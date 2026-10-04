import { describe, expect, it } from "vitest";
import { isOneTimePasswordMessage, luhnValid, redactSensitive } from "../src/index";

describe("one-time password detection", () => {
  it("detects OTP messages, including ones that mention an amount", () => {
    expect(isOneTimePasswordMessage("123456 is your OTP for txn of Rs 1249.00 at AMAZON. Do not share.")).toBe(true);
    expect(isOneTimePasswordMessage("Your verification code is 4821")).toBe(true);
    expect(isOneTimePasswordMessage("Use OTP 908712 to login")).toBe(true);
  });

  it("does not treat transaction alerts with OTP disclaimers as OTPs", () => {
    const alert =
      "Rs.1249.00 debited from A/c XX1234 on 04-10-26 to VPA amazon@apl (UPI Ref No 627712345678). Never share OTP. Not you? Call 18002586161";
    expect(isOneTimePasswordMessage(alert)).toBe(false);
    expect(isOneTimePasswordMessage("Spent Rs.5000 on card 1234 at 10:41. Never share your OTP or PIN")).toBe(false);
  });
});

describe("redaction", () => {
  it("validates card numbers with Luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  it("masks cards, account numbers, ids, emails and codes", () => {
    const r = redactSensitive("Card 4111 1111 1111 1111 a/c 123456789012 PAN ABCDE1234F mail kishan@example.com");
    expect(r.text).not.toContain("4111 1111");
    expect(r.text).toContain("••••1111");
    expect(r.text).toContain("••••9012");
    expect(r.text).toContain("[id]");
    expect(r.text).toContain("k•••@example.com");
    expect(r.redactions).toEqual(expect.arrayContaining(["card_number", "account_number", "national_id", "email"]));

    const otp = redactSensitive("482193 is your OTP for Rs 500 at Swiggy");
    expect(otp.text).toContain("[code]");
    expect(otp.text).toContain("Rs 500");
    expect(otp.redactions).toContain("otp");
  });
});
