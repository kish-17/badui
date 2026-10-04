import { describe, expect, it } from "vitest";
import { fixedClock, money } from "@brake/core";
import type { AdapterContext, Observation, RawSignal } from "@brake/core";
import { assessPair } from "../../core/src/fusion/match";
import { defaultMerchantMatcher } from "../../core/src/fusion/merchant";
import type { FusionConfig } from "../../core/src/fusion/types";
import { createCardFeedAdapter } from "../src/card-feed";
import type { CardFeedEvent } from "../src/card-feed";

/*
 * Events follow Fidel API's Select Transactions object (Fidel docs source,
 * select/transactions.md: the "Coffee Brand London" example) — amounts in
 * major units, `datetime` in local time at the location, refunds negative on
 * both their auth and clearing events.
 */

const NOW = Date.UTC(2026, 9, 3, 7, 16, 0);
const GB: AdapterContext = { clock: fixedClock(NOW), country: "GB", locale: "en-GB", timeZone: "Europe/London" };
const adapter = createCardFeedAdapter();

const FUSION: FusionConfig = {
  linkThreshold: 0.9,
  possibleThreshold: 0.5,
  ambiguityMargin: 0.15,
  priorLogOdds: Math.log(0.1 / 0.9),
  intentHorizonMs: 24 * 3_600_000,
  pendingToPostedTolerance: 0.3,
  approximateAmountTolerance: 0.15,
};

const AUTH: CardFeedEvent = {
  event: "transaction.auth",
  id: "7fdfd5d8-9589-402f-8477-4a727ad138a2",
  accountId: "4ed4b72b-aa4c-43a1-8054-da6d1368e17a",
  amount: 4.6,
  approvalCode: "AA00BB",
  auth: true,
  authCode: "A73H890",
  cardPresent: true,
  cleared: false,
  created: "2026-10-03T07:15:31.644Z",
  currency: "GBP",
  datetime: "2026-10-03T08:15:30",
  descriptor: { merchantName: "COFFEE BRAND LONDON", storeName: "Coffee Brand" },
  programId: "6e38aa0c-b7ef-46bd-b1bd-c07c647d9cba",
  refundTransactionId: null,
  wallet: "apple_pay",
  brand: { id: "9d136f2e-df99-4a08-a0a5-3bc1534b7db8", name: "Coffee Brand" },
  card: { id: "bc538b71-31c5-4699-820a-6d4a08693314", firstNumbers: "401288", lastNumbers: "5001", scheme: "visa" },
  identifiers: {
    mastercardAuthCode: null,
    mastercardRefNumber: null,
    mastercardTransactionSequenceNumber: null,
    MID: "8552067328",
    visaAuthCode: "A73H890",
  },
  location: { id: "7a916fbd-70a0-462f-8dbc-bd7dbfbea140", address: "53 Frith Street", city: "London", countryCode: "GBR", postcode: "W1D 4SN", timezone: "Europe/London" },
  merchantCategoryCode: "5814",
  provider: "Fidel API",
};

function parse(event: CardFeedEvent, ctx: AdapterContext = GB, receivedAt = NOW): Observation {
  const signal: RawSignal<CardFeedEvent> = { adapterId: "card-feed", connectionId: "fidel_card_5001", receivedAt, payload: event };
  const result = adapter.parse(signal, ctx);
  if (result.status !== "observations") throw new Error(`expected observations, got ${result.status}`);
  return result.observations[0]!;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe("card feed adapter", () => {
  it("maps an authorization to an in-spend pending card payment", () => {
    const o = parse(AUTH);
    expect(o).toMatchObject({ kind: "money_movement", window: "in_spend", stage: "pending", direction: "debit", country: "GB", confidence: 0.95 });
    expect(o.source).toEqual({
      adapterId: "card-feed",
      kind: "card_feed",
      connectionId: "fidel_card_5001",
      label: "Visa card ••5001 linked to BRAKE (via Fidel API)",
      provider: "Fidel API",
    });
    expect(o.amount).toEqual({ value: money(460, "GBP"), confidence: 0.95 });
    // 08:15:30 local in London (BST) is 07:15:30 UTC.
    expect(o.occurredAt).toEqual({ value: Date.UTC(2026, 9, 3, 7, 15, 30), confidence: 0.95 });
    expect(o.merchant).toEqual({ raw: "COFFEE BRAND LONDON", name: "Coffee Brand", mcc: "5814", channel: "in_store", confidence: 0.95 });
    expect(o.instrument).toEqual({ type: "card", accountRef: AUTH.card.id, last4: "5001", network: "visa" });
    expect(o.rail).toEqual({ family: "card", scheme: "visa" });
    expect(o.references).toEqual([
      { type: "provider_transaction_id", value: AUTH.id, namespace: `card-feed:${AUTH.card.id}` },
      { type: "auth_code", value: "A73H890", namespace: "visa" },
    ]);
    expect(o.categoryHints).toEqual([{ scheme: "mcc", value: "5814", confidence: 0.9 }]);
    expect(o.typeHints).toEqual([{ type: "purchase", confidence: 0.7, reason: "card_feed:card_purchase" }]);
    expect(o.evidence.summary).toBe("The card network reported a pending payment of £4.60 at Coffee Brand on your Visa card ••5001.");
  });

  it("maps clearing to a posted record that fuses with its authorization", () => {
    const auth = parse(AUTH);
    const cleared = parse({ ...AUTH, event: "transaction.clearing", cleared: true }, GB, NOW + 2 * 86_400_000);
    expect(cleared).toMatchObject({ window: "post_spend", stage: "posted" });
    expect(cleared.amount?.confidence).toBe(0.99);
    expect(cleared.id).not.toBe(auth.id);
    expect(cleared.references[0]).toEqual(auth.references[0]);
    const assessment = assessPair(cleared, auth, FUSION, defaultMerchantMatcher);
    expect(assessment.veto).toBeUndefined();
    expect(assessment.features.map((f) => f.name)).toEqual(expect.arrayContaining(["reference_match", "amount_exact", "auth_code_match"]));
    expect(assessment.probability).toBeGreaterThan(0.99);
  });

  it("maps negative refunds to credits that never fuse with the original purchase", () => {
    const purchase = parse({ ...AUTH, cleared: true });
    const refund = parse({
      ...AUTH,
      event: "transaction.refund",
      id: "e1a7c0f2-41d3-4bd2-9b5f-0c7d3e2a9b11",
      amount: -4.6,
      auth: true,
      cleared: true,
      originalTransactionId: AUTH.id,
      datetime: "2026-10-05T12:02:11",
    });
    expect(refund).toMatchObject({ direction: "credit", stage: "posted", window: "post_spend" });
    expect(refund.amount?.value).toEqual(money(460, "GBP"));
    expect(refund.typeHints).toEqual([{ type: "refund", confidence: 0.9, reason: "card_feed:refund" }]);
    expect(refund.evidence.summary).toContain("refund of £4.60 from Coffee Brand");
    expect(assessPair(refund, purchase, FUSION, defaultMerchantMatcher).veto).toMatch(/direction/);
  });

  it("handles US Amex, Mastercard network references, Japanese yen and UAE dirham", () => {
    const amex = parse(
      {
        ...AUTH,
        id: "us-1",
        amount: 18.75,
        currency: "USD",
        datetime: "2026-10-02T12:31:09",
        authCode: null,
        card: { id: "card-amex", lastNumbers: "1009", scheme: "amex" },
        identifiers: { amexApprovalCode: "834512", MID: "9876543210" },
        descriptor: { merchantName: "SWEETGREEN NYC 0091" },
        brand: { name: "Sweetgreen" },
        location: { countryCode: "USA", timezone: "America/New_York" },
      },
      { clock: fixedClock(NOW), country: "US", locale: "en-US" },
    );
    expect(amex.country).toBe("US");
    expect(amex.occurredAt?.value).toBe(Date.UTC(2026, 9, 2, 16, 31, 9));
    expect(amex.references).toContainEqual({ type: "auth_code", value: "834512", namespace: "amex" });
    expect(amex.source.label).toBe("Amex card ••1009 linked to BRAKE (via Fidel API)");

    const mc = parse({
      ...AUTH,
      id: "se-1",
      amount: "129.00",
      currency: "SEK",
      card: { id: "card-mc", lastNumbers: "4444", scheme: "mastercard" },
      authCode: null,
      identifiers: { mastercardAuthCode: "MC1234", mastercardRefNumber: "AABBCCDDE", mastercardTransactionSequenceNumber: "0000001234567" },
      location: { countryCode: "SWE", timezone: "Europe/Stockholm" },
    });
    expect(mc.amount?.value).toEqual(money(12_900, "SEK"));
    expect(mc.references).toEqual(
      expect.arrayContaining([
        { type: "auth_code", value: "MC1234", namespace: "mastercard" },
        { type: "rail_reference", value: "AABBCCDDE", namespace: "mastercard" },
      ]),
    );

    const jp = parse({ ...AUTH, id: "jp-1", amount: 1200, currency: "JPY", location: { countryCode: "JPN", timezone: "Asia/Tokyo" }, datetime: "2026-10-03T16:15:30" });
    expect(jp.amount?.value).toEqual(money(1200, "JPY"));
    expect(jp.occurredAt?.value).toBe(Date.UTC(2026, 9, 3, 7, 15, 30));

    const ae = parse({ ...AUTH, id: "ae-1", amount: 36.75, currency: "AED", location: { countryCode: "ARE", timezone: "Asia/Dubai" } });
    expect(ae.country).toBe("AE");
    expect(ae.amount?.value).toEqual(money(3675, "AED"));
  });

  it("accepts an already-normalized merchant object and card-not-present purchases", () => {
    const o = parse({
      ...AUTH,
      id: "n-1",
      descriptor: null,
      brand: null,
      merchantCategoryCode: null,
      cardPresent: false,
      merchant: { name: "Deliveroo", mcc: 5812, address: "1 Cluny Mews, London" },
    });
    expect(o.merchant).toEqual({ raw: "Deliveroo", name: "Deliveroo", mcc: "5812", channel: "online", confidence: 0.95 });
  });

  it("falls back to the provider's UTC creation time and to the user's zone with lower confidence", () => {
    const noZone = parse({ ...AUTH, id: "z-1", location: { countryCode: "GBR" } });
    expect(noZone.occurredAt).toEqual({ value: Date.UTC(2026, 9, 3, 7, 15, 30), confidence: 0.7 });
    const noLocal = parse({ ...AUTH, id: "z-2", datetime: "not a date" });
    expect(noLocal.occurredAt).toEqual({ value: Date.parse("2026-10-03T07:15:31.644Z"), confidence: 0.8 });
  });

  it("is idempotent and never emits the card BIN or a full number", () => {
    expect(parse(AUTH).id).toBe(parse(AUTH).id);
    const o = parse({ ...AUTH, descriptor: { merchantName: "PAYMENT 4012888888881881 COFFEE BRAND" } });
    for (const s of strings(o)) {
      expect(s).not.toContain("401288");
      expect(s).not.toMatch(/\d{13,19}/);
    }
  });

  it("rejects events without id, card or amount", () => {
    const signal = (payload: unknown): RawSignal<CardFeedEvent> => ({ adapterId: "card-feed", connectionId: "c", receivedAt: NOW, payload: payload as CardFeedEvent });
    expect(adapter.parse(signal({ id: "x" }), GB).status).toBe("rejected");
    expect(adapter.parse(signal({ ...AUTH, amount: "abc" }), GB).status).toBe("rejected");
    expect(adapter.parse(signal({ ...AUTH, currency: "", amount: 4.6 }), GB).status).toBe("rejected");
    expect(adapter.parse(signal({ ...AUTH, currency: "" }), { ...GB, defaultCurrency: "GBP" }).status).toBe("observations");
  });
});
