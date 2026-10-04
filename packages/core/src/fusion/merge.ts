import type { UserAssertion } from "../model/assertion";
import { defaultAttributes, unknownInference, userInference } from "../model/candidate";
import type {
  CandidateLink,
  CandidateMerchant,
  CategoryId,
  FieldProvenance,
  Inference,
  IntentOutcome,
  ProvenanceField,
  SemanticAttributes,
  SignalRole,
  SourceSignal,
  TransactionCandidate,
} from "../model/candidate";
import type { Money } from "../model/money";
import type {
  CounterpartyObservation,
  Direction,
  InstrumentObservation,
  LineItem,
  MerchantChannel,
  MerchantObservation,
  Observation,
  ObservationKind,
  PaymentRail,
  Reference,
  TransactionStatus,
  TransactionType,
  TransferKind,
  TypeHint,
} from "../model/observation";
import { clamp01 } from "../model/primitives";
import type { CandidateId, EpochMillis, Measured, ObservationId, Probability } from "../model/primitives";
import { stableId } from "../util/hash";
import { effectiveDirection, observationClass, referenceKey, timeOf } from "./match";
import type { ObservationClass } from "./match";
import { displayNameFromDescriptor } from "./merchant";
import type { CandidatePatch, FusionConfig, MerchantMatcher } from "./types";

/**
 * Field fusion: turn the observations of one event into one
 * TransactionCandidate, following the "which source wins" table in
 * docs/architecture/fusion-and-reconciliation.md. Pure functions of the
 * cluster's observations, patches and assertions, so a candidate can always be
 * recomputed after re-fusion or a source disconnect and come out identical.
 */

/* ------------------------------------------------------------------ */
/* Source authority                                                    */
/* ------------------------------------------------------------------ */

/** How much an observation of each class evidences that the event really happened. */
export const SOURCE_WEIGHTS: Readonly<Record<ObservationClass, number>> = {
  ledger: 1,
  alert: 0.95,
  document: 0.8,
  refund_notice: 0.8,
  delivery: 0.5,
  checkout: 0.6,
  intent: 0.4,
  context: 0,
};

/** Amount authority: posted ledger > pending ledger > real-time alert > document total > checkout > intent. */
export function amountRank(o: Observation): number {
  switch (observationClass(o)) {
    case "ledger":
      return o.stage === "posted" ? 6 : o.stage === "pending" ? 5 : o.stage === "cancelled" ? 4.5 : 5.5;
    case "alert":
      return 4;
    case "document":
    case "refund_notice":
      return 3;
    case "checkout":
      return 2;
    case "intent":
      return 1;
    default:
      return 0;
  }
}

/** Display-name authority: merchants name themselves best in orders/receipts, QR payloads and checkouts. */
function displayRank(o: Observation): number {
  const cls = observationClass(o);
  if (cls === "document" || cls === "refund_notice" || cls === "delivery") return 4;
  if (cls === "checkout" || o.source.kind === "qr_scan" || o.source.kind === "merchant_partner") return 3;
  if (cls === "intent") return 2;
  return 1;
}

const STATUS_RANK: Readonly<Record<TransactionStatus, number>> = {
  unknown: 0,
  refunded: 0,
  cancelled: 0,
  intent: 1,
  pending: 2,
  confirmed: 3,
  posted: 4,
};

/** Members sorted by authority (amount rank, then observation confidence), ingest order breaking ties. */
function byAuthority(members: readonly Observation[]): Observation[] {
  return members
    .map((o, i) => ({ o, i }))
    .sort((p, q) => amountRank(q.o) - amountRank(p.o) || q.o.confidence - p.o.confidence || p.i - q.i)
    .map((x) => x.o);
}

/**
 * Noisy-OR over independent evidence. Observations from one connection are
 * not independent of each other (a pending and a posted record from the same
 * aggregator), so each connection contributes only its strongest item.
 */
function noisyOrByConnection(items: ReadonlyArray<{ readonly o: Observation; readonly p: number }>): Probability {
  const best = new Map<string, number>();
  for (const { o, p } of items) best.set(o.source.connectionId, Math.max(best.get(o.source.connectionId) ?? 0, clamp01(p)));
  let miss = 1;
  for (const p of best.values()) miss *= 1 - p;
  return clamp01(1 - miss);
}

function uniqueIds(ids: ReadonlyArray<ObservationId | undefined>): ObservationId[] {
  const out: ObservationId[] = [];
  for (const id of ids) if (id !== undefined && !out.includes(id)) out.push(id);
  return out;
}

function provenance(field: ProvenanceField, observationIds: readonly ObservationId[], note: string, method?: FieldProvenance["method"]): FieldProvenance {
  return { field, method: method ?? (observationIds.length > 1 ? "fused" : "direct"), observationIds, note };
}

/* ------------------------------------------------------------------ */
/* Facts                                                               */
/* ------------------------------------------------------------------ */

interface AmountFusion {
  readonly amount: Measured<Money> | null;
  readonly originalAmount?: Money;
  readonly provenance?: FieldProvenance;
}

const AMOUNT_NOTES: Readonly<Record<ObservationClass, string>> = {
  ledger: "ledger amount",
  alert: "real-time alert amount",
  document: "receipt/order total",
  refund_notice: "refund notice amount",
  checkout: "checkout amount",
  intent: "intent estimate",
  delivery: "delivery",
  context: "context",
};

function fuseAmount(members: readonly Observation[], ranked: readonly Observation[]): AmountFusion {
  const withAmount = ranked.flatMap((o) => (o.amount ? [{ o, amount: o.amount }] : []));
  const winner = withAmount[0];
  if (!winner) return { amount: null };
  const value = winner.amount.value;
  const agreeing = withAmount.filter((x) => x.amount.value.currency === value.currency && Math.abs(x.amount.value.minor - value.minor) <= 1);
  const confidence = noisyOrByConnection(agreeing.map((x) => ({ o: x.o, p: x.amount.confidence })));
  const approximate = agreeing.every((x) => x.amount.approximate === true);

  const cls = observationClass(winner.o);
  const supersedesPending =
    cls === "ledger" && winner.o.stage === "posted" && members.some((o) => o !== winner.o && o.kind === "money_movement" && o.stage === "pending");
  const note = supersedesPending
    ? "posted amount supersedes pending"
    : cls === "ledger"
      ? `${winner.o.stage === "posted" || winner.o.stage === "pending" ? `${winner.o.stage} ` : ""}${AMOUNT_NOTES.ledger}`
      : AMOUNT_NOTES[cls];

  const originalOf = (o: Observation): Money | undefined => o.amountBreakdown?.find((c) => c.kind === "original_currency")?.amount;
  const originalAmount = originalOf(winner.o) ?? ranked.map(originalOf).find((m) => m !== undefined);

  return {
    amount: { value, confidence, ...(approximate ? { approximate: true } : {}) },
    ...(originalAmount ? { originalAmount } : {}),
    provenance: provenance("amount", agreeing.map((x) => x.o.id), note),
  };
}

interface MerchantFusion {
  readonly merchant: CandidateMerchant;
  readonly provenance?: FieldProvenance;
}

function fuseMerchant(ranked: readonly Observation[], matcher: MerchantMatcher): MerchantFusion {
  const withMerchant = ranked.flatMap((o) => (o.merchant ? [{ o, m: o.merchant }] : []));
  if (withMerchant.length === 0) {
    return { merchant: { raw: null, normalized: null, displayName: null, confidence: 0, channel: "unknown" } };
  }
  // Descriptor from the most authoritative money movement (ranked puts ledgers and alerts first).
  const rawSource = withMerchant.find((x) => x.o.kind === "money_movement") ?? withMerchant[0];
  const named = withMerchant
    .filter((x) => (x.m.name ?? "").trim().length > 0)
    .sort((p, q) => displayRank(q.o) - displayRank(p.o) || q.m.confidence - p.m.confidence);
  const keyed = withMerchant
    .flatMap((x) => {
      const key = matcher.key(x.m);
      return key ? [{ ...x, key }] : [];
    })
    .sort((p, q) => q.m.confidence - p.m.confidence);

  const keySource = keyed[0];
  const normalized = keySource?.key ?? null;
  const displaySource = named[0];
  const raw = rawSource?.m.raw ?? null;
  const displayName = displaySource?.m.name?.trim() ?? (raw ? (displayNameFromDescriptor(raw) ?? raw.trim()) : null);
  const confidence = keySource
    ? noisyOrByConnection(keyed.filter((x) => x.key === normalized).map((x) => ({ o: x.o, p: x.m.confidence })))
    : (rawSource?.m.confidence ?? 0);

  const first = <K extends keyof MerchantObservation>(field: K): MerchantObservation[K] | undefined =>
    withMerchant.map((x) => x.m[field]).find((v) => v !== undefined && v !== "");
  const channel: MerchantChannel = withMerchant.map((x) => x.m.channel).find((c) => c !== undefined && c !== "unknown") ?? "unknown";
  const mcc = first("mcc");
  const handle = first("handle");

  const ids = uniqueIds([rawSource?.o.id, displaySource?.o.id, keySource?.o.id]);
  const note = displaySource ? `display name from ${displaySource.o.kind}; descriptor from ${rawSource?.o.kind ?? "none"}` : "display name from descriptor";
  return {
    merchant: {
      raw,
      normalized,
      displayName,
      confidence,
      channel,
      ...(mcc ? { mcc } : {}),
      ...(handle ? { handle } : {}),
    },
    provenance: provenance("merchant", ids, note),
  };
}

interface StatusFusion {
  readonly status: TransactionStatus;
  readonly history: TransactionCandidate["statusHistory"];
  readonly roles: readonly SignalRole[];
  readonly provenance: FieldProvenance;
}

/**
 * Status is the furthest lifecycle stage any observation evidences
 * (intent < pending < confirmed < posted); a cancellation before posting wins.
 * `refunded` is never derived here: linking a refund to its purchase is
 * reconciliation's job. Roles are derived in the same pass because "lifecycle"
 * means "advanced the status".
 */
function fuseStatus(members: readonly Observation[]): StatusFusion {
  let best: TransactionStatus = "unknown";
  let cancelled = false;
  const current = (): TransactionStatus => (cancelled && best !== "posted" ? "cancelled" : best);
  const history: Array<{ status: TransactionStatus; at: EpochMillis; observationId: ObservationId }> = [];
  const primaryIndex = Math.max(
    0,
    members.findIndex((o) => o.kind === "money_movement" || o.kind === "purchase_intent"),
  );
  const roles: SignalRole[] = members.map((o, i) => {
    const before = current();
    if (o.kind !== "delivery") {
      if (o.stage === "cancelled") cancelled = true;
      else if (STATUS_RANK[o.stage] > STATUS_RANK[best]) best = o.stage;
    }
    const after = current();
    if (after !== before) history.push({ status: after, at: o.receivedAt, observationId: o.id });
    if (i === primaryIndex) return "primary";
    if (o.stage === "cancelled") return "lifecycle";
    const cls = observationClass(o);
    if (cls === "ledger" || cls === "alert" || cls === "checkout") {
      return i > primaryIndex && STATUS_RANK[after] > STATUS_RANK[before] ? "lifecycle" : "corroborating";
    }
    return "enriching";
  });
  const status = current();
  const evidencing = members.filter((o) => o.kind !== "delivery" && (status === "unknown" || o.stage === status));
  const note = status === "cancelled" ? "cancelled before posting" : "furthest lifecycle stage";
  return { status, history, roles, provenance: provenance("status", evidencing.map((o) => o.id), note) };
}

function pickLineItems(members: readonly Observation[]): { readonly items: readonly LineItem[]; readonly source?: Observation } {
  const choose = (kinds: ReadonlySet<ObservationKind>): Observation | undefined => {
    let best: Observation | undefined;
    for (const o of members) {
      const n = o.lineItems?.length ?? 0;
      // Most items wins; a later update with as many items replaces an earlier one.
      if (kinds.has(o.kind) && n > 0 && n >= (best?.lineItems?.length ?? 0)) best = o;
    }
    return best;
  };
  const source =
    choose(new Set<ObservationKind>(["receipt"])) ??
    choose(new Set<ObservationKind>(["order", "invoice", "booking", "subscription_event", "refund_notice", "checkout"]));
  return source?.lineItems ? { items: source.lineItems, source } : { items: [] };
}

function paymentLayerFirst(ranked: readonly Observation[]): Observation[] {
  const isPayment = (o: Observation): boolean => o.kind === "money_movement" || o.kind === "checkout";
  return [...ranked.filter(isPayment), ...ranked.filter((o) => !isPayment(o))];
}

function fuseRail(ordered: readonly Observation[]): { readonly rail: PaymentRail; readonly ids: ObservationId[] } {
  let family: PaymentRail["family"] | undefined;
  let scheme: string | undefined;
  const ids: ObservationId[] = [];
  for (const o of ordered) {
    if (!o.rail) continue;
    let used = false;
    if (family === undefined && o.rail.family !== "unknown") {
      family = o.rail.family;
      used = true;
    }
    if (scheme === undefined && o.rail.scheme) {
      scheme = o.rail.scheme;
      used = true;
    }
    if (used) ids.push(o.id);
  }
  return { rail: { family: family ?? "unknown", ...(scheme ? { scheme } : {}) }, ids };
}

/**
 * How directly an instrument describes how the user paid. A card, handle or
 * wallet is what was presented at the point of sale; the bank account behind
 * it is only the funding source (a debit card's ledger entry shows the account).
 */
const INSTRUMENT_SPECIFICITY: Readonly<Record<InstrumentObservation["type"], number>> = {
  card: 3,
  upi_handle: 3,
  wallet: 3,
  mobile_money: 3,
  bnpl: 3,
  cash: 3,
  bank_account: 2,
  other: 1,
};

/** Field-by-field merge of instruments of the same type as the most specific, most authoritative one. */
function fuseInstrument(ordered: readonly Observation[]): { readonly instrument?: InstrumentObservation; readonly ids: ObservationId[] } {
  const withInstrument = ordered
    .filter((o) => o.instrument)
    .sort((a, b) => INSTRUMENT_SPECIFICITY[b.instrument?.type ?? "other"] - INSTRUMENT_SPECIFICITY[a.instrument?.type ?? "other"]);
  const lead = withInstrument[0]?.instrument;
  if (!lead) return { ids: [] };
  const same = withInstrument.filter((o) => o.instrument?.type === lead.type);
  const pick = <K extends keyof InstrumentObservation>(k: K): InstrumentObservation[K] | undefined =>
    same.map((o) => o.instrument?.[k]).find((v) => v !== undefined);
  const issuer = pick("issuer");
  const network = pick("network");
  const last4 = pick("last4");
  const accountRef = pick("accountRef");
  const cardKind = pick("cardKind");
  return {
    instrument: {
      type: lead.type,
      ...(issuer ? { issuer } : {}),
      ...(network ? { network } : {}),
      ...(last4 ? { last4 } : {}),
      ...(accountRef ? { accountRef } : {}),
      ...(cardKind ? { cardKind } : {}),
    },
    ids: same.map((o) => o.id),
  };
}

function fuseCounterparty(ordered: readonly Observation[]): CounterpartyObservation | undefined {
  const all = ordered.flatMap((o) => (o.counterparty ? [o.counterparty] : []));
  if (all.length === 0) return undefined;
  const pick = <K extends keyof CounterpartyObservation>(k: K): CounterpartyObservation[K] | undefined =>
    all.map((c) => c[k]).find((v) => v !== undefined);
  const name = pick("name");
  const handle = pick("handle");
  const isSelf = pick("isSelf");
  const isMerchant = pick("isMerchant");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(isSelf !== undefined ? { isSelf } : {}),
    ...(isMerchant !== undefined ? { isMerchant } : {}),
  };
}

function unionReferences(members: readonly Observation[]): Reference[] {
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const o of members) {
    for (const r of o.references) {
      const key = referenceKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Seeded inferences                                                   */
/* ------------------------------------------------------------------ */

/**
 * Turn hints from several observations into a distribution: per value the
 * strongest hint, renormalised only if the mass exceeds 1 (mass below 1 is
 * honest residual uncertainty). Ties sort by value for determinism.
 */
export function distributionFromHints<T extends string>(hints: ReadonlyArray<{ readonly value: T; readonly confidence: number }>): Inference<T> | null {
  const best = new Map<T, number>();
  for (const h of hints) {
    const p = clamp01(h.confidence);
    if (p > (best.get(h.value) ?? -1)) best.set(h.value, p);
  }
  const entries = [...best.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = entries[0];
  if (!top) return null;
  const mass = entries.reduce((s, [, p]) => s + p, 0);
  const scale = mass > 1 ? 1 / mass : 1;
  return {
    value: top[0],
    confidence: top[1] * scale,
    alternatives: entries.slice(1).map(([value, p]) => ({ value, probability: p * scale })),
    basis: ["source_hint"],
    userSet: false,
  };
}

/** Hints implied by the observation kind itself: a refund notice describes a refund. */
function impliedTypeHints(o: Observation): TypeHint[] {
  if (o.kind === "refund_notice") return [{ type: "refund", confidence: 0.9, reason: "kind:refund_notice" }];
  if (o.kind === "subscription_event" && o.subscription?.event === "charged") {
    return [{ type: "subscription", confidence: 0.8, reason: "kind:subscription_charged" }];
  }
  return [];
}

interface Seeded {
  readonly transactionType: Inference<TransactionType>;
  readonly transferKind?: TransferKind;
  readonly category: Inference<CategoryId>;
  readonly provenance: readonly FieldProvenance[];
}

function seedInferences(members: readonly Observation[]): Seeded {
  const typeHints = members.flatMap((o) => [...(o.typeHints ?? []), ...impliedTypeHints(o)].map((h) => ({ o, h })));
  const transactionType =
    distributionFromHints(typeHints.map(({ h }) => ({ value: h.type, confidence: h.confidence }))) ?? unknownInference<TransactionType>("unknown");
  const transferHint = typeHints
    .filter(({ h }) => h.type === "transfer" && h.transferKind !== undefined)
    .sort((a, b) => b.h.confidence - a.h.confidence)[0];
  const transferKind = transactionType.value === "transfer" ? transferHint?.h.transferKind : undefined;

  const categoryHints = members.flatMap((o) => (o.categoryHints ?? []).filter((h) => h.scheme.toLowerCase() === "brake").map((h) => ({ o, h })));
  const category =
    distributionFromHints(categoryHints.map(({ h }) => ({ value: h.value, confidence: h.confidence }))) ?? unknownInference<CategoryId>("uncategorized");

  const prov: FieldProvenance[] = [];
  if (typeHints.length > 0) {
    prov.push(provenance("transaction_type", uniqueIds(typeHints.map(({ o }) => o.id)), "source_hint", "inferred"));
  }
  if (categoryHints.length > 0) {
    prov.push(provenance("category", uniqueIds(categoryHints.map(({ o }) => o.id)), "source_hint", "inferred"));
  }
  return { transactionType, ...(transferKind ? { transferKind } : {}), category, provenance: prov };
}

/* ------------------------------------------------------------------ */
/* Patches                                                             */
/* ------------------------------------------------------------------ */

/**
 * Combine an earlier patch with a later one: later fields win, attributes
 * merge per attribute, and links of the kinds the later patch carries replace
 * the earlier patch's links of those kinds.
 */
export function mergePatches(prev: CandidatePatch, next: CandidatePatch): CandidatePatch {
  const attributes = prev.attributes || next.attributes ? { ...prev.attributes, ...definedEntries(next.attributes) } : undefined;
  const nextKinds = new Set((next.links ?? []).map((l) => l.kind));
  const links = next.links ? [...(prev.links ?? []).filter((l) => !nextKinds.has(l.kind)), ...next.links] : prev.links;
  const category = next.category ?? prev.category;
  const transactionType = next.transactionType ?? prev.transactionType;
  const transferKind = next.transferKind ?? prev.transferKind;
  const merchantNormalized = next.merchantNormalized ?? prev.merchantNormalized;
  const status = next.status ?? prev.status;
  const intentOutcome = next.intentOutcome ?? prev.intentOutcome;
  return {
    ...(category ? { category } : {}),
    ...(transactionType ? { transactionType } : {}),
    ...(transferKind ? { transferKind } : {}),
    ...(attributes ? { attributes } : {}),
    ...(merchantNormalized ? { merchantNormalized } : {}),
    ...(links ? { links } : {}),
    ...(status ? { status } : {}),
    ...(intentOutcome ? { intentOutcome } : {}),
  };
}

function definedEntries<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mergeLinks(fusionLinks: readonly CandidateLink[], patchLinks: readonly CandidateLink[]): CandidateLink[] {
  const out = new Map<string, CandidateLink>();
  for (const l of [...fusionLinks, ...patchLinks]) out.set(`${l.kind}|${l.target}`, l);
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

export interface ClusterInput {
  readonly id: CandidateId;
  /** Member observations in ingest order; the first one founded the candidate. */
  readonly members: readonly Observation[];
  /** Posterior with which each member was linked (1 for the founder and user-forced links). */
  readonly matchProbabilities: ReadonlyMap<ObservationId, Probability>;
  /** Links fusion itself recorded (possible duplicates). */
  readonly fusionLinks: readonly CandidateLink[];
  /** Intelligence patches anchored to any member, oldest first. */
  readonly patches: readonly CandidatePatch[];
  /** User assertions anchored to any member, oldest first. */
  readonly assertions: readonly UserAssertion[];
}

export interface ComposedCandidate {
  /** The candidate with `intentOutcome` "open" while an intent is undecided. */
  readonly candidate: TransactionCandidate;
  /** Instant after which an undecided intent reads as abandoned; null when nothing is pending on the clock. */
  readonly intentDeadline: EpochMillis | null;
  readonly intentObservationIds: readonly ObservationId[];
}

export function candidateIdFor(foundingObservationId: ObservationId): CandidateId {
  return stableId("cand", foundingObservationId);
}

/**
 * Compose a candidate from its cluster. Precedence for every
 * intelligence-owned field: user assertion > latest patch > fact-derived seed.
 */
export function composeCandidate(input: ClusterInput, matcher: MerchantMatcher, config: FusionConfig): ComposedCandidate {
  const { members } = input;
  const founder = members[0];
  if (!founder) throw new RangeError(`Candidate ${input.id} has no observations`);
  const ranked = byAuthority(members);
  const paymentOrdered = paymentLayerFirst(ranked);

  const amount = fuseAmount(members, ranked);
  const merchantFusion = fuseMerchant(ranked, matcher);
  const status = fuseStatus(members);
  const rail = fuseRail(paymentOrdered);
  const instrument = fuseInstrument(paymentOrdered);
  const counterparty = fuseCounterparty(paymentOrdered);
  const lineItems = pickLineItems(members);
  const seeded = seedInferences(members);

  // Timestamps: the most precise money-movement time, else the founding observation's.
  const moneyMovements = members.filter((o) => o.kind === "money_movement");
  const precise = [...moneyMovements].sort((a, b) => (b.occurredAt?.confidence ?? 0) - (a.occurredAt?.confidence ?? 0))[0];
  const timestampEstimated = precise ? timeOf(precise) : timeOf(founder);
  const confirming = members
    .filter((o) => o.kind !== "delivery" && (o.stage === "confirmed" || o.stage === "posted"))
    .sort((a, b) => timeOf(a) - timeOf(b));
  const timestampConfirmed = confirming[0] ? timeOf(confirming[0]) : null;

  // Direction: stated by a money movement, else by any source, else implied by kind.
  const stated = ranked.find((o) => o.direction !== undefined);
  const implied = stated ? undefined : ranked.map(effectiveDirection).find((d) => d !== undefined);
  const direction: Direction | "unknown" = stated?.direction ?? implied ?? "unknown";

  const country = ranked.map((o) => o.country).find((c) => c !== undefined) ?? null;
  const evidence = members.map((o) => ({ o, p: o.confidence * SOURCE_WEIGHTS[observationClass(o)] }));
  let confidence = noisyOrByConnection(evidence);

  const prov: FieldProvenance[] = [];
  if (amount.provenance) prov.push(amount.provenance);
  if (merchantFusion.provenance) prov.push(merchantFusion.provenance);
  prov.push(
    provenance(
      "timestamp",
      uniqueIds([precise?.id ?? founder.id, confirming[0]?.id]),
      precise ? "most precise money-movement time" : "founding observation time",
    ),
  );
  prov.push(status.provenance);
  if (stated) prov.push(provenance("direction", [stated.id], "stated by source"));
  else if (implied) prov.push(provenance("direction", [founder.id], "implied by observation kind", "inferred"));
  if (rail.ids.length > 0) prov.push(provenance("rail", rail.ids, "payment-layer sources"));
  if (instrument.instrument) prov.push(provenance("instrument", instrument.ids, "payment-layer sources"));
  if (lineItems.source) prov.push(provenance("line_items", [lineItems.source.id], `from ${lineItems.source.kind}`));
  prov.push(...seeded.provenance);
  if (input.fusionLinks.length > 0) {
    prov.push(provenance("link", [founder.id], `possible duplicate of ${input.fusionLinks.length} candidate(s)`, "inferred"));
  }

  // Intelligence patches.
  const patch = input.patches.reduce(mergePatches, {} as CandidatePatch);
  let category = patch.category ?? seeded.category;
  let transactionType = patch.transactionType ?? seeded.transactionType;
  // A patched non-transfer type must not inherit a transfer kind seeded from hints.
  const seededTransferKind = patch.transactionType && patch.transactionType.value !== "transfer" ? undefined : seeded.transferKind;
  let transferKind: TransferKind | undefined = patch.transferKind ?? seededTransferKind;
  let attributes: SemanticAttributes = { ...defaultAttributes(), ...definedEntries(patch.attributes) };
  let merchant = merchantFusion.merchant;
  if (patch.merchantNormalized) {
    merchant = {
      ...merchant,
      normalized: patch.merchantNormalized.key,
      displayName: patch.merchantNormalized.displayName,
      confidence: patch.merchantNormalized.confidence,
    };
    prov.push(provenance("merchant", merchantFusion.provenance?.observationIds ?? [], "normalized by merchant resolution", "inferred"));
  }
  // A patched inference supersedes the seeded one, so its provenance replaces the seed's.
  const inferred = (field: ProvenanceField, inference: Inference<string>): void => {
    for (let i = prov.length - 1; i >= 0; i--) if (prov[i]?.field === field && prov[i]?.method === "inferred") prov.splice(i, 1);
    prov.push(provenance(field, [], `basis:${inference.basis.join("+")}`, "inferred"));
  };
  if (patch.category) inferred("category", patch.category);
  if (patch.transactionType) inferred("transaction_type", patch.transactionType);
  if (patch.attributes?.essentiality) inferred("essentiality", patch.attributes.essentiality);
  const links = mergeLinks(input.fusionLinks, patch.links ?? []);
  if (patch.links && patch.links.length > 0) prov.push(provenance("link", [], "reconciliation", "inferred"));
  let candidateStatus = status.status;
  if (patch.status === "refunded") {
    candidateStatus = "refunded";
    prov.push(provenance("status", [], "refunded (reconciliation)", "inferred"));
  }

  // User assertions: always win, never overwritten.
  let userVerified = false;
  let labeledTransfer: { readonly kind?: TransferKind; readonly isTransfer: boolean } | null = null;
  // A user label supersedes inferred provenance for its field and any earlier label of the same kind.
  const userProvenance = (field: ProvenanceField, a: UserAssertion, note: string): void => {
    for (let i = prov.length - 1; i >= 0; i--) {
      const p = prov[i];
      if (p && p.field === field && (p.method === "inferred" || (p.method === "user" && p.note === note))) prov.splice(i, 1);
    }
    prov.push(provenance(field, a.anchors, note, "user"));
  };
  for (const a of input.assertions) {
    if (a.kind === "confirm") {
      userVerified = true;
    } else if (a.kind === "satisfaction") {
      attributes = { ...attributes, satisfaction: { value: a.value, askedAt: a.askedAt, answeredAt: a.at } };
    } else if (a.kind === "label") {
      switch (a.field) {
        case "category":
          category = userInference(a.value);
          userProvenance("category", a, "label:category");
          break;
        case "transaction_type":
          transactionType = userInference(a.value);
          labeledTransfer = { isTransfer: a.value === "transfer", ...(a.transferKind ? { kind: a.transferKind } : {}) };
          userProvenance("transaction_type", a, "label:transaction_type");
          break;
        case "essentiality":
          attributes = { ...attributes, essentiality: userInference(a.value) };
          userProvenance("essentiality", a, "label:essentiality");
          break;
        case "ownership":
          attributes = { ...attributes, ownership: userInference(a.value) };
          userProvenance("attributes", a, "label:ownership");
          break;
        case "intent":
          attributes = { ...attributes, intent: userInference(a.value) };
          userProvenance("attributes", a, "label:intent");
          break;
        case "temporal_type":
          attributes = { ...attributes, temporalType: userInference(a.value) };
          userProvenance("attributes", a, "label:temporal_type");
          break;
        case "purchase_context":
          attributes = { ...attributes, purchaseContext: userInference(a.value) };
          userProvenance("attributes", a, "label:purchase_context");
          break;
      }
    }
  }
  if (labeledTransfer) transferKind = labeledTransfer.kind ?? (labeledTransfer.isTransfer ? transferKind : undefined);
  if (userVerified) confidence = 1;

  // Intent lifecycle: purchased once money moved; otherwise open until the horizon passes.
  const intents = members.filter((o) => o.kind === "purchase_intent");
  let intentOutcome: IntentOutcome | undefined = patch.intentOutcome;
  let intentDeadline: EpochMillis | null = null;
  if (intents.length > 0) {
    const paid = members.some(
      (o) =>
        o.kind !== "purchase_intent" &&
        o.kind !== "delivery" &&
        (STATUS_RANK[o.stage] >= STATUS_RANK.confirmed || (o.kind === "money_movement" && o.stage === "pending")),
    );
    if (paid) intentOutcome = "purchased";
    else if (!patch.intentOutcome) {
      intentOutcome = "open";
      intentDeadline = Math.min(...intents.map(timeOf)) + config.intentHorizonMs;
    }
  }

  const sourceSignals: SourceSignal[] = members.map((o, i) => ({
    observationId: o.id,
    kind: o.kind,
    sourceLabel: o.source.label,
    ...(o.source.provider ? { provider: o.source.provider } : {}),
    adapterId: o.source.adapterId,
    connectionId: o.source.connectionId,
    role: status.roles[i] ?? "enriching",
    matchProbability: input.matchProbabilities.get(o.id) ?? 1,
    linkedAt: o.receivedAt,
  }));

  const updatedAt = Math.max(...members.map((o) => o.receivedAt), ...input.assertions.map((a) => a.at));

  const candidate: TransactionCandidate = {
    id: input.id,
    deduplicationGroup: stableId("dedup", founder.id),
    status: candidateStatus,
    statusHistory: status.history,
    ...(intentOutcome ? { intentOutcome } : {}),
    direction,
    amount: amount.amount,
    ...(amount.originalAmount ? { originalAmount: amount.originalAmount } : {}),
    merchant,
    ...(counterparty ? { counterparty } : {}),
    timestampEstimated,
    timestampConfirmed,
    country,
    paymentRail: rail.rail,
    ...(instrument.instrument ? { instrument: instrument.instrument } : {}),
    sourceSignals,
    references: unionReferences(members),
    lineItems: lineItems.items,
    category,
    transactionType,
    ...(transferKind ? { transferKind } : {}),
    attributes,
    confidence,
    provenance: prov,
    userVerified,
    links,
    createdAt: founder.receivedAt,
    updatedAt,
  };
  return { candidate, intentDeadline, intentObservationIds: intents.map((o) => o.id) };
}

/**
 * Read-time view: an intent nobody acted on within the horizon is
 * "abandoned" (and, per the status model, a cancelled intent). Derived from
 * the clock at read time so the stored state never depends on when it was read.
 */
export function finalizeCandidate(composed: ComposedCandidate, now: EpochMillis): TransactionCandidate {
  const c = composed.candidate;
  if (composed.intentDeadline === null || now <= composed.intentDeadline) return c;
  return {
    ...c,
    intentOutcome: "abandoned",
    status: c.status === "intent" ? "cancelled" : c.status,
    provenance: [...c.provenance, provenance("status", composed.intentObservationIds, "intent abandoned after horizon", "inferred")],
  };
}
