import { systemClock } from "@brake/core";
import type {
  BrakeExport,
  BrakeStore,
  Clock,
  ConnectionId,
  Observation,
  ObservationQuery,
  Page,
  PromptLogEntry,
  UserAssertion,
} from "@brake/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "./database.types";
import {
  OBSERVATION_READ_COLUMNS,
  assertionFromRow,
  assertionToRow,
  budgetFromRow,
  budgetToRow,
  connectionFromRow,
  connectionToRow,
  consentEventFromRow,
  consentEventToRow,
  decodeCursor,
  encodeCursor,
  exportFromDocument,
  goalFromRow,
  goalToRow,
  instrumentFromRow,
  instrumentToRow,
  observationFromRow,
  observationToRow,
  pageSize,
  promptFromRow,
  promptToRow,
  ruleFromRow,
  ruleToRow,
  settingsFromRow,
  settingsToRow,
  toTimestamptz,
} from "./rows";
import type { ObservationReadRow } from "./rows";

/**
 * `BrakeStore` on Supabase (Postgres + PostgREST + Supabase Auth): accounts,
 * multi-device sync and backup of the source of truth. Processing stays on
 * the device (ADR-004); this store only moves extracted facts, assertions,
 * consent and preferences.
 *
 * Isolation is enforced by the database, not by this code. The client MUST
 * be authenticated as `userId` (a user session or a user JWT in the
 * Authorization header): every table's row-level security admits only rows
 * whose user_id = auth.uid(), and the RPCs act on auth.uid() alone. The store
 * writes `user_id = userId` (RLS rejects any other value) and also filters
 * reads by it — that filter is only for the query planner and to stay empty
 * when misconfigured; it is not the security boundary. Never construct this
 * store with a service-role client: service_role bypasses RLS, and the
 * user-rights RPCs refuse to run without a signed-in user.
 *
 * Behaviour matches the in-memory reference store (both pass the shared
 * contract suite). Notes specific to the network:
 *  - Writes upsert on the tables' primary keys; `putObservations` uses
 *    ON CONFLICT DO NOTHING, so re-sending an observation is a no-op, and
 *    reports how many rows were actually inserted (rows of a revoked
 *    connection are skipped by a trigger and not counted).
 *  - Large writes go in batches of at most 500 rows per request; each batch is
 *    atomic, the whole call is not. Retrying a failed call is safe because
 *    every write is idempotent.
 *  - Id lists for deletes travel in the URL, so they go 100 ids per request.
 *  - Reads never ask PostgREST for more than `maxRows` rows per request (the
 *    project's "Max Rows" setting, 1000 by default), so a server-side cap can
 *    never silently truncate a listing or a page.
 *  - Errors become `SupabaseStoreError` carrying the PostgREST/SQLSTATE code
 *    and message only. PostgREST `details` are dropped because for constraint
 *    violations they echo the failing row ("Failing row contains (...)"), and
 *    row contents must never reach logs. The store itself never logs.
 */
export interface SupabaseStoreOptions {
  /** A supabase-js client authenticated as `userId`. */
  readonly client: SupabaseClient<Database>;
  /** The auth user id (auth.uid()) the client is signed in as. */
  readonly userId: string;
  /** Time source for excerpt expiry and export timestamps; defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * The project's PostgREST max-rows setting. Only lower it if the project's
   * setting was lowered below the Supabase default of 1000.
   */
  readonly maxRows?: number;
}

/** A failed request. `code` is PostgREST's code (a SQLSTATE such as 23514, or PGRSTxxx). */
export class SupabaseStoreError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly status: number | undefined;

  constructor(operation: string, code: string, message: string, status?: number) {
    super(`${operation} failed (${code}): ${message}`);
    this.name = "SupabaseStoreError";
    this.code = code;
    this.operation = operation;
    this.status = status;
  }
}

/** Rows per write request: keeps request bodies and statement times modest. */
export const WRITE_BATCH_SIZE = 500;
/** Ids per delete request: ids travel in the query string. */
export const ID_FILTER_BATCH_SIZE = 100;
const DEFAULT_MAX_ROWS = 1000;

/** What every supabase-js builder resolves to, reduced to what the store inspects. */
interface Response<T> {
  readonly data: T | null;
  readonly error: { readonly code?: string; readonly message?: string } | null;
  readonly status: number;
  readonly count?: number | null;
}

export function createSupabaseStore(opts: SupabaseStoreOptions): BrakeStore {
  const { client, userId } = opts;
  const clock = opts.clock ?? systemClock;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 2) throw new RangeError("maxRows must be an integer >= 2");
  if (!userId) throw new RangeError("userId is required");

  async function run<T>(operation: string, request: PromiseLike<Response<T>>): Promise<Response<T>> {
    let res: Response<T>;
    try {
      res = await request;
    } catch (e) {
      throw new SupabaseStoreError(operation, "network", e instanceof Error ? e.message : "request failed");
    }
    if (res.error) {
      const code = res.error.code || `HTTP${res.status}`;
      throw new SupabaseStoreError(operation, code, res.error.message ?? "unknown error", res.status);
    }
    return res;
  }

  /**
   * Read every row of a listing by offset pages of `maxRows`. Each page is
   * requested with an ORDER BY over a unique key, so pages never overlap.
   */
  async function selectAll<T>(operation: string, page: (from: number, to: number) => PromiseLike<Response<T[]>>): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += maxRows) {
      const { data } = await run(operation, page(from, from + maxRows - 1));
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < maxRows) return out;
    }
  }

  /** Excerpt TTL per connection, needed only when a batch carries excerpts. */
  async function excerptTtls(connectionIds: readonly ConnectionId[]): Promise<Map<ConnectionId, number>> {
    const ttl = new Map<ConnectionId, number>();
    for (const chunk of chunks([...new Set(connectionIds)], ID_FILTER_BATCH_SIZE)) {
      const { data } = await run(
        "putObservations",
        client
          .from("source_connections")
          .select("connection_id, excerpt_ttl_ms")
          .eq("user_id", userId)
          .filter("connection_id", "in", inList(chunk)),
      );
      for (const row of data ?? []) ttl.set(row.connection_id, Number(row.excerpt_ttl_ms));
    }
    return ttl;
  }

  async function deleteById(
    operation: string,
    table: "user_assertions" | "budgets" | "goals" | "user_rules" | "owned_instruments",
    id: string,
  ): Promise<void> {
    await run(operation, client.from(table).delete().eq("user_id", userId).eq("id", id));
  }

  const store: BrakeStore = {
    /* consent */

    async upsertConnection(connection) {
      await run(
        "upsertConnection",
        client.from("source_connections").upsert(connectionToRow(connection, userId), { onConflict: "user_id,connection_id" }),
      );
    },

    async listConnections() {
      const rows = await selectAll("listConnections", (from, to) =>
        client.from("source_connections").select("*").eq("user_id", userId).order("connection_id").range(from, to),
      );
      return rows.map(connectionFromRow);
    },

    async appendConsentEvent(event) {
      await run("appendConsentEvent", client.from("consent_events").insert(consentEventToRow(event, userId)));
    },

    async listConsentEvents(connectionId) {
      const rows = await selectAll("listConsentEvents", (from, to) => {
        let q = client.from("consent_events").select("id, connection_id, action, at, scopes, purposes").eq("user_id", userId);
        if (connectionId !== undefined) q = q.eq("connection_id", connectionId);
        return q.order("at").order("id").range(from, to);
      });
      return rows.map(consentEventFromRow);
    },

    async revokeConnection(connectionId, at) {
      const { data } = await run(
        "revokeConnection",
        client.rpc("revoke_connection", { p_connection_id: connectionId, p_at: toTimestamptz(at) }),
      );
      return { deletedObservations: Number(data ?? 0) };
    },

    /* source of truth */

    async putObservations(observations) {
      if (observations.length === 0) return { inserted: 0 };
      const now = clock.now();
      const withExcerpt = observations.filter((o) => o.evidence.excerpt !== undefined);
      const ttl = withExcerpt.length > 0 ? await excerptTtls(withExcerpt.map((o) => o.source.connectionId)) : new Map<ConnectionId, number>();
      // Map everything first: a mapping error (e.g. an invalid instant) then fails before any batch is sent.
      const rows = observations.map((o) =>
        // Unknown connection: keep no excerpt; the insert then fails on the foreign key.
        observationToRow(o, userId, { now, excerptTtlMs: ttl.get(o.source.connectionId) ?? 0 }),
      );
      let inserted = 0;
      for (const batch of chunks(rows, WRITE_BATCH_SIZE)) {
        const { count } = await run(
          "putObservations",
          client.from("observations").upsert(batch, { onConflict: "user_id,id", ignoreDuplicates: true, count: "exact" }),
        );
        inserted += count ?? 0;
      }
      return { inserted };
    },

    async listObservations(query: ObservationQuery = {}): Promise<Page<Observation>> {
      const limit = pageSize(query.limit);
      const cursor = query.after !== undefined ? decodeCursor(query.after) : undefined;
      // Ask for one extra row to learn whether another page exists, unless that
      // would exceed the server's row cap; then a full page implies "maybe more".
      const request = Math.min(limit + 1, maxRows);
      let q = client.from("observations").select(OBSERVATION_READ_COLUMNS).eq("user_id", userId);
      if (query.since !== undefined) q = q.gte("received_at", toTimestamptz(query.since));
      if (query.until !== undefined) q = q.lt("received_at", toTimestamptz(query.until));
      if (query.connectionId !== undefined) q = q.eq("connection_id", query.connectionId);
      if (cursor !== undefined) {
        const at = quote(toTimestamptz(cursor.receivedAt));
        q = q.or(`received_at.gt.${at},and(received_at.eq.${at},id.gt.${quote(cursor.id)})`);
      }
      const { data } = await run("listObservations", q.order("received_at").order("id").limit(request));
      const now = clock.now();
      const rows: ObservationReadRow[] = data ?? [];
      const items = rows.slice(0, limit).map((r) => observationFromRow(r, now));
      const last = items[items.length - 1];
      const more = rows.length > limit || (request <= limit && rows.length === request);
      return more && last ? { items, next: encodeCursor(last.receivedAt, last.id) } : { items };
    },

    async deleteObservations(ids) {
      let deleted = 0;
      for (const chunk of chunks([...new Set(ids)], ID_FILTER_BATCH_SIZE)) {
        const { count } = await run(
          "deleteObservations",
          client.from("observations").delete({ count: "exact" }).eq("user_id", userId).filter("id", "in", inList(chunk)),
        );
        deleted += count ?? 0;
      }
      return deleted;
    },

    async putAssertion(assertion) {
      await run("putAssertion", client.from("user_assertions").upsert(assertionToRow(assertion, userId), { onConflict: "user_id,id" }));
    },

    async listAssertions(): Promise<UserAssertion[]> {
      const rows = await selectAll("listAssertions", (from, to) =>
        client.from("user_assertions").select("body").eq("user_id", userId).order("at").order("id").range(from, to),
      );
      return rows.map(assertionFromRow);
    },

    async deleteAssertion(id) {
      await deleteById("deleteAssertion", "user_assertions", id);
    },

    /* preferences */

    async getSettings() {
      const { data } = await run("getSettings", client.from("user_settings").select("*").eq("user_id", userId).maybeSingle());
      return data === null ? null : settingsFromRow(data);
    },

    async putSettings(settings) {
      await run("putSettings", client.from("user_settings").upsert(settingsToRow(settings, userId), { onConflict: "user_id" }));
    },

    async listBudgets() {
      const rows = await selectAll("listBudgets", (from, to) =>
        client.from("budgets").select("*").eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(budgetFromRow);
    },

    async putBudget(budget) {
      await run("putBudget", client.from("budgets").upsert(budgetToRow(budget, userId), { onConflict: "user_id,id" }));
    },

    async deleteBudget(id) {
      await deleteById("deleteBudget", "budgets", id);
    },

    async listGoals() {
      const rows = await selectAll("listGoals", (from, to) =>
        client.from("goals").select("*").eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(goalFromRow);
    },

    async putGoal(goal) {
      await run("putGoal", client.from("goals").upsert(goalToRow(goal, userId), { onConflict: "user_id,id" }));
    },

    async deleteGoal(id) {
      await deleteById("deleteGoal", "goals", id);
    },

    async listRules() {
      const rows = await selectAll("listRules", (from, to) =>
        client.from("user_rules").select("*").eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(ruleFromRow);
    },

    async putRule(rule) {
      await run("putRule", client.from("user_rules").upsert(ruleToRow(rule, userId), { onConflict: "user_id,id" }));
    },

    async deleteRule(id) {
      await deleteById("deleteRule", "user_rules", id);
    },

    async listOwnedInstruments() {
      const rows = await selectAll("listOwnedInstruments", (from, to) =>
        client.from("owned_instruments").select("*").eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(instrumentFromRow);
    },

    async putOwnedInstrument(instrument) {
      await run(
        "putOwnedInstrument",
        client.from("owned_instruments").upsert(instrumentToRow(instrument, userId), { onConflict: "user_id,id" }),
      );
    },

    async deleteOwnedInstrument(id) {
      await deleteById("deleteOwnedInstrument", "owned_instruments", id);
    },

    /* learning-loop bookkeeping */

    async logPrompt(entry) {
      await run("logPrompt", client.from("prompt_log").upsert(promptToRow(entry, userId), { onConflict: "user_id,id" }));
    },

    async listPrompts(since): Promise<PromptLogEntry[]> {
      const rows = await selectAll("listPrompts", (from, to) => {
        let q = client.from("prompt_log").select("*").eq("user_id", userId);
        // A bound before any representable instant (e.g. -Infinity for "all") means no bound.
        if (Number.isFinite(since) && !Number.isNaN(new Date(since).getTime())) q = q.gte("shown_at", toTimestamptz(since));
        return q.order("shown_at").order("id").range(from, to);
      });
      return rows.map(promptFromRow);
    },

    /* user rights */

    async exportAll(): Promise<BrakeExport> {
      const { data } = await run("exportAll", client.rpc("export_my_data"));
      const now = clock.now();
      return exportFromDocument((data ?? {}) as Json, now, now);
    },

    async eraseAll() {
      await run("eraseAll", client.rpc("erase_my_data"));
    },
  };
  return store;
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Quote a value for a PostgREST filter list or logic tree. Always quoting
 * (with backslash escapes) keeps ids containing `,` `.` `:` `(` `)` `"` or `\`
 * from being parsed as syntax — supabase-js's own `.in()` quotes only some of them.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function inList(values: readonly string[]): string {
  return `(${values.map(quote).join(",")})`;
}
