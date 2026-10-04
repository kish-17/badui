import type { ConnectionId } from "./primitives";

/**
 * Where a signal can sit relative to a purchase. A source does not need to
 * serve all three windows to be valuable.
 */
export type SpendWindow = "pre_spend" | "in_spend" | "post_spend";

export const SPEND_WINDOWS: readonly SpendWindow[] = ["pre_spend", "in_spend", "post_spend"];

/**
 * Generic families of signal source. Concrete providers (Plaid, HDFC SMS,
 * Gmail, PhonePe) are *instances* of a family, identified by adapter and
 * connection — never by a hard-coded branch in product logic.
 */
export type SignalSourceKind =
  // Financial data
  | "open_banking" // PSD2/UK OB/CDR/Open Finance style account-information access, incl. aggregators such as Plaid
  | "account_aggregator" // consent-artefact based FI data sharing (e.g. India AA)
  | "card_feed" // card-linked transaction events (card-linked offers/notification programmes)
  | "issuer_webhook" // real-time authorization/settlement events from an issuer/processor (incl. a BRAKE-issued card)
  | "neobank_api" // a bank's own personal API / webhooks
  | "wallet_history" // stored-value wallet or P2P app history
  | "os_wallet" // OS-level wallet data (Apple FinanceKit, Wallet transaction automations)
  // Device / messaging
  | "notification" // OS notifications from bank/payment apps (e.g. Android NotificationListenerService)
  | "sms" // SMS/RCS transactional alerts
  | "messaging" // other transactional messaging channels
  // Communication
  | "email" // Gmail, Outlook, IMAP, forwarding address
  // Payment flow
  | "payment_intent" // payment deep links / intents (e.g. upi://pay) observed before hand-off
  | "qr_scan" // a payment or product QR scanned in BRAKE
  | "checkout" // browser/app checkout pages, payment redirects, confirmation pages
  | "merchant_partner" // merchant integration
  | "payment_partner" // payment-provider partnership
  // User-initiated
  | "manual" // typed entry, "Should I buy this?", price-entry widget
  | "receipt" // receipt photo/scan/PDF
  | "share" // share sheet, pasted URL, screenshot shared to BRAKE
  | "voice" // Siri/App Intents/assistant
  | "barcode" // product barcode/GTIN scan
  | "browser_extension"
  // Context
  | "app_activity" // shopping-app launch or shield events (Screen Time / usage stats)
  | "user_rule"; // user-defined rules and goals

/** Reference from an observation back to the source that produced it. */
export interface SourceRef {
  /** Adapter implementation id, e.g. "sms", "android-notification", "plaid", "gmail". */
  readonly adapterId: string;
  readonly kind: SignalSourceKind;
  /**
   * The user's connection of this source (one Gmail account, one Plaid item,
   * one notification-listener grant). Disconnecting it purges its observations.
   */
  readonly connectionId: ConnectionId;
  /** Institution/provider behind the signal, for explanations ("HDFC Bank", "Amazon"). */
  readonly provider?: string;
  /**
   * Human-readable noun phrase used in provenance sentences, written so it
   * reads after "your": "HDFC Bank transaction notification", "Gmail inbox".
   */
  readonly label: string;
}

/** Runtime surfaces BRAKE runs on or receives signals from. */
export type Platform = "android" | "ios" | "web" | "desktop" | "server";
