import { clamp01, stableHash } from "@brake/core";
import type { MerchantMatcher, MerchantObservation, Probability } from "@brake/core";
import type { NormalizedMerchant } from "./contracts";
import { foldAccents, foldText } from "./hints";
import { MERCHANT_PROFILES } from "./merchant-profiles";
import type { MerchantProfile } from "./merchant-profiles";

/**
 * Merchant normalization: from whatever a source wrote ("AMZN Mktp US*2K4L80",
 * "UPI/627712345678/swiggy@icici/Payment", "PIX ENVIADO - MERCADO LIVRE") to a
 * stable key and a name a person recognises.
 *
 * The cleaning rules are descriptor *grammar* — processor prefixes, rail
 * words, reference numbers, masked cards, legal suffixes, trailing locations —
 * and apply identically to every descriptor. Nothing branches on the user's
 * country, the source or the provider; the merchant table is context data.
 *
 * Resolution cascade (first hit wins, each with an honest confidence):
 *   learned alias (the user told us)            0.97
 *   payment handle of a known merchant          0.95
 *   descriptor pattern of a known merchant      0.88–0.94
 *   domain of a known merchant                  0.92
 *   pattern anywhere in the raw text            0.82–0.85
 *   cleaned descriptor (unknown merchant)       0.35–0.6
 *   processor/gateway only ("PAYPAL", "RAZORPAY") ≤ 0.4, and no fusion key
 *
 * An intermediary in front of a merchant ("PAYPAL *JOES TACOS") is kept on
 * the resolution but never stands in for the merchant behind it.
 */

export type MerchantMatchVia = "learned" | "handle" | "descriptor" | "domain" | "source_key" | "cleaned";

export interface MerchantResolution extends NormalizedMerchant {
  readonly via: MerchantMatchVia;
  /** The well-known merchant this resolved to, if any. */
  readonly profile?: MerchantProfile;
  /** Payment processor / app-store / gateway that fronted the merchant ("paypal" in "PAYPAL *NETFLIX"). */
  readonly intermediary?: string;
  /**
   * The descriptor names only a processor/gateway/wallet ("PAYPAL", "RAZORPAY
   * PAYMENTS 98765"): it says how the money moved, not who was paid. Such a
   * resolution is shown as what it is, at low confidence, but gives fusion no
   * key and no similarity opinion — otherwise every merchant behind the same
   * gateway would look like one merchant.
   */
  readonly processorOnly?: boolean;
  /** Folded tokens describing the merchant, used for similarity. */
  readonly tokens: readonly string[];
}

export interface CleanedDescriptor {
  /** Folded tokens naming the merchant: processor prefix, rail words, references and locations removed. */
  readonly merchantTokens: readonly string[];
  /** Merchant tokens plus product detail after a "*" ("UBER *EATS" -> ["uber", "eats"]). */
  readonly matchTokens: readonly string[];
  /** Every folded token of the raw text, for fallback matching. */
  readonly allTokens: readonly string[];
  /** Payment handles found in the text ("swiggy@icici"). */
  readonly handles: readonly string[];
  /** Domains found in the text, with an optional first path segment ("apple.com/bill"). */
  readonly domains: readonly string[];
  readonly intermediary?: string;
  /** Where `merchantTokens` came from when the descriptor had no merchant words of its own. */
  readonly tokenSource: "descriptor" | "handle" | "domain" | "none";
  /** Title-cased merchant name in the descriptor's own spelling ("Padaria São José"), or null. */
  readonly displayName: string | null;
}

export interface MerchantNormalizer extends MerchantMatcher {
  /** Normalize a raw descriptor; null when it names no merchant at all ("UPI/1234/Payment"). */
  normalize(raw: string): NormalizedMerchant | null;
  /** Resolve a full merchant observation (raw, name, handle, website, source key). */
  resolve(m: MerchantObservation | string): MerchantResolution | null;
  profileFor(key: string): MerchantProfile | undefined;
  /** Remember that descriptors like `raw` mean merchant `key` (a user correction). */
  learnAlias(raw: string, key: string): void;
  /** Learned aliases (cleaned descriptor key -> merchant key), for persistence. */
  learnedAliases(): Readonly<Record<string, string>>;
}

export interface MerchantNormalizerOptions {
  readonly profiles?: readonly MerchantProfile[];
  /** Previously learned aliases: raw descriptor (or its cleaned key) -> merchant key. */
  readonly learned?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
}

/* ------------------------------------------------------------------ */
/* Descriptor grammar                                                    */
/* ------------------------------------------------------------------ */

/**
 * Payment processors, terminals, gateways and app-store billers that appear
 * *before* a "*" in front of the real merchant ("SQ *BLUE BOTTLE",
 * "PAYPAL *NETFLIX", "GOOGLE *YouTubePremium", "DD *DOORDASH …").
 */
const PROCESSOR_PREFIX =
  /^(?:sq|squ|sqr|tst|toast|paypal|pp|pypl|paytm|google|goog|gpay|sp|shopify|iz|izettle|zettle|sumup|dd|mercadopago|mercado pago|mp|pagseguro|pag|pg|ebanx|dlocal|dlo|payu|razorpay|rzp|ccavenue|billdesk|cashfree|stripe|fs|fastspring|2co|paddle|wpy|clover|cko|adyen|worldpay|ipn|phonepe)$/;

/** Rail, channel and narration phrases that lead a descriptor; stripped repeatedly. Longest first. */
const LEADING_PHRASES: readonly (readonly string[])[] = [
  "lipa na m pesa", "lipa na mpesa", "buy goods and services", "m pesa", "mpesa", "buy goods", "pay bill", "paybill",
  "till number", "till no", "till", "merchant payment",
  "pix enviado", "pix recebido", "pix qr", "pix transferencia", "pix", "ted", "doc", "transferencia enviada",
  "transferencia recebida", "transferencia", "compra no debito", "compra no credito", "compra cartao", "compra",
  "pagamento para", "pagamento de", "pagamento a", "pagamento", "pgto",
  "pos purchase", "pos debit", "pos txn", "pos", "ecom", "e com", "ecommerce",
  "upi payment", "upi txn", "upi collect", "upi mandate", "upi", "imps", "neft", "rtgs", "nach", "ecs",
  "ach debit", "ach credit", "ach pmt", "ach",
  "purchase authorized on", "purchase", "card purchase", "debit card purchase", "debit card", "credit card purchase",
  "point of sale", "visa debit", "visa", "vis", "mastercard", "maestro", "mc", "rupay", "dbt", "chk card", "chkcard",
  "checkcard", "recurring payment", "recurring debit", "recurring", "online payment", "online purchase",
  "payment to", "payment for", "paid to", "sent to", "transfer to", "trf to", "direct debit", "dd", "standing order",
  "sepa lastschrift", "sepa direct debit", "sepa credit transfer", "sepa", "lastschrift", "kartenzahlung",
  "girocard", "cb", "carte", "prlv sepa", "prlv", "vir sepa", "vir", "contactless", "apple pay", "google pay",
  "samsung pay", "intl", "international", "bil", "billpay", "bill payment", "dr", "cr",
  "atm cash withdrawal", "atm withdrawal", "atm wdl", "atm cash", "atm", "cash withdrawal",
]
  .map((p) => p.split(" "))
  // Longest first, so "pix enviado" is stripped as one phrase rather than leaving "enviado".
  .sort((a, b) => b.length - a.length);

/** Narration filler removed anywhere in a descriptor. */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  "upi", "imps", "neft", "rtgs", "nach", "txn", "txnid", "trxn", "trx", "ref", "refno", "utr", "rrn", "auth",
  "pymt", "pmt", "payment", "payments", "pos", "ecom", "www", "http", "https", "mob", "ib", "nr", "num", "xx", "xxx",
  "wdl",
]);

/** Legal-entity words, stripped from the end (and "pt"/"cv" from the start). */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "pvt", "private", "ltd", "limited", "llc", "llp", "inc", "incorporated", "corp", "corporation", "co", "company",
  "gmbh", "ag", "kg", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "plc", "pte", "pty", "sdn", "bhd", "tbk", "ltda",
  "me", "eireli", "epp", "lda", "oy", "ab", "kk",
]);
const LEADING_LEGAL: ReadonlySet<string> = new Set(["pt", "cv"]);

/**
 * Locations card descriptors append ("… BANGALORE", "… SEATTLE WA", "… US").
 * Only stripped from the end, and never the last remaining token.
 */
const TRAILING_LOCATIONS: ReadonlySet<string> = new Set([
  // ISO country codes and names
  "us", "usa", "uk", "gb", "gbr", "in", "ind", "india", "br", "bra", "brasil", "brazil", "ke", "ken", "kenya", "sg", "sgp",
  "singapore", "id", "idn", "indonesia", "my", "mys", "malaysia", "ph", "phl", "philippines", "th", "tha", "thailand",
  "vn", "vnm", "vietnam", "de", "deu", "deutschland", "germany", "fr", "fra", "france", "nl", "nld", "netherlands",
  "es", "esp", "espana", "spain", "it", "ita", "italia", "ie", "irl", "ireland", "be", "bel", "pt", "prt", "portugal",
  "at", "aut", "ch", "che", "au", "aus", "ca", "can", "mx", "mex",
  // US states and DC
  "al", "ak", "az", "ar", "co", "ct", "fl", "ga", "hi", "il", "ia", "ks", "ky", "la", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx",
  "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
  // Major cities
  "bangalore", "bengaluru", "blr", "mumbai", "bombay", "delhi", "gurgaon", "gurugram", "noida", "pune", "hyderabad",
  "chennai", "kolkata", "ahmedabad", "jaipur", "kochi", "lucknow", "chandigarh", "indore", "nyc", "brooklyn", "seattle",
  "chicago", "boston", "austin", "houston", "miami", "london", "manchester", "birmingham", "edinburgh", "glasgow",
  "bristol", "leeds", "paris", "lyon", "berlin", "munich", "muenchen", "hamburg", "frankfurt", "amsterdam", "rotterdam",
  "madrid", "barcelona", "milan", "milano", "rome", "roma", "dublin", "lisbon", "lisboa", "curitiba", "brasilia",
  "nairobi", "mombasa", "kisumu", "jakarta", "manila", "makati", "bangkok", "hanoi", "cebu",
]);
const TRAILING_LOCATION_PAIRS: ReadonlySet<string> = new Set([
  "new delhi", "new york", "san francisco", "los angeles", "sao paulo", "belo horizonte", "porto alegre",
  "kuala lumpur", "quezon city", "ho chi", "chi minh",
]);
const TRAILING_LOCATION_TRIPLES: ReadonlySet<string> = new Set(["rio de janeiro", "ho chi minh"]);

/** Top-level domains (and second-level public suffix labels) recognised in descriptors. */
const TLDS: ReadonlySet<string> = new Set([
  "com", "net", "org", "io", "co", "in", "uk", "de", "fr", "nl", "es", "it", "br", "ke", "sg", "id", "my", "ph", "th",
  "vn", "eu", "app", "tv", "me", "info", "gov", "gouv", "biz", "shop", "store", "online", "us", "ca", "au", "jp", "ie",
  "be", "pt", "at", "ch", "se", "no", "dk", "fi", "pl",
]);

/**
 * Masked card/account numbers written with asterisks or bullets ("4512****1234",
 * "**1234", "1234*5678"). They must go before the "*" processor split, or
 * "CARD **1234 JOES TACOS" would read as merchant "card" with detail "joes tacos".
 */
const MASKED_NUMBER_RE = /\d*[*•]{2,}\d*|\d+[*•]+\d+/g;

/** Narration filler that trails a descriptor ("…-123456789012-NA"): "not available". */
const TRAILING_FILLER: ReadonlySet<string> = new Set(["na", "nil"]);

/**
 * Payment handles (UPI VPA, Pix e-mail key). Hyphen-delimited narrations
 * ("UPI-JOES CAFE-joescafe@ybl-YESB0000001-1234…") use "-" as the field
 * separator, so a hyphen never starts or extends the local part and only
 * appears inside a dotted domain label — otherwise "cafe-joescafe@ybl-yesb…"
 * would swallow the merchant's name and the bank code.
 */
const HANDLE_RE = /(?<![a-z0-9._])[a-z0-9][a-z0-9._]*@[a-z][a-z0-9]*(?:\.[a-z0-9-]*[a-z0-9])*/g;
const DOMAIN_RE = /(?<![a-z0-9@.-])(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,6})(\/[a-z0-9]+)?(?![a-z0-9])/g;

function isNoiseToken(t: string): boolean {
  if (NOISE_WORDS.has(t)) return true;
  if (/^\d+$/.test(t)) return true; // RRNs, store numbers, dates, phone numbers
  if (/^\d*x{2,}\d*$/.test(t)) return true; // masked card/account "4512xxxx", "xxxx1234"
  // Reference codes such as "2k4l80", "p1a2b3c4d5", "abcd0001234": letters and >= 2 digits.
  const digits = t.replace(/\D/g, "").length;
  return t.length >= 5 && digits >= 2 && /[a-z]/.test(t);
}

function startsWithPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  return phrase.length <= tokens.length && phrase.every((p, i) => tokens[i] === p);
}

function stripLeading(tokens: string[]): string[] {
  let out = tokens;
  for (let guard = 0; guard < 8; guard++) {
    const phrase = LEADING_PHRASES.find((p) => startsWithPhrase(out, p));
    if (!phrase) break;
    out = out.slice(phrase.length);
  }
  while (out.length > 1 && LEADING_LEGAL.has(out[0]!)) out = out.slice(1);
  return out;
}

function stripTrailing(tokens: string[]): string[] {
  const out = [...tokens];
  for (let guard = 0; guard < 8 && out.length > 1; guard++) {
    const n = out.length;
    const last = out[n - 1]!;
    if (n > 3 && TRAILING_LOCATION_TRIPLES.has(out.slice(n - 3).join(" "))) out.splice(n - 3, 3);
    else if (n > 2 && TRAILING_LOCATION_PAIRS.has(out.slice(n - 2).join(" "))) out.splice(n - 2, 2);
    else if (LEGAL_SUFFIXES.has(last) || TRAILING_LOCATIONS.has(last) || TRAILING_FILLER.has(last)) out.pop();
    else break;
  }
  return out;
}

function tokenize(text: string): string[] {
  const folded = foldText(text);
  return folded ? folded.split(" ") : [];
}

function cleanTokens(text: string, leading: boolean): string[] {
  const tokens = tokenize(text);
  const withoutLead = leading ? stripLeading(tokens) : tokens;
  const out = stripTrailing(withoutLead.filter((t) => !isNoiseToken(t)));
  // A lone state code or legal suffix ("WALMART.COM 8009256278 AR" minus the domain) names nobody.
  return out.every((t) => TRAILING_LOCATIONS.has(t) || LEGAL_SUFFIXES.has(t) || TRAILING_FILLER.has(t)) ? [] : out;
}

/** Name label of a host: "help.uber.com" -> "uber", "mercadolivre.com.br" -> "mercadolivre". */
function registrableLabel(host: string): string | null {
  const labels = host.split(".").filter((l) => l !== "www");
  while (labels.length > 1 && TLDS.has(labels[labels.length - 1]!)) labels.pop();
  const label = labels[labels.length - 1];
  return label && !TLDS.has(label) ? label : null;
}

/** True when a name is only a payment processor, gateway or wallet ("paypal", "mercado pago", "razorpay"). */
function isProcessorName(tokens: readonly string[]): boolean {
  return tokens.length > 0 && PROCESSOR_PREFIX.test(tokens.join(" "));
}

/** Tokens with the intermediary's words removed, so "PAYPAL *JOES TACOS" cannot fall back to "PayPal". */
function withoutWords(tokens: readonly string[], words: readonly string[]): string[] {
  const drop = new Set(words);
  return tokens.filter((t) => !drop.has(t));
}

/**
 * Does a payment handle's local part name this merchant handle? Exact, or
 * the first dotted segment ("cred.club"), or — for handles long enough to be
 * distinctive — a prefix ("zeptonow" for "zepto"). A 4-letter brand handle
 * never matches by prefix: "credencetech@…" is not CRED, "uberto.rossi@…" not Uber.
 */
function handleNames(localPart: string, merchantHandle: string): boolean {
  const compact = localPart.replace(/[^a-z0-9]/g, "");
  if (compact === merchantHandle) return true;
  if ((localPart.split(/[._-]+/)[0] ?? "") === merchantHandle) return true;
  return merchantHandle.length >= 5 && compact.startsWith(merchantHandle);
}

/** Code-point order: deterministic on every device, unlike locale collation. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function handleTokens(handle: string): string[] {
  const local = handle.split("@")[0] ?? "";
  return local
    .split(/[._-]+/)
    .map((t) => t.replace(/\d+/g, ""))
    .filter((t) => t.length > 1 && !isNoiseToken(t));
}

/* ------------------------------------------------------------------ */
/* Display names                                                        */
/* ------------------------------------------------------------------ */

const MINOR_WORDS: ReadonlySet<string> = new Set([
  "and", "of", "the", "de", "da", "do", "das", "dos", "du", "des", "di", "der", "e", "la", "le", "del", "van", "von", "y", "na", "wa",
]);

/** Map folded tokens back to the descriptor's own spelling (keeps "São", "Joe's"). */
function originalSpellings(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const word of raw.split(/[^\p{L}\p{M}\p{N}'’&]+/u)) {
    const folded = foldText(word);
    if (folded && !folded.includes(" ") && !map.has(folded)) map.set(folded, word);
  }
  return map;
}

function displayWord(original: string, index: number): string {
  // Already human-cased ("YouTube", "iPhone"): keep it.
  if (/\p{Ll}/u.test(original) && /\p{Lu}/u.test(original)) return original;
  const lower = original.toLocaleLowerCase();
  const folded = foldText(lower);
  if (index > 0 && MINOR_WORDS.has(folded)) return lower;
  // Short vowel-less words are acronyms ("KFC", "BP", "DSW").
  if (folded.length <= 4 && /^[a-z]+$/.test(folded) && !/[aeiouy]/.test(folded)) return original.toLocaleUpperCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

function titleCase(tokens: readonly string[], spellings: ReadonlyMap<string, string>): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => displayWord(spellings.get(t) ?? t, i)).join(" ");
}

function keyToDisplay(key: string): string {
  return titleCase(key.split(/[_\s]+/).filter(Boolean), new Map()) ?? key;
}

/* ------------------------------------------------------------------ */
/* Cleaning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Split a raw descriptor into merchant words, product detail, handles and
 * domains. Pure and deterministic; exported for adapters and tests.
 */
export function cleanDescriptor(raw: string): CleanedDescriptor {
  const spellings = originalSpellings(raw);
  let s = foldAccents(raw).replace(/['’`´&]/g, "");

  const handles: string[] = [];
  const domains: string[] = [];
  s = s.replace(HANDLE_RE, (h: string) => {
    handles.push(h);
    const host = h.split("@")[1] ?? "";
    // E-mail-like keys (Pix e-mail keys, billing addresses) name the merchant by their host.
    if (host.includes(".") && TLDS.has(host.split(".").pop() ?? "")) domains.push(host);
    return " ";
  });
  s = s.replace(DOMAIN_RE, (whole: string, host: string, path: string | undefined) => {
    const tld = host.split(".").pop() ?? "";
    if (!TLDS.has(tld)) return whole;
    domains.push(`${host.replace(/^www\./, "")}${path ?? ""}`);
    return " ";
  });

  s = s.replace(MASKED_NUMBER_RE, " ");

  let merchantPart = s;
  let detailPart = "";
  let intermediary: string | undefined;
  const star = s.indexOf("*");
  if (star >= 0) {
    const left = stripLeading(tokenize(s.slice(0, star))).join(" ");
    const right = s.slice(star + 1).replace(/\*/g, " ");
    if (left === "" || PROCESSOR_PREFIX.test(left)) {
      if (left) intermediary = left;
      merchantPart = right;
    } else {
      // "UBER *TRIP", "AMZN Mktp US*2K4L80": the merchant is on the left, the right is detail or a reference.
      merchantPart = s.slice(0, star);
      detailPart = right;
    }
  }

  let merchantTokens = cleanTokens(merchantPart, true);
  let tokenSource: CleanedDescriptor["tokenSource"] = merchantTokens.length > 0 ? "descriptor" : "none";
  if (merchantTokens.length === 0) {
    const fromHandle = handles.map(handleTokens).find((t) => t.length > 0);
    const fromDomain = domains.map((d) => registrableLabel(d.split("/")[0]!)).find((l): l is string => l !== null);
    if (fromHandle) {
      merchantTokens = fromHandle;
      tokenSource = "handle";
    } else if (fromDomain) {
      merchantTokens = [fromDomain];
      tokenSource = "domain";
    }
  }
  const detailTokens = detailPart ? tokenize(detailPart).filter((t) => !isNoiseToken(t)) : [];

  return {
    merchantTokens,
    matchTokens: [...merchantTokens, ...detailTokens],
    allTokens: tokenize(raw),
    handles,
    domains,
    ...(intermediary ? { intermediary } : {}),
    tokenSource,
    displayName: titleCase(merchantTokens, spellings),
  };
}

/** The key an unknown merchant gets. Handle-only names are hashed: a payee handle may be a person. */
function cleanedKey(c: CleanedDescriptor): string | null {
  if (c.merchantTokens.length === 0) return null;
  if (c.tokenSource === "handle") return `h_${stableHash(c.merchantTokens.join(" "))}`;
  return c.merchantTokens.join("_").slice(0, 48);
}

/* ------------------------------------------------------------------ */
/* Profile index                                                        */
/* ------------------------------------------------------------------ */

interface CompiledPattern {
  readonly profile: MerchantProfile;
  readonly tokens?: readonly string[];
  readonly compact?: string;
  readonly re?: RegExp;
  readonly specificity: number;
}

interface PatternHit {
  readonly profile: MerchantProfile;
  readonly specificity: number;
  readonly position: number;
  readonly exact: boolean;
  readonly tokens: readonly string[];
}

function compilePatterns(profiles: readonly MerchantProfile[]): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const profile of profiles) {
    for (const pattern of profile.patterns) {
      if (typeof pattern === "string") {
        const tokens = tokenize(pattern);
        if (tokens.length === 0) continue;
        const compact = tokens.join("");
        out.push({ profile, tokens, compact, specificity: compact.length });
      } else {
        out.push({ profile, re: new RegExp(pattern.source, pattern.flags.replace("g", "")), specificity: pattern.source.length / 2 });
      }
    }
  }
  return out;
}

function matchPattern(p: CompiledPattern, tokens: readonly string[], text: string): PatternHit | null {
  if (p.re) {
    const m = p.re.exec(text);
    return m ? { profile: p.profile, specificity: p.specificity, position: m.index, exact: true, tokens: tokenize(m[0]) } : null;
  }
  const phrase = p.tokens!;
  const compact = p.compact!;
  let charPos = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (phrase.every((w, k) => tokens[i + k] === w)) {
      return { profile: p.profile, specificity: p.specificity + 0.5, position: charPos, exact: true, tokens: phrase };
    }
    // Glued or split spellings ("YouTubePremium", "home depot" vs "HOMEDEPOT"), ending on a token boundary.
    if (compact.length >= 4) {
      let glued = "";
      for (let j = i; j < tokens.length && glued.length < compact.length; j++) {
        glued += tokens[j];
        if (glued === compact) return { profile: p.profile, specificity: p.specificity, position: charPos, exact: false, tokens: tokens.slice(i, j + 1) };
      }
    }
    charPos += tokens[i]!.length + 1;
  }
  return null;
}

/** Most specific hit; ties go to the earliest (the merchant comes before what it sells). */
function bestHit(hits: readonly PatternHit[]): PatternHit | null {
  let best: PatternHit | null = null;
  for (const h of hits) {
    if (!best || h.specificity > best.specificity || (h.specificity === best.specificity && h.position < best.position)) best = h;
  }
  return best;
}

function uniqueTokens(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())];
}

/* ------------------------------------------------------------------ */
/* Similarity                                                          */
/* ------------------------------------------------------------------ */

function tokensAgree(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return a.startsWith(b) || b.startsWith(a); // truncated descriptors: "STARBUCKS COFF"
}

/** Dice coefficient over tokens with prefix agreement; glued spellings count as equal. */
function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join("") === b.join("")) return 1;
  const used = new Set<number>();
  let matched = 0;
  for (const x of a) {
    const j = b.findIndex((y, i) => !used.has(i) && tokensAgree(x, y));
    if (j >= 0) {
      used.add(j);
      matched += 1;
    }
  }
  return (2 * matched) / (a.length + b.length);
}

/* ------------------------------------------------------------------ */
/* Normalizer                                                          */
/* ------------------------------------------------------------------ */

const CONFIDENCE = {
  learned: 0.97,
  handle: 0.95,
  patternExact: 0.94,
  patternGlued: 0.9,
  domain: 0.92,
  sourceKey: 0.9,
  fallbackExact: 0.85,
  fallbackGlued: 0.82,
  /** Ceiling for a processor-only descriptor: any real merchant name from another source beats it. */
  processorOnly: 0.4,
} as const;

/** Similarity of two sibling brands of one company ("amazon" / "amazon_prime"): related, not decisive. */
const RELATED_BRANDS = 0.5;

/** Brand family of a known merchant: the first segment of its key ("amazon_prime" -> "amazon"). */
function brandFamily(r: MerchantResolution): string | null {
  return r.profile ? (r.profile.key.split("_")[0] ?? null) : null;
}

function normalizeMerchantKey(key: string): string {
  return foldText(key).replace(/\s+/g, "_");
}

function toEntries(learned: MerchantNormalizerOptions["learned"]): Array<[string, string]> {
  if (!learned) return [];
  if (learned instanceof Map) return [...(learned as ReadonlyMap<string, string>).entries()];
  return Object.entries(learned as Readonly<Record<string, string>>);
}

export function createMerchantNormalizer(opts: MerchantNormalizerOptions = {}): MerchantNormalizer {
  const profiles = opts.profiles ?? MERCHANT_PROFILES;
  const byKey = new Map<string, MerchantProfile>();
  for (const p of profiles) if (!byKey.has(p.key)) byKey.set(p.key, p);
  const patterns = compilePatterns(profiles);
  const learned = new Map<string, string>();
  const cache = new Map<string, MerchantResolution | null>();

  function aliasKeyOf(raw: string): string | null {
    return cleanedKey(cleanDescriptor(raw));
  }

  for (const [alias, key] of toEntries(opts.learned)) {
    const aliasKey = aliasKeyOf(alias);
    if (aliasKey && key.trim()) learned.set(aliasKey, normalizeMerchantKey(key));
  }

  function fromProfile(profile: MerchantProfile, confidence: Probability, via: MerchantMatchVia, c: CleanedDescriptor | null, matched: readonly string[] = []): MerchantResolution {
    return {
      key: profile.key,
      displayName: profile.displayName,
      confidence,
      via,
      profile,
      ...(c?.intermediary ? { intermediary: c.intermediary } : {}),
      tokens: uniqueTokens(profile.key.split("_"), tokenize(profile.displayName), matched),
    };
  }

  function matchHandles(c: CleanedDescriptor): MerchantProfile | null {
    let best: { profile: MerchantProfile; length: number } | null = null;
    for (const handle of c.handles) {
      const local = handle.split("@")[0] ?? "";
      for (const profile of profiles) {
        for (const h of profile.handles ?? []) {
          if (handleNames(local, h) && (!best || h.length > best.length)) best = { profile, length: h.length };
        }
      }
    }
    return best?.profile ?? null;
  }

  function matchDomains(c: CleanedDescriptor): MerchantProfile | null {
    let best: { profile: MerchantProfile; length: number } | null = null;
    for (const d of c.domains) {
      const [host = "", path = ""] = d.split(/(?=\/)/);
      for (const profile of profiles) {
        for (const entry of profile.domains ?? []) {
          const [eHost = "", ePath = ""] = entry.split(/(?=\/)/);
          const hostOk = host === eHost || host.endsWith(`.${eHost}`);
          const pathOk = ePath === "" || path === ePath;
          if (hostOk && pathOk && (!best || entry.length > best.length)) best = { profile, length: entry.length };
        }
      }
    }
    return best?.profile ?? null;
  }

  function matchTokens(tokens: readonly string[]): PatternHit | null {
    if (tokens.length === 0) return null;
    const text = tokens.join(" ");
    const hits: PatternHit[] = [];
    for (const p of patterns) {
      const hit = matchPattern(p, tokens, text);
      if (hit) hits.push(hit);
    }
    return bestHit(hits);
  }

  /** Mark a resolution that names only a processor (see `processorOnly`). User-taught aliases are taken as given. */
  function markProcessor(r: MerchantResolution | null): MerchantResolution | null {
    if (!r || r.via === "learned") return r;
    const names = r.profile ? [tokenize(r.profile.key), tokenize(r.profile.displayName)] : [r.tokens];
    if (!names.some(isProcessorName)) return r;
    return {
      ...r,
      confidence: Math.min(r.confidence, CONFIDENCE.processorOnly),
      intermediary: r.intermediary ?? (names[0] ?? []).join(" "),
      processorOnly: true,
    };
  }

  function resolveText(text: string, isHumanName: boolean): MerchantResolution | null {
    return markProcessor(resolveCleaned(cleanDescriptor(text), isHumanName));
  }

  function resolveCleaned(c: CleanedDescriptor, isHumanName: boolean): MerchantResolution | null {
    const aliasKey = cleanedKey(c);
    if (aliasKey) {
      const learnedKey = learned.get(aliasKey);
      if (learnedKey) {
        const profile = byKey.get(learnedKey);
        if (profile) return fromProfile(profile, CONFIDENCE.learned, "learned", c);
        return { key: learnedKey, displayName: keyToDisplay(learnedKey), confidence: CONFIDENCE.learned, via: "learned", tokens: learnedKey.split("_") };
      }
    }
    const byHandle = matchHandles(c);
    if (byHandle) return fromProfile(byHandle, CONFIDENCE.handle, "handle", c);
    const hit = matchTokens(c.matchTokens);
    if (hit) return fromProfile(hit.profile, hit.exact ? CONFIDENCE.patternExact : CONFIDENCE.patternGlued, "descriptor", c, hit.tokens);
    const byDomain = matchDomains(c);
    if (byDomain) return fromProfile(byDomain, CONFIDENCE.domain, "domain", c);
    // Last resort: any known name anywhere in the text — except the intermediary's own
    // name when the descriptor names a merchant behind it ("PAYPAL *JOES TACOS" is not PayPal).
    const fallbackTokens =
      c.intermediary && c.merchantTokens.length > 0 ? withoutWords(c.allTokens, c.intermediary.split(" ")) : c.allTokens;
    const fallback = matchTokens(fallbackTokens);
    if (fallback) return fromProfile(fallback.profile, fallback.exact ? CONFIDENCE.fallbackExact : CONFIDENCE.fallbackGlued, "descriptor", c, fallback.tokens);

    if (!aliasKey) return null;
    const letters = c.merchantTokens.join("").length;
    const confidence =
      c.tokenSource === "handle" ? 0.4 : c.tokenSource === "domain" ? 0.6 : isHumanName ? 0.6 : letters >= 4 ? 0.55 : 0.35;
    return {
      key: aliasKey,
      displayName: c.displayName ?? keyToDisplay(aliasKey),
      confidence,
      via: "cleaned",
      ...(c.intermediary ? { intermediary: c.intermediary } : {}),
      tokens: c.merchantTokens,
    };
  }

  function resolveUncached(m: MerchantObservation): MerchantResolution | null {
    const results: MerchantResolution[] = [];
    const add = (r: MerchantResolution | null) => {
      if (r) results.push(r);
    };
    if (m.raw) add(resolveText(m.raw, false));
    if (m.name && m.name !== m.raw) add(resolveText(m.name, true));
    if (m.handle) add(resolveText(m.handle, false));
    if (m.website) add(resolveText(m.website, false));
    if (m.key) {
      const key = normalizeMerchantKey(m.key);
      const profile = byKey.get(key);
      if (profile) add(markProcessor(fromProfile(profile, CONFIDENCE.sourceKey, "source_key", null)));
      else if (key) add(markProcessor({ key, displayName: m.name?.trim() || keyToDisplay(key), confidence: clamp01(Math.min(0.5, m.confidence)), via: "source_key", tokens: key.split("_") }));
    }
    // Highest confidence wins; on ties a known merchant beats a cleaned guess, then input order.
    let best: MerchantResolution | null = null;
    for (const r of results) {
      if (!best || r.confidence > best.confidence || (r.confidence === best.confidence && r.profile && !best.profile)) best = r;
    }
    return best;
  }

  function resolve(input: MerchantObservation | string): MerchantResolution | null {
    const m: MerchantObservation = typeof input === "string" ? { raw: input, confidence: 1 } : input;
    const cacheKey = [m.raw, m.name, m.key, m.handle, m.website, m.confidence].map((v) => v ?? "").join("␟");
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
    const r = resolveUncached(m);
    if (cache.size >= 2000) cache.clear(); // bounded; deterministic either way
    cache.set(cacheKey, r);
    return r;
  }

  function isKnown(r: MerchantResolution): boolean {
    return r.profile !== undefined || r.via === "learned";
  }

  return {
    normalize(raw: string): NormalizedMerchant | null {
      const r = resolve(raw);
      return r ? { key: r.key, displayName: r.displayName, confidence: r.confidence } : null;
    },
    resolve,
    profileFor(key: string): MerchantProfile | undefined {
      return byKey.get(key);
    },
    learnAlias(raw: string, key: string): void {
      const aliasKey = aliasKeyOf(raw);
      const target = normalizeMerchantKey(key);
      if (!aliasKey || !target) return;
      learned.set(aliasKey, target);
      cache.clear();
    },
    learnedAliases(): Readonly<Record<string, string>> {
      return Object.fromEntries([...learned.entries()].sort(([a], [b]) => byCodePoint(a, b)));
    },
    key(m: MerchantObservation): string | null {
      const r = resolve(m);
      // A processor-only descriptor does not identify a merchant (see `processorOnly`).
      return r && !r.processorOnly ? r.key : null;
    },
    similarity(a: MerchantObservation, b: MerchantObservation): number {
      const ra = resolve(a);
      const rb = resolve(b);
      if (!ra || !rb || ra.processorOnly || rb.processorOnly) return 0;
      if (ra.key === rb.key) return isKnown(ra) || isKnown(rb) ? 1 : 0.95;
      if (isKnown(ra) && isKnown(rb)) {
        // Sibling brands of one company ("Amazon" debit, "Amazon Prime" e-mail) may be one
        // charge; two unrelated merchants BRAKE recognises are clearly different.
        const family = brandFamily(ra);
        return family !== null && family === brandFamily(rb) ? RELATED_BRANDS : 0.05;
      }
      return tokenSimilarity(ra.tokens, rb.tokens);
    },
  };
}
