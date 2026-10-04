/**
 * Primitive value types shared by every BRAKE package.
 *
 * Deliberately plain (no branding) so payloads stay JSON-serializable and the
 * same contract can be mirrored by native capture code (Kotlin/Swift) or a
 * server without a TypeScript runtime.
 */

/** Milliseconds since the Unix epoch, UTC. All BRAKE instants use this. */
export type EpochMillis = number;

/** A probability in the closed interval [0, 1]. */
export type Probability = number;

/** ISO 3166-1 alpha-2 country code, upper-case ("IN", "US", "BR"). */
export type CountryCode = string;

/** ISO 4217 currency code, upper-case ("INR", "USD", "EUR"). */
export type CurrencyCode = string;

/** BCP 47 locale tag ("en-IN", "en-US", "pt-BR"). */
export type LocaleTag = string;

export type ObservationId = string;
export type CandidateId = string;
export type ConnectionId = string;

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Clamp a number into [0, 1]. NaN becomes 0. */
export function clamp01(x: number): Probability {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** A value together with how sure the producer is about it. */
export interface Measured<T> {
  readonly value: T;
  /** Probability that `value` is correct. */
  readonly confidence: Probability;
  /** True when the producer knows the value is an estimate (OCR'd price tag, "about ₹850"). */
  readonly approximate?: boolean;
}

/** Injectable time source so every engine is deterministic under test. */
export interface Clock {
  now(): EpochMillis;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(start: EpochMillis): Clock & { advance(ms: number): void; set(t: EpochMillis): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(next: EpochMillis) {
      t = next;
    },
  };
}
