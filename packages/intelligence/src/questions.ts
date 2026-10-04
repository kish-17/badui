import { HOUR, clamp01, stableId } from "@brake/core";
import type {
  CandidateLink,
  CurrencyCode,
  Inference,
  LabelField,
  Money,
  Probability,
  TransactionCandidate,
  TransactionType,
  TransferKind,
} from "@brake/core";
import type {
  AskDecision,
  AskReason,
  LabelOption,
  Question,
  QuestionContext,
  QuestionKind,
  QuestionPolicy,
} from "./contracts";
import { candidateAmountText, describeCandidate } from "./copy";
import type { CandidateDescription } from "./copy";
import { MORE_OPTION, UNCATEGORIZED, getCategory, labelOption, optionForCategory, topLevelCategory } from "./taxonomy";
import { counterpartyKey } from "./user-model";

/**
 * Uncertainty-driven questions: BRAKE asks only when an answer is worth more
 * than the interruption it costs.
 *
 *   value = uncertainty × impact × learning value + bonuses
 *   cost  = base + fatigue + unanswered-streak penalty + spacing
 *   ask iff value − cost > 0, the weekly budget is not spent, and no hard rule forbids it.
 *
 * This is a decision-theoretic (expected value of information) policy in the
 * sense of Kapoor & Horvitz 2008: ask about the transactions whose answers
 * change a budget interpretation, a future intervention, or many future
 * transactions at the same merchant; stay silent when the answer is already
 * predictable (docs/research/09 §E9, §4.3).
 *
 * Everything here reads normalized candidate fields only — never the adapter,
 * provider, country or OS that produced the candidate.
 */

/* ------------------------------------------------------------------ */
/* Options and defaults                                                */
/* ------------------------------------------------------------------ */

/** Local hours during which BRAKE does not interrupt: `from` inclusive, `to` exclusive, wrapping past midnight when from > to. */
export interface QuietHours {
  readonly from: number;
  readonly to: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { from: 22, to: 8 };

/** Questions expire silently (never re-sent) after this long. */
export const QUESTION_TTL_MS = 48 * HOUR;

export const DEFAULT_WEEKLY_QUESTION_BUDGET = 5;

/**
 * Below these amounts a purchase is too small to interrupt anyone about
 * (unless it may not be spending at all). Keyed by ISO 4217 code, in minor
 * units; roughly one to two US dollars of purchasing power. Currencies not
 * listed fall back to 1% of the user's weekly baseline.
 */
export const DEFAULT_TINY_AMOUNT_MINOR: Readonly<Record<CurrencyCode, number>> = {
  INR: 10_000, // ₹100
  USD: 200,
  EUR: 200,
  GBP: 200,
  CAD: 300,
  AUD: 300,
  SGD: 300,
  BRL: 1_000, // R$10
  MXN: 4_000,
  KES: 10_000, // KSh 100
  NGN: 100_000,
  ZAR: 3_000,
  JPY: 300, // zero-exponent currency: ¥300
};

export interface QuestionPolicyOptions {
  /** Maximum questions per rolling 7 days. Default 5. */
  readonly weeklyBudget?: number;
  /** Hours in which questions are deferred. Default 22:00–08:00; `null` disables. */
  readonly quietHours?: QuietHours | null;
  /** Per-currency "tiny amount" floors in minor units; merged over DEFAULT_TINY_AMOUNT_MINOR. */
  readonly minAmountMinorByCurrency?: Readonly<Record<CurrencyCode, number>>;
  /** Fixed cost of any interruption, in value units. Default 0.1. */
  readonly baseCost?: number;
}

/** Why a question was not asked. */
export type QuestionSuppression =
  | "user_verified"
  | "intent"
  | "cancelled"
  | "refunded"
  | "surface_unsupported"
  | "already_labeled"
  | "predictable"
  | "sensitive_category"
  | "tiny_amount"
  | "backing_off"
  | "budget_exhausted"
  | "low_value"
  | "quiet_hours";

/** Back off entirely after this many consecutive unanswered questions. */
const BACK_OFF_STREAK = 3;
const UNANSWERED_PENALTY = 0.1;
/** A question right after another one costs extra, fading to nothing over this window (no bursts). */
const SPACING_WINDOW_MS = 2 * HOUR;
const SPACING_COST = 0.25;
/** At most this many buttons on any surface: the brief's example shows five. Never fifteen. */
const MAX_OPTIONS = 5;

/** Category confidence at or above which the answer is "already highly predictable". */
const PREDICTABLE_CATEGORY = 0.85;
/** Candidate (existence) confidence below which BRAKE asks whether the transaction is real. */
const EXISTENCE_DOUBT = 0.6;
/** Type ambiguity at which the spending/non-spending split is the main question. */
const TYPE_QUESTION_AMBIGUITY = 0.4;
/** Type ambiguity below which the type is treated as settled. */
const TYPE_SETTLED_AMBIGUITY = 0.2;
/**
 * Thresholds are inclusive ("P(transfer) ≥ 0.2"), but 2·min(p, 1−p) rarely
 * lands on them exactly (1 − 0.8 is 0.19999999999999996), so comparisons
 * allow for floating-point error.
 */
const atLeast = (x: number, threshold: number): boolean => x >= threshold - 1e-9;
/** Category questions are not worth asking for candidates that are almost surely not spending. */
const SPENDING_RELEVANCE_FLOOR = 0.1;
/** Amount over the merchant's typical amount that counts as unusual. */
const UNUSUAL_MULTIPLE = 3;
/** Share of a typical week's spending at which one transaction is "material". */
const MATERIAL_SHARE = 0.1;
/** Share of a typical week's spending at which impact saturates. */
const FULL_IMPACT_SHARE = 0.25;
/** Possible-duplicate links below this probability are not asked about. */
const DUPLICATE_FLOOR = 0.2;
/** Categories BRAKE never asks "what was this?" about (docs/research/09 §4.3). */
const SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set(["health", "donations"]);

/* ------------------------------------------------------------------ */
/* Assertion-only options                                              */
/* ------------------------------------------------------------------ */

/**
 * `LabelOption.effect` can only express field labels, but some answers are
 * assertions about the candidate itself (confirm / dismiss / same event /
 * different events). Those options carry this inert placeholder effect and
 * the orchestrator turns them into assertions with `optionAssertion()`.
 */
const ASSERTION_ONLY_EFFECT: LabelField = { field: "purchase_context", value: "unknown" };

/**
 * "Is this a real transaction of yours?" answers (ids per the learning-loop spec).
 * "Yes, mine" confirms the event; it says nothing about personal vs business
 * (a work expense is still "mine"), so it asserts no ownership.
 */
export const EXISTENCE_OPTIONS: readonly LabelOption[] = [
  { id: "yes_mine", label: "Yes, mine", effect: ASSERTION_ONLY_EFFECT },
  // Opens the picker so the user can say what it was instead (transfer, refund, not a transaction…).
  { id: "not_purchase", label: "Not a purchase", effect: { field: "transaction_type", value: "transfer" }, opensPicker: true },
  { id: "not_mine", label: "Not mine", effect: ASSERTION_ONLY_EFFECT },
];

/** "Is this the same purchase as one already listed?" answers. */
export const SAME_EVENT_OPTIONS: readonly LabelOption[] = [
  { id: "same_purchase", label: "Same purchase", effect: ASSERTION_ONLY_EFFECT },
  { id: "different_purchase", label: "Different", effect: ASSERTION_ONLY_EFFECT },
];

/**
 * The same answers for money that is probably not a purchase (incoming
 * money, transfers): calling a transfer a "purchase" is the trust-destroying
 * mistake the brief warns about. Ids are unchanged so `optionAssertion` applies.
 */
const SAME_EVENT_PAYMENT_OPTIONS: readonly LabelOption[] = [
  { id: "same_purchase", label: "Same payment", effect: ASSERTION_ONLY_EFFECT },
  { id: "different_purchase", label: "Different", effect: ASSERTION_ONLY_EFFECT },
];

/** Existence answers for incoming money, which nobody would take for a purchase. */
const CREDIT_EXISTENCE_OPTIONS: readonly LabelOption[] = EXISTENCE_OPTIONS.map((o) =>
  o.id === "not_purchase" ? { ...o, label: "Something else" } : o,
);

/** The assertion (beyond its field effect) that answering with an option implies. */
export type OptionAssertion =
  | { readonly kind: "confirm" }
  | { readonly kind: "dismiss"; readonly reason: "not_mine" }
  | { readonly kind: "same_event" }
  | { readonly kind: "different_events" };

/**
 * Map an answered option id to the candidate-level assertion it implies, or
 * null when the option's `effect` (or picker) says everything.
 */
export function optionAssertion(optionId: string): OptionAssertion | null {
  switch (optionId) {
    case "yes_mine":
      return { kind: "confirm" };
    case "not_mine":
      return { kind: "dismiss", reason: "not_mine" };
    case "same_purchase":
      return { kind: "same_event" };
    case "different_purchase":
      return { kind: "different_events" };
    default:
      return null;
  }
}

/* Type options the shared taxonomy does not define (types with no one-tap label there). */
const PURCHASE_OPTION: LabelOption = { id: "purchase", label: "Purchase", effect: { field: "transaction_type", value: "purchase" } };
const FEE_OPTION: LabelOption = { id: "fee", label: "Fee", effect: { field: "transaction_type", value: "fee" } };
const TAX_OPTION: LabelOption = { id: "tax", label: "Tax", effect: { field: "transaction_type", value: "tax" } };
const CASH_OPTION: LabelOption = { id: "cash", label: "Cash", effect: { field: "transaction_type", value: "cash_withdrawal" } };
const INCOME_OPTION: LabelOption = { id: "income", label: "Income", effect: { field: "transaction_type", value: "income" } };
const PAID_BACK_OPTION: LabelOption = { id: "paid_back", label: "Paid back", effect: { field: "transaction_type", value: "reimbursement" } };

/** Common choices used to fill a category question when predictions are thin. */
const FALLBACK_CATEGORY_OPTION_IDS = ["shopping", "groceries", "eating_out", "household", "transport", "entertainment"] as const;

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for reuse and tests)                         */
/* ------------------------------------------------------------------ */

export function isQuietHour(hour: number, quiet: QuietHours | null): boolean {
  if (!quiet || quiet.from === quiet.to) return false;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return quiet.from < quiet.to ? h >= quiet.from && h < quiet.to : h >= quiet.from || h < quiet.to;
}

/**
 * How much one more label teaches BRAKE about a merchant: the first label
 * propagates to every future visit, the fourth adds little. `null` (no stable
 * merchant/counterparty key) means the answer fixes this transaction only.
 */
export function learningValue(labelCount: number | null): number {
  if (labelCount === null) return 0.5;
  if (labelCount <= 0) return 1;
  if (labelCount <= 2) return 0.6;
  return 0.25;
}

/** Types that count toward spending; mirrors `spending.ts`, whose definition is authoritative for budgets. */
const SPENDING_TYPES: ReadonlySet<TransactionType> = new Set([
  "purchase",
  "subscription",
  "fee",
  "tax",
  "shared_expense",
  "business_expense",
]);
/** Credits that offset spending (the budget-relevant side of an incoming payment). */
const OFFSETTING_TYPES: ReadonlySet<TransactionType> = new Set(["refund", "reimbursement"]);

type TypeEntry = { readonly value: TransactionType; readonly probability: number };

/** Uninformed debits are most likely purchases, but not certainly (consistent with spending.ts). */
const UNINFORMED_DEBIT: readonly TypeEntry[] = [
  { value: "purchase", probability: 0.6 },
  { value: "transfer", probability: 0.3 },
  { value: "credit_card_payment", probability: 0.05 },
  { value: "investment", probability: 0.05 },
];
const UNINFORMED_CREDIT: readonly TypeEntry[] = [
  { value: "refund", probability: 0.35 },
  { value: "transfer", probability: 0.35 },
  { value: "income", probability: 0.3 },
];

export interface TypeSplit {
  /**
   * Probability of the budget-relevant side: spending types for a debit,
   * refund/reimbursement for a credit.
   */
  readonly pRelevant: Probability;
  /** 2·min(p, 1−p): 0 when the side is settled, 1 at a coin flip. */
  readonly ambiguity: number;
  /**
   * Distribution over known types. Mass the inference did not assign to a
   * known type (an explicit "unknown", or alternatives a producer left out)
   * is spread by the direction prior, never handed to the listed types.
   */
  readonly distribution: readonly TypeEntry[];
  /** False when the type inference said (almost) nothing and the direction prior decides. */
  readonly informed: boolean;
  /** True when the user already settled the question (type or category set by the user). */
  readonly settledByUser: boolean;
}

/** Below this much mass on known types the inference is treated as saying nothing. */
const INFORMED_TYPE_MASS = 0.05;

/**
 * The spending-vs-not split of a candidate's type distribution. This is the
 * ambiguity that matters most: calling a transfer "spending" destroys trust.
 *
 * Classifiers list only the values some evidence supported, so an inference
 * like "purchase 0.5" with no alternatives leaves half its mass unassigned.
 * Renormalizing over the listed values would turn that into a certain
 * purchase (and "unknown 0.7 / transfer 0.3" into a certain transfer); the
 * unassigned mass instead follows the same uninformed prior an empty
 * inference gets, so the split moves smoothly between knowing nothing and knowing the type.
 */
export function typeSplit(c: TransactionCandidate): TypeSplit {
  const credit = c.direction === "credit";
  const relevant = credit ? OFFSETTING_TYPES : SPENDING_TYPES;
  const t = c.transactionType;

  if (t.userSet) {
    const p = relevant.has(t.value) ? 1 : 0;
    return { pRelevant: p, ambiguity: 0, distribution: [{ value: t.value, probability: 1 }], informed: true, settledByUser: true };
  }
  // A user-chosen category says what the money was for, so it is spending.
  if (!credit && c.category.userSet) {
    return { pRelevant: 1, ambiguity: 0, distribution: [{ value: "purchase", probability: 1 }], informed: true, settledByUser: true };
  }

  const mass = new Map<TransactionType, number>();
  const add = (v: TransactionType, p: number) => {
    if (v !== "unknown" && p > 0) mass.set(v, (mass.get(v) ?? 0) + p);
  };
  add(t.value, t.confidence);
  for (const alt of t.alternatives) add(alt.value, alt.probability);
  const listed = [...mass.values()].reduce((a, b) => a + b, 0);
  const unassigned = Math.max(0, 1 - listed);
  for (const e of credit ? UNINFORMED_CREDIT : UNINFORMED_DEBIT) add(e.value, unassigned * e.probability);
  const total = listed + unassigned;

  // Stable sort: listed types win ties against prior-only ones, so output is deterministic.
  const distribution: readonly TypeEntry[] = [...mass.entries()]
    .map(([value, p]) => ({ value, probability: p / total }))
    .sort((a, b) => b.probability - a.probability);
  const pRelevant = clamp01(distribution.reduce((s, e) => s + (relevant.has(e.value) ? e.probability : 0), 0));
  return {
    pRelevant,
    ambiguity: 2 * Math.min(pRelevant, 1 - pRelevant),
    distribution,
    informed: listed >= INFORMED_TYPE_MASS,
    settledByUser: false,
  };
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

interface Assessment {
  readonly kind: QuestionKind | null;
  readonly description: CandidateDescription;
  readonly split: TypeSplit;
  readonly predictable: boolean;
  readonly value: number;
  readonly tiny: boolean;
  readonly reasons: readonly AskReason[];
  readonly duplicate: CandidateLink | null;
}

const REASON_ORDER: readonly AskReason[] = [
  "low_confidence",
  "material_budget_impact",
  "essentiality_uncertain",
  "ambiguous_merchant",
  "unusual",
  "improves_interventions",
  "possible_transfer_or_refund",
  "possible_duplicate",
];

/**
 * The key the user model learns labels under (user-model.ts): the merchant
 * key, else the *hashed* counterparty key. Looking up a raw payee handle
 * would always miss, so every family transfer would look brand new and be
 * asked about again.
 */
function learningKey(c: TransactionCandidate): string | null {
  const merchant = c.merchant.normalized?.trim().toLowerCase();
  return merchant ? merchant : counterpartyKey(c.counterparty);
}

function sameCurrency(a: Money | null, currency: CurrencyCode): a is Money {
  return a !== null && a.currency === currency && a.minor > 0;
}

/**
 * The most likely possible-duplicate link worth a "same purchase?" question.
 * A link its producer rates as very unlikely is not worth an interruption
 * (fusion records links at ≥ 0.5 by default; the floor guards other producers).
 */
function strongestDuplicate(c: TransactionCandidate): CandidateLink | null {
  let best: CandidateLink | null = null;
  for (const l of c.links) {
    if (l.kind !== "possible_duplicate" || !(l.probability >= DUPLICATE_FLOOR)) continue;
    if (!best || l.probability > best.probability) best = l;
  }
  return best;
}

/**
 * How unsure BRAKE is whether the purchase is essential: from the
 * candidate's own essentiality inference when it has one, otherwise the
 * user's learned distribution for the category, else the taxonomy prior.
 */
function essentialityUncertainty(c: TransactionCandidate, ctx: QuestionContext): number {
  const e = c.attributes.essentiality;
  if (e.userSet) return 0;
  if (e.value !== "unknown" && e.confidence > 0) return 1 - e.confidence;
  const learned = ctx.userModel.essentialityFor(c.category.value);
  if (learned && learned.entries.length > 0) return 1 - Math.max(...learned.entries.map((x) => x.probability));
  const def = getCategory(c.category.value) ?? getCategory(topLevelCategory(c.category.value));
  const prior = def ? Object.values(def.essentiality) : [];
  return prior.length > 0 ? 1 - Math.max(...prior) : 1;
}

/** True when the two best category guesses are close: a multi-category merchant (Amazon, a supermarket). */
function multiCategory(category: Inference<string>): boolean {
  const second = category.alternatives[0]?.probability ?? 0;
  return second >= 0.2 && category.confidence - second < 0.15;
}

interface Impact {
  /** 0..1: how much this transaction moves the user's picture of the week. */
  readonly impact: number;
  readonly material: boolean;
  readonly tiny: boolean;
}

/**
 * Impact relative to the user's own weekly spending when known; otherwise
 * amount bands expressed in multiples of the currency's tiny-amount floor.
 */
function impactOf(c: TransactionCandidate, ctx: QuestionContext, tinyFloors: Readonly<Record<string, number>>): Impact {
  if (!c.amount) return { impact: 0.5, material: false, tiny: false };
  const amount = c.amount.value;
  const baseline = sameCurrency(ctx.weeklySpendingBaseline, amount.currency) ? ctx.weeklySpendingBaseline : null;
  const tinyFloor = tinyFloors[amount.currency] ?? (baseline ? baseline.minor * 0.01 : null);
  const tiny = tinyFloor !== null && amount.minor < tinyFloor;

  if (baseline) {
    const share = amount.minor / baseline.minor;
    return { impact: Math.sqrt(Math.min(1, share / FULL_IMPACT_SHARE)), material: share >= MATERIAL_SHARE, tiny };
  }
  if (tinyFloor === null) return { impact: 0.5, material: false, tiny: false };
  const units = amount.minor / tinyFloor;
  if (units < 1) return { impact: 0.1, material: false, tiny };
  if (units < 10) return { impact: 0.3, material: false, tiny };
  if (units < 50) return { impact: 0.55, material: false, tiny };
  if (units < 250) return { impact: 0.8, material: true, tiny };
  return { impact: 1, material: true, tiny };
}

function assess(c: TransactionCandidate, ctx: QuestionContext, tinyFloors: Readonly<Record<string, number>>): Assessment {
  const description = describeCandidate(c, ctx.locale);
  const split = typeSplit(c);
  const credit = c.direction === "credit";
  const typeOpen = !split.settledByUser;

  // Category and essentiality only matter for money that is (probably) spending.
  const categoryRelevant = !credit && split.pRelevant >= SPENDING_RELEVANCE_FLOOR;
  const categoryOpen = categoryRelevant && !c.category.userSet;
  const categoryU = categoryOpen ? 1 - c.category.confidence : 0;
  const essentialityU = categoryRelevant && !c.attributes.essentiality.userSet ? essentialityUncertainty(c, ctx) : 0;
  // A user who labeled the candidate has already said it happened: never ask "was this a transaction?".
  const userLabeled = c.category.userSet || c.transactionType.userSet;
  const existenceDoubt = !userLabeled && (c.confidence < EXISTENCE_DOUBT || description.tier === "low");
  const existenceU = existenceDoubt ? 2 * Math.min(c.confidence, 1 - c.confidence) : 0;
  const duplicate = strongestDuplicate(c);
  const duplicateU = duplicate ? Math.max(0.2, 2 * Math.min(duplicate.probability, 1 - duplicate.probability)) : 0;
  const typeU = typeOpen ? split.ambiguity : 0;

  // One question per item: the single most useful one (docs/research/09 §4.3).
  let kind: QuestionKind | null = null;
  if (duplicate) kind = "same_event";
  else if (existenceDoubt) kind = "is_this_a_transaction";
  else if (atLeast(typeU, TYPE_QUESTION_AMBIGUITY) || (atLeast(typeU, TYPE_SETTLED_AMBIGUITY) && typeU >= categoryU)) kind = "transaction_type";
  else if (categoryOpen && (categoryU > 0 || essentialityU > 0)) kind = "category";

  const predictable =
    (kind === "category" || kind === null) &&
    (!categoryOpen || c.category.confidence >= PREDICTABLE_CATEGORY) &&
    !atLeast(typeU, TYPE_SETTLED_AMBIGUITY);

  const { impact, material, tiny } = impactOf(c, ctx, tinyFloors);
  const key = learningKey(c);
  const labelCount = key ? ctx.userModel.labelCount(key) : null;
  const learning = learningValue(labelCount);

  const typical = c.amount && sameCurrency(ctx.merchantTypicalAmount, c.amount.value.currency) ? ctx.merchantTypicalAmount : null;
  const unusual = !!(c.amount && typical && c.amount.value.minor > UNUSUAL_MULTIPLE * typical.minor);
  const possibleNonSpending = typeOpen && (credit ? atLeast(split.ambiguity, 0.3) : atLeast(1 - split.pRelevant, 0.15));

  // Bonuses matter more on bigger amounts: a possible ₹30 duplicate is not worth an interruption.
  const bonusScale = 0.5 + 0.5 * impact;
  const bonus = bonusScale * ((duplicate ? 0.3 : 0) + (unusual ? 0.15 : 0) + (possibleNonSpending ? 0.15 : 0));
  const uncertainty = Math.max(categoryU, typeU, 0.75 * essentialityU, existenceU, duplicateU);
  const value = uncertainty * impact * learning + bonus;

  const applied = new Set<AskReason>();
  if ((categoryOpen && c.category.confidence < 0.6) || c.confidence < EXISTENCE_DOUBT) applied.add("low_confidence");
  if (material) applied.add("material_budget_impact");
  if (categoryRelevant && essentialityU >= 0.5) applied.add("essentiality_uncertain");
  if (categoryOpen && (c.merchant.normalized === null || c.merchant.confidence < 0.6 || multiCategory(c.category))) {
    applied.add("ambiguous_merchant");
  }
  if (unusual) applied.add("unusual");
  if (labelCount === 0 && split.pRelevant >= 0.5 && categoryRelevant && (kind === "category" || kind === "transaction_type")) {
    applied.add("improves_interventions");
  }
  if (possibleNonSpending) applied.add("possible_transfer_or_refund");
  if (duplicate) applied.add("possible_duplicate");

  return {
    kind,
    description,
    split,
    predictable,
    value,
    tiny,
    reasons: REASON_ORDER.filter((r) => applied.has(r)),
    duplicate,
  };
}

/* ------------------------------------------------------------------ */
/* Question construction                                               */
/* ------------------------------------------------------------------ */

type Scored = { option: LabelOption; score: number };

function addScore(into: Map<string, Scored>, option: LabelOption | undefined, score: number): void {
  if (!option || score <= 0) return;
  const prev = into.get(option.id);
  into.set(option.id, { option, score: (prev?.score ?? 0) + score });
}

/** Highest score first; insertion order breaks ties (stable sort), so output is deterministic. */
function ranked(scores: Map<string, Scored>): LabelOption[] {
  return [...scores.values()].sort((a, b) => b.score - a.score).map((s) => s.option);
}

function slotsFor(ctx: QuestionContext): number {
  return Math.min(Math.floor(ctx.surface.maxQuickActions), MAX_OPTIONS) - 1;
}

/** Predicted top categories plus "Other…": the brief's "[Shopping] [Household] [Work] […]". */
function categoryOptions(c: TransactionCandidate, ctx: QuestionContext): LabelOption[] {
  const slots = slotsFor(ctx);
  const scores = new Map<string, Scored>();
  const addCategory = (id: string, p: number) => {
    const option = optionForCategory(id);
    // "Other" is what the overflow button is for.
    if (option && option.id !== "other") addScore(scores, option, p);
  };
  addCategory(c.category.value, c.category.confidence);
  for (const alt of c.category.alternatives) addCategory(alt.value, alt.probability);

  // Ownership answers the brief lists among quick actions ("Work", "Reimbursable") —
  // unless the user already said whose money it was.
  const own = c.attributes.ownership;
  for (const [value, id] of own.userSet ? [] : ([["business", "work"], ["reimbursable", "reimbursable"]] as const)) {
    const p = (own.value === value ? own.confidence : 0) + (own.alternatives.find((a) => a.value === value)?.probability ?? 0);
    if (p >= 0.2) addScore(scores, labelOption(id), p);
  }

  const picked = ranked(scores).slice(0, slots);
  const fill = (option: LabelOption | undefined) => {
    if (option && option.id !== "other" && picked.length < slots && !picked.some((o) => o.id === option.id)) picked.push(option);
  };
  // Thin predictions: what this user said about the merchant (or payee) before, then common choices.
  const key = learningKey(c);
  const learned = key ? ctx.userModel.categoryFor(key) : null;
  for (const e of [...(learned?.entries ?? [])].sort((a, b) => b.probability - a.probability)) fill(optionForCategory(e.value));
  for (const id of FALLBACK_CATEGORY_OPTION_IDS) fill(labelOption(id));
  return [...picked, MORE_OPTION];
}

function transferKindGuess(c: TransactionCandidate, ctx: QuestionContext): TransferKind | null {
  if (c.transferKind && c.transferKind !== "unknown") return c.transferKind;
  const key = counterpartyKey(c.counterparty);
  const learned = key ? ctx.userModel.transferKindFor(key) : null;
  const top = learned?.entries.reduce<{ value: TransferKind; probability: number } | null>(
    (best, e) => (!best || e.probability > best.probability ? e : best),
    null,
  );
  return top && top.value !== "unknown" && top.probability >= 0.6 ? top.value : null;
}

/** One-tap options a type (with its probability) contributes to a type question. */
function optionsForType(type: TransactionType, c: TransactionCandidate, ctx: QuestionContext): Array<[LabelOption | undefined, number]> {
  const credit = c.direction === "credit";
  switch (type) {
    case "purchase": {
      // Prefer the purchase's likely category ("Rent" for a ₹50,000 debit to a landlord).
      const cat = c.category;
      const catOption = cat.value !== UNCATEGORIZED && cat.confidence >= 0.5 ? optionForCategory(cat.value) : undefined;
      return [[catOption && catOption.id !== "other" ? catOption : PURCHASE_OPTION, 1]];
    }
    case "subscription":
      return [[labelOption("subscription"), 1]];
    case "shared_expense":
      return [[labelOption("shared"), 1]];
    case "business_expense":
      return [[labelOption("work"), 1]];
    case "fee":
      return [[FEE_OPTION, 1]];
    case "tax":
      return [[TAX_OPTION, 1]];
    case "transfer": {
      const kind = transferKindGuess(c, ctx);
      if (kind === "own_account" || kind === "wallet_load") return [[labelOption("own_transfer"), 1]];
      if (kind === "family") return [[labelOption("family_transfer"), 1]];
      if (kind === "p2p_other") return [[labelOption("transfer"), 1]];
      // Unknown kind: the generic answer first, then the kinds budgets treat differently.
      return [
        [labelOption("transfer"), 1],
        [labelOption("own_transfer"), 0.6],
        [labelOption("family_transfer"), 0.5],
      ];
    }
    case "credit_card_payment":
      return [[labelOption("card_bill"), 1]];
    case "loan_payment":
      return [[labelOption("loan"), 1]];
    case "investment":
      return [[labelOption("investment"), 1]];
    case "cash_withdrawal":
      return [[CASH_OPTION, 1]];
    case "refund":
      return [[labelOption("refund"), 1]];
    case "reimbursement":
      return [[credit ? PAID_BACK_OPTION : labelOption("reimbursable"), 1]];
    case "income":
      return credit ? [[INCOME_OPTION, 1]] : [];
    case "unknown":
      return [];
  }
}

/**
 * Options for "purchase or transfer?": ranked by the type distribution, and
 * always showing both sides of the split when there is room — if a transfer
 * is plausible, "not spending" must be one tap away (docs/research/09 §4.3).
 */
function typeOptions(c: TransactionCandidate, split: TypeSplit, ctx: QuestionContext): LabelOption[] {
  const slots = slotsFor(ctx);
  const relevant = c.direction === "credit" ? OFFSETTING_TYPES : SPENDING_TYPES;
  const scores = new Map<string, Scored>();
  const side = new Map<string, boolean>();
  for (const { value, probability } of split.distribution) {
    for (const [option, weight] of optionsForType(value, c, ctx)) {
      addScore(scores, option, probability * weight);
      if (option && !side.has(option.id)) side.set(option.id, relevant.has(value));
    }
  }
  const all = ranked(scores);
  const picked = all.slice(0, slots);
  for (const wanted of [true, false]) {
    if (picked.length < 2 || picked.some((o) => side.get(o.id) === wanted)) continue;
    const best = all.find((o) => side.get(o.id) === wanted);
    if (best) picked[picked.length - 1] = best;
  }
  return [...picked, MORE_OPTION];
}

function existenceOptions(c: TransactionCandidate, ctx: QuestionContext): LabelOption[] {
  const all = c.direction === "credit" ? CREDIT_EXISTENCE_OPTIONS : EXISTENCE_OPTIONS;
  return all.slice(0, Math.min(Math.floor(ctx.surface.maxQuickActions), all.length));
}

/** True when the money probably is a purchase, so "purchase" wording is not a guess presented as fact. */
function purchaseLike(c: TransactionCandidate, split: TypeSplit): boolean {
  return c.direction !== "credit" && split.pRelevant >= 0.5;
}

/**
 * The candidate described without presuming it was spending. The medium tier
 * of `describeCandidate` says "Looks like you spent about…", which is the
 * very claim a "purchase or transfer?" question is unsure of.
 */
function neutralText(c: TransactionCandidate, d: CandidateDescription, locale: string): string {
  if (d.tier !== "medium" || c.direction === "credit") return d.text;
  const amount = candidateAmountText(c, locale);
  if (!amount) return d.text;
  const who = c.merchant.displayName ?? c.counterparty?.name ?? null;
  return who ? `Looks like about ${amount} went to ${who}.` : `Looks like about ${amount} went out.`;
}

/** Confidence-aware wording: the hedge lives in the sentence, never sounds surer than BRAKE is. */
function promptFor(kind: QuestionKind, a: Assessment, c: TransactionCandidate, options: readonly LabelOption[], locale: string): string {
  const d = a.description;
  const credit = c.direction === "credit";
  switch (kind) {
    case "same_event": {
      const isPurchase = purchaseLike(c, a.split);
      const noun = isPurchase ? "purchase" : "payment";
      const text = isPurchase ? d.text : neutralText(c, d, locale);
      if (d.tier === "high") return `${text} — same ${noun} as one already listed?`;
      if (d.tier === "medium") return `${text} Is it the same as one already listed?`;
      return `${text} It may match one already listed — same ${noun}?`;
    }
    case "is_this_a_transaction":
      return d.text;
    case "transaction_type": {
      const offersTransfer = options.some((o) => o.effect.field === "transaction_type" && o.effect.value === "transfer");
      if (credit) return d.tier === "high" ? `${d.text} — what was this?` : `${d.text} What was it?`;
      const ask = offersTransfer ? "was this a purchase or a transfer?" : "what kind of payment was this?";
      const text = neutralText(c, d, locale);
      return d.tier === "high" ? `${text} — ${ask}` : `${text} ${ask.charAt(0).toUpperCase()}${ask.slice(1)}`;
    }
    case "category":
    case "satisfaction":
      return d.tier === "high" ? `${d.text} — what was this?` : `${d.text} What was it for?`;
  }
}

function buildQuestion(c: TransactionCandidate, ctx: QuestionContext, a: Assessment, kind: QuestionKind): Question {
  let options: LabelOption[];
  switch (kind) {
    case "same_event":
      options = [...(purchaseLike(c, a.split) ? SAME_EVENT_OPTIONS : SAME_EVENT_PAYMENT_OPTIONS)];
      break;
    case "is_this_a_transaction":
      options = existenceOptions(c, ctx);
      break;
    case "transaction_type":
      options = typeOptions(c, a.split, ctx);
      break;
    default:
      options = categoryOptions(c, ctx);
  }
  return {
    // Deterministic: the same question about the same candidate always has the same id (no double-asking).
    id: stableId("q", c.id, kind, kind === "same_event" ? a.duplicate?.target : undefined),
    candidateId: c.id,
    kind,
    prompt: promptFor(kind, a, c, options, ctx.locale),
    options,
    reasons: a.reasons,
    createdAt: ctx.now,
    expiresAt: ctx.now + QUESTION_TTL_MS,
  };
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

function isSensitive(c: TransactionCandidate): boolean {
  return SENSITIVE_CATEGORIES.has(topLevelCategory(c.category.value)) && c.category.confidence >= 0.6;
}

/**
 * Create the question policy. Defaults follow the learning-loop spec and
 * docs/research/09 §4.3: a weekly budget of 5, quiet hours 22:00–08:00, and a
 * hard back-off after 3 unanswered questions in a row.
 */
export function createQuestionPolicy(opts: QuestionPolicyOptions = {}): QuestionPolicy {
  const weeklyBudget = Math.max(0, opts.weeklyBudget ?? DEFAULT_WEEKLY_QUESTION_BUDGET);
  const quietHours = opts.quietHours === undefined ? DEFAULT_QUIET_HOURS : opts.quietHours;
  const tinyFloors: Readonly<Record<string, number>> = { ...DEFAULT_TINY_AMOUNT_MINOR, ...(opts.minAmountMinorByCurrency ?? {}) };
  const baseCost = opts.baseCost ?? 0.1;

  function cost(ctx: QuestionContext): number {
    const { askedLast7Days, unansweredStreak, lastAskedAt } = ctx.budget;
    const fatigue = weeklyBudget > 0 ? (askedLast7Days / weeklyBudget) ** 2 : 1;
    const sinceLast = lastAskedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, ctx.now - lastAskedAt);
    const spacing = SPACING_COST * Math.max(0, 1 - sinceLast / SPACING_WINDOW_MS);
    return baseCost + fatigue + UNANSWERED_PENALTY * unansweredStreak + spacing;
  }

  return {
    decide(c: TransactionCandidate, ctx: QuestionContext): AskDecision {
      const nothingToAsk = (suppressedBy: QuestionSuppression): AskDecision => ({ ask: false, score: 0, reasons: [], suppressedBy });

      if (c.userVerified) return nothingToAsk("user_verified");
      if (c.status === "intent" || c.status === "cancelled" || c.status === "refunded") return nothingToAsk(c.status);
      // `!(x >= 2)` also rejects NaN, which would otherwise yield a question with no answers but "Other…".
      if (!(Math.floor(ctx.surface.maxQuickActions) >= 2)) return nothingToAsk("surface_unsupported");

      const a = assess(c, ctx, tinyFloors);
      if (a.kind === null || a.predictable) {
        const labeled = c.category.userSet || c.transactionType.userSet;
        return nothingToAsk(labeled ? "already_labeled" : "predictable");
      }
      if (a.kind === "category" && isSensitive(c)) return nothingToAsk("sensitive_category");

      const score = a.value - cost(ctx);
      const decline = (suppressedBy: QuestionSuppression, question?: Question): AskDecision => ({
        ask: false,
        score,
        reasons: a.reasons,
        suppressedBy,
        ...(question ? { question } : {}),
      });

      // The tiny-amount exemption needs evidence that the money may not be spending; the
      // uninformed prior alone (any debit might be a transfer) would exempt every ₹40 tea.
      const evidencedTypeAmbiguity = a.split.informed && !a.split.settledByUser ? a.split.ambiguity : 0;
      if (a.tiny && !atLeast(evidencedTypeAmbiguity, TYPE_QUESTION_AMBIGUITY)) return decline("tiny_amount");
      if (ctx.budget.unansweredStreak >= BACK_OFF_STREAK) return decline("backing_off");
      if (ctx.budget.askedLast7Days >= weeklyBudget) return decline("budget_exhausted");
      if (score <= 0) return decline("low_value");

      const question = buildQuestion(c, ctx, a, a.kind);
      // Worth asking, just not now: the question is attached so the orchestrator can defer it.
      if (isQuietHour(ctx.localHour, quietHours)) return decline("quiet_hours", question);
      return { ask: true, score, reasons: a.reasons, question };
    },
  };
}
