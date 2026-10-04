import type { Observation } from "./model/observation";
import type { Clock, ConnectionId, CountryCode, CurrencyCode, EpochMillis, LocaleTag } from "./model/primitives";
import type { Platform, SignalSourceKind, SpendWindow } from "./model/source";

/**
 * The envelope a capture surface hands to an adapter. Capture code is
 * platform-native (Kotlin NotificationListenerService, a Swift App Intent fed
 * by a Wallet automation, a Gmail fetcher, a Plaid webhook handler); the
 * envelope is the JSON boundary between that code and BRAKE's core.
 *
 * Raw payloads are transient: adapters parse them into observations and core
 * never persists `payload`.
 */
export interface RawSignal<P = unknown> {
  readonly adapterId: string;
  readonly connectionId: ConnectionId;
  readonly receivedAt: EpochMillis;
  readonly payload: P;
}

export interface AdapterContext {
  readonly clock: Clock;
  /** Hints about the user — used to resolve ambiguity (currency symbols, date order), never as hard branches. */
  readonly country?: CountryCode;
  readonly locale?: LocaleTag;
  readonly defaultCurrency?: CurrencyCode;
  /** IANA zone used to interpret local wall-clock times in alerts ("04-10-26 10:41"). */
  readonly timeZone?: string;
}

export type IgnoreReason =
  | "not_financial" // ordinary message/notification
  | "otp" // one-time password — dropped immediately, never stored
  | "promotional" // marketing, offers, "pre-approved loan"
  | "unsupported_format" // financial-looking but no parser understood it
  | "duplicate_delivery" // the same raw signal delivered twice
  | "source_disabled";

export type AdapterResult =
  | { readonly status: "observations"; readonly observations: readonly Observation[] }
  | { readonly status: "ignored"; readonly reason: IgnoreReason }
  | { readonly status: "rejected"; readonly reason: string };

export type PrivacySensitivity = "low" | "medium" | "high" | "very_high";

export interface AdapterDescriptor {
  /** Stable id, also used as `SourceRef.adapterId` ("sms", "android-notification", "plaid"). */
  readonly id: string;
  readonly kind: SignalSourceKind;
  readonly displayName: string;
  /** Windows this adapter can contribute to. */
  readonly windows: readonly SpendWindow[];
  readonly platforms: readonly Platform[];
  /** Capability ids from the capability registry that must hold for this adapter to be offered. */
  readonly requiresCapabilities: readonly string[];
  readonly privacy: {
    readonly sensitivity: PrivacySensitivity;
    /** Plain-language data categories, shown in consent UI ("bank SMS text", "order emails from allow-listed senders"). */
    readonly dataCategories: readonly string[];
    /** Where parsing is designed to run. */
    readonly processing: "on_device" | "server" | "either";
  };
}

/**
 * A pure, deterministic translation from one source's payload into
 * normalized observations. Adapters do no I/O, hold no credentials and never
 * return raw payload text beyond a redacted, expiring excerpt.
 */
export interface SignalAdapter<P = unknown> {
  readonly descriptor: AdapterDescriptor;
  parse(signal: RawSignal<P>, ctx: AdapterContext): AdapterResult;
}
