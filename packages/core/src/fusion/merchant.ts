import type { MerchantObservation } from "../model/observation";
import type { MerchantMatcher } from "./types";

/**
 * Conservative merchant comparison for fusion.
 *
 * Fusion only needs to answer "could these two descriptors name the same
 * merchant?", not "which brand is this?" — that is the intelligence layer's
 * job (and it may inject a richer matcher). So the default cleaner removes
 * what is reliably noise in card/bank/UPI/Pix descriptors and nothing more:
 * store numbers and reference codes, payment-processor prefixes ("SQ *",
 * "PAYTM*", "UPI/"), payment handles' bank suffixes, legal-entity suffixes and
 * filler words. A tiny alias table covers abbreviations that otherwise share
 * no token with the merchant's own name ("AMZN Mktp" vs "Amazon").
 *
 * Everything here is applied uniformly to every descriptor: nothing branches
 * on the user's country, provider or adapter.
 */

/**
 * Payment-processor / terminal / gateway prefixes that precede the real
 * merchant ("SQ *BLUE BOTTLE", "PAYPAL *NETFLIX", "TST* JOES DINER").
 * They are only stripped as a leading "<prefix>*" so that a merchant whose
 * name merely contains the word survives.
 */
const PROCESSOR_STAR_PREFIX =
  /^\s*(?:sq|tst|dd|paytm|paypal|pp|sp|ipn|cko|pag|pg|mp|mercpago|dlo|payu|rzp|razorpay|cashfree|ccavenue|goog|google|gpay|phonepe)\s*\*\s*/;

/** Rail / channel prefixes in bank narrations ("UPI/…", "POS 4021…", "PIX - …", "ACH-…"). */
const RAIL_PREFIX =
  /^\s*(?:upi|pos|ecom|ach|nach|ecs|imps|neft|rtgs|pix|ted|sepa|sct|mpesa|bil|vps|vin|ibft)(?:\s*[/\-:*]\s*|\s+)/;

/** Abbreviations that share no token with the merchant's own name. Kept deliberately tiny. */
const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bamzn\s+mktp\b/g, "amazon"],
  [/\bamazon\s+mktp\b/g, "amazon"],
  [/\bamzn\b/g, "amazon"],
  [/\bwal\s+mart\b/g, "walmart"],
];

/** Legal-entity suffixes: never part of what distinguishes two merchants. */
const LEGAL_SUFFIXES = [
  "pvt", "private", "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc", "corp", "corporation",
  "co", "company", "gmbh", "ag", "sa", "sas", "sarl", "srl", "bv", "nv", "ltda", "eireli", "me", "pte", "pty", "oy", "ab", "kk",
];

/**
 * Descriptor filler: rail and narration words, marketplace/payment words,
 * domain fragments and the country codes descriptors append. Payment
 * gateways that appear *instead of* a merchant ("RAZORPAY", "PAYPAL") are
 * filler too: they say how the money moved, not who was paid, so a
 * gateway-only descriptor yields no merchant key rather than a misleading one.
 */
const FILLER = [
  // narration
  "upi", "pos", "ecom", "ach", "nach", "imps", "neft", "rtgs", "pix", "sepa", "mpesa", "txn", "trx", "ref", "refno",
  "dr", "cr", "debit", "credit", "card", "purchase", "authorized", "authorised", "on", "at", "to", "from", "by", "via",
  "for", "trf", "transfer", "pmt", "payment", "payments", "pay", "paid", "bill", "billing", "recurring",
  "the", "and", "of", "de", "da", "do",
  // marketplace / channel
  "mktp", "mktplace", "marketplace", "online", "retail", "services", "service", "store", "intl", "international",
  // domains
  "www", "com", "net", "org", "in", "co",
  // country codes / names commonly appended to descriptors
  "us", "usa", "uk", "gb", "ind", "india", "br", "bra", "brasil", "brazil", "ke", "ken", "kenya", "eu",
  // gateways and wallets that stand in for the merchant
  "razorpay", "rzp", "payu", "paytm", "phonepe", "gpay", "googlepay", "paypal", "stripe", "square", "cashfree",
  "ccavenue", "billdesk", "juspay", "adyen", "worldpay", "pagseguro", "mercadopago", "sumup", "visa", "mastercard", "rupay",
];

const NOISE: ReadonlySet<string> = new Set([...LEGAL_SUFFIXES, ...FILLER]);

/**
 * Clean a merchant descriptor into comparable tokens.
 *   "AMZN Mktp US*2K4L"                      -> ["amazon"]
 *   "UPI/627712345678/AMAZON/amazon@apl"     -> ["amazon"]
 *   "SQ *BLUE BOTTLE COFFEE #42"             -> ["blue", "bottle", "coffee"]
 *   "Padaria São João Ltda"                  -> ["padaria", "sao", "joao"]
 */
export function merchantTokens(text: string | undefined | null): string[] {
  if (!text) return [];
  let s = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // Payment handles (UPI VPA, e-mail-like Pix keys): keep the local part, drop the bank/PSP suffix.
  s = s.replace(/([a-z0-9._-]+)@[a-z0-9.-]+/g, " $1 ");
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PROCESSOR_STAR_PREFIX, "").replace(RAIL_PREFIX, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, canonical] of ALIASES) s = s.replace(re, canonical);
  const out: string[] = [];
  for (const token of s.split(" ")) {
    // Tokens carrying digits are store numbers, RRNs, dates or reference codes.
    if (token.length < 2 || /\d/.test(token) || NOISE.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

function normalizeKey(key: string): string | null {
  const k = key.trim().toLowerCase().replace(/\s+/g, " ");
  return k.length > 0 ? k : null;
}

function handleLocalPart(handle: string | undefined): string | null {
  if (!handle) return null;
  const local = handle.toLowerCase().split("@")[0]?.trim() ?? "";
  return local.length > 0 ? local : null;
}

/*
 * Observations are immutable, so cleaning results can be memoized per
 * merchant object. Fusion compares each incoming observation with several
 * candidate members; without this the regex work would dominate ingest time.
 */
const keyCache = new WeakMap<MerchantObservation, string | null>();
const variantCache = new WeakMap<MerchantObservation, string[][]>();

/** Canonical key: the source's own key, else cleaned name, else cleaned raw descriptor. */
export function merchantKey(m: MerchantObservation): string | null {
  const cached = keyCache.get(m);
  if (cached !== undefined) return cached;
  const key = computeKey(m);
  keyCache.set(m, key);
  return key;
}

function computeKey(m: MerchantObservation): string | null {
  if (m.key) {
    const k = normalizeKey(m.key);
    if (k) return k;
  }
  const fromName = merchantTokens(m.name);
  if (fromName.length > 0) return fromName.join(" ");
  const fromRaw = merchantTokens(m.raw);
  return fromRaw.length > 0 ? fromRaw.join(" ") : null;
}

/**
 * Truncated descriptors ("STARBUCKS COFF") match the full word when the shared
 * prefix is long enough. Field-length limits cut the *end* of a descriptor, so
 * only a list's last token may be a truncation: "STAR" in "STAR BAZAAR" is a
 * whole word, not a cut-off "STARBUCKS".
 */
function tokensMatch(a: string, aIsLast: boolean, b: string, bIsLast: boolean): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return (bIsLast && a.startsWith(b)) || (aIsLast && b.startsWith(a));
}

/**
 * Token-set similarity in [0, 1]: the mean of the Dice coefficient (penalises
 * extra tokens such as a city) and the overlap coefficient (rewards one name
 * being contained in the other). One-to-one greedy matching keeps it symmetric
 * enough for scoring and fully deterministic.
 */
export function tokenSetSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join("") === b.join("")) return 1; // "bluetokai" vs "blue tokai"
  const used = new Set<number>();
  let matched = 0;
  for (const [i, x] of a.entries()) {
    const j = b.findIndex((y, k) => !used.has(k) && tokensMatch(x, i === a.length - 1, y, k === b.length - 1));
    if (j >= 0) {
      used.add(j);
      matched += 1;
    }
  }
  const dice = (2 * matched) / (a.length + b.length);
  const overlap = matched / Math.min(a.length, b.length);
  return (dice + overlap) / 2;
}

function variants(m: MerchantObservation): string[][] {
  const cached = variantCache.get(m);
  if (cached) return cached;
  const out: string[][] = [];
  const add = (tokens: string[]): void => {
    if (tokens.length > 0 && !out.some((v) => v.join(" ") === tokens.join(" "))) out.push(tokens);
  };
  if (m.key) add(merchantTokens(m.key));
  add(merchantTokens(m.name));
  add(merchantTokens(m.raw));
  const local = handleLocalPart(m.handle);
  if (local) add(merchantTokens(local));
  variantCache.set(m, out);
  return out;
}

/** Similarity of two merchant observations: 1 for equal handles or keys, else best token-set similarity. */
export function merchantSimilarity(a: MerchantObservation, b: MerchantObservation): number {
  if (a.handle && b.handle && a.handle.trim().toLowerCase() === b.handle.trim().toLowerCase()) return 1;
  const ka = merchantKey(a);
  const kb = merchantKey(b);
  if (ka !== null && ka === kb) return 1;
  let best = 0;
  for (const x of variants(a)) for (const y of variants(b)) best = Math.max(best, tokenSetSimilarity(x, y));
  return best;
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Human-ish name from a descriptor when no source supplied one: "AMZN Mktp US*2K4L" -> "Amazon". */
export function displayNameFromDescriptor(raw: string): string | null {
  const tokens = merchantTokens(raw);
  return tokens.length > 0 ? titleCase(tokens.join(" ")) : null;
}

export const defaultMerchantMatcher: MerchantMatcher = {
  key: merchantKey,
  similarity: merchantSimilarity,
};
