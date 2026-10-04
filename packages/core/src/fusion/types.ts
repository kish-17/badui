import type { UserAssertion } from "../model/assertion";
import type { CandidateLink, Inference, SemanticAttributes, TransactionCandidate, CategoryId } from "../model/candidate";
import type { MerchantObservation, Observation, TransactionStatus, TransactionType, TransferKind } from "../model/observation";
import type { CandidateId, Clock, ObservationId, Probability } from "../model/primitives";

/**
 * Pluggable merchant comparison. Core ships a conservative default; the
 * intelligence layer injects a richer normalizer (aliases, learned keys)
 * without core depending on it.
 */
export interface MerchantMatcher {
  /** Canonical key for a merchant observation, or null when unknown. */
  key(m: MerchantObservation): string | null;
  /** Similarity in [0, 1] (1 = certainly the same merchant). */
  similarity(a: MerchantObservation, b: MerchantObservation): number;
}

export interface FusionConfig {
  /** Posterior at or above which an observation is merged into a candidate. Default 0.9. */
  readonly linkThreshold: Probability;
  /** Posterior at or above which a non-merged pair is recorded as `possible_duplicate`. Default 0.5. */
  readonly possibleThreshold: Probability;
  /**
   * When the best and second-best candidates are within this posterior margin,
   * the observation is ambiguous and is not merged into either. Default 0.15.
   */
  readonly ambiguityMargin: number;
  /** Prior log-odds that two blocked observations are the same event, before evidence. Default ln(0.1/0.9). */
  readonly priorLogOdds: number;
  /** Max time between a pre-spend intent and the purchase it became. Default 24h. */
  readonly intentHorizonMs: number;
  /** Max increase of a posted amount over its pending amount (tips) when the provider/instrument agree. Default 0.3. */
  readonly pendingToPostedTolerance: number;
  /** Relative amount tolerance for approximate (intent/OCR) amounts. Default 0.15. */
  readonly approximateAmountTolerance: number;
}

export type FusionOutcome =
  /** A new candidate was created from this observation. */
  | "created"
  /** The observation was merged into an existing candidate. */
  | "linked"
  /** Several candidates matched about equally well: kept separate, `possible_duplicate` links recorded. */
  | "ambiguous"
  /** The exact observation id was already ingested (idempotent re-delivery). */
  | "duplicate_delivery"
  /** Context-only observation (balance, app launch, renewal notice, mandate): stored, not a transaction. */
  | "context";

export interface MatchFeature {
  /** e.g. "amount_exact", "time_proximity", "merchant_similarity", "reference_match". */
  readonly name: string;
  /** Log-likelihood-ratio contribution (positive = evidence for same event). */
  readonly llr: number;
  readonly detail?: string;
}

export interface MatchAssessment {
  /** Set when the pair can never be the same event (direction conflict, distinct ledger ids, user cannot-link…). */
  readonly veto?: string;
  readonly logOdds: number;
  readonly probability: Probability;
  readonly features: readonly MatchFeature[];
}

export interface FusionDecision {
  readonly observationId: ObservationId;
  readonly outcome: FusionOutcome;
  /** Candidate the observation now belongs to (absent for `context` and `duplicate_delivery` of context). */
  readonly candidateId?: CandidateId;
  readonly matchProbability?: Probability;
  readonly possibleMatches: ReadonlyArray<{ readonly candidateId: CandidateId; readonly probability: Probability }>;
  /** Feature breakdown of the winning comparison — powers debugging and "How did BRAKE know this?". */
  readonly assessment?: MatchAssessment;
}

/**
 * Inference/link fields owned by the intelligence layer. Fusion preserves
 * them across fact updates; user-set inferences are never overwritten.
 */
export interface CandidatePatch {
  readonly category?: Inference<CategoryId>;
  readonly transactionType?: Inference<TransactionType>;
  readonly transferKind?: TransferKind;
  readonly attributes?: Partial<SemanticAttributes>;
  readonly merchantNormalized?: { readonly key: string; readonly displayName: string; readonly confidence: Probability };
  /** Replaces all links of the given kinds that this patch's author owns. */
  readonly links?: readonly CandidateLink[];
  /** Reconciliation may mark an original purchase as refunded. */
  readonly status?: Extract<TransactionStatus, "refunded">;
  readonly intentOutcome?: TransactionCandidate["intentOutcome"];
}

export interface RemovalResult {
  readonly removedObservationIds: readonly ObservationId[];
  /** Candidates that disappeared because no evidence remained. */
  readonly deletedCandidateIds: readonly CandidateId[];
  /** Candidates whose facts were recomputed. */
  readonly updatedCandidateIds: readonly CandidateId[];
}

/** Serializable state for persistence (observations + assertions are the source of truth). */
export interface FusionSnapshot {
  readonly version: 1;
  readonly observations: readonly Observation[];
  readonly assertions: readonly UserAssertion[];
  readonly patches: ReadonlyArray<{ readonly anchor: ObservationId; readonly patch: CandidatePatch }>;
}

/**
 * Fuses observations into transaction candidates.
 *
 * Contract:
 *  - Deterministic: the same observations in the same order give the same candidates and ids.
 *  - Idempotent: re-ingesting an observation id is a no-op (`duplicate_delivery`).
 *  - Conservative: merges only above `linkThreshold`, never when ambiguous, never across a veto.
 *  - Provenance-preserving: every candidate lists every contributing observation and field provenance.
 *  - Reversible: removing observations (source disconnect) recomputes affected candidates.
 */
export interface FusionEngine {
  ingest(observation: Observation): FusionDecision;
  /** Apply/replace user assertions (labels, same/different-event constraints, dismissals). */
  applyAssertion(assertion: UserAssertion): readonly CandidateId[];
  /** Remove observations (e.g. every observation of a revoked connection). */
  removeObservations(predicate: (o: Observation) => boolean): RemovalResult;
  patchCandidate(id: CandidateId, patch: CandidatePatch): TransactionCandidate;
  getCandidate(id: CandidateId): TransactionCandidate | undefined;
  findCandidateByObservation(id: ObservationId): TransactionCandidate | undefined;
  /** All non-dismissed candidates, newest first by `timestampEstimated`. */
  listCandidates(): readonly TransactionCandidate[];
  /** Observations that belong to a candidate. */
  observationsOf(id: CandidateId): readonly Observation[];
  /** Context-only observations (balances, renewal notices, mandates, app launches). */
  contextObservations(): readonly Observation[];
  assertions(): readonly UserAssertion[];
  /** Explain how an observation compares to a candidate without changing state. */
  assess(observation: Observation, candidateId: CandidateId): MatchAssessment;
  snapshot(): FusionSnapshot;
}

export interface FusionEngineOptions {
  readonly clock: Clock;
  readonly config?: Partial<FusionConfig>;
  readonly merchantMatcher?: MerchantMatcher;
}
