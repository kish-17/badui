import type { UserAssertion } from "./model/assertion";
import type { Observation } from "./model/observation";
import type { Budget, Goal, OwnedInstrument, UserRule } from "./model/preferences";
import type { CountryCode, CurrencyCode, EpochMillis, LocaleTag, ObservationId } from "./model/primitives";
import type { ConsentEvent, SourceConnection } from "./privacy/types";

/**
 * Persistence port. Engines are pure and in-memory; a store persists the
 * *source of truth* (observations, user assertions, consent, preferences) so
 * candidates can be rebuilt deterministically on any device.
 *
 * What a store must never hold: raw payloads (SMS/email bodies, provider
 * JSON), OTPs, full card/account numbers, or derived candidates as truth.
 *
 * Every method is scoped to one signed-in user; implementations enforce that
 * (the Supabase store relies on row-level security, not on client filters).
 */
export interface BrakeStore {
  /* consent */
  upsertConnection(connection: SourceConnection): Promise<void>;
  listConnections(): Promise<SourceConnection[]>;
  appendConsentEvent(event: ConsentEvent): Promise<void>;
  listConsentEvents(connectionId?: string): Promise<ConsentEvent[]>;
  /** Mark revoked, record the consent event and delete every observation of the connection. */
  revokeConnection(connectionId: string, at: EpochMillis): Promise<{ readonly deletedObservations: number }>;

  /* source of truth */
  /** Idempotent: re-putting an existing observation id is a no-op. */
  putObservations(observations: readonly Observation[]): Promise<{ readonly inserted: number }>;
  listObservations(query?: ObservationQuery): Promise<Page<Observation>>;
  deleteObservations(ids: readonly ObservationId[]): Promise<number>;
  putAssertion(assertion: UserAssertion): Promise<void>;
  listAssertions(): Promise<UserAssertion[]>;
  deleteAssertion(id: string): Promise<void>;

  /* preferences */
  getSettings(): Promise<UserSettings | null>;
  putSettings(settings: UserSettings): Promise<void>;
  listBudgets(): Promise<Budget[]>;
  putBudget(budget: Budget): Promise<void>;
  deleteBudget(id: string): Promise<void>;
  listGoals(): Promise<Goal[]>;
  putGoal(goal: Goal): Promise<void>;
  deleteGoal(id: string): Promise<void>;
  listRules(): Promise<UserRule[]>;
  putRule(rule: UserRule): Promise<void>;
  deleteRule(id: string): Promise<void>;
  listOwnedInstruments(): Promise<StoredInstrument[]>;
  putOwnedInstrument(instrument: StoredInstrument): Promise<void>;
  deleteOwnedInstrument(id: string): Promise<void>;

  /* learning-loop bookkeeping shared across devices (question budget, regret prompt caps, nagging guard) */
  logPrompt(entry: PromptLogEntry): Promise<void>;
  listPrompts(since: EpochMillis): Promise<PromptLogEntry[]>;

  /* user rights */
  /** Everything stored about the user, as plain JSON (data portability). */
  exportAll(): Promise<BrakeExport>;
  /** Delete every row belonging to the user (the auth account itself is removed by the auth provider). */
  eraseAll(): Promise<void>;
}

export interface ObservationQuery {
  /** Inclusive lower bound on receivedAt. */
  readonly since?: EpochMillis;
  /** Exclusive upper bound on receivedAt. */
  readonly until?: EpochMillis;
  readonly connectionId?: string;
  /** Page size (default 500, max 1000). */
  readonly limit?: number;
  /** Opaque cursor from a previous page's `next`. */
  readonly after?: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly next?: string;
}

export interface UserSettings {
  readonly locale: LocaleTag;
  /** IANA time zone. */
  readonly timeZone: string;
  readonly homeCountry?: CountryCode;
  readonly homeCurrency?: CurrencyCode;
  /** Max classification questions per 7 days. */
  readonly questionWeeklyBudget: number;
  readonly regretPromptsEnabled: boolean;
}

export interface StoredInstrument extends OwnedInstrument {
  readonly id: string;
}

export type PromptKind = "question" | "regret_prompt" | "intervention" | "insight";

export interface PromptLogEntry {
  readonly id: string;
  readonly kind: PromptKind;
  /** An observation id of the candidate the prompt was about (candidates are derived, observations are not). */
  readonly anchor?: ObservationId;
  readonly shownAt: EpochMillis;
  readonly answeredAt?: EpochMillis;
  /** Option id chosen, or "dismissed". Never free text. */
  readonly answer?: string;
}

export interface BrakeExport {
  readonly exportedAt: EpochMillis;
  readonly settings: UserSettings | null;
  readonly connections: SourceConnection[];
  readonly consentEvents: ConsentEvent[];
  readonly observations: Observation[];
  readonly assertions: UserAssertion[];
  readonly budgets: Budget[];
  readonly goals: Goal[];
  readonly rules: UserRule[];
  readonly instruments: StoredInstrument[];
  readonly prompts: PromptLogEntry[];
}
