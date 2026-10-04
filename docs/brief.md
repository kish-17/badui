# BRAKE — Founding Architectural Brief

> This is the founding product/architecture brief for BRAKE, preserved as written.
> It is the source of truth that `docs/architecture/requirements-traceability.md`
> traces against. Do not edit the substance; add clarifications elsewhere.

---

## Core architectural principle: BRAKE must be agnostic

Do not architect BRAKE around any single:

- country
- bank
- payment provider
- account aggregator
- card network
- wallet
- operating system
- transaction-data vendor
- notification format
- email provider
- payment rail

Plaid is a data source.
Account Aggregator is a data source.
Gmail is a data source.
SMS is a data source.
Android notifications are a data source.
UPI intents are a data source.
QR scans are a data source.
Receipts are a data source.

None of them ARE the product.

BRAKE should have a provider-agnostic financial event layer.

All external signals should eventually normalize into a common internal representation.

---

## Think in three time windows

Every possible signal should be classified as:

- **PRE-SPEND** — Signals that indicate a purchase may be about to happen.
- **IN-SPEND** — Signals available while the purchase decision/payment flow is occurring.
- **POST-SPEND** — Signals confirming or explaining what happened after payment.

Research all three independently.

A source does not need to work in all three phases to be valuable.

---

## Research every possible signal source

Do not constrain research to conventional bank APIs.

Investigate every technically and ethically reasonable input source.

Examples include, but are not limited to:

### Financial data

- open banking
- Plaid
- Account Aggregator
- bank APIs
- card transaction feeds
- card-linked services
- wallet history
- neobank APIs
- issuer APIs
- transaction webhooks
- pending transactions
- posted transactions
- balance information
- recurring payment information

### Device signals

- Android NotificationListenerService
- Android SMS where policy permits
- iOS permitted financial APIs
- FamilyControls / ManagedSettings
- app-open signals where permitted
- Live Activities
- widgets
- share sheets
- shortcuts / intents
- clipboard where platform policy permits and user action makes it appropriate
- accessibility-safe mechanisms
- OS automation capabilities

### Payment signals

- UPI intent URLs
- QR payment data
- merchant QR
- payment-app deep links
- Apple Pay related flows where accessible
- Google Pay related flows where accessible
- payment confirmation pages
- payment redirects
- browser checkout events where appropriate
- merchant integrations
- payment-provider partnerships

### Communication signals

- Gmail
- Outlook
- transactional emails
- bank email alerts
- purchase confirmation emails
- merchant receipts
- subscription emails
- renewal warnings
- cancellation notices
- refund messages
- order confirmation
- delivery confirmation
- invoices
- travel bookings

### Messaging signals

Where technically, legally and platform-policy appropriate:

- SMS banking alerts
- RCS
- messaging receipts
- transactional merchant messages

Do not access private communication channels without explicit informed consent.

### Manual / user-initiated signals

- manual transaction entry
- "Should I buy this?" input
- QR scan
- barcode scan
- receipt photo
- screenshot
- share product from another app
- paste product URL
- browser extension
- Safari extension
- Chrome extension
- photo of price tag
- voice input
- Siri / system intent
- search/share action

### Merchant-context signals

Potentially:

- merchant identity
- merchant category
- store type
- online vs physical
- recurring merchant
- known subscription
- historical behavior with that merchant

### Contextual signals

Only when useful, ethical and consented:

- time of day
- day of week
- payday proximity
- budget cycle
- upcoming known bills
- savings goals
- travel plans
- recurring obligations
- prior spending velocity
- previous regret patterns
- user-defined rules

Avoid invasive surveillance.

Do not collect context merely because it is technically available.

---

## Transaction candidate model

Do not immediately treat every incoming signal as a confirmed transaction.

Normalize observations into a `TransactionCandidate`.

Example conceptual model:

```
TransactionCandidate
  id
  amount
  currency
  merchant_raw
  merchant_normalized
  timestamp_estimated
  timestamp_confirmed
  country
  payment_rail
  source_signals[]
  category_candidate
  category_confidence
  essentiality_candidate
  essentiality_confidence
  transaction_type_candidate
  status
  confidence
  provenance
  deduplication_group
  user_verified
```

`transaction_type` may include: purchase, transfer, refund, subscription, cash withdrawal,
income, loan payment, credit-card payment, investment, reimbursement, shared expense,
business expense, fee, tax, unknown.

`status`: intent, pending, confirmed, posted, refunded, cancelled, unknown.

BRAKE should preserve provenance.

Never collapse uncertainty too early.

---

## Multi-signal fusion

One financial event may produce several observations.

Example:

| Time  | Source               | Observation                          |
|-------|----------------------|--------------------------------------|
| 10:41 | Android notification | ₹1,249 charged                       |
| 10:42 | Gmail                | Amazon order confirmation            |
| 10:43 | Bank API             | ₹1,249 pending transaction           |
| 10:47 | Merchant email       | Order #XYZ contains headphones       |

These should not become four transactions.

The system should reason that they probably describe ONE event.

Research robust transaction reconciliation.

Potential matching inputs:

- amount
- currency
- timestamp proximity
- merchant
- order number
- account
- payment instrument
- payment reference
- receipt metadata

Maintain confidence.

Do not aggressively merge events when uncertain.

---

## Gmail / email intelligence

Research email as an important financial context source.

BRAKE may optionally connect to:

- Gmail
- Outlook
- other providers later

Do not treat email as merely another transaction feed.

Email may supply richer semantic context than bank data.

Example:

Bank transaction: `₹4,799 AMAZON`

Email — Amazon order:

- electric toothbrush
- USB cable
- dog food

This may allow classification into different categories or explain why a transaction occurred.

Email-derived signals may identify: product/item, merchant, subscription, renewal, amount,
tax, shipping, order status, cancellation, refund, recurring billing, business expense,
travel, restaurant reservation, grocery delivery, ecommerce purchase.

Research privacy-preserving approaches.

Prefer requesting the narrowest possible permissions.

Where feasible:

- process relevant messages only
- filter transaction-related senders
- process locally
- avoid retaining full email bodies
- persist extracted structured facts instead of raw emails

---

## Post-transaction learning loop

After a likely transaction, BRAKE may ask the user for clarification.

Example:

> "₹1,249 at Amazon" — What was this?
> [Groceries] [Shopping] [Work] [Gift] [Other]

But do NOT ask users to classify every transaction indefinitely.

Classification requests should be uncertainty-driven.

Ask when:

- model confidence is low
- transaction materially affects budget interpretation
- essential vs discretionary status is uncertain
- merchant is ambiguous
- transaction appears unusual
- classification would improve future interventions
- transaction may be transfer/refund/reimbursement rather than spending

Do not ask when the answer is already highly predictable.

---

## One-tap labeling

Classification must be extremely low-friction.

Use notification quick actions where platform APIs allow them.

Possible actions: Groceries, Eating out, Shopping, Bills, Transport, Entertainment, Work,
Medical, Gift, Travel, Transfer, Subscription, Refund, Reimbursable, Shared expense, Other.

But do not show fifteen options simultaneously.

Use predicted top choices. For example:

> Amazon ₹1,249
> [Shopping] [Household] [Work] […]

Learn from every correction.

---

## Semantic attributes beyond category

Traditional finance apps over-focus on categories.

BRAKE should consider richer properties. A transaction can have attributes such as:

- **Essentiality**: essential, semi-discretionary, discretionary, unknown
- **Intent**: planned, unplanned, impulsive, recurring, emergency, unknown
- **Ownership**: personal, business, family, shared, reimbursable
- **Temporal type**: one-off, recurring, subscription
- **Satisfaction**: worth it, neutral, regretted
- **Purchase context**: planned in advance, saw and bought, recommended purchase,
  replacement, upgrade, social spending, convenience purchase

Do not require users to label all of these.

Infer where possible.

Ask selectively.

---

## Regret / satisfaction learning

Research whether lightweight retrospective feedback improves personalization.

Example, perhaps 24–72 hours later:

> "That ₹6,200 purchase from Saturday — still happy you bought it?"
> [Yes] [Neutral] [Regret it]

Use sparingly.

The objective is not guilt.

The purpose is learning: which purchases does THIS user later regret?

BRAKE may discover:

- late-night ecommerce is frequently regretted
- restaurant spending is rarely regretted
- electronics under ₹2,000 are often regretted
- expensive planned purchases are usually valued

Then future interventions become personalized.

Do not create an obsessive regret-tracking loop.

---

## Transfer vs spending problem

Research this deeply.

A ₹50,000 bank movement may be: rent, investment, transfer to own account, credit card
payment, family transfer, loan payment, actual discretionary purchase.

BRAKE should not treat all debit transactions as spending.

Build reconciliation logic for:

- internal transfers
- card payments
- refunds
- investments
- reimbursements
- shared expenses
- wallet loading

Incorrectly calling transfers "spending" destroys trust.

---

## Recurring & subscription intelligence

Use signals from: transaction history, email, merchant data, calendar-like recurrence,
app-store receipts.

Detect:

- subscriptions
- free-trial conversions
- upcoming renewals
- price increases
- duplicate subscriptions
- dormant subscriptions

Potential future intervention:

> "Netflix renews tomorrow for $22.99. You haven't marked it as essential. Keep or review?"

Research whether this belongs inside the initial product or later.

---

## Pre-spend surfaces

Investigate mechanisms for capturing purchase intent before payment.

Possibilities may include: BRAKE QR scanner, share product to BRAKE, browser extension,
ecommerce extension, "Ask BRAKE" system share action, screenshot detection initiated by
user, Siri / voice action, price-entry widget, selected app shielding, shopping app launch
friction, merchant partnership, payment provider integration.

Evaluate each by: coverage, latency, user friction, privacy, OS policy, reliability,
behavioral value.

---

## Post-spend surfaces

Post-payment information is still valuable.

BRAKE can respond immediately after spending with: financial state update, classification
request, discretionary impact, remaining budget, anomaly notice, subscription
identification, refund tracking, contextual learning.

Do NOT scold users after purchase.

Avoid useless messaging such as: "You spent ₹500."

Prefer information that changes understanding. Example:

> "₹500 at Swiggy — Food spending this week is now 38% above your usual pace."

Or say nothing if there is no meaningful insight.

---

## Source adapter architecture

Implement external systems using adapters. Conceptually:

```
SignalSource
  → GmailAdapter
  → OutlookAdapter
  → AndroidNotificationAdapter
  → SMSAdapter
  → PlaidAdapter
  → AccountAggregatorAdapter
  → UPIIntentAdapter
  → QRAdapter
  → ReceiptAdapter
  → ManualAdapter
  → BrowserExtensionAdapter
  → FutureBankAdapter
```

Each emits normalized observations.

The product intelligence layer should not care which provider produced them.

---

## Country capability registry

Maintain a machine-readable capability registry. For example:

- **India** — UPI QR: available. Account Aggregator: available. Plaid: generally no.
  SMS banking alerts: common.
- **USA** — UPI: not available. Plaid/open banking: available. Card transactions: dominant.

Build features against capabilities, not hard-coded country branches wherever practical.

---

## Capability-based product design

A user's BRAKE experience should depend on available capabilities.

- **User A**: Android + India + Gmail + bank notifications + AA — strong near-real-time
  transaction awareness.
- **User B**: iPhone + USA + Plaid + Gmail — strong financial context but weaker immediate
  transaction sensing.
- **User C**: No connected financial account — BRAKE should still offer manual purchase
  check, QR scanning where relevant, goal tracking, browser/share interventions.

Design graceful degradation.

BRAKE must remain useful even when some sensors are unavailable.

---

## Confidence-aware UX

Never pretend BRAKE knows more than it knows.

- High confidence: "₹850 at Starbucks"
- Medium confidence: "Looks like you spent about ₹850 at Starbucks."
- Low confidence: "Was this ₹850 transaction at Starbucks?"

Uncertainty should influence whether BRAKE intervenes.

A low-confidence inference should rarely trigger strong friction.

---

## Privacy principle

BRAKE will potentially observe extremely sensitive information. Therefore:

- Collect the minimum.
- Store the minimum.
- Retain the minimum.
- Transmit the minimum.
- Prefer local processing where practical.
- Give users control over each signal source.
- Allow users to disconnect individual sources.
- Make provenance inspectable: "How did BRAKE know this?" Possible answers:
  "Detected from your HDFC transaction notification." or
  "Matched your bank transaction with an Amazon receipt."

Transparency is a product feature.

---

## The north-star architectural question

Do not ask: "How do we get every transaction?"

Ask: **"What combination of independent signals gives BRAKE enough context to improve a
user's spending decisions?"**

BRAKE should become stronger as users connect more sources, while remaining useful with
fewer sources.

Think probabilistically. Think modularly. Think internationally. Think across operating
systems. Think across payment rails. Think before, during and after payment.

Do not allow today's API limitations to dictate the long-term product architecture.
