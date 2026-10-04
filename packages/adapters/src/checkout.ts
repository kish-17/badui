import { parseAmount } from "@brake/core";
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
import { detectCurrency, extractAmount, normalizeWhitespace, observationId } from "./shared/text";
import { describeProductLink, merchantForDomain, parseHttpUrl, registrableDomain } from "./share";
import { describeMoney } from "./upi";

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

const STAGES: ReadonlySet<string> = new Set<CheckoutStage>(["cart", "checkout", "payment_redirect", "confirmation"]);

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
      const domainInput = typeof e.merchantDomain === "string" && e.merchantDomain.trim() ? e.merchantDomain.trim() : page.host;
      const domain = registrableDomain(parseHttpUrl(domainInput)?.host ?? domainInput.toLowerCase());
      if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain)) return { status: "rejected", reason: "merchantDomain invalid" };
      const at = Number.isFinite(e.at) ? e.at : signal.receivedAt;
      const shape = STAGE_SHAPE[e.stage];

      const link = describeProductLink(e.url);
      const resolved = merchantForDomain(domain);
      const name = (e.merchantName ? normalizeWhitespace(e.merchantName) : "") || resolved?.merchant.name;
      const merchant: MerchantObservation = {
        raw: e.merchantName ? normalizeWhitespace(e.merchantName) : domain,
        ...(name ? { name } : {}),
        ...(resolved ? { key: resolved.merchant.key } : {}),
        website: domain,
        channel: "online",
        confidence: e.merchantName || resolved?.known ? 0.9 : 0.75,
      };

      const currency = resolveCurrency(e, ctx);
      const total = e.total !== undefined && currency ? moneyFrom(e.total, currency, ctx) : null;
      const lineItems = (e.items ?? []).flatMap((it) => lineItem(it, currency, ctx));

      const orderId = (typeof e.orderId === "string" && e.orderId.trim()) || (e.stage === "confirmation" ? link?.orderIdFromQuery : undefined);
      // Namespaced by the merchant's registrable domain, like e-mail order confirmations, so they can join.
      const references: Reference[] = orderId ? [{ type: "order_id", value: orderId.trim(), namespace: domain }] : [];
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

function resolveCurrency(e: BrowserCheckoutEvent, ctx: AdapterContext): CurrencyCode | undefined {
  if (typeof e.currency === "string" && /^[A-Za-z]{3}$/.test(e.currency.trim())) return e.currency.trim().toUpperCase();
  const fromText = [e.total, ...(e.items ?? []).map((i) => i.price)].map((t) => (t ? detectCurrency(t, ctx) : null)).find((c) => c);
  return fromText ?? ctx.defaultCurrency;
}

/** "₹4,799.00" / "1.299,00 €" / "86.40" in a known currency. */
function moneyFrom(text: string, currency: CurrencyCode, ctx: AdapterContext): Money | null {
  const marked = extractAmount(text, { ...ctx, defaultCurrency: currency });
  if (marked) return marked.money.currency === currency ? marked.money : { minor: marked.money.minor, currency };
  return parseAmount(text, currency);
}

function lineItem(it: { readonly title: string; readonly price?: string; readonly quantity?: number }, currency: CurrencyCode | undefined, ctx: AdapterContext): LineItem[] {
  const description = typeof it.title === "string" ? normalizeWhitespace(it.title) : "";
  if (!description) return [];
  const quantity = typeof it.quantity === "number" && Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : undefined;
  const unit = it.price && currency ? moneyFrom(it.price, currency, ctx) : null;
  const total = unit && Number.isInteger(quantity ?? 1) ? { minor: unit.minor * (quantity ?? 1), currency: unit.currency } : null;
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
  const amount = total ? describeMoney(total, ctx.locale) : undefined;
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
