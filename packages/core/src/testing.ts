/**
 * Builders for tests and demos. Not used by production code paths.
 * Import via "@brake/core/testing".
 */
import { defaultAttributes, unknownInference } from "./model/candidate";
import type { Inference, TransactionCandidate } from "./model/candidate";
import { money } from "./model/money";
import type { Observation } from "./model/observation";
import type { SourceRef } from "./model/source";
import { stableId } from "./util/hash";

export const T0 = Date.UTC(2026, 9, 4, 5, 11, 0); // 2026-10-04 10:41 IST

export function makeSource(p: Partial<SourceRef> = {}): SourceRef {
  return {
    adapterId: "test",
    kind: "notification",
    connectionId: "conn_test",
    label: "test source",
    ...p,
  };
}

let seq = 0;

/** A money-movement debit observation with sensible defaults; override anything. */
export function makeObservation(p: Partial<Observation> & { minor?: number; currency?: string } = {}): Observation {
  seq += 1;
  const { minor, currency, ...rest } = p;
  const source = rest.source ?? makeSource();
  return {
    id: rest.id ?? stableId("obs", source.adapterId, source.connectionId, `fixture-${seq}`),
    source,
    kind: "money_movement",
    window: "post_spend",
    stage: "confirmed",
    receivedAt: T0,
    occurredAt: { value: rest.receivedAt ?? T0, confidence: 0.95 },
    direction: "debit",
    amount: { value: money(minor ?? 124_900, currency ?? "INR"), confidence: 0.99 },
    references: [],
    confidence: 0.95,
    evidence: { summary: "fixture observation" },
    ...rest,
  };
}

export function inference<T extends string>(value: T, confidence: number, alternatives: Array<[T, number]> = []): Inference<T> {
  return {
    value,
    confidence,
    alternatives: alternatives.map(([v, p]) => ({ value: v, probability: p })),
    basis: ["rule"],
    userSet: false,
  };
}

/** A fused candidate with sensible defaults; override anything. */
export function makeCandidate(p: Partial<TransactionCandidate> & { minor?: number; currency?: string } = {}): TransactionCandidate {
  seq += 1;
  const { minor, currency, ...rest } = p;
  const id = rest.id ?? `cand_fixture_${seq}`;
  const at = rest.timestampEstimated ?? T0;
  return {
    id,
    deduplicationGroup: id,
    status: "confirmed",
    statusHistory: [],
    direction: "debit",
    amount: { value: money(minor ?? 124_900, currency ?? "INR"), confidence: 0.99 },
    merchant: { raw: null, normalized: null, displayName: null, confidence: 0, channel: "unknown" },
    timestampEstimated: at,
    timestampConfirmed: at,
    country: "IN",
    paymentRail: { family: "unknown" },
    sourceSignals: [],
    references: [],
    lineItems: [],
    category: unknownInference("uncategorized"),
    transactionType: unknownInference("unknown"),
    attributes: defaultAttributes(),
    confidence: 0.95,
    provenance: [],
    userVerified: false,
    links: [],
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}
