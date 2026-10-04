import { moneyFromMajor, parseAmount } from "@brake/core";
import type {
  AmountComponent,
  CategoryHint,
  CurrencyCode,
  EpochMillis,
  LineItem,
  Measured,
  MerchantObservation,
  Money,
  Reference,
  TransactionStatus,
} from "@brake/core";
import { detectCurrency, parseDateTime } from "../shared/text";
import { amountsIn, makeLineItem, referenceNamespace, senderCategoryHints, senderMerchant } from "./extract";
import type { EmailContext, EmailFinding } from "./model";
import { ldTypeOf, senderVariant } from "./senders";

/**
 * Observations from schema.org markup embedded in email (the Gmail "Email
 * Markup" vocabulary): Order, Invoice, ParcelDelivery and the Reservation
 * family. Property names follow the schema.org release vocabulary (research
 * 06 §14) plus Google's documented `reservationNumber` alias.
 *
 * Markup is the most reliable extraction layer when present, but it is
 * sender-controlled: amounts are cross-checked against the visible text, and
 * people (`customer`, `underName`, `broker` persons), addresses and account
 * ids are never read.
 */

type Node = Readonly<Record<string, unknown>>;

const SCHEMA_ORG_CONFIDENCE = 0.95;

export function jsonLdFindings(nodes: readonly unknown[], ctx: EmailContext, visibleText?: string): EmailFinding[] {
  const out: EmailFinding[] = [];
  for (const raw of nodes) {
    if (!isNode(raw)) continue;
    const type = ldTypeOf(raw);
    let f: EmailFinding | undefined;
    if (type === "Order") f = orderFinding(raw, ctx);
    else if (type === "Invoice") f = invoiceFinding(raw, ctx);
    else if (type === "ParcelDelivery") f = deliveryFinding(raw, ctx);
    else if (type && /Reservation$/.test(type)) f = reservationFinding(raw, type, ctx);
    if (f) out.push(crossCheck(f, ctx, visibleText));
  }
  // Two nodes describing the same thing (an Order and its own copy in @graph) collapse to one.
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}

/** Markup totals that do not appear in the visible text are suspect (stale or wrong markup). */
function crossCheck(f: EmailFinding, ctx: EmailContext, visibleText?: string): EmailFinding {
  if (!f.amount || !visibleText) return f;
  const seen = amountsIn(visibleText, ctx).some((a) => a.money.minor === f.amount!.value.minor && a.money.currency === f.amount!.value.currency);
  if (seen) return f;
  return { ...f, amount: { ...f.amount, confidence: Math.min(f.amount.confidence, 0.8) }, confidence: Math.min(f.confidence, 0.85) };
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

const ORDER_STATUS: Readonly<Record<string, TransactionStatus>> = {
  OrderPaymentDue: "pending",
  OrderProcessing: "confirmed",
  OrderInTransit: "confirmed",
  OrderPickupAvailable: "confirmed",
  OrderDelivered: "confirmed",
  OrderProblem: "unknown",
  OrderReturned: "refunded",
  OrderCancelled: "cancelled",
};

function orderFinding(node: Node, ctx: EmailContext): EmailFinding | undefined {
  const orderNumber = text(node.orderNumber) ?? text(node.confirmationNumber);
  const merchant = ldMerchant(node.merchant ?? node.seller, ctx);
  const namespace = merchant?.key ?? referenceNamespace(ctx);
  const currency = currencyOf(node.priceCurrency, ctx);
  const items = orderItems(node, currency, ctx);
  const explicit = moneyOf(node.price ?? node.totalPrice ?? node.totalPaymentDue ?? node.priceSpecification, currency, ctx);
  const summed = sumItems(items);
  const total = explicit ?? summed;
  if (!orderNumber && !total && items.length === 0) return undefined;

  const status = ORDER_STATUS[enumName(node.orderStatus) ?? ""] ?? "confirmed";
  const discount = moneyOf(node.discount, currencyOf(node.discountCurrency, ctx) ?? currency, ctx);
  const breakdown: AmountComponent[] = discount ? [{ kind: "discount", amount: discount }] : [];
  const references: Reference[] = orderNumber ? [{ type: "order_id", value: orderNumber, namespace }] : [];
  const invoiceNumber = text(asNode(node.partOfInvoice)?.confirmationNumber);
  if (invoiceNumber) references.push({ type: "invoice_id", value: invoiceNumber, namespace });
  const occurredAt = dateOf(node.orderDate, ctx) ?? emailDate(ctx, 0.75);

  return {
    kind: "order",
    window: "post_spend",
    stage: status,
    direction: "debit",
    ...(occurredAt ? { occurredAt } : {}),
    ...(total ? { amount: { value: total, confidence: explicit ? SCHEMA_ORG_CONFIDENCE : 0.85 } } : {}),
    ...(breakdown.length > 0 ? { amountBreakdown: breakdown } : {}),
    ...(merchant ? { merchant } : {}),
    references,
    ...(items.length > 0 ? { lineItems: items } : {}),
    ...withHints(senderCategoryHints(ctx)),
    typeHints: [{ type: "purchase", confidence: 0.85, reason: "schema_org:Order" }],
    confidence: SCHEMA_ORG_CONFIDENCE,
    method: "schema_org",
    label: status === "cancelled" ? "order cancellation" : "order confirmation",
    key: `order:${orderNumber ?? total?.minor ?? ""}`,
  };
}

/** acceptedOffer (Offer[]) and orderedItem (OrderItem[] | Product[]) -> line items. */
function orderItems(node: Node, currency: CurrencyCode | undefined, ctx: EmailContext): LineItem[] {
  const out: LineItem[] = [];
  for (const offer of nodes(node.acceptedOffer)) {
    const product = offer.itemOffered;
    const name = nameOf(product);
    if (!name) continue;
    const qty = numberOf(asNode(offer.eligibleQuantity)?.value ?? offer.eligibleQuantity);
    const unit = moneyOf(offer.price ?? offer.priceSpecification, currencyOf(offer.priceCurrency, ctx) ?? currency, ctx);
    const quantity = qty !== undefined && qty > 0 ? qty : undefined;
    const item = makeLineItem({
      description: name,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(unit ? { unitPrice: unit, total: { minor: unit.minor * (quantity ?? 1), currency: unit.currency } } : {}),
      ...(productIdOf(product) ? { productId: productIdOf(product)! } : {}),
    });
    if (item) out.push(item);
  }
  if (out.length > 0) return out.slice(0, 50);
  for (const entry of nodes(node.orderedItem)) {
    const isOrderItem = ldTypeOf(entry) === "OrderItem";
    const product = isOrderItem ? entry.orderedItem : entry;
    const name = nameOf(product);
    if (!name) continue;
    const quantity = isOrderItem ? numberOf(entry.orderQuantity) : undefined;
    const item = makeLineItem({
      description: name,
      ...(quantity !== undefined && quantity > 0 ? { quantity } : {}),
      ...(productIdOf(product) ? { productId: productIdOf(product)! } : {}),
    });
    if (item) out.push(item);
  }
  return out.slice(0, 50);
}

function sumItems(items: readonly LineItem[]): Money | undefined {
  const priced = items.filter((i) => i.total);
  if (priced.length === 0 || priced.length !== items.length) return undefined;
  const currency = priced[0]!.total!.currency;
  if (priced.some((i) => i.total!.currency !== currency)) return undefined;
  return { minor: priced.reduce((s, i) => s + i.total!.minor, 0), currency };
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

const PAID_STATUSES = new Set(["PaymentComplete", "PaymentAutomaticallyApplied"]);
const DUE_STATUSES = new Set(["PaymentDue", "PaymentPastDue", "PaymentDeclined"]);

function invoiceFinding(node: Node, ctx: EmailContext): EmailFinding | undefined {
  const merchant = ldMerchant(node.provider ?? node.broker, ctx);
  const namespace = merchant?.key ?? referenceNamespace(ctx);
  const amount = moneyOf(node.totalPaymentDue ?? node.minimumPaymentDue, currencyOf(node.priceCurrency, ctx), ctx);
  const status = enumName(node.paymentStatus);
  const references: Reference[] = [];
  // `accountId` is the customer's account number with the provider: never read.
  const invoiceNo = text(node.confirmationNumber) ?? text(node.identifier);
  if (invoiceNo) references.push({ type: "invoice_id", value: invoiceNo, namespace });
  const orderNo = text(asNode(node.referencesOrder)?.orderNumber);
  if (orderNo) references.push({ type: "order_id", value: orderNo, namespace });
  if (!amount && references.length === 0) return undefined;

  const paid = status !== undefined && PAID_STATUSES.has(status);
  const due = status !== undefined && DUE_STATUSES.has(status);
  const dueDate = dateOf(node.paymentDueDate ?? node.paymentDue, ctx);
  const occurredAt = due && dueDate ? { ...dueDate, approximate: true } : emailDate(ctx, 0.7);
  return {
    kind: "invoice",
    window: due ? "pre_spend" : "post_spend",
    stage: paid ? "confirmed" : due ? "pending" : "unknown",
    direction: "debit",
    ...(occurredAt ? { occurredAt } : {}),
    ...(amount ? { amount: { value: amount, confidence: SCHEMA_ORG_CONFIDENCE } } : {}),
    ...(merchant ? { merchant } : {}),
    references,
    ...withHints(senderCategoryHints(ctx)),
    typeHints: [{ type: "purchase", confidence: 0.6, reason: "schema_org:Invoice" }],
    confidence: SCHEMA_ORG_CONFIDENCE,
    method: "schema_org",
    label: "invoice",
    key: `invoice:${invoiceNo ?? orderNo ?? amount?.minor ?? ""}`,
    ...(paid ? { detail: "paid" } : due ? { detail: "payment due" } : {}),
  };
}

// ---------------------------------------------------------------------------
// ParcelDelivery
// ---------------------------------------------------------------------------

const DELIVERY_DETAIL: Readonly<Record<string, string>> = {
  OrderInTransit: "in transit",
  OrderDelivered: "delivered",
  OrderPickupAvailable: "ready for pickup",
  OrderProblem: "delivery problem",
  OrderReturned: "returned",
  OrderCancelled: "cancelled",
};

function deliveryFinding(node: Node, ctx: EmailContext): EmailFinding | undefined {
  const order = asNode(node.partOfOrder);
  const orderNo = text(order?.orderNumber);
  const merchant = ldMerchant(order?.merchant ?? order?.seller ?? node.provider, ctx);
  const namespace = merchant?.key ?? referenceNamespace(ctx);
  const items: LineItem[] = [];
  for (const p of nodes(node.itemShipped)) {
    const name = nameOf(p);
    const item = name ? makeLineItem({ description: name }) : undefined;
    if (item) items.push(item);
  }
  if (!orderNo && items.length === 0) return undefined;
  const status = enumName(asNode(node.deliveryStatus)?.["@id"] ?? node.deliveryStatus ?? order?.orderStatus);
  const detail = (status && DELIVERY_DETAIL[status]) ?? "shipped";
  const occurredAt = emailDate(ctx, 0.7);
  return {
    kind: "delivery",
    window: "post_spend",
    stage: status === "OrderCancelled" ? "cancelled" : "confirmed",
    ...(occurredAt ? { occurredAt } : {}),
    ...(merchant ? { merchant } : {}),
    references: orderNo ? [{ type: "order_id", value: orderNo, namespace }] : [],
    ...(items.length > 0 ? { lineItems: items.slice(0, 50) } : {}),
    confidence: SCHEMA_ORG_CONFIDENCE,
    method: "schema_org",
    label: "delivery update",
    key: `delivery:${orderNo ?? ""}:${detail}`,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

const RESERVATION_STATUS: Readonly<Record<string, TransactionStatus>> = {
  ReservationConfirmed: "confirmed",
  ReservationPending: "pending",
  ReservationHold: "pending",
  ReservationCancelled: "cancelled",
};

/** Reservation subtype -> BRAKE category id. */
const RESERVATION_CATEGORY: Readonly<Record<string, string>> = {
  FlightReservation: "travel.flights",
  LodgingReservation: "travel.lodging",
  FoodEstablishmentReservation: "eating_out.restaurant",
  EventReservation: "entertainment.events",
  RentalCarReservation: "travel",
  TrainReservation: "travel",
  BusReservation: "travel",
  TaxiReservation: "transport.rideshare",
};

function reservationFinding(node: Node, type: string, ctx: EmailContext): EmailFinding | undefined {
  const number = text(node.reservationNumber) ?? text(node.reservationId) ?? text(node.confirmationNumber);
  const venue = asNode(node.reservationFor);
  // Who provides the service: the airline, the hotel, the restaurant. Event names are not merchants.
  const provider =
    type === "FlightReservation"
      ? nameOf(venue?.airline) ?? nameOf(node.provider)
      : type === "EventReservation"
        ? nameOf(venue?.organizer) ?? nameOf(node.provider)
        : type === "RentalCarReservation"
          ? nameOf(venue?.rentalCompany) ?? nameOf(node.provider)
          : nameOf(venue) ?? nameOf(node.provider);
  const agent = asNode(node.bookingAgent) ?? asNode(node.broker);
  const agentMerchant = agent && ldTypeOf(agent) !== "Person" ? ldMerchant(agent, ctx) : undefined;
  const merchant: MerchantObservation | undefined = provider
    ? { raw: provider, name: provider, channel: "unknown", confidence: 0.9 }
    : agentMerchant ?? senderMerchant(ctx, 0.9);
  // Reservation numbers are issued by whoever took the booking (Booking.com), else the provider.
  const namespace = agentMerchant?.key ?? ctx.sender?.info.key ?? (provider ? slug(provider) : referenceNamespace(ctx));
  const total = moneyOf(node.totalPrice ?? node.price, currencyOf(node.priceCurrency, ctx), ctx);
  if (!number && !total) return undefined;

  const status = RESERVATION_STATUS[enumName(node.reservationStatus) ?? ""] ?? "confirmed";
  // No price means nothing was paid yet: a restaurant table is a likely spend later (pre-spend context).
  const unpaid = !total && status !== "cancelled";
  const occurredAt = dateOf(node.bookingTime, ctx) ?? emailDate(ctx, 0.75);
  const category = RESERVATION_CATEGORY[type] ?? senderVariantCategory(ctx);
  const categoryHints: CategoryHint[] = category ? [{ scheme: "brake", value: category, confidence: 0.85 }] : [];
  const service = serviceDate(type, node, venue, ctx);
  const detailParts = [provider, service].filter((x): x is string => typeof x === "string" && x.length > 0);
  return {
    kind: "booking",
    window: unpaid ? "pre_spend" : "post_spend",
    stage: unpaid ? "intent" : status,
    direction: "debit",
    ...(occurredAt ? { occurredAt } : {}),
    ...(total ? { amount: { value: total, confidence: SCHEMA_ORG_CONFIDENCE } } : {}),
    ...(merchant ? { merchant } : {}),
    references: number ? [{ type: "booking_ref", value: number, namespace }] : [],
    ...withHints(categoryHints),
    typeHints: [{ type: "purchase", confidence: 0.85, reason: `schema_org:${type}` }],
    confidence: SCHEMA_ORG_CONFIDENCE,
    method: "schema_org",
    label: status === "cancelled" ? "reservation cancellation" : "reservation",
    key: `booking:${number ?? total?.minor ?? ""}`,
    ...(detailParts.length > 0 ? { detail: detailParts.join(", ") } : {}),
  };
}

/** "check-in 12 Nov 2026" for stays, "departs 12 Nov 2026" for flights; only the date, never times or places. */
function serviceDate(type: string, node: Node, venue: Node | undefined, ctx: EmailContext): string | undefined {
  const raw =
    type === "LodgingReservation"
      ? node.checkinDate ?? node.checkinTime
      : type === "FlightReservation"
        ? venue?.departureTime
        : node.startTime ?? node.startDate ?? venue?.startDate;
  const d = dateOf(raw, ctx);
  if (!d) return undefined;
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: ctx.timeZone ?? "UTC" }).format(d.value);
  return type === "LodgingReservation" ? `check-in ${day}` : type === "FlightReservation" ? `departs ${day}` : day;
}

function senderVariantCategory(ctx: EmailContext): string | undefined {
  return ctx.sender ? senderVariant(ctx.sender.info, ctx.subject).category : undefined;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function isNode(v: unknown): v is Node {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asNode(v: unknown): Node | undefined {
  if (Array.isArray(v)) return v.find(isNode);
  return isNode(v) ? v : undefined;
}

function nodes(v: unknown): Node[] {
  if (Array.isArray(v)) return v.filter(isNode);
  return isNode(v) ? [v] : [];
}

/** A plain string value: strings, numbers, or `{ "@value": … }`. */
function text(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isNode(v) && v["@value"] !== undefined) return text(v["@value"]);
  return undefined;
}

function nameOf(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  const n = asNode(v);
  return n ? text(n.name) : undefined;
}

function numberOf(v: unknown): number | undefined {
  const s = text(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function productIdOf(v: unknown): string | undefined {
  const n = asNode(v);
  if (!n) return undefined;
  return text(n.sku) ?? text(n.gtin13) ?? text(n.gtin) ?? text(n.gtin12) ?? text(n.productID) ?? text(n.mpn);
}

/** "http://schema.org/OrderDelivered" | "OrderDelivered" | { "@id": … } -> "OrderDelivered". */
function enumName(v: unknown): string | undefined {
  const s = text(v) ?? (isNode(v) ? text(v["@id"]) ?? text(v.name) : undefined);
  return s?.replace(/^.*[/#:]/, "");
}

function currencyOf(v: unknown, ctx: EmailContext): CurrencyCode | undefined {
  const s = text(v)?.toUpperCase();
  if (s && /^[A-Z]{3}$/.test(s)) return s;
  return undefined;
}

/**
 * schema.org prices: a number, a numeric string ("4799.00", always "." as
 * decimal per schema.org), a symbol-marked string ("₹4,799"), a
 * PriceSpecification `{ price, priceCurrency }` or a MonetaryAmount
 * `{ value, currency }`.
 */
function moneyOf(v: unknown, currency: CurrencyCode | undefined, ctx: EmailContext): Money | undefined {
  const n = asNode(v);
  if (n) {
    const inner = n.price ?? n.value ?? n.amount;
    return moneyOf(inner, currencyOf(n.priceCurrency ?? n.currency, ctx) ?? currency, ctx);
  }
  const fallback = currency ?? ctx.sender?.info.currency ?? ctx.defaultCurrency;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return fallback ? moneyFromMajor(v, fallback) : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return fallback ? parseAmount(s, fallback, { decimalSeparator: "." }) ?? undefined : undefined;
  const marked = amountsIn(s, ctx)[0];
  if (marked) return currency && marked.money.currency !== currency ? undefined : marked.money;
  const detected = detectCurrency(s, ctx.country ? { country: ctx.country } : {}) ?? fallback;
  return detected ? parseAmount(s, detected) ?? undefined : undefined;
}

/**
 * ISO 8601 dates. Values with a zone offset are exact; local date-times and
 * bare dates are interpreted in the user's zone via the shared parser, so no
 * result depends on the machine's time zone.
 */
function dateOf(v: unknown, ctx: EmailContext): Measured<EpochMillis> | undefined {
  const s = text(v);
  if (!s) return undefined;
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? { value: t, confidence: 0.9 } : undefined;
  }
  const p = parseDateTime(s.replace("T", " "), { order: "YMD", ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}) });
  if (!p) return undefined;
  return p.precision === "datetime" ? { value: p.at, confidence: 0.85 } : { value: p.at, confidence: 0.6, approximate: true };
}

function emailDate(ctx: EmailContext, confidence: number): Measured<EpochMillis> | undefined {
  return ctx.emailDate > 0 ? { value: ctx.emailDate, confidence } : undefined;
}

/**
 * Merchant from markup (`merchant`/`seller`/`provider`). When it names the
 * sender's own brand ("Amazon.in" from amazon.in) the sender's canonical key
 * is used, so references share a namespace with other Amazon sources.
 */
function ldMerchant(v: unknown, ctx: EmailContext): MerchantObservation | undefined {
  const node = asNode(v);
  if (node && ldTypeOf(node) === "Person") return undefined;
  const name = nameOf(v);
  const fromSender = senderMerchant(ctx, 0.95);
  if (!name) return fromSender;
  const n = name.toLowerCase();
  if (fromSender && ctx.sender && (n.includes(ctx.sender.info.key.replace(/_/g, " ")) || n.includes(ctx.sender.info.displayName.toLowerCase()))) {
    return { ...fromSender, raw: name };
  }
  const url = text(node?.url);
  const website = url ? /^https?:\/\/(?:www\.)?([^/]+)/i.exec(url)?.[1]?.toLowerCase() : undefined;
  return { raw: name, name, key: slug(name), ...(website ? { website } : {}), channel: "online", confidence: 0.85 };
}

/** "Booking.com" -> "booking_com". Only used when no sender key exists. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function withHints(hints: readonly CategoryHint[]): { categoryHints?: readonly CategoryHint[] } {
  return hints.length > 0 ? { categoryHints: hints } : {};
}
