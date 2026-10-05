import { luhnValid, maskTail } from "@brake/core";
import type {
  AmountComponent,
  CategoryHint,
  CounterpartyObservation,
  CurrencyCode,
  MerchantObservation,
  Money,
  Observation,
  PaymentRail,
  Probability,
  Reference,
  TypeHint,
} from "@brake/core";
import { observationId } from "./shared/text";
import { factText, parseAmountSafe } from "./share";
import { isVpa, maskUpiHandle, summaryMoney } from "./upi";
import type { PaymentSurface } from "./upi";

/**
 * EMVCo Merchant-Presented Mode (MPM) QR codes: the TLV format behind Pix,
 * PayNow/SGQR, PromptPay, DuitNow, QRIS, QR Ph, VietQR, KHQR and Bharat QR.
 *
 * Format (EMVCo QR Code Specification for Payment Systems, MPM; tag table in
 * docs/research/05-payment-rails-and-qr.md §4): each data object is a 2-digit
 * id, a 2-digit length and the value; ids 26–51, 62, 64 and 80–99 are
 * templates of nested data objects; tag 63 is a CRC-16/CCITT-FALSE
 * (poly 0x1021, init 0xFFFF) over the whole payload up to and including "6304".
 *
 * National profiles differ only in which merchant-account template carries
 * which globally unique identifier (GUID), so scheme detection is a data
 * table (`EMV_SCHEME_PROFILES`), not code paths per country.
 */

/* ------------------------------------------------------------------ */
/* Parsed model                                                        */
/* ------------------------------------------------------------------ */

export interface EmvDataObject {
  readonly id: string;
  readonly value: string;
}

/** A merchant-account-information object (02–51) or an unreserved template (80–99). */
export interface EmvMerchantAccount {
  readonly tag: string;
  /** Sub-tag 00 of a template: GUID, AID or reverse-domain name ("br.gov.bcb.pix"). */
  readonly guid?: string;
  /** Sub-objects of a template (empty for primitive card-network ids 02–25). */
  readonly fields: Readonly<Record<string, string>>;
  /** Raw value (for 02–25 the network's merchant id). */
  readonly value: string;
}

export interface EmvAdditionalData {
  readonly billNumber?: string;
  readonly mobileNumber?: string;
  readonly storeLabel?: string;
  readonly loyaltyNumber?: string;
  readonly referenceLabel?: string;
  readonly customerLabel?: string;
  readonly terminalLabel?: string;
  readonly purpose?: string;
  readonly consumerDataRequest?: string;
  readonly merchantTaxId?: string;
  readonly merchantChannel?: string;
  /** RFU and payment-system-specific sub-objects (12–99), verbatim. */
  readonly other: Readonly<Record<string, string>>;
}

export interface EmvQrPayload {
  /** Tag 00, always "01". */
  readonly formatIndicator: string;
  /** Tag 01: "11" static (amount entered by the payer) / "12" dynamic (one payment). */
  readonly initiation?: "static" | "dynamic";
  readonly merchantAccounts: readonly EmvMerchantAccount[];
  /** Tag 52, ISO 18245. */
  readonly mcc?: string;
  /** Tag 53, ISO 4217 numeric ("986"). */
  readonly currencyNumeric?: string;
  /** Alpha code resolved from tag 53 ("BRL"), when known. */
  readonly currency?: CurrencyCode;
  /** Tag 54 as written: a decimal string with "." (never parsed to float). */
  readonly amount?: string;
  /** Tags 55–57: tip prompt, fixed convenience fee, percentage fee. */
  readonly tip?: { readonly mode: "prompt" | "fixed" | "percentage"; readonly value?: string };
  /** Tag 58, the merchant's country (may differ from the payer's for cross-border QR). */
  readonly countryCode?: string;
  readonly merchantName?: string;
  readonly merchantCity?: string;
  readonly postalCode?: string;
  readonly additionalData?: EmvAdditionalData;
  /** Tag 64: localised merchant name/city. */
  readonly language?: { readonly preference?: string; readonly merchantName?: string; readonly merchantCity?: string };
  /** Templates 80–99 (national extensions, e.g. KHQR timestamps). */
  readonly unreserved: readonly EmvMerchantAccount[];
  /** Tag 63 value, upper-case hex. */
  readonly crc: string;
  /** Every top-level object in order. */
  readonly objects: readonly EmvDataObject[];
}

export type EmvParseError = "not_emv" | "malformed_tlv" | "missing_crc" | "crc_mismatch";

export type EmvDecodeResult = { readonly ok: true; readonly payload: EmvQrPayload } | { readonly ok: false; readonly error: EmvParseError };

/* ------------------------------------------------------------------ */
/* TLV and CRC                                                         */
/* ------------------------------------------------------------------ */

/**
 * CRC-16/CCITT-FALSE over the UTF-8 bytes of `text` (poly 0x1021, init
 * 0xFFFF, no reflection, no final xor), as 4 upper-case hex digits.
 */
export function emvCrc16(text: string): string {
  let crc = 0xffff;
  for (const byte of utf8(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * UTF-8 encoding without TextEncoder (not in the ES lib; adapters also run in
 * native shells). Like TextEncoder, a lone surrogate encodes as U+FFFD.
 */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const raw = ch.codePointAt(0) ?? 0;
    const cp = raw >= 0xd800 && raw <= 0xdfff ? 0xfffd : raw;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

/**
 * Split a TLV string into data objects. Lengths count characters (code
 * points), which matters for tag 64 names in Thai, Chinese or Khmer.
 */
export function parseEmvTlv(text: string): EmvDataObject[] | null {
  const chars = Array.from(text);
  const out: EmvDataObject[] = [];
  let i = 0;
  while (i < chars.length) {
    if (i + 4 > chars.length) return null;
    const id = chars.slice(i, i + 2).join("");
    const len = chars.slice(i + 2, i + 4).join("");
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(len)) return null;
    const n = Number(len);
    if (i + 4 + n > chars.length) return null;
    out.push({ id, value: chars.slice(i + 4, i + 4 + n).join("") });
    i += 4 + n;
  }
  return out;
}

/** Cheap sniff: an MPM payload starts with the payload-format indicator "000201". */
export function looksLikeEmvQr(text: string): boolean {
  return /^000201/.test(text.trim());
}

/** Parse and CRC-check an EMV MPM QR payload; null when invalid or corrupted. */
export function parseEmvQr(payload: string): EmvQrPayload | null {
  const r = decodeEmvQr(payload);
  return r.ok ? r.payload : null;
}

/** Like parseEmvQr, but says why a payload was refused. */
export function decodeEmvQr(payload: string): EmvDecodeResult {
  const text = payload.trim();
  if (!looksLikeEmvQr(text)) return { ok: false, error: "not_emv" };
  const objects = parseEmvTlv(text);
  if (!objects || objects.length < 2) return { ok: false, error: "malformed_tlv" };
  const last = objects[objects.length - 1];
  if (!last || last.id !== "63" || !/^[0-9A-Fa-f]{4}$/.test(last.value)) return { ok: false, error: "missing_crc" };
  // CRC covers everything up to and including the "6304" of the CRC object itself.
  const covered = text.slice(0, text.length - 4);
  if (emvCrc16(covered) !== last.value.toUpperCase()) return { ok: false, error: "crc_mismatch" };

  const top = new Map<string, string>();
  for (const o of objects) if (!top.has(o.id)) top.set(o.id, o.value);
  const merchantAccounts: EmvMerchantAccount[] = [];
  const unreserved: EmvMerchantAccount[] = [];
  for (const o of objects) {
    const n = Number(o.id);
    if (n >= 2 && n <= 25) merchantAccounts.push({ tag: o.id, fields: {}, value: o.value });
    else if (n >= 26 && n <= 51) merchantAccounts.push(template(o));
    else if (n >= 80 && n <= 99) unreserved.push(template(o));
  }

  const tipCode = top.get("55");
  const tip =
    tipCode === "01"
      ? { mode: "prompt" as const }
      : tipCode === "02"
        ? { mode: "fixed" as const, ...opt("value", top.get("56")) }
        : tipCode === "03"
          ? { mode: "percentage" as const, ...opt("value", top.get("57")) }
          : undefined;
  const initiation: EmvQrPayload["initiation"] = top.get("01") === "11" ? "static" : top.get("01") === "12" ? "dynamic" : undefined;
  const currencyNumeric = top.get("53");
  const currency = currencyNumeric ? NUMERIC_CURRENCIES[currencyNumeric] : undefined;
  const lang = top.has("64") ? subFields(top.get("64") ?? "") : null;

  const result: EmvQrPayload = {
    formatIndicator: top.get("00") ?? "",
    ...opt("initiation", initiation),
    merchantAccounts,
    ...opt("mcc", top.get("52")),
    ...opt("currencyNumeric", currencyNumeric),
    ...opt("currency", currency),
    ...opt("amount", top.get("54")),
    ...opt("tip", tip),
    ...opt("countryCode", top.get("58")?.toUpperCase()),
    ...opt("merchantName", clean(top.get("59"))),
    ...opt("merchantCity", clean(top.get("60"))),
    ...opt("postalCode", top.get("61")),
    ...opt("additionalData", top.has("62") ? additionalData(top.get("62") ?? "") : undefined),
    ...opt(
      "language",
      lang ? { ...opt("preference", lang["00"]), ...opt("merchantName", clean(lang["01"])), ...opt("merchantCity", clean(lang["02"])) } : undefined,
    ),
    unreserved,
    crc: last.value.toUpperCase(),
    objects,
  };
  return { ok: true, payload: result };
}

function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined || value === "" ? {} : ({ [key]: value } as Record<K, V>);
}

/** Names and cities are displayed facts: storable text, never a card-shaped number. */
function clean(v: string | undefined): string | undefined {
  return factText(v, 120);
}

/** Sub-objects of a template; a value that is not valid TLV yields {}. */
function subFields(value: string): Record<string, string> {
  const parsed = parseEmvTlv(value);
  const out: Record<string, string> = {};
  for (const o of parsed ?? []) if (!(o.id in out)) out[o.id] = o.value;
  return out;
}

function template(o: EmvDataObject): EmvMerchantAccount {
  const fields = subFields(o.value);
  const guid = fields["00"];
  return { tag: o.id, ...(guid ? { guid } : {}), fields, value: o.value };
}

const ADDITIONAL_FIELDS: Readonly<Record<string, keyof Omit<EmvAdditionalData, "other">>> = {
  "01": "billNumber",
  "02": "mobileNumber",
  "03": "storeLabel",
  "04": "loyaltyNumber",
  "05": "referenceLabel",
  "06": "customerLabel",
  "07": "terminalLabel",
  "08": "purpose",
  "09": "consumerDataRequest",
  "10": "merchantTaxId",
  "11": "merchantChannel",
};

function additionalData(value: string): EmvAdditionalData {
  const fields = subFields(value);
  const out: Record<string, unknown> = {};
  const other: Record<string, string> = {};
  for (const [id, v] of Object.entries(fields)) {
    const name = ADDITIONAL_FIELDS[id];
    if (name) out[name] = v;
    else other[id] = v;
  }
  return { ...(out as Omit<EmvAdditionalData, "other">), other };
}

/**
 * ISO 4217 numeric -> alpha for currencies seen in QR-payment markets
 * (ISO 4217 list; 356/764/702/458/704/116/840 re-checked in research 05 §4).
 */
const NUMERIC_CURRENCIES: Readonly<Record<string, CurrencyCode>> = {
  "032": "ARS", "036": "AUD", "050": "BDT", "068": "BOB", "096": "BND", "104": "MMK", "116": "KHR", "124": "CAD",
  "144": "LKR", "152": "CLP", "156": "CNY", "170": "COP", "344": "HKD", "356": "INR", "360": "IDR", "392": "JPY",
  "404": "KES", "410": "KRW", "418": "LAK", "458": "MYR", "484": "MXN", "524": "NPR", "554": "NZD", "566": "NGN",
  "586": "PKR", "600": "PYG", "604": "PEN", "608": "PHP", "634": "QAR", "643": "RUB", "682": "SAR", "702": "SGD",
  "704": "VND", "710": "ZAR", "756": "CHF", "764": "THB", "784": "AED", "800": "UGX", "818": "EGP", "826": "GBP",
  "834": "TZS", "840": "USD", "858": "UYU", "901": "TWD", "936": "GHS", "949": "TRY", "950": "XAF", "952": "XOF",
  "978": "EUR", "986": "BRL",
};

/* ------------------------------------------------------------------ */
/* Scheme profiles (data pack)                                         */
/* ------------------------------------------------------------------ */

export type EmvScheme =
  | "pix"
  | "paynow"
  | "sgqr"
  | "promptpay"
  | "duitnow"
  | "qris"
  | "qrph"
  | "vietqr"
  | "khqr"
  | "bharatqr"
  | "upi"
  | "card"
  | "unknown";

export interface EmvSchemeProfile {
  readonly scheme: EmvScheme;
  readonly displayName: string;
  readonly rail: PaymentRail;
  /** Prior that the payee is a business when nothing else says so. */
  readonly merchantPrior: Probability;
  /** Template GUIDs (case-insensitive, exact). */
  readonly guids?: readonly string[];
  /** Template GUID prefixes (case-insensitive). */
  readonly guidPrefixes?: readonly string[];
  /** Country (tag 58) the profile is restricted to. */
  readonly country?: string;
  /** Matches when an account template's sub-tag 00 is a `name@bank` account id (KHQR). */
  readonly accountIdTemplates?: readonly string[];
  /** Matches on card-network templates 02–08 within `country` (Bharat QR). */
  readonly cardNetworkTemplates?: boolean;
  /** Matches on a UPI VPA in any account template within `country`. */
  readonly upiVpa?: boolean;
  /** Per-template merchant priors ("29": person, "30": bill payment). */
  readonly templatePriors?: Readonly<Record<string, Probability>>;
  /** Sub-fields of the matched template that hold the payee's proxy/account id; first present wins. */
  readonly payeeFields?: readonly string[];
  /** The payee field is itself a template: read `account` (and `bank`) inside it (VietQR 38.01). */
  readonly payeeTemplate?: { readonly field: string; readonly bank?: string; readonly account: string };
  /** The payee is the UPI VPA found in any template (Bharat QR, UPI-in-EMV). */
  readonly payeeIsVpa?: boolean;
  /** A proxy-type sub-field whose value says person vs business (PayNow 01: "0" mobile, "2" UEN). */
  readonly proxyTypes?: { readonly field: string; readonly priors: Readonly<Record<string, Probability>> };
  /** Payee ids of this shape are business registrations (Pix CNPJ, 14 digits). */
  readonly businessId?: RegExp;
  /** The payee's own template is in this id range, not the one carrying the national GUID (QRIS: issuer 26–45, NMID in 51). */
  readonly payeeTemplateRange?: readonly [number, number];
  /** Rail when a UPI VPA is present (an interoperable Bharat QR paid from a UPI app). */
  readonly vpaRail?: PaymentRail;
  /** Template sub-field holding a charge-location URL (dynamic Pix 26.25); BRAKE never fetches it. */
  readonly locationField?: string;
}

/**
 * Ordered: the first matching profile wins, so national GUIDs come before the
 * generic UPI/card fallbacks. Sources: research 05 §5 table (Pix BCB manual
 * via community parsers; PromptPay AIDs from dtinth/promptpay-qr; DuitNow,
 * SGQR, QRIS, VietQR, KHQR from community SDKs); QR Ph GUIDs from search
 * results only (unverified against BSP/PPMI documents).
 */
export const EMV_SCHEME_PROFILES: readonly EmvSchemeProfile[] = [
  {
    scheme: "pix",
    displayName: "Pix",
    rail: { family: "account_to_account_instant", scheme: "pix" },
    merchantPrior: 0.5,
    guids: ["br.gov.bcb.pix"],
    payeeFields: ["01"],
    businessId: /^\d{14}$/,
    locationField: "25",
  },
  {
    scheme: "paynow",
    displayName: "PayNow",
    rail: { family: "account_to_account_instant", scheme: "paynow" },
    merchantPrior: 0.5,
    guids: ["sg.paynow"],
    payeeFields: ["02"],
    proxyTypes: { field: "01", priors: { "0": 0.2, "2": 0.85 } },
  },
  {
    scheme: "promptpay",
    displayName: "PromptPay",
    rail: { family: "account_to_account_instant", scheme: "promptpay" },
    merchantPrior: 0.5,
    guids: ["a000000677010111", "a000000677010112", "a000000677010113", "a000000677010114"],
    // Tag 29 is a credit transfer (usually to a person's phone/ID); tag 30 is bill payment (a biller).
    templatePriors: { "29": 0.3, "30": 0.9 },
    payeeFields: ["01", "02", "03"],
  },
  {
    scheme: "duitnow",
    displayName: "DuitNow QR",
    rail: { family: "account_to_account_instant", scheme: "duitnow" },
    merchantPrior: 0.6,
    guids: ["a0000006150001"],
    payeeFields: ["02", "01"],
  },
  // QRIS is merchant-presented only (P2M); payers use bank or e-wallet apps, so the family stays unknown.
  {
    scheme: "qris",
    displayName: "QRIS",
    rail: { family: "unknown", scheme: "qris" },
    merchantPrior: 0.9,
    guids: ["id.co.qris.www"],
    guidPrefixes: ["id.co."],
    payeeFields: ["01"],
    payeeTemplateRange: [26, 45],
  },
  {
    scheme: "qrph",
    displayName: "QR Ph",
    rail: { family: "account_to_account_instant", scheme: "qrph" },
    merchantPrior: 0.5,
    guids: ["ph.ppmi.p2m", "com.p2pqrpay"],
    payeeFields: ["03", "01"],
  },
  {
    scheme: "vietqr",
    displayName: "VietQR",
    rail: { family: "account_to_account_instant", scheme: "napas" },
    merchantPrior: 0.4,
    guids: ["a000000727"],
    payeeTemplate: { field: "01", bank: "00", account: "01" },
  },
  {
    scheme: "khqr",
    displayName: "KHQR",
    rail: { family: "account_to_account_instant", scheme: "bakong" },
    merchantPrior: 0.5,
    country: "KH",
    accountIdTemplates: ["29", "30"],
    // KHQR: 29 individual, 30 merchant.
    templatePriors: { "29": 0.3, "30": 0.9 },
    payeeFields: ["00"],
  },
  // SGQR wraps several schemes; it is named only when no PayNow template is present.
  { scheme: "sgqr", displayName: "SGQR", rail: { family: "unknown", scheme: "sgqr" }, merchantPrior: 0.85, guids: ["sg.sgqr"], payeeFields: ["01"] },
  {
    scheme: "bharatqr",
    displayName: "Bharat QR",
    rail: { family: "card", scheme: "bharatqr" },
    merchantPrior: 0.95,
    country: "IN",
    cardNetworkTemplates: true,
    payeeIsVpa: true,
    vpaRail: { family: "account_to_account_instant", scheme: "upi" },
  },
  { scheme: "upi", displayName: "UPI", rail: { family: "account_to_account_instant", scheme: "upi" }, merchantPrior: 0.6, country: "IN", upiVpa: true, payeeIsVpa: true },
];

const CARD_PROFILE: EmvSchemeProfile = { scheme: "card", displayName: "card", rail: { family: "card" }, merchantPrior: 0.95 };
const UNKNOWN_PROFILE: EmvSchemeProfile = { scheme: "unknown", displayName: "QR", rail: { family: "unknown" }, merchantPrior: 0.5 };

/** EMVCo-assigned merchant-account ids 02–16 (pairs per network). */
const CARD_NETWORKS: Readonly<Record<string, string>> = {
  "02": "visa", "03": "visa", "04": "mastercard", "05": "mastercard", "09": "discover", "10": "discover",
  "11": "amex", "12": "amex", "13": "jcb", "14": "jcb", "15": "unionpay", "16": "unionpay",
};

/** The national/network scheme of an EMV QR, or null when the input is not a valid EMV QR. */
export function detectEmvScheme(payload: string | EmvQrPayload): EmvScheme | null {
  const qr = typeof payload === "string" ? parseEmvQr(payload) : payload;
  return qr ? resolveEmvProfile(qr).profile.scheme : null;
}

/** The profile and the merchant-account template it matched. */
export function resolveEmvProfile(qr: EmvQrPayload): { readonly profile: EmvSchemeProfile; readonly account?: EmvMerchantAccount } {
  const accounts = qr.merchantAccounts;
  for (const profile of EMV_SCHEME_PROFILES) {
    if (profile.country && qr.countryCode !== profile.country) continue;
    const guids = profile.guids?.map((g) => g.toLowerCase()) ?? [];
    const prefixes = profile.guidPrefixes?.map((g) => g.toLowerCase()) ?? [];
    if (guids.length > 0 || prefixes.length > 0) {
      // Exact GUIDs first so "ID.CO.QRIS.WWW" is preferred to an issuer's "ID.CO.*" template.
      const exact = accounts.find((a) => a.guid && guids.includes(a.guid.toLowerCase()));
      const prefixed = exact ?? accounts.find((a) => a.guid && prefixes.some((pre) => a.guid?.toLowerCase().startsWith(pre)));
      if (prefixed) {
        const range = profile.payeeTemplateRange;
        const payTemplate = range ? accounts.find((a) => Number(a.tag) >= range[0] && Number(a.tag) <= range[1]) : undefined;
        return { profile, account: payTemplate ?? prefixed };
      }
      continue;
    }
    if (profile.accountIdTemplates) {
      const account = accounts.find((a) => profile.accountIdTemplates?.includes(a.tag) && /^[^@\s]+@[a-z0-9_.-]+$/i.test(a.fields["00"] ?? ""));
      if (account) return { profile, account };
      continue;
    }
    if (profile.cardNetworkTemplates) {
      const account = accounts.find((a) => Number(a.tag) >= 2 && Number(a.tag) <= 8);
      if (account) return { profile, account };
      continue;
    }
    if (profile.upiVpa) {
      const account = accounts.find((a) => upiVpaOf(a) !== undefined);
      if (account) return { profile, account };
    }
  }
  const card = accounts.find((a) => CARD_NETWORKS[a.tag] !== undefined);
  if (card) return { profile: { ...CARD_PROFILE, rail: { family: "card", scheme: CARD_NETWORKS[card.tag] ?? "card" } }, account: card };
  return { profile: UNKNOWN_PROFILE };
}

/** The UPI VPA in a merchant-account template (Bharat QR 26.01 or any sub-field that is a VPA). */
function upiVpaOf(a: EmvMerchantAccount): string | undefined {
  const values = [a.fields["01"], ...Object.values(a.fields)];
  return values.find((v): v is string => typeof v === "string" && isVpa(v))?.toLowerCase();
}

function anyUpiVpa(qr: EmvQrPayload): string | undefined {
  for (const a of qr.merchantAccounts) {
    const v = upiVpaOf(a);
    if (v) return v;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Observation building                                                */
/* ------------------------------------------------------------------ */

/**
 * Masks payee identifiers that name a person (phone numbers, national ids,
 * e-mail Pix keys); business ids (CNPJ, UEN, MPAN, random EVP keys) stay
 * usable for matching.
 */
export function maskPayeeId(value: string): string {
  const v = value.trim();
  if (v.includes("@")) {
    if (isVpa(v)) return maskUpiHandle(v.toLowerCase());
    const [local = "", domain = ""] = v.split("@");
    return /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ? `${local.charAt(0)}•••@${domain}` : v;
  }
  const digits = v.replace(/\D/g, "");
  // Phone numbers and 11–13 digit personal ids (CPF, Thai national id); 14-digit CNPJ and longer MPANs are businesses.
  if (/^\+?[\d\s().-]{8,}$/.test(v) && digits.length >= 8 && digits.length <= 13) return maskTail(digits);
  // A 13–19 digit id that passes Luhn is card-shaped (QRIS merchant PANs are built that way; a CNPJ can pass by
  // chance). It is masked like a PAN: BRAKE never keeps a full card-number-shaped value, and the store refuses one.
  if (/^\d{13,19}$/.test(v) && luhnValid(v)) return maskTail(v);
  return v;
}

/** The payee's id from the matched template (per the profile's data), before masking. */
function rawPayeeId(qr: EmvQrPayload, profile: EmvSchemeProfile, account: EmvMerchantAccount | undefined): string | undefined {
  if (profile.payeeIsVpa) return anyUpiVpa(qr);
  if (!account) return undefined;
  if (profile.payeeTemplate) {
    const inner = subFields(account.fields[profile.payeeTemplate.field] ?? "");
    return inner[profile.payeeTemplate.account];
  }
  return (profile.payeeFields ?? []).map((f) => account.fields[f]).find((v): v is string => typeof v === "string" && v !== "");
}

/** A display/match handle for the payee, masked when it identifies a person (bank BIN kept as a prefix). */
function payeeHandle(qr: EmvQrPayload, profile: EmvSchemeProfile, account: EmvMerchantAccount | undefined): string | undefined {
  const raw = rawPayeeId(qr, profile, account);
  if (!raw) return undefined;
  if (profile.payeeTemplate && account) {
    // Account numbers inside a beneficiary template are always personal-grade: keep last 4 only.
    const bank = profile.payeeTemplate.bank ? subFields(account.fields[profile.payeeTemplate.field] ?? "")[profile.payeeTemplate.bank] : undefined;
    return `${bank ? `${bank}:` : ""}${maskTail(raw)}`;
  }
  return maskPayeeId(raw);
}

/**
 * Probability the payee is a business: template/scheme prior, then a
 * proxy-type field, then the id's shape (business registration vs a
 * person's phone/national id), then a real MCC. All inputs come from the profile.
 */
function payeeIsMerchant(qr: EmvQrPayload, profile: EmvSchemeProfile, account: EmvMerchantAccount | undefined, handle: string | undefined): Probability {
  let p = (account && profile.templatePriors?.[account.tag]) ?? profile.merchantPrior;
  const proxyType = profile.proxyTypes && account ? account.fields[profile.proxyTypes.field] : undefined;
  if (proxyType !== undefined && profile.proxyTypes?.priors[proxyType] !== undefined) p = profile.proxyTypes.priors[proxyType] ?? p;
  const raw = rawPayeeId(qr, profile, account);
  if (raw && profile.businessId?.test(raw.replace(/[.\/-]/g, ""))) p = Math.max(p, 0.85);
  // A masked (personal-looking) id lowers a weak prior; business-only templates (bill payment, card acceptance) keep theirs.
  else if (raw && handle !== undefined && handle !== raw && !profile.payeeTemplate && p < 0.85) p = Math.min(p, 0.25);
  if (qr.mcc && /^\d{4}$/.test(qr.mcc) && qr.mcc !== "0000") p = Math.max(p, qr.mcc === "7407" ? 0.8 : 0.85);
  return p;
}

/** Final amount: tag 54 plus a fixed (56) or percentage (57) convenience fee. */
function amountOf(qr: EmvQrPayload): { total: Money; breakdown: AmountComponent[]; approximate: boolean } | null {
  // Tag 54 is at most 13 characters ("up to 13" in the EMVCo MPM data-object table); longer is not an amount.
  if (!qr.amount || !qr.currency || qr.amount.length > 13 || !/^\d+(?:\.\d+)?$/.test(qr.amount)) return null;
  const base = parseAmountSafe(qr.amount, qr.currency, { decimalSeparator: "." });
  if (!base || base.minor === 0) return null;
  const tip = qr.tip;
  if (tip?.mode === "fixed" && tip.value && tip.value.length <= 13 && /^\d+(?:\.\d+)?$/.test(tip.value)) {
    const fee = parseAmountSafe(tip.value, qr.currency, { decimalSeparator: "." });
    if (fee) {
      return {
        total: { minor: base.minor + fee.minor, currency: base.currency },
        breakdown: [{ kind: "subtotal", amount: base }, { kind: "fee", amount: fee }],
        approximate: false,
      };
    }
  }
  if (tip?.mode === "percentage" && tip.value && /^\d{1,2}(?:\.\d{1,2})?$/.test(tip.value)) {
    const fee = { minor: Math.round((base.minor * Number(tip.value)) / 100), currency: base.currency };
    return { total: { minor: base.minor + fee.minor, currency: base.currency }, breakdown: [{ kind: "subtotal", amount: base }, { kind: "fee", amount: fee }], approximate: false };
  }
  // A tip prompt means the payer may add to the amount.
  return { total: base, breakdown: [], approximate: tip?.mode === "prompt" };
}

/** Parsed EMV QR -> checkout (amount-bearing/dynamic) or pre-spend purchase intent (static, no amount). */
export function emvObservation(qr: EmvQrPayload, s: PaymentSurface): Observation {
  const { profile, account } = resolveEmvProfile(qr);
  const amount = amountOf(qr);
  const handle = payeeHandle(qr, profile, account);
  const isMerchant = payeeIsMerchant(qr, profile, account, handle);
  const raw = qr.merchantName ?? handle ?? profile.displayName;
  const localized = qr.language?.merchantName;
  const displayName = localized ?? qr.merchantName;
  const mcc = qr.mcc && /^\d{4}$/.test(qr.mcc) && qr.mcc !== "0000" && qr.mcc !== "7407" ? qr.mcc : undefined;
  // Bharat QR lists card-network ids first; its UPI VPA can sit in any template (26 by convention).
  const upiVpa = profile.payeeIsVpa ? anyUpiVpa(qr) : undefined;
  const rail: PaymentRail = upiVpa && profile.vpaRail ? profile.vpaRail : profile.rail;

  const merchant: MerchantObservation | undefined =
    isMerchant >= 0.5
      ? {
          raw,
          ...(displayName ? { name: displayName } : {}),
          ...(mcc ? { mcc } : {}),
          ...(handle ? { handle } : {}),
          channel: s.channel,
          confidence: qr.merchantName ? 0.9 : 0.6,
        }
      : undefined;
  const counterparty: CounterpartyObservation = {
    ...(displayName ? { name: displayName } : {}),
    ...(handle ? { handle } : {}),
    isMerchant,
  };

  const ns = handle ?? `${profile.scheme}:${(qr.merchantName ?? "").toLowerCase()}`;
  const references: Reference[] = [];
  const ref = qr.additionalData?.referenceLabel;
  // Pix static codes carry "***" as txid: a placeholder, not an id.
  if (ref && !/^\*+$/.test(ref)) references.push({ type: "merchant_reference", value: ref, namespace: ns });
  const bill = qr.additionalData?.billNumber;
  if (bill && !/^\*+$/.test(bill)) references.push({ type: "invoice_id", value: bill, namespace: ns });
  // Bharat QR template 27 carries the UPI transaction reference (`tr`).
  const bharatTr = qr.merchantAccounts.find((a) => a.tag === "27")?.fields["01"];
  if (profile.payeeIsVpa && bharatTr && upiVpa) references.push({ type: "merchant_reference", value: bharatTr, namespace: maskUpiHandle(upiVpa) });

  const categoryHints: CategoryHint[] = mcc ? [{ scheme: "mcc", value: mcc, confidence: 0.85 }] : [];
  const typeHints: TypeHint[] =
    isMerchant >= 0.5
      ? [{ type: "purchase", confidence: isMerchant, reason: `emv:${profile.scheme}${mcc ? `:mcc${mcc}` : ""}` }]
      : [{ type: "transfer", transferKind: "p2p_other", confidence: 1 - isMerchant, reason: `emv:${profile.scheme}:personal-payee` }];

  const amountText = amount ? summaryMoney(amount.total, s.locale) : undefined;
  const where = [displayName, qr.merchantCity].filter(Boolean).join(", ");
  const dynamic = qr.initiation === "dynamic";
  const dynamicUrl = profile.locationField !== undefined && account?.fields[profile.locationField] !== undefined;
  const payee = where || handle;
  const amountPart = amountText
    ? ` of ${amountText}${amount?.approximate ? " before any tip" : ""}`
    : dynamicUrl
      ? " (amount shown in your bank app)"
      : "";
  const summary = `${s.summaryLead}: ${profile.displayName} ${isMerchant < 0.5 && handle !== undefined && handle.includes("•") ? "transfer" : "payment"}${amountPart}${payee ? ` to ${payee}` : ""} (${dynamic ? "dynamic" : "static"} code).`;

  const common = {
    id: observationId(s.source.adapterId, s.source.connectionId, s.naturalKey),
    source: s.source,
    receivedAt: s.receivedAt,
    occurredAt: { value: s.at, confidence: s.atConfidence },
    direction: "debit" as const,
    ...(merchant ? { merchant } : {}),
    counterparty,
    rail,
    ...(qr.countryCode ? { country: qr.countryCode } : {}),
    references,
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    typeHints,
    evidence: { summary },
  };
  if (s.mode === "checkout" || amount !== null || dynamic) {
    return {
      ...common,
      kind: "checkout",
      window: "in_spend",
      stage: "intent",
      ...(amount ? { amount: { value: amount.total, confidence: 0.95, approximate: amount.approximate } } : {}),
      ...(amount && amount.breakdown.length > 0 ? { amountBreakdown: amount.breakdown } : {}),
      confidence: 0.95,
    };
  }
  return {
    ...common,
    kind: "purchase_intent",
    window: "pre_spend",
    stage: "intent",
    intent: { via: s.via, ...(displayName ? { title: displayName } : {}) },
    confidence: 0.9,
  };
}
