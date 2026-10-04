# Cards, card-linked services, issuers, wallets and neobank APIs as BRAKE signal sources

> **Stream:** 02 — Card feeds, card-linked services, issuer processors, wallets and neobank APIs.
> **Date / status "as of":** 2026-10-04. Every claim that depends on time is as of this date unless it says otherwise.
> **Scope:** Sources that expose *card* or *wallet* payment events to a third-party consumer app, plus the option of BRAKE issuing its own card to make decisions during authorization. Covered: Apple FinanceKit and Wallet Orders, Google Wallet, card-linked services (Fidel, card-network offer programmes, Cardlytics), issuer processors (Marqeta, Lithic, Stripe Issuing, Adyen Issuing), neobank personal APIs (Monzo, Starling, Up, Investec, Revolut, Wise, Nubank via Open Finance Brasil), wallet histories (PayPal, Venmo, Cash App, Paytm, PhonePe, Amazon Pay, GrabPay, GCash, M-Pesa) and app-store purchase receipts.
> **Out of scope (other streams):** Plaid, US §1033, India Account Aggregator, UK/EU open banking aggregators, Android notifications and SMS, email, and UPI intents. These are cross-referenced where they matter.
>
> **How this was researched, and its limits.** Primary sources were used wherever the research sandbox could reach them: Apple developer documentation (including its JSON documentation endpoints), WWDC session pages, and official vendor repositories on GitHub with OpenAPI specs or docs sources. The vendor repositories used were Monzo, Up, Revolut, Investec, Lithic, Stripe SDK, Adyen, Marqeta, PayPal, Fidel's docs repository, Open Finance Brasil and Visa. The web-search budget ran out partway through. Many vendor and regulator domains were also blocked by the egress proxy: docs.stripe.com, docs.lithic.com, marqeta.com, docs.adyen.com, developer.visa.com, developer.mastercard.com, cardlytics.com, docs.monzo.com, developer.starlingbank.com, developer.up.com.au, developer.investec.com, docs.wise.com, developer.paypal.com, developers.google.com, support.apple.com, consumerfinance.gov, rbi.org.in, npci.org.in, developer.safaricom.co.ke, fidelapi.com, astrada.co and sec.gov. Claims that could not be checked against a primary source in this session are marked **(unverified)**. Treat them as hypotheses to confirm before building.

### Key takeaways for BRAKE

1. **No card source in this stream gives BRAKE a universal, consented, real-time feed of all card spending to a third-party consumer app.** The fast feeds are either limited to one institution (Monzo, Up and Investec webhooks), limited to a set of merchants (Fidel Select only sees purchases "at locations in the program"), or only available if BRAKE becomes the issuer. Card data stays a *patchwork of adapters*, which confirms the brief's agnostic, capability-registry approach.
2. **Apple FinanceKit is the only iOS-sanctioned on-device feed of bank or card transactions, and it is worth pursuing for US and UK iPhone users.** It covers Apple Card, Apple Cash and Savings in the US (iOS 17.4+) and UK open-banking "connected" accounts in Wallet (iOS 18.4+). It needs a managed entitlement (`com.apple.developer.financekit`), an organization developer account and a Finance-category listing. Since iOS 26 a `BackgroundDeliveryExtension` can wake BRAKE at most about **hourly**, so FinanceKit is a POST-SPEND source, not an IN-SPEND one.
3. **Only an issuer-side authorization hook gives true in-spend decisioning.** Examples are Adyen relayed authorisation (2-second response window, then "your fallback logic"), Stripe Issuing `issuing_authorization.request`, Lithic Auth Stream Access and Marqeta Gateway JIT (with "Commando Mode" fallback). This requires BRAKE to issue a card through a BIN-sponsor bank or e-money institution, and that card only sees spending *on that card*. It is a high-cost, regulated path. Treat it as a "later" commitment-device product for a self-selected segment, not as the core.
4. **One cheap route to in-spend decisioning exists today without becoming an issuer: Investec Programmable Banking "Card Code"** (South Africa). The user's own card runs user-deployed JavaScript (`beforeTransaction(authorization)` returns `true` or `false`). It is a niche market, but it proves the "user-owned rules at the authorization point" pattern for the registry.
5. **Neobank personal APIs give near-real-time POST-SPEND events but cannot underpin a public product.** Monzo's API "is not suitable for building public applications" and allows only "your own account or those of a small set of users you explicitly allow". Up's API is beta and issues Personal Access Tokens only. Production access to these banks goes through regulated open banking (for example Revolut's Open Banking API requires a "regulated third party provider"). Classify these as "power-user / research" adapters.
6. **Card-linked offer infrastructure works against BRAKE's mission.** Fidel Select, card-network offer programmes and Cardlytics only cover enrolled or participating merchants. Their economics are merchant-funded incentives to *spend more*. BRAKE should not depend on them for coverage, and should not take offer revenue that conflicts with helping users spend better.
7. **Wallet histories (PayPal, Venmo, Cash App, Paytm, PhonePe, Amazon Pay, GrabPay, GCash, M-Pesa) have no consumer-consented third-party data APIs** that could be verified. PayPal's Transaction Search API is for the account owner, and third parties "must be part of the PayPal partner network". The practical signals for these wallets are their **notifications, SMS, emails and statement exports**, which other streams cover, and the matching debit in the funding bank or card account.
8. **App-store purchase data is first-party only.** StoreKit, the App Store Server API and Play Billing return only *your app's* purchases. Even `showManageSubscriptions(in:)` shows "the customer's currently active subscription for your app". Subscription detection must come from bank or card descriptors (for example `APPLE.COM/BILL`, **unverified** exact strings), App Store and Google Play receipt emails, and user confirmation.
9. **Brazil's Open Finance credit-card API is a valuable model for normalization.** It reaches Nubank customers through licensed participants. It exposes `payeeMCC`, an instalment structure (`chargeIdentificator` / `chargeNumber`), `billId` and a `transactions-current` endpoint with a 7-day window. BRAKE's schema should model **instalments and statement or bill membership** explicitly, not only single purchases.
10. **The adapter layer needs two kinds of interface.** Most sources need an *observation* interface (asynchronous, idempotent, able to reconcile pending and posted records). Issuer hooks need a separate *synchronous decision hook* with a hard deadline (about 2 seconds) and a fail-open default. Mixing the two would either put user payments at risk or slow the fusion layer down.

---

## Sources investigated

Each subsection uses the same template: **What it is · Data available · Windows & latency · Coverage · Access · Privacy & consent · Reliability & failure modes · Dedup keys · Normalized observation & confidence · Provenance sentence · Recommendation.**

### A. Apple ecosystem

#### A1. Apple FinanceKit: full-authorization queries (`apple-financekit`)

- **What it is.** An Apple framework that lets a finance app read financial data stored **on the device** by Apple Wallet: accounts, balances and transactions. Apple describes it as follows: "Information is retrieved directly from the on-device data store and never seen by Apple" [1].
- **Data available** (verified from Apple docs [3][10]):
  - `Transaction`: `id` (UUID; "unique per device as well", used to "track how a given transaction evolves over time"), `accountID`, `transactionDate`, `postedDate?`, `transactionDescription`, `originalTransactionDescription` (the raw institution text), `transactionAmount` (`CurrencyAmount`), `foreignCurrencyAmount?`, `foreignCurrencyExchangeRate?`, `creditDebitIndicator`, `transactionType`, `status`, `merchantName?` and `merchantCategoryCode?` (ISO 18245 MCC). Amounts are "stored as positive decimal values regardless of whether they're debit or credit" [10].
  - `TransactionStatus`: `authorized`, `pending`, `booked`, `rejected`, `memo` [4].
  - `TransactionType`: `adjustment`, `atm`, `billPayment`, `check`, `deposit`, `directDebit`, `directDeposit`, `dividend`, `fee`, `interest`, `loan`, `pointOfSale`, `refund`, `standingOrder`, `transfer`, `withdrawal`, `unknown` [5]. These help directly with the brief's *transfer vs spending* problem.
  - `Account` (an enum of `AssetAccount` or `LiabilityAccount`): `id`, `institutionName`, `displayName`, `accountDescription`, `currency`. Liability accounts add `creditLimit`, `nextPaymentDate`, `minimumPaymentAmount` and `overduePaymentAmount` [10].
  - `AccountBalance`: `available`, `booked` or `availableAndBooked`, plus `asOfDate`, `accountId`, `amount` and `creditDebitIndicator` [10].
  - Change feeds: `transactionHistory(forAccountID:since:isMonitoring:)` returns `inserted` / `updated` / `deleted` plus a Codable `HistoryToken` for resuming. History "can be compacted by the system", and Apple says the framework can still bring an app up to date without data loss [10]. FinanceKit "tries to preserve as is at least some months of history" [10]. The exact depth is not documented (**unverified**).
  - `interpretation of creditDebitIndicator` depends on the account type. On a liability account (credit card), a debit is "decrease in the available credit" [10]. A BRAKE normalizer must therefore branch on account type.
- **Windows & latency.**
  - *POST-SPEND:* yes. While BRAKE is in the foreground, a long-running `transactionHistory(..., isMonitoring: true)` query streams changes as Wallet receives them. In the background (iOS 26+), a `BackgroundDeliveryExtension` is launched with `didReceiveData([BackgroundDataType])` and `willTerminate`. Apps register through `FinanceStore.enableBackgroundDelivery(for:frequency:)` with `UpdateFrequency` set to `.hourly`, `.daily` or `.weekly` [6][7][11]. `.hourly` means "Get notified within an hour of data updating". After a delivery, "if data changes again within the interval, the next update won't happen until the interval has passed" [7]. Practitioners report that background requests "can be delayed, interrupted, duplicated, or arrive out of order" (secondary source, search snippet only [15]).
  - *IN-SPEND:* no. There is no callback during an Apple Pay authorization.
  - *PRE-SPEND:* only indirectly. Liability `nextPaymentDate` and `minimumPaymentAmount` plus balances give context (for example "card payment due in 3 days").
  - How fast Apple Card or Apple Cash transactions reach the Wallet store is not documented. For UK connected accounts, freshness depends on Wallet's open-banking refresh cadence (**unverified**; likely minutes to hours).
- **Coverage.** US: Apple Card (excluding Apple Card Family participants), Apple Cash (excluding children using Apple Cash Family) and Savings, iOS 17.4+. UK: open-banking connected accounts in Wallet, iOS 18.4+, from institutions including "Barclays, Barclaycard, First Direct, Halifax, HSBC, Lloyds, M&S Bank, MBNA, Monzo, Nationwide, NatWest, Royal Bank of Scotland, and Santander" [1]. No other country is listed as of 2026-10-04. The WWDC26 and iOS 27 materials that were checked mention Wallet order-tracking expansion, not FinanceKit expansion [13][14]. The API is iPhone-centric; check `FinanceStore.isDataAvailable(.financialData)` at runtime [2][10].
- **Access requirements** [1][2]:
  - Managed capability `com.apple.developer.financekit`, requested by the **Account Holder** of an **organization** developer account and granted **per bundle ID**.
  - The app must be "listed in the Finance category in App Store Connect and distributed through the App Store for iPhone in the United States or United Kingdom".
  - The app must "Provide financial management tools (for example, a comprehensive view of net worth, spending trends, budgeting)".
  - An app that also offers financial products must let customers connect accounts to Wallet and must not block FinanceKit sharing.
  - `NSFinancialDataUsageDescription` must be in Info.plist.
  - Apple reviews each request against criteria that are not fully public (**unverified**).
  - App Store Review Guideline 5.1.1(ix) says apps in "banking and financial services" "should be submitted by a legal entity", not an individual [16].
- **Privacy & consent.** Consent is granular. A system prompt is followed by account selection, and for each account the user chooses "the earliest activity that will be available to your app". Access can be changed or revoked in Settings [10]. The data never leaves the device unless BRAKE sends it. This fits the brief's "prefer local processing" principle very well.
- **Reliability & failure modes.**
  - Authorization status `.denied` or `.unknown`, or access revoked later.
  - History compaction.
  - Background windows controlled by iOS.
  - Apple Card programme changes. An issuer transition has been reported but was **unverified** in this session.
  - `id` is device-scoped, so the same transaction seen on two devices has different IDs.
  - A UK connected account may *also* be connected to BRAKE through an open-banking aggregator, which creates duplicate observations of the same event.
- **Dedup keys.** `Transaction.id` (stable on one device across status changes; use it for pending-to-booked updates); `accountID`; `(amount, currency, transactionDate, merchantName/originalTransactionDescription)` for cross-source matching; `foreignCurrencyAmount` for FX transactions.
- **Normalized observation & confidence.** `source_id=apple-financekit`, `kind=account_transaction`, `rail=card|bank` (inferred from account type), `status` mapped as `authorized|pending→pending`, `booked→posted`, `rejected→cancelled`, `memo→ignored/annotation`, plus `type_hint` from `transactionType` and `mcc`. Confidence: amount, currency and direction are **high** because they come from the institution of record. Merchant identity is **medium** (`merchantName` is optional). Timing is **high** for `transactionDate`, but the *arrival* latency for BRAKE is low-grade.
- **Provenance sentence.** "Read on your iPhone from your Apple Card activity in Wallet (shared with BRAKE through Apple FinanceKit)." / "From your Barclays account connected in Apple Wallet."
- **Recommendation: `next`** for US and UK iOS. Apply for the entitlement early because approval is gated. It strengthens "User B" (iPhone + US) and covers UK iPhone users without a separate aggregator contract. It is not `mvp` because of the entitlement uncertainty, its US/UK-only reach, and the fact that it is not real-time.

#### A2. FinanceKit Transaction Picker (`apple-financekit-transaction-picker`)

- **What it is.** `TransactionPicker` (FinanceKitUI, iOS 18.0+) is a system UI in which the user picks one or more Wallet transactions to hand to the app [9]. Apple says it "has fewer requirements for your app" and that "access to the shared transactions is ephemeral… the picker will not remember or store any of the transactions shared" [10].
- **Data.** The same `Transaction` struct as A1, but only for the transactions the user selects.
- **Windows.** POST-SPEND, driven by the user, for example "Explain this purchase" or "Mark as regretted". Latency is immediate once the user acts.
- **Coverage / access.** Same countries and accounts as A1. Whether the picker needs the full FinanceKit entitlement is **unverified**; Apple's wording suggests fewer requirements.
- **Privacy.** The narrowest possible consent: one transaction at a time, initiated by the user.
- **Dedup keys / observation.** Same as A1. Mark `user_verified=true` for the user-selected link ("this card charge is the thing I'm asking about").
- **Provenance.** "You picked this transaction from Apple Wallet."
- **Recommendation: `next`**, as a low-friction complement to manual entry on US/UK iPhones, and as a fallback if the full-access entitlement is refused.

#### A3. Apple Wallet Orders / order tracking (`apple-wallet-orders`)

- **What it is.** Merchants create, sign and update **Wallet order packages**. They attach them to an Apple Pay payment result or distribute them through a web service, and Wallet shows order and shipping status [12]. Apple says that since iOS 26, "Using the power of Apple Intelligence, Wallet can now … detect order emails in the Mail app, automatically convert them into Wallet orders" [11][13].
- **Data (merchant to Wallet).** `orderIdentifier`, `orderNumber`, `merchant`, `payment`, `lineItems`, `fulfillments`, `status` [12].
- **Can BRAKE read it? No.** FinanceKit exposes `saveOrder(signedArchive:)` to *add or update* an order, and `FullyQualifiedOrderIdentifier`. No documented API lets a third party *read* a user's Wallet orders [2][8][12].
- **Windows.** It would be POST-SPEND (item-level context) if it were readable. It is not.
- **Coverage.** Wallet Orders: iOS 16+ [12]. Automatic order tracking from Mail: iOS 26. Reported expansion to Australia and Canada in iOS 27 (secondary source [14], **unverified**).
- **Implication.** Item-level context on iOS must come from the email stream (Gmail/Outlook adapters) or receipts, not from Wallet.
- **Recommendation: `avoid`** as an input. Possibly **`later`** as an *output*: if BRAKE ever sells something (for example a premium plan), it could write a Wallet order, but that has no signal value.

#### A4. Apple Pay transactions on non-Apple cards, and iOS Shortcuts "Wallet transaction" automations (`ios-shortcuts-wallet-transaction-automation`)

- **What it is.** Outside the US and UK, and for non-Apple cards in the US, Apple gives third-party apps **no API** for Apple Pay transaction history or the Wallet "you paid" notifications. iOS apps cannot read other apps' notifications.
- **Possible exception, owned by the device-signals stream.** iOS Shortcuts has a personal-automation trigger that fires when the user taps a chosen card or pass in Wallet. It is reported to pass merchant, amount and card name to a shortcut, which could then call a BRAKE App Intent. This is **unverified** in this session because support.apple.com was blocked. If it holds, it is the only near-real-time (seconds) iOS signal for *in-store Apple Pay taps* on any card, in any Apple Pay country. It is user-configured, so consent is explicit.
- **Windows.** POST-SPEND within seconds, arguably at the edge of IN-SPEND (the tap has already happened). In-app and web Apple Pay coverage is **unverified**.
- **Recommendation: `research`.** Confirm the trigger's fields and behaviour on iOS 26 and 27 and check App Review acceptability. The `apple-financekit` and iOS-signals streams should share one adapter definition for it.

### B. Google ecosystem

#### B1. Google Wallet / Google Pay (`google-wallet`)

- **What it is.** Google Wallet's developer APIs are for *issuing passes* (loyalty, offers, tickets, generic passes), and the Google Pay API is for *merchants accepting payments*. No public API was found that lets a third-party app read a user's Google Wallet transaction history or tap-to-pay receipts. This is **unverified** because developers.google.com was blocked. Revolut's 2026 "Wallet Partner" API is likewise push-only for passes ("Endpoints hosted by Revolut that partners call to put passes into Revolut Wallet") [32].
- **Practical route.** On Android, Google Wallet posts a notification after a contactless payment (merchant and amount; **unverified** format). BRAKE can only see it through `NotificationListenerService`, which belongs to the Android-notifications stream. The adapter id there should be `android-notification-listener`, with Google Wallet as a *notification template* inside it, not as a separate source.
- **Windows.** The notification is POST-SPEND within seconds.
- **Recommendation: `avoid`** as a dedicated API adapter. Treat it as a notification template under `android-notification-listener` (`mvp` in that stream).

### C. Card-linked services

#### C1. Fidel API "Select Transactions" (`fidel-select-transactions`)

- **What it is.** A card-linking platform. The user enrolls a Visa, Mastercard or Amex card (first 6 and last 4 digits are kept; the full PAN is tokenised and "The CVV number is not needed") [35]. Fidel then receives authorization, clearing and refund events from the networks for purchases **at program locations**. In Fidel's words: "When a consumer makes a purchase at a participating store with a linked card, Fidel API spots that transaction and sends it to your server in real-time through webhooks" [35]. Crucially, "Cards are linked to Programs and consequently are able to track all purchases at locations in the program" [35]. Fidel cannot see the card's other spending.
- **Data available** [35]:
  - `id`, `accountId`, `programId`, `amount`, `currency`, `datetime`, `created`, `updated`.
  - `auth`, `cleared`, `cardPresent`.
  - `authCode`, `approvalCode`, `refundTransactionId`.
  - `card{id, firstNumbers, lastNumbers, scheme, metadata}`.
  - `brand{id, name, logoURL}`.
  - `location{id, address, city, countryCode, postcode, timezone, geolocation}`.
  - `identifiers{MID, visaAuthCode, mastercardAuthCode, mastercardRefNumber, mastercardTransactionSequenceNumber}`.
  - `descriptor{merchantName, storeName}`.
  - `merchantCategoryCode`, `wallet`, and `offer{…}`.
- **Webhooks** [35]: `transaction.auth`, `transaction.clearing`, `transaction.refund` (and `*.qualified` variants), `card.linked`, `card.failed`, `location.status`. Each request is signed with `x-fidel-signature` and `x-fidel-timestamp` (HMAC-SHA256; 5-minute replay tolerance recommended). Fidel makes up to 3 attempts (immediately, after 1 minute, then 2 minutes later), and a `2xx` must be returned within 20 seconds.
- **Windows & latency.** POST-SPEND. The authorization event arrives "in real-time" (likely seconds; no SLA was seen). Clearing "usually happens 48 to 72 hours after a payment is made" [35].
- **Coverage.** "the United States, UK, Ireland, Canada, Sweden and UAE", with Japan in beta, according to the docs source [35]. The repository date is not shown; re-confirm. Card schemes: Visa, Mastercard, Amex. Locations must be onboarded with the networks ("Location Sync can take 1-2 weeks") [35]. The SDKs are actively maintained (React Native SDK 3.2.1, released 2026-07-23 [43]).
- **Access.** A commercial contract, and a program per merchant set. Whether a brand must consent to being tracked in a non-offer program could not be verified in Fidel's brand docs, so it is **unverified**. Fidel's real-time card-data product for expense management appears to have been spun out as "Astrada" (the GitHub org `FidelLimited` is now named Astrada) [35-note]. Astrada's consumer eligibility is **unverified**.
- **Privacy & consent.** The user agrees to card-monitoring terms when linking (the API flag is `termsOfUse=true`). The exact network consent text is **unverified**. Data goes to BRAKE's server through webhooks, not to the device.
- **Reliability.** High for enrolled merchants, and zero coverage elsewhere. Common failure modes: locations not yet live, MIDs missing (Fidel offers `missing-transaction-request`), cards replaced or reissued (new PAN, so the user must re-link), and cardholder name or PAN changes.
- **Dedup keys.** `id`; `authCode` / `approvalCode`; `visaAuthCode` and `mastercardRefNumber`; `MID`; `card.lastNumbers` + `amount` + `datetime`; `refundTransactionId` (refund-to-purchase link).
- **Normalized observation & confidence.** Card-network-grade amount, time and merchant (`brand.name` and `location`): **high**. Coverage completeness: **very low**. The registry must mark this source `coverage_scope=merchant_subset` so that the fusion layer never treats "no Fidel event" as evidence of no spending.
- **Provenance sentence.** "Reported by your Visa card network when you paid at Deliveroo (card ending 4242, linked to BRAKE)."
- **Recommendation: `avoid`** for general spend sensing (merchant-subset coverage, cost, and an offers-oriented business model). **`research`** only for a possible "high-risk merchant watch-list" feature: users opt in to real-time alerts for a few self-chosen merchants such as food delivery or betting. Only consider it if Fidel or Astrada allow non-offer, consumer-protective programs.

#### C2. Card-network card-linked offer and notification programmes, Visa / Mastercard / Amex (`card-network-card-linked-offers`)

- **What it is.** The schemes run card-linked offer platforms. Publishers enroll cards, merchants fund offers, and the schemes report qualifying transactions. They also run issuer-side consumer controls and alerts (for example Visa Transaction Controls and Mastercard spend-control services). This is **unverified**: developer.visa.com and developer.mastercard.com were blocked.
- **Data.** For offers, qualifying-transaction notifications only (merchant-scoped, like Fidel, which is built on these). For controls and alerts, real-time alerts and blocks *configured through the issuer's app*. No path was found for a non-issuer consumer app to subscribe to all transactions on a card (**unverified**).
- **Windows.** Offer reporting is POST-SPEND (seconds to days). Issuer controls are IN-SPEND, but only for issuers.
- **Access.** Network partner agreements. Controls require an issuing bank.
- **Recommendation: `avoid`** as direct integrations. Fidel or Astrada are the practical abstraction if the C1 research case is pursued. Issuer controls only matter if BRAKE becomes an issuer (section D).

#### C3. Cardlytics (`cardlytics`)

- **What it is.** A bank-channel advertising platform. Offers appear inside partner banks' own apps and statements, and partner banks share purchase data with Cardlytics for targeting and attribution (**unverified** in this session; cardlytics.com and sec.gov were blocked).
- **Relevance to BRAKE.** There is no consumer-consented data feed to a third-party app. Its business purpose (driving incremental merchant spend) conflicts with BRAKE's.
- **Recommendation: `avoid`.**

#### C4. Agentic-commerce credentials: Visa Intelligent Commerce and Trusted Agent Protocol (`visa-intelligent-commerce`)

- **What it is.** "Visa Intelligent Commerce (VIC) enables AI agents to securely browse, shop, and purchase on behalf of consumers using tokenized digital credentials" [42]. The toolkit covers VTS tokenization, FIDO device binding, step-up authentication and Visa Payment Passkeys. Visa's Trusted Agent Protocol lets merchants verify that an agent is legitimate and authorized by a user. Merchants may receive "Payment Account References (PARs) for cards on file" [42].
- **Why it matters.** If users increasingly buy *through agents*, the agent's purchase-instruction step becomes a new PRE-SPEND / IN-SPEND surface. BRAKE could be a consumer-side policy that an agent consults ("is this within my plan?"). It also introduces **PAR** as a cross-token card identifier that could help deduplication.
- **Access.** Visa Developer Center credentials. Consumer-app eligibility is **unverified**.
- **Recommendation: `research`.** Track it. Do not build yet.

### D. Issuer processors: a BRAKE-issued card for true IN-SPEND decisioning

A BRAKE-issued physical or virtual card would put BRAKE **in the authorization path**. On every purchase the processor calls BRAKE synchronously, and BRAKE approves or declines. This is the only mechanism in this stream with true IN-SPEND *control*.

| Processor | Real-time hook | Response window | Timeout behaviour | Fields BRAKE would see (verified unless noted) | Post-auth events |
|---|---|---|---|---|---|
| **Adyen Issuing** (`adyen-issuing-relayed-authorisation`) | Relayed authorisation webhook (`authorisationDecision.status` = `Authorised`/`Refused`) | "If we do not receive the response within **two seconds**, we apply your fallback logic." [38] | Configurable fallback logic [38] | `amount`, `merchantData{acquirerId, mcc, merchantId, nameLocation{city, country, name}}`, `paymentInstrument`, `processingType`, `id`, `validationResult` [38] | `balancePlatform.transaction.created` with `status` `pending`/`booked` [39] |
| **Stripe Issuing** (`stripe-issuing-realtime-auth`) | `issuing_authorization.request` webhook; "respond directly to the webhook request to approve" [37] | About 2 s (**unverified**; docs blocked) | Account-level default (**unverified**) | `amount`, `merchant_amount`, `merchant_currency`, `merchant_data{category, category_code, city, country, name, network_id, postal_code, state, terminal_id, url, tax_id}`, `authorization_method` (`chip`/`contactless`/`keyed_in`/`online`/`swipe`), `wallet` (`apple_pay`/`google_pay`/`samsung_pay`), `pending_request{amount, is_amount_controllable, network_risk_score…}`, `network_data`, `verification_data` [37] | Authorization `status`: `pending`/`closed`/`reversed`/`expired` [37] |
| **Lithic** (`lithic-auth-stream-access`) | Auth Stream Access (ASA) webhook, HMAC-signed (`/v1/auth_stream/secret`, rotation with 24 h overlap) [41] | **Unverified** | **Unverified** | Example payloads include `token`, `merchant.mcc`, `merchant.state` [41]; full schema **unverified** | Transaction webhooks (**unverified** names) |
| **Marqeta** (`marqeta-gateway-jit`) | Gateway Just-in-Time (JIT) Funding: BRAKE funds or declines each authorization | **Unverified** | "Commando Mode is a fallback measure that ensures Gateway JIT-funded cards continue to function in the event that your system fails" [40] | **Unverified** in detail; transactions carry `subnetwork` such as `GATEWAY_JIT` [40] | Webhooks: "You can receive information about transactions as they occur" [40] |

- **Windows & latency.** IN-SPEND: a decision is made in about 2 seconds or less, which is too short to involve the human in that same authorization. POST-SPEND: the authorization event is the earliest and most authoritative record possible (well under a second after the tap), followed by clearing (typically days).
- **What in-spend decisioning can realistically do.**
  1. *Pre-committed rules* evaluated at authorization, for example "decline food delivery after 23:00 unless I unlock", or MCC or merchant caps set by the user in calm moments.
  2. *Soft-decline-and-unlock:* decline, immediately push "Unlock Deliveroo for 10 minutes?", and the user retries. This is high friction and must be opt-in.
  3. *Approve and annotate:* approve, then use the zero-latency event for instant POST-SPEND context ("₹500 at Swiggy, 38% above your usual pace").
- **Coverage.** Only spending on *the BRAKE card*. BRAKE's coverage then depends on the user moving spending onto it, which is a big behavioural ask. Provider availability (**unverified** for specifics): US, UK and EEA for most of these processors. Consumer (rather than commercial) programmes generally need a sponsor bank and programme approval.
- **Regulatory / BIN-sponsor implications** (not legal advice; **unverified** in detail):
  - *US.* The card is issued by a sponsor bank. BRAKE would be the programme manager, with KYC/CIP and BSA/AML duties, Regulation E (debit and prepaid, including error resolution and the Prepaid Rule), network rules, possibly state money-transmission analysis depending on funds flow, and bank-partner oversight. The 2024 Synapse failure is reported to have sharply raised scrutiny of BaaS arrangements (**unverified** this session).
  - *UK/EEA.* An e-money licence, or acting as an agent or distributor of an EMI. Safeguarding, PSD2 SCA, and the FCA Consumer Duty in the UK.
  - *India.* Card issuance is restricted to banks and eligible NBFCs, and PPIs need RBI authorisation (**unverified** this session). UPI dominates small-ticket payments anyway, so value there is low.
  - *Funding models.* A prepaid or e-money card (the user loads money in) is simplest. A "pass-through" card that pulls from the user's existing card in real time touches network rules on staged wallets (**unverified**).
  - *Apple Pay / Google Pay provisioning* needs issuer agreements with Apple and Google (**unverified** specifics).
- **Privacy & consent.** BRAKE becomes the data controller *and* a regulated party. It would hold KYC data, which is far more than the brief's minimum-collection principle wants for a core product.
- **Reliability & failure modes.** Endpoint latency or outage must fail **open** (approve). Fallback logic or Commando Mode must be set to approve. Other issues: incremental authorizations (hotels, fuel), partial reversals, offline authorizations, and multi-currency.
- **Dedup keys.** Processor authorization or transaction IDs; `network_data` IDs; `merchant_data.network_id`/`terminal_id`; last 4 digits; the link between authorization and clearing records.
- **Normalized observation & confidence.** Amount, time and status are authoritative (**very high**). Merchant comes from the raw acceptor descriptor plus MCC (**medium-high**).
- **Provenance sentence.** "Seen instantly because you paid with your BRAKE card."
- **Recommendation.** Umbrella `brake-issued-card`: **`later`**, as a separate, opt-in "commitment card" product for users who explicitly want hard limits. Pilot through a programme manager in one market (US or UK) only after the observation-based product shows value. Of the individual processors, Adyen's documented 2-second window with configurable fallback, and Marqeta's Commando Mode, are the right *patterns* to require from whichever provider is chosen.

#### D2. Investec Programmable Banking "Card Code": user-owned in-spend rules (`investec-card-code`)

- **What it is.** Investec (South Africa) lets clients deploy JavaScript to their own card. The default template is `const beforeTransaction = async (authorization) => { … return true; }`, with `afterTransaction(transaction)` and `afterDecline(transaction)` hooks [29]. Endpoints under `/za/v1/cards/{cardKey}/…` let a client upload code (`/code`), publish it (`/publish`), simulate it (`/code/execute` with `centsAmount`, merchant and other fields), list executions, and set `environmentvariables`. Reference endpoints list countries, currencies and merchants [29].
- **Windows.** True **IN-SPEND** decisioning on the user's own bank card, without BRAKE being an issuer. `afterTransaction` gives an instant POST-SPEND event. Card Code runs inside Investec's environment, and calling out to an external BRAKE service from it is **unverified**. Execution time limits are not documented in the spec ("timeout" is not found) [29].
- **Coverage.** Investec private-banking clients in South Africa (`/za/` paths [29]). UK availability is **unverified**. Reach is small (a premium private bank).
- **Access.** OAuth2 (3-legged OAuth spec present [29]) with scope `cards`. Whether a third-party app may manage a client's card code at scale is **unverified**.
- **Dedup keys.** Card `cardKey`; the transaction fields from the Account Information API (`/za/pb/v1/accounts/{accountId}/transactions` and `/pending-transactions` [29]).
- **Provenance.** "Your Investec card asked BRAKE's rule before approving this payment."
- **Recommendation: `research`.** It is a near-perfect *reference design* for BRAKE's decision-hook interface, and a possible niche adapter. Not a priority market.

### E. Neobank personal APIs and webhooks

#### E1. Monzo Developer API (`monzo-developer-api`)

- **What it is.** Monzo's REST API with webhooks. Its stated restriction: "The Monzo Developer API is not suitable for building public applications. You may only connect to your own account or those of a small set of users you explicitly allow." [22]
- **Data** [23][24]:
  - Transactions: `amount` (minor units; negative = debit), `currency`, `created`, `description`, `merchant` (expandable), `metadata` (app-private key-values), `notes`, `settled` (empty until settled), `category` (`general`, `eating_out`, `expenses`, `transport`, `cash`, `bills`, `entertainment`, `shopping`, `holidays`, `groceries`), `is_load` (top-up vs refund), and `decline_reason` (`INSUFFICIENT_FUNDS`, `CARD_INACTIVE`, `CARD_BLOCKED`, `INVALID_CVC`, `OTHER`).
  - The `merchant` object in webhooks includes `name`, `category`, `logo`, `emoji`, `group_id`, and `address{address, city, country, latitude, longitude, postcode, region}`.
- **Webhooks.** `POST https://api.monzo.com/webhooks`, event `transaction.created`: "Each time a new transaction is created in a user's account, we will immediately send information about it". Failed deliveries are retried "up to a maximum of 5 attempts, with exponential backoff" [24].
- **Windows & latency.** POST-SPEND within seconds of authorization (the transaction is created at authorization, and `settled` fills in later). Declined transactions are also visible, which is a useful "attempted spend" signal.
- **Access & auth.** OAuth with in-app SCA approval. The user approves "with their card PIN, fingerprint or Face ID" in the Monzo app. Tokens expire (example `expires_in: 21600`). Only confidential clients get refresh tokens. A client may have only one active access token per user. "after 5 minutes, it can only sync the last 90 days of transactions" [23][25].
- **Coverage.** Monzo customers (UK; the US product's status is **unverified**). Only for the developer or a small allow-list.
- **Privacy.** Webhooks deliver to a server, so a relay is needed. Writing `metadata` and `notes` back into Monzo is possible but should be avoided unless the user asks.
- **Dedup keys.** `id` (stable from authorization to settlement), `merchant.id` / `group_id`, `amount`+`created`.
- **Observation.** Very high fidelity, low latency, merchant enrichment included.
- **Provenance.** "Sent by Monzo the moment your card was charged."
- **Recommendation: `avoid`** for a public product because of the terms. **`research`** for internal dogfooding: it is an excellent test harness for the fusion layer (ground truth plus low latency). For Monzo users in production, use UK open banking (other stream) or FinanceKit connected accounts (A1). Note that Monzo appears in Apple's FinanceKit UK list [1].

#### E2. Starling developer API (`starling-developer-api`)

- **What it is.** Starling exposes a "Public API" and a "Payment Services API", with official samples [28]. Starling's JavaScript SDK is archived and "Unsupported" [28]. Personal access tokens, feed-item webhooks and the rules for third-party production access could **not be verified** because developer.starlingbank.com was blocked. Most likely the model matches Monzo's: personal tokens for your own account, and regulated open banking for third parties (**unverified**).
- **Windows.** If feed-item webhooks exist as expected, POST-SPEND within seconds (**unverified**).
- **Recommendation: `research`** (confirm the terms). Assume `avoid` for production.

#### E3. Up Bank API, Australia (`up-bank-api`)

- **What it is.** "a beta release that gives you programmatic access to your balances and transaction data". The only access route is a Personal Access Token from `api.up.com.au` [26].
- **Data** [27]:
  - Transaction `attributes`: `status`, `rawText`, `description`, `message`, `isCategorizable`, `holdInfo`, `roundUp`, `cashback`, `amount`, `foreignAmount`, `cardPurchaseMethod`, `settledAt`, `createdAt`, `transactionType`, `note`, `performingCustomer`.
  - Status is `HELD` or `SETTLED` ("When a transaction is held, its account's `availableBalance` is affected").
  - Webhook events: `TRANSACTION_CREATED`, `TRANSACTION_SETTLED`, `TRANSACTION_DELETED`, `PING`, signed with `X-Up-Authenticity-Signature` (HMAC SHA-256 of the raw body).
- **Windows.** POST-SPEND within seconds (`TRANSACTION_CREATED` on hold). `TRANSACTION_DELETED` signals a dropped hold, which maps to BRAKE `cancelled`.
- **Coverage.** Up customers in Australia. Personal use only, with no OAuth for third parties in the spec [26]. Whether users may paste their PAT into a third-party service is **unverified**: it is a ToS and security question. The sanctioned third-party route in Australia is the Consumer Data Right (other stream; Up's CDR participation is **unverified**).
- **Dedup keys.** Transaction `id` (stable from HELD to SETTLED; **unverified**), `rawText`, `amount`+`createdAt`, and `holdInfo` (hold amount vs settled amount).
- **Provenance.** "Sent by Up when your card payment was held."
- **Recommendation: `research`** (power-user adapter only if the ToS permits). `avoid` for the mass market.

#### E4. Investec Programmable Banking, account information (`investec-programmable-banking`)

- **What it is.** OAuth2 API for SA private banking: `GET /za/pb/v1/accounts`, `/balance`, `/transactions`, `/pending-transactions` [29]. It is paired with Card Code (D2).
- **Windows.** POST-SPEND by polling, plus Card Code's `afterTransaction` for instant events.
- **Recommendation: `research`** (see D2).

#### E5. Revolut (`revolut-open-banking-api`)

- **What it is.** Revolut has **no personal developer API for retail customers**. The Business API is "for Revolut Business customers… to automate your own business processes" [31]. Third-party access to retail accounts goes through the **Revolut Open Banking API**, for which access requires being a "regulated third party provider" [30].
- **Data (AIS)** [30]: `/accounts`, `/balances`, `/transactions`, `/direct-debits`, `/standing-orders`. Transactions carry `TransactionId`, `Amount`, `CreditDebitIndicator`, `Status` (`Booked`/`Pending`), `BookingDateTime`, `MerchantDetails{MerchantName, MerchantCategoryCode}` and `CardInstrument`.
- **History rule.** "full transaction history can only be accessed within the first 5 minutes after the Revolut user has authorised the consent. After those 5 minutes, transaction history is restricted to the last 90 days." [30]. Monzo has the same rule [23].
- **Windows.** POST-SPEND by polling at the aggregator's cadence (minutes to hours). Pending items are available.
- **Recommendation: covered by the UK/EU open-banking stream.** **`next`** through a licensed aggregator. Do not integrate directly unless BRAKE becomes an AISP.

#### E6. Wise (`wise-personal-api`)

- **What it is.** Wise offers personal API tokens and webhooks. Event names, scopes and PSD2-driven restrictions on personal tokens for UK and EEA residents could **not be verified** (docs.wise.com was blocked).
- **Recommendation: `research`.** Assume personal-use-only, like E1–E3.

#### E7. Nubank, through Open Finance Brasil credit-card API (`brazil-open-finance-credit-cards`)

- **What it is.** Nubank has no personal developer API (**unverified**). Brazil's regulated Open Finance gives authorised participants credit-card data from participating institutions, Nubank included. The participant list is **unverified**.
- **Data (spec v2.3.1)** [33]:
  - Endpoints: `GET /accounts`, `/accounts/{creditCardAccountId}`, `/bills`, `/bills/{billId}/transactions`, `/limits`, `/transactions` (historical, last 12 months), and `/transactions-current` (7-day window).
  - Fields: `transactionId`, `identificationNumber` (last 4 digits of the card for individuals), `transactionName`, `billId`, `creditDebitType`, `transactionType` (`PAGAMENTO`, `TARIFA`, `OPERACOES_CRED`, `ESTORNO`, `CASHBACK`, `OUTROS`), `paymentType` (`A_VISTA`/`A_PRAZO`), `feeType`, `otherCreditsType`, `chargeIdentificator` (instalment number), `chargeNumber` (instalment count), `brazilianAmount`, `amount` (original currency), `transactionDateTime`, `billPostDate`, `payeeMCC`.
- **Windows.** POST-SPEND, by polling `transactions-current`. Real-time push for data is **unverified**.
- **Normalization lessons.** Brazilian *parcelado* (instalment) purchases appear as one line per instalment, so one purchase becomes N postings. BRAKE needs a `purchase_group` / `instalment_of` relation, and must not count each instalment as a new impulse purchase. Bill-cycle membership (`billId`) is a natural "budget cycle" signal.
- **Access.** Participation as a regulated receiving institution, or through a licensed aggregator. Consent is managed by the ecosystem's consent API.
- **Recommendation: `later`** (Brazil market entry). Adopt the instalment model in the schema **now**.

### F. Wallet histories

#### F1. PayPal (`paypal-transaction-search`)

- **What it is.** The `GET /v1/reporting/transactions` API. "To use the API on behalf of third parties, you must be part of the PayPal partner network." "It takes a maximum of three hours for executed transactions to appear". It covers "the previous three years" with a maximum 31-day query window [34].
- **Data** (`transaction_info`) [34]: `transaction_id`, `paypal_reference_id`, `transaction_event_code`, `transaction_initiation_date`, `transaction_updated_date`, `transaction_amount`, `fee_amount`, `shipping_amount`, `sales_tax_amount`, `transaction_status`, `transaction_subject`, `invoice_id`, `payment_method_type`, `instrument_type`, `instrument_sub_type`, and more.
- **Fit.** This is a merchant-reporting API, not consumer-consented history for a personal-finance app. Log In with PayPal scopes for consumer transaction history are **unverified** and believed not to exist.
- **Windows.** POST-SPEND, up to 3 hours late.
- **Practical route.** PayPal receipt emails (email stream) plus the matching card or bank debit (descriptor `PAYPAL *MERCHANT`, **unverified** exact format). The email gives the *real* merchant behind the PayPal descriptor, which is a high-value fusion join.
- **Recommendation: `avoid`** (API). PayPal is a *merchant-resolution problem* for the fusion layer.

#### F2. Venmo and Cash App (`us-p2p-wallet-history`)

- **What it is.** No public consumer-data APIs were found for either (**unverified**; searches were exhausted and the domains were not reachable). Cash App Pay and Venmo checkout are *merchant acceptance* products. US §1033 may in future bring digital wallets (Reg E accounts) into scope. Its status in 2026 belongs to the Plaid/§1033 stream.
- **Practical signals.** Android push notifications from the apps, receipt emails, and the linked bank or card funding debit. The *transfer vs spending* risk is very high here: P2P payments are often rent splits or reimbursements.
- **Recommendation: `avoid`** (direct API). Cover through notifications, email and bank-feed fusion, with a strong `transfer|shared_expense` prior.

#### F3. India wallets: Paytm, PhonePe, Amazon Pay (`india-wallet-history`)

- **What it is.** No consumer-consented third-party history APIs were found (**unverified**). Most spending through these apps is **UPI**, so the authoritative record is the user's *bank account* debit (visible through Account Aggregator, bank SMS or bank notifications). Each payment has a UPI RRN or UTR that also appears in the app's notification and SMS (UPI stream). Wallet (PPI) balances and wallet-funded payments are the gap. Whether PPIs are Account Aggregator FIPs is **unverified**.
- **Practical signals.** App notifications (Android), SMS, emailed statements, and in-app statement downloads (**unverified** format).
- **Recommendation: `avoid`** (direct API). `mvp` coverage comes through UPI-intent, notification and SMS streams keyed on RRN.

#### F4. Southeast Asia wallets: GCash, GrabPay (`sea-wallet-history`)

- **What it is.** No consumer-consented third-party history APIs were found (**unverified**). Their developer offerings are merchant acceptance. Philippine open-finance developments are **unverified**.
- **Practical signals.** App notifications, SMS and emailed receipts.
- **Recommendation: `research`** (track the Philippine open-finance framework). `avoid` direct integration.

#### F5. M-Pesa, Kenya (`mpesa-statements`)

- **What it is.** Safaricom's Daraja APIs are for *organisations with shortcodes* (C2B, B2C, transaction status and similar). Consumer statement access is via in-app or USSD statement requests delivered as PDFs (**unverified**; developer.safaricom.co.ke was blocked). Every M-Pesa transaction produces a confirmation **SMS** with a unique transaction code. That SMS is the practical real-time signal, and the code is an excellent dedup key.
- **Windows.** The SMS is POST-SPEND within seconds. A statement PDF is POST-SPEND in batch, which suits onboarding backfill through a user-initiated upload with local parsing.
- **Recommendation: `later`** (Kenya). Through the SMS stream (`mvp` there, if Android SMS policy permits) and a manual statement import (`later`).

### G. App-store purchase receipts and subscription detection

#### G1. StoreKit / App Store Server API (`storekit-app-store-server-api`)

- **What it is.** "Information that represents the customer's purchase of a product in **your app**" (StoreKit `Transaction`) [18]. The App Store Server API returns data "for a single customer of **your app**" and authenticates with keys from *your* App Store Connect account [17]. `showManageSubscriptions(in:)` shows "the customer's currently active subscription for your app" [19].
- **Fit.** BRAKE cannot see a user's Netflix, Spotify or dating-app subscriptions billed through Apple.
- **Recommendation: `avoid`** (as a signal source). It is used only for BRAKE's own monetization.

#### G2. Google Play Billing (`google-play-billing`)

- **What it is.** "a service that enables you to sell digital products and content in your Android app" [20]. Purchases are queried with `queryPurchasesAsync()` for your own app [21]. Billing Library v8+ is required for new apps and updates by 2026-08-31 [20], which matters only for BRAKE's own in-app purchases.
- **Recommendation: `avoid`** (as a signal source).

#### G3. Alternatives for detecting app-store subscriptions (`app-store-receipt-emails`)

- **Mechanisms.**
  1. Apple and Google Play send purchase and renewal **receipt emails**, which name the app, the subscription, the price and the renewal date (exact sender addresses and templates are **unverified**). These belong to the email stream, parsed on device or under narrow sender filters.
  2. **Bank or card descriptors** such as `APPLE.COM/BILL` or `GOOGLE *<app>` (**unverified** exact strings). These show that an app-store charge happened but usually not *which* app, because Apple bundles charges.
  3. FinanceKit `merchantName` and `merchantCategoryCode` on Apple Card.
  4. A user-initiated **screenshot or share** of the Settings > Subscriptions screen, OCR'd on device (user-initiated, so policy-safe; accuracy **unverified**).
  5. The user's own data export from Apple or Google, imported manually (**unverified** contents).
- **Windows.** PRE-SPEND (an upcoming renewal from the receipt's renewal date) and POST-SPEND (the charge).
- **Recommendation: `next`**, as part of the subscription-intelligence feature. The email receipt is the primary key, and the descriptor match confirms it.

---

## Three-window classification

| Source (id) | Pre-spend | In-spend | Post-spend | Typical latency to BRAKE | Notes |
|---|---|---|---|---|---|
| Apple FinanceKit (`apple-financekit`) | Weak (due dates, balances) | No | **Yes** | Foreground: as Wallet updates. Background: ≤ ~1 h (`.hourly`) | US: Apple Card, Cash, Savings. UK: connected OB accounts. Entitlement-gated. On-device. |
| FinanceKit Transaction Picker | No | No | Yes (user-selected) | Immediate on user action | Ephemeral, narrowest consent. iOS 18+. |
| Apple Wallet Orders (`apple-wallet-orders`) | No | No | Would be item-level, but **not readable** | n/a | Write-only for apps. Use email instead. |
| iOS Shortcuts Wallet-tap automation (`ios-shortcuts-wallet-transaction-automation`) | No | Edge (tap just happened) | Yes | Seconds (**unverified**) | Apple Pay in-store taps. User-configured. |
| Google Wallet (`google-wallet`) | No | No | Via Android notification only | Seconds | No read API. Template under `android-notification-listener`. |
| Fidel Select (`fidel-select-transactions`) | No | No | Yes (program merchants only) | Auth: real-time. Clearing: 48–72 h | `coverage_scope=merchant_subset`. US, UK, IE, CA, SE, AE (JP beta). |
| Network CLO / controls (`card-network-card-linked-offers`) | No | Issuer-only | Merchant-subset | Seconds to days | Not accessible to non-issuers (**unverified**). |
| Cardlytics (`cardlytics`) | No | No | No feed to third parties | n/a | Ad platform. Avoid. |
| Visa Intelligent Commerce (`visa-intelligent-commerce`) | **Potential** (agent purchase instructions) | Potential | Potential | n/a | Emerging, agentic. |
| BRAKE-issued card (`brake-issued-card` + vendors) | No | **Yes (decision ≤ ~2 s)** | **Yes** (instant auth, then clearing) | < 1 s | Only BRAKE-card spend. Regulated. Fail-open. |
| Investec Card Code (`investec-card-code`) | No | **Yes** (user's own card) | Yes (`afterTransaction`) | < 1 s | ZA, niche. Reference design. |
| Monzo API (`monzo-developer-api`) | No | No | **Yes** (incl. declines) | Seconds | Personal/allow-list only. |
| Starling API (`starling-developer-api`) | No | No | Likely (**unverified**) | Seconds (**unverified**) | Terms unverified. |
| Up API (`up-bank-api`) | No | No | **Yes** (HELD→SETTLED→DELETED) | Seconds | PAT, beta, personal. |
| Revolut Open Banking (`revolut-open-banking-api`) | No | No | Yes | Minutes to hours (polling) | Regulated TPP. 90-day limit after 5 min. |
| Wise (`wise-personal-api`) | No | No | Likely (**unverified**) | **Unverified** | Personal tokens. |
| Brazil OFB credit cards (`brazil-open-finance-credit-cards`) | Weak (bill and limit context) | No | Yes | Polling; 7-day "current" window | Instalments, `payeeMCC`. |
| PayPal (`paypal-transaction-search`) | No | No | Merchant-side only | ≤ 3 h | Partner network required. |
| Venmo / Cash App (`us-p2p-wallet-history`) | No | No | Via notifications or email only | Seconds (notification) | No API. Transfer-heavy. |
| India wallets (`india-wallet-history`) | No | No | Via UPI/SMS/notifications | Seconds | Key on UPI RRN. |
| SEA wallets (`sea-wallet-history`) | No | No | Via notifications, SMS, email | Seconds | No API (**unverified**). |
| M-Pesa (`mpesa-statements`) | No | No | Via SMS (real time) or PDF (batch) | Seconds or batch | Transaction code is the dedup key. |
| StoreKit / App Store Server API | No | No | No (first-party only) | n/a | Only BRAKE's own IAPs. |
| Google Play Billing | No | No | No (first-party only) | n/a | Only BRAKE's own IAPs. |
| App-store receipt emails + descriptors (`app-store-receipt-emails`) | **Yes** (renewal date) | No | Yes | Minutes (email) / days (bank posting) | Primary route to subscription intelligence. |

---

## Implications for BRAKE architecture

### 1. Four adapter shapes, not one

| Shape | Examples | Contract |
|---|---|---|
| **Server push (webhook)** | Monzo, Up, Fidel, issuer post-auth events | Verify the signature (Up `X-Up-Authenticity-Signature`; Fidel `x-fidel-signature` + `x-fidel-timestamp` with a 5-minute replay window; Lithic ASA HMAC with 24 h key-rotation overlap). Acknowledge fast (Fidel requires `2xx` within 20 s). Be idempotent on `source_record_id`, because retries happen (Monzo up to 5 with exponential backoff; Fidel 3). Then forward to the device or the fusion store with minimal retention. |
| **On-device pull or stream** | FinanceKit long-running query, Transaction Picker | Persist a `HistoryToken` per account. Handle `inserted`/`updated`/`deleted`. Process locally. Upload only derived facts, if anything. |
| **On-device background wake** | FinanceKit `BackgroundDeliveryExtension` | Expect delays, duplicates, reordering and early termination (`willTerminate`). Persist work incrementally. Never assume the order of deliveries. |
| **Synchronous decision hook** | Issuer real-time authorization (Adyen, Stripe, Lithic, Marqeta), Investec `beforeTransaction` | A hard deadline (about 2 s for Adyen [38]). Decide from **precomputed** state only (rules compiled ahead of time, budgets cached). No model or LLM calls in the path. **Fail open** (configure fallback or Commando Mode to approve). Emit an observation *after* the decision through the normal pipeline. Keep this interface separate from `SignalSource`; call it something like `DecisionHook`, with its own SLOs and audit log. |

### 2. Status-lifecycle mapping (normalization pitfalls)

| Source | Source status | → BRAKE `status` | Pitfall |
|---|---|---|---|
| FinanceKit | `authorized`, `pending` | `pending` | Same `id` moves to `booked`. Update in place; do not create a new candidate. |
| FinanceKit | `booked` | `posted` | Posted amount may differ from authorized (tips, FX). |
| FinanceKit | `rejected` | `cancelled` (attempt) | Useful "attempted spend" signal. Never count it as spending. |
| FinanceKit | `memo` | annotation | Not a money movement. |
| Monzo | `settled` empty / set | `pending` / `posted` | Declines arrive with `decline_reason`. |
| Up | `HELD` / `SETTLED` / `TRANSACTION_DELETED` | `pending` / `posted` / `cancelled` | `holdInfo` carries the original hold amount. |
| Fidel | `transaction.auth` / `.clearing` / `.refund` | `pending` / `posted` / `refunded` | Clearing arrives 48–72 h later. Link refunds through `refundTransactionId`. |
| Stripe Issuing | `pending` / `closed` / `reversed` / `expired` | `pending` / `posted` (with transaction) / `cancelled` / `cancelled` | An authorization is not a transaction. Join through `transactions[]`. |
| Adyen | `pending` / `booked` | `pending` / `posted` | |
| Revolut OB | `Pending` / `Booked` | `pending` / `posted` | Pending and booked may have *different* `TransactionId`s (**unverified**). Match on amount, time and merchant. |
| Brazil OFB | per-bill postings | `posted` | Instalments: N postings per purchase. |

### 3. Amount and sign conventions

- FinanceKit: positive decimal plus `creditDebitIndicator`, whose meaning flips for liability accounts [10].
- Monzo: signed integer in minor units, negative = debit [23].
- Up: `amount` object (internal shape **unverified**) plus `foreignAmount`.
- Stripe: `amount` plus `merchant_amount` and `merchant_currency`.
- Brazil: `brazilianAmount` (BRL) plus `amount` (original currency).

**Normalize to `{amount_minor: int, currency: ISO4217, direction: debit|credit, account_kind: asset|liability}`, and keep the source-original values in provenance.** Keep `fx_original {amount, currency, rate}` as its own field, because FX transactions are a frequent source of false "different amount" non-matches.

### 4. Merchant and category priors

MCC is available from FinanceKit (`merchantCategoryCode`, ISO 18245), Fidel (`merchantCategoryCode`), Stripe (`merchant_data.category_code`), Adyen (`merchantData.mcc`), Revolut OB (`MerchantCategoryCode`) and Brazil OFB (`payeeMCC`). Use MCC as a **category prior**, not as ground truth: MCCs describe the merchant, not the basket (the brief's Amazon toothbrush, cable and dog-food example). Monzo's `category` reflects the user's own labelling and should be imported as a *user-verified* label when present.

### 5. Deduplication keys this stream contributes

- **Within one source:** FinanceKit `Transaction.id` (device-scoped), Monzo `id`, Up transaction `id`, Fidel `id`, Stripe authorization `id`, Adyen `id`, Revolut `TransactionId`, Brazil `transactionId`, PayPal `transaction_id`.
- **Across sources:** card last 4 digits (Fidel `card.lastNumbers`, Brazil `identificationNumber`, issuer card objects); network authorization codes (Fidel `authCode`, `approvalCode`, `visaAuthCode`, `mastercardRefNumber`); merchant IDs (`MID`, `merchantData.merchantId`, `merchant_data.network_id`); PAR (Payment Account Reference, a cross-token card identifier in agentic and tokenized flows [42]); M-Pesa transaction codes; UPI RRN (other stream).
- **Pending to posted:** same-id update (FinanceKit, Monzo, Up) or explicit links (Plaid `pending_transaction_id`, other stream). Elsewhere use fuzzy amount, time and merchant matching with tolerance for tip, fuel and hotel incremental authorizations.
- **Device-scoped IDs** (FinanceKit) cannot be matched across a user's iPhone and iPad. Use content keys.

### 6. Coverage semantics in the capability registry

Every source entry should declare more than availability. Required fields:

- `coverage_scope`: `all_accounts | single_institution | single_card | merchant_subset | user_selected`.
- `latency_class`: `sync_decision | seconds | minutes | hours | days`.
- `processing_locus`: `device | server`.
- `consent_unit`: `per_account | per_card | per_transaction | per_institution`.
- `history_depth`: for example "full within 5 minutes of consent, then 90 days" for UK OB/Monzo/Revolut; "12 months + 7-day current" for Brazil.

The fusion layer must use `coverage_scope` to avoid inferring "no spending" from silence. A Fidel or BRAKE-card feed says nothing about other cards.

### 7. Capability-registry facts (as of 2026-10-04)

| Country | Platform | Capability | Status |
|---|---|---|---|
| US | iOS ≥17.4 | `apple-financekit` (Apple Card, Apple Cash, Savings) | available (entitlement-gated) |
| GB | iOS ≥18.4 | `apple-financekit` (Wallet connected accounts via open banking) | available (entitlement-gated) |
| Other | iOS | `apple-financekit` | unavailable |
| US, GB | iOS ≥26 | FinanceKit background delivery (hourly/daily/weekly) | available |
| US, GB | iOS ≥26 | Wallet automatic order tracking from Mail | available (country list from secondary source [14]), not readable by apps |
| AU, CA | iOS 27 | Wallet order tracking | emerging (secondary source) |
| GB | server | `monzo-developer-api` | limited (own account or small allow-list) |
| AU | server | `up-bank-api` | limited (personal access token, beta) |
| ZA | server | `investec-card-code`, `investec-programmable-banking` | available to Investec clients (niche) |
| GB/EEA | server | `revolut-open-banking-api` | available to regulated TPPs only |
| BR | server | `brazil-open-finance-credit-cards` | available to authorised participants |
| US, GB, IE, CA, SE, AE | server | `fidel-select-transactions` | available, merchant-subset |
| JP | server | `fidel-select-transactions` | emerging (beta) |
| GLOBAL | any | third-party read of App Store / Play purchases | unavailable |
| GLOBAL | Android | Google Wallet transaction read API | unavailable (**unverified**); notification only |
| GLOBAL | server | PayPal consumer transaction history for third-party apps | limited (partner network; merchant reporting) |
| US | any | Venmo / Cash App consumer data API | unavailable (**unverified**) |
| IN | any | Paytm / PhonePe / Amazon Pay history API | unavailable (**unverified**) |
| KE | any | M-Pesa consumer statement API | unavailable (**unverified**); SMS common |
| US, GB, EEA | server | BRAKE-issued card real-time authorization | limited (requires sponsor bank or EMI programme) |
| IN | any | BRAKE-issued card | unavailable in practice (**unverified**; RBI issuance rules) |

### 8. Privacy architecture notes

- Server-push sources (Monzo, Up, Fidel, issuers) force data to transit BRAKE's servers. Use a **thin relay**: verify, minimise (drop unused fields such as geolocation unless a feature needs them), encrypt to the user's device key, and delete after delivery. Prefer device-side fusion where possible.
- FinanceKit is device-only by design. BRAKE should keep it that way and upload only derived aggregates if sync is needed. Uploading raw Apple Card data would weaken a strong privacy story and could raise questions at Apple review (**unverified**).
- Per-source disconnect must also *revoke upstream*: delete Monzo or Up webhooks, unlink Fidel cards (`card` delete), stop FinanceKit queries and point the user to Settings, and close or freeze BRAKE cards.

---

## Risks, policy constraints and ethical concerns

1. **Terms-of-service risk with personal APIs.** Monzo explicitly forbids public apps [22]. Up and Wise offer personal tokens. Asking users to paste personal tokens into BRAKE amounts to credential sharing outside the regulated AIS regime. It may breach bank terms, and in the UK and EU it may make BRAKE an unregistered AISP (**legal review needed; unverified**). Restrict it to internal testing unless written permission exists.
2. **The FinanceKit entitlement is discretionary.** Apple grants it per bundle ID against criteria. BRAKE must present as a "financial management tool" and stay in the Finance category, which may constrain product positioning (for example a pure "impulse-control" or wellbeing framing). Plan for denial: Transaction Picker plus manual entry plus email.
3. **Issuing a card is a different company.** Sponsor-bank due diligence, KYC, Reg E or e-money obligations, complaints and disputes, fraud and chargebacks, card-network rules, capital and cost. Post-2024 BaaS scrutiny (**unverified**) lengthens timelines. It also collides with the brief's minimum-collection principle, since KYC requires identity documents.
4. **Ethics of declining in real time.** A BRAKE decline at a till can strand a user (fuel, transport, pharmacy, groceries) or embarrass them. Hard rules must be:
   - user-authored in a calm state;
   - overridable;
   - safe-listed for essential MCCs;
   - fail-open on any outage or timeout.

   Low-confidence inferences must never trigger a decline, in line with the brief's confidence-aware UX. Measure regret *and* harm (for example a "BRAKE blocked something I needed" report).
5. **Conflict of interest in card-linked offers.** Fidel and network CLO programmes and Cardlytics exist to drive merchant-funded spending. Taking offer revenue would contradict BRAKE's purpose and erode trust. If BRAKE uses card-linking at all, it should be for user-chosen *protective* watch-lists, with no merchant monetization.
6. **Partial coverage misread as complete.** Merchant-subset or single-card feeds can create false calm ("you've spent nothing on delivery this week"). The registry's `coverage_scope` must propagate into UX copy ("Based on your Monzo card only…").
7. **Third-party policy volatility.** Apple changes Wallet and FinanceKit annually (UK in iOS 18.4, background delivery in iOS 26, order tracking in more countries in iOS 27). Play Billing deadlines move yearly. Issuer and processor terms change. Re-verify the registry facts every release cycle.
8. **Sensitive inferences.** Card MCCs reveal health (pharmacy, clinics), religion (donations), gambling and sexuality-related merchants. Apply data minimisation and on-device processing, and avoid server-side profiling. App Store guideline 5.1.1(iii) requires collecting "only… data that is required to accomplish the relevant task" [16].
9. **Children and family accounts.** FinanceKit excludes Apple Card Family participants and children using Apple Cash Family [1]. BRAKE should not attempt workarounds for minors' data.

---

## Open questions

1. Does Apple grant the FinanceKit entitlement to a behaviour-change or "spending decisions" app that is not a full budgeting or net-worth tool? What evidence does Apple ask for, and how long does review take?
2. Does the FinanceKit Transaction Picker require the full managed entitlement, or a lighter one?
3. How quickly do Apple Card *authorizations* (`status=.authorized`) and UK connected-account transactions appear in the Wallet store? Does `.hourly` background delivery deliver within minutes in practice?
4. On iOS 26 and 27, what exact fields does the Shortcuts Wallet-tap automation pass (merchant, amount, card, category)? Does it fire for in-app or web Apple Pay? Can an App Intent receive it without user editing?
5. Is FinanceKit expanding beyond the US and UK (for example via Connected Cards in other open-banking markets)? Nothing was found as of 2026-10-04.
6. Do Fidel or Astrada allow a non-offer, consumer-protective program (user-chosen merchant watch-list)? Do brands need to consent? What is the per-card or per-transaction cost?
7. Does any card network or processor offer *consumer-consented, all-merchant* real-time card transaction notifications to non-issuer apps in 2026 (for example via tokenization-lifecycle or "card-on-file" services)?
8. For a BRAKE commitment card: which programme manager will support a *consumer* prepaid or debit programme with real-time authorization and a fail-open fallback, in which first market, with what minimums? What exact response windows apply for Stripe Issuing, Lithic ASA and Marqeta JIT?
9. Can Investec Card Code call out to an external service during `beforeTransaction`, and what is its execution-time budget? Is UK Investec programmable banking available?
10. What are the current terms for Starling personal tokens and webhooks, Wise personal tokens (PSD2 restrictions) and Up PAT sharing with third-party apps?
11. Are PPI wallets (Paytm, PhonePe, Amazon Pay) or M-Pesa reachable through any regulated data-sharing framework (India AA FIP categories; Kenya; Philippine open finance) as of 2026?
12. What legal classification applies to BRAKE in the UK and EU if it relays bank webhooks for users (AISP registration)?
13. Could BRAKE act as a consumer-side "spending policy" for AI shopping agents via Visa Intelligent Commerce or similar, and is consumer-app access possible?

---

## References

URLs actually consulted on 2026-10-04. "(snippet)" means the content was seen only in a search-result snippet, not fetched.

1. https://developer.apple.com/financekit/ — FinanceKit countries (US iOS 17.4+, UK iOS 18.4+), supported accounts and exclusions, UK institution list, eligibility criteria, background sync, privacy statement.
2. https://developer.apple.com/tutorials/data/documentation/financekit.json — FinanceKit framework index: `FinanceStore` methods, `saveOrder(signedArchive:)`, `BackgroundDeliveryExtension`, managed capability `com.apple.developer.financekit`, organization account / Account Holder, `NSFinancialDataUsageDescription`.
3. https://developer.apple.com/tutorials/data/documentation/financekit/transaction.json — `Transaction` properties and types (iOS 17.4+).
4. https://developer.apple.com/tutorials/data/documentation/financekit/transactionstatus.json — `authorized`, `booked`, `pending`, `rejected`, `memo`.
5. https://developer.apple.com/tutorials/data/documentation/financekit/transactiontype.json — the 17 `TransactionType` cases.
6. https://developer.apple.com/tutorials/data/documentation/financekit/backgrounddeliveryextension.json — `BackgroundDeliveryExtension` (iOS 26.0+), `enableBackgroundDelivery(for:frequency:)`.
7. https://developer.apple.com/tutorials/data/documentation/financekit/financestore/updatefrequency.json — `.hourly`/`.daily`/`.weekly` semantics.
8. https://developer.apple.com/tutorials/data/documentation/financekit/financestore/saveorder(signedarchive:).json — apps can add or update orders. No read API documented.
9. https://developer.apple.com/tutorials/data/documentation/financekitui/transactionpicker.json — `TransactionPicker` (iOS 18.0+).
10. https://developer.apple.com/videos/play/wwdc2024/2023/ — "Meet FinanceKit": field semantics, authorization flow, per-account earliest date, history tokens, compaction, picker being ephemeral, creditDebitIndicator semantics.
11. https://developer.apple.com/videos/play/wwdc2025/201/ — FinanceKit in the UK, background delivery extension (`didReceiveData`, `willTerminate`, frequencies), Mail-based automatic order tracking.
12. https://developer.apple.com/tutorials/data/documentation/walletorders.json — Wallet Orders: merchant-created orders, fields, web service. No third-party read API.
13. https://developer.apple.com/wallet/whats-new/ — Order tracking via Apple Intelligence in Mail (iOS 26). Wallet changes in iOS 27.
14. https://en.smartphones24.org/apps/finance/801312-ios-27-apple-wallet-iphone (snippet) — iOS 27 Wallet order tracking reported in Australia and Canada. Secondary source.
15. https://github.com/sure-admin/swift-sure/pull/18 and https://github.com/we-promise/sure/issues/3485 (snippet) — practitioner notes that FinanceKit background deliveries can be delayed, duplicated or out of order. Secondary source.
16. https://developer.apple.com/app-store/review/guidelines/ — Guidelines 5.1.1(ii), 5.1.1(iii), 5.1.1(ix) (regulated financial services submitted by a legal entity), 5.1.2.
17. https://developer.apple.com/tutorials/data/documentation/appstoreserverapi.json — App Store Server API scope: your app's customers only.
18. https://developer.apple.com/tutorials/data/documentation/storekit/transaction.json — StoreKit `Transaction` = purchase "in your app".
19. https://developer.apple.com/tutorials/data/documentation/storekit/appstore/showmanagesubscriptions(in:).json — the manage-subscriptions sheet shows only the calling app's subscription.
20. https://developer.android.com/google/play/billing — Play Billing scope (your app's digital goods). Billing Library 8+ deadline of 2026-08-31.
21. https://developer.android.com/google/play/billing/integrate — `queryPurchasesAsync()` for processing your app's purchases.
22. https://raw.githubusercontent.com/monzo/docs/master/source/index.html.md — "not suitable for building public applications… small set of users".
23. https://raw.githubusercontent.com/monzo/docs/master/source/includes/_transactions.md — Monzo transaction fields, categories, decline reasons, "after 5 minutes… last 90 days".
24. https://raw.githubusercontent.com/monzo/docs/master/source/includes/_webhooks.md — `transaction.created`, payload and merchant fields, retry policy.
25. https://raw.githubusercontent.com/monzo/docs/master/source/includes/_authentication.md — in-app approval, token expiry, refresh tokens for confidential clients only, one token per user.
26. https://raw.githubusercontent.com/up-banking/api/master/README.md — Up API in beta, Personal Access Token only.
27. https://raw.githubusercontent.com/up-banking/api/master/v1/openapi.json — Up transaction attributes, `HELD`/`SETTLED`, webhook event types, `X-Up-Authenticity-Signature`.
28. https://github.com/starlingbank/api-samples, https://raw.githubusercontent.com/starlingbank/developer-resources/master/README.md, https://raw.githubusercontent.com/starlingbank/starling-developer-sdk/master/README.md — Starling Public API and Payment Services API samples. The SDK is archived and unsupported.
29. https://github.com/Investec-Developer-Community/investec-swagger, https://raw.githubusercontent.com/Investec-Developer-Community/investec-swagger/main/swagger/sa-card-code.json, https://raw.githubusercontent.com/Investec-Developer-Community/investec-swagger/main/skills/investec-card-code/SKILL.md, https://raw.githubusercontent.com/Investec-Developer-Community/investec-swagger/main/skills/investec-pb-account-info/SKILL.md, https://raw.githubusercontent.com/Investec-Developer-Community/investec-dev-quest/main/README.md — Investec Card Code endpoints and the `beforeTransaction`/`afterTransaction`/`afterDecline` templates, PB account-information endpoints, OAuth.
30. https://raw.githubusercontent.com/revolut-engineering/revolut-openapi/master/yaml/open-banking.yaml — Revolut Open Banking API: regulated TPPs, AIS endpoints, transaction fields, 5-minute / 90-day rule.
31. https://raw.githubusercontent.com/revolut-engineering/revolut-openapi/master/yaml/business.yaml — Business API limited to Revolut Business customers' own processes.
32. https://raw.githubusercontent.com/revolut-engineering/revolut-openapi/master/yaml/revolut-wallet-partner-2026-07-01.yaml — Revolut Wallet Partner API (passes, push-only).
33. https://raw.githubusercontent.com/OpenBanking-Brasil/openapi/main/swagger-apis/credit-cards/2.3.1.yml — Open Finance Brasil credit-card accounts API endpoints and transaction fields (also https://github.com/OpenBanking-Brasil/openapi/tree/main/swagger-apis/credit-cards for versions).
34. https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/reporting_transactions_v1.json — PayPal Transaction Search: partner-network requirement, 3-hour latency, 3-year history, 31-day window, `transaction_info` fields.
35. https://github.com/Enigmatic-Smile/docs (Fidel docs source): `select/index.md` (real-time webhooks, participating stores, countries), `select/transactions.md` (fields, auth/clearing/refund, 48–72 h clearing), `select/cards.md` (linking, no CVV, schemes, `termsOfUse`), `select/webhooks.md` (events, retries, signatures), `select/locations.md` (Location Sync 1–2 weeks), `select/programs.md` ("track all purchases at locations in the program"). [35-note] https://github.com/FidelLimited shows the org named "Astrada" with no public repositories. Also https://docs.fidelapi.com/docs/select/transactions/ (snippet only; domain blocked).
36. https://github.com/lithic-com — Lithic SDKs, OpenAPI and ASA demo repositories.
37. https://raw.githubusercontent.com/stripe/stripe-node/master/src/resources/Issuing/Authorizations.ts — Stripe Issuing Authorization fields, enums, `pending_request` only during `issuing_authorization.request`, respond to the webhook directly to approve.
38. https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/BalancePlatformRelayedAuthorisationNotification-v4.json — Adyen relayed authorisation request and response fields, two-second window and fallback logic.
39. https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/BalancePlatformTransactionNotification-v4.json — `balancePlatform.transaction.created`, `pending`/`booked`.
40. https://raw.githubusercontent.com/marqeta/marqeta-openapi/main/yaml/CoreAPI.yaml — Gateway JIT Funding, Commando Mode fallback, `GATEWAY_JIT` subnetwork, transaction webhooks.
41. https://raw.githubusercontent.com/lithic-com/lithic-openapi/main/lithic-openapi.yml, https://raw.githubusercontent.com/lithic-com/asa-demo-python/main/README.md, https://raw.githubusercontent.com/lithic-com/asa-demo-node/main/README.md — ASA HMAC secret retrieve and rotate (old key deactivated after 24 h), example ASA rules on `merchant.mcc` and `merchant.state`.
42. https://raw.githubusercontent.com/visa/ai/main/README.md, https://raw.githubusercontent.com/visa/trusted-agent-protocol/main/README.md (also https://github.com/visa) — Visa Intelligent Commerce and Trusted Agent Protocol, PAR for cards on file.
43. https://registry.npmjs.org/fidel-react-native — Fidel React Native SDK 3.2.1 released 2026-07-23 (shows active maintenance).
