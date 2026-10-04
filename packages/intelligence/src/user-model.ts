import { DAY, stableHash } from "@brake/core";
import type {
  CategoryId,
  CounterpartyObservation,
  EpochMillis,
  Essentiality,
  TransactionCandidate,
  TransactionType,
  TransferKind,
  UserAssertion,
} from "@brake/core";
import type { Distribution, UserModel } from "./contracts";
import { foldAccents, foldText } from "./hints";
import { UNCATEGORIZED, topLevelCategory } from "./taxonomy";

/**
 * What BRAKE has learned from this user's own answers — on-device, small,
 * and forgetful on purpose.
 *
 * Every answer is kept as a weighted event with its assertion timestamp, and
 * read back as Dirichlet-style counts with exponential recency decay
 * (half-life ~180 days): habits change, and a label from two years ago
 * should not outvote last week's. Decay is measured from the newest
 * assertion the model has seen (or a caller-supplied instant), never from a
 * wall clock, so the model is deterministic.
 *
 * Learning is idempotent and correctable: re-observing an assertion is a
 * no-op, and a newer answer for the same candidate and field replaces the
 * older one instead of adding to it.
 *
 * Nothing that could name a person is stored in clear text. Payee handles
 * are hashed by `counterpartyKey`, and every merchant/counterparty key is
 * hashed again at rest: a P2P narration ("UPI/…/RAMESH KUMAR/…") makes the
 * payee's name the merchant key, and the snapshot must not keep it. Only
 * category ids (not personal) stay readable.
 */

export const USER_MODEL_HALF_LIFE_DAYS = 180;

/** Semantic attributes learned per merchant/counterparty key. */
export type LearnedAttribute = "ownership" | "intent" | "temporal_type" | "purchase_context";

/** Whether payments matching a key are real transactions (dismissals teach "not a transaction"). */
export type Existence = "transaction" | "not_a_transaction";

export interface LearnedUserModel extends UserModel {
  readonly halfLifeDays: number;
  /** Newest assertion time seen; reads decay relative to max(this, `at`). */
  asOf(): EpochMillis;
  categoryFor(merchantKey: string, at?: EpochMillis): Distribution<CategoryId> | null;
  typeFor(counterpartyOrMerchantKey: string, at?: EpochMillis): Distribution<TransactionType> | null;
  transferKindFor(counterpartyKey: string, at?: EpochMillis): Distribution<TransferKind> | null;
  essentialityFor(category: CategoryId, at?: EpochMillis): Distribution<Exclude<Essentiality, "unknown">> | null;
  attributeFor(field: LearnedAttribute, key: string, at?: EpochMillis): Distribution<string> | null;
  existenceFor(key: string, at?: EpochMillis): Distribution<Existence> | null;
}

export interface UserModelOptions {
  /** Override the recency half-life (days). */
  readonly halfLifeDays?: number;
}

/** True when a UserModel also exposes the attribute/existence/recency extensions. */
export function isLearnedUserModel(model: UserModel): model is LearnedUserModel {
  const m = model as Partial<LearnedUserModel>;
  return typeof m.attributeFor === "function" && typeof m.existenceFor === "function";
}

/**
 * Privacy-preserving key for the other party of a transfer. Handles and
 * names of people must never sit in a model in clear text, so the key is a
 * hash of the normalized handle (or, failing that, the name).
 */
export function counterpartyKey(cp: CounterpartyObservation | undefined): string | null {
  if (!cp) return null;
  const basis = cp.handle ? foldAccents(cp.handle).trim() : cp.name ? foldText(cp.name) : "";
  return basis ? `cp_${stableHash(basis)}` : null;
}

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

type TableName = "category" | "type" | "transferKind" | "essentiality" | "attribute" | "existence" | "labels";
const TABLES: readonly TableName[] = ["category", "type", "transferKind", "essentiality", "attribute", "existence", "labels"];

/** Tables keyed by category id; every other table is keyed by a (hashed) merchant/counterparty key. */
const CATEGORY_KEYED: ReadonlySet<TableName> = new Set(["essentiality"]);

/** Keys are compared the way they are written: "Amazon " and "amazon" are one merchant. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** At-rest form of a merchant/counterparty key: a hash, never the name itself. */
function storedKey(key: string): string {
  return `k_${stableHash(normalizeKey(key))}`;
}

/** At-rest form of a per-key attribute row ("ownership:<hashed key>"). */
function attributeKey(field: LearnedAttribute, key: string): string {
  return `${field}:${storedKey(key)}`;
}

/** Code-point order: deterministic on every device, unlike locale collation. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One remembered answer: [assertion id, at, value, weight]. Tuples keep the snapshot compact. */
type Event = readonly [id: string, at: EpochMillis, value: string, weight: number];

/** Older events beyond this per key carry almost no weight after decay; dropping them bounds storage. */
const MAX_EVENTS_PER_KEY = 200;

/**
 * Version 2 stores hashed merchant/counterparty keys. Version 1 (clear-text
 * keys) is still read, and its keys are hashed on load.
 */
interface SnapshotV2 {
  readonly version: 2;
  readonly halfLifeDays: number;
  readonly asOf: EpochMillis;
  readonly tables: Readonly<Record<TableName, Readonly<Record<string, readonly Event[]>>>>;
  readonly slots: Readonly<Record<string, readonly [id: string, at: EpochMillis]>>;
}

function isEvent(x: unknown): x is Event {
  return (
    Array.isArray(x) &&
    x.length === 4 &&
    typeof x[0] === "string" &&
    typeof x[1] === "number" &&
    Number.isFinite(x[1]) &&
    typeof x[2] === "string" &&
    typeof x[3] === "number" &&
    Number.isFinite(x[3])
  );
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const ESSENTIALITY_VALUES: ReadonlySet<string> = new Set(["essential", "semi_discretionary", "discretionary"]);

/** Hash a version-1 (clear-text) row key into its version-2 form. */
function migrateKey(table: TableName, key: string): string {
  if (CATEGORY_KEYED.has(table)) return key;
  if (table === "attribute") {
    const colon = key.indexOf(":");
    return colon < 0 ? storedKey(key) : `${key.slice(0, colon)}:${storedKey(key.slice(colon + 1))}`;
  }
  return storedKey(key);
}

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

export function createUserModel(snapshot?: unknown, opts: UserModelOptions = {}): LearnedUserModel {
  const tables = new Map<TableName, Map<string, Event[]>>(TABLES.map((t) => [t, new Map()]));
  const slots = new Map<string, readonly [string, EpochMillis]>();
  let asOf = 0;
  let halfLifeDays = USER_MODEL_HALF_LIFE_DAYS;

  if (isRecord(snapshot) && (snapshot.version === 1 || snapshot.version === 2)) {
    const legacy = snapshot.version === 1;
    if (typeof snapshot.halfLifeDays === "number" && snapshot.halfLifeDays > 0) halfLifeDays = snapshot.halfLifeDays;
    if (typeof snapshot.asOf === "number" && Number.isFinite(snapshot.asOf)) asOf = snapshot.asOf;
    const rawTables = isRecord(snapshot.tables) ? snapshot.tables : {};
    for (const name of TABLES) {
      const rows = rawTables[name];
      if (!isRecord(rows)) continue;
      for (const [key, events] of Object.entries(rows)) {
        if (!Array.isArray(events)) continue;
        const valid = events.filter(isEvent);
        if (valid.length === 0) continue;
        const target = tables.get(name)!;
        const at = legacy ? migrateKey(name, key) : key;
        target.set(at, [...(target.get(at) ?? []), ...valid.map((e) => [e[0], e[1], e[2], e[3]] as const)]);
      }
    }
    if (isRecord(snapshot.slots)) {
      for (const [slot, v] of Object.entries(snapshot.slots)) {
        if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "number") slots.set(slot, [v[0], v[1]]);
      }
    }
  }
  if (opts.halfLifeDays !== undefined && opts.halfLifeDays > 0) halfLifeDays = opts.halfLifeDays;
  const halfLifeMs = halfLifeDays * DAY;

  function table(name: TableName): Map<string, Event[]> {
    return tables.get(name)!;
  }

  /** Append an event under an already-stored (hashed or category) key. */
  function push(name: TableName, key: string | null, event: Event): void {
    if (!key) return;
    const rows = table(name);
    const events = rows.get(key) ?? [];
    events.push(event);
    if (events.length > MAX_EVENTS_PER_KEY) {
      events.sort((a, b) => a[1] - b[1]);
      events.splice(0, events.length - MAX_EVENTS_PER_KEY);
    }
    rows.set(key, events);
  }

  function forget(assertionId: string): void {
    for (const rows of tables.values()) {
      for (const [key, events] of rows) {
        const kept = events.filter((e) => e[0] !== assertionId);
        if (kept.length === 0) rows.delete(key);
        else if (kept.length !== events.length) rows.set(key, kept);
      }
    }
  }

  function decay(at: EpochMillis, ref: EpochMillis): number {
    const dt = ref - at;
    return dt <= 0 ? 1 : 0.5 ** (dt / halfLifeMs);
  }

  function read<T extends string>(name: TableName, key: string, at?: EpochMillis, allowed?: ReadonlySet<string>): Distribution<T> | null {
    const events = table(name).get(key);
    if (!events || events.length === 0) return null;
    const ref = Math.max(asOf, at ?? asOf);
    const acc = new Map<string, number>();
    for (const [, t, value, weight] of events) {
      if (allowed && !allowed.has(value)) continue;
      acc.set(value, (acc.get(value) ?? 0) + weight * decay(t, ref));
    }
    const total = [...acc.values()].reduce((s, w) => s + w, 0);
    if (total < 1e-6) return null;
    const entries = [...acc.entries()]
      .map(([value, w]) => ({ value: value as T, probability: w / total }))
      .sort((a, b) => b.probability - a.probability || byCodePoint(a.value, b.value));
    return { entries, evidence: total };
  }

  /** Assertions about the same candidate and field supersede each other; this names that slot. */
  function slotOf(a: UserAssertion): string {
    const anchors = a.anchors.length > 0 ? [...a.anchors].sort().join(",") : `#${a.id}`;
    const field = a.kind === "label" ? `label:${a.field}` : a.kind;
    return `${field}|${anchors}`;
  }

  function observe(assertion: UserAssertion, candidate: TransactionCandidate): void {
    if (assertion.kind === "same_event" || assertion.kind === "different_events" || assertion.kind === "satisfaction") return;

    const slot = slotOf(assertion);
    const previous = slots.get(slot);
    if (previous) {
      const [prevId, prevAt] = previous;
      if (prevId === assertion.id) return; // idempotent re-delivery
      const older = prevAt > assertion.at || (prevAt === assertion.at && prevId > assertion.id);
      if (older) return; // a newer answer already replaced this one
      forget(prevId);
    }
    slots.set(slot, [assertion.id, assertion.at]);
    if (assertion.at > asOf) asOf = assertion.at;

    const merchantRaw = candidate.merchant.normalized ? normalizeKey(candidate.merchant.normalized) : "";
    const counterpartyRaw = counterpartyKey(candidate.counterparty);
    const merchant = merchantRaw ? storedKey(merchantRaw) : null;
    const counterparty = counterpartyRaw ? storedKey(counterpartyRaw) : null;
    const keys = [merchant, counterparty];
    const ev = (value: string, weight = 1): Event => [assertion.id, assertion.at, value, weight];
    const toAll = (name: TableName, event: Event, ks: ReadonlyArray<string | null> = keys) => {
      for (const k of new Set(ks)) push(name, k, event);
    };

    if (assertion.kind === "dismiss") {
      // Only "not a transaction" says something about the merchant; "not mine"/"duplicate" do not.
      if (assertion.reason === "not_a_transaction") toAll("existence", ev("not_a_transaction"));
      return;
    }

    toAll("existence", ev("transaction"));
    toAll("labels", ev(assertion.kind === "confirm" ? "confirm" : assertion.field));

    if (assertion.kind === "confirm") {
      // "Yes, that's right" reinforces what was shown — except fields the user already set, which their label counted.
      if (!candidate.category.userSet && candidate.category.confidence > 0 && candidate.category.value !== UNCATEGORIZED) {
        toAll("category", ev(candidate.category.value));
      }
      if (!candidate.transactionType.userSet && candidate.transactionType.confidence > 0 && candidate.transactionType.value !== "unknown") {
        toAll("type", ev(candidate.transactionType.value));
      }
      return;
    }

    switch (assertion.field) {
      case "category":
        toAll("category", ev(assertion.value));
        break;
      case "transaction_type":
        toAll("type", ev(assertion.value));
        if (assertion.transferKind) toAll("transferKind", ev(assertion.transferKind), [counterparty, merchant]);
        break;
      case "essentiality": {
        if (assertion.value === "unknown") break;
        const category = candidate.category.value;
        if (category === UNCATEGORIZED) break;
        // Learned per category, and rolled up to the top level so sibling categories benefit.
        toAll("essentiality", ev(assertion.value), [category, topLevelCategory(category)]);
        break;
      }
      case "ownership":
      case "intent":
      case "temporal_type":
      case "purchase_context":
        toAll("attribute", ev(assertion.value), [merchantRaw || null, counterpartyRaw].map((k) => (k ? attributeKey(assertion.field, k) : null)));
        break;
    }
  }

  function snapshotTables(): SnapshotV2["tables"] {
    const out = {} as Record<TableName, Record<string, readonly Event[]>>;
    for (const name of TABLES) {
      const rows = table(name);
      out[name] = Object.fromEntries(
        [...rows.keys()].sort(byCodePoint).map((k) => [k, rows.get(k)!.map((e) => [e[0], e[1], e[2], e[3]] as const)]),
      );
    }
    return out;
  }

  return {
    halfLifeDays,
    asOf: () => asOf,
    observe,
    categoryFor: (merchantKey, at) => read<CategoryId>("category", storedKey(merchantKey), at),
    typeFor: (key, at) => read<TransactionType>("type", storedKey(key), at),
    transferKindFor: (key, at) => read<TransferKind>("transferKind", storedKey(key), at),
    essentialityFor(category, at) {
      return (
        read<Exclude<Essentiality, "unknown">>("essentiality", category, at, ESSENTIALITY_VALUES) ??
        (topLevelCategory(category) !== category
          ? read<Exclude<Essentiality, "unknown">>("essentiality", topLevelCategory(category), at, ESSENTIALITY_VALUES)
          : null)
      );
    },
    attributeFor: (field, key, at) => read<string>("attribute", attributeKey(field, key), at),
    existenceFor: (key, at) => read<Existence>("existence", storedKey(key), at),
    labelCount(merchantKey: string): number {
      return new Set((table("labels").get(storedKey(merchantKey)) ?? []).map((e) => e[0])).size;
    },
    toJSON(): SnapshotV2 {
      return {
        version: 2,
        halfLifeDays,
        asOf,
        tables: snapshotTables(),
        slots: Object.fromEntries([...slots.keys()].sort(byCodePoint).map((k) => [k, slots.get(k)!])),
      };
    },
  };
}
