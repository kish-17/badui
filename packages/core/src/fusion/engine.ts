import type { UserAssertion } from "../model/assertion";
import type { CandidateLink, TransactionCandidate } from "../model/candidate";
import type { Observation } from "../model/observation";
import { DAY, HOUR } from "../model/primitives";
import type { CandidateId, Clock, EpochMillis, ObservationId, Probability } from "../model/primitives";
import {
  EVENT_REFERENCE_TYPES,
  assessPair,
  comparableAmounts,
  isContextOnly,
  maxAmountTolerance,
  maxPairWindowMs,
  referenceKey,
  timeOf,
} from "./match";
import type { PairAssessment } from "./match";
import { candidateIdFor, composeCandidate, finalizeCandidate, mergePatches } from "./merge";
import type { ComposedCandidate } from "./merge";
import { defaultMerchantMatcher } from "./merchant";
import type {
  CandidatePatch,
  FusionConfig,
  FusionDecision,
  FusionEngine,
  FusionEngineOptions,
  FusionSnapshot,
  MatchAssessment,
  MerchantMatcher,
  RemovalResult,
} from "./types";

/**
 * The fusion engine: decides which observations describe the same financial
 * event and keeps one TransactionCandidate per event.
 *
 * State model. Observations (in ingest order), user assertions and
 * intelligence patches are the source of truth; clusters, indexes and
 * candidates are derived. Ingest is incremental, while anything that can
 * change cluster membership retroactively (same/different-event assertions,
 * dismissals, removing observations) rebuilds by replaying the observations in
 * their original order. Because every rule is a pure function of observation
 * data and assertions, incremental ingest and replay give identical results —
 * which is what makes source disconnects reversible and snapshots exact.
 *
 * Blocking. An incoming observation is compared only with candidates found
 * through two indexes: event references (order ids, RRNs, ledger ids,
 * pending↔posted links) and currency + log-scale amount bucket + day. There is
 * no scan over history.
 */

export const DEFAULT_FUSION_CONFIG: FusionConfig = Object.freeze({
  linkThreshold: 0.9,
  possibleThreshold: 0.5,
  ambiguityMargin: 0.15,
  priorLogOdds: Math.log(0.1 / 0.9),
  intentHorizonMs: 24 * HOUR,
  pendingToPostedTolerance: 0.3,
  approximateAmountTolerance: 0.15,
});

export function createFusionEngine(opts: FusionEngineOptions): FusionEngine {
  return new Engine(opts);
}

/**
 * Rebuild an engine from a persisted snapshot. Patches keep their original
 * anchors and order, so the restored candidates are identical to the ones the
 * snapshot was taken from.
 */
export function restoreFusionEngine(snapshot: FusionSnapshot, opts: FusionEngineOptions): FusionEngine {
  if (snapshot.version !== 1) throw new RangeError(`Unsupported fusion snapshot version: ${String(snapshot.version)}`);
  const engine = new Engine(opts);
  engine.load(snapshot);
  return engine;
}

/* ------------------------------------------------------------------ */
/* Index keys                                                          */
/* ------------------------------------------------------------------ */

const BUCKET_LOG_BASE = Math.log(1.1);

/** Log-scale amount bucket: ~10% wide, so a relative tolerance maps to a few neighbouring buckets. */
function amountBucket(minor: number): number {
  return minor <= 0 ? 0 : Math.floor(Math.log(minor) / BUCKET_LOG_BASE) + 1;
}

function dayOf(t: EpochMillis): number {
  return Math.floor(t / DAY);
}

/** Keys under which a member observation is found by reference. */
function memberReferenceKeys(o: Observation): string[] {
  return o.references.filter((r) => EVENT_REFERENCE_TYPES.has(r.type) || r.type === "provider_pending_id").map((r) => referenceKey(r));
}

/**
 * Keys an incoming observation looks up: its own event references, plus the
 * pending↔posted cross-links (a posted record's provider_pending_id finds the
 * pending record's provider_transaction_id, and vice versa).
 */
function lookupReferenceKeys(o: Observation): string[] {
  const keys: string[] = [];
  for (const r of o.references) {
    if (EVENT_REFERENCE_TYPES.has(r.type)) keys.push(referenceKey(r));
    if (r.type === "provider_pending_id") keys.push(referenceKey(r, "provider_transaction_id"));
    if (r.type === "provider_transaction_id") keys.push(referenceKey(r, "provider_pending_id"));
  }
  return keys;
}

function memberAmountKeys(o: Observation): string[] {
  const day = dayOf(timeOf(o));
  return comparableAmounts(o).map((m) => `${m.currency}|${amountBucket(m.minor)}|${day}`);
}

function lookupAmountKeys(o: Observation, config: FusionConfig): string[] {
  const tolerance = maxAmountTolerance(config);
  // One extra day either side covers date-only value dates.
  const window = maxPairWindowMs(config) + DAY;
  const t = timeOf(o);
  const firstDay = dayOf(t - window);
  const lastDay = dayOf(t + window);
  const keys: string[] = [];
  for (const m of comparableAmounts(o)) {
    const lo = amountBucket(Math.max(0, Math.floor(m.minor / (1 + tolerance)) - 1));
    const hi = amountBucket(Math.ceil(m.minor * (1 + tolerance)) + 1);
    for (let b = lo; b <= hi; b++) for (let d = firstDay; d <= lastDay; d++) keys.push(`${m.currency}|${b}|${d}`);
  }
  return keys;
}

function addToIndex(index: Map<string, Set<CandidateId>>, key: string, id: CandidateId): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(id);
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

interface Cluster {
  readonly id: CandidateId;
  /** Creation order; breaks ties deterministically. */
  readonly seq: number;
  /** Member observation ids in ingest order; the first founded the cluster. */
  members: ObservationId[];
  readonly matchProbabilities: Map<ObservationId, Probability>;
  /** possible_duplicate links fusion recorded when this cluster was founded. */
  links: CandidateLink[];
}

type Evaluation = {
  readonly kind: "forced" | "veto" | "blocked" | "scored";
  readonly assessment: MatchAssessment;
};

type Relation = "must" | "cannot";

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function affectsMembership(a: UserAssertion): boolean {
  return a.kind === "same_event" || a.kind === "different_events" || a.kind === "dismiss";
}

class Engine implements FusionEngine {
  private readonly clock: Clock;
  private readonly config: FusionConfig;
  private readonly matcher: MerchantMatcher;

  // Source of truth.
  private readonly observationsById = new Map<ObservationId, Observation>();
  private readonly ingestOrder = new Map<ObservationId, number>();
  private ingestCounter = 0;
  private assertionList: UserAssertion[] = [];
  private readonly patches = new Map<ObservationId, { readonly seq: number; readonly patch: CandidatePatch }>();
  private patchCounter = 0;

  // Derived from assertions.
  private relations = new Map<ObservationId, Map<ObservationId, Relation>>();
  private dismissedAt = new Map<ObservationId, EpochMillis>();
  private assertionsByAnchor = new Map<ObservationId, number[]>();

  // Derived from observations (rebuilt by replay).
  private readonly clusters = new Map<CandidateId, Cluster>();
  private readonly clusterOf = new Map<ObservationId, CandidateId>();
  private readonly contextIds = new Set<ObservationId>();
  private readonly orphanDeliveries = new Map<string, ObservationId[]>();
  private readonly referenceIndex = new Map<string, Set<CandidateId>>();
  private readonly amountIndex = new Map<string, Set<CandidateId>>();
  private clusterCounter = 0;
  private readonly cache = new Map<CandidateId, ComposedCandidate>();

  constructor(opts: FusionEngineOptions) {
    this.clock = opts.clock;
    this.config = { ...DEFAULT_FUSION_CONFIG, ...opts.config };
    this.matcher = opts.merchantMatcher ?? defaultMerchantMatcher;
  }

  /* ---------------------------- public API --------------------------- */

  ingest(observation: Observation): FusionDecision {
    if (this.observationsById.has(observation.id)) {
      const candidateId = this.clusterOf.get(observation.id);
      return { observationId: observation.id, outcome: "duplicate_delivery", ...(candidateId ? { candidateId } : {}), possibleMatches: [] };
    }
    this.observationsById.set(observation.id, observation);
    this.ingestOrder.set(observation.id, this.ingestCounter++);
    return this.fuse(observation);
  }

  applyAssertion(assertion: UserAssertion): readonly CandidateId[] {
    const previous = this.assertionList.find((a) => a.id === assertion.id);
    this.assertionList = [...this.assertionList.filter((a) => a.id !== assertion.id), assertion];
    this.reindexAssertions();
    const anchors = new Set([...assertion.anchors, ...(previous?.anchors ?? [])]);
    if (affectsMembership(assertion) || (previous !== undefined && affectsMembership(previous))) {
      const before = this.renderAll();
      this.rebuild();
      const after = this.renderAll();
      const changed = new Set([...this.clustersContaining(anchors), ...[...after.keys()].filter((id) => before.get(id) !== after.get(id))]);
      const current = [...this.clusters.values()].filter((c) => changed.has(c.id)).map((c) => c.id);
      const vanished = [...before.keys()].filter((id) => !after.has(id)).sort(compareIds);
      return [...current, ...vanished];
    }
    const affected = this.clustersContaining(anchors);
    for (const id of affected) this.cache.delete(id);
    return affected;
  }

  removeObservations(predicate: (o: Observation) => boolean): RemovalResult {
    const removed = [...this.observationsById.values()].filter(predicate).map((o) => o.id);
    if (removed.length === 0) return { removedObservationIds: [], deletedCandidateIds: [], updatedCandidateIds: [] };
    const gone = new Set(removed);
    const before = this.renderAll();
    this.reanchorPatches(gone);
    for (const id of removed) {
      this.observationsById.delete(id);
      this.ingestOrder.delete(id);
    }
    this.rebuild();
    const after = this.renderAll();
    return {
      removedObservationIds: removed,
      deletedCandidateIds: [...before.keys()].filter((id) => !after.has(id)),
      updatedCandidateIds: [...after.keys()].filter((id) => before.get(id) !== after.get(id)),
    };
  }

  patchCandidate(id: CandidateId, patch: CandidatePatch): TransactionCandidate {
    const cluster = this.clusters.get(id);
    const anchor = cluster?.members[0];
    if (!cluster || anchor === undefined) throw new RangeError(`Unknown candidate: ${id}`);
    const previous = this.patches.get(anchor);
    this.patches.set(anchor, { seq: ++this.patchCounter, patch: previous ? mergePatches(previous.patch, patch) : patch });
    this.cache.delete(id);
    return this.read(cluster);
  }

  getCandidate(id: CandidateId): TransactionCandidate | undefined {
    const cluster = this.clusters.get(id);
    return cluster ? this.read(cluster) : undefined;
  }

  findCandidateByObservation(id: ObservationId): TransactionCandidate | undefined {
    const candidateId = this.clusterOf.get(id);
    return candidateId ? this.getCandidate(candidateId) : undefined;
  }

  listCandidates(): readonly TransactionCandidate[] {
    const now = this.clock.now();
    return [...this.clusters.values()]
      .filter((c) => !this.isDismissed(c))
      .map((c) => finalizeCandidate(this.composed(c), now))
      .sort((a, b) => b.timestampEstimated - a.timestampEstimated || b.createdAt - a.createdAt || compareIds(a.id, b.id));
  }

  observationsOf(id: CandidateId): readonly Observation[] {
    return this.membersOf(this.clusters.get(id));
  }

  contextObservations(): readonly Observation[] {
    return [...this.observationsById.values()].filter((o) => this.contextIds.has(o.id));
  }

  assertions(): readonly UserAssertion[] {
    return [...this.assertionList];
  }

  assess(observation: Observation, candidateId: CandidateId): MatchAssessment {
    const cluster = this.clusters.get(candidateId);
    if (!cluster) throw new RangeError(`Unknown candidate: ${candidateId}`);
    return this.evaluate(observation, cluster).assessment;
  }

  snapshot(): FusionSnapshot {
    return {
      version: 1,
      observations: [...this.observationsById.values()],
      assertions: [...this.assertionList],
      patches: [...this.patches.entries()]
        .sort((a, b) => a[1].seq - b[1].seq)
        .map(([anchor, entry]) => ({ anchor, patch: entry.patch })),
    };
  }

  /** Load a snapshot into an empty engine (see restoreFusionEngine). */
  load(snapshot: FusionSnapshot): void {
    for (const o of snapshot.observations) {
      if (this.observationsById.has(o.id)) continue;
      this.observationsById.set(o.id, o);
      this.ingestOrder.set(o.id, this.ingestCounter++);
    }
    for (const a of snapshot.assertions) this.assertionList = [...this.assertionList.filter((x) => x.id !== a.id), a];
    this.reindexAssertions();
    for (const { anchor, patch } of snapshot.patches) {
      const previous = this.patches.get(anchor);
      this.patches.set(anchor, { seq: ++this.patchCounter, patch: previous ? mergePatches(previous.patch, patch) : patch });
    }
    this.rebuild();
  }

  /* ------------------------------ fusion ----------------------------- */

  private fuse(o: Observation): FusionDecision {
    if (isContextOnly(o)) {
      this.contextIds.add(o.id);
      return { observationId: o.id, outcome: "context", possibleMatches: [] };
    }

    const evaluations = this.retrieve(o).map((cluster) => ({ cluster, ev: this.evaluate(o, cluster) }));

    const forced = evaluations.filter((e) => e.ev.kind === "forced");
    const firstForced = forced[0];
    if (firstForced) {
      const target = this.mergeForced(forced.map((e) => e.cluster));
      this.addMember(target, o, 1);
      return { observationId: o.id, outcome: "linked", candidateId: target.id, matchProbability: 1, possibleMatches: [], assessment: firstForced.ev.assessment };
    }

    const p = (e: { readonly ev: Evaluation }): Probability => e.ev.assessment.probability;
    const scored = evaluations.filter((e) => e.ev.kind === "scored").sort((a, b) => p(b) - p(a) || a.cluster.seq - b.cluster.seq);
    const { linkThreshold, possibleThreshold, ambiguityMargin } = this.config;
    const best = scored[0];
    const runnerUp = scored[1];
    const asMatch = (e: { readonly cluster: Cluster; readonly ev: Evaluation }) => ({ candidateId: e.cluster.id, probability: p(e) });

    if (best && p(best) >= linkThreshold && (!runnerUp || p(best) - p(runnerUp) > ambiguityMargin)) {
      this.addMember(best.cluster, o, p(best));
      return {
        observationId: o.id,
        outcome: "linked",
        candidateId: best.cluster.id,
        matchProbability: p(best),
        possibleMatches: scored.slice(1).filter((e) => p(e) >= possibleThreshold).map(asMatch),
        assessment: best.ev.assessment,
      };
    }

    // Never merge when uncertain: either several candidates match about equally
    // well (ambiguous) or the best match is only plausible (possible duplicate).
    const ambiguous = best !== undefined && p(best) >= linkThreshold;
    const related = scored.filter((e) => p(e) >= possibleThreshold && (!ambiguous || (best !== undefined && p(best) - p(e) <= ambiguityMargin)));
    const assessment = best ? { assessment: best.ev.assessment } : {};

    if (o.kind === "delivery") {
      // Join-only: a delivery whose order BRAKE has not seen waits as context.
      this.contextIds.add(o.id);
      for (const r of o.references) {
        if (r.type !== "order_id") continue;
        const key = referenceKey(r);
        this.orphanDeliveries.set(key, [...(this.orphanDeliveries.get(key) ?? []), o.id]);
      }
      return { observationId: o.id, outcome: "context", possibleMatches: related.map(asMatch), ...assessment };
    }

    const links: CandidateLink[] = related.map((e) => ({
      kind: "possible_duplicate",
      target: e.cluster.id,
      probability: p(e),
      createdAt: o.receivedAt,
    }));
    const cluster = this.createCluster(o, links);
    return {
      observationId: o.id,
      outcome: ambiguous ? "ambiguous" : "created",
      candidateId: cluster.id,
      possibleMatches: related.map(asMatch),
      ...assessment,
    };
  }

  /** Candidates worth comparing: shared references, nearby amount/time, or user must-links. */
  private retrieve(o: Observation): Cluster[] {
    const ids = new Set<CandidateId>();
    for (const key of lookupReferenceKeys(o)) for (const id of this.referenceIndex.get(key) ?? []) ids.add(id);
    if (o.kind !== "delivery") {
      for (const key of lookupAmountKeys(o, this.config)) for (const id of this.amountIndex.get(key) ?? []) ids.add(id);
    }
    for (const [partner, relation] of this.relations.get(o.id) ?? []) {
      const id = relation === "must" ? this.clusterOf.get(partner) : undefined;
      if (id) ids.add(id);
    }
    return [...ids].flatMap((id) => this.clusters.get(id) ?? []).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Compare an observation with a candidate. User constraints come first
   * (cannot-link beats must-link); then any member's hard veto excludes the
   * candidate; otherwise the candidate scores as its best comparable member.
   */
  private evaluate(o: Observation, cluster: Cluster): Evaluation {
    const relations = this.relations.get(o.id);
    let forced = false;
    for (const m of cluster.members) {
      const relation = relations?.get(m);
      if (relation === "cannot") return { kind: "veto", assessment: this.userVeto("user asserted these are different events") };
      if (relation === "must") forced = true;
    }
    if (forced) return { kind: "forced", assessment: this.forcedAssessment() };
    if (this.isDismissedBefore(cluster, o.receivedAt)) return { kind: "veto", assessment: this.userVeto("candidate dismissed by the user") };

    let best: PairAssessment | undefined;
    let blocked: PairAssessment | undefined;
    for (const id of cluster.members) {
      const member = id === o.id ? undefined : this.observationsById.get(id);
      if (!member) continue;
      const a = assessPair(o, member, this.config, this.matcher);
      if (a.veto !== undefined && !a.blocked) return { kind: "veto", assessment: a };
      if (a.blocked) blocked ??= a;
      else if (!best || a.probability > best.probability) best = a;
    }
    if (best) return { kind: "scored", assessment: best };
    return { kind: "blocked", assessment: blocked ?? this.userVeto("not comparable: no other observations") };
  }

  private forcedAssessment(): MatchAssessment {
    const llr = 50;
    return {
      logOdds: this.config.priorLogOdds + llr,
      probability: 1,
      features: [{ name: "user_same_event", llr, detail: "user asserted these observations are one event" }],
    };
  }

  private userVeto(reason: string): MatchAssessment {
    return { veto: reason, logOdds: this.config.priorLogOdds, probability: 0, features: [] };
  }

  /* -------------------------- cluster state -------------------------- */

  private createCluster(o: Observation, links: CandidateLink[]): Cluster {
    const cluster: Cluster = {
      id: candidateIdFor(o.id),
      seq: this.clusterCounter++,
      members: [o.id],
      matchProbabilities: new Map([[o.id, 1]]),
      links,
    };
    this.clusters.set(cluster.id, cluster);
    this.clusterOf.set(o.id, cluster.id);
    this.indexMember(cluster.id, o);
    if (o.kind === "order") this.adoptOrphanDeliveries(cluster, o);
    return cluster;
  }

  private addMember(cluster: Cluster, o: Observation, probability: Probability): void {
    cluster.members = this.inIngestOrder([...cluster.members, o.id]);
    cluster.matchProbabilities.set(o.id, probability);
    this.clusterOf.set(o.id, cluster.id);
    this.indexMember(cluster.id, o);
    this.cache.delete(cluster.id);
    if (o.kind === "order") this.adoptOrphanDeliveries(cluster, o);
  }

  private indexMember(clusterId: CandidateId, o: Observation): void {
    for (const key of memberReferenceKeys(o)) addToIndex(this.referenceIndex, key, clusterId);
    for (const key of memberAmountKeys(o)) addToIndex(this.amountIndex, key, clusterId);
  }

  private reindexMember(o: Observation, from: CandidateId, to: CandidateId): void {
    for (const key of memberReferenceKeys(o)) {
      this.referenceIndex.get(key)?.delete(from);
      addToIndex(this.referenceIndex, key, to);
    }
    for (const key of memberAmountKeys(o)) {
      this.amountIndex.get(key)?.delete(from);
      addToIndex(this.amountIndex, key, to);
    }
  }

  /** An order arrived: attach deliveries that were waiting for it. */
  private adoptOrphanDeliveries(cluster: Cluster, order: Observation): void {
    for (const r of order.references) {
      if (r.type !== "order_id") continue;
      const key = referenceKey(r);
      const waiting = this.orphanDeliveries.get(key);
      if (!waiting) continue;
      const stillWaiting: ObservationId[] = [];
      for (const id of waiting) {
        const delivery = this.observationsById.get(id);
        if (!delivery || this.clusterOf.has(id)) continue;
        const ev = this.evaluate(delivery, cluster);
        if (ev.kind === "forced" || (ev.kind === "scored" && ev.assessment.probability >= this.config.linkThreshold)) {
          this.contextIds.delete(id);
          this.addMember(cluster, delivery, ev.assessment.probability);
        } else {
          stillWaiting.push(id);
        }
      }
      this.orphanDeliveries.set(key, stillWaiting);
    }
  }

  /** Merge candidates the user said are one event into the oldest of them. */
  private mergeForced(clusters: readonly Cluster[]): Cluster {
    const [target, ...rest] = clusters;
    if (!target) throw new RangeError("mergeForced needs at least one candidate");
    for (const other of rest) {
      if (other.id === target.id || this.hasCannotLinkBetween(target, other)) continue;
      for (const id of other.members) {
        const o = this.observationsById.get(id);
        this.clusterOf.set(id, target.id);
        target.matchProbabilities.set(id, other.matchProbabilities.get(id) ?? 1);
        if (o) this.reindexMember(o, other.id, target.id);
      }
      target.members = this.inIngestOrder([...target.members, ...other.members]);
      target.links = this.dedupeLinks([...target.links, ...other.links], target.id, other.id);
      this.clusters.delete(other.id);
      this.cache.delete(other.id);
      for (const c of this.clusters.values()) {
        if (!c.links.some((l) => l.target === other.id)) continue;
        c.links = this.dedupeLinks(
          c.links.map((l) => (l.target === other.id ? { ...l, target: target.id } : l)),
          c.id,
          c.id,
        );
        this.cache.delete(c.id);
      }
    }
    this.cache.delete(target.id);
    return target;
  }

  private dedupeLinks(links: readonly CandidateLink[], selfId: CandidateId, mergedId: CandidateId): CandidateLink[] {
    const out = new Map<string, CandidateLink>();
    for (const l of links) {
      if (l.target === selfId || l.target === mergedId) continue;
      const key = `${l.kind}|${l.target}`;
      const existing = out.get(key);
      if (!existing || l.probability > existing.probability) out.set(key, l);
    }
    return [...out.values()];
  }

  private hasCannotLinkBetween(a: Cluster, b: Cluster): boolean {
    return a.members.some((x) => b.members.some((y) => this.relations.get(x)?.get(y) === "cannot"));
  }

  private inIngestOrder(ids: readonly ObservationId[]): ObservationId[] {
    return [...new Set(ids)].sort((a, b) => (this.ingestOrder.get(a) ?? 0) - (this.ingestOrder.get(b) ?? 0));
  }

  private resetDerived(): void {
    this.clusters.clear();
    this.clusterOf.clear();
    this.contextIds.clear();
    this.orphanDeliveries.clear();
    this.referenceIndex.clear();
    this.amountIndex.clear();
    this.cache.clear();
    this.clusterCounter = 0;
  }

  /** Replay every observation in ingest order under the current assertions. */
  private rebuild(): void {
    this.resetDerived();
    for (const o of this.observationsById.values()) this.fuse(o);
  }

  /* ---------------------------- assertions --------------------------- */

  private reindexAssertions(): void {
    this.relations = new Map();
    this.dismissedAt = new Map();
    this.assertionsByAnchor = new Map();
    const relate = (x: ObservationId, y: ObservationId, r: Relation): void => {
      let m = this.relations.get(x);
      if (!m) {
        m = new Map();
        this.relations.set(x, m);
      }
      m.set(y, r);
    };
    this.assertionList.forEach((a, index) => {
      const anchors = [...new Set(a.anchors)];
      for (const anchor of anchors) this.assertionsByAnchor.set(anchor, [...(this.assertionsByAnchor.get(anchor) ?? []), index]);
      if (a.kind === "same_event" || a.kind === "different_events") {
        // Later assertions about the same pair override earlier ones.
        const relation: Relation = a.kind === "same_event" ? "must" : "cannot";
        for (const x of anchors) for (const y of anchors) if (x !== y) relate(x, y, relation);
      } else if (a.kind === "dismiss") {
        for (const anchor of anchors) this.dismissedAt.set(anchor, Math.min(this.dismissedAt.get(anchor) ?? Infinity, a.at));
      }
    });
  }

  private isDismissed(cluster: Cluster): boolean {
    return cluster.members.some((m) => this.dismissedAt.has(m));
  }

  /**
   * A dismissed candidate does not absorb observations received after the
   * dismissal. Comparing data timestamps (not ingest time) keeps replay
   * identical to incremental ingest.
   */
  private isDismissedBefore(cluster: Cluster, receivedAt: EpochMillis): boolean {
    return cluster.members.some((m) => {
      const at = this.dismissedAt.get(m);
      return at !== undefined && at < receivedAt;
    });
  }

  private clustersContaining(anchors: ReadonlySet<ObservationId>): CandidateId[] {
    const ids = new Set<CandidateId>();
    for (const anchor of anchors) {
      const id = this.clusterOf.get(anchor);
      if (id) ids.add(id);
    }
    return [...this.clusters.values()].filter((c) => ids.has(c.id)).map((c) => c.id);
  }

  /**
   * Patches are anchored to a candidate's founding observation. When that
   * observation goes away, move the patch to the earliest remaining member so
   * intelligence-owned fields survive a partial disconnect.
   */
  private reanchorPatches(gone: ReadonlySet<ObservationId>): void {
    for (const [anchor, entry] of [...this.patches.entries()]) {
      if (!gone.has(anchor)) continue;
      this.patches.delete(anchor);
      const clusterId = this.clusterOf.get(anchor);
      const successor = clusterId ? this.clusters.get(clusterId)?.members.find((m) => !gone.has(m)) : undefined;
      if (successor === undefined) continue;
      const existing = this.patches.get(successor);
      if (!existing) {
        this.patches.set(successor, entry);
        continue;
      }
      const [older, newer] = existing.seq < entry.seq ? [existing, entry] : [entry, existing];
      this.patches.set(successor, { seq: newer.seq, patch: mergePatches(older.patch, newer.patch) });
    }
  }

  /* ---------------------------- composition -------------------------- */

  private membersOf(cluster: Cluster | undefined): Observation[] {
    if (!cluster) return [];
    return cluster.members.flatMap((id) => this.observationsById.get(id) ?? []);
  }

  private composed(cluster: Cluster): ComposedCandidate {
    const cached = this.cache.get(cluster.id);
    if (cached) return cached;
    const members = this.membersOf(cluster);
    const patches = members
      .flatMap((o) => this.patches.get(o.id) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.patch);
    const indices = new Set<number>();
    for (const o of members) for (const i of this.assertionsByAnchor.get(o.id) ?? []) indices.add(i);
    const assertions = [...indices].sort((a, b) => a - b).flatMap((i) => this.assertionList[i] ?? []);
    const composed = composeCandidate(
      { id: cluster.id, members, matchProbabilities: cluster.matchProbabilities, fusionLinks: cluster.links, patches, assertions },
      this.matcher,
      this.config,
    );
    this.cache.set(cluster.id, composed);
    return composed;
  }

  private read(cluster: Cluster): TransactionCandidate {
    return finalizeCandidate(this.composed(cluster), this.clock.now());
  }

  /** Clock-independent rendering of every candidate, for change detection. */
  private renderAll(): Map<CandidateId, string> {
    const out = new Map<CandidateId, string>();
    for (const c of this.clusters.values()) out.set(c.id, JSON.stringify(this.composed(c).candidate));
    return out;
  }
}
