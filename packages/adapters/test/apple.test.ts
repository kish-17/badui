import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext, Observation, RawSignal } from "@brake/core";
import { assessPair } from "../../core/src/fusion/match";
import { defaultMerchantMatcher } from "../../core/src/fusion/merchant";
import type { FusionConfig } from "../../core/src/fusion/types";
import { createFinanceKitAdapter } from "../src/financekit";
import type { FinanceKitAccount, FinanceKitBatch, FinanceKitTransaction } from "../src/financekit";
import { createWalletAutomationAdapter, parseLocalizedAmount } from "../src/wallet-automation";
import type { WalletAutomationPayload } from "../src/wallet-automation";

/*
 * FinanceKit payloads mirror Apple's `Transaction`, `Account` and
 * `AccountBalance` (developer.apple.com/documentation/financekit) as the iOS
 * bridge serializes them: Decimal amounts as strings, enums as their case
 * names. Wallet automation payloads mirror what the Shortcuts "Transaction"
 * trigger hands an App Intent: localized strings (docs/research/04 §1).
 */

const NOW = Date.UTC(2026, 9, 4, 17, 30, 0);
const US: AdapterContext = { clock: fixedClock(NOW), country: "US", locale: "en-US", timeZone: "America/New_York" };
const GB: AdapterContext = { clock: fixedClock(NOW), country: "GB", locale: "en-GB", timeZone: "Europe/London" };

const FUSION: FusionConfig = {
  linkThreshold: 0.9,
  possibleThreshold: 0.5,
  ambiguityMargin: 0.15,
  priorLogOdds: Math.log(0.1 / 0.9),
  intentHorizonMs: 24 * 3_600_000,
  pendingToPostedTolerance: 0.3,
  approximateAmountTolerance: 0.15,
};

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* FinanceKit                                                          */
/* ------------------------------------------------------------------ */

const APPLE_CARD = "8C1D5F3A-6B2E-4F7C-9A10-3E4D5C6B7A80";
const APPLE_CASH = "1F2E3D4C-5B6A-4798-8A7B-6C5D4E3F2A10";
const MONZO_GB = "A0B1C2D3-E4F5-4677-8899-AABBCCDDEEFF";

const ACCOUNTS: FinanceKitAccount[] = [
  {
    id: APPLE_CARD,
    kind: "liability",
    displayName: "Apple Card",
    institutionName: "Apple",
    accountDescription: "Apple Card",
    currencyCode: "USD",
    creditLimit: { amount: "8000", currencyCode: "USD" },
  },
  { id: APPLE_CASH, kind: "asset", displayName: "Apple Cash", institutionName: "Apple", currencyCode: "USD" },
  { id: MONZO_GB, kind: "asset", displayName: "Monzo Current Account", institutionName: "Monzo", accountDescription: "•••• 7712", currencyCode: "GBP" },
];

function fkTxn(p: Partial<FinanceKitTransaction> & Pick<FinanceKitTransaction, "id">): FinanceKitTransaction {
  return {
    accountID: APPLE_CARD,
    transactionAmount: { amount: "12.50", currencyCode: "USD" },
    creditDebitIndicator: "debit",
    transactionDescription: "Blue Bottle Coffee",
    originalTransactionDescription: "BLUE BOTTLE COFFEE #42 NEW YORK NY",
    merchantCategoryCode: 5814,
    merchantName: "Blue Bottle Coffee",
    transactionType: "pointOfSale",
    status: "authorized",
    transactionDate: "2026-10-04T13:05:22Z",
    postedDate: null,
    ...p,
  };
}

const fk = createFinanceKitAdapter();

function parseFk(payload: FinanceKitBatch, ctx: AdapterContext = US): Observation[] {
  const signal: RawSignal<FinanceKitBatch> = { adapterId: "financekit", connectionId: "fk_iphone", receivedAt: NOW, payload };
  const result = fk.parse(signal, ctx);
  if (result.status !== "observations") throw new Error(`expected observations, got ${result.status}`);
  return [...result.observations];
}

describe("FinanceKit adapter", () => {
  it("maps an Apple Card authorization and its booking as two observations sharing one provider id", () => {
    const [auth] = parseFk({ inserted: [fkTxn({ id: "T-1" })], accounts: ACCOUNTS });
    const [booked] = parseFk({ updated: [fkTxn({ id: "T-1", status: "booked", postedDate: "2026-10-05T00:00:00Z" })], accounts: ACCOUNTS });

    expect(auth).toMatchObject({ kind: "money_movement", window: "post_spend", stage: "pending", direction: "debit", confidence: 0.92 });
    expect(auth!.source).toEqual({ adapterId: "financekit", kind: "os_wallet", connectionId: "fk_iphone", label: "Apple Card in Apple Wallet", provider: "Apple" });
    expect(auth!.amount?.value).toEqual(money(1250, "USD"));
    expect(auth!.occurredAt).toEqual({ value: Date.parse("2026-10-04T13:05:22Z"), confidence: 0.9 });
    expect(auth!.merchant).toEqual({ raw: "BLUE BOTTLE COFFEE #42 NEW YORK NY", name: "Blue Bottle Coffee", mcc: "5814", confidence: 0.9 });
    expect(auth!.instrument).toEqual({ type: "card", cardKind: "credit", accountRef: APPLE_CARD, issuer: "Apple" });
    expect(auth!.rail).toEqual({ family: "card" });
    expect(auth!.categoryHints).toEqual([{ scheme: "mcc", value: "5814", confidence: 0.9 }]);
    expect(auth!.typeHints).toEqual([{ type: "purchase", confidence: 0.7, reason: "fk_type:pointOfSale" }]);
    expect(auth!.evidence.summary).toBe("Apple Wallet shows a pending $12.50 debit at Blue Bottle Coffee on your Apple Card in Apple Wallet.");

    expect(booked!.stage).toBe("posted");
    expect(booked!.id).not.toBe(auth!.id);
    expect(booked!.references).toEqual(auth!.references);
    expect(booked!.references[0]).toEqual({ type: "provider_transaction_id", value: "T-1", namespace: "financekit:fk_iphone" });

    const assessment = assessPair(booked!, auth!, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.probability).toBeGreaterThan(0.99);
  });

  it("keeps the merchant-currency amount of a foreign purchase as an FX bridge", () => {
    const [o] = parseFk({
      inserted: [
        fkTxn({
          id: "T-FX",
          status: "booked",
          transactionAmount: { amount: "54.37", currencyCode: "USD" },
          foreignCurrencyAmount: { amount: "49.90", currencyCode: "EUR" },
          foreignCurrencyExchangeRate: "1.0896",
          transactionDescription: "Galeries Lafayette",
          originalTransactionDescription: "GALERIES LAFAYETTE PARIS FR",
          merchantName: "Galeries Lafayette",
          merchantCategoryCode: 5311,
        }),
      ],
      accounts: ACCOUNTS,
    });
    expect(o!.amount?.value).toEqual(money(5437, "USD"));
    expect(o!.amountBreakdown).toEqual([{ kind: "original_currency", amount: money(4990, "EUR") }]);
  });

  it("reads UK connected accounts (GBP) with standing orders, direct debits and transfers", () => {
    const obs = parseFk(
      {
        accounts: ACCOUNTS,
        inserted: [
          fkTxn({ id: "UK-1", accountID: MONZO_GB, status: "booked", transactionAmount: { amount: "950.00", currencyCode: "GBP" }, transactionType: "standingOrder", transactionDescription: "Rent", originalTransactionDescription: "SO RENT FLAT 4", merchantName: null, merchantCategoryCode: null, transactionDate: "2026-10-01T00:00:00Z" }),
          fkTxn({ id: "UK-2", accountID: MONZO_GB, status: "booked", transactionAmount: { amount: "38.00", currencyCode: "GBP" }, transactionType: "directDebit", transactionDescription: "Thames Water", originalTransactionDescription: "THAMES WATER DD", merchantName: "Thames Water", merchantCategoryCode: 4900 }),
          fkTxn({ id: "UK-3", accountID: MONZO_GB, status: "booked", transactionAmount: { amount: "200.00", currencyCode: "GBP" }, creditDebitIndicator: "credit", transactionType: "transfer", transactionDescription: "From savings pot", originalTransactionDescription: "POT TRANSFER", merchantName: null, merchantCategoryCode: null }),
        ],
      },
      GB,
    );
    const [rent, water, pot] = obs;
    expect(rent!.instrument).toEqual({ type: "bank_account", accountRef: MONZO_GB, last4: "7712", issuer: "Monzo" });
    expect(rent!.source.label).toBe("Monzo Current Account in Apple Wallet");
    expect(rent!.rail).toEqual({ family: "account_to_account_batch", scheme: "standing_order" });
    // Midnight is a date placeholder, not a time.
    expect(rent!.occurredAt).toEqual({ value: Date.parse("2026-10-01T11:00:00Z"), confidence: 0.4 });
    expect(rent!.merchant).toEqual({ raw: "SO RENT FLAT 4", name: "Rent", confidence: 0.7 });
    expect(rent!.country).toBe("GB");
    expect(water!.rail).toEqual({ family: "direct_debit" });
    expect(water!.amount?.value).toEqual(money(3800, "GBP"));
    expect(pot!.direction).toBe("credit");
    expect(pot!.typeHints).toEqual([{ type: "transfer", confidence: 0.8, reason: "fk_type:transfer" }]);
  });

  it("recognizes card bill payments, Apple Cash wallets, declines, memos and deletions", () => {
    const obs = parseFk({
      accounts: ACCOUNTS,
      accountID: APPLE_CARD,
      inserted: [
        fkTxn({ id: "PAY", status: "booked", creditDebitIndicator: "credit", transactionAmount: { amount: "1240.55", currencyCode: "USD" }, transactionType: "billPayment", transactionDescription: "Payment", originalTransactionDescription: "ACH DEPOSIT INTERNET TRANSFER", merchantName: null, merchantCategoryCode: null }),
        fkTxn({ id: "CASH", accountID: APPLE_CASH, status: "booked", creditDebitIndicator: "credit", transactionAmount: { amount: "25.00", currencyCode: "USD" }, transactionType: "transfer", transactionDescription: "Sam", originalTransactionDescription: "APPLE CASH SENT MONEY", merchantName: null, merchantCategoryCode: null }),
        fkTxn({ id: "DECLINED", status: "rejected", transactionAmount: { amount: "899.00", currencyCode: "USD" }, merchantName: "Apple Store", transactionDescription: "Apple Store", originalTransactionDescription: "APPLE STORE #R102", merchantCategoryCode: 5732 }),
        fkTxn({ id: "MEMO", status: "memo" }),
      ],
      deleted: ["HOLD-77"],
    });
    const by = (id: string) => obs.find((o) => o.references[0]?.value === id)!;
    expect(by("PAY").typeHints).toContainEqual({ type: "credit_card_payment", confidence: 0.85, reason: "fk_type:billPayment" });
    expect(by("CASH").instrument?.type).toBe("wallet");
    expect(by("DECLINED")).toMatchObject({ stage: "cancelled", direction: "debit" });
    expect(by("MEMO")).toBeUndefined();
    const removed = by("HOLD-77");
    expect(removed).toMatchObject({ stage: "cancelled", references: [{ type: "provider_transaction_id", value: "HOLD-77", namespace: "financekit:fk_iphone" }] });
    expect(removed.amount).toBeUndefined();
    expect(removed.instrument?.accountRef).toBe(APPLE_CARD);
  });

  it("emits balances with the card's credit limit", () => {
    const obs = parseFk({
      accounts: ACCOUNTS,
      balances: [
        { accountID: APPLE_CARD, booked: { amount: { amount: "412.08", currencyCode: "USD" }, asOfDate: "2026-10-04T12:00:00Z", creditDebitIndicator: "debit" } },
        { accountID: APPLE_CASH, available: { amount: { amount: "57.25", currencyCode: "USD" }, asOfDate: "2026-10-04T12:00:00Z", creditDebitIndicator: "credit" } },
      ],
    });
    expect(obs[0]).toMatchObject({ kind: "balance_snapshot", window: "pre_spend", balance: { current: money(41208, "USD"), limit: money(800000, "USD") } });
    expect(obs[0]!.evidence.summary).toBe("Apple Wallet reported a card balance of $412.08 on your Apple Card in Apple Wallet.");
    expect(obs[1]!.balance).toEqual({ available: money(5725, "USD") });
  });

  it("is idempotent and rejects malformed batches", () => {
    const batch: FinanceKitBatch = { inserted: [fkTxn({ id: "T-9" })], accounts: ACCOUNTS };
    expect(parseFk(batch).map((o) => o.id)).toEqual(parseFk(batch).map((o) => o.id));
    const signal = (payload: unknown): RawSignal<FinanceKitBatch> => ({ adapterId: "financekit", connectionId: "c", receivedAt: NOW, payload: payload as FinanceKitBatch });
    expect(fk.parse(signal("nope"), US).status).toBe("rejected");
    expect(fk.parse(signal({ inserted: [{ id: "x", status: "booked" }] }), US).status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */
/* Wallet tap automation                                               */
/* ------------------------------------------------------------------ */

const wallet = createWalletAutomationAdapter();
const TAP = Date.UTC(2026, 9, 4, 5, 11, 4);

function tap(payload: WalletAutomationPayload, ctx: AdapterContext): Observation | undefined {
  const signal: RawSignal<WalletAutomationPayload> = { adapterId: "apple-wallet-automation", connectionId: "shortcut_1", receivedAt: TAP + 900, payload };
  const result = wallet.parse(signal, ctx);
  return result.status === "observations" ? result.observations[0] : undefined;
}

describe("Apple Wallet tap automation adapter", () => {
  it("emits an in-spend pending card movement at tap time", () => {
    const o = tap({ amount: "$22.99", merchant: "Netflix", card: "Chase Sapphire Visa ••4242", firedAt: TAP }, US)!;
    expect(o).toMatchObject({ kind: "money_movement", window: "in_spend", stage: "pending", direction: "debit", confidence: 0.7 });
    expect(o.source).toEqual({ adapterId: "apple-wallet-automation", kind: "os_wallet", connectionId: "shortcut_1", provider: "Apple Wallet", label: "Apple Wallet tap automation" });
    expect(o.amount).toEqual({ value: money(2299, "USD"), confidence: 0.9 });
    expect(o.occurredAt).toEqual({ value: TAP, confidence: 0.85 });
    expect(o.merchant).toEqual({ raw: "Netflix", name: "Netflix", channel: "in_store", confidence: 0.8 });
    expect(o.instrument).toEqual({ type: "card", accountRef: "wallet-card:chase sapphire visa ••4242", network: "visa", last4: "4242" });
    expect(o.rail).toEqual({ family: "card", scheme: "visa" });
    expect(o.typeHints).toEqual([{ type: "purchase", confidence: 0.6, reason: "wallet_tap" }]);
    expect(o.evidence.summary).toBe("Apple Wallet: Chase Sapphire Visa ••4242 tapped for $22.99 at Netflix (authorization; not yet settled).");
  });

  it.each([
    ["en-IN", "IN", "₹1,249.00", 124_900, "INR"],
    ["en-US", "US", "$22.99", 2299, "USD"],
    ["en-CA", "CA", "$5.25", 525, "CAD"],
    ["en-GB", "GB", "£4.50", 450, "GBP"],
    ["de-DE", "DE", "22,99 €", 2299, "EUR"],
    ["fr-FR", "FR", "1 249,50 €", 124_950, "EUR"],
    ["nl-NL", "NL", "€ 1.234,56", 123_456, "EUR"],
    ["ja-JP", "JP", "¥1,200", 1200, "JPY"],
    ["pt-BR", "BR", "R$ 45,90", 4590, "BRL"],
    ["sv-SE", "SE", "45,00 kr", 4500, "SEK"],
    ["nb-NO", "NO", "kr 129,00", 12_900, "NOK"],
    ["de-CH", "CH", "CHF 12.50", 1250, "CHF"],
    ["en-AU", "AU", "A$18.40", 1840, "AUD"],
  ])("parses %s amounts (%s)", (locale, country, amount, minor, currency) => {
    const o = tap({ amount, merchant: "Shop", firedAt: TAP }, { clock: fixedClock(TAP), locale, country })!;
    expect(o.amount?.value).toEqual(money(minor, currency));
  });

  it("uses the locale only for amounts without a currency, with lower confidence", () => {
    expect(parseLocalizedAmount("22.99", { locale: "en-GB" })).toEqual({ money: money(2299, "GBP"), negative: false, currencyStated: false });
    expect(parseLocalizedAmount("1.249", { locale: "de-DE", defaultCurrency: "EUR" })?.money).toEqual(money(124_900, "EUR"));
    expect(parseLocalizedAmount("1,249", { locale: "en-IN", defaultCurrency: "INR" })?.money).toEqual(money(124_900, "INR"));
    const o = tap({ amount: "18.75", merchant: "Pret A Manger", firedAt: TAP }, GB)!;
    expect(o.amount).toEqual({ value: money(1875, "GBP"), confidence: 0.7 });
    expect(parseLocalizedAmount("18.75", { locale: "en" })).toBeNull();
  });

  it("treats 0.0 and blank merchants as missing, never as free or anonymous", () => {
    const zero = tap({ amount: "0.0", merchant: "Starbucks", card: "Apple Card", firedAt: TAP }, US)!;
    expect(zero.amount).toBeUndefined();
    expect(zero.confidence).toBe(0.55);
    const blank = tap({ amount: "$4.75", merchant: " ", name: "STARBUCKS STORE 0412", card: "Apple Card", firedAt: TAP }, US)!;
    expect(blank.merchant?.raw).toBe("STARBUCKS STORE 0412");
    expect(tap({ amount: "0.0", merchant: " ", firedAt: TAP }, US)).toBeUndefined();
    const signal: RawSignal<WalletAutomationPayload> = { adapterId: "apple-wallet-automation", connectionId: "s", receivedAt: TAP, payload: { amount: "", merchant: "", firedAt: TAP } };
    expect(wallet.parse(signal, US)).toEqual({ status: "ignored", reason: "unsupported_format" });
  });

  it("accepts seconds-based timestamps, refunds, and never keeps card numbers", () => {
    const o = tap({ amount: "-$5.00", merchant: "Target", card: "Visa 4111 1111 1111 1111", firedAt: TAP / 1000 }, US)!;
    expect(o.occurredAt?.value).toBe(TAP);
    expect(o.direction).toBe("credit");
    expect(o.typeHints).toBeUndefined();
    for (const s of strings(o)) expect(s).not.toMatch(/\d{9,}|\d{4} \d{4} \d{4}/);
    expect(o.instrument?.last4).toBe("1111");
  });

  it("gives the same id when the App Intent is re-delivered", () => {
    const p: WalletAutomationPayload = { amount: "£3.20", merchant: "Greggs", card: "Monzo", firedAt: TAP };
    expect(tap(p, GB)!.id).toBe(tap(p, GB)!.id);
    expect(tap({ ...p, firedAt: TAP + 60_000 }, GB)!.id).not.toBe(tap(p, GB)!.id);
  });

  it("is later confirmed by the FinanceKit record of the same tap", () => {
    const t = tap({ amount: "$12.50", merchant: "Blue Bottle Coffee", card: "Apple Card", firedAt: Date.parse("2026-10-04T13:05:30Z") }, US)!;
    const [ledger] = parseFk({ inserted: [fkTxn({ id: "T-2" })], accounts: ACCOUNTS });
    const assessment = assessPair(ledger!, t, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.features.map((f) => f.name)).toEqual(expect.arrayContaining(["amount_exact", "merchant_key_equal"]));
    expect(assessment.probability).toBeGreaterThan(0.9);
  });
});
