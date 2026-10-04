import { describe, expect, it } from "vitest";
import { DAY, fixedClock, money, zonedTimeToEpoch } from "@brake/core";
import type { AdapterContext, AdapterResult, Observation, RawSignal } from "@brake/core";
import { createEmailAdapter } from "../src/email/adapter";
import { extractJsonLd } from "../src/email/html";
import type { NormalizedEmail } from "../src/email/model";

/**
 * Fixtures are modelled on real templates where a source exists:
 *  - HDFC UPI alert: docs/research/06-email-intelligence.md §13a (2026 parser fixture, alerts@hdfcbank.net).
 *  - Amazon order ids NNN-NNNNNNN-NNNNNNN and the brief's ₹4,799 toothbrush/USB cable/dog food order (docs/brief.md).
 *  - Swiggy/Zomato senders noreply@swiggy.in / noreply@zomato.com (research 06 §13b).
 *  - Netflix "$22.99" renewal and price-change wording (docs/brief.md; research 06 §6 provenance example).
 *  - Booking.com LodgingReservation: Gmail Email Markup LodgingReservation example shape with schema.org
 *    properties (research 06 §14: reservationNumber/reservationId, reservationStatus, totalPrice, priceCurrency).
 *  - Uber trip receipt and Chase alert layouts (fare breakdown, "Visa ••••4242", "(...4321)") as described in research 06 §13b.
 * Personal details in fixtures (names, addresses, phone numbers) are fictitious and exist to prove they are dropped.
 */

const RECEIVED = Date.UTC(2026, 9, 4, 5, 12, 40);
const IN: AdapterContext = { clock: fixedClock(RECEIVED), country: "IN", locale: "en-IN", defaultCurrency: "INR", timeZone: "Asia/Kolkata" };
const US: AdapterContext = { clock: fixedClock(RECEIVED), country: "US", locale: "en-US", defaultCurrency: "USD", timeZone: "America/New_York" };
const DE: AdapterContext = { clock: fixedClock(RECEIVED), country: "DE", locale: "en-GB", defaultCurrency: "EUR", timeZone: "Europe/Berlin" };
const BR: AdapterContext = { clock: fixedClock(RECEIVED), country: "BR", locale: "pt-BR", defaultCurrency: "BRL", timeZone: "America/Sao_Paulo" };

const gmail = createEmailAdapter({ provider: "gmail" });

function signal(payload: NormalizedEmail, connectionId = "conn_gmail_1", receivedAt = RECEIVED): RawSignal<NormalizedEmail> {
  return { adapterId: "email", connectionId, receivedAt, payload };
}

function only(result: AdapterResult): Observation {
  expect(result.status).toBe("observations");
  if (result.status !== "observations") throw new Error(JSON.stringify(result));
  expect(result.observations).toHaveLength(1);
  return result.observations[0]!;
}

const DKIM_PASS = (domain: string) => ({ dkim: "pass" as const, dmarc: "pass" as const, domain });

// ---------------------------------------------------------------------------
// The brief's Amazon order
// ---------------------------------------------------------------------------

const AMAZON_ORDER_HTML = `<html><head><style>.hdr{font-weight:bold}</style><title>Amazon.in</title></head>
<body>
<div style="display:none;max-height:0;overflow:hidden">Your order of Philips Sonicare and 2 more items has been placed.</div>
<table>
<tr><td><h2>Order Confirmation</h2></td></tr>
<tr><td>Hello Kishan Abola,</td></tr>
<tr><td>Thank you for your order. We&rsquo;ll send a confirmation when your items ship.</td></tr>
<tr><td>Order #<a href="https://www.amazon.in/gp/css/summary?orderID=402-8473621-5530745">402-8473621-5530745</a></td></tr>
<tr><td>Placed on Sunday, 4 October 2026</td></tr>
<tr><td>Delivery to: Kishan Abola, 12 MG Road, Bengaluru, Karnataka 560001</td></tr>
</table>
<table>
<tr><td>Philips Sonicare Electric Toothbrush HX3681</td><td>Qty: 1</td><td>&#8377;2,999.00</td></tr>
<tr><td>Amazon Basics USB-C to USB-A Cable, 1.8 m</td><td>Qty: 2</td><td>&#8377;598.00</td></tr>
<tr><td>Pedigree Adult Dry Dog Food, Chicken &amp; Vegetables, 3 kg</td><td>Qty: 1</td><td>&#8377;1,152.00</td></tr>
</table>
<table>
<tr><td>Item Subtotal:</td><td>&#8377;4,749.00</td></tr>
<tr><td>Shipping &amp; Handling:</td><td>&#8377;50.00</td></tr>
<tr><td><b>Order Total:</b></td><td><b>&#8377;4,799.00</b></td></tr>
<tr><td>Paid by: HDFC Bank Credit Card ending in 4417</td></tr>
</table>
<p>Recommended for you</p>
<table><tr><td>Echo Dot (5th Gen)</td><td>&#8377;5,499.00</td></tr></table>
<p>&copy; 1996-2026, Amazon.com, Inc. or its affiliates</p>
</body></html>`;

const AMAZON_ORDER: NormalizedEmail = {
  messageId: "18c2f4a9b7e3d1aa",
  threadId: "18c2f4a9b7e3d1aa",
  from: { address: "auto-confirm@amazon.in", name: "Amazon.in" },
  subject: 'Your Amazon.in order of "Philips Sonicare Electric..." and 2 more items',
  date: Date.UTC(2026, 9, 4, 5, 12, 13), // 10:42:13 IST
  html: AMAZON_ORDER_HTML,
  internetMessageId: "<0100018c2f4a9b7e-amazon-in@email.amazonses.com>",
  authentication: DKIM_PASS("amazon.in"),
};

describe("email adapter: the brief's Amazon order", () => {
  const obs = only(gmail.parse(signal(AMAZON_ORDER), IN));

  it("extracts total, order id and the three line items with category hints", () => {
    expect(obs.kind).toBe("order");
    expect(obs.window).toBe("post_spend");
    expect(obs.stage).toBe("confirmed");
    expect(obs.direction).toBe("debit");
    expect(obs.amount?.value).toEqual(money(479_900, "INR"));
    expect(obs.references).toEqual([{ type: "order_id", value: "402-8473621-5530745", namespace: "amazon" }]);
    expect(obs.lineItems?.map((i) => i.description)).toEqual([
      "Philips Sonicare Electric Toothbrush HX3681",
      "Amazon Basics USB-C to USB-A Cable, 1.8 m",
      "Pedigree Adult Dry Dog Food, Chicken & Vegetables, 3 kg",
    ]);
    expect(obs.lineItems?.map((i) => i.categoryHints?.find((h) => h.scheme === "brake")?.value)).toEqual([
      "personal_care",
      "shopping.electronics",
      "pets",
    ]);
    expect(obs.lineItems?.[1]).toMatchObject({ quantity: 2, total: money(59_800, "INR") });
    expect(obs.amountBreakdown).toEqual([
      { kind: "subtotal", amount: money(474_900, "INR") },
      { kind: "shipping", amount: money(5_000, "INR") },
    ]);
  });

  it("names the merchant, provider, instrument and provenance", () => {
    expect(obs.merchant).toMatchObject({ raw: "Amazon", name: "Amazon", key: "amazon", website: "amazon.in", channel: "online" });
    expect(obs.source).toMatchObject({ adapterId: "email", kind: "email", connectionId: "conn_gmail_1", provider: "Amazon", label: "Gmail inbox" });
    expect(obs.instrument).toEqual({ type: "card", last4: "4417", cardKind: "credit" });
    expect(obs.rail).toEqual({ family: "card" });
    expect(obs.country).toBe("IN");
    expect(obs.evidence.summary).toBe("Amazon order confirmation email: 3 items, ₹4,799");
    expect(obs.categoryHints).toContainEqual({ scheme: "brake", value: "shopping.online_marketplace", confidence: 0.55 });
    expect(obs.typeHints?.[0]?.type).toBe("purchase");
  });

  it("sets honest confidence: templated + DKIM-aligned + items reconcile with the total", () => {
    expect(obs.confidence).toBeGreaterThanOrEqual(0.9);
    expect(obs.confidence).toBeLessThanOrEqual(0.97);
    expect(obs.amount?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(obs.occurredAt?.value).toBe(AMAZON_ORDER.date);
  });

  it("keeps only a redacted, expiring excerpt of the matched line and never the body", () => {
    expect(obs.evidence.excerpt).toBe("Order Total: ₹4,799.00");
    expect(obs.evidence.excerptExpiresAt).toBe(RECEIVED + 7 * DAY);
    const json = JSON.stringify(obs);
    for (const secret of ["Kishan", "MG Road", "560001", "Echo Dot", "Recommended", "Hello", "Thank you", "<td>", "display:none"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("is deterministic: re-delivery yields the same observation id", () => {
    const again = only(gmail.parse(signal(AMAZON_ORDER, "conn_gmail_1", RECEIVED + 60_000), IN));
    expect(again.id).toBe(obs.id);
    const other = only(gmail.parse(signal(AMAZON_ORDER, "conn_gmail_2"), IN));
    expect(other.id).not.toBe(obs.id);
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe("email adapter: subscription lifecycle", () => {
  it("Netflix renewal notice -> renewal_upcoming with nextChargeAt and $22.99 (pre-spend)", () => {
    const email: NormalizedEmail = {
      messageId: "msg-netflix-renew",
      from: { address: "info@account.netflix.com", name: "Netflix" },
      subject: "Your membership renews tomorrow",
      date: Date.UTC(2026, 9, 4, 14, 0, 0),
      html: `<p>Hi Kishan,</p><p>Just a reminder: your Netflix membership will renew on October 5, 2026 for $22.99.</p>
             <p>Plan: Premium</p><p>Payment method: Visa &bull;&bull;&bull;&bull; 4242</p>
             <p>Want to make changes? Visit your Account page. You can cancel anytime.</p>`,
    };
    const obs = only(gmail.parse(signal(email), US));
    expect(obs.kind).toBe("subscription_event");
    expect(obs.window).toBe("pre_spend");
    expect(obs.stage).toBe("intent");
    expect(obs.subscription).toEqual({
      event: "renewal_upcoming",
      serviceName: "Netflix",
      planName: "Premium",
      nextChargeAt: zonedTimeToEpoch({ year: 2026, month: 10, day: 5, hour: 12, minute: 0, second: 0 }, "America/New_York"),
      price: money(2_299, "USD"),
    });
    expect(obs.amount).toBeUndefined(); // no money has moved yet
    expect(obs.typeHints?.[0]).toMatchObject({ type: "subscription" });
    expect(obs.categoryHints).toContainEqual({ scheme: "brake", value: "entertainment.streaming", confidence: 0.8 });
    expect(obs.evidence.summary).toBe("Netflix renewal notice email: renews Oct 5, 2026 for $22.99");
    expect(obs.source.provider).toBe("Netflix");
  });

  it("Spotify trial ending -> trial_ending with trialEndsAt, price and monthly period (IN)", () => {
    const email: NormalizedEmail = {
      messageId: "msg-spotify-trial",
      from: { address: "no-reply@spotify.com", name: "Spotify" },
      subject: "Your Premium trial ends soon",
      date: Date.UTC(2026, 9, 5, 4, 30, 0),
      text: "Hi there,\nYour free trial of Spotify Premium ends on 12 October 2026.\nAfter that, you'll be charged ₹119/month unless you cancel before then.\nManage your plan anytime in your account.",
    };
    const obs = only(gmail.parse(signal(email), IN));
    const end = zonedTimeToEpoch({ year: 2026, month: 10, day: 12, hour: 12, minute: 0, second: 0 }, "Asia/Kolkata");
    expect(obs.subscription).toMatchObject({ event: "trial_ending", serviceName: "Spotify", trialEndsAt: end, nextChargeAt: end, price: money(11_900, "INR"), period: "P1M" });
    expect(obs.window).toBe("pre_spend");
    expect(obs.evidence.summary).toBe("Spotify trial-ending notice email: free trial ends 12 Oct 2026, then ₹119/month");
  });

  it("price change -> previousPrice, new price and effective date", () => {
    const email: NormalizedEmail = {
      messageId: "msg-netflix-price",
      from: { address: "info@account.netflix.com", name: "Netflix" },
      subject: "Important: your Netflix price is changing",
      date: Date.UTC(2026, 9, 4, 16, 0, 0),
      html: `<p>We're writing to let you know that your Standard plan price is changing from $15.49 to $17.99 per month, starting with your billing date on November 5, 2026.</p>`,
    };
    const obs = only(gmail.parse(signal(email), US));
    expect(obs.subscription).toMatchObject({
      event: "price_change",
      planName: "Standard",
      previousPrice: money(1_549, "USD"),
      price: money(1_799, "USD"),
      period: "P1M",
      nextChargeAt: zonedTimeToEpoch({ year: 2026, month: 11, day: 5, hour: 12, minute: 0, second: 0 }, "America/New_York"),
    });
    expect(obs.evidence.summary).toBe("Netflix price-change notice email: $15.49 → $17.99/month, from Nov 5, 2026");
  });

  it("reads 'will be $X (was $Y)' phrasing the other way round", () => {
    const email: NormalizedEmail = {
      messageId: "msg-spotify-price-uk",
      from: { address: "no-reply@spotify.com", name: "Spotify" },
      subject: "An update to your Premium price",
      date: Date.UTC(2026, 9, 4, 9, 0, 0),
      text: "We're updating our prices. From your next bill on 1 November 2026, Premium Individual will be £12.99/month (was £11.99/month).",
    };
    const obs = only(gmail.parse(signal(email), { clock: fixedClock(RECEIVED), country: "GB", timeZone: "Europe/London" }));
    expect(obs.subscription).toMatchObject({ event: "price_change", price: money(1_299, "GBP"), previousPrice: money(1_199, "GBP") });
  });

  it("subscription receipt -> charged event with amount (fusable) and next renewal", () => {
    const email: NormalizedEmail = {
      messageId: "msg-apple-receipt",
      from: { address: "no_reply@email.apple.com", name: "Apple" },
      subject: "Your receipt from Apple.",
      date: Date.UTC(2026, 9, 4, 3, 0, 0),
      html: `<table><tr><td>Apple Account: k•••@gmail.com</td></tr><tr><td>Order ID: MT4QX9Z7KL</td></tr>
        <tr><td>iCloud+ with 50 GB (Monthly)</td><td>&#8377;75.00</td></tr>
        <tr><td>Renews 4 November 2026</td></tr>
        <tr><td>TOTAL</td><td>&#8377;75.00</td></tr><tr><td>Paid with UPI</td></tr></table>`,
    };
    const obs = only(gmail.parse(signal(email), IN));
    expect(obs.kind).toBe("subscription_event");
    expect(obs.stage).toBe("confirmed");
    expect(obs.window).toBe("post_spend");
    expect(obs.amount?.value).toEqual(money(7_500, "INR"));
    expect(obs.subscription).toMatchObject({ event: "charged", serviceName: "Apple", price: money(7_500, "INR") });
    expect(obs.subscription?.nextChargeAt).toBe(zonedTimeToEpoch({ year: 2026, month: 11, day: 4, hour: 12, minute: 0, second: 0 }, "Asia/Kolkata"));
    expect(obs.lineItems?.[0]?.description).toBe("iCloud+ with 50 GB (Monthly)");
    expect(obs.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(JSON.stringify(obs)).not.toContain("gmail.com");
  });

  it("cancellation and payment-failed notices", () => {
    const cancelled = only(
      gmail.parse(
        signal({
          messageId: "msg-cancel",
          from: { address: "no-reply@spotify.com", name: "Spotify" },
          subject: "Your Premium subscription has been cancelled",
          date: Date.UTC(2026, 9, 4, 9, 0, 0),
          text: "Your Spotify Premium subscription has been cancelled. You'll keep Premium until 12 October 2026.",
        }),
        IN,
      ),
    );
    expect(cancelled.subscription?.event).toBe("cancelled");
    expect(cancelled.stage).toBe("cancelled");

    const failed = only(
      gmail.parse(
        signal({
          messageId: "msg-failed",
          from: { address: "info@account.netflix.com", name: "Netflix" },
          subject: "Your payment was declined",
          date: Date.UTC(2026, 9, 4, 9, 0, 0),
          text: "We couldn't process your payment of $22.99 for your Netflix membership. Please update your payment method.",
        }),
        US,
      ),
    );
    expect(failed.subscription).toMatchObject({ event: "payment_failed", price: money(2_299, "USD") });
    expect(failed.amount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

describe("email adapter: refunds", () => {
  it("Amazon refund -> refund_notice (credit) that shares the order reference with the original order", () => {
    const order = only(gmail.parse(signal(AMAZON_ORDER), IN));
    const refund = only(
      gmail.parse(
        signal({
          messageId: "msg-amazon-refund",
          from: { address: "return@amazon.in", name: "Amazon.in" },
          subject: "Your refund for Amazon Basics USB-C to USB-A Cable has been processed",
          date: Date.UTC(2026, 9, 9, 6, 0, 0),
          html: `<p>Hello Kishan,</p><p>We've processed your refund of &#8377;598.00 for order 402-8473621-5530745.</p>
                 <p>The refund will be credited to your HDFC Bank Credit Card ending in 4417 within 3-5 business days.</p>`,
        }),
        IN,
      ),
    );
    expect(refund.kind).toBe("refund_notice");
    expect(refund.direction).toBe("credit");
    expect(refund.stage).toBe("confirmed");
    expect(refund.amount?.value).toEqual(money(59_800, "INR"));
    expect(refund.references).toEqual(order.references);
    expect(refund.instrument).toMatchObject({ type: "card", last4: "4417" });
    expect(refund.typeHints?.[0]).toMatchObject({ type: "refund" });
    expect(refund.evidence.summary).toBe("Amazon refund email: ₹598 refund processed");
  });

  it("an initiated refund is pending", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-flipkart-refund",
          from: { address: "no-reply@flipkart.com", name: "Flipkart" },
          subject: "Refund initiated for your order",
          date: Date.UTC(2026, 9, 6, 6, 0, 0),
          text: "A refund of ₹1,249 has been initiated for your order OD432178965412300100.\nIt will reach your bank account in 5-7 days.",
        }),
        IN,
      ),
    );
    expect(obs.stage).toBe("pending");
    expect(obs.amount?.value).toEqual(money(124_900, "INR"));
    expect(obs.references).toEqual([{ type: "order_id", value: "OD432178965412300100", namespace: "flipkart" }]);
  });
});

// ---------------------------------------------------------------------------
// Food delivery, rides, marketplaces (IN / US / BR / DE)
// ---------------------------------------------------------------------------

describe("email adapter: receipts across countries", () => {
  it("Swiggy order receipt (INR) with fees, taxes and UPI", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-swiggy",
          from: { address: "noreply@swiggy.in", name: "Swiggy" },
          subject: "Your Swiggy order was delivered successfully",
          date: Date.UTC(2026, 9, 4, 15, 1, 0),
          html: `<table><tr><td>Order No: 167843923456</td></tr><tr><td>Meghana Foods</td></tr>
            <tr><td>Chicken Boneless Biryani x 2</td><td>&#8377;640.00</td></tr>
            <tr><td>Item Total</td><td>&#8377;640.00</td></tr>
            <tr><td>Delivery partner fee</td><td>&#8377;35.00</td></tr>
            <tr><td>Platform fee</td><td>&#8377;5.00</td></tr>
            <tr><td>Taxes</td><td>&#8377;33.25</td></tr>
            <tr><td>Order Total</td><td>&#8377;713.25</td></tr>
            <tr><td>Paid via UPI</td></tr></table>`,
        }),
        IN,
      ),
    );
    expect(obs.kind).toBe("order");
    expect(obs.amount?.value).toEqual(money(71_325, "INR"));
    expect(obs.references).toEqual([{ type: "order_id", value: "167843923456", namespace: "swiggy" }]);
    expect(obs.lineItems).toEqual([
      {
        description: "Chicken Boneless Biryani",
        quantity: 2,
        total: money(64_000, "INR"),
        categoryHints: [
          { scheme: "brake", value: "eating_out", confidence: 0.8 },
          { scheme: "keyword", value: "biryani", confidence: 0.8 },
        ],
      },
    ]);
    expect(obs.amountBreakdown?.map((c) => c.kind)).toEqual(["subtotal", "shipping", "fee", "tax"]);
    expect(obs.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(obs.categoryHints?.[0]).toMatchObject({ scheme: "brake", value: "eating_out.delivery" });
    expect(obs.evidence.summary).toBe("Swiggy order confirmation email: 1 item, ₹713.25");
  });

  it("Zomato plain-text receipt (INR) paid from a wallet", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-zomato",
          from: { address: "noreply@zomato.com", name: "Zomato" },
          subject: "Your Zomato order from Burger King",
          date: Date.UTC(2026, 9, 3, 14, 20, 0),
          text: [
            "Order ID: 5678901234",
            "Burger King, Indiranagar",
            "Whopper Meal x 1      ₹329.00",
            "Fries (Medium) x 1    ₹119.00",
            "Taxes                 ₹22.40",
            "Delivery charge       ₹30.00",
            "Grand Total           ₹500.40",
            "Paid using Zomato Money",
          ].join("\n"),
        }),
        IN,
      ),
    );
    expect(obs.amount?.value).toEqual(money(50_040, "INR"));
    expect(obs.lineItems?.map((i) => [i.description, i.quantity, i.total?.minor])).toEqual([
      ["Whopper Meal", 1, 32_900],
      ["Fries (Medium)", 1, 11_900],
    ]);
    expect(obs.rail).toEqual({ family: "wallet" });
    expect(obs.references[0]).toEqual({ type: "order_id", value: "5678901234", namespace: "zomato" });
  });

  it("Uber trip receipt (USD): fare breakdown, card last4, no route or driver", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-uber",
          from: { address: "noreply@uber.com", name: "Uber Receipts" },
          subject: "Your Saturday evening trip with Uber",
          date: Date.UTC(2026, 9, 4, 0, 20, 0),
          html: `<table>
            <tr><td>Total</td><td>$23.45</td></tr><tr><td>October 3, 2026</td></tr>
            <tr><td>Thanks for riding, Kishan</td></tr>
            <tr><td>Trip fare</td><td>$18.12</td></tr><tr><td>Subtotal</td><td>$18.12</td></tr>
            <tr><td>Booking Fee</td><td>$2.33</td></tr><tr><td>Tip</td><td>$3.00</td></tr>
            <tr><td>Payments</td></tr><tr><td>Visa &bull;&bull;&bull;&bull;4242</td><td>$23.45</td></tr>
            <tr><td>You rode with Marcus</td></tr><tr><td>UberX 4.2 miles | 16 min</td></tr>
            <tr><td>8:01 PM</td><td>1455 Market St, San Francisco, CA</td></tr>
            <tr><td>8:17 PM</td><td>500 Castro St, San Francisco, CA</td></tr></table>`,
        }),
        US,
      ),
    );
    expect(obs.kind).toBe("receipt");
    expect(obs.amount?.value).toEqual(money(2_345, "USD"));
    expect(obs.amountBreakdown).toEqual([
      { kind: "subtotal", amount: money(1_812, "USD") },
      { kind: "fee", amount: money(233, "USD") },
      { kind: "tip", amount: money(300, "USD") },
    ]);
    expect(obs.instrument).toEqual({ type: "card", network: "visa", last4: "4242" });
    expect(obs.rail).toEqual({ family: "card", scheme: "visa" });
    expect(obs.lineItems).toBeUndefined();
    expect(obs.merchant).toMatchObject({ key: "uber", mcc: "4121" });
    expect(obs.categoryHints).toContainEqual({ scheme: "brake", value: "transport.rideshare", confidence: 0.8 });
    expect(obs.categoryHints).toContainEqual({ scheme: "mcc", value: "4121", confidence: 0.85 });
    const json = JSON.stringify(obs);
    for (const s of ["Market St", "Castro", "Marcus", "Kishan", "San Francisco"]) expect(json).not.toContain(s);
  });

  it("Uber Eats receipts resolve to the Uber Eats variant and food-delivery category", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-ubereats",
          from: { address: "noreply@uber.com", name: "Uber Receipts" },
          subject: "Your Uber Eats order from Chipotle",
          date: Date.UTC(2026, 9, 4, 0, 20, 0),
          text: "Total $18.40\nBurrito Bowl $11.25\nChips & Guac $4.65\nDelivery Fee $0.49\nService Fee $2.01\nVisa ••••4242",
        }),
        US,
      ),
    );
    expect(obs.merchant).toMatchObject({ key: "uber_eats", name: "Uber Eats" });
    expect(obs.source.provider).toBe("Uber Eats");
    expect(obs.categoryHints?.[0]).toMatchObject({ value: "eating_out.delivery" });
    expect(obs.lineItems?.map((i) => i.description)).toEqual(["Burrito Bowl", "Chips & Guac"]);
  });

  it("Mercado Livre order (BRL, comma decimals, Pix)", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-meli",
          from: { address: "noreply@mercadolivre.com.br", name: "Mercado Livre" },
          subject: "Você comprou Fone de Ouvido JBL Tune 520BT",
          date: Date.UTC(2026, 9, 4, 13, 0, 0),
          html: `<table><tr><td>Pedido #2000004567891234</td></tr>
            <tr><td>Fone de Ouvido JBL Tune 520BT</td><td>1 unidade</td><td>R$ 279,90</td></tr>
            <tr><td>Frete</td><td>R$ 19,90</td></tr>
            <tr><td>Valor total</td><td>R$ 299,80</td></tr>
            <tr><td>Pagamento: Pix</td></tr></table>`,
        }),
        BR,
      ),
    );
    expect(obs.amount?.value).toEqual(money(29_980, "BRL"));
    expect(obs.references).toEqual([{ type: "order_id", value: "2000004567891234", namespace: "mercado_livre" }]);
    expect(obs.lineItems?.[0]).toMatchObject({ description: "Fone de Ouvido JBL Tune 520BT", quantity: 1, total: money(27_990, "BRL") });
    expect(obs.lineItems?.[0]?.categoryHints?.[0]?.value).toBe("shopping.electronics");
    expect(obs.rail).toEqual({ family: "account_to_account_instant", scheme: "pix" });
    expect(obs.country).toBe("BR");
  });

  it("Zalando order (EUR, German labels)", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-zalando",
          from: { address: "info@service-mail.zalando.de", name: "Zalando" },
          subject: "Deine Bestellung bei Zalando",
          date: Date.UTC(2026, 9, 4, 8, 0, 0),
          text: "Bestellnummer: 10101234567890\nNike Air Max sneakers\t1 Stück\t89,95 €\nVersandkosten\t0,00 €\nGesamtbetrag\t89,95 €\nZahlungsart: PayPal",
        }),
        DE,
      ),
    );
    expect(obs.amount?.value).toEqual(money(8_995, "EUR"));
    expect(obs.references[0]).toEqual({ type: "order_id", value: "10101234567890", namespace: "zalando" });
    expect(obs.lineItems?.[0]?.categoryHints?.[0]?.value).toBe("shopping.clothing");
    expect(obs.rail).toEqual({ family: "wallet", scheme: "paypal" });
  });

  it("cash-on-delivery orders are pending, not confirmed", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-flipkart-cod",
          from: { address: "no-reply@flipkart.com", name: "Flipkart" },
          subject: "Your Flipkart order has been placed",
          date: Date.UTC(2026, 9, 4, 8, 0, 0),
          text: "Order ID OD332178965412300100\nboAt Rockerz 450 Bluetooth Headphones ₹1,499\nOrder Total ₹1,499\nPayment mode: Cash on Delivery",
        }),
        IN,
      ),
    );
    expect(obs.stage).toBe("pending");
    expect(obs.rail).toEqual({ family: "cash" });
  });

  it("shipping updates without totals become delivery observations that join by order id", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-amazon-ship",
          from: { address: "shipment-tracking@amazon.in", name: "Amazon.in" },
          subject: "Your Amazon.in order #402-8473621-5530745 has been shipped",
          date: Date.UTC(2026, 9, 5, 5, 0, 0),
          text: "Your package is on the way.\nOrder #402-8473621-5530745\nArriving Tuesday",
        }),
        IN,
      ),
    );
    expect(obs.kind).toBe("delivery");
    expect(obs.amount).toBeUndefined();
    expect(obs.direction).toBeUndefined();
    expect(obs.references).toEqual([{ type: "order_id", value: "402-8473621-5530745", namespace: "amazon" }]);
    expect(obs.evidence.summary).toBe("Amazon delivery update email: order shipped");
  });

  it("health items are reduced to a category label by default", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-pharmacy",
          from: { address: "auto-confirm@amazon.in", name: "Amazon.in" },
          subject: "Your Amazon.in order of Dolo 650 Tablet",
          date: Date.UTC(2026, 9, 4, 8, 0, 0),
          text: "Order #403-1112223-4445556\nDolo 650mg Tablet strip of 15\tQty: 1\t₹30.91\nOrder Total:\t₹30.91",
        }),
        IN,
      ),
    );
    expect(obs.lineItems?.[0]).toMatchObject({ description: "Health item", categoryHints: [{ scheme: "brake", value: "health", confidence: 0.8 }] });
    expect(JSON.stringify(obs)).not.toContain("Dolo");
  });
});

// ---------------------------------------------------------------------------
// Bank alert emails
// ---------------------------------------------------------------------------

describe("email adapter: bank alert emails", () => {
  it("HDFC UPI debit email: amount, last4, UPI RRN; the person paid is never named", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-hdfc-upi",
          from: { address: "alerts@hdfcbank.net", name: "HDFC Bank InstaAlerts" },
          subject: "❗ You have done a UPI txn. Check details!",
          date: Date.UTC(2026, 1, 8, 7, 35, 0),
          html: `Dear Customer,<br><br>Rs.290.00 has been debited from account 9212 to VPA 9611653384@axl BABA FAKRUDDIN on 08-02-26.<br><br>
                 Your UPI transaction reference number is 603927536719.<br><br>
                 If you did not authorize this transaction, please report it immediately by calling 18002586161 or SMS BLOCK UPI to 7308080808.<br><br>Warm Regards,<br>HDFC Bank`,
          authentication: DKIM_PASS("hdfcbank.net"),
        }),
        IN,
      ),
    );
    expect(obs.kind).toBe("money_movement");
    expect(obs.direction).toBe("debit");
    expect(obs.stage).toBe("confirmed");
    expect(obs.amount?.value).toEqual(money(29_000, "INR"));
    expect(obs.instrument).toEqual({ type: "bank_account", issuer: "HDFC Bank", last4: "9212" });
    expect(obs.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(obs.references).toEqual([{ type: "rail_reference", value: "603927536719", namespace: "upi" }]);
    expect(obs.counterparty).toEqual({ handle: "••••3384@axl", isMerchant: 0.2 });
    expect(obs.merchant).toBeUndefined();
    expect(obs.typeHints?.[0]).toMatchObject({ type: "transfer", transferKind: "p2p_other" });
    expect(obs.occurredAt?.value).toBe(Date.UTC(2026, 1, 8, 7, 35, 0));
    expect(obs.confidence).toBeGreaterThanOrEqual(0.93);
    expect(obs.source).toMatchObject({ provider: "HDFC Bank", label: "Gmail inbox" });
    expect(obs.evidence.summary).toBe("HDFC Bank transaction alert email: ₹290 debited (UPI), to a personal account");
    expect(obs.evidence.excerpt).toBeUndefined();
    const json = JSON.stringify(obs);
    for (const s of ["BABA", "FAKRUDDIN", "9611653384", "18002586161", "Dear Customer"]) expect(json).not.toContain(s);
  });

  it("Chase card alert (US): labelled merchant, masked card, local time", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-chase",
          from: { address: "no.reply.alerts@chase.com", name: "Chase" },
          subject: "Your $45.12 transaction with STARBUCKS STORE 12345",
          date: Date.UTC(2026, 9, 4, 12, 16, 0),
          html: `<p>You made a credit card transaction that exceeds your alert setting.</p><table>
            <tr><td>Account</td><td>Chase Sapphire Preferred (...4321)</td></tr>
            <tr><td>Date</td><td>Oct 4, 2026 at 8:15 AM ET</td></tr>
            <tr><td>Merchant</td><td>STARBUCKS STORE 12345</td></tr>
            <tr><td>Amount</td><td>$45.12</td></tr></table>`,
        }),
        US,
      ),
    );
    expect(obs.amount?.value).toEqual(money(4_512, "USD"));
    expect(obs.merchant).toMatchObject({ raw: "STARBUCKS STORE 12345" });
    expect(obs.instrument).toEqual({ type: "card", issuer: "Chase", last4: "4321", cardKind: "credit" });
    expect(obs.rail).toEqual({ family: "card" });
    expect(obs.occurredAt).toEqual({ value: Date.UTC(2026, 9, 4, 12, 15, 0), confidence: 0.9 });
    expect(obs.evidence.summary).toBe("Chase transaction alert email: $45.12 debited, at STARBUCKS STORE 12345");
  });

  it("India e-mandate pre-debit notice -> upcoming debit (pre-spend) with mandate reference", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-icici-predebit",
          from: { address: "credit_cards@icicibank.com", name: "ICICI Bank" },
          subject: "Pre-debit notification for your recurring payment",
          date: Date.UTC(2026, 9, 4, 4, 0, 0),
          text: "Dear Customer, INR 649.00 will be debited from your ICICI Bank Credit Card XX5521 on 05-10-2026 towards NETFLIX for your e-mandate. E-mandate reference: SIHDF1234567890. To opt out, visit the e-mandate portal.",
        }),
        IN,
      ),
    );
    expect(obs.kind).toBe("subscription_event");
    expect(obs.window).toBe("pre_spend");
    expect(obs.subscription).toMatchObject({
      event: "renewal_upcoming",
      serviceName: "NETFLIX",
      price: money(64_900, "INR"),
      nextChargeAt: zonedTimeToEpoch({ year: 2026, month: 10, day: 5, hour: 12, minute: 0, second: 0 }, "Asia/Kolkata"),
    });
    expect(obs.references).toEqual([{ type: "mandate_id", value: "SIHDF1234567890", namespace: "icici_bank" }]);
    expect(obs.instrument).toMatchObject({ type: "card", issuer: "ICICI Bank", last4: "5521" });
  });
});

// ---------------------------------------------------------------------------
// schema.org markup
// ---------------------------------------------------------------------------

const BOOKING_HTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "http://schema.org",
  "@type": "LodgingReservation",
  "reservationNumber": "4012345678",
  "reservationStatus": "http://schema.org/ReservationConfirmed",
  "underName": { "@type": "Person", "name": "John Smith" },
  "reservationFor": {
    "@type": "LodgingBusiness",
    "name": "Hotel Adlon Kempinski",
    "address": { "@type": "PostalAddress", "streetAddress": "Unter den Linden 77", "addressLocality": "Berlin", "postalCode": "10117", "addressCountry": "DE" },
    "telephone": "+49 30 22610"
  },
  "checkinDate": "2026-11-12T15:00:00+01:00",
  "checkoutDate": "2026-11-14T12:00:00+01:00",
  "totalPrice": "389.00",
  "priceCurrency": "EUR",
  "bookingAgent": { "@type": "Organization", "name": "Booking.com", "url": "https://www.booking.com" }
}
</script></head><body>
<p>Thanks, John! Your booking in Berlin is confirmed.</p>
<table><tr><td>Booking number:</td><td>4012345678</td></tr><tr><td>PIN code:</td><td>6789</td></tr>
<tr><td>Total price</td><td>&euro; 389</td></tr></table></body></html>`;

describe("email adapter: schema.org JSON-LD", () => {
  it("Booking.com LodgingReservation -> booking with booking_ref, hotel and EUR total; guest data dropped", () => {
    const email: NormalizedEmail = {
      messageId: "msg-booking",
      from: { address: "noreply@booking.com", name: "Booking.com" },
      subject: "Your booking is confirmed at Hotel Adlon Kempinski",
      date: Date.UTC(2026, 9, 4, 10, 0, 0),
      html: BOOKING_HTML,
    };
    const obs = only(gmail.parse(signal(email), DE));
    expect(obs.kind).toBe("booking");
    expect(obs.stage).toBe("confirmed");
    expect(obs.window).toBe("post_spend");
    expect(obs.amount).toEqual({ value: money(38_900, "EUR"), confidence: expect.any(Number) });
    expect(obs.amount!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(obs.references).toEqual([{ type: "booking_ref", value: "4012345678", namespace: "booking" }]);
    expect(obs.merchant).toMatchObject({ raw: "Hotel Adlon Kempinski", name: "Hotel Adlon Kempinski" });
    expect(obs.categoryHints).toEqual([{ scheme: "brake", value: "travel.lodging", confidence: 0.85 }]);
    expect(obs.source.provider).toBe("Booking.com");
    expect(obs.evidence.summary).toBe("Booking.com reservation email: Hotel Adlon Kempinski, check-in 12 Nov 2026, €389");
    const json = JSON.stringify(obs);
    for (const s of ["John", "Smith", "Unter den Linden", "10117", "22610", "6789"]) expect(json).not.toContain(s);
  });

  it("schema.org Order with acceptedOffer items wins over heuristics", () => {
    const html = `<script type="application/ld+json">[{
      "@context": "http://schema.org", "@type": "Order",
      "merchant": { "@type": "Organization", "name": "Amazon.com" },
      "orderNumber": "112-5591234-1234567",
      "orderStatus": "http://schema.org/OrderProcessing",
      "priceCurrency": "USD", "price": "39.98",
      "acceptedOffer": [
        { "@type": "Offer", "itemOffered": { "@type": "Product", "name": "Google Chromecast", "sku": "B00DR0PDNE" }, "price": "29.99", "priceCurrency": "USD", "eligibleQuantity": { "@type": "QuantitativeValue", "value": "1" } },
        { "@type": "Offer", "itemOffered": { "@type": "Product", "name": "HDMI Cable 6ft" }, "price": "9.99", "priceCurrency": "USD", "eligibleQuantity": { "@type": "QuantitativeValue", "value": "1" } }
      ],
      "customer": { "@type": "Person", "name": "Jane Doe" }
    }]</script><p>Order total: $39.98</p>`;
    const obs = only(
      gmail.parse(
        signal({ messageId: "msg-ld-order", from: { address: "auto-confirm@amazon.com", name: "Amazon.com" }, subject: "Your Amazon.com order #112-5591234-1234567", date: Date.UTC(2026, 9, 4, 1, 0, 0), html, jsonLd: extractJsonLd(html) }),
        US,
      ),
    );
    expect(obs.amount?.value).toEqual(money(3_998, "USD"));
    expect(obs.references).toEqual([{ type: "order_id", value: "112-5591234-1234567", namespace: "amazon" }]);
    expect(obs.lineItems?.map((i) => [i.description, i.unitPrice?.minor, i.productId])).toEqual([
      ["Google Chromecast", 2_999, "B00DR0PDNE"],
      ["HDMI Cable 6ft", 999, undefined],
    ]);
    expect(obs.merchant).toMatchObject({ key: "amazon", raw: "Amazon.com" });
    expect(JSON.stringify(obs)).not.toContain("Jane");
  });

  it("markup totals that are not in the visible text lose confidence", () => {
    const html = `<script type="application/ld+json">{"@type":"Order","orderNumber":"A-1001","price":"99.00","priceCurrency":"USD","merchant":{"name":"Acme Outdoor"}}</script><p>Your order A-1001 is confirmed. Total: $79.00</p>`;
    const obs = only(gmail.parse(signal({ messageId: "msg-stale-ld", from: { address: "orders@acme-outdoor.com", name: "Acme Outdoor" }, subject: "Order A-1001 confirmed", date: Date.UTC(2026, 9, 4), html }), US));
    expect(obs.amount?.confidence).toBeLessThanOrEqual(0.8);
    expect(obs.merchant).toMatchObject({ raw: "Acme Outdoor", key: "acme_outdoor" });
  });

  it("an unpaid restaurant reservation is a pre-spend intent", () => {
    const html = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"FoodEstablishmentReservation","reservationNumber":"OT-88213","reservationStatus":"http://schema.org/ReservationConfirmed","underName":{"@type":"Person","name":"Kishan"},"reservationFor":{"@type":"FoodEstablishment","name":"Indian Accent"},"startTime":"2026-10-10T20:00:00+05:30","partySize":"2"}</script><p>Table for 2 confirmed.</p>`;
    const obs = only(gmail.parse(signal({ messageId: "msg-table", from: { address: "reservations@opentable.com", name: "OpenTable" }, subject: "Your reservation is confirmed", date: Date.UTC(2026, 9, 4), html }), IN));
    expect(obs).toMatchObject({ kind: "booking", window: "pre_spend", stage: "intent" });
    expect(obs.merchant?.raw).toBe("Indian Accent");
    expect(obs.categoryHints?.[0]?.value).toBe("eating_out.restaurant");
    expect(obs.amount).toBeUndefined();
  });

  it("an Order plus its ParcelDelivery produce order and delivery observations", () => {
    const html = `<script type="application/ld+json">{"@context":"http://schema.org","@graph":[
      {"@type":"ParcelDelivery","partOfOrder":{"@type":"Order","orderNumber":"OD99887766554433221","merchant":{"name":"Flipkart"}},"deliveryStatus":"http://schema.org/OrderInTransit","trackingNumber":"FMPP1234567890","itemShipped":{"@type":"Product","name":"Prestige Electric Kettle"}}
    ]}</script><p>Your item is on the way</p>`;
    const r = gmail.parse(signal({ messageId: "msg-parcel", from: { address: "noreply@nct.flipkart.com", name: "Flipkart" }, subject: "Shipped: Prestige Electric Kettle", date: Date.UTC(2026, 9, 4), html }), IN);
    const obs = only(r);
    expect(obs.kind).toBe("delivery");
    expect(obs.references).toEqual([{ type: "order_id", value: "OD99887766554433221", namespace: "flipkart" }]);
    expect(obs.evidence.summary).toBe("Flipkart delivery update email: order in transit");
  });
});

// ---------------------------------------------------------------------------
// Filtering, OTPs, forwarding, trust
// ---------------------------------------------------------------------------

describe("email adapter: what it refuses to read", () => {
  it("drops OTP emails before parsing", () => {
    const r = gmail.parse(
      signal({
        messageId: "msg-otp",
        from: { address: "alerts@hdfcbank.net", name: "HDFC Bank" },
        subject: "OTP for your transaction",
        date: Date.UTC(2026, 9, 4),
        text: "Your One Time Password for transaction of Rs. 1,249.00 at AMAZON is 482910. Do not share it with anyone.",
      }),
      IN,
    );
    expect(r).toEqual({ status: "ignored", reason: "otp" });
  });

  it("ignores a merchant's promotional newsletter", () => {
    const r = gmail.parse(
      signal({
        messageId: "msg-promo",
        from: { address: "store-news@amazon.in", name: "Amazon.in" },
        subject: "Great Indian Festival: Up to 70% off on electronics",
        date: Date.UTC(2026, 9, 4),
        listUnsubscribe: true,
        html: "<p>Deals on headphones from ₹499. Order now!</p>",
      }),
      IN,
    );
    expect(r).toEqual({ status: "ignored", reason: "promotional" });
  });

  it("ignores a bulk newsletter even without a sale subject", () => {
    const r = gmail.parse(
      signal({
        messageId: "msg-newsletter",
        from: { address: "news@thehustle.co", name: "The Hustle" },
        subject: "Why everyone is talking about tiny homes",
        date: Date.UTC(2026, 9, 4),
        listUnsubscribe: true,
        text: "Today's stories: tiny homes, big money.",
      }),
      US,
    );
    expect(r).toEqual({ status: "ignored", reason: "promotional" });
  });

  it("ignores personal mail as not financial", () => {
    const r = gmail.parse(
      signal({ messageId: "msg-personal", from: { address: "friend@gmail.com", name: "Ravi" }, subject: "Dinner on Saturday?", date: Date.UTC(2026, 9, 4), text: "Are you free?" }),
      IN,
    );
    expect(r).toEqual({ status: "ignored", reason: "not_financial" });
  });

  it("respects the sender allow-list", () => {
    const narrow = createEmailAdapter({ provider: "gmail", allowedSenders: ["alerts@hdfcbank.net", "swiggy.in"] });
    expect(narrow.parse(signal(AMAZON_ORDER), IN)).toEqual({ status: "ignored", reason: "not_financial" });
  });

  it("rejects malformed payloads", () => {
    const r = gmail.parse(signal({ messageId: "", from: { address: "x@y.z" }, subject: "", date: 0 }), IN);
    expect(r.status).toBe("rejected");
  });

  it("never turns a bank statement into a purchase", () => {
    const r = gmail.parse(
      signal({
        messageId: "msg-statement",
        from: { address: "emailstatements.cards@hdfcbank.net", name: "HDFC Bank" },
        subject: "Your HDFC Bank Credit Card Statement for September 2026",
        date: Date.UTC(2026, 9, 4),
        text: "Total Amount Due: ₹12,345.00\nMinimum Amount Due: ₹620.00\nPayment Due Date: 22-10-2026",
      }),
      IN,
    );
    expect(r).toEqual({ status: "ignored", reason: "unsupported_format" });
  });

  it("reports unsupported formats for transactional mail it cannot read", () => {
    const r = gmail.parse(
      signal({ messageId: "msg-nothing", from: { address: "auto-confirm@amazon.in", name: "Amazon.in" }, subject: "Your Amazon.in order", date: Date.UTC(2026, 9, 4), text: "Thanks for shopping with us." }),
      IN,
    );
    expect(r).toEqual({ status: "ignored", reason: "unsupported_format" });
  });
});

describe("email adapter: provenance and trust", () => {
  const forwarding = createEmailAdapter({ provider: "forwarding" });

  it("labels the source by transport", () => {
    expect(createEmailAdapter({ provider: "outlook" }).descriptor.displayName).toBe("Outlook");
    const obs = only(forwarding.parse(signal({ ...AMAZON_ORDER, forwarded: "auto" }, "conn_fwd"), IN));
    expect(obs.source.label).toBe("receipts forwarding address");
  });

  it("recovers the merchant from a manual forward and caps confidence at 0.6", () => {
    const text = [
      "FYI",
      "---------- Forwarded message ---------",
      "From: Swiggy <noreply@swiggy.in>",
      "Date: Sun, 4 Oct 2026 at 20:31",
      "Subject: Your Swiggy order was delivered successfully",
      "To: <kishan.abola@example.com>",
      "Order No: 167843923456",
      "Paneer Butter Masala x 1 ₹320.00",
      "Order Total ₹320.00",
    ].join("\n");
    const obs = only(forwarding.parse(signal({ messageId: "msg-fwd", from: { address: "kishan.abola@example.com", name: "Kishan" }, subject: "Fwd: Your Swiggy order was delivered successfully", date: Date.UTC(2026, 9, 4, 15, 5, 0), text }, "conn_fwd"), IN));
    expect(obs.merchant?.key).toBe("swiggy");
    expect(obs.amount?.value).toEqual(money(32_000, "INR"));
    expect(obs.confidence).toBeLessThanOrEqual(0.6);
    expect(obs.amount!.confidence).toBeLessThanOrEqual(0.6);
    expect(JSON.stringify(obs)).not.toContain("kishan.abola");
  });

  it("caps confidence when DKIM fails (possible spoof)", () => {
    const obs = only(gmail.parse(signal({ ...AMAZON_ORDER, authentication: { dkim: "fail", dmarc: "fail" } }), IN));
    expect(obs.confidence).toBeLessThanOrEqual(0.5);
  });

  it("unknown senders get heuristic confidence (~0.7)", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-unknown-shop",
          from: { address: "orders@chaipoint.in", name: "Chai Point" },
          subject: "Your Chai Point order receipt",
          date: Date.UTC(2026, 9, 4, 5, 0, 0),
          text: "Order No: 88123\nMasala Chai x 2 ₹180.00\nGrand Total ₹180.00",
        }),
        IN,
      ),
    );
    expect(obs.confidence).toBeGreaterThan(0.55);
    expect(obs.confidence).toBeLessThan(0.75);
    expect(obs.merchant).toMatchObject({ raw: "Chai Point", name: "Chai Point" });
    expect(obs.references[0]).toEqual({ type: "order_id", value: "88123", namespace: "chaipoint.in" });
  });

  it("never stores full card numbers that appear in a body", () => {
    const obs = only(
      gmail.parse(
        signal({
          messageId: "msg-card-leak",
          from: { address: "auto-confirm@amazon.in", name: "Amazon.in" },
          subject: "Your Amazon.in order of Kindle Paperwhite",
          date: Date.UTC(2026, 9, 4, 5, 0, 0),
          text: "Order #404-1234567-7654321\nKindle Paperwhite\tQty: 1\t₹13,999.00\nOrder Total: ₹13,999.00 charged to card 4111 1111 1111 1111\nPaid with Visa card 4111 1111 1111 1111",
        }),
        IN,
      ),
    );
    const json = JSON.stringify(obs);
    expect(json).not.toMatch(/4111\s?1111\s?1111\s?1111/);
    expect(obs.instrument?.last4 ?? "1111").toBe("1111");
    expect(obs.evidence.excerpt).toContain("••••1111");
  });
});
