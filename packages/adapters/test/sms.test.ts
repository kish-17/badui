import { describe, expect, it } from "vitest";
import { DAY, fixedClock, money, zonedTimeToEpoch } from "@brake/core";
import type { AdapterContext, AdapterResult, Observation } from "@brake/core";
import { createSmsAdapter, SMS_DESCRIPTOR } from "../src/sms";
import type { SmsPayload } from "../src/sms";
import { observationId } from "../src/shared/text";

/*
 * Message structures come from docs/research/07-sms-and-messaging-alerts.md
 * (PennyWise parser fixtures [24]-[43]: Kotak JD-KOTAKD-S sample [27],
 * Canara fixtures [41], CSB/Jupiter RuPay-on-UPI [42], GTBank [39],
 * M-PESA [35], Chase short code 24273 [40]). Names, numbers and references
 * are anonymised; "(illustrative)" marks structures assembled from parser
 * patterns rather than verbatim fixtures.
 */

const ctxOf = (country: string, defaultCurrency: string, timeZone: string, locale: string): AdapterContext => ({
  clock: fixedClock(0),
  country,
  defaultCurrency,
  timeZone,
  locale,
});
const IN = ctxOf("IN", "INR", "Asia/Kolkata", "en-IN");
const KE = ctxOf("KE", "KES", "Africa/Nairobi", "en-KE");
const US = ctxOf("US", "USD", "America/New_York", "en-US");
const NG = ctxOf("NG", "NGN", "Africa/Lagos", "en-NG");
const BR = ctxOf("BR", "BRL", "America/Sao_Paulo", "pt-BR");

const at = (zone: string, year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
  zonedTimeToEpoch({ year, month, day, hour, minute, second }, zone);
const IST_RECEIVED = at("Asia/Kolkata", 2026, 10, 4, 10, 41, 20);

const sms = createSmsAdapter();

function run(sender: string, body: string, ctx: AdapterContext = IN, receivedAt = IST_RECEIVED, extra: Partial<SmsPayload> = {}, connectionId = "conn_sms"): AdapterResult {
  return sms.parse({ adapterId: "sms", connectionId, receivedAt, payload: { sender, body, ...extra } }, ctx);
}

function observations(r: AdapterResult): readonly Observation[] {
  if (r.status !== "observations") throw new Error(`expected observations, got ${JSON.stringify(r)}`);
  return r.observations;
}

function movement(r: AdapterResult): Observation {
  const o = observations(r).find((x) => x.kind === "money_movement");
  if (!o) throw new Error("no money_movement");
  return o;
}

const HDFC_UPI = "Sent Rs.250.00\nFrom HDFC Bank A/C *1234\nTo SWIGGY\nOn 04/10/26\nRef 627712345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808";
const CANARA_UPI =
  "Dear Customer, Acct XXX123 Dr. INR 260.00 on 04/10/26 to SAMPLE MART; UPI: 123456789012; Bal INR 12,345.67.Not you? SMS BLOCKUPI to XXXXXXXXXX-CanaraBank";

describe("SMS adapter descriptor", () => {
  it("declares an on-device, very-high-sensitivity Android source", () => {
    expect(sms.descriptor).toBe(SMS_DESCRIPTOR);
    expect(SMS_DESCRIPTOR).toMatchObject({
      id: "sms",
      kind: "sms",
      platforms: ["android"],
      requiresCapabilities: ["os:sms-read"],
      privacy: { sensitivity: "very_high", processing: "on_device" },
    });
    expect(SMS_DESCRIPTOR.windows).toEqual(expect.arrayContaining(["in_spend", "post_spend"]));
  });
});

describe("Indian bank SMS", () => {
  it("HDFC UPI 'Sent' alert", () => {
    const o = movement(run("AX-HDFCBK-S", HDFC_UPI));
    expect(o).toMatchObject({
      kind: "money_movement",
      window: "post_spend",
      stage: "confirmed",
      direction: "debit",
      amount: { value: money(25_000, "INR"), confidence: 0.98 },
      instrument: { type: "bank_account", issuer: "HDFC Bank", last4: "1234" },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      references: [{ type: "rail_reference", namespace: "upi", value: "627712345678" }],
      country: "IN",
      confidence: 0.97,
      source: { adapterId: "sms", kind: "sms", connectionId: "conn_sms", provider: "HDFC Bank", label: "HDFC Bank SMS alert" },
    });
    expect(o.merchant?.raw).toBe("SWIGGY");
    expect(o.evidence.summary).toBe("HDFC Bank SMS: ₹250.00 debited to SWIGGY (UPI)");
  });

  it("HDFC card spend is a real-time authorization (in_spend) on a credit card", () => {
    const o = movement(run("AX-HDFCBK-S", "Spent Rs.1,249 From HDFC Bank Card x1234 At AMAZON On 2026-10-04:10:41:00 Not You? To Block+Reissue Call 18002586161/SMS BLOCK CC 1234 to 7308080808"));
    expect(o).toMatchObject({
      window: "in_spend",
      amount: { value: money(124_900, "INR") },
      merchant: { raw: "AMAZON", confidence: 0.9 },
      instrument: { type: "card", last4: "1234", cardKind: "credit" },
      rail: { family: "card" },
      occurredAt: { value: at("Asia/Kolkata", 2026, 10, 4, 10, 41), confidence: 0.95 },
    });
    expect(o.typeHints?.[0]).toMatchObject({ type: "purchase" });
    expect(o.evidence.summary).toBe("HDFC Bank SMS: ₹1,249.00 spent at AMAZON (card)");
  });

  it("Kotak UPI 'Sent' alert from the verified JD-KOTAKD-S header [27]", () => {
    const o = movement(
      run("JD-KOTAKD-S", "Sent Rs.205.00 from XXXXXX1234 to Ramesh Kumar on 04/10/2026. UPI ref no. 614812345678. Not you? Tap https://kotak.com/KBANKT/Fraud to report -Kotak"),
    );
    expect(o.amount?.value).toEqual(money(20_500, "INR"));
    expect(o.counterparty).toMatchObject({ name: "Ramesh Kumar", isMerchant: 0.5 });
    // A named payee could be a shop or a person: both readings stay open.
    expect(o.typeHints?.map((h) => h.type).sort()).toEqual(["purchase", "transfer"]);
    expect(o.evidence.excerpt).not.toMatch(/https?:|kotak\.com/);
  });

  it("Canara UPI debit with balance emits a movement and a balance snapshot [41]", () => {
    const [mm, bal] = observations(run("VK-CANBNK-S", CANARA_UPI));
    expect(mm).toMatchObject({ kind: "money_movement", merchant: { raw: "SAMPLE MART" }, references: [{ namespace: "upi", value: "123456789012" }] });
    // "XXX123" is a three-digit tail, which may never be stored as last4.
    expect(mm!.instrument).toEqual({ type: "bank_account", issuer: "Canara Bank" });
    expect(bal).toMatchObject({
      kind: "balance_snapshot",
      window: "post_spend",
      balance: { available: money(1_234_567, "INR") },
      references: [],
      occurredAt: mm!.occurredAt,
    });
    expect(bal!.evidence.summary).toBe("Canara Bank SMS: available balance ₹12,345.67");
    expect(bal!.id).not.toBe(mm!.id);
  });

  it("Canara RTGS credit in lakh grouping from a mutual fund [41]", () => {
    const [mm] = observations(
      run(
        "VA-CANBNK-S",
        "An amount of INR 13,30,614.75 has been credited to XXXX6785 on 02/12/2025 towards RTGS by Sender AXIS MUTUAL FUND REDEMPTION PO, IFSC UTIB0000004, Sender A/c XXXX9108, AXIS BANK, MUMBAI BRANCH, UTR UTIBR72025120200011461, Total Avail. Bal INR 2679815.88- Canara Bank",
        IN,
        at("Asia/Kolkata", 2025, 12, 2, 11, 30),
      ),
    );
    expect(mm).toMatchObject({
      direction: "credit",
      amount: { value: money(133_061_475, "INR") },
      rail: { family: "account_to_account_instant", scheme: "rtgs" },
      references: [{ type: "rail_reference", namespace: "rtgs", value: "UTIBR72025120200011461" }],
      instrument: { last4: "6785" },
    });
    expect(mm!.typeHints?.[0]).toMatchObject({ type: "investment" });
    expect(mm!.evidence.summary).toBe("Canara Bank SMS: ₹13,30,614.75 credited from AXIS MUTUAL FUND REDEMPTION PO (RTGS)");
  });

  it("SBI ATM withdrawal is cash, not spending at a merchant (illustrative)", () => {
    const [mm, bal] = observations(
      run(
        "AX-SBIINB-S",
        "Dear Customer, Rs.2,000 withdrawn at SBI ATM S1NW000093009 from A/cX1234 on 04Oct26 Transaction Number 1234. Available Balance Rs.10,345.67. If not withdrawn by you, call 1800111109 -SBI",
      ),
    );
    expect(mm).toMatchObject({ rail: { family: "cash", scheme: "atm" }, typeHints: [{ type: "cash_withdrawal" }], amount: { value: money(200_000, "INR") } });
    expect(mm!.merchant).toBeUndefined();
    expect(bal!.balance?.available).toEqual(money(1_034_567, "INR"));
  });

  it("declined card payment is a cancelled movement (illustrative)", () => {
    const o = movement(run("AX-HDFCBK-S", "Your HDFC Bank Credit Card ending 1234 was declined for Rs.4,999.00 at FLIPKART on 04-10-26 due to insufficient credit limit."));
    expect(o).toMatchObject({ stage: "cancelled", direction: "debit", merchant: { raw: "FLIPKART" } });
    expect(o.evidence.summary).toBe("HDFC Bank SMS: ₹4,999.00 payment declined at FLIPKART (card)");
  });

  it("refund credit to a card (illustrative)", () => {
    const o = movement(run("AX-HDFCBK-S", "Refund of Rs.1,249.00 from AMAZON has been credited to your HDFC Bank Credit Card ending 1234 on 04-10-26."));
    expect(o).toMatchObject({ direction: "credit", stage: "confirmed", typeHints: [{ type: "refund", confidence: 0.9 }] });
    expect(o.evidence.summary).toBe("HDFC Bank SMS: ₹1,249.00 refund credited from AMAZON (card)");
  });

  it("UPI AutoPay pre-debit notice becomes a pre-spend subscription event (illustrative)", () => {
    const [o] = observations(
      run("VM-ICICIB-S", "Your UPI-Mandate for Rs.649.00 towards NETFLIX will be debited on 12-Oct-26 from A/c XX1234. UMN: a1b2c3d4e5f6@ybl. To pause/revoke, use any UPI app. -ICICI Bank"),
    );
    expect(o).toMatchObject({
      kind: "subscription_event",
      window: "pre_spend",
      stage: "intent",
      subscription: {
        event: "renewal_upcoming",
        serviceName: "NETFLIX",
        nextChargeAt: at("Asia/Kolkata", 2026, 10, 12, 12, 0),
        price: money(64_900, "INR"),
      },
      references: [{ type: "mandate_id", namespace: "upi", value: "a1b2c3d4e5f6@ybl" }],
    });
    expect(o!.evidence.summary).toBe("ICICI Bank SMS: ₹649.00 will be debited for NETFLIX on 12 Oct (UPI)");
  });

  it("mandate set-up becomes a mandate observation (illustrative)", () => {
    const [o] = observations(
      run("BX-SBIUPI-S", "UPI AutoPay mandate for Spotify of max Rs.119.00 (Monthly) has been successfully created on your SBI A/c X1234. UMN 9f8e7d6c5b4a@axl. -SBI"),
    );
    expect(o).toMatchObject({
      kind: "mandate",
      window: "pre_spend",
      stage: "confirmed",
      subscription: { event: "signup", serviceName: "Spotify", period: "P1M", price: money(11_900, "INR") },
    });
  });

  it("RuPay credit card on UPI from an unknown bank header [42]", () => {
    const o = movement(
      run(
        "JM-CSBBNK-S",
        "Rs.25.00 debited to your Edge CSB Bank RuPay Credit Card ending 6788 on 3/18/26, 6:39 PM - (UPI Ref no.702711160776). To dispute, call 18002669999",
        IN,
        at("Asia/Kolkata", 2026, 3, 18, 18, 39, 30),
      ),
    );
    expect(o).toMatchObject({
      confidence: 0.55,
      rail: { scheme: "upi" },
      instrument: { type: "card", network: "rupay", cardKind: "credit", last4: "6788" },
      source: { label: "SMS from JM-CSBBNK-S", provider: "JM-CSBBNK-S" },
    });
  });
});

describe("mobile money, Nigeria, US and Brazil", () => {
  const KE_EVENING = at("Africa/Nairobi", 2026, 10, 4, 21, 0);

  it("M-PESA send money: person counterparty, fee, balance, transaction code [35]", () => {
    const [mm, bal] = observations(
      run(
        "MPESA",
        "SJ41AB2CDE Confirmed. Ksh1,200.00 sent to JOHN DOE 0712345678 on 4/10/26 at 10:41 AM. New M-PESA balance is Ksh5,432.10. Transaction cost, Ksh13.00. Amount you can transact within the day is 498,800.00.",
        KE,
        at("Africa/Nairobi", 2026, 10, 4, 10, 41, 25),
      ),
    );
    expect(mm).toMatchObject({
      window: "in_spend",
      amount: { value: money(120_000, "KES") },
      amountBreakdown: [{ kind: "fee", amount: money(1_300, "KES") }],
      counterparty: { name: "JOHN DOE", isMerchant: 0.05 },
      instrument: { type: "mobile_money", issuer: "M-PESA" },
      rail: { family: "mobile_money", scheme: "mpesa" },
      references: [{ type: "rail_reference", namespace: "mpesa", value: "SJ41AB2CDE" }],
      typeHints: [{ type: "transfer", transferKind: "p2p_other" }],
      occurredAt: { value: at("Africa/Nairobi", 2026, 10, 4, 10, 41), confidence: 0.95 },
      country: "KE",
    });
    expect(mm!.merchant).toBeUndefined();
    // A private person's name is never echoed into the persisted summary.
    // Intl writes "Ksh\u00a01,200.00".
    expect(mm!.evidence.summary.replace(/\u00a0/g, " ")).toBe("M-PESA SMS: Ksh 1,200.00 debited to a person (M-PESA)");
    expect(bal!.balance?.available).toEqual(money(543_210, "KES"));
  });

  it("M-PESA Buy Goods is a purchase at a till [35]", () => {
    const o = movement(
      run("MPESA", "SJ41AB2CDF Confirmed. Ksh350.00 paid to NAIVAS SUPERMARKET. on 4/10/26 at 6:30 PM.New M-PESA balance is Ksh5,082.10. Transaction cost, Ksh0.00.", KE, KE_EVENING),
    );
    expect(o).toMatchObject({ merchant: { raw: "NAIVAS SUPERMARKET" }, typeHints: [{ type: "purchase" }], categoryHints: [{ value: "groceries" }] });
    expect(o.amountBreakdown).toBeUndefined();
  });

  it("M-PESA received money is a credit from a person", () => {
    const o = movement(
      run("MPESA", "SJ41AB2CDH Confirmed.You have received Ksh2,000.00 from JANE WANJIKU 0723456789 on 4/10/26 at 9:15 AM New M-PESA balance is Ksh7,432.10.", KE, KE_EVENING),
    );
    expect(o).toMatchObject({ direction: "credit", counterparty: { name: "JANE WANJIKU" }, amount: { value: money(200_000, "KES") } });
  });

  it("M-PESA agent withdrawal is a cash withdrawal on the mobile-money rail", () => {
    const o = movement(
      run(
        "MPESA",
        "SJ41AB2CDJ Confirmed.on 4/10/26 at 11:00 AMWithdraw Ksh3,000.00 from 123456 - MAMA MBOGA AGENCIES New M-PESA balance is Ksh4,432.10. Transaction cost, Ksh67.00.",
        KE,
        KE_EVENING,
      ),
    );
    expect(o).toMatchObject({ typeHints: [{ type: "cash_withdrawal" }], rail: { scheme: "mpesa" }, amountBreakdown: [{ kind: "fee" }] });
  });

  it("a fake M-PESA credit from a phone number is rejected", () => {
    const r = run(
      "+254712345678",
      "SJ41AB2CDK Confirmed. You have received Ksh5,000.00 from JOHN DOE 0712345678 on 4/10/26 at 10:41 AM. New M-PESA balance is Ksh5,120.00.",
      KE,
      KE_EVENING,
    );
    expect(r).toMatchObject({ status: "rejected", reason: expect.stringContaining("M-PESA") });
  });

  it("GTBank multi-line debit with balance [39]", () => {
    const [mm, bal] = observations(
      run("GTBank", "Acct:******4321\nAmt:NGN15,000.00 DR\nDesc:OUTWARD TRANSFER TO OPAY - JANE DOE\nBal:NGN20,000.00\nDate:2026-10-04 9:36AM", NG, at("Africa/Lagos", 2026, 10, 4, 9, 36, 30)),
    );
    expect(mm).toMatchObject({
      direction: "debit",
      amount: { value: money(1_500_000, "NGN") },
      instrument: { type: "bank_account", issuer: "GTBank", last4: "4321" },
      occurredAt: { value: at("Africa/Lagos", 2026, 10, 4, 9, 36), confidence: 0.95 },
      counterparty: { name: "OPAY - JANE DOE" },
    });
    expect(bal!.balance?.available).toEqual(money(2_000_000, "NGN"));
  });

  it("GTBank salary credit (illustrative)", () => {
    const o = movement(run("GTBank", "Credit Alert! Acct: ******4321 Amt: NGN 50,000.00 CR Desc: SALARY OCT 2026 ACME NIGERIA LTD Bal: NGN 70,000.00", NG));
    expect(o).toMatchObject({ direction: "credit", typeHints: [{ type: "income" }] });
  });

  it("Chase short-code alert with an Eastern time [40]", () => {
    const o = movement(
      run("24273", "Chase Freedom Unlimited: You made a $9.17 transaction with TACO BELL on Mar 17, 2026 at 1:56 PM ET.", US, Date.UTC(2026, 2, 17, 17, 56, 30)),
    );
    expect(o).toMatchObject({
      window: "in_spend",
      amount: { value: money(917, "USD") },
      merchant: { raw: "TACO BELL" },
      instrument: { type: "card", issuer: "Chase" },
      occurredAt: { value: Date.UTC(2026, 2, 17, 17, 56), confidence: 0.95 },
      source: { label: "Chase SMS alert" },
    });
    expect(o.evidence.summary).toBe("Chase SMS: $9.17 spent at TACO BELL (card)");
  });

  it("an SMS claiming Nubank (push-only) is rejected as phishing", () => {
    const r = run("28149", "NUBANK: Compra APROVADA de R$ 2.399,00 em MAGAZINE LUIZA. Nao reconhece? Ligue 0800 591 2117", BR);
    expect(r.status).toBe("rejected");
  });
});

describe("privacy and dropping", () => {
  it("drops OTP SMS before parsing, even with an amount and merchant", () => {
    expect(run("AX-HDFCBK-S", "482193 is the OTP for your txn of Rs.1,249.00 at AMAZON on HDFC Bank Card ending 1234. Valid for 5 mins. Do not share it with anyone.")).toEqual({
      status: "ignored",
      reason: "otp",
    });
    expect(run("AX-HDFCBK-T", "Use 4821 to authenticate your HDFC Bank transaction.")).toEqual({ status: "ignored", reason: "otp" });
  });

  it("drops promotions and spoofs", () => {
    expect(run("AX-HDFCBK-S", "Congratulations! You are pre-approved for an HDFC Bank Personal Loan of up to Rs.5,00,000. Apply now: hdfc.bank/pl T&C apply")).toEqual({
      status: "ignored",
      reason: "promotional",
    });
    const spoof = run("+919876543210", "Dear HDFC Bank customer, Rs.9,999.00 debited from A/c XX1234. If not done by you, click http://hdfc-secure.co/verify to block.");
    expect(spoof).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^unverified_sender: .*HDFC Bank/) });
  });

  it("keeps only a redacted, expiring excerpt and a summary without identifiers", () => {
    const [mm] = observations(run("AX-HDFCBK-S", HDFC_UPI));
    expect(mm!.evidence.excerptExpiresAt).toBe(IST_RECEIVED + 7 * DAY);
    const excerpt = mm!.evidence.excerpt ?? "";
    expect(excerpt).not.toContain("627712345678");
    expect(excerpt).not.toContain("18002586161");
    expect(excerpt).toContain("••••5678");
    expect(mm!.evidence.summary).not.toMatch(/\d{6,}/);
    const without = observations(createSmsAdapter({ includeExcerpt: false }).parse({ adapterId: "sms", connectionId: "c", receivedAt: IST_RECEIVED, payload: { sender: "AX-HDFCBK-S", body: HDFC_UPI } }, IN));
    expect(without[0]!.evidence.excerpt).toBeUndefined();
    expect(without[0]!.evidence.excerptExpiresAt).toBeUndefined();
  });

  it("masks a personal sender number in provenance", () => {
    const o = movement(run("+15551234567", "You spent $25.00 at CORNER DELI with card ending 4242.", US));
    expect(o.source.label).toBe("SMS from ••••4567");
    expect(o.source.label).not.toContain("5551234567");
  });

  it("rejects malformed payloads and ignores empty ones", () => {
    expect(sms.parse({ adapterId: "sms", connectionId: "c", receivedAt: 0, payload: { sender: "AX-HDFCBK-S" } as unknown as SmsPayload }, IN).status).toBe("rejected");
    expect(run("AX-HDFCBK-S", "   ")).toEqual({ status: "ignored", reason: "not_financial" });
  });
});

describe("identity and time bookkeeping", () => {
  it("gives the same ids to the same SMS re-delivered with a different timestamp", () => {
    const live = observations(run("AX-HDFCBK-S", HDFC_UPI, IN, IST_RECEIVED));
    const rescan = observations(run("AX-HDFCBK-S", HDFC_UPI, IN, IST_RECEIVED + 90_000, { receivedAt: IST_RECEIVED + 3_000 }));
    expect(rescan.map((o) => o.id)).toEqual(live.map((o) => o.id));
    // Keyed by the UPI reference (stable across wording changes), scoped to adapter + connection.
    expect(live[0]!.id).toBe(observationId("sms", "conn_sms", "sms|debit|upi:627712345678|money_movement"));
    const otherConnection = observations(run("AX-HDFCBK-S", HDFC_UPI, IN, IST_RECEIVED, {}, "conn_other"));
    expect(otherConnection[0]!.id).not.toBe(live[0]!.id);
  });

  it("keys alerts without a reference by their text, so different alerts never collide", () => {
    const a = movement(run("AX-HDFCBK-S", "Your HDFC Bank Credit Card ending 1234 was declined for Rs.4,999.00 at FLIPKART on 04-10-26 due to insufficient credit limit."));
    const b = movement(run("AX-HDFCBK-S", "Your HDFC Bank Credit Card ending 1234 was declined for Rs.5,999.00 at FLIPKART on 04-10-26 due to insufficient credit limit."));
    expect(a.id).not.toBe(b.id);
  });

  it("uses the SMS timestamp for occurredAt and BRAKE's receipt time for receivedAt", () => {
    const smsTime = IST_RECEIVED - 5_000;
    const o = movement(run("AX-HDFCBK-S", HDFC_UPI, IN, IST_RECEIVED + 60_000, { receivedAt: smsTime }));
    expect(o.receivedAt).toBe(IST_RECEIVED + 60_000);
    expect(o.occurredAt).toEqual({ value: smsTime, confidence: 0.85 });
  });
});

describe("review regressions: robustness", () => {
  it("never throws on oversized numbers, an invalid locale or an invalid time zone", () => {
    const bad: AdapterContext[] = [IN, { ...IN, locale: "xx-INVALID-@@" }, { ...IN, timeZone: "Not/AZone" }, { clock: fixedClock(0), timeZone: "Not/AZone", locale: "@@" }];
    const bodies = [
      `Rs.${"9".repeat(60)} debited from A/c XX1234 on 04-10-26`,
      `₹${"1,".repeat(3000)}0 debited from A/c XX1234`,
      "INR 1,00,00,00,00,00,00,00,00,000.00 debited from A/c XX1234 on 04-10-26",
      HDFC_UPI,
    ];
    for (const ctx of bad) {
      for (const body of bodies) {
        for (const sender of ["AX-HDFCBK-S", "VM-SARASB-S"]) {
          let r: AdapterResult | undefined;
          expect(() => {
            r = run(sender, body, ctx);
          }).not.toThrow();
          expect(["observations", "ignored", "rejected"]).toContain(r?.status);
        }
      }
    }
    // An implausible amount (beyond safe integer minor units) is not reported as money.
    const huge = run("AX-HDFCBK-S", "INR 1,00,00,00,00,00,00,00,00,000.00 debited from A/c XX1234 on 04-10-26");
    expect(huge.status).not.toBe("observations");
  });

  it("refuses implausibly long input instead of stalling on it (180 KB took 82 s)", () => {
    const started = performance.now();
    const r = run("AX-HDFCBK-S", `interest ${"1.2.3.".repeat(30_000)} paid`);
    expect(r).toEqual({ status: "ignored", reason: "unsupported_format" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("still parses with an invalid locale, falling back to a neutral format", () => {
    const o = movement(run("AX-HDFCBK-S", HDFC_UPI, { ...IN, locale: "xx-INVALID-@@" }));
    expect(o.amount?.value).toEqual(money(25_000, "INR"));
    expect(o.evidence.summary).toContain("250");
  });
});

describe("review regressions: Nigeria", () => {
  it("OPay SMS with the GSM-7 'N' naira sign (TestOpayBankParser)", () => {
    const o = movement(run("OPay", "Dear OPay user, N2,300.00 has been debited for Card Payment via POS on 14-May-2026 19:28.", NG, at("Africa/Lagos", 2026, 5, 14, 19, 28, 30)));
    expect(o).toMatchObject({
      direction: "debit",
      amount: { value: money(230_000, "NGN") },
      source: { provider: "OPay", label: "OPay SMS alert" },
      occurredAt: { value: at("Africa/Lagos", 2026, 5, 14, 19, 28), confidence: 0.95 },
    });
  });
});
