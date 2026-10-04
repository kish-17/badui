import { decodeMimeWords, headerValue, parseAuthenticationResults } from "./gmail";
import { extractJsonLd } from "./html";
import type { NormalizedEmail } from "./model";

/**
 * Microsoft Graph `message` resource -> NormalizedEmail.
 *
 * Field names follow the Graph v1.0 `message` resource
 * (microsoft-graph-docs-contrib `api-reference/v1.0/resources/message.md`,
 * research 06 §6): `receivedDateTime` is UTC ISO-8601, `body` is
 * `{ contentType: "text" | "html", content }`, `internetMessageHeaders` is only
 * returned when explicitly `$select`ed.
 *
 * Under the narrower `Mail.ReadBasic` permission `body`/`bodyPreview` are
 * absent; the email then converts with no text at all and the adapter falls
 * back to subject-only, low-confidence extraction (research 06 §7).
 */

export interface GraphEmailAddress {
  readonly address?: string | null;
  readonly name?: string | null;
}

export interface GraphRecipient {
  readonly emailAddress?: GraphEmailAddress | null;
}

export interface GraphItemBody {
  /** Graph serialises the bodyType enum lower-case ("html" | "text"); be lenient about case. */
  readonly contentType?: string | null;
  readonly content?: string | null;
}

export interface GraphInternetMessageHeader {
  readonly name: string;
  readonly value: string;
}

export interface GraphMessage {
  readonly id: string;
  readonly conversationId?: string | null;
  readonly internetMessageId?: string | null;
  readonly receivedDateTime?: string | null;
  readonly sentDateTime?: string | null;
  readonly subject?: string | null;
  readonly from?: GraphRecipient | null;
  readonly sender?: GraphRecipient | null;
  readonly body?: GraphItemBody | null;
  readonly bodyPreview?: string | null;
  readonly internetMessageHeaders?: readonly GraphInternetMessageHeader[] | null;
  readonly inferenceClassification?: string | null;
  readonly categories?: readonly string[] | null;
  readonly webLink?: string | null;
}

/** Convert a Graph `message`. Never throws on sparse or malformed resources; missing pieces are simply absent. */
export function fromGraphMessage(message: GraphMessage): NormalizedEmail {
  const who = message.from?.emailAddress ?? message.sender?.emailAddress ?? {};
  const address = str(who.address).trim().toLowerCase();
  const name = str(who.name).trim();
  const received = Date.parse(str(message.receivedDateTime));
  const sent = Date.parse(str(message.sentDateTime));
  const date = Number.isFinite(received) ? received : Number.isFinite(sent) ? sent : 0;

  const content = typeof message.body?.content === "string" ? message.body.content : undefined;
  const isHtml = str(message.body?.contentType).toLowerCase() === "html";
  const html = content !== undefined && isHtml ? content : undefined;
  const text = content !== undefined && !isHtml ? content : undefined;
  const jsonLd = html ? extractJsonLd(html) : [];

  const headers = Array.isArray(message.internetMessageHeaders) ? message.internetMessageHeaders : [];
  const auth = parseAuthenticationResults(headerValue(headers, "Authentication-Results"));
  const listUnsubscribe = headerValue(headers, "List-Unsubscribe") !== undefined;
  const conversationId = str(message.conversationId);
  const internetMessageId = str(message.internetMessageId).trim();

  return {
    messageId: str(message.id),
    ...(conversationId ? { threadId: conversationId } : {}),
    from: { address, ...(name && name.toLowerCase() !== address ? { name } : {}) },
    subject: decodeMimeWords(str(message.subject)).trim(),
    date,
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(listUnsubscribe ? { listUnsubscribe: true } : {}),
    ...(jsonLd.length > 0 ? { jsonLd } : {}),
    ...(internetMessageId ? { internetMessageId } : {}),
    ...(auth ? { authentication: auth } : {}),
  };
}

/** Graph JSON is untyped at runtime: anything that is not a string reads as empty. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
