import type {
  CountryCode,
  CurrencyCode,
  InstrumentObservation,
  InstrumentType,
  PaymentRail,
  ReferenceType,
  TransactionType,
  TransferKind,
} from "@brake/core";

/**
 * Transaction-alert knowledge as data.
 *
 * Everything BRAKE knows about one issuer's, payment app's or mobile-money
 * operator's alerts lives in an `AlertPack`: who may send them (SMS sender ids,
 * messaging display names, Android package names), what text claims to be
 * from them (for spoof detection), defaults (currency, zone, date order,
 * instrument, rail) and optional templates for the highest-volume formats.
 * Language and rail vocabularies shared by every pack live in
 * `ALERT_VOCABULARY`. The engine (`./engine.ts`) has no provider branches: a
 * new bank, app or country is a new entry here.
 *
 * Every pattern is a plain regex *source string* (not a RegExp) so a pack is
 * JSON-serializable and can later ship as a signed, versioned, over-the-air
 * update when a bank changes its wording (research stream 07, Architecture B).
 * Patterns compile case-insensitively unless noted.
 *
 * Sources: formats come from docs/research/07-sms-and-messaging-alerts.md
 * (open-source parser fixtures: PennyWise [22]–[43], transaction-sms-parser
 * [52]) and docs/research/05-payment-rails-and-qr.md; header suffix meanings
 * (-S service, -T transactional/OTP, -P promotional, -G government) follow
 * TRAI's TCCCPR-2018 categories as amended for suffixes from 2025-05-06.
 * Entries whose sender ids could not be verified say so in `notes`.
 */

/** What an alert says happened. */
export type AlertEvent =
  | "debit"
  | "credit"
  | "refund"
  | "reversal"
  | "declined"
  | "cash_withdrawal"
  | "mandate_created"
  | "mandate_revoked"
  | "autopay_upcoming"
  | "balance";

export type DateOrder = "DMY" | "MDY" | "YMD";

/** How sure a template is that the captured party is a business. */
export type PartyRole = "merchant" | "person" | "infer";

/**
 * A known alert format. Named groups the engine understands:
 *   amount   amount with or without currency marker ("Rs.250.00", "Ksh1,200.00", "250.0")
 *   acct     masked account/card token ("XX1234", "*1234", "x1234")
 *   party    merchant or counterparty name
 *   vpa      payment handle (UPI VPA)
 *   ref      event reference (RRN/UTR/provider code)
 *   balance  available balance after the event
 *   fee      fee charged for the event
 *   date, time  when the event happened (parsed with the template's date order)
 */
export interface AlertTemplate {
  readonly id: string;
  readonly pattern: string;
  /** Regex flags; default "i". */
  readonly flags?: string;
  readonly event: AlertEvent;
  readonly party?: PartyRole;
  readonly rail?: PaymentRail;
  readonly instrument?: InstrumentType;
  readonly cardKind?: InstrumentObservation["cardKind"];
  readonly dateOrder?: DateOrder;
  /** What the `ref` group is; default: rail_reference in the rail scheme's namespace. */
  readonly ref?: { readonly type: ReferenceType; readonly namespace: string };
  /** Where the format came from. */
  readonly source: string;
}

export type AlertPackKind = "bank" | "card_issuer" | "payment_app" | "wallet" | "mobile_money" | "neobank" | "generic";

/**
 * An extra reference format specific to one pack, e.g. the M-PESA
 * transaction code. `namespace` "$issuer" means the pack's namespace.
 */
export interface ReferenceRule {
  readonly pattern: string;
  readonly flags?: string;
  readonly type: ReferenceType;
  /**
   * Literal namespace, or a placeholder: "$rail" (the detected account-to-account
   * or mobile-money scheme; the rule is skipped when there is none), "$issuer"
   * (the pack namespace) or "$mandate" (the rail scheme for UPI/NACH mandates,
   * otherwise the pack namespace).
   */
  readonly namespace: string;
}

export interface AlertPack {
  /** Stable id: "<country>.<issuer>" ("in.hdfc"); "generic" for the fallback. */
  readonly id: string;
  readonly version: number;
  /** Institution or app name used in provenance ("HDFC Bank", "PhonePe"). */
  readonly displayName: string;
  readonly kind: AlertPackKind;
  /** Lower-case key for issuer-scoped references (auth codes, mandate ids). */
  readonly namespace: string;
  readonly country?: CountryCode;
  readonly defaultCurrency?: CurrencyCode;
  /** IANA zone the issuer writes alert times in (Indian banks always write IST). */
  readonly timeZone?: string;
  readonly dateOrder?: DateOrder;
  /** SMS sender ids (DLT headers, short codes, alphanumeric ids). */
  readonly senders?: readonly string[];
  /** Names messaging apps display for this issuer (RCS business agents, WhatsApp business names). */
  readonly displayNames?: readonly string[];
  /** Android package names of the issuer's own apps. Notifications from them are verified by construction. */
  readonly packages?: readonly string[];
  /**
   * Text that claims to come from this issuer. Compiled case-SENSITIVELY so
   * brand words do not collide with ordinary words ("Chase" vs "chase").
   */
  readonly claims?: readonly string[];
  /** Default instrument when the text names none (M-PESA wallet, UPI handle). */
  readonly instrument?: InstrumentType;
  /** Card network for single-network issuers (American Express). */
  readonly cardNetwork?: string;
  /** Default rail when the text names none (M-PESA, wallet apps, UPI apps). */
  readonly rail?: PaymentRail;
  readonly references?: readonly ReferenceRule[];
  readonly templates?: readonly AlertTemplate[];
  /**
   * Messages from this issuer that look like money moving but are not events
   * the engine models (an overdraft drawdown notice whose purchase arrives in
   * its own confirmation). Matching messages are ignored as unsupported.
   */
  readonly ignore?: readonly string[];
  readonly notes?: string;
}

/** An app that renders other parties' messages (SMS/RCS/WhatsApp) as notifications. */
export interface MessagingApp {
  readonly packageName: string;
  readonly displayName: string;
  /** Channel noun used in provenance ("SMS alert", "WhatsApp message"). */
  readonly channelNoun: string;
}

/* ------------------------------------------------------------------ */
/* Helpers that build pattern strings (data stays strings)             */
/* ------------------------------------------------------------------ */

/**
 * India DLT header "XX-ENTITY" with optional category suffix ("AX-HDFCBK-S").
 * The two-letter prefix is operator/circle; the suffix is checked separately.
 */
function dlt(entities: string): string {
  return `^[A-Z]{2}-(?:${entities})(?:-[A-Z])?$`;
}

const UPI: PaymentRail = { family: "account_to_account_instant", scheme: "upi" };
const PIX: PaymentRail = { family: "account_to_account_instant", scheme: "pix" };
const CARD: PaymentRail = { family: "card" };
const MPESA_RAIL: PaymentRail = { family: "mobile_money", scheme: "mpesa" };

/** Amount token as written in Indian alerts ("Rs.1,249.00", "INR 250", "₹41.00"). */
const INR_AMOUNT = String.raw`(?:Rs\.?|INR|₹)\s?[\d,]+(?:\.\d{1,2})?`;
const KES_AMOUNT = String.raw`Ksh\s?[\d,]+(?:\.\d{1,2})?`;

const IN_DEFAULTS = {
  country: "IN",
  defaultCurrency: "INR",
  timeZone: "Asia/Kolkata",
  dateOrder: "DMY",
} as const;

/* ------------------------------------------------------------------ */
/* Packs                                                               */
/* ------------------------------------------------------------------ */

export const ALERT_PACKS: readonly AlertPack[] = [
  // ---------------------------------------------------------------- India: banks
  {
    id: "in.hdfc",
    version: 1,
    displayName: "HDFC Bank",
    kind: "bank",
    namespace: "hdfc",
    ...IN_DEFAULTS,
    // PennyWise CompiledPatterns.kt matches ^[A-Z]{2}-HDFCBK.*, ^[A-Z]{2}-HDFC.* [30].
    senders: [dlt("HDFCBK|HDFCBN|HDFCBANK|HDFCCC|HDFC")],
    displayNames: ["^HDFC Bank$"],
    packages: ["com.snapwork.hdfc"],
    // Group affiliates (HDFC Life, HDFC Mutual Fund, …) are other issuers with their own headers.
    claims: [String.raw`\bHDFC\b(?!\s+(?:Life|ERGO|Mutual|MF|AMC|Securities|Sec|Credila|Capital|Sky|Pension))`],
    instrument: "bank_account",
    templates: [
      {
        id: "in.hdfc.upi_sent.v2",
        // Multi-line "Sent Rs.X / From HDFC Bank A/C *1234 / To NAME / On dd/mm/yy / Ref <RRN>" (lines joined by "; ").
        pattern: String.raw`^Sent (?<amount>${INR_AMOUNT});? From HDFC Bank A\/C (?<acct>[*xX]+\d{4});? To (?<party>[^;]+?);? On (?<date>\d{2}\/\d{2}\/\d{2,4});? Ref (?<ref>\d{12})`,
        event: "debit",
        party: "infer",
        rail: UPI,
        instrument: "bank_account",
        source: "HDFC multi-line UPI 'Sent' alert (PennyWise HDFCBankParser 'Sent Rs.X From HDFC Bank' [29])",
      },
      {
        id: "in.hdfc.card_spent.v1",
        pattern: String.raw`^Spent (?<amount>${INR_AMOUNT}) From HDFC Bank (?:Credit |Debit )?Card (?<acct>[xX*]*\d{4}) At (?<party>.+?) On (?<date>\d{4}-\d{2}-\d{2}):(?<time>\d{2}:\d{2}:\d{2})`,
        event: "debit",
        party: "merchant",
        rail: CARD,
        instrument: "card",
        source: "PennyWise HDFCBankParser: 'Spent Rs.xxx From HDFC Bank Card xxxx At [MERCHANT] On xxx' [29]",
      },
    ],
  },
  {
    id: "in.icici",
    version: 1,
    displayName: "ICICI Bank",
    kind: "bank",
    namespace: "icici",
    ...IN_DEFAULTS,
    // ICICIBankParser.kt: ^[A-Z]{2}-ICICIB-S$, ^[A-Z]{2}-ICICI-S$ [24].
    senders: [dlt("ICICIB|ICICIT|ICICI")],
    displayNames: ["^ICICI Bank$"],
    packages: ["com.csam.icici.bank.imobile"],
    claims: [String.raw`\bICICI\b(?!\s+(?:Prudential|Pru|Lombard|Direct|Securities|Sec|Home Finance))`],
    instrument: "bank_account",
    templates: [
      {
        id: "in.icici.upi_debit.v1",
        pattern: String.raw`^ICICI Bank Acc(?:t|ount)? (?<acct>XX\d{3,4}) debited (?:for|with) (?<amount>${INR_AMOUNT}) on (?<date>\d{2}-[A-Za-z]{3}-\d{2,4}); (?<party>[^;]+?) credited\. UPI:(?<ref>\d{12})`,
        event: "debit",
        party: "infer",
        rail: UPI,
        instrument: "bank_account",
        source: "ICICIBankParser '; <name> credited. UPI' pattern [24]",
      },
      {
        id: "in.icici.card_spent.v1",
        pattern: String.raw`^(?<amount>[A-Z]{3}\s?[\d,]*\.?\d+) spent (?:using|on) ICICI Bank (?:Credit )?Card (?<acct>XX\d{4}) on (?<date>\d{2}-[A-Za-z]{3}-\d{2,4}) (?:on|at) (?<party>.+?)\. Avl`,
        event: "debit",
        party: "merchant",
        rail: CARD,
        instrument: "card",
        cardKind: "credit",
        source: "ICICIBankParser 'USD 11.80 spent using ICICI Bank Card … on DD-Mon-YY on MERCHANT' [24]",
      },
    ],
  },
  {
    // SBI Card before SBI so the more specific SBICRD header wins.
    id: "in.sbicard",
    version: 1,
    displayName: "SBI Card",
    kind: "card_issuer",
    namespace: "sbicard",
    ...IN_DEFAULTS,
    senders: [dlt("SBICRD")],
    // SBI Card sends RCS alerts with display name "SBI CARDS" (PennyWise SBIBankParser [25]).
    displayNames: ["^SBI ?CARDS?$"],
    claims: [String.raw`\bSBI Card\b`, String.raw`\bSBI Credit Card\b`],
    instrument: "card",
    templates: [
      {
        id: "in.sbicard.spent.v1",
        pattern: String.raw`^(?<amount>${INR_AMOUNT}) spent on your SBI Credit Card ending (?:with )?(?<acct>\d{4}) at (?<party>.+?) on (?<date>\d{2}\/\d{2}\/\d{2,4})`,
        event: "debit",
        party: "merchant",
        rail: CARD,
        instrument: "card",
        cardKind: "credit",
        source: "SBIBankParser 'Rs.259.00 spent' / 'at MERCHANT on DD/MM/YY' / 'ending with 1234' [25]",
      },
    ],
  },
  {
    id: "in.sbi",
    version: 1,
    displayName: "State Bank of India",
    kind: "bank",
    namespace: "sbi",
    ...IN_DEFAULTS,
    // SBIBankParser.kt: SBIINB, SBIUPI, ATMSBI, ^[A-Z]{2}-SBIBK-S$ [25].
    senders: [dlt("SBIBK|SBIINB|SBIUPI|SBIPSG|ATMSBI|CBSSBI|SBI")],
    displayNames: ["^SBI$", "^State Bank of India$"],
    packages: ["com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus"],
    claims: [String.raw`\bSBI\b(?!\s+(?:Card|Credit Card|CARDS?|Life|General|Mutual|MF|Funds|Securities|Cap))`, String.raw`State Bank of India`],
    instrument: "bank_account",
    templates: [
      {
        id: "in.sbi.upi_debit.v1",
        // "debited by 250.0" carries no currency marker; the pack default (INR) applies.
        pattern: String.raw`A\/C (?<acct>X\d{4}) debited by (?<amount>[\d,]+(?:\.\d{1,2})?) on date (?<date>\d{1,2}[A-Za-z]{3}\d{2}) trf to (?<party>.+?) Ref ?no (?<ref>\d{12})`,
        event: "debit",
        party: "infer",
        rail: UPI,
        instrument: "bank_account",
        source: "SBIBankParser 'A/C debited by 20.0 (UPI format)', 'trf to Merchant' [25]",
      },
    ],
  },
  {
    id: "in.axis",
    version: 1,
    displayName: "Axis Bank",
    kind: "bank",
    namespace: "axis",
    ...IN_DEFAULTS,
    // AxisBankParser.kt: ^[A-Z]{2}-AXISBK-S$, ^[A-Z]{2}-AXISBANK-S$, ^[A-Z]{2}-AXIS-S$.
    senders: [dlt("AXISBK|AXISBANK|AXISMR|AXIS")],
    displayNames: ["^Axis Bank$"],
    packages: ["com.axis.mobile"],
    claims: [String.raw`\bAxis Bank\b`],
    instrument: "bank_account",
    templates: [
      {
        // UPI/P2M = person-to-merchant: the payee is a business.
        id: "in.axis.upi_p2m.v1",
        pattern: String.raw`^(?<amount>${INR_AMOUNT}) debited;? A\/c no\. (?<acct>XX\d{3,6});? (?<date>\d{2}-\d{2}-\d{2,4}),? (?<time>\d{2}:\d{2}:\d{2});? UPI\/P2M\/(?<ref>\d{12})\/(?<party>[^;]+?)(?=\s*;|\s+Not you|\.\s|\.?$)`,
        event: "debit",
        party: "merchant",
        rail: UPI,
        instrument: "bank_account",
        source: "AxisBankParser 'INR x debited', upiMerchantPattern 'UPI/<type>/<ref>/<merchant>'",
      },
      {
        // UPI/P2A = person-to-account: the payee is a person.
        id: "in.axis.upi_p2a.v1",
        pattern: String.raw`^(?<amount>${INR_AMOUNT}) debited;? A\/c no\. (?<acct>XX\d{3,6});? (?<date>\d{2}-\d{2}-\d{2,4}),? (?<time>\d{2}:\d{2}:\d{2});? UPI\/P2A\/(?<ref>\d{12})\/(?<party>[^;]+?)(?=\s*;|\s+Not you|\.\s|\.?$)`,
        event: "debit",
        party: "person",
        rail: UPI,
        instrument: "bank_account",
        source: "AxisBankParser upiPersonPattern 'UPI/P2A/<ref>/<name>'",
      },
      {
        id: "in.axis.card_spent.v1",
        // "Spent\nCard no. XX7441\nINR 562\n01-09-25 12:04:18\nAVENUE SUPE\nAvl Lmt" (AxisBankParser format 2).
        pattern: String.raw`^Spent;? Card no\. (?<acct>XX\d{4});? (?<amount>${INR_AMOUNT});? (?<date>\d{2}-\d{2}-\d{2,4}) (?<time>\d{2}:\d{2}:\d{2});? (?<party>[^;]+?);? Avl L(?:i)?m(?:i)?t`,
        event: "debit",
        party: "merchant",
        rail: CARD,
        instrument: "card",
        cardKind: "credit",
        source: "AxisBankParser credit-card 'Spent' format 2",
      },
    ],
  },
  {
    id: "in.kotak",
    version: 1,
    displayName: "Kotak Mahindra Bank",
    kind: "bank",
    namespace: "kotak",
    ...IN_DEFAULTS,
    // KotakBankParser.kt: ^[A-Z]{2}-KOTAK[A-Z]-[ST]$; live sample from JD-KOTAKD-S [26][27].
    senders: [dlt("KOTAK[A-Z]?")],
    // Kotak moved UPI "Sent" alerts to RCS with display-name senders (2026-05) [28].
    displayNames: ["^Kotak(?: Mahindra)?(?: Bank)?$"],
    packages: ["com.msf.kbank.mobile"],
    claims: [String.raw`\bKotak\b(?!\s+(?:Life|General|Mutual|MF|Securities|Sec|Cherry))`],
    instrument: "bank_account",
    templates: [
      {
        id: "in.kotak.upi_sent.v3",
        pattern: String.raw`^Sent (?<amount>${INR_AMOUNT}) from (?:Kotak Bank AC )?(?<acct>[X*]+\d{3,4}) to (?<party>.+?) on (?<date>\d{2}\/\d{2}\/\d{2,4})\. UPI ref no\. (?<ref>\d{12})`,
        event: "debit",
        party: "infer",
        rail: UPI,
        instrument: "bank_account",
        source: "Kotak sample from JD-KOTAKD-S, PennyWise issue #360 (2026-05) [27]",
      },
    ],
  },
  {
    id: "in.pnb",
    version: 1,
    displayName: "Punjab National Bank",
    kind: "bank",
    namespace: "pnb",
    ...IN_DEFAULTS,
    // PNBBankParser.kt: PNBSMS, PNBBNK, PUNBN; RCS display name "PUNJAB NATIONAL BANK" [31].
    senders: [dlt("PNBSMS|PNBBNK|PUNBN[A-Z]?|PNB")],
    displayNames: ["^PUNJAB NATIONAL BANK$", "^PNB$"],
    packages: ["com.Version1"],
    claims: [String.raw`\bPNB\b`, String.raw`Punjab National Bank`, String.raw`PUNJAB NATIONAL BANK`],
    instrument: "bank_account",
  },
  {
    id: "in.bob",
    version: 1,
    displayName: "Bank of Baroda",
    kind: "bank",
    namespace: "bob",
    ...IN_DEFAULTS,
    // BankOfBarodaParser.kt: ^[A-Z]{2}-BOBSMS-[A-Z]$, -BOBTXN-, -BOBCRD-, -BOB-.
    senders: [dlt("BOBSMS|BOBTXN|BOBCRD|BOB")],
    displayNames: ["^Bank of Baroda$"],
    packages: ["com.bankofbaroda.mconnect"],
    claims: [String.raw`Bank of Baroda`, String.raw`-BOB\b`],
    instrument: "bank_account",
    templates: [
      {
        id: "in.bob.upi_dr.v1",
        pattern: String.raw`^(?<amount>${INR_AMOUNT}) Dr\. from A\/C (?<acct>X+\d{4}) and Cr\. to (?<vpa>[\w.-]+@[a-z][a-z0-9]+)\. Ref:(?<ref>\d{12})\. AvlBal:(?<balance>Rs\.?\s?[\d,]+(?:\.\d{1,2})?)\((?<date>\d{4}:\d{2}:\d{2}) (?<time>\d{2}:\d{2}:\d{2})\)`,
        event: "debit",
        party: "infer",
        rail: UPI,
        instrument: "bank_account",
        dateOrder: "YMD",
        source: "BankOfBarodaParser UPI 'Dr.' / 'Cr. to' format",
      },
    ],
  },
  {
    id: "in.canara",
    version: 1,
    displayName: "Canara Bank",
    kind: "bank",
    namespace: "canara",
    ...IN_DEFAULTS,
    // Senders VK-CANBNK-S, JK-CANBNK-S, VA-CANBNK-S in CanaraBankParserTest.kt [41].
    senders: [dlt("CANBNK|CANARA")],
    displayNames: ["^Canara Bank$"],
    packages: ["com.canarabank.mobility"],
    claims: [String.raw`\bCanara\b`],
    instrument: "bank_account",
    templates: [
      {
        id: "in.canara.upi_dr.v1",
        pattern: String.raw`Acct (?<acct>X+\d{3,4}) Dr\. (?<amount>${INR_AMOUNT}) on (?<date>\d{2}\/\d{2}\/\d{2,4}) to (?<party>[^;,]+?)[;,] UPI: (?<ref>\d{12}); Bal (?<balance>${INR_AMOUNT})`,
        event: "debit",
        party: "infer",
        rail: UPI,
        instrument: "bank_account",
        source: "CanaraBankParserTest 'Compact Dr INR UPI debit' fixtures [41]",
      },
    ],
  },

  // ---------------------------------------------------------------- India: UPI apps and wallets
  {
    id: "in.paytm",
    version: 1,
    displayName: "Paytm",
    kind: "payment_app",
    namespace: "paytm",
    ...IN_DEFAULTS,
    senders: [dlt("PAYTMB|PYTMBK|IPAYTM|PAYTM")],
    packages: ["net.one97.paytm"],
    claims: [String.raw`\bPaytm\b`],
    instrument: "upi_handle",
    rail: UPI,
    notes: "SMS headers unverified; notification wording varies by app version.",
  },
  {
    id: "in.phonepe",
    version: 1,
    displayName: "PhonePe",
    kind: "payment_app",
    namespace: "phonepe",
    ...IN_DEFAULTS,
    senders: [dlt("PHONPE|PHNPE")],
    packages: ["com.phonepe.app"],
    claims: [String.raw`\bPhonePe\b`],
    instrument: "upi_handle",
    rail: UPI,
    notes: "SMS headers unverified. PhonePe and Google Pay carried ~79% of UPI value in May 2026 (stream 05 §10).",
  },
  {
    id: "in.gpay",
    version: 1,
    displayName: "Google Pay",
    kind: "payment_app",
    namespace: "gpay",
    ...IN_DEFAULTS,
    packages: ["com.google.android.apps.nbu.paisa.user"],
    claims: [String.raw`\bGoogle Pay\b`, String.raw`\bGPay\b`],
    instrument: "upi_handle",
    rail: UPI,
  },
  {
    id: "in.bhim",
    version: 1,
    displayName: "BHIM",
    kind: "payment_app",
    namespace: "bhim",
    ...IN_DEFAULTS,
    packages: ["in.org.npci.upiapp"],
    claims: [String.raw`\bBHIM\b`],
    instrument: "upi_handle",
    rail: UPI,
  },

  // ---------------------------------------------------------------- Kenya / East Africa: mobile money
  {
    id: "ke.mpesa",
    version: 1,
    displayName: "M-PESA",
    kind: "mobile_money",
    namespace: "mpesa",
    country: "KE",
    defaultCurrency: "KES",
    timeZone: "Africa/Nairobi",
    dateOrder: "DMY",
    // Same sender name is used in KE/TZ/MZ with different currencies; the currency token decides (stream 07 §1b).
    senders: ["^M-?PESA$"],
    displayNames: ["^M-?PESA$"],
    packages: ["com.safaricom.mpesa.lifestyle", "com.safaricom.mysafaricom"],
    claims: [String.raw`\bM-?PESA\b`, String.raw`\bM-?Pesa\b`],
    instrument: "mobile_money",
    rail: MPESA_RAIL,
    // A Fuliza notice reports the overdraft that topped up a payment, not a second payment:
    // the purchase arrives in its own "paid to" confirmation, so booking the notice double counts.
    ignore: [String.raw`\bFuliza M-?PESA amount is\b`],
    references: [
      // "SJ41AB2CDE Confirmed." (KE) / "Confirmado DF50KDFDHWK." (MZ): the 10-character transaction code.
      { pattern: String.raw`^\s*([A-Z0-9]{10})\s+confirmed\b`, type: "rail_reference", namespace: "mpesa" },
      { pattern: String.raw`\bConfirmado\s+([A-Z0-9]{10,11})\b`, type: "rail_reference", namespace: "mpesa" },
    ],
    templates: [
      {
        id: "ke.mpesa.paybill.v1",
        pattern: String.raw`^(?<ref>[A-Z0-9]{10}) Confirmed\.? (?<amount>${KES_AMOUNT}) sent to (?<party>.+?) for account \S+ on (?<date>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<time>\d{1,2}:\d{2} ?[AP]M)`,
        event: "debit",
        party: "merchant",
        rail: MPESA_RAIL,
        instrument: "mobile_money",
        source: "PennyWise MPESAParser '… sent to <PAYBILL> for account 123123' [35]",
      },
      {
        id: "ke.mpesa.buy_goods.v1",
        pattern: String.raw`^(?<ref>[A-Z0-9]{10}) Confirmed\.? (?<amount>${KES_AMOUNT}) paid to (?<party>.+?)\.? on (?<date>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<time>\d{1,2}:\d{2} ?[AP]M)`,
        event: "debit",
        party: "merchant",
        rail: MPESA_RAIL,
        instrument: "mobile_money",
        source: "PennyWise MPESAParser '<code> Confirmed. Ksh70.00 paid to <NAME> … on 20/10/24' [35]",
      },
      {
        id: "ke.mpesa.send_money.v1",
        pattern: String.raw`^(?<ref>[A-Z0-9]{10}) Confirmed\.? (?<amount>${KES_AMOUNT}) sent to (?<party>.+?) on (?<date>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<time>\d{1,2}:\d{2} ?[AP]M)`,
        event: "debit",
        party: "infer",
        rail: MPESA_RAIL,
        instrument: "mobile_money",
        source: "PennyWise MPESAParser 'Ksh1000.00 sent' [35]",
      },
      {
        id: "ke.mpesa.received.v1",
        pattern: String.raw`^(?<ref>[A-Z0-9]{10}) Confirmed\.? You have received (?<amount>${KES_AMOUNT}) from (?<party>.+?) on (?<date>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<time>\d{1,2}:\d{2} ?[AP]M)`,
        event: "credit",
        party: "infer",
        rail: MPESA_RAIL,
        instrument: "mobile_money",
        source: "PennyWise MPESAParser 'You have received' / 'received Ksh300.00 from' [35]",
      },
      {
        id: "ke.mpesa.airtime.v1",
        pattern: String.raw`^(?<ref>[A-Z0-9]{10}) confirmed\.? ?You bought (?<amount>${KES_AMOUNT}) of airtime(?: for \S+)? on (?<date>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<time>\d{1,2}:\d{2} ?[AP]M)`,
        event: "debit",
        rail: MPESA_RAIL,
        instrument: "mobile_money",
        source: "M-PESA airtime purchase confirmation ('You bought Ksh… of airtime')",
      },
      {
        id: "ke.mpesa.withdraw.v1",
        pattern: String.raw`^(?<ref>[A-Z0-9]{10}) Confirmed\.? ?on (?<date>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<time>\d{1,2}:\d{2} ?[AP]M) Withdraw (?<amount>${KES_AMOUNT}) from`,
        event: "cash_withdrawal",
        rail: MPESA_RAIL,
        instrument: "mobile_money",
        source: "M-PESA agent withdrawal confirmation (stream 07 §1b: agent cash-out is a withdrawal, not spending)",
      },
    ],
  },

  // ---------------------------------------------------------------- Brazil
  {
    id: "br.nubank",
    version: 1,
    displayName: "Nubank",
    kind: "neobank",
    namespace: "nubank",
    country: "BR",
    defaultCurrency: "BRL",
    timeZone: "America/Sao_Paulo",
    dateOrder: "DMY",
    // Nubank sends transaction alerts only as app push, never SMS (blog.nubank.com.br/golpe-nubank):
    // any SMS that claims to be a Nubank purchase alert is a phishing attempt.
    senders: [],
    packages: ["com.nu.production"],
    claims: [String.raw`\bNubank\b`, String.raw`\bNUBANK\b`],
    templates: [
      {
        id: "br.nubank.compra.v1",
        pattern: String.raw`Compra de (?<amount>R\$\s?[\d.]+,\d{2}) APROVADA em (?<party>.+?) para o cart[aã]o com final (?<acct>\d{4})`,
        event: "debit",
        party: "merchant",
        rail: CARD,
        instrument: "card",
        source: "Nubank card purchase push ('Compra … APROVADA em …'); structure illustrative",
      },
    ],
  },
  {
    id: "br.itau",
    version: 1,
    displayName: "Itaú",
    kind: "bank",
    namespace: "itau",
    country: "BR",
    defaultCurrency: "BRL",
    timeZone: "America/Sao_Paulo",
    dateOrder: "DMY",
    packages: ["com.itau"],
    claims: [String.raw`\bIta[uú]\b`, String.raw`\bITA[UÚ]\b`],
    instrument: "bank_account",
    notes: "SMS short codes unverified; notifications only.",
  },

  // ---------------------------------------------------------------- United States
  {
    id: "us.chase",
    version: 1,
    displayName: "Chase",
    kind: "bank",
    namespace: "chase",
    country: "US",
    defaultCurrency: "USD",
    dateOrder: "MDY",
    // Chase short code 24273 (PennyWise ChaseBankParser [40]).
    senders: ["^24273$"],
    packages: ["com.chase.sig.android"],
    claims: [String.raw`\bChase\b`, String.raw`\bCHASE\b`, String.raw`JPMorgan`],
    templates: [
      {
        id: "us.chase.transaction.v1",
        pattern: String.raw`You made an? (?<amount>\$[\d,]+(?:\.\d{2})?) transaction with (?<party>.+?) on (?<date>[A-Za-z]{3,9}\.? \d{1,2}, \d{4}) at (?<time>\d{1,2}:\d{2} ?[AP]M)`,
        event: "debit",
        party: "merchant",
        rail: CARD,
        instrument: "card",
        source: "Chase SMS 'Card Name: You made a $9.17 transaction with TACO BELL on Mar 17, 2026 at 1:56 PM ET.' [40]",
      },
    ],
  },
  {
    id: "us.amex",
    version: 1,
    displayName: "American Express",
    kind: "card_issuer",
    namespace: "amex",
    country: "US",
    defaultCurrency: "USD",
    dateOrder: "MDY",
    packages: ["com.americanexpress.android.acctsvcs.us"],
    claims: [String.raw`\bAmex\b`, String.raw`\bAMEX\b`, String.raw`American Express`],
    instrument: "card",
    cardNetwork: "amex",
    notes: "SMS short codes unverified; Amex shows 5-digit card endings (last 4 kept).",
  },
  {
    id: "us.bofa",
    version: 1,
    displayName: "Bank of America",
    kind: "bank",
    namespace: "bofa",
    country: "US",
    defaultCurrency: "USD",
    dateOrder: "MDY",
    senders: ["^73981$"],
    packages: ["com.infonow.bofa"],
    claims: [String.raw`Bank of America`, String.raw`\bBofA\b`],
    notes: "Short code 73981 unverified.",
  },
  {
    id: "us.capitalone",
    version: 1,
    displayName: "Capital One",
    kind: "card_issuer",
    namespace: "capitalone",
    country: "US",
    defaultCurrency: "USD",
    dateOrder: "MDY",
    senders: ["^227898$"],
    packages: ["com.konylabs.capitalone"],
    claims: [String.raw`Capital One`, String.raw`CAPITAL ONE`],
    instrument: "card",
    notes: "Short code 227898 unverified.",
  },

  // ---------------------------------------------------------------- United Kingdom / Europe
  {
    id: "gb.monzo",
    version: 1,
    displayName: "Monzo",
    kind: "neobank",
    namespace: "monzo",
    country: "GB",
    defaultCurrency: "GBP",
    timeZone: "Europe/London",
    dateOrder: "DMY",
    packages: ["co.uk.getmondo"],
    claims: [String.raw`\bMonzo\b`],
    notes: "Push only; card pushes read '£X at MERCHANT' with a 'You've spent £Y today' running total.",
  },
  {
    id: "gb.revolut",
    version: 1,
    displayName: "Revolut",
    kind: "neobank",
    namespace: "revolut",
    country: "GB",
    timeZone: "Europe/London",
    dateOrder: "DMY",
    packages: ["com.revolut.revolut"],
    claims: [String.raw`\bRevolut\b`],
    notes: "Multi-currency: no default currency; the amount's own marker decides.",
  },

  // ---------------------------------------------------------------- Nigeria
  {
    id: "ng.gtbank",
    version: 1,
    displayName: "GTBank",
    kind: "bank",
    namespace: "gtbank",
    country: "NG",
    defaultCurrency: "NGN",
    timeZone: "Africa/Lagos",
    dateOrder: "DMY",
    senders: ["^GTBank$", "^GTWORLD$", "^GTB$"],
    packages: ["com.gtbank.gtworldv1"],
    claims: [String.raw`\bGTBank\b`, String.raw`\bGTB\b`, String.raw`Guaranty Trust`],
    instrument: "bank_account",
    notes: "Multi-line Acct/Amt/Desc/Bal/Date format (PennyWise GTBankParser [39]).",
  },
  {
    id: "ng.opay",
    version: 1,
    displayName: "OPay",
    kind: "wallet",
    namespace: "opay",
    country: "NG",
    defaultCurrency: "NGN",
    timeZone: "Africa/Lagos",
    dateOrder: "DMY",
    // "Opay" alphanumeric SMS sender as in PennyWise OpayBankParserTest fixtures (canHandle: sender contains "OPAY").
    senders: ["^OPay$"],
    packages: ["team.opay.pay"],
    claims: [String.raw`\bOPay\b`, String.raw`\bOPAY\b`],
    instrument: "wallet",
    rail: { family: "wallet", scheme: "opay" },
  },

  // ---------------------------------------------------------------- Indonesia
  {
    id: "id.bca",
    version: 1,
    displayName: "BCA",
    kind: "bank",
    namespace: "bca",
    country: "ID",
    defaultCurrency: "IDR",
    timeZone: "Asia/Jakarta",
    dateOrder: "DMY",
    packages: ["com.bca"],
    claims: [String.raw`\bBCA\b`],
    instrument: "bank_account",
  },
  {
    id: "id.gopay",
    version: 1,
    displayName: "GoPay",
    kind: "wallet",
    namespace: "gopay",
    country: "ID",
    defaultCurrency: "IDR",
    timeZone: "Asia/Jakarta",
    dateOrder: "DMY",
    packages: ["com.gojek.app", "com.gojek.gopay"],
    claims: [String.raw`\bGoPay\b`],
    instrument: "wallet",
    rail: { family: "wallet", scheme: "gopay" },
  },
  {
    id: "id.dana",
    version: 1,
    displayName: "DANA",
    kind: "wallet",
    namespace: "dana",
    country: "ID",
    defaultCurrency: "IDR",
    timeZone: "Asia/Jakarta",
    dateOrder: "DMY",
    packages: ["id.dana"],
    // "dana" is also the Indonesian word for "funds", so only the brand forms count as a claim.
    claims: [String.raw`DANA Indonesia`, String.raw`\bDANA ID\b`],
    instrument: "wallet",
    rail: { family: "wallet", scheme: "dana" },
  },

  // ---------------------------------------------------------------- Bangladesh
  {
    id: "bd.bkash",
    version: 1,
    displayName: "bKash",
    kind: "mobile_money",
    namespace: "bkash",
    country: "BD",
    defaultCurrency: "BDT",
    timeZone: "Asia/Dhaka",
    dateOrder: "DMY",
    senders: ["^bKash$"],
    packages: ["com.bKash.customerapp"],
    claims: [String.raw`\bbKash\b`],
    instrument: "mobile_money",
    rail: { family: "mobile_money", scheme: "bkash" },
    references: [{ pattern: String.raw`\bTrxID\s*:?\s*([A-Z0-9]{8,12})\b`, type: "rail_reference", namespace: "bkash" }],
  },
];

/**
 * Fallback for senders and apps no pack knows. It has no sender patterns,
 * templates or claims; the engine parses heuristically at reduced confidence.
 */
export const GENERIC_PACK: AlertPack = {
  id: "generic",
  version: 1,
  displayName: "",
  kind: "generic",
  namespace: "generic",
};

/** Messaging apps whose notifications carry other senders' SMS/RCS/WhatsApp messages. */
export const MESSAGING_APPS: readonly MessagingApp[] = [
  { packageName: "com.google.android.apps.messaging", displayName: "Messages", channelNoun: "SMS alert" },
  { packageName: "com.samsung.android.messaging", displayName: "Samsung Messages", channelNoun: "SMS alert" },
  { packageName: "com.android.mms", displayName: "Messages", channelNoun: "SMS alert" },
  { packageName: "com.truecaller", displayName: "Truecaller", channelNoun: "SMS alert" },
  { packageName: "com.whatsapp", displayName: "WhatsApp", channelNoun: "WhatsApp message" },
  { packageName: "com.whatsapp.w4b", displayName: "WhatsApp Business", channelNoun: "WhatsApp message" },
];

/* ------------------------------------------------------------------ */
/* Shared vocabulary (language and rail knowledge, not provider data)  */
/* ------------------------------------------------------------------ */

export interface RailRule {
  readonly pattern: string;
  readonly flags?: string;
  readonly rail: PaymentRail;
}

export interface PartyRule {
  readonly id: string;
  /** Must capture a `name` and/or `vpa` group. */
  readonly pattern: string;
  readonly flags?: string;
  /** Only for these directions (party semantics flip between debits and credits). */
  readonly directions?: readonly ("debit" | "credit")[];
  /** Prior probability that the party is a business. */
  readonly isMerchant?: number;
}

export interface TypeRule {
  readonly pattern: string;
  readonly directions?: readonly ("debit" | "credit")[];
  readonly type: TransactionType;
  readonly transferKind?: TransferKind;
  readonly confidence: number;
  readonly reason: string;
}

export interface CategoryRule {
  readonly pattern: string;
  /** BRAKE taxonomy id (copied from intelligence/taxonomy.ts, which adapters do not import). */
  readonly category: string;
}

/** Ends a UPI payee segment: a separator, sentence end, a following label or end of text. */
const UPI_PAYEE_END = String.raw`(?=\s*[;\/]|\.\s|\.$|\s+(?:on|avl|avbl|bal|balance|ref|not you)\b|\s*$)`;

/** Ends a captured name: a following keyword, separator, sentence end or end of text. */
const STOP = String.raw`(?=\s+(?:on|at|via|using|with|ref|refno|upi|avl|avbl|bal|balance|for|from|by|dated|txn|trxn|was|is|has|will|of (?:max(?:imum)?|up ?to|amount|rs|inr)|para o|para a|no dia|berhasil|sukses|gagal|pakai|dengan|not you|if not|new|info|imps|neft)\b|\s*[;(|]|\.\s|\.$|,\s|$)`;

/**
 * Language, rail and reference vocabulary shared by every pack. It is data
 * too: supporting Swahili or Bahasa alerts means adding phrases here.
 */
export interface AlertVocabulary {
  /**
   * The message *is* a one-time password even though core's detector found no
   * code (masked "5738xx", truncated "…"). A match preceded by "never share" /
   * "do not share" is a disclaimer and does not count.
   */
  readonly otpMessage: readonly string[];
  /** Authentication words. On an India "-T" (OTP-class) header they mark the message as an OTP. */
  readonly otpAdjacent: readonly string[];
  /** Collect and payment requests: money has not moved and may never move. */
  readonly paymentRequest: readonly string[];
  /** Phrases that contain a direction verb but say nothing about direction ("Ignore if already paid"). */
  readonly directionNoise: readonly string[];
  readonly promotionalDecisive: readonly string[];
  readonly promotionalSoft: readonly string[];
  readonly billDue: readonly string[];
  readonly autopayUpcoming: readonly string[];
  readonly mandateRevoked: readonly string[];
  readonly mandateCreated: readonly string[];
  readonly reversal: readonly string[];
  readonly reversalFuture: readonly string[];
  /** A reversal that did not happen: no money came back. */
  readonly reversalFailed: readonly string[];
  /** Money that will arrive later ("will be credited … in 3-5 business days"): a notice, not a movement. */
  readonly futureCredit: readonly string[];
  readonly declined: readonly string[];
  readonly refund: readonly string[];
  readonly pending: readonly string[];
  readonly cashWithdrawal: readonly string[];
  readonly atm: readonly string[];
  readonly debitStrong: readonly string[];
  readonly creditStrong: readonly string[];
  readonly debitWeak: readonly string[];
  readonly creditWeak: readonly string[];
  readonly balanceWords: string;
  readonly balanceBefore: string;
  /** Context right after an amount that makes it a balance ("has a $10.12 bal"). */
  readonly balanceAfter: string;
  readonly limitBefore: string;
  readonly feeBefore: string;
  readonly aggregateBefore: string;
  readonly aggregateAfter: string;
  readonly maskedInstrument: readonly string[];
  readonly counterpartyAccountBefore: string;
  readonly instrumentCard: string;
  readonly instrumentAccount: string;
  readonly instrumentWallet: string;
  readonly cardCredit: string;
  readonly cardDebit: string;
  readonly cardPrepaid: string;
  readonly cardNetworks: readonly { readonly pattern: string; readonly network: string }[];
  readonly parties: readonly PartyRule[];
  readonly partyReject: string;
  /** Explicit statements that the other side is the user's own account (any direction). */
  readonly ownAccount: string;
  /** Debit wording that sends money to another account of the user's ("transferred to your …"). */
  readonly ownAccountDebit: string;
  readonly businessWords: string;
  readonly merchantHandle: string;
  readonly transferWords: string;
  readonly disclaimerStart: string;
  readonly rails: readonly RailRule[];
  readonly references: readonly ReferenceRule[];
  readonly types: readonly TypeRule[];
  readonly categories: readonly CategoryRule[];
  readonly periods: readonly { readonly pattern: string; readonly period: string }[];
  readonly zoneAbbreviations: Readonly<Record<string, string>>;
  readonly railLabels: Readonly<Record<string, string>>;
  readonly redactedPlaceholders: readonly string[];
  /**
   * Currency signs written without their glyph because GSM-7 SMS cannot carry
   * it ("N2,300.00" for ₦). Applied only when the pack or user currency is
   * `currency`; the replacement must keep the text length unchanged.
   */
  readonly currencyAliases: readonly { readonly currency: CurrencyCode; readonly pattern: string; readonly replacement: string }[];
}

export const ALERT_VOCABULARY: AlertVocabulary = {
  otpMessage: [
    String.raw`\bis (?:your|the) (?:otp|one[- ]?time[- ]?(?:password|passcode|pin|code)|verification code|security code|passcode|auth(?:entication)? code)\b`,
    String.raw`\b(?:otp|one[- ]?time[- ]?password)\s+(?:for|to)\s+(?:your\s+|a\s+|the\s+)?(?:txn|transaction|payment|purchase|login|log ?in|authenticat\w*|verif\w*)\b`,
    String.raw`\buse\s+(?:otp\s+)?[\dxX*•]{4,8}\s+(?:to|for|as)\b`,
  ],
  otpAdjacent: [
    String.raw`\b(?:otp|one[- ]?time|passcode|pass code|verification|verify|authenticat\w*|auth code|security code|login|log in|sign in)\b`,
    String.raw`\bcode\b`,
  ],
  // Payment requests (research 07 §3: "has requested", "payment request"; NPCI merchant collect continues).
  paymentRequest: [
    String.raw`\bcollect request\b`,
    String.raw`\bpayment request\b`,
    String.raw`\b(?:has|have) requested\b`,
    String.raw`\brequested (?:you to pay|a payment|money)\b`,
  ],
  directionNoise: [
    String.raw`\b(?:please )?(?:ignore|disregard)(?: this)?(?: (?:sms|message|alert|reminder))? if (?:already )?(?:paid|done)\b`,
    String.raw`\bif (?:already )?paid\b`,
  ],
  /** Decisive marketing phrases: a real transaction alert never says these. */
  promotionalDecisive: [
    String.raw`\bpre-?approved\b`,
    String.raw`\bpre-?qualified\b`,
    String.raw`\bloan offer\b`,
    String.raw`\byou(?:'ve| have) won\b`,
    String.raw`\bapply now\b`,
    String.raw`\bT&Cs? apply\b`,
    String.raw`\bS&K berlaku\b`,
  ],
  /** Softer marketing phrases: promotional only when no transaction anchor (masked instrument, reference) is present. */
  promotionalSoft: [
    String.raw`\blimited[- ]period\b`,
    String.raw`\bhurry\b`,
    String.raw`\bclick (?:here )?to (?:apply|avail|claim)\b`,
    String.raw`\bget (?:up ?to|flat)\b`,
    String.raw`\bexclusive offer\b`,
    String.raw`\boffer (?:valid|ends|expires)\b`,
    String.raw`\b\d{1,2}% (?:off|cashback)\b`,
    String.raw`\binstant (?:personal )?loan\b`,
    String.raw`\bcashback (?:up ?to|hingga)\b`,
    String.raw`\bdapatkan\b`,
    String.raw`\bpromo(?:ção|cao)?\b`,
    // "Get Rs.500 cashback on your next … payment. Use code BILL500" (a verified app's own marketing).
    String.raw`\bget\s+(?:rs\.?|inr|₹|\$|£|€|ksh|₦|rp|r\$)\s?[\d,.]+\s+(?:cashback|off|discount|reward)`,
    String.raw`\buse (?:promo |coupon |offer )?code\s+[A-Z0-9]{4,}\b`,
    String.raw`\bon your next (?:purchase|order|payment|bill|recharge|transaction|txn)\b`,
    String.raw`\boferta\b`,
    String.raw`\bdiskon\b`,
  ],
  /** Card-bill and statement reminders: financial, but not an event this parser models. */
  billDue: [
    String.raw`\b(?:total|min(?:imum)?) (?:amount )?due\b`,
    String.raw`\bstatement (?:has been )?generated\b`,
    String.raw`\bpayment (?:is )?due (?:on|by)\b`,
    String.raw`\bbill (?:is )?due\b`,
    // "Bill … of Rs.1500.00 is due on 15-Jan-2026", "payment of INR 10,000 is due by 25-08-2025" (HDFC, Yes Bank fixtures).
    String.raw`\b(?:is|are) (?:now )?due\b`,
    String.raw`\bbill alert\b`,
  ],
  autopayUpcoming: [
    String.raw`\bwill be (?:auto-?)?(?:debited|deducted|charged|processed)\b`,
    String.raw`\bpre-?debit (?:notification|intimation|alert)\b`,
    String.raw`\bscheduled to be (?:debited|charged|paid)\b`,
    String.raw`\bupcoming (?:payment|debit|charge|auto[- ]?pay|renewal)\b`,
    String.raw`\bwill renew\b`,
    String.raw`\bser[aá] (?:debitad[ao]|cobrad[ao])\b`,
    String.raw`\bakan didebet\b`,
  ],
  mandateRevoked: [
    String.raw`\b(?:e-?mandate|mandate|auto[- ]?pay|standing instruction)\b[^;]{0,80}?\b(?:revoked|cancell?ed|deactivated|paused|deleted|stopped)\b`,
    String.raw`\b(?:revoked|cancell?ed|paused|deactivated)\b[^;]{0,40}?\b(?:e-?mandate|mandate|auto[- ]?pay)\b`,
  ],
  mandateCreated: [
    // "auto pay facility has been successfully activated" (PNB fixture) is written with a space.
    String.raw`\b(?:e-?mandate|mandate|auto[- ]?pay|standing instruction)\b[^;]{0,100}?\b(?:created|registered|set ?up|activated|approved)\b`,
    String.raw`\b(?:created|registered|set up|activated)\b[^;]{0,40}?\b(?:e-?mandate|mandate|auto[- ]?pay|standing instruction)\b`,
    // "NACH Mandate : Rs. 100000.00 UMRN:… received today for processing" (HDFC fixture): a registration, not a credit.
    String.raw`\bmandate\b[^;]{0,120}?\breceived\b[^;]{0,25}?\bfor (?:processing|registration)\b`,
    String.raw`\bPix Autom[aá]tico\b[^;]{0,40}\b(?:autorizado|ativado|cadastrado)\b`,
  ],
  /** A reversal credit. "will be reversed" (future) is excluded by `reversalFuture`. */
  reversal: [
    String.raw`\breversed\b`,
    String.raw`\breversal\b`,
    String.raw`\bcredited back\b`,
    String.raw`\bestornad[ao]\b`,
    String.raw`\bestorno\b`,
    String.raw`\bdikembalikan\b`,
  ],
  reversalFuture: [String.raw`\bwill be (?:reversed|refunded|credited back)\b`, String.raw`\bif (?:any amount|amount is) debited\b`],
  futureCredit: [String.raw`\bwill be (?:credited|refunded|reversed|credited back|processed)\b`],
  // "Reversal of the original transaction was declined" (STC fixture); "REVERSAL OF FAILED TXN" is a real reversal and stays one.
  reversalFailed: [
    String.raw`\breversal\b[^;.]{0,40}?\b(?:was|has been|is|got)\s+(?:declined|rejected|unsuccessful)\b`,
    String.raw`\b(?:failed|unsuccessful) reversal\b`,
    String.raw`\breversal (?:has )?failed\b`,
  ],
  declined: [
    String.raw`\bdeclined\b`,
    String.raw`\bnot (?:been )?approved\b`,
    String.raw`\bfailed\b`,
    String.raw`\bunsuccessful\b`,
    String.raw`\bcould not be (?:processed|completed)\b`,
    String.raw`\binsufficient (?:funds|balance|credit limit)\b`,
    String.raw`\b(?:was|has been) rejected\b`,
    String.raw`\brecusad[ao]\b`,
    String.raw`\bnegad[ao]\b`,
    String.raw`\bn[aã]o (?:foi )?aprovad[ao]\b`,
    String.raw`\bfalhou\b`,
    String.raw`\bgagal\b`,
    String.raw`\bditolak\b`,
  ],
  refund: [
    String.raw`\brefund(?:ed)?\b`,
    String.raw`\breembols`,
    String.raw`\bdevolvid[ao]\b`,
    String.raw`\bdevolu[cç][aã]o\b`,
    String.raw`\bpengembalian dana\b`,
  ],
  /** Lifecycle words meaning money is held or in flight, not settled. */
  pending: [
    String.raw`\bcharge or hold\b`,
    String.raw`\bon hold\b`,
    String.raw`\bpre-?auth(?:ori[sz]ation)?\b`,
    String.raw`\bpending\b`,
    String.raw`\bprocessing\b(?! fee| charge)`,
    String.raw`\binitiated\b`,
    String.raw`\bwill be credited\b`,
    String.raw`\bem processamento\b`,
    String.raw`\bdiproses\b`,
    String.raw`\bwait for confirmation\b`,
  ],
  cashWithdrawal: [
    String.raw`\batm\b[^;]{0,40}\b(?:withdrawal|wdl|withdrawn|cash)\b`,
    String.raw`\b(?:withdrawal|withdrawn|wdl)\b[^;]{0,40}\batm\b`,
    String.raw`\bnfs ?cash\b`,
    String.raw`\bcash (?:withdrawal|wdl)\b`,
    String.raw`\bw\/d@`,
    String.raw`\bwithdraw (?:ksh|tsh|ush)`,
    // bKash "Cash Out Tk … to <agent>": cash taken out at an agent.
    String.raw`\bcash[- ]?out\b`,
    String.raw`\bsaque\b`,
    String.raw`\btarik tunai\b`,
  ],
  atm: [String.raw`\batm\b`, String.raw`\bnfs ?cash\b`, String.raw`\bw\/d@`],
  /** Verbs that state direction. Earliest match wins; ties go to the longer phrase ("sent you" beats "sent"). */
  debitStrong: [
    String.raw`\bdebited\b`,
    String.raw`\bdebit alert\b`,
    String.raw`\bdr\b\.?`,
    String.raw`\bspent\b`,
    String.raw`\bpaid\b`,
    String.raw`\bsent\b`,
    String.raw`\bwithdrawn\b`,
    String.raw`\bwithdraw\b`,
    String.raw`\bdeducted\b`,
    String.raw`\bcharged\b`,
    String.raw`\ba charge (?:of|for)\b`,
    String.raw`\ba debit of\b`,
    String.raw`\bcharge or hold\b`,
    String.raw`\bpurchase\b`,
    String.raw`\byou made an?\b`,
    String.raw`\btxn (?:of|rs|inr)\b`,
    String.raw`\bused (?:for|at)\b`,
    String.raw`\bbought\b`,
    String.raw`\boutgoing\b`,
    String.raw`\bcompra\b`,
    String.raw`\benviad[oa]\b`,
    String.raw`\bvoc[eê] (?:enviou|pagou)\b`,
    String.raw`\bpagamento (?:de|realizado|efetuado|enviado)\b`,
    String.raw`\bpembayaran\b`,
    String.raw`\bmengirim\b`,
    String.raw`\bwill be (?:auto-?)?(?:debited|deducted|charged)\b`,
    String.raw`\bsend money\b`,
    // Outward transfers told from the payee's side (ICICI, Federal fixtures).
    String.raw`\bcredited to (?:the )?beneficiary\b`,
    String.raw`\b(?:has|have) received\b(?=[^;]{0,60}?\bfrom your\b)`,
  ],
  creditStrong: [
    String.raw`\bcredited\b`,
    String.raw`\bcredit alert\b`,
    String.raw`\ba credit of\b`,
    // Not "Cr Crd" (credit card, Sampath fixture).
    String.raw`\bcr\b(?!\.?\s*(?:crd|card))\.?`,
    String.raw`\breceived\b`,
    String.raw`\bdeposited\b`,
    String.raw`\bincoming\b`,
    String.raw`\bsent you\b`,
    String.raw`\badded to (?:your|the)\b`,
    String.raw`\brecebid[oa]\b`,
    String.raw`\bvoc[eê] recebeu\b`,
    String.raw`\bmenerima\b`,
    String.raw`\bditerima\b`,
    String.raw`\bdana masuk\b`,
    String.raw`\bcash[- ]?in\b`,
    String.raw`\bdirect deposit\b`,
    String.raw`\bdeposit of\b`,
    String.raw`\blanded in\b`,
    String.raw`\byou(?:'ve| have)? earned\b`,
    // Money arriving in the user's own account told with a debit-sounding verb (Kotak cashback, IndusInd interest fixtures).
    String.raw`\b(?:sent|transferred|paid|added|moved) (?:to|into|on) your (?:[\w-]+ ){0,4}?(?:a\/c|acct?|account|deposit|wallet)\b`,
    String.raw`\bmade into your\b`,
    String.raw`\binterest\b(?:[^;.]|\.\d){0,30}?\bpaid\b`,
    // M-PESA agent deposit: "Give Ksh2,000.00 cash to <agent>".
    String.raw`\bgive\s+(?:[A-Za-z]{1,3}\s?)?[\d,]+(?:\.\d{1,2})?\s+cash to\b`,
    String.raw`\brefund(?:ed)?\b`,
    String.raw`\breversed\b`,
    String.raw`\bcredited back\b`,
  ],
  debitWeak: [
    String.raw`\btransfer(?:red)?\b`,
    String.raw`\bpayment\b`,
    String.raw`\btransaction\b`,
    String.raw`\btxn\b`,
    String.raw`\btransfer[eê]ncia enviada\b`,
    // Labels, not mentions: "UPI debit:Rs.599.00", "DEBIT:Rs.983.75", "DEBIT with amount", a "Debit" line
    // (South Indian, DOP, Access fixtures). Never "debit card".
    String.raw`(?:^|;\s*)debit\b(?!\s*card)`,
    String.raw`\bdebit\s*:`,
    String.raw`\bdebit (?:of|with|for)\b`,
    String.raw`\b(?:upi|neft|imps|rtgs|nip|ach|pos)\s+debit\b`,
    String.raw`\bwithdrawal\b`,
    String.raw`\b(?:thank(?:s| you) for|for) using\b`,
  ],
  creditWeak: [
    String.raw`\btransfer[eê]ncia recebida\b`,
    // Labels, not mentions: "NEFT credit of INR …", "CREDIT with amount", "UPI Credit:INR", a "Credit" line
    // (StanChart, DOP, South Indian, Access fixtures). Never "credit card", "available credit" or "service credit".
    String.raw`(?:^|;\s*)credit\b(?!\s*(?:card|limit|lmt|line|score|facility))`,
    String.raw`(?<!\b(?:available|avl|avbl)\.?\s)\bcredit\s*[:!]`,
    String.raw`(?<!\b(?:available|avl|avbl)\.?\s)\bcredit (?:of|with|for)\b`,
    String.raw`\b(?:upi|neft|imps|rtgs|nip|ach|sepa|salary)\s+credit\b`,
    String.raw`\bdeposit\b(?!\s*(?:no\b|number|account))`,
    String.raw`\btransfer in\b`,
  ],
  /** Context right before an amount that makes it a balance, a limit, a fee or a running total. */
  balanceWords: String.raw`\b(?:bal|balance|avl bal|saldo)\b`,
  // Also "Avl Bal in your A/c is Rs.2,992.54" (UCO fixture) and "Aval Bal is INR …" (Dhanlaxmi fixture).
  balanceBefore: String.raw`(?<![a-z])(?:bal(?:ance)?|avl|avbl|aval|avail(?:able)?|saldo(?: atual| dispon[ií]vel)?|sisa saldo)(?:\s+in\s+(?:your\s+)?(?:a\/c|acct?|account)(?:\s+(?:no\.?\s*)?[\w*•]+)?)?\s*(?:is|was|of|de|:|-|\.)?\s*(?:is\s*)?(?::\s*)?$`,
  // "Acct CK0000 has a $10.12 bal" (Huntington fixture).
  balanceAfter: String.raw`^\s*(?:avl\.?\s*|available\s+)?bal(?:ance)?\b`,
  limitBefore: String.raw`(?<![a-z])(?:lmt|limit|limite)\s*(?:is|of|:|-)?\s*$`,
  // Singular "charge" is deliberately absent: "A charge of $45.20 at …" is the transaction itself.
  feeBefore: String.raw`(?<![a-z])(?:fee|charges|cost|taxa(?: de)?|tarifa|biaya)\s*(?:of|is|was|:|-|,)?\s*$`,
  aggregateBefore: String.raw`(?<![a-z])(?:spent|total)\s*$`,
  aggregateAfter: String.raw`^\s*(?:today|this (?:week|month)|so far)\b`,
  /** Masked instrument tokens; the first match not preceded by a counterparty label is the user's instrument. */
  maskedInstrument: [
    String.raw`(?<![a-z])(?:a\/c|acct?|account|ac|card|cart[aã]o|kartu|no\.)\s*(?:no\.?|number|ending(?: in| with)?|final)?\s*[:.]?\s*([xX*•]{1,12}\s?-?\d{3,5})(?!\d)`,
    String.raw`(?<![\w*•])([xX*•]{2,12}\d{3,5})(?!\d)`,
    String.raw`\b(?:ending|ends)(?: in| with)?\s*[:.]?\s*(\d{4,5})(?!\d)`,
    String.raw`\b(?:com )?final\s*(\d{4})(?!\d)`,
    String.raw`\bakhiran\s*(\d{4})(?!\d)`,
    String.raw`\bcard\s*(?:no\.?\s*)?\((\d{4})\)`,
    String.raw`\bCard (\d{4})\b`,
  ],
  /** Words right before a masked token that make it the other party's account. */
  counterpartyAccountBefore: String.raw`(?:sender|beneficiary|payee|remitter|benef\.?)\s*(?:a\/c|acct?|account)?\s*(?:no\.?)?\s*[:.]?\s*$`,
  instrumentCard: String.raw`\b(?:credit|debit|prepaid)?\s*card\b|cart[aã]o|\bkartu\b`,
  instrumentAccount: String.raw`\b(?:a\/c|acct?|account|ac)\b`,
  instrumentWallet: String.raw`\bwallet\b|\bcarteira\b|\bdompet\b`,
  cardCredit: String.raw`\bcredit card\b|\bavl\.? ?(?:lmt|limit)\b|\bavailable (?:credit )?limit\b|\bBLOCK CC\b|\bcart[aã]o de cr[eé]dito\b|\bcr[eé]dito\b`,
  cardDebit: String.raw`\bdebit card\b|\bBLOCK DC\b|\bcart[aã]o de d[eé]bito\b|\bd[eé]bito\b`,
  cardPrepaid: String.raw`\bprepaid card\b`,
  cardNetworks: [
    { pattern: String.raw`\bvisa\b`, network: "visa" },
    { pattern: String.raw`\bmaster ?card\b`, network: "mastercard" },
    { pattern: String.raw`\brupay\b`, network: "rupay" },
    { pattern: String.raw`\bamex\b|\bamerican express\b`, network: "amex" },
    { pattern: String.raw`\bdiscover\b(?= card)`, network: "discover" },
    { pattern: String.raw`\belo\b`, network: "elo" },
    { pattern: String.raw`\bmaestro\b`, network: "maestro" },
  ],
  /** Party extraction, highest priority first. */
  parties: [
    // The payee ends at the next "/", ";", sentence end or a following label ("ZOMATO LTD. Avl bal:INR …").
    { id: "upi-p2m", pattern: String.raw`UPI\/P2M\/\d{6,}\/(?<name>[^;\/]+?)${UPI_PAYEE_END}`, isMerchant: 0.95 },
    { id: "upi-p2a", pattern: String.raw`UPI\/P2[AP]\/\d{6,}\/(?<name>[^;\/]+?)${UPI_PAYEE_END}`, isMerchant: 0.05 },
    { id: "upi-info", pattern: String.raw`\bInfo:?\s*UPI\/(?:[^;\s\/]*\/)*?\d{6,}\/\s*(?<name>[^;\/]+?)${UPI_PAYEE_END}` },
    // "Info: UPI/<merchant>/<category>" without a reference segment (PennyWise HDFC INFO_PATTERN).
    { id: "upi-info-plain", pattern: String.raw`\bInfo:?\s*UPI\/(?<name>[A-Za-z][^;\/]*?)${UPI_PAYEE_END}` },
    {
      id: "vpa",
      pattern: String.raw`\b(?:to|from|by|Cr\. to|paid to|sent to)\s+(?:VPA\s+)?(?<vpa>[a-z0-9][\w.-]{0,254}@[a-z][a-z0-9]{1,63})\b(?!\.[a-z])(?:\s*\((?<name>[^)]{2,60})\))?`,
    },
    { id: "transaction-with", pattern: String.raw`\btransaction with\s+(?<name>.+?)${STOP}`, directions: ["debit"], isMerchant: 0.95 },
    { id: "paybill", pattern: String.raw`\bsent to\s+(?<name>.+?)\s+for account\b`, directions: ["debit"], isMerchant: 0.9 },
    { id: "mandate-for", pattern: String.raw`\b(?:mandate|auto[- ]?pay|subscription)\s+(?:for|towards|to)\s+(?<name>.+?)${STOP}`, isMerchant: 0.9 },
    { id: "towards", pattern: String.raw`\btowards\s+(?<name>.+?)${STOP}`, isMerchant: 0.8 },
    { id: "at", pattern: String.raw`\bat\s+(?<name>.+?)${STOP}`, directions: ["debit"], isMerchant: 0.9 },
    { id: "pt-em", pattern: String.raw`\bem\s+(?<name>[A-Z0-9].+?)${STOP}`, flags: "", directions: ["debit"], isMerchant: 0.9 },
    { id: "icici-credited-payee", pattern: String.raw`;\s*(?<name>[^;]+?)\s+credited\b`, directions: ["debit"] },
    { id: "paid-to", pattern: String.raw`\bpaid to\s+(?<name>.+?)${STOP}`, directions: ["debit"], isMerchant: 0.7 },
    {
      id: "to",
      pattern: String.raw`\b(?:trf to|transfer(?:red)? to|sent to|payment to|Cr\. to|to)\s+(?<name>.+?)${STOP}`,
      directions: ["debit"],
    },
    { id: "pt-para", pattern: String.raw`\bpara\s+(?<name>.+?)${STOP}`, directions: ["debit"] },
    { id: "id-ke", pattern: String.raw`\bke\s+(?<name>.+?)${STOP}`, directions: ["debit"] },
    { id: "sent-you", pattern: String.raw`(?:^|[.;!]\s*)(?<name>[A-Z][\w '-]{1,40}?) sent you\b`, flags: "", directions: ["credit"] },
    { id: "by-sender", pattern: String.raw`\bby sender\s+(?<name>.+?)${STOP}`, directions: ["credit"] },
    { id: "from", pattern: String.raw`\b(?:received from|transfer from|from)\s+(?<name>.+?)${STOP}`, directions: ["credit"] },
    { id: "pt-de", pattern: String.raw`\bde\s+(?<name>[A-Z][^;]+?)${STOP}`, flags: "", directions: ["credit"] },
    { id: "id-dari", pattern: String.raw`\bdari\s+(?<name>.+?)${STOP}`, directions: ["credit"] },
    { id: "by", pattern: String.raw`\bby\s+(?<name>[A-Z][^;]+?)${STOP}`, flags: "", directions: ["credit"] },
    { id: "desc", pattern: String.raw`\bDesc(?:ription)?\s*:\s*(?<name>[^;]+?)(?=\s*;|\s+Bal\b|$)` },
  ],
  /** Names that are not parties at all. */
  // Includes imperative verbs from boilerplate ("to send Ksh…", "to check daily charges", "to block card").
  partyReject: String.raw`^(?:your|you|the|a\/c|ac|acct|account|card|o|a|os|as|self|own|vpa|upi|imps|neft|rtgs|nach|ecs|ach|pix|atm|mobile|block|dispute|report|cancel|any|date|rs\.?|inr|cust|send|pay|check|call|dial|click|tap|visit|view|know|reply|login|log in|download|manage|approve|decline|unblock|activate)\b|\[link\]`,
  // "credited to your A/c" names the user's own account, not an own-account counterparty, so it is not here.
  ownAccount: String.raw`\bself[- ]?transfer\b|\bown (?:a\/c|acct?|account)s?\b|\b(?:to|from) self\b|\bbetween (?:your )?(?:own )?accounts\b`,
  ownAccountDebit: String.raw`\b(?:transfer(?:red)?|trf|sent|moved) to your\b`,
  /** Hints that a party is a business rather than a person. */
  businessWords: String.raw`\b(?:ltd|limited|pvt|private|inc|llc|llp|corp|company|co\.|store|stores|mart|supermarket|market|shop|restaurant|cafe|café|hotel|foods?|pharmacy|medical|enterprises?|traders?|services|technologies|solutions|ltda|eireli|tbk|pt|toko|warung|bakery|padaria|loja|mercado|posto|prepaid|fund|insurance|agency|agencies|telecom|airlines?|supermercado)\b|#\d+|\.com\b`,
  /** VPA local parts typical of merchant/QR handles. */
  merchantHandle: String.raw`(?:^q\d{6,}|paytmqr|bharatpe|razorpay|\.rzp|merchant|store|shop|pay\b|payu|cashfree|billdesk|ccavenue)`,
  transferWords: String.raw`\b(?:transfer|trf|nip|imps|neft|rtgs|outward)\b`,
  /** Where an alert's fraud/help boilerplate starts; keyword hints ignore everything after it. */
  disclaimerStart: String.raw`\b(?:not you|if not (?:[a-z]+ )?(?:by )?(?:you|u)|if not done|if not transacted|fwd sms|forward this sms|to (?:block|dispute|report)|never share|call \d|sms block)\b`,
  rails: [
    { pattern: String.raw`\bUPI\b|\bVPA\b|@(?:ok(?:axis|hdfcbank|icici|sbi)|ybl|ibl|axl|paytm|upi|apl|yapl|icici|hdfcbank|sbi|axisbank|kotak|yesbank|indus|federal|idfcbank|rbl|airtel|jio|fam|axisb|pthdfc|ptsbi|ptyes|ptaxis|waicici|wahdfcbank|naviaxis|superyes|freecharge|ikwik)\b`, rail: UPI },
    { pattern: String.raw`\bIMPS\b`, rail: { family: "account_to_account_instant", scheme: "imps" } },
    { pattern: String.raw`\bRTGS\b`, rail: { family: "account_to_account_instant", scheme: "rtgs" } },
    { pattern: String.raw`\bNEFT\b`, rail: { family: "account_to_account_batch", scheme: "neft" } },
    { pattern: String.raw`\b(?:NACH|ECS)\b`, rail: { family: "direct_debit", scheme: "nach" } },
    { pattern: String.raw`\bACH\b`, rail: { family: "direct_debit", scheme: "ach" } },
    { pattern: String.raw`\bdirect debit\b`, rail: { family: "direct_debit" } },
    { pattern: String.raw`\bPix\b`, rail: PIX },
    { pattern: String.raw`\bZelle\b`, rail: { family: "account_to_account_instant", scheme: "zelle" } },
    { pattern: String.raw`\bFaster Payments?\b`, rail: { family: "account_to_account_instant", scheme: "faster_payments" } },
    { pattern: String.raw`\bSEPA Instant\b|\bSCT ?Inst\b`, rail: { family: "account_to_account_instant", scheme: "sepa_inst" } },
    { pattern: String.raw`\bSEPA\b`, rail: { family: "account_to_account_batch", scheme: "sepa" } },
    { pattern: String.raw`\bBI-?FAST\b`, rail: { family: "account_to_account_instant", scheme: "bi_fast" } },
    { pattern: String.raw`\bNIP\b`, rail: { family: "account_to_account_instant", scheme: "nip" } },
    { pattern: String.raw`\bInterac e-?Transfer\b`, rail: { family: "account_to_account_instant", scheme: "interac" } },
    { pattern: String.raw`\bRAAST\b`, rail: { family: "account_to_account_instant", scheme: "raast" } },
    { pattern: String.raw`\bIBFT\b`, rail: { family: "account_to_account_instant", scheme: "ibft" } },
  ],
  /** Event references every pack understands. "$rail": namespace = detected A2A/mobile-money scheme. */
  references: [
    { pattern: String.raw`\bUPI(?:\s*(?:Ref(?:erence)?|RRN|Txn|Transaction))?(?:\s*(?:No|ID|Number))?\.?\s*[:#.-]?\s*(\d{12})(?!\d)`, type: "rail_reference", namespace: "upi" },
    { pattern: String.raw`\bUPI\/(?:P2[AMP]|CR|DR|[A-Z]{2,4})\/(\d{12})(?!\d)`, type: "rail_reference", namespace: "upi" },
    { pattern: String.raw`\bIMPS(?:\s*Ref(?:erence)?)?(?:\s*No)?\.?\s*[:#.-]?\s*(\d{12})(?!\d)`, type: "rail_reference", namespace: "imps" },
    { pattern: String.raw`\b(?:RRN|UTR)(?:\s*(?:No|Number))?\.?\s*[:#.-]?\s*((?=[A-Z]*\d)[A-Z0-9]{12,22})\b`, type: "rail_reference", namespace: "$rail" },
    { pattern: String.raw`\bRef(?:erence)?\.?\s*(?:No|ID|#)?\.?\s*[:#.-]?\s*(\d{12})(?!\d)`, type: "rail_reference", namespace: "$rail" },
    // Pix EndToEndId: "E" + 8-digit ISPB + yyyyMMddHHmm + 11 alphanumerics (32 characters).
    { pattern: String.raw`\b(E\d{20}[A-Za-z0-9]{11})\b`, flags: "", type: "rail_reference", namespace: "pix" },
    // Card approval codes. ("Auth code …" is dropped earlier: core's OTP detector treats it as a code.)
    { pattern: String.raw`\b(?:approval|appr\.?)\s*(?:code|no\.?|#)\s*[:#.-]?\s*([A-Z0-9]{6})\b`, type: "auth_code", namespace: "$issuer" },
    { pattern: String.raw`\b(?:UMRN|UMN|mandate (?:ref(?:erence)?|id|no\.?))\s*[:#.-]?\s*([A-Za-z0-9][A-Za-z0-9@._-]{5,63})`, type: "mandate_id", namespace: "$mandate" },
  ],
  types: [
    { pattern: String.raw`\bsalary\b|\bpayroll\b|\bSAL\b`, directions: ["credit"], type: "income", confidence: 0.85, reason: "alert:salary-keyword" },
    { pattern: String.raw`\binterest\b(?:[^;.]|\.\d){0,30}?\b(?:credited|paid|amount|earned)\b|\bint\.? (?:credited|pd)\b`, directions: ["credit"], type: "income", confidence: 0.7, reason: "alert:interest-keyword" },
    { pattern: String.raw`\b(?:paid|payment|transferred|sent)\b[^;]{0,40}\btowards (?:your )?[\w ]{0,30}credit card\b|\bcredit card (?:bill )?payment\b|\bpayment (?:of [^;]{0,30})?(?:received )?towards your [\w ]{0,30}card\b|\bcard ?bill\b|\bCC (?:bill|payment)\b|\bpayment (?:received|credited) (?:on|to|for) your [\w ]{0,30}card\b|\bpayment\b[^;]{0,40}?\b(?:received|credited)\b[^;]{0,30}?\b(?:on|to|for|towards|in) your [\w ]{0,30}?card\b`, type: "credit_card_payment", confidence: 0.85, reason: "alert:card-payment-keyword" },
    { pattern: String.raw`\b(?:added|loaded|topped up) (?:to|into|in) (?:your )?(?:\w+ )?wallet\b|\bwallet (?:top-?up|load)\b|\badd money\b`, type: "transfer", transferKind: "wallet_load", confidence: 0.75, reason: "alert:wallet-load" },
    // A neobank or wallet "Top-up" is the user's own money loaded from another instrument, not income.
    { pattern: String.raw`\btop-?up\b|\btopped up\b`, directions: ["credit"], type: "transfer", transferKind: "wallet_load", confidence: 0.7, reason: "alert:top-up" },
    { pattern: String.raw`\bEMI (?:of|for|debited|paid|deducted)\b|\bloan (?:EMI|repayment|instal+ment)\b`, directions: ["debit"], type: "loan_payment", confidence: 0.7, reason: "alert:loan-keyword" },
    { pattern: String.raw`\bSIP\b|\bmutual fund\b|\bdemat\b|\bredemption\b`, type: "investment", confidence: 0.7, reason: "alert:investment-keyword" },
    { pattern: String.raw`\b(?:airtime|mobile recharge|data bundle|pulsa)\b`, directions: ["debit"], type: "purchase", confidence: 0.85, reason: "alert:airtime" },
    { pattern: String.raw`\b(?:annual|joining|late payment|SMS|service|maintenance|processing) (?:fee|charges?)\b|\bcharges? (?:debited|levied|deducted)\b`, directions: ["debit"], type: "fee", confidence: 0.8, reason: "alert:fee-keyword" },
    { pattern: String.raw`\b(?:mandate|auto[- ]?pay|auto-?debit|standing instruction|recurring)\b`, directions: ["debit"], type: "subscription", confidence: 0.75, reason: "alert:autopay-debit" },
    // Agent cash-in and deposits are transfers into the user's wallet, not income (research 07 §1b).
    { pattern: String.raw`\bcash[- ]?in\b|\bgive\b[^;]{0,25}?\bcash to\b`, directions: ["credit"], type: "transfer", transferKind: "wallet_load", confidence: 0.75, reason: "alert:cash-in" },
  ],
  categories: [
    { pattern: String.raw`\b(?:airtime|recharge|data bundle|mobile recharge|postpaid|broadband|pulsa|paket data)\b`, category: "bills.phone_internet" },
    { pattern: String.raw`\b(?:electricity|power bill|kplc|listrik|water bill|gas bill|utility)\b`, category: "bills.utilities" },
    { pattern: String.raw`\b(?:fuel|petrol|diesel|gas station|filling station|posto|combust[ií]vel|bensin|pertamina)\b`, category: "transport.fuel" },
    { pattern: String.raw`\b(?:fastag|toll|parking)\b`, category: "transport" },
    { pattern: String.raw`\b(?:insurance|seguro|asuransi)\b`, category: "bills.insurance" },
    { pattern: String.raw`\b(?:rent|aluguel)\b`, category: "housing.rent" },
    { pattern: String.raw`\b(?:supermarket|grocery|groceries|supermercado|hypermarket)\b`, category: "groceries" },
    { pattern: String.raw`\b(?:padaria|bakery|restaurant|restaurante)\b`, category: "eating_out.restaurant" },
    { pattern: String.raw`\b(?:cafe|café|kopi|coffee)\b`, category: "eating_out.cafe" },
    { pattern: String.raw`\b(?:pharmacy|chemist|farm[aá]cia|apotek|hospital|clinic)\b`, category: "health" },
  ],
  /** Mandate frequency words -> ISO 8601 period. */
  periods: [
    { pattern: String.raw`\bmonthly\b|\bmensal\b|\bbulanan\b`, period: "P1M" },
    { pattern: String.raw`\b(?:yearly|annual(?:ly)?|anual)\b`, period: "P1Y" },
    { pattern: String.raw`\bquarterly\b`, period: "P3M" },
    { pattern: String.raw`\bhalf[- ]yearly\b`, period: "P6M" },
    { pattern: String.raw`\bweekly\b|\bsemanal\b`, period: "P1W" },
    { pattern: String.raw`\bdaily\b|\bdi[aá]rio\b`, period: "P1D" },
  ],
  /** Zone abbreviations written right after an alert's time ("1:56 PM ET"). */
  zoneAbbreviations: {
    IST: "Asia/Kolkata",
    ET: "America/New_York",
    EST: "America/New_York",
    EDT: "America/New_York",
    CT: "America/Chicago",
    CST: "America/Chicago",
    CDT: "America/Chicago",
    MT: "America/Denver",
    MST: "America/Denver",
    MDT: "America/Denver",
    PT: "America/Los_Angeles",
    PST: "America/Los_Angeles",
    PDT: "America/Los_Angeles",
    GMT: "UTC",
    UTC: "UTC",
    BST: "Europe/London",
    EAT: "Africa/Nairobi",
    WAT: "Africa/Lagos",
    BRT: "America/Sao_Paulo",
    WIB: "Asia/Jakarta",
  },
  /** Short labels for evidence summaries. */
  railLabels: {
    upi: "UPI",
    imps: "IMPS",
    neft: "NEFT",
    rtgs: "RTGS",
    nach: "NACH",
    ach: "ACH",
    pix: "Pix",
    mpesa: "M-PESA",
    bkash: "bKash",
    zelle: "Zelle",
    faster_payments: "Faster Payments",
    sepa: "SEPA",
    sepa_inst: "SEPA Instant",
    bi_fast: "BI-FAST",
    nip: "NIP",
    atm: "ATM",
  },
  /**
   * Android 15+ replaces OTP-bearing notifications for untrusted listeners
   * with this placeholder (framework string `redacted_notification_message`,
   * stream 03 §1).
   */
  redactedPlaceholders: [String.raw`^sensitive notification content hidden\.?$`],
  // Nigerian banks and wallets write "N2,300.00" for ₦ (TestOpayBankParser, TestVFDBankParser fixtures).
  currencyAliases: [{ currency: "NGN", pattern: String.raw`(?<![\w.,])N(?=\d)`, replacement: "₦" }],
};

/** Find a pack by id (pack tooling and tests). */
export function packById(id: string, packs: readonly AlertPack[] = ALERT_PACKS): AlertPack | undefined {
  return packs.find((p) => p.id === id);
}
