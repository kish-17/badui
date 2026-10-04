import type {
  BrakeExport,
  Budget,
  ConsentEvent,
  EpochMillis,
  Evidence,
  Goal,
  Observation,
  ObservationId,
  PromptLogEntry,
  SourceConnection,
  StoredInstrument,
  UserAssertion,
  UserRule,
  UserSettings,
} from "@brake/core";
import type { Json, Tables, TablesInsert } from "./database.types";

/**
 * Pure mappers between BRAKE's JSON contract and database rows.
 *
 * Conventions:
 *  - Instants are epoch milliseconds in BRAKE and ISO 8601 `timestamptz` in
 *    Postgres. Postgres keeps microseconds, so millisecond values round-trip.
 *  - Optional BRAKE fields are SQL NULL and are *omitted* (not `undefined`)
 *    when read back, so a read equals what was written.
 *  - An observation is stored as `facts` (the whole observation minus its
 *    evidence excerpt) plus indexed columns derived from it for filtering.
 *    `facts` is what is read back; the columns never have to round-trip.
 *  - The redacted evidence excerpt lives in its own nullable, expiring column
 *    so retention can null it without rewriting `facts`, and it is merged back
 *    only while unexpired at read time (by the caller's injected clock).
 *
 * The few semantic helpers here (budget ids, cursors, page sizes, excerpt
 * capping) deliberately mirror `@brake/core`'s memory store; the shared store
 * contract suite keeps the two implementations in step.
 */

/* ------------------------------------------------------------------ */
/* Time.                                                               */
/* ------------------------------------------------------------------ */

/**
 * The instants a store accepts (same bounds as the memory store): whole
 * milliseconds from 0001-01-01 UTC to JavaScript's last date, +275760-09-13,
 * which `timestamptz` (up to year 294276) can hold. Earlier years would need
 * Postgres's "BC" syntax and are refused.
 */
export const MIN_INSTANT = -62_135_596_800_000;
export const MAX_INSTANT = 8_640_000_000_000_000;

/**
 * Epoch millis -> ISO 8601 UTC that Postgres accepts. Refuses fractional
 * milliseconds rather than truncating them: the observation document would
 * keep the fraction while the indexed column did not, and the keyset cursor
 * (built from the document) could then never be decoded or would replay rows.
 * Years past 9999 are written without JavaScript's "+" year sign, which
 * Postgres would misread as a time-zone displacement. The message never
 * echoes the value.
 */
export function toTimestamptz(ms: EpochMillis): string {
  if (!Number.isInteger(ms) || ms < MIN_INSTANT || ms > MAX_INSTANT) {
    throw new RangeError("Instants must be whole epoch milliseconds between year 1 and 275760");
  }
  return new Date(ms).toISOString().replace(/^\+/, "");
}

/**
 * A query bound (`since`, `until`) as a timestamptz filter value. Bounds are
 * not data, so they get the memory store's numeric semantics rather than
 * being refused: ±Infinity and instants past either end of the storable range
 * become Postgres's '-infinity' / 'infinity', and a fractional bound is rounded
 * up — over whole-millisecond instants `t >= 1.5` is `t >= 2` and `t < 1.5` is
 * `t < 2`. NaN is a programming error, as in the memory store.
 */
export function toTimestamptzBound(ms: EpochMillis): string {
  if (typeof ms !== "number" || Number.isNaN(ms)) throw new RangeError("A time bound must be a number");
  if (ms < MIN_INSTANT) return "-infinity";
  if (ms > MAX_INSTANT) return "infinity";
  return toTimestamptz(Math.ceil(ms));
}

const TIMESTAMPTZ =
  /^([+-]?\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)?( BC)?$/i;

/**
 * Parse a timestamptz as PostgREST (or `to_jsonb`) prints it, e.g.
 * "2026-10-04T05:11:00.123+00:00" or "2026-10-04 10:41:00+05:30", in any
 * database time zone: historical offsets carry seconds ("-03:30:52"), and an
 * instant whose *local* date falls before year 1 is printed with " BC" (year
 * 1 BC is astronomical year 0) — reachable for 0001-01-01 UTC whenever the
 * database time zone is west of Greenwich. Parsed by hand rather than with
 * `Date.parse`, whose acceptance of offsets and microsecond fractions differs
 * between JavaScript engines (Hermes vs V8). Sub-millisecond digits are truncated.
 */
export function fromTimestamptz(value: string): EpochMillis {
  const m = TIMESTAMPTZ.exec(value.trim());
  if (!m) throw new RangeError("Unrecognised timestamptz");
  const [, y, mo, d, h, mi, s, frac, zone, bc] = m;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  const year = bc ? 1 - Number(y) : Number(y);
  // Not Date.UTC(year, …): it maps years 0–99 to 1900–1999.
  const date = new Date(0);
  date.setUTCFullYear(year, Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi), Number(s), ms);
  return date.getTime() - zoneOffsetMs(zone);
}

function zoneOffsetMs(zone: string | undefined): number {
  if (zone === undefined || zone.toUpperCase() === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(/:/g, "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4) || "0");
  const seconds = Number(digits.slice(4, 6) || "0");
  return sign * ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

function toNullableTimestamptz(ms: EpochMillis | undefined): string | null {
  return ms === undefined ? null : toTimestamptz(ms);
}

/* ------------------------------------------------------------------ */
/* Semantics shared with the memory store.                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 1000;

/** Persistence id of a budget: its own id, else the natural key (category, period, currency). */
export function budgetId(b: Budget): string {
  return b.id ?? `${b.category ?? "all"}:${b.period}:${b.limit.currency}`;
}

/** Default 500, clamped to 1000, and anything but a positive integer is a programming error. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** Keyset cursor for (receivedAt, id) ordering; opaque to callers. */
export function encodeCursor(receivedAt: EpochMillis, id: ObservationId): string {
  return `${receivedAt}:${id}`;
}

/** The id may be empty (Postgres allows '' as a key), so only the instant is required. */
export function decodeCursor(cursor: string): { readonly receivedAt: EpochMillis; readonly id: ObservationId } {
  const m = /^(-?\d+):([\s\S]*)$/.exec(cursor);
  if (!m) throw new RangeError("Invalid observation cursor");
  return { receivedAt: Number(m[1]), id: m[2]! };
}

/**
 * Text order by Unicode code point (= UTF-8 byte order), the order Postgres
 * uses under the "C" / "C.UTF-8" collations and the memory store uses.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    if (x > 0xffff) i += 1;
  }
  return a.length - b.length;
}

/** Lone UTF-16 surrogates and U+0000: Postgres refuses both (22P02 / 22P05, or PGRST102 for a whole body). */
const UNSTORABLE_TEXT = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/;

/**
 * True when any string or object key in a row is text Postgres cannot store.
 * Checked before sending so the failure is the same 22P05 the memory store
 * reports (instead of three different server errors), and so one bad string
 * fails before a multi-batch write has committed anything.
 */
export function containsUnstorableText(value: unknown): boolean {
  if (typeof value === "string") return UNSTORABLE_TEXT.test(value);
  if (Array.isArray(value)) return value.some(containsUnstorableText);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => UNSTORABLE_TEXT.test(k) || containsUnstorableText(v));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

/** Plain-JSON copy: drops `undefined` fields exactly as the wire would. */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * A bigint column value. JSON can carry integers beyond 2^53, but this side
 * cannot read them back exactly, and a fraction would come back from Postgres
 * as a 22P02 that quotes the value; the memory store refuses both (23514).
 */
function bigintColumn(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError("Amounts and durations must be safe integers");
  return n;
}

/** A smallint column value: out-of-range or fractional input would be a value-quoting 22003/22P02. */
function smallintColumn(n: number): number {
  if (!Number.isInteger(n) || n < -32_768 || n > 32_767) throw new RangeError("Expected a small integer");
  return n;
}

/**
 * The `confidence real` column (an index projection; `facts` keeps the exact
 * value). Validated like the memory store, because Postgres would silently
 * round 1 + ε into range; a probability too small for float4 is sent as 0,
 * because `real` input raises 22003 on underflow instead of rounding.
 */
function confidenceColumn(c: number): number {
  if (typeof c !== "number" || !(c >= 0 && c <= 1)) throw new RangeError("confidence must be within [0, 1]");
  return Math.fround(c) === 0 ? 0 : c;
}

function fromJson<T>(value: Json): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object column");
  }
  return value as unknown as T;
}

/** Postgres bigint may arrive as a JSON number or, from some serializers, as a string. */
function int(value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError("Integer column outside the safe range");
  return n;
}

/** Spread helper: `{ ...opt("provider", row.provider) }` adds the key only when the column is not NULL. */
function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/* ------------------------------------------------------------------ */
/* Consent.                                                            */
/* ------------------------------------------------------------------ */

export function connectionToRow(c: SourceConnection, userId: string): TablesInsert<"source_connections"> {
  return {
    user_id: userId,
    connection_id: c.connectionId,
    adapter_id: c.adapterId,
    kind: c.kind,
    label: c.label,
    provider: c.provider ?? null,
    status: c.status,
    scopes: [...c.scopes],
    purposes: [...c.purposes],
    excerpt_ttl_ms: bigintColumn(c.retention.excerptTtlMs),
    observation_ttl_ms: c.retention.observationTtlMs === null ? null : bigintColumn(c.retention.observationTtlMs),
    granted_at: toTimestamptz(c.grantedAt),
    updated_at: toTimestamptz(c.updatedAt),
    revoked_at: toNullableTimestamptz(c.revokedAt),
  };
}

export function connectionFromRow(r: Tables<"source_connections">): SourceConnection {
  return {
    connectionId: r.connection_id,
    adapterId: r.adapter_id,
    kind: r.kind,
    label: r.label,
    ...opt("provider", r.provider),
    status: r.status,
    scopes: [...r.scopes],
    purposes: [...r.purposes],
    retention: {
      excerptTtlMs: int(r.excerpt_ttl_ms),
      observationTtlMs: r.observation_ttl_ms === null ? null : int(r.observation_ttl_ms),
    },
    grantedAt: fromTimestamptz(r.granted_at),
    updatedAt: fromTimestamptz(r.updated_at),
    ...opt("revokedAt", r.revoked_at === null ? null : fromTimestamptz(r.revoked_at)),
  };
}

export function consentEventToRow(e: ConsentEvent, userId: string): TablesInsert<"consent_events"> {
  return {
    user_id: userId,
    connection_id: e.connectionId,
    action: e.action,
    at: toTimestamptz(e.at),
    scopes: [...e.scopes],
    purposes: [...e.purposes],
  };
}

export function consentEventFromRow(r: Pick<Tables<"consent_events">, "connection_id" | "action" | "at" | "scopes" | "purposes">): ConsentEvent {
  return {
    connectionId: r.connection_id,
    action: r.action,
    at: fromTimestamptz(r.at),
    scopes: [...r.scopes],
    purposes: [...r.purposes],
  };
}

/* ------------------------------------------------------------------ */
/* Observations.                                                       */
/* ------------------------------------------------------------------ */

export interface ObservationWriteContext {
  /** The store clock's current instant: an excerpt already expired by then is not written at all. */
  readonly now: EpochMillis;
  /** The connection's `retention.excerptTtlMs`; caps the excerpt's life (0 keeps no excerpt). */
  readonly excerptTtlMs: number;
}

/**
 * The excerpt that may be persisted, with its effective expiry: the stricter
 * of the adapter's own expiry and the connection's excerpt TTL counted from
 * `receivedAt` (as `isExcerptExpired` judges it), rounded down to a whole
 * millisecond and never past MAX_INSTANT (so a "keep as long as possible" TTL
 * such as Number.MAX_SAFE_INTEGER still yields a storable expiry). Null when
 * nothing may be kept.
 */
export function storableExcerpt(
  o: Observation,
  ctx: ObservationWriteContext,
): { readonly excerpt: string; readonly expiresAt: EpochMillis } | null {
  const { excerpt, excerptExpiresAt } = o.evidence;
  if (excerpt === undefined || !(ctx.excerptTtlMs > 0)) return null;
  const cap = o.receivedAt + ctx.excerptTtlMs;
  const expiresAt = Math.floor(Math.min(excerptExpiresAt === undefined ? cap : excerptExpiresAt, cap, MAX_INSTANT));
  return expiresAt > ctx.now ? { excerpt, expiresAt } : null;
}

/** The observation without its excerpt fields: exactly what goes into `facts`. */
export function observationFacts(o: Observation): Json {
  const { excerpt: _excerpt, excerptExpiresAt: _expires, ...evidence } = o.evidence;
  return toJson({ ...o, evidence });
}

export function observationToRow(o: Observation, userId: string, ctx: ObservationWriteContext): TablesInsert<"observations"> {
  const kept = storableExcerpt(o, ctx);
  return {
    user_id: userId,
    id: o.id,
    connection_id: o.source.connectionId,
    adapter_id: o.source.adapterId,
    source_kind: o.source.kind,
    kind: o.kind,
    spend_window: o.window,
    stage: o.stage,
    received_at: toTimestamptz(o.receivedAt),
    occurred_at: toNullableTimestamptz(o.occurredAt?.value),
    direction: o.direction ?? null,
    amount_minor: o.amount === undefined ? null : bigintColumn(o.amount.value.minor),
    currency: o.amount?.value.currency ?? null,
    merchant_key: o.merchant?.key ?? null,
    confidence: confidenceColumn(o.confidence),
    facts: observationFacts(o),
    evidence_excerpt: kept?.excerpt ?? null,
    excerpt_expires_at: kept === null ? null : toTimestamptz(kept.expiresAt),
  };
}

/** Columns a reader needs to rebuild an observation. */
export const OBSERVATION_READ_COLUMNS = "facts, evidence_excerpt, excerpt_expires_at";

export type ObservationReadRow = Pick<Tables<"observations">, "facts" | "evidence_excerpt" | "excerpt_expires_at">;

/**
 * Rebuild an observation. The excerpt is merged back only while unexpired at
 * `now`: the hourly retention job nulls expired excerpts, but between runs
 * the reader must not show text whose time is up.
 */
export function observationFromRow(r: ObservationReadRow, now: EpochMillis): Observation {
  const facts = fromJson<Observation>(r.facts);
  // Defensive: facts never carry excerpt fields, but if they did they must not bypass expiry.
  const { excerpt: _excerpt, excerptExpiresAt: _expires, ...summaryOnly } = facts.evidence as Evidence;
  if (r.evidence_excerpt !== null && r.excerpt_expires_at !== null) {
    const expiresAt = fromTimestamptz(r.excerpt_expires_at);
    if (expiresAt > now) {
      return { ...facts, evidence: { ...summaryOnly, excerpt: r.evidence_excerpt, excerptExpiresAt: expiresAt } };
    }
  }
  return { ...facts, evidence: summaryOnly };
}

/* ------------------------------------------------------------------ */
/* Assertions.                                                         */
/* ------------------------------------------------------------------ */

export function assertionToRow(a: UserAssertion, userId: string): TablesInsert<"user_assertions"> {
  return {
    user_id: userId,
    id: a.id,
    kind: a.kind,
    at: toTimestamptz(a.at),
    anchors: [...a.anchors],
    body: toJson(a),
  };
}

export function assertionFromRow(r: Pick<Tables<"user_assertions">, "body">): UserAssertion {
  return fromJson<UserAssertion>(r.body);
}

/* ------------------------------------------------------------------ */
/* Preferences.                                                        */
/* ------------------------------------------------------------------ */

/** `created_at`/`updated_at` are owned by the database (default + update trigger), so they are not sent. */
export function settingsToRow(s: UserSettings, userId: string): TablesInsert<"user_settings"> {
  return {
    user_id: userId,
    locale: s.locale,
    time_zone: s.timeZone,
    home_country: s.homeCountry ?? null,
    home_currency: s.homeCurrency ?? null,
    question_weekly_budget: smallintColumn(s.questionWeeklyBudget),
    regret_prompts_enabled: s.regretPromptsEnabled,
  };
}

export function settingsFromRow(r: Tables<"user_settings">): UserSettings {
  return {
    locale: r.locale,
    timeZone: r.time_zone,
    ...opt("homeCountry", r.home_country),
    ...opt("homeCurrency", r.home_currency),
    questionWeeklyBudget: r.question_weekly_budget,
    regretPromptsEnabled: r.regret_prompts_enabled,
  };
}

export function budgetToRow(b: Budget, userId: string): TablesInsert<"budgets"> {
  return {
    user_id: userId,
    id: budgetId(b),
    category: b.category ?? null,
    limit_minor: bigintColumn(b.limit.minor),
    currency: b.limit.currency,
    period: b.period,
  };
}

/** Budgets always come back with their (possibly derived) id. */
export function budgetFromRow(r: Tables<"budgets">): Budget & { readonly id: string } {
  return {
    id: r.id,
    ...opt("category", r.category),
    limit: { minor: int(r.limit_minor), currency: r.currency },
    period: r.period,
  };
}

/** A goal's target and saved amounts share one currency column, so they must agree. */
export function goalToRow(g: Goal, userId: string): TablesInsert<"goals"> {
  if (g.saved.currency !== g.target.currency) {
    throw new RangeError("A goal's saved and target amounts must share a currency");
  }
  return {
    user_id: userId,
    id: g.id,
    name: g.name,
    target_minor: bigintColumn(g.target.minor),
    saved_minor: bigintColumn(g.saved.minor),
    currency: g.target.currency,
    target_date: toNullableTimestamptz(g.targetDate),
  };
}

export function goalFromRow(r: Tables<"goals">): Goal {
  return {
    id: r.id,
    name: r.name,
    target: { minor: int(r.target_minor), currency: r.currency },
    saved: { minor: int(r.saved_minor), currency: r.currency },
    ...opt("targetDate", r.target_date === null ? null : fromTimestamptz(r.target_date)),
  };
}

/** The matching conditions of a rule; `id`, `description` and `level` have their own columns. */
type RuleConditions = Pick<UserRule, "category" | "minAmount" | "localHours" | "channel">;

export function ruleToRow(r: UserRule, userId: string): TablesInsert<"user_rules"> {
  const conditions: RuleConditions = {
    ...opt("category", r.category),
    ...opt("minAmount", r.minAmount),
    ...opt("localHours", r.localHours),
    ...opt("channel", r.channel),
  };
  return { user_id: userId, id: r.id, description: r.description, level: r.level, rule: toJson(conditions) };
}

export function ruleFromRow(r: Tables<"user_rules">): UserRule {
  const conditions = fromJson<RuleConditions>(r.rule);
  return {
    id: r.id,
    description: r.description,
    ...opt("category", conditions.category),
    ...opt("minAmount", conditions.minAmount),
    ...opt("localHours", conditions.localHours),
    ...opt("channel", conditions.channel),
    level: r.level,
  };
}

export function instrumentToRow(i: StoredInstrument, userId: string): TablesInsert<"owned_instruments"> {
  return {
    user_id: userId,
    id: i.id,
    type: i.type,
    issuer: i.issuer ?? null,
    last4: i.last4 ?? null,
    account_ref: i.accountRef ?? null,
    handle: i.handle ?? null,
    card_kind: i.cardKind ?? null,
  };
}

export function instrumentFromRow(r: Tables<"owned_instruments">): StoredInstrument {
  return {
    id: r.id,
    type: r.type,
    ...opt("issuer", r.issuer),
    ...opt("last4", r.last4),
    ...opt("accountRef", r.account_ref),
    ...opt("handle", r.handle),
    ...opt("cardKind", r.card_kind),
  };
}

/* ------------------------------------------------------------------ */
/* Prompt log.                                                         */
/* ------------------------------------------------------------------ */

export function promptToRow(p: PromptLogEntry, userId: string): TablesInsert<"prompt_log"> {
  return {
    user_id: userId,
    id: p.id,
    kind: p.kind,
    anchor: p.anchor ?? null,
    shown_at: toTimestamptz(p.shownAt),
    answered_at: toNullableTimestamptz(p.answeredAt),
    answer: p.answer ?? null,
  };
}

export function promptFromRow(r: Tables<"prompt_log">): PromptLogEntry {
  return {
    id: r.id,
    kind: r.kind,
    ...opt("anchor", r.anchor),
    shownAt: fromTimestamptz(r.shown_at),
    ...opt("answeredAt", r.answered_at === null ? null : fromTimestamptz(r.answered_at)),
    ...opt("answer", r.answer),
  };
}

/* ------------------------------------------------------------------ */
/* Export.                                                             */
/* ------------------------------------------------------------------ */

/**
 * The document `export_my_data()` returns: `exported_at` plus, per user table,
 * an array of its rows exactly as stored (snake_case columns, `user_id` included).
 */
export interface ExportDocument {
  readonly exported_at?: string;
  readonly user_settings?: Tables<"user_settings">[];
  readonly source_connections?: Tables<"source_connections">[];
  readonly consent_events?: Tables<"consent_events">[];
  readonly observations?: Tables<"observations">[];
  readonly user_assertions?: Tables<"user_assertions">[];
  readonly budgets?: Tables<"budgets">[];
  readonly goals?: Tables<"goals">[];
  readonly user_rules?: Tables<"user_rules">[];
  readonly owned_instruments?: Tables<"owned_instruments">[];
  readonly prompt_log?: Tables<"prompt_log">[];
}

const compareText = compareCodePoints;

/**
 * Turn an `export_my_data()` document into the port's `BrakeExport`, in the
 * same order the store's listings use, with expired excerpts withheld exactly
 * as `listObservations` would. Consent receipts keep the database order
 * (at, then insertion id), which is the order they were given.
 */
export function exportFromDocument(doc: Json, exportedAt: EpochMillis, now: EpochMillis): BrakeExport {
  const d = fromJson<ExportDocument>(doc);
  const settings = d.user_settings?.[0];
  return {
    exportedAt,
    settings: settings === undefined ? null : settingsFromRow(settings),
    connections: (d.source_connections ?? []).map(connectionFromRow).sort((a, b) => compareText(a.connectionId, b.connectionId)),
    consentEvents: [...(d.consent_events ?? [])]
      .sort((a, b) => fromTimestamptz(a.at) - fromTimestamptz(b.at) || int(a.id) - int(b.id))
      .map(consentEventFromRow),
    observations: (d.observations ?? [])
      .map((r) => observationFromRow(r, now))
      .sort((a, b) => a.receivedAt - b.receivedAt || compareText(a.id, b.id)),
    assertions: (d.user_assertions ?? []).map(assertionFromRow).sort((a, b) => a.at - b.at || compareText(a.id, b.id)),
    budgets: (d.budgets ?? []).map(budgetFromRow).sort((a, b) => compareText(a.id, b.id)),
    goals: (d.goals ?? []).map(goalFromRow).sort((a, b) => compareText(a.id, b.id)),
    rules: (d.user_rules ?? []).map(ruleFromRow).sort((a, b) => compareText(a.id, b.id)),
    instruments: (d.owned_instruments ?? []).map(instrumentFromRow).sort((a, b) => compareText(a.id, b.id)),
    prompts: (d.prompt_log ?? []).map(promptFromRow).sort((a, b) => a.shownAt - b.shownAt || compareText(a.id, b.id)),
  };
}
