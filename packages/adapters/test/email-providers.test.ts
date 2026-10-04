import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext } from "@brake/core";
import { createEmailAdapter } from "../src/email/adapter";
import { base64UrlToBytes, decodeBytes, decodeMimeWords, fromGmailMessage, gmailTransactionalQuery, parseAddressHeader, parseAuthenticationResults, utf8Decode } from "../src/email/gmail";
import type { GmailMessage } from "../src/email/gmail";
import { extractJsonLd, htmlToText } from "../src/email/html";
import { fromGraphMessage } from "../src/email/outlook";
import type { GraphMessage } from "../src/email/outlook";
import { classifyEmail, defaultTransactionalSenders, isLikelyTransactional, lookupSender, senderAllowed } from "../src/email/senders";

/**
 * Transport conversions. Message shapes mirror:
 *  - Gmail API users.messages.get format=full (discovery doc rev. 20260727: id, threadId, internalDate as
 *    an int64 string, payload.headers[], payload.body.data base64url, payload.parts[] recursive).
 *  - Microsoft Graph v1.0 message resource (receivedDateTime ISO-8601 UTC, body { contentType, content },
 *    from.emailAddress, conversationId, internetMessageId, optional internetMessageHeaders).
 * See docs/research/06-email-intelligence.md §1 and §6.
 */

const CTX_IN: AdapterContext = { clock: fixedClock(Date.UTC(2026, 9, 4, 5, 13)), country: "IN", locale: "en-IN", timeZone: "Asia/Kolkata" };
const CTX_US: AdapterContext = { clock: fixedClock(Date.UTC(2026, 9, 4, 5, 13)), country: "US", locale: "en-US", timeZone: "America/New_York" };

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

describe("htmlToText", () => {
  it("drops head/script/style and hidden preheaders, keeps rows as lines and cells as tabs", () => {
    const html = `<!doctype html><html><head><title>Receipt</title><style>td{color:red}</style><script>track()</script></head>
      <body><span style="display: none !important">Preheader teaser 50% off</span><!-- tracking -->
      <table><tr><td>Order Total:</td><td>&#8377;4,799.00</td></tr><tr><th>Item</th><th>Price</th></tr></table>
      <p>Line one<br>Line&nbsp;two</p><div>Fish &amp; Chips &euro;12,50 &mdash; &#x20B9;5 &quot;ok&quot;</div></body></html>`;
    expect(htmlToText(html)).toBe(["Order Total:\t₹4,799.00", "Item\tPrice", "Line one", "Line two", 'Fish & Chips €12,50 — ₹5 "ok"'].join("\n"));
  });

  it("removes zero-width characters and collapses whitespace", () => {
    expect(htmlToText("<p>Re​fund   of  ₹598</p>\n\n\n<p>  done </p>")).toBe("Refund of ₹598\ndone");
  });
});

describe("extractJsonLd", () => {
  it("parses objects, arrays and @graph, and skips invalid blocks", () => {
    const html = `
      <script type="application/ld+json">{"@type":"Order","orderNumber":"1"}</script>
      <script type='application/ld+json'>[{"@type":"ParcelDelivery"},{"@type":"Invoice"}]</script>
      <script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"FlightReservation","reservationNumber":"RXJ34P"}]}</script>
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json"><!-- {"@type":"EventReservation"} --></script>
      <script type="text/javascript">{"@type":"Order"}</script>`;
    const nodes = extractJsonLd(html) as Array<Record<string, unknown>>;
    expect(nodes.map((n) => n["@type"])).toEqual(["Order", "ParcelDelivery", "Invoice", "FlightReservation", "EventReservation"]);
  });

  it("recovers entity-escaped JSON", () => {
    const nodes = extractJsonLd(`<script type="application/ld+json">{&quot;@type&quot;:&quot;Order&quot;}</script>`);
    expect(nodes).toEqual([{ "@type": "Order" }]);
  });
});

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

const SWIGGY_HTML = `<html><body><table><tr><td>Order No: 167843923456</td></tr>
  <tr><td>Paneer Butter Masala x 1</td><td>&#8377;320.00</td></tr>
  <tr><td>Order Total</td><td>&#8377;320.00</td></tr><tr><td>Paid via UPI</td></tr></table>
  <p>Thanks for ordering 🍛</p></body></html>`;

const GMAIL_MESSAGE: GmailMessage = {
  id: "18c2f4a9b7e3d1aa",
  threadId: "18c2f4a9b7e3d100",
  labelIds: ["CATEGORY_UPDATES", "INBOX"],
  snippet: "Order No: 167843923456 Paneer Butter Masala…",
  historyId: "9876543",
  internalDate: String(Date.UTC(2026, 9, 4, 15, 1, 0)),
  sizeEstimate: 48213,
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@swiggy.in header.s=s1 header.b=AbCd; spf=pass (google.com: domain of noreply@swiggy.in designates 1.2.3.4 as permitted sender) smtp.mailfrom=noreply@swiggy.in; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=swiggy.in" },
      { name: "Authentication-Results", value: "spoofed.example; dkim=fail" },
      { name: "From", value: '"Swiggy" <NoReply@Swiggy.in>' },
      { name: "To", value: "kishan@example.com" },
      { name: "Subject", value: "=?UTF-8?B?" + Buffer.from("Your Swiggy order was delivered ✅", "utf8").toString("base64") + "?=" },
      { name: "Date", value: "Sun, 04 Oct 2026 20:31:00 +0530" },
      { name: "Message-ID", value: "<a1b2c3@mailer.swiggy.in>" },
      { name: "List-Unsubscribe", value: "<mailto:unsub@swiggy.in>" },
    ],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [{ name: "Content-Type", value: 'multipart/alternative; boundary="b1"' }],
        body: { size: 0 },
        parts: [
          { partId: "0.0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: 40, data: b64url("Order No: 167843923456\nOrder Total ₹320.00") } },
          { partId: "0.1", mimeType: "text/html", filename: "", headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }], body: { size: 400, data: b64url(SWIGGY_HTML) } },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' }],
        body: { size: 20113, attachmentId: "ANGjdJ8" },
      },
    ],
  },
};

describe("fromGmailMessage", () => {
  const email = fromGmailMessage(GMAIL_MESSAGE);

  it("decodes headers, internalDate and nested multipart bodies (html preferred, plain kept)", () => {
    expect(email.messageId).toBe("18c2f4a9b7e3d1aa");
    expect(email.threadId).toBe("18c2f4a9b7e3d100");
    expect(email.from).toEqual({ address: "noreply@swiggy.in", name: "Swiggy" });
    expect(email.subject).toBe("Your Swiggy order was delivered ✅");
    expect(email.date).toBe(Date.UTC(2026, 9, 4, 15, 1, 0));
    expect(email.html).toBe(SWIGGY_HTML);
    expect(email.text).toBe("Order No: 167843923456\nOrder Total ₹320.00");
    expect(email.listUnsubscribe).toBe(true);
    expect(email.internetMessageId).toBe("<a1b2c3@mailer.swiggy.in>");
  });

  it("trusts only the top-most Authentication-Results header", () => {
    expect(email.authentication).toEqual({ dkim: "pass", dmarc: "pass", domain: "swiggy.in" });
  });

  it("never carries recipients", () => {
    expect(JSON.stringify(email)).not.toContain("kishan@example.com");
  });

  it("feeds the adapter end to end", () => {
    const r = createEmailAdapter({ provider: "gmail" }).parse({ adapterId: "email", connectionId: "conn_gmail", receivedAt: email.date + 5_000, payload: email }, CTX_IN);
    expect(r.status).toBe("observations");
    if (r.status !== "observations") return;
    const obs = r.observations[0]!;
    expect(obs.amount?.value).toEqual(money(32_000, "INR"));
    expect(obs.lineItems?.[0]?.description).toBe("Paneer Butter Masala");
    expect(obs.confidence).toBeGreaterThanOrEqual(0.9);
    expect(obs.source.label).toBe("Gmail inbox");
  });

  it("falls back to the Date header and copes with a bare text/plain payload", () => {
    const plain = fromGmailMessage({
      id: "m2",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "from", value: "alerts@hdfcbank.net" },
          { name: "subject", value: "View: Account update for your HDFC Bank A/c" },
          { name: "date", value: "Sun, 08 Feb 2026 13:05:00 +0530" },
        ],
        body: { data: b64url("Rs.290.00 has been debited") },
      },
    });
    expect(plain.date).toBe(Date.UTC(2026, 1, 8, 7, 35, 0));
    expect(plain.from).toEqual({ address: "alerts@hdfcbank.net" });
    expect(plain.text).toBe("Rs.290.00 has been debited");
    expect(plain.html).toBeUndefined();
  });

  it("never throws on missing payloads", () => {
    expect(fromGmailMessage({ id: "m3" })).toEqual({ messageId: "m3", from: { address: "" }, subject: "", date: 0 });
  });
});

describe("MIME decoding", () => {
  it("decodes base64url with and without padding, including - and _", () => {
    const s = "₹4,799 — Café ✓ 🍛 ~?>";
    expect(utf8Decode(base64UrlToBytes(Buffer.from(s).toString("base64url")))).toBe(s);
    expect(utf8Decode(base64UrlToBytes(Buffer.from(s).toString("base64")))).toBe(s);
    expect(base64UrlToBytes("-_8")).toEqual([0xfb, 0xff]);
  });

  it("replaces invalid UTF-8 instead of throwing", () => {
    expect(utf8Decode([0x48, 0xc3, 0x28, 0xe2, 0x82])).toBe("H�(��");
  });

  it("decodes Windows-1252/Latin-1 parts and RFC 2047 words", () => {
    expect(decodeBytes([0x80, 0x20, 0x31, 0x32, 0x2c, 0x35, 0x30, 0x20, 0x93, 0x6f, 0x6b, 0x94, 0xe9], "windows-1252")).toBe("€ 12,50 “ok”é");
    expect(decodeMimeWords("=?ISO-8859-1?Q?Ihre_Bestellung_bei_Zalando_=FCber_89,95_=80?=")).toBe("Ihre Bestellung bei Zalando über 89,95 €");
    expect(decodeMimeWords("=?UTF-8?B?4oK5?= =?UTF-8?B?NDc5OQ==?= paid")).toBe("₹4799 paid");
  });

  it("parses From headers and Authentication-Results", () => {
    expect(parseAddressHeader('"Amazon.in" <auto-confirm@amazon.in>')).toEqual({ address: "auto-confirm@amazon.in", name: "Amazon.in" });
    expect(parseAddressHeader("no_reply@email.apple.com (Apple)")).toEqual({ address: "no_reply@email.apple.com", name: "Apple" });
    expect(parseAuthenticationResults("mx.google.com; dkim=pass header.d=amazon.in; dmarc=fail")).toEqual({ dkim: "pass", dmarc: "fail", domain: "amazon.in" });
    expect(parseAuthenticationResults("mx.google.com; spf=softfail")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

const GRAPH_MESSAGE: GraphMessage = {
  id: "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA=",
  conversationId: "AAQkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OAAQAMjLZG0p8YtIqaG4Nh1zN2E=",
  internetMessageId: "<20261004140000.7f3a@account.netflix.com>",
  receivedDateTime: "2026-10-04T14:00:00Z",
  sentDateTime: "2026-10-04T13:59:58Z",
  subject: "Your membership renews tomorrow",
  bodyPreview: "Just a reminder: your Netflix membership will renew on October 5, 2026 for $22.99.",
  body: { contentType: "html", content: "<html><body><p>Just a reminder: your Netflix membership will renew on October 5, 2026 for $22.99.</p></body></html>" },
  from: { emailAddress: { name: "Netflix", address: "Info@Account.Netflix.com" } },
  sender: { emailAddress: { name: "Netflix", address: "info@account.netflix.com" } },
  inferenceClassification: "focused",
  internetMessageHeaders: [
    { name: "Authentication-Results", value: "spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=account.netflix.com; dkim=pass (signature was verified) header.d=account.netflix.com;dmarc=pass action=none header.from=account.netflix.com" },
  ],
  webLink: "https://outlook.live.com/owa/?ItemID=AAMk…",
};

describe("fromGraphMessage", () => {
  it("converts the Graph message resource", () => {
    const email = fromGraphMessage(GRAPH_MESSAGE);
    expect(email).toMatchObject({
      messageId: GRAPH_MESSAGE.id,
      threadId: GRAPH_MESSAGE.conversationId,
      from: { address: "info@account.netflix.com", name: "Netflix" },
      subject: "Your membership renews tomorrow",
      date: Date.UTC(2026, 9, 4, 14, 0, 0),
      internetMessageId: "<20261004140000.7f3a@account.netflix.com>",
      authentication: { dkim: "pass", dmarc: "pass", domain: "account.netflix.com" },
    });
    expect(email.html).toContain("will renew on October 5, 2026");
    expect(email.text).toBeUndefined();
  });

  it("feeds the adapter with the Outlook provenance label", () => {
    const r = createEmailAdapter({ provider: "outlook" }).parse(
      { adapterId: "email", connectionId: "conn_outlook", receivedAt: Date.UTC(2026, 9, 4, 14, 0, 30), payload: fromGraphMessage(GRAPH_MESSAGE) },
      CTX_US,
    );
    expect(r.status).toBe("observations");
    if (r.status !== "observations") return;
    expect(r.observations[0]).toMatchObject({ kind: "subscription_event", source: { label: "Outlook inbox", provider: "Netflix" } });
    expect(r.observations[0]!.subscription?.price).toEqual(money(2_299, "USD"));
  });

  it("text bodies map to text; Mail.ReadBasic (no body) yields subject-only, low-confidence facts", () => {
    const textMsg = fromGraphMessage({ ...GRAPH_MESSAGE, body: { contentType: "text", content: "plain body" } });
    expect(textMsg.text).toBe("plain body");
    expect(textMsg.html).toBeUndefined();

    const basic = fromGraphMessage({
      id: "AAMk-basic",
      receivedDateTime: "2026-10-04T05:12:00Z",
      subject: "Your $45.12 transaction with STARBUCKS STORE 12345",
      from: { emailAddress: { name: "Chase", address: "no.reply.alerts@chase.com" } },
    });
    expect(basic.text).toBeUndefined();
    expect(basic.html).toBeUndefined();
    const r = createEmailAdapter({ provider: "outlook" }).parse({ adapterId: "email", connectionId: "conn_outlook", receivedAt: Date.UTC(2026, 9, 4, 5, 13), payload: basic }, CTX_US);
    expect(r.status).toBe("observations");
    if (r.status !== "observations") return;
    const obs = r.observations[0]!;
    expect(obs.kind).toBe("money_movement");
    expect(obs.amount?.value).toEqual(money(4_512, "USD"));
    expect(obs.confidence).toBeLessThanOrEqual(0.45);
    expect(obs.amount!.confidence).toBeLessThanOrEqual(0.5);
    expect(obs.lineItems).toBeUndefined();
  });

  it("never throws on sparse resources", () => {
    expect(fromGraphMessage({ id: "x", subject: null, from: null, body: null })).toEqual({ messageId: "x", from: { address: "" }, subject: "", date: 0 });
  });
});

// ---------------------------------------------------------------------------
// Query builder and sender knowledge
// ---------------------------------------------------------------------------

describe("gmailTransactionalQuery", () => {
  it("builds the narrow default query from the sender data pack", () => {
    const q = gmailTransactionalQuery({ newerThanDays: 2 });
    expect(q.startsWith("(category:purchases OR category:reservations OR from:(")).toBe(true);
    expect(q).toContain("auto-confirm@amazon.in");
    expect(q).toContain("order-update@amazon.com");
    expect(q).toContain("no_reply@email.apple.com");
    expect(q).toContain("googleplay-noreply@google.com");
    expect(q).toContain("alerts@hdfcbank.net".split("@")[1]!);
    expect(q).not.toContain("from:(google.com");
    expect(q).toContain('subject:(receipt OR order OR invoice OR renewal OR renews OR refund');
    expect(q).toContain('"payment received"');
    expect(q).toContain("-category:(promotions OR social)");
    expect(q).toContain('-subject:(OTP OR "one time password" OR "verification code" OR "security code")');
    expect(q.endsWith(" newer_than:2d")).toBe(true);
  });

  it("uses caller senders and drops anything that could inject query syntax", () => {
    const q = gmailTransactionalQuery({ senders: ["@Swiggy.in", "alerts@hdfcbank.net", "x) OR (in:anywhere", "noreply"] });
    expect(q).toBe(
      '(category:purchases OR category:reservations OR from:(swiggy.in OR alerts@hdfcbank.net) OR subject:(receipt OR order OR invoice OR renewal OR renews OR refund OR subscription OR trial OR booking OR reservation OR itinerary OR "payment received" OR "payment successful" OR "payment failed" OR "your trip" OR "price change" OR debited OR credited OR transaction OR pedido OR recibo OR fatura OR reembolso OR Bestellung OR Rechnung OR Erstattung)) -category:(promotions OR social) -subject:(OTP OR "one time password" OR "verification code" OR "security code")',
    );
  });
});

describe("sender knowledge", () => {
  it("resolves domains, subdomains and transactional local parts", () => {
    expect(lookupSender("auto-confirm@amazon.in")).toMatchObject({ domain: "amazon.in", addressKnown: true, info: { key: "amazon", role: "merchant", country: "IN" } });
    expect(lookupSender("store-news@amazon.in")).toMatchObject({ addressKnown: false });
    expect(lookupSender("noreply@nct.flipkart.com")?.info.key).toBe("flipkart");
    expect(lookupSender("alerts@hdfcbank.bank.in")?.info).toMatchObject({ key: "hdfc_bank", role: "bank" });
    expect(lookupSender("no_reply@email.apple.com")?.info.role).toBe("subscription");
    expect(lookupSender("news@insideapple.apple.com")).toBeUndefined();
    expect(lookupSender("todomundo@nubank.com.br")?.info).toMatchObject({ role: "bank", country: "BR" });
    expect(lookupSender("venmo@venmo.com")?.info.p2p).toBe(true);
    expect(lookupSender("someone@example.org")).toBeUndefined();
  });

  it("the default sender list prefers exact addresses where known", () => {
    const senders = defaultTransactionalSenders();
    expect(senders).toContain("auto-confirm@amazon.in");
    expect(senders).not.toContain("amazon.in");
    expect(senders).toContain("swiggy.in");
  });

  it("allow-lists match addresses, domains and subdomains", () => {
    expect(senderAllowed("noreply@nct.flipkart.com", ["flipkart.com"])).toBe(true);
    expect(senderAllowed("alerts@hdfcbank.net", ["@hdfcbank.net"])).toBe(true);
    expect(senderAllowed("alerts@hdfcbank.net", ["other@hdfcbank.net"])).toBe(false);
    expect(senderAllowed("x@evilflipkart.com", ["flipkart.com"])).toBe(false);
  });

  it("classifies transactional, promotional and personal mail", () => {
    const base = { messageId: "m", date: 0 };
    expect(isLikelyTransactional({ ...base, from: { address: "noreply@swiggy.in" }, subject: "Your Swiggy order receipt", text: "Order Total ₹320" })).toBe(true);
    expect(classifyEmail({ ...base, from: { address: "offers@swiggy.in" }, subject: "Flat 60% off on your next order!", listUnsubscribe: true })).toMatchObject({ transactional: false, reason: "promotional" });
    expect(classifyEmail({ ...base, from: { address: "mom@yahoo.co.in" }, subject: "Call me", text: "hi" })).toMatchObject({ transactional: false, reason: "not_financial" });
    // A List-Unsubscribe header alone does not make a real receipt promotional.
    expect(isLikelyTransactional({ ...base, from: { address: "info@account.netflix.com" }, subject: "Your membership renews tomorrow", listUnsubscribe: true, text: "will renew on October 5, 2026 for $22.99" })).toBe(true);
    // schema.org markup alone is enough.
    expect(isLikelyTransactional({ ...base, from: { address: "hello@tinyhotel.example" }, subject: "See you soon", jsonLd: [{ "@type": "LodgingReservation" }] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial review regressions
// ---------------------------------------------------------------------------

describe("review regressions: Authentication-Results parsing", () => {
  it("never reads a verdict out of a comment (Gmail's ARC summary), so a spoofer's ARC chain cannot turn dmarc=fail into pass", () => {
    // Gmail shape: arc=pass (i=1 spf=pass spfdomain=… dkim=pass dkdomain=… dmarc=pass fromdomain=…).
    const value =
      "mx.google.com; dkim=pass header.i=@sendgrid.net header.s=s1 header.b=Ab12; arc=pass (i=1 spf=pass spfdomain=evil.example dkim=pass dkdomain=amazon.in dmarc=pass fromdomain=amazon.in); spf=fail (google.com: domain of x@evil.example does not designate 1.2.3.4 as permitted sender) smtp.mailfrom=x@evil.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=amazon.in";
    expect(parseAuthenticationResults(value)).toEqual({ dkim: "pass", dmarc: "fail", domain: "sendgrid.net" });
  });

  it("with several DKIM signatures, reports the passing one aligned with header.from", () => {
    const value = "mx.google.com; dkim=pass header.i=@amazonses.com header.s=a; dkim=pass header.i=@amazon.in header.s=b; spf=pass smtp.mailfrom=x@amazonses.com; dmarc=pass (p=QUARANTINE) header.from=amazon.in";
    expect(parseAuthenticationResults(value)).toEqual({ dkim: "pass", dmarc: "pass", domain: "amazon.in" });
    // One stale failing signature next to a valid one is still a DKIM pass.
    expect(parseAuthenticationResults("mx.google.com; dkim=fail header.d=old.example; dkim=pass header.d=swiggy.in")?.dkim).toBe("pass");
  });

  it("maps no-evidence results (Microsoft bestguesspass, temperror, neutral) to none, not fail", () => {
    expect(parseAuthenticationResults("spf=pass smtp.mailfrom=shop.example; dkim=none (message not signed) header.d=none;dmarc=bestguesspass action=none header.from=shop.example")).toEqual({
      dkim: "none",
      dmarc: "none",
    });
    expect(parseAuthenticationResults("mx.example; dkim=temperror header.d=shop.example")).toEqual({ dkim: "none" });
  });
});

describe("review regressions: transports never throw on malformed JSON", () => {
  it("Gmail: non-array parts/headers, non-string values and absurd MIME nesting", () => {
    const loose = (m: unknown) => fromGmailMessage(m as GmailMessage);
    expect(() => loose({ id: "x", payload: { mimeType: "multipart/mixed", parts: {} } })).not.toThrow();
    expect(() => loose({ id: "x", payload: { headers: {} } })).not.toThrow();
    expect(() => loose({ id: "x", payload: { headers: [{ name: "From", value: 5 }, { name: 7, value: "x" }, null] } })).not.toThrow();
    expect(() => loose({ id: "x", payload: { mimeType: "text/plain", body: { data: 5 } } })).not.toThrow();
    expect(() => loose({ id: 5 })).not.toThrow();
    let part: unknown = { mimeType: "text/plain", body: { data: b64url("deep") } };
    for (let i = 0; i < 50_000; i++) part = { mimeType: "multipart/mixed", parts: [part] };
    const deep = loose({ id: "x", payload: part });
    expect(deep.text).toBeUndefined(); // beyond the nesting bound: ignored, not a stack overflow
  });

  it("Graph: non-string fields and non-array headers", () => {
    const weird = { id: "x", from: { emailAddress: { address: 5, name: 6 } }, body: { contentType: 5, content: 7 }, internetMessageHeaders: {}, subject: 5, internetMessageId: 5, conversationId: [] };
    expect(fromGraphMessage(weird as unknown as GraphMessage)).toEqual({ messageId: "x", from: { address: "" }, subject: "", date: 0 });
  });
});

describe("review regressions: HTML helpers are linear-time on hostile markup", () => {
  const timed = (f: () => unknown): number => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it("unclosed scripts, comments, hidden blocks and ld+json blocks do not go quadratic", () => {
    // Each of these took 1–11 s with per-tag lazy regexes ([\s\S]*?</script>) at this size.
    const n = 20_000;
    expect(timed(() => htmlToText('<div style="display:none">x'.repeat(n)))).toBeLessThan(500);
    expect(timed(() => htmlToText("<script>x".repeat(n)))).toBeLessThan(500);
    expect(timed(() => htmlToText("<!--x".repeat(n)))).toBeLessThan(500);
    expect(timed(() => htmlToText("<div".repeat(n)))).toBeLessThan(500);
    expect(timed(() => extractJsonLd('<script type="application/ld+json">{'.repeat(n)))).toBeLessThan(500);
  });

  it("keeps browser semantics: an unclosed script or comment hides the rest; a stray '<' is text", () => {
    expect(htmlToText("<p>Order Total ₹320</p><script>track(")).toBe("Order Total ₹320");
    expect(htmlToText("<p>Total ₹320</p><!-- unterminated <p>hidden</p>")).toBe("Total ₹320");
    expect(htmlToText("<p>Price < ₹500</p>")).toBe("Price");
    expect(htmlToText("<p>a</p><br class='x'><p>b</p>")).toBe("a\nb");
    expect(htmlToText('<svg viewBox="0 0 1 1"/><p>after svg</p>')).toBe("after svg");
  });
});
