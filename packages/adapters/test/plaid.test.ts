import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext, Observation, RawSignal } from "@brake/core";
import { assessPair } from "../../core/src/fusion/match";
import { defaultMerchantMatcher } from "../../core/src/fusion/merchant";
import type { FusionConfig } from "../../core/src/fusion/types";
import { createPlaidAdapter } from "../src/plaid";
import type { PlaidAccount, PlaidSyncPage, PlaidTransaction } from "../src/plaid";

/*
 * Payloads follow Plaid's `/transactions/sync` response as documented in the
 * Plaid API reference and OpenAPI 2020-09-14_1.762.0 (the Walmart record is
 * Plaid's own documentation example). Amounts are positive for money out.
 */

const RECEIVED = Date.UTC(2026, 9, 4, 14, 0, 0);
const US: AdapterContext = { clock: fixedClock(RECEIVED), country: "US", locale: "en-US", timeZone: "America/Los_Angeles" };
const adapter = createPlaidAdapter();

const FUSION: FusionConfig = {
  linkThreshold: 0.9,
  possibleThreshold: 0.5,
  ambiguityMargin: 0.15,
  priorLogOdds: Math.log(0.1 / 0.9),
  intentHorizonMs: 24 * 3_600_000,
  pendingToPostedTolerance: 0.3,
  approximateAmountTolerance: 0.15,
};

const CHECKING = "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp";
const CREDIT = "dVzbVMLjrxTnLjX4G66XUp5GLklm4oiZy88yK";

const ACCOUNTS: PlaidAccount[] = [
  {
    account_id: CHECKING,
    balances: { available: 1203.42, current: 1274.93, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    mask: "0000",
    name: "Plaid Checking",
    official_name: "Plaid Gold Standard 0% Interest Checking",
    type: "depository",
    subtype: "checking",
  },
  {
    account_id: CREDIT,
    balances: { available: 6900, current: 410.5, limit: 7310, iso_currency_code: "USD", unofficial_currency_code: null },
    mask: "3333",
    name: "Plaid Credit Card",
    official_name: "Plaid Diamond 12.5% APR Interest Credit Card",
    type: "credit",
    subtype: "credit card",
  },
];

function txn(p: Partial<PlaidTransaction> & Pick<PlaidTransaction, "transaction_id" | "amount">): PlaidTransaction {
  return {
    account_id: CHECKING,
    pending: false,
    pending_transaction_id: null,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-10-03",
    authorized_date: "2026-10-02",
    datetime: null,
    authorized_datetime: null,
    name: "UNKNOWN",
    merchant_name: null,
    payment_channel: "other",
    personal_finance_category: null,
    counterparties: [],
    location: {},
    payment_meta: {},
    transaction_code: null,
    ...p,
  };
}

const WALMART: PlaidTransaction = {
  account_id: CHECKING,
  account_owner: null,
  amount: 72.1,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  check_number: null,
  counterparties: [
    {
      name: "Walmart",
      type: "merchant",
      logo_url: "https://plaid-merchant-logos.plaid.com/walmart_1100.png",
      website: "walmart.com",
      entity_id: "O5W5j4dN9OR3E6ypQmjdkWZZRoXEzVMz2ByWM",
      confidence_level: "VERY_HIGH",
    },
  ],
  date: "2023-09-24",
  datetime: "2023-09-24T11:01:01Z",
  authorized_date: "2023-09-22",
  authorized_datetime: "2023-09-22T10:34:50Z",
  location: {
    address: "13425 Community Rd",
    city: "Poway",
    region: "CA",
    postal_code: "92064",
    country: "US",
    lat: 32.959068,
    lon: -117.037666,
    store_number: "1700",
  },
  name: "PURCHASE WM SUPERCENTER #1700",
  merchant_name: "Walmart",
  merchant_entity_id: "O5W5j4dN9OR3E6ypQmjdkWZZRoXEzVMz2ByWM",
  logo_url: "https://plaid-merchant-logos.plaid.com/walmart_1100.png",
  website: "walmart.com",
  payment_meta: {
    by_order_of: null,
    payee: null,
    payer: null,
    payment_method: null,
    payment_processor: null,
    ppd_id: null,
    reason: null,
    reference_number: null,
  },
  payment_channel: "in store",
  pending: false,
  pending_transaction_id: "no86Eox18VHMvaOVL7gPUM9ap3aR1LsAVZ5nc",
  personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_SUPERSTORES", confidence_level: "VERY_HIGH" },
  transaction_id: "lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje",
  transaction_code: null,
};

function page(p: Partial<PlaidSyncPage>): PlaidSyncPage {
  return { added: [], modified: [], removed: [], accounts: [], next_cursor: "cursor-1", has_more: false, ...p };
}

function parse(payload: PlaidSyncPage, ctx: AdapterContext = US, receivedAt = RECEIVED): Observation[] {
  const signal: RawSignal<PlaidSyncPage> = { adapterId: "plaid", connectionId: "plaid_item_chase", receivedAt, payload };
  const result = adapter.parse(signal, ctx);
  if (result.status !== "observations") throw new Error(`expected observations, got ${result.status}: ${"reason" in result ? result.reason : ""}`);
  return [...result.observations];
}

const ref = (o: Observation, type: string) => o.references.find((r) => r.type === type);

/** Every string value in the output (numbers such as epoch millis are not identifiers). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}
const moneyMovements = (obs: Observation[]) => obs.filter((o) => o.kind === "money_movement");

describe("Plaid adapter: transactions", () => {
  it("maps Plaid's documented Walmart example into a posted debit", () => {
    const [o] = moneyMovements(parse(page({ added: [WALMART], accounts: ACCOUNTS })));
    expect(o).toBeDefined();
    expect(o!.source).toMatchObject({ adapterId: "plaid", kind: "open_banking", connectionId: "plaid_item_chase" });
    expect(o!.source.label).toBe("Plaid Checking ••0000 (via Plaid)");
    expect(o!.kind).toBe("money_movement");
    expect(o!.window).toBe("post_spend");
    expect(o!.stage).toBe("posted");
    expect(o!.direction).toBe("debit");
    expect(o!.amount?.value).toEqual(money(7210, "USD"));
    // Authorization time, not the posting date.
    expect(o!.occurredAt).toEqual({ value: Date.parse("2023-09-22T10:34:50Z"), confidence: 0.95 });
    expect(o!.merchant).toMatchObject({ raw: "PURCHASE WM SUPERCENTER #1700", name: "Walmart", channel: "in_store", website: "walmart.com", confidence: 0.97 });
    expect(o!.instrument).toEqual({ type: "bank_account", accountRef: CHECKING, last4: "0000" });
    expect(o!.country).toBe("US");
    expect(ref(o!, "provider_transaction_id")).toEqual({ type: "provider_transaction_id", value: WALMART.transaction_id, namespace: `plaid:${CHECKING}` });
    expect(ref(o!, "provider_pending_id")).toEqual({ type: "provider_pending_id", value: "no86Eox18VHMvaOVL7gPUM9ap3aR1LsAVZ5nc", namespace: `plaid:${CHECKING}` });
    // PFC is translated, never passed through.
    expect(o!.categoryHints).toEqual([{ scheme: "brake", value: "shopping", confidence: 0.57 }]);
    expect(o!.typeHints?.[0]).toMatchObject({ type: "purchase", reason: "plaid_pfc:GENERAL_MERCHANDISE_SUPERSTORES" });
    expect(o!.confidence).toBe(0.97);
    expect(o!.evidence.summary).toBe("Plaid reported a posted $72.10 debit at Walmart on your Plaid Checking ••0000 (via Plaid).");
  });

  it("links a pending card authorization to its posted record (tip added) across sync pages", () => {
    const pending = txn({
      transaction_id: "pend_8zKr1",
      account_id: CREDIT,
      pending: true,
      amount: 42.1,
      date: "2026-10-01",
      authorized_date: "2026-10-01",
      authorized_datetime: "2026-10-01T19:42:00Z",
      name: "TST* HOPS & BARLEY",
      merchant_name: "Hops & Barley",
      payment_channel: "in store",
      personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT", confidence_level: "HIGH" },
    });
    const posted = txn({
      transaction_id: "post_Q4nV7",
      account_id: CREDIT,
      pending: false,
      pending_transaction_id: "pend_8zKr1",
      amount: 50.52,
      date: "2026-10-03",
      authorized_date: "2026-10-01",
      authorized_datetime: "2026-10-01T19:42:00Z",
      name: "HOPS AND BARLEY SAN DIEGO CA",
      merchant_name: "Hops & Barley",
      payment_channel: "in store",
      personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT", confidence_level: "VERY_HIGH" },
    });

    const [p] = moneyMovements(parse(page({ added: [pending], accounts: ACCOUNTS, next_cursor: "c1" }), US, Date.UTC(2026, 9, 1, 22)));
    // Plaid moves the pending id to `removed` in the same page that adds its posted successor.
    const second = parse(page({ added: [posted], removed: [{ transaction_id: "pend_8zKr1", account_id: CREDIT }], accounts: ACCOUNTS, next_cursor: "c2" }));
    const q = moneyMovements(second);

    expect(p!.stage).toBe("pending");
    expect(p!.amount?.confidence).toBe(0.75); // restaurant: tips change the final amount
    expect(p!.instrument).toEqual({ type: "card", cardKind: "credit", accountRef: CREDIT, last4: "3333" });
    expect(p!.rail).toEqual({ family: "card" });
    // The superseded pending record is not reported as a cancellation.
    expect(q).toHaveLength(1);
    expect(q[0]!.stage).toBe("posted");
    expect(ref(q[0]!, "provider_pending_id")).toEqual({ ...ref(p!, "provider_transaction_id")!, type: "provider_pending_id" });

    const assessment = assessPair(q[0]!, p!, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.features.map((f) => f.name)).toContain("pending_superseded");
    expect(assessment.probability).toBeGreaterThan(0.9);
  });

  it("turns a vanished authorization hold into a cancellation carrying the same provider id", () => {
    const hold = txn({
      transaction_id: "hold_HTL93",
      account_id: CREDIT,
      pending: true,
      amount: 250,
      name: "MARRIOTT SAN DIEGO",
      merchant_name: "Marriott",
      personal_finance_category: { primary: "TRAVEL", detailed: "TRAVEL_LODGING", confidence_level: "VERY_HIGH" },
    });
    const [h] = moneyMovements(parse(page({ added: [hold], accounts: ACCOUNTS })));
    const later = parse(page({ removed: [{ transaction_id: "hold_HTL93", account_id: CREDIT }], accounts: [], next_cursor: "c9" }), US, RECEIVED + 3 * 86_400_000);
    const [c] = later;

    expect(c!.stage).toBe("cancelled");
    expect(c!.amount).toBeUndefined();
    expect(c!.direction).toBeUndefined();
    expect(ref(c!, "provider_transaction_id")).toEqual(ref(h!, "provider_transaction_id"));
    expect(c!.evidence.summary).toContain("removed");

    const assessment = assessPair(c!, h!, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.probability).toBeGreaterThan(0.9);
  });

  it("follows Plaid's sign convention on depository and credit accounts", () => {
    const obs = moneyMovements(
      parse(
        page({
          accounts: ACCOUNTS,
          added: [
            txn({ transaction_id: "cc_purchase", account_id: CREDIT, amount: 89.4, name: "AMAZON.COM*2K4L", merchant_name: "Amazon", payment_channel: "online", personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", confidence_level: "VERY_HIGH" } }),
            txn({ transaction_id: "cc_payment", account_id: CREDIT, amount: -410.5, name: "PAYMENT THANK YOU", personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence_level: "VERY_HIGH" } }),
            txn({ transaction_id: "bank_cc_bill", amount: 410.5, name: "CHASE CREDIT CRD AUTOPAY", personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence_level: "HIGH" } }),
            txn({ transaction_id: "payroll", amount: -2450, name: "GUSTO PAY 123456", personal_finance_category: { primary: "INCOME", detailed: "INCOME_SALARY", confidence_level: "HIGH", version: "v2" }, counterparties: [{ name: "Gusto", type: "income_source", confidence_level: "HIGH" }] }),
            txn({ transaction_id: "amazon_refund", account_id: CREDIT, amount: -24.99, name: "AMAZON.COM REFUND", merchant_name: "Amazon", personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", confidence_level: "HIGH" } }),
          ],
        }),
      ),
    );
    const by = (id: string) => obs.find((o) => ref(o, "provider_transaction_id")?.value === id)!;

    expect(by("cc_purchase")).toMatchObject({ direction: "debit", amount: { value: money(8940, "USD") } });
    expect(by("cc_purchase").categoryHints).toContainEqual({ scheme: "brake", value: "shopping.online_marketplace", confidence: 0.95 });
    expect(by("cc_purchase").merchant?.channel).toBe("online");
    expect(by("cc_payment")).toMatchObject({ direction: "credit", amount: { value: money(41050, "USD") } });
    expect(by("cc_payment").typeHints).toContainEqual({ type: "credit_card_payment", confidence: 0.95, reason: "plaid_pfc:LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" });
    expect(by("bank_cc_bill")).toMatchObject({ direction: "debit", instrument: { type: "bank_account" } });
    expect(by("bank_cc_bill").typeHints?.[0]?.type).toBe("credit_card_payment");
    expect(by("payroll")).toMatchObject({ direction: "credit" });
    expect(by("payroll").typeHints?.[0]).toMatchObject({ type: "income", reason: "plaid_pfc:INCOME_SALARY" });
    expect(by("payroll").counterparty).toEqual({ name: "Gusto", isMerchant: 0.8 });
    expect(by("amazon_refund").direction).toBe("credit");
    expect(by("amazon_refund").typeHints?.[0]).toMatchObject({ type: "refund", reason: "plaid_pfc:GENERAL_MERCHANDISE_ONLINE_MARKETPLACES" });
  });

  it("translates transfer, investment, fee, tax and cash categories into neutral type hints", () => {
    const cases: Array<[string, string, string, string | undefined]> = [
      ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER", "transfer", "own_account"],
      ["TRANSFER_OUT", "TRANSFER_OUT_SAVINGS", "transfer", "own_account"],
      ["TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", "investment", undefined],
      ["TRANSFER_OUT", "TRANSFER_OUT_WITHDRAWAL", "cash_withdrawal", undefined],
      ["TRANSFER_OUT", "TRANSFER_OUT_WIRE", "transfer", "unknown"],
      ["LOAN_PAYMENTS", "LOAN_PAYMENTS_MORTGAGE_PAYMENT", "loan_payment", undefined],
      ["LOAN_PAYMENTS", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT", "loan_payment", undefined],
      ["BANK_FEES", "BANK_FEES_OVERDRAFT_FEES", "fee", undefined],
      ["BANK_FEES", "BANK_FEES_LATE_FEES", "fee", undefined],
      ["GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT", "tax", undefined],
    ];
    const added = cases.map(([primary, detailed], i) =>
      txn({ transaction_id: `t${i}`, amount: 100 + i, personal_finance_category: { primary, detailed, confidence_level: "VERY_HIGH" } }),
    );
    const obs = moneyMovements(parse(page({ added, accounts: ACCOUNTS })));
    cases.forEach(([, detailed, type, transferKind], i) => {
      const o = obs.find((x) => ref(x, "provider_transaction_id")?.value === `t${i}`)!;
      expect(o.typeHints?.[0]).toMatchObject({ type, reason: `plaid_pfc:${detailed}` });
      expect(o.typeHints?.[0]?.transferKind).toBe(transferKind);
    });
    const tax = obs.find((x) => ref(x, "provider_transaction_id")?.value === "t9")!;
    expect(tax.categoryHints).toContainEqual({ scheme: "brake", value: "taxes", confidence: 0.95 });
    // A detailed code this adapter does not know yet still maps through its primary.
    const [future] = moneyMovements(
      parse(page({ added: [txn({ transaction_id: "v3", amount: 12, personal_finance_category: { primary: "TRAVEL", detailed: "TRAVEL_SPACE_TOURISM", confidence_level: "MEDIUM" } })] })),
    );
    expect(future!.categoryHints).toEqual([{ scheme: "brake", value: "travel", confidence: 0.6 }]);
  });

  it("handles European institutions: EUR/GBP, transaction codes and masked card numbers in descriptors", () => {
    const es: AdapterContext = { clock: fixedClock(RECEIVED), country: "ES", locale: "es-ES", timeZone: "Europe/Madrid" };
    const obs = moneyMovements(
      parse(
        page({
          institution_name: "BBVA",
          accounts: [{ account_id: "es_acc", balances: { current: 1830.2, iso_currency_code: "EUR" }, mask: "7788", name: "Cuenta Online", type: "depository", subtype: "checking" }],
          added: [
            txn({ transaction_id: "es1", account_id: "es_acc", amount: 23.45, iso_currency_code: "EUR", date: "2026-10-02", authorized_date: null, name: "COMPRA TARJ. 4111111111111111 MERCADONA VALENCIA", merchant_name: "Mercadona", transaction_code: "purchase", payment_channel: "in store", personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES", confidence_level: "HIGH" } }),
            txn({ transaction_id: "es2", account_id: "es_acc", amount: 54.9, iso_currency_code: "EUR", date: "2026-10-01", authorized_date: null, name: "RECIBO VODAFONE ESPANA", transaction_code: "direct debit", personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_TELEPHONE", confidence_level: "VERY_HIGH" } }),
            txn({ transaction_id: "es3", account_id: "es_acc", amount: 60, iso_currency_code: "EUR", date: "2026-10-01", authorized_date: null, name: "REINTEGRO CAJERO 512345XXXXXX9012", transaction_code: "atm" }),
          ],
        }),
        es,
      ),
    );
    const by = (id: string) => obs.find((o) => ref(o, "provider_transaction_id")?.value === id)!;
    expect(by("es1").amount?.value).toEqual(money(2345, "EUR"));
    expect(by("es1").source.label).toBe("BBVA Cuenta Online ••7788 (via Plaid)");
    expect(by("es1").source.provider).toBe("BBVA");
    expect(by("es1").merchant?.raw).toBe("COMPRA TARJ. ••••1111 MERCADONA VALENCIA");
    expect(by("es1").typeHints).toContainEqual({ type: "purchase", confidence: 0.7, reason: "plaid_code:purchase" });
    // Date-only: local noon in the user's zone, confidence below 0.5 so fusion allows a day of slack.
    expect(by("es1").occurredAt).toEqual({ value: Date.parse("2026-10-02T10:00:00Z"), confidence: 0.4 });
    expect(by("es2").rail).toEqual({ family: "direct_debit" });
    expect(by("es2").categoryHints).toContainEqual({ scheme: "brake", value: "bills.phone_internet", confidence: 0.95 });
    expect(by("es3").rail).toEqual({ family: "cash", scheme: "atm" });
    expect(by("es3").typeHints?.[0]).toMatchObject({ type: "cash_withdrawal", reason: "plaid_code:atm" });
    expect(by("es3").merchant?.raw).toBe("REINTEGRO CAJERO ••••9012");
    const json = JSON.stringify(obs);
    expect(json).not.toContain("4111111111111111");
    expect(json).not.toContain("512345");
  });

  it("treats Plaid's default-midnight datetimes as dates and flags P2P app counterparties", () => {
    const [o] = moneyMovements(
      parse(
        page({
          added: [
            txn({
              transaction_id: "zelle1",
              amount: 120,
              date: "2026-10-03",
              authorized_date: null,
              datetime: "2026-10-03T00:00:00Z",
              name: "Zelle payment to JORDAN P",
              payment_meta: { payee: "JORDAN P", payment_method: "Zelle" },
              counterparties: [{ name: "Zelle", type: "payment_app", confidence_level: "VERY_HIGH" }],
              personal_finance_category: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_OTHER_TRANSFER_OUT", confidence_level: "HIGH" },
            }),
          ],
        }),
      ),
    );
    expect(o!.occurredAt?.confidence).toBe(0.4);
    expect(o!.rail).toEqual({ family: "account_to_account_instant", scheme: "zelle" });
    expect(o!.typeHints).toContainEqual({ type: "transfer", transferKind: "p2p_other", confidence: 0.45, reason: "plaid_counterparty:payment_app" });
    expect(o!.counterparty).toEqual({ name: "Zelle", isMerchant: 0.2 });
  });

  it("supports Canadian dollars and unofficial currency codes", () => {
    const ca: AdapterContext = { clock: fixedClock(RECEIVED), country: "CA", locale: "en-CA", timeZone: "America/Toronto" };
    const obs = moneyMovements(
      parse(
        page({
          added: [
            txn({ transaction_id: "ca1", amount: 6.75, iso_currency_code: "CAD", name: "TIM HORTONS #2231", merchant_name: "Tim Hortons", personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE", confidence_level: "VERY_HIGH" } }),
            txn({ transaction_id: "btc1", amount: 0.0015, iso_currency_code: null, unofficial_currency_code: "BTC", name: "COINBASE BUY" }),
          ],
        }),
        ca,
      ),
    );
    expect(obs[0]!.amount?.value).toEqual(money(675, "CAD"));
    expect(obs[0]!.categoryHints).toContainEqual({ scheme: "brake", value: "eating_out.cafe", confidence: 0.95 });
    expect(obs[1]!.amount?.value.currency).toBe("BTC");
  });
});

describe("Plaid adapter: balances, idempotency, privacy", () => {
  it("emits pre-spend balance snapshots per account", () => {
    const obs = parse(page({ accounts: ACCOUNTS }));
    const balances = obs.filter((o) => o.kind === "balance_snapshot");
    expect(balances).toHaveLength(2);
    const checking = balances.find((o) => o.instrument?.accountRef === CHECKING)!;
    expect(checking).toMatchObject({ window: "pre_spend", stage: "unknown" });
    expect(checking.balance).toEqual({ available: money(120342, "USD"), current: money(127493, "USD") });
    const card = balances.find((o) => o.instrument?.accountRef === CREDIT)!;
    expect(card.balance).toEqual({ available: money(690000, "USD"), current: money(41050, "USD"), limit: money(731000, "USD") });
    expect(card.evidence.summary).toBe("Plaid reported a card balance of $410.50 on your Plaid Credit Card ••3333 (via Plaid).");
  });

  it("flags an overdrawn balance instead of silently reporting it as positive", () => {
    const [b] = parse(page({ accounts: [{ ...ACCOUNTS[0]!, balances: { available: -45.5, current: -45.5, iso_currency_code: "USD" } }] }));
    expect(b!.confidence).toBe(0.5);
    expect(b!.evidence.summary).toContain("overdrawn");
  });

  it("gives identical ids for re-delivered pages and new ids for modified records", () => {
    const first = parse(page({ added: [WALMART], accounts: ACCOUNTS }));
    const again = parse(page({ added: [WALMART], accounts: ACCOUNTS }));
    expect(again.map((o) => o.id)).toEqual(first.map((o) => o.id));

    const modified = parse(page({ modified: [{ ...WALMART, amount: 74.6 }], accounts: ACCOUNTS }));
    const m = moneyMovements(modified)[0]!;
    const f = moneyMovements(first)[0]!;
    expect(m.id).not.toBe(f.id);
    expect(ref(m, "provider_transaction_id")).toEqual(ref(f, "provider_transaction_id"));
  });

  it("never emits full card or account numbers", () => {
    const obs = parse(
      page({
        accounts: ACCOUNTS,
        added: [
          txn({ transaction_id: "x1", amount: 500, name: "ONLINE TRANSFER TO SAVINGS ACCT 004412345678901", original_description: "XFER TO 004412345678901 REF 5555555555554444" }),
          txn({ transaction_id: "x2", amount: 19.99, name: "CARD 5555555555554444 SPOTIFY USA" }),
        ],
      }),
    );
    for (const s of strings(obs)) expect(s).not.toMatch(/\d{9,}/);
    expect(JSON.stringify(obs)).not.toContain("004412345678901");
    for (const o of obs) if (o.instrument?.last4) expect(o.instrument.last4).toMatch(/^\d{4}$/);
  });

  it("rejects malformed pages and skips malformed records", () => {
    const signal = (payload: unknown): RawSignal<PlaidSyncPage> => ({ adapterId: "plaid", connectionId: "c", receivedAt: RECEIVED, payload: payload as PlaidSyncPage });
    expect(adapter.parse(signal({ added: [] }), US).status).toBe("rejected");
    expect(adapter.parse(signal({ added: [{ transaction_id: "x" }], modified: [], removed: [] }), US).status).toBe("rejected");
    const empty = adapter.parse(signal({ added: [], modified: [], removed: [] }), US);
    expect(empty).toEqual({ status: "observations", observations: [] });
  });

  it("describes itself for the capability registry", () => {
    expect(adapter.descriptor).toMatchObject({ id: "plaid", kind: "open_banking", windows: ["pre_spend", "post_spend"], requiresCapabilities: ["data:plaid"] });
  });
});
