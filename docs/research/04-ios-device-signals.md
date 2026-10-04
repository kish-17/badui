# 04 — iOS Device Signals for BRAKE

> **Scope.** Every iPhone-side mechanism that could give BRAKE a PRE-SPEND, IN-SPEND or POST-SPEND signal, or a low-friction surface for intervening and labeling. Covered: the Shortcuts Wallet **Transaction** trigger and **App** trigger; the Screen Time API (FamilyControls, ManagedSettings, ManagedSettingsUI, DeviceActivity, and the new EU-only FamilyActivityData); App Intents (Siri, Spotlight, Action button, Controls, Visual Intelligence); interactive widgets; Live Activities; Share extensions; Safari Web Extensions; notification actions and extensions; the SMS Message Filter extension; clipboard; VisionKit/Vision OCR; Foundation Models (on-device LLM); background execution; plus EU-only TelephonyMessagingKit and NFC HCE. FinanceKit appears only as a cross-reference because stream 02 covers it.
>
> **Research date:** 2026-10-04. Most claims come from Apple's own developer documentation (current set: "The 27 platform releases – June 2026"), the App Review Guidelines, the Apple Developer Program License Agreement (DPLA) and Apple Developer Forums threads. During this session, support.apple.com, apple.com, third-party blogs and academic sites were **blocked by the network egress proxy**. Claims that rest on search-result snippets or on my prior knowledge are marked **(unverified)**.
>
> **Fact-check pass (2026-10-04).** An adversarial review re-checked 52 load-bearing claims against Apple's developer documentation JSON, the App Review Guidelines (last updated June 8, 2026), the DPLA (Schedule 1 last updated August 18, 2026) and the cited forum threads. Corrections are made inline and marked **[corrected 2026-10-04]**. The most important ones: (1) the current DPLA §3.3.3(P) text differs from what this document originally quoted. It now requires the app's **primary purpose** to be family controls or individual device and focus management, and it contains **no explicit "no off-device transmission" clause**. (2) FinanceKit is **US + UK**, and in the US it covers only Apple Card, Apple Cash and Savings. (3) `secondaryButtonSubmenuItems` is iOS 26.4+, with at most three items. (4) An NSE **can** silence pushes, with a managed entitlement. See the "Verification log" at the end.
>
> ### Key takeaways for BRAKE
>
> 1. **iPhone has no passive way to read bank or UPI alerts.** iOS has nothing like Android's `NotificationListenerService`, no SMS-inbox API outside the EU default-messaging-app path, and no accessibility-service equivalent. A Notification Service Extension can only modify **BRAKE's own** remote pushes. "User B" (iPhone + USA) therefore gets near-real-time sensing only from (a) the Shortcuts Wallet Transaction trigger, (b) FinanceKit (stream 02; in the US only Apple Card, Apple Cash and Savings; in the UK open-banking accounts, iOS 18.4+ [corrected 2026-10-04]), (c) server-side aggregators relayed by push, or (d) things the user starts.
> 2. **The Shortcuts Wallet "Transaction" trigger is the only near-real-time IN-SPEND/POST-SPEND signal on iPhone that needs no entitlement.** It fires when the user taps an Apple Wallet card or pass and passes *card or pass*, *merchant* and *amount* into an App Intent. It can be set to *Run Immediately*. Its weaknesses: it covers **Apple Pay only**, the **user has to set it up by hand**, and it is **unreliable**. Forum reports from Oct 2024 to Feb 2026 describe timeouts while waiting for issuer data (FB14035016, FB16379100, unresolved). Reports from 2025 describe occasional empty merchant or `0.0` amount, and the trigger fires on **declined** transactions (reported Oct 2024). Whether taps made with **Apple Watch** fire the iPhone automation is **unverified**. The only source is one unanswered March 2026 forum question [F4]. **[corrected 2026-10-04]** Its observations must enter as `status=intent|pending` with medium confidence, never as `confirmed`.
> 3. **Screen Time shields are BRAKE's strongest PRE-SPEND lever on iOS.** The user picks shopping apps or sites in `FamilyActivityPicker`. BRAKE then shields them with a custom `ShieldConfiguration`: title, subtitle, two buttons, and, **from iOS 26.4**, a secondary-button submenu of **up to three** items [D-ST3a]. **New in iOS 26.5:** `ShieldActionResponse.openParentalControlsApp` lets the shield hand off to BRAKE's own "Should I buy this?" flow, which Apple had said since 2022 was "no supported way" to do. Distribution requires Apple's Family Controls entitlement. Mar–Apr 2026 forum threads report a review **backlog** (waits of 9–10+ days), and in April 2026 Apple DTS said approval is now **team-scoped**. **[corrected 2026-10-04] Eligibility risk:** the DPLA now requires an app that uses Family Controls to have a *primary purpose* of family controls or individual device/focus management (§3.3.3(P), Aug 2026). BRAKE's primary purpose is spending decisions, so App Review must confirm eligibility before BRAKE commits to shields (see Risks).
> 4. **Policy firewall: data from the Screen Time API must stay on the device and stay in the friction feature.** **[corrected 2026-10-04]** The DPLA in force as of 2026-10-04 (Schedule 1 last updated August 18, 2026) has four relevant parts. First, the app must have a **primary purpose** of (1) family controls for parents/guardians through Family Sharing and/or (2) "offering individuals the ability to manage their devices to enable focus and productivity through focus controls, timers and task management, or personal device usage management". Second, "Device or usage data received through the Family Controls Framework may only be used for providing family controls, or individual device management". Third, it may not be shared "beyond the family controls You provide, or the individual and their device, respectively". Fourth, it may not be used for advertising or shared with data brokers [P2]. The wording this document originally quoted ("for any purpose other than providing parental controls and app and website usage controls", plus an explicit off-device transmission ban) is **not** in the current text. Keeping the data on the device is still the conservative reading of "the individual and their device", but it is an interpretation, not a quoted rule. App Review Guideline 4.10 bans monetising "Screen Time APIs" (confirmed). BRAKE's schema still needs a `device_local_only` data class that the sync and analytics pipelines physically cannot read.
> 5. **One-tap labeling works on iOS, within limits.** The HIG allows **up to four** action buttons in the expanded notification view. `UNNotificationCategory` docs say banners show **only the first two**. A `UNTextInputNotificationAction` gives free text, and a Notification Content Extension (iOS 12+) can render interactive custom chips. The brief's "top predicted choices" maps to *2 predicted labels (shown in the banner) + a third label + "Other…" as a text-input action*. That is four actions in total, the HIG maximum. Anything more needs the content extension. **[corrected 2026-10-04: original text implied five actions]**
> 6. **User-initiated capture is cheap, global and low-risk, so it should be the iOS MVP backbone ("User C").** The pieces: App Intents / App Shortcuts (Siri, Spotlight, Action button, Control Center controls); a Share extension for product URLs and screenshots; `UIPasteControl` for prompt-free paste; `DataScannerViewController` (A12+, `TextContentType.currency`, barcodes and QR); `RecognizeDocumentsRequest` (iOS 26) for receipts; and a Safari Web Extension with per-site permission for web checkout.
> 7. **Do not use the SMS Message Filter extension as a transaction feed.** It only sees SMS/MMS from **unknown senders**. It "can't write data to containers shared with the containing app" and "can't access the network directly". Its only off-device path is a system-made POST of `{sender, message.text}` to the developer's server. Guideline 2.5.12 forbids using that data "for any purpose not directly related to operating or improving your app or extension". → **avoid**.
> 8. **The EU-only, iOS 26.4+ features are not worth using.** `approvedWithDataAccess` + `FamilyActivityData` give real bundle IDs, visited domains and usage. Only **one app per device** can hold that status, and granting it switches off Apple's own Screen Time data. TelephonyMessagingKit (iOS 26, EU only) needs BRAKE to become the user's **default SMS app**. NFC HCE `CardSession` is EEA-only, managed-entitlement HCE for payments and other credentials (keys, transit, badges, loyalty, tickets). All three → avoid, but record them in the capability registry. The consent sheet itself says "Screen Time will lose access to this data as only one app or service can access it at a time" (quoted in [F15]).
> 9. **Local processing is now realistic on iPhone, but device-gated.** The Foundation Models framework (iOS 26+, Apple Intelligence devices only) offers guided generation (`@Generable`) and a `contentTagging` use case. Apple's Feb 2026 note cites a 4,096-token context window. In iOS 27 it adds image prompts with Vision `OCRTool` and `BarcodeReaderTool`. Together with Vision's `RecognizeDocumentsRequest` this allows on-device parsing of receipts and screenshots. The capability registry must therefore model **device class** (A12+, Apple Intelligence-eligible), not just OS version.
> 10. **Background execution is the binding constraint.** App Intents and refresh tasks get about **30 s** in the background (`LongRunningIntent`, new in iOS 27, can extend this if progress is reported). Background pushes are throttled, and nothing runs persistently. iOS adapters must be short, event-driven handlers. Server-side observations (e.g., Plaid webhooks) should arrive as **end-to-end-encrypted pushes that a Notification Service Extension decrypts and renders on the device**.

---

## Conventions used below

Each source maps to an adapter that emits a normalized `Observation`. It is fused later into a `TransactionCandidate` as described in `docs/brief.md`. The shorthand used in each section:

```
Observation {
  source_id            // stable kebab-case id, e.g. ios-shortcuts-wallet-transaction-trigger
  observed_at          // device clock when the adapter ran
  event_time_estimate  // best estimate of when the real-world event happened
  kind                 // purchase_intent | payment_event | label | context | friction_event
  amount?, currency?, merchant_raw?, instrument_hint?, url?, items?[]
  status_hint          // intent | pending | confirmed | unknown
  confidence           // 0..1, per field where useful
  provenance_text      // human sentence for "How did BRAKE know this?"
  locality             // device_local_only | syncable
  raw_ref?             // pointer to minimal retained raw payload (if any)
}
```

`locality = device_local_only` marks data that platform terms forbid moving off the device, Screen Time data in particular.

---

## Sources investigated

### 1. Shortcuts personal automation — Wallet "Transaction" trigger (`ios-shortcuts-wallet-transaction-trigger`)

**What it is.** iOS 17 added a **Transaction** trigger to Shortcuts personal automations. It runs a shortcut "whenever you tap a card or pass from Apple Wallet" [S1, S2]. One guide says the Wallet trigger only appears from iOS 17.4 with Apple Pay set up [S3] (unverified). Filters: pass type (**Payment, Transit, Access, Identity**), specific **cards**, purchase **category**, and specific **merchants** [S2 snippet].

**Data actually available (as of 2026-10-04).**
- The trigger hands the shortcut a transaction input. Third-party write-ups name its fields as **card or pass**, **merchant** and **amount** [S2 snippets]. A developer's App Intent in the forums receives `@Parameter var merchant: String` and `@Parameter var amount: Double` from it [F1].
- Whether **category**, **currency** or **transaction type** come out as output variables, rather than only as filters, is **unverified**. Apple's page (support.apple.com) was blocked in this session.
- **No transaction identifier** is exposed (none appears in any source consulted).
- How the data reaches BRAKE: the user's automation calls one of BRAKE's App Intents (e.g., *Log Wallet Transaction*) with the trigger's variables as parameters. Since iOS 26 the intent declares `supportedModes = .background` [D-AI3], replacing the deprecated `openAppWhenRun` [D-AI2], so it can run without opening BRAKE. It gets the standard background budget of about **30 s** [D-AI4]. Within that time BRAKE can write the observation and post a local labeling notification.

**Windows & latency.** **IN-SPEND / immediate POST-SPEND.** It fires at tap time, but merchant and amount come from the card issuer's feed into Wallet. The system log line `WFWalletTransactionProvider observeForUpdatesWithInitialTransactionIfNeeded… Hit timeout waiting for transaction` shows Shortcuts **waits** for issuer data and gives up when it is late [F2]. Typical latency is seconds. If the issuer is slow, the automation times out and never runs; one report saw Wallet receive the data more than 3 hours late [F2].

**Coverage.**
- iPhone only, and only for Apple Pay taps. **[corrected 2026-10-04]** Apple Watch: a March 2026 forum question (0 replies) says the developer "couldn't find any way to make it work on my Apple Watch" [F4]. That shows the automation can't be built on the Watch. It does **not** establish whether Watch-initiated payments fire the iPhone automation, which remains **unverified** and needs a device test.
- **Unverified:** whether it fires for **online or in-app Apple Pay**; the trigger is labeled "When I tap".
- Countries: wherever Apple Pay works **and** the issuer pushes transaction details to Wallet. Strongest in the US, UK and EU (unverified per issuer).
- **India:** Apple Pay was not available as of my last verified knowledge, so the trigger is effectively unavailable there (unverified as of 2026-10-04).
- Reach: a self-selected, opt-in subset of iPhone users. Setting it up takes several steps.

**Access requirements.**
- No entitlement or partnership is needed.
- BRAKE cannot create the automation programmatically. The user builds it in Shortcuts, picks the cards, adds BRAKE's action and turns on *Run Immediately* [S3, S4].
- BRAKE can provide a guided setup screen and a template shortcut.
- It cannot be tested in the Simulator; a real device with a provisioned card is needed [F5].

**Privacy & consent model.** The consent is the user's own act of building the automation. They choose which cards and merchants. BRAKE never sees cards the user excluded. The data is minimal: merchant, amount and card label, with no PAN. Disconnecting means deleting or disabling the automation, which BRAKE cannot detect directly. BRAKE should also offer an in-app "ignore Wallet events" switch.

**Reliability & failure modes.** (All from Apple Developer Forums; Apple has published no fix as of the last posts.)
- **Timeouts** when issuer data is late. Reported from iOS 18 onward and still open in Feb 2026. Mastercard (Cembra) users fail consistently while Visa users report success [F2, F3, F6].
- The **trigger fires for declined transactions** [F2].
- **Occasional empty merchant (`" "`) and `0.0` amount** when the values are passed to a custom App Intent. Built-in actions such as Messages received them reliably (Aug–Oct 2025, DTS involved, cause unknown) [F1].
- Automations "stopped working" after OS updates (Jun 2024 to Feb 2025) [F3, F6].
- Workarounds users report: turn off notification summarisation for Wallet, or reset Wallet and re-add cards [F2].
- BRAKE can't tell when the automation is broken. It needs a **heartbeat**: track `last_fired_at` and compare it with other evidence of card use, such as FinanceKit or Plaid transactions with no matching tap.

**Dedup / reconciliation keys.** None native. Match on `(amount, merchant normalized, card label → instrument, event_time ± window)` against FinanceKit `Transaction` (`transactionAmount`, `merchantName`, `transactionDate`, `accountID`) [D-FK2]. In the US that works only for Apple Card or Apple Cash taps; in the UK, for cards from FinanceKit-connected open-banking institutions (see source 2) **[corrected 2026-10-04]**. Otherwise match against aggregator data (Plaid `transaction_id` / `pending_transaction_id` — stream 01). The card label (e.g., "Apple Card", "Chase Sapphire") is a useful **instrument hint**.

**Normalized observation.** `kind=payment_event`, `status_hint=pending`. The trigger can fire on declines, so it never maps to `confirmed`.
- `amount`: confidence about 0.8 when > 0. Treat `0.0` as *missing*, not zero.
- `currency`: **unknown**. Infer it from card or locale with low confidence.
- `merchant_raw`: confidence about 0.8; treat blank as missing.
- `instrument_hint` = card name.
- `event_time_estimate` = invocation time.
- Overall confidence is medium (about 0.6–0.75) until matched with a bank or FinanceKit record.

**Provenance sentence.** "Detected when you paid with your Apple Wallet card *Chase Sapphire* (via your Shortcuts automation)."

**Recommendation: `mvp` (opt-in, labeled "beta").** It is the only real-time spend signal for iPhone users in the US, UK and EU that needs no entitlement. It enables the brief's "₹500 at Swiggy — food spending this week is now 38% above your usual pace" moment within seconds of a tap. The setup cost and reliability problems justify opt-in only, a health indicator, and never relying on it alone.

---

### 2. FinanceKit — cross-reference only (`apple-financekit`)

*Stream 02 covers this in depth; this section only records how it interacts with the iOS device signals here.*

- **What:** on-device access to financial data held in Wallet (accounts, balances, transactions) plus Wallet **orders**. iOS 17.0+ [D-FK1].
- **Access:** you must meet Apple's criteria, request the **managed FinanceKit entitlement**, hold an **organization-level** developer account (Account Holder), and include `NSFinancialDataUsageDescription`. Apple reviews each application [D-FK1].
- **Transaction fields:** `id` (UUID, internal), `accountID`, `transactionDate`, `postedDate?`, `transactionAmount` (`CurrencyAmount`), `transactionDescription`, `originalTransactionDescription`, `transactionType`, `status`, `creditDebitIndicator`, `merchantName?`, `merchantCategoryCode?` (ISO 18245), `foreignCurrencyAmount?`, `foreignCurrencyExchangeRate?` [D-FK2].
- **New in iOS 26:** `BackgroundDeliveryExtension` delivers changes to the finance store outside the app's lifecycle via `enableBackgroundDelivery(for:frequency:)` [D-FK3]. FinanceKitUI's `TransactionPicker()` (June 2024) lets the user hand over **selected** transactions only [D-FK4], a privacy-friendly alternative to granting all history.
- **Orders:** the documented API only **saves** orders (`saveOrder(signedArchive:)`) [D-FK1]. No API to *read* the user's Wallet orders appears in the topic list, so BRAKE can't use Wallet order tracking as a signal (inferred from the docs).
- **How it combines with source 1:** FinanceKit can **confirm** a Wallet-tap observation only when the tapped card is itself exposed through FinanceKit: same device, same card, and an `id`/`status` that tracks pending → booked. In the US that means Apple Card or Apple Cash only. A tap with a third-party US card (e.g., a Chase card in Wallet) has **no** FinanceKit counterpart and needs an aggregator to confirm it. **[corrected 2026-10-04]**
- **Coverage [corrected 2026-10-04, per developer.apple.com/financekit/]:**
  - **US:** iOS 17.4+, and "currently supports" only **Apple Card** (excluding Apple Card Family participants), **Apple Cash** (excluding children on Apple Cash Family) and **Savings**.
  - **UK:** iOS 18.4+. It "uses open banking to access various financial data in the U.K." from institutions including Barclays, Barclaycard, First Direct, Halifax, HSBC, Lloyds, M&S Bank, MBNA, Monzo, Nationwide, NatWest, RBS and Santander.
  - **Eligibility:** the app must be in the **Finance** category, distributed on the App Store for iPhone in the US or UK, and provide financial-management tools (e.g., budgeting) [D-FK5].
- **Recommendation: `next`** (decision owned by stream 02).

---

### 3. Shortcuts personal automation — "App" opened/closed trigger (`ios-shortcuts-app-open-trigger`)

**What it is.** A personal automation that runs "When *App* is Opened / Closed". BRAKE can use it for **launch friction**: opening Amazon or Myntra runs a BRAKE App Intent that brings up a pause or "Should I buy this?" screen. This is the original **one sec** pattern. one sec and **Opal** now mainly use the Screen Time API (prior-art details unverified in this session; their sites were blocked).

**Data available.** Only that a user-chosen app was opened or closed, and which one; BRAKE knows it from the parameter baked into the automation. Nothing about what happens inside the app.

**Windows & latency.** **PRE-SPEND.** It fires on app launch, before browsing, with sub-second latency.

**Coverage.** Global, iPhone and iPad, no entitlement, every app the user picks.

**Access requirements.** The user builds one automation per app by hand. Apps can't create automations. The intent needs `supportedModes` that include foreground (e.g., `.foreground(.immediate)`) to show UI [D-AI3].

**Privacy & consent.** The user explicitly chooses the apps. The data is minimal and stays on the device.

**Reliability & failure modes.**
- An iOS 26.6 regression (Aug 2026) makes **"When App Is Closed" fire when Control Center or Notification Center opens**. Three posters reproduced it (iPhone 13 mini, 13 Pro Max, 17 Pro Max), the OP filed FB24505842, and DTS asked for the bug number; no fix has been posted [F7]. **[corrected 2026-10-04]** An earlier version of this line quoted users reporting "automation-driven screen time friction mechanisms failing". That phrase does **not** appear in the thread and has been removed. The impact on launch-friction automations is an inference: a spurious "closed" event can end a pass-through window early.
- **Loop risk:** BRAKE sends the user back to the shopping app, which re-triggers the automation. One sec-style apps keep a short "pass-through" window; BRAKE must do the same.
- The automation can be deleted silently, so BRAKE needs a heartbeat here too.
- On some OS versions a "Running your automation" banner may appear (iOS 18 behaviour noted in [F3]; current behaviour unverified).

**Dedup keys.** Not a transaction. Store it as a `friction_event` / `purchase_intent` context with `(app, time)`.

**Normalized observation.** `kind=context` (shopping-app session start), `status_hint=intent`, low confidence of spend (about 0.1–0.3 prior, learnt per user). Store it as `device_local_only`; that is not required by policy here, but it is better practice.

**Provenance.** "You asked BRAKE to check in whenever you open *Amazon* (Shortcuts automation)."

**Recommendation: `mvp` as the no-entitlement fallback** while the Family Controls entitlement is pending, and for users who prefer it. It should be replaced by Screen Time shields (source 4) wherever the entitlement is granted. **[corrected 2026-10-04]** Because of the DPLA §3.3.3(P) primary-purpose clause, the entitlement may never be granted to a spending app. Plan for this to be the long-term iOS launch-friction path, not just a stopgap.

---

### 4. Screen Time API — FamilyControls + ManagedSettings shields + ShieldConfiguration/ShieldAction (`ios-screen-time-shields`)

**What it is.**
- **FamilyControls** authorizes the app (iOS 15+). It supports *child* authorization (approved by a parent or guardian) and **individual** authorization, where the device owner approves with biometrics (iOS 16+) [D-ST1].
- `FamilyActivityPicker` lets users "specify applications, web domains, and categories **without revealing their choices to the app**". The app receives opaque `ApplicationToken`, `WebDomainToken` and `ActivityCategoryToken` [D-ST1, D-ST2].
- **ManagedSettings** `ManagedSettingsStore` applies shields to those tokens (applications, categories, web domains) [D-ST2].
- **ManagedSettingsUI** extensions customise the shield (`ShieldConfigurationDataSource`) and handle its buttons (`ShieldActionDelegate`) [D-ST4, D-ST5].

**Data available.**
- **The main app** gets tokens only. It learns nothing about which apps the user picked.
- **The ShieldConfiguration extension** "is provided with the display names, bundle identifiers, and domains for each application, website, or category it shields". It "runs in a sandbox" that "prevents your extension from making network requests or moving sensitive content outside the extension's address space". It must return quickly or the system uses the default look [D-ST4].
- **Customisable fields** (`ShieldConfiguration`): `backgroundBlurStyle`, `backgroundColor`, `icon`, `title`, `subtitle`, `primaryButtonLabel`, `primaryButtonBackgroundColor`, `secondaryButtonLabel`, `secondaryButtonSubmenuItems: [String]?` [D-ST3].
  - **[corrected 2026-10-04]** `secondaryButtonSubmenuItems` is **iOS/iPadOS 26.4+**. Apple says to "add up to three array elements", and the system adds a Cancel item. Taps arrive in `ShieldActionDelegate` as `ShieldAction.firstSecondarySubmenuItemPressed`, `.secondSecondarySubmenuItemPressed` and `.thirdSecondarySubmenuItemPressed` [D-ST3a]. Before 26.4 the secondary button is a single action.
  - BRAKE can show, for example: *title* "Pause before you shop?", *subtitle* "₹2,300 left in your fun budget this week", *primary* "Not now", *secondary* "I need something" with submenu "Planned purchase / Essential / Just browsing".
  - The budget text has to come from an App Group store the extension can read. A forum report says SwiftData in the shield extension fails, and developers fall back to `UserDefaults(suiteName:)` [F8].
- **ShieldActionDelegate** gets **tokens, not names** ("The system doesn't provide the name of a shielded Application…") [D-ST5]. It returns a `ShieldActionResponse`: `.none`, `.close`, `.defer`, and from **iOS 26.5** `.openParentalControlsApp` ("open your parental controls app that is responsible for shielding the application") [D-ST6, D-ST7].
  - Before 26.5, Apple said in 2022 and again in Jan 2025 that there was "no supported way for … your extension to open your main app". Some apps used the private `LSApplicationWorkspace` and were **rejected** (May 2026). The supported workaround was a local notification plus deep link, at the cost of about 1 s and an extra tap [F9].
  - The May 2026 forum post asking for an "open containing app" response predates or ignores the 26.5 docs. **Confirm on a device** that `.openParentalControlsApp` works for *individual* authorization, and find out what context (if any) reaches the app.

**Windows & latency.** **PRE-SPEND** (and IN-SPEND if Safari checkout domains are shielded). The shield appears when the app opens, with no delay.

**Coverage.**
- Global on iOS/iPadOS 16+ for individual authorization. Available on Mac Catalyst. Authorization always fails in iPad/iPhone apps running on visionOS [D-ST1].
- Web-domain shields cover Safari. Coverage in third-party browsers and in-app web views is **unverified**.
- A forum thread asks whether personal Screen Time data access is supported in Türkiye; the answer is unknown [F10].

**Access requirements.**
- The `com.apple.developer.family-controls` capability. Before distribution the Account Holder must request it at `developer.apple.com/contact/request/family-controls-distribution`.
- The docs say to submit the same request for **each** Screen Time extension (Monitor, Report, Shield Action, Shield Configuration) [D-ST8]. In **April 2026** Apple DTS said: "If Apple approves your request, the entitlement is scoped to your team. You no longer need to submit a request for individual bundle IDs" [F11].
- **Backlog:** developers reported waits of 9 to 10+ days with no response for requests filed in late March 2026 [F11, F12]. Longer waits ("more than a month") are **unverified** and do not appear in the threads checked. DTS (Apr 2026): "Our team is working to clear the backlog. Please file a code-level support if you are still having issues" [F12]. Some apps were also stuck in review for about two weeks after automated Guideline 2.5.1 messages about the entitlement (Aug 2026, threads 838802 and 844034) [F10]. **[corrected 2026-10-04]**
- **Policy:**
  - **[corrected 2026-10-04]** DPLA §3.3.3(P), as of the Aug 18, 2026 DPLA [P2]:
    - **Primary purpose:** "To use the Family Controls Framework, Your Application must have a primary purpose of (1) offering family controls for parents and guardians, through Family Sharing, to supervise their children's app usage; and/or (2) offering individuals the ability to manage their devices to enable focus and productivity through focus controls, timers and task management, or personal device usage management."
    - **Excluded uses:** "The Family Controls Framework may not be used for other purposes, such as ad blocking, in organizational settings, or for managing the device of another adult individual."
    - **Data use:** "Device or usage data received through the Family Controls Framework may only be used for providing family controls, or individual device management."
    - **Sharing:** you "may not share device or usage data received through the Family Controls Framework or otherwise, beyond the family controls You provide, or the individual and their device, respectively."
    - **Advertising:** no advertising or advertising-measurement use, and no sharing with data brokers.
    - **No explicit off-device transmission ban** appears in this text. The earlier quote in this document came from an older or unverified version.
    - **Implication for BRAKE:** the binding constraint is now **eligibility**. A spending-decision app does not obviously have device usage management as its *primary* purpose. Before building on shields, get written or consultation guidance from App Review, and frame the entitlement request around personal device usage management of shopping apps.
  - Guideline 4.10: "You may not monetize … Screen Time APIs" [P1]. A paid tier can't be "pay to unlock shielding" as such; make shielding part of a broader paid product, and get App Review sign-off.
  - Guideline 2.5.1 requires APIs to be used for their intended purposes [P1]. Shopping-app friction fits the DPLA's definition of the framework ("Documented APIs that enable Your Application to provide app and website usage controls"). The open risk is the separate *primary purpose* requirement above. Say so explicitly in the entitlement request.

**Privacy & consent model.** Strongest on iOS. There is a system biometric consent sheet, a token-based picker, sandboxed extensions, and the user can revoke in Settings at any time. A forum thread notes that on iOS 26.4 revoking needs only Face ID, not the Screen Time passcode [F10]. That is good for user autonomy, though self-control users may see it as a bypass.

**Reliability & failure modes** (forums, 2025–2026) [F10, F13]:
- `TokenExpiryMessage` reports `.tokensDidExpire` for about 30% of new users immediately (Aug 2026). Feedback FB23391495 shows "Potential fix identified - For a future OS update", and the OP later reported that the fix is in iOS 27 beta 8 (build 24A5430a) [F13]. Shipping status is unverified as of 2026-10-04.
- Monitor extensions stop being invoked after days without the host app launching, and don't wake after a force-quit.
- Possible `eventDidReachThreshold` regression in iOS 26.2.
- Blocking Facebook also silently blocks Meta's Muse app, behind a generic Apple shield.
- Transferring the developer account leaves duplicate Screen Time entries.
- The entitlement works in development but fails in distribution.

**Dedup keys.** Not a transaction. Tokens are opaque, stable per app and device, and may expire.

**Normalized observation.** `kind=friction_event` with fields `{shield_shown, user_choice ∈ {not_now, planned, essential, just_browsing, open_brake}, time}` and `locality=device_local_only`. The token is not stored outside App Group storage. The user's submenu choice is **user-entered** data, but it is collected *through* a Family Controls surface. The conservative reading of §3.3.3(P) is to keep even that choice on the device unless the user re-enters it in BRAKE's main app (open question).

**Provenance.** "BRAKE showed this pause because you chose to add *Shopping apps* to your BRAKE pause list."

**Recommendation [corrected 2026-10-04]: `research` → `mvp` once eligibility is confirmed.** In week 1, book an App Review consultation and file the distribution-entitlement request. The DPLA primary-purpose clause makes approval for a spending app uncertain, on top of the backlog. Until approval, and permanently if it is refused, fall back to source 3. Shields carry out the brief's "selected app shielding / shopping app launch friction" with the best privacy properties on any platform. The tone must follow the brief: user-chosen, easy to skip, and no scolding copy.

---

### 5. Screen Time API — DeviceActivity monitor (`ios-deviceactivity-monitor`)

**What it is.** `DeviceActivityCenter.startMonitoring(_:during:events:)` with a `DeviceActivitySchedule` and `DeviceActivityEvent` thresholds over tokens. A `DeviceActivityMonitor` extension receives `intervalDidStart`, `intervalDidEnd` and `eventDidReachThreshold`. Callbacks arrive only while the device is in use [D-ST9, D-ST10].

**Data available.** Callbacks only, e.g., "the *shopping* selection reached 15 min today". There are no per-app names; the extension holds tokens.

**Windows & latency.** **PRE-SPEND.** For example: "20 minutes in shopping apps after 11 pm" → apply a shield, or schedule a gentle nudge. Latency is minutes, depending on the threshold granularity.

**Coverage / access / privacy.** The same as source 4: same entitlement and same §3.3.3(P) limits. Monitor extensions must use exactly the extension point `com.apple.deviceactivity.monitor-extension` (ITMS-90349 otherwise) [F10].

**Reliability.**
- Using schedules as a periodic "wake" mechanism is undocumented (unanswered thread, Sep 2026) [F14].
- Network budget in the extension: unverified.
- Invocation drops after days without an app launch [F10].
- Minimum schedule length and the maximum number of monitored activities are commonly reported as 15 min and 20 (**unverified**).

**Normalized observation.** `kind=context` ("extended shopping-app session"), `device_local_only`, used only to decide friction.

**Provenance.** "BRAKE noticed a long shopping session (Screen Time, on this iPhone only)."

**Recommendation: `next`.** It is useful for "late-night e-commerce" patterns. Do not use it as a general-purpose profiling feed, because of §3.3.3(P) purpose limitation.

---

### 6. Screen Time API — DeviceActivityReport extension (`ios-deviceactivity-report`)

**What it is.** A SwiftUI `DeviceActivityReport` view rendered by a report extension (`com.apple.deviceactivityui.report-extension`, iOS 16+). The extension sees activity data, but "runs in a sandbox" that "prevents your extension from making network requests or moving sensitive content outside the extension's address space" [D-ST11].

**Use for BRAKE.** It can only **display** shopping-app time inside BRAKE's UI, e.g., "You spent 3 h in shopping apps this week". BRAKE's logic can never read it.

**Windows.** POST-SPEND reflection only (latency: daily or hourly segments).

**Recommendation: `later`.** It adds little decision value and can't feed fusion.

---

### 7. EU-only non-tokenized usage data — `approvedWithDataAccess` / `FamilyActivityData` (`ios-familyactivitydata-eu`)

**What it is (iOS/iPadOS 26.4+).**
- The `com.apple.developer.family-controls.app-and-website-usage` entitlement and the `AuthorizationStatus.approvedWithDataAccess` status let an app use `FamilyActivityData` (`installedApplications`, `visitedWebDomains`, `activityCategories`) and `DeviceActivityData.activityData(filteredBy:using:)` to see **real bundle IDs, domain names and category names** [D-ST12, D-ST13, D-ST14].

**Hard constraints.**
- "Customer installations of your app can **only** achieve this status on devices located in the EU that are signed in with an Apple Account with an EU country or region". Elsewhere, access fails with `FamilyControlsError.unavailable` [D-ST13].
- "Only one app at a time can hold this authorization status on a given device" [D-ST13]. A forum report says granting it makes **Apple's own Screen Time pane stop showing new usage** [F15].
- DPLA §3.3.3(P) still applies.
- Distribution builds sometimes return `.approved` instead of `.approvedWithDataAccess` (Sep 2026) [F10].

**Windows.** PRE-SPEND context (e.g., which shopping sites the user visits).

**Recommendation: `avoid`, but log it in the registry as EU-only.** Holding it would make BRAKE the user's single Screen Time data holder, which is very invasive for a spending coach. Tokens already cover BRAKE's use case.

---

### 8. App Intents — Siri, Spotlight, Shortcuts, App Shortcuts, interactive snippets (`ios-app-intents-siri-spotlight`)

**What it is.** BRAKE exposes actions such as *Check a purchase* (amount, item, merchant), *Log a spend*, *What's left this week?* and *Start a cooling-off timer* as `AppIntent`s. They are bundled as App Shortcuts that appear automatically in Shortcuts, Siri and Spotlight [D-AI1]. The capabilities have grown each year:
- **June 2024:** controls (see source 9), `IndexedEntity` for Spotlight, URL-representable intents, conditional confirmation [D-AI1].
- **June 2025 (iOS 26):** `SnippetIntent` interactive snippets; Spotlight indexing via `@Property(indexingKey:)`; **visual intelligence** via `IntentValueQuery`; `supportedModes` replacing `openAppWhenRun` [D-AI1, D-AI2, D-AI3].
- **June 2026 (iOS 27):** `LongRunningIntent` (extends the default **30 s** background time, with progress reporting), `CancellableIntent`, `UndoableIntent`, `allowedExecutionTargets`, `RunSystemShortcutIntent` from widgets, and `SyncableEntity` [D-AI1, D-AI4].
- **No finance, payments or shopping app-schema domain exists** for Apple Intelligence. Available domains: Mail, Photos, Calendar, Messages, Notes, Reminders, Browser, Files, Spreadsheet and so on [D-AI5]. Siri won't natively understand "log a purchase" except through BRAKE's own App Shortcut phrases.

**Data available.** Whatever the user says or types into the parameters, e.g., `IntentCurrencyAmount`, item text, and an optional URL or image (`IntentFile`).

**Windows & latency.** **PRE-SPEND** ("Hey Siri, ask BRAKE if I can afford these ₹3,000 shoes"), **POST-SPEND** manual logging, and **IN-SPEND** if the user calls it at checkout. Latency is immediate.

**Coverage.** Global, iOS 16+, with richer features on 26+. Siri language coverage varies (unverified per locale). Apple Intelligence features need eligible devices.

**Access.** No entitlement. App Shortcut phrase rules (e.g., must include the app name) and a cap of about 10 App Shortcuts per app come from WWDC22 guidance (**unverified** in this session). Apple "may extract anonymized App Shortcuts data such as localized phrases…" [D-AI6].

**Privacy.** Started by the user, and the data is exactly what they provide. Intent donations and Spotlight indexing put BRAKE entities into **system indexes**. Don't index sensitive amounts by default.

**Reliability.** High for foreground intents. Background intents are bounded by about 30 s.

**Normalized observation.** `kind=purchase_intent` (amount, item, merchant?) or `kind=payment_event` with `user_verified=true`, so confidence is high for the user-stated amount.

**Provenance.** "You asked BRAKE via Siri at 21:14."

**Recommendation: `mvp`.** It is cheap, global, high-trust, and the main iOS route to "Should I buy this?".

---

### 9. Controls (Control Center, Lock Screen, Action button) (`ios-controls-action-button`)

**What it is.** WidgetKit controls (`ControlWidgetButton`, `ControlWidgetToggle`, iOS 18+). They let people "customize and configure Control Center, their Lock Screen, and the Action button with actions from your apps" [D-WK1]. A control can run a `LiveActivityIntent` to start a Live Activity from the background [D-LA1].

**Use.** One press opens "Should I buy this?" (camera/price scan or quick entry) or toggles "Shopping mode" (applies shields and starts a Live Activity).

**Windows.** PRE-SPEND and IN-SPEND (at the shelf or the till). Latency is immediate.

**Coverage.** iOS 18+. The Action button is only on newer iPhones (iPhone 15 Pro and later, **unverified** list).

**Recommendation: `mvp`.** It is just a thin shell over the source-8 intents and makes "ask BRAKE" one press.

---

### 10. Interactive widgets (`ios-interactive-widgets`)

**What it is.** Home/Lock Screen widgets with `Button(intent:)` and `Toggle(isOn:intent:)` (iOS 17+) [D-WK2].

**Constraints.**
- No text entry. A "price-entry widget" can't take typing; it must deep-link with `Link`/`widgetURL` or use preset amounts.
- "On a locked device, buttons and toggles are inactive … unless a person authenticates and unlocks".
- Every interaction guarantees a timeline reload.
- An `AppIntent` runs in the **widget extension process** by default; `LiveActivityIntent` and similar run in the app [D-WK2].
- WidgetKit push-driven reloads exist (`WidgetPushHandler`, June 2025) [D-WK1].
- iOS 27 adds `RunSystemShortcutIntent` from widgets [D-AI1].

**Use.** A "this week's discretionary room" glanceable widget, quick-amount buttons (₹200 / ₹500 / ₹1,000 → "check"), and a "Snooze shields 15 min" toggle.

**Windows.** PRE-SPEND (glanceable context). Latency is immediate.

**Privacy.** Lock Screen and Home Screen are visible to others. Default to non-numeric states (e.g., "On track" or "Tight week") and let users opt in to showing amounts.

**Recommendation: `next`.** Useful, but secondary to intents and notifications.

---

### 11. Live Activities & Dynamic Island (`ios-live-activities`)

**What it is.** ActivityKit Live Activities on the Lock Screen and in the Dynamic Island.

**Hard limits** [D-LA1, D-LA2]:
- Active for up to **8 h**, then kept on the Lock Screen up to **4 h more (12 h total)**.
- Static plus dynamic data **≤ 4 KB**.
- It "can't access the network or receive location updates".
- It usually must start in the **foreground**. The exceptions are `LiveActivityIntent` (background start) and push-to-start (updates via push; push-to-start not available on iOS ≤ 17.1, so **17.2+** by inference). iOS 26 added scheduled starts.
- Priority-10 pushes count against an hourly **budget**, while priority 5 does not. `NSSupportsLiveActivitiesFrequentUpdates` is available, but users can switch it off.
- Buttons and toggles via App Intents. Height above 160 pt may be truncated.

**HIG** [D-LA3]: use for "tasks and events that have a defined beginning and end"; "Don't use a Live Activity to display ads or promotions"; "Avoid displaying sensitive information". It is visible on the Lock Screen and in Always-On.

**Use for BRAKE.**
- A user-started **"Shopping trip" session** (e.g., mall visit, up to 8 h) showing remaining discretionary room, with one-tap "Log ₹…" / "Done".
- A **cooling-off timer** ("Decide on the headphones at 9 pm"). Cooling-off periods longer than 8–12 h need a notification instead.

**Windows.** **IN-SPEND** (a persistent companion while shopping). Updates arrive via app or push.

**Recommendation: `later`.** It has good behavioural value, but needs careful privacy-preserving design (numbers hidden by default).

---

### 12. Share extension (`ios-share-extension`)

**What it is.** A Share extension that appears in the share sheet of shopping apps, Safari and Photos. `NSExtensionActivationRule` declares what it accepts:
- `NSExtensionActivationSupportsWebURLWithMaxCount`, `…WebPageWithMaxCount`, `…ImageWithMaxCount`, `…FileWithMaxCount`, `NSExtensionActivationSupportsText`.
- Apple warns that `TRUEPREDICATE` "may result in App Store rejection" [D-SH1].

**Data available.** Whatever the source app shares: product URL (often with tracking parameters), title text, screenshot image, sometimes price in the text. For URLs BRAKE can fetch metadata itself (server or device; privacy trade-off) or run on-device OCR on screenshots (sources 18–19).

**Windows.** **PRE-SPEND** (the canonical "share product to BRAKE" from the brief). Latency is immediate.

**Coverage.** Global, all apps that use the standard share sheet. Some shopping apps share only a short link.

**Privacy.** Strictly user-initiated, and the data is exactly what's shared. Strip tracking parameters before storing.

**Normalized observation.** `kind=purchase_intent {url, title?, price?, merchant_domain}`. Confidence is high for `merchant_domain` and medium for parsed price.

**Provenance.** "You shared this from *Amazon* to BRAKE."

**Recommendation: `mvp`.**

---

### 13. Safari Web Extension on iOS (`safari-web-extension-ios`)

**What it is.** WebExtension-standard extensions shipped inside the app (iOS 15+) [D-SW1].
- **Permissions:** on iOS the user grants per-site access from the extension's entry in Safari's *More* menu. In Settings › Safari › Extensions they can set each site to **Ask / Allow / Deny**.
- Apple recommends `activeTab` and narrow `host_permissions` over `<all_urls>` [D-SW2].
- The extension talks to native code with `browser.runtime.sendNativeMessage` [D-SW1]. Whether the containing app can *initiate* messages on iOS is unverified; use an App Group store.

**Data available.** DOM on permitted sites: product title, price, cart total and checkout step on allow-listed retailer domains. This gives a true **IN-SPEND** signal at web checkout ("Order total ₹4,799 → Place order").

**Windows.** PRE-SPEND (product page) and **IN-SPEND** (checkout page). Latency is immediate.

**Coverage.** Safari only. On iOS, Chrome and other browsers don't run extensions, and in-app web views aren't covered (both **unverified** for 2026). Most Indian mobile commerce happens in apps, not Safari (unverified), so value is higher for US/EU web shoppers.

**Access.** Guideline 4.4/4.4.2: extensions may not include marketing, ads or IAP, and must not interfere with Safari UI [P1].

**Privacy.** Per-site consent and narrow host lists (a merchant allow-list in the capability registry). Never send page contents off the device by default.

**Reliability.** Retailer DOMs change, so per-merchant extractors need maintenance. Use a generic fallback (schema.org `Product`/`Offer` JSON-LD) where present.

**Normalized observation.** `kind=purchase_intent` with `status_hint=intent`, `{merchant_domain, item_titles[], cart_total, currency}`. `order_id` is available on confirmation pages, which is a strong **dedup key** for email receipts (stream on email).

**Provenance.** "Seen on the *amazon.com* checkout page in Safari (you allowed BRAKE on this site)."

**Recommendation: `next`.** It has high value for web shoppers, but limited reach and real maintenance cost.

---

### 14. Notification actions for one-tap labeling (`ios-notification-actions`)

**What it is.** `UNNotificationCategory` with `UNNotificationAction`s (options include destructive; icons since iOS 15) and `UNTextInputNotificationAction` (iOS 10+, with `textInputButtonTitle` and `textInputPlaceholder`) [D-UN1, D-UN2, D-UN3].
- When the user picks an action, "the system launches your app in the background" and calls `userNotificationCenter(_:didReceive:withCompletionHandler:)` with `actionIdentifier` [D-UN1].
- **Limits:** the HIG allows "a customizable detail view that contains **up to four buttons**" [D-UN4]. `UNNotificationCategory.actions` docs say: "When displaying banner notifications, the system displays **only the first two actions**" [D-UN5].
- Interruption levels: `passive`, `active`, `timeSensitive` (breaks through notification controls), `critical` (needs a special entitlement) [D-UN6].

**Design for the brief's "predicted top choices".**
- Before posting a local label prompt, BRAKE registers or refreshes a category whose actions are the **top-2 predicted labels** plus a third and fourth (e.g., "Other…" as a text-input action).
- A Notification Content Extension (source 15) can render more chips.
- Updating categories while earlier prompts are still undelivered could change their buttons; this is a design risk to test (**unverified behaviour**).
- Use `passive` or `active` level, never `timeSensitive`, for labeling. Summary and Focus settings may delay prompts; that is acceptable.

**Windows.** **POST-SPEND** (classification, regret check-in 24–72 h later). Latency: immediate after the triggering observation.

**Coverage.** Global, all iOS versions in scope.

**Policy.** Guideline 4.5.4: push notifications "should not be used to send sensitive personal or confidential information" [P1]. Prefer **locally generated** notifications (from on-device observations) or encrypted pushes decrypted in an NSE (source 16). Default the lock-screen preview to hide amounts if the user prefers.

**Normalized observation.** `kind=label {candidate_id, label, source=notification_action}` with `user_verified=true`.

**Provenance.** "You labeled this *Groceries* from a notification."

**Recommendation: `mvp`.**

---

### 15. Notification Content Extension (custom interactive notification UI) (`ios-notification-content-extension`)

**What it is.** A `UNNotificationContentExtension` view controller that supplements or replaces the default expanded UI. **Interactive controls since iOS 12** via `UNNotificationExtensionUserInteractionEnabled`. It must use only immediately available data (payload, bundle, App Group files) and must not do long-running or network work [D-UN7].

**Use.** A label grid (6–8 predicted chips), a "worth it?" 3-point scale, or a "split / reimbursable" toggle, all inside the expanded notification.

**Windows.** POST-SPEND. **Recommendation: `next`.**

---

### 16. Notification Service Extension — BRAKE's own pushes only (`ios-notification-service-extension`)

**What it is.** It modifies **remote** notifications that have an alert and `mutable-content: 1`, within "a limited amount of time". If it overruns, `serviceExtensionTimeWillExpire()` runs and the original content is shown. It can "decrypt an encrypted data block" and download attachments. It cannot touch silent pushes [D-UN8]. It only sees **BRAKE's own** pushes; no public API reads other apps' notifications.

**Use.** A privacy pattern for server-side sources:
1. BRAKE's server receives an aggregator webhook (Plaid, AA, etc.).
2. It forwards an **end-to-end-encrypted** blob through APNs.
3. The NSE decrypts it with a key that never left the device, writes the observation to the App Group store, runs local fusion, and renders an insight such as "₹500 at Swiggy — food this week is 38% above your usual pace". If nothing is meaningful, it shows a neutral or `passive` notification. **[corrected 2026-10-04]** An NSE **can** suppress an alert push completely if it holds the managed `com.apple.developer.usernotifications.filtering` entitlement (iOS 13.3+): it passes an empty `UNNotificationContent()` to the content handler. Apple grants this entitlement on application [D-UN9], and its approval criteria for a finance app are **unverified**. With the entitlement BRAKE can apply the brief's "say nothing if there is no meaningful insight" to server-relayed observations. Without it, BRAKE should send relays as background pushes (throttled; see source 23) or accept a neutral visible notification.

**Windows.** POST-SPEND (and pending-transaction IN-SPEND where the aggregator supplies pending data). Latency is seconds after the webhook.

**Recommendation: `next`.** It is infrastructure for the aggregator streams, and important for meeting Guideline 4.5.4 and the brief's "transmit the minimum".

---

### 17. SMS Message Filter extension — `ILMessageFilterExtension` (`ios-message-filter-extension`)

**What it is.** An IdentityLookup extension that the Messages app calls for **SMS/MMS from unknown senders only**: "it doesn't work with messages from senders in a user's Contacts list or with iMessage messages from any source" [D-ML1].
- Input `ILMessageFilterQueryRequest`: `sender`, `messageBody`, `receiverISOCountryCode` [D-ML2].
- Output `ILMessageFilterQueryResponse`: `action` + `subAction` [D-ML3].
- iOS 16 sub-actions include `transactionalFinance`, `transactionalOrders`, `transactionalReminders`, `transactionalHealth`, `transactionalWeather`, `transactionalCarrier`, `transactionalRewards`, `transactionalPublicServices`, `transactionalOthers`, and `promotionalOffers` / `promotionalCoupons` / `promotionalOthers`, declared via `ILMessageFilterCapabilitiesQueryResponse` [D-ML4, D-ML5].
- Apple's docs say nothing about which regions *display* these sub-categories. The commonly cited India (iOS 16) and Brazil scoping is **unverified** here.
- Whether RCS (incl. E2EE RCS on iOS 26.5) reaches the filter is undocumented [F16].

**Can it feed BRAKE? Technically almost not; by policy no.**
- "Your app extension also **can't write data to containers shared with the containing app**", and "can't access the network directly" [D-ML1].
- The only way out is `deferQueryRequestToNetwork`. The **system** POSTs `{"_version":1,"query":{"sender":…,"message":{"text":…}},"app":{"version":…}}` to the URL in `ILMessageFilterExtensionNetworkURL` and returns the response to the extension [D-ML6]. So a developer server *could* receive bank SMS text, but only for unknown senders, only while BRAKE is the **single** active filter app, and only by sending private message content to a server. That goes against BRAKE's local-first principle.
- Guideline 2.5.12: "You may not use the data accessed via these tools for any purpose not directly related to operating or improving your app or extension (e.g. … creating user profiles)" [P1]. Guideline 2.5.1 requires intended-purpose use [P1].
- Memory limits for on-device models in the extension are undocumented [F17].

**Windows.** It would have been POST-SPEND (bank SMS alerts). Not available to BRAKE.

**Recommendation: `avoid`.** Record in the registry: *iOS: SMS bank alerts not readable by third-party apps (all countries)*. On iOS the Indian bank-SMS signal has to come from AA or email instead.

---

### 18. Clipboard / paste (`ios-clipboard-paste`)

**What it is.**
- Since iOS 14 "the system notifies the user when an app gets general pasteboard content that originates in a different app without user intent". In iOS 16+ "programmatic pasting raises a user alert" (Allow Paste) [D-CB1, D-CB2].
- **`UIPasteControl`** (iOS 16+) is a system paste button that pastes **without** the prompt [D-CB1].
- Pattern APIs (`detectPatterns(for:)` for `probableWebURL`, `probableWebSearch`, `number`) and the `hasURLs` / `hasStrings` checks work "without notifying the user" [D-CB2].
- **[corrected 2026-10-04]** `UIPasteboard.DetectionPattern` (iOS 14) has only `number`, `probableWebSearch` and `probableWebURL`. Richer *values* (`moneyAmounts`, `links`, `shipmentTrackingNumbers`, `phoneNumbers`, `postalAddresses`, `calendarEvents`, `flightNumbers`, `emailAddresses`) come from `UIPasteboard.DetectedValues` via `detectValues(for:)` / `detectedValues(for:)` (iOS 15) [D-CB3]. They are not detection patterns. Whether value retrieval triggers the paste notification is **unverified**.

**Use.** On BRAKE's "Should I buy this?" screen: `detectPatterns` → if `probableWebURL`, show a `UIPasteControl` labelled "Paste product link". Never read the clipboard silently.

**Windows.** PRE-SPEND. Latency is immediate. **Recommendation: `mvp`** (part of the manual check flow).

---

### 19. VisionKit DataScanner — price tags, barcodes, QR (`ios-visionkit-data-scanner`)

**What it is.** `DataScannerViewController` (iOS 16+) scans live camera video for text, "data in text" and machine-readable codes [D-VK1].
- `TextContentType` includes **`currency`**, `URL`, `emailAddress`, `telephoneNumber`, `shipmentTrackingNumber`, `flightNumber`, `fullStreetAddress`, `dateTimeDuration` [D-VK2].
- `isSupported` requires an **A12 Bionic or later**; `isAvailable` requires camera permission (`NSCameraUsageDescription`) [D-VK1, D-VK3].

**Use.** "Point at the price tag": the currency-typed text gives `amount` + `currency`, and the barcode gives a product GTIN. A GTIN→product lookup requires an external database, which leaks product interest; do it locally where possible.

**QR.** The same scanner reads payment QR codes such as UPI or Pix. Parsing belongs to the QR/UPI stream (`upi-qr` / `QRAdapter`); on iOS this scanner is the capture path.

**Windows.** **PRE-SPEND / IN-SPEND** (in-store, at the shelf or till). Latency is immediate.

**Coverage.** Global; language list via `supportedTextRecognitionLanguages`.

**Recommendation: `next`.** QR scanning is `mvp` in India per the payment stream. Price-tag scanning is valuable but secondary.

---

### 20. Vision document OCR for receipts (`ios-vision-document-ocr`)

**What it is.** `RecognizeDocumentsRequest` (iOS 26+) returns a `DocumentObservation` with text grouped by words, lines and paragraphs, plus **tables, lists and barcodes**. It is meant for "structured texts like **receipts**" [D-VI1, D-VI2]. In iOS 27, Foundation Models prompts can include an image and call Vision's `OCRTool` and `BarcodeReaderTool` [D-FM1]. VisionKit's document camera is available for capture (version not re-verified).

**Use.** Receipt photo or screenshot → on-device extraction of `{merchant, date, total, tax, line items}`. This gives the item-level semantics the brief wants from email, but on the device and without email access.

**Windows.** **POST-SPEND.** Seconds on the device.

**Dedup keys.** Receipt number / invoice number / order id when printed; otherwise `(total, merchant, date)`.

**Provenance.** "Read from the receipt photo you added on 4 Oct."

**Recommendation: `next`.** Ship basic receipt capture in the MVP with `RecognizeTextRequest`-class OCR (iOS 18 Swift Vision API) [D-VI2], and upgrade to document structure on iOS 26+.

---

### 21. Visual Intelligence integration (`ios-visual-intelligence`)

**What it is.** In iOS 26+ (and macOS 27), users point the visual-intelligence camera at something or select objects in a **screenshot**. Apps that adopt `IntentValueQuery` receive a `SemanticContentDescriptor` with **`labels`** (generic `en_US` terms like "building") and **`pixelBuffer`**, and return entities shown in the system UI. Tapping a result runs an `OpenIntent` [D-VS1, D-VS2]. Constraints: an app can have only **one** `IntentValueQuery` accepting `SemanticContentDescriptor`; results must come back quickly; the labels have no synonyms or translations [D-VS2].

**Use.** Screenshot a product page → visual intelligence → a BRAKE result such as "Check against this week's plan" → `OpenIntent` into the "Should I buy this?" flow with the pixel buffer OCR'd locally (price, title).

**Windows.** PRE-SPEND.

**Coverage.** Apple Intelligence-eligible devices and regions only (unverified per country).

**Recommendation: `later` / research.** It is novel, but the surface is search-oriented and discovery is uncertain. The Share extension (source 12) already covers screenshots.

---

### 22. On-device Foundation Models — local intelligence (`ios-foundation-models`)

**What it is.** The Foundation Models framework (iOS 26+) gives access to Apple's **on-device** `SystemLanguageModel` [D-FM1, D-FM2].
- Features: guided generation (`@Generable`), tool calling, a `contentTagging` use case, and three model versions so far (26.0–26.3, 26.4, 27.0).
- A Feb 2026 note cites a **4,096-token** context window, with `contextSize` and `tokenCount(for:)` APIs [D-FM3].
- iOS 27 adds `PrivateCloudComputeLanguageModel`, any LLM via the `LanguageModel` protocol, image prompts with Vision tools, and a Python SDK (Mar 2026) [D-FM3].
- Availability states include `.deviceNotEligible`, `.appleIntelligenceNotEnabled` (implied), and `.modelNotReady`; it requires a device and region that support Apple Intelligence [D-FM2].

**Use.** It is not a signal but a **local processing capability**:
- normalize merchant strings
- classify a candidate's category or essentiality
- parse pasted or shared text and OCR output into a `TransactionCandidate`
- draft non-scolding insight copy

All of this can happen without sending financial text to BRAKE's servers.

**Policy.** Guideline 5.1.2(i) requires disclosure and explicit permission before sharing personal data "with third-party AI" [P1]. On-device use avoids this; a server LLM fallback triggers it.

**Recommendation: `next`.** Ship deterministic or rule-based parsing first. Gate model use on availability and version, and re-test prompts on each model update.

---

### 23. Background execution constraints (`ios-background-tasks`)

These are not a source but limit every adapter above [D-BG1, D-BG2, D-AI4]:
- `BGAppRefreshTask`: up to about 30 s, scheduled by the system.
- `BGProcessingTask`: minutes, when idle or charging.
- Background (silent) pushes: up to 30 s. Apple: "If you send background pushes more frequently than three times per hour, the system imposes rate limitations" [D-BG1] (verified 2026-10-04).
- `BGContinuedProcessingTask` (iOS 26): user-started foreground work that continues in the background with a system progress UI.
- App Intents: 30 s in the background unless `LongRunningIntent` (iOS 27) is used.
- Guideline 2.5.4: background services only "for their intended purposes" [P1].
- There is **no** persistent background service, **no** notification-listener equivalent and **no** accessibility-service equivalent.

**Recommendation: `mvp` (as a design constraint).** Every iOS adapter is a short event handler that writes to an App Group store. Fusion runs on the next foreground, in an NSE, or in a short background task.

---

### 24. EU-only: TelephonyMessagingKit (default carrier messaging app) (`ios-telephonymessagingkit-eu`)

**What it is.** iOS 26+ on iPhone: an app chosen as the user's **default carrier messaging app** can send and receive SMS, MMS and RCS and access that app's message history.
- Requirements: the `com.apple.developer.carrier-messaging-app` entitlement; "users must have an account registered in the EU, and their device must be located within the EU" [D-TM1].
- **[corrected 2026-10-04]** DPLA §3.3.7(H) (Aug 2026) has three requirements [P2]:
  - The app "must offer the ability to send messages initiated by the end user, and to view messages previously received".
  - Messages and metadata must be stored and transmitted securely; "messages synced to a server must be encrypted in transit and at rest".
  - The app may not send unsolicited messages, phish or spam.
  The previously quoted "for any other purpose" ban is **not** in the current text. In practice BRAKE would still have to *be* a full messaging app.

**Recommendation: `avoid`.** BRAKE would have to *become the user's SMS app*. Record it as an EU registry fact only.

---

### 25. EEA-only: NFC host card emulation (`ios-nfc-hce-eea`)

**What it is.** Core NFC `CardSession` (iOS 17.4+) does ISO 7816 HCE for "in-store payments, car keys, closed-loop transit, corporate badges, hotel keys, merchant loyalty/rewards and event tickets in the European Economic Area (EEA)" [D-NF1].
- **EEA only** (per Apple's `CardSession` page as of 2026-10-04). Apple's separate secure-element NFC programme in other countries is out of scope and was **not verified** in this session. It needs managed entitlements (`com.apple.developer.nfc.hce`, AID prefixes, optional `default-contactless-app`) and an application process [D-NF1].
- A payment app that is the default contactless app *would* sit in the IN-SPEND path, but only if BRAKE were (or partnered with) a regulated payment app.

**Recommendation: `avoid`** for BRAKE itself. Note it as a possible **partner** route (EEA issuers or wallets) for the future.

---

### 26. Location / geofence context (`ios-location-monitoring`)

**What it is.** Core Location region monitoring (`CLMonitor`, iOS 17+) could flag "arrived at a mall or favourite store" as PRE-SPEND context. Details (condition limits, Always-permission requirements for background events) are **not re-verified** in this session.

**Risk.** The brief says "Avoid invasive surveillance … Do not collect context merely because it is technically available".

**Recommendation: `later`.** Only consider it as user-defined places ("remind me at *Phoenix Mall*"), processed only on the device.

---

## Three-window classification

| Source (id) | Pre-spend | In-spend | Post-spend | Typical latency | Notes |
|---|---|---|---|---|---|
| Wallet Transaction trigger (`ios-shortcuts-wallet-transaction-trigger`) | – | ✔ (tap) | ✔ (immediate) | seconds; times out if issuer is late (can be hours) | Apple Pay taps only; user-built automation; fires on declines; no txn id |
| FinanceKit (`apple-financekit`) | – | ◐ (pending) | ✔ | background delivery (iOS 26); otherwise on app open | stream 02; US = Apple Card/Cash/Savings only; UK = open-banking accounts (iOS 18.4+); confirms Wallet taps only for those cards |
| Shortcuts App trigger (`ios-shortcuts-app-open-trigger`) | ✔ | – | – | <1 s at app open | no entitlement; fragile (iOS 26.6 regression) |
| Screen Time shields (`ios-screen-time-shields`) | ✔ | ◐ (shielded checkout domains) | – | immediate | entitlement + DPLA primary-purpose eligibility; device-local data; 26.4 submenu; 26.5 `openParentalControlsApp` |
| DeviceActivity monitor (`ios-deviceactivity-monitor`) | ✔ | – | – | minutes (thresholds) | device-local; purpose-limited |
| DeviceActivity report (`ios-deviceactivity-report`) | – | – | ◐ (reflection) | daily/hourly | display-only sandbox |
| EU FamilyActivityData (`ios-familyactivitydata-eu`) | ◐ | – | – | n/a | EU-only, exclusive with Screen Time → avoid |
| App Intents / Siri / Spotlight (`ios-app-intents-siri-spotlight`) | ✔ | ✔ | ✔ (manual log) | immediate | user-stated amount; global |
| Controls / Action button (`ios-controls-action-button`) | ✔ | ✔ | – | immediate | iOS 18+; Action button on newer iPhones |
| Interactive widgets (`ios-interactive-widgets`) | ✔ | – | ◐ | immediate | no text input; inactive while locked |
| Live Activities (`ios-live-activities`) | ◐ | ✔ (shopping session) | ◐ | push/app updates; ≤8 h (+4 h) | 4 KB; no network; avoid sensitive info |
| Share extension (`ios-share-extension`) | ✔ | ◐ | ◐ (share receipt image) | immediate | canonical "share to BRAKE" |
| Safari Web Extension (`safari-web-extension-ios`) | ✔ | ✔ (checkout DOM) | ◐ (order-confirmation page) | immediate | per-site permission; Safari only |
| Notification actions (`ios-notification-actions`) | – | – | ✔ (labels, regret) | immediate | ≤4 buttons expanded, 2 in banner |
| Notification content ext. (`ios-notification-content-extension`) | – | – | ✔ | immediate | richer label UI |
| Notification service ext. (`ios-notification-service-extension`) | – | ◐ (pending via aggregator) | ✔ | seconds after webhook | own pushes only; E2EE decrypt |
| SMS Message Filter (`ios-message-filter-extension`) | – | – | ✗ | – | unknown senders only; can't export; 2.5.12 → avoid |
| Clipboard / UIPasteControl (`ios-clipboard-paste`) | ✔ | – | – | immediate | user-tapped paste only |
| VisionKit DataScanner (`ios-visionkit-data-scanner`) | ✔ | ✔ (till, QR) | – | immediate | A12+; currency text; barcodes/QR |
| Vision document OCR (`ios-vision-document-ocr`) | – | – | ✔ (receipts) | seconds | iOS 26 structure (tables/lists) |
| Visual Intelligence (`ios-visual-intelligence`) | ✔ | – | – | immediate | Apple Intelligence devices |
| Foundation Models (`ios-foundation-models`) | (enabler) | (enabler) | (enabler) | sub-second to seconds | local parsing/classification |
| Background tasks (`ios-background-tasks`) | constraint | constraint | constraint | ~30 s windows | shapes adapter design |
| TelephonyMessagingKit EU (`ios-telephonymessagingkit-eu`) | – | – | ✗ | – | default SMS app only → avoid |
| NFC HCE EEA (`ios-nfc-hce-eea`) | – | ✗ (managed-entitlement HCE apps only) | – | – | avoid; partner idea |
| Location (`ios-location-monitoring`) | ◐ | – | – | minutes | invasive; later |

✔ = primary use, ◐ = partial or secondary, ✗ = technically present but not usable by BRAKE.

---

## Implications for BRAKE architecture

### Adapter design notes (iOS)

1. **`WalletTapAdapter` (App Intent entry point).**
   - Expose `LogWalletTransactionIntent(merchant: String?, amount: String?/Double?, card: String?)` with `supportedModes = [.background]`.
   - The exact variable types Shortcuts passes in are unverified, so accept a **string or a number** for amount, keep the raw value, and parse with the device locale ("45,00 €" vs "$45.00").
   - Treat `0`/blank as missing and emit `status_hint=pending`.
   - Finish in under 30 s: write to the App Group store, schedule a local label notification if confidence permits, and return.
   - Keep a **health record** `{configured_cards[], last_fired_at, consecutive_unmatched_card_txns}` to spot broken automations, and prompt a gentle re-setup.
2. **`ScreenTimeFrictionAdapter` is a sealed, device-local module.**
   - Its outputs carry `locality=device_local_only`. Enforce this in code, e.g., with a separate store not included in sync, backup export or analytics, and a type wrapper the sync layer cannot serialise.
   - Shield text reads a **pre-computed, minimal** budget summary from App Group `UserDefaults`. A forum report says SwiftData in the shield extension fails [F8].
   - On iOS ≥ 26.5, `ShieldActionDelegate` returns `.openParentalControlsApp` for "Ask BRAKE". On older versions, use the local-notification deep-link fallback.
3. **`ShortcutsAppOpenAdapter`** as the fallback, with a pass-through window (e.g., 60–120 s per app) to avoid loops, and a heartbeat.
4. **`ManualIntentAdapter`** shared by Siri, Spotlight, Action button, Controls, widgets, Share extension, paste and scanner. A single normalized `purchase_intent` schema with `capture_surface` provenance (`siri|spotlight|action_button|control|widget|share_sheet|paste|scanner|visual_intelligence|safari_extension`).
5. **`LabelAdapter`** from notification actions and the content extension. It emits `label` observations linked by `candidate_id`, carried in `userInfo` of the local notification. Categories are generated dynamically from the top-k predictions, with the k=2 most likely first so they show in banners.
6. **Server-relay pattern for cloud sources.** Aggregator webhook → E2EE APNs payload → NSE decrypts → App Group → local fusion → optional insight notification. The server never needs plaintext *insights*, only the source data it already holds.
7. **Local intelligence layer.** Use rules and regex first. Then use Foundation Models when `SystemLanguageModel.default.availability == .available`, with `@Generable` structs mirroring `TransactionCandidate` fields. Version prompts per model version (26.0–26.3 / 26.4 / 27.0).

### Normalization pitfalls

- **Status inflation.** A Wallet-tap observation is not a confirmed spend (declines fire the trigger). Shield or App-open events are *intent at most*.
- **Zero is not an amount.** `0.0` from the trigger is a known failure mode [F1].
- **Currency ambiguity.** The trigger's currency is unknown. FinanceKit has `CurrencyAmount` and `foreignCurrencyAmount`; OCR returns "Rs.", "₹" and "INR" variants.
- **Two merchant strings.** FinanceKit has both `transactionDescription` and `originalTransactionDescription`. Keep both, plus `merchantName` and `merchantCategoryCode`, so normalization is reproducible.
- **Time.** Trigger time is tap time. Issuer data and FinanceKit `transactionDate`/`postedDate` may differ by hours to days. Use asymmetric match windows.
- **Instrument mapping.** Wallet card names are user-visible labels, not account IDs. Map them to FinanceKit `accountID` or aggregator account only with user confirmation.
- **Apple Watch taps** may not reach the trigger. This is **unverified**: [F4] is an unanswered question about building the automation on the Watch **[corrected 2026-10-04]**. If they don't, they look like "missed" spends without other data, and the health heuristic must not count them as automation failures.
- **FinanceKit coverage gap.** In the US, FinanceKit sees only Apple Card, Apple Cash and Savings, so most Wallet-tap observations (third-party cards) can't be confirmed through FinanceKit **[corrected 2026-10-04]**.
- **Share-sheet URLs** carry affiliate and tracking parameters. Canonicalize them, and store the domain and product id, not the full URL.
- **Screen Time tokens can expire** [F13]. Never assume a stored token selection is still valid.

### Capability-registry facts (platform = iOS)

Express each as `{country, platform, capability, status, min_os, device_req, entitlement, user_setup, notes}`:

- `GLOBAL/ios/third-party-notification-read`: **unavailable** (no API; NSE is own-app only).
- `GLOBAL/ios/sms-inbox-read`: **unavailable**, except the EU default-messaging-app path (`EU/ios/telephonymessagingkit`: **limited**, iOS 26+, avoid).
- `GLOBAL/ios/sms-filter-extension-as-feed`: **unavailable by policy** (2.5.12; no shared-container write).
- `GLOBAL/ios/screen-time-shields`: **available** (platform), iOS 16+ individual auth, entitlement required, submenu iOS 26.4+, `openParentalControlsApp` iOS 26.5+. App eligibility depends on the DPLA §3.3.3(P) primary-purpose clause (Aug 2026), so model `entitlement_status` per app build, not per country.
- `US/ios/financekit`: **limited**, iOS 17.4+, Apple Card, Apple Cash and Savings only; managed entitlement; Finance-category app. **[corrected 2026-10-04]**
- `GB/ios/financekit`: **available**, iOS 18.4+, open-banking-connected accounts from major UK banks; managed entitlement. **[corrected 2026-10-04]**
- `GLOBAL/ios/nse-silent-filtering`: **limited**. Needs the managed `com.apple.developer.usernotifications.filtering` entitlement (iOS 13.3+). **[added 2026-10-04]**
- `EU/ios/screen-time-nontokenized-usage`: **limited**, iOS 26.4+, EU device + EU Apple Account, one app per device.
- `US|GB|EU…/ios/wallet-transaction-trigger`: **limited** (Apple Pay taps; issuer-dependent detail; user setup).
- `IN/ios/wallet-transaction-trigger`: **unknown/unavailable** (Apple Pay availability in India unverified as of 2026-10-04).
- `GLOBAL/ios/data-scanner`: **available**, iOS 16+, `device_req=A12+`.
- `GLOBAL/ios/document-ocr-structured`: **available**, iOS 26+.
- `GLOBAL/ios/on-device-llm`: **limited**, iOS 26+, `device_req=apple-intelligence-eligible`, region-dependent.
- `GLOBAL/ios/visual-intelligence-integration`: **limited**, iOS 26+, Apple Intelligence devices.
- `GLOBAL/ios/safari-web-extension`: **available**, iOS 15+, Safari only, per-site permission.
- `GLOBAL/ios/notification-quick-actions`: **available** (≤4 expanded / 2 banner).
- `GLOBAL/ios/live-activities`: **available**, iPhone/iPad, ≤8 h, 4 KB.
- `EEA/ios/nfc-hce`: **limited** (payment-app entitlement; not for BRAKE).
- `GLOBAL/ios/wallet-orders-read`: **unavailable** (FinanceKit documents save-only for orders; inferred).

The registry should also track **per-device runtime state**: e.g., `wallet_trigger.health = healthy|stale|never_seen` and `family_controls.status = notDetermined|approved|denied`, because many iOS capabilities depend on user setup, not on country.

---

## Risks, policy constraints and ethical concerns

1. **Family Controls eligibility and purpose limitation (DPLA §3.3.3(P), Aug 18, 2026 text) [corrected 2026-10-04].**
   - **Eligibility:** the app must have a *primary purpose* of family controls or individual device, focus or productivity management. BRAKE's primary purpose (spending decisions) may not qualify, so the shield feature could be refused or later pulled.
   - **Data limits:** data may only be used "for providing family controls, or individual device management". It may not be shared "beyond … the individual and their device", and may not be used for advertising or given to data brokers.
   - **Consequence:** using shield or usage events in a server-side spending model risks losing the entitlement or the developer account.
   - **Mitigation:** a device-local sealed module and no sync. Hold an App Review consultation (30-minute appointment, as DTS suggests [F18]) before building. Ask (a) whether a spending-focused app with a shopping-app usage-management feature is eligible, and (b) whether user-entered shield submenu answers may be synced.
2. **Entitlement timing.** The Family Controls distribution entitlement went through a backlog in 2026 [F11, F12], and automated review checks have stalled apps [F10]. Apply early and keep the Shortcuts fallback.
3. **Monetisation (Guideline 4.10).** Don't sell "shield access" as a stand-alone paid feature.
4. **Private API temptation.** Opening the parent app from a shield via `LSApplicationWorkspace` led to rejections in May 2026 [F9]. Use the iOS 26.5 public response or the notification fallback.
5. **Shortcuts dependency.** The Wallet trigger has no SLA, has had unresolved bugs since 2024, and Apple could change it in any OS update (including the iOS 27 cycle; its current behaviour is not verified here). Never make it a single point of failure, and be transparent with users when it's "not hearing" taps.
6. **Sensitive data in visible surfaces.** Live Activities, widgets and notification previews show on the Lock Screen and Always-On display. The HIG says to avoid sensitive info [D-LA3], and Guideline 4.5.4 discourages sensitive content in pushes [P1]. Default to non-numeric summaries.
7. **Third-party AI disclosure (5.1.2(i)).** Any server LLM (or third-party model through the iOS 27 `LanguageModel` protocol) used on financial text needs explicit disclosure and permission. On-device Foundation Models avoid this.
8. **Highly regulated field (5.1.1(ix)).** Financial-services apps "should be submitted by a legal entity". Ship under the company entity. FinanceKit also requires an organisation account.
9. **Compiling personal information (5.1.1(viii)).** Don't enrich users with data that doesn't come directly from them or that they didn't explicitly consent to, e.g., third-party purchase-history brokers.
10. **Behavioural ethics of friction.**
    - Shields and app-open interventions can easily become nagging or shaming.
    - Keep them user-chosen, rate-limited, easy to bypass ("Not now" always works), and copy-reviewed against the brief's "without scolding".
    - Don't use DeviceActivity to profile vulnerability, e.g., late-night use, for anything except the user's own requested friction.
11. **EU exclusive data access.** Taking `approvedWithDataAccess` would knock out Apple's Screen Time for the user [F15], a disproportionate side effect.
12. **SMS filter misuse.** Turning a spam filter into a financial-SMS harvester would breach Guideline 2.5.12 and user expectations. Avoid it, even though the system's network deferral technically makes it possible.

---

## Open questions

1. What exactly does the Wallet **Transaction** trigger output on iOS 26.x/27: variable names, types (currency-aware or `Double`), whether **category**, **currency**, **transaction type** or **refund** are passed, and whether it fires for **online/in-app Apple Pay** or refunds? This needs an on-device test matrix across issuers (Visa vs Mastercard; US, UK, EU).
2. Was the timeout bug (FB14035016 / FB16379100) fixed in iOS 26.x or 27? Forum posts up to Feb 2026 say no.
3. Does `ShieldActionResponse.openParentalControlsApp` (iOS 26.5) work with **individual** authorization, and can the app learn *which* token was shielded (e.g., via App Group hand-off from the action extension)?
4. Under DPLA §3.3.3(P), may BRAKE **sync** answers the user gives on a shield (e.g., "planned purchase"), or use shield counts in its *on-device* regret model? Get App Review guidance.
5. Is a spending-decision app eligible for Family Controls at all under the DPLA's primary-purpose clause ("personal device usage management"), and how long will distribution approval take in late 2026? **[updated 2026-10-04]**
6. Can notification categories be updated per notification (dynamic top-2 labels) without changing buttons on earlier, still-visible prompts?
7. Is Apple Pay available in **India** as of Oct 2026, and if so, does Wallet get merchant and amount from Indian issuers? That would decide `IN/ios/wallet-transaction-trigger`.
8. Which countries and languages does the on-device `SystemLanguageModel` support (`supportedLanguages`), e.g., English (India), Hindi? Is Apple Intelligence available in the target markets?
9. Do Screen Time web-domain shields apply in third-party browsers and in-app web views on iOS 26/27?
10. Does iOS 27 (or later 26.x) add any third-party read access to **Wallet orders** (Apple Intelligence order tracking from Mail), or to App Store subscription lists for the user's other apps? Neither was found.
11. Which region scopes the iOS SMS filter sub-categories (India, Brazil, others), and does RCS reach `ILMessageFilterExtension`? Only relevant to the registry, since the recommendation is avoid.
12. Behavioural evidence: the one sec / PNAS 2023 self-nudge study is commonly cited as showing large reductions in app openings (**unverified** in this session). Does launch friction carry over to *purchase* reduction without raising regret or annoyance? BRAKE should run its own A/B evaluation.

---

## References

URLs consulted in this session. Apple documentation pages were read through `developer.apple.com/tutorials/data/documentation/…json`, the JSON form of the human-readable URL given.

**Policies**
- [P1] https://developer.apple.com/app-store/review/guidelines/ — Guidelines 2.5.1, 2.5.4, 2.5.12, 4.4/4.4.2, 4.5.4, 4.10 (Screen Time APIs not monetizable), 5.1.1(i)–(x) incl. (viii) and (ix), 5.1.2(i) (third-party AI), 5.1.2(vii) (Apple Pay data).
- [P2] https://developer.apple.com/support/terms/apple-developer-program-license-agreement/ — DPLA (Schedule 1 last updated August 18, 2026): §3.3.3(P) Family Controls primary-purpose requirement and data restrictions; §3.3.7(H) TelephonyMessagingKit; definitions of Apple Pay APIs and Passes. Re-fetched 2026-10-04.

**Shortcuts / Wallet trigger**
- [S1] https://support.apple.com/guide/shortcuts/transaction-trigger-apd65c67538a/ios — Apple's Transaction trigger page. **Search snippet only** (fetch blocked): "run an automation based on your wallet transactions", "When I tap".
- [S2] https://matthewcassinelli.com/shortcuts-automations-ios-ipados-transaction-display-stage-manager/ and https://www.idropnews.com/ios-17/this-new-ios-17-shortcut-will-help-you-keep-track-of-your-spending/197589/ — **search snippets only**: iOS 17 Transaction trigger; Payment/Transit/Access/Identity; filters on card, category, merchant; outputs card or pass, merchant, amount.
- [S3] https://www.threads.com/@meta.ai/post/Db4Hw8xDNua — **search snippet only**: "Run Immediately", "Needs iOS 17.4+ and Apple Pay".
- [S4] https://techtiff.substack.com/p/apple-wallet-expense-tracker-shortcuts — **search snippet only**: setup steps incl. Run Immediately.
- [F1] https://developer.apple.com/forums/thread/797233 — App Intent receives merchant/amount; occasional empty merchant / 0.0 amount (Aug–Oct 2025).
- [F2] https://developer.apple.com/forums/thread/765516 — timeouts waiting for issuer data; fires on declines; Mastercard vs Visa; FB14035016/FB16379100; unresolved as of Feb 2026.
- [F3] https://developer.apple.com/forums/thread/758053 — trigger stopped working on iOS 18 (Jun 2024–Feb 2025).
- [F4] https://developer.apple.com/forums/thread/819473 — "Wallet Automation on Apple Watch" (Mar 2026, 0 replies): the developer couldn't make the automation work on Apple Watch. It does not establish whether Watch payments fire the iPhone trigger.
- [F5] https://developer.apple.com/forums/thread/746889 — can't test in Simulator; frequent timeouts.
- [F6] https://developer.apple.com/forums/thread/773745 — "Automation failed" since Feb 2025.
- [F7] https://developer.apple.com/forums/thread/841128 — iOS 26.6 "When App Is Closed" regression (FB24505842), Aug 2026. It contains no "screen time friction" quote.

**Screen Time API**
- [D-ST1] https://developer.apple.com/documentation/familycontrols — individual vs child authorization; entitlement; visionOS failure.
- [D-ST2] https://developer.apple.com/documentation/managedsettings — ManagedSettingsStore, tokens, shield types.
- [D-ST3] https://developer.apple.com/documentation/managedsettingsui/shieldconfiguration — shield properties incl. `secondaryButtonSubmenuItems`.
- [D-ST3a] https://developer.apple.com/documentation/managedsettingsui/shieldconfiguration/secondarybuttonsubmenuitems and https://developer.apple.com/documentation/managedsettings/shieldaction — iOS 26.4+; up to three items; `first/second/thirdSecondarySubmenuItemPressed`.
- [D-ST4] https://developer.apple.com/documentation/managedsettingsui/shieldconfigurationdatasource — extension receives names/bundle IDs/domains; sandbox; no network.
- [D-ST5] https://developer.apple.com/documentation/managedsettings/shieldactiondelegate — tokens only; handle methods.
- [D-ST6] https://developer.apple.com/documentation/managedsettings/shieldactionresponse — `.none/.close/.defer/.openParentalControlsApp`.
- [D-ST7] https://developer.apple.com/documentation/managedsettings/shieldactionresponse/openparentalcontrolsapp — iOS 26.5 availability.
- [D-ST8] https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement — distribution request process incl. extensions.
- [D-ST9] https://developer.apple.com/documentation/deviceactivity — framework overview.
- [D-ST10] https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter — monitoring semantics; callbacks only when device in use.
- [D-ST11] https://developer.apple.com/documentation/deviceactivity/deviceactivityreport — report extension sandbox.
- [D-ST12] https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.family-controls.app-and-website-usage — iOS 26.4 entitlement.
- [D-ST13] https://developer.apple.com/documentation/familycontrols/authorizationstatus/approvedwithdataaccess — EU-only; one app at a time.
- [D-ST14] https://developer.apple.com/documentation/familycontrols/familyactivitydata and https://developer.apple.com/documentation/deviceactivity/deviceactivitydata — EU-only non-tokenized data; activityData API.
- [F8] https://developer.apple.com/forums/thread/786195 — SwiftData in ShieldConfiguration extension (via tag summaries).
- [F9] https://developer.apple.com/forums/thread/719905 — "no supported way" to open parent app (2022, 2025); private-API rejections (May 2026).
- [F10] https://developer.apple.com/forums/tags/screen-time and https://developer.apple.com/forums/tags/family-controls — 2026 issues: token expiry, extension wake, iOS 26.4 Face ID revocation (thread 821959), Muse co-blocking (849218), ITMS-90349 (829363), review stalls after automated 2.5.1 checks (838802, 844034), `.approved` instead of `.approvedWithDataAccess` in distribution (844541, 844623), 26.2 threshold regression (809410, FB21267341), Türkiye question (849364). Tag listings re-checked 2026-10-04.
- [F11] https://developer.apple.com/forums/thread/821964 — DTS (Apr 2026): entitlement now team-scoped.
- [F12] https://developer.apple.com/forums/thread/821650 — DTS: "working to clear the backlog" (2026).
- [F13] https://developer.apple.com/forums/thread/844148 — TokenExpiryMessage issue, FB23391495 (via tag summary).
- [F14] https://developer.apple.com/forums/thread/846053 — DeviceActivitySchedule as wake mechanism (unanswered).
- [F15] https://developer.apple.com/forums/thread/844661 — data-access exclusivity vs Apple Screen Time (Sep 2026).
- https://developer.apple.com/forums/thread/849296 — non-EU developers can't get per-app usage data (Oct 2026, unanswered).
- https://developer.apple.com/forums/thread/807733 — DTS "Family Controls Resources" index.
- https://developer.apple.com/forums/thread/848997 — off-device abstract scores under 3.3.3(P) (unanswered).
- [F18] https://developer.apple.com/forums/thread/837242 — DTS points to App Review consultations for 3.3.3(P) questions.

**App Intents, widgets, Live Activities**
- [D-AI1] https://developer.apple.com/documentation/updates/appintents — June 2024 / June 2025 / June 2026 changes.
- [D-AI2] https://developer.apple.com/documentation/appintents/appintent/openappwhenrun — deprecated in 26.0.
- [D-AI3] https://developer.apple.com/documentation/appintents/appintent/supportedmodes — IntentModes (iOS 26).
- [D-AI4] https://developer.apple.com/documentation/appintents/longrunningintent — iOS 27; default 30 s background limit.
- [D-AI5] https://developer.apple.com/documentation/appintents/app-schema-domains — no finance/shopping domain.
- [D-AI6] https://developer.apple.com/documentation/appintents/appshortcutsprovider and https://developer.apple.com/documentation/appintents/app-shortcuts — App Shortcuts behaviour; anonymized data note.
- [D-WK1] https://developer.apple.com/documentation/updates/widgetkit — Controls (2024); WidgetKit push (2025).
- [D-WK2] https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities — Button/Toggle, execution process, locked-device behaviour.
- [D-LA1] https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities — 8 h/12 h, 4 KB, no network/location, LiveActivityIntent.
- [D-LA2] https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications and https://developer.apple.com/documentation/updates/activitykit — push-to-start (not ≤17.1), budgets, scheduled start (2025).
- [D-LA3] https://developer.apple.com/design/human-interface-guidelines/live-activities — no ads; avoid sensitive info.

**Notifications**
- [D-UN1] https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types — background launch on action; text input.
- [D-UN2] https://developer.apple.com/documentation/usernotifications/untextinputnotificationaction — text input action API.
- [D-UN3] (same page as D-UN2) — initializer with `UNNotificationActionIcon`.
- [D-UN4] https://developer.apple.com/design/human-interface-guidelines/notifications — up to four buttons.
- [D-UN5] https://developer.apple.com/documentation/usernotifications/unnotificationcategory/actions — banners show only first two actions.
- [D-UN6] https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel — interruption levels.
- [D-UN7] https://developer.apple.com/documentation/usernotificationsui/customizing-the-appearance-of-notifications — content extension, interactive since iOS 12.
- [D-UN8] https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension — mutable-content, time limit, decrypt.
- [D-UN9] https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.filtering — managed entitlement (iOS 13.3+) that lets an NSE silence a push by returning empty content. **[added 2026-10-04]**
- https://developer.apple.com/documentation/updates/usernotifications — 2024 changes.

**SMS / messaging**
- [D-ML1] https://developer.apple.com/documentation/identitylookup/sms-and-mms-message-filtering — unknown senders only; no shared-container writes; no direct network.
- [D-ML2] https://developer.apple.com/documentation/identitylookup/ilmessagefilterqueryrequest — sender, messageBody, receiverISOCountryCode.
- [D-ML3] https://developer.apple.com/documentation/identitylookup/ilmessagefilterqueryresponse — action/subAction.
- [D-ML4] https://developer.apple.com/documentation/identitylookup/ilmessagefiltersubaction — transactional/promotional sub-actions (iOS 16).
- [D-ML5] https://developer.apple.com/documentation/identitylookup/ilmessagefiltercapabilitiesqueryresponse — capability declaration.
- [D-ML6] https://developer.apple.com/documentation/identitylookup/ilmessagefilterextensioncontext/deferqueryrequesttonetwork(completion:) — server POST JSON format.
- https://developer.apple.com/documentation/identitylookup and https://developer.apple.com/documentation/identitylookup/ilmessagefilterqueryhandling — framework overview; system-handled network.
- [F16] https://developer.apple.com/forums/thread/835232 — RCS/E2EE behaviour of filter undocumented (Jun 2026).
- [F17] https://developer.apple.com/forums/thread/781877 — filter memory limit for ML undocumented.
- [D-TM1] https://developer.apple.com/documentation/telephonymessagingkit — iOS 26, EU-only default carrier messaging app.

**Clipboard, camera, OCR, AI**
- [D-CB1] https://developer.apple.com/documentation/uikit/uipastecontrol — iOS 16 paste alert; prompt-free paste control.
- [D-CB2] https://developer.apple.com/documentation/uikit/uipasteboard — iOS 14 notification; pattern APIs without notifying.
- [D-CB3] https://developer.apple.com/documentation/uikit/uipasteboard/detectionpattern — detection patterns (`number`, `probableWebSearch`, `probableWebURL` only); https://developer.apple.com/documentation/uikit/uipasteboard/detectedvalues — detected values incl. `moneyAmounts`, `links`, `shipmentTrackingNumbers` (iOS 15). **[corrected 2026-10-04]**
- [D-VK1] https://developer.apple.com/documentation/visionkit/datascannerviewcontroller — live text/codes; isSupported/isAvailable.
- [D-VK2] https://developer.apple.com/documentation/visionkit/datascannerviewcontroller/textcontenttype — currency etc.
- [D-VK3] https://developer.apple.com/documentation/visionkit/datascannerviewcontroller/issupported — A12 Bionic requirement.
- [D-VI1] https://developer.apple.com/documentation/vision/recognizedocumentsrequest — receipts, tables, lists (iOS 26).
- [D-VI2] https://developer.apple.com/documentation/updates/vision — 2024 Swift API; 2025 RecognizeDocumentsRequest.
- [D-VS1] https://developer.apple.com/documentation/visualintelligence — iOS 26 / macOS 27 visual intelligence.
- [D-VS2] https://developer.apple.com/documentation/visualintelligence/integrating-your-app-with-visual-intelligence — SemanticContentDescriptor labels/pixelBuffer; one query limit.
- https://developer.apple.com/documentation/updates/visualintelligence — 2026 macOS support.
- [D-FM1] https://developer.apple.com/documentation/foundationmodels — on-device/PCC models; guided generation; tools.
- [D-FM2] https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel — availability states; model versions; contentTagging.
- [D-FM3] https://developer.apple.com/documentation/updates/foundationmodels — Feb 2026 (4,096-token context note, 26.4 model), Mar 2026 (Python SDK), Jun 2026 (OCRTool/BarcodeReaderTool, PCC, LanguageModel protocol).
- https://developer.apple.com/documentation/updates/apple-intelligence — Apple Intelligence developer updates (2024–2025).

**FinanceKit, background, extensions, NFC**
- [D-FK1] https://developer.apple.com/documentation/financekit — entitlement criteria; topics (orders save-only).
- [D-FK2] https://developer.apple.com/documentation/financekit/transaction — transaction fields.
- [D-FK3] https://developer.apple.com/documentation/financekit/backgrounddeliveryextension and https://developer.apple.com/documentation/financekit/implementing-a-background-delivery-extension — iOS 26 background delivery.
- [D-FK4] https://developer.apple.com/documentation/updates/financekit — TransactionPicker (June 2024).
- [D-FK5] https://developer.apple.com/financekit/ — regional availability (US: iOS 17.4+, Apple Card/Apple Cash/Savings; UK: iOS 18.4+, open banking from listed banks) and eligibility (Finance category, US/UK App Store). Fetched 2026-10-04. **[added 2026-10-04]**
- [D-BG1] https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app — 30 s refresh; background push limits.
- [D-BG2] https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask and https://developer.apple.com/documentation/updates/backgroundtasks — iOS 26 continued processing.
- [D-SH1] https://developer.apple.com/documentation/bundleresources/information-property-list/nsextension/nsextensionattributes/nsextensionactivationrule — share/action activation keys; TRUEPREDICATE warning.
- [D-SW1] https://developer.apple.com/documentation/safariservices/safari-web-extensions — iOS 15+; native messaging.
- [D-SW2] https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions — iOS per-site Ask/Allow/Deny.
- [D-NF1] https://developer.apple.com/documentation/corenfc/cardsession — EEA-only HCE; entitlements.
- https://developer.apple.com/documentation/updates and https://developer.apple.com/documentation/updates/passkit — documentation index ("27 platform releases – June 2026"); PassKit MCC (2024).

---

## Verification log

Adversarial fact-check run on 2026-10-04. Method: Apple documentation was read as `developer.apple.com/tutorials/data/documentation/<path>.json`, and forum threads, the App Review Guidelines, the DPLA and developer.apple.com/financekit through direct fetch. WebSearch was unavailable (budget exhausted). support.apple.com, apple.com, pnas.org and news sites were blocked by the egress proxy. Verdicts: **confirmed** = primary source matches; **corrected** = text changed in this document; **unverifiable** = no primary source reachable.

| # | Claim (as originally written) | Verdict | Source |
|---|---|---|---|
| 1 | `ShieldActionResponse.openParentalControlsApp` is new in iOS 26.5 | confirmed (iOS/iPadOS/Mac Catalyst 26.5) | https://developer.apple.com/documentation/managedsettings/shieldactionresponse/openparentalcontrolsapp |
| 2 | `ShieldConfiguration` offers a secondary-button submenu (no version given) | corrected: iOS 26.4+, up to 3 items, `first/second/thirdSecondarySubmenuItemPressed` | https://developer.apple.com/documentation/managedsettingsui/shieldconfiguration/secondarybuttonsubmenuitems |
| 3 | Shield configuration extension gets display names, bundle IDs and domains, and is sandboxed with no network | confirmed | https://developer.apple.com/documentation/managedsettingsui/shieldconfigurationdatasource |
| 4 | `ShieldActionDelegate` receives tokens, not names | confirmed | https://developer.apple.com/documentation/managedsettings/shieldactiondelegate |
| 5 | `approvedWithDataAccess`: iOS 26.4+, EU device + EU account, one app per device | confirmed (status reverts to `.notDetermined` if another app gets it) | https://developer.apple.com/documentation/familycontrols/authorizationstatus/approvedwithdataaccess |
| 6 | Granting data access stops Apple's Screen Time showing new usage | confirmed (forum quotes the consent sheet: "Screen Time will lose access to this data…") | https://developer.apple.com/forums/thread/844661 |
| 7 | Individual authorization uses biometrics, iOS 16+ | confirmed | https://developer.apple.com/documentation/familycontrols/authorizationcenter/requestauthorization(for:) |
| 8 | Docs ask for a separate request per Screen Time extension; DTS (Apr 2026) says approval is team-scoped | confirmed | https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement ; https://developer.apple.com/forums/thread/821964 |
| 9 | Entitlement backlog: waits of 9 days to more than a month (Mar–May 2026) | corrected: 9–10+ days documented; "more than a month" unverified | https://developer.apple.com/forums/thread/821650 ; https://developer.apple.com/forums/thread/821964 |
| 10 | DPLA §3.3.3(P) bans use "for any purpose other than providing parental controls and app and website usage controls", third-party sharing, and off-device transmission | **corrected**: current text (Aug 18, 2026) adds a primary-purpose requirement, limits use to family controls or individual device management, bans sharing beyond the individual and their device, bans advertising and data brokers, and has no explicit off-device clause | https://developer.apple.com/support/terms/apple-developer-program-license-agreement/ |
| 11 | Guideline 4.10: Screen Time APIs may not be monetized | confirmed (guidelines last updated June 8, 2026) | https://developer.apple.com/app-store/review/guidelines/ |
| 12 | Guideline 2.5.12 bans other uses of SMS-filter data | confirmed | https://developer.apple.com/app-store/review/guidelines/ |
| 13 | Guideline 4.5.4: pushes should not carry sensitive personal information | confirmed | https://developer.apple.com/app-store/review/guidelines/ |
| 14 | Guideline 5.1.2(i): disclosure and permission before sharing with third-party AI | confirmed | https://developer.apple.com/app-store/review/guidelines/ |
| 15 | Guideline 5.1.1(ix): financial apps submitted by a legal entity | confirmed | https://developer.apple.com/app-store/review/guidelines/ |
| 16 | DPLA §3.3.7(H): TelephonyMessagingKit "for any other purpose" forbidden | corrected: requires user-initiated send and viewing of received messages, secure storage and transit, no spam; no "any other purpose" wording | https://developer.apple.com/support/terms/apple-developer-program-license-agreement/ |
| 17 | TelephonyMessagingKit: iOS 26, iPhone only, EU account + EU location, default carrier messaging app | confirmed | https://developer.apple.com/documentation/telephonymessagingkit |
| 18 | Message Filter: unknown senders only, no direct network, no shared-container writes, system POSTs `{sender, message.text}` | confirmed | https://developer.apple.com/documentation/identitylookup/sms-and-mms-message-filtering ; https://developer.apple.com/documentation/identitylookup/ilmessagefilterextensioncontext/deferqueryrequesttonetwork(completion:) |
| 19 | Wallet trigger: timeouts (FB14035016/FB16379100), fires on declines, Mastercard/Cembra failures, 3+ h issuer delay, unresolved Feb 2026 | confirmed | https://developer.apple.com/forums/thread/765516 ; https://developer.apple.com/forums/thread/758053 |
| 20 | Custom App Intent occasionally gets merchant `" "` and amount `0.0`; `String`/`Double` parameters; DTS involved | confirmed (Aug–Oct 2025) | https://developer.apple.com/forums/thread/797233 |
| 21 | Trigger can't be made to work for Apple Watch taps | corrected: unanswered question about the Watch; whether Watch payments fire the iPhone trigger is unverified | https://developer.apple.com/forums/thread/819473 |
| 22 | Trigger can't be tested in the Simulator | confirmed | https://developer.apple.com/forums/thread/746889 |
| 23 | iOS 26.6 "When App Is Closed" regression, FB24505842; users quote "automation-driven screen time friction mechanisms failing" | corrected: regression and FB confirmed; the quote does not exist in the thread and was removed | https://developer.apple.com/forums/thread/841128 |
| 24 | HIG: up to four notification buttons; banners show only the first two actions | confirmed | https://developer.apple.com/design/human-interface-guidelines/notifications ; https://developer.apple.com/documentation/usernotifications/unnotificationcategory/actions |
| 25 | Notification content extension supports interactive controls from iOS 12 | confirmed | https://developer.apple.com/documentation/usernotificationsui/customizing-the-appearance-of-notifications |
| 26 | iOS can't fully suppress an alert push from an NSE | corrected: possible with the managed `com.apple.developer.usernotifications.filtering` entitlement (iOS 13.3+) | https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.filtering |
| 27 | Live Activities: 8 h + 4 h (12 h max), 4 KB, no network/location, `LiveActivityIntent` background start; push-to-start 17.2+ | confirmed | https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities ; https://developer.apple.com/documentation/activitykit/activity/pushtostarttoken |
| 28 | HIG Live Activities: avoid sensitive info; no ads | confirmed | https://developer.apple.com/design/human-interface-guidelines/live-activities |
| 29 | `supportedModes` iOS 26 replaces deprecated `openAppWhenRun` | confirmed | https://developer.apple.com/documentation/appintents/appintent/supportedmodes |
| 30 | `LongRunningIntent` iOS 27; default 30 s background limit | confirmed | https://developer.apple.com/documentation/appintents/longrunningintent |
| 31 | No finance/payments/shopping app-schema domain | confirmed (as of 2026-10-04) | https://developer.apple.com/documentation/appintents/app-schema-domains |
| 32 | Foundation Models: 4,096-token note (Feb 2026), Python SDK (Mar 2026), iOS 27 `OCRTool`/`BarcodeReaderTool`, PCC model, `LanguageModel` protocol | confirmed | https://developer.apple.com/documentation/updates/foundationmodels |
| 33 | `RecognizeDocumentsRequest` iOS 26; receipts, tables, lists | confirmed | https://developer.apple.com/documentation/vision/recognizedocumentsrequest |
| 34 | `DataScannerViewController` needs A12+; `TextContentType.currency` | confirmed | https://developer.apple.com/documentation/visionkit/datascannerviewcontroller/issupported |
| 35 | `UIPasteControl` pastes without a prompt (iOS 16) | confirmed | https://developer.apple.com/documentation/uikit/uipastecontrol |
| 36 | Detection patterns include `moneyAmount`, `link`, `shipmentTrackingNumber` | corrected: those are `DetectedValues` (iOS 15); `DetectionPattern` has only number/probableWebSearch/probableWebURL | https://developer.apple.com/documentation/uikit/uipasteboard/detectedvalues |
| 37 | Visual intelligence: one `IntentValueQuery` per app; `en_US` labels; macOS 27 | confirmed | https://developer.apple.com/documentation/visualintelligence/integrating-your-app-with-visual-intelligence |
| 38 | FinanceKit: managed entitlement, org account, Account Holder, `NSFinancialDataUsageDescription`; orders save-only | confirmed | https://developer.apple.com/documentation/financekit |
| 39 | FinanceKit `Transaction` fields; `BackgroundDeliveryExtension` iOS 26 | confirmed (`Transaction` itself is iOS 17.4+) | https://developer.apple.com/documentation/financekit/transaction ; https://developer.apple.com/documentation/financekit/backgrounddeliveryextension |
| 40 | FinanceKit: "Apple-issued and Wallet-connected accounts, mainly US"; natural confirmer for any Wallet tap | **corrected**: US = Apple Card, Apple Cash, Savings only (iOS 17.4+); UK = open-banking accounts (iOS 18.4+); Finance-category eligibility | https://developer.apple.com/financekit/ |
| 41 | `CardSession` HCE EEA-only, iOS 17.4, "for payment apps" | corrected (scope): EEA-only confirmed; use cases include keys, transit, badges, loyalty, tickets | https://developer.apple.com/documentation/corenfc/cardsession |
| 42 | Safari Web Extensions on iOS: per-site Ask/Allow/Deny in Settings; prefer `activeTab` | confirmed | https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions |
| 43 | Widgets: buttons inactive on a locked device; intent runs in the widget extension process by default | confirmed | https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities |
| 44 | Background pushes: "more than a few per hour" | corrected: more than three per hour triggers rate limits; 30 s runtime | https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app |
| 45 | TokenExpiryMessage ~30% `.tokensDidExpire`, FB23391495 "Potential fix identified" | confirmed; added that the OP reports the fix in iOS 27 beta 8 | https://developer.apple.com/forums/thread/844148 |
| 46 | SwiftData fails in ShieldConfiguration extension; `UserDefaults(suiteName:)` works | confirmed (still failing on iOS 27 SDK per OP) | https://developer.apple.com/forums/thread/786195 |
| 47 | Apple said "no supported way" to open the main app from a shield (2022, Jan 2025); `LSApplicationWorkspace` rejection May 2026 | confirmed (2.5.1 rejection) | https://developer.apple.com/forums/thread/719905 |
| 48 | DTS points to App Review 30-minute consultations for 3.3.3(P) questions | confirmed | https://developer.apple.com/forums/thread/837242 |
| 49 | iOS 26.4 revocation asks for Face ID, not the Screen Time passcode | confirmed (forum report, thread 821959) | https://developer.apple.com/forums/tags/screen-time |
| 50 | Apple Pay availability in India as of Oct 2026 | unverifiable (support.apple.com and news sites blocked; WebSearch budget exhausted) | — |
| 51 | Wallet trigger output variables beyond card/merchant/amount (category, currency, type); iOS 17 vs 17.4 | unverifiable (Apple's Shortcuts guide blocked; only third-party snippets) | https://support.apple.com/guide/shortcuts/transaction-trigger-apd65c67538a/ios (not fetched) |
| 52 | one sec / PNAS 2023 effect sizes; Action-button model list; 10-App-Shortcuts cap | unverifiable (pnas.org blocked; Apple docs give no model list or cap) | — |
