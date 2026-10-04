import type {
  CountryCode,
  CurrencyCode,
  LocaleTag,
  Platform,
  PrivacySensitivity,
  SignalSourceKind,
  SpendWindow,
} from "@brake/core";

/**
 * Capability ids are namespaced kebab-case strings:
 *   rail:upi, rail:pix, rail:card
 *   data:open-banking-ais, data:account-aggregator, data:plaid, data:financekit
 *   alerts:sms-bank-alerts, alerts:push-bank-alerts
 *   os:notification-listener, os:sms-read, os:wallet-transaction-automation, os:screen-time-shield
 *   ext:browser-extension, email:gmail-api, email:graph-mail
 * Product code checks capabilities, never country or OS names.
 */
export type CapabilityId = string;

export type Availability = "available" | "limited" | "emerging" | "unavailable" | "unknown";

export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly name: string;
  /** Who decides availability: the market, the OS, the user's accounts, or a runtime permission grant. */
  readonly scope: "country" | "platform" | "account" | "permission";
  readonly description: string;
}

export interface CapabilityStatus {
  readonly status: Availability;
  readonly note?: string;
  /** Date the fact was last verified (YYYY-MM-DD). Registry facts decay; stale ones are reported by `auditRegistry`. */
  readonly asOf: string;
  readonly citations?: readonly string[];
}

export interface CountryProfile {
  readonly country: CountryCode;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly defaultLocale: LocaleTag;
  /** Most-used payment schemes, most dominant first ("upi", "card", "cash"). */
  readonly dominantRails: readonly string[];
  readonly capabilities: Readonly<Record<CapabilityId, CapabilityStatus>>;
}

export interface PlatformProfile {
  readonly platform: Platform;
  readonly capabilities: Readonly<Record<CapabilityId, CapabilityStatus>>;
  /** Presentation limits of this platform's quick-action surfaces. */
  readonly surface: { readonly maxQuickActions: number; readonly supportsTextInput: boolean };
}

/** Boolean expression over capability ids. */
export type CapabilityExpr =
  | { readonly cap: CapabilityId }
  | { readonly all: readonly CapabilityExpr[] }
  | { readonly any: readonly CapabilityExpr[] }
  | { readonly not: CapabilityExpr };

export type SourceMaturity = "mvp" | "next" | "later" | "avoid" | "research";

export type SourceProvides =
  | "amount"
  | "merchant"
  | "line_items"
  | "realtime"
  | "pending"
  | "posted"
  | "balance"
  | "recurring"
  | "intent"
  | "subscription"
  | "references";

export interface SourceDefinition {
  /** Matches the adapter id when an adapter exists ("sms", "android-notification", "plaid"). */
  readonly id: string;
  readonly kind: SignalSourceKind;
  readonly name: string;
  readonly windows: readonly SpendWindow[];
  /** Capabilities that must hold for the source to be offered to a user. */
  readonly requires: CapabilityExpr;
  readonly typicalLatency: string;
  /** How much this source alone contributes to awareness in each window (0..1). */
  readonly strength: Readonly<Partial<Record<SpendWindow, number>>>;
  readonly provides: readonly SourceProvides[];
  readonly privacy: PrivacySensitivity;
  readonly reliability: "low" | "medium" | "high";
  readonly maturity: SourceMaturity;
  /** Implemented adapter id, if any. */
  readonly adapterId?: string;
  /** Research document backing this entry. */
  readonly doc?: string;
  readonly notes?: string;
}

export type FeatureId = string;

export interface FeatureDefinition {
  readonly id: FeatureId;
  readonly name: string;
  readonly window: SpendWindow | "always";
  readonly description: string;
  /**
   * Full mode needs any one of these source sets (each set is all-of).
   * Empty array = always available (manual-only features).
   */
  readonly fullWith: ReadonlyArray<readonly string[]>;
  /** Degraded mode needs any one of these sets; omitted = no degraded mode. */
  readonly degradedWith?: ReadonlyArray<readonly string[]>;
  readonly degradedDescription?: string;
}

export interface Registry {
  readonly version: string;
  readonly capabilities: readonly CapabilityDefinition[];
  readonly countries: readonly CountryProfile[];
  readonly platforms: readonly PlatformProfile[];
  readonly sources: readonly SourceDefinition[];
  readonly features: readonly FeatureDefinition[];
}

export interface UserCapabilityContext {
  readonly country: CountryCode;
  readonly platforms: readonly Platform[];
  /** Source ids the user has connected and not paused. */
  readonly connectedSources: readonly string[];
  /** Runtime grants the user has given (os:notification-listener …) or account facts (data:has-credit-card). */
  readonly grantedCapabilities?: readonly CapabilityId[];
}

export type SourceState = "connected" | "available" | "unavailable";

export interface SourceAvailability {
  readonly source: SourceDefinition;
  readonly state: SourceState;
  /** Capabilities that are missing/unavailable, when state = unavailable. */
  readonly blockedBy: readonly CapabilityId[];
}

export type CoverageLevel = "strong" | "partial" | "weak" | "none";

export interface WindowCoverage {
  /** 1 - Π(1 - strength_i) over connected sources: independent signals compound. */
  readonly score: number;
  readonly level: CoverageLevel;
  readonly contributors: readonly string[];
}

export interface FeatureAvailability {
  readonly feature: FeatureDefinition;
  readonly mode: "full" | "degraded" | "unavailable";
  /** Smallest set of additional sources that would unlock full mode. */
  readonly unlockWith?: readonly string[];
}

export interface SourceSuggestion {
  readonly sourceId: string;
  /** Total coverage gain across windows if connected (sum of per-window deltas). */
  readonly marginalGain: number;
  readonly windowGains: Readonly<Partial<Record<SpendWindow, number>>>;
  readonly unlocksFeatures: readonly FeatureId[];
  /** Penalised by privacy sensitivity so BRAKE suggests the least invasive useful source first. */
  readonly score: number;
}

export interface CapabilityProfile {
  readonly context: UserCapabilityContext;
  readonly sources: readonly SourceAvailability[];
  readonly windows: Readonly<Record<SpendWindow, WindowCoverage>>;
  readonly features: readonly FeatureAvailability[];
  readonly suggestions: readonly SourceSuggestion[];
  /** Quick-action limits of the user's primary platform. */
  readonly surface: { readonly maxQuickActions: number; readonly supportsTextInput: boolean };
}
