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
  TypeHint,
} from "@brake/core";
import { detectCurrency, parseDateTime } from "../shared/text";
import { amountsIn, makeLineItem, paysAtProperty, referenceNamespace, senderCategoryHints, senderMerchant, visibleTotal } from "./extract";
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
    else if (type && /Reservation$/.test(type)) f = reservationFinding(raw, type, ctx, visibleText);
    if (f) out.push(crossCheck(f, ctx, visibleText));
  }
  // Two nodes describing the same thing (an Order and its own copy in @graph) collapse to one.
  const seen = new Set<string>();
  const unique = out.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
  return unique.length === 1 ? [withVisibleTotal(unique[0]!, ctx, visibleText)] : unique;
}

/**
 * Markup often names the order or ticket but not its price (Google's
 * FlightReservation examples carry none). When the email is about exactly one
 * paid order or ticket, the labelled total of its visible text is the amount,
 * at heuristic rather than markup confidence. Never for several findings
 * (one total cannot be split between them) and never for unpaid bookings.
 */
function withVisibleTotal(f: EmailFinding, ctx: EmailContext, visibleText?: string): EmailFinding {
  if (f.amount || !visibleText) return f;
  const paidBooking = f.kind === "booking" && f.stage === "confirmed";
  if (f.kind !== "order" && !paidBooking) return f;
  const total = visibleTotal(visibleText, ctx);
  if (!total) return f;
  return { ...f, amount: { value: total.money, confidence: 0.8 }, matchedLine: total.line };
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
  const namespace = referenceNamespace(ctx);
  const currency = currencyOf(node.priceCurrency);
  const items = orderItems(node, currency, ctx);
  const explicit = moneyOf(node.price ?? node.totalPrice ?? node.totalPaymentDue ?? node.priceSpecification, currency, ctx);
  const summed = sumItems(items);
  const total = explicit ?? summed;
  if (!orderNumber && !total && items.length === 0) return undefined;

  const status = ORDER_STATUS[enumName(node.orderStatus) ?? ""] ?? "confirmed";
  const discount = moneyOf(node.discount, currencyOf(node.discountCurrency) ?? currency, ctx);
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
    const unit = moneyOf(offer.price ?? offer.priceSpecification, currencyOf(offer.priceCurrency) ?? currency, ctx);
    const quantity = qty !== undefined && qty > 0 && qty <= MAX_QUANTITY ? qty : undefined;
    // Quantities may be fractional (1.5 kg); Money stays in whole minor units.
    const lineMinor = unit ? Math.round(unit.minor * (quantity ?? 1)) : undefined;
    const item = makeLineItem({
      description: name,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(unit ? { unitPrice: unit } : {}),
      ...(unit && lineMinor !== undefined && Number.isSafeInteger(lineMinor) ? { total: { minor: lineMinor, currency: unit.currency } } : {}),
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
      ...(quantity !== undefined && quantity > 0 && quantity <= MAX_QUANTITY ? { quantity } : {}),
      ...(productIdOf(product) ? { productId: productIdOf(product)! } : {}),
    });
    if (item) out.push(item);
  }
  return out.slice(0, 50);
}

/** Larger quantities in markup are noise (or hostile), not an order line. */
const MAX_QUANTITY = 10_000;

function sumItems(items: readonly LineItem[]): Money | undefined {
  const priced = items.filter((i) => i.total);
  if (priced.length === 0 || priced.length !== items.length) return undefined;
  const currency = priced[0]!.total!.currency;
  if (priced.some((i) => i.total!.currency !== currency)) return undefined;
  const minor = priced.reduce((s, i) => s + i.total!.minor, 0);
  return Number.isSafeInteger(minor) ? { minor, currency } : undefined;
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

const PAID_STATUSES = new Set(["PaymentComplete", "PaymentAutomaticallyApplied"]);
const DUE_STATUSES = new Set(["PaymentDue", "PaymentPastDue", "PaymentDeclined"]);

function invoiceFinding(node: Node, ctx: EmailContext): EmailFinding | undefined {
  const merchant = ldMerchant(node.provider ?? node.broker, ctx);
  const namespace = referenceNamespace(ctx);
  // The minimum due is not what the bill is for; without a total the invoice carries no amount.
  const amount = moneyOf(node.totalPaymentDue, currencyOf(node.priceCurrency), ctx);
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
    ...withTypeHints(invoiceTypeHints(node, ctx)),
    confidence: SCHEMA_ORG_CONFIDENCE,
    method: "schema_org",
    label: "invoice",
    key: `invoice:${invoiceNo ?? orderNo ?? amount?.minor ?? ""}`,
    ...(paid ? { detail: "paid" } : due ? { detail: "payment due" } : {}),
  };
}

/**
 * A bank's or wallet's "invoice" is a card bill or loan statement: paying it
 * moves money between the user's own accounts and is never a purchase (the
 * brief's transfer-vs-spending problem). A card bill says so; anything else
 * from a bank is left untyped for the intelligence layer.
 */
function invoiceTypeHints(node: Node, ctx: EmailContext): TypeHint[] {
  const role = ctx.sender?.info.role;
  if (role !== "bank" && role !== "payment") return [{ type: "purchase", confidence: 0.6, reason: "schema_org:Invoice" }];
  const about = [text(node.category), text(node.description), text(node.name), nameOf(node.provider)].filter(Boolean).join(" ");
  return /\bcard\b|cart[aã]o|karte/i.test(about) ? [{ type: "credit_card_payment", confidence: 0.7, reason: "schema_org:Invoice:card-bill" }] : [];
}

function withTypeHints(hints: readonly TypeHint[]): { typeHints?: readonly TypeHint[] } {
  return hints.length > 0 ? { typeHints: hints } : {};
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
  const namespace = referenceNamespace(ctx);
  const items: LineItem[] = [];
  for (const p of nodes(node.itemShipped)) {
    const name = nameOf(p);
    const item = name ? makeLineItem({ description: name }) : undefined;
    if (item) items.push(item);
  }
  if (!orderNo && items.length === 0) return undefined;
  // `deliveryStatus` may be a DeliveryEvent object with no status of its own: fall back to the order's.
  const status = [enumName(node.deliveryStatus), enumName(order?.orderStatus)].find((s) => s !== undefined && DELIVERY_DETAIL[s] !== undefined);
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

/** Reservation types whose ticket is issued only after payment. */
const PREPAID_RESERVATIONS: ReadonlySet<string> = new Set(["FlightReservation", "TrainReservation", "BusReservation"]);

/** Reservation types that are often paid at the property rather than when booked. */
const PAY_AT_PROPERTY_RESERVATIONS: ReadonlySet<string> = new Set(["LodgingReservation", "RentalCarReservation"]);

function reservationFinding(node: Node, type: string, ctx: EmailContext, visibleText?: string): EmailFinding | undefined {
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
  const namespace = referenceNamespace(ctx);
  const total = moneyOf(node.totalPrice ?? node.price, currencyOf(node.priceCurrency), ctx);
  if (!number && !total) return undefined;

  const status = RESERVATION_STATUS[enumName(node.reservationStatus) ?? ""] ?? "confirmed";
  // No price usually means nothing was paid yet: a restaurant table or a pay-at-hotel stay is a
  // likely spend later (pre-spend context). Flight, train and bus tickets are paid when issued,
  // so a confirmed ticket without a markup price is still a purchase.
  const unpaid = !total && status !== "cancelled" && !PREPAID_RESERVATIONS.has(type);
  // A priced pay-at-property stay ("You'll pay when you stay") is the expected charge, not a payment.
  const payLater = total !== undefined && status !== "cancelled" && PAY_AT_PROPERTY_RESERVATIONS.has(type) && visibleText !== undefined && paysAtProperty(visibleText);
  const occurredAt = dateOf(node.bookingTime, ctx) ?? emailDate(ctx, 0.75);
  const category = RESERVATION_CATEGORY[type] ?? senderVariantCategory(ctx);
  const categoryHints: CategoryHint[] = category ? [{ scheme: "brake", value: category, confidence: 0.85 }] : [];
  const service = serviceDate(type, node, venue, ctx);
  const detailParts = [provider, service].filter((x): x is string => typeof x === "string" && x.length > 0);
  return {
    kind: "booking",
    window: unpaid || payLater ? "pre_spend" : "post_spend",
    stage: unpaid ? "intent" : payLater ? "pending" : status,
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

function currencyOf(v: unknown): CurrencyCode | undefined {
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
function moneyOf(v: unknown, currency: CurrencyCode | undefined, ctx: EmailContext, depth = 0): Money | undefined {
  const n = asNode(v);
  if (n) {
    if (depth > 3) return undefined;
    const inner = n.price ?? n.value ?? n.amount;
    return moneyOf(inner, currencyOf(n.priceCurrency ?? n.currency) ?? currency, ctx, depth + 1);
  }
  const fallback = currency ?? ctx.sender?.info.currency ?? ctx.defaultCurrency;
  // Markup is sender-controlled: a price like 1e307 or a 400-digit string must
  // yield nothing rather than make core's Money constructor throw.
  if (typeof v === "number") return fallback && Number.isFinite(v) && v >= 0 && v <= MAX_MAJOR ? safe(() => moneyFromMajor(v, fallback)) : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, 64);
  if (/^\d+(?:\.\d+)?$/.test(s)) return fallback ? safe(() => parseAmount(s, fallback, { decimalSeparator: "." })) : undefined;
  const marked = amountsIn(s, ctx)[0];
  if (marked) return currency && marked.money.currency !== currency ? undefined : marked.money;
  const detected = detectCurrency(s, ctx.country ? { country: ctx.country } : {}) ?? fallback;
  return detected ? safe(() => parseAmount(s, detected)) : undefined;
}

/** No real order, invoice or reservation is priced above this many major units. */
const MAX_MAJOR = 1e12;

function safe(make: () => Money | null): Money | undefined {
  try {
    const m = make();
    return m && Number.isSafeInteger(m.minor) ? m : undefined;
  } catch {
    return undefined;
  }
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
 * Merchant from markup (`merchant`/`seller`/`provider`). A registered sender
 * is the merchant whatever the markup says: on a marketplace the `seller` of
 * record ("Appario Retail" on Amazon.in) neither charges the card nor issues
 * the order number, and a bank descriptor reads "AMAZON". The markup name is
 * kept as `raw` only when it names the sender's own brand ("Amazon.in").
 *
 * References from markup use the same namespace as the heuristic extractors
 * (`referenceNamespace`: the sender key, else the sending domain), so an
 * order confirmation with markup and a plain shipping or refund email from
 * the same sender carry comparable order ids.
 */
function ldMerchant(v: unknown, ctx: EmailContext): MerchantObservation | undefined {
  const node = asNode(v);
  if (node && ldTypeOf(node) === "Person") return undefined;
  const name = nameOf(v);
  const fromSender = senderMerchant(ctx, 0.95);
  if (!name) return fromSender;
  const n = name.toLowerCase();
  if (fromSender && ctx.sender) {
    const namesSender = n.includes(ctx.sender.info.key.replace(/_/g, " ")) || n.includes(ctx.sender.info.displayName.toLowerCase());
    return namesSender ? { ...fromSender, raw: name } : fromSender;
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
