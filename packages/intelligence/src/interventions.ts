import { MINUTE, formatMoney } from "@brake/core";
import type {
  CandidateId,
  EpochMillis,
  InterventionLevel,
  LabelField,
  ObservationId,
  TransactionCandidate,
  TransactionType,
  UserRule,
} from "@brake/core";
import type { InterventionContext, InterventionDecision, InterventionPolicy, RegretEstimate } from "./contracts";
import { toneIssues } from "./copy";
import { applicableBudgets, budgetStatus, confidentCategory, wholeUnits } from "./insights";
import { UNCATEGORIZED, categoryLabel, defaultEssentiality, topLevelCategory } from "./taxonomy";

/**
 * Pre-spend and in-spend interventions.
 *
 * BRAKE's friction ladder is none → inform → reflect → pause, and it never
 * blocks: every decision carries a one-tap "Continue". Each input (personal
 * regret history, budgets, goals, the user's own rules) proposes a level;
 * the strongest wins, and is then bounded by
 *   - confidence — "a low-confidence inference should rarely trigger strong
 *     friction" (brief): below 0.4 nothing, below 0.6 at most inform;
 *   - essentials — groceries, medicine, rent, bills are never questioned
 *     unless the user wrote a rule asking for it;
 *   - fatigue — after a few interventions in a day BRAKE only informs, because
 *     friction that fires constantly is habituated to and then uninstalled.
 * Late night is not a reason on its own (the "tired willpower" story has not
 * held up in replication); it only strengthens friction when the user's own
 * regret history, or their own rule, says late-night purchases matter for them.
 *
 * Messages are short, specific and autonomy-supportive: a fact the user may
 * not have in mind, then (for reflect/pause) a question they can skip. BRAKE
 * only describes a personal pattern once enough answers back it, and an
 * inform with no fact to show is not shown at all.
 */

export const INTERVENTION_THRESHOLDS = {
  /** Below this candidate confidence BRAKE stays out of the way. */
  noneBelowConfidence: 0.4,
  /** Below this candidate confidence BRAKE may only inform. */
  informBelowConfidence: 0.6,
  reflectRegret: { probability: 0.5, evidence: 3 },
  pauseRegret: { probability: 0.7, evidence: 5 },
  /** Answers needed before a message may describe the user's own regret pattern. */
  regretPatternEvidence: 5,
  /** Exceeding a budget by more than this fraction of its limit suggests a pause rather than a reflection. */
  budgetPauseOverFraction: 0.25,
  /** Within budget, but less than this fraction of the limit would remain: a quiet inform. */
  budgetInformRemainingFraction: 0.25,
  /** A purchase at least this share of a goal's remaining amount is worth a quiet inform. */
  goalInformShare: 0.1,
  /** At or above this many interventions in 24h, BRAKE only informs. */
  maxPerDay: 3,
  /** A pending payment this recent is still "in-spend". */
  inSpendWindowMs: 15 * MINUTE,
  /** Local hours [from, to) treated as late night. */
  lateNight: { from: 23, to: 5 },
  /** Category certainty needed before category budgets or category rules apply. */
  minCategoryConfidence: 0.6,
  /** Category certainty enough to recognise an essential from the category prior (lower: erring towards no friction). */
  essentialCategoryConfidence: 0.5,
} as const;

const T = INTERVENTION_THRESHOLDS;

export interface InterventionPolicyOptions {
  /**
   * IANA zone of the user, used to find the start of budget weeks/months.
   * InterventionContext carries only `localHour`; without this option the
   * zone is approximated by a whole-hour offset derived from it.
   */
  readonly timeZone?: string;
  /** How long a pending payment counts as in-spend. Default 15 minutes. */
  readonly inSpendWindowMs?: number;
  /** Interventions in 24h after which BRAKE only informs. Default 3. */
  readonly maxPerDay?: number;
  /**
   * Strongest level BRAKE may choose on its own (regret, budget, goal);
   * user rules are not limited by it. Default "pause". Set "reflect" to keep
   * cooling-off suggestions for user-authored rules only — e.g. during cold
   * start, before the regret model has enough answers.
   */
  readonly maxModelLevel?: InterventionLevel;
  /**
   * Which confidence bounds friction for a pre-spend intent:
   *   "candidate" (default) — `candidate.confidence`, as the contract says;
   *   "facts" — the higher of that and the confidence in the stated amount.
   * Use "facts" when fusion's candidate confidence for an intent also
   * discounts whether the purchase will happen at all (a lone "Should I buy
   * this?" would otherwise never get past `none`/`inform`).
   */
  readonly intentConfidence?: "candidate" | "facts";
}

/* ------------------------------------------------------------------ */
/* Actions and answers                                                 */
/* ------------------------------------------------------------------ */

export type InterventionActionId = "continue" | "planned" | "spur_of_the_moment" | "remind_tomorrow" | "save_to_wishlist";

export const INTERVENTION_ACTIONS: Readonly<Record<InterventionActionId, { readonly id: InterventionActionId; readonly label: string }>> = {
  continue: { id: "continue", label: "Continue" },
  planned: { id: "planned", label: "Planned" },
  spur_of_the_moment: { id: "spur_of_the_moment", label: "Spur of the moment" },
  remind_tomorrow: { id: "remind_tomorrow", label: "Remind me tomorrow" },
  save_to_wishlist: { id: "save_to_wishlist", label: "Save to wishlist" },
};

const A = INTERVENTION_ACTIONS;

/** Every level keeps a way to continue; stronger levels add, never replace. */
function actionsFor(level: InterventionLevel): InterventionDecision["actions"] {
  switch (level) {
    case "reflect":
      return [A.planned, A.spur_of_the_moment, A.continue];
    case "pause":
      return [A.remind_tomorrow, A.save_to_wishlist, A.continue];
    default:
      return [A.continue];
  }
}

/**
 * What a reflect answer teaches BRAKE about the purchase: it becomes a
 * `label` assertion on `attributes.intent`, which in turn feeds the regret
 * model's `planned` feature. Other actions carry no label.
 */
export function interventionAnswerEffect(actionId: string): LabelField | null {
  switch (actionId) {
    case "planned":
      return { field: "intent", value: "planned" };
    case "spur_of_the_moment":
      return { field: "intent", value: "impulsive" };
    default:
      return null;
  }
}

/** A user's answer to an intervention, as tracked by the orchestrator. */
export interface InterventionResponse {
  /** Candidate the decision was shown for. */
  readonly candidateId: CandidateId;
  readonly actionId: string;
  readonly at: EpochMillis;
  /** The candidate's observations when the user answered, so the answer survives re-fusion. */
  readonly observationIds?: readonly ObservationId[];
}

/** Answers that mean "I've decided, let me through". */
const PROCEED_ACTIONS: ReadonlySet<string> = new Set(["continue", "planned", "spur_of_the_moment"]);

function concerns(r: InterventionResponse, c: TransactionCandidate): boolean {
  if (r.candidateId === c.id || r.candidateId === c.deduplicationGroup) return true;
  const ids = r.observationIds;
  return ids !== undefined && c.sourceSignals.some((s) => ids.includes(s.observationId));
}

/**
 * True when the user already chose to go ahead with this purchase. The intent
 * may reappear as the checkout and then the payment of the same candidate;
 * asking again would second-guess a decision the user already made.
 */
export function hasChosenToContinue(candidate: TransactionCandidate, responses: readonly InterventionResponse[]): boolean {
  return responses.some((r) => PROCEED_ACTIONS.has(r.actionId) && concerns(r, candidate));
}

/** Apply the user's earlier answers to a fresh decision: once they chose to continue, BRAKE stays quiet. */
export function respectPriorResponses(
  decision: InterventionDecision,
  candidate: TransactionCandidate,
  responses: readonly InterventionResponse[],
): InterventionDecision {
  if (decision.level === "none" || !hasChosenToContinue(candidate, responses)) return decision;
  return { level: "none", reasons: [...decision.reasons, "already_chose_continue"], actions: actionsFor("none") };
}

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

const LEVELS: readonly InterventionLevel[] = ["none", "inform", "reflect", "pause"];

function rank(l: InterventionLevel): number {
  return LEVELS.indexOf(l);
}

function capAt(l: InterventionLevel, cap: InterventionLevel): InterventionLevel {
  return rank(l) > rank(cap) ? cap : l;
}

function escalate(l: InterventionLevel): InterventionLevel {
  return LEVELS[Math.min(rank(l) + 1, LEVELS.length - 1)]!;
}

/** One input's proposal: a level, why, and one factual sentence to show (null when there is nothing honest to say). */
interface Signal {
  readonly source: "rule" | "regret" | "budget" | "goal";
  readonly level: InterventionLevel;
  readonly reasons: readonly string[];
  readonly fact: string | null;
}

/* ------------------------------------------------------------------ */
/* Applicability                                                       */
/* ------------------------------------------------------------------ */

type Phase = "pre_spend" | "in_spend";

/**
 * Interventions only make sense before money moves: an open intent, or a
 * payment flow that started minutes ago. After that, insights take over.
 */
function spendPhase(c: TransactionCandidate, now: EpochMillis, windowMs: number): Phase | null {
  if (c.status === "intent") return c.intentOutcome === undefined || c.intentOutcome === "open" ? "pre_spend" : null;
  const age = now - c.timestampEstimated;
  const recent = age >= -windowMs && age <= windowMs;
  if (!recent) return null;
  if (c.status === "pending") return "in_spend";
  if (c.status === "unknown" && c.sourceSignals.some((s) => s.kind === "checkout")) return "in_spend";
  return null;
}

const NOT_PURCHASES: ReadonlySet<TransactionType> = new Set([
  "transfer",
  "credit_card_payment",
  "loan_payment",
  "investment",
  "income",
  "refund",
  "reimbursement",
  "cash_withdrawal",
]);

/** Paying a card bill or moving money to savings is not a spending decision to question. */
function clearlyNotAPurchase(c: TransactionCandidate): boolean {
  const t = c.transactionType;
  return NOT_PURCHASES.has(t.value) && (t.userSet || t.confidence >= 0.6);
}

/**
 * Essentials are never questioned by default (medicine, groceries, rent).
 * A user label or a confident essentiality inference decides; otherwise the
 * category prior does, with a lower bar than other uses because the safe
 * error here is "no friction".
 */
function isEssential(c: TransactionCandidate): boolean {
  const e = c.attributes.essentiality;
  if (e.userSet || (e.value !== "unknown" && e.confidence >= 0.6)) return e.value === "essential";
  const cat = c.category;
  if (!cat.userSet && cat.confidence < T.essentialCategoryConfidence) return false;
  if (topLevelCategory(cat.value) === UNCATEGORIZED) return false;
  return defaultEssentiality(cat.value) === "essential";
}

function inHours(hour: number, window: { readonly from: number; readonly to: number }): boolean {
  if (window.from === window.to) return true;
  return window.from < window.to ? hour >= window.from && hour < window.to : hour >= window.from || hour < window.to;
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

function regretSignal(r: RegretEstimate | null, lateNight: boolean): Signal | null {
  if (!r) return null;
  let level: InterventionLevel = "none";
  if (r.probability >= T.pauseRegret.probability && r.evidence >= T.pauseRegret.evidence) level = "pause";
  else if (r.probability >= T.reflectRegret.probability && r.evidence >= T.reflectRegret.evidence) level = "reflect";
  if (level === "none") return null;

  const reasons = [`regret:p=${r.probability.toFixed(2)},n=${Math.round(r.evidence * 10) / 10}`];
  if (lateNight) {
    // The user's own history says purchases like this are often regretted,
    // and it is night: a night's sleep is the natural cooling-off period.
    level = escalate(level);
    reasons.push("late_night+regret");
  }
  // A pattern is only described once enough of the user's own answers back it;
  // with fewer, BRAKE still asks, but claims nothing about the user.
  if (r.evidence < T.regretPatternEvidence) return { source: "regret", level, reasons, fact: null };
  const when = lateNight ? " late at night" : "";
  const fact =
    r.probability >= 0.65
      ? `Purchases like this${when} are often ones you've regretted.`
      : `Purchases like this${when} have sometimes been ones you've regretted.`;
  return { source: "regret", level, reasons, fact };
}

function about(c: TransactionCandidate): string {
  const a = c.amount;
  return a && (a.approximate || a.confidence < 0.85) ? "about " : "";
}

/**
 * Would this purchase exceed a budget? Exceeding it suggests reflection;
 * exceeding it by more than a quarter of the limit suggests a pause. The
 * overshoot is measured against the limit, not the remainder, so a ₹100
 * coffee when ₹10 is left is not treated as a 900% overshoot. Nearly using it
 * up is a quiet inform: "You have ₹1,200 left in Eating out this week."
 */
function budgetSignal(c: TransactionCandidate, ctx: InterventionContext, timeZone: string, others: readonly TransactionCandidate[]): Signal | null {
  if (!c.amount) return null;
  const amount = c.amount.value.minor;
  let best: Signal | null = null;
  for (const budget of applicableBudgets(c, ctx.budgets, T.minCategoryConfidence)) {
    const status = budgetStatus(budget, others, ctx.now, timeZone);
    const limit = budget.limit.minor;
    const over = status.spent.minor + amount - limit;
    const name = budget.category ? categoryLabel(budget.category) : null;
    const periodWord = budget.period === "weekly" ? "week" : "month";
    const scope = budget.category ?? "overall";

    let level: InterventionLevel;
    let fact: string;
    let reason: string;
    if (over > 0) {
      level = over / limit > T.budgetPauseOverFraction ? "pause" : "reflect";
      const overText = formatMoney(wholeUnits({ minor: over, currency: budget.limit.currency }), ctx.locale);
      fact = `This would put ${name ?? "you"} ${about(c)}${overText} over this ${periodWord}'s budget.`;
      reason = `budget:${scope}:over_by=${Math.round((over / limit) * 100)}%`;
    } else if (-over < T.budgetInformRemainingFraction * limit) {
      // -over is what would remain after this purchase.
      level = "inform";
      const left = formatMoney(wholeUnits(status.remaining), ctx.locale);
      fact = name ? `You have ${left} left in ${name} this ${periodWord}.` : `You have ${left} left in your budget this ${periodWord}.`;
      reason = `budget:${scope}:nearly_used`;
    } else {
      continue;
    }
    if (!best || rank(level) > rank(best.level)) best = { source: "budget", level, reasons: [reason], fact };
  }
  return best;
}

/** "This would be 12% of what's left for Goa trip." — a quiet fact, never more than inform. */
function goalSignal(c: TransactionCandidate, ctx: InterventionContext): Signal | null {
  if (!c.amount) return null;
  const amount = c.amount.value;
  let best: { name: string; id: string; share: number } | null = null;
  for (const goal of ctx.goals) {
    if (goal.target.currency !== amount.currency || goal.saved.currency !== amount.currency) continue;
    const remaining = goal.target.minor - goal.saved.minor;
    if (remaining <= 0) continue;
    const share = amount.minor / remaining;
    if (share >= T.goalInformShare && (!best || share > best.share)) best = { name: goal.name, id: goal.id, share };
  }
  if (!best) return null;
  const name = safeText(best.name) ?? "your goal";
  const fact =
    best.share >= 1
      ? `This would cost more than what's left for ${name}.`
      : `This would be ${about(c)}${Math.round(best.share * 100)}% of what's left for ${name}.`;
  return { source: "goal", level: "inform", reasons: [`goal:${best.id}:share=${Math.round(best.share * 100)}%`], fact };
}

function ruleMatches(rule: UserRule, c: TransactionCandidate, localHour: number): boolean {
  if (rule.category !== undefined) {
    const cat = confidentCategory(c, T.minCategoryConfidence);
    if (!cat || !(cat === rule.category || cat.startsWith(`${rule.category}.`))) return false;
  }
  if (rule.minAmount) {
    const a = c.amount?.value;
    if (!a || a.currency !== rule.minAmount.currency || a.minor < rule.minAmount.minor) return false;
  }
  if (rule.localHours && !inHours(localHour, rule.localHours)) return false;
  if (rule.channel && c.merchant.channel !== rule.channel) return false;
  return true;
}

/**
 * The user's own rules. They are commitments the user chose, so they apply
 * even to essentials — but still only as strongly as BRAKE's confidence in
 * the candidate allows.
 */
function ruleSignal(c: TransactionCandidate, ctx: InterventionContext): Signal | null {
  const matching = ctx.rules.filter((r) => ruleMatches(r, c, ctx.localHour));
  if (matching.length === 0) return null;
  let strongest = matching[0]!;
  for (const r of matching) if (rank(r.level) > rank(strongest.level)) strongest = r;
  const description = safeText(strongest.description);
  const fact = description ? `This matches your rule “${description}”.` : "This matches one of your rules.";
  return { source: "rule", level: strongest.level, reasons: matching.map((r) => `rule:${r.id}`), fact };
}

function safeText(text: string): string | null {
  const t = text.trim().replace(/[.!?。]+$/u, "");
  return t.length > 0 && toneIssues(t).length === 0 ? t : null;
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

/** For a quiet inform, the most concrete fact wins. */
const INFORM_PRIORITY: readonly Signal["source"][] = ["budget", "goal", "rule", "regret"];
/** For a question, the user's own commitment leads, then their own history. */
const PROMPT_PRIORITY: readonly Signal["source"][] = ["rule", "regret", "budget", "goal"];

function byPriority(order: readonly Signal["source"][]): (a: Signal, b: Signal) => number {
  return (a, b) => order.indexOf(a.source) - order.indexOf(b.source);
}

/**
 * The sentence that leads the message. For a question, the signal that set
 * the level speaks (falling back to any other fact); for a quiet inform, the
 * most concrete fact available. Null when there is no honest fact to show.
 */
function leadFact(level: InterventionLevel, signals: readonly Signal[]): string | null {
  const withFact = signals.filter((s) => s.fact !== null && rank(s.level) >= rank("inform"));
  const informFact = [...withFact].sort(byPriority(INFORM_PRIORITY))[0]?.fact ?? null;
  if (level === "inform") return informFact;
  const setters = signals.filter((s) => s.level === level && s.fact !== null).sort(byPriority(PROMPT_PRIORITY));
  return setters[0]?.fact ?? informFact;
}

const QUESTION: Readonly<Record<"reflect" | "pause", string>> = {
  reflect: "Planned, or spur of the moment?",
  pause: "Want to give it a day?",
};

/** Message for a level, or null when an inform would have nothing to say. */
function composeMessage(level: Exclude<InterventionLevel, "none">, signals: readonly Signal[], lateNight: boolean): string | null {
  const fact = leadFact(level, signals);
  let message: string | null;
  if (level === "inform") message = fact;
  else if (level === "reflect") message = fact ? `${fact} ${QUESTION.reflect}` : QUESTION.reflect;
  else if (lateNight) message = fact ? `${fact} Sleep on it?` : "It's late. Sleep on it?";
  else message = fact ? `${fact} ${QUESTION.pause}` : QUESTION.pause;
  // Every template is tone-safe; user-authored names are filtered upstream. Belt and braces:
  if (message !== null && toneIssues(message).length > 0) message = level === "inform" ? null : QUESTION[level];
  return message;
}

/* ------------------------------------------------------------------ */
/* Time zone fallback                                                  */
/* ------------------------------------------------------------------ */

/**
 * Approximate the user's zone from the local hour when no zone was given:
 * a whole-hour `Etc/GMT±N` zone (sign inverted by IANA convention). Offsets
 * of +14 and −10 are indistinguishable; −10 (Hawaii, Tahiti) is preferred.
 * Half-hour zones may be off by an hour at period boundaries.
 */
export function approximateTimeZone(now: EpochMillis, localHour: number): string {
  const utcHour = new Date(now).getUTCHours();
  let diff = (((localHour - utcHour) % 24) + 24) % 24;
  if (diff >= 14) diff -= 24;
  if (diff === 0) return "UTC";
  return `Etc/GMT${diff > 0 ? "-" : "+"}${Math.abs(diff)}`;
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

function decision(level: InterventionLevel, reasons: readonly string[], message?: string): InterventionDecision {
  return message === undefined ? { level, reasons, actions: actionsFor(level) } : { level, reasons, message, actions: actionsFor(level) };
}

/**
 * The confidence that bounds friction. By contract it is the candidate's
 * confidence; in "facts" mode an open intent is judged by how sure BRAKE is of
 * what the user is about to pay, not by whether they will go through with it.
 */
function boundingConfidence(c: TransactionCandidate, mode: "candidate" | "facts"): number {
  if (mode === "facts" && c.status === "intent" && c.amount) return Math.max(c.confidence, c.amount.confidence);
  return c.confidence;
}

export function createInterventionPolicy(opts: InterventionPolicyOptions = {}): InterventionPolicy {
  const windowMs = opts.inSpendWindowMs ?? T.inSpendWindowMs;
  const maxPerDay = opts.maxPerDay ?? T.maxPerDay;
  const maxModelLevel = opts.maxModelLevel ?? "pause";
  const confidenceMode = opts.intentConfidence ?? "candidate";

  return {
    decide(c: TransactionCandidate, ctx: InterventionContext): InterventionDecision {
      if (!spendPhase(c, ctx.now, windowMs)) return decision("none", ["not_pre_or_in_spend"]);
      if (c.direction === "credit") return decision("none", ["incoming_money"]);
      if (clearlyNotAPurchase(c)) return decision("none", [`not_a_purchase:${c.transactionType.value}`]);
      const confidence = boundingConfidence(c, confidenceMode);
      if (confidence < T.noneBelowConfidence) return decision("none", ["low_confidence"]);

      const timeZone = opts.timeZone ?? approximateTimeZone(ctx.now, ctx.localHour);
      const lateNight = inHours(ctx.localHour, T.lateNight);
      const others = ctx.history.filter((h) => h.id !== c.id && h.deduplicationGroup !== c.deduplicationGroup);
      const essential = isEssential(c);
      const reasons: string[] = [];
      if (essential) reasons.push("essential");

      const signals: Signal[] = [];
      const rule = ruleSignal(c, ctx);
      if (rule) signals.push(rule);
      if (!essential) {
        for (const s of [regretSignal(ctx.regret, lateNight), budgetSignal(c, ctx, timeZone, others), goalSignal(c, ctx)]) {
          if (!s) continue;
          if (rank(s.level) > rank(maxModelLevel)) {
            signals.push({ ...s, level: capAt(s.level, maxModelLevel) });
            reasons.push(`capped:model_level:${s.source}`);
          } else {
            signals.push(s);
          }
        }
      }
      for (const s of signals) reasons.push(...s.reasons);

      let level: InterventionLevel = "none";
      for (const s of signals) if (rank(s.level) > rank(level)) level = s.level;
      if (level === "none") return decision("none", reasons.length ? reasons : ["no_signal"]);

      if (confidence < T.informBelowConfidence && rank(level) > rank("inform")) {
        level = capAt(level, "inform");
        reasons.push("capped:confidence");
      }
      if (ctx.interventionsLast24h >= maxPerDay && rank(level) > rank("inform")) {
        level = capAt(level, "inform");
        reasons.push("capped:recent_interventions");
      }

      const message = level === "none" ? null : composeMessage(level, signals, lateNight);
      if (message === null) return decision("none", [...reasons, "nothing_to_inform"]);
      return decision(level, reasons, message);
    },
  };
}
