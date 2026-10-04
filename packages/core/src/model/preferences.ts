import type { CategoryId } from "./candidate";
import type { Money } from "./money";
import type { EpochMillis } from "./primitives";

/**
 * User-owned preferences and facts that BRAKE persists alongside
 * observations. They live in core because stores persist them; the
 * intelligence layer consumes them.
 */

/** An account/instrument the user owns, learned from connections or confirmed by the user. */
export interface OwnedInstrument {
  readonly type: "bank_account" | "card" | "wallet" | "upi_handle" | "brokerage" | "loan";
  readonly issuer?: string;
  readonly last4?: string;
  readonly accountRef?: string;
  readonly handle?: string;
  readonly cardKind?: "credit" | "debit" | "prepaid";
}

export interface Budget {
  /** Stable id for persistence; stores derive one from category + period when absent. */
  readonly id?: string;
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
