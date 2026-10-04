import { describe, expect, it } from "vitest";
import { DAY, defaultAttributes, money, unknownInference, zonedTimeToEpoch } from "@brake/core";
import type { Inference, TransactionCandidate, TransactionType, TransferKind } from "@brake/core";
import { categoryPace, spendingEffect, summarizeSpending } from "../src/index";

const TZ = "Asia/Kolkata";
let n = 0;
function cand(p: {
  minor: number;
  at: number;
  type?: TransactionType;
  typeConfidence?: number;
  transferKind?: TransferKind;
  category?: string;
  direction?: "debit" | "credit";
  status?: TransactionCandidate["status"];
}): TransactionCandidate {
  const type: Inference<TransactionType> = p.type
    ? { value: p.type, confidence: p.typeConfidence ?? 1, alternatives: [], basis: ["rule"], userSet: false }
    : unknownInference("unknown");
  n += 1;
  return {
    id: `c${n}`,
    deduplicationGroup: `c${n}`,
    status: p.status ?? "posted",
    statusHistory: [],
    direction: p.direction ?? "debit",
    amount: { value: money(p.minor, "INR"), confidence: 1 },
    merchant: { raw: null, normalized: null, displayName: null, confidence: 0, channel: "unknown" },
    timestampEstimated: p.at,
    timestampConfirmed: p.at,
    country: "IN",
    paymentRail: { family: "unknown" },
    sourceSignals: [],
    references: [],
    lineItems: [],
    category: { value: p.category ?? "eating_out", confidence: 1, alternatives: [], basis: ["rule"], userSet: false },
    transactionType: type,
    ...(p.transferKind ? { transferKind: p.transferKind } : {}),
    attributes: defaultAttributes(),
    confidence: 1,
    provenance: [],
    userVerified: false,
    links: [],
    createdAt: p.at,
    updatedAt: p.at,
  };
}

describe("spending effect", () => {
  const t = Date.UTC(2026, 9, 4);
  it("never counts transfers, card bills or investments as spending", () => {
    expect(spendingEffect(cand({ minor: 5_000_000, at: t, type: "transfer", transferKind: "own_account" })).bucket).toBe("transfer");
    expect(spendingEffect(cand({ minor: 5_000_000, at: t, type: "credit_card_payment" })).bucket).toBe("debt_payment");
    expect(spendingEffect(cand({ minor: 5_000_000, at: t, type: "investment" })).bucket).toBe("investment");
    expect(spendingEffect(cand({ minor: 5_000_000, at: t, type: "transfer", transferKind: "family" })).bucket).toBe("outflow_other");
  });

  it("counts purchases, offsets refunds, excludes intents", () => {
    expect(spendingEffect(cand({ minor: 124_900, at: t, type: "purchase" }))).toMatchObject({ bucket: "spending", sign: 1, weightedMinor: 124_900 });
    expect(spendingEffect(cand({ minor: 124_900, at: t, type: "refund", direction: "credit" }))).toMatchObject({ bucket: "refund", sign: -1 });
    expect(spendingEffect(cand({ minor: 124_900, at: t, type: "purchase", status: "intent" })).bucket).toBe("excluded");
  });

  it("weights uncertain types instead of collapsing them", () => {
    const e = spendingEffect(cand({ minor: 100_000, at: t, type: "purchase", typeConfidence: 0.7 }));
    expect(e.weightedMinor).toBe(70_000);
  });
});

describe("category pace", () => {
  it("compares this week so far with the same point of previous weeks", () => {
    // Thursday 2026-10-08 18:00 IST; previous weeks spent ₹1,000 by Thursday evening.
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 18, minute: 0, second: 0 }, TZ);
    const cands: TransactionCandidate[] = [];
    for (let w = 1; w <= 4; w++) cands.push(cand({ minor: 100_000, at: now - w * 7 * DAY - DAY }));
    cands.push(cand({ minor: 138_000, at: now - DAY }));
    const pace = categoryPace(cands, "eating_out", now, { timeZone: TZ, currency: "INR" });
    expect(pace.periodsOfHistory).toBe(4);
    expect(pace.ratio).toBeCloseTo(1.38, 2);
  });

  it("summarizes net spending including refunds", () => {
    const t = Date.UTC(2026, 9, 4);
    const s = summarizeSpending(
      [cand({ minor: 100_000, at: t, type: "purchase" }), cand({ minor: 40_000, at: t, type: "refund", direction: "credit" })],
      { from: t - DAY, to: t + DAY, currency: "INR" },
    );
    expect(s.total.minor).toBe(60_000);
  });
});
