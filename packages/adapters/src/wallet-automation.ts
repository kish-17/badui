import { parseAmount } from "@brake/core";
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
      const firedAt = typeof payload.firedAt === "number" && Number.isFinite(payload.firedAt) ? payload.firedAt : undefined;
      const at = firedAt === undefined ? signal.receivedAt : Math.abs(firedAt) < 1e11 ? Math.round(firedAt * 1000) : firedAt;

      const parsed = parseLocalizedAmount(text(payload.amount) ?? "", ctx);
      const merchantText = scrubDescriptor(payload.merchant) ?? scrubDescriptor(payload.name);
      if (!parsed && !merchantText) return { status: "ignored", reason: "unsupported_format" };

      const card = cardLabel(payload.card);
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
        id: observationId(ADAPTER_ID, signal.connectionId, `${at}|${text(payload.amount) ?? ""}|${text(payload.merchant) ?? ""}|${text(payload.card) ?? ""}`),
        source,
        kind: "money_movement",
        window: "in_spend",
        // Fires at authorization, including declined taps: never "confirmed".
        stage: "pending",
        receivedAt: signal.receivedAt,
        occurredAt: { value: at, confidence: 0.85 },
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
};

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
  const s = normalizeWhitespace(raw);
  if (!s) return null;
  const negative = /^[-−(]|^[^\d]*[-−]\s*\d/.test(s);
  const country = ctx.country ?? regionOf(ctx.locale);
  const stated = extractAmount(s, { ...(country ? { country } : {}) });
  let money: Money | null = stated?.money ?? null;
  let currencyStated = money !== null;
  if (!money) {
    const currency = normalizeCurrency(ctx.defaultCurrency) ?? localeCurrency(country);
    if (!currency) return null;
    const numeric = /\d[\d.,\s  ']*/.exec(s)?.[0]?.trim() ?? "";
    const sep = decimalSeparator(ctx.locale);
    // Only trust the locale's separator for a lone separator followed by three digits ("1.249" vs "1,249").
    const ambiguous = /^\d{1,3}[.,]\d{3}$/.test(numeric);
    money = parseAmount(numeric, currency, ambiguous && sep ? { decimalSeparator: sep } : {});
    currencyStated = false;
  }
  if (!money || money.minor === 0) return null;
  return { money, negative, currencyStated };
}

/** Card label safe to keep: tidy, and with any long digit run masked. */
function cardLabel(value: unknown): string | undefined {
  return scrubDescriptor(value);
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
