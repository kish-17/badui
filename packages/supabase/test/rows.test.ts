import { DAY, HOUR, money } from "@brake/core";
import type { Goal, Observation, PromptLogEntry, SourceConnection, StoredInstrument, UserAssertion, UserRule, UserSettings } from "@brake/core";
import { makeObservation, makeSource } from "@brake/core/testing";
import { describe, expect, it } from "vitest";
import * as memory from "../../core/src/store-memory";
import {
  assertionFromRow,
  assertionToRow,
  budgetFromRow,
  budgetId,
  budgetToRow,
  connectionFromRow,
  connectionToRow,
  consentEventFromRow,
  consentEventToRow,
  decodeCursor,
  encodeCursor,
  exportFromDocument,
  fromTimestamptz,
  goalFromRow,
  goalToRow,
  instrumentFromRow,
  instrumentToRow,
  observationFromRow,
  observationToRow,
  pageSize,
  promptFromRow,
  promptToRow,
  ruleFromRow,
  ruleToRow,
  settingsFromRow,
  settingsToRow,
  toTimestamptz,
} from "../src/rows";
import type { Json, Tables } from "../src/index";

const T0 = Date.UTC(2026, 9, 4, 5, 11, 0);
const USER = "6f1c2c1e-6f3b-4c4e-9d8e-2a6b7c8d9e0f";

/** What PostgREST would hand back for an inserted row (the database fills defaults). */
function asStored<R>(row: object, extra: Record<string, unknown> = {}): R {
  return { ...JSON.parse(JSON.stringify(row)), ...extra } as R;
}

describe("timestamptz conversion", () => {
  it("writes ISO 8601 UTC with milliseconds", () => {
    expect(toTimestamptz(T0)).toBe("2026-10-04T05:11:00.000Z");
    expect(toTimestamptz(T0 + 7)).toBe("2026-10-04T05:11:00.007Z");
    expect(() => toTimestamptz(Number.NaN)).toThrow(RangeError);
    expect(() => toTimestamptz(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toTimestamptz(9e15)).toThrow(RangeError);
  });

  it("reads every form PostgREST and to_jsonb print", () => {
    expect(fromTimestamptz("2026-10-04T05:11:00+00:00")).toBe(T0);
    expect(fromTimestamptz("2026-10-04T05:11:00.123+00:00")).toBe(T0 + 123);
    expect(fromTimestamptz("2026-10-04T05:11:00.123456+00:00")).toBe(T0 + 123);
    expect(fromTimestamptz("2026-10-04T05:11:00.5Z")).toBe(T0 + 500);
    expect(fromTimestamptz("2026-10-04 10:41:00+05:30")).toBe(T0);
    expect(fromTimestamptz("2026-10-04T01:11:00-04")).toBe(T0);
    expect(fromTimestamptz("2026-10-04T05:11:00")).toBe(T0);
    expect(() => fromTimestamptz("yesterday")).toThrow(RangeError);
  });

  it("round-trips any millisecond instant", () => {
    for (const t of [0, T0, T0 + 999, -86_400_000, Date.UTC(1999, 11, 31, 23, 59, 59, 999)]) {
      expect(fromTimestamptz(toTimestamptz(t))).toBe(t);
    }
  });
});

describe("helpers shared with the memory store", () => {
  it("agree with @brake/core's reference implementation", () => {
    const budgets = [
      { category: "food", limit: money(1, "INR"), period: "weekly" as const },
      { limit: money(1, "USD"), period: "monthly" as const },
      { id: "x", limit: money(1, "USD"), period: "monthly" as const },
    ];
    for (const b of budgets) expect(budgetId(b)).toBe(memory.budgetId(b));
    for (const limit of [undefined, 1, 500, 1000, 5000]) expect(pageSize(limit)).toBe(memory.pageSize(limit));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => pageSize(bad)).toThrow(RangeError);
      expect(() => memory.pageSize(bad)).toThrow(RangeError);
    }
    for (const id of ["obs_1", "a:b", '"q"', "🙂"]) {
      expect(encodeCursor(T0, id)).toBe(memory.encodeCursor(T0, id));
      expect(decodeCursor(memory.encodeCursor(T0, id))).toEqual({ receivedAt: T0, id });
    }
    expect(() => decodeCursor("nope")).toThrow(RangeError);
  });
});

describe("observations", () => {
  const source = makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_a", label: "Test Bank SMS alert", provider: "Test Bank" });
  const base = makeObservation({
    id: "obs_1",
    source,
    receivedAt: T0,
    occurredAt: { value: T0 - HOUR, confidence: 0.8 },
    merchant: { raw: "AMAZON PAY", key: "amazon", confidence: 0.9 },
    evidence: { summary: "Test Bank SMS: ₹1,249.00 debited", excerpt: "Rs 1249 debited to AMAZON", excerptExpiresAt: T0 + 3 * DAY },
  });

  it("projects indexed columns and keeps the excerpt out of facts", () => {
    const row = observationToRow(base, USER, { now: T0, excerptTtlMs: 7 * DAY });
    expect(row).toMatchObject({
      user_id: USER,
      id: "obs_1",
      connection_id: "conn_a",
      adapter_id: "sms",
      source_kind: "sms",
      kind: "money_movement",
      spend_window: "post_spend",
      stage: "confirmed",
      received_at: "2026-10-04T05:11:00.000Z",
      occurred_at: "2026-10-04T04:11:00.000Z",
      direction: "debit",
      amount_minor: 124_900,
      currency: "INR",
      merchant_key: "amazon",
      confidence: 0.95,
      evidence_excerpt: "Rs 1249 debited to AMAZON",
      excerpt_expires_at: "2026-10-07T05:11:00.000Z",
    });
    const facts = row.facts as { evidence: Record<string, unknown> };
    expect(facts.evidence).toEqual({ summary: "Test Bank SMS: ₹1,249.00 debited" });
    expect(JSON.stringify(row.facts)).not.toContain("Rs 1249 debited");
  });

  it("nulls optional columns and drops undefined fields from facts", () => {
    const bare: Observation = {
      id: "obs_2",
      source,
      kind: "app_context",
      window: "pre_spend",
      stage: "intent",
      receivedAt: T0,
      references: [],
      confidence: 0.5,
      evidence: { summary: "Shopping app opened" },
      merchant: undefined,
    };
    const row = observationToRow(bare, USER, { now: T0, excerptTtlMs: 0 });
    expect(row).toMatchObject({
      occurred_at: null,
      direction: null,
      amount_minor: null,
      currency: null,
      merchant_key: null,
      evidence_excerpt: null,
      excerpt_expires_at: null,
    });
    expect(Object.keys(row.facts as object)).not.toContain("merchant");
  });

  it("caps or drops the excerpt by the connection's TTL and the write time", () => {
    const capped = observationToRow(base, USER, { now: T0, excerptTtlMs: DAY });
    expect(capped.excerpt_expires_at).toBe("2026-10-05T05:11:00.000Z");
    expect(observationToRow(base, USER, { now: T0, excerptTtlMs: 0 }).evidence_excerpt).toBeNull();
    const late = observationToRow(base, USER, { now: T0 + 3 * DAY, excerptTtlMs: 7 * DAY });
    expect(late).toMatchObject({ evidence_excerpt: null, excerpt_expires_at: null });
    const noOwnExpiry = makeObservation({ ...base, evidence: { summary: "s", excerpt: "e" } });
    expect(observationToRow(noOwnExpiry, USER, { now: T0, excerptTtlMs: 7 * DAY }).excerpt_expires_at).toBe("2026-10-11T05:11:00.000Z");
  });

  it("rebuilds the observation, merging the excerpt back only while unexpired", () => {
    const row = asStored<Tables<"observations">>(observationToRow(base, USER, { now: T0, excerptTtlMs: 7 * DAY }), {
      excerpt_expires_at: "2026-10-07T05:11:00+00:00",
    });
    expect(observationFromRow(row, T0)).toEqual(base);
    expect(observationFromRow(row, T0 + 3 * DAY - 1).evidence.excerpt).toBe("Rs 1249 debited to AMAZON");
    expect(observationFromRow(row, T0 + 3 * DAY).evidence).toEqual({ summary: "Test Bank SMS: ₹1,249.00 debited" });
  });

  it("never lets an excerpt hidden inside facts bypass expiry", () => {
    const tampered = {
      facts: { ...JSON.parse(JSON.stringify(base)), evidence: { summary: "s", excerpt: "stale text", excerptExpiresAt: T0 - DAY } } as Json,
      evidence_excerpt: null,
      excerpt_expires_at: null,
    };
    expect(observationFromRow(tampered, T0).evidence).toEqual({ summary: "s" });
  });

  it("rejects instants Postgres cannot store before sending anything", () => {
    expect(() => observationToRow({ ...base, receivedAt: Number.NaN }, USER, { now: T0, excerptTtlMs: 0 })).toThrow(RangeError);
  });
});

describe("row-shaped records", () => {
  it("round-trips connections, omitting NULL optionals", () => {
    const full: SourceConnection = {
      connectionId: "conn_a",
      adapterId: "gmail",
      kind: "email",
      label: "Gmail — receipts only",
      provider: "Google",
      status: "revoked",
      scopes: ["gmail.readonly"],
      purposes: ["find receipts"],
      retention: { excerptTtlMs: 7 * DAY, observationTtlMs: 400 * DAY },
      grantedAt: T0 - DAY,
      updatedAt: T0,
      revokedAt: T0,
    };
    const row = connectionToRow(full, USER);
    expect(row).toMatchObject({ user_id: USER, excerpt_ttl_ms: 7 * DAY, observation_ttl_ms: 400 * DAY, revoked_at: "2026-10-04T05:11:00.000Z" });
    expect(connectionFromRow(asStored<Tables<"source_connections">>(row))).toEqual(full);

    const { provider: _p, revokedAt: _r, ...minimal } = { ...full, status: "active" as const, retention: { excerptTtlMs: 0, observationTtlMs: null } };
    const back = connectionFromRow(asStored<Tables<"source_connections">>(connectionToRow(minimal, USER)));
    expect(back).toEqual(minimal);
    expect(back).not.toHaveProperty("provider");
    expect(back).not.toHaveProperty("revokedAt");
    // bigint columns may arrive as strings from some serializers.
    expect(connectionFromRow({ ...asStored<Tables<"source_connections">>(row), excerpt_ttl_ms: "604800000" as unknown as number }).retention.excerptTtlMs).toBe(7 * DAY);
  });

  it("round-trips consent receipts without sending an id", () => {
    const event = { connectionId: "conn_a", action: "scopes_changed" as const, at: T0, scopes: [], purposes: ["p"] };
    const row = consentEventToRow(event, USER);
    expect(row).not.toHaveProperty("id");
    expect(consentEventFromRow(asStored<Tables<"consent_events">>(row, { id: 7 }))).toEqual(event);
  });

  it("leaves settings timestamps to the database", () => {
    const s: UserSettings = { locale: "en-IN", timeZone: "Asia/Kolkata", homeCountry: "IN", questionWeeklyBudget: 5, regretPromptsEnabled: true };
    const row = settingsToRow(s, USER);
    expect(row).not.toHaveProperty("updated_at");
    expect(row).not.toHaveProperty("created_at");
    expect(row.home_currency).toBeNull();
    const stored = asStored(row, { created_at: "2026-10-04T05:11:00+00:00", updated_at: "2026-10-04T05:11:00+00:00" });
    expect(settingsFromRow(stored as Tables<"user_settings">)).toEqual(s);
  });

  it("derives budget ids and returns them on read", () => {
    const row = budgetToRow({ category: "food.groceries", limit: money(500_000, "INR"), period: "monthly" }, USER);
    expect(row).toEqual({ user_id: USER, id: "food.groceries:monthly:INR", category: "food.groceries", limit_minor: 500_000, currency: "INR", period: "monthly" });
    expect(budgetFromRow(row as Tables<"budgets">)).toEqual({ id: "food.groceries:monthly:INR", category: "food.groceries", limit: money(500_000, "INR"), period: "monthly" });
    const overall = budgetToRow({ limit: money(1, "USD"), period: "weekly" }, USER);
    expect(budgetFromRow(overall as Tables<"budgets">)).toEqual({ id: "all:weekly:USD", limit: money(1, "USD"), period: "weekly" });
  });

  it("stores a goal in one currency and refuses mixed currencies", () => {
    const g: Goal = { id: "g1", name: "Trip", target: money(5_000_000, "INR"), saved: money(10, "INR"), targetDate: T0 + 90 * DAY };
    const row = goalToRow(g, USER);
    expect(row).toMatchObject({ currency: "INR", target_minor: 5_000_000, saved_minor: 10 });
    expect(goalFromRow(asStored<Tables<"goals">>(row))).toEqual(g);
    expect(() => goalToRow({ ...g, saved: money(10, "USD") }, USER)).toThrow(RangeError);
  });

  it("keeps only a rule's matching criteria in the rule document", () => {
    const r = { id: "r1", description: "late night", localHours: { from: 23, to: 5 }, channel: "online", level: "pause", note: "x" } as UserRule;
    const row = ruleToRow(r, USER);
    expect(row.rule).toEqual({ localHours: { from: 23, to: 5 }, channel: "online" });
    expect(ruleFromRow(row as Tables<"user_rules">)).toEqual({ id: "r1", description: "late night", localHours: { from: 23, to: 5 }, channel: "online", level: "pause" });
  });

  it("maps instruments column by column, so nothing unmasked rides along", () => {
    const i = { id: "i1", type: "card", issuer: "Test Bank", last4: "1234", cardKind: "credit", pan: "4111111111111111" } as StoredInstrument;
    const row = instrumentToRow(i, USER);
    expect(JSON.stringify(row)).not.toContain("4111111111111111");
    expect(instrumentFromRow(row as Tables<"owned_instruments">)).toEqual({ id: "i1", type: "card", issuer: "Test Bank", last4: "1234", cardKind: "credit" });
  });

  it("round-trips prompts and assertions", () => {
    const p: PromptLogEntry = { id: "p1", kind: "regret_prompt", anchor: "obs_1", shownAt: T0, answeredAt: T0 + 1, answer: "worth_it" };
    expect(promptFromRow(asStored<Tables<"prompt_log">>(promptToRow(p, USER)))).toEqual(p);
    const unanswered: PromptLogEntry = { id: "p2", kind: "question", shownAt: T0 };
    expect(promptFromRow(asStored<Tables<"prompt_log">>(promptToRow(unanswered, USER)))).toEqual(unanswered);

    const a: UserAssertion = { id: "as_1", kind: "satisfaction", at: T0, anchors: ["obs_1"], value: "regretted", askedAt: T0 - DAY };
    const row = assertionToRow(a, USER);
    expect(row).toMatchObject({ kind: "satisfaction", at: "2026-10-04T05:11:00.000Z", anchors: ["obs_1"] });
    expect(assertionFromRow(row)).toEqual(a);
  });
});

describe("export documents", () => {
  it("maps export_my_data() output into the port's order, withholding expired excerpts", () => {
    const o1 = makeObservation({ id: "obs_b", source: makeSource({ connectionId: "c1" }), receivedAt: T0, evidence: { summary: "s", excerpt: "e", excerptExpiresAt: T0 + DAY } });
    const o2 = makeObservation({ id: "obs_a", source: makeSource({ connectionId: "c1" }), receivedAt: T0 });
    const ts = (t: number) => toTimestamptz(t).replace(".000Z", "+00:00");
    const doc = {
      exported_at: ts(T0),
      user_settings: [],
      source_connections: ["c2", "c1"].map((id) => asStored(connectionToRow({ ...{ connectionId: id, adapterId: "a", kind: "sms", label: "l", status: "active", scopes: [], purposes: [], retention: { excerptTtlMs: DAY, observationTtlMs: null }, grantedAt: T0, updatedAt: T0 } } as SourceConnection, USER))),
      consent_events: [
        asStored(consentEventToRow({ connectionId: "c1", action: "paused", at: T0, scopes: [], purposes: [] }, USER), { id: 9 }),
        asStored(consentEventToRow({ connectionId: "c1", action: "granted", at: T0, scopes: [], purposes: [] }, USER), { id: 3 }),
      ],
      observations: [o1, o2].map((o) => asStored(observationToRow(o, USER, { now: T0, excerptTtlMs: DAY }), { created_at: ts(T0) })),
      user_assertions: [],
      budgets: [],
      goals: [],
      user_rules: [],
      owned_instruments: [],
      prompt_log: [],
    } as unknown as Json;

    const fresh = exportFromDocument(doc, T0, T0);
    expect(fresh.settings).toBeNull();
    expect(fresh.connections.map((c) => c.connectionId)).toEqual(["c1", "c2"]);
    expect(fresh.consentEvents.map((e) => e.action)).toEqual(["granted", "paused"]);
    expect(fresh.observations).toEqual([o2, o1]);

    const later = exportFromDocument(doc, T0 + DAY, T0 + DAY);
    expect(later.exportedAt).toBe(T0 + DAY);
    expect(later.observations[1]?.evidence).toEqual({ summary: "s" });
    expect(exportFromDocument({} as Json, T0, T0).observations).toEqual([]);
  });
});
