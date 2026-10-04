import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE, defaultAttributes, formatMoney, money, unknownInference, zonedTimeToEpoch } from "@brake/core";
import type {
  Budget,
  CandidateLink,
  Essentiality,
  Goal,
  Reference,
  TransactionCandidate,
  TransactionType,
  TransferKind,
} from "@brake/core";
import { inference, makeCandidate } from "@brake/core/testing";
import type { Insight, InsightContext, RecurringAlert, RecurringFindings, RecurringSeries } from "../src/contracts";
import { toneIssues } from "../src/copy";
import { applicableBudgets, budgetStatus, createInsightEngine, rankInsights, wholeUnits } from "../src/insights";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const IN = { tz: "Asia/Kolkata", locale: "en-IN" } as const;
const US = { tz: "America/New_York", locale: "en-US" } as const;
const IE = { tz: "Europe/Dublin", locale: "en-IE" } as const;
const BR = { tz: "America/Sao_Paulo", locale: "pt-BR" } as const;
const KE = { tz: "Africa/Nairobi", locale: "en-KE" } as const;

/** Thursday 2026-10-08 18:00 IST (week starts Monday 5 Oct, month 1 Oct). */
const NOW_IN = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 18, minute: 0, second: 0 }, IN.tz);

interface Buy {
  id?: string;
  minor: number;
  currency?: string;
  at: number;
  merchant?: string;
  category?: string;
  categoryConfidence?: number;
  confidence?: number;
  status?: TransactionCandidate["status"];
  direction?: "debit" | "credit";
  type?: TransactionType;
  transferKind?: TransferKind;
  references?: Reference[];
  links?: CandidateLink[];
  essentiality?: Essentiality;
  essentialityUserSet?: boolean;
}

/** A purchase-like candidate. Defaults: posted, certain purchase, uncategorized. */
function buy(p: Buy): TransactionCandidate {
  const attrs = defaultAttributes();
  return makeCandidate({
    ...(p.id ? { id: p.id } : {}),
    minor: p.minor,
    currency: p.currency ?? "INR",
    timestampEstimated: p.at,
    status: p.status ?? "posted",
    direction: p.direction ?? "debit",
    merchant: p.merchant
      ? { raw: p.merchant.toUpperCase(), normalized: p.merchant.toLowerCase().replace(/\s+/g, "_"), displayName: p.merchant, confidence: 0.95, channel: "online" }
      : { raw: null, normalized: null, displayName: null, confidence: 0, channel: "unknown" },
    category: p.category ? inference(p.category, p.categoryConfidence ?? 0.95) : unknownInference("uncategorized"),
    transactionType: inference(p.type ?? "purchase", 1),
    ...(p.transferKind ? { transferKind: p.transferKind } : {}),
    confidence: p.confidence ?? 1,
    references: p.references ?? [],
    links: p.links ?? [],
    attributes: p.essentiality
      ? {
          ...attrs,
          essentiality: { value: p.essentiality, confidence: 1, alternatives: [], basis: ["user_label"], userSet: p.essentialityUserSet ?? true },
        }
      : attrs,
  });
}

function ctx(p: Partial<InsightContext> & { region?: { tz: string; locale: string } } = {}): InsightContext {
  const { region, ...rest } = p;
  return {
    now: NOW_IN,
    locale: region?.locale ?? IN.locale,
    timeZone: region?.tz ?? IN.tz,
    history: [],
    budgets: [],
    goals: [],
    recurring: null,
    ...rest,
  };
}

const engine = createInsightEngine();

/** Every text BRAKE produces must pass the tone linter and never be a bare "You spent X." */
function expectGoodCopy(i: Insight | null | undefined): asserts i is Insight {
  expect(i).toBeTruthy();
  expect(toneIssues(i!.text)).toEqual([]);
  expect(i!.text).not.toMatch(/^\s*you spent/i);
}

function find(list: readonly Insight[], kind: Insight["kind"]): Insight | undefined {
  return list.find((i) => i.kind === kind);
}

const rs = (value: string, namespace = "upi"): Reference => ({ type: "rail_reference", value, namespace });

/* ------------------------------------------------------------------ */
/* category_pace                                                       */
/* ------------------------------------------------------------------ */

describe("category_pace", () => {
  /** Four previous weeks of ₹1,000 eating out by Wednesday, plus `earlier` this week. */
  function paceHistory(earlier: number, weeks = 4): TransactionCandidate[] {
    const h: TransactionCandidate[] = [];
    for (let w = 1; w <= weeks; w++) h.push(buy({ minor: 100_000, at: NOW_IN - w * 7 * DAY - DAY, merchant: "Zomato", category: "eating_out.restaurant" }));
    if (earlier > 0) h.push(buy({ minor: earlier, at: NOW_IN - 2 * DAY, merchant: "Zomato", category: "eating_out.restaurant" }));
    return h;
  }

  it("matches the brief: amount and merchant, then the pace against the usual", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery" });
    const i = engine.afterSpend(c, ctx({ history: paceHistory(88_000) }));
    expectGoodCopy(i);
    expect(i.kind).toBe("category_pace");
    expect(i.text).toBe("₹500 at Swiggy — Eating out spending this week is now 38% above your usual pace.");
    expect(i.data).toMatchObject({ period: "week", category: "eating_out", periodsOfHistory: 4 });
    expect(i.candidateId).toBe(c.id);
  });

  it("counts the candidate once even when history already contains it", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery" });
    const i = engine.afterSpend(c, ctx({ history: [...paceHistory(88_000), c] }));
    expect(i?.text).toContain("38% above your usual pace");
  });

  it("stays silent when the pace is less than 25% above usual", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery" });
    expect(engine.afterSpend(c, ctx({ history: paceHistory(70_000) }))).toBeNull();
  });

  it("needs at least three previous periods of history", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery" });
    expect(find(rankInsights(c, ctx({ history: paceHistory(88_000, 2) })), "category_pace")).toBeUndefined();
  });

  it("hedges for a medium-confidence purchase instead of stating it", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery", confidence: 0.7 });
    const i = engine.afterSpend(c, ctx({ history: paceHistory(100_000) }));
    expectGoodCopy(i);
    // "If so" conditions on the purchase: 1,000 + 500 = 1,500 against a usual 1,000.
    // (Weighting it by 0.7 would give 35%, a figure true in neither world.)
    expect(i.text).toBe(
      "Looks like you spent about ₹500 at Swiggy. If so, your Eating out spending this week is now about 50% above your usual pace.",
    );
  });

  it("counts a purchase it states as fact at its full amount", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery", confidence: 0.9 });
    const i = engine.afterSpend(c, ctx({ history: paceHistory(100_000) }));
    expectGoodCopy(i);
    expect(i.text).toBe("₹500 at Swiggy — Eating out spending this week is now 50% above your usual pace.");
  });

  it("does not let a tiny purchase carry a pace notice on its own", () => {
    const c = buy({ minor: 2_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery" });
    const c2 = ctx({ history: paceHistory(128_000) });
    expect(engine.afterSpend(c, c2)).toBeNull();
    const pace = find(rankInsights(c, c2), "category_pace");
    expect(pace).toBeDefined();
    expect(pace!.importance).toBeLessThan(0.5);
  });

  it("ignores an uncertain category rather than guessing whose pace it is", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery", categoryConfidence: 0.5 });
    expect(find(rankInsights(c, ctx({ history: paceHistory(88_000) })), "category_pace")).toBeUndefined();
  });

  it("uses the month when the week has no comparable history (USD, en-US)", () => {
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 20, hour: 12, minute: 0, second: 0 }, US.tz);
    const at = (m: number, d: number) => zonedTimeToEpoch({ year: 2026, month: m, day: d, hour: 12, minute: 0, second: 0 }, US.tz);
    const history = [7, 8, 9].map((m) => buy({ minor: 20_000, currency: "USD", at: at(m, 10), merchant: "Target", category: "shopping" }));
    history.push(buy({ minor: 15_000, currency: "USD", at: at(10, 5), merchant: "Target", category: "shopping" }));
    const c = buy({ minor: 13_000, currency: "USD", at: now - HOUR, merchant: "Best Buy", category: "shopping.electronics" });
    const i = engine.afterSpend(c, ctx({ now, region: US, history }));
    expectGoodCopy(i);
    expect(i.text).toBe("$130 at Best Buy — Shopping spending this month is now 40% above your usual pace.");
  });

  it("does not attribute a late-posting purchase from last week to this week's pace", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - 5 * DAY, merchant: "Swiggy", category: "eating_out.delivery" });
    expect(find(rankInsights(c, ctx({ history: paceHistory(88_000) })), "category_pace")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* budget_remaining                                                    */
/* ------------------------------------------------------------------ */

describe("budget_remaining", () => {
  const eatingOut: Budget = { category: "eating_out", limit: money(500_000, "INR"), period: "monthly" };

  /** Eating-out spending earlier this month (1 Oct onwards), split over two purchases. */
  function spent(total: number): TransactionCandidate[] {
    const half = Math.round(total / 2);
    return [
      buy({ minor: half, at: NOW_IN - 6 * DAY, merchant: "Zomato", category: "eating_out.restaurant" }),
      buy({ minor: total - half, at: NOW_IN - 2 * DAY, merchant: "Zomato", category: "eating_out.restaurant" }),
    ];
  }
  const swiggy = (p: Partial<Buy> = {}) => buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery", ...p });

  it("keeps quiet when plenty is left, but can show it at a lower gate", () => {
    const c = swiggy();
    const context = ctx({ history: spent(220_000), budgets: [eatingOut] });
    expect(engine.afterSpend(c, context)).toBeNull();
    const i = createInsightEngine({ minImportance: 0.3 }).afterSpend(c, context);
    expectGoodCopy(i);
    expect(i.text).toBe("₹2,300 left in your Eating out budget this month.");
  });

  it("speaks up when less than a quarter is left", () => {
    const i = engine.afterSpend(swiggy(), ctx({ history: spent(400_000), budgets: [eatingOut] }));
    expectGoodCopy(i);
    expect(i.kind).toBe("budget_remaining");
    expect(i.text).toBe("₹500 left in your Eating out budget this month.");
    expect(i.importance).toBeGreaterThan(0.7);
  });

  it("states an exceeded budget neutrally and ranks the crossing purchase highest", () => {
    const crossing = engine.afterSpend(swiggy(), ctx({ history: spent(490_000), budgets: [eatingOut] }));
    expectGoodCopy(crossing);
    expect(crossing.text).toBe("This puts Eating out ₹400 over this month's budget.");

    const alreadyOver = engine.afterSpend(swiggy(), ctx({ history: spent(520_000), budgets: [eatingOut] }));
    expectGoodCopy(alreadyOver);
    expect(alreadyOver.text).toBe("This puts Eating out ₹700 over this month's budget.");
    expect(alreadyOver.importance).toBeLessThan(crossing.importance);
  });

  it("notes when a purchase uses up exactly what was left", () => {
    const i = engine.afterSpend(swiggy(), ctx({ history: spent(450_000), budgets: [eatingOut] }));
    expect(i?.text).toBe("This uses up the rest of your Eating out budget for this month.");
  });

  it("hedges remaining budget for a medium-confidence purchase", () => {
    const i = engine.afterSpend(swiggy({ confidence: 0.7 }), ctx({ history: spent(400_000), budgets: [eatingOut] }));
    expectGoodCopy(i);
    // If the ₹500 purchase happened, ₹5,000 − ₹4,000 − ₹500 = ₹500 is left (not the 0.7-weighted ₹650).
    expect(i.text).toBe("Looks like you spent about ₹500 at Swiggy. If so, about ₹500 is left in your Eating out budget this month.");
  });

  it("never says '₹0 over' or '₹0 left' when the budget is used up to within a unit", () => {
    const usedUp = "This uses up the rest of your Eating out budget for this month.";
    // 30 paise over and 40 paise left: both read as "uses up the rest".
    expect(engine.afterSpend(swiggy(), ctx({ history: spent(450_030), budgets: [eatingOut] }))?.text).toBe(usedUp);
    expect(engine.afterSpend(swiggy(), ctx({ history: spent(449_960), budgets: [eatingOut] }))?.text).toBe(usedUp);
  });

  it("handles an overall weekly budget in USD", () => {
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 18, minute: 0, second: 0 }, US.tz);
    const overall: Budget = { limit: money(30_000, "USD"), period: "weekly" };
    const history = [buy({ minor: 20_000, currency: "USD", at: now - 2 * DAY, merchant: "Trader Joe's", category: "groceries" })];
    const c = buy({ minor: 4_500, currency: "USD", at: now - HOUR, merchant: "Chipotle", category: "eating_out.restaurant" });
    const i = engine.afterSpend(c, ctx({ now, region: US, history, budgets: [overall] }));
    expectGoodCopy(i);
    expect(i.text).toBe("$55 left in your budget this week.");
  });

  it("ignores budgets in another currency and budgets for other categories", () => {
    const eur: Budget = { category: "eating_out", limit: money(10_000, "EUR"), period: "monthly" };
    const shopping: Budget = { category: "shopping", limit: money(100_000, "INR"), period: "monthly" };
    const list = rankInsights(swiggy(), ctx({ history: spent(490_000), budgets: [eur, shopping] }));
    expect(find(list, "budget_remaining")).toBeUndefined();
  });

  it("applies only the overall budget when the category is uncertain", () => {
    const overall: Budget = { limit: money(1_000_000, "INR"), period: "monthly" };
    const c = swiggy({ categoryConfidence: 0.4 });
    expect(applicableBudgets(c, [eatingOut, overall])).toEqual([overall]);
  });

  it("orders category budgets before the overall budget and respects the hierarchy", () => {
    const overall: Budget = { limit: money(1_000_000, "INR"), period: "monthly" };
    const delivery: Budget = { category: "eating_out.delivery", limit: money(200_000, "INR"), period: "weekly" };
    const restaurants: Budget = { category: "eating_out.restaurant", limit: money(200_000, "INR"), period: "weekly" };
    expect(applicableBudgets(swiggy(), [overall, restaurants, delivery, eatingOut])).toEqual([delivery, eatingOut, overall]);
    // Most specific first whatever order the user created them in.
    expect(applicableBudgets(swiggy(), [eatingOut, overall, delivery])).toEqual([delivery, eatingOut, overall]);
  });

  it("budgetStatus reports spent, remaining and over in the budget currency", () => {
    const s = budgetStatus(eatingOut, spent(520_000), NOW_IN, IN.tz);
    expect(s.spent).toEqual(money(520_000, "INR"));
    expect(s.remaining.minor).toBe(0);
    expect(s.over).toEqual(money(20_000, "INR"));
    expect(s.periodStart).toBe(zonedTimeToEpoch({ year: 2026, month: 10, day: 1, hour: 0, minute: 0, second: 0 }, IN.tz));
  });

  it("wholeUnits rounds expectations to whole currency units", () => {
    expect(wholeUnits(money(229_947, "INR"))).toEqual(money(229_900, "INR"));
    expect(wholeUnits(money(229_960, "INR"))).toEqual(money(230_000, "INR"));
    expect(wholeUnits(money(1_249, "JPY"))).toEqual(money(1_249, "JPY"));
  });
});

/* ------------------------------------------------------------------ */
/* unusual_amount                                                      */
/* ------------------------------------------------------------------ */

describe("unusual_amount", () => {
  const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 13, minute: 0, second: 0 }, KE.tz);
  const javaHouse = (minor: number, daysAgo: number) => buy({ minor, currency: "KES", at: now - daysAgo * DAY, merchant: "Java House" });

  it("flags ≥3× the merchant median with three or more prior purchases (KES, M-Pesa)", () => {
    const history = [javaHouse(45_000, 30), javaHouse(50_000, 20), javaHouse(52_000, 10), javaHouse(48_000, 5)];
    const c = javaHouse(240_000, 0);
    const i = engine.afterSpend(c, ctx({ now, region: KE, history }));
    expectGoodCopy(i);
    expect(i.kind).toBe("unusual_amount");
    const ksh = (minor: number) => formatMoney(money(minor, "KES"), KE.locale);
    expect(i.text).toBe(`${ksh(240_000)} at Java House — about 5× your usual ${ksh(49_000)} there.`);
    expect(i.text).toMatch(/^Ksh\s2,400/);
    expect(i.data).toMatchObject({ priorPurchases: 4 });
  });

  it("needs three prior purchases at the merchant", () => {
    const c = javaHouse(240_000, 0);
    expect(find(rankInsights(c, ctx({ now, region: KE, history: [javaHouse(45_000, 30), javaHouse(50_000, 20)] })), "unusual_amount")).toBeUndefined();
  });

  it("needs at least three times the usual amount", () => {
    const history = [javaHouse(50_000, 30), javaHouse(50_000, 20), javaHouse(50_000, 10)];
    expect(find(rankInsights(javaHouse(145_000, 0), ctx({ now, region: KE, history })), "unusual_amount")).toBeUndefined();
    // Exactly 3× qualifies.
    expect(find(rankInsights(javaHouse(150_000, 0), ctx({ now, region: KE, history })), "unusual_amount")).toBeDefined();
  });

  it("writes the multiple in the user's locale (BRL, pt-BR)", () => {
    const brNow = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 9, minute: 0, second: 0 }, BR.tz);
    const padaria = (minor: number, daysAgo: number) => buy({ minor, currency: "BRL", at: brNow - daysAgo * DAY, merchant: "Padaria Real" });
    const history = [padaria(10_000, 21), padaria(10_000, 14), padaria(10_000, 7)];
    const i = engine.afterSpend(padaria(45_000, 0), ctx({ now: brNow, region: BR, history }));
    expectGoodCopy(i);
    const brl = (minor: number) => formatMoney(money(minor, "BRL"), BR.locale);
    expect(i.text).toBe(`${brl(45_000)} at Padaria Real — about 4,5× your usual ${brl(10_000)} there.`);
  });

  it("stays silent when the difference is immaterial for this user", () => {
    const chai = (minor: number, daysAgo: number) => buy({ minor, at: NOW_IN - daysAgo * DAY, merchant: "Chai Point" });
    const others = [1, 2, 3, 4, 5].map((d) => buy({ minor: 30_000, at: NOW_IN - d * DAY - HOUR, merchant: "BigBasket" }));
    const context = ctx({ history: [chai(1_000, 3), chai(1_000, 2), chai(1_000, 1), ...others] });
    const c = chai(3_000, 0);
    expect(engine.afterSpend(c, context)).toBeNull();
    expect(find(rankInsights(c, context), "unusual_amount")!.importance).toBeLessThan(0.5);
  });
});

/* ------------------------------------------------------------------ */
/* possible_duplicate_charge                                           */
/* ------------------------------------------------------------------ */

describe("possible_duplicate_charge", () => {
  const first = buy({ minor: 124_900, at: NOW_IN - 3 * MINUTE, merchant: "Amazon", references: [rs("RRN-1")] });

  it("asks when the same merchant charged the same amount twice within minutes, with distinct references", () => {
    const second = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-2")] });
    const i = engine.afterSpend(second, ctx({ history: [first] }));
    expectGoodCopy(i);
    expect(i.kind).toBe("possible_duplicate_charge");
    expect(i.text).toBe("Were you charged twice? There appear to be two ₹1,249 charges at Amazon 3 minutes apart.");
    expect(i.data).toMatchObject({ otherCandidateId: first.id, minutesApart: 3 });
  });

  it("is the one insight a low-confidence candidate can get, phrased as a question", () => {
    const second = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-2")], confidence: 0.5, category: "shopping" });
    const goals: Goal[] = [{ id: "g", name: "Goa trip", target: money(1_000_000, "INR"), saved: money(0, "INR") }];
    const list = rankInsights(second, ctx({ history: [first], goals }));
    expect(list.map((i) => i.kind)).toEqual(["possible_duplicate_charge"]);
    expect(list[0]!.text).toMatch(/\?/);
  });

  it("outranks a budget crossing", () => {
    const budget: Budget = { limit: money(200_000, "INR"), period: "monthly" };
    const second = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-2")] });
    const i = engine.afterSpend(second, ctx({ history: [first], budgets: [budget] }));
    expect(i?.kind).toBe("possible_duplicate_charge");
  });

  it("does not fire for one event seen twice (shared reference)", () => {
    const second = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-1"), { type: "order_id", value: "402-1" }] });
    expect(engine.afterSpend(second, ctx({ history: [first] }))).toBeNull();
  });

  it("does not fire without proof the charges are distinct", () => {
    const noRefs = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon" });
    expect(engine.afterSpend(noRefs, ctx({ history: [first] }))).toBeNull();
    const otherKind = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [{ type: "order_id", value: "402-9" }] });
    expect(engine.afterSpend(otherKind, ctx({ history: [first] }))).toBeNull();
  });

  it("requires the same amount, merchant and a ten-minute window", () => {
    const later = buy({ minor: 124_900, at: NOW_IN + 8 * MINUTE, merchant: "Amazon", references: [rs("RRN-2")] });
    expect(engine.afterSpend(later, ctx({ now: NOW_IN + 8 * MINUTE, history: [first] }))).toBeNull();
    const otherAmount = buy({ minor: 124_800, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-2")] });
    expect(engine.afterSpend(otherAmount, ctx({ history: [first] }))).toBeNull();
    const otherMerchant = buy({ minor: 124_900, at: NOW_IN, merchant: "Flipkart", references: [rs("RRN-2")] });
    expect(engine.afterSpend(otherMerchant, ctx({ history: [first] }))).toBeNull();
  });

  it("warns once per pair (on the later charge) and ignores cancelled charges", () => {
    const second = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-2")] });
    expect(engine.afterSpend(first, ctx({ history: [second] }))).toBeNull();
    const voided = { ...first, status: "cancelled" as const };
    expect(engine.afterSpend(second, ctx({ history: [voided] }))).toBeNull();
  });

  it("includes the ten-minute boundary", () => {
    const tenLater = buy({ minor: 124_900, at: NOW_IN + 7 * MINUTE, merchant: "Amazon", references: [rs("RRN-2")] });
    expect(engine.afterSpend(tenLater, ctx({ now: NOW_IN + 7 * MINUTE, history: [first] }))?.data).toMatchObject({ minutesApart: 10 });
  });

  it("still asks when both charges share a mandate or subscription id (a recurring debit taken twice)", () => {
    const mandate: Reference = { type: "mandate_id", value: "UMN-GYM-01", namespace: "upi" };
    const sub: Reference = { type: "subscription_id", value: "sub_9", namespace: "gym" };
    const a = buy({ minor: 199_900, at: NOW_IN - 2 * MINUTE, merchant: "Cult Fit", references: [rs("RRN-A"), mandate, sub] });
    const b = buy({ minor: 199_900, at: NOW_IN, merchant: "Cult Fit", references: [rs("RRN-B"), mandate, sub] });
    const i = engine.afterSpend(b, ctx({ history: [a] }));
    expect(i?.kind).toBe("possible_duplicate_charge");
    expect(i?.text).toBe("Were you charged twice? There appear to be two ₹1,999 charges at Cult Fit 2 minutes apart.");
  });

  it("warns on whichever charge arrives second, even when the earlier charge is reported late", () => {
    const later = buy({ id: "cand_later", minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [rs("RRN-2")] });
    const lateReport = { ...buy({ id: "cand_late_report", minor: 124_900, at: NOW_IN - 3 * MINUTE, merchant: "Amazon", references: [rs("RRN-1")] }), createdAt: NOW_IN + 20 * MINUTE };
    const now = NOW_IN + 20 * MINUTE;
    // The later charge arrived first, alone: nothing to compare with.
    expect(engine.afterSpend(later, ctx({ now, history: [] }))).toBeNull();
    const i = engine.afterSpend(lateReport, ctx({ now, history: [later] }));
    expect(i?.kind).toBe("possible_duplicate_charge");
    expect(i?.data).toMatchObject({ otherCandidateId: "cand_later", minutesApart: 3 });
    // Still once per pair.
    expect(engine.afterSpend(later, ctx({ now, history: [lateReport] }))).toBeNull();
  });

  it("compares references the way fusion does: case, spacing and namespace case do not make two events", () => {
    const sameRef = buy({ minor: 124_900, at: NOW_IN, merchant: "Amazon", references: [{ type: "rail_reference", value: " rrn-1", namespace: "UPI" }] });
    expect(engine.afterSpend(sameRef, ctx({ history: [first] }))).toBeNull();
  });

  it("does not mistake an unmerged pending/posted pair for two charges (USD card)", () => {
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 18, minute: 0, second: 0 }, US.tz);
    const ledger = (value: string): Reference => ({ type: "provider_transaction_id", value, namespace: "bank" });
    const pending = buy({ minor: 4_999, currency: "USD", at: now - 2 * MINUTE, status: "pending", merchant: "Uber Eats", references: [ledger("pend-77")] });
    const posted = buy({
      minor: 4_999,
      currency: "USD",
      at: now,
      merchant: "Uber Eats",
      references: [ledger("post-91"), { type: "provider_pending_id", value: "pend-77", namespace: "bank" }],
    });
    expect(engine.afterSpend(posted, ctx({ now, region: US, history: [pending] }))).toBeNull();
  });

  it("does not claim minutes between charges whose time of day is unknown (date-only ledger dates)", () => {
    const ledger = (value: string): Reference => ({ type: "provider_transaction_id", value, namespace: "bank" });
    const localMidnight = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 0, minute: 0, second: 0 }, IN.tz);
    const a = buy({ id: "cand_a", minor: 25_000, at: localMidnight, merchant: "Starbucks", references: [ledger("T1")] });
    const b = buy({ id: "cand_b", minor: 25_000, at: localMidnight, merchant: "Starbucks", references: [ledger("T2")] });
    expect(engine.afterSpend(b, ctx({ history: [a] }))).toBeNull();
    const utcMidnight = Date.UTC(2026, 9, 8);
    const c = buy({ id: "cand_c", minor: 25_000, at: utcMidnight, merchant: "Starbucks", references: [ledger("T3")] });
    const d = buy({ id: "cand_d", minor: 25_000, at: utcMidnight, merchant: "Starbucks", references: [ledger("T4")] });
    expect(engine.afterSpend(d, ctx({ history: [c] }))).toBeNull();
  });

  it("never echoes a raw payment descriptor (it can carry phone numbers or handles)", () => {
    const raw = { raw: "UPI/P2M/9876543210/KIRANA", normalized: null, displayName: null, confidence: 0.4, channel: "in_store" as const };
    const a = { ...buy({ minor: 45_000, at: NOW_IN - 2 * MINUTE, references: [rs("R-1")] }), merchant: raw };
    const b = { ...buy({ minor: 45_000, at: NOW_IN, references: [rs("R-2")] }), merchant: raw };
    const i = engine.afterSpend(b, ctx({ history: [a] }));
    expectGoodCopy(i);
    expect(i.text).toBe("Were you charged twice? There appear to be two ₹450 charges 2 minutes apart.");
    expect(i.text).not.toContain("9876543210");
  });

  it("says 'within a minute' for near-simultaneous charges (USD card)", () => {
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 18, minute: 0, second: 0 }, US.tz);
    const ref = (v: string): Reference => ({ type: "rail_reference", value: v, namespace: "visa" });
    const a = buy({ minor: 4_999, currency: "USD", at: now - 20_000, merchant: "Uber Eats", references: [ref("A")] });
    const b = buy({ minor: 4_999, currency: "USD", at: now, merchant: "Uber Eats", references: [ref("B")] });
    const i = engine.afterSpend(b, ctx({ now, region: US, history: [a] }));
    expect(i?.text).toBe("Were you charged twice? There appear to be two $49.99 charges at Uber Eats within a minute of each other.");
  });
});

/* ------------------------------------------------------------------ */
/* refund_tracked                                                      */
/* ------------------------------------------------------------------ */

describe("refund_tracked", () => {
  const purchaseAt = zonedTimeToEpoch({ year: 2026, month: 10, day: 2, hour: 11, minute: 0, second: 0 }, IN.tz);
  const original = buy({ id: "cand_amazon_order", minor: 124_900, at: purchaseAt, merchant: "Amazon", category: "shopping" });
  const refund = (minor: number, probability = 0.95, target = original.id) =>
    buy({
      minor,
      at: NOW_IN - HOUR,
      merchant: "Amazon",
      direction: "credit",
      type: "refund",
      links: [{ kind: "refund_of", target, probability, createdAt: NOW_IN }],
    });

  it("matches the brief's wording", () => {
    const i = engine.afterSpend(refund(124_900), ctx({ history: [original] }));
    expectGoodCopy(i);
    expect(i.kind).toBe("refund_tracked");
    expect(i.text).toBe("Refund of ₹1,249 from Amazon matched to your 2 Oct purchase.");
    expect(i.data).toMatchObject({ originalCandidateId: original.id, partial: false });
  });

  it("mentions the original amount for a partial refund (EUR, SEPA)", () => {
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 12, minute: 0, second: 0 }, IE.tz);
    const orig = buy({ id: "cand_zalando", minor: 8_999, currency: "EUR", at: now - 6 * DAY, merchant: "Zalando", category: "shopping.clothing" });
    const credit = buy({
      minor: 3_000,
      currency: "EUR",
      at: now - HOUR,
      merchant: "Zalando",
      direction: "credit",
      type: "refund",
      links: [{ kind: "refund_of", target: orig.id, probability: 0.9, createdAt: now }],
    });
    const i = engine.afterSpend(credit, ctx({ now, region: IE, history: [orig] }));
    expectGoodCopy(i);
    expect(i.text).toBe("Refund of €30 from Zalando matched to your 2 Oct purchase of €89.99.");
    expect(i.data).toMatchObject({ partial: true });
  });

  it("hedges a weak reconciliation link", () => {
    const i = engine.afterSpend(refund(124_900, 0.6), ctx({ history: [original] }));
    expectGoodCopy(i);
    expect(i.text).toBe("Looks like ₹1,249 from Amazon is a refund for your 2 Oct purchase.");
  });

  it("still closes the loop when the original is not in history", () => {
    const i = engine.afterSpend(refund(124_900, 0.95, "cand_missing"), ctx({ history: [] }));
    expect(i?.text).toBe("Refund of ₹1,249 from Amazon matched to an earlier purchase.");
  });

  it("stays silent when the match to a purchase is itself a guess", () => {
    expect(engine.afterSpend(refund(124_900, 0.4), ctx({ history: [original] }))).toBeNull();
    expect(engine.afterSpend(refund(124_900, 0.6), ctx({ history: [original] }))?.text).toMatch(/^Looks like/);
  });

  it("says nothing about a credit with no refund link", () => {
    const credit = buy({ minor: 124_900, at: NOW_IN - HOUR, merchant: "Amazon", direction: "credit", type: "refund" });
    expect(engine.afterSpend(credit, ctx({ history: [original] }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* recurring: new_subscription / price_increase / upcoming_renewal      */
/* ------------------------------------------------------------------ */

describe("recurring alerts", () => {
  const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 9, minute: 0, second: 0 }, US.tz);
  const charge = buy({ id: "cand_netflix_oct", minor: 2_299, currency: "USD", at: now - HOUR, merchant: "Netflix", category: "entertainment.streaming" });

  function series(p: Partial<RecurringSeries> = {}): RecurringSeries {
    return {
      id: "series_netflix",
      merchantKey: "netflix",
      displayName: "Netflix",
      cadence: "monthly",
      periodDays: 30,
      typicalAmount: money(2_299, "USD"),
      amountVariation: 0.05,
      memberIds: [charge.id],
      firstChargeAt: now - 120 * DAY,
      lastChargeAt: now - HOUR,
      nextExpectedAt: now + 30 * DAY,
      nextExpectedAmount: money(2_299, "USD"),
      subscriptionProbability: 0.95,
      status: "active",
      priceHistory: [],
      confidence: 0.9,
      ...p,
    };
  }
  function findings(s: RecurringSeries, alerts: RecurringAlert[]): RecurringFindings {
    return { series: [s], alerts, patches: new Map() };
  }
  const context = (recurring: RecurringFindings) => ctx({ now, region: US, recurring });

  it("price_increase: names the old and new price", () => {
    const alert: RecurringAlert = { kind: "price_increase", seriesId: "series_netflix", at: now, amount: money(2_299, "USD"), previousAmount: money(1_999, "USD"), confidence: 0.9 };
    const i = engine.afterSpend(charge, context(findings(series(), [alert])));
    expectGoodCopy(i);
    expect(i.kind).toBe("price_increase");
    expect(i.text).toBe("Netflix now costs $22.99 a month, up from $19.99.");
  });

  it("new_subscription: says it looks like one, with its cadence", () => {
    const alert: RecurringAlert = { kind: "new_subscription", seriesId: "series_netflix", at: now, amount: money(2_299, "USD"), confidence: 0.85 };
    const i = engine.afterSpend(charge, context(findings(series(), [alert])));
    expectGoodCopy(i);
    expect(i.text).toBe("Netflix looks like a new subscription at $22.99 a month.");
  });

  it("new_subscription: a less certain detection says 'might be'", () => {
    const alert: RecurringAlert = { kind: "new_subscription", seriesId: "series_netflix", at: now, confidence: 0.5 };
    const i = rankInsights(charge, context(findings(series({ cadence: "annual" }), [alert])))[0];
    expect(i?.text).toBe("Netflix might be a new subscription at $22.99 a year.");
  });

  it("upcoming_renewal: uses relative days in the user's zone", () => {
    const alert: RecurringAlert = { kind: "upcoming_renewal", seriesId: "series_netflix", at: now, amount: money(2_299, "USD"), confidence: 0.9 };
    const tomorrow = engine.afterSpend(charge, context(findings(series({ nextExpectedAt: now + DAY }), [alert])));
    expectGoodCopy(tomorrow);
    expect(tomorrow.text).toBe("Netflix renews tomorrow for $22.99.");
    const later = rankInsights(charge, context(findings(series({ nextExpectedAt: now + 9 * DAY }), [alert])))[0];
    expect(later?.text).toBe("Netflix renews on Oct 17 for $22.99.");
  });

  it("words alerts by the shared confidence tiers: only ≥ 0.85 is stated flatly", () => {
    const rise = (confidence: number): RecurringAlert => ({
      kind: "price_increase",
      seriesId: "series_netflix",
      at: now,
      amount: money(2_299, "USD"),
      previousAmount: money(1_999, "USD"),
      confidence,
    });
    const text = (alert: RecurringAlert, s = series()) => rankInsights(charge, context(findings(s, [alert])))[0]?.text;
    expect(text(rise(0.75))).toBe("Looks like Netflix now costs $22.99 a month, up from $19.99.");
    expect(text(rise(0.5))).toBe("Netflix may now cost $22.99 a month, up from $19.99.");
    const renewal = (confidence: number): RecurringAlert => ({ kind: "upcoming_renewal", seriesId: "series_netflix", at: now + DAY, confidence });
    const soon = series({ nextExpectedAt: now + DAY });
    expect(text(renewal(0.9), soon)).toBe("Netflix renews tomorrow for $22.99.");
    expect(text(renewal(0.75), soon)).toBe("Netflix looks set to renew tomorrow for $22.99.");
    expect(text(renewal(0.5), soon)).toBe("Netflix may renew tomorrow for $22.99.");
    for (const c of [0.5, 0.75, 0.9]) {
      expect(toneIssues(text(rise(c))!)).toEqual([]);
      expect(toneIssues(text(renewal(c), soon)!)).toEqual([]);
    }
  });

  it("follows recurring_series links as well as member ids", () => {
    const linked = { ...charge, id: "cand_other", links: [{ kind: "recurring_series" as const, target: "series_netflix", probability: 0.9, createdAt: now }] };
    const alert: RecurringAlert = { kind: "price_increase", seriesId: "series_netflix", at: now, amount: money(2_299, "USD"), previousAmount: money(1_999, "USD"), confidence: 0.9 };
    expect(engine.afterSpend(linked, context(findings(series(), [alert])))?.kind).toBe("price_increase");
  });

  it("does not repeat a price increase or new subscription that was news on an earlier charge", () => {
    // The detector keeps these alerts alive for about a period; last month's step is not news on this charge.
    const step = now - 31 * DAY;
    const rise: RecurringAlert = { kind: "price_increase", seriesId: "series_netflix", at: step, amount: money(2_299, "USD"), previousAmount: money(1_999, "USD"), confidence: 0.9 };
    const fresh: RecurringAlert = { kind: "new_subscription", seriesId: "series_netflix", at: step, amount: money(2_299, "USD"), confidence: 0.9 };
    expect(rankInsights(charge, context(findings(series(), [rise, fresh])))).toEqual([]);
  });

  it("keeps a far-off renewal under the gate: only a renewal within three days is actionable", () => {
    const alert: RecurringAlert = { kind: "upcoming_renewal", seriesId: "series_netflix", at: now + 30 * DAY, amount: money(2_299, "USD"), confidence: 0.9 };
    const c = context(findings(series({ nextExpectedAt: now + 30 * DAY }), [alert]));
    expect(engine.afterSpend(charge, c)).toBeNull();
    expect(find(rankInsights(charge, c), "upcoming_renewal")!.importance).toBeLessThan(0.5);
  });

  it("does not claim a rise the amounts contradict, nor compare prices across currencies", () => {
    const down: RecurringAlert = { kind: "price_increase", seriesId: "series_netflix", at: now, amount: money(1_999, "USD"), previousAmount: money(2_299, "USD"), confidence: 0.9 };
    expect(find(rankInsights(charge, context(findings(series(), [down]))), "price_increase")).toBeUndefined();
    const fx: RecurringAlert = { kind: "price_increase", seriesId: "series_netflix", at: now, amount: money(2_299, "USD"), previousAmount: money(1_799, "EUR"), confidence: 0.9 };
    expect(find(rankInsights(charge, context(findings(series(), [fx]))), "price_increase")?.text).toBe("Netflix's price went up to $22.99 a month.");
  });

  it("ignores alerts about other series and candidates outside any series", () => {
    const alert: RecurringAlert = { kind: "price_increase", seriesId: "series_spotify", at: now, amount: money(1_199, "USD"), previousAmount: money(1_099, "USD"), confidence: 0.9 };
    expect(engine.afterSpend(charge, context(findings(series(), [alert])))).toBeNull();
    const outsider = { ...charge, id: "cand_unrelated" };
    const own: RecurringAlert = { ...alert, seriesId: "series_netflix" };
    expect(engine.afterSpend(outsider, context(findings(series(), [own])))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* goal_impact                                                         */
/* ------------------------------------------------------------------ */

describe("goal_impact", () => {
  const goa: Goal = { id: "goal_goa", name: "Goa trip", target: money(6_000_000, "INR"), saved: money(1_000_000, "INR") };

  it("relates a discretionary purchase to what's left for a goal", () => {
    const c = buy({ minor: 600_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics" });
    const i = engine.afterSpend(c, ctx({ goals: [goa] }));
    expectGoodCopy(i);
    expect(i.kind).toBe("goal_impact");
    expect(i.text).toBe("₹6,000 at Croma — that's 12% of what's left for Goa trip.");
  });

  it("formats BRL for pt-BR (Pix)", () => {
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 15, minute: 0, second: 0 }, BR.tz);
    const goal: Goal = { id: "goal_ssa", name: "Viagem para Salvador", target: money(1_000_000, "BRL"), saved: money(400_000, "BRL") };
    const c = buy({ minor: 72_000, currency: "BRL", at: now - HOUR, merchant: "Magazine Luiza", category: "shopping.electronics" });
    const i = engine.afterSpend(c, ctx({ now, region: BR, goals: [goal] }));
    expectGoodCopy(i);
    expect(i.text).toBe(`${formatMoney(money(72_000, "BRL"), "pt-BR")} at Magazine Luiza — that's 12% of what's left for Viagem para Salvador.`);
    expect(i.text).toMatch(/^R\$\s720 at/);
  });

  it("never applies to essentials, small shares, other currencies or reached goals", () => {
    const groceries = buy({ minor: 600_000, at: NOW_IN - HOUR, merchant: "BigBasket", category: "groceries" });
    expect(find(rankInsights(groceries, ctx({ goals: [goa] })), "goal_impact")).toBeUndefined();

    const labelledEssential = buy({ minor: 600_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics", essentiality: "essential" });
    expect(find(rankInsights(labelledEssential, ctx({ goals: [goa] })), "goal_impact")).toBeUndefined();

    const small = buy({ minor: 200_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics" });
    expect(find(rankInsights(small, ctx({ goals: [goa] })), "goal_impact")).toBeUndefined();

    const usdGoal: Goal = { ...goa, target: money(500_000, "USD"), saved: money(0, "USD") };
    const c = buy({ minor: 600_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics" });
    expect(find(rankInsights(c, ctx({ goals: [usdGoal] })), "goal_impact")).toBeUndefined();

    const reached: Goal = { ...goa, saved: goa.target };
    expect(find(rankInsights(c, ctx({ goals: [reached] })), "goal_impact")).toBeUndefined();
  });

  it("includes the 5% boundary and never rounds a share below 100% up to '100%'", () => {
    const fivePct = buy({ minor: 250_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics" });
    expect(engine.afterSpend(fivePct, ctx({ goals: [goa] }))?.text).toBe("₹2,500 at Croma — that's 5% of what's left for Goa trip.");
    const almost = buy({ minor: 4_980_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics" });
    expect(engine.afterSpend(almost, ctx({ goals: [goa] }))?.text).toBe("₹49,800 at Croma — that's nearly all of what's left for Goa trip.");
  });

  it("does not echo a goal name that would read as scolding, and handles a purchase above what's left", () => {
    const harsh: Goal = { id: "g2", name: "Stop wasting money", target: money(1_000_000, "INR"), saved: money(900_000, "INR") };
    const c = buy({ minor: 150_000, at: NOW_IN - HOUR, merchant: "Croma", category: "shopping.electronics" });
    const i = engine.afterSpend(c, ctx({ goals: [harsh] }));
    expectGoodCopy(i);
    expect(i.text).toBe("₹1,500 at Croma — that's more than what's left for your goal.");
  });
});

/* ------------------------------------------------------------------ */
/* Gating, selection, silence                                          */
/* ------------------------------------------------------------------ */

describe("gating and selection", () => {
  const bigBudgetCrossing = () => ({
    history: [buy({ minor: 490_000, at: NOW_IN - DAY, merchant: "Zomato", category: "eating_out" })],
    budgets: [{ category: "eating_out", limit: money(500_000, "INR"), period: "monthly" } as Budget],
  });

  it("says nothing for an ordinary purchase with no meaningful context", () => {
    const c = buy({ minor: 25_000, at: NOW_IN - HOUR, merchant: "Starbucks", category: "eating_out.cafe" });
    expect(engine.afterSpend(c, ctx())).toBeNull();
    expect(rankInsights(c, ctx())).toEqual([]);
  });

  it("only speaks after confirmed or posted spending", () => {
    const base = { minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out" };
    for (const status of ["intent", "pending", "cancelled", "unknown"] as const) {
      expect(engine.afterSpend(buy({ ...base, status }), ctx(bigBudgetCrossing()))).toBeNull();
    }
    expect(engine.afterSpend(buy({ ...base, status: "confirmed" }), ctx(bigBudgetCrossing()))).not.toBeNull();
  });

  it("never treats transfers, card bills or investments as purchases", () => {
    const base = { minor: 5_000_000, at: NOW_IN - HOUR, category: "eating_out" };
    const transfer = buy({ ...base, type: "transfer", transferKind: "own_account" });
    const cardBill = buy({ ...base, type: "credit_card_payment" });
    const sip = buy({ ...base, type: "investment" });
    for (const c of [transfer, cardBill, sip]) expect(engine.afterSpend(c, ctx(bigBudgetCrossing()))).toBeNull();
  });

  it("gives low-confidence candidates nothing but a duplicate question", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out", confidence: 0.55 });
    expect(rankInsights(c, ctx(bigBudgetCrossing()))).toEqual([]);
  });

  it("returns the single most important insight", () => {
    const history: TransactionCandidate[] = [];
    for (let w = 1; w <= 4; w++) history.push(buy({ minor: 100_000, at: NOW_IN - w * 7 * DAY - DAY, category: "eating_out" }));
    history.push(buy({ minor: 330_000, at: NOW_IN - 2 * DAY, category: "eating_out" }));
    const budgets: Budget[] = [{ category: "eating_out", limit: money(380_000, "INR"), period: "monthly" }];
    const c = buy({ minor: 100_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out.delivery" });
    const all = rankInsights(c, ctx({ history, budgets }));
    expect(all.map((i) => i.kind)).toEqual(expect.arrayContaining(["budget_remaining", "category_pace"]));
    const best = engine.afterSpend(c, ctx({ history, budgets }));
    expect(best?.kind).toBe("budget_remaining");
    expect(best?.text).toBe("This puts Eating out ₹500 over this month's budget.");
    for (let k = 1; k < all.length; k++) expect(all[k - 1]!.importance).toBeGreaterThanOrEqual(all[k]!.importance);
  });

  it("is deterministic: same input, same insight and id", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out" });
    const a = engine.afterSpend(c, ctx(bigBudgetCrossing()));
    const b = engine.afterSpend(c, ctx(bigBudgetCrossing()));
    expect(a).toEqual(b);
    expect(a?.id).toMatch(/^insight_/);
  });

  it("clamps the importance gate", () => {
    const c = buy({ minor: 50_000, at: NOW_IN - HOUR, merchant: "Swiggy", category: "eating_out" });
    expect(createInsightEngine({ minImportance: 5 }).afterSpend(c, ctx(bigBudgetCrossing()))).toBeNull();
    expect(createInsightEngine({ minImportance: -1 }).afterSpend(c, ctx({}))).toBeNull();
  });
});

describe("tone across every insight kind and locale", () => {
  it("never scolds and never restates the purchase alone", () => {
    const texts: string[] = [];
    const regions = [
      { region: IN, currency: "INR" },
      { region: US, currency: "USD" },
      { region: IE, currency: "EUR" },
      { region: BR, currency: "BRL" },
      { region: KE, currency: "KES" },
    ];
    for (const { region, currency } of regions) {
      const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 18, minute: 0, second: 0 }, region.tz);
      const history: TransactionCandidate[] = [];
      for (let w = 1; w <= 4; w++) history.push(buy({ minor: 100_000, currency, at: now - w * 7 * DAY - DAY, merchant: "Shop", category: "shopping" }));
      for (let k = 1; k <= 3; k++) history.push(buy({ minor: 20_000, currency, at: now - k * DAY, merchant: "Shop", category: "shopping" }));
      const budgets: Budget[] = [{ category: "shopping", limit: money(200_000, currency), period: "monthly" }, { limit: money(900_000, currency), period: "weekly" }];
      const goals: Goal[] = [{ id: "g", name: "Emergency fund", target: money(5_000_000, currency), saved: money(1_000_000, currency) }];
      for (const confidence of [0.62, 0.75, 0.95]) {
        const c = buy({ minor: 260_000, currency, at: now - HOUR, merchant: "Shop", category: "shopping.electronics", confidence });
        for (const i of rankInsights(c, ctx({ now, region, history, budgets, goals }))) texts.push(i.text);
      }
    }
    expect(texts.length).toBeGreaterThan(20);
    for (const t of texts) {
      expect(toneIssues(t)).toEqual([]);
      expect(t).not.toMatch(/^\s*you spent/i);
    }
  });
});
