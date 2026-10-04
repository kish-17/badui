# SMS banking alerts, RCS and transactional messaging as BRAKE signal sources

> **Scope.** This is research stream 07. It covers bank, card, UPI and mobile-money **SMS alerts** and their formats by country, how they are captured on Android (SMS permission, notification listener, the default-SMS-app role) and why iOS cannot capture them, how to parse them (template packs, regex, ML, on-device LLMs), **spoofing** and sender verification, **OTP** handling, **RCS Business Messaging**, **WhatsApp** transactional messages, the legal and consent position, and how iOS users in SMS-heavy markets can still be served. Email alerts, Account Aggregator, UPI intents and bank-app push notifications belong to other streams. They appear here only where they meet messaging (fusion keys, fallbacks).
>
> **Date:** 2026-10-04. Every time-sensitive claim is "as of" this date unless another date is given.
>
> **Method and verification.** The research environment had a restricted network. Web search was unavailable. Regulator sites (rbi.org.in, trai.gov.in, npci.org.in, pib.gov.in), Google Play Console Help (support.google.com, play.google.com), Meta developer and WhatsApp legal pages, Safaricom, support.apple.com, Wikipedia and legal databases all returned *egress blocked*. The sources I could read were **Android Developers** (behavior-change pages updated 2026-10-01), **AOSP source** (GitHub mirror), **Apple Developer** documentation (JSON endpoints), **Meta's published WhatsApp OpenAPI spec**, and **open-source SMS-parsing projects** whose code and test fixtures show real alert formats (one of them was committed on 2026-10-04). Every regulatory, policy-text and market claim I could not check against a primary source is marked **(unverified)**. Read them as hypotheses to confirm before a product decision depends on them.

## Key takeaways for BRAKE

1. **The alert text is the asset, not the capture path.** BRAKE should build one on-device `sms` parsing adapter (versioned template packs, a heuristic fallback, an optional on-device LLM fallback). It should accept text from every capture path: Android SMS permission, Android notification listener (SMS, RCS and WhatsApp as rendered by messaging apps), and user paste or Shortcuts on iOS. Model each capture path as its own capability and consent.
2. **On Android, plan for the notification listener first and the SMS permission second.** `READ_SMS` and `RECEIVE_SMS` are *hard-restricted* in the platform (the installer must allow-list them) [8]. Google Play also grants them only to default handlers or approved exception cases [4]. Ship the MVP on the notification listener. Treat the SMS permission as an opt-in upgrade, worth having for exact sender headers and history backfill, once Play approves BRAKE's declaration. Approval for budgeting apps is plausible but **(unverified)** for 2026.
3. **The OS now walls off OTPs, and BRAKE must never touch them.** Android 15 redacts notifications in which an OTP is detected for untrusted listeners [3]. Android 17 (API 37) withholds OTP SMS from non-recipient apps for **three hours**: WebOTP and SMS-Retriever-format OTPs for all apps, standard OTP SMS for apps targeting API 37 [1][2]. BRAKE should drop OTP messages at capture, before any persistence, logging or crash reporting. It must not build an in-spend feature on "OTP for ₹X at MERCHANT" SMS.
4. **Sender verification is BRAKE's spoofing defence, and India gives a strong key.** Indian commercial SMS arrive from DLT headers of the form `XX-ENTITY-S`. Live 2026 examples include `JD-KOTAKD-S` [27], and parsers treat `-S` as service/transaction alerts and `-T/-P/-G` as OTP, promotional and government [24][25]. The regulation behind the suffixes is **(unverified)**. Outside India, use short codes (Chase `24273` [40]) and alphanumeric IDs (`MPESA`, `bKash`), plus template conformance, balance-chain consistency and cross-source corroboration. An unverified message must never found a high-confidence candidate or trigger friction.
5. **Some Indian alerts are moving to RCS, which has no read API.** Kotak moved its UPI "Sent" alerts from SMS to RCS by May 2026 [28]. SBI Card and Punjab National Bank also send RCS alerts [25][31]. Android offers no public RCS API. The notification listener sees RCS messages. An undocumented route (Google Messages writing RBM messages into `content://mms` with `tr_id` = `proto:<base64>` containing `…_agent@rbm.goog`) works today but is fragile [46].
6. **Alerts carry strong dedup and reconciliation keys.** These include the UPI RRN (12 digits, e.g. `UPI Ref no. …`, `UPI: …`), the NEFT/RTGS UTR, the 10-character M-Pesa transaction code, the bKash `TrxID` and the mandate `UMRN`/`UMN`. The same RRN on a debit alert from bank A and a credit alert from bank B identifies an own-account transfer, which is the brief's "transfer vs spending" problem solved deterministically.
7. **SMS has real PRE-SPEND value in India.** Pre-debit notifications for e-mandates and UPI AutoPay (the "will be debited … towards NETFLIX" type), card-bill due alerts and payment requests arrive *before* money moves. Most trackers throw them away [29]. BRAKE should parse them into `mandate`/`subscription_event` observations ("Netflix renews tomorrow — keep or review?").
8. **Prevalence differs widely by market.**
   - **India:** SMS alerts are near-universal (RBI-driven, **unverified**).
   - **Kenya, Tanzania, Mozambique, Bangladesh:** SMS is the system of record for mobile money (M-Pesa, Tigo Pesa, bKash) [35][36][37][38].
   - **Nigeria:** bank SMS alerts are common [39].
   - **US, UK, EU:** SMS is opt-in and minor; push notifications dominate.
   - **Indonesia, Brazil:** no evidence of an SMS-led alert culture in the sources I could read. Push and WhatsApp appear dominant **(unverified)**.
9. **WhatsApp offers no third-party read path except the notification listener.** Meta's published API is business-side only: send templates (`MARKETING`/`UTILITY`/`AUTHENTICATION`), `order_details` with `payment_type: upi`, and `order_status` [57]. A BRAKE WhatsApp number that users *forward* receipts to would be a user-initiated, cross-platform channel. It moves processing to a server, so it is a research item.
10. **iOS cannot read SMS, RCS or WhatsApp.** Message Filter extensions only see SMS/MMS from unknown senders, cannot reach the network directly and cannot write to the app's shared container [12]. They are not an ingestion path, and using them as one would be a policy risk. Serve iOS users in SMS-heavy markets with user-initiated **paste** (`UIPasteControl` pastes without the iOS 16+ prompt [18]), Shortcuts automations into an App Intent (trigger details **unverified**), on-device parsing (Foundation Models on Apple Intelligence devices [20]), and AA or email for the ledger.

---

## Sources investigated

Each subsection uses the same headings. "Confidence" is the probability, as BRAKE's `Observation.confidence` defines it, that the observation is genuine and its core facts were extracted correctly.

### 1. `sms-bank-alerts` — bank, card and UPI transaction SMS (the content)

*(Stream 12 calls the India-specific case `india-sms-bank-alerts`. This entry is the country-agnostic content source. The capture paths are §2, §7, §12 and §11.)*

- **What it is.** An A2P (application-to-person) SMS that a bank, card issuer, wallet or payments bank sends on every debit, credit, card authorization, ATM withdrawal, reversal or mandate event. In India this is regulator-driven. The RBI circular of 2017-07-06 on limiting customer liability in unauthorised electronic transactions requires banks to have customers register mobile numbers for SMS alerts and to send alerts for electronic transactions **(unverified; primary site blocked)**. Indian alerts are sent from DLT-registered headers using DLT-registered content templates with `{#var#}` slots under TRAI's TCCCPR-2018 framework **(unverified)**.
- **Data actually available.** These are fields as they appear in real alerts from open-source parser fixtures and issue reports [26][27][29][36][38][39][40][41][42][43]. Samples are anonymized by their maintainers; I removed names and links further.

  | Market / sender | Example text (verbatim structure) | Extractable fields |
  |---|---|---|
  | India, Kotak (`JD-KOTAKD-S`, 2026-05) | `Sent Rs.205.00 from XXXXXX1234 to <PAYEE NAME> on 26/05/2026. UPI ref no. <12 digits>. Not you? Tap <link> to report -Kotak` [27] | direction, amount, masked account, payee, date, **UPI RRN**, embedded link (never render) |
  | India, Canara (UPI debit) | `Dear Customer, Acct XXX123 Dr. INR 260.00 on 06/07/26 to SAMPLE MART; UPI: 123456789012; Bal INR 12,345.67.Not you? SMS BLOCKUPI to XXXXXXXXXX-CanaraBank` [41] | DR/CR, amount, **3-digit** masked tail, payee, dd/mm/yy date, RRN, **available balance** |
  | India, Canara (RTGS credit) | `An amount of INR 13,30,614.75 has been credited to XXXX6785 on 02/12/2025 towards RTGS by Sender AXIS MUTUAL FUND REDEMPTION PO, IFSC UTIB0000004, Sender A/c XXXX9108, AXIS BANK, MUMBAI BRANCH, UTR UTIBR72025120200011461, Total Avail. Bal INR 2679815.88- Canara Bank` [41] | **lakh-grouped** amount, counterparty name/IFSC, **UTR**, balance |
  | India, CSB/Jupiter RuPay credit card on UPI | `Rs.25.00 debited to your Edge CSB Bank RuPay Credit Card ending 6788 on 3/18/26, 6:39 PM - (UPI Ref no.702711160776). To dispute, call …` [42] | card instrument (credit), **m/d/yy** date with time, RRN |
  | India, HDFC (card) | `Spent Rs.X From HDFC Bank Card xxxx At [MERCHANT] On …`; `Txn Rs.X On HDFC Bank Card At [MERCHANT] by UPI` [29] | card last4, merchant descriptor |
  | India, ICICI (card abroad) | `USD 11.80 spent using ICICI Bank Card … on DD-Mon-YY at MERCHANT NAME` [24] | **foreign currency** amount, merchant |
  | India, mandate / pre-debit | Patterns `will be debited`, `E-Mandate`, `UMRN`/`UMN`, `towards <merchant>` [29][45] | amount, merchant, next deduction date, **UMN/UMRN** |
  | Kenya, M-PESA (`MPESA`) | `<10-char code> Confirmed. Ksh70.00 paid to <NAME> … on 20/10/24 …`, `… sent to <PAYBILL> for account 123123`, `New M-PESA balance is Ksh…` [35] | **transaction code**, amount, counterparty/till/paybill, balance, fee ("Transaction cost") |
  | Tanzania, M-Pesa (`M-Pesa`) | `DFJ9B1FPQ8 Confirmed. Tsh5,000.00 sent to business VODACOM-BUNDLES 2 on 19/6/26 at 10:56 pm. New M-Pesa balance is Tsh0.36.` [36] | code, amount, business vs person, time, balance |
  | Tanzania, Tigo Pesa | `Cash-In of TSh 100,000 from Agent - PERSON FIVE is successful. New balance is TSh 100,000. TxnId: 13411949026. 16/08/23 15:19.` [36] | TxnId, cash-in (not spend) |
  | Mozambique, M-Pesa (Portuguese) | `Confirmado DF50KDFDHWK. Transferiste 1,234.56MT e a taxa foi de 1.23MT para 258841234567 - JOHNDOE aos 5/6/26 as 4:15 PM. O teu novo saldo M-Pesa e de 12,345.67MT. …` [37] | code, amount, **fee**, phone-number counterparty, balance, Portuguese keywords |
  | Bangladesh, bKash | `You have received Tk 6,400.00 from xxxx. Fee Tk 0.00. Balance Tk 20,288.41. TrxID xxxx at 26/05/2026 10:58.`; `Payment of Tk 20.00 to xxxx is successful…` [38] | **TrxID**, amount, fee, balance, payment vs send-money |
  | Nigeria, GTBank | `Acct:******4321 / Amt:NGN15,000.00 DR / Desc:OUTWARD TRANSFER TO OPAY - JANE DOE / Bal:NGN20,000.00 / Date:2026-01-15 9:36AM` (multi-line) [39] | DR/CR, amount, free-text descriptor, balance, no reference id |
  | Pakistan, Faysal Bank (app notification) | `PKR 16738.79 Debit Card purchase at Sample Delivery Karachi from FBL A/C *1234 on 02/FEB/2026 at 09:14:51 PM`; `… received PKR 500.00 via RAAST … Ref#:121621592909 …`; `PKR 55.000.00 sent to … via IBFT …` [43] | rail (RAAST/IBFT), Ref#, **malformed thousands separator** |
  | US, Chase (short code `24273`) | `Card Name: You made a $9.17 transaction with TACO BELL on Mar 17, 2026 at 1:56 PM ET.` [40] | amount, merchant, timestamp with zone |

- **Windows and latency.**
  - **POST-SPEND** is primary. The alert typically lands seconds to minutes after authorization. No SLA is published, so this is observed behaviour **(unverified)**.
  - **PRE-SPEND** comes from mandate pre-debit, bill-due and payment-request messages (§3).
  - **IN-SPEND** would come only from OTP messages, which are excluded (§6).
- **Coverage.**
  - India: universal for bank accounts and cards, by regulation **(unverified)**. Smaller UPI debits may be exempt at some banks; for example, HDFC reportedly stopped SMS for UPI debits under ₹100 in 2024 **(unverified)**.
  - East Africa and Bangladesh: mobile money (§1b).
  - Nigeria: common. Banks reportedly charge SMS-alert fees, which pushes some users to email or app alerts **(unverified)**.
  - US, UK, EU: opt-in only.
  - Indonesia and Brazil: likely limited **(unverified)**.
  - One open-source on-device parser covers **159 institutions across 25 countries**: India 54, Nepal 13, Thailand 11, US 10, Ethiopia 9, Nigeria 9, Tanzania 7, Saudi Arabia 7, Iran 6, UAE 6, and Kenya, Pakistan and Bangladesh 1 each. It covers none in Indonesia or Brazil [22][23]. This reflects contributor demand rather than market size, but it is a useful proxy for where SMS/notification alert parsing is wanted.
- **Access requirements.** Depend on the capture path (§2, §7, §11, §12). The content itself costs nothing to receive.
- **Privacy and consent.**
  - Alerts reveal balances, counterparties (other people's names and phone numbers), salary and locations.
  - They are financial data, and in some jurisdictions they are communications content too.
  - Rules: parse on-device; persist only the extracted facts and a redacted, expiring excerpt (as `@brake/core/privacy` already specifies); never upload raw text by default.
- **Reliability and failure modes.**
  - Template drift: banks change wording, and suffix headers broke strict regexes [24][26].
  - Alerts move between channels: SMS to RCS [28], SMS to app push.
  - Multipart SMS must be concatenated [49].
  - Regional-language and Unicode-styled variants: SBI Card's RCS uses Mathematical Sans-Serif characters [25].
  - Messages that look transactional but are not: payment requests, future debits, declines, ATM free-usage counters, NACH "received for processing", promos with amounts [29][32][33][41].
  - Shared family phone numbers mean alerts for accounts the user does not own. PennyWise has an "ignored account" concept for this, see #826 in [47].
  - Delayed SMS delivery during network congestion **(unverified)**.
- **Dedup and reconciliation keys.**
  - `rail_reference`, namespace `upi`: the 12-digit RRN.
  - `rail_reference`, namespace `neft`/`rtgs`/`imps`: the UTR.
  - `rail_reference`, namespace `mpesa`/`tigopesa`/`bkash`/`raast`: the provider transaction code.
  - `mandate_id`: UMRN or UMN.
  - Weak keys: instrument masked tail + amount + minute-level timestamp + merchant descriptor.
  - Weakest: running balance, a sequence key used to detect gaps and forgeries (see Architecture).
- **Normalized observation** (aligned with `Observation` in `@brake/core`):

  ```json
  {
    "kind": "money_movement", "window": "post_spend", "stage": "confirmed",
    "source": { "adapterId": "sms", "kind": "sms", "provider": "Canara Bank", "label": "Canara Bank SMS alert" },
    "direction": "debit",
    "amount": { "value": { "minor": 26000, "currency": "INR" }, "confidence": 0.98 },
    "occurredAt": { "value": 1783312380000, "confidence": 0.85 },
    "merchant": { "raw": "SAMPLE MART", "confidence": 0.8 },
    "instrument": { "type": "bank_account", "issuer": "Canara Bank", "last4": null },
    "rail": { "family": "account_to_account_instant", "scheme": "upi" },
    "references": [ { "type": "rail_reference", "namespace": "upi", "value": "123456789012" } ],
    "typeHints": [ { "type": "purchase", "confidence": 0.6, "reason": "sms:upi-debit-named-payee" } ],
    "confidence": 0.95,
    "evidence": { "summary": "Canara Bank SMS: ₹260.00 debited to SAMPLE MART (UPI)", "excerptExpiresAt": "…+7d" }
  }
  ```

  The balance (`Bal INR 12,345.67`) goes into a separate `balance_snapshot` observation (context only). Confidence characteristics:
  - **0.93–0.98**: verified sender header plus a full known-template match.
  - **0.75–0.88**: verified sender with heuristic extraction.
  - **≤ 0.4**: unknown sender with financial-looking content. Such an observation founds only a low-confidence candidate that BRAKE may ask about, and it never triggers friction.
  - **Date-only alerts:** `occurredAt` takes the date from the text and the time from the SMS service-centre timestamp, with lower confidence.
- **Provenance sentence.** "Detected from your Canara Bank SMS alert (sender `<header as received>`) at 10:41." Always show the exact header BRAKE received, never a reconstructed one. I have not verified Canara's DLT header, so none is shown here. Variants: "Matched your Kotak RCS alert and your Amazon order email by UPI reference …7141" (illustrative).
- **Recommendation: `mvp` (the parser and template packs).** It is the highest-value real-time POST-SPEND content in India, East Africa, Bangladesh and Nigeria, and the same adapter serves every capture path.

### 1b. `mobile-money-sms` — M-Pesa, Tigo Pesa, bKash and similar confirmations

- **What it is.** The mobile-money operator's own confirmation SMS. For many users it is the only record they get, and it acts as the ledger. Kenya's `MPESA` messages start with a 10-character transaction code and the word `Confirmed`, and end with `New M-PESA balance is Ksh…` [35]. The same sender name is used in Kenya, Tanzania and Mozambique with different currencies and languages, so parser selection must look at content, not just the sender [34].
- **Data available.** Transaction code, amount, counterparty (person name and phone, till or paybill name, account), date and time, new balance, fee ("Transaction cost", `Fee Tk`, `taxa`), and the transaction kind (send, pay, buy goods, paybill, withdraw at agent, deposit/cash-in, airtime).
- **Windows and latency.** POST-SPEND within seconds **(unverified)**. Payments are approved through the SIM toolkit/USSD prompt, which no app can read. There is no in-spend signal.
- **Coverage.** Kenya, Tanzania, Mozambique, Bangladesh, and probably Pakistan (JazzCash/Easypaisa **unverified**) and other mobile-money markets. Android only, since iOS cannot read SMS.
- **Access, privacy, reliability.** As §1. Extra failure modes:
  - Agent cash-in and cash-out are *transfers*, not spending.
  - Cash withdrawn at an agent becomes invisible cash spending.
  - Overdraft products such as Fuliza create loan-type flows **(unverified)**.
  - Counterparties are often private individuals' names and phone numbers, which are third-party personal data to minimise.
- **Dedup keys.** Provider transaction code (`rail_reference`, namespace `mpesa`, `bkash` and so on). It is strong and also appears on merchant receipts.
- **Observation.** `money_movement` with `rail.family = "mobile_money"` and `scheme = "mpesa"`. `instrument.type = "mobile_money"`; there is no account number, only the wallet [35]. The fee goes in `amountBreakdown.fee`. Confidence 0.95 for a verified sender with a known template.
- **Provenance.** "Detected from your M-PESA confirmation (code DFJ9B1FPQ8)."
- **Recommendation: `next`.** It becomes `mvp` if BRAKE launches in East Africa or Bangladesh. The adapter is the same as §1 with extra template packs.

### 2. `android-sms-read` — capture through the SMS permission (`READ_SMS`/`RECEIVE_SMS`)

- **What it is.** The app declares `RECEIVE_SMS`, receives the non-abortable `SMS_RECEIVED_ACTION` broadcast that is "delivered to multiple apps" [Telephony.java, see 10], and with `READ_SMS` can query the SMS provider for history. `SMS_RECEIVED_ACTION` is on the implicit-broadcast exception list, so a manifest receiver still works on modern target SDKs [5]. Only the default SMS app can *write* to the provider [Telephony.java].
- **Data actually available.**
  - From `SmsMessage`: `getOriginatingAddress()` (the DLT header or short code), `getMessageBody()`, and `getTimestampMillis()`. The last one is the **service-centre** timestamp, not device receipt time [10].
  - From the provider (`Telephony.Sms`): `address`, `body`, `date`, `date_sent`, `sub_id` (the SIM that received it), `service_center`, and `creator` (read-only, set by the provider) [Telephony.java].
  - With `READ_SMS` the app can also query `content://mms`. That is where some RCS messages surface; see §8.
- **Windows and latency.** As §1. Capture happens at the moment the SMS arrives, with no notification needed. History backfill covers months or years of alerts, which gives an immediate spending baseline for "your usual pace" insights.
- **Coverage.** Android devices only, all countries. Dual-SIM is visible through `sub_id`.
- **Access requirements.**
  - **Platform:** `READ_SMS` and `RECEIVE_SMS` are `dangerous` permissions flagged `hardRestricted`, which "cannot be held by an app until the installer on record allowlists the permission" [8].
  - **Google Play** "restricts apps' access to call- and messaging-related permission groups". The app must be the default handler "unless your app satisfies one of the exception cases" [4] (page updated 2026-02-26).
  - The current exception list includes a use case for SMS-based money management or budgeting **(unverified: Play Console Help was blocked; stream 12 records the same uncertainty)**.
  - Evidence that budgeting apps get approved: PennyWise ships a Play build with `READ_SMS`/`RECEIVE_SMS` for bank-SMS parsing [22][50]. Money Manager Ex (Android) was rejected in Aug 2025 *for lacking a proper runtime-permission flow*, not for the use case: "Your app must prompt the user for permission access via a runtime permission" [56].
  - Expect a Permissions Declaration Form, a demo video and a prominent in-app disclosure **(unverified details)**.
  - Sideloaded or F-Droid builds avoid Play review but reach few users.
- **Privacy and consent.** Very high sensitivity. The permission exposes the *entire* inbox: personal messages, OTPs, health. Requirements:
  - Filter on-device at capture, by sender allow-list and a financial classifier.
  - Never read threads from contacts.
  - Never transmit non-financial messages.
  - Show the list of senders BRAKE reads.
  - Make the history backfill window a separate, explicit choice: "Scan the last 90 days of bank alerts?"
- **Reliability and failure modes.**
  - Two delivery paths: the live broadcast plus a provider rescan in a worker. They produce the same message twice with *different timestamps*. PennyWise therefore deduplicates on `sender|amount|md5(body)`, not on time [44].
  - OEM battery managers can delay the work.
  - Android 17's 3-hour OTP delay applies to anything the OS classifies as an OTP [1][2].
  - RCS alerts do not appear in `Telephony.Sms` at all (§8).
- **Dedup keys.** Within the source: `hash(normalizedSenderEntity | normalizedBody)` → `duplicate_delivery`. Across sources: the §1 keys.
- **Observation and confidence.** As §1. The originating address is exact, so sender verification is strongest on this path. This is the main advantage over the notification path.
- **Provenance.** "Detected from your HDFC Bank SMS (sender `XX-HDFCBK-…` as received)." Parsers match HDFC headers with `^[A-Z]{2}-HDFCBK.*$` [30].
- **Recommendation: `next`.** File the Play declaration during MVP development and ship the permission as an opt-in "precision and history" upgrade once approved. Do not make the MVP depend on it. Stream 12's history of Play's 2019 SMS crackdown, and of SMS-reading apps turning into lenders, argues for this caution.

### 3. `sms-pre-debit-notifications` — mandate, AutoPay and bill-due alerts (PRE-SPEND)

- **What it is.** Advance notices sent before a recurring debit: card e-mandates, UPI AutoPay and NACH. Example structure: `… Rs.X will be debited … towards <merchant> … UMRN …`. The RBI e-mandate framework reportedly requires a pre-debit notification at least 24 hours before each charge and lets the customer opt out of that charge **(unverified)**. Also in this class:
  - mandate creation, modification and revocation confirmations (`E-Mandate`, `UPI-Mandate`) [25][29];
  - credit-card statement and due-date alerts;
  - payment requests: `has requested`, `payment request` [32]. NPCI reportedly discontinued P2P UPI collect requests in late 2025 **(unverified)**, so these will mostly be merchant requests.
- **Data available.** Amount, merchant, next deduction date (format varies by bank, e.g. `dd/MM/yy` and `d-MMM-yy` [45]), `UMN`/`UMRN`, and sometimes the masked account [45].
- **Windows.** **PRE-SPEND**, typically ≥ 24 h before the charge **(unverified)**. They also confirm subscriptions POST-SPEND when the charge alert follows.
- **Coverage.** India: card e-mandates, UPI AutoPay, NACH. Elsewhere mostly by email.
- **Privacy, access, reliability.** Same as §1. Failure mode: most open-source parsers *skip* these as "not transactions" [29][32]. BRAKE must route them to a separate `mandate`/`subscription_event` path instead.
- **Dedup keys.** `mandate_id` (UMRN/UMN) and merchant+amount+date. The later charge links through the same UMRN or merchant.
- **Observation.** `kind: "subscription_event"` with `subscription.event = "renewal_upcoming"`, `nextChargeAt`, `price`, plus `references: [{type:"mandate_id"}]`. Or `kind: "mandate"` for set-ups and changes. Confidence 0.9 for a verified sender. These observations never found a spend candidate; they are context (consistent with BRAKE's fusion classes).
- **Provenance** (illustrative values). "Your HDFC Bank SMS says ₹649 will be debited for NETFLIX on 12 Oct."
- **Recommendation: `mvp`.** It is cheap, part of the §1 adapter, and directly enables the brief's renewal intervention in India.

### 4. `merchant-transactional-sms` — order, delivery and refund SMS from merchants

- **What it is.** Service SMS from e-commerce, food-delivery, travel and utility merchants: order placed, out for delivery, refund initiated, booking confirmed. In India they come from DLT headers like the banks' **(unverified per merchant)**.
- **Data available.** Merchant, order id, amount (sometimes), item hints (rarely), refund amount and status.
- **Windows and latency.** POST-SPEND enrichment within minutes. They also give the refund lifecycle. Merchants increasingly use WhatsApp or RCS instead **(unverified)**.
- **Dedup keys.** `order_id` (namespace = merchant key) and refund reference.
- **Observation.** `order`, `delivery` or `refund_notice`. Confidence 0.8. Join-only for delivery, per the fusion design.
- **Provenance.** "Matched your bank alert with a Swiggy order SMS."
- **Recommendation: `next`.** Email (Gmail stream) carries richer order data. SMS adds coverage for users without connected email.

### 5. `sms-balance-and-due-alerts` — balances, limits and statement alerts (context)

- **What it is.** Balances embedded in transaction alerts (`Avl Bal`, `Avl Lmt`, `New M-PESA balance`), plus stand-alone low-balance, statement-generated and minimum-due alerts.
- **Data available.** Available balance or limit, outstanding amount, due date.
- **Windows.** PRE-SPEND context ("payday proximity", "budget cycle"), and the balance chain for verification (see Architecture).
- **Observation.** `balance_snapshot` (context). Never founds a candidate.
- **Recommendation: `mvp`.** It comes free with the §1 parser and powers spoof detection and missed-alert detection.

### 6. `sms-otp-messages` — one-time passwords (AVOID)

- **What it is.** For example: `123456 is your OTP for a Dr. INR 500.00 transaction on your Canara Bank card. Do not share it with anyone.-Canara Bank` [41]. Card e-commerce OTPs often name the amount and merchant. That makes them a tempting **IN-SPEND** signal: the payment is being authorized right now.
- **Why avoid.**
  1. *Security and trust.* An app that reads OTPs is indistinguishable from OTP-stealing malware. Any leak (logs, crash reports, analytics, a cloud LLM) is catastrophic.
  2. *The platform is closing this path.*
     - **Android 15:** "Android will stop untrusted apps that implement a NotificationListenerService from reading unredacted content from notifications where an OTP has been detected" [3]. The exemption permission `RECEIVE_SENSITIVE_NOTIFICATIONS` is `signature|role` [8], so BRAKE cannot hold it.
     - **Android 17:** SMS-Retriever and WebOTP-format OTPs are withheld from non-recipient apps for three hours, for all apps. Standard OTP SMS are withheld for three hours for apps targeting API 37. During the delay "the `SMS_RECEIVED_ACTION` broadcast is withheld and SMS provider database queries are filtered" [1][2].
  3. *Regulatory direction.* RBI's 2025 authentication directions reportedly allow factors other than SMS OTP from 2026 **(unverified)**, so OTP SMS volume may fall anyway.
- **What BRAKE does.**
  - Drops OTP messages at capture: `isOneTimePasswordMessage()` in `@brake/core/privacy` returns `ignored/otp`.
  - Never logs or persists them, and never sends them to any model.
  - Treats India `-T`-suffixed headers as OTP-class, judging by how parsers interpret them [25] **(regulatory meaning unverified)**.
  - Real-world parsers show OTPs slipping through keyword filters. An Amex SafeKey "One-Time Password" got "booked as a card spend" [32]. So test the OTP gate with adversarial fixtures (hyphenation, other languages, "code", "passcode").
- **Recommendation: `avoid`.** Even metadata ("an OTP from HDFC just arrived") stays out of MVP. If ever explored, it needs explicit opt-in and must never read content.

### 7. `android-notification-listener` — messaging-app notifications (SMS, RCS, WhatsApp as rendered)

*(The general notification-listener mechanism belongs to the notification stream. This section covers only its use for messaging apps.)*

- **What it is.** A `NotificationListenerService` that the user enables in system settings. The service must be protected by `BIND_NOTIFICATION_LISTENER_SERVICE` (`signature`) [8]. It receives `onNotificationPosted(StatusBarNotification)` for notifications from the default SMS app (`com.google.android.apps.messaging`, Samsung Messages and so on), which covers SMS **and RCS**, and from WhatsApp, Telegram and other messaging apps.
- **Data actually available.**
  - From `StatusBarNotification`: `packageName`, `postTime` and `key`.
  - From `Notification.extras`: `EXTRA_TITLE` (the sender display name, which may be a saved contact name rather than the header), `EXTRA_TEXT`, `EXTRA_BIG_TEXT` and `EXTRA_TEXT_LINES`. Parsers merge these to recover the full body [48].
  - Filter types (`conversations|alerting|ongoing|silent`) can be declared in the manifest metadata `android.service.notification.default_filter_types` / `disabled_filter_types` [9].
  - `Ranking.hasSensitiveContent()` ("e.g. containing an OTP") is `@SystemApi`, so it is not available to BRAKE [9].
- **Windows and latency.** POST-SPEND within seconds of the message notification. No history: only messages that arrive while the listener is bound.
- **Coverage.** Android, all countries. Not available on low-RAM devices running Android 10 and below [9]. Restricted settings for sideloaded apps (Android 13+) **(unverified in-session)**.
- **Access requirements.** User grant in Settings. No Play declaration form is known for the listener itself, but Play's personal and sensitive data policy (prominent disclosure) applies **(unverified)**.
- **Privacy and consent.** Arguably *broader* than the SMS permission, because it sees every app's notifications: chats, email previews, health apps. BRAKE must:
  - (a) keep a package allow-list, as PennyWise does, which processes only allow-listed packages "to preserve user privacy" [48];
  - (b) apply a sender allow-list inside messaging apps;
  - (c) discard everything else in memory without logging;
  - (d) offer separate BRAKE-level toggles: "Bank SMS/RCS via Messages", "Bank and UPI apps", "WhatsApp business chats". All of them share one OS grant.
- **Reliability and failure modes.**
  - No notification means no capture: the user muted the conversation or category, turned on "do not disturb" for a channel, or uses a messaging app that groups or collapses messages.
  - Sender identity is a *display name*, which is weaker than the SMS originating address.
  - Text can be truncated when only `EXTRA_TEXT` is set.
  - Group summaries duplicate content. Skip `FLAG_GROUP_SUMMARY`, as PennyWise does [47].
  - OEM process killing.
  - Android 15 redacts OTP notifications [3], which suits BRAKE.
- **Dedup keys.** Within the source: `sbn.key` plus a body hash. Across sources: §1 keys. PennyWise layers an exact-hash match with a "same bank + merchant + amount within a ±2-minute window" match between its SMS and notification channels [47].
- **Observation.** Same as §1, with `source.adapterId = "android-notification"`, `provider` taken from the matched sender, and confidence reduced by about 0.05 when only a display name verifies the sender.
- **Provenance.** "Detected from your Messages notification of a Kotak Mahindra Bank alert."
- **Recommendation: `mvp` (Android).** It captures SMS and RCS alerts without the restricted SMS permission and also covers bank and UPI app pushes and WhatsApp. It is the best single Android sensor for India.

### 8. `rcs-business-messaging` — RCS (RBM) bank and merchant messages

- **What it is.** RCS Business Messaging "upgrades SMS with branding, rich media, interactivity, and analytics", delivered to "an RCS-enabled device" in the native messaging app [58]. Senders are RBM *agents*; the agent address format observed on devices is `<brand>_<id>_agent@rbm.goog` [46]. Agent brand verification and carrier launch approval exist but are **unverified** in-session (Google's RBM docs were blocked).
- **Adoption (India, 2026).**
  - Kotak moved UPI "Sent" alerts to RCS, which broke a parser that matched only `JD-KOTAKD-S` (fixed 2026-05-29) [28].
  - SBI Card ("SBI CARDS") and Punjab National Bank ("PUNJAB NATIONAL BANK") alerts arrive over RCS with display-name senders [25][31].
  - Saudi STC Bank RCS purchase alerts are also parsed [STCBankParser in 22].
  - Carrier-level status (Jio, Airtel, Vi) and TRAI's position on RCS spam **(unverified)**.
  - iOS 18+ supports RCS person-to-person; RBM delivery to iPhones **(unverified)**.
- **Data available.** The same transaction text as the SMS alert, sometimes inside a rich-card JSON (`text`, `title`, `description`, `suggestions`) [46], plus the display name and agent id.
- **How a third-party app can read it.**
  - **No public API.** `Telephony` defines no RCS message table, only RCS *configuration* columns [Telephony.java].
  - **Notification listener (supported).** Body and display name, as §7.
  - **Undocumented MMS-provider route.** With `READ_SMS`, rows in `content://mms` whose `tr_id` starts with `proto:` contain a base64 protobuf with the agent address. The text sits in `content://mms/part` (`ct` `text/*`, sometimes JSON) [46]. This is Google Messages implementation behaviour, not an API, and it can disappear without notice.
- **Windows and latency.** POST-SPEND, seconds.
- **Spoofing.** The RBM agent id is a stronger sender identity than an SMS header *if* BRAKE can see it (MMS route). Through notifications, BRAKE sees only a display name. Parsers that match any sender containing "KOTAK" [26] would accept a look-alike display name. BRAKE should require the agent id or corroboration for high confidence.
- **Normalization pitfall.** Styled Unicode (Mathematical Sans-Serif digits and letters) in RCS bodies [25]. Normalize with **NFKC**. Do *not* use NFKD plus an ASCII strip, as one parser does [31]: that deletes `₹` and Indic scripts.
- **Dedup keys.** Same as SMS: the RRN etc. An SMS fallback copy of the same RCS message is possible **(unverified)**, so dedup on body hash and RRN.
- **Provenance.** "Detected from a Kotak Mahindra Bank RCS message (verified business sender)". Say "verified" only when the agent id was matched.
- **Recommendation: `mvp` via the notification listener.** The MMS-provider route is `research` (fragile; requires `READ_SMS`).

### 9. `whatsapp-business-notifications` — WhatsApp transactional messages from banks and merchants

- **What it is.** Businesses send WhatsApp template messages (categories `MARKETING`, `UTILITY`, `AUTHENTICATION`) and interactive `order_details` messages. The published spec's example has `payment_type: upi`, `total_amount`, `items[]` with `retailer_id`, `tax`, `shipping` and `reference_id`. They also send `order_status` updates referencing the same `reference_id`. All of this is visible in Meta's published WhatsApp OpenAPI spec (Graph v23.0) [57], which also lists a `pricing_model` enum `CBP`/`PMP` (presumably conversation-based vs per-message pricing, **unverified**). Bank and merchant use in India and Brazil is reportedly widespread **(unverified)**.
- **Data available to BRAKE.** None through Meta's API. The spec covers only the business side: sending messages, managing templates, and webhooks to the *business*. No endpoint exposes a consumer's chats to a third party [57]. WhatsApp's terms reportedly prohibit automated data collection and unofficial clients **(unverified; page blocked)**. The **only passive path** is the Android notification listener (`com.whatsapp`, `com.whatsapp.w4b`). It gives the business display name and message text, and fails when the user disables previews or mutes the chat.
- **Windows and latency.**
  - PRE-SPEND: cart reminders and offers. These are marketing; don't use them.
  - IN-SPEND: an `order_details` "review and pay" message is a checkout in progress **(unverified how it renders in notifications)**.
  - POST-SPEND: order confirmations, delivery updates, bank alerts.
- **Coverage.** Android only. India and Brazil are the heaviest markets **(unverified)**.
- **Privacy.** End-to-end-encrypted personal chats share the same notification stream. Require a strict business-sender allow-list. Ideally use only senders the user explicitly picks ("Read messages from: Swiggy, HDFC Bank on WhatsApp").
- **Reliability.** Low to medium: preview settings, grouping, and formats that vary by template.
- **Dedup keys.** Order id or `reference_id` if printed; amount + merchant + time.
- **Provenance.** "Detected from a Swiggy WhatsApp message notification."
- **Recommendation: `next`.** Use the notification listener with a per-sender opt-in.

### 9b. `whatsapp-forward-to-brake` — users forward messages to a BRAKE WhatsApp number

- **What it is.** BRAKE runs its own WhatsApp Business account. A user forwards a bank SMS (pasted), a merchant's WhatsApp receipt or a screenshot to it, and BRAKE receives it through Cloud API webhooks.
- **Pros.** Works on **iOS** and Android. It is entirely user-initiated, and it is a natural habit in WhatsApp-first markets.
- **Cons.** Processing happens on the server (Meta and BRAKE both see the content), which goes against "local processing preferred". There are per-conversation or per-message costs **(unverified for 2026)**. Account and number verification add friction.
- **Recommendation: `research`.** Compare it with email forwarding (email stream) and with iOS paste (§12).

### 10. `ios-message-filter-extension` — IdentityLookup SMS filter (AVOID for ingestion)

- **What it is.** An `ILMessageFilterExtension` that "the Messages app can ask … to determine whether the message is unsolicited or otherwise unwanted" [12].
  - It receives `ILMessageFilterQueryRequest` with `sender`, `messageBody` and `receiverISOCountryCode` [13].
  - It returns `ILMessageFilterAction` (`allow`, `junk`, `promotion`, `transaction`) [14].
  - Since iOS 16 it can also return sub-actions such as `transactionalFinance`, `transactionalOrders`, `transactionalReminders`, `transactionalRewards`, `promotionalOffers` and `promotionalCoupons` [15][16].
- **Limits.**
  - "IdentityLookup works only with SMS and MMS messages from unknown senders; it doesn't work with messages from senders in a user's Contacts list or with iMessage messages from any source."
  - "your Message Filter app extension can't access the network directly."
  - "Your app extension also can't write data to containers shared with the containing app." [12]
  - Server deferral goes through a system-handled request to the URL in `ILMessageFilterExtensionNetworkURL` [17].
- **Why avoid.** The extension is designed so it *cannot* hand message content to the app. Using deferral to ship bank SMS to BRAKE's server would turn a spam-filter API into a data-collection channel. That breaks the API's purpose and the App Review data-use rules (5.1.1(iii) minimization; 5.1.2(ii) no repurposing without consent) [21], and risks removal. RCS and iMessage are out of scope anyway.
- **Legitimate use (optional, later).** Ship BRAKE's on-device "transactions vs promotions" classifier as a *filter* that tidies the user's Messages app. That is a user benefit, but it gives BRAKE no data.
- **Recommendation: `avoid`** as a signal source.

### 11. `ios-shortcuts-message-automation` — Shortcuts "Message" automation → BRAKE App Intent

- **What it is.** The user creates a personal automation in Shortcuts: when a message arrives from a sender, or containing a keyword such as "debited", it runs an action that passes the message text to a BRAKE **App Intent** with a `String` `@Parameter`. App Intents are exposed to "Siri, the Shortcuts app, and other system experiences", and parameters are declared with `@Parameter` [19]. The intent parses on-device and creates an observation.
- **Uncertainties.** The trigger's exact capabilities are **unverified** (support.apple.com was blocked): whether the automation can "Run Immediately" without confirmation, whether it fires for alphanumeric bank headers that aren't contacts, and whether the full body is passed as Shortcut input. Prototype on current iOS before promising anything.
- **Windows and latency.** POST-SPEND within seconds, if it runs immediately.
- **Coverage.** iOS. User setup is per bank or keyword and is fiddly, so expect a small motivated segment.
- **Privacy.** Excellent: user-configured, scoped to chosen senders, on-device.
- **Reliability.** Medium to low (automation breakage, confirmations, OS changes).
- **Dedup keys.** §1 keys.
- **Provenance.** "From the HDFC Bank SMS your Shortcut sent to BRAKE."
- **Recommendation: `research`, then `next`.** It is the only near-automatic iOS route to SMS alerts.

### 12. `user-shared-message-text` — copy, paste and share of a message (all platforms)

- **What it is.** The user copies an alert (long-press → Copy) and pastes it into BRAKE. `UIPasteControl` lets the app paste "without a user prompt". Since iOS 16, programmatic pasting otherwise "raises a user alert" [18]. A share extension that accepts text, and a "paste" quick action in a widget, are variants. Android uses the same flow.
- **Data.** Whatever text was copied. Sender identity is **unknown** unless the user picks the bank.
- **Windows.** POST-SPEND (whenever the user does it). The same flow also accepts "Should I buy this?" text, which is PRE-SPEND (manual stream).
- **Privacy.** The best possible: explicit, per message.
- **Reliability.** Parsing is as good as §1. Sender verification is absent, so confidence comes from template match and corroboration, about 0.7–0.85. It is user-asserted, so spoofing risk is low (the user chose it).
- **Provenance.** "From the bank message you pasted on 4 Oct."
- **Recommendation: `mvp` (iOS and fallback).** It costs almost nothing, uses the same parser, and is the honest answer for iOS users in SMS markets.

### 13. `android-default-sms-handler` — becoming the user's SMS app (AVOID)

- **What it is.** The default SMS app receives `SMS_DELIVER_ACTION` and can write to the provider [Telephony.java]. This is the route Play always allows [4].
- **Why avoid.** BRAKE would have to be a full SMS/MMS/RCS client. RCS is effectively Google-Messages-only. It would replace the user's messaging app and take on the whole inbox, which is the most invasive possible posture.
- **Recommendation: `avoid`.**

### 14. `android-sms-retriever-api` — SMS Retriever / User Consent APIs (not applicable)

- **What it is.** APIs that deliver *one* verification SMS (the Retriever needs an 11-character app hash and waits for "ONE matching SMS message until timeout (5 minutes)") without `READ_SMS` [6]. Android 17 points OTP readers to them [1].
- **Why not.** They are designed for an app reading *its own* verification codes, not bank alerts.
- **Recommendation: `avoid`** (out of scope).

---

## Three-window classification

| Source | Pre-spend | In-spend | Post-spend | Latency | Notes |
|---|---|---|---|---|---|
| `sms-bank-alerts` (content) | weak (balances) | — | **strong** | seconds–minutes (unverified) | core real-time sensor in IN/NG; RRN/UTR keys |
| `mobile-money-sms` | — | — (USSD/STK prompt unreadable) | **strong** | seconds (unverified) | KE/TZ/MZ/BD system of record; agent cash-in/out = transfers |
| `android-sms-read` (capture) | via §3 | — | **strong** + history backfill | real-time; backfill on grant | Play-gated, hard-restricted permission; exact sender header |
| `sms-pre-debit-notifications` | **strong** (≥24 h, unverified) | — | links to the later charge | hours–days ahead | India mandates/AutoPay; most trackers discard these |
| `merchant-transactional-sms` | — | — | medium (enrichment, refunds) | minutes | moving to WhatsApp/RCS (unverified) |
| `sms-balance-and-due-alerts` | medium (context) | — | balance-chain verification | real-time | never founds a candidate |
| `sms-otp-messages` | — | (technically strong) **avoid** | — | real-time; Android 17 delays 3 h | drop at capture |
| `android-notification-listener` (messaging apps) | via §3 | — | **strong** | seconds | covers SMS + RCS + WhatsApp; no history; display-name senders |
| `rcs-business-messaging` | via §3 | — | **strong** (growing in IN) | seconds | no API; listener or undocumented MMS route |
| `whatsapp-business-notifications` | marketing (ignore) | possible (`order_details`, unverified rendering) | medium | seconds | listener only; per-sender opt-in |
| `whatsapp-forward-to-brake` | possible ("should I buy") | — | medium | user-paced | server-side; research |
| `ios-message-filter-extension` | — | — | — | — | cannot export data; avoid |
| `ios-shortcuts-message-automation` | — | — | medium | seconds if auto-run (unverified) | iOS only automatic path; research |
| `user-shared-message-text` | yes (manual "should I buy") | — | medium | user-paced | iOS fallback; no sender verification |
| `android-default-sms-handler` | — | — | strong | real-time | avoid (scope, invasiveness) |
| `android-sms-retriever-api` | — | — | — | — | not applicable |

---

## Implications for BRAKE architecture

### A. Split capture from parsing

```
Capture (platform-native, thin)                 Adapter (pure TS, deterministic)          Core
─────────────────────────────────               ─────────────────────────────────         ─────────
SmsReceiver / provider backfill   ─┐
NotificationListener (Messages,    ├─ RawSignal<MessagePayload> ─► sms adapter ──► Observation[] ─► fusion
  bank/UPI apps, WhatsApp)         │    { channel, senderRaw,       (OTP gate → sender verify →
RCS (listener; MMS route = research)│     senderKind, body,          template pack → heuristic →
iOS App Intent (Shortcuts/paste)  ─┘     scTimestamp, receivedAt,   optional on-device LLM → validate)
                                          subId?, capturePath,
                                          publisherPackage? }
```

- **`MessagePayload` fields.**
  - `channel`: `sms | rcs | whatsapp | pasted | shortcut`.
  - `senderKind`: `dlt_header | short_code | alnum | msisdn | rbm_agent | display_name | user_selected`.
  - `capturePath`: `sms_broadcast | sms_provider | notification | mms_provider | app_intent | paste`.
  - `publisherPackage`: for notifications.

  Product logic never branches on these. They only set sender-verification strength and the "How did BRAKE know?" text.
- **Run the OTP gate first, in the capture layer as well as the adapter.** Native capture code should run a cheap OTP check *before* the text crosses into JS or any queue, so that OTPs never sit in a WorkManager input, a log line or a crash breadcrumb. Use `isOneTimePasswordMessage()` from `@brake/core`, plus `-T` header suffixes in India **(regulatory meaning unverified)**.
- **Fix the fusion veto.** The architecture doc vetoes merging two `money_movement`s "from the **same connection**" without a shared reference [internal: fusion-and-reconciliation.md]. One notification-listener grant observes several *independent publishers*, though: the Messages app (bank SMS), the bank's own app and the UPI app all report the same ₹1,249. If they share a `connectionId`, the veto blocks the correct merge and BRAKE triple-counts. **Recommendation:** add a `channelKey` to `SourceRef` (`sms:KOTAKD`, `pkg:com.snapwork.hdfc`, `rcs:kotak_…_agent`) and apply the veto per `(connectionId, channelKey)`. Keep separately the intra-channel rule "same body hash ⇒ `duplicate_delivery`", which handles the broadcast-plus-provider-rescan duplicates [44].

### B. Template packs (data, not code)

- **Template packs are signed, versioned JSON** keyed by *sender entity* (for example `KOTAKD`), not by the full header. The two-letter operator/circle prefix varies, and the suffix encodes category **(prefix semantics unverified)**. Illustrative example: the pattern is built from the verified Kotak sample [27], and `KOTAKD`/`KOTAKB` come from [26]. The RBM agent prefix is a placeholder.

  ```json
  {
    "id": "in.kotak.upi_sent.v3",
    "sender": { "dltEntity": ["KOTAKD", "KOTAKB"], "dltSuffix": ["S"], "rcsDisplayName": ["Kotak Mahindra Bank", "Kotak"], "rbmAgentIdPrefix": ["kotak_"] },
    "pattern": "^Sent (?<cur>Rs\\.?|INR|₹)\\s?(?<amount>[\\d,]+(?:\\.\\d{1,2})?) from (?<acct>X+\\d{3,4}) to (?<payee>.+?) on (?<date>\\d{2}/\\d{2}/\\d{4})\\. UPI ref no\\. (?<rrn>\\d{12})\\.",
    "dateFormat": "dd/MM/yyyy",
    "emit": { "kind": "money_movement", "direction": "debit", "rail": "upi", "references": [{ "type": "rail_reference", "namespace": "upi", "from": "rrn" }] },
    "fixtures": ["…anonymized samples…"]
  }
  ```

  Ship packs over the air so a bank's wording change (or a regulator's header change) doesn't need an app release.
- **Induce templates on-device.** DLT templates are fixed text with variable slots **(unverified as a TRAI requirement; observed in practice)**. Cluster a sender's messages by masking digits, amounts and dates. When a new cluster appears, parse it heuristically and *ask once* ("Is this ₹260 to SAMPLE MART?"). That is the brief's uncertainty-driven labeling. Confirmed clusters become local templates.
- **Heuristic fallback.** Keyword and regex extraction, as in `transaction-sms-parser` (debit `debited|debit|deducted`, credit `credited|…|refund`, `rs.` amount tokens, a "2 of 3 fields present" validity rule) [52][53][54] and PennyWise's base parser [32]. Its own README example outputs `amount: '2343.23'`, which equals the *balance*, for an `INR 2000 debited … Avl Bal- INR 2343.23` input [52]. Heuristic output therefore always gets lower confidence and a consistency check.
- **On-device LLM fallback (optional).**
  - Android: Gemini Nano runs in AICore and keeps data on-device ("AICore isolates requests and stores no input/output records"), exposed through ML Kit GenAI APIs including a Prompt API; device support is limited [7].
  - iOS 26+: the Foundation Models framework offers `@Generable` guided generation into Swift types on Apple Intelligence devices [20]. It also lists Private Cloud Compute and third-party server providers. BRAKE should use on-device only for message text, because App Review 5.1.2(i) requires explicit permission before sharing data "with third-party AI" [21].
  - **Validation rule:** the LLM proposes, a deterministic validator decides. The amount must occur verbatim in the text, the date must parse, and the direction keyword must be present. Otherwise discard the output.
- **Report-a-parse-failure flow.** It must show a redacted preview and send only on explicit tap. Compare PennyWise: opening its report page sends the SMS text and an encrypted device id to the server "right away to generate a parsed preview" [51]. BRAKE should not copy that.

### C. Normalization pitfalls (from real fixtures)

| Pitfall | Evidence | Rule |
|---|---|---|
| Indian lakh grouping | `INR 13,30,614.75` [41] | never assume 3-digit groups; strip separators by locale-agnostic rules |
| Malformed separators | `PKR 55.000.00` [43] | currency-aware parse plus plausibility against balance delta; lower confidence |
| Amount vs balance | README example output [52] | anchor amount to verb (`debited`, `Dr.`, `sent`); check `prevBal − amount ≈ newBal` |
| Date order per *template* | `06/07/26` (dd/mm/yy) [41], `3/18/26, 6:39 PM` (m/d/yy) [42], `19/6/26 at 10:56 pm` [36], `06-FEB-2026`, `2026-01-15 9:36AM` [39] | date format belongs to the template, not the country; fall back to the SC timestamp |
| Timestamps | `SmsMessage.getTimestampMillis()` = service-centre time [10]; provider `date` = receipt | keep both; dedup must not rely on either alone [44] |
| Multipart SMS | concatenation by sender in receiver [49] | concatenate before parsing; earliest timestamp |
| Styled Unicode (RCS) | SBI Card Mathematical Sans-Serif [25] | NFKC; never strip non-ASCII (`₹`, Devanagari) as NFKD+ASCII does [31] |
| Masked tails vary | `XXX123` (3 digits), `XXXXXX1234`, `*1234`, `******4321`, `ending 6788`, `x1234` | store a `maskedTail` with its length; only call it `last4` when it has 4 digits |
| Credit card "debited" | `debited to your … Credit Card` [42] | instrument = credit card ⇒ spend on card, not a bank-account debit; the later bill payment is `credit_card_payment` |
| Foreign currency | `USD 11.80 spent using ICICI Bank Card` [24] | `amount` in USD; the INR amount comes later from the statement or ledger |
| Fees inside messages | M-Pesa `Transaction cost`, bKash `Fee Tk`, `a taxa foi de` [35][37][38] | `amountBreakdown.fee`; total = amount + fee for budget |
| Non-transactions with amounts | payment requests, `will be debited`, declined, ATM usage counters, NACH "for processing", promos [29][32][33][41] | classify into context kinds or `ignored`; never `money_movement` |
| Shared sender across countries | M-Pesa KE/TZ/MZ [34] | content-aware dispatch; currency token decides |
| Transfers | agent cash-in, IMPS/NEFT to self, wallet loads | `typeHints: transfer` with probability; RRN pairing (below) |
| Links and phone numbers in alerts | `Tap <link> to report`, `SMS BLOCKUPI to …` [27][41] | never render or follow; redact from excerpts |

### D. Reconciliation hooks specific to messaging

- **RRN pairing.** A debit alert and a credit alert carrying the same `upi` RRN, on two instruments the user owns, form an own-account transfer. The direction veto already stops a merge. Reconciliation should link them as `transfer_counterpart` with probability about 0.98.
- **Balance chain.** Keep `(instrument, balance, observedAt)` per account. If a new alert's `prevBalance − amount` differs from its stated balance by more than a tolerance, either an alert was missed or this one is forged. Lower confidence and, if it repeats, ask the user. This is also the main defence against forged *credit* alerts.
- **Mandate linkage.** A `subscription_event{renewal_upcoming}` with a UMRN, followed by a debit carrying the same merchant or UMRN, gives the charge `typeHints: subscription` (0.9) and supports "price increased" detection.
- **AA and email corroboration.** An SMS-founded candidate is promoted to `posted` when the AA or bank-ledger record with the same RRN or amount and date arrives (the AA stream owns the details).

### E. Sender verification and anti-spoofing

1. **Allow-list by sender entity:**
   - **India:** strip the operator/circle prefix and the category suffix. Accept `-S` for alerts. Treat `-T` as OTP and `-P` as promo, and drop both [24][25]. A **10-digit mobile number** claiming to be a bank goes straight to low confidence plus a phishing hint.
   - **Short codes:** for example Chase `24273` [40].
   - **Alphanumeric IDs:** for example `MPESA`, `bKash`.
   - **RBM:** agent id prefix.
   - **Notifications:** publisher package allow-list [48].
2. **Template conformance.** A known sender sending an unknown template gets medium confidence plus "Is this right?". A known template from an unknown sender is a *suspected spoof*.
3. **Provider integrity.** Only the default SMS app can write to the SMS provider [Telephony.java], so other apps cannot inject inbox rows. On the notification path, any app can *post* a look-alike notification, so trust only allow-listed publisher packages, never the notification text's claimed bank.
4. **Corroboration and stakes.** An observation founded only by a single unverified message cannot trigger friction or strong insight copy. Credits from SMS alone ("fake credit alerts", reportedly common in Nigeria, **unverified**) never count as income until corroborated or confirmed by the user.
5. **Help the user, carefully.** If a message fails verification, say "This message didn't come from a known HDFC Bank sender. It may be phishing." Don't overreach into a security product.

### F. Data minimization specifics

- Persist the observation plus `evidence.summary`. Keep a redacted excerpt only with a TTL (for example 7 days). Never keep the raw body.
- Store references as **keyed hashes** (`HMAC(userKey, namespace|value)`) for matching, plus the last 4 characters for display. Fusion needs only equality.
- Treat counterparty names of private individuals as on-device only and exclude them from any server sync. Merchants may sync.
- Make backfill depth a user choice (30, 90 or 365 days). Give each source a disconnect action that purges its observations, which the architecture already supports.

### G. Capability-registry facts (proposed entries; `asOf: 2026-10-04`)

Capability ids follow `packages/capabilities` naming. `V` = verified in this stream's sources, `U` = unverified.

| Scope | Capability id | Status | Note | Evidence |
|---|---|---|---|---|
| IN | `alerts:sms-bank-alerts` | available | near-universal bank/card/UPI SMS; RBI mandate | U (mandate); V (formats [24]–[29][41][42]) |
| IN | `alerts:rcs-bank-alerts` | emerging | Kotak UPI "Sent" alerts on RCS (2026-05); SBI Card, PNB | V [25][28][31] |
| IN | `sms:sender-registry` (DLT headers) | available | `XX-ENTITY-S`; `-T/-P/-G` other categories | V (observed) / U (regulation) |
| IN | `alerts:pre-debit-notifications` | available | e-mandate/AutoPay advance notice ≥ 24 h | U |
| IN | `alerts:whatsapp-transactional` | limited | merchant/bank WhatsApp; listener-only access | U (prevalence); V (API is business-side [57]) |
| KE | `alerts:mobile-money-sms` | available | M-PESA confirmations, 10-char code | V [35] |
| TZ | `alerts:mobile-money-sms` | available | M-Pesa, Tigo Pesa, Selcom | V [36] |
| MZ | `alerts:mobile-money-sms` | available | M-Pesa in Portuguese, fee inline | V [37] |
| BD | `alerts:mobile-money-sms` | available | bKash TrxID | V [38] |
| PK | `alerts:push-bank-alerts` | available | Faysal Bank via app notification; RAAST/IBFT | V [43][48] |
| PK | `alerts:sms-bank-alerts` | unknown | not established | U |
| NG | `alerts:sms-bank-alerts` | available | GTBank/Access/Zenith/Opay formats; fees reportedly charged | V (formats [39]); U (fees) |
| NP, TH, ET, SA, AE | `alerts:sms-bank-alerts` | available | 13/11/9/7/6 institutions parsed | V (coverage proxy [23]) |
| ID | `alerts:sms-bank-alerts` | unknown | no parser coverage; push/e-wallet led | U |
| BR | `alerts:sms-bank-alerts` | limited | push and WhatsApp dominant | U |
| US | `alerts:sms-bank-alerts` | limited | opt-in (e.g. Chase short code 24273); push dominant | V (format [40]); U (prevalence) |
| GB, EU | `alerts:sms-bank-alerts` | limited | push dominant | U |
| android | `os:sms-read` | limited | hard-restricted; Play default-handler/exception | V [4][8] |
| android | `os:notification-listener` | available | user grant; OTP redaction for untrusted listeners (15+) | V [3][9] |
| android | `os:otp-sms-delay` | available (17+) | 3 h withholding of OTP SMS | V [1][2] |
| android | `os:rcs-read` | unavailable | no public API; listener or undocumented MMS route | V [Telephony.java][46] |
| android | `os:on-device-llm` | limited | Gemini Nano / ML Kit GenAI on supported devices | V [7] |
| ios | `os:sms-read` | unavailable | no SMS/RCS/iMessage access | V [12] |
| ios | `os:message-filter-extension` | limited | unknown senders only; no export; not an ingestion path | V [12][13] |
| ios | `os:paste-control` | available (16+) | paste without prompt | V [18] |
| ios | `os:shortcuts-message-trigger` | unknown | automation passes message text to App Intent | U |
| ios | `os:on-device-llm` | limited (26+) | Foundation Models; Apple Intelligence devices | V [20] |
| GLOBAL | `api:whatsapp-consumer-read` | unavailable | business-side API only | V [57] |

---

## Risks, policy constraints and ethical concerns

1. **Play policy risk.**
   - Removal or rejection on the SMS route: the 2019 precedent is in stream 12.
   - Runtime-permission and disclosure flaws get apps rejected even when the use case is allowed [56].
   - *Mitigation:* the notification-listener MVP; the SMS permission strictly opt-in; a declaration prepared early.
2. **Trust and association with predatory lending.** In India, SMS-reading apps became associated with lending and harassment. Walnut became a lender (stream 12). BRAKE needs an architectural guarantee, stated in product copy, that sensed messages never feed credit, advertising or affiliate decisions and never leave the device raw.
3. **Over-collection.** Both the SMS permission and the notification listener expose personal communications. Filter at the capture boundary, keep allow-lists the user can see, and never write non-financial messages to disk, logs or crash reports. Crash reporters that capture string arguments are a classic leak vector.
4. **OTP leakage.** It is the highest-severity failure. Gate in native code, run adversarial tests (hyphenation, languages, "passcode", amount-bearing OTPs [32][41]), and never feed message text to cloud models.
5. **Spoofing and phishing amplification.** If BRAKE confidently says "HDFC debited ₹9,999" because of a spoofed SMS, it lends credibility to a scam. Never render links from messages, require verified senders for confident copy, and use the balance-chain check.
6. **Shared phones and family accounts.** In India one mobile number often receives alerts for several family members' accounts **(unverified prevalence)**. BRAKE would then observe other people's finances. Ask "Is this account yours?" on first sight of each new masked account, and offer a per-account ignore (PennyWise has "ignored account" handling [47]).
7. **Third-party personal data.** Counterparty names and phone numbers in P2P alerts belong to other people. Keep them on-device, avoid syncing, and avoid showing them in shareable views.
8. **Legal: interception and consent** (all **unverified**; obtain local counsel).
   - Reading messages *already delivered* to the user's own device, with the user's explicit opt-in, is generally not "interception in the course of transmission". Still, frameworks differ:
     - India: Telecommunications Act 2023, IT Act, DPDP Act 2023 and Rules 2025 (consent notices, purpose limitation, phased obligations).
     - EU: ePrivacy Directive Art. 5 (confidentiality of communications) plus GDPR (consent, DPIA for large-scale financial data).
     - US: Wiretap Act one-party consent, but state all-party-consent statutes and CIPA-style litigation.
     - Kenya: Data Protection Act 2019.
     - Nigeria: NDPA 2023.
     - Brazil: LGPD.
     - Indonesia: PDP Law 27/2022.
   - Design for the strictest reading: explicit, granular, revocable consent per source; purpose-bound use; on-device processing.
9. **Platform drift.**
   - Android 17's OTP heuristics could delay legitimate alerts that look OTP-like by 3 hours [1][2].
   - Google Messages may stop exposing RBM in `content://mms` at any time.
   - Banks move channels (SMS → RCS → app push), and regulators change header formats.
   - The registry and template packs must be OTA-updatable, and capture health must be monitored on-device ("no alerts from HDFC in 10 days — still connected?").
10. **WhatsApp terms.** Automated reading of WhatsApp beyond OS notifications (accessibility scraping, unofficial clients) risks account bans for the user and policy violations **(unverified terms text)**. Use only the notification listener with explicit per-sender opt-in.
11. **Accessibility-service misuse.** Using an AccessibilityService to read message content is a non-accessibility use and is policy-prohibited on Play **(unverified current text)**. Avoid it.
12. **Behavioural ethics.** Alerts are high-frequency. Respond only when there is meaningful insight, as the brief says ("say nothing if there is no meaningful insight"), and never add a BRAKE notification on top of every bank SMS.

---

## Open questions

1. Does Google Play (2026) approve a non-lending budgeting app for `READ_SMS`/`RECEIVE_SMS` under an exception, and with what declaration wording, video and disclosure? Run a test submission early.
2. What is the exact current TRAI rule on header suffixes (`-S/-T/-P/-G`) and the operator/circle prefix, and do *all* bank transaction alerts now use `-S`? Get the primary TRAI text.
3. How fast is the SMS → RCS migration among Indian banks? Does every RCS alert also reach the notification listener with full text, and can the RBM agent id be verified without the undocumented MMS route?
4. Does Android 17's standard-SMS OTP classifier ever trigger on transaction alerts that contain "OTP" only as a disclaimer ("Never share your OTP")? Measure it on a fixture corpus once BRAKE targets API 37.
5. What share of Indian Android users silence the Messages app's transaction notifications or categories? That share is invisible to the listener-only MVP.
6. Can the iOS Shortcuts Message trigger run without confirmation for alphanumeric bank senders and pass the full body to an App Intent on the current iOS release?
7. Will RBI's alternative-authentication directions change bank alerting volumes or formats in 2026–27, and are any changes coming to the 2017 alert mandate?
8. Kenya: does Safaricom or the ODPC have a position on third-party apps parsing M-PESA SMS, and do digital-lender regulations spill over onto PFMs that read SMS?
9. Nigeria: how many users opt out of SMS alerts because of fees and rely on email or app alerts? Indonesia and Brazil: what are the current alert-channel shares?
10. How can template packs improve without collecting raw SMS? Options include user-submitted redacted samples, synthetic fixtures from bank-published formats, and federated template induction.
11. Should `SourceRef` gain a `channelKey` (proposed in §A) so that the same-connection veto in fusion does not block merging one event seen by several publishers through one listener?
12. Which form of RRN storage (keyed hash vs plaintext) does the AA stream need for its own matching, so that both streams share one convention?

---

## References

All URLs below were opened in this research session (2026-10-04) unless marked otherwise.

1. https://developer.android.com/about/versions/17/behavior-changes-all — Android 17 (API 37) "SMS OTP protection" for all apps: WebOTP and SMS-Retriever-format OTPs withheld 3 h; `SMS_RECEIVED_ACTION` withheld and provider queries filtered; exemptions; page updated 2026-10-01.
2. https://developer.android.com/about/versions/17/behavior-changes-17 — Android 17 standard-SMS OTP delay for apps targeting API 37; exemptions (default SMS assistant, companion apps).
3. https://developer.android.com/about/versions/15/behavior-changes-all — Android 15 OTP redaction for untrusted `NotificationListenerService`s; screen-share protections; page updated 2026-10-01.
4. https://developer.android.com/guide/topics/permissions/default-handlers — Play restricts call/messaging permission groups to default handlers or exception cases; updated 2026-02-26.
5. https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions — `SMS_RECEIVED_ACTION` is an implicit-broadcast exception.
6. https://developer.android.com/identity/sms-retriever — SMS Retriever: no `READ_SMS`, 11-character app hash, one message, 5-minute timeout.
7. https://developer.android.com/ai/gemini-nano — Gemini Nano in AICore, ML Kit GenAI (Prompt, Summarization…), on-device privacy; updated 2026-09-08.
8. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/res/AndroidManifest.xml — `READ_SMS`/`RECEIVE_SMS` are `dangerous` + `hardRestricted`; `RECEIVE_SENSITIVE_NOTIFICATIONS` is `signature|role`; `BIND_NOTIFICATION_LISTENER_SERVICE` is `signature`.
9. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/service/notification/NotificationListenerService.java — filter-type metadata, `FLAG_FILTER_TYPE_*`, `Ranking.hasSensitiveContent()` (@SystemApi), low-RAM restriction.
10. https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/telephony/java/android/telephony/SmsMessage.java — `getTimestampMillis()` returns the service-centre timestamp. **[Telephony.java]** = https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/java/android/provider/Telephony.java — only the default SMS app writes to the provider; `SMS_RECEIVED_ACTION` non-abortable, multi-app; columns `address`, `body`, `date`, `date_sent`, `sub_id`, `creator`; MMS `tr_id`; no RCS message table.
11. https://github.com/aosp-mirror/platform_frameworks_base — mirror archived 2023-11-08. AOSP facts above reflect that snapshot and are corroborated for Android 15/17 by [1]–[3].
12. https://developer.apple.com/documentation/identitylookup/sms-and-mms-message-filtering (read via the developer.apple.com JSON documentation endpoint) — unknown senders only; no direct network; no writes to shared containers.
13. https://developer.apple.com/documentation/identitylookup/ilmessagefilterqueryrequest — `sender`, `messageBody`, `receiverISOCountryCode`.
14. https://developer.apple.com/documentation/identitylookup/ilmessagefilteraction — `none`, `allow`, `junk`, `promotion`, `transaction`.
15. https://developer.apple.com/documentation/identitylookup/ilmessagefiltersubaction — iOS 16+ transactional/promotional sub-actions.
16. https://developer.apple.com/documentation/identitylookup/ilmessagefiltercapabilitiesqueryresponse — `transactionalSubActions`, `promotionalSubActions`.
17. https://developer.apple.com/documentation/identitylookup/creating-a-message-filter-app-extension — `ILMessageFilterExtensionNetworkURL`, associated domains.
18. https://developer.apple.com/documentation/uikit/uipastecontrol — paste without prompt; iOS 16 paste alert.
19. https://developer.apple.com/documentation/appintents/appintent — App Intents exposed to Shortcuts/Siri; `@Parameter`.
20. https://developer.apple.com/documentation/foundationmodels — on-device models, `@Generable`, iOS 26+, Apple Intelligence devices; PCC/server providers also listed.
21. https://developer.apple.com/app-store/review/guidelines/ — 5.1.1 (consent, minimization, (ix) regulated financial services), 5.1.2 (explicit permission incl. third-party AI; no repurposing).
22. https://github.com/sarim2000/pennywiseai-tracker — open-source on-device bank-SMS tracker: 159 institutions / 25 countries; Play, F-Droid, iOS builds; per-bank parsers plus on-device LLM; the STC Bank RCS parser is in this repo.
23. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/docs/supported-banks.json — per-country coverage counts.
24. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/ICICIBankParser.kt — DLT regexes `^[A-Z]{2}-ICICIB-S$`, `-[TPG]$`; card-abroad format.
25. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/SBIBankParser.kt — `-S` "for transactions", `[TPG]` "OTP, Promotional, Govt"; SBI Card RCS sender; Mathematical Sans-Serif text; UPI-mandate detection.
26. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/KotakBankParser.kt — `^[A-Z]{2}-KOTAK[A-Z]-[ST]$`; RCS display-name senders.
27. https://github.com/sarim2000/pennywiseai-tracker/issues/360 — Kotak alert sample from sender `JD-KOTAKD-S` (2026-05).
28. https://github.com/sarim2000/pennywiseai-tracker/pull/375 — Kotak migrated UPI "Sent" alerts from SMS to RCS; display-name senders; merged 2026-05-29.
29. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/HDFCBankParser.kt — HDFC formats; e-mandate and "will be debited" future-debit parsing; NACH skip.
30. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/CompiledPatterns.kt — HDFC DLT patterns; `UPI Ref No (\d{12})` and other reference regexes.
31. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/PNBBankParser.kt — PNB RCS sender; NFKD + ASCII strip normalization (pitfall).
32. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/BankParser.kt — shared OTP/promo/payment-request filters; Amex SafeKey OTP "booked as a card spend".
33. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/FinancialMessageSafety.kt — content-only OTP/failure/notice detection; no sender verification.
34. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/BankParserFactory.kt — content-aware dispatch; M-Pesa sender shared across KE/TZ/MZ.
35. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/MPESAParser.kt — Kenya M-PESA formats, 10-char code, balance regex.
36. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/test/kotlin/com/pennywiseai/parser/core/bank/TanzaniaParserTest.kt — M-Pesa TZ, Selcom Pesa, Tigo Pesa samples.
37. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/test/kotlin/com/pennywiseai/parser/core/bank/MPesaMozambiqueParserTest.kt — Portuguese M-Pesa samples with fees.
38. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/BkashParser.kt — bKash formats, `TrxID`.
39. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/GTBankParser.kt — Nigeria GTBank multi-line format.
40. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/bank/ChaseBankParser.kt — Chase short code `24273`; alert format.
41. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/test/kotlin/com/pennywiseai/parser/core/bank/CanaraBankParserTest.kt — Canara UPI/RTGS samples; OTP-with-amount sample; ATM usage notice.
42. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/test/kotlin/com/pennywiseai/parser/core/bank/JupiterBankParserTest.kt — RuPay credit card on UPI; m/d/yy date.
43. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/test/kotlin/com/pennywiseai/parser/core/bank/FaysalBankParserTest.kt — Pakistan RAAST/IBFT/debit card samples; `PKR 55.000.00`.
44. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/ParsedTransaction.kt — dedup key `sender|amount|md5(body)` across broadcast vs provider timestamps.
45. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/parser-core/src/main/kotlin/com/pennywiseai/parser/core/MandateInfo.kt — mandate fields (amount, next deduction date, merchant, UMN, account).
46. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/app/src/main/java/com/pennywiseai/tracker/worker/OptimizedSmsReaderWorker.kt — RCS read from `content://mms` (`tr_id LIKE 'proto:%'`), agent `…_agent@rbm.goog`, `content://mms/part`, rich-card JSON.
47. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/app/src/main/java/com/pennywiseai/tracker/receiver/BankNotificationListenerService.kt — package allow-list; skip group summaries; exact-hash plus ±2-minute cross-channel dedup; ignored-account handling (#826).
48. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/app/src/main/java/com/pennywiseai/tracker/receiver/BankNotificationConfig.kt — allowed packages (e.g. Faysal, Chase UK); extras merge (`EXTRA_BIG_TEXT`, `EXTRA_TEXT_LINES`, `EXTRA_TEXT`, `EXTRA_SUMMARY_TEXT`).
49. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/app/src/main/java/com/pennywiseai/tracker/receiver/SmsBroadcastReceiver.kt — `getMessagesFromIntent`; multipart concatenation by originating address.
50. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/app/src/main/AndroidManifest.xml — `READ_SMS`, `RECEIVE_SMS`, `SMS_RECEIVED` receiver priority 999, notification listener service.
51. https://raw.githubusercontent.com/sarim2000/pennywiseai-tracker/main/PRIVACY.md — on-device parsing; parse-report flow sends SMS text to server on page open (cautionary).
52. https://github.com/saurabhgupta050890/transaction-sms-parser and https://raw.githubusercontent.com/saurabhgupta050890/transaction-sms-parser/master/README.md — regex SMS parser; output shape; README example where amount equals balance.
53. https://raw.githubusercontent.com/saurabhgupta050890/transaction-sms-parser/master/src/library/engine.ts — debit/credit keyword regexes; `rs.` amount extraction; 2-of-3 validity rule.
54. https://raw.githubusercontent.com/saurabhgupta050890/transaction-sms-parser/master/src/library/constants.ts — balance keywords, wallet names, UPI keywords and handles.
55. https://registry.npmjs.org/transaction-sms-parser — package metadata (v3.3.3, MIT).
56. https://github.com/moneymanagerex/android-money-manager-ex/issues/2709 — Play rejection (2025-08-27) for an improper SMS runtime-permission flow.
57. https://github.com/facebook/openapi and https://raw.githubusercontent.com/facebook/openapi/main/business-messaging-api_v23.0.yaml — Meta WhatsApp Business API (v23.0): business-side endpoints only; template categories; `order_details` (`payment_type: upi`), `order_status`; `pricing_model` `CBP`/`PMP`.
58. https://raw.githubusercontent.com/google-business-communications/nodejs-rcsbusinessmessaging/master/README.md — RBM description ("upgrades SMS with branding, rich media…", RCS-enabled devices).
59. https://github.com/google-business-communications — Google's RBM sample/client repositories.

**Internal cross-references (not URLs):**
- `docs/brief.md`
- `docs/architecture/fusion-and-reconciliation.md` (same-connection veto, pair windows)
- `docs/research/12-prior-art-and-competitors.md` (Walnut/axio history, Play 2019 SMS policy, `android-notification-listener` assessment)
- `packages/core/src/privacy/redact.ts` (`isOneTimePasswordMessage`, `redactSensitive`)
- `packages/core/src/adapter.ts` (`IgnoreReason: "otp"`)
- `packages/capabilities/src/types.ts` (capability id naming)

**Attempted but blocked by the research environment (claims depending on them are marked unverified):**
- RBI notification pages (www.rbi.org.in, rbidocs.rbi.org.in)
- www.trai.gov.in
- www.npci.org.in
- pib.gov.in
- Google Play Console Help and policy pages (support.google.com, play.google.com)
- developers.google.com (SMS Retriever, RBM)
- developers.facebook.com (WhatsApp pricing)
- www.whatsapp.com (terms)
- www.safaricom.co.ke
- support.apple.com and help.apple.com (Shortcuts)
- en.wikipedia.org
- eur-lex.europa.eu, www.law.cornell.edu, www.legislation.gov.uk
