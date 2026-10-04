import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext, Observation, RawSignal } from "@brake/core";
import { makeObservation, makeSource } from "@brake/core/testing";
import { assessPair } from "../../core/src/fusion/match";
import { defaultMerchantMatcher } from "../../core/src/fusion/merchant";
import type { FusionConfig } from "../../core/src/fusion/types";
import { createAccountAggregatorAdapter, parseAaNarration } from "../src/account-aggregator";
import type { AaDepositTransaction, AaFiData } from "../src/account-aggregator";

/*
 * Payload shape: ReBIT/Sahamati deposit FI schema (schemas/deposit/deposit.xsd
 * in github.com/Sahamati/account-aggregator-standards) as decrypted JSON.
 * Narrations follow formats Indian banks print on statements (SBI, ICICI,
 * HDFC, Axis); see docs/research/10 §A5 — they are bank-specific.
 */

const FETCHED_AT = Date.UTC(2026, 9, 4, 6, 0, 0); // 11:30 IST: a periodic AA fetch, hours after the payments
const IN: AdapterContext = { clock: fixedClock(FETCHED_AT), country: "IN", locale: "en-IN", timeZone: "Asia/Kolkata", defaultCurrency: "INR" };
const LINKED = "f4a9c2e1-3b7d-4c55-9a0e-1d2b3c4d5e6f";
const adapter = createAccountAggregatorAdapter();

const FUSION: FusionConfig = {
  linkThreshold: 0.9,
  possibleThreshold: 0.5,
  ambiguityMargin: 0.15,
  priorLogOdds: Math.log(0.1 / 0.9),
  intentHorizonMs: 24 * 3_600_000,
  pendingToPostedTolerance: 0.3,
  approximateAmountTolerance: 0.15,
};

const TRANSACTIONS: AaDepositTransaction[] = [
  {
    txnId: "S81234567",
    type: "DEBIT",
    mode: "UPI",
    amount: "1249.00",
    currentBalance: "48751.00",
    transactionTimestamp: "2026-10-04T10:41:00+05:30",
    valueDate: "2026-10-04",
    narration: "UPI/627712345678/swiggy@icici/Payment from Ph",
    reference: "627712345678",
  },
  {
    txnId: "S81234501",
    type: "CREDIT",
    mode: "FT",
    amount: "85000.00",
    currentBalance: "50000.00",
    transactionTimestamp: "2026-09-30T18:05:12+05:30",
    valueDate: "2026-09-30",
    narration: "NEFT/N273260123456/ACME PVT LTD/SALARY SEP",
    reference: "N273260123456",
  },
  {
    txnId: "S81234502",
    type: "DEBIT",
    mode: "ATM",
    amount: "5000",
    currentBalance: "45000.00",
    transactionTimestamp: "2026-10-01T20:12:44+05:30",
    valueDate: "2026-10-01",
    narration: "ATW-512345XXXXXX4321-S1ANBG12-BANGALORE",
    reference: "",
  },
  {
    txnId: "S81234503",
    type: "DEBIT",
    mode: "OTHERS",
    amount: "4210.00",
    currentBalance: "40790.00",
    transactionTimestamp: "2026-10-02T00:00:00+05:30",
    valueDate: "2026-10-02",
    narration: "ACH D- BAJAJ FINANCE LTD-P1234567 EMI",
    reference: "P1234567",
  },
  {
    txnId: "S81234504",
    type: "DEBIT",
    mode: "UPI",
    amount: "15000.00",
    currentBalance: "25790.00",
    transactionTimestamp: "2026-10-02T09:15:03+05:30",
    valueDate: "2026-10-02",
    narration: "UPI/P2A/627798765432/RAMESH K/SBIN/9876543210@ybl/rent",
    reference: "627798765432",
  },
  {
    txnId: "S81234505",
    type: "DEBIT",
    mode: "CARD",
    amount: "799.00",
    currentBalance: "24991.00",
    transactionTimestamp: "2026-10-03T21:47:10+05:30",
    valueDate: "2026-10-03",
    narration: "POS 512345XXXXXX4321 AMAZON PAY IN",
    reference: "",
  },
  {
    txnId: "S81234506",
    type: "CREDIT",
    mode: "OTHERS",
    amount: "600.00",
    currentBalance: "25591.00",
    transactionTimestamp: "2026-10-03T23:02:00+05:30",
    valueDate: "2026-10-03",
    narration: "IMPS/P2A/627755512345/PRIYA S/ICIC/XXXXXXX9876/dinner split",
    reference: "627755512345",
  },
  {
    txnId: "S81234507",
    type: "DEBIT",
    mode: "FT",
    amount: "20000.00",
    currentBalance: "5591.00",
    transactionTimestamp: "2026-10-03T23:30:00+05:30",
    valueDate: "2026-10-03",
    narration: "IB FUNDS TRANSFER DR-50100123456789-RAVI KUMAR",
    reference: "",
  },
];

const FI: AaFiData = {
  fipId: "HDFC-FIP",
  fipName: "HDFC Bank",
  Account: {
    linkedAccRef: LINKED,
    maskedAccNumber: "XXXXXXXX4321",
    type: "deposit",
    version: "2.0.0",
    Profile: {
      Holders: {
        type: "SINGLE",
        Holder: [
          {
            name: "Ananya Rao",
            dob: "1994-03-12",
            mobile: "9123456780",
            nominee: "NOT-REGISTERED",
            email: "ananya.rao@example.com",
            pan: "ABCDE1234F",
            ckycCompliance: "true",
            address: "12 MG Road Bengaluru 560001",
          },
        ],
      },
    },
    Summary: {
      currentBalance: "5591.00",
      currency: "INR",
      exchgeRate: "",
      balanceDateTime: "2026-10-04T09:30:00+05:30",
      type: "SAVINGS",
      branch: "MG Road",
      facility: "OD",
      ifscCode: "HDFC0000123",
      micrCode: "560240002",
      openingDate: "2019-06-01",
      currentODLimit: "25000",
      drawingLimit: "0",
      status: "ACTIVE",
    },
    Transactions: { startDate: "2026-09-01", endDate: "2026-10-04", Transaction: TRANSACTIONS },
  },
};

function parse(payload: AaFiData, ctx: AdapterContext = IN): Observation[] {
  const signal: RawSignal<AaFiData> = { adapterId: "account-aggregator", connectionId: "aa_consent_7f3", receivedAt: FETCHED_AT, payload };
  const result = adapter.parse(signal, ctx);
  if (result.status !== "observations") throw new Error(`expected observations, got ${result.status}`);
  return [...result.observations];
}

const byTxn = (obs: Observation[], id: string) =>
  obs.find((o) => o.references.some((r) => r.type === "provider_transaction_id" && r.value === id))!;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe("Account Aggregator adapter", () => {
  const obs = parse(FI);

  it("maps a UPI debit into a posted ledger entry with RRN and VPA", () => {
    const o = byTxn(obs, "S81234567");
    expect(o).toMatchObject({ kind: "money_movement", window: "post_spend", stage: "posted", direction: "debit", country: "IN" });
    expect(o.source).toEqual({
      adapterId: "account-aggregator",
      kind: "account_aggregator",
      connectionId: "aa_consent_7f3",
      provider: "HDFC Bank",
      label: "HDFC Bank statement via Account Aggregator",
    });
    expect(o.amount?.value).toEqual(money(124_900, "INR"));
    expect(o.receivedAt).toBe(FETCHED_AT);
    expect(o.occurredAt).toEqual({ value: Date.UTC(2026, 9, 4, 5, 11, 0), confidence: 0.9 });
    expect(o.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(o.references).toEqual([
      { type: "provider_transaction_id", value: "S81234567", namespace: `aa:${LINKED}` },
      { type: "rail_reference", value: "627712345678", namespace: "upi" },
    ]);
    expect(o.merchant).toEqual({ raw: "swiggy@icici", handle: "swiggy@icici", confidence: 0.75 });
    expect(o.counterparty).toEqual({ handle: "swiggy@icici" });
    expect(o.instrument).toEqual({ type: "bank_account", accountRef: LINKED, last4: "4321", issuer: "HDFC Bank" });
    expect(o.balance).toEqual({ current: money(4_875_100, "INR") });
    expect(o.evidence.summary).toBe("Your HDFC Bank statement (via Account Aggregator) shows ₹1,249 debited by UPI to swiggy@icici.");
    expect(o.evidence.excerpt).toBe("UPI/••••5678/swiggy@icici/Payment from Ph");
    expect(o.evidence.excerptExpiresAt).toBe(FETCHED_AT + 7 * 86_400_000);
  });

  it("joins the matching real-time bank alert through the shared UPI RRN", () => {
    const alert = makeObservation({
      source: makeSource({ adapterId: "sms", kind: "sms", connectionId: "sms_device", provider: "HDFC Bank", label: "HDFC Bank SMS" }),
      receivedAt: Date.UTC(2026, 9, 4, 5, 11, 20),
      occurredAt: { value: Date.UTC(2026, 9, 4, 5, 11, 0), confidence: 0.95 },
      minor: 124_900,
      currency: "INR",
      merchant: { raw: "SWIGGY", confidence: 0.8 },
      instrument: { type: "bank_account", last4: "4321" },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      references: [{ type: "rail_reference", value: "627712345678", namespace: "upi" }],
    });
    const assessment = assessPair(byTxn(obs, "S81234567"), alert, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.features.map((f) => f.name)).toEqual(expect.arrayContaining(["reference_match", "amount_exact", "instrument_match"]));
    expect(assessment.probability).toBeGreaterThan(0.99);
  });

  it("parses NEFT salary credits, ATM withdrawals, NACH EMIs and card spends", () => {
    const salary = byTxn(obs, "S81234501");
    expect(salary).toMatchObject({ direction: "credit", rail: { family: "account_to_account_batch", scheme: "neft" } });
    expect(salary.counterparty).toEqual({ name: "ACME PVT LTD" });
    expect(salary.references).toContainEqual({ type: "rail_reference", value: "N273260123456", namespace: "neft" });
    expect(salary.typeHints).toContainEqual({ type: "income", confidence: 0.75, reason: "aa_narration:salary" });

    const atm = byTxn(obs, "S81234502");
    expect(atm.rail).toEqual({ family: "cash", scheme: "atm" });
    expect(atm.merchant).toBeUndefined();
    expect(atm.typeHints?.[0]).toMatchObject({ type: "cash_withdrawal", confidence: 0.9 });
    expect(atm.evidence.summary).toContain("as cash");

    const emi = byTxn(obs, "S81234503");
    expect(emi.rail).toEqual({ family: "direct_debit", scheme: "nach" });
    expect(emi.merchant?.raw).toBe("BAJAJ FINANCE LTD");
    expect(emi.typeHints).toContainEqual({ type: "loan_payment", confidence: 0.6, reason: "aa_narration:loan" });
    // A padded midnight timestamp is a date, not 00:00 IST.
    expect(emi.occurredAt?.confidence).toBe(0.4);

    const pos = byTxn(obs, "S81234505");
    expect(pos.rail).toEqual({ family: "card" });
    expect(pos.merchant?.raw).toBe("AMAZON PAY IN");
  });

  it("separates person-to-person transfers and masks phone-number VPAs", () => {
    const rent = byTxn(obs, "S81234504");
    expect(rent.counterparty).toEqual({ name: "RAMESH K", handle: "••••3210@ybl", isMerchant: 0.1 });
    expect(rent.references).toContainEqual({ type: "rail_reference", value: "627798765432", namespace: "upi" });

    const split = byTxn(obs, "S81234506");
    expect(split).toMatchObject({ direction: "credit", rail: { family: "account_to_account_instant", scheme: "imps" } });
    expect(split.counterparty).toEqual({ name: "PRIYA S", isMerchant: 0.1 });
    expect(split.references).toContainEqual({ type: "rail_reference", value: "627755512345", namespace: "imps" });

    const own = byTxn(obs, "S81234507");
    expect(own.counterparty?.name).toBe("RAVI KUMAR");
    expect(own.rail).toEqual({ family: "account_to_account_instant", scheme: "ft" });
  });

  it("emits a balance snapshot from the account Summary", () => {
    const balance = obs.find((o) => o.kind === "balance_snapshot")!;
    expect(balance).toMatchObject({ window: "pre_spend", stage: "unknown", confidence: 0.95 });
    expect(balance.balance).toEqual({ current: money(559_100, "INR"), limit: money(2_500_000, "INR") });
    expect(balance.occurredAt).toEqual({ value: Date.UTC(2026, 9, 4, 4, 0, 0), confidence: 0.95 });
    expect(balance.instrument?.last4).toBe("4321");
  });

  it("never leaks holder profile data or full account/card numbers", () => {
    const all = strings(obs);
    for (const s of all) {
      expect(s).not.toMatch(/\d{13,19}/);
      for (const secret of ["Ananya", "ABCDE1234F", "ananya.rao", "9123456780", "9876543210", "50100123456789", "512345XXXXXX", "MG Road Bengaluru"]) {
        expect(s).not.toContain(secret);
      }
    }
  });

  it("is idempotent across repeated fetches and tolerates single-element XML-style arrays", () => {
    expect(parse(FI).map((o) => o.id)).toEqual(obs.map((o) => o.id));
    const single = parse({ ...FI, Account: { ...FI.Account, Transactions: { Transaction: TRANSACTIONS[0]! } } });
    expect(single.filter((o) => o.kind === "money_movement")).toHaveLength(1);
    expect(byTxn(single, "S81234567").id).toBe(byTxn(obs, "S81234567").id);
  });

  it("keys entries without a txnId by content and never invents a provider id", () => {
    const { txnId: _omit, ...noId } = TRANSACTIONS[0]!;
    const [o] = parse({ ...FI, Account: { ...FI.Account, Summary: undefined, Transactions: { Transaction: [noId] } } });
    expect(o!.references).toEqual([{ type: "rail_reference", value: "627712345678", namespace: "upi" }]);
    expect(o!.id).toMatch(/^obs_/);
  });

  it("parses xs:float amounts and defaults to IST when timestamps carry no offset", () => {
    const [o] = parse({
      ...FI,
      Account: {
        ...FI.Account,
        Summary: undefined,
        Transactions: { Transaction: [{ txnId: "F1", type: "DEBIT", mode: "UPI", amount: "1.2495E3", transactionTimestamp: "2026-10-04T10:41:00", narration: "UPI/DR/627700001111/SWIGGY/YESB/swiggy@ybl/Payment" }] },
      },
    }, { clock: fixedClock(FETCHED_AT) });
    expect(o!.amount?.value).toEqual(money(124_950, "INR"));
    expect(o!.occurredAt?.value).toBe(Date.UTC(2026, 9, 4, 5, 11, 0));
    expect(o!.merchant?.raw).toBe("SWIGGY");
  });

  it("rejects non-AA payloads and ignores other FI types", () => {
    const signal = (payload: unknown): RawSignal<AaFiData> => ({ adapterId: "account-aggregator", connectionId: "c", receivedAt: FETCHED_AT, payload: payload as AaFiData });
    expect(adapter.parse(signal({ foo: 1 }), IN).status).toBe("rejected");
    expect(adapter.parse(signal({ Account: { linkedAccRef: "x", type: "credit_card" } }), IN)).toEqual({ status: "ignored", reason: "unsupported_format" });
  });
});

describe("parseAaNarration (bank narration data pack)", () => {
  it.each([
    ["UPI/DR/627712345678/SWIGGY/YESB/swiggy@ybl/Payment", "SWIGGY", "swiggy@ybl", "627712345678", undefined],
    ["UPI/627712345678/Payment from Ph/swiggy@icici/ICICI Bank", undefined, "swiggy@icici", "627712345678", undefined],
    ["UPI-SWIGGY-SWIGGY8@YBL-YESB0YBLUPI-627712345678-PAYMENT FROM PHONE", "SWIGGY", "swiggy8@ybl", "627712345678", undefined],
    ["UPI/P2M/627712345678/SWIGGY/Payment from Ph/HDFC BANK", "SWIGGY", undefined, "627712345678", true],
  ])("%s", (narration, name, handle, rrn, toMerchant) => {
    const p = parseAaNarration(narration, "debit");
    expect(p.rail).toEqual({ family: "account_to_account_instant", scheme: "upi" });
    expect(p.name).toBe(name);
    expect(p.handle).toBe(handle);
    expect(p.railReference).toEqual({ value: rrn, namespace: "upi" });
    expect(p.toMerchant).toBe(toMerchant);
  });

  it("reads HDFC-style NEFT credits without mistaking the IFSC for the UTR", () => {
    const p = parseAaNarration("NEFT CR-HDFC0000001-ACME PVT LTD-SALARY SEP-N123456789012345", "credit");
    expect(p.rail?.scheme).toBe("neft");
    expect(p.name).toBe("ACME PVT LTD");
    expect(p.railReference).toEqual({ value: "N123456789012345", namespace: "neft" });
    expect(p.typeHints.map((h) => h.type)).toContain("income");
  });

  it("applies direction-specific keywords only in their direction", () => {
    expect(parseAaNarration("UPI/REV/627712345678/SWIGGY", "credit").typeHints.map((h) => h.type)).toContain("refund");
    expect(parseAaNarration("UPI/REV/627712345678/SWIGGY", "debit").typeHints.map((h) => h.type)).not.toContain("refund");
    expect(parseAaNarration("BIL/ONL/000987/CRED CLUB/CC PAYMENT", "debit").typeHints.map((h) => h.type)).toContain("credit_card_payment");
  });
});
