import { isOneTimePasswordMessage, maskTail } from "@brake/core";
import type { AdapterContext, AdapterDescriptor, AdapterResult, RawSignal, SignalAdapter } from "@brake/core";
import { alertObservations, parseAlert, resolvePackage, resolveSender } from "./alerts/engine";
import type { AlertMeta, AlertParseResult, ParsedAlert } from "./alerts/engine";
import { ALERT_PACKS, ALERT_VOCABULARY, GENERIC_PACK, MESSAGING_APPS } from "./alerts/packs";
import type { AlertPack, MessagingApp } from "./alerts/packs";
import { normalizeWhitespace } from "./shared/text";

/**
 * Android NotificationListenerService notifications from bank, card, UPI and
 * wallet apps — and bank SMS/RCS/WhatsApp alerts as rendered by messaging
 * apps — parsed on-device by the shared alert engine (stream 03 §1, stream 07 §7).
 *
 * Privacy gates, in order, before any text is parsed:
 *  1. Package allow-list: only packages of known issuers/apps (`AlertPack.packages`),
 *     messaging apps (`MESSAGING_APPS`) and packages the user explicitly added
 *     (`extraFinancialPackages`). Everything else is `not_financial`, unread.
 *  2. Android 15+ OTP redaction: the "Sensitive notification content hidden"
 *     placeholder means the system detected an OTP → `ignored/otp`. BRAKE keeps
 *     no meta-signal about it (stream 07 §6: even "an OTP arrived" stays out).
 *  3. OTP detection on the composed text.
 *  4. Inside messaging apps, only senders a pack verifies (DLT header, short
 *     code or business display name) are parsed. Conversations with contacts
 *     (a display name no pack knows) are never parsed. A phone-number sender
 *     is checked only for spoofing (a message claiming a known issuer is
 *     `rejected`); otherwise it is treated as a personal message.
 *
 * Sender identity: a notification from an issuer's own package is verified by
 * construction (any app can post look-alike text, so the claimed bank in the
 * text is never trusted — only the package). A messaging app's title is a
 * display name, weaker than an SMS originating address, so its confidence is
 * about 0.05 lower than the SMS adapter's.
 */

export const ANDROID_NOTIFICATION_ADAPTER_ID = "android-notification";

export interface AndroidNotificationPayload {
  readonly packageName: string;
  readonly appLabel?: string;
  /** `android.title` — often the amount line for bank apps, the sender for messaging apps. */
  readonly title?: string;
  /** `android.text` (one line, may be truncated). */
  readonly text?: string;
  /** `android.bigText` (full BigTextStyle body), preferred over `text`. */
  readonly bigText?: string;
  /** `android.subText` (sometimes the account label or masked card). */
  readonly subText?: string;
  /** `StatusBarNotification.getPostTime()`, epoch ms. */
  readonly postedAt: number;
  /** `Notification.category` ("msg", "promo", "status", …). */
  readonly category?: string;
}

export interface AndroidNotificationAdapterOptions {
  readonly packs?: readonly AlertPack[];
  readonly messagingApps?: readonly MessagingApp[];
  /** Packages the user allow-listed that no pack knows (parsed heuristically at reduced confidence). */
  readonly extraFinancialPackages?: readonly string[];
  /** Keep a redacted, 7-day excerpt in evidence (default true). */
  readonly includeExcerpt?: boolean;
}

export const ANDROID_NOTIFICATION_DESCRIPTOR: AdapterDescriptor = {
  id: ANDROID_NOTIFICATION_ADAPTER_ID,
  kind: "notification",
  displayName: "Bank and payment app notifications",
  windows: ["pre_spend", "in_spend", "post_spend"],
  platforms: ["android"],
  requiresCapabilities: ["os:notification-listener"],
  privacy: {
    sensitivity: "high",
    dataCategories: [
      "notifications from allow-listed bank, card, UPI and wallet apps",
      "bank SMS, RCS and WhatsApp alerts shown by messaging apps",
    ],
    processing: "on_device",
  },
};

function clean(s: string | undefined): string {
  return typeof s === "string" ? normalizeWhitespace(s) : "";
}

function isRedactedPlaceholder(text: string): boolean {
  return ALERT_VOCABULARY.redactedPlaceholders.some((p) => new RegExp(p, "i").test(text.trim()));
}

/** Title + body (+ subtext), without a title that only names the app or repeats the body. */
function compose(title: string, body: string, subText: string, appNames: readonly string[]): string {
  const parts: string[] = [];
  const titleIsAppName = appNames.some((n) => n.length > 0 && n.toLowerCase() === title.toLowerCase());
  if (title && !titleIsAppName && !body.toLowerCase().includes(title.toLowerCase())) parts.push(title);
  if (body) parts.push(body);
  if (subText && !parts.some((x) => x.includes(subText))) parts.push(subText);
  return parts.map((x, i) => (i < parts.length - 1 && !/[.;:!?]$/.test(x) ? `${x}.` : x)).join(" ");
}

interface SourceNames {
  readonly label: string;
  readonly provider: string;
  readonly summarySource: string;
}

export function createAndroidNotificationAdapter(opts: AndroidNotificationAdapterOptions = {}): SignalAdapter<AndroidNotificationPayload> {
  const packs = opts.packs ?? ALERT_PACKS;
  const hosts = opts.messagingApps ?? MESSAGING_APPS;
  const extra = new Set(opts.extraFinancialPackages ?? []);

  return {
    descriptor: ANDROID_NOTIFICATION_DESCRIPTOR,
    parse(signal: RawSignal<AndroidNotificationPayload>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload as Partial<AndroidNotificationPayload> | null | undefined;
      if (!p || typeof p.packageName !== "string" || typeof p.postedAt !== "number" || !Number.isFinite(p.postedAt)) {
        return { status: "rejected", reason: "malformed notification payload: packageName and postedAt are required" };
      }
      const pkg = p.packageName.trim();
      const app = resolvePackage(pkg, packs);
      const host = app ? undefined : hosts.find((h) => h.packageName === pkg);
      const allowListed = !app && !host && extra.has(pkg);
      // 1. Allow-list first: nothing else from a non-financial app is read.
      if (!app && !host && !allowListed) return { status: "ignored", reason: "not_financial" };

      const title = clean(p.title);
      const body = clean(p.bigText) || clean(p.text);
      const subText = clean(p.subText);
      // 2. Android 15+ replaced an OTP-bearing notification with a placeholder.
      if (isRedactedPlaceholder(body) || (!body && isRedactedPlaceholder(title))) return { status: "ignored", reason: "otp" };
      if (!title && !body) return { status: "ignored", reason: "not_financial" };
      if (p.category === "promo") return { status: "ignored", reason: "promotional" };

      const composed = host ? body : compose(title, body, subText, [clean(p.appLabel), app?.displayName ?? ""]);
      // 3. OTPs dropped before parsing.
      if (isOneTimePasswordMessage(composed) || isOneTimePasswordMessage(`${title} ${body}`)) {
        return { status: "ignored", reason: "otp" };
      }

      let result: AlertParseResult;
      let names: (parsed: ParsedAlert) => SourceNames;
      const base: Omit<AlertMeta, "senderOrApp"> = { receivedAt: p.postedAt, ctx, packs };
      if (app) {
        result = parseAlert(composed, { ...base, senderOrApp: pkg, pack: app, verification: "package" });
        names = () => ({ label: `${app.displayName} notification`, provider: app.displayName, summarySource: `${app.displayName} notification` });
      } else if (host) {
        // 4. Inside messaging apps: never parse conversations with contacts.
        const resolution = resolveSender(title, packs, "display");
        const sender = resolution.sender;
        const personal = resolution.pack.kind === "generic" && (sender.kind === "phone" || sender.kind === "display" || sender.kind === "empty");
        if (personal && sender.kind !== "phone") return { status: "ignored", reason: "not_financial" };
        result = parseAlert(composed, { ...base, senderOrApp: title, senderKind: "display" });
        // A phone number is parsed only to catch spoofed issuer alerts; anything else from it is personal.
        if (personal && "event" in result) return { status: "ignored", reason: "not_financial" };
        names = (parsed) => {
          if (parsed.pack.kind !== "generic") {
            const n = parsed.pack.displayName;
            return { label: `${n} ${host.channelNoun} via ${host.displayName}`, provider: n, summarySource: `${n} ${host.channelNoun}` };
          }
          const who = sender.kind === "phone" ? maskTail(sender.entity) : sender.raw;
          return { label: `${host.displayName} message from ${who}`, provider: who, summarySource: `${host.displayName} message from ${who}` };
        };
      } else {
        const appName = clean(p.appLabel) || pkg;
        result = parseAlert(composed, { ...base, senderOrApp: pkg, pack: GENERIC_PACK, verification: "package" });
        names = () => ({ label: `${appName} notification`, provider: appName, summarySource: `${appName} notification` });
      }

      if ("ignored" in result) return { status: "ignored", reason: result.ignored };
      if ("rejected" in result) return { status: "rejected", reason: result.rejected };

      return {
        status: "observations",
        observations: alertObservations(result, {
          adapterId: ANDROID_NOTIFICATION_ADAPTER_ID,
          sourceKind: "notification",
          connectionId: signal.connectionId,
          receivedAt: signal.receivedAt,
          ...names(result),
          channelKey: `pkg:${pkg}`,
          ...(ctx.locale ? { locale: ctx.locale } : {}),
          includeExcerpt: opts.includeExcerpt ?? true,
        }),
      };
    },
  };
}
