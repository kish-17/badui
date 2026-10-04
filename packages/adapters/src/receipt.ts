import { DAY, clamp01, currencyExponent, isOneTimePasswordMessage, parseAmount, redactSensitive } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  AmountComponent,
  CountryCode,
  CurrencyCode,
  EpochMillis,
  InstrumentObservation,
  LineItem,
  LocaleTag,
  Money,
  Observation,
  PaymentRail,
  Probability,
  RawSignal,
  Reference,
  SignalAdapter,
  SourceRef,
  TypeHint,
} from "@brake/core";
import { detectCurrency, lastFour, normalizeWhitespace, observationId, parseDateTime } from "./shared/text";
import type { ParsedDateTime } from "./shared/text";
import { describeMoney } from "./upi";

/**
 * Receipt photos, screenshots and PDFs (on-device OCR text) -> post-spend
 * `receipt` observations with merchant, total, tax, line items, payment
 * instrument and receipt/invoice number.
 *
 * Everything locale-specific is data: total/subtotal/tax/change keywords in
 * en, pt, es, de, fr; decimal separators are inferred from the receipt itself
 * (with the user's locale as tie-breaker). The value of receipts is line
 * items and semantics, so the total is chosen conservatively: an explicit
 * grand total beats "TOTAL", which beats a card/paid line, which beats the
 * sum of items; subtotals, tax, cash tendered and change never win.
 * Research: docs/research/08-manual-and-pre-spend-surfaces.md §15–16,
 * docs/research/04-ios-device-signals.md §20.
 *
 * The image and OCR text are never kept; a redacted, expiring excerpt of the
 * header and total lines supports "How did BRAKE know this?".
 */

export interface ReceiptPayload {
  readonly ocrText: string;
  /** OCR line segmentation when the recognizer provides it (preferred over splitting ocrText). */
  readonly lines?: readonly string[];
  readonly capturedAt: EpochMillis;
  readonly source: "photo" | "screenshot" | "pdf";
}

const ADAPTER_ID = "receipt";
const EXCERPT_TTL = 7 * DAY;

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "receipt",
  displayName: "Receipt scans",
  windows: ["post_spend"],
  platforms: ["android", "ios", "web"],
  requiresCapabilities: [],
  privacy: {
    sensitivity: "medium",
    dataCategories: ["text read from receipts you scan (merchant, items, totals, last 4 card digits)"],
    processing: "on_device",
  },
};

/* ------------------------------------------------------------------ */
/* Keyword data pack                                                   */
/* ------------------------------------------------------------------ */

type LabelKind = "ignore" | "tax_total" | "subtotal" | "total1" | "tax" | "total2" | "tip" | "discount" | "change" | "tendered" | "paid";

/**
 * Line labels, matched against the start of a diacritic-stripped,
 * lower-cased line, first rule wins. Order encodes the disambiguation:
 * "total tax" is tax, "total items" is not money, "grand total" beats "total".
 */
const LABEL_RULES: ReadonlyArray<readonly [LabelKind, RegExp]> = [
  ["ignore", /^(?:total\s+(?:items?|qty|quantity|savings?|discounts?|units?|pcs|artikel|itens|de\s+itens)|items?\s+total|no\.?\s+of\s+items|you\s+saved|qtd\.?\s+total|quantidade\s+total|anzahl|round(?:ing)?\s*off|arredondamento)\b/],
  ["tax_total", /^(?:total\s+(?:tax|taxes|vat|gst|mwst|iva|tributos|impostos)|(?:tax|vat|gst)\s+total|total\s+(?:aprox\.?\s+)?(?:de\s+)?tributos)\b/],
  ["subtotal", /^(?:sub[\s-]?total|zwischensumme|netto(?:betrag|summe)?|summe\s+netto|taxable\s+(?:amount|value)|amount\s+before\s+tax|valor\s+(?:dos\s+)?(?:produtos|itens)|sous[\s-]total)\b/],
  ["total1", /^(?:grand\s+total|total\s+amount|total\s+due|amount\s+due|balance\s+due|total\s+payable|net\s+payable|net\s+amount|amount\s+payable|bill\s+amount|invoice\s+total|order\s+total|total\s+a\s+pagar|valor\s+a\s+pagar|total\s+da\s+compra|total\s+do\s+cupom|valor\s+total|gesamtbetrag|gesamtsumme|zu\s+zahlen|endbetrag|total\s+ttc|montant\s+total|net\s+a\s+payer|importe\s+total|total\s+general|totale\s+complessivo)\b/],
  ["tax", /^(?:(?:sales\s+)?tax|vat|gst|cgst|sgst|igst|utgst|cess|mwst|ust|mehrwertsteuer|umsatzsteuer|enthaltene?\s+mwst|inkl\.?\s+mwst|iva|icms|hst|pst|qst|tva|tributos|impostos)\b/],
  ["total2", /^(?:total|gesamt|summe|totale|totaal|montant|importe)\b/],
  ["tip", /^(?:tip|gratuity|trinkgeld|gorjeta|propina|service\s+charge|taxa\s+de\s+servico|servico|pourboire)\b/],
  ["discount", /^(?:discount|savings?|coupon|desconto|rabatt|descuento|remise|promo(?:tion)?)\b/],
  ["change", /^(?:change(?:\s+due)?|troco|ruckgeld|wechselgeld|cambio|vuelto|rendu)\b/],
  ["tendered", /^(?:cash(?:\s+tendered)?|tendered|bar|geg(?:eben|\.)|dinheiro|efectivo|especes|recebido|valor\s+recebido)\b/],
  ["paid", /^(?:amount\s+paid|total\s+paid|paid|valor\s+pago|bezahlt|pagado|visa|master\s?card|amex|rupay|elo|card|cartao|credito|debito|karte|ec[\s-]?karte|girocard|upi|pix)\b/],
];

/** Header lines that are never the merchant name. */
const NOT_MERCHANT =
  /^(?:tax\s+invoice|invoice|receipt|sales\s+receipt|cash\s+memo|bill(?:\s+of\s+supply)?|retail\s+invoice|cupom\s+fiscal|nota\s+fiscal|nfc-?e|documento\s+auxiliar|danfe|kassenbon|beleg|rechnung|quittung|ticket|welcome|bem[\s-]vindo|willkommen|bienvenue|thank\s+you|obrigad[oa]|danke|duplicate|copy|original|customer\s+copy|merchant\s+copy|store\s*#?\s*\d|loja|filiale|tel|phone|ph\b|fone|fax|gstin|gst\s*(?:no|in)|cnpj|cpf|ie\b|im\b|ust|st\.?\s*-?nr|steuer|www\.|http|date|data|datum|time|hora|cashier|operator|kasse|caixa|server|table|mesa)/;

/** Street/address words; a header line containing one plus a digit is an address. */
const ADDRESS_WORD = /\b(?:st|street|rd|road|ave|avenue|blvd|boulevard|lane|ln|suite|floor|rua|r\.|av\.?|avenida|travessa|strasse|str\.?|platz|weg|allee|marg|nagar|sector|calle|carrera|rue)\b/i;

/** Item lines that are bookkeeping, not goods. */
const NOT_ITEM = /^(?:table|mesa|tisch|guests?|covers?|pessoas|server|cashier|operator|kasse|caixa|order\s*#|pedido|token|kot|bill\s*no|invoice|receipt|beleg|bon|terminal|tid|mid|batch|trace|ref|auth|appr|card|visa|master|amex|cash|change|tel|phone|gstin|cnpj|cpf)\b/;

const REFUND = /\b(?:refund|returned?|reembolso|estorno|devolucao|ruckgabe|storno|gutschrift|credit\s+note|nota\s+de\s+credito|avoir)\b/;

const CARD_NETWORKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bvisa\b/, "visa"],
  [/\bmaster\s?card\b|\bmc\b/, "mastercard"],
  [/\bamex\b|\bamerican\s+express\b/, "amex"],
  [/\brupay\b/, "rupay"],
  [/\belo\b/, "elo"],
  [/\bhipercard\b/, "hipercard"],
  [/\bmaestro\b/, "maestro"],
  [/\bgirocard\b|\bec[\s-]?karte\b/, "girocard"],
  [/\bdiscover\b/, "discover"],
  [/\bjcb\b/, "jcb"],
  [/\bdiners\b/, "diners"],
  [/\bunion\s?pay\b/, "unionpay"],
  [/\binterac\b/, "interac"],
  [/\beftpos\b/, "eftpos"],
];

const DOC_NUMBER =
  /\b(receipt|rcpt|invoice|inv|bill|transaction|trans|txn|bon|beleg|rechnung|cupom|nfc-?e|nota\s+fiscal|coo|recibo|factura|facture)[\s-]*(?:no\.?|nr\.?|number|num\.?|#|n[ºo°]\.?|id)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9/-]{2,24})/gi;
const INVOICE_WORDS = /^(?:invoice|inv|bill|rechnung|nfc-?e|nota\s+fiscal|factura|facture)$/i;

const AUTH_CODE =
  /\b(?:auth(?:ori[sz]ation)?|appr(?:oval)?|autoriza[cç][aã]o|aut|genehmigung(?:s-?nr)?)\.?\s*(?:code|cd|no|nr|#)?\.?\s*[:#]?\s*([A-Z0-9]{4,8})\b/gi;

/** 12-digit UPI RRN/UTR printed on POS slips and payment screenshots. */
const UPI_RRN = /\b(?:rrn|utr|upi\s*ref(?:erence)?(?:\s*no\.?)?|upi\s*txn\s*id)\s*[:#.]?\s*(\d{12})\b/i;

const DATE_LINE = /\b(?:date|data|datum|fecha|emiss[aã]o|dt)\b/i;

/** Locale languages that write decimal commas (tie-breaker only). */
const COMMA_DECIMAL_LANGS = new Set(["de", "pt", "es", "fr", "it", "nl", "id", "vi", "tr", "ru", "pl", "da", "sv", "nb", "fi", "cs"]);

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export interface ReceiptParseOptions {
  readonly country?: CountryCode;
  readonly locale?: LocaleTag;
  readonly defaultCurrency?: CurrencyCode;
  readonly timeZone?: string;
}

export interface ReceiptPayment {
  readonly method: "card" | "cash" | "upi" | "pix";
  readonly network?: string;
  readonly last4?: string;
  readonly cardKind?: "credit" | "debit";
}

export interface ParsedReceipt {
  readonly merchant?: string;
  readonly currency?: CurrencyCode;
  readonly total?: Money;
  /** Where the total came from: an explicit total line, a payment line, or the sum of items. */
  readonly totalSource: "grand_total" | "total" | "paid" | "items" | "none";
  readonly subtotal?: Money;
  readonly tax?: Money;
  readonly tip?: Money;
  readonly discount?: Money;
  readonly lineItems: readonly LineItem[];
  readonly date?: ParsedDateTime;
  readonly documentNumber?: { readonly type: "receipt_id" | "invoice_id"; readonly value: string };
  readonly authCode?: string;
  readonly upiReference?: string;
  readonly payment?: ReceiptPayment;
  readonly refund: boolean;
  /** Totals reconcile with subtotal/tax or with the items. */
  readonly validated: boolean;
  /** 0..1 heuristic quality of the OCR text itself. */
  readonly quality: Probability;
  readonly decimalSeparator: "." | ",";
  /** Index of the line holding the chosen total, for excerpts. */
  readonly totalLine?: number;
}

interface LabeledLine {
  readonly index: number;
  readonly kind: LabelKind;
  readonly label: string;
  readonly amount?: Money;
}

/** Parse OCR'd receipt text. Pure; exported for tests and for other receipt-bearing sources. */
export function parseReceiptText(text: string, opts: ReceiptParseOptions = {}, givenLines?: readonly string[]): ParsedReceipt {
  const lines = (givenLines && givenLines.length > 0 ? givenLines : text.split(/\r?\n/))
    .map((l) => normalizeWhitespace(l))
    .filter((l) => l.length > 0);
  const joined = lines.join("\n");
  const folded = lines.map(fold);
  const sep = inferDecimalSeparator(joined, opts.locale);
  const currency = detectCurrency(joined, opts) ?? opts.defaultCurrency ?? undefined;
  const zeroExp = currency ? currencyExponent(currency) === 0 : false;

  const labeled: LabeledLine[] = [];
  folded.forEach((f, index) => {
    const body = f.replace(/^[^\p{L}\p{N}]+/u, "");
    for (const [kind, re] of LABEL_RULES) {
      const m = re.exec(body);
      if (m) {
        const amount = currency ? lastAmount(lines[index] ?? "", sep, currency, zeroExp) : undefined;
        labeled.push({ index, kind, label: m[0], ...(amount ? { amount } : {}) });
        break;
      }
    }
  });
  const labelAt = new Map(labeled.map((l) => [l.index, l]));

  const merchantIndex = findMerchant(lines, folded);
  const firstSummary = labeled.find((l) => ["subtotal", "total1", "total2", "tax_total", "tax", "tip", "discount"].includes(l.kind))?.index ?? lines.length;
  const lineItems: LineItem[] = [];
  if (currency) {
    for (let i = (merchantIndex ?? -1) + 1; i < firstSummary && lineItems.length < 60; i++) {
      if (labelAt.has(i)) continue;
      const item = parseItemLine(lines[i] ?? "", folded[i] ?? "", sep, currency, zeroExp);
      if (item) lineItems.push(item);
    }
  }

  const positive = (k: LabelKind) => labeled.filter((l) => l.kind === k && l.amount && l.amount.minor > 0);
  const maxOf = (ls: LabeledLine[]) => ls.reduce<LabeledLine | undefined>((best, l) => (!best || (l.amount?.minor ?? 0) > (best.amount?.minor ?? 0) ? l : best), undefined);

  let totalSource: ParsedReceipt["totalSource"] = "none";
  let totalLine = maxOf(positive("total1"));
  if (totalLine) totalSource = "grand_total";
  else if ((totalLine = maxOf(positive("total2")))) totalSource = "total";
  else if ((totalLine = maxOf(positive("paid")))) totalSource = "paid";
  let total = totalLine?.amount;
  const itemsSum = sumMoney(lineItems.map((i) => i.total).filter((m): m is Money => m !== undefined));
  if (!total && itemsSum && itemsSum.minor > 0) {
    total = itemsSum;
    totalSource = "items";
  }

  const subtotal = positive("subtotal")[0]?.amount;
  const taxTotal = positive("tax_total")[0]?.amount;
  const tax = taxTotal ?? sumTaxLines(positive("tax"));
  const tip = maxOf(positive("tip"))?.amount;
  const discount = sumMoney(labeled.filter((l) => l.kind === "discount" && l.amount).map((l) => l.amount as Money));

  const validated = total !== undefined && totalSource !== "items" && reconciles(total, subtotal, tax, tip, discount, itemsSum);
  const date = findDate(lines, opts);
  const docNumber = findDocumentNumber(joined);
  const authCode = firstWithDigit(joined, AUTH_CODE);
  const upiRef = UPI_RRN.exec(joined)?.[1];
  const foldedText = folded.join("\n");

  return {
    ...(merchantIndex !== undefined ? { merchant: lines[merchantIndex] } : {}),
    ...(currency ? { currency } : {}),
    ...(total ? { total } : {}),
    totalSource,
    ...(subtotal ? { subtotal } : {}),
    ...(tax ? { tax } : {}),
    ...(tip ? { tip } : {}),
    ...(discount && discount.minor > 0 ? { discount } : {}),
    lineItems,
    ...(date ? { date } : {}),
    ...(docNumber ? { documentNumber: docNumber } : {}),
    ...(authCode ? { authCode } : {}),
    ...(upiRef ? { upiReference: upiRef } : {}),
    ...paymentOf(joined, foldedText, labeled),
    refund: REFUND.test(foldedText),
    validated,
    quality: ocrQuality(lines),
    decimalSeparator: sep,
    ...(totalLine ? { totalLine: totalLine.index } : {}),
  };
}

/** Lower-case, diacritics removed ("Rückgeld" -> "ruckgeld", "Cartão" -> "cartao"). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Majority of "d,dd" vs "d.dd" amount shapes, dates and times excluded; locale breaks ties. */
function inferDecimalSeparator(text: string, locale: LocaleTag | undefined): "." | "," {
  const scrubbed = text
    .replace(/\b\d{1,4}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  const commas = (scrubbed.match(/\d,\d{2}(?!\d)/g) ?? []).length;
  const dots = (scrubbed.match(/\d\.\d{2}(?!\d)/g) ?? []).length;
  if (commas !== dots) return commas > dots ? "," : ".";
  const lang = (locale ?? "").split("-")[0]?.toLowerCase() ?? "";
  return COMMA_DECIMAL_LANGS.has(lang) ? "," : ".";
}

/** A token shaped like an amount in this receipt's convention ("1,180.00", "1.234,56", "45,90"; integers only for 0-decimal currencies). */
function isMoneyToken(token: string, sep: "." | ",", zeroExp: boolean): boolean {
  const t = token.replace(/^(?:R\$|US\$|\$|€|£|₹|¥|Rs\.?|Rp\.?)/i, "").replace(/-$/, "").replace(/^-/, "");
  const group = sep === "." ? "," : ".";
  const g = group === "." ? "\\." : ",";
  const s = sep === "." ? "\\." : ",";
  if (new RegExp(`^\\d{1,3}(?:${g}\\d{2,3})*${s}\\d{2}$|^\\d+${s}\\d{2}$`).test(t)) return true;
  return zeroExp && new RegExp(`^\\d{1,3}(?:${g}\\d{3})+$|^\\d+$`).test(t);
}

/** The last amount on a line that is not a percentage, date or time. */
function lastAmount(line: string, sep: "." | ",", currency: CurrencyCode, zeroExp: boolean): Money | undefined {
  const tokens = line
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/(\d)\s+%/g, "$1%")
    .split(/\s+/)
    .filter((t) => isMoneyToken(t.replace(/[:;]$/, ""), sep, zeroExp));
  const last = tokens[tokens.length - 1];
  if (!last) return undefined;
  return parseAmount(cleanToken(last), currency, { decimalSeparator: sep }) ?? undefined;
}

function cleanToken(t: string): string {
  return t.replace(/^(?:R\$|US\$|\$|€|£|₹|¥|Rs\.?|Rp\.?)/i, "").replace(/[-:;]+$/, "").replace(/^-/, "");
}

/** The merchant: the first header line that is not a document title, id, address, phone or date. */
function findMerchant(lines: readonly string[], folded: readonly string[]): number | undefined {
  for (let i = 0; i < Math.min(6, lines.length); i++) {
    const line = lines[i] ?? "";
    const f = (folded[i] ?? "").replace(/^[^\p{L}\p{N}]+/u, "");
    const letters = (line.match(/\p{L}/gu) ?? []).length;
    const digits = (line.match(/\d/g) ?? []).length;
    if (letters < 3 || digits > letters) continue;
    if (NOT_MERCHANT.test(f) || line.includes("@")) continue;
    if (/\d/.test(line) && ADDRESS_WORD.test(line)) continue;
    if (/\b\d{5,6}\b/.test(line)) continue; // postal codes
    if (LABEL_RULES.some(([, re]) => re.test(f))) continue;
    return i;
  }
  return undefined;
}

const UNIT_TOKEN = /^(?:x|@|\*|un|und|unid|kg|g|l|ml|pc|pcs|nos|ea|st|stk|qty)$/i;
const FLAG_TOKEN = /^(?:[A-Z]{1,2}|\*{1,2})$/;

/**
 * "Paneer Tikka 1 280.00 280.00", "MILK 2% GAL 3.49 F", "Vollmilch 3,5% 1,19 A",
 * "001 7891000100103 LEITE INTEGRAL 1L 2 UN X 4,99 9,98".
 */
function parseItemLine(line: string, folded: string, sep: "." | ",", currency: CurrencyCode, zeroExp: boolean): LineItem | null {
  if (NOT_ITEM.test(folded.replace(/^[^\p{L}\p{N}]+/u, ""))) return null;
  const tokens = line.split(/\s+/);
  while (tokens.length > 2 && FLAG_TOKEN.test(tokens[tokens.length - 1] ?? "") && isMoneyToken(tokens[tokens.length - 2] ?? "", sep, zeroExp)) tokens.pop();
  const tail: string[] = [];
  let i = tokens.length - 1;
  for (; i >= 0; i--) {
    const t = tokens[i] ?? "";
    if (isMoneyToken(t, sep, zeroExp) || /^\d{1,3}(?:[.,]\d{1,3})?[xX]?$/.test(t) || UNIT_TOKEN.test(t)) tail.unshift(t);
    else break;
  }
  const money = tail.filter((t) => isMoneyToken(t, sep, zeroExp));
  if (money.length === 0) return null;
  const desc = tokens.slice(0, i + 1);
  let productId: string | undefined;
  // Leading line numbers ("001") and GTIN/EAN codes precede the description on many POS formats.
  while (desc.length > 1 && /^0\d{1,3}$/.test(desc[0] ?? "")) desc.shift();
  const gtinAt = desc.findIndex((t, k) => k < 2 && /^\d{8,14}$/.test(t));
  if (gtinAt >= 0) {
    productId = `gtin:${(desc[gtinAt] ?? "").padStart(14, "0")}`;
    desc.splice(gtinAt, 1);
  }
  let leadingQty: number | undefined;
  if (desc.length > 1 && /^\d{1,3}[xX]?$/.test(desc[0] ?? "") && (/[xX]$/.test(desc[0] ?? "") || /^[xX]$/.test(desc[1] ?? ""))) {
    leadingQty = Number((desc.shift() ?? "").replace(/[xX]$/, ""));
    if (/^[xX]$/.test(desc[0] ?? "")) desc.shift();
  }
  const description = desc.join(" ").trim();
  if ((description.match(/\p{L}/gu) ?? []).length < 2) return null;

  const parse = (t: string) => parseAmount(cleanToken(t), currency, { decimalSeparator: sep }) ?? undefined;
  const total = parse(money[money.length - 1] ?? "");
  const unit = money.length >= 2 ? parse(money[money.length - 2] ?? "") : undefined;
  const qtyToken = tail.find((t) => !isMoneyToken(t, sep, zeroExp) && /^\d{1,3}[xX]?$/.test(t));
  const quantity = leadingQty ?? (qtyToken ? Number(qtyToken.replace(/[xX]$/, "")) : undefined);
  if (!total) return null;
  return {
    description,
    ...(quantity !== undefined && quantity > 0 ? { quantity } : {}),
    ...(unit ? { unitPrice: unit } : {}),
    total,
    ...(productId ? { productId } : {}),
  };
}

function sumMoney(ms: readonly Money[]): Money | undefined {
  const first = ms[0];
  if (!first) return undefined;
  return { minor: ms.filter((m) => m.currency === first.currency).reduce((s, m) => s + m.minor, 0), currency: first.currency };
}

/** CGST + SGST are different taxes (sum); "MwSt" printed twice is one tax (max). */
function sumTaxLines(lines: readonly LabeledLine[]): Money | undefined {
  const byKind = new Map<string, Money>();
  for (const l of lines) {
    if (!l.amount) continue;
    const key = l.label.split(/\s+/)[0] ?? l.label;
    const prev = byKind.get(key);
    if (!prev || l.amount.minor > prev.minor) byKind.set(key, l.amount);
  }
  return sumMoney([...byKind.values()]);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, Math.round(Math.max(a, b) * 0.005));
}

/** Total = subtotal + tax (+ tip − discount), tax-inclusive variants, or ≈ Σ items. */
function reconciles(total: Money, subtotal?: Money, tax?: Money, tip?: Money, discount?: Money, items?: Money): boolean {
  const t = total.minor;
  const extra = (tip?.minor ?? 0) - (discount?.minor ?? 0);
  if (subtotal) {
    if (close(subtotal.minor + (tax?.minor ?? 0) + extra, t)) return true;
    if (tax && close(subtotal.minor + extra, t)) return true; // tax included in prices (EU/IN style)
  }
  if (items && items.minor > 0) {
    if (close(items.minor, t) || close(items.minor + extra, t) || close(items.minor + (tax?.minor ?? 0) + extra, t)) return true;
  }
  return false;
}

function findDate(lines: readonly string[], opts: ReceiptParseOptions): ParsedDateTime | undefined {
  const country = opts.country ?? regionOf(opts.locale);
  const o = { ...(country ? { country } : {}), ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) };
  for (const line of lines) {
    if (DATE_LINE.test(line)) {
      const d = parseDateTime(line, o);
      if (d) return d;
    }
  }
  return parseDateTime(lines.join("\n"), o) ?? undefined;
}

function regionOf(locale: LocaleTag | undefined): CountryCode | undefined {
  const region = locale?.split("-")[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : undefined;
}

function findDocumentNumber(text: string): ParsedReceipt["documentNumber"] {
  for (const m of text.matchAll(DOC_NUMBER)) {
    const word = (m[1] ?? "").replace(/\s+/g, " ");
    const value = m[2] ?? "";
    if (!/\d/.test(value)) continue;
    return { type: INVOICE_WORDS.test(word) ? "invoice_id" : "receipt_id", value: value.replace(/[-/]+$/, "") };
  }
  return undefined;
}

function firstWithDigit(text: string, re: RegExp): string | undefined {
  for (const m of text.matchAll(re)) if (m[1] && /\d/.test(m[1])) return m[1];
  return undefined;
}

function paymentOf(text: string, folded: string, labeled: readonly LabeledLine[]): { payment?: ReceiptPayment } {
  const network = CARD_NETWORKS.find(([re]) => re.test(folded))?.[1];
  const last4 = lastFour(text);
  const cardKind = /\b(?:credit|credito)\b/.test(folded) ? "credit" : /\b(?:debit|debito)\b/.test(folded) ? "debit" : undefined;
  if (network || (last4 && /\b(?:card|cartao|karte|tarjeta)\b/.test(folded))) {
    return { payment: { method: "card", ...(network ? { network } : {}), ...(last4 ? { last4 } : {}), ...(cardKind ? { cardKind } : {}) } };
  }
  if (/\bupi\b/.test(folded)) return { payment: { method: "upi" } };
  if (/\bpix\b/.test(folded)) return { payment: { method: "pix" } };
  if (labeled.some((l) => l.kind === "tendered")) return { payment: { method: "cash" } };
  return {};
}

/** Heuristic OCR quality: garbage glyphs, digit/letter confusions ("1O.5O"), fragmented lines. */
function ocrQuality(lines: readonly string[]): Probability {
  const text = lines.join("\n");
  const chars = Array.from(text.replace(/\s/g, ""));
  if (chars.length === 0) return 0;
  const odd = chars.filter((c) => !/[\p{L}\p{N}.,:;/\-+*#%()&'"@$€£¥₹₩₦₱฿₫|=_!?ºª°]/u.test(c)).length;
  const confusions = (text.match(/\b\d+[OoIlS]\d*[.,][\dOoIlS]{2}\b|\b\d+[.,]\d?[OoIlS]\d?\b/g) ?? []).length;
  const fragments = lines.filter((l) => l.length <= 2).length / lines.length;
  return clamp01(1 - (odd / chars.length) * 3 - Math.min(0.3, confusions * 0.08) - fragments * 0.3);
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

const SOURCE_BASE: Readonly<Record<ReceiptPayload["source"], number>> = {
  // A PDF has a text layer; a screenshot is crisp; a photo of thermal paper is the noisiest.
  pdf: 0.8,
  screenshot: 0.72,
  photo: 0.62,
};

const SOURCE_LABEL: Readonly<Record<ReceiptPayload["source"], string>> = {
  pdf: "receipt PDF",
  screenshot: "receipt screenshot",
  photo: "receipt photo",
};

/** Whether text that yielded no amount still looked like a receipt (vs. any other photo of text). */
const RECEIPT_WORDS = /\b(?:total|subtotal|receipt|invoice|tax|gst|vat|mwst|summe|cupom|nota\s+fiscal|recibo|rechnung|kassenbon|bill)\b/i;

export function createReceiptAdapter(): SignalAdapter<ReceiptPayload> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<ReceiptPayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload;
      if (!p || typeof p.ocrText !== "string") return { status: "rejected", reason: "payload.ocrText missing" };
      if (!(p.source in SOURCE_BASE)) return { status: "rejected", reason: `unknown source ${String(p.source)}` };
      const text = p.ocrText;
      if (isOneTimePasswordMessage(text)) return { status: "ignored", reason: "otp" };
      const capturedAt = Number.isFinite(p.capturedAt) ? p.capturedAt : signal.receivedAt;

      const r = parseReceiptText(text, ctx, p.lines);
      if (!r.total && r.lineItems.length === 0) {
        return { status: "ignored", reason: RECEIPT_WORDS.test(text) ? "unsupported_format" : "not_financial" };
      }

      // OCR dates later than the capture are misreads (a receipt cannot be from the future).
      const date = r.date && r.date.at <= capturedAt + DAY ? r.date : undefined;
      const confidence = receiptConfidence(r, p.source);
      const merchantKey = r.merchant ? fold(r.merchant).replace(/[^a-z0-9]+/g, "").slice(0, 40) : undefined;
      const ns = merchantKey || "receipt";

      const references: Reference[] = [];
      if (r.documentNumber) references.push({ type: r.documentNumber.type, value: r.documentNumber.value, namespace: ns });
      if (r.authCode) references.push({ type: "auth_code", value: r.authCode, namespace: ns });
      if (r.upiReference) references.push({ type: "rail_reference", value: r.upiReference, namespace: "upi" });

      const breakdown: AmountComponent[] = [
        ...(r.subtotal ? [{ kind: "subtotal" as const, amount: r.subtotal }] : []),
        ...(r.tax ? [{ kind: "tax" as const, amount: r.tax }] : []),
        ...(r.tip ? [{ kind: "tip" as const, amount: r.tip }] : []),
        ...(r.discount ? [{ kind: "discount" as const, amount: r.discount }] : []),
      ];
      const instrument = instrumentOf(r.payment);
      const rail = railOf(r.payment);
      const typeHints: TypeHint[] = r.refund ? [{ type: "refund", confidence: 0.75, reason: "receipt:refund-keyword" }] : [];

      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "receipt",
        connectionId: signal.connectionId,
        ...(r.merchant ? { provider: r.merchant } : {}),
        label: SOURCE_LABEL[p.source],
      };
      const observation: Observation = {
        // Same receipt text (re-imported PDF, re-delivered capture) -> same observation.
        id: observationId(ADAPTER_ID, signal.connectionId, `${p.source}|${normalizeWhitespace(text)}`),
        source,
        kind: "receipt",
        window: "post_spend",
        stage: "confirmed",
        receivedAt: signal.receivedAt,
        occurredAt: date
          ? { value: date.at, confidence: date.precision === "datetime" ? 0.85 : 0.45 }
          : { value: capturedAt, confidence: 0.3, approximate: true },
        direction: r.refund ? "credit" : "debit",
        ...(r.total
          ? {
              amount: {
                value: r.total,
                confidence: r.totalSource === "items" ? Math.max(0.2, confidence - 0.15) : confidence,
                ...(r.totalSource === "items" ? { approximate: true } : {}),
              },
            }
          : {}),
        ...(breakdown.length > 0 ? { amountBreakdown: breakdown } : {}),
        ...(r.merchant
          ? {
              merchant: {
                raw: r.merchant,
                name: r.merchant,
                ...(merchantKey ? {} : {}),
                channel: p.source === "photo" ? ("in_store" as const) : ("unknown" as const),
                confidence: clamp01(0.55 + 0.3 * r.quality),
              },
            }
          : {}),
        ...(instrument ? { instrument } : {}),
        ...(rail ? { rail } : {}),
        references,
        ...(r.lineItems.length > 0 ? { lineItems: r.lineItems } : {}),
        ...(typeHints.length > 0 ? { typeHints } : {}),
        confidence,
        evidence: {
          summary: summarize(r, SOURCE_LABEL[p.source], ctx.locale),
          ...excerpt(r, text, p.lines, signal.receivedAt),
        },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

/** OCR baseline by capture type, scaled by text quality, raised when the arithmetic checks out. */
function receiptConfidence(r: ParsedReceipt, source: ReceiptPayload["source"]): Probability {
  let c = SOURCE_BASE[source] * (0.6 + 0.4 * r.quality);
  if (r.validated) c += 0.18;
  if (r.totalSource === "paid") c -= 0.05;
  if (r.totalSource === "items") c -= 0.1;
  if (r.totalSource === "none") c -= 0.2;
  if (!r.merchant) c -= 0.05;
  return Math.round(Math.min(0.92, Math.max(0.2, c)) * 100) / 100;
}

function instrumentOf(p: ReceiptPayment | undefined): InstrumentObservation | undefined {
  if (!p) return undefined;
  if (p.method === "card") {
    return { type: "card", ...(p.network ? { network: p.network } : {}), ...(p.last4 ? { last4: p.last4 } : {}), ...(p.cardKind ? { cardKind: p.cardKind } : {}) };
  }
  if (p.method === "cash") return { type: "cash" };
  if (p.method === "upi") return { type: "upi_handle" };
  return undefined;
}

function railOf(p: ReceiptPayment | undefined): PaymentRail | undefined {
  if (!p) return undefined;
  switch (p.method) {
    case "card":
      return { family: "card", ...(p.network ? { scheme: p.network } : {}) };
    case "cash":
      return { family: "cash" };
    case "upi":
      return { family: "account_to_account_instant", scheme: "upi" };
    case "pix":
      return { family: "account_to_account_instant", scheme: "pix" };
  }
}

function summarize(r: ParsedReceipt, label: string, locale: LocaleTag | undefined): string {
  const what = r.refund ? "Refund receipt" : capitalize(label);
  const amount = r.total ? describeMoney(r.total, locale) : undefined;
  const pay =
    r.payment?.method === "card"
      ? `, paid by ${r.payment.network ? capitalize(r.payment.network) : "card"}${r.payment.last4 ? ` ••${r.payment.last4}` : ""}`
      : r.payment?.method === "cash"
        ? ", paid in cash"
        : r.payment?.method === "upi"
          ? ", paid by UPI"
          : r.payment?.method === "pix"
            ? ", paid by Pix"
            : "";
  const items = r.lineItems.length > 0 ? ` (${r.lineItems.length} item${r.lineItems.length === 1 ? "" : "s"})` : "";
  return `${what}${r.merchant ? ` from ${r.merchant}` : ""}${amount ? `: ${amount}` : ""}${items}${pay}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Header (first three lines) and the total line, redacted and expiring. */
function excerpt(r: ParsedReceipt, text: string, given: readonly string[] | undefined, receivedAt: EpochMillis): { excerpt?: string; excerptExpiresAt?: EpochMillis } {
  const lines = (given && given.length > 0 ? given : text.split(/\r?\n/)).map((l) => normalizeWhitespace(l)).filter(Boolean);
  const picked = [...lines.slice(0, 3), ...(r.totalLine !== undefined && r.totalLine >= 3 ? [lines[r.totalLine] ?? ""] : [])].filter(Boolean);
  const clean = redactSensitive(picked.join(" | ")).text;
  if (!clean) return {};
  return { excerpt: clean.length > 200 ? `${clean.slice(0, 199)}…` : clean, excerptExpiresAt: receivedAt + EXCERPT_TTL };
}
