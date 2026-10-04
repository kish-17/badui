import type { Observation } from "../model/observation";
import { DAY } from "../model/primitives";
import type { ConnectionId, EpochMillis, ObservationId } from "../model/primitives";
import type { SignalSourceKind } from "../model/source";
import type { RetentionPolicy } from "./types";

/**
 * Retention: "Collect the minimum. Store the minimum. Retain the minimum.
 * Transmit the minimum." Raw payloads are never stored at all (adapters parse
 * and discard them); what remains is (a) extracted, structured observations
 * and (b) an optional redacted excerpt that exists only so the user can check
 * "How did BRAKE know this?" while a detection is fresh.
 *
 * Two clocks, deliberately different:
 *  - Excerpt expiry runs from `receivedAt`: an excerpt's only purpose is to let
 *    the user verify a *new* detection, so its life starts when BRAKE saw it.
 *  - Observation expiry runs from the event itself (see `retentionAnchor`): the
 *    purpose of a fact is tied to when the event happened, so a two-year-old
 *    email fetched during a backfill does not get a fresh lease on life.
 */

/** Long enough to answer "How did BRAKE know this?" about this week's detections; short enough that text does not pile up. */
const EXCERPT_WEEK = 7 * DAY;

/** No excerpt is kept: the structured fields already are the evidence, or the text would be someone else's content. */
const NO_EXCERPT = 0;

/**
 * Keep extracted facts until the user deletes them or disconnects the source.
 * Used only where the observation *is* the user's spending history: dropping
 * it would silently rewrite budgets, baselines and recurring detection.
 */
const UNTIL_DISCONNECTED = null;

/**
 * About 13 months: covers an annual renewal cycle plus slack (two charges of
 * an annual subscription are needed to see it), and every refund window.
 * After that the money movement and the user's own labels carry the history.
 */
const ENRICHMENT_HORIZON = 400 * DAY;

/**
 * A quarter: pre- and in-spend signals matter at the decision moment and for
 * near-term learning ("BRAKE helped you skip ₹X this quarter"). The learned
 * models keep aggregates, so the raw moments need not outlive that.
 */
const DECISION_MOMENT_HORIZON = 90 * DAY;

/** A month: app-launch context only informs near-term interventions. */
const CONTEXT_HORIZON = 30 * DAY;

/**
 * Minimal-by-default retention per source family. Users may shorten (or,
 * with consent, lengthen) a connection's policy via the consent registry.
 */
export const DEFAULT_RETENTION: Readonly<Record<SignalSourceKind, RetentionPolicy>> = Object.freeze({
  // ---- Ledger and payment-record feeds: the facts are the user's transaction
  // history. Records arrive structured, so an excerpt would add nothing (and
  // P2P memo fields are written by other people).
  open_banking: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  account_aggregator: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  card_feed: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  issuer_webhook: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  neobank_api: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  wallet_history: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  os_wallet: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  payment_partner: policy(NO_EXCERPT, UNTIL_DISCONNECTED),

  // ---- Real-time alerts. For many users (no aggregator, cash-heavy, prepaid)
  // these alerts are the *only* record of a payment, so the extracted facts are
  // history. The alert text itself expires after a week: long enough to check a
  // fresh detection, then the structured summary suffices.
  notification: policy(EXCERPT_WEEK, UNTIL_DISCONNECTED),
  sms: policy(EXCERPT_WEEK, UNTIL_DISCONNECTED),
  // Messaging threads (RCS, chat-app business threads) can interleave messages
  // written by other people: no excerpt, ever.
  messaging: policy(NO_EXCERPT, UNTIL_DISCONNECTED),

  // ---- Passive enrichment. Email is collected in bulk from a private
  // channel, so it gets the shortest excerpt life and a bounded fact life.
  email: policy(EXCERPT_WEEK, ENRICHMENT_HORIZON),
  merchant_partner: policy(NO_EXCERPT, ENRICHMENT_HORIZON),

  // ---- Pre-/in-spend decision moments. Page content, shared screenshots and
  // voice transcripts are third-party content (other shoppers' reviews, chat
  // screenshots, bystanders' speech): no excerpt.
  payment_intent: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),
  qr_scan: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),
  checkout: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),
  share: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),
  voice: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),
  barcode: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),
  browser_extension: policy(NO_EXCERPT, DECISION_MOMENT_HORIZON),

  // ---- User-authored records. The user deliberately created them (a cash
  // purchase typed in, a receipt photographed) and they may be the only record
  // of that spending, so they stay until the user deletes them. A receipt's OCR
  // text is kept a week because OCR is the most error-prone extraction and the
  // user may want to compare what was read against what was printed.
  manual: policy(NO_EXCERPT, UNTIL_DISCONNECTED),
  receipt: policy(EXCERPT_WEEK, UNTIL_DISCONNECTED),
  user_rule: policy(NO_EXCERPT, UNTIL_DISCONNECTED),

  // ---- Pure context: no text at all, short life.
  app_activity: policy(NO_EXCERPT, CONTEXT_HORIZON),
});

function policy(excerptTtlMs: number, observationTtlMs: number | null): RetentionPolicy {
  return Object.freeze({ excerptTtlMs, observationTtlMs });
}

/**
 * Validate a retention policy. TTLs are non-negative finite millisecond
 * counts; "keep" is spelled `null`, never `Infinity`, so a policy stays JSON-safe.
 */
export function validateRetentionPolicy(p: RetentionPolicy): RetentionPolicy {
  if (!isTtl(p.excerptTtlMs)) {
    throw new RangeError(`excerptTtlMs must be a non-negative finite number, got ${String(p.excerptTtlMs)}`);
  }
  if (p.observationTtlMs !== null && !isTtl(p.observationTtlMs)) {
    throw new RangeError(`observationTtlMs must be null or a non-negative finite number, got ${String(p.observationTtlMs)}`);
  }
  return Object.freeze({ excerptTtlMs: p.excerptTtlMs, observationTtlMs: p.observationTtlMs });
}

function isTtl(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/**
 * The instant an observation's retention clock starts: when the event
 * happened, but never later than when BRAKE received it — a wrongly
 * future-dated `occurredAt` must not extend how long BRAKE keeps the fact.
 */
export function retentionAnchor(o: Observation): EpochMillis {
  const occurred = o.occurredAt?.value;
  return occurred === undefined || !Number.isFinite(occurred) ? o.receivedAt : Math.min(occurred, o.receivedAt);
}

/**
 * True when the observation's excerpt must go: either the adapter's own
 * expiry passed or the connection's (possibly user-shortened) policy did.
 * The stricter of the two always wins.
 */
export function isExcerptExpired(o: Observation, p: RetentionPolicy, now: EpochMillis): boolean {
  if (o.evidence.excerpt === undefined) return false;
  const byPolicy = o.receivedAt + Math.max(0, p.excerptTtlMs);
  const byAdapter = o.evidence.excerptExpiresAt ?? Number.POSITIVE_INFINITY;
  return Math.min(byPolicy, byAdapter) <= now;
}

/** True when the observation is past its connection's fact TTL (anchoring by user assertions is checked separately). */
export function isPastRetention(o: Observation, p: RetentionPolicy, now: EpochMillis): boolean {
  if (p.observationTtlMs === null) return false;
  return retentionAnchor(o) + Math.max(0, p.observationTtlMs) <= now;
}

/** The observation without its excerpt (and the excerpt's expiry, which no longer means anything). */
export function stripExcerpt(o: Observation): Observation {
  const { excerpt: _excerpt, excerptExpiresAt: _expires, ...evidence } = o.evidence;
  return { ...o, evidence };
}

/**
 * Used when no policy is known for a connection (e.g. the registry has not
 * loaded it): text is never kept without a policy, but facts are never
 * deleted because of a missing lookup either.
 */
const UNKNOWN_CONNECTION_POLICY: RetentionPolicy = Object.freeze({ excerptTtlMs: 0, observationTtlMs: null });

export interface RetentionResult {
  /** Observations to keep, in input order; expired excerpts removed. Unchanged observations are the same objects. */
  readonly keep: Observation[];
  /** Observations past their TTL and not anchored by a user assertion: delete them (FusionEngine.removeObservations). */
  readonly dropIds: ObservationId[];
  /** Kept observations whose excerpt was stripped in this pass: persist these back. */
  readonly strippedIds: ObservationId[];
}

/**
 * One retention pass. Pure: callers persist `keep`, delete `dropIds` and
 * re-run fusion removal for them.
 *
 * `policyFor` may return undefined for a connection it does not know; such
 * observations lose their excerpt but keep their facts.
 *
 * Observations anchored by a user assertion (a label, a "same event", a
 * confirmation) are never dropped: the user's answer is about that fact, and
 * deleting it would make the label silently disappear. Their excerpts still
 * expire — the assertion needs the fact, not the text.
 */
export function applyRetention(
  observations: readonly Observation[],
  policyFor: (connectionId: ConnectionId) => RetentionPolicy | undefined,
  now: EpochMillis,
  anchored: ReadonlySet<ObservationId> = new Set(),
): RetentionResult {
  const policies = new Map<ConnectionId, RetentionPolicy>();
  const resolve = (id: ConnectionId): RetentionPolicy => {
    let p = policies.get(id);
    if (!p) {
      p = policyFor(id) ?? UNKNOWN_CONNECTION_POLICY;
      policies.set(id, p);
    }
    return p;
  };

  const keep: Observation[] = [];
  const dropIds: ObservationId[] = [];
  const strippedIds: ObservationId[] = [];

  for (const o of observations) {
    const p = resolve(o.source.connectionId);
    if (isPastRetention(o, p, now) && !anchored.has(o.id)) {
      dropIds.push(o.id);
      continue;
    }
    if (isExcerptExpired(o, p, now)) {
      keep.push(stripExcerpt(o));
      strippedIds.push(o.id);
    } else {
      keep.push(o);
    }
  }
  return { keep, dropIds, strippedIds };
}
