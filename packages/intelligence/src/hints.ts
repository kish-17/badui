import { clamp01 } from "@brake/core";
import type { CategoryHint, CategoryId, TransactionType, TransferKind } from "@brake/core";
import type { Distribution } from "./contracts";
import { CATEGORIES, isKnownCategory, topLevelCategory } from "./taxonomy";

/**
 * Provider-neutral category hints → BRAKE taxonomy.
 *
 * Only *standard* vocabularies are mapped here: BRAKE's own ids, ISO 18245
 * merchant category codes and plain-language keywords. Provider-specific
 * vocabularies (an aggregator's category enum, a bank's narration codes) are
 * translated by the adapter that understands them, so this module — and
 * everything that consumes it — never learns which provider is behind a hint.
 *
 * Every mapping returns a *distribution*, not a label: an MCC is a
 * merchant-level prior (a supercenter coded 5411 also sells TVs), and a word
 * like "cable" can mean a USB cable or a TV bill.
 */

type Mix = CategoryId | ReadonlyArray<readonly [CategoryId, number]>;

/* ------------------------------------------------------------------ */
/* Text folding (shared with merchant normalization)                    */
/* ------------------------------------------------------------------ */

/** Lower-case and strip diacritics, keeping punctuation: "PÃO DE AÇÚCAR" -> "pao de acucar". */
export function foldAccents(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Fold text for vocabulary matching: accent-free lower case, apostrophes and
 * "&" glued ("McDonald's" -> "mcdonalds", "AT&T" -> "att"), every other
 * non-alphanumeric character a single space.
 */
export function foldText(text: string): string {
  return foldAccents(text)
    .replace(/['’`´&]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Distributions                                                        */
/* ------------------------------------------------------------------ */

function toEntries(mix: Mix): Array<{ value: CategoryId; probability: number }> {
  if (typeof mix === "string") return [{ value: mix, probability: 1 }];
  const total = mix.reduce((s, [, p]) => s + p, 0);
  return mix
    .map(([value, p]) => ({ value, probability: total > 0 ? p / total : 0 }))
    .sort((a, b) => b.probability - a.probability || a.value.localeCompare(b.value));
}

function distribution(mix: Mix, evidence: number): Distribution<CategoryId> {
  return { entries: toEntries(mix), evidence: clamp01(evidence) };
}

/** Average several mixes with equal weight (used when several keywords agree or conflict). */
function averageMixes(mixes: readonly Mix[]): Mix {
  const acc = new Map<CategoryId, number>();
  for (const mix of mixes) {
    for (const { value, probability } of toEntries(mix)) acc.set(value, (acc.get(value) ?? 0) + probability / mixes.length);
  }
  return [...acc.entries()];
}

/* ------------------------------------------------------------------ */
/* ISO 18245 merchant category codes                                     */
/* ------------------------------------------------------------------ */

interface MccRule {
  /** null: the code describes how money moved (cash, transfers, securities), not what was bought. */
  readonly mix: Mix | null;
  /**
   * How much the code says about *this* purchase. 5814 (fast food) is
   * specific; 5999 (misc. retail) or 5311 (department store) is barely a hint.
   */
  readonly specificity: number;
}

const SPECIFIC = 0.85;
const BROAD = 0.6;
const VAGUE = 0.3;

const CAR_RENTAL: Mix = [["travel", 0.6], ["transport", 0.4]];
const DIGITAL: Mix = [["entertainment.streaming", 0.45], ["entertainment.gaming", 0.35], ["entertainment", 0.2]];
const EATING_OUT_SPLIT: Mix = [["eating_out.restaurant", 0.7], ["eating_out", 0.15], ["eating_out.delivery", 0.1], ["eating_out.cafe", 0.05]];

/**
 * [code or "from-to" range, mix, specificity]. Exact codes win over ranges.
 * Codes describing money movement map to null so the type logic (cash
 * withdrawal, transfer, investment) handles them instead of a category.
 */
const MCC_TABLE: ReadonlyArray<readonly [string, Mix | null, number]> = [
  // Agriculture, contractors
  ["0742", "pets", SPECIFIC],
  ["0763", "groceries", BROAD],
  ["0780", "household", BROAD],
  ["1520-1799", "household", BROAD],
  ["2741", [["education", 0.5], ["entertainment", 0.5]], BROAD],
  ["2842", "household", BROAD],
  // Airlines (brand codes), car rental (brand codes), lodging (brand codes)
  ["3000-3350", "travel.flights", SPECIFIC],
  ["3351-3500", CAR_RENTAL, SPECIFIC],
  ["3501-3999", "travel.lodging", SPECIFIC],
  // Transport
  ["4011", "transport", BROAD],
  ["4111", "transport.public", SPECIFIC],
  ["4112", [["transport.public", 0.7], ["travel", 0.3]], SPECIFIC],
  ["4119", "health", BROAD], // ambulance services
  ["4121", "transport.rideshare", SPECIFIC],
  ["4131", "transport.public", SPECIFIC],
  ["4214", "other", VAGUE],
  ["4215", "other", VAGUE],
  ["4225", "household", BROAD],
  ["4411", "travel", SPECIFIC],
  ["4457", "entertainment", BROAD],
  ["4468", "entertainment", BROAD],
  ["4511", "travel.flights", SPECIFIC],
  ["4582", "travel.flights", BROAD],
  ["4722", "travel", SPECIFIC],
  ["4723", "travel", SPECIFIC],
  ["4784", "transport", SPECIFIC],
  ["4789", "transport", BROAD],
  // Telecom, utilities
  ["4812", [["shopping.electronics", 0.6], ["bills.phone_internet", 0.4]], BROAD],
  ["4813", "bills.phone_internet", BROAD],
  ["4814", "bills.phone_internet", SPECIFIC],
  ["4815", "bills.phone_internet", BROAD],
  ["4816", [["bills.phone_internet", 0.6], ["entertainment.streaming", 0.2], ["bills", 0.2]], BROAD],
  ["4821", "bills.phone_internet", BROAD],
  ["4829", null, 0], // wire transfer / money orders
  ["4899", [["bills.phone_internet", 0.65], ["entertainment.streaming", 0.35]], SPECIFIC],
  ["4900", "bills.utilities", SPECIFIC],
  // Wholesale / durable goods
  ["5013-5099", "shopping", VAGUE],
  ["5021", "household", BROAD],
  ["5039", "household", BROAD],
  ["5044", "shopping.electronics", BROAD],
  ["5045", "shopping.electronics", BROAD],
  ["5047", "health", BROAD],
  ["5065", "shopping.electronics", BROAD],
  ["5072", "household", BROAD],
  ["5094", [["shopping", 0.7], ["gifts", 0.3]], BROAD],
  ["5111", [["shopping", 0.6], ["education", 0.4]], BROAD],
  ["5122", "health", SPECIFIC],
  ["5131-5139", "shopping.clothing", BROAD],
  ["5169", "household", BROAD],
  ["5172", "transport.fuel", BROAD],
  ["5192", [["education", 0.5], ["shopping", 0.3], ["entertainment", 0.2]], BROAD],
  ["5193", [["gifts", 0.5], ["household", 0.5]], BROAD],
  ["5198", "household", BROAD],
  ["5199", "shopping", VAGUE],
  // Home improvement
  ["5200", "household", SPECIFIC],
  ["5211", "household", SPECIFIC],
  ["5231", "household", SPECIFIC],
  ["5251", "household", SPECIFIC],
  ["5261", "household", SPECIFIC],
  ["5271", "housing", BROAD],
  // General merchandise
  ["5300", [["groceries", 0.5], ["shopping", 0.3], ["household", 0.2]], BROAD],
  ["5309", "shopping", BROAD],
  ["5310", [["shopping", 0.6], ["groceries", 0.2], ["household", 0.2]], VAGUE],
  ["5311", [["shopping", 0.7], ["shopping.clothing", 0.3]], VAGUE],
  ["5331", [["shopping", 0.6], ["household", 0.4]], VAGUE],
  ["5399", "shopping", VAGUE],
  // Food stores
  ["5411", [["groceries", 0.9], ["household", 0.1]], SPECIFIC],
  ["5422", "groceries", SPECIFIC],
  ["5441", [["groceries", 0.5], ["eating_out", 0.5]], BROAD],
  ["5451", "groceries", SPECIFIC],
  ["5462", [["eating_out.cafe", 0.5], ["groceries", 0.5]], SPECIFIC],
  ["5499", [["groceries", 0.7], ["eating_out", 0.3]], BROAD],
  // Automotive
  ["5511", "transport", BROAD],
  ["5521", "transport", BROAD],
  ["5531", [["transport", 0.6], ["household", 0.4]], BROAD],
  ["5532", "transport", SPECIFIC],
  ["5533", "transport", SPECIFIC],
  ["5541", [["transport.fuel", 0.9], ["groceries", 0.1]], SPECIFIC],
  ["5542", "transport.fuel", SPECIFIC],
  ["5551", "shopping", BROAD],
  ["5552", "transport.fuel", SPECIFIC], // EV charging
  ["5561-5599", "transport", BROAD],
  // Apparel
  ["5611-5699", "shopping.clothing", SPECIFIC],
  // Home furnishing, electronics
  ["5712", "household", SPECIFIC],
  ["5713", "household", SPECIFIC],
  ["5714", "household", SPECIFIC],
  ["5718", "household", SPECIFIC],
  ["5719", "household", SPECIFIC],
  ["5722", [["household", 0.6], ["shopping.electronics", 0.4]], SPECIFIC],
  ["5732", "shopping.electronics", SPECIFIC],
  ["5733", "shopping", BROAD],
  ["5734", "shopping.electronics", SPECIFIC],
  ["5735", [["entertainment", 0.5], ["shopping", 0.5]], BROAD],
  // Eating and drinking places
  ["5811", "eating_out", SPECIFIC],
  ["5812", EATING_OUT_SPLIT, SPECIFIC],
  ["5813", [["eating_out", 0.6], ["entertainment", 0.4]], SPECIFIC],
  ["5814", [["eating_out", 0.75], ["eating_out.delivery", 0.15], ["eating_out.cafe", 0.1]], SPECIFIC],
  // Digital goods
  ["5815", [["entertainment.streaming", 0.6], ["entertainment", 0.25], ["education", 0.15]], SPECIFIC],
  ["5816", "entertainment.gaming", SPECIFIC],
  ["5817", [["entertainment.streaming", 0.4], ["entertainment.gaming", 0.3], ["shopping.electronics", 0.3]], BROAD],
  ["5818", DIGITAL, BROAD],
  // Miscellaneous retail
  ["5912", [["health", 0.75], ["personal_care", 0.25]], SPECIFIC],
  ["5921", [["groceries", 0.5], ["entertainment", 0.3], ["eating_out", 0.2]], SPECIFIC],
  ["5931", "shopping", BROAD],
  ["5932", "shopping", BROAD],
  ["5933", "shopping", BROAD],
  ["5935", "other", VAGUE],
  ["5937", "shopping", BROAD],
  ["5940", [["transport", 0.5], ["shopping", 0.5]], BROAD],
  ["5941", "shopping", BROAD],
  ["5942", [["education", 0.4], ["shopping", 0.4], ["entertainment", 0.2]], BROAD],
  ["5943", [["shopping", 0.6], ["education", 0.4]], BROAD],
  ["5944", [["shopping", 0.7], ["gifts", 0.3]], BROAD],
  ["5945", [["shopping", 0.5], ["gifts", 0.3], ["entertainment.gaming", 0.2]], BROAD],
  ["5946", "shopping.electronics", SPECIFIC],
  ["5947", "gifts", SPECIFIC],
  ["5948", [["shopping", 0.6], ["travel", 0.4]], BROAD],
  ["5949", "shopping", BROAD],
  ["5950", "household", BROAD],
  ["5960", "bills.insurance", BROAD],
  ["5961", "shopping.online_marketplace", BROAD],
  ["5962", "travel", BROAD],
  ["5963", "shopping", VAGUE],
  ["5964", "shopping.online_marketplace", BROAD],
  ["5965", "shopping.online_marketplace", BROAD],
  ["5966", "shopping", VAGUE],
  ["5967", "entertainment", VAGUE],
  ["5968", [["entertainment.streaming", 0.5], ["bills", 0.3], ["shopping", 0.2]], BROAD], // continuity/subscription
  ["5969", "shopping", VAGUE],
  ["5970", "shopping", BROAD],
  ["5971", "shopping", BROAD],
  ["5972", "shopping", BROAD],
  ["5973", "shopping", BROAD],
  ["5975", "health", SPECIFIC],
  ["5976", "health", SPECIFIC],
  ["5977", "personal_care", SPECIFIC],
  ["5978", "shopping", BROAD],
  ["5983", [["bills.utilities", 0.6], ["transport.fuel", 0.4]], BROAD],
  ["5992", "gifts", SPECIFIC],
  ["5993", "shopping", BROAD],
  ["5994", [["entertainment", 0.5], ["education", 0.5]], BROAD],
  ["5995", "pets", SPECIFIC],
  ["5996", "household", BROAD],
  ["5997", "personal_care", BROAD],
  ["5998", "household", BROAD],
  ["5999", "shopping", VAGUE],
  // Financial: money movement, not a purchase category
  ["6010", null, 0],
  ["6011", null, 0],
  ["6012", null, 0],
  ["6050", null, 0],
  ["6051", null, 0],
  ["6211", null, 0],
  ["6300", "bills.insurance", SPECIFIC],
  ["6381", "bills.insurance", SPECIFIC],
  ["6399", "bills.insurance", SPECIFIC],
  ["6513", [["housing.rent", 0.8], ["housing", 0.2]], SPECIFIC],
  ["6529-6540", null, 0], // stored-value loads, payment transactions, MoneySend
  ["6611", null, 0],
  ["6760", null, 0],
  // Lodging and personal services
  ["7011", "travel.lodging", SPECIFIC],
  ["7012", "travel.lodging", SPECIFIC],
  ["7032", [["entertainment", 0.6], ["travel", 0.4]], BROAD],
  ["7033", "travel.lodging", SPECIFIC],
  ["7210", [["household", 0.6], ["personal_care", 0.4]], SPECIFIC],
  ["7211", "household", SPECIFIC],
  ["7216", [["household", 0.5], ["personal_care", 0.5]], SPECIFIC],
  ["7217", "household", SPECIFIC],
  ["7221", "entertainment", BROAD],
  ["7230", "personal_care", SPECIFIC],
  ["7251", "household", BROAD],
  ["7261", "other", BROAD],
  ["7273", "entertainment", BROAD],
  ["7276", "fees", SPECIFIC],
  ["7277", "health", BROAD],
  ["7278", "shopping", VAGUE],
  ["7280", "health", BROAD],
  ["7295", "household", BROAD],
  ["7296", "shopping.clothing", BROAD],
  ["7297", "personal_care", SPECIFIC],
  ["7298", "personal_care", SPECIFIC],
  ["7299", [["personal_care", 0.5], ["other", 0.5]], VAGUE],
  // Business services
  ["7311-7399", "other", VAGUE],
  ["7342", "household", SPECIFIC],
  ["7349", "household", SPECIFIC],
  ["7372", [["bills", 0.4], ["shopping.electronics", 0.3], ["entertainment.streaming", 0.3]], BROAD],
  ["7375", "bills.phone_internet", BROAD],
  ["7379", "shopping.electronics", BROAD],
  ["7394", "household", BROAD],
  ["7395", "shopping", BROAD],
  // Automotive services
  ["7512", CAR_RENTAL, SPECIFIC],
  ["7513", "transport", SPECIFIC],
  ["7519", "travel", SPECIFIC],
  ["7523", "transport", SPECIFIC], // parking
  ["7531-7549", "transport", SPECIFIC],
  // Repair
  ["7622", "shopping.electronics", BROAD],
  ["7623", "household", BROAD],
  ["7629", "household", BROAD],
  ["7631", "shopping", BROAD],
  ["7641", "household", BROAD],
  ["7692", "household", BROAD],
  ["7699", "household", VAGUE],
  // Amusement and recreation
  ["7800", "entertainment", SPECIFIC],
  ["7801", "entertainment.gaming", SPECIFIC],
  ["7802", "entertainment.gaming", SPECIFIC],
  ["7829", "entertainment", BROAD],
  ["7832", "entertainment.events", SPECIFIC],
  ["7841", "entertainment.streaming", SPECIFIC],
  ["7911", [["entertainment", 0.6], ["education", 0.4]], BROAD],
  ["7922", "entertainment.events", SPECIFIC],
  ["7929", "entertainment.events", SPECIFIC],
  ["7932", "entertainment", SPECIFIC],
  ["7933", "entertainment", SPECIFIC],
  ["7941", "entertainment.events", SPECIFIC],
  ["7991", [["entertainment", 0.6], ["travel", 0.4]], BROAD],
  ["7992", "entertainment", SPECIFIC],
  ["7993", "entertainment.gaming", SPECIFIC],
  ["7994", "entertainment.gaming", SPECIFIC],
  ["7995", "entertainment.gaming", SPECIFIC],
  ["7996", "entertainment", SPECIFIC],
  ["7997", [["personal_care", 0.5], ["entertainment", 0.3], ["health", 0.2]], BROAD], // gyms, membership clubs
  ["7998", "entertainment", SPECIFIC],
  ["7999", "entertainment", BROAD],
  // Health
  ["8011-8099", "health", SPECIFIC],
  // Professional services
  ["8111", "fees", BROAD],
  // Education
  ["8211-8299", "education", SPECIFIC],
  ["8351", [["education", 0.5], ["household", 0.5]], SPECIFIC],
  // Organisations
  ["8398", "donations", SPECIFIC],
  ["8641", [["donations", 0.5], ["other", 0.5]], BROAD],
  ["8651", "donations", SPECIFIC],
  ["8661", "donations", SPECIFIC],
  ["8675", "transport", BROAD],
  ["8699", "other", VAGUE],
  ["8734", "other", VAGUE],
  ["8911", "household", BROAD],
  ["8931", "fees", BROAD],
  ["8999", "other", VAGUE],
  // Government
  ["9211", "fees", SPECIFIC],
  ["9222", "fees", SPECIFIC],
  ["9223", "fees", SPECIFIC],
  ["9311", "taxes", SPECIFIC],
  ["9399", [["fees", 0.6], ["taxes", 0.4]], BROAD],
  ["9402", "other", BROAD],
  ["9405", "other", VAGUE],
  ["9950", null, 0],
];

const MCC_EXACT = new Map<number, MccRule>();
const MCC_RANGES: Array<{ readonly from: number; readonly to: number; readonly rule: MccRule }> = [];
for (const [code, mix, specificity] of MCC_TABLE) {
  const [from, to] = code.split("-").map(Number) as [number, number | undefined];
  if (to === undefined) MCC_EXACT.set(from, { mix, specificity });
  // Narrower ranges first, so "7531-7549" wins over a broad enclosing range.
  else MCC_RANGES.push({ from, to, rule: { mix, specificity } });
}
MCC_RANGES.sort((a, b) => a.to - a.from - (b.to - b.from));

/**
 * Canonical 4-digit MCC: sources lose leading zeros (742 -> "0742") or send
 * placeholders ("0000", ""), which mean "no code".
 */
export function normalizeMcc(code: string | number): string | null {
  const digits = String(code).trim();
  if (!/^\d{1,4}$/.test(digits)) return null;
  const padded = digits.padStart(4, "0");
  return padded === "0000" ? null : padded;
}

function mccRule(code: string | number): MccRule | null {
  const mcc = normalizeMcc(code);
  if (!mcc) return null;
  const n = Number(mcc);
  return MCC_EXACT.get(n) ?? MCC_RANGES.find((r) => n >= r.from && n <= r.to)?.rule ?? null;
}

/**
 * ISO 18245 code → category distribution. `evidence` is the code's
 * specificity (how much it says about one purchase). Null for unknown codes
 * and for money-movement codes (cash, transfers, securities, wallet loads).
 */
export function mapMcc(code: string | number): Distribution<CategoryId> | null {
  const rule = mccRule(code);
  if (!rule || rule.mix === null) return null;
  return distribution(rule.mix, rule.specificity);
}

export interface MccTypeHint {
  readonly type: TransactionType;
  readonly transferKind?: TransferKind;
  readonly confidence: number;
}

/**
 * Codes that describe *how money moved* rather than what was bought. They
 * carry no category (see `mapMcc`) but say a lot about the transaction type.
 */
const MCC_TYPES: ReadonlyArray<readonly [from: number, to: number, hint: MccTypeHint]> = [
  [6010, 6011, { type: "cash_withdrawal", confidence: 0.9 }],
  [4829, 4829, { type: "transfer", confidence: 0.7 }],
  [6050, 6051, { type: "transfer", confidence: 0.6 }],
  [6211, 6211, { type: "investment", confidence: 0.85 }],
  [6529, 6540, { type: "transfer", transferKind: "wallet_load", confidence: 0.7 }],
  [9211, 9223, { type: "fee", confidence: 0.6 }],
  [9311, 9311, { type: "tax", confidence: 0.9 }],
];

/** Transaction-type evidence carried by an MCC (ATM, money transfer, brokerage, wallet load, tax), or null. */
export function mapMccType(code: string | number): MccTypeHint | null {
  const mcc = normalizeMcc(code);
  if (!mcc) return null;
  const n = Number(mcc);
  return MCC_TYPES.find(([from, to]) => n >= from && n <= to)?.[2] ?? null;
}

/* ------------------------------------------------------------------ */
/* Keywords                                                             */
/* ------------------------------------------------------------------ */

/**
 * Tiers resolve conflicts inside one text: a qualifier saying *for whom or
 * what kind* ("dog food", "hot dog") beats a product type ("shampoo"), which
 * beats a generic ingredient ("chicken", "vegetables"). So "Dog shampoo,
 * chicken flavour" is pets, and "Chicken biryani" is eating out.
 */
const QUALIFIER = 3;
const PRODUCT = 2;
const GENERIC = 1;

/** [regex source over folded text (word-bounded automatically), mix, tier]. */
const KEYWORDS: ReadonlyArray<readonly [string, Mix, number]> = [
  // Qualifiers
  ["dogs?|puppy|puppies|cats?|kittens?|pets?|pet ?shop|pet ?store|pet ?food|kibble|cat litter|veterinary|veterinarian|vets?", "pets", QUALIFIER],
  ["hot ?dogs?|food delivery", [["eating_out", 0.6], ["eating_out.delivery", 0.4]], QUALIFIER],
  ["baby|babies|diapers?|nappies|infant", [["household", 0.6], ["personal_care", 0.4]], QUALIFIER],

  // Groceries
  ["grocery|groceries|supermarkets?|supermarkt|supermercados?|supermarche|hypermarkets?|hipermercados?|minimarkets?|mini ?mart|kirana|provisions?|greengrocers?|mercearia|hortifruti|sacolao|atacadista", "groceries", PRODUCT],
  // Eating out
  ["restaurants?|restaurante|ristorante|trattoria|bistro|diner|dhaba|steakhouse|brasserie|churrascaria|eatery|dining|pizzeria|sushi|biryani|thali|dosa|ramen", "eating_out.restaurant", PRODUCT],
  ["fast ?food|takeaway|takeout|take away|burgers?|pizzas?|kebabs?|shawarma|lanchonete|canteen|food ?court|bar|pubs?|tavern|nyama ?choma", "eating_out", PRODUCT],
  ["cafes?|coffee|coffee ?shop|espresso|cappuccino|latte|tea ?house|chai|patisserie|boulangerie|bakery|bakeries|padaria|kopitiam", [["eating_out.cafe", 0.8], ["groceries", 0.2]], PRODUCT],
  // Shopping
  ["clothing|clothes|apparel|fashion|garments?|boutique|shoes|footwear|sneakers|t ?shirts?|shirts?|jeans|trousers|dress|dresses|jackets?|kurta|kurti|saree|sari|socks|hoodies?", "shopping.clothing", PRODUCT],
  ["electronics?|gadgets?|laptops?|notebook computer|smartphones?|mobile phones?|iphone|ipad|macbook|airpods|android phone|headphones?|earphones?|earbuds|headsets?|chargers?|usb|usb ?c|(?:usb ?c?|hdmi|charging|lightning|data|ethernet) cables?|hdmi|power ?banks?|keyboards?|monitors?|ssd|hard ?drives?|memory card|speakers?|smart ?watch|apple watch|echo dot|chromecast|printers?|routers?|televisions?|camera", "shopping.electronics", PRODUCT],
  ["chocolates?|chocolate bars?|protein bars?|candy|biscuits|cookies", "groceries", PRODUCT],
  ["cables?", [["shopping.electronics", 0.6], ["bills.phone_internet", 0.4]], PRODUCT],
  ["tablets?", [["health", 0.5], ["shopping.electronics", 0.5]], PRODUCT],
  ["shopping|department store|marketplace|mall|toys?|toy ?store|lego|sporting goods|jewell?ery|watches", "shopping", PRODUCT],
  // Household
  ["household|furniture|hardware|home improvement|homeware|kitchenware|cookware|detergents?|dish ?wash|dishwashing|cleaning supplies|mops?|brooms?|bed ?sheets?|bedding|towels?|mattress|light ?bulbs?|lamps?|plumbing|plumber|electrician|laundry|dry ?clean(?:ing|ers)?|pest control|home decor|curtains", "household", PRODUCT],
  // Personal care
  ["salon|barber|barbershop|spa|beauty|cosmetics|make ?up|skincare|skin care|tooth ?brush|toothpaste|shampoo|conditioner|soap|body ?wash|deodorant|razors?|shaving|perfume|haircut|manicure|pedicure|massage|gym|fitness|yoga", "personal_care", PRODUCT],
  // Health
  ["pharmacy|pharmacie|farmacia|apotheke|drogaria|chemist|drugstore|medical|medicines?|medication|hospital|clinic|doctor|dentist|dental|physician|diagnostics?|pathology|lab test|optician|optical|paracetamol|vitamins?|supplements?|prescription|health ?care", "health", PRODUCT],
  // Bills
  ["electricity|electric bill|power bill|water bill|gas bill|utility|utilities|sewage|lpg|cooking gas|energy bill|prepaid electricity|token listrik|conta de luz|conta de agua", "bills.utilities", PRODUCT],
  ["broadband|internet|wifi|wi fi|fibre|fiber|mobile recharge|recharge|prepaid recharge|postpaid|airtime|data bundles?|data plan|phone bill|mobile bill|telecom|cable tv|dth", "bills.phone_internet", PRODUCT],
  ["insurance|assurance|seguros?|versicherung|assicurazione", "bills.insurance", PRODUCT],
  // Housing
  ["rent|house rent|rental payment|aluguel|aluguer|miete|loyer|alquiler|landlord", "housing.rent", PRODUCT],
  ["society maintenance|homeowners association|condominio|mortgage", "housing", PRODUCT],
  // Transport
  ["fuel|petrol|diesel|gasoline|gas station|filling station|service station|petrol pump|auto posto|posto de combustivel|combustivel|gasolina|tankstelle|ev charging|charging station", "transport.fuel", PRODUCT],
  ["metro|mrt|bus|buses|train|trains|railways?|rail|transit|tram|ferry|commute|metro card|matatu", "transport.public", PRODUCT],
  ["taxi|taxis|cab|cabs|rideshare|ride hailing|auto rickshaw|rickshaw|tuk ?tuk|boda ?boda", "transport.rideshare", PRODUCT],
  ["parking|car wash|tolls?|car service|auto repair|mechanic|tyres?|tires?", "transport", PRODUCT],
  // Travel
  ["hotels?|hostels?|motels?|resorts?|lodging|accommodation|guest ?house|homestay|pousada", "travel.lodging", PRODUCT],
  ["airlines?|airways|flights?|airfare|air tickets?|boarding pass", "travel.flights", PRODUCT],
  ["travel|tours?|holiday|vacation|travel agency|luggage", "travel", PRODUCT],
  // Entertainment
  ["cinemas?|movies?|theatre|theater|multiplex|concerts?|gig|show tickets|event tickets|festival|museum|amusement park|zoo|stadium", "entertainment.events", PRODUCT],
  ["streaming|video streaming|music streaming|ott", "entertainment.streaming", PRODUCT],
  ["gaming|video games?|games?|casino|betting|lottery", "entertainment.gaming", PRODUCT],
  ["entertainment|nightclub|bowling|karaoke|arcade", "entertainment", PRODUCT],
  // Education
  ["tuition|school fees?|school|college|university|courses?|coaching|tutor|tutoring|exam fees?|textbooks?|stationery", "education", PRODUCT],
  ["books?", [["education", 0.5], ["shopping", 0.3], ["entertainment", 0.2]], PRODUCT],
  // Gifts, donations
  ["gifts?|gift cards?|florist|flowers|bouquet", "gifts", PRODUCT],
  ["donations?|charity|charities|ngo|fundraiser|tithe|zakat|offering", "donations", PRODUCT],
  // Fees, taxes
  ["bank charges|service charges?|late fee|annual fee|penalty|overdraft|interest charge|processing fee|atm fee|fees?", "fees", PRODUCT],
  ["tax|taxes|income tax|property tax|council tax|vat payment|imposto|iptu|ipva|darf|municipal tax", "taxes", PRODUCT],

  // Generic ingredients and staples
  ["milk|eggs?|bread|rice|flour|atta|dal|lentils|sugar|salt|vegetables?|veggies|fruits?|bananas?|apples?|onions?|tomato(?:es)?|potato(?:es)?|chicken|meat|fish|paneer|cheese|butter|yogh?urt|curd|cereal|oats|pasta|cooking oil|snacks|juice|beverages|feijao|arroz|ugali|unga", "groceries", GENERIC],
  ["tissues?|toilet paper|paper towels?|trash bags?|garbage bags?|candles|batteries", "household", GENERIC],
];

interface CompiledKeyword {
  readonly re: RegExp;
  readonly mix: Mix;
  readonly tier: number;
  readonly index: number;
}

const COMPILED_KEYWORDS: readonly CompiledKeyword[] = KEYWORDS.map(([src, mix, tier], index) => ({
  re: new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`, "g"),
  mix,
  tier,
  index,
}));

interface KeywordMatch {
  readonly start: number;
  readonly end: number;
  readonly keyword: CompiledKeyword;
}

function findKeywords(folded: string): KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  for (const keyword of COMPILED_KEYWORDS) {
    keyword.re.lastIndex = 0;
    for (let m = keyword.re.exec(folded); m !== null; m = keyword.re.exec(folded)) {
      matches.push({ start: m.index, end: m.index + m[0].length, keyword });
    }
  }
  // A match inside a longer one is part of a phrase ("dog" in "hot dog"): the phrase decides.
  return matches.filter(
    (a) => !matches.some((b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start),
  );
}

/**
 * Category distribution implied by plain-language words in a text (item
 * titles, descriptors, user-typed notes). Only the highest tier present
 * speaks; within it, matched keywords are averaged. `evidence` is the number
 * of distinct keywords behind the answer (capped at 1 for a single word).
 */
export function keywordCategories(text: string): Distribution<CategoryId> | null {
  const folded = foldText(text);
  if (!folded) return null;
  const matches = findKeywords(folded);
  if (matches.length === 0) return null;
  const top = Math.max(...matches.map((m) => m.keyword.tier));
  const winners = [...new Map(matches.filter((m) => m.keyword.tier === top).map((m) => [m.keyword.index, m.keyword])).values()];
  const mix = winners.length === 1 ? winners[0]!.mix : averageMixes(winners.map((w) => w.mix));
  return { entries: toEntries(mix), evidence: winners.length };
}

/* ------------------------------------------------------------------ */
/* Hints                                                               */
/* ------------------------------------------------------------------ */

const LABEL_TO_ID = new Map<string, CategoryId>();
for (const c of CATEGORIES) {
  LABEL_TO_ID.set(foldText(c.label), c.id);
  LABEL_TO_ID.set(foldText(c.id), c.id);
}

/**
 * Map a category hint in a standard vocabulary into BRAKE's taxonomy.
 *
 *   scheme "brake"   — pass-through for known ids (unknown sub-ids fall back to their top level)
 *   scheme "mcc"     — ISO 18245 table; money-movement codes (6011 ATM…) → null
 *   scheme "keyword" — plain words ("groceries", "pharmacy", "rent") or taxonomy labels
 *
 * `evidence` is the hint's own confidence (times the code's specificity for
 * MCCs), so a vague hint flattens itself instead of overriding better evidence.
 * Unknown schemes return null: translating provider vocabularies is the
 * adapter's job.
 */
export function mapCategoryHint(hint: CategoryHint): Distribution<CategoryId> | null {
  const scheme = hint.scheme.trim().toLowerCase();
  const confidence = clamp01(hint.confidence);
  if (confidence <= 0) return null;
  switch (scheme) {
    case "brake": {
      const id = hint.value.trim();
      if (isKnownCategory(id)) return distribution(id, confidence);
      const top = topLevelCategory(id);
      return isKnownCategory(top) ? distribution(top, confidence * 0.9) : null;
    }
    case "mcc":
    case "iso18245":
    case "iso_18245": {
      const d = mapMcc(hint.value);
      return d ? { entries: d.entries, evidence: clamp01(d.evidence * confidence) } : null;
    }
    case "keyword": {
      const id = LABEL_TO_ID.get(foldText(hint.value));
      if (id && id !== "uncategorized") return distribution(id, confidence);
      const d = keywordCategories(hint.value);
      return d ? { entries: d.entries, evidence: confidence } : null;
    }
    default:
      return null;
  }
}
