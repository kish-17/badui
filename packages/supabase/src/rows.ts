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

/** Epoch millis -> ISO 8601 UTC. Throws for values Postgres or Date cannot represent. */
export function toTimestamptz(ms: EpochMillis): string {
  if (!Number.isFinite(ms)) throw new RangeError(`Not a finite instant: ${ms}`);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Instant out of range: ${ms}`);
  return d.toISOString();
}

const TIMESTAMPTZ =
  /^([+-]?\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)?$/i;

/**
 * Parse a timestamptz as PostgREST (or `to_jsonb`) prints it, e.g.
 * "2026-10-04T05:11:00.123+00:00" or "2026-10-04 10:41:00+05:30". Parsed by
 * hand rather than with `Date.parse`, whose acceptance of offsets and
 * microsecond fractions differs between JavaScript engines (Hermes vs V8).
 * Sub-millisecond digits are truncated.
 */
export function fromTimestamptz(value: string): EpochMillis {
  const m = TIMESTAMPTZ.exec(value.trim());
  if (!m) throw new RangeError(`Unrecognised timestamptz: ${value}`);
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  return utc - zoneOffsetMs(zone);
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

export function decodeCursor(cursor: string): { readonly receivedAt: EpochMillis; readonly id: ObservationId } {
  const m = /^(-?\d+):([\s\S]+)$/.exec(cursor);
  if (!m) throw new RangeError("Invalid observation cursor");
  return { receivedAt: Number(m[1]), id: m[2]! };
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

/** Plain-JSON copy: drops `undefined` fields exactly as the wire would. */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
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
    excerpt_ttl_ms: c.retention.excerptTtlMs,
    observation_ttl_ms: c.retention.observationTtlMs,
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
 * `receivedAt` (as `isExcerptExpired` judges it). Null when nothing may be kept.
 */
export function storableExcerpt(
  o: Observation,
  ctx: ObservationWriteContext,
): { readonly excerpt: string; readonly expiresAt: EpochMillis } | null {
  const { excerpt, excerptExpiresAt } = o.evidence;
  if (excerpt === undefined || !(ctx.excerptTtlMs > 0)) return null;
  const cap = o.receivedAt + ctx.excerptTtlMs;
  const expiresAt = excerptExpiresAt === undefined ? cap : Math.min(excerptExpiresAt, cap);
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
    amount_minor: o.amount?.value.minor ?? null,
    currency: o.amount?.value.currency ?? null,
    merchant_key: o.merchant?.key ?? null,
    confidence: o.confidence,
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
    question_weekly_budget: s.questionWeeklyBudget,
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
    limit_minor: b.limit.minor,
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
    throw new RangeError(`Goal "${g.id}": saved (${g.saved.currency}) and target (${g.target.currency}) currencies differ`);
  }
  return {
    user_id: userId,
    id: g.id,
    name: g.name,
    target_minor: g.target.minor,
    saved_minor: g.saved.minor,
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
