import { it } from "vitest";
import { money, DAY } from "@brake/core";
import { makeCandidate, makeObservation, T0 } from "@brake/core/testing";
import { createClassifier } from "../src/classify";
import { createUserModel } from "../src/user-model";
const show = (label: string, p: unknown) => console.log(label, JSON.stringify(p, null, 0));
it("scratch", () => {
  const cl = createClassifier();
  const um = createUserModel();
  const ctx = { userModel: um, now: T0 };
  // Brief example
  const amazon = makeCandidate({ minor: 479_900, merchant: { raw: "AMAZON PAY INDIA PRIVATE", normalized: null, displayName: null, confidence: 0.5, channel: "online" },
    lineItems: [
      { description: "Philips Sonicare Electric Toothbrush", total: money(249_900, "INR") },
      { description: "USB-C Cable 1m", total: money(50_000, "INR") },
      { description: "Pedigree Adult Dry Dog Food 3kg, Chicken & Vegetables", total: money(180_000, "INR") },
    ] });
  show("amazon items", cl.classify(amazon, [], ctx));
  const amazon2 = makeCandidate({ merchant: { raw: "AMZN Mktp US*2K4L80", normalized: null, displayName: null, confidence: 0.5, channel: "online" } });
  show("amazon plain", cl.classify(amazon2, [], ctx));
  const sw = makeCandidate({ merchant: { raw: "POS 4512XXXX SWIGGY BANGALORE", normalized: null, displayName: null, confidence: 0.5, channel: "unknown" } });
  show("swiggy+5812", cl.classify(sw, [makeObservation({ merchant: { raw: "SWIGGY", mcc: "5812", confidence: 0.9 } })], ctx));
  const nf = makeCandidate({ currency: "USD", minor: 2299, merchant: { raw: "PAYPAL *NETFLIX", normalized: null, displayName: null, confidence: 0.5, channel: "unknown" } });
  show("netflix", cl.classify(nf, [], ctx));
  const unk = makeCandidate({ merchant: { raw: null, normalized: null, displayName: null, confidence: 0, channel: "unknown" } });
  show("none", cl.classify(unk, [], ctx));
  const mcc = makeCandidate({ currency: "USD", merchant: { raw: "JOES MARKET 123", normalized: null, displayName: null, confidence: 0.5, channel: "unknown", mcc: "5411" } });
  show("mcc5411", cl.classify(mcc, [], ctx));
  const zer = makeCandidate({ merchant: { raw: "ZERODHA BROKING LTD", normalized: null, displayName: null, confidence: 0.5, channel: "unknown" } });
  show("zerodha", cl.classify(zer, [], ctx));
  const atm = makeCandidate({ merchant: { raw: "ATM WDL 1234", normalized: null, displayName: null, confidence: 0.5, channel: "unknown", mcc: "6011" } });
  show("atm", cl.classify(atm, [], ctx));
  // learning
  const am = makeCandidate({ merchant: { raw: "AMZN Mktp US*2K4L80", normalized: "amazon", displayName: "Amazon", confidence: 0.94, channel: "online" } });
  for (let i = 0; i < 3; i++) { um.observe({ id: `a${i}`, at: T0 - i * DAY, anchors: [`o${i}`], kind: "label", field: "category", value: "household" }, am); show(`after ${i+1}`, cl.classify(am, [], ctx).category); }
  show("json", um.toJSON());
});
