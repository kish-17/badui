import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext, AdapterResult, Observation } from "@brake/core";
import { ANDROID_NOTIFICATION_DESCRIPTOR, createAndroidNotificationAdapter } from "../src/notification";
import type { AndroidNotificationPayload } from "../src/notification";
import { createSmsAdapter } from "../src/sms";

/*
 * Payload fields mirror what a NotificationListenerService reads from
 * StatusBarNotification / Notification.extras (android.title, android.text,
 * android.bigText, android.subText, postTime, category) per
 * docs/research/03-android-device-signals.md §1. Bank and wallet push wording
 * is illustrative (apps do not publish their templates); bank SMS bodies shown
 * by messaging apps are the research fixtures used in sms.test.ts.
 */

const ctxOf = (country: string, defaultCurrency: string, timeZone: string, locale: string): AdapterContext => ({
  clock: fixedClock(0),
  country,
  defaultCurrency,
  timeZone,
  locale,
});
const IN = ctxOf("IN", "INR", "Asia/Kolkata", "en-IN");
const BR = ctxOf("BR", "BRL", "America/Sao_Paulo", "pt-BR");
const US = ctxOf("US", "USD", "America/New_York", "en-US");
const GB = ctxOf("GB", "GBP", "Europe/London", "en-GB");
const NG = ctxOf("NG", "NGN", "Africa/Lagos", "en-NG");
const ID = ctxOf("ID", "IDR", "Asia/Jakarta", "id-ID");

/** 2026-10-04 10:41:20 IST. */
const POSTED = Date.UTC(2026, 9, 4, 5, 11, 20);

const listener = createAndroidNotificationAdapter();

function run(payload: Omit<AndroidNotificationPayload, "postedAt"> & { postedAt?: number }, ctx: AdapterContext = IN, connectionId = "conn_nls"): AdapterResult {
  const postedAt = payload.postedAt ?? POSTED;
  return listener.parse({ adapterId: "android-notification", connectionId, receivedAt: postedAt + 400, payload: { ...payload, postedAt } }, ctx);
}

function movement(r: AdapterResult): Observation {
  if (r.status !== "observations") throw new Error(`expected observations, got ${JSON.stringify(r)}`);
  const o = r.observations.find((x) => x.kind === "money_movement");
  if (!o) throw new Error("no money_movement");
  return o;
}

const HDFC_UPI_SMS = "Sent Rs.250.00\nFrom HDFC Bank A/C *1234\nTo SWIGGY\nOn 04/10/26\nRef 627712345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808";

describe("notification adapter descriptor", () => {
  it("declares an on-device, high-sensitivity Android listener source", () => {
    expect(listener.descriptor).toBe(ANDROID_NOTIFICATION_DESCRIPTOR);
    expect(ANDROID_NOTIFICATION_DESCRIPTOR).toMatchObject({
      id: "android-notification",
      kind: "notification",
      platforms: ["android"],
      requiresCapabilities: ["os:notification-listener"],
      privacy: { sensitivity: "high", processing: "on_device" },
    });
  });
});

describe("gates before parsing", () => {
  it("ignores packages that are not financial without reading them", () => {
    expect(run({ packageName: "com.instagram.android", title: "Sale", text: "₹500 off on shoes — paid partnership" })).toEqual({ status: "ignored", reason: "not_financial" });
    expect(run({ packageName: "com.example.game", title: "HDFC Bank", text: "Rs.9,999.00 debited from A/c XX1234" })).toEqual({ status: "ignored", reason: "not_financial" });
  });

  it("treats Android 15's redacted OTP placeholder as an OTP", () => {
    expect(run({ packageName: "com.phonepe.app", appLabel: "PhonePe", title: "PhonePe", text: "Sensitive notification content hidden" })).toEqual({ status: "ignored", reason: "otp" });
    expect(run({ packageName: "com.google.android.apps.messaging", appLabel: "Messages", title: "Messages", text: "Sensitive notification content hidden" })).toEqual({
      status: "ignored",
      reason: "otp",
    });
  });

  it("drops OTP notifications and promo-category notifications", () => {
    expect(run({ packageName: "com.csam.icici.bank.imobile", title: "ICICI Bank", text: "Your OTP for the transaction of INR 2,499.00 at MYNTRA is 739104. Do not share." })).toEqual({
      status: "ignored",
      reason: "otp",
    });
    expect(run({ packageName: "com.phonepe.app", title: "Offers", text: "Flat ₹100 cashback on your next recharge", category: "promo" })).toEqual({
      status: "ignored",
      reason: "promotional",
    });
  });

  it("rejects malformed payloads", () => {
    const r = listener.parse({ adapterId: "android-notification", connectionId: "c", receivedAt: 0, payload: { packageName: "com.phonepe.app" } as AndroidNotificationPayload }, IN);
    expect(r.status).toBe("rejected");
  });
});

describe("bank, card and UPI app notifications", () => {
  it("PhonePe payment (India)", () => {
    const o = movement(run({ packageName: "com.phonepe.app", title: "Payment Successful", text: "₹250 paid to Swiggy Limited" }));
    expect(o).toMatchObject({
      amount: { value: money(25_000, "INR") },
      merchant: { raw: "Swiggy Limited" },
      instrument: { type: "upi_handle" },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      confidence: 0.85,
      occurredAt: { value: POSTED, confidence: 0.75 },
      source: { adapterId: "android-notification", kind: "notification", provider: "PhonePe", label: "PhonePe notification" },
    });
    // A payment app is not the issuer of the account it debits.
    expect(o.instrument?.issuer).toBeUndefined();
    expect(o.evidence.summary).toBe("PhonePe notification: ₹250.00 debited to Swiggy Limited (UPI)");
  });

  it("Google Pay money received (India)", () => {
    const o = movement(run({ packageName: "com.google.android.apps.nbu.paisa.user", title: "Google Pay", text: "₹500 received from Rahul Sharma" }));
    expect(o).toMatchObject({ direction: "credit", counterparty: { name: "Rahul Sharma" }, source: { label: "Google Pay notification" } });
  });

  it("Paytm payment carrying a UPI reference shared with the bank SMS", () => {
    const paytm = movement(run({ packageName: "net.one97.paytm", title: "Paytm", text: "Rs.250 paid to SWIGGY from Paytm UPI. UPI Ref: 627712345678" }));
    const bankSms = createSmsAdapter().parse(
      { adapterId: "sms", connectionId: "conn_sms", receivedAt: POSTED, payload: { sender: "AX-HDFCBK-S", body: HDFC_UPI_SMS } },
      IN,
    );
    const bank = movement(bankSms);
    // Same event, two sources: different observation ids, one shared fusion key.
    expect(paytm.id).not.toBe(bank.id);
    expect(paytm.references).toEqual(bank.references);
    expect(paytm.references).toEqual([{ type: "rail_reference", namespace: "upi", value: "627712345678" }]);
  });

  it("Nubank card purchase and Pix (Brazil)", () => {
    const card = movement(
      run({ packageName: "com.nu.production", title: "Compra aprovada", text: "Compra de R$ 45,90 APROVADA em PADARIA PAO QUENTE para o cartão com final 1234." }, BR),
    );
    expect(card).toMatchObject({
      amount: { value: money(4_590, "BRL") },
      merchant: { raw: "PADARIA PAO QUENTE" },
      instrument: { type: "card", issuer: "Nubank", last4: "1234" },
      confidence: 0.97,
      country: "BR",
    });
    const sent = movement(run({ packageName: "com.nu.production", title: "Pix enviado", text: "Você enviou R$ 150,00 para MARIA SILVA." }, BR));
    expect(sent).toMatchObject({ direction: "debit", rail: { scheme: "pix" }, counterparty: { name: "MARIA SILVA" } });
    const received = movement(run({ packageName: "com.nu.production", title: "Pix recebido", text: "Você recebeu um Pix de R$ 1.250,00 de JOAO SOUZA." }, BR));
    expect(received).toMatchObject({ direction: "credit", amount: { value: money(125_000, "BRL") }, counterparty: { name: "JOAO SOUZA" } });
  });

  it("Itaú Pix with an end-to-end id (Brazil)", () => {
    const o = movement(
      run({ packageName: "com.itau", title: "Itaú", bigText: "Pix enviado com sucesso. Valor: R$ 89,90 para LOJA DO ZE LTDA. ID da transação: E60701190202610041041DY5I8R4BZ3P" }, BR),
    );
    expect(o).toMatchObject({
      merchant: { raw: "LOJA DO ZE LTDA" },
      references: [{ type: "rail_reference", namespace: "pix", value: "E60701190202610041041DY5I8R4BZ3P" }],
      typeHints: [{ type: "purchase" }],
    });
    expect(o.evidence.summary.replace(/ /g, " ")).toBe("Itaú notification: R$ 89,90 debited to LOJA DO ZE LTDA (Pix)");
  });

  it("American Express purchase with a five-digit card ending (US)", () => {
    const o = movement(
      run({ packageName: "com.americanexpress.android.acctsvcs.us", title: "Purchase Approved", text: "A charge of $45.20 at WHOLE FOODS MARKET was approved on your Card ending in 51005." }, US),
    );
    expect(o).toMatchObject({
      amount: { value: money(4_520, "USD") },
      merchant: { raw: "WHOLE FOODS MARKET" },
      instrument: { type: "card", issuer: "American Express", network: "amex", last4: "1005" },
      rail: { family: "card", scheme: "amex" },
    });
  });

  it("Bank of America debit card and Zelle (US)", () => {
    const card = movement(run({ packageName: "com.infonow.bofa", title: "Bank of America", text: "Your debit card ending in 4321 was used for $62.50 at SHELL OIL 57444 on 10/04/2026." }, US));
    expect(card).toMatchObject({ merchant: { raw: "SHELL OIL 57444" }, instrument: { type: "card", cardKind: "debit", last4: "4321" } });
    const zelle = movement(run({ packageName: "com.infonow.bofa", title: "Zelle®", text: "You sent $50.00 to Alex Smith with Zelle®." }, US));
    expect(zelle).toMatchObject({ rail: { family: "account_to_account_instant", scheme: "zelle" }, counterparty: { name: "Alex Smith" } });
  });

  it("Monzo card push: the amount, not the running daily total (UK)", () => {
    const o = movement(run({ packageName: "co.uk.getmondo", title: "£3.20 at Pret A Manger", text: "☕️ You've spent £12.40 today" }, GB));
    expect(o).toMatchObject({
      amount: { value: money(320, "GBP") },
      merchant: { raw: "Pret A Manger" },
      instrument: { type: "card", issuer: "Monzo" },
      country: "GB",
    });
    expect(o.evidence.summary).toBe("Monzo notification: £3.20 spent at Pret A Manger (card)");
  });

  it("Revolut multi-currency spend and incoming transfer (UK)", () => {
    const spend = movement(run({ packageName: "com.revolut.revolut", title: "Revolut", text: "You paid €12.30 at Lidl. Balance: €245.10" }, GB));
    expect(spend).toMatchObject({ amount: { value: money(1_230, "EUR") }, merchant: { raw: "Lidl" } });
    // A euro spend in a GB-registered app says nothing about the country it happened in.
    expect(spend.country).toBeUndefined();
    const incoming = movement(run({ packageName: "com.revolut.revolut", title: "Revolut", text: "Alex Smith sent you £25.00" }, GB));
    expect(incoming).toMatchObject({ direction: "credit", counterparty: { name: "Alex Smith" }, amount: { value: money(2_500, "GBP") } });
  });

  it("OPay transfer with a balance (Nigeria)", () => {
    const r = run({ packageName: "team.opay.pay", title: "Transfer Successful", text: "₦5,000.00 has been sent to JOHN OKAFOR (Access Bank). Balance: ₦12,340.50" }, NG);
    const o = movement(r);
    expect(o).toMatchObject({ amount: { value: money(500_000, "NGN") }, instrument: { type: "wallet", issuer: "OPay" }, counterparty: { name: "JOHN OKAFOR" } });
    expect(r.status === "observations" && r.observations.some((x) => x.kind === "balance_snapshot")).toBe(true);
  });

  it("BCA transfer, GoPay payment and a DANA promotion (Indonesia)", () => {
    const bca = movement(run({ packageName: "com.bca", title: "m-BCA", text: "Transfer Rp 150.000,00 ke BUDI SANTOSO berhasil" }, ID));
    expect(bca).toMatchObject({ direction: "debit", amount: { value: money(15_000_000, "IDR") }, counterparty: { name: "BUDI SANTOSO" } });
    const gopay = movement(run({ packageName: "com.gojek.app", title: "Pembayaran berhasil", text: "Pembayaran Rp25.000 ke Kopi Kenangan berhasil pakai GoPay." }, ID));
    expect(gopay).toMatchObject({
      amount: { value: money(2_500_000, "IDR") },
      rail: { family: "wallet", scheme: "gopay" },
      categoryHints: [{ scheme: "brake", value: "eating_out.cafe" }],
    });
    expect(run({ packageName: "id.dana", title: "DANA", text: "Dapatkan cashback hingga Rp50.000 untuk pembayaran pakai DANA! S&K berlaku" }, ID)).toEqual({
      status: "ignored",
      reason: "promotional",
    });
  });

  it("reads bigText over the truncated one-line text", () => {
    const o = movement(
      run({
        packageName: "com.csam.icici.bank.imobile",
        title: "ICICI Bank",
        text: "USD 11.80 spent using ICICI Bank Card XX4321…",
        bigText: "USD 11.80 spent using ICICI Bank Card XX4321 on 03-Oct-26 on NETFLIX.COM. Avl Limit: INR 2,48,751.00.",
      }),
    );
    expect(o).toMatchObject({ merchant: { raw: "NETFLIX.COM" }, amount: { value: money(1_180, "USD") }, confidence: 0.97 });
  });
});

describe("messages shown by messaging apps", () => {
  it("parses a bank SMS shown by Google Messages, slightly below the SMS adapter's confidence", () => {
    const viaMessages = movement(run({ packageName: "com.google.android.apps.messaging", appLabel: "Messages", title: "AX-HDFCBK-S", text: HDFC_UPI_SMS }));
    expect(viaMessages).toMatchObject({
      confidence: 0.92,
      source: { provider: "HDFC Bank", label: "HDFC Bank SMS alert via Messages" },
      references: [{ type: "rail_reference", namespace: "upi", value: "627712345678" }],
    });
    const direct = movement(
      createSmsAdapter().parse({ adapterId: "sms", connectionId: "conn_sms", receivedAt: POSTED, payload: { sender: "AX-HDFCBK-S", body: HDFC_UPI_SMS } }, IN),
    );
    expect(viaMessages.confidence).toBeLessThan(direct.confidence);
  });

  it("verifies RCS business display names (Kotak moved UPI alerts to RCS in 2026 [28])", () => {
    const o = movement(
      run({
        packageName: "com.google.android.apps.messaging",
        title: "Kotak Mahindra Bank",
        text: "Sent Rs.205.00 from XXXXXX1234 to swiggy@icici on 04/10/2026. UPI ref no. 614812345678. Not you? Tap https://kotak.com/KBANKT/Fraud to report -Kotak",
      }),
    );
    expect(o).toMatchObject({ merchant: { raw: "swiggy@icici", handle: "swiggy@icici" }, source: { provider: "Kotak Mahindra Bank" } });
  });

  it("never parses conversations with contacts", () => {
    expect(run({ packageName: "com.google.android.apps.messaging", title: "Mom", text: "I sent you Rs 500 on GPay, buy vegetables" })).toEqual({
      status: "ignored",
      reason: "not_financial",
    });
    expect(run({ packageName: "com.whatsapp", title: "Priya", text: "Paid ₹1,200 for the cab, split later?" })).toEqual({ status: "ignored", reason: "not_financial" });
  });

  it("rejects a spoofed bank alert from a phone number but ignores ordinary ones", () => {
    const spoof = run({ packageName: "com.google.android.apps.messaging", title: "+91 98765 43210", text: "HDFC Bank: Rs.9,999.00 debited from A/c XX1234. Not you? Call 9876500000" });
    expect(spoof).toMatchObject({ status: "rejected", reason: expect.stringContaining("HDFC Bank") });
    const plain = run({ packageName: "com.google.android.apps.messaging", title: "+91 98765 43210", text: "Rs.500 received, thanks!" });
    expect(plain).toEqual({ status: "ignored", reason: "not_financial" });
  });

  it("parses an unknown bank's DLT header heuristically", () => {
    const o = movement(
      run({
        packageName: "com.samsung.android.messaging",
        title: "VM-SARASB-S",
        text: "Rs.500.00 debited from A/c XX7788 on 04-10-26 to VPA grocerymart@ybl (UPI Ref No 627799887766). Avl Bal Rs.4,500.00",
      }),
    );
    expect(o).toMatchObject({ confidence: 0.55, source: { label: "Samsung Messages message from VM-SARASB-S" } });
  });
});

describe("user allow-listed apps and identity", () => {
  it("parses a user-added package heuristically at reduced confidence", () => {
    const custom = createAndroidNotificationAdapter({ extraFinancialPackages: ["com.example.cooperativebank"] });
    const r = custom.parse(
      {
        adapterId: "android-notification",
        connectionId: "c",
        receivedAt: POSTED,
        payload: { packageName: "com.example.cooperativebank", appLabel: "Co-op Bank", title: "Debit alert", text: "Rs.1,500.00 debited from A/c XX4455 at RELIANCE FRESH on 04-10-26", postedAt: POSTED },
      },
      IN,
    );
    const o = movement(r);
    expect(o).toMatchObject({ confidence: 0.6, merchant: { raw: "RELIANCE FRESH" }, source: { label: "Co-op Bank notification", provider: "Co-op Bank" } });
  });

  it("gives a re-posted notification the same id and distinct apps distinct ids", () => {
    const payload = { packageName: "com.phonepe.app", title: "Payment Successful", text: "₹250 paid to Swiggy Limited" };
    const first = movement(run(payload));
    const repost = movement(run({ ...payload, postedAt: POSTED + 5_000 }));
    expect(repost.id).toBe(first.id);
    const gpay = movement(run({ ...payload, packageName: "com.google.android.apps.nbu.paisa.user" }));
    expect(gpay.id).not.toBe(first.id);
  });

  it("keeps a redacted excerpt that expires after seven days", () => {
    const o = movement(run({ packageName: "net.one97.paytm", title: "Paytm", text: "Rs.250 paid to SWIGGY from Paytm UPI. UPI Ref: 627712345678" }));
    expect(o.evidence.excerpt).toContain("••••5678");
    expect(o.evidence.excerpt).not.toContain("627712345678");
    expect(o.evidence.excerptExpiresAt).toBe(POSTED + 400 + 7 * 86_400_000);
  });
});
