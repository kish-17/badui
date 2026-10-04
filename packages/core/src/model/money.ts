import type { CurrencyCode, LocaleTag } from "./primitives";

/**
 * An amount of money in integer minor units (paise, cents, yen) plus its
 * ISO 4217 currency. Floating point never represents money inside BRAKE.
 * `minor` is always non-negative; direction (debit/credit) is carried separately.
 */
export interface Money {
  readonly minor: number;
  readonly currency: CurrencyCode;
}

const exponentCache = new Map<string, number>();

/** Number of minor-unit digits for a currency (INR 2, JPY 0, KWD 3). Falls back to 2. */
export function currencyExponent(currency: CurrencyCode): number {
  const code = currency.toUpperCase();
  const cached = exponentCache.get(code);
  if (cached !== undefined) return cached;
  let exp = 2;
  try {
    exp = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    exp = 2;
  }
  exponentCache.set(code, exp);
  return exp;
}

export function money(minor: number, currency: CurrencyCode): Money {
  if (!Number.isFinite(minor) || !Number.isInteger(minor)) {
    throw new RangeError(`Money minor units must be a finite integer, got ${minor}`);
  }
  return { minor: Math.abs(minor), currency: currency.toUpperCase() };
}

/** Build Money from a major-unit decimal (1249.5 INR -> 124950 paise). */
export function moneyFromMajor(major: number, currency: CurrencyCode): Money {
  const exp = currencyExponent(currency);
  return money(Math.round(Math.abs(major) * 10 ** exp), currency);
}

export function toMajor(m: Money): number {
  return m.minor / 10 ** currencyExponent(m.currency);
}

export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: Math.abs(a.minor - b.minor), currency: a.currency };
}

export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor - b.minor;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new RangeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export interface AmountTolerance {
  /** Absolute tolerance in minor units. */
  readonly absMinor?: number;
  /** Relative tolerance as a fraction of the larger amount (0.02 = 2%). */
  readonly relative?: number;
}

/**
 * True when two amounts in the same currency are within tolerance.
 * Different currencies are never "close" here; FX matching is the caller's job.
 */
export function amountsClose(a: Money, b: Money, tol: AmountTolerance = {}): boolean {
  if (a.currency !== b.currency) return false;
  const diff = Math.abs(a.minor - b.minor);
  const abs = tol.absMinor ?? 0;
  const rel = (tol.relative ?? 0) * Math.max(a.minor, b.minor);
  return diff <= Math.max(abs, rel);
}

/** Relative difference |a-b| / max(a,b); 0 when both are zero. */
export function relativeDifference(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  const max = Math.max(a.minor, b.minor);
  return max === 0 ? 0 : Math.abs(a.minor - b.minor) / max;
}

export interface FormatMoneyOptions {
  /** Drop minor units when they are zero ("₹1,249" rather than "₹1,249.00"). Default true. */
  readonly trimZeroMinor?: boolean;
}

/** Locale-aware formatting: en-IN -> "₹1,249", en-US -> "$22.99". */
export function formatMoney(m: Money, locale: LocaleTag, opts: FormatMoneyOptions = {}): string {
  const exp = currencyExponent(m.currency);
  const major = m.minor / 10 ** exp;
  const trim = opts.trimZeroMinor ?? true;
  const wholeNumber = m.minor % 10 ** exp === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: trim && wholeNumber ? 0 : exp,
    maximumFractionDigits: exp,
  }).format(major);
}

export type DecimalSeparator = "." | ",";

export interface ParseAmountOptions {
  /**
   * Decimal separator used by the source, when known (bank alert formats are
   * usually stable per issuer/country). When omitted the parser infers it.
   */
  readonly decimalSeparator?: DecimalSeparator;
}

/**
 * Parse the numeric part of a human-written amount into minor units.
 *
 * Handles "1,249.00", "1249", "1,00,000.50" (Indian grouping), "1.234,56"
 * (European), "12,50", "1 234,56" and surrounding currency symbols/words.
 * Returns null when no unambiguous number is present.
 *
 * Inference rule when the separator is not given: if both "." and "," occur,
 * the last one is the decimal separator; if only one kind occurs once and is
 * followed by exactly three digits it is treated as a grouping separator,
 * otherwise as the decimal separator.
 */
export function parseAmount(text: string, currency: CurrencyCode, opts: ParseAmountOptions = {}): Money | null {
  // Space-grouped numbers ("1 234,56") are only accepted in strict groups of three
  // so that two adjacent numbers ("1249.00 1234") are never glued together.
  const match = /(?<!\d)(?:\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?!\d)|\d[\d.,  ']*)/.exec(text);
  if (!match) return null;
  const numeric = match[0].replace(/[   ']/g, "").replace(/[.,]+$/, "");
  if (numeric.length === 0) return null;

  let decimalSep: DecimalSeparator | null = opts.decimalSeparator ?? null;
  if (decimalSep === null) {
    const lastDot = numeric.lastIndexOf(".");
    const lastComma = numeric.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      decimalSep = lastDot > lastComma ? "." : ",";
    } else if (lastDot >= 0 || lastComma >= 0) {
      const sep: DecimalSeparator = lastDot >= 0 ? "." : ",";
      const occurrences = numeric.split(sep).length - 1;
      const digitsAfter = numeric.length - numeric.lastIndexOf(sep) - 1;
      decimalSep = occurrences === 1 && digitsAfter !== 3 ? sep : null;
      if (decimalSep === null && occurrences === 1 && digitsAfter === 3 && currencyExponent(currency) === 3) {
        decimalSep = sep;
      }
    }
  }

  let integerPart = numeric;
  let fractionPart = "";
  if (decimalSep !== null) {
    const idx = numeric.lastIndexOf(decimalSep);
    if (idx >= 0) {
      integerPart = numeric.slice(0, idx);
      fractionPart = numeric.slice(idx + 1);
    }
  }
  integerPart = integerPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(integerPart) || !/^\d*$/.test(fractionPart)) return null;

  const exp = currencyExponent(currency);
  if (fractionPart.length > exp) {
    // More precision than the currency supports: round half up on the extra digits.
    const kept = fractionPart.slice(0, exp);
    const roundUp = Number(fractionPart[exp] ?? "0") >= 5;
    const base = Number(integerPart + kept.padEnd(exp, "0"));
    return money(base + (roundUp ? 1 : 0), currency);
  }
  return money(Number(integerPart + fractionPart.padEnd(exp, "0")), currency);
}
