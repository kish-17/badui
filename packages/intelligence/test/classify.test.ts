import { describe, expect, it } from "vitest";
import { DAY, money, unknownInference, userInference } from "@brake/core";
import type { CandidateMerchant, CategoryId, Inference, LineItem, Observation, TransactionCandidate, UserAssertion } from "@brake/core";
import { T0, inference, makeCandidate, makeObservation, makeSource } from "@brake/core/testing";
import { createClassifier } from "../src/classify";
import { keywordCategories, mapCategoryHint, mapMcc, mapMccType, normalizeMcc } from "../src/hints";
import { createMerchantNormalizer } from "../src/merchant";
import { counterpartyKey, createUserModel } from "../src/user-model";
import { topLevelCategory } from "../src/taxonomy";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const classifier = createClassifier();

function merchant(raw: string | null, p: Partial<CandidateMerchant> = {}): CandidateMerchant {
  return { raw, normalized: null, displayName: null, confidence: 0.6, channel: "unknown", ...p };
}

function cand(raw: string | null, p: Partial<TransactionCandidate> & { minor?: number; currency?: string } = {}): TransactionCandidate {
  return makeCandidate({ merchant: merchant(raw), ...p });
}

function ctx(userModel = createUserModel(), now = T0) {
  return { userModel, now };
}

function top(d: ReturnType<typeof mapCategoryHint>): string | undefined {
  return d?.entries[0]?.value;
}

function prob<T extends string>(inf: Inference<T> | undefined, v: T): number {
  if (!inf) return 0;
  return inf.value === v ? inf.confidence : (inf.alternatives.find((a) => a.value === v)?.probability ?? 0);
}

let n = 0;
function labelFor(c: TransactionCandidate, value: string, at = T0): UserAssertion {
  n += 1;
  return { id: `l${n}`, at, anchors: [`obs_l${n}`], kind: "label", field: "category", value };
}

/* ------------------------------------------------------------------ */
/* Hint mapping                                                         */
/* ------------------------------------------------------------------ */

describe("MCC mapping (ISO 18245)", () => {
  const mcc = (value: string) => mapCategoryHint({ scheme: "mcc", value, confidence: 0.9 });

  it.each([
    ["3000", "travel.flights"],
    ["3150", "travel.flights"],
    ["3299", "travel.flights"],
    ["4511", "travel.flights"],
    ["3501", "travel.lodging"],
    ["3999", "travel.lodging"],
    ["7011", "travel.lodging"],
    ["5411", "groceries"],
    ["5812", "eating_out.restaurant"],
    ["5814", "eating_out"],
    ["5541", "transport.fuel"],
    ["5542", "transport.fuel"],
    ["4111", "transport.public"],
    ["4112", "transport.public"],
    ["4131", "transport.public"],
    ["4121", "transport.rideshare"],
    ["4814", "bills.phone_internet"],
    ["4899", "bills.phone_internet"],
    ["4900", "bills.utilities"],
    ["5732", "shopping.electronics"],
    ["5734", "shopping.electronics"],
    ["5651", "shopping.clothing"],
    ["5691", "shopping.clothing"],
    ["5912", "health"],
    ["8011", "health"],
    ["8062", "health"],
    ["8099", "health"],
    ["8211", "education"],
    ["8299", "education"],
    ["7832", "entertainment.events"],
    ["9311", "taxes"],
    ["6300", "bills.insurance"],
    ["5300", "shopping"],
    ["5310", "shopping"],
    ["5311", "shopping"],
    ["5200", "household"],
    ["5251", "household"],
    ["0742", "pets"],
    ["5995", "pets"],
    ["6513", "housing.rent"],
  ])("%s -> %s", (code, expected) => {
    expect(top(mcc(code))).toBe(expected);
  });

  it("maps digital goods 5815–5818 to a streaming/gaming mixture", () => {
    for (const code of ["5815", "5816", "5817", "5818"]) {
      const values = mcc(code)!.entries.map((e) => e.value);
      expect(values.some((v) => v.startsWith("entertainment."))).toBe(true);
    }
    const d = mcc("5818")!.entries.map((e) => e.value);
    expect(d).toContain("entertainment.streaming");
    expect(d).toContain("entertainment.gaming");
  });

  it("returns no category for money-movement codes and lets type logic handle them", () => {
    for (const code of ["6010", "6011", "4829", "6051", "6211", "6540"]) expect(mcc(code)).toBeNull();
    expect(mapMccType("6011")).toMatchObject({ type: "cash_withdrawal" });
    expect(mapMccType("6211")).toMatchObject({ type: "investment" });
    expect(mapMccType("6540")).toMatchObject({ type: "transfer", transferKind: "wallet_load" });
    expect(mapMccType("9311")).toMatchObject({ type: "tax" });
    expect(mapMccType("5411")).toBeNull();
  });

  it("tells stored-value loads apart from person-to-person money transfers", () => {
    for (const code of ["6529", "6530", "6540"]) expect(mapMccType(code), code).toMatchObject({ type: "transfer", transferKind: "wallet_load" });
    for (const code of ["6532", "6534", "6536", "6537", "6538"]) {
      const t = mapMccType(code)!;
      expect(t.type, code).toBe("transfer");
      expect(t.transferKind, code).toBeUndefined();
    }
  });

  it("normalizes codes that lost leading zeros and treats placeholders as absent", () => {
    expect(normalizeMcc("742")).toBe("0742");
    expect(normalizeMcc(742)).toBe("0742");
    expect(normalizeMcc("0000")).toBeNull();
    expect(normalizeMcc("")).toBeNull();
    expect(normalizeMcc("54X1")).toBeNull();
    expect(top(mcc("742"))).toBe("pets");
    expect(mcc("0000")).toBeNull();
    expect(mcc("1234")).toBeNull(); // unassigned
  });

  it("weights a code by its specificity and the hint's confidence", () => {
    expect(mapMcc("5411")!.evidence).toBeGreaterThan(mapMcc("5999")!.evidence);
    expect(mapCategoryHint({ scheme: "mcc", value: "5411", confidence: 0.5 })!.evidence).toBeCloseTo(0.5 * mapMcc("5411")!.evidence, 6);
  });

  it("distributions are normalized", () => {
    for (const code of ["5300", "5812", "5818", "7997"]) {
      const total = mapMcc(code)!.entries.reduce((s, e) => s + e.probability, 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });
});

describe("keyword mapping", () => {
  const kw = (value: string) => top(mapCategoryHint({ scheme: "keyword", value, confidence: 0.8 }));

  it.each([
    ["groceries", "groceries"],
    ["supermarket", "groceries"],
    ["Supermercado", "groceries"],
    ["pharmacy", "health"],
    ["Farmácia", "health"],
    ["restaurant", "eating_out.restaurant"],
    ["cafe", "eating_out.cafe"],
    ["fuel", "transport.fuel"],
    ["petrol", "transport.fuel"],
    ["rent", "housing.rent"],
    ["aluguel", "housing.rent"],
    ["electricity", "bills.utilities"],
    ["broadband", "bills.phone_internet"],
    ["airtime", "bills.phone_internet"],
    ["insurance", "bills.insurance"],
    ["tuition", "education"],
    ["hotel", "travel.lodging"],
    ["airline", "travel.flights"],
    ["cinema", "entertainment.events"],
    ["streaming", "entertainment.streaming"],
    ["gym", "personal_care"],
    ["salon", "personal_care"],
    ["pet", "pets"],
  ])("%s -> %s", (word, expected) => {
    expect(kw(word)).toBe(expected);
  });

  it("accepts taxonomy labels and ids", () => {
    expect(kw("Eating out")).toBe("eating_out");
    expect(kw("Food delivery")).toBe("eating_out.delivery");
    expect(kw("shopping.electronics")).toBe("shopping.electronics");
  });

  it("returns null for words it does not know", () => {
    expect(mapCategoryHint({ scheme: "keyword", value: "zxqv", confidence: 0.9 })).toBeNull();
  });

  it("resolves conflicts inside a text by specificity", () => {
    expect(keywordCategories("Pedigree Adult Dog Food, Chicken & Vegetables")!.entries[0]!.value).toBe("pets");
    expect(keywordCategories("Dog shampoo")!.entries[0]!.value).toBe("pets");
    expect(keywordCategories("Hot dog combo")!.entries[0]!.value).toBe("eating_out");
    expect(keywordCategories("Chicken biryani")!.entries[0]!.value).toBe("eating_out.restaurant");
    expect(keywordCategories("USB-C Cable 1m")!.entries).toEqual([{ value: "shopping.electronics", probability: 1 }]);
    expect(keywordCategories("Cable TV")!.entries[0]!.value).toBe("bills.phone_internet");
  });
});

describe("brake and unknown schemes", () => {
  it("passes BRAKE ids through and backs off unknown sub-ids to their top level", () => {
    expect(mapCategoryHint({ scheme: "brake", value: "shopping.electronics", confidence: 0.9 })!.entries).toEqual([{ value: "shopping.electronics", probability: 1 }]);
    expect(top(mapCategoryHint({ scheme: "brake", value: "shopping.toys", confidence: 0.9 }))).toBe("shopping");
    expect(mapCategoryHint({ scheme: "brake", value: "nonsense", confidence: 0.9 })).toBeNull();
  });

  it("ignores provider vocabularies: adapters must translate them", () => {
    expect(mapCategoryHint({ scheme: "some_aggregator_v2", value: "FOOD_AND_DRINK_RESTAURANT", confidence: 0.9 })).toBeNull();
    expect(mapCategoryHint({ scheme: "mcc", value: "5411", confidence: 0 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

describe("line items — the brief's ₹4,799 Amazon order", () => {
  const items: LineItem[] = [
    { description: "Philips Sonicare Electric Toothbrush", total: money(249_900, "INR") },
    { description: "USB-C Cable 1m", total: money(50_000, "INR") },
    { description: "Pedigree Adult Dry Dog Food 3kg, Chicken & Vegetables", total: money(180_000, "INR") },
  ];
  const order = cand("AMAZON", { minor: 479_900, lineItems: items });
  const patch = classifier.classify(order, [], ctx());

  it("classifies the order as a mixture weighted by item totals", () => {
    const c = patch.category!;
    expect(c.value).toBe("personal_care");
    expect(c.alternatives.map((a) => a.value)).toEqual(["pets", "shopping.electronics"]);
    // Shares by item total: 52% / 37.5% / 10.4%.
    expect(c.confidence).toBeCloseTo(2499 / 4799, 1);
    expect(prob(c, "pets")).toBeCloseTo(1800 / 4799, 1);
    expect(prob(c, "shopping.electronics")).toBeCloseTo(500 / 4799, 1);
    expect(c.basis).toContain("line_items");
    expect(c.userSet).toBe(false);
  });

  it("still names the merchant and seeds a purchase", () => {
    expect(patch.merchantNormalized).toMatchObject({ key: "amazon", displayName: "Amazon" });
    expect(patch.transactionType!.value).toBe("purchase");
  });

  it("is not the marketplace answer it would give without items", () => {
    const plain = classifier.classify(cand("AMAZON"), [], ctx());
    expect(plain.category!.value).toBe("shopping.online_marketplace");
    expect(plain.category!.confidence).toBeLessThan(0.7); // marketplaces are genuinely mixed
  });

  it("reads items from a receipt observation when the candidate has none", () => {
    const receipt = makeObservation({ kind: "receipt", lineItems: items, source: makeSource({ kind: "email", adapterId: "mail", connectionId: "c_mail" }) });
    expect(classifier.classify(cand("AMAZON"), [receipt], ctx()).category!.value).toBe("personal_care");
  });

  it("splits evenly when items carry no amounts, and skips non-product lines", () => {
    const p = classifier.classify(
      cand("FLIPKART", {
        lineItems: [{ description: "Bluetooth headphones" }, { description: "Running shoes" }, { description: "Shipping" }, { description: "GST" }],
      }),
      [],
      ctx(),
    );
    expect(prob(p.category, "shopping.electronics")).toBeCloseTo(prob(p.category, "shopping.clothing"), 2);
    expect(prob(p.category, "shopping.electronics")).toBeGreaterThan(0.4);
  });

  it("falls back to merchant-level evidence for items it cannot read", () => {
    const p = classifier.classify(
      cand("TESCO STORES 3145", { currency: "GBP", lineItems: [{ description: "Tesco Finest 8pk", total: money(450, "GBP") }, { description: "Fairy Liquid detergent", total: money(150, "GBP") }] }),
      [],
      ctx(),
    );
    expect(p.category!.value).toBe("groceries");
    expect(prob(p.category, "household")).toBeGreaterThan(0.2);
  });

  it("uses the product of a pre-spend intent as its item", () => {
    const intent = makeObservation({ kind: "purchase_intent", stage: "intent", window: "pre_spend", intent: { via: "share", title: "Sony WH-1000XM5 Wireless Headphones" } });
    const p = classifier.classify(cand("CROMA", { status: "intent", direction: "unknown" }), [intent], ctx());
    expect(p.category!.value).toBe("shopping.electronics");
    expect(p.transactionType!.value).toBe("purchase");
  });
});

describe("multi-country merchants", () => {
  const cases: ReadonlyArray<readonly [string, string, string, string, string]> = [
    // [descriptor, currency, rail family, expected key, expected top-level category]
    ["UPI/627712345678/swiggy@icici/Payment", "INR", "account_to_account_instant", "swiggy", "eating_out"],
    ["POS 4512XXXX DMART AVENUE SUPERMARTS", "INR", "card", "dmart", "groceries"],
    ["WHOLEFDS MKT #10234 AUSTIN TX", "USD", "card", "whole_foods", "groceries"],
    ["CHEVRON 0091234", "USD", "card", "chevron", "transport"],
    ["TFL TRAVEL CH", "GBP", "card", "tfl", "transport"],
    ["LIDL SAGT DANKE", "EUR", "card", "lidl", "groceries"],
    ["SEPA LASTSCHRIFT TELEKOM DEUTSCHLAND GMBH", "EUR", "direct_debit", "telekom", "bills"],
    ["PIX ENVIADO - MERCADO LIVRE", "BRL", "account_to_account_instant", "mercado_livre", "shopping"],
    ["IFD*IFOOD.COM AGENCIA DE RESTAURANTES", "BRL", "card", "ifood", "eating_out"],
    ["M-PESA Buy Goods NAIVAS", "KES", "mobile_money", "naivas", "groceries"],
    ["Pay Bill KPLC PREPAID 888880", "KES", "mobile_money", "kplc", "bills"],
    ["GRAB* A-2K3J4L", "SGD", "card", "grab", "transport"],
  ];

  it.each(cases)("%s (%s) -> %s / %s", (raw, currency, family, key, category) => {
    const c = cand(raw, { currency, minor: 12_345, paymentRail: { family: family as TransactionCandidate["paymentRail"]["family"] } });
    const p = classifier.classify(c, [], ctx());
    expect(p.merchantNormalized?.key).toBe(key);
    expect(topLevelCategory(p.category!.value)).toBe(category);
    expect(p.category!.basis).toContain("merchant_profile");
    expect(p.transactionType!.value).toBe("purchase");
    expect(p.attributes?.essentiality?.value).not.toBe("unknown");
  });

  it("does not depend on which source, provider or country reported the payment", () => {
    const sources = [
      makeSource({ adapterId: "sms", kind: "sms", connectionId: "c_sms", provider: "Some Bank" }),
      makeSource({ adapterId: "open-banking", kind: "open_banking", connectionId: "c_ob", provider: "Another Bank" }),
      makeSource({ adapterId: "notification", kind: "notification", connectionId: "c_n" }),
    ];
    const patches = sources.flatMap((source) =>
      ["IN", "US", "BR", "KE", null].map((country) => {
        const o = makeObservation({ id: "obs_same", source, ...(country ? { country } : {}), merchant: { raw: "PAYPAL *NETFLIX", mcc: "4899", confidence: 0.9 } });
        return classifier.classify(cand("PAYPAL *NETFLIX", { country }), [o], ctx());
      }),
    );
    for (const p of patches) expect(p).toEqual(patches[0]);
  });
});

describe("evidence combination", () => {
  it("combines a merchant profile with an agreeing MCC", () => {
    const o = makeObservation({ merchant: { raw: "SWIGGY", mcc: "5812", confidence: 0.9 } });
    const p = classifier.classify(cand("POS 4512XXXX SWIGGY BANGALORE"), [o], ctx());
    expect(p.category!.value).toBe("eating_out.delivery");
    expect(p.category!.basis).toEqual(["merchant_profile", "source_hint"]);
    const eatingOut = [p.category!, ...p.category!.alternatives.map((a) => ({ value: a.value, confidence: a.probability }))]
      .filter((x) => topLevelCategory(x.value) === "eating_out")
      .reduce((s, x) => s + x.confidence, 0);
    expect(eatingOut).toBeGreaterThan(0.9);
  });

  it("classifies an unknown merchant from its MCC", () => {
    const p = classifier.classify(cand("JOES MARKET 123", { currency: "USD", merchant: merchant("JOES MARKET 123", { mcc: "5411" }) }), [], ctx());
    expect(p.category!.value).toBe("groceries");
    expect(p.category!.basis).toEqual(["source_hint"]);
    expect(p.category!.confidence).toBeLessThan(0.85); // a code is a merchant-level prior, not a fact
  });

  it("classifies an unknown merchant from words in its descriptor", () => {
    const p = classifier.classify(cand("PIX ENVIADO - SUPERMERCADO BOA VISTA", { currency: "BRL" }), [], ctx());
    expect(p.category!.value).toBe("groceries");
    expect(p.category!.confidence).toBeLessThan(0.7);
  });

  it("uses category hints from observations, deduplicated across sources", () => {
    const hint = { scheme: "keyword", value: "pharmacy", confidence: 0.8 };
    const a = makeObservation({ categoryHints: [hint] });
    const b = makeObservation({ categoryHints: [hint] });
    const one = classifier.classify(cand("MEDPLUS 0042"), [a], ctx());
    const two = classifier.classify(cand("MEDPLUS 0042"), [a, b], ctx());
    expect(one.category!.value).toBe("health");
    expect(two.category).toEqual(one.category);
  });

  it("states the top level when sure of it but split across sub-categories", () => {
    const hints = [
      { scheme: "brake", value: "eating_out.restaurant", confidence: 0.7 },
      { scheme: "brake", value: "eating_out.cafe", confidence: 0.7 },
    ];
    const p = classifier.classify(cand("NOODLE BAR 9"), [makeObservation({ categoryHints: hints })], ctx());
    expect(p.category!.value).toBe("eating_out");
    expect(p.category!.confidence).toBeGreaterThan(0.8);
  });

  it("gives an honest 'uncategorized' when there is no evidence", () => {
    const p = classifier.classify(makeCandidate(), [], ctx());
    expect(p.category).toEqual(unknownInference("uncategorized"));
    expect(p.attributes?.essentiality).toEqual(unknownInference("unknown"));
    expect(p.transactionType).toBeUndefined();
    expect(p.merchantNormalized).toBeUndefined();
    expect(p.attributes?.ownership).toBeUndefined();
    expect(p.attributes?.intent).toBeUndefined();
    expect(p.attributes?.purchaseContext).toBeUndefined();
  });

  it("is deterministic", () => {
    const c = cand("PAYPAL *NETFLIX");
    expect(classifier.classify(c, [], ctx())).toEqual(createClassifier().classify(c, [], ctx()));
  });
});

describe("essentiality", () => {
  it("follows the category's population prior", () => {
    expect(classifier.classify(cand("KPLC PREPAID"), [], ctx()).attributes?.essentiality?.value).toBe("essential");
    expect(classifier.classify(cand("STEAMGAMES.COM 4259522985"), [], ctx()).attributes?.essentiality?.value).toBe("discretionary");
  });

  it("is a mixture for mixed orders", () => {
    const p = classifier.classify(
      cand("AMAZON", { lineItems: [{ description: "Paracetamol tablets", total: money(10_000, "INR") }, { description: "PS5 video game", total: money(10_000, "INR") }] }),
      [],
      ctx(),
    );
    const e = p.attributes!.essentiality!;
    expect(prob(e, "essential")).toBeGreaterThan(0.3);
    expect(prob(e, "discretionary")).toBeGreaterThan(0.3);
  });

  it("is overridden by the user's own essentiality answers for the category", () => {
    const um = createUserModel();
    const swiggy = cand("SWIGGY", { merchant: merchant("SWIGGY", { normalized: "swiggy", confidence: 0.94 }), category: inference("eating_out.delivery", 0.9) });
    for (let i = 0; i < 4; i++) um.observe({ id: `e${i}`, at: T0, anchors: [`o${i}`], kind: "label", field: "essentiality", value: "essential" }, swiggy);
    const fresh = cand("SWIGGY");
    expect(classifier.classify(fresh, [], ctx()).attributes?.essentiality?.value).toBe("discretionary");
    const p = classifier.classify(fresh, [], ctx(um));
    expect(p.attributes?.essentiality?.value).toBe("essential");
    expect(p.attributes?.essentiality?.basis).toContain("user_history");
  });

  it("derives from a user-set category without touching the category", () => {
    const p = classifier.classify(cand("AMAZON", { category: userInference("gifts") }), [], ctx());
    expect(p.category).toBeUndefined();
    expect(p.attributes?.essentiality?.value).toBe("discretionary");
    // The population prior for the user's category; "user_label" belongs to the category, not to this inference.
    expect(p.attributes?.essentiality?.basis).toEqual(["prior"]);
    expect(p.attributes?.essentiality?.userSet).toBe(false);
  });
});

describe("transaction type seed", () => {
  it("treats a debit at a merchant as a purchase", () => {
    const t = classifier.classify(cand("STARBUCKS STORE 12345", { currency: "USD" }), [], ctx()).transactionType!;
    expect(t.value).toBe("purchase");
    expect(t.confidence).toBeGreaterThan(0.6);
    expect(t.confidence).toBeLessThan(0.9);
    expect(t.basis).toEqual(["prior"]);
  });

  it("lets the merchant profile's type hint win", () => {
    const cred = classifier.classify(cand("UPI/412345678901/cred.club@axisb/Payment"), [], ctx());
    expect(cred.transactionType!.value).toBe("credit_card_payment");
    expect(cred.category!.value).toBe("uncategorized"); // a card bill is not a spending category

    expect(classifier.classify(cand("ZERODHA BROKING LTD"), [], ctx()).transactionType!.value).toBe("investment");
    expect(classifier.classify(cand("VANGUARD BUY INVESTMENT", { currency: "USD" }), [], ctx()).transactionType!.value).toBe("investment");

    const load = classifier.classify(cand("PAYTM ADD MONEY"), [], ctx());
    expect(load.transactionType!.value).toBe("transfer");
    expect(load.transferKind).toBe("wallet_load");

    const irs = classifier.classify(cand("IRS USATAXPYMT 270469", { currency: "USD" }), [], ctx());
    expect(irs.transactionType!.value).toBe("tax");
    expect(irs.category!.value).toBe("taxes");
  });

  it("reads money-movement MCCs as type evidence", () => {
    const p = classifier.classify(cand("ATM WDL 1234", { merchant: merchant("ATM WDL 1234", { mcc: "6011" }) }), [], ctx());
    expect(p.transactionType!.value).toBe("cash_withdrawal");
    expect(p.category!.value).toBe("uncategorized");
  });

  it("uses adapter type hints", () => {
    const o = makeObservation({ typeHints: [{ type: "loan_payment", confidence: 0.85, reason: "narration:emi" }] });
    expect(classifier.classify(cand("BAJAJ FINANCE EMI"), [o], ctx()).transactionType!.value).toBe("loan_payment");
  });

  it("does not call a payment to a person a purchase, nor seed credits", () => {
    const p2p = makeCandidate({ counterparty: { name: "Ramesh Kumar", handle: "ramesh.k@okaxis", isMerchant: 0.1 } });
    expect(classifier.classify(p2p, [], ctx()).transactionType).toBeUndefined();
    expect(classifier.classify(cand("AMAZON", { direction: "credit" }), [], ctx()).transactionType).toBeUndefined();
  });

  it("does not call money moved to the user's own account a purchase", () => {
    const toSelf = cand("NEFT DR JOHN DOE", { counterparty: { name: "John Doe", isSelf: 0.95 } });
    expect(classifier.classify(toSelf, [], ctx()).transactionType?.value).not.toBe("purchase");
  });

  it("only seeds when the type is unknown or the classifier's own", () => {
    const reconciled = cand("ZERODHA BROKING LTD", { transactionType: { ...inference("transfer", 0.9), basis: ["reconciliation"] } });
    expect(classifier.classify(reconciled, [], ctx()).transactionType).toBeUndefined();
    const ownSeed = cand("ZERODHA BROKING LTD", { transactionType: { ...inference("purchase", 0.7), basis: ["prior"] } });
    expect(classifier.classify(ownSeed, [], ctx()).transactionType!.value).toBe("investment");
  });

  it("learns types per payee from the user", () => {
    const um = createUserModel();
    const rent = makeCandidate({ counterparty: { name: "S Landlord", handle: "landlord.s@okicici", isMerchant: 0.2 } });
    um.observe({ id: "t1", at: T0, anchors: ["o1"], kind: "label", field: "transaction_type", value: "purchase" }, rent);
    um.observe({ id: "c1", at: T0, anchors: ["o1"], kind: "label", field: "category", value: "housing.rent" }, rent);
    const next = makeCandidate({ counterparty: { name: "S Landlord", handle: "landlord.s@okicici", isMerchant: 0.2 } });
    const p = classifier.classify(next, [], ctx(um));
    expect(p.transactionType!.value).toBe("purchase");
    expect(p.transactionType!.basis).toEqual(["user_history"]);
    expect(p.category!.value).toBe("housing.rent");
    expect(counterpartyKey(next.counterparty)).toMatch(/^cp_/);
  });
});

describe("subscriptions and other attributes", () => {
  it("marks known subscription merchants as ~0.7 subscription, never certain", () => {
    const p = classifier.classify(cand("PAYPAL *NETFLIX", { currency: "USD", minor: 2299 }), [], ctx());
    const t = p.attributes!.temporalType!;
    expect(t.value).toBe("subscription");
    expect(t.confidence).toBeGreaterThan(0.6);
    expect(t.confidence).toBeLessThan(0.8);
    expect(t.basis).toEqual(["merchant_profile"]);
    expect(p.attributes!.intent!.value).toBe("recurring");
    expect(p.category!.value).toBe("entertainment.streaming");
  });

  it("is surer when a subscription charge was observed", () => {
    const charge = makeObservation({ kind: "subscription_event", subscription: { event: "charged", serviceName: "Spotify Premium" }, confidence: 0.95 });
    const p = classifier.classify(cand("SPOTIFY P1A2B3C4D5", { currency: "EUR", minor: 1099 }), [charge], ctx());
    expect(p.attributes!.temporalType!.confidence).toBeGreaterThan(0.9);
  });

  it("leaves ownership, intent and purchase context unknown without evidence", () => {
    const p = classifier.classify(cand("SQ *BLUE BOTTLE COFFEE", { currency: "USD" }), [], ctx());
    expect(p.attributes?.ownership).toBeUndefined();
    expect(p.attributes?.intent).toBeUndefined();
    expect(p.attributes?.purchaseContext).toBeUndefined();
    expect(p.attributes?.temporalType).toBeUndefined();
  });

  it("learns ownership and purchase context per merchant from the user", () => {
    const um = createUserModel();
    const office = cand("WEWORK 0042", { merchant: merchant("WEWORK 0042", { normalized: "wework", confidence: 0.6 }) });
    um.observe({ id: "w1", at: T0, anchors: ["o1"], kind: "label", field: "ownership", value: "business" }, office);
    um.observe({ id: "w2", at: T0, anchors: ["o2"], kind: "label", field: "ownership", value: "business" }, office);
    um.observe({ id: "w3", at: T0, anchors: ["o3"], kind: "label", field: "purchase_context", value: "planned_in_advance" }, office);
    const p = classifier.classify(cand("WEWORK 0042"), [], ctx(um));
    expect(p.attributes!.ownership!.value).toBe("business");
    expect(p.attributes!.ownership!.basis).toEqual(["user_history"]);
    expect(p.attributes!.ownership!.confidence).toBeLessThan(0.9); // two answers, not certainty
    expect(p.attributes!.purchaseContext!.value).toBe("planned_in_advance");
  });
});

describe("personal learning shifts predictions", () => {
  const amazon = () => cand("AMZN Mktp US*2K4L80", { merchant: merchant("AMZN Mktp US*2K4L80", { normalized: "amazon", displayName: "Amazon", confidence: 0.94 }) });

  it("puts household on top after the user labels Amazon household three times", () => {
    const um = createUserModel();
    const before = classifier.classify(amazon(), [], ctx(um)).category!;
    expect(before.value).toBe("shopping.online_marketplace");
    for (let i = 0; i < 3; i++) um.observe(labelFor(amazon(), "household", T0 - i * DAY), amazon());
    const after = classifier.classify(amazon(), [], ctx(um)).category!;
    expect(after.value).toBe("household");
    expect(after.confidence).toBeGreaterThan(0.8);
    expect(after.basis[0]).toBe("user_history");
    expect(after.basis).toContain("merchant_profile");
  });

  it("scales with evidence: one label shifts less than three", () => {
    const one = createUserModel();
    one.observe(labelFor(amazon(), "household"), amazon());
    const three = createUserModel();
    for (let i = 0; i < 3; i++) three.observe(labelFor(amazon(), "household"), amazon());
    const p1 = classifier.classify(amazon(), [], ctx(one)).category!;
    const p3 = classifier.classify(amazon(), [], ctx(three)).category!;
    expect(prob(p1, "household")).toBeLessThan(prob(p3, "household"));
    expect(prob(p1, "household")).toBeGreaterThan(prob(classifier.classify(amazon(), [], ctx()).category, "household"));
  });

  it("agrees with a profile sub-category when the user answers at the top level", () => {
    const um = createUserModel();
    const swiggy = cand("SWIGGY", { merchant: merchant("SWIGGY", { normalized: "swiggy", confidence: 0.94 }) });
    for (let i = 0; i < 3; i++) um.observe(labelFor(swiggy, "eating_out"), swiggy);
    const p = classifier.classify(swiggy, [], ctx(um)).category!;
    const without = classifier.classify(swiggy, [], ctx()).category!;
    // "Eating out" refines to the profile's "Food delivery" instead of competing with it.
    expect(p.value).toBe("eating_out.delivery");
    expect(p.confidence).toBeGreaterThanOrEqual(without.confidence - 0.01);
    expect(p.alternatives.filter((a) => topLevelCategory(a.value) !== "eating_out")).toEqual([]);
  });

  it("forgets old habits: recent labels outweigh two-year-old ones", () => {
    const um = createUserModel();
    const shop = cand("KIRANA KING 0042", { merchant: merchant("KIRANA KING 0042", { normalized: "kirana_king", confidence: 0.55 }) });
    for (let i = 0; i < 3; i++) um.observe(labelFor(shop, "shopping", T0 - 730 * DAY), shop);
    um.observe(labelFor(shop, "household", T0 - DAY), shop);
    const p = classifier.classify(shop, [], ctx(um)).category!;
    expect(p.value).toBe("household");
    expect(p.basis[0]).toBe("user_history");
  });

  it("decays history with the classification time", () => {
    const um = createUserModel();
    const shop = cand("ZQX TRADING 0042", { merchant: merchant("ZQX TRADING 0042", { normalized: "zqx_trading", confidence: 0.55 }) });
    um.observe(labelFor(shop, "household", T0), shop);
    const now = classifier.classify(shop, [], ctx(um, T0)).category!;
    const later = classifier.classify(shop, [], ctx(um, T0 + 3 * 365 * DAY)).category!;
    expect(now.value).toBe("household");
    expect(later.value).toBe("household");
    expect(later.confidence).toBeLessThan(now.confidence);
  });
});

describe("user-set and foreign inferences are never overwritten", () => {
  const userSetCandidate = cand("PAYPAL *NETFLIX", {
    category: userInference("education"),
    transactionType: userInference("business_expense"),
    attributes: {
      essentiality: userInference("essential"),
      intent: userInference("planned"),
      ownership: userInference("business"),
      temporalType: userInference("one_off"),
      purchaseContext: userInference("recommended"),
    },
  });

  it("omits every user-set field from the patch", () => {
    const p = classifier.classify(userSetCandidate, [], ctx());
    expect(p.category).toBeUndefined();
    expect(p.transactionType).toBeUndefined();
    expect(p.transferKind).toBeUndefined();
    expect(p.attributes ?? {}).toEqual({});
    expect(p.merchantNormalized?.key).toBe("netflix");
  });

  it("does not let learned history override a user-set field either", () => {
    const um = createUserModel();
    const nf = cand("PAYPAL *NETFLIX", { merchant: merchant("PAYPAL *NETFLIX", { normalized: "netflix", confidence: 0.94 }) });
    for (let i = 0; i < 5; i++) um.observe(labelFor(nf, "entertainment"), nf);
    expect(classifier.classify(userSetCandidate, [], ctx(um)).category).toBeUndefined();
  });

  it("leaves recurrence-owned temporal type and rule-owned category alone", () => {
    const c = cand("PAYPAL *NETFLIX", {
      category: { ...inference<CategoryId>("entertainment", 0.8), basis: ["rule"] },
      attributes: { ...makeCandidate().attributes, temporalType: { ...inference("recurring", 0.9), basis: ["recurrence"] } },
    });
    const p = classifier.classify(c, [], ctx());
    expect(p.category).toBeUndefined();
    expect(p.attributes?.temporalType).toBeUndefined();
    // Recurrence evidence still informs intent.
    expect(p.attributes?.essentiality).toBeDefined();
  });

  it("refines a weaker fused merchant key but keeps a more confident one", () => {
    const weak = classifier.classify(cand("AMZN Mktp US*2K4L80", { merchant: merchant("AMZN Mktp US*2K4L80", { normalized: "amzn mktp", confidence: 0.5 }) }), [], ctx());
    expect(weak.merchantNormalized?.key).toBe("amazon");
    const strong = classifier.classify(cand("JOES TACOS", { merchant: merchant("JOES TACOS", { normalized: "joes_tacos_downtown", displayName: "Joe's Tacos Downtown", confidence: 0.99 }) }), [], ctx());
    expect(strong.merchantNormalized).toBeUndefined();
  });

  it("accepts an injected normalizer with learned aliases", () => {
    const normalizer = createMerchantNormalizer();
    normalizer.learnAlias("BLR FOOD ORDER", "swiggy");
    const p = createClassifier({ normalizer }).classify(cand("BLR FOOD ORDER"), [], ctx());
    expect(p.merchantNormalized).toMatchObject({ key: "swiggy", displayName: "Swiggy" });
    expect(p.category!.value).toBe("eating_out.delivery");
  });
});

/** Apply a classifier patch to a candidate the way fusion does (patch fields replace, attributes merge). */
function applyPatch(c: TransactionCandidate, p: ReturnType<typeof classifier.classify>): TransactionCandidate {
  return {
    ...c,
    ...(p.category ? { category: p.category } : {}),
    ...(p.transactionType ? { transactionType: p.transactionType } : {}),
    ...(p.transferKind ? { transferKind: p.transferKind } : {}),
    ...(p.merchantNormalized
      ? { merchant: { ...c.merchant, normalized: p.merchantNormalized.key, displayName: p.merchantNormalized.displayName, confidence: p.merchantNormalized.confidence } }
      : {}),
    attributes: { ...c.attributes, ...(p.attributes ?? {}) },
  };
}

const sourceSeed = <T extends string>(value: T, confidence: number): Inference<T> => ({ value, confidence, alternatives: [], basis: ["source_hint"], userSet: false });

describe("type evidence from the observation itself is never thrown away", () => {
  it("keeps a charged subscription typed as a subscription", () => {
    const charge = makeObservation({ kind: "subscription_event", subscription: { event: "charged", serviceName: "Netflix" }, merchant: { raw: "NETFLIX.COM", confidence: 0.9 } });
    // Fusion seeds "subscription" from the observation kind; the classifier must not demote it to a plain purchase.
    const c = cand("NETFLIX.COM", { currency: "USD", minor: 2299, transactionType: sourceSeed("subscription", 0.8) });
    const p = classifier.classify(c, [charge], ctx());
    expect((p.transactionType ?? c.transactionType).value).toBe("subscription");
  });

  it("keeps a refund a refund, even from a merchant whose payments are card bills", () => {
    const notice = makeObservation({ kind: "refund_notice", direction: "credit", merchant: { raw: "CRED", confidence: 0.8 } });
    const c = cand("CRED", { direction: "credit", transactionType: sourceSeed("refund", 0.9) });
    const p = classifier.classify(c, [notice], ctx());
    expect((p.transactionType ?? c.transactionType).value).toBe("refund");
  });

  it("does not read a payee's type hint backwards on money coming in", () => {
    // Money *from* the tax authority is not a tax payment, and cashback from a bill-pay app is not a card bill.
    for (const raw of ["IRS TREAS 310 TAX REF", "CRED CASHBACK"]) {
      const p = classifier.classify(cand(raw, { direction: "credit" }), [], ctx());
      expect(p.transactionType?.value ?? "unknown", raw).not.toMatch(/^(tax|credit_card_payment)$/);
    }
    // Symmetric movements (wallet, broker) still read as what they are.
    const withdrawal = classifier.classify(cand("ZERODHA BROKING LTD", { direction: "credit" }), [], ctx());
    expect(withdrawal.transactionType!.value).toBe("investment");
  });
});

describe("derived inferences stay re-derivable", () => {
  it("re-derives essentiality when the user changes their category label", () => {
    const gift = cand("AMAZON", { category: userInference("gifts") });
    const first = applyPatch(gift, classifier.classify(gift, [], ctx()));
    expect(first.attributes.essentiality.value).toBe("discretionary");
    const relabelled = { ...first, category: userInference("groceries") };
    const p = classifier.classify(relabelled, [], ctx());
    expect(p.attributes?.essentiality?.value).toBe("essential");
  });

  it("only writes bases the classifier owns, so its own output never looks foreign", () => {
    const own = ["user_history", "merchant_profile", "source_hint", "line_items", "prior", "none"];
    const recurrence = { ...inference("subscription", 0.9), basis: ["recurrence" as const] };
    const c = cand("JOES GYM 0042", { category: userInference("personal_care"), attributes: { ...makeCandidate().attributes, temporalType: recurrence } });
    const p = classifier.classify(c, [], ctx());
    expect(p.attributes?.intent?.value).toBe("recurring");
    for (const inf of [p.attributes?.essentiality, p.attributes?.intent]) {
      expect(inf!.basis.every((b) => own.includes(b)), inf!.basis.join()).toBe(true);
    }
  });

  it("clears its own attributes and type once their evidence is gone", () => {
    // Earlier runs inferred these from a merchant BRAKE no longer believes in.
    const stale = cand("JOES TACOS 0042", {
      transactionType: { ...inference("investment", 0.8), basis: ["merchant_profile"] },
      attributes: {
        ...makeCandidate().attributes,
        temporalType: { ...inference("subscription", 0.7), basis: ["merchant_profile"] },
        intent: { ...inference("recurring", 0.6), basis: ["merchant_profile"] },
        ownership: { ...inference("business", 0.7), basis: ["user_history"] },
      },
    });
    const p = classifier.classify(stale, [], ctx());
    expect(p.transactionType!.value).toBe("purchase");
    expect(p.attributes?.temporalType).toMatchObject({ confidence: 0, userSet: false });
    expect(p.attributes?.intent).toMatchObject({ confidence: 0, userSet: false });
    expect(p.attributes?.ownership).toMatchObject({ confidence: 0, userSet: false });
    // ...but leaves what other engines own alone.
    const recurring = cand("JOES TACOS 0042", { attributes: { ...makeCandidate().attributes, temporalType: { ...inference("recurring", 0.9), basis: ["recurrence"] } } });
    expect(classifier.classify(recurring, [], ctx()).attributes?.temporalType).toBeUndefined();
  });

  it("re-classifying its own output is stable", () => {
    for (const raw of ["PAYPAL *NETFLIX", "UPI/627712345678/swiggy@icici/Payment", "SQ *JOES TACOS", "ZERODHA BROKING LTD"]) {
      const c = cand(raw);
      const once = applyPatch(c, classifier.classify(c, [makeObservation({ merchant: { raw, confidence: 0.9 } })], ctx()));
      const again = classifier.classify(once, [makeObservation({ merchant: { raw, confidence: 0.9 } })], ctx());
      expect(applyPatch(once, again), raw).toEqual(once);
    }
  });
});

describe("reversibility: a disconnected source's facts do not live on", () => {
  it("re-derives the merchant from the observations that remain, not from its own earlier answer", () => {
    // An order e-mail once named the merchant (Zomato); the user disconnected e-mail, so only the bank line remains.
    const bank = makeObservation({ merchant: { raw: "RAZORPAY PAYMENTS 98765", confidence: 0.9 } });
    const c = cand("RAZORPAY PAYMENTS 98765", { merchant: merchant("RAZORPAY PAYMENTS 98765", { normalized: "zomato", displayName: "Zomato", confidence: 0.94 }) });
    const p = classifier.classify(c, [bank], ctx());
    expect(p.merchantNormalized?.key).not.toBe("zomato");
    expect(p.merchantNormalized?.displayName).not.toBe("Zomato");
    expect(topLevelCategory(p.category!.value)).not.toBe("eating_out");
  });

  it("still keeps a confident key that a remaining observation supports", () => {
    const o = makeObservation({ merchant: { raw: "JOES TACOS", key: "joes_tacos_downtown", name: "Joe's Tacos Downtown", confidence: 0.99 } });
    const c = cand("JOES TACOS", { merchant: merchant("JOES TACOS", { normalized: "joes_tacos_downtown", displayName: "Joe's Tacos Downtown", confidence: 0.99 }) });
    expect(classifier.classify(c, [o], ctx()).merchantNormalized).toBeUndefined();
  });
});

describe("intermediaries in classification", () => {
  it("classifies the merchant behind a processor, not the processor", () => {
    const p = classifier.classify(cand("PAYPAL *JOES PIZZA", { currency: "USD" }), [], ctx());
    expect(p.merchantNormalized?.key).toBe("joes_pizza");
    expect(topLevelCategory(p.category!.value)).toBe("eating_out");
  });
});

describe("observations of every kind are read through normalized fields only", () => {
  it("resolves the merchant from an order e-mail when the bank descriptor is opaque", () => {
    const bank = makeObservation({ merchant: { raw: "RAZORPAY PAYMENTS 98765", confidence: 0.9 } });
    const order: Observation = makeObservation({ kind: "order", merchant: { raw: "Your Zomato order", name: "Zomato", confidence: 0.8 }, source: makeSource({ kind: "email", adapterId: "mail", connectionId: "c_mail" }) });
    const p = classifier.classify(cand("RAZORPAY PAYMENTS 98765"), [bank, order], ctx());
    expect(p.merchantNormalized?.key).toBe("zomato");
    expect(p.category!.value).toBe("eating_out.delivery");
  });

  it("gives a booking without other evidence a travel-leaning guess", () => {
    const booking = makeObservation({ kind: "booking", merchant: undefined });
    const p = classifier.classify(makeCandidate(), [booking], ctx());
    expect(topLevelCategory(p.category!.value)).toBe("travel");
    expect(p.category!.confidence).toBeLessThan(0.6);
  });
});
