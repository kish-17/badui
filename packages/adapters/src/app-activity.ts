import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CategoryHint,
  EpochMillis,
  MerchantObservation,
  Observation,
  RawSignal,
  SignalAdapter,
  SourceRef,
  TransactionStatus,
} from "@brake/core";
import { normalizeWhitespace, observationId } from "./shared/text";

/**
 * Shopping-app launches and BRAKE pause ("shield") outcomes -> `app_context`
 * observations. Context only: they are never transactions and fusion never
 * merges them (fusion-and-reconciliation.md, "Context"). The intelligence
 * layer uses them to time pre-spend help and to learn whether pauses work.
 *
 * Capture: iOS Screen Time shields (FamilyControls/ManagedSettings; the
 * ShieldAction extension knows the outcome, the app id may be an opaque
 * token) and Android UsageStatsManager `ACTIVITY_RESUMED` polling for apps
 * the user picked. Research: docs/research/04-ios-device-signals.md §3–4,
 * docs/research/03-android-device-signals.md §5, docs/research/08-manual-and-pre-spend-surfaces.md §20–23.
 *
 * Privacy: app ids stay out of evidence text (on iOS they may be Screen Time
 * tokens that Apple's DPLA §3.3.3(P) keeps on device); only the event, the
 * app's display name when the capture layer was allowed to know it, and the
 * category survive.
 */

export type AppActivityEvent = "app_opened" | "shield_shown" | "shield_bypassed" | "shield_respected";
export type AppActivityCategory = "shopping" | "food_delivery" | "travel" | "other";

export interface AppActivityPayload {
  readonly event: AppActivityEvent;
  /** Android package name, iOS bundle id, or an opaque Screen Time token reference. */
  readonly appId: string;
  readonly appName?: string;
  readonly category?: AppActivityCategory;
  readonly at: EpochMillis;
  readonly platform: "ios" | "android";
}

const ADAPTER_ID = "app-activity";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "app_activity",
  displayName: "Shopping app pauses",
  windows: ["pre_spend"],
  platforms: ["ios", "android"],
  // Gated per platform by the registry's SourceDefinition (os:screen-time-shield OR os:usage-access);
  // an all-of list cannot express that, so the adapter itself requires nothing.
  requiresCapabilities: [],
  privacy: {
    sensitivity: "medium",
    dataCategories: ["when you open apps you asked BRAKE to watch", "whether you continued past a pause"],
    processing: "on_device",
  },
};

export interface KnownApp {
  readonly name: string;
  /** Merchant key when the app *is* a merchant's storefront (matches share/checkout keys). */
  readonly merchantKey?: string;
  readonly category: AppActivityCategory;
}

/**
 * App ids -> display name / merchant. Package and bundle ids are public
 * store identifiers (observed on the Play Store / App Store; not verified for
 * 2026). A new app is a row here.
 */
const KNOWN_APPS: Readonly<Record<string, KnownApp>> = {
  "in.amazon.mShop.android.shopping": { name: "Amazon", merchantKey: "amazon", category: "shopping" },
  "com.amazon.mShop.android.shopping": { name: "Amazon", merchantKey: "amazon", category: "shopping" },
  "com.amazon.Amazon": { name: "Amazon", merchantKey: "amazon", category: "shopping" },
  "com.flipkart.android": { name: "Flipkart", merchantKey: "flipkart", category: "shopping" },
  "com.myntra.android": { name: "Myntra", merchantKey: "myntra", category: "shopping" },
  "com.meesho.supply": { name: "Meesho", merchantKey: "meesho", category: "shopping" },
  "com.ril.ajio": { name: "AJIO", merchantKey: "ajio", category: "shopping" },
  "com.fsn.nykaa": { name: "Nykaa", merchantKey: "nykaa", category: "shopping" },
  "in.swiggy.android": { name: "Swiggy", merchantKey: "swiggy", category: "food_delivery" },
  "com.application.zomato": { name: "Zomato", merchantKey: "zomato", category: "food_delivery" },
  "com.grofers.customerapp": { name: "Blinkit", merchantKey: "blinkit", category: "shopping" },
  "com.mercadolibre": { name: "Mercado Libre", merchantKey: "mercadolibre", category: "shopping" },
  "com.mercadolibre.mercadolibre": { name: "Mercado Libre", merchantKey: "mercadolibre", category: "shopping" },
  "com.luizalabs.mlapp": { name: "Magalu", merchantKey: "magalu", category: "shopping" },
  "br.com.brainweb.ifood": { name: "iFood", merchantKey: "ifood", category: "food_delivery" },
  "com.shopee.id": { name: "Shopee", merchantKey: "shopee", category: "shopping" },
  "com.walmart.android": { name: "Walmart", merchantKey: "walmart", category: "shopping" },
  "com.target.ui": { name: "Target", merchantKey: "target", category: "shopping" },
  "com.ebay.mobile": { name: "eBay", merchantKey: "ebay", category: "shopping" },
  "com.einnovation.temu": { name: "Temu", merchantKey: "temu", category: "shopping" },
  "com.zzkko": { name: "SHEIN", merchantKey: "shein", category: "shopping" },
  "com.dd.doordash": { name: "DoorDash", merchantKey: "doordash", category: "food_delivery" },
  "com.ubercab.eats": { name: "Uber Eats", merchantKey: "ubereats", category: "food_delivery" },
  "com.booking": { name: "Booking.com", merchantKey: "booking", category: "travel" },
  "com.makemytrip": { name: "MakeMyTrip", merchantKey: "makemytrip", category: "travel" },
  // Payment apps: named for provenance ("opened by PhonePe"), not merchants.
  "com.phonepe.app": { name: "PhonePe", category: "other" },
  "com.google.android.apps.nbu.paisa.user": { name: "Google Pay", category: "other" },
  "net.one97.paytm": { name: "Paytm", category: "other" },
  "in.org.npci.upiapp": { name: "BHIM", category: "other" },
};

/** Display info for an app id, if it is in the data pack. */
export function knownApp(appId: string | undefined): KnownApp | undefined {
  return appId ? KNOWN_APPS[appId.trim()] : undefined;
}

/** BRAKE taxonomy ids (copied from intelligence/taxonomy) for app categories. */
const CATEGORY_HINT: Readonly<Record<AppActivityCategory, string | undefined>> = {
  shopping: "shopping",
  food_delivery: "eating_out.delivery",
  travel: "travel",
  other: undefined,
};

const EVENTS: ReadonlySet<string> = new Set<AppActivityEvent>(["app_opened", "shield_shown", "shield_bypassed", "shield_respected"]);

export function createAppActivityAdapter(): SignalAdapter<AppActivityPayload> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<AppActivityPayload>, _ctx: AdapterContext): AdapterResult {
      const p = signal.payload;
      if (!p || typeof p !== "object") return { status: "rejected", reason: "payload missing" };
      if (!EVENTS.has(p.event)) return { status: "rejected", reason: `unknown event ${String(p.event)}` };
      if (typeof p.appId !== "string" || p.appId.trim() === "") return { status: "rejected", reason: "appId missing" };
      if (p.platform !== "ios" && p.platform !== "android") return { status: "rejected", reason: "platform must be ios or android" };
      const at = Number.isFinite(p.at) ? p.at : signal.receivedAt;

      const known = knownApp(p.appId);
      const name = (p.appName ? normalizeWhitespace(p.appName) : "") || known?.name;
      const category = p.category ?? known?.category;
      const categoryValue = category ? CATEGORY_HINT[category] : undefined;
      const categoryHints: CategoryHint[] = categoryValue
        ? [{ scheme: "brake", value: categoryValue, confidence: p.category ? 0.7 : 0.6 }]
        : [];
      const merchant: MerchantObservation | undefined =
        known?.merchantKey && name
          ? { raw: name, name, key: known.merchantKey, channel: "online", confidence: 0.6 }
          : undefined;

      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "app_activity",
        connectionId: signal.connectionId,
        ...(name ? { provider: name } : {}),
        label: p.platform === "ios" ? "Screen Time app pause" : "Android app usage access",
      };

      // A respected pause is an abandoned intent; everything else is an open one.
      const stage: TransactionStatus = p.event === "shield_respected" ? "cancelled" : "intent";
      const observation: Observation = {
        id: observationId(ADAPTER_ID, signal.connectionId, `${p.event}|${p.appId}|${at}`),
        source,
        kind: "app_context",
        window: "pre_spend",
        stage,
        receivedAt: signal.receivedAt,
        occurredAt: { value: at, confidence: 0.95 },
        ...(merchant ? { merchant } : {}),
        references: [],
        ...(categoryHints.length > 0 ? { categoryHints } : {}),
        intent: { via: p.event === "app_opened" ? "app_launch" : "shield" },
        // The fact (this app opened / this choice was made) is reliable; purchase likelihood is learned elsewhere.
        confidence: 0.95,
        evidence: { summary: summarize(p.event, name, category) },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

function summarize(event: AppActivityEvent, name: string | undefined, category: AppActivityCategory | undefined): string {
  const kind = category === "food_delivery" ? "food delivery app" : category === "travel" ? "travel app" : category === "shopping" ? "shopping app" : "app";
  const app = name ? `${name} (a ${kind} you asked BRAKE to watch)` : `a ${kind} you asked BRAKE to watch`;
  switch (event) {
    case "app_opened":
      return `You opened ${app}.`;
    case "shield_shown":
      return `BRAKE showed a pause when you opened ${app}.`;
    case "shield_bypassed":
      return `You continued past BRAKE's pause for ${app}.`;
    case "shield_respected":
      return `You closed ${app} at BRAKE's pause.`;
  }
}
