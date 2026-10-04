import { describe, expect, it } from "vitest";
import { amountsClose, currencyExponent, formatMoney, money, moneyFromMajor, parseAmount } from "../src/index";

describe("money", () => {
  it("knows currency exponents", () => {
    expect(currencyExponent("INR")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("parses human amounts in many conventions", () => {
    expect(parseAmount("Rs.1249.00", "INR")).toEqual(money(124900, "INR"));
    expect(parseAmount("₹1,249", "INR")).toEqual(money(124900, "INR"));
    expect(parseAmount("INR 1,00,000.50 debited", "INR")).toEqual(money(10000050, "INR"));
    expect(parseAmount("1,00,000", "INR")).toEqual(money(10000000, "INR"));
    expect(parseAmount("$22.99", "USD")).toEqual(money(2299, "USD"));
    expect(parseAmount("R$ 1.234,56", "BRL")).toEqual(money(123456, "BRL"));
    expect(parseAmount("12,50 €", "EUR")).toEqual(money(1250, "EUR"));
    expect(parseAmount("1 234,56 €", "EUR")).toEqual(money(123456, "EUR"));
    expect(parseAmount("¥1,200", "JPY")).toEqual(money(1200, "JPY"));
    expect(parseAmount("KWD 1.250", "KWD")).toEqual(money(1250, "KWD"));
    expect(parseAmount("no number here", "INR")).toBeNull();
  });

  it("does not glue adjacent numbers together", () => {
    expect(parseAmount("1249.00 1234", "INR")).toEqual(money(124900, "INR"));
  });

  it("honours an explicit decimal separator", () => {
    expect(parseAmount("1.249", "EUR", { decimalSeparator: "," })).toEqual(money(124900, "EUR"));
  });

  it("compares with tolerance and formats per locale", () => {
    expect(amountsClose(money(124900, "INR"), money(124901, "INR"), { absMinor: 1 })).toBe(true);
    expect(amountsClose(money(100, "INR"), money(100, "USD"), { absMinor: 1000 })).toBe(false);
    expect(formatMoney(moneyFromMajor(1249, "INR"), "en-IN")).toBe("₹1,249");
    expect(formatMoney(moneyFromMajor(150000, "INR"), "en-IN")).toBe("₹1,50,000");
    expect(formatMoney(money(2299, "USD"), "en-US")).toBe("$22.99");
  });
});
