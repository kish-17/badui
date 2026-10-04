import { extractJsonLd, htmlToText } from "./html";
import type { NormalizedEmail, SenderInfo, SenderMatch, SenderVariant } from "./model";

/**
 * Transactional-sender knowledge: which sending domains belong to which
 * merchant/bank/payment/travel/subscription brand. This is the email data
 * pack; adding a country or merchant is a new row here, never new control
 * flow (ADR-003). Categories are BRAKE taxonomy ids copied as strings from
 * packages/intelligence/src/taxonomy.ts (adapters do not import intelligence).
 *
 * Sources for the sender addresses: docs/research/06-email-intelligence.md
 * (§13a HDFC `alerts@hdfcbank.net` and the 2025 `.bank.in` migration; §13b
 * Swiggy `noreply@swiggy.in`, Zomato `noreply@zomato.com`; Amazon order
 * mail) and the merchants' own published "how to recognise our emails"
 * help pages (Amazon auto-confirm@/order-update@, Apple
 * no_reply@email.apple.com, Google Play googleplay-noreply@google.com).
 * Addresses not individually verified are matched by domain only.
 *
 * Domain matching is by the sender's From domain. It is a *routing* hint, not
 * a trust decision: trust comes from DKIM (`EmailAuthentication`), which the
 * adapter applies separately, because From headers are trivially spoofed.
 */

interface SenderRow {
  readonly domains: readonly string[];
  readonly info: SenderInfo;
}

const AMAZON_ADDRESSES = [
  "auto-confirm",
  "order-update",
  "shipment-tracking",
  "returns",
  "return",
  "payments-messages",
  "digital-no-reply",
  "no-reply",
  "donotreply",
  "account-update",
] as const;

const ROWS: readonly SenderRow[] = [
  // ---- India
  { domains: ["amazon.in"], info: { key: "amazon", displayName: "Amazon", role: "merchant", country: "IN", currency: "INR", category: "shopping.online_marketplace", addresses: AMAZON_ADDRESSES } },
  { domains: ["flipkart.com"], info: { key: "flipkart", displayName: "Flipkart", role: "merchant", country: "IN", currency: "INR", category: "shopping.online_marketplace" } },
  { domains: ["myntra.com"], info: { key: "myntra", displayName: "Myntra", role: "merchant", country: "IN", currency: "INR", category: "shopping.clothing" } },
  { domains: ["swiggy.in"], info: { key: "swiggy", displayName: "Swiggy", role: "merchant", country: "IN", currency: "INR", category: "eating_out.delivery" } },
  { domains: ["zomato.com"], info: { key: "zomato", displayName: "Zomato", role: "merchant", country: "IN", currency: "INR", category: "eating_out.delivery" } },
  { domains: ["bigbasket.com"], info: { key: "bigbasket", displayName: "BigBasket", role: "merchant", country: "IN", currency: "INR", category: "groceries" } },
  { domains: ["blinkit.com"], info: { key: "blinkit", displayName: "Blinkit", role: "merchant", country: "IN", currency: "INR", category: "groceries" } },
  { domains: ["zeptonow.com"], info: { key: "zepto", displayName: "Zepto", role: "merchant", country: "IN", currency: "INR", category: "groceries" } },
  { domains: ["olacabs.com"], info: { key: "ola", displayName: "Ola", role: "merchant", country: "IN", currency: "INR", category: "transport.rideshare" } },
  { domains: ["bookmyshow.com"], info: { key: "bookmyshow", displayName: "BookMyShow", role: "merchant", country: "IN", currency: "INR", category: "entertainment.events" } },
  { domains: ["makemytrip.com"], info: { key: "makemytrip", displayName: "MakeMyTrip", role: "travel", country: "IN", currency: "INR", category: "travel" } },
  { domains: ["irctc.co.in"], info: { key: "irctc", displayName: "IRCTC", role: "travel", country: "IN", currency: "INR", category: "travel" } },
  { domains: ["goindigo.in"], info: { key: "indigo", displayName: "IndiGo", role: "travel", country: "IN", currency: "INR", category: "travel.flights" } },
  { domains: ["hotstar.com"], info: { key: "jiohotstar", displayName: "JioHotstar", role: "subscription", country: "IN", currency: "INR", category: "entertainment.streaming" } },
  { domains: ["hdfcbank.net", "hdfcbank.bank.in", "hdfcbank.com"], info: { key: "hdfc_bank", displayName: "HDFC Bank", role: "bank", country: "IN", currency: "INR" } },
  { domains: ["icicibank.com", "icici.bank.in"], info: { key: "icici_bank", displayName: "ICICI Bank", role: "bank", country: "IN", currency: "INR" } },
  { domains: ["axisbank.com", "axis.bank.in"], info: { key: "axis_bank", displayName: "Axis Bank", role: "bank", country: "IN", currency: "INR" } },
  { domains: ["sbi.co.in", "sbi.bank.in"], info: { key: "sbi", displayName: "State Bank of India", role: "bank", country: "IN", currency: "INR" } },
  { domains: ["kotak.com", "kotak.bank.in"], info: { key: "kotak_bank", displayName: "Kotak Mahindra Bank", role: "bank", country: "IN", currency: "INR" } },
  { domains: ["paytm.com"], info: { key: "paytm", displayName: "Paytm", role: "payment", country: "IN", currency: "INR" } },
  { domains: ["phonepe.com"], info: { key: "phonepe", displayName: "PhonePe", role: "payment", country: "IN", currency: "INR", p2p: true } },
  { domains: ["razorpay.com"], info: { key: "razorpay", displayName: "Razorpay", role: "payment", country: "IN", currency: "INR" } },

  // ---- United States
  { domains: ["amazon.com"], info: { key: "amazon", displayName: "Amazon", role: "merchant", country: "US", currency: "USD", category: "shopping.online_marketplace", addresses: AMAZON_ADDRESSES } },
  { domains: ["walmart.com"], info: { key: "walmart", displayName: "Walmart", role: "merchant", country: "US", currency: "USD", category: "shopping" } },
  { domains: ["target.com"], info: { key: "target", displayName: "Target", role: "merchant", country: "US", currency: "USD", category: "shopping" } },
  { domains: ["doordash.com"], info: { key: "doordash", displayName: "DoorDash", role: "merchant", country: "US", currency: "USD", category: "eating_out.delivery" } },
  { domains: ["instacart.com"], info: { key: "instacart", displayName: "Instacart", role: "merchant", country: "US", currency: "USD", category: "groceries" } },
  { domains: ["lyft.com"], info: { key: "lyft", displayName: "Lyft", role: "merchant", country: "US", currency: "USD", category: "transport.rideshare", mcc: "4121" } },
  { domains: ["hulu.com"], info: { key: "hulu", displayName: "Hulu", role: "subscription", country: "US", currency: "USD", category: "entertainment.streaming" } },
  { domains: ["expedia.com"], info: { key: "expedia", displayName: "Expedia", role: "travel", country: "US", currency: "USD", category: "travel" } },
  { domains: ["united.com"], info: { key: "united", displayName: "United Airlines", role: "travel", country: "US", currency: "USD", category: "travel.flights" } },
  { domains: ["chase.com"], info: { key: "chase", displayName: "Chase", role: "bank", country: "US", currency: "USD" } },
  { domains: ["americanexpress.com", "aexp.com"], info: { key: "amex", displayName: "American Express", role: "bank", currency: "USD" } },
  { domains: ["capitalone.com"], info: { key: "capital_one", displayName: "Capital One", role: "bank", country: "US", currency: "USD" } },
  { domains: ["venmo.com"], info: { key: "venmo", displayName: "Venmo", role: "payment", country: "US", currency: "USD", p2p: true } },
  { domains: ["cash.app", "square.com"], info: { key: "cash_app", displayName: "Cash App", role: "payment", country: "US", currency: "USD", p2p: true } },

  // ---- United Kingdom / European Union
  { domains: ["amazon.co.uk"], info: { key: "amazon", displayName: "Amazon", role: "merchant", country: "GB", currency: "GBP", category: "shopping.online_marketplace", addresses: AMAZON_ADDRESSES } },
  { domains: ["amazon.de"], info: { key: "amazon", displayName: "Amazon", role: "merchant", country: "DE", currency: "EUR", category: "shopping.online_marketplace", addresses: AMAZON_ADDRESSES } },
  { domains: ["deliveroo.co.uk"], info: { key: "deliveroo", displayName: "Deliveroo", role: "merchant", country: "GB", currency: "GBP", category: "eating_out.delivery" } },
  { domains: ["tesco.com"], info: { key: "tesco", displayName: "Tesco", role: "merchant", country: "GB", currency: "GBP", category: "groceries" } },
  { domains: ["ocado.com"], info: { key: "ocado", displayName: "Ocado", role: "merchant", country: "GB", currency: "GBP", category: "groceries" } },
  { domains: ["trainline.com"], info: { key: "trainline", displayName: "Trainline", role: "travel", category: "travel" } },
  { domains: ["monzo.com"], info: { key: "monzo", displayName: "Monzo", role: "bank", country: "GB", currency: "GBP" } },
  { domains: ["revolut.com"], info: { key: "revolut", displayName: "Revolut", role: "bank" } },
  { domains: ["zalando.de", "zalando.com", "zalando.co.uk"], info: { key: "zalando", displayName: "Zalando", role: "merchant", currency: "EUR", category: "shopping.clothing" } },
  { domains: ["lieferando.de"], info: { key: "lieferando", displayName: "Lieferando", role: "merchant", country: "DE", currency: "EUR", category: "eating_out.delivery" } },
  { domains: ["bahn.de"], info: { key: "deutsche_bahn", displayName: "Deutsche Bahn", role: "travel", country: "DE", currency: "EUR", category: "transport.public" } },

  // ---- Brazil
  { domains: ["amazon.com.br"], info: { key: "amazon", displayName: "Amazon", role: "merchant", country: "BR", currency: "BRL", category: "shopping.online_marketplace", addresses: AMAZON_ADDRESSES } },
  { domains: ["mercadolivre.com.br", "mercadolivre.com", "mercadolibre.com"], info: { key: "mercado_livre", displayName: "Mercado Livre", role: "merchant", country: "BR", currency: "BRL", category: "shopping.online_marketplace" } },
  { domains: ["mercadopago.com.br", "mercadopago.com"], info: { key: "mercado_pago", displayName: "Mercado Pago", role: "payment", country: "BR", currency: "BRL" } },
  { domains: ["ifood.com.br"], info: { key: "ifood", displayName: "iFood", role: "merchant", country: "BR", currency: "BRL", category: "eating_out.delivery" } },
  { domains: ["magazineluiza.com.br", "magalu.com"], info: { key: "magalu", displayName: "Magalu", role: "merchant", country: "BR", currency: "BRL", category: "shopping.online_marketplace" } },
  { domains: ["99app.com"], info: { key: "99", displayName: "99", role: "merchant", country: "BR", currency: "BRL", category: "transport.rideshare" } },
  { domains: ["latam.com"], info: { key: "latam", displayName: "LATAM Airlines", role: "travel", category: "travel.flights" } },
  { domains: ["nubank.com.br"], info: { key: "nubank", displayName: "Nubank", role: "bank", country: "BR", currency: "BRL" } },
  { domains: ["itau.com.br"], info: { key: "itau", displayName: "Itaú", role: "bank", country: "BR", currency: "BRL" } },
  { domains: ["picpay.com"], info: { key: "picpay", displayName: "PicPay", role: "payment", country: "BR", currency: "BRL", p2p: true } },

  // ---- Global brands (no market: amounts resolve with the user's country hint)
  {
    domains: ["uber.com"],
    info: {
      key: "uber",
      displayName: "Uber",
      role: "merchant",
      category: "transport.rideshare",
      mcc: "4121",
      variants: [{ subjectKeyword: "uber eats", key: "uber_eats", displayName: "Uber Eats", category: "eating_out.delivery" }],
    },
  },
  { domains: ["netflix.com"], info: { key: "netflix", displayName: "Netflix", role: "subscription", category: "entertainment.streaming", mcc: "4899" } },
  { domains: ["spotify.com"], info: { key: "spotify", displayName: "Spotify", role: "subscription", category: "entertainment.streaming" } },
  { domains: ["disneyplus.com"], info: { key: "disney_plus", displayName: "Disney+", role: "subscription", category: "entertainment.streaming" } },
  { domains: ["youtube.com"], info: { key: "youtube", displayName: "YouTube", role: "subscription", category: "entertainment.streaming", addresses: ["noreply-purchases", "youtube-noreply"] } },
  { domains: ["email.apple.com"], info: { key: "apple", displayName: "Apple", role: "subscription", addresses: ["no_reply", "no-reply"] } },
  { domains: ["google.com"], info: { key: "google_play", displayName: "Google Play", role: "subscription", addresses: ["googleplay-noreply", "payments-noreply"] } },
  { domains: ["airbnb.com"], info: { key: "airbnb", displayName: "Airbnb", role: "travel", category: "travel.lodging" } },
  { domains: ["booking.com"], info: { key: "booking", displayName: "Booking.com", role: "travel", category: "travel.lodging" } },
  { domains: ["paypal.com", "paypal.co.uk", "paypal.de", "paypal.com.br", "intl.paypal.com"], info: { key: "paypal", displayName: "PayPal", role: "payment" } },
];

const BY_DOMAIN: ReadonlyMap<string, SenderInfo> = new Map(ROWS.flatMap((r) => r.domains.map((d) => [d, r.info] as const)));

/** Every sender row, for consent UIs ("BRAKE reads email from these senders") and query building. */
export const TRANSACTIONAL_SENDERS: readonly { readonly domain: string; readonly info: SenderInfo }[] = ROWS.flatMap((r) =>
  r.domains.map((domain) => ({ domain, info: r.info })),
);

/**
 * The sender list compiled into a Gmail `from:` clause or a forwarding filter:
 * specific addresses where the data pack knows them (so store-news@amazon.in
 * is never fetched), whole domains otherwise.
 */
export function defaultTransactionalSenders(): string[] {
  return TRANSACTIONAL_SENDERS.flatMap(({ domain, info }) =>
    info.addresses ? info.addresses.map((local) => `${local}@${domain}`) : [domain],
  );
}

/** Domain part of an address, lower-cased ("auto-confirm@Amazon.in" -> "amazon.in"). */
export function emailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/[>.\s]+$/, "");
}

/**
 * Resolve a sender address against the data pack: the longest registered
 * domain that equals the sender's domain or is a parent of it
 * ("noreply@nct.flipkart.com" -> flipkart.com).
 */
export function lookupSender(address: string): SenderMatch | undefined {
  const lower = address.trim().toLowerCase();
  const local = lower.includes("@") ? lower.slice(0, lower.lastIndexOf("@")) : "";
  const labels = emailDomain(lower).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = labels.slice(i).join(".");
    const info = BY_DOMAIN.get(domain);
    if (info) {
      const addressKnown = !info.addresses || info.addresses.includes(local);
      return { info, domain, addressKnown };
    }
  }
  return undefined;
}

/** The sub-brand a subject selects ("Your Uber Eats order" -> Uber Eats), else the sender itself. */
export function senderVariant(info: SenderInfo, subject: string): Pick<SenderVariant, "key" | "displayName" | "category"> {
  const lower = subject.toLowerCase();
  const v = info.variants?.find((x) => lower.includes(x.subjectKeyword));
  return v ?? { key: info.key, displayName: info.displayName, ...(info.category ? { category: info.category } : {}) };
}

/** True when an allow-list entry ("amazon.in", "@amazon.in", "alerts@hdfcbank.net") covers the address. */
export function senderAllowed(address: string, allowed: readonly string[]): boolean {
  const lower = address.trim().toLowerCase();
  const domain = emailDomain(lower);
  return allowed.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^@/, "");
    if (entry.length === 0) return false;
    if (entry.includes("@")) return entry === lower;
    return domain === entry || domain.endsWith(`.${entry}`);
  });
}

/** Consumer mailbox providers: a From name on these domains is a person, never a merchant. */
const PERSONAL_MAIL_DOMAINS =
  /^(?:gmail\.com|googlemail\.com|yahoo\.[a-z.]+|ymail\.com|outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|icloud\.com|me\.com|mac\.com|aol\.com|proton\.me|protonmail\.com|gmx\.[a-z.]+|web\.de|rediffmail\.com|yandex\.[a-z.]+|mail\.ru|uol\.com\.br|bol\.com\.br|terra\.com\.br|qq\.com|163\.com)$/;

export function isPersonalMailbox(domain: string): boolean {
  return PERSONAL_MAIL_DOMAINS.test(domain.toLowerCase());
}

// ---------------------------------------------------------------------------
// Transactional vs promotional
// ---------------------------------------------------------------------------

/**
 * Marketing subjects across the launch languages. A merchant's sale mail is
 * never a receipt, and neither is a cart reminder ("Complete your order: items
 * in your bag are waiting"): research 06 §13h treats abandoned-cart mail as
 * opt-in research, so it must not become a confirmed order.
 */
const MARKETING_SUBJECT =
  /(\d{1,2}\s?%\s?(?:off|de desconto|rabatt)|\bup to \d|\bsale\b|\bdeals?\b|\boffers?\b|\bdiscount|\bcoupon|\bpromo(?:tion|code|ção)?\b|\bsave (?:up to|big|\d|[₹$€£])|limited[- ]time|new arrivals?|just for you|recommended for you|you (?:might|may) (?:also )?like|newsletter|weekly digest|flash sale|lowest price|best price|last chance|don'?t miss|ends tonight|free shipping on|back in stock|price drop|cashback offer|pre-?approved|earn (?:rewards|points)|black friday|cyber monday|great indian festival|big billion|prime day|\boferta|desconto|\bcupom|\bangebot|gutschein|\bsoldes\b|\bin your (?:cart|bag|basket|trolley)\b|\bleft (?:something|items?|these|it) (?:in|behind)\b|\bcomplete your (?:order|purchase|checkout)\b|\bforgot something\b|\bstill (?:interested|thinking|deciding)\b|\bitems? (?:are|is) waiting\b|\bno seu carrinho\b|\bim (?:warenkorb|einkaufswagen)\b)/i;

/** Cart-reminder bodies: whatever the subject says, nothing was bought. */
const CART_BODY =
  /\b(?:you left (?:these|something|items?|it)|(?:items?|products?) (?:left |still )?in your (?:cart|bag|basket|trolley)|complete your (?:order|purchase|checkout)|place (?:your )?order now|your (?:cart|bag|basket) is waiting|esqueceu (?:algo|no carrinho)|noch im warenkorb)\b/i;

/** Subject words of receipts, renewals, refunds, bookings and alerts (en/pt/de/fr/es). */
const TRANSACTIONAL_SUBJECT =
  /\b(receipt|order(?:ed)?|invoice|payment|paid|renew(?:al|s|ed|ing)?|subscription|membership|trial|refund(?:ed)?|cancel+(?:ed|ation)?|booking|booked|reservation|itinerary|e-?ticket|pnr|trip|ride|shipped|dispatched|delivered|out for delivery|arriving|debited|credited|transaction|txn|spent|charged|purchase|statement|bill|prices?|pedido|recibo|fatura|nota fiscal|compra|reembolso|assinatura|pagamento|bestellung|rechnung|zahlung|erstattung|buchung|abonnement|commande|facture|remboursement|factura|reserva)\b/i;

/** Body phrases that only transactional mail uses. */
const TRANSACTIONAL_BODY =
  /(order total|grand total|total amount|amount paid|total paid|total charged|you paid|has been (?:debited|credited|charged|processed|initiated|refunded)|(?:will|to) (?:auto-?)?renew|renews on|trial (?:period )?(?:ends|will end|is ending|expires)|refund (?:of|for|has|is|was)|payment (?:received|successful|failed|declined)|booking (?:id|reference|confirmed|number)|reservation (?:number|confirmed)|confirmation (?:number|code)|order (?:id|no\.?|number|#)|transaction (?:reference|id)|valor total|total do pedido|gesamtbetrag|montant total|price (?:is|will be) (?:changing|increasing|going up)|updating (?:our|your) prices|new price|price (?:change|increase))/i;

/** schema.org types that only transactional email carries (Gmail "Email Markup" types). */
export const TRANSACTIONAL_LD_TYPES: ReadonlySet<string> = new Set([
  "Order",
  "Invoice",
  "ParcelDelivery",
  "Reservation",
  "FlightReservation",
  "LodgingReservation",
  "FoodEstablishmentReservation",
  "EventReservation",
  "RentalCarReservation",
  "TrainReservation",
  "BusReservation",
  "TaxiReservation",
]);

/** Local name of a schema.org `@type` ("http://schema.org/Order" -> "Order"); first entry of an array. */
export function ldTypeOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const t = (node as Record<string, unknown>)["@type"];
  const first = Array.isArray(t) ? t.find((x) => typeof x === "string" && TRANSACTIONAL_LD_TYPES.has(localName(x))) ?? t[0] : t;
  return typeof first === "string" ? localName(first) : undefined;
}

function localName(t: string): string {
  return t.replace(/^.*[/#:]/, "");
}

export interface EmailClassification {
  readonly transactional: boolean;
  /** Why a non-transactional email is ignored. */
  readonly reason?: "promotional" | "not_financial";
  readonly sender?: SenderMatch;
  /** 0..1 evidence score; transactional at >= 0.6. */
  readonly score: number;
}

export interface ClassifyOptions {
  /** Visible text when the caller already converted the HTML (avoids doing it twice). */
  readonly text?: string;
  /** Effective sender when the caller unwrapped a manual forward. */
  readonly from?: string;
  /** schema.org nodes when the caller already extracted them (else they are read from the HTML). */
  readonly jsonLd?: readonly unknown[];
  readonly subject?: string;
}

/**
 * Is this email worth extracting? Combines sender knowledge, subject and body
 * keywords and schema.org markup. Marketing subjects ("Up to 70% off") are
 * promotional even from a known merchant; a `List-Unsubscribe` header alone
 * only lowers the score, because many receipts carry one too, and it never
 * implies a *paid* subscription (research 06 §13c).
 */
export function classifyEmail(email: NormalizedEmail, opts: ClassifyOptions = {}): EmailClassification {
  const subject = opts.subject ?? email.subject;
  const sender = lookupSender(opts.from ?? email.from.address);
  const nodes = opts.jsonLd ?? email.jsonLd ?? (email.html ? extractJsonLd(email.html) : []);
  const hasLd = nodes.some((n) => {
    const t = ldTypeOf(n);
    return t !== undefined && TRANSACTIONAL_LD_TYPES.has(t);
  });
  if (hasLd) return { transactional: true, score: 1, ...(sender ? { sender } : {}) };
  if (MARKETING_SUBJECT.test(subject)) return { transactional: false, reason: "promotional", score: 0, ...(sender ? { sender } : {}) };

  const text = opts.text ?? (email.html ? htmlToText(email.html) : email.text ?? "");
  if (CART_BODY.test(text)) return { transactional: false, reason: "promotional", score: 0, ...(sender ? { sender } : {}) };
  let score = 0;
  if (sender?.addressKnown) score += 0.4;
  else if (sender) score -= 0.1;
  if (TRANSACTIONAL_SUBJECT.test(subject)) score += 0.35;
  if (TRANSACTIONAL_BODY.test(text)) score += 0.3;
  if (email.listUnsubscribe) score -= 0.15;
  const clamped = Math.max(0, Math.min(1, score));
  if (score >= 0.6) return { transactional: true, score: clamped, ...(sender ? { sender } : {}) };
  return {
    transactional: false,
    reason: email.listUnsubscribe ? "promotional" : "not_financial",
    score: clamped,
    ...(sender ? { sender } : {}),
  };
}

export function isLikelyTransactional(email: NormalizedEmail): boolean {
  return classifyEmail(email).transactional;
}
