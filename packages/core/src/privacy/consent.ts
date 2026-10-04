import type { Observation } from "../model/observation";
import type { Clock, ConnectionId, EpochMillis } from "../model/primitives";
import type { SignalSourceKind } from "../model/source";
import { DEFAULT_RETENTION, validateRetentionPolicy } from "./retention";
import type { ConsentEvent, RetentionPolicy, SourceConnection } from "./types";

/**
 * Consent registry: the user's control over each signal source.
 *
 * "Give users control over each signal source. Allow users to disconnect
 * individual sources." Every change is recorded as an append-only consent
 * receipt, so BRAKE can always show what the user agreed to and when.
 *
 * Lifecycle: active ⇄ paused → revoked. Revocation is final: re-consenting
 * creates a *new* connection (new id, new receipt), so a grant can never be
 * silently revived with stale scopes.
 */

export interface ConnectInput {
  readonly connectionId: ConnectionId;
  readonly adapterId: string;
  readonly kind: SignalSourceKind;
  /** Noun phrase that reads after "your": "HDFC Bank SMS alerts", "Gmail inbox". */
  readonly label: string;
  readonly provider?: string;
  /** Exact permissions granted, as shown at consent time. */
  readonly scopes: readonly string[];
  /** Plain-language purposes the user agreed to. At least one is required. */
  readonly purposes: readonly string[];
  /** Defaults to `DEFAULT_RETENTION[kind]`. */
  readonly retention?: RetentionPolicy;
}

export interface Revocation {
  readonly connection: SourceConnection;
  /** Matches every observation from the revoked connection — pass to `FusionEngine.removeObservations`. */
  readonly purgePredicate: (o: Observation) => boolean;
}

export interface ScopeChange {
  readonly scopes?: readonly string[];
  readonly purposes?: readonly string[];
}

/** Serializable registry state; the history is the user's consent receipts and must be persisted with it. */
export interface ConsentSnapshot {
  readonly version: 1;
  readonly connections: readonly SourceConnection[];
  readonly history: readonly ConsentEvent[];
}

export interface ConsentRegistry {
  /** Record a new grant. Throws if the id was ever used (re-consent needs a new id). */
  connect(input: ConnectInput): SourceConnection;
  /** Stop collecting without deleting anything. Idempotent while paused. */
  pause(id: ConnectionId): SourceConnection;
  /** Resume a paused connection. Idempotent while active; throws for a revoked connection. */
  resume(id: ConnectionId): SourceConnection;
  /** Withdraw consent and get the predicate that purges this connection's data. Idempotent. */
  revoke(id: ConnectionId): Revocation;
  setRetention(id: ConnectionId, policy: RetentionPolicy): SourceConnection;
  /** Narrow or otherwise change what was granted; recorded as `scopes_changed`. */
  updateScopes(id: ConnectionId, change: ScopeChange): SourceConnection;
  /** The connection, or undefined when the id is unknown (a lookup, not a mutation). */
  get(id: ConnectionId): SourceConnection | undefined;
  /** Every connection ever granted, including revoked ones, in grant order. */
  list(): SourceConnection[];
  /**
   * Whether signals from this connection may be used. Paused, revoked and
   * unknown connections are not active: adapters' signals from them are dropped.
   */
  isActive(id: ConnectionId): boolean;
  /** Append-only consent receipts, oldest first. */
  history(): ConsentEvent[];
  snapshot(): ConsentSnapshot;
}

export type ConsentErrorCode = "unknown_connection" | "revoked" | "duplicate_connection" | "invalid_input";

export class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  readonly connectionId: ConnectionId;

  constructor(code: ConsentErrorCode, connectionId: ConnectionId, message: string) {
    super(message);
    this.name = "ConsentError";
    this.code = code;
    this.connectionId = connectionId;
  }
}

/** Predicate matching every observation that came from one connection. */
export function connectionPurgePredicate(connectionId: ConnectionId): (o: Observation) => boolean {
  return (o) => o.source.connectionId === connectionId;
}

export interface ConsentRegistryOptions {
  readonly clock: Clock;
  /** Restore persisted state (connections and their receipts). */
  readonly restore?: ConsentSnapshot;
}

export function createConsentRegistry(opts: ConsentRegistryOptions): ConsentRegistry {
  const { clock } = opts;
  const connections = new Map<ConnectionId, SourceConnection>();
  const events: ConsentEvent[] = [];

  if (opts.restore) {
    if (opts.restore.version !== 1) throw new RangeError(`Unsupported consent snapshot version ${String(opts.restore.version)}`);
    for (const c of opts.restore.connections) {
      if (connections.has(c.connectionId)) throw new RangeError(`Consent snapshot lists connection "${c.connectionId}" twice`);
      connections.set(c.connectionId, restoredConnection(c));
    }
    for (const e of opts.restore.history) events.push(restoredEvent(e));
  }

  function mustGet(id: ConnectionId): SourceConnection {
    const c = connections.get(id);
    if (!c) throw new ConsentError("unknown_connection", id, `Unknown connection "${id}"`);
    return c;
  }

  function requireNotRevoked(id: ConnectionId, action: string): SourceConnection {
    const c = mustGet(id);
    if (c.status === "revoked") {
      throw new ConsentError("revoked", id, `Cannot ${action} revoked connection "${id}"; re-consent creates a new connection`);
    }
    return c;
  }

  function record(c: SourceConnection, action: ConsentEvent["action"], at: EpochMillis): void {
    events.push(freezeEvent({ connectionId: c.connectionId, action, at, scopes: c.scopes, purposes: c.purposes }));
  }

  function update(
    prev: SourceConnection,
    changes: Partial<SourceConnection>,
    action: ConsentEvent["action"],
    at: EpochMillis = clock.now(),
  ): SourceConnection {
    const next = freezeConnection({ ...prev, ...changes, updatedAt: at });
    connections.set(next.connectionId, next);
    record(next, action, at);
    return next;
  }

  return {
    connect(input) {
      const id = input.connectionId;
      if (connections.has(id)) {
        throw new ConsentError("duplicate_connection", id, `Connection "${id}" already exists; re-consent must use a new connection id`);
      }
      if (!id.trim()) throw new ConsentError("invalid_input", id, "connectionId must not be empty");
      if (!input.adapterId.trim()) throw new ConsentError("invalid_input", id, "adapterId must not be empty");
      if (!input.label.trim()) throw new ConsentError("invalid_input", id, "label must not be empty: the user must be able to recognise the source");
      if (cleanList(input.purposes).length === 0) {
        // Consent without a stated purpose is not informed consent.
        throw new ConsentError("invalid_input", id, "at least one purpose is required");
      }
      const fallback = Object.hasOwn(DEFAULT_RETENTION, input.kind) ? DEFAULT_RETENTION[input.kind] : undefined;
      if (!input.retention && !fallback) {
        throw new ConsentError("invalid_input", id, `unknown source kind "${String(input.kind)}" and no retention policy given`);
      }
      const retention = input.retention ? validated(id, input.retention) : fallback!;
      const at = clock.now();
      const connection = freezeConnection({
        connectionId: id,
        adapterId: input.adapterId,
        kind: input.kind,
        label: input.label.trim(),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        status: "active",
        scopes: cleanList(input.scopes),
        purposes: cleanList(input.purposes),
        retention,
        grantedAt: at,
        updatedAt: at,
      });
      connections.set(id, connection);
      record(connection, "granted", at);
      return connection;
    },

    pause(id) {
      const c = requireNotRevoked(id, "pause");
      return c.status === "paused" ? c : update(c, { status: "paused" }, "paused");
    },

    resume(id) {
      const c = requireNotRevoked(id, "resume");
      return c.status === "active" ? c : update(c, { status: "active" }, "resumed");
    },

    revoke(id) {
      const c = mustGet(id);
      if (c.status === "revoked") return { connection: c, purgePredicate: connectionPurgePredicate(id) };
      const at = clock.now();
      const connection = update(c, { status: "revoked", revokedAt: at }, "revoked", at);
      return { connection, purgePredicate: connectionPurgePredicate(id) };
    },

    setRetention(id, policy) {
      const c = requireNotRevoked(id, "change retention of");
      return update(c, { retention: validated(id, policy) }, "retention_changed");
    },

    updateScopes(id, change) {
      const c = requireNotRevoked(id, "change scopes of");
      const purposes = change.purposes !== undefined ? cleanList(change.purposes) : c.purposes;
      if (purposes.length === 0) throw new ConsentError("invalid_input", id, "at least one purpose is required");
      const scopes = change.scopes !== undefined ? cleanList(change.scopes) : c.scopes;
      return update(c, { scopes, purposes }, "scopes_changed");
    },

    get(id) {
      return connections.get(id);
    },

    list() {
      return [...connections.values()].sort((a, b) => a.grantedAt - b.grantedAt);
    },

    isActive(id) {
      return connections.get(id)?.status === "active";
    },

    history() {
      return [...events];
    },

    snapshot() {
      return { version: 1, connections: [...connections.values()], history: [...events] };
    },
  };
}

function validated(id: ConnectionId, p: RetentionPolicy): RetentionPolicy {
  try {
    return validateRetentionPolicy(p);
  } catch (e) {
    throw new ConsentError("invalid_input", id, (e as Error).message);
  }
}

/** Trimmed, de-duplicated, frozen copy — the caller's array can't later alter a receipt. */
function cleanList(items: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(items.map((s) => s.trim()).filter((s) => s.length > 0))]);
}

const STATUSES: ReadonlySet<string> = new Set<SourceConnection["status"]>(["active", "paused", "revoked"]);
const ACTIONS: ReadonlySet<string> = new Set<ConsentEvent["action"]>([
  "granted",
  "paused",
  "resumed",
  "revoked",
  "scopes_changed",
  "retention_changed",
]);

/**
 * Persisted state comes back through a JSON boundary, so it is checked before
 * BRAKE acts on it: a corrupted retention policy (say a negative TTL) would
 * otherwise make the next retention pass delete every fact of the source, and
 * an unknown status would make `isActive` silently drop or admit signals.
 */
function restoredConnection(c: SourceConnection): SourceConnection {
  if (typeof c.connectionId !== "string" || !c.connectionId.trim()) throw new RangeError("Consent snapshot has a connection without an id");
  if (!STATUSES.has(c.status)) throw new RangeError(`Consent snapshot connection "${c.connectionId}" has unknown status ${String(c.status)}`);
  if (!Array.isArray(c.scopes) || !Array.isArray(c.purposes)) {
    throw new RangeError(`Consent snapshot connection "${c.connectionId}" has malformed scopes or purposes`);
  }
  return freezeConnection({ ...c, retention: validateRetentionPolicy(c.retention ?? ({} as RetentionPolicy)) });
}

function restoredEvent(e: ConsentEvent): ConsentEvent {
  if (!ACTIONS.has(e.action)) throw new RangeError(`Consent snapshot has a receipt with unknown action ${String(e.action)}`);
  if (!Array.isArray(e.scopes) || !Array.isArray(e.purposes)) throw new RangeError("Consent snapshot has a malformed receipt");
  return freezeEvent(e);
}

function freezeConnection(c: SourceConnection): SourceConnection {
  return Object.freeze({
    ...c,
    scopes: Object.freeze([...c.scopes]),
    purposes: Object.freeze([...c.purposes]),
    retention: Object.freeze({ ...c.retention }),
  });
}

function freezeEvent(e: ConsentEvent): ConsentEvent {
  return Object.freeze({ ...e, scopes: Object.freeze([...e.scopes]), purposes: Object.freeze([...e.purposes]) });
}
