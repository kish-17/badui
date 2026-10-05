/**
 * Recurring & subscription intelligence.
 *
 * Finds charges that repeat on a calendar rhythm (subscriptions, bills, rent,
 * habits) in fused transaction candidates, and strengthens them with
 * context-only observations: renewal notices, trial emails, price-change
 * notices, cancellations and payment mandates.
 *
 * It reasons only on normalized fields: merchant key, amount, ISO 4217
 * currency, time, instrument last4, ISO 18245 MCC, BRAKE category,
 * observation kinds and subscription-event semantics. It never looks at which
 * provider, adapter, country or OS produced the evidence, so the same
 * Netflix-on-a-card, Spotify-via-UPI-AutoPay and rent-via-Pix histories are
 * read the same way.
 *
 * Pipeline for each (merchant key, currency) group:
 *  1. Partition by instrument only when two cards/accounts bill
 *     *concurrently* (two Netflix accounts). Never partition on a card
 *     replacement: a subscription that moves to a new card stays one series.
 *  2. Split into tight amount clusters (7.5% running level, as in the
 *     open-source engines surveyed in docs/research/10, §E10), so two plans
 *     at one merchant stay apart. Then re-join clusters that follow each
 *     other in time and keep the cadence: drift ≤ 25%, larger price steps
 *     once the new price has repeated, and intro/trial prices.
 *  3. Fit a cadence from the median interval with per-cadence tolerance
 *     (calendar-month aware: billing day ±3, month-end clamping). Accept a
 *     series once it has enough occurrences, needing fewer when a merchant
 *     notice, mandate or subscription reference corroborates it.
 *  4. Whatever is left is tried as one variable-amount sequence (utility
 *     bills, weekly groceries): recurring, but rarely a subscription.
 *
 * Every output keeps its uncertainty. Series carry `confidence` and
 * `subscriptionProbability`. Patches are Inference distributions with basis
 * "recurrence", and they never overwrite anything the user set.
 */
import { DAY, clamp01, formatMoney, localParts, money, stableId, unknownInference, zonedTimeToEpoch } from "@brake/core";
import type {
  CandidateId,
  CandidateLink,
  CandidatePatch,
  CategoryId,
  EpochMillis,
  Inference,
  InferenceBasis,
  LocaleTag,
  Money,
  Observation,
  ObservationKind,
  Probability,
  Reference,
  TemporalType,
  TransactionCandidate,
  TransactionType,
} from "@brake/core";
import type { Cadence, RecurringAlert, RecurringDetector, RecurringFindings, RecurringSeries } from "./contracts";
import { confidenceTier } from "./copy";
import { isLikelyDuplicate } from "./spending";
import { topLevelCategory } from "./taxonomy";

/* ------------------------------------------------------------------ */
/* The brief's open question                                           */
/* ------------------------------------------------------------------ */

/**
 * The brief asks whether subscription intelligence belongs in the initial
 * product or later.
 *
 * Recommendation: split it. The passive core goes into the initial product.
 * Proactive subscription management follows once its value has been
 * measured. This follows docs/research/10-reconciliation-transfers-recurring.md
 * (§E10, §E11):
 *
 * Initial product:
 *  - Recurring-series detection and passive labelling (temporalType and the
 *    "subscription" type). BRAKE needs these anyway to read spending
 *    correctly: fixed costs stay out of discretionary pace, and "upcoming
 *    known bills" and payday proximity depend on them. They need no new
 *    sensor, so they work from any transaction source, manual entry included.
 *  - Renewals that the merchant or bank has stated (e-mandate pre-debit
 *    notices, renewal emails). These arrive before the money moves, with an
 *    exact date and amount. That makes "Netflix renews tomorrow for $22.99.
 *    Keep or review?" possible without guessing.
 *
 * Next:
 *  - Predicted-renewal nudges, trial conversions, price increases and
 *    new-subscription notices. They are implemented here behind confidence
 *    gates, but they lean on email and mandate signals. False alarms erode
 *    trust, and BRAKE's differentiator is the spending decision, not
 *    subscription management.
 *
 * Later, and only as a question:
 *  - Duplicate and dormant detection. Family plans and app-store billing
 *    blur duplicates. BRAKE cannot see usage, so dormancy can only be asked
 *    about ("Still using it?"), never stated.
 *
 * Measure which alerts actually change decisions before promoting them
 * (research open question 10).
 */
export const SUBSCRIPTION_INTELLIGENCE_RECOMMENDATION = {
  initialProduct: ["series_detection", "passive_labels", "upcoming_known_bills", "stated_renewals"],
  next: ["upcoming_renewal", "trial_conversion", "price_increase", "new_subscription"],
  later: ["duplicate_subscription", "dormant_subscription"],
} as const;

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface RecurringDetectorOptions {
  /** IANA zone for calendar arithmetic (billing day of month, month lengths). Default "UTC". */
  readonly timeZone?: string;
  /** A predicted renewal at most this many days away raises `upcoming_renewal`. Default 3. */
  readonly renewalLeadDays?: number;
  /** Relative rise over the previous price that counts as a price increase. Default 0.02. */
  readonly priceIncreaseThreshold?: number;
  /**
   * Relative difference within which a charge joins an amount cluster (compared
   * with the cluster's latest amount, so slow price creep stays together).
   * Default 0.075. Kept tight so two plans at one merchant stay apart.
   */
  readonly amountTolerance?: number;
  /** A price step up to this relative size continues a series right away. Larger steps (≤ 2×) must repeat first. Default 0.25. */
  readonly maxDrift?: number;
  /** Series below this confidence are not reported. Default 0.5. */
  readonly minConfidence?: Probability;
  /** subscriptionProbability from which a series counts as a subscription for alerts. Default 0.6. */
  readonly subscriptionThreshold?: Probability;
  /** subscriptionProbability from which members' transaction type may become "subscription". Default 0.7. */
  readonly typePatchThreshold?: Probability;
}

type Settings = Required<RecurringDetectorOptions>;

const DEFAULTS: Settings = {
  timeZone: "UTC",
  renewalLeadDays: 3,
  priceIncreaseThreshold: 0.02,
  amountTolerance: 0.075,
  maxDrift: 0.25,
  minConfidence: 0.5,
  subscriptionThreshold: 0.6,
  typePatchThreshold: 0.7,
};

/* ------------------------------------------------------------------ */
/* Cadences                                                            */
/* ------------------------------------------------------------------ */

type RegularCadence = Exclude<Cadence, "irregular">;

interface CadenceSpec {
  readonly cadence: RegularCadence;
  /** Nominal period, reported as `RecurringSeries.periodDays` for calendar-aligned series. */
  readonly periodDays: number;
  /** Average calendar length of one period, for intervals measured in days. */
  readonly meanDays: number;
  /** Calendar months per period; 0 for cadences counted in days. */
  readonly months: number;
  /** Accepted median interval in days. */
  readonly band: readonly [number, number];
  /** Plausible single-period intervals, used to estimate a day-count cycle (a 28-day plan). */
  readonly intervalBand: readonly [number, number];
  /** Deviation (days) that still counts as on time. Also caps the series' median absolute deviation. */
  readonly toleranceDays: number;
}

const CADENCE_SPECS: readonly CadenceSpec[] = [
  { cadence: "weekly", periodDays: 7, meanDays: 7, months: 0, band: [5, 9], intervalBand: [5, 9], toleranceDays: 2 },
  { cadence: "biweekly", periodDays: 14, meanDays: 14, months: 0, band: [11, 17], intervalBand: [11, 17], toleranceDays: 3 },
  { cadence: "monthly", periodDays: 30, meanDays: 30.44, months: 1, band: [28, 33], intervalBand: [27, 34], toleranceDays: 3 },
  { cadence: "quarterly", periodDays: 91, meanDays: 91.31, months: 3, band: [85, 98], intervalBand: [85, 98], toleranceDays: 6 },
  { cadence: "semiannual", periodDays: 182, meanDays: 182.62, months: 6, band: [175, 190], intervalBand: [175, 190], toleranceDays: 8 },
  { cadence: "annual", periodDays: 365, meanDays: 365.25, months: 12, band: [350, 380], intervalBand: [350, 380], toleranceDays: 15 },
];

/** Billing day may drift this many days from the anchor (weekends, holidays, posting lag). */
const CALENDAR_TOLERANCE_DAYS = 3;
/** Charges closer than this are one occurrence (a retry, a split charge) for cadence purposes. */
const SAME_OCCURRENCE_MS = 2 * DAY;
/** Stray removal is for small fixed-price clusters; large clusters are habits and are not searched. */
const MAX_PRUNE_CLUSTER = 24;

interface Fit {
  readonly spec: CadenceSpec;
  /** Median absolute deviation in days (intervals, or billing-day offsets); null when the cadence came from context. */
  readonly madDays: number | null;
  /** Share of intervals that skipped a period (a missed observation). */
  readonly gappedFraction: number;
  /** Charges follow the calendar (same billing day each month), so predictions use calendar months. */
  readonly calendar: boolean;
  /** Days per period: nominal for calendar series, observed for day-count cycles (a 28-day plan). */
  readonly periodDays: number;
  /** Per interval between collapsed occurrences: on rhythm or not. Empty for context-derived fits. */
  readonly onRhythm: readonly boolean[];
}

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function medianAbsoluteDeviation(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

function coefficientOfVariation(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

/** |a-b| / max(a,b); 0 when both are zero. */
function relDiff(a: number, b: number): number {
  const max = Math.max(a, b);
  return max === 0 ? 0 : Math.abs(a - b) / max;
}

function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function maxOrNull(xs: readonly number[]): number | null {
  return xs.length ? Math.max(...xs) : null;
}

function minOrNull(xs: readonly number[]): number | null {
  return xs.length ? Math.min(...xs) : null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Days since the epoch of a calendar date (zone-free day arithmetic). */
function dayNumber(d: CalendarDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY);
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/** The date a bill anchored on `anchor` falls on in a month: the 31st becomes Feb 28/29, Apr 30… */
function anchoredDate(monthIdx: number, anchor: number): CalendarDate {
  const year = Math.floor(monthIdx / 12);
  const month = monthIdx - year * 12 + 1;
  return { year, month, day: Math.min(anchor, daysInMonth(year, month)) };
}

/** The billing month a date belongs to (the nearest anchored date) and its offset from it in days. */
function nearestAnchor(d: CalendarDate, anchor: number): { readonly monthIdx: number; readonly offset: number } {
  const base = monthIndex(d.year, d.month);
  let best = { monthIdx: base, offset: Number.POSITIVE_INFINITY };
  for (const m of [base - 1, base, base + 1]) {
    const offset = dayNumber(d) - dayNumber(anchoredDate(m, anchor));
    if (Math.abs(offset) < Math.abs(best.offset)) best = { monthIdx: m, offset };
  }
  return best;
}

function consistentWithAnchor(d: CalendarDate, anchor: number): boolean {
  return d.day === Math.min(anchor, daysInMonth(d.year, d.month));
}

/**
 * The day of month a series bills on: the day that keeps the most charges
 * within ±3 days, then the one most charges fall on exactly, then the one
 * with the smallest spread, then one the latest charge falls on. Exact
 * matches alone are not enough: when no two charges share a day (10th, 13th,
 * 8th, 12th) the anchor must still be central, not the latest charge's day.
 * A charge on the last day of a short month is consistent with any later
 * anchor (Feb 28 may be "the 31st").
 */
function anchorDayOf(dates: readonly CalendarDate[]): number {
  const latest = dates[dates.length - 1];
  if (!latest) return 1;
  // Month lengths around each date, so the 31 × n offsets below are plain arithmetic.
  const around = dates.map((d) => ({
    day: d.day,
    len: daysInMonth(d.year, d.month),
    prevLen: daysInMonth(d.month === 1 ? d.year - 1 : d.year, d.month === 1 ? 12 : d.month - 1),
    nextLen: daysInMonth(d.month === 12 ? d.year + 1 : d.year, d.month === 12 ? 1 : d.month + 1),
  }));
  let best = latest.day;
  let bestScore: readonly number[] = [-1];
  for (let a = 1; a <= 31; a++) {
    let within = 0;
    let exact = 0;
    let spread = 0;
    for (const d of around) {
      // Distance to the anchored day in the previous, same or next month (as nearestAnchor).
      const off = Math.min(
        Math.abs(d.day + d.prevLen - Math.min(a, d.prevLen)),
        Math.abs(d.day - Math.min(a, d.len)),
        Math.abs(d.len - d.day + Math.min(a, d.nextLen)),
      );
      if (off <= CALENDAR_TOLERANCE_DAYS) within++;
      if (off === 0) exact++;
      spread += Math.min(off, CALENDAR_TOLERANCE_DAYS + 1);
    }
    const score = [within, exact, -spread, consistentWithAnchor(latest, a) ? 1 : 0];
    if (compareScores(score, bestScore) > 0) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The billing day to predict from. Usually the series' anchor, but when the
 * last two charges both moved well away from it and agree with each other,
 * the merchant changed the billing date (plan change, card update, failed
 * payment retried): the new day wins over the historical majority.
 */
function currentBillingDay(dates: readonly CalendarDate[]): number {
  const overall = anchorDayOf(dates);
  const recent = dates.slice(-2);
  if (dates.length < 3) return overall;
  const moved = recent.every((d) => Math.abs(nearestAnchor(d, overall).offset) > CALENDAR_TOLERANCE_DAYS);
  if (!moved) return overall;
  const day = anchorDayOf(recent);
  return recent.every((d) => Math.abs(nearestAnchor(d, day).offset) <= CALENDAR_TOLERANCE_DAYS) ? day : overall;
}

/**
 * Calendar-month arithmetic for billing dates. Adds `months` to the billing
 * month of `at` and lands on `anchorDay`, clamped to the month's length:
 * anchored on the 31st, Jan 31 → Feb 28 → Mar 31. Keeps the local time of day.
 */
export function addMonthsAnchored(at: EpochMillis, months: number, anchorDay: number, timeZone = "UTC"): EpochMillis {
  const p = localParts(at, timeZone);
  const { monthIdx } = nearestAnchor(p, anchorDay);
  const target = anchoredDate(monthIdx + months, anchorDay);
  return zonedTimeToEpoch({ ...target, hour: p.hour, minute: p.minute, second: p.second }, timeZone);
}

/* ------------------------------------------------------------------ */
/* Cadence fitting                                                     */
/* ------------------------------------------------------------------ */

type DateOf = (t: EpochMillis) => CalendarDate;

function collapseOccurrences(times: readonly EpochMillis[]): EpochMillis[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: EpochMillis[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || t - last >= SAME_OCCURRENCE_MS) out.push(t);
  }
  return out;
}

/**
 * Short histories must be entirely on rhythm (one missed observation
 * allowed). Longer ones may have one imperfect interval in four, counting
 * off-rhythm and skipped periods together. Research §E10 accepts a period
 * when ≥ 75% of gaps fit it.
 */
function enoughOnRhythm(ok: number, gapped: number, total: number): boolean {
  if (total <= 3) return ok === total && gapped <= 1;
  return ok / total >= 0.75 && total - ok + gapped <= Math.max(1, Math.floor(0.25 * total));
}

/**
 * How many periods an interval spans: 1, or 2 (one missed observation, given
 * a little more room), or 0 when it is off rhythm. Skipping a period is only
 * accepted with at least three occurrences, because a lone 60-day gap is just
 * as likely to be a bi-monthly bill. Never more than one missed period: with
 * k up to 3, almost any interval of 25–110 days would look "monthly".
 */
function periodsSpanned(spec: CadenceSpec, days: number, period: number, occurrences: number): 0 | 1 | 2 {
  if (Math.abs(days - period) <= spec.toleranceDays) return 1;
  if (occurrences >= 3 && Math.abs(days - 2 * period) <= 1.5 * spec.toleranceDays) return 2;
  return 0;
}

/** Weekly and biweekly: counted in days around the nominal period (7±2, 14±3). */
function fitByDays(spec: CadenceSpec, occ: readonly EpochMillis[], intervals: readonly number[]): Fit | null {
  const med = median(intervals);
  if (med < spec.band[0] || med > spec.band[1]) return null;
  const norms: number[] = [];
  const onRhythm: boolean[] = [];
  let gapped = 0;
  for (const d of intervals) {
    const k = periodsSpanned(spec, d, spec.periodDays, occ.length);
    onRhythm.push(k > 0);
    if (k === 0) continue;
    norms.push(d / k);
    if (k > 1) gapped++;
  }
  if (!enoughOnRhythm(norms.length, gapped, intervals.length)) return null;
  const madDays = medianAbsoluteDeviation(norms);
  if (madDays > spec.toleranceDays) return null;
  return { spec, madDays, gappedFraction: gapped / intervals.length, calendar: false, periodDays: spec.periodDays, onRhythm };
}

/**
 * Calendar cadences (monthly and longer). Two readings are fitted:
 *  - on the calendar: an interval is on rhythm when both charges sit within
 *    ±3 days of the anchored billing day (month-length aware) and one or two
 *    periods apart. An off-anchor interval can still count when it is one
 *    cycle long in days (a charge posted late);
 *  - by day count: intervals measured against the series' own cycle, which
 *    covers 28- or 30-day plans that drift against the calendar.
 * The calendar reading wins unless the day count fits clearly tighter. Bills
 * land on a billing day, and their intervals vary with month lengths and
 * weekends, so a day count is only the better story for a drifting cycle.
 */
function fitByCalendar(spec: CadenceSpec, occ: readonly EpochMillis[], intervals: readonly number[], dateOf: DateOf): Fit | null {
  const med = median(intervals);
  // Cheap rejection: a daily habit or a multi-year gap cannot be this cadence.
  if (med < spec.band[0] * 0.5 || med > spec.band[1] * 2.5) return null;
  const singles = intervals.filter((d) => d >= spec.intervalBand[0] && d <= spec.intervalBand[1]);
  const cycle = singles.length ? median(singles) : spec.meanDays;
  const onCalendar = calendarReading(spec, occ, intervals, occ.map(dateOf), cycle);
  const byDays = dayCountReading(spec, occ, intervals, cycle);
  if (onCalendar && byDays) return byDays.madDays! + 1 < onCalendar.madDays! ? byDays : onCalendar;
  return onCalendar ?? byDays;
}

function calendarReading(spec: CadenceSpec, occ: readonly EpochMillis[], intervals: readonly number[], dates: readonly CalendarDate[], cycle: number): Fit | null {
  const anchor = anchorDayOf(dates);
  const near = dates.map((d) => nearestAnchor(d, anchor));
  const steps: number[] = [];
  const onRhythm: boolean[] = [];
  let aligned = 0;
  let gapped = 0;
  for (let i = 0; i < intervals.length; i++) {
    const a = near[i]!;
    const b = near[i + 1]!;
    const step = (b.monthIdx - a.monthIdx) / spec.months;
    const onAnchor =
      Math.abs(a.offset) <= CALENDAR_TOLERANCE_DAYS &&
      Math.abs(b.offset) <= CALENDAR_TOLERANCE_DAYS &&
      (step === 1 || (step === 2 && occ.length >= 3));
    const k = onAnchor ? step : periodsSpanned(spec, intervals[i]!, cycle, occ.length);
    onRhythm.push(k > 0);
    if (k === 0) continue;
    if (onAnchor) aligned++;
    steps.push(k);
    if (k > 1) gapped++;
  }
  if (!enoughOnRhythm(steps.length, gapped, intervals.length) || median(steps) !== 1) return null;
  // Most intervals must actually land on the billing day; otherwise this is a day count.
  if (aligned * 2 < steps.length) return null;
  const madDays = medianAbsoluteDeviation(near.map((n) => n.offset));
  if (madDays > spec.toleranceDays) return null;
  return { spec, madDays, gappedFraction: gapped / intervals.length, calendar: true, periodDays: spec.periodDays, onRhythm };
}

function dayCountReading(spec: CadenceSpec, occ: readonly EpochMillis[], intervals: readonly number[], cycle: number): Fit | null {
  // A cycle counted in days must itself be this cadence (monthly: 28–33 days).
  if (cycle < spec.band[0] || cycle > spec.band[1]) return null;
  const steps: number[] = [];
  const norms: number[] = [];
  const onRhythm: boolean[] = [];
  let gapped = 0;
  for (const days of intervals) {
    const k = periodsSpanned(spec, days, cycle, occ.length);
    onRhythm.push(k > 0);
    if (k === 0) continue;
    steps.push(k);
    norms.push(days / k);
    if (k > 1) gapped++;
  }
  if (!enoughOnRhythm(steps.length, gapped, intervals.length) || median(steps) !== 1) return null;
  const madDays = medianAbsoluteDeviation(norms);
  if (madDays > spec.toleranceDays) return null;
  return { spec, madDays, gappedFraction: gapped / intervals.length, calendar: false, periodDays: Math.round(cycle), onRhythm };
}

/**
 * Drop members at either end that are joined to the series only by an
 * off-rhythm interval. A purchase months before a run of weekly charges is
 * not its first occurrence. Breaks inside a series (a pause) are kept.
 */
function trimOffRhythmEnds(members: readonly Member[], fit: Fit): Member[] {
  const occ = collapseOccurrences(timesOf(members));
  const first = fit.onRhythm.indexOf(true);
  const last = fit.onRhythm.lastIndexOf(true);
  if (first < 0 || (first === 0 && last === fit.onRhythm.length - 1)) return [...members];
  const from = occ[first]!;
  const to = occ[last + 1]! + SAME_OCCURRENCE_MS;
  return members.filter((m) => m.at >= from && m.at < to);
}

function fitObserved(times: readonly EpochMillis[], dateOf: DateOf): Fit | null {
  const occ = collapseOccurrences(times);
  if (occ.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < occ.length; i++) intervals.push((occ[i]! - occ[i - 1]!) / DAY);
  for (const spec of CADENCE_SPECS) {
    const fit = spec.months > 0 ? fitByCalendar(spec, occ, intervals, dateOf) : fitByDays(spec, occ, intervals);
    if (fit) return fit;
  }
  return null;
}

function specForDays(days: number): CadenceSpec | null {
  return CADENCE_SPECS.find((s) => days >= s.band[0] && days <= s.band[1]) ?? null;
}

/** ISO 8601 duration ("P1M", "P1Y", "P12M", "P7D", "P2W") → cadence. */
function specForPeriod(iso: string): CadenceSpec | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/i.exec(iso.trim());
  if (!m) return null;
  const months = Number(m[1] ?? 0) * 12 + Number(m[2] ?? 0);
  const days = Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0);
  if (months > 0 && days === 0) return CADENCE_SPECS.find((s) => s.months === months) ?? null;
  if (days > 0 && months === 0) return specForDays(days);
  return null;
}

/**
 * The cadence of a list of charge times, or "irregular". Exposed for other
 * modules (insights, interventions) that need the same notion of rhythm.
 */
export function classifyCadence(times: readonly EpochMillis[], timeZone = "UTC"): Cadence {
  const fit = fitObserved(times, (t) => calendarDateIn(t, timeZone));
  return fit ? fit.spec.cadence : "irregular";
}

function calendarDateIn(t: EpochMillis, timeZone: string): CalendarDate {
  const p = localParts(t, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/* ------------------------------------------------------------------ */
/* Merchant keys                                                       */
/* ------------------------------------------------------------------ */

/**
 * Descriptor words that carry no merchant identity: payment mechanics, legal
 * forms and processor filler. They are multi-rail and multi-country on purpose.
 */
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  "pos", "upi", "pix", "sepa", "ach", "nach", "ecs", "imps", "neft", "rtgs", "si", "dd",
  "debit", "dr", "purchase", "payment", "pymt", "pmt", "recurring", "autopay", "auto", "mandate",
  "card", "txn", "trx", "ref", "via", "online", "www", "http", "https", "com", "net", "org",
  "inc", "ltd", "llc", "llp", "pvt", "plc", "gmbh", "bv", "sa", "sas", "ltda", "corp", "co",
  "mktp", "intl", "billing", "bill", "the",
]);

/**
 * Words that join a name ("Bank of America", "Café de Flore"). Inside a name
 * they do not count towards the two-token cap, so "City of Austin" and
 * "City of Chicago" stay apart instead of both becoming "city of".
 */
const CONNECTOR_TOKENS: ReadonlySet<string> = new Set(["of", "de", "del", "da", "do", "dos", "das", "du", "des", "der", "di", "von", "van", "and", "y", "e", "et", "und"]);

/** Store numbers, phone numbers, order and reference codes ("2K4L9", "866-579-7172"). */
function isReferenceToken(t: string): boolean {
  const digits = t.replace(/\D/g, "").length;
  return digits >= 3 || (digits >= 2 && t.length >= 4);
}

const TOKEN_SPLIT = /[^\p{L}\p{M}\p{N}]+/u;

/**
 * A payment handle on its own ("q123456789@ybl", "••••3210@ybl",
 * "paytmqr28100505@paytm", a Pix e-mail key). The part after "@" names the
 * payment provider, not the payee, so token cleaning would collapse every
 * payee of one provider into a single key. The whole handle is the identity.
 */
const PAYMENT_HANDLE = /^[^\s@/*]+@[\p{L}][\p{L}\p{N}.-]*$/u;

function keyTokens(key: string): string[] {
  return key.split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

/**
 * Turn a raw descriptor into a grouping key: "NETFLIX.COM 866-579-7172 CA" →
 * "netflix", "SQ *BLUE BOTTLE COFFEE" → "blue bottle". This is only a
 * fallback for candidates the merchant normalizer has not resolved. It keeps
 * non-Latin scripts and caps the key at two tokens, so store and city
 * suffixes do not split a merchant.
 */
export function cleanMerchantDescriptor(raw: string): string | null {
  let s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (PAYMENT_HANDLE.test(s.trim())) return s.trim();
  const star = s.indexOf("*");
  if (star >= 0) {
    const before = s.slice(0, star).trim();
    const after = s.slice(star + 1).trim();
    // "SQ *SHOP": a short code before '*' names the payment facilitator; "AMZN MKTP US*2K4L": a long one is the merchant.
    const facilitatorPrefix = before.replace(/[^\p{L}]/gu, "").length <= 3;
    s = (facilitatorPrefix ? after : before) || after || before;
  }
  s = s.replace(/https?:\/\//g, " ").replace(/\.[a-z]{2,3}(?:\.[a-z]{2})?(?=[^\p{L}\p{N}]|$)/gu, " ");
  let tokens = keyTokens(s).filter((t) => !isReferenceToken(t) && !NOISE_TOKENS.has(t));
  // Trailing state/country codes ("CA", "US", "IN") say where, not who.
  while (tokens.length > 1 && tokens[tokens.length - 1]!.length <= 2) tokens = tokens.slice(0, -1);
  if (tokens.length === 0) return null;
  // Two name tokens; a connector after the first token joins them without counting.
  const kept: string[] = [];
  let counted = 0;
  for (const t of tokens) {
    const joins = kept.length > 0 && CONNECTOR_TOKENS.has(t);
    if (!joins && counted === 2) break;
    kept.push(t);
    if (!joins) counted++;
  }
  while (kept.length > 1 && CONNECTOR_TOKENS.has(kept[kept.length - 1]!)) kept.pop();
  return kept.join(" ");
}

/**
 * Per-candidate grouping key. Uses `merchant.normalized` when present, else
 * the cleaned raw descriptor or display name, else the counterparty (rent to
 * a landlord, a P2P standing payment), else a payment handle.
 */
export function recurringMerchantKey(c: TransactionCandidate): string | null {
  const normalized = c.merchant.normalized?.trim().toLowerCase();
  if (normalized) return normalized;
  for (const text of [c.merchant.raw, c.merchant.displayName, c.counterparty?.name]) {
    if (!text) continue;
    const key = cleanMerchantDescriptor(text);
    if (key) return key;
  }
  const handle = c.merchant.handle ?? c.counterparty?.handle;
  return handle ? handle.trim().toLowerCase() : null;
}

function isTokenPrefix(short: readonly string[], long: readonly string[]): boolean {
  return short.length < long.length && short.every((t, i) => long[i] === t);
}

/** Same merchant when keys are equal or one key's tokens start the other's ("amazon" ~ "amazon prime"). */
function keysMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = keyTokens(a);
  const tb = keyTokens(b);
  return isTokenPrefix(ta, tb) || isTokenPrefix(tb, ta);
}

/**
 * Resolves cleaned keys onto keys that other candidates already use, so
 * "netflix entertainment" (unnormalized) joins "netflix" (normalized). The
 * normalizer's keys win. Among cleaned keys only distinctive ones (≥ 4
 * characters) may absorb longer ones.
 */
function createKeyResolver(candidates: readonly TransactionCandidate[]): (c: TransactionCandidate) => string | null {
  const normalized = new Set<string>();
  const cleaned = new Set<string>();
  for (const c of candidates) {
    const n = c.merchant.normalized?.trim().toLowerCase();
    if (n) normalized.add(n);
    else {
      const k = recurringMerchantKey(c);
      if (k) cleaned.add(k);
    }
  }
  const pools = [[...normalized].sort(), [...cleaned].filter((k) => k.length >= 4).sort()];
  const cache = new Map<string, string>();
  const canonical = (key: string): string => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const tokens = keyTokens(key);
    let best: string | null = null;
    for (const pool of pools) {
      for (const p of pool) {
        if (p !== key && isTokenPrefix(keyTokens(p), tokens) && (best === null || p.length < best.length)) best = p;
      }
      if (best) break;
    }
    const resolved = best ?? key;
    cache.set(key, resolved);
    return resolved;
  };
  return (c) => {
    const n = c.merchant.normalized?.trim().toLowerCase();
    if (n) return n;
    const k = recurringMerchantKey(c);
    return k ? canonical(k) : null;
  };
}

/** Deterministic series id from merchant key + currency + cadence: stable across runs. */
export function recurringSeriesId(merchantKey: string, currency: string, cadence: Cadence): string {
  return stableId("rec", merchantKey, currency.toUpperCase(), cadence);
}

/* ------------------------------------------------------------------ */
/* Context observations (renewal notices, trials, mandates…)           */
/* ------------------------------------------------------------------ */

/** Kinds that show the user engaging with a merchant beyond being billed. Used for dormancy. */
const INTERACTION_KINDS: ReadonlySet<ObservationKind> = new Set([
  "app_context",
  "purchase_intent",
  "checkout",
  "order",
  "delivery",
  "receipt",
  "booking",
]);

function obsTime(o: Observation): EpochMillis {
  return o.occurredAt?.value ?? o.receivedAt;
}

function byObservation(a: Observation, b: Observation): number {
  return obsTime(a) - obsTime(b) || compareStrings(a.id, b.id);
}

function subscriptionEvent(o: Observation) {
  return o.kind === "subscription_event" ? (o.subscription?.event ?? null) : null;
}

/** Any subscription event proves a subscription relationship. A live mandate proves a standing authorization. */
function isCorroborating(o: Observation): boolean {
  return o.kind === "subscription_event" || (o.kind === "mandate" && o.stage !== "cancelled");
}

function isCancellation(o: Observation): boolean {
  return subscriptionEvent(o) === "cancelled" || (o.kind === "mandate" && o.stage === "cancelled");
}

function isTrialContext(o: Observation): boolean {
  const e = subscriptionEvent(o);
  return e === "trial_started" || e === "trial_ending" || (e !== null && o.subscription?.trialEndsAt !== undefined);
}

/** The merchant (or bank) telling the user when the next charge lands. */
function isNotice(o: Observation): boolean {
  const e = subscriptionEvent(o);
  return e === "renewal_upcoming" || e === "trial_ending" || (e === "trial_started" && o.subscription?.trialEndsAt !== undefined);
}

/**
 * A reminder sent ahead of a charge, as opposed to a sign-up confirmation.
 * The sender chose its timing, so BRAKE can pass it on as soon as it arrives.
 */
function isReminder(o: Observation): boolean {
  const e = subscriptionEvent(o);
  return e === "renewal_upcoming" || e === "trial_ending";
}

function noticeDueAt(o: Observation): EpochMillis | null {
  const s = o.subscription;
  if (!s) return null;
  const e = subscriptionEvent(o);
  if (e === "renewal_upcoming") return s.nextChargeAt ?? null;
  if (e === "trial_ending" || e === "trial_started") return s.trialEndsAt ?? s.nextChargeAt ?? null;
  return null;
}

/** Price a context observation states. A mandate's amount is a ceiling, not a price, so it is ignored. */
function contextPriceMoney(o: Observation): Money | null {
  if (o.kind !== "subscription_event") return null;
  return o.subscription?.price ?? o.amount?.value ?? null;
}

function contextPrice(o: Observation, currency: string): number | null {
  const m = contextPriceMoney(o);
  return m && m.currency === currency ? m.minor : null;
}

function contextKeys(o: Observation): string[] {
  const keys = new Set<string>();
  const key = o.merchant?.key?.trim().toLowerCase();
  if (key) keys.add(key);
  for (const text of [o.merchant?.raw, o.merchant?.name, o.subscription?.serviceName, o.counterparty?.name]) {
    const k = text ? cleanMerchantDescriptor(text) : null;
    if (k) keys.add(k);
  }
  return [...keys];
}

/** Mandate and subscription ids are the strongest link between a notice and the charges it governs. */
function sharesBillingReference(a: readonly Reference[], b: readonly Reference[]): boolean {
  return a.some(
    (x) =>
      (x.type === "mandate_id" || x.type === "subscription_id") &&
      b.some((y) => y.type === x.type && y.value === x.value && (x.namespace === undefined || y.namespace === undefined || x.namespace === y.namespace)),
  );
}

/* ------------------------------------------------------------------ */
/* Members, groups, drafts                                             */
/* ------------------------------------------------------------------ */

interface Member {
  readonly c: TransactionCandidate;
  readonly at: EpochMillis;
  readonly minor: number;
  readonly last4: string | null;
}

interface Group {
  readonly key: string;
  readonly currency: string;
  readonly members: readonly Member[];
}

interface Draft {
  readonly members: readonly Member[];
  /** Instrument last4 when the group was split by concurrent instruments. */
  readonly partition: string | null;
}

function byMember(a: Member, b: Member): number {
  return a.at - b.at || compareStrings(a.c.id, b.c.id);
}

function byCandidate(a: TransactionCandidate, b: TransactionCandidate): number {
  return a.timestampEstimated - b.timestampEstimated || compareStrings(a.id, b.id);
}

function timesOf(ms: readonly Member[]): EpochMillis[] {
  return ms.map((m) => m.at);
}

/** Debit types that are never a recurring *purchase* (card bills, money coming back, cash). */
const EXCLUDED_TYPES: ReadonlySet<TransactionType> = new Set([
  "credit_card_payment",
  "refund",
  "income",
  "reimbursement",
  "cash_withdrawal",
]);

/**
 * Debits that can belong to a series. Intents and cancelled or likely-duplicate
 * candidates never moved money. Own-account transfers and wallet loads move
 * the user's own money, and card-bill payments re-count card purchases.
 * Dismissed candidates are expected to be absent from the input
 * (FusionEngine.listCandidates omits them).
 */
function isEligible(c: TransactionCandidate): boolean {
  if (c.direction !== "debit" || !c.amount) return false;
  if (c.status === "intent" || c.status === "cancelled") return false;
  if (isLikelyDuplicate(c)) return false;
  const type = c.transactionType.value;
  if (EXCLUDED_TYPES.has(type)) return false;
  if (type === "transfer" && (c.transferKind === "own_account" || c.transferKind === "wallet_load")) return false;
  const temporal = c.attributes.temporalType;
  return !(temporal.userSet && temporal.value === "one_off");
}

/**
 * Split a group by instrument only when two instruments bill concurrently
 * (overlapping charge ranges). A card replacement gives sequential ranges and
 * stays one sequence. Charges with no or one-off last4 join the partition
 * whose usual amount is closest.
 */
function partitionByInstrument(members: readonly Member[]): Draft[] {
  const byLast4 = new Map<string, Member[]>();
  for (const m of members) {
    if (!m.last4) continue;
    const list = byLast4.get(m.last4) ?? [];
    list.push(m);
    byLast4.set(m.last4, list);
  }
  const multi = [...byLast4.entries()].filter(([, ms]) => ms.length >= 2).sort(([a], [b]) => compareStrings(a, b));
  let concurrent = false;
  for (let i = 0; i < multi.length && !concurrent; i++) {
    for (let j = i + 1; j < multi.length && !concurrent; j++) {
      const a = multi[i]![1];
      const b = multi[j]![1];
      concurrent = Math.max(a[0]!.at, b[0]!.at) < Math.min(a[a.length - 1]!.at, b[b.length - 1]!.at);
    }
  }
  if (!concurrent) return [{ members: [...members], partition: null }];

  const parts = multi.map(([last4, ms]) => ({ last4, members: [...ms], level: median(ms.map((m) => m.minor)) }));
  for (const m of members) {
    if (m.last4 && parts.some((p) => p.last4 === m.last4)) continue;
    let best = parts[0]!;
    for (const p of parts) {
      const d = relDiff(m.minor, p.level);
      const bestD = relDiff(m.minor, best.level);
      if (d < bestD || (d === bestD && p.members.length > best.members.length)) best = p;
    }
    best.members.push(m);
  }
  return parts.map((p) => ({ members: [...p.members].sort(byMember), partition: p.last4 }));
}

/**
 * Tight amount clusters. A charge joins the cluster whose latest amount is
 * closest, within `tolerance`. Comparing with the latest amount lets slow
 * price creep stay together, while two concurrent plans (₹119 and ₹149) stay
 * apart.
 */
function amountClusters(members: readonly Member[], tolerance: number): Member[][] {
  const clusters: Array<{ members: Member[]; level: number }> = [];
  for (const m of members) {
    let best: { members: Member[]; level: number } | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const c of clusters) {
      const diff = relDiff(m.minor, c.level);
      if (diff <= tolerance && diff < bestDiff) {
        best = c;
        bestDiff = diff;
      }
    }
    if (best) {
      best.members.push(m);
      best.level = m.minor;
    } else {
      clusters.push({ members: [m], level: m.minor });
    }
  }
  return clusters.map((c) => c.members);
}

/** Few price changes: a fixed-price plan with the odd step, not a bill that varies every time. */
function isStepStable(ms: ReadonlyArray<{ readonly minor: number }>): boolean {
  let changes = 0;
  for (let i = 1; i < ms.length; i++) if (relDiff(ms[i]!.minor, ms[i - 1]!.minor) > 0.02) changes++;
  return changes <= Math.floor(0.25 * (ms.length - 1)) || (changes === 1 && ms.length >= 3);
}

/** One price throughout (within tolerance of the first charge): an intro price, not an ascending chain of purchases. */
function isSinglePrice(ms: readonly Member[], tolerance: number): boolean {
  const first = ms[0];
  return first !== undefined && ms.every((m) => relDiff(m.minor, first.minor) <= tolerance);
}

/**
 * Re-join amount clusters that follow each other in time and keep one
 * cadence. Both sides must be fixed-price:
 *  - drift ≤ maxDrift: a price increase or small change, once either price
 *    has repeated;
 *  - a larger step up to 2×: an upgrade or downgrade, once both prices have
 *    repeated;
 *  - ≤ 3 charges at one low price (or zero) before the full price: an intro
 *    or trial price, once the full price has repeated (a $0 authorization
 *    needs no repeat: random purchases are never free).
 * The repetition requirements keep two coincidental one-off purchases from
 * chaining into a "price history". Overlapping clusters are concurrent plans
 * and are never joined.
 */
function mergeSequentialClusters(clusters: readonly Member[][], env: Env): Member[][] {
  let list = clusters.map((c) => [...c]).sort((a, b) => byMember(a[0]!, b[0]!));
  for (let changed = true; changed; ) {
    changed = false;
    search: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const early = list[i]!;
        const late = list[j]!;
        const earlyLast = early[early.length - 1]!;
        const lateFirst = late[0]!;
        if (earlyLast.at >= lateFirst.at) continue;
        if (!isStepStable(early) || !isStepStable(late)) continue;
        const drift = relDiff(earlyLast.minor, lateFirst.minor);
        const ratio = earlyLast.minor === 0 ? Number.POSITIVE_INFINITY : lateFirst.minor / earlyLast.minor;
        const repeated = early.length >= 2 || late.length >= 2;
        const smallStep = drift <= env.maxDrift && repeated;
        const bigStep = ratio >= 0.5 && ratio <= 2 && early.length >= 2 && late.length >= 2;
        const intro =
          early.length <= 3 &&
          isSinglePrice(early, env.amountTolerance) &&
          early.every((m) => m.minor <= 0.5 * lateFirst.minor) &&
          (late.length >= 2 || early.every((m) => m.minor === 0));
        if (!smallStep && !bigStep && !intro) continue;
        const union = [...early, ...late].sort(byMember);
        if (!fitObserved(timesOf(union), env.dateOf)) continue;
        list = [...list.filter((_, k) => k !== i && k !== j), union].sort((a, b) => byMember(a[0]!, b[0]!));
        changed = true;
        break search;
      }
    }
  }
  return list;
}

/**
 * One stray charge (a one-off purchase that happens to match the price) must
 * not hide a series: if dropping a single member restores the cadence, the
 * stray becomes its own cluster.
 */
function pruneStray(cluster: readonly Member[], env: Env): Member[][] {
  if (cluster.length < 3 || cluster.length > MAX_PRUNE_CLUSTER || fitObserved(timesOf(cluster), env.dateOf)) return [[...cluster]];
  let bestIdx = -1;
  let bestMad = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cluster.length; i++) {
    const fit = fitObserved(timesOf(cluster.filter((_, j) => j !== i)), env.dateOf);
    const madDays = fit?.madDays ?? Number.POSITIVE_INFINITY;
    if (fit && madDays < bestMad) {
      bestMad = madDays;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return [[...cluster]];
  return [cluster.filter((_, j) => j !== bestIdx), [cluster[bestIdx]!]];
}

/**
 * Candidate member sets for one partition. Fixed-price clusters on a rhythm
 * win. With none, the partition as a whole may be a variable-amount
 * sequence (bills, habits).
 */
function proposeDrafts(members: readonly Member[], env: Env): Member[][] {
  const merged = mergeSequentialClusters(amountClusters(members, env.amountTolerance), env);
  const clusters = merged.flatMap((c) => pruneStray(c, env));
  const regular = clusters.filter((c) => fitObserved(timesOf(c), env.dateOf) !== null);
  if (regular.some(isStepStable)) return regular;
  if (fitObserved(timesOf(members), env.dateOf)) return [[...members]];
  return regular;
}

/* ------------------------------------------------------------------ */
/* Building a series from a draft                                      */
/* ------------------------------------------------------------------ */

interface Env extends Settings {
  readonly now: EpochMillis;
  readonly dateOf: DateOf;
}

interface Built {
  readonly group: Group;
  readonly partition: string | null;
  readonly members: readonly Member[];
  /** Leading zero/intro-price charges. */
  readonly trial: readonly Member[];
  readonly full: readonly Member[];
  readonly contexts: readonly Observation[];
  readonly category: CategoryId | null;
  /** nextExpectedAt (or the renewal itself) was stated by the merchant or bank, not extrapolated. */
  readonly statedNext: boolean;
  /** The stated renewal came in a reminder sent ahead of the charge (pre-debit notice, renewal or trial-ending email). */
  readonly reminded: boolean;
  readonly trialContext: boolean;
  readonly trialEndsAt: EpochMillis | null;
  readonly signupContext: boolean;
  /** When the evidence first sufficed to call this a series. */
  readonly confirmAt: EpochMillis;
  readonly last4s: readonly string[];
  /** The user's latest essentiality label on a member says "essential". */
  readonly userEssential: boolean;
  readonly body: Omit<RecurringSeries, "id">;
}

/** The most recent user essentiality label among members (labels can change) is "essential". */
function userMarkedEssential(members: readonly Member[]): boolean {
  for (let i = members.length - 1; i >= 0; i--) {
    const e = members[i]!.c.attributes.essentiality;
    if (e.userSet) return e.value === "essential";
  }
  return false;
}

/** Members carrying their own proof of recurrence: a charged-subscription email, a mandate or subscription id, a user label. */
function memberCorroborates(c: TransactionCandidate): boolean {
  if (c.sourceSignals.some((s) => s.kind === "subscription_event")) return true;
  if (c.references.some((r) => r.type === "subscription_id" || r.type === "mandate_id")) return true;
  const userSub = (c.transactionType.userSet && c.transactionType.value === "subscription") ||
    (c.attributes.temporalType.userSet && c.attributes.temporalType.value === "subscription");
  return userSub;
}

/**
 * Occurrences required to call a series (spec): 3 in general. For weekly,
 * biweekly and monthly series, 2 with corroborating context, or 1 with a
 * notice of the next charge. For quarterly, semiannual and annual series, 2
 * with context.
 */
function minOccurrences(spec: CadenceSpec, corroborated: boolean, notice: boolean): number {
  if (!corroborated && !notice) return 3;
  if (spec.months <= 1) return notice ? 1 : 2;
  return 2;
}

/**
 * Confidence that the members form a real series: regularity (MAD of
 * intervals relative to the cadence's tolerance) times the weight of the
 * evidence (occurrences, plus independent context).
 */
function seriesConfidence(fit: Fit, occurrences: number, corroborated: boolean): Probability {
  const regularity = fit.madDays === null ? 0.5 : clamp01(1 - (0.5 * fit.madDays) / fit.spec.toleranceDays);
  const evidence = occurrences + (corroborated ? 1.5 : 0);
  const countScore = 1 - Math.exp(-evidence / 2.5);
  const base = countScore * (0.4 + 0.6 * regularity) * (1 - 0.3 * fit.gappedFraction);
  const combined = corroborated ? 1 - (1 - base) * 0.5 : base;
  return round(Math.min(0.99, Math.max(0.05, combined)));
}

/**
 * Leading zero or intro-price charges (≤ 50% of the price that follows; at
 * most 3). Without trial context, cheap first charges are only an intro price
 * when they share one price and the rest bills a steady amount that has
 * repeated (or the intro was free). A prorated first utility bill, or an
 * ascending run of purchases, is not a trial.
 */
function splitTrial(
  members: readonly Member[],
  price: number | null,
  trialContext: boolean,
  tolerance: number,
): { trial: Member[]; full: Member[] } {
  let k = 0;
  while (k < Math.min(3, members.length)) {
    const later = members.slice(k + 1).map((m) => m.minor);
    const ref = price ?? (later.length ? median(later) : null);
    if (ref === null || ref === 0 || members[k]!.minor > 0.5 * ref) break;
    k++;
  }
  const trial = members.slice(0, k);
  const full = members.slice(k);
  const free = trial.every((m) => m.minor === 0);
  const plausibleIntro = full.length > 0 && isStepStable(full) && isSinglePrice(trial, tolerance) && (full.length >= 2 || free);
  if (k > 0 && !trialContext && !plausibleIntro) return { trial: [], full: [...members] };
  return { trial, full };
}

/** Cadence from context when charges are too few: a stated plan period, else the gap to an announced renewal. */
function contextFit(contexts: readonly Observation[], lastAt: EpochMillis): Fit | null {
  const newestFirst = [...contexts].sort((a, b) => byObservation(b, a));
  const fromSpec = (spec: CadenceSpec): Fit => ({
    spec,
    madDays: null,
    gappedFraction: 0,
    calendar: spec.months > 0,
    periodDays: spec.periodDays,
    onRhythm: [],
  });
  for (const o of newestFirst) {
    const spec = o.subscription?.period ? specForPeriod(o.subscription.period) : null;
    if (spec) return fromSpec(spec);
  }
  for (const o of newestFirst) {
    if (subscriptionEvent(o) !== "renewal_upcoming") continue; // trial length is not the billing period
    const due = noticeDueAt(o);
    if (due === null || due <= lastAt) continue;
    const spec = specForDays((due - lastAt) / DAY);
    if (spec) return fromSpec(spec);
  }
  return null;
}

/**
 * Observed charges are consistent with a stated period when every gap is one
 * period, or two (one charge not observed), within the cadence's tolerance.
 * Without this, a notice saying "monthly" would vouch for any two charges at
 * the merchant, however far apart.
 */
function agreesWithPeriod(spec: CadenceSpec, times: readonly EpochMillis[]): boolean {
  const occ = collapseOccurrences(times);
  for (let i = 1; i < occ.length; i++) {
    if (periodsSpanned(spec, (occ[i]! - occ[i - 1]!) / DAY, spec.meanDays, 3) === 0) return false;
  }
  return true;
}

function latestContextPrice(contexts: readonly Observation[], currency: string): number | null {
  let price: number | null = null;
  for (const o of contexts) {
    const p = contextPrice(o, currency);
    if (p !== null) price = p;
  }
  return price;
}

function latestTrialEnd(contexts: readonly Observation[]): EpochMillis | null {
  let end: EpochMillis | null = null;
  for (const o of contexts) {
    if (!isTrialContext(o)) continue;
    const e = o.subscription?.trialEndsAt ?? (subscriptionEvent(o) === "trial_ending" ? o.subscription?.nextChargeAt : undefined);
    if (e !== undefined) end = e;
  }
  return end;
}

function dominant<T extends string>(entries: ReadonlyArray<readonly [T | null | undefined, number]>): T | null {
  const scores = new Map<T, number>();
  for (const [value, weight] of entries) if (value) scores.set(value, (scores.get(value) ?? 0) + weight);
  let best: T | null = null;
  let bestScore = 0;
  for (const [value, score] of [...scores.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    if (score > bestScore) {
      best = value;
      bestScore = score;
    }
  }
  return best;
}

function dominantCategory(members: readonly Member[]): CategoryId | null {
  return dominant(
    members.map((m) => {
      const cat = m.c.category;
      const informative = cat.value !== "uncategorized" && (cat.userSet || cat.confidence > 0);
      return [informative ? cat.value : null, cat.userSet ? 1 : cat.confidence] as const;
    }),
  );
}

function displayNameOf(members: readonly Member[], contexts: readonly Observation[], key: string): string {
  const names = new Map<string, { n: number; last: number }>();
  for (const m of members) {
    const name = m.c.merchant.displayName ?? m.c.counterparty?.name;
    if (!name) continue;
    const prev = names.get(name);
    names.set(name, { n: (prev?.n ?? 0) + 1, last: m.at });
  }
  let best: string | null = null;
  let bestStat = { n: 0, last: Number.NEGATIVE_INFINITY };
  for (const [name, stat] of names) {
    if (stat.n > bestStat.n || (stat.n === bestStat.n && stat.last > bestStat.last)) {
      best = name;
      bestStat = stat;
    }
  }
  if (best) return best;
  for (const o of [...contexts].reverse()) {
    const name = o.subscription?.serviceName ?? o.merchant?.name;
    if (name) return name;
  }
  // A bare payment handle reads best as itself ("••••3210@ybl"), not as title-cased fragments.
  if (key.includes("@")) return key;
  return keyTokens(key)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

/* ---------------------------- subscription probability ---------------------------- */

/** Log-odds by top-level category: habits and bills recur but are not subscriptions. */
const CATEGORY_LOG_ODDS: Readonly<Record<string, number>> = {
  groceries: -2.5,
  eating_out: -2.5,
  transport: -2.5,
  housing: -2.5,
  bills: -2,
  taxes: -3,
  fees: -1,
  personal_care: -1,
  health: -1,
  household: -1,
  pets: -0.5,
  donations: -0.5,
  gifts: -1.5,
  travel: -1.5,
  entertainment: 0.5,
};

/** Subcategories that differ from their parent. */
const SUBCATEGORY_LOG_ODDS: Readonly<Record<string, number>> = {
  "entertainment.streaming": 2,
  "bills.phone_internet": -1,
};

/**
 * ISO 18245 merchant category codes. Digital goods (5815–5818) and
 * continuity/subscription merchants (5968) are strong evidence. Pay-TV and
 * membership clubs (4899, 7997) are moderate. Codes for habits and bills only
 * count when no BRAKE category exists, because the classifier already turned
 * them into one.
 */
function mccLogOdds(mcc: string, categoryKnown: boolean): number {
  const n = Number(mcc);
  if ((n >= 5815 && n <= 5818) || n === 5968) return 2;
  if (n === 4899 || n === 7997) return 1;
  if (categoryKnown) return 0;
  if ([5411, 5422, 5441, 5451, 5462, 5499, 5541, 5542, 5983, 5811, 5812, 5813, 5814, 4111, 4121, 4131].includes(n)) return -2.5;
  if ([4900, 6513, 6300, 6381, 9311].includes(n)) return -2;
  if (n === 4812 || n === 4814) return -1;
  return 0;
}

const SUBSCRIPTION_WORDS =
  /(?:^|[^\p{L}])(subscri\p{L}*|membership|member|premium|assinatura|suscripcion|abonnement|mitgliedschaft)(?![\p{L}])/u;

const CADENCE_LOG_ODDS: Readonly<Record<Cadence, number>> = {
  weekly: -0.7,
  biweekly: -0.5,
  semimonthly: -0.3,
  monthly: 0.3,
  bimonthly: 0,
  quarterly: 0,
  semiannual: 0,
  annual: 0.3,
  irregular: -0.5,
};

/** Types that recur but are commitments or movements of the user's own money, not subscriptions. */
const NOT_SUBSCRIPTION_TYPES: ReadonlySet<TransactionType> = new Set(["loan_payment", "investment", "transfer", "tax"]);

interface SubscriptionFeatures {
  readonly category: CategoryId | null;
  readonly mcc: string | null;
  readonly keyword: boolean;
  readonly channel: "online" | "in_store" | null;
  readonly dominantType: TransactionType | null;
  readonly userSaysSubscription: boolean;
  readonly userSaysRecurringOnly: boolean;
  readonly amountVariation: number;
  readonly stepStable: boolean;
  readonly subscriptionEvents: boolean;
  readonly mandate: boolean;
  readonly subscriptionRef: boolean;
  readonly mandateRef: boolean;
  readonly cadence: Cadence;
}

/**
 * Probability that a series is a subscription rather than a habit or a bill.
 * Additive log-odds, so each signal's contribution is explicit: digital or
 * streaming merchant, subscription words, steady price, merchant
 * subscription events, mandates, user labels (strongest). Groceries, fuel,
 * rent, utilities and variable amounts push it down.
 *
 * A steady price alone leaves an unknown merchant just under the alert
 * threshold (≈ 0.5–0.6). Following docs/research/10 §E11, identifying a
 * subscription needs a subscription-type merchant, MCC, email or mandate on
 * top of a fixed amount.
 */
function subscriptionProbabilityOf(f: SubscriptionFeatures): Probability {
  let z = -0.9;
  if (f.category) z += SUBCATEGORY_LOG_ODDS[f.category] ?? CATEGORY_LOG_ODDS[topLevelCategory(f.category)] ?? 0;
  if (f.mcc) z += mccLogOdds(f.mcc, f.category !== null);
  if (f.keyword) z += 1.5;
  if (f.dominantType === "subscription") z += 1.5;
  if (f.dominantType && NOT_SUBSCRIPTION_TYPES.has(f.dominantType)) z -= 3;
  if (f.userSaysSubscription) z += 5;
  if (f.userSaysRecurringOnly) z -= 3;
  if (f.stepStable && f.amountVariation <= 0.1) z += 0.7;
  else if (f.amountVariation <= 0.15) z += 0.2;
  else if (f.amountVariation > 0.25) z -= 1.5;
  else z -= 0.5;
  if (f.subscriptionEvents) z += 2;
  if (f.mandate) z += 0.7;
  if (f.subscriptionRef) z += 1.5;
  if (f.mandateRef && !f.mandate) z += 0.5;
  z += CADENCE_LOG_ODDS[f.cadence];
  if (f.channel === "online") z += 0.3;
  if (f.channel === "in_store") z -= 1;
  return round(Math.min(0.98, Math.max(0.02, sigmoid(z))));
}

function normalizeText(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function subscriptionFeatures(
  members: readonly Member[],
  full: readonly Member[],
  contexts: readonly Observation[],
  category: CategoryId | null,
  cadence: Cadence,
): SubscriptionFeatures {
  const texts: string[] = [];
  for (const m of members) {
    const mer = m.c.merchant;
    for (const t of [mer.raw, mer.displayName, mer.normalized]) if (t) texts.push(t);
    for (const li of m.c.lineItems) texts.push(li.description);
  }
  for (const o of contexts) {
    for (const t of [o.subscription?.serviceName, o.subscription?.planName, o.merchant?.raw, o.merchant?.name]) if (t) texts.push(t);
  }
  const channels = members.map((m) => [m.c.merchant.channel === "unknown" ? null : m.c.merchant.channel, 1] as const);
  // This detector's own "subscription" reading is not evidence: read the belief it refined.
  const types = members.map((m) => {
    const t = typeBeforeRecurrence(m.c.transactionType);
    return [t.value === "unknown" ? null : t.value, t.userSet ? 1 : t.confidence] as const;
  });
  const amounts = full.map((m) => m.minor);
  return {
    category,
    mcc: dominant(members.map((m) => [m.c.merchant.mcc ?? null, 1] as const)),
    keyword: texts.some((t) => SUBSCRIPTION_WORDS.test(normalizeText(t))),
    channel: dominant(channels),
    dominantType: dominant(types),
    userSaysSubscription: members.some(
      (m) =>
        (m.c.transactionType.userSet && m.c.transactionType.value === "subscription") ||
        (m.c.attributes.temporalType.userSet && m.c.attributes.temporalType.value === "subscription"),
    ),
    userSaysRecurringOnly: members.some((m) => m.c.attributes.temporalType.userSet && m.c.attributes.temporalType.value === "recurring"),
    amountVariation: coefficientOfVariation(amounts),
    stepStable: isStepStable(full),
    subscriptionEvents: contexts.some((o) => o.kind === "subscription_event") || members.some((m) => m.c.sourceSignals.some((s) => s.kind === "subscription_event")),
    mandate: contexts.some((o) => o.kind === "mandate"),
    subscriptionRef: members.some((m) => m.c.references.some((r) => r.type === "subscription_id")),
    mandateRef: members.some((m) => m.c.references.some((r) => r.type === "mandate_id")),
    cadence,
  };
}

/* ---------------------------- build ---------------------------- */

/**
 * Fit the members' rhythm, from all charges or (when an intro/trial charge
 * sits off the rhythm) from full-price charges only. Then drop members joined
 * only by off-rhythm intervals at either end and refit. Trial charges are
 * kept, because a trial's length is not the billing period.
 *
 * When the leading charges are a sign-up authorization (a $0/₹1 charge, or
 * any charge under trial context), the gap to the first paid charge is the
 * trial's length: a 7-day trial must not make a monthly plan "weekly". Only
 * paid charges then reveal the cadence; with fewer than two, the caller falls
 * back to the period the merchant stated.
 */
function fitAndTrim(members: readonly Member[], trial: readonly Member[], full: readonly Member[], dateOf: DateOf, signupTrial: boolean) {
  const fitOf = (all: readonly Member[], paid: readonly Member[]) => {
    if (signupTrial) {
      const onPaid = paid.length >= 2 ? fitObserved(timesOf(paid), dateOf) : null;
      return onPaid ? { fit: onPaid, basis: paid } : null;
    }
    const onAll = fitObserved(timesOf(all), dateOf);
    if (onAll) return { fit: onAll, basis: all };
    const onPaid = paid.length >= 2 ? fitObserved(timesOf(paid), dateOf) : null;
    return onPaid ? { fit: onPaid, basis: paid } : null;
  };
  const first = fitOf(members, full);
  if (!first) return { members: [...members], full: [...full], fit: null };
  const kept = new Set([...trial, ...trimOffRhythmEnds(first.basis, first.fit)]);
  if (kept.size === members.length) return { members: [...members], full: [...full], fit: first.fit };
  const trimmedMembers = members.filter((m) => kept.has(m));
  const trimmedFull = full.filter((m) => kept.has(m));
  return { members: trimmedMembers, full: trimmedFull, fit: fitOf(trimmedMembers, trimmedFull)?.fit ?? null };
}

/**
 * Build a series from a draft, or decline.
 *
 * `explainedElsewhere` holds the merchant's charges that other series
 * (or hypotheses) account for. The rest of the merchant's charges during this
 * draft's span are unexplained noise. The more noise, the more occurrences an
 * uncorroborated series needs: among many purchases at one merchant, three
 * evenly spaced ones are easily a coincidence.
 */
function build(draft: Draft, contexts: readonly Observation[], group: Group, env: Env, explainedElsewhere: ReadonlySet<Member>): Built | null {
  const drafted = [...draft.members].sort(byMember);
  if (drafted.length === 0) return null;
  const { currency } = group;
  const ctx = [...contexts].sort(byObservation);
  const price = latestContextPrice(ctx, currency);
  const trialContext = ctx.some(isTrialContext);
  const split = splitTrial(drafted, price, trialContext, env.amountTolerance);
  if (split.full.length === 0 && !trialContext) return null;

  const signupTrial = split.trial.length > 0 && (trialContext || split.trial.every((m) => m.minor === 0));
  const trimmed = fitAndTrim(drafted, split.trial, split.full, env.dateOf, signupTrial);
  const members = trimmed.members;
  const full = trimmed.full;
  const trial = split.trial;
  const occurrences = collapseOccurrences(timesOf(members));
  const last = members[members.length - 1]!;
  let fit = trimmed.fit;
  // Too few charges to read a rhythm: take the period the merchant stated,
  // but only if the charges we do see agree with it.
  const rhythmBasis = signupTrial ? full : members;
  if (!fit && (signupTrial || occurrences.length <= 2)) {
    const stated = contextFit(ctx, last.at);
    if (stated && agreesWithPeriod(stated.spec, timesOf(rhythmBasis))) fit = stated;
  }
  if (!fit) return null;

  const corroborated = ctx.some(isCorroborating) || members.some((m) => memberCorroborates(m.c));
  const notice = ctx.some(isNotice);
  let required = minOccurrences(fit.spec, corroborated, notice);
  if (!corroborated) {
    const own = new Set(members);
    const first = members[0]!.at;
    const noise = group.members.filter((m) => !own.has(m) && !explainedElsewhere.has(m) && m.at >= first && m.at <= last.at).length;
    required += Math.floor(noise / 3);
  }
  if (occurrences.length < required) return null;
  const confidence = seriesConfidence(fit, occurrences.length, corroborated);
  if (confidence < env.minConfidence) return null;

  const spec = fit.spec;
  const periodMs = fit.periodDays * DAY;
  const lastFull = full.length ? full[full.length - 1]! : null;
  const fullAmounts = full.map((m) => m.minor);
  const typicalMinor = full.length ? Math.round(median(fullAmounts)) : (price ?? Math.round(median(members.map((m) => m.minor))));

  // Status.
  const cancelAt = maxOrNull(ctx.filter(isCancellation).map(obsTime));
  const trialEndsAt = latestTrialEnd(ctx);
  const overdueAt = lastFull === null && trialEndsAt !== null ? trialEndsAt + 0.5 * periodMs : last.at + 1.5 * periodMs;
  // A reminder of a charge still ahead, sent after the last charge we saw,
  // shows the plan is live even when the feed missed charges in between.
  const reminderAhead = ctx.some(
    (o) => isReminder(o) && obsTime(o) > last.at && (noticeDueAt(o) ?? obsTime(o) + env.renewalLeadDays * DAY) >= env.now - DAY,
  );
  let status: RecurringSeries["status"];
  if (cancelAt !== null && cancelAt >= last.at - DAY) status = "cancelled";
  else if (env.now > overdueAt && !reminderAhead) status = "dormant"; // missed > 1.5 periods without a cancellation
  else if (lastFull === null || (trialEndsAt !== null && trialEndsAt > env.now && trialEndsAt > lastFull.at)) status = "trial";
  else status = "active";

  // Next charge: the merchant's own statement beats extrapolation. Calendar
  // series land on their billing day; day-count cycles (28-day plans) add days.
  const anchorBase = full.length ? full : members;
  let nextAt: EpochMillis | null =
    fit.calendar && spec.months > 0
      ? addMonthsAnchored(last.at, spec.months, currentBillingDay(anchorBase.map((m) => env.dateOf(m.at))), env.timeZone)
      : last.at + periodMs;
  let nextMinor: number | null = lastFull?.minor ?? price;
  let statedNext = false;
  let reminded = false;
  // A notice whose date a charge already met (posted a little early) is
  // history, not the next renewal.
  const fulfilledWithin = Math.min(CALENDAR_TOLERANCE_DAYS, spec.toleranceDays) * DAY;
  for (const o of ctx) {
    if (!isNotice(o)) continue;
    const due = noticeDueAt(o);
    if (due !== null && due > last.at + Math.max(DAY / 2, fulfilledWithin)) {
      nextAt = due;
      statedNext = true;
      reminded = isReminder(o);
      const p = contextPrice(o, currency);
      if (p !== null) nextMinor = p;
    } else if (due === null && subscriptionEvent(o) === "renewal_upcoming" && obsTime(o) > last.at) {
      statedNext = true; // "renews soon" without a date still announces the renewal
      reminded = true;
    }
  }
  for (const o of ctx) {
    const p = contextPrice(o, currency);
    if (subscriptionEvent(o) === "price_change" && p !== null && obsTime(o) >= last.at - DAY) nextMinor = p;
  }
  if (status === "trial") {
    if (trialEndsAt !== null) {
      nextAt = trialEndsAt;
      statedNext = true;
    }
    nextMinor = price ?? lastFull?.minor ?? null;
  }
  if (status === "cancelled" || status === "dormant") {
    nextAt = null;
    nextMinor = null;
    statedNext = false;
    reminded = false;
  }

  const priceHistory: Array<{ at: EpochMillis; amount: Money }> = [];
  for (const m of members) {
    const prev = priceHistory[priceHistory.length - 1];
    if (!prev || prev.amount.minor !== m.minor) priceHistory.push({ at: m.at, amount: money(m.minor, currency) });
  }

  const category = dominantCategory(full.length ? full : members);
  const subscriptionProbability = subscriptionProbabilityOf(subscriptionFeatures(members, full, ctx, category, spec.cadence));

  // When the evidence first sufficed: the third charge, or earlier with corroboration or a notice.
  const corroboratedAt = minOrNull([
    ...ctx.filter(isCorroborating).map(obsTime),
    ...members.filter((m) => memberCorroborates(m.c)).map((m) => m.at),
  ]);
  const noticeAt = minOrNull(ctx.filter(isNotice).map(obsTime));
  const confirmOptions: number[] = [];
  if (occurrences.length >= 3) confirmOptions.push(occurrences[2]!);
  if (corroboratedAt !== null && occurrences.length >= 2) confirmOptions.push(Math.max(occurrences[1]!, corroboratedAt));
  if (noticeAt !== null && spec.months <= 1) confirmOptions.push(Math.max(occurrences[0]!, noticeAt));
  const confirmAt = minOrNull(confirmOptions) ?? last.at;

  const signupEvents = new Set(["signup", "trial_started", "trial_ending"]);
  return {
    group,
    partition: draft.partition,
    members,
    trial,
    full,
    contexts: ctx,
    category,
    statedNext,
    reminded,
    trialContext,
    trialEndsAt,
    signupContext: ctx.some((o) => signupEvents.has(subscriptionEvent(o) ?? "")),
    confirmAt,
    last4s: [...new Set(members.map((m) => m.last4).filter((x): x is string => x !== null))].sort(),
    userEssential: userMarkedEssential(members),
    body: {
      merchantKey: group.key,
      displayName: displayNameOf(members, ctx, group.key),
      cadence: spec.cadence,
      periodDays: fit.periodDays,
      typicalAmount: money(typicalMinor, currency),
      amountVariation: round(coefficientOfVariation(fullAmounts), 4),
      memberIds: members.map((m) => m.c.id),
      firstChargeAt: members[0]!.at,
      lastChargeAt: last.at,
      nextExpectedAt: nextAt,
      nextExpectedAmount: nextMinor === null ? null : money(nextMinor, currency),
      subscriptionProbability,
      status,
      priceHistory,
      confidence,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Per-group detection                                                 */
/* ------------------------------------------------------------------ */

function priceCompatible(o: Observation, members: readonly Member[], currency: string): boolean {
  const p = contextPrice(o, currency);
  if (p === null) return true;
  return members.some((m) => relDiff(m.minor, p) <= 0.25) || members.every((m) => m.minor <= 0.5 * p);
}

function contextMatchesGroup(o: Observation, g: Group): boolean {
  if (g.members.some((m) => sharesBillingReference(m.c.references, o.references))) return true;
  const price = contextPriceMoney(o);
  // A notice may state the plan's own currency while the card is charged in another (FX).
  if (price && price.currency !== g.currency && !g.members.some((m) => m.c.originalAmount?.currency === price.currency)) return false;
  return contextKeys(o).some((k) => keysMatch(k, g.key));
}

/** Words that describe a plan rather than name a service ("Prime membership", "Music plan"). */
const PLAN_WORDS: ReadonlySet<string> = new Set(["subscription", "subscriptions", "membership", "member", "plan", "monthly", "annual", "yearly", "renewal", "account"]);

/**
 * Tokens that name a service beyond the merchant key: "Amazon Music
 * Unlimited" under "amazon" → {music, unlimited}; "Apple TV+" under "apple"
 * → {tv}. Unlike the key cleaner, short tokens ("TV") are kept: here they are
 * the name.
 */
function serviceTokens(name: string | null | undefined, groupKey: string): Set<string> {
  if (!name) return new Set();
  const base = new Set(keyTokens(groupKey));
  return new Set(keyTokens(normalizeText(name)).filter((t) => !base.has(t) && !NOISE_TOKENS.has(t) && !PLAN_WORDS.has(t) && !isReferenceToken(t)));
}

/**
 * The notice names one service and the charges another, and the names share
 * nothing ("iCloud+" vs "Apple TV+", "Amazon Music Unlimited" vs "Amazon
 * Prime"). Only the service a notice is about counts, not its sender's name.
 */
function namesOtherService(o: Observation, chargesName: string, groupKey: string): boolean {
  const named = serviceTokens(o.subscription?.serviceName, groupKey);
  const own = serviceTokens(chargesName, groupKey);
  return named.size > 0 && own.size > 0 && ![...named].some((t) => own.has(t));
}

/** The notice states the price these charges carry. That outweighs a mismatch in names (a store's name on the charges). */
function statesPriceOf(o: Observation, members: readonly Member[], currency: string): boolean {
  const p = contextPrice(o, currency);
  return p !== null && members.some((m) => relDiff(m.minor, p) <= 0.1);
}

/** The notice is about a different service than these charges: it names another, and its price does not say otherwise. */
function aboutOtherService(o: Observation, members: readonly Member[], group: Group, name = displayNameOf(members, [], group.key)): boolean {
  return namesOtherService(o, name, group.key) && !statesPriceOf(o, members, group.currency);
}

/** Latest charge at or before a notice (or, failing that, the earliest charge after it, ranked lowest). */
function lastBilledBefore(members: readonly Member[], at: EpochMillis): number {
  return maxOrNull(members.filter((m) => m.at <= at + DAY).map((m) => m.at)) ?? Number.NEGATIVE_INFINITY;
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Give each context observation to one draft: the one sharing a mandate or
 * subscription id, else (among drafts it does not name as another service)
 * the one whose price it states, else (no price) the draft that billed last
 * before it.
 */
function assignContexts(drafts: readonly Draft[], contexts: readonly Observation[], group: Group): Map<Draft, Observation[]> {
  const out = new Map<Draft, Observation[]>();
  const { currency } = group;
  const names = new Map(drafts.map((d) => [d, displayNameOf(d.members, [], group.key)] as const));
  for (const o of contexts) {
    let target = drafts.find((d) => d.members.some((m) => sharesBillingReference(m.c.references, o.references)));
    if (!target) {
      const named = drafts.filter((d) => !aboutOtherService(o, d.members, group, names.get(d)!));
      const p = o.kind === "mandate" ? null : contextPrice(o, currency);
      if (p === null) {
        const at = obsTime(o);
        const rank = (d: Draft) => [lastBilledBefore(d.members, at), d.members[d.members.length - 1]?.at ?? 0, d.members.length];
        target = [...named].sort((a, b) => compareScores(rank(b), rank(a)))[0];
      } else {
        let bestDiff = Number.POSITIVE_INFINITY;
        for (const d of named) {
          if (!priceCompatible(o, d.members, currency)) continue;
          const diff = Math.min(...d.members.map((m) => relDiff(m.minor, p)));
          if (diff < bestDiff) {
            bestDiff = diff;
            target = d;
          }
        }
      }
    }
    if (target) out.set(target, [...(out.get(target) ?? []), o]);
  }
  return out;
}

/** How specifically a notice's names point at a key: the exact key beats a broader or narrower one, and longer beats shorter. */
function keySpecificity(o: Observation, key: string): number {
  let best = 0;
  for (const k of contextKeys(o)) {
    if (k === key) best = Math.max(best, 100 + keyTokens(k).length);
    else if (keysMatch(k, key)) best = Math.max(best, Math.min(keyTokens(k).length, keyTokens(key).length));
  }
  return best;
}

/**
 * Each notice is about one subscription, so it goes to one merchant group:
 * the one sharing its mandate or subscription id; else the one its names
 * match most specifically ("Amazon Music Unlimited" → "amazon music", not
 * "amazon"); else the one in the currency it states; else the one billed
 * last before it. Ties go to the first group in key order.
 */
function assignContextsToGroups(contexts: readonly Observation[], groups: readonly Group[]): Map<Group, Observation[]> {
  const out = new Map<Group, Observation[]>();
  for (const o of contexts) {
    const price = contextPriceMoney(o);
    let best: { readonly group: Group; readonly score: readonly number[] } | null = null;
    for (const g of groups) {
      if (!contextMatchesGroup(o, g)) continue;
      const score = [
        g.members.some((m) => sharesBillingReference(m.c.references, o.references)) ? 1 : 0,
        keySpecificity(o, g.key),
        price && price.currency === g.currency ? 1 : 0,
        lastBilledBefore(g.members, obsTime(o)),
      ];
      if (!best || compareScores(score, best.score) > 0) best = { group: g, score };
    }
    if (best) out.set(best.group, [...(out.get(best.group) ?? []), o]);
  }
  return out;
}

/**
 * Charges a notice can be about, in a merchant group that also has unrelated
 * purchases: the price-matching cluster charged before the notice, plus
 * earlier trial-priced charges.
 */
function noticeDraft(notice: Observation, members: readonly Member[], env: Env, currency: string): Draft | null {
  const before = members.filter((m) => m.at <= obsTime(notice) + DAY);
  if (before.length === 0) return null;
  const price = contextPrice(notice, currency);
  if (price === null) {
    const clusters = amountClusters(before, env.amountTolerance);
    return clusters.length === 1 ? { members: clusters[0]!, partition: null } : null;
  }
  const isTrialLike = (m: Member) => m.minor <= 0.5 * price;
  const full = before.filter((m) => relDiff(m.minor, price) <= env.maxDrift);
  if (full.length === 0) {
    const trial = before.filter(isTrialLike).slice(-3);
    return trial.length ? { members: trial, partition: null } : null;
  }
  const latest = full[full.length - 1]!;
  const cluster = amountClusters(full, env.amountTolerance).find((c) => c.includes(latest)) ?? [latest];
  const start = cluster[0]!.at;
  const trial = before.filter((m) => isTrialLike(m) && m.at < start && start - m.at <= 100 * DAY).slice(-3);
  return { members: [...trial, ...cluster].sort(byMember), partition: null };
}

function detectGroup(group: Group, contexts: readonly Observation[], env: Env): Built[] {
  const out: Built[] = [];
  const claimed = new Set<Member>();
  const usedContext = new Set<Observation>();
  const accept = (b: Built | null): boolean => {
    if (!b) return false;
    out.push(b);
    for (const m of b.members) claimed.add(m);
    for (const o of b.contexts) usedContext.add(o);
    return true;
  };

  const proposals: Draft[] = [];
  for (const part of partitionByInstrument(group.members)) {
    for (const members of proposeDrafts(part.members, env)) proposals.push({ members, partition: part.partition });
  }
  const assigned = assignContexts(proposals, contexts, group);
  for (const d of proposals) {
    // Charges in other hypotheses (a concurrent plan) are explained, not noise.
    const elsewhere = new Set(proposals.filter((p) => p !== d).flatMap((p) => p.members));
    accept(build(d, assigned.get(d) ?? [], group, env, elsewhere));
  }

  // Leftovers: first as one variable-amount sequence, then around each unused notice.
  const unclaimed = () => group.members.filter((m) => !claimed.has(m));
  const freeContext = () => contexts.filter((o) => !usedContext.has(o));
  const leftover = unclaimed();
  if (leftover.length === 0) return out;
  const fits = (o: Observation, members: readonly Member[]) => priceCompatible(o, members, group.currency) && !aboutOtherService(o, members, group);
  const wholeCtx = freeContext().filter((o) => fits(o, leftover));
  if (accept(build({ members: leftover, partition: null }, wholeCtx, group, env, claimed))) return out;
  for (const notice of freeContext().filter(isNotice)) {
    if (usedContext.has(notice)) continue;
    const draft = noticeDraft(notice, unclaimed(), env, group.currency);
    if (!draft || aboutOtherService(notice, draft.members, group)) continue;
    const related = freeContext().filter((o) => o !== notice && fits(o, draft.members));
    accept(build(draft, [notice, ...related], group, env, claimed));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

interface Item {
  readonly b: Built;
  readonly s: RecurringSeries;
}

/** "Within the last period" for news-like alerts, at least a month, plus posting lag. */
function recencyWindowMs(s: RecurringSeries): number {
  return (Math.max(s.periodDays, 31) + 3) * DAY;
}

function upcomingRenewal({ b, s }: Item, env: Env): RecurringAlert | null {
  if ((s.status !== "active" && s.status !== "trial") || s.nextExpectedAt === null) return null;
  // The brief's nudge is for renewals the user has not marked essential; asking
  // "keep or review?" about something they called essential is nagging.
  if (b.userEssential) return null;
  const due = s.nextExpectedAt;
  if (due < env.now - DAY) return null;
  const soon = due <= env.now + env.renewalLeadDays * DAY;
  const predicted = soon && s.subscriptionProbability >= env.subscriptionThreshold;
  // A reminder is passed on when it arrives. A date stated at sign-up (a trial's
  // end) is exact but not yet news: it waits for the same lead window as a prediction.
  const stated = b.statedNext && (b.reminded || soon);
  if (!stated && !predicted) return null;
  const confidence = b.statedNext ? Math.max(0.85, s.confidence) : s.confidence * (0.5 + 0.5 * s.subscriptionProbability);
  return {
    kind: "upcoming_renewal",
    seriesId: s.id,
    at: due,
    ...(s.nextExpectedAmount ? { amount: s.nextExpectedAmount } : {}),
    confidence: round(confidence),
  };
}

/**
 * Latest price level vs the level before it (> threshold). Only for
 * fixed-price series, because a varying utility bill would raise an alert
 * every month. Only for well-established or subscription-like series, because
 * on a three-charge coincidence a "price increase" is just noise. A merchant's
 * price-change notice either confirms the step or announces it ahead of the
 * charge.
 */
function priceIncrease({ b, s }: Item, env: Env): RecurringAlert | null {
  if (s.status === "cancelled" || s.status === "dormant") return null;
  const { currency, points: full } = pricePoints(b.full, s.typicalAmount.currency);
  const thr = env.priceIncreaseThreshold;
  const window = recencyWindowMs(s);
  const established = s.confidence >= 0.75 || s.subscriptionProbability >= env.subscriptionThreshold;
  let alert: RecurringAlert | null = null;
  if (established && full.length >= 2 && isStepStable(full)) {
    const latest = full[full.length - 1]!.minor;
    let i = full.length - 1;
    while (i > 0 && relDiff(full[i - 1]!.minor, latest) <= thr) i--;
    // The new level must start with a real step. Many small moves that add up
    // (a habit's basket creeping up) are drift, not a price change.
    if (i > 0 && relDiff(full[i - 1]!.minor, full[i]!.minor) > thr) {
      const prevEnd = i - 1;
      let j = prevEnd;
      while (j > 0 && relDiff(full[j - 1]!.minor, full[prevEnd]!.minor) <= thr) j--;
      const previous = Math.round(median(full.slice(j, prevEnd + 1).map((m) => m.minor)));
      const stepAt = full[i]!.at;
      if (latest > previous * (1 + thr) && env.now - stepAt <= window) {
        alert = {
          kind: "price_increase",
          seriesId: s.id,
          at: stepAt,
          amount: money(latest, currency),
          previousAmount: money(previous, currency),
          confidence: round(s.confidence * 0.95),
        };
      }
    }
  }
  const notices = b.contexts.filter((o) => subscriptionEvent(o) === "price_change").reverse();
  for (const o of notices) {
    const p = contextPrice(o, currency);
    const prev = o.subscription?.previousPrice;
    if (p === null || !prev || prev.currency !== currency || p <= prev.minor * (1 + thr)) continue;
    if (env.now - obsTime(o) > window) continue;
    if (alert) {
      if (alert.amount && relDiff(alert.amount.minor, p) <= 0.01) alert = { ...alert, confidence: round(Math.max(alert.confidence, 0.9)) };
    } else {
      alert = {
        kind: "price_increase",
        seriesId: s.id,
        at: o.subscription?.nextChargeAt ?? obsTime(o),
        amount: money(p, currency),
        previousAmount: prev,
        confidence: 0.9,
      };
    }
    break;
  }
  return alert;
}

/**
 * The prices to compare for a price increase. A subscription priced in a
 * foreign currency (a USD plan on an INR card) is charged a different local
 * amount every month as exchange rates move; that is not the merchant raising
 * its price. When every full-price charge carries its original amount in one
 * other currency, compare those instead.
 */
function pricePoints(full: readonly Member[], chargedCurrency: string): { currency: string; points: Array<{ at: EpochMillis; minor: number }> } {
  const originals = full.map((m) => m.c.originalAmount);
  const original = originals[0]?.currency;
  if (original && original !== chargedCurrency && originals.every((o) => o?.currency === original)) {
    return { currency: original, points: full.map((m, i) => ({ at: m.at, minor: originals[i]!.minor })) };
  }
  return { currency: chargedCurrency, points: full.map((m) => ({ at: m.at, minor: m.minor })) };
}

/** The first full-price charge after a trial (zero/intro-priced charges or trial context), while it is news. */
function trialConversion({ b, s }: Item, env: Env): RecurringAlert | null {
  if (s.status !== "active" || s.subscriptionProbability < env.subscriptionThreshold || b.full.length === 0) return null;
  const firstFull = b.full.find((m) => b.trialEndsAt === null || m.at >= b.trialEndsAt - DAY);
  if (!firstFull) return null;
  const trialBefore = b.trial.length > 0 || b.contexts.some((o) => isTrialContext(o) && obsTime(o) <= firstFull.at + DAY);
  if (!trialBefore || env.now - firstFull.at > recencyWindowMs(s)) return null;
  return {
    kind: "trial_conversion",
    seriesId: s.id,
    at: firstFull.at,
    amount: money(firstFull.minor, s.typicalAmount.currency),
    confidence: round(s.confidence * (b.trialContext ? 0.95 : 0.8)),
  };
}

/**
 * A series first confirmed within the last period. "Confirmed" is not
 * "started": a long-standing subscription can only become visible when a
 * source is connected. So unless a signup/trial notice says it is new,
 * BRAKE must have had visibility for a full period before the first charge.
 */
function newSubscription({ b, s }: Item, env: Env, earliestVisibleAt: EpochMillis): RecurringAlert | null {
  if ((s.status !== "active" && s.status !== "trial") || s.subscriptionProbability < env.subscriptionThreshold) return null;
  if (b.confirmAt > env.now || env.now - b.confirmAt > recencyWindowMs(s)) return null;
  const visibleBefore = s.firstChargeAt - earliestVisibleAt >= s.periodDays * DAY;
  if (!b.signupContext && !visibleBefore) return null;
  return {
    kind: "new_subscription",
    seriesId: s.id,
    at: b.confirmAt,
    amount: s.nextExpectedAmount ?? s.typicalAmount,
    confidence: round(s.confidence * (b.signupContext ? 0.95 : 0.75)),
  };
}

function isStreaming(category: CategoryId | null): boolean {
  return category === "entertainment.streaming" || (category?.startsWith("entertainment.streaming.") ?? false);
}

/**
 * Two series under one merchant key that are named as different services
 * ("iCloud+" and "Apple TV+" behind an app-store descriptor). A shared key is
 * then the billing intermediary, not the service. Names that extend each
 * other ("Spotify", "Spotify Premium") do not conflict.
 */
function namesConflict(a: string, b: string): boolean {
  const ka = cleanMerchantDescriptor(a);
  const kb = cleanMerchantDescriptor(b);
  return ka !== null && kb !== null && !keysMatch(ka, kb);
}

/**
 * Two live subscriptions to the same service:
 *  - the same merchant key and cadence (two cards, or two plans billed side by
 *    side), unless their names say they are different services;
 *  - or two streaming series with the same name billed under different keys
 *    (direct vs through an app store).
 * A series that missed its last expected charge is not live. That keeps a
 * plan switch from looking like a duplicate.
 */
function duplicateAlerts(items: readonly Item[], env: Env): RecurringAlert[] {
  const live = items.filter(
    ({ s }) =>
      s.status === "active" &&
      s.subscriptionProbability >= env.subscriptionThreshold &&
      (s.nextExpectedAt === null || env.now <= s.nextExpectedAt + 3 * DAY),
  );
  const parent = live.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const pairConfidence = new Map<number, number>();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      let base = 0;
      if (a.s.merchantKey === b.s.merchantKey && a.s.cadence === b.s.cadence && !namesConflict(a.s.displayName, b.s.displayName)) {
        const differentCards = a.b.last4s.length > 0 && b.b.last4s.length > 0 && !a.b.last4s.some((x) => b.b.last4s.includes(x));
        base = differentCards ? 0.85 : 0.7;
      } else if (isStreaming(a.b.category) && isStreaming(b.b.category)) {
        const na = cleanMerchantDescriptor(a.s.displayName);
        if (na !== null && na === cleanMerchantDescriptor(b.s.displayName)) base = 0.7;
      }
      if (base === 0) continue;
      const confidence = base * Math.min(a.s.subscriptionProbability, b.s.subscriptionProbability);
      const ri = find(i);
      const rj = find(j);
      const root = Math.min(ri, rj);
      parent[Math.max(ri, rj)] = root;
      pairConfidence.set(root, Math.max(pairConfidence.get(root) ?? 0, pairConfidence.get(ri) ?? 0, pairConfidence.get(rj) ?? 0, confidence));
    }
  }
  const clusters = new Map<number, Item[]>();
  live.forEach((item, i) => {
    const r = find(i);
    clusters.set(r, [...(clusters.get(r) ?? []), item]);
  });
  const alerts: RecurringAlert[] = [];
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    // The newest series is the likelier unintended one; the alert hangs on it.
    const newest = [...members].sort((x, y) => y.s.firstChargeAt - x.s.firstChargeAt || compareStrings(x.s.id, y.s.id))[0]!;
    alerts.push({
      kind: "duplicate_subscription",
      seriesId: newest.s.id,
      relatedSeriesIds: members.filter((m) => m !== newest).map((m) => m.s.id).sort(),
      at: newest.s.firstChargeAt,
      amount: newest.s.nextExpectedAmount ?? newest.s.typicalAmount,
      confidence: round(pairConfidence.get(root) ?? 0),
    });
  }
  return alerts;
}

/**
 * An active subscription with no non-billing interaction with the merchant
 * (app opens, orders, intents, other purchases) for ≥ 3 periods (capped at a
 * year).
 *
 * Confidence is deliberately low (≤ 0.4). BRAKE cannot see usage: streaming
 * happens inside apps BRAKE does not observe, so the absence of interaction
 * signals is weak evidence of non-use. This should only ever turn into a
 * question ("Still using it?"), never a statement.
 */
function dormantSubscription({ b, s }: Item, env: Env, lastInteraction: (key: string) => EpochMillis | null): RecurringAlert | null {
  if (s.status !== "active" || s.subscriptionProbability < env.subscriptionThreshold || b.userEssential) return null;
  const windowMs = Math.min(3 * s.periodDays, 365) * DAY;
  if (env.now - s.firstChargeAt < windowMs) return null;
  const since = lastInteraction(s.merchantKey);
  if (since !== null && env.now - since < windowMs) return null;
  return {
    kind: "dormant_subscription",
    seriesId: s.id,
    at: (since ?? s.firstChargeAt) + windowMs,
    amount: s.nextExpectedAmount ?? s.typicalAmount,
    confidence: round(Math.min(0.4, s.confidence * s.subscriptionProbability)),
  };
}

/* ------------------------------------------------------------------ */
/* Patches                                                             */
/* ------------------------------------------------------------------ */

function toInference<T extends string>(entries: ReadonlyArray<readonly [T, number]>, basis: readonly InferenceBasis[]): Inference<T> {
  const merged = new Map<T, number>();
  for (const [v, p] of entries) merged.set(v, (merged.get(v) ?? 0) + p);
  const sorted = [...merged.entries()].sort(([va, pa], [vb, pb]) => pb - pa || compareStrings(va, vb));
  const [head, ...rest] = sorted;
  return {
    value: head![0],
    confidence: round(head![1]),
    alternatives: rest.filter(([, p]) => p > 0).map(([value, p]) => ({ value, probability: round(p) })),
    basis,
    userSet: false,
  };
}

/** P(subscription) = series confidence × subscriptionProbability; the remainder is "recurring" or "one-off". */
function temporalInference(s: RecurringSeries): Inference<TemporalType> {
  return toInference<TemporalType>(
    [
      ["subscription", s.confidence * s.subscriptionProbability],
      ["recurring", s.confidence * (1 - s.subscriptionProbability)],
      ["one_off", 1 - s.confidence],
    ],
    ["recurrence"],
  );
}

/**
 * This detector's own earlier reading (basis "recurrence", not set by the
 * user). The classifier treats any "recurrence" basis as owned elsewhere and
 * leaves it alone, so only this detector can update or withdraw it.
 */
function isOwnReading(inf: Inference<string>): boolean {
  return !inf.userSet && inf.basis.includes("recurrence");
}

type Entry<T extends string> = { readonly value: T; readonly probability: Probability };

function entriesOf<T extends string>(inf: Inference<T>): Entry<T>[] {
  return [{ value: inf.value, probability: inf.confidence }, ...inf.alternatives];
}

function fromEntries<T extends string>(entries: readonly Entry<T>[], basis: readonly InferenceBasis[], fallback: T): Inference<T> {
  const sorted = entries.filter((e) => e.probability > 0).sort((a, b) => b.probability - a.probability || compareStrings(a.value, b.value));
  const [head, ...alternatives] = sorted;
  if (!head) return unknownInference(fallback);
  return { value: head.value, confidence: head.probability, alternatives, basis: basis.length ? basis : ["none"], userSet: false };
}

/**
 * The type belief this detector refined, recovered from its own reading.
 * The refinement scales every earlier entry by 1 − P(subscription) and keeps
 * the earlier basis, so dividing that factor back out restores it. Without
 * this the next run would count its own "subscription" as independent
 * evidence (raising subscriptionProbability run after run), and could never
 * take the reading back once the series dissolved.
 */
function typeBeforeRecurrence(current: Inference<TransactionType>): Inference<TransactionType> {
  if (!isOwnReading(current)) return current;
  const entries = entriesOf(current);
  const scale = 1 - (entries.find((e) => e.value === "subscription")?.probability ?? 0);
  const earlier = entries
    .filter((e) => e.value !== "subscription")
    .map((e) => ({ value: e.value, probability: scale > 0 ? round(e.probability / scale, 6) : 0 }));
  return fromEntries(earlier, current.basis.filter((b) => b !== "recurrence"), "unknown");
}

/**
 * Refine purchase/unknown to "subscription" with probability pSub. The
 * earlier belief keeps its shape: each entry is scaled by 1 − pSub, and its
 * unassigned mass stays unassigned, so nothing collapses and the refinement
 * can be undone exactly (typeBeforeRecurrence).
 */
function refineToSubscription(prior: Inference<TransactionType>, pSub: Probability): Inference<TransactionType> {
  const p = round(pSub);
  const earlier = entriesOf(prior)
    .filter((e) => e.value !== "subscription")
    .map((e) => ({ value: e.value, probability: round(e.probability * (1 - p), 9) }));
  const basis: InferenceBasis[] = ["recurrence", ...prior.basis.filter((x) => x !== "none" && x !== "recurrence")];
  return fromEntries<TransactionType>([{ value: "subscription", probability: p }, ...earlier], basis, "unknown");
}

function sameInference<T extends string>(a: Inference<T>, b: Inference<T>): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-6;
  return (
    a.value === b.value &&
    a.userSet === b.userSet &&
    close(a.confidence, b.confidence) &&
    a.basis.length === b.basis.length &&
    a.basis.every((x, i) => x === b.basis[i]) &&
    a.alternatives.length === b.alternatives.length &&
    a.alternatives.every((x, i) => x.value === b.alternatives[i]!.value && close(x.probability, b.alternatives[i]!.probability))
  );
}

/**
 * The transaction type this detector wants on a candidate, or null to leave
 * it as it is. Members of a likely subscription have purchase/unknown refined
 * to "subscription" (only when that reading is the most likely one). Anything
 * else gets back the belief this detector refined earlier. A user label, or
 * another engine's type, is never touched.
 */
function typeReading(current: Inference<TransactionType>, s: RecurringSeries | null, env: Env): Inference<TransactionType> | null {
  if (current.userSet) return null;
  const prior = typeBeforeRecurrence(current);
  const pSub = s ? s.confidence * s.subscriptionProbability : 0;
  const refines =
    s !== null && (prior.value === "purchase" || prior.value === "unknown") && s.subscriptionProbability >= env.typePatchThreshold && pSub >= 0.5;
  const next = refines ? refineToSubscription(prior, pSub) : prior;
  return sameInference(next, current) ? null : next;
}

/** The temporal type for a member (never asserting one_off from recurrence), or the withdrawal of an earlier reading. */
function temporalReading(current: Inference<TemporalType>, s: RecurringSeries | null): Inference<TemporalType> | null {
  if (current.userSet) return null;
  const next = s ? temporalInference(s) : null;
  if (next && next.value !== "one_off") return sameInference(next, current) ? null : next;
  return isOwnReading(current) ? unknownInference<TemporalType>("one_off") : null;
}

function memberPatch(m: Member, s: RecurringSeries, env: Env): CandidatePatch {
  // Keep the time the link was first made, so re-running detection on an
  // unchanged series yields an identical patch instead of churning every member.
  const prior = m.c.links.find((l) => l.kind === "recurring_series" && l.target === s.id);
  const link: CandidateLink = { kind: "recurring_series", target: s.id, probability: s.confidence, createdAt: prior?.createdAt ?? env.now };
  const temporal = temporalReading(m.c.attributes.temporalType, s);
  const type = typeReading(m.c.transactionType, s, env);
  return {
    links: [link],
    ...(temporal ? { attributes: { temporalType: temporal } } : {}),
    ...(type ? { transactionType: type } : {}),
  };
}

/**
 * A candidate that is no longer in any series: withdraw what this detector
 * said about it earlier. Its series link cannot be removed (a patch only
 * replaces links of the kinds it names), so it is superseded by the same link
 * at probability 0. Null when there is nothing to withdraw.
 */
function withdrawalPatch(c: TransactionCandidate, env: Env): CandidatePatch | null {
  const stale = c.links.filter((l) => l.kind === "recurring_series" && l.probability > 0);
  const temporal = temporalReading(c.attributes.temporalType, null);
  const type = typeReading(c.transactionType, null, env);
  if (stale.length === 0 && !temporal && !type) return null;
  const links = c.links.filter((l) => l.kind === "recurring_series").map((l) => ({ ...l, probability: 0 }));
  return {
    ...(stale.length > 0 ? { links } : {}),
    ...(temporal ? { attributes: { temporalType: temporal } } : {}),
    ...(type ? { transactionType: type } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Detector                                                            */
/* ------------------------------------------------------------------ */

function settingsFrom(opts: RecurringDetectorOptions): Settings {
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  return { ...DEFAULTS, ...defined } as Settings;
}

function compareAlerts(a: RecurringAlert, b: RecurringAlert): number {
  return a.at - b.at || compareStrings(a.kind, b.kind) || compareStrings(a.seriesId, b.seriesId);
}

function detectRecurring(candidates: readonly TransactionCandidate[], context: readonly Observation[], env: Env): RecurringFindings {
  const sorted = [...candidates].sort(byCandidate);
  const resolveKey = createKeyResolver(sorted);

  const groupsByKey = new Map<string, { key: string; currency: string; members: Member[] }>();
  for (const c of sorted) {
    if (!isEligible(c)) continue;
    const key = resolveKey(c);
    if (!key) continue;
    const currency = c.amount!.value.currency;
    const id = `${key}␟${currency}`;
    const g = groupsByKey.get(id) ?? { key, currency, members: [] };
    g.members.push({ c, at: c.timestampEstimated, minor: c.amount!.value.minor, last4: c.instrument?.last4 ?? null });
    groupsByKey.set(id, g);
  }
  const groups = [...groupsByKey.values()].sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.currency, b.currency));

  const billingContext = context.filter((o) => o.kind === "subscription_event" || o.kind === "mandate").sort(byObservation);
  const contextsByGroup = assignContextsToGroups(billingContext, groups);
  const built: Built[] = [];
  for (const g of groups) built.push(...detectGroup(g, contextsByGroup.get(g) ?? [], env));

  // Stable ids: the earliest series of a (key, currency, cadence) owns the plain id.
  built.sort(
    (x, y) =>
      compareStrings(x.group.key, y.group.key) ||
      compareStrings(x.group.currency, y.group.currency) ||
      x.body.firstChargeAt - y.body.firstChargeAt ||
      compareStrings(x.body.memberIds[0] ?? "", y.body.memberIds[0] ?? ""),
  );
  const usedIds = new Set<string>();
  const items: Item[] = built.map((b) => {
    let id = recurringSeriesId(b.group.key, b.group.currency, b.body.cadence);
    if (usedIds.has(id)) id = stableId("rec", b.group.key, b.group.currency, b.body.cadence, b.partition ?? b.body.memberIds[0]);
    usedIds.add(id);
    return { b, s: { id, ...b.body } };
  });

  // Non-billing interactions with each merchant, for dormancy.
  const memberIds = new Set(items.flatMap(({ s }) => s.memberIds));
  const candidateTouches: Array<{ key: string; at: EpochMillis }> = [];
  for (const c of sorted) {
    if (c.direction === "credit" || memberIds.has(c.id)) continue;
    const key = resolveKey(c);
    if (key) candidateTouches.push({ key, at: c.timestampEstimated });
  }
  const contextTouches = context
    .filter((o) => INTERACTION_KINDS.has(o.kind))
    .map((o) => ({ keys: contextKeys(o), at: obsTime(o) }));
  const lastInteraction = (key: string): EpochMillis | null =>
    maxOrNull([
      ...candidateTouches.filter((t) => t.at <= env.now && keysMatch(t.key, key)).map((t) => t.at),
      ...contextTouches.filter((t) => t.at <= env.now && t.keys.some((k) => keysMatch(k, key))).map((t) => t.at),
    ]);
  const earliestVisibleAt = sorted[0]?.timestampEstimated ?? env.now;

  const alerts: RecurringAlert[] = [];
  for (const item of items) {
    for (const alert of [
      upcomingRenewal(item, env),
      priceIncrease(item, env),
      trialConversion(item, env),
      newSubscription(item, env, earliestVisibleAt),
      dormantSubscription(item, env, lastInteraction),
    ]) {
      if (alert) alerts.push(alert);
    }
  }
  alerts.push(...duplicateAlerts(items, env));
  alerts.sort(compareAlerts);

  const patches = new Map<CandidateId, CandidatePatch>();
  for (const { b, s } of items) for (const m of b.members) patches.set(m.c.id, memberPatch(m, s, env));
  for (const c of sorted) {
    if (memberIds.has(c.id)) continue;
    const withdrawal = withdrawalPatch(c, env);
    if (withdrawal) patches.set(c.id, withdrawal);
  }

  return { series: items.map(({ s }) => s), alerts, patches };
}

/**
 * Create a recurring/subscription detector. Deterministic: the same
 * candidates, context and `now` give the same series, ids, alerts and patches,
 * whatever the input order.
 */
export function createRecurringDetector(opts: RecurringDetectorOptions = {}): RecurringDetector {
  const settings = settingsFrom(opts);
  return {
    detect(candidates, context, now) {
      const dates = new Map<EpochMillis, CalendarDate>();
      const dateOf: DateOf = (t) => {
        let d = dates.get(t);
        if (!d) {
          d = calendarDateIn(t, settings.timeZone);
          dates.set(t, d);
        }
        return d;
      };
      return detectRecurring(candidates, context, { ...settings, now, dateOf });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

export interface RecurringCopyOptions {
  readonly now: EpochMillis;
  readonly locale: LocaleTag;
  /** IANA zone for "today"/"tomorrow". Default "UTC". */
  readonly timeZone?: string;
  /** The detector's subscriptionThreshold: below it a renewal is worded as a payment that is due. Default 0.6. */
  readonly subscriptionThreshold?: Probability;
}

const PER_PERIOD: Readonly<Record<Cadence, string>> = {
  weekly: " a week",
  biweekly: " every two weeks",
  semimonthly: " twice a month",
  monthly: " a month",
  bimonthly: " every two months",
  quarterly: " a quarter",
  semiannual: " every six months",
  annual: " a year",
  irregular: "",
};

/** Local calendar days from `now` to `at` (negative when `at` is on an earlier day). */
function daysFromNow(at: EpochMillis, opts: RecurringCopyOptions): number {
  const tz = opts.timeZone ?? "UTC";
  return dayNumber(calendarDateIn(at, tz)) - dayNumber(calendarDateIn(opts.now, tz));
}

function relativeDay(at: EpochMillis, opts: RecurringCopyOptions): string {
  const tz = opts.timeZone ?? "UTC";
  const days = daysFromNow(at, opts);
  if (days === -1) return "yesterday";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return `in ${days} days`;
  return `on ${new Intl.DateTimeFormat(opts.locale, { month: "short", day: "numeric", timeZone: tz }).format(new Date(at))}`;
}

/**
 * One calm, confidence-aware sentence for a recurring alert. It informs and
 * offers a choice, and never judges: "Netflix renews tomorrow for $22.99.
 * Keep or review?" Lower confidence is said as "looks like", and lowest as a
 * question.
 */
export function describeRecurringAlert(alert: RecurringAlert, series: RecurringSeries, opts: RecurringCopyOptions): string {
  const name = series.displayName;
  const amount = alert.amount ? formatMoney(alert.amount, opts.locale) : null;
  const per = PER_PERIOD[series.cadence];
  const tier = confidenceTier(alert.confidence);
  switch (alert.kind) {
    case "upcoming_renewal": {
      const when = relativeDay(alert.at, opts);
      const past = daysFromNow(alert.at, opts) < 0;
      // Rent, bills, loan instalments and investments come round too, and their pre-debit
      // notices raise this alert. "Keep or review?" is a nudge meant for subscriptions.
      if (series.status !== "trial" && series.subscriptionProbability < (opts.subscriptionThreshold ?? DEFAULTS.subscriptionThreshold)) {
        const verb = past ? "was due" : "is due";
        if (tier === "low") return `${past ? "Was" : "Is"} a payment to ${name} due ${when}?${amount ? ` Last time it was ${amount}.` : ""}`;
        if (tier === "medium") return `Looks like ${amount ? `about ${amount} to ${name}` : `a payment to ${name}`} ${verb} ${when}.`;
        return `${amount ? `${amount} to ${name}` : `A payment to ${name}`} ${verb} ${when}.`;
      }
      // A renewal can still be pending a day after its date (posting lag): say it was due, not that it renews today.
      if (past) {
        const trialEnded = series.status === "trial";
        const what = trialEnded ? `${name} trial ended ${when}` : `${name} was due to renew ${when}`;
        if (tier === "low") return `Did ${name} renew ${when}?${amount ? ` Last time it was ${amount}.` : ""}`;
        return `${tier === "medium" ? "Looks like " : ""}${what}${amount ? ` (${amount}${trialEnded ? per : ""})` : ""}. Keep or review?`;
      }
      if (series.status === "trial") {
        return amount ? `${name} trial ends ${when}; after that it's ${amount}${per}. Keep or review?` : `${name} trial ends ${when}. Keep or review?`;
      }
      if (tier === "high") return amount ? `${name} renews ${when} for ${amount}. Keep or review?` : `${name} renews ${when}. Keep or review?`;
      if (tier === "medium") return `Looks like ${name} renews ${when}${amount ? `, about ${amount}` : ""}. Keep or review?`;
      return `Does ${name} renew ${when}?${amount ? ` Last time it was ${amount}.` : ""}`;
    }
    case "price_increase": {
      if (!amount) return `Looks like ${name} changed its price.`;
      const prev = alert.previousAmount ? formatMoney(alert.previousAmount, opts.locale) : null;
      const pct =
        alert.amount && alert.previousAmount && alert.previousAmount.minor > 0
          ? Math.round((alert.amount.minor / alert.previousAmount.minor - 1) * 100)
          : null;
      const lead = tier === "high" ? `${name} now costs` : `Looks like ${name} now costs`;
      return `${lead} ${amount}${per}${prev ? `, up from ${prev}` : ""}${pct !== null && pct > 0 ? ` (+${pct}%)` : ""}.`;
    }
    case "trial_conversion":
      return tier === "high"
        ? `Your ${name} trial is now a paid plan${amount ? ` at ${amount}${per}` : ""}.`
        : `Looks like your ${name} trial became a paid plan${amount ? ` at ${amount}${per}` : ""}.`;
    case "duplicate_subscription":
      return `${name} appears to be billed more than once${amount ? ` (${amount}${per} on this one)` : ""}. Keep both or review?`;
    case "dormant_subscription":
      return `Still using ${name}? It continues at ${amount ?? "its usual price"}${per}. BRAKE can't see usage, so only you know. Keep or review?`;
    case "new_subscription":
      // During a trial nothing has been charged yet: say what it will cost, not that a charge recurs.
      if (series.status === "trial") {
        return `${tier === "high" ? "New" : "Looks like a new"} ${name} trial${amount ? `; after it, ${amount}${per}` : ""}.`;
      }
      return tier === "high"
        ? `New recurring charge: ${name}${amount ? `, ${amount}${per}` : ""}.`
        : `Looks like a new recurring charge: ${name}${amount ? `, about ${amount}${per}` : ""}.`;
  }
}
