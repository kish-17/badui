# BRAKE architecture overview

> North star: *"What combination of independent signals gives BRAKE enough
> context to improve a user's spending decisions?"* — not "how do we get every
> transaction?"

BRAKE is built so that **no data source is the product**. Plaid, Account
Aggregator, Gmail, SMS, Android notifications, UPI intents, QR scans and
receipts are interchangeable inputs to one provider-agnostic financial event
layer. Product behaviour is built on capabilities and normalized events, never
on a particular bank, country, OS, rail or vendor.

## Layers

```
 ┌──────────────────────────── capture (platform-native, outside this repo) ───────────────────────────┐
 │ Kotlin NotificationListenerService · SMS receiver · Swift App Intent fed by a Wallet automation ·   │
 │ FinanceKit bridge · Screen Time shield events · share/Action extensions · browser extension ·        │
 │ Gmail/Graph fetchers · Plaid/AA/card-feed webhook handlers · camera (QR/receipt OCR)                 │
 └───────────────────────────────┬──────────────────────────────────────────────────────────────────────┘
                                 │ RawSignal<P> JSON envelope {adapterId, connectionId, receivedAt, payload}
 ┌───────────────────────────────▼───────────────────────── @brake/adapters ───────────────────────────┐
 │ Pure functions RawSignal → AdapterResult. All provider knowledge lives here (formats, sender ids,    │
 │ package names, provider category vocabularies). OTPs dropped; PII redacted; raw payload discarded.   │
 └───────────────────────────────┬──────────────────────────────────────────────────────────────────────┘
                                 │ Observation (normalized fact-with-uncertainty + provenance)
 ┌───────────────────────────────▼───────────────────────── @brake/core ───────────────────────────────┐
 │ Fusion engine: blocking → Fellegi–Sunter scoring → conservative linking → field fusion.              │
 │ TransactionCandidate (derived, reversible) · UserAssertions (anchored to observations) ·             │
 │ consent registry · retention · provenance explanations · redaction                                   │
 └───────────────────────────────┬──────────────────────────────────────────────────────────────────────┘
                                 │ TransactionCandidate + context observations
 ┌───────────────────────────────▼───────────────────────── @brake/intelligence ───────────────────────┐
 │ Provider-blind. Merchant normalization · classification · reconciliation (transfer vs spending) ·    │
 │ recurring & subscriptions · spending rules · uncertainty-driven questions · regret learning ·        │
 │ post-spend insights · pre/in-spend interventions · confidence-aware copy · orchestration             │
 └───────────────────────────────┬──────────────────────────────────────────────────────────────────────┘
                                 │ BrakeEvent (question, insight, intervention, recurring alert …)
 ┌───────────────────────────────▼──────────────────── surfaces (app shells, outside this repo) ───────┐
 │ notification quick actions · widgets · Live Activities · Screen Time shield UI · extension popups   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘

 @brake/capabilities sits beside the pipeline: a machine-readable registry of country × platform ×
 source capabilities that decides which sources are offered, how strong each spend window is, which
 features run in full or degraded mode, and which source to suggest next.
```

### Dependency rules (enforced by `packages/intelligence/test/architecture.test.ts`)

| Package        | May depend on | Must never contain |
|----------------|---------------|--------------------|
| `core`         | nothing       | product policy, provider knowledge, platform APIs |
| `adapters`     | `core`        | product policy (when to ask/intervene), I/O, credentials |
| `capabilities` | `core`        | product logic beyond capability resolution |
| `intelligence` | `core`        | provider/aggregator/OS names, branches on `adapterId`/`connectionId` |

## The event model

* **Observation** — one source's claim about (possibly) one event at one time:
  kind (`purchase_intent`, `checkout`, `money_movement`, `order`, `receipt`,
  `refund_notice`, `subscription_event`, `mandate`, `balance_snapshot`,
  `app_context`, …), spend window, lifecycle stage, measured amount/time,
  merchant/counterparty/instrument, rail family + scheme, typed references,
  line items, neutral category/type hints, confidence and a minimised evidence
  summary. Immutable. See `packages/core/src/model/observation.ts`.
* **TransactionCandidate** — BRAKE's belief about one event, fused from one or
  more observations. Every uncertain field is an `Inference` (value,
  confidence, alternatives, basis); status follows `intent → pending →
  confirmed → posted` (or `refunded`/`cancelled`). Field-level provenance
  answers "How did BRAKE know this?". See `packages/core/src/model/candidate.ts`.
* **UserAssertion** — what the user told BRAKE (labels, satisfaction, same /
  different event, dismiss, confirm), anchored to observation ids so it
  survives re-fusion.

Observations and assertions are the source of truth; candidates are a derived,
recomputable view. Disconnecting a source deletes its observations and
recomputes candidates — nothing else needs special-casing.

## Three time windows

Every source declares the windows it serves; every observation carries one.

| Window | What BRAKE can do | Typical sources |
|--------|-------------------|-----------------|
| Pre-spend | capture intent, offer a check or a pause, show goal/budget impact | "Should I buy this?", share sheet, QR scan, browser cart, app-launch shield, voice |
| In-spend | light, confidence-bounded nudges while paying | UPI intent hand-off, checkout pages, Wallet tap automation, real-time card/UPI alerts |
| Post-spend | understand, classify, learn, insight or silence | bank alerts, ledgers (Plaid/AA/open banking), receipts, order/subscription emails |

A source does not need to serve every window. The capability registry turns
the set of connected sources into a per-window coverage score
(`1 − Π(1 − strengthᵢ)`), so BRAKE gets stronger as users connect more
independent sources and still works with none.

## Capability-based degradation

Features declare the source sets that enable full and degraded modes; the
resolver evaluates them for a user's country, platforms and connections. For
example a user with no connected accounts still gets the manual purchase check,
QR scanning (where QR payments exist), goals, share/browser interventions and
regret learning on manually entered purchases. See
`docs/architecture/capabilities.md` and `packages/capabilities`.

## Confidence-aware behaviour

* Copy tiers (`packages/intelligence/src/copy.ts`): ≥ 0.85 states the fact,
  ≥ 0.6 says "Looks like … about …", below asks.
* Interventions are bounded by confidence: < 0.4 none, < 0.6 at most a quiet
  inform. BRAKE never blocks a purchase.
* Questions are asked only when their expected value of information beats a
  fatigue-aware cost and a weekly budget.
* Insights are gated: silence is the default; "You spent ₹500." is never sent.

## Privacy architecture

* Minimum collection: adapters drop OTPs and non-financial content before
  parsing and never return raw payloads.
* Minimum storage: observations keep extracted facts; evidence excerpts are
  redacted and expire; instruments are last-4 only.
* Minimum retention: per-source retention policies; anchored observations
  survive only while a user assertion needs them.
* Minimum transmission: every package is pure TypeScript with no I/O, designed
  to run on-device; server components are optional.
* Control: per-connection consent receipts, pause/resume, revoke-and-purge.
* Transparency: `explainCandidate` produces "Detected from your HDFC Bank
  transaction notification." / "Matched your bank transaction with an Amazon
  receipt."

Server persistence (ADR-005) is limited to accounts, multi-device sync and
backup. A Supabase project stores only the source of truth defined by the
`BrakeStore` port: connections and consent receipts, observations, assertions
and preferences. It never stores raw payloads, OTPs, full card numbers or
candidates. Row-level security keyed on `auth.uid()` isolates every user's
rows. The database also re-checks the privacy rules (card-number guard,
revoke-and-purge, hourly retention), and devices rebuild candidates locally
by replaying observations and assertions. See
[supabase.md](supabase.md).

## Adding a new source

1. Write (or configure, via `createLedgerAdapter`) an adapter that maps the
   provider payload to observations, translating provider vocabularies into
   neutral hints.
2. Add a `SourceDefinition` (windows, strengths, required capabilities,
   privacy, maturity) and any new capability facts to the registry.
3. Nothing in `core` or `intelligence` changes.

## Decisions

* [ADR-001](adr/001-typescript-core-json-boundary.md) — TypeScript core, JSON envelope boundary to native capture.
* [ADR-002](adr/002-observations-as-source-of-truth.md) — Observations and assertions are the source of truth; candidates are derived.
* [ADR-003](adr/003-provider-vocabularies-stop-at-adapters.md) — Provider vocabularies stop at adapters.
* [ADR-004](adr/004-on-device-first.md) — On-device first; servers are optional relays.
* [ADR-005](adr/005-supabase-backend.md) — Supabase (Postgres + RLS + Auth) for accounts, sync and backup of the source of truth only.
