import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext, Observation, RawSignal } from "@brake/core";
import { assessPair } from "../../core/src/fusion/match";
import { defaultMerchantMatcher } from "../../core/src/fusion/merchant";
import type { FusionConfig } from "../../core/src/fusion/types";
import {
  MONZO_TRANSACTION_WEBHOOK_MAPPING,
  OBIE_ACCOUNT_TRANSACTIONS_MAPPING,
  createLedgerAdapter,
  last4Of,
  parseDecimalAmount,
  parseInstant,
  parseMinorAmount,
  safeHandle,
  scrubDescriptor,
  selectAll,
  validateLedgerMapping,
} from "../src/ledger-mapping";
import type { LedgerMapping } from "../src/ledger-mapping";

const NOW = Date.UTC(2026, 9, 4, 9, 0, 0);
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

function run(mapping: LedgerMapping, payload: unknown, ctx: AdapterContext = GB, receivedAt = NOW) {
  const signal: RawSignal<unknown> = { adapterId: mapping.id, connectionId: `conn_${mapping.id}`, receivedAt, payload };
  return createLedgerAdapter(mapping).parse(signal, ctx);
}

function observations(mapping: LedgerMapping, payload: unknown, ctx: AdapterContext = GB, receivedAt = NOW): Observation[] {
  const result = run(mapping, payload, ctx, receivedAt);
  if (result.status !== "observations") throw new Error(`expected observations, got ${result.status}`);
  return [...result.observations];
}

/* ------------------------------------------------------------------ */
/* Toolkit                                                             */
/* ------------------------------------------------------------------ */

describe("ledger toolkit", () => {
  it("parses decimal amounts exactly, including xs:float and 0/3-decimal currencies", () => {
    expect(parseDecimalAmount("10.00", "GBP")).toEqual({ money: money(1000, "GBP"), negative: false });
    expect(parseDecimalAmount(-72.1, "USD")).toEqual({ money: money(7210, "USD"), negative: true });
    expect(parseDecimalAmount(0.1 + 0.2, "USD")?.money).toEqual(money(30, "USD"));
    expect(parseDecimalAmount("1.2495E3", "INR")?.money).toEqual(money(124_950, "INR"));
    expect(parseDecimalAmount("45.9000", "BRL")?.money).toEqual(money(4590, "BRL"));
    expect(parseDecimalAmount("1200", "JPY")?.money).toEqual(money(1200, "JPY"));
    expect(parseDecimalAmount("12.345", "KWD")?.money).toEqual(money(12_345, "KWD"));
    expect(parseDecimalAmount("2.675", "EUR")?.money).toEqual(money(268, "EUR"));
    expect(parseDecimalAmount("-0.00", "EUR")).toEqual({ money: money(0, "EUR"), negative: false });
    expect(parseDecimalAmount("1,249.00", "INR")).toBeNull();
    expect(parseDecimalAmount(Number.NaN, "USD")).toBeNull();
    expect(parseMinorAmount(-350, "GBP")).toEqual({ money: money(350, "GBP"), negative: true });
    expect(parseMinorAmount("12.5", "GBP")).toBeNull();
  });

  it("parses instants with offsets, without offsets, date-only and epoch values", () => {
    expect(parseInstant("2026-10-04T10:41:00+05:30")).toEqual({ at: Date.UTC(2026, 9, 4, 5, 11), precision: "datetime" });
    expect(parseInstant("2026-10-04T10:41:00", { timeZone: "Asia/Kolkata" })).toEqual({ at: Date.UTC(2026, 9, 4, 5, 11), precision: "datetime" });
    expect(parseInstant("2026-10-04T10:41:00.250Z")?.at).toBe(Date.UTC(2026, 9, 4, 10, 41, 0, 250));
    expect(parseInstant("2026-10-04", { timeZone: "America/New_York" })).toEqual({ at: Date.UTC(2026, 9, 4, 16), precision: "date" });
    expect(parseInstant("2026-10-04T00:00:00Z", { midnightIsDate: true })).toEqual({ at: Date.UTC(2026, 9, 4, 12), precision: "date" });
    expect(parseInstant(1_791_115_860)).toEqual({ at: 1_791_115_860_000, precision: "datetime" });
    expect(parseInstant("04/10/2026", { format: "dmy", timeZone: "UTC" })).toEqual({ at: Date.UTC(2026, 9, 4, 12), precision: "date" });
    expect(parseInstant("2026-02-30")).toBeNull();
  });

  it("selects dot paths with arrays", () => {
    const doc = { Data: { Transaction: [{ Amount: { Amount: "1.00" } }, { Amount: { Amount: "2.00" } }] } };
    expect(selectAll(doc, "Data.Transaction[*].Amount.Amount")).toEqual(["1.00", "2.00"]);
    expect(selectAll(doc, "Data.Transaction.Amount.Amount")).toEqual(["1.00", "2.00"]);
    expect(selectAll(doc, "Data.Transaction[1].Amount.Amount")).toEqual(["2.00"]);
    expect(selectAll(doc, "Data.Missing.Field")).toEqual([]);
  });

  it("scrubs descriptors and handles", () => {
    expect(scrubDescriptor("CARD 4111111111111111 SPOTIFY")).toBe("CARD ••••1111 SPOTIFY");
    expect(scrubDescriptor("POS 512345XXXXXX4321 AMAZON")).toBe("POS ••••4321 AMAZON");
    expect(scrubDescriptor("TRF TO 50100123456789  RAVI")).toBe("TRF TO ••••6789 RAVI");
    expect(safeHandle("9876543210@YBL")).toBe("••••3210@ybl");
    expect(safeHandle("swiggy@icici")).toBe("swiggy@icici");
    expect(safeHandle("joao.silva@gmail.com")).toBe("j•••@gmail.com");
    expect(last4Of("****1234")).toBe("1234");
    expect(last4Of("XXXXXXXX4321")).toBe("4321");
    expect(last4Of("12")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Monzo                                                               */
/* ------------------------------------------------------------------ */

/** docs.monzo.com "Webhooks" — transaction.created example payload (with a 2026 date). */
const MONZO_CREATED = {
  type: "transaction.created",
  data: {
    account_id: "acc_00008gju41AHyfLUzBUk8A",
    amount: -350,
    created: "2026-10-04T08:28:40Z",
    currency: "GBP",
    description: "OZONE COFFEE ROASTERS LONDON GBR",
    id: "tx_00008zjky19HyFLAzlUk7t",
    category: "eating_out",
    is_load: false,
    settled: "",
    merchant: {
      address: {
        address: "11 Leonard Street",
        city: "London",
        country: "GB",
        latitude: 51.5245,
        longitude: -0.0857,
        postcode: "EC2A 4AQ",
        region: "Greater London",
      },
      created: "2015-08-22T12:20:18Z",
      group_id: "grp_00008zIcpbBOaAr7TTP3sv",
      id: "merch_00008zIcpbAKe8shBxXUtl",
      logo: "https://pbs.twimg.com/profile_images/527043602623389696/68_SgUWJ.jpeg",
      emoji: "☕️",
      name: "Ozone Coffee Roasters",
      category: "eating_out",
    },
  },
};

describe("Monzo transaction webhook mapping", () => {
  it("maps transaction.created to a pending card debit", () => {
    const [o] = observations(MONZO_TRANSACTION_WEBHOOK_MAPPING, MONZO_CREATED);
    expect(o).toMatchObject({ kind: "money_movement", window: "post_spend", stage: "pending", direction: "debit", country: "GB", confidence: 0.9 });
    expect(o!.source).toEqual({ adapterId: "monzo-webhook", kind: "neobank_api", connectionId: "conn_monzo-webhook", label: "Monzo account", provider: "Monzo" });
    expect(o!.amount).toEqual({ value: money(350, "GBP"), confidence: 0.95 });
    expect(o!.occurredAt).toEqual({ value: Date.UTC(2026, 9, 4, 8, 28, 40), confidence: 0.95 });
    expect(o!.merchant).toEqual({ raw: "OZONE COFFEE ROASTERS LONDON GBR", name: "Ozone Coffee Roasters", confidence: 0.9 });
    expect(o!.instrument).toEqual({ type: "bank_account", accountRef: "acc_00008gju41AHyfLUzBUk8A" });
    expect(o!.rail).toEqual({ family: "card", scheme: "mastercard" });
    expect(o!.references).toEqual([{ type: "provider_transaction_id", value: "tx_00008zjky19HyFLAzlUk7t", namespace: "monzo:acc_00008gju41AHyfLUzBUk8A" }]);
    expect(o!.categoryHints).toEqual([{ scheme: "brake", value: "eating_out", confidence: 0.75 }]);
    expect(o!.evidence.summary).toBe("Monzo: pending £3.50 debit at Ozone Coffee Roasters.");
  });

  it("links the settled update to the authorization through the stable transaction id", () => {
    const [pending] = observations(MONZO_TRANSACTION_WEBHOOK_MAPPING, MONZO_CREATED);
    const [posted] = observations(
      MONZO_TRANSACTION_WEBHOOK_MAPPING,
      { ...MONZO_CREATED, type: "transaction.updated", data: { ...MONZO_CREATED.data, settled: "2026-10-05T03:10:00Z" } },
      GB,
      NOW + 86_400_000,
    );
    expect(posted!.stage).toBe("posted");
    expect(posted!.id).not.toBe(pending!.id);
    expect(posted!.references).toEqual(pending!.references);
    const assessment = assessPair(posted!, pending!, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.probability).toBeGreaterThan(0.99);
  });

  it("maps top-ups, declines and foreign-currency spends", () => {
    const [topup] = observations(MONZO_TRANSACTION_WEBHOOK_MAPPING, {
      type: "transaction.created",
      data: { account_id: "acc_1", amount: 10_000, created: "2026-10-03T19:00:00Z", currency: "GBP", description: "Top up from Barclays", id: "tx_top", category: "general", is_load: true, settled: "2026-10-03T19:00:01Z" },
    });
    expect(topup).toMatchObject({ direction: "credit", stage: "posted" });
    expect(topup!.rail).toBeUndefined();
    expect(topup!.typeHints).toEqual([{ type: "transfer", transferKind: "wallet_load", confidence: 0.8, reason: "monzo-webhook:is_load=true" }]);

    const [declined] = observations(MONZO_TRANSACTION_WEBHOOK_MAPPING, {
      type: "transaction.created",
      data: { ...MONZO_CREATED.data, id: "tx_declined", amount: -12_999, settled: "", decline_reason: "INSUFFICIENT_FUNDS", category: "shopping", description: "APPLE STORE R245" },
    });
    expect(declined!.stage).toBe("cancelled");

    const [paris] = observations(MONZO_TRANSACTION_WEBHOOK_MAPPING, {
      type: "transaction.created",
      data: {
        ...MONZO_CREATED.data,
        id: "tx_paris",
        amount: -870,
        currency: "GBP",
        local_amount: -1000,
        local_currency: "EUR",
        description: "PAUL BOULANGERIE PARIS FRA",
        merchant: { ...MONZO_CREATED.data.merchant, name: "Paul", address: { ...MONZO_CREATED.data.merchant.address, country: "FR" } },
      },
    });
    expect(paris!.amount?.value).toEqual(money(870, "GBP"));
    expect(paris!.amountBreakdown).toEqual([{ kind: "original_currency", amount: money(1000, "EUR") }]);
    expect(paris!.country).toBe("FR");
  });

  it("ignores other webhook types", () => {
    expect(run(MONZO_TRANSACTION_WEBHOOK_MAPPING, { type: "account.updated", data: {} })).toEqual({ status: "ignored", reason: "not_financial" });
    expect(run(MONZO_TRANSACTION_WEBHOOK_MAPPING, "not json").status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------ */
/* UK Open Banking (OBIE v3.1)                                          */
/* ------------------------------------------------------------------ */

/**
 * OBReadTransaction6. The first record is the OBIE v3.1 specification's own
 * example ("Cash from Aubrey"); the others use the same schema.
 */
const OBIE_TRANSACTIONS = {
  Data: {
    Transaction: [
      {
        AccountId: "22289",
        TransactionId: "123",
        TransactionReference: "Ref 1",
        Amount: { Amount: "10.00", Currency: "GBP" },
        CreditDebitIndicator: "Credit",
        Status: "Booked",
        BookingDateTime: "2017-04-05T10:43:07+00:00",
        ValueDateTime: "2017-04-05T10:45:22+00:00",
        TransactionInformation: "Cash from Aubrey",
        BankTransactionCode: { Code: "ReceivedCreditTransfer", SubCode: "DomesticCreditTransfer" },
        ProprietaryBankTransactionCode: { Code: "Transfer", Issuer: "AlphaBank" },
        Balance: { Amount: { Amount: "230.00", Currency: "GBP" }, CreditDebitIndicator: "Credit", Type: "InterimBooked" },
      },
      {
        AccountId: "22289",
        TransactionId: "TX-2026-1003-0001",
        Amount: { Amount: "23.40", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "Booked",
        BookingDateTime: "2026-10-03T12:14:09+01:00",
        ValueDateTime: "2026-10-03T00:00:00+01:00",
        TransactionInformation: "PRET A MANGER 0412 LONDON",
        MerchantDetails: { MerchantName: "Pret A Manger", MerchantCategoryCode: "5814" },
        CardInstrument: { CardSchemeName: "Visa", AuthorisationType: "Contactless", Name: "MRS J SMITH", Identification: "****1234" },
        ProprietaryBankTransactionCode: { Code: "POS", Issuer: "AlphaBank" },
        Balance: { Amount: { Amount: "206.60", Currency: "GBP" }, CreditDebitIndicator: "Credit", Type: "InterimBooked" },
      },
      {
        AccountId: "22289",
        TransactionId: "TX-PDNG-77",
        Amount: { Amount: "61.99", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "Pending",
        BookingDateTime: "2026-10-04T08:02:51+01:00",
        TransactionInformation: "AMAZON.CO.UK*2K4L",
        MerchantDetails: { MerchantName: "Amazon", MerchantCategoryCode: "5942" },
        CardInstrument: { CardSchemeName: "Visa", AuthorisationType: "None", Identification: "****1234" },
      },
      {
        AccountId: "22289",
        TransactionId: "TX-DD-9",
        Amount: { Amount: "38.00", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "Booked",
        BookingDateTime: "2026-10-01T06:00:00+01:00",
        TransactionInformation: "THAMES WATER",
        ProprietaryBankTransactionCode: { Code: "DD", Issuer: "AlphaBank" },
        CreditorAccount: { SchemeName: "UK.OBIE.SortCodeAccountNumber", Identification: "80200110203345", Name: "Thames Water Utilities" },
      },
      {
        AccountId: "22289",
        TransactionId: "TX-ATM-3",
        Amount: { Amount: "100.00", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "Booked",
        BookingDateTime: "2026-10-02T21:40:00+01:00",
        TransactionInformation: "CASH LINK 34 HIGH ST",
        ProprietaryBankTransactionCode: { Code: "ATM", Issuer: "AlphaBank" },
      },
      {
        AccountId: "22289",
        TransactionId: "TX-FX-5",
        Amount: { Amount: "45.82", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "Booked",
        BookingDateTime: "2026-09-29T15:22:00+01:00",
        TransactionInformation: "BLUE BOTTLE COFFEE NEW YORK",
        CurrencyExchange: { SourceCurrency: "USD", TargetCurrency: "GBP", ExchangeRate: "0.7637", InstructedAmount: { Amount: "60.00", Currency: "USD" } },
      },
      {
        AccountId: "22289",
        Amount: { Amount: "750.00", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "Booked",
        BookingDateTime: "2026-10-01T09:00:00+01:00",
        TransactionInformation: "SO J SMITH RENT",
        ProprietaryBankTransactionCode: { Code: "SO", Issuer: "AlphaBank" },
        CreditorAccount: { SchemeName: "UK.OBIE.SortCodeAccountNumber", Identification: "40051512345678", Name: "J Smith" },
        SupplementaryData: { CategoryPurposeCode: "GP2P" },
      },
      {
        AccountId: "22289",
        TransactionId: "TX-FUTR-1",
        Amount: { Amount: "12.99", Currency: "GBP" },
        CreditDebitIndicator: "Debit",
        Status: "FUTR",
        BookingDateTime: "2026-10-12T00:00:00+01:00",
        TransactionInformation: "NETFLIX.COM",
      },
    ],
  },
  Links: { Self: "https://api.alphabank.com/open-banking/v3.1/aisp/accounts/22289/transactions/" },
  Meta: { TotalPages: 1, FirstAvailableDateTime: "2017-05-03T00:00:00+00:00", LastAvailableDateTime: "2026-12-03T00:00:00+00:00" },
};

describe("UK Open Banking (OBIE v3.1) mapping", () => {
  const obs = observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, OBIE_TRANSACTIONS);
  const byId = (id: string) => obs.find((o) => o.references.some((r) => r.type === "provider_transaction_id" && r.value === id))!;

  it("maps the specification's example credit", () => {
    const o = byId("123");
    expect(o).toMatchObject({ stage: "posted", direction: "credit" });
    expect(o.amount?.value).toEqual(money(1000, "GBP"));
    expect(o.occurredAt).toEqual({ value: Date.parse("2017-04-05T10:43:07Z"), confidence: 0.95 });
    expect(o.merchant).toEqual({ raw: "Cash from Aubrey", confidence: 0.7 });
    expect(o.balance).toEqual({ current: money(23_000, "GBP") });
    expect(o.references[0]).toEqual({ type: "provider_transaction_id", value: "123", namespace: "obie:22289" });
    expect(o.instrument).toEqual({ type: "bank_account", accountRef: "22289" });
  });

  it("maps card purchases with merchant details and a masked card", () => {
    const o = byId("TX-2026-1003-0001");
    expect(o).toMatchObject({ stage: "posted", direction: "debit", rail: { family: "card" } });
    expect(o.merchant).toEqual({ raw: "PRET A MANGER 0412 LONDON", name: "Pret A Manger", mcc: "5814", channel: "in_store", confidence: 0.9 });
    expect(o.instrument).toEqual({ type: "card", last4: "1234", accountRef: "22289", network: "visa" });
    expect(o.categoryHints).toEqual([{ scheme: "mcc", value: "5814", confidence: 0.9 }]);
    expect(byId("TX-PDNG-77")).toMatchObject({ stage: "pending", merchant: { channel: "online" } });
  });

  it("maps direct debits, cash, FX and P2P standing orders; skips future-dated entries", () => {
    const dd = byId("TX-DD-9");
    expect(dd.rail).toEqual({ family: "direct_debit", scheme: "bacs_dd" });
    expect(dd.counterparty).toEqual({ name: "Thames Water Utilities" });
    const atm = byId("TX-ATM-3");
    expect(atm.rail).toEqual({ family: "cash", scheme: "atm" });
    expect(atm.typeHints).toEqual([{ type: "cash_withdrawal", confidence: 0.9, reason: "uk-open-banking:ProprietaryBankTransactionCode.Code=ATM" }]);
    const fx = byId("TX-FX-5");
    expect(fx.amountBreakdown).toEqual([{ kind: "original_currency", amount: money(6000, "USD") }]);
    // No TransactionId (optional in v3.1): keyed by content, no invented provider reference.
    const rent = obs.find((o) => o.merchant?.raw === "SO J SMITH RENT")!;
    expect(rent.references).toEqual([]);
    expect(rent.rail).toEqual({ family: "account_to_account_instant", scheme: "faster_payments" });
    expect(rent.typeHints).toContainEqual({ type: "transfer", transferKind: "p2p_other", confidence: 0.7, reason: "uk-open-banking:SupplementaryData.CategoryPurposeCode=GP2P" });
    expect(obs.some((o) => o.references.some((r) => r.value === "TX-FUTR-1"))).toBe(false);
    expect(obs.filter((o) => o.kind === "money_movement")).toHaveLength(7);
  });

  it("never emits sort codes or account numbers", () => {
    for (const s of strings(obs)) {
      expect(s).not.toContain("80200110203345");
      expect(s).not.toContain("40051512345678");
      expect(s).not.toContain("MRS J SMITH");
    }
  });

  it("maps the balances endpoint into one snapshot per account", () => {
    const balances = observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, {
      Data: {
        Balance: [
          { AccountId: "22289", Amount: { Amount: "1230.00", Currency: "GBP" }, CreditDebitIndicator: "Credit", Type: "InterimAvailable", DateTime: "2026-10-04T08:00:00+01:00", CreditLine: [{ Included: true, Amount: { Amount: "1000.00", Currency: "GBP" }, Type: "Pre-Agreed" }] },
          { AccountId: "22289", Amount: { Amount: "1185.40", Currency: "GBP" }, CreditDebitIndicator: "Credit", Type: "InterimBooked", DateTime: "2026-10-04T08:00:00+01:00" },
          { AccountId: "31820", Amount: { Amount: "52.10", Currency: "EUR" }, CreditDebitIndicator: "Credit", Type: "ClosingBooked", DateTime: "2026-10-03T23:59:59+02:00" },
        ],
      },
      Links: { Self: "https://api.alphabank.com/open-banking/v3.1/aisp/balances" },
      Meta: { TotalPages: 1 },
    });
    expect(balances).toHaveLength(2);
    expect(balances[0]).toMatchObject({ kind: "balance_snapshot", window: "pre_spend", instrument: { type: "bank_account", accountRef: "22289" } });
    expect(balances[0]!.balance).toEqual({ available: money(123_000, "GBP"), current: money(118_540, "GBP") });
    expect(balances[0]!.occurredAt).toEqual({ value: Date.UTC(2026, 9, 4, 7), confidence: 0.95 });
    expect(balances[1]!.balance).toEqual({ current: money(5210, "EUR") });
  });

  it("is idempotent", () => {
    expect(observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, OBIE_TRANSACTIONS).map((o) => o.id)).toEqual(obs.map((o) => o.id));
  });
});

/* ------------------------------------------------------------------ */
/* A new bank as configuration only: Up (Australia)                    */
/* ------------------------------------------------------------------ */

/**
 * Up Bank API v1 (github.com/up-banking/api, v1/openapi.json): transaction
 * resources with `attributes.status` HELD|SETTLED, signed decimal
 * `amount.value`, `rawText`/`description`, `cardPurchaseMethod`.
 */
const UP_MAPPING: LedgerMapping = {
  id: "up-bank",
  kind: "neobank_api",
  displayName: "Up",
  label: "Up account",
  provider: "Up",
  transactions: {
    records: "data",
    fields: {
      id: "id",
      idNamespace: "up:{relationships.account.data.id}",
      amount: { path: "attributes.amount.value", unit: "major", sign: "negative_is_debit", currency: "attributes.amount.currencyCode" },
      stage: [{ path: "attributes.status", map: { HELD: "pending", SETTLED: "posted" } }],
      occurredAt: [{ path: "attributes.createdAt" }],
      merchantRaw: "attributes.rawText",
      merchantName: "attributes.description",
      accountRef: "relationships.account.data.id",
      last4: "attributes.cardPurchaseMethod.cardNumberSuffix",
      instrumentType: { path: "attributes.cardPurchaseMethod.method", present: "card", absent: "bank_account" },
      channel: { path: "attributes.cardPurchaseMethod.method", map: { CONTACTLESS: "in_store", CARD_PIN: "in_store", ECOMMERCE: "online", CARD_ON_FILE: "online", CARD_DETAILS: "online" } },
      hints: [{ path: "relationships.category.data.id", map: { takeaway: { brake: "eating_out.delivery", confidence: 0.8 }, groceries: { brake: "groceries", confidence: 0.8 } } }],
    },
  },
};

describe("a new bank by configuration (Up, Australia)", () => {
  const held = {
    data: {
      type: "transactions",
      id: "b4f1c6e2-8a8e-4c0e-9d3f-2c4b5a6d7e8f",
      attributes: {
        status: "HELD",
        rawText: "MENULOG PTY LTD SYDNEY",
        description: "Menulog",
        message: null,
        isCategorizable: true,
        holdInfo: { amount: { currencyCode: "AUD", value: "-38.50", valueInBaseUnits: -3850 }, foreignAmount: null },
        amount: { currencyCode: "AUD", value: "-38.50", valueInBaseUnits: -3850 },
        foreignAmount: null,
        cardPurchaseMethod: { method: "CARD_ON_FILE", cardNumberSuffix: "0123" },
        settledAt: null,
        createdAt: "2026-10-04T19:12:44+10:00",
      },
      relationships: { account: { data: { type: "accounts", id: "acc-up-spending" } }, category: { data: { type: "categories", id: "takeaway" } } },
    },
  };

  it("parses AUD transactions and links HELD to SETTLED with no code", () => {
    const au: AdapterContext = { clock: fixedClock(NOW), country: "AU", locale: "en-AU", timeZone: "Australia/Sydney" };
    const [pending] = observations(UP_MAPPING, held, au);
    const [posted] = observations(UP_MAPPING, { data: { ...held.data, attributes: { ...held.data.attributes, status: "SETTLED", settledAt: "2026-10-05T03:00:00+10:00" } } }, au);
    expect(pending).toMatchObject({ stage: "pending", direction: "debit", amount: { value: money(3850, "AUD") } });
    expect(pending!.instrument).toEqual({ type: "card", last4: "0123", accountRef: "acc-up-spending" });
    expect(pending!.merchant).toMatchObject({ raw: "MENULOG PTY LTD SYDNEY", name: "Menulog", channel: "online" });
    expect(pending!.categoryHints).toEqual([{ scheme: "brake", value: "eating_out.delivery", confidence: 0.8 }]);
    expect(pending!.occurredAt?.value).toBe(Date.UTC(2026, 9, 4, 9, 12, 44));
    expect(posted!.stage).toBe("posted");
    expect(posted!.references).toEqual(pending!.references);
    expect(assessPair(posted!, pending!, FUSION, defaultMerchantMatcher).probability).toBeGreaterThan(0.99);
  });

  it("validates mappings up front", () => {
    expect(validateLedgerMapping(UP_MAPPING)).toEqual([]);
    expect(validateLedgerMapping(MONZO_TRANSACTION_WEBHOOK_MAPPING)).toEqual([]);
    expect(validateLedgerMapping(OBIE_ACCOUNT_TRANSACTIONS_MAPPING)).toEqual([]);
    const broken: LedgerMapping = {
      id: "Bad Bank",
      kind: "neobank_api",
      displayName: "Bad",
      label: "",
      transactions: {
        records: "items",
        fields: {
          id: "id",
          idNamespace: "bad:{acct}",
          amount: { path: "amt", unit: "major", sign: "unsigned", currency: { const: "USD" } },
          stage: [{ path: "s", map: { X: "settled" as never } }],
          hints: [{ path: "c", map: { food: { brake: "Food & Drink" } } }],
        },
      },
    };
    const errors = validateLedgerMapping(broken);
    expect(errors).toEqual(
      expect.arrayContaining([
        "id must be kebab-case",
        "label is required (it is shown after 'your' in provenance)",
        "unsigned amounts need fields.direction",
        'unknown stage "settled"',
        'malformed BRAKE category id "Food & Drink"',
      ]),
    );
    expect(() => createLedgerAdapter(broken)).toThrow(RangeError);
  });

  it("uses a constant currency and the user's default when the source omits one", () => {
    const mapping: LedgerMapping = {
      ...UP_MAPPING,
      id: "up-bank-const",
      transactions: {
        records: "data",
        fields: { ...UP_MAPPING.transactions!.fields, amount: { path: "attributes.amount.value", unit: "major", sign: "negative_is_debit", currency: "attributes.missing" } },
      },
    };
    const [o] = observations(mapping, held, { clock: fixedClock(NOW), defaultCurrency: "AUD" });
    expect(o!.amount?.value).toEqual(money(3850, "AUD"));
    expect(run(mapping, held, { clock: fixedClock(NOW) })).toMatchObject({ status: "rejected" });
    // Deliberately skipped records (future-dated) are a valid empty result, not an error.
    const futureOnly = { Data: { Transaction: [OBIE_TRANSACTIONS.Data.Transaction[7]] } };
    expect(run(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, futureOnly)).toEqual({ status: "observations", observations: [] });
    expect(run(mapping, { unrelated: true }, GB)).toEqual({ status: "ignored", reason: "unsupported_format" });
  });
});

/* ------------------------------------------------------------------ */
/* Adversarial review regressions                                      */
/* ------------------------------------------------------------------ */

describe("ledger review regressions", () => {
  it("masks IBANs, very long references and UK sort code + account numbers in descriptors", () => {
    // ISO 13616 example IBANs (DE, FR, GB, NL) as EU banks and AISPs (Tink, TrueLayer) put them in remittance text.
    const cases: Array<[string, string]> = [
      ["SEPA-Überweisung DE89370400440532013000 Max Mustermann", "DE89370400440532013000"],
      ["Prélèvement FR1420041010050500013M02606 loyer", "FR1420041010050500013M02606"],
      ["IBAN GB29 NWBK 6016 1331 9268 19 rent", "6016 1331 9268"],
      ["NL91ABNA0417164300 Albert Heijn", "0417164300"],
      ["REF 12345678901234567890 ACME", "12345678901234567890"],
      // Barclays/Lloyds-style internal transfer text: sort code then 8-digit account number.
      ["TFR 20-45-77 12345678 J SMITH", "12345678"],
      ["TO A/C 87654321 SAVINGS", "87654321"],
    ];
    for (const [input, secret] of cases) {
      const out = scrubDescriptor(input)!;
      expect(out, input).not.toContain(secret);
      expect(out, input).toMatch(/[A-Za-z]{3}/);
    }
    // Merchant names that merely look structured survive.
    expect(scrubDescriptor("AMZN Mktp DE*2K4L19UK5")).toBe("AMZN Mktp DE*2K4L19UK5");
    expect(scrubDescriptor("PRET A MANGER 0412 LONDON 04-10-26")).toBe("PRET A MANGER 0412 LONDON 04-10-26");
  });

  it("never throws on an unknown IANA zone (falls back to UTC)", () => {
    expect(parseInstant("2026-10-04T10:41:00", { timeZone: "Mars/Olympus_Mons" })).toEqual({ at: Date.UTC(2026, 9, 4, 10, 41), precision: "datetime" });
    expect(parseInstant("2026-10-04", { timeZone: "not a zone" })).toEqual({ at: Date.UTC(2026, 9, 4, 12), precision: "date" });
    const bogus: AdapterContext = { ...GB, timeZone: "Europe/Atlantis" };
    const midnight = { Data: { Transaction: [{ ...OBIE_TRANSACTIONS.Data.Transaction[3], BookingDateTime: "2026-10-01T00:00:00+00:00" }] } };
    expect(run(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, midnight, bogus).status).toBe("observations");
  });

  it("treats OBIE midnight booking times as date-only, not as an exact 00:00 event", () => {
    // Many ASPSPs publish BookingDateTime as the booking date padded with T00:00:00.
    const [o] = observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, {
      Data: { Transaction: [{ ...OBIE_TRANSACTIONS.Data.Transaction[3], BookingDateTime: "2026-10-01T00:00:00+00:00", ValueDateTime: "2026-10-01T00:00:00+00:00" }] },
    });
    expect(o!.occurredAt?.confidence).toBeLessThan(0.5);
  });

  it("does not report an OBIE debit (overdrawn) balance as money in the account", () => {
    // OBReadBalance1: CreditDebitIndicator "Debit" = negative balance on a current account (or owed on a card account).
    const [snap] = observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, {
      Data: {
        Balance: [
          { AccountId: "22289", Amount: { Amount: "312.45", Currency: "GBP" }, CreditDebitIndicator: "Debit", Type: "InterimAvailable", DateTime: "2026-10-04T08:00:00+01:00" },
          { AccountId: "22289", Amount: { Amount: "312.45", Currency: "GBP" }, CreditDebitIndicator: "Debit", Type: "InterimBooked", DateTime: "2026-10-04T08:00:00+01:00" },
        ],
      },
    });
    expect(snap!.confidence).toBeLessThanOrEqual(0.5);
    expect(snap!.evidence.summary).toMatch(/debit balance|overdrawn/i);
    // A balance-after on an overdrawn entry must not turn into a positive running balance.
    const [entry] = observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, {
      Data: {
        Transaction: [
          { ...OBIE_TRANSACTIONS.Data.Transaction[4], Balance: { Amount: { Amount: "312.45", Currency: "GBP" }, CreditDebitIndicator: "Debit", Type: "InterimBooked" } },
        ],
      },
    });
    expect(entry!.balance).toBeUndefined();
  });

  it("keeps the ambiguous CCRD purpose code a weak credit-card-payment hint (docs/research/10 §A6)", () => {
    // ISO ExternalCategoryPurpose1Code CCRD/DCRD mark payments *made with* a card as often as card-bill payments.
    const [o] = observations(OBIE_ACCOUNT_TRANSACTIONS_MAPPING, {
      Data: { Transaction: [{ ...OBIE_TRANSACTIONS.Data.Transaction[1], TransactionId: "TX-CCRD", CategoryPurposeCode: "CCRD" }] },
    });
    const hint = o!.typeHints?.find((h) => h.type === "credit_card_payment");
    expect(hint?.confidence ?? 0).toBeLessThanOrEqual(0.4);
  });
});
