import { readFile } from "node:fs/promises";
import { DAY, HOUR, fixedClock } from "@brake/core";
import type { BrakeStore, Observation } from "@brake/core";
import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, SHIM_FILE, createTestDatabase, isDatabaseAvailable, migrationFiles, startPostgrest } from "../../../supabase/tests/harness";
import type { PostgrestServer, TestDatabase } from "../../../supabase/tests/harness";
import { MAX_FACTS_BYTES, containsCardNumber, jsonContainsCardNumber, jsonbSize } from "../../core/src/store-memory";
import { CONTRACT_T0, contractConnection, contractObservation, describeStoreContract } from "../../core/test/store-contract";
import { ID_FILTER_MAX_URL_CHARS, createSupabaseStore, observationFacts, SupabaseStoreError } from "../src/index";
import type { Database } from "../src/index";

/**
 * The Supabase store through the real stack: supabase-js -> PostgREST 13 ->
 * Postgres 16 with the BRAKE migrations, row-level security and the Supabase
 * roles/default grants (supabase/tests/shim.sql). Nothing is mocked, so these
 * tests prove what the database actually enforces, not what the client hopes.
 *
 * Needs the local test cluster (`npm run db:start`); skipped when it is not
 * reachable. Run with `npm run test:db`.
 */

const T0 = CONTRACT_T0;
const available = await isDatabaseAvailable();

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  /** The raw (still URL-encoded) query string, for URL-length checks. */
  readonly search: string;
  readonly rows: number;
  /** `user_id` of every row in the request body. */
  readonly bodyUserIds: readonly unknown[];
}

describe.skipIf(!available)("Supabase store over PostgREST + Postgres", () => {
  let db: TestDatabase;
  let server: PostgrestServer;

  beforeAll(async () => {
    db = await createTestDatabase();
    server = await startPostgrest(db.url);
  });

  afterAll(async () => {
    await server?.stop();
    await db?.drop();
  });

  /**
   * A supabase-js client signed in as `userId`: the public anon key as
   * `apikey` plus the user's access token, exactly what an app sends after
   * sign-in. `requests` (optional) records every call for batching checks.
   */
  function clientFor(userId: string | null, requests?: RecordedRequest[]) {
    const recordingFetch: typeof fetch = async (input, init) => {
      if (requests) {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
        const rows = Array.isArray(body) ? body : body ? [body] : [];
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          search: url.search,
          rows: rows.length,
          bodyUserIds: url.pathname.includes("/rpc/") ? [] : rows.map((r) => (r as { user_id?: unknown }).user_id),
        });
      }
      return fetch(input, init);
    };
    return createClient<Database>(server.supabaseUrl, server.anonKey, {
      global: {
        headers: userId === null ? {} : { Authorization: `Bearer ${server.userToken(userId)}` },
        fetch: recordingFetch,
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  describeStoreContract("supabase", async ({ clock }) => {
    const userId = await db.createUser();
    return { store: createSupabaseStore({ client: clientFor(userId), userId, clock }) };
  });

  /**
   * Hosted projects may set a database time zone, and PostgREST then prints
   * every timestamptz in it: half-hour offsets, historical offsets with
   * seconds (LMT, e.g. -03:30:52), and " BC" for an instant whose *local* date
   * falls before year 1. The whole contract must hold there too.
   */
  describe("with a non-UTC database time zone", () => {
    let zoned: TestDatabase;
    let zonedServer: PostgrestServer;

    beforeAll(async () => {
      zoned = await createTestDatabase();
      await zoned.pool.query(`alter database "${zoned.name}" set timezone to 'America/St_Johns'`);
      zonedServer = await startPostgrest(zoned.url);
    });

    afterAll(async () => {
      await zonedServer?.stop();
      await zoned?.drop();
    });

    describeStoreContract("supabase (America/St_Johns)", async ({ clock }) => {
      const userId = await zoned.createUser();
      const client = createClient<Database>(zonedServer.supabaseUrl, zonedServer.anonKey, {
        global: { headers: { Authorization: `Bearer ${zonedServer.userToken(userId)}` } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      return { store: createSupabaseStore({ client, userId, clock }) };
    });
  });

  /**
   * Hosted or self-hosted clusters may be initialised with a linguistic default
   * collation (en_US.UTF-8) instead of the C.UTF-8 the local test cluster uses.
   * Text keys then sort as "obs_a, obs_ä, obs_B, obs-c", not by code point.
   * Keyset pagination must stay complete and duplicate-free either way, and
   * the order itself matches the memory store because the migrations declare
   * the id-like key columns `collate "C"` instead of inheriting the default.
   */
  describe("with a linguistic default collation (ICU en-US)", () => {
    const icuName = `brake_test_${process.pid}_icu_${Date.now().toString(36)}`;
    let admin: PgClient;
    let icu: PgClient;
    let icuServer: PostgrestServer;
    let store: BrakeStore;
    const tied = ["obs_B", "obs_a", "obs-c", "obs_ä", "obs10", "obs9", "OBS", "obs"];

    beforeAll(async () => {
      admin = new PgClient({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`create database ${icuName} template template0 locale_provider icu icu_locale 'en-US' locale 'C.UTF-8'`);
      const url = new URL(ADMIN_URL);
      url.pathname = `/${icuName}`;
      icu = new PgClient({ connectionString: url.href });
      await icu.connect();
      await icu.query(await readFile(SHIM_FILE, "utf8"));
      for (const file of await migrationFiles()) await icu.query(await readFile(file, "utf8"));
      icuServer = await startPostgrest(url.href);
      const { rows } = await icu.query<{ id: string }>("insert into auth.users (email) values ('icu@example.test') returning id");
      const userId = rows[0]!.id;
      const client = createClient<Database>(icuServer.supabaseUrl, icuServer.anonKey, {
        global: { headers: { Authorization: `Bearer ${icuServer.userToken(userId)}` } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      store = createSupabaseStore({ client, userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      await store.putObservations(tied.map((id) => contractObservation(id, "conn_a", T0)));
    });

    afterAll(async () => {
      await icuServer?.stop();
      await icu?.end().catch(() => undefined);
      await admin?.query(`drop database if exists ${icuName} with (force)`);
      await admin?.end();
    });

    async function paged(limit: number): Promise<string[]> {
      const out: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await store.listObservations({ limit, ...(after !== undefined ? { after } : {}) });
        out.push(...page.items.map((o) => o.id));
        after = page.next;
        if (after === undefined) break;
      }
      return out;
    }

    it("pages through ties on receivedAt completely, without duplicates, in one stable order", async () => {
      const whole = (await store.listObservations()).items.map((o) => o.id);
      expect([...whole].sort()).toEqual([...tied].sort());
      expect(await paged(1)).toEqual(whole);
      expect(await paged(3)).toEqual(whole);
    });

    // Regression: before the key columns were declared `collate "C"`, ties
    // came back in the cluster's linguistic order (obs_a, obs_ä, obs_B, obs-c, ...).
    it("orders ties by code point like the memory store (key columns are collate \"C\")", async () => {
      expect(await paged(2)).toEqual([...tied].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    });
  });

  describe("isolation between users (through the API)", () => {
    let alice: string;
    let bob: string;
    let aliceStore: BrakeStore;
    const aliceObs: Observation[] = [];

    beforeAll(async () => {
      alice = await db.createUser("alice@example.test");
      bob = await db.createUser("bob@example.test");
      aliceStore = createSupabaseStore({ client: clientFor(alice), userId: alice, clock: fixedClock(T0) });
      await aliceStore.upsertConnection(contractConnection("conn_alice"));
      aliceObs.push(contractObservation("obs_1", "conn_alice", T0), contractObservation("obs_2", "conn_alice", T0 + 1));
      await aliceStore.putObservations(aliceObs);
      await aliceStore.putAssertion({ id: "as_1", kind: "confirm", at: T0, anchors: ["obs_1"] });
    });

    /** Bob's token, but claiming to be Alice: only RLS stands in the way. */
    const bobPosingAsAlice = () => createSupabaseStore({ client: clientFor(bob), userId: alice, clock: fixedClock(T0) });

    async function aliceIsIntact(): Promise<void> {
      expect((await aliceStore.listObservations()).items).toEqual(aliceObs);
      expect((await aliceStore.listConnections()).map((c) => c.status)).toEqual(["active"]);
      expect(await aliceStore.listAssertions()).toHaveLength(1);
    }

    it("cannot read another user's rows even when it passes their userId", async () => {
      const store = bobPosingAsAlice();
      expect((await store.listObservations()).items).toEqual([]);
      expect(await store.listConnections()).toEqual([]);
      expect(await store.listAssertions()).toEqual([]);
      expect(await store.listConsentEvents()).toEqual([]);
      const exported = await store.exportAll();
      expect(exported.observations).toEqual([]);
      expect(exported.connections).toEqual([]);
    });

    it("cannot write rows owned by another user", async () => {
      const store = bobPosingAsAlice();
      const overwrite = { ...aliceObs[0]!, confidence: 0.01 };
      await expect(store.putObservations([overwrite])).rejects.toMatchObject({ code: "42501" });
      await expect(store.upsertConnection(contractConnection("conn_alice", { label: "hijacked" }))).rejects.toMatchObject({ code: "42501" });
      await expect(store.putAssertion({ id: "as_1", kind: "dismiss", at: T0, anchors: ["obs_1"], reason: "not_mine" })).rejects.toMatchObject({
        code: "42501",
      });
      await expect(store.appendConsentEvent({ connectionId: "conn_alice", action: "revoked", at: T0, scopes: [], purposes: [] })).rejects.toMatchObject({
        code: "42501",
      });
      await aliceIsIntact();
    });

    it("cannot delete, revoke or erase another user's data", async () => {
      const store = bobPosingAsAlice();
      expect(await store.deleteObservations(["obs_1", "obs_2"])).toBe(0);
      await store.deleteAssertion("as_1");
      // Not found, exactly like a connection that does not exist: no oracle for other users' ids.
      await expect(store.revokeConnection("conn_alice", T0)).rejects.toMatchObject({ code: "P0002" });
      await store.eraseAll();
      await aliceIsIntact();
    });

    it("keeps ids per user: the same observation id never collides across users", async () => {
      const bobStore = createSupabaseStore({ client: clientFor(bob), userId: bob, clock: fixedClock(T0) });
      await bobStore.upsertConnection(contractConnection("conn_alice"));
      const mine = contractObservation("obs_1", "conn_alice", T0 + DAY, { minor: 1 });
      expect(await bobStore.putObservations([mine])).toEqual({ inserted: 1 });
      expect((await bobStore.listObservations()).items).toEqual([mine]);
      await aliceIsIntact();
      await bobStore.eraseAll();
      await aliceIsIntact();
    });

    it("scopes every request to its own user, but relies on RLS rather than that scoping", async () => {
      const carol = await db.createUser();
      const requests: RecordedRequest[] = [];
      const store = createSupabaseStore({ client: clientFor(carol, requests), userId: carol, clock: fixedClock(T0) });
      await store.putSettings({ locale: "en-IN", timeZone: "Asia/Kolkata", questionWeeklyBudget: 5, regretPromptsEnabled: true });
      await store.upsertConnection(contractConnection("conn_c"));
      await store.appendConsentEvent({ connectionId: "conn_c", action: "granted", at: T0, scopes: [], purposes: [] });
      await store.putObservations([contractObservation("obs_1", "conn_c", T0, { evidence: { summary: "s", excerpt: "e", excerptExpiresAt: T0 + DAY } })]);
      await store.putAssertion({ id: "as_1", kind: "confirm", at: T0, anchors: ["obs_1"] });
      await store.putBudget({ limit: { minor: 1, currency: "INR" }, period: "weekly" });
      await store.putGoal({ id: "g", name: "n", target: { minor: 1, currency: "INR" }, saved: { minor: 0, currency: "INR" } });
      await store.putRule({ id: "r", description: "d", level: "inform" });
      await store.putOwnedInstrument({ id: "i", type: "wallet" });
      await store.logPrompt({ id: "p", kind: "question", shownAt: T0 });
      await store.getSettings();
      await store.listConnections();
      await store.listConsentEvents();
      await store.listObservations({ connectionId: "conn_c" });
      await store.listAssertions();
      await store.listBudgets();
      await store.listGoals();
      await store.listRules();
      await store.listOwnedInstruments();
      await store.listPrompts(0);
      await store.deleteObservations(["obs_x"]);
      await store.deleteAssertion("as_x");

      const tableRequests = requests.filter((r) => !r.path.includes("/rpc/"));
      expect(tableRequests.length).toBeGreaterThan(15);
      for (const r of tableRequests) {
        // Writes carry only rows of this user; reads and deletes filter on this user.
        for (const id of r.bodyUserIds) expect(id).toBe(carol);
        if (r.method === "GET" || r.method === "DELETE") expect(new URLSearchParams(r.search).get("user_id")).toBe(`eq.${carol}`);
      }

      // The filter is a convenience, not the boundary: a raw client of Carol's
      // that filters on nothing (or on Alice) still sees only Carol's rows.
      const raw = clientFor(carol);
      const unfiltered = await raw.from("observations").select("user_id, id");
      expect(unfiltered.error).toBeNull();
      expect(new Set(unfiltered.data!.map((r) => r.user_id))).toEqual(new Set([carol]));
      const aimed = await raw.from("observations").select("id").eq("user_id", alice);
      expect(aimed.data).toEqual([]);
      // Nor can an unfiltered update or delete touch Alice's rows: both have an
      // "as_1" and an "obs_1", but only Carol's are visible to Carol's token.
      const patched = await raw.from("user_assertions").update({ kind: "dismiss" }, { count: "exact" }).eq("id", "as_1");
      expect(patched.error).toBeNull();
      expect(patched.count).toBe(1);
      const deleted = await raw.from("observations").delete({ count: "exact" }).eq("id", "obs_2");
      expect(deleted.count).toBe(0);
      // Observations are immutable through the API, for everyone. The Database
      // type already forbids the update at compile time; the cast proves the
      // database refuses it too.
      const rewritten = await raw.from("observations").update({ confidence: 0.01 } as never).eq("id", "obs_1");
      expect(rewritten.error?.code).toBe("42501");
      await aliceIsIntact();
      expect((await aliceStore.listAssertions())[0]?.kind).toBe("confirm");
    });

    it("gives the public anon key no access to user data", async () => {
      const anon = createSupabaseStore({ client: clientFor(null), userId: alice, clock: fixedClock(T0) });
      await expect(anon.listObservations()).rejects.toMatchObject({ code: "42501" });
      await expect(anon.listConnections()).rejects.toMatchObject({ code: "42501" });
      await expect(anon.eraseAll()).rejects.toBeInstanceOf(SupabaseStoreError);
      await aliceIsIntact();
    });
  });

  describe("what reaches the database", () => {
    it("stores facts without the excerpt, and the excerpt with its capped expiry", async () => {
      const userId = await db.createUser();
      const store = createSupabaseStore({ client: clientFor(userId), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a", { retention: { excerptTtlMs: DAY, observationTtlMs: null } }));
      await store.putObservations([
        contractObservation("obs_1", "conn_a", T0, {
          evidence: { summary: "Test Bank SMS: ₹1,249.00 debited", excerpt: "Rs 1249.00 debited to AMAZON", excerptExpiresAt: T0 + 5 * DAY },
        }),
      ]);
      const { rows } = await db.pool.query<{ facts: Observation; evidence_excerpt: string; excerpt_expires_at: Date; amount_minor: string; merchant_key: string }>(
        "select facts, evidence_excerpt, excerpt_expires_at, amount_minor, merchant_key from public.observations where user_id = $1",
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.facts.evidence).toEqual({ summary: "Test Bank SMS: ₹1,249.00 debited" });
      expect(rows[0]!.evidence_excerpt).toBe("Rs 1249.00 debited to AMAZON");
      expect(rows[0]!.excerpt_expires_at.getTime()).toBe(T0 + DAY);
      expect(Number(rows[0]!.amount_minor)).toBe(124_900);
      expect(rows[0]!.merchant_key).toBe("amazon");

      // Once the hourly retention job has run past the expiry, the text is gone from storage too.
      await db.pool.query("select * from private.apply_retention($1)", [new Date(T0 + 2 * DAY)]);
      const after = await db.pool.query<{ evidence_excerpt: string | null }>(
        "select evidence_excerpt from public.observations where user_id = $1",
        [userId],
      );
      expect(after.rows[0]!.evidence_excerpt).toBeNull();
    });

    it("reports violations by code without echoing row contents", async () => {
      const userId = await db.createUser();
      const store = createSupabaseStore({ client: clientFor(userId), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      const leaky = contractObservation("obs_1", "conn_a", T0, { merchant: { raw: "PAYMENT 4111111111111111 SECRETMERCHANT", confidence: 0.5 } });
      const error = await store.putObservations([leaky]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseStoreError);
      expect((error as SupabaseStoreError).code).toBe("23514");
      expect((error as SupabaseStoreError).message).not.toContain("4111111111111111");
      expect((error as SupabaseStoreError).message).not.toContain("SECRETMERCHANT");

      const tooLong = contractObservation("obs_2", "conn_a", T0, { evidence: { summary: "s", excerpt: `SECRET-${"y".repeat(600)}`, excerptExpiresAt: T0 + DAY } });
      const lengthError = (await store.putObservations([tooLong]).catch((e: unknown) => e)) as SupabaseStoreError;
      expect(lengthError.code).toBe("23514");
      expect(lengthError.message).not.toContain("SECRET");
    });

    it("writes in batches of at most 500 rows and pages reads within the row cap", async () => {
      const userId = await db.createUser();
      const requests: RecordedRequest[] = [];
      const store = createSupabaseStore({ client: clientFor(userId, requests), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      const many = Array.from({ length: 1_201 }, (_, i) => contractObservation(`obs_${String(i).padStart(5, "0")}`, "conn_a", T0 + i));

      requests.length = 0;
      expect(await store.putObservations(many)).toEqual({ inserted: 1_201 });
      const writes = requests.filter((r) => r.method === "POST" && r.path.endsWith("/observations"));
      expect(writes.map((r) => r.rows)).toEqual([500, 500, 201]);
      expect(await store.putObservations(many)).toEqual({ inserted: 0 });

      const first = await store.listObservations({ limit: 1_000 });
      expect(first.items).toHaveLength(1_000);
      const second = await store.listObservations({ after: first.next! });
      expect(second.items).toHaveLength(201);
      expect(second.next).toBeUndefined();
      expect([...first.items, ...second.items].map((o) => o.id)).toEqual(many.map((o) => o.id));

      requests.length = 0;
      expect(await store.deleteObservations(many.map((o) => o.id))).toBe(1_201);
      expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(13);
    });

    it("judges card numbers exactly like the memory store does", async () => {
      // The memory store re-implements the database's guard; any drift would let
      // code pass on the device and fail on sync (or the other way round).
      const card = "4111111111111111";
      const texts = [
        card,
        `PAYMENT ${card}`,
        `x${card}`,
        `${card}x`,
        `_${card}`,
        `₹${card}`,
        `é${card}`,
        `card:${card}.`,
        `${card}\n`,
        "4111 1111 1111 1111",
        "4111-1111-1111-1111",
        "4111 1111 1111 1111 123",
        "4111 1111 1111 1111 2222",
        "3782 822463 10005",
        "378282246310005",
        "4222222222222",
        "6011111111111117",
        "94111111111111111111",
        "4111111111111112",
        "627712345678",
        "408-1234567-1234567",
        "card ••••1111 / XX1111",
        String(CONTRACT_T0),
      ];
      for (const text of texts) {
        const { rows } = await db.pool.query<{ hit: boolean }>("select private.contains_card_number($1) as hit", [text]);
        expect([text, containsCardNumber(text)]).toEqual([text, rows[0]!.hit]);
      }
      const docs: unknown[] = [
        { merchant: { raw: card } },
        { tags: ["x", card] },
        { references: [{ type: "order_id", value: card }] },
        { deep: { references: [{ value: card }] } },
        { references: { value: card } },
        { lineItems: [{ productId: card }], intent: { url: card }, merchant: { website: card } },
        { [card]: "x" },
        { n: Number(card) },
        card,
      ];
      for (const doc of docs) {
        const { rows } = await db.pool.query<{ hit: boolean }>("select private.json_contains_card_number($1::jsonb) as hit", [JSON.stringify(doc)]);
        expect([doc, jsonContainsCardNumber(doc)]).toEqual([doc, rows[0]!.hit]);
      }
    });

    it("batches writes and id filters exactly at their limits", async () => {
      const userId = await db.createUser();
      const requests: RecordedRequest[] = [];
      const store = createSupabaseStore({ client: clientFor(userId, requests), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      const make = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => contractObservation(`${prefix}_${String(i).padStart(4, "0")}`, "conn_a", T0 + i));
      const writes = () => requests.filter((r) => r.method === "POST" && r.path.endsWith("/observations")).map((r) => r.rows);
      const deletes = () => requests.filter((r) => r.method === "DELETE").length;

      requests.length = 0;
      expect(await store.putObservations(make(500, "a"))).toEqual({ inserted: 500 });
      expect(writes()).toEqual([500]);
      requests.length = 0;
      expect(await store.putObservations(make(501, "b"))).toEqual({ inserted: 501 });
      expect(writes()).toEqual([500, 1]);

      requests.length = 0;
      expect(await store.deleteObservations(make(100, "a").map((o) => o.id))).toBe(100);
      expect(deletes()).toBe(1);
      requests.length = 0;
      expect(await store.deleteObservations(make(101, "b").map((o) => o.id))).toBe(101);
      expect(deletes()).toBe(2);
    });

    it("splits id filters by URL length, so long ids never exceed the gateway's limit", async () => {
      const userId = await db.createUser();
      const requests: RecordedRequest[] = [];
      const store = createSupabaseStore({ client: clientFor(userId, requests), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      // 100 ids of 300 characters: a single request (~30 KB of URL) got HTTP 431 from the gateway.
      const longIds = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}:`.padEnd(300, "x"));
      expect(await store.putObservations(longIds.map((id, i) => contractObservation(id, "conn_a", T0 + i)))).toEqual({ inserted: 100 });
      requests.length = 0;
      expect(await store.deleteObservations(longIds)).toBe(100);
      const deleteRequests = requests.filter((r) => r.method === "DELETE");
      expect(deleteRequests.length).toBeGreaterThan(1);
      for (const r of deleteRequests) expect(r.search.length).toBeLessThan(ID_FILTER_MAX_URL_CHARS + 500);
      expect((await store.listObservations()).items).toEqual([]);
    });

    it("measures facts exactly as the database's 32 KiB check does", async () => {
      // The memory store's jsonbSize must agree with pg_column_size byte for byte,
      // or code passes on the device and fails on sync (or the other way round).
      const corpus: unknown[] = [
        observationFacts(contractObservation("o", "c", T0)),
        observationFacts(contractObservation("o", "c", T0, { minor: Number.MAX_SAFE_INTEGER, confidence: 1e-50 })),
        { a: [0, -1, 0.5, 1e-7, 1e21, 123456789.125, 10000, 99990000] },
        { "é": "₹🙂", z: [true, false, null, { "": "" }], aa: { bb: [[[]]] } },
        { d: "\n\t\"\\".repeat(50) },
      ];
      for (const doc of corpus) {
        const { rows } = await db.pool.query<{ size: number }>("select pg_column_size($1::jsonb) as size", [JSON.stringify(doc)]);
        expect([doc, jsonbSize(doc)]).toEqual([doc, rows[0]!.size]);
      }

      // Find the largest description that still fits and the smallest that does not.
      const sized = (n: number) => contractObservation(`obs_${n}`, "conn_a", T0, { lineItems: [{ description: "x".repeat(n), quantity: 2 }] });
      let fits = 0;
      let overflows = 40_000;
      while (overflows - fits > 1) {
        const mid = Math.floor((fits + overflows) / 2);
        if (jsonbSize(observationFacts(sized(mid))) <= MAX_FACTS_BYTES) fits = mid;
        else overflows = mid;
      }
      expect(jsonbSize(observationFacts(sized(fits)))).toBeGreaterThan(MAX_FACTS_BYTES - 4);
      const userId = await db.createUser();
      const store = createSupabaseStore({ client: clientFor(userId), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      expect(await store.putObservations([sized(fits)])).toEqual({ inserted: 1 });
      await expect(store.putObservations([sized(overflows)])).rejects.toMatchObject({ code: "23514" });
    });

    it("stores the projected columns exactly, at the edges of their types", async () => {
      const userId = await db.createUser();
      const store = createSupabaseStore({ client: clientFor(userId), userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      const MAX_INSTANT = 8_640_000_000_000_000;
      await store.putObservations([
        contractObservation("obs_big", "conn_a", MAX_INSTANT, { minor: Number.MAX_SAFE_INTEGER, confidence: 1e-50, occurredAt: { value: T0, confidence: 1 } }),
      ]);
      const { rows } = await db.pool.query<{ amount: string; confidence: number; received: string; facts_amount: string }>(
        `select amount_minor::text as amount, confidence, to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') as received,
                (facts #>> '{amount,value,minor}') as facts_amount
           from public.observations where user_id = $1`,
        [userId],
      );
      expect(rows).toEqual([{ amount: "9007199254740991", confidence: 0, received: "275760-09-13T00:00:00.000", facts_amount: "9007199254740991" }]);
    });

    it("probes instead of returning a dangling cursor when a page fills the row cap", async () => {
      const userId = await db.createUser();
      const requests: RecordedRequest[] = [];
      const store = createSupabaseStore({ client: clientFor(userId, requests), userId, clock: fixedClock(T0), maxRows: 3 });
      await store.upsertConnection(contractConnection("conn_a"));
      await store.putObservations(Array.from({ length: 6 }, (_, i) => contractObservation(`obs_${i}`, "conn_a", T0 + i)));
      requests.length = 0;
      const first = await store.listObservations({ limit: 5 });
      expect(first.items).toHaveLength(3);
      const second = await store.listObservations({ limit: 5, after: first.next! });
      expect(second.items.map((o) => o.id)).toEqual(["obs_3", "obs_4", "obs_5"]);
      expect(second.next).toBeUndefined();
      // Each page: one read plus one single-row probe; never a request for more than 3 rows.
      const gets = requests.filter((r) => r.method === "GET");
      expect(gets).toHaveLength(4);
      for (const r of gets) expect(Number(new URLSearchParams(r.search).get("limit"))).toBeLessThanOrEqual(3);
    });

    it("lists everything even when the server's row cap is lower than the store assumes", async () => {
      // A project whose "Max Rows" was lowered to 3, while the store keeps its
      // default assumption of 1000: PostgREST then silently clamps every
      // response, exactly like this fetch does to the `limit` it is sent.
      const userId = await db.createUser();
      let requests = 0;
      const clamped: typeof fetch = async (input, init) => {
        requests += 1;
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const limit = url.searchParams.get("limit");
        if (limit !== null && Number(limit) > 3) url.searchParams.set("limit", "3");
        return fetch(url, init);
      };
      const client = createClient<Database>(server.supabaseUrl, server.anonKey, {
        global: { headers: { Authorization: `Bearer ${server.userToken(userId)}` }, fetch: clamped },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const store = createSupabaseStore({ client, userId, clock: fixedClock(T0) });
      for (let i = 0; i < 7; i++) await store.upsertConnection(contractConnection(`conn_${i}`));
      for (let i = 0; i < 5; i++) await store.putGoal({ id: `g${i}`, name: "n", target: { minor: 1, currency: "INR" }, saved: { minor: 0, currency: "INR" } });
      await store.putObservations(Array.from({ length: 8 }, (_, i) => contractObservation(`obs_${i}`, "conn_0", T0 + i)));

      expect((await store.listConnections()).map((c) => c.connectionId)).toEqual(Array.from({ length: 7 }, (_, i) => `conn_${i}`));
      expect((await store.listGoals()).map((g) => g.id)).toEqual(["g0", "g1", "g2", "g3", "g4"]);
      const ids: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await store.listObservations({ ...(after !== undefined ? { after } : {}) });
        ids.push(...page.items.map((o) => o.id));
        after = page.next;
        if (after === undefined) break;
      }
      expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `obs_${i}`));
      expect((await store.exportAll()).connections).toHaveLength(7);

      // Small listings stay a single request once the count says they are complete.
      requests = 0;
      await store.putBudget({ limit: { minor: 1, currency: "INR" }, period: "weekly" });
      requests = 0;
      expect(await store.listBudgets()).toHaveLength(1);
      expect(requests).toBe(1);
    });

    it("does not mistake another device's concurrent writes for a lower row cap", async () => {
      // The page size may only shrink on proof from one snapshot. A row another
      // device inserts between a short page and its look-ahead probe, or rows it
      // deletes between two offset pages, prove nothing about the server's cap;
      // learning from them would page in tiny steps for the store's whole life.
      const userId = await db.createUser();
      const otherDevice = createSupabaseStore({ client: clientFor(userId), userId, clock: fixedClock(T0) });
      let race: (() => Promise<void>) | undefined;
      const requests: string[] = [];
      const racing: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const isRead = (init?.method ?? "GET") === "GET";
        if (isRead && race && url.search.includes("offset=") === false && url.searchParams.get("select") === "id") {
          const run = race;
          race = undefined;
          await run(); // lands between the page and its probe
        }
        if (isRead && race && url.searchParams.get("offset") === "3") {
          const run = race;
          race = undefined;
          await run(); // lands between two offset pages
        }
        if (isRead) requests.push(url.pathname);
        return fetch(input, init);
      };
      const client = createClient<Database>(server.supabaseUrl, server.anonKey, {
        global: { headers: { Authorization: `Bearer ${server.userToken(userId)}` }, fetch: racing },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      // 1. Look-ahead probe vs a concurrent insert (default row cap: 1000).
      const store = createSupabaseStore({ client, userId, clock: fixedClock(T0) });
      await store.upsertConnection(contractConnection("conn_a"));
      await store.putObservations(Array.from({ length: 3 }, (_, i) => contractObservation(`obs_${i}`, "conn_a", T0 + i)));
      race = () => otherDevice.putObservations([contractObservation("obs_new", "conn_a", T0 + DAY)]).then(() => undefined);
      const first = await store.listObservations();
      expect(first.items.map((o) => o.id)).toEqual(["obs_0", "obs_1", "obs_2"]);
      expect(race).toBeUndefined();
      await store.putObservations(Array.from({ length: 20 }, (_, i) => contractObservation(`obs_more_${i}`, "conn_a", T0 + 10 + i)));
      expect((await store.listObservations()).items).toHaveLength(24);

      // 2. Offset pages vs a concurrent delete (a configured cap of 3).
      const capped = createSupabaseStore({ client, userId, clock: fixedClock(T0), maxRows: 3 });
      const goal = (id: string) => ({ id, name: "n", target: { minor: 1, currency: "INR" }, saved: { minor: 0, currency: "INR" } });
      for (const id of ["g0", "g1", "g2", "g3", "g4"]) await capped.putGoal(goal(id));
      race = () => otherDevice.deleteGoal("g4");
      expect((await capped.listGoals()).map((g) => g.id)).toEqual(["g0", "g1", "g2", "g3"]);
      expect(race).toBeUndefined();
      requests.length = 0;
      expect(await capped.listGoals()).toHaveLength(4);
      expect(requests).toHaveLength(2); // pages of 3 and 1, not of 1 row each
    });

    it("never asks for more rows than the server's cap, and still lists everything", async () => {
      const userId = await db.createUser();
      const store = createSupabaseStore({ client: clientFor(userId), userId, clock: fixedClock(T0), maxRows: 3 });
      for (let i = 0; i < 7; i++) await store.upsertConnection(contractConnection(`conn_${i}`));
      expect((await store.listConnections()).map((c) => c.connectionId)).toEqual(Array.from({ length: 7 }, (_, i) => `conn_${i}`));

      await store.putObservations(Array.from({ length: 7 }, (_, i) => contractObservation(`obs_${i}`, "conn_0", T0 + i * HOUR)));
      const ids: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await store.listObservations({ limit: 5, ...(after !== undefined ? { after } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(3);
        ids.push(...page.items.map((o) => o.id));
        after = page.next;
        pages += 1;
      } while (after !== undefined && pages < 10);
      expect(ids).toEqual(Array.from({ length: 7 }, (_, i) => `obs_${i}`));
    });
  });
});

describe("Supabase store error mapping (canned responses, no database)", () => {
  /** A client whose every request gets the given response, as PostgREST would send it. */
  function cannedClient(status: number, body: unknown) {
    const fetchStub: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return createClient<Database>("http://127.0.0.1:1", "anon-key", {
      global: { fetch: fetchStub },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  const USER = "6f1c2c1e-6f3b-4c4e-9d8e-2a6b7c8d9e0f";

  it("keeps the code, drops details and hint, and strips quoted values from data exceptions", async () => {
    const store = createSupabaseStore({
      client: cannedClient(400, {
        code: "22P02",
        message: 'invalid input syntax for type bigint: "SECRET-124900"',
        details: "Failing row contains (SECRET-ROW).",
        hint: "SECRET-HINT",
      }),
      userId: USER,
      clock: fixedClock(T0),
    });
    const error = (await store.listConnections().catch((e: unknown) => e)) as SupabaseStoreError;
    expect(error).toBeInstanceOf(SupabaseStoreError);
    expect(error.code).toBe("22P02");
    expect(error.status).toBe(400);
    expect(error.message).toContain("invalid input syntax for type bigint");
    expect(error.message).not.toContain("SECRET");
  });

  it("keeps names in other messages and reports HTTP status when PostgREST gives no code", async () => {
    const check = createSupabaseStore({
      client: cannedClient(400, { code: "23514", message: 'new row for relation "goals" violates check constraint "goals_name_check"' }),
      userId: USER,
    });
    await expect(check.listGoals()).rejects.toMatchObject({ code: "23514", message: expect.stringContaining('"goals_name_check"') });
    const gateway = createSupabaseStore({ client: cannedClient(431, { message: "" }), userId: USER });
    await expect(gateway.deleteObservations(["x"])).rejects.toMatchObject({ code: "HTTP431" });
  });

  it("refuses values before sending anything, with the memory store's codes", async () => {
    let sent = 0;
    const client = createClient<Database>("http://127.0.0.1:1", "anon-key", {
      global: {
        fetch: async () => {
          sent += 1;
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const store = createSupabaseStore({ client, userId: USER, clock: fixedClock(T0) });
    const many = Array.from({ length: 1_200 }, (_, i) => contractObservation(`obs_${i}`, "conn_a", T0 + i));
    // One bad row late in the input fails the whole call before the first batch is sent.
    many[1_100] = contractObservation("obs_bad", "conn_a", T0 + 0.5);
    await expect(store.putObservations(many)).rejects.toMatchObject({ code: "23514" });
    many[1_100] = contractObservation("obs_bad", "conn_a", T0, { merchant: { raw: "🙂".slice(0, 1), confidence: 1 } });
    await expect(store.putObservations(many)).rejects.toMatchObject({ code: "22P05" });
    await expect(store.putGoal({ id: "g", name: "n", target: { minor: 1, currency: "INR" }, saved: { minor: 0, currency: "USD" } })).rejects.toMatchObject({
      code: "23514",
    });
    expect(sent).toBe(0);
  });
});
