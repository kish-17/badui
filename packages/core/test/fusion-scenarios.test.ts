import { describe, expect, it } from "vitest";
import { T0, makeObservation, makeSource } from "@brake/core/testing";
import { createFusionEngine } from "../src/fusion/engine";
import type { TransactionCandidate } from "../src/model/candidate";
import { money } from "../src/model/money";
import type { Observation } from "../src/model/observation";
import { DAY, HOUR, MINUTE, fixedClock } from "../src/model/primitives";
import type { SourceRef } from "../src/model/source";

/**
 * What a probability-weighted spending total sees, mirroring the rule in
 * intelligence/spending: an enrichment-only candidate that carries a
 * possible_duplicate link is excluded; everything else counts in proportion
 * to its confidence. Fusion is responsible for making this total right.
 */
function expectedMinor(candidates: readonly TransactionCandidate[]): number {
  let total = 0;
  for (const c of candidates) {
    const paymentBacked = c.sourceSignals.some((s) => s.kind === "money_movement");
    const flagged = c.links.some((l) => l.kind === "possible_duplicate" && l.probability >= 0.5);
    if (!paymentBacked && flagged) continue;
    total += (c.amount?.value.minor ?? 0) * c.confidence;
  }
  return total;
}

/**
 * End-to-end fusion scenarios with realistic, multi-country observations.
 * The engine never sees which provider produced them: only normalized fields.
 */

/** Wall-clock helper for the brief's morning: T0 is 10:41 IST on 2026-10-04. */
const ist = (h: number, m: number): number => T0 + ((h - 10) * 60 + (m - 41)) * MINUTE;

const SRC = {
  hdfcNotification: makeSource({
    adapterId: "android-notification",
    kind: "notification",
    connectionId: "conn_notification_listener",
    provider: "HDFC Bank",
    label: "HDFC Bank transaction notification",
  }),
  hdfcSms: makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_sms", provider: "HDFC Bank", label: "HDFC Bank SMS alert" }),
  gmail: makeSource({ adapterId: "gmail", kind: "email", connectionId: "conn_gmail", label: "Gmail inbox" }),
  bankApi: makeSource({ adapterId: "bank-api", kind: "open_banking", connectionId: "conn_bank_api", provider: "HDFC Bank", label: "HDFC Bank account data" }),
  aa: makeSource({ adapterId: "account-aggregator", kind: "account_aggregator", connectionId: "conn_aa", provider: "HDFC Bank", label: "HDFC account via Account Aggregator" }),
  plaid: makeSource({ adapterId: "plaid", kind: "open_banking", connectionId: "conn_plaid_item1", provider: "Chase", label: "Chase account via Plaid" }),
  cardFeed: makeSource({ adapterId: "card-feed", kind: "issuer_webhook", connectionId: "conn_card", provider: "Chase", label: "Chase card alerts" }),
  manual: makeSource({ adapterId: "manual", kind: "manual", connectionId: "conn_manual", label: "Should I buy this? check" }),
  nubankNotification: makeSource({
    adapterId: "android-notification",
    kind: "notification",
    connectionId: "conn_notification_listener",
    provider: "Nubank",
    label: "Nubank notification",
  }),
  openFinance: makeSource({ adapterId: "open-finance-br", kind: "open_banking", connectionId: "conn_ofb", provider: "Nubank", label: "Nubank account via Open Finance" }),
  receiptShare: makeSource({ adapterId: "share", kind: "share", connectionId: "conn_share", label: "shared payment receipt" }),
  mpesaSms: makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_sms_ke", provider: "M-PESA", label: "M-PESA SMS" }),
  mpesaStatement: makeSource({ adapterId: "mpesa-statement", kind: "wallet_history", connectionId: "conn_mpesa", provider: "M-PESA", label: "M-PESA statement" }),
  revolut: makeSource({ adapterId: "obie", kind: "open_banking", connectionId: "conn_revolut", provider: "Revolut", label: "Revolut account via open banking" }),
} satisfies Record<string, SourceRef>;

function engineAt(now: number) {
  const clock = fixedClock(now);
  return { clock, engine: createFusionEngine({ clock }) };
}

/* ------------------------------------------------------------------ */
/* The brief's four-observation example                                */
/* ------------------------------------------------------------------ */

const ORDER_ID = { type: "order_id" as const, value: "402-8812345-1234567", namespace: "amazon" };

function briefObservations(): Observation[] {
  const alert = makeObservation({
    id: "obs_notification_1041",
    source: SRC.hdfcNotification,
    stage: "confirmed",
    receivedAt: ist(10, 41),
    occurredAt: { value: ist(10, 41), confidence: 0.95 },
    minor: 124_900,
    currency: "INR",
    merchant: { raw: "AMAZON", confidence: 0.8 },
    instrument: { type: "card", issuer: "HDFC Bank", last4: "1234", cardKind: "credit" },
    rail: { family: "card", scheme: "visa" },
    country: "IN",
    references: [],
    confidence: 0.95,
    evidence: { summary: "HDFC Bank notification: ₹1,249.00 spent on card ••1234 at AMAZON" },
  });
  const orderConfirmation = makeObservation({
    id: "obs_gmail_order_1042",
    source: SRC.gmail,
    kind: "order",
    stage: "confirmed",
    direction: undefined,
    receivedAt: ist(10, 42),
    occurredAt: { value: ist(10, 42), confidence: 0.9 },
    minor: 124_900,
    currency: "INR",
    merchant: { raw: "Amazon.in", name: "Amazon", website: "amazon.in", channel: "online", confidence: 0.9 },
    references: [ORDER_ID],
    confidence: 0.9,
    evidence: { summary: "Amazon order confirmation, total ₹1,249.00" },
  });
  const pendingLedger = makeObservation({
    id: "obs_bank_pending_1043",
    source: SRC.bankApi,
    stage: "pending",
    receivedAt: ist(10, 43),
    occurredAt: { value: ist(10, 41), confidence: 0.6 },
    minor: 124_900,
    currency: "INR",
    merchant: { raw: "AMZN PAY INDIA", confidence: 0.7 },
    instrument: { type: "bank_account", last4: "7890", accountRef: "acc_7890" },
    references: [{ type: "provider_transaction_id", value: "TXN-88213", namespace: "bank:hdfc:acc_7890" }],
    confidence: 0.97,
    evidence: { summary: "HDFC Bank pending transaction ₹1,249.00 AMZN PAY INDIA" },
  });
  const itemsEmail = makeObservation({
    id: "obs_gmail_items_1047",
    source: SRC.gmail,
    kind: "order",
    stage: "confirmed",
    direction: undefined,
    receivedAt: ist(10, 47),
    occurredAt: { value: ist(10, 47), confidence: 0.9 },
    amount: undefined,
    merchant: { raw: "Amazon.in", name: "Amazon", confidence: 0.9 },
    lineItems: [{ description: "boAt Rockerz 450 wireless headphones", quantity: 1, total: money(124_900, "INR") }],
    references: [ORDER_ID],
    confidence: 0.9,
    evidence: { summary: "Amazon order #402-8812345-1234567 contains headphones" },
  });
  return [alert, orderConfirmation, pendingLedger, itemsEmail];
}

describe("the brief's scenario: four observations of one ₹1,249 Amazon purchase", () => {
  it("fuses notification, order email, pending ledger entry and item email into exactly one candidate", () => {
    const { engine } = engineAt(ist(11, 0));
    const decisions = briefObservations().map((o) => engine.ingest(o));

    expect(decisions.map((d) => d.outcome)).toEqual(["created", "linked", "linked", "linked"]);
    const all = engine.listCandidates();
    expect(all).toHaveLength(1);
    const c = all[0]!;
    expect(decisions.every((d) => d.candidateId === c.id)).toBe(true);

    // Status: the 10:41 alert confirms the debit although the ledger is still pending.
    expect(c.status).toBe("confirmed");
    expect(c.statusHistory.map((h) => h.status)).toEqual(["confirmed"]);
    expect(c.timestampConfirmed).toBe(ist(10, 41));
    expect(c.timestampEstimated).toBe(ist(10, 41));

    // Amount comes from the ledger source; three independent sources agree.
    expect(c.amount?.value).toEqual(money(124_900, "INR"));
    expect(c.amount?.confidence).toBeGreaterThan(0.99);
    const amountProv = c.provenance.find((p) => p.field === "amount")!;
    expect(amountProv.observationIds[0]).toBe("obs_bank_pending_1043");
    expect(amountProv.method).toBe("fused");
    expect(amountProv.note).toBe("pending ledger amount");

    // Merchant: human name from the order, descriptor from the ledger.
    expect(c.merchant.displayName).toBe("Amazon");
    expect(c.merchant.normalized).toBe("amazon");
    expect(c.merchant.raw).toBe("AMZN PAY INDIA");
    expect(c.merchant.channel).toBe("online");
    const merchantProv = c.provenance.find((p) => p.field === "merchant")!;
    expect(merchantProv.observationIds).toContain("obs_gmail_order_1042");
    expect(merchantProv.note).toMatch(/display name from order/);

    expect(c.provenance.find((p) => p.field === "status")).toMatchObject({ note: "furthest lifecycle stage" });

    // Line items from the merchant email.
    expect(c.lineItems.map((i) => i.description)).toEqual(["boAt Rockerz 450 wireless headphones"]);

    // Every observation is kept as a source signal with a role.
    expect(c.sourceSignals.map((s) => [s.observationId, s.role])).toEqual([
      ["obs_notification_1041", "primary"],
      ["obs_gmail_order_1042", "enriching"],
      ["obs_bank_pending_1043", "corroborating"],
      ["obs_gmail_items_1047", "enriching"],
    ]);
    expect(c.sourceSignals[0]!.matchProbability).toBe(1);
    expect(c.sourceSignals.slice(1).every((s) => s.matchProbability >= 0.9)).toBe(true);
    expect(c.sourceSignals[2]!.sourceLabel).toBe("HDFC Bank account data");

    // References are unioned and de-duplicated.
    expect(c.references).toEqual([ORDER_ID, { type: "provider_transaction_id", value: "TXN-88213", namespace: "bank:hdfc:acc_7890" }]);

    expect(c.confidence).toBeGreaterThan(0.95);
    expect(c.direction).toBe("debit");
    expect(c.instrument).toMatchObject({ type: "card", last4: "1234" });
    expect(c.paymentRail).toEqual({ family: "card", scheme: "visa" });
    expect(c.country).toBe("IN");
    expect(engine.observationsOf(c.id).map((o) => o.id)).toHaveLength(4);
  });

  it("reaches the same single candidate whatever order the signals arrive in", () => {
    const [alert, order, pending, items] = briefObservations();
    const { engine } = engineAt(ist(11, 0));
    for (const o of [items!, order!, pending!, alert!]) engine.ingest(o);
    const all = engine.listCandidates();
    expect(all).toHaveLength(1);
    const c = all[0]!;
    expect(c.status).toBe("confirmed");
    expect(c.amount?.value.minor).toBe(124_900);
    expect(c.merchant.displayName).toBe("Amazon");
    expect(c.lineItems).toHaveLength(1);
    // The first money movement is primary even though an email founded the candidate.
    expect(c.sourceSignals.find((s) => s.role === "primary")?.observationId).toBe("obs_bank_pending_1043");
  });

  it("becomes posted when the ledger posts, and the posted amount wins", () => {
    const { engine } = engineAt(ist(11, 0) + 2 * DAY);
    for (const o of briefObservations()) engine.ingest(o);
    const posted = makeObservation({
      id: "obs_bank_posted",
      source: SRC.bankApi,
      stage: "posted",
      receivedAt: ist(10, 41) + 2 * DAY,
      occurredAt: { value: ist(10, 41), confidence: 0.6 },
      minor: 124_900,
      merchant: { raw: "AMZN PAY INDIA", confidence: 0.7 },
      instrument: { type: "bank_account", last4: "7890", accountRef: "acc_7890" },
      references: [{ type: "provider_transaction_id", value: "TXN-88213", namespace: "bank:hdfc:acc_7890" }],
      confidence: 0.98,
    });
    expect(engine.ingest(posted).outcome).toBe("linked");
    const c = engine.listCandidates()[0]!;
    expect(engine.listCandidates()).toHaveLength(1);
    expect(c.status).toBe("posted");
    expect(c.statusHistory.map((h) => h.status)).toEqual(["confirmed", "posted"]);
    expect(c.sourceSignals.find((s) => s.observationId === "obs_bank_posted")?.role).toBe("lifecycle");
    expect(c.provenance.find((p) => p.field === "amount")?.note).toBe("posted amount supersedes pending");
  });
});

/* ------------------------------------------------------------------ */
/* Same-connection veto and ambiguity                                  */
/* ------------------------------------------------------------------ */

describe("conservative merging", () => {
  const coffee = (id: string, minute: number, extra: Partial<Observation> = {}): Observation =>
    makeObservation({
      id,
      source: SRC.aa,
      stage: "posted",
      receivedAt: T0 + 3 * HOUR,
      occurredAt: { value: T0 + minute * MINUTE, confidence: 0.9 },
      minor: 10_000,
      currency: "INR",
      merchant: { raw: "UPI/THIRD WAVE COFFEE/thirdwave@ybl", handle: "thirdwave@ybl", confidence: 0.85 },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      references: [],
      ...extra,
    });

  it("keeps two genuine ₹100 coffees 20 minutes apart from the same ledger connection apart", () => {
    const { engine } = engineAt(T0 + DAY);
    const first = engine.ingest(coffee("obs_coffee_1", 0, { references: [{ type: "provider_transaction_id", value: "AA-1", namespace: "aa:hdfc:acc" }] }));
    const second = engine.ingest(coffee("obs_coffee_2", 20, { references: [{ type: "provider_transaction_id", value: "AA-2", namespace: "aa:hdfc:acc" }] }));
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    expect(engine.listCandidates()).toHaveLength(2);
    expect(engine.assess(coffee("obs_probe", 20), first.candidateId!).veto).toMatch(/same source/);
  });

  it("keeps them apart on the same-connection veto alone, without any ledger ids", () => {
    const { engine } = engineAt(T0 + DAY);
    engine.ingest(coffee("obs_coffee_a", 0));
    const d = engine.ingest(coffee("obs_coffee_b", 20));
    expect(d.outcome).toBe("created");
    expect(d.possibleMatches).toEqual([]);
    expect(engine.listCandidates()).toHaveLength(2);
  });

  it("does not merge one ₹100 receipt into either of two matching ₹100 card charges", () => {
    const { engine } = engineAt(T0 + DAY);
    const charge = (id: string, minute: number, ref: string): Observation =>
      makeObservation({
        id,
        source: SRC.cardFeed,
        stage: "confirmed",
        receivedAt: T0 + minute * MINUTE,
        occurredAt: { value: T0 + minute * MINUTE, confidence: 0.95 },
        minor: 10_000,
        currency: "INR",
        merchant: { raw: "BLUE TOKAI COFFEE ROASTERS", confidence: 0.85 },
        instrument: { type: "card", last4: "4321" },
        references: [{ type: "rail_reference", value: ref, namespace: "visa" }],
      });
    const c1 = engine.ingest(charge("obs_charge_1", 0, "VISA-77001"));
    const c2 = engine.ingest(charge("obs_charge_2", 20, "VISA-77002"));
    const receipt = makeObservation({
      id: "obs_receipt_email",
      source: SRC.gmail,
      kind: "receipt",
      stage: "confirmed",
      direction: undefined,
      receivedAt: T0 + 30 * MINUTE,
      occurredAt: { value: T0 + 10 * MINUTE, confidence: 0.8 },
      minor: 10_000,
      currency: "INR",
      merchant: { raw: "Blue Tokai Coffee", name: "Blue Tokai Coffee", confidence: 0.9 },
      references: [],
    });
    const d = engine.ingest(receipt);

    expect(d.outcome).toBe("ambiguous");
    expect(d.candidateId).toBeDefined();
    expect(d.candidateId).not.toBe(c1.candidateId);
    expect(d.candidateId).not.toBe(c2.candidateId);
    expect(d.possibleMatches.map((m) => m.candidateId).sort()).toEqual([c1.candidateId, c2.candidateId].sort());
    expect(engine.listCandidates()).toHaveLength(3);

    const own = engine.getCandidate(d.candidateId!)!;
    const dupes = own.links.filter((l) => l.kind === "possible_duplicate");
    expect(dupes.map((l) => l.target).sort()).toEqual([c1.candidateId, c2.candidateId].sort());
    expect(dupes.every((l) => l.probability >= 0.5)).toBe(true);
    // The charges themselves were left untouched.
    expect(engine.getCandidate(c1.candidateId!)!.sourceSignals).toHaveLength(1);
    expect(engine.getCandidate(c2.candidateId!)!.sourceSignals).toHaveLength(1);
  });

  it("records a possible duplicate instead of merging a merely plausible match", () => {
    const { engine } = engineAt(T0 + DAY);
    const alert = engine.ingest(
      makeObservation({ id: "obs_alert", source: SRC.hdfcSms, minor: 45_000, merchant: { raw: "SWIGGY", confidence: 0.8 }, references: [] }),
    );
    // A shared receipt for the same round ₹450 half an hour later, but naming another merchant.
    const screenshot = makeObservation({
      id: "obs_screenshot",
      source: SRC.receiptShare,
      kind: "receipt",
      stage: "confirmed",
      direction: undefined,
      receivedAt: T0 + 30 * MINUTE,
      occurredAt: { value: T0 + 30 * MINUTE, confidence: 0.9 },
      minor: 45_000,
      merchant: { raw: "Zomato", name: "Zomato", confidence: 0.9 },
      references: [],
    });
    const d = engine.ingest(screenshot);
    expect(d.outcome).toBe("created");
    expect(d.possibleMatches).toEqual([{ candidateId: alert.candidateId, probability: expect.any(Number) }]);
    expect(d.possibleMatches[0]!.probability).toBeGreaterThanOrEqual(0.5);
    expect(d.possibleMatches[0]!.probability).toBeLessThan(0.9);
    expect(engine.getCandidate(d.candidateId!)!.links).toMatchObject([{ kind: "possible_duplicate", target: alert.candidateId }]);
  });
});

/* ------------------------------------------------------------------ */
/* Pending -> posted                                                   */
/* ------------------------------------------------------------------ */

describe("pending to posted", () => {
  const pending = makeObservation({
    id: "obs_plaid_pending",
    source: SRC.plaid,
    stage: "pending",
    receivedAt: T0,
    occurredAt: { value: T0 - 2 * HOUR, confidence: 0.9 },
    minor: 4_250,
    currency: "USD",
    merchant: { raw: "JOE'S DINER", name: "Joe's Diner", confidence: 0.8 },
    instrument: { type: "card", last4: "0042", cardKind: "credit" },
    rail: { family: "card", scheme: "mastercard" },
    country: "US",
    references: [{ type: "provider_transaction_id", value: "pend_lPNjeW1nR6", namespace: "plaid:item_abc" }],
  });

  it("merges a posted record that names the pending one, even 18% higher (tip) on another date", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    engine.ingest(pending);
    const posted = makeObservation({
      id: "obs_plaid_posted",
      source: SRC.plaid,
      stage: "posted",
      receivedAt: T0 + 2 * DAY,
      occurredAt: { value: T0 + 2 * DAY - 6 * HOUR, confidence: 0.4 }, // date-only posting date
      minor: 5_015, // $42.50 + 18% tip
      currency: "USD",
      merchant: { raw: "JOES DINER 0042 SEATTLE WA", name: "Joe's Diner", confidence: 0.85 },
      instrument: { type: "card", last4: "0042" },
      references: [
        { type: "provider_transaction_id", value: "post_9Kq2mZ0x", namespace: "plaid:item_abc" },
        { type: "provider_pending_id", value: "pend_lPNjeW1nR6", namespace: "plaid:item_abc" },
      ],
    });
    const d = engine.ingest(posted);
    expect(d.outcome).toBe("linked");
    expect(d.assessment?.features.map((f) => f.name)).toContain("pending_superseded");

    expect(engine.listCandidates()).toHaveLength(1);
    const c = engine.listCandidates()[0]!;
    expect(c.status).toBe("posted");
    expect(c.statusHistory.map((h) => h.status)).toEqual(["pending", "posted"]);
    expect(c.amount?.value).toEqual(money(5_015, "USD"));
    const amountProv = c.provenance.find((p) => p.field === "amount")!;
    expect(amountProv.note).toBe("posted amount supersedes pending");
    expect(amountProv.observationIds).toEqual(["obs_plaid_posted"]);
    expect(c.sourceSignals.map((s) => s.role)).toEqual(["primary", "lifecycle"]);
    expect(c.merchant.displayName).toBe("Joe's Diner");
  });

  it("falls back to fuzzy matching where the regime issues a new id on posting (EUR, no pending link)", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    const ns = "obie:revolut:acc_1";
    const p = makeObservation({
      id: "obs_eur_pending",
      source: SRC.revolut,
      stage: "pending",
      receivedAt: T0,
      occurredAt: { value: T0, confidence: 0.9 },
      minor: 2_800,
      currency: "EUR",
      merchant: { raw: "CAFE DE FLORE PARIS", confidence: 0.8 },
      instrument: { type: "card", last4: "5511" },
      references: [{ type: "provider_transaction_id", value: "PDNG-1", namespace: ns }],
    });
    const q = makeObservation({
      ...p,
      id: "obs_eur_booked",
      stage: "posted",
      receivedAt: T0 + DAY,
      occurredAt: { value: T0 + DAY, confidence: 0.4 },
      amount: { value: money(3_100, "EUR"), confidence: 0.99 }, // tip added at settlement: +10.7%
      references: [{ type: "provider_transaction_id", value: "BOOK-9", namespace: ns }],
    });
    engine.ingest(p);
    expect(engine.ingest(q).outcome).toBe("linked");
    const c = engine.listCandidates()[0]!;
    expect(c.status).toBe("posted");
    expect(c.amount?.value).toEqual(money(3_100, "EUR"));
  });

  it("never merges a posted record into a pending record it does not name", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    engine.ingest(pending);
    const otherPosted = makeObservation({
      ...pending,
      id: "obs_plaid_posted_other",
      stage: "posted",
      receivedAt: T0 + DAY,
      references: [
        { type: "provider_transaction_id", value: "post_other", namespace: "plaid:item_abc" },
        { type: "provider_pending_id", value: "pend_SOMETHING_ELSE", namespace: "plaid:item_abc" },
      ],
    });
    expect(engine.ingest(otherPosted).outcome).toBe("created");
    expect(engine.listCandidates()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Other rails: Pix (BRL) and M-Pesa (KES)                             */
/* ------------------------------------------------------------------ */

describe("instant rails", () => {
  it("fuses a Pix notification, the shared Pix receipt and the Open Finance ledger entry (BRL)", () => {
    const { engine } = engineAt(T0 + DAY);
    const e2e = { type: "rail_reference" as const, value: "E18236120202610041341s0123456789", namespace: "pix" };
    const notification = makeObservation({
      id: "obs_pix_notification",
      source: SRC.nubankNotification,
      receivedAt: T0,
      occurredAt: { value: T0, confidence: 0.95 },
      minor: 8_990,
      currency: "BRL",
      merchant: { raw: "Padaria São João Ltda", confidence: 0.8 },
      rail: { family: "account_to_account_instant", scheme: "pix" },
      country: "BR",
      references: [],
    });
    const receipt = makeObservation({
      id: "obs_pix_receipt",
      source: SRC.receiptShare,
      kind: "receipt",
      direction: "debit",
      receivedAt: T0 + 2 * MINUTE,
      occurredAt: { value: T0, confidence: 0.95 },
      minor: 8_990,
      currency: "BRL",
      merchant: { raw: "PADARIA SAO JOAO LTDA", name: "Padaria São João", confidence: 0.9 },
      rail: { family: "account_to_account_instant", scheme: "pix" },
      references: [e2e],
    });
    const ledger = makeObservation({
      id: "obs_pix_ledger",
      source: SRC.openFinance,
      stage: "posted",
      receivedAt: T0 + 5 * HOUR,
      occurredAt: { value: T0, confidence: 0.9 },
      minor: 8_990,
      currency: "BRL",
      merchant: { raw: "PIX - PADARIA SAO JOAO", confidence: 0.7 },
      references: [e2e, { type: "provider_transaction_id", value: "ofb-778", namespace: "ofb:nubank:acc" }],
    });
    for (const o of [notification, receipt, ledger]) engine.ingest(o);
    const all = engine.listCandidates();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("posted");
    expect(all[0]!.merchant.displayName).toBe("Padaria São João");
    expect(all[0]!.paymentRail).toEqual({ family: "account_to_account_instant", scheme: "pix" });
  });

  it("joins M-Pesa SMS and statement rows by transaction code and separates different codes (KES)", () => {
    const { engine } = engineAt(T0 + DAY);
    const sms = (id: string, code: string, minute: number): Observation =>
      makeObservation({
        id,
        source: SRC.mpesaSms,
        receivedAt: T0 + minute * MINUTE,
        occurredAt: { value: T0 + minute * MINUTE, confidence: 0.95 },
        minor: 125_000,
        currency: "KES",
        merchant: { raw: "NAIVAS SUPERMARKET", confidence: 0.85 },
        rail: { family: "mobile_money", scheme: "mpesa" },
        country: "KE",
        references: [{ type: "rail_reference", value: code, namespace: "mpesa" }],
      });
    const statement = makeObservation({
      id: "obs_mpesa_statement",
      source: SRC.mpesaStatement,
      stage: "posted",
      receivedAt: T0 + DAY,
      occurredAt: { value: T0, confidence: 0.9 },
      minor: 125_000,
      currency: "KES",
      merchant: { raw: "Merchant Payment to 512345 - NAIVAS SUPERMARKET", confidence: 0.8 },
      references: [{ type: "rail_reference", value: "QJK3XYZ12A", namespace: "mpesa" }],
    });
    const a = engine.ingest(sms("obs_mpesa_1", "QJK3XYZ12A", 0));
    const b = engine.ingest(sms("obs_mpesa_2", "QJK3XYZ99B", 30)); // a second, genuine purchase
    const s = engine.ingest(statement);
    expect(b.outcome).toBe("created");
    expect(s.outcome).toBe("linked");
    expect(s.candidateId).toBe(a.candidateId);
    expect(engine.listCandidates()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Intent lifecycle                                                    */
/* ------------------------------------------------------------------ */

describe("purchase intent lifecycle", () => {
  const intent = makeObservation({
    id: "obs_should_i_buy",
    source: SRC.manual,
    kind: "purchase_intent",
    window: "pre_spend",
    stage: "intent",
    direction: undefined,
    receivedAt: T0,
    occurredAt: { value: T0, confidence: 1 },
    amount: { value: money(120_000, "INR"), confidence: 0.6, approximate: true },
    merchant: { raw: "Amazon", name: "Amazon", confidence: 0.7 },
    intent: { via: "should_i_buy", title: "Wireless headphones" },
    references: [],
    confidence: 0.9,
  });
  const purchase = (id: string, at: number): Observation =>
    makeObservation({
      id,
      source: SRC.hdfcSms,
      receivedAt: at,
      occurredAt: { value: at, confidence: 0.95 },
      minor: 124_900,
      merchant: { raw: "AMAZON PAY INDIA", confidence: 0.8 },
      references: [],
    });

  it("advances an intent to a confirmed purchase when the matching debit arrives within the horizon", () => {
    const { clock, engine } = engineAt(T0);
    const created = engine.ingest(intent);
    expect(engine.getCandidate(created.candidateId!)).toMatchObject({ status: "intent", intentOutcome: "open" });

    clock.set(T0 + 3 * HOUR);
    const d = engine.ingest(purchase("obs_amazon_debit", T0 + 3 * HOUR));
    expect(d.outcome).toBe("linked");
    expect(d.candidateId).toBe(created.candidateId);
    const all = engine.listCandidates();
    expect(all).toHaveLength(1);
    const c = all[0]!;
    expect(c.status).toBe("confirmed");
    expect(c.intentOutcome).toBe("purchased");
    expect(c.amount?.value).toEqual(money(124_900, "INR"));
    expect(c.amount?.approximate).toBeUndefined();
    expect(c.statusHistory.map((h) => h.status)).toEqual(["intent", "confirmed"]);
    expect(c.sourceSignals.map((s) => s.role)).toEqual(["primary", "lifecycle"]);

    // Still purchased long after the horizon.
    clock.set(T0 + 10 * DAY);
    expect(engine.getCandidate(c.id)?.intentOutcome).toBe("purchased");
  });

  it("reads an intent with no purchase as abandoned once the horizon has passed (derived at read time)", () => {
    const { clock, engine } = engineAt(T0 + HOUR);
    const { candidateId } = engine.ingest(intent);
    expect(engine.getCandidate(candidateId!)?.intentOutcome).toBe("open");
    expect(engine.getCandidate(candidateId!)?.status).toBe("intent");

    clock.set(T0 + 25 * HOUR);
    const later = engine.getCandidate(candidateId!)!;
    expect(later.intentOutcome).toBe("abandoned");
    expect(later.status).toBe("cancelled");
    expect(engine.listCandidates()[0]?.intentOutcome).toBe("abandoned");

    // A purchase after the horizon is a separate event; the intent stays abandoned.
    const d = engine.ingest(purchase("obs_late_debit", T0 + 30 * HOUR));
    expect(d.outcome).toBe("created");
    expect(engine.getCandidate(candidateId!)?.intentOutcome).toBe("abandoned");
  });

  it("never links a purchase that happened before the intent", () => {
    const { engine } = engineAt(T0 + HOUR);
    engine.ingest(purchase("obs_earlier_debit", T0 - 2 * HOUR));
    expect(engine.ingest(intent).outcome).toBe("created");
    expect(engine.listCandidates()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

describe("refunds", () => {
  it("fuses a refund notice with the later bank credit into one refund candidate, not into the purchase", () => {
    const { engine } = engineAt(T0 + 10 * DAY);
    const [alert, order] = briefObservations();
    const purchase = engine.ingest(alert!);
    engine.ingest(order!);

    const refundNotice = makeObservation({
      id: "obs_refund_notice",
      source: SRC.gmail,
      kind: "refund_notice",
      stage: "confirmed",
      direction: "credit",
      receivedAt: T0 + 5 * DAY,
      occurredAt: { value: T0 + 5 * DAY, confidence: 0.9 },
      minor: 124_900,
      merchant: { raw: "Amazon.in", name: "Amazon", confidence: 0.9 },
      references: [ORDER_ID],
      evidence: { summary: "Amazon: refund of ₹1,249.00 initiated for order #402-8812345-1234567" },
    });
    const credit = makeObservation({
      id: "obs_refund_credit",
      source: SRC.hdfcSms,
      direction: "credit",
      receivedAt: T0 + 7 * DAY,
      occurredAt: { value: T0 + 7 * DAY, confidence: 0.95 },
      minor: 124_900,
      merchant: { raw: "AMAZON REFUND", confidence: 0.8 },
      references: [],
    });
    const n = engine.ingest(refundNotice);
    const c = engine.ingest(credit);

    expect(n.outcome).toBe("created");
    expect(n.candidateId).not.toBe(purchase.candidateId);
    expect(c.outcome).toBe("linked");
    expect(c.candidateId).toBe(n.candidateId);
    expect(engine.listCandidates()).toHaveLength(2);

    const refund = engine.getCandidate(n.candidateId!)!;
    expect(refund.direction).toBe("credit");
    expect(refund.transactionType.value).toBe("refund");
    expect(refund.transactionType.basis).toEqual(["source_hint"]);
    expect(refund.references).toContainEqual(ORDER_ID); // lets reconciliation link refund_of
    expect(refund.links).toEqual([]);
    expect(engine.getCandidate(purchase.candidateId!)!.sourceSignals).toHaveLength(2);
    expect(engine.assess(refundNotice, purchase.candidateId!).veto).toMatch(/directions conflict/);
  });
});

/* ------------------------------------------------------------------ */
/* Deliveries                                                          */
/* ------------------------------------------------------------------ */

describe("deliveries", () => {
  const flipkartOrder = (id: string, orderId: string): Observation =>
    makeObservation({
      id,
      source: SRC.gmail,
      kind: "order",
      direction: undefined,
      receivedAt: T0,
      occurredAt: { value: T0, confidence: 0.9 },
      minor: 249_900,
      merchant: { raw: "Flipkart", name: "Flipkart", confidence: 0.9 },
      references: [{ type: "order_id", value: orderId, namespace: "flipkart" }],
    });
  const delivery = (id: string, orderId: string | null, at: number): Observation =>
    makeObservation({
      id,
      source: SRC.gmail,
      kind: "delivery",
      stage: "confirmed",
      direction: undefined,
      amount: undefined,
      receivedAt: at,
      occurredAt: { value: at, confidence: 0.9 },
      merchant: { raw: "Flipkart", name: "Flipkart", confidence: 0.9 },
      references: orderId ? [{ type: "order_id", value: orderId, namespace: "flipkart" }] : [],
    });

  it("joins a delivery to its order by order id", () => {
    const { engine } = engineAt(T0 + 5 * DAY);
    const order = engine.ingest(flipkartOrder("obs_fk_order", "OD4271"));
    const d = engine.ingest(delivery("obs_fk_delivered", "OD4271", T0 + 3 * DAY));
    expect(d.outcome).toBe("linked");
    expect(d.candidateId).toBe(order.candidateId);
    const c = engine.getCandidate(order.candidateId!)!;
    expect(c.sourceSignals.map((s) => [s.kind, s.role])).toEqual([
      ["order", "primary"],
      ["delivery", "enriching"],
    ]);
    expect(engine.contextObservations()).toEqual([]);
  });

  it("stores a delivery without a matching order as context, creating no candidate", () => {
    const { engine } = engineAt(T0 + 5 * DAY);
    engine.ingest(flipkartOrder("obs_fk_order", "OD4271"));
    const unknownOrder = engine.ingest(delivery("obs_fk_other", "OD9999", T0 + DAY));
    const noReference = engine.ingest(delivery("obs_fk_noref", null, T0 + DAY)); // same merchant, but no order id
    expect(unknownOrder).toMatchObject({ outcome: "context" });
    expect(unknownOrder.candidateId).toBeUndefined();
    expect(noReference.outcome).toBe("context");
    expect(engine.listCandidates()).toHaveLength(1);
    expect(engine.contextObservations().map((o) => o.id)).toEqual(["obs_fk_other", "obs_fk_noref"]);
  });

  it("attaches a waiting delivery once its order arrives", () => {
    const { engine } = engineAt(T0 + 5 * DAY);
    expect(engine.ingest(delivery("obs_early_delivery", "OD5555", T0 + DAY)).outcome).toBe("context");
    const order = engine.ingest(flipkartOrder("obs_late_order", "OD5555"));
    expect(engine.findCandidateByObservation("obs_early_delivery")?.id).toBe(order.candidateId);
    expect(engine.contextObservations()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Context-only observations                                           */
/* ------------------------------------------------------------------ */

describe("context-only observations", () => {
  it("never creates candidates for balances, app launches, mandates, renewal notices or unpaid invoices", () => {
    const { engine } = engineAt(T0 + DAY);
    const balance = makeObservation({
      id: "obs_balance",
      source: SRC.plaid,
      kind: "balance_snapshot",
      stage: "unknown",
      direction: undefined,
      amount: undefined,
      balance: { available: money(1_250_000, "USD"), current: money(1_300_000, "USD") },
      references: [],
    });
    const appLaunch = makeObservation({
      id: "obs_app_launch",
      source: makeSource({ adapterId: "screen-time", kind: "app_activity", connectionId: "conn_screen_time", label: "app activity" }),
      kind: "app_context",
      window: "pre_spend",
      stage: "unknown",
      direction: undefined,
      amount: undefined,
      references: [],
    });
    const mandate = makeObservation({
      id: "obs_mandate",
      source: SRC.hdfcSms,
      kind: "mandate",
      stage: "confirmed",
      minor: 64_900,
      merchant: { raw: "NETFLIX", confidence: 0.9 },
      references: [{ type: "mandate_id", value: "UMN-1", namespace: "upi" }],
    });
    const renewal = makeObservation({
      id: "obs_renewal_upcoming",
      source: SRC.gmail,
      kind: "subscription_event",
      stage: "unknown",
      direction: undefined,
      amount: undefined,
      merchant: { raw: "Netflix", name: "Netflix", confidence: 0.95 },
      subscription: { event: "renewal_upcoming", serviceName: "Netflix", price: money(2_299, "USD"), nextChargeAt: T0 + DAY },
      references: [],
    });
    const unpaidInvoice = makeObservation({
      id: "obs_invoice_due",
      source: SRC.gmail,
      kind: "invoice",
      stage: "pending",
      direction: undefined,
      minor: 89_000,
      currency: "EUR",
      merchant: { raw: "Stadtwerke München", name: "Stadtwerke München", confidence: 0.9 },
      references: [{ type: "invoice_id", value: "R-2026-10-118", namespace: "swm" }],
    });
    const observations = [balance, appLaunch, mandate, renewal, unpaidInvoice];
    const decisions = observations.map((o) => engine.ingest(o));

    expect(decisions.map((d) => d.outcome)).toEqual(["context", "context", "context", "context", "context"]);
    expect(decisions.every((d) => d.candidateId === undefined)).toBe(true);
    expect(engine.listCandidates()).toEqual([]);
    expect(engine.contextObservations().map((o) => o.id)).toEqual(observations.map((o) => o.id));
  });

  it("treats a charged subscription event as a transaction", () => {
    const { engine } = engineAt(T0 + DAY);
    const charged = makeObservation({
      id: "obs_netflix_charged",
      source: SRC.gmail,
      kind: "subscription_event",
      stage: "confirmed",
      direction: undefined,
      minor: 2_299,
      currency: "USD",
      merchant: { raw: "Netflix", name: "Netflix", confidence: 0.95 },
      subscription: { event: "charged", serviceName: "Netflix", period: "P1M" },
      references: [{ type: "invoice_id", value: "NF-2026-10", namespace: "netflix" }],
    });
    const d = engine.ingest(charged);
    expect(d.outcome).toBe("created");
    expect(engine.getCandidate(d.candidateId!)?.transactionType.value).toBe("subscription");
  });
});

/* ------------------------------------------------------------------ */
/* Review regressions: never double count, never over-merge            */
/* ------------------------------------------------------------------ */

describe("double counting across sources", () => {
  const zomatoReceipt = makeObservation({
    id: "obs_zomato_receipt",
    source: SRC.receiptShare,
    kind: "receipt",
    stage: "confirmed",
    direction: undefined,
    receivedAt: T0,
    occurredAt: { value: T0, confidence: 0.9 },
    minor: 45_000,
    merchant: { raw: "Zomato", name: "Zomato", confidence: 0.9 },
    references: [],
  });
  const swiggySms = makeObservation({
    id: "obs_swiggy_sms",
    source: SRC.hdfcSms,
    receivedAt: T0 + 30 * MINUTE,
    occurredAt: { value: T0 + 30 * MINUTE, confidence: 0.95 },
    minor: 45_000,
    merchant: { raw: "SWIGGY", confidence: 0.8 },
    references: [],
  });

  it("flags the enrichment-only side of a possible duplicate whichever arrives first", () => {
    const totals: number[] = [];
    for (const arrival of [
      [zomatoReceipt, swiggySms],
      [swiggySms, zomatoReceipt],
    ]) {
      const { engine } = engineAt(T0 + DAY);
      for (const o of arrival) engine.ingest(o);
      const receipt = engine.findCandidateByObservation(zomatoReceipt.id)!;
      const payment = engine.findCandidateByObservation(swiggySms.id)!;
      expect(receipt.id).not.toBe(payment.id); // never merged while uncertain
      const flag = receipt.links.find((l) => l.kind === "possible_duplicate" && l.target === payment.id);
      expect(flag?.probability).toBeGreaterThanOrEqual(0.5);
      expect(payment.confidence).toBeGreaterThan(0.9); // the payment itself is not in doubt
      totals.push(expectedMinor(engine.listCandidates()));
    }
    expect(totals[0]).toBeCloseTo(totals[1]!, 6);
    expect(totals[0]! / 45_000).toBeLessThan(1.05);
  });

  it("keeps ledger entries that are ambiguous between two same-amount coffees from double counting them (INR, UPI)", () => {
    const { engine } = engineAt(T0 + 2 * DAY);
    const alert = (id: string, minute: number): Observation =>
      makeObservation({
        id,
        source: SRC.hdfcSms,
        receivedAt: T0 + minute * MINUTE,
        occurredAt: { value: T0 + minute * MINUTE, confidence: 0.95 },
        minor: 10_000,
        merchant: { raw: "THIRD WAVE COFFEE", confidence: 0.85 },
        rail: { family: "account_to_account_instant", scheme: "upi" },
        references: [],
      });
    const ledger = (id: string, minute: number, txn: string): Observation =>
      makeObservation({
        id,
        source: SRC.aa,
        stage: "posted",
        receivedAt: T0 + DAY,
        occurredAt: { value: T0 + minute * MINUTE, confidence: 0.9 },
        minor: 10_000,
        merchant: { raw: "UPI/THIRD WAVE COFFEE/thirdwave@ybl", confidence: 0.85 },
        rail: { family: "account_to_account_instant", scheme: "upi" },
        references: [{ type: "provider_transaction_id", value: txn, namespace: "aa:hdfc:acc" }],
      });
    const a1 = engine.ingest(alert("obs_sms_coffee_1", 0));
    const a2 = engine.ingest(alert("obs_sms_coffee_2", 20));
    const l1 = engine.ingest(ledger("obs_aa_coffee_1", 0, "AA-1"));
    const l2 = engine.ingest(ledger("obs_aa_coffee_2", 20, "AA-2"));

    // Uncertainty is preserved: neither ledger entry is merged into a guess.
    expect([l1.outcome, l2.outcome]).toEqual(["ambiguous", "ambiguous"]);
    for (const d of [l1, l2]) {
      const c = engine.getCandidate(d.candidateId!)!;
      expect(c.links.filter((l) => l.kind === "possible_duplicate").map((l) => l.target).sort()).toEqual(
        [a1.candidateId, a2.candidateId].sort(),
      );
      // …but a record that almost certainly duplicates one of two known payments is not a third payment.
      expect(c.confidence).toBeLessThan(0.05);
    }
    expect(engine.getCandidate(a1.candidateId!)!.confidence).toBeGreaterThan(0.9);
    expect(expectedMinor(engine.listCandidates())).toBeGreaterThan(2 * 10_000 * 0.8);
    expect(expectedMinor(engine.listCandidates())).toBeLessThan(2 * 10_000 * 1.05);
  });

  it("does the same for daily transit fares seen as card alerts and date-only ledger rows (USD)", () => {
    const { engine } = engineAt(T0 + 5 * DAY);
    const fares = [0, 1, 2].map((day) => T0 + day * DAY);
    for (const [i, at] of fares.entries()) {
      engine.ingest(
        makeObservation({
          id: `obs_fare_alert_${i}`,
          source: SRC.cardFeed,
          receivedAt: at,
          occurredAt: { value: at, confidence: 0.95 },
          minor: 290,
          currency: "USD",
          merchant: { raw: "MTA*NYCT PAYGO", confidence: 0.85 },
          instrument: { type: "card", last4: "0042" },
          references: [],
        }),
      );
    }
    for (const [i, at] of fares.entries()) {
      engine.ingest(
        makeObservation({
          id: `obs_fare_ledger_${i}`,
          source: SRC.plaid,
          stage: "posted",
          receivedAt: T0 + 3 * DAY,
          occurredAt: { value: at - (at % DAY), confidence: 0.4 }, // date-only posting date
          minor: 290,
          currency: "USD",
          merchant: { raw: "MTA*NYCT PAYGO", confidence: 0.85 },
          instrument: { type: "card", last4: "0042" },
          references: [{ type: "provider_transaction_id", value: `fare_${i}`, namespace: "plaid:acc_card" }],
        }),
      );
    }
    expect(expectedMinor(engine.listCandidates())).toBeLessThan(3 * 290 * 1.05);
    expect(expectedMinor(engine.listCandidates())).toBeGreaterThan(3 * 290 * 0.8);
  });
});

describe("authorisation vs settlement amounts", () => {
  const cardAlert = (minor: number): Observation =>
    makeObservation({
      id: "obs_card_alert",
      source: SRC.cardFeed,
      receivedAt: T0 - 2 * HOUR,
      occurredAt: { value: T0 - 2 * HOUR, confidence: 0.95 },
      minor,
      currency: "USD",
      merchant: { raw: "JOE'S DINER", confidence: 0.8 },
      instrument: { type: "card", last4: "0042" },
      references: [],
    });
  const plaidPending = (minor: number): Observation =>
    makeObservation({
      id: "obs_plaid_pending",
      source: SRC.plaid,
      stage: "pending",
      receivedAt: T0,
      occurredAt: { value: T0 - 2 * HOUR, confidence: 0.9 },
      amount: { value: money(minor, "USD"), confidence: 0.9 },
      merchant: { raw: "JOE'S DINER", name: "Joe's Diner", confidence: 0.8 },
      instrument: { type: "card", last4: "0042", cardKind: "credit" },
      references: [{ type: "provider_transaction_id", value: "pend_lPNjeW1nR6", namespace: "plaid:item_abc" }],
    });
  const plaidPosted = (minor: number): Observation =>
    makeObservation({
      id: "obs_plaid_posted",
      source: SRC.plaid,
      stage: "posted",
      receivedAt: T0 + 2 * DAY,
      occurredAt: { value: T0 + 2 * DAY - 6 * HOUR, confidence: 0.4 },
      minor,
      currency: "USD",
      merchant: { raw: "JOES DINER 0042 SEATTLE WA", name: "Joe's Diner", confidence: 0.85 },
      instrument: { type: "card", last4: "0042" },
      references: [
        { type: "provider_transaction_id", value: "post_9Kq2mZ0x", namespace: "plaid:item_abc" },
        { type: "provider_pending_id", value: "pend_lPNjeW1nR6", namespace: "plaid:item_abc" },
      ],
    });

  it("merges a tipped posted record into the candidate its pending record shares with a card alert", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    const decisions = [cardAlert(4_250), plaidPending(4_250), plaidPosted(5_015)].map((o) => engine.ingest(o));
    expect(decisions.map((d) => d.outcome)).toEqual(["created", "linked", "linked"]);
    const all = engine.listCandidates();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("posted");
    expect(all[0]!.amount?.value).toEqual(money(5_015, "USD"));
    expect(all[0]!.provenance.find((p) => p.field === "amount")?.note).toBe("posted amount supersedes pending");
  });

  it("lets the posted amount replace a much larger fuel hold instead of counting both", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    for (const o of [cardAlert(10_000), plaidPending(10_000), plaidPosted(4_512)]) engine.ingest(o);
    const all = engine.listCandidates();
    expect(all).toHaveLength(1);
    expect(all[0]!.amount?.value).toEqual(money(4_512, "USD"));
  });

  it("reaches the same single candidate when the ledger records arrive before the card alert", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    for (const o of [plaidPending(4_250), plaidPosted(5_015), cardAlert(4_250)]) engine.ingest(o);
    expect(engine.listCandidates()).toHaveLength(1);
    expect(engine.listCandidates()[0]!.amount?.value).toEqual(money(5_015, "USD"));
  });

  it("joins a tipped restaurant receipt through the posted amount", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    for (const o of [cardAlert(4_250), plaidPending(4_250), plaidPosted(5_015)]) engine.ingest(o);
    const receipt = makeObservation({
      id: "obs_diner_receipt",
      source: SRC.gmail,
      kind: "receipt",
      direction: undefined,
      receivedAt: T0 + 2 * DAY + HOUR,
      occurredAt: { value: T0 - 2 * HOUR, confidence: 0.8 },
      minor: 5_015,
      currency: "USD",
      merchant: { raw: "Joe's Diner", name: "Joe's Diner", confidence: 0.9 },
      lineItems: [{ description: "Pancakes" }],
      references: [],
    });
    expect(engine.ingest(receipt).outcome).toBe("linked");
    expect(engine.listCandidates()).toHaveLength(1);
  });

  it("still refuses a money movement that contradicts the candidate's payment, even when a receipt would vouch for it", () => {
    const { engine } = engineAt(T0 + 3 * DAY);
    const sms = makeObservation({ id: "obs_sms_1249", source: SRC.hdfcSms, minor: 124_900, merchant: { raw: "AMAZON", confidence: 0.8 }, references: [] });
    const receipt = makeObservation({
      id: "obs_receipt_1249",
      source: SRC.gmail,
      kind: "receipt",
      direction: undefined,
      receivedAt: T0 + MINUTE,
      minor: 124_900,
      merchant: { raw: "Amazon", name: "Amazon", confidence: 0.9 },
      references: [],
    });
    const ledger = makeObservation({
      id: "obs_ledger_1240",
      source: SRC.bankApi,
      stage: "posted",
      receivedAt: T0 + DAY,
      occurredAt: { value: T0, confidence: 0.4 },
      minor: 124_000, // within the receipt's 1 % tolerance, but ₹9 off the alert
      merchant: { raw: "AMAZON", confidence: 0.8 },
      references: [{ type: "provider_transaction_id", value: "L-1", namespace: "bank:hdfc" }],
    });
    for (const o of [sms, receipt]) engine.ingest(o);
    const d = engine.ingest(ledger);
    expect(d.outcome).not.toBe("linked");
    expect(engine.assess(ledger, engine.findCandidateByObservation(sms.id)!.id).veto).toMatch(/amount/);
  });
});

describe("over-merging through approximate amounts", () => {
  it("does not let an approximate intent vouch for an order whose amount contradicts the payment", () => {
    const { engine } = engineAt(T0 + DAY);
    engine.ingest(
      makeObservation({
        id: "obs_intent_headphones",
        source: SRC.manual,
        kind: "purchase_intent",
        window: "pre_spend",
        stage: "intent",
        direction: undefined,
        receivedAt: T0,
        occurredAt: { value: T0, confidence: 1 },
        amount: { value: money(120_000, "INR"), confidence: 0.6, approximate: true },
        merchant: { raw: "Amazon", name: "Amazon", confidence: 0.7 },
        intent: { via: "should_i_buy" },
        references: [],
      }),
    );
    const paid = engine.ingest(
      makeObservation({ id: "obs_paid_1249", source: SRC.hdfcSms, receivedAt: T0 + 3 * HOUR, occurredAt: { value: T0 + 3 * HOUR, confidence: 0.95 }, minor: 124_900, merchant: { raw: "AMAZON PAY INDIA", confidence: 0.8 }, references: [] }),
    );
    expect(paid.outcome).toBe("linked");
    const otherOrder = engine.ingest(
      makeObservation({
        id: "obs_other_order_1199",
        source: SRC.gmail,
        kind: "order",
        direction: undefined,
        receivedAt: T0 + 5 * HOUR,
        occurredAt: { value: T0 + 5 * HOUR, confidence: 0.9 },
        minor: 119_900,
        merchant: { raw: "Amazon.in", name: "Amazon", confidence: 0.9 },
        references: [{ type: "order_id", value: "402-7000000-0000001", namespace: "amazon" }],
      }),
    );
    expect(otherOrder.outcome).toBe("created");
    expect(engine.getCandidate(paid.candidateId!)!.sourceSignals).toHaveLength(2);
  });

  it("retrieves every pair a custom approximate-amount tolerance allows", () => {
    const clock = fixedClock(T0 + DAY);
    const engine = createFusionEngine({ clock, config: { approximateAmountTolerance: 0.3 } });
    engine.ingest(
      makeObservation({
        id: "obs_intent_estimate",
        source: SRC.manual,
        kind: "purchase_intent",
        stage: "intent",
        direction: undefined,
        receivedAt: T0,
        occurredAt: { value: T0, confidence: 1 },
        amount: { value: money(100_000, "INR"), confidence: 0.5, approximate: true },
        merchant: { raw: "Croma", name: "Croma", confidence: 0.7 },
        references: [],
      }),
    );
    // 28.6 % above the estimate, i.e. within 30 % of the larger amount.
    const d = engine.ingest(
      makeObservation({ id: "obs_croma_debit", source: SRC.hdfcSms, receivedAt: T0 + 2 * HOUR, occurredAt: { value: T0 + 2 * HOUR, confidence: 0.95 }, minor: 140_000, merchant: { raw: "CROMA", confidence: 0.8 }, references: [] }),
    );
    expect(d.outcome).toBe("linked");
  });
});

describe("record versions and lifecycle updates", () => {
  it("lets a re-reported version of a ledger record replace the earlier version's amount and descriptor (USD)", () => {
    const { engine } = engineAt(T0 + DAY);
    const ref = { type: "provider_transaction_id" as const, value: "txn_lPNjeW1nR6", namespace: "plaid:acc_card" };
    const v1 = makeObservation({
      id: "obs_plaid_txn_v1",
      source: SRC.plaid,
      stage: "pending",
      receivedAt: T0,
      occurredAt: { value: T0, confidence: 0.95 },
      amount: { value: money(4_250, "USD"), confidence: 0.9 },
      merchant: { raw: "SQ *JOES DINER", confidence: 0.8 },
      references: [ref],
      confidence: 0.85,
    });
    const v2 = { ...v1, id: "obs_plaid_txn_v2", receivedAt: T0 + 3 * HOUR, amount: { value: money(4_500, "USD"), confidence: 0.9 }, merchant: { raw: "JOE'S DINER", name: "Joe's Diner", confidence: 0.9 } };
    engine.ingest(v1);
    expect(engine.ingest(v2).outcome).toBe("linked");
    const c = engine.listCandidates()[0]!;
    expect(engine.listCandidates()).toHaveLength(1);
    expect(c.amount?.value).toEqual(money(4_500, "USD"));
    expect(c.merchant.raw).toBe("JOE'S DINER");
    expect(c.provenance.find((p) => p.field === "amount")?.observationIds).toEqual(["obs_plaid_txn_v2"]);
  });

  it("keeps the amount when the later report of a record carries none (a removed authorisation)", () => {
    const { engine } = engineAt(T0 + DAY);
    const ref = { type: "provider_transaction_id" as const, value: "txn_hold_1", namespace: "plaid:acc_card" };
    engine.ingest(makeObservation({ id: "obs_hold", source: SRC.plaid, stage: "pending", minor: 100, currency: "USD", references: [ref] }));
    engine.ingest(makeObservation({ id: "obs_hold_removed", source: SRC.plaid, stage: "cancelled", receivedAt: T0 + HOUR, occurredAt: undefined, direction: undefined, amount: undefined, references: [ref] }));
    const c = engine.listCandidates()[0]!;
    expect(engine.listCandidates()).toHaveLength(1);
    expect(c.status).toBe("cancelled");
    expect(c.amount?.value).toEqual(money(100, "USD"));
  });

  it("joins a delivery by its order id whatever other references it shares first", () => {
    const { engine } = engineAt(T0 + 5 * DAY);
    const order = engine.ingest(
      makeObservation({
        id: "obs_fk_order_psp",
        source: SRC.gmail,
        kind: "order",
        direction: undefined,
        minor: 249_900,
        merchant: { raw: "Flipkart", name: "Flipkart", confidence: 0.9 },
        references: [
          { type: "order_id", value: "OD4271", namespace: "flipkart" },
          { type: "merchant_reference", value: "PSP-77", namespace: "flipkart" },
        ],
      }),
    );
    const delivery = engine.ingest(
      makeObservation({
        id: "obs_fk_delivery_psp",
        source: SRC.gmail,
        kind: "delivery",
        direction: undefined,
        amount: undefined,
        receivedAt: T0 + 2 * DAY,
        merchant: { raw: "Flipkart", name: "Flipkart", confidence: 0.9 },
        references: [
          { type: "merchant_reference", value: "PSP-77", namespace: "flipkart" },
          { type: "order_id", value: "OD4271", namespace: "flipkart" },
        ],
      }),
    );
    expect(delivery.outcome).toBe("linked");
    expect(delivery.candidateId).toBe(order.candidateId);
  });

  it("cancels an order when a delivery update reports the order cancelled, and uses shipped items as a last resort", () => {
    const { engine } = engineAt(T0 + 5 * DAY);
    const ref = { type: "order_id" as const, value: "OD5150", namespace: "flipkart" };
    const order = engine.ingest(
      makeObservation({ id: "obs_fk_order_c", source: SRC.gmail, kind: "order", direction: undefined, minor: 49_900, merchant: { raw: "Flipkart", name: "Flipkart", confidence: 0.9 }, references: [ref] }),
    );
    engine.ingest(
      makeObservation({
        id: "obs_fk_cancelled",
        source: SRC.gmail,
        kind: "delivery",
        stage: "cancelled",
        direction: undefined,
        amount: undefined,
        receivedAt: T0 + DAY,
        merchant: { raw: "Flipkart", name: "Flipkart", confidence: 0.9 },
        lineItems: [{ description: "phone case" }],
        references: [ref],
      }),
    );
    const c = engine.getCandidate(order.candidateId!)!;
    expect(c.status).toBe("cancelled");
    expect(c.lineItems.map((i) => i.description)).toEqual(["phone case"]);
    // A delivery never advances the payment lifecycle on its own.
    const shipped = createFusionEngine({ clock: fixedClock(T0 + 5 * DAY) });
    const pendingOrder = shipped.ingest(
      makeObservation({ id: "obs_cod_order", source: SRC.gmail, kind: "order", stage: "pending", direction: undefined, minor: 49_900, merchant: { raw: "Flipkart", confidence: 0.9 }, references: [ref] }),
    );
    shipped.ingest(makeObservation({ id: "obs_cod_shipped", source: SRC.gmail, kind: "delivery", stage: "confirmed", direction: undefined, amount: undefined, receivedAt: T0 + DAY, references: [ref] }));
    expect(shipped.getCandidate(pendingOrder.candidateId!)!.status).toBe("pending");
  });
});
