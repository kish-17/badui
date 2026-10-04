import { describe, expect, it } from "vitest";
import { DAY, fixedClock, money } from "../src/index";
import {
  MAX_INSTANT,
  budgetId,
  compareCodePoints,
  containsCardNumber,
  containsUnstorableText,
  jsonContainsCardNumber,
  jsonbSize,
  createMemoryStore,
  decodeCursor,
  encodeCursor,
  pageSize,
  storableEvidence,
  visibleObservation,
} from "../src/store-memory";
import { CONTRACT_T0, contractConnection, contractObservation, describeStoreContract } from "./store-contract";

describeStoreContract("memory", async ({ clock }) => ({ store: createMemoryStore({ clock }) }));

describe("memory store helpers", () => {
  const T0 = CONTRACT_T0;

  it("derives budget ids from the natural key unless one is given", () => {
    expect(budgetId({ category: "food", limit: money(1, "INR"), period: "weekly" })).toBe("food:weekly:INR");
    expect(budgetId({ limit: money(1, "USD"), period: "monthly" })).toBe("all:monthly:USD");
    expect(budgetId({ id: "mine", limit: money(1, "USD"), period: "monthly" })).toBe("mine");
  });

  it("round-trips cursors, including ids with separators", () => {
    for (const id of ["obs_1", "a:b:c", "x\ny", "🙂"]) expect(decodeCursor(encodeCursor(T0, id))).toEqual({ receivedAt: T0, id });
    expect(decodeCursor(encodeCursor(-5, "neg"))).toEqual({ receivedAt: -5, id: "neg" });
    expect(() => decodeCursor("garbage")).toThrow(RangeError);
    expect(() => decodeCursor(":obs")).toThrow(RangeError);
    // An empty id is a valid key in Postgres, so a page may end on it.
    expect(decodeCursor(encodeCursor(12, ""))).toEqual({ receivedAt: 12, id: "" });
  });

  it("normalizes page sizes", () => {
    expect(pageSize(undefined)).toBe(500);
    expect(pageSize(10)).toBe(10);
    expect(pageSize(10_000)).toBe(1000);
    expect(() => pageSize(0)).toThrow(RangeError);
    expect(() => pageSize(Number.NaN)).toThrow(RangeError);
  });

  it("caps excerpts by the stricter of adapter expiry and connection TTL", () => {
    const o = contractObservation("o", "c", T0, { evidence: { summary: "s", excerpt: "e", excerptExpiresAt: T0 + 3 * DAY } });
    expect(storableEvidence(o, 7 * DAY, T0)).toEqual({ summary: "s", excerpt: "e", excerptExpiresAt: T0 + 3 * DAY });
    expect(storableEvidence(o, DAY, T0)).toEqual({ summary: "s", excerpt: "e", excerptExpiresAt: T0 + DAY });
    expect(storableEvidence(o, 0, T0)).toEqual({ summary: "s" });
    expect(storableEvidence(o, 7 * DAY, T0 + 3 * DAY)).toEqual({ summary: "s" });
    const bad = contractObservation("o", "c", T0, { evidence: { summary: "s", excerpt: "e", excerptExpiresAt: Number.NaN } });
    expect(storableEvidence(bad, 7 * DAY, T0)).toEqual({ summary: "s" });
  });

  it("floors excerpt expiries and never caps them past the last storable instant", () => {
    const o = contractObservation("o", "c", T0, { evidence: { summary: "s", excerpt: "e", excerptExpiresAt: T0 + DAY + 0.9 } });
    expect(storableEvidence(o, 7 * DAY, T0).excerptExpiresAt).toBe(T0 + DAY);
    const forever = contractObservation("o", "c", T0, { evidence: { summary: "s", excerpt: "e" } });
    expect(storableEvidence(forever, Number.MAX_SAFE_INTEGER, T0).excerptExpiresAt).toBe(MAX_INSTANT);
  });

  it("orders text by code point, like Postgres under the C collation", () => {
    // UTF-16 code units would put the astral emoji (0xD83D…) before U+FF5A.
    expect(["obs🙂", "obs\uFF5A", "obs", "obsa", ""].sort(compareCodePoints)).toEqual(["", "obs", "obsa", "obs\uFF5A", "obs🙂"]);
    expect(compareCodePoints("é", "é")).toBe(0);
  });

  it("recognises text Postgres cannot store", () => {
    const half = "🙂".slice(0, 1);
    expect(containsUnstorableText("CAFÉ 🙂")).toBe(false);
    expect(containsUnstorableText(`x${half}`)).toBe(true);
    expect(containsUnstorableText(`${"🙂".slice(1)}x`)).toBe(true);
    expect(containsUnstorableText("a\u0000b")).toBe(true);
    expect(containsUnstorableText({ deep: [{ ok: "fine" }, { [`k${half}`]: 1 }] })).toBe(true);
    expect(containsUnstorableText({ n: 1, b: true, z: null })).toBe(false);
  });

  it("sizes jsonb the way pg_column_size does (verified against Postgres in store.db.test.ts)", () => {
    expect(jsonbSize({})).toBe(8);
    expect(jsonbSize([])).toBe(8);
    expect(jsonbSize(null)).toBe(12);
    // Values measured with pg_column_size on Postgres 16.
    expect(jsonbSize({ a: 1 })).toBe(28);
    expect(jsonbSize({ a: "x" })).toBe(18);
    // Numbers cost 6 + 2 bytes per base-10000 digit group, aligned to 4 bytes.
    expect(jsonbSize([0])).toBe(18);
    expect(jsonbSize([12345])).toBe(22);
    expect(jsonbSize([10000])).toBe(20);
    expect(jsonbSize([1e21])).toBe(20);
    // Escapes are resolved: a newline is one byte, not two.
    expect(jsonbSize({ d: "\n".repeat(100) })).toBe(117);
  });

  it("hides expired excerpts from readers", () => {
    const o = contractObservation("o", "c", T0, { evidence: { summary: "s", excerpt: "e", excerptExpiresAt: T0 + DAY } });
    expect(visibleObservation(o, T0).evidence.excerpt).toBe("e");
    expect(visibleObservation(o, T0 + DAY).evidence).toEqual({ summary: "s" });
  });

  it("recognises only Luhn-valid card-shaped digit runs as card numbers", () => {
    expect(containsCardNumber("paid with 4111111111111111 today")).toBe(true);
    expect(containsCardNumber("ref 4111111111111112")).toBe(false);
    expect(containsCardNumber("utr 627712345678")).toBe(false);
    expect(containsCardNumber("4111 1111 1111 1111")).toBe(true);
    expect(containsCardNumber("4111-1111-1111-1111")).toBe(true);
    expect(containsCardNumber("amex 3782 822463 10005")).toBe(true);
    // Bounded like Postgres \y: digits glued to letters or longer runs are not a card.
    expect(containsCardNumber("x4111111111111111")).toBe(false);
    expect(containsCardNumber("94111111111111111111")).toBe(false);
    expect(containsCardNumber("order 408-1234567-1234567")).toBe(false);
  });

  it("scans JSON strings except numeric-by-design identifiers", () => {
    const card = "4111111111111111";
    expect(jsonContainsCardNumber({ merchant: { raw: card } })).toBe(true);
    expect(jsonContainsCardNumber({ tags: ["x", card] })).toBe(true);
    expect(jsonContainsCardNumber({ references: [{ type: "order_id", value: card }] })).toBe(false);
    expect(jsonContainsCardNumber({ references: [{ type: card, value: "x" }] })).toBe(true);
    expect(jsonContainsCardNumber({ lineItems: [{ productId: card }], intent: { url: card }, merchant: { website: card } })).toBe(false);
    // Numbers (amounts, epoch-millisecond instants) and object keys are not text.
    expect(jsonContainsCardNumber({ receivedAt: Number(card) })).toBe(false);
    expect(jsonContainsCardNumber({ [card]: "x" })).toBe(false);
  });

  it("uses the injected clock and never the wall clock", async () => {
    const clock = fixedClock(T0);
    const store = createMemoryStore({ clock });
    await store.upsertConnection(contractConnection("c"));
    expect((await store.exportAll()).exportedAt).toBe(T0);
    clock.advance(DAY);
    expect((await store.exportAll()).exportedAt).toBe(T0 + DAY);
  });
});
