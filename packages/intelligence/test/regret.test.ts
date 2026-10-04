import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE, defaultAttributes, formatMoney, localParts, money, userInference, zonedTimeToEpoch } from "@brake/core";
import type { CategoryId, Essentiality, TransactionCandidate, TransactionType } from "@brake/core";
import { inference, makeCandidate } from "@brake/core/testing";
import type { RegretFeatures, RegretModel, RegretPromptContext } from "../src/contracts";
import { toneIssues } from "../src/copy";
import {
  amountBandForRatio,
  createRegretModel,
  createRegretPromptPolicy,
  regretFeatures,
  regretInformationValue,
  regretPromptText,
  regretSegmentPath,
  timeBandForHour,
} from "../src/regret";
import type { RegretPromptPolicyOptions } from "../src/regret";
import { SATISFACTION_OPTIONS } from "../src/taxonomy";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const IST = "Asia/Kolkata";

/** Local wall-clock time in October 2026 (3rd = Saturday, 4th = Sunday). */
function local(day: number, hour: number, minute = 0, timeZone = IST): number {
  return zonedTimeToEpoch({ year: 2026, month: 10, day, hour, minute, second: 0 }, timeZone);
}

const SAT_2PM = local(3, 14);

type CandidateOverrides = Partial<TransactionCandidate> & { minor?: number; currency?: string };

/** ₹6,200 headphones bought online on Saturday afternoon: posted, discretionary, personal. */
function gadget(p: CandidateOverrides = {}): TransactionCandidate {
  return makeCandidate({
    id: "cand_headphones",
    minor: 620_000,
    status: "posted",
    timestampEstimated: SAT_2PM,
    merchant: { raw: "CROMA RETAIL", normalized: "croma", displayName: "Croma", confidence: 0.95, channel: "online" },
    paymentRail: { family: "card", scheme: "rupay" },
    transactionType: inference<TransactionType>("purchase", 0.95),
    category: inference<CategoryId>("shopping.electronics", 0.9),
    attributes: { ...defaultAttributes(), essentiality: inference<Essentiality>("discretionary", 0.7) },
    ...p,
  });
}

/** A ₹3,400 restaurant dinner on Saturday at 13:00 (an experience). */
function dinner(p: CandidateOverrides = {}): TransactionCandidate {
  return gadget({
    id: "cand_dinner",
    minor: 340_000,
    timestampEstimated: local(3, 13),
    merchant: { raw: "TOIT BREWPUB", normalized: "toit", displayName: "Toit", confidence: 0.9, channel: "in_store" },
    category: inference<CategoryId>("eating_out.restaurant", 0.9),
    attributes: { ...defaultAttributes(), essentiality: inference<Essentiality>("discretionary", 0.67) },
    ...p,
  });
}

const TYPICAL = 250_000; // ₹2,500 typical discretionary purchase
const features = (c: TransactionCandidate, timeZone = IST, typical = TYPICAL): RegretFeatures =>
  regretFeatures(c, { timeZone, typicalDiscretionaryMinor: typical });

function pctx(c: TransactionCandidate, p: Partial<RegretPromptContext> = {}): RegretPromptContext {
  return {
    now: c.timestampEstimated + MINUTE,
    locale: "en-IN",
    promptsLast7Days: 0,
    lastPromptAt: null,
    model: createRegretModel(),
    features: features(c),
    userOptedOut: false,
    ...p,
  };
}

const policy = (opts: RegretPromptPolicyOptions = {}) => createRegretPromptPolicy({ timeZone: IST, ...opts });

const LATE_NIGHT_GADGET: RegretFeatures = {
  category: "shopping",
  channel: "online",
  timeBand: "late_night",
  dayType: "weekday",
  amountBand: "medium",
  planned: "unplanned",
};
const RESTAURANT_DINNER: RegretFeatures = {
  category: "eating_out",
  channel: "in_store",
  timeBand: "evening",
  dayType: "weekend",
  amountBand: "medium",
  planned: "planned",
};
const TRAVEL: RegretFeatures = { ...RESTAURANT_DINNER, category: "travel", channel: "online", amountBand: "very_large" };

function modelWith(entries: ReadonlyArray<[RegretFeatures, "regretted" | "neutral" | "worth_it", number]>): RegretModel {
  const m = createRegretModel();
  for (const [f, answer, times] of entries) for (let i = 0; i < times; i++) m.record(f, answer);
  return m;
}

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

describe("regret features", () => {
  it("bands local hours: morning 5–12, afternoon 12–17, evening 17–22, late night 22–5", () => {
    const bands = [0, 4, 5, 11, 12, 16, 17, 21, 22, 23].map(timeBandForHour);
    expect(bands).toEqual([
      "late_night",
      "late_night",
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
      "evening",
      "late_night",
      "late_night",
    ]);
  });

  it("bands amounts relative to the typical discretionary purchase", () => {
    expect([0.49, 0.5, 1.99, 2, 4.99, 5, 40].map(amountBandForRatio)).toEqual([
      "small",
      "medium",
      "medium",
      "large",
      "large",
      "very_large",
      "very_large",
    ]);
  });

  it("reads time of day and weekday in the user's time zone", () => {
    // 23:40 IST on Friday 2 Oct is 18:10 UTC: late night in India, evening by UTC.
    const c = gadget({ timestampEstimated: local(2, 23, 40) });
    expect(features(c)).toEqual({
      category: "shopping",
      channel: "online",
      timeBand: "late_night",
      dayType: "weekday",
      amountBand: "large",
      planned: "unknown",
    });
    expect(features(c, "UTC").timeBand).toBe("evening");
    expect(features(gadget()).dayType).toBe("weekend");
  });

  it("takes the weekend definition as configuration, not from a country", () => {
    const friday = gadget({ timestampEstimated: local(2, 12) });
    expect(features(friday).dayType).toBe("weekday");
    expect(regretFeatures(friday, { timeZone: IST, typicalDiscretionaryMinor: TYPICAL, weekendDays: [4, 5] }).dayType).toBe("weekend");
  });

  it("derives planned/unplanned from the intent attribute, trusting only confident or user-set values", () => {
    const withIntent = (intent: TransactionCandidate["attributes"]["intent"]) =>
      features(gadget({ attributes: { ...defaultAttributes(), intent } })).planned;
    expect(withIntent(inference("planned", 0.8))).toBe("planned");
    expect(withIntent(inference("impulsive", 0.7))).toBe("unplanned");
    expect(withIntent(inference("planned", 0.3))).toBe("unknown");
    expect(withIntent(userInference("unplanned"))).toBe("unplanned");
    const saw = features(gadget({ attributes: { ...defaultAttributes(), purchaseContext: inference("saw_and_bought", 0.6) } }));
    expect(saw.planned).toBe("unplanned");
  });

  it("uses the neutral amount band when the amount or the typical amount is unknown", () => {
    expect(features(gadget({ amount: null })).amountBand).toBe("medium");
    expect(features(gadget(), IST, 0).amountBand).toBe("medium");
  });
});

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

describe("hierarchical regret model", () => {
  it("starts at the Beta(1,3) prior with no evidence", () => {
    expect(createRegretModel().estimate(LATE_NIGHT_GADGET)).toEqual({ probability: 0.25, evidence: 0, segment: "global" });
  });

  it("does not jump to conclusions from one answer", () => {
    const m = modelWith([[LATE_NIGHT_GADGET, "regretted", 1]]);
    const e = m.estimate(LATE_NIGHT_GADGET);
    expect(e.probability).toBeCloseTo(0.4, 10);
    expect(e.evidence).toBe(1);
    expect(e.segment).toBe(regretSegmentPath(LATE_NIGHT_GADGET)[3]);
  });

  it("learns that late-night online electronics are regretted while restaurant dinners stay low", () => {
    const m = modelWith([
      [RESTAURANT_DINNER, "worth_it", 6],
      [TRAVEL, "worth_it", 3],
    ]);
    const before = m.estimate(LATE_NIGHT_GADGET).probability;
    let previous = before;
    for (let i = 0; i < 6; i++) {
      m.record(LATE_NIGHT_GADGET, "regretted");
      const now = m.estimate(LATE_NIGHT_GADGET).probability;
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
    expect(previous).toBeGreaterThan(0.6);
    const restaurants = m.estimate(RESTAURANT_DINNER);
    expect(restaurants.probability).toBeLessThan(0.25);
    expect(restaurants.probability).toBeLessThan(previous / 2);
  });

  it("backs off to coarser segments when a segment has no answers of its own", () => {
    const m = modelWith([[LATE_NIGHT_GADGET, "regretted", 4]]);
    const [global, category, middle, full] = regretSegmentPath(LATE_NIGHT_GADGET);
    expect(m.estimate(LATE_NIGHT_GADGET).segment).toBe(full);
    expect(m.estimate({ ...LATE_NIGHT_GADGET, amountBand: "large" }).segment).toBe(middle);
    expect(m.estimate({ ...LATE_NIGHT_GADGET, timeBand: "afternoon" }).segment).toBe(category);
    expect(m.estimate({ ...LATE_NIGHT_GADGET, category: "entertainment" }).segment).toBe(global);
    // Backed-off estimates inherit the direction but carry less evidence than the segment itself.
    const nearby = m.estimate({ ...LATE_NIGHT_GADGET, amountBand: "large" });
    expect(nearby.probability).toBeGreaterThan(0.25);
    expect(nearby.evidence).toBeLessThan(m.estimate(LATE_NIGHT_GADGET).evidence);
  });

  it("counts 'regretted' as 1, 'neutral' as 0.3 and 'worth it' as 0", () => {
    const neutral = modelWith([[LATE_NIGHT_GADGET, "neutral", 40]]).estimate(LATE_NIGHT_GADGET).probability;
    const worth = modelWith([[LATE_NIGHT_GADGET, "worth_it", 40]]).estimate(LATE_NIGHT_GADGET).probability;
    const regretted = modelWith([[LATE_NIGHT_GADGET, "regretted", 40]]).estimate(LATE_NIGHT_GADGET).probability;
    expect(neutral).toBeCloseTo((40 * 0.3 + 4 * 0.25) / 44, 10);
    expect(worth).toBeLessThan(neutral);
    expect(neutral).toBeLessThan(regretted);
  });

  it("is order-independent", () => {
    const a = modelWith([
      [LATE_NIGHT_GADGET, "regretted", 3],
      [RESTAURANT_DINNER, "worth_it", 2],
      [TRAVEL, "neutral", 2],
    ]);
    const b = modelWith([
      [TRAVEL, "neutral", 2],
      [RESTAURANT_DINNER, "worth_it", 2],
      [LATE_NIGHT_GADGET, "regretted", 3],
    ]);
    for (const f of [LATE_NIGHT_GADGET, RESTAURANT_DINNER, TRAVEL]) expect(b.estimate(f)).toEqual(a.estimate(f));
  });

  it("round-trips through toJSON", () => {
    const m = modelWith([
      [LATE_NIGHT_GADGET, "regretted", 3],
      [RESTAURANT_DINNER, "worth_it", 5],
      [TRAVEL, "neutral", 2],
    ]);
    const restored = createRegretModel(JSON.parse(JSON.stringify(m.toJSON())));
    expect(restored.toJSON()).toEqual(m.toJSON());
    for (const f of [LATE_NIGHT_GADGET, RESTAURANT_DINNER, TRAVEL, { ...TRAVEL, category: "gifts" }]) {
      expect(restored.estimate(f)).toEqual(m.estimate(f));
    }
    // Restored models keep learning.
    restored.record(LATE_NIGHT_GADGET, "regretted");
    expect(restored.estimate(LATE_NIGHT_GADGET).evidence).toBeGreaterThan(m.estimate(LATE_NIGHT_GADGET).evidence);
  });

  it("rejects malformed snapshots and answers instead of silently corrupting learning", () => {
    expect(() => createRegretModel("nope")).toThrow(TypeError);
    expect(() => createRegretModel({ version: 2, prior: { alpha: 1, beta: 3 }, segments: [] })).toThrow(TypeError);
    expect(() => createRegretModel({ version: 1, prior: { alpha: 1, beta: 3 }, segments: [{ key: "global", regret: 5, answers: 2 }] })).toThrow(
      TypeError,
    );
    expect(() => createRegretModel().record(LATE_NIGHT_GADGET, "meh" as never)).toThrow(RangeError);
  });
});

describe("information value", () => {
  it("is 1 for an unseen segment and falls as answers accumulate", () => {
    expect(regretInformationValue({ probability: 0.25, evidence: 0 })).toBeCloseTo(1, 10);
    const values = [0, 2, 5, 10, 20].map((evidence) => regretInformationValue({ probability: 0.3, evidence }));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
    expect(values[4]!).toBeLessThan(0.1);
  });

  it("is higher for a coin-flip segment than for a settled one", () => {
    expect(regretInformationValue({ probability: 0.5, evidence: 4 })).toBeGreaterThan(regretInformationValue({ probability: 0.05, evidence: 4 }));
  });
});

/* ------------------------------------------------------------------ */
/* Prompt policy                                                       */
/* ------------------------------------------------------------------ */

describe("regret prompt policy", () => {
  it("asks about a discretionary purchase like the brief, at ~19:00 local, 24–72 h later", () => {
    const c = gadget();
    const plan = policy().plan(c, pctx(c));
    expect(plan).not.toBeNull();
    expect(plan!.prompt).toBe("That ₹6,200 purchase from Saturday — still happy you bought it?");
    expect(plan!.options).toEqual(SATISFACTION_OPTIONS);
    expect(plan!.value).toBeCloseTo(1, 10);
    // Goods: the second evening, after the item has usually arrived (Monday 19:00).
    expect(plan!.askAt).toBe(local(5, 19));
    expect(plan!.askAt - c.timestampEstimated).toBeGreaterThanOrEqual(24 * HOUR);
    expect(plan!.askAt - c.timestampEstimated).toBeLessThanOrEqual(72 * HOUR);
    expect(toneIssues(plan!.prompt)).toEqual([]);
  });

  it("asks about experiences sooner than about goods", () => {
    const d = dinner();
    const plan = policy().plan(d, pctx(d));
    expect(plan!.askAt).toBe(local(4, 19)); // Sunday evening, ~30 h later
    const g = gadget({ timestampEstimated: local(3, 13) });
    expect(policy().plan(g, pctx(g))!.askAt).toBeGreaterThan(plan!.askAt);
  });

  it("is deterministic", () => {
    const c = gadget();
    expect(policy().plan(c, pctx(c))).toEqual(policy().plan(c, pctx(c)));
    expect(policy().explain(c, pctx(c)).plan).toEqual(policy().plan(c, pctx(c)));
  });

  describe("only for confirmed, personal, discretionary purchases", () => {
    const blockedBy = (c: TransactionCandidate, p: Partial<RegretPromptContext> = {}) => {
      const outcome = policy().explain(c, pctx(c, p));
      expect(outcome.plan).toBeNull();
      return "blockedBy" in outcome ? outcome.blockedBy : null;
    };

    it("never asks a user who opted out", () => {
      expect(blockedBy(gadget(), { userOptedOut: true })).toBe("opted_out");
    });

    it("never asks about pending, intent or cancelled candidates", () => {
      expect(blockedBy(gadget({ status: "pending" }))).toBe("not_completed");
      expect(blockedBy(gadget({ status: "intent" }))).toBe("not_completed");
      expect(blockedBy(gadget({ status: "cancelled" }))).toBe("not_completed");
      expect(policy().plan(gadget({ status: "confirmed" }), pctx(gadget()))).not.toBeNull();
    });

    it("never asks about refunded purchases", () => {
      expect(blockedBy(gadget({ status: "refunded" }))).toBe("refunded");
      expect(blockedBy(gadget({ links: [{ kind: "refunded_by", target: "cand_refund", probability: 0.9, createdAt: SAT_2PM }] }))).toBe("refunded");
    });

    it("never asks about transfers, card bills or uncertain purchase types", () => {
      expect(blockedBy(gadget({ transactionType: inference<TransactionType>("transfer", 0.9) }))).toBe("not_a_purchase");
      expect(blockedBy(gadget({ transactionType: inference<TransactionType>("credit_card_payment", 0.9) }))).toBe("not_a_purchase");
      expect(blockedBy(gadget({ transactionType: inference<TransactionType>("purchase", 0.55, [["transfer", 0.45]]) }))).toBe(
        "not_a_purchase",
      );
      expect(blockedBy(gadget({ direction: "credit" }))).toBe("not_a_purchase");
    });

    it("never asks about subscriptions or other recurring charges", () => {
      const renewal = gadget({ attributes: { ...gadget().attributes, temporalType: inference("subscription", 0.9) } });
      expect(blockedBy(renewal)).toBe("recurring");
      const series = gadget({ links: [{ kind: "recurring_series", target: "series_netflix", probability: 0.8, createdAt: SAT_2PM }] });
      expect(blockedBy(series)).toBe("recurring");
    });

    it("never asks about essentials, bills or rent", () => {
      const groceries = gadget({
        category: inference<CategoryId>("groceries", 0.9),
        attributes: { ...defaultAttributes(), essentiality: inference<Essentiality>("essential", 0.75) },
      });
      expect(blockedBy(groceries)).toBe("essential");
      expect(blockedBy(gadget({ category: inference<CategoryId>("bills.utilities", 0.9) }))).toBe("essential");
      expect(blockedBy(gadget({ category: inference<CategoryId>("housing.rent", 0.9) }))).toBe("essential");
      // Unsure whether it was discretionary: do not ask.
      expect(blockedBy(gadget({ attributes: { ...defaultAttributes(), essentiality: inference<Essentiality>("discretionary", 0.4) } }))).toBe(
        "essential",
      );
      const semi = gadget({ attributes: { ...defaultAttributes(), essentiality: inference<Essentiality>("semi_discretionary", 0.6) } });
      expect(policy().plan(semi, pctx(semi))).not.toBeNull();
    });

    it("never asks about sensitive categories", () => {
      expect(blockedBy(gadget({ category: inference<CategoryId>("health", 0.9) }))).toBe("sensitive");
      expect(blockedBy(gadget({ category: inference<CategoryId>("donations", 0.9) }))).toBe("sensitive");
    });

    it("never asks about business, reimbursable or shared expenses", () => {
      expect(blockedBy(gadget({ attributes: { ...gadget().attributes, ownership: userInference("business") } }))).toBe("not_personal");
      expect(blockedBy(gadget({ attributes: { ...gadget().attributes, ownership: inference("shared", 0.8) } }))).toBe("not_personal");
    });

    it("never asks about small purchases, uncertain candidates, or twice", () => {
      const coffee = gadget({ minor: 45_000 });
      expect(blockedBy(coffee, { features: features(coffee) })).toBe("small_amount");
      expect(blockedBy(gadget({ confidence: 0.7 }))).toBe("low_confidence");
      expect(blockedBy(gadget({ amount: null }))).toBe("low_confidence");
      const answered = gadget({
        attributes: { ...gadget().attributes, satisfaction: { value: "worth_it", askedAt: SAT_2PM, answeredAt: SAT_2PM } },
      });
      expect(blockedBy(answered)).toBe("already_answered");
    });
  });

  describe("sparsity", () => {
    it("respects the weekly cap (default 2)", () => {
      const c = gadget();
      expect(policy().explain(c, pctx(c, { promptsLast7Days: 2 }))).toEqual({ plan: null, blockedBy: "weekly_cap" });
      expect(policy().plan(c, pctx(c, { promptsLast7Days: 1 }))).not.toBeNull();
      expect(policy({ maxPerWeek: 1 }).plan(c, pctx(c, { promptsLast7Days: 1 }))).toBeNull();
    });

    it("waits at least 24 h after the previous prompt", () => {
      const d = dinner();
      // Last prompt Saturday 22:00: Sunday 19:00 is too soon, Monday 19:00 is fine.
      const plan = policy().plan(d, pctx(d, { lastPromptAt: local(3, 22) }));
      expect(plan!.askAt).toBe(local(5, 19));
      // Last prompt Monday 15:00: nothing fits before the window closes on Tuesday 13:00.
      expect(policy().explain(d, pctx(d, { lastPromptAt: local(5, 15) }))).toEqual({ plan: null, blockedBy: "no_slot" });
    });

    it("stops asking about a kind of purchase once BRAKE understands it", () => {
      const c = gadget();
      const f = features(c);
      const known = modelWith([[f, "worth_it", 30]]);
      expect(policy().explain(c, pctx(c, { model: known }))).toEqual({ plan: null, blockedBy: "low_information" });
    });

    it("samples uncertain-but-known segments deterministically, in proportion to information value", () => {
      const base = gadget();
      const f = features(base);
      const model = modelWith([
        [f, "regretted", 2],
        [f, "worth_it", 1],
      ]);
      const value = regretInformationValue(model.estimate(f));
      expect(value).toBeGreaterThan(0.3);
      expect(value).toBeLessThan(0.7);
      const outcomes = Array.from({ length: 300 }, (_, i) => {
        const c = gadget({ id: `cand_${i}` });
        return policy().explain(c, pctx(c, { model }));
      });
      const asked = outcomes.filter((o) => o.plan !== null).length / outcomes.length;
      expect(asked).toBeGreaterThan(value - 0.12);
      expect(asked).toBeLessThan(value + 0.12);
      for (const o of outcomes) if (o.plan === null) expect(o).toMatchObject({ blockedBy: "sampled_out" });
      for (const o of outcomes) if (o.plan !== null) expect("samplingProbability" in o && o.samplingProbability).toBeCloseTo(value, 10);
      // Same ids, same draws.
      const again = Array.from({ length: 300 }, (_, i) => {
        const c = gadget({ id: `cand_${i}` });
        return policy().plan(c, pctx(c, { model })) !== null;
      });
      expect(again).toEqual(outcomes.map((o) => o.plan !== null));
    });
  });

  describe("timing", () => {
    it("never asks about purchases older than the window", () => {
      const c = gadget();
      expect(policy().explain(c, pctx(c, { now: c.timestampEstimated + 73 * HOUR }))).toEqual({ plan: null, blockedBy: "no_slot" });
    });

    it("plans late discoveries inside the window, never in the past", () => {
      const c = gadget();
      const now = c.timestampEstimated + 50 * HOUR; // Monday 16:00
      expect(policy().plan(c, pctx(c, { now }))!.askAt).toBe(local(5, 19));
      const lastMoment = c.timestampEstimated + 71 * HOUR; // Tuesday 13:00, the evening slot is past the window
      const plan = policy().plan(c, pctx(c, { now: lastMoment }))!;
      expect(plan.askAt).toBe(lastMoment);
    });

    it("keeps out of quiet hours", () => {
      const d = dinner();
      const lateAsk = policy({ askHour: 23 }).plan(d, pctx(d))!;
      expect(localParts(lateAsk.askAt, IST).hour).toBe(21);
      const earlyQuiet = policy({ quietHours: { from: 18, to: 9 } }).plan(d, pctx(d))!;
      expect(localParts(earlyQuiet.askAt, IST).hour).toBe(17);
      // Planned late at night with the window closing before morning: stay silent.
      const night = dinner({ timestampEstimated: local(3, 23) });
      expect(policy().explain(night, pctx(night, { now: local(6, 22, 30) }))).toEqual({ plan: null, blockedBy: "no_slot" });
    });

    it("honours custom delay windows and names the date when the purchase is over 6 days old", () => {
      const c = gadget();
      const plan = policy({ minDelayHours: 7 * 24, maxDelayHours: 10 * 24 }).plan(c, pctx(c))!;
      expect(plan.askAt - c.timestampEstimated).toBeGreaterThan(6 * DAY);
      expect(plan.prompt).toBe("That ₹6,200 purchase from 3 October — still happy you bought it?");
    });
  });

  describe("wording", () => {
    it("never states an estimated amount flatly", () => {
      const c = gadget({ amount: { value: money(620_000, "INR"), confidence: 0.9, approximate: true } });
      expect(policy().plan(c, pctx(c))!.prompt).toBe("That purchase of about ₹6,200 from Saturday — still happy you bought it?");
    });

    it("uses the user's time zone and locale for the weekday and amount, in any market", () => {
      const markets = [
        { tz: "America/New_York", locale: "en-US", minor: 8_999, currency: "USD", typical: 4_000, rail: { family: "card", scheme: "visa" } },
        { tz: "Europe/Berlin", locale: "de-DE", minor: 14_900, currency: "EUR", typical: 6_000, rail: { family: "account_to_account_batch", scheme: "sepa" } },
        { tz: "America/Sao_Paulo", locale: "pt-BR", minor: 45_000, currency: "BRL", typical: 20_000, rail: { family: "account_to_account_instant", scheme: "pix" } },
        { tz: "Africa/Nairobi", locale: "en-KE", minor: 650_000, currency: "KES", typical: 300_000, rail: { family: "mobile_money", scheme: "mpesa" } },
        { tz: IST, locale: "en-IN", minor: 620_000, currency: "INR", typical: TYPICAL, rail: { family: "account_to_account_instant", scheme: "upi" } },
      ] as const;
      for (const m of markets) {
        const c = gadget({
          id: `cand_${m.currency}`,
          amount: { value: money(m.minor, m.currency), confidence: 0.99 },
          paymentRail: m.rail,
          timestampEstimated: local(3, 15, 0, m.tz),
        });
        const plan = createRegretPromptPolicy({ timeZone: m.tz }).plan(
          c,
          pctx(c, { locale: m.locale, features: features(c, m.tz, m.typical) }),
        )!;
        const weekday = new Intl.DateTimeFormat(m.locale, { weekday: "long", timeZone: m.tz }).format(new Date(c.timestampEstimated));
        expect(plan.prompt).toBe(`That ${formatMoney(c.amount!.value, m.locale)} purchase from ${weekday} — still happy you bought it?`);
        expect(localParts(plan.askAt, m.tz).hour).toBe(19);
        expect(toneIssues(plan.prompt)).toEqual([]);
      }
    });

    it("formats prompt text directly for the orchestrator", () => {
      const c = gadget();
      expect(regretPromptText(c, local(5, 19), "en-IN", IST)).toBe("That ₹6,200 purchase from Saturday — still happy you bought it?");
      expect(regretPromptText(gadget({ amount: null }), local(5, 19), "en-IN", IST)).toBe(
        "That purchase from Saturday — still happy you bought it?",
      );
      for (const o of SATISFACTION_OPTIONS) expect(toneIssues(o.label)).toEqual([]);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Review regressions                                                  */
/* ------------------------------------------------------------------ */

describe("review regressions", () => {
  it("plans a late discovery for the morning after quiet hours when the window is still open", () => {
    const c = gadget(); // Saturday 14:00; the 72 h window closes Tuesday 14:00
    const plan = policy().plan(c, pctx(c, { now: local(5, 22, 30) }))!; // discovered Monday 22:30, in quiet hours
    expect(plan).not.toBeNull();
    expect(plan.askAt).toBe(local(6, 8)); // Tuesday 08:00, when quiet hours end
    expect(plan.askAt - c.timestampEstimated).toBeLessThanOrEqual(72 * HOUR);
    // Custom quiet hours end at their own hour.
    expect(policy({ quietHours: { from: 21, to: 9 } }).plan(c, pctx(c, { now: local(5, 22, 30) }))!.askAt).toBe(local(6, 9));
    // Still silent when the window closes before quiet hours end.
    const late = gadget({ timestampEstimated: local(3, 6) }); // window closes Tuesday 06:00
    expect(policy().explain(late, pctx(late, { now: local(5, 23) }))).toEqual({ plan: null, blockedBy: "no_slot" });
  });

  it("keeps ~19:00 local across a daylight-saving change", () => {
    const tz = "America/New_York"; // clocks go back on Sunday 1 November 2026
    const c = dinner({
      id: "cand_ny_dinner",
      amount: { value: money(8_500, "USD"), confidence: 0.99 },
      paymentRail: { family: "card", scheme: "visa" },
      timestampEstimated: local(31, 15, 0, tz),
    });
    const plan = createRegretPromptPolicy({ timeZone: tz }).plan(c, pctx(c, { locale: "en-US", features: features(c, tz, 4_000) }))!;
    expect(localParts(plan.askAt, tz)).toMatchObject({ month: 11, day: 1, hour: 19, minute: 0 });
    expect(plan.askAt - c.timestampEstimated).toBe(29 * HOUR); // 28 wall-clock hours + the repeated hour
    expect(plan.prompt).toBe("That $85 purchase from Saturday — still happy you bought it?");
  });

  it("never asks whether a gift was worth it (gifts distort personal regret)", () => {
    const gift = gadget({ category: inference<CategoryId>("gifts", 0.9) });
    expect(policy().explain(gift, pctx(gift))).toEqual({ plan: null, blockedBy: "not_personal" });
  });
});
