import { describe, expect, it } from "vitest";
import { DAY, fixedClock } from "@brake/core";
import type { AdapterContext, AdapterResult, Observation, RawSignal } from "@brake/core";
import { createAppActivityAdapter } from "../src/app-activity";
import type { AppActivityPayload } from "../src/app-activity";
import { createBrowserCheckoutAdapter } from "../src/checkout";
import type { BrowserCheckoutEvent } from "../src/checkout";
import { createManualAdapter, parseUtterance } from "../src/manual";
import type { ManualInput } from "../src/manual";
import { cleanShareTitle, createShareAdapter, describeProductLink, registrableDomain, stripUrl } from "../src/share";
import type { SharePayload } from "../src/share";

const T0 = Date.UTC(2026, 9, 4, 5, 11, 0); // 2026-10-04 10:41 IST
const ctxIN: AdapterContext = { clock: fixedClock(T0), country: "IN", locale: "en-IN", defaultCurrency: "INR", timeZone: "Asia/Kolkata" };
const ctxUS: AdapterContext = { clock: fixedClock(T0), country: "US", locale: "en-US", defaultCurrency: "USD", timeZone: "America/New_York" };
const ctxBR: AdapterContext = { clock: fixedClock(T0), country: "BR", locale: "pt-BR", defaultCurrency: "BRL", timeZone: "America/Sao_Paulo" };
const ctxDE: AdapterContext = { clock: fixedClock(T0), country: "DE", locale: "de-DE", defaultCurrency: "EUR", timeZone: "Europe/Berlin" };

function raw<P>(adapterId: string, payload: P, receivedAt = T0): RawSignal<P> {
  return { adapterId, connectionId: `conn_${adapterId}`, receivedAt, payload };
}

function only(r: AdapterResult): Observation {
  if (r.status !== "observations") throw new Error(`expected observations, got ${JSON.stringify(r)}`);
  expect(r.observations).toHaveLength(1);
  return r.observations[0] as Observation;
}

/* ------------------------------------------------------------------ */

describe("URL helpers", () => {
  it("strips query strings, fragments, userinfo and tracking path segments", () => {
    expect(stripUrl("https://user:pw@www.Amazon.com/Apple-AirPods/dp/B0CHWRXH8B/ref=sr_1_1?crid=2X&keywords=airpods#reviews")).toBe(
      "https://www.amazon.com/Apple-AirPods/dp/B0CHWRXH8B",
    );
    expect(stripUrl("http://shop.example:80/cart?session=abc")).toBe("http://shop.example/cart");
    expect(stripUrl("upi://pay?pa=x@ybl")).toBeNull();
  });

  it("computes registrable domains across ccTLD second levels", () => {
    expect(registrableDomain("www.amazon.co.uk")).toBe("amazon.co.uk");
    expect(registrableDomain("produto.mercadolivre.com.br")).toBe("mercadolivre.com.br");
    expect(registrableDomain("dl.flipkart.com")).toBe("flipkart.com");
    expect(registrableDomain("amzn.in")).toBe("amzn.in");
  });

  it("recognises product links and ids from several retailers", () => {
    expect(describeProductLink("https://www.walmart.com/ip/Apple-AirPods-Pro-2nd-Generation/5689919121?athbdg=L1600")).toMatchObject({
      productId: "walmart:5689919121",
      merchant: { name: "Walmart" },
      productPage: true,
    });
    expect(describeProductLink("https://www.target.com/p/apple-airpods-pro-2nd-generation/-/A-85978612")?.productId).toBe("target:85978612");
    expect(describeProductLink("https://www.amazon.de/")?.productPage).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("browser checkout adapter", () => {
  const adapter = createBrowserCheckoutAdapter();
  const ev = (e: Partial<BrowserCheckoutEvent>): RawSignal<BrowserCheckoutEvent> =>
    raw("browser-checkout", { stage: "cart", url: "https://www.amazon.in/gp/cart/view.html", merchantDomain: "amazon.in", at: T0, ...e });

  it("cart -> pre-spend purchase intent with approximate total and items; query stripped", () => {
    const o = only(
      adapter.parse(
        ev({
          url: "https://www.amazon.in/gp/cart/view.html?ref_=nav_cart&session-id=262-1234567-7654321#top",
          total: "₹4,799.00",
          items: [
            { title: "boAt Rockerz 450 Bluetooth Headphones", price: "₹1,499.00", quantity: 1 },
            { title: "Philips electric toothbrush", price: "₹1,650.00", quantity: 2 },
          ],
        }),
        ctxIN,
      ),
    );
    expect(o).toMatchObject({
      kind: "purchase_intent",
      window: "pre_spend",
      stage: "intent",
      direction: "debit",
      amount: { value: { minor: 479_900, currency: "INR" }, confidence: 0.8, approximate: true },
      merchant: { raw: "amazon.in", name: "Amazon", key: "amazon", website: "amazon.in", channel: "online" },
      intent: { via: "cart", url: "https://www.amazon.in/gp/cart/view.html", title: "boAt Rockerz 450 Bluetooth Headphones and 1 more" },
      source: { adapterId: "browser-checkout", kind: "browser_extension", label: "BRAKE browser extension" },
    });
    expect(o.lineItems?.[1]).toEqual({
      description: "Philips electric toothbrush",
      quantity: 2,
      unitPrice: { minor: 165_000, currency: "INR" },
      total: { minor: 330_000, currency: "INR" },
    });
    expect(JSON.stringify(o)).not.toContain("session-id");
    expect(JSON.stringify(o)).not.toContain("262-1234567");
  });

  it("checkout and payment redirect -> in-spend checkout (USD, Target)", () => {
    const o = only(adapter.parse(ev({ stage: "checkout", url: "https://www.target.com/checkout?cartId=99", merchantDomain: "www.target.com", total: "$86.40" }), ctxUS));
    expect(o).toMatchObject({ kind: "checkout", window: "in_spend", stage: "intent", amount: { value: { minor: 8_640, currency: "USD" }, approximate: false } });
    expect(o.intent).toBeUndefined();
    const redirect = only(
      adapter.parse(
        ev({
          stage: "payment_redirect",
          url: "https://securegateway.example-psp.com/pay?txn=abc123&email=asha%40example.com",
          merchantDomain: "flipkart.com",
          total: "24900",
          currency: "INR",
          orderId: "OD330218477127261100",
        }),
        ctxIN,
      ),
    );
    expect(redirect).toMatchObject({ kind: "checkout", merchant: { name: "Flipkart" }, amount: { value: { minor: 2_490_000, currency: "INR" } } });
    expect(redirect.references).toEqual([{ type: "order_id", value: "OD330218477127261100", namespace: "flipkart" }]);
    expect(JSON.stringify(redirect)).not.toContain("asha");
  });

  it("confirmation -> confirmed post-spend order keyed by order id; re-renders dedupe", () => {
    const confirm = (at: number) =>
      adapter.parse(
        ev({ stage: "confirmation", url: "https://www.amazon.in/gp/buy/thankyou/handlers/display.html?purchaseId=106-1", total: "₹4,799.00", orderId: "402-1234567-1234567", at }),
        ctxIN,
      );
    const o = only(confirm(T0));
    expect(o).toMatchObject({ kind: "order", window: "post_spend", stage: "confirmed", confidence: 0.9 });
    expect(o.references).toEqual([{ type: "order_id", value: "402-1234567-1234567", namespace: "amazon" }]);
    expect(o.evidence.summary).toBe("Amazon confirmed your order 402-1234567-1234567 for ₹4,799 on amazon.in.");
    expect(only(confirm(T0 + 30_000)).id).toBe(o.id);
  });

  it("reads an order id from the confirmation URL query before discarding it (EUR, decimal comma)", () => {
    const o = only(
      adapter.parse(
        ev({
          stage: "confirmation",
          url: "https://www.example-shop.de/checkout/success?order_id=100045678&email=kunde%40example.de",
          merchantDomain: "example-shop.de",
          merchantName: "Example Shop",
          total: "1.299,00 €",
        }),
        ctxDE,
      ),
    );
    expect(o.amount?.value).toEqual({ minor: 129_900, currency: "EUR" });
    expect(o.references).toEqual([{ type: "order_id", value: "100045678", namespace: "example-shop.de" }]);
    expect(o.merchant).toMatchObject({ raw: "Example Shop", name: "Example Shop", key: "exampleshop" });
    expect(JSON.stringify(o)).not.toContain("kunde");
  });

  it("rejects malformed events", () => {
    expect(adapter.parse(ev({ url: "javascript:alert(1)" }), ctxIN).status).toBe("rejected");
    expect(adapter.parse(ev({ stage: "paid" as BrowserCheckoutEvent["stage"] }), ctxIN).status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */

describe("share adapter", () => {
  const adapter = createShareAdapter();
  const share = (p: Omit<SharePayload, "sharedAt">, ctx: AdapterContext = ctxIN) => adapter.parse(raw("share", { sharedAt: T0, ...p }), ctx);

  // Share-text shapes are illustrative of retailer apps' "Share" output (formats vary by app version and locale).
  it("amazon.in short link from the Amazon app: merchant from domain, title from text", () => {
    const o = only(share({ text: "Check out this product on Amazon: Apple AirPods Pro (2nd Generation) with MagSafe Case (USB‑C) https://amzn.in/d/5qXyZ12", sourceApp: "in.amazon.mShop.android.shopping" }));
    expect(o).toMatchObject({
      kind: "purchase_intent",
      window: "pre_spend",
      stage: "intent",
      merchant: { raw: "amzn.in", name: "Amazon", key: "amazon", channel: "online", confidence: 0.9 },
      intent: { via: "share", url: "https://amzn.in/d/5qXyZ12", title: "Apple AirPods Pro (2nd Generation) with MagSafe Case (USB‑C)" },
      source: { adapterId: "share", kind: "share", label: "shared Amazon link", provider: "Amazon" },
    });
    expect(o.amount).toBeUndefined();
    expect(o.categoryHints).toEqual([{ scheme: "brake", value: "shopping.online_marketplace", confidence: 0.5 }]);
  });

  it("amazon.com product URL with tracking: ASIN, clean URL, approximate USD price", () => {
    const o = only(
      share(
        {
          url: "https://www.amazon.com/Apple-Generation-Cancelling-Transparency-Personalized/dp/B0CHWRXH8B/ref=sr_1_1?crid=2XQ&keywords=airpods&qid=1759550000",
          title: "Apple AirPods Pro 2",
          text: "Apple AirPods Pro 2 - $189.99",
        },
        ctxUS,
      ),
    );
    expect(o.intent).toEqual({
      via: "share",
      title: "Apple AirPods Pro 2",
      url: "https://www.amazon.com/Apple-Generation-Cancelling-Transparency-Personalized/dp/B0CHWRXH8B",
      productId: "asin:B0CHWRXH8B",
    });
    expect(o.amount).toEqual({ value: { minor: 18_999, currency: "USD" }, confidence: 0.65, approximate: true });
    expect(o.merchant?.website).toBe("amazon.com");
    expect(JSON.stringify(o)).not.toContain("qid=");
  });

  it("Flipkart link with pid/affid params", () => {
    const o = only(
      share({
        text: "Check out this Apple AirPods Pro (2nd generation) with MagSafe Case (USB-C) Bluetooth Headset on Flipkart: https://www.flipkart.com/apple-airpods-pro-2nd-generation-magsafe-case-usb-c-bluetooth-headset/p/itm4a5b6c7d8e9f0?pid=ACCGRZ5S7HBGHBQF&affid=xyz&cmpid=share",
      }),
    );
    expect(o.merchant).toMatchObject({ name: "Flipkart", key: "flipkart" });
    expect(o.intent).toMatchObject({
      title: "Apple AirPods Pro (2nd generation) with MagSafe Case (USB-C) Bluetooth Headset",
      url: "https://www.flipkart.com/apple-airpods-pro-2nd-generation-magsafe-case-usb-c-bluetooth-headset/p/itm4a5b6c7d8e9f0",
      productId: "flipkart:itm4a5b6c7d8e9f0",
    });
    expect(JSON.stringify(o)).not.toContain("affid");
  });

  it("Mercado Livre (BR) link with a price in reais", () => {
    const o = only(
      share(
        { text: "Fone De Ouvido Apple AirPods Pro (2ª Geração) - R$ 1.899 https://produto.mercadolivre.com.br/MLB-3456789012-fone-de-ouvido-apple-airpods-pro-_JM#position=1&search_layout=grid" },
        ctxBR,
      ),
    );
    expect(o.merchant).toMatchObject({ name: "Mercado Livre", key: "mercado_livre", website: "mercadolivre.com.br" });
    expect(o.amount?.value).toEqual({ minor: 189_900, currency: "BRL" });
    expect(o.intent).toMatchObject({ productId: "mercadolibre:MLB3456789012", title: "Fone De Ouvido Apple AirPods Pro (2ª Geração)" });
    expect(o.intent?.url).toBe("https://produto.mercadolivre.com.br/MLB-3456789012-fone-de-ouvido-apple-airpods-pro-_JM");
  });

  it("falls back to the URL slug for a title and a domain-derived merchant", () => {
    const o = only(share({ url: "https://www.tanishq-store.co.in/products/gold-hoop-earrings-22kt?variant=4411" }));
    expect(o.merchant).toMatchObject({ name: "Tanishq Store", website: "tanishq-store.co.in", confidence: 0.6 });
    expect(o.intent).toMatchObject({ title: "Gold Hoop Earrings 22kt", url: "https://www.tanishq-store.co.in/products/gold-hoop-earrings-22kt" });
    expect(o.categoryHints).toBeUndefined();
  });

  it("accepts screenshot OCR text with a price and no link", () => {
    const o = only(share({ text: "Apple Watch SE (2nd Gen)\n₹24,900\nAdd to cart", sourceApp: "screenshot" }));
    expect(o.amount?.value).toEqual({ minor: 2_490_000, currency: "INR" });
    expect(o.merchant).toBeUndefined();
    expect(o.confidence).toBe(0.6);
  });

  it("ignores non-product content and drops OTPs", () => {
    expect(share({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toEqual({ status: "ignored", reason: "not_financial" });
    expect(share({ text: "see you at 8 near the station" })).toEqual({ status: "ignored", reason: "not_financial" });
    expect(share({ text: "482913 is your OTP for login. Do not share it." })).toEqual({ status: "ignored", reason: "otp" });
  });

  it("keeps a redacted, expiring excerpt without query strings", () => {
    const o = only(share({ text: "Check this out https://www.myntra.com/tshirts/roadster/12345678/buy?utm=wa", title: "Roadster T-shirt" }));
    expect(o.evidence.excerpt).toBe("Roadster T-shirt — Check this out https://www.myntra.com/tshirts/roadster/12345678/buy");
    expect(o.evidence.excerptExpiresAt).toBe(T0 + 7 * DAY);
  });

  it("cleans share boilerplate from titles", () => {
    expect(cleanShareTitle("Confira este produto no Mercado Livre: Tênis Nike Revolution 7", "Mercado Livre")).toBe("Tênis Nike Revolution 7");
    expect(cleanShareTitle("Hey! Check out this deal on Amazon: Kindle Paperwhite for ₹14,999", "Amazon")).toBe("Kindle Paperwhite");
  });
});

/* ------------------------------------------------------------------ */

describe("manual adapter", () => {
  const adapter = createManualAdapter();
  const input = (p: Omit<ManualInput, "at">, ctx: AdapterContext = ctxIN) => adapter.parse(raw("manual", { at: T0, ...p }), ctx);

  it("should_i_buy with a typed amount -> exact (not approximate) pre-spend intent", () => {
    const o = only(input({ mode: "should_i_buy", amount: "24,900", merchant: "Croma", note: "AirPods Pro", category: "shopping.electronics" }));
    expect(o).toMatchObject({
      kind: "purchase_intent",
      window: "pre_spend",
      stage: "intent",
      amount: { value: { minor: 2_490_000, currency: "INR" }, confidence: 0.9, approximate: false },
      merchant: { raw: "Croma", confidence: 0.7 },
      intent: { via: "should_i_buy", title: "AirPods Pro" },
      categoryHints: [{ scheme: "brake", value: "shopping.electronics", confidence: 0.9 }],
      confidence: 0.9,
      source: { kind: "manual", label: "“Should I buy this?” check" },
    });
    expect(o.evidence.summary).toBe("You asked BRAKE about AirPods Pro from Croma for ₹24,900.");
  });

  it("typed approximate amounts and shorthand", () => {
    const o = only(input({ mode: "should_i_buy", amount: "about 2.5k", note: "running shoes" }));
    expect(o.amount).toEqual({ value: { minor: 250_000, currency: "INR" }, confidence: 0.9, approximate: true });
    const usd = only(input({ mode: "should_i_buy", amount: "$80", note: "headphones" }, ctxUS));
    expect(usd.amount?.value).toEqual({ minor: 8_000, currency: "USD" });
  });

  it("spent -> confirmed post-spend money movement at user-entered confidence", () => {
    const o = only(input({ mode: "spent", amount: "180", merchant: "Chai Point", category: "eating_out.cafe", note: "chai and samosa" }));
    expect(o).toMatchObject({
      kind: "money_movement",
      window: "post_spend",
      stage: "confirmed",
      direction: "debit",
      amount: { value: { minor: 18_000, currency: "INR" }, confidence: 0.9 },
      categoryHints: [{ scheme: "brake", value: "eating_out.cafe", confidence: 0.95 }],
      confidence: 0.9,
    });
    expect(o.evidence.summary).toBe("You added ₹180 at Chai Point (chai and samosa).");
  });

  it("spent with a currency field (BRL) and an unknown category keyword", () => {
    const o = only(input({ mode: "spent", amount: "45,90", currency: "brl", merchant: "Padaria", category: "Lanche" }, ctxBR));
    expect(o.amount?.value).toEqual({ minor: 4_590, currency: "BRL" });
    expect(o.categoryHints).toEqual([{ scheme: "keyword", value: "lanche", confidence: 0.6 }]);
  });

  it("rejects entries that say nothing", () => {
    expect(input({ mode: "spent", merchant: "Somewhere" }).status).toBe("rejected");
    expect(input({ mode: "should_i_buy" }).status).toBe("rejected");
    expect(input({ mode: "voice" }).status).toBe("rejected");
  });

  it("voice: 'should I buy AirPods for 24,900'", () => {
    const o = only(input({ mode: "voice", utterance: "should I buy AirPods for 24,900" }));
    expect(o).toMatchObject({
      kind: "purchase_intent",
      amount: { value: { minor: 2_490_000, currency: "INR" }, confidence: 0.8, approximate: false },
      intent: { via: "voice", title: "AirPods" },
      source: { label: "voice request" },
    });
    expect(o.evidence.excerpt).toBe("should I buy AirPods for 24,900");
    expect(o.evidence.excerptExpiresAt).toBe(T0 + 7 * DAY);
  });

  it("voice: past spend becomes a money movement", () => {
    const o = only(input({ mode: "voice", utterance: "I spent 450 on lunch at Subway" }));
    expect(o).toMatchObject({ kind: "money_movement", stage: "confirmed", amount: { value: { minor: 45_000, currency: "INR" } }, merchant: { raw: "Subway" }, confidence: 0.8 });
    expect(o.evidence.summary).toBe("You told BRAKE you spent ₹450 at Subway (lunch).");
  });

  it("parses utterances in several shapes and languages", () => {
    expect(parseUtterance("Should I buy the Sony WH-1000XM5 from Croma for ₹29,990?", { defaultCurrency: "INR" })).toEqual({
      intent: "should_i_buy",
      title: "Sony WH-1000XM5",
      merchant: "Croma",
      amount: { minor: 2_999_000, currency: "INR" },
      approximate: false,
    });
    expect(parseUtterance("can I afford a trip to Goa for about 40k", { defaultCurrency: "INR" })).toMatchObject({
      title: "trip to Goa",
      amount: { minor: 4_000_000, currency: "INR" },
      approximate: true,
    });
    expect(parseUtterance("should I buy a 55 inch TV for 45,000", { defaultCurrency: "INR" })).toMatchObject({ title: "55 inch TV", amount: { minor: 4_500_000 } });
    expect(parseUtterance("is it ok to buy a jacket for 80 dollars", { defaultCurrency: "INR", country: "US" })).toMatchObject({
      title: "jacket",
      amount: { minor: 8_000, currency: "USD" },
    });
    expect(parseUtterance("devo comprar um tênis por 300 reais?", { country: "BR" })).toMatchObject({
      intent: "should_i_buy",
      title: "tênis",
      amount: { minor: 30_000, currency: "BRL" },
    });
    expect(parseUtterance("should I buy a sofa for 1.5 lakh", { defaultCurrency: "INR" })).toMatchObject({ title: "sofa", amount: { minor: 15_000_000 } });
    expect(parseUtterance("should I get the iPhone 16", { defaultCurrency: "USD" })).toEqual({ intent: "should_i_buy", title: "iPhone 16", approximate: false });
  });
});

/* ------------------------------------------------------------------ */

describe("app activity adapter", () => {
  const adapter = createAppActivityAdapter();
  const ev = (p: Partial<AppActivityPayload>) => adapter.parse(raw("app-activity", { event: "app_opened", appId: "com.flipkart.android", at: T0, platform: "android", ...p }), ctxIN);

  it("emits pre-spend app_context, never a transaction", () => {
    const o = only(ev({ event: "shield_shown", appId: "com.amazon.Amazon", platform: "ios", category: "shopping" }));
    expect(o).toMatchObject({
      kind: "app_context",
      window: "pre_spend",
      stage: "intent",
      merchant: { name: "Amazon", key: "amazon" },
      categoryHints: [{ scheme: "brake", value: "shopping", confidence: 0.7 }],
      intent: { via: "shield" },
      source: { kind: "app_activity", label: "Screen Time app pause" },
    });
    expect(o.amount).toBeUndefined();
    expect(o.direction).toBeUndefined();
    expect(o.references).toEqual([]);
  });

  it("maps outcomes: bypass stays open, respected pause is an abandoned intent", () => {
    expect(only(ev({ event: "shield_bypassed" })).stage).toBe("intent");
    const respected = only(ev({ event: "shield_respected" }));
    expect(respected.stage).toBe("cancelled");
    expect(respected.evidence.summary).toBe("You closed Flipkart (a shopping app you asked BRAKE to watch) at BRAKE's pause.");
  });

  it("uses data-pack categories for food delivery apps on Android", () => {
    const o = only(ev({ appId: "in.swiggy.android" }));
    expect(o.categoryHints).toEqual([{ scheme: "brake", value: "eating_out.delivery", confidence: 0.6 }]);
    expect(o.source.label).toBe("Android app usage access");
    expect(o.intent).toEqual({ via: "app_launch" });
  });

  it("never exposes opaque Screen Time tokens in evidence", () => {
    const o = only(ev({ event: "shield_shown", appId: "token:8F3A21C0-77E1-4C3B-9A51-0D2E6B1C9F44", platform: "ios", category: "shopping" }));
    expect(o.evidence.summary).toBe("BRAKE showed a pause when you opened a shopping app you asked BRAKE to watch.");
    expect(JSON.stringify(o.evidence)).not.toContain("8F3A21C0");
    expect(o.merchant).toBeUndefined();
  });

  it("rejects malformed events", () => {
    expect(ev({ event: "purchase" as AppActivityPayload["event"] }).status).toBe("rejected");
    expect(ev({ appId: " " }).status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */
/* Adversarial review: hostile payloads, storability, misclassification */
/* ------------------------------------------------------------------ */

/** Observations must pass the store's own schema and privacy checks (lone surrogates, instants, safe integers, card numbers). */
async function expectStorable(observations: readonly Observation[]): Promise<void> {
  const { createMemoryStore } = await import("../../core/src/store-memory");
  const store = createMemoryStore({ clock: fixedClock(T0) });
  for (const o of observations) {
    await store.upsertConnection({
      connectionId: o.source.connectionId,
      adapterId: o.source.adapterId,
      kind: o.source.kind,
      label: "test connection",
      status: "active",
      scopes: [],
      purposes: [],
      retention: { excerptTtlMs: 7 * DAY, observationTtlMs: null },
      grantedAt: T0,
      updatedAt: T0,
    });
  }
  await expect(store.putObservations(observations)).resolves.toBeDefined();
}

/** Run a payload of any shape; adapters must answer, never throw. */
function parseAny<P>(adapter: { parse(s: RawSignal<P>, c: AdapterContext): AdapterResult }, adapterId: string, payload: unknown, ctx: AdapterContext = ctxIN): AdapterResult {
  return adapter.parse(raw(adapterId, payload as P), ctx);
}

describe("adversarial review: browser checkout", () => {
  const adapter = createBrowserCheckoutAdapter();
  const base = { stage: "cart", url: "https://www.amazon.in/gp/cart/view.html", merchantDomain: "amazon.in", at: T0 };

  it("never throws on malformed item lists or non-string fields", () => {
    for (const bad of [
      { ...base, items: "abc" },
      { ...base, items: {} },
      { ...base, items: [null, 5, { title: 5 }, { title: "Mug", price: 3, quantity: "2" }] },
      { ...base, merchantName: 5 },
      { ...base, total: { amount: 1 }, currency: 5 },
      { ...base, orderId: 12345, stage: "confirmation" },
    ]) {
      expect(() => parseAny(adapter, "browser-checkout", bad)).not.toThrow();
    }
    const r = only(parseAny(adapter, "browser-checkout", { ...base, items: [null, { title: "Coffee mug", price: "₹349" }] }));
    expect(r.lineItems).toEqual([{ description: "Coffee mug", unitPrice: { minor: 34_900, currency: "INR" }, total: { minor: 34_900, currency: "INR" } }]);
  });

  it("does not turn an absurd page total into an unsafe amount, and repairs non-integer event times", async () => {
    const o = only(parseAny(adapter, "browser-checkout", { ...base, stage: "checkout", total: `₹${"9".repeat(400)}`, at: 1759554660.25 }));
    expect(o.amount).toBeUndefined();
    expect(o.occurredAt?.value).toBe(T0);
    const p = only(parseAny(adapter, "browser-checkout", { ...base, stage: "checkout", total: "₹99999999999999999999" }));
    expect(p.amount).toBeUndefined();
    await expectStorable([o, p]);
  });
});

describe("adversarial review: share", () => {
  const adapter = createShareAdapter();
  const share = (p: Record<string, unknown>, ctx: AdapterContext = ctxIN) => parseAny(adapter, "share", { sharedAt: T0, ...p }, ctx);

  it("truncates emoji-heavy titles on code points, so the summary and excerpt stay storable", async () => {
    const o = only(share({ title: `${"🔥".repeat(100)} deal`, url: "https://www.amazon.in/dp/B0CHWRXH8B" }));
    const p = only(share({ text: `Check out ${"🔥".repeat(150)} https://www.amazon.in/dp/B0CHWRXH8B` }));
    expect(o.evidence.summary.endsWith("…”.")).toBe(true);
    await expectStorable([o, p]);
  });

  it("a forwarded bank debit alert is not a pre-spend purchase intent", () => {
    // HDFC-style UPI debit SMS shared into BRAKE from the messages app.
    expect(share({ text: "Rs 500.00 debited from A/c XX1234 on 04-10-26 to VPA swiggy@icici. UPI Ref 412345678901. Not you? Call 18002586161" })).toEqual({
      status: "ignored",
      reason: "unsupported_format",
    });
    expect(share({ text: "Sent Rs.1,249.00 From HDFC Bank A/C *1234 To AMAZON On 04/10/26 Ref 427713268894" })).toEqual({ status: "ignored", reason: "unsupported_format" });
  });

  it("never throws on huge numbers or non-string fields", () => {
    expect(() => share({ text: `Phone case ₹${"9".repeat(400)} and ₹499` })).not.toThrow();
    const o = only(share({ text: `Phone case ₹${"9".repeat(400)} only ₹499 https://www.amazon.in/dp/B0CHWRXH8B` }));
    expect(o.amount?.value).toEqual({ minor: 49_900, currency: "INR" });
    expect(share({ text: 5, url: 5, title: 5 }).status).toBe("ignored");
  });
});

describe("adversarial review: manual and voice", () => {
  const adapter = createManualAdapter();
  const input = (p: Record<string, unknown>, ctx: AdapterContext = ctxIN) => parseAny(adapter, "manual", { at: T0, ...p }, ctx);

  it("refuses amounts beyond what Money can hold exactly instead of storing 1e25 paise or throwing", () => {
    expect(input({ mode: "spent", amount: "99999999999999999999999", note: "typo" })).toMatchObject({ status: "rejected" });
    expect(() => input({ mode: "spent", amount: "9".repeat(400) })).not.toThrow();
    expect(() => input({ mode: "voice", utterance: `should I buy a watch for ${"9".repeat(400)} rupees` })).not.toThrow();
    const o = only(input({ mode: "voice", utterance: `should I buy a watch for ${"9".repeat(40)} rupees` }));
    expect(o.amount).toBeUndefined();
  });

  it("a zero spend is not a money movement", () => {
    expect(input({ mode: "spent", amount: "₹0", merchant: "Cafe" }).status).toBe("rejected");
  });

  it("keeps voice excerpts storable when the cut falls inside an emoji", async () => {
    const o = only(input({ mode: "voice", utterance: `should I buy ${"🎧".repeat(150)} for 2000` }));
    await expectStorable([o]);
  });

  it("repairs non-integer times", async () => {
    const o = only(input({ mode: "spent", amount: "180", at: 1759554660.9 }));
    expect(o.occurredAt?.value).toBe(T0);
    await expectStorable([o]);
  });
});

describe("adversarial review: app activity", () => {
  const adapter = createAppActivityAdapter();
  const ev = (p: Record<string, unknown>) => parseAny(adapter, "app-activity", { event: "app_opened", appId: "com.flipkart.android", at: T0, platform: "android", ...p });

  it("never throws on a non-string appName", () => {
    expect(() => ev({ appName: 5 })).not.toThrow();
    expect(only(ev({ appName: 5 })).source.provider).toBe("Flipkart");
  });

  it("does not resolve app ids or categories through Object.prototype", () => {
    const o = only(ev({ appId: "toString" }));
    expect(o.source.provider).toBeUndefined();
    expect(o.merchant).toBeUndefined();
    const c = only(ev({ appId: "com.example.app", category: "constructor" }));
    expect(c.categoryHints).toBeUndefined();
    expect(c.evidence.summary).toBe("You opened an app you asked BRAKE to watch.");
  });
});

describe("adversarial review: fusion keys shared with the e-mail adapter", () => {
  it("a browser order confirmation uses the same order_id namespace and merchant key as the merchant's order e-mail", async () => {
    // The e-mail adapter namespaces merchant order ids by the sender's merchant key ("amazon", "flipkart",
    // "mercado_livre"); a different namespace makes the decisive shared-reference match impossible.
    const { lookupSender } = await import("../src/email/senders");
    const adapter = createBrowserCheckoutAdapter();
    const confirm = (merchantDomain: string, orderId: string) =>
      only(adapter.parse(raw("browser-checkout", { stage: "confirmation", url: `https://www.${merchantDomain}/thankyou`, merchantDomain, orderId, at: T0 }), ctxIN));
    for (const [domain, sender, orderId] of [
      ["amazon.in", "auto-confirm@amazon.in", "402-8473621-5530745"],
      ["flipkart.com", "noreply@flipkart.com", "OD432178965412300100"],
      ["mercadolivre.com.br", "noreply@mercadolivre.com.br", "2000004567891234"],
    ] as const) {
      const o = confirm(domain, orderId);
      const key = lookupSender(sender)?.info.key;
      expect(key).toBeDefined();
      expect(o.references).toEqual([{ type: "order_id", value: orderId, namespace: key }]);
      expect(o.merchant?.key).toBe(key);
    }
    // Merchants outside the data pack fall back to the registrable domain.
    expect(confirm("example-shop.de", "100045678").references[0]?.namespace).toBe("example-shop.de");
  });
});

describe("adversarial review: personal data in URL paths", () => {
  it("drops path segments that carry e-mail addresses from every retained URL", () => {
    expect(stripUrl("https://shop.example.com/u/jane.doe@example.com/wishlist/item/123")).toBe("https://shop.example.com/u/wishlist/item/123");
    expect(stripUrl("https://shop.example.com/u/jane.doe%40example.com/cart")).toBe("https://shop.example.com/u/cart");
    const o = only(createBrowserCheckoutAdapter().parse(raw("browser-checkout", { stage: "cart", url: "https://www.example-shop.de/cart/kunde@example.de", merchantDomain: "example-shop.de", total: "12,00 €", at: T0 }), ctxDE));
    expect(JSON.stringify(o)).not.toContain("kunde");
  });
});

describe("adversarial review: relative days in voice entries", () => {
  const adapter = createManualAdapter();
  const say = (utterance: string, ctx: AdapterContext = ctxIN) => only(adapter.parse(raw("manual", { mode: "voice", utterance, at: T0 }), ctx));

  it("'yesterday' moves the spend a day back, marks the time approximate and leaves the title clean", () => {
    const o = say("I spent 450 on lunch at Subway yesterday");
    expect(o.kind).toBe("money_movement");
    expect(o.occurredAt).toMatchObject({ value: T0 - DAY, approximate: true });
    expect(o.occurredAt?.confidence).toBeLessThanOrEqual(0.5);
    expect(o.evidence.summary).toBe("You told BRAKE you spent ₹450 at Subway (lunch).");
    expect(only(adapter.parse(raw("manual", { mode: "voice", utterance: "ontem gastei 80 reais no mercado", at: T0 }), ctxBR)).occurredAt?.value).toBe(T0 - DAY);
    expect(say("I paid 1200 for groceries the day before yesterday").occurredAt?.value).toBe(T0 - 2 * DAY);
  });

  it("a plain past spend keeps the entry time", () => {
    expect(say("I spent 450 on lunch at Subway").occurredAt).toEqual({ value: T0, confidence: 0.8 });
  });
});

describe("adversarial review: locale hints from native shells", () => {
  it("an underscore locale (Android Locale.toString(): 'en_IN') or an empty one never makes an adapter throw", () => {
    for (const locale of ["en_IN", "", "not a locale!"]) {
      const ctx: AdapterContext = { ...ctxIN, locale };
      const spent = only(createManualAdapter().parse(raw("manual", { mode: "spent", amount: "1249", merchant: "Croma", at: T0 }), ctx));
      expect(spent.evidence.summary).toContain("1,249");
      expect(() => createBrowserCheckoutAdapter().parse(raw("browser-checkout", { stage: "checkout", url: "https://www.amazon.in/checkout", merchantDomain: "amazon.in", total: "₹4,799.00", at: T0 }), ctx)).not.toThrow();
    }
    const underscore = only(createManualAdapter().parse(raw("manual", { mode: "spent", amount: "124900", merchant: "Croma", at: T0 }), { ...ctxIN, locale: "en_IN" }));
    // Read as en-IN, not dropped: Indian digit grouping survives.
    expect(underscore.evidence.summary).toBe("You added ₹1,24,900 at Croma.");
  });
});

describe("adversarial review: unstorable text never reaches facts", () => {
  it("NUL bytes, lone surrogates and card numbers in free-text fields are cleaned before they become facts", async () => {
    const outs: Observation[] = [];
    outs.push(only(createShareAdapter().parse(raw("share", { url: "https://www.example-shop.com/products/fancy%00mug-blue\ud83d", title: "Mug \u0000 \ud83d", sharedAt: T0 }), ctxIN)));
    outs.push(only(createBrowserCheckoutAdapter().parse(raw("browser-checkout", { stage: "cart", url: "https://www.amazon.in/gp/cart", merchantDomain: "amazon.in", merchantName: "Shop 6012345678901234 \ud83d", items: [{ title: "Mug\u0000 6012345678901234", price: "₹349" }], at: T0 }), ctxIN)));
    outs.push(only(createAppActivityAdapter().parse(raw("app-activity", { event: "app_opened", appId: "com.example", appName: "Shop\u0000 \udc00 6012345678901234", at: T0, platform: "android" }), ctxIN)));
    outs.push(only(createManualAdapter().parse(raw("manual", { mode: "voice", utterance: "should I buy gift card 6012345678901234 for 500 \ud83d", at: T0 }), ctxIN)));
    outs.push(only(createManualAdapter().parse(raw("manual", { mode: "spent", amount: "50", merchant: "Cafe\u0000", note: "\udc00 latte", at: T0 }), ctxIN)));
    for (const o of outs) {
      const json = JSON.stringify(o);
      expect(json).not.toContain("6012345678901234");
      expect(json).not.toContain("\\u0000");
    }
    await expectStorable(outs);
  });
});
