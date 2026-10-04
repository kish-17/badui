# Android device signals for BRAKE (research stream 03)

> **Scope.** This stream covers on-device Android mechanisms that can give BRAKE spending context:
> NotificationListenerService, SMS (READ_SMS / RECEIVE_SMS, SMS Retriever / User Consent, default
> SMS role), sideload and alternative distribution, app-open signals (UsageStatsManager), Accessibility,
> overlays, share and PROCESS_TEXT intents, clipboard, App Widgets, Quick Settings tiles, notification
> actions and RemoteInput, Live Updates, App Actions / AppFunctions / Gemini, `upi://` intent handling,
> Digital Wellbeing, Android 15 private space and Wear OS. Bank/aggregator APIs, Gmail, iOS and UPI
> payment semantics belong to other streams. This stream covers only the Android side of those
> sources.
>
> **Date:** 2026-10-04. All time-sensitive claims are "as of" this date unless another date is given.
>
> **Verification note.** Android platform facts below come from developer.android.com pages fetched
> on 2026-10-04 (most say "Last updated" between 2026-07 and 2026-10-01), and from AOSP source
> files read through the GitHub mirror. That mirror may lag the current release; where it disagrees
> with the developer reference, the reference wins. The network egress policy blocked
> `support.google.com`, `play.google.com`, `source.android.com`, `developers.google.com`, `npci.org.in`,
> Google blogs and most news sites. **Google Play policy claims are therefore taken from search-engine
> excerpts of the official Play Console Help pages, not from the pages themselves.** They are marked
> *(Play excerpt)*. Anything else that could not be verified is marked *(unverified)*.
>
> **Fact-check pass (2026-10-04).** An adversarial re-verification of the load-bearing claims was run
> against developer.android.com and the AOSP mirror on 2026-10-04; corrections are applied inline and
> listed in the "Verification log" at the end. Two caveats from that pass: (a) the GitHub AOSP mirror
> (`aosp-mirror/platform_frameworks_base`, branch `main`) clearly lags the shipping platform — it has
> Android 16's `ProgressStyle` but not `Notification.EXTRA_REQUEST_PROMOTED_ONGOING`/`MetricStyle`, and it
> still declares `RECEIVE_SENSITIVE_NOTIFICATIONS` as `signature|role` — so AOSP-only claims describe
> roughly Android 15/16-era code; (b) `support.google.com` and Google blogs remained blocked, so Play
> policy claims are still *(Play excerpt)* / *(unverified)*.
>
> ### Key takeaways for BRAKE
>
> 1. **NotificationListenerService (NLS) is the most valuable Android signal and should be the
>    Android MVP sensor.** It sees bank-app, card-app, UPI-app and wallet push alerts. It also sees
>    bank **SMS and RCS** messages through the messaging app's notification, with no SMS permission.
>    All of this arrives within seconds of the alert being posted. No Play declaration form for NLS
>    was found *(unverified for 2026)*. The user grants it under "Notification access", and on Android
>    13+ sideloaded apps hit the restricted-settings block.
> 2. **OTP-bearing messages are no longer a usable IN-SPEND signal on modern Android.** Since
>    Android 15, the system strips OTP-bearing notifications before an "untrusted" listener receives
>    them. The listener gets the title replaced by the posting app's label, the text replaced by
>    "Sensitive notification content hidden", and action titles blanked. SMS that contain OTPs are
>    withheld from non-exempt SMS-reading apps for **3 hours**: SMS Retriever-format messages were
>    already delayed before Android 17 (the docs do not say from which release); Android 17 adds
>    WebOTP-format messages for all apps regardless of target SDK, and standard OTP SMS for apps
>    targeting API 37 (as of the 2026-10-01 Android 17 docs). "Trust" requires
>    `RECEIVE_SENSITIVE_NOTIFICATIONS` (signature|preinstalled|knownSigner|role) or a companion-device
>    association, which BRAKE cannot legitimately obtain. BRAKE must not design around
>    card-authentication OTP messages. Its adapters must also treat a redacted notification as a
>    *meta-signal* ("something sensitive arrived from app X") rather than as text to parse.
> 3. **Reading the SMS inbox on Play is possible but gated.** Play Console Help lists an exception
>    for **"SMS-based money management — apps that track and manage budget"**, covering `READ_SMS`,
>    `RECEIVE_SMS`, `RECEIVE_MMS` and `RECEIVE_WAP_PUSH` *(Play excerpt)*. Using it needs an approved
>    Permissions Declaration. Play's own wording treats exceptions as "temporary" and available only
>    when "there's currently no alternative method". What READ_SMS adds over NLS is **historical
>    backfill at onboarding** (months of bank SMS give an instant baseline). Recommendation: *next*,
>    not MVP.
> 4. **Sideloading to get around Play policy is shrinking and should not be the plan.** The obstacles:
>    - Android 13+ "restricted settings" blocks NLS and Accessibility grants for sideloaded apps.
>    - Android developer verification applies to installs from participating stores (Google Play,
>      Galaxy Store, Xiaomi GetApps, OPPO App Market, V-Appstore, HONOR App Market, Palm Store) in BR,
>      ID, SG and TH from 2026-09-30. Direct sideloads and other stores are **not** affected yet; the
>      global expansion "for all apps on certified Android devices" is planned for 2027 (as of
>      2026-10-04).
>    - Android 16 Advanced Protection Mode blocks installs from unknown sources for users who turn it
>      on (an opt-in mode, not a default).
>    - Play Protect fraud protections are reported to block internet-sideloaded apps that request
>      SMS, NLS or Accessibility *(unverified)*.
> 5. **For Android PRE-SPEND, use user-initiated surfaces, not surveillance.**
>    - **MVP:** share target (`ACTION_SEND`), text-selection "Ask BRAKE" (`ACTION_PROCESS_TEXT`), a
>      home-screen widget, and paste-on-tap.
>    - **Next:** a Quick Settings tile, with an Android 13+ add prompt via `requestAddTileService()`.
>    - **Research only:** app-open detection with `UsageStatsManager`. It needs the user-granted
>      `PACKAGE_USAGE_STATS` app-op, returns `null` while the device is locked, keeps events only
>      "a few days", and has no public push callback, so it means polling. It is privacy-heavy.
>    - **Avoid:** AccessibilityService and `SYSTEM_ALERT_WINDOW` overlays for interception.
> 6. **One-tap labelling on Android works with three action buttons plus app-supplied chips.**
>    - `Notification.MAX_ACTION_BUTTONS = 3`, and the docs say "up to three action buttons".
>    - Separately, AOSP SystemUI renders app-supplied `RemoteInput.setChoices()` as smart-reply
>      chips. Apps that target P or later get these, and they take precedence over assistant
>      suggestions. Free-text `RemoteInput` direct reply also works.
>    - OEM SystemUIs may differ *(unverified)*.
>    - Registry surface for Android: `maxQuickActions: 3`, `supportsTextInput: true`.
> 7. **BRAKE *can* register a `upi://pay` intent filter and appear in the payment-app chooser.**
>    Forwarding the intent to the user's real UPI app is technically feasible but is
>    *research/avoid*:
>    - It interposes BRAKE in a regulated payment flow.
>    - It changes the calling package that the PSP app sees.
>    - It risks "hijack" perceptions if the user ever picks "Always".
>    - *(Corrected 2026-10-04.)* Android 16's intent-redirection hardening (all apps on Android 16)
>      targets launching an untrusted **sub-level** intent taken from another intent's extras. The
>      docs do not say it blocks re-launching a received top-level `upi://` intent. Building a fresh
>      explicit intent from validated parameters is still the safer design, but it is good practice,
>      not something the hardening is documented to require.
>
>    Prefer post-spend NLS from UPI apps plus BRAKE's own QR scanner (another stream).
> 8. **The assistant/voice path is moving to AppFunctions.** AppFunctions (Android 16+) lets apps
>    expose MCP-like tools that agents such as Gemini can call. As of May 2026, Gemini integration is
>    in a private preview with trusted testers (page updated 2026-09-22). The caller permission
>    `EXECUTE_APP_FUNCTIONS` has protection level `normal`; access is gated by a runtime allowlist.
>    App Actions (Assistant built-in intents) is still documented as a current feature (page updated
>    2026-07-16, no deprecation notice). Calling it the "legacy" path is this stream's judgement, and
>    whether Gemini fulfils App Actions BIIs is *(unverified)*. Recommendation: *research* for "Hey
>    Gemini, ask BRAKE if I can afford this".
> 9. **Reliability needs explicit design.** NLS has:
>    - no history API (only `getActiveNotifications()` catch-up on reconnect);
>    - OEM background killing (dontkillmyapp's worst ranked: Huawei, Xiaomi, OnePlus, Samsung);
>    - no delivery during lockdown mode;
>    - no delivery from private-space apps while the space is locked (they are stopped);
>    - per-app listener filters the user can change;
>    - duplicate posts (bank app and SMS app for the same transaction; notification updates that
>      reuse the same key).
>
>    The adapter must deduplicate within the source, and fusion must expect gaps.
> 10. **Platform deadlines:**
>     - Play has required new apps and updates to target **API 36 (Android 16)** since 2026-08-31
>       (existing apps: API 35 to stay available to new users; an extension to 2026-11-01 can be
>       requested; target-sdk page updated 2026-10-01).
>     - Targeting API 37 later brings the standard-SMS OTP delay. The Play deadline for that is
>       expected around 2027-08 *(extrapolated, unverified)*.
>     - A Play SMS/Call Log policy revision announced 2026-07-15 takes effect 2027-01-27. The change
>       visible in the excerpts only removes phone-call account verification as a `READ_CALL_LOG` use;
>       the change list may not be complete *(Play excerpt; not re-verifiable in the 2026-10-04
>       fact-check: support.google.com blocked, only a secondary GitHub issue corroborates the date)*.

---

## Sources investigated

Each subsection uses the same template. "Observation" refers to `packages/core/src/model/observation.ts`
(kinds such as `money_movement`, `checkout`, `purchase_intent`, `app_context`, `mandate`,
`balance_snapshot`; reference types such as `rail_reference` and `merchant_reference`). Proposed
registry capability ids follow the namespacing in `packages/capabilities/src/types.ts`
(`os:notification-listener`, `os:sms-read`, …).

### 1. NotificationListenerService — `android-notification-listener`

**What it is.** A system-bound `Service`
(`android.service.notification.NotificationListenerService`, API 18+). The system calls it whenever
any app posts, updates or removes a notification.

- **Declaration.** The manifest declares the service with
  `android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"` (protection level
  `signature`, so only the system can bind) and the `android.service.notification.NotificationListenerService`
  action.
- **Granting access.** The user grants access in Settings → Notification access. Deep links:
  `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`, and from API 30
  `Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS` with
  `Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME`. Check the grant with
  `NotificationManager.isNotificationListenerAccessGranted(ComponentName)` (all verified in AOSP
  `Settings.java` / `NotificationManager.java`).
- **Callbacks.** `onListenerConnected()`, `onNotificationPosted(StatusBarNotification, RankingMap)`,
  `onNotificationRemoved(...)`, `onListenerDisconnected()`. Pull APIs: `getActiveNotifications()`
  and `getSnoozedNotifications()`. The AOSP javadoc says `requestRebind(ComponentName)` is "the
  *only*" method that is safe to call before `onListenerConnected()` or after
  `onListenerDisconnected()`.
- **Manifest filtering.** `android.service.notification.default_filter_types` and
  `disabled_filter_types` meta-data take `conversations|alerting|silent|ongoing`
  (`FLAG_FILTER_TYPE_CONVERSATIONS=1, ALERTING=2, SILENT=4, ONGOING=8`). From API 31,
  `migrateNotificationFilter(defaultTypes, disallowedPkgs)` lets the app pre-seed an OS-level
  **deny-list of packages**. It is ignored if the user has already set filters, and there is no
  allow-list API. The system enforces these filters per listener
  (`NotificationListenerFilter.isPackageAllowed` in `NotificationManagerService.isVisibleToListener`).

**Data actually available (per notification).**

| Field | API | Notes for BRAKE |
|---|---|---|
| Posting app | `sbn.getPackageName()`, `sbn.getOpPkg()`, `sbn.getUid()` | Identifies the source app (bank app, UPI app, `com.google.android.apps.messaging`, …). Primary allow-list key. |
| Post time | `sbn.getPostTime()` | Time the notification was posted or updated (epoch ms). |
| Event time | `Notification.when` | App-supplied; may be the transaction time, or simply equal to the post time. |
| Identity | `sbn.getKey()` = `userId|pkg|id|tag|uid` (AOSP), `getId()`, `getTag()` | Stable per notification *slot*. Updates reuse the key, so it is not unique per event. |
| User/profile | `sbn.getUser()` | Distinguishes main, work and private profiles. |
| Grouping | `sbn.getGroupKey()`, `Notification.getGroup()`, `FLAG_GROUP_SUMMARY` | Group summaries repeat child content and must be skipped. |
| Channel | `Notification.getChannelId()`; `Ranking.getChannel()` (NotificationChannel: id, name, importance) | Banks often separate "Transactions" from "Offers" channels, which makes channels a strong promo filter. |
| Category | `Notification.category` (`msg`, `promo`, `status`, `reminder`, …) | No transaction/payment category exists; `promo` is useful negative evidence. |
| Title | `extras["android.title"]` (`EXTRA_TITLE`), `android.title.big` | Often "₹1,249 debited" or the sender name. |
| Text | `extras["android.text"]` (`EXTRA_TEXT`) | One-line body (truncated by the app, not by the OS). |
| Big text | `extras["android.bigText"]` (`EXTRA_BIG_TEXT`) | Full alert body for BigTextStyle bank alerts. |
| Sub/info/summary | `android.subText`, `android.infoText`, `android.summaryText` | Sometimes holds the account label or masked card. |
| Inbox lines | `android.textLines` (`EXTRA_TEXT_LINES`) | InboxStyle: several alerts collapsed into one notification. |
| Messages | `android.messages` (`EXTRA_MESSAGES`), `android.messages.historic`, `android.conversationTitle` | MessagingStyle from SMS/RCS apps: one bundle per message with text, timestamp and sender. `MessagingStyle` keeps up to 25 messages (`MAXIMUM_RETAINED_MESSAGES = 25`). |
| Template | `android.template` | Style class name, used to choose the parser. |
| Actions | `Notification.actions[]` (title, PendingIntent, RemoteInputs) | Titles such as "View" or "Pay". BRAKE must never fire another app's PendingIntent. |
| Flags | `sbn.isOngoing()`, `isClearable()` | Ongoing usually means progress or a foreground service. "Payment processing" states sometimes show here. |
| Ranking | `RankingMap`: importance, channel, `isConversation`, … | `Ranking.hasSensitiveContent()` exists but is `@SystemApi`, so BRAKE cannot read it directly. |

**OTP and sensitive-content redaction (Android 15+).** Verified in the developer docs and AOSP
`NotificationManagerService`.

- The developer docs say: "Android will stop untrusted apps that implement a
  NotificationListenerService from reading unredacted content from notifications where an OTP has
  been detected. Trusted apps such as companion device manager associations are exempt."
- In AOSP, a listener is trusted if it holds `RECEIVE_SENSITIVE_NOTIFICATIONS`, is platform-signed,
  is allowed the matching app-op, or has a non-revoked CDM association. The developer reference
  gives that permission the protection level `signature|preinstalled|knownSigner|role` (public SDK
  36.1).
- The redacted copy that untrusted listeners receive:
  - the title is set to the posting app's label;
  - the text becomes "Sensitive notification content hidden";
  - the sub-text is removed;
  - every action title is blanked;
  - MessagingStyle and BigTextStyle bodies are replaced by the same placeholder (BigTextStyle
    redaction sits behind a separate AOSP bug-fix flag, `redact_sensitive_notifications_big_text_style`;
    whether it is on in every Android 15+ build is *(unverified)*);
  - `android.textLines` is removed;
  - system smart replies and actions are nulled.
- The "sensitive" flag comes from the system Notification Assistant
  (`Adjustment`/`Ranking.hasSensitiveContent`). Which classifier runs depends on the device
  (Pixel vs other OEMs), and its false-positive rate on bank debit alerts that contain long
  reference numbers is **unknown** (open question).

**Time windows and latency.**
- **POST-SPEND (primary).** Debit, credit and card-spend alerts from bank apps; "Paid ₹X to Y"
  from UPI apps; wallet tap-to-pay notifications *(Google Wallet behaviour unverified)*; and bank
  SMS/RCS shown by the messaging app. The callback fires as soon as the alert is posted.
  End-to-end latency is set by the issuer: SMS and push typically arrive within seconds to minutes
  *(no 2026 measurement found; unverified)*.
- **IN-SPEND (partial).** UPI *collect requests* ("₹X requested by merchant@psp"), "payment
  processing" ongoing notifications, and card-authentication OTP messages. The OTP messages are
  **redacted on Android 15+**, so only the fact that they arrived is visible.
- **PRE-SPEND (weak, ethically sensitive).** Shopping-app promotional pushes ("Sale ends tonight")
  and cart reminders. These could feed context ("temptation pressure") but are not needed for MVP.
- **Email notifications (example).** A Gmail notification exposes sender, subject and a snippet. An
  order-confirmation subject seen via NLS is a cheap POST-SPEND hint that avoids Gmail
  restricted-scope OAuth. It only works when the user's mail app notifies for that message.

**Coverage.**
- Every Android device on API 18+, in every country. Not available on iOS (no equivalent API).
- Per AOSP javadoc, listeners "cannot get notification access or be bound by the system on low-RAM
  devices running Android Q (and below)". That matters for old Android Go phones.
- "The system also ignores notification listeners running in a work profile". A device admin can
  restrict which listeners see work-profile notifications
  (`DevicePolicyManager.isNotificationListenerServicePermitted`).
- Reach in India is high because bank alerts are commonly sent by both SMS and app push. A recent
  Android share figure for India could not be verified in this session *(unverified)*. In the US,
  UK and EU, bank and card apps commonly offer real-time push alerts *(unverified for 2026; based on
  widely documented bank-app features)*.

**Access requirements.**
- **User grant.** The special-app-access toggle. No runtime dialog.
- **Android 13+ restricted settings.** If the APK was sideloaded through a non-store installer, the
  Notification access toggle is greyed out ("Restricted setting — For your security, this setting is
  currently unavailable.") until the user enables "Allow restricted settings" in App info. Strings
  were verified in AOSP Settings; the exact installer rules on Android 15–17 are *(unverified)*.
- **Google Play.** No NLS-specific declaration form was found *(unverified for 2026)*. The User Data
  policy's prominent-disclosure and consent rules, the Data safety form and the spyware/stalkerware
  rules apply *(Play pages blocked; general policy, unverified detail)*.
- **Cost.** None.

**Privacy and consent model.**
- The OS grant is all-or-nothing: BRAKE would receive every app's notifications, including chats,
  health and 2FA codes. Consent must therefore be layered:
  1. OS grant.
  2. A BRAKE allow-list chosen by the user, per source app ("HDFC Bank app", "Google Messages: bank
     senders only").
  3. Native-side filtering *before* any parsing or storage.
- The adapter's raw payload must never leave the device. Only allow-listed notifications are parsed,
  in memory, into a `RawSignal`. That signal carries the minimal fields: amount, merchant string,
  masked instrument, references and time, plus a short redacted excerpt with a TTL.
- `migrateNotificationFilter(types, disallowedPkgs)` can pre-deny known chat apps at OS level. Users
  can edit per-app listener filters in system settings (Android 12+; the setting exists in the
  platform, but the UI is OEM-dependent and *unverified*).
- Disconnecting the source means telling the user to revoke access in Settings. BRAKE cannot revoke
  its own access; it can call `requestUnbind()`. BRAKE should also purge the source's observations
  (ADR-002 already models this).

**Reliability and failure modes.**
- **OEM background killing.** The dontkillmyapp source repo ranks Huawei #1, Xiaomi #2, OnePlus #3,
  Samsung #4, Meizu #5, Asus #6, Oppo #8, Vivo #11, Realme #12 and Motorola #13 (severity "award"
  3–5; retrieved 2026-10-04; ranking date unknown). Mitigations:
  - an onboarding checklist per OEM (auto-start, battery "unrestricted");
  - a heartbeat that detects silence;
  - `requestRebind()` on app start;
  - `getActiveNotifications()` catch-up in `onListenerConnected()`.
- **No history.** Anything posted and dismissed while BRAKE was unbound is lost. There is no public
  notification-history API.
- **Lockdown mode.** NMS skips every listener for a user in lockdown (`isInLockDownMode`).
- **Private space (Android 15+).** "When a user locks the private space, all apps in the private
  space are stopped … including showing notifications." While the space is unlocked, AOSP's listener
  user-matching (`enabledAndUserMatches` → current profiles) suggests a main-profile listener *does*
  receive private-profile notifications. That is inferred from source only *(unverified on
  device)*.
- **Format drift.** Bank apps change wording, language (Hindi and regional scripts) and style
  (BigText ↔ Inbox ↔ MessagingStyle).
- **Duplicates.** Several sources notify for the same transaction (bank app, SMS app, UPI app), an
  app may update the same notification id, and group summaries repeat child content.
- **Hidden or partial content.** Some apps post only "You have a new transaction" with no amount.
- **User muting.** If the user turns a bank app's notifications off, nothing is posted, so NLS sees
  nothing.
- **False redaction.** If the OEM classifier tags a debit alert as OTP-bearing, BRAKE receives only
  the app label.

**Deduplication and reconciliation keys exposed.**
- Within the source: `sbn.getKey()` plus a hash of the normalized text, within a time window.
- Across sources, depending on the bank's text format *(formats illustrative, vary by bank)*:
  - UPI RRN/UTR, typically 12 digits ("UPI Ref No …");
  - bank "Txn ID";
  - card last-4 and account last-4 ("XX1234", "A/c *1234");
  - merchant name or VPA;
  - amount and currency;
  - available balance ("Avl Bal"), which allows a strong continuity check (prev − amount = new) and
    ordering;
  - for SMS seen via the messaging app: sender header ("AX-HDFCBK") and message timestamp.

**Normalized BRAKE observation.**
- `kind`:
  - `money_movement` for debits and credits;
  - `checkout` for a collect request or "processing";
  - `mandate` for AutoPay/e-mandate set-up or pre-debit notices;
  - `balance_snapshot` when a balance is present.
- `status`: `confirmed` for "debited/paid", `pending` for "processing/authorised", `cancelled` for
  "failed/declined/reversed".
- Amount and currency, each with parse confidence.
- `direction`.
- `merchant.raw`, plus `merchant.handle` (VPA) when present.
- `counterparty`: P2P names minimised or hashed.
- `instrument {type, issuer from the app or sender, last4}`.
- `references [{type: rail_reference, value: RRN, namespace: "upi"}]`.
- Timestamps: `postTime` as `timestamp_estimated`; an in-text time, if present, as
  `timestamp_confirmed`.
- `rail.family` inferred (`account_to_account_instant`/`upi`, `card`, …).
- **Confidence characteristics:**
  - A versioned template matched for a known app or sender: ≈0.85–0.95 on amount, ≈0.7–0.9 on
    merchant.
  - A generic heuristic parse: ≈0.5–0.7.
  - Promo-like text with no masked instrument: under 0.3, emitted only as negative evidence or
    dropped.
  - A redacted notification: no transaction observation; an optional `app_context` meta-observation
    ("sensitive notification from bank app at t").

**Provenance sentence.** "Detected from your HDFC Bank app notification at 10:41." /
"Detected from an SMS from AX-HDFCBK shown by your Messages app at 10:41."

**Recommendation: `mvp`.** It is the highest coverage-to-cost Android sensor. It needs no Play
declaration *(unverified)*, works across countries, banks and payment apps, and catches SMS and RCS
without SMS permission. Ship it with allow-list-first native filtering and on-device parsing.

---

### 2. SMS inbox and SMS broadcast (READ_SMS / RECEIVE_SMS) — `android-sms-read`

**What it is.**
- `RECEIVE_SMS` delivers `Telephony.Sms.Intents.SMS_RECEIVED_ACTION` broadcasts.
  `Telephony.Sms.Intents.getMessagesFromIntent()` turns them into `SmsMessage` objects with
  `getOriginatingAddress()`, `getMessageBody()` and `getTimestampMillis()`.
- `READ_SMS` allows querying the SMS provider (`Telephony.Sms.Inbox`; columns `address`, `body`,
  `date`, `date_sent`, `sub_id`, `thread_id`, `read`, `type`).
- The developer reference marks both as **"hard restricted"** permissions: the app cannot hold them
  "until the installer on record allowlists the permission" (`PackageInstaller.SessionParams.setWhitelistedRestrictedPermissions`).
  On Play, that allow-listing follows from policy approval *(mechanism unverified)*.

**Data available.**
- Sender address or header. Indian commercial senders appear as headers such as "AX-HDFCBK". TRAI
  header suffix conventions are *(unverified)*.
- Body text, service-centre timestamp, sent timestamp, SIM subscription id, and thread.
- **History**: whatever the user has not deleted, often months.

**Windows and latency.**
- **POST-SPEND:** debit and credit alerts, within seconds of SMS delivery.
- **PRE-SPEND:** recurring-payment *pre-debit notifications* ("AutoPay of ₹X will be debited on …").
  In India these are required for e-mandates. The RBI requirement could not be re-verified here
  *(unverified)*.
- **IN-SPEND:** OTP SMS ("OTP … for txn of INR 1,249 at AMAZON"). These are withheld for 3 hours
  from non-exempt SMS readers. SMS Retriever-hash messages were already delayed before Android 17;
  **Android 17** adds WebOTP-format messages regardless of target SDK, and standard OTP SMS when the
  app targets API 37 (Android 17 docs, updated 2026-10-01). During the delay
  `SMS_RECEIVED_ACTION` is withheld and provider queries are filtered. Exempt apps include the
  default SMS app, the "default SMS assistant app" and connected-device companion apps. BRAKE is
  none of these.

**Coverage.**
- India: very high; SMS alerts for card and electronic transactions are standard. The regulatory
  basis could not be re-checked on rbi.org.in *(unverified)*.
- Other markets: lower or unknown.
- **Gaps:** app-push-only alerts, and bank messages delivered over **RCS**. RCS messages are kept in
  the messaging app's own store, not the telephony SMS provider *(implementation detail,
  unverified)*.
- Android only.

**Access requirements.**
- **Play policy** *(Play excerpt; the page itself was blocked)*:
  - "Google Play restricts the use of high-risk or sensitive permissions, including SMS or Call Log
    permission groups."
  - Permitted uses are default SMS, default Phone or Assistant handler.
  - Outside those, "Google Play may provide a temporary exception … when the use of the permission
    enables core app functionality listed in the policy and there's currently no alternative
    method".
  - The exceptions table includes **"SMS-based money management — apps that track and manage
    budget"** with `READ_SMS`, `RECEIVE_MMS`, `RECEIVE_SMS` and `RECEIVE_WAP_PUSH`.
  - Apps "must declare any Call Log or SMS permissions directly through Google Play Console" using
    the Permissions Declaration Form. Apps without one "may be removed from Google Play".
  - Note: developer.android.com's default-handlers page links to Play Console Help
    `answer/9047303` (`#intended`, `#exceptions`) for this guidance, not `answer/10208820`. Which of
    the two URLs now holds the exceptions table could not be checked (both on the blocked host).
- **The developer docs** (`/guide/topics/permissions/default-handlers`, updated 2026-02-26) add:
  - Default handlers must provide a privacy policy.
  - The core functionality must be clear in the store listing.
  - The app "must ask to become a default handler before it requests the permissions associated
    with being that handler".
- **2026 policy cycle** *(Play excerpt)*:
  - Policy announcement 2026-07-15. Preview of "Use of SMS or Call Log permission groups"
    effective **2027-01-27**: phone-call account verification is no longer a permitted
    `READ_CALL_LOG` use; apps should use the Digital Credentials API or SMS Retriever instead.
  - No change to the money-management exception was visible in the excerpts. A secondary source
    (a public GitHub issue dated 2026-09-29) also states it is unchanged through the 2027-01-27
    revision *(secondary)*.
- **Review risk.** A developer post reports Play rejecting an expense tracker's SMS auto-import
  *(anecdotal, secondary)*. A strong application would have:
  - on-device-only processing;
  - a demo video;
  - SMS tracking featured in the store listing;
  - a Data safety declaration that matches behaviour;
  - full functionality when the permission is denied.
- **Default SMS app route.** This would make BRAKE a full SMS client that must send messages. Not
  appropriate.

**Privacy and consent.**
- The inbox holds personal conversations. Filter by sender header pattern and a known-bank header
  list on-device before parsing. Store no raw bodies.
- Make the backfill scope explicit ("scan the last 90 days of messages from banks"), run it once,
  and show what was found.
- If parsed data is transmitted, the Data safety form must declare "SMS or MMS" *(Play detail
  unverified)*.

**Reliability.**
- High delivery reliability; the broadcast is system-driven.
- Formats vary and drift. Promotional SMS mimic alerts. Multi-part SMS must be joined. Dual-SIM
  needs `sub_id`.
- Android 17 OTP delay. The classifier's false-positive behaviour on debit alerts is *(unknown)*.

**Dedup keys.** The same as NLS, plus `(sender header, date_sent, body hash)`. The **same SMS is
usually also seen by NLS** through the messaging app's notification. An exact body-hash match (after
whitespace normalisation) is a near-certain same-event link and should be resolved inside the
Android capture layer or as a deterministic fusion rule.

**Observation and confidence.** Same as NLS.
- Backfilled history gets `status: posted/confirmed` and no real-time flag.
- Confidence is slightly higher than NLS for SMS, because the body is complete (no app truncation)
  and the sender header is authoritative for the issuer.

**Provenance.** "Found in an SMS from AX-HDFCBK on 3 Oct (scanned with your permission)."

**Recommendation: `next`.** It is worth applying for the Play exception once NLS is live, mainly
for onboarding backfill and as a fallback when SMS-app notifications are muted. Do not make it an
MVP dependency, and do not ship a sideloaded variant to get it.

---

### 3. SMS Retriever / SMS User Consent APIs — `android-sms-retriever`

**What it is.** Google Play services APIs for **phone-number verification and OTP autofill**. The
developer page (`/identity/sms-retriever`, updated 2026-09-28) describes it as: "To automatically
verify phone numbers … call the SMS Retriever API to begin listening for an SMS message containing
a one-time code for your app."

- **SMS Retriever:** the message must contain the app's hash. It waits for one matching SMS until a
  **5-minute** timeout (verified on the page, 2026-10-04).
- **User Consent:** asks the user for each message, for a short listening window. Its window length
  and the code-format rules could not be fetched *(unverified)*.

**Data, windows and coverage.** One message that the app's own server sent or expects. **Not
applicable to third-party bank alerts.** Android 17 explicitly steers OTP readers to these APIs.

**Access.** Play services dependency (`play-services-auth-api-phone`); no SMS permission.

**Recommendation: `avoid`** for transaction sensing. It is the wrong purpose and has no coverage.
It is only relevant if BRAKE ever verifies a phone number.

---

### 4. Sideloaded / alternative distribution — `android-sideload-distribution`

**What it is.** Shipping an APK outside Play (website, alternative stores) to use SMS or
Accessibility without Play's policy review.

**Constraints as of 2026-10-04 (verified on developer.android.com).**
- **Restricted settings (Android 13+).** Sideloaded apps cannot be granted Notification access or
  Accessibility until the user finds App info → "Allow restricted settings" (AOSP Settings strings
  verified). Whether newer releases extend this to other installers is *(unverified)*.
- **Developer verification.**
  - August 2026: developer APIs, limited-distribution accounts (students and hobbyists, up to 20
    devices) and an "advanced flow" for power users.
  - **2026-09-30:** "Protections begin for all users who install apps from participating stores in
    Brazil, Indonesia, Singapore, and Thailand on certified devices running Android 7+." The
    participating stores (developer-verification guides, updated 2026-08-18) are Google Play,
    HONOR App Market, OPPO App Market, Samsung Galaxy Store, Transsion Palm Store, vivo V-Appstore
    and Xiaomi GetApps. *(Quote corrected 2026-10-04; the earlier wording was a paraphrase.)*
  - The FAQ says direct sideloads and non-participating stores are **not yet** affected.
  - Global expansion in **2027**.
  - The advanced flow requires developer mode, a "not being coached" confirmation, a restart and
    re-authentication, and a "one-time, one-day wait" before biometric/PIN confirmation (FAQ entry
    updated 2026-03-23). The "unverified developer" warning shown afterwards is *(unverified)*. ADB
    installs are exempt.
- **Android 16 Advanced Protection Mode** blocks app sideloading for users who enable it.
- **Play Protect.** Play Protect "recommends a real-time app scan when installing apps that haven't
  been scanned before" (developer.android.com fraud page). Reports that Play Protect's
  *enhanced fraud protection* blocks internet-sideloaded apps requesting `RECEIVE_SMS`, `READ_SMS`,
  `BIND_NOTIFICATION_LISTENER_SERVICE` or `BIND_ACCESSIBILITY_SERVICE` in India and SE Asia could
  not be verified *(unverified)*.

**Privacy and trust.** Asking mainstream users to sideload a finance app that reads SMS is the
same pattern banking malware uses. It would undermine BRAKE's trust position.

**Recommendation: `avoid`** as a distribution strategy for MVP. It could be `research` for a
consenting power-user or beta channel via the limited-distribution account, but never as the way
to bypass Play SMS review.

---

### 5. App-open signals: UsageStatsManager — `android-usage-stats`

**What it is.** `android.app.usage.UsageStatsManager` gives access to device usage history.
- Most methods need `android.permission.PACKAGE_USAGE_STATS`, protection level
  `signature|privileged|development|appop|retailDemo`. The reference says: "declaring the permission
  implies intention to use the API and the user of the device still needs to grant permission
  through the Settings application" (`Settings.ACTION_USAGE_ACCESS_SETTINGS`).
- Methods that return only the caller's own data need no permission.

**Data available.**
- `queryEvents(begin, end)` returns `UsageEvents.Event`: package name, class name, event type (for
  example activity resumed/paused, screen interactive), timestamp.
- From API 35, `queryEvents(UsageEventsQuery)` adds filtered queries, plus `EXTRA_EVENT_CATEGORY` and
  `EXTRA_EVENT_ACTION`.
- `queryUsageStats` / `queryAndAggregateUsageStats` return daily, weekly, monthly or yearly
  aggregates: total time in foreground and last time used.
- **Limits** (verbatim from the reference):
  - "Events are only kept by the system for a few days."
  - "Starting from Android R, if the user's device is not in an unlocked state … then null will be
    returned."
- The newer `queryAppUsageDuration()` ("Added in version 37.2", 30-day window) requires
  `QUERY_APP_USAGE` with protection `internal|role`, so it is **not available to BRAKE**.

**Windows and latency.**
- PRE-SPEND context: "opened a shopping or food app at 23:40", session length, and the
  shopping-app → payment-app sequence.
- There is no public push callback, so BRAKE must poll. Polling every few seconds needs a running
  foreground service, which costs battery and needs an FGS-type justification such as `specialUse`
  with Play review. Periodic WorkManager is limited to a 15-minute minimum, so it can only be used
  for after-the-fact context. BRAKE **cannot block or shield** the opened app; Android has no
  equivalent of iOS ManagedSettings.

**Coverage.** All Android versions BRAKE targets.
- Mapping packages to labels needs package visibility on Android 11+: declare
  `<queries><package …/></queries>` for a curated shopping-app list, or use `QUERY_ALL_PACKAGES`,
  which requires a Play declaration.

**Access.** A user-granted app-op. No Play declaration specific to `PACKAGE_USAGE_STATS` was found
*(unverified)*; Data safety disclosure for "app interactions" applies *(unverified detail)*.

**Privacy.** High. It is a full app-usage timeline. Collect only events for packages on the user's
"apps I want help with" list, keep them local, and aggregate quickly.

**Reliability.** Medium. Polling gaps, OEM process killing, and the data is unavailable while
locked.

**Dedup keys.** None financial. It provides temporal context for fusion, such as a payment app
opened 30 s before a debit alert.

**Observation.** `kind: app_context` (never a transaction), `window: pre_spend`, `merchant.key` if
the app maps to a merchant, `confidence` high for the fact itself.

**Provenance.** "You opened Myntra at 23:40 (from Android usage access)."

**Recommendation: `research` / `later`.** It is useful for the "late-night e-commerce is often
regretted" learning and for opt-in "remind me of my goal when I open X" nudges. Those nudges would
be a notification, not a block. The privacy cost and polling complexity rule it out for MVP.

---

### 6. AccessibilityService — `android-accessibility-service`

**What it is.** A service (`BIND_ACCESSIBILITY_SERVICE`, signature) that receives `AccessibilityEvent`s
and can read on-screen `AccessibilityNodeInfo` trees and perform actions.
`AccessibilityServiceInfo.isAccessibilityTool()` (API 31) "Indicates if the service is used to
assist users with disabilities."

**Data.** Window changes (real-time foreground-app detection), on-screen text (cart totals,
checkout amounts, UPI confirmation screens). Technically the strongest IN-SPEND sensor on Android.

**Policy.**
- Google Play's Accessibility API policy allows non-accessibility apps only with prominent
  disclosure, consent and a Play Console declaration. It prohibits deceptive or
  privacy-circumventing use. Apps that set `isAccessibilityTool` must genuinely serve users with
  disabilities. These are general policy terms; the Play pages were blocked, so the 2026 text is
  *(unverified)*.
- Android 13+ restricted settings apply to sideloaded apps.
- Android 16 Advanced Protection lists "additional custom mitigations"; the specific accessibility
  restrictions are *(unverified)*.
- Many banking and UPI apps use `FLAG_SECURE` or overlay hiding and treat active accessibility
  services as a fraud signal *(unverified per app)*.

**Privacy and ethics.** Very high sensitivity. Reading other apps' screens to infer spending is
exactly the "invasive surveillance" the brief rules out. It would also make BRAKE look like banking
malware.

**Recommendation: `avoid`.**

---

### 7. Overlays (`SYSTEM_ALERT_WINDOW`) — `android-overlay-window`

**What it is.** `TYPE_APPLICATION_OVERLAY` windows drawn over other apps.
- Permission: `SYSTEM_ALERT_WINDOW` (`signature|setup|appop|installer|pre23|development`), granted
  via `Settings.ACTION_MANAGE_OVERLAY_PERMISSION`. The reference says: "Very few apps should use this
  permission".
- Holding it also exempts an app from background-activity-launch restrictions ("The app has the
  SYSTEM_ALERT_WINDOW permission granted by the user").

**Restrictions.**
- Android 12 blocks "untrusted touches" that pass through overlays from another UID (all apps on
  Android 12+). SAW overlays whose combined opacity is ≤ 0.8 are exempt. This affects pass-through
  overlays; a touchable BRAKE bubble would still get its own touches.
- Apps on Android 12+ can call `Window.setHideOverlayWindows(true)` to hide non-system overlays.
  Payment apps are likely to do this on sensitive screens *(per-app unverified)*.
- Android 15 (target 35): holding SAW no longer allows a background FGS start unless a
  `TYPE_APPLICATION_OVERLAY` window is **visible**.
- Android 17 continues to harden background activity launch (BAL), extending it to
  `IntentSender`.

**Windows.** In principle IN-SPEND (a "pause" bubble over a checkout). In practice it is fragile,
hostile to payment apps, and reads as a dark pattern.

**Recommendation: `avoid`** for interception. A user-started "cooling-off" timer is better served
by a Live Update notification (section 15).

---

### 8. Share target (`ACTION_SEND`) — `android-share-intent`

**What it is.** An activity intent filter for `android.intent.action.SEND` (and `SEND_MULTIPLE`)
with MIME types `text/plain` and `image/*`. BRAKE then appears in the system share sheet. Sharing
shortcuts / Direct Share targets can deep-link to "Ask BRAKE".

**Data.** `Intent.EXTRA_TEXT` (product URL, title, price text), `EXTRA_SUBJECT`, and
`EXTRA_STREAM` (screenshot or image URI with a temporary read grant).

**Windows.** PRE-SPEND (a product being considered) and POST-SPEND (sharing a receipt or
confirmation screenshot). Latency: immediate, user-initiated.

**Coverage.** All Android, all countries. No permission.

**Privacy.** Low. User-initiated, explicit content.

**Reliability.** High. Content quality depends on the source app; some share only a URL.

**Dedup keys.** Product URL or merchant domain, product id in the URL, and the price string.

**Observation.** `kind: purchase_intent`, `status: intent`, amount if a price is parsed (≈0.6–0.9),
`merchant.website`, `window: pre_spend`. A shared receipt image becomes a `receipt` observation
through the OCR stream.

**Provenance.** "You shared this from Amazon at 21:14."

**Recommendation: `mvp`.**

---

### 9. Text-selection action (`ACTION_PROCESS_TEXT`) — `android-process-text`

**What it is.** An activity filtering `android.intent.action.PROCESS_TEXT` (`text/plain`) shows
"Ask BRAKE" in the text-selection toolbar of any app. Input: `EXTRA_PROCESS_TEXT`, and
`EXTRA_PROCESS_TEXT_READONLY` (verified in AOSP `Intent.java`; API 23).

**Data.** Only the selected text (a price or product name).

**Windows.** PRE-SPEND; immediate. **Privacy:** low; explicit. **Reliability:** high where apps use
standard text views; some apps block selection.

**Observation.** `purchase_intent` carrying a price/description and lower merchant confidence
(no URL).

**Provenance.** "From text you selected in Chrome."

**Recommendation: `mvp`.** Near-zero cost alongside the share target.

---

### 10. Clipboard — `android-clipboard`

**Platform rules (verified).**
- Android 10+: "Unless your app is the default input method editor (IME) or is the app that
  currently has focus, your app cannot access clipboard data."
- Android 12+: "the system usually shows a toast message when your app calls `getPrimaryClip()`"
  ("APP pasted from your clipboard"). There is no toast when the app reads only metadata via
  `getPrimaryClipDescription()`.
- Android 13+: a standard copy confirmation. Source apps can set `ClipDescription.EXTRA_IS_SENSITIVE`.

**Use for BRAKE.** When the user opens the "Should I buy this?" screen, BRAKE may check
`getPrimaryClipDescription()` for a URL or text MIME type (no toast) and offer a **"Paste copied
link"** chip. It reads the clip only on tap. No background reading is possible or desirable.

**Windows.** PRE-SPEND. **Privacy:** low if read only on tap. **Recommendation: `mvp`**, limited to
explicit paste. Background clipboard monitoring is unavailable and out of scope.

---

### 11. App Widgets — `android-app-widget`

**What it is.** Home-screen `AppWidgetProvider` built with `RemoteViews`, or Glance. RemoteViews
supports `Button`, `ImageButton`, `TextView`, `ListView`/`GridView`/`StackView` and others, and
since API 31 `CheckBox`, `RadioButton`, `RadioGroup` and `Switch`. "Descendants of these classes are
not supported". **There is no `EditText`**, so a price-entry box must open an activity. Android 15
added generated previews (`AppWidgetManager.setWidgetPreview`). For apps targeting Android 17
(API 37), the bitmaps and icons in a RemoteViews parcel may use at most 1.5 × screen width × screen
height × 4 bytes in total. Going over throws a fatal `IllegalArgumentException` (verified
2026-10-04).

**Roles.**
- An *output surface*: discretionary pace, goal progress, "last transaction — tap to label".
- An *input trigger*: an "Ask before I buy" button; a launch from the launcher or a widget counts
  as a background-activity-start exception.
- The label buttons produce user assertions; the widget generates no transaction data itself.

**Windows.** PRE-SPEND (a quick check entry) and POST-SPEND (glance and labelling). Updates are
batched (system-limited) *(exact update limits not re-verified)*.

**Recommendation: `mvp`.** Low cost, high visibility, no sensitive permission.

---

### 12. Quick Settings tile — `android-quick-settings-tile`

**What it is.** A `TileService`.
- Android 13+ `StatusBarManager.requestAddTileService(component, label, icon, executor, callback)`
  prompts the user to add the tile. The docs: "We recommend calling `requestAddTileService()` only in
  context". The system may stop processing requests that were denied "enough times".
- `onClick()` can show a dialog or call `startActivityAndCollapse()`. Use the `PendingIntent`
  overload (API 34). The `Intent` overload was deprecated in API 34 and throws
  `UnsupportedOperationException` on Android 14+ (verified in the TileService reference, 2026-10-04).
- Use `isSecure()` / `unlockAndRun()` for sensitive actions. Active mode uses
  `META_DATA_ACTIVE_TILE`.

**Windows.** PRE-SPEND: a one-swipe "Should I buy this?" or "Start a 10-minute pause". **Privacy:**
none. **Recommendation: `next`.**

---

### 13. Notification actions and RemoteInput (one-tap labelling) — `android-notification-actions`

**What it is.** BRAKE's own notifications carrying `Notification.Action`s and `RemoteInput`.

**Limits (verified).**
- Docs: "A notification can offer up to three action buttons". AOSP: `Notification.MAX_ACTION_BUTTONS = 3`
  ("generic" actions; contextual actions are handled separately).
- Direct reply (`RemoteInput`) since Android 7.0; read the result with `RemoteInput.getResultsFromIntent()`.
- **App-provided choices.** AOSP `SmartReplyStateInflater` shows `RemoteInput.getChoices()` as
  smart-reply chips. This applies only to apps targeting P+ (when `requiresTargetingP` is set) and
  only when the smart-suggestion feature is enabled. "If the app provides any smart replies, we don't
  show any replies or actions generated by the NotificationAssistantService". So BRAKE can show **3
  buttons plus a row of category chips**. The chip count is limited by row width. OEM SystemUIs
  (One UI, HyperOS) may render this differently *(unverified)*.
- **Wear OS.** Phone notifications are bridged to paired watches by default
  (`/training/wearables/notifications/bridger`, updated 2026-09-22). That page does **not** say
  whether action buttons and `RemoteInput` choices work on the watch, so that part is
  *(unverified)*.
- **Android 12+ trampoline rule.** Tapping a notification must not start an activity indirectly
  through a service or receiver. Label actions should go to a `BroadcastReceiver` that does **not**
  open UI. "Other…" should be a direct activity `PendingIntent`.
- **Android 13+.** Posting requires the `POST_NOTIFICATIONS` runtime permission.

**Design.**
- Example: "Amazon ₹1,249 · Looks like Shopping": [Shopping] [Household] [Other…], with chips for
  the next 3–5 predictions.
- Free-text RemoteInput ("note") for "what was this?".
- Retrospective "still happy?" prompts can use the same mechanism with three buttons.

**Signal value.** Each tap is a `UserAssertion` anchored to observation ids (ADR-002). This is a
surface rather than a sensor, but it is BRAKE's main Android labelling input.

**Registry facts.** `PlatformProfile(android).surface = { maxQuickActions: 3, supportsTextInput: true }`,
plus a proposed capability `os:notification-choice-chips` with status `limited` (OEM-dependent).

**Recommendation: `mvp`.**

---

### 14. RCS and business messages (via the messaging app) — `rcs-business-messaging`

**What it is.** Banks and merchants increasingly send alerts as RCS business messages. There is no
public Android API that lets a third-party app read RCS. Such messages are visible to BRAKE **only**
through NLS on the messaging app's notification (MessagingStyle). Whether bank alerts in a
particular market have moved to RCS is *(unverified)*.

**Recommendation: `research`.** Treat it as part of `android-notification-listener`; the
`READ_SMS` path cannot cover it.

---

### 15. Live Updates (promoted ongoing notifications) — `android-live-updates`

**What it is.** Android 16+ promoted notifications: status-bar chip, lock screen.
- Requirements (live-update page, updated 2026-10-01): `POST_PROMOTED_NOTIFICATIONS` (added in API
  36.1, protection `normal|appops`, in addition to `POST_NOTIFICATIONS`), `setRequestPromotedOngoing`
  / `EXTRA_REQUEST_PROMOTED_ONGOING`, ongoing (`FLAG_ONGOING_EVENT`), a content title, no custom
  content view, not a group summary, not colorized, a channel that is not `IMPORTANCE_MIN`, and a
  standard, BigText, Call, Progress or Metric style. *(Corrected 2026-10-04: the earlier list missed
  `MetricStyle`, the group-summary rule and the channel-importance rule.)*
- Usage criteria are "ongoing, user-initiated, and time-sensitive". Inappropriate uses include
  ads and promotions, chat messages, "alerts", upcoming calendar events and "quick access to app
  features".
- OEMs can add criteria. Android 17 adds semantic colouring and `Notification.Metric`.

**BRAKE use.** Only a **user-started cooling-off timer** ("Wait 10 min before buying" → countdown
chip → "Still want it?"). That is plausibly compliant. A budget meter or a post-spend alert is not.

**Windows.** PRE-SPEND/IN-SPEND as an *intervention surface*, not a sensor.

**Recommendation: `research`** (check eligibility with Play and OEMs).

---

### 16. Assistant integrations: App Actions, AppFunctions, Gemini — `android-appfunctions`

**AppFunctions** (developer.android.com/ai/appfunctions):
- "an Android platform API with an accompanying Jetpack library to simplify Android MCP
  integration". Apps expose functions (`@AppFunction`) that callers holding
  `EXECUTE_APP_FUNCTIONS` (agents, assistants like Gemini) can discover and execute.
- "available on devices running Android 16 or higher". "As of May 2026, AppFunctions integration
  with Gemini is in a private preview with trusted testers." The API is experimental (page updated
  2026-09-22).
- `EXECUTE_APP_FUNCTIONS` (API 36) has protection level `normal`. The reference says "allowlist
  checks for AppFunctions API access are enforced at runtime", so which agents can call BRAKE is
  decided by a platform allowlist, not by the permission alone.

**App Actions** (Assistant built-in intents) remain documented as a current feature (page updated
2026-07-16, no deprecation or Gemini notice on the page). That the phone assistant "has largely moved
to Gemini" is *(unverified in this session)*, and so is whether Gemini fulfils App Actions BIIs.

**BRAKE use.** Voice or agent "Should I buy X for ₹Y?" → `checkPurchase(item, price)` returning
goal/budget impact. Also `logPurchase(amount, merchant)` as manual entry.

**Windows.** PRE-SPEND and POST-SPEND (manual). **Privacy:** low (user-initiated), but anything
returned to the agent leaves BRAKE's control. Return minimal, summarised answers.

**Recommendation: `research`.** Prototype once AppFunctions is generally available.

---

### 17. `upi://` intent handling and payment deep links — `upi-intent-url` (Android mechanics)

**What it is.** Merchant apps and websites start UPI payments with an implicit
`Intent(ACTION_VIEW, Uri.parse("upi://pay?..."))`. The parameters (`pa`, `pn`, `am`, `cu`, `tr`,
`tn`, `mc`, `url`, `mode`, `sign`, …) are defined by NPCI's UPI Linking Specification; npci.org.in
was blocked, so they are *(not re-verified in this session)*.
- Any app can declare `<intent-filter><action VIEW/><category DEFAULT/><category BROWSABLE/><data android:scheme="upi"/></intent-filter>`
  and appear in the disambiguation chooser. Android has no restriction on this scheme.
- **Forwarding.** BRAKE would build a **new** explicit intent to the user's chosen UPI app and use
  `startActivityForResult` to pass the result back.
  - Android 16's intent-redirection protection (all apps on Android 16) targets apps that launch an
    "untrusted sub-level intent" taken from another intent's **extras**. *(Corrected 2026-10-04.)*
    Forwarding the received top-level `upi://` intent is not what the documentation describes, so
    whether the hardening affects it is *(unverified)*. Building a fresh explicit intent from
    validated `pa`/`am`/`tr` values is still recommended, because it limits what BRAKE passes on.
  - Package visibility (Android 11+) requires `<queries><intent><action VIEW/><data scheme="upi"/></intent></queries>`
    to list UPI apps.
  - An app that calls `startActivityForResult` into BRAKE automatically becomes visible to BRAKE.

**Data.** Payee VPA and name, amount, currency, merchant code (MCC), transaction reference (`tr`),
and note — **before** payment. The result ("response" extras with txnId, responseCode, Status,
txnRef) is defined by NPCI *(unverified)*. This is the richest IN-SPEND signal in India, and
BRAKE could add a confidence-bounded nudge before handing over.

**Coverage and limits.**
- India only.
- BRAKE appears only when the merchant uses an implicit intent; many merchant SDKs target a specific
  package via `setPackage` or their own picker *(unverified share)*.
- If the user taps "Always", BRAKE silently becomes the default handler. That is a trust and
  "hijack" risk.
- The PSP app sees **BRAKE** as the caller instead of the merchant. Possible effects on merchant
  verification and signed intents (`sign`), and on PSP fraud heuristics, are *(unknown)*.
- NPCI or PSP rules for apps that sit in between are *(unknown)*.

**Recommendation: `research`** (with legal/NPCI review), leaning `avoid` for MVP. Safer
alternatives for the same moment:
- BRAKE's own QR scanner, which parses the `upi://` payload and then hands off to the UPI app
  (another stream);
- post-spend NLS from UPI apps.

---

### 18. Digital Wellbeing / screen-time APIs — `android-digital-wellbeing`

**What it is.** Android's Digital Wellbeing app timers, Focus mode and bedtime have **no
third-party API** *(none found in developer docs)*.
- The public pieces are `UsageStatsManager` (section 5) and `Settings.ACTION_APP_USAGE_SETTINGS`
  ("Show screen for controlling app usage properties for an app"). An app can expose that settings
  screen so the system's usage dashboard can link to it.
- The new `queryAppUsageDuration` requires `QUERY_APP_USAGE` (`internal|role`).
- There is nothing like iOS FamilyControls/ManagedSettings app shielding for third parties.

**Recommendation: `avoid`** (unavailable). Record `os:screen-time-shield = unavailable` for Android
in the registry.

---

### 19. Android 15+ private space (platform constraint) — `android-private-space`

**Facts (verified, Android 15 behaviour changes).**
- Private space is a separate user profile. "When a user locks the private space, all apps in the
  private space are stopped, and those apps can't perform foreground or background activities,
  including showing notifications."
- "apps can't determine whether or not they're being used in the private space".
- Only the default launcher holding `ACCESS_HIDDEN_PROFILES` can list private-space apps.

**Impact.**
- A user who keeps a bank or UPI app in private space produces **no** notifications while it is
  locked. When it unlocks, notifications appear late.
- BRAKE installed *inside* private space would be stopped while locked.
- From AOSP source, main-profile listeners appear to receive private-profile notifications while
  the space is unlocked *(inferred, unverified on device)*.
- Usage stats for private-space apps are likely invisible to the main profile *(unverified)*.

**Recommendation.** Not a source. Record it as a degradation fact and show a provenance caveat
("Some apps in your private space can't be observed while it's locked").

---

### 20. Wear OS — `wear-os-surfaces`

**What it is.**
- Phone notifications are "bridged" to the watch by default (`BridgingManager`, `setBridgeTag`;
  verified 2026-10-04). BRAKE's labelling notifications therefore appear on the watch at no extra
  cost. Whether their action buttons and RemoteInput choices are usable there is not stated on the
  bridging page *(unverified)*.
- A Wear OS app could add a Tile or complication (for example "discretionary left this week").
- A watch app cannot read other apps' phone notifications.
- Tap-to-pay on the watch produces phone-side notifications only if the wallet or bank app posts
  them *(unverified)*.

**Windows.** PRE-SPEND glance; POST-SPEND labelling. **Recommendation: `later`.** Bridging is free;
a dedicated watch app is not a priority.

---

### 21. Default SMS handler role and companion-device association — `android-default-sms-role` / `android-companion-device-association`

- **Default SMS role** (`RoleManager.ROLE_SMS`). It would give full SMS access and exempt BRAKE
  from the Android 17 OTP delay. In return BRAKE would have to be the user's complete SMS client
  ("must be able to send text messages"). **`avoid`.**
- **CDM association.** It makes a listener "trusted" and so bypasses OTP redaction, and it is
  exempt from SMS OTP delay. It is intended for genuine companion devices (watches and similar).
  Using it to get around redaction would be policy abuse. **`avoid`.**

---

### 22. AutofillService (added by the 2026-10-04 fact-check) — `android-autofill-service`

**What it is.** A service bound with `BIND_AUTOFILL_SERVICE` that the user picks in system settings
(apps can prompt with `Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE`). When the user focuses a field
in another app, the system calls `onFillRequest()` with an `AssistStructure` holding that app's view
hierarchy. On checkout screens this would show cart, amount and card fields, which made it a
candidate IN-SPEND sensor that the original stream left out.

**Why `avoid`.**
- The developer guide says: "Autofill services must not use information for purposes other than
  providing suggestions" (autofill-services guide, updated 2026-10-01). Using it as a spending
  sensor would break that rule.
- The user has one active autofill service, normally their password manager. Asking them to swap it
  for BRAKE is unrealistic *(single-service behaviour from general platform knowledge; not
  re-quoted in this session)*.
- It is the same kind of screen-content surveillance the brief rules out.

**Recommendation: `avoid`.** Record it in the registry as considered and rejected.

---

### 23. Screenshot detection API (Android 14+) (added by the 2026-10-04 fact-check) — `android-screenshot-detection`

**What it is.** `Activity.registerScreenCaptureCallback()` with the install-time
`DETECT_SCREEN_CAPTURE` permission. The callback fires only when the user takes a screenshot (with
the hardware-button combination) **while that app's own activity is visible**. It "doesn't provide an
image of the actual screenshot" (Android 14 screenshot-detection page, updated 2026-10-01).

**Relevance to the brief's "screenshot detection initiated by user".** BRAKE cannot detect
screenshots taken in shopping or payment apps. The workable route is still the user *sharing* the
screenshot to BRAKE (section 8). **Recommendation: `avoid`** as a sensor (unavailable for third-party
screens). Registry: `os:screenshot-detection-third-party = unavailable`.

---

## Three-window classification

| Source | Pre-spend | In-spend | Post-spend | Latency | Notes |
|---|---|---|---|---|---|
| `android-notification-listener` | weak (shopping promos/cart reminders; ethically sensitive) | partial (UPI collect requests, "processing"; OTP alerts **redacted** on 15+) | **strong** (bank/card/UPI/wallet push, SMS and RCS via the messaging app) | Callback on post; overall seconds–minutes after payment (issuer-dependent) | MVP. Allow-list first, on-device parse, no history, OEM-kill mitigation |
| `android-sms-read` | pre-debit mandate notices (recurring) | OTP SMS **delayed 3 h** on Android 17 | **strong** (India), plus **backfill** | Seconds (broadcast); backfill instant | Play "SMS-based money management" declaration; next |
| `android-sms-retriever` | – | – | – | – | OTP verification only; avoid |
| `android-sideload-distribution` | – | – | – | – | Restricted settings, developer verification 2026–27, AAPM; avoid |
| `android-usage-stats` | context (app opened) | context (payment app foregrounded) | – | Polling-bound (seconds with FGS, ≥15 min WorkManager) | Null while locked; events kept "a few days"; research/later |
| `android-accessibility-service` | technically strong | technically strong | – | Real-time | Policy and ethics: avoid |
| `android-overlay-window` | – | intervention only | – | – | Untrusted-touch blocking, payment apps hide overlays; avoid |
| `android-share-intent` | **strong** (user-initiated) | – | receipts/screenshots | Immediate | MVP |
| `android-process-text` | good | – | – | Immediate | MVP |
| `android-clipboard` | good (on-tap paste only) | – | – | Immediate | No background read (Android 10+); toast (Android 12+) |
| `android-app-widget` | entry point | – | glance and label surface | Immediate (tap) | No text input in RemoteViews |
| `android-quick-settings-tile` | entry point | – | – | Immediate | Android 13+ add prompt |
| `android-notification-actions` | – | – | labelling surface | Immediate | 3 buttons plus choice chips |
| `rcs-business-messaging` | – | – | via NLS only | As NLS | No direct API |
| `android-live-updates` | cooling-off timer | cooling-off timer | – | Immediate | Must be user-initiated |
| `android-appfunctions` | voice/agent check | – | voice logging | Immediate | Private preview with Gemini (May 2026) |
| `upi-intent-url` (chooser) | – | **strong** (payee, amount, `tr` before payment) | result code | Immediate | Interposition risk; research |
| `android-digital-wellbeing` | – | – | – | – | No API |
| `android-private-space` | – | – | – | – | Degradation fact |
| `wear-os-surfaces` | glance | – | labelling (bridged; action usability on watch unverified) | Immediate | Later |
| `android-autofill-service` | – | technically strong (checkout view tree) | – | Real-time | Guide forbids non-suggestion use; avoid |
| `android-screenshot-detection` | – | – | – | – | Own activity only, no image; avoid |

---

## Implications for BRAKE architecture

### Android capture module (Kotlin, outside this repo) → `RawSignal` envelope

1. **Gate before parse (ADR-004).**
   - The `NotificationListenerService` callback runs a native allow-list check on
     `(packageName, channelId, sender/conversationTitle)` first.
   - Non-allow-listed notifications are dropped in memory: no logging, no counting by content.
   - Only allow-listed ones become `RawSignal { adapterId: "android-notification", connectionId, receivedAt, payload }`.
   - The payload holds the selected extras (`android.title`, `android.text`, `android.bigText`,
     `android.textLines`, latest `android.messages` entry), `postTime`, `when`, `key`, `channelId`
     and `category`. The `RawSignal` is consumed by the pure TS adapter and then discarded.
2. **Redaction detection.** If the text equals the localized "Sensitive notification content
   hidden" and the title equals the app label, the capture layer **emits no transaction payload**.
   At most it emits a `sensitive_notification` meta-event (package and time). Fusion may use this as
   weak IN-SPEND timing evidence ("a bank OTP arrived at 10:40:55").
   - The localized string comes from the framework resource `redacted_notification_message`. Match
     it per locale, or use the structural signature: actions present but every title empty, and the
     title equal to the app label.
3. **OTP drop.** Even below Android 15, the adapter must strip OTP-like tokens before any field
   leaves the parser (`overview.md` already says "OTPs dropped").
4. **Within-source dedup.**
   - Key: `(sbn.key, normalizedTextHash)` over a 10-minute window, which absorbs app updates and
     reposts.
   - Skip `FLAG_GROUP_SUMMARY`.
   - For MessagingStyle, parse only messages whose timestamp is newer than the last one seen for
     that conversation. These notifications carry the *whole recent thread* (up to 25 messages), so
     re-parsing would duplicate old alerts.
5. **SMS and NLS double-sighting.** When both the SMS adapter and NLS are connected, the same bank
   SMS arrives twice: a broadcast, then the messaging app's notification. Use a deterministic link
   rule — same sender header or title, identical normalized body, |Δt| < 2 min — so fusion does not
   treat them as independent corroboration. They are one origin, which matters for the
   Fellegi–Sunter independence assumption.
6. **Catch-up and health.**
   - On `onListenerConnected()`, read `getActiveNotifications()` and run it through the same dedup.
   - Track the "last allow-listed notification seen" per app. If the user usually gets alerts but
     none have arrived for N days, show an OEM-specific battery checklist instead of guessing.
7. **Per-source consent receipts.** Record separately:
   - the OS grant (NLS on/off, from `isNotificationListenerAccessGranted`);
   - BRAKE's per-app allow-list;
   - the SMS backfill scope (date range, sender list).

   Disconnecting a bank app from the allow-list purges its observations (ADR-002).

### Normalization pitfalls (adapter layer)

- **Indian digit grouping and currency tokens:** "Rs.1,24,999.00", "INR 1,249", "₹1249",
  "Rs 1,249/-". Strip lakh/crore grouping before parsing.
- **Verbs and status.** "debited/spent/paid/sent/withdrawn" mean `debit`; "credited/received/refund"
  mean `credit`. "will be debited on" is a future `mandate`, not a `money_movement`.
  "failed/declined/reversed" mean `cancelled` or reversal. "blocked/on hold" mean `pending`.
- **"Avl Bal" vs "Avl Lmt".** Card alerts report the available *credit limit*, not a balance, so
  never emit `balance_snapshot` for "Avl Lmt".
- **Masked identifiers:** "XX1234", "**1234", "A/c no. XXXXXX1234", "Card ending 1234". Keep last-4
  only (core rule).
- **Who the counterparty is.** Merchant vs P2P: "to merchant@ybl" or "to RAHUL K" (a VPA-like
  handle is not proof of a merchant). Own-account transfers ("to your A/c XX9876") feed
  `TransferKind.own_account`.
- **Time.** Use `postTime` (device clock) as the estimate. Prefer an in-text date or time when
  present (often DD-MM-YY or DD-Mon-YY, IST). SMS `date_sent` is SMSC time. Old notifications
  re-posted after reboot keep their original `when` but get a new `postTime`.
- **Promotions.**
  - The channel name, `category == "promo"`, `Ranking` importance and the absence of a masked
    instrument are strong negative features.
  - UPI apps send "cashback" and "you won ₹10" notifications that look like credits.
  - Shopping apps send "₹500 off" texts.
- **Language and script.** Hindi and regional-language alerts exist. Keep templates
  locale-tagged.
- **Template drift.** Track the unparsed rate per `(package|sender, template version)` locally.
  Ship template updates as signed, versioned data (and say so in privacy docs).

### Capability-registry facts to add (proposed ids; `asOf: 2026-10-04`)

| Capability id | Scope | Android status | Note |
|---|---|---|---|
| `os:notification-listener` | platform/permission | available (API 18+; not low-RAM ≤ Android 10; user grant; sideload → restricted setting) | MVP sensor |
| `os:notification-otp-content` | platform | unavailable on Android 15+ for third-party listeners | redaction to "Sensitive notification content hidden" |
| `os:sms-read` | platform + store policy | limited (Play exception "SMS-based money management" + declaration) | Android 17 OTP delay |
| `os:sms-otp-realtime` | platform | limited (3 h delay: Retriever-hash SMS already before Android 17; Android 17 adds WebOTP for all apps and standard OTP SMS for target 37) | do not depend on it |
| `os:usage-access` | permission | available (special app access; null while locked; few-days retention) | research |
| `os:accessibility-non-a11y` | store policy | limited (declaration; restricted settings) | BRAKE: avoid |
| `os:overlay` | permission | limited | BRAKE: avoid |
| `os:share-target`, `os:process-text` | platform | available | MVP |
| `os:clipboard-on-tap` | platform | available (foreground only; Android 12+ toast) | MVP |
| `os:app-widget` | platform | available (no text input) | MVP |
| `os:qs-tile-add-prompt` | platform | available (Android 13+) | next |
| `os:notification-choice-chips` | platform | limited (AOSP SystemUI; OEM variance) | plus 3 action buttons |
| `os:live-updates` | platform | available (Android 16+; eligibility rules) | research |
| `os:appfunctions` | platform | emerging (Android 16+; Gemini private preview May 2026) | research |
| `os:screen-time-shield` | platform | unavailable on Android | contrast with iOS |
| `os:private-space` | platform | present on Android 15+ | degradation note |
| `dist:unverified-developer-install` | country | limited in BR/ID/SG/TH (participating stores, from 2026-09-30); global 2027 | affects sideload plans |
| `os:autofill-as-sensor` | platform + guide | unavailable (guide forbids non-suggestion use) | BRAKE: avoid |
| `os:screenshot-detection-third-party` | platform | unavailable (own activity only, no image) | use share target instead |

`PlatformProfile(android).surface = { maxQuickActions: 3, supportsTextInput: true }`.

### Product-level consequences

- **User A (Android, India) in-spend reality.** Without OTP access and without UPI interposition,
  in-spend sensing on Android is mostly limited to:
  - BRAKE-originated flows (its own QR scanner, share, "should I buy");
  - collect-request notifications;
  - fast post-spend alerts within seconds.

  The intelligence layer should treat "post-spend within seconds" as the main Android real-time
  capability. It should not promise an in-flow pause.
- **Graceful degradation order on Android:**
  1. NLS
  2. plus SMS backfill (if approved)
  3. plus AA/email (other streams)
  4. manual only

---

## Risks, policy constraints and ethical concerns

1. **Play enforcement risk (SMS).**
   - The money-management exception is discretionary and called "temporary". A rejection or later
     removal would break the SMS path, which is why it must not be MVP-critical.
   - Exact 2026 conditions could not be read directly (support.google.com blocked). **A legal/policy
     review with the live Play Console form is required before building it.**
2. **NLS is a malware-grade capability.**
   - BRAKE's process would hold every notification on the device momentarily. Required:
     - no third-party analytics or ads SDKs in the capture process;
     - certificate pinning for any sync;
     - no remote "parse everything" switch;
     - a server-side kill switch that can only *narrow* the scope;
     - security review and penetration testing.
   - Play's spyware/stalkerware rules and Play Protect heuristics apply *(details unverified)*.
3. **Third-party and private-message content.** Messaging-app notifications include friends'
   messages and P2P counterparties' names.
   - Drop non-allow-listed senders before parsing.
   - Hash or omit P2P names unless the user opts in for shared-expense features.
   - Never ingest WhatsApp or other chat content by default; use `migrateNotificationFilter` to
     deny chat apps.
4. **OTP handling.** Never extract, store or display OTPs, even on Android ≤14 where they are not
   redacted. Treat any OTP seen as a bug and an incident.
5. **Interposition ethics (UPI chooser, overlays, accessibility).** Inserting BRAKE into payment
   flows can feel like hijacking and can break payments, and it is in tension with "without
   scolding". Any in-flow friction must be opt-in, light, bypassable in one tap, and never applied
   to low-confidence inferences (`overview.md` intervention bounds).
6. **Surveillance creep with usage stats.** App-open telemetry is a full behavioural timeline.
   Limit it to user-chosen apps, process it locally, aggregate quickly, and explain it in the
   provenance UI.
7. **Data protection law.** India's DPDP Act 2023 and Rules, and the GDPR elsewhere, require
   specific, informed consent notices per purpose. Exact obligations are for the legal stream
   *(not researched here)*.
8. **OEM fragmentation.** Kill-happy OEMs dominate Indian sales *(market share unverified)*.
   Without per-OEM onboarding, NLS reliability will be inconsistent, and users will blame BRAKE for
   "missing transactions". Provenance and gap honesty ("BRAKE may miss alerts while it's asleep")
   are product features.
9. **Classifier opacity.** OS-level OTP and sensitive-content classifiers (Android 15
   notifications, Android 17 SMS) are black boxes. False positives silently remove real debit alerts,
   so field telemetry must count redacted vs parsed rates, locally aggregated.
10. **Target-SDK treadmill.** Each Play target-API step (36 now, 37 expected ~2027) can bring
    behaviour changes such as the standard-SMS OTP delay and BAL hardening. Budget for an annual
    Android compatibility pass.

---

## Open questions

1. What exactly do the current (2026) Play Console Help pages say for the "SMS-based money
   management" exception? Specifically: conditions, required evidence, whether both `READ_SMS`
   (backfill) and `RECEIVE_SMS` are grantable, current approval practice, and whether the
   2027-01-27 revision touches it.
2. Does Google Play require any declaration or extra review for `BIND_NOTIFICATION_LISTENER_SERVICE`
   in 2026? How does the Data safety form classify notification content processed only on-device?
3. Which Notification Assistant implementations (Pixel, Samsung, Xiaomi, others) flag "sensitive"
   content, and how often do Indian bank **debit alerts** (not OTPs) get redacted by mistake? Needs
   device testing.
4. How does Android 17's SMS OTP detector treat debit alerts that contain long reference numbers?
   Are any bank alerts withheld for 3 hours?
5. On a real Android 15+ device, does a main-profile NLS receive notifications from private-space
   apps while the space is unlocked (the AOSP reading suggests yes)? Are they back-delivered on
   unlock?
6. Do Samsung One UI and Xiaomi HyperOS render app-supplied `RemoteInput.setChoices()` chips, and
   how many fit?
7. Is forwarding a merchant's `upi://pay` intent through BRAKE acceptable to NPCI and the major PSP
   apps? What happens to `sign`/verified-merchant flows and fraud scoring when the caller is BRAKE?
8. What is the current scope of Play Protect's enhanced fraud protection (countries; permissions
   that trigger blocking of internet-sideloaded apps), and does it cover India in 2026? (The
   fact-checker recalls public reports of an India pilot from late 2024; this was not verifiable
   on 2026-10-04 because Google blogs and search were unavailable.)
13. Which Play Console Help URL (`answer/9047303` or `answer/10208820`) now holds the SMS/Call Log
    exceptions table, and does it still list "SMS-based money management"?
9. Have restricted settings been extended beyond non-session installers on Android 15–17?
10. When will AppFunctions/Gemini integration be generally available, and will Gemini call
    third-party finance functions?
11. What is the Play policy position on a `specialUse` foreground service used to poll
    `UsageStatsManager` for shopping-app detection?
12. Which markets beyond India have SMS or app-push transaction alerts dense enough to make NLS the
    primary sensor (for example Kenya M-PESA SMS, Indonesia, Brazil Pix app alerts)? These were
    *not researched here*.

---

## References

URLs consulted on 2026-10-04. "Fetched" means the page or file was read directly. "Search
excerpt" means only a search-engine excerpt was seen, because the page was blocked by the egress
proxy.

1. https://developer.android.com/about/versions/15/behavior-changes-all (fetched; updated
   2026-10-01): OTP redaction for untrusted NLS, screenshare protection, private space behaviour
   (apps stopped when locked, `ACCESS_HIDDEN_PROFILES`).
2. https://developer.android.com/about/versions/15/behavior-changes-15 (fetched): SYSTEM_ALERT_WINDOW
   FGS-start narrowing, dataSync FGS timeout.
3. https://developer.android.com/about/versions/15/features (fetched): private space, widget
   generated previews.
4. https://developer.android.com/about/versions/16/behavior-changes-all (fetched; updated
   2026-10-01): intent-redirection hardening, `removeLaunchSecurityProtection()`.
5. https://developer.android.com/about/versions/16/behavior-changes-16 (fetched): Safer Intents
   (`intentMatchingFlags`).
6. https://developer.android.com/about/versions/16/features (fetched): ProgressStyle notifications.
7. https://developer.android.com/about/versions/17/behavior-changes-all (fetched; updated
   2026-10-01): SMS OTP protection (3-hour delay, WebOTP, all apps).
8. https://developer.android.com/about/versions/17/behavior-changes-17 (fetched; updated
   2026-10-01): OTP protection for standard SMS (target 37), BAL hardening for IntentSender, widget
   memory limit.
9. https://developer.android.com/about/versions/17 and https://developer.android.com/about/versions/17/features
   (fetched): Android 17 overview, Live Update semantic colours, `Notification.Metric`.
10. https://developer.android.com/about/versions/13/behavior-changes-all (fetched):
    `POST_NOTIFICATIONS`, clipboard `EXTRA_IS_SENSITIVE`.
11. https://developer.android.com/about/versions/12/behavior-changes-all (fetched): untrusted touch
    blocking.
12. https://developer.android.com/about/versions/12/behavior-changes-12 (fetched): notification
    trampoline restrictions.
13. https://developer.android.com/about/versions/10/privacy/changes (fetched): Android 10 clipboard
    restriction (only IME or focused app).
14. https://developer.android.com/reference/android/Manifest.permission (fetched; updated
    2026-09-16): `RECEIVE_SENSITIVE_NOTIFICATIONS` (signature|preinstalled|knownSigner|role; also
    covers SMS OTP broadcasts), `READ_SMS`/`RECEIVE_SMS` hard-restricted, `PACKAGE_USAGE_STATS`,
    `QUERY_APP_USAGE` (internal|role), `SYSTEM_ALERT_WINDOW`, `ACCESS_HIDDEN_PROFILES`,
    `BIND_NOTIFICATION_LISTENER_SERVICE`, `QUERY_ALL_PACKAGES`.
15. https://developer.android.com/reference/android/app/usage/UsageStatsManager (fetched; updated
    2026-08-28): permission model, "events only kept … a few days", null while locked,
    `queryEvents(UsageEventsQuery)` API 35, `queryAppUsageDuration` (37.2).
16. https://developer.android.com/reference/android/accessibilityservice/AccessibilityServiceInfo
    (fetched): `isAccessibilityTool()` (API 31).
17. https://developer.android.com/guide/topics/ui/accessibility/service (fetched; updated
    2026-04-17): AccessibilityService capabilities. No policy text on this page.
18. https://developer.android.com/reference/android/widget/RemoteViews (fetched): supported
    layouts and widgets (no EditText; CheckBox/RadioButton/Switch since API 31).
19. https://developer.android.com/guide/topics/permissions/default-handlers (fetched; updated
    2026-02-26): default-handler requirement and rules; link to Play exceptions.
20. https://developer.android.com/identity/sms-retriever (fetched; updated 2026-09-28): SMS
    Retriever purpose (phone verification, one-time code).
21. https://developer.android.com/develop/ui/views/touch-and-input/copy-paste (fetched; updated
    2026-10-01): clipboard access toast (Android 12+), copy confirmation (Android 13+), sensitive
    flag.
22. https://developer.android.com/develop/ui/views/quicksettings-tiles (fetched; updated
    2026-10-01): TileService modes, `requestAddTileService()` (Android 13), `startActivityAndCollapse`,
    `unlockAndRun`.
23. https://developer.android.com/develop/ui/views/notifications/build-notification (fetched): "up
    to three action buttons", direct reply (Android 7.0), `POST_NOTIFICATIONS`.
24. https://developer.android.com/develop/ui/views/notifications/live-update (fetched; updated
    2026-10-01): Live Update requirements and usage criteria.
25. https://developer.android.com/training/sharing/receive (fetched): `ACTION_SEND` intent filters,
    MIME types, Direct Share.
26. https://developer.android.com/training/package-visibility, https://developer.android.com/training/package-visibility/declaring,
    https://developer.android.com/training/package-visibility/automatic,
    https://developer.android.com/training/package-visibility/use-cases (fetched): `<queries>`,
    automatic visibility (startActivityForResult callers), `QUERY_ALL_PACKAGES`.
27. https://developer.android.com/guide/components/activities/background-starts (fetched):
    background activity launch exceptions (SAW, notification PendingIntent, launcher/widget),
    PendingIntent opt-in hardening.
28. https://developer.android.com/privacy-and-security/risks/tapjacking (fetched): overlays,
    `setHideOverlayWindows()`, Android 12 occlusion protection.
29. https://developer.android.com/develop/background-work/services/fgs/service-types (fetched):
    `specialUse` FGS type requires a Play Console justification.
30. https://developer.android.com/training/wearables/notifications/bridger (fetched; updated
    2026-09-22): notification bridging to Wear OS, bridge tags. *(Fact-check: does not cover
    bridging of actions or RemoteInput choices.)*
31. https://developer.android.com/ai/appfunctions (fetched): AppFunctions (Android 16+,
    `EXECUTE_APP_FUNCTIONS`, Gemini private preview as of May 2026, experimental).
32. https://developer.android.com/develop/devices/assistant/overview (fetched; updated 2026-07-16):
    App Actions / BIIs still documented. *(Fact-check: no deprecation or "legacy" notice on the
    page.)*
33. https://developer.android.com/google/play/requirements/target-sdk (fetched): from 2026-08-31,
    new apps and updates must target API 36; existing apps API 35.
34. https://developer.android.com/developer-verification (fetched): verification timeline (Aug
    2026; 2026-09-30 BR/ID/SG/TH; 2027 global).
35. https://developer.android.com/developer-verification/guides/faq (fetched): sideloads not yet
    covered, advanced flow (24-hour wait), ADB exemption, limited distribution.
36. https://developer.android.com/privacy-and-security/advanced-protection-mode (fetched; updated
    2026-07-29): AAPM (Android 16) blocks sideloading, 2G, etc.
37. https://developer.android.com/security/fraud-prevention (fetched): Play Protect real-time scan;
    "most apps with the notification listener service will receive notifications with one-time
    password content removed".
38. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/service/notification/NotificationListenerService.java
    (fetched): manifest example, filter-type meta-data, low-RAM and work-profile notes,
    `requestRebind`, `migrateNotificationFilter`, `hasSensitiveContent` (@SystemApi).
39. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/services/core/java/com/android/server/notification/NotificationManagerService.java
    (fetched): trusted-listener test (permission, platform signature, app-op, CDM association),
    `redactStatusBarNotification` (title → app label, text → placeholder, actions blanked),
    `isVisibleToListener`, lockdown handling, private-profile flags.
40. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/services/core/java/com/android/server/notification/ManagedServices.java
    (fetched): listener user/profile matching (`enabledAndUserMatches`, `isPermittedForProfile`).
41. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/app/Notification.java
    (fetched): extras keys, `MAX_ACTION_BUTTONS = 3`, categories, MessagingStyle retention (25).
42. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/service/notification/StatusBarNotification.java
    (fetched): public getters, key format.
43. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/res/res/values/strings.xml
    (fetched): `redacted_notification_message` = "Sensitive notification content hidden".
44. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/res/AndroidManifest.xml
    and https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/service/notification/flags.aconfig
    (fetched): `RECEIVE_SENSITIVE_NOTIFICATIONS` definition (older protection level in the mirror),
    redaction feature flags.
45. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/packages/SystemUI/src/com/android/systemui/statusbar/policy/SmartReplyStateInflater.kt
    and https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/packages/SystemUI/src/com/android/systemui/statusbar/policy/SmartReplyConstants.java
    (fetched): app-provided RemoteInput choices rendered as smart-reply chips; precedence over the
    assistant.
46. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/provider/Settings.java,
    https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/app/NotificationManager.java,
    https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/content/Intent.java
    (fetched): settings intents (notification listener detail, usage access, overlay, app usage),
    `isNotificationListenerAccessGranted`, `ACTION_PROCESS_TEXT`.
47. https://raw.githubusercontent.com/aosp-mirror/platform_packages_apps_settings/main/res/values/strings.xml
    (fetched): restricted-settings UI strings ("Allow restricted settings", "For your security, this
    setting is currently unavailable.").
48. https://raw.githubusercontent.com/urbandroid-team/dont-kill-my-app/master/_vendors/{huawei,xiaomi,oneplus,samsung,meizu,asus,oppo,vivo,realme,motorola,sony}.md
    (fetched): OEM background-kill ranking positions and severity. Ranking date unknown.
49. https://support.google.com/googleplay/android-developer/answer/10208820 (**search excerpt
    only**): "Use of SMS or Call Log permission groups"; permitted uses; temporary-exception
    language; "SMS-based money management — apps that track and manage budget" with
    READ_SMS/RECEIVE_SMS/RECEIVE_MMS/RECEIVE_WAP_PUSH; declaration requirement.
50. https://support.google.com/googleplay/android-developer/answer/17225965 (**search excerpt
    only**): preview of the SMS/Call Log policy effective 2027-01-27 (READ_CALL_LOG call-verification
    use removed).
51. https://support.google.com/googleplay/android-developer/answer/17134731 (**search excerpt
    only**): policy announcement 2026-07-15 (SMS/Call Log change; Contacts Permissions policy
    effective 2026-10-28).
52. https://github.com/PenniLogic/android/issues/10 (fetched; **secondary**, dated 2026-09-29):
    third-party summary of the money-management exception and declaration evidence (demo video,
    on-device processing). Not authoritative.
53. https://dev.to/zeta_byte/ive-been-working-on-a-personal-finance-app-called-finvantage-and-i-recently-hit-a-roadblock-4mjh
    (**search excerpt only; anecdotal**): reported Play rejection of SMS auto-import for an expense
    tracker.

References added by the 2026-10-04 fact-check (all fetched directly on that date):

54. https://developer.android.com/developer-verification/guides (updated 2026-08-18): list of
    participating stores; "Your apps can still be sideloaded"; ADB unchanged.
55. https://developer.android.com/reference/android/service/quicksettings/TileService:
    `startActivityAndCollapse(Intent)` deprecated in API 34 and throws `UnsupportedOperationException`
    on 34+; the `PendingIntent` overload was added in API 34.
56. https://developer.android.com/about/versions/17/features (updated 2026-10-01): Live Update
    semantic colouring, `Notification.Metric`.
57. https://developer.android.com/guide/topics/text/autofill-services (updated 2026-10-01):
    `AssistStructure` in `onFillRequest()`; "Autofill services must not use information for purposes
    other than providing suggestions."
58. https://developer.android.com/about/versions/14/features/screenshot-detection (updated
    2026-10-01): per-activity callback, `DETECT_SCREEN_CAPTURE`, no screenshot image.
59. https://developer.android.com/develop/background-work/services/fgs/service-types (updated
    2026-10-01): `specialUse` use cases "are reviewed when you submit your app in the Google Play
    Console".

---

## Verification log

Adversarial fact-check run on 2026-10-04. Verdicts: **confirmed** (a primary source says this),
**corrected** (the text was changed above), **unverifiable** (no primary source was reachable;
the claim stays marked in the text).

| # | Claim | Verdict | Source |
|---|---|---|---|
| 1 | Android 15 stops untrusted NLS apps from reading unredacted OTP notifications; CDM associations are exempt | confirmed | https://developer.android.com/about/versions/15/behavior-changes-all |
| 2 | Redaction details: title becomes app label, text "Sensitive notification content hidden", sub-text and textLines removed, action titles blanked, MessagingStyle replaced | confirmed (AOSP `redactStatusBarNotification`) | https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/services/core/java/com/android/server/notification/NotificationManagerService.java |
| 3 | BigTextStyle body is also redacted | corrected (sits behind a separate AOSP bug-fix flag; rollout unverified) | same NMS file plus `core/java/android/service/notification/flags.aconfig` |
| 4 | Trusted listener = `RECEIVE_SENSITIVE_NOTIFICATIONS`, platform signature, app-op, or non-revoked CDM association | confirmed | NMS `isAppTrustedNotificationListenerService` (same URL as #2) |
| 5 | `RECEIVE_SENSITIVE_NOTIFICATIONS` protection `signature\|preinstalled\|knownSigner\|role`; it also gates OTP SMS | confirmed (added in 36.1) | https://developer.android.com/reference/android/Manifest.permission |
| 6 | Android 17: OTP SMS withheld 3 h; `SMS_RECEIVED_ACTION` withheld and provider queries filtered | confirmed | https://developer.android.com/about/versions/17/behavior-changes-all |
| 7 | "Android 17 applies to WebOTP/Retriever formats for all apps" | corrected (Retriever-hash delay predates Android 17; Android 17 adds WebOTP for all apps) | https://developer.android.com/about/versions/17/behavior-changes-all |
| 8 | Standard OTP SMS delayed 3 h for apps targeting API 37; default SMS assistant and companion apps exempt | confirmed | https://developer.android.com/about/versions/17/behavior-changes-17 |
| 9 | Play: new apps and updates must target API 36 from 2026-08-31; existing apps API 35 | confirmed (added: extension to 2026-11-01) | https://developer.android.com/google/play/requirements/target-sdk |
| 10 | Developer verification: 2026-09-30 for participating stores in BR/ID/SG/TH on Android 7+; global 2027; sideloads not affected yet | confirmed (wording of quote corrected; store list added) | https://developer.android.com/developer-verification ; https://developer.android.com/developer-verification/guides/faq ; https://developer.android.com/developer-verification/guides |
| 11 | Advanced flow: developer mode, anti-coaching check, restart, one-day wait; ADB exempt; limited distribution up to 20 devices | confirmed | https://developer.android.com/developer-verification/guides/faq |
| 12 | Android 16 AAPM blocks sideloading | confirmed (only for users who enable it; takeaway reworded) | https://developer.android.com/privacy-and-security/advanced-protection-mode |
| 13 | Android 16 intent-redirection hardening rules out re-launching the received intent | corrected (docs target sub-level intents from extras; effect on a forwarded top-level intent unverified) | https://developer.android.com/about/versions/16/behavior-changes-all |
| 14 | `Notification.MAX_ACTION_BUTTONS = 3`; docs: "up to three action buttons" | confirmed | Notification.java (AOSP mirror); https://developer.android.com/develop/ui/views/notifications/build-notification |
| 15 | `MessagingStyle.MAXIMUM_RETAINED_MESSAGES = 25`; `CATEGORY_PROMO = "promo"` | confirmed | https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/app/Notification.java |
| 16 | App-supplied RemoteInput choices take precedence over NAS suggestions; target-P gate | confirmed (AOSP; OEM rendering unverifiable) | https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/packages/SystemUI/src/com/android/systemui/statusbar/policy/SmartReplyStateInflater.kt |
| 17 | Wear OS bridges actions and RemoteInput choices by default | corrected (the page confirms only that notifications are bridged by default) | https://developer.android.com/training/wearables/notifications/bridger |
| 18 | NLS unavailable on low-RAM devices running Android Q and below; work-profile listeners ignored; `requestRebind` is the only call safe before connect | confirmed | https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/service/notification/NotificationListenerService.java |
| 19 | `migrateNotificationFilter` is ignored if the user already set filters; filter-type flags 1/2/4/8 | confirmed | same NLS file as #18 |
| 20 | `sbn.getKey()` = `userId\|pkg\|id\|tag\|uid` | confirmed | https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/service/notification/StatusBarNotification.java |
| 21 | UsageStatsManager: events "kept … a few days"; null while locked (Android R+); user must grant in Settings | confirmed | https://developer.android.com/reference/android/app/usage/UsageStatsManager |
| 22 | `queryAppUsageDuration` added in 37.2, 30-day window, requires `QUERY_APP_USAGE` (`internal\|role`) | confirmed | UsageStatsManager reference; Manifest.permission reference |
| 23 | `READ_SMS`/`RECEIVE_SMS` hard restricted (installer allow-list) | confirmed | https://developer.android.com/reference/android/Manifest.permission |
| 24 | Default handler must ask for the role before requesting permissions; default SMS handler must be able to send texts | confirmed | https://developer.android.com/guide/topics/permissions/default-handlers |
| 25 | Play exception "SMS-based money management — apps that track and manage budget" (READ_SMS, RECEIVE_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH) | unverifiable (support.google.com blocked; the dev docs link to answer/9047303) | https://support.google.com/googleplay/android-developer/answer/9047303 (not fetched) |
| 26 | Play SMS/Call Log revision announced 2026-07-15, effective 2027-01-27, money-management exception unchanged | unverifiable (only a secondary GitHub issue corroborates) | https://github.com/PenniLogic/android/issues/10 (secondary) |
| 27 | No NLS-specific Play declaration exists (2026) | unverifiable | — |
| 28 | Live Update requirements | corrected (added MetricStyle, group-summary and IMPORTANCE_MIN rules; permission added in 36.1) | https://developer.android.com/develop/ui/views/notifications/live-update |
| 29 | AppFunctions: Android 16+, `EXECUTE_APP_FUNCTIONS`, Gemini private preview "as of May 2026", experimental | confirmed (added: permission is `normal`, runtime allowlist) | https://developer.android.com/ai/appfunctions ; Manifest.permission reference |
| 30 | App Actions is the "legacy" Assistant path | corrected (the page shows it as current with no deprecation notice; "legacy" is this doc's judgement) | https://developer.android.com/develop/devices/assistant/overview |
| 31 | Clipboard: Android 10 IME/focus only; Android 12 toast on `getPrimaryClip()` but not on `getPrimaryClipDescription()`; Android 13 `EXTRA_IS_SENSITIVE` | confirmed | https://developer.android.com/about/versions/10/privacy/changes ; https://developer.android.com/develop/ui/views/touch-and-input/copy-paste |
| 32 | RemoteViews has no EditText; CheckBox/RadioButton/RadioGroup/Switch from API 31 | confirmed | https://developer.android.com/reference/android/widget/RemoteViews |
| 33 | Android 17 widget memory limit | confirmed (formula added) | https://developer.android.com/about/versions/17/behavior-changes-17 |
| 34 | QS tile: `requestAddTileService` (Android 13), "only in context", denied "enough times"; Intent overload of `startActivityAndCollapse` deprecated on 34+ | confirmed (the deprecation had been marked unverified) | https://developer.android.com/develop/ui/views/quicksettings-tiles ; TileService reference |
| 35 | Android 15 SAW background-FGS exemption needs a visible overlay (target 35) | confirmed | https://developer.android.com/about/versions/15/behavior-changes-15 |
| 36 | Android 12 untrusted-touch blocking; `setHideOverlayWindows` (API 31) | confirmed (≤0.8-opacity exemption added) | https://developer.android.com/about/versions/12/behavior-changes-all ; https://developer.android.com/privacy-and-security/risks/tapjacking |
| 37 | Android 12 notification trampoline restriction (target 31+) | confirmed | https://developer.android.com/about/versions/12/behavior-changes-12 |
| 38 | Private space: apps stopped when locked, no notifications; apps can't detect private space; `ACCESS_HIDDEN_PROFILES` for launchers | confirmed (main-profile NLS visibility while unlocked unverifiable) | https://developer.android.com/about/versions/15/behavior-changes-all |
| 39 | `specialUse` FGS needs a Play Console justification | confirmed | https://developer.android.com/develop/background-work/services/fgs/service-types |
| 40 | `startActivityForResult` callers are automatically visible | confirmed | https://developer.android.com/training/package-visibility/automatic |
| 41 | SMS Retriever is for phone verification and the message must carry the app hash | confirmed (5-minute timeout added) | https://developer.android.com/identity/sms-retriever |
| 42 | Fraud page: "most apps with the notification listener service will receive notifications with one-time password content removed"; Play Protect real-time scan | confirmed | https://developer.android.com/security/fraud-prevention |
| 43 | Play Protect enhanced fraud protection blocks internet-sideloaded apps requesting SMS/NLS/Accessibility (and covers India) | unverifiable (not on the fraud-prevention page; blogs blocked) | — |
| 44 | dontkillmyapp ranks Huawei 1, Xiaomi 2, OnePlus 3, Samsung 4 (award 5) | confirmed (ranking date unknown) | https://raw.githubusercontent.com/urbandroid-team/dont-kill-my-app/master/_vendors/huawei.md (and siblings) |
| 45 | Restricted-settings UI strings | confirmed (scope on Android 15–17 unverifiable) | https://raw.githubusercontent.com/aosp-mirror/platform_packages_apps_settings/main/res/values/strings.xml |
| 46 | Background-activity-start exemptions (SAW, notification PendingIntent, launcher/widget) | confirmed | https://developer.android.com/guide/components/activities/background-starts |
| 47 | Share target intent filters, `EXTRA_TEXT`/`EXTRA_STREAM`, Direct Share | confirmed | https://developer.android.com/training/sharing/receive |
| 48 | RCS alerts are absent from the telephony SMS provider; NPCI UPI linking parameters and result extras | unverifiable | — |

**Spot-checked citations:** about 40 URLs were fetched again. Every cited developer.android.com page
and AOSP file exists. Mismatches between a citation and its claim were fixed in the text and noted
in references 30 and 32. The cited GitHub issue exists but is secondary and possibly
machine-written, so it is not used as evidence.
