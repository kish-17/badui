import { describe, expect, it } from "vitest";
import { DAY, HOUR, money, userInference } from "@brake/core";
import type {
  CandidateLink,
  CandidatePatch,
  CategoryId,
  Inference,
  InstrumentObservation,
  Money,
  OwnedInstrument,
  RailFamily,
  Reference,
  TransactionCandidate,
  TransactionType,
  TransferKind,
} from "@brake/core";
import { inference, makeCandidate } from "@brake/core/testing";
import type { Distribution, ReconciliationContext, UserModel } from "../src/contracts";
import { toneIssues } from "../src/copy";
import { RECONCILIATION_LINK_KINDS, createReconciler, explainReconciliationLink } from "../src/reconcile";
import { spendingEffect, summarizeSpending } from "../src/spending";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 9, 4, 12, 0);
const at = (month: number, day: number, hour = 4, minute = 0) => Date.UTC(2026, month - 1, day, hour, minute);

interface Leg {
  readonly id: string;
  readonly minor: number;
  readonly currency: string;
  readonly t: number;
  readonly raw?: string;
  readonly key?: string;
  readonly name?: string;
  readonly handle?: string;
  readonly isMerchant?: number;
  readonly isSelf?: number;
  readonly mcc?: string;
  readonly rail?: RailFamily;
  readonly instrument?: InstrumentObservation;
  readonly original?: Money;
  readonly type?: Inference<TransactionType>;
  readonly transferKind?: TransferKind;
  readonly status?: TransactionCandidate["status"];
  readonly references?: readonly Reference[];
  readonly links?: readonly CandidateLink[];
}

function leg(direction: "debit" | "credit", p: Leg): TransactionCandidate {
  const hasParty = p.name !== undefined || p.handle !== undefined || p.isMerchant !== undefined || p.isSelf !== undefined;
  return makeCandidate({
    id: p.id,
    direction,
    minor: p.minor,
    currency: p.currency,
    timestampEstimated: p.t,
    merchant: {
      raw: p.raw ?? null,
      normalized: p.key ?? null,
      displayName: null,
      confidence: p.key ? 0.9 : 0,
      channel: "unknown",
      ...(p.mcc ? { mcc: p.mcc } : {}),
    },
    ...(hasParty
      ? {
          counterparty: {
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.handle !== undefined ? { handle: p.handle } : {}),
            ...(p.isMerchant !== undefined ? { isMerchant: p.isMerchant } : {}),
            ...(p.isSelf !== undefined ? { isSelf: p.isSelf } : {}),
          },
        }
      : {}),
    paymentRail: { family: p.rail ?? "unknown" },
    ...(p.instrument ? { instrument: p.instrument } : {}),
    ...(p.original ? { originalAmount: p.original } : {}),
    ...(p.type ? { transactionType: p.type } : {}),
    ...(p.transferKind ? { transferKind: p.transferKind } : {}),
    ...(p.status ? { status: p.status } : {}),
    ...(p.references ? { references: p.references } : {}),
    ...(p.links ? { links: p.links } : {}),
  });
}
const debit = (p: Leg) => leg("debit", p);
const credit = (p: Leg) => leg("credit", p);

interface ModelSpec {
  readonly types?: Readonly<Record<string, Distribution<TransactionType>>>;
  readonly kinds?: Readonly<Record<string, Distribution<TransferKind>>>;
  readonly categories?: Readonly<Record<string, Distribution<CategoryId>>>;
}

function model(s: ModelSpec = {}): UserModel {
  return {
    observe: () => undefined,
    categoryFor: (k) => s.categories?.[k] ?? null,
    typeFor: (k) => s.types?.[k] ?? null,
    transferKindFor: (k) => s.kinds?.[k] ?? null,
    essentialityFor: () => null,
    labelCount: () => 0,
    toJSON: () => ({}),
  };
}

function ctx(p: Partial<ReconciliationContext> = {}): ReconciliationContext {
  return { ownedInstruments: [], selfNames: [], userModel: model(), now: NOW, ...p };
}

/** Apply a patch the way fusion's patchCandidate does: reconciliation-owned link kinds are replaced. */
function apply(c: TransactionCandidate, patch: CandidatePatch | undefined): TransactionCandidate {
  if (!patch) return c;
  return {
    ...c,
    ...(patch.transactionType ? { transactionType: patch.transactionType } : {}),
    ...(patch.transferKind ? { transferKind: patch.transferKind } : {}),
    ...(patch.category ? { category: patch.category } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    attributes: { ...c.attributes, ...patch.attributes },
    links: patch.links ? [...c.links.filter((l) => !RECONCILIATION_LINK_KINDS.has(l.kind)), ...patch.links] : c.links,
  };
}

const reconciler = createReconciler();

function run(cands: readonly TransactionCandidate[], context: ReconciliationContext = ctx()) {
  const { patches } = reconciler.reconcile(cands, context);
  const applied = cands.map((c) => apply(c, patches.get(c.id)));
  const byId = new Map(applied.map((c) => [c.id, c] as const));
  return {
    patches,
    applied,
    /** The candidate after its patch (if any) was applied. */
    get: (id: string): TransactionCandidate => byId.get(id)!,
  };
}

const targets = (c: TransactionCandidate, kind: CandidateLink["kind"]) => c.links.filter((l) => l.kind === kind).map((l) => l.target);
const alt = (c: TransactionCandidate, type: TransactionType) => c.transactionType.alternatives.find((a) => a.value === type)?.probability ?? 0;
const pOf = (c: TransactionCandidate, type: TransactionType) => (c.transactionType.value === type ? c.transactionType.confidence : alt(c, type));

// Instruments: masked identifiers only.
const IN_SAVINGS: InstrumentObservation = { type: "bank_account", issuer: "HDFC Bank", last4: "1234" };
const IN_SALARY: InstrumentObservation = { type: "bank_account", issuer: "State Bank of India", last4: "5678" };
const US_CHECKING: InstrumentObservation = { type: "bank_account", issuer: "Chase", last4: "1111" };
const US_SAVINGS: InstrumentObservation = { type: "bank_account", issuer: "Ally", last4: "2222" };
const US_CARD: InstrumentObservation = { type: "card", issuer: "Chase", last4: "9876", cardKind: "credit", network: "visa" };
const IN_WALLET: InstrumentObservation = { type: "wallet", issuer: "Paytm", accountRef: "wallet-ref-1" };
const owned = (...xs: InstrumentObservation[]): OwnedInstrument[] =>
  xs.map((x) => ({
    type: x.type === "mobile_money" ? "wallet" : (x.type as OwnedInstrument["type"]),
    ...(x.issuer ? { issuer: x.issuer } : {}),
    ...(x.last4 ? { last4: x.last4 } : {}),
    ...(x.accountRef ? { accountRef: x.accountRef } : {}),
    ...(x.cardKind ? { cardKind: x.cardKind } : {}),
  }));

/* ------------------------------------------------------------------ */
/* 1. Own-account transfers                                             */
/* ------------------------------------------------------------------ */

describe("own-account transfers", () => {
  it("pairs an IMPS between two owned accounts as a transfer, linked both ways", () => {
    const d = debit({ id: "d", minor: 5_000_000, currency: "INR", t: at(9, 10, 10), raw: "IMPS/P2A/627712345678/PRIYA SHARMA", instrument: IN_SAVINGS, rail: "account_to_account_instant" });
    const c = credit({ id: "c", minor: 5_000_000, currency: "INR", t: at(9, 10, 10, 5), raw: "IMPS/627712345678/FROM PRIYA SHARMA", instrument: IN_SALARY });
    const r = run([d, c], ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY), selfNames: ["Priya Sharma"] }));
    for (const id of ["d", "c"]) {
      const x = r.get(id);
      expect(x.transactionType.value).toBe("transfer");
      expect(x.transactionType.confidence).toBeGreaterThanOrEqual(0.9);
      expect(x.transactionType.basis).toContain("reconciliation");
      expect(x.transferKind).toBe("own_account");
      expect(spendingEffect(x).bucket).toBe("transfer");
    }
    expect(targets(r.get("d"), "transfer_counterpart")).toEqual(["c"]);
    expect(targets(r.get("c"), "transfer_counterpart")).toEqual(["d"]);
    // Never collapsed: the purchase reading survives as an alternative on the debit.
    expect(alt(r.get("d"), "purchase")).toBeGreaterThan(0);
  });

  it("pairs Zelle legs across two US banks on the user's name alone, less surely than with owned instruments", () => {
    const d = debit({ id: "d", minor: 100_000, currency: "USD", t: at(9, 3, 15), raw: "ZELLE TO PRIYA SHARMA", instrument: US_CHECKING });
    const c = credit({ id: "c", minor: 100_000, currency: "USD", t: at(9, 4, 15), raw: "ZELLE FROM PRIYA SHARMA", instrument: US_SAVINGS });
    const r = run([d, c], ctx({ selfNames: ["Priya Sharma", "P Sharma"] }));
    expect(r.get("d").transactionType.value).toBe("transfer");
    expect(r.get("d").transferKind).toBe("own_account");
    expect(targets(r.get("c"), "transfer_counterpart")).toEqual(["d"]);
    const link = r.get("d").links.find((l) => l.kind === "transfer_counterpart")!;
    expect(link.probability).toBeGreaterThan(0.75);
    expect(link.probability).toBeLessThan(0.95);
  });

  it("pairs a SEPA transfer whose counterparty isSelf ≥ 0.8, at moderate confidence", () => {
    const d = debit({ id: "d", minor: 200_000, currency: "EUR", t: at(9, 1, 8), raw: "SEPA-Überweisung an Max Mustermann", name: "Max Mustermann", isSelf: 0.85, instrument: { type: "bank_account", issuer: "Sparkasse", last4: "4444" } });
    const c = credit({ id: "c", minor: 200_000, currency: "EUR", t: at(9, 3, 8), raw: "SEPA-Gutschrift Max Mustermann", instrument: { type: "bank_account", issuer: "DKB", last4: "5555" } });
    const r = run([d, c]);
    const p = r.get("d").links.find((l) => l.kind === "transfer_counterpart")?.probability ?? 0;
    expect(p).toBeGreaterThanOrEqual(0.6);
    expect(p).toBeLessThan(0.9);
    expect(r.get("c").transactionType.value).toBe("transfer");
  });

  it("bridges currencies through the original amount", () => {
    const usd = money(100_000, "USD");
    const d = debit({ id: "d", minor: 100_000, currency: "USD", t: at(9, 1, 9), raw: "WIRE TRANSFER TO OWN ACCOUNT", instrument: US_SAVINGS });
    const c = credit({ id: "c", minor: 8_312_000, currency: "INR", t: at(9, 2, 6), raw: "INWARD REMITTANCE", original: usd, instrument: IN_SALARY });
    const r1 = run([d, c], ctx({ ownedInstruments: owned(US_SAVINGS, IN_SALARY) }));
    expect(targets(r1.get("d"), "transfer_counterpart")).toEqual(["c"]);
    expect(r1.get("c").transferKind).toBe("own_account");

    // Both legs converted from the same original amount.
    const d2 = debit({ id: "d2", minor: 79_000, currency: "GBP", original: usd, t: at(9, 1, 9), raw: "TRANSFER TO OWN ACCOUNT", instrument: { type: "bank_account", issuer: "Monzo", last4: "3333" } });
    const r2 = run([d2, c], ctx({ ownedInstruments: owned({ type: "bank_account", issuer: "Monzo", last4: "3333" }, IN_SALARY) }));
    expect(targets(r2.get("d2"), "transfer_counterpart")).toEqual(["c"]);
  });

  it("never pairs equal amounts without ownership evidence", () => {
    const d = debit({ id: "d", minor: 500_000, currency: "INR", t: at(9, 5, 9), raw: "UPI/DR/627712345678/RAHUL VERMA/okaxis" });
    const c = credit({ id: "c", minor: 500_000, currency: "INR", t: at(9, 5, 11), raw: "UPI/CR/627799999999/ANITA DESAI/oksbi" });
    const r = run([d, c]);
    expect(targets(r.get("d"), "transfer_counterpart")).toEqual([]);
    expect(targets(r.get("c"), "transfer_counterpart")).toEqual([]);
    expect(r.get("d").transferKind).not.toBe("own_account");
  });

  it("does not pair legs more than 3 days apart, but still reads the debit as a move to an owned account", () => {
    const d = debit({ id: "d", minor: 5_000_000, currency: "INR", t: at(9, 1, 9), raw: "TRANSFER TO A/C XX5678", instrument: IN_SAVINGS });
    const c = credit({ id: "c", minor: 5_000_000, currency: "INR", t: at(9, 5, 10), raw: "NEFT CREDIT", instrument: IN_SALARY });
    const r = run([d, c], ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY) }));
    expect(r.get("d").links).toEqual([]);
    expect(r.get("c").links).toEqual([]);
    expect(r.get("d").transactionType.value).toBe("transfer");
    expect(r.get("d").transferKind).toBe("own_account");
  });

  it("treats a same-account debit and equal credit as a reversal, never as an own-account transfer", () => {
    const rrn: Reference = { type: "rail_reference", value: "627712345678", namespace: "upi" };
    const d = debit({ id: "d", minor: 45_000, currency: "INR", t: at(9, 9, 13), raw: "UPI/DR/627712345678/SWIGGY/swiggy.rzp@icici", key: "swiggy", handle: "swiggy.rzp@icici", instrument: IN_SAVINGS, references: [rrn] });
    const c = credit({ id: "c", minor: 45_000, currency: "INR", t: at(9, 9, 15), raw: "REV-UPI/627712345678/SWIGGY", key: "swiggy", instrument: IN_SAVINGS, references: [rrn] });
    const r = run([d, c], ctx({ ownedInstruments: owned(IN_SAVINGS) }));
    expect(targets(r.get("d"), "transfer_counterpart")).toEqual([]);
    expect(targets(r.get("c"), "refund_of")).toEqual(["d"]);
    expect(r.get("d").status).toBe("refunded");
  });

  it("reads a single leg to an owned account or handle as own_account at lower confidence than a pair", () => {
    const d = debit({ id: "d", minor: 5_000_000, currency: "INR", t: at(9, 1, 9), raw: "TRANSFER TO A/C XX5678", instrument: IN_SAVINGS });
    const r = run([d], ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY) }));
    const x = r.get("d");
    expect(x.transactionType.value).toBe("transfer");
    expect(x.transferKind).toBe("own_account");
    expect(x.transactionType.confidence).toBeGreaterThanOrEqual(0.6);
    expect(x.transactionType.confidence).toBeLessThan(0.85);

    const h = debit({ id: "h", minor: 1_000_000, currency: "INR", t: at(9, 2, 9), raw: "UPI/DR/627712345670/PRIYA/oksbi", handle: "priya.s@oksbi", instrument: IN_SAVINGS });
    const rh = run([h], ctx({ ownedInstruments: [...owned(IN_SAVINGS), { type: "upi_handle", handle: "priya.s@oksbi" }] }));
    expect(rh.get("h").transferKind).toBe("own_account");

    const pix = debit({ id: "pix", minor: 100_000, currency: "BRL", t: at(9, 3, 12), raw: "PIX ENVIADO MARIA SOUZA" });
    const rp = run([pix], ctx({ selfNames: ["Maria Souza"] }));
    expect(rp.get("pix").transactionType.value).toBe("transfer");
    expect(rp.get("pix").transferKind).toBe("own_account");
    expect(rp.get("pix").transactionType.confidence).toBeLessThan(0.85);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Credit-card bill payments                                         */
/* ------------------------------------------------------------------ */

describe("credit-card bill payments", () => {
  const purchase = debit({ id: "buy", minor: 152_345, currency: "USD", t: at(8, 20, 18), raw: "BEST BUY 00012345", key: "best_buy", mcc: "5732", rail: "card", instrument: US_CARD, type: inference("purchase", 0.95) });
  const bill = debit({ id: "bill", minor: 152_345, currency: "USD", t: at(9, 10, 6), raw: "ACH D- CHASE CREDIT CRD AUTOPAY", instrument: US_CHECKING });
  const cardSide = credit({ id: "cardpay", minor: 152_345, currency: "USD", t: at(9, 12, 6), raw: "AUTOMATIC PAYMENT - THANK YOU", instrument: US_CARD });
  const context = ctx({ ownedInstruments: owned(US_CHECKING, US_CARD) });

  it("links the bank debit to the payment credit on the owned card", () => {
    const r = run([purchase, bill, cardSide], context);
    expect(r.get("bill").transactionType.value).toBe("credit_card_payment");
    expect(r.get("bill").transactionType.confidence).toBeGreaterThan(0.9);
    expect(targets(r.get("bill"), "card_payment_for")).toEqual(["cardpay"]);
    expect(r.get("cardpay").transactionType.value).toBe("credit_card_payment");
    expect(targets(r.get("cardpay"), "transfer_counterpart")).toEqual(["bill"]);
    // The card purchase keeps the classifier's reading and gets no patch.
    expect(r.patches.has("buy")).toBe(false);
  });

  it("counts the card purchase once and the bill payment never", () => {
    const r = run([purchase, bill, cardSide], context);
    expect(spendingEffect(r.get("bill")).bucket).toBe("debt_payment");
    expect(spendingEffect(r.get("cardpay")).sign).toBe(0);
    const total = summarizeSpending(r.applied, { from: at(8, 1), to: at(10, 1), currency: "USD" }).total.minor;
    expect(total).toBe(spendingEffect(r.get("buy")).weightedMinor);
    expect(total).toBeLessThanOrEqual(152_345);
  });

  it("recognizes card-bill payments from the debit alone in several markets", () => {
    const cases: Array<[string, string, number]> = [
      ["CC PAYMENT 4XXX4321 THANK YOU", "INR", 1_820_000],
      ["BBPS/AXIS CREDIT CARD/XX4321", "INR", 1_820_000],
      ["AMEX EPAYMENT ACH PMT", "USD", 240_055],
      ["CAPITAL ONE MOBILE PMT", "USD", 50_000],
      ["PAGTO FATURA CARTAO NUBANK", "BRL", 320_000],
      ["Kreditkartenabrechnung 09/2026", "EUR", 84_512],
      ["Payment to card ending in 4321", "GBP", 61_000],
    ];
    for (const [raw, currency, minor] of cases) {
      const r = run([debit({ id: raw, minor, currency, t: at(9, 15), raw })]);
      expect(r.get(raw).transactionType.value, raw).toBe("credit_card_payment");
      expect(spendingEffect(r.get(raw)).bucket, raw).toBe("debt_payment");
    }
  });

  it("keeps a bill-pay app reading uncertain (such apps also pay rent)", () => {
    const r = run([debit({ id: "x", minor: 2_500_000, currency: "INR", t: at(9, 15), raw: "UPI/DR/627712345611/CRED Club/axisb" })]);
    const x = r.get("x");
    expect(x.transactionType.value).toBe("credit_card_payment");
    expect(x.transactionType.confidence).toBeLessThan(0.8);
    expect(alt(x, "purchase")).toBeGreaterThan(0.1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Wallet loads                                                      */
/* ------------------------------------------------------------------ */

describe("wallet loads", () => {
  it("reads add-money descriptors as wallet loads, surer when wallet spends are observable", () => {
    const load = debit({ id: "load", minor: 200_000, currency: "INR", t: at(9, 5), raw: "Add Money to Paytm Wallet" });
    const alone = run([load]).get("load");
    expect(alone.transactionType.value).toBe("transfer");
    expect(alone.transferKind).toBe("wallet_load");
    expect(spendingEffect(alone).bucket).toBe("transfer");

    const walletSpend = debit({ id: "spend", minor: 25_000, currency: "INR", t: at(9, 6), raw: "CHAAYOS", mcc: "5814", rail: "wallet", instrument: IN_WALLET });
    const seen = run([load, walletSpend]).get("load");
    expect(seen.transactionType.confidence).toBeGreaterThan(alone.transactionType.confidence);
  });

  it("pairs a bank debit with the credit on an owned wallet", () => {
    const d = debit({ id: "d", minor: 300_000, currency: "INR", t: at(9, 5, 9), raw: "ADD MONEY TO WALLET", instrument: IN_SAVINGS });
    const c = credit({ id: "c", minor: 300_000, currency: "INR", t: at(9, 5, 9, 1), raw: "Money added from bank account", instrument: IN_WALLET });
    const r = run([d, c], ctx({ ownedInstruments: owned(IN_SAVINGS, IN_WALLET) }));
    for (const id of ["d", "c"]) {
      expect(r.get(id).transactionType.value).toBe("transfer");
      expect(r.get(id).transferKind).toBe("wallet_load");
    }
    expect(targets(r.get("d"), "transfer_counterpart")).toEqual(["c"]);
  });

  it("reads a transfer to the user's own mobile-money wallet as a wallet load", () => {
    const mpesa: OwnedInstrument = { type: "wallet", issuer: "M-PESA", handle: "254712345678" };
    const kcb: InstrumentObservation = { type: "bank_account", issuer: "KCB", last4: "7777" };
    const d = debit({ id: "d", minor: 1_000_000, currency: "KES", t: at(9, 5), raw: "Bank to M-PESA transfer", handle: "254712345678", instrument: kcb });
    const r = run([d], ctx({ ownedInstruments: [...owned(kcb), mpesa] }));
    expect(r.get("d").transactionType.value).toBe("transfer");
    expect(r.get("d").transferKind).toBe("wallet_load");
  });

  it("reads a wallet cash-out to the bank as money moving between own accounts", () => {
    const r = run([credit({ id: "c", minor: 25_000, currency: "USD", t: at(9, 5), raw: "VENMO CASHOUT" })]);
    expect(r.get("c").transactionType.value).toBe("transfer");
    expect(r.get("c").transferKind).toBe("own_account");
  });

  it("does not mistake an airtime top-up for a wallet load", () => {
    const r = run([debit({ id: "a", minor: 50_000, currency: "KES", t: at(9, 5), raw: "SAFARICOM AIRTIME TOP UP" })]);
    expect(r.get("a").transferKind).not.toBe("wallet_load");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Investment, loan, income, cash, fees, taxes                       */
/* ------------------------------------------------------------------ */

describe("descriptor-driven types across markets", () => {
  const cases: Array<[string, "debit" | "credit", string, TransactionType, string?]> = [
    ["NACH DR ICICI PRUDENTIAL MF SIP", "debit", "INR", "investment"],
    ["ACH D- INDIAN CLEARING CORP-ZERODHA", "debit", "INR", "investment"],
    ["VANGUARD BUY INVESTMENT", "debit", "USD", "investment"],
    ["Trade Republic Sparplan", "debit", "EUR", "investment"],
    ["APLICACAO CDB", "debit", "BRL", "investment"],
    ["NORTHWIND CAPITAL MARKETS", "debit", "USD", "investment", "6211"],
    ["NACH DR HDFC BANK HOME LOAN EMI", "debit", "INR", "loan_payment"],
    ["NAVIENT STUDENT LOAN PMT", "debit", "USD", "loan_payment"],
    ["Darlehen Tilgung Oktober", "debit", "EUR", "loan_payment"],
    ["OD Loan Repayment to 232323 - M-PESA Overdraw", "debit", "KES", "loan_payment"],
    ["FINANCIAMENTO IMOBILIARIO PARCELA 012/360", "debit", "BRL", "loan_payment"],
    ["NEFT-HDFC0001234-ACME PVT LTD SALARY", "credit", "INR", "income"],
    ["DIRECT DEP ACME CORP PAYROLL", "credit", "USD", "income"],
    ["Gehalt Oktober ACME GmbH", "credit", "EUR", "income"],
    ["PIX RECEBIDO ACME LTDA SALARIO", "credit", "BRL", "income"],
    ["Salary Payment from ACME KENYA LTD", "credit", "KES", "income"],
    ["ATM WDL 04OCT26 MG ROAD", "debit", "INR", "cash_withdrawal"],
    ["NWD-512345XXXXXX1234-ATM BANDRA", "debit", "INR", "cash_withdrawal"],
    ["ATM WITHDRAWAL 1234 MAIN ST", "debit", "USD", "cash_withdrawal"],
    ["SAQUE BANCO24HORAS", "debit", "BRL", "cash_withdrawal"],
    ["Customer Withdrawal At Agent Till 123456", "debit", "KES", "cash_withdrawal"],
    ["CITY CENTRE KIOSK", "debit", "GBP", "cash_withdrawal", "6011"],
    ["GST ON SMS CHARGES", "debit", "INR", "fee"],
    ["MONTHLY SERVICE FEE", "debit", "USD", "fee"],
    ["Kontoführungsentgelt", "debit", "EUR", "fee"],
    ["TARIFA PACOTE SERVICOS", "debit", "BRL", "fee"],
    ["Pay Bill Charge", "debit", "KES", "fee"],
    ["ADVANCE TAX CHALLAN 280 CBDT", "debit", "INR", "tax"],
    ["IRS USATAXPYMT", "debit", "USD", "tax"],
    ["HMRC SELF ASSESSMENT", "debit", "GBP", "tax"],
    ["DARF RECEITA FEDERAL", "debit", "BRL", "tax"],
    ["SEPA-Lastschrift Finanzamt München", "debit", "EUR", "tax"],
    ["KRA PAYBILL 572572 ITAX", "debit", "KES", "tax"],
  ];

  for (const [raw, direction, currency, expected, mcc] of cases) {
    it(`${direction} "${raw}" (${currency}) -> ${expected}`, () => {
      const c = leg(direction, { id: "x", minor: 1_234_500, currency, t: at(9, 15), raw, ...(mcc ? { mcc } : {}) });
      const { patches, get } = run([c]);
      const inf = patches.get("x")?.transactionType;
      expect(inf?.value).toBe(expected);
      expect(inf?.basis).toContain("reconciliation");
      expect(inf?.userSet).toBe(false);
      expect(inf?.alternatives.length ?? 0).toBeGreaterThan(0);
      expect(spendingEffect(get("x")).bucket).toBe(
        ({ investment: "investment", loan_payment: "debt_payment", income: "income", cash_withdrawal: "cash", fee: "spending", tax: "spending" } as Record<string, string>)[expected],
      );
    });
  }

  it("does not read school fees as a bank fee", () => {
    const r = run([debit({ id: "s", minor: 4_500_000, currency: "INR", t: at(9, 15), raw: "SCHOOL FEES DPS RK PURAM" })]);
    expect(r.get("s").transactionType.value).not.toBe("fee");
  });
});

/* ------------------------------------------------------------------ */
/* 5. Refunds                                                           */
/* ------------------------------------------------------------------ */

describe("refunds", () => {
  it("links a full refund to its purchase and marks the purchase refunded", () => {
    const p = debit({ id: "p", minor: 124_900, currency: "INR", t: at(9, 1, 5), raw: "AMZN PAY INDIA", key: "amazon", type: inference("purchase", 0.9) });
    const r1 = credit({ id: "r", minor: 124_900, currency: "INR", t: at(9, 10, 5), raw: "AMAZON REFUND 402-1234567", key: "amazon" });
    const r = run([p, r1]);
    expect(r.get("r").transactionType.value).toBe("refund");
    expect(targets(r.get("r"), "refund_of")).toEqual(["p"]);
    expect(targets(r.get("p"), "refunded_by")).toEqual(["r"]);
    expect(r.get("p").status).toBe("refunded");
    // The original's own type is not rewritten.
    expect(r.patches.get("p")?.transactionType).toBeUndefined();
  });

  it("follows a chain of partial refunds and marks refunded only once they cover the purchase", () => {
    const p = debit({ id: "p", minor: 12_000, currency: "USD", t: at(8, 1, 17), raw: "ZARA USA 1234", key: "zara" });
    const r1 = credit({ id: "r1", minor: 4_000, currency: "USD", t: at(8, 5, 17), raw: "ZARA.COM RETURN", key: "zara" });
    const r2 = credit({ id: "r2", minor: 8_000, currency: "USD", t: at(8, 12, 17), raw: "ZARA.COM RETURN", key: "zara" });

    const partial = run([p, r1]);
    expect(targets(partial.get("r1"), "refund_of")).toEqual(["p"]);
    expect(partial.get("p").status).toBe("confirmed");
    expect(partial.patches.get("p")?.status).toBeUndefined();

    const full = run([p, r1, r2]);
    expect(targets(full.get("r2"), "refund_of")).toEqual(["p"]);
    expect(targets(full.get("p"), "refunded_by").sort()).toEqual(["r1", "r2"]);
    expect(full.get("p").status).toBe("refunded");
  });

  it("matches one refund to one original: the most recent identical purchase", () => {
    const o1 = debit({ id: "o1", minor: 19_990, currency: "BRL", t: at(9, 1, 14), raw: "MERCADOLIVRE*LOJA", key: "mercadolivre" });
    const o2 = debit({ id: "o2", minor: 19_990, currency: "BRL", t: at(9, 15, 14), raw: "MERCADOLIVRE*LOJA", key: "mercadolivre" });
    const rf = credit({ id: "rf", minor: 19_990, currency: "BRL", t: at(9, 20, 14), raw: "ESTORNO MERCADOLIVRE", key: "mercadolivre" });
    const one = run([o1, o2, rf]);
    expect(targets(one.get("rf"), "refund_of")).toEqual(["o2"]);
    expect(targets(one.get("o1"), "refunded_by")).toEqual([]);
    expect(one.get("o1").status).toBe("confirmed");

    const rf2 = credit({ id: "rf2", minor: 19_990, currency: "BRL", t: at(9, 22, 14), raw: "ESTORNO MERCADOLIVRE", key: "mercadolivre" });
    const two = run([o1, o2, rf, rf2]);
    expect(targets(two.get("rf"), "refund_of")).toEqual(["o2"]);
    expect(targets(two.get("rf2"), "refund_of")).toEqual(["o1"]);
    expect(two.get("o1").status).toBe("refunded");
    expect(two.get("o2").status).toBe("refunded");
  });

  it("prefers an exact-amount original over a closer one the refund would only partly cover", () => {
    const o1 = debit({ id: "o1", minor: 50_000, currency: "BRL", t: at(8, 1), key: "magalu", raw: "MAGALU" });
    const o2 = debit({ id: "o2", minor: 80_000, currency: "BRL", t: at(8, 20), key: "magalu", raw: "MAGALU" });
    const rf = credit({ id: "rf", minor: 50_000, currency: "BRL", t: at(8, 25), key: "magalu", raw: "MAGALU DEVOLUCAO" });
    expect(targets(run([o1, o2, rf]).get("rf"), "refund_of")).toEqual(["o1"]);
  });

  it("matches a foreign-currency refund on the original currency, not the drifting converted amount", () => {
    const p = debit({ id: "p", minor: 5_450, currency: "USD", original: money(5_000, "EUR"), t: at(7, 1), key: "booking", raw: "BOOKING.COM HOTEL" });
    const rf = credit({ id: "rf", minor: 5_390, currency: "USD", original: money(5_000, "EUR"), t: at(7, 20), key: "booking", raw: "BOOKING.COM REFUND" });
    const r = run([p, rf]);
    expect(targets(r.get("rf"), "refund_of")).toEqual(["p"]);
    expect(r.get("p").status).toBe("refunded");
  });

  it("does not link refunds that are too late, too large, from another merchant or from a person", () => {
    const p = debit({ id: "p", minor: 124_900, currency: "INR", t: at(5, 1), key: "amazon", raw: "AMAZON" });
    const late = credit({ id: "late", minor: 124_900, currency: "INR", t: at(5, 1) + 121 * DAY, key: "amazon", raw: "AMAZON REFUND" });
    const large = credit({ id: "large", minor: 130_000, currency: "INR", t: at(5, 10), key: "amazon", raw: "AMAZON REFUND" });
    const other = credit({ id: "other", minor: 124_900, currency: "INR", t: at(5, 11), key: "flipkart", raw: "FLIPKART REFUND" });
    const r = run([p, late, large, other]);
    for (const id of ["late", "large", "other"]) expect(targets(r.get(id), "refund_of"), id).toEqual([]);

    const paid = debit({ id: "paid", minor: 50_000, currency: "INR", t: at(9, 1), raw: "UPI/DR/627712340000/RAHUL VERMA/okaxis", handle: "rahul.verma@okaxis" });
    const back = credit({ id: "back", minor: 50_000, currency: "INR", t: at(9, 3), raw: "UPI/CR/627712340001/RAHUL VERMA/okaxis", handle: "rahul.verma@okaxis" });
    expect(targets(run([paid, back]).get("back"), "refund_of")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Reimbursements and shared expenses                                */
/* ------------------------------------------------------------------ */

describe("reimbursements and shared expenses", () => {
  const dinner = debit({ id: "dinner", minor: 12_000, currency: "USD", t: at(9, 5, 2), raw: "OLIVE GARDEN 0123", key: "olive_garden", mcc: "5812", rail: "card", type: inference("purchase", 0.9) });

  it("links 1/3 shares paid back by two friends and marks the dinner shared (~0.6, no more)", () => {
    const john = credit({ id: "john", minor: 4_000, currency: "USD", t: at(9, 6, 2), raw: "ZELLE FROM JOHN SMITH" });
    const jane = credit({ id: "jane", minor: 4_000, currency: "USD", t: at(9, 8, 2), raw: "ZELLE FROM JANE DOE" });
    const r = run([dinner, john, jane]);
    for (const id of ["john", "jane"]) {
      expect(r.get(id).transactionType.value).toBe("reimbursement");
      expect(targets(r.get(id), "reimbursement_of")).toEqual(["dinner"]);
    }
    const own = r.get("dinner").attributes.ownership;
    expect(own.value).toBe("shared");
    expect(own.confidence).toBeGreaterThanOrEqual(0.5);
    expect(own.confidence).toBeLessThanOrEqual(0.6);
    expect(own.userSet).toBe(false);
    // Paybacks offset the dinner in spending totals.
    const total = summarizeSpending(r.applied, { from: at(9, 1), to: at(10, 1), currency: "USD" }).total.minor;
    expect(total).toBeLessThan(spendingEffect(r.get("dinner")).weightedMinor);
  });

  it("links a Pix half share", () => {
    const meal = debit({ id: "meal", minor: 30_000, currency: "BRL", t: at(9, 5, 23), raw: "OUTBACK STEAKHOUSE", mcc: "5812", rail: "card" });
    const maria = credit({ id: "maria", minor: 15_000, currency: "BRL", t: at(9, 6, 12), raw: "PIX RECEBIDO MARIA SOUZA" });
    const r = run([meal, maria]);
    expect(targets(r.get("maria"), "reimbursement_of")).toEqual(["meal"]);
    expect(r.get("meal").attributes.ownership.value).toBe("shared");
  });

  it("links uneven paybacks from several people that sum to part of the bill, at lower confidence", () => {
    const bill = debit({ id: "bill", minor: 300_000, currency: "INR", t: at(9, 10, 15), raw: "BARBEQUE NATION", mcc: "5812", rail: "card" });
    const rahul = credit({ id: "rahul", minor: 120_000, currency: "INR", t: at(9, 11, 5), raw: "UPI/CR/627712340001/RAHUL VERMA/okaxis" });
    const anita = credit({ id: "anita", minor: 80_000, currency: "INR", t: at(9, 12, 5), raw: "UPI/CR/627712340002/ANITA DESAI/oksbi" });
    const r = run([bill, rahul, anita]);
    for (const id of ["rahul", "anita"]) {
      const l = r.get(id).links.find((x) => x.kind === "reimbursement_of");
      expect(l?.target).toBe("bill");
      expect(l?.probability ?? 1).toBeLessThan(0.6);
    }
    expect(r.get("bill").attributes.ownership.confidence).toBeLessThan(0.6);
  });

  it("ignores paybacks after 30 days, from the user, or that are salary", () => {
    const late = credit({ id: "late", minor: 6_000, currency: "USD", t: at(9, 5, 2) + 31 * DAY, raw: "ZELLE FROM JOHN SMITH" });
    const self = credit({ id: "self", minor: 6_000, currency: "USD", t: at(9, 6), raw: "ZELLE FROM PRIYA SHARMA" });
    const pay = credit({ id: "pay", minor: 6_000, currency: "USD", t: at(9, 7), raw: "DIRECT DEP ACME PAYROLL" });
    const r = run([dinner, late, self, pay], ctx({ selfNames: ["Priya Sharma"] }));
    for (const id of ["late", "self", "pay"]) expect(targets(r.get(id), "reimbursement_of"), id).toEqual([]);
    expect(r.patches.get("dinner")?.attributes).toBeUndefined();
  });

  it("never claims more than ~0.6 ownership certainty, however clean the split", () => {
    const tab = debit({ id: "tab", minor: 10_000, currency: "EUR", t: at(9, 5, 20), raw: "BIERGARTEN MUENCHEN", mcc: "5813", rail: "card" });
    const friends = ["Anna Weber", "Jonas Klein", "Lena Wolf", "Paul Braun"].map((n, i) =>
      credit({ id: `f${i}`, minor: 2_500, currency: "EUR", t: at(9, 6, 9 + i), raw: `SEPA-Gutschrift von ${n}` }),
    );
    const r = run([tab, ...friends]);
    for (const f of friends) expect(targets(r.get(f.id), "reimbursement_of")).toEqual(["tab"]);
    expect(r.get("tab").attributes.ownership.confidence).toBeLessThanOrEqual(0.6);
  });

  it("links an employer paying back a whole expense and marks it reimbursable (~0.6, no more)", () => {
    const hotel = debit({ id: "hotel", minor: 35_000, currency: "EUR", t: at(9, 2), raw: "HOTEL ADLON BERLIN", mcc: "7011", rail: "card" });
    const claim = credit({ id: "claim", minor: 35_000, currency: "EUR", t: at(9, 20), raw: "ACME GMBH SPESENERSTATTUNG" });
    const r = run([hotel, claim]);
    expect(targets(r.get("claim"), "reimbursement_of")).toEqual(["hotel"]);
    expect(r.get("claim").transactionType.value).toBe("reimbursement");
    expect(targets(r.get("claim"), "refund_of")).toEqual([]);
    const own = r.get("hotel").attributes.ownership;
    expect(own.value).toBe("reimbursable");
    expect(own.confidence).toBeLessThanOrEqual(0.6);
  });

  it("reads an outgoing split payment to a friend as a shared expense (spending)", () => {
    const r = run([debit({ id: "s", minor: 3_000, currency: "USD", t: at(9, 6), raw: "VENMO to John Smith dinner split" })]);
    expect(r.get("s").transactionType.value).toBe("shared_expense");
    expect(alt(r.get("s"), "transfer")).toBeGreaterThan(0.3);
    expect(spendingEffect(r.get("s")).bucket).toBe("spending");
  });
});

/* ------------------------------------------------------------------ */
/* 7. P2P vs P2M, rent                                                  */
/* ------------------------------------------------------------------ */

describe("person-to-person vs merchant", () => {
  it("keeps a payment to a person uncertain: transfer with a purchase alternative", () => {
    const r = run([debit({ id: "p", minor: 25_000, currency: "BRL", t: at(9, 6), raw: "PIX ENVIADO JOAO" })]);
    const x = r.get("p");
    expect(x.transactionType.value).toBe("transfer");
    expect(x.transferKind).toBe("p2p_other");
    expect(x.transactionType.confidence).toBeGreaterThanOrEqual(0.5);
    expect(x.transactionType.confidence).toBeLessThanOrEqual(0.75);
    expect(alt(x, "purchase")).toBeGreaterThanOrEqual(0.25);
    expect(spendingEffect(x).bucket).toBe("outflow_other");
  });

  it("reads payments to a merchant handle with a merchant code as purchases", () => {
    const r = run([
      debit({ id: "m", minor: 64_000, currency: "INR", t: at(9, 6), raw: "UPI/DR/627712345678/FRESH MART/paytmqr2810050501011abc", handle: "paytmqr2810050501011abc@paytm", mcc: "5411", rail: "account_to_account_instant" }),
    ]);
    expect(r.get("m").transactionType.value).toBe("purchase");
    expect(r.get("m").transactionType.confidence).toBeGreaterThan(0.9);
    expect(r.get("m").transactionType.basis).toContain("source_hint");
  });

  it("guesses family for a person sharing the user's surname", () => {
    const r = run([debit({ id: "f", minor: 2_000_000, currency: "INR", t: at(9, 6), raw: "UPI/DR/627712345679/SUNITA SHARMA/oksbi" })], ctx({ selfNames: ["Priya Sharma"] }));
    expect(r.get("f").transactionType.value).toBe("transfer");
    expect(r.get("f").transferKind).toBe("family");
  });

  it("tells M-Pesa Send Money (person) from Buy Goods (merchant), and reads a Faster Payment to a person as a transfer", () => {
    const r = run([
      debit({ id: "send", minor: 300_000, currency: "KES", t: at(9, 6), raw: "M-PESA Send Money to JANE WANJIKU 0712345678" }),
      debit({ id: "buy", minor: 85_000, currency: "KES", t: at(9, 6, 8), raw: "Buy Goods JAVA HOUSE Till 123456" }),
      debit({ id: "fps", minor: 4_000, currency: "GBP", t: at(9, 6, 9), raw: "Faster Payment to J SMITH" }),
    ]);
    expect(r.get("send").transactionType.value).toBe("transfer");
    expect(r.get("buy").transactionType.value).toBe("purchase");
    expect(r.get("fps").transactionType.value).toBe("transfer");
    expect(alt(r.get("fps"), "purchase")).toBeGreaterThan(0.25);
  });
});

describe("rent", () => {
  it("reads a UPI payment to a person noted 'rent' as a rent purchase, transfer kept as the alternative", () => {
    const r = run([debit({ id: "rent", minor: 5_000_000, currency: "INR", t: at(9, 2), raw: "UPI/DR/627712345678/RAHUL SHARMA/okaxis/rent" })]);
    const x = r.get("rent");
    expect(x.transactionType.value).toBe("purchase");
    expect(x.transactionType.confidence).toBeGreaterThanOrEqual(0.55);
    expect(x.transactionType.confidence).toBeLessThan(0.85);
    expect(alt(x, "transfer")).toBeGreaterThan(0.2);
    expect(x.category.value).toBe("housing.rent");
    expect(spendingEffect(x).bucket).toBe("spending");
  });

  it("detects rent from the pattern alone: same person, monthly, large, early in the month", () => {
    const rahul = { name: "Rahul Sharma", handle: "rahul.sharma@okaxis" } as const;
    const rents = [at(7, 2), at(8, 3), at(9, 2)].map((t, i) =>
      debit({ id: `rent${i}`, minor: 2_500_000, currency: "INR", t, raw: `UPI/DR/62771234560${i}/RAHUL SHARMA/okaxis`, ...rahul }),
    );
    const small = [20_000, 35_000, 50_000, 80_000, 120_000, 150_000].map((minor, i) =>
      debit({ id: `s${i}`, minor, currency: "INR", t: at(8, 10 + i), raw: "SWIGGY", mcc: "5814", rail: "card" }),
    );
    const r = run([...rents, ...small]);
    for (const x of rents) {
      const y = r.get(x.id);
      expect(y.transactionType.value).toBe("purchase");
      expect(y.transactionType.confidence).toBeLessThanOrEqual(0.75);
      expect(y.transactionType.basis).toContain("recurrence");
      expect(y.category.value).toBe("housing.rent");
      expect(alt(y, "transfer")).toBeGreaterThan(0.2);
    }
  });

  it("reads rent wording in SEPA remittance text and a rental merchant code", () => {
    const r = run([
      debit({ id: "de", minor: 95_000, currency: "EUR", t: at(10, 1), raw: "SEPA-Überweisung an Max Mustermann Miete Oktober" }),
      debit({ id: "us", minor: 245_000, currency: "USD", t: at(10, 1, 14), raw: "AVALON COMMUNITIES ONLINE PMT", mcc: "6513" }),
    ]);
    expect(r.get("de").category.value).toBe("housing.rent");
    expect(r.get("us").category.value).toBe("housing.rent");
    expect(r.get("us").transactionType.confidence).toBeGreaterThan(r.get("de").transactionType.confidence);
  });

  it("does not call a car rental rent", () => {
    const r = run([debit({ id: "car", minor: 32_000, currency: "USD", t: at(9, 3), raw: "HERTZ CAR RENTAL", mcc: "7512", rail: "card" })]);
    expect(r.patches.get("car")?.category).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 8. The brief's ₹50,000 question                                      */
/* ------------------------------------------------------------------ */

describe("the brief's ₹50,000 question", () => {
  const AMOUNT = 5_000_000;
  const HDFC_CARD: InstrumentObservation = { type: "card", issuer: "HDFC Bank", last4: "9999", cardKind: "debit" };
  const rows: Array<[TransactionCandidate, TransactionType, string, TransferKind?]> = [
    [debit({ id: "rent", minor: AMOUNT, currency: "INR", t: at(9, 1), raw: "UPI/DR/627712345678/RAHUL SHARMA/okaxis/rent", instrument: IN_SAVINGS }), "purchase", "spending"],
    [debit({ id: "sip", minor: AMOUNT, currency: "INR", t: at(9, 5), raw: "NACH DR ICICI PRUDENTIAL MF SIP", instrument: IN_SAVINGS }), "investment", "investment"],
    [debit({ id: "own", minor: AMOUNT, currency: "INR", t: at(9, 10, 10), raw: "IMPS/P2A/627799999999/PRIYA SHARMA", instrument: IN_SAVINGS }), "transfer", "transfer", "own_account"],
    [debit({ id: "card", minor: AMOUNT, currency: "INR", t: at(9, 15), raw: "CC PAYMENT 4XXX4321 THANK YOU", instrument: IN_SAVINGS }), "credit_card_payment", "debt_payment"],
    [debit({ id: "family", minor: AMOUNT, currency: "INR", t: at(9, 20), raw: "UPI/DR/627712345679/SUNITA SHARMA/oksbi", instrument: IN_SAVINGS }), "transfer", "outflow_other", "family"],
    [debit({ id: "emi", minor: AMOUNT, currency: "INR", t: at(9, 25), raw: "NACH DR BAJAJ FINANCE LTD EMI", instrument: IN_SAVINGS }), "loan_payment", "debt_payment"],
    [debit({ id: "tv", minor: AMOUNT, currency: "INR", t: at(9, 29), raw: "CROMA ELECTRONICS MUMBAI", mcc: "5732", rail: "card", instrument: HDFC_CARD }), "purchase", "spending"],
  ];
  const ownIn = credit({ id: "own-in", minor: AMOUNT, currency: "INR", t: at(9, 10, 10, 2), raw: "IMPS/627799999999/FROM PRIYA SHARMA", instrument: IN_SALARY });
  const context = ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY, HDFC_CARD), selfNames: ["Priya Sharma"] });

  it("tells rent, investment, own transfer, card bill, family, loan and purchase apart", () => {
    const r = run([...rows.map(([c]) => c), ownIn], context);
    for (const [c, type, bucket, kind] of rows) {
      const x = r.get(c.id);
      expect(x.transactionType.value, c.id).toBe(type);
      expect(spendingEffect(x).bucket, c.id).toBe(bucket);
      if (kind) expect(x.transferKind, c.id).toBe(kind);
      expect(x.transactionType.basis, c.id).toContain("reconciliation");
    }
    expect(r.get("rent").category.value).toBe("housing.rent");
    expect(targets(r.get("own"), "transfer_counterpart")).toEqual(["own-in"]);
    // Only the uncertain readings keep a material alternative the question policy can ask about.
    expect(alt(r.get("rent"), "transfer")).toBeGreaterThan(0.2);
    expect(alt(r.get("family"), "purchase")).toBeGreaterThan(0.2);
  });

  it("counts only rent and the purchase towards spending", () => {
    const r = run([...rows.map(([c]) => c), ownIn], context);
    const total = summarizeSpending(r.applied, { from: at(9, 1) - DAY, to: at(10, 1), currency: "INR" }).total.minor;
    expect(total).toBe(spendingEffect(r.get("rent")).weightedMinor + spendingEffect(r.get("tv")).weightedMinor);
    expect(total).toBeLessThan(2 * AMOUNT);
    // A naive "every debit is spending" reading would have said ₹3,50,000.
    expect(total).toBeLessThan(7 * AMOUNT * 0.3);
  });
});

/* ------------------------------------------------------------------ */
/* 9. User model and user labels                                        */
/* ------------------------------------------------------------------ */

describe("user model and user labels", () => {
  const toRahul = debit({ id: "x", minor: 800_000, currency: "INR", t: at(9, 6), raw: "UPI/DR/627712345678/RAHUL SHARMA/okaxis" });

  it("lets the user's answers for a counterparty outweigh heuristics in proportion to evidence", () => {
    const learned = (evidence: number) =>
      run([toRahul], ctx({ userModel: model({ types: { "rahul sharma": { entries: [{ value: "purchase", probability: 1 }], evidence } } }) })).get("x");
    const none = run([toRahul]).get("x");
    expect(none.transactionType.value).toBe("transfer");
    const one = learned(1);
    const six = learned(6);
    expect(pOf(one, "purchase")).toBeGreaterThan(pOf(none, "purchase"));
    expect(six.transactionType.value).toBe("purchase");
    expect(pOf(six, "purchase")).toBeGreaterThan(pOf(one, "purchase"));
    expect(six.transactionType.basis).toContain("user_history");
  });

  it("takes the transfer kind the user taught for a counterparty", () => {
    const send = debit({ id: "s", minor: 300_000, currency: "KES", t: at(9, 6), raw: "M-PESA Send Money to JANE WANJIKU 0712345678" });
    const r = run([send], ctx({ userModel: model({ kinds: { "jane wanjiku": { entries: [{ value: "family", probability: 0.9 }, { value: "p2p_other", probability: 0.1 }], evidence: 2 } } }) }));
    expect(r.get("s").transferKind).toBe("family");
  });

  it("never changes a user-set type, and never pairs it as something the user said it is not", () => {
    const d = debit({ id: "d", minor: 5_000_000, currency: "INR", t: at(9, 10, 10), raw: "IMPS/P2A/627712345678/PRIYA SHARMA", instrument: IN_SAVINGS, type: userInference("purchase") });
    const c = credit({ id: "c", minor: 5_000_000, currency: "INR", t: at(9, 10, 10, 5), raw: "IMPS/627712345678/FROM PRIYA SHARMA", instrument: IN_SALARY });
    const r = run([d, c], ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY), selfNames: ["Priya Sharma"] }));
    expect(r.patches.get("d")?.transactionType).toBeUndefined();
    expect(r.get("d").transactionType).toEqual(userInference("purchase"));
    expect(r.get("d").links).toEqual([]);
    expect(targets(r.get("c"), "transfer_counterpart")).toEqual([]);
  });

  it("still links a user-labelled refund without touching its type", () => {
    const p = debit({ id: "p", minor: 249_900, currency: "INR", t: at(9, 1), key: "amazon", raw: "AMAZON" });
    const rf = credit({ id: "rf", minor: 249_900, currency: "INR", t: at(9, 9), key: "amazon", raw: "AMAZON", type: userInference("refund") });
    const r = run([p, rf]);
    expect(r.patches.get("rf")?.transactionType).toBeUndefined();
    expect(targets(r.get("rf"), "refund_of")).toEqual(["p"]);
  });

  it("never overwrites a user-set category or ownership, while still linking", () => {
    const rent = debit({ id: "rent", minor: 5_000_000, currency: "INR", t: at(9, 2), raw: "UPI/DR/627712345678/RAHUL SHARMA/okaxis/rent" });
    const labelled = { ...rent, category: userInference("family.support") };
    const r1 = run([labelled]);
    expect(r1.patches.get("rent")?.category).toBeUndefined();
    expect(r1.get("rent").category).toEqual(userInference("family.support"));

    const dinner = debit({ id: "dinner", minor: 12_000, currency: "USD", t: at(9, 5), raw: "OLIVE GARDEN", mcc: "5812", rail: "card" });
    const mine = { ...dinner, attributes: { ...dinner.attributes, ownership: userInference("personal" as const) } };
    const john = credit({ id: "john", minor: 6_000, currency: "USD", t: at(9, 6), raw: "ZELLE FROM JOHN SMITH" });
    const r2 = run([mine, john]);
    expect(targets(r2.get("john"), "reimbursement_of")).toEqual(["dinner"]);
    expect(r2.patches.get("dinner")?.attributes).toBeUndefined();
    expect(r2.get("dinner").attributes.ownership.userSet).toBe(true);
  });

  it("defers to a more confident classifier reading of a single leg, filling in only the transfer kind", () => {
    const z = debit({ id: "z", minor: 15_000, currency: "USD", t: at(9, 6), raw: "ZELLE TO JOHN SMITH", type: inference("transfer", 0.92) });
    const r = run([z]);
    expect(r.patches.get("z")?.transactionType).toBeUndefined();
    expect(r.get("z").transferKind).toBe("p2p_other");
  });
});

/* ------------------------------------------------------------------ */
/* 10. Hygiene: no-ops, determinism, idempotency, stale output          */
/* ------------------------------------------------------------------ */

describe("hygiene", () => {
  it("leaves unrelated candidates alone", () => {
    const r = run([
      debit({ id: "coffee", minor: 45_000, currency: "INR", t: at(9, 6, 3), raw: "STARBUCKS 0451", key: "starbucks", mcc: "5814", rail: "card", type: inference("purchase", 0.97) }),
      debit({ id: "netflix", minor: 2_299, currency: "USD", t: at(9, 6, 4), raw: "NETFLIX.COM", key: "netflix", mcc: "4899", rail: "card", type: inference("subscription", 0.8) }),
      debit({ id: "bare", minor: 85_000, currency: "INR", t: at(9, 6, 5), raw: "STARBUCKS" }),
      credit({ id: "biz", minor: 85_000, currency: "EUR", t: at(9, 6, 6), raw: "ACME GMBH" }),
      debit({ id: "intent", minor: 5_000_000, currency: "INR", t: at(9, 6, 7), raw: "IMPS/P2A/627712345678/PRIYA SHARMA", status: "intent" }),
      debit({ id: "void", minor: 5_000_000, currency: "INR", t: at(9, 6, 8), raw: "ADD MONEY TO WALLET", status: "cancelled" }),
    ], ctx({ selfNames: ["Priya Sharma"] }));
    expect([...r.patches.keys()]).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const scenario = scenarioCandidates();
    const a = reconciler.reconcile(scenario, scenarioContext());
    const shuffled = [...scenario].reverse();
    shuffled.push(...shuffled.splice(0, 3));
    const b = reconciler.reconcile(shuffled, scenarioContext());
    const serialize = (m: ReadonlyMap<string, CandidatePatch>) => JSON.stringify([...m].sort(([x], [y]) => x.localeCompare(y)));
    expect(serialize(b.patches)).toEqual(serialize(a.patches));
    expect(a.patches.size).toBeGreaterThan(5);
  });

  it("is idempotent: re-running over its own output changes nothing", () => {
    const first = run(scenarioCandidates(), scenarioContext());
    const second = reconciler.reconcile(first.applied, { ...scenarioContext(), now: NOW + HOUR });
    expect([...second.patches.keys()]).toEqual([]);
  });

  it("withdraws its own stale reading when the matched leg disappears", () => {
    const stale = debit({
      id: "stale",
      minor: 70_000,
      currency: "INR",
      t: at(9, 6),
      raw: "PAYMENT",
      type: { value: "transfer", confidence: 0.95, alternatives: [{ value: "purchase", probability: 0.05 }], basis: ["reconciliation"], userSet: false },
      transferKind: "own_account",
      links: [{ kind: "transfer_counterpart", target: "gone", probability: 0.95, createdAt: at(9, 6) }],
    });
    const r = run([stale]);
    expect(r.patches.get("stale")?.links).toEqual([]);
    expect(r.get("stale").transactionType.value).toBe("unknown");
    expect(r.get("stale").transactionType.confidence).toBe(0);
  });

  it("stamps new links with the context time and keeps the original time on re-runs", () => {
    const p = debit({ id: "p", minor: 124_900, currency: "INR", t: at(9, 1), key: "amazon", raw: "AMAZON" });
    const rf = credit({ id: "rf", minor: 124_900, currency: "INR", t: at(9, 9), key: "amazon", raw: "AMAZON REFUND" });
    const first = run([p, rf]);
    expect(first.get("rf").links[0]?.createdAt).toBe(NOW);
    const p2 = { ...first.get("p"), status: "confirmed" as const };
    const again = reconciler.reconcile([p2, first.get("rf")], ctx({ now: NOW + DAY }));
    expect(again.patches.get("p")?.links).toBeUndefined();
    expect(again.patches.get("p")?.status).toBe("refunded");
  });
});

function scenarioContext(): ReconciliationContext {
  return ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY, US_CHECKING, US_CARD, IN_WALLET), selfNames: ["Priya Sharma"] });
}

function scenarioCandidates(): TransactionCandidate[] {
  return [
    debit({ id: "own", minor: 5_000_000, currency: "INR", t: at(9, 10, 10), raw: "IMPS/P2A/627799999999/PRIYA SHARMA", instrument: IN_SAVINGS }),
    credit({ id: "own-in", minor: 5_000_000, currency: "INR", t: at(9, 10, 10, 2), raw: "IMPS/627799999999/FROM PRIYA SHARMA", instrument: IN_SALARY }),
    debit({ id: "rent", minor: 5_000_000, currency: "INR", t: at(9, 1), raw: "UPI/DR/627712345678/RAHUL SHARMA/okaxis/rent", instrument: IN_SAVINGS }),
    debit({ id: "buy", minor: 152_345, currency: "USD", t: at(8, 20, 18), raw: "BEST BUY 00012345", key: "best_buy", mcc: "5732", rail: "card", instrument: US_CARD }),
    debit({ id: "bill", minor: 152_345, currency: "USD", t: at(9, 10, 6), raw: "ACH D- CHASE CREDIT CRD AUTOPAY", instrument: US_CHECKING }),
    credit({ id: "cardpay", minor: 152_345, currency: "USD", t: at(9, 12, 6), raw: "AUTOMATIC PAYMENT - THANK YOU", instrument: US_CARD }),
    debit({ id: "amz", minor: 124_900, currency: "INR", t: at(9, 1, 5), raw: "AMZN PAY INDIA", key: "amazon" }),
    credit({ id: "amz-rf", minor: 124_900, currency: "INR", t: at(9, 10, 5), raw: "AMAZON REFUND", key: "amazon" }),
    debit({ id: "dinner", minor: 12_000, currency: "USD", t: at(9, 5, 2), raw: "OLIVE GARDEN 0123", key: "olive_garden", mcc: "5812", rail: "card" }),
    credit({ id: "john", minor: 4_000, currency: "USD", t: at(9, 6, 2), raw: "ZELLE FROM JOHN SMITH" }),
    credit({ id: "jane", minor: 4_000, currency: "USD", t: at(9, 8, 2), raw: "ZELLE FROM JANE DOE" }),
    debit({ id: "pix", minor: 25_000, currency: "BRL", t: at(9, 6), raw: "PIX ENVIADO JOAO" }),
    debit({ id: "load", minor: 200_000, currency: "INR", t: at(9, 5, 9), raw: "ADD MONEY TO WALLET", instrument: IN_SAVINGS }),
    credit({ id: "load-in", minor: 200_000, currency: "INR", t: at(9, 5, 9, 1), raw: "Money added from bank account", instrument: IN_WALLET }),
    debit({ id: "sip", minor: 500_000, currency: "INR", t: at(9, 5), raw: "NACH DR ICICI PRUDENTIAL MF SIP", instrument: IN_SAVINGS }),
    debit({ id: "atm", minor: 1_000_000, currency: "KES", t: at(9, 7), raw: "Customer Withdrawal At Agent Till 123456" }),
    // Reversals of non-spending movements, a business payee and a 1-minor-unit refund.
    debit({ id: "emi", minor: 2_500_000, currency: "BRL", t: at(9, 5), raw: "FINANCIAMENTO IMOBILIARIO PARCELA 012/360" }),
    credit({ id: "emi-back", minor: 2_500_000, currency: "BRL", t: at(9, 6), raw: "ESTORNO FINANCIAMENTO IMOBILIARIO PARCELA 012/360" }),
    debit({ id: "upi-fail", minor: 300_000, currency: "INR", t: at(9, 8, 9), raw: "UPI/DR/627700000001/RAHUL VERMA/okaxis", references: [{ type: "rail_reference", value: "627700000001", namespace: "upi" }] }),
    credit({ id: "upi-rev", minor: 300_000, currency: "INR", t: at(9, 8, 11), raw: "REV-UPI/627700000001/RAHUL VERMA", references: [{ type: "rail_reference", value: "627700000001", namespace: "upi" }] }),
    debit({ id: "plumber", minor: 49_000, currency: "USD", t: at(9, 3), raw: "ZELLE TO JOES PLUMBING LLC" }),
    debit({ id: "tee", minor: 4_599, currency: "USD", t: at(9, 1), raw: "UNIQLO", key: "uniqlo" }),
    credit({ id: "tee-rf", minor: 4_598, currency: "USD", t: at(9, 3), raw: "UNIQLO REFUND", key: "uniqlo" }),
  ];
}

/* ------------------------------------------------------------------ */
/* 11. Explanations                                                     */
/* ------------------------------------------------------------------ */

describe("explainReconciliationLink", () => {
  it("explains every reconciliation link calmly, at the link's confidence", () => {
    for (const kind of RECONCILIATION_LINK_KINDS) {
      const sure = explainReconciliationLink({ kind, target: "x", probability: 0.95, createdAt: NOW });
      const unsure = explainReconciliationLink({ kind, target: "x", probability: 0.65, createdAt: NOW });
      expect(sure, kind).toBeTruthy();
      expect(unsure, kind).toMatch(/^Looks like|^A later credit looks like/);
      expect(toneIssues(sure!), kind).toEqual([]);
      expect(toneIssues(unsure!), kind).toEqual([]);
    }
    expect(explainReconciliationLink({ kind: "possible_duplicate", target: "x", probability: 0.9, createdAt: NOW })).toBeNull();
  });

  it("explains links produced by a real reconciliation", () => {
    const r = run(scenarioCandidates(), scenarioContext());
    const texts = r.applied.flatMap((c) => c.links.map(explainReconciliationLink)).filter((t): t is string => !!t);
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(toneIssues(t)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 12. Adversarial review: regressions                                  */
/* ------------------------------------------------------------------ */

describe("masked numbers in narrations", () => {
  const visa: InstrumentObservation = { type: "card", issuer: "Chase", last4: "9876", cardKind: "credit" };
  const checking: InstrumentObservation = { type: "bank_account", issuer: "Wells Fargo", last4: "1234" };

  it("never reads a store or cheque number as a payment into an owned account", () => {
    const r = run(
      [
        debit({ id: "target", minor: 4_599, currency: "USD", t: at(9, 3), raw: "TARGET #1234 MINNEAPOLIS MN", mcc: "5310", rail: "card", instrument: visa }),
        debit({ id: "sbux", minor: 675, currency: "USD", t: at(9, 4), raw: "STARBUCKS STORE #1234 SEATTLE", instrument: visa }),
        debit({ id: "cheque", minor: 120_000, currency: "USD", t: at(9, 5), raw: "CHECK #1234", instrument: { type: "bank_account", issuer: "Ally", last4: "2222" } }),
      ],
      ctx({ ownedInstruments: owned(visa, checking, { type: "bank_account", issuer: "Ally", last4: "2222" }) }),
    );
    for (const id of ["target", "sbux", "cheque"]) {
      expect(r.get(id).transferKind, id).not.toBe("own_account");
      expect(r.get(id).transactionType.value, id).not.toBe("transfer");
    }
    expect(spendingEffect(r.get("target")).bucket).toBe("spending");
  });

  it("reads the paying card's own masked number in a POS narration as the payer, not a card-bill payee", () => {
    const card: InstrumentObservation = { type: "card", issuer: "HDFC Bank", last4: "1234", cardKind: "credit" };
    const r = run(
      [
        debit({ id: "pos", minor: 120_000, currency: "INR", t: at(9, 3), raw: "POS 512345XXXXXX1234 AMAZON" }),
        debit({ id: "atm", minor: 500_000, currency: "INR", t: at(9, 4), raw: "NWD-512345XXXXXX1234-ATM BANDRA" }),
      ],
      ctx({ ownedInstruments: owned(card) }),
    );
    expect(r.get("pos").transactionType.value).not.toBe("credit_card_payment");
    expect(r.get("atm").transactionType.value).toBe("cash_withdrawal");
  });

  it("still reads a masked owned account after transfer wording as the destination", () => {
    const r = run(
      [debit({ id: "sav", minor: 50_000, currency: "USD", t: at(9, 3), raw: "Online Transfer to SAV ...5678 transaction#: 1234567", instrument: US_CHECKING })],
      ctx({ ownedInstruments: [...owned(US_CHECKING), { type: "bank_account", issuer: "Chase", last4: "5678" }] }),
    );
    expect(r.get("sav").transactionType.value).toBe("transfer");
    expect(r.get("sav").transferKind).toBe("own_account");
  });
});

describe("card-bill wording", () => {
  it("does not read a debit-card purchase narration as a credit-card bill payment", () => {
    const cases: Array<[string, string]> = [
      ["POS PAYMENT DEBIT CARD XX1234 AMAZON", "INR"],
      ["CONTACTLESS PAYMENT VISA DEBIT CARD TESCO STORES", "GBP"],
      ["RECURRING PAYMENT DEBIT CARD NETFLIX", "USD"],
      ["PAGAMENTO CARTAO DE DEBITO PADARIA", "BRL"],
    ];
    for (const [raw, currency] of cases) {
      const x = run([debit({ id: raw, minor: 120_000, currency, t: at(9, 3), raw })]).get(raw);
      expect(x.transactionType.value, raw).not.toBe("credit_card_payment");
      expect(spendingEffect(x).bucket, raw).not.toBe("debt_payment");
    }
  });

  it("never reads a charge on the credit card itself as paying that card's bill", () => {
    const card: InstrumentObservation = { type: "card", issuer: "Axis Bank", last4: "2222", cardKind: "credit" };
    const x = run([debit({ id: "n", minor: 64_900, currency: "INR", t: at(9, 3), raw: "SI AUTOPAY NETFLIX CARD", instrument: card })], ctx({ ownedInstruments: owned(card) })).get("n");
    expect(x.transactionType.value).not.toBe("credit_card_payment");
    expect(spendingEffect(x).bucket).not.toBe("debt_payment");
  });

  it("needs card-bill wording on one side before pairing a bank debit with a credit on the card", () => {
    const savings: InstrumentObservation = { type: "bank_account", issuer: "Axis Bank", last4: "1111" };
    const card: InstrumentObservation = { type: "card", issuer: "Axis Bank", last4: "2222", cardKind: "credit" };
    const d = debit({ id: "d", minor: 45_000, currency: "INR", t: at(9, 3), raw: "BILLDESK ELECTRICITY", instrument: savings });
    const c = credit({ id: "c", minor: 45_000, currency: "INR", t: at(9, 4), raw: "ZOMATO", instrument: card });
    const r = run([d, c], ctx({ ownedInstruments: owned(savings, card) }));
    expect(r.get("d").links).toEqual([]);
    expect(r.get("d").transactionType.value).not.toBe("credit_card_payment");
    expect(r.get("c").transactionType.value).not.toBe("credit_card_payment");

    // A plain "PAYMENT" credit on the card is enough for the card side.
    const plain = credit({ id: "c2", minor: 45_000, currency: "INR", t: at(9, 4), raw: "ONLINE PAYMENT", instrument: card });
    const r2 = run([debit({ id: "d2", minor: 45_000, currency: "INR", t: at(9, 3), raw: "NEFT DR XX2222", instrument: savings }), plain], ctx({ ownedInstruments: owned(savings, card) }));
    expect(targets(r2.get("d2"), "card_payment_for")).toEqual(["c2"]);
  });
});

describe("refund merchant matching", () => {
  it("does not match a refund to a different merchant that merely shares a prefix", () => {
    const sbux = debit({ id: "sbux", minor: 45_000, currency: "INR", t: at(9, 1), raw: "STARBUCKS 0451", mcc: "5814", rail: "card" });
    const star = credit({ id: "star", minor: 45_000, currency: "INR", t: at(9, 10), raw: "STAR HEALTH REFUND" });
    const r = run([sbux, star]);
    expect(targets(r.get("star"), "refund_of")).toEqual([]);
    expect(r.get("sbux").status).toBe("confirmed");
  });

  it("trusts different normalized merchant keys over loose descriptor overlap", () => {
    const sbux = debit({ id: "sbux", minor: 45_000, currency: "INR", t: at(9, 1), raw: "STARBUCKS 0451", key: "starbucks" });
    const star = credit({ id: "star", minor: 45_000, currency: "INR", t: at(9, 10), raw: "STAR HEALTH REFUND", key: "star_health" });
    expect(targets(run([sbux, star]).get("star"), "refund_of")).toEqual([]);
  });

  it("still matches truncated descriptors of the same merchant", () => {
    const p = debit({ id: "p", minor: 19_990, currency: "BRL", t: at(9, 1), raw: "MERCADOLIVR*LOJA ABC" });
    const rf = credit({ id: "rf", minor: 19_990, currency: "BRL", t: at(9, 9), raw: "ESTORNO MERCADOLIVRE" });
    expect(targets(run([p, rf]).get("rf"), "refund_of")).toEqual(["p"]);
  });

  it("marks the original refunded when the refund is within one minor unit, whatever the amount", () => {
    // 4599 and 1387 are amounts where (a-1)/a < 1 - 1/a in floating point.
    for (const [minor, currency] of [[4_599, "USD"], [1_387, "JPY"], [7, "KWD"], [124_900, "INR"]] as const) {
      const p = debit({ id: "p", minor, currency, t: at(9, 1), raw: "UNIQLO", key: "uniqlo" });
      const rf = credit({ id: "rf", minor: minor - 1, currency, t: at(9, 3), raw: "UNIQLO REFUND", key: "uniqlo" });
      expect(run([p, rf]).get("p").status, `${minor} ${currency}`).toBe("refunded");
    }
    // Two minor units short is a partial refund.
    const p = debit({ id: "p", minor: 4_599, currency: "USD", t: at(9, 1), raw: "UNIQLO", key: "uniqlo" });
    const rf = credit({ id: "rf", minor: 4_597, currency: "USD", t: at(9, 3), raw: "UNIQLO REFUND", key: "uniqlo" });
    expect(run([p, rf]).get("p").status).toBe("confirmed");
  });

  it("ignores zero-amount credits and legs", () => {
    const p = debit({ id: "p", minor: 5_000, currency: "USD", t: at(9, 3), raw: "AMAZON", key: "amazon" });
    const z = credit({ id: "z", minor: 0, currency: "USD", t: at(9, 4), raw: "AMAZON", key: "amazon" });
    expect(targets(run([p, z]).get("z"), "refund_of")).toEqual([]);

    const d0 = debit({ id: "d0", minor: 0, currency: "USD", t: at(9, 3), raw: "TRANSFER TO SAVINGS", instrument: US_CHECKING });
    const c0 = credit({ id: "c0", minor: 0, currency: "USD", t: at(9, 3), raw: "TRANSFER FROM CHECKING", instrument: US_SAVINGS });
    expect(run([d0, c0], ctx({ ownedInstruments: owned(US_CHECKING, US_SAVINGS) })).get("d0").links).toEqual([]);
  });
});

describe("reversals of movements that were never spending", () => {
  const neutral = (c: TransactionCandidate) => spendingEffect(c).sign;

  it("keeps a returned card-bill autopay out of spending, linked to the payment it reverses", () => {
    const bill = debit({ id: "bill", minor: 152_345, currency: "USD", t: at(9, 5), raw: "ACH D- CREDIT CRD AUTOPAY", instrument: US_CHECKING });
    const back = credit({ id: "back", minor: 152_345, currency: "USD", t: at(9, 7), raw: "ACH RETURN CREDIT CRD AUTOPAY", instrument: US_CHECKING });
    const r = run([bill, back]);
    expect(targets(r.get("back"), "refund_of")).toEqual(["bill"]);
    expect(r.get("back").transactionType.value).toBe("credit_card_payment");
    expect(neutral(r.get("back"))).toBe(0);
    expect(summarizeSpending(r.applied, { from: at(9, 1), to: at(10, 1), currency: "USD" }).total.minor).toBe(0);
  });

  it("keeps a reversed loan instalment and a failed person-to-person payment neutral", () => {
    const emi = debit({ id: "emi", minor: 2_500_000, currency: "BRL", t: at(9, 5), raw: "FINANCIAMENTO IMOBILIARIO PARCELA 012/360", instrument: { type: "bank_account", issuer: "Itau", last4: "3030" } });
    const estorno = credit({ id: "estorno", minor: 2_500_000, currency: "BRL", t: at(9, 6), raw: "ESTORNO FINANCIAMENTO IMOBILIARIO PARCELA 012/360", instrument: { type: "bank_account", issuer: "Itau", last4: "3030" } });
    const r1 = run([emi, estorno]);
    expect(r1.get("estorno").transactionType.value).toBe("loan_payment");
    expect(neutral(r1.get("estorno"))).toBe(0);

    const rrn: Reference = { type: "rail_reference", value: "627712345678", namespace: "upi" };
    const p2p = debit({ id: "p2p", minor: 500_000, currency: "INR", t: at(9, 5), raw: "UPI/DR/627712345678/RAHUL VERMA/okaxis", instrument: IN_SAVINGS, references: [rrn] });
    const rev = credit({ id: "rev", minor: 500_000, currency: "INR", t: at(9, 5, 6), raw: "REV-UPI/627712345678/RAHUL VERMA", instrument: IN_SAVINGS, references: [rrn] });
    const r2 = run([p2p, rev]);
    expect(targets(r2.get("rev"), "refund_of")).toEqual(["p2p"]);
    expect(r2.get("rev").transactionType.value).toBe("transfer");
    // The purchase reading of the payment survives as the refund reading of its reversal.
    expect(alt(r2.get("rev"), "refund")).toBeGreaterThan(0.2);
    expect(neutral(r2.get("rev"))).toBe(0);
  });

  it("reads a returned mandate for a SIP or card bill as a reversal even when the debit is not in view", () => {
    const sip = credit({ id: "sip", minor: 500_000, currency: "INR", t: at(9, 6), raw: "NACH RTN ICICI PRUDENTIAL MF SIP INSUFFICIENT BAL" });
    const cc = credit({ id: "cc", minor: 1_820_000, currency: "INR", t: at(9, 6), raw: "CC PAYMENT REVERSAL XX4321" });
    const r = run([sip, cc]);
    expect(r.get("sip").transactionType.value).not.toBe("refund");
    expect(neutral(r.get("sip"))).toBe(0);
    expect(r.get("cc").transactionType.value).not.toBe("refund");
    expect(neutral(r.get("cc"))).toBe(0);
  });

  it("still treats the reversal of a purchase as a refund", () => {
    const rrn: Reference = { type: "rail_reference", value: "627712345690", namespace: "upi" };
    const buy = debit({ id: "buy", minor: 45_000, currency: "INR", t: at(9, 9, 13), raw: "UPI/DR/627712345690/SWIGGY/swiggy.rzp@icici", key: "swiggy", handle: "swiggy.rzp@icici", mcc: "5814", references: [rrn] });
    const back = credit({ id: "back", minor: 45_000, currency: "INR", t: at(9, 9, 15), raw: "REV-UPI/627712345690/SWIGGY", key: "swiggy", references: [rrn] });
    const r = run([buy, back]);
    expect(r.get("back").transactionType.value).toBe("refund");
    expect(r.get("buy").status).toBe("refunded");
  });
});

describe("rent pattern and business payees", () => {
  const small = [20_000, 35_000, 50_000, 80_000, 12_000, 15_000].map((minor, i) =>
    debit({ id: `s${i}`, minor, currency: "INR", t: at(8, 10 + i), raw: "SWIGGY", mcc: "5814", rail: "card" }),
  );

  it("does not call a large monthly payment to a business 'rent' from the pattern alone", () => {
    const lic = [at(7, 5), at(8, 5), at(9, 5)].map((t, i) => debit({ id: `lic${i}`, minor: 500_000, currency: "INR", t, raw: "LIC PREMIUM", key: "lic" }));
    const r = run([...lic, ...small]);
    for (const x of lic) expect(r.get(x.id).category.value, x.id).not.toBe("housing.rent");
  });

  it("reads payments to named companies as purchases, not person-to-person transfers", () => {
    const cases: Array<[string, string]> = [
      ["NEFT DR-ICIC0000123-ACME PVT LTD-INV4411", "INR"],
      ["SEPA-Überweisung an Stadtwerke München GmbH", "EUR"],
      ["ZELLE TO JOES PLUMBING LLC", "USD"],
      ["PIX ENVIADO PADARIA SAO JOAO LTDA", "BRL"],
      ["M-PESA Send Money to ACME KENYA LIMITED", "KES"],
    ];
    for (const [raw, currency] of cases) {
      const x = run([debit({ id: raw, minor: 490_000, currency, t: at(9, 3), raw })]).get(raw);
      expect(x.transactionType.value, raw).not.toBe("transfer");
      expect(spendingEffect(x).bucket, raw).not.toBe("outflow_other");
    }
  });

  it("does not treat a company's credit as a friend paying back a share", () => {
    const dinner = debit({ id: "dinner", minor: 12_000, currency: "INR", t: at(9, 5), raw: "BARBEQUE NATION", mcc: "5812", rail: "card" });
    const client = credit({ id: "client", minor: 6_000, currency: "INR", t: at(9, 6), raw: "NEFT CR-HDFC0000123-ACME PVT LTD-INV 77" });
    expect(targets(run([dinner, client]).get("client"), "reimbursement_of")).toEqual([]);
  });

  it("withdraws its own rent category when the rent reading no longer holds", () => {
    const rent = debit({ id: "rent", minor: 5_000_000, currency: "INR", t: at(9, 2), raw: "UPI/DR/627712345678/RAHUL SHARMA/okaxis/rent" });
    const first = run([rent]).get("rent");
    expect(first.category.value).toBe("housing.rent");
    const taught = model({
      types: { "rahul sharma": { entries: [{ value: "transfer", probability: 1 }], evidence: 20 } },
      kinds: { "rahul sharma": { entries: [{ value: "family", probability: 1 }], evidence: 20 } },
    });
    const again = run([first], ctx({ userModel: taught })).get("rent");
    expect(again.transactionType.value).toBe("transfer");
    expect(again.transferKind).toBe("family");
    expect(again.category.value).not.toBe("housing.rent");
    expect(again.category.basis).not.toContain("reconciliation");
  });
});

describe("reimbursement joiners", () => {
  const dinner = debit({ id: "dinner", minor: 12_000, currency: "USD", t: at(9, 5, 2), raw: "OLIVE GARDEN 0123", mcc: "5812", rail: "card" });
  const john = credit({ id: "john", minor: 4_000, currency: "USD", t: at(9, 6, 2), raw: "ZELLE FROM JOHN SMITH" });

  it("lets another friend's uneven payback join a split settled the same week", () => {
    const jane = credit({ id: "jane", minor: 5_000, currency: "USD", t: at(9, 8, 2), raw: "ZELLE FROM JANE DOE" });
    expect(targets(run([dinner, john, jane]).get("jane"), "reimbursement_of")).toEqual(["dinner"]);
  });

  it("does not turn an unrelated credit weeks later into a payback for the split", () => {
    const gift = credit({ id: "gift", minor: 5_000, currency: "USD", t: at(10, 3, 2), raw: "ZELLE FROM MARY JONES" });
    const r = run([dinner, john, gift]);
    expect(targets(r.get("gift"), "reimbursement_of")).toEqual([]);
    expect(r.get("gift").transactionType.value).not.toBe("reimbursement");
  });
});

describe("scale", () => {
  it("reconciles months of history without quadratic text work", () => {
    const merchants = ["SWIGGY", "ZOMATO", "AMAZON", "FLIPKART", "UBER", "BIGBASKET", "STARBUCKS", "CROMA", "MYNTRA", "NETFLIX"];
    const people = ["RAHUL VERMA", "ANITA DESAI", "JOHN SMITH", "MARIA SOUZA"];
    const many: TransactionCandidate[] = [];
    for (let i = 0; i < 8_000; i++) {
      const isCredit = i % 5 === 0;
      const isPerson = i % 3 === 0;
      const name = isPerson ? people[i % people.length]! : merchants[i % merchants.length]!;
      const t = at(1, 1) + ((i * 7_919) % 270) * DAY + ((i * 104_729) % DAY);
      many.push(
        leg(isCredit ? "credit" : "debit", {
          id: `h${i}`,
          minor: ((i * 37) % 500) * 100 + 100,
          currency: "INR",
          t,
          raw: isPerson ? `UPI/${isCredit ? "CR" : "DR"}/6277${i}/${name}/okaxis` : `${name}${isCredit ? " REFUND" : ""}`,
          ...(isPerson ? {} : { key: name.toLowerCase() }),
          instrument: i % 2 ? IN_SAVINGS : IN_SALARY,
        }),
      );
    }
    const started = performance.now();
    const out = reconciler.reconcile(many, ctx({ ownedInstruments: owned(IN_SAVINGS, IN_SALARY), selfNames: ["Priya Sharma"] }));
    const elapsed = performance.now() - started;
    expect(out.patches.size).toBeGreaterThan(1_000);
    expect(elapsed).toBeLessThan(2_500);
  });
});

it("ignores candidates whose direction is unknown", () => {
  const c = makeCandidate({ id: "u", direction: "unknown", minor: 5_000_000, currency: "INR", timestampEstimated: at(9, 6), merchant: { raw: "ATM WDL", normalized: null, displayName: null, confidence: 0, channel: "unknown" } });
  expect(reconciler.reconcile([c], ctx()).patches.size).toBe(0);
});
