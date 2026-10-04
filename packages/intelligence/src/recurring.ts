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
import { DAY, clamp01, formatMoney, localParts, money, stableId, zonedTimeToEpoch } from "@brake/core";
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
 * The day of month a series bills on. A charge on the last day of a short
 * month is consistent with any later anchor (Feb 28 may be "the 31st"), so the
 * anchor is the day consistent with the most charges, ties going to the
 * latest charge's day.
 */
function anchorDayOf(dates: readonly CalendarDate[]): number {
  const latest = dates[dates.length - 1];
  if (!latest) return 1;
  let best = latest.day;
  let bestScore = -1;
  for (let a = 1; a <= 31; a++) {
    let score = 0;
    for (const d of dates) if (consistentWithAnchor(d, a)) score++;
    const preferLatest = consistentWithAnchor(latest, a) && !consistentWithAnchor(latest, best);
    if (score > bestScore || (score === bestScore && preferLatest)) {
      best = a;
      bestScore = score;
    }
  }
  return best;
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

/** Short histories must be all on rhythm; longer ones may have a stray interval in four. */
function enoughOnRhythm(ok: number, total: number): boolean {
  return total <= 3 ? ok === total : ok / total >= 0.75;
}

/**
 * Interval measured in days: k periods (k ≤ 3, one or two missed observations)
 * are accepted only with at least three occurrences, because a single 60-day
 * gap is just as likely to be a bi-monthly bill.
 */
function intervalByDays(spec: CadenceSpec, days: number, occurrences: number): { ok: boolean; k: number } {
  const k = Math.max(1, Math.round(days / spec.periodDays));
  const norm = days / k;
  const ok = k <= 3 && (k === 1 || occurrences >= 3) && norm >= spec.intervalBand[0] && norm <= spec.intervalBand[1];
  return { ok, k };
}

function fitByDays(spec: CadenceSpec, occ: readonly EpochMillis[], intervals: readonly number[]): Fit | null {
  const med = median(intervals);
  if (med < spec.band[0] || med > spec.band[1]) return null;
  const norms: number[] = [];
  let gapped = 0;
  for (const d of intervals) {
    const r = intervalByDays(spec, d, occ.length);
    if (!r.ok) continue;
    norms.push(d / r.k);
    if (r.k > 1) gapped++;
  }
  if (!enoughOnRhythm(norms.length, intervals.length)) return null;
  return { spec, madDays: medianAbsoluteDeviation(norms), gappedFraction: gapped / intervals.length };
}

/**
 * Calendar cadences (monthly and longer). An interval is on rhythm when both
 * charges sit within ±3 days of the anchored billing day and are a whole
 * number of periods apart, or when it fits by day count (30-day cycles that
 * drift against the calendar).
 */
function fitByCalendar(spec: CadenceSpec, occ: readonly EpochMillis[], intervals: readonly number[], dateOf: DateOf): Fit | null {
  const dates = occ.map(dateOf);
  const anchor = anchorDayOf(dates);
  const near = dates.map((d) => nearestAnchor(d, anchor));
  const steps: number[] = [];
  const norms: number[] = [];
  let gapped = 0;
  for (let i = 0; i < intervals.length; i++) {
    const a = near[i]!;
    const b = near[i + 1]!;
    const days = intervals[i]!;
    const step = (b.monthIdx - a.monthIdx) / spec.months;
    const aligned =
      Math.abs(a.offset) <= CALENDAR_TOLERANCE_DAYS &&
      Math.abs(b.offset) <= CALENDAR_TOLERANCE_DAYS &&
      Number.isInteger(step) &&
      step >= 1 &&
      step <= 3 &&
      (step === 1 || occ.length >= 3);
    const byDays = intervalByDays(spec, days, occ.length);
    if (!aligned && !byDays.ok) continue;
    const k = aligned ? step : byDays.k;
    steps.push(k);
    norms.push(days / k);
    if (k > 1) gapped++;
  }
  if (!enoughOnRhythm(steps.length, intervals.length) || median(steps) !== 1) return null;
  const offsets = near.map((n) => n.offset);
  return {
    spec,
    madDays: Math.min(medianAbsoluteDeviation(offsets), medianAbsoluteDeviation(norms)),
    gappedFraction: gapped / intervals.length,
  };
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

/** Store numbers, phone numbers, order and reference codes ("2K4L9", "866-579-7172"). */
function isReferenceToken(t: string): boolean {
  const digits = t.replace(/\D/g, "").length;
  return digits >= 3 || (digits >= 2 && t.length >= 4);
}

const TOKEN_SPLIT = /[^\p{L}\p{M}\p{N}]+/u;

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
  return tokens.slice(0, 2).join(" ");
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
function isStepStable(ms: readonly Member[]): boolean {
  let changes = 0;
  for (let i = 1; i < ms.length; i++) if (relDiff(ms[i]!.minor, ms[i - 1]!.minor) > 0.02) changes++;
  return changes <= Math.floor(0.25 * (ms.length - 1)) || (changes === 1 && ms.length >= 3);
}

/**
 * Re-join amount clusters that follow each other in time and keep one
 * cadence:
 *  - drift ≤ maxDrift: a price increase or small change;
 *  - a larger step up to 2×: an upgrade or downgrade, once the new price has
 *    repeated;
 *  - ≤ 3 low charges before the full price: an intro or trial price.
 * Overlapping clusters are concurrent plans and are never joined.
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
        const drift = relDiff(earlyLast.minor, lateFirst.minor);
        const ratio = earlyLast.minor === 0 ? Number.POSITIVE_INFINITY : lateFirst.minor / earlyLast.minor;
        const smallStep = drift <= env.maxDrift;
        const bigStep = ratio >= 0.5 && ratio <= 2 && late.length >= 2;
        const intro = early.length <= 3 && early.every((m) => m.minor <= 0.5 * lateFirst.minor);
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
  if (cluster.length < 3 || fitObserved(timesOf(cluster), env.dateOf)) return [[...cluster]];
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
  readonly trialContext: boolean;
  readonly trialEndsAt: EpochMillis | null;
  readonly signupContext: boolean;
  /** When the evidence first sufficed to call this a series. */
  readonly confirmAt: EpochMillis;
  readonly last4s: readonly string[];
  readonly body: Omit<RecurringSeries, "id">;
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
 * most 3). Without trial context, a cheap first charge is only an intro
 * price when the rest bills a steady amount. A prorated first utility bill is
 * not a trial.
 */
function splitTrial(members: readonly Member[], price: number | null, trialContext: boolean): { trial: Member[]; full: Member[] } {
  let k = 0;
  while (k < Math.min(3, members.length)) {
    const later = members.slice(k + 1).map((m) => m.minor);
    const ref = price ?? (later.length ? median(later) : null);
    if (ref === null || ref === 0 || members[k]!.minor > 0.5 * ref) break;
    k++;
  }
  const trial = members.slice(0, k);
  const full = members.slice(k);
  if (k > 0 && !trialContext && (full.length === 0 || !isStepStable(full))) return { trial: [], full: [...members] };
  return { trial, full };
}

/** Cadence from context when charges are too few: a stated plan period, else the gap to an announced renewal. */
function contextFit(contexts: readonly Observation[], lastAt: EpochMillis): Fit | null {
  const newestFirst = [...contexts].sort((a, b) => byObservation(b, a));
  for (const o of newestFirst) {
    const spec = o.subscription?.period ? specForPeriod(o.subscription.period) : null;
    if (spec) return { spec, madDays: null, gappedFraction: 0 };
  }
  for (const o of newestFirst) {
    if (subscriptionEvent(o) !== "renewal_upcoming") continue; // trial length is not the billing period
    const due = noticeDueAt(o);
    if (due === null || due <= lastAt) continue;
    const spec = specForDays((due - lastAt) / DAY);
    if (spec) return { spec, madDays: null, gappedFraction: 0 };
  }
  return null;
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
  monthly: 0.3,
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
 */
function subscriptionProbabilityOf(f: SubscriptionFeatures): Probability {
  let z = -0.5;
  if (f.category) z += SUBCATEGORY_LOG_ODDS[f.category] ?? CATEGORY_LOG_ODDS[topLevelCategory(f.category)] ?? 0;
  if (f.mcc) z += mccLogOdds(f.mcc, f.category !== null);
  if (f.keyword) z += 1.5;
  if (f.dominantType === "subscription") z += 1.5;
  if (f.dominantType && NOT_SUBSCRIPTION_TYPES.has(f.dominantType)) z -= 3;
  if (f.userSaysSubscription) z += 5;
  if (f.userSaysRecurringOnly) z -= 3;
  if (f.stepStable && f.amountVariation <= 0.1) z += 1;
  else if (f.amountVariation <= 0.15) z += 0.3;
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
  const types = members.map((m) => {
    const t = m.c.transactionType;
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

function build(draft: Draft, contexts: readonly Observation[], group: Group, env: Env): Built | null {
  const members = [...draft.members].sort(byMember);
  if (members.length === 0) return null;
  const { currency } = group;
  const ctx = [...contexts].sort(byObservation);
  const price = latestContextPrice(ctx, currency);
  const trialContext = ctx.some(isTrialContext);
  const { trial, full } = splitTrial(members, price, trialContext);
  if (full.length === 0 && !trialContext) return null;

  const occurrences = collapseOccurrences(timesOf(members));
  const last = members[members.length - 1]!;
  let fit = fitObserved(timesOf(members), env.dateOf) ?? (full.length >= 2 ? fitObserved(timesOf(full), env.dateOf) : null);
  if (!fit && occurrences.length <= 2) fit = contextFit(ctx, last.at);
  if (!fit) return null;

  const corroborated = ctx.some(isCorroborating) || members.some((m) => memberCorroborates(m.c));
  const notice = ctx.some(isNotice);
  if (occurrences.length < minOccurrences(fit.spec, corroborated, notice)) return null;
  const confidence = seriesConfidence(fit, occurrences.length, corroborated);
  if (confidence < env.minConfidence) return null;

  const spec = fit.spec;
  const periodMs = spec.periodDays * DAY;
  const lastFull = full.length ? full[full.length - 1]! : null;
  const fullAmounts = full.map((m) => m.minor);
  const typicalMinor = full.length ? Math.round(median(fullAmounts)) : (price ?? Math.round(median(members.map((m) => m.minor))));

  // Status.
  const cancelAt = maxOrNull(ctx.filter(isCancellation).map(obsTime));
  const trialEndsAt = latestTrialEnd(ctx);
  const overdueAt = lastFull === null && trialEndsAt !== null ? trialEndsAt + 0.5 * periodMs : last.at + 1.5 * periodMs;
  let status: RecurringSeries["status"];
  if (cancelAt !== null && cancelAt >= last.at - DAY) status = "cancelled";
  else if (env.now > overdueAt) status = "dormant"; // missed > 1.5 periods without a cancellation
  else if (lastFull === null || (trialEndsAt !== null && trialEndsAt > env.now && trialEndsAt > lastFull.at)) status = "trial";
  else status = "active";

  // Next charge: the merchant's own statement beats extrapolation.
  const anchorBase = full.length ? full : members;
  let nextAt: EpochMillis | null =
    spec.months > 0
      ? addMonthsAnchored(last.at, spec.months, anchorDayOf(anchorBase.map((m) => env.dateOf(m.at))), env.timeZone)
      : last.at + periodMs;
  let nextMinor: number | null = lastFull?.minor ?? price;
  let statedNext = false;
  for (const o of ctx) {
    if (!isNotice(o)) continue;
    const due = noticeDueAt(o);
    if (due !== null && due > last.at + DAY / 2) {
      nextAt = due;
      statedNext = true;
      const p = contextPrice(o, currency);
      if (p !== null) nextMinor = p;
    } else if (due === null && subscriptionEvent(o) === "renewal_upcoming" && obsTime(o) > last.at) {
      statedNext = true; // "renews soon" without a date still announces the renewal
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
    trialContext,
    trialEndsAt,
    signupContext: ctx.some((o) => signupEvents.has(subscriptionEvent(o) ?? "")),
    confirmAt,
    last4s: [...new Set(members.map((m) => m.last4).filter((x): x is string => x !== null))].sort(),
    body: {
      merchantKey: group.key,
      displayName: displayNameOf(members, ctx, group.key),
      cadence: spec.cadence,
      periodDays: spec.periodDays,
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
  if (price && price.currency !== g.currency) return false;
  return contextKeys(o).some((k) => keysMatch(k, g.key));
}

/**
 * Give each context observation to one draft: the one sharing a mandate or
 * subscription id, else the one whose price it states, else (no price) the
 * draft that charged most recently.
 */
function assignContexts(drafts: readonly Draft[], contexts: readonly Observation[], currency: string): Map<Draft, Observation[]> {
  const out = new Map<Draft, Observation[]>();
  const latestCharge = (d: Draft) => d.members[d.members.length - 1]?.at ?? 0;
  for (const o of contexts) {
    let target = drafts.find((d) => d.members.some((m) => sharesBillingReference(m.c.references, o.references)));
    if (!target) {
      const p = o.kind === "mandate" ? null : contextPrice(o, currency);
      if (p === null) {
        target = [...drafts].sort((a, b) => latestCharge(b) - latestCharge(a) || b.members.length - a.members.length)[0];
      } else {
        let bestDiff = Number.POSITIVE_INFINITY;
        for (const d of drafts) {
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
  const assigned = assignContexts(proposals, contexts, group.currency);
  for (const d of proposals) accept(build(d, assigned.get(d) ?? [], group, env));

  // Leftovers: first as one variable-amount sequence, then around each unused notice.
  const unclaimed = () => group.members.filter((m) => !claimed.has(m));
  const freeContext = () => contexts.filter((o) => !usedContext.has(o));
  const leftover = unclaimed();
  if (leftover.length === 0) return out;
  const wholeCtx = freeContext().filter((o) => priceCompatible(o, leftover, group.currency));
  if (accept(build({ members: leftover, partition: null }, wholeCtx, group, env))) return out;
  for (const notice of freeContext().filter(isNotice)) {
    if (usedContext.has(notice)) continue;
    const draft = noticeDraft(notice, unclaimed(), env, group.currency);
    if (!draft) continue;
    const related = freeContext().filter((o) => o !== notice && priceCompatible(o, draft.members, group.currency));
    accept(build(draft, [notice, ...related], group, env));
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
  const due = s.nextExpectedAt;
  if (due < env.now - DAY) return null;
  const predicted = due <= env.now + env.renewalLeadDays * DAY && s.subscriptionProbability >= env.subscriptionThreshold;
  if (!b.statedNext && !predicted) return null;
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
 * every month. A merchant's price-change notice either confirms the step or
 * announces it ahead of the charge.
 */
function priceIncrease({ b, s }: Item, env: Env): RecurringAlert | null {
  if (s.status === "cancelled" || s.status === "dormant") return null;
  const currency = s.typicalAmount.currency;
  const thr = env.priceIncreaseThreshold;
  const window = recencyWindowMs(s);
  const full = b.full;
  let alert: RecurringAlert | null = null;
  if (full.length >= 2 && isStepStable(full)) {
    const latest = full[full.length - 1]!.minor;
    let i = full.length - 1;
    while (i > 0 && relDiff(full[i - 1]!.minor, latest) <= thr) i--;
    if (i > 0) {
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
 * Two live subscriptions to the same service:
 *  - the same merchant key and cadence (two cards, or two plans billed side by side);
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
      if (a.s.merchantKey === b.s.merchantKey && a.s.cadence === b.s.cadence) {
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
function dormantSubscription({ s }: Item, env: Env, lastInteraction: (key: string) => EpochMillis | null): RecurringAlert | null {
  if (s.status !== "active" || s.subscriptionProbability < env.subscriptionThreshold) return null;
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
 * Refine purchase/unknown to "subscription". The earlier distribution keeps
 * the remaining mass, so nothing collapses. Only when the subscription
 * reading is the most likely one, and never over a user label.
 */
function subscriptionTypeInference(current: Inference<TransactionType>, s: RecurringSeries, env: Env): Inference<TransactionType> | null {
  if (current.userSet || (current.value !== "purchase" && current.value !== "unknown")) return null;
  if (s.subscriptionProbability < env.typePatchThreshold) return null;
  const pSub = s.confidence * s.subscriptionProbability;
  if (pSub < 0.5) return null;
  const prior: Array<readonly [TransactionType, number]> = [
    [current.value, current.confidence] as const,
    ...current.alternatives.map((a) => [a.value, a.probability] as const),
  ].filter(([v]) => v !== "subscription");
  const mass = prior.reduce((a, [, p]) => a + p, 0);
  const rest = 1 - pSub;
  const scaled = mass > 0 ? prior.map(([v, p]) => [v, (rest * p) / mass] as const) : [[current.value, rest] as const];
  const basis: InferenceBasis[] = ["recurrence", ...current.basis.filter((x) => x !== "none" && x !== "recurrence")];
  return toInference<TransactionType>([["subscription", pSub], ...scaled], basis);
}

function memberPatch(m: Member, s: RecurringSeries, env: Env): CandidatePatch {
  const link: CandidateLink = { kind: "recurring_series", target: s.id, probability: s.confidence, createdAt: env.now };
  const temporal = m.c.attributes.temporalType.userSet ? null : temporalInference(s);
  const type = subscriptionTypeInference(m.c.transactionType, s, env);
  return {
    links: [link],
    ...(temporal && temporal.value !== "one_off" ? { attributes: { temporalType: temporal } } : {}),
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
  const built: Built[] = [];
  for (const g of groups) built.push(...detectGroup(g, billingContext.filter((o) => contextMatchesGroup(o, g)), env));

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
}

const PER_PERIOD: Readonly<Record<Cadence, string>> = {
  weekly: " a week",
  biweekly: " every two weeks",
  monthly: " a month",
  quarterly: " a quarter",
  semiannual: " every six months",
  annual: " a year",
  irregular: "",
};

function relativeDay(at: EpochMillis, opts: RecurringCopyOptions): string {
  const tz = opts.timeZone ?? "UTC";
  const days = dayNumber(calendarDateIn(at, tz)) - dayNumber(calendarDateIn(opts.now, tz));
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
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
      return tier === "high"
        ? `New recurring charge: ${name}${amount ? `, ${amount}${per}` : ""}.`
        : `Looks like a new recurring charge: ${name}${amount ? `, about ${amount}${per}` : ""}.`;
  }
}
