import type { UserAssertion } from "./model/assertion";
import type { Evidence, Observation, ObservationKind, TransactionStatus } from "./model/observation";
import type { Budget, Goal, UserRule } from "./model/preferences";
import { systemClock } from "./model/primitives";
import type { Clock, ConnectionId, EpochMillis, ObservationId } from "./model/primitives";
import type { SignalSourceKind, SpendWindow } from "./model/source";
import { luhnValid } from "./privacy/redact";
import type { ConsentEvent, SourceConnection } from "./privacy/types";
import type {
  BrakeExport,
  BrakeStore,
  ObservationQuery,
  Page,
  PromptKind,
  PromptLogEntry,
  StoredInstrument,
  UserSettings,
} from "./store";

/**
 * In-memory reference implementation of the persistence port.
 *
 * It is the executable specification of `BrakeStore`: the Supabase store must
 * behave exactly like this one (both run `describeStoreContract`). It is pure
 * and deterministic — time comes only from the injected clock — so it is also
 * what tests, demos and an offline-only device use.
 *
 * Semantics shared with the Supabase store (and its schema):
 *  - Everything is deep-copied on the way in and on the way out, so a caller
 *    can never mutate stored state (stores hand out plain JSON, like a network
 *    round trip would).
 *  - The same integrity and privacy rules the database enforces with check
 *    constraints and triggers are enforced here, and violations throw a
 *    `StoreError` whose `code` is the SQLSTATE the database would report
 *    (23514 check, 23503 foreign key, P0002 unknown row). Code that works
 *    against this store therefore does not start failing against Postgres.
 *  - Evidence excerpts are stored only while unexpired: their expiry is capped
 *    by the connection's `excerptTtlMs` at write time, an excerpt already
 *    expired at write time is not stored at all, and reads omit an excerpt
 *    whose expiry has passed (the server-side retention job then deletes it).
 *  - Observations are ordered by (receivedAt, id) and paginated with an opaque
 *    keyset cursor; ids compare by UTF-16 code unit, which matches Postgres
 *    under the "C" collation for ASCII ids.
 *
 * Unlike the Supabase store (which writes observations in batches of 500),
 * `putObservations` validates the whole input before writing anything.
 */
export interface MemoryStoreOptions {
  readonly clock?: Clock;
}

/**
 * Error raised for writes the database would reject. `code` is the matching
 * SQLSTATE, so callers can handle the memory and Supabase stores alike.
 */
export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

/** SQLSTATE check_violation: a value breaks a schema rule. */
export const CHECK_VIOLATION = "23514";
/** SQLSTATE foreign_key_violation: an observation references an unknown connection. */
export const FOREIGN_KEY_VIOLATION = "23503";
/** SQLSTATE no_data_found: an RPC was asked to act on a row the user does not have. */
export const NO_DATA_FOUND = "P0002";

/** Default and maximum observation page sizes (see `ObservationQuery.limit`). */
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 1000;

/** Hard cap on an evidence excerpt, in characters: an excerpt is a snippet, never a message body. */
export const MAX_EXCERPT_CHARS = 500;
/** Hard cap on an observation's serialized facts: extracted facts are small; anything bigger is a payload. */
export const MAX_FACTS_BYTES = 32_768;
/** Top-level keys that would mean a raw payload is being smuggled into an observation. */
export const FORBIDDEN_FACT_KEYS: readonly string[] = ["payload", "raw", "rawPayload", "body", "html", "text"];
/** Prompt answers are option ids ("worth_it", "dismissed", "cat:food"), never free text. */
export const PROMPT_ANSWER_PATTERN = /^[a-z0-9_:-]{1,64}$/;

/**
 * Persistence id of a budget. One budget per (category, period, currency) is
 * the natural key when the caller has not chosen an id.
 */
export function budgetId(b: Budget): string {
  return b.id ?? `${b.category ?? "all"}:${b.period}:${b.limit.currency}`;
}

/**
 * Normalize a requested page size: default 500, values above 1000 are clamped
 * (a client cannot ask for an unbounded page), anything that is not a
 * positive integer is a programming error.
 */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** Keyset cursor for (receivedAt, id) ordering. Opaque to callers; stable across both stores. */
export function encodeCursor(receivedAt: EpochMillis, id: ObservationId): string {
  return `${receivedAt}:${id}`;
}

export function decodeCursor(cursor: string): { readonly receivedAt: EpochMillis; readonly id: ObservationId } {
  const m = /^(-?\d+):([\s\S]+)$/.exec(cursor);
  if (!m) throw new RangeError("Invalid observation cursor");
  return { receivedAt: Number(m[1]), id: m[2]! };
}

/**
 * The evidence a store may keep for an observation. The excerpt survives only
 * if it is still within both its own expiry and the connection's excerpt TTL
 * (the stricter wins, as in `isExcerptExpired`); its stored expiry is the
 * capped one, so retention never has to look the policy up again.
 */
export function storableEvidence(o: Observation, excerptTtlMs: number, now: EpochMillis): Evidence {
  const { excerpt, excerptExpiresAt, ...rest } = o.evidence;
  if (excerpt === undefined) return rest;
  const cap = o.receivedAt + Math.max(0, excerptTtlMs);
  const expiresAt = excerptExpiresAt === undefined ? cap : Math.min(excerptExpiresAt, cap);
  if (!(expiresAt > now)) return rest;
  return { ...rest, excerpt, excerptExpiresAt: expiresAt };
}

/** The observation as a reader at `now` may see it: an expired excerpt is withheld. */
export function visibleObservation(o: Observation, now: EpochMillis): Observation {
  const { excerpt, excerptExpiresAt, ...rest } = o.evidence;
  if (excerpt === undefined) return o;
  if (excerptExpiresAt !== undefined && excerptExpiresAt > now) return o;
  return { ...o, evidence: rest };
}

/**
 * Full card numbers (Luhn-valid runs of 13–19 digits) found in a text.
 * Adapters redact them before anything is kept; the store refuses them as a
 * second line of defence, exactly like the database trigger does.
 */
export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\d+/g)) {
    const run = m[0];
    if (run.length >= 13 && run.length <= 19 && luhnValid(run)) return true;
  }
  return false;
}

/** True when any string inside a JSON value contains a full card number. */
export function jsonContainsCardNumber(value: unknown): boolean {
  if (typeof value === "string") return containsCardNumber(value);
  if (Array.isArray(value)) return value.some(jsonContainsCardNumber);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => containsCardNumber(k) || jsonContainsCardNumber(v));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Allowed values, kept exhaustive by the compiler.                    */
/* ------------------------------------------------------------------ */

const SOURCE_KINDS = keys<SignalSourceKind>({
  open_banking: 1,
  account_aggregator: 1,
  card_feed: 1,
  issuer_webhook: 1,
  neobank_api: 1,
  wallet_history: 1,
  os_wallet: 1,
  notification: 1,
  sms: 1,
  messaging: 1,
  email: 1,
  payment_intent: 1,
  qr_scan: 1,
  checkout: 1,
  merchant_partner: 1,
  payment_partner: 1,
  manual: 1,
  receipt: 1,
  share: 1,
  voice: 1,
  barcode: 1,
  browser_extension: 1,
  app_activity: 1,
  user_rule: 1,
});

const OBSERVATION_KINDS = keys<ObservationKind>({
  purchase_intent: 1,
  checkout: 1,
  money_movement: 1,
  order: 1,
  receipt: 1,
  invoice: 1,
  delivery: 1,
  subscription_event: 1,
  refund_notice: 1,
  booking: 1,
  mandate: 1,
  balance_snapshot: 1,
  app_context: 1,
});

const STAGES = keys<TransactionStatus>({
  intent: 1,
  pending: 1,
  confirmed: 1,
  posted: 1,
  refunded: 1,
  cancelled: 1,
  unknown: 1,
});

const WINDOWS = keys<SpendWindow>({ pre_spend: 1, in_spend: 1, post_spend: 1 });
const CONNECTION_STATUSES = keys<SourceConnection["status"]>({ active: 1, paused: 1, revoked: 1 });
const CONSENT_ACTIONS = keys<ConsentEvent["action"]>({
  granted: 1,
  paused: 1,
  resumed: 1,
  revoked: 1,
  scopes_changed: 1,
  retention_changed: 1,
});
const ASSERTION_KINDS = keys<UserAssertion["kind"]>({
  label: 1,
  satisfaction: 1,
  same_event: 1,
  different_events: 1,
  dismiss: 1,
  confirm: 1,
});
const PERIODS = keys<Budget["period"]>({ weekly: 1, monthly: 1 });
const RULE_LEVELS = keys<UserRule["level"]>({ inform: 1, reflect: 1, pause: 1 });
const INSTRUMENT_TYPES = keys<StoredInstrument["type"]>({
  bank_account: 1,
  card: 1,
  wallet: 1,
  upi_handle: 1,
  brokerage: 1,
  loan: 1,
});
const CARD_KINDS = keys<NonNullable<StoredInstrument["cardKind"]>>({ credit: 1, debit: 1, prepaid: 1 });
const PROMPT_KINDS = keys<PromptKind>({ question: 1, regret_prompt: 1, intervention: 1, insight: 1 });

function keys<K extends string>(record: Record<K, 1>): ReadonlySet<string> {
  return new Set(Object.keys(record));
}

/* ------------------------------------------------------------------ */
/* The store.                                                          */
/* ------------------------------------------------------------------ */

export function createMemoryStore(opts: MemoryStoreOptions = {}): BrakeStore {
  const clock = opts.clock ?? systemClock;

  let settings: UserSettings | null = null;
  const connections = new Map<ConnectionId, SourceConnection>();
  /** Append-only; `seq` breaks ties between events at the same instant, like the identity column does. */
  let consentEvents: Array<{ readonly seq: number; readonly event: ConsentEvent }> = [];
  let consentSeq = 0;
  const observations = new Map<ObservationId, Observation>();
  const assertions = new Map<string, UserAssertion>();
  const budgets = new Map<string, Budget>();
  const goals = new Map<string, Goal>();
  const rules = new Map<string, UserRule>();
  const instruments = new Map<string, StoredInstrument>();
  const prompts = new Map<string, PromptLogEntry>();

  function sortedObservations(now: EpochMillis): Observation[] {
    return [...observations.values()]
      .sort((a, b) => a.receivedAt - b.receivedAt || compareText(a.id, b.id))
      .map((o) => clone(visibleObservation(o, now)));
  }

  function appendEvent(event: ConsentEvent): void {
    consentSeq += 1;
    consentEvents.push({ seq: consentSeq, event: clone(event) });
  }

  function listConsent(connectionId?: string): ConsentEvent[] {
    return consentEvents
      .filter((e) => connectionId === undefined || e.event.connectionId === connectionId)
      .sort((a, b) => a.event.at - b.event.at || a.seq - b.seq)
      .map((e) => clone(e.event));
  }

  const store: BrakeStore = {
    /* consent */

    async upsertConnection(connection) {
      checkConnection(connection);
      connections.set(connection.connectionId, clone(connection));
    },

    async listConnections() {
      return byKey([...connections.values()], (c) => c.connectionId).map(clone);
    },

    async appendConsentEvent(event) {
      checkConsentEvent(event);
      appendEvent(event);
    },

    async listConsentEvents(connectionId) {
      return listConsent(connectionId);
    },

    async revokeConnection(connectionId, at) {
      checkInstant(at, "revokedAt");
      const c = connections.get(connectionId);
      if (!c) throw new StoreError(NO_DATA_FOUND, "Unknown connection");
      // Revocation is final and idempotent: a second revoke keeps the original
      // receipt but still purges anything that arrived for the connection since.
      if (c.status !== "revoked") {
        connections.set(connectionId, { ...c, status: "revoked", revokedAt: at, updatedAt: at });
        appendEvent({ connectionId, action: "revoked", at, scopes: c.scopes, purposes: c.purposes });
      }
      let deletedObservations = 0;
      for (const [id, o] of observations) {
        if (o.source.connectionId === connectionId) {
          observations.delete(id);
          deletedObservations += 1;
        }
      }
      return { deletedObservations };
    },

    /* source of truth */

    async putObservations(input) {
      const now = clock.now();
      const prepared: Observation[] = [];
      for (const o of input) {
        checkObservation(o);
        const connection = connections.get(o.source.connectionId);
        if (!connection) throw new StoreError(FOREIGN_KEY_VIOLATION, "Observation references an unknown connection");
        const stored = clone({ ...o, evidence: storableEvidence(o, connection.retention.excerptTtlMs, now) });
        checkStoredObservation(stored);
        prepared.push(stored);
      }
      let inserted = 0;
      for (const o of prepared) {
        // Idempotent: the first write of an id wins, later ones are no-ops.
        if (observations.has(o.id)) continue;
        observations.set(o.id, o);
        inserted += 1;
      }
      return { inserted };
    },

    async listObservations(query: ObservationQuery = {}) {
      const limit = pageSize(query.limit);
      const cursor = query.after !== undefined ? decodeCursor(query.after) : undefined;
      const matching = sortedObservations(clock.now()).filter(
        (o) =>
          (query.since === undefined || o.receivedAt >= query.since) &&
          (query.until === undefined || o.receivedAt < query.until) &&
          (query.connectionId === undefined || o.source.connectionId === query.connectionId) &&
          (cursor === undefined ||
            o.receivedAt > cursor.receivedAt ||
            (o.receivedAt === cursor.receivedAt && compareText(o.id, cursor.id) > 0)),
      );
      const items = matching.slice(0, limit);
      const last = items[items.length - 1];
      const page: Page<Observation> =
        matching.length > limit && last ? { items, next: encodeCursor(last.receivedAt, last.id) } : { items };
      return page;
    },

    async deleteObservations(ids) {
      let deleted = 0;
      for (const id of new Set(ids)) if (observations.delete(id)) deleted += 1;
      return deleted;
    },

    async putAssertion(assertion) {
      checkAssertion(assertion);
      assertions.set(assertion.id, clone(assertion));
    },

    async listAssertions() {
      return [...assertions.values()].sort((a, b) => a.at - b.at || compareText(a.id, b.id)).map(clone);
    },

    async deleteAssertion(id) {
      assertions.delete(id);
    },

    /* preferences */

    async getSettings() {
      return settings === null ? null : clone(settings);
    },

    async putSettings(next) {
      checkSettings(next);
      settings = clone(next);
    },

    async listBudgets() {
      return byKey([...budgets.values()], budgetId).map(clone);
    },

    async putBudget(budget) {
      checkBudget(budget);
      const id = budgetId(budget);
      budgets.set(id, clone({ ...budget, id }));
    },

    async deleteBudget(id) {
      budgets.delete(id);
    },

    async listGoals() {
      return byKey([...goals.values()], (g) => g.id).map(clone);
    },

    async putGoal(goal) {
      checkGoal(goal);
      goals.set(goal.id, clone(goal));
    },

    async deleteGoal(id) {
      goals.delete(id);
    },

    async listRules() {
      return byKey([...rules.values()], (r) => r.id).map(clone);
    },

    async putRule(rule) {
      checkRule(rule);
      rules.set(rule.id, clone(rule));
    },

    async deleteRule(id) {
      rules.delete(id);
    },

    async listOwnedInstruments() {
      return byKey([...instruments.values()], (i) => i.id).map(clone);
    },

    async putOwnedInstrument(instrument) {
      checkInstrument(instrument);
      instruments.set(instrument.id, clone(instrument));
    },

    async deleteOwnedInstrument(id) {
      instruments.delete(id);
    },

    /* learning-loop bookkeeping */

    async logPrompt(entry) {
      checkPrompt(entry);
      prompts.set(entry.id, clone(entry));
    },

    async listPrompts(since) {
      return [...prompts.values()]
        .filter((p) => p.shownAt >= since)
        .sort((a, b) => a.shownAt - b.shownAt || compareText(a.id, b.id))
        .map(clone);
    },

    /* user rights */

    async exportAll(): Promise<BrakeExport> {
      const now = clock.now();
      return {
        exportedAt: now,
        settings: await store.getSettings(),
        connections: await store.listConnections(),
        consentEvents: listConsent(),
        observations: sortedObservations(now),
        assertions: await store.listAssertions(),
        budgets: await store.listBudgets(),
        goals: await store.listGoals(),
        rules: await store.listRules(),
        instruments: await store.listOwnedInstruments(),
        prompts: await store.listPrompts(Number.NEGATIVE_INFINITY),
      };
    },

    async eraseAll() {
      settings = null;
      connections.clear();
      consentEvents = [];
      observations.clear();
      assertions.clear();
      budgets.clear();
      goals.clear();
      rules.clear();
      instruments.clear();
      prompts.clear();
    },
  };
  return store;
}

/* ------------------------------------------------------------------ */
/* Validation: mirrors the schema's check constraints and triggers.    */
/* ------------------------------------------------------------------ */

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new StoreError(CHECK_VIOLATION, message);
}

/** Postgres counts characters (code points), not UTF-16 units. */
function chars(s: string): number {
  return Array.from(s).length;
}

function checkInstant(t: unknown, field: string): void {
  check(typeof t === "number" && Number.isInteger(t), `${field} must be integer epoch milliseconds`);
}

function checkCurrency(c: unknown, field: string): void {
  check(typeof c === "string" && /^[A-Z]{3}$/.test(c), `${field} must be an upper-case ISO 4217 code`);
}

function checkMinor(m: unknown, field: string, min: number): void {
  check(typeof m === "number" && Number.isSafeInteger(m) && m >= min, `${field} must be an integer >= ${min}`);
}

function checkConnection(c: SourceConnection): void {
  check(SOURCE_KINDS.has(c.kind), "connection kind is not a known source kind");
  check(CONNECTION_STATUSES.has(c.status), "connection status is invalid");
  check(chars(c.label) <= 120, "connection label is longer than 120 characters");
  check(Number.isSafeInteger(c.retention.excerptTtlMs) && c.retention.excerptTtlMs >= 0, "excerptTtlMs must be >= 0");
  check(
    c.retention.observationTtlMs === null ||
      (Number.isSafeInteger(c.retention.observationTtlMs) && c.retention.observationTtlMs > 0),
    "observationTtlMs must be null or > 0",
  );
  checkInstant(c.grantedAt, "grantedAt");
  checkInstant(c.updatedAt, "updatedAt");
  if (c.revokedAt !== undefined) checkInstant(c.revokedAt, "revokedAt");
}

function checkConsentEvent(e: ConsentEvent): void {
  check(CONSENT_ACTIONS.has(e.action), "consent action is invalid");
  checkInstant(e.at, "at");
}

/** Column-level rules of the observations table. */
function checkObservation(o: Observation): void {
  check(OBSERVATION_KINDS.has(o.kind), "observation kind is invalid");
  check(WINDOWS.has(o.window), "spend window is invalid");
  check(STAGES.has(o.stage), "observation stage is invalid");
  check(o.direction === undefined || o.direction === "debit" || o.direction === "credit", "direction is invalid");
  checkInstant(o.receivedAt, "receivedAt");
  if (o.occurredAt !== undefined) checkInstant(o.occurredAt.value, "occurredAt");
  if (o.amount !== undefined) {
    checkMinor(o.amount.value.minor, "amount", 0);
    checkCurrency(o.amount.value.currency, "amount currency");
  }
  check(typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1, "confidence must be within [0, 1]");
}

/** Privacy rules on what is actually persisted (facts + surviving excerpt). */
function checkStoredObservation(o: Observation): void {
  const { excerpt, excerptExpiresAt: _expires, ...evidence } = o.evidence;
  const facts: Record<string, unknown> = { ...o, evidence };
  for (const key of FORBIDDEN_FACT_KEYS) check(!(key in facts), `observation facts must not carry a raw "${key}"`);
  check(utf8Bytes(JSON.stringify(facts)) <= MAX_FACTS_BYTES, "observation facts are larger than 32 KiB");
  if (excerpt !== undefined) check(chars(excerpt) <= MAX_EXCERPT_CHARS, "evidence excerpt is longer than 500 characters");
  check(!jsonContainsCardNumber(facts), "observation facts contain a full card number");
  check(excerpt === undefined || !containsCardNumber(excerpt), "evidence excerpt contains a full card number");
}

function checkAssertion(a: UserAssertion): void {
  check(ASSERTION_KINDS.has(a.kind), "assertion kind is invalid");
  checkInstant(a.at, "at");
  check(Array.isArray(a.anchors) && a.anchors.length >= 1 && a.anchors.length <= 50, "an assertion needs 1 to 50 anchors");
  check(!jsonContainsCardNumber(a), "assertion contains a full card number");
}

function checkSettings(s: UserSettings): void {
  check(
    Number.isInteger(s.questionWeeklyBudget) && s.questionWeeklyBudget >= 0 && s.questionWeeklyBudget <= 50,
    "questionWeeklyBudget must be an integer within [0, 50]",
  );
  check(s.homeCountry === undefined || /^[A-Z]{2}$/.test(s.homeCountry), "homeCountry must be ISO 3166-1 alpha-2");
  if (s.homeCurrency !== undefined) checkCurrency(s.homeCurrency, "homeCurrency");
}

function checkBudget(b: Budget): void {
  checkMinor(b.limit.minor, "budget limit", 1);
  checkCurrency(b.limit.currency, "budget currency");
  check(PERIODS.has(b.period), "budget period is invalid");
}

function checkGoal(g: Goal): void {
  check(chars(g.name) <= 80, "goal name is longer than 80 characters");
  checkMinor(g.target.minor, "goal target", 1);
  checkMinor(g.saved.minor, "goal saved", 0);
  checkCurrency(g.target.currency, "goal currency");
  check(g.saved.currency === g.target.currency, "goal saved and target must share a currency");
  if (g.targetDate !== undefined) checkInstant(g.targetDate, "targetDate");
}

function checkRule(r: UserRule): void {
  check(chars(r.description) <= 200, "rule description is longer than 200 characters");
  check(RULE_LEVELS.has(r.level), "rule level is invalid");
}

function checkInstrument(i: StoredInstrument): void {
  check(INSTRUMENT_TYPES.has(i.type), "instrument type is invalid");
  // Only a masked tail is ever stored; a longer number is refused, not truncated.
  check(i.last4 === undefined || /^\d{4}$/.test(i.last4), "last4 must be exactly four digits");
  check(i.cardKind === undefined || CARD_KINDS.has(i.cardKind), "cardKind is invalid");
}

function checkPrompt(p: PromptLogEntry): void {
  check(PROMPT_KINDS.has(p.kind), "prompt kind is invalid");
  checkInstant(p.shownAt, "shownAt");
  if (p.answeredAt !== undefined) checkInstant(p.answeredAt, "answeredAt");
  check(p.answer === undefined || PROMPT_ANSWER_PATTERN.test(p.answer), "prompt answers must be option ids, never free text");
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

/** JSON deep copy: stored state is plain data (ADR-001) and `undefined` fields vanish, as over the wire. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byKey<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => compareText(key(a), key(b)));
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}
