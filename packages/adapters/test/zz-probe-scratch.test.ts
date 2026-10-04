import { it } from "vitest";
import { fixedClock } from "@brake/core";
import { parseAaNarration, createAccountAggregatorAdapter } from "../src/account-aggregator";
import { parseLocalizedAmount } from "../src/wallet-automation";
import { createLedgerAdapter, OBIE_ACCOUNT_TRANSACTIONS_MAPPING, MONZO_TRANSACTION_WEBHOOK_MAPPING } from "../src/ledger-mapping";
import { createFinanceKitAdapter } from "../src/financekit";

it("probe", () => {
  const ns = [
    "TO TRANSFER-UPI/DR/627712345678/RAHUL KUMAR/SBIN/rahul@okaxis/NA",
    "BY TRANSFER-UPI/CR/627712345678/ACME/HDFC/acme@hdfcbank/Refund",
    "UPI/DR/627712345678/SWIGGY/YESB/swiggy@ybl/Payment",
    "UPI/627712345678/Payment from Ph/swiggy@icici/ICICI Bank",
    "UPI-SWIGGY-SWIGGY8@YBL-YESB0YBLUPI-627712345678-PAYMENT FROM PHONE",
    "UPI/P2M/627712345678/SWIGGY/Payment from Ph/HDFC BANK",
    "NEFT/N123/ACME PVT LTD/SALARY",
    "NEFT CR-HDFC0000001-ACME PVT LTD-SALARY SEP-N123456789012345",
    "ACH D- BAJAJ FINANCE LTD-P1234567",
    "ATW-512345XXXXXX1234-S1ANBG12-BANGALORE",
    "POS 512345XXXXXX1234 AMAZON PAY IN",
    "MMT/IMPS/627712345678/RAHUL/HDFC Bank",
    "UPI/DR/627712345678/9876543210/YBL/9876543210@ybl/NA",
    "INB/IFT/SELF TRANSFER/123456",
    "BIL/ONL/000123456789/AIRTEL/AIRTEL1234",
    "IMPS-627712345678-RAHUL KUMAR-HDFC-XXXXXXXX1234-NA",
    "NACH-DR-BAJAJ FINANCE LIMITED-ABCD1234",
    "UPI/CR/627712345678/AMAZON/UTIB/amazonrefunds@axisbank/REFUND",
    "CASH DEPOSIT BY SELF",
    "Int.Pd:12345678901:01-07-2026 to 30-09-2026",
  ];
  for (const n of ns) console.log(JSON.stringify(n), "=>", JSON.stringify(parseAaNarration(n, n.includes("CR") ? "credit" : "debit", "UPI")));
  for (const [raw, loc] of [["₹1,249.00","en-IN"],["$22.99","en-US"],["22,99 €","de-DE"],["1.249,00 €","de-DE"],["CHF 12.50","de-CH"],["£4.50","en-GB"],["¥1,249","ja-JP"],["R$ 1.249,90","pt-BR"],["12,50","fr-FR"],["1 249,00 €","fr-FR"],["1 249,00 €","fr-FR"],["kr 249,00","sv-SE"],["249,00 kr","sv-SE"],["S$12.80","en-SG"],["A$9.50","en-AU"],["1,249","en-IN"],["-$5.00","en-US"],["0.0","en-US"],["$0.00","en-US"],["﷼ 50","ar-SA"],["SAR 50.00","ar-SA"],["AED 25.00","en-AE"],["₩12,000","ko-KR"],["HK$88.00","zh-HK"],["NT$150","zh-TW"],["MX$199.00","es-MX"],["$199.00","es-MX"],["CA$5.00","en-CA"],["£1,249.99","en-GB"],["1.249 kr.","da-DK"],["zł 12,50","pl-PL"],["12,50 zł","pl-PL"],["₪12.90","he-IL"],["RM 12.90","ms-MY"]] as const) {
    console.log(raw, loc, JSON.stringify(parseLocalizedAmount(raw, { locale: loc })));
  }
  const obie = createLedgerAdapter(OBIE_ACCOUNT_TRANSACTIONS_MAPPING);
  const r = obie.parse({ adapterId: "x", connectionId: "c", receivedAt: 1759574400000, payload: { Data: { Balance: [
    { AccountId: "22289", Amount: { Amount: "1230.00", Currency: "GBP" }, CreditDebitIndicator: "Debit", Type: "InterimAvailable", DateTime: "2026-10-04T08:00:00+00:00" },
    { AccountId: "22289", Amount: { Amount: "1230.00", Currency: "GBP" }, CreditDebitIndicator: "Debit", Type: "InterimBooked", DateTime: "2026-10-04T08:00:00+00:00" } ],
    Transaction: [{ AccountId: "22289", TransactionId: "123", CreditDebitIndicator: "Debit", Status: "Booked", BookingDateTime: "2026-10-03T00:00:00+00:00", Amount: { Amount: "10.00", Currency: "GBP" }, CategoryPurposeCode: "CCRD", Balance: { Amount: { Amount: "1230.00", Currency: "GBP" }, CreditDebitIndicator: "Debit", Type: "InterimBooked" } }] } } }, { clock: fixedClock(0), timeZone: "Europe/London" });
  console.log(JSON.stringify(r, null, 1));
  const aa = createAccountAggregatorAdapter();
  const r2 = aa.parse({ adapterId: "x", connectionId: "c", receivedAt: 1759574400000, payload: { Account: { linkedAccRef: "L", maskedAccNumber: "XXXXXXXX4020", type: "deposit", Transactions: { Transaction: [{ txnId: "T1", type: "DEBIT", mode: "UPI", amount: "1249.00", currentBalance: "5000", transactionTimestamp: "2026-10-04T10:41:00", valueDate: "2026-10-04", narration: "UPI/DR/627712345678/SWIGGY/YESB/swiggy@ybl/Payment", reference: "627712345678" }] } } } }, { clock: fixedClock(0), timeZone: "Asia/Dubai" });
  console.log((r2 as any).observations?.[0]?.occurredAt, new Date((r2 as any).observations?.[0]?.occurredAt.value).toISOString());
  const fk = createFinanceKitAdapter();
  const r3 = fk.parse({ adapterId: "x", connectionId: "c", receivedAt: 1759574400000, payload: { accounts: [{ id: "A", kind: "asset", displayName: "Savings", institutionName: "Barclays", accountDescription: "Rainy Day Savings 2025", currencyCode: "GBP" }], balances: [{ accountID: "A", booked: { amount: { amount: "120.00", currencyCode: "GBP" }, creditDebitIndicator: "debit", asOfDate: "2026-10-04T09:00:00Z" } }] } }, { clock: fixedClock(0) });
  console.log(JSON.stringify(r3, null, 1));
  const monzo = createLedgerAdapter(MONZO_TRANSACTION_WEBHOOK_MAPPING);
  const r4 = monzo.parse({ adapterId: "x", connectionId: "c", receivedAt: 1759574400000, payload: { type: "transaction.created", data: { account_id: "acc_1", amount: -350, created: "2015-09-04T14:28:40Z", currency: "GBP", description: "Ozone Coffee Roasters", id: "tx_1", category: "eating_out", is_load: false, settled: false, merchant: { id: "m", name: "Ozone" } } } }, { clock: fixedClock(0) });
  console.log((r4 as any).observations?.[0]?.stage);
});
