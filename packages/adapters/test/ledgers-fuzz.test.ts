/**
 * Robustness: ledger adapters must return ignored/rejected (never throw) for
 * malformed, hostile or oversized payloads crossing the native JSON boundary.
 */
import { describe, it, expect } from "vitest";
import { fixedClock } from "@brake/core";
import { createPlaidAdapter } from "../src/plaid";
import { createAccountAggregatorAdapter } from "../src/account-aggregator";
import { createFinanceKitAdapter } from "../src/financekit";
import { createWalletAutomationAdapter } from "../src/wallet-automation";
import { createCardFeedAdapter } from "../src/card-feed";
import { createLedgerAdapter, MONZO_TRANSACTION_WEBHOOK_MAPPING, OBIE_ACCOUNT_TRANSACTIONS_MAPPING } from "../src/ledger-mapping";

const adapters: Array<[string, { parse: (s: any, c: any) => any }]> = [
  ["plaid", createPlaidAdapter()],
  ["aa", createAccountAggregatorAdapter()],
  ["fk", createFinanceKitAdapter()],
  ["wallet", createWalletAutomationAdapter()],
  ["card", createCardFeedAdapter()],
  ["monzo", createLedgerAdapter(MONZO_TRANSACTION_WEBHOOK_MAPPING)],
  ["obie", createLedgerAdapter(OBIE_ACCOUNT_TRANSACTIONS_MAPPING)],
];
const weird: unknown[] = [null, undefined, 0, "", "x".repeat(100000), [], {}, [1, 2], { a: 1 }, true, NaN, "😀", { __proto__: null },
  { added: "x", modified: {}, removed: 3 }, { added: [], modified: [], removed: [], accounts: "foo" },
  { added: [], modified: [], removed: [], accounts: {} },
  { added: [{ transaction_id: "t", account_id: "a", amount: 1, iso_currency_code: "USD", pending: false, date: "2026-10-04", counterparties: "zz" }], modified: [], removed: [] },
  { added: [{ transaction_id: "t", account_id: "a", amount: 1, iso_currency_code: "USD", pending: false, date: "2026-10-04", counterparties: {} }], modified: [], removed: [] },
  { added: [{ transaction_id: "t", account_id: "a", amount: 1, iso_currency_code: "USD", pending: false, date: "2026-10-04", personal_finance_category: "FOOD" , location: "x", payment_meta: 3}], modified: [], removed: [] },
  { added: [], modified: [], removed: [], accounts: [{ account_id: "a", balances: "x" }, { account_id: "b", balances: { current: 1e300, iso_currency_code: "USD" } }, { account_id: "c", balances: { current: 5, iso_currency_code: "USD" }, mask: {} , name: 5}] },
  { Account: "x" }, { Account: { linkedAccRef: "r", Transactions: "x" } }, { Account: { linkedAccRef: "r", Transactions: { Transaction: "abc" } } },
  { Account: { linkedAccRef: "r", Summary: { currentBalance: {} }, Transactions: { Transaction: [{ type: "DEBIT", amount: "1e400", narration: 5 }] } } },
  { Account: { linkedAccRef: "r", type: 5, Transactions: { Transaction: [{ type: "DEBIT", amount: "12", narration: "UPI/".repeat(5000), transactionTimestamp: "9999-99-99T99:99" }] } } },
  { Account: { linkedAccRef: { a: 1 } } },
  { Account: { linkedAccRef: "r", maskedAccNumber: 123456789012, Summary: { currentBalance: "100", currency: 5 } } },
  { inserted: "abc" }, { inserted: {}, deleted: "abc", balances: 5 }, { accounts: {} }, { deleted: [{}, null, 5] },
  { inserted: [{ id: "x", status: "booked", transactionAmount: "5", creditDebitIndicator: "debit", accountID: {} }] },
  { inserted: [{ id: "x", status: "booked", transactionAmount: { amount: "5", currencyCode: "USD" }, creditDebitIndicator: "debit", accountID: "a", transactionDate: 5, foreignCurrencyAmount: "x" }] },
  { balances: [{ accountID: "a", booked: { amount: "x" }, available: 5 }] },
  { accounts: [{ id: "a", kind: "liability", creditLimit: "5", displayName: {}, accountDescription: 7 }], balances: [{ accountID: "a", booked: { amount: { amount: "5", currencyCode: "USD" }, asOfDate: {} } }] },
  { amount: {}, firedAt: "x" }, { amount: "₹", merchant: {} }, { amount: "$1e5", merchant: "x", card: 5, firedAt: 1e300 }, { amount: "-".repeat(10000) + "5", firedAt: -1 },
  { amount: "22.99", firedAt: Infinity, merchant: " " },
  { id: "x", card: { id: "c" }, amount: 5, currency: "USD", datetime: "2026-10-04T10:00:00", location: { timezone: "Not/AZone" } },
  { id: "x", card: { id: "c" }, amount: 5, currency: "USD", datetime: 5, location: { timezone: 5 } },
  { id: "x", card: { id: "c", lastNumbers: 1234 }, amount: "abc", currency: "USD" },
  { id: "x", card: { id: "c" }, amount: 5, currency: "USD", identifiers: "x", merchant: "y", brand: 3, descriptor: [] },
  { type: "transaction.created", data: "x" }, { type: "transaction.created", data: [{ id: "x", amount: "1.5", currency: "GBP" }] },
  { type: "transaction.created", data: { id: {}, amount: 1, currency: "GBP" } },
  { type: "transaction.created", data: { id: "tx", amount: 1e300, currency: "GBP", created: "2026-13-45" } },
  { Data: { Transaction: "x", Balance: [{ Type: "x" }] } }, { Data: { Transaction: [{ Amount: 5 }] } },
  { Data: { Transaction: [{ TransactionId: "a", AccountId: "b", Amount: { Amount: "1", Currency: "GBP" }, CreditDebitIndicator: "Debit", Status: "Booked", BookingDateTime: "2026-10-04T10:00:00+99:99" }] } },
];
const ctxs = [
  { clock: fixedClock(0) },
  { clock: fixedClock(0), timeZone: "Bogus/Zone", locale: "xx_invalid_!!", defaultCurrency: "ZZZZ", country: "??" },
  { clock: fixedClock(0), locale: "de-DE", defaultCurrency: "EUR", country: "DE", timeZone: "Europe/Berlin" },
];

describe("fuzz", () => {
  for (const [name, a] of adapters) {
    it(name, () => {
      const failures: string[] = [];
      for (const payload of weird) {
        for (const ctx of ctxs) {
          try {
            const r = a.parse({ adapterId: name, connectionId: "c", receivedAt: 1_759_574_400_000, payload }, ctx);
            JSON.stringify(r);
          } catch (e) {
            failures.push(`${JSON.stringify(payload)?.slice(0, 120)} ctx=${JSON.stringify(ctx).slice(0, 80)} -> ${(e as Error).message}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
