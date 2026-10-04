import type { ConnectionId, EpochMillis } from "../model/primitives";
import type { SignalSourceKind } from "../model/source";

export type ConnectionStatus = "active" | "paused" | "revoked";

/** How long BRAKE keeps what a source gave it. Raw payloads are never kept at all. */
export interface RetentionPolicy {
  /** Redacted evidence excerpts expire after this long. */
  readonly excerptTtlMs: number;
  /**
   * Extracted observations are deleted after this long unless a user
   * assertion anchors them. `null` keeps extracted facts until the user deletes
   * them or disconnects the source.
   */
  readonly observationTtlMs: number | null;
}

/** One user-granted connection of one source (a Gmail account, a Plaid item, the notification listener). */
export interface SourceConnection {
  readonly connectionId: ConnectionId;
  readonly adapterId: string;
  readonly kind: SignalSourceKind;
  /** Shown in settings and provenance ("HDFC Bank SMS alerts", "Gmail — receipts only"). */
  readonly label: string;
  readonly provider?: string;
  readonly status: ConnectionStatus;
  /** Exact permissions/scopes granted, as shown to the user at consent time. */
  readonly scopes: readonly string[];
  /** Plain-language purposes the user agreed to ("detect purchases", "find subscriptions"). */
  readonly purposes: readonly string[];
  readonly retention: RetentionPolicy;
  readonly grantedAt: EpochMillis;
  readonly updatedAt: EpochMillis;
  readonly revokedAt?: EpochMillis;
}

/** An append-only record of a consent change — the user's consent receipt. */
export interface ConsentEvent {
  readonly connectionId: ConnectionId;
  readonly action: "granted" | "paused" | "resumed" | "revoked" | "scopes_changed" | "retention_changed";
  readonly at: EpochMillis;
  readonly scopes: readonly string[];
  readonly purposes: readonly string[];
}

export type RedactionKind = "otp" | "card_number" | "account_number" | "national_id" | "email" | "phone" | "cvv";

export interface RedactionResult {
  readonly text: string;
  readonly redactions: readonly RedactionKind[];
}

/** Answer to "How did BRAKE know this?". */
export interface Explanation {
  /** One sentence, e.g. "Matched your bank transaction with an Amazon receipt." */
  readonly headline: string;
  /** Supporting lines: each source, inference bases, user confirmations. */
  readonly details: readonly string[];
}
