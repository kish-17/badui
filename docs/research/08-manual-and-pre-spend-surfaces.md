# Manual, user-initiated and pre-spend surfaces (Research stream 08)

> **Scope.** Every surface through which a user can tell BRAKE "I am about to buy something" (PRE-SPEND), every surface that puts BRAKE inside the payment moment (IN-SPEND), and the user-initiated capture paths (manual entry, receipt, screenshot) that also close the loop after spending (POST-SPEND). In scope: the "Should I buy this?" quick check, quick-entry widgets/controls, share sheet and pasted URLs (with Open Graph / schema.org extraction), browser extensions (Chromium MV3, Safari, Firefox; Honey as a trust lesson), the BRAKE QR scanner, barcode/GTIN lookup, price-tag OCR, receipt OCR, screenshot import, voice (Siri / App Intents, Google Assistant / Gemini / AppFunctions), visual intelligence, app-launch friction (iOS Screen Time shields, Shortcuts automations, Android usage stats, Android accessibility), merchant and payment-provider partnerships, a BRAKE-issued card, and manual transaction entry UX.
>
> **Date:** 2026-10-04. Every time-sensitive claim carries an "as of" date or names the dated document it comes from.
>
> **How this was verified.** The session's web-search quota was exhausted after three searches, and the egress proxy blocked most sites (developers.google.com, developer.chrome.com, support.google.com, schema.org, NPCI, RBI, Stripe docs, Wikipedia, news sites). Facts were checked against the primary sources I could reach: **developer.apple.com** (documentation JSON, App Review Guidelines, developer forums, WWDC transcripts), **developer.android.com**, and **raw GitHub copies of primary sources** (schema.org vocabulary, the Open Graph protocol source, MDN WebExtensions docs, Mozilla Extension Workshop policies, the archived Chrome Web Store policy pages, ML Kit samples, Stripe's OpenAPI spec, Open Food Facts API docs). Anything not checked against such a source is marked **(unverified)**.
>
> **Key takeaways for BRAKE**
>
> 1. **The surface that works everywhere is an amount-first "Should I buy this?" check, at most two taps from system UI.** That means a widget, a Control Center control or the Action button, a Quick Settings tile, an app shortcut or the share sheet. It works for users with no connected accounts, needs no permission, and creates `purchase_intent` observations. Fusion later resolves each intent to *purchased* or *abandoned*, which is BRAKE's main way to measure whether it helps.
> 2. **On iPhone, Screen Time shields are now the strongest automatic pre-spend trigger.** iOS 26.4 added up to three secondary-button submenu items (`secondaryButtonSubmenuItems`). iOS 26.5 added `ShieldActionResponse.openParentalControlsApp`, which ends the workaround of tapping a notification to reach the app. The user picks apps and domains privately (`FamilyActivityPicker`, opaque tokens). Shield extensions run sandboxed with no network access. Distribution needs Apple's *Family Controls (Distribution)* entitlement for each bundle ID and each extension, and approval times are unpredictable. App Review Guideline 4.10 forbids monetizing Screen Time APIs (guidelines as of 2026-06-08).
> 3. **Android gives third parties nothing like system shields.** Detecting a shopping-app launch through `UsageStatsManager` (special "Usage access" grant) and then sending a notification is policy-safe, but it cannot block, and background activity launches are restricted (Android 10+). Overlays and `AccessibilityService` interception would work technically, but they bring heavy privacy and Play-policy risk. **Avoid them for the MVP.**
> 4. **In India, the BRAKE QR scanner is the most valuable in-store in-spend surface.** BRAKE parses the UPI QR (`upi://pay?pa=…&pn=…&mc=…&am=…&tr=…`), shows context, then hands off to the user's own UPI app. The resulting `checkout` observation later fuses with the bank SMS or notification RRN. In the USA no QR payment rail matters, so QR is low value there.
> 5. **Share-to-BRAKE is cross-platform and policy-safe, but share payloads rarely contain a price.** The price has to come from the product page: schema.org `Offer.price` + `priceCurrency` in JSON-LD first, then Meta-style `product:price:*` tags (these are *not* part of the core Open Graph spec), then the visible DOM. On iOS, a share extension with `NSExtensionJavaScriptPreprocessingFile` reads the **live Safari DOM**, including cart totals, without any browser extension.
> 6. **Browser extensions give the best in-flow timing for web shopping but reach few BRAKE users.** They are desktop browsers, Safari on iOS and macOS, and Firefox. Chrome on Android has no extensions (unverified), and Indian e-commerce is app-first. Build them `activeTab`-first with per-site optional host permissions. **BRAKE must never take affiliate revenue.** Honey's 2024–25 affiliate scandal led Chrome to enforce stricter affiliate rules from 2025-06-10. Firefox bans affiliate-tag injection outright and has required declared `data_collection_permissions` for new extensions since 2025-11-03.
> 7. **On-device extraction from price tags, receipts and screenshots is now practical.** Android: ML Kit Text Recognition v2 covers Latin, Devanagari, Chinese, Japanese and Korean, and the Google code scanner and document scanner need no camera permission. iOS: VisionKit `DataScannerViewController` recognises `.currency` (iOS 17), Vision `RecognizeDocumentsRequest` handles receipts and tables (iOS 26), and Foundation Models accepts image attachments with `OCRTool` / `BarcodeReaderTool` (iOS 27 / June 2026 release notes) on Apple Intelligence devices. Gemini Nano runs only on some Android devices, so deterministic parsers come first and LLMs only enhance.
> 8. **Voice: build Siri now, wait on Android.** Siri via App Intents / App Shortcuts is production-ready, and value prompts collect amounts. On Android, the future of Assistant App Actions under Gemini is unclear. AppFunctions needs Android 16+ and was in private preview with Gemini as of May 2026.
> 9. **Partnerships and a BRAKE-issued card give the best in-spend control but are long-horizon bets.** An issuer authorization webhook exposes amount, `merchant_data.category_code`, `merchant_data.name` and `network_data.transaction_id` *before* approval. These options need licences or sponsor banks and require users to switch payment instruments. Merchants have little reason to add friction. Classify all three as *later/research*.
> 10. **Pre-spend amounts are list prices, not amounts paid.** Sales tax (US), shipping, coupons, MRP vs selling price (India), variants and multi-item carts all shift the final figure. Model intents with approximate amounts and expected components. Fusion should rely on merchant and time and treat amount as soft evidence. The current ±15% intent tolerance (`fusion-and-reconciliation.md`) is too tight for some US and online cases (analysis in [Implications](#implications-for-brake-architecture)).

---

## Sources investigated

### How to read this section

Each subsection covers one mechanism and uses the same headings: what it is; data actually available; windows and latency; coverage; access requirements; privacy and consent; reliability and failure modes; dedup keys; the normalized observation (aligned with `packages/core/src/model/observation.ts`); a provenance sentence; and a recommendation. Source ids are stable kebab-case strings for the capability registry (`SourceDefinition.id`).

### Scored comparison matrix (pre-spend / in-spend surfaces)

Scores run 1–5, and **higher is always better for BRAKE**. Friction scores 5 when it is lowest; privacy scores 5 when collection is least invasive; policy scores 5 when platform or store risk is lowest. "Timeliness" means how close to the decision moment the signal arrives. The scores are my analytic judgements from the evidence below, **not measured data**; use them to rank, not as absolute values. "Build" is a rough effort estimate (S/M/L/XL).

| # | Surface (id) | Coverage | Timeliness | Low friction | Privacy | Policy safety | Reliability | Behavioral value | **Total /35** | Build | Cross-platform? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | "Should I buy this?" quick check (`manual-should-i-buy`) | 5 | 4 | 3 | 5 | 5 | 5 | 4 | **31** | S | Yes (all) |
| 2 | iOS Screen Time shield on chosen apps/domains (`ios-screen-time-shield`) | 3 | 5 | 5* | 5 | 3 | 4 | 5 | **30** | M | iOS/iPadOS only |
| 3 | Quick-entry widget / control / tile / Action button (`price-entry-widget`) | 4 | 4 | 4 | 5 | 5 | 5 | 3 | **30** | S | Yes (per-OS UI) |
| 4 | BRAKE QR scanner, **India UPI** (`brake-qr-scanner`) | 4 (IN) | 5 | 3 | 5 | 4 | 4 | 5 | **30** | M | Yes; value is country-specific |
| 5 | Share-to-BRAKE (URL/text) (`share-sheet`) | 5 | 4 | 3 | 4 | 5 | 3 | 4 | **28** | M | Yes |
| 6 | Payment-provider partnership (`payment-provider-partnership`) | 2 | 5 | 5 | 3 | 3 | 5 | 5 | **28** (feasibility low) | XL | Partner-dependent |
| 7 | Price-tag photo / live scan (`price-tag-ocr`) | 4 | 4 | 3 | 5 | 5 | 3 | 3 | **27** | M | Yes |
| 8 | iOS Shortcuts app-open automation (`ios-shortcuts-app-automation`) | 2 | 5 | 2 | 5 | 5 | 3 | 4 | **26** | S | iOS only |
| 9 | iOS Safari share with JS preprocessing (`ios-share-js-preprocessing`) | 2 | 4 | 3 | 4 | 5 | 4 | 4 | **26** | M | iOS/macOS Safari |
| 10 | Merchant partnership (`merchant-partnership`) | 1 | 5 | 5 | 3 | 4 | 4 | 4 | **26** (feasibility very low) | XL | Partner-dependent |
| 11 | Paste product URL (`paste-product-url`) | 5 | 3 | 2 | 4 | 5 | 3 | 3 | **25** | S | Yes |
| 12 | Screenshot import, user-initiated (`screenshot-import`) | 5 | 3 | 3 | 3 | 5 | 3 | 3 | **25** | M | Yes |
| 13 | Siri / App Intents voice (`siri-app-intents`) | 3 | 4 | 3 | 4 | 5 | 3 | 3 | **25** | S | iOS/macOS/watchOS |
| 14 | BRAKE-issued card (`brake-issued-card`) | 2 | 5 | 2 | 3 | 2 | 5 | 5 | **24** | XL | Card-network wide |
| 15 | Safari Web Extension (`safari-web-extension`) | 2 | 5 | 3 | 3 | 4 | 2 | 4 | **23** | M–L | macOS/iOS/visionOS |
| 16 | Android usage-stats launch nudge (`android-usage-stats`) | 4 | 3 | 4 | 3 | 3 | 3 | 3 | **23** | M | Android only |
| 17 | Barcode → GTIN lookup (`barcode-gtin-lookup`) | 3 | 4 | 3 | 4 | 5 | 2 | 2 | **23** | M | Yes |
| 18 | Chromium MV3 extension (`browser-extension-chromium`) | 2 | 5 | 4† | 2 | 3 | 2 | 4 | **22** | M–L | Desktop only |
| 19 | Firefox extension (`firefox-extension`) | 1 | 5 | 3 | 3 | 4 | 2 | 4 | **22** | S (port) | Desktop + Android (unverified) |
| 20 | Android assistant: App Actions / AppFunctions (`android-assistant-actions`) | 2 | 4 | 3 | 4 | 4 | 2 | 3 | **22** | M | Android only |
| 21 | Android accessibility interception (`android-accessibility-service`) | 4 | 5 | 4 | 1 | 1 | 3 | 5 | **23 → avoid** | M | Android only |
| 22 | iOS visual intelligence (`ios-visual-intelligence`) | 2 | 3 | 3 | 4 | 5 | 2 | 2 | **21** | M | iOS 26+/macOS 27 |
| — | Receipt photo OCR (`receipt-photo-ocr`): post-spend | 5 | 1 (pre) | 2 | 4 | 5 | 4 | 2 | n/a pre-spend | M | Yes |
| — | Manual transaction entry (`manual-transaction-entry`): post-spend | 5 | 1 (pre) | 2 | 5 | 5 | 3 | 3 | n/a pre-spend | S | Yes |

\* For shields, "friction" means the effort per use: once configured, the system triggers the shield. The shield itself *adds* friction to shopping, and that is the point. † After installation; installing and granting permissions is a high one-time cost.

### Recommended MVP sets

| Segment | MVP (build first) | Next | Defer / avoid |
|---|---|---|---|
| **(a) Android, India** | Quick check (amount-first, ₹, lakh-grouped keypad) + "wait 24h" wishlist; **UPI QR scanner with hand-off to the user's UPI app**; share-to-BRAKE from Flipkart/Amazon/Myntra/Meesho with on-device page metadata; home widget + Quick Settings tile + app shortcut; screenshot import (cart / UPI success screen) and price-tag scan using ML Kit Text Recognition v2 (Latin + Devanagari); manual cash entry | Opt-in usage-stats launch nudge (notification, never blocking); receipt OCR; barcode lookup for groceries | Accessibility interception; browser extension (low desktop share); voice (AppFunctions preview); BRAKE card (RBI licensing) |
| **(b) iPhone, USA** | Quick check + Control Center control / Action button / Lock Screen widget + Siri App Shortcut; **Screen Time shields on user-chosen shopping apps and web domains**, optionally scheduled to high-regret hours, with "Check with BRAKE" (`openParentalControlsApp`, iOS 26.5+) and "Open for 5/15 min" submenu (iOS 26.4+); share extension with Safari JS preprocessing + URL share from retailer apps; manual entry | Safari Web Extension (`activeTab` + opt-in sites) on iOS/macOS; price-tag scan (`DataScannerViewController` `.currency`); receipt scan (VisionKit + `RecognizeDocumentsRequest`); Foundation Models screenshot parsing | Shortcuts automation (fallback only); `FamilyActivityData` (EU-only and surveillance-grade); BRAKE card; merchant partnerships |
| **(c) No connected accounts (any country)** | Quick check + wishlist/cooling-off timer; manual transaction entry (cash and cards alike); share/paste URL; QR scanner where a QR rail exists; shields (iOS) or launch nudge (Android); **self-reported intent outcomes** ("Did you end up buying it?", asked once at the end of the horizon) | Receipt OCR to log after the fact; screenshot import of payment confirmations | Anything needing a financial partner |

Shields and launch nudges **need no financial account**. They suit User C especially well, because they deliver pre-spend value without any money-movement data.

---

### A. Manual core

#### 1. "Should I buy this?" quick check — `manual-should-i-buy`

- **What it is.** An in-app flow (also reachable from widgets, controls, share and voice) where the user enters an amount and optionally an item, merchant, category, photo or URL. BRAKE replies with *context, not judgement*: what remains in the relevant budget, the effect on a named goal ("moves your Goa trip goal back by ~4 days"), the user's own regret pattern for similar purchases, and a no-pressure "Wait 24h?" option that adds the item to a wishlist and sets a reminder. The brief's "Should I buy this?", "Ask BRAKE" and goal-tracking items all land here.
- **Data available.** User-typed `amount` + `currency` (defaulted from locale), optional `title`, `merchant`, `category`, `url`, `photo`, and a self-reported "planned vs saw-it-now" flag. Everything else comes from BRAKE's own state (budgets, goals, regret history).
- **Windows / latency.** PRE-SPEND (it can also be used IN-SPEND at the till). Latency is whatever the user chooses: the signal exists only if the user remembers to ask, which is the core weakness.
- **Coverage.** All countries, platforms and users, including users with no connected accounts.
- **Access requirements.** None.
- **Privacy & consent.** Minimal and user-authored. Store the structured intent; don't upload photos unless the user opts in.
- **Reliability / failure modes.** The data is reliable because the user typed it. Two weaknesses: *selection bias* (users ask about purchases they already doubt) and *recall*. Abandoned intents can't be told apart from purchases on unconnected rails, so self-report closes the loop for User C.
- **Dedup keys.** Client-generated intent id only. Fusion links the intent to later payments forward-only, by merchant, time and approximate amount (fusion doc: `purchase intent → anything (forward only)`, 24 h horizon, ±15%).
- **Normalized observation.** `kind: "purchase_intent"`, `window: "pre_spend"`, `stage: "intent"`, `amount: {value, confidence: 0.9, approximate: true when the user typed "about"}`, `intent: {via: "should_i_buy", title?, url?}`, `merchant?` (user-typed, confidence 0.7), `confidence: 0.9` that the facts are correct. *Purchase likelihood* is a separate, learned quantity; don't fold it into observation confidence.
- **Provenance sentence.** "You asked BRAKE about this ₹2,499 purchase on Saturday at 10:41 pm."
- **Recommendation: `mvp`.** It is the only universal surface and the anchor for measuring outcomes (intent → purchased / abandoned, in the fusion doc's intent lifecycle).

#### 2. Quick-entry widgets, controls, tiles and shortcuts — `price-entry-widget`

- **What it is.** System-level entry points that open the quick check, pre-focused on a numeric keypad.
  - **iOS:** Home/Lock Screen widgets. Interactive widgets support only *buttons and toggles* backed by App Intents, and Apple says "an interaction with a button or toggle should do more than open the app". Opening the app uses `Link` / `widgetURL` instead. **Controls** (`ControlConfigurationIntent`, iOS 18) work "from Control Center, the Lock Screen, or by using the Action button". App Shortcuts appear in Spotlight and Siri.
  - **Android:** Home-screen widgets (RemoteViews/Glance). These support a restricted view set, and Android 12 added only stateful `CheckBox` / `Switch` / `RadioButton`, so there is no free-text entry. Also a Quick Settings tile (`TileService`) and static or pinned app shortcuts.
- **Data available.** The same fields as #1. A widget can also *show* useful context, such as remaining discretionary budget, without being opened.
- **Windows / latency.** PRE-SPEND / IN-SPEND. About two taps to a focused keypad. Standard KLM estimates (Card, Moran & Newell; not re-verified) put this at roughly 2–3 s before typing begins.
- **Coverage.** iOS 17+ (interactive widgets), iOS 18+ (controls), all modern Android versions. Lock Screen widgets mean users can see context without unlocking. Interactive controls on a locked device require authentication: "on a locked device, buttons and toggles are inactive … unless a person authenticates".
- **Access / policy.** None special.
- **Privacy.** Redact amounts on the Lock Screen by default. Controls support "redact the text in a control when the device is locked".
- **Reliability.** High. Widget timelines are budgeted by the OS, so budget numbers shown in widgets can be stale (refresh on app events).
- **Dedup keys / observation / provenance.** Same as #1 with `intent.via: "widget"`. "You asked BRAKE from your Lock Screen widget at 1:12 pm."
- **Recommendation: `mvp`.** Cheap to build, and it cuts the main friction of #1.

#### 3. Cooling-off timer and wishlist (supporting surface for #1, #5, #9, #12)

- A wishlist item with a countdown ("revisit in 24h / 72h / 30 days"). On iOS this can be a **Live Activity**, which stays active for up to 8 hours and then remains on the Lock Screen for at most 4 more (12 h maximum). That fits a same-day cooling-off timer; longer waits should use scheduled local notifications.
- It produces no new financial facts. It **extends the intent horizon** and marks intent outcomes (`abandoned` after the user removes the item; `purchased` when a matching payment fuses).
- Provenance: "You saved this to your wait list 3 days ago."
- **Recommendation: `mvp`** as a feature of #1, not as a separate adapter.

#### 4. Manual transaction entry — `manual-transaction-entry`

- **What it is.** Post-spend logging of purchases that BRAKE didn't observe: cash, unconnected cards, and every purchase for User C. It is also the correction path ("this was actually two purchases").
- **Data available.** `amount`, `currency`, `merchant` (autocomplete from history), `category` (top-3 predicted chips), `timestamp` (defaults to now; "earlier today" chips), optional `instrument` (cash/card/UPI), `note`, `photo` → receipt pipeline (#15).
- **Windows / latency.** POST-SPEND. Seconds to days after the event.
- **Coverage.** Universal.
- **Privacy.** User-authored, local-first.
- **Reliability.** Accurate when entered; *coverage decays* with user fatigue. That decay is why BRAKE must not depend on it for users who can connect sources.
- **Dedup keys.** None strong. When accounts are later connected, a manual entry and a bank record of the same purchase must merge. Manual observations should therefore be allowed to fuse with money movements (amount exact, ±1 day, merchant similarity), and when uncertain the candidate should be marked *possible duplicate* and the user asked "Is this the same as …?" (fusion doc).
- **Normalized observation.** `kind: "money_movement"`, `stage: "confirmed"`, `window: "post_spend"`, `source.kind: "manual"`, `confidence: 0.85`. Lower than a bank alert because of typos and recall, but the user's word wins over inference via `user_verified`.
- **UX benchmarks (BRAKE design targets, not measured industry data).**

  | Metric | Target | Rationale |
  |---|---|---|
  | Taps from system surface to saved entry (amount + category) | ≤ 4 (open, digits, category chip, implicit save) | amount-first keypad; category from top-3 predictions; time defaults to now |
  | Median completion time | ≤ 6 s | ≈ 2–3 s to reach the keypad + ≈ 2 s digits + ≈ 1.5 s chip (KLM-style estimate) |
  | Fields required | 1 (amount) | everything else optional or inferred; currency from locale/last used |
  | Amount entry | numeric keypad with locale grouping (₹1,23,456 vs $123,456) and minor units | avoid decimal-separator errors |
  | Merchant entry | autocomplete from the user's own history first, then a small on-device merchant list | no network call while typing |
  | Error recovery | undo snackbar; edit in place | no confirmation dialogs |
  | Offline | full function, with sync later | in-store use |
  | Re-ask policy | never ask to categorise an entry the user just categorised | brief: "do not ask when the answer is already highly predictable" |

  Prior-art patterns common in widely used expense trackers (specific apps' 2026 behaviour **unverified**): amount-first keypads, recent-merchant templates, recurring "quick add" buttons, and bank-SMS auto-capture with manual fallback (India).
- **Provenance sentence.** "You added this ₹180 cash purchase manually on Monday."
- **Recommendation: `mvp`** for User C and cash; for connected users it is mainly a correction tool.

---

### B. Share sheet, pasted URLs and product-page metadata

#### 5. Share-to-BRAKE — `share-sheet`

- **What it is.** BRAKE registers as a share target. **Android:** an `ACTION_SEND` intent filter for `text/plain` (URLs arrive in `EXTRA_TEXT`) and `image/*`, plus optional sharing shortcuts (Direct Share). **iOS:** a Share extension whose activation rule sets keys such as `NSExtensionActivationSupportsWebURLWithMaxCount` and `NSExtensionActivationSupportsImageWithMaxCount` (Apple App Extension Programming Guide). The brief's "Ask BRAKE system share action" is this surface.
- **Data available.** It depends on the sending app. Typically a **URL** (often a short or tracking link) plus share text containing the **product title**. Retailer apps usually **do not include the price** in share text (observed behaviour; **unverified** for any specific retailer in 2026). Images arrive as files (screenshots, photos). The price therefore comes from #8 (metadata resolver), OCR (#14/#16), or the user.
- **Windows / latency.** PRE-SPEND (browsing or cart). Seconds; network metadata fetch adds about 0.5–3 s (estimate).
- **Coverage.** iOS and Android, any app with a share action (retailer apps, browsers, social apps, chat). The best broad surface for **app-first** commerce (India).
- **Access / policy.** None special.
- **Privacy & consent.** The user initiates each share. The *URL itself is sensitive*: it reveals what the user is considering (health products, gifts). Strip tracking parameters, resolve short links **on-device**, and don't send URLs to BRAKE servers by default (see #8).
- **Reliability / failure modes.** Short links need redirects. Some retailers return bot-walls or JavaScript-only pages to non-browser fetches. Share text format varies by app and locale. Variant pages may show a different price from the chosen variant.
- **Dedup keys.** Canonical product URL, merchant domain (→ `merchant.website`, `merchant.key`), product ids parsed from URLs or JSON-LD (`sku`, `gtin13`, retailer ids such as an ASIN; the URL patterns are **unverified**). These later match **order-confirmation emails** (line items / product ids) and extension order pages.
- **Normalized observation.** `kind: "purchase_intent"`, `stage: "intent"`, `intent: {via: "share", url, title, productId?}`, `merchant: {raw: domain, website, channel: "online", confidence: 0.9}`, `amount?: {value, confidence 0.6–0.85, approximate: true}`, set according to the metadata tier that produced it (#8).
- **Provenance sentence.** "From the Flipkart link you shared at 10:42 pm (price read from the product page)."
- **Recommendation: `mvp`.**

#### 6. iOS Safari share with JavaScript preprocessing — `ios-share-js-preprocessing`

- **What it is.** A share (or action) extension can declare `NSExtensionJavaScriptPreprocessingFile`. Safari then runs the extension's JavaScript (`ExtensionPreprocessingJS.run(completionFunction)`) **in the current page before the extension starts**. The extension receives the results through `NSItemProvider` under `NSExtensionJavaScriptPreprocessingResultsKey`. The activation rule must set `NSExtensionActivationSupportsWebPageWithMaxCount` to a nonzero value (Apple App Extension Programming Guide).
- **Data available.** Anything the script reads from the rendered DOM: JSON-LD `Product` / `Offer`, Open Graph / Meta tags, **visible cart / checkout totals**, item names, and the order number on confirmation pages. This works even for client-rendered pages that a server fetch would miss.
- **Windows / latency.** PRE-SPEND / IN-SPEND (cart and checkout pages); POST-SPEND on order confirmation pages. Sub-second.
- **Coverage.** Safari on iOS/iPadOS and macOS. Whether `SFSafariViewController` or other browsers on iOS run preprocessing is **unverified**.
- **Access / policy.** None beyond the extension rules (App Review 4.4: extensions "may not include marketing, advertising, or in-app purchases").
- **Privacy.** User-initiated and scoped to one page. BRAKE should extract structured fields locally and discard the DOM.
- **Reliability.** Higher than server-side fetching for price, because it sees what the user sees. DOM heuristics for totals stay fragile, so JSON-LD wins whenever it is present.
- **Dedup keys.** As #5, plus `order_id` (namespace = merchant domain) when shared from a confirmation page.
- **Observation / provenance.** As #5 with `intent.via: "share"` and a note that it was read from the page. "From the cart page you shared from Safari (target.com, total $86.40)."
- **Recommendation: `mvp`** on iOS. It gives about 80% of a Safari extension's value for 20% of the permission cost (analytic estimate).

#### 7. Paste product URL — `paste-product-url`

- **What it is.** A paste field inside the quick check. On iOS, use **`UIPasteControl`** (iOS 16+): "programmatic pasting raises a user alert … Use this class to paste without a user prompt." On Android 12+ the system shows a toast ("APP pasted from your clipboard") the first time an app reads another app's clip, and `getPrimaryClipDescription()` can check the MIME type without triggering it.
- **Data / latency / coverage.** As #5, but with more friction (copy, switch app, paste). Universal.
- **Policy.** **Never read the clipboard silently on app launch.** It triggers OS alerts and erodes trust. Offer an explicit paste button and, at most, a "Looks like you copied a link — check it?" chip only after the user has opened the quick check (inspect the description first).
- **Recommendation: `mvp`** as a field of #1 (low cost). It is not a separate surface to promote.

#### 8. Product-page metadata resolver (Open Graph, schema.org, retailer pages) — `product-page-metadata`

- **What it is.** A pure, on-device resolver that turns a URL or DOM snapshot into `ProductFacts` with per-field provenance. Shares (#5), pastes (#7), Safari preprocessing (#6) and extensions (#18–20) all use it.
- **Data actually available, in order of preference.**
  1. **schema.org JSON-LD** `Product` with `offers` → `Offer.price`, `Offer.priceCurrency`, `availability`, `sku`, `gtin13` (and other GTIN properties), `seller`. `AggregateOffer.lowPrice` / `highPrice` cover multi-seller pages. The schema.org vocabulary requires `priceCurrency` in **ISO 4217** "instead of including ambiguous symbols such as '$'", and asks for `'.'` as the decimal point with no thousands separators, which makes JSON-LD the cleanest source to parse. Order pages may carry `Order.orderNumber`, `acceptedOffer` and `totalPaymentDue` (schema.org definitions).
  2. **Meta / Facebook-style product tags** (`product:price:amount`, `product:price:currency`). These are **not part of the core Open Graph protocol**. The ogp.me spec defines only `og:title`, `og:type`, `og:image` and `og:url` as required, plus vertical types (music, video, article, book, profile, website), and has no price property. The product tags are a Meta catalogue convention (Meta docs **unverified** in this session). Treat them as tier 2.
  3. **Core Open Graph** `og:title`, `og:image`, `og:url` (canonical), `og:site_name`: title and merchant only.
  4. **Visible DOM heuristics**: price elements near "Add to cart", strikethrough vs sale price. This is fragile and varies by locale.
  5. **Retailer product APIs**, such as Amazon's Product Advertising API. These usually require an affiliate relationship, which **conflicts with BRAKE's no-affiliate principle**. Their 2026 status and terms are **unverified**. Avoid.
- **Windows / latency.** PRE-SPEND; 0.5–3 s for a network fetch (estimate), ≈0 for DOM snapshots.
- **Privacy.** Fetching from **BRAKE servers would leak intent** (who is looking at what) and would also look like scraping from a single IP range. Fetch **on-device**, with no cookies, a standard user agent and stripped query parameters. Allow a privacy-proxy fallback only with consent.
- **Reliability.** JSON-LD price: high confidence (≈0.85) for the *list price* of the default variant. Meta price tags ≈0.75. DOM heuristics ≈0.5. Title-only: no amount. Prices vary by personalisation, location, variant and time. Store `observedAt`.
- **Normalization pitfalls.** See [Implications](#implications-for-brake-architecture): currency symbols, decimal commas, Indian digit grouping, MRP vs selling price, tax-exclusive US prices, `AggregateOffer` ranges.
- **Recommendation: `mvp`** (as a library, not a user-facing source).

---

### C. Browser extensions

#### Prior art and the Honey trust lesson

- **Prior art.** Honey (PayPal), Capital One Shopping and Rakuten all use the same mechanism: content scripts recognise checkout pages and inject coupons, cashback and **affiliate attribution**. Their business model *rewards completed purchases*, which is the opposite of BRAKE's mission. Friction-oriented extensions also exist (e.g. "Icebox"-style cooling-off extensions; **unverified** in 2026).
- **The 2024–25 Honey controversy (trust lesson).** A widely viewed investigation (MegaLag, December 2024; exact date **unverified**) alleged that Honey replaced creators' affiliate cookies even when it supplied no coupon, and suppressed better coupons for partner merchants. According to contemporary reports consulted via search results (the pages themselves were blocked), Google announced a Chrome Web Store affiliate policy update on **2025-03-11** and **began enforcement on 2025-06-10**. Under the update, extensions may include affiliate links only if the programme is prominently disclosed, a related user action precedes each affiliate code, link or cookie, and the code gives the user an immediate, tangible benefit. Honey then added disclosure (2025-03-12) and stopped claiming attribution when it had no coupon or "Gold" (2025-03-13). The archived 2022 Chrome policy text already required "related user action … before the inclusion of each affiliate code, link, or cookie". **Firefox's Add-on Policy §7.3 is stricter:** "Modifying web content or facilitating redirects to include affiliate promotion tags is not permitted."
- **Implications for BRAKE.** (1) **No affiliate revenue and no coupon injection, ever.** Any commerce revenue creates an incentive to encourage spending and would undermine BRAKE's credibility. (2) Publish a plain-language "what the extension reads" page. (3) Chrome's *Limited Use* policy (archived 2022 text) prohibits "collection and use of web browsing activity … except to the extent required for a user-facing feature described prominently", forbids using such data for personalised ads, and forbids using or selling it "to determine credit-worthiness or for lending purposes". That matters if BRAKE ever partners with lenders or BNPL providers.

#### 9. Chromium MV3 extension (Chrome, Edge, Brave…) — `browser-extension-chromium`

- **What it is.** An MV3 extension with three tiers of access:
  - **Tier 0, `activeTab` only.** When the user clicks the toolbar button, a context-menu item or a keyboard shortcut, the extension gets temporary scripting access to the active tab and its `url` / `title`. Access ends when the tab navigates (MDN).
  - **Tier 1, `optional_host_permissions`.** Requested at runtime for a **user-chosen list of shopping sites**. Content scripts then detect cart and checkout pages without a click and show a non-blocking "pause" panel.
  - **Tier 2, `<all_urls>`.** **Avoid.** It is surveillance-grade and draws harsher store review (review behaviour **unverified**).
- **Data available.** Page URL and domain; JSON-LD / meta / DOM facts (#8); detected **cart / checkout totals**, line-item titles and quantities; the **order confirmation number** and total on thank-you pages; the payment-method label if visible. Checkout detection combines URL tokens (`/cart`, `/checkout`, `/basket`, `/buy`), CTA texts ("Place order", "Pay now", "Proceed to pay"), `schema.org/Order` markup, and PSP iframe origins. Cross-origin payment iframes are opaque without host permission for those origins.
- **Windows / latency.** PRE-SPEND (cart), IN-SPEND (checkout, about 100 ms after DOM ready), POST-SPEND (confirmation page). **The best in-flow timing of any web surface.**
- **Coverage.** Desktop Chromium browsers. **Chrome on Android does not support extensions** (as of 2026, **unverified**). Low reach in app-first markets (India).
- **Access / policy.** Chrome Web Store developer account and review; *single purpose*; *Limited Use*; MV3 bans remotely hosted code (**unverified** in this session), so per-merchant detectors must ship as signed **data**, not code. Permission warnings appear at install (MDN: "Chrome displays the permissions in the install prompt").
- **Privacy & consent.** Process everything inside the extension and transmit only the `purchase_intent` / `checkout` / `order` observation after the user opts in. Provide a per-site on/off switch and a "pause on this site" option.
- **Reliability.** DOM heuristics break when retailers redesign. Single-page-app navigation needs MutationObservers. Multiple tabs and carts cause noise. A/B-tested checkouts. Mitigate by preferring structured data, using generic detectors plus a small curated detector set, and degrading to tier 0.
- **Dedup keys.** `order_id` (namespace = merchant domain), which matches **email order confirmations** and receipts; cart total + domain + time match card or UPI money movements.
- **Normalized observations.** Cart: `purchase_intent` (`via: "cart"`, `amount` approx, confidence ≈0.8). Checkout: `kind: "checkout"`, `stage: "intent"`, `window: "in_spend"`, `amount` ≈0.85. Confirmation: `kind: "order"`, `stage: "confirmed"`, `references: [{type: "order_id", value, namespace: domain}]`, confidence ≈0.9.
- **Provenance sentence.** "From your cart on bestbuy.com, via BRAKE's Chrome extension."
- **Recommendation: `next`** (US/EU desktop users). `avoid` for India MVP.

#### 10. Safari Web Extension (macOS, iOS, iPadOS, visionOS) — `safari-web-extension`

- **What it is.** The same WebExtension code packaged inside the BRAKE app ("available in macOS with Safari 14 and later, visionOS 1 and later, and iOS 15 and later"). It must be distributed through an app and Xcode or App Store Connect packaging.
- **Permission model (Apple docs).** Request `activeTab`, host patterns (MV3: `host_permissions`) or `optional_permissions`, and "only use `<all_urls>` if there is no other option". On iOS the user grants access per site from the extension's entry in the More menu, choosing "a single use, for the day, or for all websites" on macOS. They manage it later in **Settings → Safari → Extensions**, with Ask / Allow / Deny per site. Since Safari 17, a per-site grant covers all profiles and private browsing. App Review 4.4.2 says Safari extensions "should not claim access to more websites than strictly necessary".
- **Messaging.** Native messaging plus an app group lets the extension hand observations to the BRAKE app locally, with no server round trip.
- **Data / windows / dedup / observations.** As #9.
- **Coverage.** iPhone users in the USA who shop in Safari are the main win. Enabling the extension takes several steps in Settings (high one-time friction). Adoption rates are **unverified**.
- **Recommendation: `next`** for iPhone USA, after #6 (Safari share preprocessing) proves demand.

#### 11. Firefox extension — `firefox-extension`

- **What it is.** The same code base. Firefox supports MV2 and MV3, and since Firefox 127 it shows MV3 host permissions in the install prompt (MDN).
- **Policy (Mozilla, as of the 2026-03-12 doc revision).** Since **2025-11-03**, all *new* extensions must use Firefox's built-in data-collection consent, declaring `browser_specific_settings.gecko.data_collection_permissions` with `required` / `optional` lists drawn from a taxonomy that includes `financialAndPaymentInfo`, `browsingActivity`, `websiteContent` and `websiteActivity`. Extensions that transmit nothing must declare `"required": ["none"]`. The policy's consent rules prohibit deceptive design such as "multi-step consent decline flows". §7.3 bans affiliate-tag injection.
- **Coverage.** Small desktop share, plus Firefox for Android (extension support **unverified** in this session).
- **Recommendation: `later`**, as a low-cost port once #9 exists. BRAKE should declare `required: ["none"]` and make `financialAndPaymentInfo` / `websiteContent` optional.

---

### D. Camera and image surfaces

#### 12. BRAKE QR scanner — `brake-qr-scanner`

- **What it is.** An in-app scanner that classifies and parses QR payloads.
  - **Android:** the Google code scanner scans "without requiring to request camera permission" (ML Kit sample README), or ML Kit barcode-scanning on CameraX.
  - **iOS:** VisionKit `DataScannerViewController` (barcodes + text) or Vision barcode detection.
  - **Payload families:**
    - **UPI URI** (`upi://pay?…`). Parameters per the NPCI UPI linking specification (not re-fetched; **unverified** in this session): `pa` payee VPA, `pn` payee name, `mc` merchant category code, `am` amount (optional), `cu` currency, `tr` transaction reference (dynamic QRs), `tn` note, `tid`, `url`. Signed-QR variants exist (**unverified**).
    - **EMVCo Merchant-Presented QR** (TLV), used by Pix, PromptPay, PayNow, QRIS, DuitNow and others. Tags from the EMVCo MPM spec (not re-fetched; **unverified**): 52 MCC, 53 currency, 54 amount, 58 country, 59 merchant name, 60 city, 62 additional data such as bill number and reference label, 63 CRC.
    - **Plain URL**, which goes to #8.
    - **GS1 Digital Link** URLs carrying a GTIN, which go to #13.
    - **Fiscal receipt QRs**, which go to #15.
- **In-spend flow (India).** The user scans the shop's QR in BRAKE instead of in PhonePe or Google Pay. BRAKE shows "₹ at <pn> — Eating out has ₹1,150 left this week". The user taps **Pay with my UPI app**, and BRAKE fires the original `upi://pay` URI as an Android `ACTION_VIEW` intent with a chooser, so the user's own PSP app collects the PIN. BRAKE never touches funds. The UPI-intent stream covers hand-off mechanics and iOS URL-scheme limits; whether NPCI rules constrain a non-PSP app that relays a scanned QR is **unverified** (open question).
- **Data available.** Payee VPA (`pa`), name (`pn`), MCC (`mc`; P2P handles typically use `0000`, **unverified**), amount if the QR is dynamic, reference `tr`, and the BRAKE-side scan timestamp. There is **no** user account data.
- **Windows / latency.** PRE-SPEND → IN-SPEND (seconds before payment). This is the only in-store IN-SPEND surface a consumer app can own without a partnership.
- **Coverage.** High value in **India** (UPI QR is ubiquitous at merchants) and other markets with QR rails (Brazil Pix, Thailand, Singapore, Indonesia, Malaysia; details **unverified** in this stream). **Low value in the USA** (no consumer QR payment rail of significance).
- **Access / policy.** Camera permission, unless the Google code scanner is used on Android.
- **Privacy.** Merchant VPAs are business identifiers. **Personal VPAs (P2P QRs) are personal data**: store a hash, not the raw handle, unless the user labels the contact.
- **Reliability.** Structured payloads are near-exact. Static merchant QRs omit `am`, so the user enters the amount, or it comes later from SMS. Habit change is the real barrier: users must open BRAKE instead of their payment app.
- **Dedup keys.** `merchant.handle = pa` (strong merchant join with the UPI SMS/notification counterparty); `tr` → `merchant_reference`; amount + time ≤ 1 h. The bank alert's **RRN/UTR** (`rail_reference`) then joins the candidate.
- **Normalized observation.** `kind: "checkout"`, `window: "in_spend"`, `stage: "intent"`, `rail: {family: "account_to_account_instant", scheme: "upi"}`, `merchant: {raw: pn, handle: pa, mcc: mc, channel: "in_store", confidence: 0.95}`, `amount?: {value, confidence: 0.95}` (dynamic QR), `references: [{type: "merchant_reference", value: tr, namespace: pa}]`, `confidence: 0.95`.
- **Provenance sentence.** "Scanned from the UPI QR code at Sharma General Store (payee sharmastore@…) at 7:02 pm."
- **Recommendation: `mvp` for India** (and other QR-rail markets after they are verified). `later` for the USA (URL QRs only).

#### 13. Barcode / GTIN lookup — `barcode-gtin-lookup`

- **What it is.** Scan an EAN/UPC (GTIN-8/12/13/14) or a GS1 Digital Link and look up the product. A GTIN-12 (UPC) converts to GTIN-13 "by simply adding a preceding zero" (schema.org `gtin13`).
- **Data available.** **No price.** A GTIN identifies the product, not the offer. Product databases give name, brand and category. Open Food Facts covers food (ODbL licence; data "provided voluntarily … no assurances that the data is accurate"). Its read limit is **15 req/min/IP**, and it asks for a custom `User-Agent` (`AppName/Version (ContactEmail)`); API v2 is deprecated in favour of v3 (Open Food Facts API docs, GitHub, as of 2026). For non-food items, commercial UPC databases and GS1's registry exist (terms, coverage and cost **unverified**).
- **Windows / latency.** PRE-SPEND in store; ≈1 s lookup.
- **Value to BRAKE.** "Have you bought this before?" (match against past receipt line items), "It's on your wait list", category hints for essentiality (groceries vs electronics). The price still has to come from a shelf tag (#14) or the user.
- **Reliability.** Coverage outside packaged food is patchy; Indian MRP-labelled goods are well covered by GS1 India in principle (**unverified**).
- **Dedup keys.** `productId: "gtin:<14-digit>"`, which joins receipt line items and e-commerce JSON-LD `gtin*`.
- **Observation.** `purchase_intent`, `intent.via: "barcode"`, `intent.productId`, `categoryHints: [{scheme: "gs1_gpc" | "off_category", …}]`, no amount unless OCR or the user supplies one.
- **Provenance sentence.** "From the barcode you scanned (Maggi 2-Minute Noodles, 280 g)."
- **Recommendation: `later`.** Low behavioural value relative to cost. Reuse the camera stack from #12.

#### 14. Photo or live scan of a price tag — `price-tag-ocr`

- **What it is.** Point the camera at a shelf tag or price label; BRAKE extracts the amount and pre-fills the quick check.
  - **iOS:** `DataScannerViewController` with `.text(textContentType: .currency)` (iOS 17+) highlights money amounts live.
  - **Android:** ML Kit Text Recognition v2 (bundled models for **Latin, Chinese, Devanagari, Japanese, Korean**; `com.google.mlkit:text-recognition*` in the official sample) plus a BRAKE currency grammar.
- **Data available.** Candidate amounts with bounding boxes. Optionally a product name (nearby text), unit price, "MRP ₹… (incl. of all taxes)" in India, and strikethrough vs sale price.
- **Windows / latency.** PRE-SPEND; live scan ≈1–2 s.
- **Reliability / pitfalls.** Several numbers per tag (unit price, per-kg price, MRP, offer price, SKU codes), so ask the user to tap the right one. US shelf prices **exclude sales tax**. Indian packs show **MRP**, which may exceed the selling price. Glare, angle, and digit confusions (1/7, 5/S).
- **Privacy.** Fully on-device. Discard the image unless the user saves it.
- **Dedup keys.** None strong; merchant comes from location only if the user permits it (avoid by default).
- **Observation.** `purchase_intent`, `intent.via: "price_tag"`, `amount: {confidence: 0.6, approximate: true}`, `amountBreakdown` with a locale-estimated tax component for tax-exclusive locales, `confidence: 0.6`.
- **Provenance sentence.** "Read from a photo of a price tag — tap to correct the amount."
- **Recommendation: `next`.** It is the cheapest physical-store pre-spend surface outside QR markets. Put it in the MVP for India only if the UPI scanner ships first and shares the camera code.

#### 15. Receipt photo OCR (and fiscal receipt QR) — `receipt-photo-ocr`

- **What it is.** Capture a paper receipt (or import a PDF/photo) and extract the merchant, date and time, total, tax, line items and payment hints.
  - **Android:** the ML Kit **Document Scanner** (no camera permission needed, per the ML Kit sample README) plus Text Recognition v2.
  - **iOS:** VisionKit document camera plus **Vision `RecognizeDocumentsRequest`** (iOS 26), which returns a `DocumentObservation` "grouped by words, lines, or paragraphs" including **tables and lists**, and names *receipts* explicitly as a target.
  - **iOS 27:** Foundation Models multimodal prompting with `@Generable` output structs and Vision-backed `OCRTool` / `BarcodeReaderTool` (June 2026 release notes) on Apple Intelligence devices.
  - **Android flagships:** the ML Kit GenAI **Prompt API** (Gemini Nano, via AICore) supports "text-only or multimodal" prompts, but only on supported devices (device list **unverified**).
- **Data available.** `merchant_raw` (header), `total`, `subtotal`, `tax`, `tip`, line items (description, qty, unit price), date and time, receipt or invoice number, terminal id, **card last4 and sometimes an approval/auth code** (common on US card receipts, **unverified** as a rule), GSTIN and invoice number on Indian GST invoices, and UPI ref numbers on some POS slips (**unverified**).
- **Fiscal receipt QR (research).** Several countries print machine-readable fiscal QRs on receipts or e-invoices: for example Brazil NFC-e access keys, Saudi ZATCA e-invoice QR (TLV with seller, VAT number, timestamp, total, VAT), and India's B2C dynamic QR for large GST taxpayers. Formats and coverage are **unverified** in this stream. When present they give exact totals and invoice ids without OCR; register them as a capability (`receipt:fiscal-qr`) per country.
- **Windows / latency.** POST-SPEND (minutes to days). Its value is **line items and semantic context**, which matter most for the brief's richer attributes (essentiality, ownership).
- **Reliability.** Totals are good when validated (Σ items + tax ≈ total); line-item text is abbreviated and noisy. Thermal-paper fading.
- **Privacy.** Receipts may carry names, partial card numbers and loyalty ids. Extract the fields, then **drop the image** by default (Evidence `excerpt` with an expiry).
- **Dedup keys.** Card `last4` + `auth_code` (`references.type: "auth_code"`, namespace = merchant), receipt or invoice id, total + merchant + timestamp ±10 min. These match card feed or Plaid transactions, SMS alerts and email e-receipts.
- **Observation.** `kind: "receipt"`, `stage: "confirmed"`, `window: "post_spend"`, `lineItems[]`, `amountBreakdown` (subtotal/tax/tip/discount), `instrument: {type: "card", last4}`, `confidence: 0.8` (validated total) or 0.6 (unvalidated).
- **Provenance sentence.** "From your receipt photo (Trader Joe's, $42.17, Visa ••4821)."
- **Recommendation: `next`** (post-spend semantic enrichment). `mvp` for User C only as a fast logging path if the capture pipeline is shared with #14/#16.

#### 16. Screenshot import (user-initiated) — `screenshot-import`; automatic screenshot detection — `screenshot-auto-detection`

- **What it is.** The user shares a screenshot to BRAKE: an iOS share extension image activation rule, Android `ACTION_SEND image/*`, or the Android photo picker. Useful screenshots include a **cart or checkout screen** in a shopping app (pre-spend), a **UPI or bank "payment successful" screen** (post-spend; usually shows the amount, payee and **UPI transaction id / UTR**), an order summary, a subscription paywall, and a BNPL plan.
- **Extraction.** On-device OCR (ML Kit; Vision `RecognizeTextRequest` / `RecognizeDocumentsRequest`) plus template grammars for common layouts (payment-success screens of the main UPI apps, cart summaries). The on-device LLM, where available, fills a `@Generable` struct `{amount, currency, payee, reference, items[]}`. **Cloud LLMs only with explicit, specific consent.** App Review 5.1.2(i) (as of 2026-06-08) requires that apps "clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission".
- **Automatic detection (avoid).** iOS posts `userDidTakeScreenshotNotification` only to the foreground app, with no `userInfo` and no image. Android 14's `Activity.ScreenCaptureCallback` (`DETECT_SCREEN_CAPTURE`) fires only while *your* activity is visible and "doesn't provide an image". Detecting screenshots taken in *other* apps would require broad photo-library access, which conflicts with the Android photo-picker direction and Play's photo/video permission policy (policy text **unverified** in this session) and is invasive on iOS. **Do not build it.** Offer a "Share to BRAKE" habit instead (and on iOS, a Shortcuts action that accepts an `IntentFile`).
- **Windows / latency.** PRE-SPEND (cart), POST-SPEND (confirmation); seconds after sharing.
- **Privacy.** Screenshots often contain unrelated personal data such as addresses, phone numbers, chats and balances. Crop to the region of interest, redact the rest, and keep only the extracted fields.
- **Dedup keys.** UTR / RRN (`rail_reference`, namespace `upi`), order id, amount + payee + time. These are strong joins to SMS, notification and AA records.
- **Observation.** Payment-success screenshot: `money_movement`, `stage: "confirmed"`, `references: [{type: "rail_reference", value: utr, namespace: "upi"}]`, `confidence: 0.85`. Cart screenshot: `purchase_intent` with `via: "screenshot"`, `confidence: 0.7`.
- **Provenance sentence.** "From a screenshot you shared of a PhonePe payment confirmation (UPI ref …4417)."
- **Recommendation: `screenshot-import` `mvp`** (Android India) / `next` (iOS USA). **`screenshot-auto-detection` `avoid`.**

#### 17. iOS visual intelligence integration — `ios-visual-intelligence`

- **What it is.** iOS 26 lets apps serve results when a person uses visual intelligence on the camera or **a screenshot**. The app implements an `IntentValueQuery` whose `values(for: SemanticContentDescriptor)` gets generic `labels` (en_US, e.g. "tower", **never** the specific product name) and a `pixelBuffer`, and returns `AppEntity` results. Since June 2026 this is also available to macOS apps (macOS 27).
- **Fit for BRAKE.** Weak. It is designed for **searching an app's content**. BRAKE could match a product photo against the user's wish list or past purchases, or return a "Check this with BRAKE" entity, but the latter stretches the API's intent and may not pass review (**unverified**). Labels are too generic to price.
- **Recommendation: `research`.**

---

### E. Voice and assistants

#### 18. Siri, App Intents and App Shortcuts — `siri-app-intents`

- **What it is.** An `AppIntent` "CheckPurchase" (amount, optional item and merchant) exposed as an **App Shortcut**, with phrases that must contain the app name token (`.applicationName`), plus Spotlight, Shortcuts, Action button and Control Center reuse. Apple's App Shortcuts session (WWDC22 10170) describes **value prompts** "to ask the user for an open-ended value … great for types like strings or integers", so "Hey Siri, check a purchase with BRAKE" → "How much is it?" works. Since June 2025, `SnippetIntent` allows interactive result snippets. June 2026 added `LongRunningIntent`, `UndoableIntent` and `RunSystemShortcutIntent` from widgets (App Intents updates page).
- **Data.** As #1. Apple notes it "may extract anonymized App Shortcuts data such as localized phrases … title and description" for model training. That covers phrases, not user values.
- **Windows / latency.** PRE-SPEND; about 3–6 s by voice.
- **Coverage.** iOS 16+ (App Shortcuts), watchOS, macOS. Speaking amounts aloud in shops is socially awkward, so voice fits *at home / online*.
- **Privacy.** Speech goes through Apple's Siri pipeline under Apple's terms. BRAKE receives only the resolved parameters.
- **Observation / provenance.** `purchase_intent`, `intent.via: "voice"`. "You asked Siri to check this $80 purchase with BRAKE."
- **Recommendation: `next`** (iPhone USA). Cheap once the App Intent exists, and the same intent powers controls and the Action button (#2), which *are* MVP.

#### 19. Google Assistant App Actions, Android AppFunctions and Gemini — `android-assistant-actions`

- **App Actions** (developer.android.com, as of 2026): built-in intents declared in `shortcuts.xml` `<capability>` elements; "Users can only access App Actions on Android phones. Assistant on Android Go does not support App Actions", and Google "may exercise discretion in surfacing your Action". How App Actions behave now that Gemini has replaced Assistant on many devices is **unverified**.
- **AppFunctions** (Android 16+, API 36): apps expose functions "like on device MCP servers". Callers need `EXECUTE_APP_FUNCTIONS`. The API is labelled **experimental**, and "as of May 2026, AppFunctions integration with Gemini is in a private preview with trusted testers."
- **Recommendation: `later`** (re-evaluate when AppFunctions reaches GA with Gemini). Exposing `checkPurchase(amount, item)` as an AppFunction is cheap to prototype.

---

### F. App-launch friction and selected-app shielding

#### 20. iOS Screen Time shields (FamilyControls + ManagedSettings + DeviceActivity) — `ios-screen-time-shield`

- **What it is.**
  1. **Authorize.** `AuthorizationCenter.shared.requestAuthorization(for: .individual)` (iOS 16+). The device owner approves with Face ID or Touch ID. With individual authorization, the system lifts the anti-circumvention restrictions, so the user can still delete BRAKE.
  2. **Pick.** `FamilyActivityPicker` lets the user choose "applications, web domains, and categories **without revealing their choices to the app**". BRAKE gets opaque `ApplicationToken` / `WebDomainToken` / `ActivityCategoryToken` values.
  3. **Shield.** `ManagedSettingsStore().shield.applications` / `.webDomains` / `.applicationCategories` / `.webDomainCategories`. Shielding "dims the app's icon on the homescreen and applies an hourglass symbol. When the app launches, the system covers it with a view that your app can configure."
  4. **Configure the shield.** A `ShieldConfigurationDataSource` extension returns a `ShieldConfiguration` with `backgroundBlurStyle`, `backgroundColor`, `icon`, `title`, `subtitle`, `primaryButtonLabel`, `primaryButtonBackgroundColor`, `secondaryButtonLabel` and, **new in iOS 26.4**, `secondaryButtonSubmenuItems` (up to three items, e.g. "1 more minute / 15 more minutes / 1 more hour", handled as `ShieldAction.first/second/thirdSecondarySubmenuItemPressed`). The system passes the extension "the display names, bundle identifiers, and domains" of what it shields, but the extension "runs in a sandbox" that "prevents your extension from making network requests or moving sensitive content outside the extension's address space".
  5. **Act.** A `ShieldActionDelegate` returns `ShieldActionResponse` `.none` / `.close` / `.defer` or, **new in iOS 26.5, `.openParentalControlsApp`**: "open your parental controls app that is responsible for shielding the application or web browser". Before 26.5, developers (including one sec's author, forum thread of March 2026, and an earlier thread from July 2025) had to post a local notification and ask the user to tap it, which was unreliable under Focus modes and Apple Intelligence notification summaries.
  6. **Schedule.** `DeviceActivityMonitor` (`intervalDidStart` / `intervalDidEnd` / threshold events) applies shields only during chosen windows. `DeviceActivityEvent` thresholds measure time an app or domain is frontmost, and web-domain activity covers "Safari or any third-party browser that contributes web usage via a `STWebpageController`".
- **BRAKE design.** The user picks shopping and food-delivery apps and shopping domains, and optionally schedules shields for **high-regret windows** learned from the regret loop (e.g. 22:00–02:00, per the brief's "late-night ecommerce is frequently regretted"). The shield reads "Pause for a second? This week's fun money: $64 left." The primary button "Check with BRAKE" opens BRAKE (26.5+) on the quick check, pre-tagged with the app. The secondary button, "Continue", has a submenu: "5 minutes / 15 minutes / I'm not shopping". `ShieldActionDelegate` temporarily removes the token from the store and a DeviceActivity schedule re-applies it. **Always allow one-tap continuation; never hard-block.**
- **Data available.** Context only: *the user opened app X (token) at time T and chose action A*. Inside the extension, app display name and bundle id are known, but they can't leave the sandbox. Pre-computed budget numbers can be shown if they sit in shared storage that the extension can read (app-group reads by shield extensions are common practice but **unverified** as a documented guarantee).
- **Windows / latency.** PRE-SPEND, at the **earliest possible moment** (app launch), with zero lag (system-rendered).
- **Coverage.** iOS/iPadOS 16+ for individual authorization. `openParentalControlsApp` needs 26.5+ and submenus 26.4+, with a fallback (notification workaround) on older versions. Not on Android.
- **Access requirements.** The Family Controls capability, and **before App Store or TestFlight distribution a separate "Family Controls (Distribution)" approval**. Apple: "If your app includes a Screen Time API app extension such as Device Activity Monitor, Device Activity Report, Shield Action, or Shield Configuration, submit the same request for the extension." Status is checked under Capability Requests. Developers on Apple's forums report waits of days to several weeks with little status feedback (threads from March–April 2026), so **file on day 1**. App Review 4.10 (as of 2026-06-08) forbids monetizing "Screen Time APIs", so do not put shields behind a paywall without legal review.
- **Privacy & consent.** This is the best privacy model of any app-launch surface. Selections are tokenized; BRAKE never learns the user's app list.
- **Reliability.** Enforced by the system and reliable once set. Developer forums report recurring DeviceActivity scheduling bugs (**unverified** for 2026). Users can revoke at any time in Settings.
- **Behavioral value.** Very high. It interrupts autopilot at the right moment. A 2023 PNAS field study of the friction app *one sec* reported fewer target-app openings after adding a short delay (Grüning et al., 2023; figures **unverified** in this session). The risk is annoyance, which personalised, scheduled and easily bypassed shields reduce.
- **Dedup keys.** None. This is context, never a transaction.
- **Normalized observation.** `kind: "app_context"`, `window: "pre_spend"`, `stage: "intent"`, `source.kind: "app_activity"`, with `intent: {via: "shield"}` only if the user taps "Check with BRAKE". The app identity stays a BRAKE-local token reference and is never uploaded.
- **Provenance sentence.** "You opened a shopping app you asked BRAKE to pause during late evenings."
- **Recommendation: `mvp`** for iPhone (all countries).

#### 21. iOS Shortcuts personal automation on app open — `ios-shortcuts-app-automation`

- **What it is.** The user creates a personal automation "When <App> is opened → run BRAKE's App Intent / open BRAKE". (Running without confirmation, the "Notify When Run" option, and the fact that personal automations cannot be shared or installed programmatically are all **unverified** against Apple's Shortcuts User Guide in this session; Apple support pages were blocked.)
- **Assessment.** No entitlement is needed, but setup is manual and multi-step, re-triggers need debouncing (BRAKE → back to app → automation fires again), and it is now **superseded by shields + `openParentalControlsApp`**.
- **Recommendation: `later`** (fallback for users who decline Screen Time authorization).

#### 22. iOS `FamilyActivityData` (EU only) — `ios-family-activity-data`

- **What it is (iOS 26.4).** With the new **`approvedWithDataAccess`** authorization status and the *Family Controls App and Website Usage* entitlement, an app can read the actual `installedApplications` (bundle identifiers), `visitedWebDomains` (domain names) and category names. This only works on devices "located in the EU that are signed in with an Apple Account with an EU country or region", and "only one app at a time can hold this authorization status on a given device".
- **Assessment.** It is surveillance-grade and BRAKE doesn't need it: shields work on tokens. The one-app-per-device exclusivity means BRAKE would compete with screen-time apps.
- **Recommendation: `avoid`** (document it in the registry as an EU capability).

#### 23. Android usage-stats launch detection + nudge — `android-usage-stats`

- **What it is.** With `android.permission.PACKAGE_USAGE_STATS`, which "the user of the device still needs to grant … through the Settings application" (`Settings.ACTION_USAGE_ACCESS_SETTINGS`), BRAKE polls `UsageStatsManager.queryEvents()` for `UsageEvents.Event.ACTIVITY_RESUMED` (API 29+; it includes package and class name) for a user-chosen set of shopping packages. On a match, it posts a heads-up notification ("Opening Myntra — ₹1,150 left for treats this week. Check something?"). The user picks apps from the launcher-visible list; avoid `QUERY_ALL_PACKAGES`, which Android limits to cases such as accessibility, browsers, device management, security and antivirus apps. Declare `<queries>` or use the launcher intent instead.
- **Why not an interstitial.** Since Android 10, background activity launches are blocked unless an exception applies, for example a `SYSTEM_ALERT_WINDOW` grant, a system `PendingIntent` such as a notification tap, or a visible window. Android's guidance asks apps to start with "standard notifications and only escalating to more intrusive options when necessary". Android 15–17 tighten PendingIntent and `IntentSender` BAL opt-ins. A full-screen interstitial would therefore need the "Display over other apps" grant, which is a much bigger trust ask.
- **Latency / reliability.** Event delivery is not push. Polling needs a running component, either a foreground service or frequent work, and polling intervals plus OEM battery management add seconds of lag or missed events (OEM behaviour **unverified** per vendor). Google Play declaration requirements for usage access and for a foreground-service type used for this purpose are **unverified** in this session (open question).
- **Privacy.** Usage access exposes *all* app usage to BRAKE even if it filters locally. Explain this clearly, process on-device, store only the event "opened a chosen app at T".
- **Observation / provenance.** `app_context` as #20. "You opened Myntra, one of the apps you asked BRAKE to watch."
- **Recommendation: `next`** (Android India, opt-in, notification-only).

#### 24. Android AccessibilityService interception — `android-accessibility-service`

- **What it is.** An accessibility service receives window-change events for all apps, or for apps listed in `android:packageNames`. It could detect shopping-app launches and even read cart totals or "Place order" screens, then overlay friction.
- **Policy / OS signals.** `android:isAccessibilityTool` declares whether a service assists users with disabilities; if false, "system will show a notification after a duration to inform the user about the privacy implications of the service." Google Play's AccessibilityService policy restricts non-accessibility uses and requires a prominent disclosure and declaration (current 2026 policy text **unverified**). Sideloaded apps face "restricted settings" (**unverified** detail).
- **Assessment.** Technically the strongest Android in-flow signal (it can read checkout screens of any app). But it is maximally invasive (it can read everything on screen, including OTPs and balances), carries high policy risk and contradicts BRAKE's privacy principle.
- **Recommendation: `avoid`.**

---

### G. Partnerships and instruments

#### 25. Merchant partnerships — `merchant-partnership`

- **What it is.** A merchant integrates BRAKE into checkout: a "Pause with BRAKE" button, a pre-checkout budget check, or structured order webhooks for consenting users.
- **Incentives.** Merchants optimise conversion, so pre-spend friction is against their interest. Plausible partners are those with a *regulatory or brand* reason to be seen promoting responsible spending: BNPL providers, subscription businesses reducing churn-by-regret, and retailers that want returns down. All speculative (**unverified** market interest).
- **Data.** Order id, line items, amount, and pre-checkout cart: the cleanest possible `order` / `checkout` observations.
- **Recommendation: `later`.** Pursue structured *post-spend* order data (e-receipts) before pre-spend friction.

#### 26. Payment-provider partnerships (issuers, BNPL, UPI apps, wallets) — `payment-provider-partnership`

- **What it is.** A payment provider calls BRAKE or embeds BRAKE context **inside its own payment flow**: an issuer's app shows BRAKE's budget context at authorization, a UPI app adds a "check with BRAKE" step before PIN entry, or a BNPL provider shows BRAKE's affordability view before plan acceptance. Card networks offer issuer-side spending controls programmes (details **unverified**), and some providers expose consumer "spend controls" (**unverified**).
- **Data.** Real-time amount, merchant, MCC, instrument and authorization references, which give exact IN-SPEND observations.
- **Access.** Commercial agreements and partner security reviews. In India, any integration into UPI flows is governed by NPCI rules (**unverified**). UPI apps and banks control the PIN screen, and BRAKE cannot insert itself without them.
- **Recommendation: `research`.** Pick one friendly neobank or issuer per market for a pilot after product-market fit.

#### 27. BRAKE-issued card (or virtual card) — `brake-issued-card`

- **What it is.** BRAKE issues a debit or prepaid (or virtual) card through a BaaS issuer-processor. Every authorization reaches BRAKE **before** approval. Stripe Issuing's OpenAPI spec (GitHub, current) shows the `issuing.authorization` object with `amount`, `merchant_amount` / `merchant_currency`, `merchant_data` (`name`, `category`, `category_code`, `city`, `country`, `postal_code`, `network_id`, `terminal_id`, `url`), `network_data.transaction_id` ("used to match subsequent messages, disputes, and transactions"), `card_presence`, `authorization_method` (`chip`, `contactless`, `keyed_in`, `online`, `swipe`), `wallet` (`apple_pay`, `google_pay`, `samsung_pay`), `status` (`pending`, `closed`, `expired`, `reversed`) and a `pending_request` that is "only non-null during an `issuing_authorization.request` webhook". Cards carry `spending_controls` with `allowed_categories`, `blocked_categories`, `allowed_merchant_countries` and `spending_limits`. The real-time response window is short (on the order of seconds per Stripe docs; **unverified** in this session).
- **What it enables.** True IN-SPEND interventions: approve, but push "₹ at <merchant> — 38% above your usual pace" at the same instant; user-set soft limits ("ask me before any electronics over $200", answered on the phone before the authorization times out, **unverified** feasibility); per-purchase virtual cards for online shopping that require a BRAKE check to create.
- **Costs.** Issuing is regulated. US programmes need a sponsor bank and compliance (KYC/AML, Reg E disputes; BaaS sponsor-bank turmoil since 2024, details **unverified**). India needs an RBI PPI licence or a bank co-brand under RBI directions (**unverified**). Interchange economics are thin, and users must *switch* payment instruments, while BRAKE's agnostic principle says it should not *become* the rail.
- **Dedup keys.** `network_data.transaction_id` (`rail_reference`, namespace = network), the authorization `id` (`provider_transaction_id`), `merchant_data.network_id`.
- **Observation.** `money_movement`, `stage: "pending"` (authorization) → `posted` (capture), `instrument: {type: "card", issuer: "BRAKE", last4}`, `merchant.mcc`, `confidence: 0.99`.
- **Provenance sentence.** "Authorized on your BRAKE card at Starbucks (Visa authorization)."
- **Recommendation: `later`** (USA first). `avoid` for MVP.

---

### H. Processing capabilities used by these surfaces (not sources)

| Capability | Android | iOS | Notes (as of 2026-10-04) |
|---|---|---|---|
| Camera-permission-free scanning | Google code scanner; ML Kit Document Scanner (both "without … camera permission") | VisionKit document camera; `DataScannerViewController` (camera) | Play services required on Android (**unverified** for non-GMS devices) |
| On-device OCR | ML Kit Text Recognition v2: Latin, Chinese, Devanagari, Japanese, Korean | Vision text recognition; `RecognizeDocumentsRequest` (iOS 26, tables/lists); `DataScanner` `.currency` (iOS 17) | No Tamil/Telugu/Bengali models in ML Kit's list; prices use Latin digits, so this is acceptable |
| On-device LLM (text) | Gemini Nano via ML Kit GenAI / AICore, supported devices only | Foundation Models (iOS 26+), Apple Intelligence devices | Device reach in India is limited for both (**unverified** numbers) |
| On-device LLM (image input) | ML Kit Prompt API "multimodal prompt" | Foundation Models image `Attachment`, `OCRTool`, `BarcodeReaderTool` (iOS 27) | Use structured output (`@Generable`), then validate deterministically |
| Server LLM | opt-in only | `PrivateCloudComputeLanguageModel` (iOS 27) or third-party, with 5.1.2(i) disclosure | Prefer on-device; PCC is Apple-operated |

---

## Three-window classification

| Source (id) | Pre-spend | In-spend | Post-spend | Typical latency | Notes |
|---|---|---|---|---|---|
| `manual-should-i-buy` | ●●● | ●● | – | user-timed | Anchor for intent → outcome measurement |
| `price-entry-widget` | ●●● | ●● | ● (quick log) | ~2–3 s to keypad | iOS widgets/controls/Action button; Android widget/tile/shortcut |
| `manual-transaction-entry` | – | – | ●●● | seconds–days | Cash and User C; correction tool |
| `share-sheet` | ●●● | ● | ● (order pages) | 1–4 s incl. fetch | Price via metadata resolver |
| `ios-share-js-preprocessing` | ●●● | ●● (checkout page) | ●● (confirmation page) | <1 s | Safari only; reads live DOM |
| `paste-product-url` | ●● | – | – | user-timed | Use `UIPasteControl`; never silent reads |
| `product-page-metadata` | (library) | (library) | (library) | 0–3 s | JSON-LD > Meta price tags > OG title > DOM |
| `browser-extension-chromium` | ●●● (cart) | ●●● (checkout) | ●● (order page) | ~100 ms | Desktop; activeTab + opt-in sites |
| `safari-web-extension` | ●●● | ●●● | ●● | ~100 ms | iOS 15+/macOS; per-site grants |
| `firefox-extension` | ●●● | ●●● | ●● | ~100 ms | `data_collection_permissions` required |
| `brake-qr-scanner` | ●● | ●●● | – | seconds before paying | India UPI and other QR rails; US low |
| `barcode-gtin-lookup` | ●● | – | – | ~1 s | No price in GTIN |
| `price-tag-ocr` | ●●● | ● | – | 1–2 s | Approximate amounts; tax/MRP pitfalls |
| `receipt-photo-ocr` | – | – | ●●● | minutes–days | Line items; auth code/last4 joins |
| `screenshot-import` | ●● (cart) | – | ●●● (payment success) | seconds after share | UTR/order id joins |
| `screenshot-auto-detection` | – | – | – | n/a | Avoid: own-app-only APIs; invasive alternative |
| `ios-visual-intelligence` | ● | – | – | seconds | Research |
| `siri-app-intents` | ●● | ● | ● (voice log) | 3–6 s | Same intent powers controls |
| `android-assistant-actions` | ●● | – | – | 3–6 s | App Actions status under Gemini unclear; AppFunctions preview |
| `ios-screen-time-shield` | ●●● | – | – | 0 s (system) | Context only; best iOS trigger |
| `ios-shortcuts-app-automation` | ●● | – | – | ~1 s | Fallback |
| `ios-family-activity-data` | ● | – | – | n/a | EU-only; avoid |
| `android-usage-stats` | ●● | – | – | seconds (polling) | Notification nudge only |
| `android-accessibility-service` | ●●● | ●●● | ●● | <1 s | Avoid (privacy/policy) |
| `merchant-partnership` | ●● | ●●● | ●●● | real-time | Low feasibility |
| `payment-provider-partnership` | – | ●●● | ●●● | real-time | Research |
| `brake-issued-card` | – | ●●● (pre-approval) | ●●● | < seconds | Later |

● weak · ●● useful · ●●● strong

---

## Implications for BRAKE architecture

### Adapter design notes

1. **One `IntentCapture` pipeline, many front doors.** The quick check, widgets and controls, voice, share, paste, barcode, price tags and shields all produce the same `purchase_intent` (or `app_context`) observation through a shared `ManualAdapter` path with `intent.via` set. Use a **controlled vocabulary for `via`**: `should_i_buy | widget | voice | share | paste | screenshot | price_tag | barcode | qr | cart | shield`. Today the type comment lists only six values, and the field is a free string.
2. **`ProductMetadataResolver` is a pure function** (URL or DOM snapshot → `ProductFacts{title, price?, currency?, productIds[], merchantDomain, fieldProvenance}`), shared by iOS (Swift), Android (Kotlin) and extensions (TS). Keep the parsing rules in a portable spec with golden test fixtures. Run it on-device; never centralise URL fetching by default.
3. **`QRAdapter` = classifier + parsers**: `upi-uri`, `emv-mpm-tlv` (validate CRC tag 63), `url`, `gs1-digital-link`, `fiscal-receipt` (per-country plug-ins registered in the capability registry). The classifier is country-agnostic; the parsers are rail-specific modules.
4. **`OCRPipeline`**: capture → text recognition → layout (lines/blocks/tables) → **deterministic locale grammars** (currency, totals keywords per locale) → optional on-device LLM (structured output) → **validators** (Σ line items + tax ≈ total; date plausible; currency consistent with locale/merchant) → observation with calibrated confidence. Price tags, receipts and screenshots all reuse it.
5. **`BrowserExtensionAdapter`**: content scripts emit observations into the extension's local store, then hand off. Safari uses native messaging into the app group with no server hop. Chromium and Firefox desktop need a BRAKE account link, so send *only observations*, never DOM or URLs beyond the merchant domain, unless the user enables "send product links".
6. **`AppActivityAdapter`** (shields, usage stats) emits `app_context` only. The fusion doc already classifies `app_context` as *context, never fused*. Add a learned link "intent started from shield" → intent outcome, to measure shield efficacy.
7. **Shield extension constraints shape the data flow.** The shield config extension cannot call the network, so BRAKE must **precompute** shield copy inputs (remaining budget, goal progress) into shared storage on every relevant event. Keep them coarse ("$64 left"), not per-transaction details.

### Normalization pitfalls (pre-spend amounts)

- **List price ≠ paid amount.** US shelf and web prices exclude sales tax (state/local), and shipping and fees appear only at checkout. Coupons and loyalty discounts lower the figure. India: **MRP** includes taxes but is a *maximum*, and actual selling prices are often lower; e-commerce pages show MRP struck through next to the price. Represent this with `amountBreakdown` (`subtotal`, estimated `tax`, `shipping`, `discount`) and `approximate: true`.
- **The fusion tolerance for intents needs revisiting.** The current rule `purchase intent → anything (forward only)`, ±15%, 24 h will miss, for example, a $12 item + $5.99 shipping + 8% tax (≈ +60%) and multi-item carts where the user asked about one item. Recommendation: (a) for `via ∈ {share, paste, cart}`, block on **merchant domain + time** and treat amount as soft evidence (`llr` scaled by relative difference); (b) add an *absolute* allowance (shipping) besides the percentage; (c) **per-`via` horizons**: `qr` ~15 min, `cart`/`checkout` ~1–2 h, `price_tag` same day, `should_i_buy` 72 h, `share` 7 d, wishlist 30 d (proposed defaults, to be tuned with data).
- **Currency.** Bare `$` is ambiguous (USD, CAD, AUD, SGD, MXN…), so resolve it with merchant country, then page `priceCurrency`, then device locale, and lower confidence when they disagree. Watch decimal commas (`1.299,00 €`), Indian grouping (`₹1,23,456`), `Rs.`/`INR`/`₹` variants, and currency after the number.
- **Ranges and variants.** `AggregateOffer.lowPrice`/`highPrice`, "from $X" and size or colour variants: store a range and ask the user to confirm.
- **Product ids need namespaces.** `LineItem.productId` should be namespaced (`gtin:00012345678905`, `asin:B0…`, `sku:<merchant>:<id>`). The schema.org guidance that a 12-digit UPC becomes GTIN-13 with a leading zero suggests normalising every GTIN to 14 digits.
- **Merchant from domain.** `amazon.in` vs `amazon.com` vs a marketplace seller: map the domain to a merchant key, and keep `seller.name` as a separate attribute (marketplace vs retailer).
- **P2P vs P2M QRs.** A UPI QR with MCC `0000` or a personal-looking VPA is probably a transfer (fusion and reconciliation doc). Mark `typeHints: [{type: "transfer", transferKind: "p2p_other"}]` with moderate confidence.

### Capability-registry facts (proposed entries; `asOf: 2026-10-04`)

| Capability id | Scope | Platform / country | Status | Note |
|---|---|---|---|---|
| `os:screen-time-shield` | platform | iOS/iPadOS ≥16 (individual auth) | available | Needs Family Controls (Distribution) per bundle id + per extension |
| `os:shield-open-app` | platform | iOS ≥26.5 | available | `ShieldActionResponse.openParentalControlsApp` |
| `os:shield-submenu` | platform | iOS ≥26.4 | available | ≤3 `secondaryButtonSubmenuItems` |
| `os:family-activity-data` | country+platform | iOS ≥26.4, EU only | limited | One app per device; `approvedWithDataAccess` |
| `os:usage-stats` | permission | Android (all supported) | available | Special access via Settings; event polling |
| `os:accessibility-service` | permission | Android | limited (policy) | Avoid |
| `os:overlay-window` | permission | Android | limited | `SYSTEM_ALERT_WINDOW`; BAL exception |
| `os:share-target` | platform | Android, iOS, iPadOS, macOS | available | |
| `os:share-js-preprocessing` | platform | iOS/macOS Safari | available | `NSExtensionJavaScriptPreprocessingFile` |
| `os:paste-control` | platform | iOS ≥16 | available | Prompt-free paste |
| `os:interactive-widgets` | platform | iOS ≥17; Android | available | No text input in widgets |
| `os:system-controls` | platform | iOS ≥18 | available | Control Center, Lock Screen, Action button |
| `os:live-activities` | platform | iOS ≥16.1 | available | ≤8 h active + ≤4 h on Lock Screen |
| `vision:code-scanner-no-permission` | platform | Android (Play services) | available | Google code scanner |
| `vision:document-scanner` | platform | Android (ML Kit), iOS (VisionKit) | available | |
| `vision:currency-text-scan` | platform | iOS ≥17 | available | `DataScannerViewController` `.currency` |
| `vision:structured-documents` | platform | iOS ≥26 | available | `RecognizeDocumentsRequest` |
| `vision:ocr-devanagari` | platform | Android ML Kit | available | Latin/Chinese/Devanagari/Japanese/Korean |
| `ai:on-device-llm` | platform | iOS ≥26 (Apple Intelligence devices); Android AICore devices | limited | Device-gated |
| `ai:on-device-llm-image` | platform | iOS ≥27; Android ML Kit Prompt API (supported devices) | limited | |
| `voice:app-intents` | platform | iOS ≥16 | available | |
| `voice:app-actions` | platform | Android phones (not Go) | unknown | Gemini transition unclear |
| `agent:appfunctions` | platform | Android ≥16 | emerging | Experimental; Gemini private preview (May 2026) |
| `ext:chromium-mv3` | platform | desktop | available | Chrome on Android: unavailable (unverified) |
| `ext:safari-web` | platform | iOS ≥15, macOS Safari ≥14, visionOS | available | |
| `ext:firefox` | platform | desktop (+ Android, unverified) | available | Data-consent manifest required (new extensions since 2025-11-03) |
| `rail:upi-qr` | country | IN | available | Scan in BRAKE + hand-off |
| `rail:upi-qr` | country | US | unavailable | |
| `receipt:fiscal-qr` | country | BR, SA, IN (B2C dynamic QR), others | research | Formats unverified |
| `data:gtin-food-db` | global | Open Food Facts | available | 15 read req/min/IP; ODbL |
| `card:issuing` | country | US (BaaS) | limited | Licensing/sponsor bank |
| `card:issuing` | country | IN | limited | RBI PPI/co-brand (unverified) |

### Feature wiring (capability-based, not country-based)

- `feature:pre-spend-check` = always available (manual). It is *enhanced* by `share-sheet`, `brake-qr-scanner` (`rail:*-qr`), `price-tag-ocr` (`vision:*`) and shields (`os:screen-time-shield`) or `android-usage-stats`.
- `feature:in-store-gate` = `any(rail:upi-qr, rail:emv-mpm-qr)` → QR scanner, else degraded to price-tag scan + quick check.
- `feature:app-launch-pause` = `any(os:screen-time-shield, os:usage-stats)`, with `os:shield-open-app` upgrading the CTA from "notification" to "direct open".
- `feature:intent-outcome-tracking` = full with any money-movement source; **degraded** (self-report prompt at horizon end) otherwise.

---

## Risks, policy constraints and ethical concerns

1. **Paternalism and dark patterns.** Friction is ethical only when the user **chooses it, configures it and can always bypass it in one tap**. No shaming copy, no streak guilt, no hiding the "Continue" button, and no delay timers on essentials. Never shield or nag categories such as health, pharmacy or groceries unless the user explicitly asks. Copy should inform ("$64 left"), not judge ("You've overspent!"), in line with the brief's no-scolding principle.
2. **Annoyance and reactance.** Persistent dimmed icons (shields) and frequent nudges can push users to revoke permissions or uninstall. Mitigations: schedules tied to *personal* regret windows, rate limits, "snooze for a week", and measuring revocations as a harm metric.
3. **Commercial conflicts.** No affiliate links, coupon injection or "deals" feeds (the Honey lesson; Chrome's affiliate policy enforced from 2025-06-10; Firefox §7.3 ban). Disclose any partnership. Never use browsing or shopping data for credit decisions: Chrome's *Limited Use* explicitly forbids using browsing data "to determine credit-worthiness or for lending purposes", and BRAKE should adopt that rule universally.
4. **Intent leakage.** Product URLs and screenshots reveal sensitive interests (health, pregnancy, religion, gifts). Fetch on-device, strip tracking parameters, store only extracted facts, expire excerpts, and give each source a "forget everything from this source" control (the fusion doc's reversibility).
5. **Third-party AI.** Any cloud LLM for OCR or screenshots needs explicit, specific consent and disclosure (App Review 5.1.2(i), June 2026). Prefer Apple Foundation Models (on-device or Private Cloud Compute), Gemini Nano, or deterministic parsers.
6. **Platform gatekeeping.**
   - The Family Controls distribution entitlement can be slow or refused, so ship a no-shield iOS build path.
   - Guideline 4.10 forbids monetizing Screen Time APIs, which is a business-model constraint.
   - Shield extensions cannot use the network.
   - Android Play policies on usage access, accessibility, foreground services and photo permissions need checking before launch (exact 2026 texts **unverified**).
   - Chrome review of host permissions.
7. **Payments regulation.** Relaying UPI QRs touches NPCI rules (**unverified** constraints). Issuing a card triggers banking regulation (KYC/AML, disputes, RBI PPI rules in India). BRAKE must never hold funds or credentials in the MVP.
8. **Accessibility misuse.** Using `AccessibilityService` for non-accessibility monitoring is ethically questionable and policy-risky, so avoid it.
9. **Minors and shared devices.** Family Controls also supports `.child` authorization, but BRAKE should not market parental money controls in the MVP: different consent model, different regulation.
10. **Measurement ethics.** "BRAKE helped you skip ₹X" claims must count only intents with a credible counterfactual: user-initiated checks the user later abandoned. Don't count shield bounces as "money saved".

---

## Open questions

1. Does `ShieldActionResponse.openParentalControlsApp` (iOS 26.5) work for **individually authorized** apps, or only parent-managed child devices as the name suggests? Needs on-device verification.
2. Can a `ShieldConfigurationDataSource` reliably read app-group data (budget figures) on iOS 26/27, and how fresh must it be?
3. Will Apple grant the *Family Controls (Distribution)* entitlement for a **spending-friction** (non-screen-time, non-parental) use case, and does Guideline 4.10 prevent including shields in a paid tier?
4. Google Play 2026 requirements for `PACKAGE_USAGE_STATS` and for a foreground service used for launch detection: is a declaration form required, and which `foregroundServiceType` applies?
5. NPCI rules: may a non-PSP app scan a merchant UPI QR and relay the `upi://pay` URI to the user's PSP app? Are there signed-QR or "verified merchant" constraints? On iOS, how predictable is `upi://` hand-off when several UPI apps are installed? (Coordinate with the UPI-intent stream.)
6. How often do Indian and US retailer pages (Amazon, Flipkart, Myntra, Meesho, Walmart, Target, Best Buy) expose schema.org `Offer.price` in server-rendered HTML vs only client-side? This needs a measured crawl of a sample from the device.
7. Efficacy: does a pre-spend check or shield reduce *regretted* spending (72 h satisfaction) without reducing *valued* spending? Proposed RCT within BRAKE: shield vs nudge vs nothing, measuring abandon rate, regret rate and revocation rate.
8. Market reach of on-device LLMs in India (share of active devices with Gemini Nano / Apple Intelligence) and whether Apple Intelligence's English (India) support covers Foundation Models for Indian users (**unverified**).
9. What App Actions do now that Gemini has replaced Google Assistant, and when AppFunctions will reach GA with Gemini.
10. Which countries' fiscal receipt QR formats are stable enough to parse (Brazil NFC-e, Saudi ZATCA, India B2C dynamic QR, Portugal ATCUD…)?
11. Should intent amounts carry estimated tax and shipping, or should fusion learn per-merchant uplift factors from matched intent → payment pairs?
12. Is there any merchant or payment partner with a *structural* incentive to show BRAKE pre-spend context (BNPL affordability rules, subscription regret reduction)?

---

## References

Numbered list of sources consulted in this session. "Fetched" means the page or raw file was retrieved and read; "search summary" means only the search-result summary was seen, because the page was blocked.

1. `docs/brief.md` (local): founding brief; pre-spend surfaces list, privacy principles, capability-based design.
2. `docs/architecture/fusion-and-reconciliation.md` (local): intent tolerance ±15%, 24 h horizon, `app_context` as context-only, intent lifecycle.
3. `packages/core/src/model/observation.ts`, `source.ts`; `packages/capabilities/src/types.ts` (local): observation, source-kind and registry vocabulary used above.
4. https://developer.apple.com/documentation/managedsettings/shieldactionresponse (fetched): `.none/.close/.defer/.openParentalControlsApp`.
5. https://developer.apple.com/documentation/managedsettings/shieldactionresponse/openparentalcontrolsapp (fetched): introduced iOS 26.5.
6. https://developer.apple.com/documentation/managedsettingsui/shieldconfiguration (fetched): shield fields.
7. https://developer.apple.com/documentation/managedsettingsui/shieldconfiguration/secondarybuttonsubmenuitems (fetched): iOS 26.4, up to three submenu items.
8. https://developer.apple.com/documentation/managedsettingsui/shieldconfigurationdatasource (fetched): extension receives names/bundle ids/domains; sandbox, no network.
9. https://developer.apple.com/documentation/managedsettings and https://developer.apple.com/documentation/managedsettings/shieldsettings (fetched): shield targets (apps, web domains, categories).
10. https://developer.apple.com/documentation/managedsettings/application (fetched): `bundleIdentifier`, `localizedDisplayName`, `token`.
11. https://developer.apple.com/documentation/familycontrols (fetched): entitlement requirement; individual authorization via biometrics.
12. https://developer.apple.com/documentation/familycontrols/authorizationcenter/requestauthorization(for:) (fetched): iOS 16 individual authorization; restrictions lifted for individuals.
13. https://developer.apple.com/documentation/familycontrols/familyactivitypicker (fetched): private selection.
14. https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement (fetched): distribution request per app and per Screen Time extension.
15. https://developer.apple.com/documentation/familycontrols/familyactivitydata and …/authorizationstatus/approvedwithdataaccess, …/familyactivitydata/visitedwebdomains, …/installedapplications (fetched): iOS 26.4 EU-only data access, one app per device.
16. https://developer.apple.com/documentation/deviceactivity/deviceactivityevent and …/deviceactivitymonitor (fetched): thresholds, web-domain activity, icon dimming note.
17. https://developer.apple.com/forums/thread/820790 (fetched): one sec developer's March 2026 request for `openParentApp`; notification workaround.
18. https://developer.apple.com/forums/thread/793060 (fetched): July 2025 thread; Apple confirmed opening the parent app from a shield was unsupported at the time.
19. https://developer.apple.com/forums/thread/820811 (fetched): 2026 reports of unclear entitlement approval timelines.
20. https://developer.apple.com/app-store/review/guidelines/ (fetched; "Last Updated: June 8, 2026"): 4.4, 4.4.2 Safari extensions, 4.10 Screen Time monetization, 5.1.2(i) third-party AI disclosure.
21. https://developer.apple.com/documentation/safariservices/safari-web-extensions (fetched): platforms (Safari 14+, iOS 15+, visionOS 1+), Open Graph sample listing.
22. https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions (fetched): permission model, iOS per-site grants, Safari 17 profiles.
23. https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html (fetched): `NSExtensionJavaScriptPreprocessingFile`, `ExtensionPreprocessingJS`, activation rule keys.
24. https://developer.apple.com/documentation/visualintelligence and …/integrating-your-app-with-visual-intelligence, …/updates/visualintelligence (fetched): `SemanticContentDescriptor`, labels, macOS June 2026 update.
25. https://developer.apple.com/documentation/updates/appintents (fetched): June 2024/2025/2026 App Intents changes.
26. https://developer.apple.com/videos/play/wwdc2022/10170/ (fetched): App Shortcuts phrases, `.applicationName`, value prompts.
27. https://developer.apple.com/documentation/appintents/appshortcut (fetched): anonymized phrase extraction note.
28. https://developer.apple.com/documentation/foundationmodels, …/updates/foundationmodels, …/analyzing-images-with-multimodal-prompting, …/systemlanguagemodel/availability-swift.enum (fetched): device requirement, iOS 27 image attachments, `OCRTool`/`BarcodeReaderTool`, PCC model.
29. https://developer.apple.com/documentation/vision/recognizedocumentsrequest and …/updates/vision (fetched): iOS 26 structured document recognition including receipts.
30. https://developer.apple.com/documentation/visionkit/datascannerviewcontroller/textcontenttype (+ `/currency`) (fetched): `.currency` since iOS 17.
31. https://developer.apple.com/documentation/uikit/uipastecontrol (fetched): prompt-free paste, iOS 16 paste alert.
32. https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities and …/creating-controls-to-perform-actions-across-the-system (fetched): buttons/toggles only; controls on Lock Screen, Control Center and Action button.
33. https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities (fetched): 8 h + 4 h limits.
34. https://developer.apple.com/documentation/uikit/uiapplication/userdidtakescreenshotnotification (fetched): no `userInfo`.
35. https://developer.android.com/reference/android/app/usage/UsageStatsManager (fetched): `PACKAGE_USAGE_STATS` granted in Settings.
36. https://developer.android.com/reference/android/app/usage/UsageEvents.Event (fetched): `ACTIVITY_RESUMED` (API 29).
37. https://developer.android.com/guide/components/activities/background-starts (fetched): BAL restrictions since Android 10; exceptions; Android 15–17 opt-ins.
38. https://developer.android.com/training/package-visibility/declaring (fetched; last updated 2026-10-01): `QUERY_ALL_PACKAGES` appropriate use cases.
39. https://developer.android.com/reference/android/accessibilityservice/AccessibilityServiceInfo (fetched): `isAccessibilityTool` and the privacy notification.
40. https://developer.android.com/about/versions/14/features/screenshot-detection (fetched): `DETECT_SCREEN_CAPTURE`, own-activity only, no image.
41. https://developer.android.com/training/data-storage/shared/photopicker (fetched): availability (Android 11+, backport), media grants.
42. https://developer.android.com/develop/ui/views/touch-and-input/copy-paste (fetched): Android 12+ clipboard access toast.
43. https://developer.android.com/develop/ui/views/appwidgets (fetched): RemoteViews view limits; Android 12 stateful widgets.
44. https://developer.android.com/ai/gemini-nano (fetched): ML Kit GenAI APIs, Prompt API multimodal, AICore.
45. https://developer.android.com/ai/appfunctions (fetched): experimental; Android 16+; Gemini private preview as of May 2026.
46. https://developer.android.com/develop/devices/assistant/overview (fetched): App Actions, BIIs, `shortcuts.xml`, Android Go exclusion.
47. https://raw.githubusercontent.com/googlesamples/mlkit/master/android/codescanner/README.md and …/android/documentscanner/README.md (fetched): no camera permission required.
48. https://raw.githubusercontent.com/googlesamples/mlkit/master/android/vision-quickstart/app/build.gradle (fetched): text-recognition modules (Latin, Chinese, Devanagari, Japanese, Korean).
49. https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/schema.ttl (fetched): `price`, `priceCurrency` (ISO 4217, '.' decimal), `lowPrice`, `gtin13`, `sku`, `availability`, `Order.orderNumber`, `acceptedOffer`, `totalPaymentDue`.
50. https://raw.githubusercontent.com/facebook/open-graph-protocol/master/index.html (fetched): core OGP required properties and verticals; no price property.
51. https://raw.githubusercontent.com/mdn/content/main/files/en-us/mozilla/add-ons/webextensions/manifest.json/permissions/index.md (fetched): `activeTab` semantics.
52. https://raw.githubusercontent.com/mdn/content/main/files/en-us/mozilla/add-ons/webextensions/manifest.json/host_permissions/index.md (fetched): MV3 host permissions; install-prompt behaviour by browser.
53. https://raw.githubusercontent.com/mozilla/extension-workshop/master/src/content/documentation/develop/manifest-v3-migration-guide.md (fetched): Firefox MV2/MV3 behaviour.
54. https://raw.githubusercontent.com/mozilla/extension-workshop/master/src/content/documentation/publish/add-on-policies.md (fetched): consent rules, §7.3 affiliate ban.
55. https://raw.githubusercontent.com/mozilla/extension-workshop/master/src/content/documentation/develop/firefox-builtin-data-consent.md (fetched; dated 2026-03-12): `data_collection_permissions`, taxonomy, 2025-11-03 requirement.
56. https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/webstore/program-policies/affiliate-ads/index.md (fetched; archived 2022 text): related-user-action rule.
57. https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/webstore/program-policies/limited-use/index.md (fetched; archived 2022 text): Limited Use incl. credit-worthiness ban.
58. https://9to5google.com/2025/03/11/google-chrome-affiliate-extension-policy-honey/ (search summary; page blocked): March 11, 2025 policy update; June 10, 2025 enforcement; disclosure/user-action/benefit requirements.
59. https://9to5google.com/2025/03/12/honey-affiliate-disclosure-google-chrome-listing/ and https://9to5google.com/2025/03/13/honey-affiliate-update/ (search-result titles only): Honey's disclosure and attribution changes.
60. https://www.neowin.net/news/google-changes-chrome-extension-policies-in-wake-of-honey-controversy/ and https://dataconomy.com/2025/03/12/google-cracks-down-on-chrome-extensions-after-honey-affiliate-scandal/ (search results only): corroborating coverage.
61. https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json (fetched): `issuing.authorization` fields, `merchant_data`, `network_data`, `pending_request`, card `spending_controls`.
62. https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/main/docs/api/index.md (fetched): licence, rate limits (15 req/min/IP), User-Agent, v2 deprecation.
63. https://newly.app/how-to/family-controls-entitlement and https://developer.apple.com/forums/thread/818553 (search results only): reported entitlement waiting times (secondary).
