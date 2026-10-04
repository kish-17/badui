# Multi-signal fusion and reconciliation

BRAKE gets several observations of one financial event from independent
sources, at different times and in different shapes. This document specifies
how BRAKE decides which observations describe the same event (**fusion**, in
`@brake/core/fusion`) and how it relates different events to each other
(**reconciliation**, in `@brake/intelligence`).

The two are deliberately separate:

| Layer          | Question                                          | Output                               |
|----------------|---------------------------------------------------|--------------------------------------|
| Fusion         | Are these observations the *same* event?          | `TransactionCandidate` (one per event) |
| Reconciliation | How do these *different* events relate?           | links + type inferences (transfer pair, refund of, card payment for, reimbursement of, recurring series) |

## The running example

| Time  | Source               | Observation kind  | Stage     | Facts |
|-------|----------------------|-------------------|-----------|-------|
| 10:41 | Android notification | `money_movement`  | confirmed | ₹1,249 debit, "AMAZON", card ••1234 |
| 10:42 | Gmail                | `order`           | confirmed | Amazon order #402-…, total ₹1,249 |
| 10:43 | Bank API             | `money_movement`  | pending   | ₹1,249 "AMZN PAY INDIA", account ••7890 |
| 10:47 | Gmail                | `order`           | confirmed | Order #402-… contains "headphones" |

Result: **one** candidate in status `confirmed` (status is the furthest
lifecycle stage any observation evidences: the 10:41 alert confirms the debit
even though the 10:43 ledger entry is still pending; it becomes `posted` when
the ledger posts), amount ₹1,249 with
confidence near 1 (three independent sources agree), merchant display "Amazon",
line item "headphones", provenance "Matched your bank transaction with an Amazon
order confirmation."

## Observation classes

Not every observation is a transaction:

* **Transactional** — can found or join a candidate: `money_movement`,
  `purchase_intent`, `checkout`, `order`, `receipt`, `refund_notice`,
  `subscription_event` with `event = "charged"`, `invoice`/`booking` that
  evidence a payment (stage confirmed/posted).
* **Join-only** — `delivery` joins an order by `order_id` and never founds a
  candidate on its own.
* **Context** — stored, never fused into a candidate: `balance_snapshot`,
  `app_context`, `mandate`, non-charge `subscription_event`s (renewal upcoming,
  trial ending, price change, cancelled), unpaid invoices. They feed recurring
  detection, insights and interventions.

## Matching: blocking, scoring, deciding

### 1. Blocking (cheap candidate retrieval)

An incoming observation is compared only with candidates that share a strong
reference **or** satisfy all of:

* same direction (or one side unknown);
* same currency, or an `original_currency` component that bridges FX;
* amount within the pair's tolerance (below);
* time within the pair's window (below).

| Pair (incoming ↔ member)                                  | Max Δt                     | Amount tolerance |
|-----------------------------------------------------------|----------------------------|------------------|
| money movement ↔ money movement (both real-time alerts)   | 2 h                        | exact (≤ 1 minor unit) |
| money movement ↔ money movement (either is a ledger entry)| 5 days (posting lag)       | exact; pending→posted may grow ≤ 30 % with same provider/instrument (tips) |
| posted ↔ pending via `provider_pending_id`                | unlimited                  | any (fuel/hotel holds) |
| money movement ↔ order / receipt / invoice / booking / charged subscription | 7 days (merchants may charge at shipment) | exact or ≤ 1 % |
| checkout ↔ money movement                                 | 1 h                        | exact |
| purchase intent → anything (forward only)                 | `intentHorizonMs` (24 h)   | ± 15 % (intents are approximate) |
| refund notice ↔ credit money movement                     | 10 days                    | exact |
| delivery → order                                          | 60 days, `order_id` only   | n/a |

### 2. Vetoes (hard cannot-link)

A pair can never merge when:

* directions conflict (debit vs credit);
* both carry a reference of the same `type` and `namespace` with different
  values (two Plaid transaction ids, two UPI RRNs, two order ids);
* both are `money_movement` from the **same connection** and do not share a
  strong reference and are not a pending→posted pair — *a single source reports
  an event once*. This is what keeps two genuine ₹100 coffees apart;
* both carry instruments of the same type with different `last4`;
* the user asserted `different_events`;
* the candidate is dismissed.

### 3. Scoring (Fellegi–Sunter style)

Each compared field contributes a log-likelihood ratio
`llr = ln(P(agreement | same event) / P(agreement | different events))`:

| Feature                         | Typical llr | Notes |
|---------------------------------|-------------|-------|
| shared strong reference         | +9          | effectively decisive |
| amount exact                    | +4.5        | weaker for very common amounts (round numbers) |
| amount within tolerance         | +2          | |
| time proximity                  | +2 → 0      | decays across the pair window |
| merchant key equal              | +3          | |
| merchant similarity s           | +3·s − 1    | token overlap after descriptor cleaning |
| merchant clearly different      | −3          | |
| instrument last4 equal          | +2.5        | |
| same rail scheme                | +0.5        | |
| currency mismatch without FX    | −4          | |

`posterior = sigmoid(priorLogOdds + Σ llr)` with `priorLogOdds = ln(0.1/0.9)`.
The incoming observation is compared with every member of a candidate; the
candidate's score is the best member score, provided no member vetoes.

### 4. Deciding

* **link** when the best posterior ≥ `linkThreshold` (0.9) and the runner-up is
  more than `ambiguityMargin` (0.15) below it;
* **ambiguous** when two or more candidates are within the margin — the
  observation founds its own candidate and records `possible_duplicate` links
  to each. *Never merge when uncertain.* Spending totals exclude enrichment-only
  candidates that are likely duplicates (see `intelligence/spending`), so
  ambiguity never double counts;
* **possible duplicate** when the best posterior is between `possibleThreshold`
  (0.5) and the link threshold — new candidate plus a `possible_duplicate` link,
  which the question policy may turn into "Is this the same as …?";
* **created** otherwise.

User assertions are hard constraints: `same_event` forces a merge,
`different_events` forbids one.

## Field fusion (which source wins)

| Field | Rule |
|-------|------|
| amount | posted ledger > pending ledger > real-time alert (notification/SMS/wallet automation/issuer/card feed) > receipt/order/invoice total > checkout > intent; ties → higher observation confidence. A posted amount supersedes a pending one (provenance note "posted amount supersedes pending"). |
| merchant.raw | descriptor from the most authoritative money-movement source |
| merchant.displayName | human name from order/receipt/QR/checkout/email, else money-movement name, else cleaned raw |
| merchant.normalized | highest-confidence key; the intelligence layer may refine it |
| timestampEstimated | most precise occurredAt among money movements (exact alert time beats a date-only value date), else founding observation time |
| timestampConfirmed | occurredAt of the first confirmed/posted observation |
| status | max over intent < pending < confirmed < posted; `cancelled` if a reversal/cancellation is linked before posting; `refunded` is set by reconciliation |
| references | union, de-duplicated |
| line items | from receipts/orders (receipt preferred) |
| rail, instrument | merged field-by-field from payment-layer sources |
| confidence | `1 − Π(1 − cᵢ·wᵢ)` over independent observations (wᵢ by kind: ledger 1.0, alert 0.95, order/receipt 0.8, checkout 0.6, intent 0.4); `1` once user-verified |

Every fused field records `FieldProvenance` naming the observation(s) and the
rule used. "How did BRAKE know this?" is generated from that provenance.

## Lifecycle of a candidate that starts as intent

`purchase_intent` (share, QR, "Should I buy this?") founds a candidate in
status `intent` with `intentOutcome = "open"`. A matching payment within the
horizon advances it (`intent → confirmed/posted`, outcome `purchased`). With no
match before the horizon the outcome becomes `abandoned` — the basis for
"BRAKE helped you skip ₹X" and for measuring intervention value.

## Reversibility

Observations and user assertions are the source of truth; candidates are a
derived view. Disconnecting a source removes its observations and recomputes
every affected candidate deterministically. Labels survive because assertions
are anchored to observation ids, not to candidate ids.

## Reconciliation (different events)

Implemented in `@brake/intelligence/reconcile`. See the research document
`docs/research/10-reconciliation-transfers-recurring.md` for the evidence base.

* **Own-account transfer** — a debit and a credit of the same amount between two
  owned instruments within 3 days → both `transfer/own_account`, linked as
  `transfer_counterpart`. Not spending.
* **Credit-card payment** — a bank debit to a card issuer/bill-pay descriptor,
  optionally matched to a payment credit on an owned card account →
  `credit_card_payment`, linked `card_payment_for`. Card purchases count as
  spending once; the bill payment never does.
* **Wallet load** — debit to an own wallet (top-up descriptors) →
  `transfer/wallet_load`; spending is counted when the wallet pays a merchant.
* **Refund** — a credit from the merchant of an earlier purchase, amount ≤ the
  original, within 120 days → `refund`, linked `refund_of`/`refunded_by`;
  full refunds set the original's status to `refunded`.
* **Investment, loan payment, tax, income** — descriptor/mandate/recurrence
  heuristics and provider hints.
* **Reimbursement / shared expense** — incoming P2P credits after a purchase,
  summing to a share of it, from counterparties the user has labeled as
  friends/employer → `reimbursement` / `shared_expense` links.
* **P2P vs P2M** — merchant codes, verified merchant handles and counterparty
  heuristics decide whether a UPI/Pix/Venmo-style payment is a purchase or a
  transfer; when uncertain the type stays uncertain and the question policy may
  ask "Was this a purchase or a transfer?".

Every reconciliation output is an inference with a probability, never a hard
rewrite; user labels override it and teach it.
