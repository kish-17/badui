import type { Essentiality, Ownership, PurchaseContext, PurchaseIntent, Satisfaction, TemporalType } from "./candidate";
import type { TransactionType, TransferKind } from "./observation";
import type { EpochMillis, ObservationId } from "./primitives";

/**
 * Something the user told BRAKE. Assertions are stored separately from
 * candidates and anchored to observation ids, so they survive re-fusion
 * (e.g. after a source is disconnected and candidates are rebuilt).
 * An assertion applies to whichever candidate contains any of its anchors.
 */
export type UserAssertion =
  | LabelAssertion
  | SatisfactionAssertion
  | SameEventAssertion
  | DifferentEventsAssertion
  | DismissAssertion
  | ConfirmAssertion;

interface AssertionBase {
  readonly id: string;
  readonly at: EpochMillis;
  /** Observations identifying the candidate this assertion is about. */
  readonly anchors: readonly ObservationId[];
}

export type LabelField =
  | { readonly field: "category"; readonly value: string }
  | { readonly field: "transaction_type"; readonly value: TransactionType; readonly transferKind?: TransferKind }
  | { readonly field: "essentiality"; readonly value: Essentiality }
  | { readonly field: "ownership"; readonly value: Ownership }
  | { readonly field: "intent"; readonly value: PurchaseIntent }
  | { readonly field: "temporal_type"; readonly value: TemporalType }
  | { readonly field: "purchase_context"; readonly value: PurchaseContext };

export type LabelAssertion = AssertionBase & { readonly kind: "label" } & LabelField;

export interface SatisfactionAssertion extends AssertionBase {
  readonly kind: "satisfaction";
  readonly value: Satisfaction;
  readonly askedAt: EpochMillis;
}

/** The user says these observations are one event (hard must-link for fusion). */
export interface SameEventAssertion extends AssertionBase {
  readonly kind: "same_event";
}

/** The user says these observations are separate events (hard cannot-link for fusion). */
export interface DifferentEventsAssertion extends AssertionBase {
  readonly kind: "different_events";
}

/** "Not a transaction" / "not mine": hide the candidate and learn from it. */
export interface DismissAssertion extends AssertionBase {
  readonly kind: "dismiss";
  readonly reason: "not_a_transaction" | "not_mine" | "duplicate";
}

/** The user confirmed the candidate as shown is correct. */
export interface ConfirmAssertion extends AssertionBase {
  readonly kind: "confirm";
}
