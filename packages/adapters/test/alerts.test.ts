import { describe, expect, it } from "vitest";
import { fixedClock, money, zonedTimeToEpoch } from "@brake/core";
import type { AdapterContext } from "@brake/core";
import {
  alertExcerpt,
  claimedIssuer,
  classifySender,
  isParsedAlert,
  normalizeAlertText,
  parseAlert,
  resolvePackage,
  resolveSender,
} from "../src/alerts/engine";
import type { AlertMeta, AlertParseResult, ParsedAlert } from "../src/alerts/engine";
import { ALERT_PACKS, ALERT_VOCABULARY, GENERIC_PACK, MESSAGING_APPS, packById } from "../src/alerts/packs";
import type { AlertPack } from "../src/alerts/packs";

/*
 * Fixtures. Unless marked otherwise, message structures come from
 * docs/research/07-sms-and-messaging-alerts.md (open-source parser fixtures:
 * PennyWise [22]-[43], transaction-sms-parser [52]); names, numbers and
 * references are anonymised. "(illustrative)" marks a structure assembled
 * from a parser's patterns rather than a verbatim fixture.
 */

const IST = "Asia/Kolkata";
const ctxOf = (country: string, defaultCurrency: string, timeZone: string, locale: string): AdapterContext => ({
  clock: fixedClock(0),
  country,
  defaultCurrency,
  timeZone,
  locale,
});
const IN = ctxOf("IN", "INR", IST, "en-IN");
const KE = ctxOf("KE", "KES", "Africa/Nairobi", "en-KE");
const US = ctxOf("US", "USD", "America/New_York", "en-US");

const at = (zone: string, year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
  zonedTimeToEpoch({ year, month, day, hour, minute, second }, zone);

/** 2026-10-04 10:41:20 IST: twenty seconds after the alerts below say the payment happened. */
const RECEIVED = at(IST, 2026, 10, 4, 10, 41, 20);

function parsed(r: AlertParseResult): ParsedAlert {
  if (!isParsedAlert(r)) throw new Error(`expected a parsed alert, got ${JSON.stringify(r)}`);
  return r;
}

function parse(sender: string, text: string, extra: Partial<AlertMeta> = {}): AlertParseResult {
  return parseAlert(text, { senderOrApp: sender, receivedAt: RECEIVED, ctx: IN, ...extra });
}

function pack(id: string): AlertPack {
  const p = packById(id);
  if (!p) throw new Error(`no pack ${id}`);
  return p;
}

/* ------------------------------------------------------------------ */

const HDFC_UPI = "Sent Rs.250.00\nFrom HDFC Bank A/C *1234\nTo SWIGGY\nOn 04/10/26\nRef 627712345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808";
const HDFC_CARD = "Spent Rs.1,249 From HDFC Bank Card x1234 At AMAZON On 2026-10-04:10:41:00 Not You? To Block+Reissue Call 18002586161/SMS BLOCK CC 1234 to 7308080808";
const CANARA_RTGS =
  "An amount of INR 13,30,614.75 has been credited to XXXX6785 on 02/12/2025 towards RTGS by Sender AXIS MUTUAL FUND REDEMPTION PO, IFSC UTIB0000004, Sender A/c XXXX9108, AXIS BANK, MUMBAI BRANCH, UTR UTIBR72025120200011461, Total Avail. Bal INR 2679815.88- Canara Bank";

interface TemplateFixture {
  readonly template: string;
  readonly sender: string;
  readonly text: string;
  readonly ctx?: AdapterContext;
  readonly pack?: string;
}

/** End of the Kenyan day, so every M-PESA time below is in the past. */
const KE_EVENING = at("Africa/Nairobi", 2026, 10, 4, 21, 0);

/** One realistic message per template, so every template in the packs is exercised. */
const TEMPLATE_FIXTURES: readonly TemplateFixture[] = [
  { template: "in.hdfc.upi_sent.v2", sender: "AX-HDFCBK-S", text: HDFC_UPI },
  { template: "in.hdfc.card_spent.v1", sender: "AX-HDFCBK-S", text: HDFC_CARD },
  {
    template: "in.icici.upi_debit.v1",
    sender: "JD-ICICIT-S",
    text: "ICICI Bank Acct XX123 debited for Rs 250.00 on 04-Oct-26; SWIGGY credited. UPI:627712345678. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766.",
  },
  {
    template: "in.icici.card_spent.v1",
    sender: "VM-ICICIB-S",
    text: "USD 11.80 spent using ICICI Bank Card XX4321 on 03-Oct-26 on NETFLIX.COM. Avl Limit: INR 2,48,751.00. If not you, call 1800 2662/SMS BLOCK 4321 to 9215676766.",
  },
  {
    template: "in.sbicard.spent.v1",
    sender: "VM-SBICRD-S",
    text: "Rs.1,249.00 spent on your SBI Credit Card ending 1234 at AMAZON on 04/10/26. Trxn. not done by you? Report at https://sbicard.com/Dispute",
  },
  {
    template: "in.sbi.upi_debit.v1",
    sender: "BZ-SBIUPI-S",
    text: "Dear UPI user A/C X1234 debited by 250.0 on date 04Oct26 trf to SWIGGY Refno 627712345678. If not u? call 1800111109. -SBI",
  },
  {
    template: "in.axis.upi_p2m.v1",
    sender: "AD-AXISBK-S",
    text: "INR 250.00 debited\nA/c no. XX1234\n04-10-26, 10:41:00\nUPI/P2M/627712345678/SWIGGY\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank",
  },
  {
    template: "in.axis.upi_p2a.v1",
    sender: "AD-AXISBK-S",
    text: "INR 500.00 debited\nA/c no. XX1234\n04-10-26, 10:41:00\nUPI/P2A/627712345679/RAHUL KUMAR\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank",
  },
  {
    template: "in.axis.card_spent.v1",
    sender: "AD-AXISBK-S",
    text: "Spent\nCard no. XX5678\nINR 1,249.00\n04-10-26 10:41:00\nAMAZON\nAvl Lmt INR 48,751.00\nSMS BLOCK 5678 to 919951860002, if not you - Axis Bank",
  },
  {
    template: "in.kotak.upi_sent.v3",
    sender: "JD-KOTAKD-S",
    text: "Sent Rs.205.00 from XXXXXX1234 to Ramesh Kumar on 04/10/2026. UPI ref no. 614812345678. Not you? Tap https://kotak.com/KBANKT/Fraud to report -Kotak",
  },
  {
    template: "in.bob.upi_dr.v1",
    sender: "BP-BOBTXN-S",
    text: "Rs.250.00 Dr. from A/C XXXXXX1234 and Cr. to swiggy@icici. Ref:627712345678. AvlBal:Rs12,345.67(2026:10:04 10:41:00). Not you? Call 18005700-BOB",
  },
  {
    template: "in.canara.upi_dr.v1",
    sender: "VK-CANBNK-S",
    text: "Dear Customer, Acct XXX123 Dr. INR 260.00 on 04/10/26 to SAMPLE MART; UPI: 123456789012; Bal INR 12,345.67.Not you? SMS BLOCKUPI to XXXXXXXXXX-CanaraBank",
  },
  {
    template: "ke.mpesa.send_money.v1",
    sender: "MPESA",
    ctx: KE,
    text: "SJ41AB2CDE Confirmed. Ksh1,200.00 sent to JOHN DOE 0712345678 on 4/10/26 at 10:41 AM. New M-PESA balance is Ksh5,432.10. Transaction cost, Ksh13.00.",
  },
  {
    template: "ke.mpesa.buy_goods.v1",
    sender: "MPESA",
    ctx: KE,
    text: "SJ41AB2CDF Confirmed. Ksh350.00 paid to NAIVAS SUPERMARKET. on 4/10/26 at 6:30 PM.New M-PESA balance is Ksh5,082.10. Transaction cost, Ksh0.00.",
  },
  {
    template: "ke.mpesa.paybill.v1",
    sender: "MPESA",
    ctx: KE,
    text: "SJ41AB2CDG Confirmed. Ksh2,500.00 sent to KPLC PREPAID for account 37123456789 on 4/10/26 at 8:15 PM New M-PESA balance is Ksh2,582.10. Transaction cost, Ksh33.00.",
  },
  {
    template: "ke.mpesa.received.v1",
    sender: "MPESA",
    ctx: KE,
    text: "SJ41AB2CDH Confirmed.You have received Ksh2,000.00 from JANE WANJIKU 0723456789 on 4/10/26 at 9:15 AM New M-PESA balance is Ksh7,432.10.",
  },
  {
    template: "ke.mpesa.airtime.v1",
    sender: "MPESA",
    ctx: KE,
    text: "SJ41AB2CDL confirmed.You bought Ksh100.00 of airtime on 4/10/26 at 12:01 PM.New M-PESA balance is Ksh4,332.10. Transaction cost, Ksh0.00.",
  },
  {
    template: "ke.mpesa.withdraw.v1",
    sender: "MPESA",
    ctx: KE,
    text: "SJ41AB2CDJ Confirmed.on 4/10/26 at 11:00 AMWithdraw Ksh3,000.00 from 123456 - MAMA MBOGA AGENCIES New M-PESA balance is Ksh4,432.10. Transaction cost, Ksh67.00.",
  },
  {
    template: "br.nubank.compra.v1",
    sender: "com.nu.production",
    pack: "br.nubank",
    text: "Compra aprovada. Compra de R$ 45,90 APROVADA em PADARIA PAO QUENTE para o cartão com final 1234.",
  },
  {
    template: "us.chase.transaction.v1",
    sender: "24273",
    ctx: US,
    text: "Chase Freedom Unlimited: You made a $9.17 transaction with TACO BELL on Mar 17, 2026 at 1:56 PM ET.",
  },
];

describe("alert packs (data)", () => {
  it("ships at least 25 packs with unique ids, namespaces and package names", () => {
    expect(ALERT_PACKS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(ALERT_PACKS.map((p) => p.id)).size).toBe(ALERT_PACKS.length);
    expect(new Set(ALERT_PACKS.map((p) => p.namespace)).size).toBe(ALERT_PACKS.length);
    const packages = ALERT_PACKS.flatMap((p) => p.packages ?? []);
    expect(new Set(packages).size).toBe(packages.length);
    for (const m of MESSAGING_APPS) expect(packages).not.toContain(m.packageName);
    expect(GENERIC_PACK.kind).toBe("generic");
  });

  it("covers India, Kenya, Brazil, the US, the UK, Nigeria and Indonesia", () => {
    const countries = new Set(ALERT_PACKS.map((p) => p.country));
    for (const c of ["IN", "KE", "BR", "US", "GB", "NG", "ID"]) expect(countries).toContain(c);
  });

  it("is JSON data: every pattern is a string that compiles", () => {
    const json = JSON.parse(JSON.stringify(ALERT_PACKS)) as AlertPack[];
    expect(json).toEqual(ALERT_PACKS);
    for (const p of ALERT_PACKS) {
      for (const src of [...(p.senders ?? []), ...(p.displayNames ?? []), ...(p.claims ?? [])]) expect(() => new RegExp(src)).not.toThrow();
      for (const t of p.templates ?? []) {
        expect(() => new RegExp(t.pattern, t.flags ?? "i")).not.toThrow();
        expect(t.source.length).toBeGreaterThan(10);
      }
      for (const r of p.references ?? []) expect(() => new RegExp(r.pattern, r.flags ?? "i")).not.toThrow();
    }
    const v = ALERT_VOCABULARY;
    const lists = [v.promotionalDecisive, v.promotionalSoft, v.debitStrong, v.creditStrong, v.declined, v.refund, v.maskedInstrument];
    for (const src of lists.flat()) expect(() => new RegExp(src, "i")).not.toThrow();
    for (const r of [...v.parties, ...v.rails, ...v.references]) expect(() => new RegExp(r.pattern, r.flags ?? "i")).not.toThrow();
  });

  it("exercises every template with a realistic fixture", () => {
    const all = ALERT_PACKS.flatMap((p) => (p.templates ?? []).map((t) => t.id));
    for (const f of TEMPLATE_FIXTURES) {
      const extra: Partial<AlertMeta> = {
        ...(f.ctx ? { ctx: f.ctx } : {}),
        ...(f.ctx === KE ? { receivedAt: KE_EVENING } : {}),
        ...(f.pack ? { pack: pack(f.pack), verification: "package" as const } : {}),
      };
      const r = parsed(parse(f.sender, f.text, extra));
      expect(r.templateId, f.template).toBe(f.template);
      expect(r.confidence).toBeGreaterThanOrEqual(0.92);
    }
    expect(new Set(TEMPLATE_FIXTURES.map((f) => f.template))).toEqual(new Set(all));
  });
});

describe("sender identity", () => {
  it("classifies DLT headers, short codes, phone numbers, alphanumeric ids and display names", () => {
    expect(classifySender("AX-HDFCBK-S")).toEqual({ raw: "AX-HDFCBK-S", kind: "dlt", entity: "HDFCBK", dltSuffix: "S" });
    expect(classifySender("JD-KOTAKD-S").entity).toBe("KOTAKD");
    expect(classifySender("24273").kind).toBe("short_code");
    expect(classifySender("+91 98765 43210")).toMatchObject({ kind: "phone", entity: "+919876543210" });
    expect(classifySender("MPESA").kind).toBe("alphanumeric");
    expect(classifySender("Kotak Mahindra Bank", true).kind).toBe("display");
  });

  it("resolves senders to packs, preferring the more specific header", () => {
    expect(resolveSender("AX-HDFCBK-S")).toMatchObject({ verification: "sender_id", pack: { id: "in.hdfc" } });
    expect(resolveSender("VM-SBICRD-S").pack.id).toBe("in.sbicard");
    expect(resolveSender("VM-SBIUPI-S").pack.id).toBe("in.sbi");
    expect(resolveSender("MPESA").pack.id).toBe("ke.mpesa");
    // Display names verify only a sender a messaging app displayed (RCS), never an SMS address.
    expect(resolveSender("Kotak Mahindra Bank", ALERT_PACKS, "display")).toMatchObject({ verification: "display_name", pack: { id: "in.kotak" } });
    expect(resolveSender("Kotak Mahindra Bank", ALERT_PACKS, "sms").pack.id).toBe("generic");
    expect(resolveSender("VM-SARASB-S").verification).toBe("unverified_business");
    expect(resolveSender("+919876543210").verification).toBe("unverified_personal");
  });

  it("maps Android packages to packs and detects brand claims case-sensitively", () => {
    expect(resolvePackage("com.phonepe.app")?.displayName).toBe("PhonePe");
    expect(resolvePackage("com.safaricom.mpesa.lifestyle")?.id).toBe("ke.mpesa");
    expect(resolvePackage("com.whatsapp")).toBeUndefined();
    expect(claimedIssuer("Your Chase card was used")?.id).toBe("us.chase");
    expect(claimedIssuer("chase your dreams this weekend")).toBeUndefined();
    expect(claimedIssuer("Dana masuk Rp 500.000")).toBeUndefined();
  });
});

describe("dropping what must never be parsed", () => {
  it("drops OTP messages, including ones that name an amount and merchant", () => {
    const otps = [
      "482193 is the OTP for your txn of Rs.1,249.00 at AMAZON on HDFC Bank Card ending 1234. Valid for 5 mins. Do not share it with anyone.",
      // Canara sample from CanaraBankParserTest [41].
      "123456 is your OTP for a Dr. INR 500.00 transaction on your Canara Bank card. Do not share it with anyone.-Canara Bank",
      // An Amex SafeKey code was "booked as a card spend" by a keyword parser [32].
      "Your American Express SafeKey One-Time Password is 731904. Do not share this code with anyone.",
      "Nubank: seu código de verificação é 482913. Não compartilhe.",
    ];
    for (const text of otps) expect(parse("AX-HDFCBK-S", text)).toEqual({ ignored: "otp" });
  });

  it("treats India's -T (transactional/OTP) and -P (promotional) header categories as such", () => {
    expect(parse("AX-ICICIT-T", "Your transaction of Rs.1,249.00 at AMAZON requires authentication.")).toEqual({ ignored: "otp" });
    expect(parse("AX-HDFCBK-P", "Get a Personal Loan of up to Rs.5,00,000 at attractive rates!")).toEqual({ ignored: "promotional" });
  });

  it("drops promotions, even when they carry a masked account, but keeps real alerts with upsell tails", () => {
    expect(parse("AX-HDFCBK-S", "Dear Customer, your A/c XX1234 is pre-approved for a Personal Loan of Rs.5,00,000. Apply now")).toEqual({
      ignored: "promotional",
    });
    expect(parse("VM-PAYTMB-S", "Hurry! Get flat 10% cashback on electricity bill payments this weekend.")).toEqual({ ignored: "promotional" });
    const upsell = parsed(
      parse("AX-HDFCBK-S", "Spent Rs.25,000 From HDFC Bank Card x1234 At CROMA On 2026-10-04:10:41:00. Get up to 6 months no-cost EMI on this purchase"),
    );
    expect(upsell.amount?.value).toEqual(money(2_500_000, "INR"));
  });

  it("ignores bill reminders and non-financial text", () => {
    expect(parse("AX-HDFCBK-S", "Your HDFC Bank Credit Card statement has been generated. Total amount due Rs.12,345.00, pay by 15-10-26.")).toEqual({
      ignored: "unsupported_format",
    });
    expect(parse("VM-ABCDEF-S", "Your appointment is confirmed for tomorrow at 10:00.")).toEqual({ ignored: "not_financial" });
  });
});

describe("spoofed senders", () => {
  it("rejects an alert that claims a known bank but comes from a phone number", () => {
    const r = parse("+919876543210", "Dear HDFC Bank customer, Rs.9,999.00 debited from A/c XX1234. If not done by you, click http://hdfc-secure.co/verify to block.");
    expect(r).toMatchObject({ rejected: expect.stringContaining("HDFC Bank") });
  });

  it("rejects a look-alike header and an SMS claiming a push-only bank", () => {
    // "ICIClB" uses a lower-case L for the I.
    expect(parse("VM-ICIClB-S", "ICICI Bank Acct XX123 debited for Rs 4,999.00 on 04-Oct-26; RAHUL credited. UPI:627712345678.")).toHaveProperty("rejected");
    // Nubank sends purchase alerts only as app pushes; fake "compra aprovada" SMS are a known scam.
    const fake = parseAlert("NUBANK: Compra APROVADA de R$ 2.399,00 em MAGAZINE LUIZA. Nao reconhece? Ligue 0800 591 2117", {
      senderOrApp: "28149",
      receivedAt: RECEIVED,
      ctx: ctxOf("BR", "BRL", "America/Sao_Paulo", "pt-BR"),
    });
    expect(fake).toHaveProperty("rejected");
  });

  it("rejects fake M-PESA credits from ordinary numbers (a common Kenyan scam)", () => {
    const r = parseAlert(
      "SJ41AB2CDK Confirmed. You have received Ksh5,000.00 from JOHN DOE 0712345678 on 4/10/26 at 10:41 AM. New M-PESA balance is Ksh5,120.00.",
      { senderOrApp: "+254712345678", receivedAt: RECEIVED, ctx: KE },
    );
    expect(r).toMatchObject({ rejected: expect.stringContaining("M-PESA") });
  });

  it("accepts a verified bank naming another bank as the counterparty", () => {
    const r = parsed(
      parse("JD-ICICIT-S", "ICICI Bank Acct XX123 credited with Rs 5,000.00 on 04-Oct-26 from HDFC Bank A/c XX9876 by IMPS. IMPS Ref No 627712345678."),
    );
    expect(r.direction).toBe("credit");
    expect(r.references).toContainEqual({ type: "rail_reference", namespace: "imps", value: "627712345678" });
  });

  it("parses unknown senders that claim no known issuer at reduced confidence", () => {
    const business = parsed(parse("VM-SARASB-S", "Rs.500.00 debited from A/c XX7788 on 04-10-26 to VPA grocerymart@ybl (UPI Ref No 627799887766). Avl Bal Rs.4,500.00"));
    expect(business.pack.id).toBe("generic");
    expect(business.confidence).toBe(0.55);
    const phone = parsed(parse("+15551234567", "You spent $25.00 at CORNER DELI with card ending 4242.", { ctx: US }));
    expect(phone.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe("amounts", () => {
  it("takes the transaction amount, not the balance that follows (transaction-sms-parser README [52])", () => {
    const r = parsed(
      parseAlert("INR 2000 debited from A/c no. XX3423 on 05-02-19 07:27:11 IST at ECS PAY. Avl Bal- INR 2343.23.", {
        senderOrApp: "VM-BANKAL-S",
        receivedAt: Date.UTC(2019, 1, 5, 1, 57, 30),
        ctx: IN,
      }),
    );
    expect(r.amount?.value).toEqual(money(200_000, "INR"));
    expect(r.balance).toEqual(money(234_323, "INR"));
    expect(r.rail).toEqual({ family: "direct_debit", scheme: "nach" });
    expect(r.occurredAt).toEqual({ value: Date.UTC(2019, 1, 5, 1, 57, 11), confidence: 0.95 });
  });

  it("disambiguates a balance written before the amount", () => {
    const r = parsed(parse("AX-HDFCBK-S", "Your A/c XX1234 balance is Rs.10,000.50 after a debit of Rs.1,249.00 at AMAZON on 04-10-26."));
    expect(r.amount?.value).toEqual(money(124_900, "INR"));
    expect(r.balance).toEqual(money(1_000_050, "INR"));
  });

  it("reads Indian lakh grouping", () => {
    const r = parsed(parse("VA-CANBNK-S", CANARA_RTGS, { receivedAt: at(IST, 2025, 12, 2, 11, 30) }));
    expect(r.amount?.value).toEqual(money(133_061_475, "INR"));
    expect(r.balance).toEqual(money(267_981_588, "INR"));
    const big = parsed(parse("AX-HDFCBK-S", "Spent Rs.1,24,999.00 From HDFC Bank Card x1234 At APPLE STORE On 2026-10-04:10:41:00"));
    expect(big.amount?.value).toEqual(money(12_499_900, "INR"));
  });

  it("never treats a card's available limit as a balance, and keeps foreign-currency spends in their currency", () => {
    const r = parsed(parse("VM-ICICIB-S", TEMPLATE_FIXTURES[3]!.text));
    expect(r.amount?.value).toEqual(money(1_180, "USD"));
    expect(r.balance).toBeUndefined();
    expect(r.instrument).toMatchObject({ type: "card", last4: "4321", cardKind: "credit" });
    expect(r.country).toBeUndefined();
  });

  it("accepts an unmarked amount only right after a movement verb", () => {
    const r = parsed(parse("VM-UCOBNK-S", "A/c XX1234 debited by 75.50 on 04-10-26 for UPI txn 627712345678 to CHAI POINT."));
    expect(r.amount).toEqual({ value: money(7_550, "INR"), confidence: 0.85 });
  });

  it("excludes running totals and reads separate fees", () => {
    const monzo = parsed(parse("co.uk.getmondo", "£3.20 at Pret A Manger. ☕️ You've spent £12.40 today", { pack: pack("gb.monzo"), verification: "package" }));
    expect(monzo.amount?.value).toEqual(money(320, "GBP"));
    const mpesa = parsed(parse("MPESA", TEMPLATE_FIXTURES.find((f) => f.template === "ke.mpesa.paybill.v1")!.text, { ctx: KE, receivedAt: KE_EVENING }));
    expect(mpesa.amount?.value).toEqual(money(250_000, "KES"));
    expect(mpesa.fee).toEqual(money(3_300, "KES"));
    expect(mpesa.balance).toEqual(money(258_210, "KES"));
  });
});

describe("dates and times", () => {
  it("reads alert times in IST", () => {
    const axis = parsed(parse("AD-AXISBK-S", TEMPLATE_FIXTURES.find((f) => f.template === "in.axis.upi_p2m.v1")!.text));
    expect(axis.occurredAt).toEqual({ value: at(IST, 2026, 10, 4, 10, 41), confidence: 0.95 });
    expect(new Date(axis.occurredAt.value).toISOString()).toBe("2026-10-04T05:11:00.000Z");
    const bob = parsed(parse("BP-BOBTXN-S", TEMPLATE_FIXTURES.find((f) => f.template === "in.bob.upi_dr.v1")!.text));
    expect(bob.occurredAt.value).toBe(at(IST, 2026, 10, 4, 10, 41));
    const hdfc = parsed(parse("AX-HDFCBK-S", HDFC_CARD));
    expect(hdfc.occurredAt.value).toBe(at(IST, 2026, 10, 4, 10, 41));
  });

  it("uses the issuer's zone even when the user is travelling", () => {
    const roaming = parsed(parse("AX-HDFCBK-S", HDFC_CARD, { ctx: { ...IN, timeZone: "Europe/London" } }));
    expect(roaming.occurredAt.value).toBe(at(IST, 2026, 10, 4, 10, 41));
  });

  it("honours a zone written after the time", () => {
    const chase = parsed(
      parseAlert(TEMPLATE_FIXTURES.find((f) => f.template === "us.chase.transaction.v1")!.text, {
        senderOrApp: "24273",
        receivedAt: Date.UTC(2026, 2, 17, 17, 56, 30),
        ctx: { ...US, timeZone: "America/Los_Angeles" },
      }),
    );
    // 1:56 PM Eastern Daylight Time.
    expect(chase.occurredAt.value).toBe(Date.UTC(2026, 2, 17, 17, 56));
    expect(chase.window).toBe("in_spend");
  });

  it("encodes date precision in confidence", () => {
    // Same local day: the receipt time is the best estimate.
    const sameDay = parsed(parse("AX-HDFCBK-S", HDFC_UPI));
    expect(sameDay.occurredAt).toEqual({ value: RECEIVED, confidence: 0.85 });
    // Another day: local noon, flagged approximate, below 0.5 so fusion widens its window.
    const icici = parsed(parse("VM-ICICIB-S", TEMPLATE_FIXTURES[3]!.text));
    expect(icici.occurredAt).toEqual({ value: at(IST, 2026, 10, 3, 12, 0), confidence: 0.45, approximate: true });
    // No date at all.
    const phonepe = parsed(parse("com.phonepe.app", "Payment Successful. ₹250 paid to Swiggy Limited", { pack: pack("in.phonepe"), verification: "package" }));
    expect(phonepe.occurredAt).toEqual({ value: RECEIVED, confidence: 0.75 });
  });

  it("distrusts a stated time in the future of the receipt", () => {
    const text = "INR 250.00 debited\nA/c no. XX1234\n04-10-26, 23:59:00\nUPI/P2M/627712345678/SWIGGY\nAxis Bank";
    const r = parsed(parse("AD-AXISBK-S", text));
    expect(r.occurredAt).toEqual({ value: RECEIVED, confidence: 0.6 });
    expect(r.confidence).toBeLessThan(0.97);
  });

  it("reads the event's own date, not the original transaction's 'dated' date", () => {
    const r = parsed(
      parse("JD-KOTAKB-S", "Dear Customer, your UPI txn of Rs 250.00 dated 03-10-26 (UPI Ref 627712345678) has been reversed to your A/c XX1234 on 04-10-26. -Kotak Bank"),
    );
    expect(r.event).toBe("reversal");
    expect(r.occurredAt.value).toBe(RECEIVED);
  });

  it("swaps an impossible day-month order (RuPay credit card on UPI, m/d/yy [42])", () => {
    const r = parsed(
      parseAlert(
        "Rs.25.00 debited to your Edge CSB Bank RuPay Credit Card ending 6788 on 3/18/26, 6:39 PM - (UPI Ref no.702711160776). To dispute, call 18002669999",
        { senderOrApp: "JM-CSBBNK-S", receivedAt: at(IST, 2026, 3, 18, 18, 39, 40), ctx: IN },
      ),
    );
    expect(r.occurredAt.value).toBe(at(IST, 2026, 3, 18, 18, 39));
    // Rail is UPI while the instrument is a RuPay credit card: a later card bill must not double count it.
    expect(r.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(r.instrument).toMatchObject({ type: "card", cardKind: "credit", network: "rupay", last4: "6788" });
    expect(r.references).toEqual([{ type: "rail_reference", namespace: "upi", value: "702711160776" }]);
  });
});

describe("events, stages and windows", () => {
  it("marks real-time card authorizations in_spend and later alerts post_spend", () => {
    expect(parsed(parse("AX-HDFCBK-S", HDFC_CARD)).window).toBe("in_spend");
    expect(parsed(parse("AX-HDFCBK-S", HDFC_CARD, { receivedAt: RECEIVED + 10 * 60_000 })).window).toBe("post_spend");
    // Date-only alert: no proof it was real time.
    expect(parsed(parse("AX-HDFCBK-S", HDFC_UPI)).window).toBe("post_spend");
  });

  it("classifies declines, refunds, reversals, cash and holds", () => {
    const declined = parsed(parse("AX-HDFCBK-S", "Your HDFC Bank Credit Card ending 1234 was declined for Rs.4,999.00 at FLIPKART on 04-10-26 due to insufficient credit limit."));
    expect(declined).toMatchObject({ event: "declined", stage: "cancelled", direction: "debit" });
    const refund = parsed(parse("AX-HDFCBK-S", "Refund of Rs.1,249.00 from AMAZON has been credited to your HDFC Bank Credit Card ending 1234 on 04-10-26."));
    expect(refund).toMatchObject({ event: "refund", direction: "credit", stage: "confirmed", merchant: { raw: "AMAZON" } });
    expect(refund.typeHints[0]).toMatchObject({ type: "refund" });
    const atm = parsed(
      parse(
        "AX-SBIINB-S",
        "Dear Customer, Rs.2,000 withdrawn at SBI ATM S1NW000093009 from A/cX1234 on 04Oct26 Transaction Number 1234. Available Balance Rs.10,345.67. If not withdrawn by you, call 1800111109 -SBI",
      ),
    );
    expect(atm).toMatchObject({ event: "cash_withdrawal", rail: { family: "cash", scheme: "atm" }, balance: money(1_034_567, "INR") });
    expect(atm.merchant).toBeUndefined();
    expect(atm.typeHints).toEqual([{ type: "cash_withdrawal", confidence: 0.95, reason: "alert:cash-withdrawal" }]);
    const hold = parsed(
      parseAlert("Capital One: A charge or hold for $1,249.00 on October 4, 2026 was placed on your Quicksilver Credit Card (5678) at BEST BUY #123.", {
        senderOrApp: "227898",
        receivedAt: Date.UTC(2026, 9, 4, 16, 0),
        ctx: US,
      }),
    );
    expect(hold).toMatchObject({ stage: "pending", merchant: { raw: "BEST BUY #123" }, instrument: { last4: "5678", cardKind: "credit" } });
  });

  it("turns a UPI AutoPay pre-debit notice into an upcoming charge", () => {
    const r = parsed(
      parse("VM-ICICIB-S", "Your UPI-Mandate for Rs.649.00 towards NETFLIX will be debited on 12-Oct-26 from A/c XX1234. UMN: a1b2c3d4e5f6@ybl. To pause/revoke, use any UPI app. -ICICI Bank"),
    );
    expect(r).toMatchObject({ event: "autopay_upcoming", window: "pre_spend", stage: "intent", merchant: { raw: "NETFLIX" } });
    expect(r.nextChargeAt).toBe(at(IST, 2026, 10, 12, 12, 0));
    expect(r.references).toEqual([{ type: "mandate_id", namespace: "upi", value: "a1b2c3d4e5f6@ybl" }]);
  });

  it("recognises mandate set-up and cancellation", () => {
    const created = parsed(
      parse("BX-SBIUPI-S", "UPI AutoPay mandate for Spotify of max Rs.119.00 (Monthly) has been successfully created on your SBI A/c X1234. UMN 9f8e7d6c5b4a@axl. -SBI"),
    );
    expect(created).toMatchObject({ event: "mandate_created", stage: "confirmed", period: "P1M", merchant: { raw: "Spotify" } });
    const revoked = parsed(parse("JD-KOTAKB-S", "Your UPI AutoPay mandate for Spotify of Rs.119.00 has been revoked successfully. -Kotak Bank"));
    expect(revoked).toMatchObject({ event: "mandate_revoked", stage: "cancelled" });
  });

  it("emits balance-only alerts as balances", () => {
    const r = parsed(parse("VK-CANBNK-S", "Dear Customer, the available balance in your A/c XX1234 is INR 12,345.67 as on 04-10-26 10:00. -Canara Bank"));
    expect(r).toMatchObject({ event: "balance", balance: money(1_234_567, "INR"), stage: "unknown" });
    expect(r.amount).toBeUndefined();
  });
});

describe("instruments, parties and references", () => {
  it("keeps only the user's last four digits and never a three-digit tail", () => {
    const canara = parsed(parse("VA-CANBNK-S", CANARA_RTGS, { receivedAt: at(IST, 2025, 12, 2, 11, 30) }));
    // "Sender A/c XXXX9108" is the payer's account, not the user's.
    expect(canara.instrument).toEqual({ type: "bank_account", issuer: "Canara Bank", last4: "6785" });
    expect(canara.counterparty).toMatchObject({ name: "AXIS MUTUAL FUND REDEMPTION PO" });
    expect(canara.references).toEqual([{ type: "rail_reference", namespace: "rtgs", value: "UTIBR72025120200011461" }]);
    const icici = parsed(parse("JD-ICICIT-S", TEMPLATE_FIXTURES[2]!.text));
    expect(icici.instrument).toEqual({ type: "bank_account", issuer: "ICICI Bank" });
  });

  it("separates merchants (P2M) from people (P2A)", () => {
    const p2m = parsed(parse("AD-AXISBK-S", TEMPLATE_FIXTURES.find((f) => f.template === "in.axis.upi_p2m.v1")!.text));
    expect(p2m.merchant).toEqual({ raw: "SWIGGY", confidence: 0.9 });
    expect(p2m.counterparty).toBeUndefined();
    expect(p2m.typeHints[0]).toMatchObject({ type: "purchase" });
    const p2a = parsed(parse("AD-AXISBK-S", TEMPLATE_FIXTURES.find((f) => f.template === "in.axis.upi_p2a.v1")!.text));
    expect(p2a.merchant).toBeUndefined();
    expect(p2a.counterparty).toEqual({ name: "RAHUL KUMAR", isMerchant: 0.05 });
    expect(p2a.typeHints[0]).toMatchObject({ type: "transfer", transferKind: "p2p_other" });
  });

  it("masks personal payment handles and strips phone numbers from names", () => {
    const vpa = parsed(parse("VM-SARASB-S", "Rs.500.00 debited from A/c XX7788 on 04-10-26 to VPA 9876543210@ybl (UPI Ref No 627799887766)."));
    expect(vpa.counterparty).toMatchObject({ handle: "••••3210@ybl" });
    expect(vpa.counterparty?.isMerchant).toBeLessThan(0.2);
    const qr = parsed(parse("VM-SARASB-S", "Rs.80.00 debited from A/c XX7788 on 04-10-26 to VPA paytmqr281005050101@paytm (UPI Ref No 627799887767)."));
    expect(qr.merchant).toMatchObject({ handle: "paytmqr281005050101@paytm" });
    const mpesa = parsed(parse("MPESA", TEMPLATE_FIXTURES.find((f) => f.template === "ke.mpesa.send_money.v1")!.text, { ctx: KE, receivedAt: KE_EVENING }));
    expect(mpesa.counterparty).toEqual({ name: "JOHN DOE", isMerchant: 0.05 });
    expect(JSON.stringify(mpesa.counterparty)).not.toContain("0712345678");
  });

  it("extracts rail references in the right namespaces", () => {
    const mpesa = parsed(parse("MPESA", TEMPLATE_FIXTURES.find((f) => f.template === "ke.mpesa.buy_goods.v1")!.text, { ctx: KE, receivedAt: KE_EVENING }));
    expect(mpesa.references).toEqual([{ type: "rail_reference", namespace: "mpesa", value: "SJ41AB2CDF" }]);
    expect(mpesa.rail).toEqual({ family: "mobile_money", scheme: "mpesa" });
    const pix = parsed(
      parseAlert("Pix enviado com sucesso. Valor: R$ 89,90 para LOJA DO ZE LTDA. ID da transação: E60701190202610041041DY5I8R4BZ3P", {
        senderOrApp: "com.itau",
        receivedAt: RECEIVED,
        ctx: ctxOf("BR", "BRL", "America/Sao_Paulo", "pt-BR"),
        pack: pack("br.itau"),
        verification: "package",
      }),
    );
    expect(pix.references).toEqual([{ type: "rail_reference", namespace: "pix", value: "E60701190202610041041DY5I8R4BZ3P" }]);
    const auth = parsed(parse("VM-ICICIB-S", "Txn of USD 45.20 on ICICI Bank Card XX1234 at AMAZON US on 04-Oct-26. Approval Code 482913."));
    expect(auth.references).toEqual([{ type: "auth_code", namespace: "icici", value: "482913" }]);
  });

  it("does not invent rail references for card retrieval numbers", () => {
    const r = parsed(parse("AX-HDFCBK-S", "Spent Rs.500 From HDFC Bank Card x1234 At DMART On 2026-10-04:10:41:00 Ref No 123456789012"));
    expect(r.references).toEqual([]);
  });

  it("derives type and category hints from the alert's own words", () => {
    const salary = parsed(
      parseAlert("Credit Alert! Acct: ******4321 Amt: NGN 50,000.00 CR Desc: SALARY OCT 2026 ACME NIGERIA LTD Bal: NGN 70,000.00", {
        senderOrApp: "GTBank",
        receivedAt: RECEIVED,
        ctx: ctxOf("NG", "NGN", "Africa/Lagos", "en-NG"),
      }),
    );
    expect(salary.typeHints[0]).toMatchObject({ type: "income", reason: "alert:salary-keyword" });
    const kplc = parsed(parse("MPESA", TEMPLATE_FIXTURES.find((f) => f.template === "ke.mpesa.paybill.v1")!.text, { ctx: KE, receivedAt: KE_EVENING }));
    expect(kplc.categoryHints).toContainEqual({ scheme: "brake", value: "bills.utilities", confidence: 0.55 });
    const card = parsed(parse("AX-HDFCBK-S", "Paid Rs.3,000.00 towards your HDFC Bank Credit Card XX1234 via NEFT on 04-10-26. Thank you."));
    expect(card.typeHints[0]).toMatchObject({ type: "credit_card_payment" });
  });
});

describe("text handling", () => {
  /** Mathematical Sans-Serif, as SBI Card's RCS alerts use [25]. */
  const sansSerif = (s: string) =>
    [...s]
      .map((ch) => {
        const c = ch.charCodeAt(0);
        if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5a0 + c - 65);
        if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ba + c - 97);
        if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7e2 + c - 48);
        return ch;
      })
      .join("");

  it("normalizes styled Unicode with NFKC, keeping ₹", () => {
    expect(normalizeAlertText(`₹${sansSerif("250")} ${sansSerif("debited")}`)).toBe("₹250 debited");
    const r = parsed(
      parse("SBI CARDS", `${sansSerif("Rs.1,249.00 spent on your SBI Credit Card ending 1234 at AMAZON on 04/10/26")}.`, { senderKind: "display" }),
    );
    expect(r.pack.id).toBe("in.sbicard");
    expect(r.amount?.value).toEqual(money(124_900, "INR"));
    expect(r.confidence).toBe(0.92);
  });

  it("joins multi-line alerts and unglues M-PESA's run-together words", () => {
    expect(normalizeAlertText("INR 250.00 debited\nA/c no. XX1234\n")).toBe("INR 250.00 debited; A/c no. XX1234");
    expect(normalizeAlertText("Confirmed.on 4/10/26 at 11:00 AMWithdraw Ksh3,000.00")).toBe("Confirmed.on 4/10/26 at 11:00 AM Withdraw Ksh3,000.00");
    expect(normalizeAlertText("SJ41AB2CDH Confirmed.You have received")).toBe("SJ41AB2CDH Confirmed. You have received");
  });

  it("builds excerpts without links, references or account numbers", () => {
    const e = alertExcerpt(
      normalizeAlertText("Sent Rs.205.00 from XXXXXX1234 to Ramesh Kumar on 04/10/2026. UPI ref no. 614812345678. A/c 123456789012. Not you? Tap https://kotak.com/KBANKT/Fraud to report"),
    );
    expect(e).not.toMatch(/https?:|kotak\.com/);
    expect(e).not.toContain("614812345678");
    expect(e).not.toContain("123456789012");
    expect(e).toContain("••••5678");
    expect(e).toContain("Rs.205.00");
    expect(alertExcerpt("x".repeat(500)).length).toBe(240);
  });
});

/*
 * Adversarial-review regressions. Fixtures are verbatim test messages from
 * the PennyWise parser suite (research 07 [22]-[43]; file named per case),
 * except where marked "(illustrative)". Each one broke the engine before the
 * fix that accompanies it.
 */
describe("review regressions: amounts", () => {
  const BD = ctxOf("BD", "BDT", "Asia/Dhaka", "en-BD");
  const PK = ctxOf("PK", "PKR", "Asia/Karachi", "en-PK");

  it("keeps an amount glued to the next date apart from it (PNBBankParserTest)", () => {
    const r = parsed(
      parse(
        "VM-PNBSMS-S",
        "A/c XX1234 debited with Rs.5000.00,21-11-2025 13:23:22 thru card XX9239  . Out of 5 free txn on PNB ATM, you utilized 1 txn. Chrgs applicable as per policy. Bal 27000.00 CR. If not done, fwd SMS to 9264192641 to block card/call 18001800/18002021-PNB",
        { receivedAt: at(IST, 2025, 11, 21, 13, 23, 40) },
      ),
    );
    // Was ₹5,00,000.21: the date's day was read as two more decimals.
    expect(r.amount?.value).toEqual(money(500_000, "INR"));
    expect(r.occurredAt.value).toBe(at(IST, 2025, 11, 21, 13, 23, 22));
    // "fwd SMS to … to block card/call …" is boilerplate, not a payee.
    expect(r.merchant).toBeUndefined();
    expect(r.counterparty).toBeUndefined();
  });

  it("reads three-decimal and malformed separators without multiplying the amount (Federal, Faysal fixtures)", () => {
    const federal = parsed(
      parse("CP-FEDBNK-S", "Jerry Joseph has received Rs 6000.000 from your A/c XX3343 via NEFT on 24-06-2026 22:04:04. Ref no. FDRLM4175007432 - Federal Bank", {
        receivedAt: at(IST, 2026, 6, 24, 22, 4, 30),
      }),
    );
    // "6000.000" cannot be thousands grouping (a group never has four leading digits).
    expect(federal.amount?.value).toEqual(money(600_000, "INR"));
    // Someone else received money from the user's account.
    expect(federal.direction).toBe("debit");
    const faysal = parsed(
      parseAlert("PKR 55.000.00 sent to DEMO RECIPIENT A/C *9901 via IBFT from FBL A/C *1234 on 06-FEB-2026 02:22 PM Ref # 960855.", {
        senderOrApp: "FBL",
        receivedAt: at("Asia/Karachi", 2026, 2, 6, 14, 22, 30),
        ctx: PK,
      }),
    );
    // Research 07 §C: "PKR 55.000.00" is 55,000.00 written with a malformed separator; lower the amount's confidence.
    expect(faysal.amount?.value).toEqual(money(5_500_000, "PKR"));
    expect(faysal.amount?.confidence).toBeLessThan(0.9);
  });

  it("never reports the balance as the transaction amount, or the amount as the balance (UCO, Huntington fixtures)", () => {
    const uco = parsed(parse("VM-UCOBNK-S", "Your UCO Bank A/c XX1234 has been Debited with Rs..50 by Transfer.Avl Bal in your A/c is Rs.2,992.54."));
    // Was ₹2,992.54 (the balance) as the debit.
    expect(uco.amount?.value).toEqual(money(50, "INR"));
    expect(uco.balance).toEqual(money(299_254, "INR"));
    const uco2 = parsed(parse("VM-UCOBNK-S", "Rs..50 debited from A/c XX1234 by Transfer. Avl Bal Rs.2,992.54"));
    expect(uco2.amount?.value).toEqual(money(50, "INR"));
    const huntington = parsed(
      parseAlert("Huntington Heads Up. We processed a debit card withdrawal: $25.00 at Bob Inc. Acct CK0000 has a $10.12 bal (10/19/25 5:43 AM ET).", {
        senderOrApp: "HUNTINGTON",
        receivedAt: Date.UTC(2025, 9, 19, 9, 43, 30),
        ctx: US,
      }),
    );
    // Was a $25.00 *balance* snapshot: no movement verb, so the first amount became the balance.
    expect(huntington).toMatchObject({ event: "debit", direction: "debit", merchant: { raw: "Bob Inc" } });
    expect(huntington.amount?.value).toEqual(money(2_500, "USD"));
    expect(huntington.balance).toEqual(money(1_012, "USD"));
  });

  it("does not guess which of several unlabelled amounts is the balance (synthetic)", () => {
    expect(parse("VM-SARASB-S", "Balance update for A/c XX7788: Rs.5,000.00 and Rs.1,000.00 as on 04-10-26")).toEqual({ ignored: "unsupported_format" });
  });

  it("never reads an amount out of a link (TestCBEBankParser)", () => {
    const r = parseAlert(
      "Dear [Name] your Account 1*********9388 has been debited with ETB 25.00. Your Current Balance is ETB 3,079.87 Thank you for Banking with CBE! https://apps.cbe.com.et:100/?id=FT25256RP1FK27799388",
      { senderOrApp: "CBE", receivedAt: RECEIVED, ctx: ctxOf("ET", "ETB", "Africa/Addis_Ababa", "en-ET") },
    );
    // Was IDR 25,256 read from "FT25256RP1FK" inside the URL.
    expect(isParsedAlert(r) ? r.amount?.value.currency : undefined).not.toBe("IDR");
  });

  it("parses bKash cash-in, send-money and cash-out (TestBkashParser; cash-out illustrative)", () => {
    const cashIn = parsed(
      parseAlert("Cash In Tk 500.00 from 01900000000 successful. Fee Tk 0.00. Balance Tk 506.91. TrxID GHI9012RST at 29/05/2026 19:00. Download App: https://bKa.sh/8app", {
        senderOrApp: "bKash",
        receivedAt: at("Asia/Dhaka", 2026, 5, 29, 19, 0, 30),
        ctx: BD,
      }),
    );
    expect(cashIn).toMatchObject({ event: "credit", direction: "credit", amount: { value: money(50_000, "BDT") }, balance: money(50_691, "BDT") });
    expect(cashIn.references).toEqual([{ type: "rail_reference", namespace: "bkash", value: "GHI9012RST" }]);
    const send = parsed(
      parseAlert("Send Money Tk 0.20 to 01600000000 successful. Ref 2. Fee Tk 0.00. Balance Tk 0.08. TrxID JKL3456MNO at 07/06/2026 22:45.", {
        senderOrApp: "bKash",
        receivedAt: at("Asia/Dhaka", 2026, 6, 7, 22, 45, 30),
        ctx: BD,
      }),
    );
    expect(send).toMatchObject({ direction: "debit", amount: { value: money(20, "BDT") } });
    const cashOut = parsed(
      parseAlert("Cash Out Tk 1,000.00 to 01712345678 successful. Fee Tk 18.50. Balance Tk 19,249.91. TrxID BJQ1ABCDEH at 04/10/2026 11:10", {
        senderOrApp: "bKash",
        receivedAt: at("Asia/Dhaka", 2026, 10, 4, 11, 10, 30),
        ctx: BD,
      }),
    );
    expect(cashOut).toMatchObject({ event: "cash_withdrawal", amount: { value: money(100_000, "BDT") }, fee: money(1_850, "BDT") });
  });
});

describe("review regressions: what is and is not a money movement", () => {
  it("ignores bill reminders, payment requests and collect requests even when they say 'paid' (HDFC, Yes Bank, slice fixtures)", () => {
    const bill = "New Bill Alert:\nYour XUBA00000TST1A Bill 1234567890 of Rs.1500.00 is due on 15-Jan-2026. To pay, login to HDFC Bank Net/Mobile Banking>BillPay\nT&C. Ignore if paid";
    // Was a ₹1,500 debit "to pay" from a verified HDFC header.
    expect(parse("CP-HDFCBK-S", bill)).toEqual({ ignored: "unsupported_format" });
    expect(isParsedAlert(parse("CP-YESBNK-S", "Your Yes Bank Credit Card payment of INR 10,000 is due by 25-08-2025"))).toBe(false);
    expect(isParsedAlert(parse("CP-YESBNK-S", "Payment request of INR 500.00 from merchant@upi. Ignore if already paid."))).toBe(false);
    // Was a ₹500 *credit*: "received" a collect request.
    expect(isParsedAlert(parse("JD-SLICEIT-S", "You have received a collect request of Rs. 500 from someone@slc on slice. Approve or decline in the app. - slice"))).toBe(false);
  });

  it("treats mandate registrations as mandates, never as money moving (HDFC, PNB fixtures)", () => {
    const nach = parsed(
      parse("VM-HDFCBK-S", "Auto Pay HDFC Bank NACH Mandate : Rs. 100000.00 UMRN:HDFC7031703262015557 To:NationalSecuritiesClearin Freq ADHO received today for processing."),
    );
    // Was a ₹1,00,000 pending *credit*.
    expect(nach).toMatchObject({ event: "mandate_created", stage: "pending" });
    expect(nach.references).toContainEqual({ type: "mandate_id", namespace: "nach", value: "HDFC7031703262015557" });
    const pnb = parsed(
      parse(
        "VM-PNBSMS-S",
        "Dear Customer, auto pay facility has been successfully activated on your Punjab National Bank Card XX4356 for Rs. 75000.00, from Google Clouds. An initial amount of Rs. 2.00 has been debited from your account. Google Clouds can initiate subsequent transactions for a max amount upto Rs. 75000.00. You will receive notification with the transaction amount prior to any subsequent debits initiated by Google Clouds. Manage / cancel your Auto-Pay facility with ID RTy243262532g via https://www.sihub.in/man",
      ),
    );
    // Was a ₹75,000 debit: "auto pay" (with a space) was not recognised as a mandate.
    expect(pnb.event).toBe("mandate_created");
  });

  it("drops OTP messages whose code is masked or cut off (SliceParserTest, TestADCBParser)", () => {
    expect(parse("JD-SLICEIT-S", "5738xx is your OTP for txn of Rs. INR 2.07 at FamApp by TriO on slice card ending with 2887. Do not share OTP for security reasons. - slice")).toEqual({
      ignored: "otp",
    });
    expect(
      parse("ADCBAlert", "Do not share your OTP with anyone. If not initiated by you, please call BANK_HOTLINE. OTP for transaction at RETAILER for THB 25.00 on your ADCB Debit Car..."),
    ).toEqual({ ignored: "otp" });
    // A genuine alert with an OTP disclaimer is still an alert.
    expect(isParsedAlert(parse("AX-HDFCBK-S", "Rs.500.00 debited from A/c XX1234 on 04-10-26 to VPA swiggy@icici. Never share your OTP with anyone."))).toBe(true);
  });

  it("parses genuine alerts sent on -T headers but still drops -T authentication prompts (Federal, IDFC fixtures)", () => {
    const federal = parsed(
      parse("AD-FEDBNK-T", "Debited Rs 6000 from a/c XX3343 on 24JUN2026 21:35 via NEFT to Jerry.Ref FDRLM4175007432.Bal Rs 76.82.Not you?Call 18004251199 -Federal Bank", {
        receivedAt: at(IST, 2026, 6, 24, 21, 35, 30),
      }),
    );
    expect(federal).toMatchObject({ direction: "debit", amount: { value: money(600_000, "INR") } });
    const idfc = parsed(
      parse(
        "AX-IDFCBK-T",
        "Transaction Successful! GBP 150.00 spent on your IDFC FIRST Bank Credit Card ending XX9999 at LONDON SHOP on 20-APR-2025 at 03:45 PM Avbl Limit: INR 10000.00",
        { receivedAt: at(IST, 2025, 4, 20, 15, 45, 30) },
      ),
    );
    expect(idfc).toMatchObject({ amount: { value: money(15_000, "GBP") }, merchant: { raw: "LONDON SHOP" }, instrument: { last4: "9999" } });
    expect(parse("AX-ICICIT-T", "Your transaction of Rs.1,249.00 at AMAZON requires authentication.")).toEqual({ ignored: "otp" });
  });

  it("does not turn a failed reversal into a credit (STCBankParserTest)", () => {
    const r = parsed(
      parseAlert("Reversal of the original transaction was declined\nAmount: 35.79 SAR\nFrom: SYNTHETIC MERCHANT", {
        senderOrApp: "STCBank",
        receivedAt: RECEIVED,
        ctx: ctxOf("SA", "SAR", "Asia/Riyadh", "en-SA"),
      }),
    );
    expect(r).toMatchObject({ event: "declined", stage: "cancelled" });
  });

  it("does not book an M-PESA Fuliza overdraft notice as spending, and reads agent deposits as credits (illustrative)", () => {
    const fuliza = parse(
      "MPESA",
      "SJ41AB2CDQ Confirmed. Fuliza M-PESA amount is Ksh 150.00. Access Fee charged Ksh 1.50. Total Fuliza M-PESA outstanding amount is Ksh151.50 due on 03/11/26. To check daily charges, Dial *234*0#OK Select Query Charges",
      { ctx: KE, receivedAt: KE_EVENING },
    );
    expect(isParsedAlert(fuliza)).toBe(false);
    const deposit = parsed(
      parse("MPESA", "SJ41AB2CDR Confirmed. On 4/10/26 at 7:20 PM Give Ksh2,000.00 cash to MAMA MBOGA AGENCIES New M-PESA balance is Ksh10,432.10.", {
        ctx: KE,
        receivedAt: KE_EVENING,
      }),
    );
    // Was a balance snapshot only: the deposit itself was lost.
    expect(deposit).toMatchObject({ direction: "credit", amount: { value: money(200_000, "KES") }, balance: money(1_043_210, "KES") });
  });
});

describe("review regressions: direction, parties and hints", () => {
  it("reads direction from who received the money (ICICI, Kotak, IndusInd fixtures)", () => {
    const neft = parsed(
      parse("JD-ICICIT-S", "ICICI BANK NEFT Transaction with reference number IN12603221231681 for Rs. 22050.00 has been credited to the beneficiary account on 01-02-2026 at 10:32:51", {
        receivedAt: at(IST, 2026, 2, 1, 10, 33),
      }),
    );
    expect(neft.direction).toBe("debit");
    const cashback = parsed(parse("JD-KOTAKB-S", "Cashback of Rs.50.00 has been sent to your Kotak Bank A/c x5555. Credited on 14-10-25. UPI Ref 9999999999"));
    expect(cashback.direction).toBe("credit");
    const interest = parsed(
      parse("AD-INDUSIND-S", "Net interest INR 248.07 paid on your IndusInd Deposit No 300***123456 on 17/09/25. Call 18602677777 for assistance - IndusInd Bank"),
    );
    expect(interest.direction).toBe("credit");
    expect(interest.typeHints[0]).toMatchObject({ type: "income" });
  });

  it("understands more ways banks say debit and credit (South Indian, DOP, StanChart, HSBC, Chase UK fixtures; Chase deposit illustrative)", () => {
    const sib = parsed(
      parse("VM-SIBSMS-S", "UPI debit:Rs.599.00 A/c X7477, 16-10-25 16:25:29 RRN: 565526068910 Bal:Rs.12345.89 Block A/c? Call18004251809/SMS BLK<A/c>to 9840777222-South Indian Bank", {
        receivedAt: at(IST, 2025, 10, 16, 16, 25, 40),
      }),
    );
    expect(sib).toMatchObject({ direction: "debit", amount: { value: money(59_900, "INR") }, balance: money(1_234_589, "INR") });
    expect(sib.references).toContainEqual({ type: "rail_reference", namespace: "upi", value: "565526068910" });
    const dop = parsed(parse("VM-DOPBNK-S", "Account  No. XXXXXXXX1234 CREDIT with amount Rs. 5550.00 on 02-03-2026. Balance: Rs.40000.00. [S76543210]"));
    expect(dop).toMatchObject({ direction: "credit", amount: { value: money(555_000, "INR") } });
    const scb = parsed(parse("JK-SCBANK-S", "Dear Customer, there is an NEFT credit of INR 48,796.00 in your account 123xxxx7655 on 1/11/2025.Available Balance:INR 97,885.05 -StanChart"));
    expect(scb).toMatchObject({ direction: "credit", amount: { value: money(4_879_600, "INR") } });
    const hsbc = parsed(parse("VM-HSBCIN-S", "Thank you for using HSBC Debit Card XXXXX71xx at IKEA INDIA . for INR 49.00 on 12-04-25."));
    expect(hsbc).toMatchObject({ direction: "debit", amount: { value: money(4_900, "INR") }, merchant: { raw: "IKEA INDIA" } });
    const landed = parsed(
      parseAlert("🎉 £1,250.00 just landed in Test's Account from ACME LTD.", { senderOrApp: "ChaseUK", receivedAt: RECEIVED, ctx: ctxOf("GB", "GBP", "Europe/London", "en-GB") }),
    );
    expect(landed).toMatchObject({ direction: "credit", amount: { value: money(125_000, "GBP") } });
    const deposit = parsed(
      parseAlert("Chase: Your Total Checking account ending in 1234 had a direct deposit of $2,500.00 on Oct 4, 2026.", {
        senderOrApp: "24273",
        receivedAt: Date.UTC(2026, 9, 4, 16, 0),
        ctx: US,
      }),
    );
    expect(deposit).toMatchObject({ direction: "credit", amount: { value: money(250_000, "USD") } });
  });

  it("ends UPI 'Info' payees at the payee, keeping the balance out of the merchant (HDFC structure per PennyWise INFO_PATTERN; South Indian fixture)", () => {
    const hdfc = parsed(
      parse("VM-HDFCBK-S", "Update! INR 1,500.00 debited from HDFC Bank XX1234 on 04-OCT-26. Info: UPI/P2M/627712345678/ZOMATO LTD. Avl bal:INR 23,456.78"),
    );
    expect(hdfc.merchant?.raw).toBe("ZOMATO LTD");
    expect(hdfc.balance).toEqual(money(2_345_678, "INR"));
    const sib = parsed(
      parse("VM-SIBSMS-S", "UPI debit:INR Rs.250.50 in A/c X2468. Info:UPI/ICIC/222333444555/Demo Merchant on 26-12-25 19:05:01. Final balance is Rs.34317.17 -South Indian Bank", {
        receivedAt: at(IST, 2025, 12, 26, 19, 5, 30),
      }),
    );
    expect(sib.merchant?.raw ?? sib.counterparty?.name).toBe("Demo Merchant");
    expect(sib.balance).toEqual(money(3_431_717, "INR"));
  });

  it("keeps boilerplate and amounts out of payee names (illustrative M-PESA failure notice)", () => {
    const r = parsed(
      parse("MPESA", "Failed. You do not have enough money in your M-PESA account to send Ksh5,000.00. Your M-PESA balance is Ksh1,432.10.", { ctx: KE, receivedAt: KE_EVENING }),
    );
    expect(r.stage).toBe("cancelled");
    expect(r.merchant).toBeUndefined();
    expect(r.counterparty).toBeUndefined();
  });

  it("tags card-bill credits as card payments and never calls an ordinary credit an own-account transfer (ICICI, SBI fixtures)", () => {
    const icici = parsed(parse("AD-ICICIB-S", "Payment of Rs 26,266.00 has been received on your ICICI Bank Credit Card XX9006 through Bharat Bill Payment System on 06-DEC-25."));
    expect(icici.typeHints[0]).toMatchObject({ type: "credit_card_payment" });
    const sbiCard = parsed(parse("VM-SBICRD-S", "Your payment of Rs.1,644.55 has been credited to your SBI Credit Card ending with 5667. Your available limit is Rs.48,355.45."));
    expect(sbiCard.typeHints[0]).toMatchObject({ type: "credit_card_payment" });
    const p2p = parsed(parse("AD-ICICIB-S", "Dear Customer, Rs.5,000.00 has been credited to your ICICI Bank Acct XX123 on 04-Oct-26 from RAHUL SHARMA. UPI:627712345678."));
    // "credited to your Acct" names the user's own account, not an own-account *counterparty*.
    expect(p2p.typeHints.some((h) => h.transferKind === "own_account")).toBe(false);
  });
});

describe("review regressions: spoof detection", () => {
  it("does not reject genuine alerts from unknown banks that name a known brand as the other party (HSBC, BOI, Dhanlaxmi, CRED fixtures)", () => {
    const hsbc = parse(
      "VM-HSBCIN-S",
      "HSBC: Dear HSBC Customer, your NEFT transaction with reference number HSBCN00106726185 for INR 150,000.00 has been credited to the HDFC A/c XXXXXXXXXX6956 of AKASH KEDIA on 01-01-2026 at 15:36:47 .",
      { receivedAt: at(IST, 2026, 1, 1, 15, 37) },
    );
    expect(isParsedAlert(hsbc)).toBe(true);
    const boi = parsed(
      parse("JX-BOIIND-S", "BOI - Rs 15,000.00 Credited in your Ac XX5468 on 04-02-2026 By NEFTINWARD HDFCH00778553836/HDFC MUTUAL F .Avl Bal 18679.91"),
    );
    expect(boi).toMatchObject({ direction: "credit", amount: { value: money(1_500_000, "INR") } });
    const dhan = parsed(
      parse(
        "TL-DHANBK-S",
        'INR 50,000.00 is debited from A/c XXXX5678 on 15-DEC-2025 - "UPI TXN: /123456789012-MR /Payment from GPay". Aval Bal is INR 1,25,000.50. If not transacted call 044-42413000.-DhanlaxmiBank',
      ),
    );
    expect(dhan).toMatchObject({ direction: "debit", amount: { value: money(5_000_000, "INR") }, balance: money(12_500_050, "INR") });
    // A third-party payment app paying the user's ICICI card: plausible, but it speaks for the user's ICICI account
    // without being ICICI, so it stays low-confidence.
    const cred = parsed(
      parse("JK-CREDIN-S", "Payment of Rs.50,000 has been successfully credited towards your ICICI Bank Credit Card. Your payment was settled in 3 seconds - CRED"),
    );
    expect(cred.confidence).toBeLessThanOrEqual(0.4);
  });

  it("still rejects messages that pose as the issuer from another business sender", () => {
    // A known HDFC template from a header HDFC does not use (research 07 §E.2: "a known template from an unknown sender is a suspected spoof").
    expect(parse("VK-ALERTS-S", "Sent Rs.15000.00 From HDFC Bank A/C *1234 To TEST MERCHANT PVT LTD On 01/01/26 Ref 567890567890")).toHaveProperty("rejected");
    // Brand as the message's own header or signature.
    expect(parse("VK-ALERTS-S", "HDFC Bank: Rs.9,999.00 debited from A/c XX1234 on 04-10-26. Not you? Call 9876500000")).toHaveProperty("rejected");
    expect(parse("VK-ALERTS-S", "Rs.9,999.00 debited from A/c XX1234 on 04-10-26. Not you? Call 9876500000 -HDFC Bank")).toHaveProperty("rejected");
  });
});
