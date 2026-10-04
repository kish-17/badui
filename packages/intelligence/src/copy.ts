import { formatMoney } from "@brake/core";
import type { LocaleTag, Money, Probability, TransactionCandidate } from "@brake/core";
import type { ConfidenceTier } from "./contracts";

/**
 * Confidence-aware language. BRAKE never sounds more certain than it is:
 *   high   "₹850 at Starbucks"
 *   medium "Looks like you spent about ₹850 at Starbucks."
 *   low    "Was this ₹850 transaction at Starbucks?"
 */

export const TIER_THRESHOLDS = { high: 0.85, medium: 0.6 } as const;

export function confidenceTier(p: Probability): ConfidenceTier {
  if (p >= TIER_THRESHOLDS.high) return "high";
  if (p >= TIER_THRESHOLDS.medium) return "medium";
  return "low";
}

export interface CandidateDescription {
  readonly text: string;
  readonly tier: ConfidenceTier;
}

/** Display money for a candidate, or null if unknown. */
export function candidateAmountText(c: TransactionCandidate, locale: LocaleTag): string | null {
  return c.amount ? formatMoney(c.amount.value, locale) : null;
}

/**
 * Describe a candidate at the right confidence. The tier is the lower of the
 * candidate's existence confidence and its amount confidence, so an
 * approximate amount is never stated flatly.
 */
export function describeCandidate(c: TransactionCandidate, locale: LocaleTag): CandidateDescription {
  const amountConf = c.amount ? (c.amount.approximate ? Math.min(c.amount.confidence, 0.84) : c.amount.confidence) : 0;
  const tier = confidenceTier(Math.min(c.confidence, amountConf || c.confidence));
  const amount = candidateAmountText(c, locale);
  const merchant = c.merchant.displayName ?? c.counterparty?.name ?? null;
  const incoming = c.direction === "credit";

  if (!amount) {
    const text = merchant ? (tier === "low" ? `Was there a payment to ${merchant}?` : `Payment at ${merchant}`) : "A payment";
    return { text, tier };
  }

  if (incoming) {
    const from = merchant ? ` from ${merchant}` : "";
    switch (tier) {
      case "high":
        return { text: `${amount} received${from}`, tier };
      case "medium":
        return { text: `Looks like you received about ${amount}${from}.`, tier };
      case "low":
        return { text: `Did you receive ${amount}${from}?`, tier };
    }
  }

  const at = merchant ? ` at ${merchant}` : "";
  switch (tier) {
    case "high":
      return { text: `${amount}${at}`, tier };
    case "medium":
      return { text: `Looks like you spent about ${amount}${at}.`, tier };
    case "low":
      return { text: `Was this ${amount} transaction${at}?`, tier };
  }
}

/** Short money phrase used inside insight/intervention sentences. */
export function money(m: Money, locale: LocaleTag): string {
  return formatMoney(m, locale);
}

const SCOLDING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwast(e|ed|ing|eful)\b/i, "judgemental: 'waste'"],
  [/\bshould(?:n't| not) have\b/i, "judgemental: 'shouldn't have'"],
  [/\b(bad|poor|irresponsible|careless|reckless)\s+(choice|decision|spending|habit)/i, "judgemental adjective"],
  [/\b(guilt|guilty|shame|ashamed)\b/i, "guilt/shame language"],
  [/\b(again\?|seriously|really\?)/i, "sarcasm"],
  [/\byou (always|never)\b/i, "absolute generalisation about the user"],
  [/\boverspen(t|d|ding)\b/i, "loaded term 'overspent'"],
  [/!{2,}/, "shouting"],
];

/**
 * Lint user-facing copy against BRAKE's tone rules. Returns the problems
 * found (empty = acceptable). Used in tests for every generated message.
 */
export function toneIssues(text: string): string[] {
  const issues: string[] = [];
  for (const [re, why] of SCOLDING_PATTERNS) if (re.test(text)) issues.push(why);
  // "You spent ₹500." on its own tells the user nothing they don't know.
  if (/^\s*you spent [^.]+\.?\s*$/i.test(text)) issues.push("uninformative: restates the purchase only");
  return issues;
}
