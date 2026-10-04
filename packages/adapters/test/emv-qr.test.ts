import { describe, expect, it } from "vitest";
import { decodeEmvQr, detectEmvScheme, emvCrc16, maskPayeeId, parseEmvQr, parseEmvTlv } from "../src/emv-qr";

/*
 * Test helper: an independent CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
 * over UTF-8 bytes, so payloads built here are valid without trusting the
 * implementation under test.
 */
function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** One TLV data object; length counts characters (code points). */
const tlv = (id: string, value: string): string => `${id}${String(Array.from(value).length).padStart(2, "0")}${value}`;

/** Append the CRC object ("6304" + checksum over everything including "6304"). */
const withCrc = (body: string): string => `${body}6304${crc16(`${body}6304`)}`;

// Published examples (CRC re-verified with the helper above):
// Banco Central do Brasil, "Manual de Padrões para Iniciação do Pix" — static BR Code with an EVP key.
const PIX_BCB_STATIC =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";
// dtinth/promptpay-qr test vectors (widely used Thai PromptPay generator).
const PROMPTPAY_PHONE = "00020101021129370016A000000677010111011300668012345675802TH530376463046197";
const PROMPTPAY_AMOUNT = "00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469";
// terryds/qris-decoder README: a real QRIS sticker (Telkom acquirer, NMID in tag 51).
const QRIS_STATIC =
  "00020101021126680016ID.CO.TELKOM.WWW011893600898026635207502150001952663520750303UMI51440014ID.CO.QRIS.WWW0215ID10211254059720303UMI5204549953033605502015802ID5906BIOLBE6011KAB. MALANG610565168622005091147938120703A03630404CB";

describe("CRC-16/CCITT-FALSE", () => {
  it("matches the checksums printed in published payloads", () => {
    for (const payload of [PIX_BCB_STATIC, PROMPTPAY_PHONE, PROMPTPAY_AMOUNT, QRIS_STATIC]) {
      expect(emvCrc16(payload.slice(0, -4))).toBe(payload.slice(-4));
      expect(crc16(payload.slice(0, -4))).toBe(payload.slice(-4));
    }
  });

  it("matches the standard check value for '123456789'", () => {
    // CRC-16/CCITT-FALSE check value from the CRC catalogue.
    expect(emvCrc16("123456789")).toBe("29B1");
  });
});

describe("parseEmvQr", () => {
  it("parses the BCB static Pix example", () => {
    const qr = parseEmvQr(PIX_BCB_STATIC);
    expect(qr).not.toBeNull();
    expect(qr?.formatIndicator).toBe("01");
    expect(qr?.merchantAccounts[0]).toMatchObject({ tag: "26", guid: "br.gov.bcb.pix", fields: { "01": "123e4567-e12b-12d1-a456-426655440000" } });
    expect(qr).toMatchObject({ mcc: "0000", currencyNumeric: "986", currency: "BRL", countryCode: "BR", merchantName: "Fulano de Tal", merchantCity: "BRASILIA", crc: "1D3D" });
    expect(qr?.additionalData?.referenceLabel).toBe("***");
    expect(qr?.amount).toBeUndefined();
    expect(detectEmvScheme(PIX_BCB_STATIC)).toBe("pix");
  });

  it("parses PromptPay static and dynamic payloads", () => {
    const stat = parseEmvQr(PROMPTPAY_PHONE);
    expect(stat).toMatchObject({ initiation: "static", currency: "THB", countryCode: "TH" });
    expect(stat?.merchantAccounts[0]).toMatchObject({ tag: "29", guid: "A000000677010111", fields: { "01": "0066801234567" } });
    const dyn = parseEmvQr(PROMPTPAY_AMOUNT);
    expect(dyn).toMatchObject({ initiation: "dynamic", amount: "4.22", currency: "THB" });
    expect(detectEmvScheme(PROMPTPAY_PHONE)).toBe("promptpay");
  });

  it("parses a real QRIS sticker with nested templates and tip indicator", () => {
    const qr = parseEmvQr(QRIS_STATIC);
    expect(qr).toMatchObject({ mcc: "5499", currency: "IDR", countryCode: "ID", merchantName: "BIOLBE", merchantCity: "KAB. MALANG", postalCode: "65168" });
    expect(qr?.tip).toEqual({ mode: "prompt" });
    expect(qr?.additionalData).toMatchObject({ referenceLabel: "114793812", terminalLabel: "A03" });
    expect(qr?.merchantAccounts.map((a) => a.guid)).toEqual(["ID.CO.TELKOM.WWW", "ID.CO.QRIS.WWW"]);
    expect(detectEmvScheme(QRIS_STATIC)).toBe("qris");
  });

  it("parses a dynamic Pix code with amount, MCC and txid", () => {
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
    const qr = parseEmvQr(payload);
    expect(qr).toMatchObject({ initiation: "dynamic", amount: "45.90", currency: "BRL", mcc: "5812" });
    expect(qr?.additionalData?.referenceLabel).toBe("PEDIDO12345");
  });

  it("parses PayNow inside SGQR and prefers the PayNow profile", () => {
    const payload = withCrc(
      tlv("00", "01") +
        tlv("01", "12") +
        tlv("26", tlv("00", "SG.PAYNOW") + tlv("01", "2") + tlv("02", "201403121W") + tlv("03", "0") + tlv("04", "20261231")) +
        tlv("51", tlv("00", "SG.SGQR") + tlv("01", "190101000000A1")) +
        tlv("52", "5814") +
        tlv("53", "702") +
        tlv("54", "12.50") +
        tlv("58", "SG") +
        tlv("59", "KOPI CORNER PTE LTD") +
        tlv("60", "Singapore") +
        tlv("62", tlv("01", "INV-2041")),
    );
    const qr = parseEmvQr(payload);
    expect(qr).toMatchObject({ currency: "SGD", amount: "12.50", countryCode: "SG" });
    expect(qr?.additionalData?.billNumber).toBe("INV-2041");
    expect(detectEmvScheme(payload)).toBe("paynow");
    // Without the PayNow template the code is identified as SGQR.
    const sgqrOnly = withCrc(tlv("00", "01") + tlv("51", tlv("00", "SG.SGQR") + tlv("01", "190101000000A1")) + tlv("52", "5814") + tlv("53", "702") + tlv("58", "SG") + tlv("59", "KOPI") + tlv("60", "SG"));
    expect(detectEmvScheme(sgqrOnly)).toBe("sgqr");
  });

  it("counts lengths in characters for localised names (tag 64) and CRCs over UTF-8", () => {
    const payload = withCrc(
      tlv("00", "01") +
        tlv("29", tlv("00", "A000000677010111") + tlv("01", "0066812345678")) +
        tlv("53", "764") +
        tlv("58", "TH") +
        tlv("59", "COFFEE CORNER") +
        tlv("60", "BANGKOK") +
        tlv("64", tlv("00", "TH") + tlv("01", "ร้านกาแฟมุม") + tlv("02", "กรุงเทพ")),
    );
    const qr = parseEmvQr(payload);
    expect(qr?.language).toEqual({ preference: "TH", merchantName: "ร้านกาแฟมุม", merchantCity: "กรุงเทพ" });
  });

  it("accepts a lower-case CRC", () => {
    const payload = PIX_BCB_STATIC.slice(0, -4) + PIX_BCB_STATIC.slice(-4).toLowerCase();
    expect(parseEmvQr(payload)?.crc).toBe("1D3D");
  });
});

describe("rejection", () => {
  it("rejects a payload whose CRC does not match (one character changed)", () => {
    const corrupted = PIX_BCB_STATIC.replace("Fulano de Tal", "Fulana de Tal");
    expect(parseEmvQr(corrupted)).toBeNull();
    expect(decodeEmvQr(corrupted)).toEqual({ ok: false, error: "crc_mismatch" });
    const wrongCrc = `${PROMPTPAY_PHONE.slice(0, -4)}6198`;
    expect(decodeEmvQr(wrongCrc)).toEqual({ ok: false, error: "crc_mismatch" });
  });

  it("rejects truncated TLV, a missing CRC and non-EMV text", () => {
    expect(decodeEmvQr(PIX_BCB_STATIC.slice(0, 40))).toEqual({ ok: false, error: "malformed_tlv" });
    expect(decodeEmvQr(`000201${tlv("59", "SHOP")}`)).toEqual({ ok: false, error: "missing_crc" });
    expect(decodeEmvQr("upi://pay?pa=a@ybl")).toEqual({ ok: false, error: "not_emv" });
    expect(parseEmvTlv("0002")).toBeNull();
    expect(detectEmvScheme("hello")).toBeNull();
  });
});

describe("detectEmvScheme profiles", () => {
  const base = (accounts: string, country: string, currency: string): string =>
    withCrc(tlv("00", "01") + accounts + tlv("52", "5411") + tlv("53", currency) + tlv("58", country) + tlv("59", "SHOP") + tlv("60", "CITY"));

  it("recognises DuitNow, VietQR, KHQR, QR Ph and PromptPay bill payment", () => {
    expect(detectEmvScheme(base(tlv("26", tlv("00", "A0000006150001") + tlv("01", "890053") + tlv("02", "0000000123")), "MY", "458"))).toBe("duitnow");
    expect(
      detectEmvScheme(base(tlv("38", tlv("00", "A000000727") + tlv("01", tlv("00", "970436") + tlv("01", "0011001234567")) + tlv("02", "QRIBFTTA")), "VN", "704")),
    ).toBe("vietqr");
    expect(detectEmvScheme(base(tlv("30", tlv("00", "coffee_shop@aclb") + tlv("01", "MID001")), "KH", "116"))).toBe("khqr");
    expect(detectEmvScheme(base(tlv("27", tlv("00", "ph.ppmi.p2m") + tlv("01", "BNORPHMMXXX")), "PH", "608"))).toBe("qrph");
    expect(detectEmvScheme(base(tlv("30", tlv("00", "A000000677010112") + tlv("01", "0105536012345")), "TH", "764"))).toBe("promptpay");
  });

  it("recognises Bharat QR, plain UPI-in-EMV and card-network codes", () => {
    const bharat = base(tlv("02", "4403847800001234") + tlv("26", tlv("00", "A000000524") + tlv("01", "sharmastore@okaxis")), "IN", "356");
    expect(detectEmvScheme(bharat)).toBe("bharatqr");
    const upiOnly = base(tlv("26", tlv("00", "A000000524") + tlv("01", "sharmastore@okaxis")), "IN", "356");
    expect(detectEmvScheme(upiOnly)).toBe("upi");
    const visa = base(tlv("02", "4403847800001234"), "US", "840");
    expect(detectEmvScheme(visa)).toBe("card");
    const unknown = base(tlv("26", tlv("00", "com.example.pay") + tlv("01", "X1")), "ZZ", "840");
    expect(detectEmvScheme(unknown)).toBe("unknown");
  });

  it("does not mistake a Pix e-mail key or a KHQR id for a UPI VPA", () => {
    const pixEmail = withCrc(tlv("00", "01") + tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", "loja@example.com")) + tlv("53", "986") + tlv("58", "BR") + tlv("59", "LOJA") + tlv("60", "RIO"));
    expect(detectEmvScheme(pixEmail)).toBe("pix");
  });
});

describe("maskPayeeId", () => {
  it("masks personal identifiers and keeps business ones", () => {
    expect(maskPayeeId("0066801234567")).toBe("••••4567"); // PromptPay mobile
    expect(maskPayeeId("123.456.789-09")).toBe("••••8909"); // CPF
    expect(maskPayeeId("+5511998765432")).toBe("••••5432"); // Pix phone key
    expect(maskPayeeId("fulano@example.com")).toBe("f•••@example.com");
    expect(maskPayeeId("9876543210@ybl")).toBe("••••3210@ybl");
    expect(maskPayeeId("12345678000195")).toBe("12345678000195"); // CNPJ (company)
    expect(maskPayeeId("123e4567-e12b-12d1-a456-426655440000")).toBe("123e4567-e12b-12d1-a456-426655440000"); // random EVP key
  });
});
