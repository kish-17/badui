import type { Money } from "./money";
import type {
  CounterpartyObservation,
  Direction,
  InstrumentObservation,
  LineItem,
  MerchantChannel,
  ObservationKind,
  PaymentRail,
  Reference,
  TransactionStatus,
  TransactionType,
  TransferKind,
} from "./observation";
import type { CandidateId, CountryCode, EpochMillis, Measured, ObservationId, Probability } from "./primitives";

/** BRAKE category id, dotted hierarchy ("shopping.electronics"). Defined by the intelligence taxonomy. */
export type CategoryId = string;

export type Essentiality = "essential" | "semi_discretionary" | "discretionary" | "unknown";
export type PurchaseIntent = "planned" | "unplanned" | "impulsive" | "recurring" | "emergency" | "unknown";
export type Ownership = "personal" | "business" | "family" | "shared" | "reimbursable";
export type TemporalType = "one_off" | "recurring" | "subscription";
export type Satisfaction = "worth_it" | "neutral" | "regretted";
export type PurchaseContext =
  | "planned_in_advance"
  | "saw_and_bought"
  | "recommended"
  | "replacement"
  | "upgrade"
  | "social"
  | "convenience"
  | "unknown";

/** Why an inference holds the value it holds. Rendered in "How did BRAKE know this?". */
export type InferenceBasis =
  | "user_label" // the user said so
  | "user_history" // the user's own past labels for this merchant/pattern
  | "merchant_profile" // known merchant category/essentiality
  | "source_hint" // provider category, MCC, adapter type hint
  | "line_items" // email/receipt item details
  | "reconciliation" // matched transfer pair, refund of an original, card payment
  | "recurrence" // recurring-series detection
  | "rule" // a user-defined rule
  | "prior" // population/default prior
  | "none";

/**
 * A probability distribution over labels, never collapsed early. `value` is
 * the argmax and `confidence` its probability; `alternatives` keeps the rest
 * (sorted descending, excluding `value`).
 */
export interface Inference<T extends string> {
  readonly value: T;
  readonly confidence: Probability;
  readonly alternatives: ReadonlyArray<{ readonly value: T; readonly probability: Probability }>;
  readonly basis: readonly InferenceBasis[];
  /** True when the user set this value explicitly. User-set values are never overwritten by inference. */
  readonly userSet: boolean;
}

export interface SatisfactionRecord {
  readonly value: Satisfaction;
  readonly askedAt: EpochMillis;
  readonly answeredAt: EpochMillis;
}

/** Semantic properties beyond category. All optional to infer; none required from the user. */
export interface SemanticAttributes {
  readonly essentiality: Inference<Essentiality>;
  readonly intent: Inference<PurchaseIntent>;
  readonly ownership: Inference<Ownership>;
  readonly temporalType: Inference<TemporalType>;
  readonly purchaseContext: Inference<PurchaseContext>;
  /** Only ever comes from the user (regret/satisfaction check-in). */
  readonly satisfaction?: SatisfactionRecord;
}

/** How an observation participates in a fused candidate. */
export type SignalRole =
  | "primary" // established the event (first money movement or intent)
  | "corroborating" // independently confirms amount/time (second money-movement source)
  | "lifecycle" // advanced status (pending -> posted, refund, cancellation)
  | "enriching"; // added semantics (order items, receipt, subscription details)

export interface SourceSignal {
  readonly observationId: ObservationId;
  readonly kind: ObservationKind;
  readonly sourceLabel: string;
  readonly provider?: string;
  readonly adapterId: string;
  readonly connectionId: string;
  readonly role: SignalRole;
  /** Posterior match probability when this observation was linked (1 for the founding observation). */
  readonly matchProbability: Probability;
  readonly linkedAt: EpochMillis;
}

export type ProvenanceField =
  | "amount"
  | "merchant"
  | "timestamp"
  | "status"
  | "direction"
  | "rail"
  | "instrument"
  | "line_items"
  | "category"
  | "transaction_type"
  | "essentiality"
  | "attributes"
  | "link";

/** Field-level provenance: which observation (or inference/user action) supplied a value. */
export interface FieldProvenance {
  readonly field: ProvenanceField;
  readonly method: "direct" | "fused" | "inferred" | "user";
  readonly observationIds: readonly ObservationId[];
  /** Short machine-readable note, e.g. "posted amount supersedes pending", "mcc:5411". */
  readonly note?: string;
}

export type CandidateLinkKind =
  | "possible_duplicate" // close match not merged — uncertainty preserved, may be asked
  | "refund_of" // this credit refunds the target purchase
  | "refunded_by"
  | "transfer_counterpart" // the other leg of an own-account/card-payment transfer
  | "card_payment_for" // this bank debit pays the card account the target belongs to
  | "reimbursement_of" // incoming money reimbursing the target expense
  | "recurring_series" // member of a recurring/subscription series (target = series id)
  | "intent_outcome"; // links a pre-spend intent to the purchase it became

export interface CandidateLink {
  readonly kind: CandidateLinkKind;
  readonly target: string;
  readonly probability: Probability;
  readonly createdAt: EpochMillis;
}

export interface CandidateMerchant {
  /** Raw descriptor as reported by the most authoritative money-movement source. */
  readonly raw: string | null;
  /** Canonical merchant key ("amazon") once resolved. */
  readonly normalized: string | null;
  /** What BRAKE shows the user ("Amazon"). */
  readonly displayName: string | null;
  readonly confidence: Probability;
  readonly mcc?: string;
  readonly channel: MerchantChannel;
  readonly handle?: string;
}

/** Outcome tracking for candidates that began as a pre-spend intent. */
export type IntentOutcome = "open" | "purchased" | "abandoned";

/**
 * BRAKE's belief about one financial event, fused from one or more
 * observations. Everything uncertain is represented with its uncertainty.
 *
 * Field mapping to the founding brief's conceptual model:
 *   category_candidate / category_confidence        -> category.value / category.confidence
 *   essentiality_candidate / essentiality_confidence -> attributes.essentiality.value / .confidence
 *   transaction_type_candidate                       -> transactionType.value (+ .confidence)
 *   source_signals[]                                 -> sourceSignals
 *   deduplication_group                              -> deduplicationGroup
 */
export interface TransactionCandidate {
  readonly id: CandidateId;
  /** Stable id of the fused cluster; equals the founding observation's cluster key. */
  readonly deduplicationGroup: string;
  readonly status: TransactionStatus;
  readonly statusHistory: ReadonlyArray<{ readonly status: TransactionStatus; readonly at: EpochMillis; readonly observationId: ObservationId }>;
  readonly intentOutcome?: IntentOutcome;
  readonly direction: Direction | "unknown";
  readonly amount: Measured<Money> | null;
  /** Amount in the original currency when the charge was converted. */
  readonly originalAmount?: Money;
  readonly merchant: CandidateMerchant;
  readonly counterparty?: CounterpartyObservation;
  readonly timestampEstimated: EpochMillis;
  readonly timestampConfirmed: EpochMillis | null;
  readonly country: CountryCode | null;
  readonly paymentRail: PaymentRail;
  readonly instrument?: InstrumentObservation;
  readonly sourceSignals: readonly SourceSignal[];
  readonly references: readonly Reference[];
  readonly lineItems: readonly LineItem[];
  readonly category: Inference<CategoryId>;
  readonly transactionType: Inference<TransactionType>;
  readonly transferKind?: TransferKind;
  readonly attributes: SemanticAttributes;
  /**
   * Probability that this candidate is a real event and its core facts
   * (amount, direction, merchant) are right. Drives copy tier and whether
   * BRAKE may intervene.
   */
  readonly confidence: Probability;
  readonly provenance: readonly FieldProvenance[];
  readonly userVerified: boolean;
  readonly links: readonly CandidateLink[];
  readonly createdAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

/** A neutral, explicitly-uninformed inference. */
export function unknownInference<T extends string>(value: T): Inference<T> {
  return { value, confidence: 0, alternatives: [], basis: ["none"], userSet: false };
}

/** An inference the user asserted. */
export function userInference<T extends string>(value: T): Inference<T> {
  return { value, confidence: 1, alternatives: [], basis: ["user_label"], userSet: true };
}

export function defaultAttributes(): SemanticAttributes {
  return {
    essentiality: unknownInference<Essentiality>("unknown"),
    intent: unknownInference<PurchaseIntent>("unknown"),
    ownership: unknownInference<Ownership>("personal"),
    temporalType: unknownInference<TemporalType>("one_off"),
    purchaseContext: unknownInference<PurchaseContext>("unknown"),
  };
}
