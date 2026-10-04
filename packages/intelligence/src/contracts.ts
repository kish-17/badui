/**
 * Contracts between the intelligence modules. Every module in this package
 * consumes only @brake/core types: it never knows which provider, adapter,
 * country-specific API or OS produced an observation.
 */
import type {
  CandidateId,
  CandidateLink,
  CandidatePatch,
  CategoryHint,
  CategoryId,
  Clock,
  CountryCode,
  CurrencyCode,
  EpochMillis,
  Essentiality,
  LabelField,
  LocaleTag,
  Money,
  Observation,
  Probability,
  Satisfaction,
  TransactionCandidate,
  TransactionType,
  TransferKind,
  UserAssertion,
} from "@brake/core";

/* ------------------------------------------------------------------ */
/* Taxonomy & one-tap labels                                           */
/* ------------------------------------------------------------------ */

export interface CategoryDefinition {
  readonly id: CategoryId;
  readonly label: string;
  readonly parent?: CategoryId;
  /** Default essentiality distribution for the category, before personal learning. */
  readonly essentiality: Readonly<Partial<Record<Exclude<Essentiality, "unknown">, Probability>>>;
}

/**
 * A one-tap answer. Some brief "categories" are really types or ownership
 * (Transfer, Refund, Reimbursable, Shared expense, Subscription, Work), so each
 * option carries the precise effect it has on the candidate.
 */
export interface LabelOption {
  readonly id: string;
  /** Short button text, max ~14 characters ("Eating out"). */
  readonly label: string;
  /** What answering with this option asserts about the candidate. */
  readonly effect: LabelField | { readonly field: "satisfaction"; readonly value: Satisfaction };
  /** Overflow option: opens the full picker instead of asserting `effect`. */
  readonly opensPicker?: boolean;
}

export interface Distribution<T extends string> {
  readonly entries: ReadonlyArray<{ readonly value: T; readonly probability: Probability }>;
  /** Effective number of observations behind the distribution (0 = pure prior). */
  readonly evidence: number;
}

/* ------------------------------------------------------------------ */
/* Personal learning                                                   */
/* ------------------------------------------------------------------ */

/**
 * What BRAKE has learned from this user's own answers. Lives on-device.
 * Keys are merchant keys (e.g. "amazon") or counterparty keys (hashed handles).
 */
export interface UserModel {
  /** Learn from a user assertion about a candidate (labels, dismissals, confirmations). */
  observe(assertion: UserAssertion, candidate: TransactionCandidate): void;
  categoryFor(merchantKey: string): Distribution<CategoryId> | null;
  typeFor(counterpartyOrMerchantKey: string): Distribution<TransactionType> | null;
  transferKindFor(counterpartyKey: string): Distribution<TransferKind> | null;
  essentialityFor(category: CategoryId): Distribution<Exclude<Essentiality, "unknown">> | null;
  /** Number of labels the user has given for a merchant (drives "do not ask when predictable"). */
  labelCount(merchantKey: string): number;
  toJSON(): unknown;
}

/* ------------------------------------------------------------------ */
/* Enrichment: merchant normalization & classification                  */
/* ------------------------------------------------------------------ */

export interface NormalizedMerchant {
  readonly key: string;
  readonly displayName: string;
  readonly confidence: Probability;
}

export interface ClassificationContext {
  readonly userModel: UserModel;
  readonly now: EpochMillis;
}

/** Produces category, essentiality, initial transaction type and attributes for one candidate. */
export interface Classifier {
  classify(candidate: TransactionCandidate, observations: readonly Observation[], ctx: ClassificationContext): CandidatePatch;
}

/* ------------------------------------------------------------------ */
/* Reconciliation: transfer vs spending                                 */
/* ------------------------------------------------------------------ */

/** An account/instrument the user owns, learned from connections or confirmed by the user. */
export interface OwnedInstrument {
  readonly type: "bank_account" | "card" | "wallet" | "upi_handle" | "brokerage" | "loan";
  readonly issuer?: string;
  readonly last4?: string;
  readonly accountRef?: string;
  readonly handle?: string;
  readonly cardKind?: "credit" | "debit" | "prepaid";
}

export interface ReconciliationContext {
  readonly ownedInstruments: readonly OwnedInstrument[];
  /** Name variants of the user, for detecting self-transfers in narrations. */
  readonly selfNames: readonly string[];
  readonly userModel: UserModel;
  readonly now: EpochMillis;
}

export interface ReconciliationResult {
  /** Type/transfer-kind inferences and links to apply, keyed by candidate. */
  readonly patches: ReadonlyMap<CandidateId, CandidatePatch>;
}

export interface Reconciler {
  reconcile(candidates: readonly TransactionCandidate[], ctx: ReconciliationContext): ReconciliationResult;
}

/** How a candidate affects the user's spending picture. */
export type SpendingBucket =
  | "spending" // purchases, subscriptions, fees, rent… — counts toward budgets
  | "refund" // offsets spending
  | "transfer" // own-account, wallet load — neutral
  | "outflow_other" // family/P2P transfers — shown separately, not "spending" unless labeled
  | "debt_payment" // credit-card bill, loan EMI
  | "investment"
  | "income"
  | "cash" // ATM withdrawals — tracked as cash, not as spending by category
  | "excluded"; // intents, cancelled, dismissed, likely duplicates

export interface SpendingEffect {
  readonly bucket: SpendingBucket;
  /** +1 adds to spending, -1 reduces it, 0 neutral. */
  readonly sign: 1 | -1 | 0;
  /** Probability-weighted amount in minor units that counts toward spending (0 when not spending). */
  readonly weightedMinor: number;
  readonly reason: string;
}

/* ------------------------------------------------------------------ */
/* Recurring & subscriptions                                            */
/* ------------------------------------------------------------------ */

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "annual" | "irregular";

export interface RecurringSeries {
  readonly id: string;
  readonly merchantKey: string;
  readonly displayName: string;
  readonly cadence: Cadence;
  readonly periodDays: number;
  readonly typicalAmount: Money;
  /** Coefficient of variation of member amounts. */
  readonly amountVariation: number;
  readonly memberIds: readonly CandidateId[];
  readonly firstChargeAt: EpochMillis;
  readonly lastChargeAt: EpochMillis;
  readonly nextExpectedAt: EpochMillis | null;
  readonly nextExpectedAmount: Money | null;
  /** Probability the series is a subscription (vs a habitual purchase or a bill). */
  readonly subscriptionProbability: Probability;
  readonly status: "active" | "trial" | "dormant" | "cancelled";
  readonly priceHistory: ReadonlyArray<{ readonly at: EpochMillis; readonly amount: Money }>;
  readonly confidence: Probability;
}

export type RecurringAlertKind =
  | "upcoming_renewal"
  | "price_increase"
  | "trial_conversion"
  | "duplicate_subscription"
  | "dormant_subscription"
  | "new_subscription";

export interface RecurringAlert {
  readonly kind: RecurringAlertKind;
  readonly seriesId: string;
  readonly relatedSeriesIds?: readonly string[];
  readonly at: EpochMillis;
  readonly amount?: Money;
  readonly previousAmount?: Money;
  readonly confidence: Probability;
}

export interface RecurringFindings {
  readonly series: readonly RecurringSeries[];
  readonly alerts: readonly RecurringAlert[];
  /** recurring_series links and temporalType inferences to apply. */
  readonly patches: ReadonlyMap<CandidateId, CandidatePatch>;
}

export interface RecurringDetector {
  detect(candidates: readonly TransactionCandidate[], context: readonly Observation[], now: EpochMillis): RecurringFindings;
}

/* ------------------------------------------------------------------ */
/* Learning loop: questions and regret                                  */
/* ------------------------------------------------------------------ */

export type AskReason =
  | "low_confidence"
  | "material_budget_impact"
  | "essentiality_uncertain"
  | "ambiguous_merchant"
  | "unusual"
  | "improves_interventions"
  | "possible_transfer_or_refund"
  | "possible_duplicate";

export type QuestionKind = "category" | "transaction_type" | "same_event" | "is_this_a_transaction" | "satisfaction";

export interface Question {
  readonly id: string;
  readonly candidateId: CandidateId;
  readonly kind: QuestionKind;
  /** Confidence-aware prompt text, e.g. "₹1,249 at Amazon — what was this?" */
  readonly prompt: string;
  /** Predicted top choices, at most the surface's quick-action limit, ending with an overflow option. */
  readonly options: readonly LabelOption[];
  readonly reasons: readonly AskReason[];
  readonly createdAt: EpochMillis;
  readonly expiresAt: EpochMillis;
}

/** What the presentation surface can render (notification quick actions, in-app sheet). */
export interface SurfaceCapabilities {
  /** Max buttons the surface shows at once (e.g. 3 for an Android notification). */
  readonly maxQuickActions: number;
  readonly supportsTextInput: boolean;
}

export interface QuestionBudgetState {
  readonly askedLast7Days: number;
  readonly lastAskedAt: EpochMillis | null;
  readonly unansweredStreak: number;
}

export interface QuestionContext {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  readonly userModel: UserModel;
  readonly budget: QuestionBudgetState;
  readonly surface: SurfaceCapabilities;
  /** Typical weekly discretionary spending in the candidate's currency, for "material impact". */
  readonly weeklySpendingBaseline: Money | null;
  /** Typical amount the user spends at this merchant, for "unusual". */
  readonly merchantTypicalAmount: Money | null;
  /** Local hour 0-23, for quiet hours. */
  readonly localHour: number;
}

export interface AskDecision {
  readonly ask: boolean;
  /** Expected value of asking minus its cost; ask when > 0 and budget allows. */
  readonly score: number;
  readonly reasons: readonly AskReason[];
  /** Why not asking, when ask=false ("predictable", "budget_exhausted", "quiet_hours", …). */
  readonly suppressedBy?: string;
  readonly question?: Question;
}

export interface QuestionPolicy {
  decide(candidate: TransactionCandidate, ctx: QuestionContext): AskDecision;
}

/** Features a regret model conditions on. Coarse by design (privacy + generalization). */
export interface RegretFeatures {
  readonly category: CategoryId;
  readonly channel: "online" | "in_store" | "unknown";
  /** Local time band. */
  readonly timeBand: "morning" | "afternoon" | "evening" | "late_night";
  readonly dayType: "weekday" | "weekend";
  /** Amount relative to the user's typical discretionary purchase. */
  readonly amountBand: "small" | "medium" | "large" | "very_large";
  readonly planned: "planned" | "unplanned" | "unknown";
}

export interface RegretEstimate {
  /** Posterior mean probability the user will regret a purchase like this. */
  readonly probability: Probability;
  /** Effective number of answers behind the estimate. */
  readonly evidence: number;
  /** Which feature segment the estimate came from (after hierarchical back-off). */
  readonly segment: string;
}

export interface RegretModel {
  record(features: RegretFeatures, answer: Satisfaction): void;
  estimate(features: RegretFeatures): RegretEstimate;
  toJSON(): unknown;
}

export interface RegretPromptContext {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  readonly promptsLast7Days: number;
  readonly lastPromptAt: EpochMillis | null;
  readonly model: RegretModel;
  readonly features: RegretFeatures;
  readonly userOptedOut: boolean;
}

export interface RegretPromptPlan {
  /** When to ask (24–72h after purchase, at a sensible local time). */
  readonly askAt: EpochMillis;
  readonly prompt: string;
  readonly options: readonly LabelOption[];
  /** Expected information gain that justified asking. */
  readonly value: number;
}

export interface RegretPromptPolicy {
  plan(candidate: TransactionCandidate, ctx: RegretPromptContext): RegretPromptPlan | null;
}

/* ------------------------------------------------------------------ */
/* Post-spend insights, pre/in-spend interventions, copy                */
/* ------------------------------------------------------------------ */

export type InsightKind =
  | "category_pace"
  | "budget_remaining"
  | "unusual_amount"
  | "new_subscription"
  | "price_increase"
  | "upcoming_renewal"
  | "refund_tracked"
  | "possible_duplicate_charge"
  | "goal_impact";

export interface Insight {
  readonly id: string;
  readonly kind: InsightKind;
  readonly candidateId?: CandidateId;
  /** Final user-facing sentence(s). Never scolding, never "You spent X" alone. */
  readonly text: string;
  /** 0..1 — how much this changes the user's understanding. Below the gate it is not shown. */
  readonly importance: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface Budget {
  readonly category?: CategoryId;
  readonly limit: Money;
  readonly period: "weekly" | "monthly";
}

export interface Goal {
  readonly id: string;
  readonly name: string;
  readonly target: Money;
  readonly saved: Money;
  readonly targetDate?: EpochMillis;
}

export interface InsightContext {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  readonly timeZone: string;
  /** All known candidates (history) for baselines. */
  readonly history: readonly TransactionCandidate[];
  readonly budgets: readonly Budget[];
  readonly goals: readonly Goal[];
  readonly recurring: RecurringFindings | null;
}

export interface InsightEngine {
  /** The single most valuable insight for this candidate, or null to stay silent. */
  afterSpend(candidate: TransactionCandidate, ctx: InsightContext): Insight | null;
}

/**
 * Strength of a pre/in-spend intervention:
 *   none    — stay out of the way
 *   inform  — a quiet, glanceable fact (budget left, goal impact)
 *   reflect — a gentle question ("Planned or spur of the moment?") with a one-tap continue
 *   pause   — a cooling-off suggestion the user can always skip
 * BRAKE never blocks a purchase outright.
 */
export type InterventionLevel = "none" | "inform" | "reflect" | "pause";

export interface UserRule {
  readonly id: string;
  /** e.g. "pause online shopping after 11pm", "remind me of my goal for electronics over ₹2,000". */
  readonly description: string;
  readonly category?: CategoryId;
  readonly minAmount?: Money;
  readonly localHours?: { readonly from: number; readonly to: number };
  readonly channel?: "online" | "in_store";
  readonly level: Exclude<InterventionLevel, "none">;
}

export interface InterventionContext {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  readonly localHour: number;
  readonly regret: RegretEstimate | null;
  readonly budgets: readonly Budget[];
  readonly goals: readonly Goal[];
  readonly history: readonly TransactionCandidate[];
  readonly rules: readonly UserRule[];
  /** Interventions shown in the last 24h, to avoid nagging. */
  readonly interventionsLast24h: number;
}

export interface InterventionDecision {
  readonly level: InterventionLevel;
  readonly reasons: readonly string[];
  readonly message?: string;
  /** Always includes a way to continue. */
  readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface InterventionPolicy {
  decide(candidate: TransactionCandidate, ctx: InterventionContext): InterventionDecision;
}

export type ConfidenceTier = "high" | "medium" | "low";

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type BrakeEvent =
  | { readonly type: "candidate_created"; readonly candidate: TransactionCandidate }
  | { readonly type: "candidate_updated"; readonly candidate: TransactionCandidate }
  | { readonly type: "candidate_removed"; readonly candidateId: CandidateId }
  | { readonly type: "question"; readonly question: Question }
  | { readonly type: "insight"; readonly insight: Insight }
  | { readonly type: "intervention"; readonly candidateId: CandidateId; readonly decision: InterventionDecision }
  | { readonly type: "regret_prompt_scheduled"; readonly candidateId: CandidateId; readonly plan: RegretPromptPlan }
  | { readonly type: "recurring_alert"; readonly alert: RecurringAlert };

export interface BrakeOptions {
  readonly clock: Clock;
  readonly locale: LocaleTag;
  readonly timeZone: string;
  readonly homeCountry?: CountryCode;
  readonly homeCurrency?: CurrencyCode;
  readonly surface?: SurfaceCapabilities;
  readonly ownedInstruments?: readonly OwnedInstrument[];
  readonly selfNames?: readonly string[];
  readonly budgets?: readonly Budget[];
  readonly goals?: readonly Goal[];
  readonly rules?: readonly UserRule[];
}

/** Hint type re-exported for module authors mapping provider categories. */
export type { CategoryHint, CandidateLink };
