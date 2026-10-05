import { describe, expect, it } from "vitest";
import { fixedClock } from "@brake/core";
import type { AdapterContext, Observation, RawSignal } from "@brake/core";
import { createUpiIntentAdapter, decodeUpiUri, isPhoneLikeVpa, maskUpiHandle, parseUpiUri } from "../src/upi";
import type { UpiIntentPayload } from "../src/upi";

const T0 = Date.UTC(2026, 9, 4, 5, 11, 0); // 2026-10-04 10:41 IST
const ctx: AdapterContext = { clock: fixedClock(T0), country: "IN", locale: "en-IN", defaultCurrency: "INR", timeZone: "Asia/Kolkata" };

function signal(payload: UpiIntentPayload, receivedAt = T0): RawSignal<UpiIntentPayload> {
  return { adapterId: "upi-intent", connectionId: "conn_upi", receivedAt, payload };
}

function only(result: ReturnType<ReturnType<typeof createUpiIntentAdapter>["parse"]>): Observation {
  expect(result.status).toBe("observations");
  if (result.status !== "observations") throw new Error("no observations");
  expect(result.observations).toHaveLength(1);
  return result.observations[0] as Observation;
}

// URI shapes follow NPCI's UPI Linking Specification parameter table (research 05 §1).
const STATIC_MERCHANT = "upi://pay?pa=sharmastore@okaxis&pn=Sharma%20General%20Store&mc=5411&cu=INR";
const DYNAMIC_SIGNED =
  "upi://pay?pa=swiggy.payu@hdfcbank&pn=Swiggy&mc=5812&tid=PSP2026100410411234&tr=SWG123456789&tn=Order%20%23ORD-88231" +
  "&am=349.00&cu=INR&mode=04&purpose=00&orgid=000000&url=https%3A%2F%2Fwww.swiggy.com%2Forders%2F88231%3Ftoken%3Dsecret-abc" +
  "&sign=MEUCIQDx7f%2BqZk9%2Fabc%3D";
const P2P = "upi://pay?pa=9876543210@ybl&pn=Rahul%20Kumar&am=500&cu=INR";

describe("parseUpiUri", () => {
  it("parses a static merchant QR (P2M, no amount)", () => {
    const r = parseUpiUri(STATIC_MERCHANT);
    expect(r).toMatchObject({
      kind: "pay",
      payeeAddress: "sharmastore@okaxis",
      payeeName: "Sharma General Store",
      merchantCode: "5411",
      currency: "INR",
      signed: false,
      amountEditable: true,
    });
    expect(r?.amount).toBeUndefined();
    expect(r?.isMerchant).toBeGreaterThanOrEqual(0.9);
    expect(r?.merchantSignals).toContain("mc:5411");
  });

  it("parses a signed dynamic intent with encoded params", () => {
    const r = parseUpiUri(DYNAMIC_SIGNED);
    expect(r).toMatchObject({
      payeeAddress: "swiggy.payu@hdfcbank",
      transactionId: "PSP2026100410411234",
      transactionRef: "SWG123456789",
      note: "Order #ORD-88231",
      amount: "349.00",
      mode: "04",
      initiationMode: "intent",
      orgId: "000000",
      signed: true,
      amountEditable: false,
      referenceUrl: "https://www.swiggy.com/orders/88231?token=secret-abc",
    });
    expect(r?.isMerchant).toBeGreaterThanOrEqual(0.92);
    // The signature itself is never kept.
    expect(JSON.stringify(r)).not.toContain("MEUCIQ");
  });

  it("classifies a phone-number VPA without merchant data as P2P", () => {
    const r = parseUpiUri(P2P);
    expect(r?.amount).toBe("500.00");
    expect(r?.isMerchant).toBeLessThanOrEqual(0.15);
    expect(r?.merchantSignals).toContain("phone-like-vpa");
    expect(isPhoneLikeVpa("9876543210@ybl")).toBe(true);
    expect(isPhoneLikeVpa("+919876543210@paytm")).toBe(true);
    expect(isPhoneLikeVpa("rahul.k@okhdfcbank")).toBe(false);
    expect(maskUpiHandle("9876543210@ybl")).toBe("••••3210@ybl");
    expect(maskUpiHandle("sharmastore@okaxis")).toBe("sharmastore@okaxis");
  });

  it("treats MCC 0000 as a person and MCC 7407 as a small (P2PM) merchant", () => {
    expect(parseUpiUri("upi://pay?pa=anita.s@oksbi&pn=Anita&mc=0000")?.isMerchant).toBeLessThanOrEqual(0.1);
    expect(parseUpiUri("upi://pay?pa=ramu.chai@okicici&pn=Ramu%20Tea%20Stall&mc=7407")?.isMerchant).toBeCloseTo(0.8);
  });

  it("recognises business-only handles", () => {
    expect(parseUpiUri("upi://pay?pa=Q123456789@ybl&pn=Fresh%20Mart")?.isMerchant).toBeGreaterThanOrEqual(0.75);
    expect(parseUpiUri("upi://pay?pa=paytmqr2810050501011abcd@paytm&pn=Kirana")?.isMerchant).toBeGreaterThanOrEqual(0.75);
  });

  it("decodes '+' as space, normalises amounts and upper-case URIs", () => {
    const r = parseUpiUri("UPI://PAY?PA=FreshMart@YBL&PN=Fresh+Mart&AM=1249&CU=inr");
    expect(r).toMatchObject({ payeeAddress: "freshmart@ybl", payeeName: "Fresh Mart", amount: "1249.00", currency: "INR" });
    expect(parseUpiUri("upi://pay?pa=a.b@ybl&am=0.00")?.amount).toBeUndefined();
    expect(parseUpiUri("upi://pay?pa=a.b@ybl&am=&cu=INR")?.amount).toBeUndefined();
  });

  it("survives malformed percent-encoding without throwing", () => {
    const r = parseUpiUri("upi://pay?pa=cafe@okaxis&pn=Caf%C3%A9%ZZ%20Rio");
    expect(r?.payeeName).toBe("Café%ZZ Rio");
  });

  it("keeps unknown parameters (UPI 2.0 / GST tags) verbatim", () => {
    const r = parseUpiUri("upi://pay?pa=shop@okaxis&pn=Shop&mc=5411&gstIn=29ABCDE1234F1Z5&invoiceNo=INV-77&am=10");
    expect(r?.extra).toMatchObject({ gstin: "29ABCDE1234F1Z5", invoiceno: "INV-77" });
  });

  it("accepts PSP app-specific schemes used on iOS", () => {
    expect(parseUpiUri("tez://upi/pay?pa=shop@okaxis&pn=Shop&am=10")?.payeeAddress).toBe("shop@okaxis");
    expect(parseUpiUri("phonepe://pay?pa=shop@ybl&pn=Shop")?.payeeAddress).toBe("shop@ybl");
  });

  it("rejects malformed URIs with a reason", () => {
    expect(parseUpiUri("upi://pay?pn=NoPayee")).toBeNull();
    expect(decodeUpiUri("upi://pay?pn=NoPayee")).toEqual({ ok: false, error: "missing_payee" });
    expect(decodeUpiUri("upi://pay?pa=not-a-vpa")).toEqual({ ok: false, error: "invalid_payee" });
    expect(decodeUpiUri("upi://pay?pa=shop@example.com")).toEqual({ ok: false, error: "invalid_payee" });
    expect(decodeUpiUri("upi://pay?pa=shop@okaxis&am=1,249.00")).toEqual({ ok: false, error: "invalid_amount" });
    expect(decodeUpiUri("upi://pay?pa=shop@okaxis&am=12.345")).toEqual({ ok: false, error: "invalid_amount" });
    expect(decodeUpiUri("upi://pay?pa=shop@okaxis&am=-5")).toEqual({ ok: false, error: "invalid_amount" });
    expect(decodeUpiUri("upi://pay?pa=shop@okaxis&cu=RUPEES")).toEqual({ ok: false, error: "invalid_currency" });
    expect(decodeUpiUri("upi://collect?pa=shop@okaxis")).toEqual({ ok: false, error: "unsupported_action" });
    expect(decodeUpiUri("https://example.com/?pa=shop@okaxis")).toEqual({ ok: false, error: "not_upi" });
    expect(parseUpiUri("")).toBeNull();
  });

  it("parses AutoPay mandate URIs (PSP-aggregator documented parameters)", () => {
    // Example from Setu's UPI mandate docs (search result, 2026).
    const weekly = parseUpiUri(
      "upi://mandate?pa=acme.corp@axis&pn=merchant-1&validitystart=02012006&validityend=02012008&am=100.00&amrule=MAX&recur=WEEKLY&recurvalue=1&recurtype=ON",
    );
    expect(weekly).toMatchObject({ kind: "mandate", payeeAddress: "acme.corp@axis", amount: "100.00" });
    expect(weekly?.mandate).toEqual({
      amountRule: "max",
      recurrence: "weekly",
      period: "P1W",
      recurrenceValue: "1",
      recurrenceType: "on",
      validityStart: "2006-01-02",
      validityEnd: "2008-01-02",
    });
    const asPresented = parseUpiUri(
      "upi://mandate?amrule=MAX&tn=Merchantmandate&validityend=09112026&mode=04&mn=Merchantmandate&cu=INR&pn=MerchantMandate&purpose=14&tid=YJP20231009dzY4Kb7aBs9dj22&pa=merchant@yespay&am=10.00&validitystart=27102023&recur=ASPRESENTED",
    );
    expect(asPresented?.mandate).toMatchObject({ name: "Merchantmandate", recurrence: "aspresented", validityEnd: "2026-11-09" });
    expect(asPresented?.mandate?.period).toBeUndefined();
    expect(parseUpiUri("upi://mandate?pa=x@ybl&recur=one%20time")?.mandate?.recurrence).toBe("onetime");
  });
});

describe("createUpiIntentAdapter", () => {
  const adapter = createUpiIntentAdapter();

  it("describes itself", () => {
    expect(adapter.descriptor).toMatchObject({ id: "upi-intent", kind: "payment_intent", platforms: ["android"] });
  });

  it("emits an in-spend checkout for a merchant intent", () => {
    const launchedAt = T0 - 2_000;
    const o = only(adapter.parse(signal({ uri: DYNAMIC_SIGNED, launchedAt, sourceApp: "in.swiggy.android" }), ctx));
    expect(o).toMatchObject({
      kind: "checkout",
      window: "in_spend",
      stage: "intent",
      direction: "debit",
      rail: { family: "account_to_account_instant", scheme: "upi" },
      amount: { value: { minor: 34_900, currency: "INR" }, confidence: 0.95, approximate: false },
      occurredAt: { value: launchedAt, confidence: 0.95 },
      country: "IN",
      source: { adapterId: "upi-intent", kind: "payment_intent", connectionId: "conn_upi", label: "UPI payment request" },
    });
    expect(o.merchant).toMatchObject({ raw: "Swiggy", name: "Swiggy", mcc: "5812", handle: "swiggy.payu@hdfcbank", website: "swiggy.com", channel: "online" });
    expect(o.counterparty?.isMerchant).toBeGreaterThanOrEqual(0.92);
    expect(o.references).toEqual([
      { type: "merchant_reference", value: "SWG123456789", namespace: "swiggy.payu@hdfcbank" },
      { type: "order_id", value: "88231", namespace: "swiggy" },
    ]);
    expect(o.categoryHints).toEqual([{ scheme: "mcc", value: "5812", confidence: 0.9 }]);
    expect(o.typeHints?.[0]).toMatchObject({ type: "purchase" });
    expect(o.evidence.summary).toContain("Swiggy opened a UPI request");
    expect(o.evidence.summary).toContain("₹349");
    // Tokens in the merchant's reference URL never reach the observation.
    expect(JSON.stringify(o)).not.toContain("secret-abc");
    expect(o.evidence.excerpt).toBeUndefined();
  });

  it("emits a checkout without amount for a static request and finds order ids in the note", () => {
    const o = only(adapter.parse(signal({ uri: "upi://pay?pa=Q123456789@ybl&pn=Fresh%20Mart&tn=Payment%20for%20order%20FM-20419" }), ctx));
    expect(o.kind).toBe("checkout");
    expect(o.amount).toBeUndefined();
    expect(o.references).toEqual([{ type: "order_id", value: "FM-20419", namespace: "q123456789@ybl" }]);
    expect(o.occurredAt).toEqual({ value: T0, confidence: 0.9 });
  });

  it("masks personal VPAs and hints a P2P transfer", () => {
    const o = only(adapter.parse(signal({ uri: P2P }), ctx));
    expect(o.merchant).toBeUndefined();
    expect(o.counterparty).toMatchObject({ name: "Rahul Kumar", handle: "••••3210@ybl" });
    expect(o.typeHints?.[0]).toMatchObject({ type: "transfer", transferKind: "p2p_other" });
    expect(o.typeHints?.[0]?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(JSON.stringify(o)).not.toContain("9876543210");
  });

  it("emits a pre-spend mandate observation for AutoPay links", () => {
    const o = only(
      adapter.parse(
        signal({ uri: "upi://mandate?pa=netflix.billdesk@hdfcbank&pn=Netflix&mc=4899&am=649.00&amrule=MAX&recur=MONTHLY&validitystart=04102026&validityend=04102031&umn=UMN8822719@hdfcbank" }),
        ctx,
      ),
    );
    expect(o).toMatchObject({ kind: "mandate", window: "pre_spend", stage: "intent" });
    expect(o.subscription).toEqual({ event: "signup", serviceName: "Netflix", period: "P1M", price: { minor: 64_900, currency: "INR" } });
    expect(o.amount).toMatchObject({ approximate: true });
    expect(o.references).toContainEqual({ type: "mandate_id", value: "UMN8822719@hdfcbank", namespace: "upi" });
    expect(o.typeHints?.[0]).toMatchObject({ type: "subscription" });
    expect(o.evidence.summary).toContain("up to");
  });

  it("is deterministic across re-delivery", () => {
    const a = only(adapter.parse(signal({ uri: STATIC_MERCHANT, launchedAt: T0 }), ctx));
    const b = only(adapter.parse(signal({ uri: STATIC_MERCHANT, launchedAt: T0 }, T0 + 5_000), ctx));
    expect(a.id).toBe(b.id);
    const c = only(adapter.parse(signal({ uri: STATIC_MERCHANT, launchedAt: T0 + 60_000 }), ctx));
    expect(c.id).not.toBe(a.id);
  });

  it("ignores non-UPI links and rejects malformed UPI links", () => {
    expect(adapter.parse(signal({ uri: "https://example.com" }), ctx)).toEqual({ status: "ignored", reason: "unsupported_format" });
    const bad = adapter.parse(signal({ uri: "upi://pay?pa=shop@okaxis&am=abc" }), ctx);
    expect(bad.status).toBe("rejected");
    expect(adapter.parse(signal({} as UpiIntentPayload), ctx).status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */
/* Adversarial review: privacy, real-world URI drift, hostile payloads */
/* ------------------------------------------------------------------ */

/** Every observation must survive the store's own column and privacy checks (mirrors the Postgres schema). */
async function expectStorable(observations: readonly Observation[]): Promise<void> {
  const { createMemoryStore } = await import("../../core/src/store-memory");
  const store = createMemoryStore({ clock: fixedClock(T0) });
  const connectionIds = [...new Set(observations.map((o) => o.source.connectionId))];
  for (const connectionId of connectionIds) {
    await store.upsertConnection({
      connectionId,
      adapterId: "upi-intent",
      kind: "payment_intent",
      label: "UPI payment request",
      status: "active",
      scopes: [],
      purposes: [],
      retention: { excerptTtlMs: 7 * 86_400_000, observationTtlMs: null },
      grantedAt: T0,
      updatedAt: T0,
    });
  }
  await expect(store.putObservations(observations)).resolves.toBeDefined();
}

describe("UPI adversarial review", () => {
  const adapter = createUpiIntentAdapter();

  it("masks a phone number embedded in a mixed VPA local part (handle, namespace and summary)", () => {
    // Google Pay/BHIM let people pick handles such as "<name><mobile>@ok…"; the number is personal data.
    const o = only(adapter.parse(signal({ uri: "upi://pay?pa=rahul9876543210@okaxis&pn=Rahul%20S&tr=REF77&am=200" }), ctx));
    const json = JSON.stringify(o);
    expect(json).not.toContain("9876543210");
    expect(o.counterparty?.handle).toBe("••••3210@okaxis");
    expect(maskUpiHandle("rahul9876543210@okaxis")).toBe("••••3210@okaxis");
    // Business-only handles are public and stay joinable.
    expect(maskUpiHandle("q123456789@ybl")).toBe("q123456789@ybl");
  });

  it("accepts account-number + IFSC VPAs (Accountnumber@IFSC.ifsc.npci) and never keeps the account number", async () => {
    // Format published by NPCI's India Stack: "Accountnumber@ifsccode.ifsc.npci".
    const uri = "upi://pay?pa=50100123456789@HDFC0001234.ifsc.npci&pn=Asha%20Traders&am=150.00&cu=INR";
    expect(parseUpiUri(uri)?.payeeAddress).toBe("50100123456789@hdfc0001234.ifsc.npci");
    const o = only(adapter.parse(signal({ uri }), ctx));
    expect(o.counterparty?.handle).toBe("••••6789@hdfc0001234.ifsc.npci");
    expect(JSON.stringify(o)).not.toContain("50100123456789");
    expect(o.amount?.value).toEqual({ minor: 15_000, currency: "INR" });
    await expectStorable([o]);
    // E-mail addresses are still not VPAs.
    expect(decodeUpiUri("upi://pay?pa=shop@example.com")).toEqual({ ok: false, error: "invalid_payee" });
  });

  it("reads URIs whose '&' separators were HTML-escaped by the page that rendered them", () => {
    const r = parseUpiUri("upi://pay?pa=freshmart@ybl&amp;pn=Fresh%20Mart&amp;am=99.50&amp;cu=INR");
    expect(r).toMatchObject({ payeeAddress: "freshmart@ybl", payeeName: "Fresh Mart", amount: "99.50" });
  });

  it("never throws on hostile payload fields and never names an app after an Object.prototype key", () => {
    const a = adapter.parse(signal({ uri: STATIC_MERCHANT, sourceApp: 5 as unknown as string }), ctx);
    expect(a.status).toBe("observations");
    const b = only(adapter.parse(signal({ uri: STATIC_MERCHANT, sourceApp: "toString" }), ctx));
    expect(b.evidence.summary).not.toContain("toString");
    expect(adapter.parse({ adapterId: "upi-intent", connectionId: "c", receivedAt: T0, payload: "upi://pay" as unknown as UpiIntentPayload }, ctx).status).toBe("rejected");
  });

  it("falls back to receivedAt for launch times the store cannot hold (fractional or absurd)", async () => {
    const o = only(adapter.parse(signal({ uri: STATIC_MERCHANT, launchedAt: 1759554660.123 }), ctx));
    expect(o.occurredAt?.value).toBe(T0);
    const p = only(adapter.parse(signal({ uri: STATIC_MERCHANT, launchedAt: 9e15 }), ctx));
    expect(p.occurredAt?.value).toBe(T0);
    await expectStorable([o, p]);
  });
});

describe("UPI fusion keys", () => {
  it("an order id in the merchant's reference URL uses the merchant key the e-mail adapter uses", async () => {
    const { lookupSender } = await import("../src/email/senders");
    const o = only(createUpiIntentAdapter().parse(signal({ uri: DYNAMIC_SIGNED }), ctx));
    expect(o.references).toContainEqual({ type: "order_id", value: "88231", namespace: lookupSender("noreply@swiggy.in")?.info.key ?? "swiggy" });
  });
});
