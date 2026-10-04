import { DAY, isOneTimePasswordMessage, redactSensitive } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CategoryHint,
  EpochMillis,
  MerchantObservation,
  Observation,
  Probability,
  RawSignal,
  SignalAdapter,
  SourceRef,
} from "@brake/core";
import { extractAmount, normalizeWhitespace, observationId } from "./shared/text";

/**
 * Share sheet / pasted product links -> pre-spend purchase intents.
 *
 * Also home of the URL helpers every pre-spend surface reuses (QR product
 * links, browser checkout, UPI `url` params): product URLs are sensitive
 * (they reveal what someone is considering) and their query strings carry
 * tracking ids, session tokens and sometimes e-mail addresses, so nothing
 * here ever keeps a query string or fragment.
 *
 * Retailer knowledge (which domains belong to which merchant, how product ids
 * look in their URLs) is a data pack below; a new retailer is a row, not code.
 * Research: docs/research/08-manual-and-pre-spend-surfaces.md §5–8,
 * docs/research/03-android-device-signals.md §8, docs/research/04-ios-device-signals.md §12.
 */

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

export interface ParsedHttpUrl {
  readonly scheme: "http" | "https";
  /** Lower-case host without a trailing dot. */
  readonly host: string;
  readonly port?: string;
  /** Path as written ("" when absent). */
  readonly path: string;
  /** Raw query without "?" — read once for ids, never retained. */
  readonly query: string;
}

const HTTP_URL = /^(https?):\/\/(?:[^@/?#\s]*@)?([^/?#:\s]+)(?::(\d{1,5}))?([^?#\s]*)(?:\?([^#\s]*))?(?:#\S*)?$/i;

/**
 * Parse an http(s) URL without relying on a platform URL implementation
 * (adapters also run inside native shells). Userinfo is dropped on purpose:
 * it can hold credentials.
 */
export function parseHttpUrl(text: string): ParsedHttpUrl | null {
  const m = HTTP_URL.exec(text.trim());
  if (!m) return null;
  const host = (m[2] ?? "").toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return null;
  const scheme = (m[1] ?? "").toLowerCase() === "http" ? "http" : "https";
  const port = m[3];
  const defaultPort = (scheme === "http" && port === "80") || (scheme === "https" && port === "443");
  return { scheme, host, ...(port && !defaultPort ? { port } : {}), path: m[4] ?? "", query: m[5] ?? "" };
}

/**
 * The URL with query string, fragment and tracking path segments removed
 * ("…/dp/B0CHWRXH8B/ref=sr_1_1?keywords=…" -> "…/dp/B0CHWRXH8B"). Path
 * segments that carry `key=value` pairs are tracking-style parameters in
 * disguise and are dropped too. Returns null for non-http(s) input.
 */
export function stripUrl(url: string): string | null {
  const p = parseHttpUrl(url);
  if (!p) return null;
  const segments = p.path.split("/").filter((s) => s.length > 0 && !s.includes("=") && !s.includes(";"));
  const path = segments.length > 0 ? `/${segments.join("/")}` : "";
  return `${p.scheme}://${p.host}${p.port ? `:${p.port}` : ""}${path}`;
}

/** Query parameters with lower-cased keys (first occurrence wins). For id extraction only. */
export function queryParams(query: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!key || out.has(key)) continue;
    out.set(key, eq < 0 ? "" : safeDecode(pair.slice(eq + 1)));
  }
  return out;
}

/** Form-style percent decoding that never throws on malformed escapes. */
export function safeDecode(value: string): string {
  const plus = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plus);
  } catch {
    // Decode the well-formed escapes and keep the broken ones literally.
    return plus.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

/** Every http(s) URL in free text, trailing punctuation trimmed. */
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    out.push(m[0].replace(/[),.;:!?\]}»”’]+$/, ""));
  }
  return out;
}

/**
 * Second-level labels under which ccTLD registrations happen
 * ("amazon.co.uk", "mercadolivre.com.br", "tokopedia.co.id"). A pragmatic
 * subset of the Public Suffix List — enough to name a merchant from a domain.
 */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go", "gob", "nic", "ltd", "plc"]);

/** "www.amazon.co.uk" -> "amazon.co.uk"; "dl.flipkart.com" -> "flipkart.com". */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] ?? "";
  const sld = labels[labels.length - 2] ?? "";
  return tld.length === 2 && SECOND_LEVEL_LABELS.has(sld) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

/* ------------------------------------------------------------------ */
/* Merchant and product data pack                                      */
/* ------------------------------------------------------------------ */

export interface KnownMerchant {
  readonly name: string;
  /** Lower-case canonical key, shared by every country site and short-link host of the merchant. */
  readonly key: string;
  /** BRAKE taxonomy id (copied from intelligence/taxonomy; adapters never import intelligence). */
  readonly category?: string;
}

interface MerchantDomainRow extends KnownMerchant {
  /**
   * "amazon.*" matches any registrable domain whose first label is "amazon"
   * (amazon.in, amazon.com, amazon.co.uk, amazon.com.br); a plain entry
   * matches that registrable domain (short-link hosts such as "amzn.in").
   */
  readonly domains: readonly string[];
}

/**
 * Commerce domains -> merchant. Short-link hosts are observed in retailer
 * app share text (not verified per app for 2026; formats drift).
 */
const MERCHANT_DOMAINS: readonly MerchantDomainRow[] = [
  { name: "Amazon", key: "amazon", category: "shopping.online_marketplace", domains: ["amazon.*", "amzn.to", "amzn.in", "amzn.eu", "amzn.asia", "amzn.com", "a.co"] },
  { name: "Flipkart", key: "flipkart", category: "shopping.online_marketplace", domains: ["flipkart.*", "fkrt.it", "fkrt.co"] },
  { name: "Myntra", key: "myntra", category: "shopping.clothing", domains: ["myntra.*", "myntr.it"] },
  { name: "Meesho", key: "meesho", category: "shopping.online_marketplace", domains: ["meesho.*"] },
  { name: "AJIO", key: "ajio", category: "shopping.clothing", domains: ["ajio.*"] },
  { name: "Nykaa", key: "nykaa", category: "personal_care", domains: ["nykaa.*", "nykaafashion.*"] },
  { name: "Tata CLiQ", key: "tatacliq", category: "shopping.online_marketplace", domains: ["tatacliq.*"] },
  { name: "Croma", key: "croma", category: "shopping.electronics", domains: ["croma.*"] },
  { name: "Reliance Digital", key: "reliancedigital", category: "shopping.electronics", domains: ["reliancedigital.*"] },
  { name: "BigBasket", key: "bigbasket", category: "groceries", domains: ["bigbasket.*"] },
  { name: "Blinkit", key: "blinkit", category: "groceries", domains: ["blinkit.*"] },
  { name: "Swiggy", key: "swiggy", category: "eating_out.delivery", domains: ["swiggy.*"] },
  { name: "Zomato", key: "zomato", category: "eating_out.delivery", domains: ["zomato.*"] },
  { name: "Mercado Livre", key: "mercadolibre", category: "shopping.online_marketplace", domains: ["mercadolivre.*"] },
  { name: "Mercado Libre", key: "mercadolibre", category: "shopping.online_marketplace", domains: ["mercadolibre.*"] },
  { name: "Magalu", key: "magalu", category: "shopping.online_marketplace", domains: ["magazineluiza.*", "magalu.*"] },
  { name: "Americanas", key: "americanas", category: "shopping.online_marketplace", domains: ["americanas.*"] },
  { name: "Shopee", key: "shopee", category: "shopping.online_marketplace", domains: ["shopee.*", "shp.ee"] },
  { name: "Lazada", key: "lazada", category: "shopping.online_marketplace", domains: ["lazada.*"] },
  { name: "Tokopedia", key: "tokopedia", category: "shopping.online_marketplace", domains: ["tokopedia.*", "tokopedia.link"] },
  { name: "Walmart", key: "walmart", category: "shopping.online_marketplace", domains: ["walmart.*"] },
  { name: "Target", key: "target", category: "shopping", domains: ["target.com"] },
  { name: "Best Buy", key: "bestbuy", category: "shopping.electronics", domains: ["bestbuy.*"] },
  { name: "eBay", key: "ebay", category: "shopping.online_marketplace", domains: ["ebay.*", "ebay.us"] },
  { name: "Etsy", key: "etsy", category: "shopping.online_marketplace", domains: ["etsy.*", "etsy.me"] },
  { name: "AliExpress", key: "aliexpress", category: "shopping.online_marketplace", domains: ["aliexpress.*"] },
  { name: "Temu", key: "temu", category: "shopping.online_marketplace", domains: ["temu.*"] },
  { name: "SHEIN", key: "shein", category: "shopping.clothing", domains: ["shein.*"] },
  { name: "Zalando", key: "zalando", category: "shopping.clothing", domains: ["zalando.*"] },
  { name: "Otto", key: "otto", category: "shopping.online_marketplace", domains: ["otto.de"] },
  { name: "IKEA", key: "ikea", category: "household", domains: ["ikea.*"] },
  { name: "Apple", key: "apple", category: "shopping.electronics", domains: ["apple.com"] },
  { name: "Costco", key: "costco", category: "shopping", domains: ["costco.*"] },
  { name: "Decathlon", key: "decathlon", category: "shopping", domains: ["decathlon.*"] },
  { name: "Jumia", key: "jumia", category: "shopping.online_marketplace", domains: ["jumia.*"] },
  { name: "Takealot", key: "takealot", category: "shopping.online_marketplace", domains: ["takealot.*"] },
  { name: "Rakuten", key: "rakuten", category: "shopping.online_marketplace", domains: ["rakuten.*"] },
  { name: "Coupang", key: "coupang", category: "shopping.online_marketplace", domains: ["coupang.*"] },
];

/** Hosts that resolve product identifiers but are not a seller (GS1 Digital Link resolver). */
const NON_MERCHANT_DOMAINS = new Set(["gs1.org"]);

const DOMAIN_INDEX: ReadonlyMap<string, KnownMerchant> = (() => {
  const m = new Map<string, KnownMerchant>();
  for (const row of MERCHANT_DOMAINS) {
    const known: KnownMerchant = { name: row.name, key: row.key, ...(row.category ? { category: row.category } : {}) };
    for (const d of row.domains) m.set(d, known);
  }
  return m;
})();

/** The merchant a host or URL belongs to, from the data pack only. */
export function knownMerchantForHost(hostOrUrl: string): KnownMerchant | null {
  const host = parseHttpUrl(hostOrUrl)?.host ?? hostOrUrl.toLowerCase().replace(/^www\./, "");
  const reg = registrableDomain(host);
  const firstLabel = reg.split(".")[0] ?? "";
  return DOMAIN_INDEX.get(reg) ?? DOMAIN_INDEX.get(`${firstLabel}.*`) ?? null;
}

/**
 * A display name for any shopping domain: the data pack when known, else
 * the domain's own label ("example-shop.co.uk" -> "Example Shop").
 */
export function merchantForDomain(hostOrUrl: string): { readonly merchant: KnownMerchant; readonly known: boolean } | null {
  const known = knownMerchantForHost(hostOrUrl);
  if (known) return { merchant: known, known: true };
  const host = parseHttpUrl(hostOrUrl)?.host ?? hostOrUrl.toLowerCase();
  const reg = registrableDomain(host);
  if (NON_MERCHANT_DOMAINS.has(reg)) return null;
  const label = reg.split(".")[0] ?? "";
  if (!/[a-z]/.test(label)) return null;
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { merchant: { name, key: label.replace(/[^a-z0-9]/g, "") }, known: false };
}

interface ProductIdRule {
  /** Matched against the path (and the query for `param` rules) before anything is stripped. */
  readonly re: RegExp;
  /** Namespaced id from the match ("asin:B0CHWRXH8B"). */
  readonly id: (m: RegExpExecArray) => string;
}

/**
 * Product identifiers recognisable from URLs. Patterns are observed
 * retailer URL shapes (unverified as contracts; research 08 §5 notes this).
 */
const PRODUCT_ID_RULES: readonly ProductIdRule[] = [
  { re: /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=[/?#]|$)/i, id: (m) => `asin:${(m[1] ?? "").toUpperCase()}` },
  { re: /\/p\/(itm[a-z0-9]{6,})/i, id: (m) => `flipkart:${(m[1] ?? "").toLowerCase()}` },
  { re: /\/(ML[A-Z])-?(\d{6,})/i, id: (m) => `mercadolibre:${(m[1] ?? "").toUpperCase()}${m[2] ?? ""}` },
  { re: /\/ip\/(?:[^/]+\/)?(\d{5,})(?=[/?#]|$)/, id: (m) => `walmart:${m[1] ?? ""}` },
  { re: /\/A-(\d{6,})(?=[/?#]|$)/, id: (m) => `target:${m[1] ?? ""}` },
  { re: /\/listing\/(\d{5,})/, id: (m) => `etsy:${m[1] ?? ""}` },
  { re: /\/itm\/(?:[^/]+\/)?(\d{9,})/, id: (m) => `ebay:${m[1] ?? ""}` },
  // GS1 Digital Link: /01/<GTIN>; GTINs are normalised to 14 digits (schema.org gtin guidance, research 08 §13).
  { re: /\/01\/(\d{8,14})(?=[/?#]|$)/, id: (m) => `gtin:${(m[1] ?? "").padStart(14, "0")}` },
];

/** Path shapes that indicate a product detail page rather than a home/search/article page. */
const PRODUCT_PATH = [
  /\/(?:dp|gp\/product|gp\/aw\/d)\//i,
  /\/p\/[a-z0-9]/i,
  /\/products?\//i,
  /\/produto\//i,
  /\/producto\//i,
  /\/artikel\//i,
  /\/item\//i,
  /\/itm\//i,
  /\/ip\//i,
  /\/A-\d{6,}/,
  /\/listing\/\d/,
  /\/ML[A-Z]-?\d{6,}/i,
  /\/i\.\d+\.\d+/,
  /\/01\/\d{8,14}/,
  /\/site\/[^/]+\/\d+\.p/i,
  /-p-\d{5,}/i,
];

export interface ProductLink {
  /** Canonical URL without query/fragment/tracking segments. */
  readonly url: string;
  /** Lower-case registrable domain ("amazon.in"). */
  readonly domain: string;
  readonly merchant?: KnownMerchant;
  /** True when the merchant came from the data pack rather than the bare domain. */
  readonly merchantKnown: boolean;
  readonly productId?: string;
  /** Human-ish title recovered from a descriptive URL slug. */
  readonly slugTitle?: string;
  /** Path looks like a product page (or carries a product id). */
  readonly productPage: boolean;
  /** An order id carried in the query string ("?order_id=…"), read before the query is discarded. */
  readonly orderIdFromQuery?: string;
}

const ORDER_PARAMS = ["order_id", "orderid", "order_no", "orderno", "ordernumber", "order_number", "order"];

/** Facts about a URL a user shared, pasted, scanned or browsed. Null for non-http(s) input. */
export function describeProductLink(url: string): ProductLink | null {
  const p = parseHttpUrl(url);
  const clean = stripUrl(url);
  if (!p || !clean) return null;
  const domain = registrableDomain(p.host);
  const target = `${p.path}${p.query ? `?${p.query}` : ""}`;
  let productId: string | undefined;
  for (const rule of PRODUCT_ID_RULES) {
    const m = rule.re.exec(target);
    if (m) {
      productId = rule.id(m);
      break;
    }
  }
  const resolved = merchantForDomain(p.host);
  const params = queryParams(p.query);
  const orderId = ORDER_PARAMS.map((k) => params.get(k)).find((v): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9-_]{2,63}$/.test(v));
  const slug = slugTitle(p.path);
  return {
    url: clean,
    domain,
    ...(resolved ? { merchant: resolved.merchant } : {}),
    merchantKnown: resolved?.known ?? false,
    ...(productId ? { productId } : {}),
    ...(slug ? { slugTitle: slug } : {}),
    productPage: productId !== undefined || PRODUCT_PATH.some((re) => re.test(p.path)),
    ...(orderId ? { orderIdFromQuery: orderId } : {}),
  };
}

/** "Apple-AirPods-Pro-2nd-Generation" -> "Apple AirPods Pro 2nd Generation"; lower-case slugs get capitalised words. */
function slugTitle(path: string): string | undefined {
  let best: string | undefined;
  for (const raw of path.split("/")) {
    const seg = safeDecode(raw)
      .replace(/^ML[A-Z]-?\d+-?/i, "") // "MLB-3456789012-fone-…"
      .replace(/-?_JM$/i, "")
      .replace(/\.(?:html?|aspx?|php|p)$/i, "");
    const words = seg.split(/[-_]+/).filter((w) => /\p{L}/u.test(w));
    if (words.length < 2 || seg.includes("=")) continue;
    const text = seg.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!best || text.length > best.length) best = text;
  }
  if (!best) return undefined;
  return best === best.toLowerCase() ? best.replace(/(^|\s)(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase()) : best;
}

/* ------------------------------------------------------------------ */
/* Share adapter                                                       */
/* ------------------------------------------------------------------ */

export interface SharePayload {
  /** Share text (EXTRA_TEXT / NSExtensionItem text) or OCR text of a shared screenshot. */
  readonly text?: string;
  readonly url?: string;
  readonly title?: string;
  /** Sending app (package / bundle id), for provenance only. */
  readonly sourceApp?: string;
  readonly sharedAt: EpochMillis;
}

const ADAPTER_ID = "share";
const EXCERPT_TTL = 7 * DAY;

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "share",
  displayName: "Share to BRAKE",
  windows: ["pre_spend"],
  platforms: ["android", "ios"],
  requiresCapabilities: [],
  privacy: {
    sensitivity: "medium",
    dataCategories: ["links and text you share to BRAKE", "product titles and prices"],
    processing: "on_device",
  },
};

/** Lead-ins retailer apps and people put around a shared link (en/pt/es/hi-Latn), stripped from titles. */
const SHARE_LEAD_INS: readonly RegExp[] = [
  /^(?:hey!?\s*)?(?:check\s+(?:this\s+)?out|have\s+a\s+look\s+at|look\s+at|take\s+a\s+look\s+at|i\s+found|found)\s*(?:this|these)?\s*(?:great\s+)?(?:product|item|deal|offer)?\s*(?:on|at|from)?\s*/i,
  /^(?:confira|olha|veja|d[aá]\s+uma\s+olhada\s+n[oa])\s*(?:s[oó])?\s*(?:este|esse|isso|essa|esta)?\s*(?:produto|oferta)?\s*(?:no|na|em)?\s*/i,
  /^(?:mira|echa\s+un\s+vistazo\s+a)\s*(?:este|esto|esta)?\s*(?:producto|oferta)?\s*(?:en)?\s*/i,
  /^(?:yeh\s+dekho)\s*/i,
];

const SHARE_TRAILERS: readonly RegExp[] = [/\b(?:shared\s+via|sent\s+from|enviado\s+(?:pelo|via))\b.*$/i];

const PRICE_LABEL = /\b(?:price|deal\s+price|now|only|just|at|for|pre[cç]o|por|apenas|precio|preis|mrp)\s*[:\-]?\s*$/i;

export function createShareAdapter(): SignalAdapter<SharePayload> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<SharePayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload;
      if (!p || typeof p !== "object") return { status: "rejected", reason: "payload missing" };
      const sharedAt = Number.isFinite(p.sharedAt) ? p.sharedAt : signal.receivedAt;
      const text = typeof p.text === "string" ? p.text : "";
      const title = typeof p.title === "string" ? normalizeWhitespace(p.title) : "";
      // OTPs are dropped before anything else is looked at.
      if (isOneTimePasswordMessage(`${title}\n${text}`)) return { status: "ignored", reason: "otp" };

      const urls = [...(typeof p.url === "string" && p.url.trim() ? [p.url.trim()] : []), ...findUrls(text)];
      const link = urls.map(describeProductLink).find((l): l is ProductLink => l !== null) ?? null;
      const priceText = [title, stripUrls(text)].join("\n");
      const price = extractAmount(priceText, ctx);

      const isProduct = link !== null && (link.productPage || (link.merchantKnown && link.url.split("/").length > 3));
      if (!isProduct && !(price && (link === null || link.merchantKnown))) {
        return { status: "ignored", reason: "not_financial" };
      }

      const derivedTitle = title || cleanShareTitle(text, link?.merchant?.name) || link?.slugTitle;
      const merchant = link?.merchant ? shareMerchant(link) : undefined;
      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "share",
        connectionId: signal.connectionId,
        ...(link?.merchant ? { provider: link.merchant.name } : {}),
        label: link?.merchant ? `shared ${link.merchant.name} link` : "shared link",
      };
      const categoryHints: CategoryHint[] = link?.merchant?.category && link.merchantKnown
        ? [{ scheme: "brake", value: link.merchant.category, confidence: 0.5 }]
        : [];
      const confidence: Probability = link ? (link.merchantKnown ? 0.85 : 0.75) : 0.6;
      const summaryParts = [
        `You shared ${link?.merchant ? `${withArticle(link.merchant.name)} product` : "a product"}`,
        derivedTitle ? `: “${truncate(derivedTitle, 80)}”` : "",
        price ? ` (${price.raw.trim()} shown, may exclude tax or shipping)` : "",
        ".",
      ];
      const excerptSource = [title, replaceUrlsWithStripped(text)].filter(Boolean).join(" — ");
      const excerpt = excerptSource ? truncate(redactSensitive(normalizeWhitespace(excerptSource)).text, 200) : "";

      const observation: Observation = {
        id: observationId(ADAPTER_ID, signal.connectionId, `${sharedAt}|${p.url ?? ""}|${text}|${title}`),
        source,
        kind: "purchase_intent",
        window: "pre_spend",
        stage: "intent",
        receivedAt: signal.receivedAt,
        occurredAt: { value: sharedAt, confidence: 0.95 },
        direction: "debit",
        // A shared price is a list price: tax, shipping, coupons and variants move the final amount.
        ...(price ? { amount: { value: price.money, confidence: 0.65, approximate: true } } : {}),
        ...(merchant ? { merchant } : {}),
        references: [],
        ...(categoryHints.length > 0 ? { categoryHints } : {}),
        intent: {
          via: "share",
          ...(derivedTitle ? { title: derivedTitle } : {}),
          ...(link ? { url: link.url } : {}),
          ...(link?.productId ? { productId: link.productId } : {}),
        },
        confidence,
        evidence: {
          summary: summaryParts.join(""),
          ...(excerpt ? { excerpt, excerptExpiresAt: signal.receivedAt + EXCERPT_TTL } : {}),
        },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

function shareMerchant(link: ProductLink): MerchantObservation | undefined {
  if (!link.merchant) return undefined;
  return {
    raw: link.domain,
    name: link.merchant.name,
    key: link.merchant.key,
    website: link.domain,
    channel: "online",
    confidence: link.merchantKnown ? 0.9 : 0.6,
  };
}

function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, " ");
}

function replaceUrlsWithStripped(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (u) => stripUrl(u.replace(/[),.;:!?]+$/, "")) ?? "");
}

/** Title from share text: drop URLs, prices, retailer boilerplate and "on <merchant>" tails. */
export function cleanShareTitle(text: string, merchantName?: string): string | undefined {
  let t = normalizeWhitespace(stripUrls(text).replace(/\n+/g, " "));
  for (const re of SHARE_TRAILERS) t = t.replace(re, "");
  // Remove currency-marked prices together with a dangling "price:"/"for" label.
  for (let price = extractAmount(t); price; price = extractAmount(t)) {
    const before = t.slice(0, price.index).replace(PRICE_LABEL, "");
    t = `${before} ${t.slice(price.index + price.raw.length)}`;
  }
  for (const re of SHARE_LEAD_INS) t = t.replace(re, "");
  if (merchantName) {
    const name = merchantName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\s*(?:on|at|from|no|na|en)?\\s*${name}\\b\\s*[:\\-–—]?`, "i"), "");
    t = t.replace(new RegExp(`\\s*(?:on|at|from|no|na|en)\\s+${name}\\b(?:\\.[a-z.]+)?\\s*[:!.\\-–—]*\\s*$`, "i"), "");
  }
  t = t.replace(/\s+[|\-–—:]\s*$/, "").replace(/^[\s:|\-–—!.,]+|[\s:|\-–—!,]+$/g, "").trim();
  return t.length >= 3 && /\p{L}{2}/u.test(t) ? truncate(t, 200) : undefined;
}

/** "an Amazon", "a Flipkart". */
function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
