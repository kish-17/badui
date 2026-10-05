/**
 * Contracts between the intelligence modules. Every module in this package
 * consumes only @brake/core types: it never knows which provider, adapter,
 * country-specific API or OS produced an observation.
 */
import type {
  Budget,
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
  Goal,
  InterventionLevel,
  LabelField,
  LocaleTag,
  Money,
  Observation,
  OwnedInstrument,
  Probability,
  Satisfaction,
  TransactionCandidate,
  TransactionType,
  TransferKind,
  UserAssertion,
  UserRule,
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
  /**
   * Special-category or stigmatising spending (health, gambling, religious or
   * political giving). Never named on a lock screen, in nudge copy, default
   * regret prompts, telemetry or any off-device/cross-user learning.
   */
  readonly sensitive?: boolean;
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
  readonly effect:
    | LabelField
    | { readonly field: "satisfaction"; readonly value: Satisfaction }
    /** Candidate-level answers: "Yes, mine", "Not mine", "Not a purchase", "Same payment", "Different". */
    | { readonly field: "assertion"; readonly value: "confirm" | "not_mine" | "not_a_transaction" | "same_event" | "different_events" };
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
  /** The learning key for a candidate (merchant key, or hashed counterparty key), shared by every module. */
  keyFor?(candidate: TransactionCandidate): string | null;
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

export interface ReconciliationContext {
  /** IANA zone for local calendar rules (rent "early in the month"). */
  readonly timeZone?: string;
  /** Context observations (mandates, pre-debit notices) that strengthen loan/investment/subscription readings. */
  readonly context?: readonly Observation[];
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

export type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly" // 1st & 15th style billing
  | "monthly"
  | "bimonthly"
  | "quarterly"
  | "semiannual"
  | "annual"
  | "irregular";

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
  /** Whether nextExpectedAt was stated by the merchant/bank (renewal notice, pre-debit) or predicted from cadence. */
  readonly nextExpectedSource?: "stated" | "predicted";
  readonly trialEndsAt?: EpochMillis;
  readonly category?: CategoryId;
}

export type RecurringAlertKind =
  | "upcoming_renewal"
  | "price_increase"
  | "trial_conversion"
  | "duplicate_subscription"
  | "dormant_subscription"
  | "new_subscription";

export interface RecurringAlert {
  /** Stable id (kind + series + cycle) so surfaces show at most one reminder per cycle. */
  readonly id?: string;
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
  /** Questions asked since local midnight (research: at most one per day). */
  readonly askedToday?: number;
  /** All prompts BRAKE initiated in the last 7 days (questions, regret, insights, interventions): ≤ 4/week total. */
  readonly promptsLast7Days?: number;
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
  /** Local time band; "unknown" when the timestamp is date-only (time-of-day features abstain). */
  readonly timeBand: "morning" | "afternoon" | "evening" | "late_night" | "unknown";
  readonly dayType: "weekday" | "weekend" | "unknown";
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
  /** Raw answers in that segment, for natural-frequency copy ("4 of your last 6"). */
  readonly answered?: number;
  readonly regretted?: number;
  /** The features the segment conditions on. */
  readonly conditionsOn?: ReadonlyArray<keyof RegretFeatures>;
}

export interface RegretModel {
  /** Record an answer; `weight` is the inverse-propensity weight (default 1). */
  record(features: RegretFeatures, answer: Satisfaction, weight?: number): void;
  estimate(features: RegretFeatures): RegretEstimate;
  /** Expected information gain from asking about a purchase like this (uses the model's own prior). */
  informationValue?(features: RegretFeatures): number;
  toJSON(): unknown;
}

export interface RegretPromptContext {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  readonly timeZone?: string;
  /** Anti-obsession guardrails: stop for the week after 3 "regretted" answers or 3 ignored prompts. */
  readonly regretAnswersLast7Days?: number;
  readonly unansweredRegretStreak?: number;
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
  /** Probability this purchase was selected (log it on the SatisfactionAssertion for IPW). */
  readonly propensity?: number;
  readonly selectionReason?: string;
  readonly segment?: string;
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
  | "trial_conversion"
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

export interface InterventionContext {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  readonly timeZone?: string;
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

/** User preference types live in core (they are persisted by stores); re-exported for convenience. */
export type { Budget, Goal, InterventionLevel, OwnedInstrument, UserRule };
