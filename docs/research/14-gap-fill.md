# 14 — Completeness audit and gap fill: what the first thirteen streams missed

> **Stream:** 14, completeness critic and gap fill.
> **Date / status "as of":** 2026-10-04. Every time-sensitive claim is as of this date unless it says otherwise.
> **Scope.** (1) Check every signal and cross-cutting topic in `docs/brief.md` against research streams 01–13 and decide whether each is covered *substantively* (its own source section with what / data / windows / access / recommendation, or a dedicated design table), *partially* (a passing mention, a row inside another source's section, or flagged "missed" / "unverified"), or not at all. (2) Check whether IN-SPEND was researched in real depth for each platform and market. (3) Research the substantive gaps with primary sources and write them up in the same per-source structure as the other streams. The **Coverage audit** at the end maps every brief item to the documents and sections that cover it.
> **Out of scope.** Re-verifying claims already made in streams 01–13. Where this stream found something that bears on an earlier stream, it says so in a note; it does not edit those documents.
>
> **How this was researched, and its limits.** Coverage was judged by grepping all thirteen documents and `_raw-structured-findings.json` for each topic, then reading the matching sections (see "Method"). New facts were researched on 2026-10-04. The egress proxy allowed only `developer.apple.com`, `developer.android.com`, `raw.githubusercontent.com` and Google API discovery documents (`*.googleapis.com/$discovery`). Every other primary host tried was blocked: `support.google.com`, `support.apple.com`, `www.samsung.com`, `www.fca.org.uk`, `eur-lex.europa.eu`, `www.ecb.europa.eu`, `www.rbi.org.in`, `www.npci.org.in`, `usa.visa.com`, `developer.mastercard.com`, `docs.cdp.coinbase.com`, `tfl.gov.uk`, `www.omg.org`, `asic.gov.au` and others. For those, the claim is taken from the search engine's rendering of the primary page and is marked **[Ps]**. That is weaker than a fetch, because the snippet is a summary. Treat [Ps] claims as "very likely, re-read the page before relying on the exact wording".
>
> **Evidence legend.** **[P]** primary source fetched and read in this session. **[Ps]** primary page (regulator, standard body, vendor documentation or vendor press release), seen only through the search-engine result because the host was blocked. **[S]** secondary source (news, law firm, blog, vendor marketing about a third party). **(unverified)** no source in this session supports the claim; it is a hypothesis.

---

## Key takeaways for BRAKE

1. **The corpus is strong on the brief's named sources and weak on the edges of real-world spending.** Of the 211 brief and mechanism items in the Coverage audit, 159 are covered substantively by streams 01–13, 22 only partially, and 30 needed new research here. The biggest real gaps were not exotic APIs. They were common payment situations that break BRAKE's assumptions: stored-value pockets (transit, tolls, gift cards, cash), holds and tips, buy-now-pay-later plans, joint accounts, employer cards, points, and payment-authentication prompts. (Counts are by row in the Coverage audit table, excluding the 15-row IN-SPEND matrix.)
2. **The payment-authentication step is an IN-SPEND signal the corpus missed.** EU and UK strong customer authentication requires that "the payer shall be made aware of the amount of the payment transaction and of the payee" during authentication (Delegated Regulation (EU) 2018/389, Art. 5(1)(a)) [Ps]. 3-D Secure out-of-band approvals, BLIK confirmations and Swish payment requests therefore put **amount and payee in a bank or wallet app push before the payment completes** [Ps]. On Android, BRAKE's notification listener can read these: Android 15 redacts content only "from notifications where an OTP has been detected" for untrusted listeners [P]. This is the only broad, non-UPI IN-SPEND signal for card e-commerce on Android in Europe. Recommendation **`next`**, as template packs inside `android-notification-listener`, under strict rules: read only, never touch the notification's actions, never delay authentication (§G1).
3. **Agentic commerce now has concrete, open protocols, and they contain the best pre-commitment device the payments industry has ever offered.** AP2 v0.2 "open mandates" carry user-approved constraints: Budget, Amount Range, Allowed Payee, Allowed Payment Instrument, Execution Date, Agent Recurrence, Allowed Merchants and Line Items [P]. ACP's delegated payment token is usable "**only** within the provided **Allowance** (reason, max_amount, currency, expiry)" [P]. Google announced the Universal Commerce Protocol on 11 Jan 2026 [Ps]; Mastercard launched Agent Pay on 29 Apr 2025 [Ps]; Visa launched the Trusted Agent Protocol on 14 Oct 2025 [Ps]. BRAKE should add an `initiator: agent` field and a `mandate` observation with constraints to its schema now (cheap), and track whether wallets or credential providers will let a consumer app act as the user's policy check (`research`) (§G2).
4. **Android wallet notifications are confirmed.** Google Wallet sends a purchase notification after a contactless payment with the merchant, the amount and the card used, silent by default [Ps]. Samsung Wallet sends "a push notification with details of your transaction after each purchase" [Ps]. This settles the "unverified" flag in streams 02 (§B1) and 03 (§1): add both as templates in the notification-listener pack (POST-SPEND, seconds) (§G3).
5. **Watches and rings add instruments, not signals.** An Apple Watch Apple Pay payment produces a notification "in Notification Center when the transaction is confirmed" [Ps]. Since July 2026 the phone's Google Wallet app shows Wear OS payments, marked "Purchase made on watch" [S]. Whether the iPhone's Shortcuts Wallet "Transaction" trigger fires for Watch taps is still **unresolved** (secondary sources disagree; stream 04 §1). Tokenized device payments may show a device account number rather than the plastic card's last 4 (unverified this session), so instrument matching needs aliases (§G4).
6. **Stored-value pockets break "one payment = one purchase".** TfL turns a day of taps into one charge after the travel day closes, and it can take 1–3 days to post [S]. NCMC cards spend from an offline wallet of up to ₹2,000 without a PIN or bank round-trip [Ps]. FASTag sends a per-toll SMS, and since 15 Aug 2025 a ₹3,000 annual pass covers a year or 200 trips [Ps]. Gift cards, store credit, UPI Lite (stream 05) and cash behave the same way. BRAKE needs one **stored-value pocket** concept: a load is a transfer, a spend from the pocket is a purchase if observed, and unexplained pocket balance is shown as "unitemized", never double-counted (§G5, §G6, §G8, §G12).
7. **Holds and tips need data, not new sources.** US automated fuel dispenser status-check holds were raised to $175 [S]. Mastercard recommends US and Canadian issuers release AFD holds within 60 minutes of the completion advice [Ps]. AFIR requires card readers or contactless devices on new public chargers of 50 kW or more from 13 Apr 2024, and on existing ones by 1 Jan 2027 [Ps]. Restaurant tip tolerance is reported as 20%, raised to 30% for US restaurants from 21 Feb 2026 [S, unverified]. Stream 10 already says holds are not spending. This stream adds the hold MCCs and tolerances for the registry (§G7).
8. **BNPL moved from checkout buttons into cards and wallets, and its regulation changed in 2025–26.** Visa Flexible Credential lets one card switch between debit, credit, instalments and points [Ps]. The Klarna Card runs on it [Ps], and Klarna launched in-store tap to pay across 14 markets in Dec 2025 [Ps]. UK Deferred Payment Credit has been regulated since 15 Jul 2026 [Ps]. Australian BNPL providers have needed a credit licence since 10 Jun 2025 [Ps]. New York enacted a BNPL licensing act in May 2025 and DFS proposed rules on 23 Feb 2026 [S]. In India, the RBI ordered Simpl to stop payment operations on 25 Sep 2025 [S]. No consumer-consented BNPL data API was found. BRAKE's signals are the instalment schedule (email, app push) and the instalment debits, modelled as `purchase_group` / `instalment_of` (§G9).
9. **Households need explicit modelling.** UK Open Banking exposes `PartyType` ∈ {Delegate, Joint, Sole} [P]. The India AA deposit schema has `Holders/@type` ∈ {SINGLE, JOINT} [Ps]. Plaid makes "a best effort to report the names of all account holders" of a joint account [P]. The co-holder's transactions are a third party's personal data, and two BRAKE users who both connect one joint account will each see the other's spending. BRAKE is 18+ (stream 11, PR-13), so children's wallets (Apple Cash Family, Google Wallet for kids) are out of scope except as the parent's own outflow (§G14).
10. **Employer cards, crypto cards, carrier billing and points create spending that is either not the user's money, not in the bank feed, or a disguised asset sale.** Brex OAuth is for registered partners only [Ps]. Spending crypto (other than USD or USDC) through the Coinbase Card is a sale and a taxable event in the US [Ps]. Google Play carrier billing puts purchases on the phone bill [S]. Chase Pay Yourself Back credits arrive as statement credits within about three business days [Ps]. These need **ownership, funding-source and tender-split attributes**, not new adapters (§G10, §G11, §G13, §G19).
11. **EU law already sends a post-spend FX alert.** Regulation (EU) 2019/518 requires DCC providers to show their mark-up over the ECB reference rate *before* the payment, and card issuers to send an electronic message (SMS, email or app push) "without undue delay" after a card payment or ATM withdrawal in another Union currency [Ps]. That message carries the original and converted amounts, which is an exact cross-currency fusion key (§G15).
12. **Two new output surfaces and one new receipt standard.** Apple Wallet passes can be updated by push and show a change message, with up to 10 relevant locations [P]. Google Wallet passes notify only for allowlisted field updates or `TEXT_AND_NOTIFY` messages, and the API has a `GENERIC_RECEIPT` pass type [P]. Neither lets BRAKE read other passes [P]. OMG's Digital Receipt API 1.0 (April 2025) gives a JSON line-item model for receipts [Ps]. France stopped systematic receipt printing on 1 Aug 2023 [Ps]. Pass surfaces are `later`; aligning BRAKE's line-item schema with the receipt standard is `next` (§G17, §G18).
13. **IN-SPEND depth is uneven by design, not by neglect.** The corpus covers IN-SPEND deeply for UPI and QR markets, browser checkouts, iOS Apple Pay taps and issuer-side authorization. The remaining holes are structural: physical card taps on Android, in-app checkouts on both platforms, and card OTP flows in India (deliberately avoided). Only partnerships (issuer, wallet, agent platform) can close them. See the IN-SPEND depth audit.

---

## Method: how coverage was judged

1. Every item in `docs/brief.md` was listed (the 10 signal families, the 3 time windows, and the 18 cross-cutting sections), plus the mechanisms the task named and others found while reading.
2. For each item, all thirteen documents were grepped (case-insensitive) for the item and its synonyms. Hits were then read in context to separate a dedicated section from a passing mention.
3. `_compact-findings.json` (372 source entries) was used to list which sources each stream classified as IN-SPEND, by platform and country. `_raw-structured-findings.json` was grepped for entries marked "missed by the doc" (`verified_correction: true`), which flagged `bnpl-provider-history`, `mastercard-agent-pay` and `google-wallet` as known holes.

Keyword hits across streams 01–13 (case-insensitive line counts; a hit is not coverage, but zero hits is a reliable gap signal):

| Topic searched | Lines matched | Documents (lines) | Reading of the hits |
|---|---|---|---|
| Samsung Wallet / Samsung Pay | 0 | — | Gap |
| Garmin / Fitbit | 0 | — | Gap |
| Apple Watch | 5 | 04 (5) | Partial: one unresolved question about the Wallet trigger |
| Wear OS | 6 | 03 (6) | Partial: notification bridging only |
| FASTag / NCMC | 11 each | 05, 06, 07 | Partial: only the pre-debit-notice exemption |
| OMNY / fare capping / Express Mode | 0 | — | Gap |
| EV charging / AFIR | 2 | 13 (2) | Gap (a POI category only) |
| fuel / MCC 5542 | 12 | 01, 02, 05, 10, 12 | Partial: "holds are not spending" rule, no amounts |
| tip tolerance | 2 | 10 (2) | Partial: tolerance marked unverified |
| ATM | 30 | 8 documents | Partial: ATM as a transfer type; cash spending itself not studied |
| BNPL | 47 | 01, 06, 08, 09, 10, 11, 12 | Partial: behavioural signal (09 §17); providers, regulation and card-based BNPL not researched |
| Simpl / LazyPay | 0 | — | Gap |
| crypto | 2 | 02, 12 | Gap |
| corporate / expense card, Brex, Ramp | 0 | — | Gap |
| gift card / store credit | 4 / 0 | 06, 09 | Gap |
| loyalty / reward points | 13 | 8 documents | Partial: field names only (AA `loyaltyPoints`, EMV tag 62-04) |
| joint (account) | 0 | — | Gap |
| Apple Card Family / Family Link | 4 | 02, 04, 13 | Partial: FinanceKit exclusions only |
| DCC / dynamic currency | 0 | — | Gap |
| VRP / PISP | 13 / 6 | 01 | Partial: spec only, "a write capability, not a signal" |
| Request-to-Pay | 0 | — | Gap |
| PassKit / Wallet passes / Google Wallet objects | 1 | 04 | Gap |
| e-receipt / digital receipt | 9 | 02, 06, 08, 12 | Partial: no standards |
| 3-D Secure / dynamic linking | 1 | 05 | Gap |
| carrier billing | 0 | — | Gap |
| AP2 / ACP / Agent Pay | 1 | 02 | Partial: Visa VIC/TAP only (02 §C4) |
| marketplace / intermediary | 30+ | 10, 13 | **Substantive** (13 §B2, §B19; 10 §C1) — no gap |

---

## Gap summary

| # | Gap | Prior coverage | This stream | Recommendation (headline) |
|---|---|---|---|---|
| G1 | Payment-authentication prompts (SCA, 3-D Secure OOB, BLIK, Swish) as IN-SPEND | none | researched | `next` (Android templates) |
| G2 | Agentic-commerce mandates (AP2, ACP, UCP, Agent Pay, TAP) | partial (02 §C4) | researched | schema `mvp`; integration `research` |
| G3 | Google Wallet and Samsung Wallet post-tap notifications | flagged unverified (02 §B1, 03 §1) | verified [Ps] | `next` (templates) |
| G4 | Wearables, payment rings, Fitbit retirement | partial (03 §20, 04 §1) | researched | instrument aliasing `mvp`; no adapter |
| G5 | Transit: open-loop aggregation and capping, stored value, Express Mode, NCMC | none | researched | semantics `mvp` |
| G6 | Tolls: FASTag / NETC | partial (05, 07: PDN exemption only) | researched | `next` (India SMS templates) |
| G7 | Fuel, EV charging, hotel and car-rental holds; tips and gratuity | partial (10 §E2) | researched | rules data `mvp` |
| G8 | Cash and ATM | partial (10 §E7) | researched | cash pocket `mvp` |
| G9 | BNPL checkouts, schedules, card-based instalments, regulation | partial (09 §17; raw findings "missed") | researched | `next` |
| G10 | Crypto cards | none | researched | `later` |
| G11 | Employer, corporate and expense cards | none | researched | labels `mvp`; APIs `avoid` |
| G12 | Gift cards, store credit, prepaid | partial | researched | semantics `mvp`; templates `next` |
| G13 | Loyalty points and pay-with-points | partial (field names) | researched | tender split `mvp` |
| G14 | Joint accounts, family and household | none | researched | holding field `mvp`; household mode `next` |
| G15 | Multi-currency, travel and DCC; EU FX messages | partial (10 FX bands, 13 §C7) | researched | `next` |
| G16 | Open-banking payment initiation, VRP / sweeping, SEPA Request-to-Pay | partial (01 §7) | researched | `later` (actions); `next` (recognition) |
| G17 | Apple and Google Wallet passes as a BRAKE surface | none | researched [P] | `later` |
| G18 | E-receipt standards and digital-receipt regimes | partial (08 §15 fiscal QR) | researched | schema alignment `next` |
| G19 | Direct carrier billing | none | researched | `next` |
| G20 | Issuer subscription controls (Visa mandate) | none | researched | `next` |
| G21 | Android NFC wallet role and Observe Mode | none | researched [P] | `research` (partner-only) |
| G22 | Evidence for the *intent* and *purchase-context* attributes | partial (09 §14) | synthesis | `mvp` mapping |
| G23 | "Anomaly notice" post-spend surface | partial (09 §4.2) | synthesis | `next` |

---

## Sources investigated

Each subsection uses the template of streams 02 and 03: **What it is · Data available · Windows & latency · Coverage · Access & policy · Privacy · Reliability & failure modes · Dedup keys · Normalized observation · Provenance sentence · Recommendation · References.** Numbers in square brackets point to the References list. Evidence tags ([P], [Ps], [S]) are defined at the top.

### G1. Payment-authentication prompts as an IN-SPEND signal (`sca-authentication-prompt`)

- **What it is.** Many payments pause for the payer to approve them in a *second* app, after the checkout click and before the money moves:
  - **3-D Secure 2 out-of-band (OOB) authentication.** The card issuer sends a push to its banking app; "by tapping on the push notification, the cardholder is redirected to the Issuer app presenting the authentication screen", reviews the transaction details, and confirms or declines [13].
  - **PSD2 / UK strong customer authentication with dynamic linking.** Where SCA applies to a remote payment, "the payer shall be made aware of the amount of the payment transaction and of the payee", and the authentication code is specific to that amount and payee (Delegated Regulation (EU) 2018/389, Art. 5(1)) [12]. Any compliant approval screen therefore shows amount and payee. Whether the *push notification* (as opposed to the in-app screen) also shows them depends on the issuer (unverified per issuer).
  - **BLIK (Poland).** The user enters a 6-digit code at the till or website, then "must confirm the transaction in their banking app where a detailed transaction summary appears … including the amount and recipient details" [15].
  - **Swish e-commerce (Sweden).** The merchant registers a payment request; "a push notification is sent to their Swish app", and the user approves and signs with Mobile BankID [16].
  - Not in scope: India's card OTP SMS and payment OTP emails. Streams 06 and 07 classify them `avoid`, and Android 15+ redacts OTP-bearing notifications for untrusted listeners [14].
- **Data available.** Amount, currency, payee or merchant name (dynamic linking), sometimes the card's last 4, the issuer app's package name and the time. The outcome (approved or declined) is visible only if the app posts a follow-up notification, or when the card alert or ledger record arrives.
- **Windows & latency.** **IN-SPEND.** The push arrives seconds after the checkout click, while the user is mid-decision. BLIK codes are typically valid for about two minutes [15]. It also marks the `intent → pending` transition for a candidate that a browser extension may already have opened at the cart (stream 05 §17).
- **Coverage.** EEA and UK remote card payments (SCA is the default for customer-initiated online payments), BLIK in Poland, Swish in Sweden, and issuers worldwide that use app-based 3-D Secure. In the US, 3-D Secure challenges are less frequent (unverified; no frequency data found). **Android only:** iOS gives third-party apps no way to read another app's notifications (stream 04).
- **Access & policy.**
  - Uses BRAKE's existing `NotificationListenerService` (stream 03 §1), with per-issuer template packs. No new permission.
  - Android 15: "Android will stop untrusted apps that implement a NotificationListenerService from reading unredacted content from notifications where an OTP has been detected" [14]. An approval push that carries no OTP is outside that rule (inference from the wording; OEM behaviour unverified).
  - **Hard rule:** BRAKE must never invoke the notification's actions or `PendingIntent`s (approve / decline). Android exposes them to listeners (stream 03), and acting on them would be authentication fraud. BRAKE also must never delay or obscure the approval screen: SCA flows have short timeouts, and a failed approval is a failed or duplicated payment (stream 05 risk 2).
  - Google Play's notification-listener policy and the interception-law analysis in stream 11 §A12 apply unchanged.
- **Privacy.** Sensitive, but no more than the transaction alert that follows. Parse in memory; keep amount, currency, payee and time; drop the text; never store codes.
- **Reliability & failure modes.** Formats differ per issuer, and some pushes say only "Approve your payment" without an amount (then the signal is weaker: "a payment is being approved at 14:02"). Abandoned or declined approvals must expire the candidate, not leave a phantom purchase. Duplicate prompts appear when the user retries.
- **Dedup keys.** amount + currency + payee + time (±10 min); joins the browser `checkout` observation (before) and the card alert or ledger record (after). 3-D Secure exposes no consumer-visible transaction ID.
- **Normalized observation.** `kind: checkout`, `stage: authenticating` (new stage value; see Implications), `window: in_spend`, `confidence` medium (it may not complete).
- **Provenance sentence.** "Seen when your bank asked you to approve €42.10 to ASOS."
- **Behavioural use.** The approval is an *existing* pause that the user already accepts. BRAKE may post at most a quiet, informational notification, and only when a user-set rule fires ("you asked me to flag clothing over €40 this month"). Stream 09's intervention ladder applies: confidence-bounded, never blocking, always skippable.
- **Recommendation: `next`** for Android in the EEA, UK, Poland and Sweden, as template packs inside `android-notification-listener`. **`avoid`** for any OTP-bearing message.
- **References.** [12], [13], [14], [15], [16].

### G2. Agentic-commerce mandates (`agentic-commerce-mandates`)

- **What it is.** Open protocols that let AI agents shop and pay for a user under limits the user approved:
  - **AP2, the Agent Payments Protocol** (Google-led, Apache-2.0, specification v0.2) [7]. Roles: Shopping Agent, Credential Provider, Merchant, Merchant Payment Processor and others. A *Checkout Mandate* secures what is bought; a linked *Payment Mandate* secures the payment; both come with signed receipts. Two modes: **Human Present** ("The User directly sees the closed Checkout"), and **Human Not Present**, where "The User sees and approves a set of constraints over what closed Checkout and Payment would meet their intent" [7]. Defined open-mandate constraints: *Agent Recurrence*, *Allowed Payee*, *Allowed Payment Instrument*, *Allowed PISP*, *Amount Range*, *Budget* ("a total amount limit"), *Reference* and *Execution Date* on the payment side; *Allowed Merchants* and *Line Items* on the checkout side [7]. New constraint types can be defined with "a uniquely defined `type`", a schema and an evaluation algorithm [7].
  - **ACP, the Agentic Commerce Protocol** (maintained by OpenAI and Stripe, status beta; spec versions dated 2025-09-29 to 2026-04-17) [8]. Checkout sessions move through `not_ready_for_payment | ready_for_payment | completed | canceled | in_progress`, with `authentication_required` for 3-D Secure; order lifecycle events `order_create` / `order_update` go to the application's webhook [8]. The delegated payment token "**MUST ONLY** be usable within the provided **Allowance** (reason, max_amount, currency, expiry)" and becomes invalid at `allowance.expires_at` [8].
  - **UCP, the Universal Commerce Protocol** (Google with Shopify and retailers), announced at NRF on 11 Jan 2026 and described as compatible with AP2, A2A and MCP; checkout in AI Mode and the Gemini app for eligible US retailers [19].
  - **Network programmes.** Visa Intelligent Commerce and the Trusted Agent Protocol (announced 14 Oct 2025 with Cloudflare and merchant and processor partners) [18], already in stream 02 §C4. **Mastercard Agent Pay** (unveiled 29 Apr 2025) binds a tokenized credential to an agent [17]; secondary sources report that all US Mastercard cardholders were enabled by Nov 2025 [17, S].
- **Data available.** The user's purchase intent in structured form (items, maximum amount, budget, allowed merchants, expiry, recurrence); agent identity; signed checkout and payment receipts with line items; order status events.
- **Windows & latency.** **PRE-SPEND:** approving an open mandate is an explicit, planned purchase decision with a budget, made in advance. **IN-SPEND:** in Human Present flows the user signs the closed mandate on a trusted surface. **POST-SPEND:** receipts and order webhooks, with item detail.
- **Coverage.** Global specifications; deployments are US-first (UCP checkout) and volumes are small (unverified; no usage data found).
- **Access & policy.** BRAKE is not a party to these flows by default. Four realistic routes, in order of feasibility: (a) the agent platform emails the user a receipt, which stream 06's adapters already parse; (b) BRAKE exposes an MCP tool or App Intent that the user's own agent consults ("is this within my plan?"); (c) a credential provider or wallet calls BRAKE as a policy check before issuing a scoped credential; (d) BRAKE defines an AP2 constraint type such as "discretionary budget remaining". Routes (c) and (d) need partners.
- **Privacy.** Mandates contain item-level shopping intent. The agent platform is a separate controller. Keep any BRAKE policy evaluation on the device and return only allow / warn.
- **Reliability & failure modes.** Draft and beta specifications with rapid change (ACP published five spec versions in seven months [8]). Agent purchases may also appear as ordinary card transactions with no agent marker.
- **Dedup keys.** ACP `order.id` and `checkout_session_id`; AP2 mandate and receipt identifiers; network token or Payment Account Reference (stream 02 §C4).
- **Normalized observation.** New `kind: mandate` with `constraints {max_amount, budget, merchants[], expires_at, recurrence}`; a new `initiator: user | agent | merchant | delegate` field on all observations (UPI Circle delegates in stream 05 §8 are the same concept).
- **Provenance sentence.** "From the purchase limit you approved for your shopping assistant (up to $150, until Friday)."
- **Recommendation.** Schema fields (`mandate`, `initiator`): **`mvp`** (cheap now, expensive to retrofit). Integration: **`research`**. Re-check in 2027 whether any wallet or credential provider lets a consumer app act as a policy check.
- **References.** [7], [8], [17], [18], [19]; stream 02 §C4.

### G3. Google Wallet and Samsung Wallet post-tap notifications (`android-wallet-tap-notifications`)

- **What it is.** After an NFC payment, the Android wallet posts its own notification, independent of the bank's alert.
  - **Google Wallet:** "you get a purchase notification that you have a new transaction"; it includes "the store/merchant name, how much you spent, and what card was used"; "This notification is silent by default"; users manage it under "Manage Wallet notifications" [20]. Since 2023–24 the notifications come from the Google Wallet app itself rather than Google Play services [S, 9to5Google, cited in 20].
  - **Samsung Wallet:** "You'll also receive a push notification with details of your transaction after each purchase. Notifications require an active internet connection"; recent transactions are viewable "until one month after purchase"; "Some card issuers may not allow transactional information or may limit the number of transactions displayed" [21].
- **Data available.** Merchant name (as the network or issuer supplies it), amount, card nickname or last 4 (format unverified), time.
- **Windows & latency.** **POST-SPEND**, seconds to minutes (secondary reports say Google's arrives "a few minutes later" for watch taps [23]). No IN-SPEND hook (see G21).
- **Coverage.** Android phones and Wear OS watches paired to them, in every Google Wallet or Samsung Wallet market where the issuer shares transaction data.
- **Access & policy.** Existing notification listener; template per wallet package. Silent notifications are still delivered to listeners (silence affects alerting, not posting; inference from Android's notification model).
- **Privacy.** Same as bank notifications (stream 11 §B1).
- **Reliability & failure modes.** Issuer-dependent: no notification when the issuer does not share data [21]. Duplicates the bank's own alert, which is a fusion problem, not a counting problem. The card label may be a user nickname.
- **Dedup keys.** amount + merchant + time (±2 min) against the bank alert; the instrument as a wallet token alias (see G4).
- **Normalized observation.** `kind: money_movement`, `stage: confirmed`, `rail: card`, `channel: contactless_wallet`.
- **Provenance sentence.** "Detected from your Google Wallet purchase notification."
- **Recommendation: `next`.** Add `com.google.android.apps.walletnfcrel` and Samsung Wallet templates to the stream 03 template pack (package names to be confirmed on devices). This **closes** the "unverified" notes in stream 02 §B1 and stream 03 §1.
- **References.** [20], [21], [23].

### G4. Wearables, payment rings and other form factors (`wearable-payments`)

- **What it is.** Payments made from a watch, ring or fitness band with a tokenized card.
  - **Apple Watch.** Apple says that after an Apple Pay purchase on the watch "you receive a notification in Notification Center when the transaction is confirmed", and the watch's Wallet app lists recent transactions [22]. Apple's Shortcuts guide describes the Wallet "Transaction" trigger for iPhone and iPad [26]. One secondary source says watch purchases also trigger it [26, S]; stream 04 §1 cites an unanswered developer-forum question saying the automation could not be made to work on the watch. **Unresolved.** An Apple developer-forum thread also reports that the trigger "frequently times out" [26].
  - **Wear OS.** Since July 2026 the phone's Google Wallet app lists payments made on a Wear OS watch, marked "Purchase made on watch" [23, S]. Notification bridging is covered in stream 03 §20.
  - **Fitbit.** Google replaced Fitbit Pay with Google Wallet on Fitbit devices from 26 Mar 2024; Fitbit Pay was discontinued on 29 Jul 2024, and legacy tokens with issuers in Japan, Saudi Arabia and Taiwan were deleted on 13 Jan 2025 [24].
  - **Garmin Pay.** Reported in 66 countries with hundreds of banks; UK support is narrow [25, S]. Whether Garmin Connect posts a phone-side notification is unverified.
  - **Payment rings and other passive wearables** (for example McLear RingPay or CNICK). Usually tokenized through Curve or a similar intermediary [S]. The phone-side signal is the intermediary's or the issuer's notification, and the merchant descriptor may carry the intermediary prefix, which stream 13 §B19 already splits off.
- **Data available.** The same as the phone wallet's, delivered through whichever app owns the token.
- **Windows & latency.** POST-SPEND only. No consumer-app IN-SPEND hook exists on any wearable.
- **Coverage.** Global, by wallet and issuer.
- **Access & policy.** No new access. The relevant gap is *data modelling*: a tokenized wallet payment may carry a device-account-number last 4 that differs from the plastic card's last 4 printed in bank SMS (Apple describes a separate Device Account Number in its platform security guide; not re-read this session, so **unverified**). Instrument matching on last 4 alone then fails.
- **Privacy.** No change.
- **Reliability & failure modes.** Watch taps may be "missing" from the iPhone Wallet trigger. Stream 04's trigger-health heuristic must not count them as automation failures. Rings via Curve add an intermediary leg (card → Curve → merchant) that must not be counted twice.
- **Dedup keys.** amount + merchant + time; instrument **alias set** (physical last 4, device token last 4, wallet nickname) in the owned-instrument registry (stream 10 §D2).
- **Provenance sentence.** "Paid with your watch (Google Wallet), matched to your HDFC card alert."
- **Recommendation.** Instrument alias sets in the owned-instrument registry: **`mvp`**. No wearable adapter (`later` for a Wear OS companion, as stream 03 §20 says).
- **References.** [22], [23], [24], [25], [26].

### G5. Transit: aggregated contactless fares, stored-value cards and NCMC (`transit-fare-aggregation`)

- **What it is.**
  - **Open-loop contactless with aggregation and capping.** TfL's travel day runs from 04:30 to 04:29; after it closes, the system works out the cheapest combination of fares for the day's taps and sends one charge to the bank, which can take 1–3 days to appear [27, S]. TfL also applies daily and weekly caps; registered users can see an itemized journey history [27]. New York's OMNY uses a rolling seven-day cap: after 12 paid rides in any seven days the rest are free [28]; secondary sources state a $35 weekly ceiling in 2026 [28, S].
  - **Closed-loop stored value.** Transit cards in Apple Wallet use Express Mode, which is "turned on by default" for eligible transit cards and needs no Face ID, Touch ID or passcode [29]. Top-ups appear as loads; individual rides live in the transit card's own history (whether Wallet exposes them to FinanceKit is unverified).
  - **India: National Common Mobility Card (NCMC).** A RuPay contactless card with an **offline wallet** (up to ₹2,000 per bank FAQs) used at metro gates and parking without a PIN or online authorization; it is topped up from the linked account, internet or mobile banking, or with cash at transit counters [30]. Auto-replenishment is exempt from India's 24-hour pre-debit notice (stream 05 §7).
- **Data available.** Aggregated charge (descriptor such as "TFL TRAVEL CH" [S]; other operators unverified), amount, posting date; journey detail only in operator portals. For stored value: top-up amount and time.
- **Windows & latency.** No IN-SPEND by design (frictionless gates; a nudge at a ticket gate would be unsafe and pointless). POST-SPEND with 1–3 days lag for aggregated open-loop fares; top-ups immediately.
- **Coverage.** London, New York and many other open-loop cities; closed-loop cards in Japan, Hong Kong, the US and elsewhere; NCMC across Indian metros.
- **Access & policy.** No adapter needed. Operator account APIs were not researched and would mean credential storage (`avoid`).
- **Privacy.** Journey histories are location trails. Do not ingest them by default; if a user shares one, keep daily totals only.
- **Reliability & failure modes.** Charge date ≠ travel date; one charge covers many journeys; capped days show lower totals; Express Mode taps may not fire the iPhone Wallet trigger (unverified).
- **Dedup keys.** Merchant key + instrument + travel-day offset (posting date minus 1–3 days).
- **Normalized observation.** `money_movement` with `aggregation: daily | weekly`, `items_unknown: true`, category prior `transport/transit`, essentiality prior *essential*. Stored-value top-up: `transfer/wallet_load` into a pocket (see Implications).
- **Provenance sentence.** "Your TfL charge for Tuesday's journeys, posted Thursday."
- **Recommendation.** Semantics and merchant-rule data: **`mvp`**. Never ask per journey; never treat a top-up as spending if the pocket's spends are unobservable (use stream 10's "unitemized" label). User-shared journey-history import: `later`.
- **References.** [27], [28], [29], [30]; stream 05 §7.

### G6. Tolls: FASTag and NETC (`fastag-netc`)

- **What it is.** India's National Electronic Toll Collection: an RFID FASTag on the windscreen, linked to a bank- or wallet-issued account. Every toll deduction triggers an SMS from the issuer with the amount, the plaza and the remaining balance, plus low-balance alerts [32]. Since **15 Aug 2025**, private non-commercial vehicles can buy an annual pass for **₹3,000**, valid for one year or 200 toll-plaza crossings, whichever comes first, via the Rajmargyatra app or NHAI website; activation is confirmed by SMS [31]. Auto-replenishment mandates are exempt from the 24-hour pre-debit notice (stream 05 §7, OC-207).
- **Data available.** Toll amount, plaza name, tag balance, vehicle registration number (PII), time.
- **Windows & latency.** POST-SPEND, seconds (SMS). PRE-SPEND context only via low-balance alerts.
- **Coverage.** India (all national-highway toll plazas). Other countries' transponders (E-ZPass and similar) were not researched (unverified).
- **Access & policy.** Through the existing SMS and notification adapters (streams 03, 07); one template pack per FASTag issuer.
- **Privacy.** Plaza + time is a movement trail. Keep `category: tolls` and the amount; drop the plaza and the vehicle number by default (stream 13's Context Justification Test).
- **Reliability & failure modes.** Double counting: the FASTag top-up debit **and** each toll SMS. Annual-pass tolls show ₹0 or no SMS. Disputed double deductions (unverified frequency) appear later as refunds.
- **Dedup keys.** Tag or wallet identifier (hashed) + amount + time.
- **Normalized observation.** Top-up: `transfer/wallet_load` into a `fastag` pocket. Toll: `purchase`, category `transport/tolls`, essentiality *essential*. Annual pass: `purchase` with `temporal_type: prepaid_period`.
- **Provenance sentence.** "From your FASTag toll SMS (₹285)."
- **Recommendation: `next`** (India SMS templates for the main FASTag issuers, with location minimisation).
- **References.** [31], [32]; stream 05 §7; stream 07 §3.

### G7. Holds and tips: fuel pumps, EV chargers, hotels, car rental and restaurants (`preauth-holds-and-tips`)

- **What it is.** Card authorizations whose amount is *not* the purchase amount.
  - **Automated fuel dispensers (MCC 5542).** Visa raised status-check holds at US pumps from $125 to $175, and Mastercard made the same change [33, S]. Mastercard recommends that issuers release any hold "no more than 60 minutes in Canada and the U.S. regions" after receiving the completion advice [33]. Secondary sources say both networks limit these holds to about two hours [33, S].
  - **EV charging.** The EU Alternative Fuels Infrastructure Regulation (EU) 2023/1804 requires newly installed public chargers of 50 kW or more, put into operation from **13 Apr 2024**, to offer ad-hoc payment with a payment card reader or a contactless device that can read payment cards; existing ≥50 kW chargers must be retrofitted by **1 Jan 2027** [34]. App-based networks also pre-authorize: Tesla places "a temporary authorization hold" when a session starts [35]; secondary sources report €50–120 [35, S].
  - **Hotels and car rental (MCC 7011, 7512).** Estimated and incremental authorizations; Visa expanded the eligibility for them [36].
  - **Restaurants and bars.** The pre-tip amount is authorized and the final amount cleared within a tolerance. Historically 20%; a secondary source states that from 21 Feb 2026 Visa allows up to 30% for US MCC 5811/5812/5814, with bars (5813) at 20% [36, S, **unverified**: Visa's Core Rules PDF dated 18 Apr 2026 was blocked].
- **Data available.** Authorization amount ≠ final amount; MCC; separate clearing record.
- **Windows & latency.** The authorization alert is the earliest POST-SPEND signal (seconds), but its **amount is wrong** for these MCCs; the final amount arrives on clearing (hours to days).
- **Coverage.** Global card behaviour; amounts by market.
- **Access & policy.** Rules data only.
- **Privacy.** None new.
- **Reliability & failure modes.** A $175 or $1 fuel alert followed by a $48.20 posting; a hotel hold released days later; "pending" EV session charges replaced by final ones.
- **Dedup keys.** Authorization ID where present; else merchant + instrument + time window, with MCC-specific amount tolerance.
- **Normalized observation.** `money_movement`, `stage: authorized_hold` (new stage), `amount_role: hold` (never counted as spending); final record supersedes (stream 10 §E2).
- **Provenance sentence.** "Your bank showed a $175 hold at Shell; the actual charge was $48.20."
- **Recommendation: `mvp`** as data: a hold-MCC table (5542, 5552 electric-vehicle charging (MCC number **unverified**), 7011, 7512, 4121 taxis (unverified)) and a tip-tolerance table by MCC and country, both with `asOf` dates in the capability registry.
- **References.** [33], [34], [35], [36]; stream 10 §E2.

### G8. Cash and ATM (`cash-and-atm`)

- **What it is.** Physical cash, and the withdrawals that create it.
  - **How much spending is cash.** Euro area 2024: cash was used in **52%** of point-of-sale transactions by number (down from 59%) and **39%** by value, with cards at 45% by value [37]. United States: cash was **14%** of consumer payments by number in 2024 and again in 2025 [38]. Japan: cashless payments were **42.8%** of consumer payment value in 2024 (so cash and other non-cashless means were the majority) [39].
  - **What BRAKE can see.** ATM withdrawals in ledgers (AA `mode=ATM`, MCC 6010/6011, Plaid `transaction_code: atm`; stream 10 §E7), in bank SMS and notifications, and, in the EU, in the currency-conversion message for a withdrawal in another Union currency (G15). Cash purchases themselves are visible only through manual entry, receipt photos and fiscal receipt QR codes (stream 08 §4, §15).
- **Windows & latency.** Withdrawal: POST-SPEND seconds (alert) to days (ledger). Cash purchases: unobservable unless the user logs them.
- **Coverage.** Universal; material in the euro area, Japan and India.
- **Access & policy.** No new access.
- **Privacy.** ATM location is a movement trail; drop it.
- **Reliability & failure modes.** Cash spends are logged late or not at all; withdrawals that fund a P2P payment or savings are not spending.
- **Dedup keys.** Withdrawal: amount + time + instrument.
- **Normalized observation.** Withdrawal: `transfer/cash_withdrawal` into a `cash` pocket. Manual cash purchase: `purchase` with `funding: cash_pocket`. Unexplained pocket balance remains "cash (untracked)" (stream 10 §3).
- **Provenance sentence.** "₹4,000 withdrawn on Saturday; ₹1,200 of it explained by entries you added."
- **Behavioural note.** Stream 09 §E2 notes that cash is the most transparent form of payment and increases the "pain of paying". BRAKE should not nudge users towards or away from cash.
- **Recommendation: `mvp`** for the cash-pocket semantics and a one-tap "cash spend" entry; **`next`** for an optional weekly "where did the cash go?" prompt inside stream 09's question budget.
- **References.** [37], [38], [39]; stream 10 §E7.

### G9. BNPL checkouts, schedules, card-based instalments and regulation (`bnpl-checkout-and-schedules`)

- **What it is.** Short-term instalment credit at the point of purchase, now in four shapes:
  1. **Checkout buttons** (Klarna, Afterpay/Clearpay, Affirm, Zip; pay-in-4 is typically four payments two weeks apart [65, S]).
  2. **Card-native instalments.** Apple ended Apple Pay Later in June 2024 and moved to instalments from issuers and Affirm inside Apple Pay [46, S]. Visa Flexible Credential lets one card switch between debit, credit, "pay-in-four" instalments, reward points and currency, using preferences the user sets in the issuer's app [45]. The Klarna Card is a debit product "powered by Visa Flexible Credential and issued by WebBank" with Pay in 4 and Pay Later options [45].
  3. **In-store BNPL by tap.** Klarna launched tap to pay for in-store purchases across 14 markets on 2 Dec 2025 [44].
  4. **India:** card EMIs and UPI credit lines (stream 05 §6). The pay-later app Simpl was ordered by the RBI on **25 Sep 2025** to stop payment operations for operating a payment system without authorisation under the Payment and Settlement Systems Act [43, S]. LazyPay's 2026 status was not checked (unverified).
- **Data available.**
  - *Checkout:* the BNPL option and plan on the merchant page (browser extension, stream 08 §C).
  - *Provider notifications:* Klarna notifies "by email and push notification when a payment is due and when you have made or missed a payment" [44, S].
  - *Schedule and order emails:* stream 09 §17.
  - *Debits:* each instalment as a card or bank debit to the provider. Plaid's taxonomy has a `LOAN_PAYMENTS_BNPL` category [67] (stream 10 also cites `LOAN_DISBURSEMENTS_BNPL` for PFC v2; both may exist), and Plaid's CRA reports count `loan_payments_bnpl_count_90d` [10].
  - *Regulated data:* Australia's CDR is adding non-bank lending and BNPL (stream 01 §10). No consumer-consented BNPL data API was found elsewhere. BNPL credit is not a *payment account*, so PSD2 account-information access does not reach it (inference from PSD2's scope).
- **Regulation (as of 2026-10-04).**
  - **UK:** the FCA has regulated Deferred Payment Credit since **15 Jul 2026**: interest-free credit repayable in 12 or fewer instalments within 12 months, provided by a third-party lender; affordability and creditworthiness checks, disclosure, help for customers in difficulty, and Financial Ombudsman access; agreements made before regulation day stay exempt [40].
  - **Australia:** from **10 Jun 2025** anyone engaging in credit activities involving BNPL contracts must hold an Australian credit licence; ASIC's RG 281 sets modified responsible-lending obligations [41].
  - **New York:** the BNPL Act was enacted in May 2025 and takes effect 180 days after DFS rules; DFS proposed rules on **23 Feb 2026** (licensing, fee limits, disclosures, disputes, privacy) [42].
  - **US federal:** the CFPB's 2024 interpretive rule was withdrawn on 12 May 2025 (stream 09). The Federal Reserve published a FEDS Note on BNPL "beyond pay in 4" on 5 Jun 2026 (title seen only) [65].
- **Windows & latency.** PRE-SPEND (the option is shown; future instalments are known obligations), IN-SPEND (the plan is chosen at checkout or, with flexible credentials, in the issuer app), POST-SPEND (schedule, debits, missed-payment notices).
- **Coverage.** US, UK, AU, DE, the Nordics, and growing in-store; India via card EMIs.
- **Access & policy.** Email and notification templates; browser extension on checkout pages. Gmail Limited Use forbids using Gmail-derived data for lending or creditworthiness (stream 06), so BNPL data must never feed credit decisions or partners.
- **Privacy.** BNPL use is credit information. Keep it on the device; never share it.
- **Reliability & failure modes.** If only the instalment debits are visible, BRAKE sees four 25% debits to "KLARNA" (descriptor format unverified) and no merchant. Refunds shorten or cancel the schedule. Flexible-credential cards change funding after the purchase.
- **Dedup keys.** Provider plan or order ID, merchant order ID, instalment number and amount, due dates.
- **Normalized observation.** The purchase is spending at checkout at full price; instalments are `loan_payment` with `instalment_of: <purchase_group>` (stream 10 §3). If only debits are seen, create a `purchase_group` with unknown merchant and ask once ("What was the Klarna plan for?").
- **Provenance sentence.** "From your Klarna schedule email: 4 × €25 for the Zalando order."
- **Recommendation: `next`** (schedule-email and notification templates for Klarna, Afterpay/Clearpay, Affirm and Zip; an obligations calendar). **`mvp`** for the `purchase_group` / `instalment_of` fields and `funding: bnpl`. **`avoid`** any BNPL partnership or revenue (streams 08 and 12 business-model guardrails).
- **References.** [10], [40], [41], [42], [43], [44], [45], [46], [65], [67]; stream 09 §17; stream 01 §10.

### G10. Crypto cards (`crypto-card-spend`)

- **What it is.** Card programmes that spend from a crypto balance. Coinbase Card is a Visa debit card; Coinbase states that spending any crypto other than USD or USDC "involves selling your assets", and that selling crypto using the card is a taxable transaction [47]. The Coinbase App API (v2) offers OAuth with read scopes such as `wallet:transactions:read` and `GET /v2/accounts/:account_id/transactions` [47]. Other crypto cards (Crypto.com, Bitpanda, self-custody cards) were not researched (unverified).
- **Data available.** Card purchase (merchant, amount in fiat) and the linked crypto sale; through the API, account transactions.
- **Windows & latency.** POST-SPEND (notifications seconds; API on poll).
- **Coverage.** US, UK, EU (provider-dependent).
- **Access & policy.** OAuth to the exchange (read-only), or the card app's notifications through the listener.
- **Privacy.** Very high: holdings and wallet addresses. Collect the purchase only, never balances or addresses.
- **Reliability & failure modes.** Bank-ledger-only users never see these purchases; the bank shows only fiat top-ups to the exchange, which are investments or transfers, not spending.
- **Dedup keys.** Exchange transaction ID; amount + merchant + time.
- **Normalized observation.** `purchase` with `funding: crypto_card`; the top-up from the bank is `transfer/investment`.
- **Provenance sentence.** "From your Coinbase Card notification (paid in USDC)."
- **Recommendation: `later`.** Add an instrument type `crypto_card` (`mvp`, data only) and a notification template (`next`). Build an exchange adapter only on demand.
- **References.** [47].

### G11. Employer, corporate and expense cards (`employer-expense-cards`)

- **What it is.** Cards issued by an employer, and expense platforms that manage them. Brex's API uses user tokens for one's own account and OAuth for partner applications, and "You must be a registered Brex partner to obtain OAuth credentials" [48]. Ramp's Developer API scopes (for example `transactions:read`) are chosen by the business for its developer apps [48]. SAP Concur and Expensify were not researched (unverified).
- **Data available.** Card transactions, receipts, policy status; but the account holder is the employer.
- **Windows & latency.** POST-SPEND.
- **Coverage.** Global.
- **Access & policy.** A consumer app has no business accessing employer card APIs. What reaches the employee's personal phone: the expense app's notifications, receipts in personal email, and reimbursements arriving in the personal account (stream 10 §E9).
- **Privacy.** Employer data and employment-monitoring concerns; work mailboxes are already discouraged (stream 11 §B4).
- **Reliability & failure modes.** Corporate-card notifications look like personal spending; personal cards used for business look like discretionary spending until reimbursed.
- **Dedup keys.** Reimbursement matching (stream 10 §E9).
- **Normalized observation.** Instrument flag `employer_owned` → `ownership: business`, excluded from personal discretionary pace; personal-card business purchases → `ownership: reimbursable`.
- **Provenance sentence.** "You marked your Brex card as your employer's, so its charges are not counted."
- **Recommendation.** Labels and instrument flag: **`mvp`** (the brief already lists "Work" and "Reimbursable"). Corporate-card or expense-platform APIs: **`avoid`**.
- **References.** [48]; stream 10 §E9.

### G12. Gift cards, store credit and prepaid instruments (`gift-cards-store-credit-prepaid`)

- **What it is.** Stored value that is not a bank account.
  - **US:** Regulation E §1005.20 covers gift certificates, store gift cards and general-use prepaid cards: funds may not expire before five years after issue or last load, and dormancy, inactivity or service fees are allowed only after a year of inactivity, at most one per month [49].
  - **India:** a gift PPI may not exceed **₹10,000**, is not reloadable, and does not allow cash withdrawal [50]. The RBI also published a draft revised Master Direction on PPIs in 2026 (secondary; contents not checked) [50, S]. Wallet loads to Paytm, PhonePe and Amazon Pay are covered in stream 02 §F3 and stream 10 §E7.
  - **Store credit and gift-card refunds:** refund emails can say the money went back to a gift card or wallet balance (stream 06 §13e).
- **Data available.** Gift-card purchase in the ledger or email; "gift card applied −$X" lines on order emails; refund-to-store-credit notices. Spending *from* a gift card is invisible to bank feeds.
- **Windows & latency.** POST-SPEND (email minutes; ledger days).
- **Coverage.** Universal.
- **Access & policy.** Existing email, receipt and share adapters.
- **Privacy.** Low.
- **Reliability & failure modes.** Order total ≠ card charge when a gift card or store credit covers part of it (fusion mismatch). A refund to store credit never produces a bank credit, so "refund expected, not seen" (stream 06 §13e) would wait forever.
- **Dedup keys.** Order ID; gift-card code (never stored; hash only if needed).
- **Normalized observation.** Buying a gift card for someone else: `purchase`, label *Gift*. Buying one for oneself: `transfer/wallet_load` into a `gift_card` pocket. `tender_split[]` on orders (card, gift card, store credit, points). Refund with `refund_method: store_credit` closes the refund without a bank credit.
- **Provenance sentence.** "Part of this order ($20) was paid with a gift card, so your card was charged $35.40."
- **Recommendation.** Pocket semantics and `tender_split`: **`mvp`**. Email templates for gift-card-applied and refund-to-store-credit lines: **`next`**.
- **References.** [49], [50]; stream 06 §13e; stream 10 §E7.

### G13. Loyalty points and pay-with-points (`loyalty-points-redemption`)

- **What it is.** Points used as money.
  - **At checkout:** Amazon's Shop with Points lets customers "pay for all or a portion of eligible purchases with rewards"; the rewards are deducted from the order total and the rest goes on the card [52].
  - **Afterwards:** Chase Pay Yourself Back redeems points as statement credits against eligible purchases from the last 90 days; the credit arrives within about three business days [51].
  - **On the card itself:** Visa Flexible Credential lists reward points as a funding source chosen per transaction [45].
  - **In data:** India AA credit-card summaries carry `loyaltyPoints` (stream 01 §5); EMV QR tag 62-04 carries a loyalty number (stream 05 §4).
- **Data available.** Order-email points lines; statement-credit records in ledgers; card app notifications.
- **Windows & latency.** POST-SPEND.
- **Coverage.** US-heavy for card points; global for retailer loyalty.
- **Access & policy.** Existing adapters.
- **Privacy.** Low.
- **Reliability & failure modes.** The email total includes the points portion but the card charge does not (fusion mismatch). A points statement credit looks like a refund and could be netted against the purchase a second time.
- **Dedup keys.** Order ID; statement-credit description.
- **Normalized observation.** `tender_split[]` with `points`; a points credit is `transaction_type: reward_credit` (not `refund`). Consumption views count the full price; cash-flow views count only the cash.
- **Provenance sentence.** "You used 2,000 points on this order, so your card was charged $12 less."
- **Recommendation: `mvp`** (data model only).
- **References.** [45], [51], [52].

### G14. Joint accounts, family and household sharing (`joint-and-family-accounts`)

- **What it is.** Accounts and instruments shared by more than one person.
  - **UK Open Banking v4.0.1:** `/accounts/{AccountId}/parties` (permission `ReadParty`) returns parties with `PartyType` ∈ {`Delegate`, `Joint`, `Sole`} [9].
  - **India AA deposit schema:** `Holders/@type` ∈ {`SINGLE`, `JOINT`}, with per-holder details and nominee status [11].
  - **Plaid:** "In the case of a joint account, Plaid will make a best effort to report the names of all account holders" [10].
  - **Apple Card Family:** owners and co-owners can set per-transaction spending limits for participants and get notifications when a participant's purchase or monthly total exceeds an amount [53]. FinanceKit excludes Apple Card Family participants and children using Apple Cash Family (stream 02 §A1).
  - **Google Wallet for kids:** supervised children can tap to pay; parents get an email for each transaction and see history in Family Link; available in the US, UK, Australia, Spain and Poland [54, S].
  - **UPI Circle:** delegated payments (stream 05 §8).
- **Data available.** Holding type, holder names, per-card last 4 for each holder on a joint account.
- **Windows & latency.** Context for all three windows.
- **Coverage.** Universal.
- **Access & policy.** Who may connect a joint account to an AISP is set by the bank and regulator. Open Banking customer-experience guidance on joint accounts could not be read (openbanking.org.uk blocked; **unverified**).
- **Privacy.**
  - The co-holder's transactions are a third person's personal data under GDPR and DPDP. BRAKE should show joint-account spending made with the other holder's card as "shared (not attributed to you)" unless the user confirms both holders agree.
  - BRAKE is 18+ (stream 11 PR-13; DPDP s.9 bans behavioural monitoring of children). It must not offer "monitor my child's spending". A parent's top-ups to a child's wallet are the parent's outflow (`transfer/family`).
- **Reliability & failure modes.** Two partners each running BRAKE on the same joint account each see the other's spending; BRAKE is on-device first, so there is no cross-user deduplication (accept and explain it). Attribution by card last 4 fails when both holders use one card or a shared wallet.
- **Dedup keys.** Account ID + holder instrument.
- **Normalized observation.** Account-level `holding: sole | joint | delegate`; per-instrument `holder: self | other | unknown`; `ownership: personal | shared | family` (brief §Semantic attributes).
- **Provenance sentence.** "This is a joint account; the payment was made with your partner's card ••7712."
- **Recommendation.** `holding` and `holder` fields with default exclusion of the other holder's card spends from personal discretionary pace: **`mvp`**. A household view with mutual consent: **`next`**. Any child-monitoring feature: **`avoid`**.
- **References.** [9], [10], [11], [53], [54]; stream 11 PR-13.

### G15. Multi-currency, travel and dynamic currency conversion (`fx-dcc-and-travel-spend`)

- **What it is.** Paying in a currency other than the account's.
  - **EU Regulation 2019/518 (amending 924/2009).** Card currency-conversion charges must be expressed as a percentage mark-up over the latest ECB euro reference rates. DCC providers at ATMs and points of sale must disclose that mark-up to the payer *before* the payment is initiated. The issuer must send the payer an electronic message with the same information "without undue delay" after receiving a payment order for an ATM withdrawal or point-of-sale payment in a Union currency other than the account currency; channels include SMS, email or a banking-app push agreed with the user, and where nothing changes the message may be sent once a month [55].
  - Multi-currency accounts (Wise, Revolut) are covered in stream 02 §E5–E6; cross-currency transfer matching in stream 10 §E4; travel detection in stream 13 §C7.
- **Data available.** In the EU message: original amount and currency, converted amount, total conversion charge as a mark-up.
- **Windows & latency.** PRE-SPEND: DCC disclosure at the terminal (BRAKE cannot see it). POST-SPEND: the EU message, seconds to minutes after the payment.
- **Coverage.** EU/EEA issuers for cross-currency card use; the UK retained its own version after Brexit (not checked; unverified).
- **Access & policy.** Through existing SMS, notification and email adapters.
- **Privacy.** Reveals travel; stream 13's travel-context rules apply.
- **Reliability & failure modes.** Monthly batching for repeated currencies; message wording per issuer.
- **Dedup keys.** Original amount + currency gives an exact bridge to the merchant receipt; converted amount + time to the ledger.
- **Normalized observation.** Attach `fx {original_amount, original_currency, markup_pct}` to the candidate.
- **Provenance sentence.** "From your bank's currency-conversion message: €54.00 charged as £47.12 (mark-up 2.6%)."
- **Behavioural use.** A one-time, pre-trip tip ("at terminals, choosing the local currency is usually cheaper") when travel is detected and the user has tips enabled. It is factual and non-judgmental.
- **Recommendation: `next`** (EU FX-message templates as a fusion key; the pre-trip tip).
- **References.** [55]; stream 10 §E1, §E4; stream 13 §C7.

### G16. Payment initiation, VRP / sweeping and SEPA Request-to-Pay (`pis-vrp-srtp-surfaces`)

- **What it is.**
  - **Sweeping VRP (UK).** The CMA required the nine largest UK banks to implement VRP for sweeping (moving money between a customer's own accounts) by July 2022; VRP for other uses was left optional [56].
  - **Commercial VRP (UK).** UK Payments Initiative Wave 1 launched on **2 Jun 2026** for energy, utilities and telecoms, regulated financial services, e-money institutions, government and charities, targeting about 75% of UK current accounts [57, S]. The OBIE VRP specification is in stream 01 §7.
  - **SEPA Request-to-Pay (SRTP).** The EPC scheme lets a payee "request the initiation of a payment from a Payer in a wide range of physical or online use cases"; rulebook v4.0, with a clarification paper updated on 1 Jun 2026 covering "accept now/later" and "pay now/later" options and expiry; 2026 homologation waves, and the EPC Directory Service opening to participants at the end of September 2026 [58].
  - **Payment initiation (PIS) in general.** The user is redirected to the bank app to approve; stream 05 §17 covers seeing the redirect in a browser extension.
- **Data available.** cVRP: recurring payments of variable amount under one consent. SRTP: payee, amount, expiry, shown to the payer before payment.
- **Windows & latency.** cVRP consent: PRE-SPEND (a new recurring obligation). SRTP request: **IN-SPEND** (the payer decides in the bank app). Executed payments: POST-SPEND.
- **Coverage.** UK (VRP), euro area (SRTP, early adoption).
- **Access & policy.** For BRAKE to *initiate* payments (for example "move what you didn't spend to savings") it would need PISP authorisation or to act through a regulated partner (stream 01 §7). Reading the request or consent requires the bank app's notification (Android listener template) or AIS data. Whether UK AIS exposes VRP consents as standing orders or direct debits was not checked (unverified).
- **Privacy.** As for open banking (stream 11 §B9).
- **Reliability & failure modes.** Early-stage schemes; variable amounts break fixed-amount recurrence detection.
- **Dedup keys.** VRP consent ID (if exposed); payee + amount + date series.
- **Normalized observation.** cVRP: `kind: mandate`, `recurrence: variable` (as for UPI AutoPay in stream 05 §7). SRTP: `checkout`, `stage: requested`.
- **Provenance sentence.** "Your energy supplier collects by variable recurring payment (approved in your bank app)."
- **Recommendation.** BRAKE as payment initiator (sweeps, a "BRAKE-paid" checkout with a built-in pause): **`later`** via a partner. Recognising cVRP and SRTP in alerts and ledgers: **`next`**.
- **References.** [56], [57], [58]; stream 01 §7.

### G17. Apple and Google Wallet passes as a BRAKE output surface (`wallet-pass-surface`)

- **What it is.** A BRAKE-issued pass in the user's wallet that shows, for example, "discretionary left this week" or a goal's progress.
  - **Apple Wallet.** Pass styles: boarding pass, event ticket, store card, coupon and generic; passes can be updated "in real-time" [1]. To make a pass updatable, add `webServiceURL` and `authenticationToken`; the server sends an APNs push with an empty payload, the device asks for changed serial numbers and downloads the new pass [4]. A field's `changeMessage` is "a format string for the alert text to display when the pass updates", e.g. `Gate changed to %@` [3]. A pass can list "up to 10" locations, plus `maxDistance`, Bluetooth beacons and `relevantDates` (the older `relevantDate` is deprecated) [2].
  - **Google Wallet.** Discovery document revision `20261002`: `notifyPreference: NOTIFY_ON_UPDATE` sends a notification only "if the updated fields are part of an allowlist", and must be set on each update; messages of type `TEXT_AND_NOTIFY` render "as text on the card details screen and as an Android notification"; `merchantLocations` (maximum ten) trigger a notification "when a user enters within a Google-set radius"; the older `locations` field is "not supported to trigger geo notifications"; `GenericType` includes `GENERIC_RECEIPT`, `GENERIC_UTILITY_BILLS`, `GENERIC_LOYALTY_CARD` and others [6]. Notification rate limits were not visible (developers.google.com blocked; unverified).
  - **Reading other passes is not possible.** `PKPassLibrary.passes()` "Returns the passes in the user's pass library that the app can access", limited by entitlements [5]. Google's API is issuer-only (stream 02 §B1).
- **Windows & latency.** PRE-SPEND glance (lock-screen relevance near a user-chosen place, without BRAKE holding location permission, because the wallet evaluates relevance; inference) and POST-SPEND update after a transaction.
- **Coverage.** iOS, watchOS and Android, worldwide.
- **Access & policy.** Apple Pass Type ID certificate; Google Wallet issuer account. Whether a "budget" pass fits each wallet's content policies was not checked (unverified).
- **Privacy.** The pass is visible on the lock screen. Show only what the user chooses (for example a percentage, not amounts).
- **Reliability & failure modes.** Updates depend on push delivery; Google's notifications only fire for allowlisted fields.
- **Dedup keys.** n/a (output).
- **Provenance sentence.** n/a (output surface).
- **Recommendation: `later`.** Widgets, Live Activities and notification actions (streams 03, 04) already cover the same need on the device.
- **References.** [1], [2], [3], [4], [5], [6].

### G18. E-receipt standards and digital-receipt regimes (`e-receipt-standards`)

- **What it is.** Rules and standards that move receipts from paper to digital channels.
  - **OMG Digital Receipt API 1.0** (April 2025): a JSON/REST version of the ARTS Digital Receipt standard, with line items inside retail transactions, developed with the Digital Receipt Subcommittee of Japan's .NET Retail System Council [59].
  - **France:** since **1 Aug 2023** receipts (including card-payment slips) are no longer printed systematically; they are printed on request, and merchants may offer a digital receipt [60].
  - **Germany:** receipts have been mandatory since 1 Jan 2020 and may be issued electronically with the customer's consent (email, download link or QR code) [61]; a government draft reportedly makes electronic receipts the default from 1 Jan 2028 [61, S].
  - **Fiscal receipt QRs** (Brazil NFC-e, Saudi ZATCA) are covered in stream 08 §15.
  - **Visa Enhanced Merchant Data:** issuers must show the merchant's trading name, street address (card-present), phone and website in their digital channels by **23 Jan 2027** [62, S]. This is not a receipt, but it improves the merchant strings in bank notifications that stream 13's resolver consumes.
  - **Google Wallet `GENERIC_RECEIPT`** passes exist [6] but are not readable by BRAKE (G17).
- **Data available.** Line items (ID, description, quantity, unit price, tax, discounts), totals, tenders, store and terminal IDs.
- **Windows & latency.** POST-SPEND, at checkout (QR or email) or minutes later.
- **Coverage.** France, Germany, Japan (DRAPI), merchants worldwide.
- **Access & policy.** No API reaches consumer receipts held by merchants. Receipts reach BRAKE through email (stream 06), share or upload (stream 08), or a user-scanned receipt QR that links to a web page (fetching the link sends a request to the merchant's provider; user-initiated only).
- **Privacy.** Receipts can carry names, loyalty IDs and partial card numbers (stream 08 §15): extract and discard.
- **Reliability & failure modes.** Many formats; links expire.
- **Dedup keys.** Receipt or transaction ID, terminal ID, total + time, card last 4.
- **Normalized observation.** `receipt` with `lineItems[]` shaped like DRAPI/ARTS line items.
- **Provenance sentence.** "From the digital receipt you scanned at the till."
- **Recommendation: `next`** (align the line-item schema; add a user-initiated receipt-link QR handler). Merchant digital-receipt partnerships: `research`.
- **References.** [6], [59], [60], [61], [62]; stream 08 §15.

### G19. Direct carrier billing (`carrier-billing`)

- **What it is.** Digital purchases charged to the mobile phone bill or prepaid balance. Google Play carrier billing is offered in more than 55 countries with 140 operators [64]. Apple's equivalent was not checked (unverified).
- **Data available.** Google Play receipt emails (stream 02 §G3) state the payment method; prepaid operators may send balance-deduction SMS (unverified).
- **Windows & latency.** POST-SPEND (email minutes; phone bill monthly).
- **Coverage.** Strong in markets with many prepaid users (country list unverified).
- **Access & policy.** Existing email and SMS adapters.
- **Privacy.** Low.
- **Reliability & failure modes.** The bank feed shows only the telecom bill payment, which is categorised as essential telecom although part of it is discretionary app spending.
- **Dedup keys.** Google Play order number (`GPA.…`, stream 06 §13b) + amount.
- **Normalized observation.** `purchase` with `funding: carrier_bill`; the later telecom bill payment gets a linked, partially discretionary split.
- **Provenance sentence.** "This ₹149 Play purchase was charged to your phone bill."
- **Recommendation: `next`.**
- **References.** [64]; stream 02 §G3.

### G20. Issuer subscription controls (`issuer-subscription-controls`)

- **What it is.** Card-network rules that make issuers manage recurring payments. Visa launched an "Enhanced Subscription Manager" in 2026 [63]. Secondary sources report a Visa issuer mandate in force since **18 Apr 2026** in 13 European markets: label three recurring transaction types, let cardholders place and remove merchant-level stop instructions, and tell cardholders that stopping card payments does not end the contract [63, S]. Visa also has rules for subscription merchants offering free trials [63].
- **Data available.** A recurring flag in issuer apps (and possibly in notifications); merchant-level stop status.
- **Windows & latency.** PRE-SPEND (before a renewal); POST-SPEND (recurring flag on the charge).
- **Coverage.** Visa issuers in the named markets (US status unverified).
- **Access & policy.** No third-party API; BRAKE can only deep-link the user to the bank app.
- **Recommendation: `next`.** "Where to cancel" guidance inside the renewal intervention (stream 10 §E11), and parse a recurring indicator where notifications expose it.
- **References.** [63]; stream 10 §E11.

### G21. Android NFC wallet role and Observe Mode (`android-nfc-observe-mode`)

- **What it is.** Android 15 added Observe Mode for host card emulation. Apps that register payment AIDs "can only process a transaction if" the user sets the app as the default payment app ("Wallet role holder on Android 15+ devices") or the app is in the foreground and calls `setPreferredService` [66]. In Observe Mode, the device passively observes a terminal's polling loop; frames that match an app's filters go to that app's `HostApduService`, but standard polling frames go only "to the preferred foreground service … or to the default wallet role holder otherwise". This lets the service "ensure that the user is ready to transact and intends to do so—for example, authenticating the user" before it lets the transaction proceed [66].
- **Windows & latency.** A genuine **IN-SPEND** moment (the phone is at the terminal, before the tap completes), but only for the default wallet.
- **Access & policy.** BRAKE would have to *be* the user's wallet, which means being an issuer or token requestor (stream 02 §D). A wallet partner could show BRAKE context at this moment.
- **Recommendation: `research`** (partner-only, like iOS EEA host card emulation in stream 04 §25).
- **References.** [66].

### G22. Evidence for the *intent* and *purchase-context* attributes (`intent-context-evidence-map`, synthesis)

The brief asks BRAKE to infer *intent* (planned, unplanned, impulsive, recurring, emergency) and *purchase context* (planned in advance, saw and bought, recommended, replacement, upgrade, social, convenience). Stream 09 keeps these separate from essentiality and regret (§4.6) and offers an optional "Why now?" tag (§14), but no stream maps signals to values. Mapping from evidence already in the corpus:

| Attribute value | Evidence that supports it (source) | Strength |
|---|---|---|
| intent = planned | wishlist or cooling-off item later bought (08 §3, 09 §2); manual "Should I buy this?" before the purchase (08 §1); approved agent mandate (G2); calendar or booking for the event (06 §13f) | strong |
| intent = recurring | recurring series (10 §E10); mandate or AutoPay (05 §7); subscription email (06 §13c) | strong |
| intent = unplanned / impulsive | no prior intent signal; short app-open-to-purchase gap (03 §5, 04 §3); late night (13 §C1); merchant marketing email shortly before (06 §13h). Never label "impulsive" without the user (09 §E5) | weak; ask |
| intent = emergency | medical or repair MCC, unusual amount, user label | weak; ask |
| context = replacement | same GTIN or product category bought before (08 §13, receipt line items) | medium |
| context = upgrade | same category, higher price tier than the last purchase | weak |
| context = recommended | product shared from a social or messaging app (share-sheet source app, 08 §5) | weak |
| context = social | shared expense or split (10 §E9), group restaurant bill | medium |
| context = convenience | delivery-fee line items, quick-commerce merchants (13 §B1) | medium |

**Recommendation: `mvp`** for storing these as `Inference`s with alternatives and basis, fed by the signals above; ask only through stream 09's EVOI question budget.

### G23. The "anomaly notice" post-spend surface (`anomaly-notice`, synthesis)

The brief lists "anomaly notice" among post-spend responses. Stream 09 §4.2 includes duplicate charges and overdue refunds among its insight triggers, but no stream defines anomalies as a set. From evidence already in the corpus plus this stream: (1) likely duplicate charge (same merchant, amount and instrument within minutes; 10 §E1); (2) hold not released (G7); (3) price increase on a recurring series (10 §E11); (4) amount far outside this user's history with the merchant (13 §B18); (5) foreign merchant while no travel is detected (13 §C7); (6) refund overdue (06 §13e); (7) free trial converting (06 §13c); (8) instalment missed (G9). Each must pass stream 09's insight gate (say something only if it changes understanding) and use the confidence copy tiers. **Recommendation: `next`.** BRAKE is not a fraud-detection service and must not imply that it is.

---

## IN-SPEND depth audit (platform × market)

The brief asks for IN-SPEND to be researched independently. This table checks, for each market and payment context, what the corpus found on each platform and whether that is the realistic ceiling. "Structural" means no consumer app can do better without becoming (or partnering with) the issuer, wallet, payment app or merchant.

| # | Market / payment context | Android | iOS | Web / desktop | Where researched | Verdict |
|---|---|---|---|---|---|---|
| I-1 | India: UPI QR at a counter | BRAKE QR scanner, then hand-off to the UPI app before PIN entry (✓✓) | Same scanner and app hand-off (✓✓) | n/a | 05 §1–3, §18; 08 §12; 13 §B10 | substantive |
| I-2 | India: UPI app-to-app from a merchant app | BRAKE as a `upi://` chooser target (research; regulatory and UX risk) | none (app-specific schemes) | QR shown on screen → scanner | 05 §1, §18; 03 §17; 11 §B13; 12 §A5 | substantive (research-grade) |
| I-3 | India: card e-commerce (OTP) | OTP SMS deliberately avoided; Android 15+ redacts OTP notifications | none | browser extension | 07 §6; 06 (`payment-otp-emails`); 08 §C | partial by policy (deliberate) |
| I-4 | India: NCMC, FASTag, UPI Lite | none (offline or frictionless by design) | none | n/a | 05 §6; G5; G6 | gap-filled here (no IN-SPEND possible) |
| I-5 | US and global: in-store card or wallet tap | none; Google and Samsung Wallet notifications are POST-SPEND seconds (G3); wallet Observe Mode is wallet-only (G21) | Shortcuts Wallet "Transaction" trigger for Apple Pay taps (✓; watch taps unresolved) | n/a | 04 §1; 02 §A4; G3; G4; G21 | substantive; structural ceiling |
| I-6 | US and global: web checkout | Firefox for Android extension only; no Chrome extensions | Safari Web Extension (✓✓) | Chromium, Safari, Firefox extensions (✓✓) | 05 §16–17; 08 §9–11; 04 §13; 12 §C4; 09 §16 | substantive |
| I-7 | Any market: checkout inside a shopping app | app-launch nudge (PRE-SPEND); AccessibilityService and Autofill avoided | Screen Time shields (PRE-SPEND) | n/a | 03 §5–7, §22; 04 §3–5; 08 §20–24 | partial; structural (only merchant or payment partnerships, 08 §25–26) |
| I-8 | UK / EEA: card e-commerce with SCA | SCA / 3-D Secure approval push read by the listener (G1) | none | browser extension | G1; 08 §C | gap-filled here |
| I-9 | UK / EEA: account-to-account (Pay by Bank, iDEAL/Wero, BLIK, Swish, Bizum, SRTP) | BLIK and Swish confirmations (G1); SRTP request notifications (G16) | none | redirect to the bank seen by the extension | 05 §13, §17; G1; G16 | gap-filled here |
| I-10 | Brazil: Pix | QR scanner; "copia e cola" share or paste | QR scanner; share or paste | QR on screen → scanner | 05 §11; `payment-string-share-paste` | substantive |
| I-11 | South-East Asia QR (SG, TH, MY, ID, VN, PH, KH) | QR scanner with national EMV profiles | same | n/a | 05 §4–5 | substantive |
| I-12 | China: Alipay / WeChat Pay | weak (opaque tokens; merchant hint only) | weak | n/a | 05 §12 | partial; structural |
| I-13 | Japan: PayPay, cards, Suica | POST-SPEND notifications only | Wallet trigger for Apple Pay; Suica Express Mode (G5) | extension | 05 §12; 04 §1; G5 | partial; structural |
| I-14 | Kenya and mobile-money markets | M-Pesa STK push is a SIM-toolkit prompt (avoid); SMS POST-SPEND | none | n/a | 05 §14; 07 §1b | partial; structural |
| I-15 | Any market: issuer-, wallet- or agent-side decision points | BRAKE-issued card; Investec Card Code; agent mandates; wallet Observe Mode | BRAKE card; agent mandates | agent checkout (ACP/UCP) | 02 §D, §D2, §C4; 08 §27; G2; G21 | substantive (02) + gap-filled (G2, G21) |

**Reading.** IN-SPEND was researched in real depth where a consumer app can actually participate: QR-first rails (I-1, I-10, I-11), browser checkouts (I-6), Apple Pay taps (I-5) and issuer authorization (I-15). The gaps this stream closes are I-8 and I-9 (the authentication step, Android, Europe) and the agent channel (I-15). The remaining partial rows are structural ceilings, not missing research.

---

## Three-window classification (sources added by this stream)

| Source (id) | Pre-spend | In-spend | Post-spend | Latency | Recommendation |
|---|---|---|---|---|---|
| `sca-authentication-prompt` (G1) | – | ✓✓ (Android, Europe) | links to the outcome | seconds before completion | next |
| `agentic-commerce-mandates` (G2) | ✓✓ (mandate approval) | ✓ (human-present signing) | ✓ (receipts, order webhooks) | n/a (protocol) | mvp (schema), research (integration) |
| `android-wallet-tap-notifications` (G3) | – | – | ✓✓ | seconds–minutes | next |
| `wearable-payments` (G4) | – | – | ✓ (via phone wallet or issuer) | seconds–minutes | mvp (instrument aliases) |
| `transit-fare-aggregation` (G5) | context (commute) | – | ✓ (1–3 days lag) | days | mvp (semantics) |
| `fastag-netc` (G6) | low-balance context | – | ✓✓ (toll SMS) | seconds | next |
| `preauth-holds-and-tips` (G7) | – | (hold alert, wrong amount) | ✓ (final on clearing) | seconds (hold), days (final) | mvp (rules data) |
| `cash-and-atm` (G8) | weak | – | ✓ (withdrawal); cash spends manual | seconds–days | mvp |
| `bnpl-checkout-and-schedules` (G9) | ✓ (option shown; future instalments) | ✓ (plan chosen) | ✓✓ (schedule, debits) | minutes–weeks | next |
| `crypto-card-spend` (G10) | – | – | ✓ | seconds | later |
| `employer-expense-cards` (G11) | – | – | ✓ (exclusion) | n/a | mvp (labels); avoid (APIs) |
| `gift-cards-store-credit-prepaid` (G12) | – | – | ✓ | minutes–days | mvp / next |
| `loyalty-points-redemption` (G13) | – | – | ✓ | days | mvp (model) |
| `joint-and-family-accounts` (G14) | context | context | context | n/a | mvp / next |
| `fx-dcc-and-travel-spend` (G15) | ✓ (pre-trip tip) | – (DCC screen not visible) | ✓✓ (EU FX message) | seconds–minutes | next |
| `pis-vrp-srtp-surfaces` (G16) | ✓ (cVRP consent) | ✓ (SRTP request) | ✓ | seconds | next (recognition), later (initiation) |
| `wallet-pass-surface` (G17) | ✓ (glance) | – | ✓ (update) | push | later |
| `e-receipt-standards` (G18) | – | – | ✓✓ (line items) | minutes | next |
| `carrier-billing` (G19) | – | – | ✓ | minutes (email), monthly (bill) | next |
| `issuer-subscription-controls` (G20) | ✓ (before renewal) | – | ✓ (recurring flag) | n/a | next |
| `android-nfc-observe-mode` (G21) | – | ✓✓ (wallet only) | – | ms | research |

---

## Implications for BRAKE architecture

### A. Observation and candidate model additions

These are additions to the shapes in `docs/architecture/overview.md` and streams 05 and 10. None of them names a provider, so they respect ADR-003.

1. **New `stage` values:** `authenticating` (G1), `authorized_hold` (G7), `requested` (SRTP, G16). Holds are never counted as spending; an `authenticating` candidate expires if no outcome arrives within its window.
2. **`initiator`** ∈ {`user`, `agent`, `merchant`, `delegate`} on every observation (G2; UPI Circle in stream 05 §8; merchant-initiated mandates).
3. **`kind: mandate`** with `constraints {max_amount, budget, allowed_merchants[], expires_at, recurrence: fixed | variable}`. One kind covers AP2/ACP open mandates, UK cVRP, UPI AutoPay and card e-mandates (G2, G16; stream 05 §7).
4. **`funding`, separate from `rail` and `instrument`:** `bank`, `card_debit`, `card_credit`, `bnpl`, `points`, `gift_card`, `store_credit`, `cash_pocket`, `stored_value` (transit, FASTag, NCMC, UPI Lite), `crypto`, `carrier_bill`. Stream 05 already separates `funding_instrument` for UPI; this generalises it (G9, G10, G12, G13, G19). Visa Flexible Credential (G9) means funding can change per transaction on the *same* card.
5. **`tender_split[]`** on orders and receipts: `{funding, amount}` parts, so an email total can match a smaller card charge (G12, G13).
6. **Stored-value pockets.** A pocket is an owned instrument with kind `cash | transit | fastag | ncmc | upi_lite | gift_card | store_credit | wallet`. Loads are `transfer/wallet_load`; spends from the pocket are purchases when observed; the unexplained remainder is shown as "unitemized" and never double-counted (G5, G6, G8, G12; stream 10 §3).
7. **`aggregation`** ∈ {`none`, `daily`, `weekly`} and `items_unknown` on money movements (transit, G5).
8. **`purchase_group` / `instalment_of`** (BNPL, card EMIs, Brazilian *parcelado*; G9; stream 02 §E7).
9. **Instrument metadata:** alias sets (physical last 4, device-token last 4, nickname; G4), `employer_owned` (G11), `holder: self | other | unknown`, and account `holding: sole | joint | delegate` (G14).
10. **`fx {original_amount, original_currency, markup_pct}`** (G15).
11. **New `transaction_type`:** `reward_credit` (G13). The brief's `business expense` maps to `ownership: business` (G11), not a separate type.

### B. Capability-registry facts (proposed; `asOf: 2026-10-04`)

| Scope | Capability id | Status | Note | Evidence |
|---|---|---|---|---|
| EU, GB | `auth:sca-dynamic-linking` | available | Payer shown amount and payee during SCA (RTS Art. 5) | [12] Ps |
| PL | `auth:blik-app-confirmation` | available | Amount and recipient shown in the bank app | [15] Ps |
| SE | `auth:swish-payment-request-push` | available | Push to Swish app; BankID signing | [16] Ps |
| android (15+) | `os:nls-otp-redaction` | available | Untrusted listeners lose content only where an OTP is detected | [14] P |
| android | `wallet:google-wallet-tap-notification` | available | Merchant, amount, card; silent by default | [20] Ps |
| android | `wallet:samsung-wallet-tap-notification` | available | After each purchase; issuer-dependent | [21] Ps |
| android (15+) | `os:nfc-observe-mode` | wallet-role only | Polling frames to the default wallet or foreground preferred service | [66] P |
| GLOBAL | `agentic:ap2` | emerging | Spec v0.2; open-mandate constraints | [7] P |
| GLOBAL | `agentic:acp` | emerging (beta) | Delegated token limited by Allowance | [8] P |
| US | `agentic:ucp-checkout` | emerging | Announced 2026-01-11; eligible US retailers | [19] Ps |
| GB | `transit:tfl-daily-aggregation` | available | One charge per travel day; posts after 1–3 days | [27] S |
| US-NY | `transit:omny-7day-cap` | available | Rolling seven-day cap after 12 paid rides | [28] Ps |
| IN | `toll:fastag-sms` | available | Per-toll SMS with amount, plaza, balance | [32] Ps |
| IN | `toll:fastag-annual-pass` | available | ₹3,000; 1 year or 200 trips; from 2025-08-15 | [31] Ps |
| IN | `transit:ncmc-offline-wallet` | available | Offline wallet (≤ ₹2,000 per bank FAQs), no PIN | [30] Ps |
| US | `holds:afd-status-check-max` | 175 USD | Visa and Mastercard | [33] S |
| EU | `charging:afir-adhoc-card-payment` | required | New ≥50 kW from 2024-04-13; retrofit by 2027-01-01 | [34] Ps |
| US | `tips:restaurant-tolerance` | 20% (30% from 2026-02-21, unverified) | MCC 5811/5812/5814; bars 20% | [36] S |
| EU (euro area) | `cash:pos-share-by-number` | 52% (2024) | 39% by value | [37] Ps |
| US | `cash:payment-share-by-number` | 14% (2024, 2025) | Fed Diary | [38] Ps |
| JP | `cash:cashless-ratio` | 42.8% (2024) | Share of consumer payment value | [39] Ps |
| GB | `bnpl:regulated-dpc` | in force 2026-07-15 | Third-party lender DPC | [40] Ps |
| AU | `bnpl:credit-licence` | in force 2025-06-10 | NCCP; RG 281 | [41] Ps |
| US-NY | `bnpl:state-licensing` | pending | Effective 180 days after DFS rules (proposed 2026-02-23) | [42] Ps/S |
| IN | `bnpl:simpl` | stopped | RBI order 2025-09-25 | [43] S |
| GB | `ob:party-type` | available | Delegate / Joint / Sole | [9] P |
| IN | `aa:holders-type` | available | SINGLE / JOINT | [11] Ps |
| EU | `fx:cbpr2-conversion-message` | available | Issuer message after cross-currency card use; DCC mark-up disclosed before payment | [55] Ps |
| GB | `pay:cvrp-ukpi-wave1` | available (2026-06-02) | Utilities, regulated FS, EMIs, government, charities | [57] S |
| EU | `pay:srtp` | emerging | Rulebook v4.0; EDS opening end Sep 2026 | [58] Ps |
| FR | `receipts:paper-on-request` | in force 2023-08-01 | AGEC law | [60] Ps |
| DE | `receipts:electronic-allowed` | available | With consent; digital default proposed for 2028 | [61] Ps/S |
| GLOBAL | `merchant:visa-enhanced-merchant-data` | due 2027-01-23 | Issuer apps show trading name, address, phone, website | [62] S |
| ios | `wallet:pass-updates` | available | Push-driven updates, change messages, up to 10 locations | [2]–[4] P |
| android | `wallet:pass-update-notifications` | limited | Allowlisted fields or `TEXT_AND_NOTIFY` only | [6] P |

### C. Normalization pitfalls added by this stream

1. **Hold amounts are not purchase amounts** (fuel, EV charging, hotels, car rental, tips). Match the final amount with MCC-specific tolerances (G7).
2. **One charge, many purchases** (transit aggregation) and **many charges, one purchase** (BNPL instalments) (G5, G9).
3. **Order total ≠ card charge** when gift cards, store credit or points cover part (G12, G13).
4. **Points statement credits are not refunds**; netting them as refunds double-counts the purchase's reduction (G13).
5. **Device-token last 4 ≠ plastic card last 4** (unverified per wallet); match instruments by alias set (G4).
6. **The authentication prompt is not the payment.** It can be abandoned, declined or retried (G1).
7. **Joint-account debits may be another person's spending** (G14).
8. **Carrier-billed purchases hide inside the telecom bill** (G19).
9. **Crypto-card top-ups are investments or transfers; the card purchase is the spending** (G10).
10. **Posting date ≠ event date** for aggregated transit fares (1–3 days) (G5).

### D. Product consequences (the brief's users A, B, C)

- **User A (Android, India):** add FASTag and NCMC handling (pockets, toll SMS), and keep card OTPs out. The corpus's IN-SPEND strength (UPI) is unchanged.
- **User B (iPhone, USA):** the agent-mandate schema (G2), hold and tip rules (G7), BNPL schedules (G9) and points (G13) matter most. IN-SPEND remains Apple Pay taps plus the Safari extension.
- **User C (no connected accounts):** cash pocket and one-tap cash entry (G8), receipt-QR scanning (G18), and the BNPL obligations calendar from emails (G9) add value without any financial connection.
- **A new Android, EU user** gets a real IN-SPEND signal from SCA and BLIK/Swish prompts (G1), which the corpus did not have.

---

## Risks, policy constraints and ethical concerns

1. **Authentication prompts are security-critical.** Reading them is acceptable only as read-only parsing; any interaction with their actions, any delay, or any overlay would be authentication interference. The adapter must be reviewed as security code and tested to never call `PendingIntent`s (G1).
2. **Agentic policy liability.** If BRAKE ever acts as a policy check for an agent and fails open or closed wrongly, a purchase is blocked or allowed against the user's wish. Fail open, log, and never present BRAKE as a payment authority (G2).
3. **Third-party personal data.** Joint accounts, family plans and household views expose another adult's transactions (G14). Children are out of scope (stream 11 PR-13).
4. **Employer data.** Corporate-card data belongs to the employer; BRAKE must not ingest it even when a token is technically obtainable (G11).
5. **Location trails.** Toll plazas, transit journeys, ATM and EV-charger locations reveal movement. Keep category and amount; drop places by default (G5, G6, G8, G7).
6. **Credit data.** BNPL usage must never feed credit decisions, partners or advertising (G9; Gmail Limited Use, stream 06).
7. **Lock-screen exposure.** A wallet pass with budget figures is visible to anyone holding the phone (G17).
8. **Regulatory drift.** BNPL (UK, AU, NY, IN), cVRP, SRTP, AFIR and Visa issuer mandates all changed in 2024–26; keep these as dated registry facts, not code (Implications B).

---

## Open questions

1. Does the iPhone Shortcuts Wallet "Transaction" trigger fire for Apple Watch payments and for Express Mode transit taps? (Test on devices; G4, G5.)
2. Which major EU, UK and Polish issuers put amount and payee in the 3-D Secure or SCA *push text* (not only the in-app screen), and do any Android OEMs redact such pushes? (Fixture collection; G1.)
3. What exact package names and text formats do Google Wallet and Samsung Wallet use for tap notifications in 2026, and do they differ for watch payments? (G3.)
4. Will any wallet or credential provider let a consumer app register as an AP2 or ACP policy constraint evaluator? (G2.)
5. Is MCC 5552 the electric-vehicle charging MCC across networks, and what pre-authorization amounts do AFIR-compliant contactless chargers use in practice? (G7.)
6. Do UK AIS endpoints expose commercial VRP consents (as standing orders, direct debits or a new resource)? (G16.)
7. Can a consumer app read Wallet transit-card ride history through FinanceKit, or only top-ups? (G5.)
8. What is LazyPay's operating status in India in 2026, and does the RBI's draft PPI Master Direction change gift PPI limits? (G9, G12.)
9. How do UK Open Banking customer-experience guidelines handle joint-account consent by one holder? (G14.)
10. Does the UK version of the cross-border payments regulation still require the post-transaction FX message? (G15.)
