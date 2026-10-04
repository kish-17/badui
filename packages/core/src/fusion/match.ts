import { currencyExponent } from "../model/money";
import type { Money } from "../model/money";
import type { Direction, Observation, Reference, ReferenceType } from "../model/observation";
import { DAY, HOUR, MINUTE } from "../model/primitives";
import type { EpochMillis, Probability } from "../model/primitives";
import type { SignalSourceKind } from "../model/source";
import type { FusionConfig, MatchAssessment, MatchFeature, MerchantMatcher } from "./types";

/**
 * Pairwise matching: may two observations describe the same financial event?
 *
 * Implements blocking (which pairs are comparable at all), hard vetoes
 * (pairs that can never merge) and Fellegi–Sunter style scoring, as specified
 * in docs/architecture/fusion-and-reconciliation.md. Everything here looks at
 * normalized observation fields and generic source families only — never at
 * which provider, adapter, country or OS produced the observation.
 */

/* ------------------------------------------------------------------ */
/* Observation classes                                                 */
/* ------------------------------------------------------------------ */

/**
 * True when the observation can found or join a candidate. Invoices and
 * bookings count only when they evidence a payment (confirmed/posted with an
 * amount); a restaurant reservation or an unpaid invoice is context.
 */
export function isTransactional(o: Observation): boolean {
  switch (o.kind) {
    case "money_movement":
    case "purchase_intent":
    case "checkout":
    case "order":
    case "receipt":
    case "refund_notice":
      return true;
    case "subscription_event":
      return o.subscription?.event === "charged";
    case "invoice":
    case "booking":
      return (o.stage === "confirmed" || o.stage === "posted") && o.amount !== undefined;
    default:
      return false;
  }
}

/** Stored for recurring detection/insights but never fused (deliveries are join-only, not context). */
export function isContextOnly(o: Observation): boolean {
  return !isTransactional(o) && o.kind !== "delivery";
}

/**
 * How an observation participates in matching:
 *  ledger        money movement from an account-of-record (aggregator/bank API/wallet history, or posted)
 *  alert         real-time money-movement alert (notification, SMS, issuer webhook, card feed, OS wallet)
 *  document      order, receipt, paid invoice/booking, charged subscription
 *  checkout      payment flow observed in-spend
 *  intent        pre-spend purchase intent
 *  refund_notice merchant-side refund message
 *  delivery      join-only shipment/delivery update
 *  context       never fused
 */
export type ObservationClass = "ledger" | "alert" | "document" | "checkout" | "intent" | "refund_notice" | "delivery" | "context";

/** Source families that report an account's own ledger rather than a real-time alert. */
const LEDGER_SOURCE_KINDS: ReadonlySet<SignalSourceKind> = new Set([
  "open_banking",
  "account_aggregator",
  "neobank_api",
  "wallet_history",
]);

export function isLedger(o: Observation): boolean {
  if (o.kind !== "money_movement") return false;
  return LEDGER_SOURCE_KINDS.has(o.source.kind) || o.stage === "posted" || o.references.some((r) => r.type === "provider_transaction_id");
}

export function observationClass(o: Observation): ObservationClass {
  switch (o.kind) {
    case "money_movement":
      return isLedger(o) ? "ledger" : "alert";
    case "purchase_intent":
      return "intent";
    case "checkout":
      return "checkout";
    case "refund_notice":
      return "refund_notice";
    case "delivery":
      return "delivery";
    default:
      return isTransactional(o) ? "document" : "context";
  }
}

function isMoneyMovementClass(c: ObservationClass): boolean {
  return c === "ledger" || c === "alert";
}

/**
 * Direction used for vetoes. Observations that do not state one still imply
 * it by kind: an order or receipt is the user paying, a refund notice is money
 * coming back. Money movements and deliveries imply nothing.
 */
export function effectiveDirection(o: Observation): Direction | undefined {
  if (o.direction) return o.direction;
  switch (o.kind) {
    case "refund_notice":
      return "credit";
    case "purchase_intent":
    case "checkout":
    case "order":
    case "receipt":
    case "invoice":
    case "booking":
    case "subscription_event":
      return "debit";
    default:
      return undefined;
  }
}

/** Best estimate of when the event happened. */
export function timeOf(o: Observation): EpochMillis {
  return o.occurredAt?.value ?? o.receivedAt;
}

/**
 * How far an observation's time may be off. Bank value dates are often
 * date-only (low occurredAt confidence); without any occurredAt we only know
 * when BRAKE received the signal.
 */
export function timeSlack(o: Observation): number {
  if (!o.occurredAt) return HOUR;
  return o.occurredAt.confidence < 0.5 ? DAY : 0;
}

/* ------------------------------------------------------------------ */
/* References                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reference types that identify one event. Mandate and subscription ids are
 * shared by every charge of a series, and auth codes are short and reused, so
 * they are not event identifiers.
 */
export const EVENT_REFERENCE_TYPES: ReadonlySet<ReferenceType> = new Set([
  "rail_reference",
  "provider_transaction_id",
  "merchant_reference",
  "order_id",
  "invoice_id",
  "receipt_id",
  "booking_ref",
]);

function refNamespace(r: Reference): string {
  return (r.namespace ?? "").trim().toLowerCase();
}

function refValue(r: Reference): string {
  return r.value.replace(/\s+/g, "").toUpperCase();
}

/** Comparable key: references compare only within the same type and namespace. */
export function referenceKey(r: Reference, type: ReferenceType = r.type): string {
  return `${type}|${refNamespace(r)}|${refValue(r)}`;
}

function refsOfType(o: Observation, type: ReferenceType): Reference[] {
  return o.references.filter((r) => r.type === type);
}

/** The first event-identifying reference type both observations carry with an equal value. */
export function sharedEventReference(a: Observation, b: Observation): ReferenceType | null {
  const keys = new Set(b.references.filter((r) => EVENT_REFERENCE_TYPES.has(r.type)).map((r) => referenceKey(r)));
  for (const r of a.references) if (EVENT_REFERENCE_TYPES.has(r.type) && keys.has(referenceKey(r))) return r.type;
  return null;
}

/** True when `posted` names `pending` as the record it supersedes (provider_pending_id = provider_transaction_id). */
function names(posted: Observation, pending: Observation): boolean {
  const ids = new Set(refsOfType(pending, "provider_transaction_id").map((r) => referenceKey(r, "provider_pending_id")));
  return refsOfType(posted, "provider_pending_id").some((r) => ids.has(referenceKey(r)));
}

/** Either side explicitly supersedes the other (posted ↔ pending link asserted by the provider). */
export function pendingSupersedes(a: Observation, b: Observation): boolean {
  return names(a, b) || names(b, a);
}

/** `posted` says it supersedes a pending record, and `pending` is a pending record of that namespace with another id. */
function supersedesAnother(posted: Observation, pending: Observation): boolean {
  if (pending.stage !== "pending") return false;
  const claims = refsOfType(posted, "provider_pending_id");
  if (claims.length === 0) return false;
  const pendingIds = refsOfType(pending, "provider_transaction_id");
  return claims.some((c) => {
    const sameNs = pendingIds.filter((p) => refNamespace(p) === refNamespace(c));
    return sameNs.length > 0 && !sameNs.some((p) => refValue(p) === refValue(c));
  });
}

/**
 * The first event-reference type for which both sides carry values in the
 * same namespace and none of them agree. Provider transaction ids are exempt
 * on a pending↔posted pair: several regimes issue a new id on posting, or
 * change it until the record is final.
 */
function conflictingReference(a: Observation, b: Observation, exemptProviderIds: boolean): ReferenceType | null {
  for (const type of EVENT_REFERENCE_TYPES) {
    if (exemptProviderIds && type === "provider_transaction_id") continue;
    const ra = refsOfType(a, type);
    const rb = refsOfType(b, type);
    if (ra.length === 0 || rb.length === 0) continue;
    for (const x of ra) {
      const sameNs = rb.filter((y) => refNamespace(y) === refNamespace(x));
      if (sameNs.length === 0) continue;
      const valuesA = new Set(ra.filter((y) => refNamespace(y) === refNamespace(x)).map(refValue));
      if (!sameNs.some((y) => valuesA.has(refValue(y)))) return type;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Pair rules (blocking)                                               */
/* ------------------------------------------------------------------ */

export type AmountRule =
  | { readonly kind: "exact" }
  | { readonly kind: "relative"; readonly relative: number }
  /** Posted may exceed pending by up to `max` (tips); never shrink beyond a minor unit. */
  | { readonly kind: "growth"; readonly max: number }
  | { readonly kind: "any" };

export interface PairRule {
  readonly name: string;
  /** Max time between the two observations (Infinity = unlimited). */
  readonly windowMs: number;
  readonly amount: AmountRule;
  /** Which side is a pre-spend intent that may only be followed, never preceded, by the other. */
  readonly forwardFrom?: "incoming" | "member";
}

const EXACT: AmountRule = { kind: "exact" };

/** Pending and posted money movements of the same account, posted not earlier than pending. */
export function isPendingPostedPair(a: Observation, b: Observation): boolean {
  if (a.kind !== "money_movement" || b.kind !== "money_movement") return false;
  const pending = a.stage === "pending" ? a : b.stage === "pending" ? b : null;
  const posted = a.stage === "posted" ? a : b.stage === "posted" ? b : null;
  if (!pending || !posted || pending === posted) return false;
  return timeOf(posted) + Math.max(timeSlack(posted), timeSlack(pending)) >= timeOf(pending);
}

/** Same account: same connection and institution, or the same instrument (type + last4/accountRef). */
function sameAccount(a: Observation, b: Observation): boolean {
  if (sameSource(a, b)) return true;
  const ia = a.instrument;
  const ib = b.instrument;
  if (!ia || !ib || ia.type !== ib.type) return false;
  if (ia.last4 && ib.last4) return ia.last4 === ib.last4;
  return !!ia.accountRef && ia.accountRef === ib.accountRef;
}

/** One source = one connection reporting for one institution (a notification listener sees many apps). */
function sameSource(a: Observation, b: Observation): boolean {
  return a.source.connectionId === b.source.connectionId && (a.source.provider ?? "") === (b.source.provider ?? "");
}

/**
 * The blocking rule for a pair, from the table in the architecture doc, or
 * null when the pair is only comparable through a shared reference.
 */
export function pairRule(incoming: Observation, member: Observation, config: FusionConfig): PairRule | null {
  const a = observationClass(incoming);
  const b = observationClass(member);
  if (a === "context" || b === "context" || a === "delivery" || b === "delivery") return null;

  if (a === "intent" || b === "intent") {
    const other = a === "intent" ? b : a;
    if (other === "intent" || other === "refund_notice") return null;
    return {
      name: "intent_forward",
      windowMs: config.intentHorizonMs,
      amount: { kind: "relative", relative: config.approximateAmountTolerance },
      forwardFrom: a === "intent" ? "incoming" : "member",
    };
  }

  const has = (x: ObservationClass, y: ObservationClass): boolean => (a === x && b === y) || (a === y && b === x);

  if (isMoneyMovementClass(a) && isMoneyMovementClass(b)) {
    if (isPendingPostedPair(incoming, member) && sameAccount(incoming, member)) {
      return { name: "pending_posted", windowMs: 5 * DAY, amount: { kind: "growth", max: config.pendingToPostedTolerance } };
    }
    if (a === "ledger" || b === "ledger") return { name: "ledger_entries", windowMs: 5 * DAY, amount: EXACT };
    return { name: "realtime_alerts", windowMs: 2 * HOUR, amount: EXACT };
  }
  const mm = isMoneyMovementClass(a) ? a : isMoneyMovementClass(b) ? b : null;
  const other = mm === a ? b : a;
  if (mm) {
    if (other === "document") return { name: "payment_document", windowMs: 7 * DAY, amount: { kind: "relative", relative: 0.01 } };
    if (other === "checkout") return { name: "checkout_payment", windowMs: HOUR, amount: EXACT };
    if (other === "refund_notice") return { name: "refund_credit", windowMs: 10 * DAY, amount: EXACT };
    return null;
  }
  if (has("checkout", "document")) return { name: "checkout_document", windowMs: DAY, amount: { kind: "relative", relative: 0.01 } };
  if (has("document", "document")) return { name: "documents", windowMs: 2 * DAY, amount: EXACT };
  if (has("refund_notice", "refund_notice")) return { name: "refund_notices", windowMs: 10 * DAY, amount: EXACT };
  return null;
}

const PENDING_SUPERSEDED_RULE: PairRule = { name: "pending_superseded", windowMs: Infinity, amount: { kind: "any" } };
const DELIVERY_RULE: PairRule = { name: "delivery_order", windowMs: 60 * DAY, amount: { kind: "any" } };

/** Upper bounds over every rule, for index retrieval. */
export function maxPairWindowMs(config: FusionConfig): number {
  return Math.max(10 * DAY, config.intentHorizonMs);
}

export function maxAmountTolerance(config: FusionConfig): number {
  return Math.max(0.01, config.pendingToPostedTolerance, config.approximateAmountTolerance);
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** Log-likelihood ratios per feature (see the scoring table in the architecture doc). */
export const LLR = {
  referenceMatch: 9,
  amountExact: 4.5,
  /** Round amounts (₹100, $20) are common, so agreeing on one is weaker evidence. */
  amountExactRound: 3.5,
  amountWithinTolerance: 2,
  amountDiffers: -2,
  timeProximityMax: 2,
  merchantKeyEqual: 3,
  merchantDifferent: -3,
  instrumentMatch: 2.5,
  railSchemeMatch: 0.5,
  authCodeMatch: 2,
  currencyMismatch: -4,
} as const;

export interface PairAssessment extends MatchAssessment {
  /**
   * True when the pair is merely not comparable under the blocking rules
   * (outside the time window or amount tolerance, no applicable pair rule).
   * `veto` is set too, but unlike a hard veto this member simply contributes
   * no evidence; it does not disqualify the rest of a candidate.
   */
  readonly blocked: boolean;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

export function sigmoid(x: number): Probability {
  return 1 / (1 + Math.exp(-x));
}

/** Whole major units divisible by 5: amounts people pay all the time. */
export function isRoundAmount(m: Money): boolean {
  const unit = 10 ** currencyExponent(m.currency);
  if (m.minor % unit !== 0) return false;
  return (m.minor / unit) % 5 === 0;
}

/** All amounts an observation can be compared on: its own and an original-currency component (FX bridge). */
export function comparableAmounts(o: Observation): Money[] {
  const out: Money[] = [];
  if (o.amount) out.push(o.amount.value);
  for (const c of o.amountBreakdown ?? []) {
    if (c.kind === "original_currency" && !out.some((m) => m.currency === c.amount.currency)) out.push(c.amount);
  }
  return out;
}

/**
 * The closest pair of same-currency representations (own amount or original
 * currency). Card FX is settled at a different rate than it was authorised at,
 * so two converted amounts may disagree while the original amounts match.
 */
function alignAmounts(a: Observation, b: Observation): readonly [Money, Money] | null {
  let best: readonly [Money, Money] | null = null;
  let bestDiff = Infinity;
  for (const x of comparableAmounts(a)) {
    for (const y of comparableAmounts(b)) {
      if (x.currency !== y.currency) continue;
      const larger = Math.max(x.minor, y.minor);
      const diff = larger === 0 ? 0 : Math.abs(x.minor - y.minor) / larger;
      if (diff < bestDiff) {
        best = [x, y];
        bestDiff = diff;
      }
    }
  }
  return best;
}

interface PartialResult {
  readonly feature?: MatchFeature;
  /** Outside the rule; blocks the pair unless a shared reference makes it comparable. */
  readonly outside?: string;
}

interface AmountResult extends PartialResult {
  /** Relative difference as a percentage label, when amounts were comparable and differed. */
  readonly difference?: string;
}

function compareAmounts(incoming: Observation, member: Observation, rule: PairRule | null, config: FusionConfig): AmountResult {
  if (!incoming.amount || !member.amount) return {};
  const aligned = alignAmounts(incoming, member);
  if (!aligned) {
    return {
      feature: {
        name: "currency_mismatch",
        llr: LLR.currencyMismatch,
        detail: `${incoming.amount.value.currency} vs ${member.amount.value.currency} without an FX bridge`,
      },
    };
  }
  const [x, y] = aligned;
  const diff = Math.abs(x.minor - y.minor);
  const bridged = x.currency !== incoming.amount.value.currency || y.currency !== member.amount.value.currency;
  const via = bridged ? ` (via original ${x.currency} amount)` : "";
  if (diff <= 1) {
    const round = isRoundAmount(x);
    return {
      feature: {
        name: "amount_exact",
        llr: round ? LLR.amountExactRound : LLR.amountExact,
        detail: `${round ? "round amount" : "exact"}${via}`,
      },
    };
  }

  let amountRule: AmountRule = rule?.amount ?? EXACT;
  const approximate = incoming.amount.approximate === true || member.amount.approximate === true;
  if (approximate && (amountRule.kind === "exact" || amountRule.kind === "relative")) {
    const base = amountRule.kind === "relative" ? amountRule.relative : 0;
    amountRule = { kind: "relative", relative: Math.max(base, config.approximateAmountTolerance) };
  }
  const larger = Math.max(x.minor, y.minor);
  const relDiff = larger === 0 ? 0 : diff / larger;
  const pct = `${round4(relDiff * 100)}%`;

  switch (amountRule.kind) {
    case "any":
      return { feature: { name: "amount_changed", llr: 0, detail: `${pct} difference allowed for ${rule?.name ?? "pair"}` } };
    case "relative":
      if (diff <= amountRule.relative * larger) {
        return { feature: { name: "amount_within_tolerance", llr: LLR.amountWithinTolerance, detail: `${pct}${via}` } };
      }
      break;
    case "growth": {
      const posted = incoming.stage === "posted" ? x : y;
      const pending = incoming.stage === "posted" ? y : x;
      const growth = pending.minor === 0 ? Infinity : (posted.minor - pending.minor) / pending.minor;
      if (posted.minor + 1 >= pending.minor && growth <= amountRule.max) {
        return { feature: { name: "amount_within_tolerance", llr: LLR.amountWithinTolerance, detail: `posted ${pct} above pending` } };
      }
      break;
    }
    case "exact":
      break;
  }
  return { feature: { name: "amount_differs", llr: LLR.amountDiffers, detail: pct }, outside: `amount differs by ${pct}`, difference: pct };
}

function compareTime(incoming: Observation, member: Observation, rule: PairRule): PartialResult {
  if (rule.forwardFrom) {
    const [intent, other] = rule.forwardFrom === "incoming" ? [incoming, member] : [member, incoming];
    const lead = timeOf(other) - timeOf(intent);
    const slack = Math.max(10 * MINUTE, timeSlack(other), timeSlack(intent));
    if (lead < -slack) return { outside: "payment precedes the intent", feature: { name: "time_proximity", llr: 0, detail: "before intent" } };
    const effective = Math.max(0, lead - Math.max(timeSlack(other), timeSlack(intent)));
    if (effective > rule.windowMs) {
      return { outside: "beyond the intent horizon", feature: { name: "time_proximity", llr: 0, detail: "beyond horizon" } };
    }
    return { feature: proximity(effective, rule.windowMs) };
  }
  if (!Number.isFinite(rule.windowMs)) return {};
  const dt = Math.max(0, Math.abs(timeOf(incoming) - timeOf(member)) - Math.max(timeSlack(incoming), timeSlack(member)));
  if (dt > rule.windowMs) {
    return { outside: `time apart exceeds ${rule.name} window`, feature: { name: "time_proximity", llr: 0, detail: "outside window" } };
  }
  return { feature: proximity(dt, rule.windowMs) };
}

function proximity(dt: number, window: number): MatchFeature {
  const minutes = Math.round(dt / MINUTE);
  return { name: "time_proximity", llr: round4(LLR.timeProximityMax * (1 - dt / window)), detail: `${minutes} min apart` };
}

function compareMerchants(incoming: Observation, member: Observation, matcher: MerchantMatcher): MatchFeature | null {
  const ma = incoming.merchant;
  const mb = member.merchant;
  if (!ma || !mb) return null;
  const ka = matcher.key(ma);
  const kb = matcher.key(mb);
  if (ka !== null && ka === kb) return { name: "merchant_key_equal", llr: LLR.merchantKeyEqual, detail: ka };
  const s = Math.min(1, Math.max(0, matcher.similarity(ma, mb)));
  if (s <= 0.1 && ka !== null && kb !== null) return { name: "merchant_different", llr: LLR.merchantDifferent, detail: `${ka} vs ${kb}` };
  if (s <= 0) return null;
  return { name: "merchant_similarity", llr: round4(3 * s - 1), detail: `similarity ${round4(s)}` };
}

function compareInstruments(incoming: Observation, member: Observation): MatchFeature | null {
  const ia = incoming.instrument;
  const ib = member.instrument;
  if (!ia || !ib || ia.type !== ib.type) return null;
  if (ia.last4 && ib.last4) {
    return ia.last4 === ib.last4 ? { name: "instrument_match", llr: LLR.instrumentMatch, detail: `${ia.type} ••${ia.last4}` } : null;
  }
  if (ia.accountRef && ia.accountRef === ib.accountRef) return { name: "instrument_match", llr: LLR.instrumentMatch, detail: `${ia.type} account` };
  return null;
}

function hardVeto(incoming: Observation, member: Observation, superseded: boolean, shared: ReferenceType | null): string | null {
  const da = effectiveDirection(incoming);
  const db = effectiveDirection(member);
  if (da && db && da !== db) return `directions conflict (${da} vs ${db})`;

  const exempt = superseded || isPendingPostedPair(incoming, member);
  const conflict = conflictingReference(incoming, member, exempt);
  if (conflict) return `distinct ${conflict} references`;
  if (supersedesAnother(incoming, member) || supersedesAnother(member, incoming)) {
    return "posted record supersedes a different pending record";
  }

  if (
    incoming.kind === "money_movement" &&
    member.kind === "money_movement" &&
    sameSource(incoming, member) &&
    !shared &&
    !superseded &&
    !isPendingPostedPair(incoming, member)
  ) {
    return "same source reports each event once";
  }

  const ia = incoming.instrument;
  const ib = member.instrument;
  if (ia && ib && ia.type === ib.type && ia.last4 && ib.last4 && ia.last4 !== ib.last4) {
    return `different ${ia.type} instruments (••${ia.last4} vs ••${ib.last4})`;
  }
  return null;
}

function verdict(config: FusionConfig, features: readonly MatchFeature[], veto: string | null, blocked: boolean): PairAssessment {
  const logOdds = round4(features.reduce((sum, f) => sum + f.llr, config.priorLogOdds));
  return {
    ...(veto ? { veto } : {}),
    logOdds,
    // A vetoed or non-comparable pair can never link, whatever its features say.
    probability: veto ? 0 : sigmoid(logOdds),
    features,
    blocked,
  };
}

/**
 * Compare an incoming observation with one member of a candidate: blocking,
 * hard vetoes and scoring. `probability` is 0 whenever `veto` is set; check
 * `blocked` to tell "not comparable" from "can never be the same event".
 */
export function assessPair(incoming: Observation, member: Observation, config: FusionConfig, matcher: MerchantMatcher): PairAssessment {
  if (isContextOnly(incoming) || isContextOnly(member)) {
    return verdict(config, [], "context-only observations never fuse", false);
  }
  const superseded = pendingSupersedes(incoming, member);
  const shared = superseded ? null : sharedEventReference(incoming, member);
  const veto = hardVeto(incoming, member, superseded, shared);

  const features: MatchFeature[] = [];
  if (superseded) features.push({ name: "pending_superseded", llr: LLR.referenceMatch, detail: "posted record names this pending record" });
  else if (shared) features.push({ name: "reference_match", llr: LLR.referenceMatch, detail: shared });
  const comparableByReference = superseded || shared !== null;

  let blocked: string | null = null;
  let rule: PairRule | null;
  if (incoming.kind === "delivery" || member.kind === "delivery") {
    // Deliveries join their order by order id and nothing else.
    const order = incoming.kind === "delivery" ? member : incoming;
    rule = DELIVERY_RULE;
    if (order.kind !== "order" && order.kind !== "delivery") blocked = "deliveries join orders only";
    else if (shared !== "order_id") blocked = "delivery needs the order's order_id";
  } else {
    rule = superseded ? PENDING_SUPERSEDED_RULE : pairRule(incoming, member, config);
    if (!rule && !comparableByReference) blocked = "no comparable pair rule";
  }

  if (rule) {
    const time = compareTime(incoming, member, rule);
    if (time.feature) features.push(time.feature);
    if (time.outside && !comparableByReference) blocked ??= time.outside;
  }
  const amount = compareAmounts(incoming, member, rule, config);
  if (amount.feature) features.push(amount.feature);
  if (amount.outside && !comparableByReference) blocked ??= amount.outside;
  // Two money movements are each precise about what moved. If they disagree
  // beyond their rule's tolerance and share no reference, they are different
  // events — even if another member of the candidate (a receipt with a looser
  // tolerance) would otherwise vouch for the pair.
  const amountConflict =
    amount.outside !== undefined && !comparableByReference && incoming.kind === "money_movement" && member.kind === "money_movement"
      ? `money movements disagree on amount (${amount.difference ?? "beyond tolerance"})`
      : null;

  const merchant = compareMerchants(incoming, member, matcher);
  if (merchant) features.push(merchant);
  const instrument = compareInstruments(incoming, member);
  if (instrument) features.push(instrument);
  if (incoming.rail?.scheme && incoming.rail.scheme === member.rail?.scheme) {
    features.push({ name: "rail_scheme_match", llr: LLR.railSchemeMatch, detail: incoming.rail.scheme });
  }
  const authA = new Set(refsOfType(incoming, "auth_code").map((r) => referenceKey(r)));
  if (refsOfType(member, "auth_code").some((r) => authA.has(referenceKey(r)))) {
    features.push({ name: "auth_code_match", llr: LLR.authCodeMatch });
  }

  const hard = veto ?? amountConflict;
  if (hard) return verdict(config, features, hard, false);
  if (blocked) return verdict(config, features, `not comparable: ${blocked}`, true);
  return verdict(config, features, null, false);
}
