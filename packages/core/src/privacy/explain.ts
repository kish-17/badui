import type { CandidateLink, CategoryId, InferenceBasis, TransactionCandidate } from "../model/candidate";
import type { Direction, Observation, ObservationKind, TransactionStatus, TransactionType, TransferKind } from "../model/observation";
import { DAY } from "../model/primitives";
import type { CandidateId, ConnectionId, EpochMillis, LocaleTag, ObservationId } from "../model/primitives";
import type { SignalSourceKind } from "../model/source";
import { localParts } from "../util/time";
import { isOneTimePasswordMessage, maskTail, redactSensitive } from "./redact";
import { isExcerptExpired, retentionAnchor } from "./retention";
import type { ConnectionStatus, Explanation, RetentionPolicy, SourceConnection } from "./types";

/**
 * "How did BRAKE know this?" — provenance made inspectable.
 *
 * Every sentence is built from normalized fields only (observation kind,
 * source kind, instrument type, rail family, inference basis, link kind) plus
 * the human labels the adapters and the user supplied. Nothing here branches
 * on a provider, adapter id, country or OS, so a Pix alert from Nubank and a
 * UPI alert from HDFC Bank are explained by the same code path.
 *
 * Privacy rules for explanations:
 *  - An excerpt is shown only while it is present and unexpired, which can
 *    only be checked when the caller passes `now`.
 *  - OTP messages are never shown; excerpts are re-redacted before display.
 *  - As a final guard every line, whatever field its words came from (labels
 *    and merchant names are free text written by adapters and users), is
 *    redacted again: full card numbers, IBANs and national ids are masked even
 *    when grouped ("4111 1111 1111 1111"), and any run of five or more digits
 *    in any script that is not an amount keeps only its last four ("••••5678").
 */

export interface ExplainOptions {
  readonly locale: LocaleTag;
  /** IANA zone for dates and times. Defaults to "UTC" so output never depends on the host machine. */
  readonly timeZone?: string;
  /** Current time. Needed to show an excerpt: without it expiry cannot be checked, so none is shown. */
  readonly now?: EpochMillis;
  /** Display name of a BRAKE category id (inject the intelligence taxonomy's label). Default: humanized id. */
  readonly categoryLabel?: (id: CategoryId) => string;
  /** Look up a linked candidate (e.g. `FusionEngine.getCandidate`) so links can name its date. */
  readonly resolveCandidate?: (id: CandidateId) => TransactionCandidate | undefined;
  /**
   * The connection's current retention policy (e.g. `id => registry.get(id)?.retention`).
   * When given, an excerpt the user's (possibly shortened) policy no longer
   * allows is hidden even before the next retention pass strips it; a
   * connection with no known policy shows no text, as in `applyRetention`.
   */
  readonly retentionFor?: (connectionId: ConnectionId) => RetentionPolicy | undefined;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Answer "How did BRAKE know this?" for one candidate, given its observations. */
export function explainCandidate(
  candidate: TransactionCandidate,
  observations: readonly Observation[],
  opts: ExplainOptions,
): Explanation {
  const ctx = makeContext(candidate, opts);
  const contributions = contributionsOf(candidate, observations);

  const details: string[] = [];
  for (const k of contributions) {
    details.push(sourceLine(k, candidate, ctx));
    const excerpt = excerptLine(k, opts);
    if (excerpt) details.push(excerpt);
  }
  if (candidate.userVerified) details.push("You confirmed this.");
  const merchant = merchantLine(candidate);
  if (merchant) details.push(merchant);
  details.push(...categoryLines(candidate, contributions, ctx));
  details.push(...typeLines(candidate, contributions));
  details.push(...linkLines(candidate, ctx));

  return {
    headline: guard(headlineFor(contributions, candidate)),
    details: details.map(guard),
  };
}

/** One-line source sentence for settings and lists: "From your HDFC Bank SMS alerts". */
export function explainObservation(o: Observation): string {
  if (o.source.kind === "manual") return "Added by you";
  return guard(`From your ${cleanLabel(o.source.label)}`);
}

export interface DataInventoryEntry {
  readonly connectionId: ConnectionId;
  readonly label: string;
  readonly kind: SignalSourceKind;
  /** `unregistered`: data whose connection the registry does not know — shown, never hidden. */
  readonly status: ConnectionStatus | "unregistered";
  readonly observationCount: number;
  /** Event time (see `retentionAnchor`) of the oldest/newest fact kept; null when nothing is kept. */
  readonly oldestAt: EpochMillis | null;
  readonly newestAt: EpochMillis | null;
  /** Observations that still hold a redacted text excerpt. */
  readonly excerptCount: number;
}

/**
 * "What BRAKE keeps about you", per connection. Connections come first in
 * the given order; data from connections the registry does not know is
 * listed after them (sorted by id) rather than silently omitted.
 */
export function dataInventory(
  connections: readonly SourceConnection[],
  observations: readonly Observation[],
): DataInventoryEntry[] {
  interface Tally {
    count: number;
    oldest: EpochMillis | null;
    newest: EpochMillis | null;
    excerpts: number;
    first: Observation;
  }
  const tallies = new Map<ConnectionId, Tally>();
  for (const o of observations) {
    const at = retentionAnchor(o);
    const t = tallies.get(o.source.connectionId);
    if (!t) {
      tallies.set(o.source.connectionId, { count: 1, oldest: at, newest: at, excerpts: o.evidence.excerpt ? 1 : 0, first: o });
      continue;
    }
    t.count += 1;
    t.oldest = t.oldest === null ? at : Math.min(t.oldest, at);
    t.newest = t.newest === null ? at : Math.max(t.newest, at);
    if (o.evidence.excerpt) t.excerpts += 1;
  }

  const entry = (id: ConnectionId, label: string, kind: SignalSourceKind, status: DataInventoryEntry["status"]): DataInventoryEntry => {
    const t = tallies.get(id);
    return {
      connectionId: id,
      // Shown in settings, so it gets the same masking as every other sentence.
      label: guard(label),
      kind,
      status,
      observationCount: t?.count ?? 0,
      oldestAt: t?.oldest ?? null,
      newestAt: t?.newest ?? null,
      excerptCount: t?.excerpts ?? 0,
    };
  };

  const known = new Set<ConnectionId>();
  const out: DataInventoryEntry[] = [];
  for (const c of connections) {
    if (known.has(c.connectionId)) continue;
    known.add(c.connectionId);
    out.push(entry(c.connectionId, c.label, c.kind, c.status));
  }
  const orphans = [...tallies.keys()].filter((id) => !known.has(id)).sort();
  for (const id of orphans) {
    const first = tallies.get(id)!.first;
    out.push(entry(id, first.source.label, first.source.kind, "unregistered"));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Contributions                                                       */
/* ------------------------------------------------------------------ */

/** One observation's part in a candidate, from the observation itself or (if it is gone) its SourceSignal. */
interface Contribution {
  readonly observationId: ObservationId;
  readonly kind: ObservationKind;
  readonly label: string;
  readonly provider?: string;
  /** The time shown for this source (see `sourceTime`). */
  readonly at: EpochMillis;
  /** True when `at` is when BRAKE received a signal about an event known to be older. */
  readonly received: boolean;
  readonly observation?: Observation;
}

function fromObservation(o: Observation): Contribution {
  return { observationId: o.id, kind: o.kind, label: o.source.label, provider: o.source.provider, ...sourceTime(o), observation: o };
}

/** At or above this occurredAt confidence the time is exact; below it is a date-only value (fusion's `timeSlack` convention). */
const EXACT_TIME_CONFIDENCE = 0.5;

/** A date-only event time further than this before receipt means the signal arrived late (a backfill, a value-dated entry). */
const LATE_ARRIVAL = DAY;

/**
 * When the source says the event happened. Backfills make receipt time
 * misleading: an Amazon email from 11 July fetched when Gmail was connected
 * in October is "11 Jul", not the connection day. An exact `occurredAt` wins,
 * clamped so a wrongly future-dated value cannot move it past receipt. A
 * date-only value is not shown as a time (its zone convention is unknown and
 * would invent a clock time or shift the day), so receipt time is shown and,
 * when the event was clearly earlier, labelled as such ("received 4 Oct").
 */
function sourceTime(o: Observation): { at: EpochMillis; received: boolean } {
  const occurred = o.occurredAt;
  if (occurred === undefined || !Number.isFinite(occurred.value)) return { at: o.receivedAt, received: false };
  if (occurred.confidence >= EXACT_TIME_CONFIDENCE) return { at: Math.min(occurred.value, o.receivedAt), received: false };
  return { at: o.receivedAt, received: o.receivedAt - occurred.value > LATE_ARRIVAL };
}

/**
 * The candidate's own source signals are authoritative for *which*
 * observations contributed (callers may pass a wider set); the observations
 * supply detail. Without source signals, every given observation counts.
 */
function contributionsOf(c: TransactionCandidate, observations: readonly Observation[]): Contribution[] {
  const byId = new Map(observations.map((o) => [o.id, o] as const));
  const raw: Contribution[] =
    c.sourceSignals.length > 0
      ? c.sourceSignals.map((s) => {
          const o = byId.get(s.observationId);
          return o
            ? fromObservation(o)
            : { observationId: s.observationId, kind: s.kind, label: s.sourceLabel, provider: s.provider, at: s.linkedAt, received: false };
        })
      : observations.map(fromObservation);
  // Ties break on the stable observation id, so the answer never depends on the caller's array order.
  return unique(raw, (k) => k.observationId).sort((a, b) => a.at - b.at || compareIds(a.observationId, b.observationId));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isManual(k: Contribution): boolean {
  return k.observation?.source.kind === "manual";
}

/* ------------------------------------------------------------------ */
/* Headline                                                            */
/* ------------------------------------------------------------------ */

/** Noun phrases for documents that explain a payment, by observation kind. */
const DOCUMENT_NOUN: Partial<Record<ObservationKind, string>> = {
  receipt: "receipt",
  invoice: "invoice",
  order: "order confirmation",
  booking: "booking",
  subscription_event: "subscription email",
  refund_notice: "refund notice",
  delivery: "delivery update",
};

/** Which document names the match when several are present: the most specific proof of purchase first. */
const DOCUMENT_PRIORITY: readonly ObservationKind[] = ["receipt", "invoice", "order", "booking", "subscription_event", "refund_notice", "delivery"];

function headlineFor(contributions: readonly Contribution[], c: TransactionCandidate): string {
  if (contributions.length === 0) return "No source details are available for this.";
  if (contributions.every(isManual)) return "You added this yourself.";

  const movements = contributions.filter((k) => k.kind === "money_movement");
  const documents = contributions
    .filter((k) => DOCUMENT_NOUN[k.kind] !== undefined)
    .sort((a, b) => DOCUMENT_PRIORITY.indexOf(a.kind) - DOCUMENT_PRIORITY.indexOf(b.kind));
  const document = documents[0];
  if (movements.length > 0 && document) {
    return `Matched your ${paymentNoun(mostAuthoritative(movements))} with ${withArticle(documentPhrase(document, c))}.`;
  }

  const sources = unique(contributions.map((k) => (isManual(k) ? "own entry" : cleanLabel(k.label))), (s) => s.toLowerCase());
  if (sources.length === 1) return `Detected from your ${sources[0]}.`;
  if (sources.length === 2) return `Detected from your ${sources[0]} and your ${sources[1]}.`;
  return `Detected from your ${sources[0]} and ${sources.length - 1} other sources.`;
}

const STAGE_RANK: Partial<Record<TransactionStatus, number>> = { posted: 3, pending: 2 };

/** Ledger feeds are the account's own books; real-time alerts are reports about them. */
const LEDGER_SOURCES: ReadonlySet<SignalSourceKind> = new Set(["open_banking", "account_aggregator", "neobank_api", "wallet_history"]);

/** The money movement whose description should name the payment: posted > pending > alert, ledger over alert. */
function mostAuthoritative(movements: readonly Contribution[]): Contribution {
  const score = (k: Contribution): number => {
    const o = k.observation;
    if (!o) return 0;
    return (STAGE_RANK[o.stage] ?? 1) * 2 + (LEDGER_SOURCES.has(o.source.kind) ? 1 : 0);
  };
  return movements.reduce((best, k) => (score(k) > score(best) ? k : best));
}

const INSTRUMENT_NOUN: Readonly<Record<string, string>> = {
  card: "card transaction",
  bank_account: "bank transaction",
  upi_handle: "bank transaction",
  wallet: "wallet payment",
  mobile_money: "mobile money payment",
  bnpl: "pay-later purchase",
  cash: "cash payment",
};

const RAIL_NOUN: Readonly<Record<string, string>> = {
  card: "card transaction",
  account_to_account_instant: "bank transaction",
  account_to_account_batch: "bank transaction",
  direct_debit: "direct debit",
  wallet: "wallet payment",
  mobile_money: "mobile money payment",
  bnpl: "pay-later purchase",
  cash: "cash payment",
  cheque: "cheque payment",
};

const SOURCE_NOUN: Partial<Record<SignalSourceKind, string>> = {
  card_feed: "card transaction",
  issuer_webhook: "card transaction",
  os_wallet: "card transaction",
  wallet_history: "wallet payment",
};

/** "bank transaction", "card transaction", "mobile money payment" — from instrument, rail and source family. */
function paymentNoun(k: Contribution): string {
  const o = k.observation;
  if (!o) return "bank transaction";
  if (o.source.kind === "manual") return "own entry";
  return (
    (o.instrument && INSTRUMENT_NOUN[o.instrument.type]) ??
    (o.rail && RAIL_NOUN[o.rail.family]) ??
    SOURCE_NOUN[o.source.kind] ??
    "bank transaction"
  );
}

/** "Amazon receipt", "Netflix subscription email", or just "invoice" when no merchant is known. */
function documentPhrase(k: Contribution, c: TransactionCandidate): string {
  const noun = DOCUMENT_NOUN[k.kind] ?? "message";
  const merchant = documentMerchant(k, c);
  return merchant ? `${merchant} ${noun}` : noun;
}

function documentMerchant(k: Contribution, c: TransactionCandidate): string | null {
  const name = k.observation?.merchant?.name ?? c.merchant.displayName ?? k.provider;
  const clean = name?.trim();
  return clean ? clean : null;
}

/* ------------------------------------------------------------------ */
/* Source lines and excerpts                                           */
/* ------------------------------------------------------------------ */

function sourceLine(k: Contribution, c: TransactionCandidate, ctx: Context): string {
  const what = thingPhrase(k, c);
  const when = `${k.received ? "received " : ""}${ctx.when(k.at)}`;
  return isManual(k) ? `Added by you: ${what}, ${when}.` : `From your ${cleanLabel(k.label)}: ${what}, ${when}.`;
}

/** What the observation was, with its article: "a pending payment", "an Amazon receipt". */
function thingPhrase(k: Contribution, c: TransactionCandidate): string {
  switch (k.kind) {
    case "money_movement": {
      const direction = k.observation?.direction ?? c.direction;
      const base = direction === "credit" ? "credit" : direction === "debit" ? "payment" : "transaction";
      const stage = k.observation?.stage;
      const prefix = stage === "pending" ? "pending " : stage === "posted" ? "posted " : stage === "cancelled" ? "reversed " : "";
      return withArticle(prefix + base);
    }
    case "purchase_intent":
      return "a purchase you were considering";
    case "checkout":
      return "a checkout";
    case "mandate":
      return "a recurring payment mandate";
    case "balance_snapshot":
      return "a balance update";
    case "app_context":
      return "app activity";
    default:
      return withArticle(documentPhrase(k, c));
  }
}

const EXCERPT_MAX = 200;

function excerptLine(k: Contribution, opts: ExplainOptions): string | null {
  const o = k.observation;
  const text = o?.evidence.excerpt;
  const expires: unknown = o?.evidence.excerptExpiresAt;
  const now = opts.now;
  // Fail closed: no clock, or no usable expiry, means BRAKE cannot prove the excerpt may still be shown.
  if (!o || !text || now === undefined || typeof expires !== "number" || !Number.isFinite(expires) || expires <= now) return null;
  if (opts.retentionFor) {
    const policy = opts.retentionFor(o.source.connectionId);
    if (!policy || isExcerptExpired(o, policy, now)) return null;
  }
  if (isOneTimePasswordMessage(text)) return null;
  const clean = redactSensitive(text).text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const shown = clean.length > EXCERPT_MAX ? `${clean.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : clean;
  return `Excerpt: “${shown}”`;
}

/* ------------------------------------------------------------------ */
/* Merchant, category and type                                         */
/* ------------------------------------------------------------------ */

/** Explains a non-obvious merchant name: "Shown as Amazon (listed as “AMZN PAY INDIA”)." */
function merchantLine(c: TransactionCandidate): string | null {
  const display = c.merchant.displayName?.trim();
  const raw = c.merchant.raw?.trim();
  if (!display || !raw) return null;
  const d = comparable(display);
  const r = comparable(raw);
  if (!d || !r || r.includes(d) || d.includes(r)) return null;
  const listed = redactSensitive(raw).text;
  return `Shown as ${display} (listed as “${listed.length > 60 ? `${listed.slice(0, 59)}…` : listed}”).`;
}

function comparable(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

type Connector = "because" | "based on";

interface Reason {
  readonly connector: Connector;
  readonly text: string;
}

/** Facts about the candidate's evidence that inference bases refer to. */
interface ReasonFacts {
  readonly name: string | null;
  readonly hasMcc: boolean;
  /** Label of a source that supplied a non-MCC category (an aggregator's category, a provider's type). */
  readonly categoryHintSource: string | null;
  readonly typeHintSource: string | null;
  /** "Amazon order", "receipt" — the document that listed items. */
  readonly itemsDocument: string | null;
}

const ITEMS_NOUN: Partial<Record<ObservationKind, string>> = {
  order: "order",
  receipt: "receipt",
  invoice: "invoice",
  booking: "booking",
  subscription_event: "subscription",
};

function reasonFacts(c: TransactionCandidate, contributions: readonly Contribution[]): ReasonFacts {
  const obs = contributions.map((k) => k.observation).filter((o): o is Observation => o !== undefined);
  const hasMcc =
    Boolean(c.merchant.mcc) ||
    obs.some((o) => Boolean(o.merchant?.mcc) || (o.categoryHints ?? []).some((h) => h.scheme.toLowerCase() === "mcc")) ||
    c.provenance.some((p) => p.field === "category" && /^mcc\b/i.test(p.note ?? ""));
  const categoryHinted = contributions.find((k) => (k.observation?.categoryHints ?? []).some((h) => h.scheme.toLowerCase() !== "mcc"));
  const typeHinted = contributions.find((k) => (k.observation?.typeHints ?? []).length > 0);
  const itemized = contributions.find((k) => (k.observation?.lineItems ?? []).length > 0);
  let itemsDocument: string | null = null;
  if (itemized) {
    const noun = ITEMS_NOUN[itemized.kind] ?? "purchase details";
    const merchant = documentMerchant(itemized, c);
    itemsDocument = merchant ? `${merchant} ${noun}` : noun;
  }
  return {
    name: c.merchant.displayName?.trim() || c.counterparty?.name?.trim() || null,
    hasMcc,
    categoryHintSource: categoryHinted ? cleanLabel(categoryHinted.label) : null,
    typeHintSource: typeHinted ? cleanLabel(typeHinted.label) : null,
    itemsDocument,
  };
}

/** Reasons shared by category and type explanations. */
function commonReason(b: InferenceBasis, f: ReasonFacts): Reason | null {
  switch (b) {
    case "user_label":
      return { connector: "because", text: "you labelled it" };
    case "merchant_profile":
      return { connector: "based on", text: `what BRAKE knows about ${f.name ?? "this merchant"}` };
    case "line_items":
      return { connector: "based on", text: f.itemsDocument ? `the items in your ${f.itemsDocument}` : "the items listed for this purchase" };
    case "reconciliation":
      return { connector: "because", text: "it matched another of your transactions" };
    case "recurrence":
      return { connector: "because", text: "it repeats on a regular schedule" };
    case "rule":
      return { connector: "because", text: "a rule you set applies" };
    case "prior":
      return { connector: "based on", text: "what's typical for payments like this" };
    default:
      return null;
  }
}

function categoryReason(b: InferenceBasis, label: string, f: ReasonFacts): Reason | null {
  if (b === "user_history") {
    return { connector: "because", text: `you've labelled ${f.name ?? "similar payments"} as ${label} before` };
  }
  if (b === "source_hint") {
    if (f.hasMcc) return { connector: "based on", text: "the merchant's category code" };
    if (f.categoryHintSource) return { connector: "based on", text: `the category from your ${f.categoryHintSource}` };
    return { connector: "based on", text: "the category the source reported" };
  }
  return commonReason(b, f);
}

function typeReason(b: InferenceBasis, c: TransactionCandidate, f: ReasonFacts): Reason | null {
  if (b === "user_history") {
    const preposition = c.direction === "credit" ? "from" : "to";
    return { connector: "because", text: f.name ? `you've marked payments ${preposition} ${f.name} this way before` : "you've marked similar payments this way before" };
  }
  if (b === "source_hint") {
    if (f.typeHintSource) return { connector: "based on", text: `how your ${f.typeHintSource} described it` };
    if (f.hasMcc) return { connector: "based on", text: "the merchant's category code" };
    return { connector: "based on", text: "how the source described it" };
  }
  return commonReason(b, f);
}

/** "because A and B, and based on C" — reasons grouped by connector, duplicates removed. */
function joinReasons(reasons: readonly Reason[]): string {
  const groups = new Map<Connector, string[]>();
  for (const r of reasons) {
    const texts = groups.get(r.connector) ?? [];
    if (!texts.includes(r.text)) texts.push(r.text);
    groups.set(r.connector, texts);
  }
  return [...groups].map(([connector, texts]) => `${connector} ${joinAnd(texts)}`).join(", and ");
}

const LOW_CONFIDENCE = 0.6;
const HIGH_CONFIDENCE = 0.85;
/** Alternatives at least this likely are mentioned, so a guess is never presented as the only possibility. */
const ALTERNATIVE_WORTH_MENTIONING = 0.2;

function categoryLines(c: TransactionCandidate, contributions: readonly Contribution[], ctx: Context): string[] {
  const inf = c.category;
  const label = ctx.categoryLabel(inf.value);
  if (inf.userSet) return [`You labelled this as ${label}.`];
  if (inf.value === "uncategorized" || inf.confidence <= 0) return [];

  const facts = reasonFacts(c, contributions);
  const reasons = inf.basis.map((b) => categoryReason(b, label, facts)).filter((r): r is Reason => r !== null);
  const lines = [reasons.length > 0 ? `Categorised as ${label} ${joinReasons(reasons)}.` : `Categorised as ${label}.`];
  if (inf.confidence < LOW_CONFIDENCE) lines.push("BRAKE isn't sure about this category yet.");
  const alt = inf.alternatives.find((a) => a.value !== "uncategorized" && a.value !== inf.value);
  if (alt && alt.probability >= ALTERNATIVE_WORTH_MENTIONING) lines.push(`It could also be ${ctx.categoryLabel(alt.value)}.`);
  return lines;
}

const TYPE_PHRASE: Readonly<Record<TransactionType, string>> = {
  purchase: "a purchase",
  transfer: "a transfer",
  refund: "a refund",
  subscription: "a subscription payment",
  cash_withdrawal: "a cash withdrawal",
  income: "income",
  loan_payment: "a loan payment",
  credit_card_payment: "a credit card bill payment",
  investment: "an investment",
  reimbursement: "a reimbursement",
  shared_expense: "a shared expense",
  business_expense: "a business expense",
  fee: "a fee",
  tax: "a tax payment",
  unknown: "an unclassified payment",
};

/**
 * Transfers to and from other people read differently by direction: money
 * received from Mum is not "a transfer to family".
 */
const TRANSFER_PHRASE: Readonly<Record<Direction | "unknown", Readonly<Record<TransferKind, string>>>> = {
  debit: {
    own_account: "a transfer between your own accounts",
    wallet_load: "a wallet top-up",
    family: "a transfer to family",
    p2p_other: "a transfer to someone else",
    unknown: "a transfer",
  },
  credit: {
    own_account: "a transfer between your own accounts",
    wallet_load: "a wallet top-up",
    family: "a transfer from family",
    p2p_other: "a transfer from someone else",
    unknown: "a transfer",
  },
  unknown: {
    own_account: "a transfer between your own accounts",
    wallet_load: "a wallet top-up",
    family: "a family transfer",
    p2p_other: "a transfer with someone else",
    unknown: "a transfer",
  },
};

function typePhrase(t: TransactionType, direction: TransactionCandidate["direction"], transferKind?: TransferKind): string {
  return t === "transfer" && transferKind ? TRANSFER_PHRASE[direction][transferKind] : TYPE_PHRASE[t];
}

function typeLines(c: TransactionCandidate, contributions: readonly Contribution[]): string[] {
  const inf = c.transactionType;
  const phrase = typePhrase(inf.value, c.direction, c.transferKind);
  if (inf.userSet) return [`You marked this as ${phrase}.`];
  if (inf.value === "unknown" || inf.confidence <= 0) return [];

  const facts = reasonFacts(c, contributions);
  const reasons = inf.basis.map((b) => typeReason(b, c, facts)).filter((r): r is Reason => r !== null);
  const lines = [reasons.length > 0 ? `Treated as ${phrase} ${joinReasons(reasons)}.` : `Treated as ${phrase}.`];
  if (inf.confidence < LOW_CONFIDENCE) lines.push("BRAKE isn't sure what kind of payment this is yet.");
  const alt = inf.alternatives.find((a) => a.value !== "unknown" && a.value !== inf.value);
  if (alt && alt.probability >= ALTERNATIVE_WORTH_MENTIONING) lines.push(`It could also be ${typePhrase(alt.value, c.direction)}.`);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Reconciliation links                                                */
/* ------------------------------------------------------------------ */

/** Confidence-aware lead: certain links are stated, likely ones hedged, weak ones asked about. */
function lead(p: number): string {
  return p >= HIGH_CONFIDENCE ? "Matched as" : p >= LOW_CONFIDENCE ? "Looks like" : "Might be";
}

function linkedLead(p: number): string {
  return p >= HIGH_CONFIDENCE ? "Linked to" : p >= LOW_CONFIDENCE ? "Looks linked to" : "Might be linked to";
}

/** One line per distinct relation; two links that read the same (e.g. two possible duplicates) are said once. */
function linkLines(c: TransactionCandidate, ctx: Context): string[] {
  const lines: string[] = [];
  for (const l of c.links) {
    const line = linkLine(l, c, ctx);
    if (line) lines.push(line);
  }
  return unique(lines);
}

function linkLine(l: CandidateLink, c: TransactionCandidate, ctx: Context): string | null {
  // Recurring links point at a series id, not a candidate.
  const target = l.kind === "recurring_series" ? undefined : ctx.resolveCandidate(l.target);
  const date = target ? ctx.date(target.timestampEstimated) : null;
  const yourPurchase = date ? `your ${date} purchase` : "an earlier purchase";
  switch (l.kind) {
    case "refund_of":
      return `${lead(l.probability)} a refund of ${yourPurchase}.`;
    case "refunded_by":
      return `${lead(l.probability)} a purchase that was refunded${date ? ` on ${date}` : " later"}.`;
    case "reimbursement_of":
      return `${lead(l.probability)} a reimbursement for ${yourPurchase}.`;
    case "transfer_counterpart":
      return `${lead(l.probability)} one side of a transfer between your accounts${date ? ` (the other side is from ${date})` : ""}.`;
    case "card_payment_for":
      return `${lead(l.probability)} a payment towards your card bill.`;
    case "recurring_series":
      return `${lead(l.probability)} part of a recurring payment.`;
    case "intent_outcome":
      return c.status === "intent"
        ? `${linkedLead(l.probability)} ${date ? `your ${date} purchase` : "a later purchase"}.`
        : `${linkedLead(l.probability)} a purchase you were considering${date ? ` on ${date}` : ""}.`;
    case "possible_duplicate":
      return `This might be the same payment as another one${date ? ` from ${date}` : ""}, so BRAKE is keeping them separate for now.`;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Formatting context                                                  */
/* ------------------------------------------------------------------ */

interface Context {
  /** "2 Oct" (en-IN) / "Oct 2" (en-US); the year is added when it differs from the candidate's. */
  date(at: EpochMillis): string;
  /** "4 Oct at 10:41 am". */
  when(at: EpochMillis): string;
  categoryLabel(id: CategoryId): string;
  resolveCandidate(id: CandidateId): TransactionCandidate | undefined;
}

function makeContext(c: TransactionCandidate, opts: ExplainOptions): Context {
  const timeZone = validTimeZone(opts.timeZone ?? "UTC");
  const locale = validLocale(opts.locale);
  const dayMonth = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" });
  const dayMonthYear = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", year: "numeric" });
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const referenceYear = localParts(c.timestampEstimated, timeZone).year;
  const date = (at: EpochMillis): string =>
    (localParts(at, timeZone).year === referenceYear ? dayMonth : dayMonthYear).format(new Date(at));
  return {
    date,
    when: (at) => `${date(at)} at ${clock.format(new Date(at))}`,
    categoryLabel: opts.categoryLabel ?? humanizeCategory,
    resolveCandidate: opts.resolveCandidate ?? (() => undefined),
  };
}

function validTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function validLocale(locale: LocaleTag): LocaleTag {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : "en";
  } catch {
    return "en";
  }
}

/** "eating_out" -> "Eating out", "shopping.online_marketplace" -> "Online marketplace". */
function humanizeCategory(id: CategoryId): string {
  const leaf = id.slice(id.lastIndexOf(".") + 1).replace(/_/g, " ").trim();
  return leaf ? leaf.charAt(0).toUpperCase() + leaf.slice(1) : "Other";
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Labels are noun phrases written to follow "your"; tolerate ones that already start with it. */
function cleanLabel(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim().replace(/^your\s+/i, "");
  return clean || "connected source";
}

/** Letters whose spoken names start with a vowel sound ("an HDFC", "an SBI", but "a UPI"). */
const AN_LETTERS = new Set(["A", "E", "F", "H", "I", "L", "M", "N", "O", "R", "S", "X"]);

/** "an Amazon receipt", "a Uniqlo receipt", "an HDFC Bank alert", "a UPI payment", "an M-Pesa receipt", "an 8-item order". */
function withArticle(phrase: string): string {
  return `${indefiniteArticle(phrase)} ${phrase}`;
}

function indefiniteArticle(phrase: string): "a" | "an" {
  const word = phrase.trim().split(/[\s-]/)[0] ?? "";
  if (/^\d/.test(word)) return /^(?:8|11(?!\d)|18(?!\d))/.test(word) ? "an" : "a";
  const letters = word.replace(/[^A-Za-z]/g, "");
  if (!letters) return "a";
  // Read letter by letter: acronyms ("HDFC", "UPI") and single capitals before a hyphen or digit ("M-Pesa", "T-Mobile", "O2").
  const isSpelledOut = letters === letters.toUpperCase() && (letters.length <= 3 || !/[AEIOU]/.test(letters));
  if (isSpelledOut) return AN_LETTERS.has(letters[0]!) ? "an" : "a";
  const lower = letters.toLowerCase();
  if (/^(?:hour|honest|honou?r|heir)/.test(lower)) return "an";
  if (/^(?:uni(?!n)|use|usu|uti|ubiq|eu|ewe|one|once)/.test(lower)) return "a";
  return /^[aeiou]/.test(lower) ? "an" : "a";
}

/** A currency marker right before a digit run means the run is an amount, which may be shown. */
const CURRENCY_BEFORE = /(?:(?<![a-z])(?:rs\.?|inr|usd|eur|gbp|brl|kes|ksh\.?|ngn|idr|rp\.?|us\$|r\$)|[₹$€£¥₦₱฿₫₩])\s?$/i;

/**
 * Final privacy guard on every user-facing line. Labels and names are free
 * text, so a full card number, IBAN or national id can arrive in any field,
 * often grouped in blocks of four that no single digit run reveals.
 */
function guard(text: string): string {
  return scrubDigits(redactSensitive(maskIbans(text)).text);
}

/**
 * IBAN-shaped tokens ("DE89 3704 0044 0532 0130 00", "GB29NWBK60161331926819")
 * keep only their last four characters. The BBAN must carry at least eight
 * digits, so upper-case words and short payment codes ("QK12AB34CD") are left alone.
 */
function maskIbans(text: string): string {
  return text.replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?\b/g, (m: string) =>
    (m.slice(4).match(/\d/g) ?? []).length >= 8 ? maskTail(m) : m,
  );
}

/**
 * Digit runs of five or more, in any script (Arabic-Indic and Devanagari
 * digits included), that are not amounts keep only their last four digits.
 */
function scrubDigits(text: string): string {
  return text.replace(/\p{Nd}{5,}/gu, (run: string, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 5), offset);
    const after = whole.slice(offset + run.length, offset + run.length + 5);
    const isAmount = CURRENCY_BEFORE.test(before) || /^[.,]\p{Nd}{2,3}(?!\p{Nd})/u.test(after);
    return isAmount ? run : maskTail(run);
  });
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function unique<T>(items: readonly T[], key: (t: T) => unknown = (t) => t): T[] {
  const seen = new Set<unknown>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
