# Email Intelligence for BRAKE: Gmail, Outlook, IMAP, Forwarding and Receipt Extraction

> **Research stream 06: email intelligence.** Covers Gmail API (scopes, restricted-scope verification, CASA, Limited Use, `q` filtering, `users.watch`/Pub/Sub, history sync), Microsoft Graph mail (`Mail.Read` vs `Mail.ReadBasic`, delta, change notifications, publisher verification, consumer Outlook.com), IMAP for Yahoo/iCloud/others, narrow-permission alternatives (user-configured forwarding inbox, on-device processing, Gmail add-ons, manual share, mailbox export), structured data inside emails (schema.org markup, merchant formats), extraction approaches (templates, ML, local LLMs), detection of subscriptions, renewals, trials, price changes, refunds, cancellations, travel and reservations, and the trust lessons of email-data monetization (Unroll.me/Slice and others).
>
> **Date:** 2026-10-04. All time-sensitive claims carry an "as of" date or are tagged.
>
> **How sources were reached.** In this research session, direct fetching of `developers.google.com`, `support.google.com`, `learn.microsoft.com`, `ftc.gov` and most vendor sites was blocked by the network egress proxy, and the shared web-search budget ran out partway through. So the evidence comes from: (a) **official source files hosted on GitHub**: the Gmail API discovery document (revision `20260727`), the `microsoftgraph/microsoft-graph-docs-contrib` repo that builds Microsoft Learn's Graph pages, `MicrosoftDocs/entra-docs`, the `schemaorg/schemaorg` vocabulary release, and Google's own `android/skills` repo; (b) **verbatim copies of policy text** in GitHub repos, such as a copy of the Google API Services User Data Policy; (c) **web-search excerpts** of Google help pages; and (d) **2026-dated secondary compliance write-ups** that quote the primary pages. The tags below show the evidence level of every claim:
>
> - **[P]**: primary, verified in this session (official doc source or official repo).
> - **[P\*]**: primary text, read through a verbatim copy, mirror or search excerpt.
> - **[S]**: secondary source from 2025–2026 that quotes or summarizes primary material.
> - **[U]**: unverified in this session (prior knowledge). Treat as a hypothesis until checked.
>
> **Fact-check pass (2026-10-04).** An adversarial verification pass re-checked the load-bearing claims against the same GitHub-hosted primary sources plus additional mirrors (archived Google policy snapshots, verbatim copies of Google OAuth and Gmail push docs, Apple's Foundation Models documentation JSON, the FairEmail client's provider data). Corrections are made inline and marked "(corrected 2026-10-04)". See the [Verification log](#verification-log) at the end.
>
> ### Key takeaways for BRAKE
>
> 1. **On Gmail, "metadata-only" buys no compliance relief.** Every Gmail read scope is *restricted*, including `gmail.metadata` [P\*]. `gmail.metadata` also cannot use the `q` search parameter, and it cannot request `format=full` or `format=raw` [P]. The narrowest workable server path is therefore `gmail.readonly` with a strict `q` sender/category filter. That filter reduces what BRAKE *fetches*, but the grant still covers the whole mailbox, so trust has to come from design, disclosure and audit, not from the permission itself.
> 2. **Restricted-scope access is cheap in dollars but expensive in calendar time.** It needs brand verification, scope justification, a demo video and app-type review, then an annual CASA assessment for any app that reaches Gmail data "from or through a server". Commercial labs have quoted about $540–$1,800/yr at Tier 2 and $4.5k–$8k at Tier 3 [S] (corrected 2026-10-04: the 2026 source that compiles these figures says they come from **2024–2025 rate cards**; they are not verified 2026 quotes). An unverified app has a 100-user lifetime cap [S], and in Testing mode its refresh tokens expire after 7 days [P\* verbatim copy of Google's OAuth doc]. **Start verification early. Do not block the MVP on it.**
> 3. **Limited Use rules shape the business, not just the code.** BRAKE may not use Gmail-derived data, including aggregated or derived data, for ads, for data brokers, or "to determine credit-worthiness or for lending purposes" [P\*]. Humans may not read it unless the user gives affirmative agreement for specific messages [P\*]. Under the Google Workspace API User Data and Developer Policy (which governs Gmail), it may not train any model "beyond that specific user's personalized model" [S] (corrected 2026-10-04: this AI/ML clause is in the Workspace policy, not in the general API Services User Data Policy, whose 15 Feb 2024 text was checked and does not contain it). BRAKE should apply this policy to **every** email adapter, Google or not.
> 4. **Microsoft Graph has a real narrow permission that Google lacks.** `Mail.ReadBasic` excludes `body`, `previewBody`, attachments and extended properties. Personal Microsoft accounts can grant it, and it needs no admin consent [P]. It supports change notifications (average under 1 minute, maximum 3 minutes) and subscriptions of up to 10,080 minutes [P]. No CASA-style audit is known for consumer Graph mail [U].
> 5. **The MVP email path should be a user-configured forwarding inbox plus manual share.** The user creates a per-user BRAKE address and a sender filter. This involves no Google or Microsoft scope, the user's own filter enforces the narrowness, and the original DKIM signature usually survives auto-forwarding, which lets BRAKE verify the sender. The costs are onboarding friction and Microsoft 365 work tenants, where the default outbound-spam setting has meant automatic external forwarding is **off** since 2021 for new orgs and for existing orgs that weren't actively using it [P\*, mirror of Microsoft Learn dated 2026-08-18].
> 6. **Email is mostly POST-SPEND, but it also carries pre-spend signals BRAKE can't easily get elsewhere.** In India, RBI's Digital Payments – E-mandate Framework, 2026 (21 Apr 2026), which covers recurring payments on **cards, PPIs and UPI**, requires a pre-transaction notification **at least 24 hours** before every recurring debit, naming the merchant, amount, date and mandate reference [S, corroborated by many independent 2026 secondary sources; RBI's own page was not reachable]. Trial-ending, renewal, price-change, bill-due and reservation emails are pre-spend too. IN-SPEND email (payment OTPs) should be avoided by default.
> 7. **In India, bank alert emails may be the best near-real-time signal that works on iOS.** HDFC reportedly emails *every* UPI transaction, including the 12-digit UPI reference (RRN), even below its SMS thresholds (in force since 25 June 2024) [S]. A 2026 alert sample confirms the RRN field [S]. But email alerts are optional under RBI rules (SMS alerts are mandatory) [S], coverage varies by bank, and sender domains are migrating to `*.bank.in`. Trust the DKIM `d=` domain, not the `From:` header.
> 8. **Email should mostly *explain* bank-sourced transactions, not create them.** Order email time is not charge time: Amazon charges per shipment, and Subscribe & Save charges arrive 14–19 days after the order email [S]. Tips, wallets, gift cards, FX and partial refunds all break amount equality. Fuse on order ID, payment reference, amount and time windows. Without a bank signal, emit only `intent`/`pending` candidates.
> 9. **Extraction should run as layers in a fixed order.** Parse schema.org JSON-LD/microdata first (deterministic, but prevalence unknown). Then apply per-sender templates for the top senders in each country. Then use a schema-constrained LLM, **on-device first**. On Android, Google's own skill (updated 2026-09-03) requires the ML Kit GenAI Prompt API at **at least** `1.0.0-beta4`, and its structured-output schema compiler is `1.0.0-alpha1` [P] (corrected 2026-10-04: the source gives a minimum version and does not show whether a stable release exists). On iOS, Apple's Foundation Models framework (iOS 26+, Apple Intelligence devices only) offers `@Generable` guided generation [P]. Persist extracted facts and a message reference, never bodies. Gate trust on DKIM to resist spoofing and prompt injection.
> 10. **The trust risk here is existential.** Unroll.me's parent Slice sold e-receipt-derived data (the Lyft/Uber story, NYT 2017). The FTC's 2019 order required deletion and user notice, with no fine, and Unroll.me is now reported as NielsenIQ-owned [S, a competitor's blog; ownership not verified against a primary source]. BRAKE has to make "we never monetize your inbox" structurally true through on-device extraction, no aggregates sold to anyone, and a public Limited Use statement, and it should say so up front.

---

## Sources investigated

Each subsection uses the same layout: **What it is**, **Data available**, **Windows & latency**, **Coverage**, **Access requirements**, **Privacy & consent**, **Reliability & failure modes**, **Dedup/reconciliation keys**, **Normalized observation & confidence**, **Provenance sentence**, and **Recommendation**.

The sources fall into three groups:

- **Transports**: how BRAKE obtains a message (§1–§12).
- **Content classes**: what a message means for spending (§13).
- **Extraction techniques**: how facts get out of a message (§14–§16).

The canonical observation schema shared by all of them is in [Implications → Normalized `EmailObservation`](#normalized-emailobservation).

---

### 1. Gmail API, server-side (`gmail-api`)

**What it is.** Google's REST API for Gmail mailboxes (`gmail.googleapis.com/gmail/v1/users/me/...`). BRAKE would hold OAuth tokens on its servers and read the messages it is interested in.

**Data available.** Field names below are verified from the discovery document [P].
- `users.messages.list(q, labelIds, includeSpamTrash, maxResults≤500, pageToken)` returns message `id`s and `threadId`s. `q` "Supports the same query format as the Gmail search box", but "**cannot be used when accessing the api using the gmail.metadata scope**" [P].
- `users.messages.get(format=minimal|metadata|full|raw)` returns a `Message` with these fields:
  - `id`, which is immutable, and `threadId`.
  - `labelIds`.
  - `snippet` ("A short part of the message text"; about 200 characters is the observed size, not a documented limit [S]).
  - `historyId`.
  - `internalDate`: epoch ms when Google accepted the message, "more reliable than the `Date` header".
  - `payload` (a `MessagePart` with `headers[]`, `mimeType`, `body`, `parts[]`, `filename`).
  - `sizeEstimate`, and `raw` (base64url RFC 2822).
  - `full` and `raw` "cannot be used when accessing the api using the gmail.metadata scope" [P].
- Headers in `payload.headers` matter to BRAKE: `From`, `Subject`, `Date`, `Message-ID`, `List-Unsubscribe`, and the `Authentication-Results` header that Gmail prepends (DKIM/SPF/DMARC verdicts) [U for exact Gmail header format; widely relied on by parsers [S]].
- **Gmail's own category classifier is available through `q`.** The help-center operator list includes `category:purchases` and `category:reservations`, alongside primary, social, promotions, updates and forums [P\* via mirror of Gmail Help 7190]. Whether these two are also exposed as system `labelIds` is unverified [U].

**Windows & latency.** Mainly POST-SPEND: order confirmations, receipts and bank alerts. It is also PRE-SPEND for renewals, trials, bills, e-mandate pre-debit notices and reservations. Latency is the merchant's send delay (seconds to minutes for receipts [U]) plus BRAKE's sync delay: seconds with push (§2), or the polling interval otherwise.

**Coverage.** Global. Gmail is the dominant consumer mailbox in India and large in the US and EU [U on exact shares]. It works for Android, iOS and web, because it is server-side.

**Access requirements (as of 2026).**
- **Scope class.** `gmail.readonly`, `gmail.metadata`, `gmail.modify`, `gmail.compose`, `gmail.insert`, `gmail.settings.basic`, `gmail.settings.sharing` and `https://mail.google.com/` are **restricted** [P\* search excerpt of Google's restricted-scope list; corroborated by [S]]. `gmail.send` is sensitive. `gmail.labels` is non-sensitive. The add-on scopes `gmail.addons.current.message.readonly` and `...metadata` are sensitive [P\* tab-separated copies of Google's scope table in several 2026 repos]. (Corrected 2026-10-04: one copy lists `gmail.addons.current.message.action` and `gmail.addons.current.action.compose` as non-sensitive, not sensitive (unverified against Google directly).)
- **Verification gates** [S, summarizing Google's restricted-scope verification guide]:
  1. Brand verification: a homepage on a verified domain, a privacy policy, and the logo.
  2. Per-scope narrowest-necessary justification.
  3. A demo video of the production OAuth flow.
  4. App-type and policy review (Google says this takes several weeks).
  5. A CASA security assessment. Google assigns the assurance level (AL1 is evidence-based, AL2 is lab-tested). Labs sell these as "Tier 2/Tier 3".
  6. **Revalidation every 12 months** from the Letter of Validation or Assessment date [P\* search excerpt: "at least every 12 months"].
- **The assessment trigger is server access.** Per a 2026 secondary quote of Google's restricted-scope verification page, an app that "accesses or has the capability to access Google user data from or through a server" must undergo an annual assessment by a Google-approved third party [S]. **Local-client exemption (corrected 2026-10-04):** the sentence "Local client applications that only allow user-configured transmissions of Restricted Scope data from the device may be exempt from this requirement" is verified in archived 2022 versions of the Google API Services User Data Policy. It is **absent** from the version last updated 15 Feb 2024, which the checked snapshots show was still current in Oct 2025. Whether any 2026 Google page still offers a local-client exemption is **unverified** (see §4).
- **Cost [S] (corrected 2026-10-04: the figures come from 2024–2025 rate cards compiled in a 25 Aug 2026 secondary source, which says to get current quotes; they are not verified 2026 prices).** TAC Security is about $540 (Tier 2) and $4,500 (Tier 3). Other labs charge about $800–$1,500+ (Tier 2) and $5,000–$8,000+ (Tier 3). Lab time is 1–4 weeks. Questionnaires run about 50–54 items. First-hand 2026 accounts report infrastructure findings such as CORS, TLS ciphers and security headers. Older figures of "$15k–$75k" describe the pre-CASA regime [S].
- **Before verification** [S, with the token rules confirmed against a verbatim copy of Google's "Using OAuth 2.0 to Access Google APIs" page [P\*]]:
  - In **Testing** mode, only listed test users (max 100) can authorize, and refresh tokens are issued "expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile".
  - In **Production but unverified** mode, there is a 100-new-user *lifetime* cap ("cannot be reset or changed", per a Google quote in a 2026 secondary source) and the user sees an unverified-app warning.
  - Refresh tokens carrying Gmail scopes are also revoked on a password change and after 6 months unused. There is a limit of 100 refresh tokens per Google Account per OAuth client ID, and when it is reached the oldest token is invalidated without warning [P\*].
- **Appropriate-access category.** Gmail restricted scopes are limited to permitted app types. The 2026 Workspace policy lists email clients, productivity enhancements, and "*Applications that use information from emails to provide reporting or monitoring services for the benefit of users that improve the email experience (such as applications that automate travel itineraries or track flights or package delivery statuses)*" [S] (corrected 2026-10-04: only **one** of the cited 2026 sources, `yadava5/applied`, quotes this wording; the Boomerang brief paraphrases it. An archived Sep 2022 Google policy snapshot reads "Applications that use information from emails to provide reporting or monitoring services for the benefit of users (such as applications that automate travel itineraries or track flight or package delivery statuses)", without "that improve the email experience". The current wording is **unverified**). **BRAKE must frame its feature as purchase, subscription and bill tracking from receipts.** A generic "financial profiling" description is a rejection risk. Google's 2018 announcement also said apps that access mail "without their regular direct interaction (for example, services that provide reporting or monitoring...)" would get extra warnings and periodic re-consent [S quoting Google]. Whether this is enforced in 2026 is unverified [U].
- **Policy obligations** (Google API Services User Data Policy; the Workspace User Data and Developer Policy governs Gmail):
  - **Limited Use** [P\* verbatim copies of the policy "Last updated February 15, 2024", still current in an Oct 2025 snapshot; 2026 text not directly fetched] applies to "the raw data obtained from the scopes and data aggregated, anonymized, or derived from them". Use is limited to "providing or improving user-facing features that are prominent in the requesting application's user interface".
  - **Transfers** are allowed only for those features with consent, for security, for legal compliance, or in M&A with explicit prior consent.
  - **"Don't allow humans to read the data"** unless one of these holds: per-item affirmative agreement, security, law, or aggregated internal operations.
  - **Prohibited outright**: transfer or sale to "advertising platforms, data brokers, or any information resellers"; use for ads; and use "**to determine credit-worthiness or for lending purposes**".
  - **AI/ML**: "Transferring, selling, or using user data to create, train, or improve a machine learning or artificial intelligence model beyond that specific user's personalized model" is prohibited. Personalized means on-device or tailored to that user only, and Google data may not train foundational or frontier models [S] (corrected 2026-10-04: this clause comes from the **Workspace** API User Data and Developer Policy and the Limited Use FAQ, which could not be fetched. It is not in the 15 Feb 2024 API Services User Data Policy. Many developer privacy policies on GitHub carry the related Workspace affirmation that data is "not used to develop, improve, or train generalized AI and/or ML models").
  - **Workspace policy (2026) extras** [S]: a prominent in-product disclosure *immediately before* consent; a public Limited Use statement; encrypted tokens with HSM-equivalent key management; prompt-injection protection for AI processing; incident reporting to `security@google.com`; and incremental authorization ("Don't attempt to 'future proof' your access", [P\*]).
- **API cost.** No per-call fee [U]. Per-user and per-project quota units apply; `watch` costs 100 units [S]. The other per-method costs are unverified [U].

**Privacy & consent.** The consent screen shows "View your email messages and settings" (the `gmail.readonly` description [P]). The user grants the **whole mailbox**, even if BRAKE only queries `from:(...)`. BRAKE needs its own in-product pre-consent screen that lists the sender classes it reads and states what it stores ("facts, never bodies"). Users can revoke access at myaccount.google.com; BRAKE must also revoke the refresh token on disconnect [S].

**Reliability & failure modes.**
- Token revocation: password change, 6-month idle, 7-day Testing expiry [S].
- Verification lapses if the annual CASA is missed [S].
- `historyId` gaps return a 404, which forces a full re-sync [P].
- Quota throttling.
- `q` relies on Gmail's tokenization, so non-English and Indic subjects may be missed [U].
- Merchant template churn.
- Multi-account duplication: the same receipt can be CC'd to two mailboxes.

**Dedup/reconciliation keys.**
- Message level: Gmail `id`, `threadId`, and the RFC `Message-ID` (cross-provider).
- Order level: merchant order number.
- Payment level: UPI RRN/UTR, card last-4 plus amount plus time, Apple/Google Play order IDs, tracking numbers (to link shipments to orders), PNR or booking ID.

**Normalized observation & confidence.** An `EmailObservation` (schema below) with `source_adapter: gmail-api`. Confidence comes from three things: sender authentication (a DKIM `d=` match against the merchant registry), the extraction method (schema.org > template > LLM), and internal validation (whether line items, tax and shipping sum to the total).

**Provenance sentence.** *"Matched your ₹4,799 HDFC debit with an Amazon.in order email in your Gmail (4 Oct, 10:42): toothbrush, USB cable, dog food."*

**Recommendation: `next`.** Highest semantic value and best coverage for Gmail users. But verification lead time, recurring CASA, app-type eligibility risk and the "whole mailbox" consent make it a poor MVP dependency. **Start restricted-scope verification during the MVP phase**, so it is ready when forwarding has proven the value.

---

### 2. Gmail push: `users.watch` + Cloud Pub/Sub + `users.history.list` (`gmail-push-watch`)

**What it is.** Gmail's change-notification mechanism. BRAKE calls `users.watch` with a Pub/Sub topic. Gmail publishes a small notification when the mailbox changes, and BRAKE then calls `history.list` to find out what changed.

**Data available** [P, discovery doc].
- `WatchRequest`:
  - `topicName`: the topic "**must** already exist" and Gmail must have "publish" permission on it.
  - `labelIds`: restricts notifications to those labels.
  - `labelFilterBehavior` (`include`/`exclude`), which replaces the deprecated `labelFilterAction`.
- `WatchResponse`: `historyId` and `expiration` (epoch ms; "Call `watch` again before this time").
- `history.list(startHistoryId, historyTypes=[messageAdded|messageDeleted|labelAdded|labelRemoved], labelId)` returns `History{id, messagesAdded, messagesDeleted, labelsAdded, labelsRemoved}`. Returned messages "typically only have `id` and `threadId`". An out-of-date `startHistoryId` "typically returns an `HTTP 404`".
- The notification payload (base64 in the Pub/Sub message `data`) is `{"emailAddress": "...", "historyId": "..."}`, with no content [P\* verbatim copy of Google's Gmail push-notifications guide; corrected 2026-10-04 from U].

**Windows & latency.** This mechanism adds no new data. It cuts POST/PRE-SPEND latency to "receipt delivery + seconds" [U: no published SLA]. Limits: "You must re-call `watch` at least every 7 days", and Google recommends calling it once per day. "Each Gmail user being watched has a maximum notification rate of 1 event/sec", and notifications above that rate **are dropped** [P\* verbatim copy of Google's guide]. A `watch` call costs 100 quota units [S].

**Coverage.** Same as §1.

**Access requirements.** Same restricted scopes as §1, plus a GCP project with Pub/Sub. Pub/Sub costs are negligible at consumer scale [U].

**Privacy & consent.** The notification itself carries no content. **Design opportunity:** in the on-device variant (§4), BRAKE's server receives only `{emailAddress, historyId}` and relays a silent push (FCM/APNs). The device then fetches and extracts locally. Whether this keeps BRAKE outside "access through a server" is an open question for Google.

**Reliability & failure modes.**
- An expired watch silently stops notifications, so BRAKE needs a daily renew job plus a periodic `history.list` reconciliation sweep.
- A 404 on stale history forces a fallback to a bounded `messages.list` with `q`.
- If `labelIds` filtering is used, BRAKE misses messages Gmail classifies into another category.
- On iOS, silent pushes are throttled by the OS, so the on-device variant gets minutes-to-hours latency [U].

**Dedup keys.** `historyId` gives idempotent processing. Gmail message `id`.

**Normalized observation.** None of its own. It triggers §1 or §4 extraction.

**Provenance sentence.** Not user-facing. It can surface as freshness: *"Checked your Gmail receipts 2 min ago."*

**Recommendation: `next`.** It ships together with `gmail-api` or `gmail-api-on-device`.

---

### 3. Gmail metadata-only scope (`gmail-metadata-scope`)

**What it is.** The `gmail.metadata` scope: "View your email message metadata such as labels and headers, but not the email body" [P].

**Data available.** `format=minimal|metadata` only, which returns IDs, labels and headers (`From`, `Subject`, `Date`, `List-Unsubscribe`, `Authentication-Results`). The `q` parameter cannot be used [P]. Whether `snippet` is returned under this scope is unverified [U].

**Windows & latency.** POST-SPEND and PRE-SPEND at the level of "something happened with merchant X at time T". Examples: an order email at 10:42; a "Your trial ends Friday" subject line, though only if the subject carries it. Bank alert subjects often omit the amount: HDFC's subject is "You have done a UPI txn. Check details!" [S].

**Coverage.** Same as §1.

**Access requirements.** **Restricted**, so it carries the same verification and CASA burden as `gmail.readonly` [P\*/S]. Because `q` is unavailable, BRAKE must enumerate more of the mailbox (or filter by label) to find receipts. A 2026 verification write-up notes this "inverts the usual expectation: the narrower scope would force [the app] to read more of the mailbox, not less" [S].

**Privacy & consent.** No bodies is a real reduction in exposure. But the consent burden and the audit are identical, and the subject and sender stream still reveals purchases.

**Reliability.** Low semantic yield: no amounts or items unless they are in the subject. It is useful as a "merchant touchpoint" corroborator for fusion: an email from `amazon.in` 1 minute before a bank debit.

**Dedup keys.** Message `id`, `Message-ID`, and order numbers that appear in subjects.

**Normalized observation & confidence.** `email_kind` is inferred from sender plus subject, with low-to-medium confidence. Amounts are usually absent.

**Provenance sentence.** *"You got an email from Amazon.in at 10:41, one minute before this debit."*

**Recommendation: `avoid`** on Gmail. It is the worst of both worlds: the full compliance cost with too little data, and it removes server-side filtering. Contrast this with Microsoft's `Mail.ReadBasic` (§7), which *is* worth using.

---

### 4. Gmail API, on-device / local-client variant (`gmail-api-on-device`)

**What it is.** The same Gmail API, called from the BRAKE mobile app with tokens stored only on the device. Extraction runs locally, and only derived facts (or nothing) leave the phone.

**Data available.** Same as §1. Extraction uses on-device templates and models (§16).

**Windows & latency.**
- Android: an FCM high-priority relay (§2) plus WorkManager gives seconds to minutes [U].
- iOS: background fetch and silent pushes are opportunistic, from minutes to hours. Foreground sync on app open is reliable.

**Coverage.** Android and iOS apps. Web would need its own handling.

**Access requirements.** Still a restricted scope, so **OAuth verification is still required**: app-type review, privacy policy and demo video. The **security assessment may not apply, but this is now weaker evidence than first stated** (corrected 2026-10-04). The local-client sentence ("may be exempt") is verified only in **2022** versions of the User Data Policy. It was dropped from the 15 Feb 2024 version. A June 2026 secondary analysis notes the live text "now leans on user count and 'ability to access data from or through a third-party server' rather than a clean local-client carve-out" (unverified). Secondary 2026 analyses agree any exemption hinges on data never transiting a server, and note that "has the capability to access... from or through a server" is read broadly [S]. **Unresolved:** whether syncing *derived* facts (amount, merchant, order ID) to BRAKE's cloud counts as transmitting restricted-scope data. Limited Use explicitly covers "derived" data, which suggests it may [P\*].

**Privacy & consent.** Best privacy story. Bodies never leave the device. Tokens are held in the Android Keystore or iOS Keychain. The user can revoke per mailbox.

**Reliability & failure modes.**
- Battery and background limits.
- Multi-device consistency, since each device holds its own extraction state.
- On-device model availability varies by device (§16).
- Token loss on reinstall means the user must re-consent.

**Dedup keys.** Same as §1. Server-side dedupe receives only `Message-ID` hashes.

**Normalized observation & confidence.** Same schema. Extraction confidence may run lower than with server-side LLMs on low-end devices.

**Provenance sentence.** *"Found on your phone in an Amazon.in email. The email itself never left your device."*

**Recommendation: `research`.** This may be BRAKE's best long-run Gmail architecture. **Get Google's written position** on the CASA exemption and on syncing derived facts before committing.

---

### 5. Gmail add-on, contextual and per-message (`gmail-workspace-addon`)

**What it is.** A Google Workspace add-on that shows a BRAKE card next to the email the user has open in Gmail, via a contextual trigger.

**Data available.** Only the **currently open message**. `gmail.addons.current.message.readonly` ("View your email messages when the add-on is running") and `...metadata` are **sensitive, not restricted** [P description, S classification]. The add-on cannot read history and cannot run in the background [S].

**Windows & latency.** User-initiated POST-SPEND ("log this receipt", "this is a subscription"). Occasionally IN-SPEND, when the user reviews a checkout or quote email. Latency is immediate.

**Coverage.** Gmail web. Gmail Android/iOS support for Workspace add-ons is believed to exist but is unverified for 2026 [U]. Consumer `@gmail.com` users can install from the Workspace Marketplace [U].

**Access requirements.** Sensitive-scope verification (no CASA) plus Marketplace listing review [S/U].

**Privacy & consent.** Excellent: one message, on an explicit user action.

**Reliability.** High for what it covers, but coverage is low: users must remember to open it.

**Dedup keys.** Gmail message `id`, `Message-ID`, order ID.

**Normalized observation & confidence.** Same schema. `user_initiated: true` raises the prior that the email is relevant.

**Provenance sentence.** *"You sent this Swiggy receipt to BRAKE from Gmail."*

**Recommendation: `later`.** It is a good low-burden complement for power users, but coverage is too low for the MVP.

---

### 6. Microsoft Graph mail, full read (`microsoft-graph-mail`)

**What it is.** The Microsoft Graph `/me/messages` and `/me/mailFolders/{id}/messages` APIs for Outlook.com and Hotmail (consumer) and Microsoft 365 (work and school) mailboxes.

**Data available** [P, Graph docs repo].
- `message` fields:
  - `body` (HTML or text) and `bodyPreview` ("The first 255 characters of the message body").
  - `subject`, `from`, `sender`, `receivedDateTime` (UTC ISO-8601).
  - `internetMessageId` (RFC 2822) and `internetMessageHeaders`.
  - `conversationId`, `parentFolderId`, `hasAttachments`.
  - `inferenceClassification` (`focused`/`other`), `categories`, `webLink`, and `uniqueBody`.
- **Permission `Mail.Read`** (delegated): "Allows the app to read the signed-in user's mailbox". AdminConsentRequired: No. "**available for consent in personal Microsoft accounts**" [P].
- **Delta query** [P]: `GET /me/mailFolders/{id}/messages/delta`.
  - It is per-folder ("Delta query is a per-folder operation") and supports `$select`, `$top` and `$expand`.
  - The only supported `$filter` is `receivedDateTime ge|gt {value}`, which caps results at 5,000 messages. The only `$orderby` is `receivedDateTime desc`.
  - There is no `$search`. `changeType=created|updated|deleted` is available, and the `Prefer: odata.maxpagesize` header sets page size.
- **`$search` on messages** [P]: KQL property search, defaulting to from/subject/body. A `$search` request returns up to 1,000 results.
- **Change notifications** [P]:
  - The `message` resource supports subscriptions with `Mail.ReadBasic` or `Mail.Read`, *including delegated personal Microsoft accounts*.
  - `$filter` can be applied to the subscription resource.
  - Maximum subscription lifetime is **10,080 minutes** (under 7 days), or 1,440 minutes for rich notifications that include resource data.
  - Rich notifications require `includeResourceData`, an `encryptionCertificate` and `$select`; `Body`/`UniqueBody` cannot be selected into the notification.
  - A mailbox can hold at most 1,000 active Outlook subscriptions across all apps.
  - **Latency for `message`: average under 1 minute, maximum 3 minutes.** Lifecycle notifications (`subscriptionRemoved`, `reauthorizationRequired`, `missed`) are available.
- **Throttling** [P]: 10,000 requests per 10 minutes and 4 concurrent requests per app per mailbox.

**Windows & latency.** POST-SPEND and PRE-SPEND as for Gmail. Notification latency is under 1 minute on average and 3 minutes at most (documented) [P].

**Coverage.** Global consumer Outlook.com and Hotmail, plus M365. Consumer share is much smaller than Gmail's in India [U]. Works on all platforms.

**Access requirements.**
- An app registration in Entra with `signInAudience` including personal accounts [U on exact setting name].
- **No mandated third-party security assessment is known** for Graph mail scopes on consumer accounts [U, as of 2026].
- **Publisher verification** [P] requires a verified Microsoft AI Cloud Partner Program (CPP) account and an app registered with an Entra work account (not an MSA). It shows a blue "verified" badge.
- Since November 2020, if risk-based step-up consent is enabled, users in *other organizations* can't consent to most newly registered multitenant apps that are not publisher-verified [P]. This matters for M365 work accounts and is mostly irrelevant for consumer MSA.

**Privacy & consent.** As with Gmail, the user grants the whole mailbox. Graph's server-side filters reduce what is fetched, not what is granted.

**Reliability & failure modes.**
- Subscriptions expire within 7 days and need renewal.
- Missed notifications need delta reconciliation.
- Delta is per-folder, so BRAKE must track Inbox plus any folders the user's rules move receipts into.
- Throttling.
- M365 tenants may block user consent entirely through admin policy.

**Dedup keys.** Graph message `id` (which changes when the message moves folders unless immutable IDs are requested with `Prefer: IdType="ImmutableId"` [P, Graph "Obtain immutable identifiers" doc; corrected 2026-10-04 from U]), `internetMessageId`, order IDs and payment references.

**Normalized observation & confidence.** Same schema, with `source_adapter: microsoft-graph-mail`.

**Provenance sentence.** *"From a Netflix email in your Outlook.com inbox: price rising to $24.99 on 1 Nov."*

**Recommendation: `next`.** Lower compliance burden than Gmail, so it is a good second provider. Ship it after the forwarding MVP proves extraction quality.

**Local-client variant (added 2026-10-04; `microsoft-graph-mail-on-device`, `research`).** The §4 design also works for Outlook: a public-client app on Android or iOS (MSAL) holds the delegated `Mail.ReadBasic`/`Mail.Read` token on the device and extracts locally. Push still needs a server, because a Graph webhook must be "a publicly accessible, HTTPS-secured endpoint" [P]. A basic (non-rich) notification carries only `changeType`, `resource` and the message `id`, with no content [P, webhook delivery doc]. So BRAKE's server can relay a content-free push to the device, as in §2. No CASA-style audit is known for Graph [U], so the gain here is privacy rather than compliance cost.

---

### 7. Microsoft Graph `Mail.ReadBasic`, metadata-first (`microsoft-graph-mail-readbasic`)

**What it is.** Graph delegated permission **`Mail.ReadBasic`**: "Allows the app to read email in the signed-in user's mailbox **except body, previewBody, attachments and any extended properties**." AdminConsentRequired: No. Available for consent in personal Microsoft accounts [P]. Change-notification subscriptions on messages accept it [P].

**Data available.** `subject`, `from`/`sender`, `receivedDateTime`, `internetMessageId`, `conversationId`, `categories`, `inferenceClassification`, and `parentFolderId`. Whether `internetMessageHeaders` (and therefore `Authentication-Results` and `List-Unsubscribe`) is returned under `Mail.ReadBasic` is unverified [U]: the exclusion list names "extended properties", not headers.

**Windows & latency.** Same as §6 (under 1 min average). Semantics are coarse: sender, subject and time.

**Coverage.** Outlook.com and M365.

**Access requirements.** As §6, but with a materially smaller blast radius.

**Privacy & consent.** **A genuinely narrower grant that the user can see.** This is the asymmetric opportunity: BRAKE can offer an "Outlook light" connection that reads only who emailed and when.

**Reliability.** Same as §3: good for touchpoint corroboration and recurring-sender detection (a monthly "Your Spotify receipt" subject), weak for amounts. Subjects sometimes carry amounts and order numbers [U per merchant].

**Dedup keys.** `internetMessageId`, plus order numbers when they appear in subjects.

**Normalized observation & confidence.** `email_kind` from subject heuristics, with low-to-medium confidence. A message can be upgraded through a user tap ("Read this one?"), via incremental consent to `Mail.Read` or manual share.

**Provenance sentence.** *"You received a 'Your trip with Uber' email at 21:14 (subject only; BRAKE didn't read the email)."*

**Recommendation: `next`.** Pair it with §6 as a two-tier Outlook consent. Never use it alone for amounts.

---

### 8. IMAP: Yahoo, iCloud and others (`imap-generic`)

**What it is.** Standard IMAP4 access to any provider that offers it.

**Data available.** Full RFC 822 messages, `INTERNALDATE`, `UID`/`UIDVALIDITY`, and `SEARCH FROM/SUBJECT/SINCE` on the server side.

**Windows & latency.** POST-SPEND and PRE-SPEND. Polling or IMAP IDLE gives minutes. IDLE needs a persistent connection per user, which is costly for a server and impractical on mobile.

**Coverage and auth by provider.**
- **Outlook.com, Hotmail, Live and MSN**: basic auth and app passwords have been **switched off since 16 September 2024**. Only `AUTHENTICATE XOAUTH2` with the `https://outlook.office.com/IMAP.AccessAsUser.All` scope (consumer tenant) works [S, two independent implementations: the Zelos IMAP adapter and the FairEmail FAQ, which links Microsoft's Outlook blog announcement. The scope itself is [P] in the Graph permission reference, consentable by personal accounts]. Use Graph instead (§6).
- **Gmail IMAP**: OAuth requires `https://mail.google.com/`, the broadest restricted scope [P\*]. App passwords exist for accounts with 2-Step Verification [U]. **Asking users for a Gmail app password hands BRAKE full-mailbox credentials and bypasses Google's OAuth review. Avoid it.**
- **iCloud Mail**: IMAP at `imap.mail.me.com:993` with an **app-specific password** [S: FairEmail's provider config (`appPassword="true"`) and FAQ, which links Apple's support pages]. No third-party OAuth for IMAP [U].
- **Yahoo Mail (corrected 2026-10-04)**: the earlier claim that "app passwords are available" is **contradicted**. FairEmail's FAQ (fetched 2026-10-04) says: "A Yahoo account can only be configured using the quick setup wizard (=OAuth). Yahoo no longer allows users to log in using just an (app) password to access email". Its Yahoo app-password provider profile is set to `enabled="false"` [S]. When this changed, and whether it applies to every Yahoo account, is unverified. OAuth-for-IMAP access is believed to require Yahoo's approval of the client [U]. Yahoo may restrict automatic forwarding to paid tiers [U].
- **Fastmail and others**: app passwords or API tokens, and JMAP for Fastmail [U].

**Access requirements.** No platform review for app passwords, but BRAKE becomes a credential custodian. Some providers' terms may restrict automated access [U].

**Privacy & consent.** Poor: an app password is a full-mailbox, long-lived secret that the user cannot scope. If it is used at all, it must be **on-device only**, with the secret kept in the Keychain or Keystore and never sent to BRAKE servers.

**Reliability & failure modes.** Password rotation breaks sync silently. `UIDVALIDITY` resets force a resync. Providers throttle IMAP. Folder naming varies by provider.

**Dedup keys.** `Message-ID`, plus `UIDVALIDITY:UID` per mailbox.

**Normalized observation.** Same schema, with `source_adapter: imap-generic`.

**Provenance sentence.** *"From an Apple receipt in your iCloud Mail (read on this iPhone)."*

**Recommendation: `later`.** Only on-device, only for iCloud, Yahoo and other providers without a better path. Steer most users to forwarding (§9).

---

### 9. User-configured forwarding inbox (`email-forwarding-inbox`)

**What it is.** BRAKE gives each user an unguessable address (for example `k7f3q…@in.brake.app`). The user creates a filter in their own mail client that auto-forwards selected senders to that address, or forwards individual emails by hand. Precedents for the pattern include travel-itinerary and expense apps such as TripIt-style `plans@` and Expensify-style `receipts@` addresses [U on their current 2026 behavior].

**Data available.** Full RFC 822 copies of **only the messages the user's filter selects**. With **auto-forwarding**, the original headers, including the merchant's `DKIM-Signature`, usually arrive intact. Gmail and Microsoft add ARC headers [U on exact behavior]. With **manual forwarding**, the message is re-wrapped and the original DKIM verification is lost, so confidence is lower.

**Windows & latency.** POST-SPEND and PRE-SPEND. Latency is the merchant's send delay plus forwarding delay, typically seconds to a few minutes [U].

**Coverage.** Every provider that supports forwarding rules: Gmail, Outlook.com, iCloud (iCloud.com rules), and others. Exceptions:
- **Microsoft 365 work and school tenants** have automatic external forwarding controlled by the outbound spam policy. The default "Automatic – System-controlled" value "changed to **Off – Forwarding is disabled** for new organizations and for existing organizations that weren't actively using" it, in 2021. Existing orgs that were already using it may still forward [P\* via mirror of Microsoft Learn, page dated 2026-08-18]. Expect failures with "5.7.520 Access denied, Your organization does not allow external forwarding".
- Yahoo free tier, possibly [U].
- **Gmail** requires the user to confirm a forwarding address via a code sent to that address [U on the exact 2026 flow]. BRAKE's inbound processor can surface the code in-app; the user must perform the confirmation themselves.

**Access requirements.** **No Google or Microsoft OAuth scope, no restricted-scope verification, no CASA** [S]. BRAKE does need:
- Inbound mail infrastructure: MX, SPF/DKIM checking, an ARC-aware verifier, and a spam gate.
- A per-user address registry.
- Abuse controls, since anyone can mail the address.

**Privacy & consent.** **The narrowness is enforced by the user, and the user can see it.** BRAKE receives only what the filter matches, and the user can delete the filter at any time, which is the per-source disconnect. Recommended handling:
1. Process in memory at ingress.
2. Extract facts.
3. Drop the body.

   Or, for a stronger guarantee: encrypt the raw message on arrival to the user's device public key, let the device extract (as in §4), and keep no plaintext at rest. Google's Limited Use does **not** legally apply to mail the user forwards (no Google API is involved), but BRAKE should apply the same rules anyway (see Risks).

**Reliability & failure modes.**
- Onboarding friction. Mitigations: guided setup, sender-list presets per country, and possibly an importable Gmail filter XML [U whether imported filters keep the forward action].
- The filter goes stale as merchants change sender addresses.
- Forwarding confirmation can fail.
- Work tenants block it.
- Attackers can mail the address directly. Treat any mail that is not auto-forwarded with valid DKIM as low-trust.
- Gmail may surface a "forwarding active" banner to the user [U].

**Dedup keys.** `Message-ID` (for dedupe against a later Gmail API connection), order ID, payment references.

**Normalized observation & confidence.** Same schema, with `source_adapter: email-forwarding-inbox` and `sender.via_forward: auto|manual`. Confidence is high with an aligned DKIM pass, and medium-to-low for manual forwards.

**Provenance sentence.** *"From a Swiggy receipt your Gmail filter forwarded to BRAKE (4 Oct, 20:31)."*

**Recommendation: `mvp`.** It works today in every country, involves no platform gatekeeper, and is the most privacy-legible option. It doubles as the fallback for users who refuse inbox OAuth even after BRAKE is verified.

---

### 10. Manual single-email share, forward or `.eml` upload (`manual-email-share`)

**What it is.** The user forwards one email to their BRAKE address, uses the OS share sheet to share an email or PDF receipt to BRAKE, or uploads a `.eml` or PDF.

**Data available.** Whatever is shared. For a manual forward, the original body is usually included but the original DKIM is lost.

**Windows & latency.** POST-SPEND (receipts, refunds), PRE-SPEND ("is this renewal worth keeping?"), and occasionally IN-SPEND (a quote or checkout email). Latency is immediate.

**Coverage.** Universal across all providers and platforms. The iOS Mail share sheet passes limited content, so "Forward" is the reliable path [U].

**Access requirements.** None beyond §9's inbound infrastructure or a share extension.

**Privacy & consent.** Explicit, per message. This is also the **cleanest legal basis for human review**: "Send to BRAKE support to improve parsing" with an explicit affirmative agreement for that specific message, in line with the Limited Use exception [P\*].

**Reliability.** High precision, low recall.

**Dedup keys.** `Message-ID` where it survives, order ID, amount plus time.

**Normalized observation.** Same schema, with `user_initiated: true`.

**Provenance sentence.** *"From the Uber receipt you forwarded."*

**Recommendation: `mvp`.**

---

### 11. Mailbox export import, e.g. Google Takeout mbox (`mailbox-export-import`)

**What it is.** A one-time historical backfill. The user exports selected labels as mbox (Google Takeout allows label selection [U]) and opens the file in BRAKE, which parses it on-device.

**Data available.** Full historical messages for the chosen labels.

**Windows & latency.** POST-SPEND history only, which helps with subscription detection, regret baselines and recurring-merchant priors. Latency is hours to days (export time).

**Coverage.** Gmail (Takeout). Outlook.com export options for consumers are limited [U].

**Access requirements.** None. No API is involved.

**Privacy & consent.** Good if processed on-device and discarded. Files are large, so mobile is impractical, and desktop or web (WASM, local only) is better.

**Reliability.** High for history. Zero for real time.

**Dedup keys.** `Message-ID`.

**Provenance sentence.** *"Learned from your past receipts (imported 3 Oct; the file wasn't kept)."*

**Recommendation: `later`.** A good "cold start" for subscription detection without ongoing access.

---

### 12. Email API aggregators: Nylas, Unipile, EmailEngine and similar (`email-api-aggregators`)

**What it is.** Third-party unified email APIs. Some offer their own pre-verified Google OAuth client: a "Shared GCP App" for Nylas and a "pre-verified CASA Tier 2 OAuth client" for Unipile [S].

**Data available.** Normalized message objects across Gmail, Graph and IMAP.

**Windows & latency.** As for the underlying provider. The vendor adds webhook hops.

**Coverage.** Multi-provider.

**Access requirements.** A commercial contract with per-connection pricing [S]. The consent screen shows **the vendor's brand**, which is in tension with Google's rule that branding accurately represent the app [S].

**Privacy & consent.** Adds a processor that holds the user's mailbox tokens and content. This works against BRAKE's minimum-transmission principle and complicates the provenance story.

**Reliability.** Generally good. Creates vendor lock-in.

**Dedup keys.** As the provider.

**Recommendation: `avoid`** for consumer BRAKE, apart from possibly a short pilot. Self-hosted libraries are fine as implementation tools.

---

### 13. Content classes: what email actually tells BRAKE

Transport answers *how* a message arrives. Content class answers *what it means*. The fusion layer consumes both: one `EmailObservation` per message, with `email_kind` set.

#### 13a. Bank and card transaction alert emails (`bank-email-alerts`)

- **What.** Per-transaction debit and credit alerts from banks and card issuers.
- **Data (India, verified sample).** A 2026 HDFC email from `alerts@hdfcbank.net` with subject "❗ You have done a UPI txn. Check details!" reads: *"Rs.290.00 has been debited from account NNNN to VPA XXXXXXXXXX@axl [PAYEE NAME] on 08-02-26. Your UPI transaction reference number is NNNNNNNNNNNN."* [S, a test fixture from a 2026 parser, which the fact-check confirmed exists]. (Redacted 2026-10-04: the fixture appears to contain a real third party's phone-number VPA, name and reference number, so BRAKE documents must not reproduce them.) The same fixture also has a credit-card UPI variant ("debited from your HDFC Bank RuPay Credit Card XXNNNN to <vpa> ... Your UPI transaction reference number is ..."). Fields: amount, masked account or card (last 4), payee VPA and name, date, **12-digit UPI RRN**.
- **Windows.** POST-SPEND within minutes [U]. For iOS users this is effectively the fastest sensor available.
- **Coverage.** Uneven [S, compiled 2026 from bank pages and user reports]:
  - **RBI rules** (RBI/2017-18/15, 6 July 2017): "SMS alerts shall mandatorily be sent... email alerts may be sent, wherever registered", so email has no regulatory floor. (Note 2026-10-04: RBI consolidated many legacy circulars into Master Directions in 2025–26. Whether this clause now sits in a consolidated direction, and whether its wording changed, is unverified.)
  - **HDFC** stopped SMS for UPI payments of ₹100 or less and receipts under ₹500 from **25 June 2024**, but **continues email for all UPI transactions**.
  - **ICICI** email alerts are reportedly NRI-scoped.
  - **SBI** is reportedly unsuitable: SMS-centric, with thresholds.
  - **Sender domains changed** during 2025. RBI circular RBI/2025-26/28 (22 Apr 2025) told banks to migrate to **`.bank.in`** domains by 31 Oct 2025 [S, quoted by several independent sources]. The circular targets bank web domains; adoption for **email** sender domains is per bank and observed, not mandated as far as verified. For HDFC, `alerts@hdfcbank.net` and `alerts@hdfcbank.bank.in` are both observed (one fixture also shows `alerts@hdfcbank.com`), so match on the DKIM `d=` value.
  - **In the US**, issuers offer opt-in per-transaction email alerts with thresholds [U for specific issuers in 2026]. If confirmed, this would substantially help "User B" (iPhone + US), who has no notification access.
- **Reliability caveat.** A DKIM-valid alert proves the bank sent it, **not** that money moved. RBL Bank was reportedly documented (Moneylife, 1 July 2026) sending "Account Credited" e-alerts where 47 of 54 matched no statement credit [S, single secondary source; the Moneylife article could not be reached (unverified)]. Treat these as `pending`/`confirmed-by-issuer-alert`, not `posted`.
- **Dedup keys.** **UPI RRN/UTR (12 digits)**, account last 4 plus amount plus timestamp, card last 4 plus merchant descriptor.
- **Observation.** `email_kind: bank_txn_alert_debit|credit`, `payment_rail: upi|card|netbanking|neft|imps`, `payment_refs[{scheme: upi-rrn}]`. Confidence is high with a DKIM-aligned template match.
- **Provenance.** *"Detected from your HDFC transaction email (UPI ref …8901)."*
- **Recommendation: `mvp`**, via forwarding in India, starting with HDFC.

#### 13b. Merchant order and receipt emails (`merchant-receipt-emails`)

- **What.** Order confirmations, payment receipts, invoices, and shipping and delivery updates.
- **Data.** The table below states the evidence level for each merchant. **As of 2026-10-04 we could not verify item-level content against live primary samples for most merchants.** BRAKE should build a consented test-purchase corpus (staff accounts) before promising item-level explanations per merchant.

| Merchant | Typical content (evidence) | Item-level? | IDs useful for fusion |
|---|---|---|---|
| Amazon (.com/.in) | Order confirmations, Subscribe & Save notices and refund notices are parsed by 2025–26 open-source tools [S]. Card charges are **per shipment**, and S&S charges land **14–19 days** after the order [S, one hobby project's README; an observation, not Amazon documentation]. | Item names commonly present, sometimes truncated. Per-item price is variable [U]. | Order ID `NNN-NNNNNNN-NNNNNNN` [S]. Digital orders use a different ID format [S]. |
| Flipkart | Order confirmation and shipment emails [U]. | Likely items plus price [U]. | Order ID (`OD…`) [U]. |
| Uber / Uber Eats | Trip receipts with a fare breakdown, route, time and payment method. Eats receipts list items [U]. | Eats yes, rides n/a [U]. | Trip or order ID [U]. **Drop route and location by default** (minimization). |
| Swiggy / Zomato | Order summary emails. Open-source 2026 parsers query `from:noreply@swiggy.in`, `from:noreply@zomato.com` and extract items and quantities [S, weak]. | Yes (per parsers) [S]. | Order ID [U]. |
| Netflix | Price-change and payment-failure notices. Monthly receipts are not consistently emailed [U]. | n/a | Plan, price, effective date [U]. |
| Apple (App Store / iCloud / subscriptions) | "Your receipt from Apple": item, price, renewal info, order ID and document number [U]. | Yes [U]. | Apple order ID [U]. |
| Google Play | Order receipt [U]. | Yes [U]. | `GPA.` order number [U]. |
| Walmart (US) | Order notifications with order IDs. One 2026 tool still uses web order lookup for item details [S]. | Partial [S]. | Order number [S]. |

- **Windows.** POST-SPEND within minutes (confirmation), days (shipping and delivery), and weeks (refund). Abandoned-cart and quote emails are PRE-SPEND (§13h).
- **Dedup keys.** Merchant order ID (scoped by merchant), invoice number, tracking number (links shipments to orders), payment last 4.
- **Observation.** `email_kind: order_confirmation|payment_receipt|invoice|shipping_update|delivery_confirmation`, plus `line_items[]` and `amounts{}`. `amount_role` must distinguish *order total* from *amount charged*.
- **Provenance.** *"Matched your bank transaction with an Amazon receipt."* (the brief's own example).
- **Recommendation: `mvp`.** Start with templates for the top 10–20 senders per launch country (§15).

#### 13c. Subscription lifecycle emails: started, renewal notice, trial ending, price change, payment failed, cancelled (`subscription-lifecycle-emails`)

- **What.** Merchant emails about recurring billing.
- **Data.** Plan, price, currency, billing period, renewal or trial-end date, old versus new price, and effective date.
- **Windows.**
  - **PRE-SPEND**: trial ending in N days, renewal in N days, price increase effective date. These map directly onto the brief's "Netflix renews tomorrow" intervention.
  - **POST-SPEND**: renewal receipt, cancellation confirmation.
- **Coverage.** Merchant-dependent. Legal duties to send reminders vary by jurisdiction. In the US, the FTC's amended Negative Option ("click-to-cancel") Rule was **vacated by the Eighth Circuit on 8 July 2025**, before its 14 July 2025 compliance date [S, consistent across several independent 2026 compliance write-ups; corrected 2026-10-04 from U]. One 2026 source reports the FTC sent a new draft rulemaking to OIRA on 30 Jan 2026 (unverified). ROSCA and state auto-renewal laws such as California's still apply and may require notices [U on specifics]. **Never assume a reminder exists.** Combine email with recurrence detection from transactions.
- **Caveat.** Gmail's "Manage subscriptions" view (rolled out from 9 July 2025 on web, 14 July on Android and 21 July on iOS, per PCWorld's 9 July 2025 report [S]; Google described it as rolling out in select countries) is about **newsletter/mailing-list subscriptions**: a `List-Unsubscribe` header means marketing, **not** a paid subscription. BRAKE must not conflate the two.
- **Dedup keys.** Merchant plus plan plus billing period. Apple/Google order IDs. The renewal date links the notice to the later charge.
- **Recommendation: `next`.** High value, but it needs reliable recurrence linking. Ship it once receipts and fusion work.

#### 13d. India e-mandate pre-debit notifications (`india-emandate-predebit-notification`)

- **What.** RBI requires issuers to notify customers before each recurring debit on an e-mandate. The **2026 consolidated framework** ("Digital Payments – E-mandate Framework, 2026", circular RBI/DPSS/2026-27/396, dated 21 April 2026) applies to recurring transactions on **cards, PPIs and UPI** (corrected 2026-10-04: the original text said cards and PPIs only). It repeals the earlier e-mandate circulars of 2019–2024. It states [S, verbatim as reproduced by TaxGuru and corroborated by many independent 2026 sources; RBI's own notification page (Id=13374, as cited by those sources) could not be fetched from this environment]:
  - "(a) An issuer shall send a pre-transaction notification to the customer, **at least 24 hours prior** to the actual charge / debit."
  - "(b) ... at the minimum, inform the customer about the **merchant's name, transaction amount, date / time of debit, reference number of e-mandate**, reason for debit."
  - "(c) ... facility to opt-out of any particular transaction or the e-mandate."
  - "(d) Not required for FASTag and NCMC auto-replenish."
  - AFA-free recurring transactions are allowed up to ₹15,000 per transaction, and up to ₹1,00,000 per transaction for insurance premiums, mutual fund subscriptions and credit-card bill payments [S]. Registration and the first debit require AFA [S].
  - Secondary sources also describe a mandatory **post-debit** notification [S, unverified against RBI text]. That is a POST-SPEND confirmation signal.
  - The 24-hour rule also appears in RBI's 22 August 2024 circular text [P\* copy].
- **Windows.** **PRE-SPEND, at least 24 hours ahead, by regulation.** This is the most reliable pre-spend email or SMS signal BRAKE has in India.
- **Coverage.** India. Card, PPI and UPI (AutoPay) e-mandates under the 2026 framework [S]. The channel (SMS and/or email) varies by issuer and payment app [U].
- **Dedup keys.** E-mandate reference number, merchant plus amount plus scheduled date, later matched to the actual debit.
- **Observation.** `email_kind: emandate_predebit`, `status: upcoming`, `expected_charge_at`, `mandate_ref`.
- **Provenance.** *"Your bank says Netflix will debit ₹649 tomorrow (e-mandate notice)."*
- **Recommendation: `next`.** It is a high-value PRE-SPEND feature for India. Build templates per issuer once forwarding is live.

#### 13e. Refund and cancellation emails (`refund-cancellation-emails`)

- **Data.** Refund amount (often partial), original order ID, refund method (source, wallet or gift card), and expected days to credit. Order cancelled before the charge.
- **Windows.** POST-SPEND, days to weeks after the purchase. Refund emails often precede the bank credit by days [U].
- **Fusion.** Link to the original candidate by order ID. Set `status: refunded` or `cancelled`. Track "refund expected; not yet seen in bank". This prevents transfers and refunds being counted as spending or income (the brief's transfer-versus-spending concern).
- **Recommendation: `mvp`** (Amazon/Flipkart templates), extended in `next`.

#### 13f. Travel and reservation emails (`travel-reservation-emails`)

- **Data.** Flights, hotels, trains (IRCTC), buses, cabs, restaurant and event reservations: booking ID or PNR, dates, total price, provider. schema.org `FlightReservation`, `LodgingReservation` and others (§14) are most likely here [U on prevalence].
- **Windows.** POST-SPEND for the booking. **Contextual PRE-SPEND** for the upcoming trip (a trip budget) and for a restaurant reservation (a likely spend at time T).
- **Recommendation: `next`.**

#### 13g. Bills, statements and dues (`bill-statement-emails`)

- **Data.** Utility, telecom and credit-card statements: amount due, minimum due, due date, and statement period. Indian card statements arrive as **password-protected PDFs** [U on per-issuer schemes].
- **Windows.** PRE-SPEND (an upcoming known bill) and monthly POST-SPEND reconciliation. Card bill payment is a *transfer*, not spending.
- **Recommendation: `later`.** Account Aggregator, Plaid and similar sources cover statements better; see the financial-data streams.

#### 13h. Merchant intent marketing: abandoned cart, price drop, back in stock (`merchant-intent-marketing-emails`)

- **Data.** Item, price, and the merchant's own "you showed interest" signal.
- **Windows.** **PRE-SPEND.** The merchant is telling the user, and BRAKE, that a purchase may be about to happen.
- **Ethics.** BRAKE must not become a re-engagement amplifier. Use these only for reflection that the user has opted into ("You left a ₹6,000 jacket in your cart 2 days ago. Still want it, or sleep on it?"). High volume, low precision, `List-Unsubscribe` present.
- **Recommendation: `research`.** Test the behavioral value before building it.

#### 13i. Payment OTP and authorization emails (`payment-otp-emails`)

- **Data.** Some issuers email OTPs for card-not-present transactions, often with amount and merchant [U].
- **Windows.** **IN-SPEND**: a payment is being authorized right now. This is email's only real in-spend signal.
- **Risks.** OTPs are authentication secrets. Processing them raises breach impact and fraud risk and would alarm users and reviewers.
- **Recommendation: `avoid`** by default. Exclude OTP senders and subjects at query and filter level. If it is ever explored, do it on-device only, with the code dropped by the parser before anything else sees it, and only on explicit opt-in.

---

### 14. Structured data in email: schema.org markup (`schema-org-email-markup`)

**What it is.** Senders can embed schema.org JSON-LD or microdata in HTML email. Gmail's "Email Markup" program historically used it for order, parcel, reservation and invoice cards and actions [U on the 2026 program state and registration rules: these requirements historically included DKIM/SPF authentication and a sending-volume history].

**Data available.** Vocabulary verified against the schema.org release in the official repo [P]:
- **`Order`**: `orderNumber`, `orderDate`, `orderStatus`, `orderedItem`, `acceptedOffer`, `merchant`/`seller`, `customer`, `paymentMethod`, `paymentMethodId`, `paymentDue`/`paymentDueDate`, `paymentUrl`, `discount`, `discountCode`, `discountCurrency`, `billingAddress`, `confirmationNumber`, `orderDelivery`, `partOfInvoice`, `isGift`, `broker`.
- **`OrderStatus`** values: `OrderPaymentDue`, `OrderProcessing`, `OrderInTransit`, `OrderPickupAvailable`, `OrderDelivered`, `OrderProblem`, `OrderReturned`, `OrderCancelled`.
- **`OrderItem`**: `orderItemNumber`, `orderItemStatus`, `orderQuantity`, `orderedItem`, `orderDelivery`.
- **`Invoice`**: `accountId`, `billingPeriod`, `totalPaymentDue`, `minimumPaymentDue`, `paymentDueDate`, `scheduledPaymentDate`, `paymentStatus` (`PaymentDue`, `PaymentComplete`, `PaymentPastDue`, `PaymentDeclined`, `PaymentAutomaticallyApplied`), `provider`, `referencesOrder`, `confirmationNumber`, `category`.
- **`ParcelDelivery`**: `trackingNumber`, `trackingUrl`, `carrier`/`provider`, `deliveryStatus`, `expectedArrivalFrom`/`Until`, `itemShipped`, `partOfOrder`, `deliveryAddress`, `originAddress`, `hasDeliveryMethod`.
- **`Reservation`**: `reservationId`, `reservationStatus` (`ReservationConfirmed`, `ReservationPending`, `ReservationHold`, `ReservationCancelled`), `reservationFor`, `totalPrice`, `priceCurrency`, `bookingTime`, `modifiedTime`, `underName`, `provider`, `bookingAgent`, `reservedTicket`. Subtypes include `FlightReservation`.

**Prevalence (as of 2026).** **Unknown and unverified.** No reliable public 2025–26 measurement was found. Some 2026 open-source connectors still parse JSON-LD in email deterministically, especially for flights, lodging and events [S], so some senders still emit it. Big merchants increasingly rely on the mailbox provider's own extraction (Gmail's purchases and reservations categorization) [U].

**Windows & latency.** As for the carrying email.

**Coverage.** Global, wherever senders emit it.

**Access requirements.** None. It is a parsing technique.

**Privacy & consent.** Parsing is local and deterministic, and needs no LLM.

**Reliability.** When present and the sender is DKIM-verified, it is the highest-confidence extraction available. Stale or incorrect markup is possible, so cross-check the `totalPrice` against the visible text.

**Dedup keys.** `orderNumber`, `reservationId`, `trackingNumber`, `confirmationNumber`.

**Normalized observation.** `extraction.method: schema_org`, with field confidence of about 0.95 when internally consistent.

**Provenance sentence.** *"Read from the structured order data in Amazon's email."*

**Recommendation: `mvp`**, as the first extractor layer, because it is cheap. **Measure prevalence** on BRAKE's own consented corpus by counting, per sender domain, how often JSON-LD or microdata is present. Aggregated counts are allowed under Limited Use's internal-operations exception [P\*].

---

### 15. Sender-template parsers (`email-template-parsers`)

**What it is.** Per-sender, versioned extraction rules: regex, DOM selectors, or a declarative rule set "as data, not code" [S pattern]. Each rule set is keyed by DKIM domain, subject hints and locale.

**Data available.** High-precision fields for known formats. Example HDFC patterns from a 2026 parser [S]:
- Amount: `(?:Rs\.?|INR)\s*([0-9][0-9,]*\.[0-9]{2})`
- RRN: `UPI\s+transaction\s+reference\s+number\s+is\s+([0-9]{12})`

**Windows & latency.** As for the carrying email. Parsing takes milliseconds, on-device or server-side.

**Coverage.** Long-tail coverage is poor. The top 20 senders per country probably cover a large share of the volume [U: measure it].

**Access requirements.** None.

**Privacy & consent.** Runs on-device. **Building and maintaining templates is the hard part.** Under Limited Use, staff cannot read users' Gmail-derived messages to write templates. Templates must come from:
- BRAKE's own test purchases.
- Explicit per-message donations (§10).
- Aggregated failure telemetry: sender domain, template version and failure code, with no content.

**Reliability & failure modes.** Silent breakage when a merchant redesigns its email. Mitigation: sum-check validators, per-template success-rate monitoring, and automatic fallback to the LLM layer with lower confidence.

**Dedup keys.** As extracted.

**Normalized observation.** `extraction.method: template:<id>@<version>`.

**Provenance sentence.** Same as the source email.

**Recommendation: `mvp`.**

---

### 16. LLM extraction: on-device first, server only with consent (`on-device-llm-extraction`, `email-llm-extraction-server`)

**What it is.** Schema-constrained generation that turns a message into the `EmailObservation` fields.

**On-device (`on-device-llm-extraction`).**
- **Android**: the ML Kit GenAI **Prompt API** on Gemini Nano (`com.google.mlkit:genai-prompt`, at least `1.0.0-beta4`, minSdk 26). It supports **structured output** via `@Generable` types, checked with `isStructuredOutputFeatureAvailable()`, and prefix caching for long prompts. The model's `FeatureStatus` must be `AVAILABLE` (otherwise `DOWNLOADABLE` or `UNAVAILABLE`) [P, Google's `android/skills`, last updated 2026-09-03]. (Corrected 2026-10-04: the skill gives `1.0.0-beta4` as a **minimum** version. It does not show that no stable release exists. The skill's structured-output reference uses `com.google.mlkit:genai-schema-compiler:1.0.0-alpha1`, so the structured-output tooling is **alpha** [P].) **Device coverage is limited** [U on the exact device list].
- **iOS** (corrected 2026-10-04, now [P] from Apple's documentation): Apple's **Foundation Models** framework was introduced in iOS/iPadOS/macOS 26.0 (non-beta) and offers **guided generation** through the `@Generable` macro. Apple says "people need a device that supports Apple Intelligence". As of Oct 2026, Apple's overview also says the framework gives access to "the on-device and Private Cloud Compute models" and to "any server model provider". **BRAKE must pin extraction to the on-device model** to keep the "never left your device" provenance claim true.
- **Fallbacks**: a small bundled model, or templates only.

**Server LLM (`email-llm-extraction-server`).** Allowed under Limited Use only as a disclosed, consented service-provider transfer with no training or retention [P\*/S]. Gmail data on a server also triggers CASA (§1).

**Windows & latency.** As for the carrying email. On-device inference takes seconds per message [U].

**Reliability & failure modes.**
- Hallucinated amounts. Mitigate with sum checks and by requiring the number to appear verbatim in the text.
- **Prompt injection.** Email content is attacker-controlled, so give the model no tools, use schema-only output, and gate trust on DKIM.
- Device fragmentation.

**Dedup keys.** As extracted.

**Normalized observation.** `extraction.method: llm:on-device:<model>@<ver>`, with a lower default confidence (about 0.6–0.8) until validators pass.

**Provenance sentence.** *"Understood on your phone from a Myntra email."*

**Recommendations.**
- `on-device-llm-extraction`: **`next`**. Ship it as the fallback layer where available.
- `email-llm-extraction-server`: **`avoid`** for Gmail-API data, because it adds CASA scope and erodes the privacy story. **`research`** for forwarded mail, with explicit opt-in only.

---

### 17. Gmail's own classifier as a pre-filter (`gmail-purchases-category`)

**What it is.** Gmail search operators `category:purchases` and `category:reservations` [P\* mirror of Gmail Help 7190], used inside `q` with `gmail.readonly`.

**Data available.** Only message IDs. It reduces what BRAKE fetches. 2026 open-source finance tools already use it, for example `category:purchases after:YYYY/MM/DD` [S].

**Windows & latency.** POST-SPEND and PRE-SPEND. No added latency.

**Coverage.** Gmail users with categories enabled. Category accuracy for Indian bank alerts is unknown: one 2026 n8n workflow labels HDFC alerts `CATEGORY_UPDATES` [S].

**Access requirements.** `gmail.readonly` (restricted). Unusable with `gmail.metadata` [P].

**Privacy & consent.** Fetching less improves minimization in practice, though not in the grant.

**Reliability.** A black box. Combine it with explicit `from:(…)` sender lists and bank-alert senders.

**Recommendation: `next`**, together with §1.

---

## Three-window classification

| Source | Pre-spend | In-spend | Post-spend | Typical latency | Notes |
|---|---|---|---|---|---|
| `gmail-api` (server) | Renewals, trials, bills, e-mandate notices, reservations | — | Receipts, bank alerts, refunds, shipping | Merchant send delay plus seconds (push) or poll interval | Restricted scope; CASA; app-type eligibility risk |
| `gmail-push-watch` | (transport) | — | (transport) | Seconds [U] | Renew watch at least every 7 days; at most 1 notification/sec/user [S] |
| `gmail-metadata-scope` | Weak (subjects only) | — | Weak (touchpoints) | Same as `gmail-api` | **Avoid**: restricted, no `q` |
| `gmail-api-on-device` | Yes | — | Yes | Android seconds–minutes; iOS minutes–hours | Possible CASA exemption, unconfirmed |
| `gmail-workspace-addon` | User-initiated | Occasional (open quote or checkout email) | User-initiated | Immediate | Sensitive scope; one message at a time |
| `microsoft-graph-mail` | Yes | — | Yes | Under 1 min average, 3 min max [P] | Personal accounts supported |
| `microsoft-graph-mail-readbasic` | Subjects only | — | Touchpoints | Under 1 min average [P] | Excludes body and preview |
| `imap-generic` | Yes | — | Yes | Minutes (poll or IDLE) | App passwords; on-device only |
| `email-forwarding-inbox` | Yes | — | Yes | Seconds–minutes | No OAuth; M365 tenants block by default |
| `manual-email-share` | Yes | Occasional | Yes | Immediate | User-initiated |
| `mailbox-export-import` | Baselines | — | History | Hours–days | One-off backfill |
| `bank-email-alerts` | — | — | **Yes (fast)** | Minutes [U] | India HDFC: all UPI, with RRN [S] |
| `merchant-receipt-emails` | — | — | Yes | Minutes; shipping in days | Item-level varies by merchant |
| `subscription-lifecycle-emails` | **Yes** (trial end, renewal, price change) | — | Yes (renewal receipt, cancel) | Days ahead | Not newsletters |
| `india-emandate-predebit-notification` | **Yes, at least 24h ahead (regulated)** | — | — | At least 24h before the debit | RBI 2026 framework [S] |
| `refund-cancellation-emails` | — | — | Yes | Days–weeks | Fixes spend versus refund |
| `travel-reservation-emails` | Contextual (upcoming trip or meal) | — | Yes (booking) | Minutes | schema.org most likely here |
| `bill-statement-emails` | Yes (dues) | — | Monthly reconciliation | Monthly | Password-protected PDFs |
| `merchant-intent-marketing-emails` | **Yes** (cart, price drop) | — | — | Hours–days | Ethics: no amplification |
| `payment-otp-emails` | — | **Yes** | — | Seconds | **Avoid** by default |
| `schema-org-email-markup` | Via reservations and invoices | — | Yes | Same as carrier | Prevalence unknown |
| `email-template-parsers` / `on-device-llm-extraction` | (technique) | (technique) | (technique) | Milliseconds / seconds | Facts, not bodies |

---

## Implications for BRAKE architecture

### Adapter design: separate transport, extraction and classification

```
Transport adapters (how a message arrives)          Extractors (how facts come out)         Output
  GmailApiTransport  (server | on-device)  ─┐        SchemaOrgExtractor      (deterministic)
  GraphMailTransport (Read | ReadBasic)    ─┤        SenderTemplateExtractor (versioned rules)    EmailObservation
  ImapTransport      (on-device only)      ─┼─► RawEmailEnvelope ─► LlmExtractor (on-device first) ─► (facts only)
  ForwardInboxTransport                    ─┤        (ephemeral, never     Validator (sum checks,       ─► Fusion
  ManualShareTransport / ExportImport      ─┘         persisted)            DKIM gate, verbatim-number)
```

- **`RawEmailEnvelope` is ephemeral.** It holds headers, the selected body parts and the authentication results. It lives in memory, or encrypted to the device key, and is **never persisted**. What is persisted is the `EmailObservation`, plus a **message reference** so the user can "open the original" in their mail app. Graph has `webLink` [P]; for Gmail, BRAKE stores the message or thread ID and builds a link [U on the URL form].
- **One `SenderPolicy`, compiled for each transport.** A single country-aware list of sender classes (bank alerts, merchants, subscriptions, travel), each with **DKIM domains**, compiles to:
  - a Gmail `q` string, for example `from:(alerts@hdfcbank.net OR alerts@hdfcbank.bank.in OR …) OR category:purchases newer_than:2d -subject:OTP`;
  - a Graph `$search` (KQL) query or a subscription `$filter`;
  - IMAP `SEARCH FROM` clauses;
  - a **user-installable forwarding filter** (Gmail filter XML or step-by-step instructions).

  The narrowness is then identical and auditable across adapters.
- **Sender authentication gate.**
  - Trust the **top-most `Authentication-Results`** header added by the receiving provider, or verify DKIM ourselves for forwarded mail, using ARC where present.
  - Require the DKIM `d=` domain to be in the merchant registry before an email can create merchant-branded insights.
  - Unauthenticated mail can only produce `low` confidence, needs user confirmation, and never triggers interventions.
- **Policy is uniform across adapters.** Gmail Limited Use rules (no ads, no brokers, no credit or lending use, no human reading without per-item consent, no generalized training) apply to **all** email-derived data, whatever the transport. This avoids "the forwarding path is allowed to do X" surprises and keeps the provenance promise simple.
- **Telemetry stays aggregated and content-free.** Allowed fields: sender domain, template ID and version, extraction outcome, field-presence bitmap, and schema.org presence. This is what BRAKE needs for template maintenance and prevalence measurement.

### Normalized `EmailObservation`

```yaml
EmailObservation:
  observation_id: uuid
  source_adapter: gmail-api | gmail-api-on-device | microsoft-graph-mail | microsoft-graph-mail-readbasic
                  | imap-generic | email-forwarding-inbox | manual-email-share | mailbox-export-import
  source_account_ref: opaque-id            # which connected mailbox; avoid storing the address server-side
  message_ref:
    provider_message_id: "18c2f…"          # Gmail id / Graph id / IMAP UIDVALIDITY:UID
    thread_ref: "…"                        # Gmail threadId / Graph conversationId
    internet_message_id_sha256: "…"        # cross-provider dedupe (RFC Message-ID, hashed)
  received_at: 2026-10-04T05:12:13Z        # Gmail internalDate / Graph receivedDateTime / IMAP INTERNALDATE
  sender:
    dkim_domain: amazon.in                 # aligned d= ; null if unauthenticated
    auth: {dkim: pass, dmarc: pass, arc: pass|none}
    via_forward: none | auto | manual
  email_kind: order_confirmation | payment_receipt | invoice | shipping_update | delivery_confirmation
            | bank_txn_alert_debit | bank_txn_alert_credit | card_statement | bill_due
            | subscription_started | renewal_notice | trial_ending | price_change | payment_failed
            | subscription_cancelled | refund_initiated | refund_completed | order_cancelled
            | emandate_predebit | travel_booking | reservation | abandoned_cart | price_drop | other
  merchant_raw: "Amazon.in"
  merchant_normalized_candidate: {id: amazon, confidence: 0.97}
  order_ref: {scheme: amazon-order-id, value: "403-1234567-1234567"}
  payment_refs:
    - {scheme: upi-rrn, value: "612345678901"}   # synthetic example value
    - {scheme: card-last4, value: "1234"}
    - {scheme: emandate-ref, value: "…"}
  amounts:
    value: 4799.00
    currency: INR
    role: order_total | charged | refund | upcoming_debit | price_old | price_new | amount_due
    components: {subtotal: …, tax: …, shipping: …, discount: …, tip: …, wallet_or_giftcard: …}
  line_items:
    - {name: "Electric toothbrush", qty: 1, unit_price: 2499.00, category_hint: personal_care, confidence: 0.86}
  times:
    ordered_at: …                          # merchant-stated
    expected_charge_at: …                  # e.g. e-mandate or renewal date
    due_at: …                              # bill due
    trial_ends_at: …
    service_at: …                          # flight / reservation time
  status_hint: intent | pending | confirmed | upcoming | refunded | cancelled
  transaction_type_hint: purchase | subscription | refund | bill | transfer | fee | unknown
  extraction:
    method: schema_org | template:hdfc-upi-debit@3 | llm:on-device:<model>@<ver> | user
    field_confidence: {amount: 0.99, merchant: 0.97, line_items: 0.80}
    validators: {sum_check: pass, number_verbatim: pass, dkim_gate: pass}
  sensitivity_flags: [health, ...]         # pharmacy etc.: line items redacted by default
  retention: {body_retained: false, facts_ttl_days: <policy>}
  provenance_text: "From your Amazon.in order email (Gmail, 4 Oct 10:42)"
```

**Confidence characteristics.**

| Combination | Default confidence |
|---|---|
| DKIM-aligned sender + schema.org or template + validators pass | 0.9–0.99 |
| DKIM-aligned sender + LLM + validators pass | 0.7–0.85 |
| Manual forward (no original DKIM) | Cap at 0.6 |
| Subject-only (`Mail.ReadBasic`) | 0.3–0.5, and only for `email_kind` |

### Fusion rules specific to email

1. **Email explains, the bank confirms.** When a bank, AA, Plaid, notification or SMS candidate exists, attach the email as **evidence**: items, category and subscription flag. Do not create a new candidate. On their own, emails create `intent` (cart, quote), `pending` (order placed, not yet charged), or `upcoming` (renewal, e-mandate) candidates.
2. **Matching windows depend on the merchant.** Examples:
   - Amazon: charge per shipment. Open-source matchers use windows such as −1 to +7 days (one per-shipment matcher) or up to +25 days after the order date (another tool's default). These are configuration heuristics, not Amazon-documented windows [S]. Subscribe & Save: +14 to +19 days, observed by one developer [S].
   - Hotels: charged at check-out.
   - Food delivery: charged at order, and a tip may change the final amount.
   - E-mandate: the debit lands at or after the notified date.

   Store these as merchant-registry data, not code.
3. **Allow N:M mapping.** One order can produce many charges (split shipments), and one charge can cover several orders (combined shipments). Partial refunds map to a single item where the price fits [S pattern].
4. **Strong keys before fuzzy keys.** Match on UPI RRN/UTR, then order ID, then `Message-ID`. Only then fall back to amount ± tolerance, time window, merchant similarity, and card last 4. **Never merge on fuzzy keys alone when two candidates are plausible.** Ask the user, or keep both linked with a `deduplication_group` at low confidence.
5. **Duplicate emails are one order.** Confirmation, invoice, shipped and delivered emails all refer to the same order ID. Link them by order ID and never count them separately.
6. **Cross-transport duplicates.** The same message can arrive via forwarding and later via the Gmail API, or via two mailboxes. Dedupe on the `internet_message_id_sha256`.

### Normalization pitfalls

- **Time.** `Date:` header, `internalDate`, order time and charge time all differ. Use `internalDate` or `receivedDateTime` for arrival time and merchant-stated times for semantics. Indian alerts use `dd-mm-yy` dates with no time zone [S]; assume IST from the registry.
- **Amounts.**
  - "Rs.", "₹", "INR" and thousands separators: Indian lakh grouping (`1,24,999.00`) versus Western grouping.
  - Comma decimals in EU locales.
  - Totals that include tax, shipping or tips.
  - Gift card or wallet portions not charged to the card.
  - FX conversion and fees.
  - Strike-through "old price" values inside marketing blocks.
- **Merchant identity.** The email brand (Swiggy) differs from the bank descriptor (`SWIGGY BANGALORE` or a VPA like `swiggy@ybl`) and from the payment gateway (Razorpay, PayU). Keep a merchant registry linking email DKIM domains ⇄ VPA handles ⇄ card descriptors.
- **Ownership.** Shared Amazon or Netflix accounts send receipts to one mailbox for family purchases, so ownership is `family`/`shared` and uncertain. Ask, don't assume.
- **Sensitive line items.** Pharmacy, health, adult and religious purchases. Default to redacting item names to a category, and keep names only with user opt-in (GDPR special categories; DPDP).
- **Locales and scripts.** Hindi or regional-language templates and mixed scripts break `q` and regex assumptions [U].
- **Bank domain migration.** Match `hdfcbank.net` *and* `hdfcbank.bank.in` (and so on) [S]. The registry must allow several domains per sender, each valid over a time range.

### Capability-registry facts (email)

```yaml
email_capabilities:
  GLOBAL:
    gmail-api-restricted-scopes:        {status: limited,     note: "verification + annual CASA for server access (as of 2026)"}
    gmail-metadata-scope:               {status: limited,     note: "restricted; no q; no full/raw format"}
    gmail-purchases-category-search:    {status: available,   note: "category:purchases / category:reservations via q"}
    gmail-workspace-addon-current-message: {status: available, note: "sensitive scope; open message only"}
    microsoft-graph-mail-personal:      {status: available,   note: "Mail.Read and Mail.ReadBasic consentable by MSA; no admin consent"}
    microsoft-graph-mail-change-notifications: {status: available, note: "message: avg <1 min, max 3 min; ≤10,080-min subscriptions"}
    outlook-com-imap-basic-auth:        {status: unavailable, note: "off since 2024-09-16; XOAUTH2 only"}
    m365-external-auto-forwarding:      {status: limited,     note: "default Off since 2021 for new orgs and orgs not actively using it (MS Learn, 2026-08-18)"}
    icloud-imap-app-specific-password:  {status: available,   note: "imap.mail.me.com:993 + app-specific password (FairEmail config; Apple page not fetched)"}
    yahoo-imap-app-password:            {status: unknown,     note: "CONFLICTING: FairEmail FAQ (2026-10-04) says Yahoo no longer allows app-password login; OAuth only"}
    android-on-device-llm-structured-output: {status: emerging, note: "Prompt API >= 1.0.0-beta4; schema compiler 1.0.0-alpha1; device-limited (2026-09-03)"}
    apple-foundation-models-on-device-llm: {status: limited,  note: "iOS 26.0+, Apple Intelligence devices only; @Generable guided generation; also routes to PCC/server models, so pin on-device"}
    schema-org-email-markup:            {status: unknown,     note: "prevalence unmeasured"}
  IN:
    bank-email-transaction-alerts:      {status: limited,     note: "not mandated; per-bank variance"}
    hdfc-upi-email-alerts:              {status: available,   note: "all UPI txns incl. RRN (reported)"}
    rbi-emandate-predebit-notification: {status: available,   note: "≥24h before recurring debit on cards, PPIs and UPI; merchant, amount, date, mandate ref (RBI/DPSS/2026-27/396)"}
    bank-in-sender-domains:             {status: available,   note: "RBI/2025-26/28: migrate to .bank.in by 2025-10-31; email adoption per bank; old domains still live"}
  US:
    issuer-transaction-email-alerts:    {status: unknown,     note: "opt-in per issuer; unverified"}
    ftc-click-to-cancel-rule:           {status: unavailable, note: "vacated by 8th Cir. 2025-07-08; ROSCA and state ARLs still apply"}
```

### Platform notes

- **Android.** Can run the Gmail API on-device with FCM relay, on-device extraction (ML Kit Prompt API where available), and forwarding. Email complements notification-listener sensing rather than replacing it.
- **iOS.** No notification or SMS reading, so **email is a primary near-real-time financial sensor on iOS**: bank alert emails in India, issuer alert emails in the US [U]. iOS background limits favor server-side or forwarding-inbox processing for latency, and on-device processing for privacy. Make the choice per user and explain it. On-device extraction can use Apple's Foundation Models (iOS 26+, Apple Intelligence devices only) [P]. Because the framework can also route to Private Cloud Compute or server models, BRAKE must use the on-device model explicitly for email content.
- **Web.** Server-side Gmail/Graph or forwarding. Mailbox export import can run fully local (WASM).

---

## Risks, policy constraints and ethical concerns

1. **Platform gatekeeping (Google).**
   - Restricted-scope verification can be refused on app-type grounds. BRAKE's purpose must fit "reporting or monitoring services... that improve the email experience" [S]. Get a pre-read and frame the feature as receipt, subscription and bill tracking.
   - Verification is re-done annually. A missed CASA can revoke production access [S].
   - Periodic re-consent for monitoring-style apps was announced in 2018; its current enforcement is unverified [S/U].
2. **Business-model constraints from Limited Use** [P\*].
   - **No credit-worthiness or lending use.** Gmail-derived data cannot feed any future BNPL, credit or lending partnership.
   - No ads or retargeting, and no data brokers or "information resellers". Aggregated or anonymized derivatives are covered too.
   - No generalized model training on Gmail data, so per-user personalization only.

   These constraints should be treated as **company commitments for all email data**.
3. **Human review.** Support and labeling teams may not read users' Gmail-derived content without per-item affirmative agreement [P\*]. Design consent-gated "share this email with support" flows. Never browse raw user mail in admin tools; build those tools to show facts only.
4. **Whole-mailbox grants versus narrow behavior.** OAuth consent is coarse, so trust depends on BRAKE behaving narrowly where users can't see it. Mitigations:
   - In-product pre-consent disclosure [S, a 2026 Workspace requirement].
   - A visible "what BRAKE read" log per source: counts by sender class, never content.
   - Open-sourcing the `SenderPolicy` lists.
   - Prefer forwarding and `Mail.ReadBasic` where they suffice.
5. **Spoofing and phishing amplification.** Fake "renewal failed" or "refund" emails could make BRAKE show false alerts or lend legitimacy to phishing. Gate merchant-branded insights on DKIM-aligned registry domains. Never render or relay links from emails. Never ask the user to act on an email-only signal involving credentials or payments.
6. **Prompt injection into LLM extractors.** Email content is attacker-controlled. Mitigations:
   - Schema-only output, and no tools or actions.
   - Validators that require every numeric value to appear verbatim.
   - Sender trust gating.

   A 2026 secondary reading says Google's Workspace policy now expects explicit prompt-injection protection for AI processing of Workspace data [S].
7. **Bank alert truthfulness.** Authentic alerts can be wrong: RBL's false "credited" e-alerts in 2026 [S]. Never mark `posted` from email alone, and reconcile against bank data where available.
8. **Third-party and sensitive data.** Receipts contain other people's names and addresses (gifts) and sensitive categories (health). Extract the minimum: no addresses, no Uber routes, health items reduced to a category by default.
9. **Regulatory.** GDPR/UK GDPR (EU/UK) treats email-derived purchase data as personal data, and some items are special-category data. India's DPDP Act 2023 requires notice and consent per purpose and a right to withdraw. The DPDP Rules, 2025 were notified on **13 November 2025**, with most data-fiduciary obligations taking effect 18 months later (**13 May 2027**) [S, several independent 2026 compliance write-ups; MeitY gazette not fetched; corrected 2026-10-04 from U]. US state privacy laws apply, and sector rules may apply if BRAKE ever ties into lending, which Limited Use forbids anyway.
10. **The email-monetization trust history.**
    - **Unroll.me / Slice.** An April 2017 NYT story reported that Uber bought anonymized Lyft-receipt data from Slice Intelligence, Unroll.me's parent. The data came from scanning users' inboxes. The FTC alleged Unroll.me falsely told users it wouldn't "touch" personal emails. The 2019 consent order required it to stop misrepresenting, notify affected users and **delete stored e-receipts**, with **no monetary fine**. Unroll.me is reported as **NielsenIQ-owned**, and its 2025 privacy notice still describes providing de-identified or aggregated reports to brands and data brokers [S].
    - **Rakuten Intelligence** (formerly Slice) sells e-receipt panel data [U].
    - **Edison Mail / Return Path.** A 2018 WSJ report described employees at email-app companies reading user emails to train algorithms [U].
    - **Google's response.** Project Strobe (October 2018) and the restricted-scope and security-assessment regime that followed [S].

    **Lessons for BRAKE:**
    - Monetization through "anonymized aggregates" still destroys trust.
    - "We don't read your email" claims must be literally true.
    - Free email tools subsidized by data sales are the archetype users fear.

    **Commitments BRAKE should make:**
    - No sale or licensing of email-derived data in any form, including aggregates.
    - Extraction on-device by default.
    - Bodies never retained.
    - A public Limited Use-style statement covering *all* providers.
    - An independent audit, which CASA partly provides.
    - A one-tap "disconnect and delete everything from this source".
11. **Over-intervention risk.** Marketing-intent emails (§13h) and OTP emails (§13i) offer tempting PRE- and IN-SPEND hooks that could make BRAKE intrusive or manipulative. Keep these opt-in and research-gated.

---

## Open questions

1. Will Google approve a **personal-finance and spending-decision** app for `gmail.readonly` under the "reporting or monitoring services... that improve the email experience" category? Which framing and feature set passes? Request a pre-read and check precedents among Indian card and expense apps [U].
2. Does Google still offer **any** local-client security-assessment exemption in 2026? The "local client applications ... may be exempt" sentence is in 2022 versions of the User Data Policy but not in the 15 Feb 2024 version. If an exemption exists, does a **local-client** Gmail integration that syncs only *derived facts* (amount, merchant, order ID) to BRAKE's cloud qualify? Does a server that receives only Pub/Sub `{emailAddress, historyId}` relay notifications count as "access through a server"?
3. Is Google's announced **periodic re-consent** for monitoring-style Gmail apps enforced in 2026, and at what interval?
4. Under `Mail.ReadBasic`, are `internetMessageHeaders` (and so `Authentication-Results` and `List-Unsubscribe`) returned? Can rich (`includeResourceData`) notifications be used with personal accounts?
5. Do Gmail's `category:purchases` and `category:reservations` exist as API `labelIds` (for `watch` label filters), or only as `q` operators? What is their recall on Indian bank alerts and regional-language receipts?
6. **Item-level reality in 2026.** Which top merchants per country (Amazon .in/.com, Flipkart, Myntra, Swiggy, Zomato, Blinkit, Zepto, BigBasket, Uber, Ola, Netflix, Spotify, Apple, Google Play, IRCTC, MakeMyTrip) include item names and per-item prices in emails? Requires a consented test-purchase corpus.
7. **schema.org prevalence.** What share of receipts and reservations from top senders carry JSON-LD or microdata? Measure with aggregated telemetry.
8. Which Indian banks email **every** UPI and card transaction (as HDFC reportedly does) versus only above a threshold? What are their DKIM domains after the `.bank.in` migration? Which issuers send e-mandate pre-debit notices by email as well as SMS?
9. US issuers: which offer opt-in per-transaction email alerts (thresholds, latency)? Could these give iPhone users a near-real-time signal?
10. Does a Gmail filter imported from XML keep a **forward-to** action? What is the smoothest forwarding-address confirmation flow in Gmail and Outlook.com in 2026?
11. Is Apple's Foundation Models framework (iOS 26+) good enough for receipt extraction, and how large is the device-coverage gap versus the Android ML Kit Prompt API?
12. Is Yahoo Mail's IMAP OAuth gated, and is auto-forwarding still paid-only? A major client (FairEmail) now states that Yahoo no longer accepts app passwords: since when, and for which accounts? What is iCloud Mail's current third-party access policy?
13. Does Microsoft require any security attestation (beyond publisher verification) for consumer apps using `Mail.Read` at scale in 2026?

---

## References

Access legend: **(F)** fetched directly in this session, from GitHub or raw GitHub; **(M)** primary text read through a mirror or copy hosted on GitHub; **(X)** consulted through web-search result excerpts only; **(R)** cited by a fetched source and not fetched directly. All were accessed on 2026-10-04.

1. Gmail API discovery document, revision 20260727. https://raw.githubusercontent.com/googleapis/google-api-go-client/main/gmail/v1/gmail-api.json **(F)**. Supports: scope descriptions; `q` unusable with `gmail.metadata`; `format` enum restrictions; `maxResults` ≤ 500; `WatchRequest`/`WatchResponse` fields; `history.list` 404 behavior; `Message` fields including `internalDate`.
2. Google, "Choose Gmail API scopes". https://developers.google.com/workspace/gmail/api/auth/scopes **(X)**. Supports: restricted classification of `gmail.readonly`/`metadata`/`modify` and others.
3. Google Cloud Help, "Restricted scopes". https://support.google.com/cloud/answer/13464325 **(X)**. Supports: the restricted Gmail scope list.
4. Google, "Restricted scope verification". https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification **(X)**. Supports: annual third-party assessment for server access. (Fact-check 2026-10-04: the page could not be fetched, because `developers.google.com` is blocked by the egress proxy. The local-client exemption sentence was verified only in 2022 User Data Policy snapshots (ref 41), so whether this page still carries it is unverified.)
5. Google Cloud Help, "Annual Recertification". https://support.google.com/cloud/answer/13463816 **(X)**. Supports: reverification and security assessment at least every 12 months.
6. Google API Services User Data Policy. https://developers.google.com/terms/api-services-user-data-policy, read via a verbatim copy at https://github.com/mnov88/dsacontracts/blob/3f4c7c92a2b9e3153bf7c3c9abca28851c12f693/Google%20APIs/Developer%20Terms.md **(M)**. Supports: Limited Use text (allowed uses, transfers, human reading, prohibition on ads, brokers and credit/lending); minimum permissions; annual security assessment clause. (Fact-check 2026-10-04: the copy is the version "Last updated February 15, 2024". It contains **no** local-client exemption sentence and **no** "personalized model" AI clause.)
7. Google Workspace user data and developer policy. https://developers.google.com/workspace/workspace-api-user-data-developer-policy **(X/R)**. Supports: the AI/ML "beyond that specific user's personalized model" clause; permitted Gmail use cases (quoted in refs 10–12).
8. Google Cloud Help, Limited Use FAQ. https://support.google.com/cloud/answer/13463817 **(X/R)**. Supports: personalized versus generalized models; no foundational-model training.
9. Search excerpts on CASA pricing and process: https://deepstrike.io/blog/google-casa-security-assessment-2025 ; https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option ; https://meetorbis.com/blog/how-we-passed-google-casa-tier-2-with-claude **(X)**. Supports: Tier 2 and Tier 3 price ranges; yearly revalidation.
10. "Gmail's Restricted Scope Gate", a research brief dated 25 Aug 2026. https://github.com/jacklvd/boomerang/blob/HEAD/.claude/artifacts/restricted-scope-gate.html **(F)**. Supports: the verification sequence; AL1/AL2; lab price table (which the brief itself says was "compiled from secondary sources reflecting 2024–2025 rate cards"); 100-user lifetime cap; 7-day Testing token expiry; watch limits (7-day renewal, 1/sec/user, 100 units); permitted-category summary; the 2018 re-consent quote; forwarding as a compliant fallback; the add-on scope limits; the Chrome Web Store Limited Use update of 1 Aug 2026.
11. "Restricted scope justification: gmail.readonly", 2026. https://github.com/yadava5/applied/blob/HEAD/docs/google/RESTRICTED-SCOPE-JUSTIFICATION.md **(F)**. Supports: why metadata/snippet is insufficient; the verbatim permitted-use-case quote; the body-never-persisted pattern.
12. "Google Workspace connector compliance review", 2026-08-13. https://github.com/OxFrancesco/BeeGreat/blob/HEAD/docs/research/google-api-user-data-policy-compliance.md **(F)**. Supports: 2026 Workspace policy requirements (pre-consent disclosure, Limited Use statement, token encryption and HSM, prompt-injection protection, incident reporting, incremental authorization).
13. laravel-gmail issue #50, "Metadata scope does not support 'q' parameter". https://github.com/dacastro4/laravel-gmail/issues/50 **(X)**. Supports: a real-world `q` error under `gmail.metadata`.
14. Gmail Help 7190, "Refine searches in Gmail", operator table read via mirror at https://github.com/julik/gmail_search_syntax/blob/HEAD/lib/GMAIL_SEARCH_OPERATORS.md **(M)**. Supports: `category:purchases` and `category:reservations`.
15. Microsoft Graph permissions reference. https://learn.microsoft.com/en-us/graph/permissions-reference, read via https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/permissions-reference.md **(F)**. Supports: `Mail.ReadBasic` exclusions; `Mail.Read`/`ReadWrite`; `IMAP.AccessAsUser.All`; personal-account consentability; admin-consent flags.
16. Microsoft Graph, "Get incremental changes to messages in a folder" and `message: delta`. https://learn.microsoft.com/en-us/graph/delta-query-messages ; https://learn.microsoft.com/en-us/graph/api/message-delta (repo: `concepts/delta-query-messages.md`, `api-reference/v1.0/api/message-delta.md`) **(F)**. Supports: per-folder delta; `$filter` limits; the 5,000 cap; `changeType`.
17. Microsoft Graph subscription resource and change-notification includes. https://learn.microsoft.com/en-us/graph/api/resources/subscription ; https://learn.microsoft.com/en-us/graph/change-notifications-overview (repo: `concepts/includes/change-notifications-subscription-lifetime.md`, `change-notifications-delivery-latency.md`) **(F)**. Supports: 10,080-minute and 1,440-minute lifetimes; message latency under 1 minute average and 3 minutes maximum.
18. Microsoft Graph, "Change notifications for Outlook resources". https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview (repo: `concepts/outlook-change-notifications-overview.md`) **(F)**. Supports: personal-account permissions for message subscriptions; the 1,000-subscription limit; `includeResourceData` requirements; `$filter`.
19. Microsoft Graph `message` resource. https://learn.microsoft.com/en-us/graph/api/resources/message (repo: `api-reference/v1.0/resources/message.md`) **(F)**. Supports: field names and `bodyPreview` = first 255 characters.
20. Microsoft Graph throttling limits, Outlook. https://learn.microsoft.com/en-us/graph/throttling-limits (repo: `includes/throttling-outlook.md`) **(F)**. Supports: 10,000 requests per 10 minutes and 4 concurrent requests per app per mailbox.
21. Microsoft Graph, "Use the $search query parameter". https://learn.microsoft.com/en-us/graph/search-query-parameter (repo: `concepts/search-query-parameter.md`) **(F)**. Supports: KQL message search with up to 1,000 results.
22. Microsoft Entra, "Publisher verification". https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview, read via https://github.com/MicrosoftDocs/entra-docs/blob/main/docs/identity-platform/publisher-verification-overview.md **(F)**. Supports: CPP requirement; the November 2020 rule on consent to unverified apps under step-up consent.
23. Microsoft Defender for Office 365, "Control automatic external email forwarding". https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding, read via https://github.com/merill/defender-docs-mirror/blob/HEAD/defender-office-365/outbound-spam-policies-external-email-forwarding.md **(M)**. Supports: "Automatic – System-controlled" changed to Off in 2021 for new orgs and for existing orgs not actively using it; the 5.7.520 NDR text (mirror page dated 2026-08-18).
24. Zelos IMAP adapter notes. https://github.com/HoosAILLC/zelos/blob/304994edc87aa2769665bc2c9f670f676479548e/core/sources/imap.mjs **(F)**. Supports: Outlook.com, Hotmail, Live and MSN basic auth and app passwords switched off 16 Sep 2024; XOAUTH2 with `outlook.office.com/IMAP.AccessAsUser.All`.
25. schema.org vocabulary release 30.0. https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/releases/30.0/schemaorg-current-https.jsonld **(F)** (also https://schema.org/Order). Supports: property lists for Order, OrderItem, Invoice, ParcelDelivery, Reservation; OrderStatus, PaymentStatusType and ReservationStatusType values.
26. Mimir email connector documentation. https://github.com/BhavsarDevansh/Mimir/blob/HEAD/docs/email-connector.md **(X via GitHub code search)**. Supports: deterministic JSON-LD parsing of reservations and orders in email (2026 precedent).
27. HDFC email parser test fixture, 2026. https://github.com/arun-mishra20/workspace/blob/374fd476495a3a8fb19318a6f315475de7968c0e/apps/api/src/modules/expenses/infrastructure/parsers/hdfc-email.parser.spec.ts **(X via GitHub code search)**. Supports: the HDFC UPI alert email format, including the 12-digit UPI reference number.
28. Bank credit-alert parser registry. https://github.com/chrisjaimon2012/thela/blob/ddc8fa259354c3a7dc04ee48c150003238acdb78/src/lib/banks/parsers.json **(F)**. Supports: RBI/2017-18/15 (SMS mandatory, email optional); HDFC SMS thresholds from 25 June 2024 with email continued for all UPI; `.bank.in` domain migration; DKIM-domain matching; RBL false-credit alerts (Moneylife, 1 July 2026); ICICI and SBI suitability notes.
29. Authentication-Results usage in a bank-email parser. https://github.com/unixipher/paymentgateway/blob/c1782bc2e489b6f4efc1605242d77be8020333e7/src/lib/parser.ts **(X via GitHub code search)**. Supports: trusting the top-most `Authentication-Results` header that Gmail prepends.
30. RBI Digital Payments e-Mandate Framework 2026 (RBI/DPSS/2026-27/396, 21 Apr 2026), verbatim extract reproduced from TaxGuru at https://github.com/manorath295/buildathon/blob/3c7dca02a79c55f2ac78e8a0d2ac67f9adaa2309/docs/sources/RBI_EMANDATE_2026.txt and `RBI_PRE_DEBIT_2026.txt` **(F)**. Original: https://taxguru.in/rbi/rbi-issues-consolidated-directions-digital-payments-e-mandate-framework-2026.html **(R)**. Supports: pre-transaction notification at least 24h ahead, with minimum contents, opt-out, exemptions, and the ₹15,000 AFA-free limit.
31. RBI circular of 22 Aug 2024 on processing e-mandates (markdown copy). https://github.com/vishvaRam/Data-Prep-for-LLM-fine-tuning/blob/1ad657808eeab6248ee80ef923794bc5a41ed45d/Data/pdf-markdowns/2024/RBI_2024-2025_64CO.DPSS.POLC.No.S528_02-14-003_2024-25_2024-08-22.md **(X via GitHub code search)**. Supports: the 24-hour pre-debit notification requirement in RBI text.
32. Amazon-Receipts, an Amazon-to-YNAB enrichment service. https://github.com/jamesonwildwood/Amazon-Receipts/blob/main/README.md **(F)**. Supports: Amazon charges at shipment; Subscribe & Save charges 14–19 days after the order; match windows.
33. amazon-exporter-for-ynab. https://github.com/jparavisini/amazon-exporter-for-ynab/blob/main/README.md **(F)**. Supports: one card charge per shipment; refund attribution; per-item splits; order ID format.
34. ynab-amazon-transaction-updater. https://github.com/justinfiore/ynab-amazon-transaction-updater/blob/master/README.md **(F)**. Supports: parsing Amazon order confirmations, S&S and refund emails over IMAP; Walmart email order IDs plus web lookup for items.
35. bitetrack-backend routes. https://github.com/Jodd-cyber/bitetrack-backend/blob/4769826cd81fc961e63ec0bf9a97965ef2d41abb/routes/ai.js **(X via GitHub code search)**. Supports: Swiggy and Zomato sender queries and item-level extraction from order emails (weak evidence).
36. "Unroll.me alternative" (MailMop blog source). https://github.com/neilbhammar/mailmop/blob/HEAD/content/blog/unroll-me-alternative.mdx **(X via GitHub code search)**. Supports: summary of the 2019 FTC settlement (deletion, notice, no fine), the 2017 NYT Lyft/Uber report, and NielsenIQ ownership with the 2025 privacy-notice description.
37. Project Strobe and "Elevating user trust in our API ecosystems" (2018). https://www.blog.google/technology/safety-security/project-strobe/ ; https://cloud.google.com/blog/products/g-suite/elevating-user-trust-in-our-api-ecosystems **(R)**, referenced by multiple GitHub-hosted sources. Supports: origin of the restricted Gmail scope regime.
38. Gmail "Manage subscriptions" launch (8–9 July 2025), via an RSS archive of The Verge and PCWorld entries: https://github.com/rumca-js/RSS-Link-Database-2025 **(X via GitHub code search)**. Original: https://blog.google/products/gmail/new-manage-subscriptions-unsubscribe/ **(R)**. Supports: the feature targets newsletter subscriptions, rolled out on web, Android and iOS.
39. Google `android/skills`, ML Kit GenAI Prompt API skill (last-updated 2026-09-03). https://github.com/android/skills/blob/42dc2270e96032bd860bb94511e440aa00a43125/device-ai/ml-kit-genai-prompt-api/SKILL.md **(F)**. Supports: Gemini Nano Prompt API at a minimum of `1.0.0-beta4`, minSdk 26, structured output via `@Generable`, `FeatureStatus` checks. Its structured-output reference (https://github.com/android/skills/blob/main/device-ai/ml-kit-genai-prompt-api/references/structured-output.md, **(F)**) uses `genai-schema-compiler:1.0.0-alpha1`.
40. App Defense Alliance CASA framework. https://appdefensealliance.dev/casa **(R)**. Google security assessment help: https://support.google.com/cloud/answer/13465431 **(R)**. Supports: the CASA basis of Google's restricted-scope assessment.

*References added by the 2026-10-04 fact-check:*

41. Archived Google API Services User Data Policy snapshots (Open Terms Archive-style capture). Sep 2022 version: https://github.com/LORDLYAMIGO/eudia-hackathon-eula-handler/blob/HEAD/EULA/console.cloud.google.com/Developer%20Terms/2022-09-13T18-34-34Z.md **(M)**. Oct 2025 capture of the 15 Feb 2024 version: https://github.com/LORDLYAMIGO/eudia-hackathon-eula-handler/blob/HEAD/EULA/console.cloud.google.com/Developer%20Terms/2025-10-21T18-09-01Z.md **(M)**. Supports: the 2022 Gmail permitted-application-type wording; the 2022 local-client exemption sentence and its absence in 2024–2025; the current Limited Use wording, including credit-worthiness and lending.
42. Verbatim copy of Google's "Using OAuth 2.0 to Access Google APIs". https://github.com/gdrozo/organiser/blob/HEAD/Docs/Google%20Drive%20Api%20Docs/Using%20OAuth%202.0%20to%20Access%20Google%20APIs.txt **(M)**. Supports: 7-day Testing-mode refresh-token expiry; revocation on password change for Gmail scopes; the six-month idle rule; 100 refresh tokens per account per client ID.
43. Verbatim copy of Google's Gmail push-notification guide. https://github.com/benhyh/flow/blob/6720f848ea5c109444e1950eeb3d060c7646a44a/.kiro/steering/gmail-api.md **(M)**. Supports: the `{"emailAddress","historyId"}` payload; re-calling `watch` at least every 7 days (daily recommended); 1 event/sec/user, with excess notifications dropped; the history 404 to full-sync rule.
44. Copies of Google's Gmail scope table (tab-separated, with sensitivity column): https://github.com/i-am-alice/4th-devs/blob/HEAD/03_04_gmail/docs/reference.md ; https://github.com/iceener/gmail-streamable-mcp-server/blob/HEAD/api.md **(M)**. Supports: `gmail.readonly`/`compose` restricted; `gmail.send` and the add-on `current.message.readonly/metadata` scopes sensitive; `gmail.labels` non-sensitive.
45. FairEmail FAQ and provider configuration (M66B/FairEmail, fetched 2026-10-04). https://github.com/M66B/FairEmail/blob/master/FAQ.md ; https://github.com/M66B/FairEmail/blob/master/app/src/main/res/xml/providers.xml **(F)**. Supports: the Outlook/Hotmail/Live basic-auth and app-password cutoff of 16 Sep 2024 (linking Microsoft's Outlook blog at https://techcommunity.microsoft.com/t5/outlook-blog/keeping-our-outlook-personal-email-users-safe-reinforcing-our/ba-p/4164184 **(R)**); Yahoo "no longer allows users to log in using just an (app) password"; iCloud `imap.mail.me.com:993` with an app-specific password.
46. Apple Developer Documentation, Foundation Models (JSON form of https://developer.apple.com/documentation/foundationmodels). https://developer.apple.com/tutorials/data/documentation/foundationmodels.json **(F)**. Supports: introduced in iOS/iPadOS/macOS 26.0; `@Generable` guided generation; requires an Apple Intelligence device; access to on-device, Private Cloud Compute and server models.
47. Microsoft Graph, "Obtain immutable identifiers for Outlook resources" (repo: `concepts/outlook-immutable-id.md`) and "Receive change notifications through webhooks" (repo: `concepts/change-notifications-delivery-webhooks.md`), in https://github.com/microsoftgraph/microsoft-graph-docs-contrib **(F)**. Supports: IDs change on folder move unless `Prefer: IdType="ImmutableId"` is sent; the webhook must be public HTTPS; basic notifications carry only resource IDs.
48. Independent 2026 corroborations of the RBI E-mandate Framework, 2026 (RBI/DPSS/2026-27/396, 21 Apr 2026): https://github.com/subhash-0000/Razorpay-Submission/blob/258f9c6246133fe00aec9d761510e7a31da7eaa5/backend/parsed/RBI_2026_EMANDATE_002.txt ; https://github.com/R-Abinav/mandate/blob/ec80acb91fd7609341c19fa9c1731743f2008bbd/docs/VERIFIED_POINTERS.md **(F)**. RBI page as cited there: https://rbi.org.in/Scripts/NotificationUser.aspx?Id=13374 **(R, not reachable from this environment)**. Supports: scope covering cards, PPIs and UPI; the ₹15,000 and ₹1,00,000 AFA-free limits; pre-debit and post-debit notifications; repeal of the 2019–2024 circulars.
49. Secondary 2026 sources on the FTC Negative Option Rule vacatur (Eighth Circuit, 8 July 2025), found by GitHub code search, e.g. https://github.com/cgallic/kai-cmo-harness/blob/HEAD/harness/references/advertising-compliance.md **(X via GitHub code search)**. Supports: vacatur date and compliance date.
50. Secondary 2026 sources on India's DPDP Rules, 2025 (notified 13 Nov 2025; full compliance 13 May 2027), e.g. https://github.com/Sushegaad/Claude-Skills-Governance-Risk-and-Compliance/blob/HEAD/plugins/dpdpa/skills/dpdpa/SKILL.md **(X via GitHub code search)**. Supports: DPDP Rules dates.
51. Secondary sources on RBI/2025-26/28 (22 Apr 2025), which requires banks to migrate to `.bank.in` by 31 Oct 2025, e.g. https://github.com/aws-samples/sample-CryptaMap/blob/HEAD/dashboard/public/compliance/rbi.json **(X via GitHub code search)**; RBI page as cited: https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12837 **(R)**. Supports: `.bank.in` deadline and circular number.
52. PCWorld, 9 July 2025, "Gmail gets new feature to unsubscribe from emails", as archived in https://github.com/rumca-js/RSS-Link-Database-2025 (file `2025/07/2025-07-09/https...www.pcworld.com.index.rss_entries.json`) **(X via GitHub code search)**. Supports: Manage subscriptions rollout on web (9 Jul), Android (14 Jul) and iOS (21 Jul) 2025.
53. UnaMentis iOS integration discovery notes (June 2026). https://github.com/UnaMentis/unamentis-ios/blob/HEAD/docs/ios/PERSONAL_ASSISTANT_INTEGRATION_DISCOVERY_2026-06.md **(X via GitHub code search)**. Supports: a 2026 view that the local-client CASA carve-out is no longer clean in live policy text (secondary; unverified).

---

## Verification log

Adversarial fact-check performed 2026-10-04. `developers.google.com`, `support.google.com`, `learn.microsoft.com`, `rbi.org.in`, `ftc.gov`, `taxguru.in` and `moneylife.in` were blocked by the egress proxy, and the shared web-search budget was exhausted. Verification therefore used official doc-source repos on GitHub, archived policy snapshots, verbatim copies of Google docs, Apple's developer documentation JSON, and independent secondary sources. Verdicts: **confirmed** (supported by a primary source or a verbatim primary copy, or by several independent secondary sources consistent with each other), **corrected** (the doc was wrong, overstated or under-qualified; now fixed inline), **unverifiable** (no adequate source reachable; left marked (unverified)).

| # | Claim | Verdict | Source |
|---|---|---|---|
| 1 | `q` cannot be used with the `gmail.metadata` scope; `format=full/raw` likewise; discovery revision `20260727` | confirmed | https://raw.githubusercontent.com/googleapis/google-api-go-client/main/gmail/v1/gmail-api.json |
| 2 | All Gmail read scopes, including `gmail.metadata`, are restricted; `gmail.send` sensitive; `gmail.labels` non-sensitive; add-on `current.message.readonly/metadata` sensitive | confirmed (via verbatim scope-table copies) | ref 44; https://github.com/jacklvd/boomerang/blob/HEAD/.claude/artifacts/restricted-scope-gate.html |
| 3 | Add-on `...message.action` scope is sensitive | unverifiable (one copy lists it as non-sensitive) | https://github.com/NayanKanaparthi/Orivra/blob/HEAD/docs/SECURITY_NOTES.md |
| 4 | Limited Use covers raw, aggregated, anonymized and derived data; bans transfer to ads platforms and data brokers, ads use, and credit-worthiness/lending use; humans may not read without per-item agreement | confirmed (policy dated 15 Feb 2024, still current in an Oct 2025 snapshot) | ref 41; https://github.com/mnov88/dsacontracts/blob/3f4c7c92a2b9e3153bf7c3c9abca28851c12f693/Google%20APIs/Developer%20Terms.md |
| 5 | AI/ML ban "beyond that specific user's personalized model" | corrected (attribution: Workspace policy, not the general User Data Policy; secondary only) | https://github.com/OxFrancesco/BeeGreat/blob/HEAD/docs/research/google-api-user-data-policy-compliance.md |
| 6 | Local-client apps "may be exempt" from the security assessment | corrected (verified only in 2022 policy text; removed by the Feb 2024 version; 2026 status unverified) | ref 41; ref 53 |
| 7 | Gmail permitted app type quoted verbatim "...that improve the email experience..." by two 2026 sources | corrected (one source quotes it; 2022 official wording differs; current wording unverified) | https://github.com/yadava5/applied/blob/HEAD/docs/google/RESTRICTED-SCOPE-JUSTIFICATION.md ; ref 41 |
| 8 | CASA lab prices are "2026 market" ($540–$1,800 T2; $4.5k–$8k T3) | corrected (the source compiles 2024–2025 rate cards) | https://github.com/jacklvd/boomerang/blob/HEAD/.claude/artifacts/restricted-scope-gate.html |
| 9 | Testing-mode 7-day refresh-token expiry; 100 tokens per account per client; password-change and 6-month revocation | confirmed (verbatim copy) | ref 42 |
| 10 | 100-user lifetime cap for unverified apps; annual (12-month) CASA revalidation | confirmed (secondary quoting Google; Google pages unreachable) | https://github.com/jacklvd/boomerang/blob/HEAD/.claude/artifacts/restricted-scope-gate.html |
| 11 | Gmail push payload `{emailAddress, historyId}`; renew `watch` at least every 7 days; 1 event/sec/user | confirmed (was [U] for payload) | ref 43 |
| 12 | `category:purchases` / `category:reservations` search operators exist | confirmed (mirror of Gmail Help 7190) | https://github.com/julik/gmail_search_syntax/blob/HEAD/lib/GMAIL_SEARCH_OPERATORS.md |
| 13 | Graph `Mail.ReadBasic` excludes body, previewBody, attachments, extended properties; `Mail.Read`, `Mail.ReadBasic` and `IMAP.AccessAsUser.All` consentable by personal accounts with no admin consent | confirmed | https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/permissions-reference.md |
| 14 | Graph message notifications: avg < 1 min, max 3 min; max lifetime 10,080 min (1,440 with resource data); 1,000 subscriptions per mailbox; personal accounts supported | confirmed (includes dated 11/07/2024) | microsoft-graph-docs-contrib `concepts/includes/change-notifications-delivery-latency.md`, `change-notifications-subscription-lifetime.md`, `concepts/outlook-change-notifications-overview.md` |
| 15 | Graph delta is per-folder; `$filter` only on `receivedDateTime` (5,000 cap); no `$search` | confirmed | microsoft-graph-docs-contrib `concepts/delta-query-messages.md` |
| 16 | Graph Outlook throttling: 10,000 requests / 10 min, 4 concurrent per app per mailbox | confirmed | microsoft-graph-docs-contrib `includes/throttling-outlook.md` |
| 17 | Graph message IDs change on folder move unless immutable IDs are used | confirmed (was [U]) | ref 47 |
| 18 | Publisher verification needs a verified CPP account; Nov 2020 consent rule under risk-based step-up | confirmed | https://github.com/MicrosoftDocs/entra-docs/blob/main/docs/identity-platform/publisher-verification-overview.md |
| 19 | M365 external auto-forwarding Off by default "for most orgs" since 2021 | corrected (new orgs and orgs not actively using it) | ref 23 mirror (dated 2026-08-18) |
| 20 | Outlook.com/Hotmail/Live basic auth and app passwords off since 16 Sep 2024 | confirmed (two independent implementations) | ref 24; ref 45 |
| 21 | Yahoo app passwords available for IMAP | corrected (contradicted by FairEmail FAQ; status unknown) | ref 45 |
| 22 | iCloud IMAP `imap.mail.me.com:993` with app-specific password | confirmed (secondary client config) | ref 45 |
| 23 | RBI E-mandate Framework 2026 (RBI/DPSS/2026-27/396, 21 Apr 2026): 24h pre-debit notice with merchant, amount, date/time, mandate ref; opt-out; FASTag/NCMC exempt; ₹15,000 AFA-free | confirmed (many independent secondaries; RBI page unreachable) | https://github.com/manorath295/buildathon/blob/3c7dca02a79c55f2ac78e8a0d2ac67f9adaa2309/docs/sources/RBI_EMANDATE_2026.txt ; ref 48 |
| 24 | E-mandate scope is cards and PPIs (UPI "analogous") | corrected (the framework covers cards, PPIs and UPI; ₹1 lakh category limit and post-debit notice added) | ref 48 |
| 25 | RBI/2017-18/15: SMS alerts mandatory, email optional | confirmed (secondary quote; may since be consolidated; unverified) | https://github.com/chrisjaimon2012/thela/blob/ddc8fa259354c3a7dc04ee48c150003238acdb78/src/lib/banks/parsers.json |
| 26 | HDFC SMS thresholds from 25 Jun 2024 while email continues for all UPI | confirmed (secondary; HDFC page unreachable) | same as #25 |
| 27 | HDFC alert email format with 12-digit UPI RRN (2026 sample) | confirmed; quoted sample redacted (third-party PII) | https://github.com/arun-mishra20/workspace/blob/374fd476495a3a8fb19318a6f315475de7968c0e/apps/api/src/modules/expenses/infrastructure/parsers/hdfc-email.parser.spec.ts |
| 28 | Indian banks moved to `.bank.in` in 2025 | confirmed with precision added (RBI/2025-26/28, deadline 31 Oct 2025; web-domain mandate, email adoption per bank) | ref 51 |
| 29 | RBL false "credited" e-alerts (Moneylife, 1 Jul 2026, 47 of 54) | unverifiable (single secondary; Moneylife unreachable) | thela parsers.json |
| 30 | ML Kit GenAI Prompt API "still beta4" in Sep 2026 | corrected (minimum version is beta4; structured-output schema compiler alpha1; stable status unknown) | ref 39 |
| 31 | Apple Foundation Models shipped with iOS 26, guided generation, Apple Intelligence devices only | confirmed (was [U]); added that the framework also routes to PCC/server models | ref 46 |
| 32 | FTC click-to-cancel rule vacated by the 8th Circuit, July 2025 | confirmed (secondaries consistent: 8 Jul 2025; was [U]) | ref 49 |
| 33 | Gmail "Manage subscriptions" launched July 2025 on web, Android, iOS | confirmed (9/14/21 July rollout per PCWorld) | ref 52 |
| 34 | DPDP Rules notified Nov 2025 with phased commencement | confirmed (13 Nov 2025; 13 May 2027; was [U]) | ref 50 |
| 35 | Unroll.me: FTC 2019 order (no fine, deletion, notice); NYT 2017 Slice/Lyft/Uber; NielsenIQ ownership | confirmed for the FTC/NYT summary (secondary); NielsenIQ ownership unverifiable (competitor blog only) | https://github.com/neilbhammar/mailmop/blob/HEAD/content/blog/unroll-me-alternative.mdx |
| 36 | Amazon charges per shipment; S&S +14–19 days | confirmed as hobby-tool observations (not Amazon documentation) | refs 32–33 |
| 37 | schema.org Order / Invoice / ParcelDelivery / Reservation property and enum lists | confirmed | https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/releases/30.0/schemaorg-current-https.jsonld |
| 38 | No CASA-style mandated audit for Graph consumer mail; Workspace add-ons on Gmail mobile; Yahoo forwarding paid-only; US issuer email alerts; Gmail Email Markup program state; schema.org prevalence | unverifiable | none reachable |

**Citation spot-check (25 URLs).** Refs 1, 6 (mnov88 copy), 10, 11, 12, 14, 15–22 (Graph and Entra doc sources), 23 (mirror), 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36 and 39 resolve and contain the attributed text. Exceptions: ref 6 does not contain the local-client or AI/ML clauses; ref 10 states its prices are 2024–2025 rate cards; ref 11 is the only source of the "improve the email experience" wording; ref 27's sample contains third-party PII (redacted here). Refs 2–5, 7–9, 13 and 37–38 (Google, support.google.com, vendor blogs) could not be fetched.
