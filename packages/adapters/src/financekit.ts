import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  AmountComponent,
  BalanceDetails,
  Direction,
  InstrumentObservation,
  MerchantObservation,
  Observation,
  PaymentRail,
  Probability,
  RawSignal,
  SignalAdapter,
  SourceRef,
  TransactionStatus,
  TransactionType,
  TransferKind,
  TypeHint,
} from "@brake/core";
import {
  contentKey,
  describeMoney,
  isRecord,
  last4Of,
  measuredInstant,
  mccHints,
  normalizeCurrency,
  normalizeMcc,
  parseDecimalAmount,
  parseInstant,
  scrubDescriptor,
  stageWord,
  text,
} from "./ledger-mapping";
import { observationId } from "./shared/text";

/**
 * Apple FinanceKit (iOS 17.4+ US: Apple Card, Apple Cash, Savings; iOS 18.4+
 * UK: open-banking accounts connected in Wallet) -> observations.
 *
 * FinanceKit is a Swift framework; BRAKE's iOS bridge serializes its structs
 * to JSON with Apple's property names (developer.apple.com/documentation/financekit,
 * `Transaction`, `TransactionStatus`, `TransactionType`, `Account`,
 * `AccountBalance`; docs/research/02 §A1, /04 §2, /10 §A10):
 *  - `transactionAmount` is a `CurrencyAmount` whose `Decimal` amount is
 *    bridged as a string and is always positive; `creditDebitIndicator` gives
 *    the direction. On a liability (credit) account a debit is "a decrease in
 *    the available credit" — a purchase — so debit = money spent on both
 *    account kinds; only the instrument differs.
 *  - `status`: authorized | pending | booked | rejected | memo. The `id` is
 *    stable while a transaction moves from authorized to booked (Apple:
 *    "track how a given transaction evolves over time") but device-scoped.
 *  - Change feeds (`transactionHistory(forAccountID:since:isMonitoring:)`)
 *    deliver `inserted`, `updated` and `deleted` (ids only).
 *
 * All of this is read and parsed on the device; nothing requires a server.
 */

/* ------------------------------------------------------------------ */
/* Payload (the Swift bridge's JSON)                                   */
/* ------------------------------------------------------------------ */

export interface FinanceKitCurrencyAmount {
  /** Swift `Decimal` as a string ("12.50"); a JSON number is tolerated. */
  readonly amount: string | number;
  readonly currencyCode: string;
}

export type FinanceKitTransactionStatus = "authorized" | "pending" | "booked" | "rejected" | "memo";

export type FinanceKitTransactionType =
  | "adjustment"
  | "atm"
  | "billPayment"
  | "check"
  | "deposit"
  | "directDebit"
  | "directDeposit"
  | "dividend"
  | "fee"
  | "interest"
  | "loan"
  | "pointOfSale"
  | "refund"
  | "standingOrder"
  | "transfer"
  | "withdrawal"
  | "unknown";

export interface FinanceKitTransaction {
  /** UUID string, unique per device. */
  readonly id: string;
  readonly accountID: string;
  readonly transactionAmount: FinanceKitCurrencyAmount;
  readonly foreignCurrencyAmount?: FinanceKitCurrencyAmount | null;
  readonly foreignCurrencyExchangeRate?: string | number | null;
  readonly creditDebitIndicator: "credit" | "debit";
  /** Display description (cleaned by Wallet). */
  readonly transactionDescription: string;
  /** The institution's raw text. */
  readonly originalTransactionDescription: string;
  /** ISO 18245 (`MerchantCategoryCode.rawValue`). */
  readonly merchantCategoryCode?: number | string | null;
  readonly merchantName?: string | null;
  readonly transactionType: FinanceKitTransactionType | string;
  readonly status: FinanceKitTransactionStatus | string;
  /** ISO 8601. */
  readonly transactionDate: string;
  readonly postedDate?: string | null;
}

export interface FinanceKitAccount {
  readonly id: string;
  /** Swift `Account` is an enum of AssetAccount | LiabilityAccount. */
  readonly kind: "asset" | "liability";
  readonly displayName: string;
  readonly institutionName: string;
  readonly accountDescription?: string | null;
  readonly currencyCode: string;
  /** LiabilityAccount.creditInformation.creditLimit. */
  readonly creditLimit?: FinanceKitCurrencyAmount | null;
}

export interface FinanceKitBalance {
  readonly amount: FinanceKitCurrencyAmount;
  readonly asOfDate?: string | null;
  readonly creditDebitIndicator?: "credit" | "debit";
}

/** `AccountBalance` with its `CurrentBalance` enum flattened (available, booked, or both). */
export interface FinanceKitAccountBalance {
  readonly id?: string;
  readonly accountID: string;
  readonly available?: FinanceKitBalance | null;
  readonly booked?: FinanceKitBalance | null;
}

export interface FinanceKitBatch {
  /** New transactions from a history query (or a plain `transactions(query:)` result). */
  readonly inserted?: readonly FinanceKitTransaction[];
  /** Transactions whose status/amount/description changed since the last history token. */
  readonly updated?: readonly FinanceKitTransaction[];
  /** Ids of transactions removed from the store (dropped authorizations, corrections). */
  readonly deleted?: readonly string[];
  /** Account the history query was scoped to (`transactionHistory(forAccountID:)`). */
  readonly accountID?: string;
  readonly accounts?: readonly FinanceKitAccount[];
  readonly balances?: readonly FinanceKitAccountBalance[];
  /** "picker" when the user handed these over with `TransactionPicker`. */
  readonly via?: "history" | "query" | "picker";
}

/* ------------------------------------------------------------------ */
/* Data pack                                                           */
/* ------------------------------------------------------------------ */

const STATUS: Readonly<Record<string, TransactionStatus | "skip">> = {
  authorized: "pending",
  pending: "pending",
  booked: "posted",
  // A declined attempt: kept as evidence of attempted spend, never counted as spending.
  rejected: "cancelled",
  // An annotation, not a money movement.
  memo: "skip",
};

interface TypeRule {
  readonly debit?: { readonly type: TransactionType; readonly transferKind?: TransferKind; readonly confidence: Probability };
  readonly credit?: { readonly type: TransactionType; readonly transferKind?: TransferKind; readonly confidence: Probability };
  readonly rail?: PaymentRail;
  /** Only on liability (credit-card) accounts. */
  readonly liabilityCredit?: { readonly type: TransactionType; readonly confidence: Probability };
}

/** FinanceKit `TransactionType` -> type hints ("fk_type:<case>") and rails. */
const TRANSACTION_TYPES: Readonly<Record<string, TypeRule>> = {
  atm: { debit: { type: "cash_withdrawal", confidence: 0.9 }, rail: { family: "cash", scheme: "atm" } },
  withdrawal: { debit: { type: "cash_withdrawal", confidence: 0.5 } },
  billPayment: { liabilityCredit: { type: "credit_card_payment", confidence: 0.85 } },
  check: { rail: { family: "cheque" } },
  deposit: { credit: { type: "transfer", transferKind: "unknown", confidence: 0.5 } },
  directDebit: { rail: { family: "direct_debit" } },
  directDeposit: { credit: { type: "income", confidence: 0.8 } },
  dividend: { credit: { type: "income", confidence: 0.85 } },
  fee: { debit: { type: "fee", confidence: 0.9 } },
  interest: { credit: { type: "income", confidence: 0.85 }, debit: { type: "fee", confidence: 0.8 } },
  loan: { debit: { type: "loan_payment", confidence: 0.6 } },
  pointOfSale: { debit: { type: "purchase", confidence: 0.7 }, credit: { type: "refund", confidence: 0.6 }, rail: { family: "card" } },
  refund: { credit: { type: "refund", confidence: 0.9 } },
  standingOrder: { rail: { family: "account_to_account_batch", scheme: "standing_order" } },
  transfer: { debit: { type: "transfer", confidence: 0.8 }, credit: { type: "transfer", confidence: 0.8 } },
};

/** Asset accounts that are stored-value wallets rather than bank accounts. */
const WALLET_ACCOUNT_NAMES: readonly RegExp[] = [/\bapple cash\b/i];

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

const ADAPTER_ID = "financekit";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "os_wallet",
  displayName: "Apple Wallet (FinanceKit)",
  windows: ["pre_spend", "post_spend"],
  platforms: ["ios"],
  requiresCapabilities: ["data:financekit"],
  privacy: {
    sensitivity: "high",
    dataCategories: ["transactions and balances of the Wallet accounts you choose to share"],
    processing: "on_device",
  },
};

export function createFinanceKitAdapter(): SignalAdapter<FinanceKitBatch> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<FinanceKitBatch>, ctx: AdapterContext): AdapterResult {
      const batch = signal.payload as unknown;
      if (!isRecord(batch)) return { status: "rejected", reason: "FinanceKit batch must be an object" };
      const b = batch as unknown as FinanceKitBatch;
      const accounts = new Map<string, FinanceKitAccount>();
      for (const a of b.accounts ?? []) if (isRecord(a) && text(a.id)) accounts.set(a.id, a);

      const observations: Observation[] = [];
      let malformed = 0;
      for (const t of [...(b.inserted ?? []), ...(b.updated ?? [])]) {
        if (!isRecord(t)) {
          malformed += 1;
          continue;
        }
        const result = transactionObservation(t as FinanceKitTransaction, accounts, signal, ctx);
        if (result === "skip") continue;
        if (result) observations.push(result);
        else malformed += 1;
      }
      for (const id of b.deleted ?? []) {
        const tid = text(id);
        if (tid) observations.push(deletedObservation(tid, b.accountID, accounts, signal));
      }
      for (const balance of b.balances ?? []) {
        const o = isRecord(balance) ? balanceObservation(balance as FinanceKitAccountBalance, accounts, signal, ctx) : null;
        if (o) observations.push(o);
      }
      if (observations.length === 0 && malformed > 0) return { status: "rejected", reason: "no well-formed FinanceKit transactions" };
      return { status: "observations", observations };
    },
  };
}

/** Transaction ids are UUIDs unique on this device, so the device's FinanceKit grant scopes them. */
function namespaceFor(signal: RawSignal<FinanceKitBatch>): string {
  return `financekit:${signal.connectionId}`;
}

function transactionObservation(
  t: FinanceKitTransaction,
  accounts: ReadonlyMap<string, FinanceKitAccount>,
  signal: RawSignal<FinanceKitBatch>,
  ctx: AdapterContext,
): Observation | "skip" | null {
  const id = text(t.id);
  const stage = STATUS[String(t.status)];
  if (!id || !stage) return null;
  if (stage === "skip") return "skip";
  const currency = normalizeCurrency(t.transactionAmount?.currencyCode);
  const amount = currency ? parseDecimalAmount(t.transactionAmount.amount, currency) : null;
  const direction: Direction | undefined = t.creditDebitIndicator === "debit" ? "debit" : t.creditDebitIndicator === "credit" ? "credit" : undefined;
  if (!amount || !direction) return null;

  const account = accounts.get(t.accountID);
  const liability = account?.kind === "liability";
  const instrument = instrumentFor(t.accountID, account);
  const typeRule = TRANSACTION_TYPES[String(t.transactionType)];
  const typeHints: TypeHint[] = [];
  const byDirection = typeRule?.[direction];
  if (byDirection) {
    typeHints.push({
      type: byDirection.type,
      ...(byDirection.transferKind ? { transferKind: byDirection.transferKind } : {}),
      confidence: byDirection.confidence,
      reason: `fk_type:${t.transactionType}`,
    });
  }
  if (typeRule?.liabilityCredit && liability && direction === "credit") {
    typeHints.push({ type: typeRule.liabilityCredit.type, confidence: typeRule.liabilityCredit.confidence, reason: `fk_type:${t.transactionType}` });
  }
  const rail: PaymentRail | undefined = typeRule?.rail ?? (instrument.type === "card" ? { family: "card" } : undefined);

  const mcc = normalizeMcc(t.merchantCategoryCode);
  const raw = scrubDescriptor(t.originalTransactionDescription) ?? scrubDescriptor(t.transactionDescription);
  const name = scrubDescriptor(t.merchantName) ?? scrubDescriptor(t.transactionDescription);
  const merchant: MerchantObservation | undefined = raw
    ? { raw, ...(name ? { name } : {}), ...(mcc ? { mcc } : {}), confidence: text(t.merchantName) ? 0.9 : 0.7 }
    : undefined;

  const foreignCurrency = normalizeCurrency(t.foreignCurrencyAmount?.currencyCode);
  const foreign = foreignCurrency && t.foreignCurrencyAmount ? parseDecimalAmount(t.foreignCurrencyAmount.amount, foreignCurrency) : null;
  const breakdown: AmountComponent[] = foreign && foreign.money.currency !== amount.money.currency ? [{ kind: "original_currency", amount: foreign.money }] : [];

  const zone = ctx.timeZone ?? "UTC";
  const when = parseInstant(t.transactionDate, { timeZone: zone, midnightIsDate: true }) ?? parseInstant(t.postedDate, { timeZone: zone, midnightIsDate: true });

  const label = labelFor(account);
  const summary =
    `Apple Wallet shows a ${stageWord(stage)} ${describeMoney(amount.money, ctx.locale)} ${direction}` +
    (name ? ` ${direction === "credit" ? "from" : "at"} ${name}` : "") +
    ` on your ${label}.`;

  return {
    // The id survives authorized -> booked, so the version (status, amount) is part of the key:
    // each lifecycle step is a new observation sharing the provider id.
    id: observationId(ADAPTER_ID, signal.connectionId, `txn:${id}#${contentKey(stage, amount.money.minor, amount.money.currency, direction, t.postedDate)}`),
    source: sourceFor(signal, account, label),
    kind: "money_movement",
    window: "post_spend",
    stage,
    receivedAt: signal.receivedAt,
    ...(when ? { occurredAt: measuredInstant(when, 0.9) } : {}),
    direction,
    amount: { value: amount.money, confidence: stage === "posted" ? 0.99 : 0.95 },
    ...(breakdown.length > 0 ? { amountBreakdown: breakdown } : {}),
    ...(merchant ? { merchant } : {}),
    instrument,
    ...(rail ? { rail } : {}),
    ...(ctx.country ? { country: ctx.country } : {}),
    references: [{ type: "provider_transaction_id", value: id, namespace: namespaceFor(signal) }],
    ...(mcc ? { categoryHints: mccHints(mcc) } : {}),
    ...(typeHints.length > 0 ? { typeHints } : {}),
    confidence: stage === "posted" ? 0.97 : 0.92,
    evidence: { summary },
  };
}

/** A transaction that left the Wallet store: retracts the observations sharing its id. */
function deletedObservation(
  id: string,
  accountID: string | undefined,
  accounts: ReadonlyMap<string, FinanceKitAccount>,
  signal: RawSignal<FinanceKitBatch>,
): Observation {
  const account = accountID ? accounts.get(accountID) : undefined;
  const label = labelFor(account);
  return {
    id: observationId(ADAPTER_ID, signal.connectionId, `deleted:${id}`),
    source: sourceFor(signal, account, label),
    kind: "money_movement",
    window: "post_spend",
    stage: "cancelled",
    receivedAt: signal.receivedAt,
    ...(accountID ? { instrument: instrumentFor(accountID, account) } : {}),
    references: [{ type: "provider_transaction_id", value: id, namespace: namespaceFor(signal) }],
    confidence: 0.85,
    evidence: { summary: `Apple Wallet removed a transaction from your ${label}.` },
  };
}

function balanceObservation(
  b: FinanceKitAccountBalance,
  accounts: ReadonlyMap<string, FinanceKitAccount>,
  signal: RawSignal<FinanceKitBatch>,
  ctx: AdapterContext,
): Observation | null {
  const accountID = text(b.accountID);
  if (!accountID) return null;
  const account = accounts.get(accountID);
  const amountOf = (x: FinanceKitBalance | null | undefined) => {
    const currency = normalizeCurrency(x?.amount?.currencyCode);
    return currency && x ? (parseDecimalAmount(x.amount.amount, currency)?.money ?? undefined) : undefined;
  };
  const available = amountOf(b.available);
  const current = amountOf(b.booked);
  if (!available && !current) return null;
  const limitCurrency = normalizeCurrency(account?.creditLimit?.currencyCode);
  const limit = limitCurrency && account?.creditLimit ? parseDecimalAmount(account.creditLimit.amount, limitCurrency)?.money : undefined;
  const balance: { -readonly [K in keyof BalanceDetails]: BalanceDetails[K] } = {};
  if (available) balance.available = available;
  if (current) balance.current = current;
  if (limit) balance.limit = limit;

  const asOfRaw = b.booked?.asOfDate ?? b.available?.asOfDate;
  const asOf = parseInstant(asOfRaw, { timeZone: ctx.timeZone ?? "UTC" });
  const label = labelFor(account);
  const shown = current ?? available;
  return {
    id: observationId(ADAPTER_ID, signal.connectionId, `balance:${accountID}:${asOfRaw ?? signal.receivedAt}:${contentKey(available?.minor, current?.minor, shown?.currency)}`),
    source: sourceFor(signal, account, label),
    kind: "balance_snapshot",
    window: "pre_spend",
    stage: "unknown",
    receivedAt: signal.receivedAt,
    occurredAt: asOf ? measuredInstant(asOf, 0.95) : { value: signal.receivedAt, confidence: 0.6 },
    instrument: instrumentFor(accountID, account),
    references: [],
    balance,
    confidence: 0.95,
    evidence: {
      summary: `Apple Wallet reported ${account?.kind === "liability" ? "a card balance" : "a balance"} of ${
        shown ? describeMoney(shown, ctx.locale) : "unknown"
      } on your ${label}.`,
    },
  };
}

function instrumentFor(accountID: string, account: FinanceKitAccount | undefined): InstrumentObservation {
  const last4 = last4Of(account?.accountDescription ?? undefined);
  const base = { accountRef: accountID, ...(last4 ? { last4 } : {}), ...(account?.institutionName ? { issuer: account.institutionName } : {}) };
  if (account?.kind === "liability") return { type: "card", cardKind: "credit", ...base };
  const names = `${account?.displayName ?? ""} ${account?.accountDescription ?? ""}`;
  if (WALLET_ACCOUNT_NAMES.some((re) => re.test(names))) return { type: "wallet", ...base };
  return { type: account ? "bank_account" : "other", ...base };
}

function labelFor(account: FinanceKitAccount | undefined): string {
  const name = scrubDescriptor(account?.displayName);
  return name ? `${name} in Apple Wallet` : "Apple Wallet account";
}

function sourceFor(signal: RawSignal<FinanceKitBatch>, account: FinanceKitAccount | undefined, label: string): SourceRef {
  const provider = text(account?.institutionName);
  return { adapterId: ADAPTER_ID, kind: "os_wallet", connectionId: signal.connectionId, label, ...(provider ? { provider } : {}) };
}
