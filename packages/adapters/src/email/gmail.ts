import { extractJsonLd } from "./html";
import type { EmailAddress, EmailAuthentication, NormalizedEmail } from "./model";
import { defaultTransactionalSenders } from "./senders";

/**
 * Gmail API (`users.messages.get?format=full`) -> NormalizedEmail.
 *
 * Field names mirror the Gmail API discovery document (rev. 20260727, see
 * docs/research/06-email-intelligence.md §1): `internalDate` is epoch-ms as a
 * decimal string and is "more reliable than the Date header"; bodies are
 * base64url in `payload.body.data` / `payload.parts[].body.data`, already
 * decoded from their Content-Transfer-Encoding but still in the part's charset.
 *
 * Decoding is implemented here (no Buffer/atob/TextDecoder) so the same code
 * runs on-device in a JS engine without Node or DOM globals.
 */

export interface GmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailMessagePartBody {
  readonly attachmentId?: string;
  readonly size?: number;
  /** base64url-encoded part body. */
  readonly data?: string;
}

export interface GmailMessagePart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: GmailMessagePartBody;
  readonly parts?: readonly GmailMessagePart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly historyId?: string;
  /** Epoch milliseconds as a decimal string (int64 in the API's JSON). */
  readonly internalDate?: string | number;
  readonly sizeEstimate?: number;
  readonly payload?: GmailMessagePart;
}

/** Convert a Gmail `format=full` message. Never throws on malformed parts; missing pieces are simply absent. */
export function fromGmailMessage(message: GmailMessage): NormalizedEmail {
  const headers = message.payload?.headers ?? [];
  const from = parseAddressHeader(headerValue(headers, "From") ?? "");
  const subject = decodeMimeWords(headerValue(headers, "Subject") ?? "").trim();
  const internal = Number(message.internalDate);
  const headerDate = Date.parse(headerValue(headers, "Date") ?? "");
  const date = Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(headerDate) ? headerDate : 0;

  const bodies: { html?: string; text?: string } = {};
  if (message.payload) collectBodies(message.payload, bodies);
  const jsonLd = bodies.html ? extractJsonLd(bodies.html) : [];
  const auth = parseAuthenticationResults(headerValue(headers, "Authentication-Results"));
  const internetMessageId = headerValue(headers, "Message-ID") ?? headerValue(headers, "Message-Id");

  return {
    messageId: message.id,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    from,
    subject,
    date,
    ...(bodies.text !== undefined ? { text: bodies.text } : {}),
    ...(bodies.html !== undefined ? { html: bodies.html } : {}),
    ...(headerValue(headers, "List-Unsubscribe") !== undefined ? { listUnsubscribe: true } : {}),
    ...(jsonLd.length > 0 ? { jsonLd } : {}),
    ...(internetMessageId ? { internetMessageId: internetMessageId.trim() } : {}),
    ...(auth ? { authentication: auth } : {}),
  };
}

/**
 * Depth-first walk keeping the first text/html and first text/plain part that
 * is not an attachment. multipart/alternative puts plain before html, so both
 * are collected and the adapter prefers html.
 */
function collectBodies(part: GmailMessagePart, out: { html?: string; text?: string }): void {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime.startsWith("multipart/")) {
    for (const child of part.parts ?? []) collectBodies(child, out);
    return;
  }
  const disposition = headerValue(part.headers ?? [], "Content-Disposition") ?? "";
  const isAttachment = (part.filename ?? "").length > 0 || /^\s*attachment/i.test(disposition);
  if (isAttachment || !part.body?.data) {
    for (const child of part.parts ?? []) collectBodies(child, out);
    return;
  }
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(headerValue(part.headers ?? [], "Content-Type") ?? "")?.[1];
  if (mime === "text/html" && out.html === undefined) out.html = decodeBytes(base64UrlToBytes(part.body.data), charset);
  else if (mime === "text/plain" && out.text === undefined) out.text = decodeBytes(base64UrlToBytes(part.body.data), charset);
}

// ---------------------------------------------------------------------------
// Narrow Gmail search query
// ---------------------------------------------------------------------------

export interface GmailQueryOptions {
  /** Sender addresses or domains to include; defaults to the transactional-sender data pack. */
  readonly senders?: readonly string[];
  /** Adds `newer_than:Nd` (incremental polling); omit for a bounded backfill driven by `after:`. */
  readonly newerThanDays?: number;
}

/** Subject terms that mark receipts, renewals, refunds and bank alerts across the launch languages. */
const SUBJECT_TERMS: readonly string[] = [
  "receipt",
  "order",
  "invoice",
  "renewal",
  "renews",
  "refund",
  "subscription",
  "trial",
  "booking",
  "reservation",
  "itinerary",
  '"payment received"',
  '"payment successful"',
  '"payment failed"',
  '"your trip"',
  '"price change"',
  "debited",
  "credited",
  "transaction",
  "pedido",
  "recibo",
  "fatura",
  "reembolso",
  "Bestellung",
  "Rechnung",
  "Erstattung",
];

/** OTP mail is excluded at query level: BRAKE should never even fetch it (research 06 §13i). */
const EXCLUDED_SUBJECTS: readonly string[] = ["OTP", '"one time password"', '"verification code"', '"security code"'];

/**
 * Builds the narrow Gmail `q` used with `users.messages.list`:
 *
 *   (category:purchases OR category:reservations OR from:(…) OR subject:(…))
 *   -category:(promotions OR social) -subject:(OTP OR …) newer_than:Nd
 *
 * Scope: `q` requires `https://www.googleapis.com/auth/gmail.readonly`. The
 * narrower-sounding `gmail.metadata` scope is equally *restricted* (same
 * verification and annual CASA assessment) yet cannot use `q` or
 * `format=full`, so it would force reading more of the mailbox, not less.
 * The query narrows what BRAKE fetches, never what the user granted: the
 * grant still covers the whole mailbox. That is why a per-user receipts
 * forwarding address is the narrowest option: no Google scope at all, and the
 * user's own filter decides, visibly, which senders BRAKE ever receives
 * (docs/research/06-email-intelligence.md §1, §3, §9, §17).
 */
export function gmailTransactionalQuery(opts: GmailQueryOptions = {}): string {
  const senders = dedupe((opts.senders ?? defaultTransactionalSenders()).map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(isQuerySafe));
  const include = ["category:purchases", "category:reservations"];
  if (senders.length > 0) include.push(`from:(${senders.join(" OR ")})`);
  include.push(`subject:(${SUBJECT_TERMS.join(" OR ")})`);
  const parts = [`(${include.join(" OR ")})`, "-category:(promotions OR social)", `-subject:(${EXCLUDED_SUBJECTS.join(" OR ")})`];
  if (opts.newerThanDays !== undefined && Number.isFinite(opts.newerThanDays) && opts.newerThanDays > 0) {
    parts.push(`newer_than:${Math.ceil(opts.newerThanDays)}d`);
  }
  return parts.join(" ");
}

/** Sender tokens are interpolated into a search string: only plain address/domain characters are allowed. */
function isQuerySafe(s: string): boolean {
  return /^[a-z0-9._%+-]+(?:@[a-z0-9.-]+)?$/.test(s) && s.includes(".");
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------
// RFC 5322 / MIME helpers (shared with outlook.ts and forwarding/IMAP sources)
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup; the first occurrence wins (the top-most header is the receiving provider's). */
export function headerValue(headers: readonly GmailHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** `"Amazon.in" <auto-confirm@amazon.in>`, `Netflix <info@account.netflix.com>`, `alerts@hdfcbank.net`. */
export function parseAddressHeader(value: string): EmailAddress {
  const decoded = decodeMimeWords(value).trim();
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(decoded);
  if (angle) {
    const name = (angle[1] ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { address: (angle[2] ?? "").toLowerCase(), ...(name ? { name } : {}) };
  }
  const bare = /([^\s<>"(),;]+@[^\s<>"(),;]+)/.exec(decoded);
  const comment = /\(([^)]+)\)/.exec(decoded)?.[1]?.trim();
  return { address: (bare?.[1] ?? decoded).toLowerCase(), ...(comment ? { name: comment } : {}) };
}

/**
 * Parse the top-most `Authentication-Results` value Gmail/Outlook prepend:
 * "mx.google.com; dkim=pass header.i=@amazon.in header.s=…; spf=pass …;
 * dmarc=pass (p=QUARANTINE …) header.from=amazon.in".
 */
export function parseAuthenticationResults(value: string | undefined): EmailAuthentication | undefined {
  if (!value) return undefined;
  const verdict = (method: string): "pass" | "fail" | "none" | undefined => {
    const m = new RegExp(`\\b${method}\\s*=\\s*(\\w+)`, "i").exec(value);
    if (!m) return undefined;
    const v = (m[1] ?? "").toLowerCase();
    return v === "pass" ? "pass" : v === "none" ? "none" : "fail";
  };
  const dkim = verdict("dkim");
  const dmarc = verdict("dmarc");
  const domain =
    /\bdkim\s*=\s*pass\b[^;]*?\bheader\.d\s*=\s*([a-z0-9.-]+)/i.exec(value)?.[1] ??
    /\bdkim\s*=\s*pass\b[^;]*?\bheader\.i\s*=\s*[^@\s;]*@([a-z0-9.-]+)/i.exec(value)?.[1];
  if (dkim === undefined && dmarc === undefined) return undefined;
  return {
    ...(dkim ? { dkim } : {}),
    ...(dmarc ? { dmarc } : {}),
    ...(domain && dkim === "pass" ? { domain: domain.toLowerCase() } : {}),
  };
}

/** Decode RFC 2047 encoded-words (`=?UTF-8?B?…?=`, `=?ISO-8859-1?Q?…?=`); plain text passes through. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, "$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_m, charset: string, enc: string, data: string) => {
      const bytes = enc.toLowerCase() === "b" ? base64UrlToBytes(data) : qEncodedToBytes(data);
      return decodeBytes(bytes, charset.replace(/\*.*$/, ""));
    });
}

function qEncodedToBytes(data: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9a-f]{2}$/i.test(data.slice(i + 1, i + 3))) {
      out.push(parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * base64url (and plain base64) -> bytes. Padding is optional, whitespace and
 * unknown characters are skipped, so malformed input degrades to garbage
 * text rather than an exception.
 */
export function base64UrlToBytes(data: string): number[] {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    let v: number;
    if (c === "-" || c === "+") v = 62;
    else if (c === "_" || c === "/") v = 63;
    else if (c === "=") break;
    else {
      v = B64.indexOf(c);
      if (v < 0) continue;
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** Windows-1252 code points for bytes 0x80–0x9F (curly quotes, €, …); everything else maps 1:1 to Latin-1. */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

/** Decode bytes in a declared charset: UTF-8 (default), US-ASCII, ISO-8859-1 and Windows-1252. Unknown charsets fall back to UTF-8. */
export function decodeBytes(bytes: readonly number[], charset?: string): string {
  const cs = (charset ?? "utf-8").toLowerCase().replace(/^"|"$/g, "");
  if (/^(iso-?8859-1|latin-?1|l1|us-ascii|ascii|windows-1252|cp1252)$/.test(cs)) {
    let s = "";
    // Mail labelled ISO-8859-1 is overwhelmingly Windows-1252 in practice (as WHATWG
    // Encoding treats it), so the C1 range is mapped for every single-byte label.
    for (const b of bytes) s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b);
    return s;
  }
  return utf8Decode(bytes);
}

/** Strict-enough UTF-8 decoder: invalid or truncated sequences become U+FFFD instead of throwing. */
export function utf8Decode(bytes: readonly number[]): string {
  const cps: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let need = 0;
    let cp = 0;
    let min = 0;
    if (b0 < 0x80) {
      cps.push(b0);
      i += 1;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      cps.push(0xfffd);
      i += 1;
      continue;
    }
    let ok = i + need < bytes.length;
    for (let k = 1; ok && k <= need; k++) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (b & 0x3f);
    }
    if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      cps.push(0xfffd);
      i += 1;
      continue;
    }
    cps.push(cp);
    i += need + 1;
  }
  let s = "";
  for (let k = 0; k < cps.length; k += 4096) s += String.fromCodePoint(...cps.slice(k, k + 4096));
  return s;
}
