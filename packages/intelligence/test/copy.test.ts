import { describe, expect, it } from "vitest";
import { defaultAttributes, money, unknownInference } from "@brake/core";
import type { TransactionCandidate } from "@brake/core";
import { confidenceTier, describeCandidate, toneIssues } from "../src/index";

function candidate(confidence: number, approximate = false): TransactionCandidate {
  return {
    id: "cand_1",
    deduplicationGroup: "cand_1",
    status: "confirmed",
    statusHistory: [],
    direction: "debit",
    amount: { value: money(85000, "INR"), confidence: approximate ? 0.7 : 0.99, approximate },
    merchant: { raw: "STARBUCKS", normalized: "starbucks", displayName: "Starbucks", confidence: 0.9, channel: "in_store" },
    timestampEstimated: 0,
    timestampConfirmed: 0,
    country: "IN",
    paymentRail: { family: "card" },
    sourceSignals: [],
    references: [],
    lineItems: [],
    category: unknownInference("uncategorized"),
    transactionType: unknownInference("purchase"),
    attributes: defaultAttributes(),
    confidence,
    provenance: [],
    userVerified: false,
    links: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("confidence-aware copy", () => {
  it("matches the brief's three tiers", () => {
    expect(describeCandidate(candidate(0.97), "en-IN").text).toBe("₹850 at Starbucks");
    expect(describeCandidate(candidate(0.7), "en-IN").text).toBe("Looks like you spent about ₹850 at Starbucks.");
    expect(describeCandidate(candidate(0.4), "en-IN").text).toBe("Was this ₹850 transaction at Starbucks?");
  });

  it("never states an approximate amount flatly", () => {
    expect(describeCandidate(candidate(0.99, true), "en-IN").tier).toBe("medium");
  });

  it("tiers probabilities", () => {
    expect(confidenceTier(0.9)).toBe("high");
    expect(confidenceTier(0.6)).toBe("medium");
    expect(confidenceTier(0.59)).toBe("low");
  });

  it("flags scolding or uninformative copy", () => {
    expect(toneIssues("You spent ₹500.")).not.toHaveLength(0);
    expect(toneIssues("You wasted ₹500 on snacks")).not.toHaveLength(0);
    expect(toneIssues("Food spending this week is now 38% above your usual pace.")).toEqual([]);
  });
});
