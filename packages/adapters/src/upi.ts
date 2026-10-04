import { formatMoney, maskTail, parseAmount } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CategoryHint,
  CounterpartyObservation,
  CurrencyCode,
  EpochMillis,
  LocaleTag,
  MerchantChannel,
  MerchantObservation,
  Money,
  Observation,
  Probability,
  RawSignal,
  Reference,
  SignalAdapter,
  SourceRef,
  SubscriptionDetails,
  TypeHint,
} from "@brake/core";
import { knownApp } from "./app-activity";
import { normalizeWhitespace, observationId } from "./shared/text";
import { parseHttpUrl, queryParams, registrableDomain } from "./share";

/**
 * UPI deep links (`upi://pay`, `upi://mandate`) -> payment-intent observations.
 *
 * Parameters follow NPCI's UPI Linking Specification (pa, pn, mc, tid, tr,
 * tn, am, mam, cu, url, mode, purpose, orgid, sign) as catalogued in
 * docs/research/05-payment-rails-and-qr.md §1–3; mandate parameters
 * (mn, amrule, recur, recurvalue, recurtype, validitystart, validityend,
 * block, rev, txnType, umn) follow PSP-aggregator documentation (Setu,
 * Juspay — search results, 2026), since NPCI's mandate URI text is not public.
 *
 * The parser never re-encodes or "fixes" a URI: signed URIs are only valid
 * byte-for-byte, so BRAKE reads them and hands the original string on.
 */

/* ------------------------------------------------------------------ */
/* Parsed model                                                        */
/* ------------------------------------------------------------------ */

/** NPCI initiation modes (`mode`), research 05 §1. Unknown codes are kept raw in `mode`. */
export type UpiInitiationMode =
  | "default"
  | "qr"
  | "secure_qr"
  | "bharat_qr"
  | "intent"
  | "secure_intent"
  | "nfc"
  | "ble"
  | "uhf"
  | "sebi";

const MODES: Readonly<Record<string, UpiInitiationMode>> = {
  "00": "default",
  "01": "qr",
  "02": "secure_qr",
  "03": "bharat_qr",
  "04": "intent",
  "05": "secure_intent",
  "06": "nfc",
  "07": "ble",
  "08": "uhf",
  "15": "sebi",
};

export interface UpiMandateDetails {
  /** `mn`: mandate name shown to the payer. */
  readonly name?: string;
  /** `amrule`: the debit may be up to (`max`) or exactly (`exact`) the amount. */
  readonly amountRule?: "max" | "exact";
  /** `recur`, lower-case ("monthly", "onetime", "aspresented"). */
  readonly recurrence?: string;
  /** ISO 8601 period for calendar recurrences ("P1M"). */
  readonly period?: string;
  readonly recurrenceValue?: string;
  readonly recurrenceType?: "on" | "before" | "after";
  /** ISO dates (YYYY-MM-DD) from DDMMYYYY. */
  readonly validityStart?: string;
  readonly validityEnd?: string;
  readonly blockFunds?: boolean;
  readonly revocable?: boolean;
  /** create / update / revoke / pause / unpause. */
  readonly action?: string;
  /** Unique Mandate Number when the link refers to an existing mandate. */
  readonly umn?: string;
}

export interface UpiPaymentRequest {
  readonly kind: "pay" | "mandate";
  /** `pa`, lower-cased. May embed a phone number: never put it in text, mask it with maskUpiHandle. */
  readonly payeeAddress: string;
  readonly payeeName?: string;
  /** `mc`, 4-digit merchant category code. */
  readonly merchantCode?: string;
  readonly transactionId?: string;
  /** `tr`, the merchant's own reference. */
  readonly transactionRef?: string;
  readonly note?: string;
  /** `am` as a normalised decimal string ("1249.00"); absent for static requests or a zero amount. */
  readonly amount?: string;
  /** `mam`, minimum amount: the payer may pay more, so `amount` is a floor/suggestion. */
  readonly minimumAmount?: string;
  /** `cu`, default INR. */
  readonly currency: CurrencyCode;
  /** `url`, the merchant's reference link (query kept here only so ids can be read; never stored). */
  readonly referenceUrl?: string;
  readonly mode?: string;
  readonly initiationMode?: UpiInitiationMode;
  readonly purpose?: string;
  readonly orgId?: string;
  /** `sign` present. BRAKE cannot verify it (no acquirer keys), so this is a claim, not proof. */
  readonly signed: boolean;
  /** The payer can change the amount (no `am`, or `mam` given). */
  readonly amountEditable: boolean;
  /** Probability the payee is a business (P2M/P2PM) rather than a person (P2P). */
  readonly isMerchant: Probability;
  /** Machine-readable reasons behind `isMerchant` ("mc:5411", "signed", "phone-like-vpa"). */
  readonly merchantSignals: readonly string[];
  readonly mandate?: UpiMandateDetails;
  /** Parameters this parser does not model (UPI 2.0 GST tags etc.), verbatim. `sign` is never kept. */
  readonly extra: Readonly<Record<string, string>>;
}

export type UpiParseError = "not_upi" | "unsupported_action" | "missing_payee" | "invalid_payee" | "invalid_amount" | "invalid_currency";

export type UpiDecodeResult =
  | { readonly ok: true; readonly request: UpiPaymentRequest }
  | { readonly ok: false; readonly error: UpiParseError };

/* ------------------------------------------------------------------ */
/* Data pack                                                           */
/* ------------------------------------------------------------------ */

/**
 * URI forms that carry NPCI parameters. `upi://` is the standard; PSP
 * app-specific schemes are what merchants use on iOS, where the target of a
 * shared `upi` scheme is undefined (research 05 §1, app schemes unverified).
 */
const URI_FORMS: Readonly<Record<string, Readonly<Record<string, "pay" | "mandate">>>> = {
  upi: { pay: "pay", mandate: "mandate" },
  tez: { "upi/pay": "pay", "upi/mandate": "mandate" },
  gpay: { "upi/pay": "pay" },
  phonepe: { pay: "pay" },
  paytmmp: { pay: "pay" },
};

/**
 * VPA handles that only business accounts get (observed formats, unverified
 * as rules): PhonePe-for-Business "Q…@ybl", Paytm merchant QR "paytmqr…",
 * BharatPe, Google Pay for Business "@okbiz…", Razorpay virtual VPAs.
 */
const MERCHANT_HANDLE_PATTERNS: readonly RegExp[] = [
  /^q\d{6,}@ybl$/,
  /^paytmqr[a-z0-9]+@paytm$/,
  /^bharatpe[a-z0-9.]*@/,
  /@okbiz[a-z]+$/,
  /\.rzp@/,
];

/** NPCI OC-181: MCC 7407 marks P2PM (small, informal merchants) in the UPI merchant tag. */
const P2PM_MCC = "7407";

/** Recurrences with a calendar period (ISO 8601). */
const RECURRENCE_PERIODS: Readonly<Record<string, string>> = {
  daily: "P1D",
  weekly: "P1W",
  fortnightly: "P2W",
  monthly: "P1M",
  bimonthly: "P2M",
  quarterly: "P3M",
  halfyearly: "P6M",
  yearly: "P1Y",
};

/** MCC prefixes whose mandates are investments rather than subscriptions (SIPs on MCC 6211). */
const MANDATE_TYPE_BY_MCC: Readonly<Record<string, TypeHint["type"]>> = {
  "6211": "investment",
  "6012": "loan_payment",
};

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** `name@psp`: PSP handles are short alphanumerics ("okaxis", "ybl", "paytm"), never domains — which keeps e-mail addresses out. */
const VPA = /^[a-z0-9][a-z0-9._-]{0,254}@[a-z][a-z0-9]{1,63}$/;
const DECIMAL = /^\d{1,13}(?:\.\d{1,2})?$/;

/** True for a syntactically valid UPI virtual payment address (`name@handle`). */
export function isVpa(value: string): boolean {
  return VPA.test(value.trim().toLowerCase());
}

/** A VPA whose local part is a phone number (P2P handles usually are). */
export function isPhoneLikeVpa(vpa: string): boolean {
  const local = vpa.split("@")[0] ?? "";
  return /\d{9,}/.test(local.replace(/[^\d]/g, "")) && /^\+?\d[\d._-]*$/.test(local);
}

/**
 * Payee handles that identify a person are personal data: keep the PSP
 * handle and the last digits only ("9876543210@ybl" -> "••••3210@ybl").
 * Business handles are kept as-is (they are public, and fusion joins on them).
 */
export function maskUpiHandle(vpa: string): string {
  const [local = "", handle = ""] = vpa.split("@");
  return isPhoneLikeVpa(vpa) ? `${maskTail(local)}@${handle}` : vpa;
}

/** Parse a UPI deep link, or null when it is not a valid one. */
export function parseUpiUri(uri: string): UpiPaymentRequest | null {
  const r = decodeUpiUri(uri);
  return r.ok ? r.request : null;
}

/** Like parseUpiUri, but says why a URI was refused. */
export function decodeUpiUri(uri: string): UpiDecodeResult {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^?#]*)\??([^#]*)/i.exec(uri.trim());
  if (!m) return { ok: false, error: "not_upi" };
  const scheme = (m[1] ?? "").toLowerCase();
  const forms = URI_FORMS[scheme];
  if (!forms) return { ok: false, error: "not_upi" };
  const target = (m[2] ?? "").toLowerCase().replace(/\/+$/, "");
  const kind = forms[target];
  if (!kind) return { ok: false, error: "unsupported_action" };

  const params = queryParams(m[3] ?? "");
  const get = (k: string): string | undefined => {
    const v = params.get(k);
    if (v === undefined) return undefined;
    const t = normalizeWhitespace(v);
    return t === "" ? undefined : t;
  };

  const rawPa = get("pa");
  if (!rawPa) return { ok: false, error: "missing_payee" };
  const pa = rawPa.toLowerCase();
  if (!VPA.test(pa)) return { ok: false, error: "invalid_payee" };

  const amount = normalizeDecimal(get("am"));
  if (amount === null) return { ok: false, error: "invalid_amount" };
  const minimumAmount = normalizeDecimal(get("mam"));
  if (minimumAmount === null) return { ok: false, error: "invalid_amount" };
  const cu = get("cu");
  if (cu !== undefined && !/^[A-Za-z]{3}$/.test(cu)) return { ok: false, error: "invalid_currency" };
  const currency = (cu ?? "INR").toUpperCase();

  const mcRaw = get("mc");
  const merchantCode = mcRaw && /^\d{4}$/.test(mcRaw) ? mcRaw : undefined;
  const mode = get("mode");
  const initiationMode = mode ? MODES[mode] : undefined;
  const signed = get("sign") !== undefined;
  const orgId = get("orgid");
  const transactionRef = get("tr");
  const url = get("url");

  const { probability, signals } = merchantProbability({ pa, merchantCode, signed, transactionRef, kind });

  const known = new Set(["pa", "pn", "mc", "tid", "tr", "tn", "am", "mam", "cu", "url", "mode", "purpose", "orgid", "sign", ...MANDATE_KEYS]);
  const extra: Record<string, string> = {};
  for (const [k, v] of params) if (!known.has(k)) extra[k] = v;

  const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
    value === undefined ? {} : ({ [key]: value } as Record<K, V>);

  const request: UpiPaymentRequest = {
    kind,
    payeeAddress: pa,
    ...optional("payeeName", get("pn")),
    ...optional("merchantCode", merchantCode),
    ...optional("transactionId", get("tid")),
    ...optional("transactionRef", transactionRef),
    ...optional("note", get("tn")),
    ...optional("amount", amount),
    ...optional("minimumAmount", minimumAmount),
    currency,
    ...optional("referenceUrl", url),
    ...optional("mode", mode),
    ...optional("initiationMode", initiationMode),
    ...optional("purpose", get("purpose")),
    ...optional("orgId", orgId),
    signed,
    amountEditable: amount === undefined || minimumAmount !== undefined,
    isMerchant: probability,
    merchantSignals: signals,
    ...(kind === "mandate" ? { mandate: parseMandate(get) } : {}),
    extra,
  };
  return { ok: true, request };
}

const MANDATE_KEYS = ["mn", "amrule", "recur", "recurvalue", "recurtype", "validitystart", "validityend", "block", "rev", "txntype", "umn"];

/** "1249" -> "1249.00"; "" / absent / zero -> undefined; malformed -> null. */
function normalizeDecimal(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  if (!DECIMAL.test(value)) return null;
  const [int = "0", frac = ""] = value.split(".");
  const normalized = `${String(Number(int))}.${frac.padEnd(2, "0")}`;
  return /^0\.00$/.test(normalized) ? undefined : normalized;
}

function parseMandate(get: (k: string) => string | undefined): UpiMandateDetails {
  const recur = get("recur")?.toLowerCase().replace(/[\s_-]+/g, "");
  const amrule = get("amrule")?.toLowerCase();
  const recurtype = get("recurtype")?.toLowerCase();
  const flag = (v: string | undefined): boolean | undefined =>
    v === undefined ? undefined : /^(?:y|yes|true|1)$/i.test(v) ? true : /^(?:n|no|false|0)$/i.test(v) ? false : undefined;
  const block = flag(get("block"));
  const rev = flag(get("rev"));
  const out: Record<string, unknown> = {
    name: get("mn"),
    amountRule: amrule === "max" || amrule === "exact" ? amrule : undefined,
    recurrence: recur,
    period: recur ? RECURRENCE_PERIODS[recur] : undefined,
    recurrenceValue: get("recurvalue"),
    recurrenceType: recurtype === "on" || recurtype === "before" || recurtype === "after" ? recurtype : undefined,
    validityStart: ddmmyyyy(get("validitystart")),
    validityEnd: ddmmyyyy(get("validityend")),
    blockFunds: block,
    revocable: rev,
    action: get("txntype")?.toLowerCase(),
    umn: get("umn"),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as UpiMandateDetails;
}

function ddmmyyyy(v: string | undefined): string | undefined {
  const m = v ? /^(\d{2})(\d{2})(\d{4})$/.exec(v) : null;
  if (!m) return undefined;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

interface MerchantFacts {
  readonly pa: string;
  readonly merchantCode?: string;
  readonly signed: boolean;
  readonly transactionRef?: string;
  readonly kind: "pay" | "mandate";
}

/**
 * P2P vs P2M (research 05 §3, strongest first): a real MCC, a signed
 * (verified-merchant) payload, a merchant reference, a business-only handle.
 * A `0000` MCC or a phone-number VPA with nothing else points to a person.
 */
function merchantProbability(f: MerchantFacts): { probability: Probability; signals: string[] } {
  const signals: string[] = [];
  let p = 0.3;
  const phoneLike = isPhoneLikeVpa(f.pa);
  if (phoneLike) {
    p = 0.12;
    signals.push("phone-like-vpa");
  }
  if (MERCHANT_HANDLE_PATTERNS.some((re) => re.test(f.pa))) {
    p = Math.max(p, 0.75);
    signals.push("business-handle");
  }
  if (f.transactionRef) {
    p = Math.max(p, 0.75);
    signals.push("merchant-reference");
  }
  if (f.kind === "mandate") {
    // AutoPay mandates are created by billers; P2P mandates are not a product.
    p = Math.max(p, 0.85);
    signals.push("mandate");
  }
  if (f.merchantCode && f.merchantCode !== "0000") {
    p = Math.max(p, f.merchantCode === P2PM_MCC ? 0.8 : 0.9);
    signals.push(`mc:${f.merchantCode}`);
  }
  if (f.signed) {
    // Unverifiable here, so strong but not decisive.
    p = Math.max(p, 0.92);
    signals.push("signed");
  }
  if (f.merchantCode === "0000" && !f.signed && !f.transactionRef && f.kind === "pay") {
    p = Math.min(p, 0.1);
    signals.push("mc:0000");
  }
  return { probability: p, signals };
}

/* ------------------------------------------------------------------ */
/* Observation building (shared with the QR adapter)                   */
/* ------------------------------------------------------------------ */

/** Where a payment payload was seen and how to present it. Shared by UPI, EMV QR and QR dispatch. */
export interface PaymentSurface {
  readonly source: SourceRef;
  readonly receivedAt: EpochMillis;
  /** When the payload was launched/scanned. */
  readonly at: EpochMillis;
  readonly atConfidence: Probability;
  /** Stable across re-delivery of the same raw signal. */
  readonly naturalKey: string;
  readonly channel: MerchantChannel;
  /** PurchaseIntentDetails.via when a pre-spend intent is emitted ("qr"). */
  readonly via: string;
  /**
   * "checkout": always in-spend (an app launched the payment).
   * "by_amount": in-spend checkout only when the payload fixes an amount, else a pre-spend purchase intent.
   */
  readonly mode: "checkout" | "by_amount";
  /** Opening words of the evidence summary ("Scanned a UPI QR code", "Swiggy opened a UPI payment"). */
  readonly summaryLead: string;
  readonly locale?: LocaleTag;
}

/** Display string for money in evidence summaries. */
export function summaryMoney(m: Money, locale: LocaleTag | undefined): string {
  return formatMoney(m, locale ?? "en");
}

/** Normalised UPI request -> one observation (checkout, purchase intent or mandate). */
export function upiObservation(req: UpiPaymentRequest, s: PaymentSurface): Observation {
  const amount = req.amount ? parseAmount(req.amount, req.currency, { decimalSeparator: "." }) : null;
  const handle = maskUpiHandle(req.payeeAddress);
  const personal = handle !== req.payeeAddress;
  const isMerchant = req.isMerchant >= 0.5;
  const name = req.payeeName;
  const mcc = req.merchantCode && req.merchantCode !== "0000" && req.merchantCode !== P2PM_MCC ? req.merchantCode : undefined;

  const merchant: MerchantObservation | undefined = isMerchant
    ? {
        raw: name ?? handle,
        ...(name ? { name } : {}),
        ...(mcc ? { mcc } : {}),
        handle,
        ...(req.referenceUrl ? websiteOf(req.referenceUrl) : {}),
        channel: s.channel,
        confidence: name ? 0.9 : 0.7,
      }
    : undefined;
  const counterparty: CounterpartyObservation = {
    ...(name ? { name } : {}),
    handle,
    isMerchant: req.isMerchant,
  };

  const references: Reference[] = [];
  // Namespaced by the payee so two merchants' identical bill numbers never collide.
  if (req.transactionRef) references.push({ type: "merchant_reference", value: req.transactionRef, namespace: handle });
  const order = orderIdFrom(req, handle);
  if (order) references.push(order);
  if (req.mandate?.umn) references.push({ type: "mandate_id", value: req.mandate.umn, namespace: "upi" });

  const categoryHints: CategoryHint[] = mcc ? [{ scheme: "mcc", value: mcc, confidence: 0.9 }] : [];
  const typeHints: TypeHint[] = [];
  if (req.kind === "pay") {
    // Signals are recorded weakest-first, so the last business signal is the decisive one.
    const strongest = req.merchantSignals.filter((x) => x !== "phone-like-vpa" && x !== "mc:0000").at(-1);
    if (isMerchant) typeHints.push({ type: "purchase", confidence: req.isMerchant, reason: `upi:${strongest ?? "merchant"}` });
    else typeHints.push({ type: "transfer", transferKind: "p2p_other", confidence: 1 - req.isMerchant, reason: `upi:p2p${req.merchantSignals.length ? `:${req.merchantSignals[0]}` : ""}` });
  } else {
    const t = (req.merchantCode && MANDATE_TYPE_BY_MCC[req.merchantCode]) || "subscription";
    typeHints.push({ type: t, confidence: t === "subscription" ? 0.6 : 0.7, reason: `upi:mandate${req.merchantCode ? `:mc${req.merchantCode}` : ""}` });
  }

  const payee = name ? `${name} (${handle})` : handle;
  const amountText = amount ? summaryMoney(amount, s.locale) : undefined;
  const common = {
    id: observationId(s.source.adapterId, s.source.connectionId, s.naturalKey),
    source: s.source,
    receivedAt: s.receivedAt,
    occurredAt: { value: s.at, confidence: s.atConfidence },
    direction: "debit" as const,
    ...(merchant ? { merchant } : {}),
    counterparty,
    rail: { family: "account_to_account_instant" as const, scheme: "upi" },
    ...(req.currency === "INR" ? { country: "IN" } : {}),
    references,
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    typeHints,
  };

  if (req.kind === "mandate") {
    const subscription: SubscriptionDetails = {
      event: "signup",
      ...(name || req.mandate?.name ? { serviceName: name ?? req.mandate?.name } : {}),
      ...(req.mandate?.period ? { period: req.mandate.period } : {}),
      ...(amount ? { price: amount } : {}),
    };
    const rule = req.mandate?.amountRule === "max" ? "up to " : "";
    return {
      ...common,
      kind: "mandate",
      window: "pre_spend",
      stage: "intent",
      // A mandate's amount is a cap or a fixed debit, never a payment that happened.
      ...(amount ? { amount: { value: amount, confidence: 0.95, approximate: req.mandate?.amountRule === "max" } } : {}),
      subscription,
      confidence: 0.9,
      evidence: {
        summary: `${s.summaryLead}: a UPI AutoPay mandate for ${payee}${amountText ? `, ${rule}${amountText}` : ""}${req.mandate?.recurrence ? ` (${req.mandate.recurrence})` : ""}.`,
      },
    };
  }

  const checkout = s.mode === "checkout" || amount !== null;
  // Only call it a transfer when the payee handle is clearly a person's (phone-number VPA).
  const kindWord = !isMerchant && personal ? "transfer" : "payment";
  const summary = `${s.summaryLead}: UPI ${kindWord} ${amountText ? `of ${amountText}${req.amountEditable ? " (editable)" : ""} ` : ""}to ${payee}${mcc ? `, merchant code ${mcc}` : ""}${req.signed ? ", signed by the merchant (not verified by BRAKE)" : ""}.`;
  if (checkout) {
    return {
      ...common,
      kind: "checkout",
      window: "in_spend",
      stage: "intent",
      ...(amount ? { amount: { value: amount, confidence: 0.95, approximate: req.minimumAmount !== undefined } } : {}),
      // Payee identity is machine-generated and reliable; completion is unknown.
      confidence: 0.95,
      evidence: { summary },
    };
  }
  return {
    ...common,
    kind: "purchase_intent",
    window: "pre_spend",
    stage: "intent",
    intent: { via: s.via, ...(name ? { title: name } : {}) },
    confidence: 0.9,
    evidence: { summary },
  };
}

function websiteOf(url: string): { website?: string } {
  const p = parseHttpUrl(url);
  return p ? { website: registrableDomain(p.host) } : {};
}

const ORDER_IN_TEXT = /\b(?:order|ord|pedido|invoice|inv|bill)\s*(?:id|no\.?|number|num|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9_/-]{3,39})/i;

/**
 * An order id the merchant put into `url` (query or /orders/<id> path) or
 * the note ("Order #402-1234567"). Namespaced by the merchant's domain when a
 * URL is present (matching browser and email order ids), else by the payee.
 */
function orderIdFrom(req: UpiPaymentRequest, handle: string): Reference | null {
  if (req.referenceUrl) {
    const p = parseHttpUrl(req.referenceUrl);
    if (p) {
      const ns = registrableDomain(p.host);
      const params = queryParams(p.query);
      for (const k of ["order_id", "orderid", "order_no", "orderno", "ordernumber", "order", "oid"]) {
        const v = params.get(k);
        if (v && /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(v) && /\d/.test(v)) return { type: "order_id", value: v, namespace: ns };
      }
      const path = /\/orders?\/([A-Za-z0-9][A-Za-z0-9_-]{3,63})(?:\/|$)/i.exec(p.path);
      if (path?.[1] && /\d/.test(path[1])) return { type: "order_id", value: path[1], namespace: ns };
    }
  }
  const m = req.note ? ORDER_IN_TEXT.exec(req.note) : null;
  if (m?.[1] && /\d/.test(m[1])) return { type: "order_id", value: m[1], namespace: handle };
  return null;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export interface UpiIntentPayload {
  readonly uri: string;
  /** Device time the intent reached BRAKE's handler. */
  readonly launchedAt?: EpochMillis;
  /** Calling package (Android `getCallingPackage()`), provenance only. */
  readonly sourceApp?: string;
}

const ADAPTER_ID = "upi-intent";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "payment_intent",
  displayName: "UPI payment links",
  windows: ["in_spend", "pre_spend"],
  platforms: ["android"],
  requiresCapabilities: ["rail:upi"],
  privacy: {
    sensitivity: "high",
    dataCategories: ["UPI payment requests apps hand to your UPI app (payee, amount, note)"],
    processing: "on_device",
  },
};

export function createUpiIntentAdapter(): SignalAdapter<UpiIntentPayload> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<UpiIntentPayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload;
      if (!p || typeof p.uri !== "string") return { status: "rejected", reason: "payload.uri missing" };
      const decoded = decodeUpiUri(p.uri);
      if (!decoded.ok) {
        return decoded.error === "not_upi"
          ? { status: "ignored", reason: "unsupported_format" }
          : { status: "rejected", reason: `invalid UPI link: ${decoded.error}` };
      }
      const at = typeof p.launchedAt === "number" && Number.isFinite(p.launchedAt) ? p.launchedAt : signal.receivedAt;
      const appName = knownApp(p.sourceApp)?.name;
      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "payment_intent",
        connectionId: signal.connectionId,
        provider: "UPI",
        label: "UPI payment request",
      };
      const observation = upiObservation(decoded.request, {
        source,
        receivedAt: signal.receivedAt,
        at,
        atConfidence: p.launchedAt !== undefined ? 0.95 : 0.9,
        naturalKey: `${at}|${p.uri.trim()}`,
        channel: "online",
        via: "upi_intent",
        mode: "checkout",
        summaryLead: appName ? `${appName} opened a UPI request` : p.sourceApp ? "An app opened a UPI request" : "A UPI request was opened",
        ...(ctx.locale ? { locale: ctx.locale } : {}),
      });
      return { status: "observations", observations: [observation] };
    },
  };
}
