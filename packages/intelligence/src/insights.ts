import { DAY, MINUTE, clamp01, currencyExponent, formatMoney, stableId, startOfLocalDay, startOfLocalMonth, startOfLocalWeek } from "@brake/core";
import type { Budget, CategoryId, EpochMillis, Goal, LocaleTag, Money, Reference, TransactionCandidate } from "@brake/core";
import type { Cadence, Insight, InsightContext, InsightEngine, InsightKind, RecurringAlert, RecurringFindings, RecurringSeries } from "./contracts";
import { describeCandidate, toneIssues } from "./copy";
import { categoryPace, spendingEffect, summarizeSpending } from "./spending";
import { UNCATEGORIZED, categoryLabel, defaultEssentiality, topLevelCategory } from "./taxonomy";

/**
 * Post-spend insights.
 *
 * After a purchase BRAKE either says one thing that changes the user's
 * understanding — pace, budget, an anomaly, a refund, a subscription change,
 * a goal — or says nothing. Silence is the default: "You spent ₹500." tells
 * people what their bank already told them, and a stream of low-value notices
 * trains them to ignore the valuable ones.
 *
 * Each generator below is a small pure function returning a scored insight or
 * null. Importance (0..1) estimates how much the insight changes the user's
 * picture; the engine shows the single best one if it clears the gate.
 * Wording follows the confidence tiers in copy.ts, so a probable purchase is
 * never stated as fact, and nothing scolds.
 */

export const INSIGHT_THRESHOLDS = {
  /** Default gate: below this the engine stays silent. */
  minImportance: 0.5,
  /** Candidates below this get no insight at all, except a duplicate-charge question. */
  minCandidateConfidence: 0.6,
  /** A category inference must be at least this sure before BRAKE talks about "your Eating out spending". */
  minCategoryConfidence: 0.7,
  /** Pace must be at least this multiple of the usual pace. */
  paceRatio: 1.25,
  /** Previous periods required before a pace is meaningful. */
  paceMinHistory: 3,
  /** Budget remaining below this fraction of the limit becomes noteworthy. */
  lowBudgetFraction: 0.25,
  /** Amount must be at least this multiple of the merchant median to be unusual. */
  unusualMultiple: 3,
  /** Prior purchases at the merchant required before "unusual" means anything. */
  unusualMinPrior: 3,
  /** Same merchant, same amount within this window, with distinct references: possibly charged twice. */
  duplicateWindowMs: 10 * MINUTE,
  /** A discretionary purchase at least this share of a goal's remaining amount is worth mentioning. */
  goalShare: 0.05,
  /** A refund link at least this probable is described as "matched". */
  refundMatchedProbability: 0.8,
} as const;

const T = INSIGHT_THRESHOLDS;

export interface InsightEngineOptions {
  /** Insights below this importance are not shown. Default 0.5 — silence is the default. */
  readonly minImportance?: number;
}

/**
 * When two insights are equally important, the one that protects money or
 * corrects understanding wins (a possible double charge beats a pace note).
 */
const KIND_PRIORITY: readonly InsightKind[] = [
  "possible_duplicate_charge",
  "budget_remaining",
  "refund_tracked",
  "price_increase",
  "new_subscription",
  "category_pace",
  "unusual_amount",
  "goal_impact",
  "upcoming_renewal",
];

export function createInsightEngine(opts: InsightEngineOptions = {}): InsightEngine {
  const gate = clamp01(opts.minImportance ?? T.minImportance);
  return {
    afterSpend(candidate, ctx) {
      const best = rankInsights(candidate, ctx)[0];
      return best && best.importance >= gate ? best : null;
    },
  };
}

/**
 * Every insight that applies to the candidate, most important first, without
 * the importance gate. The engine shows at most the first one; this is exposed
 * for explanations ("why did BRAKE say this?") and tuning.
 */
export function rankInsights(candidate: TransactionCandidate, ctx: InsightContext): Insight[] {
  const env = environment(candidate, ctx);
  if (!env) return [];

  const found: Array<Insight | null> = [];
  if (env.bucket === "spending") found.push(duplicateChargeInsight(env));

  // Below this confidence BRAKE is not sure the purchase happened as described;
  // building further claims on it would present a guess as fact.
  if (candidate.confidence >= T.minCandidateConfidence) {
    if (env.bucket === "refund") {
      found.push(refundInsight(env));
    } else {
      found.push(categoryPaceInsight(env), budgetInsight(env), unusualAmountInsight(env), goalImpactInsight(env));
      found.push(...recurringInsights(env));
    }
  }

  return found
    .filter((i): i is Insight => i !== null && toneIssues(i.text).length === 0)
    .sort((a, b) => b.importance - a.importance || KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind));
}

/* ------------------------------------------------------------------ */
/* Shared helpers (also used by interventions)                          */
/* ------------------------------------------------------------------ */

/**
 * The candidate's category when BRAKE is sure enough to talk about it, else
 * null. "Uncategorized" and "Other" never anchor an insight.
 */
export function confidentCategory(c: TransactionCandidate, minConfidence: number = T.minCategoryConfidence): CategoryId | null {
  const cat = c.category;
  if (!cat.userSet && cat.confidence < minConfidence) return null;
  const top = topLevelCategory(cat.value);
  return top === UNCATEGORIZED || top === "other" ? null : cat.value;
}

function categoryWithin(id: CategoryId, parent: CategoryId): boolean {
  return id === parent || id.startsWith(`${parent}.`);
}

/**
 * Budgets the candidate counts toward: matching category budgets first (most
 * specific), then the overall budget. Only budgets in the candidate's currency
 * apply — BRAKE does not guess exchange rates.
 */
export function applicableBudgets(
  c: TransactionCandidate,
  budgets: readonly Budget[],
  minCategoryConfidence: number = T.minCategoryConfidence,
): Budget[] {
  if (!c.amount) return [];
  const currency = c.amount.value.currency;
  const category = confidentCategory(c, minCategoryConfidence);
  const sameCurrency = budgets.filter((b) => b.limit.currency === currency && b.limit.minor > 0);
  const byCategory = sameCurrency.filter((b) => b.category !== undefined && category !== null && categoryWithin(category, b.category));
  const overall = sameCurrency.filter((b) => b.category === undefined);
  return [...byCategory, ...overall];
}

export interface BudgetStatus {
  readonly budget: Budget;
  readonly periodStart: EpochMillis;
  /** Probability-weighted net spending counted toward the budget so far this period. */
  readonly spent: Money;
  /** What is left (zero when over). */
  readonly remaining: Money;
  /** How far spending is past the limit (zero when within). */
  readonly over: Money;
}

/** Where a budget stands at `now`, from the user's own (probability-weighted) spending. */
export function budgetStatus(
  budget: Budget,
  history: readonly TransactionCandidate[],
  now: EpochMillis,
  timeZone: string,
): BudgetStatus {
  const currency = budget.limit.currency;
  const periodStart = budget.period === "weekly" ? startOfLocalWeek(now, timeZone) : startOfLocalMonth(now, timeZone);
  const spent = summarizeSpending(history, { from: periodStart, to: now + 1, currency, category: budget.category }).total;
  const diff = budget.limit.minor - spent.minor;
  return {
    budget,
    periodStart,
    spent,
    remaining: { minor: Math.max(0, diff), currency },
    over: { minor: Math.max(0, -diff), currency },
  };
}

/**
 * Whether the purchase is discretionary. A user label or a confident
 * inference wins; otherwise the category's population prior decides, and only
 * when the category itself is reasonably sure.
 */
export function isLikelyDiscretionary(c: TransactionCandidate): boolean {
  const e = c.attributes.essentiality;
  if (e.userSet || (e.value !== "unknown" && e.confidence >= 0.6)) return e.value === "discretionary";
  const cat = c.category;
  if (!cat.userSet && cat.confidence < 0.5) return false;
  return defaultEssentiality(cat.value) === "discretionary";
}

/**
 * Display amounts derived from probability-weighted totals are expectations,
 * so they are shown in whole units ("₹2,300 left", not "₹2,299.47 left").
 */
export function wholeUnits(m: Money): Money {
  const unit = 10 ** currencyExponent(m.currency);
  return { minor: Math.round(m.minor / unit) * unit, currency: m.currency };
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

interface Env {
  readonly c: TransactionCandidate;
  readonly ctx: InsightContext;
  readonly amount: Money;
  readonly bucket: "spending" | "refund";
  /** History with this candidate counted exactly once — baselines must include it, once. */
  readonly withSelf: readonly TransactionCandidate[];
  /** History without this candidate. */
  readonly others: readonly TransactionCandidate[];
}

/**
 * Insights are post-spend only: confirmed or posted money that counts as
 * spending or offsets it. Intents, transfers, card bills and cancelled
 * events are not purchases and get no purchase commentary.
 */
function environment(c: TransactionCandidate, ctx: InsightContext): Env | null {
  if (c.status !== "confirmed" && c.status !== "posted") return null;
  if (!c.amount) return null;
  const bucket = spendingEffect(c).bucket;
  if (bucket !== "spending" && bucket !== "refund") return null;
  const others = ctx.history.filter((h) => h.id !== c.id && h.deduplicationGroup !== c.deduplicationGroup);
  return { c, ctx, amount: c.amount.value, bucket, others, withSelf: [...others, c] };
}

function make(env: Env, kind: InsightKind, text: string, importance: number, data: Record<string, unknown>): Insight {
  return { id: stableId("insight", kind, env.c.id), kind, candidateId: env.c.id, text, importance: clamp01(importance), data };
}

/* ------------------------------------------------------------------ */
/* Copy helpers                                                        */
/* ------------------------------------------------------------------ */

function fmt(m: Money, locale: LocaleTag): string {
  return formatMoney(m, locale);
}

/**
 * Lead with the purchase at the right confidence:
 *   high   "₹500 at Swiggy — <sure>"
 *   medium "Looks like you spent about ₹500 at Swiggy. <hedged>"
 */
function aboutPurchase(c: TransactionCandidate, locale: LocaleTag, sure: string, hedged: string): string {
  const d = describeCandidate(c, locale);
  return d.tier === "high" ? `${d.text} — ${sure}` : `${d.text} ${hedged}`;
}

/** A state fact that needs no lead when the purchase is certain, and is conditioned on it otherwise. */
function stateFact(c: TransactionCandidate, locale: LocaleTag, sure: string, hedged: string): string {
  const d = describeCandidate(c, locale);
  return d.tier === "high" ? sure : `${d.text} ${hedged}`;
}

/** "4.5×" — halves below 10 keep it readable without false precision. */
function multiple(ratio: number): string {
  const r = ratio < 10 ? Math.round(ratio * 2) / 2 : Math.round(ratio);
  return `${r}×`;
}

function dayMonth(at: EpochMillis, locale: LocaleTag, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(new Date(at));
}

/** "today", "tomorrow" or "on 12 Oct" in the user's zone. */
function relativeDay(at: EpochMillis, now: EpochMillis, locale: LocaleTag, timeZone: string): string {
  const days = Math.round((startOfLocalDay(at, timeZone) - startOfLocalDay(now, timeZone)) / DAY);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `on ${dayMonth(at, locale, timeZone)}`;
}

/** User-authored names are echoed back only when they read neutrally. */
function safeName(name: string, fallback: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 && toneIssues(trimmed).length === 0 ? trimmed : fallback;
}

/* ------------------------------------------------------------------ */
/* category_pace                                                       */
/* ------------------------------------------------------------------ */

function paceText(ratio: number, hedge: boolean): string {
  if (ratio >= 2) return `about ${multiple(ratio)} your usual pace`;
  return `${hedge ? "about " : ""}${Math.round((ratio - 1) * 100)}% above your usual pace`;
}

/**
 * "₹500 at Swiggy — Eating out spending this week is now 38% above your usual
 * pace." Compares this period so far with the same elapsed part of previous
 * periods (spending.categoryPace). Importance grows with how far above pace
 * the category is and how much this purchase contributed, so a ₹20 snack does
 * not trigger a pace notice on its own.
 */
function categoryPaceInsight(env: Env): Insight | null {
  const category = confidentCategory(env.c);
  if (!category) return null;
  const top = topLevelCategory(category);
  const { now, timeZone, locale } = env.ctx;
  let best: Insight | null = null;
  for (const period of ["week", "month"] as const) {
    const pace = categoryPace(env.withSelf, top, now, { timeZone, currency: env.amount.currency, period, minHistory: T.paceMinHistory });
    if (pace.ratio === null || pace.ratio < T.paceRatio) continue;
    // A late-posting purchase from an earlier period says nothing about this one.
    if (env.c.timestampEstimated < pace.periodStart) continue;
    const ratioScore = clamp01((pace.ratio - T.paceRatio) / 1);
    const amountScore = clamp01(env.amount.minor / pace.baseline.minor);
    // Capped at 0.9: a budget the user set themselves outranks a statistical pace.
    const importance = 0.4 + 0.3 * ratioScore + 0.2 * amountScore;
    if (best && importance <= best.importance) continue;
    const label = categoryLabel(top);
    const sure = `${label} spending this ${period} is now ${paceText(pace.ratio, false)}.`;
    const hedged = `If so, your ${label} spending this ${period} is now ${paceText(pace.ratio, true)}.`;
    best = make(env, "category_pace", aboutPurchase(env.c, locale, sure, hedged), importance, {
      category: top,
      period,
      ratio: pace.ratio,
      current: pace.current,
      baseline: pace.baseline,
      periodsOfHistory: pace.periodsOfHistory,
    });
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* budget_remaining                                                    */
/* ------------------------------------------------------------------ */

/**
 * "₹2,300 left in your Eating out budget this month." Plenty left is not news
 * (importance stays under the gate); importance rises sharply below 25% left,
 * and most when this purchase is the one that crosses the limit. Being over is
 * stated neutrally: "This puts Eating out ₹400 over this month's budget."
 */
function budgetInsight(env: Env): Insight | null {
  const { now, timeZone, locale } = env.ctx;
  let best: Insight | null = null;
  for (const budget of applicableBudgets(env.c, env.ctx.budgets)) {
    const after = budgetStatus(budget, env.withSelf, now, timeZone);
    if (env.c.timestampEstimated < after.periodStart) continue;
    const before = budgetStatus(budget, env.others, now, timeZone);
    const limit = budget.limit.minor;
    const name = budget.category ? categoryLabel(budget.category) : null;
    const periodWord = budget.period === "weekly" ? "week" : "month";

    let importance: number;
    let sure: string;
    let hedged: string;
    if (after.over.minor > 0) {
      const over = fmt(wholeUnits(after.over), locale);
      const subject = name ?? "you";
      importance = before.over.minor === 0 ? 0.92 : 0.65;
      sure = `This puts ${subject} ${over} over this ${periodWord}'s budget.`;
      hedged = `If so, this puts ${subject} about ${over} over this ${periodWord}'s budget.`;
    } else if (after.remaining.minor === 0) {
      importance = 0.85;
      const whose = name ? `your ${name} budget` : "your budget";
      sure = `This uses up the rest of ${whose} for this ${periodWord}.`;
      hedged = `If so, this uses up about the rest of ${whose} for this ${periodWord}.`;
    } else {
      const fraction = after.remaining.minor / limit;
      importance =
        fraction >= T.lowBudgetFraction
          ? 0.15 + 0.3 * (1 - fraction)
          : 0.55 + 0.35 * (1 - fraction / T.lowBudgetFraction);
      const left = fmt(wholeUnits(after.remaining), locale);
      const whose = name ? `your ${name} budget` : "your budget";
      sure = `${left} left in ${whose} this ${periodWord}.`;
      hedged = `If so, about ${left} is left in ${whose} this ${periodWord}.`;
    }
    if (best && importance <= best.importance) continue;
    best = make(env, "budget_remaining", stateFact(env.c, locale, sure, hedged), importance, {
      category: budget.category ?? null,
      period: budget.period,
      limit: budget.limit,
      spent: after.spent,
      remaining: after.remaining,
      over: after.over,
    });
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* unusual_amount                                                      */
/* ------------------------------------------------------------------ */

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function spendingAmounts(cs: readonly TransactionCandidate[], currency: string): number[] {
  const out: number[] = [];
  for (const c of cs) {
    if (c.direction !== "debit" || c.amount?.value.currency !== currency) continue;
    if (spendingEffect(c).bucket === "spending") out.push(c.amount.value.minor);
  }
  return out;
}

/**
 * "₹1,500 at Swiggy — about 4.5× your usual ₹335 there." Needs at least three
 * earlier purchases at the same merchant. Materiality is judged against the
 * user's typical purchase overall, so ₹30 at a tea stall where ₹10 is usual
 * stays silent.
 */
function unusualAmountInsight(env: Env): Insight | null {
  const key = env.c.merchant.normalized;
  if (!key) return null;
  const currency = env.amount.currency;
  const prior = env.others.filter((o) => o.merchant.normalized === key && o.timestampEstimated <= env.c.timestampEstimated);
  const amounts = spendingAmounts(prior, currency);
  if (amounts.length < T.unusualMinPrior) return null;
  const usual = median(amounts);
  if (usual <= 0) return null;
  const ratio = env.amount.minor / usual;
  if (ratio < T.unusualMultiple) return null;

  const typical = median(spendingAmounts(env.others, currency));
  const materiality = clamp01((env.amount.minor - usual) / Math.max(typical, usual));
  const importance = 0.4 + 0.25 * materiality + 0.2 * clamp01((ratio - T.unusualMultiple) / 5);
  const usualText = fmt(wholeUnits({ minor: Math.round(usual), currency }), env.ctx.locale);
  const sure = `about ${multiple(ratio)} your usual ${usualText} there.`;
  const hedged = `If so, that's about ${multiple(ratio)} your usual ${usualText} there.`;
  return make(env, "unusual_amount", aboutPurchase(env.c, env.ctx.locale, sure, hedged), importance, {
    merchant: key,
    ratio,
    usual: { minor: Math.round(usual), currency },
    priorPurchases: amounts.length,
  });
}

/* ------------------------------------------------------------------ */
/* possible_duplicate_charge                                           */
/* ------------------------------------------------------------------ */

function merchantKey(c: TransactionCandidate): string | null {
  const k = c.merchant.normalized ?? c.merchant.displayName ?? c.merchant.raw;
  return k ? k.trim().toLowerCase() : null;
}

function comparable(a: Reference, b: Reference): boolean {
  return a.type === b.type && (a.namespace ?? "") === (b.namespace ?? "");
}

/**
 * Two candidates are provably different events when they carry comparable
 * references (same type and namespace) with different values — two UPI RRNs,
 * two ledger ids, two card network ids — and share none. Without that proof
 * the pair may simply be one event BRAKE has not merged, which is fusion's
 * `possible_duplicate` question, not a double charge.
 */
function provablyDistinct(a: TransactionCandidate, b: TransactionCandidate): boolean {
  let conflicting = false;
  for (const ra of a.references) {
    for (const rb of b.references) {
      if (!comparable(ra, rb)) continue;
      if (ra.value === rb.value) return false;
      conflicting = true;
    }
  }
  return conflicting;
}

const LIVE_STATUSES: ReadonlySet<TransactionCandidate["status"]> = new Set(["pending", "confirmed", "posted"]);

/**
 * "Were you charged twice? There appear to be two ₹1,249 charges at Amazon 3
 * minutes apart." Always phrased as a question — this is the one insight shown
 * even for low-confidence candidates, because the cost of missing a real
 * double charge is high and a question claims nothing.
 */
function duplicateChargeInsight(env: Env): Insight | null {
  const c = env.c;
  if (c.direction !== "debit") return null;
  const key = merchantKey(c);
  if (!key) return null;
  let match: { other: TransactionCandidate; gap: number } | null = null;
  for (const o of env.others) {
    if (o.direction !== "debit" || !LIVE_STATUSES.has(o.status)) continue;
    if (merchantKey(o) !== key) continue;
    if (!o.amount || o.amount.value.currency !== env.amount.currency || o.amount.value.minor !== env.amount.minor) continue;
    const gap = c.timestampEstimated - o.timestampEstimated;
    if (Math.abs(gap) > T.duplicateWindowMs) continue;
    // Warn once per pair: on the later charge.
    if (gap < 0 || (gap === 0 && c.id < o.id)) continue;
    if (!provablyDistinct(c, o)) continue;
    if (!match || gap < match.gap) match = { other: o, gap };
  }
  if (!match) return null;

  const minutes = Math.round(match.gap / MINUTE);
  const apart = minutes === 0 ? "within a minute of each other" : minutes === 1 ? "1 minute apart" : `${minutes} minutes apart`;
  const merchant = c.merchant.displayName ?? match.other.merchant.displayName ?? c.merchant.raw;
  const at = merchant ? ` at ${merchant}` : "";
  const text = `Were you charged twice? There appear to be two ${fmt(env.amount, env.ctx.locale)} charges${at} ${apart}.`;
  // Money may be at stake and the user can act on it, so this outranks a budget crossing.
  const importance = 0.9 + 0.08 * Math.min(c.confidence, match.other.confidence);
  return make(env, "possible_duplicate_charge", text, importance, {
    otherCandidateId: match.other.id,
    minutesApart: minutes,
    amount: env.amount,
  });
}

/* ------------------------------------------------------------------ */
/* refund_tracked                                                      */
/* ------------------------------------------------------------------ */

/**
 * "Refund of ₹1,249 from Amazon matched to your 2 Oct purchase." Closing the
 * loop on a refund is reassurance the user cannot get from a raw credit alert.
 * A weaker reconciliation link is described as "looks like".
 */
function refundInsight(env: Env): Insight | null {
  const link = [...env.c.links].filter((l) => l.kind === "refund_of").sort((a, b) => b.probability - a.probability)[0];
  if (!link) return null;
  const { locale, timeZone } = env.ctx;
  const original = env.others.find((o) => o.id === link.target);
  const merchant = env.c.merchant.displayName ?? original?.merchant.displayName ?? null;
  const from = merchant ? ` from ${merchant}` : "";
  const amount = fmt(env.amount, locale);
  const purchase = original ? `your ${dayMonth(original.timestampEstimated, locale, timeZone)} purchase` : "an earlier purchase";
  const originalAmount = original?.amount?.value;
  const partial =
    originalAmount && originalAmount.currency === env.amount.currency && originalAmount.minor > env.amount.minor
      ? ` of ${fmt(originalAmount, locale)}`
      : "";
  const matched = link.probability >= T.refundMatchedProbability && describeCandidate(env.c, locale).tier === "high";
  const text = matched
    ? `Refund of ${amount}${from} matched to ${purchase}${partial}.`
    : `Looks like ${amount}${from} is a refund for ${purchase}${partial}.`;
  return make(env, "refund_tracked", text, 0.55 + 0.25 * link.probability, {
    originalCandidateId: link.target,
    linkProbability: link.probability,
    partial: partial.length > 0,
  });
}

/* ------------------------------------------------------------------ */
/* new_subscription / price_increase / upcoming_renewal                 */
/* ------------------------------------------------------------------ */

const PER_CADENCE: Readonly<Record<Cadence, string | null>> = {
  weekly: "a week",
  biweekly: "every 2 weeks",
  monthly: "a month",
  quarterly: "every 3 months",
  semiannual: "every 6 months",
  annual: "a year",
  irregular: null,
};

function seriesOf(c: TransactionCandidate, r: RecurringFindings): RecurringSeries | null {
  const linked = new Set<string>();
  for (const l of c.links) if (l.kind === "recurring_series") linked.add(l.target);
  for (const l of r.patches.get(c.id)?.links ?? []) if (l.kind === "recurring_series") linked.add(l.target);
  return r.series.find((s) => s.memberIds.includes(c.id) || linked.has(s.id)) ?? null;
}

function recurringInsights(env: Env): Insight[] {
  const r = env.ctx.recurring;
  if (!r) return [];
  const series = seriesOf(env.c, r);
  if (!series) return [];
  const out: Insight[] = [];
  for (const alert of r.alerts) {
    if (alert.seriesId !== series.id) continue;
    const i = recurringInsight(env, series, alert);
    if (i) out.push(i);
  }
  return out;
}

function recurringInsight(env: Env, s: RecurringSeries, alert: RecurringAlert): Insight | null {
  const { locale, timeZone, now } = env.ctx;
  const name = s.displayName || env.c.merchant.displayName || "This subscription";
  const per = PER_CADENCE[s.cadence];
  const perSuffix = per ? ` ${per}` : "";
  const sure = alert.confidence >= 0.7;
  const data = { seriesId: s.id, alertConfidence: alert.confidence, cadence: s.cadence };

  switch (alert.kind) {
    case "new_subscription": {
      // A new recurring commitment is easy to miss in a list of one-off charges.
      const price = fmt(alert.amount ?? s.typicalAmount, locale);
      const what = per ? ` at ${price}${perSuffix}` : "";
      const text = sure ? `${name} looks like a new subscription${what}.` : `${name} might be a new subscription${what}.`;
      return make(env, "new_subscription", text, 0.5 + 0.3 * alert.confidence, data);
    }
    case "price_increase": {
      const current = alert.amount ?? env.amount;
      const previous = alert.previousAmount;
      const rise =
        previous && previous.currency === current.currency && previous.minor > 0 ? (current.minor - previous.minor) / previous.minor : 0;
      const body = previous
        ? `${name} now costs ${fmt(current, locale)}${perSuffix}, up from ${fmt(previous, locale)}.`
        : `${name}'s price went up to ${fmt(current, locale)}${perSuffix}.`;
      const text = sure ? body : `Looks like ${body}`;
      const importance = (0.6 + 0.25 * clamp01(rise / 0.25)) * (0.6 + 0.4 * alert.confidence);
      return make(env, "price_increase", text, importance, { ...data, previous: previous ?? null, current, rise });
    }
    case "upcoming_renewal": {
      const when = s.nextExpectedAt ?? alert.at;
      if (when <= now) return null;
      const amount = alert.amount ?? s.nextExpectedAmount ?? s.typicalAmount;
      const day = relativeDay(when, now, locale, timeZone);
      const body = `${name} renews ${day} for ${fmt(amount, locale)}.`;
      const text = sure ? body : `${name} looks set to renew ${day} for ${fmt(amount, locale)}.`;
      const soon = when - now <= 3 * DAY ? 0.15 : 0;
      return make(env, "upcoming_renewal", text, 0.4 + 0.2 * alert.confidence + soon, { ...data, renewsAt: when, amount });
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* goal_impact                                                         */
/* ------------------------------------------------------------------ */

/**
 * "₹6,200 at Croma — that's 12% of what's left for Goa trip." Connects a
 * discretionary purchase to something the user said they care about, as a
 * neutral fact. Essentials never trigger it.
 */
function goalImpactInsight(env: Env): Insight | null {
  if (!isLikelyDiscretionary(env.c)) return null;
  let best: { goal: Goal; share: number; remaining: Money } | null = null;
  for (const goal of env.ctx.goals) {
    if (goal.target.currency !== env.amount.currency || goal.saved.currency !== env.amount.currency) continue;
    const remaining = goal.target.minor - goal.saved.minor;
    if (remaining <= 0) continue;
    const share = env.amount.minor / remaining;
    if (share < T.goalShare) continue;
    if (!best || share > best.share) best = { goal, share, remaining: { minor: remaining, currency: goal.target.currency } };
  }
  if (!best) return null;
  const goalName = safeName(best.goal.name, "your goal");
  const pct = Math.round(best.share * 100);
  const sure = best.share >= 1 ? `that's more than what's left for ${goalName}.` : `that's ${pct}% of what's left for ${goalName}.`;
  const hedged =
    best.share >= 1 ? `If so, that's more than what's left for ${goalName}.` : `If so, that's about ${pct}% of what's left for ${goalName}.`;
  const importance = 0.5 + 0.4 * clamp01((best.share - T.goalShare) / 0.25);
  return make(env, "goal_impact", aboutPurchase(env.c, env.ctx.locale, sure, hedged), importance, {
    goalId: best.goal.id,
    share: best.share,
    remaining: best.remaining,
  });
}
