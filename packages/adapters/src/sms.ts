import { isOneTimePasswordMessage, maskTail } from "@brake/core";
import type { AdapterContext, AdapterDescriptor, AdapterResult, RawSignal, SignalAdapter } from "@brake/core";
import { alertObservations, parseAlert } from "./alerts/engine";
import type { ParsedAlert, SenderInfo } from "./alerts/engine";
import { ALERT_PACKS } from "./alerts/packs";
import type { AlertPack } from "./alerts/packs";

/**
 * SMS transaction alerts (bank, card, UPI, mobile money) captured on Android
 * through the SMS permission (broadcast or inbox backfill), parsed on-device
 * by the shared alert engine.
 *
 * The payload is what `SmsMessage`/`Telephony.Sms` expose: the originating
 * address (DLT header, short code, alphanumeric id or phone number), the body
 * (multipart messages concatenated by the capture layer) and the message
 * timestamp. Re-delivery of the same SMS (live broadcast plus a provider
 * rescan with a different timestamp) yields the same observation ids because
 * the natural key is the event reference or a hash of the body — never the
 * timestamp (stream 07 §2).
 *
 * `simSlot` is accepted for the capture contract but deliberately unused: the
 * SIM a message arrived on says nothing reliable about which account moved.
 */

export const SMS_ADAPTER_ID = "sms";

export interface SmsPayload {
  /** Originating address exactly as received ("AX-HDFCBK-S", "24273", "MPESA", "+919812345678"). */
  readonly sender: string;
  readonly body: string;
  /** Message timestamp (service-centre or provider `date`), epoch ms. Defaults to the signal's receivedAt. */
  readonly receivedAt?: number;
  readonly simSlot?: number;
}

export interface SmsAdapterOptions {
  /** Alert packs to verify senders against; defaults to the built-in ALERT_PACKS. */
  readonly packs?: readonly AlertPack[];
  /** Keep a redacted, 7-day excerpt in evidence (default true). */
  readonly includeExcerpt?: boolean;
}

export const SMS_DESCRIPTOR: AdapterDescriptor = {
  id: SMS_ADAPTER_ID,
  kind: "sms",
  displayName: "Bank and payment SMS alerts",
  // Pre-debit (AutoPay/e-mandate) notices arrive before money moves, so SMS also feeds pre-spend.
  windows: ["pre_spend", "in_spend", "post_spend"],
  platforms: ["android"],
  requiresCapabilities: ["os:sms-read"],
  privacy: {
    sensitivity: "very_high",
    dataCategories: [
      "transaction SMS from bank, card, UPI and mobile-money senders",
      "balances and payees stated in those messages",
    ],
    processing: "on_device",
  },
};

/** How a sender is named in provenance; personal numbers are masked. */
function senderLabel(sender: SenderInfo, raw: string): string {
  if (sender.kind === "phone") return maskTail(sender.entity);
  return sender.raw || raw.trim() || "an unknown sender";
}

function sourceFor(parsed: ParsedAlert, raw: string) {
  if (parsed.pack.kind !== "generic") {
    const name = parsed.pack.displayName;
    return { label: `${name} SMS alert`, provider: name, summarySource: `${name} SMS` };
  }
  const who = senderLabel(parsed.sender, raw);
  return { label: `SMS from ${who}`, provider: who, summarySource: `SMS from ${who}` };
}

export function createSmsAdapter(opts: SmsAdapterOptions = {}): SignalAdapter<SmsPayload> {
  const packs = opts.packs ?? ALERT_PACKS;
  return {
    descriptor: SMS_DESCRIPTOR,
    parse(signal: RawSignal<SmsPayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload as Partial<SmsPayload> | null | undefined;
      if (!p || typeof p.body !== "string" || typeof p.sender !== "string") {
        return { status: "rejected", reason: "malformed SMS payload: sender and body must be strings" };
      }
      // OTPs are dropped before any other code reads the body.
      if (isOneTimePasswordMessage(p.body)) return { status: "ignored", reason: "otp" };

      const at = typeof p.receivedAt === "number" && Number.isFinite(p.receivedAt) ? p.receivedAt : signal.receivedAt;
      const result = parseAlert(p.body, { senderOrApp: p.sender, receivedAt: at, ctx, packs, senderKind: "sms" });
      if ("ignored" in result) return { status: "ignored", reason: result.ignored };
      if ("rejected" in result) return { status: "rejected", reason: result.rejected };

      return {
        status: "observations",
        observations: alertObservations(result, {
          adapterId: SMS_ADAPTER_ID,
          sourceKind: "sms",
          connectionId: signal.connectionId,
          receivedAt: signal.receivedAt,
          ...sourceFor(result, p.sender),
          channelKey: "sms",
          ...(ctx.locale ? { locale: ctx.locale } : {}),
          includeExcerpt: opts.includeExcerpt ?? true,
        }),
      };
    },
  };
}
