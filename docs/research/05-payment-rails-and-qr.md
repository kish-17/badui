# Research Stream 05: Payment rails, UPI intents and QR payment data

> **Scope.** This stream covers what payment rails and payment-initiation formats can tell BRAKE before, during and after a payment. It includes UPI deep-link and intent URLs, UPI QR (static, dynamic and signed), P2P vs P2M detection, UPI Lite, AutoPay, UPI Circle, credit on UPI, UPI references (RRN/UTR) and Android vs iOS intent behaviour. It covers the EMVCo Merchant-Presented Mode (MPM) QR format and its national profiles (Bharat QR, Pix BR Code, SGQR/PayNow, PromptPay, DuitNow, QRIS, QR Ph, VietQR, KHQR). It also covers other rails that matter for agnosticism (Pix Automatico and Pix por aproximacao, Swish, Bizum, BLIK, iDEAL/Wero, Vipps MobilePay, M-Pesa, Alipay/WeChat Pay/Alipay+, PayPay, FedNow/RTP, SEPA Instant) and web checkout (Payment Request API, Secure Payment Confirmation, Apple Pay on the web, Google Pay API, confirmation pages and redirects).
>
> **Date:** 2026-10-04. Every time-sensitive claim is "as of 2026-10-04" unless it carries its own date.
>
> **Research constraints (read before relying on this document).** The session's web-search budget ran out after a handful of queries, and the network egress allowlist blocked most primary sites: npci.org.in, rbi.org.in, bcb.gov.br, emvco.com, w3.org, developers.google.com, developer.chrome.com, the Stripe/Adyen/Razorpay docs and news sites. Sources that *were* reachable: github.com and raw.githubusercontent.com (including official repositories from Banco Central do Brasil, W3C, MDN browser-compat-data, Vipps MobilePay, PayPay and Safaricom), developer.android.com, Apple's developer documentation JSON, and the npm registry. As a result:
> - Facts marked **[P]** were confirmed against a primary source in this session (an official spec, an official repository, or platform documentation).
> - Facts marked **[S]** were confirmed against a secondary source: a community library that implements a spec, a third-party index of NPCI circulars, or a search-result snippet that cites a primary source.
> - Facts marked **(unverified)** come from prior knowledge and were **not** confirmed in this session. Treat them as hypotheses to check before building on them.
> - Facts marked **[C]** were added or re-checked by the 2026-10-04 adversarial fact-check against the **verbatim text of the NPCI circular** (PDF text extracted into `index/chunks.json` of the UPI-Brain repository [47]). This is stronger than [S] but still not npci.org.in itself, which remained unreachable.
>
> **Fact-check note (2026-10-04).** Reference [12] (`pdf_summaries.json`) contains **LLM-generated (Gemini) summaries** written for an intern's chatbot project. They are not NPCI text. The fact-check re-verified the load-bearing NPCI claims against the extracted circular text [47] and found one hallucinated detail (a "Merchant Identifier Code" in OC-201B) and several omissions that matter for BRAKE. The biggest are the intent and QR-share restrictions in OC-73, OC-76 and OC-76A/C (§1, §2). The index covers circulars up to about May 2026 (OC-231), so any NPCI change from June to October 2026 is **not** reflected here. See the "Verification log" at the end.
>
> ### Key takeaways for BRAKE
> 1. **A user-initiated "Scan with BRAKE" QR flow is the best rail-level signal for the MVP.** It is the only payment-rail signal that reliably arrives *before* authorisation on both Android and iOS. One EMVCo MPM TLV parser plus a small profile registry decodes Bharat QR, Pix, SGQR/PayNow, PromptPay, DuitNow, QRIS, VietQR and KHQR. A second parser handles `upi://pay` URIs. That covers most of the large QR-payment markets with two parsers. [P]/[S] **Caveat (fact-check, [C]):** in India the *hand-off* after a BRAKE scan is constrained. Re-launching the scanned `upi://` string as an Android intent is disallowed for **P2P** payees and for **offline non-verified merchants** (initiation modes `04`/`05`; NPCI OC-76A/OC-76C). Sharing the QR image into a UPI app ("QR share & Pay") is capped at **₹2,000** for P2P and non-verified offline P2M. So for the typical street-shop sticker, BRAKE's scan is a pre-spend *observation*, and the user has to re-scan in their UPI app.
> 2. **Static and dynamic QRs differ sharply in value.** A static QR (EMV tag `01`=`11`, or a UPI QR without `am`) identifies the payee but carries no amount. A dynamic QR (`01`=`12`, or UPI with `am`+`tr`) carries the amount and a merchant reference. A dynamic Pix code can hold the charge behind a location URL (tag `26`.`25`), and BRAKE should **not** fetch that URL by default. [S]
> 3. **Intercepting `upi://` intents on Android is technically possible but should not be MVP.** Any app can declare the intent filter, and Android then shows a disambiguation dialog [P]. To do it, BRAKE would have to sit inside a regulated flow, forward the URI byte-for-byte (signed intents use `mode`=`02`/`05` with `sign`+`orgid`), and relay the result fields `txnId`, `responseCode`, `ApprovalRefNo`, `Status` and `txnRef` back to the merchant app [S]. No NPCI rule that explicitly addresses *non-PSP* intermediaries was found. NPCI does regulate who answers intents, though. **OC-73 (14 Sep 2019)** says UPI apps "must respond to Intent call from merchant App only in cases where the customer has registered & has also SET UPI PIN for the specific App", "to avoid clutter on the screen and also increase success rates". **OC-76A/76C** disallow P2P intent transactions (modes `04`/`05`) and intents to offline non-verified merchants [C]. A non-UPI app appearing in the intent chooser runs against the stated intent of OC-73. Recommendation: **research** (unchanged, with a lower expected value).
> 4. **iOS has no UPI chooser.** "If multiple apps register the same scheme, the app the system targets is undefined" [P]. Handing off from BRAKE on iOS needs app-specific schemes (for example `phonepe://pay`, `tez://upi/pay`, `paytmmp://pay` [S][49]). *Detecting* which of those apps is installed (`canOpenURL`) requires declaring the schemes in `LSApplicationQueriesSchemes`. That list is capped at 50 entries for apps linked on iOS 15 or later, and **25 entries for apps linked on iOS 27 or later** [P]. **Correction:** the cap limits only *probing*. Apple states that `open(_:options:completionHandler:)` "isn't constrained by the `LSApplicationQueriesSchemes` requirement" [10][P], so BRAKE can open any user-chosen app scheme without declaring it.
> 5. **UPI no longer means a debit from a bank account.** A UPI payment can be funded by a UPI Lite on-device balance (₹1,000 per transaction, ₹5,000 balance), a RuPay credit card, a pre-sanctioned credit line, a Reserve Pay block, or a delegated UPI Circle payment [S]. Adapters must emit `payment_rail`, `funding_instrument` and `initiator` as separate fields. Without that, BRAKE double-counts (for example a credit-card UPI spend followed by the card-bill payment) and mislabels transfers.
> 6. **P2P vs P2M can be classified from the payload.** The signals are UPI `mc` (with MCC `7407` reserved for P2PM small merchants), the presence of `tr`/`sign`/`orgid`, and EMV tag `52`. **P2P collect requests have been discontinued since 1 Oct 2025** (NPCI OC-220, dated 29 Jul 2025) [C], so an incoming collect request is now almost always from a merchant. For EMV profiles, the MAI GUID can also separate P2P from P2M. QR Ph uses `com.p2pqrpay` (tag `27`) for P2P vs `ph.ppmi.p2m` (tag `28`) for P2M [S], and VietQR's service code `QRPUSH` marks merchant payments [S].
> 7. **UPI AutoPay pre-debit notifications are a real PRE-SPEND subscription signal.** A pre-debit notification (PDN) is sent 24 hours before mandate execution, with MCC-specific exemptions (FASTag/NCMC auto-replenishment) [S]. NPCI's 2025-26 changes let users view and port mandates across UPI apps [S]. None of this gives third parties an API, so BRAKE has to read the PDN through SMS or notifications.
> 8. **A few UPI apps carry most of the volume.** As of May 2026, PhonePe + Google Pay held about 79% and the top 3 about 87%. This comes from social-media and blog posts citing NPCI; the fact-check could not reach any of them, so treat it as **(unverified)**, including whether the figures are by volume or value. Notification parsers for 3–5 apps plus bank SMS therefore probably cover most UPI volume on Android. The NPCI 30% per-app volume cap deadline was extended to **31 Dec 2026** (OC-210) [C]. No later circular changing it appears in the index, which runs to about May 2026, so the market shares are still moving.
> 9. **Reconciliation keys exist, but merchant references rarely reach the consumer.** The UPI RRN (12-digit), the payee VPA, Pix `endToEndId`/`txid`, the M-Pesa receipt number, the KHQR MD5 hash, the Vipps `reference` and the PayPay `merchantPaymentId` are all usable keys. Merchant-side references such as UPI `tr` and EMV `62`.`05` rarely appear in consumer-visible alerts, so dedup should bridge on **payee identifier + amount + time** first.
> 10. **Web checkout APIs deliberately hide payment details from third parties.** This applies to Payment Request, SPC, Apple Pay JS and Google Pay. A browser extension can observe only the page DOM and URL (cart totals, "Place order" clicks, confirmation pages). SPC is Chromium-only (Chrome/Edge 95+; not Firefox, Safari or Android WebView; still flagged experimental in MDN BCD as of 2026-10-04). Payment Request in Firefox is still behind preferences [P]. Other A2A rails (Swish, Bizum, BLIK, Wero/iDEAL, Vipps MobilePay, FedNow/RTP, SEPA Instant) expose nothing directly to a consumer app. In BRAKE they are **rail labels in the registry, not adapters**, and their data reaches BRAKE through notifications, SMS, email and open-banking feeds.

---

## Sources investigated

Each subsection follows the same template: what it is, the data actually available, time windows and latency, coverage, access, privacy, reliability, dedup keys, the normalised BRAKE observation, a provenance sentence, and a recommendation.

### 1. UPI deep-link / intent URL (`upi://pay`): Android intent handler (`upi-intent-url`)

**What it is.** NPCI's *UPI Linking Specification* defines a URI format, `upi://pay?param=value&...`. Merchant apps, websites (mobile web "Pay by UPI app" buttons) and QR codes use it to hand a payment to a UPI PSP app such as PhonePe, Google Pay, Paytm or BHIM. The most commonly circulated public copy is "NPCI UPI Linking Specifications 1.6, November 2017" [1][S]. Later NPCI addenda extended it with signing and initiation-mode tags.

**Parameters (data actually available).**

| Param | Meaning | Presence / format | Verification |
|---|---|---|---|
| `pa` | Payee VPA (UPI ID), e.g. `merchant@okaxis` | Mandatory | [S] [2][3] |
| `pn` | Payee name (merchant-supplied, free text) | Mandatory | [S] [2] |
| `mc` | Payee merchant code: a 4-digit ISO 18245 MCC | Optional; present for merchants | [S] [2][4] |
| `tid` | Transaction ID, "PSP generated id when present" | Optional | [S] [2] |
| `tr` | Transaction reference ID (merchant order/bill ref), up to 35 alphanumeric | Conditional; mandatory for merchant/dynamic | [S] [4][5] |
| `tn` | Transaction note, up to 50 chars | Optional | [S] [4] |
| `am` | Amount, 2 decimals | Optional (static) / mandatory (dynamic) | [S] [2][5] |
| `mam` | Minimum amount; makes `am` editable above a floor | Conditional | [S] [2] |
| `cu` | Currency (`INR`) | Optional | [S] [2]. Note: one library README mislabels it "callback URL" [5] |
| `url` | Reference URL (transaction/invoice details); "should initiate with http" | Optional | [S] [2]. Use as a transaction-detail link: (unverified) |
| `mode` | Initiation mode, 2 digits: `00` default, `01` QR, `02` secure QR, `04` intent, `05` secure intent, `06` NFC, `07` BLE, `08` UHF, `15` SEBI | Conditional | [S] search-result snippet [6] |
| `purpose` | Purpose code (maps to the `TxnInitiationMode`/purpose in the UPI API) | Conditional | [S] [6]. Value list not verified |
| `orgid` | 6-digit org ID. PSP-initiated: the PSP's orgID. Merchant-generated intent/QR: `000000` | Conditional (required with `sign`) | [S] [6][4] |
| `sign` | Signature for verified-merchant (signed) QR/intent. SHA-256 with RSA, base64, **appended as the final tag**, covering all preceding content (Linking Spec §1.3) | Optional; with `mode`=`02`/`05` | [S] [3][4] |
| `ver`, `mid`, `msid`, `mtid`, `qrMedium`, `QRexpire`, `QRts`, `invoiceNo`, `invoiceDate`, `gstIn`, `gstBrkUp` | Additional tags seen in "UPI 2.0"/GST-invoice QRs | Optional | **(unverified)**. The parser must keep unknown params verbatim |

A related URI, `upi://mandate?...`, creates AutoPay mandates (validity window, recurrence pattern, amount rule, block flag, revocability; lifecycle `CREATE`/`UPDATE`/`REVOKE`/`PAUSE`/`UNPAUSE`). One implementer notes that its parameters come from "PSP aggregator documentation rather than the NPCI spec" and that "aggregators disagree at the edges" (for example `block=Y/N` vs `True/False`) [3][S].

**Result returned to the caller** (Linking Spec §1.4): `txnId`, `responseCode`, `ApprovalRefNo`, `Status`, `txnRef` [3][S]. The spec says client-side `Status` is only a hint, and merchants must verify server-side [3][S]. In practice the result arrives in the `response` extra of `onActivityResult` as a query-string, and `ApprovalRefNo` often carries the 12-digit RRN **(unverified)**.

**Android behaviour.**
- Any app can declare an `<intent-filter>` with `ACTION_VIEW` + `<data android:scheme="upi"/>`. If more than one activity can handle the intent, Android "displays a dialog (sometimes referred to as the 'disambiguation dialog') for the user to select which app to use", and the user can set a default. `Intent.createChooser()` forces a choice every time [7][P].
- Since Android 11 (API 30), merchant apps that want to *list* installed UPI apps must declare `<queries><intent>…scheme…</intent></queries>`. `QUERY_ALL_PACKAGES` is restricted by Play policy [8][P]. This affects BRAKE directly: if BRAKE registers for `upi://`, it will appear in merchant/PSP-SDK "Pay with…" app lists as if it were a UPI app (inference, not tested). Some checkout SDKs fire explicit intents at known package names (`setPackage`), which bypasses BRAKE entirely **(unverified, observed industry practice)**.

**iOS behaviour.** Apple: "If multiple apps register the same scheme, the app the system targets is undefined. There's no mechanism to change the app" [9][P]. Apple also warns that URL schemes are "a potential attack vector" and "strongly recommend[s]" universal links [9][P]. A generic `upi://pay` link on iOS therefore opens an arbitrary UPI app. Merchants use app-specific schemes instead (for example `phonepe://`, `tez://upi/`, `paytmmp://`, all **(unverified)**). A third-party app can probe for those apps only through `canOpenURL` with schemes declared in `LSApplicationQueriesSchemes`. That list is capped at 50 for apps linked on iOS 15+ and 25 for apps linked on iOS 27+, and `canOpenURL` "always returns false for undeclared schemes" [10][P]. iOS gives BRAKE **no** intent-interception position.

**Time windows and latency.** IN-SPEND. The intent fires at the moment the user taps "Pay via UPI", and BRAKE would receive it within milliseconds, *before* PIN entry. This is the only point in the UPI flow where a third-party app can be in the path before authorisation, apart from a QR scanned in BRAKE.

**Coverage.** India, Android only, for app-to-app and mobile-web flows (not for scans made inside the PSP app). UPI handled about 20+ billion transactions a month in 2026 [11][S]. The share initiated by intent, as opposed to QR or collect, is not public **(unverified)**.

**Access requirements.** No partnership is needed to *declare* the filter. To *forward* the payment, BRAKE fires an explicit intent at the user's chosen PSP app and relays the result. Open policy questions remain: NPCI/TPAP rules for non-PSP intermediaries (none found; see Risks), and Google Play's policies on deceptive behaviour and payment interception (not reviewed; Play policy pages were unreachable).

**Privacy and consent.** The URI contains a third party's payee identifier (a P2P VPA often embeds a phone number), the amount and a free-text note. BRAKE should get explicit opt-in ("Let BRAKE check UPI payments before they open"), process on device, and store a hashed `pa` plus parsed fields, not the raw URI.

**Reliability and failure modes.**
- (a) The user sets a PSP app as default and BRAKE never sees intents again.
- (b) Explicit-package SDK flows bypass BRAKE.
- (c) A result-relay bug makes the merchant app report failure while money moved.
- (d) Delay from BRAKE's UI can push the PSP/merchant session past its timeout.
- (e) Modifying any byte of a signed intent invalidates `sign`.

**Dedup / reconciliation keys.** `pa` (strong merchant key that also appears in bank SMS as "to VPA …" **(unverified, format varies by bank)**), `am`, `tr` (merchant only), `tid`. If BRAKE relays the result, it also gets `txnId` and `ApprovalRefNo`, which bridge to bank SMS and AA records.

**Normalised observation.** `PaymentIntentObservation{rail=UPI, payload_format=UPI_URI, initiation=INTENT, counterparty.alias=hash(pa), counterparty.raw_name=pn, mcc=mc, amount=am|null, amount_editable=(mam present or am absent), merchant_ref=tr, signed=(sign present), signature_valid=unknown|true|false, initiating_app=calling package, status=intent}`. Confidence: payee identity is high (machine-generated), amount is high when `am` is present, and completion is unknown. If BRAKE relays the result, it can emit a second observation with `status=confirmed|failed` at medium-high confidence, since client-side status is only a hint.

**Provenance sentence.** "Seen when the Swiggy app opened a UPI payment of ₹500 to swiggy@… (you chose to route UPI links through BRAKE)."

**Recommendation: `research`.** The behavioural value is very high: this is a true in-spend moment, at the exact point of decision. But the regulatory position (BRAKE in the path of a regulated payment flow), the UX risk (an extra app in the chooser, timeouts) and the Android-India-only coverage make it unsuitable for the MVP. Run a policy and legal review with NPCI/PSP partners and a closed beta first.

---

### 2. UPI QR (static, dynamic, signed) and Bharat QR via BRAKE's own scanner (`upi-qr`, `bharat-qr`, `qr-scan`)

**What it is.** UPI QRs come in two encodings:
- **(a) a `upi://pay?…` URI** carrying the parameters listed in §1 (the dominant form on Indian counters);
- **(b) an EMVCo MPM payload ("Bharat QR")**, which carries card-network merchant IDs and UPI data in TLV templates (see §4).

NPCI required all member PSP apps to generate and read **dynamic** QR codes from December 2016 (NPCI Circular 11) [12][S]. **Signed QR** for verified merchants arrived with UPI 2.0 (August 2018) [6][S]. On scan, compliant apps verify `sign` and warn when verification fails [6][S]; the exact warning wording varies by app.

**Bharat QR tag usage** (community parser, 2019) [13][S]:
- `02` Visa merchant ID, `04` Mastercard merchant ID, `06` NPCI (RuPay) merchant ID, `08` account + IFSC.
- `26` UPI data: `00` RuPay RID, `01` payee VPA, `02` minimum amount.
- `27` UPI additional data: `00` RID, `01` `tr`, `02` URL.
- `28` UPI Aadhaar data.
- Then the standard EMV tags `52`–`63`.

**Static vs dynamic.**
- *Static* means a printed sticker: `pa`, `pn`, often `mc`, and no `am`, or EMV `01`=`11`. The user types the amount inside the PSP app, so the payload never shows it.
- *Dynamic* is shown on a POS, screen or invoice: `am`, `tr`, often `tn`, sometimes `sign`/`orgid`/`mode=02`, or EMV `01`=`12` with tag `54`.

**Data actually available to BRAKE.** Everything in the payload, and only when the user scans **with BRAKE**. This is the "Scan with BRAKE first, then pay in your usual app" pattern. BRAKE never sees scans made inside PhonePe or Google Pay.

**Time windows and latency.** IN-SPEND: the user is at the counter or checkout and the flow has begun. It is also PRE-SPEND for bills and invoices scanned to "decide later". Parsing takes under a second on device.

**Coverage.** India: UPI QR is accepted almost everywhere UPI is. Android and iOS: the camera APIs are universal. Hand-off is described below.

**Hand-off after the scan.**
- **Android:** fire `ACTION_VIEW` with the *original, unmodified* URI. Use `createChooser` or the user's saved PSP package. Signed payloads must not be modified.
- **iOS:** open an app-specific scheme for the user's chosen PSP app (subject to the `LSApplicationQueriesSchemes` caps above), or fall back to "Open your UPI app and scan again".

  The UPI apps' own scan-from-gallery features are an alternative. BRAKE could save or share the QR image (unverified UX).
- **Mode semantics:** when BRAKE re-launches a QR payload as an intent, the PSP app may treat it as `mode=04` (intent) rather than `01` (QR). NPCI applies different rules per initiation mode; for example OC-76C prohibits "QR share & Pay" for international UPI Global P2M [12][S]. This is a compliance and risk question for PSPs, and the reason to prefer "forward the raw string" over re-encoding.

**Access requirements.** None for parsing. No NPCI membership is needed to *read* QR payloads. BRAKE must never *generate* payment QRs.

**Privacy.** P2P VPAs often embed the payee's mobile number. Hash `pa` with a per-device salt for matching. Keep `pn` only as a display string, and keep it only if the user keeps the observation.

**Reliability.** Payloads are machine-readable and CRC- or signature-protected, so parse reliability is high. Failure modes:
- tampered or overlaid stickers ("QR swap" fraud). BRAKE should show the `pn` and banking-name mismatch where it can, but must not claim "safe";
- malformed community-generated URIs (the `+` vs `%20` encoding drift noted by implementers [3]);
- an unknown national profile;
- the user abandoning the payment after scanning, so completion stays unknown.

**Dedup keys.** `pa`/VPA, `am`, `tr`, `mc`, scan timestamp. The later bank SMS or AA record carries an RRN but usually not `tr`, so match on hash(`pa`) or the payee name, then amount within ±0, then time within N minutes.

**Normalised observation.** `PaymentIntentObservation{source=qr-scan, payload_format=UPI_URI|EMV_MPM, initiation=QR_STATIC|QR_DYNAMIC, …same fields as §1…, signed, scanned_at, location=none by default}`. Confidence: counterparty high; amount high for dynamic and absent for static; completion low to unknown. If the payload is static, BRAKE asks "About how much?". That amount is *user-declared* and stored at medium confidence.

**Provenance sentence.** "From the QR code you scanned with BRAKE at 10:41: a dynamic UPI code for 'Sharma General Store' asking for ₹1,249 (merchant signature verified)."

**Recommendation: `mvp`.** It works on both OSs, involves no regulator or platform interception, the user starts it, and it is pure on-device parsing. It delivers BRAKE's core "before you pay" moment, and the same scanner serves every EMV-QR country (§4–5).

---

### 3. UPI counterparty-type inference: P2P vs P2M vs P2PM (`upi-counterparty-classification`, derived)

**Not a separate source.** This is a feature derived from §1, §2 and §7, and it matters for the transfer-vs-spending problem.

**Signals (strongest first).**
1. `mc` present and not a placeholder. Under NPCI OC-181, acquirers must categorise merchants as P2M or P2PM and "correctly populate the MCC 7407 for P2PM transactions in the UPI merchant tag" [12][S]. P2PM ("person-to-person-merchant", small informal merchants) has inward limits of ₹10,000 per transaction, ₹25,000 per day and ₹1,00,000 per month (OC-192) [12][S].
2. `sign` + `orgid` present means a verified merchant. Verified merchants in some categories get higher limits, for example tax payments (MCC 9311) and capital markets, insurance, travel and credit-card bill payments up to ₹5 lakh (OC-185A/B) [12][S].
3. `tr` present, or a dynamic amount, means likely P2M.
4. EMV tag `52` (MCC) in Bharat QR.
5. Only `pa`+`pn` and a VPA that looks like a phone number means likely P2P. A placeholder MCC such as `0000` is common in P2P payloads **(unverified)**.

**Policy change that helps.** NPCI discontinued "UPI Collect Request" for **all P2P transactions after 1 October 2025** (OC-220) [12][S]. An incoming collect request is therefore merchant-initiated (P2M) by construction.

**Beneficiary name.** OC-101A requires PSP apps to "display only the ultimate beneficiary's banking name (as fetched from the Validate Address API)" (compliance by 30 June 2025) [12][S]. The `pn` in a QR (merchant-chosen) can therefore differ from the name in the PSP app's confirmation and in bank SMS. BRAKE should store both as `merchant_raw` variants.

**Recommendation: `mvp`.** Ship it as part of the QR/UPI parser. It feeds `transaction_type_candidate` (purchase vs transfer) directly.

---

### 4. EMVCo Merchant-Presented Mode QR, the generic parser (`emvco-mpm-qr`)

**What it is.** EMVCo's *QR Code Specification for Payment Systems, Merchant-Presented Mode* defines a TLV string. Each data object is `ID` (2 digits) + `Length` (2 digits) + `Value`. National schemes build their profiles on top of it.

**Root data objects** (from an MPM v1.1 implementation's constants [14][S], with the CRC from the same library [15][S]):

| ID | Name | Presence | Notes for BRAKE |
|---|---|---|---|
| `00` | Payload Format Indicator | M | always `01` |
| `01` | Point of Initiation Method | O | `11` static, `12` dynamic [16][17][S] |
| `02`–`25` | Merchant Account Information reserved for EMVCo-registered networks (card schemes) | at least one MAI object (`02`–`51`) required | Bharat QR: `02` Visa, `04` Mastercard, `06` RuPay [13] |
| `26`–`51` | Merchant Account Information templates for "any payment operators"; value up to 99 chars; sub-tag `00` = globally unique identifier (GUID/AID/reverse-domain) | M (at least one MAI) | **this is where the rail is identified** [14][18][S] |
| `52` | Merchant Category Code (ISO 18245) | M | category prior |
| `53` | Transaction Currency, ISO 4217 numeric | M | e.g. 356 INR, 764 THB, 702 SGD, 458 MYR, 704 VND, 116 KHR / 840 USD (verified in profile sources); 986 BRL, 360 IDR, 608 PHP (ISO 4217, not re-checked) |
| `54` | Transaction Amount | C | present in dynamic QRs |
| `55` / `56` / `57` | Tip or convenience indicator / fixed fee / percentage fee | O/C | final amount ≠ `54` |
| `58` | Country Code (ISO 3166-1 alpha-2) | M | may differ from the user's home country (cross-border QR linkages) |
| `59` | Merchant Name | M | Pix caps it at 25 chars [19] |
| `60` | Merchant City | M | Pix caps it at 15 chars [19] |
| `61` | Postal Code | O | |
| `62` | Additional Data Field Template: `01` Bill Number, `02` Mobile Number, `03` Store Label, `04` Loyalty Number, `05` Reference Label, `06` Customer Label, `07` Terminal Label, `08` Purpose of Transaction, `09` Additional Consumer Data Request, `10` Merchant Tax ID, `11` Merchant Channel, `12`–`49` RFU, `50`–`99` payment-system-specific | O | `05` is the main merchant reference (Pix `txid`) [14][S] |
| `63` | CRC: CRC-16/CCITT-FALSE, polynomial `0x1021`, initial value `0xFFFF` (ISO/IEC 13239), computed over the whole payload including `6304`; example `6304007B` | M, last object | some libraries describe it as "XMODEM" [17]. Validate with test vectors |
| `64` | Merchant Information, Language Template (localised name and city) | O | prefer for display if present |
| `65`–`79` | RFU for EMVCo | | |
| `80`–`99` | Unreserved templates | O | national extensions |

**Time windows, coverage and access.** The same as §2: IN-SPEND (and PRE-SPEND for bills), instant, any OS, no access requirements. EMVCo publishes the spec freely (registration may be needed) **(unverified)**.

**Reliability.** CRC detects corruption but not tampering. A swapped sticker is a valid QR. Unknown GUIDs should degrade to "QR payment to <59 name> in <60 city>, <58 country>".

**Dedup keys.** `62`.`01` bill number, `62`.`05` reference label, `62`.`07` terminal label, `54` amount, the MAI account/proxy, `59` name.

**Normalised observation.** As in §2, with `payload_format=EMV_MPM`, `rail` = resolved from the MAI GUID through the profile registry (§5), `mcc=52`, `currency=53`, `country=58`, `merchant_ref={bill:62.01, ref:62.05, terminal:62.07, purpose:62.08}`.

**Provenance sentence.** "From the PromptPay QR you scanned: 'Coffee Corner', Bangkok, ฿85."

**Recommendation: `mvp`.** One small, well-specified parser unlocks most QR-payment countries.

---

### 5. National EMV QR profiles (`pix-br-code`, `sgqr-paynow`, `promptpay-qr`, `duitnow-qr`, `qris`, `qr-ph`, `vietqr`, `khqr`, `bharat-qr`)

| Profile | Country | Where the rail lives | GUID / AID and sub-tags | Notable rules | Source |
|---|---|---|---|---|---|
| **Pix BR Code** | BR | MAI `26` | `00`=`br.gov.bcb.pix`; `01` Pix key (CPF 11 digits, CNPJ 14, phone `+55…`, lower-case e-mail, or lower-case UUID "EVP"); `02` info for the payer; `25` location URL (dynamic; written without `https://`) | `62`.`05` = `txid`: `***` for static, 1–25 alphanumerics otherwise; name ≤25, city ≤15 chars; MCC commonly `0000` (unverified) | [19][S], BCB Manual do BR Code referenced |
| **SGQR / PayNow** | SG | MAI `26` | `00`=`SG.PAYNOW`; `01` proxy type (`0` mobile, `2` UEN); `02` proxy value; `03` amount editable (`1`); `04` expiry (unverified) | SGQR Specification v1.7 cited; currency 702; SGQR ID in tag `51` (unverified) | [20][S] |
| **PromptPay (Thai QR)** | TH | MAI `29` (credit transfer); `30` bill payment (unverified) | GUID `A000000677010111`; `01` mobile (`0066…`, 13 digits), `02` national/tax ID (13), `03` e-wallet ID (15) | currency 764; `01`=`12` when an amount is set | [17][S] |
| **DuitNow QR** | MY | MAI `26` | `00`=`A0000006150001` (PayNet AID); `01` acquirer ID; `02` merchant account; `03` reserved | currency 458; `62` holds the bill/reference | [21][S] |
| **QRIS** | ID | MAI `26`–`45` (one per PJSP/issuer, e.g. `ID.CO.QRIS.WWW`) plus tag `51` national merchant ID (NMID) | MPAN in MAI; merchant criteria UMI/UKE/UME/UBE/URE (micro to large) | Static-to-dynamic conversion is common (`54` injected); tip `55`; currency 360 | [22][S] |
| **QR Ph** | PH | (P2P vs P2M templates; GUIDs not verified) | (unverified) | Based on EMVCo; mandated by BSP. The repo cites R.A. 11127 (National Payment Systems Act) | [23][S] |
| **VietQR (NAPAS)** | VN | MAI `38` | `00`=`A000000727`; `01` beneficiary (`00` bank BIN, `01` account/card); `02` service code `QRIBFTTA` (to account) / `QRIBFTTC` (to card) | currency 704; `62`.`08` purpose; NAPAS QR Switching Technical Specification v1.5.2 cited | [24][S] |
| **KHQR (Bakong)** | KH | MAI `29` (individual) / `30` (merchant) | Bakong account ID `name@bank` | tag `99` timestamp; expiry required for dynamic KHQR; currency 116 KHR or 840 USD. The MD5 of the QR string is the transaction-lookup key in the Bakong Open API (`check_transaction_by_md5`) | [25][26][S] |
| **Bharat QR** | IN | `02`/`04`/`06` card networks; `26`–`28` UPI | see §2 | interoperable card + UPI | [13][S] |
| Kenya QR Standard, HK Common QR | KE, HK | EMVCo-based national standards (exist; not analysed) | | | [18] search result |

**Data, windows and access.** As in §4. Pix adds two specifics:
- **Dynamic Pix**: the amount and charge details live behind the `26`.`25` location URL. Payer apps fetch that URL to get a signed JWS charge object **(unverified detail; BCB manual not reachable)**. BRAKE should **not** fetch it by default. Fetching it is a network call to a PSP, reveals the payer's IP, and may count as "presenting" the charge. Show "amount will be shown in your bank app" instead, or make fetching an explicit opt-in.
- **Pix "copia e cola"**: the same payload as a text string, which users copy from checkout pages and paste into their bank app. BRAKE can parse it from a share or paste action (see §16).

**Coverage.** Real-time A2A QR is the dominant retail rail in BR, IN, TH, ID, VN, KH, MY and SG, and growing in PH (qualitative; adoption figures not verified this session). Cross-border QR linkages mean tag `58` can be foreign: for example UPI "Global" P2M exists per NPCI OC-76C [12][S], and ASEAN interlinkages exist (unverified).

**Recommendation.**
- **`mvp`** for Bharat QR (India launch).
- **`next`** for Pix, PromptPay, SGQR/PayNow, DuitNow, QRIS, VietQR and KHQR. Each is roughly a profile row plus tests on top of the §4 parser.
- **`research`** for QR Ph, until the GUIDs are verified against a primary source.

---

### 6. UPI funding instruments: UPI Lite, RuPay credit card on UPI, credit line on UPI, Reserve Pay (`upi-lite`, `rupay-credit-on-upi`, `upi-credit-line`, `upi-reserve-pay`)

**What it is.** These are not signal sources. They are facts about *what a UPI payment actually debits*. Adapters must label them, because they change the transfer-vs-spending and double-count logic.

| Instrument | Facts (as of 2026-10-04) | BRAKE implication |
|---|---|---|
| **UPI Lite** (on-device balance, PIN-less small payments) | Limits raised to ₹1,000 per transaction and ₹5,000 balance (OC-169A, FY2024-25) [12][S]. Auto top-up introduced (OC-205) [12][S]. A "Transfer Out" feature and daily balance reconciliation were mandated (OC-138B) [12][S]. Banks may not send an SMS per Lite payment; the bank statement may show only loads (unverified) | A Lite **load** is an own-account transfer, not spending. Lite **spends** may be visible only in the PSP app's notifications or history, so bank-SMS-only users under-count small spends |
| **RuPay credit card on UPI** | The UPI limit is the lowest of the issuer's credit limit, the issuer's UPI risk limit and the customer-set limit (RuPay OC-022) [12][S]. Generally P2M only (unverified). Prohibited for CBDC wallet top-ups (OC-170B) [12][S] | One purchase produces a UPI notification **and** a later credit-card statement line, and then a card-bill payment that is a transfer, not spending |
| **Pre-sanctioned credit line on UPI** | Bank credit lines can be linked to UPI IDs for merchant payments (OC-171). Since FY2025-26, use must match the loan's purpose (OC-171A) [12][S] | `funding_instrument=credit_line`. Repayments are loan payments, not spending |
| **UPI Reserve Pay (Single-Block-Multiple-Debits)** | One mandate blocks funds for multiple later debits (OC-200), extended to all UPI funding sources in FY2025-26 (OC-228) [12][S] | A block is a *commitment*, not spending. Each debit is the spend |
| **UPI Tap & Pay (NFC)** | NFC UPI payments on Android and iOS (OC-186) [12][S] | No QR or intent for BRAKE to see; post-spend signals only |
| **Biometric authentication** | On-device biometrics as an optional alternative to the UPI PIN (OC-226, FY2025-26) [12][S] | The in-spend window shrinks, which raises the value of pre-spend surfaces |

**Recommendation: `next`.** Model `funding_instrument` and `initiator` in the observation schema from day one. Rail-specific inference rules can follow later.

---

### 7. UPI AutoPay mandates and pre-debit notifications (`upi-autopay-mandate`)

**What it is.** Recurring mandates created through `upi://mandate` or in-app flows. Facts:
- The limit above which a UPI PIN (AFA) is required on each execution was raised from ₹15,000 to ₹1,00,000 for specified categories (OC-151A) [12][S]. RBI scoped this to mutual funds, insurance and credit-card bills **(unverified)**.
- A **24-hour pre-debit notification (PDN)** is the norm. OC-207 "remove[d] the 24-hour PDN validation requirement" for FASTag and NCMC auto-replenishment MCCs [12][S], which confirms that the rule exists elsewhere.
- OC-223 (FY2025-26) lets users "view and port their active mandates across different UPI apps" and lets merchants port mandate execution between PSPs [12][S].
- OC-215/215A restrict API usage, including mandate execution TPS and windows [12][S]. Execution in non-peak hours is commonly reported **(unverified detail)**.
- NPCI is piloting "UPI HELP", an AI assistant that includes "unified mandate management" (OC-227) [12][S].

**Data available to BRAKE.**
- At creation: the payee, the maximum amount and the recurrence, but only if the user scans or opens the mandate link in BRAKE (rare).
- Before each debit: the PDN text (merchant, amount, date) via SMS or a PSP/bank notification. That text goes to the SMS and notification adapters (other streams).
- After: a bank SMS/AA debit.

There is no third-party API for listing a user's mandates.

**Windows.** PRE-SPEND: the PDN arrives at least 24 hours before the debit. POST-SPEND: the execution alert.

**Coverage.** India; Android for automatic capture. iOS users would need to share or paste the PDN.

**Dedup keys.** The UMN (Unique Mandate Number) appears in some PDNs **(unverified)**. Otherwise merchant name + amount + day-of-month.

**Normalised observation.** `RecurringObligationObservation{rail=UPI, instrument=mandate, payee, amount_max|amount_due, due_at, recurrence?, source=sms|notification}`. Confidence: due date and amount are high when parsed from the PDN.

**Provenance sentence.** "From your bank's pre-debit notice: Netflix AutoPay ₹649 due tomorrow."

**Recommendation: `next`.** This is very high value for the brief's "renews tomorrow" intervention. It depends on the SMS and notification adapters.

---

### 8. UPI Circle: delegated payments, including IoT and software delegates (`upi-circle`)

**What it is.** A primary user delegates UPI payments to a secondary user, either fully (within limits) or partially (the primary approves each payment). Limits: "maximum monthly limit of ₹15,000 and a per-transaction limit of ₹5,000" (OC-201) [12][S]. OC-201B (FY2025-26) extends delegation of domestic P2M payments to **IoT devices and software profiles** ("smart glasses, watches, and TVs"). It introduces a Merchant Identifier Code (MIC) and a new purpose code `BH` [12][S]. This is NPCI's route toward agent-initiated payments.

**Signals.**
- For the primary: approval requests (IN-SPEND) and debit alerts that the user did not initiate personally (POST-SPEND, ownership = family/delegate).
- For the secondary: spends that never hit their own account.

**Recommendation: `later`.** Label `initiator=delegate` and `ownership_candidate=family|device` when it is detectable from notification text.

---

### 9. UPI transaction alerts and references: bank SMS, PSP notifications, RRN/UTR (`upi-transaction-alerts`)

**What it is.** These are the post-spend confirmations of UPI payments. They are owned by the SMS and notification streams; this section covers the rail-specific content. Bank debit SMS typically contain the amount, the masked account (`XX1234`), the date and time, the payee VPA or name, a **UPI Ref No / RRN (12 digits)** and sometimes the balance. An example from an open-source Indian SMS parser is "INR 2000 debited from A/c no. XX3423 on 05-02-19 07:27:11 IST at ECS PAY. Avl Bal- INR 2343.23." [27][S]. Formats vary by bank and change without notice.

**References.**
- *RRN* (Retrieval Reference Number, 12 digits): shown to users as "UPI Ref No" or "UTR" **(unverified as a universal convention)**.
- *UPI transaction ID* (`txnId`): from the PSP.
- *ApprovalRefNo*: from the intent result.
- Merchant `tr`: rarely shown to the payer.

The RRN is the strongest cross-source key between a PSP-app notification, a bank SMS, an Account Aggregator transaction narration and the user's own screenshot.

**Android constraint.** Android 15 stops "untrusted apps that implement a NotificationListenerService from reading unredacted content from notifications where an OTP has been detected" [28][P]. Payment confirmations are not OTPs, but a combined "OTP + amount" message from some issuers would arrive redacted.

**Recommendation: `mvp`,** delivered through the `android-notification-listener` / `android-sms` adapters (other streams). This stream's contribution is the RRN/VPA extraction rules and the P2P/P2M heuristics.

---

### 10. UPI app landscape and market share (`upi-app-market-share`, registry data)

As of 2026, from NPCI app-wise data as reported by secondary sources:
- **January 2026:** PhonePe 48.61%, Google Pay 37.77%, Paytm 6.42%, Navi 1.34%, others 9.86% [29][S].
- **April 2026:** PhonePe 47.07%, Google Pay 33.54%, Paytm 8.10% [30][S].
- **May 2026 (by value):** PhonePe 46.26%, Google Pay 32.75%, Paytm 7.91%, Navi 3.55%, super.money 1.8%, BHIM 0.98%, FamApp 0.85%, CRED 0.68%, WhatsApp 0.65%, Axis Bank apps 0.58% [31][S]. PhonePe + Google Pay fell to 79%, the "first sub-80% reading" [32][S].
- NPCI extended the deadline for the 30% per-TPAP volume cap to **31 Dec 2026** (OC-210) [12][S].

**Implication.** Notification parsers for PhonePe, Google Pay, Paytm and Navi (plus BHIM and bank apps) cover about 90% of volume. The cap deadline could reshuffle shares in 2027, so the parsers must be data-driven and remotely updatable.

**Recommendation: `mvp`** as registry data feeding the notification adapter's priorities.

---

### 11. Pix: BR Code, Pix Automatico, Pix por aproximacao, Pix API identifiers (`pix-br-code`, `pix-automatico`, `pix-nfc`)

- **BR Code**: see §5. Banco Central do Brasil publishes the Pix API as OpenAPI on GitHub (`bacen/pix-api`, current version **2.10.0**) [33][34][P].
- **Received-Pix object** (merchant/PSP side): `endToEndId`, `txid`, `valor`, `chave`, `horario`, `infoPagador`, `devolucoes` (refunds) [35][P]. The `endToEndId` format, `E` + 8-digit ISPB + `yyyyMMddHHmm` + 11 characters (32 chars), is **(unverified)**.
- **Pix Automatico (recurring Pix)**: API version 2.7.0 added the tags `RecPayload`, `Rec`, `SolicRec`, `CobR`, `PayloadLocationRec`, `WebhookRec` and `WebhookCobR`, and `rec.dadosQR` with `pixCopiaECola` and `jornada` [34][P]. A recurrence (`Rec`) carries `idRec`, `vinculo` (debtor, contract), `calendario` (`dataInicial`, `dataFinal`, `periodicidade`), `valor` (`valorRec`, `valorMinimoRecebedor`), `politicaRetentativa` and `status` [35][P]. Version 2.10.0 added rejection-reason handling for recurrences [34][P]. Launch date 16 June 2025 **(unverified)**.

  For BRAKE, a BR Code that carries a recurrence-authorisation journey is a **subscription sign-up event** seen in PRE-SPEND. The exact tag carrying it is not verified.
- **Pix por aproximacao (NFC Pix)**: launched around February 2025 via wallets on Android **(unverified)**. No payload is visible to BRAKE, so only post-spend signals apply.
- **Consumer-side access.** None of the Pix API is available to a consumer app: it is PSP/merchant-side. BRAKE in Brazil reads Pix through QR/copy-paste (pre-spend), bank-app notifications (post-spend) and Open Finance Brasil (other stream).
- **Recommendations:** BR Code parse **`next`**; Pix Automatico QR detection **`research`**; Pix API **`avoid`** (merchant-side only).

---

### 12. Closed-loop and proprietary QR: Alipay / WeChat Pay / Alipay+, PayPay (`alipay-wechat-qr`, `paypay`)

- **Alipay / WeChat Pay.** Merchant QRs are typically opaque URLs or tokens (for example an `https://qr.alipay.com/…` link or a `wxp://…` scheme) that carry no amount or merchant name **(unverified)**. Alipay+ aggregates wallets for cross-border acceptance **(unverified)**. BRAKE can at most say "QR payment via Alipay" plus whatever the user types. Recommendation: **`later`** (merchant-hint only; China is a low-priority market for BRAKE).
- **PayPay (Japan).** The merchant API creates dynamic QR codes (`codeId`) keyed by a merchant-generated `merchantPaymentId` (≤64 chars) and a PayPay `paymentId`. Statuses include `COMPLETED` and `AUTHORIZED`. PayPay recommends polling payment details "with a 4-5 second interval" [36][P]. All of this is merchant-side. Japan also has the JPQR unified standard **(unverified)**. Recommendation: **`later`**.

---

### 13. European account-to-account and wallet rails: Swish, Bizum, BLIK, iDEAL/Wero, Vipps MobilePay, SEPA Instant (`swish`, `bizum`, `blik`, `ideal-wero`, `vipps-mobilepay`, `sepa-instant`)

None of these exposes a consumer-side API or an interceptable payload to a third-party app. BRAKE observes them through bank or wallet notifications, emails and PSD2 account information (the open-banking stream).

| Rail | What it is | What BRAKE can see | Recommendation |
|---|---|---|---|
| **Vipps MobilePay** (NO/DK/FI) | ePayment API currencies NOK, DKK, EUR. `userFlow` = `WEB_REDIRECT`, `QR` ("returns a one-time QR"), `PUSH_MESSAGE`, `NATIVE_REDIRECT`. States `CREATED`, `AUTHORIZED` (final), `ABORTED`, `EXPIRED`, `TERMINATED`. Merchant `reference` must match `^[a-zA-Z0-9-]{8,64}$`. An optional `receipt` holds "order details shown in the app's payment history" [37][P] | Vipps one-time QRs are opaque. Post-spend app notifications; the receipt lines are visible to the user in-app (share or screenshot) | `later` |
| **Swish** (SE) | Mobile-number-based instant payments, with QR and app-switch for e-commerce **(unverified details)** | notifications, bank feed | `later` |
| **Bizum** (ES) | Bank-integrated P2P/P2M by phone number **(unverified details)** | bank-app notifications, PSD2 feed | `later` |
| **BLIK** (PL) | 6-digit one-time codes entered at checkout, plus P2P by phone **(unverified details)** | bank-app notifications (the code is generated in the bank app, so in-spend is invisible to BRAKE) | `later` |
| **iDEAL → Wero** (NL/EU) | iDEAL is migrating to EPI's Wero brand from 2026 **(unverified timeline)** | redirect confirmation pages in the browser (§16), bank notifications | `later` (web part `next` via the extension) |
| **SEPA Instant** (EU) | Instant Payments Regulation (EU) 2024/886: euro-area PSPs had to receive instant payments by 9 Jan 2025, send by 9 Oct 2025, and apply Verification of Payee by 9 Oct 2025 **(unverified; regulation text not fetched)** | Bank feeds with ISO 20022 `EndToEndId` and the creditor name (VoP improves name quality) | `later` (rail label) |

---

### 14. M-Pesa: STK push and confirmation SMS (`mpesa-stk-push`, `mpesa-confirmation-sms`)

- **STK push (M-Pesa Express / Lipa Na M-Pesa Online).** The merchant calls Safaricom's Daraja API and the customer's SIM toolkit pops up a PIN prompt. Safaricom's official Node library covers M-Pesa Express, C2B, B2C, B2B, Transaction Status, Account Balance and Reversal, with `transactionType='CustomerPayBillOnline'`, `accountRef` and `transactionDesc` [38][P]. Callbacks carry `MerchantRequestID`, `CheckoutRequestID`, `ResultCode` and `ResultDesc` [39][S], plus metadata including `MpesaReceiptNumber`, `Amount` and `TransactionDate` **(unverified field list)**. This is merchant-side only, so for BRAKE: **`avoid`** (no consumer access), or `later` via a merchant partnership.
- **Confirmation SMS.** Every M-Pesa transaction produces an SMS from "MPESA" with a ~10-character alphanumeric receipt code, the amount, the counterparty (name / till / paybill + account), the date and time, the new balance and the transaction cost **(unverified exact format)**. On Android, this is the richest and fastest post-spend signal in Kenya, and the receipt code is a unique dedup key. It is subject to Google Play SMS-permission policy (other stream). Kenya also has an EMVCo-based national QR standard (CBK) [18].
- **Recommendation:** confirmation SMS **`next`** (Kenya, Android, via the SMS adapter); STK push **`avoid`**.

---

### 15. US instant rails: FedNow and RTP (`fednow-rtp`)

FedNow (Federal Reserve, launched July 2023) and RTP (The Clearing House) are ISO 20022 credit-transfer rails. The 2025 limit increases (RTP to $10M; FedNow's maximum raised) are **(unverified)**. Neither offers consumer-side observability. They show up as fast-posting bank transactions in Plaid/1033 feeds (other stream). Consumer card dominance makes them secondary in the US.

**Recommendation: `later`** (rail label only; no adapter).

---

### 16. Web checkout: Payment Request API, Secure Payment Confirmation, Apple Pay on the web, Google Pay API (`payment-request-api`, `secure-payment-confirmation`, `apple-pay-web`, `google-pay-web`)

- **Payment Request API** (W3C). The merchant page builds `new PaymentRequest(methodData, details)` and receives a `PaymentResponse` (method name, method-specific details such as wallet tokens, and payer name, email, phone and shipping address only if requested). Support (MDN BCD) [40][P]: Chrome 60, Chrome Android 53, Edge 15, Safari 11.1. Firefox 55 only behind `dom.payments.request.enabled` and `dom.payments.request.supportedRegions`.
- **Secure Payment Confirmation (SPC).** A `secure-payment-confirmation` payment method in which the browser shows a native dialog with the payee origin/name, amount, currency and instrument `displayName`/`icon`, and signs a challenge with a passkey; "payment details are included in the returned assertion" [41][P]. Support: Chrome/Chrome Android 95+ only; `securePaymentConfirmationAvailability()` from Chrome 139 [40][P].
- **Apple Pay on the web.** Safari offers the Apple Pay JS API (iOS 10+, macOS 10.12+) and Payment Request API (iOS 11.3+, Safari 11.1+). China has different availability [42][P]. The payment sheet is native browser UI. The page receives an encrypted token plus requested contact data. Support in third-party iOS browsers (iOS 18+) is **(unverified in fetched docs)**.
- **Google Pay API for web.** The page receives `PaymentData` with `paymentMethodData` (`type`, `description`, `info.cardNetwork`, `info.cardDetails`, `tokenizationData`) **(unverified; Google docs unreachable)**.

**What BRAKE can observe.** Nothing inside these sheets. They are browser chrome by design, so a content script cannot read them. An extension *could* inject a main-world script that wraps `PaymentRequest` to read `details.total` before the sheet opens. That is technically feasible but invasive, brittle, and likely to draw store-review scrutiny. **Recommendation:** `payment-request-api` **`research`** (only as an opt-in, merchant-agnostic "total about to be charged" hook); `secure-payment-confirmation` **`avoid`**; `apple-pay-web`/`google-pay-web` **`later`** (use the DOM context of §17 instead).

---

### 17. Browser checkout DOM, confirmation pages and payment redirects (`browser-checkout-dom`, `payment-confirmation-page`)

**What it is.** A Chrome, Edge, Firefox or Safari Web Extension (including Safari on iOS) whose content scripts run, with per-site or user-granted host permissions, on checkout and confirmation pages.

**Data.**
- PRE-SPEND / IN-SPEND: cart total, currency, merchant domain, line items, and a "Place order" / "Pay" click (the moment for friction).
- POST-SPEND: confirmation page URL patterns (`/order-confirmation`, `/thank-you`, `?order_id=`), the order number, and redirect returns from PSP hosted pages (iDEAL/Wero, Pix/UPI web flows, 3-D Secure).
- Many merchant pages also push a GA4-style `purchase` event (`transaction_id`, `value`, `currency`, `items[]`) to `window.dataLayer` **(unverified schema; Google docs unreachable)**. That is a structured post-spend signal readable from the main world.

**Coverage.** Global, desktop plus iOS Safari. Mobile Chrome on Android has no extensions.

**Access.** Store review. Chrome Web Store user-data policies require a narrow purpose and disclosure **(unverified, policy page unreachable)**.

**Privacy.** It runs on every page it is permitted on, so restrict host permissions to an allowlist of commerce domains plus user-added sites, and parse in the extension without uploading DOM.

**Dedup keys.** Order number (also in confirmation e-mails), amount, merchant domain, timestamp.

**Provenance sentence.** "Seen on amazon.in's checkout page when you clicked 'Place your order' (₹4,799)."

**Recommendation: `next`.** This is the main web pre-spend surface and the counterpart to the QR scan. It belongs to the browser-extension stream but is listed here as the web "rail".

---

### 18. Payment-app hand-off via app-specific URL schemes and universal links (`payment-app-deeplink-handoff`)

**What it is.** After a BRAKE pre-spend check, BRAKE has to return the user to their payment app without friction:
- **Android:** `ACTION_VIEW` on the original URI, with `setPackage(preferred)` or a chooser [7][P].
- **iOS:** app-specific schemes or universal links, limited to 50 queryable schemes (25 when linked on iOS 27+) [10][P]. The generic `upi` scheme target is undefined [9][P].

Pix and EMV QR codes have no standard launch URI: the user must scan or paste them inside the bank app **(unverified that no common scheme exists)**.

**Recommendation: `next`.** It is required for the QR MVP flow on Android (cheap) and best-effort on iOS (keep a curated, remotely updatable scheme list per country).

---

### 19. Other mechanisms considered

| Mechanism | Assessment |
|---|---|
| **Clipboard or share-sheet of payment strings** (Pix copia e cola, `upi://` links, payment-link URLs) | The user shares or pastes into BRAKE, which parses on device. Background clipboard reading is restricted on modern Android and iOS **(unverified specifics)**, so use explicit share/paste only. `next`. |
| **QR image from gallery/screenshot** | Same parser on a decoded image (for example a QR received on WhatsApp). `mvp` (part of the QR scanner). |
| **QRIS-style "payment notification forwarder" apps** | An open-source Android app (`qrishook`) "monitors QRIS payment notifications and forwards parsed payment events to your webhook" [43][S]. This confirms the notification-parsing pattern for merchant-side QR receipts in Indonesia. It is not a new source for BRAKE. |
| **Wallet order tracking / FinanceKit** (iOS 17+) | FinanceKit gives on-device Apple Card/Apple Cash data and Wallet orders, behind a managed entitlement (organisation account, Apple review, `NSFinancialDataUsageDescription`) [44][P]. Belongs to the iOS financial-API stream. |

---

## Three-window classification

| Source (id) | Pre-spend | In-spend | Post-spend | Latency | Notes |
|---|---|---|---|---|---|
| `qr-scan` (UPI URI + EMV MPM via BRAKE scanner) | ✓ (bills/invoices) | ✓✓ (at counter, before PIN) | – | <1 s, on device | User-initiated; Android + iOS; static QR has no amount |
| `upi-qr` / `bharat-qr` | ✓ | ✓✓ | – | <1 s | Signed QR = verified merchant |
| `emvco-mpm-qr` + national profiles | ✓ | ✓✓ | – | <1 s | One parser, profile registry by MAI GUID |
| `upi-intent-url` (Android handler) | – | ✓✓ (app-to-app, before PIN) | ✓ (if BRAKE relays the result) | ms | Research; regulatory/UX risk; Android only |
| `upi-counterparty-classification` | ✓ | ✓ | ✓ | n/a (derived) | P2P/P2M/P2PM from `mc`, `sign`, `tr` |
| `upi-autopay-mandate` (PDN) | ✓✓ (≥24 h ahead) | – | ✓ | PDN ≥24 h before debit; execution alert seconds–minutes | Via SMS/notification adapters |
| `upi-lite` / `rupay-credit-on-upi` / `upi-credit-line` / `upi-reserve-pay` | – | – | ✓ (labelling) | n/a | Funding-instrument facts for transfer/double-count logic |
| `upi-circle` | – | ✓ (approval request) | ✓ | seconds | Ownership = delegate/family/device |
| `upi-transaction-alerts` (bank SMS / PSP notification, RRN) | – | – | ✓✓ | seconds–minutes | RRN = strongest UPI dedup key |
| `pix-br-code` | ✓ | ✓✓ | – | <1 s (static); dynamic needs a URL fetch (avoid) | `txid` in `62`.`05` |
| `pix-automatico` | ✓✓ (authorisation = subscription sign-up) | ✓ | ✓ | n/a | Recurrence tags in Pix API 2.7+ |
| `pix-nfc` | – | – | ✓ (via bank notifications) | seconds | No payload visible |
| `alipay-wechat-qr` | ✓ (merchant hint only) | ✓ (weak) | – | <1 s | Opaque tokens |
| `paypay` | – | – | ✓ (notifications) | seconds | Merchant API only |
| `vipps-mobilepay`, `swish`, `bizum`, `blik`, `ideal-wero` | – | (web redirect via extension) | ✓ (notifications, PSD2) | seconds–days | Rail labels, no direct adapter |
| `sepa-instant`, `fednow-rtp` | – | – | ✓ (bank feeds) | seconds (rail); feed latency varies | Rail labels |
| `mpesa-confirmation-sms` | – | – | ✓✓ | seconds | Receipt code = dedup key |
| `mpesa-stk-push` | – | (merchant-side) | – | – | Avoid |
| `payment-request-api` (extension hook) | ✓ (total before sheet) | ✓ | – | ms | Research; invasive |
| `secure-payment-confirmation` | – | (browser-native) | – | – | Avoid; not observable |
| `apple-pay-web` / `google-pay-web` | – | (sheet not observable) | – | – | Use DOM context instead |
| `browser-checkout-dom` / `payment-confirmation-page` | ✓✓ (cart/total) | ✓✓ (Place-order click) | ✓ (confirmation/redirect) | ms | Desktop + iOS Safari |
| `payment-app-deeplink-handoff` | – | ✓ (return path) | – | ms | Required plumbing for QR flow |

---

## Implications for BRAKE architecture

### A. Adapter design

1. **`QRAdapter` as a pipeline, not a parser.**
   1. Image → string. Use the platform scanner: Android ML Kit or CameraX, iOS VisionKit/AVFoundation (implementation choice, not researched here).
   2. **Format sniffing:** a `upi:`/`UPI:` URI; an EMV MPM (starts with `000201`, ends with `6304` + 4 hex); a known proprietary URL; a plain URL; unknown.
   3. **Integrity:** EMV CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`) [15]; UPI `sign` (verify against an acquirer public key if one can be obtained; otherwise `signature_valid=unknown`).
   4. **Profile resolution** by MAI tag and GUID (`br.gov.bcb.pix` → PIX, `SG.PAYNOW` → PAYNOW, `A000000677010111` → PROMPTPAY, `A0000006150001` → DUITNOW, `A000000727` → NAPAS, `ID.CO.QRIS.WWW` → QRIS, Bakong `@` IDs → BAKONG, `02`/`04`/`06` → card schemes), driven by a **data file**, not code branches.
   5. Emit a `PaymentIntentObservation`.
   6. Discard the raw string unless the user saves it. Keep `sha256(raw)` for dedup.
2. **`UPIIntentAdapter`** (feature-flagged, Android, India). Re-use the UPI-URI parser from the QRAdapter and keep the raw URI immutable. If routing is enabled, relay with `startActivityForResult` to the chosen PSP package and pass the PSP's result extras back unmodified. Hard time budget: the reflection UI must never block "Pay anyway" for more than about 1 s, and the user must be able to disable it permanently in one tap.
3. **Rail-aware text parsers live in the SMS and notification adapters**, but this stream supplies the rail extraction rules: RRN/UTR (12-digit), VPA, M-Pesa receipt codes, PDN templates, and Pix/PayNow/PromptPay notification wording. Keep the rules as versioned, remotely updatable data with test fixtures.
4. **Never generate or modify payment payloads.** BRAKE reads them and hands them off. The only exception would be adding `am` to an *unsigned static* UPI QR after the user enters an amount in BRAKE. Even that should be `research`, because it turns BRAKE into a payment-initiation interface.

### B. Normalised observation shape (proposal)

```
PaymentIntentObservation
  observation_id, source_id ("qr-scan" | "upi-intent-url" | "browser-checkout-dom" | …)
  window: PRE_SPEND | IN_SPEND | POST_SPEND
  observed_at (device clock, UTC + tz)
  payment_rail: UPI | PIX | PAYNOW | PROMPTPAY | DUITNOW | QRIS | QRPH | NAPAS | BAKONG
              | CARD(scheme) | MPESA | VIPPS_MOBILEPAY | SWISH | BLIK | BIZUM | WERO
              | SEPA_INST | FEDNOW | RTP | ALIPAY | WECHAT | PAYPAY | UNKNOWN
  payload_format: UPI_URI | UPI_MANDATE_URI | EMV_MPM | PROPRIETARY | WEB_DOM
  initiation: QR_STATIC | QR_DYNAMIC | INTENT | COLLECT | MANDATE_CREATE | MANDATE_PDN | NFC | WEB_CHECKOUT
  counterparty:
    raw_name (pn / tag 59), localized_name (tag 64), banking_name (from later alert)
    alias_hash (sha256(salt+VPA|proxy|key)), alias_kind (VPA|MOBILE|UEN|CPF|EVP|BAKONG_ID|TILL|PAYBILL)
    mcc, city, country, signed: bool, signature_valid: true|false|unknown
    type_candidate: P2P | P2M | P2PM | UNKNOWN, type_confidence
  amount: { value: decimal string, currency: ISO 4217 alpha, editable: bool, minimum?: decimal,
            tip_rule?: (55/56/57), source: PAYLOAD | USER_DECLARED | NONE }
  funding_instrument_candidate: BANK_ACCOUNT | UPI_LITE | CREDIT_CARD | CREDIT_LINE | WALLET | UNKNOWN
  initiator: SELF | DELEGATE | DEVICE | MERCHANT_MANDATE | UNKNOWN
  references: { upi_tr, upi_tid, upi_txn_id, rrn, pix_txid, pix_e2eid, emv_bill(62.01),
                emv_ref(62.05), emv_terminal(62.07), khqr_md5, mpesa_receipt, order_id, raw_hash }
  recurrence?: { periodicity, start, end, max_amount }   # mandates / Pix Automatico
  expires_at?
  completion_probability: low (scan only) … high (result relayed)
  provenance_text
```

### C. Reconciliation keys by rail (what bridges pre-spend to post-spend)

| Rail | Pre-spend key(s) in payload | Post-spend key(s) in consumer-visible alerts | Bridge strategy |
|---|---|---|---|
| UPI | `pa` VPA, `am`, `tr`, `tid` | RRN / UPI Ref No, VPA or banking name, amount | hash(VPA) or name ↔ alert payee; amount exact; Δt ≤ 15 min (tune empirically) |
| Bharat QR (card leg) | `02`/`04`/`06` merchant IDs | card alert: merchant descriptor, last 4 | amount + Δt + fuzzy name |
| Pix | key (`26`.`01`), `txid` (`62`.`05`) | bank notification (amount, name); Open Finance `endToEndId` | amount + name + Δt; `txid` rarely visible |
| PayNow/PromptPay/DuitNow/QRIS/VietQR | proxy/MPAN/BIN+account, `62` refs | bank notification | amount + name + Δt |
| KHQR | MD5 of QR string | Bakong lookup is merchant-side | amount + Δt |
| M-Pesa | till/paybill + account | SMS receipt code | till/paybill + amount + Δt |
| Web checkout | cart total, domain | order e-mail order number; card/UPI alert | order number ↔ email; amount + Δt ↔ alert |

Merge rule (consistent with the brief): a scan/intent observation (`status=intent`) **attaches** to a later confirmed observation only when the payee **and** the amount agree. Otherwise it stays a separate intent that expires after N hours. Never infer a spend from a scan alone.

### D. Normalisation pitfalls

- **Amounts.** EMV `54` is a decimal string, so do not parse it to float. UPI `am` uses 2 decimals. Static QRs have no amount. `mam`, editable flags (PayNow `03`) and tips (`55`–`57`) mean the final amount ≠ the payload amount.
- **Currencies.** EMV uses ISO 4217 *numeric* (`356`), UPI uses alpha (`INR`). KHQR allows KHR or USD. Map everything to alpha internally.
- **Names.** `pn`/`59` are merchant-chosen, truncated (25 chars in Pix) and often upper-case. The banking name shown after OC-101A can differ [12]. `64` can carry a local-language name. Keep all three.
- **Country.** `58` is the *merchant's* country. Cross-border UPI Global and ASEAN links mean the user's currency may differ from `53`.
- **Payee identifiers are personal data.** VPAs, mobile proxies, CPF and Thai national IDs identify private individuals in P2P payloads. Hash with a device salt and never upload raw values.
- **Rail ≠ instrument ≠ app.** A UPI payment via the Paytm app can be funded by a RuPay credit card. A Pix payment via a bank app can be part of a Pix Automatico recurrence. Model each separately.
- **Transfers and commitments.** UPI Lite loads, Reserve Pay blocks, mandate creation, credit-card bill payments via UPI (MCC-specific high limits [12]) and own-account VPA payments are **not spending**.
- **Signed payloads are immutable.** Never re-encode a URI. Keep the byte order, because `sign` is the final tag over the preceding content [3].
- **Library drift.** Community libraries mislabel fields (for example `cu` as "callback URL" [5], or the CRC described as "XMODEM" [17]). Build conformance tests from primary specs when they become reachable.

### E. Capability-registry facts (machine-readable proposal)

```yaml
# as_of: 2026-10-04 ; verification: P=primary, S=secondary, U=unverified
- {country: IN, platform: [android, ios], capability: qr-scan.upi-uri, status: available, v: S}
- {country: IN, platform: [android, ios], capability: qr-scan.bharat-qr, status: available, v: S}
- {country: IN, platform: android, capability: upi-intent-url.intercept, status: limited, v: P,
   note: "any app can declare upi scheme; disambiguation dialog; user default bypasses; policy unreviewed"}
- {country: IN, platform: ios, capability: upi-intent-url.intercept, status: unavailable, v: P,
   note: "multiple handlers => undefined target"}
- {country: IN, platform: ios, capability: payment-app-handoff, status: limited, v: P,
   note: "LSApplicationQueriesSchemes max 50 (iOS15+), 25 (linked iOS27+)"}
- {country: IN, capability: upi-p2p-collect, status: unavailable, since: 2025-10-01, v: S}
- {country: IN, capability: upi-autopay-pdn, status: available, v: S, note: "24h PDN; MCC exemptions"}
- {country: IN, capability: upi-lite, status: available, v: S, limits: {per_txn_inr: 1000, balance_inr: 5000}}
- {country: IN, capability: upi-circle, status: available, v: S, limits: {per_txn_inr: 5000, monthly_inr: 15000}}
- {country: IN, capability: rupay-credit-on-upi, status: available, v: S}
- {country: IN, capability: upi-credit-line, status: emerging, v: S}
- {country: IN, capability: upi-reserve-pay, status: emerging, v: S}
- {country: BR, platform: [android, ios], capability: qr-scan.pix-br-code, status: available, v: S}
- {country: BR, capability: pix-automatico, status: available, v: P(api)/U(launch date)}
- {country: SG, capability: qr-scan.sgqr-paynow, status: available, v: S}
- {country: TH, capability: qr-scan.promptpay, status: available, v: S}
- {country: MY, capability: qr-scan.duitnow, status: available, v: S}
- {country: ID, capability: qr-scan.qris, status: available, v: S}
- {country: VN, capability: qr-scan.vietqr, status: available, v: S}
- {country: KH, capability: qr-scan.khqr, status: available, v: S}
- {country: PH, capability: qr-scan.qr-ph, status: limited, v: S, note: "profile GUIDs unverified"}
- {country: KE, capability: mpesa-confirmation-sms, status: available, v: U}
- {country: GLOBAL, platform: web, capability: payment-request-api, status: available, v: P,
   note: "Chrome 60+, Edge 15+, Safari 11.1+, Firefox pref-gated"}
- {country: GLOBAL, platform: web, capability: secure-payment-confirmation, status: limited, v: P, note: "Chrome 95+ only"}
- {country: US, capability: upi, status: unavailable, v: U}
- {country: EU, capability: sepa-instant, status: available, v: U}
```

---

## Risks, policy constraints and ethical concerns

1. **Regulated-flow interference (UPI intent routing).** BRAKE is not a PSP or TPAP. Placing it between a merchant app and a PSP app may be seen as tampering or as an unauthorised intermediary. No NPCI circular addressing non-PSP intent handlers was found; a query of an index of 226 NPCI/RBI circulars found no entries on app-to-app intent protocols [12][S]. Mitigations: never modify payloads, always offer "Pay without BRAKE", seek written comfort from NPCI or a partner PSP before launch.
2. **Payment-flow reliability harm.** A delay or crash in BRAKE during an intent or QR hand-off can cause failed or duplicated payments, merchant timeouts, and essential purchases (medicine, fuel) blocked at the counter. Friction must be skippable, capped in time, and never applied to low-confidence or essential-looking payments (for example MCCs for pharmacies and fuel).
3. **Fraud surface.** A third-party UPI handler is a phishing target, because malware may imitate it. QR payloads can carry `url` fields: never auto-open them. BRAKE must not claim a QR is "safe". Report what it can verify ("signature valid", "name differs from banking name") and nothing else.
4. **Platform policy.**
   - Google Play: package-visibility rules (`QUERY_ALL_PACKAGES` restricted [8]); SMS/notification policies (other streams); possible "deceptive behaviour" review of payment-intent handlers (unverified; policy pages unreachable).
   - Apple: no interception is possible, and the URL-scheme allowlist cap tightens to 25 for apps linked on iOS 27+ [10].
   - Browser stores: user-data disclosure and minimum-permission rules for checkout-reading extensions (unverified).
5. **Privacy and third-party data.** Payloads carry *other people's* identifiers: payee phone-number VPAs, CPF, national IDs. Hash on device, never upload raw values, and let the user purge the history. Indian data-protection obligations (DPDP Act 2023 and its Rules) apply to BRAKE's processing (status of the Rules not verified here). RBI's payment-data localisation directive targets payment-system operators (unverified applicability), but on-device processing avoids the question.
6. **Pix dynamic-code fetch.** Fetching the `26`.`25` location reveals the user to the receiving PSP and could be read as acting on the charge. Keep it off by default.
7. **No scolding at the till.** Interventions in IN-SPEND moments must be informational, for example "This is the 3rd café payment today; your weekly eating-out pace is 20% above usual." Never moralise, and stay silent when there is no insight (per the brief).
8. **Regulatory churn.** NPCI issued many material circulars in FY2025-26 alone (P2P collect ban, beneficiary-name display, API limits, AutoPay portability, biometrics, Reserve Pay, IoT delegation). Registry facts need an owner and a refresh cadence. The `captn3m0/npci-rss-feeds` project publishes NPCI circular RSS feeds twice daily [45] and could drive alerts.

---

## Open questions

1. Does NPCI (or do the major PSPs) permit a non-PSP app to register as a `upi://` handler and forward unmodified intents, and must it relay the result? Is there a TPAP/PSP partnership model (for example an "insights partner") that makes this legitimate?
2. Do PSP apps treat a QR payload re-launched by BRAKE as `mode=04` (intent) instead of `01` (QR), and does that change limits, risk scoring or the success rate? Needs empirical testing with PhonePe, Google Pay and Paytm.
3. Can BRAKE obtain public keys to verify UPI `sign` (signed QR) offline, or is verification possible only inside PSP apps?
4. Which UPI apps post *outgoing* payment notifications, with what text, and do UPI Lite payments produce any bank-side alert? Needs a device test matrix.
5. What exact tag or template carries a Pix Automatico authorisation in a BR Code, which jornadas expose the recurrence amount and periodicity in the payload, and which require fetching?
6. QR Ph P2P and P2M GUIDs, SGQR tag `51`, and the PromptPay bill-payment (tag `30`) layout all need confirmation from BSP/PPMI, MAS/IMDA and BOT specifications.
7. Is an extension that wraps `PaymentRequest` acceptable to the Chrome Web Store and Safari review, and is the user benefit worth the trust cost compared with DOM-only cart reading?
8. What share of Indian UPI P2M volume starts from intent vs QR vs collect vs Tap & Pay? This decides the relative value of §1 vs §2.
9. Would users actually "scan with BRAKE first"? Needs a behavioural experiment: the friction cost of a second scan vs the value of the reflection moment.
10. Primary-source re-verification: the NPCI Linking Spec (latest version, full parameter list including `purpose` values and UPI 2.0 GST tags), RBI e-mandate thresholds, the IPR/VoP dates, FedNow/RTP limits, and Wero/iDEAL migration timelines. All were unreachable in this session.

---

## References

Access legend: **F** = fetched and read in this session; **SR** = seen only as a web-search result or snippet (page not fetched).

1. https://www.labnol.org/files/linking.pdf (SR). Title "NPCI UPI LINKING SPECIFICATIONS 1.6 November 2017"; supports the spec version and the parameter names in the search summary.
2. https://github.com/bgagan911/RandomDocs/wiki/NPCI-UPI---Specifications-for-Deep-Linking (F). Parameter table `pa`, `pn`, `mc`, `tid`, `tr`, `tn`, `am`, `mam`, `cu`, `url`, with mandatory flags.
3. https://github.com/stingrayzboy/upi/pull/5 (F). `sign` = SHA-256 with RSA, base64, final tag (Linking Spec §1.3); response fields `txnId`, `responseCode`, `ApprovalRefNo`, `Status`, `txnRef` (§1.4); server-side verification required; `upi://mandate` lifecycle and aggregator inconsistencies.
4. https://raw.githubusercontent.com/stingrayzboy/upi/master/README.md (F). `tr` ≤35, `tn` ≤50, `mc` = ISO 18245; signed QR "`mode=02`, requiring the `sign` and `orgid` tags".
5. https://raw.githubusercontent.com/souravray/upi-link/master/README.md (F). `tr` mandatory when merchant/dynamic; Linking Spec 1.5.1; mislabelled `cu`.
6. Web-search snippets for the query on `upi://pay` `orgid`/`mode`/`purpose`, drawing on https://medium.com/@aryan.dcgpt/upi-qr-deep-link-abuse-how-attackers-exploit-payment-intents-and-how-to-stop-them-362e1e07c8f9 and https://qrcrack.com/blog/upi-qr-codes-india-npci-specification (SR). `mode` code list, `orgid` `000000` rule, signed QR from UPI 2.0 (Aug 2018) and app warning behaviour.
7. https://developer.android.com/training/basics/intents/sending (F). Disambiguation dialog, default app, `createChooser`.
8. https://developer.android.com/training/package-visibility/declaring (F). Android 11 `<queries>`, `QUERY_ALL_PACKAGES` restrictions.
9. https://developer.apple.com/tutorials/data/documentation/xcode/defining-a-custom-url-scheme-for-your-app.json (F). Undefined target for duplicate schemes; URL-scheme security; universal links recommended.
10. https://developer.apple.com/tutorials/data/documentation/uikit/uiapplication/canopenurl(_:).json (F). `LSApplicationQueriesSchemes` limits of 50 (iOS 15+) and 25 (iOS 27+); `false` for undeclared schemes.
11. https://coinlaw.io/upi-statistics/ (SR). "UPI Statistics 2026: 23.2 Billion Monthly Transactions" (headline only).
12. https://raw.githubusercontent.com/satwikrath01-cyber/UPI-Brain/main/index/pdf_summaries.json and https://github.com/satwikrath01-cyber/UPI-Brain (F). Third-party index of 226 NPCI/RBI UPI circulars (2016–2026), with summaries of OC-101A, OC-133A, OC-138B, OC-151A, OC-165, OC-169A, OC-170B, OC-171/171A, OC-175, OC-180, OC-181, OC-185A/B, OC-186, OC-192, OC-200, OC-201/201B, OC-205, OC-207, OC-209, OC-210, OC-215/215A, OC-220, OC-223, OC-226, OC-227, OC-228, OC-230/230A, OC-76C, RuPay OC-022 and Circular 11. Secondary: the circular PDFs themselves were not fetched.
13. https://raw.githubusercontent.com/rupeshk/bqrparser/master/BQRParser.js (F). Bharat QR tag map (`02`/`04`/`06`/`08`/`26`/`27`/`28` and `62` sub-tags).
14. https://raw.githubusercontent.com/mvallim/emv-qrcode/master/src/main/java/com/emv/qrcode/model/mpm/constants/MerchantPresentedModeCodes.java and .../AdditionalDataFieldCodes.java (F). EMV MPM root IDs `00`–`99` and `62` sub-IDs `01`–`11`, `50`–`99`.
15. https://raw.githubusercontent.com/mvallim/emv-qrcode/master/src/main/java/com/emv/qrcode/core/CRC.java (F). CRC poly `0x1021`, init `0xFFFF`, ISO/IEC 13239.
16. https://github.com/DHCertainty/DuitNowQR (F). `01`=`11` static / `12` dynamic (also [21]).
17. https://raw.githubusercontent.com/dtinth/promptpay-qr/master/index.js (F). PromptPay tag `29`, GUID `A000000677010111`, sub-tags `01`/`02`/`03`, `TH`/`764`, `11`/`12`.
18. Search results: https://www.centralbank.go.ke/QR/KenyaQuickResponseCodeStandard.pdf, https://www.hkma.gov.hk/media/eng/doc/key-functions/financial-infrastructure/infrastructure/retail-payment-initiatives/Common_QR_Code_Specification.pdf, https://www.emvco.com/knowledge-hub/the-what-why-and-how-of-emv-qr-codes/ (SR). MAI `02`–`25` for EMVCo payment networks, `26`–`51` for any operator, ≤99 chars, at least one present; CRC16 `0x1021` with example `6304007B`; existence of the Kenya and HK national standards.
19. https://github.com/igorgbr/pix_brcode (F). BR Code `26` sub-tags, `txid` rules, name/city limits, DICT key formats, static vs dynamic.
20. https://github.com/sausheong/SGQR (F). `SG.PAYNOW` sub-fields; SGQR Specification v1.7.
21. https://github.com/DHCertainty/DuitNowQR (F). DuitNow GUID `A0000006150001`, sub-tags, `458`/`MY`.
22. https://github.com/ezha-payment/qris-go (F). QRIS MAI `26`–`51`, `ID.CO.QRIS.WWW`, NMID tag `51`, MPAN, merchant criteria, static-to-dynamic.
23. https://github.com/qrph/qrph and https://raw.githubusercontent.com/qrph/qrph/master/README.md (F). QR Ph is EMVCo-based and BSP-mandated; R.A. 11127 cited.
24. https://github.com/liopayvn/vietqr-php (F). VietQR tag `38`, GUID `A000000727`, BIN/account, `QRIBFTTA`/`QRIBFTTC`, NAPAS spec v1.5.2.
25. https://github.com/bsthen/bakong-khqr (F). KHQR `name@bank`, tag `99`, `116`/`840`, MD5 transaction check, Bakong API base URLs.
26. https://registry.npmjs.org/bakong-khqr (F). Expiry timestamp required for dynamic KHQR; SDK v1.0.20 (Apr 2025).
27. https://github.com/saurabhgupta050890/transaction-sms-parser (F). Indian bank SMS fields and example SMS.
28. https://developer.android.com/about/versions/15/behavior-changes-all (F). Android 15 OTP redaction for untrusted NotificationListenerService apps.
29. https://x.com/Indianinfoguide/status/2021435416294146229 (SR). January 2026 UPI app shares.
30. https://startupfeed.in/phonepe-upi-market-share-april-2026/ (SR). April 2026 shares.
31. https://www.threads.com/@trakintech/post/DZpduDyFzOQ/upi-apps-market-share-in-may-phone-pe-google-pay-paytm-navi-super-money-bhim/ (SR). May 2026 top-10 app shares (source: NPCI).
32. https://lapaasvoice.com/upi-may-phonepe-googlepay-share/ (SR). PhonePe + Google Pay first sub-80% reading (May 2026).
33. https://github.com/bacen/pix-api (F). Official BCB Pix API repository, version 2.10.0.
34. https://raw.githubusercontent.com/bacen/pix-api/master/changelog.md (F). Pix Automatico tags (`Rec`, `SolicRec`, `CobR`, `LocRec`, webhooks), `rec.dadosQR.pixCopiaECola`/`jornada`, versions 2.7.0–2.10.0.
35. https://raw.githubusercontent.com/bacen/pix-api/master/openapi.yaml (F). Pix object fields; `Rec` fields; `txid` filter pattern.
36. https://github.com/paypay/paypayopa-sdk-node (F). PayPay QR/native flows, `merchantPaymentId`/`codeId`/`paymentId`, statuses, 4–5 s polling.
37. https://raw.githubusercontent.com/vippsas/agent-toolkit/main/plugins/vipps-developer/skills/epayment/SKILL.md (F) (plus https://github.com/vippsas). Vipps MobilePay ePayment currencies, `userFlow`s, states, `reference` pattern, `receipt`.
38. https://github.com/safaricom/mpesa-node-library (F). Official Safaricom library: M-Pesa Express and other APIs, `CustomerPayBillOnline`.
39. https://github.com/wamaithaNyamu/Lipa-na-Mpesa-STK-Push- (F). STK callback identifiers `MerchantRequestID`, `CheckoutRequestID`, `ResultCode`, `ResultDesc`.
40. https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PaymentRequest.json (F). Payment Request and SPC browser support; `securePaymentConfirmationAvailability()` in Chrome 139.
41. https://github.com/w3c/secure-payment-confirmation and https://raw.githubusercontent.com/w3c/secure-payment-confirmation/main/explainers/secure-payment-confirmation.md (F). SPC data flow and displayed fields.
42. https://developer.apple.com/tutorials/data/documentation/applepayontheweb.json (F). Apple Pay JS and Payment Request availability by OS and region.
43. https://github.com/search?q=qris+parser&type=repositories (F). Listing of `suriyadi15/qrishook`, an Android QRIS notification forwarder.
44. https://developer.apple.com/tutorials/data/documentation/financekit.json (F). FinanceKit scope, managed entitlement, iOS 17+.
45. https://github.com/captn3m0/npci-rss-feeds (F). Twice-daily RSS feeds of NPCI circulars, for registry maintenance.
46. https://developer.android.com/reference/android/service/notification/NotificationListenerService (F). Notification listener basics (context for §9).
