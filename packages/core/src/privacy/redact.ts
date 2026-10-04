import type { RedactionKind, RedactionResult } from "./types";

/**
 * Data-minimisation helpers used by every adapter before anything is kept.
 * Raw payloads are never persisted; these functions shape the only text that
 * may survive (an expiring evidence excerpt) and detect messages that must be
 * dropped outright (one-time passwords).
 */

const OTP_KEYWORD =
  /\b(otp|one[\s-]?time[\s-]?(?:pass(?:word|code)?|pin|code)|verification code|security code|auth(?:entication|orization)? code|passcode|login code|confirmation code|código|codigo|senha)\b/i;

/** Currency markers that make a following number an amount, not a code. */
const CURRENCY_BEFORE = /(?:rs\.?|inr|usd|eur|gbp|brl|kes|ksh|ngn|idr|rp|r\$|us\$|[₹$€£¥₦₱฿₫₩])\s*$/i;

/**
 * True when the message is (or carries) a one-time password. Such messages
 * are dropped by adapters immediately — BRAKE never stores or forwards OTPs,
 * even when they mention an amount and merchant.
 *
 * A bare disclaimer ("Never share your OTP with anyone") without a code does
 * not make a transaction alert an OTP message.
 */
export function isOneTimePasswordMessage(text: string): boolean {
  if (!OTP_KEYWORD.test(text)) return false;
  const keywordRe = new RegExp(OTP_KEYWORD.source, "gi");
  const codes = findCodes(text);
  if (codes.length === 0) return false;

  for (let k = keywordRe.exec(text); k !== null; k = keywordRe.exec(text)) {
    const keywordEnd = k.index + k[0].length;
    const disclaimer = /(never|do not|don't|dont|not to)\s+(share|disclose)\b[^.\n]{0,20}$/i.test(
      text.slice(Math.max(0, k.index - 30), k.index),
    );
    for (const c of codes) {
      // "OTP is 123456", "OTP: 123456", "OTP for txn of Rs 1,249 at AMAZON is 123456", "Use OTP 908712".
      if (!disclaimer && c.index >= keywordEnd && c.index - keywordEnd <= 60) {
        const between = text.slice(keywordEnd, c.index);
        if (!/\.\s|\n/.test(between)) return true;
      }
      // "123456 is your OTP", "4821 is the verification code for …".
      if (c.index + c.value.length <= k.index) {
        const between = text.slice(c.index + c.value.length, k.index);
        if (/^\s*(?:is|-|:)\s+(?:your|the)?\s*(?:[\w-]+\s+){0,3}$/i.test(between)) return true;
      }
    }
  }
  return false;
}

/** Standalone 4–8 digit tokens that are not amounts, dates, times or parts of masked numbers. */
function findCodes(text: string): Array<{ index: number; value: string }> {
  const out: Array<{ index: number; value: string }> = [];
  const codeRe = /(?<![\w*•.,:/-])\d{4,8}(?![\w]|[.,:/-]\d)/g;
  for (let m = codeRe.exec(text); m !== null; m = codeRe.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (CURRENCY_BEFORE.test(before)) continue;
    out.push({ index: m.index, value: m[0] });
  }
  return out;
}

/** Luhn checksum, used to recognise real card numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** "123456789012" -> "••••9012". Keeps at most the last `keep` characters. */
export function maskTail(value: string, keep = 4): string {
  const clean = value.replace(/[\s-]/g, "");
  return `••••${clean.slice(-Math.min(keep, 4))}`;
}

/**
 * Redact sensitive tokens from text that may be kept as an evidence excerpt.
 * Order matters: card numbers before generic digit runs.
 */
export function redactSensitive(text: string): RedactionResult {
  const found = new Set<RedactionKind>();
  let out = text;

  if (isOneTimePasswordMessage(out)) {
    const codes = findCodes(out);
    for (let i = codes.length - 1; i >= 0; i--) {
      const c = codes[i]!;
      out = `${out.slice(0, c.index)}[code]${out.slice(c.index + c.value.length)}`;
    }
    if (codes.length > 0) found.add("otp");
  }

  // CVV / PIN mentions.
  out = out.replace(/\b(cvv2?|cvc|pin)\b(\s*(?:is|:)?\s*)\d{3,6}\b/gi, (_m, label: string, sep: string) => {
    found.add("cvv");
    return `${label}${sep}[redacted]`;
  });

  // Card numbers: 13-19 digits, optionally grouped by spaces/dashes, Luhn-valid.
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (luhnValid(digits)) {
      found.add("card_number");
      return maskTail(digits);
    }
    return match;
  });

  // Indian Aadhaar (4-4-4) and US SSN.
  out = out.replace(/\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, () => {
    found.add("national_id");
    return "[id]";
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    found.add("national_id");
    return "[id]";
  });
  // Indian PAN (tax id): 5 letters, 4 digits, 1 letter.
  out = out.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => {
    found.add("national_id");
    return "[id]";
  });

  // Long digit runs (account numbers, references) — keep last 4 only.
  out = out.replace(/(?<![\d•])\d{9,18}(?!\d)/g, (match) => {
    found.add("account_number");
    return maskTail(match);
  });

  // Email addresses: keep first character and domain.
  out = out.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, first: string, domain: string) => {
    found.add("email");
    return `${first}•••@${domain}`;
  });

  // Phone numbers in international format.
  out = out.replace(/\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12}/g, (match) => {
    found.add("phone");
    return maskTail(match.replace(/\D/g, ""), 2);
  });

  return { text: out, redactions: [...found] };
}
