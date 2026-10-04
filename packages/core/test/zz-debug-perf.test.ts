import { it } from "vitest";
import { T0, makeObservation, makeSource } from "@brake/core/testing";
import { createFusionEngine } from "../src/fusion/engine";
import type { Observation } from "../src/model/observation";
import { DAY, MINUTE, fixedClock } from "../src/model/primitives";
const SRC = {
  sms: makeSource({ adapterId: "sms", kind: "sms", connectionId: "conn_sms", provider: "HDFC Bank", label: "x" }),
  gmail: makeSource({ adapterId: "gmail", kind: "email", connectionId: "conn_gmail", label: "Gmail inbox" }),
  bank: makeSource({ adapterId: "bank-api", kind: "open_banking", connectionId: "conn_bank", provider: "HDFC Bank", label: "y" }),
};
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 2 ** 32; }; }
const MERCHANTS = ["Swiggy", "Amazon", "Starbucks", "Carrefour", "Padaria Real", "Naivas", "Uber", "Lidl", "Pão de Açúcar", "Java House"];
const CURRENCIES = ["INR", "USD", "EUR", "BRL", "KES"];
it("debug", () => {
  const rand = lcg(42); const observations: Observation[] = []; let events = 0;
  while (observations.length < 5_000) {
    const i = events++; const currency = CURRENCIES[i % 5]!; const merchant = MERCHANTS[Math.floor(rand() * 10)]!;
    const at = T0 - 365 * DAY + Math.floor(rand() * 365 * DAY); const minor = Math.round(10 ** (2 + 4 * rand()));
    const base = { minor, currency, references: [], merchant: { raw: merchant.toUpperCase(), confidence: 0.8 } };
    observations.push(makeObservation({ ...base, id: `perf_alert_${i}`, source: SRC.sms, receivedAt: at, occurredAt: { value: at, confidence: 0.95 } }));
    if (rand() < 0.7) observations.push(makeObservation({ ...base, id: `perf_ledger_${i}`, source: SRC.bank, stage: "posted", receivedAt: at + DAY, occurredAt: { value: at, confidence: 0.4 }, references: [{ type: "provider_transaction_id", value: `L${i}`, namespace: "bank:perf" }] }));
    if (rand() < 0.3) observations.push(makeObservation({ ...base, id: `perf_receipt_${i}`, source: SRC.gmail, kind: "receipt", direction: undefined, receivedAt: at + 5 * MINUTE, occurredAt: { value: at, confidence: 0.9 }, merchant: { raw: merchant, name: merchant, confidence: 0.9 } }));
  }
  const engine = createFusionEngine({ clock: fixedClock(T0) });
  const out: string[] = [];
  const byId = new Map(observations.map(o => [o.id, o]));
  for (const o of observations.slice(0, 5000)) {
    const d = engine.ingest(o);
    if (d.outcome !== "linked" && !o.id.startsWith("perf_alert")) {
      out.push(`${o.id} ${d.outcome} ${o.amount?.value.minor} ${o.amount?.value.currency} t=${o.occurredAt?.value}`);
      for (const m of d.possibleMatches) { const c = engine.getCandidate(m.candidateId)!; out.push(`   -> ${m.probability.toFixed(4)} ${c.sourceSignals.map(s=>s.observationId).join(",")} ${c.amount?.value.minor} ${c.merchant.normalized} t=${c.timestampEstimated}`); }
    }
    if (d.outcome === "linked" && o.id.startsWith("perf_alert")) out.push(`ALERT LINKED ${o.id} -> ${engine.getCandidate(d.candidateId!)!.sourceSignals.map(s=>s.observationId).join(",")}`);
  }
  (globalThis as any).process.stdout.write(`COUNT ${engine.listCandidates().length}\n` + out.join("\n") + "\n");
});
