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
        await store.putObservations([contractObservation("obs_1", "conn_a", T0)]);
        expect((await store.listObservations()).items).toHaveLength(1);
        expect((await store.listObservations({ limit: 5_000 })).items).toHaveLength(1);
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
