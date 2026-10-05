import { DAY, HOUR, money } from "@brake/core";
import type { Goal, Observation, PromptLogEntry, SourceConnection, StoredInstrument, UserAssertion, UserRule, UserSettings } from "@brake/core";
import { makeObservation, makeSource } from "@brake/core/testing";
import { describe, expect, it } from "vitest";
import * as memory from "../../core/src/store-memory";
import {
  ColumnWidthError,
  assertionFromRow,
  assertionToRow,
  budgetFromRow,
  budgetId,
  budgetToRow,
  compareCodePoints,
  connectionFromRow,
  connectionToRow,
  consentEventFromRow,
  consentEventToRow,
  containsUnstorableText,
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
  storableExcerpt,
  toTimestamptz,
  toTimestamptzBound,
  MAX_INSTANT,
  MIN_INSTANT,
} from "../src/rows";
import type { Json, Tables } from "../src/index";

const T0 = Date.UTC(2026, 9, 4, 5, 11, 0);
const USER = "6f1c2c1e-6f3b-4c4e-9d8e-2a6b7c8d9e0f";

/** The message of the error `fn` throws (fails the test if it does not throw). */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a throw");
}

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

  it("covers the whole storable range, including years 1-99 and past 9999", () => {
    expect(toTimestamptz(MIN_INSTANT)).toBe("0001-01-01T00:00:00.000Z");
    // Postgres reads "+010000-…" as a time-zone displacement, so the sign is dropped.
    expect(toTimestamptz(Date.parse("+010000-01-01T00:00:00.000Z"))).toBe("010000-01-01T00:00:00.000Z");
    expect(toTimestamptz(MAX_INSTANT)).toBe("275760-09-13T00:00:00.000Z");
    const year50 = Date.parse("0050-06-15T12:00:00.000Z");
    // Date.UTC would read year 50 as 1950.
    expect(fromTimestamptz("0050-06-15T12:00:00+00:00")).toBe(year50);
    expect(fromTimestamptz("275760-09-13T00:00:00+00:00")).toBe(MAX_INSTANT);
    // 0001-01-01 UTC as a database west of Greenwich prints it (St John's local mean time, year 1 BC).
    expect(fromTimestamptz("0001-12-31T20:29:08-03:30:52 BC")).toBe(MIN_INSTANT);
    expect(fromTimestamptz("0001-01-01T05:53:28+05:53:28")).toBe(MIN_INSTANT);
    for (const t of [MIN_INSTANT, year50, Date.parse("9999-12-31T23:59:59.999Z"), MAX_INSTANT]) {
      expect(fromTimestamptz(toTimestamptz(t))).toBe(t);
    }
  });

  it("refuses fractional or out-of-range instants without echoing them", () => {
    for (const bad of [T0 + 0.5, MIN_INSTANT - 1, MAX_INSTANT + 1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(() => toTimestamptz(bad)).toThrow(RangeError);
    }
    expect(thrown(() => toTimestamptz(T0 + 0.5))).not.toContain(String(T0));
    expect(() => fromTimestamptz("SECRET")).toThrow(/^Unrecognised timestamptz$/);
  });

  it("turns query bounds into filter values with the memory store's numeric semantics", () => {
    expect(toTimestamptzBound(Number.NEGATIVE_INFINITY)).toBe("-infinity");
    expect(toTimestamptzBound(-1e300)).toBe("-infinity");
    expect(toTimestamptzBound(Number.POSITIVE_INFINITY)).toBe("infinity");
    expect(toTimestamptzBound(1e16)).toBe("infinity");
    // Over whole-millisecond instants, t >= x.5 and t < x.5 both mean "from x + 1".
    expect(toTimestamptzBound(T0 + 0.5)).toBe(toTimestamptz(T0 + 1));
    expect(toTimestamptzBound(T0)).toBe(toTimestamptz(T0));
    expect(() => toTimestamptzBound(Number.NaN)).toThrow(RangeError);
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
    for (const id of ["obs_1", "a:b", '"q"', "🙂", ""]) {
      expect(encodeCursor(T0, id)).toBe(memory.encodeCursor(T0, id));
      expect(decodeCursor(memory.encodeCursor(T0, id))).toEqual({ receivedAt: T0, id });
    }
    expect(() => decodeCursor("nope")).toThrow(RangeError);
    for (const forged of ["99999999999999999999:x", `${MAX_INSTANT + 1}:x`, `${MIN_INSTANT - 1}:x`]) {
      expect(() => decodeCursor(forged)).toThrow(RangeError);
      expect(() => memory.decodeCursor(forged)).toThrow(RangeError);
    }
    for (const edge of [MIN_INSTANT, MAX_INSTANT]) expect(decodeCursor(encodeCursor(edge, "x"))).toEqual(memory.decodeCursor(memory.encodeCursor(edge, "x")));
    expect([MIN_INSTANT, MAX_INSTANT]).toEqual([memory.MIN_INSTANT, memory.MAX_INSTANT]);
  });

  it("order text and recognise unstorable text exactly as the memory store does", () => {
    const words = ["", "a", "A", "é", "e\u0301", "obs\uFF5A", "obs🙂", "obs", "obs_", "obs ", "\u{10FFFF}", "\uFFFF"];
    for (const a of words) for (const b of words) expect(Math.sign(compareCodePoints(a, b))).toBe(Math.sign(memory.compareCodePoints(a, b)));
    const half = "🙂".slice(0, 1);
    const samples: unknown[] = ["ok 🙂", `x${half}`, `${"🙂".slice(1)}`, "a\u0000", { [`k${half}`]: 1 }, [["deep", { v: "\u0000" }]], 42, null];
    for (const v of samples) expect(containsUnstorableText(v)).toBe(memory.containsUnstorableText(v));
  });

  it("cap excerpts exactly as the memory store does", () => {
    const expiries = [undefined, T0 - 1, T0 + 0.4, T0 + DAY + 0.9, Number.NaN, Number.MAX_SAFE_INTEGER];
    const ttls = [0, 1, DAY, 7 * DAY, Number.MAX_SAFE_INTEGER];
    for (const excerptExpiresAt of expiries) {
      for (const excerptTtlMs of ttls) {
        const evidence = excerptExpiresAt === undefined ? { summary: "s", excerpt: "e" } : { summary: "s", excerpt: "e", excerptExpiresAt };
        const o = makeObservation({ receivedAt: T0, evidence });
        const kept = storableExcerpt(o, { now: T0, excerptTtlMs });
        const reference = memory.storableEvidence(o, excerptTtlMs, T0);
        expect(kept === null ? undefined : kept.expiresAt).toBe(reference.excerptExpiresAt);
      }
    }
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

  it("round-trips every Observation field, with undefined optionals dropped exactly as the wire drops them", () => {
    const rich: Observation = {
      id: "obs_rich 🙂",
      source: { adapterId: "sms", kind: "sms", connectionId: "conn_a", provider: "Banco São Paulo", label: "مصرف SMS alert" },
      kind: "money_movement",
      window: "post_spend",
      stage: "posted",
      receivedAt: T0,
      occurredAt: { value: -86_400_001, confidence: 0.5, approximate: true },
      direction: "credit",
      amount: { value: money(Number.MAX_SAFE_INTEGER, "JPY"), confidence: 1, approximate: false },
      amountBreakdown: [
        { kind: "fx_fee", amount: money(Number.MAX_SAFE_INTEGER - 1, "USD") },
        { kind: "discount", amount: money(0, "JPY") },
      ],
      merchant: { raw: "CAFÉ é ☕ «Zürich»", name: undefined, key: "cafe", mcc: "5814", handle: "cafe@upi", website: "https://café.example", channel: "in_store", confidence: 0.3 },
      counterparty: { name: "Ünal", handle: "u@okbank", isSelf: 0, isMerchant: 1 },
      instrument: { type: "upi_handle", issuer: "Bank", network: "rupay", last4: "0000", accountRef: "acc_1", cardKind: undefined },
      rail: { family: "account_to_account_instant", scheme: "upi" },
      country: "BR",
      references: [
        { type: "rail_reference", value: "E00038166202610040511s0", namespace: "pix" },
        { type: "order_id", value: "", namespace: undefined },
      ],
      lineItems: [
        { description: "Pão de queijo\n\t\"quoted\" \\ back", quantity: 0.5, unitPrice: money(1, "BRL"), total: money(1, "BRL"), categoryHints: [], productId: "7891000100103" },
        { description: "" },
      ],
      categoryHints: [{ scheme: "brake", value: "food.cafe", confidence: 1e-9 }],
      typeHints: [{ type: "transfer", transferKind: "family", confidence: 0.1 + 0.2, reason: "pix:family" }],
      subscription: { event: "price_change", period: "P1M", nextChargeAt: MAX_INSTANT, trialEndsAt: MIN_INSTANT, price: money(1, "BRL"), previousPrice: money(2, "BRL") },
      balance: { available: money(0, "BRL"), current: money(1, "BRL"), limit: money(Number.MAX_SAFE_INTEGER, "BRL") },
      intent: { via: "qr", title: "", url: "https://x.example/?a=1&b=2", productId: "1" },
      confidence: 1,
      evidence: { summary: "Pix recebido de Ünal", excerpt: "Pix R$ 1,00 — Ünal 🙂", excerptExpiresAt: T0 + DAY },
    };
    const row = asStored<Tables<"observations">>(observationToRow(rich, USER, { now: T0, excerptTtlMs: 7 * DAY }), {
      excerpt_expires_at: "2026-10-05T10:41:00.000+05:30",
      created_at: "2026-10-04T05:11:00+00:00",
    });
    expect(row).toMatchObject({ amount_minor: Number.MAX_SAFE_INTEGER, currency: "JPY", occurred_at: "1969-12-30T23:59:59.999Z", direction: "credit" });
    // Strict: an `undefined` optional must come back absent, not as an undefined-valued key.
    expect(observationFromRow(row, T0)).toStrictEqual(JSON.parse(JSON.stringify(rich)));
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
    expect(() => observationToRow({ ...base, receivedAt: T0 + 0.5 }, USER, { now: T0, excerptTtlMs: 0 })).toThrow(RangeError);
  });

  it("refuses bigint values JavaScript cannot read back, and confidences outside [0, 1]", () => {
    const ctx = { now: T0, excerptTtlMs: 0 };
    const withMinor = (minor: number): Observation => ({ ...base, amount: { value: money(minor, "INR"), confidence: 1 } });
    expect(observationToRow(withMinor(Number.MAX_SAFE_INTEGER), USER, ctx).amount_minor).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => observationToRow(withMinor(2 ** 53), USER, ctx)).toThrow(RangeError);
    expect(() => budgetToRow({ limit: money(2 ** 53, "INR"), period: "weekly" }, USER)).toThrow(RangeError);
    expect(() => goalToRow({ id: "g", name: "n", target: money(1, "INR"), saved: money(2 ** 53, "INR") }, USER)).toThrow(RangeError);
    for (const confidence of [1 + 1e-9, -1e-9, Number.NaN]) expect(() => observationToRow({ ...base, confidence }, USER, ctx)).toThrow(RangeError);
  });

  it("projects a confidence too small for float4 as 0, keeping the exact value in facts", () => {
    const row = observationToRow({ ...base, confidence: 1e-50 }, USER, { now: T0, excerptTtlMs: 0 });
    expect(row.confidence).toBe(0);
    expect((row.facts as { confidence: number }).confidence).toBe(1e-50);
    expect(observationToRow({ ...base, confidence: 0.95 }, USER, { now: T0, excerptTtlMs: 0 }).confidence).toBe(0.95);
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

  it("refuses codes wider than their char(n) column, trailing spaces included, as 22001", () => {
    // Postgres would store "INR " as "INR" (it drops excess trailing spaces), so the read would not equal the write.
    const settings: UserSettings = { locale: "en-IN", timeZone: "Asia/Kolkata", questionWeeklyBudget: 5, regretPromptsEnabled: true };
    const ctx = { now: T0, excerptTtlMs: 0 };
    const wide: Array<() => unknown> = [
      () => budgetToRow({ limit: { minor: 1, currency: "INR " }, period: "weekly" }, USER),
      () => settingsToRow({ ...settings, homeCountry: "IN " }, USER),
      () => settingsToRow({ ...settings, homeCurrency: "INRR" }, USER),
      () => goalToRow({ id: "g", name: "n", target: { minor: 1, currency: "INR " }, saved: { minor: 0, currency: "INR " } }, USER),
      () => observationToRow(makeObservation({ amount: { value: { minor: 1, currency: "INR " }, confidence: 1 } }), USER, ctx),
    ];
    for (const write of wide) {
      expect(write).toThrow(ColumnWidthError);
      expect(write).toThrow(expect.objectContaining({ code: "22001" }));
    }
    // Width counts characters, not UTF-16 units or bytes; a narrower value is left to the CHECK constraint.
    expect(settingsToRow({ ...settings, homeCountry: "🙂🙂" }, USER).home_country).toBe("🙂🙂");
    expect(budgetToRow({ limit: { minor: 1, currency: "IN" }, period: "weekly" }, USER).currency).toBe("IN");
  });

  it("stores a goal in one currency and refuses mixed currencies", () => {
    const g: Goal = { id: "g1", name: "Trip", target: money(5_000_000, "INR"), saved: money(10, "INR"), targetDate: T0 + 90 * DAY };
    const row = goalToRow(g, USER);
    expect(row).toMatchObject({ currency: "INR", target_minor: 5_000_000, saved_minor: 10 });
    expect(goalFromRow(asStored<Tables<"goals">>(row))).toEqual(g);
    expect(() => goalToRow({ ...g, saved: money(10, "USD") }, USER)).toThrow(RangeError);
    // Messages never quote row values.
    expect(thrown(() => goalToRow({ ...g, id: "SECRET", saved: money(10, "USD") }, USER))).not.toMatch(/SECRET|USD|INR/);
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
