import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  BalanceDetails,
  CounterpartyObservation,
  Direction,
  InstrumentObservation,
  MerchantObservation,
  Money,
  Observation,
  PaymentRail,
  Probability,
  RawSignal,
  Reference,
  SignalAdapter,
  SourceRef,
  TransactionType,
  TransferKind,
  TypeHint,
} from "@brake/core";
import {
  asArray,
  contentKey,
  describeMoney,
  evidenceExcerpt,
  isRecord,
  last4Of,
  measuredInstant,
  normalizeCurrency,
  parseDecimalAmount,
  parseInstant,
  safeHandle,
  scrubDescriptor,
  text,
} from "./ledger-mapping";
import { normalizeWhitespace, observationId } from "./shared/text";

/**
 * India Account Aggregator (ReBIT/Sahamati) DEPOSIT FI data -> observations.
 *
 * Shape: the decrypted FI JSON of `deposit.xsd`
 * (github.com/Sahamati/account-aggregator-standards, schemas/deposit) —
 * `Account{linkedAccRef, maskedAccNumber, type="deposit", Profile, Summary,
 * Transactions{startDate, endDate, Transaction[]}}`, each `Transaction` with
 * `type` CREDIT|DEBIT, `mode` (CASH, ATM, CARD, UPI, FT, OTHERS in v1.x; v2
 * banks also send NEFT, IMPS, RTGS, ACH…), `amount` (xs:float), `currentBalance`
 * (balance after), `transactionTimestamp` (xs:dateTime), `valueDate` (xs:date),
 * `txnId`, `narration`, `reference` ("cheque or reference no").
 *
 * AA data is *posted only* and *periodic*: a consented fetch (≤ 45/month under
 * purpose 102) returns a batch covering startDate..endDate, hours or days after
 * the payments. So `receivedAt` is the fetch time and `occurredAt` comes from
 * each entry; nothing here is in-spend.
 *
 * Privacy: `Profile` (holder name, PAN, mobile, e-mail, address) is never
 * read. Account numbers survive only as last four digits.
 */

/* ------------------------------------------------------------------ */
/* Payload                                                             */
/* ------------------------------------------------------------------ */

export interface AaDepositTransaction {
  readonly txnId?: string;
  readonly type: "DEBIT" | "CREDIT" | string;
  readonly mode?: string;
  /** xs:float lexical form, e.g. "1249.00". */
  readonly amount: string | number;
  /** Balance after this entry. */
  readonly currentBalance?: string | number;
  readonly transactionTimestamp?: string;
  readonly valueDate?: string;
  readonly narration?: string;
  readonly reference?: string;
}

export interface AaDepositSummary {
  readonly currentBalance: string | number;
  readonly currency?: string;
  readonly exchgeRate?: string;
  readonly balanceDateTime?: string;
  /** SAVINGS | CURRENT */
  readonly type?: string;
  readonly branch?: string;
  /** OD | CC */
  readonly facility?: string;
  readonly ifscCode?: string;
  readonly micrCode?: string;
  readonly openingDate?: string;
  readonly currentODLimit?: string | number;
  readonly drawingLimit?: string | number;
  readonly status?: string;
}

export interface AaDepositAccount {
  readonly linkedAccRef: string;
  readonly maskedAccNumber?: string;
  readonly type?: "deposit" | string;
  readonly version?: string;
  /** Holder PII. Typed opaque on purpose: this adapter never reads it. */
  readonly Profile?: unknown;
  readonly Summary?: AaDepositSummary;
  readonly Transactions?: {
    readonly startDate?: string;
    readonly endDate?: string;
    readonly Transaction?: AaDepositTransaction | readonly AaDepositTransaction[];
  };
}

/** One account's decrypted FI data, plus what the FI/fetch envelope says about its sender. */
export interface AaFiData {
  readonly Account: AaDepositAccount;
  /** `FI[].fipID` from the FI/fetch response ("HDFC-FIP"). */
  readonly fipId?: string;
  /** Display name the relay resolved for the FIP from the AA Central Registry ("HDFC Bank"). */
  readonly fipName?: string;
}

/* ------------------------------------------------------------------ */
/* Data pack: modes and narrations                                     */
/* ------------------------------------------------------------------ */

interface TypeRule {
  readonly type: TransactionType;
  readonly transferKind?: TransferKind;
  readonly confidence: Probability;
  /** Applies only to this direction. */
  readonly direction?: Direction;
}

interface RailRule {
  readonly rail: PaymentRail;
  /** Namespace for the rail's reference (RRN/UTR) when one is found in the narration. */
  readonly refNamespace?: string;
  readonly type?: TypeRule;
}

const UPI: RailRule = { rail: { family: "account_to_account_instant", scheme: "upi" }, refNamespace: "upi" };
const IMPS: RailRule = { rail: { family: "account_to_account_instant", scheme: "imps" }, refNamespace: "imps" };
const NEFT: RailRule = { rail: { family: "account_to_account_batch", scheme: "neft" }, refNamespace: "neft" };
const RTGS: RailRule = { rail: { family: "account_to_account_instant", scheme: "rtgs" }, refNamespace: "rtgs" };
const NACH: RailRule = { rail: { family: "direct_debit", scheme: "nach" } };
const ATM: RailRule = {
  rail: { family: "cash", scheme: "atm" },
  type: { type: "cash_withdrawal", confidence: 0.9, direction: "debit" },
};
const CASH: RailRule = { rail: { family: "cash" } };
const CARD: RailRule = { rail: { family: "card" } };
const CHEQUE: RailRule = { rail: { family: "cheque" } };
const INTRABANK: RailRule = { rail: { family: "account_to_account_instant", scheme: "ft" } };

/** `Transaction.mode` -> rail. Unknown modes fall back to the narration. */
const MODE_RAILS: Readonly<Record<string, RailRule>> = {
  UPI,
  IMPS,
  NEFT,
  RTGS,
  ACH: NACH,
  NACH,
  ECS: NACH,
  ATM,
  CASH: { ...CASH, type: { type: "cash_withdrawal", confidence: 0.75, direction: "debit" } },
  CARD,
  CHEQUE,
  FT: INTRABANK,
};

/**
 * Narration prefixes -> rail, tried before `mode` (a v1 FIP reports NEFT and
 * IMPS as mode "FT" or "OTHERS"; the narration says which). Patterns cover
 * the common bank formats, e.g.
 *   SBI    "UPI/DR/627712345678/SWIGGY/YESB/swiggy@ybl/Payment"
 *   ICICI  "UPI/627712345678/Payment from Ph/swiggy@icici/ICICI Bank"
 *   HDFC   "UPI-SWIGGY-SWIGGY8@YBL-YESB0YBLUPI-627712345678-PAYMENT FROM PHONE"
 *   Axis   "UPI/P2M/627712345678/SWIGGY/Payment from Ph/HDFC BANK"
 *   NEFT   "NEFT/N123/ACME PVT LTD/SALARY", "NEFT CR-HDFC0000001-ACME PVT LTD-SALARY SEP-N123456789012345"
 *   NACH   "ACH D- BAJAJ FINANCE LTD-P1234567"
 *   ATM    "ATW-512345XXXXXX1234-S1ANBG12-BANGALORE", "ATM WDL/ATM CASH 1234 MG ROAD"
 * Narration formats are bank-specific and undocumented (docs/research/10 §A5);
 * a new bank format is a new entry here, not new control flow.
 */
const NARRATION_RAILS: ReadonlyArray<readonly [RegExp, RailRule]> = [
  [/^UPI\b/i, UPI],
  [/^(?:IMPS|MMT)\b/i, IMPS],
  [/^NEFT\b/i, NEFT],
  [/^RTGS\b/i, RTGS],
  [/^(?:NACH|ACH|ECS)\b/i, NACH],
  [/^(?:ATM|ATW|NWD|EAW|CWDR|CASH WDL)\b/i, ATM],
  [/^(?:POS|PCD|ECOM|VPS|IPS|DEBIT CARD)\b/i, CARD],
  [/^(?:CHQ|CHEQUE|CLG)\b/i, CHEQUE],
];

/** Keywords anywhere in a narration -> type hints (reason "aa_narration:<id>"). */
const NARRATION_TYPES: ReadonlyArray<readonly [string, RegExp, TypeRule]> = [
  ["salary", /\b(?:SALARY|SAL|PAYROLL)\b/i, { type: "income", confidence: 0.75, direction: "credit" }],
  ["interest", /\b(?:INT(?:EREST)?[ .]?(?:PD|PAID|CR)|CREDIT INTEREST|SB INT)\b/i, { type: "income", confidence: 0.8, direction: "credit" }],
  ["charges", /\b(?:CHGS?|CHARGES?|FEES?|AMC|PENALTY)\b/i, { type: "fee", confidence: 0.65, direction: "debit" }],
  ["loan", /\b(?:EMI|LOAN|LN REPAY)\b/i, { type: "loan_payment", confidence: 0.6, direction: "debit" }],
  [
    "investment",
    /\b(?:SIP|MUTUAL ?FUND|ZERODHA|GROWW|ICCL|INDIAN CLEARING|NSE CLEARING|BSE STAR)\b/i,
    { type: "investment", confidence: 0.6, direction: "debit" },
  ],
  [
    "card_bill",
    /\b(?:CREDIT ?CARD|CC ?(?:PAYMENT|BILL|PMT)|CARD ?BILL|CRED ?CLUB)\b/i,
    { type: "credit_card_payment", confidence: 0.6, direction: "debit" },
  ],
  ["wallet_load", /\b(?:ADD MONEY|WALLET ?LOAD|WALLET TOPUP|UPI ?LITE)\b/i, { type: "transfer", transferKind: "wallet_load", confidence: 0.6, direction: "debit" }],
  ["reversal", /\b(?:REV|REVERSAL|REFUND|RFND)\b/i, { type: "refund", confidence: 0.65, direction: "credit" }],
  ["self", /\b(?:SELF|OWN A\/?C|TO SELF)\b/i, { type: "transfer", transferKind: "own_account", confidence: 0.6 }],
];

/** Narration words that describe how money moved, not who was paid. */
const RAIL_WORDS: ReadonlySet<string> = new Set([
  "UPI", "NEFT", "IMPS", "RTGS", "NACH", "ACH", "ECS", "MMT", "POS", "ATM", "ATW", "NWD", "EAW", "INB", "IB", "BIL", "ONL",
  "TPT", "FT", "TRF", "TRANSFER", "DR", "CR", "D", "C", "P2M", "P2A", "P2P", "PAY", "COLLECT", "REV", "TO", "BY", "FROM",
  "WDL", "CASH", "DEBIT", "CREDIT", "CARD", "ECOM", "PCD", "CHQ", "CLG", "BILLPAY", "IMPS-P2A",
]);

/** IFSC bank prefixes that narrations use as standalone tokens ("YESB", "ICIC"). */
const BANK_CODES: ReadonlySet<string> = new Set([
  "YESB", "HDFC", "ICIC", "SBIN", "UTIB", "KKBK", "PUNB", "BARB", "CNRB", "UBIN", "IDIB", "INDB", "IDFB", "FDRL", "AIRP",
  "PYTM", "CIUB", "KARB", "IOBA", "MAHB", "BKID", "CBIN", "UCBA", "PSIB", "SIBL", "AUBL", "ESFB", "RATN", "DBSS", "HSBC",
  "SCBL", "CITI", "KVBL", "TMBL", "DLXB", "JSFB", "USFB", "FINO", "NSPB",
]);

/** Free-text notes payment apps put in narrations instead of a name. */
const NOTE_PATTERNS: readonly RegExp[] = [
  /^payment from\b/i,
  /^(?:paid|sent|payment) (?:via|using|by|through)\b/i,
  /^(?:na|null|nil|none|upi|-+)$/i,
  /^collect request\b/i,
  /^payment$/i,
];

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}/i;
const VPA = /^[a-z0-9._-]{2,}@[a-z][a-z0-9.]*$/i;
const RRN = /^\d{12}$/;
const MASKED_NUMBER = /\d*[Xx*•]{2,}\d{2,4}/;

/* ------------------------------------------------------------------ */
/* Narration parsing                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedNarration {
  readonly rail?: PaymentRail;
  /** Payee/payer name as written ("SWIGGY", "ACME PVT LTD"). */
  readonly name?: string;
  /** UPI VPA, masked when its local part is a phone number. */
  readonly handle?: string;
  /** UPI/IMPS RRN or NEFT/RTGS UTR, with the namespace fusion compares it in. */
  readonly railReference?: { readonly value: string; readonly namespace: string };
  /** true for a UPI P2M (merchant) payment, false for P2A/P2P, undefined when unknown. */
  readonly toMerchant?: boolean;
  readonly typeHints: readonly TypeHint[];
}

function railFromNarration(narration: string): RailRule | undefined {
  for (const [re, rule] of NARRATION_RAILS) if (re.test(narration)) return rule;
  return undefined;
}

function isRailPhrase(segment: string): boolean {
  const words = segment.toUpperCase().split(/[\s.]+/).filter((w) => w.length > 0);
  return words.length > 0 && words.every((w) => RAIL_WORDS.has(w));
}

/** A reference-like token: no spaces, at least three digits ("N123", "627712345678", "P1234567"). */
function isReferenceToken(segment: string): boolean {
  return /^[A-Z0-9]+$/i.test(segment) && (segment.match(/\d/g) ?? []).length >= 3;
}

function isNoise(segment: string, rail: RailRule | undefined): boolean {
  const s = segment.trim();
  if (s.length < 2 || !/[A-Za-z]{2}/.test(s)) return true;
  if (isRailPhrase(s) || isReferenceToken(s) || VPA.test(s) || IFSC.test(s) || BANK_CODES.has(s.toUpperCase())) return true;
  if (MASKED_NUMBER.test(s) && !/[A-Za-z]{3}/.test(s.replace(MASKED_NUMBER, ""))) return true;
  if (NOTE_PATTERNS.some((re) => re.test(s))) return true;
  // In UPI narrations a trailing "<X> Bank" is the payer's or payee's bank, not the payee.
  if (rail === UPI && /\bbank(?:\s+(?:ltd|limited))?$/i.test(s)) return true;
  return false;
}

/** Strip rail words and masked/long numbers from inside a name segment ("POS 512345XXXXXX1234 AMAZON PAY IN"). */
function cleanName(segment: string): string | undefined {
  const words = segment
    .split(/\s+/)
    .filter((w) => w.length > 0 && !RAIL_WORDS.has(w.toUpperCase()) && !MASKED_NUMBER.test(w) && !/^\d{4,}$/.test(w));
  const name = normalizeWhitespace(words.join(" "));
  return /[A-Za-z]{2}/.test(name) ? scrubDescriptor(name) : undefined;
}

/**
 * Parse a bank narration into rail, payee/payer, VPA and rail reference.
 * Exported for tests and for other India-ledger adapters; returns what it is
 * sure of and leaves the rest undefined.
 */
export function parseAaNarration(narration: string, direction?: Direction, mode?: string): ParsedNarration {
  const n = normalizeWhitespace(narration);
  const rule = railFromNarration(n) ?? MODE_RAILS[String(mode ?? "").toUpperCase()];
  const segments = (n.includes("/") ? n.split("/") : n.split(/\s*-\s*/)).map((s) => s.trim()).filter((s) => s.length > 0);

  let handle: string | undefined;
  let reference: string | undefined;
  let name: string | undefined;
  for (const s of segments) {
    if (!handle && VPA.test(s)) handle = safeHandle(s);
    if (!reference && rule?.refNamespace && isReferenceToken(s) && !VPA.test(s)) {
      // UPI and IMPS carry a 12-digit RRN; NEFT/RTGS carry a UTR ("N123…", "HDFCR5…").
      if (rule.refNamespace === "upi" || rule.refNamespace === "imps" ? RRN.test(s) : !RRN.test(s) || rule === NEFT) reference = s.toUpperCase();
    }
    if (!name && !isNoise(s, rule)) name = cleanName(s);
  }

  const upper = n.toUpperCase();
  const toMerchant = /(?:^|[/\s-])P2M(?:$|[/\s-])/.test(upper) ? true : /(?:^|[/\s-])P2[AP](?:$|[/\s-])/.test(upper) ? false : undefined;

  const typeHints: TypeHint[] = [];
  if (rule?.type && (!rule.type.direction || rule.type.direction === direction)) {
    typeHints.push(hint(rule.type, `aa_rail:${rule.rail.scheme ?? rule.rail.family}`));
  }
  for (const [id, re, t] of NARRATION_TYPES) {
    if (re.test(n) && (!t.direction || t.direction === direction)) typeHints.push(hint(t, `aa_narration:${id}`));
  }

  return {
    ...(rule ? { rail: rule.rail } : {}),
    ...(name ? { name } : {}),
    ...(handle ? { handle } : {}),
    ...(reference && rule?.refNamespace ? { railReference: { value: reference, namespace: rule.refNamespace } } : {}),
    ...(toMerchant !== undefined ? { toMerchant } : {}),
    typeHints,
  };
}

function hint(t: TypeRule, reason: string): TypeHint {
  return { type: t.type, ...(t.transferKind ? { transferKind: t.transferKind } : {}), confidence: t.confidence, reason };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

const ADAPTER_ID = "account-aggregator";

/** AA FIPs are Indian institutions and their FI timestamps are IST in practice. */
const AA_DEFAULT_ZONE = "Asia/Kolkata";
const AA_DEFAULT_CURRENCY = "INR";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "account_aggregator",
  displayName: "Account Aggregator",
  windows: ["pre_spend", "post_spend"],
  platforms: ["server"],
  requiresCapabilities: ["data:account-aggregator"],
  privacy: {
    sensitivity: "high",
    dataCategories: [
      "bank statement entries shared under your Account Aggregator consent",
      "account balance",
      "the last four digits of your account number",
    ],
    processing: "server",
  },
};

export function createAccountAggregatorAdapter(): SignalAdapter<AaFiData> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<AaFiData>, ctx: AdapterContext): AdapterResult {
      const payload = signal.payload as unknown;
      const account = isRecord(payload) && isRecord(payload.Account) ? (payload.Account as unknown as AaDepositAccount) : undefined;
      if (!account || !text(account.linkedAccRef)) return { status: "rejected", reason: "AA FI data must contain Account.linkedAccRef" };
      if (account.type !== undefined && String(account.type).toLowerCase() !== "deposit") {
        // Credit-card, term-deposit and investment FI types have other schemas.
        return { status: "ignored", reason: "unsupported_format" };
      }
      const data = payload as unknown as AaFiData;
      const instrument = instrumentFor(account, data);
      const label = `${text(data.fipName) ?? "bank"} statement via Account Aggregator`;
      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "account_aggregator",
        connectionId: signal.connectionId,
        label,
        ...(text(data.fipName) ? { provider: text(data.fipName) } : {}),
      };
      const currency = normalizeCurrency(account.Summary?.currency) ?? normalizeCurrency(ctx.defaultCurrency) ?? AA_DEFAULT_CURRENCY;

      const observations: Observation[] = [];
      let malformed = 0;
      for (const t of asArray(account.Transactions?.Transaction)) {
        const o = isRecord(t) ? transactionObservation(t as AaDepositTransaction, account, instrument, currency, source, signal, ctx) : null;
        if (o) observations.push(o);
        else malformed += 1;
      }
      const balance = balanceObservation(account, instrument, currency, source, signal, ctx);
      if (balance) observations.push(balance);

      if (observations.length === 0 && malformed > 0) return { status: "rejected", reason: "no well-formed AA deposit transactions" };
      return { status: "observations", observations };
    },
  };
}

function instrumentFor(account: AaDepositAccount, data: AaFiData): InstrumentObservation {
  const last4 = last4Of(account.maskedAccNumber);
  const issuer = text(data.fipName);
  return {
    type: "bank_account",
    accountRef: account.linkedAccRef,
    ...(last4 ? { last4 } : {}),
    ...(issuer ? { issuer } : {}),
  };
}

function transactionObservation(
  t: AaDepositTransaction,
  account: AaDepositAccount,
  instrument: InstrumentObservation,
  currency: string,
  source: SourceRef,
  signal: RawSignal<AaFiData>,
  ctx: AdapterContext,
): Observation | null {
  const kind = String(t.type ?? "").toUpperCase();
  const direction: Direction | undefined = kind === "DEBIT" ? "debit" : kind === "CREDIT" ? "credit" : undefined;
  const amount = parseDecimalAmount(t.amount, currency);
  if (!direction || !amount) return null;

  const narration = text(t.narration) ?? "";
  const mode = text(t.mode)?.toUpperCase();
  const parsed = parseAaNarration(narration, direction, mode);
  const modeRule = mode ? MODE_RAILS[mode] : undefined;
  const rail = parsed.rail ?? modeRule?.rail;
  const typeHints: TypeHint[] = [...parsed.typeHints];
  if (modeRule?.type && (!modeRule.type.direction || modeRule.type.direction === direction) && !typeHints.some((h) => h.type === modeRule.type?.type)) {
    typeHints.push(hint(modeRule.type, `aa_mode:${mode}`));
  }

  const txnId = text(t.txnId);
  const references: Reference[] = [];
  if (txnId) references.push({ type: "provider_transaction_id", value: txnId, namespace: `aa:${account.linkedAccRef}` });
  const railRef = parsed.railReference ?? referenceField(t.reference, rail);
  if (railRef) references.push({ type: "rail_reference", value: railRef.value, namespace: railRef.namespace });

  const zone = ctx.timeZone ?? AA_DEFAULT_ZONE;
  // Midnight timestamps are date-only entries padded by the FIP; the value date is a fallback.
  const stamp = parseInstant(t.transactionTimestamp, { timeZone: zone, midnightIsDate: true }) ?? parseInstant(t.valueDate, { timeZone: zone });
  const occurredAt = stamp ? measuredInstant(stamp, 0.9) : undefined;

  const isCash = rail?.family === "cash";
  const merchant: MerchantObservation | undefined =
    !isCash && (parsed.name || parsed.handle)
      ? {
          raw: parsed.name ?? parsed.handle ?? "",
          ...(parsed.handle ? { handle: parsed.handle } : {}),
          ...(parsed.toMerchant !== false && rail?.family === "card" ? { channel: "unknown" as const } : {}),
          confidence: parsed.handle ? 0.75 : 0.6,
        }
      : undefined;
  const a2a = rail?.family === "account_to_account_instant" || rail?.family === "account_to_account_batch";
  const counterparty: CounterpartyObservation | undefined =
    a2a && (parsed.name || parsed.handle)
      ? {
          ...(parsed.name ? { name: parsed.name } : {}),
          ...(parsed.handle ? { handle: parsed.handle } : {}),
          ...(parsed.toMerchant !== undefined ? { isMerchant: parsed.toMerchant ? 0.9 : 0.1 } : {}),
        }
      : undefined;

  const balanceAfter = t.currentBalance !== undefined ? parseDecimalAmount(t.currentBalance, currency) : null;
  const naturalKey = txnId
    ? `txn:${account.linkedAccRef}:${txnId}#${contentKey(kind, amount.money.minor)}`
    : `entry:${account.linkedAccRef}:${contentKey(t.transactionTimestamp, t.valueDate, kind, amount.money.minor, narration, t.currentBalance)}`;

  const who = parsed.name ?? parsed.handle;
  const via = rail?.scheme ? ` by ${rail.scheme.toUpperCase()}` : "";
  const summary =
    `Your ${source.provider ?? "bank"} statement (via Account Aggregator) shows ` +
    `${describeMoney(amount.money, ctx.locale)} ${direction === "debit" ? "debited" : "credited"}${via}` +
    (who ? ` ${direction === "debit" ? "to" : "from"} ${who}` : isCash ? " as cash" : "") +
    ".";

  return {
    id: observationId(ADAPTER_ID, signal.connectionId, naturalKey),
    source,
    kind: "money_movement",
    window: "post_spend",
    stage: "posted",
    receivedAt: signal.receivedAt,
    ...(occurredAt ? { occurredAt } : {}),
    direction,
    amount: { value: amount.money, confidence: 0.99 },
    ...(merchant ? { merchant } : {}),
    ...(counterparty ? { counterparty } : {}),
    instrument,
    ...(rail ? { rail } : {}),
    country: "IN",
    references,
    ...(typeHints.length > 0 ? { typeHints } : {}),
    // Balance after the entry: a near-decisive join key against SMS "Avl Bal" alerts.
    ...(balanceAfter ? { balance: { current: balanceAfter.money } } : {}),
    confidence: 0.97,
    evidence: { summary, ...evidenceExcerpt(narration, signal.receivedAt) },
  };
}

/** The `reference` attribute when it is the rail's own id (12-digit RRN for UPI/IMPS, UTR for NEFT/RTGS). */
function referenceField(value: unknown, rail: PaymentRail | undefined): { value: string; namespace: string } | undefined {
  const ref = text(value)?.toUpperCase();
  const scheme = rail?.scheme;
  if (!ref || !scheme) return undefined;
  if ((scheme === "upi" || scheme === "imps") && RRN.test(ref)) return { value: ref, namespace: scheme };
  if ((scheme === "neft" || scheme === "rtgs") && isReferenceToken(ref) && /[A-Z]/.test(ref)) return { value: ref, namespace: scheme };
  return undefined;
}

function balanceObservation(
  account: AaDepositAccount,
  instrument: InstrumentObservation,
  currency: string,
  source: SourceRef,
  signal: RawSignal<AaFiData>,
  ctx: AdapterContext,
): Observation | null {
  const summary = account.Summary;
  if (!isRecord(summary)) return null;
  const current = parseDecimalAmount(summary.currentBalance, currency);
  if (!current) return null;
  const odLimit = summary.currentODLimit !== undefined ? parseDecimalAmount(summary.currentODLimit, currency) : null;
  const balance: { -readonly [K in keyof BalanceDetails]: BalanceDetails[K] } = { current: current.money };
  if (odLimit && odLimit.money.minor > 0) balance.limit = odLimit.money;
  const asOf = parseInstant(summary.balanceDateTime, { timeZone: ctx.timeZone ?? AA_DEFAULT_ZONE });
  const shown: Money = current.money;
  return {
    id: observationId(ADAPTER_ID, signal.connectionId, `balance:${account.linkedAccRef}:${summary.balanceDateTime ?? signal.receivedAt}:${contentKey(summary.currentBalance)}`),
    source,
    kind: "balance_snapshot",
    window: "pre_spend",
    stage: "unknown",
    receivedAt: signal.receivedAt,
    occurredAt: asOf ? measuredInstant(asOf, 0.95) : { value: signal.receivedAt, confidence: 0.6 },
    instrument,
    country: "IN",
    references: [],
    balance,
    // Money is unsigned: an overdrawn (negative) balance cannot be represented faithfully.
    confidence: current.negative ? 0.5 : 0.95,
    evidence: {
      summary: `Your ${source.provider ?? "bank"} balance (via Account Aggregator) was ${describeMoney(shown, ctx.locale)}${current.negative ? " overdrawn" : ""}.`,
    },
  };
}
