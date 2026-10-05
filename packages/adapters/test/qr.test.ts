import { describe, expect, it } from "vitest";
import { fixedClock } from "@brake/core";
import type { AdapterContext, AdapterResult, Observation, RawSignal } from "@brake/core";
import { createQrAdapter } from "../src/qr";
import type { QrScanPayload } from "../src/qr";

const T0 = Date.UTC(2026, 9, 4, 5, 11, 0);
const ctxIN: AdapterContext = { clock: fixedClock(T0), country: "IN", locale: "en-IN", defaultCurrency: "INR" };
const ctxBR: AdapterContext = { clock: fixedClock(T0), country: "BR", locale: "pt-BR", defaultCurrency: "BRL" };
const ctxTH: AdapterContext = { clock: fixedClock(T0), country: "TH", locale: "th-TH", defaultCurrency: "THB" };

const adapter = createQrAdapter();

function scan(text: string, ctx: AdapterContext = ctxIN, scannedAt?: number): AdapterResult {
  const payload: QrScanPayload = scannedAt === undefined ? { text } : { text, scannedAt };
  const signal: RawSignal<QrScanPayload> = { adapterId: "qr", connectionId: "conn_qr", receivedAt: T0, payload };
  return adapter.parse(signal, ctx);
}

function only(r: AdapterResult): Observation {
  if (r.status !== "observations") throw new Error(`expected observations, got ${JSON.stringify(r)}`);
  expect(r.observations).toHaveLength(1);
  return r.observations[0] as Observation;
}

function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
const tlv = (id: string, value: string): string => `${id}${String(Array.from(value).length).padStart(2, "0")}${value}`;
const withCrc = (body: string): string => `${body}6304${crc16(`${body}6304`)}`;

// Banco Central do Brasil manual example (static Pix, EVP key) and dtinth/promptpay-qr vectors.
const PIX_BCB_STATIC =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";
const PROMPTPAY_PHONE = "00020101021129370016A000000677010111011300668012345675802TH530376463046197";
const PROMPTPAY_AMOUNT = "00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469";

describe("QR dispatch: UPI", () => {
  it("a dynamic UPI QR (amount fixed) is an in-spend checkout at the counter", () => {
    const o = only(scan("upi://pay?pa=sharmastore@okaxis&pn=Sharma%20General%20Store&mc=5411&tr=BILL-7781&am=1249.00&cu=INR", ctxIN, T0 - 1_000));
    expect(o).toMatchObject({
      kind: "checkout",
      window: "in_spend",
      stage: "intent",
      amount: { value: { minor: 124_900, currency: "INR" } },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      source: { adapterId: "qr", kind: "qr_scan", label: "BRAKE QR scan", provider: "UPI" },
      occurredAt: { value: T0 - 1_000, confidence: 0.95 },
    });
    expect(o.merchant).toMatchObject({ name: "Sharma General Store", mcc: "5411", handle: "sharmastore@okaxis", channel: "in_store" });
    expect(o.references).toEqual([{ type: "merchant_reference", value: "BILL-7781", namespace: "sharmastore@okaxis" }]);
    expect(o.evidence.summary).toMatch(/^You scanned a UPI QR code: UPI payment of ₹1,249 to Sharma General Store/);
  });

  it("a static UPI sticker (no amount) is a pre-spend purchase intent", () => {
    const o = only(scan("upi://pay?pa=sharmastore@okaxis&pn=Sharma%20General%20Store&mc=5411"));
    expect(o).toMatchObject({ kind: "purchase_intent", window: "pre_spend", stage: "intent", intent: { via: "qr", title: "Sharma General Store" } });
    expect(o.amount).toBeUndefined();
  });

  it("rejects a malformed UPI QR instead of guessing", () => {
    expect(scan("upi://pay?pa=sharmastore&pn=Shop").status).toBe("rejected");
  });
});

describe("QR dispatch: EMV merchant-presented codes", () => {
  it("a static Pix code (BCB example) becomes a pre-spend intent to the payee", () => {
    const o = only(scan(PIX_BCB_STATIC, ctxBR));
    expect(o).toMatchObject({
      kind: "purchase_intent",
      window: "pre_spend",
      rail: { family: "account_to_account_instant", scheme: "pix" },
      country: "BR",
      source: { provider: "Pix" },
    });
    expect(o.amount).toBeUndefined();
    // MCC 0000 is a placeholder, and "***" is the static-code txid placeholder.
    expect(o.categoryHints).toBeUndefined();
    expect(o.references).toEqual([]);
    expect(o.counterparty).toMatchObject({ name: "Fulano de Tal", handle: "123e4567-e12b-12d1-a456-426655440000" });
  });

  it("a dynamic Pix code with amount is a checkout with MCC, txid and merchant", () => {
    const payload = withCrc(
      tlv("00", "01") +
        tlv("01", "12") +
        tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", "12345678000195")) +
        tlv("52", "5812") +
        tlv("53", "986") +
        tlv("54", "45.90") +
        tlv("58", "BR") +
        tlv("59", "PADARIA SAO JOAO") +
        tlv("60", "SAO PAULO") +
        tlv("62", tlv("05", "PEDIDO12345")),
    );
    const o = only(scan(payload, ctxBR));
    expect(o).toMatchObject({
      kind: "checkout",
      window: "in_spend",
      amount: { value: { minor: 4_590, currency: "BRL" }, confidence: 0.95, approximate: false },
      merchant: { raw: "PADARIA SAO JOAO", mcc: "5812", handle: "12345678000195", channel: "in_store" },
      categoryHints: [{ scheme: "mcc", value: "5812", confidence: 0.85 }],
      references: [{ type: "merchant_reference", value: "PEDIDO12345", namespace: "12345678000195" }],
    });
    expect(o.typeHints?.[0]).toMatchObject({ type: "purchase" });
    // pt-BR currency formatting puts a no-break space after "R$".
    expect(o.evidence.summary).toMatch(/Pix payment of R\$\s45,90 to PADARIA SAO JOAO, SAO PAULO \(dynamic code\)/);
  });

  it("a dynamic Pix code whose charge sits behind a location URL is a checkout without fetching it", () => {
    const payload = withCrc(
      tlv("00", "01") +
        tlv("01", "12") +
        tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("25", "qr.example-psp.com.br/v2/9d36b84fc70b478fb95c12729b90ca25")) +
        tlv("52", "0000") +
        tlv("53", "986") +
        tlv("58", "BR") +
        tlv("59", "LOJA EXEMPLO") +
        tlv("60", "RIO DE JANEIRO") +
        tlv("62", tlv("05", "***")),
    );
    const o = only(scan(payload, ctxBR));
    expect(o.kind).toBe("checkout");
    expect(o.amount).toBeUndefined();
    expect(o.evidence.summary).toContain("amount shown in your bank app");
  });

  it("PromptPay to a phone number: masked payee, P2P hint; with amount: checkout", () => {
    const p2p = only(scan(PROMPTPAY_PHONE, ctxTH));
    expect(p2p.kind).toBe("purchase_intent");
    expect(p2p.counterparty?.handle).toBe("••••4567");
    expect(p2p.typeHints?.[0]).toMatchObject({ type: "transfer", transferKind: "p2p_other" });
    expect(JSON.stringify(p2p)).not.toContain("0801234567");
    const withAmount = only(scan(PROMPTPAY_AMOUNT, ctxTH));
    expect(withAmount).toMatchObject({ kind: "checkout", amount: { value: { minor: 422, currency: "THB" } }, rail: { scheme: "promptpay" }, country: "TH" });
  });

  it("QRIS with a tip prompt is approximate; fixed convenience fees are added", () => {
    const qris = withCrc(
      tlv("00", "01") +
        tlv("01", "12") +
        tlv("26", tlv("00", "ID.CO.TELKOM.WWW") + tlv("01", "936008980266352075") + tlv("02", "000195266352075") + tlv("03", "UMI")) +
        tlv("51", tlv("00", "ID.CO.QRIS.WWW") + tlv("02", "ID1021125405972") + tlv("03", "UMI")) +
        tlv("52", "5499") +
        tlv("53", "360") +
        tlv("54", "25000") +
        tlv("55", "01") +
        tlv("58", "ID") +
        tlv("59", "BIOLBE") +
        tlv("60", "KAB. MALANG"),
    );
    const o = only(scan(qris, { clock: fixedClock(T0), country: "ID", defaultCurrency: "IDR" }));
    expect(o).toMatchObject({ kind: "checkout", amount: { value: { minor: 2_500_000, currency: "IDR" }, approximate: true }, rail: { scheme: "qris" } });
    expect(o.merchant?.handle).toBe("936008980266352075");

    const fee = withCrc(
      tlv("00", "01") + tlv("01", "12") + tlv("26", tlv("00", "A0000006150001") + tlv("01", "890053") + tlv("02", "0000000123")) +
        tlv("52", "5812") + tlv("53", "458") + tlv("54", "20.00") + tlv("55", "02") + tlv("56", "0.50") + tlv("58", "MY") + tlv("59", "NASI LEMAK ALI") + tlv("60", "KUALA LUMPUR"),
    );
    const f = only(scan(fee, { clock: fixedClock(T0), country: "MY" }));
    expect(f.amount?.value).toEqual({ minor: 2_050, currency: "MYR" });
    expect(f.amountBreakdown).toEqual([
      { kind: "subtotal", amount: { minor: 2_000, currency: "MYR" } },
      { kind: "fee", amount: { minor: 50, currency: "MYR" } },
    ]);
  });

  it("a Bharat QR carrying a UPI VPA is routed as a UPI payment", () => {
    const bharat = withCrc(
      tlv("00", "01") + tlv("01", "12") + tlv("02", "4403847800001234") +
        tlv("26", tlv("00", "A000000524") + tlv("01", "sharmastore@okaxis")) +
        tlv("27", tlv("00", "A000000524") + tlv("01", "BILL-7781")) +
        tlv("52", "5411") + tlv("53", "356") + tlv("54", "1249.00") + tlv("58", "IN") + tlv("59", "SHARMA GENERAL STORE") + tlv("60", "PUNE"),
    );
    const o = only(scan(bharat));
    expect(o.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(o.references).toContainEqual({ type: "merchant_reference", value: "BILL-7781", namespace: "sharmastore@okaxis" });
    expect(o.source.provider).toBe("Bharat QR");
  });

  it("rejects an EMV code whose CRC does not match", () => {
    const corrupted = PIX_BCB_STATIC.replace("BRASILIA", "BRASILIO");
    const r = scan(corrupted, ctxBR);
    expect(r).toEqual({ status: "rejected", reason: "invalid EMV QR: crc_mismatch" });
  });
});

describe("QR dispatch: links and everything else", () => {
  it("a product link becomes a pre-spend purchase intent via qr, without query or tracking", () => {
    const o = only(scan("https://www.amazon.in/Apple-AirPods-Pro-2nd-Generation/dp/B0CHWRXH8B/ref=qr_code?tag=poster-21&utm_source=print"));
    expect(o).toMatchObject({
      kind: "purchase_intent",
      window: "pre_spend",
      intent: { via: "qr", url: "https://www.amazon.in/Apple-AirPods-Pro-2nd-Generation/dp/B0CHWRXH8B", productId: "asin:B0CHWRXH8B", title: "Apple AirPods Pro 2nd Generation" },
      merchant: { name: "Amazon", key: "amazon", website: "amazon.in" },
    });
    expect(JSON.stringify(o)).not.toContain("utm_source");
  });

  it("a GS1 Digital Link on a package yields a GTIN without inventing a merchant", () => {
    const o = only(scan("https://id.gs1.org/01/09506000134352"));
    expect(o.intent).toMatchObject({ via: "qr", productId: "gtin:09506000134352" });
    expect(o.merchant).toBeUndefined();
  });

  it("ignores non-financial codes and drops OTPs", () => {
    expect(scan("https://example.com/menu")).toEqual({ status: "ignored", reason: "not_financial" });
    expect(scan("WIFI:S:CafeGuest;T:WPA;P:hunter22;;")).toEqual({ status: "ignored", reason: "not_financial" });
    expect(scan("BEGIN:VCARD\nFN:Jane\nEND:VCARD")).toEqual({ status: "ignored", reason: "not_financial" });
    expect(scan("   ")).toEqual({ status: "ignored", reason: "not_financial" });
    expect(scan("Your OTP is 482913. Do not share it.")).toEqual({ status: "ignored", reason: "otp" });
  });

  it("is deterministic for the same scan", () => {
    const a = only(scan(PIX_BCB_STATIC, ctxBR, T0));
    const b = only(scan(PIX_BCB_STATIC, ctxBR, T0));
    expect(a.id).toBe(b.id);
  });
});

/* ------------------------------------------------------------------ */
/* Adversarial review                                                  */
/* ------------------------------------------------------------------ */

async function expectStorable(observations: readonly Observation[]): Promise<void> {
  const { createMemoryStore } = await import("../../core/src/store-memory");
  const store = createMemoryStore({ clock: fixedClock(T0) });
  for (const connectionId of new Set(observations.map((o) => o.source.connectionId))) {
    await store.upsertConnection({
      connectionId,
      adapterId: "qr",
      kind: "qr_scan",
      label: "BRAKE QR scan",
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

describe("QR adversarial review", () => {
  it("a QRIS merchant PAN that passes Luhn is masked, so the scan is storable and no card-shaped number leaks", async () => {
    // QRIS MPANs are 16–19 digit "9360…" numbers (terryds/qris-decoder vector above); about one in ten passes Luhn.
    const mpan = "9360091500001234564";
    const qris = withCrc(
      tlv("00", "01") + tlv("01", "11") +
        tlv("26", tlv("00", "ID.CO.BANKMANDIRI.WWW") + tlv("01", mpan) + tlv("02", "000195266352075") + tlv("03", "UMI")) +
        tlv("51", tlv("00", "ID.CO.QRIS.WWW") + tlv("02", "ID1021125405972") + tlv("03", "UMI")) +
        tlv("52", "5499") + tlv("53", "360") + tlv("58", "ID") + tlv("59", "WARUNG SARI") + tlv("60", "JAKARTA"),
    );
    const o = only(scan(qris, { clock: fixedClock(T0), country: "ID", defaultCurrency: "IDR" }));
    expect(JSON.stringify(o)).not.toContain(mpan);
    expect(o.merchant?.handle).toBe("••••4564");
    await expectStorable([o]);
  });

  it("an EMV amount longer than the 13 characters tag 54 allows is not turned into an unsafe integer", async () => {
    const big = withCrc(
      tlv("00", "01") + tlv("01", "12") + tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", "12345678000195")) +
        tlv("52", "5812") + tlv("53", "986") + tlv("54", "9".repeat(40)) + tlv("58", "BR") + tlv("59", "PADARIA") + tlv("60", "SAO PAULO"),
    );
    const o = only(scan(big, ctxBR));
    expect(o.amount).toBeUndefined();
    await expectStorable([o]);
  });

  it("falls back to receivedAt when scannedAt is not whole epoch milliseconds", async () => {
    const o = only(scan(PIX_BCB_STATIC, ctxBR, 1759554660.5));
    expect(o.occurredAt?.value).toBe(T0);
    await expectStorable([o]);
  });

  it("every published vector in this suite yields storable observations", async () => {
    const outs = [PIX_BCB_STATIC, PROMPTPAY_PHONE, PROMPTPAY_AMOUNT].map((t) => only(scan(t, ctxTH)));
    await expectStorable(outs);
  });
});

describe("QR unstorable text", () => {
  it("a UPI payee name or EMV merchant name carrying NUL or a lone surrogate is cleaned, not stored raw", async () => {
    const upi = only(scan("upi://pay?pa=shop@okaxis&pn=Fresh%00Mart%ED%A0%BD&am=10"));
    expect(upi.counterparty?.name).toBe("FreshMart%ED%A0%BD");
    const emv = only(scan(withCrc(tlv("00", "01") + tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", "12345678000195")) + tlv("53", "986") + tlv("58", "BR") + tlv("59", "LOJA\u0000 \ud83d") + tlv("60", "RIO")), ctxBR));
    expect(JSON.stringify(emv)).not.toContain("\\u0000");
    await expectStorable([upi, emv]);
  });
});
