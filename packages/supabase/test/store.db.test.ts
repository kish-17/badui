import { DAY, HOUR, fixedClock } from "@brake/core";
import type { BrakeStore, Observation } from "@brake/core";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, isDatabaseAvailable, startPostgrest } from "../../../supabase/tests/harness";
import type { PostgrestServer, TestDatabase } from "../../../supabase/tests/harness";
import { containsCardNumber, jsonContainsCardNumber } from "../../core/src/store-memory";
import { CONTRACT_T0, contractConnection, contractObservation, describeStoreContract } from "../../core/test/store-contract";
import { createSupabaseStore, SupabaseStoreError } from "../src/index";
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
  readonly rows: number;
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
        requests.push({ method: init?.method ?? "GET", path: url.pathname, rows: Array.isArray(body) ? body.length : body ? 1 : 0 });
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
