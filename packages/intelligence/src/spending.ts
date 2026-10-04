import { DAY, startOfLocalMonth, startOfLocalWeek } from "@brake/core";
import type { CategoryId, EpochMillis, Money, TransactionCandidate, TransactionType } from "@brake/core";
import type { SpendingEffect } from "./contracts";
import { topLevelCategory } from "./taxonomy";

/**
 * What counts as spending. Transfers, card-bill payments, investments and
 * loan payments are never "spending" — calling them spending destroys trust.
 * Uncertainty is kept: a debit whose type is 70% purchase / 30% transfer
 * contributes 70% of its amount to probability-weighted baselines, while its
 * displayed bucket is the most likely one.
 */

const WEEK_MS = 7 * DAY;

const SPENDING_TYPES: ReadonlySet<TransactionType> = new Set([
  "purchase",
  "subscription",
  "fee",
  "tax",
  "shared_expense",
  "business_expense",
]);

/** True when the candidate's only evidence is enrichment (email/receipt) and it likely duplicates another candidate. */
export function isLikelyDuplicate(c: TransactionCandidate): boolean {
  const hasMoneyMovement = c.sourceSignals.some((s) => s.kind === "money_movement");
  if (hasMoneyMovement) return false;
  return c.links.some((l) => l.kind === "possible_duplicate" && l.probability >= 0.5);
}

function probabilityOfSpending(c: TransactionCandidate): number {
  const t = c.transactionType;
  let p = SPENDING_TYPES.has(t.value) ? t.confidence : 0;
  for (const alt of t.alternatives) if (SPENDING_TYPES.has(alt.value)) p += alt.probability;
  // An uninformed type on a debit is most likely a purchase, but not certainly.
  if (t.value === "unknown" && t.confidence === 0 && t.alternatives.length === 0) p = 0.6;
  return Math.min(1, p);
}

export function spendingEffect(c: TransactionCandidate): SpendingEffect {
  const minor = c.amount?.value.minor ?? 0;
  const none = (bucket: SpendingEffect["bucket"], reason: string): SpendingEffect => ({ bucket, sign: 0, weightedMinor: 0, reason });

  if (c.status === "intent") return none("excluded", "intent: no money moved");
  if (c.status === "cancelled") return none("excluded", "cancelled");
  if (isLikelyDuplicate(c)) return none("excluded", "likely duplicate of another candidate");
  if (!c.amount) return none("excluded", "amount unknown");

  const ownership = c.attributes.ownership;
  const type = c.transactionType.value;

  if (c.direction === "credit") {
    if (type === "refund" || type === "reimbursement") {
      return { bucket: "refund", sign: -1, weightedMinor: Math.round(minor * c.confidence), reason: `${type} offsets spending` };
    }
    if (type === "income") return none("income", "income");
    if (type === "transfer") return none("transfer", "incoming transfer");
    return none("excluded", "credit of unknown meaning");
  }

  if (c.status === "refunded") return none("excluded", "fully refunded");

  switch (type) {
    case "transfer":
      return c.transferKind === "own_account" || c.transferKind === "wallet_load"
        ? none("transfer", `transfer (${c.transferKind})`)
        : none("outflow_other", `transfer (${c.transferKind ?? "unknown"})`);
    case "credit_card_payment":
    case "loan_payment":
      return none("debt_payment", type);
    case "investment":
      return none("investment", "investment");
    case "cash_withdrawal":
      return none("cash", "cash withdrawal");
    case "income":
    case "refund":
    case "reimbursement":
      return none("excluded", `${type} on a debit`);
    default:
      break;
  }

  if (ownership.value === "business" || ownership.value === "reimbursable") {
    if (ownership.userSet || ownership.confidence >= 0.8) return none("outflow_other", `${ownership.value} expense`);
  }

  const p = probabilityOfSpending(c) * c.confidence;
  return { bucket: "spending", sign: 1, weightedMinor: Math.round(minor * p), reason: `spending (p=${p.toFixed(2)})` };
}

export interface SpendingQuery {
  readonly from: EpochMillis;
  readonly to: EpochMillis;
  readonly currency: string;
  /** Matches the category and its children ("eating_out" includes "eating_out.delivery"). */
  readonly category?: CategoryId;
}

export interface SpendingSummary {
  readonly total: Money;
  readonly count: number;
  readonly byCategory: ReadonlyMap<CategoryId, number>;
}

function inCategory(c: TransactionCandidate, category: CategoryId | undefined): boolean {
  if (!category) return true;
  const id = c.category.value;
  return id === category || id.startsWith(`${category}.`) || topLevelCategory(id) === category;
}

/** Probability-weighted net spending in a window (refunds subtract). Other currencies are ignored. */
export function summarizeSpending(candidates: readonly TransactionCandidate[], q: SpendingQuery): SpendingSummary {
  let total = 0;
  let count = 0;
  const byCategory = new Map<CategoryId, number>();
  for (const c of candidates) {
    if (!c.amount || c.amount.value.currency !== q.currency) continue;
    if (c.timestampEstimated < q.from || c.timestampEstimated >= q.to) continue;
    if (!inCategory(c, q.category)) continue;
    const e = spendingEffect(c);
    if (e.sign === 0) continue;
    const signed = e.sign * e.weightedMinor;
    total += signed;
    count += 1;
    const top = topLevelCategory(c.category.value);
    byCategory.set(top, (byCategory.get(top) ?? 0) + signed);
  }
  return { total: { minor: Math.max(0, total), currency: q.currency }, count, byCategory };
}

export interface PaceResult {
  /** Spending so far in the current period. */
  readonly current: Money;
  /** Typical spending by the same point of previous periods (median). */
  readonly baseline: Money;
  /** current / baseline; null when there is not enough history. */
  readonly ratio: number | null;
  readonly periodsOfHistory: number;
  readonly periodStart: EpochMillis;
}

export interface PaceOptions {
  readonly timeZone: string;
  readonly currency: string;
  readonly period?: "week" | "month";
  /** How many previous periods to compare against. Default 8 weeks / 6 months. */
  readonly lookback?: number;
  /** Minimum previous periods with any spending before a ratio is reported. Default 3. */
  readonly minHistory?: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Category spending pace: how this period compares with the same elapsed
 * portion of previous periods ("Food this week is 38% above your usual pace").
 */
export function categoryPace(
  candidates: readonly TransactionCandidate[],
  category: CategoryId | undefined,
  now: EpochMillis,
  opts: PaceOptions,
): PaceResult {
  const period = opts.period ?? "week";
  const lookback = opts.lookback ?? (period === "week" ? 8 : 6);
  const minHistory = opts.minHistory ?? 3;
  const start = period === "week" ? startOfLocalWeek(now, opts.timeZone) : startOfLocalMonth(now, opts.timeZone);
  const elapsed = now - start;
  const current = summarizeSpending(candidates, { from: start, to: now + 1, currency: opts.currency, category }).total;

  // Only periods after the user's history began count; earlier "zero" periods are unknown, not zero.
  let earliest = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (c.amount?.value.currency === opts.currency && c.timestampEstimated < earliest) earliest = c.timestampEstimated;
  }
  const previous: number[] = [];
  let cursor = start;
  for (let i = 0; i < lookback; i++) {
    const prevStart =
      period === "week" ? startOfLocalWeek(cursor - WEEK_MS / 2, opts.timeZone) : startOfLocalMonth(cursor - 1, opts.timeZone);
    if (cursor <= earliest) break;
    const s = summarizeSpending(candidates, { from: prevStart, to: prevStart + elapsed + 1, currency: opts.currency, category });
    previous.push(s.total.minor);
    cursor = prevStart;
  }
  const periodsWithData = previous.length;
  const baseline = Math.round(median(previous));
  const ratio = periodsWithData >= minHistory && baseline > 0 ? current.minor / baseline : null;
  return {
    current,
    baseline: { minor: baseline, currency: opts.currency },
    ratio,
    periodsOfHistory: periodsWithData,
    periodStart: start,
  };
}
