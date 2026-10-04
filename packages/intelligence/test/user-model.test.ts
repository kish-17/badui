import { describe, expect, it } from "vitest";
import { DAY, userInference } from "@brake/core";
import type { LabelField, TransactionCandidate, UserAssertion } from "@brake/core";
import { T0, inference, makeCandidate } from "@brake/core/testing";
import { USER_MODEL_HALF_LIFE_DAYS, counterpartyKey, createUserModel, isLearnedUserModel } from "../src/user-model";

let n = 0;
function label(field: LabelField, at = T0, anchors?: string[]): UserAssertion {
  n += 1;
  return { id: `asrt_${n}`, at, anchors: anchors ?? [`obs_${n}`], kind: "label", ...field } as UserAssertion;
}

function at(merchantKey: string | null, p: Partial<TransactionCandidate> = {}): TransactionCandidate {
  return makeCandidate({
    merchant: { raw: merchantKey?.toUpperCase() ?? null, normalized: merchantKey, displayName: merchantKey, confidence: 0.9, channel: "unknown" },
    ...p,
  });
}

function probabilityOf<T extends string>(d: { entries: ReadonlyArray<{ value: T; probability: number }> } | null, v: T): number {
  return d?.entries.find((e) => e.value === v)?.probability ?? 0;
}

describe("user model — empty", () => {
  it("knows nothing before the user says anything", () => {
    const m = createUserModel();
    expect(m.categoryFor("amazon")).toBeNull();
    expect(m.typeFor("amazon")).toBeNull();
    expect(m.transferKindFor("cp_x")).toBeNull();
    expect(m.essentialityFor("groceries")).toBeNull();
    expect(m.labelCount("amazon")).toBe(0);
    expect(isLearnedUserModel(m)).toBe(true);
    expect(m.halfLifeDays).toBe(USER_MODEL_HALF_LIFE_DAYS);
  });
});

describe("user model — category labels", () => {
  it("counts labels per merchant key (Dirichlet-style)", () => {
    const m = createUserModel();
    const amazon = at("amazon");
    m.observe(label({ field: "category", value: "household" }), amazon);
    m.observe(label({ field: "category", value: "household" }), amazon);
    m.observe(label({ field: "category", value: "shopping" }), amazon);
    const d = m.categoryFor("amazon")!;
    expect(d.entries[0]).toEqual({ value: "household", probability: 2 / 3 });
    expect(probabilityOf(d, "shopping")).toBeCloseTo(1 / 3, 6);
    expect(d.evidence).toBeCloseTo(3, 6);
    expect(m.labelCount("amazon")).toBe(3);
    expect(m.categoryFor("flipkart")).toBeNull();
  });

  it("lets a correction replace the earlier answer for the same candidate", () => {
    const m = createUserModel();
    const c = at("zepto");
    m.observe(label({ field: "category", value: "shopping" }, T0, ["obs_zepto"]), c);
    m.observe(label({ field: "category", value: "groceries" }, T0 + 60_000, ["obs_zepto"]), c);
    const d = m.categoryFor("zepto")!;
    expect(d.entries).toEqual([{ value: "groceries", probability: 1 }]);
    expect(d.evidence).toBeCloseTo(1, 6);
    expect(m.labelCount("zepto")).toBe(1);
  });

  it("ignores a stale answer that arrives after a newer one, and re-deliveries", () => {
    const m = createUserModel();
    const c = at("zepto");
    const newer = label({ field: "category", value: "groceries" }, T0 + 60_000, ["obs_zepto"]);
    const older = label({ field: "category", value: "shopping" }, T0, ["obs_zepto"]);
    m.observe(newer, c);
    m.observe(older, c);
    m.observe(newer, c);
    expect(m.categoryFor("zepto")!.entries).toEqual([{ value: "groceries", probability: 1 }]);
    expect(m.labelCount("zepto")).toBe(1);
  });
});

describe("user model — recency", () => {
  it("halves the weight of an answer every ~180 days", () => {
    const m = createUserModel();
    const c = at("swiggy");
    m.observe(label({ field: "category", value: "eating_out" }, T0 - USER_MODEL_HALF_LIFE_DAYS * DAY), c);
    m.observe(label({ field: "category", value: "groceries" }, T0), c);
    const d = m.categoryFor("swiggy")!;
    expect(probabilityOf(d, "groceries")).toBeCloseTo(2 / 3, 6);
    expect(probabilityOf(d, "eating_out")).toBeCloseTo(1 / 3, 6);
    expect(d.evidence).toBeCloseTo(1.5, 6);
  });

  it("lets last week's habit outvote labels from two years ago", () => {
    const m = createUserModel();
    const c = at("target");
    for (let i = 0; i < 3; i++) m.observe(label({ field: "category", value: "shopping" }, T0 - 730 * DAY - i * DAY), c);
    m.observe(label({ field: "category", value: "groceries" }, T0 - 7 * DAY), c);
    expect(m.categoryFor("target")!.entries[0]!.value).toBe("groceries");
  });

  it("decays relative to the newest assertion, or a caller-supplied instant — never the wall clock", () => {
    const m = createUserModel();
    m.observe(label({ field: "category", value: "groceries" }, T0), at("naivas"));
    expect(m.asOf()).toBe(T0);
    expect(m.categoryFor("naivas")!.evidence).toBeCloseTo(1, 6);
    expect(m.categoryFor("naivas", T0 + 360 * DAY)!.evidence).toBeCloseTo(0.25, 6);
    // Reading at an earlier instant never inflates evidence.
    expect(m.categoryFor("naivas", T0 - 360 * DAY)!.evidence).toBeCloseTo(1, 6);
  });

  it("supports a custom half-life", () => {
    const m = createUserModel(undefined, { halfLifeDays: 30 });
    m.observe(label({ field: "category", value: "eating_out" }, T0 - 30 * DAY), at("ifood"));
    m.observe(label({ field: "category", value: "groceries" }, T0), at("ifood"));
    expect(probabilityOf(m.categoryFor("ifood"), "eating_out")).toBeCloseTo(1 / 3, 6);
  });
});

describe("user model — transaction types and transfer kinds", () => {
  it("learns types per merchant and per counterparty, and transfer kinds per counterparty", () => {
    const m = createUserModel();
    const toMum = makeCandidate({ counterparty: { name: "Asha Sharma", handle: "asha.sharma@okaxis", isMerchant: 0.05 } });
    m.observe(label({ field: "transaction_type", value: "transfer", transferKind: "family" }), toMum);
    m.observe(label({ field: "transaction_type", value: "transfer", transferKind: "family" }), toMum);
    const key = counterpartyKey(toMum.counterparty)!;
    expect(m.typeFor(key)!.entries[0]).toEqual({ value: "transfer", probability: 1 });
    expect(m.transferKindFor(key)!.entries[0]!.value).toBe("family");
    expect(m.labelCount(key)).toBe(2);
  });

  it("stores counterparties only as hashes", () => {
    const k = counterpartyKey({ handle: "Asha.Sharma@OKAXIS" })!;
    expect(k).toMatch(/^cp_[0-9a-z]+$/);
    expect(k).toBe(counterpartyKey({ handle: "asha.sharma@okaxis" }));
    expect(k).not.toContain("asha");
    expect(counterpartyKey({ name: "Wanjiku Kamau" })).toMatch(/^cp_/);
    expect(counterpartyKey(undefined)).toBeNull();
    expect(counterpartyKey({})).toBeNull();
    const m = createUserModel();
    m.observe(label({ field: "transaction_type", value: "transfer" }), makeCandidate({ counterparty: { handle: "asha.sharma@okaxis" } }));
    expect(JSON.stringify(m.toJSON())).not.toContain("asha");
  });

  it("learns that a merchant is a card bill payment", () => {
    const m = createUserModel();
    m.observe(label({ field: "transaction_type", value: "credit_card_payment" }), at("cred"));
    expect(m.typeFor("cred")!.entries[0]!.value).toBe("credit_card_payment");
  });
});

describe("user model — essentiality and attributes", () => {
  it("learns essentiality per category, rolled up to the top level", () => {
    const m = createUserModel();
    const delivery = at("swiggy", { category: inference("eating_out.delivery", 0.9) });
    m.observe(label({ field: "essentiality", value: "essential" }), delivery);
    m.observe(label({ field: "essentiality", value: "essential" }), delivery);
    expect(m.essentialityFor("eating_out.delivery")!.entries[0]!.value).toBe("essential");
    // A sibling with no answers of its own borrows the top level's.
    expect(m.essentialityFor("eating_out.cafe")!.entries[0]!.value).toBe("essential");
    expect(m.essentialityFor("groceries")).toBeNull();
  });

  it("does not learn essentiality for uncategorized candidates or 'unknown' answers", () => {
    const m = createUserModel();
    m.observe(label({ field: "essentiality", value: "essential" }), at("x"));
    m.observe(label({ field: "essentiality", value: "unknown" }), at("y", { category: inference("groceries", 0.9) }));
    expect(m.essentialityFor("uncategorized")).toBeNull();
    expect(m.essentialityFor("groceries")).toBeNull();
  });

  it("learns ownership, intent, temporal type and purchase context per merchant", () => {
    const m = createUserModel();
    const cowork = at("wework");
    m.observe(label({ field: "ownership", value: "business" }), cowork);
    m.observe(label({ field: "intent", value: "planned" }), cowork);
    m.observe(label({ field: "temporal_type", value: "recurring" }), cowork);
    m.observe(label({ field: "purchase_context", value: "convenience" }), cowork);
    expect(m.attributeFor("ownership", "wework")!.entries[0]!.value).toBe("business");
    expect(m.attributeFor("intent", "wework")!.entries[0]!.value).toBe("planned");
    expect(m.attributeFor("temporal_type", "wework")!.entries[0]!.value).toBe("recurring");
    expect(m.attributeFor("purchase_context", "wework")!.entries[0]!.value).toBe("convenience");
    expect(m.attributeFor("ownership", "amazon")).toBeNull();
    expect(m.labelCount("wework")).toBe(4);
  });
});

describe("user model — dismissals and confirmations", () => {
  it("learns 'not a transaction' for a merchant from dismissals", () => {
    const m = createUserModel();
    const promo = at("promo_sender");
    m.observe({ id: "d1", at: T0, anchors: ["o1"], kind: "dismiss", reason: "not_a_transaction" }, promo);
    m.observe({ id: "d2", at: T0, anchors: ["o2"], kind: "dismiss", reason: "not_a_transaction" }, promo);
    const e = m.existenceFor("promo_sender")!;
    expect(e.entries[0]).toEqual({ value: "not_a_transaction", probability: 1 });
    expect(e.evidence).toBeCloseTo(2, 6);
    expect(m.labelCount("promo_sender")).toBe(0);
  });

  it("does not learn from 'not mine' or 'duplicate' dismissals", () => {
    const m = createUserModel();
    m.observe({ id: "d1", at: T0, anchors: ["o1"], kind: "dismiss", reason: "not_mine" }, at("uber"));
    m.observe({ id: "d2", at: T0, anchors: ["o2"], kind: "dismiss", reason: "duplicate" }, at("uber"));
    expect(m.existenceFor("uber")).toBeNull();
  });

  it("treats labels as evidence the merchant's payments are real", () => {
    const m = createUserModel();
    m.observe({ id: "d1", at: T0, anchors: ["o1"], kind: "dismiss", reason: "not_a_transaction" }, at("bank_promo"));
    m.observe(label({ field: "category", value: "fees" }), at("bank_promo"));
    expect(m.existenceFor("bank_promo")!.entries.map((e) => e.value).sort()).toEqual(["not_a_transaction", "transaction"]);
  });

  it("reinforces what was shown when the user confirms, without double-counting user-set fields", () => {
    const m = createUserModel();
    m.observe({ id: "c1", at: T0, anchors: ["o1"], kind: "confirm" }, at("naivas", { category: inference("groceries", 0.8), transactionType: inference("purchase", 0.9) }));
    expect(m.categoryFor("naivas")!.entries[0]!.value).toBe("groceries");
    expect(m.typeFor("naivas")!.entries[0]!.value).toBe("purchase");
    m.observe({ id: "c2", at: T0, anchors: ["o2"], kind: "confirm" }, at("naivas", { category: userInference("groceries") }));
    expect(m.categoryFor("naivas")!.evidence).toBeCloseTo(1, 6);
    expect(m.labelCount("naivas")).toBe(2);
  });

  it("ignores satisfaction and fusion constraints", () => {
    const m = createUserModel();
    m.observe({ id: "s1", at: T0, anchors: ["o1"], kind: "satisfaction", value: "regretted", askedAt: T0 }, at("amazon"));
    m.observe({ id: "s2", at: T0, anchors: ["o1", "o2"], kind: "same_event" }, at("amazon"));
    m.observe({ id: "s3", at: T0, anchors: ["o1", "o3"], kind: "different_events" }, at("amazon"));
    expect(m.labelCount("amazon")).toBe(0);
    expect(m.existenceFor("amazon")).toBeNull();
  });
});

describe("user model — keys", () => {
  it("reads merchant keys the way it writes them (case and whitespace insensitive)", () => {
    const m = createUserModel();
    m.observe(label({ field: "category", value: "groceries" }), at("Naivas "));
    expect(m.categoryFor("naivas")!.entries[0]!.value).toBe("groceries");
    expect(m.categoryFor("Naivas")!.entries[0]!.value).toBe("groceries");
    expect(m.labelCount("NAIVAS")).toBe(1);
  });

  it("never keeps a payee's name in clear text, even when it is the merchant key", () => {
    // A P2P narration ("UPI/…/RAMESH KUMAR/…") gives the payee's name as the merchant key.
    const m = createUserModel();
    const toRamesh = at("ramesh_kumar", { counterparty: { name: "Ramesh Kumar", isMerchant: 0.1 } });
    m.observe(label({ field: "transaction_type", value: "transfer", transferKind: "family" }), toRamesh);
    m.observe(label({ field: "ownership", value: "family" }), toRamesh);
    const json = JSON.stringify(m.toJSON());
    expect(json.toLowerCase()).not.toContain("ramesh");
    expect(m.typeFor("ramesh_kumar")!.entries[0]!.value).toBe("transfer");
    expect(m.attributeFor("ownership", "ramesh_kumar")!.entries[0]!.value).toBe("family");
    expect(m.labelCount("ramesh_kumar")).toBe(2);
    const reloaded = createUserModel(JSON.parse(json));
    expect(reloaded.typeFor("ramesh_kumar")).toEqual(m.typeFor("ramesh_kumar"));
    expect(reloaded.labelCount("ramesh_kumar")).toBe(2);
  });

  it("reads a version-1 snapshot with clear-text keys and stops storing them", () => {
    const v1 = {
      version: 1,
      halfLifeDays: 180,
      asOf: T0,
      tables: {
        category: { amazon: [["a1", T0, "household", 1]] },
        attribute: { "ownership:ramesh_kumar": [["a2", T0, "family", 1]] },
        essentiality: { groceries: [["a3", T0, "essential", 1]] },
      },
      slots: { "label:category|obs_1": ["a1", T0] },
    };
    const m = createUserModel(v1);
    expect(m.categoryFor("amazon")!.entries[0]!.value).toBe("household");
    expect(m.attributeFor("ownership", "ramesh_kumar")!.entries[0]!.value).toBe("family");
    expect(m.essentialityFor("groceries")!.entries[0]!.value).toBe("essential");
    const json = JSON.stringify(m.toJSON());
    expect(json).not.toContain("ramesh");
    expect(json).not.toContain("amazon");
    expect((m.toJSON() as { version: number }).version).toBe(2);
  });

  it("keeps category ids (not personal) readable for essentiality", () => {
    const m = createUserModel();
    m.observe(label({ field: "essentiality", value: "essential" }), at("swiggy", { category: inference("eating_out.delivery", 0.9) }));
    expect(JSON.stringify(m.toJSON())).toContain("eating_out.delivery");
  });
});

describe("user model — persistence", () => {
  it("round-trips through JSON", () => {
    const a = createUserModel();
    a.observe(label({ field: "category", value: "household" }, T0 - 200 * DAY), at("amazon"));
    a.observe(label({ field: "category", value: "household" }, T0), at("amazon"));
    a.observe(label({ field: "transaction_type", value: "transfer", transferKind: "own_account" }), makeCandidate({ counterparty: { handle: "me@okhdfc" } }));
    a.observe(label({ field: "essentiality", value: "discretionary" }), at("starbucks", { category: inference("eating_out.cafe", 0.9) }));
    a.observe({ id: "d1", at: T0, anchors: ["o9"], kind: "dismiss", reason: "not_a_transaction" }, at("promo"));
    const json = JSON.parse(JSON.stringify(a.toJSON()));
    const b = createUserModel(json);
    expect(b.toJSON()).toEqual(a.toJSON());
    expect(b.categoryFor("amazon")).toEqual(a.categoryFor("amazon"));
    expect(b.essentialityFor("eating_out.cafe")).toEqual(a.essentialityFor("eating_out.cafe"));
    expect(b.existenceFor("promo")).toEqual(a.existenceFor("promo"));
    expect(b.labelCount("amazon")).toBe(2);
    expect(b.asOf()).toBe(T0);
  });

  it("keeps supersession working after a reload", () => {
    const a = createUserModel();
    a.observe(label({ field: "category", value: "shopping" }, T0, ["obs_1"]), at("zepto"));
    const b = createUserModel(JSON.parse(JSON.stringify(a.toJSON())));
    b.observe(label({ field: "category", value: "groceries" }, T0 + 1, ["obs_1"]), at("zepto"));
    expect(b.categoryFor("zepto")!.entries).toEqual([{ value: "groceries", probability: 1 }]);
  });

  it("starts empty from a malformed snapshot instead of throwing", () => {
    for (const bad of [null, 42, "x", { version: 2 }, { version: 1, tables: { category: { amazon: [["a", "not-a-time", "x", 1]] } } }]) {
      const m = createUserModel(bad);
      expect(m.categoryFor("amazon")).toBeNull();
    }
  });

  it("bounds what it stores per key", () => {
    const m = createUserModel();
    for (let i = 0; i < 260; i++) m.observe(label({ field: "category", value: i < 60 ? "shopping" : "household" }, T0 + i), at("amazon"));
    const d = m.categoryFor("amazon")!;
    expect(d.evidence).toBeLessThanOrEqual(200);
    expect(d.entries).toEqual([{ value: "household", probability: 1 }]); // the oldest answers were dropped first
  });
});
