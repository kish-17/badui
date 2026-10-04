import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE, defaultAttributes, formatMoney, money, unknownInference, zonedTimeToEpoch } from "@brake/core";
import type { Budget, Essentiality, Goal, TransactionCandidate, TransactionType, UserRule } from "@brake/core";
import { inference, makeCandidate } from "@brake/core/testing";
import type { InterventionContext, InterventionDecision, RegretEstimate } from "../src/contracts";
import { toneIssues } from "../src/copy";
import {
  INTERVENTION_ACTIONS,
  approximateTimeZone,
  createInterventionPolicy,
  hasChosenToContinue,
  interventionAnswerEffect,
  respectPriorResponses,
} from "../src/interventions";
import type { InterventionResponse } from "../src/interventions";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const TZ = "Asia/Kolkata";
/** Thursday 2026-10-08 14:00 IST; the budget week started Monday 5 Oct. */
const NOW = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 14, minute: 0, second: 0 }, TZ);

interface Item {
  minor?: number;
  currency?: string;
  status?: TransactionCandidate["status"];
  at?: number;
  confidence?: number;
  category?: string;
  categoryConfidence?: number;
  channel?: "online" | "in_store" | "unknown";
  approximate?: boolean;
  type?: TransactionType;
  direction?: "debit" | "credit";
  essentiality?: Essentiality;
  intentOutcome?: TransactionCandidate["intentOutcome"];
}

/** A pre-spend intent ("Should I buy this?", shared product, scanned price tag). */
function intent(p: Item = {}): TransactionCandidate {
  const attrs = defaultAttributes();
  return makeCandidate({
    minor: p.minor ?? 250_000,
    currency: p.currency ?? "INR",
    status: p.status ?? "intent",
    intentOutcome: p.intentOutcome ?? "open",
    timestampEstimated: p.at ?? NOW,
    direction: p.direction ?? "debit",
    merchant: { raw: null, normalized: "shop", displayName: "Shop", confidence: 0.9, channel: p.channel ?? "online" },
    category: p.category ? inference(p.category, p.categoryConfidence ?? 0.9) : unknownInference("uncategorized"),
    transactionType: inference(p.type ?? "purchase", 0.9),
    confidence: p.confidence ?? 0.9,
    ...(p.approximate ? { amount: { value: money(p.minor ?? 250_000, p.currency ?? "INR"), confidence: 0.7, approximate: true } } : {}),
    attributes: p.essentiality
      ? { ...attrs, essentiality: { value: p.essentiality, confidence: 1, alternatives: [], basis: ["user_label"], userSet: true } }
      : attrs,
  });
}

function spent(minor: number, at: number, category = "eating_out", currency = "INR"): TransactionCandidate {
  return makeCandidate({
    minor,
    currency,
    status: "posted",
    timestampEstimated: at,
    category: inference(category, 0.95),
    transactionType: inference("purchase", 1),
    confidence: 1,
  });
}

function ctx(p: Partial<InterventionContext> = {}): InterventionContext {
  return {
    now: NOW,
    locale: "en-IN",
    localHour: 14,
    regret: null,
    budgets: [],
    goals: [],
    history: [],
    rules: [],
    interventionsLast24h: 0,
    ...p,
  };
}

/** An estimate from the time-aware segment, as regret.ts names it. */
const regret = (probability: number, evidence: number): RegretEstimate => ({
  probability,
  evidence,
  segment: "category=shopping|time=late_night|channel=online",
});
const policy = createInterventionPolicy({ timeZone: TZ });
const ids = (d: InterventionDecision) => d.actions.map((a) => a.id);

/** Never block, never scold: every decision can be continued and every message reads well. */
function expectHumane(d: InterventionDecision): void {
  expect(d.actions.some((a) => a.id === "continue" && a.label === "Continue")).toBe(true);
  if (d.level === "none") expect(d.message).toBeUndefined();
  else {
    expect(d.message).toBeTruthy();
    expect(toneIssues(d.message!)).toEqual([]);
  }
}

/* ------------------------------------------------------------------ */
/* Confidence bounds                                                   */
/* ------------------------------------------------------------------ */

describe("confidence bounds the strength of friction", () => {
  const strong = ctx({ regret: regret(0.8, 8) });

  it("does nothing below 0.4", () => {
    const d = policy.decide(intent({ confidence: 0.35 }), strong);
    expect(d.level).toBe("none");
    expect(d.reasons).toEqual(["low_confidence"]);
    expectHumane(d);
  });

  it("at most informs below 0.6", () => {
    for (const confidence of [0.4, 0.5, 0.59]) {
      const d = policy.decide(intent({ confidence }), strong);
      expect(d.level).toBe("inform");
      expect(d.reasons).toContain("capped:confidence");
      expect(d.message).toBe("Purchases like this are often ones you've regretted.");
      expect(ids(d)).toEqual(["continue"]);
      expectHumane(d);
    }
  });

  it("allows full strength from 0.6", () => {
    expect(policy.decide(intent({ confidence: 0.6 }), strong).level).toBe("pause");
    expect(policy.decide(intent({ confidence: 0.95 }), strong).level).toBe("pause");
  });

  it("can judge an open intent by the facts the user stated (opt-in)", () => {
    // A lone "Should I buy this?" whose candidate confidence also discounts whether the purchase will happen.
    const lone = makeCandidate({ status: "intent", intentOutcome: "open", minor: 250_000, confidence: 0.36, timestampEstimated: NOW });
    expect(policy.decide(lone, strong).level).toBe("none");
    const factsPolicy = createInterventionPolicy({ timeZone: TZ, intentConfidence: "facts" });
    expect(factsPolicy.decide(lone, strong).level).toBe("pause");
    // Still bounded by how sure BRAKE is of the amount (a blurry OCR'd price tag).
    const priceTag = (amountConfidence: number) =>
      makeCandidate({
        status: "intent",
        intentOutcome: "open",
        confidence: 0.2,
        timestampEstimated: NOW,
        amount: { value: money(250_000, "INR"), confidence: amountConfidence, approximate: true },
      });
    expect(factsPolicy.decide(priceTag(0.35), strong).level).toBe("none");
    expect(factsPolicy.decide(priceTag(0.5), strong).level).toBe("inform");
    // Facts mode never applies once money is moving.
    const pending = intent({ status: "pending", confidence: 0.36, at: NOW - MINUTE });
    expect(factsPolicy.decide(pending, strong).level).toBe("none");
  });

  it("bounds the user's own rules too", () => {
    const rule: UserRule = { id: "r1", description: "pause big online buys", channel: "online", level: "pause" };
    expect(policy.decide(intent({ confidence: 0.5 }), ctx({ rules: [rule] })).level).toBe("inform");
    expect(policy.decide(intent({ confidence: 0.3 }), ctx({ rules: [rule] })).level).toBe("none");
  });
});

/* ------------------------------------------------------------------ */
/* Personal regret                                                     */
/* ------------------------------------------------------------------ */

describe("regret-driven escalation", () => {
  it("reflects at p ≥ 0.5 with ≥ 3 answers, without claiming a pattern from so few", () => {
    const d = policy.decide(intent(), ctx({ regret: regret(0.55, 3) }));
    expect(d.level).toBe("reflect");
    expect(d.message).toBe("Planned, or spur of the moment?");
    expect(d.actions).toEqual([INTERVENTION_ACTIONS.planned, INTERVENTION_ACTIONS.spur_of_the_moment, INTERVENTION_ACTIONS.continue]);
    expect(d.actions.map((a) => a.label)).toEqual(["Planned", "Spur of the moment", "Continue"]);
    expectHumane(d);
  });

  it("describes the user's own pattern once five or more answers back it", () => {
    const d = policy.decide(intent(), ctx({ regret: regret(0.55, 5) }));
    expect(d.level).toBe("reflect");
    expect(d.message).toBe("Purchases like this have sometimes been ones you've regretted. Planned, or spur of the moment?");
    expectHumane(d);
  });

  it("shows nothing rather than an inform with nothing to say", () => {
    const d = policy.decide(intent({ confidence: 0.5 }), ctx({ regret: regret(0.6, 3) }));
    expect(d.level).toBe("none");
    expect(d.reasons).toEqual(expect.arrayContaining(["capped:confidence", "nothing_to_inform"]));
    expectHumane(d);
  });

  it("pauses at p ≥ 0.7 with ≥ 5 answers", () => {
    const d = policy.decide(intent(), ctx({ regret: regret(0.75, 6) }));
    expect(d.level).toBe("pause");
    expect(d.message).toBe("Purchases like this are often ones you've regretted. Want to give it a day?");
    expect(d.actions.map((a) => a.label)).toEqual(["Remind me tomorrow", "Save to wishlist", "Continue"]);
    expect(d.reasons[0]).toMatch(/^regret:p=0\.75,n=6$/);
    expectHumane(d);
  });

  it("needs enough evidence before escalating", () => {
    expect(policy.decide(intent(), ctx({ regret: regret(0.75, 4) })).level).toBe("reflect");
    expect(policy.decide(intent(), ctx({ regret: regret(0.9, 2) })).level).toBe("none");
    expect(policy.decide(intent(), ctx({ regret: regret(0.45, 20) })).level).toBe("none");
    expect(policy.decide(intent(), ctx({ regret: null })).reasons).toEqual(["no_signal"]);
  });
});

/* ------------------------------------------------------------------ */
/* Late night                                                          */
/* ------------------------------------------------------------------ */

describe("late night", () => {
  it("is not a reason on its own", () => {
    for (const localHour of [23, 0, 2, 4]) {
      const d = policy.decide(intent(), ctx({ localHour }));
      expect(d.level).toBe("none");
      expectHumane(d);
    }
  });

  it("escalates when the user's regret history supports it", () => {
    const d = policy.decide(intent(), ctx({ localHour: 23, regret: regret(0.68, 5) }));
    expect(d.level).toBe("pause");
    expect(d.message).toBe("Purchases like this late at night are often ones you've regretted. Sleep on it?");
    expect(d.reasons).toContain("late_night+regret");
    expectHumane(d);
  });

  it("never turns three answers into a pause, even at night", () => {
    // A pause needs the evidence a pause needs (≥ 5 answers); late night does not lower that bar.
    const thin = policy.decide(intent(), ctx({ localHour: 23, regret: regret(0.68, 3) }));
    expect(thin.level).toBe("reflect");
    expect(thin.message).toBe("Planned, or spur of the moment?");
    expect(thin.reasons).not.toContain("late_night+regret");
    expectHumane(thin);
  });

  it("does not claim or act on a late-night pattern the regret estimate never saw", () => {
    // Backed off to the category level: the estimate knows nothing about the time of day.
    const general: RegretEstimate = { probability: 0.6, evidence: 8, segment: "category=shopping" };
    const d = policy.decide(intent(), ctx({ localHour: 23, regret: general }));
    expect(d.level).toBe("reflect");
    expect(d.message).toBe("Purchases like this have sometimes been ones you've regretted. Planned, or spur of the moment?");
    expectHumane(d);
  });

  it("covers 23:00–04:59 only", () => {
    expect(policy.decide(intent(), ctx({ localHour: 4, regret: regret(0.55, 5) })).level).toBe("pause");
    expect(policy.decide(intent(), ctx({ localHour: 5, regret: regret(0.55, 5) })).level).toBe("reflect");
    expect(policy.decide(intent(), ctx({ localHour: 22, regret: regret(0.55, 5) })).level).toBe("reflect");
  });

  it("uses the level of a user's late-night rule without escalating past it", () => {
    const rule: UserRule = { id: "night", description: "check in on online shopping after 11pm", channel: "online", localHours: { from: 23, to: 5 }, level: "reflect" };
    const d = policy.decide(intent(), ctx({ localHour: 0, rules: [rule] }));
    expect(d.level).toBe("reflect");
    expect(d.message).toBe("This matches your rule “check in on online shopping after 11pm”. Planned, or spur of the moment?");
    expectHumane(d);
  });
});

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

describe("budgets", () => {
  const weekly: Budget = { category: "eating_out", limit: money(300_000, "INR"), period: "weekly" };
  const history = [spent(100_000, NOW - 3 * DAY), spent(80_000, NOW - 2 * DAY), spent(500_000, NOW - 10 * DAY)];
  const food = (minor: number, p: Item = {}) => intent({ minor, category: "eating_out.delivery", ...p });

  it("informs when a purchase would nearly use up the budget", () => {
    const d = policy.decide(food(100_000), ctx({ budgets: [weekly], history }));
    expect(d.level).toBe("inform");
    expect(d.message).toBe("You have ₹1,200 left in Eating out this week.");
    expect(ids(d)).toEqual(["continue"]);
    expectHumane(d);
  });

  it("stays out of the way when plenty would remain", () => {
    expect(policy.decide(food(30_000), ctx({ budgets: [weekly], history })).level).toBe("none");
  });

  it("reflects when it would exceed the budget", () => {
    const d = policy.decide(food(150_000), ctx({ budgets: [weekly], history }));
    expect(d.level).toBe("reflect");
    expect(d.message).toBe("This would put Eating out ₹300 over this week's budget. Planned, or spur of the moment?");
    expect(d.reasons).toContain("budget:eating_out:over_by=10%");
    expectHumane(d);
  });

  it("suggests a pause when it would exceed the budget by more than 25%", () => {
    const d = policy.decide(food(220_000), ctx({ budgets: [weekly], history }));
    expect(d.level).toBe("pause");
    expect(d.message).toBe("This would put Eating out ₹1,000 over this week's budget. Want to give it a day?");
    expectHumane(d);
  });

  it("pauses only past a quarter of the limit", () => {
    const h = [spent(180_000, NOW - DAY)];
    // ₹1,800 + ₹1,950 = ₹750 over a ₹3,000 limit: exactly 25%.
    expect(policy.decide(food(195_000), ctx({ budgets: [weekly], history: h })).level).toBe("reflect");
    expect(policy.decide(food(195_100), ctx({ budgets: [weekly], history: h })).level).toBe("pause");
  });

  it("keeps friction proportionate to this purchase once a budget is already over", () => {
    const over = [spent(400_000, NOW - DAY)]; // ₹4,000 against ₹3,000
    const chai = policy.decide(food(10_000), ctx({ budgets: [weekly], history: over }));
    expect(chai.level).toBe("reflect");
    expect(chai.message).toBe("This would put Eating out ₹1,100 over this week's budget. Planned, or spur of the moment?");
    expectHumane(chai);
    // A purchase that itself overshoots by more than a quarter of the limit still suggests a pause.
    expect(policy.decide(food(100_000), ctx({ budgets: [weekly], history: over })).level).toBe("pause");
  });

  it("never says '₹0 over': a sub-unit overshoot reads as using up what is left", () => {
    const d = policy.decide(food(120_030), ctx({ budgets: [weekly], history: [spent(180_000, NOW - DAY)] }));
    expect(d.level).toBe("inform");
    expect(d.message).toBe("You have ₹1,200 left in Eating out this week.");
    expectHumane(d);
  });

  it("does not double count an in-spend payment that is already in history", () => {
    const pending = food(150_000, { status: "pending", at: NOW - 2 * MINUTE });
    const d = policy.decide(pending, ctx({ budgets: [weekly], history: [...history, pending] }));
    expect(d.level).toBe("reflect");
    expect(d.message).toContain("₹300 over");
  });

  it("says 'about' for an approximate amount", () => {
    const d = policy.decide(food(150_000, { approximate: true }), ctx({ budgets: [weekly], history }));
    expect(d.message).toBe("This would put Eating out about ₹300 over this week's budget. Planned, or spur of the moment?");
  });

  it("handles an overall monthly budget in USD (en-US)", () => {
    const tz = "America/New_York";
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 20, hour: 15, minute: 0, second: 0 }, tz);
    const overall: Budget = { limit: money(150_000, "USD"), period: "monthly" };
    const usdPolicy = createInterventionPolicy({ timeZone: tz });
    const d = usdPolicy.decide(
      intent({ minor: 60_000, currency: "USD", at: now, category: "shopping.electronics" }),
      ctx({ now, locale: "en-US", budgets: [overall], history: [spent(130_000, now - 5 * DAY, "groceries", "USD")] }),
    );
    // $1,300 + $600 against $1,500: $400 over, 27% of the limit.
    expect(d.level).toBe("pause");
    expect(d.message).toBe("This would put you $400 over this month's budget. Want to give it a day?");
    expectHumane(d);
  });

  it("ignores category budgets when the category is uncertain, and budgets in other currencies", () => {
    expect(policy.decide(food(150_000, { categoryConfidence: 0.4 }), ctx({ budgets: [weekly], history })).level).toBe("none");
    const eur: Budget = { category: "eating_out", limit: money(1_000, "EUR"), period: "weekly" };
    expect(policy.decide(food(150_000), ctx({ budgets: [eur], history })).level).toBe("none");
  });
});

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

describe("goals", () => {
  const goa: Goal = { id: "goa", name: "Goa trip", target: money(6_000_000, "INR"), saved: money(1_000_000, "INR") };

  it("informs when a purchase is at least 10% of what's left", () => {
    const d = policy.decide(intent({ minor: 600_000, category: "shopping.electronics" }), ctx({ goals: [goa] }));
    expect(d.level).toBe("inform");
    expect(d.message).toBe("This would be 12% of what's left for Goa trip.");
    expect(d.reasons).toEqual(["goal:goa:share=12%"]);
    expectHumane(d);
  });

  it("stays quiet below 10%", () => {
    expect(policy.decide(intent({ minor: 400_000, category: "shopping.electronics" }), ctx({ goals: [goa] })).level).toBe("none");
  });

  it("includes the 10% boundary and never rounds a share below 100% up to '100%'", () => {
    expect(policy.decide(intent({ minor: 500_000, category: "shopping.electronics" }), ctx({ goals: [goa] })).message).toBe(
      "This would be 10% of what's left for Goa trip.",
    );
    const d = policy.decide(intent({ minor: 4_980_000, category: "shopping.electronics" }), ctx({ goals: [goa] }));
    expect(d.message).toBe("This would be nearly all of what's left for Goa trip.");
    expectHumane(d);
  });

  it("formats BRL for pt-BR (Pix checkout)", () => {
    const tz = "America/Sao_Paulo";
    const now = zonedTimeToEpoch({ year: 2026, month: 10, day: 8, hour: 20, minute: 0, second: 0 }, tz);
    const goal: Goal = { id: "ssa", name: "Viagem para Salvador", target: money(1_000_000, "BRL"), saved: money(400_000, "BRL") };
    const weekly: Budget = { category: "shopping", limit: money(200_000, "BRL"), period: "weekly" };
    const pix = intent({ minor: 150_000, currency: "BRL", status: "pending", at: now - MINUTE, category: "shopping.clothing" });
    const d = createInterventionPolicy({ timeZone: tz }).decide(
      pix,
      ctx({ now, locale: "pt-BR", localHour: 20, goals: [goal], budgets: [weekly], history: [spent(30_000, now - DAY, "shopping", "BRL")] }),
    );
    // Budget is the more concrete fact for a quiet inform.
    expect(d.level).toBe("inform");
    expect(d.message).toBe(`You have ${formatMoney(money(170_000, "BRL"), "pt-BR")} left in Shopping this week.`);
    expect(d.message).toMatch(/R\$\s1\.700/);
    expect(d.reasons).toEqual(expect.arrayContaining(["goal:ssa:share=25%", "budget:shopping:nearly_used"]));
    expectHumane(d);
  });
});

/* ------------------------------------------------------------------ */
/* User rules                                                          */
/* ------------------------------------------------------------------ */

describe("user rules", () => {
  const night: UserRule = {
    id: "night_shopping",
    description: "pause online shopping after 11pm",
    category: "shopping",
    localHours: { from: 23, to: 5 },
    channel: "online",
    level: "pause",
  };
  const gadgets: UserRule = {
    id: "gadgets",
    description: "remind me of my goal for electronics over ₹2,000",
    category: "shopping.electronics",
    minAmount: money(200_000, "INR"),
    level: "reflect",
  };

  it("applies a matching rule at its level", () => {
    const d = policy.decide(intent({ category: "shopping.clothing" }), ctx({ localHour: 23, rules: [night] }));
    expect(d.level).toBe("pause");
    expect(d.message).toBe("This matches your rule “pause online shopping after 11pm”. Sleep on it?");
    expect(d.reasons).toEqual(["rule:night_shopping"]);
    expectHumane(d);
  });

  it("requires every condition: hours, channel, category, amount", () => {
    expect(policy.decide(intent({ category: "shopping" }), ctx({ localHour: 14, rules: [night] })).level).toBe("none");
    expect(policy.decide(intent({ category: "shopping", channel: "in_store" }), ctx({ localHour: 23, rules: [night] })).level).toBe("none");
    expect(policy.decide(intent({ category: "eating_out" }), ctx({ localHour: 23, rules: [night] })).level).toBe("none");
    expect(policy.decide(intent({ category: "shopping", categoryConfidence: 0.3 }), ctx({ localHour: 23, rules: [night] })).level).toBe("none");

    expect(policy.decide(intent({ minor: 199_999, category: "shopping.electronics" }), ctx({ rules: [gadgets] })).level).toBe("none");
    expect(policy.decide(intent({ minor: 200_000, category: "shopping.electronics" }), ctx({ rules: [gadgets] })).level).toBe("reflect");
    // A minimum in another currency never matches: BRAKE does not guess exchange rates.
    expect(policy.decide(intent({ minor: 900_000, currency: "USD", category: "shopping.electronics" }), ctx({ rules: [gadgets] })).level).toBe("none");
  });

  it("takes the strongest of several matching rules and lists them all", () => {
    const soft: UserRule = { id: "soft", description: "tell me about online buys", channel: "online", level: "inform" };
    const d = policy.decide(intent({ category: "shopping" }), ctx({ localHour: 1, rules: [soft, night] }));
    expect(d.level).toBe("pause");
    expect(d.reasons).toEqual(["rule:soft", "rule:night_shopping"]);
  });

  it("does not echo a rule description that would read as scolding", () => {
    const harsh: UserRule = { id: "harsh", description: "Stop wasting money on gadgets!", category: "shopping", level: "reflect" };
    const d = policy.decide(intent({ category: "shopping.electronics" }), ctx({ rules: [harsh] }));
    expect(d.message).toBe("This matches one of your rules. Planned, or spur of the moment?");
    expectHumane(d);
  });
});

/* ------------------------------------------------------------------ */
/* Essentials                                                          */
/* ------------------------------------------------------------------ */

describe("essentials", () => {
  const weekly: Budget = { category: "groceries", limit: money(100_000, "INR"), period: "weekly" };

  it("never questions essentials by default, whatever the other signals say", () => {
    for (const category of ["groceries", "health", "housing.rent", "bills.utilities"]) {
      const d = policy.decide(intent({ minor: 500_000, category }), ctx({ regret: regret(0.9, 10), budgets: [weekly], localHour: 1 }));
      expect(d.level).toBe("none");
      expect(d.reasons).toContain("essential");
      expectHumane(d);
    }
  });

  it("trusts the user's essentiality label over the category prior", () => {
    expect(policy.decide(intent({ category: "shopping", essentiality: "essential" }), ctx({ regret: regret(0.9, 10) })).level).toBe("none");
    expect(policy.decide(intent({ category: "groceries", essentiality: "discretionary" }), ctx({ regret: regret(0.9, 10) })).level).toBe("pause");
  });

  it("applies a rule the user wrote for an essential category", () => {
    const rule: UserRule = { id: "big_grocery", description: "check in on grocery runs over ₹3,000", category: "groceries", minAmount: money(300_000, "INR"), level: "reflect" };
    const d = policy.decide(intent({ minor: 500_000, category: "groceries" }), ctx({ rules: [rule] }));
    expect(d.level).toBe("reflect");
    expect(d.reasons).toEqual(["essential", "rule:big_grocery"]);
    expectHumane(d);
  });
});

/* ------------------------------------------------------------------ */
/* Anti-nagging                                                        */
/* ------------------------------------------------------------------ */

describe("anti-nagging", () => {
  it("caps at inform after three interventions in 24h", () => {
    const d = policy.decide(intent(), ctx({ regret: regret(0.8, 8), interventionsLast24h: 3 }));
    expect(d.level).toBe("inform");
    expect(d.reasons).toContain("capped:recent_interventions");
    expect(d.message).toBe("Purchases like this are often ones you've regretted.");
    expect(ids(d)).toEqual(["continue"]);
    expectHumane(d);
  });

  it("prefers a concrete fact when capped", () => {
    const weekly: Budget = { category: "eating_out", limit: money(300_000, "INR"), period: "weekly" };
    const d = policy.decide(
      intent({ minor: 150_000, category: "eating_out" }),
      ctx({ regret: regret(0.8, 8), budgets: [weekly], history: [spent(180_000, NOW - DAY)], interventionsLast24h: 5 }),
    );
    expect(d.level).toBe("inform");
    expect(d.message).toBe("This would put Eating out ₹300 over this week's budget.");
  });

  it("can reserve cooling-off suggestions for rules the user wrote", () => {
    const gentle = createInterventionPolicy({ timeZone: TZ, maxModelLevel: "reflect" });
    const d = gentle.decide(intent(), ctx({ regret: regret(0.8, 8) }));
    expect(d.level).toBe("reflect");
    expect(d.reasons).toContain("capped:model_level:regret");
    const rule: UserRule = { id: "own", description: "pause online buys", channel: "online", level: "pause" };
    expect(gentle.decide(intent(), ctx({ regret: regret(0.8, 8), rules: [rule] })).level).toBe("pause");
  });

  it("keeps the anti-nagging cap when given an invalid threshold", () => {
    for (const maxPerDay of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = createInterventionPolicy({ timeZone: TZ, maxPerDay });
      expect(p.decide(intent(), ctx({ regret: regret(0.8, 8), interventionsLast24h: 3 })).level).toBe("inform");
    }
  });

  it("does not cap below the threshold and the threshold is configurable", () => {
    expect(policy.decide(intent(), ctx({ regret: regret(0.8, 8), interventionsLast24h: 2 })).level).toBe("pause");
    const patient = createInterventionPolicy({ timeZone: TZ, maxPerDay: 5 });
    expect(patient.decide(intent(), ctx({ regret: regret(0.8, 8), interventionsLast24h: 4 })).level).toBe("pause");
  });

  it("never re-prompts the same intent after the user chose to continue", () => {
    const c = intent();
    const first = policy.decide(c, ctx({ regret: regret(0.8, 8) }));
    expect(first.level).toBe("pause");
    const answered: InterventionResponse[] = [{ candidateId: c.id, actionId: "continue", at: NOW }];
    const again = respectPriorResponses(policy.decide(c, ctx({ regret: regret(0.8, 8) })), c, answered);
    expect(again.level).toBe("none");
    expect(again.reasons).toContain("already_chose_continue");
    expectHumane(again);
  });

  it("recognises the same intent across re-fusion and treats reflect answers as going ahead", () => {
    const c = makeCandidate({
      id: "cand_new_id",
      deduplicationGroup: "grp_1",
      status: "pending",
      sourceSignals: [
        { observationId: "obs_intent", kind: "purchase_intent", sourceLabel: "share", adapterId: "x", connectionId: "y", role: "primary", matchProbability: 1, linkedAt: NOW },
      ],
    });
    expect(hasChosenToContinue(c, [{ candidateId: "cand_old", actionId: "planned", at: NOW, observationIds: ["obs_intent"] }])).toBe(true);
    expect(hasChosenToContinue(c, [{ candidateId: "grp_1", actionId: "spur_of_the_moment", at: NOW }])).toBe(true);
    expect(hasChosenToContinue(c, [{ candidateId: "cand_new_id", actionId: "remind_tomorrow", at: NOW }])).toBe(false);
    expect(hasChosenToContinue(c, [{ candidateId: "cand_other", actionId: "continue", at: NOW }])).toBe(false);
  });

  it("leaves a decision alone when there is no prior answer", () => {
    const c = intent();
    const d = policy.decide(c, ctx({ regret: regret(0.8, 8) }));
    expect(respectPriorResponses(d, c, [])).toBe(d);
  });
});

/* ------------------------------------------------------------------ */
/* Applicability and answers                                           */
/* ------------------------------------------------------------------ */

describe("applicability", () => {
  const strong = ctx({ regret: regret(0.8, 8) });

  it("acts on open intents and payments still in progress", () => {
    expect(policy.decide(intent(), strong).level).toBe("pause");
    expect(policy.decide(intent({ status: "pending", at: NOW - 5 * MINUTE }), strong).level).toBe("pause");
  });

  it("treats a payment flow seen in progress (checkout, status still unknown) as in-spend", () => {
    const checkout = {
      ...intent({ status: "unknown", at: NOW - 2 * MINUTE }),
      sourceSignals: [
        { observationId: "obs_qr", kind: "checkout" as const, sourceLabel: "QR scan", adapterId: "x", connectionId: "y", role: "primary" as const, matchProbability: 1, linkedAt: NOW },
      ],
    };
    expect(policy.decide(checkout, strong).level).toBe("pause");
    expect(policy.decide({ ...checkout, sourceSignals: [] }, strong).reasons).toEqual(["not_pre_or_in_spend"]);
    expect(policy.decide({ ...checkout, timestampEstimated: NOW - 20 * MINUTE }, strong).level).toBe("none");
  });

  it("does nothing after the fact or for closed intents", () => {
    expect(policy.decide(intent({ status: "confirmed", at: NOW - MINUTE }), strong).reasons).toEqual(["not_pre_or_in_spend"]);
    expect(policy.decide(intent({ status: "posted", at: NOW - MINUTE }), strong).level).toBe("none");
    expect(policy.decide(intent({ status: "pending", at: NOW - 2 * HOUR }), strong).level).toBe("none");
    expect(policy.decide(intent({ intentOutcome: "abandoned" }), strong).level).toBe("none");
    expect(policy.decide(intent({ intentOutcome: "purchased" }), strong).level).toBe("none");
  });

  it("does not question incoming money or non-purchases", () => {
    expect(policy.decide(intent({ direction: "credit" }), strong).reasons).toEqual(["incoming_money"]);
    expect(policy.decide(intent({ type: "transfer" }), strong).reasons).toEqual(["not_a_purchase:transfer"]);
    expect(policy.decide(intent({ type: "credit_card_payment" }), strong).level).toBe("none");
  });

  it("maps reflect answers onto the intent attribute", () => {
    expect(interventionAnswerEffect("planned")).toEqual({ field: "intent", value: "planned" });
    expect(interventionAnswerEffect("spur_of_the_moment")).toEqual({ field: "intent", value: "impulsive" });
    expect(interventionAnswerEffect("continue")).toBeNull();
    expect(interventionAnswerEffect("save_to_wishlist")).toBeNull();
  });
});

describe("time zone fallback", () => {
  it("approximates a whole-hour zone from the local hour", () => {
    const at = Date.UTC(2026, 9, 8, 12, 0, 0);
    expect(approximateTimeZone(at, 12)).toBe("UTC");
    expect(approximateTimeZone(at, 9)).toBe("Etc/GMT+3"); // São Paulo
    expect(approximateTimeZone(at, 2)).toBe("Etc/GMT+10"); // Hawaii, not Kiribati
    expect(approximateTimeZone(at, 1)).toBe("Etc/GMT-13"); // New Zealand summer
    expect(approximateTimeZone(at, 15)).toBe("Etc/GMT-3"); // Nairobi
  });

  it("never builds an invalid zone (and never throws) from a malformed local hour", () => {
    const at = Date.UTC(2026, 9, 8, 8, 30, 0);
    expect(approximateTimeZone(at, Number.NaN)).toBe("UTC");
    expect(approximateTimeZone(at, 13.5)).toBe("Etc/GMT-5");
    const weekly: Budget = { category: "eating_out", limit: money(300_000, "INR"), period: "weekly" };
    const item = intent({ minor: 150_000, category: "eating_out" });
    for (const localHour of [Number.NaN, 13.5]) {
      expect(() => createInterventionPolicy().decide(item, ctx({ localHour, budgets: [weekly], history: [spent(180_000, NOW - DAY)] }))).not.toThrow();
    }
  });

  it("gives the same budget decision as an explicit zone mid-week", () => {
    const weekly: Budget = { category: "eating_out", limit: money(300_000, "INR"), period: "weekly" };
    const c = ctx({ budgets: [weekly], history: [spent(180_000, NOW - DAY)] });
    const item = intent({ minor: 150_000, category: "eating_out" });
    expect(createInterventionPolicy().decide(item, c)).toEqual(policy.decide(item, c));
  });
});

describe("tone across every path and locale", () => {
  it("every message passes the tone linter and every decision can be continued", () => {
    const decisions: InterventionDecision[] = [];
    const regions = [
      { locale: "en-IN", currency: "INR", tz: "Asia/Kolkata" },
      { locale: "en-US", currency: "USD", tz: "America/New_York" },
      { locale: "en-IE", currency: "EUR", tz: "Europe/Dublin" },
      { locale: "pt-BR", currency: "BRL", tz: "America/Sao_Paulo" },
      { locale: "en-KE", currency: "KES", tz: "Africa/Nairobi" },
    ];
    for (const r of regions) {
      const p = createInterventionPolicy({ timeZone: r.tz });
      const budgets: Budget[] = [{ category: "shopping", limit: money(500_000, r.currency), period: "weekly" }, { limit: money(2_000_000, r.currency), period: "monthly" }];
      const goals: Goal[] = [{ id: "g", name: "New laptop", target: money(5_000_000, r.currency), saved: money(1_000_000, r.currency) }];
      const rules: UserRule[] = [{ id: "r", description: "think twice about gadgets", category: "shopping.electronics", level: "reflect" }];
      const history = [spent(300_000, NOW - DAY, "shopping", r.currency)];
      for (const minor of [50_000, 150_000, 400_000, 900_000])
        for (const confidence of [0.3, 0.5, 0.7, 0.95])
          for (const localHour of [1, 14])
            for (const est of [null, regret(0.55, 3), regret(0.8, 9)])
              for (const n of [0, 3]) {
                const item = intent({ minor, currency: r.currency, confidence, category: "shopping.electronics" });
                decisions.push(p.decide(item, ctx({ locale: r.locale, localHour, regret: est, budgets, goals, rules, history, interventionsLast24h: n })));
              }
    }
    const levels = new Set(decisions.map((d) => d.level));
    expect([...levels].sort()).toEqual(["inform", "none", "pause", "reflect"]);
    for (const d of decisions) expectHumane(d);
  });
});

describe("purity", () => {
  function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  }

  it("never mutates its inputs and gives the same answer twice", () => {
    const c = deepFreeze(intent({ minor: 150_000, category: "eating_out" }));
    const context = deepFreeze(
      ctx({
        regret: regret(0.6, 6),
        budgets: [{ category: "eating_out", limit: money(300_000, "INR"), period: "weekly" }],
        goals: [{ id: "g", name: "Goa trip", target: money(1_000_000, "INR"), saved: money(0, "INR") }],
        history: [spent(180_000, NOW - DAY)],
        rules: [{ id: "r", description: "check in on food delivery", category: "eating_out", level: "inform" }],
      }),
    );
    const before = JSON.stringify([c, context]);
    const d = policy.decide(c, context);
    expect(d.level).toBe("reflect");
    expect(policy.decide(c, context)).toEqual(d);
    expect(JSON.stringify([c, context])).toBe(before);
  });
});
