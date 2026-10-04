/**
 * Proves BRAKE's Supabase schema enforces the privacy model with real SQL,
 * executed the way PostgREST executes requests (role + JWT claims per
 * transaction) and, for the API surface, through PostgREST and supabase-js.
 *
 * The properties under test are the ones a bug would turn into a data leak or
 * a broken promise to the user: per-user isolation of every table, nothing for
 * the anon key, append-only consent receipts, no raw payloads / card numbers,
 * revocation that really purges, retention, export and erasure.
 */
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, migrationFiles, startPostgrest } from "./harness";
import type { PoolClient, PostgrestServer, TestDatabase } from "./harness";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-01T09:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

type Row = Record<string, unknown>;
type Runner = (fn: (client: PoolClient) => Promise<unknown>) => Promise<unknown>;
interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const USER_TABLES = [
  "user_settings",
  "source_connections",
  "consent_events",
  "observations",
  "user_assertions",
  "budgets",
  "goals",
  "user_rules",
  "owned_instruments",
  "prompt_log",
] as const;
type UserTable = (typeof USER_TABLES)[number];

const RLS_VIOLATION = /new row violates row-level security policy/;
const TABLE_DENIED = /permission denied for table/;
const FUNCTION_DENIED = /permission denied for function/;
const PRIVATE_DENIED = /permission denied for schema private/;

// ------------------------------------------------------------- fixtures ----

const JSONB_COLUMNS = new Set(["facts", "body", "rule", "document"]);

function insertStatement(table: string, row: Row): { text: string; values: unknown[] } {
  const columns = Object.keys(row);
  return {
    text: `insert into public.${table} (${columns.join(", ")}) values (${columns
      .map((c, i) => (JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`))
      .join(", ")})`,
    values: columns.map((c) => (JSONB_COLUMNS.has(c) ? JSON.stringify(row[c]) : row[c])),
  };
}

function insert(client: Queryable, table: string, row: Row) {
  const { text, values } = insertStatement(table, row);
  return client.query(text, values);
}

function settingsRow(userId: string): Row {
  return { user_id: userId, locale: "en-IN", time_zone: "Asia/Kolkata", home_country: "IN", home_currency: "INR" };
}

function connectionRow(userId: string, connectionId: string, overrides: Row = {}): Row {
  return {
    user_id: userId,
    connection_id: connectionId,
    adapter_id: "sms",
    kind: "sms",
    label: "HDFC Bank SMS alerts",
    provider: "HDFC Bank",
    status: "active",
    scopes: ["sms:read"],
    purposes: ["detect purchases"],
    excerpt_ttl_ms: 7 * DAY,
    observation_ttl_ms: null,
    granted_at: iso(T0),
    updated_at: iso(T0),
    ...overrides,
  };
}

function consentRow(userId: string, connectionId: string, action = "granted"): Row {
  return {
    user_id: userId,
    connection_id: connectionId,
    action,
    at: iso(T0),
    scopes: ["sms:read"],
    purposes: ["detect purchases"],
  };
}

interface ObservationInput {
  readonly id: string;
  readonly connectionId: string;
  readonly receivedAt?: number;
  readonly occurredAt?: number | null;
  readonly excerpt?: string;
  readonly excerptExpiresAt?: number;
  readonly summary?: string;
  readonly merchantRaw?: string;
  readonly references?: readonly Row[];
  /** Merged into the Observation JSON (facts). */
  readonly facts?: Row;
  /** Merged into the row (columns). */
  readonly columns?: Row;
}

/** A row the way the store writes an Observation: projections + facts (no excerpt) + excerpt column. */
function observationRow(userId: string, input: ObservationInput): Row {
  const receivedAt = input.receivedAt ?? T0;
  const occurredAt = input.occurredAt === undefined ? receivedAt - 60_000 : input.occurredAt;
  const facts: Row = {
    id: input.id,
    source: {
      adapterId: "sms",
      kind: "sms",
      connectionId: input.connectionId,
      provider: "HDFC Bank",
      label: "HDFC Bank transaction SMS",
    },
    kind: "money_movement",
    window: "post_spend",
    stage: "confirmed",
    receivedAt,
    ...(occurredAt === null ? {} : { occurredAt: { value: occurredAt, confidence: 0.9 } }),
    direction: "debit",
    amount: { value: { minor: 124900, currency: "INR" }, confidence: 0.97 },
    merchant: { raw: input.merchantRaw ?? "AMAZON", key: "amazon", confidence: 0.9 },
    instrument: { type: "card", issuer: "HDFC Bank", last4: "1234", cardKind: "credit" },
    rail: { family: "account_to_account_instant", scheme: "upi" },
    references: input.references ?? [{ type: "rail_reference", value: "412345678901", namespace: "upi" }],
    confidence: 0.97,
    evidence: { summary: input.summary ?? "HDFC Bank SMS: ₹1,249.00 debited to AMAZON (UPI)" },
    ...input.facts,
  };
  return {
    user_id: userId,
    id: input.id,
    connection_id: input.connectionId,
    adapter_id: "sms",
    source_kind: "sms",
    kind: "money_movement",
    spend_window: "post_spend",
    stage: "confirmed",
    received_at: iso(receivedAt),
    occurred_at: occurredAt === null ? null : iso(occurredAt),
    direction: "debit",
    amount_minor: 124900,
    currency: "INR",
    merchant_key: "amazon",
    confidence: 0.97,
    facts,
    evidence_excerpt: input.excerpt ?? null,
    excerpt_expires_at:
      input.excerpt === undefined ? null : iso(input.excerptExpiresAt ?? receivedAt + 7 * DAY),
    ...input.columns,
  };
}

function assertionRow(userId: string, id: string, anchors: string[], body: Row = {}): Row {
  return {
    user_id: userId,
    id,
    kind: "label",
    at: iso(T0),
    anchors,
    body: { id, kind: "label", at: T0, anchors, field: "category", value: "shopping.electronics", ...body },
  };
}

function budgetRow(userId: string, id = "all:monthly:INR"): Row {
  return { user_id: userId, id, category: null, limit_minor: 2_000_000, currency: "INR", period: "monthly" };
}

function goalRow(userId: string, id = "goal-trip"): Row {
  return {
    user_id: userId,
    id,
    name: "Goa trip",
    target_minor: 5_000_000,
    saved_minor: 1_250_000,
    currency: "INR",
    target_date: "2027-03-01T00:00:00Z",
  };
}

function ruleRow(userId: string, id = "rule-late-night"): Row {
  return {
    user_id: userId,
    id,
    description: "Pause online shopping after 11pm",
    level: "pause",
    rule: { channel: "online", localHours: { from: 23, to: 5 } },
  };
}

function instrumentRow(userId: string, id = "inst-hdfc-card"): Row {
  return { user_id: userId, id, type: "card", issuer: "HDFC Bank", last4: "1234", card_kind: "credit" };
}

function promptRow(userId: string, id = "prompt-1"): Row {
  return {
    user_id: userId,
    id,
    kind: "question",
    anchor: "obs-1",
    shown_at: iso(T0),
    answered_at: iso(T0 + 60_000),
    answer: "shopping",
  };
}

/** Everything a user can have, written by the user through the API role (the happy path). */
async function seedUser(db: TestDatabase, userId: string): Promise<void> {
  await db.asUser(userId, async (c) => {
    await insert(c, "user_settings", settingsRow(userId));
    await insert(c, "source_connections", connectionRow(userId, "conn-sms"));
    await insert(
      c,
      "source_connections",
      connectionRow(userId, "conn-gmail", {
        adapter_id: "gmail",
        kind: "email",
        label: "Gmail inbox",
        provider: "Google",
        observation_ttl_ms: 400 * DAY,
      }),
    );
    await insert(c, "consent_events", consentRow(userId, "conn-sms"));
    await insert(c, "consent_events", consentRow(userId, "conn-gmail"));
    await insert(
      c,
      "observations",
      observationRow(userId, { id: "obs-1", connectionId: "conn-sms", excerpt: "Rs.1249.00 debited from a/c XX1234" }),
    );
    await insert(c, "observations", observationRow(userId, { id: "obs-2", connectionId: "conn-sms" }));
    await insert(
      c,
      "observations",
      observationRow(userId, {
        id: "obs-3",
        connectionId: "conn-gmail",
        columns: { adapter_id: "gmail", source_kind: "email", kind: "order" },
      }),
    );
    await insert(c, "user_assertions", assertionRow(userId, "asr-1", ["obs-1"]));
    await insert(c, "budgets", budgetRow(userId));
    await insert(c, "goals", goalRow(userId));
    await insert(c, "user_rules", ruleRow(userId));
    await insert(c, "owned_instruments", instrumentRow(userId));
    await insert(c, "prompt_log", promptRow(userId));
  });
}

interface TableSpec {
  readonly table: UserTable;
  /** A valid row for `userId`; `n` makes ids unique. */
  row(userId: string, n: string): Row;
  /** A column update to attempt on another user's rows. */
  readonly update: readonly [column: string, value: unknown];
  readonly appendOnly?: boolean;
}

const TABLES: readonly TableSpec[] = [
  { table: "user_settings", row: (u) => settingsRow(u), update: ["locale", "xx-XX"] },
  { table: "source_connections", row: (u, n) => connectionRow(u, `conn-${n}`), update: ["label", "hijacked"] },
  {
    table: "consent_events",
    row: (u, n) => consentRow(u, `conn-${n}`),
    update: ["action", "revoked"],
    appendOnly: true,
  },
  {
    table: "observations",
    row: (u, n) => observationRow(u, { id: `obs-${n}`, connectionId: "conn-sms" }),
    update: ["merchant_key", "hijacked"],
  },
  { table: "user_assertions", row: (u, n) => assertionRow(u, `asr-${n}`, ["obs-1"]), update: ["kind", "dismiss"] },
  { table: "budgets", row: (u, n) => budgetRow(u, `b-${n}`), update: ["limit_minor", 1] },
  { table: "goals", row: (u, n) => goalRow(u, `g-${n}`), update: ["name", "hijacked"] },
  { table: "user_rules", row: (u, n) => ruleRow(u, `r-${n}`), update: ["description", "hijacked"] },
  { table: "owned_instruments", row: (u, n) => instrumentRow(u, `i-${n}`), update: ["issuer", "hijacked"] },
  { table: "prompt_log", row: (u, n) => promptRow(u, `p-${n}`), update: ["answer", "hijacked"] },
];

// -------------------------------------------------------------- helpers ----

interface PgError {
  readonly code?: string;
  readonly message: string;
  readonly constraint?: string;
}

/** The error a statement (or a whole asUser/asAnon call) fails with; fails the test if it succeeds. */
async function failure(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (error) {
    return error as PgError;
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

async function count(db: TestDatabase, table: string, userId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(`select count(*) as n from public.${table} where user_id = $1`, [
    userId,
  ]);
  return Number(rows[0]?.n ?? 0);
}

async function countsFor(db: TestDatabase, userId: string): Promise<Record<UserTable, number>> {
  const out = {} as Record<UserTable, number>;
  for (const t of USER_TABLES) out[t] = await count(db, t, userId);
  return out;
}

async function scalar<T>(client: Queryable | PoolClient, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await (client as Queryable).query(text, values);
  const first = rows[0];
  if (!first) throw new Error(`no row from: ${text}`);
  return Object.values(first)[0] as T;
}

// =================================================================== tests ==

describe("BRAKE Supabase schema", () => {
  let db: TestDatabase;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    alice = await db.createUser("alice@example.test");
    bob = await db.createUser("bob@example.test");
    await seedUser(db, alice);
    await seedUser(db, bob);
    await db.asService((c) =>
      insert(c, "capability_registry", {
        version: "2026.10.0",
        published_at: iso(T0),
        document: { version: "2026.10.0", countries: { IN: { upi_qr: "available" } } },
      }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  // ------------------------------------------------------------ (11) ------
  describe("migrations", () => {
    it("apply to a fresh database (shim first, then every migration in name order) with pg_cron absent", async () => {
      expect((await migrationFiles()).map((f) => f.split("/").pop())).toEqual([
        "20261004120000_brake_schema.sql",
        "20261004120100_brake_functions.sql",
      ]);
      const available = await scalar<boolean>(
        db.pool,
        "select exists (select 1 from pg_available_extensions where name = 'pg_cron')",
      );
      const installed = await scalar<boolean>(db.pool, "select exists (select 1 from pg_extension where extname = 'pg_cron')");
      if (!available) {
        expect(installed).toBe(false);
        expect(await scalar<string | null>(db.pool, "select to_regnamespace('cron')::text")).toBeNull();
      } else if (installed) {
        expect(await scalar<number>(db.pool, "select count(*)::int from cron.job where jobname = 'brake_apply_retention'")).toBe(1);
      }
    });

    it("enables row-level security on every table in public", async () => {
      const { rows } = await db.pool.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      );
      expect(rows).toEqual([]);
    });

    it("exposes exactly the three user-rights RPCs in public, none to anon or PUBLIC", async () => {
      const { rows } = await db.pool.query<{ fn: string; anon: boolean; pub: boolean; authn: boolean }>(
        `select p.oid::regprocedure::text as fn,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                case when p.proacl is null then true -- NULL acl = the default, which grants PUBLIC
                     else exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) end as pub,
                has_function_privilege('authenticated', p.oid, 'execute') as authn
         from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
      );
      expect(rows.map((r) => r.fn)).toEqual([
        "erase_my_data()",
        "export_my_data()",
        "revoke_connection(text,timestamp with time zone)",
      ]);
      for (const r of rows) {
        expect(r, r.fn).toMatchObject({ anon: false, pub: false, authn: true });
      }
    });

    it("pins search_path = '' on every function it defines (and on every SECURITY DEFINER one)", async () => {
      const { rows } = await db.pool.query<{ fn: string; definer: boolean; config: string[] | null }>(
        `select p.oid::regprocedure::text as fn, p.prosecdef as definer, p.proconfig as config
         from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)`,
      );
      expect(rows.filter((r) => r.definer).length).toBeGreaterThanOrEqual(3);
      for (const r of rows) expect(r.config ?? [], r.fn).toContain('search_path=""');
    });

    it("gives anon nothing on user tables and authenticated no TRUNCATE/REFERENCES/TRIGGER (which bypass RLS)", async () => {
      for (const t of USER_TABLES) {
        const { rows } = await db.pool.query<{ privilege: string; anon: boolean; authn: boolean }>(
          `select p as privilege, has_table_privilege('anon', $1::regclass, p) as anon,
                  has_table_privilege('authenticated', $1::regclass, p) as authn
           from unnest(array['select','insert','update','delete','truncate','references','trigger']) p`,
          [`public.${t}`],
        );
        for (const r of rows) {
          expect(r.anon, `${t}: anon ${r.privilege}`).toBe(false);
          if (["truncate", "references", "trigger"].includes(r.privilege)) {
            expect(r.authn, `${t}: authenticated ${r.privilege}`).toBe(false);
          }
        }
      }
    });
  });

  // ------------------------------------------------------------- (1) ------
  describe.each(TABLES)("isolation: $table", (spec) => {
    it("shows a user only their own rows", async () => {
      const owners = await db.asUser(bob, (c) => c.query(`select distinct user_id from public.${spec.table}`));
      expect(owners.rows).toEqual([{ user_id: bob }]);
      const leaked = await db.asUser(bob, (c) =>
        c.query(`select count(*)::int as n from public.${spec.table} where user_id = $1`, [alice]),
      );
      expect(leaked.rows[0]).toEqual({ n: 0 });
      expect(await count(db, spec.table, alice)).toBeGreaterThan(0);
    });

    it("rejects inserting a row for another user (forged user_id)", async () => {
      const before = await count(db, spec.table, alice);
      const err = await failure(db.asUser(bob, (c) => insert(c, spec.table, spec.row(alice, "forged"))));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(RLS_VIOLATION);
      expect(await count(db, spec.table, alice)).toBe(before);
    });

    it("cannot update another user's rows", async () => {
      const [column, value] = spec.update;
      if (spec.appendOnly) {
        const err = await failure(
          db.asUser(bob, (c) => c.query(`update public.${spec.table} set ${column} = $1 where user_id = $2`, [value, alice])),
        );
        expect(err.message).toMatch(TABLE_DENIED);
      } else {
        const res = await db.asUser(bob, (c) =>
          c.query(`update public.${spec.table} set ${column} = $1 where user_id = $2`, [value, alice]),
        );
        expect(res.rowCount).toBe(0);
      }
      const touched = await db.pool.query(`select 1 from public.${spec.table} where user_id = $1 and ${column} = $2`, [
        alice,
        value,
      ]);
      expect(touched.rowCount).toBe(0);
    });

    it("cannot hand its own rows to another user by updating user_id", async () => {
      const err = await failure(
        db.asUser(bob, (c) => c.query(`update public.${spec.table} set user_id = $1 where user_id = $2`, [alice, bob])),
      );
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(spec.appendOnly ? TABLE_DENIED : RLS_VIOLATION);
    });

    it("cannot delete another user's rows", async () => {
      const before = await count(db, spec.table, alice);
      if (spec.appendOnly) {
        const err = await failure(
          db.asUser(bob, (c) => c.query(`delete from public.${spec.table} where user_id = $1`, [alice])),
        );
        expect(err.message).toMatch(TABLE_DENIED);
      } else {
        const res = await db.asUser(bob, (c) => c.query(`delete from public.${spec.table} where user_id = $1`, [alice]));
        expect(res.rowCount).toBe(0);
      }
      expect(await count(db, spec.table, alice)).toBe(before);
    });
  });

  // ------------------------------------------------------------- (2) ------
  describe("anon (the public API key)", () => {
    it.each(TABLES)("is refused every command on $table", async (spec) => {
      for (const sql of [
        `select * from public.${spec.table} limit 1`,
        `update public.${spec.table} set user_id = user_id`,
        `delete from public.${spec.table}`,
      ]) {
        const err = await failure(db.asAnon((c) => c.query(sql)));
        expect(err.message, sql).toMatch(TABLE_DENIED);
      }
      const err = await failure(db.asAnon((c) => insert(c, spec.table, spec.row(alice, "anon"))));
      expect(err.message).toMatch(TABLE_DENIED);
    });

    it("cannot execute any RPC or the retention job", async () => {
      for (const sql of [
        "select public.export_my_data()",
        "select public.erase_my_data()",
        "select public.revoke_connection('conn-sms')",
      ]) {
        const err = await failure(db.asAnon((c) => c.query(sql)));
        expect(err.message, sql).toMatch(FUNCTION_DENIED);
      }
      const err = await failure(db.asAnon((c) => c.query("select * from private.apply_retention()")));
      expect(err.message).toMatch(PRIVATE_DENIED);
      expect(await count(db, "observations", alice)).toBe(3);
    });
  });

  // ------------------------------------------------------------- (3) ------
  describe("capability_registry", () => {
    it("is readable by anon and authenticated", async () => {
      const anon = await db.asAnon((c) => c.query("select version, document from public.capability_registry"));
      expect(anon.rows).toEqual([
        { version: "2026.10.0", document: { version: "2026.10.0", countries: { IN: { upi_qr: "available" } } } },
      ]);
      const user = await db.asUser(alice, (c) => c.query("select version from public.capability_registry"));
      expect(user.rows).toEqual([{ version: "2026.10.0" }]);
    });

    it("is not writable by anon or authenticated", async () => {
      const doc = { version: "evil", published_at: iso(T0), document: { hacked: true } };
      const runners: Runner[] = [(fn) => db.asAnon(fn), (fn) => db.asUser(alice, fn)];
      for (const run of runners) {
        expect((await failure(run((c) => insert(c, "capability_registry", doc)))).message).toMatch(TABLE_DENIED);
        expect(
          (await failure(run((c) => c.query("update public.capability_registry set document = '{}'")))).message,
        ).toMatch(TABLE_DENIED);
        expect((await failure(run((c) => c.query("delete from public.capability_registry")))).message).toMatch(
          TABLE_DENIED,
        );
      }
    });

    it("is writable by service_role", async () => {
      await db.asService(async (c) => {
        await insert(c, "capability_registry", { version: "2026.10.1", document: { version: "2026.10.1" } });
        await c.query("update public.capability_registry set document = $1::jsonb where version = '2026.10.1'", [
          JSON.stringify({ version: "2026.10.1", note: "republished" }),
        ]);
      });
      const doc = await scalar<Row>(db.pool, "select document from public.capability_registry where version = '2026.10.1'");
      expect(doc).toEqual({ version: "2026.10.1", note: "republished" });
      await db.asService((c) => c.query("delete from public.capability_registry where version = '2026.10.1'"));
    });
  });

  // ------------------------------------------------------------- (4) ------
  describe("consent_events (append-only receipts)", () => {
    it("lets the owner read and append receipts", async () => {
      await db.asUser(alice, (c) => insert(c, "consent_events", consentRow(alice, "conn-sms", "paused")));
      const { rows } = await db.asUser(alice, (c) =>
        c.query("select action from public.consent_events where connection_id = 'conn-sms' order by id"),
      );
      expect(rows.map((r) => r.action)).toEqual(["granted", "paused"]);
    });

    it("refuses UPDATE, DELETE and TRUNCATE by the owner", async () => {
      const before = await count(db, "consent_events", alice);
      for (const sql of [
        "update public.consent_events set action = 'granted'",
        "update public.consent_events set at = now() where action = 'paused'",
        "delete from public.consent_events",
        "truncate public.consent_events",
      ]) {
        const err = await failure(db.asUser(alice, (c) => c.query(sql)));
        expect(err.message, sql).toMatch(TABLE_DENIED);
      }
      expect(await count(db, "consent_events", alice)).toBe(before);
    });

    it("does not let clients choose receipt ids", async () => {
      const err = await failure(
        db.asUser(alice, (c) => insert(c, "consent_events", { ...consentRow(alice, "conn-sms"), id: 1 })),
      );
      expect(err.message).toMatch(/cannot insert a non-DEFAULT value into column "id"/);
    });
  });

  // ------------------------------------------------------------- (5) ------
  describe("check constraints", () => {
    const rejects = async (table: string, row: Row): Promise<PgError> => {
      const err = await failure(db.asUser(alice, (c) => insert(c, table, row)));
      expect(err.code, `${table}: ${err.message}`).toBe("23514");
      return err;
    };

    it("reject malformed currency and country codes", async () => {
      await rejects("budgets", { ...budgetRow(alice, "x1"), currency: "usd" });
      await rejects("budgets", { ...budgetRow(alice, "x2"), currency: "US" });
      await rejects("goals", { ...goalRow(alice, "x3"), currency: "U5D" });
      await rejects(
        "observations",
        observationRow(alice, { id: "bad-cur", connectionId: "conn-sms", columns: { currency: "inr" } }),
      );
      // Settings are one row per user, so use a user who has none yet.
      const fresh = await db.createUser();
      for (const bad of [{ home_currency: "inr" }, { home_country: "in" }, { question_weekly_budget: 51 }]) {
        const err = await failure(db.asUser(fresh, (c) => insert(c, "user_settings", { ...settingsRow(fresh), ...bad })));
        expect(err.code, JSON.stringify(bad)).toBe("23514");
      }
    });

    it("reject non-positive budgets/goals and out-of-range settings", async () => {
      await rejects("budgets", { ...budgetRow(alice, "zero"), limit_minor: 0 });
      await rejects("budgets", { ...budgetRow(alice, "daily"), period: "daily" });
      await rejects("goals", { ...goalRow(alice, "neg"), saved_minor: -1 });
      await rejects("goals", { ...goalRow(alice, "long"), name: "x".repeat(81) });
      await rejects("source_connections", connectionRow(alice, "conn-ttl0", { observation_ttl_ms: 0 }));
      await rejects("source_connections", connectionRow(alice, "conn-kind", { kind: "plaid" }));
      await rejects("source_connections", connectionRow(alice, "conn-label", { label: "x".repeat(121) }));
      await rejects("consent_events", consentRow(alice, "conn-sms", "deleted"));
    });

    it("accept only a 4-digit last4 (never a full number)", async () => {
      for (const last4 of ["12345", "12a4", "4111111111111111", "••••"]) {
        await rejects("owned_instruments", { ...instrumentRow(alice, `inst-${last4}`), last4 });
      }
    });

    it("reject free-text prompt answers (option ids only)", async () => {
      for (const answer of ["I regret buying this for my mom", "Shopping", "", "a".repeat(65)]) {
        await rejects("prompt_log", { ...promptRow(alice, `p-${answer.length}-${answer.slice(0, 3)}`), answer });
      }
      await db.asUser(alice, (c) =>
        insert(c, "prompt_log", { ...promptRow(alice, "p-ok"), kind: "regret_prompt", answer: "satisfaction:regretted" }),
      );
    });

    it("reject raw-payload keys at the top level of facts", async () => {
      for (const key of ["payload", "raw", "rawPayload", "body", "html", "text"]) {
        const err = await rejects(
          "observations",
          observationRow(alice, { id: `raw-${key}`, connectionId: "conn-sms", facts: { [key]: "Dear customer, Rs 1249 …" } }),
        );
        expect(err.constraint).toBe("observations_facts_no_raw_payload");
      }
    });

    it("reject the evidence excerpt inside facts (it must stay in its expiring column)", async () => {
      const err = await rejects(
        "observations",
        observationRow(alice, {
          id: "excerpt-in-facts",
          connectionId: "conn-sms",
          facts: { evidence: { summary: "s", excerpt: "Rs.1249 debited", excerptExpiresAt: T0 + DAY } },
        }),
      );
      expect(err.constraint).toBe("observations_facts_no_excerpt");
    });

    it("reject oversized facts (> 32 KiB)", async () => {
      const lineItems = Array.from({ length: 40 }, (_, i) => ({ description: `item ${i} ${"x".repeat(1000)}` }));
      const err = await rejects("observations", observationRow(alice, { id: "huge", connectionId: "conn-sms", facts: { lineItems } }));
      expect(err.constraint).toBe("observations_facts_size");
    });

    it("require an expiry for every excerpt and cap its length", async () => {
      await rejects(
        "observations",
        observationRow(alice, { id: "no-expiry", connectionId: "conn-sms", excerpt: "Rs.1249", columns: { excerpt_expires_at: null } }),
      );
      await rejects("observations", observationRow(alice, { id: "long-excerpt", connectionId: "conn-sms", excerpt: "x".repeat(501) }));
    });

    it("bound assertion anchors to 1..50 and rule documents to rule criteria", async () => {
      await rejects("user_assertions", assertionRow(alice, "no-anchors", []));
      await rejects(
        "user_assertions",
        assertionRow(alice, "many-anchors", Array.from({ length: 51 }, (_, i) => `obs-${i}`)),
      );
      await rejects("user_rules", { ...ruleRow(alice, "rule-notes"), rule: { channel: "online", note: "free text" } });
    });
  });

  // ------------------------------------------------------------- (6) ------
  describe("card-number trigger", () => {
    const PAN_ERROR = /looks like a full card number/;

    it("rejects a Luhn-valid PAN in facts, in the excerpt and in assertion bodies, without echoing it", async () => {
      const cases: Array<[string, Row]> = [
        ["observations", observationRow(alice, { id: "pan-1", connectionId: "conn-sms", summary: "Card 4111 1111 1111 1111 charged ₹1,249" })],
        ["observations", observationRow(alice, { id: "pan-2", connectionId: "conn-sms", merchantRaw: "AMZN 4111111111111111" })],
        ["observations", observationRow(alice, { id: "pan-3", connectionId: "conn-sms", facts: { lineItems: [{ description: "Amex 3782-822463-10005" }] } })],
        ["observations", observationRow(alice, { id: "pan-4", connectionId: "conn-sms", excerpt: "debited from card 5555-5555-5555-4444 at AMAZON" })],
        ["user_assertions", assertionRow(alice, "pan-5", ["obs-1"], { value: "card 4111111111111111" })],
      ];
      for (const [table, row] of cases) {
        const err = await failure(db.asUser(alice, (c) => insert(c, table, row)));
        expect(err.code, String(row.id)).toBe("23514");
        expect(err.message).toMatch(PAN_ERROR);
        expect(err.message).not.toMatch(/4111|5555|3782/);
      }
    });

    it("rejects a PAN added by a later UPDATE", async () => {
      const err = await failure(
        db.asUser(alice, (c) =>
          c.query(
            `update public.observations set facts = jsonb_set(facts, '{evidence,summary}', '"card 4111111111111111"') where id = 'obs-2'`,
          ),
        ),
      );
      expect(err.message).toMatch(PAN_ERROR);
    });

    it("accepts UPI RRNs, masked numbers, Luhn-invalid digit runs and numeric identifiers", async () => {
      await db.asUser(alice, async (c) => {
        await insert(
          c,
          "observations",
          observationRow(alice, {
            id: "ok-1",
            connectionId: "conn-sms",
            summary: "UPI Ref 412345678901: ₹1,249 debited from a/c XX1234 (card ••••1234)",
            excerpt: "Rs.1249.00 debited from a/c **1234 to VPA amazon@apl UPI Ref No 412345678901",
            references: [
              { type: "rail_reference", value: "412345678901", namespace: "upi" },
              // 15-digit card-network transaction id that happens to pass Luhn: an identifier, not a card.
              { type: "provider_transaction_id", value: "412345678901233" },
              // Amazon order number layout, Luhn-valid when its separators are removed.
              { type: "order_id", value: "408-1234567-1234568", namespace: "amazon" },
            ],
            facts: {
              // Epoch milliseconds are JSON numbers and are not scanned (this one passes Luhn).
              receivedAt: 1791100000002,
              merchant: { raw: "AMAZON 4111111111111112", key: "amazon", confidence: 0.9 },
              lineItems: [{ description: "Toothbrush", productId: "8901234567098" }],
            },
          }),
        );
        await insert(c, "user_assertions", assertionRow(alice, "ok-asr", ["obs-1"], { value: "shopping.electronics" }));
      });
      expect(await scalar<number>(db.pool, "select count(*)::int from public.observations where id = 'ok-1'")).toBe(1);
      await db.pool.query("delete from public.observations where id = 'ok-1'");
      await db.pool.query("delete from public.user_assertions where id = 'ok-asr'");
    });
  });

  // ------------------------------------------------------------- (7) ------
  describe("revoke_connection()", () => {
    let rita: string;
    let sam: string;

    beforeAll(async () => {
      rita = await db.createUser();
      sam = await db.createUser();
      for (const u of [rita, sam]) {
        await db.asUser(u, async (c) => {
          await insert(c, "source_connections", connectionRow(u, "conn-a", { scopes: ["sms:read"], purposes: ["detect purchases"] }));
          await insert(c, "source_connections", connectionRow(u, "conn-b", { adapter_id: "gmail", kind: "email" }));
          await insert(c, "observations", observationRow(u, { id: "a-1", connectionId: "conn-a" }));
          await insert(c, "observations", observationRow(u, { id: "a-2", connectionId: "conn-a" }));
          await insert(c, "observations", observationRow(u, { id: "b-1", connectionId: "conn-b" }));
          // Revocation outranks retention's anchoring: anchored observations go too.
          await insert(c, "user_assertions", assertionRow(u, "asr-a", ["a-1"]));
        });
      }
      await db.asUser(rita, (c) => c.query("insert into public.source_connections (connection_id, adapter_id, kind, label, status, excerpt_ttl_ms, granted_at, updated_at) values ('conn-rita-only', 'manual', 'manual', 'Manual entries', 'active', 0, now(), now())"));
    });

    it("revokes, appends a receipt and deletes only that connection's observations", async () => {
      const at = "2026-10-04T10:00:00.000Z";
      const deleted = await db.asUser(rita, (c) => scalar<number>(c, "select public.revoke_connection($1, $2)", ["conn-a", at]));
      expect(deleted).toBe(2);

      const conn = await db.pool.query(
        "select status, revoked_at, updated_at from public.source_connections where user_id = $1 and connection_id = 'conn-a'",
        [rita],
      );
      expect(conn.rows[0]).toMatchObject({ status: "revoked" });
      expect((conn.rows[0]?.revoked_at as Date).toISOString()).toBe(at);

      const receipts = await db.pool.query(
        "select action, at, scopes, purposes from public.consent_events where user_id = $1 and connection_id = 'conn-a'",
        [rita],
      );
      expect(receipts.rows).toEqual([
        { action: "revoked", at: new Date(at), scopes: ["sms:read"], purposes: ["detect purchases"] },
      ]);

      const remaining = await db.pool.query("select id from public.observations where user_id = $1 order by id", [rita]);
      expect(remaining.rows.map((r) => r.id)).toEqual(["b-1"]);
      // Same connection id, other user: untouched.
      expect(await count(db, "observations", sam)).toBe(3);
      const samConn = await db.pool.query(
        "select status from public.source_connections where user_id = $1 and connection_id = 'conn-a'",
        [sam],
      );
      expect(samConn.rows).toEqual([{ status: "active" }]);
    });

    it("is idempotent: no second receipt, original revoked_at kept", async () => {
      const deleted = await db.asUser(rita, (c) => scalar<number>(c, "select public.revoke_connection('conn-a')"));
      expect(deleted).toBe(0);
      expect(
        await scalar<number>(
          db.pool,
          "select count(*)::int from public.consent_events where user_id = $1 and connection_id = 'conn-a'",
          [rita],
        ),
      ).toBe(1);
    });

    it("fails for another user's connection exactly like for an unknown one", async () => {
      const foreign = await failure(db.asUser(sam, (c) => c.query("select public.revoke_connection('conn-rita-only')")));
      const unknown = await failure(db.asUser(sam, (c) => c.query("select public.revoke_connection('conn-nope')")));
      expect(foreign.code).toBe("P0002");
      expect(foreign.message).toBe(unknown.message);
      const conn = await db.pool.query(
        "select status from public.source_connections where user_id = $1 and connection_id = 'conn-rita-only'",
        [rita],
      );
      expect(conn.rows).toEqual([{ status: "active" }]);
    });

    it("requires a signed-in user", async () => {
      const err = await failure(db.asRole("authenticated", { role: "authenticated" }, (c) => c.query("select public.revoke_connection('conn-b')")));
      expect(err.code).toBe("42501");
    });

    it("keeps revocation final and drops late observations from other devices", async () => {
      const err = await failure(
        db.asUser(rita, (c) =>
          c.query("update public.source_connections set status = 'active', revoked_at = null where connection_id = 'conn-a'"),
        ),
      );
      expect(err.code).toBe("23514");
      const late = await db.asUser(rita, (c) => insert(c, "observations", observationRow(rita, { id: "a-3", connectionId: "conn-a" })));
      expect(late.rowCount).toBe(0);
      expect(await scalar<number>(db.pool, "select count(*)::int from public.observations where user_id = $1 and id = 'a-3'", [rita])).toBe(0);
    });
  });

  // ------------------------------------------------------------- (9) ------
  describe("export_my_data()", () => {
    it("returns every table's rows for the caller and nothing of anyone else", async () => {
      const doc = await db.asUser(alice, (c) => scalar<Record<string, unknown>>(c, "select public.export_my_data()"));
      expect(Object.keys(doc).sort()).toEqual(["exported_at", ...USER_TABLES].sort());
      const counts = await countsFor(db, alice);
      for (const t of USER_TABLES) {
        const rows = doc[t] as Row[];
        expect(rows, t).toHaveLength(counts[t]);
        expect(rows.length, t).toBeGreaterThan(0);
        for (const r of rows) expect(r.user_id, t).toBe(alice);
      }
      const obs = (doc.observations as Row[]).find((r) => r.id === "obs-1");
      expect(obs).toMatchObject({ evidence_excerpt: "Rs.1249.00 debited from a/c XX1234", facts: { id: "obs-1" } });
      expect(JSON.stringify(doc)).not.toContain(bob);
    });

    it("refuses anon and callers without a user id", async () => {
      expect((await failure(db.asAnon((c) => c.query("select public.export_my_data()")))).message).toMatch(FUNCTION_DENIED);
      const err = await failure(db.asRole("authenticated", { role: "authenticated" }, (c) => c.query("select public.export_my_data()")));
      expect(err.code).toBe("42501");
    });
  });

  describe("erase_my_data()", () => {
    it("removes every row of the caller in every table and nothing else", async () => {
      const carol = await db.createUser();
      await seedUser(db, carol);
      await db.asUser(carol, (c) => insert(c, "consent_events", consentRow(carol, "conn-sms", "paused")));
      const carolBefore = await countsFor(db, carol);
      for (const t of USER_TABLES) expect(carolBefore[t], t).toBeGreaterThan(0);
      const othersBefore = [await countsFor(db, alice), await countsFor(db, bob)];

      await db.asUser(carol, (c) => c.query("select public.erase_my_data()"));

      const carolAfter = await countsFor(db, carol);
      for (const t of USER_TABLES) expect(carolAfter[t], t).toBe(0);
      expect([await countsFor(db, alice), await countsFor(db, bob)]).toEqual(othersBefore);
      // The auth account itself is Supabase Auth's to delete.
      expect(await scalar<number>(db.pool, "select count(*)::int from auth.users where id = $1", [carol])).toBe(1);
    });

    it("raises for anon, for service_role and for authenticated without a user id", async () => {
      expect((await failure(db.asAnon((c) => c.query("select public.erase_my_data()")))).message).toMatch(FUNCTION_DENIED);
      for (const [role, claims] of [
        ["service_role", { role: "service_role" }],
        ["authenticated", { role: "authenticated" }],
        ["authenticated", null],
      ] as const) {
        const err = await failure(db.asRole(role, claims, (c) => c.query("select public.erase_my_data()")));
        expect(err.code, role).toBe("42501");
        expect(err.message).toMatch(/requires a signed-in user/);
      }
      expect(await count(db, "observations", alice)).toBe(3);
    });
  });

  // ------------------------------------------------------------ (10) ------
  describe("account deletion", () => {
    it("deleting the auth.users row cascades to every table", async () => {
      const dave = await db.createUser();
      await seedUser(db, dave);
      const othersBefore = [await countsFor(db, alice), await countsFor(db, bob)];
      await db.pool.query("delete from auth.users where id = $1", [dave]);
      const after = await countsFor(db, dave);
      for (const t of USER_TABLES) expect(after[t], t).toBe(0);
      expect([await countsFor(db, alice), await countsFor(db, bob)]).toEqual(othersBefore);
    });
  });

  // -------------------------------------------- through PostgREST + supabase-js ----
  describe("through PostgREST and supabase-js", () => {
    let api: PostgrestServer;
    const clientFor = (key: string, token?: string): SupabaseClient =>
      createClient(api.supabaseUrl, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        ...(token ? { accessToken: async () => token } : {}),
      });

    beforeAll(async () => {
      api = await startPostgrest(db.url);
    });

    afterAll(async () => {
      await api?.stop();
    });

    it("gives the anon key no user data but the capability registry", async () => {
      const anon = clientFor(api.anonKey);
      const obs = await anon.from("observations").select("id");
      expect(obs.error?.code).toBe("42501");
      expect(obs.data).toBeNull();
      const reg = await anon.from("capability_registry").select("version");
      expect(reg.error).toBeNull();
      expect(reg.data).toEqual([{ version: "2026.10.0" }]);
      const write = await anon.from("capability_registry").insert({ version: "x", document: {} });
      expect(write.error?.code).toBe("42501");
      const rpc = await anon.rpc("erase_my_data");
      expect(rpc.error?.code).toBe("42501");
    });

    it("scopes a signed-in user to their own rows and rejects forged user ids", async () => {
      const asAlice = clientFor(api.anonKey, api.userToken(alice));
      const mine = await asAlice.from("observations").select("user_id, id").order("id");
      expect(mine.error).toBeNull();
      expect(mine.data?.length).toBe(await count(db, "observations", alice));
      expect(new Set(mine.data?.map((r) => r.user_id))).toEqual(new Set([alice]));

      const forged = await asAlice.from("budgets").insert({ ...budgetRow(bob, "forged-api") });
      expect(forged.error?.code).toBe("42501");

      // putObservations is idempotent: an upsert that ignores duplicates, user_id defaulted from the JWT.
      const { user_id: _omit, ...row } = observationRow(alice, { id: "api-1", connectionId: "conn-sms" });
      for (let i = 0; i < 2; i++) {
        const put = await asAlice.from("observations").upsert(row, { onConflict: "user_id,id", ignoreDuplicates: true });
        expect(put.error).toBeNull();
      }
      expect(await scalar<number>(db.pool, "select count(*)::int from public.observations where id = 'api-1'")).toBe(1);
      await db.pool.query("delete from public.observations where id = 'api-1'");

      const exported = await asAlice.rpc("export_my_data");
      expect(exported.error).toBeNull();
      expect(JSON.stringify(exported.data)).not.toContain(bob);
    });

    it("does not expose the private schema", async () => {
      const service = clientFor(api.serviceRoleKey);
      const res = await service.rpc("apply_retention");
      expect(res.error?.code).toBe("PGRST202");
      const viaUrl = await fetch(`${api.url}/rpc/apply_retention`, {
        method: "POST",
        headers: { authorization: `Bearer ${api.serviceRoleKey}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(viaUrl.status).toBe(404);
    });

    it("lets service_role see across users", async () => {
      const service = clientFor(api.serviceRoleKey);
      const res = await service.from("observations").select("user_id");
      expect(res.error).toBeNull();
      const owners = new Set(res.data?.map((r) => r.user_id));
      expect(owners.has(alice) && owners.has(bob)).toBe(true);
    });
  });
});

// ------------------------------------------------------------------ (8) ----
// Retention deletes across all users, so it gets a database of its own.
describe("private.apply_retention()", () => {
  let db: TestDatabase;
  let user: string;
  let other: string;
  const NOW = Date.parse("2026-10-04T12:00:00Z");

  beforeAll(async () => {
    db = await createTestDatabase();
    user = await db.createUser();
    other = await db.createUser();
    for (const u of [user, other]) {
      await db.asUser(u, async (c) => {
        // Bounded facts (30 days) and a 7-day excerpt policy.
        await insert(c, "source_connections", connectionRow(u, "conn-email", {
          adapter_id: "gmail",
          kind: "email",
          excerpt_ttl_ms: 7 * DAY,
          observation_ttl_ms: 30 * DAY,
        }));
        // Facts kept until disconnect.
        await insert(c, "source_connections", connectionRow(u, "conn-sms", { observation_ttl_ms: null }));
      });
    }
    await db.asUser(user, async (c) => {
      const obs = (input: ObservationInput) => insert(c, "observations", observationRow(user, input));
      await obs({ id: "old", connectionId: "conn-email", receivedAt: NOW - 40 * DAY });
      await obs({
        id: "old-anchored",
        connectionId: "conn-email",
        receivedAt: NOW - 40 * DAY,
        excerpt: "Your order of Toothbrush",
        excerptExpiresAt: NOW - 33 * DAY,
      });
      // A wrongly future-dated occurredAt must not extend retention.
      await obs({ id: "old-future-dated", connectionId: "conn-email", receivedAt: NOW - 40 * DAY, occurredAt: NOW + 10 * DAY });
      await obs({ id: "old-no-occurred", connectionId: "conn-email", receivedAt: NOW - 31 * DAY, occurredAt: null });
      await obs({
        id: "fresh-adapter-expired",
        connectionId: "conn-email",
        receivedAt: NOW - DAY,
        excerpt: "Your order of Toothbrush",
        excerptExpiresAt: NOW - HOUR,
      });
      await obs({
        id: "fresh-policy-expired",
        connectionId: "conn-email",
        receivedAt: NOW - 8 * DAY,
        excerpt: "Your order of USB cable",
        excerptExpiresAt: NOW + 30 * DAY,
      });
      await obs({
        id: "fresh",
        connectionId: "conn-email",
        receivedAt: NOW - DAY,
        excerpt: "Your order of Dog food",
        excerptExpiresAt: NOW + 6 * DAY,
      });
      await obs({ id: "sms-old", connectionId: "conn-sms", receivedAt: NOW - 400 * DAY });
      await insert(c, "user_assertions", assertionRow(user, "label-anchored", ["old-anchored"]));
    });
    // Another user's assertion naming the same id must not protect this user's observation.
    await db.asUser(other, (c) => insert(c, "user_assertions", assertionRow(other, "label-other", ["old"])));
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("is not executable by authenticated, anon or service_role", async () => {
    const runners: Runner[] = [(fn) => db.asUser(user, fn), (fn) => db.asAnon(fn), (fn) => db.asService(fn)];
    for (const run of runners) {
      const err = await failure(run((c) => c.query("select * from private.apply_retention()")));
      expect(err.message).toMatch(PRIVATE_DENIED);
    }
    const { rows } = await db.pool.query(
      `select r as role, has_function_privilege(r, 'private.apply_retention(timestamptz)', 'execute') as can
       from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: false },
    ]);
  });

  it("deletes TTL-expired unanchored observations and clears expired excerpts", async () => {
    const { rows } = await db.pool.query("select * from private.apply_retention($1)", [iso(NOW)]);
    expect(rows).toEqual([{ excerpts_cleared: 3, observations_deleted: 3 }]);

    const left = await db.pool.query<{ id: string; evidence_excerpt: string | null; excerpt_expires_at: Date | null }>(
      "select id, evidence_excerpt, excerpt_expires_at from public.observations where user_id = $1 order by id",
      [user],
    );
    expect(left.rows).toEqual([
      { id: "fresh", evidence_excerpt: "Your order of Dog food", excerpt_expires_at: new Date(NOW + 6 * DAY) },
      { id: "fresh-adapter-expired", evidence_excerpt: null, excerpt_expires_at: null },
      { id: "fresh-policy-expired", evidence_excerpt: null, excerpt_expires_at: null },
      // Anchored by the user's label: the fact stays, its text does not.
      { id: "old-anchored", evidence_excerpt: null, excerpt_expires_at: null },
      // No TTL on this connection: kept until disconnect.
      { id: "sms-old", evidence_excerpt: null, excerpt_expires_at: null },
    ]);
  });

  it("is idempotent", async () => {
    const { rows } = await db.pool.query("select * from private.apply_retention($1)", [iso(NOW)]);
    expect(rows).toEqual([{ excerpts_cleared: 0, observations_deleted: 0 }]);
  });

  it("survives absurd client-supplied TTLs instead of aborting for every user", async () => {
    await db.asUser(other, (c) =>
      c.query("update public.source_connections set excerpt_ttl_ms = $1, observation_ttl_ms = $1 where connection_id = 'conn-email'", [
        "9223372036854775807",
      ]),
    );
    await db.asUser(other, (c) =>
      insert(c, "observations", observationRow(other, { id: "x", connectionId: "conn-email", excerpt: "t", receivedAt: NOW - DAY })),
    );
    const { rows } = await db.pool.query("select * from private.apply_retention($1)", [iso(NOW)]);
    expect(rows).toEqual([{ excerpts_cleared: 0, observations_deleted: 0 }]);
  });
});
