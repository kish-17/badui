import type { Money } from "./money";
import type { CountryCode, EpochMillis, Measured, ObservationId, Probability } from "./primitives";
import type { SourceRef, SpendWindow } from "./source";

/**
 * Lifecycle of a (candidate) transaction.
 *  intent    — a purchase is being considered; no money has moved
 *  pending   — authorized/held, not settled
 *  confirmed — the payer/merchant confirmed it happened (debit alert, order confirmation)
 *  posted    — settled on the account ledger
 *  refunded  — reversed fully by a refund
 *  cancelled — voided/reversed before settlement, or an intent that was abandoned
 */
export type TransactionStatus = "intent" | "pending" | "confirmed" | "posted" | "refunded" | "cancelled" | "unknown";

export type Direction = "debit" | "credit";

/**
 * Economic meaning of a money movement — not its mechanism. Rent paid by bank
 * transfer is a `purchase` (housing); moving money to your own savings account
 * is a `transfer`. Only some types count as spending (see intelligence/spending).
 */
export type TransactionType =
  | "purchase"
  | "transfer"
  | "refund"
  | "subscription"
  | "cash_withdrawal"
  | "income"
  | "loan_payment"
  | "credit_card_payment"
  | "investment"
  | "reimbursement"
  | "shared_expense"
  | "business_expense"
  | "fee"
  | "tax"
  | "unknown";

/** Finer meaning of a `transfer`, which decides how budgets treat it. */
export type TransferKind = "own_account" | "wallet_load" | "family" | "p2p_other" | "unknown";

/**
 * Generic rail families. Product logic reasons about the family; the concrete
 * scheme (upi, pix, fednow, swish, sepa_inst, faster_payments, ach, …) is kept
 * as an open string so new rails need no code change.
 */
export type RailFamily =
  | "card"
  | "account_to_account_instant"
  | "account_to_account_batch"
  | "direct_debit"
  | "wallet"
  | "mobile_money"
  | "bnpl"
  | "cash"
  | "cheque"
  | "crypto"
  | "other"
  | "unknown";

export interface PaymentRail {
  readonly family: RailFamily;
  /** Lower-case scheme id, e.g. "upi", "pix", "visa", "rupay", "ach", "sepa_inst", "mpesa". */
  readonly scheme?: string;
}

/**
 * Everything one source claimed about (possibly) one financial event, at one
 * moment. Observations are immutable facts-with-uncertainty; the fusion layer
 * decides which ones describe the same event.
 */
export type ObservationKind =
  | "purchase_intent" // considering a purchase: share/QR/"should I buy this?"/cart
  | "checkout" // payment flow observed: UPI intent launched, checkout page, payment redirect
  | "money_movement" // a debit/credit/charge/authorization/ledger entry
  | "order" // merchant order confirmation or update
  | "receipt"
  | "invoice"
  | "delivery"
  | "subscription_event"
  | "refund_notice" // merchant-side refund/return message (the credit itself is a money_movement)
  | "booking" // travel or restaurant reservation
  | "mandate" // recurring authorization set up/changed (UPI AutoPay, direct debit, standing order)
  | "balance_snapshot"
  | "app_context"; // shopping-app launched or shielded — context only, never a transaction

export type ReferenceType =
  | "rail_reference" // UPI RRN/UTR, Pix EndToEndId, ACH trace, card network transaction id
  | "provider_transaction_id" // aggregator/bank ledger id (Plaid transaction_id, AA txnId)
  | "provider_pending_id" // id of the pending record a posted record supersedes (Plaid pending_transaction_id)
  | "merchant_reference" // merchant-side transaction reference (UPI `tr`, PSP order id)
  | "order_id"
  | "invoice_id"
  | "receipt_id"
  | "auth_code"
  | "mandate_id"
  | "subscription_id"
  | "booking_ref";

/**
 * An identifier the event carries. Two references are comparable only when
 * `type` and `namespace` are equal: Amazon order 123 and Flipkart order 123 are
 * unrelated. `namespace` is typically the issuing institution or merchant key.
 */
export interface Reference {
  readonly type: ReferenceType;
  readonly value: string;
  readonly namespace?: string;
}

export type MerchantChannel = "online" | "in_store" | "unknown";

export interface MerchantObservation {
  /** The merchant string exactly as the source presented it ("AMZN Mktp US*2K4L"). */
  readonly raw: string;
  /** A human-friendly name if the source provides one ("Amazon"). */
  readonly name?: string;
  /** Lower-case canonical key if the source can already resolve one ("amazon"). */
  readonly key?: string;
  /** ISO 18245 merchant category code when available (card, EMV QR, UPI). */
  readonly mcc?: string;
  /** Payment handle of the merchant (UPI VPA, Pix key) — never a personal account number. */
  readonly handle?: string;
  readonly website?: string;
  readonly channel?: MerchantChannel;
  readonly confidence: Probability;
}

/** The other party of a transfer-like movement. */
export interface CounterpartyObservation {
  readonly name?: string;
  /** Masked or public handle (UPI VPA, masked IBAN, phone hash). */
  readonly handle?: string;
  /** Probability the counterparty is the user themself (own account / own wallet). */
  readonly isSelf?: Probability;
  /** Probability the counterparty is a business rather than a person. */
  readonly isMerchant?: Probability;
}

export type InstrumentType =
  | "card"
  | "bank_account"
  | "upi_handle"
  | "wallet"
  | "mobile_money"
  | "bnpl"
  | "cash"
  | "other";

/** The user's payment instrument. Only masked identifiers ever reach BRAKE. */
export interface InstrumentObservation {
  readonly type: InstrumentType;
  readonly issuer?: string;
  readonly network?: string;
  /** Last 4 digits of a card/account. Never more. */
  readonly last4?: string;
  /** Opaque, stable id from the provider (Plaid account_id, AA linkRefNumber). */
  readonly accountRef?: string;
  /** Card instruments only: credit vs debit matters for card-payment reconciliation. */
  readonly cardKind?: "credit" | "debit" | "prepaid";
}

export type AmountComponentKind = "subtotal" | "tax" | "shipping" | "tip" | "discount" | "fee" | "fx_fee" | "original_currency";

export interface AmountComponent {
  readonly kind: AmountComponentKind;
  readonly amount: Money;
}

export interface LineItem {
  readonly description: string;
  readonly quantity?: number;
  readonly unitPrice?: Money;
  readonly total?: Money;
  /** Category hints for the item ("electric toothbrush" -> personal care). */
  readonly categoryHints?: readonly CategoryHint[];
  /** Product identifiers such as GTIN/ASIN/SKU. */
  readonly productId?: string;
}

/**
 * A category signal in the vocabulary of whoever produced it. The
 * intelligence layer maps schemes into BRAKE's taxonomy, so adapters never
 * need to know BRAKE categories.
 *   scheme "mcc"        value "5411"
 *   scheme "plaid_pfc"  value "FOOD_AND_DRINK_RESTAURANT"
 *   scheme "keyword"    value "groceries"
 *   scheme "brake"      value "shopping.electronics" (already in BRAKE taxonomy)
 */
export interface CategoryHint {
  readonly scheme: string;
  readonly value: string;
  readonly confidence: Probability;
}

export interface TypeHint {
  readonly type: TransactionType;
  readonly transferKind?: TransferKind;
  readonly confidence: Probability;
  /** Short machine-readable reason, e.g. "sms:autopay-keyword", "plaid_pfc:TRANSFER_OUT". */
  readonly reason: string;
}

export type SubscriptionEventKind = "signup" | "trial_started" | "trial_ending" | "renewal_upcoming" | "charged" | "price_change" | "cancelled" | "payment_failed";

export interface SubscriptionDetails {
  readonly event: SubscriptionEventKind;
  readonly serviceName?: string;
  readonly planName?: string;
  /** ISO 8601 duration ("P1M", "P1Y", "P7D"). */
  readonly period?: string;
  readonly nextChargeAt?: EpochMillis;
  readonly trialEndsAt?: EpochMillis;
  readonly price?: Money;
  readonly previousPrice?: Money;
}

export interface BalanceDetails {
  readonly available?: Money;
  readonly current?: Money;
  /** Credit limit for card/credit accounts. */
  readonly limit?: Money;
}

export interface PurchaseIntentDetails {
  readonly title?: string;
  readonly url?: string;
  readonly productId?: string;
  /** How the intent was expressed: "share", "qr", "price_tag", "should_i_buy", "cart", "voice". */
  readonly via: string;
}

/**
 * Minimised evidence trail. BRAKE persists extracted facts, not raw payloads:
 * `summary` is written by the adapter in plain language; `excerpt` is an
 * optional, redacted snippet that expires.
 */
export interface Evidence {
  /** e.g. "HDFC Bank SMS: ₹1,249.00 debited to AMAZON (UPI)". Must not contain OTPs or full account numbers. */
  readonly summary: string;
  /** Redacted excerpt for "How did BRAKE know this?" Optional; subject to `excerptExpiresAt`. */
  readonly excerpt?: string;
  readonly excerptExpiresAt?: EpochMillis;
}

export interface Observation {
  readonly id: ObservationId;
  readonly source: SourceRef;
  readonly kind: ObservationKind;
  readonly window: SpendWindow;
  /** The lifecycle stage this observation evidences. */
  readonly stage: TransactionStatus;
  /** When BRAKE received the signal. */
  readonly receivedAt: EpochMillis;
  /** Best estimate of when the underlying event happened (bank value dates are often date-only). */
  readonly occurredAt?: Measured<EpochMillis>;
  readonly direction?: Direction;
  readonly amount?: Measured<Money>;
  readonly amountBreakdown?: readonly AmountComponent[];
  readonly merchant?: MerchantObservation;
  readonly counterparty?: CounterpartyObservation;
  readonly instrument?: InstrumentObservation;
  readonly rail?: PaymentRail;
  readonly country?: CountryCode;
  readonly references: readonly Reference[];
  readonly lineItems?: readonly LineItem[];
  readonly categoryHints?: readonly CategoryHint[];
  readonly typeHints?: readonly TypeHint[];
  readonly subscription?: SubscriptionDetails;
  readonly balance?: BalanceDetails;
  readonly intent?: PurchaseIntentDetails;
  /**
   * Probability that this observation is genuine and its core facts (amount,
   * direction, merchant) were extracted correctly. A templated bank SMS from a
   * verified sender is ~0.97; an OCR'd price tag might be ~0.6.
   */
  readonly confidence: Probability;
  readonly evidence: Evidence;
}
