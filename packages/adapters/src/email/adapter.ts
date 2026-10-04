import { DAY, formatMoney, isOneTimePasswordMessage, redactSensitive } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  EpochMillis,
  Money,
  Observation,
  RawSignal,
  SignalAdapter,
  SourceRef,
} from "@brake/core";
import { normalizeWhitespace, observationId } from "../shared/text";
import { extractFindings } from "./extract";
import { parseAddressHeader } from "./gmail";
import { extractJsonLd, htmlToText } from "./html";
import { jsonLdFindings } from "./jsonld";
import type { EmailAddress, EmailContext, EmailFinding, NormalizedEmail, SenderMatch } from "./model";
import { classifyEmail, emailDomain, isPersonalMailbox, lookupSender, senderAllowed, senderVariant } from "./senders";

/**
 * The email adapter: NormalizedEmail -> observations. One adapter serves every
 * transport (Gmail, Outlook/Graph, IMAP, a receipts forwarding address); the
 * transport only changes the provenance label.
 *
 * Pipeline (docs/research/06-email-intelligence.md §14–§16):
 *   OTP drop -> sender allow-list -> transactional filter (promotional /
 *   not_financial) -> schema.org JSON-LD -> heuristic extractors ->
 *   sender-trust gate -> observations.
 *
 * Privacy: bodies are read in memory and dropped. Observations keep extracted
 * facts only; evidence is a sentence BRAKE writes plus, at most, the single
 * matched line, redacted and expiring after 7 days. Recipient addresses,
 * greetings, delivery addresses, routes and P2P payee names never leave this
 * function.
 */

export type EmailProvider = "gmail" | "outlook" | "imap" | "forwarding";

export interface EmailAdapterOptions {
  /** Sender addresses or domains the user allowed ("amazon.in", "alerts@hdfcbank.net"). Others are ignored unread. */
  readonly allowedSenders?: readonly string[];
  readonly provider?: EmailProvider;
}

export const EMAIL_ADAPTER_ID = "email";

/** Reads after "your": "Detected from your Gmail inbox". */
const SOURCE_LABEL: Readonly<Record<EmailProvider, string>> = {
  gmail: "Gmail inbox",
  outlook: "Outlook inbox",
  imap: "email inbox",
  forwarding: "receipts forwarding address",
};

const DISPLAY_NAME: Readonly<Record<EmailProvider, string>> = {
  gmail: "Gmail",
  outlook: "Outlook",
  imap: "Email (IMAP)",
  forwarding: "Receipts forwarding address",
};

const EXCERPT_TTL = 7 * DAY;
const EXCERPT_MAX = 160;

export function createEmailAdapter(opts: EmailAdapterOptions = {}): SignalAdapter<NormalizedEmail> {
  const descriptor: AdapterDescriptor = {
    id: EMAIL_ADAPTER_ID,
    kind: "email",
    displayName: opts.provider ? DISPLAY_NAME[opts.provider] : "Email",
    windows: ["post_spend", "pre_spend"],
    platforms: ["android", "ios", "web", "server"],
    requiresCapabilities: ["email:connected"],
    privacy: {
      sensitivity: "high",
      dataCategories: [
        "order, receipt, invoice and booking emails from transactional senders",
        "subscription renewal, trial, price-change and cancellation emails",
        "refund emails",
        "bank and card transaction alert emails",
      ],
      processing: "either",
    },
  };
  return { descriptor, parse: (signal, ctx) => parseEmail(signal, ctx, opts) };
}

/**
 * Text kept from one body. Receipts are a few KB of visible text; a body far
 * beyond this is cut so that a hostile or broken message cannot stall parsing.
 */
const MAX_TEXT_CHARS = 500_000;

/**
 * The contract is "return ignored/rejected, never throw": a bug or an
 * unforeseen payload shape surfaces as a rejection (with no message content in
 * the reason) instead of taking down the caller's ingest loop.
 */
function parseEmail(signal: RawSignal<NormalizedEmail>, actx: AdapterContext, opts: EmailAdapterOptions): AdapterResult {
  try {
    return parseValidated(signal, actx, opts);
  } catch {
    return { status: "rejected", reason: "email could not be parsed" };
  }
}

function parseValidated(signal: RawSignal<NormalizedEmail>, actx: AdapterContext, opts: EmailAdapterOptions): AdapterResult {
  const email = signal.payload;
  const problem = validate(email);
  if (problem) return { status: "rejected", reason: `malformed email payload: ${problem}` };

  const htmlText = email.html ? htmlToText(email.html).slice(0, MAX_TEXT_CHARS) : "";
  const plainText = (email.text ?? "").slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, "\n");
  // OTPs are dropped before anything is extracted, kept or logged, whichever body carries them.
  if (isOtpEmail(email.subject, htmlText) || isOtpEmail(email.subject, plainText)) return { status: "ignored", reason: "otp" };
  // HTML is preferred, but an image-only HTML receipt has no figures; its text/plain alternative does.
  const visible = htmlText.length > 0 && (/\d/.test(htmlText) || !/\d/.test(plainText)) ? htmlText : plainText;

  const unwrapped = unwrapForward(email, visible);
  const from = unwrapped.from;
  if (opts.allowedSenders && !senderAllowed(from.address, opts.allowedSenders)) return { status: "ignored", reason: "not_financial" };

  const nodes = email.jsonLd ?? (email.html ? extractJsonLd(email.html) : []);
  const verdict = classifyEmail(email, { text: unwrapped.text, from: from.address, subject: unwrapped.subject, jsonLd: nodes });
  if (!verdict.transactional) return { status: "ignored", reason: verdict.reason ?? "not_financial" };

  const sender = verdict.sender ?? lookupSender(from.address);
  const domain = emailDomain(from.address);
  const ctx: EmailContext = {
    ...(sender ? { sender } : {}),
    ...(!sender && from.name && !isPersonalMailbox(domain) ? { senderName: cleanDisplayName(from.name) } : {}),
    senderDomain: domain,
    subject: unwrapped.subject,
    emailDate: email.date > 0 ? email.date : signal.receivedAt,
    ...((sender?.info.country ?? actx.country) ? { country: sender?.info.country ?? actx.country } : {}),
    ...((sender?.info.currency ?? actx.defaultCurrency) ? { defaultCurrency: sender?.info.currency ?? actx.defaultCurrency } : {}),
    ...(actx.timeZone ? { timeZone: actx.timeZone } : {}),
  };

  let findings = jsonLdFindings(nodes, ctx, unwrapped.text);
  if (findings.length === 0) findings = extractFindings(unwrapped.text, ctx);
  if (findings.length === 0) return { status: "ignored", reason: "unsupported_format" };

  const trust = senderTrust(email, sender, unwrapped.manual);
  const base = email.internetMessageId?.trim() || email.messageId;
  const source: Omit<SourceRef, "provider"> = {
    adapterId: EMAIL_ADAPTER_ID,
    kind: "email",
    connectionId: signal.connectionId,
    label: SOURCE_LABEL[opts.provider ?? (email.forwarded ? "forwarding" : "imap")],
  };
  const fmt = formatter(actx);
  const usedKeys = new Set<string>();
  const observations = findings.map((f) => {
    let key = f.key;
    for (let n = 2; usedKeys.has(key); n++) key = `${f.key}#${n}`;
    usedKeys.add(key);
    return toObservation(f, {
      id: observationId(EMAIL_ADAPTER_ID, signal.connectionId, `${base}#${key}`),
      source,
      provider: providerName(f, ctx),
      receivedAt: signal.receivedAt,
      trust,
      fmt,
      ...(ctx.country ? { country: ctx.country } : {}),
    });
  });
  return { status: "observations", observations };
}

// ---------------------------------------------------------------------------
// OTP gate
// ---------------------------------------------------------------------------

/** Subjects that announce a one-time code; such mail is never read further (research 06 §13i). */
const OTP_SUBJECT = /\b(?:otp|one[\s-]?time[\s-]?pass(?:word|code)?|verification code|security code|passcode|login code)\b/i;

/**
 * Abbreviations whose dot is not a sentence end ("Rs. 1,249"). The shared OTP
 * detector treats ". " as a sentence break between keyword and code, so these
 * are normalised before it runs.
 */
const ABBREVIATION_DOT = /\b(Rs|No|Ref|Txn|Acct|Amt|approx|Rp|Ksh)\.\s/gi;

function isOtpEmail(subject: string, text: string): boolean {
  if (OTP_SUBJECT.test(subject) && /(?<![\d.,])\d{4,8}(?![\d.,])/.test(text)) return true;
  return isOneTimePasswordMessage(subject) || isOneTimePasswordMessage(text.replace(ABBREVIATION_DOT, "$1 "));
}

// ---------------------------------------------------------------------------
// Validation and forwarding
// ---------------------------------------------------------------------------

/** Runtime shape check: the payload crosses a JSON boundary from native/transport code, so types are not trusted. */
function validate(email: unknown): string | undefined {
  if (email === null || typeof email !== "object") return "payload is not an object";
  const e = email as Partial<Record<keyof NormalizedEmail, unknown>>;
  const from = e.from as Partial<Record<"address" | "name", unknown>> | null | undefined;
  if (typeof e.messageId !== "string" || e.messageId.length === 0) return "missing messageId";
  if (!from || typeof from !== "object" || typeof from.address !== "string") return "missing from.address";
  if (from.name !== undefined && typeof from.name !== "string") return "from.name is not a string";
  if (typeof e.subject !== "string") return "missing subject";
  if (typeof e.date !== "number" || !Number.isFinite(e.date)) return "missing date";
  if (e.html !== undefined && typeof e.html !== "string") return "html is not a string";
  if (e.text !== undefined && typeof e.text !== "string") return "text is not a string";
  if (e.threadId !== undefined && typeof e.threadId !== "string") return "threadId is not a string";
  if (e.internetMessageId !== undefined && typeof e.internetMessageId !== "string") return "internetMessageId is not a string";
  if (e.jsonLd !== undefined && !Array.isArray(e.jsonLd)) return "jsonLd is not an array";
  if (e.authentication !== undefined && (e.authentication === null || typeof e.authentication !== "object")) return "authentication is not an object";
  if (e.forwarded !== undefined && e.forwarded !== "auto" && e.forwarded !== "manual") return "forwarded is not auto|manual";
  return undefined;
}

interface Unwrapped {
  readonly from: EmailAddress;
  readonly subject: string;
  readonly text: string;
  readonly manual: boolean;
}

const FORWARD_SUBJECT = /^\s*(?:(?:fwd?|fw|tr|wg|enc|rv|i)\s*:\s*)+/i;
const FORWARD_MARKER =
  /^(?:-{2,}\s*(?:forwarded message|mensagem encaminhada|weitergeleitete nachricht|message transféré|mensaje reenviado)\s*-{2,}|begin forwarded message:|-{3,}\s*original message\s*-{3,})\s*$/im;
const FORWARD_HEADER = /^(from|de|von|subject|assunto|betreff|objet|asunto|date|data|datum|to|para|an|à|cc)\s*:\s*(.*)$/i;

/**
 * A manual forward ("Fwd: Your Amazon.in order…") comes *from the user*; the
 * merchant is in the quoted header block. Recover the original sender and
 * subject and drop the header block (which holds the user's own address).
 * Such mail lost the merchant's DKIM signature, so confidence is capped.
 */
function unwrapForward(email: NormalizedEmail, text: string): Unwrapped {
  const isForward = email.forwarded === "manual" || FORWARD_SUBJECT.test(email.subject);
  if (!isForward) return { from: email.from, subject: email.subject, text, manual: false };
  const subject = email.subject.replace(FORWARD_SUBJECT, "").trim();
  const marker = FORWARD_MARKER.exec(text);
  if (!marker) return { from: email.from, subject, text, manual: true };

  const after = text.slice(marker.index + marker[0].length).split("\n");
  let from: EmailAddress | undefined;
  let originalSubject: string | undefined;
  let i = 0;
  for (; i < after.length && i < 10; i++) {
    const line = (after[i] ?? "").trim();
    if (line.length === 0) continue;
    const h = FORWARD_HEADER.exec(line);
    if (!h) break;
    const name = (h[1] ?? "").toLowerCase();
    if (["from", "de", "von"].includes(name)) from = parseAddressHeader((h[2] ?? "").replace(/\[mailto:[^\]]*\]/i, ""));
    if (["subject", "assunto", "betreff", "objet", "asunto"].includes(name)) originalSubject = (h[2] ?? "").trim();
  }
  return {
    from: from && from.address.includes("@") ? from : email.from,
    subject: originalSubject ?? subject,
    text: after.slice(i).join("\n"),
    manual: true,
  };
}

function cleanDisplayName(name: string): string {
  return name.replace(/^["']|["']$/g, "").replace(/\s+(?:via|por|über)\s+.+$/i, "").trim().slice(0, 60);
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

interface Trust {
  readonly factor: number;
  readonly cap: number;
}

/**
 * Without a verdict (an IMAP or forwarding transport that did not supply one)
 * or with a signature from some other domain (an email service provider), the
 * From address is only a claim. Research 06 ("Sender authentication gate"):
 * unauthenticated mail can only produce low confidence, so a spoofed "HDFC
 * Bank: ₹50,000 debited" can never reach alert-grade confidence.
 */
const UNVERIFIED_CAP = 0.7;

/**
 * Sender-trust gate (research 06 "Sender authentication gate"): a DMARC pass,
 * or a DKIM pass by the From domain (or its registry domain), keeps extraction
 * confidence; a failure caps it at 0.5 (possible spoof) and outranks
 * everything else; a manual forward lost the merchant's signature and is
 * capped at 0.6; anything unverified is capped at UNVERIFIED_CAP.
 */
function senderTrust(email: NormalizedEmail, sender: SenderMatch | undefined, manual: boolean): Trust {
  const auth = email.authentication;
  if (auth?.dkim === "fail" || auth?.dmarc === "fail") return { factor: 1, cap: 0.5 };
  if (manual) return { factor: 1, cap: 0.6 };
  const fromDomain = emailDomain(email.from.address);
  const d = auth?.dkim === "pass" ? auth.domain?.toLowerCase() : undefined;
  // Label-boundary matches only: "evilamazon.in" is not within "amazon.in".
  const dkimAligned = d !== undefined && (within(fromDomain, d) || within(d, fromDomain) || (sender !== undefined && within(d, sender.domain)));
  if (auth?.dmarc === "pass" || dkimAligned) return { factor: 1, cap: 1 };
  return { factor: sender?.addressKnown ? 0.98 : 0.9, cap: UNVERIFIED_CAP };
}

/** True when `child` is `parent` or one of its subdomains. */
function within(child: string, parent: string): boolean {
  return parent.length > 0 && parent.includes(".") && (child === parent || child.endsWith(`.${parent}`));
}

// ---------------------------------------------------------------------------
// Observation assembly
// ---------------------------------------------------------------------------

interface Formatter {
  money(m: Money): string;
  date(t: EpochMillis): string;
}

function formatter(actx: AdapterContext): Formatter {
  const locale = actx.locale ?? "en";
  let dateFmt: Intl.DateTimeFormat;
  try {
    dateFmt = new Intl.DateTimeFormat(actx.locale ?? "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: actx.timeZone ?? "UTC" });
  } catch {
    dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  return {
    money: (m) => {
      try {
        return formatMoney(m, locale);
      } catch {
        return formatMoney(m, "en");
      }
    },
    date: (t) => dateFmt.format(t),
  };
}

function providerName(f: EmailFinding, ctx: EmailContext): string | undefined {
  if (ctx.sender) return senderVariant(ctx.sender.info, ctx.subject).displayName;
  return ctx.senderName ?? f.merchant?.name;
}

interface Stamp {
  readonly id: string;
  readonly source: Omit<SourceRef, "provider">;
  readonly provider: string | undefined;
  readonly receivedAt: EpochMillis;
  readonly trust: Trust;
  readonly fmt: Formatter;
  readonly country?: string;
}

function toObservation(f: EmailFinding, s: Stamp): Observation {
  const { method: _method, label: _label, key: _key, matchedLine, detail: _detail, ...facts } = f;
  const confidence = round(Math.min(s.trust.cap, f.confidence * s.trust.factor));
  const amount = f.amount ? { ...f.amount, confidence: round(Math.min(s.trust.cap, f.amount.confidence * s.trust.factor)) } : undefined;
  // A P2P payee's line names a person: no excerpt for it.
  const excerptSource = f.counterparty ? undefined : matchedLine;
  const excerpt = excerptSource ? redactSensitive(normalizeWhitespace(stripLinks(excerptSource.replace(/\t/g, " ").replace(/(\d) \| /g, "$1 ")))).text.slice(0, EXCERPT_MAX) : undefined;
  return {
    ...facts,
    id: s.id,
    source: { ...s.source, ...(s.provider ? { provider: s.provider } : {}) },
    receivedAt: s.receivedAt,
    ...(amount ? { amount } : {}),
    ...(s.country ? { country: s.country } : {}),
    confidence,
    evidence: {
      summary: summarize(f, s.provider, s.fmt),
      ...(excerpt ? { excerpt, excerptExpiresAt: s.receivedAt + EXCERPT_TTL } : {}),
    },
  };
}

/**
 * Links in plain-text mail carry session tokens, tracking ids and the user's
 * address ("https://shop.example/o/88123?token=…&uid=…"): an excerpt keeps
 * none of them.
 */
const LINK = /\b(?:https?:\/\/|www\.)\S+|\bmailto:\S+|\b[\w-]+(?:\.[\w-]+)+\/\S+/gi;

function stripLinks(text: string): string {
  return text.replace(LINK, "[link]");
}

function round(p: number): number {
  return Math.round(p * 1000) / 1000;
}

const PERIOD_SUFFIX: Readonly<Record<string, string>> = { P1M: "/month", P1Y: "/year", P1W: "/week" };

/**
 * The plain-language evidence sentence, built only from extracted fields
 * (never from body text): "Amazon order confirmation email: 3 items, ₹4,799".
 */
function summarize(f: EmailFinding, provider: string | undefined, fmt: Formatter): string {
  const head = `${provider ?? "Merchant"} ${f.label} email`;
  const parts: string[] = [];
  const amount = f.amount ? fmt.money(f.amount.value) : undefined;
  const sub = f.subscription;
  switch (f.kind) {
    case "subscription_event": {
      const price = sub?.price ? `${fmt.money(sub.price)}${sub.period ? PERIOD_SUFFIX[sub.period] ?? "" : ""}` : undefined;
      if (sub?.event === "renewal_upcoming") {
        parts.push(["renews", sub.nextChargeAt ? fmt.date(sub.nextChargeAt) : undefined, price ? `for ${price}` : undefined].filter(Boolean).join(" "));
      } else if (sub?.event === "trial_ending") {
        parts.push(`free trial ends${sub.trialEndsAt ? ` ${fmt.date(sub.trialEndsAt)}` : ""}`);
        if (price) parts.push(`then ${price}`);
      } else if (sub?.event === "price_change") {
        if (sub.previousPrice && sub.price) parts.push(`${fmt.money(sub.previousPrice)} → ${price}`);
        else if (price) parts.push(`new price ${price}`);
        if (sub.nextChargeAt) parts.push(`from ${fmt.date(sub.nextChargeAt)}`);
      } else if (sub?.event === "charged") {
        if (amount) parts.push(`${amount} charged`);
        if (sub.nextChargeAt) parts.push(`renews ${fmt.date(sub.nextChargeAt)}`);
      } else if (sub?.event === "payment_failed") {
        parts.push(price ? `payment of ${price} failed` : "payment failed");
      } else if (sub?.event === "cancelled") {
        parts.push("subscription cancelled");
      } else if (sub?.event === "trial_started") {
        parts.push(`trial started${sub.trialEndsAt ? `, ends ${fmt.date(sub.trialEndsAt)}` : ""}`);
      } else if (price) {
        parts.push(price);
      }
      break;
    }
    case "money_movement": {
      if (amount) parts.push(`${amount} ${f.direction === "credit" ? "credited" : "debited"}${f.rail?.scheme ? ` (${f.rail.scheme.toUpperCase()})` : ""}`);
      if (f.merchant) parts.push(`${f.direction === "credit" ? "from" : "at"} ${f.merchant.name ?? f.merchant.raw}`);
      else if (f.counterparty) {
        const who = (f.counterparty.isMerchant ?? 1) <= 0.2 ? "a personal account" : "another account";
        parts.push(`${f.direction === "credit" ? "from" : "to"} ${who}`);
      }
      break;
    }
    case "refund_notice":
      parts.push([amount, "refund", f.detail].filter(Boolean).join(" "));
      break;
    case "delivery":
      parts.push(`order ${f.detail ?? "shipped"}`);
      break;
    case "booking":
      if (f.detail) parts.push(f.detail);
      if (amount) parts.push(amount);
      break;
    default: {
      const n = f.lineItems?.length ?? 0;
      if (n > 0) parts.push(`${n} item${n === 1 ? "" : "s"}`);
      if (amount) parts.push(amount);
      if (f.detail) parts.push(f.detail);
    }
  }
  const tail = parts.filter((p) => p.length > 0).join(", ");
  return tail ? `${head}: ${tail}` : head;
}
