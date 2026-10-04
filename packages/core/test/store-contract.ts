import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE, fixedClock, money } from "../src/index";
import type {
  BrakeStore,
  Budget,
  ConsentEvent,
  Goal,
  Observation,
  PromptLogEntry,
  SourceConnection,
  StoredInstrument,
  UserAssertion,
  UserRule,
  UserSettings,
} from "../src/index";
import { makeObservation, makeSource } from "../src/testing";

/**
 * The behavioural contract of `BrakeStore`, as a reusable vitest suite.
 *
 * Every implementation (the in-memory reference store, the Supabase store
 * through a real PostgREST + Postgres) runs this same suite, so "works on the
 * device" and "works against the backend" cannot drift apart.
 *
 * The factory is called once per test and must return an empty store for a
 * fresh user. It receives a controllable clock that the store must use for
 * everything time-dependent (excerpt visibility, export timestamps), so the
 * suite can exercise expiry deterministically.
 */
export interface StoreContractContext {
  readonly clock: ReturnType<typeof fixedClock>;
}

export interface StoreUnderTest {
  readonly store: BrakeStore;
  readonly cleanup?: () => Promise<void>;
}

/** 2026-10-04 05:11:00 UTC — every fixture is relative to this. */
export const CONTRACT_T0 = Date.UTC(2026, 9, 4, 5, 11, 0);
const T0 = CONTRACT_T0;

/** Luhn-valid test card number (must never be stored) and a Luhn-invalid 16-digit reference (fine). */
const CARD_NUMBER = "4111111111111111";
const NOT_A_CARD = "4111111111111112";

/** The storable instant range (year 1 to JavaScript's last date, +275760-09-13). */
const MIN_INSTANT = -62_135_596_800_000;
const MAX_INSTANT = 8_640_000_000_000_000;

/** Half of "🙂": what a careless `.slice()` leaves behind. Postgres cannot store it. */
const LONE_SURROGATE = "🙂".slice(0, 1);

/**
 * Text order of ids in listings: Unicode code point (= UTF-8 byte) order, i.e.
 * Postgres's "C" / "C.UTF-8" collation. A database under a linguistic
 * collation (en_US) would order ids differently from the memory store.
 */
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function contractConnection(connectionId: string, p: Partial<SourceConnection> = {}): SourceConnection {
  return {
    connectionId,
    adapterId: "sms",
    kind: "sms",
    label: "Test Bank SMS alerts",
    provider: "Test Bank",
    status: "active",
    scopes: ["sms:read_transactional"],
    purposes: ["detect purchases", "find subscriptions"],
    retention: { excerptTtlMs: 7 * DAY, observationTtlMs: null },
    grantedAt: T0 - 10 * DAY,
    updatedAt: T0 - 10 * DAY,
    ...p,
  };
}

export function contractObservation(
  id: string,
  connectionId: string,
  receivedAt: number,
  p: Partial<Observation> & { minor?: number } = {},
): Observation {
  return makeObservation({
    id,
    receivedAt,
    occurredAt: { value: receivedAt - MINUTE, confidence: 0.9 },
    source: makeSource({ adapterId: "sms", kind: "sms", connectionId, label: "Test Bank SMS alert", provider: "Test Bank" }),
    merchant: { raw: "AMAZON PAY", key: "amazon", confidence: 0.9 },
    references: [{ type: "rail_reference", value: "627712345678", namespace: "upi" }],
    evidence: { summary: "Test Bank SMS: ₹1,249.00 debited to AMAZON (UPI)" },
    ...p,
  });
}

export function describeStoreContract(
  name: string,
  factory: (ctx: StoreContractContext) => Promise<StoreUnderTest>,
): void {
  describe(`BrakeStore contract: ${name}`, () => {
    let store: BrakeStore;
    let clock: ReturnType<typeof fixedClock>;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      clock = fixedClock(T0);
      const made = await factory({ clock });
      store = made.store;
      cleanup = made.cleanup;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    async function allObservations(query: Parameters<BrakeStore["listObservations"]>[0] = {}): Promise<Observation[]> {
      const out: Observation[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 100; guard++) {
        const page = await store.listObservations({ ...query, ...(after !== undefined ? { after } : {}) });
        out.push(...page.items);
        if (page.next === undefined) return out;
        after = page.next;
      }
      throw new Error("pagination did not terminate");
    }

    const ids = (items: readonly { readonly id: string }[]) => items.map((i) => i.id);

    describe("connections and consent", () => {
      it("upserts and lists connections, replacing by connectionId", async () => {
        const sms = contractConnection("conn_sms");
        const { provider: _provider, ...mail } = contractConnection("conn_mail", {
          adapterId: "gmail",
          kind: "email",
          label: "Gmail — receipts only",
          retention: { excerptTtlMs: 0, observationTtlMs: 400 * DAY },
        });
        await store.upsertConnection(sms);
        await store.upsertConnection(mail);
        expect(await store.listConnections()).toEqual([mail, sms]);

        const paused: SourceConnection = { ...sms, status: "paused", updatedAt: T0 };
        await store.upsertConnection(paused);
        const listed = await store.listConnections();
        expect(listed).toHaveLength(2);
        expect(listed.find((c) => c.connectionId === "conn_sms")).toEqual(paused);
        expect(listed.find((c) => c.connectionId === "conn_mail")).not.toHaveProperty("provider");
      });

      it("rejects connections that break schema rules", async () => {
        await expect(store.upsertConnection(contractConnection("c1", { label: "x".repeat(121) }))).rejects.toThrow();
        await expect(store.upsertConnection(contractConnection("c1", { label: "" }))).rejects.toThrow();
        await expect(store.upsertConnection(contractConnection("c5", { status: "revoked" }))).rejects.toThrow();
        await expect(
          store.upsertConnection(contractConnection("c2", { retention: { excerptTtlMs: -1, observationTtlMs: null } })),
        ).rejects.toThrow();
        await expect(
          store.upsertConnection(contractConnection("c3", { retention: { excerptTtlMs: 0, observationTtlMs: 0 } })),
        ).rejects.toThrow();
        await expect(
          store.upsertConnection(contractConnection("c4", { kind: "carrier_pigeon" as SourceConnection["kind"] })),
        ).rejects.toThrow();
        expect(await store.listConnections()).toEqual([]);
      });

      it("appends consent events and lists them oldest first, optionally per connection", async () => {
        const e1: ConsentEvent = { connectionId: "conn_a", action: "granted", at: T0 - 2 * DAY, scopes: ["s1"], purposes: ["p1"] };
        const e2: ConsentEvent = { connectionId: "conn_b", action: "granted", at: T0 - DAY, scopes: [], purposes: ["p2"] };
        const e3: ConsentEvent = { connectionId: "conn_a", action: "paused", at: T0, scopes: ["s1"], purposes: ["p1"] };
        // Out of order on purpose; an identical receipt is still a separate receipt (append-only).
        await store.appendConsentEvent(e3);
        await store.appendConsentEvent(e1);
        await store.appendConsentEvent(e2);
        await store.appendConsentEvent(e3);
        expect(await store.listConsentEvents()).toEqual([e1, e2, e3, e3]);
        expect(await store.listConsentEvents("conn_a")).toEqual([e1, e3, e3]);
        expect(await store.listConsentEvents("conn_unknown")).toEqual([]);
      });
    });

    describe("observations", () => {
      beforeEach(async () => {
        await store.upsertConnection(contractConnection("conn_a"));
        await store.upsertConnection(contractConnection("conn_b", { adapterId: "android-notification", kind: "notification" }));
      });

      it("puts idempotently: an existing id is never overwritten and is not counted", async () => {
        const o1 = contractObservation("obs_1", "conn_a", T0, { minor: 124_900 });
        const o2 = contractObservation("obs_2", "conn_a", T0 + MINUTE);
        expect(await store.putObservations([o1, o2])).toEqual({ inserted: 2 });
        expect(await store.putObservations([o1, o2])).toEqual({ inserted: 0 });

        const changed = contractObservation("obs_1", "conn_a", T0, { minor: 999 });
        const o3 = contractObservation("obs_3", "conn_a", T0 + 2 * MINUTE);
        // Duplicates inside one batch count once.
        expect(await store.putObservations([changed, o3, o3])).toEqual({ inserted: 1 });
        expect(await store.putObservations([])).toEqual({ inserted: 0 });

        const all = await allObservations();
        expect(all).toEqual([o1, o2, o3]);
        expect(all[0]?.amount?.value.minor).toBe(124_900);
      });

      it("round-trips every observation field it stores", async () => {
        const rich: Observation = {
          id: "obs_rich",
          source: { adapterId: "sms", kind: "sms", connectionId: "conn_a", provider: "Test Bank", label: "Test Bank SMS alert" },
          kind: "money_movement",
          window: "post_spend",
          stage: "confirmed",
          receivedAt: T0,
          occurredAt: { value: T0 - 5 * MINUTE, confidence: 0.8, approximate: true },
          direction: "debit",
          amount: { value: money(124_950, "INR"), confidence: 0.99 },
          amountBreakdown: [{ kind: "tax", amount: money(19_060, "INR") }],
          merchant: { raw: "AMZN Mktp IN*2K4L", name: "Amazon", key: "amazon", mcc: "5942", channel: "online", confidence: 0.9 },
          counterparty: { name: "Amazon Pay", handle: "amazon@apl", isSelf: 0.01, isMerchant: 0.99 },
          instrument: { type: "card", issuer: "Test Bank", network: "visa", last4: "1234", cardKind: "credit" },
          rail: { family: "card", scheme: "visa" },
          country: "IN",
          references: [
            { type: "rail_reference", value: "627712345678", namespace: "upi" },
            { type: "order_id", value: `408-${NOT_A_CARD}`, namespace: "amazon" },
          ],
          lineItems: [{ description: "Electric toothbrush", quantity: 1, total: money(124_950, "INR"), categoryHints: [{ scheme: "keyword", value: "personal care", confidence: 0.6 }] }],
          categoryHints: [{ scheme: "mcc", value: "5942", confidence: 0.7 }],
          typeHints: [{ type: "purchase", confidence: 0.8, reason: "sms:debit-keyword" }],
          subscription: { event: "charged", serviceName: "Prime", period: "P1Y", nextChargeAt: T0 + 365 * DAY, price: money(149_900, "INR") },
          balance: { available: money(5_000_000, "INR") },
          intent: { via: "should_i_buy", title: "Toothbrush", url: "https://example.com/p/1" },
          confidence: 0.97,
          evidence: { summary: "Test Bank SMS: ₹1,249.50 debited (card ••1234)", excerpt: "Rs 1249.50 spent on card XX1234 at AMZN", excerptExpiresAt: T0 + DAY },
        };
        await store.putObservations([rich]);
        expect((await store.listObservations()).items).toEqual([rich]);
      });

      it("rejects observations whose connection does not exist", async () => {
        await expect(store.putObservations([contractObservation("obs_x", "conn_missing", T0)])).rejects.toMatchObject({ code: "23503" });
        expect(await allObservations()).toEqual([]);
      });

      it("orders by (receivedAt, id) regardless of insertion order", async () => {
        const b = contractObservation("obs_b", "conn_a", T0);
        const a = contractObservation("obs_a", "conn_b", T0);
        const c = contractObservation("obs_c", "conn_a", T0 - MINUTE);
        const d = contractObservation("obs_0", "conn_a", T0 + HOUR);
        await store.putObservations([b, d]);
        await store.putObservations([a, c]);
        expect(ids((await store.listObservations()).items)).toEqual(["obs_c", "obs_a", "obs_b", "obs_0"]);
      });

      it("paginates with an opaque keyset cursor", async () => {
        const obs = Array.from({ length: 7 }, (_, i) =>
          // Pairs share a receivedAt so ties are broken by id across page boundaries.
          contractObservation(`obs_${String(i).padStart(2, "0")}`, "conn_a", T0 + Math.floor(i / 2) * MINUTE),
        );
        await store.putObservations([...obs].reverse());

        const p1 = await store.listObservations({ limit: 3 });
        expect(ids(p1.items)).toEqual(["obs_00", "obs_01", "obs_02"]);
        expect(typeof p1.next).toBe("string");
        const p2 = await store.listObservations({ limit: 3, after: p1.next! });
        expect(ids(p2.items)).toEqual(["obs_03", "obs_04", "obs_05"]);
        const p3 = await store.listObservations({ limit: 3, after: p2.next! });
        expect(ids(p3.items)).toEqual(["obs_06"]);
        expect(p3.next).toBeUndefined();

        // An exact fit leaves no dangling cursor.
        const exact = await store.listObservations({ limit: 7 });
        expect(exact.items).toHaveLength(7);
        expect(exact.next).toBeUndefined();
        expect(await allObservations({ limit: 2 })).toEqual(obs);

        // Keyset semantics: rows inserted before the cursor are not replayed; rows after it appear.
        await store.putObservations([
          contractObservation("obs_early", "conn_a", T0 - DAY),
          contractObservation("obs_late", "conn_a", T0 + DAY),
        ]);
        const rest = await store.listObservations({ limit: 10, after: p2.next! });
        expect(ids(rest.items)).toEqual(["obs_06", "obs_late"]);
      });

      it("uses a default page of 500, clamps oversized pages and rejects bad page arguments", async () => {
        const many = Array.from({ length: 501 }, (_, i) => contractObservation(`obs_${String(i).padStart(3, "0")}`, "conn_a", T0 + i));
        expect(await store.putObservations(many)).toEqual({ inserted: 501 });
        const first = await store.listObservations();
        expect(first.items).toHaveLength(500);
        const second = await store.listObservations({ after: first.next! });
        expect(ids(second.items)).toEqual(["obs_500"]);
        expect(second.next).toBeUndefined();
        expect((await store.listObservations({ limit: 5_000 })).items).toHaveLength(501);
        await expect(store.listObservations({ limit: 0 })).rejects.toThrow();
        await expect(store.listObservations({ limit: 1.5 })).rejects.toThrow();
        await expect(store.listObservations({ after: "not a cursor" })).rejects.toThrow();
      });

      it("filters by since (inclusive), until (exclusive) and connection, across pages", async () => {
        const obs = [
          contractObservation("obs_1", "conn_a", T0 - 2 * HOUR),
          contractObservation("obs_2", "conn_b", T0 - HOUR),
          contractObservation("obs_3", "conn_a", T0),
          contractObservation("obs_4", "conn_b", T0),
          contractObservation("obs_5", "conn_a", T0 + HOUR),
        ];
        await store.putObservations(obs);
        expect(ids(await allObservations({ since: T0 - HOUR }))).toEqual(["obs_2", "obs_3", "obs_4", "obs_5"]);
        expect(ids(await allObservations({ until: T0 }))).toEqual(["obs_1", "obs_2"]);
        expect(ids(await allObservations({ since: T0 - HOUR, until: T0 + HOUR }))).toEqual(["obs_2", "obs_3", "obs_4"]);
        expect(ids(await allObservations({ connectionId: "conn_a", limit: 1 }))).toEqual(["obs_1", "obs_3", "obs_5"]);
        expect(ids(await allObservations({ connectionId: "conn_b", since: T0, limit: 1 }))).toEqual(["obs_4"]);
        expect(await allObservations({ connectionId: "conn_missing" })).toEqual([]);
      });

      it("deletes observations by id and reports how many existed", async () => {
        await store.putObservations([
          contractObservation("obs_1", "conn_a", T0),
          contractObservation("obs_2", "conn_a", T0 + 1),
          contractObservation("obs_3", "conn_b", T0 + 2),
        ]);
        expect(await store.deleteObservations(["obs_1", "obs_3", "obs_missing", "obs_1"])).toBe(2);
        expect(await store.deleteObservations([])).toBe(0);
        expect(ids(await allObservations())).toEqual(["obs_2"]);
      });

      it("handles ids with characters that are special in query strings", async () => {
        const odd = ['obs "quoted"', "obs,comma", "obs(paren)", "obs\\slash", "obs.dot:colon", "obs ü 🙂"];
        await store.putObservations(odd.map((id, i) => contractObservation(id, "conn_a", T0 + i)));
        expect(ids(await allObservations({ limit: 1 }))).toEqual(odd);
        expect(await store.deleteObservations(odd.slice(0, 4))).toBe(4);
        expect(ids(await allObservations())).toEqual(odd.slice(4));
      });

      it("leaves no dangling cursor on an exact last page of the maximum size", async () => {
        // 1000 is both the largest page and Supabase's default row cap, so the
        // store cannot look one row ahead within a single request.
        const obs = Array.from({ length: 1000 }, (_, i) => contractObservation(`obs_${String(i).padStart(4, "0")}`, "conn_a", T0 + i));
        expect(await store.putObservations(obs)).toEqual({ inserted: 1000 });
        for (const limit of [1000, 5000]) {
          const page = await store.listObservations({ limit });
          expect(page.items).toHaveLength(1000);
          expect(page.next).toBeUndefined();
        }
        await store.putObservations([contractObservation("obs_last", "conn_a", T0 + DAY)]);
        const first = await store.listObservations({ limit: 1000 });
        expect(first.items).toHaveLength(1000);
        const second = await store.listObservations({ limit: 1000, after: first.next! });
        expect(ids(second.items)).toEqual(["obs_last"]);
        expect(second.next).toBeUndefined();
      });

      it("pages through ties on receivedAt in code-point order, whatever the ids contain (even empty)", async () => {
        const odd = ["obs", 'obs "quoted"', "obs ü 🙂", "obs(paren)", "obs,comma", "obs.dot:colon", "obs\\slash", "obs_", "", "obsｚ", "obs🙂"];
        await store.putObservations([...odd].reverse().map((id) => contractObservation(id, "conn_a", T0)));
        const expected = [...odd].sort(byCodePoint);
        expect(ids((await store.listObservations()).items)).toEqual(expected);
        expect(ids(await allObservations({ limit: 1 }))).toEqual(expected);
        expect(ids(await allObservations({ limit: 2 }))).toEqual(expected);
      });

      it("keeps amounts exact up to Number.MAX_SAFE_INTEGER and refuses what JavaScript cannot read back", async () => {
        const big = contractObservation("obs_big", "conn_a", T0, {
          minor: Number.MAX_SAFE_INTEGER,
          amountBreakdown: [{ kind: "tax", amount: money(Number.MAX_SAFE_INTEGER - 1, "INR") }],
        });
        expect(await store.putObservations([big])).toEqual({ inserted: 1 });
        expect((await store.listObservations()).items).toEqual([big]);
        const unsafe = contractObservation("obs_unsafe", "conn_a", T0, { minor: 2 ** 53 });
        const fractional = contractObservation("obs_frac", "conn_a", T0, { amount: { value: { minor: 1.5, currency: "INR" }, confidence: 1 } });
        for (const o of [unsafe, fractional]) await expect(store.putObservations([o])).rejects.toMatchObject({ code: "23514" });
        expect(ids(await allObservations())).toEqual(["obs_big"]);
      });

      it("refuses instants that are not whole milliseconds within the storable range", async () => {
        const bad = [
          contractObservation("obs_frac", "conn_a", T0 + 0.5),
          contractObservation("obs_occ", "conn_a", T0, { occurredAt: { value: T0 - 0.25, confidence: 1 } }),
          contractObservation("obs_late", "conn_a", MAX_INSTANT + 1, { occurredAt: { value: T0, confidence: 1 } }),
          contractObservation("obs_early", "conn_a", MIN_INSTANT - 1, { occurredAt: { value: T0, confidence: 1 } }),
        ];
        for (const o of bad) await expect(store.putObservations([o])).rejects.toMatchObject({ code: "23514" });
        expect(await allObservations()).toEqual([]);
        await expect(store.revokeConnection("conn_a", T0 + 0.5)).rejects.toMatchObject({ code: "23514" });
      });

      it("round-trips instants across the whole storable range", async () => {
        const instants = [
          MIN_INSTANT,
          Date.parse("0050-06-15T12:00:00.000Z"),
          Date.parse("1969-12-31T23:59:59.999Z"),
          0,
          T0,
          Date.parse("9999-12-31T23:59:59.999Z"),
          Date.parse("+010000-01-01T00:00:00.000Z"),
          MAX_INSTANT,
        ];
        const obs = instants.map((t, i) => contractObservation(`obs_${i}`, "conn_a", t, { occurredAt: { value: t, confidence: 1 } }));
        expect(await store.putObservations([...obs].reverse())).toEqual({ inserted: instants.length });
        expect(await allObservations({ limit: 3 })).toEqual(obs);
        expect(ids(await allObservations({ since: 0, until: MAX_INSTANT }))).toEqual(["obs_3", "obs_4", "obs_5", "obs_6"]);
      });

      it("refuses text Postgres cannot store: NUL and lone UTF-16 surrogates", async () => {
        const bad = [
          contractObservation("obs_1", "conn_a", T0, { merchant: { raw: `AMAZON ${LONE_SURROGATE}`, confidence: 0.5 } }),
          contractObservation("obs_2", "conn_a", T0, { evidence: { summary: "debited\u0000" } }),
          contractObservation("obs_3", "conn_a", T0, { evidence: { summary: "s", excerpt: `x${"🙂".slice(1)}`, excerptExpiresAt: T0 + DAY } }),
        ];
        for (const o of bad) await expect(store.putObservations([o])).rejects.toMatchObject({ code: "22P05" });
        expect(await allObservations()).toEqual([]);
        // A whole emoji is fine, and an unstorable excerpt that is dropped anyway (expired) is no error.
        const fine = contractObservation("obs_4", "conn_a", T0, {
          merchant: { raw: "CAFÉ 🙂", confidence: 0.5 },
          evidence: { summary: "s", excerpt: `gone ${LONE_SURROGATE}`, excerptExpiresAt: T0 - 1 },
        });
        expect(await store.putObservations([fine])).toEqual({ inserted: 1 });
        expect((await store.listObservations()).items[0]?.evidence).toEqual({ summary: "s" });
      });

      it("measures facts as Postgres stores them (jsonb), not as JSON text", async () => {
        const items = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `Item ${i}`, quantity: 1, total: money(12_345, "INR") }));
        // A 300-line receipt is ~28 KB of JSON text but ~38 KB of jsonb (numbers are aligned numerics).
        const long = contractObservation("obs_300", "conn_a", T0, { lineItems: items(300) });
        await expect(store.putObservations([long])).rejects.toMatchObject({ code: "23514" });
        expect(await store.putObservations([contractObservation("obs_200", "conn_a", T0, { lineItems: items(200) })])).toEqual({ inserted: 1 });
        // The other way round: escaped text is ~32 KB of JSON but ~16 KB of jsonb.
        const escaped = contractObservation("obs_nl", "conn_a", T0 + 1, { lineItems: [{ description: "\n".repeat(16_000) }] });
        expect(await store.putObservations([escaped])).toEqual({ inserted: 1 });
      });

      it("keeps any confidence within [0, 1] exactly and refuses one outside it", async () => {
        const tiny = contractObservation("obs_tiny", "conn_a", T0, { confidence: 1e-50 });
        const precise = contractObservation("obs_precise", "conn_a", T0 + 1, { confidence: 0.1 + 0.2 });
        expect(await store.putObservations([tiny, precise])).toEqual({ inserted: 2 });
        expect((await store.listObservations()).items).toEqual([tiny, precise]);
        for (const confidence of [1 + 1e-9, -1e-9]) {
          await expect(store.putObservations([contractObservation("obs_bad", "conn_a", T0, { confidence })])).rejects.toMatchObject({ code: "23514" });
        }
      });

      it("treats infinite and fractional bounds numerically and refuses NaN", async () => {
        await store.putObservations([
          contractObservation("obs_1", "conn_a", T0 - HOUR),
          contractObservation("obs_2", "conn_a", T0),
          contractObservation("obs_3", "conn_a", T0 + HOUR),
        ]);
        const all = ["obs_1", "obs_2", "obs_3"];
        expect(ids(await allObservations({ since: Number.NEGATIVE_INFINITY }))).toEqual(all);
        expect(ids(await allObservations({ until: Number.POSITIVE_INFINITY }))).toEqual(all);
        expect(ids(await allObservations({ since: -1e300, until: 1e300 }))).toEqual(all);
        expect(await allObservations({ since: Number.POSITIVE_INFINITY })).toEqual([]);
        expect(await allObservations({ until: Number.NEGATIVE_INFINITY })).toEqual([]);
        expect(ids(await allObservations({ since: T0 - 0.5 }))).toEqual(["obs_2", "obs_3"]);
        expect(ids(await allObservations({ until: T0 + 0.5 }))).toEqual(["obs_1", "obs_2"]);
        expect(ids(await allObservations({ until: T0 - 0.5 }))).toEqual(["obs_1"]);
        await expect(store.listObservations({ since: Number.NaN })).rejects.toThrow();
        await expect(store.listObservations({ until: Number.NaN })).rejects.toThrow();
      });

      it("matches connection ids exactly in filters, receipts and revocation", async () => {
        const odd = 'conn "q",(x)\\ ü*';
        await store.upsertConnection(contractConnection(odd));
        await store.upsertConnection(contractConnection("conn"));
        await store.putObservations([
          contractObservation("obs_odd", odd, T0),
          contractObservation("obs_plain", "conn", T0 + 1),
          contractObservation("obs_a", "conn_a", T0 + 2),
        ]);
        expect(ids(await allObservations({ connectionId: odd }))).toEqual(["obs_odd"]);
        await store.appendConsentEvent({ connectionId: odd, action: "granted", at: T0 - DAY, scopes: ["s"], purposes: ["p"] });
        expect(await store.listConsentEvents(odd)).toHaveLength(1);
        expect(await store.revokeConnection(odd, T0 + HOUR)).toEqual({ deletedObservations: 1 });
        expect((await store.listConsentEvents(odd)).map((e) => e.action)).toEqual(["granted", "revoked"]);
        expect(ids(await allObservations())).toEqual(["obs_plain", "obs_a"]);
      });

      it("does not let callers mutate stored state through inputs or outputs", async () => {
        const o = contractObservation("obs_1", "conn_a", T0);
        const original = JSON.parse(JSON.stringify(o)) as Observation;
        await store.putObservations([o]);
        (o as { confidence: number }).confidence = 0.1;
        const [read] = (await store.listObservations()).items;
        (read!.evidence as { summary: string }).summary = "tampered";
        expect((await store.listObservations()).items).toEqual([original]);
      });
    });

    describe("evidence excerpts", () => {
      const excerpt = "Rs 1249.00 debited from A/c XX1234 to VPA amazon@apl";

      beforeEach(async () => {
        await store.upsertConnection(contractConnection("conn_week", { retention: { excerptTtlMs: 7 * DAY, observationTtlMs: null } }));
        await store.upsertConnection(contractConnection("conn_day", { retention: { excerptTtlMs: DAY, observationTtlMs: null } }));
        await store.upsertConnection(contractConnection("conn_none", { retention: { excerptTtlMs: 0, observationTtlMs: null } }));
      });

      const evidence = (expiresAt?: number) => ({
        summary: "Test Bank SMS: ₹1,249.00 debited to AMAZON (UPI)",
        excerpt,
        ...(expiresAt !== undefined ? { excerptExpiresAt: expiresAt } : {}),
      });

      it("returns an unexpired excerpt with its expiry", async () => {
        const o = contractObservation("obs_1", "conn_week", T0, { evidence: evidence(T0 + 2 * DAY) });
        await store.putObservations([o]);
        expect((await store.listObservations()).items).toEqual([o]);
      });

      it("withholds an excerpt once it has expired, keeping the summary", async () => {
        await store.putObservations([contractObservation("obs_1", "conn_week", T0, { evidence: evidence(T0 + 2 * DAY) })]);
        clock.advance(2 * DAY);
        const [o] = (await store.listObservations()).items;
        expect(o?.evidence).toEqual({ summary: "Test Bank SMS: ₹1,249.00 debited to AMAZON (UPI)" });
        expect((await store.exportAll()).observations[0]?.evidence).not.toHaveProperty("excerpt");
      });

      it("caps an excerpt's life at the connection's excerpt TTL", async () => {
        await store.putObservations([
          contractObservation("obs_own", "conn_week", T0, { evidence: evidence(undefined) }),
          contractObservation("obs_capped", "conn_day", T0, { evidence: evidence(T0 + 5 * DAY) }),
          contractObservation("obs_none", "conn_none", T0 + 1, { evidence: evidence(T0 + 5 * DAY) }),
        ]);
        const byId = new Map((await store.listObservations()).items.map((o) => [o.id, o.evidence]));
        expect(byId.get("obs_own")).toEqual(evidence(T0 + 7 * DAY));
        expect(byId.get("obs_capped")).toEqual(evidence(T0 + DAY));
        expect(byId.get("obs_none")).toEqual({ summary: "Test Bank SMS: ₹1,249.00 debited to AMAZON (UPI)" });
      });

      it("caps an excerpt kept 'as long as possible' at the last storable instant, to the millisecond", async () => {
        await store.upsertConnection(contractConnection("conn_max", { retention: { excerptTtlMs: Number.MAX_SAFE_INTEGER, observationTtlMs: null } }));
        await store.putObservations([
          contractObservation("obs_1", "conn_max", T0, { evidence: evidence(undefined) }),
          contractObservation("obs_2", "conn_max", T0 + 1, { evidence: evidence(T0 + DAY + 0.7) }),
        ]);
        const byId = new Map((await store.listObservations()).items.map((o) => [o.id, o.evidence.excerptExpiresAt]));
        expect(byId.get("obs_1")).toBe(MAX_INSTANT);
        expect(byId.get("obs_2")).toBe(T0 + DAY);
      });

      it("never stores an excerpt that is already expired when written", async () => {
        await store.putObservations([contractObservation("obs_1", "conn_week", T0, { evidence: evidence(T0 - 1) })]);
        // Even a reader whose clock is behind cannot see it: it was not kept at all.
        clock.set(T0 - DAY);
        const [o] = (await store.listObservations()).items;
        expect(o?.evidence).not.toHaveProperty("excerpt");
        expect(o?.evidence).not.toHaveProperty("excerptExpiresAt");
      });
    });

    describe("privacy guards", () => {
      beforeEach(async () => {
        await store.upsertConnection(contractConnection("conn_a"));
      });

      it("refuses full card numbers in facts or excerpts, contiguous or printed in groups", async () => {
        const inMerchant = contractObservation("obs_1", "conn_a", T0, { merchant: { raw: `PAYMENT ${CARD_NUMBER}`, confidence: 0.5 } });
        const grouped = contractObservation("obs_2", "conn_a", T0, { evidence: { summary: "Card 4111 1111 1111 1111 charged ₹499" } });
        const amex = contractObservation("obs_3", "conn_a", T0, { lineItems: [{ description: "card 3782-822463-10005" }] });
        const inExcerpt = contractObservation("obs_4", "conn_a", T0, {
          evidence: { summary: "card payment", excerpt: `card ${CARD_NUMBER} charged`, excerptExpiresAt: T0 + DAY },
        });
        for (const o of [inMerchant, grouped, amex, inExcerpt]) {
          await expect(store.putObservations([o])).rejects.toMatchObject({ code: "23514" });
        }
        expect(await allObservations()).toEqual([]);
      });

      it("does not mistake masked numbers, other digit runs or machine identifiers for cards", async () => {
        const fine = contractObservation("obs_1", "conn_a", T0, {
          merchant: { raw: `REF ${NOT_A_CARD} card ••••1111 XX1111`, confidence: 0.5 },
          // Identifiers that are numeric by design are exempt even when they happen to pass Luhn.
          references: [{ type: "provider_transaction_id", value: CARD_NUMBER }],
          lineItems: [{ description: "Toothbrush", productId: "4006381333931" }],
          intent: { via: "share", url: `https://shop.example/item/${CARD_NUMBER}` },
          evidence: { summary: "UPI ref 627712345678; order 408-1234567-1234567" },
        });
        expect(await store.putObservations([fine])).toEqual({ inserted: 1 });
        expect((await allObservations())[0]).toEqual(fine);
      });

      it("refuses raw payload fields, oversized facts and oversized excerpts", async () => {
        const smuggled = { ...contractObservation("obs_1", "conn_a", T0), payload: { body: "Dear customer…" } } as Observation;
        const huge = contractObservation("obs_2", "conn_a", T0, { lineItems: [{ description: "x".repeat(40_000) }] });
        const longExcerpt = contractObservation("obs_3", "conn_a", T0, {
          evidence: { summary: "s", excerpt: "y".repeat(501), excerptExpiresAt: T0 + DAY },
        });
        await expect(store.putObservations([smuggled])).rejects.toThrow();
        await expect(store.putObservations([huge])).rejects.toThrow();
        await expect(store.putObservations([longExcerpt])).rejects.toThrow();
        expect(await allObservations()).toEqual([]);

        const fine = contractObservation("obs_4", "conn_a", T0, {
          lineItems: [{ description: "z".repeat(8_000) }],
          evidence: { summary: "s", excerpt: "y".repeat(500), excerptExpiresAt: T0 + DAY },
        });
        expect(await store.putObservations([fine])).toEqual({ inserted: 1 });
      });

      it("refuses free-text prompt answers and unmasked instruments", async () => {
        const prompt: PromptLogEntry = { id: "p1", kind: "question", shownAt: T0, answeredAt: T0, answer: "I regret buying this, honestly" };
        await expect(store.logPrompt(prompt)).rejects.toThrow();
        await expect(store.putOwnedInstrument({ id: "i1", type: "card", last4: "411111" })).rejects.toThrow();
        expect(await store.listPrompts(0)).toEqual([]);
        expect(await store.listOwnedInstruments()).toEqual([]);
      });

      it("keeps only the fields the schema has room for", async () => {
        // A careless caller attaching extra data to a row-shaped record: it is dropped, not stored.
        const card = { id: "i1", type: "card", last4: "1111", cardNumber: CARD_NUMBER } as StoredInstrument;
        await store.putOwnedInstrument(card);
        expect(await store.listOwnedInstruments()).toEqual([{ id: "i1", type: "card", last4: "1111" }]);
        const rule = { id: "r1", description: "pause", level: "pause", channel: "online", note: "free text" } as UserRule;
        await store.putRule(rule);
        expect(await store.listRules()).toEqual([{ id: "r1", description: "pause", level: "pause", channel: "online" }]);
      });
    });

    describe("revoking a connection", () => {
      beforeEach(async () => {
        await store.upsertConnection(contractConnection("conn_a"));
        await store.upsertConnection(contractConnection("conn_b"));
        await store.putObservations([
          contractObservation("obs_a1", "conn_a", T0),
          contractObservation("obs_a2", "conn_a", T0 + 1),
          contractObservation("obs_b1", "conn_b", T0 + 2),
        ]);
      });

      it("marks it revoked, records the receipt and purges only its observations", async () => {
        const label: UserAssertion = { id: "as_1", kind: "label", at: T0, anchors: ["obs_a1"], field: "category", value: "shopping.online" };
        await store.putAssertion(label);
        const at = T0 + HOUR;
        expect(await store.revokeConnection("conn_a", at)).toEqual({ deletedObservations: 2 });

        expect(ids(await allObservations())).toEqual(["obs_b1"]);
        const revoked = (await store.listConnections()).find((c) => c.connectionId === "conn_a");
        expect(revoked).toEqual({ ...contractConnection("conn_a"), status: "revoked", revokedAt: at, updatedAt: at });
        expect((await store.listConnections()).find((c) => c.connectionId === "conn_b")?.status).toBe("active");
        const conn = contractConnection("conn_a");
        expect(await store.listConsentEvents("conn_a")).toEqual([
          { connectionId: "conn_a", action: "revoked", at, scopes: conn.scopes, purposes: conn.purposes },
        ]);
        // The user's own answers survive: they are anchored to ids, not to the source.
        expect(await store.listAssertions()).toEqual([label]);
      });

      it("is idempotent, final, and refuses late arrivals from the revoked source", async () => {
        await store.revokeConnection("conn_a", T0 + HOUR);
        // An offline device syncing its queue must not resurrect what the user deleted.
        expect(await store.putObservations([contractObservation("obs_late", "conn_a", T0 + 2 * HOUR)])).toEqual({ inserted: 0 });
        expect(await store.revokeConnection("conn_a", T0 + 3 * HOUR)).toEqual({ deletedObservations: 0 });
        expect(ids(await allObservations())).toEqual(["obs_b1"]);

        const revoked = (await store.listConnections()).find((c) => c.connectionId === "conn_a");
        expect(revoked?.revokedAt).toBe(T0 + HOUR);
        expect(await store.listConsentEvents("conn_a")).toHaveLength(1);

        // Revocation is final: a stale copy of the grant cannot bring it back.
        await expect(store.upsertConnection(contractConnection("conn_a", { updatedAt: T0 + 4 * HOUR }))).rejects.toMatchObject({ code: "23514" });
        expect((await store.listConnections()).find((c) => c.connectionId === "conn_a")?.status).toBe("revoked");
        // Re-upserting the revoked state itself (e.g. a label fix) is fine.
        await store.upsertConnection({ ...revoked!, label: "Old bank SMS alerts" });
        expect((await store.listConnections()).find((c) => c.connectionId === "conn_a")?.label).toBe("Old bank SMS alerts");
      });

      it("rejects an unknown connection", async () => {
        await expect(store.revokeConnection("conn_missing", T0)).rejects.toMatchObject({ code: "P0002" });
        expect(await allObservations()).toHaveLength(3);
      });
    });

    describe("assertions", () => {
      const label: UserAssertion = { id: "as_1", kind: "label", at: T0, anchors: ["obs_1"], field: "category", value: "food.groceries" };
      const same: UserAssertion = { id: "as_2", kind: "same_event", at: T0 - HOUR, anchors: ["obs_1", "obs_2"] };
      const satisfaction: UserAssertion = { id: "as_3", kind: "satisfaction", at: T0, anchors: ["obs_3"], value: "regretted", askedAt: T0 - DAY };

      it("puts, lists (oldest first), replaces and deletes", async () => {
        await store.putAssertion(label);
        await store.putAssertion(satisfaction);
        await store.putAssertion(same);
        expect(await store.listAssertions()).toEqual([same, label, satisfaction]);

        const relabelled: UserAssertion = { ...label, value: "food.restaurants" };
        await store.putAssertion(relabelled);
        expect(await store.listAssertions()).toEqual([same, relabelled, satisfaction]);

        await store.deleteAssertion("as_2");
        await store.deleteAssertion("as_missing");
        expect(await store.listAssertions()).toEqual([relabelled, satisfaction]);
      });

      it("requires 1 to 50 anchors and refuses card numbers", async () => {
        await expect(store.putAssertion({ ...same, anchors: [] })).rejects.toThrow();
        await expect(
          store.putAssertion({ ...same, anchors: Array.from({ length: 51 }, (_, i) => `obs_${i}`) }),
        ).rejects.toThrow();
        await expect(store.putAssertion({ ...label, value: `card ${CARD_NUMBER}` })).rejects.toMatchObject({ code: "23514" });
        expect(await store.listAssertions()).toEqual([]);
      });
    });

    describe("preferences", () => {
      it("stores settings, replacing optional fields that are later omitted", async () => {
        expect(await store.getSettings()).toBeNull();
        const full: UserSettings = {
          locale: "en-IN",
          timeZone: "Asia/Kolkata",
          homeCountry: "IN",
          homeCurrency: "INR",
          questionWeeklyBudget: 5,
          regretPromptsEnabled: true,
        };
        await store.putSettings(full);
        expect(await store.getSettings()).toEqual(full);

        const minimal: UserSettings = { locale: "pt-BR", timeZone: "America/Sao_Paulo", questionWeeklyBudget: 0, regretPromptsEnabled: false };
        await store.putSettings(minimal);
        const read = await store.getSettings();
        expect(read).toEqual(minimal);
        expect(read).not.toHaveProperty("homeCountry");

        await expect(store.putSettings({ ...minimal, questionWeeklyBudget: 51 })).rejects.toThrow();
        await expect(store.putSettings({ ...minimal, homeCountry: "india" })).rejects.toThrow();
        await expect(store.putSettings({ ...minimal, locale: "x" })).rejects.toThrow();
        expect(await store.getSettings()).toEqual(minimal);
      });

      it("derives budget ids from category, period and currency", async () => {
        const groceries: Budget = { category: "food.groceries", limit: money(500_000, "INR"), period: "monthly" };
        const overall: Budget = { limit: money(250_000, "INR"), period: "weekly" };
        const custom: Budget = { id: "custom", category: "travel", limit: money(10_000, "USD"), period: "monthly" };
        await store.putBudget(groceries);
        await store.putBudget(overall);
        await store.putBudget(custom);
        expect(await store.listBudgets()).toEqual([
          { ...overall, id: "all:weekly:INR" },
          { ...custom },
          { ...groceries, id: "food.groceries:monthly:INR" },
        ]);

        // Same natural key: replaces rather than duplicates.
        await store.putBudget({ ...groceries, limit: money(600_000, "INR") });
        expect((await store.listBudgets()).find((b) => b.id === "food.groceries:monthly:INR")?.limit.minor).toBe(600_000);
        expect(await store.listBudgets()).toHaveLength(3);

        await store.deleteBudget("all:weekly:INR");
        expect(ids((await store.listBudgets()) as Array<{ id: string }>)).toEqual(["custom", "food.groceries:monthly:INR"]);
        await expect(store.putBudget({ ...overall, limit: money(0, "INR") })).rejects.toThrow();
      });

      it("stores goals in one currency", async () => {
        const trip: Goal = { id: "g_trip", name: "Trip to Goa", target: money(5_000_000, "INR"), saved: money(120_000, "INR"), targetDate: T0 + 90 * DAY };
        const fund: Goal = { id: "g_fund", name: "Emergency fund", target: money(100_000_00, "INR"), saved: money(0, "INR") };
        await store.putGoal(trip);
        await store.putGoal(fund);
        expect(await store.listGoals()).toEqual([fund, trip]);
        await store.putGoal({ ...trip, saved: money(200_000, "INR") });
        expect((await store.listGoals()).find((g) => g.id === "g_trip")?.saved.minor).toBe(200_000);
        await store.deleteGoal("g_fund");
        expect(ids(await store.listGoals())).toEqual(["g_trip"]);
        await expect(store.putGoal({ ...fund, saved: money(1, "USD") })).rejects.toThrow();
        await expect(store.putGoal({ ...fund, name: "n".repeat(81) })).rejects.toThrow();
      });

      it("stores rules", async () => {
        const night: UserRule = { id: "r_night", description: "pause online shopping after 11pm", channel: "online", localHours: { from: 23, to: 5 }, level: "pause" };
        const gadgets: UserRule = {
          id: "r_gadgets",
          description: "remind me of my goal for electronics over ₹2,000",
          category: "shopping.electronics",
          minAmount: money(200_000, "INR"),
          level: "reflect",
        };
        await store.putRule(night);
        await store.putRule(gadgets);
        expect(await store.listRules()).toEqual([gadgets, night]);
        await store.putRule({ ...night, level: "inform" });
        expect((await store.listRules()).find((r) => r.id === "r_night")?.level).toBe("inform");
        await store.deleteRule("r_gadgets");
        expect(ids(await store.listRules())).toEqual(["r_night"]);
        await expect(store.putRule({ ...night, description: "d".repeat(201) })).rejects.toThrow();
      });

      it("stores masked owned instruments", async () => {
        const card: StoredInstrument = { id: "i_card", type: "card", issuer: "Test Bank", last4: "1234", cardKind: "credit" };
        const upi: StoredInstrument = { id: "i_upi", type: "upi_handle", handle: "someone@okbank" };
        const account: StoredInstrument = { id: "i_acct", type: "bank_account", issuer: "Test Bank", last4: "9012", accountRef: "acc_opaque_1" };
        await store.putOwnedInstrument(card);
        await store.putOwnedInstrument(upi);
        await store.putOwnedInstrument(account);
        expect(await store.listOwnedInstruments()).toEqual([account, card, upi]);
        await store.deleteOwnedInstrument("i_upi");
        expect(ids(await store.listOwnedInstruments())).toEqual(["i_acct", "i_card"]);
      });
    });

    describe("prompt log", () => {
      it("logs, updates by id and lists since an instant (inclusive), oldest first", async () => {
        const old: PromptLogEntry = { id: "p_old", kind: "question", anchor: "obs_1", shownAt: T0 - 8 * DAY };
        const recent: PromptLogEntry = { id: "p_recent", kind: "regret_prompt", anchor: "obs_2", shownAt: T0 - DAY };
        const now: PromptLogEntry = { id: "p_now", kind: "insight", shownAt: T0 };
        await store.logPrompt(now);
        await store.logPrompt(old);
        await store.logPrompt(recent);
        expect(await store.listPrompts(T0 - DAY)).toEqual([recent, now]);
        expect(await store.listPrompts(0)).toEqual([old, recent, now]);

        const answered: PromptLogEntry = { ...recent, answeredAt: T0 - DAY + MINUTE, answer: "worth_it" };
        await store.logPrompt(answered);
        await store.logPrompt({ ...now, answeredAt: T0, answer: "dismissed" });
        expect(await store.listPrompts(T0 - DAY)).toEqual([answered, { ...now, answeredAt: T0, answer: "dismissed" }]);
      });

      it("treats infinite, out-of-range and fractional bounds numerically and refuses NaN", async () => {
        const old: PromptLogEntry = { id: "p_old", kind: "question", shownAt: T0 - DAY };
        const now: PromptLogEntry = { id: "p_now", kind: "insight", shownAt: T0 };
        await store.logPrompt(old);
        await store.logPrompt(now);
        expect(await store.listPrompts(Number.NEGATIVE_INFINITY)).toEqual([old, now]);
        expect(await store.listPrompts(-1e16)).toEqual([old, now]);
        expect(await store.listPrompts(T0 - 0.5)).toEqual([now]);
        expect(await store.listPrompts(1e16)).toEqual([]);
        expect(await store.listPrompts(Number.POSITIVE_INFINITY)).toEqual([]);
        await expect(store.listPrompts(Number.NaN)).rejects.toThrow();
      });
    });

    describe("instants in every timestamp column", () => {
      it("round-trips the edges of the storable range wherever an instant is stored", async () => {
        const year1 = MIN_INSTANT;
        const end = MAX_INSTANT;
        // The longest excerpt life there is, so the excerpt's own expiry (the end of time) is what is kept.
        const c = contractConnection("conn_t", { grantedAt: year1, updatedAt: end, retention: { excerptTtlMs: Number.MAX_SAFE_INTEGER, observationTtlMs: null } });
        await store.upsertConnection(c);
        await store.appendConsentEvent({ connectionId: "conn_t", action: "granted", at: year1, scopes: [], purposes: [] });
        await store.appendConsentEvent({ connectionId: "conn_t", action: "paused", at: end, scopes: [], purposes: [] });
        const goal: Goal = { id: "g1", name: "Far", target: money(1, "INR"), saved: money(0, "INR"), targetDate: year1 };
        const goal2: Goal = { ...goal, id: "g2", targetDate: end };
        await store.putGoal(goal);
        await store.putGoal(goal2);
        const p1: PromptLogEntry = { id: "p1", kind: "question", shownAt: year1, answeredAt: end, answer: "x" };
        await store.logPrompt(p1);
        await store.putObservations([
          contractObservation("obs_1", "conn_t", year1, { occurredAt: { value: year1, confidence: 1 }, evidence: { summary: "s", excerpt: "e", excerptExpiresAt: end } }),
        ]);
        expect(await store.listConnections()).toEqual([c]);
        expect((await store.listConsentEvents()).map((e) => e.at)).toEqual([year1, end]);
        expect(await store.listGoals()).toEqual([goal, goal2]);
        expect(await store.listPrompts(year1)).toEqual([p1]);
        expect((await store.listObservations()).items[0]?.evidence.excerptExpiresAt).toBe(end);
        const exported = await store.exportAll();
        expect(exported.connections).toEqual([c]);
        expect(exported.goals).toEqual([goal, goal2]);
        expect(exported.prompts).toEqual([p1]);
        expect(exported.observations[0]?.evidence.excerptExpiresAt).toBe(end);
        expect(await store.revokeConnection("conn_t", year1 + 1)).toEqual({ deletedObservations: 1 });
        expect((await store.listConnections())[0]?.revokedAt).toBe(year1 + 1);
      });
    });

    describe("unstorable values in every table", () => {
      it("refuses NUL and lone surrogates with 22P05, storing nothing", async () => {
        const nul = "\u0000";
        const writes: Array<() => Promise<unknown>> = [
          () => store.upsertConnection(contractConnection("conn_x", { label: `SMS ${nul}` })),
          () => store.appendConsentEvent({ connectionId: "conn_x", action: "granted", at: T0, scopes: [LONE_SURROGATE], purposes: [] }),
          () => store.putAssertion({ id: "as_1", kind: "label", at: T0, anchors: ["obs_1"], field: "category", value: `food${LONE_SURROGATE}` }),
          () => store.putSettings({ locale: "en-IN", timeZone: `Asia/Kolkata${nul}`, questionWeeklyBudget: 5, regretPromptsEnabled: true }),
          () => store.putBudget({ category: `food${nul}`, limit: money(1, "INR"), period: "weekly" }),
          () => store.putGoal({ id: "g1", name: `Trip ${LONE_SURROGATE}`, target: money(1, "INR"), saved: money(0, "INR") }),
          () => store.putRule({ id: "r1", description: `pause${nul}`, level: "pause" }),
          () => store.putOwnedInstrument({ id: "i1", type: "card", issuer: `Bank${nul}` }),
          () => store.logPrompt({ id: "p1", kind: "question", anchor: `obs${nul}`, shownAt: T0 }),
        ];
        for (const write of writes) await expect(write()).rejects.toMatchObject({ code: "22P05" });
        const exported = await store.exportAll();
        expect({ ...exported, exportedAt: 0 }).toEqual({
          exportedAt: 0,
          settings: null,
          connections: [],
          consentEvents: [],
          observations: [],
          assertions: [],
          budgets: [],
          goals: [],
          rules: [],
          instruments: [],
          prompts: [],
        });
      });

      it("reports the database's codes for over-long codes, unsafe integers and mixed goal currencies", async () => {
        await expect(store.putBudget({ limit: money(1, "INRR"), period: "weekly" })).rejects.toMatchObject({ code: "22001" });
        await expect(store.putBudget({ limit: { minor: 1, currency: "inr" }, period: "weekly" })).rejects.toMatchObject({ code: "23514" });
        await expect(store.putBudget({ limit: money(2 ** 53, "INR"), period: "weekly" })).rejects.toMatchObject({ code: "23514" });
        const settings: UserSettings = { locale: "en-IN", timeZone: "Asia/Kolkata", questionWeeklyBudget: 5, regretPromptsEnabled: true };
        await expect(store.putSettings({ ...settings, homeCountry: "IND" })).rejects.toMatchObject({ code: "22001" });
        await expect(store.putSettings({ ...settings, homeCurrency: "RUPEE" })).rejects.toMatchObject({ code: "22001" });
        for (const questionWeeklyBudget of [51, 1e10, 2.5]) {
          await expect(store.putSettings({ ...settings, questionWeeklyBudget })).rejects.toMatchObject({ code: "23514" });
        }
        const goal: Goal = { id: "g1", name: "Trip", target: money(100, "INR"), saved: money(0, "INR") };
        await expect(store.putGoal({ ...goal, saved: money(1, "USD") })).rejects.toMatchObject({ code: "23514" });
        await expect(store.putGoal({ ...goal, target: money(2 ** 53, "INR") })).rejects.toMatchObject({ code: "23514" });
        await expect(store.putGoal({ ...goal, targetDate: T0 + 0.5 })).rejects.toMatchObject({ code: "23514" });
        await expect(
          store.upsertConnection(contractConnection("conn_x", { retention: { excerptTtlMs: 2 ** 53, observationTtlMs: null } })),
        ).rejects.toMatchObject({ code: "23514" });
        expect(await store.listBudgets()).toEqual([]);
        expect(await store.getSettings()).toBeNull();
        expect(await store.listGoals()).toEqual([]);
        expect(await store.listConnections()).toEqual([]);
      });

      it("enforces the schema's length and size limits, accepting values right at them", async () => {
        const s = (n: number, ch = "x") => ch.repeat(n);
        const tooBig: Array<() => Promise<unknown>> = [
          () => store.upsertConnection(contractConnection(s(513))),
          () => store.upsertConnection(contractConnection("c1", { adapterId: s(129) })),
          () => store.upsertConnection(contractConnection("c1", { provider: s(201) })),
          () => store.upsertConnection(contractConnection("c1", { scopes: Array.from({ length: 65 }, (_, i) => `s${i}`) })),
          () => store.upsertConnection(contractConnection("c1", { purposes: [s(3000), s(3000), s(3000)] })),
          () => store.appendConsentEvent({ connectionId: s(513), action: "granted", at: T0, scopes: [], purposes: [] }),
          () => store.appendConsentEvent({ connectionId: "c1", action: "granted", at: T0, scopes: Array.from({ length: 65 }, () => "s"), purposes: [] }),
          () => store.putAssertion({ id: s(513), kind: "confirm", at: T0, anchors: ["obs_1"] }),
          () => store.putAssertion({ id: "as_1", kind: "confirm", at: T0, anchors: Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(700, "x")) }),
          () => store.putAssertion({ id: "as_1", kind: "label", at: T0, anchors: ["obs_1"], field: "category", value: s(40_000) }),
          () => store.putBudget({ category: s(257), limit: money(1, "INR"), period: "weekly" }),
          () => store.putBudget({ id: s(513), limit: money(1, "INR"), period: "weekly" }),
          () => store.putGoal({ id: s(513), name: "n", target: money(1, "INR"), saved: money(0, "INR") }),
          () => store.putRule({ id: s(513), description: "d", level: "inform" }),
          () => store.putRule({ id: "r1", description: "d", level: "inform", category: s(5_000) }),
          () => store.putOwnedInstrument({ id: s(513), type: "wallet" }),
          () => store.putOwnedInstrument({ id: "i1", type: "wallet", issuer: s(201) }),
          () => store.putOwnedInstrument({ id: "i1", type: "wallet", accountRef: s(257) }),
          () => store.putOwnedInstrument({ id: "i1", type: "upi_handle", handle: s(257) }),
          () => store.logPrompt({ id: s(513), kind: "question", shownAt: T0 }),
          () => store.logPrompt({ id: "p1", kind: "question", anchor: s(513), shownAt: T0 }),
        ];
        for (const write of tooBig) await expect(write()).rejects.toMatchObject({ code: "23514" });

        await store.upsertConnection(contractConnection("conn_a"));
        const tooLongObservations = [
          contractObservation(s(513), "conn_a", T0),
          contractObservation("obs_1", "conn_a", T0, { source: { ...contractObservation("x", "conn_a", T0).source, adapterId: s(129) } }),
          contractObservation("obs_2", "conn_a", T0, { merchant: { raw: "m", key: s(257), confidence: 1 } }),
        ];
        for (const o of tooLongObservations) await expect(store.putObservations([o])).rejects.toMatchObject({ code: "23514" });

        // Right at every limit is fine.
        const id512 = s(512, "i");
        await store.upsertConnection(
          contractConnection(id512, { adapterId: s(128), provider: s(200), scopes: Array.from({ length: 64 }, (_, i) => `s${i}`), purposes: [s(3000), s(3000)] }),
        );
        await store.appendConsentEvent({ connectionId: id512, action: "granted", at: T0, scopes: Array.from({ length: 64 }, () => "s"), purposes: [] });
        await store.putObservations([contractObservation(id512, id512, T0, { merchant: { raw: "m", key: s(256), confidence: 1 } })]);
        await store.putAssertion({ id: id512, kind: "confirm", at: T0, anchors: [id512] });
        await store.putBudget({ id: id512, category: s(256), limit: money(1, "INR"), period: "weekly" });
        await store.putGoal({ id: id512, name: "n", target: money(1, "INR"), saved: money(0, "INR") });
        await store.putRule({ id: id512, description: "d", level: "inform", category: s(256) });
        await store.putOwnedInstrument({ id: id512, type: "wallet", issuer: s(200), accountRef: s(256), handle: s(256) });
        await store.logPrompt({ id: id512, kind: "question", anchor: id512, shownAt: T0 });
        const exported = await store.exportAll();
        expect(exported.connections.map((c) => c.connectionId)).toEqual(["conn_a", id512]);
        expect([exported.observations, exported.assertions, exported.budgets, exported.goals, exported.rules, exported.instruments, exported.prompts].map((l) => l.length)).toEqual([
          1, 1, 1, 1, 1, 1, 1,
        ]);
      });

      it("refuses full card numbers in connection labels, instruments and prompt anchors", async () => {
        const writes: Array<() => Promise<unknown>> = [
          () => store.upsertConnection(contractConnection("c1", { label: `Card ${CARD_NUMBER}` })),
          () => store.upsertConnection(contractConnection("c1", { provider: `Bank 4111 1111 1111 1111` })),
          () => store.putOwnedInstrument({ id: "i1", type: "card", accountRef: CARD_NUMBER }),
          () => store.putOwnedInstrument({ id: "i1", type: "upi_handle", handle: `${CARD_NUMBER}@bank` }),
          () => store.putOwnedInstrument({ id: "i1", type: "card", issuer: `Bank ${CARD_NUMBER}` }),
          () => store.logPrompt({ id: "p1", kind: "question", anchor: `obs ${CARD_NUMBER}`, shownAt: T0 }),
        ];
        for (const write of writes) await expect(write()).rejects.toMatchObject({ code: "23514" });
        expect(await store.listConnections()).toEqual([]);
        expect(await store.listOwnedInstruments()).toEqual([]);
        expect(await store.listPrompts(0)).toEqual([]);
        // Masked and Luhn-invalid numbers are fine.
        await store.putOwnedInstrument({ id: "i1", type: "card", accountRef: NOT_A_CARD, handle: "card ••••1111", issuer: "Test Bank" });
        expect(await store.listOwnedInstruments()).toHaveLength(1);
      });

      it("deletes by exact id, never by pattern, whatever the id contains", async () => {
        const assertionIds = ["as*", "as%", "as_x", "asX", 'as "q"', "as,(b)", "as\\"];
        for (const id of assertionIds) await store.putAssertion({ id, kind: "confirm", at: T0, anchors: ["obs_1"] });
        for (const id of ["as*", "as%", 'as "q"', "as\\"]) await store.deleteAssertion(id);
        expect((await store.listAssertions()).map((a) => a.id)).toEqual(["as,(b)", "asX", "as_x"]);

        const odd: Budget = { category: 'food "q",(x)', limit: money(1, "INR"), period: "weekly" };
        await store.putBudget(odd);
        await store.putBudget({ category: "food", limit: money(1, "INR"), period: "weekly" });
        await store.deleteBudget('food "q",(x):weekly:INR');
        expect(ids((await store.listBudgets()) as Array<{ id: string }>)).toEqual(["food:weekly:INR"]);
        for (const id of ["g*", "g"]) await store.putGoal({ id, name: "n", target: money(1, "INR"), saved: money(0, "INR") });
        await store.deleteGoal("g*");
        expect(ids(await store.listGoals())).toEqual(["g"]);
        for (const id of ["r%", "r"]) await store.putRule({ id, description: "d", level: "inform" });
        await store.deleteRule("r%");
        expect(ids(await store.listRules())).toEqual(["r"]);
        for (const id of ["i.1", "i"]) await store.putOwnedInstrument({ id, type: "wallet" });
        await store.deleteOwnedInstrument("i.1");
        expect(ids(await store.listOwnedInstruments())).toEqual(["i"]);
      });
    });

    describe("user rights", () => {
      async function populate(): Promise<void> {
        await store.putSettings({ locale: "en-IN", timeZone: "Asia/Kolkata", homeCountry: "IN", homeCurrency: "INR", questionWeeklyBudget: 3, regretPromptsEnabled: true });
        await store.upsertConnection(contractConnection("conn_a"));
        await store.appendConsentEvent({ connectionId: "conn_a", action: "granted", at: T0 - 10 * DAY, scopes: ["sms:read_transactional"], purposes: ["detect purchases"] });
        await store.putObservations([
          contractObservation("obs_1", "conn_a", T0, { evidence: { summary: "s", excerpt: "Rs 10 at SHOP", excerptExpiresAt: T0 + DAY } }),
          contractObservation("obs_2", "conn_a", T0 + 1),
        ]);
        await store.putAssertion({ id: "as_1", kind: "confirm", at: T0, anchors: ["obs_1"] });
        await store.putBudget({ category: "food", limit: money(100_000, "INR"), period: "monthly" });
        await store.putGoal({ id: "g1", name: "Laptop", target: money(8_000_000, "INR"), saved: money(0, "INR") });
        await store.putRule({ id: "r1", description: "late night pause", localHours: { from: 23, to: 5 }, level: "pause" });
        await store.putOwnedInstrument({ id: "i1", type: "card", last4: "4242", cardKind: "debit" });
        await store.logPrompt({ id: "p1", kind: "question", anchor: "obs_2", shownAt: T0, answeredAt: T0 + 1, answer: "cat:food" });
      }

      it("exports everything stored about the user", async () => {
        await populate();
        clock.advance(HOUR);
        const exported = await store.exportAll();
        expect(exported).toEqual({
          exportedAt: T0 + HOUR,
          settings: await store.getSettings(),
          connections: await store.listConnections(),
          consentEvents: await store.listConsentEvents(),
          observations: (await store.listObservations()).items,
          assertions: await store.listAssertions(),
          budgets: await store.listBudgets(),
          goals: await store.listGoals(),
          rules: await store.listRules(),
          instruments: await store.listOwnedInstruments(),
          prompts: await store.listPrompts(0),
        });
        expect(exported.connections).toHaveLength(1);
        expect(exported.consentEvents).toHaveLength(1);
        expect(exported.observations.map((o) => o.id)).toEqual(["obs_1", "obs_2"]);
        expect(exported.observations[0]?.evidence.excerpt).toBe("Rs 10 at SHOP");
        expect(exported.assertions).toHaveLength(1);
        expect(exported.budgets).toHaveLength(1);
        expect(exported.goals).toHaveLength(1);
        expect(exported.rules).toHaveLength(1);
        expect(exported.instruments).toHaveLength(1);
        expect(exported.prompts).toHaveLength(1);
        // Plain JSON: survives serialization unchanged.
        expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
      });

      it("exports an empty account", async () => {
        expect(await store.exportAll()).toEqual({
          exportedAt: T0,
          settings: null,
          connections: [],
          consentEvents: [],
          observations: [],
          assertions: [],
          budgets: [],
          goals: [],
          rules: [],
          instruments: [],
          prompts: [],
        });
      });

      it("erases every row, including consent receipts, and stays usable", async () => {
        await populate();
        await store.eraseAll();
        const exported = await store.exportAll();
        expect(exported).toEqual({
          exportedAt: T0,
          settings: null,
          connections: [],
          consentEvents: [],
          observations: [],
          assertions: [],
          budgets: [],
          goals: [],
          rules: [],
          instruments: [],
          prompts: [],
        });
        await store.upsertConnection(contractConnection("conn_new"));
        expect(await store.putObservations([contractObservation("obs_1", "conn_new", T0)])).toEqual({ inserted: 1 });
      });
    });
  });
}
