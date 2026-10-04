import { describe, expect, it } from "vitest";
import { HOUR, MINUTE, defaultAttributes, money, userInference } from "@brake/core";
import type { CandidateLink, CategoryId, Money, TransactionCandidate, TransactionType, TransferKind } from "@brake/core";
import { T0, inference, makeCandidate } from "@brake/core/testing";
import type { AskDecision, Distribution, Question, QuestionContext, UserModel } from "../src/contracts";
import { toneIssues } from "../src/copy";
import {
  DEFAULT_QUIET_HOURS,
  EXISTENCE_OPTIONS,
  QUESTION_TTL_MS,
  SAME_EVENT_OPTIONS,
  createQuestionPolicy,
  isQuietHour,
  learningValue,
  optionAssertion,
  typeSplit,
} from "../src/questions";
import { MORE_OPTION } from "../src/taxonomy";
import { counterpartyKey, createUserModel } from "../src/user-model";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface StubModel {
  readonly labelCounts?: Record<string, number>;
  readonly categories?: Record<string, Distribution<CategoryId>>;
  readonly transferKinds?: Record<string, Distribution<TransferKind>>;
}

function stubUserModel(s: StubModel = {}): UserModel {
  return {
    observe() {},
    categoryFor: (k) => s.categories?.[k] ?? null,
    typeFor: () => null,
    transferKindFor: (k) => s.transferKinds?.[k] ?? null,
    essentialityFor: () => null,
    labelCount: (k) => s.labelCounts?.[k] ?? 0,
    toJSON: () => ({}),
  };
}

function ctx(p: Partial<QuestionContext> & { model?: StubModel } = {}): QuestionContext {
  const { model, ...rest } = p;
  return {
    now: T0,
    locale: "en-IN",
    userModel: stubUserModel(model),
    budget: { askedLast7Days: 0, lastAskedAt: null, unansweredStreak: 0 },
    surface: { maxQuickActions: 4, supportsTextInput: false },
    weeklySpendingBaseline: money(800_000, "INR"), // ₹8,000 a week
    merchantTypicalAmount: null,
    localHour: 11,
    ...rest,
  };
}

const AMAZON = { raw: "AMAZON PAY INDIA", normalized: "amazon", displayName: "Amazon", confidence: 0.95, channel: "online" } as const;

/** ₹1,249 at Amazon: a confident purchase whose category is genuinely unclear. */
function amazonOrder(p: Partial<TransactionCandidate> = {}): TransactionCandidate {
  return makeCandidate({
    id: "cand_amazon",
    minor: 124_900,
    merchant: AMAZON,
    paymentRail: { family: "account_to_account_instant", scheme: "upi" },
    transactionType: inference<TransactionType>("purchase", 0.95),
    category: inference<CategoryId>("shopping.online_marketplace", 0.45, [
      ["household", 0.25],
      ["shopping.electronics", 0.15],
      ["groceries", 0.1],
    ]),
    ...p,
  });
}

/** A ₹50,000 debit to a person: rent, a transfer to savings, an investment…? */
function bigDebit(p: Partial<TransactionCandidate> = {}): TransactionCandidate {
  return makeCandidate({
    id: "cand_50k",
    minor: 5_000_000,
    counterparty: { name: "R K Sharma", handle: "rksharma@okicici", isMerchant: 0.3 },
    paymentRail: { family: "account_to_account_instant", scheme: "upi" },
    transactionType: inference<TransactionType>("purchase", 0.45, [
      ["transfer", 0.4],
      ["investment", 0.15],
    ]),
    ...p,
  });
}

function decide(c: TransactionCandidate, context: QuestionContext = ctx(), opts?: Parameters<typeof createQuestionPolicy>[0]): AskDecision {
  return createQuestionPolicy(opts).decide(c, context);
}

function asked(d: AskDecision): Question {
  expect(d.ask).toBe(true);
  expect(d.question).toBeDefined();
  return d.question!;
}

function dupLink(target: string, probability = 0.7): CandidateLink {
  return { kind: "possible_duplicate", target, probability, createdAt: T0 };
}

function expectToneClean(q: Question): void {
  expect(toneIssues(q.prompt)).toEqual([]);
  for (const o of q.options) {
    expect(toneIssues(o.label)).toEqual([]);
    expect(o.label.length).toBeLessThanOrEqual(14);
  }
}

/* ------------------------------------------------------------------ */
/* Value of information                                                */
/* ------------------------------------------------------------------ */

describe("asking by value of information", () => {
  it("asks about a material purchase whose category is unclear, at a new merchant", () => {
    const d = decide(amazonOrder());
    const q = asked(d);
    expect(d.score).toBeGreaterThan(0);
    expect(q.kind).toBe("category");
    expect(d.reasons).toEqual(expect.arrayContaining(["low_confidence", "material_budget_impact", "improves_interventions"]));
    expect(q.reasons).toEqual(d.reasons);
  });

  it("values the first label at a merchant most and the fourth least", () => {
    expect(learningValue(0)).toBeGreaterThan(learningValue(1));
    expect(learningValue(2)).toBe(learningValue(1));
    expect(learningValue(3)).toBeLessThan(learningValue(2));
    const fresh = decide(amazonOrder());
    const known = decide(amazonOrder(), ctx({ model: { labelCounts: { amazon: 5 } } }));
    expect(known.score).toBeLessThan(fresh.score);
    expect(known.reasons).not.toContain("improves_interventions");
  });

  it("weighs impact against the user's own weekly spending, not an absolute amount", () => {
    const small = decide(amazonOrder({ amount: { value: money(30_000, "INR"), confidence: 0.99 } }));
    const large = decide(amazonOrder({ amount: { value: money(300_000, "INR"), confidence: 0.99 } }));
    expect(large.score).toBeGreaterThan(small.score);
    expect(large.reasons).toContain("material_budget_impact");
    expect(small.reasons).not.toContain("material_budget_impact");
  });

  it("uses amount bands when there is no baseline yet", () => {
    const d = decide(bigDebit(), ctx({ weeklySpendingBaseline: null }));
    expect(asked(d).kind).toBe("transaction_type");
    expect(d.reasons).toContain("material_budget_impact");
  });

  it("flags and rewards an unusual amount for the merchant (> 3× typical)", () => {
    const typical: Money = money(30_000, "INR");
    const usual = decide(amazonOrder({ amount: { value: money(60_000, "INR"), confidence: 0.99 } }), ctx({ merchantTypicalAmount: typical }));
    const unusual = decide(amazonOrder({ amount: { value: money(120_000, "INR"), confidence: 0.99 } }), ctx({ merchantTypicalAmount: typical }));
    expect(usual.reasons).not.toContain("unusual");
    expect(unusual.reasons).toContain("unusual");
    expect(unusual.score).toBeGreaterThan(usual.score);
  });

  it("flags essentiality uncertainty and multi-category merchants", () => {
    const d = decide(
      amazonOrder({ category: inference<CategoryId>("personal_care", 0.4, [["household", 0.35], ["shopping", 0.2]]) }),
    );
    expect(d.reasons).toEqual(expect.arrayContaining(["essentiality_uncertain", "ambiguous_merchant"]));
  });

  it("measures type ambiguity as 2·min(P(spending), 1 − P(spending))", () => {
    expect(typeSplit(bigDebit()).ambiguity).toBeCloseTo(0.9, 5);
    // 95% purchase, 5% unassigned: nearly settled, not exactly.
    expect(typeSplit(amazonOrder()).ambiguity).toBeLessThan(0.1);
    // An uninformed debit is probably, not certainly, spending.
    const uninformed = typeSplit(bigDebit({ transactionType: { value: "unknown", confidence: 0, alternatives: [], basis: ["none"], userSet: false } }));
    expect(uninformed.informed).toBe(false);
    expect(uninformed.pRelevant).toBeCloseTo(0.6, 5);
    // A user-chosen category settles it.
    expect(typeSplit(bigDebit({ category: userInference<CategoryId>("housing.rent") })).ambiguity).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Never ask when…                                                     */
/* ------------------------------------------------------------------ */

describe("suppression rules", () => {
  it("never asks about a user-verified candidate", () => {
    const d = decide(amazonOrder({ userVerified: true }));
    expect(d).toMatchObject({ ask: false, suppressedBy: "user_verified", reasons: [] });
    expect(d.question).toBeUndefined();
  });

  it("never asks about intents, cancelled or refunded transactions", () => {
    expect(decide(amazonOrder({ status: "intent" })).suppressedBy).toBe("intent");
    expect(decide(amazonOrder({ status: "cancelled" })).suppressedBy).toBe("cancelled");
    expect(decide(amazonOrder({ status: "refunded" })).suppressedBy).toBe("refunded");
  });

  it("never asks about a field the user already set", () => {
    const labeled = decide(amazonOrder({ category: userInference<CategoryId>("household") }));
    expect(labeled).toMatchObject({ ask: false, suppressedBy: "already_labeled" });
    // The user said it was a transfer: no category question, no type question.
    const transfer = decide(bigDebit({ transactionType: userInference<TransactionType>("transfer"), transferKind: "own_account" }));
    expect(transfer).toMatchObject({ ask: false, suppressedBy: "already_labeled" });
    // A user-chosen category also answers "purchase or transfer?".
    const rent = decide(bigDebit({ category: userInference<CategoryId>("housing.rent") }));
    expect(rent).toMatchObject({ ask: false, suppressedBy: "already_labeled" });
  });

  it("never asks when the answer is already predictable", () => {
    const starbucks = makeCandidate({
      minor: 45_000,
      merchant: { raw: "STARBUCKS", normalized: "starbucks", displayName: "Starbucks", confidence: 0.97, channel: "in_store" },
      transactionType: inference<TransactionType>("purchase", 0.97),
      category: inference<CategoryId>("eating_out.cafe", 0.9),
    });
    expect(decide(starbucks)).toMatchObject({ ask: false, suppressedBy: "predictable", score: 0 });
    // A confident own-account transfer has no category worth asking about.
    const sweep = bigDebit({ transactionType: inference<TransactionType>("transfer", 0.96), transferKind: "own_account" });
    expect(decide(sweep)).toMatchObject({ ask: false, suppressedBy: "predictable" });
  });

  it("defers during quiet hours (22:00–08:00 by default) and attaches the question for later", () => {
    for (const localHour of [22, 23, 0, 3, 7]) {
      const d = decide(amazonOrder(), ctx({ localHour }));
      expect(d.ask).toBe(false);
      expect(d.suppressedBy).toBe("quiet_hours");
      expect(d.score).toBeGreaterThan(0);
      expect(d.question?.kind).toBe("category");
    }
    for (const localHour of [8, 12, 21]) expect(decide(amazonOrder(), ctx({ localHour })).ask).toBe(true);
  });

  it("supports custom or disabled quiet hours", () => {
    expect(isQuietHour(23, DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isQuietHour(8, DEFAULT_QUIET_HOURS)).toBe(false);
    expect(isQuietHour(2, { from: 1, to: 6 })).toBe(true);
    expect(isQuietHour(23, { from: 1, to: 6 })).toBe(false);
    expect(decide(amazonOrder(), ctx({ localHour: 23 }), { quietHours: { from: 1, to: 6 } }).ask).toBe(true);
    expect(decide(amazonOrder(), ctx({ localHour: 3 }), { quietHours: null }).ask).toBe(true);
  });

  it("backs off after three unanswered questions in a row", () => {
    const d = decide(bigDebit(), ctx({ budget: { askedLast7Days: 1, lastAskedAt: T0 - 2 * 24 * HOUR, unansweredStreak: 3 } }));
    expect(d).toMatchObject({ ask: false, suppressedBy: "backing_off" });
    expect(d.question).toBeUndefined();
  });

  it("charges an unanswered streak below the back-off threshold", () => {
    const at = (unansweredStreak: number) => decide(amazonOrder(), ctx({ budget: { askedLast7Days: 0, lastAskedAt: null, unansweredStreak } })).score;
    expect(at(1)).toBeLessThan(at(0));
    expect(at(2)).toBeLessThan(at(1));
  });

  it("skips tiny amounts unless the money may not be spending at all", () => {
    const chai = makeCandidate({
      minor: 4_000, // ₹40
      merchant: { raw: "CHAI POINT", normalized: "chai_point", displayName: "Chai Point", confidence: 0.9, channel: "in_store" },
      transactionType: inference<TransactionType>("purchase", 0.97),
      category: inference<CategoryId>("eating_out.cafe", 0.5, [["groceries", 0.3]]),
    });
    expect(decide(chai).suppressedBy).toBe("tiny_amount");
    // ₹40 over UPI to a person: purchase or a transfer to a friend? Ambiguity overrides the tiny rule.
    const p2p = makeCandidate({
      minor: 4_000,
      counterparty: { name: "Arjun", handle: "arjun@oksbi" },
      transactionType: inference<TransactionType>("transfer", 0.5, [["purchase", 0.5]]),
    });
    expect(decide(p2p).suppressedBy).not.toBe("tiny_amount");
  });

  it("uses per-currency tiny floors, overridable by option", () => {
    const coffee = amazonOrder({ amount: { value: money(150, "USD"), confidence: 0.99 } });
    const usd = ctx({ locale: "en-US", weeklySpendingBaseline: money(40_000, "USD") });
    expect(decide(coffee, usd).suppressedBy).toBe("tiny_amount");
    expect(decide(coffee, usd, { minAmountMinorByCurrency: { USD: 100 } }).suppressedBy).not.toBe("tiny_amount");
  });

  it("never asks 'what was this?' about a sensitive category", () => {
    const pharmacy = amazonOrder({
      merchant: { raw: "APOLLO PHARMACY", normalized: "apollo_pharmacy", displayName: "Apollo Pharmacy", confidence: 0.9, channel: "in_store" },
      category: inference<CategoryId>("health", 0.7, [["personal_care", 0.2]]),
    });
    expect(decide(pharmacy).suppressedBy).toBe("sensitive_category");
  });

  it("cannot ask on a surface without room for a choice", () => {
    expect(decide(amazonOrder(), ctx({ surface: { maxQuickActions: 1, supportsTextInput: false } })).suppressedBy).toBe("surface_unsupported");
  });
});

/* ------------------------------------------------------------------ */
/* Budget and fatigue                                                  */
/* ------------------------------------------------------------------ */

describe("weekly budget and fatigue", () => {
  const budget = (askedLast7Days: number) => ({ askedLast7Days, lastAskedAt: T0 - 24 * HOUR, unansweredStreak: 0 });

  it("never exceeds the weekly budget (default 5)", () => {
    const d = decide(bigDebit(), ctx({ budget: budget(5) }));
    expect(d).toMatchObject({ ask: false, suppressedBy: "budget_exhausted" });
    expect(decide(bigDebit(), ctx({ budget: budget(2) }), { weeklyBudget: 2 }).suppressedBy).toBe("budget_exhausted");
  });

  it("raises the bar quadratically as the week's budget is used", () => {
    const scores = [0, 1, 2, 3, 4].map((n) => decide(amazonOrder(), ctx({ budget: budget(n) })).score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    const drops = scores.slice(1).map((s, i) => scores[i]! - s);
    expect(drops[3]!).toBeGreaterThan(drops[0]!);
  });

  it("spends the last slots only on valuable questions", () => {
    expect(decide(amazonOrder(), ctx({ budget: budget(0) })).ask).toBe(true);
    expect(decide(amazonOrder(), ctx({ budget: budget(3) }))).toMatchObject({ ask: false, suppressedBy: "low_value" });
    // Transfer-vs-spending on ₹50,000 is worth one of the last slots.
    expect(decide(bigDebit(), ctx({ budget: budget(4) })).ask).toBe(true);
  });

  it("charges extra for a question right after another one (no bursts)", () => {
    const fresh = decide(amazonOrder(), ctx({ budget: { askedLast7Days: 1, lastAskedAt: null, unansweredStreak: 0 } })).score;
    const burst = decide(amazonOrder(), ctx({ budget: { askedLast7Days: 1, lastAskedAt: T0 - 10 * MINUTE, unansweredStreak: 0 } })).score;
    const later = decide(amazonOrder(), ctx({ budget: { askedLast7Days: 1, lastAskedAt: T0 - 3 * HOUR, unansweredStreak: 0 } })).score;
    expect(burst).toBeLessThan(fresh);
    expect(later).toBeCloseTo(fresh, 10);
  });
});

/* ------------------------------------------------------------------ */
/* Question construction                                               */
/* ------------------------------------------------------------------ */

describe("category questions", () => {
  it("shows the top 2 predictions + Other… on a 3-button surface", () => {
    const q = asked(decide(amazonOrder(), ctx({ surface: { maxQuickActions: 3, supportsTextInput: false } })));
    expect(q.options.map((o) => o.id)).toEqual(["shopping", "household", "more"]);
    expect(q.options.at(-1)).toEqual(MORE_OPTION);
  });

  it("shows the top 3 predictions + Other… on a 4-button surface, merging subcategories", () => {
    const q = asked(decide(amazonOrder()));
    // shopping.online_marketplace (0.45) + shopping.electronics (0.15) are one "Shopping" choice.
    expect(q.options.map((o) => o.label)).toEqual(["Shopping", "Household", "Groceries", "Other…"]);
    expect(new Set(q.options.map((o) => o.id)).size).toBe(q.options.length);
  });

  it("never shows fifteen options, however large the surface", () => {
    const q = asked(decide(amazonOrder(), ctx({ surface: { maxQuickActions: 15, supportsTextInput: true } })));
    expect(q.options.length).toBeLessThanOrEqual(5);
    expect(q.options.at(-1)?.opensPicker).toBe(true);
  });

  it("fills thin predictions from what the user said before, then common choices", () => {
    const unknownShop = makeCandidate({
      minor: 230_000,
      merchant: { raw: "SRI BALAJI STORES", normalized: "sri_balaji_stores", displayName: "Sri Balaji Stores", confidence: 0.8, channel: "in_store" },
      transactionType: inference<TransactionType>("purchase", 0.9),
    });
    const withHistory = asked(
      decide(unknownShop, ctx({ model: { categories: { sri_balaji_stores: { entries: [{ value: "groceries", probability: 0.8 }], evidence: 1 } } } })),
    );
    expect(withHistory.options[0]?.id).toBe("groceries");
    const cold = asked(decide(unknownShop));
    expect(cold.options.map((o) => o.id)).toEqual(["shopping", "groceries", "eating_out", "more"]);
  });

  it("offers Work when the purchase may be a business expense", () => {
    const laptop = amazonOrder({
      attributes: { ...defaultAttributes(), ownership: inference("personal", 0.6, [["business", 0.4]]) },
    });
    expect(asked(decide(laptop)).options.map((o) => o.id)).toContain("work");
  });
});

describe("type questions (transfer vs spending)", () => {
  it("asks 'purchase or transfer?' about an ambiguous ₹50,000 debit, with both sides one tap away", () => {
    const d = decide(bigDebit());
    const q = asked(d);
    expect(q.kind).toBe("transaction_type");
    expect(q.prompt).toBe("₹50,000 at R K Sharma — was this a purchase or a transfer?");
    expect(q.options.map((o) => o.id)).toEqual(["purchase", "transfer", "own_transfer", "more"]);
    expect(d.reasons).toEqual(expect.arrayContaining(["possible_transfer_or_refund", "material_budget_impact"]));
  });

  it("uses the purchase's likely category as the spending answer (Rent)", () => {
    const q = asked(decide(bigDebit({ category: inference<CategoryId>("housing.rent", 0.6) })));
    expect(q.options[0]).toMatchObject({ id: "rent", label: "Rent" });
  });

  it("keeps a spending answer on screen even when non-spending types rank higher", () => {
    const c = bigDebit({
      transactionType: inference<TransactionType>("transfer", 0.36, [
        ["investment", 0.34],
        ["purchase", 0.3],
      ]),
    });
    const q = asked(decide(c, ctx({ surface: { maxQuickActions: 3, supportsTextInput: false } })));
    expect(q.options.map((o) => o.id)).toEqual(["transfer", "purchase", "more"]);
  });

  it("asks about an uninformed debit too", () => {
    const q = asked(decide(bigDebit({ transactionType: { value: "unknown", confidence: 0, alternatives: [], basis: ["none"], userSet: false } })));
    expect(q.kind).toBe("transaction_type");
  });

  it("uses a learned transfer kind for the counterparty (Family)", () => {
    const q = asked(
      decide(
        bigDebit(),
        // The user model keys payees by a hash of the handle, never the handle itself.
        ctx({ model: { transferKinds: { [counterpartyKey(bigDebit().counterparty)!]: { entries: [{ value: "family", probability: 0.9 }], evidence: 3 } } } }),
      ),
    );
    expect(q.options.map((o) => o.id)).toContain("family_transfer");
    expect(q.options.map((o) => o.id)).not.toContain("own_transfer");
  });

  it("asks what an incoming payment was (refund? transfer? income?)", () => {
    const credit = makeCandidate({
      minor: 200_000,
      direction: "credit",
      counterparty: { name: "Priya", handle: "priya@okhdfcbank" },
    });
    const q = asked(decide(credit));
    expect(q.kind).toBe("transaction_type");
    expect(q.prompt).toBe("₹2,000 received from Priya — what was this?");
    expect(q.options.map((o) => o.id)).toEqual(expect.arrayContaining(["refund", "transfer"]));
    expect(q.options.at(-1)?.id).toBe("more");
  });
});

describe("duplicate and existence questions", () => {
  it("asks 'same purchase?' about a possible duplicate", () => {
    const d = decide(amazonOrder({ links: [dupLink("cand_bank_alert")] }));
    const q = asked(d);
    expect(q.kind).toBe("same_event");
    expect(q.prompt).toBe("₹1,249 at Amazon — same purchase as one already listed?");
    expect(q.options.map((o) => o.label)).toEqual(["Same purchase", "Different"]);
    expect(d.reasons).toContain("possible_duplicate");
    expect(q.options.map((o) => optionAssertion(o.id))).toEqual([{ kind: "same_event" }, { kind: "different_events" }]);
  });

  it("asks about a duplicate even when the category is predictable", () => {
    const c = amazonOrder({ category: inference<CategoryId>("shopping", 0.95), links: [dupLink("cand_other")] });
    expect(asked(decide(c)).kind).toBe("same_event");
  });

  it("gives duplicate questions about different targets different ids", () => {
    const a = asked(decide(amazonOrder({ links: [dupLink("cand_a")] })));
    const b = asked(decide(amazonOrder({ links: [dupLink("cand_b")] })));
    expect(a.id).not.toBe(b.id);
  });

  it("asks whether a low-confidence candidate is a real transaction", () => {
    const shaky = makeCandidate({
      minor: 85_000,
      confidence: 0.45,
      merchant: { raw: "STARBUCKS", normalized: "starbucks", displayName: "Starbucks", confidence: 0.6, channel: "in_store" },
      transactionType: inference<TransactionType>("purchase", 0.9),
      category: inference<CategoryId>("eating_out.cafe", 0.9),
    });
    const d = decide(shaky);
    const q = asked(d);
    expect(q.kind).toBe("is_this_a_transaction");
    expect(q.prompt).toBe("Was this ₹850 transaction at Starbucks?");
    expect(q.options.map((o) => o.id)).toEqual(["yes_mine", "not_purchase", "not_mine"]);
    expect(q.options.find((o) => o.id === "not_purchase")?.opensPicker).toBe(true);
    expect(d.reasons).toContain("low_confidence");
    expect(optionAssertion("yes_mine")).toEqual({ kind: "confirm" });
    expect(optionAssertion("not_mine")).toEqual({ kind: "dismiss", reason: "not_mine" });
    expect(optionAssertion("shopping")).toBeNull();
    // Two-button surface: the picker covers "Not mine".
    const two = asked(decide(shaky, ctx({ surface: { maxQuickActions: 2, supportsTextInput: false } })));
    expect(two.options.map((o) => o.id)).toEqual(["yes_mine", "not_purchase"]);
  });
});

describe("prompt wording and identity", () => {
  it("matches the brief's confidence tiers", () => {
    expect(asked(decide(amazonOrder())).prompt).toBe("₹1,249 at Amazon — what was this?");
    expect(asked(decide(amazonOrder({ confidence: 0.7 }))).prompt).toBe(
      "Looks like you spent about ₹1,249 at Amazon. What was it for?",
    );
  });

  it("is deterministic: same inputs, same decision and question id", () => {
    const a = decide(amazonOrder());
    const b = decide(amazonOrder());
    expect(b).toEqual(a);
    const q = asked(a);
    expect(q.createdAt).toBe(T0);
    expect(q.expiresAt).toBe(T0 + QUESTION_TTL_MS);
    expect(QUESTION_TTL_MS).toBe(48 * HOUR);
    expect(asked(decide(amazonOrder(), ctx({ now: T0 + HOUR }))).id).toBe(q.id);
  });

  it("produces only kind, non-judgemental copy", () => {
    const questions: Question[] = [
      asked(decide(amazonOrder())),
      asked(decide(amazonOrder({ confidence: 0.7 }))),
      asked(decide(amazonOrder({ links: [dupLink("x")] }))),
      asked(decide(amazonOrder({ confidence: 0.7, links: [dupLink("x")] }))),
      asked(decide(amazonOrder({ confidence: 0.4, links: [dupLink("x")] }))),
      asked(decide(amazonOrder({ confidence: 0.4 }))),
      asked(decide(bigDebit())),
      asked(decide(bigDebit({ confidence: 0.7 }))),
      asked(decide(makeCandidate({ minor: 200_000, direction: "credit", counterparty: { name: "Priya" } }))),
      asked(decide(makeCandidate({ minor: 200_000, direction: "credit", confidence: 0.7, counterparty: { name: "Priya" } }))),
    ];
    expect(new Set(questions.map((q) => q.kind))).toEqual(new Set(["category", "same_event", "is_this_a_transaction", "transaction_type"]));
    for (const q of questions) expectToneClean(q);
    for (const o of [...EXISTENCE_OPTIONS, ...SAME_EVENT_OPTIONS]) expect(toneIssues(o.label)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Provider/country agnosticism                                        */
/* ------------------------------------------------------------------ */

describe("agnosticism", () => {
  /** The same economic situation in five currencies, rails and countries. */
  const markets = [
    { currency: "INR", locale: "en-IN", country: "IN", rail: { family: "account_to_account_instant", scheme: "upi" }, weekly: 800_000, price: 124_900 },
    { currency: "USD", locale: "en-US", country: "US", rail: { family: "card", scheme: "visa" }, weekly: 40_000, price: 6_245 },
    { currency: "EUR", locale: "en-IE", country: "IE", rail: { family: "account_to_account_batch", scheme: "sepa" }, weekly: 32_000, price: 4_996 },
    { currency: "BRL", locale: "pt-BR", country: "BR", rail: { family: "account_to_account_instant", scheme: "pix" }, weekly: 120_000, price: 18_735 },
    { currency: "KES", locale: "en-KE", country: "KE", rail: { family: "mobile_money", scheme: "mpesa" }, weekly: 1_500_000, price: 234_188 },
  ] as const;

  it("decides from amounts relative to the user's own spending, not from currency, rail or country", () => {
    const decisions = markets.map((m) =>
      decide(
        amazonOrder({
          amount: { value: money(m.price, m.currency), confidence: 0.99 },
          country: m.country,
          paymentRail: m.rail,
        }),
        ctx({ locale: m.locale, weeklySpendingBaseline: money(m.weekly, m.currency) }),
      ),
    );
    for (const d of decisions) {
      const q = asked(d);
      expect(q.kind).toBe("category");
      expect(q.options.map((o) => o.id)).toEqual(["shopping", "household", "groceries", "more"]);
      expect(d.reasons).toEqual(decisions[0]!.reasons);
      expect(d.score).toBeCloseTo(decisions[0]!.score, 2);
      expectToneClean(q);
    }
  });

  it("asks transfer-vs-spending for large ambiguous movements on any rail", () => {
    const cases = [
      { minor: 5_000_000, currency: "INR", locale: "en-IN", name: "R K Sharma", expected: "₹50,000" },
      { minor: 150_000, currency: "EUR", locale: "en-IE", name: "M Müller", expected: "€1,500" },
      { minor: 200_000, currency: "BRL", locale: "pt-BR", name: "Ana Souza", expected: "R$" },
      { minor: 4_500_000, currency: "KES", locale: "en-KE", name: "Wanjiku", expected: "45,000" },
      { minor: 120_000, currency: "USD", locale: "en-US", name: "Jordan Lee", expected: "$1,200" },
    ];
    for (const c of cases) {
      const d = decide(
        bigDebit({ amount: { value: money(c.minor, c.currency), confidence: 0.99 }, counterparty: { name: c.name, handle: `${c.name}@pay` } }),
        ctx({ locale: c.locale, weeklySpendingBaseline: null }),
      );
      const q = asked(d);
      expect(q.kind).toBe("transaction_type");
      expect(q.prompt).toContain(c.expected);
      expect(q.prompt).toContain(c.name);
      expect(q.options.some((o) => o.effect.field === "transaction_type" && o.effect.value === "transfer")).toBe(true);
      expectToneClean(q);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Review regressions                                                  */
/* ------------------------------------------------------------------ */

describe("review regressions", () => {
  const uninformedType = { value: "unknown" as TransactionType, confidence: 0, alternatives: [], basis: ["none" as const], userSet: false };

  it("does not collapse an incomplete type distribution into certainty", () => {
    // The classifier lists only supported values; the unlisted 50% is unknown, not "purchase".
    const halfSure = bigDebit({ transactionType: inference<TransactionType>("purchase", 0.5) });
    const split = typeSplit(halfSure);
    expect(split.pRelevant).toBeLessThan(0.9);
    expect(split.pRelevant).toBeCloseTo(0.8, 10); // 0.5 listed + 0.5 × the 0.6 uninformed purchase prior
    expect(split.ambiguity).toBeCloseTo(0.4, 10);
    const d = decide(halfSure);
    expect(asked(d).kind).toBe("transaction_type");
    expect(d.reasons).toContain("possible_transfer_or_refund");

    // 70% "unknown" + 30% transfer is not a settled transfer.
    const mostlyUnknown = bigDebit({ transactionType: inference<TransactionType>("unknown", 0.7, [["transfer", 0.3]]) });
    expect(typeSplit(mostlyUnknown).pRelevant).toBeGreaterThan(0.2);
    expect(decide(mostlyUnknown).suppressedBy).not.toBe("predictable");
    expect(asked(decide(mostlyUnknown)).kind).toBe("transaction_type");

    // No cliff between "almost nothing known" and "a little known".
    const a = typeSplit(bigDebit({ transactionType: inference<TransactionType>("transfer", 0.04) })).pRelevant;
    const b = typeSplit(bigDebit({ transactionType: inference<TransactionType>("transfer", 0.06) })).pRelevant;
    expect(Math.abs(a - b)).toBeLessThan(0.05);

    // Complete distributions are unchanged.
    expect(typeSplit(bigDebit()).ambiguity).toBeCloseTo(0.9, 5);
  });

  it("treats the ambiguity thresholds as inclusive despite floating point (P(transfer) = 0.2)", () => {
    // 1 − 0.8 is 0.19999999999999996 in floating point; the research's "P ≥ 0.2" must still ask.
    const c = bigDebit({ transactionType: inference<TransactionType>("purchase", 0.8, [["transfer", 0.2]]) });
    expect(typeSplit(c).ambiguity).toBeCloseTo(0.4, 10);
    expect(asked(decide(c)).kind).toBe("transaction_type");
    // Same boundary for the tiny-amount exemption: ₹40 with an evidenced 20% transfer chance.
    const tiny = makeCandidate({
      minor: 4_000,
      counterparty: { name: "Arjun", handle: "arjun@oksbi" },
      transactionType: inference<TransactionType>("purchase", 0.8, [["transfer", 0.2]]),
    });
    expect(decide(tiny).suppressedBy).not.toBe("tiny_amount");
  });

  it("keeps the tiny-amount rule for tiny payments whose type is simply unknown", () => {
    const chai = makeCandidate({
      minor: 4_000, // ₹40, no type inference yet
      merchant: { raw: "CHAI POINT", normalized: "chai_point", displayName: "Chai Point", confidence: 0.9, channel: "in_store" },
      transactionType: uninformedType,
      category: inference<CategoryId>("eating_out.cafe", 0.5, [["groceries", 0.3]]),
    });
    expect(decide(chai)).toMatchObject({ ask: false, suppressedBy: "tiny_amount" });
  });

  it("looks the counterparty up under the user model's hashed key", () => {
    const model = createUserModel();
    const cp = { name: "R K Sharma", handle: "rksharma@okicici" };
    for (let i = 0; i < 4; i++) {
      const prior = bigDebit({ id: `cand_rent_${i}`, counterparty: cp });
      model.observe(
        { id: `a_${i}`, at: T0 - (i + 1) * 30 * 24 * HOUR, anchors: [`obs_${i}`], kind: "label", field: "transaction_type", value: "transfer", transferKind: "family" },
        prior,
      );
    }
    const key = counterpartyKey(cp)!;
    expect(model.labelCount(key)).toBe(4);
    expect(model.labelCount(cp.handle)).toBe(0); // the raw handle is never a key

    const fresh = decide(bigDebit({ counterparty: cp }));
    const known = decide(bigDebit({ counterparty: cp }), { ...ctx(), userModel: model });
    expect(known.score).toBeLessThan(fresh.score);
    expect(known.reasons).not.toContain("improves_interventions");
    expect(asked(known).options.map((o) => o.id)).toContain("family_transfer");
  });

  it("does not re-offer an ownership the user already set", () => {
    const work = amazonOrder({ attributes: { ...defaultAttributes(), ownership: userInference("business") } });
    const ids = asked(decide(work)).options.map((o) => o.id);
    expect(ids).not.toContain("work");
    expect(ids.at(-1)).toBe("more");
  });

  it("does not call a possible transfer 'spending' in a medium-confidence type question", () => {
    const q = asked(decide(bigDebit({ confidence: 0.7 })));
    expect(q.kind).toBe("transaction_type");
    expect(q.prompt).not.toMatch(/spent/i);
    expect(q.prompt).toContain("₹50,000");
    expect(q.prompt).toContain("R K Sharma");
    expect(q.prompt).toMatch(/purchase or a transfer\?$/);
    expectToneClean(q);
  });

  it("never calls incoming money a purchase", () => {
    const credit = (p: Partial<TransactionCandidate> = {}) =>
      makeCandidate({ minor: 200_000, direction: "credit", counterparty: { name: "Priya", handle: "priya@okhdfcbank" }, ...p });
    const dup = asked(decide(credit({ links: [dupLink("cand_other_credit")] })));
    expect(dup.kind).toBe("same_event");
    expect(`${dup.prompt} ${dup.options.map((o) => o.label).join(" ")}`).not.toMatch(/purchase/i);
    expect(dup.options.map((o) => optionAssertion(o.id))).toEqual([{ kind: "same_event" }, { kind: "different_events" }]);
    const shaky = asked(decide(credit({ confidence: 0.4 })));
    expect(shaky.kind).toBe("is_this_a_transaction");
    expect(shaky.options.map((o) => o.label).join(" ")).not.toMatch(/purchase/i);
    expect(shaky.options.map((o) => o.id)).toEqual(["yes_mine", "not_purchase", "not_mine"]);
    // A possible duplicate own-account transfer is not a "purchase" either.
    const sweep = asked(decide(bigDebit({ transactionType: inference<TransactionType>("transfer", 0.9, [["purchase", 0.1]]), links: [dupLink("cand_leg")] })));
    expect(`${sweep.prompt} ${sweep.options.map((o) => o.label).join(" ")}`).not.toMatch(/purchase/i);
    for (const q of [dup, shaky, sweep]) expectToneClean(q);
  });

  it("'Yes, mine' confirms the transaction without claiming it was personal rather than business", () => {
    const yes = EXISTENCE_OPTIONS.find((o) => o.id === "yes_mine")!;
    expect(yes.effect.field).not.toBe("ownership");
    expect(optionAssertion("yes_mine")).toEqual({ kind: "confirm" });
  });

  it("does not ask 'was this a transaction?' about one the user already labeled", () => {
    const labeled = makeCandidate({
      minor: 85_000,
      confidence: 0.45,
      merchant: { raw: "STARBUCKS", normalized: "starbucks", displayName: "Starbucks", confidence: 0.6, channel: "in_store" },
      transactionType: inference<TransactionType>("purchase", 0.9),
      category: userInference<CategoryId>("eating_out.cafe"),
    });
    expect(decide(labeled).question?.kind).not.toBe("is_this_a_transaction");
  });

  it("ignores negligible duplicate links", () => {
    const c = amazonOrder({ category: inference<CategoryId>("shopping", 0.95), links: [dupLink("cand_far", 0.05)] });
    const d = decide(c);
    expect(d.question?.kind).not.toBe("same_event");
    expect(d.reasons).not.toContain("possible_duplicate");
  });

  it("treats a malformed surface as unable to ask", () => {
    expect(decide(amazonOrder(), ctx({ surface: { maxQuickActions: Number.NaN, supportsTextInput: false } })).suppressedBy).toBe(
      "surface_unsupported",
    );
    const big = asked(decide(amazonOrder(), ctx({ surface: { maxQuickActions: Number.POSITIVE_INFINITY, supportsTextInput: true } })));
    expect(big.options.length).toBeLessThanOrEqual(5);
  });
});
