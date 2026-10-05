import { DAY, parseAmount } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CountryCode,
  CurrencyCode,
  Direction,
  InstrumentObservation,
  Money,
  Observation,
  RawSignal,
  SignalAdapter,
  SourceRef,
} from "@brake/core";
import { describeMoney, isRecord, last4Of, normalizeCurrency, scrubDescriptor, text } from "./ledger-mapping";
import { extractAmount, normalizeWhitespace, observationId } from "./shared/text";

/**
 * iOS Shortcuts personal automation, Wallet "Transaction" trigger -> observation.
 *
 * The trigger runs when the user taps an Apple Wallet card and hands the
 * shortcut localized strings for the card or pass, the merchant and the
 * amount; the user's automation passes them to BRAKE's App Intent, whose
 * bridge forwards this payload (docs/research/04 §1). Known behaviour:
 *  - it fires at tap time, but only once the issuer's data reaches Wallet
 *    (seconds; occasionally it times out and never fires);
 *  - it also fires for declined taps, so a tap is evidence of an
 *    *authorization attempt* — stage pending, never confirmed;
 *  - merchant is sometimes blank (" ") and amount sometimes "0.0": both mean
 *    "missing", not "free";
 *  - no transaction id and no explicit currency are exposed. The amount
 *    string's symbol decides the currency; the user's locale/country only
 *    breaks ties ("$", "kr") and supplies a currency for bare numbers.
 */

export interface WalletAutomationPayload {
  /** As the trigger formats it: "₹1,249.00", "$22.99", "22,99 €", "CHF 12.50", or a bare "22.99". */
  readonly amount: string;
  readonly merchant?: string;
  /** Wallet card or pass name chosen by the user/issuer ("Chase Sapphire", "Apple Card"); never a number. */
  readonly card?: string;
  /** Wallet's transaction name, used when `merchant` is blank. */
  readonly name?: string;
  /** When the automation fired: epoch milliseconds (seconds tolerated, as Swift's timeIntervalSince1970). */
  readonly firedAt: number;
}

const ADAPTER_ID = "apple-wallet-automation";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "os_wallet",
  displayName: "Apple Wallet tap automation",
  windows: ["in_spend"],
  platforms: ["ios"],
  requiresCapabilities: ["os:wallet-transaction-automation"],
  privacy: {
    sensitivity: "medium",
    dataCategories: ["amount, merchant and card name of the Apple Pay taps your Shortcuts automation shares"],
    processing: "on_device",
  },
};

/** Card names that reveal the network (shown on many Wallet card names). */
const NETWORKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bvisa\b/i, "visa"],
  [/\b(?:mastercard|master card|mc)\b/i, "mastercard"],
  [/\b(?:amex|american express)\b/i, "amex"],
  [/\bdiscover\b/i, "discover"],
  [/\brupay\b/i, "rupay"],
  [/\b(?:maestro)\b/i, "maestro"],
  [/\b(?:interac)\b/i, "interac"],
  [/\b(?:eftpos)\b/i, "eftpos"],
];

export function createWalletAutomationAdapter(): SignalAdapter<WalletAutomationPayload> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<WalletAutomationPayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload as unknown;
      if (!isRecord(p)) return { status: "rejected", reason: "Wallet automation payload must be an object" };
      const payload = p as unknown as WalletAutomationPayload;
      const at = tapTime(payload.firedAt, signal.receivedAt);

      const parsed = parseLocalizedAmount(text(payload.amount) ?? "", ctx);
      const merchantText = scrubDescriptor(payload.merchant) ?? scrubDescriptor(payload.name);
      if (!parsed && !merchantText) return { status: "ignored", reason: "unsupported_format" };

      // Card names are labels ("Chase Sapphire"); anything number-like is masked.
      const card = scrubDescriptor(payload.card);
      const instrument = card ? instrumentFor(card) : undefined;
      const direction: Direction = parsed?.negative ? "credit" : "debit";
      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "os_wallet",
        connectionId: signal.connectionId,
        provider: "Apple Wallet",
        label: "Apple Wallet tap automation",
      };
      const summary =
        `Apple Wallet: ${card ? `${card} ` : "card "}tapped` +
        (parsed ? ` for ${describeMoney(parsed.money, ctx.locale)}` : "") +
        (merchantText ? ` at ${merchantText}` : "") +
        " (authorization; not yet settled).";

      const observation: Observation = {
        id: observationId(ADAPTER_ID, signal.connectionId, `${at.value}|${text(payload.amount) ?? ""}|${text(payload.merchant) ?? ""}|${text(payload.card) ?? ""}`),
        source,
        kind: "money_movement",
        window: "in_spend",
        // Fires at authorization, including declined taps: never "confirmed".
        stage: "pending",
        receivedAt: signal.receivedAt,
        occurredAt: at,
        direction,
        ...(parsed ? { amount: { value: parsed.money, confidence: parsed.currencyStated ? 0.9 : 0.7 } } : {}),
        ...(merchantText ? { merchant: { raw: merchantText, name: merchantText, channel: "in_store", confidence: 0.8 } } : {}),
        ...(instrument ? { instrument } : {}),
        rail: { family: "card", ...(instrument?.network ? { scheme: instrument.network } : {}) },
        ...(ctx.country ? { country: ctx.country } : {}),
        references: [],
        ...(direction === "debit" ? { typeHints: [{ type: "purchase" as const, confidence: 0.6, reason: "wallet_tap" }] } : {}),
        confidence: parsed && merchantText ? 0.7 : 0.55,
        evidence: { summary },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

/**
 * When the tap happened. `firedAt` comes from the user's Shortcut and the
 * bridge: epoch milliseconds, or seconds (`timeIntervalSince1970`). A value far
 * from receipt is a unit mistake (Swift's 2001-based reference date, a zero
 * default) rather than a real tap time, so receipt time is used instead — the
 * App Intent runs within seconds of the tap.
 */
function tapTime(firedAt: unknown, receivedAt: number): { value: number; confidence: number } {
  if (typeof firedAt === "number" && Number.isFinite(firedAt)) {
    const ms = Math.abs(firedAt) < 1e11 ? Math.round(firedAt * 1000) : Math.round(firedAt);
    if (ms >= receivedAt - 30 * DAY && ms <= receivedAt + DAY) return { value: ms, confidence: 0.85 };
  }
  return { value: receivedAt, confidence: 0.6 };
}

/** Zero code points of the decimal-digit blocks iOS locales format amounts in (Arabic-Indic, Persian, Devanagari, Bengali, …). */
const DIGIT_ZEROS: readonly number[] = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0,
  0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0xff10,
];

/**
 * Bring a localized amount to ASCII digits and separators before parsing:
 * "١٬٢٤٩٫٥٠ ر.س" (ar-SA) -> "1,249.50 ر.س", "₹१,२४९.५०" (mr-IN) -> "₹1,249.50",
 * and the Swiss grouping apostrophe "CHF 1’249.50" (de-CH, U+2019) -> "CHF 1'249.50",
 * which the shared parser would otherwise stop at, reading CHF 1.
 */
function asciiAmount(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    const zero = cp > 0x7f ? DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9) : undefined;
    if (zero !== undefined) out += String(cp - zero);
    else if (ch === "\u066b") out += "."; // Arabic decimal separator
    else if (ch === "\u066c") out += ","; // Arabic thousands separator
    else if (ch === "\u2019" || ch === "\u02bc" || ch === "\u2018") out += "'";
    else if (ch === "\uffe5") out += "\u00a5"; // full-width yen sign (ja-JP "￥1,250")
    else if (ch === "\uff0c") out += ",";
    else if (ch === "\uff0e") out += ".";
    else if (ch === "\u200e" || ch === "\u200f" || ch === "\u061c") continue; // direction marks
    else out += ch;
  }
  return out;
}

let isoCurrencies: ReadonlySet<string> | undefined;

/** An ISO 4217 code written next to the amount ("KWD 1.250") that the shared symbol list may not know. */
function statedIsoCode(s: string): CurrencyCode | undefined {
  if (isoCurrencies === undefined) {
    try {
      isoCurrencies = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      isoCurrencies = new Set();
    }
  }
  const re = /(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) if (isoCurrencies.has(m[0])) return m[0];
  return undefined;
}

export interface LocalizedAmount {
  readonly money: Money;
  readonly negative: boolean;
  /** True when the string itself named the currency (symbol or ISO code). */
  readonly currencyStated: boolean;
}

/** Region subtag of a BCP 47 tag ("en-IN" -> "IN", "zh-Hant-TW" -> "TW"). */
function regionOf(locale: string | undefined): CountryCode | undefined {
  const m = /[-_]([A-Za-z]{2}|\d{3})(?:[-_]|$)/.exec(locale ?? "");
  return m?.[1] && /^[A-Za-z]{2}$/.test(m[1]) ? m[1].toUpperCase() : undefined;
}

/**
 * Currency of Apple Pay markets, for amounts the trigger passes without a
 * symbol ("22.99"). Data pack: a new market is a new entry.
 */
const MARKET_CURRENCY: Readonly<Record<string, CurrencyCode>> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", CL: "CLP", CO: "COP", PE: "PEN", AR: "ARS",
  GB: "GBP", IE: "EUR", FR: "EUR", DE: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", FI: "EUR",
  PT: "EUR", GR: "EUR", LU: "EUR", SK: "EUR", SI: "EUR", EE: "EUR", LV: "EUR", LT: "EUR", HR: "EUR", MT: "EUR", CY: "EUR",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN",
  AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", IL: "ILS", ZA: "ZAR", KZ: "KZT", GE: "GEL", UA: "UAH",
  IN: "INR", JP: "JPY", CN: "CNY", HK: "HKD", TW: "TWD", SG: "SGD", MY: "MYR", KR: "KRW", AU: "AUD", NZ: "NZD",
  EG: "EGP", JO: "JOD", OM: "OMR", MA: "MAD", AZ: "AZN", AM: "AMD", MO: "MOP", VN: "VND", CR: "CRC", UY: "UYU",
  TR: "TRY", TH: "THB", ID: "IDR", PH: "PHP",
};

/**
 * Currencies written with a bare "$" in their own market (pesos and non-US
 * dollars). In es-CL "$1.250" is CLP 1,250; the shared symbol table only knows
 * a few dollar countries and would read it as USD 1,250.00. A foreign dollar
 * amount is formatted with a prefix there ("US$12,00"), so a bare "$" is local.
 */
const DOLLAR_SIGN_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
  "USD", "CAD", "AUD", "NZD", "SGD", "HKD", "TWD", "MXN", "CLP", "COP", "ARS", "UYU", "DOP", "BSD", "BBD", "BZD", "JMD",
  "TTD", "XCD", "BMD", "KYD", "FJD", "NAD", "BND", "LRD", "CVE",
]);

function localeCurrency(country: CountryCode | undefined): CurrencyCode | undefined {
  return country ? MARKET_CURRENCY[country] : undefined;
}

/** Decimal separator of a locale ("de-DE" -> ","), used only when the string alone is ambiguous. */
function decimalSeparator(locale: string | undefined): "." | "," | undefined {
  if (!locale) return undefined;
  try {
    const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((x) => x.type === "decimal")?.value;
    return part === "," ? "," : part === "." ? "." : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the trigger's localized amount. A currency symbol or ISO code in the
 * string wins; `ctx.country` (or the locale's region) breaks ties for shared
 * symbols; a bare number takes `ctx.defaultCurrency`. Zero is treated as
 * missing (a known trigger failure mode).
 */
export function parseLocalizedAmount(raw: string, ctx: Pick<AdapterContext, "country" | "locale" | "defaultCurrency">): LocalizedAmount | null {
  const s = normalizeWhitespace(asciiAmount(String(raw ?? "").slice(0, 400))).slice(0, 200);
  if (!s) return null;
  // The trigger's amount is a formatted number plus at most a currency symbol or code ("د.إ.",
  // "CHF", "kr"); a string with words in it ("UPI/627712345678/…") is not an amount at all.
  if ((s.match(/\p{L}/gu) ?? []).length > 6) return null;
  const negative = /^[-−(]|^[^\d]*[-−]\s*\d/.test(s);
  const country = ctx.country ?? regionOf(ctx.locale);
  const stated = extractAmount(s, { ...(country ? { country } : {}) });
  let money: Money | null = stated?.money ?? null;
  const local = localeCurrency(country);
  if (stated && money && local && local !== money.currency && DOLLAR_SIGN_CURRENCIES.has(local) && /(?<![A-Za-z])\$/.test(stated.raw)) {
    const digits = /\d[\d.,\s  ']*/.exec(stated.raw)?.[0]?.trim() ?? "";
    money = parseAmount(digits, local);
  }
  let currencyStated = money !== null;
  if (!money) {
    const iso = statedIsoCode(s);
    const currency = iso ?? normalizeCurrency(ctx.defaultCurrency) ?? localeCurrency(country);
    if (!currency) return null;
    const numeric = /\d[\d.,\s  ']*/.exec(s)?.[0]?.trim() ?? "";
    const sep = decimalSeparator(ctx.locale);
    // Only trust the locale's separator for a lone separator followed by three digits ("1.249" vs "1,249").
    const ambiguous = /^\d{1,3}[.,]\d{3}$/.test(numeric);
    // The device formatted the string, so its locale's separator settles "1.250" (KWD) vs "1.250" (EUR 1,250).
    money = parseAmount(numeric, currency, ambiguous && sep ? { decimalSeparator: sep } : {});
    currencyStated = iso !== undefined;
  }
  // Zero is the trigger's "missing" value; a non-safe integer is a digit run, not a price.
  if (!money || money.minor === 0 || !Number.isSafeInteger(money.minor)) return null;
  return { money, negative, currencyStated };
}

/**
 * The tapped card as an instrument. Wallet card names are user-visible labels,
 * not account ids: the label becomes an opaque `accountRef`, the network and
 * last four digits are kept only when the label itself shows them.
 */
function instrumentFor(label: string): InstrumentObservation {
  const network = NETWORKS.find(([re]) => re.test(label))?.[1];
  const last4 = /(?:[•*xX]{1,}\s?|ending\s(?:in\s)?)(\d{4})\b/i.test(label) ? last4Of(label) : undefined;
  const cardKind = /\bdebit\b/i.test(label) ? "debit" : /\bcredit\b/i.test(label) ? "credit" : undefined;
  return {
    type: "card",
    accountRef: `wallet-card:${label.toLowerCase()}`,
    ...(network ? { network } : {}),
    ...(last4 ? { last4 } : {}),
    ...(cardKind ? { cardKind } : {}),
  };
}
