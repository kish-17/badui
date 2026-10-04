import { isOneTimePasswordMessage } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CategoryHint,
  EpochMillis,
  Observation,
  RawSignal,
  SignalAdapter,
  SourceRef,
} from "@brake/core";
import { decodeEmvQr, emvObservation, looksLikeEmvQr, resolveProfile } from "./emv-qr";
import { observationId } from "./shared/text";
import { describeProductLink } from "./share";
import { decodeUpiUri, upiObservation } from "./upi";
import type { PaymentSurface } from "./upi";

/**
 * BRAKE's own QR scanner: classify the decoded string, then hand it to the
 * right parser. "Scan with BRAKE, then pay in your usual app" is the only
 * rail-level signal that reliably arrives before authorisation on both
 * Android and iOS (docs/research/05-payment-rails-and-qr.md takeaway 1,
 * docs/research/08-manual-and-pre-spend-surfaces.md §12).
 *
 *   upi://pay…             -> checkout (in-spend) when the QR fixes an amount, else purchase intent (pre-spend)
 *   upi://mandate…         -> mandate (pre-spend AutoPay sign-up)
 *   000201… (EMV MPM)      -> same rule; scheme, merchant, MCC and amount from the TLV
 *   http(s) product link   -> purchase intent (pre-spend, via "qr")
 *   anything else          -> ignored (Wi-Fi, menus, tickets, plain text)
 *
 * The raw string is never kept: VPAs and Pix keys can identify people.
 */

export interface QrScanPayload {
  /** The decoded QR text (platform scanner output). */
  readonly text: string;
  readonly scannedAt?: EpochMillis;
}

const ADAPTER_ID = "qr";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "qr_scan",
  displayName: "QR scanner",
  windows: ["pre_spend", "in_spend"],
  platforms: ["android", "ios"],
  // Works wherever a camera does; how useful it is depends on the country's QR rails (registry).
  requiresCapabilities: [],
  privacy: {
    sensitivity: "medium",
    dataCategories: ["QR codes you scan with BRAKE (payee, amount, product links)"],
    processing: "on_device",
  },
};

export function createQrAdapter(): SignalAdapter<QrScanPayload> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<QrScanPayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload;
      if (!p || typeof p.text !== "string") return { status: "rejected", reason: "payload.text missing" };
      const text = p.text.trim();
      if (text === "") return { status: "ignored", reason: "not_financial" };
      if (isOneTimePasswordMessage(text)) return { status: "ignored", reason: "otp" };
      const at = typeof p.scannedAt === "number" && Number.isFinite(p.scannedAt) ? p.scannedAt : signal.receivedAt;
      const surface = (lead: string, provider: string | undefined): PaymentSurface => ({
        source: source(signal.connectionId, provider),
        receivedAt: signal.receivedAt,
        at,
        atConfidence: p.scannedAt !== undefined ? 0.95 : 0.9,
        naturalKey: `${at}|${text}`,
        channel: "in_store",
        via: "qr",
        mode: "by_amount",
        summaryLead: lead,
        ...(ctx.locale ? { locale: ctx.locale } : {}),
      });

      const upi = decodeUpiUri(text);
      if (upi.ok) return one(upiObservation(upi.request, surface("You scanned a UPI QR code", "UPI")));
      if (upi.error !== "not_upi") return { status: "rejected", reason: `invalid UPI QR: ${upi.error}` };

      if (looksLikeEmvQr(text)) {
        const emv = decodeEmvQr(text);
        if (!emv.ok) return { status: "rejected", reason: `invalid EMV QR: ${emv.error}` };
        const { profile } = resolveProfile(emv.payload);
        return one(emvObservation(emv.payload, surface("You scanned a QR code", profile.scheme === "unknown" ? undefined : profile.displayName)));
      }

      const link = describeProductLink(text);
      if (link && (link.productPage || link.productId)) return one(productIntent(signal, link, at, p.scannedAt !== undefined));
      return { status: "ignored", reason: "not_financial" };
    },
  };
}

function source(connectionId: string, provider: string | undefined): SourceRef {
  return { adapterId: ADAPTER_ID, kind: "qr_scan", connectionId, ...(provider ? { provider } : {}), label: "BRAKE QR scan" };
}

function one(o: Observation): AdapterResult {
  return { status: "observations", observations: [o] };
}

/** A product page or GS1 Digital Link scanned from a poster, shelf or package. */
function productIntent(
  signal: RawSignal<QrScanPayload>,
  link: NonNullable<ReturnType<typeof describeProductLink>>,
  at: EpochMillis,
  exactTime: boolean,
): Observation {
  const categoryHints: CategoryHint[] =
    link.merchant?.category && link.merchantKnown ? [{ scheme: "brake", value: link.merchant.category, confidence: 0.5 }] : [];
  const what = link.merchant ? `a ${link.merchant.name} product page` : link.productId?.startsWith("gtin:") ? "a product barcode link" : "a product page";
  return {
    id: observationId(ADAPTER_ID, signal.connectionId, `${at}|${link.url}|${link.productId ?? ""}`),
    source: source(signal.connectionId, link.merchant?.name),
    kind: "purchase_intent",
    window: "pre_spend",
    stage: "intent",
    receivedAt: signal.receivedAt,
    occurredAt: { value: at, confidence: exactTime ? 0.95 : 0.9 },
    direction: "debit",
    ...(link.merchant
      ? {
          merchant: {
            raw: link.domain,
            name: link.merchant.name,
            key: link.merchant.key,
            website: link.domain,
            channel: "online" as const,
            confidence: link.merchantKnown ? 0.9 : 0.6,
          },
        }
      : {}),
    references: [],
    ...(categoryHints.length > 0 ? { categoryHints } : {}),
    intent: {
      via: "qr",
      url: link.url,
      ...(link.slugTitle ? { title: link.slugTitle } : {}),
      ...(link.productId ? { productId: link.productId } : {}),
    },
    confidence: link.merchantKnown ? 0.8 : 0.7,
    evidence: { summary: `You scanned a QR code linking to ${what} (${link.domain}).` },
  };
}
