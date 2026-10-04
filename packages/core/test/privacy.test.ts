import { afterEach, describe, expect, it, vi } from "vitest";
import { inference, makeCandidate, makeObservation, makeSource, T0 } from "@brake/core/testing";
import { userInference } from "../src/model/candidate";
import type { CandidateLink, SourceSignal, TransactionCandidate } from "../src/model/candidate";
import type { MerchantObservation, Observation } from "../src/model/observation";
import { DAY, HOUR, MINUTE, fixedClock } from "../src/model/primitives";
import type { SignalSourceKind, SourceRef } from "../src/model/source";
import { ConsentError, connectionPurgePredicate, createConsentRegistry } from "../src/privacy/consent";
import type { ConnectInput } from "../src/privacy/consent";
import { dataInventory, explainCandidate, explainObservation } from "../src/privacy/explain";
import type { ExplainOptions } from "../src/privacy/explain";
import { DEFAULT_RETENTION, applyRetention, retentionAnchor, validateRetentionPolicy } from "../src/privacy/retention";
import type { Explanation, RetentionPolicy } from "../src/privacy/types";

/* ------------------------------------------------------------------ */
/* Fixtures: one source per region/rail, all through the same builders  */
/* ------------------------------------------------------------------ */

const SRC = {
  hdfcNotification: makeSource({ adapterId: "android-notification", kind: "notification", connectionId: "conn_hdfc_notif", label: "HDFC Bank transaction notification", provider: "HDFC Bank" }),
  hdfcSms: makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_hdfc_sms", label: "HDFC Bank SMS alerts", provider: "HDFC Bank" }),
  hdfcAccount: makeSource({ adapterId: "account-aggregator", kind: "account_aggregator", connectionId: "conn_hdfc_aa", label: "HDFC Bank account", provider: "HDFC Bank" }),
  gmail: makeSource({ adapterId: "gmail", kind: "email", connectionId: "conn_gmail", label: "Gmail inbox" }),
  chaseCard: makeSource({ adapterId: "plaid", kind: "open_banking", connectionId: "conn_plaid_chase", label: "Chase Sapphire card account", provider: "Chase" }),
  outlook: makeSource({ adapterId: "outlook", kind: "email", connectionId: "conn_outlook", label: "Outlook inbox" }),
  n26: makeSource({ adapterId: "psd2", kind: "open_banking", connectionId: "conn_n26", label: "N26 account", provider: "N26" }),
  nubank: makeSource({ adapterId: "android-notification", kind: "notification", connectionId: "conn_nubank", label: "Nubank notifications", provider: "Nubank" }),
  mpesa: makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_mpesa", label: "M-Pesa SMS alerts", provider: "Safaricom" }),
  manual: makeSource({ adapterId: "manual", kind: "manual", connectionId: "conn_manual", label: "manual entries" }),
} satisfies Record<string, SourceRef>;

function merchant(name: string, extra: Partial<MerchantObservation> = {}): MerchantObservation {
  return { raw: name, name, confidence: 0.9, ...extra };
}

function signal(o: Observation, role: SourceSignal["role"]): SourceSignal {
  return {
    observationId: o.id,
    kind: o.kind,
    sourceLabel: o.source.label,
    provider: o.source.provider,
    adapterId: o.source.adapterId,
    connectionId: o.source.connectionId,
    role,
    matchProbability: 1,
    linkedAt: o.receivedAt,
  };
}

/** A fused candidate whose source signals are exactly these observations. */
function candidateOf(obs: readonly Observation[], p: Partial<TransactionCandidate> & { minor?: number; currency?: string } = {}): TransactionCandidate {
  return makeCandidate({ sourceSignals: obs.map((o, i) => signal(o, i === 0 ? "primary" : "enriching")), ...p });
}

const IN: ExplainOptions = { locale: "en-IN", timeZone: "Asia/Kolkata" };

function allText(e: Explanation): string[] {
  return [e.headline, ...e.details];
}

/** Local copy of the intelligence tone rules (core must not import intelligence). */
const SCOLDING: readonly RegExp[] = [
  /\bwast(e|ed|ing|eful)\b/i,
  /\bshould(?:n't| not) have\b/i,
  /\b(bad|poor|irresponsible|careless|reckless)\s+(choice|decision|spending|habit)/i,
  /\b(guilt|guilty|shame|ashamed)\b/i,
  /\b(again\?|seriously|really\?)/i,
  /\byou (always|never)\b/i,
  /\boverspen(t|d|ding)\b/i,
  /!/,
  /^\s*you spent [^.]+\.?\s*$/i,
];

function toneProblems(text: string): RegExp[] {
  return SCOLDING.filter((re) => re.test(text));
}

/** Digit runs longer than four that are not amounts (currency before, or decimals after). */
function nonAmountLongDigitRuns(text: string): string[] {
  const out: string[] = [];
  const re = /\d{5,}/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 5), m.index);
    const after = text.slice(m.index + m[0].length);
    const amount = /(?:rs\.?|inr|usd|eur|brl|kes|ksh|r\$|[₹$€£])\s?$/i.test(before) || /^[.,]\d{2}(?!\d)/.test(after);
    if (!amount) out.push(m[0]);
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Consent registry                                                    */
/* ------------------------------------------------------------------ */

const SMS_GRANT: ConnectInput = {
  connectionId: "conn_hdfc_sms",
  adapterId: "sms",
  kind: "sms",
  label: "HDFC Bank SMS alerts",
  provider: "HDFC Bank",
  scopes: ["READ_SMS: bank senders only"],
  purposes: ["detect purchases"],
};

const PLAID_GRANT: ConnectInput = {
  connectionId: "conn_plaid_chase",
  adapterId: "plaid",
  kind: "open_banking",
  label: "Chase Sapphire card account",
  provider: "Chase",
  scopes: ["transactions"],
  purposes: ["detect purchases", "find subscriptions"],
};

const MPESA_GRANT: ConnectInput = {
  connectionId: "conn_mpesa",
  adapterId: "sms",
  kind: "sms",
  label: "M-Pesa SMS alerts",
  provider: "Safaricom",
  scopes: ["READ_SMS: MPESA sender only"],
  purposes: ["detect purchases"],
};

describe("consent registry", () => {
  it("grants an active connection with the kind's minimal default retention and records a receipt", () => {
    const clock = fixedClock(T0);
    const reg = createConsentRegistry({ clock });
    const c = reg.connect(SMS_GRANT);

    expect(c).toMatchObject({
      connectionId: "conn_hdfc_sms",
      adapterId: "sms",
      kind: "sms",
      label: "HDFC Bank SMS alerts",
      provider: "HDFC Bank",
      status: "active",
      scopes: ["READ_SMS: bank senders only"],
      purposes: ["detect purchases"],
      grantedAt: T0,
      updatedAt: T0,
    });
    expect(c.retention).toEqual(DEFAULT_RETENTION.sms);
    expect(c.revokedAt).toBeUndefined();
    expect(reg.isActive("conn_hdfc_sms")).toBe(true);
    expect(reg.get("conn_hdfc_sms")).toEqual(c);
    expect(reg.history()).toEqual([
      { connectionId: "conn_hdfc_sms", action: "granted", at: T0, scopes: ["READ_SMS: bank senders only"], purposes: ["detect purchases"] },
    ]);
  });

  it("accepts an explicit retention policy and rejects invalid ones", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    const strict: RetentionPolicy = { excerptTtlMs: 0, observationTtlMs: 90 * DAY };
    expect(reg.connect({ ...PLAID_GRANT, retention: strict }).retention).toEqual(strict);

    for (const bad of [
      { excerptTtlMs: -1, observationTtlMs: null },
      { excerptTtlMs: Number.NaN, observationTtlMs: null },
      { excerptTtlMs: 0, observationTtlMs: Number.POSITIVE_INFINITY },
      { excerptTtlMs: 0, observationTtlMs: -DAY },
    ]) {
      expect(() => reg.connect({ ...SMS_GRANT, connectionId: `bad_${String(bad.excerptTtlMs)}_${String(bad.observationTtlMs)}`, retention: bad })).toThrow(ConsentError);
    }
    expect(() => validateRetentionPolicy({ excerptTtlMs: 0, observationTtlMs: null })).not.toThrow();
  });

  it("rejects duplicate ids, unlabeled sources and consent without a purpose", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    reg.connect(SMS_GRANT);
    expect(() => reg.connect(SMS_GRANT)).toThrow(expect.objectContaining({ code: "duplicate_connection" }));
    expect(() => reg.connect({ ...MPESA_GRANT, label: "  " })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => reg.connect({ ...MPESA_GRANT, purposes: [] })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => reg.connect({ ...MPESA_GRANT, purposes: [" "] })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => reg.connect({ ...MPESA_GRANT, connectionId: "" })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    // A kind with no default policy must state its retention explicitly.
    const unknownKind = { ...MPESA_GRANT, connectionId: "conn_future", kind: "holo_feed" as SignalSourceKind };
    expect(() => reg.connect(unknownKind)).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => reg.connect({ ...unknownKind, kind: "toString" as SignalSourceKind })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    // Failed grants leave no receipt behind.
    expect(reg.history()).toHaveLength(1);
  });

  it("pauses and resumes: paused connections are inactive, repeats are idempotent, every change is a receipt", () => {
    const clock = fixedClock(T0);
    const reg = createConsentRegistry({ clock });
    reg.connect(MPESA_GRANT);

    clock.advance(HOUR);
    const paused = reg.pause("conn_mpesa");
    expect(paused.status).toBe("paused");
    expect(paused.updatedAt).toBe(T0 + HOUR);
    expect(reg.isActive("conn_mpesa")).toBe(false);
    expect(reg.pause("conn_mpesa")).toBe(paused);

    clock.advance(HOUR);
    const resumed = reg.resume("conn_mpesa");
    expect(resumed.status).toBe("active");
    expect(reg.isActive("conn_mpesa")).toBe(true);
    expect(reg.resume("conn_mpesa")).toBe(resumed);

    expect(reg.history().map((e) => [e.action, e.at])).toEqual([
      ["granted", T0],
      ["paused", T0 + HOUR],
      ["resumed", T0 + 2 * HOUR],
    ]);
  });

  it("revokes for good: the purge predicate matches exactly that connection's observations", () => {
    const clock = fixedClock(T0);
    const reg = createConsentRegistry({ clock });
    reg.connect(SMS_GRANT);
    reg.connect(PLAID_GRANT);
    reg.connect(MPESA_GRANT);

    const upi = makeObservation({ source: SRC.hdfcSms, minor: 124_900, currency: "INR", rail: { family: "account_to_account_instant", scheme: "upi" } });
    const upi2 = makeObservation({ source: SRC.hdfcSms, minor: 45_000, currency: "INR" });
    const card = makeObservation({ source: SRC.chaseCard, minor: 2_350, currency: "USD", instrument: { type: "card", last4: "4242" } });
    const mpesa = makeObservation({ source: SRC.mpesa, minor: 245_000, currency: "KES", rail: { family: "mobile_money", scheme: "mpesa" } });

    clock.advance(DAY);
    const { connection, purgePredicate } = reg.revoke("conn_hdfc_sms");
    expect(connection.status).toBe("revoked");
    expect(connection.revokedAt).toBe(T0 + DAY);
    expect(connection.updatedAt).toBe(T0 + DAY);
    expect([upi, upi2, card, mpesa].filter(purgePredicate)).toEqual([upi, upi2]);
    expect(reg.isActive("conn_hdfc_sms")).toBe(false);
    expect(reg.isActive("conn_plaid_chase")).toBe(true);

    // Revocation is final.
    expect(() => reg.resume("conn_hdfc_sms")).toThrow(expect.objectContaining({ code: "revoked" }));
    expect(() => reg.pause("conn_hdfc_sms")).toThrow(expect.objectContaining({ code: "revoked" }));
    expect(() => reg.setRetention("conn_hdfc_sms", DEFAULT_RETENTION.sms)).toThrow(ConsentError);
    expect(() => reg.updateScopes("conn_hdfc_sms", { scopes: [] })).toThrow(ConsentError);

    // Revoking again is harmless and adds no receipt.
    const again = reg.revoke("conn_hdfc_sms");
    expect(again.connection).toBe(connection);
    expect(again.purgePredicate(upi)).toBe(true);
    expect(reg.history().filter((e) => e.action === "revoked")).toHaveLength(1);

    // Re-consent creates a new connection.
    expect(() => reg.connect(SMS_GRANT)).toThrow(expect.objectContaining({ code: "duplicate_connection" }));
    const fresh = reg.connect({ ...SMS_GRANT, connectionId: "conn_hdfc_sms_2" });
    expect(fresh.status).toBe("active");
    expect(fresh.grantedAt).toBe(T0 + DAY);
  });

  it("can revoke a paused connection", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    reg.connect(PLAID_GRANT);
    reg.pause("conn_plaid_chase");
    expect(reg.revoke("conn_plaid_chase").connection.status).toBe("revoked");
    expect(reg.history().map((e) => e.action)).toEqual(["granted", "paused", "revoked"]);
  });

  it("throws on unknown ids for every mutation; lookups fail closed", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    for (const act of [
      () => reg.pause("nope"),
      () => reg.resume("nope"),
      () => reg.revoke("nope"),
      () => reg.setRetention("nope", DEFAULT_RETENTION.email),
      () => reg.updateScopes("nope", { scopes: ["x"] }),
    ]) {
      expect(act).toThrow(expect.objectContaining({ code: "unknown_connection", connectionId: "nope" }));
    }
    expect(reg.get("nope")).toBeUndefined();
    // Signals from a connection BRAKE has no consent record for are dropped.
    expect(reg.isActive("nope")).toBe(false);
  });

  it("records retention and scope changes with the scopes in force at the time", () => {
    const clock = fixedClock(T0);
    const reg = createConsentRegistry({ clock });
    reg.connect(PLAID_GRANT);

    clock.advance(MINUTE);
    const shorter = reg.setRetention("conn_plaid_chase", { excerptTtlMs: 0, observationTtlMs: 365 * DAY });
    expect(shorter.retention).toEqual({ excerptTtlMs: 0, observationTtlMs: 365 * DAY });
    expect(shorter.updatedAt).toBe(T0 + MINUTE);
    expect(() => reg.setRetention("conn_plaid_chase", { excerptTtlMs: -5, observationTtlMs: null })).toThrow(ConsentError);

    clock.advance(MINUTE);
    const narrowed = reg.updateScopes("conn_plaid_chase", { purposes: ["detect purchases"] });
    expect(narrowed.purposes).toEqual(["detect purchases"]);
    expect(narrowed.scopes).toEqual(["transactions"]);
    expect(() => reg.updateScopes("conn_plaid_chase", { purposes: [] })).toThrow(ConsentError);

    const h = reg.history();
    expect(h.map((e) => e.action)).toEqual(["granted", "retention_changed", "scopes_changed"]);
    expect(h[0]!.purposes).toEqual(["detect purchases", "find subscriptions"]);
    expect(h[2]).toEqual({ connectionId: "conn_plaid_chase", action: "scopes_changed", at: T0 + 2 * MINUTE, scopes: ["transactions"], purposes: ["detect purchases"] });
  });

  it("keeps receipts append-only and immune to callers mutating returned values", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    const scopes = ["READ_SMS"];
    const c = reg.connect({ ...SMS_GRANT, scopes });
    scopes.push("READ_CONTACTS"); // the caller's array changing later must not widen the grant
    expect(reg.get(c.connectionId)!.scopes).toEqual(["READ_SMS"]);

    const h = reg.history();
    h.pop();
    expect(reg.history()).toHaveLength(1);
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => (c.scopes as string[]).push("x")).toThrow(TypeError);
    expect(() => {
      (reg.history()[0] as { action: string }).action = "revoked";
    }).toThrow(TypeError);
  });

  it("lists connections in grant order and round-trips through a snapshot", () => {
    const clock = fixedClock(T0);
    const reg = createConsentRegistry({ clock });
    reg.connect(MPESA_GRANT);
    clock.advance(MINUTE);
    reg.connect(SMS_GRANT);
    clock.advance(MINUTE);
    reg.connect(PLAID_GRANT);
    reg.revoke("conn_hdfc_sms");

    expect(reg.list().map((c) => c.connectionId)).toEqual(["conn_mpesa", "conn_hdfc_sms", "conn_plaid_chase"]);

    const snap = JSON.parse(JSON.stringify(reg.snapshot()));
    const restored = createConsentRegistry({ clock, restore: snap });
    expect(restored.list()).toEqual(reg.list());
    expect(restored.history()).toEqual(reg.history());
    expect(restored.isActive("conn_hdfc_sms")).toBe(false);
    expect(() => restored.resume("conn_hdfc_sms")).toThrow(ConsentError);
    expect(() => createConsentRegistry({ clock, restore: { ...snap, version: 2 } })).toThrow(RangeError);
  });

  it("takes every timestamp from the injected clock", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("library code must not read the system clock");
    });
    const clock = fixedClock(Date.UTC(2026, 9, 4));
    const reg = createConsentRegistry({ clock });
    reg.connect(PLAID_GRANT);
    clock.advance(DAY);
    expect(reg.revoke("conn_plaid_chase").connection.revokedAt).toBe(Date.UTC(2026, 9, 5));
  });

  it("exposes the same purge predicate standalone", () => {
    const o = makeObservation({ source: SRC.n26, minor: 8_999, currency: "EUR" });
    expect(connectionPurgePredicate("conn_n26")(o)).toBe(true);
    expect(connectionPurgePredicate("conn_nubank")(o)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Retention                                                           */
/* ------------------------------------------------------------------ */

/** Every source kind; the Record type makes the compiler flag a missing one. */
const ALL_KINDS: Record<SignalSourceKind, true> = {
  open_banking: true,
  account_aggregator: true,
  card_feed: true,
  issuer_webhook: true,
  neobank_api: true,
  wallet_history: true,
  os_wallet: true,
  notification: true,
  sms: true,
  messaging: true,
  email: true,
  payment_intent: true,
  qr_scan: true,
  checkout: true,
  merchant_partner: true,
  payment_partner: true,
  manual: true,
  receipt: true,
  share: true,
  voice: true,
  barcode: true,
  browser_extension: true,
  app_activity: true,
  user_rule: true,
};
const KINDS = Object.keys(ALL_KINDS) as SignalSourceKind[];

describe("default retention", () => {
  it("defines a valid, frozen policy for every source kind", () => {
    expect(Object.keys(DEFAULT_RETENTION).sort()).toEqual([...KINDS].sort());
    for (const k of KINDS) {
      expect(() => validateRetentionPolicy(DEFAULT_RETENTION[k])).not.toThrow();
      expect(Object.isFrozen(DEFAULT_RETENTION[k])).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_RETENTION)).toBe(true);
  });

  it("lets alert and email excerpts live a week at most", () => {
    for (const k of ["sms", "notification", "email"] as const) {
      expect(DEFAULT_RETENTION[k].excerptTtlMs).toBe(7 * DAY);
    }
    for (const k of KINDS) expect(DEFAULT_RETENTION[k].excerptTtlMs).toBeLessThanOrEqual(7 * DAY);
  });

  it("keeps no excerpt for structured feeds or sources whose text is third-party content", () => {
    for (const k of ["open_banking", "account_aggregator", "card_feed", "wallet_history", "messaging", "share", "voice", "checkout", "browser_extension", "app_activity"] as const) {
      expect(DEFAULT_RETENTION[k].excerptTtlMs).toBe(0);
    }
  });

  it("keeps extracted facts indefinitely only where they are the spending history", () => {
    for (const k of ["open_banking", "account_aggregator", "card_feed", "issuer_webhook", "neobank_api", "wallet_history", "sms", "notification", "manual"] as const) {
      expect(DEFAULT_RETENTION[k].observationTtlMs).toBeNull();
    }
    const finite = (k: SignalSourceKind) => DEFAULT_RETENTION[k].observationTtlMs ?? Number.POSITIVE_INFINITY;
    // Enrichment survives an annual renewal cycle; decision moments a quarter; pure context a month.
    expect(finite("email")).toBeGreaterThanOrEqual(366 * DAY);
    expect(finite("email")).toBeLessThan(Number.POSITIVE_INFINITY);
    for (const k of ["payment_intent", "qr_scan", "checkout", "share", "voice", "barcode", "browser_extension"] as const) {
      expect(finite(k)).toBeLessThan(finite("email"));
    }
    expect(finite("app_activity")).toBeLessThan(finite("qr_scan"));
  });
});

describe("applyRetention", () => {
  const kindOf: Record<string, SignalSourceKind> = Object.fromEntries(Object.values(SRC).map((s) => [s.connectionId, s.kind]));
  const defaults = (connectionId: string): RetentionPolicy => DEFAULT_RETENTION[kindOf[connectionId]!];

  it("strips excerpts whose adapter expiry has passed, keeping the extracted facts", () => {
    const sms = makeObservation({
      source: SRC.hdfcSms,
      minor: 124_900,
      currency: "INR",
      merchant: merchant("AMAZON", { handle: "amazon@apl" }),
      evidence: { summary: "HDFC Bank SMS: ₹1,249.00 debited to AMAZON (UPI)", excerpt: "Rs.1249.00 debited from A/c XX1234 to VPA amazon@apl", excerptExpiresAt: T0 + 3 * DAY },
    });
    const { keep, dropIds, strippedIds } = applyRetention([sms], defaults, T0 + 3 * DAY, new Set());
    expect(dropIds).toEqual([]);
    expect(strippedIds).toEqual([sms.id]);
    expect(keep).toHaveLength(1);
    const kept = keep[0]!;
    expect(kept.evidence).toEqual({ summary: "HDFC Bank SMS: ₹1,249.00 debited to AMAZON (UPI)" });
    expect("excerpt" in kept.evidence).toBe(false);
    expect("excerptExpiresAt" in kept.evidence).toBe(false);
    expect({ ...kept, evidence: null }).toEqual({ ...sms, evidence: null });
    // The input is not mutated.
    expect(sms.evidence.excerpt).toBeDefined();
  });

  it("applies the stricter of the adapter expiry and a user-shortened policy", () => {
    const pix = makeObservation({
      source: SRC.nubank,
      minor: 15_990,
      currency: "BRL",
      rail: { family: "account_to_account_instant", scheme: "pix" },
      evidence: { summary: "Nubank: Pix de R$ 159,90 enviado", excerpt: "Transferência Pix de R$ 159,90 para Padaria Real", excerptExpiresAt: T0 + 7 * DAY },
    });
    const oneDay: RetentionPolicy = { excerptTtlMs: DAY, observationTtlMs: null };
    expect(applyRetention([pix], () => oneDay, T0 + 2 * DAY, new Set()).strippedIds).toEqual([pix.id]);
    expect(applyRetention([pix], defaults, T0 + 2 * DAY, new Set()).strippedIds).toEqual([]);
  });

  it("returns untouched observations as the same objects", () => {
    const email = makeObservation({
      source: SRC.gmail,
      kind: "receipt",
      minor: 124_900,
      evidence: { summary: "Amazon receipt", excerpt: "Your order of headphones", excerptExpiresAt: T0 + 7 * DAY },
    });
    const plain = makeObservation({ source: SRC.chaseCard, minor: 2_350, currency: "USD" });
    const r = applyRetention([email, plain], defaults, T0 + DAY, new Set());
    expect(r.keep[0]).toBe(email);
    expect(r.keep[1]).toBe(plain);
    expect(r.strippedIds).toEqual([]);
  });

  it("strips at once when a source keeps no excerpts, even without an adapter expiry", () => {
    const sepa = makeObservation({
      source: SRC.n26,
      minor: 8_999,
      currency: "EUR",
      rail: { family: "account_to_account_batch", scheme: "sepa" },
      evidence: { summary: "SEPA debit Vodafone", excerpt: "SEPA-Lastschrift Vodafone GmbH" },
    });
    const r = applyRetention([sepa], defaults, sepa.receivedAt, new Set());
    expect(r.strippedIds).toEqual([sepa.id]);
    expect(r.keep[0]!.evidence.excerpt).toBeUndefined();
  });

  it("drops observations past their TTL unless a user assertion anchors them", () => {
    const order = makeObservation({
      source: SRC.gmail,
      kind: "order",
      minor: 8_999,
      currency: "EUR",
      evidence: { summary: "Zalando order", excerpt: "Your Zalando order", excerptExpiresAt: T0 + 7 * DAY },
    });
    const labelled = makeObservation({ source: SRC.gmail, kind: "receipt", minor: 4_500, currency: "EUR" });
    const now = T0 + 401 * DAY;
    const r = applyRetention([order, labelled], defaults, now, new Set([labelled.id]));
    expect(r.dropIds).toEqual([order.id]);
    expect(r.keep.map((o) => o.id)).toEqual([labelled.id]);

    // Anchoring keeps the fact, never the text.
    const r2 = applyRetention([order], defaults, now, new Set([order.id]));
    expect(r2.dropIds).toEqual([]);
    expect(r2.keep[0]!.evidence.excerpt).toBeUndefined();
    expect(r2.strippedIds).toEqual([order.id]);
  });

  it("never drops observations whose policy keeps them until disconnect", () => {
    const old = makeObservation({ source: SRC.chaseCard, minor: 2_350, currency: "USD", receivedAt: T0 - 5 * 365 * DAY });
    expect(applyRetention([old], defaults, T0, new Set()).dropIds).toEqual([]);
  });

  it("measures fact age from the event, so backfills expire on schedule and future dates cannot extend retention", () => {
    const backfilled = makeObservation({
      source: SRC.outlook,
      kind: "receipt",
      minor: 2_350,
      currency: "USD",
      receivedAt: T0,
      occurredAt: { value: T0 - 2 * 365 * DAY, confidence: 0.9 },
    });
    const futureDated = makeObservation({
      source: SRC.outlook,
      kind: "subscription_event",
      minor: 1_549,
      currency: "USD",
      receivedAt: T0 - 401 * DAY,
      occurredAt: { value: T0 + 365 * DAY, confidence: 0.4 },
    });
    expect(retentionAnchor(backfilled)).toBe(T0 - 2 * 365 * DAY);
    expect(retentionAnchor(futureDated)).toBe(T0 - 401 * DAY);
    const policyFor = () => DEFAULT_RETENTION.email;
    expect(applyRetention([backfilled, futureDated], policyFor, T0, new Set()).dropIds).toEqual([backfilled.id, futureDated.id]);
  });

  it("handles a multi-country store in input order and asks for each connection's policy once", () => {
    const now = T0 + 30 * DAY;
    const fresh = (src: SourceRef, extra: Partial<Observation> & { minor?: number; currency?: string }) =>
      makeObservation({ source: src, receivedAt: now - HOUR, evidence: { summary: "s", excerpt: "e", excerptExpiresAt: now + 6 * DAY }, ...extra });
    const store = [
      makeObservation({ source: SRC.hdfcSms, minor: 124_900, currency: "INR", evidence: { summary: "UPI debit", excerpt: "Rs.1249.00 debited", excerptExpiresAt: T0 + 7 * DAY } }),
      makeObservation({ source: SRC.chaseCard, minor: 2_350, currency: "USD", instrument: { type: "card", last4: "4242" } }),
      fresh(SRC.n26, { minor: 8_999, currency: "EUR" }),
      makeObservation({ source: SRC.gmail, kind: "invoice", minor: 8_999, currency: "EUR", receivedAt: T0 - 400 * DAY }),
      fresh(SRC.nubank, { minor: 15_990, currency: "BRL" }),
      makeObservation({ source: SRC.mpesa, minor: 245_000, currency: "KES", receivedAt: T0 - 3 * 365 * DAY }),
    ];
    const policyFor = vi.fn(defaults);
    const r = applyRetention(store, policyFor, now, new Set());

    expect(r.dropIds).toEqual([store[3]!.id]); // the year-old invoice email
    expect(r.keep.map((o) => o.id)).toEqual([store[0], store[1], store[2], store[4], store[5]].map((o) => o!.id));
    // INR SMS excerpt expired; EUR open-banking excerpt not allowed at all; BRL notification still fresh.
    expect(r.strippedIds).toEqual([store[0]!.id, store[2]!.id]);
    expect(r.keep[3]!.evidence.excerpt).toBe("e");
    expect(policyFor).toHaveBeenCalledTimes(new Set(store.map((o) => o.source.connectionId)).size);
  });

  it("works with policies resolved through the consent registry", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    reg.connect({ ...MPESA_GRANT, retention: { excerptTtlMs: 0, observationTtlMs: 30 * DAY } });
    const mpesa = makeObservation({ source: SRC.mpesa, minor: 245_000, currency: "KES", receivedAt: T0 - 31 * DAY });
    const r = applyRetention([mpesa], (id) => reg.get(id)?.retention, T0, new Set());
    expect(r.dropIds).toEqual([mpesa.id]);
  });

  it("strips text but never deletes facts for a connection with no known policy", () => {
    const pix = makeObservation({
      source: SRC.nubank,
      currency: "BRL",
      receivedAt: T0 - 5 * 365 * DAY,
      evidence: { summary: "Pix", excerpt: "Pix enviado", excerptExpiresAt: T0 + DAY },
    });
    const r = applyRetention([pix], () => undefined, T0, new Set());
    expect(r.dropIds).toEqual([]);
    expect(r.strippedIds).toEqual([pix.id]);
  });
});

/* ------------------------------------------------------------------ */
/* Explanations                                                        */
/* ------------------------------------------------------------------ */

function hdfcAlert(extra: Partial<Observation> & { minor?: number; currency?: string } = {}): Observation {
  return makeObservation({
    source: SRC.hdfcNotification,
    minor: 124_900,
    currency: "INR",
    merchant: merchant("AMAZON", { handle: "amazon@apl" }),
    rail: { family: "account_to_account_instant", scheme: "upi" },
    evidence: { summary: "HDFC Bank: ₹1,249.00 debited to AMAZON (UPI)" },
    ...extra,
  });
}

function amazonReceipt(extra: Partial<Observation> = {}): Observation {
  return makeObservation({
    source: SRC.gmail,
    kind: "receipt",
    minor: 124_900,
    currency: "INR",
    receivedAt: T0 + MINUTE,
    merchant: merchant("Amazon.in", { name: "Amazon", key: "amazon" }),
    evidence: { summary: "Amazon receipt" },
    ...extra,
  });
}

describe("explainCandidate — headline", () => {
  it("names the single source by its label", () => {
    const alert = hdfcAlert();
    const e = explainCandidate(candidateOf([alert]), [alert], IN);
    expect(e.headline).toBe("Detected from your HDFC Bank transaction notification.");
  });

  it("matches a bank transaction with a receipt", () => {
    const bank = makeObservation({ source: SRC.hdfcAccount, stage: "posted", minor: 124_900, currency: "INR", receivedAt: T0 + 2 * HOUR });
    const receipt = amazonReceipt();
    const e = explainCandidate(candidateOf([bank, receipt]), [bank, receipt], IN);
    expect(e.headline).toBe("Matched your bank transaction with an Amazon receipt.");
  });

  it("chooses the document noun by observation kind, with the right article", () => {
    const bank = makeObservation({ source: SRC.hdfcAccount, minor: 124_900 });
    const doc = (kind: Observation["kind"], name?: string) =>
      makeObservation({ source: SRC.gmail, kind, receivedAt: T0 + MINUTE, ...(name ? { merchant: merchant(name) } : {}) });
    const headline = (o: Observation) => explainCandidate(candidateOf([bank, o]), [bank, o], IN).headline;

    expect(headline(doc("order", "Amazon"))).toBe("Matched your bank transaction with an Amazon order confirmation.");
    expect(headline(doc("receipt", "Uber"))).toBe("Matched your bank transaction with an Uber receipt.");
    expect(headline(doc("receipt", "Uniqlo"))).toBe("Matched your bank transaction with a Uniqlo receipt.");
    expect(headline(doc("invoice"))).toBe("Matched your bank transaction with an invoice.");
    expect(headline(doc("invoice", "Vodafone"))).toBe("Matched your bank transaction with a Vodafone invoice.");
    expect(headline(doc("subscription_event", "Netflix"))).toBe("Matched your bank transaction with a Netflix subscription email.");
    expect(headline(doc("subscription_event"))).toBe("Matched your bank transaction with a subscription email.");
    expect(headline(doc("booking", "Europcar"))).toBe("Matched your bank transaction with a Europcar booking.");
    expect(headline(doc("booking", "Airbnb"))).toBe("Matched your bank transaction with an Airbnb booking.");
    expect(headline(doc("booking"))).toBe("Matched your bank transaction with a booking.");
    expect(headline(doc("order"))).toBe("Matched your bank transaction with an order confirmation.");
    expect(headline(doc("receipt", "HDFC Ergo"))).toBe("Matched your bank transaction with an HDFC Ergo receipt.");
  });

  it("prefers the candidate's display name, then the source provider, when the document names no merchant", () => {
    const bank = makeObservation({ source: SRC.hdfcAccount });
    const bare = makeObservation({ source: { ...SRC.gmail, provider: "Swiggy" }, kind: "receipt", receivedAt: T0 + MINUTE });
    expect(explainCandidate(candidateOf([bank, bare]), [bank, bare], IN).headline).toBe("Matched your bank transaction with a Swiggy receipt.");
    const named = candidateOf([bank, bare], { merchant: { raw: "SWIGGY", normalized: "swiggy", displayName: "Swiggy Instamart", confidence: 0.9, channel: "online" } });
    expect(explainCandidate(named, [bank, bare], IN).headline).toBe("Matched your bank transaction with a Swiggy Instamart receipt.");
  });

  it("reproduces the architecture's running example as one bank transaction matched with an order", () => {
    const alert = hdfcAlert({ instrument: { type: "card", last4: "1234", cardKind: "credit" } });
    const order = makeObservation({ source: SRC.gmail, kind: "order", receivedAt: T0 + MINUTE, merchant: merchant("Amazon"), references: [{ type: "order_id", value: "402-1234567-7654321", namespace: "amazon" }] });
    const pending = makeObservation({ source: SRC.hdfcAccount, stage: "pending", receivedAt: T0 + 2 * MINUTE, merchant: merchant("AMZN PAY INDIA"), instrument: { type: "bank_account", last4: "7890" } });
    const items = makeObservation({ source: SRC.gmail, kind: "order", receivedAt: T0 + 6 * MINUTE, merchant: merchant("Amazon"), lineItems: [{ description: "headphones" }] });
    const obs = [alert, order, pending, items];
    const e = explainCandidate(candidateOf(obs), obs, IN);
    expect(e.headline).toBe("Matched your bank transaction with an Amazon order confirmation.");
    expect(e.details.filter((d) => d.startsWith("From your"))).toHaveLength(4);
  });

  it("names the payment from normalized instrument, rail and source fields — never the provider", () => {
    const card = makeObservation({ source: SRC.chaseCard, stage: "posted", minor: 2_350, currency: "USD", instrument: { type: "card", last4: "4242", cardKind: "credit" } });
    const uber = makeObservation({ source: SRC.outlook, kind: "receipt", minor: 2_350, currency: "USD", receivedAt: T0 + MINUTE, merchant: merchant("Uber") });
    expect(explainCandidate(candidateOf([card, uber]), [card, uber], { locale: "en-US" }).headline).toBe(
      "Matched your card transaction with an Uber receipt.",
    );

    const mpesa = makeObservation({ source: SRC.mpesa, minor: 245_000, currency: "KES", rail: { family: "mobile_money", scheme: "mpesa" } });
    const naivas = makeObservation({ source: SRC.gmail, kind: "receipt", minor: 245_000, currency: "KES", receivedAt: T0 + MINUTE, merchant: merchant("Naivas") });
    expect(explainCandidate(candidateOf([mpesa, naivas]), [mpesa, naivas], { locale: "en-KE" }).headline).toBe(
      "Matched your mobile money payment with a Naivas receipt.",
    );

    const pix = makeObservation({ source: SRC.nubank, minor: 15_990, currency: "BRL", rail: { family: "account_to_account_instant", scheme: "pix" } });
    const ml = makeObservation({ source: SRC.gmail, kind: "order", minor: 15_990, currency: "BRL", receivedAt: T0 + MINUTE, merchant: merchant("Mercado Livre") });
    expect(explainCandidate(candidateOf([pix, ml]), [pix, ml], { locale: "pt-BR" }).headline).toBe(
      "Matched your bank transaction with a Mercado Livre order confirmation.",
    );

    const sepa = makeObservation({ source: SRC.n26, minor: 8_999, currency: "EUR", rail: { family: "account_to_account_batch", scheme: "sepa" } });
    const invoice = makeObservation({ source: SRC.gmail, kind: "invoice", minor: 8_999, currency: "EUR", receivedAt: T0 + MINUTE, merchant: merchant("Vodafone") });
    expect(explainCandidate(candidateOf([sepa, invoice]), [sepa, invoice], { locale: "de-DE" }).headline).toBe(
      "Matched your bank transaction with a Vodafone invoice.",
    );
  });

  it("explains structurally identical events identically, whatever the provider or rail", () => {
    const shape = (src: SourceRef, currency: string, scheme: string) => {
      const o = makeObservation({ source: src, minor: 50_000, currency, rail: { family: "account_to_account_instant", scheme } });
      const e = explainCandidate(candidateOf([o], { currency, minor: 50_000 }), [o], { locale: "en" });
      return allText(e).map((t) => t.replace(src.label, "<label>"));
    };
    const upi = shape(SRC.hdfcNotification, "INR", "upi");
    expect(shape(SRC.nubank, "BRL", "pix")).toEqual(upi);
    expect(shape(SRC.mpesa, "KES", "mpesa")).toEqual(upi);
  });

  it("names several sources when no document explains the payment", () => {
    const alert = hdfcAlert();
    const ledger = makeObservation({ source: SRC.hdfcAccount, stage: "posted", receivedAt: T0 + DAY });
    expect(explainCandidate(candidateOf([alert, ledger]), [alert, ledger], IN).headline).toBe(
      "Detected from your HDFC Bank transaction notification and your HDFC Bank account.",
    );
    const sms = makeObservation({ source: SRC.hdfcSms, receivedAt: T0 + MINUTE });
    expect(explainCandidate(candidateOf([alert, sms, ledger]), [alert, sms, ledger], IN).headline).toBe(
      "Detected from your HDFC Bank transaction notification and 2 other sources.",
    );
    // Two observations from one source are one source.
    const posted = makeObservation({ source: SRC.hdfcAccount, stage: "posted", receivedAt: T0 + DAY });
    const pending = makeObservation({ source: SRC.hdfcAccount, stage: "pending", receivedAt: T0 });
    expect(explainCandidate(candidateOf([pending, posted]), [pending, posted], IN).headline).toBe("Detected from your HDFC Bank account.");
  });

  it("credits the user for manual entries", () => {
    const cash = makeObservation({ source: SRC.manual, minor: 20_000, currency: "INR", rail: { family: "cash" } });
    const e = explainCandidate(candidateOf([cash]), [cash], IN);
    expect(e.headline).toBe("You added this yourself.");
    expect(e.details[0]).toMatch(/^Added by you: a payment, 4 Oct at 10:41\sam\.$/);
  });

  it("says so when no source is available", () => {
    const e = explainCandidate(makeCandidate(), [], IN);
    expect(e.headline).toBe("No source details are available for this.");
  });
});

describe("explainCandidate — details", () => {
  it("lists every contributing source with label, kind and local time, oldest first", () => {
    const alert = hdfcAlert();
    const receipt = amazonReceipt();
    const ledger = makeObservation({ source: SRC.hdfcAccount, stage: "posted", receivedAt: T0 + DAY });
    const e = explainCandidate(candidateOf([ledger, receipt, alert]), [ledger, receipt, alert], IN);
    expect(e.details.slice(0, 3)).toEqual([
      expect.stringMatching(/^From your HDFC Bank transaction notification: a payment, 4 Oct at 10:41\sam\.$/),
      expect.stringMatching(/^From your Gmail inbox: an Amazon receipt, 4 Oct at 10:42\sam\.$/),
      expect.stringMatching(/^From your HDFC Bank account: a posted payment, 5 Oct at 10:41\sam\.$/),
    ]);
  });

  it("describes money movements by direction and stage, and other kinds by what they are", () => {
    const credit = makeObservation({ source: SRC.n26, direction: "credit", stage: "pending", minor: 4_500, currency: "EUR" });
    const intent = makeObservation({ source: { ...SRC.manual, kind: "share", label: "shares to BRAKE" }, kind: "purchase_intent", receivedAt: T0 - HOUR });
    const e = explainCandidate(candidateOf([intent, credit]), [intent, credit], { locale: "en-GB" });
    expect(e.details[0]).toMatch(/^From your shares to BRAKE: a purchase you were considering, 4 Oct at/);
    expect(e.details[1]).toMatch(/^From your N26 account: a pending credit, 4 Oct at/);
  });

  it("uses the locale's date order and the given time zone, defaulting to UTC", () => {
    const card = makeObservation({ source: SRC.chaseCard, minor: 2_350, currency: "USD" });
    const ny = explainCandidate(candidateOf([card]), [card], { locale: "en-US", timeZone: "America/New_York" });
    expect(ny.details[0]).toMatch(/Oct 4 at 1:11\sAM\.$/);
    const utc = explainCandidate(candidateOf([card]), [card], { locale: "en-US" });
    expect(utc.details[0]).toMatch(/Oct 4 at 5:11\sAM\.$/);
    // Unknown zones and locales degrade instead of throwing.
    expect(() => explainCandidate(candidateOf([card]), [card], { locale: "zz-INVALID-x", timeZone: "Mars/Olympus" })).not.toThrow();
  });

  it("adds the year when a source is from a different year than the event", () => {
    const old = makeObservation({ source: SRC.gmail, kind: "subscription_event", merchant: merchant("Netflix"), receivedAt: Date.UTC(2025, 9, 4, 12) });
    const charge = makeObservation({ source: SRC.chaseCard, minor: 1_549, currency: "USD" });
    const e = explainCandidate(candidateOf([old, charge]), [old, charge], { locale: "en-US" });
    expect(e.details[0]).toMatch(/Oct 4, 2025 at/);
    expect(e.details[1]).toMatch(/Oct 4 at/);
  });

  it("only uses the candidate's own sources, falling back to the source signal when an observation is gone", () => {
    const alert = hdfcAlert();
    const unrelated = makeObservation({ source: SRC.mpesa, minor: 245_000, currency: "KES" });
    const gone = makeObservation({ source: SRC.gmail, kind: "order", receivedAt: T0 + MINUTE, merchant: merchant("Amazon") });
    const c = candidateOf([alert, gone]);
    const e = explainCandidate(c, [alert, unrelated], IN);
    expect(e.details.some((d) => d.includes("M-Pesa"))).toBe(false);
    expect(e.details[1]).toMatch(/^From your Gmail inbox: an order confirmation, 4 Oct at 10:42\sam\.$/);
  });

  it("says 'You confirmed this.' only for user-verified candidates", () => {
    const alert = hdfcAlert();
    expect(explainCandidate(candidateOf([alert], { userVerified: true }), [alert], IN).details).toContain("You confirmed this.");
    expect(explainCandidate(candidateOf([alert]), [alert], IN).details).not.toContain("You confirmed this.");
  });

  it("explains a non-obvious merchant name", () => {
    const alert = hdfcAlert();
    const shown = (raw: string, displayName: string) =>
      explainCandidate(candidateOf([alert], { merchant: { raw, normalized: "x", displayName, confidence: 0.9, channel: "online" } }), [alert], IN).details;
    expect(shown("AMZN PAY INDIA", "Amazon")).toContain("Shown as Amazon (listed as “AMZN PAY INDIA”).");
    expect(shown("AMAZON", "Amazon").some((d) => d.startsWith("Shown as"))).toBe(false);
    expect(shown("SWIGGY BANGALORE", "Swiggy").some((d) => d.startsWith("Shown as"))).toBe(false);
  });
});

describe("explainCandidate — inference bases", () => {
  const amazon = { raw: "AMZN PAY INDIA", normalized: "amazon", displayName: "Amazon", confidence: 0.95, channel: "online" as const };

  it("explains a category learned from the user's own history", () => {
    const alert = hdfcAlert();
    const c = candidateOf([alert], { merchant: amazon, category: { ...inference("shopping", 0.9), basis: ["user_history"] } });
    expect(explainCandidate(c, [alert], IN).details).toContain("Categorised as Shopping because you've labelled Amazon as Shopping before.");
  });

  it("explains a category from the merchant's category code", () => {
    const card = makeObservation({ source: SRC.chaseCard, minor: 8_412, currency: "USD", merchant: merchant("WHOLEFDS MKT 10234", { mcc: "5411" }) });
    const c = candidateOf([card], { category: { ...inference("groceries", 0.88), basis: ["source_hint"] } });
    expect(explainCandidate(c, [card], { locale: "en-US" }).details).toContain("Categorised as Groceries based on the merchant's category code.");
  });

  it("names the source of a provider category when there is no merchant code", () => {
    const sepa = makeObservation({ source: SRC.n26, minor: 8_999, currency: "EUR", categoryHints: [{ scheme: "provider", value: "telecom", confidence: 0.8 }] });
    const c = candidateOf([sepa], { category: { ...inference("bills.phone_internet", 0.8), basis: ["source_hint"] } });
    expect(explainCandidate(c, [sepa], { locale: "en-IE", categoryLabel: (id) => (id === "bills.phone_internet" ? "Phone & internet" : id) }).details).toContain(
      "Categorised as Phone & internet based on the category from your N26 account.",
    );
  });

  it("combines several bases and names the itemised document", () => {
    const bank = makeObservation({ source: SRC.hdfcAccount, minor: 479_900 });
    const order = makeObservation({ source: SRC.gmail, kind: "order", receivedAt: T0 + MINUTE, merchant: merchant("Amazon", { mcc: "5942" }), lineItems: [{ description: "dog food" }] });
    const c = candidateOf([bank, order], { category: { ...inference("pets", 0.9), basis: ["line_items", "source_hint", "user_history"] }, merchant: amazon });
    expect(explainCandidate(c, [bank, order], IN).details).toContain(
      "Categorised as Pets based on the items in your Amazon order and the merchant's category code, and because you've labelled Amazon as Pets before.",
    );
  });

  it("states user labels as the user's own, and never as a guess", () => {
    const alert = hdfcAlert();
    const c = candidateOf([alert], { category: userInference("health"), transactionType: userInference("credit_card_payment") });
    const d = explainCandidate(c, [alert], { ...IN, categoryLabel: (id) => (id === "health" ? "Medical" : id) }).details;
    expect(d).toContain("You labelled this as Medical.");
    expect(d).toContain("You marked this as a credit card bill payment.");
    expect(d.some((l) => l.includes("isn't sure"))).toBe(false);
  });

  it("hedges low-confidence inferences and mentions likely alternatives", () => {
    const alert = hdfcAlert();
    const c = candidateOf([alert], {
      category: { ...inference("shopping", 0.45, [["household", 0.35], ["groceries", 0.1]]), basis: ["prior"] },
      transactionType: { ...inference("purchase", 0.55, [["transfer", 0.4]]), basis: ["prior"] },
    });
    const d = explainCandidate(c, [alert], IN).details;
    expect(d).toContain("Categorised as Shopping based on what's typical for payments like this.");
    expect(d).toContain("BRAKE isn't sure about this category yet.");
    expect(d).toContain("It could also be Household.");
    expect(d).toContain("Treated as a purchase based on what's typical for payments like this.");
    expect(d).toContain("BRAKE isn't sure what kind of payment this is yet.");
    expect(d).toContain("It could also be a transfer.");
  });

  it("stays silent about categories and types BRAKE has not inferred", () => {
    const alert = hdfcAlert();
    const d = explainCandidate(candidateOf([alert]), [alert], IN).details;
    expect(d.some((l) => l.startsWith("Categorised"))).toBe(false);
    expect(d.some((l) => l.startsWith("Treated as"))).toBe(false);
  });

  it("explains transaction types from reconciliation, history and source hints", () => {
    const debit = makeObservation({ source: SRC.hdfcAccount, minor: 5_000_000, typeHints: [{ type: "transfer", confidence: 0.7, reason: "narration:self" }] });
    const own = candidateOf([debit], { transactionType: { ...inference("transfer", 0.92), basis: ["reconciliation", "source_hint"] }, transferKind: "own_account" });
    expect(explainCandidate(own, [debit], IN).details).toContain(
      "Treated as a transfer between your own accounts because it matched another of your transactions, and based on how your HDFC Bank account described it.",
    );

    const p2p = makeObservation({ source: SRC.mpesa, minor: 150_000, currency: "KES", counterparty: { name: "Wanjiru" } });
    const family = candidateOf([p2p], { counterparty: { name: "Wanjiru" }, transactionType: { ...inference("transfer", 0.9), basis: ["user_history"] }, transferKind: "family" });
    expect(explainCandidate(family, [p2p], { locale: "en-KE" }).details).toContain("Treated as a transfer to family because you've marked payments to Wanjiru this way before.");

    const salary = makeObservation({ source: SRC.nubank, direction: "credit", minor: 500_000, currency: "BRL" });
    const income = candidateOf([salary], { direction: "credit", counterparty: { name: "Acme Ltda" }, transactionType: { ...inference("income", 0.9), basis: ["recurrence", "user_history"] } });
    expect(explainCandidate(income, [salary], { locale: "pt-BR" }).details).toContain(
      "Treated as income because it repeats on a regular schedule and you've marked payments from Acme Ltda this way before.",
    );
  });
});

describe("explainCandidate — reconciliation links", () => {
  const original = makeCandidate({ id: "cand_original", timestampEstimated: Date.UTC(2026, 9, 2, 6, 30) });
  const resolve = (id: string) => (id === original.id ? original : undefined);
  const link = (kind: CandidateLink["kind"], probability = 0.95, target = original.id): CandidateLink => ({ kind, target, probability, createdAt: T0 });
  const refundCredit = makeObservation({ source: SRC.hdfcNotification, direction: "credit", minor: 124_900 });
  const linesFor = (links: CandidateLink[], opts: ExplainOptions = { ...IN, resolveCandidate: resolve }, p: Partial<TransactionCandidate> = {}) =>
    explainCandidate(candidateOf([refundCredit], { direction: "credit", links, ...p }), [refundCredit], opts).details;

  it("names the refunded purchase by its date", () => {
    expect(linesFor([link("refund_of")])).toContain("Matched as a refund of your 2 Oct purchase.");
    expect(linesFor([link("refund_of")], { locale: "en-US", resolveCandidate: resolve })).toContain("Matched as a refund of your Oct 2 purchase.");
  });

  it("hedges uncertain links instead of stating them", () => {
    expect(linesFor([link("refund_of", 0.7)])).toContain("Looks like a refund of your 2 Oct purchase.");
    expect(linesFor([link("refund_of", 0.4)])).toContain("Might be a refund of your 2 Oct purchase.");
  });

  it("still explains links it cannot resolve", () => {
    expect(linesFor([link("refund_of")], IN)).toContain("Matched as a refund of an earlier purchase.");
  });

  it("explains every link kind", () => {
    const d = linesFor([
      link("refunded_by"),
      link("reimbursement_of"),
      link("transfer_counterpart"),
      link("card_payment_for"),
      link("recurring_series", 0.9, "series_netflix"),
      link("possible_duplicate", 0.6),
    ]);
    expect(d).toEqual(
      expect.arrayContaining([
        "Matched as a purchase that was refunded on 2 Oct.",
        "Matched as a reimbursement for your 2 Oct purchase.",
        "Matched as one side of a transfer between your accounts (the other side is from 2 Oct).",
        "Matched as a payment towards your card bill.",
        "Matched as part of a recurring payment.",
        "This might be the same payment as another one from 2 Oct, so BRAKE is keeping them separate for now.",
      ]),
    );
    expect(linesFor([link("intent_outcome")])).toContain("Linked to a purchase you were considering on 2 Oct.");
    expect(linesFor([link("intent_outcome", 0.7)], undefined, { status: "intent" })).toContain("Looks linked to your 2 Oct purchase.");
  });
});

describe("explainCandidate — privacy of explanations", () => {
  const smsText = "Rs.1249.00 debited from A/c XX1234 on 04-10-26 to VPA amazon@apl (UPI Ref No 627712345678). Not you? Call 18002586161";

  it("shows an excerpt only while it is present and unexpired, and only when the caller can check expiry", () => {
    const withExcerpt = hdfcAlert({ evidence: { summary: "s", excerpt: smsText, excerptExpiresAt: T0 + 7 * DAY } });
    const c = candidateOf([withExcerpt]);
    const shown = explainCandidate(c, [withExcerpt], { ...IN, now: T0 + DAY }).details;
    expect(shown.some((d) => d.startsWith("Excerpt: “Rs.1249.00 debited from A/c XX1234"))).toBe(true);
    expect(explainCandidate(c, [withExcerpt], { ...IN, now: T0 + 7 * DAY }).details.some((d) => d.startsWith("Excerpt"))).toBe(false);
    expect(explainCandidate(c, [withExcerpt], IN).details.some((d) => d.startsWith("Excerpt"))).toBe(false);

    const noExpiry = hdfcAlert({ evidence: { summary: "s", excerpt: smsText } });
    expect(explainCandidate(candidateOf([noExpiry]), [noExpiry], { ...IN, now: T0 }).details.some((d) => d.startsWith("Excerpt"))).toBe(false);
  });

  it("never shows one-time passwords or full account numbers", () => {
    const otp = hdfcAlert({ evidence: { summary: "s", excerpt: "482193 is your OTP for txn of Rs 1249.00 at AMAZON", excerptExpiresAt: T0 + DAY } });
    const e1 = explainCandidate(candidateOf([otp]), [otp], { ...IN, now: T0 });
    expect(allText(e1).join(" ")).not.toContain("482193");

    const acct = hdfcAlert({ evidence: { summary: "s", excerpt: "Card 4111 1111 1111 1111 a/c 50100123456789 debited Rs.1249.00", excerptExpiresAt: T0 + DAY } });
    const e2 = explainCandidate(candidateOf([acct]), [acct], { ...IN, now: T0 });
    const text = allText(e2).join(" ");
    expect(text).not.toContain("50100123456789");
    expect(text).not.toContain("4111 1111 1111 1111");
    expect(text).toContain("••••6789");
  });

  it("contains no digit runs longer than four except amounts and dates, wherever the digits came from", () => {
    const leaky = { ...SRC.hdfcSms, label: "HDFC Bank a/c 50100123456789 alerts" };
    const alert = makeObservation({
      source: leaky,
      minor: 12_500_000,
      currency: "INR",
      evidence: { summary: "s", excerpt: `INR 125000.00 credited. ${smsText}`, excerptExpiresAt: T0 + DAY },
    });
    const c = candidateOf([alert], {
      merchant: { raw: "UPI/627712345678/AMAZON", normalized: "amazon", displayName: "Amazon", confidence: 0.9, channel: "online" },
      links: [{ kind: "refund_of", target: "cand_x", probability: 0.9, createdAt: T0 }],
    });
    const e = explainCandidate(c, [alert], { ...IN, now: T0 });
    for (const line of allText(e)) expect(nonAmountLongDigitRuns(line)).toEqual([]);
    expect(allText(e).join(" ")).toContain("125000.00");
    expect(e.details[0]).toContain("HDFC Bank a/c ••••6789 alerts");
  });

  it("does not read the system clock or randomness, and is repeatable", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now called");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random called");
    });
    const alert = hdfcAlert();
    const receipt = amazonReceipt();
    const c = candidateOf([alert, receipt], { userVerified: true, category: { ...inference("shopping", 0.9), basis: ["line_items"] } });
    const a = explainCandidate(c, [alert, receipt], IN);
    const b = explainCandidate(c, [receipt, alert], IN);
    expect(b).toEqual(a);
  });

  it("keeps every sentence neutral in tone", () => {
    const alert = hdfcAlert({ evidence: { summary: "s", excerpt: smsText, excerptExpiresAt: T0 + DAY } });
    const receipt = amazonReceipt({ lineItems: [{ description: "electric toothbrush" }] });
    const corpus: Explanation[] = [
      explainCandidate(
        candidateOf([alert, receipt], {
          userVerified: true,
          merchant: { raw: "AMZN PAY INDIA", normalized: "amazon", displayName: "Amazon", confidence: 0.9, channel: "online" },
          category: { ...inference("personal_care", 0.5, [["shopping", 0.3]]), basis: ["line_items", "user_history", "prior"] },
          transactionType: { ...inference("purchase", 0.5, [["transfer", 0.3]]), basis: ["merchant_profile", "rule"] },
          links: (["refund_of", "refunded_by", "reimbursement_of", "transfer_counterpart", "card_payment_for", "recurring_series", "intent_outcome", "possible_duplicate"] as const).map(
            (kind, i) => ({ kind, target: `t${i}`, probability: [0.95, 0.7, 0.3][i % 3]!, createdAt: T0 }),
          ),
        }),
        [alert, receipt],
        { ...IN, now: T0 },
      ),
      explainCandidate(makeCandidate(), [], IN),
      explainCandidate(candidateOf([makeObservation({ source: SRC.manual })]), [], IN),
    ];
    for (const e of corpus) {
      for (const line of allText(e)) {
        expect(toneProblems(line), line).toEqual([]);
        expect(line.trim()).toBe(line);
        expect(line).toMatch(/[.”]$/);
      }
    }
  });
});

describe("explainObservation", () => {
  it("gives the one-line source sentence used in settings", () => {
    expect(explainObservation(makeObservation({ source: SRC.hdfcSms }))).toBe("From your HDFC Bank SMS alerts");
    expect(explainObservation(makeObservation({ source: SRC.nubank, currency: "BRL" }))).toBe("From your Nubank notifications");
    expect(explainObservation(makeObservation({ source: SRC.manual }))).toBe("Added by you");
  });

  it("tolerates labels that already say 'your', and masks long numbers", () => {
    expect(explainObservation(makeObservation({ source: { ...SRC.gmail, label: "Your Gmail inbox" } }))).toBe("From your Gmail inbox");
    expect(explainObservation(makeObservation({ source: { ...SRC.hdfcSms, label: "a/c 50100123456789 alerts" } }))).toBe("From your a/c ••••6789 alerts");
    expect(explainObservation(makeObservation({ source: { ...SRC.hdfcSms, label: "  " } }))).toBe("From your connected source");
  });
});

describe("dataInventory", () => {
  it("summarises what BRAKE keeps per connection, including connections with nothing kept", () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    reg.connect(SMS_GRANT);
    reg.connect(PLAID_GRANT);
    reg.connect(MPESA_GRANT);
    reg.revoke("conn_mpesa");

    const obs = [
      makeObservation({ source: SRC.hdfcSms, receivedAt: T0 - 10 * DAY, evidence: { summary: "s", excerpt: "Rs.500 debited", excerptExpiresAt: T0 } }),
      makeObservation({ source: SRC.hdfcSms, receivedAt: T0 - DAY }),
      makeObservation({ source: SRC.hdfcSms, receivedAt: T0, occurredAt: { value: T0 - 20 * DAY, confidence: 0.6 } }),
      // Leftovers of a revoked connection not yet purged are shown, not hidden.
      makeObservation({ source: SRC.mpesa, currency: "KES", receivedAt: T0 - 2 * DAY }),
    ];
    const inv = dataInventory(reg.list(), obs);
    expect(inv).toEqual([
      { connectionId: "conn_hdfc_sms", label: "HDFC Bank SMS alerts", kind: "sms", status: "active", observationCount: 3, oldestAt: T0 - 20 * DAY, newestAt: T0 - DAY, excerptCount: 1 },
      { connectionId: "conn_plaid_chase", label: "Chase Sapphire card account", kind: "open_banking", status: "active", observationCount: 0, oldestAt: null, newestAt: null, excerptCount: 0 },
      { connectionId: "conn_mpesa", label: "M-Pesa SMS alerts", kind: "sms", status: "revoked", observationCount: 1, oldestAt: T0 - 2 * DAY, newestAt: T0 - 2 * DAY, excerptCount: 0 },
    ]);
  });

  it("lists data from unknown connections after the known ones instead of omitting it", () => {
    const pix = makeObservation({ source: SRC.nubank, currency: "BRL", evidence: { summary: "s", excerpt: "Pix enviado", excerptExpiresAt: T0 + DAY } });
    const sepa = makeObservation({ source: SRC.n26, currency: "EUR" });
    const inv = dataInventory([], [pix, sepa]);
    expect(inv.map((e) => [e.connectionId, e.status, e.label, e.kind, e.observationCount, e.excerptCount])).toEqual([
      ["conn_n26", "unregistered", "N26 account", "open_banking", 1, 0],
      ["conn_nubank", "unregistered", "Nubank notifications", "notification", 1, 1],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Review: regression tests for defects found in adversarial review    */
/* ------------------------------------------------------------------ */

describe("review — no full account numbers from labels or names", () => {
  const pan = "4111 1111 1111 1111";
  const iban = "DE89 3704 0044 0532 0130 00";
  const aadhaar = "2345 6789 0123";

  it("masks grouped card numbers, IBANs and national ids in source labels, merchant and counterparty names", () => {
    const card = makeObservation({ source: { ...SRC.hdfcSms, label: `HDFC Credit Card ${pan} alerts` }, instrument: { type: "card", last4: "1111" } });
    const sepa = makeObservation({ source: { ...SRC.n26, label: `N26 ${iban} account` }, currency: "EUR", receivedAt: T0 + MINUTE });
    const receipt = makeObservation({ source: SRC.gmail, kind: "receipt", receivedAt: T0 + 2 * MINUTE, merchant: merchant(`Shop ${pan}`) });
    const c = candidateOf([card, sepa, receipt], {
      merchant: { raw: "UPI/RAVI", normalized: null, displayName: `Ravi ${aadhaar}`, confidence: 0.5, channel: "unknown" },
      counterparty: { name: `Ravi ${aadhaar}` },
      category: { ...inference("shopping", 0.9), basis: ["user_history"] },
      transactionType: { ...inference("transfer", 0.9), basis: ["user_history"] },
    });
    const text = allText(explainCandidate(c, [card, sepa, receipt], IN)).join("\n");
    for (const secret of [pan, iban, aadhaar, "1111 1111 1111", "3704 0044 0532"]) expect(text).not.toContain(secret);
    expect(text).toContain("HDFC Credit Card ••••1111 alerts");
  });

  it("masks them in the settings sentence and the data inventory too", () => {
    const o = makeObservation({ source: { ...SRC.hdfcSms, label: `Card ${pan.replace(/ /g, "-")} alerts` } });
    expect(explainObservation(o)).toBe("From your Card ••••1111 alerts");
    const inv = dataInventory([], [o]);
    expect(inv[0]!.label).not.toContain("1111-1111");
  });

  it("masks long runs of non-ASCII digits (Arabic-Indic, Devanagari) as well", () => {
    const o = makeObservation({ source: { ...SRC.hdfcSms, label: "حساب ١٢٣٤٥٦٧٨٩٠١٢ alerts" } });
    const e = explainCandidate(candidateOf([o]), [o], IN);
    expect(e.headline).not.toContain("١٢٣٤٥٦٧٨٩٠١٢");
    expect(e.headline).toContain("٩٠١٢");
    expect(explainObservation(makeObservation({ source: { ...SRC.hdfcSms, label: "खाता ५०१००१२३४५६७८९" } }))).not.toContain("५०१००१२३४५६७८९");
  });
});

describe("review — source times are when the source says it happened", () => {
  const july = Date.UTC(2026, 6, 11, 9, 50); // 11 Jul 15:20 IST

  it("shows a backfilled email at its own time, not the day BRAKE fetched it", () => {
    const backfilled = makeObservation({
      source: SRC.gmail,
      kind: "receipt",
      receivedAt: T0,
      occurredAt: { value: july, confidence: 0.95 },
      merchant: merchant("Amazon"),
    });
    const e = explainCandidate(candidateOf([backfilled], { timestampEstimated: july }), [backfilled], IN);
    expect(e.details[0]).toMatch(/^From your Gmail inbox: an Amazon receipt, 11 Jul at 3:20\spm\.$/);
  });

  it("says 'received' when only a date-only event time is known and it arrived later", () => {
    const valueDated = makeObservation({ source: SRC.hdfcAccount, stage: "posted", receivedAt: T0, occurredAt: { value: Date.UTC(2026, 6, 11), confidence: 0.3 } });
    const e = explainCandidate(candidateOf([valueDated], { timestampEstimated: Date.UTC(2026, 6, 11) }), [valueDated], IN);
    expect(e.details[0]).toMatch(/^From your HDFC Bank account: a posted payment, received 4 Oct at 10:41\sam\.$/);
  });

  it("never moves a source's time past when BRAKE received it", () => {
    const futureDated = makeObservation({ source: SRC.chaseCard, minor: 1_549, currency: "USD", receivedAt: T0, occurredAt: { value: T0 + 30 * DAY, confidence: 0.9 } });
    expect(explainCandidate(candidateOf([futureDated]), [futureDated], { locale: "en-US" }).details[0]).toMatch(/Oct 4 at 5:11\sAM\.$/);
  });

  it("orders sources by that time, and the same way whatever order observations arrive in", () => {
    const alert = hdfcAlert({ receivedAt: T0 + HOUR, occurredAt: { value: T0 + HOUR, confidence: 0.95 } });
    const backfilled = makeObservation({ source: SRC.gmail, kind: "order", receivedAt: T0 + 2 * HOUR, occurredAt: { value: T0, confidence: 0.9 }, merchant: merchant("Amazon") });
    const e = explainCandidate(candidateOf([alert, backfilled]), [alert, backfilled], IN);
    expect(e.details[0]).toMatch(/^From your Gmail inbox: an Amazon order confirmation, 4 Oct at 10:41\sam\.$/);

    // Without source signals, equal times must not depend on the caller's array order.
    const a = makeObservation({ source: SRC.n26, currency: "EUR" });
    const b = makeObservation({ source: SRC.nubank, currency: "BRL" });
    const bare = makeCandidate();
    expect(explainCandidate(bare, [a, b], IN)).toEqual(explainCandidate(bare, [b, a], IN));
  });
});

describe("review — transfer direction", () => {
  it("describes incoming family and person-to-person transfers as coming from them", () => {
    const fromMum = makeObservation({ source: SRC.mpesa, direction: "credit", minor: 500_000, currency: "KES", counterparty: { name: "Mum" } });
    const family = candidateOf([fromMum], { direction: "credit", counterparty: { name: "Mum" }, transactionType: { ...inference("transfer", 0.9), basis: ["user_history"] }, transferKind: "family" });
    const d = explainCandidate(family, [fromMum], { locale: "en-KE" }).details;
    expect(d).toContain("Treated as a transfer from family because you've marked payments from Mum this way before.");
    expect(d.join(" ")).not.toContain("transfer to family");

    const pix = makeObservation({ source: SRC.nubank, direction: "credit", minor: 5_000, currency: "BRL" });
    const p2p = candidateOf([pix], { direction: "credit", transactionType: userInference("transfer"), transferKind: "p2p_other" });
    expect(explainCandidate(p2p, [pix], { locale: "pt-BR" }).details).toContain("You marked this as a transfer from someone else.");

    const out = candidateOf([hdfcAlert()], { transactionType: userInference("transfer"), transferKind: "family" });
    expect(explainCandidate(out, [], IN).details).toContain("You marked this as a transfer to family.");
  });
});

describe("review — articles before single-letter brand prefixes", () => {
  it("reads letter names aloud: an M-Pesa receipt, a T-Mobile invoice, a U-Haul booking", () => {
    const bank = makeObservation({ source: SRC.hdfcAccount });
    const headline = (kind: Observation["kind"], name: string) => {
      const doc = makeObservation({ source: SRC.gmail, kind, receivedAt: T0 + MINUTE, merchant: merchant(name) });
      return explainCandidate(candidateOf([bank, doc]), [bank, doc], IN).headline;
    };
    expect(headline("receipt", "M-Pesa")).toBe("Matched your bank transaction with an M-Pesa receipt.");
    expect(headline("invoice", "T-Mobile")).toBe("Matched your bank transaction with a T-Mobile invoice.");
    expect(headline("booking", "U-Haul")).toBe("Matched your bank transaction with a U-Haul booking.");
    expect(headline("invoice", "O2")).toBe("Matched your bank transaction with an O2 invoice.");
  });
});

describe("review — excerpts fail closed", () => {
  it("strips an excerpt at once when the policy keeps none, even if the device clock ran ahead", () => {
    const memo = makeObservation({ source: SRC.n26, currency: "EUR", receivedAt: T0 + HOUR, evidence: { summary: "SEPA credit", excerpt: "Verwendungszweck: Miete Anna" } });
    expect(applyRetention([memo], () => DEFAULT_RETENTION.open_banking, T0).strippedIds).toEqual([memo.id]);
  });

  it("strips and hides excerpts whose expiry is not a valid instant, so the policy still bounds them", () => {
    for (const bad of [Number.NaN, null as unknown as number]) {
      const sms = makeObservation({ source: SRC.hdfcSms, receivedAt: T0 - 30 * DAY, evidence: { summary: "s", excerpt: "Rs.500 debited at CAFE", excerptExpiresAt: bad } });
      expect(applyRetention([sms], () => DEFAULT_RETENTION.sms, T0).strippedIds).toEqual([sms.id]);
      expect(explainCandidate(candidateOf([sms]), [sms], { ...IN, now: T0 }).details.some((d) => d.startsWith("Excerpt"))).toBe(false);
    }
  });

  it("hides an excerpt the user's shortened policy no longer allows, before the retention pass runs", () => {
    const sms = hdfcAlert({ receivedAt: T0, evidence: { summary: "s", excerpt: "Rs.1249.00 debited to AMAZON", excerptExpiresAt: T0 + 7 * DAY } });
    const c = candidateOf([sms]);
    const oneDay: RetentionPolicy = { excerptTtlMs: DAY, observationTtlMs: null };
    const at = (now: number, retentionFor?: ExplainOptions["retentionFor"]) =>
      explainCandidate(c, [sms], { ...IN, now, ...(retentionFor ? { retentionFor } : {}) }).details.some((d) => d.startsWith("Excerpt"));
    expect(at(T0 + 2 * DAY)).toBe(true);
    expect(at(T0 + 2 * DAY, () => oneDay)).toBe(false);
    expect(at(T0 + HOUR, () => oneDay)).toBe(true);
    // A connection with no known policy keeps no text (as in applyRetention).
    expect(at(T0 + HOUR, () => undefined)).toBe(false);
  });
});

describe("review — restored consent state is validated", () => {
  const good = () => {
    const reg = createConsentRegistry({ clock: fixedClock(T0) });
    reg.connect(SMS_GRANT);
    return JSON.parse(JSON.stringify(reg.snapshot()));
  };

  it("rejects corrupt snapshots instead of acting on them", () => {
    const negative = good();
    // A negative TTL would make the next retention pass delete every fact of the source.
    negative.connections[0].retention.observationTtlMs = -1;
    expect(() => createConsentRegistry({ clock: fixedClock(T0), restore: negative })).toThrow(RangeError);

    const status = good();
    status.connections[0].status = "enabled";
    expect(() => createConsentRegistry({ clock: fixedClock(T0), restore: status })).toThrow(RangeError);

    const dup = good();
    dup.connections.push({ ...dup.connections[0] });
    expect(() => createConsentRegistry({ clock: fixedClock(T0), restore: dup })).toThrow(RangeError);

    const action = good();
    action.history[0].action = "deleted";
    expect(() => createConsentRegistry({ clock: fixedClock(T0), restore: action })).toThrow(RangeError);

    expect(() => createConsentRegistry({ clock: fixedClock(T0), restore: good() })).not.toThrow();
  });
});
