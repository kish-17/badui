import { describe, expect, it } from "vitest";
import type { MerchantObservation } from "@brake/core";
import { cleanDescriptor, createMerchantNormalizer } from "../src/merchant";
import { foldText } from "../src/hints";
import { MERCHANT_PROFILES } from "../src/merchant-profiles";
import type { MerchantProfile } from "../src/merchant-profiles";
import { isKnownCategory } from "../src/taxonomy";
import { toneIssues } from "../src/copy";

const normalizer = createMerchantNormalizer();

function obs(p: Partial<MerchantObservation> & { raw: string }): MerchantObservation {
  return { confidence: 0.9, ...p };
}

describe("descriptor normalization — known merchants across markets", () => {
  // [raw descriptor as a source wrote it, expected key, expected display name]
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // Global card descriptors with processor prefixes and references
    ["AMZN Mktp US*2K4L80", "amazon", "Amazon"],
    ["Amazon Prime*2K4L80", "amazon_prime", "Amazon Prime"],
    ["PAYPAL *NETFLIX", "netflix", "Netflix"],
    ["NETFLIX.COM", "netflix", "Netflix"],
    ["SPOTIFY P1A2B3C4D5", "spotify", "Spotify"],
    ["APPLE.COM/BILL ITUNES.COM", "apple", "Apple"],
    ["Google *YouTubePremium", "youtube_premium", "YouTube Premium"],
    ["UBER *TRIP HELP.UBER.COM", "uber", "Uber"],
    ["UBER *EATS", "uber_eats", "Uber Eats"],
    ["SQ *BLUE BOTTLE COFFEE", "blue_bottle", "Blue Bottle Coffee"],
    ["McDonald's 4521", "mcdonalds", "McDonald's"],
    // India: bank narrations, UPI, wallets
    ["AMAZON PAY INDIA PRIVATE", "amazon", "Amazon"],
    ["POS 4512XXXX SWIGGY BANGALORE", "swiggy", "Swiggy"],
    ["UPI/627712345678/swiggy@icici/Payment", "swiggy", "Swiggy"],
    ["PAYTM*ZOMATO", "zomato", "Zomato"],
    ["UPI-ZEPTO MARKETPLACE PRIVATE LIMITED-zepto.payu@hdfcbank-HDFC0000001-627712345678-UPI", "zepto", "Zepto"],
    ["cred.club@axisb", "cred", "CRED"],
    ["ZERODHA BROKING LTD", "zerodha", "Zerodha"],
    ["PAYTM ADD MONEY", "paytm_wallet", "Paytm Wallet"],
    ["Disney+ Hotstar", "hotstar", "JioHotstar"],
    // United States
    ["WALMART.COM 8009256278 AR", "walmart", "Walmart"],
    ["WM SUPERCENTER #1234", "walmart", "Walmart"],
    ["STARBUCKS STORE 12345 SEATTLE WA", "starbucks", "Starbucks"],
    ["IRS USATAXPYMT 270469", "irs", "IRS"],
    ["AT&T BILL PAYMENT", "att", "AT&T"],
    ["DD *DOORDASH BURGERKIN", "doordash", "DoorDash"],
    // UK and EU
    ["CARD 1234 TESCO STORES 3145 LONDON GB", "tesco", "Tesco"],
    ["Sainsbury's S/mkts", "sainsburys", "Sainsbury's"],
    ["LIDL SAGT DANKE", "lidl", "Lidl"],
    ["REWE Markt GmbH", "rewe", "REWE"],
    ["DM FIL. 1234 BERLIN", "dm", "dm-drogerie markt"],
    // Brazil (Pix, card)
    ["PIX ENVIADO - MERCADO LIVRE", "mercado_livre", "Mercado Livre"],
    ["MERCADOPAGO*MERCADOLIVRE", "mercado_livre", "Mercado Livre"],
    ["IFD*IFOOD.COM AGENCIA DE RESTAURANTES", "ifood", "iFood"],
    ["99APP *99APP", "app_99", "99"],
    // Kenya (M-Pesa)
    ["M-PESA Buy Goods NAIVAS", "naivas", "Naivas"],
    ["Pay Bill KPLC PREPAID 888880", "kplc", "Kenya Power"],
    // South-East Asia
    ["GRAB* A-2K3J4L", "grab", "Grab"],
    ["GRAB*GRABFOOD", "grab_food", "GrabFood"],
    ["7-ELEVEN 12345", "seven_eleven", "7-Eleven"],
    ["TOKOPEDIA*PT TOKOPEDIA", "tokopedia", "Tokopedia"],
  ];

  it.each(cases)("%s -> %s", (raw, key, displayName) => {
    const n = normalizer.normalize(raw);
    expect(n).not.toBeNull();
    expect(n!.key).toBe(key);
    expect(n!.displayName).toBe(displayName);
    expect(n!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("covers at least 25 real-world descriptor shapes", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });
});

describe("descriptor normalization — unknown merchants", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["TST* DIG INN", "dig_inn", "Dig Inn"],
    ["SQ *JOES TACOS", "joes_tacos", "Joes Tacos"],
    ["JOE'S PIZZA #12", "joes_pizza", "Joe's Pizza"],
    ["POS 4512XXXX RAJ GENERAL STORE BANGALORE", "raj_general_store", "Raj General Store"],
    ["PIX ENVIADO - PADARIA SÃO JOSÉ LTDA", "padaria_sao_jose", "Padaria São José"],
    ["M-PESA Buy Goods MAMA MBOGA STALL", "mama_mboga_stall", "Mama Mboga Stall"],
    ["CB BOULANGERIE DU COIN PARIS", "boulangerie_du_coin", "Boulangerie du Coin"],
    ["BBQ HUT 77", "bbq_hut", "BBQ Hut"],
  ];

  it.each(cases)("%s -> %s", (raw, key, displayName) => {
    const n = normalizer.normalize(raw)!;
    expect(n.key).toBe(key);
    expect(n.displayName).toBe(displayName);
  });

  it("gives unknown merchants a lower confidence than known ones", () => {
    const unknown = normalizer.normalize("SQ *JOES TACOS")!;
    const known = normalizer.normalize("SQ *BLUE BOTTLE COFFEE")!;
    expect(unknown.confidence).toBeLessThan(0.6);
    expect(known.confidence).toBeGreaterThan(unknown.confidence);
  });

  it("returns null when a descriptor names no merchant at all", () => {
    for (const raw of ["", "   ", "UPI/123456789012/Payment", "ATM WDL 1234", "POS 4512XXXX", "NEFT 98765432"]) {
      expect(normalizer.normalize(raw)).toBeNull();
    }
  });

  it("hashes keys derived only from a payment handle (the payee may be a person)", () => {
    const n = normalizer.resolve("UPI/412345678901/priya.s@okaxis")!;
    expect(n.key).toMatch(/^h_[0-9a-z]+$/);
    expect(n.key).not.toContain("priya");
    expect(n.via).toBe("cleaned");
    expect(n.confidence).toBeLessThan(0.5);
  });
});

describe("cleanDescriptor", () => {
  it("separates intermediary, handle and domain from the merchant", () => {
    expect(cleanDescriptor("PAYPAL *NETFLIX").intermediary).toBe("paypal");
    expect(cleanDescriptor("PAYPAL *NETFLIX").merchantTokens).toEqual(["netflix"]);
    const upi = cleanDescriptor("UPI/627712345678/swiggy@icici/Payment");
    expect(upi.handles).toEqual(["swiggy@icici"]);
    expect(upi.tokenSource).toBe("handle");
    const apple = cleanDescriptor("APPLE.COM/BILL ITUNES.COM");
    expect(apple.domains).toEqual(["apple.com/bill", "itunes.com"]);
    const uber = cleanDescriptor("UBER *TRIP HELP.UBER.COM");
    expect(uber.merchantTokens).toEqual(["uber"]);
    expect(uber.matchTokens).toEqual(["uber", "trip"]);
  });

  it("strips rails, references, masked cards, legal suffixes and trailing locations", () => {
    expect(cleanDescriptor("POS 4512XXXX SWIGGY BANGALORE").merchantTokens).toEqual(["swiggy"]);
    expect(cleanDescriptor("AMZN Mktp US*2K4L80").merchantTokens).toEqual(["amzn", "mktp"]);
    expect(cleanDescriptor("PIX ENVIADO - PADARIA SAO JOSE LTDA").merchantTokens).toEqual(["padaria", "sao", "jose"]);
    expect(cleanDescriptor("STARBUCKS STORE 12345 NEW YORK NY").merchantTokens).toEqual(["starbucks", "store"]);
  });

  it("takes e-mail-like Pix keys as the merchant's domain", () => {
    expect(cleanDescriptor("PIX pagamentos@ifood.com.br").domains).toContain("ifood.com.br");
    expect(normalizer.normalize("PIX pagamentos@ifood.com.br")!.key).toBe("ifood");
  });
});

describe("matching precedence", () => {
  it("prefers the most specific pattern", () => {
    expect(normalizer.normalize("COSTCO GAS #0123")!.key).toBe("costco_gas");
    expect(normalizer.normalize("COSTCO WHSE #0123")!.key).toBe("costco");
    expect(normalizer.normalize("AMAZON PAY BALANCE TOPUP")!.key).toBe("amazon_pay_balance");
    expect(normalizer.normalize("SWIGGY INSTAMART")!.key).toBe("swiggy_instamart");
    expect(normalizer.normalize("SWIGGY")!.key).toBe("swiggy");
  });

  it("matches glued and split spellings", () => {
    expect(normalizer.normalize("HOMEDEPOT 6612")!.key).toBe("home_depot");
    expect(normalizer.normalize("BOOK MY SHOW")!.key).toBe("bookmyshow");
    expect(normalizer.normalize("Google *YouTubeMusic")!.key).toBe("youtube_premium");
  });

  it("does not match merchant names inside other words", () => {
    expect(normalizer.normalize("SHELLYS BAKERY")!.key).toBe("shellys_bakery");
    expect(normalizer.normalize("COCA COLA VENDING")!.key).not.toBe("ola");
  });

  it("is case-, accent- and punctuation-insensitive", () => {
    expect(normalizer.normalize("pão de açúcar 123")!.key).toBe("pao_de_acucar");
    expect(normalizer.normalize("PAO DE ACUCAR 123")!.key).toBe("pao_de_acucar");
  });
});

describe("resolve, key and similarity (MerchantMatcher)", () => {
  it("uses every field of a merchant observation", () => {
    expect(normalizer.resolve(obs({ raw: "ORDER 402-1234567", name: "Amazon.in" }))!.key).toBe("amazon");
    expect(normalizer.resolve(obs({ raw: "PAYMENT", handle: "zomato@hdfcbank" }))!.key).toBe("zomato");
    expect(normalizer.resolve(obs({ raw: "WEB PURCHASE", website: "https://www.netflix.com/" }))!.key).toBe("netflix");
    expect(normalizer.resolve(obs({ raw: "XYZ", key: "spotify" }))!.key).toBe("spotify");
  });

  it("keeps the intermediary that fronted the merchant", () => {
    expect(normalizer.resolve("PAYPAL *NETFLIX")!.intermediary).toBe("paypal");
    expect(normalizer.resolve("PAYPAL *NETFLIX")!.profile?.key).toBe("netflix");
  });

  it("returns a canonical key for fusion", () => {
    expect(normalizer.key(obs({ raw: "AMZN Mktp US*2K4L80" }))).toBe("amazon");
    expect(normalizer.key(obs({ raw: "UPI/123456789012/Payment" }))).toBeNull();
  });

  it("scores the same merchant under different descriptors as identical", () => {
    expect(normalizer.similarity(obs({ raw: "AMZN Mktp US*2K4L80" }), obs({ raw: "Amazon order", name: "Amazon.in" }))).toBe(1);
    expect(normalizer.similarity(obs({ raw: "UPI/627712345678/swiggy@icici/Payment" }), obs({ raw: "SWIGGY BANGALORE" }))).toBe(1);
    expect(normalizer.similarity(obs({ raw: "SQ *JOES TACOS" }), obs({ raw: "JOES TACOS 0042" }))).toBeGreaterThan(0.9);
  });

  it("scores different merchants as clearly different", () => {
    expect(normalizer.similarity(obs({ raw: "SWIGGY" }), obs({ raw: "ZOMATO" }))).toBeLessThan(0.1);
    expect(normalizer.similarity(obs({ raw: "RAJ GENERAL STORE" }), obs({ raw: "MAMA MBOGA STALL" }))).toBe(0);
  });

  it("gives partial credit to overlapping unknown names", () => {
    const s = normalizer.similarity(obs({ raw: "RAJ GENERAL STORE" }), obs({ raw: "RAJ GENERAL STORE KORAMANGALA" }));
    expect(s).toBeGreaterThan(0.6);
    expect(s).toBeLessThan(1);
  });
});

describe("payment intermediaries (processors, gateways, wallets)", () => {
  it("never lets the processor stand in for an unknown merchant behind it", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["PAYPAL *JOES TACOS", "joes_tacos", "paypal"],
      ["MERCADOPAGO*PADARIA SAO JOSE", "padaria_sao_jose", "mercadopago"],
      ["MERCADO PAGO*LOJA DO ZE", "loja_do_ze", "mercado pago"],
    ];
    for (const [raw, key, intermediary] of cases) {
      const r = normalizer.resolve(raw)!;
      expect(r.key, raw).toBe(key);
      expect(r.intermediary, raw).toBe(intermediary);
    }
  });

  it("keeps two merchants paid through the same processor apart", () => {
    const a = obs({ raw: "PAYPAL *JOES TACOS" });
    const b = obs({ raw: "PAYPAL *ACME TOOLS" });
    expect(normalizer.key(a)).not.toBe(normalizer.key(b));
    expect(normalizer.similarity(a, b)).toBeLessThan(0.5);
  });

  it("gives a processor-only descriptor no fusion key and no opinion on similarity", () => {
    for (const raw of ["PAYPAL", "PAYPAL *", "RAZORPAY PAYMENTS 98765", "GOOGLE"]) {
      expect(normalizer.key(obs({ raw })), raw).toBeNull();
    }
    // "Razorpay" says how the money moved, not who was paid: neither the same as nor different from Zomato.
    expect(normalizer.similarity(obs({ raw: "RAZORPAY PAYMENTS 98765" }), obs({ raw: "Your Zomato order", name: "Zomato" }))).toBe(0);
    expect(normalizer.similarity(obs({ raw: "RAZORPAY 1234" }), obs({ raw: "RAZORPAY 9876" }))).toBe(0);
    // Still shown for what it is, but at a confidence any real merchant name beats.
    const r = normalizer.normalize("RAZORPAY PAYMENTS 98765")!;
    expect(r.displayName).toBe("Razorpay");
    expect(r.confidence).toBeLessThan(0.5);
  });
});

describe("masked card numbers", () => {
  it("does not mistake a masked number's asterisks for a processor separator", () => {
    expect(normalizer.normalize("POS 4512****1234 RAJ GENERAL STORE")!.key).toBe("raj_general_store");
    expect(normalizer.normalize("VISA ****1234 PADARIA SAO JOSE")!.key).toBe("padaria_sao_jose");
    expect(normalizer.normalize("POS 4512****1234 SWIGGY BANGALORE")!.key).toBe("swiggy");
    // Two different shops paid with the same masked card must not share a key.
    const a = normalizer.key(obs({ raw: "CARD **1234 JOES TACOS" }));
    const b = normalizer.key(obs({ raw: "CARD **1234 ACME TOOLS" }));
    expect(a).not.toBe(b);
    expect(a).toContain("joes_tacos");
    // A single processor star still splits.
    expect(normalizer.resolve("SQ *JOES TACOS")!.intermediary).toBe("sq");
  });
});

describe("payment handles in narrations", () => {
  it("reads a handle out of a hyphen-delimited narration without swallowing its neighbours", () => {
    const c = cleanDescriptor("UPI-JOES CAFE-joescafe@ybl-YESB0000001-123456789012-NA");
    expect(c.handles).toEqual(["joescafe@ybl"]);
    expect(c.merchantTokens).toEqual(["joes", "cafe"]);
    expect(normalizer.normalize("UPI-RAMESH KUMAR-ramesh.k@okaxis-SBIN0001-123456789012-NA")!.key).toBe("ramesh_kumar");
  });

  it("matches merchant handles on a word boundary, not on any prefix", () => {
    expect(normalizer.resolve("UPI/412345678901/cred.club@axisb/Payment")!.key).toBe("cred");
    expect(normalizer.resolve("UPI/412345678901/zeptonow.payu@hdfcbank/Payment")!.key).toBe("zepto");
    expect(normalizer.resolve("UPI/412345678901/amazonpay@apl/Payment")!.key).toBe("amazon");
    // A payee whose handle merely starts with a short brand handle is not that brand (nor a card bill).
    expect(normalizer.resolve("UPI/412345678901/credencetech@ybl/Payment")!.key).not.toBe("cred");
    expect(normalizer.resolve("UPI/412345678901/uberto.rossi@okaxis/Payment")!.key).not.toBe("uber");
  });
});

describe("merchant families and common words", () => {
  it("treats sibling brands of one company as related, not as clearly different merchants", () => {
    const pairs: ReadonlyArray<readonly [MerchantObservation, MerchantObservation]> = [
      [obs({ raw: "AMAZON PAY INDIA PRIVATE" }), obs({ raw: "Your Amazon Prime membership", name: "Amazon Prime" })],
      [obs({ raw: "UPI/627712345678/swiggy@icici/Payment" }), obs({ raw: "Your Instamart order", name: "Swiggy Instamart" })],
      [obs({ raw: "UBER *TRIP HELP.UBER.COM" }), obs({ raw: "UBER *EATS" })],
    ];
    for (const [a, b] of pairs) {
      const s = normalizer.similarity(a, b);
      expect(s, `${a.raw} ~ ${b.raw}`).toBeGreaterThan(0.1);
      expect(s, `${a.raw} ~ ${b.raw}`).toBeLessThan(1);
    }
  });

  it("does not read a common word in a restaurant's name as a money-transfer brand", () => {
    expect(normalizer.normalize("WISE GUYS PIZZA")!.key).toBe("wise_guys_pizza");
    for (const raw of ["WISE", "TransferWise", "WISE PAYMENTS LIMITED", "WISE EUROPE SA"]) expect(normalizer.normalize(raw)!.key, raw).toBe("wise");
  });
});

describe("international text", () => {
  it("folds Latin letters that have no decomposition instead of dropping them", () => {
    expect(foldText("Großmarkt GmbH")).toBe("grossmarkt gmbh");
    expect(foldText("Żabka Łódź")).toBe("zabka lodz");
    expect(foldText("SMØRREBRØD ÆBLE")).toBe("smorrebrod aeble");
    expect(normalizer.normalize("BÄCKEREI GROẞMANN 12")!.key).toBe("backerei_grossmann");
  });

  it("keeps merchant names written in non-Latin scripts", () => {
    for (const raw of ["ร้านกาแฟ สตาร์", "Пятёрочка 1234", "सब्ज़ी मंडी"]) {
      const n = normalizer.normalize(raw);
      expect(n, raw).not.toBeNull();
      expect(n!.confidence, raw).toBeLessThan(0.6);
    }
    expect(normalizer.normalize("Пятёрочка 1234")!.displayName).toBe("Пятёрочка");
    expect(normalizer.similarity(obs({ raw: "Пятёрочка 1234" }), obs({ raw: "ПЯТЁРОЧКА 9876" }))).toBeGreaterThan(0.9);
  });
});

describe("learned aliases", () => {
  it("lets the user name an unknown merchant, and remembers it", () => {
    const n = createMerchantNormalizer();
    expect(n.resolve("RAJ GEN STR BLR 0042")!.via).toBe("cleaned");
    n.learnAlias("RAJ GEN STR BLR 0042", "Raj General Store");
    const r = n.resolve("POS 1234XXXX RAJ GEN STR BLR 0099")!;
    expect(r.key).toBe("raj_general_store");
    expect(r.displayName).toBe("Raj General Store");
    expect(r.via).toBe("learned");
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it("maps an alias onto a known merchant's profile", () => {
    const n = createMerchantNormalizer();
    n.learnAlias("BLR FOOD ORDER", "swiggy");
    const r = n.resolve("BLR FOOD ORDER")!;
    expect(r.profile?.key).toBe("swiggy");
    expect(r.displayName).toBe("Swiggy");
  });

  it("round-trips learned aliases through a new normalizer", () => {
    const a = createMerchantNormalizer();
    a.learnAlias("KAKA DHABA HIGHWAY", "kaka_dhaba");
    const b = createMerchantNormalizer({ learned: a.learnedAliases() });
    expect(b.normalize("KAKA DHABA HIGHWAY")!.key).toBe("kaka_dhaba");
    const c = createMerchantNormalizer({ learned: new Map([["KAKA DHABA HIGHWAY", "kaka_dhaba"]]) });
    expect(c.normalize("KAKA DHABA HIGHWAY")!.key).toBe("kaka_dhaba");
  });

  it("accepts a custom profile table", () => {
    const custom: MerchantProfile[] = [{ key: "corner_shop", displayName: "Corner Shop", category: "groceries", channel: "in_store", patterns: ["corner shop"] }];
    const n = createMerchantNormalizer({ profiles: custom });
    expect(n.normalize("THE CORNER SHOP 12")!.key).toBe("corner_shop");
    expect(n.normalize("NETFLIX.COM")!.key).toBe("netflix"); // falls back to a cleaned key, not the default table
    expect(n.profileFor("netflix")).toBeUndefined();
  });

  it("is deterministic", () => {
    const a = createMerchantNormalizer().resolve("POS 4512XXXX SWIGGY BANGALORE");
    const b = createMerchantNormalizer().resolve("POS 4512XXXX SWIGGY BANGALORE");
    expect(a).toEqual(b);
  });
});

describe("merchant profile table", () => {
  it("has at least 120 entries with unique keys", () => {
    expect(MERCHANT_PROFILES.length).toBeGreaterThanOrEqual(120);
    const keys = MERCHANT_PROFILES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every market BRAKE targets", () => {
    const keys = new Set(MERCHANT_PROFILES.map((p) => p.key));
    for (const k of ["swiggy", "flipkart", "walmart", "doordash", "tesco", "lidl", "mercado_livre", "ifood", "naivas", "safaricom", "grab", "shopee"]) {
      expect(keys.has(k)).toBe(true);
    }
  });

  it("uses only BRAKE taxonomy categories, with coherent alternatives", () => {
    for (const p of MERCHANT_PROFILES) {
      if (p.category !== null) expect(isKnownCategory(p.category), p.key).toBe(true);
      for (const [id, q] of p.alternatives ?? []) {
        expect(isKnownCategory(id), `${p.key}:${id}`).toBe(true);
        expect(q).toBeGreaterThan(0);
      }
      expect((p.alternatives ?? []).reduce((s, [, q]) => s + q, 0)).toBeLessThan(1);
      expect(p.patterns.length + (p.domains?.length ?? 0) + (p.handles?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it("encodes money-movement merchants as type hints, not categories", () => {
    const by = (k: string) => MERCHANT_PROFILES.find((p) => p.key === k)!;
    expect(by("cred").typeHint?.type).toBe("credit_card_payment");
    for (const k of ["zerodha", "groww", "vanguard", "robinhood"]) expect(by(k).typeHint?.type).toBe("investment");
    for (const k of ["paytm_wallet", "amazon_pay_balance"]) expect(by(k).typeHint).toMatchObject({ type: "transfer", transferKind: "wallet_load" });
    for (const k of ["irs", "income_tax", "hmrc", "receita_federal", "kra"]) expect(by(k).typeHint?.type).toBe("tax");
    for (const k of ["netflix", "spotify", "youtube_premium", "apple", "amazon_prime"]) expect(by(k).isSubscription).toBe(true);
  });

  it("has display names that read well in BRAKE's copy", () => {
    for (const p of MERCHANT_PROFILES) expect(toneIssues(`₹500 at ${p.displayName}`), p.key).toEqual([]);
  });
});
