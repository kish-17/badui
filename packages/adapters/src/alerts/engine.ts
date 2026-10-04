import {
  DAY,
  MINUTE,
  clamp01,
  formatMoney,
  isOneTimePasswordMessage,
  localParts,
  maskTail,
  parseAmount,
  redactSensitive,
  stableHash,
} from "@brake/core";
import type {
  AdapterContext,
  AmountComponent,
  CategoryHint,
  ConnectionId,
  CounterpartyObservation,
  CountryCode,
  CurrencyCode,
  Direction,
  EpochMillis,
  Evidence,
  IgnoreReason,
  InstrumentObservation,
  InstrumentType,
  LocaleTag,
  Measured,
  MerchantObservation,
  Money,
  Observation,
  PaymentRail,
  Probability,
  Reference,
  SignalSourceKind,
  SourceRef,
  SpendWindow,
  SubscriptionDetails,
  TransactionStatus,
  TypeHint,
} from "@brake/core";
import { extractAmount, extractAmounts, lastFour, normalizeWhitespace, observationId, parseDateTime } from "../shared/text";
import type { ExtractedAmount } from "../shared/text";
import { ALERT_PACKS, ALERT_VOCABULARY, GENERIC_PACK } from "./packs";
import type { AlertEvent, AlertPack, AlertTemplate, DateOrder, PartyRule, ReferenceRule } from "./packs";

/**
 * Data-driven transaction-alert parser shared by the SMS and Android
 * notification adapters.
 *
 * Pipeline (stream 07, Architecture A): OTP gate → sender verification →
 * classification (promo / bill / mandate / autopay / reversal / declined /
 * refund / cash / debit / credit / balance) → spoof check → template match →
 * heuristic extraction → consistency checks. Every provider fact comes from
 * `./packs.ts`; nothing here branches on a bank, app or country.
 *
 * Decisions worth knowing:
 *  - **Spoofing.** A message from a sender no pack verifies that *claims* a
 *    known issuer (brand words in the text) is returned as `rejected`, not as
 *    a low-confidence observation: echoing "HDFC debited ₹9,999" from a
 *    spoofed SMS would lend a scam credibility, and the reason string lets the
 *    product say "this didn't come from a known HDFC Bank sender". Unknown
 *    senders that claim no known issuer are still parsed, at 0.55 (registered
 *    business ids: DLT headers, short codes, alphanumeric ids) or 0.3 (phone
 *    numbers, unknown display names).
 *  - **Window.** `in_spend` only for a debit on a real-time rail (card, UPI and
 *    other instant A2A, wallet, mobile money) whose own text time is within
 *    two minutes of receipt — i.e. the alert was emitted by the authorization
 *    while the user is plausibly still at the till. Everything else is
 *    `post_spend`; pre-debit notices and mandates are `pre_spend`.
 *  - **Time.** Alert wall-clock times are read in the zone written next to the
 *    time ("1:56 PM ET"), else the issuer's zone from the pack (Indian banks
 *    write IST even when the user roams), else `ctx.timeZone`, else UTC.
 */

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** How the sender of an alert was established. */
export type SenderVerification =
  | "sender_id" // SMS originating address matched a pack's sender patterns
  | "package" // posted by an allow-listed app's own package
  | "display_name" // a messaging app's displayed sender (header or business name) matched a pack
  | "unverified_business" // unknown registered-style sender: DLT header, short code, alphanumeric id
  | "unverified_personal" // unknown phone number
  | "unverified_display"; // unknown display name (contact, unknown RCS agent) or no sender

export type SenderKind = "dlt" | "short_code" | "alphanumeric" | "phone" | "display" | "empty";

export interface SenderInfo {
  readonly raw: string;
  readonly kind: SenderKind;
  /** "HDFCBK" for "AX-HDFCBK-S"; the digits of a short code or phone; the text otherwise. */
  readonly entity: string;
  /** India DLT category suffix: S service, T transactional (OTP), P promotional, G government. */
  readonly dltSuffix?: string;
}

export interface SenderResolution {
  readonly pack: AlertPack;
  readonly verification: SenderVerification;
  readonly sender: SenderInfo;
}

export interface AlertMeta {
  /** SMS originating address, messaging display name or Android package name. */
  readonly senderOrApp: string;
  /** When the message was received/posted (device or service-centre time). Fallback for occurredAt. */
  readonly receivedAt: EpochMillis;
  readonly ctx: AdapterContext;
  /** A pack the caller already established (e.g. from the posting app's package). */
  readonly pack?: AlertPack;
  /** How the caller established `pack`; default "sender_id". */
  readonly verification?: SenderVerification;
  /** Packs for sender resolution and spoof detection; default ALERT_PACKS. */
  readonly packs?: readonly AlertPack[];
  /** "sms": senderOrApp is an SMS address (default); "display": a name a messaging app displayed. */
  readonly senderKind?: "sms" | "display";
}

/**
 * Everything one alert said, normalized. Transient: adapters turn it into
 * observations with `alertObservations` and never persist `normalizedText`
 * except as a redacted, expiring excerpt.
 */
export interface ParsedAlert {
  readonly event: AlertEvent;
  readonly pack: AlertPack;
  readonly verification: SenderVerification;
  readonly sender: SenderInfo;
  readonly templateId?: string;
  readonly normalizedText: string;
  readonly direction?: Direction;
  readonly stage: TransactionStatus;
  readonly amount?: Measured<Money>;
  readonly fee?: Money;
  /** Available balance stated in the alert (never a credit limit). */
  readonly balance?: Money;
  readonly occurredAt: Measured<EpochMillis>;
  /** True when occurredAt came from a date+time written in the alert. */
  readonly timeFromText: boolean;
  /** Zone the alert's wall-clock times were read in. */
  readonly timeZone: string;
  /** Pre-debit notices: when the upcoming charge is due. */
  readonly nextChargeAt?: EpochMillis;
  /** Mandates: ISO 8601 recurrence ("P1M") when stated. */
  readonly period?: string;
  readonly instrument?: InstrumentObservation;
  readonly merchant?: MerchantObservation;
  readonly counterparty?: CounterpartyObservation;
  readonly rail?: PaymentRail;
  readonly references: readonly Reference[];
  readonly typeHints: readonly TypeHint[];
  readonly categoryHints: readonly CategoryHint[];
  readonly country?: CountryCode;
  readonly window: SpendWindow;
  readonly confidence: Probability;
  /** Stable across re-delivery: event + strongest event reference, else a hash of the normalized text. */
  readonly naturalKey: string;
}

export type AlertParseResult =
  | ParsedAlert
  | { readonly ignored: IgnoreReason }
  | { readonly rejected: string };

export function isParsedAlert(r: AlertParseResult): r is ParsedAlert {
  return "event" in r;
}

/* ------------------------------------------------------------------ */
/* Regex plumbing                                                      */
/* ------------------------------------------------------------------ */

const regexCache = new Map<string, RegExp>();

/** Compile (once) a pattern string from a pack or the vocabulary. Default flags "i". */
function re(source: string, flags = "i"): RegExp {
  const key = `${flags}\u0000${source}`;
  let r = regexCache.get(key);
  if (!r) {
    r = new RegExp(source, flags);
    regexCache.set(key, r);
  }
  return r;
}

function reGlobal(source: string, flags = "i"): RegExp {
  return re(source, flags.includes("g") ? flags : `${flags}g`);
}

function anyMatch(patterns: readonly string[], text: string, flags = "i"): boolean {
  return patterns.some((p) => re(p, flags).test(text));
}

/** All matches of a pattern; `matchAll` copies the regex, so the cached instance is never mutated. */
function allMatches(source: string, text: string, flags = "i"): RegExpExecArray[] {
  return [...text.matchAll(reGlobal(source, flags))] as RegExpExecArray[];
}

/**
 * First match that `accept` turns into a value, retrying one character after
 * each rejected match so a bad leftmost candidate ("de R$ 1.250,00 de JOAO")
 * does not hide a good one inside it.
 */
function firstAccepted<T>(source: string, text: string, flags: string, accept: (m: RegExpExecArray) => T | undefined): T | undefined {
  const r = new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
  for (let m = r.exec(text); m !== null; m = r.exec(text)) {
    const v = accept(m);
    if (v !== undefined) return v;
    r.lastIndex = m.index + 1;
  }
  return undefined;
}

const V = ALERT_VOCABULARY;

/* ------------------------------------------------------------------ */
/* Text and sender normalization                                       */
/* ------------------------------------------------------------------ */

/**
 * NFKC (RCS bodies use Mathematical Sans-Serif letters — never strip
 * non-ASCII, which would delete "₹"), multi-line alerts joined with "; ",
 * and two observed gluing quirks undone ("11:00 AMWithdraw", "Confirmed.You").
 */
export function normalizeAlertText(text: string): string {
  const lines = text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let joined = "";
  for (const line of lines) {
    if (joined.length === 0) joined = line;
    else joined += /[.;:,!?]$/.test(joined) ? ` ${line}` : `; ${line}`;
  }
  const unglued = joined
    .replace(/(\d{1,2}:\d{2}(?::\d{2})?\s?[AP]M)(?=[A-Za-z])/g, "$1 ")
    .replace(/([A-Za-z])\.([A-Z][a-z])/g, "$1. $2");
  return normalizeWhitespace(unglued);
}

/** Classify a sender string. `display` = it came from a messaging app's title, so free text is a name. */
export function classifySender(raw: string, display = false): SenderInfo {
  const t = normalizeWhitespace(raw.normalize("NFKC"));
  if (t.length === 0) return { raw: t, kind: "empty", entity: "" };
  const header = /^([A-Z]{2})-([A-Z0-9]{3,9})(?:-([A-Z]))?$/i.exec(t);
  if (header) {
    return {
      raw: t,
      kind: "dlt",
      entity: (header[2] ?? "").toUpperCase(),
      ...(header[3] ? { dltSuffix: header[3].toUpperCase() } : {}),
    };
  }
  const digits = t.replace(/[\s()-]/g, "");
  if (/^\d{3,6}$/.test(digits)) return { raw: t, kind: "short_code", entity: digits };
  if (/^\+?\d{7,15}$/.test(digits)) return { raw: t, kind: "phone", entity: digits };
  if (!display && /^[A-Za-z0-9][A-Za-z0-9.&_-]{1,10}$/.test(t) && /[A-Za-z]/.test(t)) {
    return { raw: t, kind: "alphanumeric", entity: t.toUpperCase() };
  }
  return { raw: t, kind: "display", entity: t };
}

/** Resolve an SMS address or displayed sender to a pack. Unknown senders resolve to the generic pack. */
export function resolveSender(
  senderOrApp: string,
  packs: readonly AlertPack[] = ALERT_PACKS,
  via: "sms" | "display" = "sms",
): SenderResolution {
  const sender = classifySender(senderOrApp, via === "display");
  if (sender.kind !== "empty") {
    for (const pack of packs) {
      if (pack.senders?.some((p) => re(p).test(sender.raw))) {
        return { pack, verification: via === "sms" ? "sender_id" : "display_name", sender };
      }
    }
    if (via === "display") {
      for (const pack of packs) {
        if (pack.displayNames?.some((p) => re(p).test(sender.raw))) return { pack, verification: "display_name", sender };
      }
    }
  }
  const verification: SenderVerification =
    sender.kind === "phone"
      ? "unverified_personal"
      : sender.kind === "display" || sender.kind === "empty"
        ? "unverified_display"
        : "unverified_business";
  return { pack: GENERIC_PACK, verification, sender };
}

/** The pack whose own app posts notifications from `packageName`, if any. */
export function resolvePackage(packageName: string, packs: readonly AlertPack[] = ALERT_PACKS): AlertPack | undefined {
  return packs.find((p) => p.packages?.includes(packageName));
}

export function isVerifiedSender(v: SenderVerification): boolean {
  return v === "sender_id" || v === "package" || v === "display_name";
}

/** The first pack the text claims to come from (brand words, case-sensitive). */
export function claimedIssuer(text: string, packs: readonly AlertPack[] = ALERT_PACKS): AlertPack | undefined {
  return packs.find((p) => p.claims?.some((c) => re(c, "").test(text)));
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

interface DirectionHit {
  readonly direction: Direction;
  readonly index: number;
  readonly strong: boolean;
}

/** Earliest direction verb; ties go to the longer phrase ("sent you" over "sent"). Weak verbs only when no strong one. */
function findDirection(text: string): DirectionHit | undefined {
  const scan = (patterns: readonly string[], direction: Direction): Array<{ direction: Direction; index: number; length: number }> => {
    const out: Array<{ direction: Direction; index: number; length: number }> = [];
    for (const p of patterns) {
      const m = re(p).exec(text);
      if (m) out.push({ direction, index: m.index, length: m[0].length });
    }
    return out;
  };
  const pick = (hits: Array<{ direction: Direction; index: number; length: number }>) =>
    hits.sort((a, b) => a.index - b.index || b.length - a.length)[0];
  const strong = pick([...scan(V.debitStrong, "debit"), ...scan(V.creditStrong, "credit")]);
  if (strong) return { direction: strong.direction, index: strong.index, strong: true };
  const weak = pick([...scan(V.debitWeak, "debit"), ...scan(V.creditWeak, "credit")]);
  return weak ? { direction: weak.direction, index: weak.index, strong: false } : undefined;
}

/** A masked instrument or an event reference: the marks of a real transaction alert. */
function hasTransactionAnchor(text: string): boolean {
  return findMaskedInstrument(text) !== undefined || /\b(?:ref|rrn|utr|upi)\b[^;]{0,14}\d{6,}/i.test(text);
}

type Classification =
  | { readonly kind: "event"; readonly event: AlertEvent; readonly direction?: Direction }
  | { readonly kind: "promotional" }
  | { readonly kind: "bill_due" }
  | { readonly kind: "none" };

function classify(text: string): Classification {
  if (anyMatch(V.promotionalDecisive, text)) return { kind: "promotional" };
  if (anyMatch(V.promotionalSoft, text) && !hasTransactionAnchor(text)) return { kind: "promotional" };

  const dir = findDirection(text);
  if (anyMatch(V.autopayUpcoming, text)) return { kind: "event", event: "autopay_upcoming", direction: "debit" };
  if (anyMatch(V.mandateRevoked, text)) return { kind: "event", event: "mandate_revoked", direction: "debit" };
  if (anyMatch(V.mandateCreated, text)) return { kind: "event", event: "mandate_created", direction: "debit" };
  if (!dir?.strong && anyMatch(V.billDue, text)) return { kind: "bill_due" };
  if (anyMatch(V.reversal, text) && !anyMatch(V.reversalFuture, text)) return { kind: "event", event: "reversal", direction: "credit" };
  if (anyMatch(V.declined, text)) return { kind: "event", event: "declined", direction: dir?.direction ?? "debit" };
  if (anyMatch(V.refund, text)) return { kind: "event", event: "refund", direction: "credit" };
  if (anyMatch(V.cashWithdrawal, text)) return { kind: "event", event: "cash_withdrawal", direction: "debit" };
  if (dir) return { kind: "event", event: dir.direction, direction: dir.direction };
  if (re(V.balanceWords).test(text)) return { kind: "event", event: "balance" };
  return { kind: "none" };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

interface TemplateMatch {
  readonly template: AlertTemplate;
  readonly groups: Readonly<Record<string, string | undefined>>;
}

function matchTemplate(text: string, pack: AlertPack): TemplateMatch | undefined {
  for (const template of pack.templates ?? []) {
    const m = re(template.pattern, template.flags ?? "i").exec(text);
    if (m) return { template, groups: m.groups ?? {} };
  }
  return undefined;
}

/** Templates fix the event only for plain movements; declines, reversals and notices win over them. */
function templateCompatible(cls: AlertEvent, tpl: AlertEvent): boolean {
  const plain: readonly AlertEvent[] = ["debit", "credit", "cash_withdrawal"];
  return cls === tpl || (plain.includes(cls) && plain.includes(tpl));
}

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

type AmountRole = "txn" | "balance" | "limit" | "fee" | "aggregate";

function amountRole(text: string, a: ExtractedAmount): AmountRole {
  const before = text.slice(Math.max(0, a.index - 32), a.index);
  const after = text.slice(a.index + a.raw.length, a.index + a.raw.length + 16);
  if (re(V.limitBefore).test(before)) return "limit";
  if (re(V.balanceBefore).test(before)) return "balance";
  if (re(V.feeBefore).test(before)) return "fee";
  if (re(V.aggregateBefore).test(before) && re(V.aggregateAfter).test(after)) return "aggregate";
  return "txn";
}

interface CurrencyHints {
  readonly country?: CountryCode;
  readonly defaultCurrency?: CurrencyCode;
}

/** A captured amount token, with or without its own currency marker. */
function parseAmountToken(token: string, hints: CurrencyHints): Money | undefined {
  const marked = extractAmount(token, hints);
  if (marked) return marked.money;
  return hints.defaultCurrency ? (parseAmount(token, hints.defaultCurrency) ?? undefined) : undefined;
}

interface AmountFacts {
  readonly amount?: Measured<Money>;
  readonly balance?: Money;
  readonly fee?: Money;
}

/**
 * The transaction amount is the first currency-marked amount that is not a
 * balance, limit, fee or running total ("Avl Bal", "Avl Lmt", "Transaction
 * cost", "You've spent £12.40 today"). Unmarked numbers are accepted only
 * right after a movement verb ("debited by 250.0").
 */
function extractAmountFacts(text: string, hints: CurrencyHints): AmountFacts {
  const all = extractAmounts(text, hints).map((a) => ({ a, role: amountRole(text, a) }));
  const txns = all.filter((x) => x.role === "txn");
  const balance = all.find((x) => x.role === "balance")?.a.money;
  const fee = all.find((x) => x.role === "fee")?.a.money;
  const base = { ...(balance ? { balance } : {}), ...(fee ? { fee } : {}) };
  // A fee alert ("SMS charges Rs.17.70 debited") has only fee-labelled amounts: the fee is the movement.
  const first = txns[0] ?? (balance === undefined ? all.find((x) => x.role === "fee") : undefined);
  if (first) {
    const distinct = new Set(txns.map((x) => `${x.a.money.currency}${x.a.money.minor}`)).size;
    return { ...base, amount: { value: first.a.money, confidence: distinct > 1 ? 0.85 : 0.95 } };
  }
  if (hints.defaultCurrency) {
    const m = /\b(?:debited|credited|paid|sent|spent|withdrawn|received|deducted|charged)\s+(?:by|for|with|of)?\s*(\d[\d,]*(?:\.\d{1,2})?)(?![\d/:-])/i.exec(text);
    const money = m?.[1] ? parseAmount(m[1], hints.defaultCurrency) : null;
    if (money) return { ...base, amount: { value: money, confidence: 0.85 } };
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Instrument                                                          */
/* ------------------------------------------------------------------ */

interface MaskedToken {
  readonly token: string;
  readonly digits: string;
  readonly index: number;
}

/** The user's masked instrument: the earliest masked token not labelled as the other party's account. */
function findMaskedInstrument(text: string): MaskedToken | undefined {
  const found: MaskedToken[] = [];
  for (const p of V.maskedInstrument) {
    for (const m of allMatches(p, text)) {
      const token = m[1];
      if (!token) continue;
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (re(V.counterpartyAccountBefore).test(before)) continue;
      found.push({ token, digits: token.replace(/\D/g, ""), index: m.index });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found[0];
}

/** Only ever the last four digits; three-digit tails ("XXX123") cannot be called last4. */
function last4Of(token: MaskedToken): string | undefined {
  if (token.digits.length < 4) return undefined;
  return lastFour(token.token) ?? token.digits.slice(-4);
}

const ISSUING_KINDS: ReadonlySet<AlertPack["kind"]> = new Set(["bank", "card_issuer", "wallet", "mobile_money", "neobank"]);

function extractInstrument(
  text: string,
  pack: AlertPack,
  tm: TemplateMatch | undefined,
  partyRuleId: string | undefined,
): InstrumentObservation | undefined {
  const acct = tm?.groups.acct;
  const masked: MaskedToken | undefined = acct
    ? { token: acct, digits: acct.replace(/\D/g, ""), index: Math.max(0, text.indexOf(acct)) }
    : findMaskedInstrument(text);
  const last4 = masked ? last4Of(masked) : undefined;

  let type: InstrumentType | undefined = tm?.template.instrument;
  if (!type && masked) {
    const near = text.slice(Math.max(0, masked.index - 30), masked.index + masked.token.length);
    if (re(V.instrumentCard).test(near)) type = "card";
    else if (re(V.instrumentWallet).test(near)) type = "wallet";
    else if (re(V.instrumentAccount).test(near)) type = "bank_account";
  }
  if (!type && re(V.instrumentWallet).test(text) && pack.instrument === "wallet") type = "wallet";
  type ??= pack.instrument;
  // A neobank/issuer push of the form "£X at MERCHANT" is a card payment.
  if (!type && partyRuleId === "at" && (pack.kind === "neobank" || pack.kind === "card_issuer")) type = "card";
  if (!type && last4) type = "other";
  if (!type) return undefined;

  let cardKind: InstrumentObservation["cardKind"];
  let network: string | undefined;
  if (type === "card") {
    cardKind =
      tm?.template.cardKind ??
      (re(V.cardPrepaid).test(text) ? "prepaid" : re(V.cardCredit).test(text) ? "credit" : re(V.cardDebit).test(text) ? "debit" : undefined);
    network = pack.cardNetwork ?? V.cardNetworks.find((n) => re(n.pattern).test(text))?.network;
  }
  return {
    type,
    ...(ISSUING_KINDS.has(pack.kind) ? { issuer: pack.displayName } : {}),
    ...(network ? { network } : {}),
    ...(last4 ? { last4 } : {}),
    ...(cardKind ? { cardKind } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Parties                                                             */
/* ------------------------------------------------------------------ */

interface Party {
  readonly name?: string;
  readonly handle?: string;
  readonly isMerchant: Probability;
  readonly ruleId: string;
  readonly own: boolean;
  readonly fromTemplate: boolean;
}

const CURRENCY_START = /^(?:R\$|Rs\.?|Rp|Ksh|KSh|Tsh|INR|USD|NGN|KES|BRL|IDR|GBP|EUR|BDT|Tk|[₹$£€₦¥])/i;

interface CleanName {
  readonly name?: string;
  readonly personHint: boolean;
  readonly own: boolean;
}

/** Strip phone numbers (third-party personal data), separators and labels; reject non-names. */
function cleanPartyName(raw: string): CleanName {
  let phone = false;
  let n = raw.replace(/\+?\d[\d\s-]{6,}\d/g, (m) => {
    if (m.replace(/\D/g, "").length >= 7) {
      phone = true;
      return " ";
    }
    return m;
  });
  n = normalizeWhitespace(n)
    .replace(/^(?:VPA|the)\s+/i, "")
    .replace(/[\s.,;:\-–]+$/, "")
    .replace(/^[\s.,;:\-–]+/, "");
  if (re(V.ownAccount).test(`to ${n}`) && /^(?:your|own|self)\b/i.test(n)) return { personHint: false, own: true };
  const invalid =
    n.length < 2 ||
    re(V.partyReject).test(n) ||
    /^\d/.test(n) ||
    CURRENCY_START.test(n) ||
    /[xX*•]{2,}\d/.test(n) ||
    /https?:|www\./i.test(n) ||
    !/[A-Za-zÀ-ɏऀ-ॿ]/.test(n);
  // A long number next to a name is a phone number (M-PESA "JOHN DOE 0712345678"): a person.
  // Without a surviving name it was something else (a reference in parentheses).
  if (invalid) return { personHint: false, own: false };
  return { name: n.length > 60 ? n.slice(0, 60).trim() : n, personHint: phone, own: false };
}

/** Mask a personal VPA ("9876543210@ybl" -> "••••3210@ybl"); business handles stay as they are. */
function maskHandle(handle: string): string {
  const at = handle.indexOf("@");
  if (at < 0) return handle;
  const local = handle.slice(0, at);
  return /\d{8,}/.test(local.replace(/\D/g, "")) && /^\+?\d/.test(local) ? `${maskTail(local)}${handle.slice(at)}` : handle;
}

function inferIsMerchant(prior: number | undefined, clean: CleanName, handle: string | undefined, text: string): Probability {
  if (clean.personHint) return 0.05;
  let p = prior ?? 0.5;
  if (clean.name && re(V.businessWords).test(clean.name)) p = Math.max(p, 0.85);
  if (handle) {
    const local = handle.split("@")[0] ?? "";
    if (/^\+?\d{8,}$/.test(local.replace(/[\s-]/g, ""))) p = Math.min(p, 0.15);
    else if (re(V.merchantHandle).test(local)) p = Math.max(p, 0.85);
  }
  if (prior === undefined && p === 0.5 && re(V.transferWords).test(text)) p = 0.3;
  return p;
}

function partyFromTemplate(tm: TemplateMatch, text: string): Party | undefined {
  const rawName = tm.groups.party;
  const vpaGroup = tm.groups.vpa ?? (rawName && /^[\w.-]+@[a-z][a-z0-9]+$/i.test(rawName.trim()) ? rawName.trim() : undefined);
  const clean = rawName && !vpaGroup ? cleanPartyName(rawName) : { personHint: false, own: false };
  if (!clean.name && !vpaGroup) return undefined;
  const role = tm.template.party ?? "infer";
  const isMerchant =
    role === "merchant" ? 0.95 : role === "person" ? 0.05 : inferIsMerchant(0.5, clean, vpaGroup, text);
  return {
    ...(clean.name ? { name: clean.name } : {}),
    ...(vpaGroup ? { handle: vpaGroup } : {}),
    isMerchant: clean.personHint ? 0.05 : isMerchant,
    ruleId: `template:${tm.template.id}`,
    own: clean.own,
    fromTemplate: true,
  };
}

function partyFromRules(text: string, direction: Direction): Party | undefined {
  let own = false;
  for (const rule of V.parties as readonly PartyRule[]) {
    if (rule.directions && !rule.directions.includes(direction)) continue;
    const party = firstAccepted(rule.pattern, text, rule.flags ?? "i", (m): Party | undefined => {
      const vpa = m.groups?.vpa;
      const clean = m.groups?.name ? cleanPartyName(m.groups.name) : { personHint: false, own: false };
      if (clean.own) own = true;
      if (!clean.name && !vpa) return undefined;
      return {
        ...(clean.name ? { name: clean.name } : {}),
        ...(vpa ? { handle: vpa } : {}),
        isMerchant: inferIsMerchant(rule.isMerchant, clean, vpa, text),
        ruleId: rule.id,
        own,
        fromTemplate: false,
      };
    });
    if (party) return party;
  }
  return own ? { isMerchant: 0.05, ruleId: "own-account", own: true, fromTemplate: false } : undefined;
}

/* ------------------------------------------------------------------ */
/* Rail, references, time                                              */
/* ------------------------------------------------------------------ */

function detectRail(text: string): PaymentRail | undefined {
  return V.rails.find((r) => re(r.pattern, r.flags ?? "i").test(text))?.rail;
}

const A2A_FAMILIES: ReadonlySet<PaymentRail["family"]> = new Set([
  "account_to_account_instant",
  "account_to_account_batch",
  "direct_debit",
  "mobile_money",
]);

/** Namespace for rail references: the scheme of an account-to-account or mobile-money rail. */
function railNamespace(rail: PaymentRail | undefined): string | undefined {
  return rail && A2A_FAMILIES.has(rail.family) ? rail.scheme : undefined;
}

function resolveNamespace(ns: string, rail: PaymentRail | undefined, pack: AlertPack): string | undefined {
  if (ns === "$rail") return railNamespace(rail);
  if (ns === "$issuer") return pack.namespace;
  if (ns === "$mandate") return rail?.scheme === "upi" || rail?.scheme === "nach" ? rail.scheme : pack.namespace;
  return ns;
}

function cleanRefValue(v: string): string {
  return v.replace(/[.,;:)]+$/, "").trim();
}

function extractReferences(text: string, pack: AlertPack, rail: PaymentRail | undefined, tm: TemplateMatch | undefined): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  const add = (r: Reference) => {
    const key = `${r.type}|${r.namespace ?? ""}|${r.value.toUpperCase()}`;
    if (!seen.has(key) && r.value.length > 0) {
      seen.add(key);
      out.push(r);
    }
  };
  const tplRef = tm?.groups.ref;
  if (tm && tplRef) {
    const type = tm.template.ref?.type ?? "rail_reference";
    const ns = tm.template.ref ? resolveNamespace(tm.template.ref.namespace, rail, pack) : (railNamespace(rail) ?? pack.namespace);
    if (ns) add({ type, value: cleanRefValue(tplRef), namespace: ns });
  }
  const rules: readonly ReferenceRule[] = [...(pack.references ?? []), ...V.references];
  for (const rule of rules) {
    const ns = resolveNamespace(rule.namespace, rail, pack);
    if (!ns) continue;
    for (const m of allMatches(rule.pattern, text, rule.flags ?? "i")) {
      if (m[1]) add({ type: rule.type, value: cleanRefValue(m[1]), namespace: ns });
    }
  }
  return out;
}

const ZONE_RE = new RegExp(
  String.raw`\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?\s*(${Object.keys(V.zoneAbbreviations).join("|")})\b`,
);

function explicitZone(text: string): string | undefined {
  const m = ZONE_RE.exec(text);
  return m?.[1] ? V.zoneAbbreviations[m[1]] : undefined;
}

/** "2026:10:04" (Bank of Baroda) -> "2026-10-04"; drop "dated <original date>" so the event's own date is read. */
function dateTextOf(text: string): string {
  return text.replace(/(?<!\d)(\d{4}):(\d{2}):(\d{2})(?!\d)/g, "$1-$2-$3").replace(/\bdated\s+\S+/gi, " ");
}

interface TimeFacts {
  readonly occurredAt: Measured<EpochMillis>;
  readonly fromText: boolean;
  readonly inconsistent: boolean;
  readonly nextChargeAt?: EpochMillis;
}

function sameLocalDate(a: EpochMillis, b: EpochMillis, zone: string): boolean {
  const x = localParts(a, zone);
  const y = localParts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/**
 * When the event happened. A datetime written in the alert wins (0.95); a
 * date-only alert on the receipt's local day takes the receipt time (0.85);
 * another day becomes local noon, approximate (0.45, so fusion widens its
 * window); no date means the receipt time (0.75). Text times in the future of
 * the receipt are treated as misreads.
 */
function resolveTime(
  text: string,
  tm: TemplateMatch | undefined,
  order: DateOrder | undefined,
  country: CountryCode | undefined,
  zone: string,
  receivedAt: EpochMillis,
  event: AlertEvent,
): TimeFacts {
  const g = tm?.groups;
  const source = g?.date ? `${g.date} ${g.time ?? ""}` : text;
  const parsed = parseDateTime(dateTextOf(source), {
    timeZone: zone,
    ...(order ? { order } : {}),
    ...(country ? { country } : {}),
  });
  const fallback = (confidence: number, inconsistent = false): TimeFacts => ({
    occurredAt: { value: receivedAt, confidence },
    fromText: false,
    inconsistent,
  });
  if (event === "autopay_upcoming") {
    return { ...fallback(0.8), ...(parsed ? { nextChargeAt: parsed.at } : {}) };
  }
  if (!parsed) return fallback(0.75);
  if (parsed.precision === "datetime") {
    if (parsed.at > receivedAt + 10 * MINUTE) return fallback(0.6, true);
    return { occurredAt: { value: parsed.at, confidence: 0.95 }, fromText: true, inconsistent: false };
  }
  if (sameLocalDate(parsed.at, receivedAt, zone)) return fallback(0.85);
  if (parsed.at > receivedAt + DAY) return fallback(0.6, true);
  return { occurredAt: { value: parsed.at, confidence: 0.45, approximate: true }, fromText: false, inconsistent: false };
}

/* ------------------------------------------------------------------ */
/* Hints                                                               */
/* ------------------------------------------------------------------ */

/** Boilerplate after "Not you? / SMS BLOCK …" never feeds keyword hints. */
function contentOf(text: string): string {
  const m = re(V.disclaimerStart).exec(text);
  return m ? text.slice(0, m.index) : text;
}

function typeHintsFor(event: AlertEvent, direction: Direction | undefined, party: Party | undefined, rail: PaymentRail | undefined, content: string): TypeHint[] {
  switch (event) {
    case "cash_withdrawal":
      return [{ type: "cash_withdrawal", confidence: 0.95, reason: "alert:cash-withdrawal" }];
    case "refund":
      return [{ type: "refund", confidence: 0.9, reason: "alert:refund" }];
    case "reversal":
      return [{ type: "refund", confidence: 0.85, reason: "alert:reversal" }];
    case "autopay_upcoming":
    case "mandate_created":
      return [{ type: "subscription", confidence: 0.8, reason: "alert:mandate-notice" }];
    case "declined":
    case "balance":
    case "mandate_revoked":
      return [];
    default:
      break;
  }
  const hints: TypeHint[] = [];
  const add = (h: TypeHint) => {
    if (!hints.some((x) => x.type === h.type && x.transferKind === h.transferKind)) hints.push(h);
  };
  for (const rule of V.types) {
    if (rule.directions && direction && !rule.directions.includes(direction)) continue;
    if (re(rule.pattern).test(content)) {
      add({ type: rule.type, ...(rule.transferKind ? { transferKind: rule.transferKind } : {}), confidence: rule.confidence, reason: rule.reason });
    }
  }
  if (party?.own || re(V.ownAccount).test(content)) {
    add({ type: "transfer", transferKind: "own_account", confidence: 0.7, reason: "alert:own-account" });
  }
  if (hints.length === 0 && direction === "debit") {
    if (party) {
      const p = party.isMerchant;
      if (p >= 0.8) add({ type: "purchase", confidence: round2(p * 0.9), reason: "alert:merchant-payee" });
      else if (p <= 0.2) add({ type: "transfer", transferKind: "p2p_other", confidence: 0.75, reason: "alert:person-payee" });
      else {
        add({ type: "purchase", confidence: 0.45, reason: "alert:payee-ambiguous" });
        add({ type: "transfer", transferKind: "p2p_other", confidence: 0.45, reason: "alert:payee-ambiguous" });
      }
    } else if (rail?.family === "card") {
      add({ type: "purchase", confidence: 0.8, reason: "alert:card-spend" });
    }
  }
  if (hints.length === 0 && direction === "credit" && party && party.isMerchant <= 0.2) {
    add({ type: "transfer", transferKind: "p2p_other", confidence: 0.5, reason: "alert:person-payer" });
  }
  return hints.sort((a, b) => b.confidence - a.confidence);
}

function categoryHintsFor(content: string, party: Party | undefined): CategoryHint[] {
  const text = `${party?.name ?? ""} ${content}`;
  const out: CategoryHint[] = [];
  for (const rule of V.categories) {
    if (re(rule.pattern).test(text) && !out.some((h) => h.value === rule.category)) {
      out.push({ scheme: "brake", value: rule.category, confidence: 0.55 });
    }
  }
  const mcc = /\bMCC[:\s-]*(\d{4})\b/i.exec(content)?.[1];
  if (mcc) out.unshift({ scheme: "mcc", value: mcc, confidence: 0.9 });
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

const TEMPLATE_CONFIDENCE: Readonly<Partial<Record<SenderVerification, number>>> = {
  sender_id: 0.97,
  package: 0.97,
  display_name: 0.92,
};

/** Heuristic parses: verified senders 0.85 (display names 0.8); unknown business ids 0.55; phones and names 0.3. */
const HEURISTIC_CONFIDENCE: Readonly<Record<SenderVerification, number>> = {
  sender_id: 0.85,
  package: 0.85,
  display_name: 0.8,
  unverified_business: 0.55,
  unverified_personal: 0.3,
  unverified_display: 0.3,
};

const MONEY_EVENTS: ReadonlySet<AlertEvent> = new Set(["debit", "credit", "refund", "reversal", "declined", "cash_withdrawal"]);
const REALTIME_FAMILIES: ReadonlySet<PaymentRail["family"]> = new Set(["card", "account_to_account_instant", "wallet", "mobile_money"]);

function windowFor(event: AlertEvent, time: TimeFacts, receivedAt: EpochMillis, rail: PaymentRail | undefined): SpendWindow {
  if (event === "autopay_upcoming" || event === "mandate_created" || event === "mandate_revoked" || event === "balance") return "pre_spend";
  const realtime =
    event === "debit" &&
    time.fromText &&
    Math.abs(receivedAt - time.occurredAt.value) <= 2 * MINUTE &&
    rail !== undefined &&
    REALTIME_FAMILIES.has(rail.family);
  return realtime ? "in_spend" : "post_spend";
}

function stageFor(event: AlertEvent, text: string): TransactionStatus {
  switch (event) {
    case "declined":
    case "mandate_revoked":
      return "cancelled";
    case "mandate_created":
      return "confirmed";
    case "autopay_upcoming":
      return "intent";
    case "balance":
      return "unknown";
    default:
      return anyMatch(V.pending, text) ? "pending" : "confirmed";
  }
}

/* ------------------------------------------------------------------ */
/* parseAlert                                                          */
/* ------------------------------------------------------------------ */

const IGNORED_OTP = { ignored: "otp" } as const;

/**
 * Parse one transaction alert. Returns `{ ignored }` for OTPs (checked before
 * anything else reads the text), promotions, non-financial and unsupported
 * messages; `{ rejected }` for a suspected spoof; otherwise the extracted facts.
 */
export function parseAlert(text: string, meta: AlertMeta): AlertParseResult {
  if (isOneTimePasswordMessage(text)) return IGNORED_OTP;
  const body = normalizeAlertText(text);
  if (body.length === 0) return { ignored: "not_financial" };
  if (isOneTimePasswordMessage(body)) return IGNORED_OTP;

  const packs = meta.packs ?? ALERT_PACKS;
  const resolution: SenderResolution = meta.pack
    ? { pack: meta.pack, verification: meta.verification ?? "sender_id", sender: classifySender(meta.senderOrApp) }
    : resolveSender(meta.senderOrApp, packs, meta.senderKind ?? "sms");
  const { pack, verification, sender } = resolution;

  // TRAI header categories: "-T" is the transactional (OTP) class, "-P" promotional.
  if (sender.dltSuffix === "T") return IGNORED_OTP;
  if (sender.dltSuffix === "P") return { ignored: "promotional" };

  const cls = classify(body);
  if (cls.kind === "promotional") return { ignored: "promotional" };
  if (cls.kind === "bill_due") return { ignored: "unsupported_format" };
  if (cls.kind === "none") return { ignored: isVerifiedSender(verification) ? "unsupported_format" : "not_financial" };

  if (!isVerifiedSender(verification)) {
    const claimed = claimedIssuer(body, packs);
    if (claimed) {
      return {
        rejected: `unverified_sender: the message claims to be from ${claimed.displayName} but "${sender.raw || "an unknown sender"}" is not a known ${claimed.displayName} sender; it may be phishing`,
      };
    }
  }

  const ctx = meta.ctx;
  const hints: CurrencyHints = {
    ...((pack.country ?? ctx.country) ? { country: pack.country ?? ctx.country } : {}),
    ...((pack.defaultCurrency ?? ctx.defaultCurrency) ? { defaultCurrency: pack.defaultCurrency ?? ctx.defaultCurrency } : {}),
  };

  const tmRaw = matchTemplate(body, pack);
  const tm = tmRaw && templateCompatible(cls.event, tmRaw.template.event) ? tmRaw : undefined;
  const event: AlertEvent = tm ? tm.template.event : cls.event;
  const direction: Direction | undefined =
    event === "balance" ? undefined : event === "credit" || event === "refund" || event === "reversal" ? "credit" : event === "debit" ? "debit" : (cls.direction ?? "debit");

  // Amounts.
  const facts = extractAmountFacts(body, hints);
  const tplAmount = tm?.groups.amount ? parseAmountToken(tm.groups.amount, hints) : undefined;
  const tplBalance = tm?.groups.balance ? parseAmountToken(tm.groups.balance, hints) : undefined;
  let amount: Measured<Money> | undefined = tplAmount ? { value: tplAmount, confidence: 0.98 } : facts.amount;
  let balance = tplBalance ?? facts.balance;
  if (event === "balance") {
    balance ??= amount?.value;
    amount = undefined;
  }
  if (MONEY_EVENTS.has(event) && !amount) return { ignored: isVerifiedSender(verification) ? "unsupported_format" : "not_financial" };
  if (event === "balance" && !balance) return { ignored: "not_financial" };

  // Parties, instrument, rail.
  const party: Party | undefined =
    event === "cash_withdrawal" || event === "balance" || !direction
      ? undefined
      : ((tm ? partyFromTemplate(tm, body) : undefined) ?? partyFromRules(body, direction));
  const refundLike = event === "refund" || event === "reversal";
  const effectiveParty: Party | undefined = party && refundLike ? { ...party, isMerchant: Math.max(party.isMerchant, 0.8) } : party;
  const instrument = extractInstrument(body, pack, tm, effectiveParty?.ruleId);
  let rail: PaymentRail | undefined =
    tm?.template.rail ??
    (event === "cash_withdrawal" && anyMatch(V.atm, body) ? { family: "cash", scheme: "atm" } : undefined) ??
    detectRail(body) ??
    pack.rail ??
    (instrument?.type === "card" ? { family: "card" } : undefined);
  if (rail?.family === "card" && !rail.scheme && instrument?.network) rail = { family: "card", scheme: instrument.network };

  const references = extractReferences(body, pack, rail, tm);

  // Time.
  const zone = explicitZone(body) ?? pack.timeZone ?? ctx.timeZone ?? "UTC";
  const time = resolveTime(body, tm, tm?.template.dateOrder ?? pack.dateOrder, pack.country ?? ctx.country, zone, meta.receivedAt, event);

  // Merchant vs counterparty.
  let merchant: MerchantObservation | undefined;
  let counterparty: CounterpartyObservation | undefined;
  if (effectiveParty && (effectiveParty.name || effectiveParty.handle)) {
    const p = effectiveParty.isMerchant;
    const merchantSide = direction === "debit" || refundLike;
    if (merchantSide && p >= 0.5) {
      const raw = effectiveParty.name ?? effectiveParty.handle ?? "";
      merchant = {
        raw,
        ...(effectiveParty.handle ? { handle: effectiveParty.handle } : {}),
        confidence: round2((effectiveParty.fromTemplate ? 0.9 : 0.75) * (p >= 0.8 ? 1 : 0.8)),
      };
    }
    if (!merchant || p < 0.8) {
      counterparty = {
        ...(effectiveParty.name ? { name: effectiveParty.name } : {}),
        ...(effectiveParty.handle ? { handle: maskHandle(effectiveParty.handle) } : {}),
        isMerchant: p,
        ...(effectiveParty.own ? { isSelf: 0.8 } : {}),
      };
    }
  } else if (effectiveParty?.own) {
    counterparty = { isSelf: 0.8, isMerchant: 0.05 };
  }

  const content = contentOf(body);
  const typeHints = typeHintsFor(event, direction, effectiveParty, rail, content);
  const categoryHints = categoryHintsFor(content, effectiveParty);
  const period = event === "mandate_created" ? V.periods.find((x) => re(x.pattern).test(body))?.period : undefined;

  // Confidence.
  const base = tm ? (TEMPLATE_CONFIDENCE[verification] ?? HEURISTIC_CONFIDENCE[verification]) : HEURISTIC_CONFIDENCE[verification];
  let confidence = pack.kind === "generic" && verification === "package" ? 0.6 : base;
  if (amount && amount.confidence < 0.9) confidence -= 0.05;
  if (MONEY_EVENTS.has(event) && event !== "cash_withdrawal" && !effectiveParty) confidence -= 0.03;
  if (time.inconsistent) confidence -= 0.05;

  const currency = amount?.value.currency ?? balance?.currency;
  // The pack's country describes the event only when the money is in that country's currency.
  const country = pack.country && pack.defaultCurrency === currency ? pack.country : undefined;
  const eventRef = references.find((r) => r.type === "rail_reference");
  const naturalKey = `${event}|${eventRef ? `${eventRef.namespace}:${eventRef.value.toUpperCase()}` : `h:${stableHash(body)}`}`;

  return {
    event,
    pack,
    verification,
    sender,
    ...(tm ? { templateId: tm.template.id } : {}),
    normalizedText: body,
    ...(direction ? { direction } : {}),
    stage: stageFor(event, body),
    ...(amount ? { amount } : {}),
    ...(facts.fee && MONEY_EVENTS.has(event) ? { fee: facts.fee } : {}),
    ...(balance && instrument?.type !== "card" ? { balance } : {}),
    occurredAt: time.occurredAt,
    timeFromText: time.fromText,
    timeZone: zone,
    ...(time.nextChargeAt !== undefined ? { nextChargeAt: time.nextChargeAt } : {}),
    ...(period ? { period } : {}),
    ...(instrument ? { instrument } : {}),
    ...(merchant ? { merchant } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(rail ? { rail } : {}),
    references,
    typeHints,
    categoryHints,
    ...(country ? { country } : {}),
    window: windowFor(event, time, meta.receivedAt, rail),
    confidence: round2(clamp01(confidence)),
    naturalKey,
  };
}

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

export interface AlertSource {
  readonly adapterId: string;
  readonly sourceKind: SignalSourceKind;
  readonly connectionId: ConnectionId;
  /** When BRAKE received the signal (Observation.receivedAt). */
  readonly receivedAt: EpochMillis;
  /** Reads after "your": "HDFC Bank SMS alert", "PhonePe notification". */
  readonly label: string;
  readonly provider?: string;
  /** Prefix for evidence summaries: "HDFC Bank SMS", "PhonePe notification". */
  readonly summarySource: string;
  /** Capture channel inside the adapter ("sms", "pkg:com.phonepe.app"), part of the natural key. */
  readonly channelKey: string;
  readonly locale?: LocaleTag;
  /** Keep a redacted excerpt that expires after 7 days (default true). */
  readonly includeExcerpt?: boolean;
}

export const EXCERPT_TTL_MS = 7 * DAY;
const EXCERPT_MAX = 240;

/** Redacted, link-free, bounded excerpt of an alert (never the raw body). */
export function alertExcerpt(text: string): string {
  const noLinks = text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\b[\w-]+(?:\.[a-z][\w-]*)+\/\S*/gi, "[link]");
  const redacted = redactSensitive(noLinks).text;
  return redacted.length > EXCERPT_MAX ? `${redacted.slice(0, EXCERPT_MAX - 1)}…` : redacted;
}

function money(m: Money, locale: LocaleTag): string {
  return formatMoney(m, locale, { trimZeroMinor: false });
}

function partyPhrase(p: ParsedAlert): string {
  const d = p.direction;
  const name = p.merchant?.raw ?? (p.counterparty && (p.counterparty.isMerchant ?? 0.5) > 0.2 ? p.counterparty.name : undefined);
  if (name) {
    if (p.event === "autopay_upcoming" || p.event === "mandate_created" || p.event === "mandate_revoked") return ` for ${name}`;
    if (d === "credit") return ` from ${name}`;
    return p.instrument?.type === "card" || p.rail?.family === "card" ? ` at ${name}` : ` to ${name}`;
  }
  if (p.counterparty?.isSelf !== undefined && p.counterparty.isSelf >= 0.5) return d === "credit" ? " from your own account" : " to your own account";
  if (p.counterparty) return d === "credit" ? " from a person" : " to a person";
  return "";
}

function railPhrase(rail: PaymentRail | undefined): string {
  if (!rail) return "";
  const label = rail.scheme ? (V.railLabels[rail.scheme] ?? (rail.family === "card" ? rail.scheme.toUpperCase() : undefined)) : undefined;
  if (label) return ` (${label})`;
  return rail.family === "card" ? " (card)" : "";
}

function summarize(p: ParsedAlert, locale: LocaleTag): string {
  const amt = p.amount ? money(p.amount.value, locale) : "";
  const party = partyPhrase(p);
  const rail = railPhrase(p.rail);
  switch (p.event) {
    case "debit":
      return `${amt} ${p.instrument?.type === "card" || p.rail?.family === "card" ? "spent" : "debited"}${party}${rail}`;
    case "credit":
      return `${amt} credited${party}${rail}`;
    case "refund":
      return `${amt} refund credited${party}${rail}`;
    case "reversal":
      return `${amt} reversal credited${rail}`;
    case "declined":
      return `${amt} payment declined${party}${rail}`;
    case "cash_withdrawal":
      return `${amt} cash withdrawn${rail}`;
    case "autopay_upcoming": {
      const when =
        p.nextChargeAt !== undefined
          ? ` on ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: p.timeZone }).format(new Date(p.nextChargeAt))}`
          : "";
      return `${amt} will be debited${party}${when}${rail}`;
    }
    case "mandate_created":
      return `recurring payment mandate set up${party}${amt ? ` (up to ${amt})` : ""}${rail}`;
    case "mandate_revoked":
      return `recurring payment mandate cancelled${party}${rail}`;
    case "balance":
      return p.balance ? `available balance ${money(p.balance, locale)}` : "balance update";
  }
}

/**
 * Turn a parsed alert into observations: one money movement (plus a
 * balance snapshot when the alert states an account balance), a
 * subscription_event for pre-debit notices, a mandate for mandate set-up or
 * cancellation, or a balance snapshot. Ids are deterministic in
 * (adapter, connection, channel, event, reference-or-text-hash).
 */
export function alertObservations(p: ParsedAlert, src: AlertSource): Observation[] {
  const locale = src.locale ?? "en";
  const source: SourceRef = {
    adapterId: src.adapterId,
    kind: src.sourceKind,
    connectionId: src.connectionId,
    label: src.label,
    ...(src.provider ? { provider: src.provider } : {}),
  };
  const key = `${src.channelKey}|${p.naturalKey}`;
  const id = (suffix: string) => observationId(src.adapterId, src.connectionId, `${key}|${suffix}`);
  const excerpt: Pick<Evidence, "excerpt" | "excerptExpiresAt"> =
    src.includeExcerpt === false ? {} : { excerpt: alertExcerpt(p.normalizedText), excerptExpiresAt: src.receivedAt + EXCERPT_TTL_MS };
  const evidence = (summary: string): Evidence => ({ summary: `${src.summarySource}: ${summary}`, ...excerpt });

  const common = {
    source,
    receivedAt: src.receivedAt,
    occurredAt: p.occurredAt,
    ...(p.instrument ? { instrument: p.instrument } : {}),
    ...(p.country ? { country: p.country } : {}),
  };

  const balanceSnapshot = (window: SpendWindow): Observation | undefined =>
    p.balance
      ? {
          ...common,
          id: id("balance_snapshot"),
          kind: "balance_snapshot",
          window,
          stage: "unknown",
          references: [],
          balance: { available: p.balance },
          confidence: round2(p.confidence * 0.98),
          evidence: evidence(`available balance ${money(p.balance, locale)}`),
        }
      : undefined;

  if (p.event === "balance") {
    const snap = balanceSnapshot("pre_spend");
    return snap ? [snap] : [];
  }

  const parties = {
    ...(p.merchant ? { merchant: p.merchant } : {}),
    ...(p.counterparty ? { counterparty: p.counterparty } : {}),
  };
  const hints = {
    ...(p.typeHints.length > 0 ? { typeHints: p.typeHints } : {}),
    ...(p.categoryHints.length > 0 ? { categoryHints: p.categoryHints } : {}),
  };

  if (p.event === "autopay_upcoming" || p.event === "mandate_created" || p.event === "mandate_revoked") {
    const serviceName = p.merchant?.raw ?? p.counterparty?.name;
    const subscription: SubscriptionDetails = {
      event: p.event === "autopay_upcoming" ? "renewal_upcoming" : p.event === "mandate_created" ? "signup" : "cancelled",
      ...(serviceName ? { serviceName } : {}),
      ...(p.period ? { period: p.period } : {}),
      ...(p.nextChargeAt !== undefined ? { nextChargeAt: p.nextChargeAt } : {}),
      ...(p.amount ? { price: p.amount.value } : {}),
    };
    return [
      {
        ...common,
        id: id(p.event === "autopay_upcoming" ? "subscription_event" : "mandate"),
        kind: p.event === "autopay_upcoming" ? "subscription_event" : "mandate",
        window: p.window,
        stage: p.stage,
        direction: "debit",
        ...(p.amount ? { amount: p.amount } : {}),
        ...parties,
        ...(p.rail ? { rail: p.rail } : {}),
        references: p.references,
        ...hints,
        subscription,
        confidence: p.confidence,
        evidence: evidence(summarize(p, locale)),
      },
    ];
  }

  const breakdown: AmountComponent[] = p.fee && p.fee.minor > 0 ? [{ kind: "fee", amount: p.fee }] : [];
  const movement: Observation = {
    ...common,
    id: id("money_movement"),
    kind: "money_movement",
    window: p.window,
    stage: p.stage,
    ...(p.direction ? { direction: p.direction } : {}),
    ...(p.amount ? { amount: p.amount } : {}),
    ...(breakdown.length > 0 ? { amountBreakdown: breakdown } : {}),
    ...parties,
    ...(p.rail ? { rail: p.rail } : {}),
    references: p.references,
    ...hints,
    confidence: p.confidence,
    evidence: evidence(summarize(p, locale)),
  };
  const snap = balanceSnapshot("post_spend");
  return snap ? [movement, snap] : [movement];
}
