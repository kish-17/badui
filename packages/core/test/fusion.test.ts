import { describe, expect, it } from "vitest";
import { T0, makeObservation, makeSource } from "@brake/core/testing";
import { DEFAULT_FUSION_CONFIG, createFusionEngine, restoreFusionEngine } from "../src/fusion/engine";
import { assessPair, isContextOnly, isTransactional } from "../src/fusion/match";
import { defaultMerchantMatcher, displayNameFromDescriptor, merchantTokens } from "../src/fusion/merchant";
import type { FusionEngine, MerchantMatcher } from "../src/fusion/types";
import type { UserAssertion } from "../src/model/assertion";
import { userInference } from "../src/model/candidate";
import type { CandidateLink, Inference } from "../src/model/candidate";
import { money } from "../src/model/money";
import type { MerchantObservation, Observation } from "../src/model/observation";
import { DAY, HOUR, MINUTE, fixedClock } from "../src/model/primitives";
import { stableId } from "../src/util/hash";

const SRC = {
  notification: makeSource({ adapterId: "android-notification", kind: "notification", connectionId: "conn_notif", provider: "HDFC Bank", label: "HDFC Bank notification" }),
  sms: makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_sms", provider: "HDFC Bank", label: "HDFC Bank SMS alert" }),
  gmail: makeSource({ adapterId: "gmail", kind: "email", connectionId: "conn_gmail", label: "Gmail inbox" }),
  bank: makeSource({ adapterId: "bank-api", kind: "open_banking", connectionId: "conn_bank", provider: "HDFC Bank", label: "HDFC Bank account data" }),
  plaid: makeSource({ adapterId: "plaid", kind: "open_banking", connectionId: "conn_plaid_1", provider: "Chase", label: "Chase via Plaid" }),
  plaidDuplicateItem: makeSource({ adapterId: "plaid", kind: "open_banking", connectionId: "conn_plaid_2", provider: "Chase", label: "Chase via Plaid" }),
  receiptPhoto: makeSource({ adapterId: "receipt", kind: "receipt", connectionId: "conn_receipts", label: "receipt photos" }),
};

const ORDER_REF = { type: "order_id" as const, value: "402-8812345-1234567", namespace: "amazon" };
const BANK_REF = { type: "provider_transaction_id" as const, value: "TXN-88213", namespace: "bank:hdfc:acc" };

/** The brief's ₹1,249 Amazon purchase: alert, order email, pending ledger entry. */
function amazonPurchase(): { alert: Observation; order: Observation; pending: Observation } {
  return {
    alert: makeObservation({
      id: "obs_alert",
      source: SRC.notification,
      receivedAt: T0,
      occurredAt: { value: T0, confidence: 0.95 },
      minor: 124_900,
      merchant: { raw: "AMAZON", confidence: 0.8 },
      instrument: { type: "card", last4: "1234" },
      references: [],
    }),
    order: makeObservation({
      id: "obs_order",
      source: SRC.gmail,
      kind: "order",
      direction: undefined,
      receivedAt: T0 + MINUTE,
      occurredAt: { value: T0 + MINUTE, confidence: 0.9 },
      minor: 124_900,
      merchant: { raw: "Amazon.in", name: "Amazon", confidence: 0.9 },
      lineItems: [{ description: "headphones" }],
      references: [ORDER_REF],
    }),
    pending: makeObservation({
      id: "obs_pending",
      source: SRC.bank,
      stage: "pending",
      receivedAt: T0 + 2 * MINUTE,
      occurredAt: { value: T0, confidence: 0.6 },
      minor: 124_900,
      merchant: { raw: "AMZN PAY INDIA", confidence: 0.7 },
      references: [BANK_REF],
      confidence: 0.97,
    }),
  };
}

function newEngine(now = T0 + HOUR, matcher?: MerchantMatcher) {
  const clock = fixedClock(now);
  return { clock, engine: createFusionEngine({ clock, ...(matcher ? { merchantMatcher: matcher } : {}) }) };
}

function ingestAll(engine: FusionEngine, observations: readonly Observation[]) {
  return observations.map((o) => engine.ingest(o));
}

const json = (x: unknown): string => JSON.stringify(x);
const SECOND_MS = 1_000;

let assertionSeq = 0;
function assertion<K extends UserAssertion["kind"]>(kind: K, anchors: string[], extra: Record<string, unknown> = {}): UserAssertion {
  assertionSeq += 1;
  return { id: `asrt_${assertionSeq}`, at: T0 + 30 * MINUTE, anchors, kind, ...extra } as UserAssertion;
}

/* ------------------------------------------------------------------ */
/* Merchant matcher                                                    */
/* ------------------------------------------------------------------ */

describe("defaultMerchantMatcher", () => {
  const m = (raw: string, extra: Partial<MerchantObservation> = {}): MerchantObservation => ({ raw, confidence: 0.8, ...extra });

  it("cleans descriptors conservatively into canonical keys", () => {
    expect(defaultMerchantMatcher.key(m("AMZN Mktp US*2K4L"))).toBe("amazon");
    expect(defaultMerchantMatcher.key(m("AMZN PAY INDIA"))).toBe("amazon");
    expect(defaultMerchantMatcher.key(m("Amazon.in"))).toBe("amazon");
    expect(defaultMerchantMatcher.key(m("UPI/627712345678/AMAZON/amazon@apl"))).toBe("amazon");
    expect(defaultMerchantMatcher.key(m("SQ *BLUE BOTTLE COFFEE #42"))).toBe("blue bottle coffee");
    expect(defaultMerchantMatcher.key(m("PAYTM*SWIGGY BANGALORE"))).toBe("swiggy bangalore");
    expect(defaultMerchantMatcher.key(m("POS 402134 RELIANCE RETAIL PVT LTD"))).toBe("reliance");
    expect(defaultMerchantMatcher.key(m("Padaria São João Ltda"))).toBe("padaria sao joao");
    expect(defaultMerchantMatcher.key(m("PIX - PADARIA SAO JOAO"))).toBe("padaria sao joao");
    expect(defaultMerchantMatcher.key(m("x", { key: " Amazon " }))).toBe("amazon");
    expect(defaultMerchantMatcher.key(m("anything", { name: "Naivas" }))).toBe("naivas");
  });

  it("yields no key for gateway-only or numeric descriptors rather than a misleading one", () => {
    expect(defaultMerchantMatcher.key(m("RAZORPAY PAYMENTS"))).toBeNull();
    expect(defaultMerchantMatcher.key(m("1234567890"))).toBeNull();
    expect(merchantTokens("")).toEqual([]);
  });

  it("scores truncated, suffixed and handle-identified names as similar, different brands as different", () => {
    expect(defaultMerchantMatcher.similarity(m("STARBUCKS COFF"), m("Starbucks Coffee"))).toBe(1);
    expect(defaultMerchantMatcher.similarity(m("BLUE TOKAI COFFEE ROASTERS"), m("Blue Tokai"))).toBeGreaterThan(0.7);
    expect(defaultMerchantMatcher.similarity(m("BLUETOKAI"), m("Blue Tokai"))).toBe(1);
    expect(defaultMerchantMatcher.similarity(m("DD DOORDASH BURGERKIN"), m("DoorDash"))).toBeGreaterThan(0.5);
    expect(defaultMerchantMatcher.similarity(m("P1", { handle: "swiggy@icici" }), m("P2", { handle: "SWIGGY@ICICI" }))).toBe(1);
    expect(defaultMerchantMatcher.similarity(m("SWIGGY"), m("Zomato"))).toBe(0);
  });

  it("derives a display name from a raw descriptor", () => {
    expect(displayNameFromDescriptor("AMZN Mktp US*2K4L")).toBe("Amazon");
    expect(displayNameFromDescriptor("SQ *BLUE BOTTLE COFFEE #42")).toBe("Blue Bottle Coffee");
    expect(displayNameFromDescriptor("000123")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Observation classes                                                 */
/* ------------------------------------------------------------------ */

describe("observation classes", () => {
  const of = (p: Partial<Observation>): Observation => makeObservation({ id: "obs_x", references: [], ...p });

  it("classifies transactional, join-only and context-only observations", () => {
    for (const kind of ["money_movement", "purchase_intent", "checkout", "order", "receipt", "refund_notice"] as const) {
      expect(isTransactional(of({ kind }))).toBe(true);
      expect(isContextOnly(of({ kind }))).toBe(false);
    }
    for (const kind of ["balance_snapshot", "app_context", "mandate"] as const) {
      expect(isTransactional(of({ kind }))).toBe(false);
      expect(isContextOnly(of({ kind }))).toBe(true);
    }
    const delivery = of({ kind: "delivery" });
    expect(isTransactional(delivery)).toBe(false);
    expect(isContextOnly(delivery)).toBe(false);
  });

  it("counts subscription events only when charged, invoices and bookings only when paid", () => {
    expect(isTransactional(of({ kind: "subscription_event", subscription: { event: "charged" } }))).toBe(true);
    expect(isContextOnly(of({ kind: "subscription_event", subscription: { event: "renewal_upcoming" } }))).toBe(true);
    expect(isContextOnly(of({ kind: "subscription_event", subscription: { event: "trial_ending" } }))).toBe(true);
    expect(isTransactional(of({ kind: "invoice", stage: "posted" }))).toBe(true);
    expect(isContextOnly(of({ kind: "invoice", stage: "pending" }))).toBe(true);
    expect(isTransactional(of({ kind: "booking", stage: "confirmed" }))).toBe(true);
    expect(isContextOnly(of({ kind: "booking", stage: "confirmed", amount: undefined }))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Pairwise assessment                                                 */
/* ------------------------------------------------------------------ */

describe("assessPair", () => {
  const cfg = DEFAULT_FUSION_CONFIG;
  const ledger = (id: string, p: Partial<Observation> = {}): Observation =>
    makeObservation({
      id,
      source: SRC.plaid,
      stage: "posted",
      receivedAt: T0,
      occurredAt: { value: T0, confidence: 0.9 },
      minor: 2_299,
      currency: "USD",
      merchant: { raw: "NETFLIX.COM", confidence: 0.9 },
      references: [],
      ...p,
    });
  const assess = (a: Observation, b: Observation) => assessPair(a, b, cfg, defaultMerchantMatcher);

  it("vetoes two distinct ledger ids from the same namespace, but not across namespaces", () => {
    const a = ledger("a", { references: [{ type: "provider_transaction_id", value: "tx_1", namespace: "plaid:item_1" }] });
    const b = ledger("b", {
      source: SRC.plaidDuplicateItem,
      references: [{ type: "provider_transaction_id", value: "tx_2", namespace: "plaid:item_1" }],
    });
    expect(assess(a, b)).toMatchObject({ veto: "distinct provider_transaction_id references", probability: 0, blocked: false });

    // The same account linked twice (two items) has unrelated id spaces: no veto, and it matches.
    const c = ledger("c", { source: SRC.plaidDuplicateItem, references: [{ type: "provider_transaction_id", value: "tx_9", namespace: "plaid:item_2" }] });
    const r = assess(a, c);
    expect(r.veto).toBeUndefined();
    expect(r.probability).toBeGreaterThan(cfg.linkThreshold);
  });

  it("vetoes distinct order ids and rail references", () => {
    const o1 = makeObservation({ id: "o1", source: SRC.gmail, kind: "order", references: [{ type: "order_id", value: "A-1", namespace: "shop" }] });
    const o2 = makeObservation({ id: "o2", source: SRC.gmail, kind: "order", references: [{ type: "order_id", value: "A-2", namespace: "shop" }] });
    expect(assess(o1, o2).veto).toBe("distinct order_id references");
    const r1 = makeObservation({ id: "r1", source: SRC.sms, references: [{ type: "rail_reference", value: "627712345678", namespace: "upi" }] });
    const r2 = makeObservation({ id: "r2", source: SRC.notification, references: [{ type: "rail_reference", value: "627712345679", namespace: "upi" }] });
    expect(assess(r1, r2).veto).toBe("distinct rail_reference references");
  });

  it("vetoes conflicting directions", () => {
    const debit = ledger("d");
    const credit = ledger("c", { source: SRC.plaidDuplicateItem, direction: "credit" });
    expect(assess(debit, credit).veto).toMatch(/directions conflict/);
    const refundNotice = makeObservation({ id: "rn", source: SRC.gmail, kind: "refund_notice", direction: undefined, references: [] });
    expect(assess(refundNotice, makeObservation({ id: "dm", source: SRC.sms, references: [] })).veto).toMatch(/directions conflict/);
  });

  it("vetoes different last4 on the same instrument type only", () => {
    const a = makeObservation({ id: "a", source: SRC.sms, instrument: { type: "card", last4: "1234" }, references: [] });
    const b = makeObservation({ id: "b", source: SRC.notification, instrument: { type: "card", last4: "9876" }, references: [] });
    expect(assess(a, b).veto).toMatch(/different card instruments/);
    const account = makeObservation({ id: "c", source: SRC.bank, instrument: { type: "bank_account", last4: "9876" }, references: [] });
    expect(assess(a, account).veto).toBeUndefined();
    const same = makeObservation({ id: "d", source: SRC.notification, instrument: { type: "card", last4: "1234" }, references: [] });
    expect(assess(a, same).features.map((f) => f.name)).toContain("instrument_match");
  });

  it("treats a currency mismatch without an FX bridge as a strong negative", () => {
    const inr = makeObservation({ id: "inr", source: SRC.sms, minor: 85_000, currency: "INR", merchant: { raw: "STARBUCKS", confidence: 0.9 }, references: [] });
    const usd = makeObservation({
      id: "usd",
      source: SRC.notification,
      minor: 85_000,
      currency: "USD",
      merchant: { raw: "STARBUCKS", confidence: 0.9 },
      references: [],
    });
    const mismatch = assess(inr, usd);
    expect(mismatch.features).toContainEqual(expect.objectContaining({ name: "currency_mismatch", llr: -4 }));
    expect(mismatch.probability).toBeLessThan(cfg.possibleThreshold);
    const sameCurrency = assess(inr, { ...usd, amount: { value: money(85_000, "INR"), confidence: 0.99 } });
    expect(sameCurrency.probability).toBeGreaterThan(cfg.linkThreshold);
  });

  it("bridges FX through an original-currency component", () => {
    const cardInInr = makeObservation({
      id: "card",
      source: SRC.sms,
      minor: 192_350,
      currency: "INR",
      amountBreakdown: [{ kind: "original_currency", amount: money(2_299, "USD") }],
      merchant: { raw: "NETFLIX.COM", confidence: 0.9 },
      references: [],
    });
    const usdReceipt = makeObservation({
      id: "receipt",
      source: SRC.gmail,
      kind: "receipt",
      direction: undefined,
      minor: 2_299,
      currency: "USD",
      merchant: { raw: "Netflix", name: "Netflix", confidence: 0.95 },
      references: [],
    });
    const r = assess(usdReceipt, cardInInr);
    expect(r.features).toContainEqual(expect.objectContaining({ name: "amount_exact", detail: "exact (via original USD amount)" }));
    expect(r.probability).toBeGreaterThan(cfg.linkThreshold);
  });

  it("weights a shared reference decisively and round amounts less than exact odd amounts", () => {
    const withRef = (id: string, minor: number, src = SRC.sms) =>
      makeObservation({ id, source: src, minor, references: [{ type: "rail_reference", value: "627712345678", namespace: "upi" }] });
    const shared = assess(withRef("a", 50_000), withRef("b", 50_000, SRC.notification));
    expect(shared.features[0]).toMatchObject({ name: "reference_match", llr: 9 });
    const round = assess(makeObservation({ id: "r1", source: SRC.sms, minor: 10_000, references: [] }), makeObservation({ id: "r2", source: SRC.notification, minor: 10_000, references: [] }));
    const odd = assess(makeObservation({ id: "o1", source: SRC.sms, minor: 12_345, references: [] }), makeObservation({ id: "o2", source: SRC.notification, minor: 12_345, references: [] }));
    expect(round.logOdds).toBeLessThan(odd.logOdds);
  });

  it("reports non-comparable pairs as blocked rather than vetoed", () => {
    const a = makeObservation({ id: "a", source: SRC.sms, receivedAt: T0, occurredAt: { value: T0, confidence: 0.95 }, references: [] });
    const b = makeObservation({ id: "b", source: SRC.notification, receivedAt: T0 + 5 * HOUR, occurredAt: { value: T0 + 5 * HOUR, confidence: 0.95 }, references: [] });
    const r = assess(a, b); // two real-time alerts 5h apart: outside the 2h window
    expect(r.blocked).toBe(true);
    expect(r.veto).toMatch(/^not comparable/);
    expect(r.probability).toBe(0);
    expect(assess(a, makeObservation({ id: "bal", kind: "balance_snapshot", references: [] })).veto).toMatch(/context-only/);
  });
});

/* ------------------------------------------------------------------ */
/* Idempotency and determinism                                         */
/* ------------------------------------------------------------------ */

describe("idempotency and determinism", () => {
  it("treats a re-delivered observation id as a no-op", () => {
    const { engine } = newEngine();
    const { alert, order } = amazonPurchase();
    const first = engine.ingest(alert);
    engine.ingest(order);
    const before = json(engine.listCandidates());
    const again = engine.ingest(alert);
    expect(again).toEqual({ observationId: "obs_alert", outcome: "duplicate_delivery", candidateId: first.candidateId, possibleMatches: [] });
    expect(json(engine.listCandidates())).toBe(before);

    const balance = makeObservation({ id: "obs_balance", kind: "balance_snapshot", references: [] });
    engine.ingest(balance);
    expect(engine.ingest(balance)).toEqual({ observationId: "obs_balance", outcome: "duplicate_delivery", possibleMatches: [] });
    expect(engine.contextObservations()).toHaveLength(1);
  });

  it("gives identical decisions, candidate ids and JSON for the same input order", () => {
    const run = () => {
      const { engine } = newEngine();
      const { alert, order, pending } = amazonPurchase();
      const decisions = ingestAll(engine, [alert, order, pending]);
      return { decisions: json(decisions), candidates: json(engine.listCandidates()), snapshot: json(engine.snapshot()) };
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    const { engine } = newEngine();
    const { alert } = amazonPurchase();
    expect(engine.ingest(alert).candidateId).toBe(stableId("cand", "obs_alert"));
  });
});

/* ------------------------------------------------------------------ */
/* User assertions                                                     */
/* ------------------------------------------------------------------ */

describe("user assertions", () => {
  it("same_event forces a merge the scores would not make", () => {
    const { engine } = newEngine();
    const { alert } = amazonPurchase();
    // OCR'd receipt photo with a misread total.
    const photo = makeObservation({
      id: "obs_photo",
      source: SRC.receiptPhoto,
      kind: "receipt",
      direction: undefined,
      receivedAt: T0 + 2 * HOUR,
      minor: 118_000,
      merchant: { raw: "AMAZ0N", confidence: 0.4 },
      references: [],
    });
    const a = engine.ingest(alert);
    const p = engine.ingest(photo);
    expect(p.candidateId).not.toBe(a.candidateId);
    expect(engine.listCandidates()).toHaveLength(2);

    const affected = engine.applyAssertion(assertion("same_event", ["obs_alert", "obs_photo"]));
    expect(affected).toEqual(expect.arrayContaining([a.candidateId, p.candidateId]));
    expect(engine.listCandidates()).toHaveLength(1);
    const merged = engine.findCandidateByObservation("obs_photo")!;
    expect(merged.id).toBe(a.candidateId);
    expect(merged.sourceSignals.map((s) => s.observationId)).toEqual(["obs_alert", "obs_photo"]);
    expect(merged.amount?.value.minor).toBe(124_900); // the alert outranks the OCR total
    expect(engine.getCandidate(p.candidateId!)).toBeUndefined();
  });

  it("different_events forbids and undoes a merge by re-fusing the affected observations", () => {
    const { engine } = newEngine();
    const { alert, order } = amazonPurchase();
    ingestAll(engine, [alert, order]);
    expect(engine.listCandidates()).toHaveLength(1);

    engine.applyAssertion(assertion("different_events", ["obs_alert", "obs_order"]));
    expect(engine.listCandidates()).toHaveLength(2);
    expect(engine.findCandidateByObservation("obs_order")?.id).toBe(stableId("cand", "obs_order"));
    expect(engine.assess(order, stableId("cand", "obs_alert")).veto).toBe("user asserted these are different events");

    // A later same_event about the same pair overrides it.
    engine.applyAssertion(assertion("same_event", ["obs_alert", "obs_order"]));
    expect(engine.listCandidates()).toHaveLength(1);
  });

  it("dismiss hides the candidate from listCandidates and stops it absorbing later observations", () => {
    const { engine } = newEngine();
    const { alert, order } = amazonPurchase();
    const a = engine.ingest(alert);
    engine.applyAssertion(assertion("dismiss", ["obs_alert"], { reason: "not_mine", at: T0 + 30 * SECOND_MS }));
    expect(engine.listCandidates()).toEqual([]);
    expect(engine.getCandidate(a.candidateId!)).toBeDefined();
    const d = engine.ingest(order); // received after the dismissal
    expect(d.outcome).toBe("created");
    expect(engine.listCandidates().map((c) => c.id)).toEqual([d.candidateId]);
  });

  it("confirm marks the candidate user-verified with confidence 1", () => {
    const { engine } = newEngine();
    const { candidateId } = engine.ingest(amazonPurchase().alert);
    expect(engine.getCandidate(candidateId!)!.confidence).toBeLessThan(1);
    expect(engine.applyAssertion(assertion("confirm", ["obs_alert"]))).toEqual([candidateId]);
    expect(engine.getCandidate(candidateId!)).toMatchObject({ userVerified: true, confidence: 1 });
  });

  it("labels set user inferences that always win over intelligence patches", () => {
    const { engine } = newEngine();
    const { candidateId } = engine.ingest(amazonPurchase().alert);
    engine.applyAssertion(assertion("label", ["obs_alert"], { field: "category", value: "shopping.electronics" }));
    engine.applyAssertion(assertion("label", ["obs_alert"], { field: "transaction_type", value: "transfer", transferKind: "own_account" }));
    engine.applyAssertion(assertion("label", ["obs_alert"], { field: "essentiality", value: "discretionary" }));
    engine.applyAssertion(assertion("label", ["obs_alert"], { field: "ownership", value: "business" }));
    engine.applyAssertion(assertion("satisfaction", ["obs_alert"], { value: "worth_it", askedAt: T0 + DAY, at: T0 + DAY + HOUR }));

    const patched = engine.patchCandidate(candidateId!, {
      category: { value: "household", confidence: 0.8, alternatives: [], basis: ["merchant_profile"], userSet: false },
      transactionType: { value: "purchase", confidence: 0.9, alternatives: [], basis: ["merchant_profile"], userSet: false },
      transferKind: "family",
      attributes: { essentiality: { value: "essential", confidence: 0.7, alternatives: [], basis: ["prior"], userSet: false } },
    });
    expect(patched.category).toEqual(userInference("shopping.electronics"));
    expect(patched.transactionType).toEqual(userInference("transfer"));
    expect(patched.transferKind).toBe("own_account");
    expect(patched.attributes.essentiality).toEqual(userInference("discretionary"));
    expect(patched.attributes.ownership).toEqual(userInference("business"));
    expect(patched.attributes.satisfaction).toEqual({ value: "worth_it", askedAt: T0 + DAY, answeredAt: T0 + DAY + HOUR });
    expect(patched.provenance).toContainEqual({ field: "category", method: "user", observationIds: ["obs_alert"], note: "label:category" });
    expect(patched.updatedAt).toBe(T0 + DAY + HOUR);
  });

  it("assertions survive removeObservations rebuilds because they are anchored to observation ids", () => {
    const { engine } = newEngine();
    const { alert, order, pending } = amazonPurchase();
    ingestAll(engine, [alert, order, pending]);
    engine.applyAssertion(assertion("label", ["obs_alert", "obs_order"], { field: "category", value: "shopping.electronics" }));
    engine.applyAssertion(assertion("confirm", ["obs_order"]));

    engine.removeObservations((o) => o.source.connectionId === SRC.notification.connectionId);
    const c = engine.findCandidateByObservation("obs_order")!;
    expect(c.category).toEqual(userInference("shopping.electronics"));
    expect(c.userVerified).toBe(true);
    expect(engine.assertions()).toHaveLength(2);

    // A label anchored only to removed evidence stops applying, is kept, and comes back on reconnect.
    engine.applyAssertion(assertion("label", ["obs_pending"], { field: "ownership", value: "family" }));
    expect(engine.findCandidateByObservation("obs_order")!.attributes.ownership).toEqual(userInference("family"));
    engine.removeObservations((o) => o.id === "obs_pending");
    expect(engine.findCandidateByObservation("obs_order")!.attributes.ownership.userSet).toBe(false);
    expect(engine.assertions()).toHaveLength(3);
    engine.ingest(pending); // the source reconnects and re-delivers the same stable observation id
    expect(engine.findCandidateByObservation("obs_order")!.attributes.ownership).toEqual(userInference("family"));
  });
});

/* ------------------------------------------------------------------ */
/* Removal (source disconnect)                                         */
/* ------------------------------------------------------------------ */

describe("removeObservations", () => {
  it("recomputes affected candidates from the remaining evidence only", () => {
    const { engine } = newEngine();
    const { alert, order, pending } = amazonPurchase();
    const [a] = ingestAll(engine, [alert, order, pending]);
    expect(engine.getCandidate(a!.candidateId!)!.amount?.value.minor).toBe(124_900);

    const result = engine.removeObservations((o) => o.source.connectionId === SRC.bank.connectionId);
    expect(result).toEqual({ removedObservationIds: ["obs_pending"], deletedCandidateIds: [], updatedCandidateIds: [a!.candidateId] });
    const c = engine.getCandidate(a!.candidateId!)!;
    expect(c.sourceSignals.map((s) => s.observationId)).toEqual(["obs_alert", "obs_order"]);
    expect(c.references).toEqual([ORDER_REF]);
    expect(c.merchant.raw).toBe("AMAZON");
    expect(c.provenance.find((p) => p.field === "amount")?.observationIds).toEqual(["obs_alert", "obs_order"]);

    // Deterministic: identical to an engine that only ever saw the remaining observations.
    const fresh = newEngine().engine;
    ingestAll(fresh, [alert, order]);
    expect(json(engine.listCandidates())).toBe(json(fresh.listCandidates()));
  });

  it("deletes candidates with no remaining observations and re-founds those that lost their founder", () => {
    const { engine } = newEngine();
    const { alert, order, pending } = amazonPurchase();
    const coffee = makeObservation({ id: "obs_coffee", source: SRC.sms, receivedAt: T0 + 3 * HOUR, minor: 25_000, merchant: { raw: "CCD", confidence: 0.8 }, references: [] });
    ingestAll(engine, [alert, order, pending, coffee]);
    const patched = engine.patchCandidate(stableId("cand", "obs_alert"), { category: { value: "shopping", confidence: 0.6, alternatives: [], basis: ["merchant_profile"], userSet: false } });

    const r1 = engine.removeObservations((o) => o.id === "obs_coffee");
    expect(r1.deletedCandidateIds).toEqual([stableId("cand", "obs_coffee")]);
    expect(r1.updatedCandidateIds).toEqual([]);

    const r2 = engine.removeObservations((o) => o.source.connectionId === SRC.notification.connectionId);
    expect(r2.deletedCandidateIds).toEqual([patched.id]);
    expect(r2.updatedCandidateIds).toEqual([stableId("cand", "obs_order")]);
    // The intelligence patch followed the evidence to the re-founded candidate.
    expect(engine.getCandidate(stableId("cand", "obs_order"))!.category.value).toBe("shopping");
    expect(engine.snapshot().patches.map((p) => p.anchor)).toEqual(["obs_order"]);

    expect(engine.removeObservations(() => false)).toEqual({ removedObservationIds: [], deletedCandidateIds: [], updatedCandidateIds: [] });
    engine.removeObservations(() => true);
    expect(engine.listCandidates()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Intelligence patches                                                */
/* ------------------------------------------------------------------ */

describe("patchCandidate", () => {
  const inf = <T extends string>(value: T, confidence: number): Inference<T> => ({ value, confidence, alternatives: [], basis: ["merchant_profile"], userSet: false });

  it("stores intelligence-owned fields and keeps them across later fact updates", () => {
    const { engine } = newEngine();
    const { alert, order, pending } = amazonPurchase();
    const { candidateId } = engine.ingest(alert);
    const refundLink: CandidateLink = { kind: "refunded_by", target: "cand_refund", probability: 0.92, createdAt: T0 + 5 * DAY };
    engine.patchCandidate(candidateId!, {
      category: inf("shopping.electronics", 0.7),
      transactionType: inf("transfer", 0.6),
      transferKind: "wallet_load",
      attributes: { essentiality: inf("discretionary", 0.6) },
      merchantNormalized: { key: "wd:Q3884", displayName: "Amazon", confidence: 0.97 },
      links: [refundLink],
      status: "refunded",
      intentOutcome: "purchased",
    });

    ingestAll(engine, [order, pending]); // later facts arrive
    const c = engine.getCandidate(candidateId!)!;
    expect(c.sourceSignals).toHaveLength(3);
    expect(c.category).toEqual(inf("shopping.electronics", 0.7));
    expect(c.transactionType.value).toBe("transfer");
    expect(c.transferKind).toBe("wallet_load");
    expect(c.attributes.essentiality.value).toBe("discretionary");
    expect(c.merchant).toMatchObject({ normalized: "wd:Q3884", displayName: "Amazon", confidence: 0.97, raw: "AMZN PAY INDIA" });
    expect(c.links).toEqual([refundLink]);
    expect(c.status).toBe("refunded");
    expect(c.intentOutcome).toBe("purchased");

    // Re-patching replaces fields; links of the patched kind are replaced, others kept.
    const series: CandidateLink = { kind: "recurring_series", target: "series_amazon", probability: 0.7, createdAt: T0 + 6 * DAY };
    const refundLink2 = { ...refundLink, target: "cand_refund_2" };
    const again = engine.patchCandidate(candidateId!, { category: inf("household", 0.55), links: [series] });
    expect(again.category.value).toBe("household");
    expect(again.links).toEqual([refundLink, series]);
    expect(engine.patchCandidate(candidateId!, { links: [refundLink2] }).links).toEqual([series, refundLink2]);
  });

  it("never overwrites a user-set inference", () => {
    const { engine } = newEngine();
    const { candidateId } = engine.ingest(amazonPurchase().alert);
    engine.applyAssertion(assertion("label", ["obs_alert"], { field: "category", value: "gifts" }));
    const c = engine.patchCandidate(candidateId!, { category: inf("shopping", 0.99) });
    expect(c.category).toEqual(userInference("gifts"));
    expect(() => engine.patchCandidate("cand_missing", {})).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ */
/* Seeding from observation hints                                      */
/* ------------------------------------------------------------------ */

describe("seeded inferences", () => {
  it("seeds transaction type from type hints: best as value, others as alternatives, basis source_hint", () => {
    const { engine } = newEngine();
    const { candidateId } = engine.ingest(
      makeObservation({
        id: "obs_hinted",
        source: SRC.plaid,
        stage: "posted",
        minor: 5_000_000,
        currency: "USD",
        references: [],
        typeHints: [
          { type: "transfer", transferKind: "own_account", confidence: 0.6, reason: "plaid_pfc:TRANSFER_OUT" },
          { type: "investment", confidence: 0.25, reason: "keyword:brokerage" },
        ],
        categoryHints: [
          { scheme: "mcc", value: "6211", confidence: 0.9 },
          { scheme: "brake", value: "fees", confidence: 0.3 },
        ],
      }),
    );
    const c = engine.getCandidate(candidateId!)!;
    expect(c.transactionType).toEqual({
      value: "transfer",
      confidence: 0.6,
      alternatives: [{ value: "investment", probability: 0.25 }],
      basis: ["source_hint"],
      userSet: false,
    });
    expect(c.transferKind).toBe("own_account");
    // Only BRAKE-scheme category hints seed the category; MCC mapping is the intelligence layer's job.
    expect(c.category).toMatchObject({ value: "fees", confidence: 0.3, alternatives: [], basis: ["source_hint"] });
    expect(c.provenance).toContainEqual({ field: "transaction_type", method: "inferred", observationIds: ["obs_hinted"], note: "source_hint" });
  });

  it("normalises hint mass above 1 and combines hints across observations", () => {
    const { engine } = newEngine();
    const { alert, order } = amazonPurchase();
    engine.ingest({ ...alert, typeHints: [{ type: "purchase", confidence: 0.9, reason: "sms:spent" }] });
    const d = engine.ingest({ ...order, typeHints: [{ type: "business_expense", confidence: 0.6, reason: "keyword:gst-invoice" }] });
    const t = engine.getCandidate(d.candidateId!)!.transactionType;
    expect(t.value).toBe("purchase");
    expect(t.confidence).toBeCloseTo(0.6, 6);
    expect(t.alternatives).toEqual([{ value: "business_expense", probability: expect.closeTo(0.4, 6) }]);
  });

  it("falls back to explicitly uninformed inferences", () => {
    const { engine } = newEngine();
    const c = engine.getCandidate(engine.ingest(amazonPurchase().alert).candidateId!)!;
    expect(c.transactionType).toEqual({ value: "unknown", confidence: 0, alternatives: [], basis: ["none"], userSet: false });
    expect(c.category).toEqual({ value: "uncategorized", confidence: 0, alternatives: [], basis: ["none"], userSet: false });
  });
});

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

describe("snapshot", () => {
  it("round-trips: a new engine fed the snapshot reproduces the same candidates", () => {
    const { engine } = newEngine();
    const { alert, order, pending } = amazonPurchase();
    const photo = makeObservation({ id: "obs_photo", source: SRC.receiptPhoto, kind: "receipt", direction: undefined, receivedAt: T0 + 2 * HOUR, minor: 9_900, references: [] });
    const balance = makeObservation({ id: "obs_balance", source: SRC.bank, kind: "balance_snapshot", references: [] });
    ingestAll(engine, [alert, order, pending, photo, balance]);
    engine.applyAssertion(assertion("different_events", ["obs_alert", "obs_pending"]));
    engine.applyAssertion(assertion("label", ["obs_order"], { field: "category", value: "shopping.electronics" }));
    engine.patchCandidate(engine.findCandidateByObservation("obs_photo")!.id, {
      category: { value: "groceries", confidence: 0.5, alternatives: [], basis: ["line_items"], userSet: false },
    });

    const snap = JSON.parse(json(engine.snapshot())) as ReturnType<FusionEngine["snapshot"]>;
    expect(snap.version).toBe(1);
    expect(snap.observations).toHaveLength(5);

    const restored = restoreFusionEngine(snap, { clock: fixedClock(T0 + HOUR) });
    expect(json(restored.listCandidates())).toBe(json(engine.listCandidates()));
    expect(json(restored.contextObservations())).toBe(json(engine.contextObservations()));

    // The same through the public API.
    const replay = newEngine().engine;
    for (const o of snap.observations) replay.ingest(o);
    for (const a of snap.assertions) replay.applyAssertion(a);
    for (const { anchor, patch } of snap.patches) replay.patchCandidate(replay.findCandidateByObservation(anchor)!.id, patch);
    expect(json(replay.listCandidates())).toBe(json(engine.listCandidates()));
    expect(json(replay.snapshot())).toBe(json(snap));
    expect(() => restoreFusionEngine({ ...snap, version: 2 as 1 }, { clock: fixedClock(T0) })).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ */
/* Performance: blocking, not O(n²)                                    */
/* ------------------------------------------------------------------ */

describe("performance", () => {
  /** Deterministic LCG so the workload is identical on every run. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 2 ** 32;
    };
  }

  const MERCHANTS = ["Swiggy", "Amazon", "Starbucks", "Carrefour", "Padaria Real", "Naivas", "Uber", "Lidl", "Pão de Açúcar", "Java House"];
  const CURRENCIES = ["INR", "USD", "EUR", "BRL", "KES"];

  /** ~5,000 observations: every event has an alert, most a ledger entry, some an email receipt. */
  function workload(): { observations: Observation[]; events: number } {
    const rand = lcg(42);
    const observations: Observation[] = [];
    let events = 0;
    while (observations.length < 5_000) {
      const i = events++;
      const currency = CURRENCIES[i % CURRENCIES.length]!;
      const merchant = MERCHANTS[Math.floor(rand() * MERCHANTS.length)]!;
      const at = T0 - 365 * DAY + Math.floor(rand() * 365 * DAY);
      const minor = 1_000 + i * 37 + Math.floor(rand() * 30); // unique per event
      const base = { minor, currency, references: [], merchant: { raw: merchant.toUpperCase(), confidence: 0.8 } };
      observations.push(makeObservation({ ...base, id: `perf_alert_${i}`, source: SRC.sms, receivedAt: at, occurredAt: { value: at, confidence: 0.95 } }));
      if (rand() < 0.7) {
        observations.push(
          makeObservation({
            ...base,
            id: `perf_ledger_${i}`,
            source: SRC.bank,
            stage: "posted",
            receivedAt: at + DAY,
            occurredAt: { value: at, confidence: 0.4 },
            references: [{ type: "provider_transaction_id", value: `L${i}`, namespace: "bank:perf" }],
          }),
        );
      }
      if (rand() < 0.3) {
        observations.push(
          makeObservation({
            ...base,
            id: `perf_receipt_${i}`,
            source: SRC.gmail,
            kind: "receipt",
            direction: undefined,
            receivedAt: at + 5 * MINUTE,
            occurredAt: { value: at, confidence: 0.9 },
            merchant: { raw: merchant, name: merchant, confidence: 0.9 },
          }),
        );
      }
    }
    return { observations: observations.slice(0, 5_000), events };
  }

  it("ingests 5,000 observations well under 2 seconds using indexed blocking", () => {
    const { observations } = workload();
    let comparisons = 0;
    const counting: MerchantMatcher = {
      key: (m) => defaultMerchantMatcher.key(m),
      similarity: (a, b) => {
        comparisons += 1;
        return defaultMerchantMatcher.similarity(a, b);
      },
    };
    const { engine } = newEngine(T0, counting);
    const started = performance.now();
    for (const o of observations) engine.ingest(o);
    const elapsed = performance.now() - started;

    const eventIds = new Set(observations.map((o) => o.id.replace(/^perf_(alert|ledger|receipt)_/, "")));
    expect(engine.listCandidates()).toHaveLength(eventIds.size);
    expect(elapsed).toBeLessThan(2_000);
    // Each observation is compared with a handful of nearby candidates, not with all history.
    expect(comparisons).toBeLessThan(observations.length * 10);
  });
});
