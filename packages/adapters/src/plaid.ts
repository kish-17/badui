import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  BalanceDetails,
  CategoryHint,
  CounterpartyObservation,
  Direction,
  InstrumentObservation,
  MerchantChannel,
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
import { currencyExponent } from "@brake/core";
import type { SignedAmount } from "./ledger-mapping";
import {
  arrayOf,
  contentKey,
  describeMoney,
  isRecord,
  lookupOwn,
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
 * Plaid Transactions (`/transactions/sync`) -> observations.
 *
 * Field names and semantics follow Plaid's OpenAPI `2020-09-14_1.762.0`
 * (github.com/plaid/plaid-openapi, Sept 2026; docs/research/01 §1 and
 * docs/research/10 §A1):
 *  - `amount` is positive when money moves OUT of the account and negative
 *    when it moves in — on credit-card accounts too (a purchase is positive, a
 *    payment negative). BRAKE carries a positive amount plus a direction.
 *  - When a pending item posts, Plaid returns a *new* posted record whose
 *    `pending_transaction_id` names the pending one, and the pending id moves
 *    to `removed`. Authorization holds (fuel, hotels) may simply vanish into
 *    `removed` without a successor.
 *  - `removed[]` entries carry only `{transaction_id, account_id}`.
 *  - `datetime` "may contain default time values (such as 00:00:00)".
 *  - `personal_finance_category` (PFC) is Plaid's own vocabulary (v1, and v2
 *    for customers enabled after 2025-12-03). It is translated here into
 *    BRAKE category ids and transaction-type hints; nothing downstream sees PFC.
 */

/* ------------------------------------------------------------------ */
/* Payload (mirrors Plaid's JSON, snake_case)                          */
/* ------------------------------------------------------------------ */

export type PlaidConfidenceLevel = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface PlaidPersonalFinanceCategory {
  readonly primary: string;
  readonly detailed: string;
  readonly confidence_level?: PlaidConfidenceLevel | string | null;
  readonly version?: "v1" | "v2" | string | null;
}

export interface PlaidCounterparty {
  readonly name: string;
  readonly entity_id?: string | null;
  /** merchant | financial_institution | payment_app | marketplace | payment_terminal | income_source */
  readonly type: string;
  readonly website?: string | null;
  readonly logo_url?: string | null;
  readonly confidence_level?: PlaidConfidenceLevel | string | null;
  readonly phone_number?: string | null;
}

export interface PlaidLocation {
  readonly address?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postal_code?: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country?: string | null;
  readonly lat?: number | null;
  readonly lon?: number | null;
  readonly store_number?: string | null;
}

export interface PlaidPaymentMeta {
  readonly reference_number?: string | null;
  readonly ppd_id?: string | null;
  readonly payee?: string | null;
  readonly payer?: string | null;
  readonly by_order_of?: string | null;
  readonly payment_method?: string | null;
  readonly payment_processor?: string | null;
  readonly reason?: string | null;
}

export interface PlaidTransaction {
  readonly transaction_id: string;
  readonly account_id: string;
  readonly pending: boolean;
  readonly pending_transaction_id?: string | null;
  /** Positive = money out of the account, negative = money in. */
  readonly amount: number;
  readonly iso_currency_code?: string | null;
  readonly unofficial_currency_code?: string | null;
  /** Pending: date the transaction occurred. Posted: date it posted. */
  readonly date: string;
  readonly authorized_date?: string | null;
  readonly datetime?: string | null;
  readonly authorized_datetime?: string | null;
  /** Legacy descriptor; still the closest thing to the raw statement text. */
  readonly name?: string | null;
  readonly merchant_name?: string | null;
  readonly merchant_entity_id?: string | null;
  /** Only with `options.include_original_description=true`. */
  readonly original_description?: string | null;
  readonly logo_url?: string | null;
  readonly website?: string | null;
  readonly payment_channel?: "online" | "in store" | "other" | string;
  readonly personal_finance_category?: PlaidPersonalFinanceCategory | null;
  readonly counterparties?: readonly PlaidCounterparty[];
  readonly location?: PlaidLocation | null;
  readonly payment_meta?: PlaidPaymentMeta | null;
  /** European and some US institutions: adjustment, atm, bank charge, bill payment, cash, … */
  readonly transaction_code?: string | null;
  /** Beta, mostly card transactions. */
  readonly merchant_category_code?: string | null;
  readonly check_number?: string | null;
  readonly account_owner?: string | null;
}

export interface PlaidRemovedTransaction {
  readonly transaction_id: string;
  readonly account_id?: string;
}

export interface PlaidAccountBalances {
  readonly available?: number | null;
  readonly current?: number | null;
  readonly limit?: number | null;
  readonly iso_currency_code?: string | null;
  readonly unofficial_currency_code?: string | null;
  readonly last_updated_datetime?: string | null;
}

export interface PlaidAccount {
  readonly account_id: string;
  readonly balances: PlaidAccountBalances;
  /** Last 2–4 alphanumeric characters of the account number. */
  readonly mask?: string | null;
  readonly name?: string | null;
  readonly official_name?: string | null;
  /** depository | credit | loan | investment | other */
  readonly type: string;
  /** checking, savings, credit card, paypal, prepaid, … */
  readonly subtype?: string | null;
  readonly persistent_account_id?: string | null;
}

/** One `/transactions/sync` response page. */
export interface PlaidSyncPage {
  readonly added: readonly PlaidTransaction[];
  readonly modified: readonly PlaidTransaction[];
  readonly removed: readonly PlaidRemovedTransaction[];
  readonly accounts?: readonly PlaidAccount[];
  readonly next_cursor?: string;
  readonly has_more?: boolean;
  readonly transactions_update_status?: string;
  /**
   * Not part of the sync response: the relay may add the institution's display
   * name (from `/item/get` + `/institutions/get_by_id`) so provenance can say
   * "your Chase checking" instead of "your bank account".
   */
  readonly institution_name?: string;
}

/* ------------------------------------------------------------------ */
/* Data pack: Plaid vocabularies -> neutral hints                      */
/* ------------------------------------------------------------------ */

/** PFC `confidence_level` ("VERY_HIGH" >98%, "HIGH" >90%) as a probability (BRAKE design values, docs/research/10 §A1). */
const LEVEL_CONFIDENCE: Readonly<Record<string, Probability>> = {
  VERY_HIGH: 0.95,
  HIGH: 0.85,
  MEDIUM: 0.6,
  LOW: 0.35,
  UNKNOWN: 0.25,
};
const LEVEL_DEFAULT = 0.5;

/** Merchant identity confidence from a counterparty's `confidence_level`. */
const MERCHANT_CONFIDENCE: Readonly<Record<string, Probability>> = {
  VERY_HIGH: 0.97,
  HIGH: 0.9,
  MEDIUM: 0.7,
  LOW: 0.45,
  UNKNOWN: 0.5,
};

interface PfcRule {
  /** BRAKE taxonomy id (copied from intelligence/taxonomy; adapters do not import it). */
  readonly category?: string;
  /** Economic type. Absent for spending categories: debit -> purchase, credit -> refund. */
  readonly type?: TransactionType;
  readonly transferKind?: TransferKind;
  /** How much of the PFC confidence carries over (some detailed codes are themselves ambiguous). */
  readonly weight?: number;
}

/**
 * PFC primary -> rule. Also the fallback for detailed codes this table does
 * not know yet (future taxonomy versions), so a new PFC never breaks parsing.
 */
const PFC_PRIMARY: Readonly<Record<string, PfcRule>> = {
  INCOME: { type: "income" },
  TRANSFER_IN: { type: "transfer", transferKind: "unknown", weight: 0.8 },
  TRANSFER_OUT: { type: "transfer", transferKind: "unknown", weight: 0.8 },
  LOAN_PAYMENTS: { type: "loan_payment" },
  LOAN_DISBURSEMENTS: { type: "transfer", transferKind: "unknown", weight: 0.6 },
  BANK_FEES: { type: "fee", category: "fees" },
  ENTERTAINMENT: { category: "entertainment" },
  FOOD_AND_DRINK: { category: "eating_out", weight: 0.8 },
  GENERAL_MERCHANDISE: { category: "shopping", weight: 0.8 },
  HOME_IMPROVEMENT: { category: "household" },
  MEDICAL: { category: "health" },
  PERSONAL_CARE: { category: "personal_care" },
  GENERAL_SERVICES: { category: "other", weight: 0.4 },
  GOVERNMENT_AND_NON_PROFIT: { category: "fees", weight: 0.4 },
  TRANSPORTATION: { category: "transport" },
  TRAVEL: { category: "travel" },
  RENT_AND_UTILITIES: { category: "bills", weight: 0.8 },
};

/** PFC detailed (v1 and v2, plaid.com/documents/pfc-taxonomy-all.csv) -> rule. */
const PFC_DETAILED: Readonly<Record<string, PfcRule>> = {
  // Transfers: which ones are between the user's own accounts, cash or investment.
  TRANSFER_IN_ACCOUNT_TRANSFER: { type: "transfer", transferKind: "own_account", weight: 0.75 },
  TRANSFER_IN_SAVINGS: { type: "transfer", transferKind: "own_account", weight: 0.85 },
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: { type: "transfer", transferKind: "own_account", weight: 0.8 },
  TRANSFER_OUT_ACCOUNT_TRANSFER: { type: "transfer", transferKind: "own_account", weight: 0.75 },
  TRANSFER_OUT_SAVINGS: { type: "transfer", transferKind: "own_account", weight: 0.85 },
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: { type: "investment" },
  TRANSFER_OUT_WITHDRAWAL: { type: "cash_withdrawal" },
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: { type: "credit_card_payment" },
  LOAN_PAYMENTS_CASH_ADVANCES: { type: "loan_payment", weight: 0.8 },
  BANK_FEES_ATM_FEES: { type: "fee", category: "fees" },
  BANK_FEES_FOREIGN_TRANSACTION_FEES: { type: "fee", category: "fees" },
  BANK_FEES_INTEREST_CHARGE: { type: "fee", category: "fees" },
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: { type: "tax", category: "taxes" },
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: { category: "donations" },
  GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES: { category: "fees", weight: 0.5 },
  // Food and drink
  FOOD_AND_DRINK_GROCERIES: { category: "groceries" },
  FOOD_AND_DRINK_RESTAURANT: { category: "eating_out.restaurant" },
  FOOD_AND_DRINK_FAST_FOOD: { category: "eating_out.restaurant", weight: 0.85 },
  FOOD_AND_DRINK_COFFEE: { category: "eating_out.cafe" },
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: { category: "groceries", weight: 0.5 },
  FOOD_AND_DRINK_VENDING_MACHINES: { category: "eating_out", weight: 0.6 },
  // General merchandise
  GENERAL_MERCHANDISE_ELECTRONICS: { category: "shopping.electronics" },
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: { category: "shopping.clothing" },
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: { category: "shopping.online_marketplace" },
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: { category: "groceries", weight: 0.6 },
  GENERAL_MERCHANDISE_SUPERSTORES: { category: "shopping", weight: 0.6 },
  GENERAL_MERCHANDISE_PET_SUPPLIES: { category: "pets" },
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: { category: "gifts", weight: 0.5 },
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: { category: "shopping", weight: 0.7 },
  // Health, care, education, home
  MEDICAL_VETERINARY_SERVICES: { category: "pets" },
  GENERAL_SERVICES_EDUCATION: { category: "education" },
  GENERAL_SERVICES_INSURANCE: { category: "bills.insurance" },
  GENERAL_SERVICES_AUTOMOTIVE: { category: "transport", weight: 0.8 },
  GENERAL_SERVICES_CHILDCARE: { category: "household", weight: 0.6 },
  // Entertainment
  ENTERTAINMENT_MUSIC_AND_AUDIO: { category: "entertainment.streaming", weight: 0.7 },
  ENTERTAINMENT_TV_AND_MOVIES: { category: "entertainment", weight: 0.9 },
  ENTERTAINMENT_VIDEO_GAMES: { category: "entertainment.gaming" },
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: { category: "entertainment.events" },
  // Transport and travel
  TRANSPORTATION_GAS: { category: "transport.fuel" },
  TRANSPORTATION_PUBLIC_TRANSIT: { category: "transport.public" },
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: { category: "transport.rideshare" },
  TRAVEL_FLIGHTS: { category: "travel.flights" },
  TRAVEL_LODGING: { category: "travel.lodging" },
  // Housing and utilities
  RENT_AND_UTILITIES_RENT: { category: "housing.rent" },
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: { category: "bills.utilities" },
  RENT_AND_UTILITIES_WATER: { category: "bills.utilities" },
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: { category: "bills.utilities" },
  RENT_AND_UTILITIES_OTHER_UTILITIES: { category: "bills.utilities", weight: 0.8 },
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: { category: "bills.phone_internet" },
  RENT_AND_UTILITIES_TELEPHONE: { category: "bills.phone_internet" },
};

/**
 * Card authorizations whose final amount routinely differs from the pending
 * one (tips, fuel pre-auths, hotel and car-rental holds): their pending
 * amount is reported with lower confidence.
 */
const HOLD_PRONE: ReadonlySet<string> = new Set([
  "TRANSPORTATION_GAS",
  "TRAVEL_LODGING",
  "TRAVEL_RENTAL_CARS",
  "FOOD_AND_DRINK_RESTAURANT",
  "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR",
]);

interface CodeRule {
  readonly debit?: { readonly type: TransactionType; readonly transferKind?: TransferKind; readonly confidence: Probability };
  readonly credit?: { readonly type: TransactionType; readonly transferKind?: TransferKind; readonly confidence: Probability };
  readonly rail?: PaymentRail;
}

/** `transaction_code` (European and some US institutions) -> type hints and rails. */
const TRANSACTION_CODES: Readonly<Record<string, CodeRule>> = {
  atm: { debit: { type: "cash_withdrawal", confidence: 0.85 }, rail: { family: "cash", scheme: "atm" } },
  cash: { debit: { type: "cash_withdrawal", confidence: 0.7 }, rail: { family: "cash" } },
  "cash advance": { debit: { type: "cash_withdrawal", confidence: 0.7 }, rail: { family: "cash" } },
  "bank charge": { debit: { type: "fee", confidence: 0.85 } },
  "late fee": { debit: { type: "fee", confidence: 0.85 } },
  "membership fee": { debit: { type: "fee", confidence: 0.8 } },
  "returned item fee": { debit: { type: "fee", confidence: 0.85 } },
  interest: { credit: { type: "income", confidence: 0.8 }, debit: { type: "fee", confidence: 0.75 } },
  refund: { credit: { type: "refund", confidence: 0.85 } },
  transfer: { debit: { type: "transfer", confidence: 0.6 }, credit: { type: "transfer", confidence: 0.6 } },
  purchase: { debit: { type: "purchase", confidence: 0.7 } },
  "direct debit": { rail: { family: "direct_debit" } },
  "standing order": { rail: { family: "account_to_account_batch", scheme: "standing_order" } },
  cheque: { rail: { family: "cheque" } },
};

/** `payment_meta.payment_method` (free text in practice) -> rail, matched case-insensitively. */
const PAYMENT_METHOD_RAILS: Readonly<Record<string, PaymentRail>> = {
  ach: { family: "account_to_account_batch", scheme: "ach" },
  wire: { family: "account_to_account_batch", scheme: "wire" },
  rtp: { family: "account_to_account_instant", scheme: "rtp" },
  fednow: { family: "account_to_account_instant", scheme: "fednow" },
  zelle: { family: "account_to_account_instant", scheme: "zelle" },
  check: { family: "cheque" },
};

const CHANNELS: Readonly<Record<string, MerchantChannel>> = { online: "online", "in store": "in_store", other: "unknown" };

const MERCHANT_COUNTERPARTY_TYPES: ReadonlySet<string> = new Set(["merchant", "marketplace", "payment_terminal"]);

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

const ADAPTER_ID = "plaid";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "open_banking",
  displayName: "Plaid",
  // Ledger entries are post-spend; balances are pre-spend affordability context.
  windows: ["pre_spend", "post_spend"],
  platforms: ["server"],
  requiresCapabilities: ["data:plaid"],
  privacy: {
    sensitivity: "high",
    dataCategories: [
      "bank and card transactions (amount, merchant, date, category)",
      "account balances",
      "account names and the last digits of account numbers",
    ],
    processing: "server",
  },
};

export function createPlaidAdapter(): SignalAdapter<PlaidSyncPage> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<PlaidSyncPage>, ctx: AdapterContext): AdapterResult {
      const page = signal.payload as unknown;
      if (!isRecord(page) || !Array.isArray(page.added) || !Array.isArray(page.modified) || !Array.isArray(page.removed)) {
        return { status: "rejected", reason: "Plaid sync page must have added, modified and removed arrays" };
      }
      const sync = page as unknown as PlaidSyncPage;
      const accounts = new Map<string, PlaidAccount>();
      for (const a of arrayOf(sync.accounts)) {
        const id = isRecord(a) ? text(a.account_id) : undefined;
        if (id) accounts.set(id, a as unknown as PlaidAccount);
      }
      const observations: Observation[] = [];
      let malformed = 0;

      for (const t of [...sync.added, ...sync.modified]) {
        const o = isRecord(t) ? transactionObservation(t as PlaidTransaction, sync, accounts, signal, ctx) : null;
        if (o) observations.push(o);
        else malformed += 1;
      }

      // A pending record removed in the same page as the posted record that names it was
      // superseded, not cancelled: the posted record already carries provider_pending_id.
      const superseded = new Set<string>();
      for (const t of [...sync.added, ...sync.modified]) {
        const pendingId = isRecord(t) ? text(t.pending_transaction_id) : undefined;
        if (pendingId) superseded.add(pendingId);
      }
      for (const r of sync.removed) {
        const id = isRecord(r) ? text(r.transaction_id) : undefined;
        if (!id) {
          malformed += 1;
          continue;
        }
        if (!superseded.has(id)) observations.push(removedObservation(r, sync, accounts, signal));
      }

      for (const account of accounts.values()) {
        const o = balanceObservation(account, sync, signal, ctx);
        if (o) observations.push(o);
      }

      if (observations.length === 0 && malformed > 0) return { status: "rejected", reason: "no well-formed Plaid transactions in page" };
      return { status: "observations", observations };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

function transactionObservation(
  t: PlaidTransaction,
  page: PlaidSyncPage,
  accounts: ReadonlyMap<string, PlaidAccount>,
  signal: RawSignal<PlaidSyncPage>,
  ctx: AdapterContext,
): Observation | null {
  const transactionId = text(t.transaction_id);
  const accountId = text(t.account_id);
  if (!transactionId || !accountId || typeof t.amount !== "number" || !Number.isFinite(t.amount)) return null;

  const account = accounts.get(accountId);
  const stage = t.pending ? "pending" : "posted";
  const { currency, parsed } = plaidAmount(t.amount, t.iso_currency_code, t.unofficial_currency_code, ctx);
  // Plaid: positive = outflow. Zero (card verification) has no direction. The sign is read from
  // Plaid's number itself, so a crypto amount too small for minor units still has a direction.
  const direction: Direction | undefined = t.amount > 0 ? "debit" : t.amount < 0 ? "credit" : undefined;

  const pfc = isRecord(t.personal_finance_category) ? (t.personal_finance_category as PlaidPersonalFinanceCategory) : undefined;
  const pfcConfidence = pfc ? (lookupOwn(LEVEL_CONFIDENCE, pfc.confidence_level) ?? LEVEL_DEFAULT) : 0;
  const detailed = pfc ? String(pfc.detailed ?? "").toUpperCase() : "";
  const amountConfidence = stage === "posted" ? 0.99 : HOLD_PRONE.has(detailed) ? 0.75 : 0.9;

  const instrument = instrumentFor(accountId, account);
  const merchant = merchantFor(t);
  const counterparty = counterpartyFor(t, pfc);
  const rail = railFor(t, instrument);
  const occurredAt = occurredAtFor(t, ctx);
  const { categoryHints, typeHints } = hintsFor(t, pfc, pfcConfidence, direction);

  const namespace = `plaid:${accountId}`;
  const references: Reference[] = [{ type: "provider_transaction_id", value: transactionId, namespace }];
  const pendingId = text(t.pending_transaction_id);
  if (pendingId) references.push({ type: "provider_pending_id", value: pendingId, namespace });

  const country = text(t.location?.country);
  // Modified records are new facts about the same transaction: the id is stable across
  // re-delivery of identical content, and changes when Plaid changes what it reports.
  const version = contentKey(stage, t.amount, currency, t.date, t.authorized_date, t.name, t.merchant_name, pfc?.detailed, pendingId);

  const label = sourceLabel(account, page);
  const counterpartyName = merchant?.name ?? merchant?.raw;
  const summary =
    `Plaid reported a ${stageWord(stage)} ` +
    (parsed ? `${describeMoney(parsed.money, ctx.locale)} ` : "") +
    `${direction === "credit" ? "credit" : direction === "debit" ? "debit" : "transaction"}` +
    (counterpartyName ? ` ${direction === "credit" ? "from" : "at"} ${counterpartyName}` : "") +
    ` on your ${label}.`;

  return {
    id: observationId(ADAPTER_ID, signal.connectionId, `txn:${transactionId}#${version}`),
    source: source(signal, label, page),
    kind: "money_movement",
    window: "post_spend",
    stage,
    receivedAt: signal.receivedAt,
    ...(occurredAt ? { occurredAt } : {}),
    ...(direction ? { direction } : {}),
    ...(parsed ? { amount: { value: parsed.money, confidence: amountConfidence } } : {}),
    ...(merchant ? { merchant } : {}),
    ...(counterparty ? { counterparty } : {}),
    instrument,
    ...(rail ? { rail } : {}),
    ...(country && /^[A-Za-z]{2}$/.test(country) ? { country: country.toUpperCase() } : ctx.country ? { country: ctx.country } : {}),
    references,
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    ...(typeHints.length > 0 ? { typeHints } : {}),
    // Pending details "may change before they are settled".
    confidence: parsed ? (stage === "posted" ? 0.97 : 0.85) : 0.6,
    evidence: { summary },
  };
}

/**
 * A removed record: an authorization that dropped, or a record the bank
 * withdrew. It carries the same provider id as the record it retracts so
 * fusion can cancel that record's candidate; it has no amount or direction.
 */
function removedObservation(
  r: PlaidRemovedTransaction,
  page: PlaidSyncPage,
  accounts: ReadonlyMap<string, PlaidAccount>,
  signal: RawSignal<PlaidSyncPage>,
): Observation {
  const transactionId = text(r.transaction_id) ?? "";
  const accountId = text(r.account_id);
  const account = accountId ? accounts.get(accountId) : undefined;
  const label = sourceLabel(account, page);
  return {
    id: observationId(ADAPTER_ID, signal.connectionId, `removed:${transactionId}`),
    source: source(signal, label, page),
    kind: "money_movement",
    window: "post_spend",
    stage: "cancelled",
    receivedAt: signal.receivedAt,
    ...(accountId ? { instrument: instrumentFor(accountId, account) } : {}),
    references: [
      // Without account_id (older API versions) the namespace cannot match; fusion then
      // falls back to treating this as an unmatched cancellation.
      { type: "provider_transaction_id", value: transactionId, namespace: accountId ? `plaid:${accountId}` : "plaid" },
    ],
    confidence: accountId ? 0.9 : 0.6,
    evidence: { summary: `Plaid removed a transaction from your ${label}: an authorization that dropped or was reversed.` },
  };
}

function occurredAtFor(t: PlaidTransaction, ctx: AdapterContext): Observation["occurredAt"] {
  const zone = ctx.timeZone ?? "UTC";
  // Authorization time is when the purchase happened; `date` on a posted record is the posting date.
  for (const value of [t.authorized_datetime, t.datetime]) {
    const p = parseInstant(value, { timeZone: zone, midnightIsDate: true });
    if (p?.precision === "datetime") return measuredInstant(p, 0.95);
  }
  for (const value of [t.authorized_date, t.date]) {
    const p = parseInstant(value, { timeZone: zone });
    if (p) return measuredInstant(p);
  }
  return undefined;
}

/**
 * Amount and currency. `unofficial_currency_code` (crypto, some local
 * currencies) is used only when the value fits BRAKE's minor units exactly:
 * 0.0015 BTC must not become "BTC 0.00". The user's default currency is a
 * fallback only when Plaid names no currency at all — never a stand-in for
 * an unofficial code BRAKE cannot read ("DOGE" is not dollars).
 */
function plaidAmount(
  amount: number,
  iso: unknown,
  unofficial: unknown,
  ctx: AdapterContext,
): { currency: string | undefined; parsed: SignedAmount | null } {
  const official = normalizeCurrency(iso);
  if (official) return { currency: official, parsed: parseDecimalAmount(amount, official) };
  if (text(unofficial) !== undefined) {
    const code = normalizeCurrency(unofficial);
    const parsed = code ? parseDecimalAmount(amount, code) : null;
    const exact = parsed !== null && parsed.money.minor / 10 ** currencyExponent(parsed.money.currency) === Math.abs(amount);
    return { currency: code, parsed: exact ? parsed : null };
  }
  const fallback = normalizeCurrency(ctx.defaultCurrency);
  return { currency: fallback, parsed: fallback ? parseDecimalAmount(amount, fallback) : null };
}

function counterpartiesOf(t: PlaidTransaction): PlaidCounterparty[] {
  return arrayOf(t.counterparties).filter((c): c is PlaidCounterparty => isRecord(c));
}

function merchantFor(t: PlaidTransaction): MerchantObservation | undefined {
  const merchantParty = counterpartiesOf(t).find((c) => MERCHANT_COUNTERPARTY_TYPES.has(String(c.type)));
  const raw = scrubDescriptor(t.name) ?? scrubDescriptor(t.original_description) ?? scrubDescriptor(t.merchant_name);
  if (!raw) return undefined;
  const name = scrubDescriptor(t.merchant_name) ?? scrubDescriptor(merchantParty?.name);
  const mcc = normalizeMcc(t.merchant_category_code);
  const website = text(t.website) ?? text(merchantParty?.website);
  const channel = lookupOwn(CHANNELS, t.payment_channel);
  const confidence = merchantParty
    ? (lookupOwn(MERCHANT_CONFIDENCE, merchantParty.confidence_level) ?? 0.8)
    : name
      ? 0.85
      : 0.6;
  return {
    raw,
    ...(name ? { name } : {}),
    ...(mcc ? { mcc } : {}),
    ...(website ? { website } : {}),
    ...(channel ? { channel } : {}),
    confidence,
  };
}

/**
 * The other party of a transfer-like movement. Plaid's counterparty `type`
 * says whether it is a business, a bank (often the user's own account or
 * lender), a P2P app (the app, not the final payee) or an income source.
 */
function counterpartyFor(t: PlaidTransaction, pfc: PlaidPersonalFinanceCategory | undefined): CounterpartyObservation | undefined {
  const primary = String(pfc?.primary ?? "").toUpperCase();
  const transferLike = /^(TRANSFER_IN|TRANSFER_OUT|INCOME|LOAN_PAYMENTS|LOAN_DISBURSEMENTS)$/.test(primary);
  const party = counterpartiesOf(t).find((c) => !MERCHANT_COUNTERPARTY_TYPES.has(String(c.type)));
  if (!transferLike && !party) return undefined;
  const meta = isRecord(t.payment_meta) ? (t.payment_meta as PlaidPaymentMeta) : undefined;
  const name = scrubDescriptor(party?.name) ?? scrubDescriptor(meta?.payee) ?? scrubDescriptor(meta?.payer);
  if (!name) return undefined;
  const type = String(party?.type ?? "");
  const isMerchant = type === "income_source" ? 0.8 : type === "financial_institution" ? 0.6 : type === "payment_app" ? 0.2 : undefined;
  return { name, ...(isMerchant !== undefined ? { isMerchant } : {}) };
}

/**
 * The account as an instrument. Plaid's `mask` is the last 2–4 characters;
 * only a 4-digit mask is a `last4` (fusion compares last4 exactly).
 */
function instrumentFor(accountId: string, account: PlaidAccount | undefined): InstrumentObservation {
  const mask = maskOf(account);
  const last4 = mask && /^\d{4}$/.test(mask) ? mask : undefined;
  const type = String(account?.type ?? "").toLowerCase();
  const subtype = String(account?.subtype ?? "").toLowerCase();
  const base = { accountRef: accountId, ...(last4 ? { last4 } : {}) };
  if (subtype === "paypal") return { type: "wallet", ...base };
  if (type === "credit") return { type: "card", cardKind: "credit", ...base };
  if (subtype === "prepaid") return { type: "card", cardKind: "prepaid", ...base };
  if (type === "depository") return { type: "bank_account", ...base };
  return { type: "other", ...base };
}

function railFor(t: PlaidTransaction, instrument: InstrumentObservation): PaymentRail | undefined {
  const code = lookupOwn(TRANSACTION_CODES, String(t.transaction_code ?? "").toLowerCase());
  if (code?.rail) return code.rail;
  const meta = isRecord(t.payment_meta) ? (t.payment_meta as PlaidPaymentMeta) : undefined;
  const method = lookupOwn(PAYMENT_METHOD_RAILS, String(meta?.payment_method ?? "").toLowerCase());
  if (method) return method;
  if (instrument.type === "card") return { family: "card" };
  return undefined;
}

/** Types that only describe money out (fee, tax…) or money in (income). */
const DEBIT_ONLY_TYPES: ReadonlySet<TransactionType> = new Set(["fee", "tax", "loan_payment", "investment", "cash_withdrawal", "purchase", "subscription"]);
const CREDIT_ONLY_TYPES: ReadonlySet<TransactionType> = new Set(["income", "refund", "reimbursement"]);

function contradicts(type: TransactionType, direction: Direction | undefined): boolean {
  return (direction === "credit" && DEBIT_ONLY_TYPES.has(type)) || (direction === "debit" && CREDIT_ONLY_TYPES.has(type));
}

function hintsFor(
  t: PlaidTransaction,
  pfc: PlaidPersonalFinanceCategory | undefined,
  pfcConfidence: Probability,
  direction: Direction | undefined,
): { categoryHints: CategoryHint[]; typeHints: TypeHint[] } {
  const categoryHints: CategoryHint[] = [...mccHints(normalizeMcc(t.merchant_category_code), 0.8)];
  const typeHints: TypeHint[] = [];

  if (pfc) {
    const detailed = String(pfc.detailed ?? "").toUpperCase();
    const primary = String(pfc.primary ?? "").toUpperCase();
    const rule = lookupOwn(PFC_DETAILED, detailed) ?? lookupOwn(PFC_PRIMARY, primary);
    const reason = `plaid_pfc:${detailed || primary}`;
    if (rule) {
      const confidence = round2(pfcConfidence * (rule.weight ?? 1));
      if (rule.category) categoryHints.push({ scheme: "brake", value: rule.category, confidence });
      if (rule.type && !contradicts(rule.type, direction)) {
        typeHints.push({ type: rule.type, ...(rule.transferKind ? { transferKind: rule.transferKind } : {}), confidence, reason });
      } else if (rule.type) {
        // Money coming back under a money-out category (a reversed overdraft fee, a tax payment
        // returned) is a refund of it, not another fee; income on money out says nothing.
        if (direction === "credit") typeHints.push({ type: "refund", confidence: round2(confidence * 0.6), reason });
      } else if (direction === "debit") {
        // A merchant category on money out is a purchase; on money in it is most likely a refund.
        typeHints.push({ type: "purchase", confidence: round2(confidence * 0.85), reason });
      } else if (direction === "credit") {
        typeHints.push({ type: "refund", confidence: round2(confidence * 0.6), reason });
      }
    }
  }

  const code = lookupOwn(TRANSACTION_CODES, String(t.transaction_code ?? "").toLowerCase());
  const byDirection = direction ? code?.[direction] : undefined;
  if (byDirection) {
    typeHints.push({
      type: byDirection.type,
      ...(byDirection.transferKind ? { transferKind: byDirection.transferKind } : {}),
      confidence: byDirection.confidence,
      reason: `plaid_code:${String(t.transaction_code).toLowerCase()}`,
    });
  }

  // A P2P app (Zelle, Venmo) as counterparty: the bank sees the app, not the person paid.
  if (counterpartiesOf(t).some((c) => c.type === "payment_app")) {
    typeHints.push({ type: "transfer", transferKind: "p2p_other", confidence: 0.45, reason: "plaid_counterparty:payment_app" });
  }
  return { categoryHints, typeHints };
}

/* ------------------------------------------------------------------ */
/* Balances                                                            */
/* ------------------------------------------------------------------ */

function balanceObservation(
  account: PlaidAccount,
  page: PlaidSyncPage,
  signal: RawSignal<PlaidSyncPage>,
  ctx: AdapterContext,
): Observation | null {
  const accountId = text(account.account_id);
  if (!accountId || !isRecord(account.balances)) return null;
  const b = account.balances as PlaidAccountBalances;
  const amountOf = (v: unknown): Money | undefined =>
    typeof v === "number" && Number.isFinite(v) ? (plaidAmount(v, b.iso_currency_code, b.unofficial_currency_code, ctx).parsed?.money ?? undefined) : undefined;
  const details: { -readonly [K in keyof BalanceDetails]: BalanceDetails[K] } = {};
  const available = amountOf(b.available);
  const current = amountOf(b.current);
  const limit = amountOf(b.limit);
  if (available) details.available = available;
  if (current) details.current = current;
  if (limit) details.limit = limit;
  if (!available && !current) return null;

  const label = sourceLabel(account, page);
  const asOf = parseInstant(b.last_updated_datetime, { timeZone: ctx.timeZone ?? "UTC" });
  // Money is unsigned in BRAKE: a negative balance (an overdrawn depository account, or a card
  // account in credit) would otherwise read as money in the account or owed on the card.
  const negative = (typeof b.current === "number" && b.current < 0) || (typeof b.available === "number" && b.available < 0);
  const overdrawn = negative && account.type !== "credit";
  const inCredit = negative && account.type === "credit";
  const shown = current ?? available;
  const currency = shown?.currency;
  return {
    // Same page re-delivered -> same id; a later sync (new cursor) is a new snapshot.
    id: observationId(
      ADAPTER_ID,
      signal.connectionId,
      `balance:${accountId}:${text(page.next_cursor) ?? signal.receivedAt}:${contentKey(b.available, b.current, b.limit, currency)}`,
    ),
    source: source(signal, label, page),
    kind: "balance_snapshot",
    window: "pre_spend",
    stage: "unknown",
    receivedAt: signal.receivedAt,
    occurredAt: asOf ? measuredInstant(asOf, 0.95) : { value: signal.receivedAt, confidence: 0.6 },
    instrument: instrumentFor(accountId, account),
    references: [],
    balance: details,
    confidence: negative ? 0.5 : 0.95,
    evidence: {
      summary: `Plaid reported a ${account.type === "credit" ? "card balance" : "balance"} of ${
        shown ? describeMoney(shown, ctx.locale) : "unknown"
      }${overdrawn ? " (overdrawn)" : inCredit ? " in your favour (credit balance)" : ""} on your ${label}.`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/** Plaid's `mask` is "the last 2-4 alphanumeric characters" of the account number; anything longer is not shown. */
function maskOf(account: PlaidAccount | undefined): string | undefined {
  const mask = text(account?.mask);
  return mask && /^[A-Za-z0-9]{2,4}$/.test(mask) ? mask : undefined;
}

function sourceLabel(account: PlaidAccount | undefined, page: PlaidSyncPage): string {
  const institution = text(page.institution_name);
  const name = scrubDescriptor(account?.name) ?? scrubDescriptor(account?.official_name);
  const mask = maskOf(account);
  const what = name ? `${institution ? `${institution} ` : ""}${name}${mask ? ` ••${mask}` : ""}` : `${institution ?? "bank"} account`;
  return `${what} (via Plaid)`;
}

function source(signal: RawSignal<PlaidSyncPage>, label: string, page: PlaidSyncPage): SourceRef {
  const institution = text(page.institution_name);
  return {
    adapterId: ADAPTER_ID,
    kind: "open_banking",
    connectionId: signal.connectionId,
    label,
    ...(institution ? { provider: institution } : {}),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
