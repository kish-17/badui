import { describe, expect, it } from "vitest";
import { money, zonedTimeToEpoch } from "@brake/core";
import { detectCurrency, extractAmount, extractAmounts, lastFour, parseDateTime } from "../src/index";

describe("currency and amount extraction", () => {
  it("detects currencies, using country only as a tie-breaker", () => {
    expect(detectCurrency("Rs.1249.00 debited")).toBe("INR");
    expect(detectCurrency("Rs 500 paid", { country: "PK" })).toBe("PKR");
    expect(detectCurrency("$22.99 charged", { country: "CA" })).toBe("CAD");
    expect(detectCurrency("US$ 10")).toBe("USD");
    expect(detectCurrency("R$ 45,90 Pix")).toBe("BRL");
    expect(detectCurrency("Ksh1,200.00 sent to")).toBe("KES");
    expect(detectCurrency("hello there")).toBeNull();
  });

  it("extracts amounts with prefix and suffix markers", () => {
    expect(extractAmount("INR 1,249.00 debited from A/c XX1234")?.money).toEqual(money(124900, "INR"));
    expect(extractAmount("You paid ₹1,249 to Amazon")?.money).toEqual(money(124900, "INR"));
    expect(extractAmount("Betrag 1.234,56 € abgebucht")?.money).toEqual(money(123456, "EUR"));
    expect(extractAmount("Confirmed. Ksh1,200.00 sent to JOHN")?.money).toEqual(money(120000, "KES"));
    const all = extractAmounts("Rs.1249.00 debited. Avl Bal Rs.10,000.50");
    expect(all.map((a) => a.money.minor)).toEqual([124900, 1000050]);
  });

  it("ignores currency-like letters inside words", () => {
    expect(extractAmount("others 500 people")).toBeNull();
  });
});

describe("date parsing", () => {
  it("parses day-first numeric dates with times in a zone", () => {
    const r = parseDateTime("debited on 04-10-26 10:41:00", { timeZone: "Asia/Kolkata" });
    expect(r?.precision).toBe("datetime");
    expect(new Date(r!.at).toISOString()).toBe("2026-10-04T05:11:00.000Z");
  });

  it("uses month-first for US hints but corrects impossible orders", () => {
    expect(new Date(parseDateTime("10/04/2026", { country: "US" })!.at).toISOString()).toBe("2026-10-04T12:00:00.000Z");
    expect(new Date(parseDateTime("13/04/2026", { country: "US" })!.at).toISOString()).toBe("2026-04-13T12:00:00.000Z");
  });

  it("parses named months and ISO", () => {
    expect(new Date(parseDateTime("on 04-Oct-26 at 10:41 PM")!.at).toISOString()).toBe("2026-10-04T22:41:00.000Z");
    expect(new Date(parseDateTime("Oct 4, 2026")!.at).toISOString()).toBe("2026-10-04T12:00:00.000Z");
    expect(new Date(parseDateTime("2026-10-04T10:41:00")!.at).toISOString()).toBe("2026-10-04T10:41:00.000Z");
  });

  it("handles DST zones", () => {
    const t = zonedTimeToEpoch({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, "America/New_York");
    expect(new Date(t).toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });
});

describe("masked numbers", () => {
  it("extracts last four digits from masked tokens", () => {
    expect(lastFour("A/c XX1234 debited")).toBe("1234");
    expect(lastFour("card ending in 9876")).toBe("9876");
    expect(lastFour("Card **** 4321")).toBe("4321");
  });
});
