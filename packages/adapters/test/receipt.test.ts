import { describe, expect, it } from "vitest";
import { DAY, fixedClock } from "@brake/core";
import type { AdapterContext, AdapterResult, Observation, RawSignal } from "@brake/core";
import { createReceiptAdapter, parseReceiptText } from "../src/receipt";
import type { ReceiptPayload } from "../src/receipt";

const T0 = Date.UTC(2026, 9, 4, 18, 0, 0);
const ctxIN: AdapterContext = { clock: fixedClock(T0), country: "IN", locale: "en-IN", defaultCurrency: "INR", timeZone: "Asia/Kolkata" };
const ctxUS: AdapterContext = { clock: fixedClock(T0), country: "US", locale: "en-US", defaultCurrency: "USD", timeZone: "America/Chicago" };
const ctxBR: AdapterContext = { clock: fixedClock(T0), country: "BR", locale: "pt-BR", defaultCurrency: "BRL", timeZone: "America/Sao_Paulo" };
const ctxDE: AdapterContext = { clock: fixedClock(T0), country: "DE", locale: "de-DE", defaultCurrency: "EUR", timeZone: "Europe/Berlin" };

const adapter = createReceiptAdapter();

function scan(ocrText: string, ctx: AdapterContext, source: ReceiptPayload["source"] = "photo", capturedAt = T0): AdapterResult {
  const signal: RawSignal<ReceiptPayload> = { adapterId: "receipt", connectionId: "conn_receipt", receivedAt: T0, payload: { ocrText, capturedAt, source } };
  return adapter.parse(signal, ctx);
}

function only(r: AdapterResult): Observation {
  if (r.status !== "observations") throw new Error(`expected observations, got ${JSON.stringify(r)}`);
  expect(r.observations).toHaveLength(1);
  return r.observations[0] as Observation;
}

const inr = (major: number) => ({ minor: Math.round(major * 100), currency: "INR" });
const usd = (major: number) => ({ minor: Math.round(major * 100), currency: "USD" });
const brl = (major: number) => ({ minor: Math.round(major * 100), currency: "BRL" });
const eur = (major: number) => ({ minor: Math.round(major * 100), currency: "EUR" });

// Layouts modelled on common POS formats: Indian GST restaurant bill (CGST/SGST split, "Bill No"),
// US grocery slip (tax flag letters, masked Visa, AUTH CODE), Brazilian NFC-e DANFE (item no., EAN,
// "UN X", "Valor a pagar", Lei 12.741 tax note), German Kassenbon (tax-class letters, SUMME, girocard).
const EN_IN = `TAX INVOICE
Cafe Coffee Day
Brigade Road, Bengaluru 560001
GSTIN: 29AABCC1234D1ZQ
Bill No: CCD/2041   Date: 04/10/26 13:05
Item Qty Rate Amount
Cappuccino 2 180.00 360.00
Chocolate Fantasy 1 240.00 240.00
Total 600.00
CGST @ 2.5% 15.00
SGST @ 2.5% 15.00
Grand Total ₹630.00
Paid by UPI
UPI Ref No: 427713268894
Thank you! Visit again`;

const EN_US = `TRADER JOE'S
123 Main St
Springfield, IL 62701
(217) 555-0143
BANANAS 0.69
ORGANIC MILK 2% GAL 5.49 F
SOURDOUGH BREAD 4.99
GREEK YOGURT 2 @ 3.29 6.58
SUBTOTAL 17.75
TAX 0.12
TOTAL $17.87
VISA ************4821
VISA 17.87
AUTH CODE: 08154Z
TRANS #: 004512
10/04/2026 07:42 PM
CHANGE DUE 0.00
Return policy: refunds within 30 days with receipt`;

const PT_BR = `PADARIA SAO JOAO LTDA
CNPJ: 12.345.678/0001-90
Rua das Flores, 123 - Centro - São Paulo/SP
DOCUMENTO AUXILIAR DA NOTA FISCAL DE CONSUMIDOR ELETRÔNICA
001 7891000100103 LEITE INTEGRAL 1L 2 UN X 4,99 9,98
002 7896004000016 PAO FRANCES KG 0,5 KG X 18,90 9,45
003 CAFE EXPRESSO 1 UN X 6,50 6,50
Qtd. total de itens 3
Valor total R$ 25,93
Desconto R$ 0,00
Valor a pagar R$ 25,93
FORMA PAGAMENTO VALOR PAGO
Cartão de Débito 25,93
NFC-e nº 000123456 Série 001 04/10/2026 10:41:22
Tributos totais incidentes (Lei Federal 12.741/2012): R$ 3,12`;

const DE_DE = `REWE Markt GmbH
Musterstraße 12
10115 Berlin
UID Nr.: DE123456789
EUR
Vollmilch 3,5% 1,19 A
Bananen 1,49 A
Bio Vollkornbrot 2,99 A
Zwischensumme 5,67
Rabatt -0,50
--------------------
SUMME EUR 5,17
Geg. Karte EUR 5,17
girocard
Nr. ############4321
Steuer % Netto Steuer Brutto
A= 7,0% 4,83 0,34 5,17
Datum: 04.10.2026 Uhrzeit: 10:41
Bon-Nr.: 4711`;

describe("en-IN restaurant bill", () => {
  it("prefers Grand Total over Total, sums CGST+SGST, reads UPI ref and bill number", () => {
    const o = only(scan(EN_IN, ctxIN));
    expect(o).toMatchObject({
      kind: "receipt",
      window: "post_spend",
      stage: "confirmed",
      direction: "debit",
      amount: { value: inr(630) },
      merchant: { raw: "Cafe Coffee Day", channel: "in_store" },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      instrument: { type: "upi_handle" },
      source: { adapterId: "receipt", kind: "receipt", label: "receipt photo", provider: "Cafe Coffee Day" },
    });
    expect(o.amountBreakdown).toEqual([
      { kind: "subtotal", amount: inr(600) },
      { kind: "tax", amount: inr(30) },
    ]);
    expect(o.lineItems).toEqual([
      { description: "Cappuccino", quantity: 2, unitPrice: inr(180), total: inr(360) },
      { description: "Chocolate Fantasy", quantity: 1, unitPrice: inr(240), total: inr(240) },
    ]);
    expect(o.references).toEqual([
      { type: "invoice_id", value: "CCD/2041", namespace: "cafecoffeeday" },
      { type: "rail_reference", value: "427713268894", namespace: "upi" },
    ]);
    // 13:05 IST
    expect(o.occurredAt).toEqual({ value: Date.UTC(2026, 9, 4, 7, 35, 0), confidence: 0.85 });
    expect(o.confidence).toBeGreaterThanOrEqual(0.75);
    expect(o.evidence.summary).toBe("Receipt photo from Cafe Coffee Day: ₹630 (2 items), paid by UPI.");
  });
});

describe("en-US grocery slip", () => {
  it("reads total (not subtotal/visa/change), tax, items, masked card and auth code", () => {
    const o = only(scan(EN_US, ctxUS));
    expect(o.amount?.value).toEqual(usd(17.87));
    expect(o.amountBreakdown).toEqual([
      { kind: "subtotal", amount: usd(17.75) },
      { kind: "tax", amount: usd(0.12) },
    ]);
    expect(o.lineItems?.map((i) => [i.description, i.total?.minor, i.quantity])).toEqual([
      ["BANANAS", 69, undefined],
      ["ORGANIC MILK 2% GAL", 549, undefined],
      ["SOURDOUGH BREAD", 499, undefined],
      ["GREEK YOGURT", 658, 2],
    ]);
    expect(o.instrument).toEqual({ type: "card", network: "visa", last4: "4821" });
    expect(o.rail).toEqual({ family: "card", scheme: "visa" });
    expect(o.references).toEqual([
      { type: "receipt_id", value: "004512", namespace: "traderjoes" },
      { type: "auth_code", value: "08154Z", namespace: "traderjoes" },
    ]);
    // 7:42 PM Central (CDT, UTC-5); month-first because the locale is US.
    expect(o.occurredAt?.value).toBe(Date.UTC(2026, 9, 5, 0, 42, 0));
    // A "refunds within 30 days" footer is not a refund.
    expect(o.direction).toBe("debit");
    expect(o.typeHints).toBeUndefined();
    expect(o.evidence.summary).toBe("Receipt photo from TRADER JOE'S: $17.87 (4 items), paid by Visa ••4821.");
    expect(JSON.stringify(o)).not.toContain("************");
  });
});

describe("pt-BR NFC-e", () => {
  it("decimal commas, 'Valor a pagar', EAN product ids, debit card, NFC-e number", () => {
    const o = only(scan(PT_BR, ctxBR, "screenshot"));
    expect(o.amount?.value).toEqual(brl(25.93));
    expect(o.lineItems).toEqual([
      { description: "LEITE INTEGRAL 1L", quantity: 2, unitPrice: brl(4.99), total: brl(9.98), productId: "gtin:07891000100103" },
      { description: "PAO FRANCES", unitPrice: brl(18.9), total: brl(9.45), productId: "gtin:07896004000016" },
      { description: "CAFE EXPRESSO", quantity: 1, unitPrice: brl(6.5), total: brl(6.5) },
    ]);
    expect(o.amountBreakdown).toContainEqual({ kind: "tax", amount: brl(3.12) });
    expect(o.instrument).toEqual({ type: "card", cardKind: "debit" });
    expect(o.references).toContainEqual({ type: "invoice_id", value: "000123456", namespace: "padariasaojoaoltda" });
    expect(o.occurredAt?.value).toBe(Date.UTC(2026, 9, 4, 13, 41, 22)); // 10:41:22 BRT (UTC-3)
    expect(o.merchant).toMatchObject({ raw: "PADARIA SAO JOAO LTDA", channel: "unknown" });
    expect(o.source.label).toBe("receipt screenshot");
  });
});

describe("de-DE Kassenbon", () => {
  it("SUMME after discount beats Zwischensumme; girocard with ### mask; Bon-Nr.", () => {
    const o = only(scan(DE_DE, ctxDE));
    expect(o.amount?.value).toEqual(eur(5.17));
    expect(o.amountBreakdown).toEqual([
      { kind: "subtotal", amount: eur(5.67) },
      { kind: "discount", amount: eur(0.5) },
    ]);
    expect(o.lineItems?.map((i) => i.description)).toEqual(["Vollmilch 3,5%", "Bananen", "Bio Vollkornbrot"]);
    expect(o.instrument).toEqual({ type: "card", network: "girocard", last4: "4321" });
    expect(o.references).toContainEqual({ type: "receipt_id", value: "4711", namespace: "rewemarktgmbh" });
    expect(o.occurredAt?.value).toBe(Date.UTC(2026, 9, 4, 8, 41, 0)); // 10:41 CEST
    expect(parseReceiptText(DE_DE, ctxDE).validated).toBe(true);
  });
});

describe("total disambiguation", () => {
  it("cash tendered and change never win over the total", () => {
    const r = parseReceiptText("JOE'S DINER\nBurger 12.50\nFries 4.00\nTOTAL 16.50\nCASH 20.00\nCHANGE 3.50", { defaultCurrency: "USD" });
    expect(r.total).toEqual(usd(16.5));
    expect(r.totalSource).toBe("total");
    expect(r.payment).toEqual({ method: "cash" });
    expect(r.validated).toBe(true);
  });

  it("a discounted total wins over a larger subtotal; 'Total tax' and 'Total items' are not totals", () => {
    const r = parseReceiptText(
      "STYLE STORE\nShirt 60.00\nJeans 40.00\nSubtotal 100.00\nDiscount 10.00\nTotal tax 7.20\nTotal items 2\nTotal 97.20",
      { defaultCurrency: "USD" },
    );
    expect(r.total).toEqual(usd(97.2));
    expect(r.subtotal).toEqual(usd(100));
    expect(r.tax).toEqual(usd(7.2));
    expect(r.discount).toEqual(usd(10));
    expect(r.validated).toBe(true);
  });

  it("falls back to a card payment line, then to the sum of items (approximate)", () => {
    expect(parseReceiptText("KIOSK\nWater 1.50\nVISA 1.50", { defaultCurrency: "EUR" }).totalSource).toBe("paid");
    const o = only(scan("FARM STAND\nTomatoes 3.20\nBasil 2.00", ctxUS));
    expect(o.amount).toMatchObject({ value: usd(5.2), approximate: true });
  });

  it("'Gesamt'/'Total a pagar' keywords in other languages", () => {
    expect(parseReceiptText("Bäckerei Schmidt\nBrezel 0,90\nKaffee 2,40\nGesamt 3,30", { defaultCurrency: "EUR", locale: "de-DE" }).total).toEqual(eur(3.3));
    expect(parseReceiptText("Restaurante Sol\nPrato do dia 32,00\nSubtotal 32,00\nTaxa de serviço 3,20\nTotal a pagar 35,20", { defaultCurrency: "BRL" })).toMatchObject({
      total: brl(35.2),
      tip: brl(3.2),
      validated: true,
    });
  });
});

describe("confidence and quality", () => {
  it("PDFs and validated totals score higher than noisy photos", () => {
    const pdf = only(scan(EN_US, ctxUS, "pdf"));
    const photo = only(scan(EN_US, ctxUS, "photo"));
    const noisy = only(scan(EN_US.replace("BANANAS 0.69", "B@N^N~S 0.69 ¬¬").replace("SOURDOUGH BREAD 4.99", "S0URD0UGH BR£AD 4.9O ~~"), ctxUS, "photo"));
    expect(pdf.confidence).toBeGreaterThan(photo.confidence);
    expect(photo.confidence).toBeGreaterThan(noisy.confidence);
    expect(photo.confidence).toBeGreaterThanOrEqual(0.7);
    const unvalidated = only(scan("CORNER SHOP\nTOTAL 9.99", ctxUS, "photo"));
    expect(unvalidated.confidence).toBeLessThanOrEqual(0.65);
  });
});

describe("refunds, privacy, determinism, non-receipts", () => {
  it("a return slip is a credit with a refund hint", () => {
    const o = only(scan("BEST BUY\nMERCHANDISE RETURN\nAirPods Pro 249.99\nSUBTOTAL 249.99\nTAX 20.62\nTOTAL 270.61\nVISA ************1111", ctxUS));
    expect(o.direction).toBe("credit");
    expect(o.typeHints).toEqual([{ type: "refund", confidence: 0.75, reason: "receipt:refund-keyword" }]);
    expect(o.evidence.summary.startsWith("Refund receipt from BEST BUY")).toBe(true);
  });

  it("keeps only a redacted, expiring excerpt and last-4 card digits", () => {
    const text = "QUICK MART\nCustomer: asha.k@example.com\nPhone +91 98765 43210\nSnacks 120.00\nTOTAL 120.00\nCard 4111 1111 1111 1111";
    const o = only(scan(text, ctxIN));
    const json = JSON.stringify(o);
    expect(json).not.toContain("4111 1111 1111 1111");
    expect(json).not.toContain("98765");
    expect(o.instrument?.last4).toBe("1111");
    expect(o.evidence.excerpt).toContain("a•••@example.com");
    expect(o.evidence.excerptExpiresAt).toBe(T0 + 7 * DAY);
  });

  it("ignores future-dated misreads and falls back to capture time", () => {
    const o = only(scan("CORNER SHOP\nDate: 04/10/2029\nTOTAL 9.99", ctxUS));
    expect(o.occurredAt).toEqual({ value: T0, confidence: 0.3, approximate: true });
  });

  it("is deterministic for the same receipt text", () => {
    expect(only(scan(EN_IN, ctxIN)).id).toBe(only(scan(EN_IN, ctxIN, "photo", T0 + 60_000)).id);
  });

  it("ignores non-receipts, unreadable receipts and OTP screenshots", () => {
    expect(scan("Meeting notes\nDiscuss roadmap with team", ctxUS)).toEqual({ status: "ignored", reason: "not_financial" });
    expect(scan("RECEIPT\nTOTAL\nTHANK YOU", ctxUS)).toEqual({ status: "ignored", reason: "unsupported_format" });
    expect(scan("Your OTP is 482913 for the payment of Rs 630 at Cafe Coffee Day", ctxIN)).toEqual({ status: "ignored", reason: "otp" });
    expect(adapter.parse({ adapterId: "receipt", connectionId: "c", receivedAt: T0, payload: { capturedAt: T0, source: "photo" } as unknown as ReceiptPayload }, ctxIN).status).toBe("rejected");
  });
});
