import { DAY, currencyExponent, formatMoney, maskTail, money, redactSensitive, stableHash, zonedTimeToEpoch } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  AmountComponent,
  BalanceDetails,
  CategoryHint,
  CounterpartyObservation,
  CurrencyCode,
  Direction,
  EpochMillis,
  InstrumentObservation,
  InstrumentType,
  Measured,
  MerchantChannel,
  MerchantObservation,
  Money,
  Observation,
  PaymentRail,
  Platform,
  RawSignal,
  Reference,
  ReferenceType,
  SignalAdapter,
  SignalSourceKind,
  SourceRef,
  SpendWindow,
  TransactionStatus,
  TransactionType,
  TransferKind,
  TypeHint,
} from "@brake/core";
import { normalizeWhitespace, observationId, parseDateTime } from "./shared/text";

/**
 * Ledger sources: the toolkit every account-of-record adapter shares, and the
 * declarative "FutureBankAdapter".
 *
 * Part 1 (toolkit) holds the few primitives where ledger providers disagree
 * and a mistake silently corrupts data: decimal-vs-minor amounts and their
 * sign conventions, ISO instants with and without offsets or times, and
 * scrubbing descriptors before anything is kept. The hand-written ledger
 * adapters (Plaid, Account Aggregator, FinanceKit, card feeds) use the same
 * functions, so every ledger normalizes identically.
 *
 * Part 2 (`createLedgerAdapter`) turns a `LedgerMapping` — dot-path selectors
 * plus value tables — into a SignalAdapter. Adding a bank, neobank or
 * open-banking aggregator whose JSON is a list of transactions is then
 * configuration, not code. Monzo's transaction webhook and UK Open Banking
 * (OBIE Account & Transaction API v3.1 `OBTransaction6`) ship as examples.
 */

/* ================================================================== */
/* Part 1 — ledger toolkit                                             */
/* ================================================================== */

/** How long a redacted evidence excerpt may be shown ("How did BRAKE know this?"). */
export const EXCERPT_TTL_MS = 7 * DAY;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * XML-derived JSON (ReBIT AA FI data) turns a single repeated element into an
 * object instead of a one-element array; treat both the same.
 */
export function asArray<T>(value: T | readonly T[] | null | undefined): readonly T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** Non-empty trimmed string, or undefined. Numbers are stringified (ids sometimes arrive numeric). */
export function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** ISO 4217-shaped code, upper-cased; anything else is rejected rather than guessed. */
export function normalizeCurrency(value: unknown): CurrencyCode | undefined {
  const t = text(value);
  return t && /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : undefined;
}

export interface SignedAmount {
  /** Absolute amount (Money is always non-negative in BRAKE). */
  readonly money: Money;
  /** True when the source value carried a minus sign (and was not zero). */
  readonly negative: boolean;
}

const DECIMAL = /^([+-])?(\d+)(?:\.(\d*))?$/;

/**
 * A provider's decimal amount — JSON number (Plaid, Fidel), decimal string
 * (UK OB `"10.00"`, FinanceKit `Decimal` bridged as a string) or `xs:float`
 * lexical form (AA `"1249.5"`, `"1.2495E3"`) — into exact minor units.
 *
 * Works on the decimal *text* so 0.1 + 0.2 style binary noise never reaches
 * Money; digits beyond the currency's exponent are rounded half-up.
 */
export function parseDecimalAmount(value: unknown, currency: CurrencyCode): SignedAmount | null {
  let raw: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    raw = String(value);
  } else if (typeof value === "string") {
    raw = value.trim().replace(/^[−]/, "-");
  } else {
    return null;
  }
  const exp = currencyExponent(currency);
  if (/e/i.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || Math.abs(n) >= 1e15) return null;
    raw = n.toFixed(Math.min(20, exp + 4));
  }
  const m = DECIMAL.exec(raw);
  if (!m) return null;
  const fraction = m[3] ?? "";
  let minor = Number((m[2] ?? "0") + fraction.slice(0, exp).padEnd(exp, "0"));
  if (fraction.length > exp && Number(fraction[exp]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) return null;
  return { money: money(minor, currency), negative: m[1] === "-" && minor !== 0 };
}

/** An integer amount already in minor units (Monzo `-350` = £3.50 out). */
export function parseMinorAmount(value: unknown, currency: CurrencyCode): SignedAmount | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) return null;
  return { money: money(n, currency), negative: n < 0 };
}

export type InstantFormat = "iso" | "epoch_s" | "epoch_ms" | "dmy" | "mdy" | "ymd";

export interface ParsedInstant {
  readonly at: EpochMillis;
  /** "date" when the source only knew the calendar day (time set to local noon). */
  readonly precision: "datetime" | "date";
}

export interface InstantOptions {
  readonly format?: InstantFormat;
  /** IANA zone for wall-clock values without an offset, and for date-only values. Default UTC. */
  readonly timeZone?: string;
  /**
   * Treat an exact 00:00:00 time as "date only". Several ledgers fill missing
   * times with midnight (Plaid documents `datetime` "may contain default time
   * values (such as 00:00:00)"); a fake midnight would otherwise outrank a
   * real alert timestamp in fusion.
   */
  readonly midnightIsDate?: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function validDate(y: number, mo: number, d: number): boolean {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function dateOnly(y: number, mo: number, d: number, timeZone: string): ParsedInstant | null {
  if (!validDate(y, mo, d)) return null;
  return { at: zonedTimeToEpoch({ year: y, month: mo, day: d, hour: 12, minute: 0, second: 0 }, timeZone), precision: "date" };
}

function offsetMinutes(offset: string): number {
  if (offset.toUpperCase() === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(offset);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * Parse a ledger timestamp. ISO 8601 with an offset is absolute; without one
 * it is wall-clock time in `timeZone`; a bare date is date-precision local
 * noon. Epoch numbers are seconds below 1e11, else milliseconds, unless the
 * format says which.
 */
export function parseInstant(value: unknown, opts: InstantOptions = {}): ParsedInstant | null {
  const zone = opts.timeZone ?? "UTC";
  const format = opts.format ?? "iso";
  if (typeof value === "number" || format === "epoch_s" || format === "epoch_ms") {
    const n = typeof value === "number" ? value : Number(text(value));
    if (!Number.isFinite(n)) return null;
    const ms = format === "epoch_s" ? n * 1000 : format === "epoch_ms" ? n : Math.abs(n) < 1e11 ? n * 1000 : n;
    return { at: Math.round(ms), precision: "datetime" };
  }
  const raw = text(value);
  if (!raw) return null;
  if (format === "dmy" || format === "mdy" || format === "ymd") {
    const order = format === "dmy" ? "DMY" : format === "mdy" ? "MDY" : "YMD";
    const parsed = parseDateTime(raw, { order, timeZone: zone });
    return parsed ? { at: parsed.at, precision: parsed.precision } : null;
  }
  const d = ISO_DATE.exec(raw);
  if (d) return dateOnly(Number(d[1]), Number(d[2]), Number(d[3]), zone);
  const t = ISO_DATETIME.exec(raw);
  if (t) {
    const [y, mo, day, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(t[i] ?? 0)) as [number, number, number, number, number, number];
    const fraction = t[7] ?? "";
    if (!validDate(y, mo, day) || h > 23 || mi > 59 || s > 59) return null;
    if (opts.midnightIsDate && h === 0 && mi === 0 && s === 0 && /^0*$/.test(fraction)) return dateOnly(y, mo, day, zone);
    const ms = Number(fraction.slice(0, 3).padEnd(3, "0"));
    const offset = t[8];
    const at = offset
      ? Date.UTC(y, mo - 1, day, h, mi, s, ms) - offsetMinutes(offset) * 60_000
      : zonedTimeToEpoch({ year: y, month: mo, day, hour: h, minute: mi, second: s }, zone) + ms;
    return { at, precision: "datetime" };
  }
  // Last resort for hand-formatted ledgers ("04/10/2026 10:41"): day-first unless told otherwise.
  const loose = parseDateTime(raw, { timeZone: zone });
  return loose ? { at: loose.at, precision: loose.precision } : null;
}

/**
 * Event time with honest confidence. Date-only values stay below 0.5 so
 * fusion compares them with a one-day slack instead of treating local noon as
 * a real time.
 */
export function measuredInstant(p: ParsedInstant, datetimeConfidence = 0.95): Measured<EpochMillis> {
  return { value: p.at, confidence: p.precision === "date" ? 0.4 : datetimeConfidence };
}

/** Masked card numbers that still show the BIN ("512345XXXXXX1234", "4111 11** **** 1111"). */
const PARTIAL_PAN = /\b\d{4,8}[\s-]?(?:[Xx*•]{2,}[\s-]?){1,4}\d{2,4}\b/g;

/**
 * Tidy and redact a provider descriptor before it is kept anywhere (merchant
 * raw, counterparty name, excerpt). Card numbers, long account/reference
 * digit runs, national ids, e-mails and phone numbers are masked.
 */
export function scrubDescriptor(value: unknown): string | undefined {
  const t = text(value);
  if (!t) return undefined;
  const tidy = normalizeWhitespace(t).replace(PARTIAL_PAN, (m) => maskTail(m.replace(/\D/g, "")));
  const out = redactSensitive(tidy).text.trim();
  return out.length > 0 ? out : undefined;
}

/**
 * A payment handle that is safe to keep: lower-cased, and with a
 * phone-number-like local part masked ("9876543210@ybl" -> "••••3210@ybl").
 * A merchant VPA ("swiggy@icici") passes through unchanged.
 */
export function safeHandle(value: unknown): string | undefined {
  const t = text(value)?.toLowerCase().replace(/\s+/g, "");
  if (!t) return undefined;
  const at = t.indexOf("@");
  const local = at >= 0 ? t.slice(0, at) : t;
  const domain = at >= 0 ? t.slice(at) : "";
  if ((local.match(/\d/g) ?? []).length >= 7) return `${maskTail(local)}${domain}`;
  // E-mail-shaped keys (Pix, PayPal) keep only their first character and domain.
  return redactSensitive(t).text;
}

/** Last four digits of a masked account/card identifier ("****1234", "XXXXXXXX1234"); never more. */
export function last4Of(value: unknown): string | undefined {
  const t = text(value);
  if (!t) return undefined;
  const digits = /(\d{4})\D*$/.exec(t.replace(/[\s-]/g, ""));
  return digits?.[1];
}

/** Evidence excerpt fields: redacted, capped, and expiring 7 days after receipt. */
export function evidenceExcerpt(value: unknown, receivedAt: EpochMillis): { excerpt?: string; excerptExpiresAt?: EpochMillis } {
  const scrubbed = scrubDescriptor(value);
  if (!scrubbed) return {};
  return { excerpt: scrubbed.slice(0, 200), excerptExpiresAt: receivedAt + EXCERPT_TTL_MS };
}

/** ISO 18245 merchant category code as 4 digits, from a number (FinanceKit) or string. */
export function normalizeMcc(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9999) return String(value).padStart(4, "0");
  const t = text(value);
  return t && /^\d{3,4}$/.test(t) ? t.padStart(4, "0") : undefined;
}

/** An MCC is already a neutral vocabulary: pass it through for the intelligence layer to map. */
export function mccHints(mcc: string | undefined, confidence = 0.9): CategoryHint[] {
  return mcc ? [{ scheme: "mcc", value: mcc, confidence }] : [];
}

/** "₹1,249", "$22.99" — locale-aware, never throws on odd currency codes. */
export function describeMoney(m: Money, locale: string | undefined): string {
  try {
    return formatMoney(m, locale ?? "en");
  } catch {
    return `${m.minor / 10 ** currencyExponent(m.currency)} ${m.currency}`;
  }
}

/** Plain-language lifecycle word for evidence summaries. */
export function stageWord(stage: TransactionStatus): string {
  switch (stage) {
    case "pending":
      return "pending";
    case "posted":
      return "posted";
    case "cancelled":
      return "reversed or declined";
    default:
      return stage;
  }
}

/** Short, stable content hash for version-aware natural keys. */
export function contentKey(...parts: ReadonlyArray<string | number | boolean | undefined | null>): string {
  return stableHash(parts.map((p) => (p === undefined || p === null ? "" : String(p))).join("|"));
}

/* ================================================================== */
/* Part 2 — declarative mappings (the FutureBankAdapter)               */
/* ================================================================== */

/**
 * One path or several alternatives (first non-empty wins). Syntax:
 *   "a.b.c"            nested keys
 *   "items[*].amount"  every element of an array (arrays met without [*] are also flattened)
 *   "items[0]"         one element
 *   "$.Data.AccountId" read from the payload root instead of the current record
 */
export type PathSpec = string | readonly string[];

/**
 * Pick a value from a record and translate it through a table. Evaluated as:
 * `const`; else the first non-empty value at `path` looked up in `map`
 * (exact key, then case-insensitive); else `present` when any value exists;
 * else `absent` when none exists; else `default`.
 */
export type ValueSpec<T> =
  | { readonly const: T }
  | {
      readonly path: PathSpec;
      readonly map?: Readonly<Record<string, T>>;
      readonly present?: T;
      readonly absent?: T;
      readonly default?: T;
    };

export interface AmountSpec {
  readonly path: PathSpec;
  /** "major" for decimal amounts ("10.00", 12.5), "minor" for integer cents/pence/paise. */
  readonly unit: "major" | "minor";
  /**
   * Sign convention of the source:
   *   negative_is_debit — money out is negative (Monzo, Australia CDR)
   *   positive_is_debit — money out is positive (Plaid-style)
   *   unsigned          — direction comes from a separate indicator (UK OB, AA, FinanceKit)
   */
  readonly sign: "negative_is_debit" | "positive_is_debit" | "unsigned";
  readonly currency: PathSpec | { readonly const: CurrencyCode };
}

export interface DateSpec {
  readonly path: PathSpec;
  readonly format?: InstantFormat;
  /** Zone for values without an offset; defaults to the user's `ctx.timeZone`, then UTC. */
  readonly timeZone?: string;
  readonly midnightIsDate?: boolean;
  /** Confidence for a full timestamp (date-only values always get 0.4). Default 0.95. */
  readonly confidence?: number;
}

/** A path whose meaning depends on direction (UK OB: the counterparty is the creditor of a debit, the debtor of a credit). */
export type DirectionalPath = PathSpec | { readonly debit: PathSpec; readonly credit: PathSpec };

export interface HintEntry {
  /** A BRAKE taxonomy id ("eating_out.restaurant"). */
  readonly brake?: string;
  /** A plain-language keyword the intelligence layer understands ("groceries"). */
  readonly keyword?: string;
  readonly type?: TransactionType;
  readonly transferKind?: TransferKind;
  /** Default 0.7. */
  readonly confidence?: number;
  /** Apply only when the movement has this direction (a "refund" code on a debit is noise). */
  readonly direction?: Direction;
}

/** Provider vocabulary at `path` -> neutral category/type hints. */
export interface HintTableSpec {
  readonly path: PathSpec;
  readonly map: Readonly<Record<string, HintEntry | readonly HintEntry[]>>;
}

export interface ReferenceSpec {
  readonly type: ReferenceType;
  readonly path: PathSpec;
  /** Template: "{AccountId}" reads the record, "{$.Data.AccountId}" the payload root. */
  readonly namespace: string;
}

export type StageValue = TransactionStatus | "skip";

export interface LedgerFieldMap {
  /** Provider transaction id: becomes the `provider_transaction_id` reference. */
  readonly id: PathSpec;
  /** Namespace template for the provider id ("monzo:{account_id}"). Ids compare only within a namespace. */
  readonly idNamespace: string;
  /**
   * Paths hashed into a synthetic natural key when a record has no provider id
   * (OBIE v3.1 makes `TransactionId` optional). Synthetic keys are never
   * emitted as references — they are not the provider's identifiers.
   */
  readonly fallbackKey?: readonly string[];
  readonly amount: AmountSpec;
  /** Required when `amount.sign` is "unsigned"; otherwise overrides the sign when it resolves. */
  readonly direction?: ValueSpec<Direction>;
  /** Evaluated in order; the first spec that resolves decides. "skip" drops the record (future-dated, informational). */
  readonly stage?: readonly ValueSpec<StageValue>[];
  /** Stage when no rule resolves. Default "posted". */
  readonly defaultStage?: StageValue;
  /** First parseable wins. */
  readonly occurredAt?: readonly DateSpec[];
  readonly merchantRaw?: PathSpec;
  readonly merchantName?: PathSpec;
  readonly merchantWebsite?: PathSpec;
  readonly merchantHandle?: PathSpec;
  readonly mcc?: PathSpec;
  readonly channel?: ValueSpec<MerchantChannel>;
  readonly counterpartyName?: DirectionalPath;
  readonly counterpartyHandle?: DirectionalPath;
  readonly accountRef?: PathSpec;
  /** Masked identifier; only its last four digits are kept. */
  readonly last4?: PathSpec;
  readonly instrumentType?: ValueSpec<InstrumentType>;
  readonly network?: PathSpec;
  readonly cardKind?: ValueSpec<"credit" | "debit" | "prepaid">;
  readonly rail?: ValueSpec<PaymentRail>;
  readonly references?: readonly ReferenceSpec[];
  readonly hints?: readonly HintTableSpec[];
  /** Balance after the entry (UK OB `Balance`); kept as `balance.current`. */
  readonly balanceAfter?: AmountSpec;
  /** Amount in the merchant's currency for FX purchases (bridges e-mail receipts in fusion). */
  readonly originalAmount?: AmountSpec;
  /** ISO 3166-1 alpha-2. */
  readonly country?: PathSpec;
}

export interface BalanceMap {
  /** Path to balance records ("Data.Balance[*]"). */
  readonly records: string;
  readonly accountRef?: PathSpec;
  readonly amount: AmountSpec;
  /** Which slot a record fills; records resolving to nothing are ignored. First record per slot wins. */
  readonly slot: ValueSpec<"available" | "current" | "limit">;
  readonly asOf?: readonly DateSpec[];
  readonly last4?: PathSpec;
  readonly instrumentType?: ValueSpec<InstrumentType>;
}

export interface LedgerMapping {
  /** Adapter id and `SourceRef.adapterId` (kebab-case, e.g. "monzo-webhook"). */
  readonly id: string;
  readonly kind: SignalSourceKind;
  readonly displayName: string;
  /** Provenance phrase that reads after "your": "Monzo account (webhook)". */
  readonly label: string;
  /** Institution behind the data, when the mapping is institution-specific. */
  readonly provider?: string;
  readonly platforms?: readonly Platform[];
  readonly windows?: readonly SpendWindow[];
  readonly requiresCapabilities?: readonly string[];
  readonly privacy?: AdapterDescriptor["privacy"];
  /** Every condition must hold, else the payload is ignored as not financial (other webhook types). */
  readonly accept?: ReadonlyArray<{ readonly path: string; readonly oneOf: readonly string[] }>;
  readonly transactions?: { readonly records: string; readonly fields: LedgerFieldMap };
  readonly balances?: BalanceMap;
  /** Observation confidence per stage. Defaults: posted 0.97, confirmed 0.95, pending 0.9, cancelled 0.9. */
  readonly confidence?: Partial<Record<TransactionStatus, number>>;
  /** Window per stage. Default post_spend: ledger APIs report after the fact. */
  readonly windowByStage?: Partial<Record<TransactionStatus, SpendWindow>>;
}

/* ------------------------------------------------------------------ */
/* Path evaluation                                                     */
/* ------------------------------------------------------------------ */

type PathStep = { readonly kind: "key"; readonly key: string } | { readonly kind: "all" } | { readonly kind: "index"; readonly index: number };

const pathCache = new Map<string, readonly PathStep[]>();

function compilePath(path: string): readonly PathStep[] {
  const cached = pathCache.get(path);
  if (cached) return cached;
  const steps: PathStep[] = [];
  const re = /([^.[\]]+)|\[(\*|\d+)\]/g;
  for (let m = re.exec(path); m !== null; m = re.exec(path)) {
    if (m[1] !== undefined) steps.push({ kind: "key", key: m[1] });
    else if (m[2] === "*") steps.push({ kind: "all" });
    else steps.push({ kind: "index", index: Number(m[2]) });
  }
  pathCache.set(path, steps);
  return steps;
}

/** Every value at `path` under `root`. Arrays met at a key step are flattened. */
export function selectAll(root: unknown, path: string): unknown[] {
  if (path === "$" || path === "") return [root];
  let current: unknown[] = [root];
  for (const step of compilePath(path)) {
    const next: unknown[] = [];
    for (const node of current) {
      if (step.kind === "key") {
        for (const item of Array.isArray(node) ? node : [node]) {
          if (isRecord(item) && Object.prototype.hasOwnProperty.call(item, step.key)) next.push(item[step.key]);
        }
      } else if (step.kind === "all") {
        if (Array.isArray(node)) next.push(...node);
        else if (node !== undefined && node !== null) next.push(node);
      } else if (Array.isArray(node) && node[step.index] !== undefined) {
        next.push(node[step.index]);
      }
    }
    current = next;
  }
  return current;
}

interface Scope {
  readonly record: unknown;
  readonly root: unknown;
}

function valuesAt(scope: Scope, path: string): unknown[] {
  return path.startsWith("$.") ? selectAll(scope.root, path.slice(2)) : selectAll(scope.record, path);
}

function paths(spec: PathSpec): readonly string[] {
  return typeof spec === "string" ? [spec] : spec;
}

type Scalar = string | number | boolean;

/** First non-empty scalar at any of the paths. */
function firstScalar(scope: Scope, spec: PathSpec): Scalar | undefined {
  for (const p of paths(spec)) {
    for (const v of valuesAt(scope, p)) {
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "boolean") return v;
    }
  }
  return undefined;
}

function firstText(scope: Scope, spec: PathSpec | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const v = firstScalar(scope, spec);
  return v === undefined || typeof v === "boolean" ? undefined : String(v);
}

function lookup<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(map)) if (k.toLowerCase() === lower) return map[k];
  return undefined;
}

function resolveValue<T>(scope: Scope, spec: ValueSpec<T> | undefined): T | undefined {
  if (!spec) return undefined;
  if ("const" in spec) return spec.const;
  const v = firstScalar(scope, spec.path);
  if (v === undefined) return spec.absent ?? spec.default;
  if (spec.map) {
    const hit = lookup(spec.map, String(v));
    if (hit !== undefined) return hit;
  }
  return spec.present ?? spec.default;
}

function fillTemplate(scope: Scope, template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_m, p: string) => firstText(scope, p.trim()) ?? "");
}

function directional(spec: DirectionalPath | undefined, direction: Direction | undefined): PathSpec | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "string" || Array.isArray(spec)) return spec as PathSpec;
  const d = spec as { readonly debit: PathSpec; readonly credit: PathSpec };
  return direction === "credit" ? d.credit : direction === "debit" ? d.debit : undefined;
}

function readAmount(scope: Scope, spec: AmountSpec, ctx: AdapterContext): SignedAmount | null {
  const declared = spec.currency;
  const currency =
    (typeof declared === "object" && !Array.isArray(declared)
      ? normalizeCurrency((declared as { readonly const: CurrencyCode }).const)
      : normalizeCurrency(firstText(scope, declared as PathSpec))) ?? normalizeCurrency(ctx.defaultCurrency);
  if (!currency) return null;
  const raw = firstScalar(scope, spec.path);
  if (raw === undefined || typeof raw === "boolean") return null;
  return spec.unit === "minor" ? parseMinorAmount(raw, currency) : parseDecimalAmount(raw, currency);
}

function readInstant(scope: Scope, specs: readonly DateSpec[] | undefined, ctx: AdapterContext): Measured<EpochMillis> | undefined {
  for (const spec of specs ?? []) {
    const raw = firstScalar(scope, spec.path);
    if (raw === undefined || typeof raw === "boolean") continue;
    const parsed = parseInstant(raw, {
      ...(spec.format ? { format: spec.format } : {}),
      timeZone: spec.timeZone ?? ctx.timeZone ?? "UTC",
      ...(spec.midnightIsDate ? { midnightIsDate: true } : {}),
    });
    if (parsed) return measuredInstant(parsed, spec.confidence ?? 0.95);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const STAGES: ReadonlySet<string> = new Set(["intent", "pending", "confirmed", "posted", "refunded", "cancelled", "unknown", "skip"]);

/** Problems with a mapping, as human-readable strings (empty when valid). */
export function validateLedgerMapping(mapping: LedgerMapping): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mapping.id ?? "")) errors.push("id must be kebab-case");
  if (!mapping.label?.trim()) errors.push("label is required (it is shown after 'your' in provenance)");
  if (!mapping.transactions && !mapping.balances) errors.push("map transactions, balances or both");
  const fields = mapping.transactions?.fields;
  if (mapping.transactions) {
    if (!mapping.transactions.records) errors.push("transactions.records path is required");
    if (!fields?.id) errors.push("transactions.fields.id is required");
    if (!fields?.idNamespace) errors.push("transactions.fields.idNamespace is required (references compare within a namespace)");
    if (!fields?.amount) errors.push("transactions.fields.amount is required");
    if (fields?.amount?.sign === "unsigned" && !fields.direction) errors.push("unsigned amounts need fields.direction");
    for (const rule of fields?.stage ?? []) {
      const values = "const" in rule ? [rule.const] : [...Object.values(rule.map ?? {}), rule.present, rule.absent, rule.default];
      for (const v of values) if (v !== undefined && !STAGES.has(v)) errors.push(`unknown stage "${v}"`);
    }
    for (const table of fields?.hints ?? []) {
      for (const entry of Object.values(table.map).flatMap((e) => asArray<HintEntry>(e))) {
        if (entry.brake !== undefined && !/^[a-z_]+(?:\.[a-z_]+)?$/.test(entry.brake)) errors.push(`malformed BRAKE category id "${entry.brake}"`);
      }
    }
  }
  if (mapping.balances && !mapping.balances.records) errors.push("balances.records path is required");
  return errors;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIDENCE: Partial<Record<TransactionStatus, number>> = { posted: 0.97, confirmed: 0.95, pending: 0.9, cancelled: 0.9 };

/**
 * Build an adapter from a declarative mapping. Throws `RangeError` for an
 * invalid mapping so a misconfigured bank fails at start-up, not per payload.
 *
 * Privacy is enforced by the engine, whatever the mapping says: descriptors
 * are scrubbed, handles masked, instruments reduced to last four digits, and
 * the raw record is never copied into an observation.
 */
export function createLedgerAdapter(mapping: LedgerMapping): SignalAdapter<unknown> {
  const errors = validateLedgerMapping(mapping);
  if (errors.length > 0) throw new RangeError(`Invalid ledger mapping "${mapping.id}": ${errors.join("; ")}`);

  const descriptor: AdapterDescriptor = {
    id: mapping.id,
    kind: mapping.kind,
    displayName: mapping.displayName,
    windows: mapping.windows ?? ["post_spend"],
    platforms: mapping.platforms ?? ["server"],
    requiresCapabilities: mapping.requiresCapabilities ?? [],
    privacy: mapping.privacy ?? {
      sensitivity: "high",
      dataCategories: ["account transactions (amount, merchant, date)", "account balances", "masked account numbers (last 4)"],
      processing: "server",
    },
  };

  return {
    descriptor,
    parse(signal: RawSignal<unknown>, ctx: AdapterContext): AdapterResult {
      const root = signal.payload;
      if (!isRecord(root) && !Array.isArray(root)) return { status: "rejected", reason: `${mapping.displayName}: payload is not JSON` };
      for (const cond of mapping.accept ?? []) {
        const v = firstText({ record: root, root }, cond.path);
        if (v === undefined || !cond.oneOf.some((o) => o.toLowerCase() === v.toLowerCase())) return { status: "ignored", reason: "not_financial" };
      }

      const source: SourceRef = {
        adapterId: mapping.id,
        kind: mapping.kind,
        connectionId: signal.connectionId,
        label: mapping.label,
        ...(mapping.provider ? { provider: mapping.provider } : {}),
      };
      const observations: Observation[] = [];
      let records = 0;
      if (mapping.transactions) {
        for (const record of recordsAt(root, mapping.transactions.records)) {
          records += 1;
          const o = transactionObservation(mapping, mapping.transactions.fields, { record, root }, source, signal, ctx);
          if (o) observations.push(o);
        }
      }
      if (mapping.balances) {
        const balances = balanceObservations(mapping, mapping.balances, root, source, signal, ctx);
        records += balances.records;
        observations.push(...balances.observations);
      }
      // No records at all: this mapping does not understand the payload. Records that were all
      // deliberately skipped (future-dated, informational) are a valid, empty result.
      if (records === 0) return { status: "ignored", reason: "unsupported_format" };
      return { status: "observations", observations };
    },
  };
}

function recordsAt(root: unknown, path: string): readonly Readonly<Record<string, unknown>>[] {
  return selectAll(root, path)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter(isRecord);
}

function transactionObservation(
  mapping: LedgerMapping,
  f: LedgerFieldMap,
  scope: Scope,
  source: SourceRef,
  signal: RawSignal<unknown>,
  ctx: AdapterContext,
): Observation | null {
  const providerId = firstText(scope, f.id);
  const fallback = providerId ? undefined : f.fallbackKey?.map((p) => firstText(scope, p) ?? "").join("|");
  if (!providerId && !fallback?.replace(/\|/g, "")) return null;

  const stage = resolveStage(scope, f);
  if (stage === "skip") return null;

  const amount = readAmount(scope, f.amount, ctx);
  if (!amount) return null;
  const direction = resolveValue(scope, f.direction) ?? signDirection(amount, f.amount.sign);

  const merchant = merchantFrom(scope, f);
  const counterparty = counterpartyFrom(scope, f, direction);
  const instrument = instrumentFrom(scope, f.accountRef, f.last4, f.instrumentType, f.network, f.cardKind);
  const rail = resolveValue(scope, f.rail);
  const references = referencesFrom(scope, f, providerId);
  const { categoryHints, typeHints } = hintsFrom(mapping.id, scope, f, direction, merchant?.mcc);
  const occurredAt = readInstant(scope, f.occurredAt, ctx);
  const country = firstText(scope, f.country);
  const balanceAfter = f.balanceAfter ? readAmount(scope, f.balanceAfter, ctx) : null;
  const original = f.originalAmount ? readAmount(scope, f.originalAmount, ctx) : null;
  const breakdown: AmountComponent[] =
    original && original.money.currency !== amount.money.currency ? [{ kind: "original_currency", amount: original.money }] : [];

  const naturalKey = `${providerId ?? `h:${stableHash(fallback ?? "")}`}#${stage}#${contentKey(amount.money.minor, amount.money.currency, direction)}`;
  const name = merchant?.name ?? merchant?.raw ?? counterparty?.name;
  const summary = [
    `${mapping.displayName}:`,
    stageWord(stage),
    describeMoney(amount.money, ctx.locale),
    direction ?? "movement",
    name ? `${direction === "credit" ? "from" : "at"} ${name}` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  return {
    id: observationId(mapping.id, signal.connectionId, naturalKey),
    source,
    kind: "money_movement",
    window: mapping.windowByStage?.[stage] ?? "post_spend",
    stage,
    receivedAt: signal.receivedAt,
    ...(occurredAt ? { occurredAt } : {}),
    ...(direction ? { direction } : {}),
    amount: { value: amount.money, confidence: stage === "posted" ? 0.99 : 0.95 },
    ...(breakdown.length > 0 ? { amountBreakdown: breakdown } : {}),
    ...(merchant ? { merchant } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(instrument ? { instrument } : {}),
    ...(rail ? { rail } : {}),
    ...(country && /^[A-Za-z]{2}$/.test(country) ? { country: country.toUpperCase() } : {}),
    references,
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    ...(typeHints.length > 0 ? { typeHints } : {}),
    ...(balanceAfter ? { balance: { current: balanceAfter.money } } : {}),
    confidence: mapping.confidence?.[stage] ?? DEFAULT_CONFIDENCE[stage] ?? 0.9,
    evidence: { summary: `${summary}.` },
  };
}

function resolveStage(scope: Scope, f: LedgerFieldMap): StageValue {
  for (const rule of f.stage ?? []) {
    const v = resolveValue(scope, rule);
    if (v !== undefined) return v;
  }
  return f.defaultStage ?? "posted";
}

function signDirection(amount: SignedAmount, sign: AmountSpec["sign"]): Direction | undefined {
  if (sign === "unsigned" || amount.money.minor === 0) return undefined;
  const outflow = sign === "negative_is_debit" ? amount.negative : !amount.negative;
  return outflow ? "debit" : "credit";
}

function merchantFrom(scope: Scope, f: LedgerFieldMap): MerchantObservation | undefined {
  const name = scrubDescriptor(firstText(scope, f.merchantName));
  const raw = scrubDescriptor(firstText(scope, f.merchantRaw)) ?? name;
  if (!raw) return undefined;
  const mcc = normalizeMcc(f.mcc ? firstScalar(scope, f.mcc) : undefined);
  const handle = safeHandle(firstText(scope, f.merchantHandle));
  const website = firstText(scope, f.merchantWebsite);
  const channel = resolveValue(scope, f.channel);
  return {
    raw,
    ...(name ? { name } : {}),
    ...(mcc ? { mcc } : {}),
    ...(handle ? { handle } : {}),
    ...(website ? { website } : {}),
    ...(channel ? { channel } : {}),
    confidence: name ? 0.9 : 0.7,
  };
}

function counterpartyFrom(scope: Scope, f: LedgerFieldMap, direction: Direction | undefined): CounterpartyObservation | undefined {
  const namePath = directional(f.counterpartyName, direction);
  const handlePath = directional(f.counterpartyHandle, direction);
  const name = scrubDescriptor(namePath ? firstText(scope, namePath) : undefined);
  const handle = safeHandle(handlePath ? firstText(scope, handlePath) : undefined);
  if (!name && !handle) return undefined;
  return { ...(name ? { name } : {}), ...(handle ? { handle } : {}) };
}

function instrumentFrom(
  scope: Scope,
  accountRefPath: PathSpec | undefined,
  last4Path: PathSpec | undefined,
  typeSpec: ValueSpec<InstrumentType> | undefined,
  networkPath?: PathSpec,
  cardKindSpec?: ValueSpec<"credit" | "debit" | "prepaid">,
): InstrumentObservation | undefined {
  const accountRef = firstText(scope, accountRefPath);
  const last4 = last4Of(firstText(scope, last4Path));
  const type = resolveValue(scope, typeSpec) ?? (accountRef || last4 ? "bank_account" : undefined);
  if (!type) return undefined;
  const network = firstText(scope, networkPath)?.toLowerCase();
  const cardKind = resolveValue(scope, cardKindSpec);
  return {
    type,
    ...(last4 ? { last4 } : {}),
    ...(accountRef ? { accountRef } : {}),
    ...(network ? { network } : {}),
    ...(cardKind && type === "card" ? { cardKind } : {}),
  };
}

function referencesFrom(scope: Scope, f: LedgerFieldMap, providerId: string | undefined): Reference[] {
  const refs: Reference[] = [];
  if (providerId) refs.push({ type: "provider_transaction_id", value: providerId, namespace: fillTemplate(scope, f.idNamespace) });
  for (const spec of f.references ?? []) {
    const value = firstText(scope, spec.path);
    if (!value) continue;
    const ref: Reference = { type: spec.type, value, namespace: fillTemplate(scope, spec.namespace) };
    if (!refs.some((r) => r.type === ref.type && r.value === ref.value && r.namespace === ref.namespace)) refs.push(ref);
  }
  return refs;
}

function hintsFrom(
  mappingId: string,
  scope: Scope,
  f: LedgerFieldMap,
  direction: Direction | undefined,
  mcc: string | undefined,
): { categoryHints: CategoryHint[]; typeHints: TypeHint[] } {
  const categoryHints: CategoryHint[] = [...mccHints(mcc)];
  const typeHints: TypeHint[] = [];
  for (const table of f.hints ?? []) {
    const value = firstScalar(scope, table.path);
    if (value === undefined) continue;
    const hit = lookup(table.map, String(value));
    if (hit === undefined) continue;
    for (const entry of asArray<HintEntry>(hit)) {
      if (entry.direction && entry.direction !== direction) continue;
      const confidence = entry.confidence ?? 0.7;
      if (entry.brake) categoryHints.push({ scheme: "brake", value: entry.brake, confidence });
      if (entry.keyword) categoryHints.push({ scheme: "keyword", value: entry.keyword, confidence });
      if (entry.type) {
        typeHints.push({
          type: entry.type,
          ...(entry.transferKind ? { transferKind: entry.transferKind } : {}),
          confidence,
          reason: `${mappingId}:${paths(table.path)[0] ?? "value"}=${String(value)}`,
        });
      }
    }
  }
  return { categoryHints, typeHints };
}

function balanceObservations(
  mapping: LedgerMapping,
  b: BalanceMap,
  root: unknown,
  source: SourceRef,
  signal: RawSignal<unknown>,
  ctx: AdapterContext,
): { observations: Observation[]; records: number } {
  interface Acc {
    details: { available?: Money; current?: Money; limit?: Money };
    at?: Measured<EpochMillis>;
    instrument?: InstrumentObservation;
    key: string;
  }
  const byAccount = new Map<string, Acc>();
  let records = 0;
  for (const record of recordsAt(root, b.records)) {
    records += 1;
    const scope: Scope = { record, root };
    const slot = resolveValue(scope, b.slot);
    const amount = readAmount(scope, b.amount, ctx);
    if (!slot || !amount) continue;
    const account = firstText(scope, b.accountRef) ?? "";
    const acc: Acc = byAccount.get(account) ?? { details: {}, key: "" };
    if (acc.details[slot] === undefined) acc.details[slot] = amount.money;
    const at = readInstant(scope, b.asOf, ctx);
    if (at && (!acc.at || at.value > acc.at.value)) acc.at = at;
    acc.instrument ??= instrumentFrom(scope, b.accountRef, b.last4, b.instrumentType);
    acc.key += `|${slot}:${amount.money.minor}${amount.money.currency}`;
    byAccount.set(account, acc);
  }
  const observations: Observation[] = [];
  for (const [account, acc] of byAccount) {
    const balance: BalanceDetails = acc.details;
    const shown = acc.details.current ?? acc.details.available;
    observations.push({
      id: observationId(mapping.id, signal.connectionId, `balance:${account}:${acc.at?.value ?? signal.receivedAt}:${stableHash(acc.key)}`),
      source,
      kind: "balance_snapshot",
      window: "pre_spend",
      stage: "unknown",
      receivedAt: signal.receivedAt,
      occurredAt: acc.at ?? { value: signal.receivedAt, confidence: 0.6 },
      ...(acc.instrument ? { instrument: acc.instrument } : {}),
      references: [],
      balance,
      confidence: 0.95,
      evidence: { summary: `${mapping.displayName}: balance ${shown ? describeMoney(shown, ctx.locale) : "update"}.` },
    });
  }
  return { observations, records };
}

/* ------------------------------------------------------------------ */
/* Example mappings                                                    */
/* ------------------------------------------------------------------ */

const CARD_MASTERCARD: PaymentRail = { family: "card", scheme: "mastercard" };

/**
 * Monzo `category` (docs.monzo.com transactions: general, eating_out,
 * expenses, transport, cash, bills, entertainment, shopping, holidays,
 * groceries; newer apps add personal_care, family, charity, gifts, savings,
 * transfers, income, finances) -> neutral hints. Monzo assigns these
 * automatically and users can change them, so they are hints, not truth.
 */
const MONZO_CATEGORIES: Readonly<Record<string, HintEntry | readonly HintEntry[]>> = {
  groceries: { brake: "groceries", confidence: 0.75 },
  eating_out: { brake: "eating_out", confidence: 0.75 },
  transport: { brake: "transport", confidence: 0.75 },
  shopping: { brake: "shopping", confidence: 0.7 },
  entertainment: { brake: "entertainment", confidence: 0.7 },
  bills: { brake: "bills", confidence: 0.7 },
  holidays: { brake: "travel", confidence: 0.7 },
  personal_care: { brake: "personal_care", confidence: 0.7 },
  charity: { brake: "donations", confidence: 0.7 },
  gifts: { brake: "gifts", confidence: 0.6 },
  cash: { type: "cash_withdrawal", confidence: 0.75, direction: "debit" },
  savings: { type: "transfer", transferKind: "own_account", confidence: 0.7 },
  transfers: { type: "transfer", confidence: 0.6 },
  income: { type: "income", confidence: 0.7, direction: "credit" },
};

/**
 * Monzo `transaction.created` webhook (docs.monzo.com "Webhooks"; example
 * payload `{"type":"transaction.created","data":{"account_id":"acc_…",
 * "amount":-350,"created":"2015-09-04T14:28:40Z","currency":"GBP",
 * "description":"Ozone Coffee Roasters","id":"tx_…","category":"eating_out",
 * "is_load":false,"settled":"…","merchant":{…}}}`).
 *
 * Amounts are signed minor units (negative = money out). `settled` is empty
 * until the card authorization settles; the transaction `id` is stable from
 * authorization to settlement, so the pending and posted observations share a
 * provider id and fuse. A `decline_reason` marks a declined attempt.
 * Monzo cards are Mastercard; a merchant object means a card payment.
 */
export const MONZO_TRANSACTION_WEBHOOK_MAPPING: LedgerMapping = {
  id: "monzo-webhook",
  kind: "neobank_api",
  displayName: "Monzo",
  label: "Monzo account",
  provider: "Monzo",
  platforms: ["server"],
  windows: ["post_spend"],
  requiresCapabilities: ["data:neobank-api"],
  privacy: {
    sensitivity: "high",
    dataCategories: ["Monzo transactions (amount, merchant, category, time)"],
    processing: "server",
  },
  accept: [{ path: "type", oneOf: ["transaction.created", "transaction.updated"] }],
  transactions: {
    records: "data",
    fields: {
      id: "id",
      idNamespace: "monzo:{account_id}",
      amount: { path: "amount", unit: "minor", sign: "negative_is_debit", currency: "currency" },
      stage: [
        { path: "decline_reason", present: "cancelled" },
        { path: "settled", present: "posted", absent: "pending" },
      ],
      occurredAt: [{ path: "created" }],
      merchantRaw: ["description"],
      merchantName: ["merchant.name"],
      merchantWebsite: ["merchant.metadata.website"],
      country: ["merchant.address.country"],
      accountRef: "account_id",
      instrumentType: { const: "bank_account" },
      rail: { path: "merchant.id", present: CARD_MASTERCARD },
      originalAmount: { path: "local_amount", unit: "minor", sign: "negative_is_debit", currency: "local_currency" },
      hints: [
        { path: "category", map: MONZO_CATEGORIES },
        { path: "is_load", map: { true: { type: "transfer", transferKind: "wallet_load", confidence: 0.8, direction: "credit" } } },
      ],
    },
  },
};

const FASTER_PAYMENTS: PaymentRail = { family: "account_to_account_instant", scheme: "faster_payments" };

/**
 * UK proprietary transaction codes (BACS-era codes many ASPSPs expose in
 * `ProprietaryBankTransactionCode.Code`): a data pack, extended per bank.
 */
const UK_PROPRIETARY_RAILS: Readonly<Record<string, PaymentRail>> = {
  DD: { family: "direct_debit", scheme: "bacs_dd" },
  "DIRECT DEBIT": { family: "direct_debit", scheme: "bacs_dd" },
  SO: FASTER_PAYMENTS,
  "STANDING ORDER": FASTER_PAYMENTS,
  FPO: FASTER_PAYMENTS,
  FPI: FASTER_PAYMENTS,
  "FASTER PAYMENT": FASTER_PAYMENTS,
  BGC: { family: "account_to_account_batch", scheme: "bacs" },
  BAC: { family: "account_to_account_batch", scheme: "bacs" },
  DEB: { family: "card" },
  POS: { family: "card" },
  CARD: { family: "card" },
  ATM: { family: "cash", scheme: "atm" },
  CPT: { family: "cash", scheme: "atm" },
  CHQ: { family: "cheque" },
  TFR: { family: "account_to_account_instant" },
};

const UK_PROPRIETARY_HINTS: Readonly<Record<string, HintEntry | readonly HintEntry[]>> = {
  ATM: { type: "cash_withdrawal", confidence: 0.9, direction: "debit" },
  CPT: { type: "cash_withdrawal", confidence: 0.9, direction: "debit" },
  CHG: { type: "fee", confidence: 0.8, direction: "debit" },
  FEE: { type: "fee", confidence: 0.8, direction: "debit" },
  INT: [
    { type: "income", confidence: 0.8, direction: "credit" },
    { type: "fee", confidence: 0.7, direction: "debit" },
  ],
};

/**
 * ISO 20022 `ExternalCategoryPurpose1Code` (OBIE `CategoryPurposeCode`, v3.1.x
 * optional / v4) -> type hints (docs/research/10 §A6).
 */
const ISO_CATEGORY_PURPOSE: Readonly<Record<string, HintEntry | readonly HintEntry[]>> = {
  CCRD: { type: "credit_card_payment", confidence: 0.9, direction: "debit" },
  DCRD: { type: "purchase", confidence: 0.6, direction: "debit" },
  GP2P: { type: "transfer", transferKind: "p2p_other", confidence: 0.7 },
  MP2P: { type: "transfer", transferKind: "p2p_other", confidence: 0.7 },
  MP2B: { type: "purchase", confidence: 0.6, direction: "debit" },
  SALA: { type: "income", confidence: 0.9, direction: "credit" },
  LOAN: { type: "loan_payment", confidence: 0.75, direction: "debit" },
  TAXS: { type: "tax", confidence: 0.85, direction: "debit" },
  CASH: { type: "transfer", transferKind: "own_account", confidence: 0.6 },
  SWEP: { type: "transfer", transferKind: "own_account", confidence: 0.8 },
  TOPG: { type: "transfer", transferKind: "own_account", confidence: 0.7 },
};

/**
 * UK Open Banking Account & Transaction API v3.1 — `GET /accounts/{AccountId}/transactions`
 * (`OBReadTransaction6`: `{"Data":{"Transaction":[OBTransaction6…]},"Links":…,"Meta":…}`)
 * and `GET /accounts/{AccountId}/balances` (`OBReadBalance1`: `Data.Balance[]`).
 * Field names from the OBIE read-write-api-specs (account-info-openapi.yaml):
 * `TransactionId`, `CreditDebitIndicator` Credit|Debit, `Status` Booked|Pending
 * (v4 codes BOOK/PDNG/FUTR/INFO/RJCT also accepted), `BookingDateTime`,
 * `ValueDateTime` (offset mandatory), `Amount{Amount,Currency}` (unsigned
 * decimal string), `TransactionInformation`, `MerchantDetails`,
 * `CardInstrument{CardSchemeName,AuthorisationType,Identification}`,
 * `Balance` (after the entry), `CurrencyExchange.InstructedAmount`.
 *
 * OBIE has no pending→booked link; fusion matches those pairs fuzzily. The
 * counterparty is the creditor of a debit and the debtor of a credit. Account
 * identifications (sort code + account number) are deliberately not mapped.
 */
export const OBIE_ACCOUNT_TRANSACTIONS_MAPPING: LedgerMapping = {
  id: "uk-open-banking",
  kind: "open_banking",
  displayName: "UK Open Banking",
  label: "bank account via Open Banking",
  platforms: ["server"],
  windows: ["pre_spend", "post_spend"],
  requiresCapabilities: ["data:open-banking-ais"],
  privacy: {
    sensitivity: "high",
    dataCategories: ["bank transactions shared under your Open Banking consent", "account balances", "masked card numbers (last 4)"],
    processing: "server",
  },
  transactions: {
    records: "Data.Transaction[*]",
    fields: {
      id: "TransactionId",
      idNamespace: "obie:{AccountId}",
      fallbackKey: ["AccountId", "BookingDateTime", "Amount.Amount", "Amount.Currency", "CreditDebitIndicator", "TransactionInformation"],
      amount: { path: "Amount.Amount", unit: "major", sign: "unsigned", currency: "Amount.Currency" },
      direction: { path: "CreditDebitIndicator", map: { Debit: "debit", Credit: "credit", DBIT: "debit", CRDT: "credit" } },
      stage: [
        {
          path: "Status",
          map: { Booked: "posted", Pending: "pending", BOOK: "posted", PDNG: "pending", RJCT: "cancelled", FUTR: "skip", INFO: "skip" },
        },
      ],
      occurredAt: [{ path: "BookingDateTime" }, { path: "ValueDateTime", confidence: 0.6 }],
      merchantRaw: ["TransactionInformation", "MerchantDetails.MerchantName"],
      merchantName: ["MerchantDetails.MerchantName"],
      mcc: ["MerchantDetails.MerchantCategoryCode"],
      channel: {
        path: "CardInstrument.AuthorisationType",
        map: { Contactless: "in_store", PIN: "in_store", ConsumerDevice: "in_store", None: "online" },
      },
      counterpartyName: { debit: ["CreditorAccount.Name", "UltimateCreditor.Name"], credit: ["DebtorAccount.Name", "UltimateDebtor.Name"] },
      accountRef: "AccountId",
      last4: "CardInstrument.Identification",
      network: "CardInstrument.CardSchemeName",
      instrumentType: { path: "CardInstrument.CardSchemeName", present: "card", absent: "bank_account" },
      rail: { path: "ProprietaryBankTransactionCode.Code", map: UK_PROPRIETARY_RAILS },
      hints: [
        { path: "ProprietaryBankTransactionCode.Code", map: UK_PROPRIETARY_HINTS },
        { path: "CategoryPurposeCode", map: ISO_CATEGORY_PURPOSE },
        { path: "SupplementaryData.CategoryPurposeCode", map: ISO_CATEGORY_PURPOSE },
      ],
      balanceAfter: { path: "Balance.Amount.Amount", unit: "major", sign: "unsigned", currency: "Balance.Amount.Currency" },
      originalAmount: {
        path: "CurrencyExchange.InstructedAmount.Amount",
        unit: "major",
        sign: "unsigned",
        currency: "CurrencyExchange.InstructedAmount.Currency",
      },
    },
  },
  balances: {
    records: "Data.Balance[*]",
    accountRef: "AccountId",
    amount: { path: "Amount.Amount", unit: "major", sign: "unsigned", currency: "Amount.Currency" },
    slot: {
      path: "Type",
      map: {
        InterimAvailable: "available",
        ClosingAvailable: "available",
        Expected: "available",
        ITAV: "available",
        CLAV: "available",
        InterimBooked: "current",
        ClosingBooked: "current",
        ITBD: "current",
        CLBD: "current",
      },
    },
    asOf: [{ path: "DateTime" }],
    instrumentType: { const: "bank_account" },
  },
};

/** The example mappings, by id, for registries and tests. */
export const EXAMPLE_LEDGER_MAPPINGS: Readonly<Record<string, LedgerMapping>> = {
  [MONZO_TRANSACTION_WEBHOOK_MAPPING.id]: MONZO_TRANSACTION_WEBHOOK_MAPPING,
  [OBIE_ACCOUNT_TRANSACTIONS_MAPPING.id]: OBIE_ACCOUNT_TRANSACTIONS_MAPPING,
};
