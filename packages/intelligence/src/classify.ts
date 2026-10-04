import { clamp01, unknownInference } from "@brake/core";
import type {
  CandidatePatch,
  CategoryHint,
  CategoryId,
  EpochMillis,
  Essentiality,
  Inference,
  InferenceBasis,
  LineItem,
  MerchantObservation,
  Observation,
  Ownership,
  PurchaseContext,
  PurchaseIntent,
  SemanticAttributes,
  TemporalType,
  TransactionCandidate,
  TransactionType,
  TransferKind,
} from "@brake/core";
import type { ClassificationContext, Classifier, Distribution, UserModel } from "./contracts";
import { keywordCategories, mapCategoryHint, mapMccType, normalizeMcc } from "./hints";
import { createMerchantNormalizer } from "./merchant";
import type { MerchantNormalizer, MerchantResolution } from "./merchant";
import { CATEGORIES, UNCATEGORIZED, getCategory, topLevelCategory } from "./taxonomy";
import { counterpartyKey, isLearnedUserModel } from "./user-model";
import type { LearnedAttribute } from "./user-model";

/**
 * Enrichment: merchant, category, essentiality, a seed transaction type and
 * the semantic attributes BRAKE can honestly infer for one candidate.
 *
 * Evidence is combined as a weighted product of experts in log space. Each
 * expert states a distribution and how reliable it is; unreliability is
 * spread as uniform mass, so a vague hint (MCC 5999, one keyword) cannot
 * overrule a specific one, and nothing is ever stated with more confidence
 * than the evidence supports. Evidence, roughly strongest first:
 *
 *   user history      the user's own past labels for this merchant/payee
 *                     (reliability grows with the number of labels)
 *   line items        what was actually bought; a multi-item order becomes a
 *                     mixture weighted by item totals and replaces
 *                     merchant-level evidence for the items it covers
 *   merchant profile  well-known merchant context
 *   category hints    standard vocabularies (BRAKE ids, MCC, keywords)
 *   keywords          plain words in an unknown merchant's descriptor
 *
 * Categories are combined in two stages — top level first ("eating out"),
 * then the sub-category within it ("delivery") — so a user who taps
 * "Eating out" agrees with, rather than contradicts, a profile that says
 * "Food delivery".
 *
 * The classifier never overwrites a user-set inference, nor one owned by
 * another engine (reconciliation, recurrence detection, user rules).
 */

export interface ClassifierOptions {
  readonly normalizer?: MerchantNormalizer;
}

export function createClassifier(opts: ClassifierOptions = {}): Classifier {
  const normalizer = opts.normalizer ?? createMerchantNormalizer();
  return {
    classify: (candidate, observations, ctx) => classifyCandidate(candidate, observations, ctx, normalizer),
  };
}

/* ------------------------------------------------------------------ */
/* Experts and pooling                                                  */
/* ------------------------------------------------------------------ */

interface Expert<T extends string> {
  /** Probability mass per value (need not cover every value; need not be normalized). */
  readonly dist: ReadonlyMap<T, number>;
  /** Probability the expert is right; the rest is spread uniformly. */
  readonly reliability: number;
  /** Relative weight in the pool (discount for experts correlated with stronger ones). */
  readonly weight: number;
  readonly basis: readonly InferenceBasis[];
}

const BASIS_ORDER: readonly InferenceBasis[] = [
  "user_label",
  "user_history",
  "line_items",
  "merchant_profile",
  "source_hint",
  "reconciliation",
  "recurrence",
  "rule",
  "prior",
  "none",
];

function mergeBases(...groups: ReadonlyArray<readonly InferenceBasis[]>): InferenceBasis[] {
  const set = new Set(groups.flat());
  return BASIS_ORDER.filter((b) => set.has(b));
}

function mapOf<T extends string>(entries: ReadonlyArray<{ readonly value: T; readonly probability: number }>): Map<T, number> {
  const m = new Map<T, number>();
  for (const e of entries) m.set(e.value, (m.get(e.value) ?? 0) + e.probability);
  return m;
}

function normalize<T extends string>(m: ReadonlyMap<T, number>): Map<T, number> {
  const total = [...m.values()].reduce((s, p) => s + p, 0);
  const out = new Map<T, number>();
  if (total <= 0) return out;
  for (const [k, p] of m) out.set(k, p / total);
  return out;
}

/**
 * Weighted log-linear pool over a closed hypothesis set. Weights are
 * relative (the strongest expert counts fully), so a lone expert yields its
 * own reliability-smoothed distribution rather than a sharpened or flattened one.
 */
function pool<T extends string>(experts: readonly Expert<T>[], hypotheses: readonly T[]): Map<T, number> {
  if (experts.length === 0 || hypotheses.length === 0) return new Map();
  const maxWeight = Math.max(...experts.map((e) => e.weight));
  const logits = new Map<T, number>(hypotheses.map((h) => [h, 0]));
  for (const e of experts) {
    const dist = normalize(e.dist);
    const w = e.weight / maxWeight;
    const r = clamp01(e.reliability);
    for (const h of hypotheses) {
      const q = r * (dist.get(h) ?? 0) + (1 - r) / hypotheses.length;
      logits.set(h, logits.get(h)! + w * Math.log(Math.max(q, 1e-12)));
    }
  }
  const max = Math.max(...logits.values());
  const exp = new Map<T, number>([...logits].map(([h, l]) => [h, Math.exp(l - max)]));
  return normalize(exp);
}

/** Dirichlet-style expert from the user's own (decayed) label counts. */
function userExpert<T extends string>(d: Distribution<T>): Expert<T> {
  return { dist: mapOf(d.entries), reliability: d.evidence / (d.evidence + 1), weight: 1, basis: ["user_history"] };
}

function round(p: number): number {
  return Math.round(p * 10_000) / 10_000;
}

/** Turn a distribution into an Inference (argmax + sorted alternatives). */
function toInference<T extends string>(dist: ReadonlyMap<T, number>, basis: readonly InferenceBasis[], maxAlternatives = 5): Inference<T> | null {
  const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted[0];
  if (!top) return null;
  return {
    value: top[0],
    confidence: round(top[1]),
    alternatives: sorted
      .slice(1)
      .filter(([, p]) => p >= 0.01)
      .slice(0, maxAlternatives)
      .map(([value, p]) => ({ value, probability: round(p) })),
    basis: basis.length > 0 ? basis : ["none"],
    userSet: false,
  };
}

/* ------------------------------------------------------------------ */
/* Hierarchical category pooling                                        */
/* ------------------------------------------------------------------ */

const TOP_LEVELS: readonly CategoryId[] = CATEGORIES.filter((c) => !c.parent && c.id !== UNCATEGORIZED).map((c) => c.id);
const CHILDREN = new Map<CategoryId, CategoryId[]>();
for (const c of CATEGORIES) if (c.parent) CHILDREN.set(c.parent, [...(CHILDREN.get(c.parent) ?? []), c.id]);

/**
 * Pool category experts in two stages: top level, then sub-category within
 * each top level. An expert that names only a top level ("eating_out") is
 * silent about the sub-category, so it neither supports nor contradicts
 * "eating_out.delivery". Returns a leaf distribution where a top-level id
 * stands for "no specific sub-category".
 */
function poolCategories(experts: readonly Expert<CategoryId>[]): Map<CategoryId, number> {
  const ids = new Set<CategoryId>();
  for (const e of experts) for (const id of e.dist.keys()) if (id !== UNCATEGORIZED) ids.add(id);
  const tops = [...new Set([...TOP_LEVELS, ...[...ids].map(topLevelCategory)])];

  const topExperts: Expert<CategoryId>[] = experts.map((e) => {
    const m = new Map<CategoryId, number>();
    for (const [id, p] of e.dist) if (id !== UNCATEGORIZED) m.set(topLevelCategory(id), (m.get(topLevelCategory(id)) ?? 0) + p);
    return { ...e, dist: m };
  });
  const topDist = pool(topExperts.filter((e) => e.dist.size > 0), tops);

  const leaves = new Map<CategoryId, number>();
  for (const [top, pTop] of topDist) {
    const kids = [...new Set([...(CHILDREN.get(top) ?? []), ...[...ids].filter((id) => id !== top && topLevelCategory(id) === top)])];
    const informative: Expert<CategoryId>[] = [];
    for (const e of experts) {
      const specific = kids.reduce((s, k) => s + (e.dist.get(k) ?? 0), 0);
      if (specific <= 0) continue;
      const m = new Map<CategoryId, number>([[top, e.dist.get(top) ?? 0]]);
      for (const k of kids) m.set(k, e.dist.get(k) ?? 0);
      informative.push({ ...e, dist: m });
    }
    if (informative.length === 0) {
      leaves.set(top, pTop);
      continue;
    }
    for (const [leaf, p] of pool(informative, [top, ...kids])) leaves.set(leaf, (leaves.get(leaf) ?? 0) + pTop * p);
  }
  return leaves;
}

/**
 * When the evidence is sure about the top level but split across its
 * sub-categories, say the top level: "Eating out (95%)" is more honest and
 * more useful than "Restaurants (55%)".
 */
function categoryInference(leaves: ReadonlyMap<CategoryId, number>, basis: readonly InferenceBasis[]): Inference<CategoryId> | null {
  const inf = toInference(leaves, basis);
  if (!inf) return null;
  const top = topLevelCategory(inf.value);
  if (top === inf.value || inf.confidence >= 0.6) return inf;
  let topMass = 0;
  for (const [id, p] of leaves) if (topLevelCategory(id) === top) topMass += p;
  if (topMass < 0.8) return inf;
  const outside = new Map<CategoryId, number>([[top, topMass]]);
  for (const [id, p] of leaves) if (topLevelCategory(id) !== top) outside.set(id, p);
  return toInference(outside, basis);
}

/* ------------------------------------------------------------------ */
/* Evidence gathering                                                   */
/* ------------------------------------------------------------------ */

const CLASSIFIER_BASES: ReadonlySet<InferenceBasis> = new Set(["merchant_profile", "user_history", "source_hint", "line_items", "prior", "none"]);

/** True when another engine (or the user) owns this inference and the classifier must leave it alone. */
function ownedElsewhere(inf: Inference<string>): boolean {
  return inf.userSet || inf.basis.some((b) => !CLASSIFIER_BASES.has(b));
}

interface MerchantContext {
  readonly resolution: MerchantResolution | null;
  /** True when `resolution` should replace the candidate's merchant key/name. */
  readonly refined: boolean;
  /** Key used for user-history lookups. */
  readonly key: string | null;
  readonly counterpartyKey: string | null;
  /** Probability the payee is a business rather than a person. */
  readonly merchantLikelihood: number;
  readonly texts: readonly string[];
}

function merchantInputs(candidate: TransactionCandidate, observations: readonly Observation[]): MerchantObservation[] {
  const inputs: MerchantObservation[] = [];
  const cm = candidate.merchant;
  if (cm.raw || cm.displayName || cm.handle) {
    inputs.push({
      raw: cm.raw ?? cm.displayName ?? cm.handle ?? "",
      ...(cm.displayName ? { name: cm.displayName } : {}),
      ...(cm.normalized ? { key: cm.normalized } : {}),
      ...(cm.handle ? { handle: cm.handle } : {}),
      confidence: cm.confidence,
    });
  }
  for (const o of observations) {
    if (o.merchant) inputs.push(o.merchant);
    if (o.subscription?.serviceName) inputs.push({ raw: o.subscription.serviceName, name: o.subscription.serviceName, confidence: o.confidence });
  }
  const cp = candidate.counterparty;
  if (cp && (cp.isMerchant ?? 0) >= 0.5 && (cp.name || cp.handle)) {
    inputs.push({ raw: cp.name ?? cp.handle ?? "", ...(cp.handle ? { handle: cp.handle } : {}), confidence: cp.isMerchant ?? 0.5 });
  }
  return inputs.filter((m) => m.raw || m.name || m.handle || m.website || m.key);
}

function resolveMerchant(
  candidate: TransactionCandidate,
  observations: readonly Observation[],
  normalizer: MerchantNormalizer,
  hasMcc: boolean,
): MerchantContext {
  const inputs = merchantInputs(candidate, observations);
  let best: MerchantResolution | null = null;
  for (const m of inputs) {
    const r = normalizer.resolve(m);
    if (r && (!best || r.confidence > best.confidence || (r.confidence === best.confidence && r.profile && !best.profile))) best = r;
  }
  // A key fused from a more confident source is refined only by a resolution at least as confident.
  const existing = candidate.merchant.normalized;
  const keepExisting = existing !== null && best !== null && best.key !== existing && candidate.merchant.confidence > best.confidence;
  const resolution = keepExisting ? normalizer.resolve({ raw: existing, key: existing, confidence: candidate.merchant.confidence }) : best;
  const key = keepExisting ? existing : (best?.key ?? existing);

  let likelihood = 0;
  if (resolution?.profile || resolution?.via === "learned") likelihood = 0.95;
  else if (resolution) likelihood = resolution.confidence >= 0.5 ? 0.6 : 0.4;
  if (!resolution?.profile && candidate.counterparty?.isMerchant !== undefined) likelihood = candidate.counterparty.isMerchant;
  if (hasMcc) likelihood = Math.max(likelihood, 0.9);

  return {
    resolution: resolution ?? null,
    refined: !keepExisting && best !== null,
    key: key ?? null,
    counterpartyKey: counterpartyKey(candidate.counterparty),
    merchantLikelihood: likelihood,
    texts: inputs.flatMap((m) => [m.raw, m.name ?? ""]).filter(Boolean),
  };
}

function collectCategoryHints(candidate: TransactionCandidate, observations: readonly Observation[]): CategoryHint[] {
  const all: CategoryHint[] = [];
  if (candidate.merchant.mcc) all.push({ scheme: "mcc", value: candidate.merchant.mcc, confidence: 0.9 });
  for (const o of observations) {
    for (const h of o.categoryHints ?? []) all.push(h);
    if (o.merchant?.mcc) all.push({ scheme: "mcc", value: o.merchant.mcc, confidence: 0.9 * clamp01(o.merchant.confidence || 1) });
  }
  // The same hint from several sources is one piece of evidence, not several.
  const best = new Map<string, CategoryHint>();
  for (const h of all) {
    const scheme = h.scheme.trim().toLowerCase();
    const value = scheme === "mcc" ? (normalizeMcc(h.value) ?? h.value) : h.value.trim().toLowerCase();
    const k = `${scheme}|${value}`;
    if (!best.has(k) || best.get(k)!.confidence < h.confidence) best.set(k, h);
  }
  return [...best.values()];
}

function lineItemsOf(candidate: TransactionCandidate, observations: readonly Observation[]): readonly LineItem[] {
  if (candidate.lineItems.length > 0) return candidate.lineItems;
  const withItems = observations.filter((o) => (o.lineItems?.length ?? 0) > 0);
  const receipt = withItems.find((o) => o.kind === "receipt");
  const chosen = receipt ?? withItems.sort((a, b) => (b.lineItems?.length ?? 0) - (a.lineItems?.length ?? 0))[0];
  if (chosen?.lineItems) return chosen.lineItems;
  // A pre-spend intent names the product being considered: treat it as a single item.
  return observations
    .map((o) => o.intent?.title)
    .filter((t): t is string => Boolean(t))
    .map((description) => ({ description }));
}

/** Order lines that are charges on the order, not things bought. */
const NON_PRODUCT_LINE = /^\s*(shipping|delivery( fee| charges?)?|postage|handling|tax(es)?|gst|vat|iva|discount|coupon|promo|tip|gratuity|service charge|convenience fee|platform fee|packaging|packing charges?|round ?off|total|subtotal)\b/i;

function itemAmount(item: LineItem): number | null {
  if (item.total) return item.total.minor;
  if (item.unitPrice) return item.unitPrice.minor * (item.quantity ?? 1);
  return null;
}

/* ------------------------------------------------------------------ */
/* Category                                                            */
/* ------------------------------------------------------------------ */

function profileExpert(r: MerchantResolution | null): Expert<CategoryId> | null {
  const p = r?.profile;
  if (!r || !p || p.category === null) return null;
  const alternatives = p.alternatives ?? [];
  const rest = Math.max(0, 1 - alternatives.reduce((s, [, q]) => s + q, 0));
  const dist = new Map<CategoryId, number>([[p.category, rest]]);
  for (const [id, q] of alternatives) dist.set(id, (dist.get(id) ?? 0) + q);
  return { dist, reliability: 0.92 * r.confidence, weight: 1, basis: ["merchant_profile"] };
}

function hintExperts(hints: readonly CategoryHint[]): Expert<CategoryId>[] {
  const out: Expert<CategoryId>[] = [];
  for (const h of hints) {
    const d = mapCategoryHint(h);
    if (!d || d.evidence <= 0) continue;
    out.push({ dist: mapOf(d.entries), reliability: d.evidence, weight: 0.8, basis: ["source_hint"] });
  }
  return out;
}

function keywordExpert(texts: readonly string[], reliability: number, weight: number, basis: InferenceBasis): Expert<CategoryId> | null {
  const d = keywordCategories(texts.join(" \n "));
  return d ? { dist: mapOf(d.entries), reliability, weight, basis: [basis] } : null;
}

const BOOKING_PRIOR = new Map<CategoryId, number>([
  ["travel.lodging", 0.35],
  ["travel.flights", 0.25],
  ["travel", 0.15],
  ["eating_out.restaurant", 0.25],
]);

interface CategoryResult {
  /** Leaf distribution, or null when there is no evidence at all. */
  readonly leaves: Map<CategoryId, number> | null;
  readonly basis: readonly InferenceBasis[];
}

/** Merchant-level evidence: profile, hints, descriptor keywords, observation kind. */
function merchantLevel(m: MerchantContext, hints: readonly CategoryHint[], observations: readonly Observation[]): CategoryResult {
  const experts: Expert<CategoryId>[] = [];
  const profile = profileExpert(m.resolution);
  if (profile) experts.push(profile);
  experts.push(...hintExperts(hints));
  // Words in a descriptor only matter when BRAKE does not already know the merchant.
  if (!m.resolution?.profile) {
    const kw = keywordExpert(m.texts, 0.55, 0.7, "source_hint");
    if (kw) experts.push(kw);
  }
  if (experts.length === 0 && observations.some((o) => o.kind === "booking")) {
    experts.push({ dist: BOOKING_PRIOR, reliability: 0.6, weight: 0.6, basis: ["source_hint"] });
  }
  if (experts.length === 0) return { leaves: null, basis: [] };
  return { leaves: poolCategories(experts), basis: mergeBases(...experts.map((e) => e.basis)) };
}

/**
 * Item-level evidence. Each product line is classified on its own (its own
 * hints and words, else the merchant-level answer), and the order becomes
 * the mixture of its lines weighted by line totals: ₹2,499 toothbrush +
 * ₹500 cable + ₹1,800 dog food is about half personal care, not "Amazon".
 */
function lineItemMixture(items: readonly LineItem[], merchant: CategoryResult): CategoryResult | null {
  const products = items.filter((i) => i.description && !NON_PRODUCT_LINE.test(i.description));
  if (products.length === 0) return null;
  const known = products.map(itemAmount).filter((a): a is number => a !== null && a > 0);
  const fallbackAmount = known.length > 0 ? known.reduce((s, a) => s + a, 0) / known.length : 1;

  let ownEvidence = false;
  const bases: InferenceBasis[][] = [];
  const parts: Array<{ readonly share: number; readonly leaves: ReadonlyMap<CategoryId, number> }> = [];
  for (const item of products) {
    const experts: Expert<CategoryId>[] = hintExperts(item.categoryHints ?? []).map((e) => ({ ...e, basis: ["line_items"] }));
    const kw = keywordExpert([item.description], 0.9, 1, "line_items");
    if (kw) experts.push(kw);
    let leaves: ReadonlyMap<CategoryId, number> | null = null;
    if (experts.length > 0) {
      ownEvidence = true;
      leaves = poolCategories(experts);
      bases.push(["line_items"]);
    } else if (merchant.leaves) {
      leaves = merchant.leaves;
      bases.push([...merchant.basis]);
    }
    const amount = itemAmount(item);
    if (leaves) parts.push({ share: amount !== null && amount > 0 ? amount : fallbackAmount, leaves });
  }
  if (!ownEvidence || parts.length === 0) return null;

  const total = parts.reduce((s, p) => s + p.share, 0);
  const mixture = new Map<CategoryId, number>();
  for (const { share, leaves } of parts) {
    for (const [id, p] of leaves) mixture.set(id, (mixture.get(id) ?? 0) + (share / total) * p);
  }
  return { leaves: mixture, basis: mergeBases(...bases) };
}

function inferenceDistribution(inf: Inference<CategoryId>): Map<CategoryId, number> {
  const m = new Map<CategoryId, number>([[inf.value, inf.confidence > 0 ? inf.confidence : 1]]);
  for (const a of inf.alternatives) m.set(a.value, (m.get(a.value) ?? 0) + a.probability);
  return m;
}

/* ------------------------------------------------------------------ */
/* Essentiality                                                        */
/* ------------------------------------------------------------------ */

type KnownEssentiality = Exclude<Essentiality, "unknown">;
const ESSENTIALITY: readonly KnownEssentiality[] = ["essential", "semi_discretionary", "discretionary"];

function essentialityPrior(id: CategoryId): ReadonlyMap<KnownEssentiality, number> {
  const def = getCategory(id) ?? getCategory(topLevelCategory(id)) ?? getCategory("other");
  return new Map(ESSENTIALITY.map((e) => [e, def?.essentiality[e] ?? 1 / 3]));
}

/**
 * Essentiality follows from the category distribution: Σ P(category) ×
 * P(essentiality | category), where the population prior per category is
 * blended with this user's own essentiality answers for that category
 * (pseudo-count 1 for the prior, so a few answers quickly dominate).
 */
function essentialityInference(
  categories: ReadonlyMap<CategoryId, number>,
  categoryBasis: readonly InferenceBasis[],
  userModel: UserModel,
  now: EpochMillis,
): Inference<Essentiality> | null {
  const learned = isLearnedUserModel(userModel) ? userModel : null;
  const acc = new Map<KnownEssentiality, number>(ESSENTIALITY.map((e) => [e, 0]));
  let usedHistory = false;
  for (const [id, p] of normalize(categories)) {
    if (p < 0.005) continue;
    const prior = essentialityPrior(id);
    const user = learned ? learned.essentialityFor(id, now) : userModel.essentialityFor(id);
    const n = user?.evidence ?? 0;
    const userDist = user ? mapOf(user.entries) : new Map<KnownEssentiality, number>();
    if (n > 0 && p >= 0.05) usedHistory = true;
    for (const e of ESSENTIALITY) {
      const blended = ((prior.get(e) ?? 0) + n * (userDist.get(e) ?? 0)) / (1 + n);
      acc.set(e, acc.get(e)! + p * blended);
    }
  }
  return toInference<Essentiality>(normalize(acc), mergeBases(categoryBasis, ["prior"], usedHistory ? ["user_history"] : []));
}

/* ------------------------------------------------------------------ */
/* Transaction type                                                     */
/* ------------------------------------------------------------------ */

const TYPES: readonly TransactionType[] = [
  "purchase",
  "transfer",
  "refund",
  "subscription",
  "cash_withdrawal",
  "income",
  "loan_payment",
  "credit_card_payment",
  "investment",
  "reimbursement",
  "shared_expense",
  "business_expense",
  "fee",
  "tax",
];

const DEBIT_AT_MERCHANT = new Map<TransactionType, number>([
  ["purchase", 0.8],
  ["transfer", 0.15],
  ["fee", 0.05],
]);

interface TypeResult {
  readonly inference: Inference<TransactionType>;
  readonly transferKind?: TransferKind;
}

function mayReseedType(current: Inference<TransactionType>): boolean {
  if (current.userSet) return false;
  return current.value === "unknown" || current.basis.every((b) => CLASSIFIER_BASES.has(b));
}

function typeInference(
  candidate: TransactionCandidate,
  observations: readonly Observation[],
  hints: readonly CategoryHint[],
  m: MerchantContext,
  userModel: UserModel,
  now: EpochMillis,
): TypeResult | null {
  const learned = isLearnedUserModel(userModel) ? userModel : null;
  const experts: Expert<TransactionType>[] = [];
  const kinds = new Map<TransferKind, number>();
  const addKind = (k: TransferKind | undefined, w: number) => {
    if (k && k !== "unknown") kinds.set(k, (kinds.get(k) ?? 0) + w);
  };

  const hint = m.resolution?.profile?.typeHint;
  if (hint && m.resolution) {
    const reliability = hint.confidence * m.resolution.confidence;
    experts.push({ dist: new Map([[hint.type, 1]]), reliability, weight: 1, basis: ["merchant_profile"] });
    addKind(hint.transferKind, reliability);
  }

  const seen = new Map<string, { type: TransactionType; kind?: TransferKind; confidence: number }>();
  for (const o of observations) {
    for (const h of o.typeHints ?? []) {
      const k = `${h.type}|${h.transferKind ?? ""}|${h.reason}`;
      if (!seen.has(k) || seen.get(k)!.confidence < h.confidence) seen.set(k, { type: h.type, ...(h.transferKind ? { kind: h.transferKind } : {}), confidence: h.confidence });
    }
  }
  for (const h of seen.values()) {
    if (h.type === "unknown") continue;
    experts.push({ dist: new Map([[h.type, 1]]), reliability: h.confidence, weight: 0.9, basis: ["source_hint"] });
    addKind(h.kind, h.confidence);
  }

  // Money-movement MCCs (ATM, money transfer, brokerage, stored-value load, tax) carry type, not category.
  for (const h of hints) {
    if (h.scheme.trim().toLowerCase() !== "mcc") continue;
    const t = mapMccType(h.value);
    if (!t) continue;
    const reliability = t.confidence * clamp01(h.confidence);
    experts.push({ dist: new Map([[t.type, 1]]), reliability, weight: 0.9, basis: ["source_hint"] });
    addKind(t.transferKind, reliability);
  }

  for (const key of [m.key, m.counterpartyKey]) {
    if (!key) continue;
    const d = learned ? learned.typeFor(key, now) : userModel.typeFor(key);
    if (d) experts.push(userExpert(d));
    const tk = learned ? learned.transferKindFor(key, now) : userModel.transferKindFor(key);
    if (tk) for (const e of tk.entries) addKind(e.value, e.probability * tk.evidence);
  }

  const spendingLike = candidate.direction === "debit" || (candidate.direction === "unknown" && observations.some((o) => o.kind === "purchase_intent" || o.kind === "checkout"));
  if (experts.length === 0 && spendingLike && m.merchantLikelihood >= 0.5) {
    experts.push({ dist: DEBIT_AT_MERCHANT, reliability: m.merchantLikelihood, weight: 1, basis: ["prior"] });
  }
  if (experts.length === 0) return null;

  const inference = toInference(pool(experts, TYPES), mergeBases(...experts.map((e) => e.basis)), 4);
  if (!inference) return null;
  const kind = [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return inference.value === "transfer" && kind ? { inference, transferKind: kind } : { inference };
}

/* ------------------------------------------------------------------ */
/* Semantic attributes                                                  */
/* ------------------------------------------------------------------ */

const TEMPORAL: readonly TemporalType[] = ["one_off", "recurring", "subscription"];
const INTENTS: readonly PurchaseIntent[] = ["planned", "unplanned", "impulsive", "recurring", "emergency"];
const OWNERSHIP: readonly Ownership[] = ["personal", "business", "family", "shared", "reimbursable"];
const CONTEXTS: readonly PurchaseContext[] = ["planned_in_advance", "saw_and_bought", "recommended", "replacement", "upgrade", "social", "convenience"];

/** The profile flag is a strong prior, not a fact: ~0.7 subscription. */
const SUBSCRIPTION_PROFILE = new Map<TemporalType, number>([
  ["subscription", 0.72],
  ["recurring", 0.08],
  ["one_off", 0.2],
]);
const SUBSCRIPTION_CHARGE = new Map<TemporalType, number>([
  ["subscription", 0.92],
  ["recurring", 0.06],
  ["one_off", 0.02],
]);
const SUBSCRIPTION_MCC = new Map<TemporalType, number>([
  ["subscription", 0.6],
  ["recurring", 0.2],
  ["one_off", 0.2],
]);

function learnedAttributeExperts(field: LearnedAttribute, m: MerchantContext, userModel: UserModel, now: EpochMillis): Expert<string>[] {
  if (!isLearnedUserModel(userModel)) return [];
  const out: Expert<string>[] = [];
  for (const key of [m.key, m.counterpartyKey]) {
    if (!key) continue;
    const d = userModel.attributeFor(field, key, now);
    if (d) out.push(userExpert(d));
  }
  return out;
}

function attributeInference<T extends string>(experts: readonly Expert<T>[], values: readonly T[]): Inference<T> | null {
  if (experts.length === 0) return null;
  return toInference(pool(experts, values), mergeBases(...experts.map((e) => e.basis)), 3);
}

function temporalExperts(m: MerchantContext, hints: readonly CategoryHint[], observations: readonly Observation[], userModel: UserModel, now: EpochMillis): Expert<TemporalType>[] {
  const experts: Expert<TemporalType>[] = [];
  if (m.resolution?.profile?.isSubscription) {
    experts.push({ dist: SUBSCRIPTION_PROFILE, reliability: m.resolution.confidence, weight: 1, basis: ["merchant_profile"] });
  }
  const charge = observations.find((o) => o.kind === "subscription_event" && (o.subscription?.event === "charged" || o.subscription?.event === "signup"));
  if (charge) experts.push({ dist: SUBSCRIPTION_CHARGE, reliability: charge.confidence, weight: 1, basis: ["source_hint"] });
  if (hints.some((h) => h.scheme.trim().toLowerCase() === "mcc" && normalizeMcc(h.value) === "5968")) {
    experts.push({ dist: SUBSCRIPTION_MCC, reliability: 0.8, weight: 0.8, basis: ["source_hint"] });
  }
  experts.push(...(learnedAttributeExperts("temporal_type", m, userModel, now) as Expert<TemporalType>[]));
  return experts;
}

/* ------------------------------------------------------------------ */
/* Classify                                                            */
/* ------------------------------------------------------------------ */

type MutablePatch = { -readonly [K in keyof CandidatePatch]: CandidatePatch[K] };
type MutableAttributes = { -readonly [K in keyof SemanticAttributes]?: SemanticAttributes[K] };

function classifyCandidate(
  candidate: TransactionCandidate,
  observations: readonly Observation[],
  ctx: ClassificationContext,
  normalizer: MerchantNormalizer,
): CandidatePatch {
  const now = ctx.now;
  const userModel = ctx.userModel;
  const learned = isLearnedUserModel(userModel) ? userModel : null;
  const patch: MutablePatch = {};
  const attributes: MutableAttributes = {};

  const hints = collectCategoryHints(candidate, observations);
  const hasMcc = hints.some((h) => h.scheme.trim().toLowerCase() === "mcc" && mapCategoryHint(h) !== null);
  const merchant = resolveMerchant(candidate, observations, normalizer, hasMcc);
  if (merchant.refined && merchant.resolution) {
    const r = merchant.resolution;
    patch.merchantNormalized = { key: r.key, displayName: r.displayName, confidence: r.confidence };
  }

  /* Category ----------------------------------------------------- */
  let categoryLeaves: Map<CategoryId, number> | null = null;
  let categoryBasis: readonly InferenceBasis[] = [];
  if (ownedElsewhere(candidate.category)) {
    if (candidate.category.value !== UNCATEGORIZED) {
      categoryLeaves = inferenceDistribution(candidate.category);
      categoryBasis = candidate.category.basis;
    }
  } else {
    const merchantResult = merchantLevel(merchant, hints, observations);
    const base = lineItemMixture(lineItemsOf(candidate, observations), merchantResult) ?? merchantResult;
    const history =
      (merchant.key ? (learned ? learned.categoryFor(merchant.key, now) : userModel.categoryFor(merchant.key)) : null) ??
      (merchant.counterpartyKey ? (learned ? learned.categoryFor(merchant.counterpartyKey, now) : userModel.categoryFor(merchant.counterpartyKey)) : null);

    if (base.leaves && history) {
      const experts: Expert<CategoryId>[] = [
        { dist: base.leaves, reliability: 0.9, weight: 1, basis: base.basis },
        userExpert(history),
      ];
      categoryLeaves = poolCategories(experts);
      categoryBasis = mergeBases(["user_history"], base.basis);
    } else if (history) {
      categoryLeaves = poolCategories([userExpert(history)]);
      categoryBasis = ["user_history"];
    } else if (base.leaves) {
      categoryLeaves = base.leaves;
      categoryBasis = base.basis;
    }

    const inference = categoryLeaves ? categoryInference(categoryLeaves, categoryBasis) : null;
    patch.category = inference ?? unknownInference<CategoryId>(UNCATEGORIZED);
  }

  /* Essentiality ------------------------------------------------- */
  if (!ownedElsewhere(candidate.attributes.essentiality)) {
    const ess = categoryLeaves ? essentialityInference(categoryLeaves, categoryBasis, userModel, now) : null;
    attributes.essentiality = ess ?? unknownInference<Essentiality>("unknown");
  }

  /* Transaction type --------------------------------------------- */
  if (mayReseedType(candidate.transactionType)) {
    const t = typeInference(candidate, observations, hints, merchant, userModel, now);
    if (t) {
      patch.transactionType = t.inference;
      if (t.transferKind) patch.transferKind = t.transferKind;
    }
  }

  /* Temporal type, intent, ownership, purchase context ------------ */
  const temporal = attributeInference(temporalExperts(merchant, hints, observations, userModel, now), TEMPORAL);
  if (temporal && !ownedElsewhere(candidate.attributes.temporalType)) attributes.temporalType = temporal;

  // A subscription charge is recurring by intent; recurrence detection, when it owns the field, counts too.
  const effectiveTemporal = attributes.temporalType ?? candidate.attributes.temporalType;
  const intentExperts = learnedAttributeExperts("intent", merchant, userModel, now) as Expert<PurchaseIntent>[];
  if (effectiveTemporal.value === "subscription" && effectiveTemporal.confidence >= 0.6) {
    intentExperts.push({
      dist: new Map<PurchaseIntent, number>([["recurring", 1]]),
      reliability: 0.85 * effectiveTemporal.confidence,
      weight: 0.8,
      basis: effectiveTemporal.basis,
    });
  }
  const intent = attributeInference(intentExperts, INTENTS);
  if (intent && !ownedElsewhere(candidate.attributes.intent)) attributes.intent = intent;

  const ownership = attributeInference(learnedAttributeExperts("ownership", merchant, userModel, now) as Expert<Ownership>[], OWNERSHIP);
  if (ownership && !ownedElsewhere(candidate.attributes.ownership)) attributes.ownership = ownership;

  const context = attributeInference(learnedAttributeExperts("purchase_context", merchant, userModel, now) as Expert<PurchaseContext>[], CONTEXTS);
  if (context && !ownedElsewhere(candidate.attributes.purchaseContext)) attributes.purchaseContext = context;

  if (Object.keys(attributes).length > 0) patch.attributes = attributes;
  return patch;
}
