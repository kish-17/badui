import type { CategoryId, MerchantChannel, Probability, TransactionType, TransferKind } from "@brake/core";

/**
 * Well-known merchants across markets, as *context* for classification.
 *
 * Merchants are not providers: naming Amazon or Swiggy here does not make
 * BRAKE depend on Amazon or Swiggy, it only tells the classifier what a
 * descriptor most likely means. Product logic never branches on a merchant
 * key; it reads the fields below (category, channel, type hint, subscription
 * flag) exactly as it would read them for a merchant it learned from the user.
 *
 * Entries are grouped by the market where the brand is most often seen, but
 * nothing reads the grouping: a Kenyan user paying Netflix and an Indian user
 * paying Uber resolve the same way.
 *
 * Pattern syntax (see merchant.ts):
 *   - plain strings are matched case/diacritic-insensitively on word
 *     boundaries against the cleaned descriptor ("trader joe's" matches
 *     "TRADER JOE S #552"); strings of 5+ characters also match glued
 *     spellings at the start of a word ("youtube premium" matches
 *     "YouTubePremium");
 *   - RegExps are tested against the folded (lower-case, accent-free) text;
 *   - `domains` match a domain or e-mail/Pix-key host by suffix, optionally
 *     with a path prefix ("apple.com/bill");
 *   - `handles` match the local part of a payment handle (UPI VPA) by prefix.
 */

export interface MerchantTypeHint {
  readonly type: TransactionType;
  readonly transferKind?: TransferKind;
  /** How reliably a payment to this merchant has this economic meaning. */
  readonly confidence: Probability;
}

export interface MerchantProfile {
  /** Stable canonical key ("amazon"). */
  readonly key: string;
  /** What BRAKE shows the user. */
  readonly displayName: string;
  readonly patterns: ReadonlyArray<string | RegExp>;
  readonly domains?: readonly string[];
  readonly handles?: readonly string[];
  /**
   * Most likely BRAKE category, or null for money-movement merchants
   * (brokers, wallets, bill-pay apps) whose payments are not spending at all —
   * their meaning lives in `typeHint`, not in a category.
   */
  readonly category: CategoryId | null;
  /**
   * Other plausible categories with their probabilities; `category` gets the
   * remainder. Marketplaces and hypermarkets are genuinely mixed, and saying
   * so keeps the classifier from overstating its confidence.
   */
  readonly alternatives?: ReadonlyArray<readonly [CategoryId, Probability]>;
  readonly channel: MerchantChannel;
  readonly typeHint?: MerchantTypeHint;
  /** Charges are usually a subscription (the classifier treats this as ~0.7, never as certain). */
  readonly isSubscription?: boolean;
}

type Extra = Pick<MerchantProfile, "domains" | "handles" | "alternatives" | "typeHint" | "isSubscription">;

function m(
  key: string,
  displayName: string,
  category: CategoryId | null,
  channel: MerchantChannel,
  patterns: ReadonlyArray<string | RegExp>,
  extra: Partial<Extra> = {},
): MerchantProfile {
  return { key, displayName, category, channel, patterns, ...extra };
}

const ON: MerchantChannel = "online";
const IN: MerchantChannel = "in_store";
const ANY: MerchantChannel = "unknown";

const SUB = { isSubscription: true } as const;
const INVESTMENT: MerchantTypeHint = { type: "investment", confidence: 0.85 };
const WALLET_LOAD: MerchantTypeHint = { type: "transfer", transferKind: "wallet_load", confidence: 0.85 };
const CARD_BILL: MerchantTypeHint = { type: "credit_card_payment", confidence: 0.8 };
const TAX: MerchantTypeHint = { type: "tax", confidence: 0.9 };
const P2P: MerchantTypeHint = { type: "transfer", transferKind: "p2p_other", confidence: 0.6 };
const REMITTANCE: MerchantTypeHint = { type: "transfer", confidence: 0.75 };
const LOAN: MerchantTypeHint = { type: "loan_payment", confidence: 0.8 };
const SAVINGS: MerchantTypeHint = { type: "transfer", transferKind: "own_account", confidence: 0.7 };

/** Software/cloud subscriptions: no "software" category in BRAKE's small taxonomy, so they read as bills. */
const SOFTWARE = { alternatives: [["shopping.electronics", 0.25]] as const, isSubscription: true };

export const MERCHANT_PROFILES: readonly MerchantProfile[] = [
  /* ---------------------------------------------------------------- */
  /* Global / multi-market                                             */
  /* ---------------------------------------------------------------- */
  m("amazon", "Amazon", "shopping.online_marketplace", ON,
    ["amazon", "amzn", "amzn mktp", "amazon mktplace", "amazon marketplace", "amazon pay india", "amazon retail", "amazon seller services"], {
      domains: ["amazon.com", "amazon.in", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.es", "amazon.it", "amazon.nl", "amazon.com.br", "amazon.sg", "amzn.com"],
      handles: ["amazon"],
      alternatives: [["shopping.electronics", 0.1], ["household", 0.1], ["groceries", 0.05], ["personal_care", 0.05], ["shopping.clothing", 0.05]],
    }),
  m("amazon_prime", "Amazon Prime", "entertainment.streaming", ON, ["amazon prime", "amzn prime", "prime video", "primevideo", "prime membership"], SUB),
  m("amazon_pay_balance", "Amazon Pay balance", null, ON, ["amazon pay balance", "amazon pay wallet", "amazonpay wallet", "add money to amazon pay", "amazon pay topup", "amazon pay top up"], { typeHint: WALLET_LOAD }),
  m("audible", "Audible", "entertainment.streaming", ON, ["audible"], { ...SUB, alternatives: [["education", 0.2]] }),
  m("kindle", "Kindle", "entertainment.streaming", ON, ["kindle", "kindle svcs", "kindle unlimited"], { alternatives: [["education", 0.3]] }),
  m("netflix", "Netflix", "entertainment.streaming", ON, ["netflix"], { domains: ["netflix.com"], ...SUB }),
  m("spotify", "Spotify", "entertainment.streaming", ON, ["spotify"], { domains: ["spotify.com"], ...SUB }),
  m("youtube_premium", "YouTube Premium", "entertainment.streaming", ON, ["youtube premium", "youtube music", "youtube tv", "youtube"], { domains: ["youtube.com"], ...SUB }),
  m("google_play", "Google Play", "entertainment.gaming", ON, ["google play", "googleplay"], { domains: ["play.google.com"], alternatives: [["entertainment.streaming", 0.4]] }),
  m("google_one", "Google One", "bills", ON, ["google one", "google storage", "googleone"], SOFTWARE),
  m("apple", "Apple", "entertainment.streaming", ON, ["apple com bill", "itunes", "apple services", "apple music", "icloud", "apple tv"], {
    domains: ["apple.com/bill", "itunes.com", "icloud.com"],
    alternatives: [["entertainment.gaming", 0.25], ["bills", 0.15]],
    isSubscription: true,
  }),
  m("apple_store", "Apple Store", "shopping.electronics", ANY, ["apple store", "apple online store", "apple retail"], { domains: ["apple.com"] }),
  m("microsoft_365", "Microsoft 365", "bills", ON, ["microsoft 365", "msft 365", "office 365", "microsoft office"], { domains: ["msbill.info"], ...SOFTWARE }),
  m("xbox", "Xbox", "entertainment.gaming", ON, ["xbox", "game pass", "microsoft xbox"], SUB),
  m("playstation", "PlayStation", "entertainment.gaming", ON, ["playstation", "playstation network", "sony playstation", "psn"]),
  m("steam", "Steam", "entertainment.gaming", ON, ["steam games", "steamgames", "steampowered", "steam purchase"], { domains: ["steampowered.com", "steamgames.com"] }),
  m("nintendo", "Nintendo", "entertainment.gaming", ON, ["nintendo"]),
  m("disney_plus", "Disney+", "entertainment.streaming", ON, ["disney plus", "disneyplus"], { domains: ["disneyplus.com"], ...SUB }),
  m("hbo_max", "Max", "entertainment.streaming", ON, ["hbo max", "hbomax"], { domains: ["max.com", "hbomax.com"], ...SUB }),
  m("openai", "ChatGPT", "bills", ON, ["openai", "chatgpt"], { domains: ["openai.com"], ...SOFTWARE }),
  m("adobe", "Adobe", "bills", ON, ["adobe", "adobe systems", "creative cloud"], { domains: ["adobe.com"], ...SOFTWARE }),
  m("dropbox", "Dropbox", "bills", ON, ["dropbox"], { domains: ["dropbox.com"], ...SOFTWARE }),
  m("canva", "Canva", "bills", ON, ["canva"], { domains: ["canva.com"], ...SOFTWARE }),
  m("uber", "Uber", "transport.rideshare", ON, ["uber", "uber trip", "uber bv", "uber india"], { domains: ["uber.com"], handles: ["uber"] }),
  m("uber_eats", "Uber Eats", "eating_out.delivery", ON, ["uber eats", "ubereats"], { domains: ["ubereats.com"] }),
  m("bolt", "Bolt", "transport.rideshare", ON, ["bolt", "bolt eu"], { domains: ["bolt.eu"] }),
  m("airbnb", "Airbnb", "travel.lodging", ON, ["airbnb"], { domains: ["airbnb.com"] }),
  m("booking_com", "Booking.com", "travel.lodging", ON, ["booking com", "bookingcom"], { domains: ["booking.com"] }),
  m("expedia", "Expedia", "travel", ON, ["expedia"], { domains: ["expedia.com"] }),
  m("agoda", "Agoda", "travel.lodging", ON, ["agoda"], { domains: ["agoda.com"] }),
  m("starbucks", "Starbucks", "eating_out.cafe", IN, ["starbucks", "sbux", "tata starbucks"]),
  m("mcdonalds", "McDonald's", "eating_out", IN, ["mcdonalds", "mcdonald", "mc donalds"]),
  m("kfc", "KFC", "eating_out", IN, ["kfc", "kentucky fried"]),
  m("dominos", "Domino's", "eating_out", ANY, ["dominos", "dominos pizza", "jubilant foodworks"]),
  m("pizza_hut", "Pizza Hut", "eating_out", ANY, ["pizza hut", "pizzahut"]),
  m("burger_king", "Burger King", "eating_out", IN, ["burger king", "burgerking"]),
  m("subway", "Subway", "eating_out", IN, ["subway"]),
  m("ikea", "IKEA", "household", ANY, ["ikea"]),
  m("hm", "H&M", "shopping.clothing", ANY, ["hm", "h m", "hennes mauritz"], { domains: ["hm.com"] }),
  m("zara", "Zara", "shopping.clothing", ANY, ["zara"]),
  m("uniqlo", "Uniqlo", "shopping.clothing", ANY, ["uniqlo"]),
  m("decathlon", "Decathlon", "shopping", ANY, ["decathlon"]),
  m("shell", "Shell", "transport.fuel", IN, ["shell", "shell oil", "shell service station"]),
  m("bp", "BP", "transport.fuel", IN, ["bp", "bp oil", "bp connect"]),
  m("paypal", "PayPal", null, ON, ["paypal"], { domains: ["paypal.com"] }),
  // "Wise" is a common word ("WISE GUYS PIZZA"); a type-changing hint must not fire on it, so the
  // bare word only matches when it is the whole merchant name.
  m("wise", "Wise", null, ON, ["transferwise", "wise payments", "wise europe", "wise us inc", /^wise$/], { domains: ["wise.com"], typeHint: REMITTANCE }),
  m("western_union", "Western Union", null, ANY, ["western union"], { typeHint: REMITTANCE }),
  m("coinbase", "Coinbase", null, ON, ["coinbase"], { typeHint: INVESTMENT }),
  m("binance", "Binance", null, ON, ["binance"], { typeHint: INVESTMENT }),
  m("shopee", "Shopee", "shopping.online_marketplace", ON, ["shopee"], { alternatives: [["shopping.clothing", 0.1], ["household", 0.1]] }),

  /* ---------------------------------------------------------------- */
  /* India                                                             */
  /* ---------------------------------------------------------------- */
  m("flipkart", "Flipkart", "shopping.online_marketplace", ON, ["flipkart", "fkrt", "flipkart internet", "flipkart payments"], {
    handles: ["flipkart", "fkrt"],
    alternatives: [["shopping.electronics", 0.15], ["shopping.clothing", 0.1], ["household", 0.05]],
  }),
  m("myntra", "Myntra", "shopping.clothing", ON, ["myntra"], { handles: ["myntra"] }),
  m("ajio", "AJIO", "shopping.clothing", ON, ["ajio"]),
  m("nykaa", "Nykaa", "personal_care", ON, ["nykaa", "fsn e commerce"]),
  m("meesho", "Meesho", "shopping.online_marketplace", ON, ["meesho"], { alternatives: [["shopping.clothing", 0.3]] }),
  m("swiggy", "Swiggy", "eating_out.delivery", ON, ["swiggy", "bundl technologies"], { handles: ["swiggy"] }),
  m("swiggy_instamart", "Swiggy Instamart", "groceries", ON, ["instamart", "swiggy instamart"], { handles: ["swiggyinstamart", "instamart"], alternatives: [["household", 0.15]] }),
  m("zomato", "Zomato", "eating_out.delivery", ON, ["zomato"], { handles: ["zomato"] }),
  m("blinkit", "Blinkit", "groceries", ON, ["blinkit", "grofers", "blink commerce"], { handles: ["blinkit"], alternatives: [["household", 0.15]] }),
  m("zepto", "Zepto", "groceries", ON, ["zepto", "zeptonow", "kiranakart"], { handles: ["zepto"], alternatives: [["household", 0.15]] }),
  m("bigbasket", "BigBasket", "groceries", ON, ["bigbasket", "big basket", "supermarket grocery supplies", "bbnow"], { handles: ["bigbasket"] }),
  m("dmart", "DMart", "groceries", IN, ["dmart", "d mart", "avenue supermarts"], { alternatives: [["household", 0.2], ["shopping.clothing", 0.05]] }),
  m("reliance_retail", "Reliance Retail", "groceries", ANY, ["reliance retail", "reliance smart", "reliance fresh", "jiomart", "smart bazaar"], { alternatives: [["household", 0.15], ["shopping", 0.15]] }),
  m("more_retail", "More", "groceries", IN, ["more retail", "more supermarket", "more hypermarket"]),
  m("tata_1mg", "Tata 1mg", "health", ON, ["1mg", "tata 1mg"]),
  m("apollo_pharmacy", "Apollo Pharmacy", "health", ANY, ["apollo pharmacy", "apollo pharmacies", "apollo health"]),
  m("pharmeasy", "PharmEasy", "health", ON, ["pharmeasy", "pharm easy"]),
  m("bookmyshow", "BookMyShow", "entertainment.events", ON, ["bookmyshow", "book my show", "bigtree entertainment"]),
  m("pvr_inox", "PVR INOX", "entertainment.events", IN, ["pvr", "inox", "pvr inox"]),
  m("irctc", "IRCTC", "transport.public", ON, ["irctc", "indian railway"], { alternatives: [["travel", 0.4]] }),
  m("makemytrip", "MakeMyTrip", "travel", ON, ["makemytrip", "make my trip"]),
  m("indigo", "IndiGo", "travel.flights", ON, ["indigo airlines", "interglobe aviation", "goindigo"], { domains: ["goindigo.in"] }),
  m("air_india", "Air India", "travel.flights", ON, ["air india"], { domains: ["airindia.com"] }),
  m("ola", "Ola", "transport.rideshare", ON, ["ola", "ola cabs", "olacabs", "ani technologies"], { handles: ["olacabs"] }),
  m("rapido", "Rapido", "transport.rideshare", ON, ["rapido", "roppen transportation"], { handles: ["rapido"] }),
  m("jio", "Jio", "bills.phone_internet", ON, ["jio", "reliance jio", "jio prepaid", "jio recharge", "jiofiber"]),
  m("airtel", "Airtel", "bills.phone_internet", ON, ["airtel", "bharti airtel", "airtel xstream"]),
  m("vi", "Vi", "bills.phone_internet", ON, ["vodafone idea", "vi prepaid", "vi postpaid"]),
  m("bescom", "BESCOM", "bills.utilities", ON, ["bescom"]),
  m("tata_power", "Tata Power", "bills.utilities", ON, ["tata power"]),
  m("adani_electricity", "Adani Electricity", "bills.utilities", ON, ["adani electricity"]),
  m("indane", "Indane Gas", "bills.utilities", ANY, ["indane"]),
  m("indian_oil", "IndianOil", "transport.fuel", IN, ["indian oil", "indianoil", "iocl"]),
  m("hpcl", "HPCL", "transport.fuel", IN, ["hpcl", "hindustan petroleum"]),
  m("bpcl", "BPCL", "transport.fuel", IN, ["bpcl", "bharat petroleum"]),
  m("cred", "CRED", null, ON, ["cred", "cred club", "dreamplug"], { handles: ["credclub", "cred"], typeHint: CARD_BILL }),
  m("zerodha", "Zerodha", null, ON, ["zerodha", "zerodha broking"], { handles: ["zerodha"], typeHint: INVESTMENT }),
  m("groww", "Groww", null, ON, ["groww", "nextbillion technology"], { handles: ["groww"], typeHint: INVESTMENT }),
  m("upstox", "Upstox", null, ON, ["upstox", "rksv"], { typeHint: INVESTMENT }),
  m("paytm_wallet", "Paytm Wallet", null, ON, ["paytm add money", "add money to paytm", "paytm wallet", "paytm wallet load"], { typeHint: WALLET_LOAD }),
  m("phonepe_wallet", "PhonePe Wallet", null, ON, ["phonepe wallet", "phonepe wallet topup"], { typeHint: WALLET_LOAD }),
  m("lic", "LIC", "bills.insurance", ANY, ["lic of india", "lic premium", "licindia", "life insurance corporation"]),
  m("income_tax", "Income Tax", "taxes", ON, ["income tax", "incometax", "tin nsdl", "oltas", "cbdt", "e pay tax"], { typeHint: TAX }),
  m("urban_company", "Urban Company", "household", ON, ["urban company", "urbanclap", "urban clap"], { alternatives: [["personal_care", 0.4]] }),
  m("lenskart", "Lenskart", "health", ANY, ["lenskart"], { alternatives: [["shopping", 0.3]] }),
  m("cult_fit", "cult.fit", "personal_care", ANY, ["cult fit", "cultfit", "curefit"], { ...SUB, alternatives: [["health", 0.3]] }),
  m("tanishq", "Tanishq", "shopping", IN, ["tanishq", "titan company"], { alternatives: [["gifts", 0.3]] }),
  m("croma", "Croma", "shopping.electronics", ANY, ["croma", "infiniti retail"]),
  m("reliance_digital", "Reliance Digital", "shopping.electronics", ANY, ["reliance digital"]),
  m("hotstar", "JioHotstar", "entertainment.streaming", ON, ["hotstar", "jiohotstar", "disney hotstar", "novi digital"], SUB),

  /* ---------------------------------------------------------------- */
  /* United States                                                     */
  /* ---------------------------------------------------------------- */
  m("walmart", "Walmart", "groceries", ANY, ["walmart", "wal mart", "wm supercenter", "walmart supercenter"], {
    domains: ["walmart.com"],
    alternatives: [["shopping", 0.3], ["household", 0.15]],
  }),
  m("target", "Target", "shopping", ANY, ["target"], { domains: ["target.com"], alternatives: [["groceries", 0.3], ["household", 0.15]] }),
  m("costco", "Costco", "groceries", IN, ["costco", "costco whse", "costco wholesale"], { alternatives: [["household", 0.2], ["shopping", 0.2]] }),
  m("costco_gas", "Costco Gas", "transport.fuel", IN, ["costco gas", "costco fuel"]),
  m("kroger", "Kroger", "groceries", IN, ["kroger"]),
  m("whole_foods", "Whole Foods", "groceries", IN, ["whole foods", "wholefds", "whole foods market"]),
  m("trader_joes", "Trader Joe's", "groceries", IN, ["trader joe", "trader joes"]),
  m("safeway", "Safeway", "groceries", IN, ["safeway"]),
  m("publix", "Publix", "groceries", IN, ["publix"]),
  m("aldi", "Aldi", "groceries", IN, ["aldi", "aldi sud", "aldi nord"]),
  m("instacart", "Instacart", "groceries", ON, ["instacart"]),
  m("doordash", "DoorDash", "eating_out.delivery", ON, ["doordash", "door dash"]),
  m("grubhub", "Grubhub", "eating_out.delivery", ON, ["grubhub"]),
  m("chipotle", "Chipotle", "eating_out.restaurant", IN, ["chipotle"]),
  m("dunkin", "Dunkin'", "eating_out.cafe", IN, ["dunkin"]),
  m("blue_bottle", "Blue Bottle Coffee", "eating_out.cafe", IN, ["blue bottle"]),
  m("sweetgreen", "sweetgreen", "eating_out.restaurant", IN, ["sweetgreen"]),
  m("cvs", "CVS Pharmacy", "health", IN, ["cvs", "cvs pharmacy"], { alternatives: [["personal_care", 0.3]] }),
  m("walgreens", "Walgreens", "health", IN, ["walgreens"], { alternatives: [["personal_care", 0.3]] }),
  m("home_depot", "The Home Depot", "household", IN, ["home depot", "homedepot"]),
  m("lowes", "Lowe's", "household", IN, ["lowes"]),
  m("best_buy", "Best Buy", "shopping.electronics", ANY, ["best buy", "bestbuy"]),
  m("chevron", "Chevron", "transport.fuel", IN, ["chevron"]),
  m("exxon", "ExxonMobil", "transport.fuel", IN, ["exxon", "exxonmobil", "mobil"]),
  m("att", "AT&T", "bills.phone_internet", ON, ["att", "att bill"], { domains: ["att.com"] }),
  m("verizon", "Verizon", "bills.phone_internet", ON, ["verizon", "vzwrlss", "verizon wireless"]),
  m("t_mobile", "T-Mobile", "bills.phone_internet", ON, ["t mobile", "tmobile"]),
  m("comcast", "Xfinity", "bills.phone_internet", ON, ["comcast", "xfinity"]),
  m("pge", "PG&E", "bills.utilities", ON, ["pge", "pacific gas", "pacific gas and electric"]),
  m("con_edison", "Con Edison", "bills.utilities", ON, ["con ed", "coned", "consolidated edison"]),
  m("geico", "GEICO", "bills.insurance", ON, ["geico"]),
  m("state_farm", "State Farm", "bills.insurance", ON, ["state farm"]),
  m("progressive", "Progressive", "bills.insurance", ON, ["progressive ins", "progressive insurance"]),
  m("irs", "IRS", "taxes", ON, ["irs", "usataxpymt", "irs usataxpymt"], { typeHint: TAX }),
  m("venmo", "Venmo", null, ON, ["venmo"], { typeHint: P2P }),
  m("zelle", "Zelle", null, ON, ["zelle"], { typeHint: { type: "transfer", transferKind: "p2p_other", confidence: 0.75 } }),
  m("cash_app", "Cash App", null, ON, ["cash app", "cashapp", "square cash"], { typeHint: P2P }),
  m("robinhood", "Robinhood", null, ON, ["robinhood"], { typeHint: INVESTMENT }),
  m("vanguard", "Vanguard", null, ON, ["vanguard"], { typeHint: INVESTMENT }),
  m("fidelity", "Fidelity", null, ON, ["fidelity investments", "fidelity"], { typeHint: INVESTMENT }),
  m("schwab", "Charles Schwab", null, ON, ["schwab", "charles schwab"], { typeHint: INVESTMENT }),
  m("delta", "Delta Air Lines", "travel.flights", ON, ["delta air", "delta airlines"], { domains: ["delta.com"] }),
  m("united_airlines", "United Airlines", "travel.flights", ON, ["united airlines", "united air"], { domains: ["united.com"] }),
  m("american_airlines", "American Airlines", "travel.flights", ON, ["american airlines", "american air"], { domains: ["aa.com"] }),
  m("southwest", "Southwest Airlines", "travel.flights", ON, ["southwest air", "southwest airlines"]),
  m("marriott", "Marriott", "travel.lodging", ANY, ["marriott"]),
  m("hilton", "Hilton", "travel.lodging", ANY, ["hilton"]),
  m("amc", "AMC Theatres", "entertainment.events", IN, ["amc", "amc theatres", "amc theaters"]),
  m("ticketmaster", "Ticketmaster", "entertainment.events", ON, ["ticketmaster"]),
  m("chewy", "Chewy", "pets", ON, ["chewy"], { domains: ["chewy.com"] }),
  m("petco", "Petco", "pets", ANY, ["petco"]),
  m("petsmart", "PetSmart", "pets", ANY, ["petsmart"]),
  m("planet_fitness", "Planet Fitness", "personal_care", IN, ["planet fitness", "planet fit"], { ...SUB, alternatives: [["health", 0.3]] }),
  m("peloton", "Peloton", "personal_care", ON, ["peloton"], { ...SUB, alternatives: [["health", 0.3]] }),
  m("nyt", "The New York Times", "entertainment.streaming", ON, ["new york times", "nytimes", "nyt"], { ...SUB, alternatives: [["education", 0.3]] }),

  /* ---------------------------------------------------------------- */
  /* United Kingdom                                                    */
  /* ---------------------------------------------------------------- */
  m("tesco", "Tesco", "groceries", IN, ["tesco", "tesco stores"], { alternatives: [["household", 0.1]] }),
  m("sainsburys", "Sainsbury's", "groceries", IN, ["sainsbury", "sainsburys", "js online grocery"]),
  m("asda", "Asda", "groceries", IN, ["asda"], { alternatives: [["household", 0.1]] }),
  m("morrisons", "Morrisons", "groceries", IN, ["morrisons", "wm morrison"]),
  m("waitrose", "Waitrose", "groceries", IN, ["waitrose"]),
  m("marks_spencer", "M&S", "groceries", IN, ["marks spencer", "marks and spencer", "m s simply food"], { alternatives: [["shopping.clothing", 0.4]] }),
  m("boots", "Boots", "health", IN, ["boots", "boots uk"], { alternatives: [["personal_care", 0.4]] }),
  m("pret", "Pret A Manger", "eating_out.cafe", IN, ["pret a manger", "pret"]),
  m("greggs", "Greggs", "eating_out", IN, ["greggs"]),
  m("costa", "Costa Coffee", "eating_out.cafe", IN, ["costa coffee"]),
  m("deliveroo", "Deliveroo", "eating_out.delivery", ON, ["deliveroo"]),
  m("just_eat", "Just Eat", "eating_out.delivery", ON, ["just eat", "justeat"]),
  m("tfl", "TfL", "transport.public", ANY, ["tfl", "transport for london", "tfl travel ch"]),
  m("trainline", "Trainline", "transport.public", ON, ["trainline"], { alternatives: [["travel", 0.3]] }),
  m("bt", "BT", "bills.phone_internet", ON, ["bt group", "british telecom", "bt broadband"], { domains: ["bt.com"] }),
  m("british_gas", "British Gas", "bills.utilities", ON, ["british gas"]),
  m("octopus_energy", "Octopus Energy", "bills.utilities", ON, ["octopus energy"]),
  m("thames_water", "Thames Water", "bills.utilities", ON, ["thames water"]),
  m("council_tax", "Council Tax", "taxes", ON, ["council tax"], { typeHint: TAX }),
  m("hmrc", "HMRC", "taxes", ON, ["hmrc", "hm revenue"], { typeHint: TAX }),
  m("argos", "Argos", "shopping", ANY, ["argos"]),
  m("currys", "Currys", "shopping.electronics", ANY, ["currys", "pc world"]),
  m("primark", "Primark", "shopping.clothing", IN, ["primark"]),
  m("john_lewis", "John Lewis", "shopping", ANY, ["john lewis"], { alternatives: [["household", 0.3]] }),
  m("sky", "Sky", "bills.phone_internet", ON, ["sky digital", "sky uk", "sky broadband", "sky subscription"], { ...SUB, alternatives: [["entertainment.streaming", 0.4]] }),
  m("vodafone", "Vodafone", "bills.phone_internet", ON, ["vodafone"]),
  m("ee", "EE", "bills.phone_internet", ON, ["ee limited", "ee mobile", "ee ltd"]),

  /* ---------------------------------------------------------------- */
  /* European Union                                                    */
  /* ---------------------------------------------------------------- */
  m("lidl", "Lidl", "groceries", IN, ["lidl"], { alternatives: [["household", 0.1]] }),
  m("carrefour", "Carrefour", "groceries", ANY, ["carrefour"], { alternatives: [["household", 0.15]] }),
  m("rewe", "REWE", "groceries", IN, ["rewe"]),
  m("edeka", "EDEKA", "groceries", IN, ["edeka"]),
  m("albert_heijn", "Albert Heijn", "groceries", IN, ["albert heijn", "ah to go"]),
  m("mercadona", "Mercadona", "groceries", IN, ["mercadona"]),
  m("metro_cash_carry", "METRO", "groceries", IN, ["metro cash carry", "metro cash and carry", "metro ag"], { alternatives: [["household", 0.2]] }),
  m("dm", "dm-drogerie markt", "personal_care", IN, ["dm drogerie", "dm drogeriemarkt", "dm fil"], { alternatives: [["household", 0.2], ["health", 0.1]] }),
  m("mediamarkt", "MediaMarkt", "shopping.electronics", ANY, ["mediamarkt", "media markt", "saturn electro"]),
  m("zalando", "Zalando", "shopping.clothing", ON, ["zalando"]),
  m("bol", "bol.com", "shopping.online_marketplace", ON, ["bol com"], { domains: ["bol.com"] }),
  m("deutsche_bahn", "Deutsche Bahn", "transport.public", ANY, ["deutsche bahn", "db fernverkehr", "db vertrieb", "db bahn"], { alternatives: [["travel", 0.3]] }),
  m("sncf", "SNCF", "transport.public", ANY, ["sncf", "sncf connect", "oui sncf"], { alternatives: [["travel", 0.3]] }),
  m("ns", "NS", "transport.public", ANY, ["ns reizigers", "ns groep"]),
  m("ryanair", "Ryanair", "travel.flights", ON, ["ryanair"]),
  m("easyjet", "easyJet", "travel.flights", ON, ["easyjet"]),
  m("lufthansa", "Lufthansa", "travel.flights", ON, ["lufthansa"]),
  m("klm", "KLM", "travel.flights", ON, ["klm", "air france klm"]),
  m("wolt", "Wolt", "eating_out.delivery", ON, ["wolt"]),
  m("glovo", "Glovo", "eating_out.delivery", ON, ["glovo"]),
  m("trade_republic", "Trade Republic", null, ON, ["trade republic"], { typeHint: INVESTMENT }),
  m("finanzamt", "Finanzamt", "taxes", ON, ["finanzamt"], { typeHint: TAX }),
  m("dgfip", "Impôts (DGFiP)", "taxes", ON, ["dgfip", "impots gouv", "direction generale des finances publiques"], { domains: ["impots.gouv.fr"], typeHint: TAX }),
  m("telekom", "Telekom", "bills.phone_internet", ON, ["telekom deutschland", "deutsche telekom"]),
  m("orange", "Orange", "bills.phone_internet", ON, ["orange sa", "orange france", "orange mobile"]),

  /* ---------------------------------------------------------------- */
  /* Brazil                                                            */
  /* ---------------------------------------------------------------- */
  m("mercado_livre", "Mercado Livre", "shopping.online_marketplace", ON, ["mercado livre", "mercadolivre", "mercadolibre", "mercado libre"], {
    domains: ["mercadolivre.com.br", "mercadolibre.com"],
    alternatives: [["shopping.electronics", 0.15], ["household", 0.1]],
  }),
  m("mercado_pago", "Mercado Pago", null, ON, ["mercado pago", "mercadopago"]),
  m("ifood", "iFood", "eating_out.delivery", ON, ["ifood", "ifd ifood"], { domains: ["ifood.com.br", "ifood.com"] }),
  m("rappi", "Rappi", "eating_out.delivery", ON, ["rappi"], { alternatives: [["groceries", 0.2]] }),
  m("pao_de_acucar", "Pão de Açúcar", "groceries", IN, ["pao de acucar", "gpa pao de acucar"]),
  m("assai", "Assaí Atacadista", "groceries", IN, ["assai", "assai atacadista"]),
  m("atacadao", "Atacadão", "groceries", IN, ["atacadao"]),
  m("magalu", "Magazine Luiza", "shopping.online_marketplace", ANY, ["magazine luiza", "magalu"], { alternatives: [["shopping.electronics", 0.3], ["household", 0.1]] }),
  m("americanas", "Americanas", "shopping.online_marketplace", ANY, ["americanas", "lojas americanas"]),
  m("casas_bahia", "Casas Bahia", "shopping.electronics", ANY, ["casas bahia"], { alternatives: [["household", 0.35]] }),
  m("drogasil", "Droga Raia / Drogasil", "health", IN, ["drogasil", "droga raia", "drogaraia", "raia drogasil"], { alternatives: [["personal_care", 0.3]] }),
  m("renner", "Renner", "shopping.clothing", IN, ["lojas renner", "renner"]),
  m("app_99", "99", "transport.rideshare", ON, ["99app", "99 app", "99 tecnologia", "99pop", "99 taxi"]),
  m("vivo_br", "Vivo", "bills.phone_internet", ON, ["telefonica brasil", "vivo fixo", "vivo movel", "vivo celular", "vivo fibra"]),
  m("claro", "Claro", "bills.phone_internet", ON, ["claro", "claro net"]),
  m("enel", "Enel", "bills.utilities", ON, ["enel", "enel distribuicao"]),
  m("sabesp", "Sabesp", "bills.utilities", ON, ["sabesp"]),
  m("receita_federal", "Receita Federal", "taxes", ON, ["receita federal", "darf", "simples nacional"], { typeHint: TAX }),
  m("nubank_card_bill", "Nubank card bill", null, ON, ["nubank fatura", "fatura nubank", "pagamento fatura nubank"], { typeHint: CARD_BILL }),
  m("xp_investimentos", "XP Investimentos", null, ON, ["xp investimentos", "xp inc"], { typeHint: INVESTMENT }),
  m("smart_fit", "Smart Fit", "personal_care", IN, ["smart fit", "smartfit"], { ...SUB, alternatives: [["health", 0.3]] }),
  m("petz", "Petz", "pets", ANY, ["petz"]),
  m("cobasi", "Cobasi", "pets", ANY, ["cobasi"]),

  /* ---------------------------------------------------------------- */
  /* Kenya                                                             */
  /* ---------------------------------------------------------------- */
  m("naivas", "Naivas", "groceries", IN, ["naivas"], { alternatives: [["household", 0.15]] }),
  m("quickmart", "Quickmart", "groceries", IN, ["quickmart", "quick mart"]),
  m("chandarana", "Chandarana Foodplus", "groceries", IN, ["chandarana"]),
  m("safaricom", "Safaricom", "bills.phone_internet", ON, ["safaricom", "safaricom airtime", "safaricom home fibre"]),
  m("kplc", "Kenya Power", "bills.utilities", ON, ["kplc", "kenya power", "kplc prepaid", "kplc postpaid"]),
  m("nairobi_water", "Nairobi Water", "bills.utilities", ON, ["nairobi water", "ncwsc"]),
  m("java_house", "Java House", "eating_out.cafe", IN, ["java house"]),
  m("artcaffe", "Artcaffé", "eating_out.cafe", IN, ["artcaffe"]),
  m("jumia", "Jumia", "shopping.online_marketplace", ON, ["jumia"], { alternatives: [["shopping.electronics", 0.2]] }),
  m("kra", "Kenya Revenue Authority", "taxes", ON, ["kra", "kenya revenue", "itax"], { typeHint: TAX }),
  m("sha", "Social Health Authority", "bills.insurance", ON, ["social health authority", "sha contribution", "nhif"]),
  m("fuliza", "Fuliza", null, ON, ["fuliza"], { typeHint: LOAN }),
  m("mshwari", "M-Shwari", null, ON, ["m shwari", "mshwari"], { typeHint: SAVINGS }),
  m("zuku", "Zuku", "bills.phone_internet", ON, ["zuku"]),
  m("goodlife_pharmacy", "Goodlife Pharmacy", "health", IN, ["goodlife pharmacy"]),

  /* ---------------------------------------------------------------- */
  /* South-East Asia                                                   */
  /* ---------------------------------------------------------------- */
  m("grab", "Grab", "transport.rideshare", ON, ["grab", "grabtaxi", "grabcar"], { alternatives: [["eating_out.delivery", 0.3]] }),
  m("grab_food", "GrabFood", "eating_out.delivery", ON, ["grabfood", "grab food"]),
  m("grabpay_topup", "GrabPay top-up", null, ON, ["grabpay top up", "grabpay topup", "grab top up"], { typeHint: WALLET_LOAD }),
  m("gojek", "Gojek", "transport.rideshare", ON, ["gojek", "go jek"], { alternatives: [["eating_out.delivery", 0.3]] }),
  m("lazada", "Lazada", "shopping.online_marketplace", ON, ["lazada"]),
  m("tokopedia", "Tokopedia", "shopping.online_marketplace", ON, ["tokopedia"]),
  m("foodpanda", "foodpanda", "eating_out.delivery", ON, ["foodpanda", "food panda"]),
  m("seven_eleven", "7-Eleven", "groceries", IN, ["7 eleven", "7eleven", "seven eleven"], { alternatives: [["eating_out", 0.3]] }),
  m("fairprice", "FairPrice", "groceries", IN, ["fairprice", "ntuc fairprice", "ntuc fp"]),
  m("cold_storage", "Cold Storage", "groceries", IN, ["cold storage"]),
  m("watsons", "Watsons", "personal_care", IN, ["watsons"], { alternatives: [["health", 0.3]] }),
  m("guardian_health", "Guardian", "health", IN, ["guardian health", "guardian pharmacy"], { alternatives: [["personal_care", 0.3]] }),
  m("singtel", "Singtel", "bills.phone_internet", ON, ["singtel"]),
  m("starhub", "StarHub", "bills.phone_internet", ON, ["starhub"]),
  m("globe", "Globe Telecom", "bills.phone_internet", ON, ["globe telecom"]),
  m("pln", "PLN", "bills.utilities", ON, ["pln", "perusahaan listrik negara", "token listrik"]),
  m("traveloka", "Traveloka", "travel", ON, ["traveloka"]),
  m("airasia", "AirAsia", "travel.flights", ON, ["airasia", "air asia"]),
  m("singapore_airlines", "Singapore Airlines", "travel.flights", ON, ["singapore airlines", "singapore air"]),
  m("jollibee", "Jollibee", "eating_out", IN, ["jollibee"]),
  m("gcash_cash_in", "GCash cash-in", null, ON, ["gcash cash in", "gcash top up", "gcash topup"], { typeHint: WALLET_LOAD }),
  m("tng_reload", "Touch 'n Go reload", null, ON, ["touch n go reload", "tng ewallet reload", "tng reload"], { typeHint: WALLET_LOAD }),
  m("sm_supermarket", "SM Supermarket", "groceries", IN, ["sm supermarket", "sm hypermarket"]),
  m("ez_link", "EZ-Link", "transport.public", ANY, ["ez link", "ezlink", "simplygo"]),
];
