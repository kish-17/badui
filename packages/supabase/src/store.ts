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
  containsUnstorableText,
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
  toTimestamptzBound,
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
 *  - Id lists for deletes travel in the URL, so they go at most 100 ids and
 *    about 4 KB of encoded ids per request (long ids would otherwise hit the
 *    gateway's URL limit, HTTP 431/414).
 *  - Reads never ask PostgREST for more than `maxRows` rows per request (the
 *    project's "Max Rows" setting, 1000 by default). A server cap lower than
 *    that still cannot truncate anything silently: listings carry an exact
 *    count, and an observation page that comes back short of what was asked
 *    is confirmed by a one-row probe (also used when a page fills the cap, so
 *    an exact last page never carries a dangling cursor); a proven cap lowers
 *    the page size for the rest of the store's life.
 *  - Values the database would accept but the memory store refuses (fractional
 *    instants, integers beyond 2^53, confidence outside [0, 1]) or that it
 *    would reject with a confusing or value-quoting error are refused before
 *    any request, with the memory store's codes: 23514 for a rule, 22P05 for
 *    text Postgres cannot hold (NUL, lone surrogates).
 *  - Errors become `SupabaseStoreError` carrying the PostgREST/SQLSTATE code
 *    and message only. PostgREST `details` are dropped because for constraint
 *    violations they echo the failing row ("Failing row contains (...)"), and
 *    quoted values are removed from data-exception messages (class 22, e.g.
 *    `invalid input syntax for type bigint: "…"`) for the same reason: row
 *    contents must never reach logs. The store itself never logs.
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
/**
 * Budget for the URL-encoded id list of one request. Gateways commonly refuse
 * request lines over 8 KB (Node's own HTTP server: 16 KB of headers in all),
 * and ids are arbitrary strings, so the count limit alone is not enough.
 */
export const ID_FILTER_MAX_URL_CHARS = 4_000;
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
      throw new SupabaseStoreError(operation, code, safeMessage(code, res.error.message), res.status);
    }
    return res;
  }

  /**
   * Map domain values to rows before any request is sent. A value the mappers
   * refuse (RangeError) is a schema-rule violation, reported as 23514 exactly
   * like the memory store; text Postgres cannot hold is 22P05.
   */
  function prepare<T>(operation: string, map: () => T): T {
    let row: T;
    try {
      row = map();
    } catch (e) {
      if (e instanceof RangeError) throw new SupabaseStoreError(operation, "23514", e.message);
      throw e;
    }
    if (containsUnstorableText(row)) {
      throw new SupabaseStoreError(operation, "22P05", "text contains NUL or an unpaired UTF-16 surrogate");
    }
    return row;
  }

  /**
   * What is known about the server's row cap (PostgREST max-rows, which
   * silently truncates any response). `pageRows` starts as the configured
   * `maxRows` and drops to the real cap once a probe proves a response was cut
   * short; `capAtLeast` is the largest response seen, so a shorter response
   * to a request no larger than that cannot have been truncated and needs no
   * probe. A project whose "Max Rows" was lowered therefore costs a few extra
   * requests, never missing rows.
   */
  let pageRows = maxRows;
  let capAtLeast = 0;

  /** Record a response of `got` rows to a request for `asked`; true when the server may have cut it short. */
  function maybeTruncated(asked: number, got: number): boolean {
    capAtLeast = Math.max(capAtLeast, got);
    return got > 0 && got < asked && asked > capAtLeast;
  }

  /** A probe found rows past a short response of `got` rows: the server's cap is exactly `got`. */
  function learnCap(got: number): void {
    pageRows = Math.max(1, Math.min(pageRows, got));
  }

  /**
   * Read every row of a listing by offset pages. Each page is requested with
   * an ORDER BY over a unique key, so pages never overlap. The first page asks
   * PostgREST for the exact row count (computed under RLS in the same request),
   * so a page cut short by the server's row cap is told apart from the last
   * page without an extra request.
   */
  async function selectAll<T>(
    operation: string,
    page: (from: number, to: number, count: { count?: "exact" }) => PromiseLike<Response<T[]>>,
  ): Promise<T[]> {
    const out: T[] = [];
    let total: number | undefined;
    for (;;) {
      const asked = pageRows;
      const res = await run(operation, page(out.length, out.length + asked - 1, total === undefined ? { count: "exact" } : {}));
      const rows = res.data ?? [];
      total ??= typeof res.count === "number" ? res.count : undefined;
      out.push(...rows);
      if (rows.length === 0 || (total !== undefined ? out.length >= total : rows.length < asked)) return out;
      if (rows.length < asked) learnCap(rows.length);
    }
  }

  /** Excerpt TTL per connection, needed only when a batch carries excerpts. */
  async function excerptTtls(connectionIds: readonly ConnectionId[]): Promise<Map<ConnectionId, number>> {
    const ttl = new Map<ConnectionId, number>();
    for (const chunk of idChunks([...new Set(connectionIds)])) {
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
      const row = prepare("upsertConnection", () => connectionToRow(connection, userId));
      await run("upsertConnection", client.from("source_connections").upsert(row, { onConflict: "user_id,connection_id" }));
    },

    async listConnections() {
      const rows = await selectAll("listConnections", (from, to, count) =>
        client.from("source_connections").select("*", count).eq("user_id", userId).order("connection_id").range(from, to),
      );
      return rows.map(connectionFromRow);
    },

    async appendConsentEvent(event) {
      const row = prepare("appendConsentEvent", () => consentEventToRow(event, userId));
      await run("appendConsentEvent", client.from("consent_events").insert(row));
    },

    async listConsentEvents(connectionId) {
      const rows = await selectAll("listConsentEvents", (from, to, count) => {
        let q = client.from("consent_events").select("id, connection_id, action, at, scopes, purposes", count).eq("user_id", userId);
        if (connectionId !== undefined) q = q.eq("connection_id", connectionId);
        return q.order("at").order("id").range(from, to);
      });
      return rows.map(consentEventFromRow);
    },

    async revokeConnection(connectionId, at) {
      const args = prepare("revokeConnection", () => ({ p_connection_id: connectionId, p_at: toTimestamptz(at) }));
      const { data } = await run("revokeConnection", client.rpc("revoke_connection", args));
      return { deletedObservations: Number(data ?? 0) };
    },

    /* source of truth */

    async putObservations(observations) {
      if (observations.length === 0) return { inserted: 0 };
      const now = clock.now();
      const withExcerpt = observations.filter((o) => o.evidence.excerpt !== undefined);
      const ttl = withExcerpt.length > 0 ? await excerptTtls(withExcerpt.map((o) => o.source.connectionId)) : new Map<ConnectionId, number>();
      // Map everything first: a mapping error (e.g. an invalid instant) then fails before any batch is sent.
      const rows = prepare("putObservations", () =>
        observations.map((o) =>
          // Unknown connection: keep no excerpt; the insert then fails on the foreign key.
          observationToRow(o, userId, { now, excerptTtlMs: ttl.get(o.source.connectionId) ?? 0 }),
        ),
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
      const since = query.since === undefined ? undefined : toTimestamptzBound(query.since);
      const until = query.until === undefined ? undefined : toTimestamptzBound(query.until);
      const cursor = query.after !== undefined ? decodeCursor(query.after) : undefined;

      /** The query's filters, continuing after (receivedAt, id) when given. */
      function page<C extends string>(columns: C, after: { readonly receivedAt: number; readonly id: string } | undefined) {
        let q = client.from("observations").select(columns).eq("user_id", userId);
        if (since !== undefined) q = q.gte("received_at", since);
        if (until !== undefined) q = q.lt("received_at", until);
        if (query.connectionId !== undefined) q = q.eq("connection_id", query.connectionId);
        if (after !== undefined) {
          const at = quote(toTimestamptz(after.receivedAt));
          q = q.or(`received_at.gt.${at},and(received_at.eq.${at},id.gt.${quote(after.id)})`);
        }
        return q.order("received_at").order("id");
      }

      // Ask for one extra row to learn whether another page exists, unless that
      // would exceed the server's row cap.
      const request = Math.min(limit + 1, pageRows);
      const { data } = await run("listObservations", page(OBSERVATION_READ_COLUMNS, cursor).limit(request));
      const now = clock.now();
      const rows: ObservationReadRow[] = data ?? [];
      const items = rows.slice(0, limit).map((r) => observationFromRow(r, now));
      const last = items[items.length - 1];
      const truncated = maybeTruncated(request, rows.length);
      if (!last) return { items };
      let more = rows.length > limit;
      if (!more && ((request <= limit && rows.length === request) || truncated)) {
        // The page filled the row cap without the look-ahead row, or the
        // server may have cut it short: probe for one more id rather than hand
        // out a cursor to an empty page, or end a listing that is not complete.
        const probe = await run("listObservations", page("id", last).limit(1));
        more = (probe.data ?? []).length > 0;
        if (more && truncated) learnCap(rows.length);
      }
      return more ? { items, next: encodeCursor(last.receivedAt, last.id) } : { items };
    },

    async deleteObservations(ids) {
      let deleted = 0;
      for (const chunk of idChunks([...new Set(ids)])) {
        const { count } = await run(
          "deleteObservations",
          client.from("observations").delete({ count: "exact" }).eq("user_id", userId).filter("id", "in", inList(chunk)),
        );
        deleted += count ?? 0;
      }
      return deleted;
    },

    async putAssertion(assertion) {
      const row = prepare("putAssertion", () => assertionToRow(assertion, userId));
      await run("putAssertion", client.from("user_assertions").upsert(row, { onConflict: "user_id,id" }));
    },

    async listAssertions(): Promise<UserAssertion[]> {
      const rows = await selectAll("listAssertions", (from, to, count) =>
        client.from("user_assertions").select("body", count).eq("user_id", userId).order("at").order("id").range(from, to),
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
      const row = prepare("putSettings", () => settingsToRow(settings, userId));
      await run("putSettings", client.from("user_settings").upsert(row, { onConflict: "user_id" }));
    },

    async listBudgets() {
      const rows = await selectAll("listBudgets", (from, to, count) =>
        client.from("budgets").select("*", count).eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(budgetFromRow);
    },

    async putBudget(budget) {
      const row = prepare("putBudget", () => budgetToRow(budget, userId));
      await run("putBudget", client.from("budgets").upsert(row, { onConflict: "user_id,id" }));
    },

    async deleteBudget(id) {
      await deleteById("deleteBudget", "budgets", id);
    },

    async listGoals() {
      const rows = await selectAll("listGoals", (from, to, count) =>
        client.from("goals").select("*", count).eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(goalFromRow);
    },

    async putGoal(goal) {
      const row = prepare("putGoal", () => goalToRow(goal, userId));
      await run("putGoal", client.from("goals").upsert(row, { onConflict: "user_id,id" }));
    },

    async deleteGoal(id) {
      await deleteById("deleteGoal", "goals", id);
    },

    async listRules() {
      const rows = await selectAll("listRules", (from, to, count) =>
        client.from("user_rules").select("*", count).eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(ruleFromRow);
    },

    async putRule(rule) {
      const row = prepare("putRule", () => ruleToRow(rule, userId));
      await run("putRule", client.from("user_rules").upsert(row, { onConflict: "user_id,id" }));
    },

    async deleteRule(id) {
      await deleteById("deleteRule", "user_rules", id);
    },

    async listOwnedInstruments() {
      const rows = await selectAll("listOwnedInstruments", (from, to, count) =>
        client.from("owned_instruments").select("*", count).eq("user_id", userId).order("id").range(from, to),
      );
      return rows.map(instrumentFromRow);
    },

    async putOwnedInstrument(instrument) {
      const row = prepare("putOwnedInstrument", () => instrumentToRow(instrument, userId));
      await run("putOwnedInstrument", client.from("owned_instruments").upsert(row, { onConflict: "user_id,id" }));
    },

    async deleteOwnedInstrument(id) {
      await deleteById("deleteOwnedInstrument", "owned_instruments", id);
    },

    /* learning-loop bookkeeping */

    async logPrompt(entry) {
      const row = prepare("logPrompt", () => promptToRow(entry, userId));
      await run("logPrompt", client.from("prompt_log").upsert(row, { onConflict: "user_id,id" }));
    },

    async listPrompts(since): Promise<PromptLogEntry[]> {
      // -Infinity (or any instant before year 1) is '-infinity', i.e. everything; NaN throws.
      const bound = toTimestamptzBound(since);
      const rows = await selectAll("listPrompts", (from, to, count) =>
        client.from("prompt_log").select("*", count).eq("user_id", userId).gte("shown_at", bound).order("shown_at").order("id").range(from, to),
      );
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
 * Split ids for `in.(…)` filters by count and by URL-encoded length, so no
 * request line outgrows ID_FILTER_MAX_URL_CHARS (one oversized id still goes
 * alone; there is no smaller request for it).
 */
function idChunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const cost = encodeURIComponent(quote(id)).length + 3; // + encoded comma
    if (current.length > 0 && (current.length >= ID_FILTER_BATCH_SIZE || chars + cost > ID_FILTER_MAX_URL_CHARS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(id);
    chars += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Data exceptions (SQLSTATE class 22) quote the offending input, e.g.
 * `invalid input syntax for type bigint: "1.5"`; drop the quoted value so an
 * error that ends up in a log cannot carry row contents. Other messages quote
 * only relation/constraint names and are kept as they are.
 */
function safeMessage(code: string, message: string | undefined): string {
  const text = message ?? "unknown error";
  return code.startsWith("22") ? text.replace(/"(?:[^"\\]|\\.)*"/g, '"…"') : text;
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
