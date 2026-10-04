import type { EpochMillis } from "../model/primitives";

/** Calendar/wall-clock helpers. Time zones are IANA names; DST is handled by Intl. */

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Convert a wall-clock time in an IANA zone to epoch millis (DST-aware via Intl). */
export function zonedTimeToEpoch(t: WallClock, timeZone: string): EpochMillis {
  const asUtc = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  let guess = asUtc - offsetMs(asUtc, timeZone);
  // Second pass corrects guesses that crossed a DST boundary.
  guess = asUtc - offsetMs(guess, timeZone);
  return guess;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetMs(epoch: EpochMillis, timeZone: string): number {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epoch)).map((p) => [p.type, p.value]));
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return local - (epoch - (epoch % 1000));
}

export interface LocalParts extends WallClock {
  /** 0 = Monday … 6 = Sunday. */
  readonly weekday: number;
}

/** Wall-clock parts of an instant in a zone. */
export function localParts(epoch: EpochMillis, timeZone: string): LocalParts {
  const local = epoch + offsetMs(epoch, timeZone);
  const d = new Date(local);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: (d.getUTCDay() + 6) % 7,
  };
}

/** Local midnight that starts the day containing `epoch`. */
export function startOfLocalDay(epoch: EpochMillis, timeZone: string): EpochMillis {
  const p = localParts(epoch, timeZone);
  return zonedTimeToEpoch({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Local Monday 00:00 that starts the week containing `epoch`. */
export function startOfLocalWeek(epoch: EpochMillis, timeZone: string): EpochMillis {
  const p = localParts(epoch, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - p.weekday));
  return zonedTimeToEpoch({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Local first-of-month 00:00 for the month containing `epoch`. */
export function startOfLocalMonth(epoch: EpochMillis, timeZone: string): EpochMillis {
  const p = localParts(epoch, timeZone);
  return zonedTimeToEpoch({ year: p.year, month: p.month, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
}
