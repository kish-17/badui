import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CategoryHint,
  CurrencyCode,
  EpochMillis,
  LineItem,
  Measured,
  MerchantObservation,
  Money,
  Observation,
  RawSignal,
  Reference,
  SignalAdapter,
  SourceRef,
} from "@brake/core";
import { detectCurrency, observationId } from "./shared/text";
import { describeProductLink, extractAmountSafe, factText, instantOr, merchantForDomain, merchantNamespace, parseAmountSafe, parseHttpUrl, registrableDomain, textField } from "./share";
import { summaryMoney } from "./upi";

/**
 * Browser extension checkout events (Chromium MV3 / Safari / Firefox content
 * scripts) -> cart intents, in-spend checkouts and order confirmations.
 *
 * The extension reads the page DOM/structured data locally and sends only
 * this event; payment sheets (Payment Request, Apple/Google Pay) are not
 * observable by design (docs/research/05-payment-rails-and-qr.md §16–17,
 * docs/research/08-manual-and-pre-spend-surfaces.md §9–11).
 *
 * URLs on checkout and confirmation pages carry session tokens, e-mail
 * addresses and payment ids in query strings: only scheme, host and path
 * are ever retained, and the confirmation page path is dropped entirely.
 */

export type CheckoutStage = "cart" | "checkout" | "payment_redirect" | "confirmation";

export interface BrowserCheckoutEvent {
  readonly stage: CheckoutStage;
  readonly url: string;
  readonly merchantDomain: string;
  readonly merchantName?: string;
  /** Total as shown on the page ("₹4,799.00", "$86.40", "1.299,00 €", "86.40"). */
  readonly total?: string;
  /** ISO 4217 when the page states it (JSON-LD priceCurrency, GA4 `currency`). */
  readonly currency?: string;
  /** `price` is the per-unit price shown next to the item. */
  readonly items?: ReadonlyArray<{ readonly title: string; readonly price?: string; readonly quantity?: number }>;
  readonly orderId?: string;
  readonly at: EpochMillis;
}

const ADAPTER_ID = "browser-checkout";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "browser_extension",
  displayName: "BRAKE browser extension",
  windows: ["pre_spend", "in_spend", "post_spend"],
  platforms: ["desktop", "ios", "web"],
  requiresCapabilities: ["ext:browser-extension"],
  privacy: {
    sensitivity: "medium",
    dataCategories: ["cart and checkout totals on shopping sites you allow", "order numbers on confirmation pages"],
    processing: "on_device",
  },
};

const STAGES: ReadonlySet<unknown> = new Set<CheckoutStage>(["cart", "checkout", "payment_redirect", "confirmation"]);

type CheckoutItem = NonNullable<BrowserCheckoutEvent["items"]>[number];

/** Per-stage meaning: what the page proves and how sure the total is. */
const STAGE_SHAPE: Readonly<
  Record<CheckoutStage, Pick<Observation, "kind" | "window" | "stage"> & { readonly amountConfidence: number; readonly approximate: boolean; readonly confidence: number; readonly via?: string }>
> = {
  // Cart totals usually exclude tax/shipping/coupons applied later.
  cart: { kind: "purchase_intent", window: "pre_spend", stage: "intent", amountConfidence: 0.8, approximate: true, confidence: 0.8, via: "cart" },
  checkout: { kind: "checkout", window: "in_spend", stage: "intent", amountConfidence: 0.85, approximate: false, confidence: 0.85 },
  payment_redirect: { kind: "checkout", window: "in_spend", stage: "intent", amountConfidence: 0.9, approximate: false, confidence: 0.85 },
  confirmation: { kind: "order", window: "post_spend", stage: "confirmed", amountConfidence: 0.9, approximate: false, confidence: 0.9 },
};

export function createBrowserCheckoutAdapter(): SignalAdapter<BrowserCheckoutEvent> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<BrowserCheckoutEvent>, ctx: AdapterContext): AdapterResult {
      const e = signal.payload;
      if (!e || typeof e !== "object") return { status: "rejected", reason: "payload missing" };
      if (!STAGES.has(e.stage)) return { status: "rejected", reason: `unknown stage ${String(e.stage)}` };
      const page = typeof e.url === "string" ? parseHttpUrl(e.url) : null;
      if (!page) return { status: "rejected", reason: "url must be http(s)" };
      const domainInput = textField(e.merchantDomain) ?? page.host;
      const domain = registrableDomain(parseHttpUrl(domainInput)?.host ?? domainInput.toLowerCase());
      if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain)) return { status: "rejected", reason: "merchantDomain invalid" };
      const at = instantOr(e.at, signal.receivedAt);
      const shape = STAGE_SHAPE[e.stage];

      const link = describeProductLink(e.url);
      const resolved = merchantForDomain(domain);
      const merchantName = factText(e.merchantName, 120);
      const name = merchantName ?? resolved?.merchant.name;
      const merchant: MerchantObservation = {
        raw: merchantName ?? domain,
        ...(name ? { name } : {}),
        ...(resolved ? { key: resolved.merchant.key } : {}),
        website: domain,
        channel: "online",
        confidence: merchantName || resolved?.known ? 0.9 : 0.75,
      };

      // Extension payloads are JSON from page scripts: items may be missing, not an array, or hold nulls.
      const items = Array.isArray(e.items) ? e.items.filter((it): it is CheckoutItem => it !== null && typeof it === "object") : [];
      const totalText = typeof e.total === "string" ? e.total : typeof e.total === "number" && Number.isFinite(e.total) ? String(e.total) : undefined;
      const currency = resolveCurrency(e, totalText, items, ctx);
      const total = totalText !== undefined && currency ? moneyFrom(totalText, currency, ctx) : null;
      const lineItems = items.flatMap((it) => lineItem(it, currency, ctx));

      const orderId = textField(typeof e.orderId === "number" && Number.isSafeInteger(e.orderId) ? String(e.orderId) : e.orderId) ?? (e.stage === "confirmation" ? link?.orderIdFromQuery : undefined);
      // Namespaced like the merchant's order e-mails (data-pack merchant key, else registrable domain), so they join.
      const references: Reference[] = orderId ? [{ type: "order_id", value: orderId, namespace: merchantNamespace(domain) }] : [];
      const categoryHints: CategoryHint[] =
        resolved?.known && resolved.merchant.category ? [{ scheme: "brake", value: resolved.merchant.category, confidence: 0.5 }] : [];
      const amount: Measured<Money> | undefined = total ? { value: total, confidence: shape.amountConfidence, approximate: shape.approximate } : undefined;

      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "browser_extension",
        connectionId: signal.connectionId,
        ...(name ? { provider: name } : {}),
        label: "BRAKE browser extension",
      };
      // Only cart intents keep a URL (query/fragment already stripped); checkout and confirmation paths can embed tokens.
      const retainedUrl = link?.url;
      const firstTitle = lineItems[0]?.description;

      const observation: Observation = {
        // A confirmation page re-rendered (refresh, back button) is the same order.
        id: observationId(ADAPTER_ID, signal.connectionId, e.stage === "confirmation" && orderId ? `confirmation|${domain}|${orderId}` : `${e.stage}|${domain}|${at}`),
        source,
        kind: shape.kind,
        window: shape.window,
        stage: shape.stage,
        receivedAt: signal.receivedAt,
        occurredAt: { value: at, confidence: 0.95 },
        direction: "debit",
        ...(amount ? { amount } : {}),
        merchant,
        references,
        ...(lineItems.length > 0 ? { lineItems } : {}),
        ...(categoryHints.length > 0 ? { categoryHints } : {}),
        ...(shape.via
          ? {
              intent: {
                via: shape.via,
                ...(firstTitle ? { title: lineItems.length > 1 ? `${firstTitle} and ${lineItems.length - 1} more` : firstTitle } : {}),
                ...(retainedUrl ? { url: retainedUrl } : {}),
              },
            }
          : {}),
        confidence: shape.confidence,
        evidence: { summary: summarize(e.stage, name ?? domain, domain, total, orderId, lineItems.length, ctx) },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

function resolveCurrency(e: BrowserCheckoutEvent, total: string | undefined, items: readonly CheckoutItem[], ctx: AdapterContext): CurrencyCode | undefined {
  const stated = textField(e.currency);
  if (stated && /^[A-Za-z]{3}$/.test(stated)) return stated.toUpperCase();
  const fromText = [total, ...items.map((i) => i.price)].map((t) => (typeof t === "string" ? detectCurrency(t, ctx) : null)).find((c) => c);
  return fromText ?? ctx.defaultCurrency;
}

/** "₹4,799.00" / "1.299,00 €" / "86.40" in a known currency; null for anything that is not an exact amount. */
function moneyFrom(text: string, currency: CurrencyCode, ctx: AdapterContext): Money | null {
  const marked = extractAmountSafe(text, { ...ctx, defaultCurrency: currency });
  if (marked) return marked.money.currency === currency ? marked.money : { minor: marked.money.minor, currency };
  // Without a currency marker only a bare number is an amount (not "9999…" noise that parseAmount would round).
  return /^\s*\d[\d.,\s\u00a0\u202f']*\s*$/.test(text) ? parseAmountSafe(text, currency) : null;
}

function lineItem(it: CheckoutItem, currency: CurrencyCode | undefined, ctx: AdapterContext): LineItem[] {
  const description = factText(it.title);
  if (!description) return [];
  const quantity = typeof it.quantity === "number" && Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : undefined;
  const priceText = typeof it.price === "string" ? it.price : typeof it.price === "number" && Number.isFinite(it.price) ? String(it.price) : undefined;
  const unit = priceText !== undefined && currency ? moneyFrom(priceText, currency, ctx) : null;
  const totalMinor = unit && Number.isInteger(quantity ?? 1) ? unit.minor * (quantity ?? 1) : undefined;
  const total = unit && totalMinor !== undefined && Number.isSafeInteger(totalMinor) ? { minor: totalMinor, currency: unit.currency } : null;
  return [
    {
      description,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(unit ? { unitPrice: unit } : {}),
      ...(total ? { total } : {}),
    },
  ];
}

function summarize(
  stage: CheckoutStage,
  name: string,
  domain: string,
  total: Money | null,
  orderId: string | undefined,
  itemCount: number,
  ctx: AdapterContext,
): string {
  const amount = total ? summaryMoney(total, ctx.locale) : undefined;
  const items = itemCount > 0 ? ` (${itemCount} item${itemCount === 1 ? "" : "s"})` : "";
  switch (stage) {
    case "cart":
      return `Your cart on ${domain}${amount ? ` totals ${amount}` : ""}${items}, seen by BRAKE's browser extension.`;
    case "checkout":
      return `You reached checkout on ${domain}${amount ? ` for ${amount}` : ""}${items}.`;
    case "payment_redirect":
      return `${name} sent you to pay${amount ? ` ${amount}` : ""} (payment page opened from ${domain}).`;
    case "confirmation":
      return `${name} confirmed your order${orderId ? ` ${orderId}` : ""}${amount ? ` for ${amount}` : ""} on ${domain}.`;
  }
}
