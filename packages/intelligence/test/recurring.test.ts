import { describe, expect, it } from "vitest";
import { DAY, money, unknownInference, userInference } from "@brake/core";
import type {
  MerchantChannel,
  Observation,
  Reference,
  SubscriptionDetails,
  TemporalType,
  TransactionCandidate,
  TransactionType,
} from "@brake/core";
import { inference, makeCandidate, makeObservation, makeSource } from "@brake/core/testing";
import type { RecurringAlert, RecurringAlertKind, RecurringFindings, RecurringSeries } from "../src/contracts";
import { toneIssues } from "../src/copy";
import {
  SUBSCRIPTION_INTELLIGENCE_RECOMMENDATION,
  addMonthsAnchored,
  classifyCadence,
  cleanMerchantDescriptor,
  createRecurringDetector,
  describeRecurringAlert,
  recurringMerchantKey,
  recurringSeriesId,
} from "../src/recurring";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const utc = (y: number, m: number, d: number, h = 9, min = 0) => Date.UTC(y, m - 1, d, h, min);
/** "Today is 2026-10-04." */
const NOW = utc(2026, 10, 4, 12);

interface ChargeSpec {
  readonly id: string;
  readonly at: number;
  readonly minor: number;
  readonly currency: string;
  readonly key?: string | null;
  readonly raw?: string | null;
  readonly name?: string | null;
  readonly category?: string;
  readonly mcc?: string;
  readonly channel?: MerchantChannel;
  readonly last4?: string;
  readonly type?: TransactionType;
  readonly typeConfidence?: number;
  readonly country?: string;
  readonly counterparty?: { readonly name?: string; readonly handle?: string };
  readonly references?: readonly Reference[];
  readonly extra?: Partial<TransactionCandidate>;
}

function charge(p: ChargeSpec): TransactionCandidate {
  return makeCandidate({
    id: p.id,
    minor: p.minor,
    currency: p.currency,
    status: "posted",
    timestampEstimated: p.at,
    timestampConfirmed: p.at,
    createdAt: p.at,
    updatedAt: p.at,
    country: p.country ?? null,
    merchant: {
      raw: p.raw ?? null,
      normalized: p.key ?? null,
      displayName: p.name ?? null,
      confidence: 0.9,
      channel: p.channel ?? "unknown",
      ...(p.mcc ? { mcc: p.mcc } : {}),
    },
    category: p.category ? inference(p.category, 0.85) : unknownInference("uncategorized"),
    transactionType: p.type ? inference(p.type, p.typeConfidence ?? 0.8) : unknownInference<TransactionType>("unknown"),
    ...(p.last4 ? { instrument: { type: "card" as const, last4: p.last4 } } : {}),
    ...(p.counterparty ? { counterparty: p.counterparty } : {}),
    references: p.references ?? [],
    ...p.extra,
  });
}

type Base = Omit<ChargeSpec, "id" | "at" | "minor">;

/** One charge per calendar month on `day` (clamped to month length), starting at year/month. */
function monthly(prefix: string, year: number, month: number, day: number, amounts: readonly number[], base: Base, hour = 9): TransactionCandidate[] {
  return amounts.map((minor, i) => {
    const mi = month - 1 + i;
    const y = year + Math.floor(mi / 12);
    const m = (mi % 12) + 1;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return charge({ ...base, id: `${prefix}-${i + 1}`, at: utc(y, m, Math.min(day, dim), hour), minor });
  });
}

function at(prefix: string, dates: readonly number[], amounts: readonly number[], base: Base): TransactionCandidate[] {
  return dates.map((t, i) => charge({ ...base, id: `${prefix}-${i + 1}`, at: t, minor: amounts[i % amounts.length]! }));
}

function subscriptionEvent(
  id: string,
  when: number,
  merchant: { readonly raw: string; readonly key?: string; readonly name?: string },
  subscription: SubscriptionDetails,
  extra: Partial<Observation> = {},
): Observation {
  return makeObservation({
    id,
    kind: "subscription_event",
    window: "pre_spend",
    stage: "unknown",
    receivedAt: when,
    occurredAt: { value: when, confidence: 0.9 },
    direction: undefined,
    amount: undefined,
    merchant: { raw: merchant.raw, confidence: 0.9, ...(merchant.key ? { key: merchant.key } : {}), ...(merchant.name ? { name: merchant.name } : {}) },
    subscription,
    source: makeSource({ kind: "email", label: "email inbox" }),
    ...extra,
  });
}

function mandate(id: string, when: number, merchant: { raw: string; key?: string }, stage: "confirmed" | "cancelled", references: Reference[] = []): Observation {
  return makeObservation({
    id,
    kind: "mandate",
    window: "pre_spend",
    stage,
    receivedAt: when,
    occurredAt: { value: when, confidence: 0.9 },
    direction: undefined,
    amount: undefined,
    merchant: { raw: merchant.raw, confidence: 0.9, ...(merchant.key ? { key: merchant.key } : {}) },
    references,
    source: makeSource({ kind: "notification", label: "bank app notification" }),
  });
}

const detector = createRecurringDetector();

function only(f: RecurringFindings, merchantKey: string): RecurringSeries {
  const matches = f.series.filter((s) => s.merchantKey === merchantKey);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function alertOf(f: RecurringFindings, kind: RecurringAlertKind, seriesId?: string): RecurringAlert | undefined {
  return f.alerts.find((a) => a.kind === kind && (seriesId === undefined || a.seriesId === seriesId));
}

function kindsFor(f: RecurringFindings, seriesId: string): RecurringAlertKind[] {
  return f.alerts.filter((a) => a.seriesId === seriesId).map((a) => a.kind).sort();
}

function expectCalmCopy(f: RecurringFindings, now: number, locale: string): string[] {
  const texts = f.alerts.map((a) => {
    const s = f.series.find((x) => x.id === a.seriesId)!;
    return describeRecurringAlert(a, s, { now, locale });
  });
  for (const t of texts) expect(toneIssues(t), t).toEqual([]);
  return texts;
}

/* Reusable scenarios */

const netflixUsd: Base = {
  currency: "USD",
  key: "netflix",
  raw: "NETFLIX.COM 866-579-7172 CA",
  name: "Netflix",
  category: "entertainment.streaming",
  mcc: "4899",
  channel: "online",
  last4: "4242",
  type: "purchase",
  country: "US",
};

/** Netflix, $19.99 Apr–Aug, then $22.99 from Sep 5: the brief's "$22.99 renews tomorrow". */
function netflixWithPriceIncrease(): TransactionCandidate[] {
  return monthly("nflx", 2026, 4, 5, [1999, 1999, 1999, 1999, 1999, 2299], netflixUsd, 8);
}

/* ------------------------------------------------------------------ */
/* Merchant keys                                                       */
/* ------------------------------------------------------------------ */

describe("merchant keys", () => {
  it("cleans raw descriptors from cards, UPI and aggregators into stable keys", () => {
    expect(cleanMerchantDescriptor("NETFLIX.COM 866-579-7172 CA")).toBe("netflix");
    expect(cleanMerchantDescriptor("SQ *BLUE BOTTLE COFFEE")).toBe("blue bottle");
    expect(cleanMerchantDescriptor("AMZN Mktp US*2K4L9")).toBe("amzn");
    expect(cleanMerchantDescriptor("UPI/NETFLIX/123456789012/Payment")).toBe("netflix");
    expect(cleanMerchantDescriptor("PAG*Spotify")).toBe("spotify");
    expect(cleanMerchantDescriptor("SPOTIFY P1A2B3C4")).toBe("spotify");
    expect(cleanMerchantDescriptor("STARBUCKS STORE 1234 SEATTLE WA")).toBe("starbucks store");
    expect(cleanMerchantDescriptor("STARBUCKS STORE 5678 PORTLAND OR")).toBe("starbucks store");
  });

  it("keeps non-Latin scripts and returns null for pure payment noise", () => {
    expect(cleanMerchantDescriptor("ज़ोमैटो")).toBe("ज़ोमैटो".normalize("NFKD"));
    expect(cleanMerchantDescriptor("UPI PAYMENT")).toBeNull();
    expect(cleanMerchantDescriptor("")).toBeNull();
  });

  it("prefers the normalized key, then the raw descriptor, then the counterparty", () => {
    expect(recurringMerchantKey(charge({ id: "a", at: NOW, minor: 1, currency: "USD", key: "Netflix", raw: "NFLX DIGITAL" }))).toBe("netflix");
    expect(recurringMerchantKey(charge({ id: "b", at: NOW, minor: 1, currency: "USD", raw: "NETFLIX.COM 866-579-7172" }))).toBe("netflix");
    expect(
      recurringMerchantKey(charge({ id: "c", at: NOW, minor: 1, currency: "INR", counterparty: { name: "Ramesh Kumar", handle: "ramesh.k@okaxis" } })),
    ).toBe("ramesh kumar");
    expect(recurringMerchantKey(charge({ id: "d", at: NOW, minor: 1, currency: "INR", counterparty: { handle: "Ramesh.K@okaxis" } }))).toBe(
      "ramesh.k@okaxis",
    );
    expect(recurringMerchantKey(charge({ id: "e", at: NOW, minor: 1, currency: "INR" }))).toBeNull();
  });

  it("groups unnormalized descriptors with the normalized key they extend", () => {
    const normalized = monthly("n", 2026, 6, 5, [64900, 64900], { currency: "INR", key: "netflix", category: "entertainment.streaming" });
    const raw = monthly("r", 2026, 8, 5, [64900, 64900], { currency: "INR", raw: "NETFLIX ENTERTAINMENT SERVICES INDIA LLP", category: "entertainment.streaming" });
    const f = detector.detect([...normalized, ...raw], [], NOW);
    expect(only(f, "netflix").memberIds).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* Cadence & calendar arithmetic                                       */
/* ------------------------------------------------------------------ */

describe("calendar-month arithmetic", () => {
  it("clamps month-end anchors and returns to the anchor afterwards (Jan 31 → Feb 28 → Mar 31)", () => {
    const jan31 = utc(2026, 1, 31, 8, 30);
    const feb28 = addMonthsAnchored(jan31, 1, 31);
    expect(feb28).toBe(utc(2026, 2, 28, 8, 30));
    expect(addMonthsAnchored(feb28, 1, 31)).toBe(utc(2026, 3, 31, 8, 30));
    expect(addMonthsAnchored(utc(2026, 4, 30, 8, 30), 1, 31)).toBe(utc(2026, 5, 31, 8, 30));
  });

  it("handles leap years, the 30th, and multi-month steps", () => {
    expect(addMonthsAnchored(utc(2028, 1, 31), 1, 31)).toBe(utc(2028, 2, 29));
    expect(addMonthsAnchored(utc(2026, 2, 28), 1, 30)).toBe(utc(2026, 3, 30));
    expect(addMonthsAnchored(utc(2025, 11, 30), 3, 30)).toBe(utc(2026, 2, 28));
    expect(addMonthsAnchored(utc(2025, 10, 7), 12, 7)).toBe(utc(2026, 10, 7));
  });

  it("uses the billing month, so a charge shifted past a weekend still predicts the anchored day", () => {
    // Anchored on the 1st; the August charge slipped to Monday the 3rd.
    expect(addMonthsAnchored(utc(2026, 8, 3), 1, 1)).toBe(utc(2026, 9, 1));
    // Anchored on the 1st; a charge pulled forward to Apr 29 belongs to May.
    expect(addMonthsAnchored(utc(2026, 4, 29), 1, 1)).toBe(utc(2026, 6, 1));
  });

  it("works in local time for a non-UTC zone", () => {
    // 00:30 IST on Jan 31 is still Jan 30 in UTC; in Asia/Kolkata the anchor is the 31st.
    const jan31Ist = Date.UTC(2026, 0, 30, 19, 0);
    expect(addMonthsAnchored(jan31Ist, 1, 31, "Asia/Kolkata")).toBe(Date.UTC(2026, 1, 27, 19, 0)); // Feb 28 00:30 IST
  });
});

describe("cadence classification", () => {
  const series = (start: number, gaps: readonly number[]) => {
    const out = [start];
    for (const g of gaps) out.push(out[out.length - 1]! + g * DAY);
    return out;
  };

  it("recognises every supported cadence within its tolerance", () => {
    expect(classifyCadence(series(utc(2026, 6, 6), [7, 8, 6, 7, 7]))).toBe("weekly");
    expect(classifyCadence(series(utc(2026, 5, 1), [14, 13, 15, 14]))).toBe("biweekly");
    expect(classifyCadence([utc(2026, 1, 1), utc(2026, 2, 3), utc(2026, 3, 2), utc(2026, 3, 31), utc(2026, 5, 1)])).toBe("monthly");
    expect(classifyCadence([utc(2025, 1, 15), utc(2025, 4, 15), utc(2025, 7, 15), utc(2025, 10, 15)])).toBe("quarterly");
    expect(classifyCadence([utc(2024, 3, 10), utc(2024, 9, 10), utc(2025, 3, 10)])).toBe("semiannual");
    expect(classifyCadence([utc(2023, 10, 7), utc(2024, 10, 7), utc(2025, 10, 7)])).toBe("annual");
  });

  it("accepts 30-day cycles that drift against the calendar and month-end billing", () => {
    expect(classifyCadence([utc(2026, 1, 1), utc(2026, 1, 31), utc(2026, 3, 2), utc(2026, 4, 1), utc(2026, 5, 1)])).toBe("monthly");
    expect(classifyCadence([utc(2025, 12, 31), utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31)])).toBe("monthly");
  });

  it("tolerates one missed observation in a longer history but not scattered dates", () => {
    expect(classifyCadence([utc(2026, 1, 5), utc(2026, 2, 5), utc(2026, 4, 5), utc(2026, 5, 5), utc(2026, 6, 5)])).toBe("monthly");
    expect(classifyCadence(series(utc(2026, 6, 1), [2, 9, 4, 15, 1, 6]))).toBe("irregular");
    expect(classifyCadence([utc(2026, 1, 5), utc(2026, 2, 10), utc(2026, 3, 15), utc(2026, 4, 5)])).toBe("irregular");
    expect(classifyCadence([utc(2026, 1, 10), utc(2026, 3, 10), utc(2026, 5, 10), utc(2026, 7, 10)])).toBe("irregular"); // every two months
    expect(classifyCadence([utc(2026, 1, 10)])).toBe("irregular");
  });
});

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

describe("Netflix monthly with a price increase (the brief's example)", () => {
  const f = detector.detect(netflixWithPriceIncrease(), [], NOW);
  const s = only(f, "netflix");

  it("detects a monthly subscription and predicts the next charge on the billing day", () => {
    expect(s.id).toBe(recurringSeriesId("netflix", "USD", "monthly"));
    expect(s).toMatchObject({ cadence: "monthly", periodDays: 30, status: "active", displayName: "Netflix" });
    expect(s.memberIds).toHaveLength(6);
    expect(s.firstChargeAt).toBe(utc(2026, 4, 5, 8));
    expect(s.lastChargeAt).toBe(utc(2026, 9, 5, 8));
    expect(s.nextExpectedAt).toBe(utc(2026, 10, 5, 8));
    expect(s.nextExpectedAmount).toEqual(money(2299, "USD"));
    expect(s.typicalAmount).toEqual(money(1999, "USD"));
    expect(s.subscriptionProbability).toBeGreaterThanOrEqual(0.9);
    expect(s.confidence).toBeGreaterThan(0.85);
    expect(s.amountVariation).toBeGreaterThan(0);
    expect(s.amountVariation).toBeLessThan(0.1);
  });

  it("keeps the price history as distinct amounts", () => {
    expect(s.priceHistory).toEqual([
      { at: utc(2026, 4, 5, 8), amount: money(1999, "USD") },
      { at: utc(2026, 9, 5, 8), amount: money(2299, "USD") },
    ]);
  });

  it("raises upcoming_renewal and price_increase, worded as the brief asks", () => {
    const renewal = alertOf(f, "upcoming_renewal", s.id)!;
    expect(renewal).toMatchObject({ at: utc(2026, 10, 5, 8), amount: money(2299, "USD") });
    expect(renewal.confidence).toBeGreaterThanOrEqual(0.85);
    expect(describeRecurringAlert(renewal, s, { now: NOW, locale: "en-US" })).toBe("Netflix renews tomorrow for $22.99. Keep or review?");

    const increase = alertOf(f, "price_increase", s.id)!;
    expect(increase).toMatchObject({ at: utc(2026, 9, 5, 8), amount: money(2299, "USD"), previousAmount: money(1999, "USD") });
    expect(describeRecurringAlert(increase, s, { now: NOW, locale: "en-US" })).toBe("Netflix now costs $22.99 a month, up from $19.99 (+15%).");
    expectCalmCopy(f, NOW, "en-US");
  });

  it("does not repeat a price increase that is older than the last period", () => {
    const old = monthly("old", 2026, 1, 5, [1999, 2299, 2299, 2299, 2299, 2299, 2299, 2299, 2299], netflixUsd, 8);
    const g = detector.detect(old, [], NOW);
    expect(alertOf(g, "price_increase")).toBeUndefined();
  });

  it("links members, infers temporal type and refines purchase to subscription", () => {
    expect(f.patches.size).toBe(6);
    const patch = f.patches.get("nflx-1")!;
    expect(patch.links).toEqual([{ kind: "recurring_series", target: s.id, probability: s.confidence, createdAt: NOW }]);
    const temporal = patch.attributes!.temporalType!;
    expect(temporal.value).toBe("subscription");
    expect(temporal.basis).toEqual(["recurrence"]);
    expect(temporal.userSet).toBe(false);
    expect(temporal.alternatives.map((a) => a.value)).toEqual(expect.arrayContaining(["one_off"]));
    const type = patch.transactionType!;
    expect(type.value).toBe("subscription");
    expect(type.confidence).toBeCloseTo(s.confidence * s.subscriptionProbability, 2);
    // The earlier "purchase" belief keeps the remaining mass instead of being erased.
    expect(type.alternatives).toEqual([{ value: "purchase", probability: expect.any(Number) }]);
    expect(type.confidence + type.alternatives[0]!.probability).toBeCloseTo(1, 2);
    expect(type.basis).toContain("recurrence");
  });
});

describe("Spotify trial conversion", () => {
  const spotify: Base = {
    currency: "USD",
    key: "spotify",
    raw: "SPOTIFY USA",
    name: "Spotify",
    category: "entertainment.streaming",
    mcc: "5815",
    channel: "online",
    country: "US",
  };
  const trialStarted = subscriptionEvent(
    "obs-trial-start",
    utc(2026, 9, 1, 9),
    { raw: "Spotify", key: "spotify" },
    { event: "trial_started", serviceName: "Spotify Premium", trialEndsAt: utc(2026, 10, 1, 9), price: money(1199, "USD"), period: "P1M" },
  );
  const background = charge({ id: "coffee-jun", at: utc(2026, 6, 2), minor: 450, currency: "USD", key: "blue bottle" });

  it("marks the first full charge after a free trial as a trial conversion", () => {
    const zeroAuth = charge({ ...spotify, id: "sp-0", at: utc(2026, 9, 1, 9), minor: 0 });
    const firstPaid = charge({ ...spotify, id: "sp-1", at: utc(2026, 10, 1, 9), minor: 1199 });
    const f = detector.detect([background, zeroAuth, firstPaid], [trialStarted], NOW);
    const s = only(f, "spotify");
    expect(s.status).toBe("active");
    expect(s.cadence).toBe("monthly");
    expect(s.memberIds).toEqual(["sp-0", "sp-1"]);
    expect(s.typicalAmount).toEqual(money(1199, "USD"));
    expect(s.nextExpectedAt).toBe(utc(2026, 11, 1, 9));
    expect(s.priceHistory.map((p) => p.amount.minor)).toEqual([0, 1199]);

    const conversion = alertOf(f, "trial_conversion", s.id)!;
    expect(conversion).toMatchObject({ at: utc(2026, 10, 1, 9), amount: money(1199, "USD") });
    expect(conversion.confidence).toBeGreaterThan(0.7);
    expect(alertOf(f, "new_subscription", s.id)).toBeDefined();
    expect(alertOf(f, "price_increase", s.id)).toBeUndefined(); // free → paid is a conversion, not a price rise
    expectCalmCopy(f, NOW, "en-US");
  });

  it("while the trial runs, reports status trial and the stated end as the upcoming renewal", () => {
    const now = utc(2026, 9, 29, 12);
    const zeroAuth = charge({ ...spotify, id: "sp-0", at: utc(2026, 9, 1, 9), minor: 0 });
    const ending = subscriptionEvent(
      "obs-trial-ending",
      utc(2026, 9, 28, 9),
      { raw: "Spotify", key: "spotify" },
      { event: "trial_ending", trialEndsAt: utc(2026, 10, 1, 9), price: money(1199, "USD") },
    );
    const f = detector.detect([background, zeroAuth], [trialStarted, ending], now);
    const s = only(f, "spotify");
    expect(s.status).toBe("trial");
    expect(s.nextExpectedAt).toBe(utc(2026, 10, 1, 9));
    expect(s.nextExpectedAmount).toEqual(money(1199, "USD"));
    const renewal = alertOf(f, "upcoming_renewal", s.id)!;
    expect(renewal.amount).toEqual(money(1199, "USD"));
    expect(describeRecurringAlert(renewal, s, { now, locale: "en-US" })).toBe(
      "Spotify trial ends in 2 days; after that it's $11.99 a month. Keep or review?",
    );
    expect(alertOf(f, "trial_conversion")).toBeUndefined();
    expectCalmCopy(f, now, "en-US");
  });

  it("recognises intro pricing without any email (BRL, Pix-era Brazil)", () => {
    const now = utc(2026, 9, 16, 12);
    const brl: Base = { ...spotify, currency: "BRL", raw: "PAG*Spotify", country: "BR" };
    const f = detector.detect(monthly("spbr", 2026, 7, 15, [199, 199, 2190], brl), [], now);
    const s = only(f, "spotify");
    expect(s.status).toBe("active");
    expect(s.typicalAmount).toEqual(money(2190, "BRL"));
    expect(s.nextExpectedAmount).toEqual(money(2190, "BRL"));
    expect(s.nextExpectedAt).toBe(utc(2026, 10, 15, 9));
    const conversion = alertOf(f, "trial_conversion", s.id)!;
    expect(conversion).toMatchObject({ at: utc(2026, 9, 15, 9), amount: money(2190, "BRL") });
    expect(alertOf(f, "price_increase")).toBeUndefined();
    const text = describeRecurringAlert(conversion, s, { now, locale: "pt-BR" });
    expect(text).toContain("Spotify");
    expect(toneIssues(text)).toEqual([]);
  });
});

describe("Amazon Prime: annual with a renewal notice (INR)", () => {
  const prime: Base = {
    currency: "INR",
    key: "amazon",
    raw: "AMAZON PRIME MEMBERSHIP",
    name: "Amazon Prime",
    category: "shopping.online_marketplace",
    channel: "online",
    country: "IN",
  };
  const shopping: Base = { currency: "INR", key: "amazon", raw: "AMAZON PAY INDIA", name: "Amazon", category: "shopping.online_marketplace", channel: "online" };
  const primeCharges = [charge({ ...prime, id: "prime-2024", at: utc(2024, 10, 7), minor: 149_900 }), charge({ ...prime, id: "prime-2025", at: utc(2025, 10, 7), minor: 149_900 })];
  const purchases = [
    charge({ ...shopping, id: "amz-a", at: utc(2025, 11, 20), minor: 145_000 }), // close to the Prime price, but off its rhythm
    charge({ ...shopping, id: "amz-b", at: utc(2026, 1, 12), minor: 34_900 }),
    charge({ ...shopping, id: "amz-c", at: utc(2026, 3, 3), minor: 219_900 }),
    charge({ ...shopping, id: "amz-d", at: utc(2026, 6, 21), minor: 79_900 }),
  ];
  const notice = subscriptionEvent(
    "obs-prime-renewal",
    utc(2026, 10, 1, 6),
    { raw: "Amazon Prime", key: "amazon", name: "Amazon Prime" },
    { event: "renewal_upcoming", serviceName: "Prime", nextChargeAt: utc(2026, 10, 7), price: money(149_900, "INR"), period: "P1Y" },
  );

  it("finds the annual membership among unrelated purchases and announces the renewal", () => {
    const f = detector.detect([...primeCharges, ...purchases], [notice], NOW);
    const s = only(f, "amazon");
    expect(s).toMatchObject({ cadence: "annual", periodDays: 365, status: "active", displayName: "Amazon Prime" });
    expect(s.memberIds).toEqual(["prime-2024", "prime-2025"]);
    expect(s.nextExpectedAt).toBe(utc(2026, 10, 7));
    expect(s.nextExpectedAmount).toEqual(money(149_900, "INR"));
    expect(s.subscriptionProbability).toBeGreaterThan(0.9);

    const renewal = alertOf(f, "upcoming_renewal", s.id)!;
    expect(renewal.at).toBe(utc(2026, 10, 7));
    expect(describeRecurringAlert(renewal, s, { now: NOW, locale: "en-IN" })).toBe("Amazon Prime renews in 3 days for ₹1,499. Keep or review?");

    // Ordinary Amazon purchases are neither linked nor relabelled…
    expect([...f.patches.keys()].sort()).toEqual(["prime-2024", "prime-2025"]);
    // …and they count as interaction with the merchant, so Prime is not called dormant.
    expect(alertOf(f, "dormant_subscription")).toBeUndefined();
    // Prime existed before BRAKE could see it: not a "new" subscription.
    expect(alertOf(f, "new_subscription")).toBeUndefined();
    expectCalmCopy(f, NOW, "en-IN");
  });

  it("needs context for an annual series with only two charges", () => {
    const f = detector.detect([...primeCharges, ...purchases], [], NOW);
    expect(f.series).toEqual([]);
    expect(f.patches.size).toBe(0);
  });

  it("does not build an annual series from one charge, even with a notice (2 + context required)", () => {
    const f = detector.detect([primeCharges[1]!], [notice], NOW);
    expect(f.series).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Recurring, but not subscriptions                                    */
/* ------------------------------------------------------------------ */

describe("habits and bills", () => {
  it("weekly grocery habit: recurring, very unlikely a subscription, no renewal nudge", () => {
    const now = utc(2026, 10, 8, 12);
    const dmart: Base = { currency: "INR", key: "dmart", raw: "DMART AVENUE SUPERMARTS", name: "DMart", category: "groceries", mcc: "5411", channel: "in_store", type: "purchase" };
    const dates = [
      utc(2026, 8, 1, 11),
      utc(2026, 8, 8, 10),
      utc(2026, 8, 16, 12), // Sunday this week
      utc(2026, 8, 22, 11),
      utc(2026, 8, 29, 10),
      utc(2026, 9, 5, 11),
      utc(2026, 9, 11, 18), // Friday evening
      utc(2026, 9, 19, 10),
      utc(2026, 9, 26, 11),
      utc(2026, 10, 3, 10),
    ];
    const amounts = [184_500, 231_000, 199_900, 262_000, 176_050, 241_200, 208_800, 190_000, 255_500, 221_000];
    const f = detector.detect(at("dmart", dates, amounts, dmart), [], now);
    const s = only(f, "dmart");
    expect(s.cadence).toBe("weekly");
    expect(s.memberIds).toHaveLength(10);
    expect(s.subscriptionProbability).toBeLessThan(0.1);
    expect(s.amountVariation).toBeGreaterThan(0.1);
    expect(s.nextExpectedAt).toBe(utc(2026, 10, 10, 10));
    expect(alertOf(f, "upcoming_renewal")).toBeUndefined();
    expect(alertOf(f, "price_increase")).toBeUndefined();
    const patch = f.patches.get("dmart-1")!;
    expect(patch.attributes!.temporalType!.value).toBe<TemporalType>("recurring");
    expect(patch.transactionType).toBeUndefined();
  });

  it("monthly rent by UPI to a landlord: recurring, not a subscription", () => {
    const rent: Base = {
      currency: "INR",
      counterparty: { name: "Ramesh Kumar", handle: "ramesh.k@okaxis" },
      category: "housing.rent",
      type: "purchase",
      typeConfidence: 0.7,
      extra: { paymentRail: { family: "account_to_account_instant", scheme: "upi" } },
    };
    const dates = [utc(2026, 4, 1), utc(2026, 5, 2), utc(2026, 6, 1), utc(2026, 7, 3), utc(2026, 8, 1), utc(2026, 9, 1), utc(2026, 10, 1)];
    const f = detector.detect(at("rent", dates, [2_500_000], rent), [], NOW);
    const s = only(f, "ramesh kumar");
    expect(s).toMatchObject({ cadence: "monthly", status: "active", displayName: "Ramesh Kumar" });
    expect(s.nextExpectedAt).toBe(utc(2026, 11, 1));
    expect(s.subscriptionProbability).toBeLessThan(0.3);
    expect(alertOf(f, "upcoming_renewal")).toBeUndefined();
    const patch = f.patches.get("rent-1")!;
    expect(patch.attributes!.temporalType!.value).toBe("recurring");
    expect(patch.transactionType).toBeUndefined();
  });

  it("monthly rent by Pix with an annual adjustment reports the increase (BRL)", () => {
    const aluguel: Base = { currency: "BRL", counterparty: { name: "Imobiliária Lar Ltda" }, category: "housing.rent", type: "purchase", country: "BR" };
    const f = detector.detect(monthly("aluguel", 2026, 4, 5, [250_000, 250_000, 250_000, 250_000, 250_000, 265_000], aluguel), [], NOW);
    const s = only(f, "imobiliaria lar");
    expect(s.subscriptionProbability).toBeLessThan(0.3);
    const increase = alertOf(f, "price_increase", s.id)!;
    expect(increase).toMatchObject({ amount: money(265_000, "BRL"), previousAmount: money(250_000, "BRL") });
    expect(f.patches.get("aluguel-1")!.transactionType).toBeUndefined();
    expectCalmCopy(f, NOW, "pt-BR");
  });

  it("variable utility bill (EUR, SEPA direct debit): recurring, low subscription probability, no price alerts", () => {
    const power: Base = { currency: "EUR", key: "iberdrola", raw: "SEPA-LASTSCHRIFT IBERDROLA", category: "bills.utilities", mcc: "4900", country: "ES" };
    const f = detector.detect(monthly("power", 2026, 4, 8, [6240, 7110, 8990, 11_800, 9450, 10_720], power), [], NOW);
    const s = only(f, "iberdrola");
    expect(s.cadence).toBe("monthly");
    expect(s.amountVariation).toBeGreaterThan(0.15);
    expect(s.subscriptionProbability).toBeLessThan(0.15);
    expect(alertOf(f, "price_increase")).toBeUndefined();
    expect(f.patches.get("power-1")!.attributes!.temporalType!.value).toBe("recurring");
  });
});

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

describe("duplicate subscriptions", () => {
  it("flags the same streaming service billed on two cards", () => {
    const cardA = monthly("nf-a", 2026, 6, 3, [1549, 1549, 1549, 1549], { ...netflixUsd, last4: "4242" });
    const cardB = monthly("nf-b", 2026, 6, 18, [1549, 1549, 1549, 1549], { ...netflixUsd, last4: "1881" });
    const f = detector.detect([...cardA, ...cardB], [], NOW);
    const netflix = f.series.filter((s) => s.merchantKey === "netflix");
    expect(netflix).toHaveLength(2);
    const [older, newer] = netflix;
    expect(older!.id).toBe(recurringSeriesId("netflix", "USD", "monthly"));
    expect(newer!.id).not.toBe(older!.id);
    expect(older!.memberIds.every((id) => id.startsWith("nf-a"))).toBe(true);
    expect(newer!.memberIds.every((id) => id.startsWith("nf-b"))).toBe(true);

    const dup = alertOf(f, "duplicate_subscription")!;
    expect(dup.seriesId).toBe(newer!.id);
    expect(dup.relatedSeriesIds).toEqual([older!.id]);
    expect(dup.confidence).toBeGreaterThan(0.75);
    expectCalmCopy(f, NOW, "en-US");
  });

  it("flags the same streaming service billed directly and through an app store (EUR)", () => {
    const direct = monthly("dis-direct", 2026, 6, 10, [999, 999, 999, 999], {
      currency: "EUR",
      key: "disneyplus",
      raw: "DISNEY PLUS",
      name: "Disney+",
      category: "entertainment.streaming",
      channel: "online",
      extra: { paymentRail: { family: "direct_debit", scheme: "sepa_dd" } },
    });
    const viaStore = monthly("dis-store", 2026, 6, 22, [999, 999, 999, 999], {
      currency: "EUR",
      key: "apple",
      raw: "APPLE.COM/BILL",
      name: "Disney+",
      category: "entertainment.streaming",
      channel: "online",
    });
    const f = detector.detect([...direct, ...viaStore], [], NOW);
    expect(f.series).toHaveLength(2);
    const dup = alertOf(f, "duplicate_subscription")!;
    const ids = [dup.seriesId, ...(dup.relatedSeriesIds ?? [])].sort();
    expect(ids).toEqual(f.series.map((s) => s.id).sort());
    expect(dup.confidence).toBeLessThan(0.75);
  });

  it("keeps two concurrent plans at one merchant apart (INR tiers) and asks whether both are intended", () => {
    const base: Base = { currency: "INR", key: "spotify", category: "entertainment.streaming", mcc: "5815", channel: "online", last4: "7890" };
    const individual = monthly("sp-ind", 2026, 6, 5, [11_900, 11_900, 11_900, 11_900], base);
    const duo = monthly("sp-duo", 2026, 6, 20, [14_900, 14_900, 14_900, 14_900], base);
    const f = detector.detect([...individual, ...duo], [], NOW);
    const spotify = f.series.filter((s) => s.merchantKey === "spotify");
    expect(spotify.map((s) => s.typicalAmount.minor).sort()).toEqual([11_900, 14_900]);
    expect(spotify.every((s) => s.cadence === "monthly")).toBe(true);
    expect(alertOf(f, "duplicate_subscription")).toBeDefined();
  });

  it("a card replacement keeps one series and is not a duplicate", () => {
    const oldCard = monthly("cr-a", 2026, 3, 12, [1549, 1549, 1549, 1549], { ...netflixUsd, last4: "4242" });
    const newCard = monthly("cr-b", 2026, 7, 12, [1549, 1549, 1549], { ...netflixUsd, last4: "5005" });
    const f = detector.detect([...oldCard, ...newCard], [], NOW);
    expect(only(f, "netflix").memberIds).toHaveLength(7);
    expect(alertOf(f, "duplicate_subscription")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle: dormant, cancelled, context-corroborated                 */
/* ------------------------------------------------------------------ */

describe("lifecycle", () => {
  const showmax: Base = { currency: "KES", key: "showmax", raw: "SHOWMAX", name: "Showmax", category: "entertainment.streaming", channel: "online", country: "KE", extra: { paymentRail: { family: "mobile_money", scheme: "mpesa" } } };

  it("a series that stopped charging is dormant, with no next charge predicted (KES, M-Pesa)", () => {
    const f = detector.detect(monthly("smx", 2026, 1, 10, [34_900, 34_900, 34_900, 34_900, 34_900], showmax), [], NOW);
    const s = only(f, "showmax");
    expect(s.status).toBe("dormant");
    expect(s.nextExpectedAt).toBeNull();
    expect(s.nextExpectedAmount).toBeNull();
    expect(f.alerts).toEqual([]);
  });

  it("a cancellation notice after the last charge cancels the series (EUR)", () => {
    const base: Base = { currency: "EUR", key: "spotify", raw: "Spotify AB", name: "Spotify", category: "entertainment.streaming", channel: "online" };
    const charges = monthly("sp-eu", 2026, 6, 12, [1099, 1099, 1099, 1099], base);
    const cancelled = subscriptionEvent("obs-cancel", utc(2026, 9, 20), { raw: "Spotify", key: "spotify" }, { event: "cancelled" });
    const f = detector.detect(charges, [cancelled], NOW);
    const s = only(f, "spotify");
    expect(s.status).toBe("cancelled");
    expect(s.nextExpectedAt).toBeNull();
    expect(alertOf(f, "upcoming_renewal")).toBeUndefined();

    // Charged again after cancelling: resubscribed, active again.
    const again = charge({ ...base, id: "sp-eu-again", at: utc(2026, 9, 28), minor: 1099 });
    const g = detector.detect([...charges, again], [cancelled], NOW);
    expect(only(g, "spotify").status).toBe("active");
  });

  it("a revoked mandate cancels the series it governs (INR, UPI AutoPay)", () => {
    const umn: Reference = { type: "mandate_id", value: "UMN-HOTSTAR-77", namespace: "upi" };
    const charges = monthly("hs", 2026, 7, 8, [29_900, 29_900, 29_900], {
      currency: "INR",
      raw: "UPI-AUTOPAY-JIOHOTSTAR",
      name: "JioHotstar",
      category: "entertainment.streaming",
      references: [umn],
      extra: { paymentRail: { family: "account_to_account_instant", scheme: "upi" } },
    });
    const revoked = mandate("obs-revoke", utc(2026, 9, 25), { raw: "Some PSP mandate notice" }, "cancelled", [umn]);
    const f = detector.detect(charges, [revoked], NOW);
    expect(f.series).toHaveLength(1);
    expect(f.series[0]!.status).toBe("cancelled");
  });

  it("two charges suffice with a mandate; without context they do not", () => {
    const yt: Base = { currency: "INR", key: "youtube", raw: "YOUTUBE PREMIUM", name: "YouTube Premium", category: "entertainment.streaming", channel: "online" };
    const charges = monthly("yt", 2026, 8, 15, [14_900, 14_900], yt);
    const active = mandate("obs-mandate", utc(2026, 8, 14), { raw: "YouTube", key: "youtube" }, "confirmed");
    expect(detector.detect(charges, [], NOW).series).toEqual([]);
    const f = detector.detect(charges, [active], NOW);
    const s = only(f, "youtube");
    expect(s.cadence).toBe("monthly");
    expect(s.subscriptionProbability).toBeGreaterThan(0.9);
  });

  it("one charge plus a pre-debit notice is enough, and the notice sets date and amount (INR)", () => {
    const one = charge({ id: "nf-in-1", at: utc(2026, 9, 5, 8), minor: 64_900, currency: "INR", key: "netflix", name: "Netflix", category: "entertainment.streaming" });
    const preDebit = subscriptionEvent(
      "obs-predebit",
      utc(2026, 10, 4, 8),
      { raw: "NETFLIX", key: "netflix" },
      { event: "renewal_upcoming", nextChargeAt: utc(2026, 10, 5, 8), price: money(64_900, "INR") },
    );
    const f = detector.detect([one], [preDebit], NOW);
    const s = only(f, "netflix");
    expect(s.cadence).toBe("monthly");
    expect(s.nextExpectedAt).toBe(utc(2026, 10, 5, 8));
    const renewal = alertOf(f, "upcoming_renewal", s.id)!;
    expect(describeRecurringAlert(renewal, s, { now: NOW, locale: "en-IN" })).toBe("Netflix renews tomorrow for ₹649. Keep or review?");
    expect(detector.detect([one], [], NOW).series).toEqual([]);
  });

  it("a merchant price-change notice raises price_increase ahead of the charge", () => {
    const charges = monthly("nf-pc", 2026, 6, 5, [64_900, 64_900, 64_900, 64_900], { currency: "INR", key: "netflix", name: "Netflix", category: "entertainment.streaming" });
    const notice = subscriptionEvent(
      "obs-price",
      utc(2026, 9, 28),
      { raw: "Netflix", key: "netflix" },
      { event: "price_change", price: money(79_900, "INR"), previousPrice: money(64_900, "INR"), nextChargeAt: utc(2026, 10, 5, 9) },
    );
    const f = detector.detect(charges, [notice], NOW);
    const s = only(f, "netflix");
    expect(s.nextExpectedAmount).toEqual(money(79_900, "INR"));
    const increase = alertOf(f, "price_increase", s.id)!;
    expect(increase).toMatchObject({ at: utc(2026, 10, 5, 9), amount: money(79_900, "INR"), previousAmount: money(64_900, "INR"), confidence: 0.9 });
    expect(alertOf(f, "upcoming_renewal", s.id)!.amount).toEqual(money(79_900, "INR"));
    expectCalmCopy(f, NOW, "en-IN");
  });
});

describe("new and dormant subscriptions", () => {
  const history = [
    charge({ id: "h-1", at: utc(2026, 1, 3), minor: 900, currency: "USD", key: "corner deli" }),
    charge({ id: "h-2", at: utc(2026, 3, 14), minor: 2500, currency: "USD", key: "bookshop" }),
  ];
  const duolingo: Base = { currency: "USD", key: "duolingo", raw: "DUOLINGO PLUS", name: "Duolingo", mcc: "5817", channel: "online" };

  it("reports a subscription that started while BRAKE was already watching", () => {
    const f = detector.detect([...history, ...monthly("duo", 2026, 7, 20, [1299, 1299, 1299], duolingo)], [], NOW);
    const s = only(f, "duolingo");
    const fresh = alertOf(f, "new_subscription", s.id)!;
    expect(fresh).toMatchObject({ at: utc(2026, 9, 20, 9), amount: money(1299, "USD") });
    expect(describeRecurringAlert(fresh, s, { now: NOW, locale: "en-US" })).toMatch(/^(Looks like a new|New) recurring charge: Duolingo/);
  });

  it("does not call a subscription new when it was already there when history begins", () => {
    const f = detector.detect(monthly("duo", 2026, 1, 20, [1299, 1299, 1299, 1299, 1299, 1299, 1299, 1299, 1299], duolingo), [], NOW);
    expect(alertOf(f, "new_subscription")).toBeUndefined();
  });

  it("asks about an active subscription with no other activity for 3 periods, at low confidence", () => {
    const f = detector.detect(netflixWithPriceIncrease(), [], NOW);
    const s = only(f, "netflix");
    const dormant = alertOf(f, "dormant_subscription", s.id)!;
    expect(dormant.confidence).toBeLessThanOrEqual(0.4);
    expect(dormant.at).toBeLessThanOrEqual(NOW);
    const text = describeRecurringAlert(dormant, s, { now: NOW, locale: "en-US" });
    expect(text).toContain("can't see usage");
    expect(toneIssues(text)).toEqual([]);
  });

  it("stays quiet when there is a recent non-billing interaction with the merchant", () => {
    const appOpened = makeObservation({
      id: "obs-app",
      kind: "app_context",
      window: "pre_spend",
      stage: "unknown",
      receivedAt: utc(2026, 9, 20),
      occurredAt: { value: utc(2026, 9, 20), confidence: 0.9 },
      direction: undefined,
      amount: undefined,
      merchant: { raw: "Netflix", key: "netflix", confidence: 0.9 },
    });
    const f = detector.detect(netflixWithPriceIncrease(), [appOpened], NOW);
    expect(alertOf(f, "dormant_subscription")).toBeUndefined();
  });

  it("never calls a young subscription dormant", () => {
    const f = detector.detect(monthly("young", 2026, 8, 5, [1999, 1999, 1999], netflixUsd), [], NOW);
    expect(alertOf(f, "dormant_subscription")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* What must never become a series                                     */
/* ------------------------------------------------------------------ */

describe("exclusions and irregular merchants", () => {
  it("never builds series from transfers, card bills, income, intents or cancelled charges", () => {
    const ownTransfer = monthly("own", 2026, 4, 1, [5_000_000, 5_000_000, 5_000_000, 5_000_000], {
      currency: "INR",
      raw: "TRANSFER TO SAVINGS",
      type: "transfer",
      extra: { transferKind: "own_account" },
    });
    const walletLoad = monthly("wallet", 2026, 4, 2, [200_000, 200_000, 200_000, 200_000], { currency: "INR", raw: "WALLET TOPUP", type: "transfer", extra: { transferKind: "wallet_load" } });
    const cardBill = monthly("cardbill", 2026, 4, 10, [4_500_000, 3_800_000, 4_100_000, 4_700_000], { currency: "INR", raw: "CARD BILL PAYMENT", type: "credit_card_payment" });
    const salary = monthly("salary", 2026, 4, 28, [12_000_000, 12_000_000, 12_000_000, 12_000_000], { currency: "INR", raw: "SALARY ACME", type: "income", extra: { direction: "credit" } });
    const intents = monthly("intent", 2026, 4, 5, [1999, 1999, 1999, 1999], { ...netflixUsd, extra: { status: "intent" } });
    const voided = monthly("void", 2026, 4, 6, [999, 999, 999, 999], { currency: "USD", key: "gym", extra: { status: "cancelled" } });
    const f = detector.detect([...ownTransfer, ...walletLoad, ...cardBill, ...salary, ...intents, ...voided], [], NOW);
    expect(f.series).toEqual([]);
    expect(f.alerts).toEqual([]);
    expect(f.patches.size).toBe(0);
  });

  it("irregular merchants produce no series (EUR café, USD marketplace)", () => {
    const cafe: Base = { currency: "EUR", key: "cafe de flore", category: "eating_out.cafe", channel: "in_store" };
    const dates = [utc(2026, 6, 1), utc(2026, 6, 3), utc(2026, 6, 12), utc(2026, 6, 16), utc(2026, 7, 1), utc(2026, 7, 2), utc(2026, 7, 8), utc(2026, 8, 19), utc(2026, 9, 2)];
    const market: Base = { currency: "USD", raw: "AMZN Mktp US*2K4L9", category: "shopping.online_marketplace", channel: "online" };
    const marketDates = [utc(2026, 2, 3), utc(2026, 2, 27), utc(2026, 4, 11), utc(2026, 5, 2), utc(2026, 7, 19), utc(2026, 9, 9)];
    const f = detector.detect(
      [...at("cafe", dates, [450, 380, 620, 410, 1290, 455, 700], cafe), ...at("mkt", marketDates, [2399, 4599, 1299, 8900, 3150, 1999], market)],
      [],
      NOW,
    );
    expect(f.series).toEqual([]);
    expect(f.patches.size).toBe(0);
  });

  it("a user's one-off label removes that charge from the series", () => {
    const charges = monthly("lbl", 2026, 5, 5, [1999, 1999, 1999, 1999], netflixUsd);
    const labelled = { ...charges[3]!, attributes: { ...charges[3]!.attributes, temporalType: userInference<TemporalType>("one_off") } };
    const f = detector.detect([...charges.slice(0, 3), labelled], [], NOW);
    expect(only(f, "netflix").memberIds).toEqual(["lbl-1", "lbl-2", "lbl-3"]);
    expect(f.patches.has("lbl-4")).toBe(false);
  });
});

describe("user labels are never overwritten", () => {
  it("skips transactionType and temporalType patches on user-set members but still links them", () => {
    const charges = netflixWithPriceIncrease();
    const userType = { ...charges[0]!, transactionType: userInference<TransactionType>("purchase") };
    const userTemporal = { ...charges[1]!, attributes: { ...charges[1]!.attributes, temporalType: userInference<TemporalType>("recurring") } };
    const feeTyped = { ...charges[2]!, transactionType: inference<TransactionType>("fee", 0.9) };
    const f = detector.detect([userType, userTemporal, feeTyped, ...charges.slice(3)], [], NOW);
    const s = only(f, "netflix");

    const p0 = f.patches.get(userType.id)!;
    expect(p0.transactionType).toBeUndefined();
    expect(p0.links![0]!.target).toBe(s.id);

    const p1 = f.patches.get(userTemporal.id)!;
    expect(p1.attributes).toBeUndefined();
    expect(p1.links![0]!.target).toBe(s.id);

    // Only purchase/unknown may be refined to "subscription".
    expect(f.patches.get(feeTyped.id)!.transactionType).toBeUndefined();
    expect(f.patches.get(charges[3]!.id)!.transactionType!.value).toBe("subscription");
  });

  it("a user's 'subscription' label is evidence; a user's 'recurring' label lowers subscription probability", () => {
    const plain = monthly("gym", 2026, 6, 1, [4500, 4500, 4500, 4500], { currency: "USD", key: "fitlab" });
    const baseline = only(detector.detect(plain, [], NOW), "fitlab").subscriptionProbability;
    const labelledSub = [{ ...plain[0]!, transactionType: userInference<TransactionType>("subscription") }, ...plain.slice(1)];
    const labelledRec = [{ ...plain[0]!, attributes: { ...plain[0]!.attributes, temporalType: userInference<TemporalType>("recurring") } }, ...plain.slice(1)];
    expect(only(detector.detect(labelledSub, [], NOW), "fitlab").subscriptionProbability).toBeGreaterThan(baseline);
    expect(only(detector.detect(labelledRec, [], NOW), "fitlab").subscriptionProbability).toBeLessThan(baseline);
  });
});

/* ------------------------------------------------------------------ */
/* Calendar edge cases in series                                       */
/* ------------------------------------------------------------------ */

describe("month-end billing", () => {
  const cloud: Base = { currency: "USD", key: "dropbox", raw: "DROPBOX*9K2LQ", name: "Dropbox", mcc: "5817", channel: "online" };

  it("bills on the 31st: Feb 28 is on rhythm and the next charge returns to the 30th/31st", () => {
    const dates = [utc(2025, 12, 31), utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31)];
    const f = detector.detect(at("dbx", dates, [1199], cloud), [], utc(2026, 4, 2, 12));
    const s = only(f, "dropbox");
    expect(s.cadence).toBe("monthly");
    expect(s.nextExpectedAt).toBe(utc(2026, 4, 30));
    expect(s.confidence).toBeGreaterThan(0.75);
  });

  it("after Jan 31 the next charge is Feb 28", () => {
    const dates = [utc(2025, 11, 30), utc(2025, 12, 31), utc(2026, 1, 31)];
    const f = detector.detect(at("dbx", dates, [1199], cloud), [], utc(2026, 2, 1, 12));
    expect(only(f, "dropbox").nextExpectedAt).toBe(utc(2026, 2, 28));
  });

  it("bills on the 30th: Feb 28 then back to Mar 30, never the 31st", () => {
    const dates = [utc(2026, 1, 30), utc(2026, 2, 28), utc(2026, 3, 30), utc(2026, 4, 30)];
    const f = detector.detect(at("dbx", dates, [1199], cloud), [], utc(2026, 5, 2, 12));
    expect(only(f, "dropbox").nextExpectedAt).toBe(utc(2026, 5, 30));
  });

  it("uses the configured time zone for billing days", () => {
    // 00:30 IST on the 1st is the previous day in UTC; in Asia/Kolkata these are all "the 1st".
    const ist = (y: number, m: number) => Date.UTC(y, m - 1, 1, 0, 30) - 5.5 * 3_600_000;
    const dates = [ist(2026, 6), ist(2026, 7), ist(2026, 8), ist(2026, 9)];
    const local = createRecurringDetector({ timeZone: "Asia/Kolkata" });
    const f = local.detect(at("jio", dates, [39_900], { currency: "INR", key: "jio fiber", category: "bills.phone_internet" }), [], NOW);
    expect(only(f, "jio fiber").nextExpectedAt).toBe(ist(2026, 10));
  });
});

/* ------------------------------------------------------------------ */
/* Agnosticism & determinism                                           */
/* ------------------------------------------------------------------ */

describe("provider-agnostic and deterministic", () => {
  const markets = [
    { currency: "INR", amount: 19_900, rail: { family: "account_to_account_instant" as const, scheme: "upi" }, adapterId: "sms", country: "IN" },
    { currency: "USD", amount: 1_299, rail: { family: "card" as const, scheme: "visa" }, adapterId: "open-banking", country: "US" },
    { currency: "EUR", amount: 1_199, rail: { family: "direct_debit" as const, scheme: "sepa_dd" }, adapterId: "psd2", country: "DE" },
    { currency: "BRL", amount: 2_190, rail: { family: "account_to_account_instant" as const, scheme: "pix" }, adapterId: "open-finance", country: "BR" },
    { currency: "KES", amount: 34_900, rail: { family: "mobile_money" as const, scheme: "mpesa" }, adapterId: "notification", country: "KE" },
  ];

  it("reads the same rhythm the same way whatever the currency, rail, country or source", () => {
    const results = markets.map((mk) => {
      const charges = monthly(`m-${mk.currency}`, 2026, 5, 12, [mk.amount, mk.amount, mk.amount, mk.amount, mk.amount], {
        currency: mk.currency,
        key: "musicbox",
        name: "MusicBox",
        category: "entertainment.streaming",
        channel: "online",
        country: mk.country,
        extra: {
          paymentRail: mk.rail,
          sourceSignals: [
            {
              observationId: `obs-${mk.currency}`,
              kind: "money_movement",
              sourceLabel: `${mk.adapterId} source`,
              adapterId: mk.adapterId,
              connectionId: `conn-${mk.adapterId}`,
              role: "primary",
              matchProbability: 1,
              linkedAt: NOW,
            },
          ],
        },
      });
      return only(detector.detect(charges, [], NOW), "musicbox");
    });
    for (const s of results) {
      expect(s.cadence).toBe("monthly");
      expect(s.status).toBe("active");
      expect(s.confidence).toBe(results[0]!.confidence);
      expect(s.subscriptionProbability).toBe(results[0]!.subscriptionProbability);
      expect(s.nextExpectedAt).toBe(utc(2026, 10, 12));
    }
    expect(new Set(results.map((s) => s.id)).size).toBe(markets.length); // currency is part of the id
  });

  it("gives identical findings regardless of input order, run after run", () => {
    const candidates = [
      ...netflixWithPriceIncrease(),
      ...monthly("nf-b", 2026, 6, 18, [2299, 2299, 2299, 2299], { ...netflixUsd, last4: "1881" }),
      ...monthly("rent", 2026, 4, 1, [2_500_000, 2_500_000, 2_500_000, 2_500_000, 2_500_000, 2_500_000, 2_500_000], {
        currency: "INR",
        counterparty: { name: "Ramesh Kumar" },
        category: "housing.rent",
      }),
    ];
    const shuffled = [...candidates].reverse();
    const interleaved = candidates.filter((_, i) => i % 2 === 0).concat(candidates.filter((_, i) => i % 2 === 1));
    const a = detector.detect(candidates, [], NOW);
    const b = detector.detect(shuffled, [], NOW);
    const c = createRecurringDetector().detect(interleaved, [], NOW);
    expect(b.series).toEqual(a.series);
    expect(c.series).toEqual(a.series);
    expect(b.alerts).toEqual(a.alerts);
    expect([...b.patches.entries()].sort(([x], [y]) => x.localeCompare(y))).toEqual([...a.patches.entries()].sort(([x], [y]) => x.localeCompare(y)));
    expect(a.series.map((s) => s.id)).toContain(recurringSeriesId("netflix", "USD", "monthly"));
    expect(a.series.map((s) => s.id)).toContain(recurringSeriesId("ramesh kumar", "INR", "monthly"));
  });

  it("returns empty findings for empty input", () => {
    const f = detector.detect([], [], NOW);
    expect(f.series).toEqual([]);
    expect(f.alerts).toEqual([]);
    expect(f.patches.size).toBe(0);
  });
});

describe("copy and product recommendation", () => {
  it("every alert across scenarios reads calmly and never scolds", () => {
    const all = [
      detector.detect(netflixWithPriceIncrease(), [], NOW),
      detector.detect(
        [...monthly("a", 2026, 6, 3, [1549, 1549, 1549, 1549], { ...netflixUsd, last4: "4242" }), ...monthly("b", 2026, 6, 18, [1549, 1549, 1549, 1549], { ...netflixUsd, last4: "1881" })],
        [],
        NOW,
      ),
    ];
    for (const f of all) {
      const texts = expectCalmCopy(f, NOW, "en-US");
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) expect(t).not.toMatch(/^you spent/i);
    }
  });

  it("phrases lower-confidence renewals as estimates or questions", () => {
    const series = only(detector.detect(netflixWithPriceIncrease(), [], NOW), "netflix");
    const base: RecurringAlert = { kind: "upcoming_renewal", seriesId: series.id, at: utc(2026, 10, 5, 8), amount: money(2299, "USD"), confidence: 0.7 };
    expect(describeRecurringAlert(base, series, { now: NOW, locale: "en-US" })).toBe("Looks like Netflix renews tomorrow, about $22.99. Keep or review?");
    expect(describeRecurringAlert({ ...base, confidence: 0.4 }, series, { now: NOW, locale: "en-US" })).toBe(
      "Does Netflix renew tomorrow? Last time it was $22.99.",
    );
    expect(describeRecurringAlert({ ...base, at: utc(2026, 10, 20) }, series, { now: NOW, locale: "en-US" })).toContain("on Oct 20");
  });

  it("answers the brief's question: passive core now, proactive management later", () => {
    expect(SUBSCRIPTION_INTELLIGENCE_RECOMMENDATION.initialProduct).toContain("series_detection");
    expect(SUBSCRIPTION_INTELLIGENCE_RECOMMENDATION.initialProduct).toContain("stated_renewals");
    expect(SUBSCRIPTION_INTELLIGENCE_RECOMMENDATION.later).toEqual(["duplicate_subscription", "dormant_subscription"]);
  });
});
