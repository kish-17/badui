import { DAY, maskTail, redactSensitive } from "@brake/core";
import type {
  AmountComponent,
  AmountComponentKind,
  CategoryHint,
  Direction,
  EpochMillis,
  InstrumentObservation,
  InstrumentType,
  LineItem,
  Measured,
  MerchantObservation,
  Money,
  PaymentRail,
  Reference,
  ReferenceType,
  SubscriptionDetails,
  SubscriptionEventKind,
  TransactionStatus,
  TypeHint,
} from "@brake/core";
import { extractAmounts, lastFour, normalizeWhitespace, parseDateTime } from "../shared/text";
import type { ExtractedAmount } from "../shared/text";
import type { EmailContext, EmailFinding, ExtractionMethod } from "./model";
import { senderVariant } from "./senders";

/**
 * Heuristic extractors for emails without schema.org markup. They run on
 * `htmlToText` output (rows as lines, cells as tabs) and are deliberately
 * label-driven: every phrase list below is data, so a new language or merchant
 * template is a new pattern, not a new branch.
 *
 * One email yields at most one heuristic finding. Detection order matters:
 * bank/payment alerts, then refunds (which mention orders), then subscription
 * lifecycle notices, then bookings, then orders/receipts/invoices/deliveries.
 */

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function extractFindings(text: string, ctx: EmailContext): EmailFinding[] {
  const subjectOnly = text.trim().length === 0;
  const body = subjectOnly ? ctx.subject : text;
  const doc = toDoc(body, ctx, subjectOnly ? "subject_only" : "heuristic");
  const role = ctx.sender?.info.role;

  // Banks and wallets only ever yield alerts here. Their statements ("Total Amount
  // Due") are not purchases, and card-statement parsing is out of scope (research 06 §13g).
  if (role === "bank" || role === "payment") {
    if (STATEMENT_SUBJECT.test(ctx.subject)) return [];
    return finalize(alertFinding(doc), subjectOnly);
  }
  const finding =
    (!ctx.sender && BANK_ALERT.test(doc.flat) ? alertFinding(doc) : undefined) ??
    refundFinding(doc) ??
    subscriptionFinding(doc) ??
    bookingFinding(doc) ??
    orderFinding(doc);
  return finalize(finding, subjectOnly);
}

const STATEMENT_SUBJECT = /\b(?:e-?statement|statement|extrato|fatura do cartão|kontoauszug|relevé)\b/i;

function finalize(finding: EmailFinding | undefined, subjectOnly: boolean): EmailFinding[] {
  if (!finding) return [];
  if (!subjectOnly) return [finding];
  // Subject-only (e.g. Graph Mail.ReadBasic): kind and maybe amount, never trusted beyond ~0.45.
  const { lineItems: _items, amount, ...rest } = finding;
  return [
    {
      ...rest,
      ...(amount ? { amount: { ...amount, confidence: Math.min(0.5, amount.confidence) } } : {}),
      method: "subject_only",
      confidence: Math.min(0.45, finding.confidence * 0.5),
    },
  ];
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface Doc {
  readonly lines: readonly string[];
  /** Lines joined with "\n" (tabs preserved). */
  readonly flat: string;
  readonly ctx: EmailContext;
  readonly method: ExtractionMethod;
  /** Subject + body, for keyword tests that may hit either. */
  readonly all: string;
}

function toDoc(text: string, ctx: EmailContext, method: ExtractionMethod): Doc {
  const lines = text
    .split(/\r?\n/)
    .map((l) => guardQuantities(l.split("\t").map((c) => normalizeWhitespace(c)).filter((c) => c.length > 0).join("\t")))
    .filter((l) => l.length > 0);
  const flat = lines.join("\n");
  return { lines, flat, ctx, method, all: `${ctx.subject}\n${flat}` };
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Currency markers that can prefix a number. Used to stop a quantity in front
 * of a prefixed price ("Qty: 1\t₹2,999.00", "x 2 ₹ 640") from being read as a
 * suffix-currency amount ("1 ₹"), a known ambiguity of suffix markers.
 */
const PREFIX_MARKER = "(?:US\\$|R\\$|S\\$|A\\$|C\\$|Rs\\.?|INR|USD|EUR|GBP|BRL|[₹$€£¥])";
const QTY_BEFORE_PRICE = new RegExp(`(\\d)([ \\t\\u00a0]*)(?=${PREFIX_MARKER}\\s?\\d)`, "gi");

/** Separates a quantity from a following prefixed price. Idempotent, so already-guarded text is unchanged. */
function guardQuantities(s: string): string {
  return s.replace(QTY_BEFORE_PRICE, "$1$2| ");
}

/**
 * Currency-marked amounts in a string, robust to "qty price" adjacency.
 * Indices refer to the guarded string; document lines are guarded on load so
 * they line up there.
 */
export function amountsIn(s: string, ctx: Pick<EmailContext, "country" | "defaultCurrency">): ExtractedAmount[] {
  const guarded = guardQuantities(s);
  const opts = { ...(ctx.country ? { country: ctx.country } : {}), ...(ctx.defaultCurrency ? { defaultCurrency: ctx.defaultCurrency } : {}) };
  let found: ExtractedAmount[];
  try {
    found = extractAmounts(guarded, opts);
  } catch {
    // A digit run long enough to overflow a double makes core's Money constructor throw
    // ("Total ₹999…9"). Neutralise such runs (same length, so indices still line up) and retry.
    try {
      found = extractAmounts(neutralizeHugeNumbers(guarded), opts);
    } catch {
      found = [];
    }
  }
  // Anything beyond 2^53 minor units is not a price, and integer Money must stay exact.
  return found.filter((a) => Number.isSafeInteger(a.money.minor));
}

/** Digits a single figure may have before it is treated as noise rather than an amount. */
const MAX_AMOUNT_DIGITS = 15;

function neutralizeHugeNumbers(s: string): string {
  return s.replace(/\d[\d,.\u00a0\u202f' ]*\d/g, (tok) => (tok.replace(/\D/g, "").length > MAX_AMOUNT_DIGITS ? tok.replace(/\d/g, "#") : tok));
}

/**
 * The nearest balance/limit word before an amount, with nothing but words
 * (no digits, no line break, no movement verb) between them. Covers "Avl Bal:
 * Rs 12,345", "Available Balance in your account is INR 50,000.00" and
 * "Available Credit Limit on your card is INR 1,23,456.00", while "balance
 * after debit of INR 2,500" still yields the debit.
 */
const BALANCE_WORD = /^[\s\S]*\b(?:bal(?:ance)?|avl|avbl|available|limit|saldo|kontostand)\b([^\d\n]{0,48})$/i;
const MOVEMENT_WORD = /\b(?:debit(?:ed)?|credited|spent|charged|paid|withdrawn|deducted|transferred|refunded)\b/i;

/** True when the amount right after `prefix` is a balance or limit, not the transaction. */
function isBalanceAmount(prefix: string): boolean {
  const m = BALANCE_WORD.exec(prefix.slice(-160));
  return m !== null && !MOVEMENT_WORD.test(m[1] ?? "");
}

function measured<T>(value: T, confidence: number, approximate = false): Measured<T> {
  return approximate ? { value, confidence, approximate } : { value, confidence };
}

// ---------------------------------------------------------------------------
// Labels (data)
// ---------------------------------------------------------------------------

/** Total labels, best first. Rank 0 is money actually charged; rank 1 the order total; rank 2 a bare "Total". */
const TOTAL_LABELS: readonly { readonly re: RegExp; readonly rank: number }[] = [
  { re: /\b(?:amount paid|total paid|paid amount|amount charged|total charged|you paid|charged to your|valor pago|total pago|bezahlter betrag|montant payé|importe pagado)\b/i, rank: 0 },
  { re: /\b(?:grand total|order total|total amount|total fare|amount due|total due|net payable|amount payable|bill total|total payable|to pay|total price|total do pedido|valor total|total da compra|gesamtbetrag|gesamtsumme|endbetrag|montant total|total ttc|importe total)\b/i, rank: 1 },
  { re: /(?<![\w-])(?<!items?\s)(?<!item\(s\)\s)(?<!sub\s)total\b(?!\s*(?:savings|saved|discount|items?\b|quantity|qty|weight|distance|time|tax|before))/i, rank: 2 },
  { re: /\b(?:summe|soma)\b/i, rank: 3 },
];

/** Price components. Order matters: "delivery fee" is shipping, not a fee. */
const COMPONENT_LABELS: readonly { readonly kind: AmountComponentKind; readonly re: RegExp }[] = [
  // "Total before tax" (Amazon.com) is the pre-tax subtotal, not tax.
  { kind: "subtotal", re: /\b(?:sub-?\s?total|items? (?:sub)?total|item\(s\) subtotal|item total|(?:total )?before tax|pre-?tax total|trip fare|base fare|(?<!total\s)fare|zwischensumme|sous-total)\b/i },
  { kind: "shipping", re: /\b(?:shipping|delivery (?:fee|charges?)|delivery partner fee|postage|frete|taxa de entrega|versand(?:kosten)?|livraison|envío)\b/i },
  { kind: "tip", re: /\b(?:tip|delivery tip|gratuity|gorjeta|trinkgeld|pourboire|propina)\b/i },
  { kind: "discount", re: /\b(?:discount|promotions? applied|coupon|savings|promo|desconto|rabatt|remise|descuento|cashback)\b/i },
  { kind: "tax", re: /\b(?:tax(?:es)?|gst|cgst|sgst|igst|vat|sales tax|mwst|ust|iva|icms|tva)\b/i },
  { kind: "fee", re: /\b(?:fee|platform fee|service fee|booking fee|convenience fee|packaging charges?|surcharge|tolls?|taxa|gebühr|frais)\b/i },
];

/** Lines that carry metadata, never an item name. */
const META_LINE =
  /^(?:order|invoice|receipt|amount|price\b|charged|billed|date|placed|delivered to|deliver(?:y|ing)? to|ship(?:ping)? to|shipping address|address|payment|paid|sold by|seller|qty|quantity|arriving|track|hello|hi\b|dear|thank|view|manage|help|contact|call|from|to:|trip|pickup|drop|olá|hallo|bonjour)|@|https?:|www\./i;

/**
 * Payment-instrument lines are never items (and may carry masked numbers).
 * A bare "card" or "wallet" is not enough: "SanDisk 128GB Memory Card" and
 * "Leather Wallet" are products.
 */
const PAYMENT_LINE =
  /\b(?:visa|master ?card|amex|american express|rupay|discover|elo|maestro|diners|upi|paypal|net ?banking|apple pay|google pay|pix|boleto|cash on delivery|pay on delivery)\b|\b(?:credit|debit|prepaid) card\b|\bcard (?:ending|no\b|number)|\bending (?:in|with)\b|\b(?:paid|pay|payment) (?:by|with|via|using|method|mode|from)\b|\bcharged to\b|\b(?:wallet|gift card|store credit)\b[^\n]{0,24}\b(?:used|applied|balance|redeemed|amount)\b|\bcartão de (?:crédito|débito)\b|\b(?:kredit|debit|ec-)karte\b|••|\*{2,}|xx\d/i;

/** Below this line an email is footer/recommendations: stop collecting items. */
const STOP_ITEMS =
  /recommend|you (?:might|may) (?:also )?like|customers who bought|inspired by|related to items|deals for you|top picks|unsubscribe|privacy (?:notice|policy)|©|this email was sent|download the app|follow us|veja também|das könnte/i;

const UNIT_WORDS = "unidades?|units?|un\\.|stück|stk\\.?|pcs|pieces?|items?";
const QTY = new RegExp(
  `(?:\\bqty|\\bquantity|\\bquantidade|\\bmenge|\\banzahl|\\bqté)\\s*[:.]?\\s*(\\d{1,3})\\b|^(\\d{1,3})\\s*[x×]\\s+|\\s[x×]\\s?(\\d{1,3})\\b|^(\\d{1,3})\\s+(?=[A-Za-z])|\\b(\\d{1,3})\\s*(?:${UNIT_WORDS})\\b`,
  "i",
);

// ---------------------------------------------------------------------------
// Line items and their category hints (data)
// ---------------------------------------------------------------------------

/**
 * Item keyword -> BRAKE category. Health items are *sensitive* (research 06
 * "Sensitive line items"): their names are replaced by a category label by
 * default, keeping only the category signal.
 */
const ITEM_KEYWORDS: readonly { readonly re: RegExp; readonly category: string; readonly sensitive?: boolean }[] = [
  {
    re: /\b(?:medicine|syrup|paracetamol|ibuprofen|antibiotic|insulin|prescription|pharmacy|vitamins?|supplement|condoms?|pregnancy test|bandage)\b|\b\d+\s?mg\b|\b(?:tablets?|capsules?)\b(?=[^\n]*\b(?:strip|of \d+|\d+\s?mg)\b)/i,
    category: "health",
    sensitive: true,
  },
  { re: /\b(?:dog|cat|pet|puppy|kitten)s?\b.*\b(?:food|treats?|kibble|litter|toy|leash|collar)\b|\bpedigree\b|\bwhiskas\b|\bkibble\b|\bcat litter\b/i, category: "pets" },
  { re: /\b(?:toothbrush|toothpaste|shampoo|conditioner|soap|lotion|razor|deodorant|sunscreen|moisturi[sz]er|face ?wash|trimmer|perfume|cosmetic|lipstick)\b/i, category: "personal_care" },
  { re: /\b(?:usb|cable|charger|headphones?|earbuds|earphones|bluetooth|phone|smartphone|laptop|keyboard|mouse|hdmi|power ?bank|ssd|monitor|tablet pc|speaker|smartwatch|router|adapter|fone de ouvido|carregador|kopfhörer|ladekabel)\b/i, category: "shopping.electronics" },
  { re: /\b(?:t-?shirt|shirt|jeans|trousers|dress|shoes|sneakers|kurta|saree|jacket|hoodie|socks|sandals|skirt|leggings)\b/i, category: "shopping.clothing" },
  { re: /\b(?:detergent|cleaner|tissues?|toilet (?:paper|roll)|dish ?wash|mop|light ?bulb|batteries|garbage bags?|storage box)\b/i, category: "household" },
  { re: /\b(?:rice|atta|flour|milk|bread|eggs|vegetables?|fruits?|dal|cooking oil|sugar|butter|cheese|paneer|onions?|tomato(?:es)?|potato(?:es)?|banana)\b/i, category: "groceries" },
  { re: /\b(?:biryani|pizza|burger|whopper|dosa|idli|noodles|sandwich|thali|meal|combo|fries|shawarma|momos|curry|wrap)\b/i, category: "eating_out" },
  { re: /\b(?:book|novel|textbook|course|notebook)\b/i, category: "education" },
];

/** Build a privacy-safe line item: description and price only, health items reduced to a category. */
export function makeLineItem(input: {
  readonly description: string;
  readonly quantity?: number;
  readonly unitPrice?: Money;
  readonly total?: Money;
  readonly productId?: string;
}): LineItem | undefined {
  let description = normalizeWhitespace(redactSensitive(input.description.replace(/\s\|\s?/g, " ")).text)
    .replace(/^[•\-–*·\d.)\s]+(?=[A-Za-z])/, "")
    .replace(/[\s|:,-]+$/, "")
    .replace(/\s*[x×]\s?\d{1,3}$/i, "")
    .replace(/[\s|:,-]+$/, "")
    .slice(0, 120);
  if (!/[A-Za-zÀ-ÿऀ-ॿ]{2}/.test(description)) return undefined;
  const hints: CategoryHint[] = [];
  for (const k of ITEM_KEYWORDS) {
    const m = k.re.exec(description);
    if (!m) continue;
    hints.push({ scheme: "brake", value: k.category, confidence: 0.8 });
    if (k.sensitive) {
      description = "Health item";
    } else {
      hints.push({ scheme: "keyword", value: m[0].toLowerCase(), confidence: 0.8 });
    }
    break;
  }
  return {
    description,
    ...(input.quantity !== undefined && input.quantity > 0 ? { quantity: input.quantity } : {}),
    ...(input.unitPrice ? { unitPrice: input.unitPrice } : {}),
    ...(input.total ? { total: input.total } : {}),
    ...(hints.length > 0 ? { categoryHints: hints } : {}),
    ...(input.productId && !hints.some((h) => h.value === "health") ? { productId: input.productId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

/** The merchant behind the email: the sender brand (or a variant), or an unknown business sender's display name. */
export function senderMerchant(ctx: EmailContext, confidence: number): MerchantObservation | undefined {
  const s = ctx.sender;
  if (s && s.info.role !== "bank" && s.info.role !== "payment") {
    const v = senderVariant(s.info, ctx.subject);
    return {
      raw: v.displayName,
      name: v.displayName,
      key: v.key,
      website: s.domain,
      channel: "online",
      ...(s.info.mcc ? { mcc: s.info.mcc } : {}),
      confidence,
    };
  }
  if (!s && ctx.senderName) return { raw: ctx.senderName, name: ctx.senderName, channel: "online", confidence: Math.min(confidence, 0.7) };
  return undefined;
}

/** Namespace for merchant-issued references: the sender key, else the sending domain. */
export function referenceNamespace(ctx: EmailContext): string {
  return ctx.sender?.info.key ?? ctx.senderDomain;
}

export function senderCategoryHints(ctx: EmailContext): CategoryHint[] {
  const out: CategoryHint[] = [];
  const s = ctx.sender;
  if (!s) return out;
  const v = senderVariant(s.info, ctx.subject);
  if (v.category) out.push({ scheme: "brake", value: v.category, confidence: v.category === "shopping.online_marketplace" ? 0.55 : 0.8 });
  if (s.info.mcc) out.push({ scheme: "mcc", value: s.info.mcc, confidence: 0.85 });
  return out;
}

const ORDER_ID_PATTERNS: readonly { readonly re: RegExp; readonly type: ReferenceType }[] = [
  { re: /\b(\d{3}-\d{7}-\d{7})\b/, type: "order_id" }, // Amazon order id (research 06 §13b)
  { re: /\b(D\d{2}-\d{7}-\d{7})\b/, type: "order_id" }, // Amazon digital order
  { re: /\b(OD\d{12,21})\b/, type: "order_id" }, // Flipkart
  { re: /\b(GPA\.\d{4}-\d{4}-\d{4}-\d{5})\b/, type: "order_id" }, // Google Play
];

const LABELLED_ID =
  /\b(order|pedido|bestellung|bestellnummer|commande|invoice|fatura|rechnung|facture|receipt|recibo|booking|reservation|reserva|buchung|confirmation|itinerary|pnr|trip)\s*(?:id|no\.?|number|nr\.?|num(?:ber|ero|éro)?|#|nº|n°|code|reference|ref\.?)?\s*[:#.]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,29})\b/gi;

function idTypeForLabel(label: string): ReferenceType {
  const l = label.toLowerCase();
  if (/invoice|fatura|rechnung|facture/.test(l)) return "invoice_id";
  if (/receipt|recibo/.test(l)) return "receipt_id";
  if (/booking|reservation|reserva|buchung|confirmation|itinerary|pnr/.test(l)) return "booking_ref";
  return "order_id";
}

/** Merchant references in the text: known id shapes first, then "Order No: …"-style labels. */
export function findReferences(text: string, ctx: EmailContext, prefer?: ReferenceType): Reference[] {
  const namespace = referenceNamespace(ctx);
  for (const p of ORDER_ID_PATTERNS) {
    const m = p.re.exec(text);
    if (m?.[1]) return [{ type: p.type, value: m[1], namespace }];
  }
  LABELLED_ID.lastIndex = 0;
  const found: Reference[] = [];
  for (let m = LABELLED_ID.exec(text); m !== null; m = LABELLED_ID.exec(text)) {
    const value = m[2] ?? "";
    const type = idTypeForLabel(m[1] ?? "");
    const codeLike = type === "booking_ref" && /^[A-Z0-9]{5,8}$/.test(value) && /[A-Z]/.test(value) && value === value.toUpperCase();
    if (!/\d/.test(value) && !codeLike) continue;
    if (/^\d{1,3}$/.test(value) || /^(?:19|20)\d{2}$/.test(value)) continue;
    if (!found.some((r) => r.type === type)) found.push({ type, value, namespace });
  }
  if (prefer) found.sort((a, b) => Number(b.type === prefer) - Number(a.type === prefer));
  return found.slice(0, 2);
}

interface LabelledAmount {
  readonly money: Money;
  readonly rank: number;
  readonly line: string;
}

/**
 * The best total: highest-priority label, first occurrence; the value may sit
 * on the label's line or alone on the next one ("Order Total:" / "₹4,799.00").
 */
function findTotal(doc: Doc): LabelledAmount | undefined {
  let best: LabelledAmount | undefined;
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i]!;
    if (labelKind(line) !== "total") continue;
    const label = TOTAL_LABELS.find((l) => l.re.test(line));
    if (!label || (best && best.rank <= label.rank)) continue;
    const at = label.re.exec(line)?.index ?? 0;
    const same = amountsIn(line.slice(at), doc.ctx)[0];
    if (same) {
      best = { money: same.money, rank: label.rank, line };
      continue;
    }
    const next = doc.lines[i + 1];
    if (next !== undefined && isValueOnly(next, doc.ctx)) {
      best = { money: amountsIn(next, doc.ctx)[0]!.money, rank: label.rank, line: `${line} ${next}` };
    }
  }
  return best;
}

/**
 * The explicitly labelled total of an email's visible text ("Order Total",
 * "Total Fare", "Amount paid"; never a bare "Total"), for markup that names
 * the order or ticket but not its price.
 */
export function visibleTotal(text: string, ctx: EmailContext): { readonly money: Money; readonly line: string } | undefined {
  const total = findTotal(toDoc(text, ctx, "heuristic"));
  return total && total.rank <= 1 ? { money: total.money, line: total.line } : undefined;
}

/** True when a line holds just an amount (a label's value on the next row). */
function isValueOnly(line: string | undefined, ctx: EmailContext): boolean {
  if (!line) return false;
  const amts = amountsIn(line, ctx);
  if (amts.length !== 1) return false;
  const rest = line.replace(amts[0]!.raw, "").replace(/[\s:|-]/g, "");
  return rest.length <= 3;
}

/**
 * What a label line is. Specific totals ("Order Total", "Amount paid") win;
 * then components ("Item Total", "Delivery fee"); a bare "Total" comes last.
 * Parenthesised and "incl. tax" qualifiers are ignored so "Grand Total (incl.
 * GST)" is a total and "Delivery Fee (incl. GST)" is shipping, not tax.
 */
function labelKind(line: string): "total" | AmountComponentKind | undefined {
  const label = line
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:incl(?:uding|\.)?|inclusive of|inkl\.?|com)\s+(?:all\s+)?(?:taxes|tax|gst|vat|mwst|impostos)\b/gi, " ");
  for (const l of TOTAL_LABELS) if (l.rank <= 1 && l.re.test(label)) return "total";
  for (const c of COMPONENT_LABELS) if (c.re.test(label)) return c.kind;
  for (const l of TOTAL_LABELS) if (l.rank > 1 && l.re.test(label)) return "total";
  return undefined;
}

interface Breakdown {
  readonly components: AmountComponent[];
  readonly items: LineItem[];
}

/** Walks the body once, collecting price components and item lines until the footer starts. */
function scanItems(doc: Doc): Breakdown {
  const components: AmountComponent[] = [];
  const items: LineItem[] = [];
  let pending: { description: string; quantity?: number } | undefined;
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i]!;
    if (STOP_ITEMS.test(line)) break;
    const kind = labelKind(line);
    if (kind) {
      pending = undefined;
      let amt = amountsIn(line, doc.ctx)[0];
      if (!amt && isValueOnly(doc.lines[i + 1], doc.ctx)) {
        amt = amountsIn(doc.lines[i + 1]!, doc.ctx)[0];
        i += 1;
      }
      if (amt && kind !== "total" && !components.some((c) => c.kind === kind)) components.push({ kind, amount: amt.money });
      continue;
    }
    if (PAYMENT_LINE.test(line)) {
      pending = undefined;
      continue;
    }
    const amts = amountsIn(line, doc.ctx).filter((a) => !isBalanceAmount(line.slice(0, a.index)));
    const qty = qtyOf(line);
    if (amts.length === 0) {
      if (qty !== undefined && pending && /^\W*(?:qty|quantity|quantidade|menge|anzahl|qté)/i.test(line)) {
        pending = { ...pending, quantity: qty };
      } else if (!META_LINE.test(line) && line.length <= 100 && /[A-Za-zÀ-ÿ]{3}/.test(line)) {
        pending = { description: line.replace(/\t/g, " "), ...(qty !== undefined ? { quantity: qty } : {}) };
      } else {
        pending = undefined;
      }
      continue;
    }
    const last = amts[amts.length - 1]!;
    const descriptionPart = line
      .slice(0, amts[0]!.index)
      .split("\t")
      .filter((c) => /[A-Za-zÀ-ÿ]{2}/.test(c) && !QTY_ONLY.test(c))
      .join(" ");
    const priceOnly = descriptionPart.replace(/[^A-Za-zÀ-ÿ]/g, "").length < 3;
    let description: string | undefined;
    let quantity = qty;
    if (!priceOnly && !META_LINE.test(descriptionPart)) description = descriptionPart;
    else if (priceOnly && pending) {
      description = pending.description;
      quantity = quantity ?? pending.quantity;
    }
    pending = undefined;
    if (!description) continue;
    const unit = amts.length >= 2 && quantity !== undefined && quantity > 1 ? amts[0]!.money : undefined;
    const item = makeLineItem({
      description,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(unit ? { unitPrice: unit } : {}),
      total: last.money,
    });
    if (item && items.length < 50) items.push(item);
  }
  return { components, items };
}

const QTY_ONLY = new RegExp(`^\\s*(?:(?:qty|quantity|quantidade|menge|anzahl|qté)\\s*[:.]?\\s*\\d{1,3}|\\d{1,3}\\s*(?:${UNIT_WORDS}))\\s*$`, "i");

function qtyOf(line: string): number | undefined {
  const m = QTY.exec(line);
  if (!m) return undefined;
  const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : undefined;
}

/** True when item totals (plus shipping/tax/tip/fees, minus discounts) reproduce the total within 1%. */
function itemsReconcile(items: readonly LineItem[], components: readonly AmountComponent[], total: Money): boolean {
  const priced = items.filter((i) => i.total && i.total.currency === total.currency);
  if (priced.length === 0 || priced.length !== items.length) return false;
  let sum = priced.reduce((s, i) => s + i.total!.minor, 0);
  for (const c of components) {
    if (c.amount.currency !== total.currency) continue;
    if (c.kind === "discount") sum -= c.amount.minor;
    else if (c.kind !== "subtotal" && c.kind !== "original_currency" && c.kind !== "fx_fee") sum += c.amount.minor;
  }
  return Math.abs(sum - total.minor) <= Math.max(1, total.minor * 0.01);
}

// ---------------------------------------------------------------------------
// Payment method (data)
// ---------------------------------------------------------------------------

const PAYMENT_METHODS: readonly { readonly re: RegExp; readonly rail: PaymentRail; readonly instrument?: InstrumentType }[] = [
  { re: /\bupi\b|\bvpa\b/i, rail: { family: "account_to_account_instant", scheme: "upi" }, instrument: "upi_handle" },
  { re: /\bpix\b/i, rail: { family: "account_to_account_instant", scheme: "pix" } },
  { re: /\bimps\b/i, rail: { family: "account_to_account_instant", scheme: "imps" }, instrument: "bank_account" },
  { re: /\bneft\b/i, rail: { family: "account_to_account_batch", scheme: "neft" }, instrument: "bank_account" },
  { re: /\bzelle\b/i, rail: { family: "account_to_account_instant", scheme: "zelle" }, instrument: "bank_account" },
  { re: /\bach\b/i, rail: { family: "account_to_account_batch", scheme: "ach" }, instrument: "bank_account" },
  { re: /\bboleto\b/i, rail: { family: "other", scheme: "boleto" } },
  { re: /\b(?:cash on delivery|pay on delivery|cod)\b/i, rail: { family: "cash" }, instrument: "cash" },
  { re: /\bpaypal\b/i, rail: { family: "wallet", scheme: "paypal" }, instrument: "wallet" },
  { re: /\b(?:amazon pay balance|paytm wallet|zomato money|swiggy money|wallet|carteira)\b/i, rail: { family: "wallet" }, instrument: "wallet" },
  { re: /\b(?:net ?banking)\b/i, rail: { family: "account_to_account_batch", scheme: "netbanking" }, instrument: "bank_account" },
  { re: /\b(?:sepa|lastschrift)\b/i, rail: { family: "direct_debit", scheme: "sepa_dd" }, instrument: "bank_account" },
  { re: /\b(?:visa|master ?card|amex|american express|rupay|discover|elo|maestro|diners)\b|\b(?:credit|debit) card\b|\bcard (?:ending|no|number)\b|\bcartão\b|\bkarte\b/i, rail: { family: "card" }, instrument: "card" },
];

/**
 * The payment method mentioned first in the text, not the first one in the
 * table: a card alert's "credit card transaction" must win over a footer that
 * advertises "Send money with Zelle".
 */
function firstMentionedMethod(text: string): (typeof PAYMENT_METHODS)[number] | undefined {
  let best: { method: (typeof PAYMENT_METHODS)[number]; at: number } | undefined;
  for (const method of PAYMENT_METHODS) {
    const at = method.re.exec(text)?.index;
    if (at !== undefined && (best === undefined || at < best.at)) best = { method, at };
  }
  return best?.method;
}

const CARD_NETWORKS: readonly [RegExp, string][] = [
  [/\bvisa\b/i, "visa"],
  [/\bmaster ?card\b/i, "mastercard"],
  [/\b(?:amex|american express)\b/i, "amex"],
  [/\brupay\b/i, "rupay"],
  [/\bdiscover\b/i, "discover"],
  [/\belo\b/i, "elo"],
  [/\bmaestro\b/i, "maestro"],
  [/\bdiners\b/i, "diners"],
];

const PAYMENT_CONTEXT = /paid (?:via|with|using|by)|payment (?:method|mode|via)|pay(?:ment)?s?\s*:|charged to|forma de pagamento|pagamento\s*:|pago com|zahlungsart|bezahlt mit|mode de paiement|ending (?:in|with)|••|\*{2,}|\bxx\d|\(\.{2,3}\d{4}\)/i;

/** Last 4 of a masked card/account in a line; covers formats the shared helper does not ("account 9212", "(...4321)"). */
export function maskedLast4(raw: string): string | undefined {
  // Redact first: a full card number must never yield its *first* four digits ("card 4111 1111 …").
  // Payment handles (a phone-number UPI VPA) are not the user's instrument, so they are removed.
  const line = redactSensitive(raw).text.replace(/\S+@\S+/g, " ");
  return (
    /\b(?:account|acct|a\/c|card)\s*(?:no\.?|number|ending(?:\s+in)?)?\s*[:#]?\s*(?:[xX*•.]+\s?)?(\d{4})(?!\d)/i.exec(line)?.[1] ??
    lastFour(line) ??
    /\(\s*(?:\.{2,3}|…)\s*(\d{4})\s*\)/.exec(line)?.[1]
  );
}

export interface PaymentInfo {
  readonly rail?: PaymentRail;
  readonly instrument?: InstrumentObservation;
}

/** Payment rail and masked instrument from a "Paid via …" / "Visa ••••4242" line. */
export function findPayment(lines: readonly string[], issuer?: string): PaymentInfo {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!PAYMENT_CONTEXT.test(line)) continue;
    const scope = `${line} ${PAYMENT_METHODS.some((p) => p.re.test(line)) ? "" : lines[i + 1] ?? ""}`;
    const method = PAYMENT_METHODS.find((p) => p.re.test(scope));
    if (!method) continue;
    return paymentFrom(scope, method, issuer);
  }
  return {};
}

function paymentFrom(scope: string, method: (typeof PAYMENT_METHODS)[number], issuer?: string): PaymentInfo {
  const network = CARD_NETWORKS.find(([re]) => re.test(scope))?.[1];
  const rail: PaymentRail = method.rail.family === "card" && network ? { family: "card", scheme: network } : method.rail;
  const last4 = maskedLast4(scope);
  const cardKind = /\bcredit\b/i.test(scope) ? "credit" : /\bdebit card\b/i.test(scope) ? "debit" : undefined;
  const type = method.instrument;
  const instrument: InstrumentObservation | undefined = type
    ? {
        type,
        ...(issuer ? { issuer } : {}),
        ...(type === "card" && network ? { network } : {}),
        ...(last4 && (type === "card" || type === "bank_account") ? { last4 } : {}),
        ...(type === "card" && cardKind ? { cardKind } : {}),
      }
    : undefined;
  return { rail, ...(instrument ? { instrument } : {}) };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

interface FoundDate {
  readonly at: EpochMillis;
  readonly precision: "datetime" | "date";
  readonly approximate?: boolean;
}

/**
 * First date in a window of text. Uses the shared parser; dates written
 * without a year ("renews on Oct 5") get the email's year, rolled forward if
 * that would put a *future* notice in the past; relative words ("tomorrow",
 * "in 3 days") are resolved against the email's date.
 */
export function dateIn(window: string, ctx: EmailContext): FoundDate | undefined {
  const zone = statedZone(window);
  const timeZone = zone?.timeZone ?? ctx.timeZone;
  const opts = { ...(ctx.country ? { country: ctx.country } : {}), ...(timeZone ? { timeZone } : {}) };
  const parsed = parseDateTime(window, opts);
  if (parsed) return zone?.offsetMs !== undefined && parsed.precision === "datetime" ? { ...parsed, at: parsed.at - zone.offsetMs } : parsed;
  const base = ctx.emailDate;
  if (base > 0) {
    // Every "Oct 5" / "5 October" candidate is tried: "Premium plan (4 screens) renews on Oct 15" must not stop at "4 screens".
    const noYear = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\b/g;
    const year = new Date(base).getUTCFullYear();
    let tries = 0;
    for (let m = noYear.exec(window); m !== null && tries < 8; m = noYear.exec(window)) {
      const month = (m[1] ?? m[4] ?? "").toLowerCase();
      if (!MONTH_NAME.test(month)) continue;
      tries += 1;
      for (const y of [year, year + 1]) {
        const p = parseDateTime(m[1] ? `${m[1]} ${m[2]}, ${y}` : `${m[3]} ${m[4]} ${y}`, opts);
        if (p && p.at >= base - 2 * DAY) return p;
      }
    }
    if (/\btomorrow\b|\bamanhã\b|\bmorgen\b|\bdemain\b/i.test(window)) return { at: base + DAY, precision: "date", approximate: true };
    if (/\btoday\b|\bhoje\b|\bheute\b|\baujourd'hui\b/i.test(window)) return { at: base, precision: "date", approximate: true };
    const inDays = /\bin (\d{1,2}) days?\b|\bem (\d{1,2}) dias\b|\bin (\d{1,2}) tagen\b/i.exec(window);
    if (inDays) return { at: base + Number(inDays[1] ?? inDays[2] ?? inDays[3]) * DAY, precision: "date", approximate: true };
  }
  return undefined;
}

/**
 * Zone abbreviations senders print after a time ("8:15 AM ET", "10:41 IST",
 * "10:41:12 AM GMT+5:30"). Data, not branches; an explicit zone beats both the
 * sender's market and the user's zone.
 */
const ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York",
  CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver",
  PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  IST: "Asia/Kolkata", BST: "Europe/London", CET: "Europe/Berlin", CEST: "Europe/Berlin", MEZ: "Europe/Berlin", MESZ: "Europe/Berlin",
  BRT: "America/Sao_Paulo", GMT: "UTC", UTC: "UTC",
};
const ZONE_AFTER_TIME =
  /\b\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\s*\(?(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|IST|BST|CET|CEST|MEZ|MESZ|BRT|GMT|UTC)\b(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?/;

/** The zone a time in `text` is stated in: an IANA zone, plus a fixed offset for "GMT+5:30". */
function statedZone(text: string): { readonly timeZone: string; readonly offsetMs?: number } | undefined {
  const m = ZONE_AFTER_TIME.exec(text);
  const timeZone = m?.[1] ? ZONE_ABBREVIATIONS[m[1]] : undefined;
  if (!m || !timeZone) return undefined;
  if (!m[2] || timeZone !== "UTC") return { timeZone };
  const offsetMs = (Number(m[3]) * 60 + Number(m[4] ?? 0)) * 60_000 * (m[2] === "-" ? -1 : 1);
  return Math.abs(offsetMs) <= 14 * 3_600_000 ? { timeZone, offsetMs } : { timeZone };
}

const MONTH_NAME = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/;

function emailOccurredAt(ctx: EmailContext, confidence: number): Measured<EpochMillis> | undefined {
  return ctx.emailDate > 0 ? measured(ctx.emailDate, confidence) : undefined;
}

/** Text from `index` to ~`span` characters later, never crossing more than two line breaks. */
function windowFrom(text: string, index: number, span = 220): string {
  const slice = text.slice(index, index + span);
  const parts = slice.split("\n");
  return parts.slice(0, 3).join("\n");
}

/** The line containing `index`. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// Bank / payment alerts
// ---------------------------------------------------------------------------

const BANK_ALERT = /(?:has been|was|is) (?:debited|credited|withdrawn)|\b(?:debited|credited) (?:from|to|with|by)\b|you made a .{0,30}\btransaction\b|transaction alert|card ending (?:in )?\d{4}.{0,40}\b(?:used|charged)/i;
const DEBIT_WORDS = /\b(?:debited|spent|charged|withdrawn|sent|paid|purchase|deducted|made a|transaction (?:of|with|at)|debitado|abgebucht)\b/i;
const CREDIT_WORDS = /\b(?:credited|received|deposited|refunded|reversed|cashback|added to|creditado|recebido|gutgeschrieben)\b/i;
const PRE_DEBIT = /\bwill be (?:debited|charged|deducted)\b|\bpre-?debit\b|\bupcoming (?:debit|payment|charge)\b|\bis scheduled (?:for|on)\b/i;
/** A 12-digit retrieval reference (UPI/IMPS RRN) after its label. */
const RAIL_REF = /(?:\bupi\b|\bimps\b|\brrn\b|\butr\b)[^\d\n]{0,45}?(\d{12})(?!\d)/i;
const MANDATE_REF = /\b(?:e-?mandate|mandate|umrn|si)\s*(?:ref(?:erence)?|id|no\.?|number)?\s*(?:is|:|#)?\s*([A-Z0-9][A-Z0-9-]{5,39})\b/i;

/** A UPI handle whose local part is a phone number belongs to a person. */
function isPersonalHandle(vpa: string): boolean {
  return /^\+?\d{8,}$/.test(vpa.split("@")[0] ?? "");
}

function maskHandle(vpa: string): string {
  const [local = "", psp = ""] = vpa.split("@");
  return `${maskTail(local)}@${psp}`;
}

interface Payee {
  readonly merchant?: MerchantObservation;
  readonly counterparty?: { readonly handle?: string; readonly isMerchant?: number; readonly isSelf?: number };
}

/**
 * Account-to-account transfer wording. The other side of such a movement is a
 * person as often as a business, and the alert names them ("debited … to JOHN
 * DOE via IMPS", "credited … by NEFT transfer from PRIYA SHARMA", PayPal "You
 * sent $25.00 USD to Jane Smith"). Person names must not be stored
 * (research 11 PR-22), so such a payee is kept only as an unnamed counterparty.
 */
const TRANSFER_CONTEXT =
  /\b(?:imps|neft|rtgs|ach|zelle|wire transfer|faster payments?|bank transfer|fund transfer|transferred|transfer (?:to|from)|beneficiary|received from|you sent|money sent|(?:paid|sent) you)\b|\bsent\b[\s\S]{0,60}?\bto\b/i;

/**
 * "<person> paid you $25.00" (Venmo), "<person> sent you $25.00 USD" (PayPal,
 * Cash App): the movement verb is a debit word, but the money comes *to* the
 * user. Matched against the text just before the amount.
 */
const TO_YOU_BEFORE_AMOUNT = /\b(?:paid|sent|transferred|gave) you\s*$/i;

/**
 * Payee of an alert. People's names and phone-number handles are never kept
 * (only a masked handle). Transfer wording is looked for in the movement line
 * only: bank footers advertise "send money with Zelle" under card alerts.
 */
function findPayee(text: string, p2pSender: boolean, movementLine: string): Payee {
  const vpa = /\bVPA\s+([\w.-]+@[\w.-]+)(?:\s+([A-Za-z][A-Za-z .&'-]{1,40}?))?(?=\s+on\b|[.,\n]|$)/i.exec(text);
  if (vpa?.[1]) {
    const handle = vpa[1].toLowerCase();
    if (p2pSender || isPersonalHandle(handle)) return { counterparty: { handle: maskHandle(handle), isMerchant: 0.2 } };
    const raw = (vpa[2] ?? "").trim() || handle;
    return { merchant: { raw, handle, channel: "unknown", confidence: 0.75 } };
  }
  // P2P apps (Venmo, Cash App, PicPay) name a person on the movement line ("You paid Jane Smith $25.00"):
  // the other side is kept as an unnamed counterparty so neither a name nor an excerpt of that line survives.
  if (p2pSender || TRANSFER_CONTEXT.test(movementLine)) return { counterparty: { isMerchant: 0.3 } };
  const labelled = /\b(?:merchant(?: name)?|payee|estabelecimento|händler)(?:\s*[:\-]\s*|\t)([^\n\t]{2,60})/i.exec(text);
  // Prepositions and the words that end a payee are matched in either case ("At AMAZON On …", HDFC card
  // alerts); the payee itself must still start with a capital or digit, which keeps "to be", "at least" out.
  const loose = /\b(?:[Aa]t|[Ww]ith|[Tt]o|[Tt]owards|[Ee]m|[Bb]ei)\s+([A-Z0-9][A-Za-z0-9&'.*\- ]{1,40}?)(?=\s+(?:[Oo]n|[Uu]sing|[Vv]ia|[Ff]rom|[Ww]ith|[Aa]t|[Rr]ef|[Cc]ard|[Ff]or|[Ii]s)\b|[.,\n\t]|$)/.exec(text);
  const found = (labelled?.[1] ?? loose?.[1])?.trim();
  const raw = found ? redactSensitive(found).text : undefined;
  if (!raw || /^(?:your|the|a|an|account|card|bank|you)\b/i.test(raw) || /^\d+$/.test(raw)) return {};
  return { merchant: { raw, channel: "unknown", confidence: labelled ? 0.85 : 0.7 } };
}

/**
 * Purposes an alert line states outright (the brief's transfer-vs-spending
 * problem): paying a credit-card bill from a bank account, a payment landing
 * on a card, an ATM withdrawal, a move between the user's own accounts. None
 * of these is a purchase, whatever payee wording follows.
 */
const CARD_BILL_DEBIT =
  /\b(?:towards|to|for)\s+(?:the\s+|your\s+)?(?:[\w&.]+\s+){0,4}credit card(?:\s+(?:no\.?\s*)?[xX*•]*\d{4})?\s+(?:bill|dues?|payment|outstanding)\b|\bcredit card (?:bill|dues|outstanding)\b/i;
const CARD_PAYMENT_CREDIT =
  /\bpayment\b[^\n]{0,80}\b(?:credited|received|posted)\b[^\n]{0,20}\b(?:to|towards|on|for)\s+(?:your\s+)?(?:[\w&.]+\s+){0,4}credit card\b/i;
const CASH_WITHDRAWAL = /\batm\b|\bcash withdrawal\b|\bwithdrawn\b|\bsaque\b|\bgeldautomat\b/i;
const OWN_ACCOUNT = /\b(?:your own|own) (?:account|a\/c)\b|\bself[- ]?transfer\b|\bbetween your (?:own )?accounts\b/i;

type AlertPurpose = "card_bill" | "cash" | "own_account";

function alertPurpose(line: string, direction: Direction): AlertPurpose | undefined {
  if (direction === "credit") return CARD_PAYMENT_CREDIT.test(line) && !/refund|reversal|reversed/i.test(line) ? "card_bill" : undefined;
  if (CARD_BILL_DEBIT.test(line)) return "card_bill";
  if (CASH_WITHDRAWAL.test(line)) return "cash";
  if (OWN_ACCOUNT.test(line)) return "own_account";
  return undefined;
}

const PURPOSE_HINT: Readonly<Record<AlertPurpose, TypeHint>> = {
  card_bill: { type: "credit_card_payment", confidence: 0.85, reason: "email:alert-card-bill" },
  cash: { type: "cash_withdrawal", confidence: 0.85, reason: "email:alert-cash-withdrawal" },
  own_account: { type: "transfer", transferKind: "own_account", confidence: 0.75, reason: "email:alert-own-account" },
};

/** Clock difference tolerated between a bank's stated transaction time and the email's arrival. */
const ALERT_CLOCK_SKEW = 15 * 60_000;

function alertFinding(doc: Doc): EmailFinding | undefined {
  const { ctx } = doc;
  const issuer = ctx.sender?.info.displayName ?? ctx.senderName;
  const p2p = ctx.sender?.info.p2p === true;
  const known = ctx.sender !== undefined;

  if (PRE_DEBIT.test(doc.all)) {
    const pre = predebitFinding(doc, issuer);
    if (pre) return pre;
  }

  // The first line that names a movement and carries a non-balance amount.
  let line: string | undefined;
  let amount: ExtractedAmount | undefined;
  // Lines are guarded like `amountsIn` guards them, so amount indices line up with the text before them.
  for (const l of [guardQuantities(ctx.subject), ...doc.lines]) {
    if (!DEBIT_WORDS.test(l) && !CREDIT_WORDS.test(l)) continue;
    const a = amountsIn(l, ctx).find((x) => !isBalanceAmount(l.slice(0, x.index)));
    if (a) {
      line = l;
      amount = a;
      break;
    }
  }
  if (!line || !amount) return undefined;

  const d = DEBIT_WORDS.exec(line)?.index ?? Infinity;
  const c = CREDIT_WORDS.exec(line)?.index ?? Infinity;
  const toYou = TO_YOU_BEFORE_AMOUNT.test(line.slice(Math.max(0, amount.index - 40), amount.index));
  const direction: Direction = toYou || c < d ? "credit" : "debit";
  const purpose = alertPurpose(line, direction);
  // Paying a card bill names the card, but the money leaves a bank account.
  const paysCardBill = purpose === "card_bill" && direction === "debit";
  const context = `${line}\n${doc.flat}`;
  const payment = paysCardBill
    ? PAYMENT_METHODS.find((p) => p.rail.family !== "card" && p.re.test(line!))
    : PAYMENT_METHODS.find((p) => p.re.test(line!)) ?? firstMentionedMethod(doc.flat);
  const isCard = !paysCardBill && (/\bcard\b/i.test(line) || payment?.rail.family === "card");
  const network = CARD_NETWORKS.find(([re]) => re.test(context))?.[1];
  const last4 = paysCardBill
    ? maskedLast4(line.replace(/\bcredit card\b[^\n]{0,24}?\d{4}/gi, " "))
    : maskedLast4(line) ?? maskedLast4(doc.flat);
  // A payment app or gateway (PhonePe, Razorpay) moves money over a real rail; its own
  // stored-value wallet is assumed only when the email names no other method.
  const namedRail = payment && payment.rail.family !== "wallet" && payment.rail.family !== "cash" ? payment : undefined;
  const instrumentType: InstrumentType = isCard
    ? "card"
    : ctx.sender?.info.role === "payment"
      ? namedRail?.instrument ?? "wallet"
      : "bank_account";
  const cardKind = /\bcredit card\b/i.test(context) ? "credit" : /\bdebit card\b/i.test(context) ? "debit" : undefined;
  const instrument: InstrumentObservation = {
    type: instrumentType,
    ...(issuer ? { issuer } : {}),
    ...(isCard && network ? { network } : {}),
    ...(last4 && instrumentType !== "wallet" ? { last4 } : {}),
    ...(isCard && cardKind ? { cardKind } : {}),
  };
  const rail: PaymentRail | undefined = isCard
    ? { family: "card", ...(network ? { scheme: network } : {}) }
    : ctx.sender?.info.role === "payment"
      ? namedRail?.rail ?? { family: "wallet", scheme: ctx.sender.info.key }
      : payment?.rail;

  const payee: Payee =
    purpose === "own_account" ? { counterparty: { isSelf: 0.85 } } : purpose ? {} : findPayee(`${line}\n${doc.flat}`, p2p, line);
  const references: Reference[] = [];
  // Rail references compare within the account-to-account rail that issued them ("upi", "imps"), as the
  // SMS/notification packs and account-aggregator ledgers key them. A card RRN has no such namespace.
  const refNamespace = rail && (rail.family === "account_to_account_instant" || rail.family === "account_to_account_batch") ? rail.scheme : undefined;
  const rrn = refNamespace ? RAIL_REF.exec(doc.flat) : null;
  if (rrn?.[1] && refNamespace) references.push({ type: "rail_reference", value: rrn[1], namespace: refNamespace });

  const when = dateIn(line, ctx) ?? dateIn(doc.flat, ctx);
  let occurredAt: Measured<EpochMillis> | undefined;
  // An alert cannot report a transaction from after it was sent: a stated time later than the email
  // was read in the wrong zone, so the email's own time is the better estimate.
  const statedAfterEmail =
    when !== undefined && ctx.emailDate > 0 && when.at > ctx.emailDate + (when.precision === "datetime" ? ALERT_CLOCK_SKEW : DAY);
  if (statedAfterEmail) occurredAt = measured(ctx.emailDate, 0.75);
  else if (when?.precision === "datetime") occurredAt = measured(when.at, 0.9);
  else if (when && ctx.emailDate > 0 && Math.abs(when.at - ctx.emailDate) < DAY) occurredAt = measured(ctx.emailDate, 0.85);
  else if (when) occurredAt = measured(when.at, 0.6);
  else occurredAt = emailOccurredAt(ctx, 0.8);

  const typeHints: TypeHint[] = [];
  const personal = payee.counterparty !== undefined && (payee.counterparty.isMerchant ?? 1) <= 0.2;
  if (purpose) typeHints.push(PURPOSE_HINT[purpose]);
  else if (direction === "credit" && /refund|reversal|reversed|estorno/i.test(context)) typeHints.push({ type: "refund", confidence: 0.8, reason: "email:alert-refund-keyword" });
  else if (direction === "debit" && personal) typeHints.push({ type: "transfer", transferKind: "p2p_other", confidence: 0.5, reason: "email:alert-personal-payee" });
  // A named account-to-account transfer may still be rent or a bill: lean transfer, but only weakly.
  else if (direction === "debit" && payee.counterparty) typeHints.push({ type: "transfer", transferKind: "unknown", confidence: 0.4, reason: "email:alert-account-transfer" });
  else if (direction === "debit" && payee.merchant) typeHints.push({ type: "purchase", confidence: 0.6, reason: "email:alert-merchant-payee" });

  const base = known ? 0.95 : 0.7;
  return {
    kind: "money_movement",
    window: "post_spend",
    stage: "confirmed",
    direction,
    ...(occurredAt ? { occurredAt } : {}),
    amount: measured(amount.money, known ? 0.97 : 0.8),
    ...(payee.merchant ? { merchant: payee.merchant } : {}),
    ...(payee.counterparty ? { counterparty: payee.counterparty } : {}),
    instrument,
    ...(rail ? { rail } : {}),
    references,
    ...(typeHints.length > 0 ? { typeHints } : {}),
    confidence: base,
    method: known ? "template" : doc.method,
    label: "transaction alert",
    key: rrn?.[1] ? `alert:${rrn[1]}` : `alert:${direction}:${amount.money.minor}`,
    matchedLine: line,
  };
}

/** e-mandate / auto-debit pre-notification (India requires one >= 24h before each recurring debit; research 06 §13d). */
function predebitFinding(doc: Doc, issuer: string | undefined): EmailFinding | undefined {
  const { ctx } = doc;
  const m = PRE_DEBIT.exec(doc.all);
  if (!m) return undefined;
  const at = m.index;
  const window = windowFrom(doc.all, Math.max(0, at - 120), 360);
  const amount = amountsIn(window, ctx)[0];
  if (!amount) return undefined;
  const when = dateIn(doc.all.slice(at, at + 200), ctx) ?? dateIn(window, ctx);
  const found =
    /\b(?:merchant(?: name)?|towards|for|by)\s*[:\-]?\s*([A-Z][A-Za-z0-9&'.* -]{1,40}?)(?=\s+(?:on|of|for|via|will|is|using)\b|[.,\n\t]|$)/.exec(window)?.[1]?.trim();
  const merchantRaw = found ? redactSensitive(found).text : undefined;
  const mandate = MANDATE_REF.exec(doc.flat)?.[1];
  const references: Reference[] = mandate && /\d/.test(mandate) ? [{ type: "mandate_id", value: mandate, namespace: ctx.sender?.info.key ?? ctx.senderDomain }] : [];
  const subscription: SubscriptionDetails = {
    event: "renewal_upcoming",
    ...(merchantRaw ? { serviceName: merchantRaw } : {}),
    ...(when ? { nextChargeAt: when.at } : {}),
    price: amount.money,
  };
  return {
    kind: "subscription_event",
    window: "pre_spend",
    stage: "intent",
    direction: "debit",
    ...(merchantRaw ? { merchant: { raw: merchantRaw, channel: "unknown", confidence: 0.7 } } : {}),
    ...(issuer ? { instrument: { type: /\bcard\b/i.test(window) ? "card" : "bank_account", issuer, ...(maskedLast4(window) ? { last4: maskedLast4(window)! } : {}) } } : {}),
    references,
    subscription,
    typeHints: [{ type: "subscription", confidence: 0.8, reason: "email:pre-debit-notice" }],
    confidence: ctx.sender ? 0.9 : 0.65,
    method: ctx.sender ? "template" : doc.method,
    label: "upcoming debit notice",
    key: `predebit:${when?.at ?? "?"}:${amount.money.minor}`,
    matchedLine: lineAt(doc.all, at),
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

const REFUND =
  /\brefund (?:of|for)\b|\brefund (?:has been|was|is being|is|will be) (?:initiated|processed|issued|credited|completed|approved|sent)|\b(?:we'?ve|we have) (?:issued|processed|initiated|sent) (?:a |your )?refund|\byour refund\b|\brefund (?:initiated|processed|confirmation|issued|completed|request)|\bhas been refunded\b|\breembolso\b|\bestorno\b|\b(?:rück)?erstattung\b|\bremboursement\b/i;
const REFUND_PENDING = /\b(?:initiated|being processed|requested|will be (?:credited|processed|refunded)|on its way|em processamento|eingeleitet|en cours)\b/i;
/** Any refund word, for picking the line that carries the refunded amount ("Refund total: ₹598"). */
const REFUND_WORD = /refund|reembolso|estorno|erstattung|rembours/i;
const REFUND_SUBJECT = /\brefund|\breembols|\bestorn|\berstattung|\brembours/i;
/**
 * Refund wording that is policy or a condition, not a refund that happened:
 * order confirmations routinely carry "If you cancel, the refund for prepaid
 * orders will be processed in 5–7 days" or "your refund is issued to the
 * original payment method".
 */
const REFUND_POLICY =
  /\b(?:if|in case|eligible|eligibility|policy|policies|learn (?:more|how)|how to|you can|can be|may be|easy returns?|returns? (?:are|is) easy|se você|falls|si vous)\b/i;

/** Labels that name the refunded sum itself ("Refund amount: ₹598", "Refund total", "Amount refunded"). */
const REFUND_AMOUNT_LABEL =
  /\brefund(?:ed)? (?:amount|total|value|of)\b|\bamount refunded\b|\btotal refund\b|\brefund\s*[:\-]|\bvalor (?:do )?reembolso\b|\berstattungsbetrag\b|\bmontant rembours/i;
/** Cues that the next amount is the order's value, not the refund ("(order value ₹4,799)"). */
const NOT_REFUND_AMOUNT =
  /\b(?:order (?:value|total|amount)|item (?:price|total)|original (?:amount|price|total)|paid amount|valor do pedido|bestellwert)\s*(?:of|was|:|-)?\s*$/i;

/** The refunded amount on a line: the first amount that is not introduced as the order's value. */
function refundAmountIn(line: string, ctx: EmailContext): ExtractedAmount | undefined {
  return amountsIn(line, ctx).find((a) => !NOT_REFUND_AMOUNT.test(guardQuantities(line).slice(Math.max(0, a.index - 32), a.index)));
}

function refundFinding(doc: Doc): EmailFinding | undefined {
  const { ctx } = doc;
  const subjectHit = REFUND_SUBJECT.test(ctx.subject) && !REFUND_POLICY.test(ctx.subject);
  const stated = doc.lines.find((l) => REFUND.test(l) && !REFUND_POLICY.test(l));
  // The line carrying the refunded amount; never a policy line. A line that labels the refunded
  // sum wins over an earlier sentence that only quotes the order's value.
  const candidates = doc.lines.filter((l) => REFUND_WORD.test(l) && !REFUND_POLICY.test(l) && refundAmountIn(l, ctx) !== undefined);
  const refundLine = candidates.find((l) => REFUND_AMOUNT_LABEL.test(l)) ?? candidates[0];
  // A refund must be what the email is about: named in the subject, or stated in the body with
  // its amount. A receipt's returns-policy footer is neither, and must not flip a purchase to a credit.
  if (!subjectHit && !(stated && refundLine)) return undefined;
  const m = REFUND.exec(doc.all) ?? REFUND_SUBJECT.exec(doc.all);
  if (!m) return undefined;
  const amount = (refundLine ? refundAmountIn(refundLine, ctx) : undefined) ?? refundAmountIn(windowFrom(doc.all, m.index), ctx);
  const references = findReferences(doc.all, ctx, "order_id").filter((r) => r.type === "order_id" || r.type === "booking_ref");
  if (!amount && references.length === 0) return undefined;
  const pending = REFUND_PENDING.test(refundLine ?? windowFrom(doc.all, m.index));
  const known = ctx.sender?.addressKnown === true;
  const destination = /\b(?:amazon pay balance|wallet|gift card|store credit|saldo|guthaben)\b/i.test(doc.flat)
    ? ({ rail: { family: "wallet" } } satisfies PaymentInfo)
    : findPayment(doc.lines);
  return {
    kind: "refund_notice",
    window: "post_spend",
    stage: pending ? "pending" : "confirmed",
    direction: "credit",
    ...(emailOccurredAt(ctx, 0.6) ? { occurredAt: emailOccurredAt(ctx, 0.6)! } : {}),
    ...(amount ? { amount: measured(amount.money, known ? 0.93 : 0.75) } : {}),
    ...(senderMerchant(ctx, known ? 0.95 : 0.7) ? { merchant: senderMerchant(ctx, known ? 0.95 : 0.7)! } : {}),
    ...(destination.rail ? { rail: destination.rail } : {}),
    ...(destination.instrument ? { instrument: destination.instrument } : {}),
    references,
    typeHints: [{ type: "refund", confidence: 0.95, reason: "email:refund-notice" }],
    confidence: known ? 0.9 : 0.72,
    method: known ? "template" : doc.method,
    label: "refund",
    key: `refund:${references[0]?.value ?? ""}:${amount?.money.minor ?? ""}`,
    matchedLine: refundLine ?? lineAt(doc.all, m.index),
    detail: pending ? "initiated" : "processed",
  };
}

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

const SUBSCRIPTION_WORDS = /\b(?:subscription|membership|plan|trial|premium|renew(?:al|s)?|auto-?renew|assinatura|abonnement|abo|mitgliedschaft)\b/i;
const PAYMENT_FAILED =
  /\bpayment (?:failed|declined|was declined|was unsuccessful|didn'?t go through|issue|problem)|\bcouldn'?t (?:process|charge|complete) (?:your )?payment|\bunable to (?:process|charge)|\bupdate your payment (?:method|details|information)|\bproblem with your payment|\bpagamento (?:recusado|não aprovado)|\bzahlung (?:fehlgeschlagen|abgelehnt)/i;
const CANCELLED =
  /\b(?:subscription|membership|plan|trial)\b[^.\n]{0,40}\b(?:has been|was|is now|been) cancel+ed|\b(?:we'?ve|you'?ve|you have|we have) cancel+ed your (?:subscription|membership|plan)|\bcancel+ation (?:confirmed|confirmation|is complete)|\bassinatura (?:foi )?cancelada|\b(?:abo|abonnement|mitgliedschaft) (?:wurde )?gekündigt/i;
const TRIAL_ENDING =
  /\b(?:free )?trial(?: period)? (?:will end|ends?|ending|expires?|is ending)\b|\bseu (?:período de )?teste (?:grátis )?termina|\bprobe(?:zeitraum|abo|monat) endet/i;
const PRICE_CHANGE =
  /\bprice (?:is |will be )?(?:changing|increasing|going up)|\bprice (?:change|increase|update)|\bnew price\b|\bupdating (?:our|your) (?:prices?|plan pricing)|\bpreço (?:vai mudar|será atualizado)|\bpreisänderung|\bpreiserhöhung/i;
const RENEWAL =
  /\b(?:will|is set to|is scheduled to|is going to) (?:automatically |auto-?)?renew|\brenews? (?:on|in|tomorrow|automatically)\b|\brenews?:?\s+(?=\d{1,2}\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)|\bauto-?renew(?:al)? (?:on|date)|\bnext (?:billing|payment|charge|renewal) (?:date )?(?:is|on|will be)?|\bwill be (?:charged|billed) on|\brenewal (?:date|reminder|notice)|\bserá renovad[ao]|\bverlängert sich/i;
const SIGNUP =
  /\bwelcome to\b|\bthanks? (?:you )?for (?:subscribing|signing up|joining)|\byour (?:subscription|membership|trial) (?:has )?(?:started|begun|is (?:now )?active|is confirmed|has been activated)|\bsubscription confirm(?:ed|ation)|\byou'?re (?:now )?subscribed/i;
const RECEIPT_WORDS =
  /\breceipt\b|\bpayment (?:received|successful|confirmation)|\bthanks for your payment|\binvoice\b|\byou(?:'ve| have) been (?:charged|billed)|\brecibo\b|\brechnung\b|\bzahlungsbestätigung\b|\bfatura\b/i;

const PERIODS: readonly [RegExp, string][] = [
  [/(?:\/|\bper |\ba |\beach |\bevery )\s?(?:month|mo)\b|\bmonthly\b|\/mês|\bpor mês|\bpro monat|\bmonatlich|\bpar mois|\bmensual/i, "P1M"],
  [/(?:\/|\bper |\ba |\beach |\bevery )\s?(?:year|yr|annum)\b|\b(?:yearly|annual(?:ly)?)\b|\/ano|\bpor ano|\bjährlich|\bpar an/i, "P1Y"],
  [/(?:\/|\bper |\ba |\beach |\bevery )\s?(?:week|wk)\b|\bweekly\b|\bsemanal|\bwöchentlich/i, "P1W"],
];

function periodIn(text: string): string | undefined {
  return PERIODS.find(([re]) => re.test(text))?.[1];
}

function planIn(text: string, service?: string): string | undefined {
  const m =
    /\b[Pp]lan[ \t]*[:\-][ \t]*([A-Z][\w+]*(?: [A-Z0-9][\w+]*){0,3})/.exec(text) ??
    /\b(?:[Yy]our|[Tt]he) ([A-Z][\w+]*(?: (?:with )?[A-Z][\w+]*){0,3}) (?:plan|membership|subscription)\b/.exec(text);
  const plan = m?.[1]?.trim();
  if (!plan || (service && plan.toLowerCase() === service.toLowerCase())) return undefined;
  return plan;
}

/** Amount preceded by a cue that marks it as the old price ("was $15.49", "from $15.49"). */
const OLD_PRICE_CUE = /(?:\bwas|\bpreviously|\bcurrently|\bcurrent (?:price|plan price)|\bfrom|\bde|\bvon|\bérait)\s*:?\s*\(?$/i;

function priceChange(window: string, ctx: EmailContext): { price?: Money; previousPrice?: Money } {
  const amts = amountsIn(window, ctx).slice(0, 2);
  if (amts.length === 0) return {};
  if (amts.length === 1) return { price: amts[0]!.money };
  const [a, b] = amts as [ExtractedAmount, ExtractedAmount];
  const before = (x: ExtractedAmount) => window.slice(Math.max(0, x.index - 24), x.index);
  if (OLD_PRICE_CUE.test(before(b)) && !OLD_PRICE_CUE.test(before(a))) return { price: a.money, previousPrice: b.money };
  return { price: b.money, previousPrice: a.money };
}

function subscriptionFinding(doc: Doc): EmailFinding | undefined {
  const { ctx } = doc;
  const role = ctx.sender?.info.role;
  if (role !== "subscription" && !SUBSCRIPTION_WORDS.test(doc.all)) return undefined;
  const service = ctx.sender ? senderVariant(ctx.sender.info, ctx.subject).displayName : ctx.senderName;

  type Rule = { readonly event: SubscriptionEventKind; readonly re: RegExp };
  const rules: Rule[] = [
    { event: "payment_failed", re: PAYMENT_FAILED },
    { event: "cancelled", re: CANCELLED },
    { event: "trial_ending", re: TRIAL_ENDING },
    { event: "price_change", re: PRICE_CHANGE },
  ];
  // A receipt that also states the next billing date is a charge, not a renewal notice.
  const isReceipt = role === "subscription" && RECEIPT_WORDS.test(ctx.subject);
  if (!isReceipt) rules.push({ event: "renewal_upcoming", re: RENEWAL });
  rules.push({ event: "signup", re: SIGNUP });

  let event: SubscriptionEventKind | undefined;
  let at = -1;
  for (const r of rules) {
    const m = r.re.exec(doc.all);
    if (m) {
      event = r.event;
      at = m.index;
      break;
    }
  }
  // An app store sells one-off items too (a movie rental, a game): its receipt is a subscription
  // charge only when it says so (a plan, a renewal, a billing period).
  if (!event && isReceipt && (SUBSCRIPTION_WORDS.test(doc.flat) || RENEWAL.test(doc.flat) || periodIn(doc.flat) !== undefined)) {
    event = "charged";
    at = 0;
  }
  if (!event) return undefined;
  // Merchant-role senders (Amazon Prime) only count with explicit subscription vocabulary near the match.
  if (role !== "subscription" && !SUBSCRIPTION_WORDS.test(windowFrom(doc.all, Math.max(0, at - 160), 360))) return undefined;

  const window = windowFrom(doc.all, at, 260);
  const known = ctx.sender?.addressKnown === true;
  const period = periodIn(window) ?? periodIn(doc.flat);
  const plan = planIn(doc.all, service);
  const firstAmount = amountsIn(window, ctx)[0] ?? amountsIn(doc.flat, ctx)[0];
  let details: SubscriptionDetails = { event, ...(service ? { serviceName: service } : {}), ...(plan ? { planName: plan } : {}), ...(period ? { period } : {}) };
  let window_: "pre_spend" | "post_spend" = "post_spend";
  let stage: TransactionStatus = "confirmed";
  let amount: Measured<Money> | undefined;
  let lineItems: LineItem[] | undefined;
  let matched = lineAt(doc.all, at);

  switch (event) {
    case "trial_ending": {
      const when = dateIn(window, ctx);
      details = { ...details, ...(when ? { trialEndsAt: when.at, nextChargeAt: when.at } : {}), ...(firstAmount ? { price: firstAmount.money } : {}) };
      window_ = "pre_spend";
      stage = "intent";
      break;
    }
    case "renewal_upcoming": {
      const when = dateIn(window, ctx);
      details = { ...details, ...(when ? { nextChargeAt: when.at } : {}), ...(firstAmount ? { price: firstAmount.money } : {}) };
      window_ = "pre_spend";
      stage = "intent";
      break;
    }
    case "price_change": {
      const change = priceChange(window, ctx);
      const effective = /\b(?:starting|beginning|effective|from|on|as of|a partir de|ab)\b/i.exec(window);
      const when = effective ? dateIn(window.slice(effective.index), ctx) : dateIn(window, ctx);
      details = { ...details, ...change, ...(when ? { nextChargeAt: when.at } : {}) };
      window_ = "pre_spend";
      stage = "intent";
      break;
    }
    case "payment_failed": {
      details = { ...details, ...(firstAmount ? { price: firstAmount.money } : {}) };
      stage = "unknown";
      break;
    }
    case "cancelled": {
      stage = "cancelled";
      break;
    }
    case "signup": {
      const trial = /\btrial\b/i.test(window);
      const when = trial ? dateIn(window, ctx) : undefined;
      details = {
        ...details,
        event: trial ? "trial_started" : "signup",
        ...(when ? { trialEndsAt: when.at } : {}),
        ...(firstAmount ? { price: firstAmount.money } : {}),
      };
      window_ = trial ? "pre_spend" : "post_spend";
      stage = trial ? "intent" : "confirmed";
      break;
    }
    case "charged": {
      const total = findTotal(doc);
      const money = total?.money ?? firstAmount?.money;
      if (!money) return undefined;
      amount = measured(money, known ? 0.95 : 0.8);
      const renew = RENEWAL.exec(doc.flat);
      const when = renew ? dateIn(windowFrom(doc.flat, renew.index), ctx) : undefined;
      details = { ...details, price: money, ...(when ? { nextChargeAt: when.at } : {}) };
      const scanned = scanItems(doc);
      lineItems = scanned.items.length > 0 ? scanned.items : undefined;
      if (total) matched = total.line;
      break;
    }
    default:
      break;
  }

  const payment = event === "charged" || event === "payment_failed" ? findPayment(doc.lines) : {};
  const references = findReferences(doc.flat, ctx).filter((r) => r.type === "order_id" || r.type === "invoice_id" || r.type === "receipt_id");
  return {
    kind: "subscription_event",
    window: window_,
    stage,
    direction: "debit",
    ...(event === "charged" && ctx.emailDate > 0 ? { occurredAt: measured(ctx.emailDate, 0.8) } : {}),
    ...(amount ? { amount } : {}),
    ...(senderMerchant(ctx, known ? 0.95 : 0.7) ? { merchant: senderMerchant(ctx, known ? 0.95 : 0.7)! } : {}),
    ...(payment.rail ? { rail: payment.rail } : {}),
    ...(payment.instrument ? { instrument: payment.instrument } : {}),
    references,
    ...(lineItems ? { lineItems } : {}),
    categoryHints: senderCategoryHints(ctx),
    typeHints: [{ type: "subscription", confidence: role === "subscription" ? 0.9 : 0.75, reason: `email:subscription-${event}` }],
    subscription: details,
    confidence: known ? 0.92 : ctx.sender ? 0.8 : 0.7,
    method: known ? "template" : doc.method,
    label: SUBSCRIPTION_LABELS[details.event],
    key: `subscription:${details.event}`,
    matchedLine: matched,
  };
}

const SUBSCRIPTION_LABELS: Readonly<Record<SubscriptionEventKind, string>> = {
  signup: "subscription confirmation",
  trial_started: "trial confirmation",
  trial_ending: "trial-ending notice",
  renewal_upcoming: "renewal notice",
  charged: "subscription receipt",
  price_change: "price-change notice",
  cancelled: "cancellation",
  payment_failed: "payment-failed notice",
};

// ---------------------------------------------------------------------------
// Travel and reservations (no markup)
// ---------------------------------------------------------------------------

const BOOKING_SUBJECT = /\b(?:booking|reservation|itinerary|e-?ticket|pnr|check-?in|your (?:flight|stay|hotel)|boarding pass|reserva|buchung|réservation)\b/i;

const TRAVEL_KEYWORDS: readonly [RegExp, string][] = [
  [/\b(?:flight|airline|pnr|boarding|departure|arrival|terminal)\b/i, "travel.flights"],
  [/\b(?:hotel|stay|check-?in|check-?out|nights?|room|guest ?house|resort)\b/i, "travel.lodging"],
  [/\b(?:table for|restaurant|dinner|lunch reservation)\b/i, "eating_out.restaurant"],
  [/\b(?:train|rail|coach|bus)\b/i, "travel"],
];

/** Stays and rentals paid at the property: nothing is charged at booking time. */
const PAY_LATER =
  /\byou'?ll pay (?:when you stay|during your stay|at the (?:property|hotel)|the property)\b|\bpay (?:at|on arrival at) the (?:property|hotel)\b|\bpayment (?:will be )?(?:collected|taken|made) (?:at|by) the (?:property|hotel)\b|\bno (?:pre)?payment (?:is )?(?:needed|required)\b|\bpagamento no (?:hotel|local)\b|\bzahlung (?:erfolgt )?(?:in der unterkunft|vor ort)\b/i;

/** True when the email says the stay or rental is paid at the property (shared with the markup extractor). */
export function paysAtProperty(text: string): boolean {
  return PAY_LATER.test(text);
}

function bookingFinding(doc: Doc): EmailFinding | undefined {
  const { ctx } = doc;
  if (ctx.sender?.info.role !== "travel" && !BOOKING_SUBJECT.test(ctx.subject)) return undefined;
  const references = findReferences(doc.flat, ctx, "booking_ref");
  const total = findTotal(doc);
  if (!total && references.length === 0) return undefined;
  const cancelled = /\bcancel+(?:ed|ation)\b|\bcancelad[ao]\b|\bstorniert\b/i.test(ctx.subject);
  // "Total price € 389" on a pay-at-property stay is the expected charge, not money that moved.
  const payLater = !cancelled && total !== undefined && PAY_LATER.test(doc.flat);
  const known = ctx.sender?.addressKnown === true;
  const categoryHints = senderCategoryHints(ctx);
  if (categoryHints.length === 0) {
    const kw = TRAVEL_KEYWORDS.find(([re]) => re.test(doc.all));
    if (kw) categoryHints.push({ scheme: "brake", value: kw[1], confidence: 0.6 });
  }
  const payment = findPayment(doc.lines);
  return {
    kind: "booking",
    window: total && !payLater ? "post_spend" : "pre_spend",
    stage: cancelled ? "cancelled" : payLater ? "pending" : total ? "confirmed" : "intent",
    direction: "debit",
    ...(emailOccurredAt(ctx, 0.7) ? { occurredAt: emailOccurredAt(ctx, 0.7)! } : {}),
    ...(total ? { amount: measured(total.money, known ? 0.92 : 0.75) } : {}),
    ...(senderMerchant(ctx, known ? 0.9 : 0.65) ? { merchant: senderMerchant(ctx, known ? 0.9 : 0.65)! } : {}),
    ...(payment.rail ? { rail: payment.rail } : {}),
    ...(payment.instrument ? { instrument: payment.instrument } : {}),
    references: references.map((r) => (r.type === "order_id" ? { ...r, type: "booking_ref" as const } : r)),
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    typeHints: [{ type: "purchase", confidence: 0.8, reason: "email:booking" }],
    confidence: known ? 0.88 : 0.68,
    method: known ? "template" : doc.method,
    label: "booking confirmation",
    key: `booking:${references[0]?.value ?? total?.money.minor ?? ""}`,
    ...(total ? { matchedLine: total.line } : {}),
  };
}

// ---------------------------------------------------------------------------
// Orders, receipts, invoices, deliveries
// ---------------------------------------------------------------------------

const INVOICE_WORDS = /\b(?:invoice|fatura|nota fiscal|rechnung|facture|factura|bill)\b/i;
const RECEIPT_KIND_WORDS = /\b(?:receipt|recibo|quittung|reçu|trip|ride|payment (?:received|successful)|thanks for (?:your payment|riding))\b/i;
const DELIVERY_WORDS =
  /\b(?:shipped|dispatched|out for delivery|delivered|arriving|on (?:its|the) way|in transit|has been sent|enviado|entregue|a caminho|versandt|zugestellt|unterwegs|expédié|livré)\b/i;
const DELIVERY_STATUS: readonly [RegExp, string][] = [
  [/\bout for delivery\b|\bsaiu para entrega\b/i, "out for delivery"],
  [/\bdelivered\b|\bentregue\b|\bzugestellt\b|\blivré\b/i, "delivered"],
  [/\b(?:shipped|dispatched|has been sent|enviado|versandt|expédié)\b/i, "shipped"],
  [/\b(?:arriving|on (?:its|the) way|in transit|a caminho|unterwegs)\b/i, "in transit"],
];
const ORDER_CANCELLED = /\border (?:has been |was |is )?cancel+ed\b|\bcancel+ation of (?:your )?order\b|\bpedido cancelado\b|\bbestellung storniert\b/i;
const DUE_WORDS = /\b(?:amount due|payment due|due (?:date|on|by)|minimum due|vencimento|fällig)\b/i;
const PAID_WORDS = /\b(?:paid|payment received|thank you for your payment|pago|bezahlt)\b/i;

function orderFinding(doc: Doc): EmailFinding | undefined {
  const { ctx } = doc;
  const total = findTotal(doc);
  const references = findReferences(doc.all, ctx);
  const { components, items: scannedItems } = scanItems(doc);
  // Item totals far above the order total mean we read recommendations, not the order.
  const items =
    total && scannedItems.some((i) => i.total) && scannedItems.reduce((s, i) => s + (i.total?.currency === total.money.currency ? i.total.minor : 0), 0) > total.money.minor * 1.05 + (components.find((c) => c.kind === "discount")?.amount.minor ?? 0)
      ? []
      : scannedItems;
  // Priced products with neither a total nor an order number are a catalogue ("Buy again",
  // recommendations, a re-order prompt), not something the user bought.
  if (!total && references.length === 0) return undefined;
  const known = ctx.sender?.addressKnown === true;

  const subjectAndHead = `${ctx.subject}\n${doc.lines.slice(0, 6).join("\n")}`;
  let kind: EmailFinding["kind"] = "order";
  let label = "order confirmation";
  let detail: string | undefined;
  if (INVOICE_WORDS.test(ctx.subject)) {
    kind = "invoice";
    label = "invoice";
  } else if (RECEIPT_KIND_WORDS.test(ctx.subject)) {
    kind = "receipt";
    label = "receipt";
  } else if (!total && DELIVERY_WORDS.test(subjectAndHead)) {
    kind = "delivery";
    label = "delivery update";
    detail = DELIVERY_STATUS.find(([re]) => re.test(subjectAndHead))?.[1];
  }

  const cod = /\b(?:cash on delivery|pay on delivery|cod)\b/i.test(doc.flat);
  let stage: TransactionStatus = "confirmed";
  let window: "pre_spend" | "post_spend" = "post_spend";
  if (ORDER_CANCELLED.test(subjectAndHead)) stage = "cancelled";
  else if (kind === "invoice" && DUE_WORDS.test(doc.all) && !PAID_WORDS.test(ctx.subject)) {
    stage = "pending";
    window = "pre_spend";
  } else if (cod) stage = "pending";

  const payment = findPayment(doc.lines);
  const reconciles = total ? itemsReconcile(items, components, total.money) : false;
  const templated = known && total !== undefined && total.rank <= 2;
  let confidence = templated ? (total!.rank <= 1 ? 0.9 : 0.86) : ctx.sender ? 0.78 : 0.7;
  if (reconciles) confidence = Math.min(0.95, confidence + 0.04);
  if (kind === "delivery") confidence = known ? 0.9 : 0.7;

  const categoryHints = senderCategoryHints(ctx);
  return {
    kind,
    window,
    stage,
    ...(kind === "delivery" ? {} : { direction: "debit" as const }),
    ...(emailOccurredAt(ctx, 0.75) ? { occurredAt: emailOccurredAt(ctx, 0.75)! } : {}),
    ...(total && kind !== "delivery" ? { amount: measured(total.money, templated ? (reconciles ? 0.97 : 0.93) : 0.8) } : {}),
    ...(components.length > 0 && kind !== "delivery" ? { amountBreakdown: components } : {}),
    ...(senderMerchant(ctx, known ? 0.95 : 0.7) ? { merchant: senderMerchant(ctx, known ? 0.95 : 0.7)! } : {}),
    ...(payment.rail ? { rail: payment.rail } : cod ? { rail: { family: "cash" as const } } : {}),
    ...(payment.instrument ? { instrument: payment.instrument } : {}),
    references,
    ...(items.length > 0 ? { lineItems: items } : {}),
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    ...(kind === "delivery" ? {} : { typeHints: [{ type: "purchase" as const, confidence: 0.8, reason: `email:${kind}` }] }),
    confidence,
    method: templated ? "template" : doc.method,
    label,
    key: `${kind}:${references[0]?.value ?? total?.money.minor ?? ""}`,
    ...(total ? { matchedLine: total.line } : references[0] ? { matchedLine: lineAt(doc.all, doc.all.indexOf(references[0].value)) } : {}),
    ...(detail ? { detail } : {}),
  };
}
