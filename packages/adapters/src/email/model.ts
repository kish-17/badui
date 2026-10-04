import type { CountryCode, CurrencyCode, EpochMillis, Observation } from "@brake/core";

/**
 * Provider-neutral email shapes. Every email transport (Gmail API, Microsoft
 * Graph, IMAP, a receipts forwarding address, a manually shared `.eml`)
 * converts its own message format into `NormalizedEmail` at the edge, so the
 * extraction pipeline never knows which mailbox a message came from.
 *
 * A `NormalizedEmail` is transient: it lives only for the duration of one
 * `parse` call and is never persisted. Note what it deliberately lacks:
 * recipients (To/Cc/Bcc), reply-to and other people's addresses are never
 * carried across the boundary.
 */

export interface EmailAddress {
  /** Lower-cased mailbox address of the sender ("auto-confirm@amazon.in"). */
  readonly address: string;
  /** Display name as the sender wrote it ("Amazon.in"). */
  readonly name?: string;
}

/**
 * Sender-authentication verdicts. The receiving provider's top-most
 * `Authentication-Results` header (or BRAKE's own DKIM check on a forwarding
 * inbox) is the only thing that distinguishes a real Amazon receipt from a
 * phishing copy, so confidence is gated on it (research 06, "Sender
 * authentication gate").
 */
export interface EmailAuthentication {
  readonly dkim?: "pass" | "fail" | "none";
  readonly dmarc?: "pass" | "fail" | "none";
  /** The DKIM signing domain (`header.d=` / `header.i=@…`) when DKIM passed. */
  readonly domain?: string;
}

export interface NormalizedEmail {
  /** Provider message id (Gmail `id`, Graph `id`, IMAP `UIDVALIDITY:UID`). */
  readonly messageId: string;
  /** Provider thread/conversation id. */
  readonly threadId?: string;
  readonly from: EmailAddress;
  readonly subject: string;
  /** When the provider accepted the message (Gmail `internalDate`, Graph `receivedDateTime`); 0 when unknown. */
  readonly date: EpochMillis;
  /** text/plain body, if the message had one. */
  readonly text?: string;
  /** text/html body, if the message had one. */
  readonly html?: string;
  /** True when the message carries a `List-Unsubscribe` header (bulk/marketing mail; never a paid subscription by itself). */
  readonly listUnsubscribe?: boolean;
  /** schema.org JSON-LD nodes found in the HTML body (already flattened). */
  readonly jsonLd?: unknown[];
  /** RFC 5322 `Message-ID`: the same email delivered through two transports keeps it, so it is the preferred natural key. */
  readonly internetMessageId?: string;
  readonly authentication?: EmailAuthentication;
  /**
   * How the message reached a forwarding inbox. "manual" forwards are
   * re-wrapped by the user's client and lose the merchant's DKIM signature,
   * which caps confidence.
   */
  readonly forwarded?: "auto" | "manual";
}

/** What a transactional sender is to the user. */
export type SenderRole = "merchant" | "bank" | "payment" | "travel" | "subscription";

/**
 * A sub-brand selected by subject keyword ("Uber" vs "Uber Eats" share
 * uber.com). Data, not control flow.
 */
export interface SenderVariant {
  /** Case-insensitive substring of the subject that selects this variant. */
  readonly subjectKeyword: string;
  readonly key: string;
  readonly displayName: string;
  readonly category?: string;
}

/** One entry of the transactional-sender data pack. */
export interface SenderInfo {
  /** Lower-case merchant/institution key, also the namespace of its order/booking references ("amazon"). */
  readonly key: string;
  readonly displayName: string;
  readonly role: SenderRole;
  /** Market the domain serves; a tie-breaker for "$" and numeric date order, never a branch. */
  readonly country?: CountryCode;
  /** Usual currency of the domain's emails when an amount carries no marker. */
  readonly currency?: CurrencyCode;
  /** BRAKE taxonomy id (copied from intelligence/taxonomy, not imported). */
  readonly category?: string;
  /** ISO 18245 MCC when the sender's business is unambiguous. */
  readonly mcc?: string;
  /**
   * Local parts known to send transactional mail. When set, other addresses on
   * the domain (store-news@, deals@) are treated as unknown/marketing senders.
   */
  readonly addresses?: readonly string[];
  /** Payment senders whose counterparties are mostly people: names are never kept. */
  readonly p2p?: boolean;
  readonly variants?: readonly SenderVariant[];
}

/** A sender resolved against the data pack. */
export interface SenderMatch {
  readonly info: SenderInfo;
  /** The registry domain that matched ("amazon.in" for "auto-confirm@amazon.in"). */
  readonly domain: string;
  /** False when the domain is known but the local part is not one of its transactional addresses. */
  readonly addressKnown: boolean;
}

/** Everything an extractor may know about the email besides its text. */
export interface EmailContext {
  /** Resolved transactional sender, when the domain is in the data pack. */
  readonly sender?: SenderMatch;
  /** Business display name for unknown senders (never set for personal mailboxes). */
  readonly senderName?: string;
  /** Domain of the sending address. */
  readonly senderDomain: string;
  readonly subject: string;
  /** Best known send/arrival time of the email. */
  readonly emailDate: EpochMillis;
  /** Sender market, else the user's country: used only to resolve "$" and date order. */
  readonly country?: CountryCode;
  readonly defaultCurrency?: CurrencyCode;
  readonly timeZone?: string;
}

/** How a finding was extracted; drives default confidence. */
export type ExtractionMethod = "schema_org" | "template" | "heuristic" | "subject_only";

/**
 * An observation before the adapter stamps identity, provenance, privacy
 * evidence and sender-trust onto it. Extractors stay pure functions of
 * (text, context) and never see connection ids or clocks.
 */
export type EmailFinding = Omit<Observation, "id" | "source" | "receivedAt" | "evidence" | "country"> & {
  readonly method: ExtractionMethod;
  /** Noun phrase for the summary: "order confirmation", "renewal notice". */
  readonly label: string;
  /** Distinguishes several findings of one email inside the natural key. */
  readonly key: string;
  /** The single line the key fact came from; becomes a redacted, expiring excerpt. */
  readonly matchedLine?: string;
  /** Extra plain-language detail for the summary ("shipped", "Hotel Adlon Kempinski"). */
  readonly detail?: string;
};
