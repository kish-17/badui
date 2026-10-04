import { parseAmount, stableId, zonedTimeToEpoch } from "@brake/core";
import type { AdapterContext, CountryCode, CurrencyCode, EpochMillis, Money } from "@brake/core";

/**
 * Shared, provider-agnostic text helpers for adapters. Country and locale are
 * only ever *hints* for resolving genuinely ambiguous tokens ("$", "kr", "Rs",
 * 04/10/26); no adapter branches on country.
 */

/** Deterministic observation id: re-delivering the same raw signal yields the same id. */
export function observationId(adapterId: string, connectionId: string, naturalKey: string): string {
  return stableId("obs", adapterId, connectionId, naturalKey);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[  \t\r]+/g, " ").replace(/ {2,}/g, " ").trim();
}

interface CurrencyMarker {
  readonly pattern: string;
  readonly currency: CurrencyCode | ((country?: CountryCode) => CurrencyCode);
}

const DOLLAR_BY_COUNTRY: Readonly<Record<string, CurrencyCode>> = {
  US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD", MX: "MXN", TW: "TWD", LR: "LRD",
};
const KRONA_BY_COUNTRY: Readonly<Record<string, CurrencyCode>> = { SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK" };
const RUPEE_BY_COUNTRY: Readonly<Record<string, CurrencyCode>> = { IN: "INR", PK: "PKR", LK: "LKR", NP: "NPR", MU: "MUR" };

/**
 * Currency markers, longest first so "US$" wins over "$" and "Rs." over "Rs".
 * ISO codes are always accepted.
 */
const MARKERS: readonly CurrencyMarker[] = [
  { pattern: "US\\$", currency: "USD" },
  { pattern: "R\\$", currency: "BRL" },
  { pattern: "S\\$", currency: "SGD" },
  { pattern: "A\\$", currency: "AUD" },
  { pattern: "C\\$", currency: "CAD" },
  { pattern: "NZ\\$", currency: "NZD" },
  { pattern: "HK\\$", currency: "HKD" },
  { pattern: "MX\\$", currency: "MXN" },
  { pattern: "GH₵", currency: "GHS" },
  { pattern: "E£", currency: "EGP" },
  { pattern: "KSh\\.?", currency: "KES" },
  { pattern: "Ksh\\.?", currency: "KES" },
  { pattern: "USh", currency: "UGX" },
  { pattern: "TSh", currency: "TZS" },
  { pattern: "Rs\\.?", currency: (c) => (c && RUPEE_BY_COUNTRY[c]) || "INR" },
  { pattern: "Rp\\.?", currency: "IDR" },
  { pattern: "RM", currency: "MYR" },
  { pattern: "zł", currency: "PLN" },
  { pattern: "kr\\.?", currency: (c) => (c && KRONA_BY_COUNTRY[c]) || "SEK" },
  { pattern: "Tk\\.?", currency: "BDT" },
  { pattern: "₹", currency: "INR" },
  { pattern: "€", currency: "EUR" },
  { pattern: "£", currency: "GBP" },
  { pattern: "₦", currency: "NGN" },
  { pattern: "₱", currency: "PHP" },
  { pattern: "฿", currency: "THB" },
  { pattern: "₫", currency: "VND" },
  { pattern: "₩", currency: "KRW" },
  { pattern: "৳", currency: "BDT" },
  { pattern: "₺", currency: "TRY" },
  { pattern: "₽", currency: "RUB" },
  { pattern: "¥", currency: (c) => (c === "CN" ? "CNY" : "JPY") },
  { pattern: "\\$", currency: (c) => (c && DOLLAR_BY_COUNTRY[c]) || "USD" },
];

const ISO_CODES =
  "INR|USD|EUR|GBP|BRL|KES|NGN|IDR|PHP|THB|VND|KRW|JPY|CNY|RMB|MYR|SGD|AUD|CAD|NZD|HKD|MXN|AED|SAR|QAR|CHF|SEK|NOK|DKK|PLN|ZAR|EGP|GHS|TZS|UGX|BDT|PKR|LKR|NPR|TRY|RUB|CZK|HUF|ILS|COP|CLP|PEN|ARS|TWD";

const MARKER_ALTERNATION = [`(?:${ISO_CODES})`, ...MARKERS.map((m) => m.pattern)].join("|");
const NUMBER = "\\d[\\d,.\\u00a0\\u202f' ]*\\d|\\d";

/** "Rs. 1,249.00", "₹1,249", "USD 22.99", "1.234,56 €", "250 kr". */
const AMOUNT_RE = new RegExp(
  `(?<prefix>${MARKER_ALTERNATION})\\s?(?<n1>${NUMBER})|(?<n2>${NUMBER})\\s?(?<suffix>${MARKER_ALTERNATION})(?![A-Za-z])`,
  "gi",
);

function resolveMarker(token: string, country?: CountryCode): CurrencyCode | null {
  const upper = token.toUpperCase();
  if (new RegExp(`^(?:${ISO_CODES})$`).test(upper)) return upper === "RMB" ? "CNY" : upper;
  for (const m of MARKERS) {
    if (new RegExp(`^(?:${m.pattern})$`, "i").test(token)) {
      return typeof m.currency === "function" ? m.currency(country) : m.currency;
    }
  }
  return null;
}

/** The currency named in text, or null. Country is only a tie-breaker for "$", "kr", "Rs", "¥". */
export function detectCurrency(text: string, ctx: Pick<AdapterContext, "country"> = {}): CurrencyCode | null {
  const re = new RegExp(`(?<![A-Za-z])(?:${MARKER_ALTERNATION})(?![A-Za-z])`, "i");
  const m = re.exec(text);
  return m ? resolveMarker(m[0], ctx.country) : null;
}

export interface ExtractedAmount {
  readonly money: Money;
  readonly index: number;
  readonly raw: string;
}

/** Every currency-marked amount in the text, in order of appearance. */
export function extractAmounts(text: string, ctx: Pick<AdapterContext, "country" | "defaultCurrency"> = {}): ExtractedAmount[] {
  const out: ExtractedAmount[] = [];
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(text); m !== null; m = AMOUNT_RE.exec(text)) {
    const g = m.groups ?? {};
    const marker = g.prefix ?? g.suffix;
    const num = g.n1 ?? g.n2;
    if (!marker || !num) continue;
    // A marker glued to letters on its left ("thers 500") is not a currency.
    if (g.prefix && m.index > 0 && /[A-Za-z]/.test(text[m.index - 1] ?? "")) continue;
    const currency = resolveMarker(marker, ctx.country) ?? ctx.defaultCurrency;
    if (!currency) continue;
    const money = parseAmount(num, currency);
    if (money) out.push({ money, index: m.index, raw: m[0] });
  }
  return out;
}

/** The first currency-marked amount, if any. */
export function extractAmount(text: string, ctx: Pick<AdapterContext, "country" | "defaultCurrency"> = {}): ExtractedAmount | null {
  return extractAmounts(text, ctx)[0] ?? null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Countries that write numeric dates month-first. */
const MONTH_FIRST = new Set(["US", "PH", "FM", "PW", "MH"]);

export interface ParsedDateTime {
  readonly at: EpochMillis;
  /** "date" when only a calendar date was present (time defaults to local noon). */
  readonly precision: "datetime" | "date";
}

export interface DateParseOptions {
  readonly country?: CountryCode;
  readonly timeZone?: string;
  /** Force numeric date order when the source's format is known. */
  readonly order?: "DMY" | "MDY" | "YMD";
}

/**
 * Parse the first date (and optional time) in free text: "04-10-26",
 * "04/10/2026 10:41", "2026-10-04T10:41:00", "04-Oct-26", "4 Oct 2026 10:41 AM",
 * "Oct 4, 2026". Interpreted as wall-clock time in `timeZone` (default UTC).
 */
export function parseDateTime(text: string, opts: DateParseOptions = {}): ParsedDateTime | null {
  const date = findDate(text, opts);
  if (!date) return null;
  const rest = text.slice(date.end);
  const time =
    /^\D{0,12}?(?<![\d])(?<h>[01]?\d|2[0-3])[:.](?<mi>[0-5]\d)(?:[:.](?<s>[0-5]\d))?\s*(?<ap>[AaPp]\.?[Mm]\.?)?/.exec(rest) ??
    /(?<![\d])(?<h>[01]?\d|2[0-3]):(?<mi>[0-5]\d)(?::(?<s>[0-5]\d))?\s*(?<ap>[AaPp]\.?[Mm]\.?)?/.exec(text.slice(0, date.start));
  let hour = 12;
  let minute = 0;
  let second = 0;
  let precision: ParsedDateTime["precision"] = "date";
  if (time?.groups) {
    hour = Number(time.groups.h);
    minute = Number(time.groups.mi);
    second = Number(time.groups.s ?? 0);
    const ap = time.groups.ap?.replace(/\./g, "").toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    precision = "datetime";
  }
  const at = zonedTimeToEpoch(
    { year: date.year, month: date.month, day: date.day, hour, minute, second },
    opts.timeZone ?? "UTC",
  );
  return { at, precision };
}

interface FoundDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly start: number;
  readonly end: number;
}

function expandYear(y: number): number {
  if (y >= 100) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function valid(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function findDate(text: string, opts: DateParseOptions): FoundDate | null {
  const candidates: FoundDate[] = [];

  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (valid(y, mo, d)) candidates.push({ year: y, month: mo, day: d, start: iso.index, end: iso.index + iso[0].length });
  }

  const named = /(?<![\w])(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]?([A-Za-z]{3,9})[\s\-/.,]*(\d{2,4})(?!\d)/.exec(text);
  if (named) {
    const month = MONTHS[(named[2] ?? "").toLowerCase()];
    const year = expandYear(Number(named[3]));
    const day = Number(named[1]);
    if (month && valid(year, month, day)) {
      candidates.push({ year, month, day, start: named.index, end: named.index + named[0].length });
    }
  }

  const namedUS = /(?<![\w])([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/.exec(text);
  if (namedUS) {
    const month = MONTHS[(namedUS[1] ?? "").toLowerCase()];
    const day = Number(namedUS[2]);
    const year = Number(namedUS[3]);
    if (month && valid(year, month, day)) {
      candidates.push({ year, month, day, start: namedUS.index, end: namedUS.index + namedUS[0].length });
    }
  }

  const numeric = /(?<![\d.])(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?![\d])/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    const monthFirst = opts.order === "MDY" || (opts.order === undefined && opts.country !== undefined && MONTH_FIRST.has(opts.country));
    let [day, month] = monthFirst ? [b, a] : [a, b];
    // Unambiguous cases override the hint (13/04 must be day-first).
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (valid(year, month, day)) {
      candidates.push({ year, month, day, start: numeric.index, end: numeric.index + numeric[0].length });
    }
  }

  candidates.sort((x, y) => x.start - y.start);
  return candidates[0] ?? null;
}

/** Last 4 digits from a masked or full account/card token ("XX1234", "**** 1234", "A/c no. XXXXXX5678"). */
export function lastFour(text: string): string | undefined {
  const m = /(?:[xX*•]+\s?|ending\s(?:in\s)?|ends\s(?:with\s)?|a\/c\s?(?:no\.?\s?)?)(\d{4})(?!\d)/i.exec(text);
  return m?.[1];
}
