import { DAY, HOUR, clamp01, formatMoney, localParts, stableHash, zonedTimeToEpoch } from "@brake/core";
import type { EpochMillis, Inference, LocaleTag, Satisfaction, TransactionCandidate } from "@brake/core";
import type {
  RegretEstimate,
  RegretFeatures,
  RegretModel,
  RegretPromptContext,
  RegretPromptPlan,
  RegretPromptPolicy,
} from "./contracts";
import { DEFAULT_QUIET_HOURS, isQuietHour } from "./questions";
import type { QuietHours } from "./questions";
import { SATISFACTION_OPTIONS, topLevelCategory } from "./taxonomy";

/**
 * Regret / satisfaction learning: which purchases does THIS user later regret?
 *
 * The purpose is learning, not guilt. BRAKE asks rarely, a day or more after
 * the purchase, only about discretionary purchases whose kind it does not yet
 * understand — and stops asking about a kind once it does. An obsessive
 * regret-tracking loop is a bug (docs/research/09 §E8, §4.4: rating every
 * purchase turns spending into homework and drains the enjoyment from purchases
 * that were fine).
 */

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

export interface RegretFeatureOptions {
  /** IANA zone used to read the purchase's local time of day and day of week. */
  readonly timeZone: string;
  /** The user's typical discretionary purchase, in minor units of the candidate's currency. */
  readonly typicalDiscretionaryMinor: number;
  /**
   * Local weekdays that count as the weekend, 0 = Monday … 6 = Sunday.
   * Default Saturday and Sunday; injected (never derived from a country) so a
   * Friday–Saturday weekend is configuration, not a code branch.
   */
  readonly weekendDays?: readonly number[];
}

const DEFAULT_WEEKEND: readonly number[] = [5, 6];

/** morning 5–12, afternoon 12–17, evening 17–22, late night 22–5 (local). */
export function timeBandForHour(hour: number): RegretFeatures["timeBand"] {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "late_night";
}

/** Amount relative to the typical discretionary purchase: small < 0.5×, medium < 2×, large < 5×, else very large. */
export function amountBandForRatio(ratio: number): RegretFeatures["amountBand"] {
  if (ratio < 0.5) return "small";
  if (ratio < 2) return "medium";
  if (ratio < 5) return "large";
  return "very_large";
}

function trusted<T extends string>(i: Inference<T>): boolean {
  return i.userSet || i.confidence >= 0.5;
}

/** Whether the purchase was planned, from the intent attribute (purchase context as a fallback). */
function plannedness(c: TransactionCandidate): RegretFeatures["planned"] {
  const intent = c.attributes.intent;
  if (trusted(intent)) {
    if (intent.value === "planned" || intent.value === "recurring") return "planned";
    if (intent.value === "unplanned" || intent.value === "impulsive" || intent.value === "emergency") return "unplanned";
  }
  const context = c.attributes.purchaseContext;
  if (trusted(context)) {
    if (context.value === "planned_in_advance" || context.value === "replacement") return "planned";
    if (context.value === "saw_and_bought" || context.value === "convenience") return "unplanned";
  }
  return "unknown";
}

/**
 * Coarse features a regret model conditions on. Coarse on purpose: regret
 * profiles are sensitive derived data (docs/research/09 §E8), and coarse
 * segments generalize from the handful of answers BRAKE will ever get.
 */
export function regretFeatures(c: TransactionCandidate, opts: RegretFeatureOptions): RegretFeatures {
  const local = localParts(c.timestampEstimated, opts.timeZone);
  const weekend = (opts.weekendDays ?? DEFAULT_WEEKEND).includes(local.weekday);
  const typical = opts.typicalDiscretionaryMinor;
  // Unknown amount or no typical amount: "medium" is the neutral band.
  const amountBand = c.amount && typical > 0 && Number.isFinite(typical) ? amountBandForRatio(c.amount.value.minor / typical) : "medium";
  return {
    category: topLevelCategory(c.category.value),
    channel: c.merchant.channel,
    timeBand: timeBandForHour(local.hour),
    dayType: weekend ? "weekend" : "weekday",
    amountBand,
    planned: plannedness(c),
  };
}

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/** Population prior: Beta(1, 3), i.e. "about one purchase in four is regretted", worth four answers. */
export const REGRET_PRIOR = { alpha: 1, beta: 3 } as const;

/** How much each answer counts as regret. "Neutral" is a mild signal, not a zero. */
export const SATISFACTION_REGRET_WEIGHT: Readonly<Record<Satisfaction, number>> = {
  regretted: 1,
  neutral: 0.3,
  worth_it: 0,
};

export interface RegretModelSnapshot {
  readonly version: 1;
  readonly prior: { readonly alpha: number; readonly beta: number };
  /** Per-segment sums: `regret` is the weighted regret total, `answers` the number of answers. */
  readonly segments: ReadonlyArray<{ readonly key: string; readonly regret: number; readonly answers: number }>;
}

interface Tally {
  regret: number;
  answers: number;
}

/**
 * The back-off path for a feature vector, coarsest first:
 * global → category → category+time band+channel → full key.
 */
export function regretSegmentPath(f: RegretFeatures): readonly [string, string, string, string] {
  const category = `category=${f.category}`;
  const middle = `${category}|time=${f.timeBand}|channel=${f.channel}`;
  return ["global", category, middle, `${middle}|day=${f.dayType}|amount=${f.amountBand}|planned=${f.planned}`];
}

function parseSnapshot(raw: unknown): { prior: { alpha: number; beta: number }; tallies: Map<string, Tally> } {
  const fail = (why: string): never => {
    throw new TypeError(`Invalid regret model snapshot: ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const s = raw as Partial<RegretModelSnapshot>;
  if (s.version !== 1) return fail(`unsupported version ${String(s.version)}`);
  const alpha = s.prior?.alpha;
  const beta = s.prior?.beta;
  if (typeof alpha !== "number" || typeof beta !== "number" || !(alpha > 0) || !(beta > 0)) return fail("bad prior");
  if (!Array.isArray(s.segments)) return fail("segments is not an array");
  const tallies = new Map<string, Tally>();
  for (const seg of s.segments as unknown[]) {
    const e = seg as { key?: unknown; regret?: unknown; answers?: unknown };
    if (typeof e.key !== "string" || typeof e.regret !== "number" || typeof e.answers !== "number") return fail("bad segment entry");
    if (!(e.answers >= 0) || !(e.regret >= 0) || e.regret > e.answers + 1e-9 || !Number.isFinite(e.answers)) {
      return fail(`bad counts for ${e.key}`);
    }
    tallies.set(e.key, { regret: e.regret, answers: e.answers });
  }
  return { prior: { alpha, beta }, tallies };
}

/**
 * Hierarchical Beta-Bernoulli regret model with back-off
 * (full key → category+time band+channel → category → global).
 *
 * Each answer is counted exactly once, at the finest segment it belongs to;
 * every coarser level acts as a prior built from the user's *other* answers.
 * Walking down the path, a level's mean shrinks toward its parent's in
 * proportion to its own evidence:
 *
 *   m_global = (α + r₀) / (α + β + n₀)                 — answers outside this category
 *   m_k      = (r_k + κ · m_{k−1}) / (n_k + κ),  κ = α + β
 *
 * Counting each answer once (rather than at every level) keeps a single
 * "regretted" from jumping a segment to near-certainty: one answer moves an
 * unseen user from 0.25 to 0.4, not to 0.7. With no data in a segment the
 * estimate *is* its parent's (back-off), and `segment` names the finest level
 * that has answers.
 */
export function createRegretModel(snapshot?: unknown): RegretModel {
  const parsed = snapshot === undefined ? null : parseSnapshot(snapshot);
  const prior = parsed?.prior ?? { alpha: REGRET_PRIOR.alpha, beta: REGRET_PRIOR.beta };
  const strength = prior.alpha + prior.beta;
  const tallies = parsed?.tallies ?? new Map<string, Tally>();

  return {
    record(features: RegretFeatures, answer: Satisfaction): void {
      const weight = SATISFACTION_REGRET_WEIGHT[answer];
      if (weight === undefined) throw new RangeError(`Unknown satisfaction answer: ${String(answer)}`);
      for (const key of regretSegmentPath(features)) {
        const t = tallies.get(key) ?? { regret: 0, answers: 0 };
        t.regret += weight;
        t.answers += 1;
        tallies.set(key, t);
      }
    },

    estimate(features: RegretFeatures): RegretEstimate {
      const path = regretSegmentPath(features);
      const totals = path.map((k) => tallies.get(k) ?? { regret: 0, answers: 0 });
      // A level's own answers: its total minus the child segment on this path.
      const own = totals.map((t, i) => {
        const child = totals[i + 1];
        if (!child) return t;
        return { regret: Math.max(0, t.regret - child.regret), answers: Math.max(0, t.answers - child.answers) };
      });

      const top = own[0]!;
      let mean = (prior.alpha + top.regret) / (strength + top.answers);
      let evidence = top.answers;
      for (let i = 1; i < own.length; i++) {
        const o = own[i]!;
        mean = (o.regret + strength * mean) / (o.answers + strength);
        // Inherited evidence is worth at most κ answers: the parent is only a prior here.
        evidence = o.answers + (strength * evidence) / (evidence + strength);
      }

      let segment = "global";
      for (let i = path.length - 1; i >= 0; i--) {
        if (totals[i]!.answers > 0) {
          segment = path[i]!;
          break;
        }
      }
      return { probability: clamp01(mean), evidence, segment };
    },

    toJSON(): RegretModelSnapshot {
      const segments = [...tallies.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, t]) => ({ key, regret: t.regret, answers: t.answers }));
      return { version: 1, prior: { alpha: prior.alpha, beta: prior.beta }, segments };
    },
  };
}

/**
 * Expected information gain of one more answer for a segment, normalized so a
 * brand-new segment under the prior scores 1.
 *
 * For a Beta posterior with mean p and N pseudo-observations, one Bernoulli
 * answer reduces the expected posterior variance by p(1−p)/(N+1)². High when
 * evidence is low or the segment is a coin flip; it falls quadratically as
 * answers accumulate, which is what makes the loop go quiet on its own.
 */
export function regretInformationValue(estimate: Pick<RegretEstimate, "probability" | "evidence">): number {
  const strength = REGRET_PRIOR.alpha + REGRET_PRIOR.beta;
  const p0 = REGRET_PRIOR.alpha / strength;
  const p = clamp01(estimate.probability);
  const n = Math.max(0, estimate.evidence) + strength;
  return (p * (1 - p)) / (n + 1) ** 2 / ((p0 * (1 - p0)) / (strength + 1) ** 2);
}

/**
 * Probability that an eligible purchase with this information value is
 * prompted. Log it with the answer: inverse-propensity weighting removes the
 * bias of asking mostly about uncertain segments (docs/research/09 §E9, §4.4).
 */
export function regretSamplingProbability(value: number): number {
  return clamp01(value);
}

/** Uniform [0, 1) draw that is a pure function of the candidate id (no Math.random). */
function stableUnit(id: string): number {
  return parseInt(stableHash(`regret-prompt␟${id}`), 36) / 2 ** 53;
}

/* ------------------------------------------------------------------ */
/* Prompt policy                                                       */
/* ------------------------------------------------------------------ */

export interface RegretPromptPolicyOptions {
  /** Default 2 prompts per rolling 7 days. */
  readonly maxPerWeek?: number;
  /** Earliest ask after the purchase. Default 24 h. */
  readonly minDelayHours?: number;
  /** Latest ask after the purchase; older purchases are never asked about. Default 72 h. */
  readonly maxDelayHours?: number;
  /** Segments whose information value is below this are not asked about. Default 0.1. */
  readonly minInformationValue?: number;
  /** Minimum gap between two regret prompts. Default 24 h. */
  readonly minGapHours?: number;
  /** Preferred local hour to ask. Default 19 (early evening, outside work and sleep). */
  readonly askHour?: number;
  /** Default 22:00–08:00; `null` disables. */
  readonly quietHours?: QuietHours | null;
  /**
   * The user's IANA time zone, for the ask time and the weekday in the prompt.
   * `RegretPromptContext` has no time zone, so the policy is configured with it. Default "UTC".
   */
  readonly timeZone?: string;
}

/** Why no regret prompt was planned. */
export type RegretPromptBlocker =
  | "opted_out"
  | "refunded"
  | "not_completed"
  | "not_a_purchase"
  | "low_confidence"
  | "already_answered"
  | "recurring"
  | "sensitive"
  | "essential"
  | "not_personal"
  | "small_amount"
  | "weekly_cap"
  | "low_information"
  | "sampled_out"
  | "no_slot";

export type RegretPromptOutcome =
  | { readonly plan: RegretPromptPlan; readonly samplingProbability: number }
  | { readonly plan: null; readonly blockedBy: RegretPromptBlocker };

export interface ExplainedRegretPromptPolicy extends RegretPromptPolicy {
  /** Same decision as `plan`, with the reason when no prompt is planned and the sampling propensity when one is. */
  explain(candidate: TransactionCandidate, ctx: RegretPromptContext): RegretPromptOutcome;
}

/** Never "still happy you bought it?" about these (docs/research/09 §4.4: medical, donations). */
const SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set(["health", "donations"]);
/**
 * Bought for someone else: whether the recipient liked it is not this
 * user's regret, so it would distort the personal model (docs/research/09 §4.6).
 */
const NOT_PERSONAL_CATEGORIES: ReadonlySet<string> = new Set(["gifts"]);
/** Obligations, not choices: regret is not a useful question. */
const OBLIGATION_CATEGORIES: ReadonlySet<string> = new Set(["bills", "housing", "taxes", "fees"]);
/** Experiences are asked about early, while action regret is fresh; goods after they have arrived and been used. */
const EXPERIENTIAL_CATEGORIES: ReadonlySet<string> = new Set(["eating_out", "entertainment", "travel", "transport", "personal_care"]);
/** A purchase BRAKE is not sure happened (or is the user's) is never asked about. */
const MIN_CANDIDATE_CONFIDENCE = 0.8;
/** Asking about a transfer as if it were a purchase destroys trust: require a confident purchase type. */
const MIN_PURCHASE_CONFIDENCE = 0.7;

/** A sensitive category at least this likely (as the guess or an alternative) blocks the prompt. */
const SENSITIVE_PROBABILITY = 0.25;

/**
 * True when the purchase may well be sensitive, not only when that is the top
 * guess: a pharmacy bill read as "personal care 55% / medical 35%" must not
 * get a "still happy you bought it?".
 */
function maybeSensitive(c: TransactionCandidate): boolean {
  const cat = c.category;
  if (cat.userSet) return SENSITIVE_CATEGORIES.has(topLevelCategory(cat.value));
  let p = SENSITIVE_CATEGORIES.has(topLevelCategory(cat.value)) ? Math.max(cat.confidence, SENSITIVE_PROBABILITY) : 0;
  for (const alt of cat.alternatives) if (SENSITIVE_CATEGORIES.has(topLevelCategory(alt.value))) p += alt.probability;
  return p >= SENSITIVE_PROBABILITY;
}

function isRecurring(c: TransactionCandidate): boolean {
  const t = c.attributes.temporalType;
  if (trusted(t) && (t.value === "recurring" || t.value === "subscription")) return true;
  if (trusted(c.attributes.intent) && c.attributes.intent.value === "recurring") return true;
  return c.links.some((l) => l.kind === "recurring_series" && l.probability >= 0.5);
}

function eligibility(c: TransactionCandidate, ctx: RegretPromptContext): RegretPromptBlocker | null {
  if (ctx.userOptedOut) return "opted_out";
  if (c.status === "refunded" || c.links.some((l) => l.kind === "refunded_by" && l.probability >= 0.5)) return "refunded";
  if (c.status !== "confirmed" && c.status !== "posted") return "not_completed";
  const type = c.transactionType;
  if (c.direction !== "debit" || type.value !== "purchase" || !(type.userSet || type.confidence >= MIN_PURCHASE_CONFIDENCE)) {
    return "not_a_purchase";
  }
  if (!c.amount || c.confidence < MIN_CANDIDATE_CONFIDENCE) return "low_confidence";
  if (c.attributes.satisfaction) return "already_answered";
  if (isRecurring(c)) return "recurring";
  const top = topLevelCategory(c.category.value);
  if (maybeSensitive(c)) return "sensitive";
  const e = c.attributes.essentiality;
  const discretionary = (e.value === "discretionary" || e.value === "semi_discretionary") && trusted(e);
  if (OBLIGATION_CATEGORIES.has(top) || !discretionary) return "essential";
  const own = c.attributes.ownership;
  if ((own.value === "business" || own.value === "reimbursable" || own.value === "shared") && trusted(own)) return "not_personal";
  if (NOT_PERSONAL_CATEGORIES.has(top)) return "not_personal";
  if (ctx.features.amountBand === "small") return "small_amount";
  return null;
}

interface Timing {
  readonly timeZone: string;
  readonly askHour: number;
  readonly quietHours: QuietHours | null;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly minGapMs: number;
}

/** The ask hour, moved to just before quiet hours if it falls inside them. */
function effectiveAskHour(askHour: number, quiet: QuietHours | null): number | null {
  if (!isQuietHour(askHour, quiet)) return askHour;
  const before = quiet ? (quiet.from + 23) % 24 : askHour;
  return isQuietHour(before, quiet) ? null : before;
}

/** Upper bound on days searched for a slot, so an unbounded window can never loop forever. */
const MAX_SLOT_SEARCH_DAYS = 366;

/** The first local `hour`:00 in [earliest, latest] that is outside quiet hours, or null. */
function firstLocalSlot(earliest: EpochMillis, latest: EpochMillis, hour: number, t: Timing): EpochMillis | null {
  const start = localParts(earliest, t.timeZone);
  const days = Math.min(Math.ceil((latest - earliest) / DAY) + 1, MAX_SLOT_SEARCH_DAYS);
  for (let i = 0; i <= days; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const at = zonedTimeToEpoch(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute: 0, second: 0 },
      t.timeZone,
    );
    if (at > latest) return null;
    if (at >= earliest && !isQuietHour(localParts(at, t.timeZone).hour, t.quietHours)) return at;
  }
  return null;
}

/**
 * The first ~19:00 local slot inside the window that respects quiet hours and
 * the gap since the last prompt. Experiences start the search at the minimum
 * delay; goods a day later, after they have usually arrived.
 */
function askTime(c: TransactionCandidate, ctx: RegretPromptContext, t: Timing): EpochMillis | null {
  const purchasedAt = c.timestampEstimated;
  const experiential = EXPERIENTIAL_CATEGORIES.has(topLevelCategory(c.category.value));
  const preferredDelay = experiential ? t.minDelayMs : Math.min(t.maxDelayMs, t.minDelayMs + DAY);
  const latest = purchasedAt + t.maxDelayMs;
  const gapFloor = ctx.lastPromptAt === null ? Number.NEGATIVE_INFINITY : ctx.lastPromptAt + t.minGapMs;
  const earliest = Math.max(purchasedAt + preferredDelay, ctx.now, gapFloor);
  if (earliest > latest) return null;

  const hour = effectiveAskHour(t.askHour, t.quietHours);
  const evening = hour === null ? null : firstLocalSlot(earliest, latest, hour, t);
  if (evening !== null) return evening;
  // Late planning (e.g. the ledger posted days after the purchase): ask as soon as allowed…
  if (!isQuietHour(localParts(earliest, t.timeZone).hour, t.quietHours)) return earliest;
  // …and when that moment is inside quiet hours, when they end, if the window is still open.
  return t.quietHours ? firstLocalSlot(earliest, latest, t.quietHours.to, t) : null;
}

/** "That ₹6,200 purchase from Saturday — still happy you bought it?" */
export function regretPromptText(c: TransactionCandidate, askAt: EpochMillis, locale: LocaleTag, timeZone: string): string {
  const purchasedAt = new Date(c.timestampEstimated);
  const when =
    askAt - c.timestampEstimated > 6 * DAY
      ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone }).format(purchasedAt)
      : new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(purchasedAt);
  if (!c.amount) return `That purchase from ${when} — still happy you bought it?`;
  const amount = formatMoney(c.amount.value, locale);
  // Never state an estimated amount flatly.
  const approximate = c.amount.approximate === true || c.amount.confidence < 0.85;
  const what = approximate ? `purchase of about ${amount}` : `${amount} purchase`;
  return `That ${what} from ${when} — still happy you bought it?`;
}

/**
 * Plan at most a few retrospective "still happy you bought it?" prompts.
 *
 * Asks only about confirmed/posted, personal, discretionary purchases of at
 * least a typical size, under a weekly cap, at least a day apart, and only
 * while the purchase's segment is still uncertain. Selection among eligible
 * purchases is a deterministic draw from the candidate id with probability
 * equal to the information value, so well-understood kinds of purchase are
 * asked about less and less, then not at all.
 */
export function createRegretPromptPolicy(opts: RegretPromptPolicyOptions = {}): ExplainedRegretPromptPolicy {
  const maxPerWeek = opts.maxPerWeek ?? 2;
  const minInformationValue = opts.minInformationValue ?? 0.1;
  const timing: Timing = {
    timeZone: opts.timeZone ?? "UTC",
    askHour: opts.askHour ?? 19,
    quietHours: opts.quietHours === undefined ? DEFAULT_QUIET_HOURS : opts.quietHours,
    minDelayMs: (opts.minDelayHours ?? 24) * HOUR,
    maxDelayMs: (opts.maxDelayHours ?? 72) * HOUR,
    minGapMs: (opts.minGapHours ?? 24) * HOUR,
  };

  function explain(c: TransactionCandidate, ctx: RegretPromptContext): RegretPromptOutcome {
    const blocked = (blockedBy: RegretPromptBlocker): RegretPromptOutcome => ({ plan: null, blockedBy });
    const ineligible = eligibility(c, ctx);
    if (ineligible) return blocked(ineligible);
    if (ctx.promptsLast7Days >= maxPerWeek) return blocked("weekly_cap");

    const value = regretInformationValue(ctx.model.estimate(ctx.features));
    if (value < minInformationValue) return blocked("low_information");
    const samplingProbability = regretSamplingProbability(value);
    if (stableUnit(c.id) >= samplingProbability) return blocked("sampled_out");

    const askAt = askTime(c, ctx, timing);
    if (askAt === null) return blocked("no_slot");
    return {
      plan: { askAt, prompt: regretPromptText(c, askAt, ctx.locale, timing.timeZone), options: SATISFACTION_OPTIONS, value },
      samplingProbability,
    };
  }

  return {
    explain,
    plan: (c, ctx) => explain(c, ctx).plan,
  };
}
