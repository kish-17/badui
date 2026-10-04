# Prior Art and Competitive Landscape: What Existing Money, Friction and Receipt Products Teach BRAKE

> **Scope.** This document covers prior art and competitors relevant to BRAKE's three time windows: India SMS- and Account-Aggregator-based trackers and payment apps; US and global personal-finance managers (PFMs); UK/EU open-banking apps and neobanks; attention-friction apps; spend controls and "pause before purchase" tools; receipt, email and rewards apps; and the trust incidents around data monetization. For each one it records the sensing approach, the intervention approach, the labeling UX, what worked and what failed, and what it teaches about retention, trust and business model. It closes with the gap BRAKE fills and the anti-patterns to avoid. Research stream 12.
>
> **Date:** 2026-10-04. Every time-sensitive claim carries an "as of" date or a verification marker.
>
> **Verification status (read this first).** This session's web-search budget was used up after 4 queries, because the budget is shared across research streams. The egress proxy also blocked fetches from almost every vendor, news and regulator domain. The only domains that could be fetched were `developer.apple.com`, `developer.android.com` and `github.com`. As a result:
> - Claims followed by a reference number like **[16]** were verified in this session, either against a fetched primary page or against a search-result summary. The References section says which.
> - Claims marked **(unverified)** come from model knowledge (training data up to about mid-2026) and were **not** re-checked in this session. Treat them as leads, not facts, and re-verify them before any decision depends on them. The "Unverified-claims register" at the end lists the important ones.
> - Product facts about named competitors are mostly in the unverified category. Platform-mechanism facts (Apple FinanceKit, FamilyControls/ManagedSettings/DeviceActivity, Android notification and usage APIs) are mostly verified.
>
> **Key takeaways for BRAKE**
> 1. **Indian trackers built on sensed spending data have repeatedly turned into credit businesses.** Walnut, the archetypal SMS-reading tracker, was acquired by the digital lender Capital Float in August 2018 and became axio, which offers BNPL, personal loans and fixed deposits [6][7][8]. Fi raised $168M, could not grow its main lending business, and in March 2026 began winding down banking on its platform for more than 3.5M users [12][13][15]. BRAKE needs a non-credit business model from day one, and the rule "sensed data never feeds credit, affiliate or ad decisions" has to be enforced in the architecture, not just stated in policy.
> 2. **Dependence on a single permission, vendor or partner is the most common way these products die.** Examples: Google Play's January 2019 SMS/Call Log policy (default handler or an approved declaration, otherwise removal) [9][10][11]; Mint folding into Credit Karma, with shutdown by 2024-03-23 [1][3][4]; GoCardless Bank Account Data closing to new accounts from July 2025 [38]; Fi losing its bank channel in 2026 [12]. For BRAKE, the adapter layer, the capability registry and per-institution multi-provider routing are what keep it alive, not optional engineering.
> 3. **Aggregator-fed PFMs are retrospective ledgers.** This covers Mint, Copilot, Monarch, YNAB, Emma and Snoop. Bank data reaches them hours to a day after the purchase. For example, SimpleFIN refreshes about once per 24 hours and returns at most 90 days of history [39], and FinanceKit background delivery is at best hourly (iOS 26+) [21][22]. None of these products steps in before money moves. In the US, UK and EU, BRAKE's pre-spend and in-spend value has to come from non-bank mechanisms: app shielding, browser checkout detection, share-sheet checks and manual checks.
> 4. **The strongest evidence of behavior change comes from attention-friction apps, not finance apps.** one sec, Opal and ScreenZen all put a short, skippable pause at app launch. iOS offers an entitlement-gated, privacy-preserving way to do this: FamilyControls individual authorization (iOS 16+), ManagedSettings shields and DeviceActivity schedules and thresholds [23][24][25][29]. The shield extension sees opaque tokens, never app names [27]. No friction app knows anything about money. That is the core gap BRAKE fills: friction that is calibrated by financial context and by the user's own regret history.
> 5. **Banks have shown that people opt into hard, self-imposed spending blocks with delayed reversal.** UK gambling blocks with a cooling-off period before they can be removed are the main example (details unverified). These blocks are coarse (based on merchant category codes) and only the card issuer can apply them. Unless BRAKE becomes an issuer or partners with one, it should orchestrate these controls (explain them, deep-link to them, remind the user) rather than copy them.
> 6. **Labeling UX: the good PFMs reduce categorization to a short review queue and learn rules from corrections** (Copilot and YNAB, unverified). Android notifications allow at most **three** action buttons [34], which is exactly enough for "top-2 predictions + Other". BRAKE must not build a YNAB-style "approve every transaction" loop for mainstream users.
> 7. **The trust incidents share one pattern: data collected "for you" was reused for parties who profit from your spending.** Examples include Unroll.me/Slice receipt data reaching Uber, litigation over Yodlee data sales, Honey's affiliate-cookie controversy, Avast/Jumpshot browsing data, and the Cleo FTC settlement (all unverified). Apple App Store guideline 5.1.2(i)–(iii) already forbids repurposing data and covertly building profiles [30]. BRAKE should go further and publish a data-flow manifest for each adapter that users can inspect.
> 8. **Receipt and rewards apps show that line items are the richest layer of meaning, and that users will photograph receipts or link email when they get an immediate payoff.** Fetch and Ibotta are the examples (unverified). Their revenue, however, comes from brands paying to increase purchases, which is the opposite of BRAKE's mission. BRAKE should copy how they sense, not how they make money.
> 9. **Apple FinanceKit is the only on-device, aggregator-free, privacy-aligned financial source on iOS.** In the US it covers Apple Card, Apple Cash and Savings (iOS 17.4+). In the UK it covers 13 banks through Wallet (iOS 18.4+). Its transactions include `merchantName`, `merchantCategoryCode` and `status ∈ {authorized, booked, pending, rejected, memo}` [16][18][19]. BRAKE should apply for the managed entitlement early.
> 10. **Open-source, local-first PFMs confirm demand for privacy-first finance and match BRAKE's adapter pattern.** Actual Budget (MIT licence, about 29.3k stars) supports pluggable bank-sync providers: Akahu, Enable Banking, GoCardless, Pluggy AI and SimpleFIN [36][37]. Maybe Finance was archived in July 2025 [42], which shows how commercially fragile a pure PFM is.

---

## Sources investigated

### How to read this section

Each mechanism subsection follows the same template: what it is → prior-art products and what they taught → data actually available → time windows and latency → coverage → access requirements → privacy and consent → reliability and failure modes → deduplication keys → normalized BRAKE observation and its confidence → provenance sentence → recommendation.

Observation kinds follow `docs/architecture/fusion-and-reconciliation.md`: `money_movement`, `purchase_intent`, `checkout`, `order`, `receipt`, `refund_notice`, `subscription_event`, `invoice`, `booking`, `delivery`, `balance_snapshot`, `app_context`, `mandate`.

Recommendation scale: **mvp** (build for first release), **next** (first follow-on), **later**, **avoid**, **research** (unresolved; investigate before committing).

### Landscape at a glance (product by product)

"V" means at least the key fact in that row was verified in this session (see the reference). "U" means the row is from model knowledge and unverified.

#### India

| Product | Sensing | Intervention | Labeling UX | What worked | What failed / lesson | Business model | V/U |
|---|---|---|---|---|---|---|---|
| **Walnut → axio** | Android READ_SMS parsing of bank, card and wallet SMS [8] | Post-spend dashboards and bill reminders (U) | Auto-categorization with manual edit (U) | Zero setup; one permission covered every bank; described as "India's most downloaded expense tracker" (a competitor's claim) [8] | Acquired by digital lender Capital Float on 2018-08-14 [6]; rebranded axio; expanded into BNPL, personal loans and FDs [8]. The tracker became a credit funnel | Lending | V |
| **Money View** | Started as an SMS-reading money manager (U) | Budget views (U) | Auto (U) | SMS gave a cash-flow picture good enough for underwriting (U) | Pivoted to digital lending (U). Same lesson: SMS data is underwriting data | Lending | U |
| **ET Money** | Started as an SMS-based expense tracker from Times Internet (U) | Tracking, then investments (U) | Auto (U) | Distribution | Pivoted to mutual-fund investing; reportedly acquired by 360 ONE in 2024 (U) | Investment distribution | U |
| **Fold** | Account Aggregator (AA) consent-based bank data (U) | Spend views, tags and rules (U) | Tag- and rule-based (U) | Bank-grade posted data without SMS (U) | Business sustainability not verified | Subscription (U) | U |
| **Jupiter** | Neobank layer on a partner bank, plus AA-based insights (U) | Spend insights, "pots" (U) | Auto (U) | UX | Moved toward credit products (U) | Interchange and credit (U) | U |
| **Fi** | Neobank layer on Federal Bank, with insights (U) | Insights, savings rules (U) | Auto (U) | Reached more than 3.5M users [12][15] | Banking services wound down after Federal Bank ended the partnership ("business re-alignment"); accounts move to FedMobile; $168M raised; failed to grow lending [12][13]; described as a "pivot to AI" [14]. As of 2026-03 | Lending, then AI pivot | V |
| **CRED** | Credit-card bill payment data, and "CRED money"-style AA spend views (U) | Rewards for paying on time (U) | Auto (U) | Affluent user base | Rewards drive engagement, not restraint (U) | Lending and commerce (U) | U |
| **PhonePe / Paytm / Google Pay (India)** | First-party ledger of payments made in that app (U) | History and monthly spend summaries (U) | Little or none (U) | Owns the in-spend moment | No third-party access; incentive is to grow transaction volume and credit distribution (U) | Payments, merchant services, credit distribution (U) | U |

#### US and global PFMs

| Product | Sensing | Intervention | Labeling UX | What worked | What failed / lesson | Business model | V/U |
|---|---|---|---|---|---|---|---|
| **Mint (Intuit), 2007–2024** | Aggregator bank feeds (U) | Budgets, alerts | Auto-categorize with editable rules (U) | Free; mass adoption | Shut down by 2024-03-23; users pushed to Credit Karma, which lacks budgeting and month-over-month trends [3][4]. Mint earned money from ads and referral fees, the same way Credit Karma does, and Credit Karma was the larger ad vehicle [3]. Shutdown announced November 2023 [1] | Lead generation, ads | V |
| **Copilot Money** | Multiple aggregators; Apple Card via FinanceKit (U) | Budgets, recurring tracking, monthly review (U) | "To review" queue; AI categorization learns from edits (U) | Polished UX; review ritual (U) | Initially iOS-only (U) | Subscription (U) | U |
| **Monarch Money** | Multiple aggregators (Plaid, MX, Finicity) with per-institution provider switching (U) | Budgets, goals, collaborative household (U) | Rules, review (U) | Absorbed many Mint refugees in 2023–24 (U); provider switching works around broken connections (U) | Aggregator breakage is still the top complaint (U) | Subscription (U) | U |
| **YNAB** | Manual entry first, plus bank import (U) | Zero-based budgeting method ("give every dollar a job") (U) | Approve every imported transaction (U) | Method plus community creates strong identity and retention among committed users (U) | High effort; price changes drew public backlash (U) | Subscription (U) | U |
| **Rocket Money (formerly Truebill)** | Aggregator (U) | Subscription detection, cancellation concierge, bill negotiation (U) | Auto (U) | A concrete "money back" payoff (U) | Negotiation fees are a percentage of savings (U); acquired by Rocket Companies (2021) (U) | Freemium, plus success fees (U) | U |
| **Cleo** | Aggregator (U) | Chat AI with "roast" and "hype" modes; cash advances (U) | Conversational (U) | Gen-Z engagement through personality (U) | FTC settlement (about $17M, 2025) over cash-advance claims and cancellation practices (U) | Subscriptions, cash advances (U) | U |
| **Simplifi (Quicken)** | Aggregator (U) | "Spending plan" (U) | Rules (U) | Simple forward-looking plan (U) | n/a | Subscription (U) | U |
| **Origin** | Aggregator (U) | AI financial planning and advisor (U) | n/a | n/a | Regulatory weight of giving advice (U) | Subscription (U) | U |

#### UK and EU

| Product | Sensing | Intervention | Labeling UX | What worked | What failed / lesson | Business model | V/U |
|---|---|---|---|---|---|---|---|
| **Emma** | Open-banking AIS (U) | Subscriptions, "wasteful" spend, budgets (U) | Auto, editable (U) | Subscription finder (U) | n/a | Tiered subscription (U) | U |
| **Snoop** | Open-banking AIS (U) | Personalized savings tips ("Snoops") and deals (U) | Auto (U) | Proactive, specific tips (U) | Deal and affiliate monetization; acquired by Vanquis Banking Group, a credit-card lender (2023) (U) | Affiliate, then lender-owned (U) | U |
| **Plum** | Open-banking AIS (U) | Automatic saving algorithm (U) | n/a | "Set and forget" automation (U) | n/a | Subscription and investing (U) | U |
| **Yolt (ING)** | Open-banking AIS (U) | PFM | Auto | n/a | Consumer app closed in 2022 (U). Bank-owned PFM did not pay its way | n/a | U |
| **Monzo** | First-party ledger | Instant push notification for every card payment, Trends, Pots, gambling block (U) | Category edit in app (U) | Real-time notifications with clean merchant name and logo set the bar (U) | n/a | Bank | U |
| **Revolut** | First-party ledger | Analytics, budgets, card toggles, disposable virtual cards (U) | Auto (U) | Granular card controls (U) | n/a | Bank and subscriptions | U |
| **Starling** | First-party ledger | Spaces, gambling block, AI "Spending Intelligence" Q&A (2025) (U) | Auto (U) | Conversational spending queries (U) | n/a | Bank | U |

#### Attention-friction apps

| Product | Mechanism | What worked | What failed / lesson | V/U |
|---|---|---|---|---|
| **one sec** | iOS: Shortcuts "app opened" automation, later the Screen Time API; Android: accessibility service. Breathing pause, then "continue or close" (U) | Peer-reviewed field study (PNAS 2023) reporting large drops in app openings, and users often choosing not to continue after the pause (U) | Setup friction on iOS before Screen Time API support (U) | U |
| **Opal** | Screen Time API sessions, "Deep Focus" sessions that can't be ended early (U) | Scheduled blocks; gamification (U) | Strict modes push people to uninstall (U) | U |
| **ScreenZen** | Configurable wait timer, limits on daily opens, escalating delay (U) | Free or donation model; strong word of mouth (U) | n/a | U |
| **Freedom** | Cross-device blocklists and sessions (U) | Cross-platform sync (U) | n/a | U |
| **Platform APIs** | iOS FamilyControls, ManagedSettings and DeviceActivity [23]–[29]; Android UsageStatsManager [35] | Privacy-preserving opaque tokens [27] | Entitlement gate [23] | V |

#### Spend controls and purchase-delay tools

| Product | Mechanism | Lesson | V/U |
|---|---|---|---|
| **UK bank gambling blocks** (Monzo, Starling, Barclays, Lloyds Banking Group, NatWest and others) | Issuer declines card authorizations with gambling merchant category codes; removal requires a cooling-off delay (e.g. 48h at Monzo) (U) | Users accept self-imposed commitment devices with delayed reversal. MCC-based blocking leaks (U) | U |
| **Revolut / Privacy.com** | Per-card toggles; merchant-locked, spend-limited virtual cards (U) | Controls at the instrument level work, but only inside that issuer | U |
| **RBI card controls (India)** | Since 2020 the RBI has required that cardholders can switch online, international and contactless use on or off and set limits (U) | A universal Indian issuer capability that BRAKE can point users to (U) | U |
| **Icebox (Finder) and similar browser extensions** | Replaces "Buy" with "put it on ice" for a cooling-off period, then reminds (U) | The delay mechanic is old and simple; distribution is the hard part (U) | U |
| **Gamban / GamStop** | Device-level and operator-level gambling self-exclusion (U) | Strong commitment devices exist for an adjacent harm (U) | U |

#### Receipt, email and rewards apps

| Product | Sensing | Business model | Trust lesson | V/U |
|---|---|---|---|---|
| **Fetch** | Photos of any receipt, eReceipts via email linking (U) | Consumer-packaged-goods brands pay for offers and purchase insight (U) | Users trade receipts for points; data serves brands (U) | U |
| **Ibotta** | Receipt verification, loyalty-account linking, offer network; IPO 2024 (U) | Brands pay per redemption (U) | Same | U |
| **Slice / Unroll.me (Rakuten)** | Gmail/Outlook receipt parsing (U) | Aggregated purchase-data panels (U) | Lyft-receipt data reached Uber (2017 press); FTC action in 2019 (U) | U |
| **Paribus / Earny** | Email receipts → price-drop refund claims (U) | Share of refunds (U) | Broad mailbox access for narrow value (U) | U |
| **Honey (PayPal)** | Browser extension on checkout pages (U) | Affiliate commissions (U) | December 2024 allegations of affiliate-cookie hijacking (U) | U |

#### Open-source and failed PFMs

| Project | Status | Lesson | V/U |
|---|---|---|---|
| **Actual Budget** | Active; MIT licence; local-first; about 29.3k stars; bank sync via Akahu, Enable Banking, GoCardless, Pluggy AI, SimpleFIN [36][37]; docs repo archived 2025-11-18 and merged into the main repo [41] | Privacy-first demand is real; the plugin model for bank sync matches BRAKE's adapter model | V |
| **Maybe Finance** | Repository archived 2025-07-27; AGPLv3; final release v0.6.0; "no longer actively maintained" [42] | Even a well-funded, polished PFM struggled commercially | V |
| **OSS local-first trackers** (ezBookkeeping, BeeCount and others) | Active [44] | "Local-first" is a recognized product position | V |

---

### A. Financial-data sensing prior art

#### A1. `india-sms-bank-alerts` — reading bank SMS on Android (Walnut/axio, Money View, early ET Money)

- **What it is.** An Android app holds `READ_SMS`/`RECEIVE_SMS` and parses SMS from bank, card and wallet sender IDs (for example `VM-HDFCBK`). This was the original Indian PFM pattern.
- **Prior art and lessons.** Walnut is the archetype. It auto-read bank SMS to track expenses [8]. It was acquired by the digital lender Capital Float on 2018-08-14 [6][7], rebranded axio, and expanded into BNPL, personal loans and FDs [8]. Money View and ET Money followed the same path from tracker to financial product (unverified).
  - **What worked:** zero setup; every bank, card and wallet covered by one permission; near-real-time; an immediate "aha" because the existing inbox gives months of history on the first run.
  - **What failed:** regex templates break across hundreds of senders and format changes; the same event appears as duplicates (SMS, email and app push); transfers and credit-card bill payments show up as "spend"; the Play 2019 policy shock [9]–[11]; and erosion of trust once SMS-reading became associated with predatory lending apps.
  - **Business-model lesson:** SMS cash-flow data is underwriting data, so it pulls the product toward lending.
- **Data actually available.** Sender ID, received timestamp and body text. A parser can extract amount, debit/credit, account or card last-4, merchant/VPA/payee, UPI reference (RRN/UTR) and available balance. The open-source `transaction-sms-parser` [43] is a typical regex approach: it outputs `account{type,number,name}`, `balance{available,outstanding}` and `transaction{type,amount,referenceNo,merchant}`, and was tested against Axis, ICICI, HDFC, Kotak, HSBC, Citi, Paytm and Amazon Pay messages.
- **Windows and latency.** POST-SPEND, seconds to minutes after the debit. Some PRE-SPEND value: bill-due and EMI reminders, and UPI AutoPay / e-mandate pre-debit notifications (the RBI framework requires advance notice before a recurring debit — unverified).
- **Coverage.** India; Android only (iOS apps cannot read the SMS inbox). User reach is very high among Indian Android users who keep bank SMS alerts on.
- **Access requirements.** Google Play Permissions Declaration. An app must be the default SMS handler or qualify for an approved exception; unapproved apps were removed after a 90-day window in early 2019 (deadline 2019-03-09) [9][10][11]. The current exception list reportedly includes an "SMS-based money management" use case (unverified; confirm in the current Play Console Help before relying on it).
- **Privacy and consent.** Very high sensitivity. The permission exposes the whole inbox, including personal messages and OTPs. The grant is all-or-nothing, so it is far broader than the purpose.
- **Reliability and failure modes.** Capture is high for banks that still send SMS. Parsing quality is medium. Failures: template drift, multi-part SMS, regional languages, promotional SMS that look like transactions, delayed or duplicated delivery.
- **Dedup keys.** UPI RRN (12 digits); card last-4 + amount + time; account last-4 + balance-after chaining.
- **BRAKE observation.** `money_movement{stage: confirmed, direction, amount, currency: INR, instrument_hint: "A/c XX1234", counterparty_raw, rail_hint: UPI|card|IMPS|NEFT|ATM, refs:[{type: upi_rrn}], balance_after, sender_id}`. Confidence is high for amount and direction when the template matches, medium to low for merchant identity, and low for whether it is spend or a transfer.
- **Provenance sentence.** "Detected from an HDFC Bank SMS (sender VM-HDFCBK) received at 10:41."
- **Recommendation: research.** The prior art shows the data is excellent, but this route carries existential policy and trust risk. Most of the same alerts can be captured through the notification listener (A2) without SMS permission. Consider `READ_SMS` only as an opt-in, one-time historical backfill, and only if the Play exception is confirmed for 2026, with on-device parsing restricted to an allow-list of bank senders.

#### A2. `android-notification-listener` — reading bank, UPI-app and SMS-app notifications

- **What it is.** `NotificationListenerService` lets an app receive notifications posted by other apps and by the system [31]. That includes the SMS app's notification for a bank SMS, bank-app pushes, UPI-app "Paid ₹X to Y" pushes and neobank pushes.
- **Prior art.** I could not verify any mainstream PFM built primarily on notification listening. Smaller trackers advertise it (unverified). Neobanks such as Monzo showed that a real-time push for every payment is what users expect (unverified).
- **Data.** Package name, title, text, post time, notification key and category. The bank text yields the same fields as A1.
- **Windows and latency.** POST-SPEND, within seconds. A possible IN-SPEND signal: the *arrival* of a bank OTP notification during an online card payment, without reading its content. This is ethically delicate and should be treated as research.
- **Coverage.** Android, global. Strongest in India, where bank alerts are near-universal (the brief notes SMS banking alerts are "common").
- **Access.** The user enables notification access in system settings. Since **Android 15**, untrusted listeners receive **redacted content for notifications in which an OTP is detected**; trusted apps such as companion-device-manager associations are exempt [32]. Android 16 behavior changes list no further changes to notification listeners [33].
- **Privacy.** Very high. Every app's notifications are visible, including chats. BRAKE must filter by an allow-list of packages and senders on-device, and drop everything else immediately.
- **Reliability.** Depends on OEM battery killers and on the user keeping alerts enabled. The same event often appears twice (SMS app and bank app).
- **Dedup keys.** RRN or card last-4 + amount + time; the notification key (within one source).
- **BRAKE observation.** As in A1, with `source: notification, package: com.snapwork.hdfc` (example). Confidence is the same as A1.
- **Provenance sentence.** "Detected from your HDFC Bank app notification at 10:41."
- **Recommendation: mvp (Android).** It is the lowest-friction near-real-time post-spend sensor, needs no SMS permission, and is the natural successor to Walnut-style capture. Other streams own the details.

#### A3. `india-account-aggregator` — consented bank data via AA (Fold, CRED, Jupiter, Fi, INDmoney)

- **Prior art.** Several Indian apps show multi-bank spending through AA consent: Fold, CRED and Jupiter (unverified), and Fi, whose banking front-end wound down in 2026 [12].
  - **What worked:** a bank-grade ledger across banks with explicit, revocable, purpose-bound consent, and no SMS permission.
  - **What didn't:** a multi-step consent journey (AA handle, OTP, account discovery); uneven uptime and coverage across banks (FIPs); data that is fetched on demand with frequency caps rather than pushed; cryptic narration strings (all unverified).
  - **Business lesson:** AA-powered tracking was usually a funnel for lending or investing, not a product in its own right (pattern; product specifics unverified).
- **Data.** Deposit-account transactions. ReBIT schema fields commonly cited are `txnId`, `type`, `mode`, `amount`, `currentBalance`, `transactionTimestamp`, `valueDate`, `narration` and `reference` (unverified in this session; the AA stream owns this).
- **Windows and latency.** POST-SPEND. Minutes to hours, bounded by consent fetch frequency (unverified).
- **Coverage.** India, platform-independent (server-side).
- **Access.** Must be a regulated Financial Information User (FIU), or go through a regulated partner or technology service provider (unverified).
- **Privacy.** High, but well structured: consent artefact, purpose code, data life and revocation.
- **Reliability.** Medium. Varies by FIP.
- **Dedup keys.** `txnId` and `reference` (which may carry a UPI RRN), plus amount, `valueDate` and account.
- **BRAKE observation.** `money_movement{stage: posted, provider_txn_id, ...}`. Confidence is high for amount and posting, medium for counterparty.
- **Provenance sentence.** "Matched with your SBI statement shared via Account Aggregator (consent until 2027-01-01)."
- **Recommendation: next.** It is the authoritative reconciliation layer that turns notification-sensed candidates into posted ones, but the regulatory access and consent friction make it a poor first-run experience.

#### A4. `upi-payment-app-analytics` — PhonePe, Paytm, Google Pay (India) in-app history

- **What it is.** Payment apps keep a first-party history of payments made through them, and some show monthly spend summaries (unverified).
- **Lessons.** These apps own the IN-SPEND moment in India. Their incentives (transaction volume, merchant offers, credit distribution) do not favor restraint (unverified). There is no third-party read API (unverified). Their payment-success pushes reach BRAKE through A2.
- **Windows.** POST-SPEND (history), IN-SPEND (inside their own flow only).
- **Dedup keys.** UPI transaction ID or RRN shown in the receipt screen (unverified).
- **BRAKE observation.** Only indirectly: notifications (A2), user-shared receipt screenshots (E2/D2), or user-initiated statement exports (unverified).
- **Provenance sentence.** "Detected from your PhonePe payment notification."
- **Recommendation: avoid as a direct integration** (none exists). Track as a **competitive risk**: if these apps add native "pause before pay" features, BRAKE's Indian in-spend wedge narrows.

#### A5. `upi-intent-url` — BRAKE as the QR front-door that hands off to the user's UPI app

- **Prior art.** CRED, Jupiter and Fi became full UPI third-party app providers (TPAPs) to own the payment moment (unverified). That is heavyweight: it needs NPCI approval and a sponsor bank. The lighter pattern is for BRAKE to scan the merchant QR, show context ("You've spent ₹2,140 on food delivery this week"), then hand off through an intent URL (`upi://pay?pa=…&pn=…&am=…&tr=…`) to the user's PSP app. The parameter names come from the NPCI linking specification (unverified here; the UPI stream owns this).
- **Windows.** PRE-SPEND and IN-SPEND, within about a second.
- **Dedup keys.** `tr` (transaction reference) if BRAKE sets it; payee VPA + amount + time.
- **BRAKE observation.** `purchase_intent{payee_vpa, payee_name, amount?, mcc?, rail: UPI, stage: intent}`. Confidence: high that the user intends to pay this payee, low that the payment completed.
- **Provenance sentence.** "From the UPI QR code you scanned with BRAKE at 13:02."
- **Recommendation: research.** It is high-value and well aligned with BRAKE (the user chose to route through BRAKE), but PSP-app behavior toward third-party intents needs checking.

#### A6. `plaid-transactions` — US aggregator-fed PFMs (Mint, Copilot, Monarch, YNAB, Rocket Money, Simplifi, Cleo, Origin)

- **Prior art and lessons.**
  - **Mint** proved there was mass demand for free automatic tracking. Its ad and referral model folded into Credit Karma, and Mint shut down by 2024-03-23 [1][3][4]. A CNBC headline captured the user lesson: "the peril of relying on free services" [1].
  - **Monarch** lets users switch the aggregator per institution (unverified). That is the direct answer to the fact that every aggregator breaks for some banks.
  - **Copilot** made review a short daily ritual (unverified).
  - **YNAB** builds retention through method and identity (unverified).
  - **Rocket Money** monetizes concrete savings: cancellations and negotiation (unverified).
  - **Cleo** showed that personality-led chat engages younger users, but its cash-advance monetization drew FTC action (unverified).
- **Data.** Plaid Transactions fields cited by other streams: `transaction_id`, `pending_transaction_id`, `pending`, `amount`, `iso_currency_code`, `date`, `authorized_date`, `merchant_name`, `personal_finance_category{primary,detailed,confidence_level}`, `payment_channel` and `account_id` (unverified in this session; the Plaid stream owns this).
- **Windows and latency.** POST-SPEND, hours to about a day (pending entries can be earlier). SimpleFIN, an MX-backed bridge, refreshes roughly every 24 hours [39], which gives a sense of the typical cadence.
- **Coverage.** US and Canada (Plaid also has some UK/EU coverage). Server-side.
- **Access.** Commercial contract and per-connection pricing (unverified). The regulatory backdrop (CFPB §1033 personal financial data rights) was in flux in 2025–2026, and its status could not be verified in this session.
- **Privacy.** High. The legacy screen-scraping era left trust scars, such as class-action litigation against Plaid (unverified).
- **Reliability.** Medium. Connections break and need re-authentication; pending-to-posted changes the amount (tips, fuel); duplicate and transfer confusion.
- **Dedup keys.** `transaction_id`, `pending_transaction_id`, `account_id`.
- **BRAKE observation.** `money_movement{stage: pending|posted, provider_txn_id, provider_pending_id, category_hint (PFC + confidence_level), ...}`. Confidence: high for amount and date, medium for merchant and category.
- **Provenance sentence.** "Matched with your Chase transaction (via Plaid)."
- **Recommendation: next (US/CA).** It provides rich context but is post-spend only and expensive. US MVP users can be served by FinanceKit (A8), email, manual entry and friction mechanisms. Design the adapter so that several aggregators can serve one institution (the Monarch lesson).

#### A7. `simplefin-bridge` — user-held, low-cost aggregation bridge

- **Facts.** Costs $1.50/month or $15/year to the user. Returns at most 90 days per account. Data updates about once a day and depends on the upstream provider (MX). Uses a one-time setup token [39]. Supported by Actual Budget alongside Akahu, Enable Banking, GoCardless and Pluggy AI [37].
- **Lesson.** In this model the user, not the app, holds and pays for the aggregator relationship. It aligns incentives and keeps the app out of credential custody, but the setup is too technical for mainstream users.
- **Windows.** POST-SPEND, about 24 hours.
- **Dedup keys.** Provider transaction IDs (unverified).
- **Provenance sentence.** "Imported from your SimpleFIN connection (updated daily)."
- **Recommendation: research.** It could serve as a "bring your own aggregator" adapter for power users.

#### A8. `apple-financekit` — on-device Apple Wallet financial data (US and UK)

- **What it is.** A framework for accessing on-device financial data, Apple Cash and Wallet orders [17].
- **Eligibility** [16]:
  - the app is in the App Store **Finance** category;
  - it is distributed in the **US or UK**;
  - it provides financial management (net worth, spending trends, budgeting);
  - an app offering financial products must let customers connect accounts to Wallet.
- **Access.** Managed entitlement request, made by the Account Holder of an organization developer account; `NSFinancialDataUsageDescription`; Apple review [17]. Apple Store Review guideline 5.1.1(ix) also requires financial-services apps to be submitted by a legal entity [30].
- **Coverage** [16]:
  - **US (iOS 17.4+):** Apple Card (excluding Family participants), Apple Cash (excluding Family children), Savings.
  - **UK (iOS 18.4+):** open-banking accounts that users connect to Wallet at Barclays, Barclaycard, First Direct, Halifax, HSBC, Lloyds, M&S Bank, MBNA, Monzo, Nationwide, NatWest, Royal Bank of Scotland and Santander.
- **Data.** `Transaction{id, accountID, transactionAmount, creditDebitIndicator, transactionDescription, originalTransactionDescription, merchantCategoryCode (ISO 18245), merchantName, transactionType, status, transactionDate, postedDate, foreignCurrencyAmount, foreignCurrencyExchangeRate}` [18]. `TransactionStatus ∈ {authorized, booked, pending, rejected, memo}` [19]. Balances and accounts are also available. Users control which accounts are shared and over what time range, and data comes from an on-device store [16].
- **Windows and latency.** POST-SPEND. A foreground query reads the on-device store, so it reflects whatever Wallet holds. `transactionHistory(forAccountID:since:isMonitoring:)` with `HistoryToken` supports incremental sync [20]. **Background delivery** (`enableBackgroundDelivery(for:frequency:)`) needs **iOS 26+** and offers `hourly`, `daily` and `weekly`, where "hourly" means "within an hour of data updating" [21][22].
- **Prior art.** Copilot, YNAB and Monarch reportedly integrated Apple Card through FinanceKit (unverified).
- **Privacy.** On-device, with per-account and per-time-range consent. This is the best fit with BRAKE's privacy principle of any financial source.
- **Reliability.** High for covered accounts.
- **Dedup keys.** FinanceKit `id` (UUID, internal to FinanceKit) and `accountID`; amount + `transactionDate` + `merchantName` for joins with other sources.
- **BRAKE observation.** `money_movement{stage: authorized→pending→posted mapped from status, mcc, merchant_raw: originalTransactionDescription, merchant_display: merchantName, ...}`. Confidence is high.
- **Provenance sentence.** "From your Apple Card activity in Apple Wallet (shared with BRAKE on this iPhone)."
- **Recommendation: next.** Apply for the entitlement during the MVP phase, and ship it in MVP for US/UK iPhone users if it is granted in time. It is the only way to give an iPhone user some automatic transaction awareness without an aggregator.

#### A9. `open-banking-ais` — UK/EU account information services (Emma, Snoop, Plum, Moneyhub, Yolt)

- **Prior art and lessons.**
  - Emma and Snoop proved that subscription finding and proactive, specific tips drive engagement (unverified).
  - Snoop's acquisition by a credit-card lender, and the closure of ING's Yolt consumer app in 2022, repeat the pattern that a PFM alone does not pay for itself (unverified).
  - On the infrastructure side, **GoCardless Bank Account Data, popular with hobbyist and indie PFMs, stopped accepting new accounts from July 2025**; existing accounts continue [38]. Actual Budget added Enable Banking as an alternative, marked experimental [40].
- **Data.** Account and transaction endpoints: booking date, value date, amount, currency, remittance information, transaction IDs (field names vary by provider; unverified here).
- **Windows.** POST-SPEND; pending items are available at some banks.
- **Access.** An FCA-authorized or registered AISP, or an agent of one; or an EU PSD2 AISP (unverified). Periodic re-consent rules apply; the UK relaxed 90-day re-authentication in 2022 (unverified).
- **Dedup keys.** Provider `transactionId` where present; `entryReference` (unverified).
- **Provenance sentence.** "Matched with your Barclays transaction via open banking (TrueLayer)."
- **Recommendation: next.** It complements FinanceKit for UK users and is the primary financial source for EU users. Build on multiple providers because providers do exit (the GoCardless case).

#### A10. `bank-native-spend-insights` — Monzo, Revolut, Starling as competitors and UX benchmarks

- **Lessons.**
  - Instant notifications with a clean merchant name, logo and category set user expectations for every post-spend message (unverified).
  - "Pots"/"Spaces" exploit mental accounting and are widely liked (unverified).
  - Gambling blocks with delayed reversal are a proven commitment device (unverified).
  - Starling's AI "Spending Intelligence" (2025) normalizes conversational queries (unverified).
- **BRAKE access.** None directly. Monzo's developer API is meant for personal use only (unverified). BRAKE reaches these banks through notifications (A2), open banking (A9) and FinanceKit, which includes Monzo in the UK [16].
- **Provenance sentence.** "Detected from your Monzo notification."
- **Recommendation: avoid as a direct integration.** Benchmark the UX against these banks. They are competitors for "insight" but not for neutral, cross-bank pre-spend friction.

#### A11. `card-linked-offers-network` — Visa/Mastercard card-linked offers (Cardlytics, Dosh, Ibotta-style)

- **What it is.** Networks and issuers notify approved offer platforms when an enrolled card transacts at a participating merchant (unverified).
- **Lesson.** It gives near-real-time card data without bank credentials, but coverage is limited to participating merchants, and merchants pay because the programme increases spending. Dosh's consumer app was wound down (unverified).
- **Windows.** POST-SPEND, seconds to minutes (unverified).
- **Recommendation: avoid.** The merchant-funded model is structurally opposed to BRAKE's mission, and coverage is partial.

### B. In-spend control prior art

#### B1. `issuer-card-controls` — gambling blocks, category and merchant blocks, card toggles, virtual cards

- **Prior art.**
  - UK banks' gambling blocks are enforced at authorization by MCC. Several require a cooling-off period (e.g. 48 hours) before removal, which is a commitment device with delayed reversal (unverified).
  - Barclays-style category controls, Revolut card toggles and disposable cards, and Privacy.com merchant-locked, spend-limited virtual cards (unverified).
  - India: the RBI's 2020 card-security directions require issuers to let cardholders enable or disable online, international and contactless use and set limits (unverified).
  - Corporate spend cards (pre-approval before spend) show a "request, then approve" pattern (unverified).
- **What worked.** Effortless once set up, and it acts at authorization, the only true IN-SPEND hard stop. Users choose it themselves.
- **What failed.** It is MCC-coarse (miscoded merchants, gambling funded through e-wallets or crypto), all-or-nothing, and only covers that issuer's cards (unverified).
- **Windows and latency.** IN-SPEND (authorization, under a second).
- **Access.** Only an issuer or BaaS programme can apply these controls. A third party cannot.
- **BRAKE observation.** None directly. A `context` fact can record which controls the user has enabled ("user has enabled the gambling block at Monzo"), and decline notifications can be sensed through A2.
- **Provenance sentence.** "You turned on your bank's gambling block on 3 Sep (you told BRAKE)."
- **Recommendation: later** for an actual issuer or partner integration. **mvp** for an *assisted controls* feature: BRAKE explains the user's bank's own controls, deep-links to them where possible, and records the user's commitment.

### C. Pre-spend attention-friction prior art

#### C1. `ios-familycontrols-managedsettings` — Screen Time API shields (one sec, Opal, ScreenZen, Freedom)

- **Mechanism (verified).**
  - FamilyControls has **individual** authorization (the device owner approves with biometrics) on iOS 16+ [23][24]. Distribution requires requesting the `com.apple.developer.family-controls` entitlement from Apple [23].
  - `FamilyActivityPicker` lets users choose apps, web domains and categories **without revealing the choices to the app** [23].
  - ManagedSettings applies shields through `ManagedSettingsStore`, uses opaque `ApplicationToken`/`WebDomainToken`, and offers a `ShieldConfigurationDataSource` UI plus `ShieldActionDelegate` [25].
  - The system **does not give the shield action handler the name of the shielded app or domain**, only a token [27]. Handler responses are `.close` ("close the current application or web browser"), `.defer` and `.none` [28].
  - DeviceActivity monitors schedules (e.g. "after 22:00") and usage thresholds through a `DeviceActivityMonitor` extension, and reports through a sandboxed report extension [29].
- **Prior art and lessons.**
  - one sec: a deliberate breathing pause, then "continue or close". A 2023 PNAS field study reported large reductions in app openings, with users frequently deciding not to continue (unverified figures; the DOI fetch was blocked).
  - Opal: scheduled sessions, including "Deep Focus" that cannot be ended early (unverified).
  - ScreenZen: escalating wait times and limits on daily opens (unverified).
  - **What worked:** friction that is short, user-chosen, skippable and reflective ("do you still want to?") rather than prohibitive.
  - **What failed:** rigid blocks lead to uninstalls; Screen Time API reliability complaints; paywalls on the core function (all unverified).
  - **What none of them do:** use any financial context, or learn which launches lead to regretted purchases.
- **Data.** `app_context{token (opaque), user_group_label ("shopping apps", "food delivery"), event: shield_shown|continued|closed, schedule_id, timestamp}`.
- **Windows and latency.** PRE-SPEND, at launch time (under a second).
- **Coverage.** iOS and iPadOS 16+ for individual authorization, all countries.
- **Access.** Apple distribution entitlement approval [23]. Whether Apple accepts a *spending-friction* use case was not verified.
- **Privacy.** BRAKE never learns app identities unless the user labels groups, which is better privacy than any finance source. The trade-off is that personalization works per user-defined group, not per app.
- **Reliability.** Medium (unverified field reports).
- **Dedup keys.** Not applicable (context, not a transaction). It links forward to `purchase_intent` within a horizon.
- **BRAKE observation.** `app_context` (context class, never founds a candidate). It is a weak prior for "a purchase may follow within N minutes" and must never be shown as a spend.
- **Provenance sentence.** "You asked BRAKE to pause before opening the shopping apps you picked; this pause appeared at 23:12."
- **Recommendation: mvp.** This is the most direct prior-art-validated pre-spend mechanism. It works with zero financial data (brief's User C) and in every country. Apply for the entitlement immediately and prepare the Shortcuts fallback (C3).

#### C2. `android-app-launch-detection` — UsageStats or Accessibility-based launch interception

- **Mechanism.** `UsageStatsManager` needs `PACKAGE_USAGE_STATS`, which users grant under Settings → Special app access → Usage access, and exposes foreground events such as `ACTIVITY_RESUMED` [35]. Interception is then done with an overlay or by bringing BRAKE to the front. Alternatively, an AccessibilityService can observe window changes; Play requires a declaration and prominent disclosure for non-accessibility use (unverified).
- **Prior art.** one sec and ScreenZen on Android, and Digital Wellbeing (unverified).
- **Windows and latency.** PRE-SPEND. Under a second with accessibility; about 1 second with usage-stats polling (unverified).
- **Privacy.** Usage access reveals app-usage history, so it is medium sensitivity. Accessibility can read screen content, so it is high sensitivity and BRAKE should avoid it unless it is strictly needed.
- **Provenance sentence.** "You asked BRAKE to pause before opening Flipkart; this pause appeared at 23:12."
- **Recommendation: next.** Use the usage-access route first; treat Accessibility as research because of policy risk.

#### C3. `ios-shortcuts-app-open-automation` — Personal Automation fallback

- **What it is.** The user creates a Shortcuts automation, "When <app> is opened → run a BRAKE App Intent". This was one sec's original approach before Screen Time API support (unverified).
- **Pros.** No special entitlement.
- **Cons.** Manual setup per app, possible banners, and the user can silently remove it (unverified).
- **Recommendation: research.** Keep it as a fallback if the FamilyControls entitlement is delayed or denied.

#### C4. `browser-extension-checkout` — checkout detection and purchase delay in the browser

- **Prior art.**
  - Delay tools: Icebox-style "put it on ice" extensions, and Impulse-Blocker-style site blockers (unverified).
  - Shopping extensions: Honey, Capital One Shopping and Rakuten proved that cart and checkout pages can be detected across thousands of merchants. The same category produced the biggest trust incidents: Honey's affiliate-cookie allegations (2024) and Avast/Jumpshot selling browsing data (FTC, 2024) (unverified).
- **Data.** Merchant domain, page type (product, cart, checkout, confirmation), cart total, currency, line items, and order ID on the confirmation page.
- **Windows and latency.** PRE-SPEND (product and cart), IN-SPEND (checkout, the best timing for an interstitial), POST-SPEND (confirmation), all within about a second.
- **Coverage.** Desktop Chrome, Edge, Firefox and Safari; Safari Web Extensions on iOS and iPadOS (unverified version). Chrome on Android does not support extensions (unverified).
- **Access.** Store review; host permissions should be limited to an allow-list of merchants. Chrome Web Store affiliate-ads policy tightened in 2025 (unverified).
- **Privacy.** High (browsing). Process on-device, act only on allow-listed merchant domains, and never collect browsing history.
- **Dedup keys.** Merchant order ID (confirmation page); amount + time with `money_movement` (Δt ≤ 1h per the fusion doc).
- **BRAKE observation.** `checkout{merchant_domain, total, currency, items[], page_type, order_id?}`. Confidence is high for the cart total and medium for completion until confirmation.
- **Provenance sentence.** "Seen on the checkout page of amazon.in in your browser (BRAKE extension)."
- **Recommendation: next.** It is the only mechanism with genuine IN-SPEND timing for online purchases outside India's UPI. BRAKE must never inject affiliate links or coupons.

### D. Communication and receipt prior art

#### D1. `gmail-api` — email receipt and order parsing (Slice/Unroll.me, Paribus, Earny, Edison)

- **Prior art and lessons.**
  - Slice and Unroll.me parsed receipts at scale, and their aggregated purchase panels reached third parties. Lyft-receipt data reaching Uber was reported in 2017, and the FTC took action against Unroll.me in 2019 (unverified).
  - Paribus and Earny used receipts to claim price-drop refunds, gaining broad mailbox access for narrow value (unverified).
  - Google subsequently tightened restricted Gmail scopes, which require security assessments (unverified here; the email stream owns this).
  - **What worked:** item-level meaning (what was bought), order numbers, renewal and trial notices.
  - **What failed:** the business model (data panels) and over-broad scopes.
- **Data.** `order{merchant, order_id, items[], subtotal, tax, shipping, total, payment_hint ("Visa ••1234"), order_date}`; `subscription_event{renewal_date, price, trial_end}`; `refund_notice`; `delivery`.
- **Windows and latency.** POST-SPEND (minutes) and PRE-SPEND (renewal warnings, trial ending).
- **Privacy.** Very high. Use sender allow-lists, local or ephemeral processing, and persist extracted facts only (the brief requires this).
- **Dedup keys.** Merchant order ID; amount + date + payment last-4.
- **Provenance sentence.** "Matched your bank transaction with an Amazon order confirmation email."
- **Recommendation: next.** It has the highest semantic value of any source, but carries a heavy compliance load. Prior art says: never monetize it.

#### D2. `receipt-photo-ocr` — receipt photo capture (Fetch, Ibotta, Expensify-style)

- **Prior art.** Fetch and Ibotta showed users will photograph receipts or link eReceipts and loyalty accounts for an immediate reward (unverified). Their revenue comes from brands funding offers, which conflicts with BRAKE (unverified).
- **Data.** Merchant, date and time, total, tax, line items, payment last-4, receipt or invoice number (in India, GSTIN may appear; unverified).
- **Windows.** POST-SPEND; user-initiated, so latency is whenever the user acts.
- **Privacy.** Medium. BRAKE should use on-device OCR and discard the image after extraction by default.
- **Dedup keys.** Receipt number, amount + timestamp + merchant, payment last-4.
- **BRAKE observation.** `receipt{...}`. OCR confidence is per field, and line items are medium confidence.
- **Provenance sentence.** "From the receipt photo you added on 4 Oct."
- **Recommendation: next.** The BRAKE payoff should be immediate: split a mixed basket into essential and discretionary items. No points economy.

#### D3. `merchant-order-history-import` — retailer order history (e.g. Amazon/Target matching)

- **Prior art.** Some US PFMs added Amazon and Target order matching through user-run extensions or exports (unverified).
- **Windows.** POST-SPEND, in batches.
- **Dedup keys.** Order ID.
- **Provenance sentence.** "Matched with your Amazon order history you imported."
- **Recommendation: research.** It is useful for splitting large marketplace charges, but retailer terms of service and page fragility need checking.

### E. Manual, conversational and learning mechanisms

#### E1. `manual-entry` — manual transaction entry

- **Prior art.** YNAB (manual-first), Spendee, Money Manager and Actual Budget (unverified apart from Actual [36]). Manual entry works only for highly committed users and for cash.
- **Windows.** POST-SPEND, or planned spending recorded in advance.
- **Provenance sentence.** "You entered this on 4 Oct."
- **Recommendation: mvp.** It is the floor of graceful degradation and must be fast (amount + optional merchant). It must never be required.

#### E2. `manual-purchase-check` — "Should I buy this?" (share sheet, pasted URL, screenshot, voice, chat)

- **Prior art.** Cleo-style chat, Starling's conversational spending Q&A, and Origin-style AI advice (unverified), plus wishlist and "30-day rule" cooling-off tools (unverified). Chat engages users, but conversational finance advice carries accuracy and regulatory weight (unverified).
- **Data.** `purchase_intent{item, price, currency, merchant?, url?, planned?: bool}`.
- **Windows.** PRE-SPEND, initiated by the user.
- **Privacy.** Low. The user volunteers the data.
- **Provenance sentence.** "From the product you shared to BRAKE at 21:40."
- **Recommendation: mvp.** It is universal across countries and platforms and a direct expression of BRAKE's purpose. Pair it with an optional "remind me in N days" cooling-off.

#### E3. `notification-quick-action-labeling` — one-tap labeling from the notification

- **Platform fact.** Android notifications allow **up to three action buttons**, plus direct reply via `RemoteInput` [34]. That fits "top-2 predicted labels + Other…".
- **Prior art.** Copilot's review queue and YNAB's approve flow show the two extremes: a light review ritual versus exhaustive approval (unverified).
- **Windows.** POST-SPEND, seconds after detection, or batched.
- **Provenance sentence.** "You labeled this 'Work' from a notification."
- **Recommendation: mvp.** Ask only when uncertainty is high (as the brief requires), with a daily cap and a batch review queue as the fallback.

#### E4. `regret-feedback-prompt` — sparse "still happy you bought it?" check-ins

- **Prior art.** I could not identify (or verify) any mainstream PFM that runs systematic satisfaction or regret prompts. Products focus on categories and budgets, which is a gap. Cleo's "roast" tone shows that tone can be playful, but shame-based framing carries ethical risk (unverified).
- **Windows.** POST-SPEND, 24–72h later.
- **Provenance sentence.** "You told BRAKE on Monday that you regret this purchase."
- **Recommendation: mvp (sparse).** It is BRAKE's core differentiator for personalizing friction. Limit it to a few prompts a week and use neutral wording.

#### E5. `subscription-detection` — recurring and subscription intelligence

- **Prior art.** Rocket Money (detection, cancellation concierge, negotiation), Emma, Snoop and Copilot's recurrings (unverified). In India, UPI AutoPay and e-mandates send pre-debit notices (unverified). The FTC's 2024 "click-to-cancel" rule was vacated in 2025 (unverified), which leaves cancellation friction largely to the market in the US.
- **Windows.** PRE-SPEND (renewal upcoming), POST-SPEND (charged).
- **Provenance sentence.** "Netflix charged you on the 5th for the last 4 months (from your bank notifications)."
- **Recommendation: next.** It is derived from fused data and needs no new sensor. Do not adopt success-fee monetization tied to savings claims without careful disclosure.

---

## Three-window classification

| Source / mechanism | Pre-spend | In-spend | Post-spend | Latency | Notes |
|---|---|---|---|---|---|
| `india-sms-bank-alerts` | Partial (bill and mandate reminders) | — | **Yes** | Seconds–minutes | Play declaration and policy risk [9]–[11]; India, Android |
| `android-notification-listener` | Partial (mandate notices) | Research (OTP arrival only, no content) | **Yes** | Seconds | Android 15 OTP redaction [32] |
| `india-account-aggregator` | — | — | **Yes** (posted) | Minutes–hours (U) | Reconciliation backbone (IN) |
| `upi-payment-app-analytics` | — | Only inside the PSP app | Yes (in-app only) | n/a | No third-party API (U) |
| `upi-intent-url` | **Yes** | **Yes** | Weak (return status) | <1 s | User routes the payment through BRAKE |
| `plaid-transactions` | — | — | **Yes** | Hours–1 day | US/CA; cost (U) |
| `simplefin-bridge` | — | — | Yes | ~24 h [39] | User-paid, ≤90 days [39] |
| `apple-financekit` | — | — | **Yes** | On-device; background ≤1 h (iOS 26) [21][22] | US/UK only [16] |
| `open-banking-ais` | — | — | **Yes** | Minutes–hours (U) | Provider exits happen [38] |
| `bank-native-spend-insights` | — | — | Benchmark only | n/a | Competitor; reached via A2/A8/A9 |
| `card-linked-offers-network` | — | — | Partial | Seconds–minutes (U) | Merchant-funded; avoid |
| `issuer-card-controls` | — | **Yes** (authorization) | — | <1 s | Issuer-only; BRAKE assists |
| `ios-familycontrols-managedsettings` | **Yes** | — | — | <1 s | Entitlement [23]; opaque tokens [27] |
| `android-app-launch-detection` | **Yes** | — | — | ~0–1 s (U) | Usage access [35] |
| `ios-shortcuts-app-open-automation` | **Yes** | — | — | ~1 s (U) | User setup |
| `browser-extension-checkout` | **Yes** | **Yes** | Yes (confirmation) | <1 s | Desktop and Safari |
| `gmail-api` | Yes (renewals, trials) | — | **Yes** | Minutes | Restricted scope (U) |
| `receipt-photo-ocr` | — | — | **Yes** | User-paced | On-device OCR |
| `merchant-order-history-import` | — | — | Yes | Batch | Research |
| `manual-entry` | Yes (planned) | — | **Yes** | User-paced | Floor of degradation |
| `manual-purchase-check` | **Yes** | Yes (in-store) | — | Immediate | Universal |
| `notification-quick-action-labeling` | — | — | **Yes** | Seconds | ≤3 actions on Android [34] |
| `regret-feedback-prompt` | Feeds future pre-spend | — | **Yes** | 24–72 h | Sparse |
| `subscription-detection` | **Yes** (renewals) | — | Yes | Derived | No new sensor |

---

## Implications for BRAKE architecture

### The gap BRAKE fills

The landscape splits into four camps, and none of them closes BRAKE's loop:

1. **Retrospective ledgers** (Mint, Copilot, Monarch, YNAB, Emma, Snoop, Indian SMS/AA trackers). They are rich in context but act POST-SPEND, from hours to a day late in the US/UK/EU. Their main intervention is a budget bar or a monthly review.
2. **Owners of the payment moment** (banks, neobanks, UPI apps). They have IN-SPEND position and real-time data, but their incentives are mixed (interchange, credit, transaction volume), and they only see their own rails and instruments.
3. **Attention-friction apps** (one sec, Opal, ScreenZen, Freedom). They have proven PRE-SPEND behavior mechanics and privacy-preserving OS hooks [23]–[29], but know nothing about money, regret or budgets.
4. **Receipt, email and rewards platforms** (Fetch, Ibotta, Slice, Honey). They have the best item-level meaning, but are funded by parties who want more spending.

**BRAKE's position:** a neutral, cross-rail, cross-country layer that uses *friction-app mechanics* calibrated by *ledger-grade context* and *personal regret history*, with *provenance visible in the UI*, and *no lending, affiliate or data-panel revenue*. In one line: "one sec for spending, informed by your own regret history, explaining how it knows."

### Anti-patterns to avoid (with the prior art that teaches each)

1. **Credit or lead-gen monetization of sensed data.** Walnut→axio [6][8]; Fi's lending-led model [12]; Mint's ads and referrals [3]; Snoop under a lender (U). A tool that earns when you borrow or buy cannot credibly help you spend less.
2. **Data-panel resale or repurposing.** Unroll.me/Slice, Yodlee, Avast/Jumpshot (U). This is already prohibited on iOS by 5.1.2(i)–(iii) [30].
3. **Affiliate injection in browser extensions.** Honey (U). BRAKE's extension must never touch cookies, coupons or affiliate parameters.
4. **Single-sensor or single-vendor dependence.** Play's 2019 SMS policy [9]; the GoCardless signup closure [38]; Fi's bank-partner exit [12].
5. **Counting transfers, card bill payments and refunds as spending.** This is a well-known PFM complaint (U) and the brief calls it trust-destroying. Reconciliation must run before any "you spent" message.
6. **Exhaustive labeling.** YNAB-style "approve every transaction" fatigue (U). Ask only when uncertain, within three actions [34].
7. **Hard blocks without an exit, or blocks on essentials.** Strict friction modes drive uninstalls (U). Medicine, groceries and bills must never be shielded by default.
8. **Shame-based tone.** "Roast" humor is opt-in at best. The brief forbids scolding.
9. **Cancellation dark patterns and opaque fees.** The Cleo FTC case (U). BRAKE's own subscription must be one-tap to cancel.
10. **"You spent ₹500" notifications.** No insight means no message (brief). Banks already send the raw alert.

### Adapter design notes (lessons turned into requirements)

- **Data-flow manifest per adapter.** Each `SignalSource` adapter declares, machine-readably:
  - the fields it reads;
  - the fields it persists;
  - where processing happens (`on_device` | `ephemeral_server` | `server`);
  - retention, and whether raw payloads ever leave the device;
  - its third-party recipients (must be empty).

  The UI's "How did BRAKE know this?" view and the privacy page render from this manifest, so a commitment like "we never sell data" becomes inspectable.
- **Parser packs as versioned data, not code.** SMS, notification and email templates (the Walnut problem) ship as signed, versioned rule packs with per-sender coverage tests. The `transaction-sms-parser` field set [43] is a reasonable minimum schema. Parsing failures should produce "unparsed alert from HDFC" observations with low confidence rather than silent drops.
- **Multi-provider routing per institution.** Aggregator adapters (Plaid, MX, open-banking providers, SimpleFIN) sit behind an `InstitutionRouter` that can fail over per bank (the Monarch pattern, U). The capability registry records provider × institution health. This was proven necessary by the GoCardless closure [38] and by Actual's five-provider set [37].
- **Separate `InterventionSurface` adapters from `SignalSource` adapters.** Prior art shows that sensing and intervening are different capabilities:
  - FamilyControls can intervene but senses almost nothing [27];
  - Plaid senses but cannot intervene;
  - a browser extension can do both.

  Each surface declares `{timing: pre|in|post, can_delay, can_block, can_overlay, exit_path, latency_ms, requires_entitlement}`.
- **Friction ladder keyed on confidence and personal regret score.** The levels are: nothing → quiet context line → skippable pause (one-sec style) → reflective question → user-pre-committed delay with timed reversal (gambling-block style). A strong step requires both high confidence and a user-chosen commitment.
- **Commitment with delayed reversal is a user setting, never a default.** It is modeled on bank gambling blocks (U). Store it as a `user_rule` with `unlock_delay`.
- **Labeling channel.** A max-3-action notification payload (top-2 predictions + "Other…") [34]; a batch review queue (the Copilot pattern, U); a per-day prompt budget; learning a rule from each correction.
- **Regret signal store.** `satisfaction{candidate_id, value, asked_at, delay_h}` feeds a per-user model of which contexts lead to regret (merchant group × time of day × amount band × launch-via-shield). That model drives the friction ladder.
- **Opaque-token constraint on iOS.** BRAKE cannot know which app a shield covered [27]. Ask users to build separate selections ("shopping", "food delivery", "quick-commerce") so each token group carries a user-assigned label.
- **FinanceKit sync.** Use `transactionHistory(...since: HistoryToken)` for incremental sync [20]. Use background delivery at `hourly` on iOS 26+ [21][22], with a foreground refresh on app open. Map `TransactionStatus` (`authorized`/`pending` → `pending`; `booked` → `posted`; `rejected` → cancel the candidate; `memo` → context) [19].

### Normalization pitfalls seen in prior art

- **Transfer vs spend.** Card bill payments, self-transfers, wallet loads and investments recorded as "spend" (generic PFM complaint, U). AA `mode`/narration and Plaid categories are hints, not truth (U).
- **Pending to posted amount changes** (tips, fuel and hotel holds). Handled by the fusion doc's ≤30% growth rule. FinanceKit makes this explicit through `status` [19].
- **Merchant strings.** `originalTransactionDescription` versus `merchantName` [18]; UPI VPAs versus brand names; marketplace aggregation (a single "AMAZON" charge containing several categories, which is the reason D1 and D2 matter).
- **Duplicate observations from one device.** The SMS app notification and the bank-app notification for the same debit. Same-connection veto rules must treat these as different connections (A1/A2) but still merge them on RRN.
- **Category taxonomies differ** across sources: Plaid PFC, MCC (ISO 18245 in FinanceKit [18]), bank categories, BRAKE categories. Keep the source category as evidence and never overwrite it.
- **Recurring false positives.** Same-amount coffees are not a subscription. Require a period and a merchant-identity match.
- **Signals that are context, not transactions.** App launches (C1/C2), cart views (C4) and renewal notices (D1) must never be shown as spends.

### Capability-registry facts by country and platform (from this stream)

| Country / platform | Capability | Status | Source |
|---|---|---|---|
| US (iOS 17.4+) | `apple-financekit` (Apple Card, Apple Cash, Savings) | available (entitlement) | [16] |
| GB (iOS 18.4+) | `apple-financekit` (13 named banks via Wallet open banking) | available (entitlement) | [16] |
| All other countries | `apple-financekit` | unavailable (eligibility limited to US/UK App Store distribution) | [16] |
| iOS 26+ | `apple-financekit-background-delivery` | available (hourly/daily/weekly) | [21][22] |
| iOS 16+ (all countries) | `ios-familycontrols-managedsettings` (individual authorization) | available (distribution entitlement) | [23][24] |
| Android 15+ | `android-notification-listener` | limited (OTP-bearing notifications redacted for untrusted listeners) | [32] |
| Android (Play) | `android-sms-read` | limited (default handler or approved declaration) | [9][10][11] |
| Android | `android-notification-actions` | available (≤3 buttons + RemoteInput) | [34] |
| Android | `android-usage-stats` | available (special "Usage access" grant) | [35] |
| IN | `india-sms-bank-alerts` | available / common | [8], brief |
| IN | `fintech-on-partner-bank` | limited (Fi banking front-end wound down 2026) | [12] |
| GB/EU | `gocardless-bank-account-data` | limited (no new accounts since July 2025) | [38] |
| US | `simplefin-bridge` | available (user-paid, daily, ≤90 days) | [39] |
| US | `mint` (free ad-supported PFM incumbent) | unavailable (shut down by 2024-03-23) | [1][4] |
| NZ / BR | `akahu` / `pluggy-ai` (bank sync in Actual) | available (country mapping unverified) | [37] (U) |
| IN | `issuer-card-controls` (online/intl/contactless toggles) | available (U) | (U) |
| GB | `bank-gambling-block` | available at many banks (U) | (U) |
| US | `cfpb-1033-open-banking` | unknown as of 2026-10 (U) | (U) |

### Business-model guardrails that must be architectural

- There is no code path from observations to any third-party sink other than user-initiated export. Enforce this with adapter manifests and CI checks.
- Do not build lending, affiliate or offer modules that consume sensed data. If BRAKE ever adds partner features, they must run on user-initiated input only.
- Prefer on-device inference. This lowers server cost, which in turn lowers the pressure to monetize data. Mint shows that a free PFM with server-side aggregation costs ends up depending on a lead-gen model [3].

---

## Risks, policy constraints and ethical concerns

- **Platform policy shocks.**
  - Play SMS/Call Log in 2019 [9]–[11] is the precedent.
  - Android 15 OTP redaction [32] shows Google is still tightening notification access.
  - The FamilyControls and FinanceKit entitlements are discretionary [17][23]; Apple may not view "spending friction" as a valid Screen Time use (unverified).
  - Apple guideline 5.1.1(ix) requires financial apps to be submitted by a legal entity [30].
  - Chrome Web Store policy changes affect extensions (U).
- **Regulatory.**
  - India: AA access requires regulated status or a partner (U); the DPDP Act 2023 and its rules (U); RBI digital-lending restrictions on access to phone resources, if BRAKE ever touches credit (U).
  - US: the §1033 rule's status in 2026 is unresolved (U); FTC Section 5 precedents on deceptive data practices and cancellation (Unroll.me, Cleo; U).
  - UK/EU: AISP authorization and GDPR (U).
- **Ethics.**
  - Paternalism and autonomy: always provide an exit path. The one-sec model is "continue anyway".
  - Shame: no scolding, roast-mode or guilt loops.
  - Vulnerable users: compulsive buying, gambling and debt. Friction may displace spending to other channels. Offer resources and do not over-promise.
  - Essentials: never shield pharmacy, groceries or bills by default.
  - Regret loop: cap prompts so the product does not become obsessive tracking.
  - Surveillance creep: do not collect context just because it is available (the brief requires this).
  - AI advice accuracy: conversational "Should I buy this?" answers must be framed as reflection, not financial advice (U on regulatory boundaries).
- **Trust.** One data-monetization incident would end BRAKE. Prior art shows trust losses are permanent and well publicized (U).
- **Competitive.** Apple, Google, banks or UPI apps could ship native "pause before purchase" features. BRAKE's defensibility rests on cross-source fusion, personal regret modeling, neutrality and transparency, not on any single hook.
- **Commercial.** PFM economics are fragile: Mint [3], Maybe [42], Yolt (U), Fi [12]. Willingness to pay for subscriptions is untested in India (U). App-store fees apply.

---

## Open questions

1. Will Apple grant the FamilyControls distribution entitlement for shielding shopping and food-delivery apps to reduce *spending* rather than screen time? Is there a published review criterion?
2. Will Apple grant the FinanceKit entitlement to an app whose primary feature is pre-spend friction? Does BRAKE's spending-trends and budgeting functionality satisfy the eligibility wording [16]?
3. Is the Google Play "SMS-based money management" exception still in the 2026 permissions policy, and what does review require?
4. Does app-launch friction measurably reduce *purchases*, not just app opens? No RCT on spending outcomes was found (unverified absence). BRAKE should plan its own holdout measurement.
5. Can the iOS `ShieldConfigurationDataSource` read App Group data to show financial context (such as weekly food-delivery pace) on the shield itself?
6. What is the realistic AA access path for a non-lending, non-regulated PFM in India in 2026, and what does it cost?
7. Will Indian PSP apps accept `upi://pay` hand-offs from a third-party scanner for P2M QR codes without warnings or limits?
8. What is the 2026 status of CFPB §1033, and how does it change aggregator costs for US PFMs?
9. Is there evidence (academic or industry) that delayed "worth it?" prompts improve later decisions without lowering satisfaction or causing guilt?
10. Would UK banks with gambling-block experience partner on user-configurable, BRAKE-aware authorization controls?
11. Which business model has kept a *non-credit* PFM sustainable outside the US? Fold's model and outcome are unverified.
12. Will Android 17+ extend notification redaction from OTPs to financial notifications generally?

---

## References

### Consulted in this session

Pages marked "search summary" were read only through the WebSearch result summary, because direct fetches were blocked. Pages marked "fetched" were read directly.

1. https://www.cnbc.com/2023/11/07/budgeting-app-mint-is-shutting-down-users-are-disappointed.html — search summary. Mint shutdown announced November 2023; "the peril of relying on free services".
2. https://www.rocketmoney.com/learn/personal-finance/mint-app-shutting-down — search summary (competitor-authored). Mint closure timeline.
3. https://wallethub.com/edu/b/what-happened-to-mint/151868 — search summary. Mint earned from ads and referral fees like Credit Karma; Credit Karma was the larger ad vehicle; Credit Karma lacks budgeting and month-over-month trends.
4. https://spendify.money/blog/mint-shut-down-now-what/ — search summary. Mint shut down 2024-03-23.
5. https://finary.com/en/product-updates/mint-is-shutting-down-what-you-need-to-know — search summary. Mint shutdown context.
6. https://tracxn.com/d/companies/walnut/__CFKIACm2_n1CdHvWMGO6QBpqzGGN8o0uIFUJ70An7uo — search summary. Walnut acquired 2018-08-14.
7. https://medium.com/@anurag.bits18/walnut-axio-and-business-of-lending-1e59205deade — search summary. Walnut/axio and the lending business; Capital Float acquisition (2018).
8. https://trackmyrupee.com/blog/trackmyrupee-vs-walnut-axio-vs-money-manager-which-expense-tracker-is-best-for-indians-in-2026/ — search summary (competitor marketing). Walnut is "India's most downloaded expense tracker", reads bank SMS, rebranded axio, expanded into BNPL, personal loans and FDs.
9. https://techcrunch.com/2019/01/18/google-pulling-unvetted-android-apps/ — search summary. Google removing apps using SMS/Call Log without an approved declaration.
10. https://android-developers.googleblog.com/2019/01/reminder-smscall-log-policy-changes.html — search summary (fetch blocked). The 2019 SMS/Call Log policy.
11. https://www.xda-developers.com/google-remove-unapproved-apps-use-call-log-sms-permissions/ — search summary. Default-handler requirement; 2019-03-09 deadline; 90-day window.
12. https://techcrunch.com/2026/03/11/india-neobank-fi-winds-down-banking-services-on-its-platform — search summary (fetch blocked). Fi winds down banking services; Federal Bank "business re-alignment"; FedMobile migration; more than 3.5M users; $168M raised; lending struggled.
13. https://finance.yahoo.com/news/india-neobank-fi-winds-down-221744130.html — search summary. Syndicated version of [12].
14. https://thepaypers.com/fintech/news/indias-fi-neobank-discontinues-banking-services-after-pivot-to-ai — search summary (title). "Pivot to AI".
15. https://www.newsbytesapp.com/news/business/fi-money-shuts-banking-services-for-35-million-users/tldr — search summary. Scale of users affected.
16. https://developer.apple.com/financekit/ — fetched. FinanceKit eligibility (Finance category, US/UK distribution, financial-management functionality); US iOS 17.4+ Apple Card, Apple Cash, Savings; UK iOS 18.4+ list of 13 institutions; balances and transactions; user controls accounts and time range; on-device.
17. https://developer.apple.com/tutorials/data/documentation/financekit.json — fetched. FinanceKit overview; managed entitlement; organization Account Holder; `NSFinancialDataUsageDescription`.
18. https://developer.apple.com/tutorials/data/documentation/financekit/transaction.json — fetched. `Transaction` properties.
19. https://developer.apple.com/tutorials/data/documentation/financekit/transactionstatus.json — fetched. `authorized`, `booked`, `pending`, `rejected`, `memo`.
20. https://developer.apple.com/tutorials/data/documentation/financekit/financestore.json — fetched. `transactions(query:)`, `transactionHistory(forAccountID:since:isMonitoring:)`, `HistoryToken`, background-delivery methods.
21. https://developer.apple.com/tutorials/data/documentation/financekit/financestore/enablebackgrounddelivery(for:frequency:).json — fetched. Background delivery, iOS 26.0+.
22. https://developer.apple.com/tutorials/data/documentation/financekit/financestore/updatefrequency.json — fetched. `hourly`, `daily`, `weekly` ("within an hour of data updating").
23. https://developer.apple.com/tutorials/data/documentation/familycontrols.json — fetched. Child and individual authorization; `com.apple.developer.family-controls`; distribution entitlement request; `FamilyActivityPicker` hides choices from the app.
24. https://developer.apple.com/tutorials/data/documentation/familycontrols/familycontrolsmember/individual.json — fetched. Individual authorization on iOS 16.0+.
25. https://developer.apple.com/tutorials/data/documentation/managedsettings.json — fetched. `ManagedSettingsStore`, shields, opaque tokens, iOS 15+.
26. https://developer.apple.com/tutorials/data/documentation/managedsettings/application.json — fetched. `Application{bundleIdentifier?, localizedDisplayName?, token?}`.
27. https://developer.apple.com/tutorials/data/documentation/managedsettings/shieldactiondelegate.json — fetched. The system does not provide the shielded app's or domain's name; tokens only.
28. https://developer.apple.com/tutorials/data/documentation/managedsettings/shieldactionresponse.json — fetched. Definitions of `.close`, `.defer` and `.none`.
29. https://developer.apple.com/tutorials/data/documentation/deviceactivity.json — fetched. Schedules, thresholds, sandboxed report extension.
30. https://developer.apple.com/app-store/review/guidelines/ — fetched. 5.1.1(ix) legal-entity requirement for banking and financial apps; 5.1.2(i) sharing limits; (ii) no repurposing; (iii) no surreptitious profile building.
31. https://developer.android.com/reference/android/service/notification/NotificationListenerService — fetched. Purpose of the class.
32. https://developer.android.com/about/versions/15/behavior-changes-all — fetched. OTP redaction for untrusted notification listeners; companion-device exemption.
33. https://developer.android.com/about/versions/16/behavior-changes-all — fetched. No notification-listener, SMS, overlay or usage-detection changes (as summarized).
34. https://developer.android.com/develop/ui/views/notifications/build-notification — fetched. Up to three action buttons; `RemoteInput` direct reply.
35. https://developer.android.com/reference/android/app/usage/UsageStatsManager — fetched. `PACKAGE_USAGE_STATS` via Usage access; foreground events.
36. https://github.com/actualbudget/actual — fetched. Local-first, MIT, about 29.3k stars.
37. https://github.com/actualbudget/actual/tree/master/packages/docs/docs/advanced/bank-sync — fetched. Bank-sync providers: Akahu, Enable Banking, GoCardless, Pluggy AI, SimpleFIN.
38. https://github.com/actualbudget/actual/blob/master/packages/docs/docs/advanced/bank-sync/gocardless.md — fetched. "From July 2025 onwards, GoCardless has stopped accepting new Bank Account Data accounts."
39. https://github.com/actualbudget/actual/blob/master/packages/docs/docs/advanced/bank-sync/simplefin.md — fetched. $1.50/month or $15/year; at most 90 days; updates about every 24h; upstream MX; one-time token.
40. https://github.com/actualbudget/actual/blob/master/packages/docs/docs/advanced/bank-sync/enable-banking.md — fetched. Enable Banking integration (experimental).
41. https://github.com/actualbudget/docs — fetched. Docs repo archived 2025-11-18 and merged into the main repo.
42. https://github.com/maybe-finance/maybe — fetched. Archived 2025-07-27; AGPLv3; v0.6.0; no longer maintained.
43. https://github.com/saurabhgupta050890/transaction-sms-parser — fetched. Regex-based Indian bank SMS parser; output fields; banks tested.
44. https://github.com/topics/expense-tracker — fetched. Open-source local-first tracker landscape (ezBookkeeping, BeeCount and others).

### Attempted but blocked (contents NOT used as evidence)

Fetching these domains failed with `EGRESS_BLOCKED`: pnas.org (one sec study DOI 10.1073/pnas.2213114120), ftc.gov, monzo.com, one-sec.app, copilot.money, consumerfinance.gov, plaid.com, developers.google.com, support.google.com, play.google.com, wikipedia.org, techcrunch.com, android-developers.googleblog.com. web.archive.org was also unreachable.

### Unverified-claims register (re-verify before relying on these)

| Claim | Where to verify |
|---|---|
| one sec PNAS 2023 effect sizes (reductions in app openings; share of users not continuing) | PNAS article (DOI above) |
| Cleo FTC settlement (~$17M, 2025) and its allegations | FTC press release |
| Unroll.me/Slice data reaching Uber (2017) and the FTC order (2019) | FTC case page; press archives |
| Honey affiliate-cookie allegations (Dec 2024); Chrome Web Store affiliate policy update (2025) | Chrome Web Store program policies; press |
| Avast/Jumpshot FTC order (2024) | FTC case page |
| Yodlee data-sale litigation; Plaid class-action settlement | Court dockets; press |
| Monzo gambling block 48h cooling-off; Starling "Spending Intelligence" (2025); Monzo developer API personal-use only | Monzo and Starling help pages |
| RBI 2020 card-control mandate; RBI e-mandate pre-debit notice; RBI digital-lending guidelines (2022) | rbi.org.in circulars |
| Play "SMS-based money management" exception; AccessibilityService declaration policy | Play Console Help |
| Product facts for Copilot, Monarch, YNAB, Rocket Money, Simplifi, Origin, Emma, Snoop, Plum, Yolt, Fold, Jupiter, CRED, Money View, ET Money, Fetch, Ibotta, Privacy.com, Icebox, Dosh | Vendor sites and press releases |
| FTC Negative Option ("click-to-cancel") rule vacated in 2025 | Court ruling; FTC |
| CFPB §1033 status as of 2026 | consumerfinance.gov |
| AA FI-schema field names; FIU access path | ReBIT / Sahamati / RBI |
