# Merchant Context and Contextual Signals for BRAKE (Research Stream 13)

> **Scope.** Where BRAKE can get *who* the user is paying (merchant identity, category, store type,
> online vs physical, recurring/subscription status, the user's own history with that merchant), and
> *when and why* the spend happens (time, payday, budget cycle, upcoming bills, goals, travel,
> velocity, regret patterns, user rules). It covers sensor-based context (location, geofencing,
> calendar) and judges whether it is justified or surveillance. It proposes a **Context
> Justification Test (CJT)** and a catalogue of on-device context features.
> Out of scope: transport of transactions themselves (SMS, notifications, Plaid, Account Aggregator
> and email ingestion), which other streams cover. This document uses only their merchant and
> context fields.
>
> **Date:** 2026-10-04. Every time-sensitive claim is "as of 2026-10-04" unless dated otherwise.
>
> **Verification note.** Web search was not available for this stream (the session's search budget
> was used up), and the egress proxy blocked many primary domains (plaid.com, npci.org.in,
> rbi.org.in, iso.org, emvco.com, bcb.gov.br, consumerfinance.gov, ecfr.gov, eur-lex, curia,
> support.google.com, developers.google.com, developer.visa.com, developer.mastercard.com,
> docs.ntropy.com, learn.microsoft.com, schema.org, wikipedia). Where possible, facts were checked
> against primary machine-readable artefacts instead: Plaid's official OpenAPI spec, the Open
> Banking UK / Australia CDR / Open Finance Brasil OpenAPI specs, ReBIT-derived Account Aggregator
> XSDs hosted by Sahamati, the Overture and OSM name-suggestion-index repositories, Google's
> `googleapis` protos and Maps Service Specific Terms, and Apple's and Android's developer docs.
> Claims I could not check this session are marked **(unverified)**.
>
> **Fact-check pass (2026-10-04).** An adversarial review re-fetched the cited artefacts directly
> (web search was again unavailable). All 37 external references were re-downloaded and read, and
> all returned HTTP 200; reference 38 is local. Corrections are inline, and each checked claim is
> listed in the [Verification log](#verification-log). These domains were still blocked:
> plaid.com, npci.org.in, labnol.org, bcb.gov.br, emvco.com, iso.org, consumerfinance.gov, federalregister.gov, ecfr.gov,
> eur-lex, curia, rbi.org.in, sahamati.org.in, docs.overturemaps.org, support.google.com,
> wikipedia, wikidata. The main corrections:
>
> - Overture's total is about **81.5M** (81,455,423), not 81.6M.
> - The UPI `mc` parameter is **optional**.
> - The Apple repurposing clause is **5.1.2(ii)**, not 5.1.2(i).
> - Google Places has **separate, stricter EEA terms**.
> - The sensitive-MCC deny-list was **incomplete**.
> - AA `transactionTimestamp` does **not** guarantee a UTC offset.
>
> **Key takeaways for BRAKE**
>
> 1. **The MCC (ISO 18245) is the most widely available structured category signal, but it is a
>    merchant-level prior, not a purchase-level truth.** It appears in Plaid (beta), Apple
>    FinanceKit, UK Open Banking, Berlin Group card accounts, Australia CDR, Open Finance Brasil
>    credit cards, India AA *credit-card* data, EMV merchant QR (tag 52, mandatory) and UPI QR
>    (`mc`, which is *optional* in the UPI linking spec v1.6). It is missing where India needs it
>    most: AA *deposit* transactions carry only `mode` (CASH/ATM/CARD/UPI/FT/OTHERS) and
>    free-text `narration`.
> 2. **In India the MCC can arrive *before* payment, not after.** A BRAKE UPI/EMV QR scan reads the
>    merchant's name, MCC (when the QR carries `mc`) and (EMV) city before the user pays. In card
>    markets the MCC is only known post-spend. QR scanning is therefore BRAKE's best PRE-SPEND
>    merchant-context source in QR-first markets.
> 3. **MCC formats are incompatible across sources and must be normalized on ingest.** FinanceKit
>    uses `Int16` and Brazil `payeeMCC` uses an integer, so leading zeros are lost (0742 becomes
>    742). UK OB allows 3–4 characters. Ntropy returns a *list* of integer MCCs per entity. Pix QR
>    commonly carries the placeholder `0000`. Use a canonical 4-character zero-padded string, and
>    treat placeholders as null.
> 4. **Merchant identity should be resolved on-device against open brand data anchored on Wikidata
>    QIDs.** Sources: the OSM name-suggestion-index (BSD-3, country-scoped `locationSet` and
>    `matchNames`; for example Starbucks → `Q37158`, DMart → `Q5203271`) and Overture Places (about
>    81.5M places in the September 2026 release under CDLA-Permissive-2.0 / Apache-2.0 / CC0, new
>    ~2,300-category taxonomy plus ~280 `basic_category` labels). Vendor IDs such as Plaid
>    `merchant_entity_id` become aliases. Descriptors are not sent off-device by default.
> 5. **Intermediaries are the biggest normalization trap.** Plaid's own example `DD DOORDASH
>    BURGERKIN` resolves to two counterparties: DoorDash (`marketplace`) and Burger King
>    (`merchant`). Payment terminals (Square, Toast), app stores, wallets and gateways hide the real
>    merchant. Model `merchant = {intermediary?, underlying_merchant?}` from day one.
> 6. **Most context BRAKE needs can be derived from data the user already consented to share, so
>    new sensors are rarely needed.**
>    - *Where:* Plaid `location`, EMV QR merchant city and postal code, Berlin Group
>      `cardAcceptorAddress`.
>    - *Online vs in store:* Plaid `payment_channel`, UK OB `CardInstrument.AuthorisationType`,
>      QR static vs dynamic.
>    - *Travel:* foreign currency or country, airline and lodging MCCs, the OS time-zone-change
>      broadcast.
>    - *Payday:* recurring inflow streams.
>    - *Upcoming bills:* recurring outflow streams, AA credit-card `dueDate`/`minDueAmount`,
>      Australia CDR BPAY `billerCode` and `DIRECT_DEBIT` type.
> 7. **Background location and geofencing fail the Context Justification Test for MVP.**
>    - *Platform cost:* `ACCESS_BACKGROUND_LOCATION` (granted on a settings page on Android 11+),
>      100 geofences per app, 2–6 minute latency, and 20 monitored conditions on iOS.
>    - *What it reveals:* sensitive places (clinics, places of worship, home and work).
>    - *What it misses:* being near a shop is a weak proxy for intent to buy.
>
>    For user-initiated "Should I buy this?" moments, use session-scoped location instead: Android
>    17's location button or iOS reduced-accuracy one-shot. An opt-in "trouble spots" mode stays a
>    research item.
> 8. **Calendar *read* access: avoid. Calendar *write-only* access: adopt.** Use write-only access
>    for renewal and bill reminders: iOS 17 write-only or EventKitUI with no permission, Android
>    `ACTION_INSERT` with no permission, Google `calendar.app.created`.
> 9. **Time-of-day features need minute-precision timestamps, and many feeds do not have them.**
>    Plaid's `authorized_datetime` "is returned for select financial institutions" and "may contain
>    default time values (such as 00:00:00)", and many ledgers are date-only. Every context feature must carry `time_precision` and abstain
>    when it is too coarse. Otherwise "late-night regret" learning will be wrong.
> 10. **Sensitive merchant categories need a hard deny-list.** Examples: political (8651),
>     religious (8661), medical (8011/8062/8099), pharmacy (5912), dating/escort (7273) and betting
>     (7995). *Fact-check:* that list is not enough. The deny-list must also cover:
>     - the whole medical block: 8021 dentists, 8031, 8041, 8042, 8043 opticians, 8049, 8050
>       nursing care and 8071 labs;
>     - medical goods: 5975 hearing aids and 5976 orthopedic goods;
>     - 7277 debt, marriage and personal counselling;
>     - 7297 massage parlors;
>     - 9211 court costs including alimony and child support, and 9223 bail and bond;
>     - 8641 and 8699 membership organisations, which can stand in for union membership.
>
>     These categories never go into server telemetry, nudge copy or default regret prompts.
>     Treat the CJT as a registry-enforced gate with automatic sunset when a signal's measured lift
>     disappears.

---

## Sources investigated

### Method and verification status

Each source below is described with the same fields:

- what it is;
- concrete fields;
- time windows and latency;
- coverage;
- access requirements;
- privacy and consent;
- reliability and failure modes;
- deduplication keys;
- the normalized BRAKE observation it produces;
- a provenance sentence;
- a recommendation.

Field names are quoted from the artefacts listed in [References](#references). The code model in
`packages/core/src/model/observation.ts` already has `MerchantObservation {raw, name, key, mcc,
handle, website, channel, confidence}` and `CategoryHint {scheme, value, confidence}`. Proposals
here extend that model. They do not replace it.

### A. Evaluation lens: the Context Justification Test (CJT)

The brief says: *"Do not collect context merely because it is technically available."* The CJT
turns that rule into a gate the capability registry can enforce. A contextual signal **S** may be
collected or computed for a feature **F** only if it passes every check:

| # | Check | Pass condition | Evidence artefact |
|---|-------|----------------|-------------------|
| 1 | **Decision link** | S feeds a named intervention decision in a feature spec: whether to intervene, how strongly, with what message, or whether to ask a question. "Might be useful later" fails. | Feature spec id |
| 2 | **Derivability first** | No already-consented source gives S, or a proxy for it, with ≥ 90 % of S's lift. If one does, use the derivation and do not collect S. | Ablation vs derived proxy |
| 3 | **Measured lift** | Offline or field ablation improves a pre-registered metric with 95 % CI lower bound > 0. Candidate metrics: intervention helpful-rate, precision of "worth intervening", regret-prediction AUC, question-avoidance rate. The test is re-run on a schedule. | `liftEvidence {metric, delta, ci95, n, asOf}` |
| 4 | **User expectation (contextual integrity)** | In a comprehension test, at least a set share of users (proposal: ≥ 70 %), shown the provenance sentence, say they would expect a spending coach to use S this way. The flow respects the norms of the context S came from (Nissenbaum's contextual integrity; not re-verified this session). | `expectationEvidence` |
| 5 | **Least precision and duration** | Use the coarsest granularity that keeps the lift (city, not coordinates; hour bucket, not timestamp; "payday ± 2 days", not salary amount), keep it for the shortest time, and compute it on-device. | Precision and retention declaration |
| 6 | **Sensitive-inference screen** | S cannot reveal or strongly imply special categories (health, religion, sexual life, politics, union membership) or home/work location. If it can, those values are suppressed. | Deny-list coverage |
| 7 | **Independent consent and reversibility** | S has its own toggle. BRAKE still works without it. Disconnecting S deletes it and recomputes derived features, which matches the existing fusion "reversibility" rule. | Registry `requires` plus deletion test |
| 8 | **No third-party leakage** | Computing S does not send S, or what S reveals, to a third party unless the user's benefit requires it and their consent covers it. Example: sending purchase coordinates to a maps API fails unless the user explicitly asked for that lookup. | Data-flow diagram |

Signals **derived** from already-consented data still need checks 1, 5, 6 and 7. Signals that
need a **new permission or new collection** must pass all eight before they leave "trial". Each
signal gets a machine-readable *justification card* in the registry:

```ts
interface ContextJustification {
  signalId: string;                 // "ctx:payday-proximity"
  decisions: string[];              // ["prespend.friction_level", "postspend.insight_select"]
  derivedFrom: string[] | null;     // consented source ids; null = new collection
  newPermission?: string;           // "ACCESS_BACKGROUND_LOCATION", "EventKit.fullAccess"
  precision: string;                // "day", "hour_bucket", "city"
  retention: string;                // "aggregates 13 months; raw 0 days"
  processing: "on_device" | "server";
  sensitiveInferenceRisk: "none" | "screened" | "high";
  liftEvidence?: { metric: string; delta: number; ci95: [number, number]; n: number; asOf: string };
  expectationEvidence?: { method: string; expectRate: number; n: number; asOf: string };
  sunsetReviewBy: string;           // ISO date; auto-disable if evidence is stale
  status: "approved" | "trial" | "rejected";
}
```

### B. Merchant identity and category sources

#### B1. ISO 18245 Merchant Category Code (MCC) — `iso-18245-mcc`

- **What it is.** A 4-digit code describing a merchant's line of business. ISO 18245 defines it.
  The *acquirer* assigns it to the merchant account, not to each item or transaction.
  - Plaid links the standard at `iso.org/standard/33365.html`, which is the 2003 edition.
  - Whether a newer edition supersedes it is **(unverified)**: iso.org was unreachable.
- **Data actually available.** Only the code. Descriptions come from public tables. One
  community-maintained table (greggles/mcc-codes, compiled from IRS/USDA/issuer lists) has 981
  rows. Codes relevant to BRAKE:

  | Group | Codes |
  |-------|-------|
  | Groceries and retail | 5411 groceries, 5300/5310/5311/5399 wholesale, discount and department stores, 5999 misc. retail |
  | Food and drink | 5812 restaurants, 5814 fast food, 5813 bars |
  | Digital and subscriptions | 5815–5818 digital goods, 5968 continuity/subscription merchant, 4899 cable/pay TV |
  | Cash, transfers, tax | 6010/6011 cash disbursement, 4829 wire/money order, 6051 non-FI currency/money orders, 9311 tax |
  | Travel | 3000–3299 airline brand codes (e.g. 3000 United), 3501–3999 lodging brand codes, 4511 airlines, 7011 lodging, 4722 travel agencies |
  | Sensitive | 8011 doctors, 8062 hospitals, 8099 medical NEC, 5912 pharmacies, 8651 political organizations, 8661 religious organizations, 7273 dating/escort, 7995 betting, 5921 liquor stores, 5993 cigar stores. **Added by fact-check** (all present in the greggles table): 8021 dentists, 8031 osteopaths, 8041 chiropractors, 8042 optometrists, 8043 opticians, 8049 podiatrists, 8050 nursing/personal care, 8071 medical/dental labs, 5975 hearing aids, 5976 orthopedic goods, 7277 counseling (debt, marriage, personal), 7297 massage parlors, 9211 court costs incl. alimony/child support, 9223 bail and bond, 8641 civic/fraternal associations, 8699 membership organizations |
- **Windows.**
  - POST-SPEND on card feeds.
  - PRE-SPEND or IN-SPEND when read from a merchant QR before payment (B10, B11).
- **Coverage.** Every card network. Field-level availability is in B2–B11.
- **Access.** Free in the sense that it rides along inside sources already connected.
- **Privacy.** Medium on its own; high for the sensitive codes. An MCC can reveal health,
  religion or political activity even when the merchant name is opaque.
- **Reliability and failure modes.**
  - It is a *merchant-level* label. A supercenter coded as groceries also sells TVs, and
    marketplace and aggregator merchants hide the real seller.
  - Payment facilitators can put many sub-merchants under generic codes **(unverified for
    specific PayFacs)**.
  - Merchants and acquirers have incentives to pick codes that change interchange or rewards
    **(unverified)**.
  - New codes are added over time. Two examples **(both unverified)**: 5552 EV charging, and
    firearms MCC 5723, which ISO approved in 2022 and whose rollout was paused amid conflicting US
    state laws. Neither code appears in the 981-row greggles table (checked 2026-10-04), so that
    table is not current. Whether ISO 18245:2003 has been superseded is still **(unverified)**,
    because iso.org was blocked.
  - MCC is absent from many feeds (AA deposit, most SMS alerts, many UPI ledgers).
- **Dedup keys.** None. It is a weak *agreement feature* in fusion and must never be used as a
  blocking key.
- **BRAKE observation.**
  - Stored as `CategoryHint {scheme: "mcc", value: "5814", confidence}`.
  - Confidence reflects the code's *specificity*: about 0.85 for 5814 or 5411, about 0.3 for 5999
    or 5399, and none for placeholders (`0000`, empty).
  - A separate `mcc_class` flag (`cash`, `transfer_like`, `tax`, `sensitive`, `travel`,
    `subscription_like`) feeds transaction-type reconciliation and the privacy deny-list.
- **Provenance sentence.** "Category suggested by the merchant code your card network reported
  (5814 — fast food)."
- **Recommendation: `mvp`.** Consume the MCC wherever it is present, normalize it (see
  Implications) and use it as a prior. Ship the sensitive-code deny-list with it.

#### B2. Plaid Transactions merchant fields — `plaid-transactions`

- **What it is.** The merchant-enrichment fields on every Plaid `Transaction`, from
  `/transactions/sync` or `/transactions/get`. Source: Plaid OpenAPI `2020-09-14_1.762.0`, read
  2026-10-04.
- **Data actually available.**
  - **Names.** `merchant_name`, "enriched by Plaid from the `name` field". `name` is legacy.
    `original_description` is opt-in.
  - **Merchant entity.** `merchant_entity_id`, "a unique, stable, Plaid-generated ID that maps to
    the merchant". For chains it maps "to the broader merchant, not a specific location".
  - **Counterparties.** `counterparties[]`, each with:
    - `name`, `entity_id`, `logo_url`, `website`;
    - `confidence_level` (`VERY_HIGH` > 98 %, `HIGH` > 90 %, `MEDIUM`, `LOW` meaning "a cleansed
      name parsed out of the request description", `UNKNOWN`);
    - `account_numbers` (BACS or IBAN, "select financial institutions in Europe");
    - `type` ∈ `merchant | financial_institution | payment_app | marketplace | payment_terminal |
      income_source`.
  - **Category.**
    - `personal_finance_category {primary, detailed, confidence_level, version}` plus
      `personal_finance_category_icon_url`.
    - `version` ∈ `v1 | v2`. *Customers who enabled Transactions or Enrich on or after December 3,
      2025 can receive only `v2`.*
  - **MCC.** `merchant_category_code`: "This field is in **beta**: it is populated primarily for
    card transactions, coverage varies by institution, and values are subject to change."
  - **Channel.** `payment_channel` ∈ `online | in store | other`. It replaces the deprecated
    `transaction_type` (`digital | place | special | unresolved`).
  - **Location.** `location {address, city, region, postal_code, country, lat, lon,
    store_number}`. It is "provided only for transactions at physical locations, not for online
    transactions" and is "most likely to be populated for transactions at large retail chains".
  - **Other.** `logo_url` (100×100 PNG), `website`, `transaction_code`, `payment_meta`.
  - **Times.** `authorized_date` and `authorized_datetime`. The datetime "is returned for select
    financial institutions and comes as provided by the institution. It may contain default time
    values (such as 00:00:00)". The posted `datetime` carries the same caveat. Expect many US
    Items to have only a date.
- **Windows and latency.** POST-SPEND. Pending transactions arrive in minutes to hours, depending
  on the institution **(unverified)**. Posting takes 1–5 days.
- **Coverage.** Country coverage belongs to the financial-data streams. Plaid's `CountryCode`
  enum (spec 1.762.0) lists 20 countries:
  - North America and UK: US, CA, GB;
  - EEA outside the EU: NO;
  - 16 EU states: ES, NL, FR, IE, DE, IT, PL, DK, SE, EE, LT, LV, PT, BE, AT, FI.

  Per-country availability of each enrichment field is **(unverified)**. Merchant entities and
  logos are best for US chains **(unverified for other markets)**.
- **Access.** Plaid production approval and per-product pricing **(pricing unverified)**.
- **Privacy.**
  - Data passes through Plaid servers under the user's Link consent.
  - Fetching `logo_url` from Plaid's CDN (`plaid-merchant-logos.plaid.com`) leaks IP address and
    merchant to the CDN. Proxy or cache logos.
- **Reliability.**
  - High for chains. Lower for local merchants (counterparty `confidence_level: LOW`).
  - PFC v1 and v2 differ, so map both.
- **Dedup keys.** `transaction_id`, `pending_transaction_id` (posted → pending link),
  `merchant_entity_id` (merchant key alias), `counterparties[].entity_id`.
- **BRAKE observation.**
  - `MerchantObservation`:
    - `raw` = `original_description` or `name`;
    - `name` = `merchant_name`;
    - `key` = `plaid:<merchant_entity_id>`, aliased to a BRAKE key;
    - `mcc`; `website`; `channel`.
  - `CategoryHint`s: `{scheme: "plaid_pfc_v2", value: detailed}`, and `{scheme: "mcc"}` when
    present.
  - Confidence maps `VERY_HIGH → 0.98`, `HIGH → 0.9`, `MEDIUM → 0.7`, `LOW → 0.4`.
  - Intermediaries come from `counterparties[type ∈ {marketplace, payment_terminal,
    payment_app}]`.
- **Provenance sentence.** "Merchant identified as Burger King (ordered through DoorDash) from
  your bank transaction, enriched by Plaid."
- **Recommendation: `mvp`** for any market where the Plaid adapter ships. The merchant fields come
  at no extra integration cost. Consume `counterparties` from day one.

#### B3. Plaid Recurring Transactions — `plaid-recurring-transactions`

- **What it is.** `/transactions/recurring/get`, which returns `inflow_streams[]` and
  `outflow_streams[]`, plus a `RECURRING_TRANSACTIONS_UPDATE` webhook.
- **Fields.** `TransactionStream`:
  - identity and merchant: `stream_id`, `account_id`, `description`, `merchant_name`;
  - dates: `first_date`, `last_date`, `predicted_next_date`;
  - `frequency` ∈ `UNKNOWN | WEEKLY | BIWEEKLY | SEMI_MONTHLY | MONTHLY | ANNUALLY`;
  - `transaction_ids[]`;
  - amounts: `average_amount` and `last_amount`, each `{amount, iso_currency_code}`;
  - `is_active`;
  - `status` ∈ `MATURE` (≥ 3 transactions on a regular cadence; annual after 2) |
    `EARLY_DETECTION` | `TOMBSTONED` | `UNKNOWN`;
  - `personal_finance_category`;
  - `is_user_modified`, "discontinued", always `false`.
- **Windows.** PRE-SPEND (`predicted_next_date` drives "renews tomorrow") and POST-SPEND.
- **Latency.** Batch. Plaid advises requesting ≥ 180 days of history (`days_requested`).
- **Access.** Plaid's spec says: "This endpoint is offered as an add-on to Transactions", and it
  is requested through a product access request. Pricing and country availability are
  **(unverified)**.
- **Reliability.** Good for monthly bills. Needs 3 occurrences before `MATURE`, so a new
  subscription shows as `EARLY_DETECTION` first. User edits are no longer supported upstream, so
  BRAKE must hold user overrides itself.
- **Dedup keys.** `stream_id`, `transaction_ids[]`.
- **BRAKE observation.** A context record `recurring_series {series_key, cadence, next_expected,
  amount_stats, status, source: "plaid"}`, reconciled with BRAKE's own detector (B17).
- **Provenance sentence.** "Plaid and BRAKE both see a monthly Netflix charge; the next one is
  expected on 12 Oct."
- **Recommendation: `next`.** BRAKE needs its own detector for every country anyway. Plaid
  streams are a strong second opinion where available.

#### B4. Plaid Enrich (non-Plaid data) — `plaid-enrich`

- **What it is.** `/transactions/enrich`, which "enriches raw transaction data generated by your
  own banking products or retrieved from other non-Plaid sources".
- **Inputs.**
  - `account_type` (`depository | credit`).
  - Up to **100** transactions per request, each with: `id`, `description`, `amount` (≥ 0),
    `direction` (`INFLOW | OUTFLOW`), `iso_currency_code`, optional `location {country, region
    (US state / Canadian province code), city, address, postal_code}`, `mcc`, `date_posted`.
- **Outputs.** `enrichments {counterparties[], entity_id, location, logo_url, merchant_name,
  payment_channel, phone_number, personal_finance_category, personal_finance_category_icon_url,
  website}`.
- **Windows.** POST-SPEND. It could also run in-spend on a parsed alert **(latency unverified)**.
- **Coverage.** The input schema targets US and Canada (region codes). Quality for Indian UPI
  narration or SMS text is **(unverified)**.
- **Privacy.**
  - Sends descriptors and amounts of transactions *not* obtained via Plaid to a third party. That
    needs its own consent line.
  - Hidden fields `client_user_id` and `client_account_id` exist. BRAKE should not send them.
- **Dedup keys.** Echoes the caller's `id` only.
- **Provenance sentence.** "Merchant name cleaned up by Plaid from your bank SMS."
- **Recommendation: `later`.** Useful for US users who connect SMS, email or a non-Plaid bank. It
  breaks local-first processing, so evaluate it against the on-device resolver (B19) before
  adopting.

#### B5. Ntropy transaction enrichment — `ntropy-enrichment`

- **What it is.** A third-party enrichment API with an open-source SDK
  (`ntropy-network/ntropy-sdk`).
- **Inputs.** `id`, `description`, `date`, `amount` (non-negative), `entry_type`, `currency`,
  `account_holder_id`, `location {raw_address, country}`.
- **Outputs.**
  - **Entities.**
    - `entities.counterparty {id, name, website, logo, mccs: List[int], phone_number, tax_number,
      type: person | organization}` and `entities.intermediaries[]`.
    - Intermediaries are modelled separately, which matches the BRAKE need in B2.
  - **Categories.** `categories.general` and `categories.accounting` (business only).
  - **Location.** `location.structured {street, city, state, postcode, country_code, country,
    latitude, longitude, google_maps_url, apple_maps_url, store_number, house_number}`.
  - **Recurrence.**
    - `recurrence {type: recurring | subscription | "one off", group_id}`. Ntropy separates
      *recurring* (varying amount) from *subscription* (fixed amount).
    - Recurrence groups carry `periodicity` (daily … yearly), `periodicity_in_days`,
      `average_amount` and `transaction_ids`.
- **Windows.** POST-SPEND.
- **Coverage, pricing, data residency.** **(unverified)**. docs.ntropy.com was unreachable.
- **Privacy.** Server-side processing of raw descriptors. `person` counterparties mean P2P
  payee names leave the device.
- **Dedup keys.** Caller `id`, recurrence `group_id`.
- **Provenance sentence.** "Merchant details from an enrichment service (Ntropy)."
- **Recommendation: `research`.** Its intermediary and recurrence semantics are a good *design
  reference* for BRAKE's own schema. As a dependency, evaluate it only if the on-device resolver
  under-performs on Indian or other non-US descriptors.

#### B6. Card-network merchant data APIs (Visa, Mastercard) — `card-network-merchant-apis`

- **What it is.** Network services that map statement descriptors or acceptor IDs to cleansed
  merchant names, addresses and MCCs. Examples: Visa Merchant Search/Locator and Mastercard
  Merchant Identifier.
- **Fields, access terms, pricing.** **(all unverified)**: developer.visa.com and
  developer.mastercard.com were unreachable.
- **Windows.** POST-SPEND.
- **Access.** Typically issuer, acquirer or approved-partner programs **(unverified)**.
- **Privacy.** A server-side lookup per merchant, which leaks less than per-user calls if batched
  and anonymized.
- **Recommendation: `later`.** Only if a partnership exists. Open brand data (B14, B15) plus
  aggregator enrichment cover the MVP.

#### B7. Open-banking standard merchant fields (UK, EU, Australia, Brazil)

These are fields of AIS adapters that other streams own. They are listed here because they decide
how much merchant context BRAKE gets "for free" per country.

**B7a. UK Open Banking Account and Transaction API v4.0.1 — `uk-open-banking-ais`**

- **Merchant fields.**
  - `MerchantDetails {MerchantName (1–350 chars), MerchantCategoryCode (3–4 chars, "conform to
    ISO 18245")}`.
  - `CardInstrument {CardSchemeName ∈ AmericanExpress | Diners | Discover | MasterCard | VISA,
    AuthorisationType ∈ ConsumerDevice | Contactless | None | PIN, Name, Identification
    (masked)}`.
  - `TransactionInformation`, `BankTransactionCode`, `ProprietaryBankTransactionCode`,
    `CategoryPurposeCode`, `PaymentPurposeCode`, `CurrencyExchange`, `UltimateCreditor`.
- **Field conditionality.** The spec says: "There are no optional fields, if a field is not marked
  as 'Required' it is a Conditional field." Banks populate merchant fields inconsistently
  **(unverified per bank)**.
- **Channel.** `AuthorisationType` is a card-present proxy:
  - `Contactless` and `PIN` strongly imply card-present use. `ConsumerDevice` most likely means a
    phone or wallet, which can be in-store or in-app.
  - `None` is ambiguous. The exact semantics of `ConsumerDevice` and `None` in the OB code set are
    **(unverified)**.
- **Dedup keys.** `TransactionId`, `TransactionReference`, `StatementReference`.
- **Provenance sentence.** "Merchant and category from your bank's Open Banking feed."
- **Recommendation: `next`.**

**B7b. Berlin Group NextGenPSD2 card accounts (Extended Services AIS for Single Cards v1.3.0,
2021-06-30) — `eu-nextgenpsd2-card-accounts`**

- **Fields.** `cardTransaction`:
  - identifiers: `cardTransactionId`, `terminalId`, `cardAcceptorId` (≤ 35);
  - times: `transactionDate`, `acceptorTransactionDateTime`, `bookingDate`, `valueDate`;
  - amounts: `transactionAmount`, `grandTotalAmount`, `currencyExchange`, `originalAmount`,
    `markupFee`, `markupFeePercentage`;
  - merchant: `cardAcceptorAddress`, `cardAcceptorPhone`, `merchantCategoryCode` (exactly 4
    characters);
  - other: `maskedPAN`, `transactionDetails`, `invoiced`, `proprietaryBankTransactionCode`.
- **Why it matters.** It is the richest merchant record among the standards: acceptor address,
  terminal and *acceptor-side* timestamp. Card-account endpoints are not offered by every bank
  **(unverified)**.
- **Dedup keys.** `cardTransactionId`, `terminalId` + `acceptorTransactionDateTime`.
- **Recommendation: `later`.**

**B7c. Australia Consumer Data Right banking v1.36.0 — `au-cdr-banking`**

- **Fields.** `BankingTransactionV2`:
  - `type` ∈ `DIRECT_DEBIT | FEE | INTEREST_CHARGED | INTEREST_PAID | OTHER | PAYMENT |
    TRANSFER_INCOMING | TRANSFER_OUTGOING`;
  - `merchantName` and `merchantCategoryCode` ("for an outgoing payment to a merchant");
  - BPAY `billerCode`, `billerName`, `crn` (a direct bill signal for C4);
  - `apcaNumber`, `reference`, `description`, `executionDateTime`, `postingDateTime`.
- **Pitfall.** The standard says: "there is currently no provision in the standards to guarantee
  the ability to correlate a pending transaction with an associated posted transaction." Fusion
  must use amount, time and merchant matching there.
- **Recommendation: `later`.**

**B7d. Open Finance Brasil credit cards API 2.3.0 — `br-open-finance-credit-cards`**

- **Version.** The repository also has **2.3.1**, a newer patch (checked 2026-10-04); `payeeMCC`
  is the same there. Pin 2.3.1 or later.
- **Fields.** Transactions carry `payeeMCC` as `type: number, format: integer` (example `5137`).
  The API also accepts a `creditCardPayeeMCC` filter parameter. Other fields include
  `transactionName` and `identificationNumber`.
- **Pitfall.** Leading zeros are lost on 0xxx codes.
- **Recommendation: `later`.** Pix QR carries no useful MCC (B11), so Brazilian category context
  comes from card data and merchant names.

#### B8. India Account Aggregator, merchant and context view — `india-account-aggregator`

- **What it is.** ReBIT FI schemas delivered through the consent-based AA network. Schema facts
  below come from the Sahamati-hosted copies. Their version label is `1.0` for credit card.
  Newer ReBIT revisions may add fields **(unverified)**.
- **Deposit `Transaction`.**
  - `txnId`, `type` (`CREDIT | DEBIT`), `mode` (`CASH | ATM | CARD | UPI | FT | OTHERS`), `amount`,
    `currentBalance`, `transactionTimestamp`, `valueDate`, `narration`, `reference`.
  - **Fact-check.** `transactionTimestamp` is typed `xs:dateTime`, and in XSD a timezone offset
    is *allowed but not required*. The sample instance has one (`2004-04-12T13:20:00-05:00`).
    Whether FIPs send a real time of day, or a default midnight, is **(unverified)**.
  - **No MCC, no merchant name field.** Merchant identity must be parsed from bank-specific
    `narration` text, whose UPI narration formats vary by bank **(unverified)**.
- **Credit-card `Transaction`.**
  - `txnId`, `txnType`, `txnDate` (date only), `amount`, `valueDate`, `narration`,
    `statementDate`, **`mcc` (required attribute)**, `maskedCardNumber`.
  - `Summary {currentDue, lastStatementDate, dueDate, previousDueAmount, totalDueAmount,
    minDueAmount, creditLimit, cashLimit, availableCredit, loyaltyPoints, financeCharges}`. This
    is a direct "upcoming known bill" source.
- **Consent purpose codes** (per Setu's AA docs, which cite the AA spec):
  - `101` Wealth management service;
  - **`102` "Customer spending patterns, budget or other reportings"**, the natural fit for
    BRAKE;
  - `103` Aggregated statement;
  - `104` Explicit consent to monitor the accounts;
  - `105` Explicit one-time consent.
  - `consentMode` ∈ `VIEW | STORE | QUERY | STREAM`; `fetchType` ∈ `ONETIME | PERIODIC`; periodic
    fetch frequency is capped at 1 per hour (24 per day).
- **Windows and latency.** POST-SPEND. Hourly at best, so it is not real-time.
- **Privacy.** Consent artefact scoped by purpose, FI type, `dataRange` and `dataLife`. BRAKE must
  not stretch purpose `102` to unrelated uses.
- **Reliability.**
  - The credit-card `mcc` attribute is schema-required, but whether FIPs actually populate it is
    **(unverified)**.
  - Card `txnDate` is date-only, so it is useless for time-of-day features.
- **Dedup keys.** `txnId`, `reference` (often carries the UPI RRN for UPI rows, **unverified**),
  `maskedCardNumber`.
- **BRAKE observation.**
  - `instrument.type` from `mode`.
  - `merchant.raw` from parsed `narration`.
  - `mcc` from card data.
  - `time_precision = "second"` for deposit `transactionTimestamp` only when the value has an
    offset and is not a default `00:00:00`; otherwise `"day"`. Card `txnDate` is always `"day"`.
- **Provenance sentence.** "From your HDFC account data shared via Account Aggregator (merchant
  name read from the transaction narration)."
- **Recommendation: `mvp`** (India). Context features must assume no MCC on deposit and UPI rows.

#### B9. Apple FinanceKit — `apple-financekit`

- **What it is.** On-device access to Apple Wallet financial data.
- **Data.** FinanceKit `Transaction`:
  - `id`, `accountID`;
  - dates: `transactionDate`, `postedDate?`;
  - amounts: `transactionAmount`, `foreignCurrencyAmount?`, `foreignCurrencyExchangeRate?`;
  - descriptions: `transactionDescription`, `originalTransactionDescription` ("the unmodified
    description");
  - `transactionType`, `status`, `creditDebitIndicator`;
  - merchant: **`merchantName?`** and **`merchantCategoryCode?`**, whose type
    `MerchantCategoryCode` is `RawRepresentable` with an **`Int16`** raw value.
  - The framework also exposes orders in Wallet and a `BackgroundDeliveryExtension`.
- **Coverage (Apple's FinanceKit page).**
  - **US**: iOS 17.4+; Apple Card (not Family participants), Apple Cash, Savings.
  - **UK**: iOS 18.4+; open-banking connections from institutions "including" Barclays, Barclaycard,
    First Direct, Halifax, HSBC, Lloyds, M&S Bank, MBNA, Monzo, Nationwide, NatWest, Royal Bank of
    Scotland and Santander. Apple presents these 13 as examples, not a closed list (as of
    2026-10-04).
  - **US exclusions.** Apple Card Family participants and children using Apple Cash Family are
    excluded.
- **Access.**
  - A managed entitlement. Apple says requests "may be submitted by an Account Holder and are
    granted per bundle ID". The page does not say whether an *organization* account is required
    **(unverified)**.
  - The app must be in the **Finance** category on the US or UK App Store and "provide financial
    management tools (such as … spending trends, budgeting)".
  - `NSFinancialDataUsageDescription` is required.
- **Windows and latency.** POST-SPEND. On-device, with background delivery possible (delivery
  latency **unverified**).
- **Privacy.** Best-in-class: data stays on-device and user authorization is per app.
- **Reliability.** The MCC `Int16` loses leading zeros. The merchant name may be Apple-cleaned;
  the raw descriptor stays available.
- **Dedup keys.** `id` (UUID), `accountID`.
- **Provenance sentence.** "From your Apple Card transaction in Wallet."
- **Recommendation: `next`.** It supplies iOS User B's merchant context. The entitlement process
  is the gating item.

#### B10. UPI QR and intent merchant fields — `upi-qr-scan`

- **What it is.** The `upi://pay?…` payload in a merchant QR or intent, which BRAKE reads when the
  user scans *with BRAKE* or shares a QR or link to BRAKE.
- **Fields.** The source is the NPCI UPI Linking Specification v1.6 (November 2017). The primary
  PDF (npci.org.in) and a labnol.org copy were both blocked. The table below comes from a
  *secondary* transcription on GitHub (`rahulsharmadev0/knowledge-ocean`, `linking.pdf.md`), so
  it is **(unverified against the primary)**.

  | Parameter | Meaning | Rule |
  |-----------|---------|------|
  | `pa` | Payee VPA | Mandatory |
  | `pn` | Payee name | Mandatory |
  | `mc` | Merchant category code | **Optional** |
  | `tid` | PSP-generated transaction id | Optional |
  | `tr` | Transaction reference | Mandatory for merchant and dynamic links |
  | `tn` | Note | Optional |
  | `am` | Amount | Mandatory in dynamic mode; if absent, the amount is editable |
  | `mam` | Minimum amount | Optional |
  | `cu` | Currency | INR only |
  | `url` | Transaction details link | Optional |
  | `mode` | Initiation mode | 01 QR, 02 secure QR, 04 intent, … |
  | `orgid` | Initiating PSP org id | Optional |
  | `sign` | Base64 signature, last tag | Listed as mandatory, but an unsigned intent only triggers a warning and a passcode prompt |
  | `mid` / `msid` / `mtid` | Merchant, store and terminal ids | Optional |

  - `purpose` is listed in some newer descriptions **(unverified)**.
  - NPCI's newer QR tables are not public.
  - P2P payloads conventionally carry `mc=0000` or omit it **(unverified)**.
  - Because `mc` is optional, BRAKE must treat a missing `mc` as "unknown", not as P2P.
- **Windows.** **PRE-SPEND and IN-SPEND** (before the user pays), with no latency. When `mc` is
  present, this is the only source in India that yields an MCC before money moves.
- **Coverage.** India; any phone with a camera.
- **Access.** No partnership is needed for reading a QR the user chose to scan.
- **Privacy.** Low. The user initiated the scan, and the data is about the merchant.
- **Reliability and failure modes.**
  - Static shop QRs often lack `am`. `pn` may be the owner's personal name for small merchants.
  - Aggregator-owned VPAs hide the store **(unverified pattern)**.
  - A QR scanned but paid in another app produces only an intent.
- **Dedup keys.** `tr` (merchant reference, which matches `merchant_reference` in the
  observation model), `pa` (merchant handle), and later the RRN from the bank alert.
- **BRAKE observation.**
  - `purchase_intent` with `merchant {raw: pn, handle: pa, mcc: mc, channel: "in_store" if the QR
    is static}`.
  - Confidence: about 0.9 for identity, about 0.6 for amount when `am` is absent (user-typed).
- **Provenance sentence.** "From the shop QR code you scanned: Sharma General Store (grocery,
  MCC 5411)."
- **Recommendation: `mvp`** (India).

#### B11. EMVCo merchant-presented QR (incl. Pix, SGQR-type schemes) — `emvco-merchant-qr`

- **What it is.** The EMV QR Code Specification for Payment Systems, Merchant-Presented Mode.
  Tag IDs below were checked against an open-source parser (`dongri/emv-qrcode`) because
  emvco.com was unreachable.
- **Fields.**

  | Tag | Meaning |
  |-----|---------|
  | 00 | Payload Format Indicator |
  | 01 | Point of Initiation Method: **`11` static, `12` dynamic**. *Optional* per the parser, so it may be absent |
  | 02–51 | Merchant Account Information (26–51 templates with a globally unique ID, e.g. `BR.GOV.BCB.PIX`) |
  | **52** | **Merchant Category Code (mandatory)** |
  | 53 | Transaction Currency (ISO 4217 numeric) |
  | 54 | Amount |
  | 55–57 | Tip or convenience fee |
  | 58 | Country |
  | **59** | **Merchant Name (mandatory)** |
  | **60** | **Merchant City (mandatory)** |
  | 61 | Postal Code (optional) |
  | 62 | Additional Data: 01 Bill Number, 02 Mobile, 03 Store Label, 04 Loyalty, 05 Reference Label, 06 Customer Label, **07 Terminal Label**, 08 Purpose, 09 Consumer Data Request |
  | 63 | CRC |
  | 64 | Merchant Info Language Template |
- **Pix caveat.** Open-source Pix BR Code generators set tag 52 to **`0000`**. That gives no
  category signal. The Banco Central manual was unreachable, so this is an **implementation
  convention (unverified against the BCB manual)**.
- **Windows.** PRE-SPEND and IN-SPEND.
- **Coverage.** Any EMV-QR-based national scheme. Country-by-country MCC population quality is
  **(unverified)**.
- **Privacy.** Low (merchant data, user-initiated).
- **Reliability.** Name and city fields are short (EMV limits) and often abbreviated.
- **Dedup keys.** Tag 62/05 Reference Label, 62/01 Bill Number, 62/07 Terminal Label, merchant
  account ID inside 26–51.
- **BRAKE observation.** Same as B10, plus `merchant.city`, `merchant.postal_code` and
  `merchant.store_label`, which give a physical location **without any location permission**.
  City is mandatory in EMV MPM, but postal code and store label are optional.
- **Provenance sentence.** "From the payment QR you scanned (merchant: KOPI KENANGA, Jakarta)."
- **Recommendation: `next`.** One TLV parser covers many markets. Ship it with the QR scanner
  after UPI.

#### B12. Google Places API (New) — `google-places-api`

- **What it is.** Google's place database, queried by text, by nearby coordinates or by
  `place_id`.
- **Fields** (`google.maps.places.v1.Place` proto):
  - identity and type: `id`, `display_name`, `types[]`, `primary_type`,
    `primary_type_display_name`;
  - address and location: `formatted_address`, `postal_address`, `location`;
  - status and price: `business_status`, `price_level` (`PRICE_LEVEL_FREE …
    PRICE_LEVEL_VERY_EXPENSIVE`), `price_range`;
  - hours and contact: `regular_opening_hours`, `website_uri`;
  - service flags: `delivery`, `dine_in`, `takeout`, `payment_options`;
  - plus many amenity flags.
- **Terms** (Google Maps Platform Service Specific Terms, *last modified June 10, 2026*; checked
  2026-10-04). These terms apply only to customers whose billing account is **outside the EEA**:
  - Places API content may be used "without a corresponding Google Map" (14.1), but **"must not
    \[be used] in conjunction with a non-Google map"** (14.2).
  - Latitude and longitude may be cached for **up to 30 consecutive calendar days** (14.3).
  - `place_id` may be cached (General Service Terms §3, "Google ID Caching").
- **EEA terms** (*fact-check addition*). Customers with an EEA billing address get the separate
  **EEA Service Specific Terms**, also last modified June 10, 2026. They are *stricter*:
  - §15.1 "No Use With any Map": other than latitude, longitude and `place_id`, Places content
    must not be used with *any* map;
  - §15.2: other uses are limited to the "Places API EEA Permitted Uses";
  - §15.4: the same 30-day latitude/longitude caching cap.
- **Pricing tiers:** **(unverified)**.
- **Windows.**
  - POST-SPEND enrichment of a merchant name.
  - PRE-SPEND only if BRAKE sends user coordinates. That fails CJT check 8.
- **Privacy.** High when queried with user location or with "merchant X in city Y" on a per-user
  basis. Google learns the purchase.
- **Recommendation: `avoid`** as a default enrichment path. Open data (B14, B15) covers store
  type without per-user calls or map-display restrictions. Reconsider only for a server-side,
  de-personalized merchant-catalogue build.

#### B13. Apple MapKit points of interest — `apple-mapkit-poi`

- **What it is.** `MKLocalSearch` and `MKPointOfInterestCategory` on Apple platforms.
- **Categories** are coarse:
  - `store` covers all retail;
  - food: `foodMarket`, `restaurant`, `cafe`, `bakery`, `brewery`, `winery`, `distillery`;
  - other: `pharmacy`, `gasStation`, `evCharger`, `hotel`, `nightlife`, `fitnessCenter`, `beauty`,
    `spa`, `airport`, `carRental`, `parking`, …
- **Windows.** POST-SPEND name lookups, or user-initiated in-spend lookups.
- **Privacy.** Queries go to Apple servers. Lower commercial-tracking risk than Google, but still
  third-party leakage.
- **Recommendation: `later`.** iOS-only and too coarse for retail store types. Possible use: a
  user-initiated "what is this place?" fallback.

#### B14. OpenStreetMap name-suggestion-index (brand dictionary) — `osm-name-suggestion-index`

- **What it is.** "Canonical features for OpenStreetMap" (brands, operators, flags) curated
  manually and via planet scans. Licence: **3-Clause BSD**.
- **Fields per item.** `displayName`, `id`, `locationSet {include, exclude}` (ISO country scoping),
  `matchNames[]`, and `tags` (`brand`, `brand:wikidata`, `name`, `official_name`, plus the OSM
  category tag such as `shop=supermarket`, `amenity=cafe` or `cuisine=coffee_shop`).
  - Examples: **Starbucks → `brand:wikidata=Q37158`, `amenity=cafe`**, global except a listed
    set of countries. **DMart → `Q5203271`, `shop=supermarket`, India only.**
  - Snapshot on 2026-10-04: the `amenity/cafe` file held 507 brands and `shop/supermarket` held
    1,049.
- **Windows.** All of them. It is a static dictionary used at resolution time, so latency is
  zero.
- **Coverage.** Global. Strongest for chains; weak for local merchants.
- **Privacy.** **Low.** Bundled and queried on-device, so nothing leaves the phone.
- **Reliability.** Community-curated. Brand-to-category mapping is reliable; matching bank
  descriptors still needs BRAKE's cleaning rules.
- **Dedup keys.** `brand:wikidata` gives a stable, open, cross-source merchant key, which is
  ideal for `merchant_normalized`.
- **Provenance sentence.** "Recognised 'STARBUCKS 0123 BLR' as Starbucks (coffee shop) using
  BRAKE's built-in merchant list."
- **Recommendation: `mvp`.** Bundle a country-filtered subset in BRAKE's merchant registry.

#### B15. Overture Maps Places — `overture-maps-places`

- **What it is.** An open POI dataset. **September 2026 release** feature counts by source:

  | Source | Licence | Places |
  |--------|---------|-------:|
  | Meta | CDLA-Permissive-2.0 | 58,783,121 |
  | BrightQuery | CDLA-Permissive-2.0 | 10,255,071 |
  | Microsoft | CDLA-Permissive-2.0 | 6,135,466 |
  | Foursquare | Apache-2.0 | 4,138,835 |
  | AllThePlaces | CC0-1.0 | 1,809,219 |
  | PinMeTo | CDLA-Permissive-2.0 | 167,667 |
  | DAC | CDLA-Permissive-2.0 | 148,791 |
  | Krick | CDLA-Permissive-2.0 | 13,501 |
  | RenderSEO | CDLA-Permissive-2.0 | 3,752 |

  - **Total.** The nine rows sum to **81,455,423 (about 81.5M)**. The guide's prose says "~81
    million"; the earlier "81.6M" figure was a rounding error, corrected 2026-10-04.
  - **Licence.** It "contains no OpenStreetMap data and carries none of the share-alike
    obligations of the ODbL".
  - **OSM caveat.** The guide also warns that *joining* CDLA data to OSM "may need to carry the
    ODbL if it is a derivative database".
- **Fields.**
  - `names`, `basic_category` (about 280 "cognitively basic" labels, e.g. `casual_eatery`);
  - `taxonomy {primary, hierarchy, alternates}` (Overture Place Categories, about 2,300
    categories). The same guide also says "the full 2.1k taxonomy" and "about 300" basic-level
    categories, so treat both counts as approximate.
  - `brand {names, wikidata}`;
  - `confidence` (0–1 existence confidence), `operating_status` (`open | temporarily_closed |
    permanently_closed`);
  - `addresses {freeform, locality, postcode, region, country}`;
  - `websites`, `phones`, `socials`, `emails`.
- **Taxonomy breaking change.** In the **September 2026 release `categories` was removed** in
  favour of `taxonomy` and `basic_category`. Top-level categories went from 22 to 13; 2,108
  categories were re-pathed.
- **Windows.** POST-SPEND store-type resolution. Also IN-SPEND when a QR or Plaid record carries a
  city.
- **Coverage.** Global, with uneven density.
- **Access.**
  - Bulk download from Amazon S3 (`s3://overturemaps-us-west-2/release/<date>/theme=places/type=place/*`)
    or Azure Blob, with releases discoverable through the STAC catalog. File format (GeoParquet) is
    **(not stated on the guide page)**.
  - Places is released **monthly**, and the taxonomy is revised **quarterly** (March, June,
    September, December). Both confirmed in the guide, 2026-10-04.
- **Privacy.** **Low** when BRAKE ships pre-cut regional extracts (by city or H3 tile) and
  matches merchant name + city on-device. Only the *tile id* request could leak a coarse region,
  and a bundled country pack avoids even that.
- **Reliability.** Good for chains and mid-size businesses; patchy for street vendors. Use
  `confidence` and `operating_status`.
- **Dedup keys.** Overture GERS ID per place and `brand.wikidata`.
  - The GERS ID "anchors its identity across releases", but stability depends on conflation.
  - The **July 2026 release re-matched the whole corpus and caused one-time elevated GERS ID
    churn**.
  - Use the bridge files and changelog to remap stored `ov:` keys, and do not treat GERS IDs as
    permanent.
- **Provenance sentence.** "Matched 'ANAND SWEETS, JAYANAGAR' to a sweet shop listed in open map
  data."
- **Recommendation: `next`.** It adds store type for non-chain merchants. Pin the release version
  because the taxonomy changes.

#### B15a. All the Places (brand store locations) — `alltheplaces` *(added by fact-check)*

- **What it is.** An open project that runs `scrapy` spiders against brands' own store-locator
  pages. It publishes a zip of per-spider GeoJSON `FeatureCollection`s on alltheplaces.xyz.
- **Cadence.** The README says it tries to run "a weekly run of all the spiders" (as of
  2026-10-04).
- **Licence.** Data is under the **CC-0** waiver; the spider code is MIT. Overture already ingests
  it (1,809,219 places in September 2026).
- **Fields.**
  - Guaranteed: `@spider` only.
  - When available: `ref`, `brand`, **`brand:wikidata`**, address fields, `phone`,
    `opening_hours` and OSM-style category tags.
  - The feature `id` is a hash of `ref` and `@spider` that "*should be* consistent between
    builds".
- **Why BRAKE cares.** It has fresher chain-store locations than Overture, keyed by the same
  Wikidata brand IDs as NSI. That makes it useful for store-level keys (B2 pitfall 5) and for
  matching QR merchant city to a branch.
- **Privacy.** Low when bundled.
- **Reliability.** Medium. It covers chains only, and a spider breaks when a site changes.
- **Recommendation: `research`.** Compare its coverage against Overture for India and other
  target markets before adding a separate pack.

#### B16. Online vs physical indicators (derived) — `channel-indicators`

Online vs physical is not one source. It is a derived merchant-context attribute fused from:

| Evidence | Source | Implies |
|----------|--------|---------|
| `payment_channel = online / in store` | Plaid (B2) | direct |
| `location` populated with lat/lon or address | Plaid (B2) | physical (absence ≠ online) |
| `CardInstrument.AuthorisationType = Contactless / PIN / ConsumerDevice` | UK OB (B7a) | card or wallet present |
| `terminalId`, `cardAcceptorAddress` | Berlin Group (B7b) | physical terminal likely |
| QR Point of Initiation `11` (static) | EMV QR (B11) | physical counter |
| Static UPI QR scanned in BRAKE | B10 | physical |
| Order or receipt email, browser checkout | other streams | online |
| MCC 5964–5969 (direct marketing), 5815–5818 (digital goods) | B1 | online / remote |

- **BRAKE output.** `merchant.channel ∈ {online, in_store, unknown}` plus `p_online`.
- **Use.** Channel matters for interventions: online purchases allow a pause, and in-store
  purchases need in-spend speed.
- **Recommendation: `mvp`.**

#### B17. On-device recurring merchant and subscription detection — `recurring-detection-on-device`

- **What it is.** BRAKE's own detector, needed because only Plaid (B3) and Ntropy (B5) provide
  streams, and India, SMS and email users have neither.
- **Algorithm (proposed).**
  1. **Group.** Group outflows by `merchant_key` (B19) and amount band (± 10 % or ± 2 currency
     units, whichever is larger). Keep a separate *variable-amount* group for utilities.
  2. **Cadence.** Compute inter-arrival gaps and the median gap *g*. Assign a cadence:

     | Median gap *g* (days) | Cadence |
     |-----------------------|---------|
     | 6–8 | weekly |
     | 13–15 | biweekly |
     | 14–17 with two fixed days of the month | semi-monthly |
     | 27–33 | monthly |
     | 85–95 | quarterly |
     | 355–375 | annual |
  3. **Regularity.** Require `MAD(gaps)/g < 0.15`.
  4. **Status.** Use Plaid's public semantics as BRAKE's vocabulary:

     | Status | Rule |
     |--------|------|
     | `early` | 2 hits (1 hit for annual with a subscription prior) |
     | `mature` | ≥ 3 hits (annual ≥ 2) |
     | `tombstoned` | missed an expected date by > 0.5·g |
  5. **Subscription prior.** Boost subscription probability with MCC 5968, 4899 or 5815–5818, the
     brand dictionary flag `subscription_brand`, app-store billing intermediaries, and subscription
     emails.
  6. **Fixed vs varying.** Distinguish fixed-amount *subscription* from varying-amount *recurring
     bill* (Ntropy's split).
  7. **Price change.** `last_amount / median(previous 3) − 1 ≥ 5 %`.
- **Windows.** PRE-SPEND (renewal tomorrow) and POST-SPEND (new subscription detected).
- **Privacy.** Low incremental: derived and on-device.
- **Provenance sentence.** "You've paid Spotify ₹119 on about the 5th of each month for 7 months."
- **Recommendation: `mvp`.** The detector is mandatory infrastructure for C2, C4 and subscription
  features.

#### B18. Per-user merchant history — `per-user-merchant-history`

- **What it is.** An on-device aggregate per `merchant_key`:
  - `first_seen`, `last_seen`;
  - `visits_30d` and `visits_90d`;
  - median and MAD ticket;
  - category distribution of user labels;
  - regret and worth-it counts;
  - share of spend in a late-night bucket;
  - typical channel.
- **Windows.** All three. PRE-SPEND: "You've bought from this store 6 times this month." IN-SPEND:
  the ticket is 3× your usual. POST-SPEND: question suppression when user labels are consistent.
- **Privacy.** Medium. It is a behavioural profile, so keep only aggregates (rolling 13 months)
  and never upload.
- **Provenance sentence.** "Based on your last 9 purchases at Zepto that BRAKE has seen."
- **Recommendation: `mvp`.**

#### B19. BRAKE merchant resolver (mechanism) — `brake-merchant-resolver`

The on-device pipeline that turns any `merchant.raw` into a stable key. Specified in
[Implications](#merchant-resolution-pipeline-on-device).

- **Recommendation: `mvp`.**

### C. Contextual signals derived from consented data or user input

#### C1. Device clock: time of day, day of week, holidays — `device-clock-context`

- **What it is.** Local time and calendar facts at the moment of *purchase* (from the transaction
  timestamp) and of *intervention* (from the device clock).
- **Fields.**
  - `local_hour`, `hour_bucket`, `dow`, `is_weekend` (the weekend definition is locale-dependent
    and lives in the registry);
  - `is_public_holiday`, from a bundled per-country table, with no network call;
  - `time_precision` of the source timestamp.
- **Windows.** All three. Latency zero.
- **Permissions.** None.
- **Reliability.** Purchase-time features are only as good as the source timestamp:
  - Plaid `authorized_datetime` may be a default `00:00:00`;
  - AA credit-card `txnDate` is date-only;
  - notification and SMS arrival time is minute-precise but is *alert* time.

  Rule: compute hour features only when `time_precision ∈ {second, minute}`. Otherwise abstain.
- **CJT.** Pass: derived, low precision, no new permission.
- **Ethics.** Using "late night" as a *personal* pattern ("you often regret late-night orders") is
  fine. Using it as a moral judgment ("don't shop at night") is not.
- **Provenance sentence.** "You made this purchase at 1:12 am; you've marked 4 of your last 5
  late-night orders as regretted."
- **Recommendation: `mvp`.**

#### C2. Payday and income-cycle detection — `payday-detection`

- **What it is.** Detect recurring income from inflows:
  - Plaid `inflow_streams` with income PFC (e.g. `INCOME_WAGES` in v1; the v2 label names are
    **unverified**), counterparty `type = income_source`;
  - AA deposit credits with salary-like narration tokens (bank-specific);
  - SMS or notification credit alerts;
  - UK OB `CategoryPurposeCode` and `PaymentPurposeCode`, which may carry an ISO 20022 salary
    purpose code (code value **unverified**).
- **Fields.** `days_since_income`, `days_to_next_income`, `income_cadence`, `income_confidence`
  (from gap regularity and amount stability). Amount is used internally for `free_to_spend` but
  is never shown or uploaded.
- **Windows.** PRE-SPEND and IN-SPEND ("2 days after payday, your first-week spending is
  usually highest"), plus POST-SPEND pacing.
- **Evidence.** Spending responds to paycheck arrival even among liquid households. Studies:
  Gelman et al., *Science* 2014; Olafsson & Pagel, *Review of Financial Studies* 2018. **(Cited
  from background knowledge; not re-verified this session.)**
- **CJT.**
  - Pass on derivability (no new collection), decision link (pacing) and expectation (users
    expect a budgeting app to know payday).
  - Sensitive-inference: income level is sensitive, so keep it on-device.
- **Ethics.** Payday targeting is a known exploitative marketing pattern. BRAKE must use payday
  only *protectively* and never for promotions or partner offers.
- **Provenance sentence.** "Your salary from ACME usually arrives on the last working day; it's
  been 2 days."
- **Recommendation: `mvp`.** Activate only when `income_confidence ≥ 0.7` after ≥ 2 cycles.

#### C3. Budget cycle, savings goals, user-defined rules — `user-goals-and-rules`

- **What it is.** Manual inputs:
  - **Cycle anchor:** a user-chosen day, or the detected payday.
  - **Goals:** name, target, date, monthly contribution.
  - **Rules:** a small DSL, e.g. `when category=food_delivery and local_hour>=22 then
    nudge(level=1)`, or `cap(category=shopping, period=cycle, amount=8000)`.
  - **Protected categories:** "never nudge me on groceries, medicine".
- **Goal progress** can be *derived* from detected own-account transfers to a savings account
  (reconciliation layer) instead of asking.
- **Windows.** All three.
- **Privacy.** Medium (goals are personal). On-device.
- **CJT.** Pass trivially: user-authored and expected.
- **Provenance sentence.** "Because you set the rule 'no food delivery after 10 pm on weeknights'."
- **Recommendation: `mvp`.** This is User C's core context.

#### C4. Upcoming known bills and recurring obligations — `upcoming-obligations`

- **What it is.** A forward calendar of expected outflows. It merges:
  - recurring series (B3, B17);
  - AA credit-card `Summary.dueDate`, `totalDueAmount` and `minDueAmount`;
  - Australia CDR `DIRECT_DEBIT` and BPAY `billerCode` series;
  - renewal and trial-ending emails (other stream);
  - mandate observations such as UPI AutoPay and direct debit, including bank pre-debit
    notifications. The RBI e-mandate pre-debit notice is ≥ 24 h before debit **(unverified)**.
- **Fields.** `obligation {series_key, expected_date, expected_amount, amount_uncertainty,
  essential_prior, source_ids}` and `committed_outflows_until_next_income`.
- **Windows.**
  - PRE-SPEND: "₹14,200 is already committed before payday".
  - POST-SPEND: a renewal was charged.
- **CJT.** Pass (derived).
- **Provenance sentence.** "Your HDFC credit-card bill (₹18,400 due 15 Oct) from Account
  Aggregator, plus 3 subscriptions BRAKE detected."
- **Recommendation: `next`.** It needs about 3 cycles of history to be credible.
  `free_to_spend` must abstain when balance freshness is over 24 h.

#### C5. Spending velocity — `spending-velocity`

- **What it is.** Rate-of-spend features by category, merchant and channel: rolling 24 h, 7 d and
  cycle-to-date, a robust z-score against the user's own baseline, and burst detection (several
  discretionary purchases in a short window).
- **Windows.** IN-SPEND (burst) and POST-SPEND (the brief's "Food spending this week is now 38 %
  above your usual pace").
- **CJT.** Pass (derived).
- **Pitfall.** Velocity must exclude transfers, card-bill payments, refunds and likely duplicates.
  It reads `transaction_type` and candidate status from the reconciliation layer and must never
  double count enrichment-only candidates (see `fusion-and-reconciliation.md`).
- **Provenance sentence.** "Compared with your usual week of eating out (median of the last 8
  weeks)."
- **Recommendation: `mvp`.**

#### C6. Prior regret patterns — `regret-feedback-history`

- **What it is.** Sparse retrospective feedback (the brief's 24–72 h "still happy?" prompt),
  aggregated as Beta posteriors per segment: category × hour bucket × channel × amount band,
  plus per merchant.
- **Windows.**
  - PRE-SPEND and IN-SPEND: scale friction by the user's own regret rate in that segment.
  - POST-SPEND: choose whom to ask.
- **CJT.** Pass on expectation (user-provided) and derivability.
- **Ethics.** Cap prompts at ≤ 2 per week. Never ask about deny-listed categories by default.
  Decay old feedback. Show the user what BRAKE has learned and let them reset it.
- **Provenance sentence.** "You've said you regretted 3 of 4 electronics purchases under ₹2,000."
- **Recommendation: `next`.** Collect from MVP; personalize once each segment has ≥ 5 ratings.

#### C7. Travel context derived from financial data and time zone — `travel-context-derived` and `timezone-change-signal`

- **What it is.** Infer "user is travelling or about to travel" with no GPS and no calendar:
  1. **Foreign transactions.** `currency ≠ home`, or Plaid `location.country ≠ home`, or
     FinanceKit `foreignCurrencyAmount` present, or Berlin Group `currencyExchange` /
     `originalAmount` present.
  2. **Travel-booking MCCs.** 3000–3299 airlines, 4511, 3501–3999 and 7011 lodging, 4722 travel
     agencies. Bookings usually precede trips by weeks, which makes them a PRE-SPEND
     "trip coming" signal.
  3. **OS time-zone change.**
     - Android's `ACTION_TIMEZONE_CHANGED` is an implicit-broadcast *exception*: manifest
       receivers still get it, and it needs no permission.
     - iOS exposes `NSNotification.Name.NSSystemTimeZoneDidChange`, "a notification posted when
       the time zone changes" (Apple Foundation docs, checked 2026-10-04). It is delivered
       through `NotificationCenter` to a *running* app. Unlike Android's manifest receiver,
       nothing indicates it wakes a suspended app **(background behaviour unverified)**, so iOS
       should compare the time zone on each app launch or resume.
- **Fields.** `is_foreign_txn`, `travel_mode {active, since, home_tz_offset, current_tz_offset,
  evidence[]}`.
- **Uses.**
  - Switch anomaly logic: foreign merchants are expected.
  - Offer a trip budget.
  - Suppress "unusual" alerts.
  - Treat FX fees as a separate component.
- **CJT.** Pass. It is derived and coarse (country or offset only), and the time-zone offset
  reveals no more than the purchases do.
- **Provenance sentence.** "You've had 3 card payments in EUR since Monday, so BRAKE switched to
  travel mode."
- **Recommendation: `next`.**

#### C8. Travel plans from email bookings — `email-booking-extraction`

- **What it is.** Structured reservations extracted from confirmation emails (the email stream
  owns ingestion). schema.org defines:
  - `Reservation` with properties `bookingAgent`, `bookingTime`, `modifiedTime`,
    `programMembershipUsed`, `reservationFor`, `reservationId`, `reservationStatus`,
    `reservedTicket`, `totalPrice`, `underName`;
  - subtypes `FlightReservation`, `LodgingReservation`, `RentalCarReservation`,
    `TrainReservation`, `FoodEstablishmentReservation`;
  - `Order` with `orderNumber`, `orderStatus`, `orderedItem`.
  - `reservationNumber` is **not** a property in the schema.org core file (confirmed
    2026-10-04). Whether Gmail's markup still uses it is **(unverified)**.
  - `bookingAgent` is marked `supersededBy :broker` in schema.org.
- **Windows.** PRE-SPEND (trip dates, restaurant booking tonight) and POST-SPEND (explains a
  hotel charge).
- **Privacy.** High. It needs mailbox access; Gmail scope policy is in the email stream.
- **CJT.** Conditional. Only if the user already connected email for receipts. Never request
  email access *for* travel context.
- **Dedup keys.** `reservationId` / booking reference, matching `booking_ref` in the observation
  model.
- **Provenance sentence.** "From your IndiGo booking confirmation email (BLR → DEL, 14 Oct)."
- **Recommendation: `later`.** It depends on the email adapter. C7 gives most of the value first.

### D. Sensor-based context: location, calendar, ambient

#### D1. Background location and geofencing — `background-location-geofencing`

- **What it is.** OS-managed region-entry and exit events, or passive visit logs:
  - Android Geofencing API;
  - iOS Core Location condition monitoring (`CLMonitor`, `CLCircularGeographicCondition`);
  - iOS `CLVisit`.
- **Platform facts.**
  - **Android geofencing**
    - Limit: **100 geofences per app per device user**.
    - Permissions: `ACCESS_FINE_LOCATION` plus **`ACCESS_BACKGROUND_LOCATION`** for apps
      targeting Android 10+.
    - Latency: "usually … less than 2 minutes"; about 2–3 min under background limits; "up to 6
      minutes" when stationary.
    - Recommended radius: ≥ 100–150 m.
  - **Android 11+**: there is no "Allow all the time" option in the dialog. Users must enable
    background location on a settings page, and Android's own guidance says "verify that access
    is necessary. Consider getting the information that the feature needs in other ways."
    Google Play requires a background-location declaration **(policy page unreachable;
    unverified details)**.
  - **iOS**: "Core Location prevents any single app from monitoring more than 20 conditions of
    any type simultaneously."
  - **iOS `CLVisit`** gives `coordinate`, `horizontalAccuracy`, `arrivalDate` and
    `departureDate`. That is effectively a place-history log.
  - **Apple App Review 5.1.5**: "Use Location Services in your app only when it is directly
    relevant to the features and services provided by the app."
- **Intended use.** A PRE-SPEND nudge on entering a mall, a liquor store or a favourite
  restaurant.
- **CJT assessment.**

  | Check | Result |
  |-------|--------|
  | 1 Decision link | Plausible (pre-spend nudge) |
  | 2 Derivability | *Partly fails.* Where the user shops is already derivable post-hoc (Plaid `location`, QR city, acceptor address). App-open and shielding signals (other stream) are better pre-spend proxies for online shopping, which is a large share of discretionary spend. |
  | 3 Lift | Unproven. Presence ≠ intent, so expect a high false-positive rate. |
  | 4 Expectation | *Fails for always-on tracking.* Users do not expect a budgeting app to know when they enter a shop. |
  | 5 Least precision | Hard: geofences need ≥ 100 m precision. |
  | 6 Sensitive inference | *Fails* without heavy suppression: clinics, places of worship, bars, home and work. |
  | 7 Reversibility | OK |
  | 8 Third-party leakage | OK if on-device |
- **Recommendation: `avoid`** for MVP and the default product.
  - Keep a **research** item for an explicit "trouble spots" mode. The user names ≤ 5 places by
    searching, not from tracking history; geofences are on-device only; nothing is logged except
    "entered user-defined zone N"; it auto-expires after 30 days unless renewed.
  - **Never** use `CLVisit` or passive visit history.

#### D2. User-initiated, session-scoped location — `user-initiated-location`

- **What it is.** One-shot location attached to a user action such as "Should I buy this?" or
  "Where am I spending?":
  - **Android 17 (API 37) location button.** A system UI element granting *session-scoped precise
    location* (`USE_LOCATION_BUTTON`). "If your app targets Android 17 … and only contains
    features that require session-based location access to function, Google Play policy requires
    you to use the location button."
    - Status: "an experimental Jetpack library and is subject to change", with "a fallback for
      apps targeting Android 16 and lower" (checked 2026-10-04).
    - The Play policy page it links (support.google.com answer 16909972) was blocked, so its
      enforcement dates are **(unverified)**.
  - **Android approximate location** (`ACCESS_COARSE_LOCATION`) is about 3 km². Since Android
    12, users can grant approximate only.
  - **iOS** `CLAccuracyAuthorization.reducedAccuracy` and `NSLocationDefaultAccuracyReduced`
    (city or neighbourhood level).
- **Windows.** PRE-SPEND and IN-SPEND, user-initiated.
- **CJT.** Passes checks 4 and 7 (expected, user-initiated). Lift is still questionable, because
  asking "where are you?" or reading the QR's merchant city often gives the same information.
- **Recommendation: `later`.** Offer it only if user research shows people want "spending
  near me" answers. Default to approximate accuracy.

#### D3. Calendar read access — `calendar-read-access`

- **What it is.** Reading events to anticipate spending such as dinners, birthdays, trips or
  weddings:
  - iOS EventKit full access (`NSCalendarsFullAccessUsageDescription`);
  - Android `READ_CALENDAR`;
  - Google Calendar API, e.g. `calendar.events.readonly` "View events on all your calendars";
  - Microsoft Graph `Calendars.Read`, or `Calendars.ReadBasic`, which excludes "body,
    attachments, and extensions".
- **CJT assessment.**
  - Check 2 fails: travel comes from C7 and C8, and bills from C4.
  - Check 4 fails: calendars are a *social and professional* context. Users don't expect a
    spending app to read them.
  - Check 6 fails: medical appointments, religious events, other people's names.
  - Check 3 is unproven.
- **Recommendation: `avoid`.** The user can type "I have a wedding on Saturday" into a goal or
  event themselves (C3).

#### D4. Calendar write-only reminders — `calendar-write-only-reminders`

- **What it is.** BRAKE *adds* renewal, trial-end and bill reminders to the user's calendar
  without reading it:
  - **iOS 17+ write-only access** (`requestWriteOnlyAccessToEvents`,
    `NSCalendarsWriteOnlyAccessUsageDescription`). Apple: "Don't request full access if your
    app's features only need write-only access." **EventKitUI** "without requesting write-only or
    full calendar access".
  - **Android** `ACTION_INSERT` intent: "your application doesn't even need to have the
    `WRITE_CALENDAR` permission".
  - **Google Calendar** `calendar.app.created`: "Make secondary Google calendars, and see, create,
    change, and delete events on them". It is limited to an app-owned calendar.
- **Windows.** PRE-SPEND (a reminder before renewal).
- **CJT.** Pass. No data flows in.
- **Recommendation: `next`** (pairs with subscription features).

#### D5. Other ambient signals (rejected) — `ambient-sensors`

- **Signals.** Weather, activity recognition, health or sleep data (as a "tiredness" proxy),
  Wi-Fi SSIDs and BLE beacons, contacts and social graph, installed-app inventory.
- **Why they are rejected.**
  - Every one fails derivability: time-of-day plus the user's own regret history is a better
    proxy for "tired".
  - They fail expectation and sensitive inference.
  - Apple 5.1.2(iii) forbids "surreptitiously build\[ing] a user profile". Apple 5.1.2(iv)
    forbids collecting installed-app data for analytics or advertising.
- **Recommendation: `avoid`.**

### E. Derive instead of sense

| Context need | Derivable from already-consented data | Sensor alternative | Verdict |
|--------------|----------------------------------------|--------------------|---------|
| Where the purchase happened | Plaid `location`; EMV QR tags 60/61; Berlin Group `cardAcceptorAddress`; Ntropy `location.structured`; Overture match on name + city | GPS at purchase time | Derive |
| Online vs in store | `payment_channel`; OB `AuthorisationType`; QR static/dynamic; MCC 5964–5969; email or browser receipts | Geofence | Derive |
| Store type | MCC; NSI brand tags; Overture `basic_category`/`taxonomy`; Plaid PFC | Places API with user location | Derive (on-device dictionary) |
| Travelling now | Foreign currency or country; time-zone broadcast | Background location | Derive |
| Trip coming | Airline and lodging MCCs; booking emails (if connected) | Calendar read | Derive |
| Payday proximity | Inflow streams; credit alerts | Employer integration | Derive |
| Upcoming bills | Recurring series; AA card `dueDate`; CDR BPAY; mandates; renewal emails | Calendar read | Derive |
| About to shop *online* | App-open, shielding, share sheet, browser extension (other streams) | — | Other streams |
| About to shop *in person* | QR scan (India and QR markets); "Should I buy this?" | Geofence | User-initiated first; geofence = research only |
| Mood or fatigue | Time of day + personal regret history | Health, sleep, activity | Do not collect |
| Social plans | User-entered events | Calendar read | Ask, don't read |

---

## Three-window classification

| Source | Pre-spend | In-spend | Post-spend | Latency | Notes |
|--------|-----------|----------|------------|---------|-------|
| `iso-18245-mcc` | via QR only | via QR only | yes | rides on carrier | Merchant-level prior; deny-list sensitive codes |
| `plaid-transactions` (merchant fields) | – | – | yes | minutes–days (pending → posted) | `merchant_entity_id`, counterparties, PFC v1/v2, MCC beta, `payment_channel`, `location` |
| `plaid-recurring-transactions` | yes (`predicted_next_date`) | – | yes | batch, webhook | `MATURE` needs ≥ 3 hits |
| `plaid-enrich` | – | possible | yes | API round-trip | US/CA-oriented; third-party transfer of non-Plaid data |
| `ntropy-enrichment` | – | – | yes | API round-trip | Intermediaries + recurrence model worth copying |
| `card-network-merchant-apis` | – | – | yes | API | Partnership only (unverified) |
| `uk-open-banking-ais` | – | – | yes | bank-dependent | `MerchantDetails`, `AuthorisationType` |
| `eu-nextgenpsd2-card-accounts` | – | – | yes | bank-dependent | Acceptor address, terminal, 4-char MCC |
| `au-cdr-banking` | yes (BPAY/direct-debit series) | – | yes | bank-dependent | No pending → posted correlation |
| `br-open-finance-credit-cards` | – | – | yes | bank-dependent | `payeeMCC` integer |
| `india-account-aggregator` | yes (card `dueDate`) | – | yes | ≥ 1 h (fetch cap 24/day) | Deposit rows: no MCC; card rows: `mcc` |
| `apple-financekit` | – | – | yes | on-device; background delivery | `merchantCategoryCode` Int16; US + UK |
| `upi-qr-scan` | **yes** | **yes** | join key | 0 s | Only pre-payment MCC source in India (when `mc` present; optional) |
| `emvco-merchant-qr` | **yes** | **yes** | join key | 0 s | Name, city, MCC; Pix MCC `0000` |
| `google-places-api` | (fails CJT) | (fails CJT) | yes | API | Terms: no non-Google map; lat/lng ≤ 30 d |
| `apple-mapkit-poi` | user-initiated | user-initiated | yes | API | Coarse categories |
| `osm-name-suggestion-index` | yes | yes | yes | 0 s (bundled) | BSD-3; Wikidata QIDs |
| `overture-maps-places` | yes (QR city) | yes | yes | 0 s (bundled tiles) | Sept 2026 taxonomy change; July 2026 GERS churn |
| `alltheplaces` | yes (QR city) | yes | yes | 0 s (bundled) | CC-0 chain store locations; `brand:wikidata` |
| `channel-indicators` | partial | yes | yes | derived | Fused attribute |
| `recurring-detection-on-device` | yes | – | yes | derived | Mandatory for non-Plaid users |
| `per-user-merchant-history` | yes | yes | yes | derived | Aggregates only |
| `brake-merchant-resolver` | yes | yes | yes | < 10 ms target | Mechanism |
| `device-clock-context` | yes | yes | yes | 0 s | Needs `time_precision` |
| `payday-detection` | yes | yes | yes | derived (≥ 2 cycles) | Protective use only |
| `user-goals-and-rules` | yes | yes | yes | 0 s | User C's core |
| `upcoming-obligations` | yes | yes | yes | derived | `committed_outflows_until_next_income` |
| `spending-velocity` | – | yes | yes | derived | Excludes transfers and duplicates |
| `regret-feedback-history` | yes | yes | yes (asks) | 24–72 h prompts | ≤ 2 prompts per week |
| `travel-context-derived` / `timezone-change-signal` | yes | yes | yes | 0 s – hours | No GPS needed |
| `email-booking-extraction` | yes | – | yes | email latency | Only if email already connected |
| `background-location-geofencing` | (yes) | – | – | 2–6 min | **avoid**; research "trouble spots" |
| `user-initiated-location` | yes | yes | – | seconds | Android 17 location button |
| `calendar-read-access` | (yes) | – | – | sync | **avoid** |
| `calendar-write-only-reminders` | yes (output) | – | – | n/a | Write-only / no permission |
| `ambient-sensors` | – | – | – | – | **avoid** |

---

## Implications for BRAKE architecture

### Merchant resolution pipeline (on-device)

```
merchant.raw (+ mcc, handle, city, website, provider ids)
  1. clean      → uppercase, strip card/terminal noise (store numbers, "#1700", dates, phone numbers,
                  city/state suffixes, payment-network prefixes), keep the original
  2. split      → detect intermediary prefixes/handles (marketplace, payment terminal, app-store billing,
                  wallet, payment gateway, delivery platform) → {intermediary, remainder}
                  (provider counterparties[] with type marketplace/payment_terminal/payment_app win)
  3. exact      → handle/VPA/provider-id alias table  (plaid:<merchant_entity_id>, upi:<pa>, ...)
  4. dictionary → NSI matchNames/brand within locationSet(country) → brand:wikidata QID
  5. local POI  → (name, city) fuzzy match against bundled Overture tile for that city
  6. priors     → MCC class, PFC, keywords
  7. history    → user's previous labels for this key/raw string
  8. (optional, consented) server enrichment (Plaid Enrich / Ntropy) for unresolved raws only
  → MerchantResolution {
       key: "wd:Q37158" | "ov:<gers-id>" | "h:<sha256(country|cleaned_raw)>",
       display_name, intermediary_key?, store_type {scheme, value, confidence},
       channel, p_online, mcc_normalized?, mcc_class?, sensitive: boolean,
       confidence, steps_applied[]   // drives the provenance sentence
     }
```

- **Key namespace.** Use Wikidata QIDs for brands. They are open, stable, and join across NSI,
  Overture `brand.wikidata` and the user's other sources. Vendor IDs become aliases only.
  Unresolved merchants get a salted hash key, so the key itself reveals nothing if exported.
- **Lookup tables.** Ship versioned, country-filtered packs: NSI brands, Overture tiles for the
  user's home city only, intermediary patterns and the MCC table. Update them like app content,
  with no per-user query.
- **Intermediary model.** Extend `MerchantObservation` with `intermediary?: {name, key, type:
  "marketplace" | "payment_terminal" | "payment_app" | "app_store" | "gateway" | "wallet"}`.
  Fusion should compare the *underlying* merchant when both sides have it. Otherwise it should
  compare the intermediary, so "DoorDash" on a card alert can still match a "Burger King via
  DoorDash" email.

### Normalization pitfalls

**MCC formats (normalize to a 4-char zero-padded string; `null` for placeholders):**

| Source | Field | Type as published | Pitfall |
|--------|-------|-------------------|---------|
| Plaid | `merchant_category_code` | string, nullable, **beta** | Mostly card transactions; "values subject to change" |
| Plaid Enrich (input) | `mcc` | string | Optional input |
| Apple FinanceKit | `merchantCategoryCode` | `MerchantCategoryCode` (`Int16` raw value) | Leading zeros lost (0742 → 742) |
| UK OB v4.0.1 | `MerchantDetails.MerchantCategoryCode` | string, **3–4** chars | Left-pad 3-char values |
| Berlin Group cards v1.3.0 | `merchantCategoryCode` | string, exactly 4 | Card-account endpoints only |
| AU CDR v1.36.0 | `merchantCategoryCode` | string | Outgoing merchant payments only |
| Open Finance Brasil cards 2.3.0 / 2.3.1 | `payeeMCC` | **integer** (`type: number, format: integer`) | Leading zeros lost |
| India AA credit card | `mcc` | `xs:string`, required | Sample instance shows `mcc=""`, so treat empty as null |
| India AA deposit | — | absent | Use `mode` + narration |
| EMV MPM | tag 52 | 4 digits, mandatory | Pix commonly `0000` |
| UPI QR/intent | `mc` | 4 digits (unverified), **optional** | Often absent; P2P `0000` (unverified) |
| Ntropy | `counterparty.mccs` | `List[int]` | Several MCCs per entity, so keep them as a set |

**Other pitfalls:**

1. **Category scheme versions.** Keep `scheme` versioned: `plaid_pfc_v1`, `plaid_pfc_v2`,
   `overture_opc@2026-09`, `osm_tag`, `mcc`. Plaid customers enabled on or after 2025-12-03 only
   get PFC v2. Overture removed `categories` in September 2026. The intelligence layer maps
   schemes to BRAKE's taxonomy, matching the existing `CategoryHint` contract.
2. **Location semantics.** A missing Plaid `location` does **not** mean online. Plaid populates
   it mostly for large chains. Only `payment_channel` and positive evidence decide channel.
3. **Time precision.** Add `time_precision ∈ {second, minute, hour, day}` and `time_basis ∈
   {authorization, alert_received, posted, value_date}` to every observation. Context features
   read them and abstain. Plaid's `authorized_datetime` may be a default `00:00:00`. The AA
   card `txnDate` and many ledgers are date-only.
4. **Time zones.** Compute purchase-local time from the source offset. AA `transactionTimestamp`
   *may* include one: `xs:dateTime` allows an offset but does not require it. If there is none,
   use the device time zone *at alert time*, not at sync time. A user who syncs after a flight
   must not get "3 am purchases".
5. **Merchant entity granularity.** Plaid `merchant_entity_id` is brand-level, not store-level.
   Store-level history ("this branch") needs `location.store_number`, the QR terminal label or
   the acceptor ID.
6. **Counterparty person vs merchant.** UPI P2M vs P2P: use `mc`, verified-merchant hints and the
   handle pattern. Plaid counterparty types and Ntropy `person | organization` help elsewhere.
   Never store personal P2P payee names in merchant tables. Hash them.
7. **Logos.** Logo URLs from providers leak IP and merchant to the provider's CDN when rendered.
   Proxy and cache them, or bundle them for top brands.

### On-device context feature catalogue

Every feature record carries `{value, confidence, support_n, time_precision, sources[],
computed_at}`. Features with `support_n` below their minimum are `null`. They are never 0.

| Feature id | Definition | Inputs | Min support | Window use |
|------------|------------|--------|-------------|------------|
| `ctx.local_hour` / `ctx.hour_bucket` | Purchase-local hour; buckets: night 00–05, morning 05–11, midday 11–15, afternoon 15–18, evening 18–22, late 22–24 | Timestamp + offset | precision ≤ minute | all |
| `ctx.is_late_night` | `local_hour ∈ [23, 5)`, user-adjustable | above | same | pre / in |
| `ctx.dow`, `ctx.is_weekend`, `ctx.is_public_holiday` | Locale weekend set; bundled holiday table | Device clock, registry | — | all |
| `ctx.days_since_income`, `ctx.days_to_next_income` | From the most recent income event and its cadence: `next = last + cadence`, shifted to the previous business day if the series shows that pattern | Income series | 2 cycles; `income_confidence ≥ 0.7` | pre / in / post |
| `ctx.cycle_day`, `ctx.cycle_progress` | Days since cycle anchor; `progress = elapsed / cycle_length` | User anchor or payday | — | all |
| `ctx.discretionary_ctd` | Σ discretionary outflows this cycle, excluding transfers, card payments, refunds, obligations and likely duplicates | Candidates + reconciliation | — | post |
| `ctx.pace_ratio` | `discretionary_ctd / median_k(cumulative discretionary at same cycle_progress)`, k = last 3 cycles | above | ≥ 2 prior cycles | pre / post |
| `ctx.velocity_7d[cat]`, `ctx.velocity_z[cat]` | Rolling 7-day sum; robust z = `(x − median_8w) / (1.4826·MAD_8w)` | Candidates | 6 weeks | in / post |
| `ctx.burst_2h` | Count of discretionary purchases in trailing 2 h; flag ≥ 3 | Candidates | — | in |
| `ctx.committed_until_income` | Σ `p_i · amount_i` over predicted obligations dated ≤ next income | Obligations (C4) | 1 mature series | pre |
| `ctx.free_to_spend` | `balance − committed_until_income − goal_reserved`; null if balance is older than 24 h | Balance snapshot, C3, C4 | balance freshness | pre / in |
| `ctx.goal_impact` | `amount / remaining_goal_capacity_this_cycle` | C3 | goal set | pre / in |
| `m.visits_30d`, `m.visits_90d`, `m.first_seen`, `m.days_since_last` | Per merchant key | History (B18) | — | all |
| `m.ticket_z` | `(amount − median_ticket) / (1.4826·MAD)` at merchant | History | ≥ 5 purchases | in / post |
| `m.regret_rate` | Beta-smoothed `(r + α) / (n + α + β)`; prior (α, β) from the user's category posterior | Regret feedback | n ≥ 1 (shrunk) | pre / in |
| `seg.regret_rate` | Same, for segment `category × hour_bucket × channel × amount_band` | Regret feedback | n ≥ 5 | pre / in |
| `m.recurring_status`, `m.next_expected`, `m.price_change_pct` | From B17 or B3 | Series | early / mature | pre / post |
| `m.channel`, `m.p_online` | Fused (B16) | Several | — | all |
| `ctx.is_foreign_txn`, `ctx.travel_mode` | Currency or country ≠ home; or tz offset ≠ home for > 12 h; or booking window active | C7, C8 | — | all |
| `intent.lead_time` | Time from `purchase_intent` to matched payment (fusion) | Intent + payment | matched pair | post (learning) |
| `rule.hits[]` | User rules matched | C3 | — | pre / in |
| `m.essentiality_prior` | From category / MCC map, with confidence | B1, B19 | — | all |
| `m.sensitive` | Deny-list hit (MCC class or store type) | B1, B19 | — | gate |

**How the features feed interventions.** These are gating rules, not a model spec.

- **Friction level (PRE-SPEND / IN-SPEND).** Friction is proportional to:
  - **affordability:** `amount / free_to_spend`, or `pace_ratio` when no balance is known;
  - **personal regret:** `seg.regret_rate`, or `m.regret_rate` if better supported;
  - **behaviour:** `burst_2h`, `is_late_night` (only if this user's late-night regret rate is
    elevated) and `rule.hits`;
  - **confidence:** the result is multiplied by the candidate and feature confidence.
- **Suppress all friction** for `m.sensitive`, user-protected categories and essential priors.
- **Post-spend insight selection.** Speak only if the insight changes understanding, for example
  `|velocity_z| ≥ 2`, `pace_ratio ≥ 1.2`, a new subscription, or a price change. Otherwise stay
  silent, per the brief.
- **Question policy.** Skip the question when `m.visits_90d ≥ 3` and the user's labels for that
  merchant are ≥ 90 % one category.

### Capability-registry facts (proposed entries, `asOf: 2026-10-04`)

Product code should check capabilities, not countries. Suggested ids follow the existing
namespacing in `packages/capabilities/src/types.ts`.

| Capability id | Scope | Status (by country/platform) | Note / citation |
|---------------|-------|------------------------------|-----------------|
| `merchant:mcc-card-ledger` | country | US limited (Plaid beta); GB available (OB conditional); AU available (CDR); BR available (cards); EU limited (card accounts); IN limited (AA credit-card only) | Refs 1, 2, 3, 4, 5, 6 |
| `merchant:mcc-deposit-ledger` | country | IN unavailable (AA deposit has `mode` only) | Ref 7 |
| `merchant:qr-mcc-prepayment` | country | IN limited (UPI `mc` is *optional* per the v1.6 spec transcription, so present only on some merchant QRs); BR limited (Pix `0000`); other EMV-QR markets available (tag 52 mandatory), quality unknown | Refs 13, 14, 41 |
| `merchant:qr-merchant-city` | country | EMV-QR markets available (tag 60); IN unavailable in UPI payloads (no city parameter known) **(unverified)** | Ref 13 |
| `merchant:channel-flag` | country | US available (`payment_channel`); GB available (`AuthorisationType`) | Refs 1, 2 |
| `merchant:brand-dictionary-offline` | global | available (NSI, BSD-3) | Refs 18, 19 |
| `merchant:poi-offline` | global | available (Overture Sept 2026, about 81.5M places, monthly releases; density varies) | Refs 20, 21 |
| `merchant:brand-store-locations-offline` | global | available (All the Places, CC-0, weekly run; chains only) | Ref 39 |
| `data:financekit-merchant` | platform+country | iOS US limited (iOS 17.4, Apple Card/Cash/Savings only); iOS GB available (iOS 18.4, open banking with institutions "including" 13 named banks); other countries unavailable | Refs 9–12 |
| `data:aa-purpose-spending-analytics` | country | IN available (purpose code 102) | Ref 8 |
| `os:timezone-change-broadcast` | platform | Android available (implicit-broadcast exception, manifest receiver); iOS limited (`NSSystemTimeZoneDidChange` while the app is running; check on launch or resume) | Refs 35, 40 |
| `os:geofencing` | platform | Android available (100/app, background location); iOS available (20 conditions) | Refs 24, 28 |
| `os:session-location-button` | platform | Android 17+ emerging (experimental) | Ref 27 |
| `os:calendar-write-only` | platform | iOS 17+ available; Android available (`ACTION_INSERT`, no permission) | Refs 31, 32 |
| `email:calendar-app-created-scope` | account | Google available | Ref 33 |

### Graceful degradation (the brief's users A, B, C)

- **User A** (Android + India + Gmail + notifications + AA)
  - *Merchant context:* from notifications/SMS text plus AA narration, resolved on-device by
    NSI/Overture; MCC only from BRAKE QR scans and AA credit-card data.
  - *Context:* payday from AA credits; bills from AA card summary and mandates; travel from
    currency and time zone.
- **User B** (iPhone + USA + Plaid + Gmail)
  - *Merchant context:* strongest — Plaid merchant entities, counterparties with intermediaries,
    `payment_channel`, `location`, PFC; FinanceKit adds Apple Card MCC.
  - *Context:* recurring streams from Plaid; time-of-day features limited where timestamps are
    date-only.
- **User C** (no financial account)
  - *Merchant context:* QR scan merchant fields and manual entries only.
  - *Context:* device clock, user goals, rules and budget cycle, plus regret feedback on manually
    logged purchases. Every feature still works in degraded form because features abstain rather
    than guess.

---

## Risks, policy constraints and ethical concerns

1. **Special-category inference from merchant data.** MCCs and store types can reveal health
   (8011, 8062, 8099, 5912), religion (8661), political activity (8651) and sexual life (7273).
   Under GDPR-style regimes, data that *indirectly* reveals special categories can itself be
   special-category data. CJEU cases C-184/20 (2022) and C-21/23 (2024, online pharmacy orders)
   are frequently cited for this **(not re-verified this session)**. Mitigations:
   - a deny-list that blocks these classes from server telemetry, nudge copy, regret prompts and
     any model training that leaves the device;
   - no "essentiality" moral labels on them;
   - user-visible "BRAKE never comments on" settings.
2. **Location surveillance.**
   - **Platform policy.** Background location is policy-sensitive on both platforms: Apple 5.1.5,
     the Android 11+ settings-page grant, and the Google Play declaration (details unverified).
   - **Precedent.** Precise location data has been the subject of regulator enforcement against
     data brokers in the US **(not re-verified this session)**.
   - **Trust.** One geofence-triggered nudge outside a clinic would destroy trust.

   Hence `avoid`, and at most a user-defined, on-device, expiring "trouble spots" research item.
3. **Repurposing and purpose limitation.**
   - **Apple 5.1.2(ii)** (corrected from "5.1.2(i)"): "Data collected for one purpose may not be
     repurposed without further consent unless otherwise explicitly permitted by law." App Review
     Guidelines were last updated June 8, 2026.
   - **Apple 5.1.2(i)** now requires apps to "clearly disclose where personal data will be shared
     with third parties, including with third-party AI, and obtain explicit permission before
     doing so". That applies to any server-side or LLM-based merchant enrichment of descriptors.
   - **AA consent:** artefacts are purpose-coded (102 = spending patterns/budget).
   - **US Section 1033:** the CFPB's Personal Financial Data Rights rule limits third parties'
     secondary use to what is reasonably necessary for the requested product. Its 2026 status,
     after reconsideration and litigation, is **(unverified; consumerfinance.gov,
     federalregister.gov and ecfr.gov unreachable)**. There is one indirect, vendor-side signal:
     Plaid's OpenAPI 1.762.0 says a consent-expiration field "is not currently used. Plaid may
     enable this field in the future if 1033-related expiration begins to be enforced".

   BRAKE's context features are within "spending patterns/budget". Partner offers or advertising
   based on them would not be, and the architecture should make that impossible: no context
   features leave the device.
4. **Third-party leakage through enrichment.** Each per-user server lookup tells a vendor what
   the user bought: Plaid Enrich, Ntropy, Google Places, Apple MapKit and logo CDNs. Default to
   the on-device resolver. Send only unresolved descriptors, batched, with no user identifiers,
   and only under an explicit "improve merchant names" consent.
5. **Licensing.**
   - **Google Places:** lat/lng caching is capped at 30 days. On map display:
     - non-EEA billing accounts must not show content with a non-Google map;
     - EEA billing accounts must not show it with *any* map, apart from lat/lng and `place_id`,
       and may use it only for "EEA Permitted Uses".
   - **Raw OSM data:** ODbL share-alike applies to derivative *databases* that are publicly used.
   - **Overture places:** CDLA-Permissive-2.0, Apache-2.0 and CC0 avoid share-alike. Joining
     them to OSM data may create an ODbL derivative database.
   - **All the Places:** CC-0.
   - **NSI:** BSD-3.
   - Keep attribution files in the app.
6. **Payday and time-of-day exploitation.** The same features power predatory targeting.
   Commit, in policy and code, that context features never drive offers, upsell or partner
   monetization.
7. **Scolding through context.** "It's 1 am and you're shopping again" is surveillance-flavoured
   scolding. Copy must cite the *user's own* stated preference or regret history, offer an
   exit, and stay silent when there is no insight.
8. **Regret-loop harm.** Over-prompting creates guilt and an obsessive loop. Cap prompts. Never
   ask about essentials or sensitive categories. Let users reset learned patterns.
9. **False precision.** MCC-based categories are merchant-level guesses, and date-only timestamps
   look precise when they are not. Confidence-aware UX must reflect this ("Looks like groceries").
   A low-confidence context feature must not trigger strong friction.
10. **Data minimization in storage.** Keep merchant history and regret posteriors as aggregates.
    Drop raw descriptors after resolution, unless the user opts into "keep originals for
    inspection". Apply source-specific retention, e.g. AA `dataLife`.
11. **Stale reference data.** Taxonomies change: Overture changed in September 2026, Plaid PFC v2
    arrived in December 2025, and new ISO MCCs appear. Version every lookup pack. Registry facts
    carry `asOf` and are audited for staleness.

---

## Open questions

1. **MCC population rates.** How often do Indian FIPs actually populate the AA credit-card `mcc`
   attribute (schema-required, but sample instances are empty)? How often is UK OB
   `MerchantDetails` populated by the major banks? This needs sandbox or production sampling.
2. **UPI specifics.** What is the current UPI QR and intent parameter set beyond v1.6 (2017), and
   what are the P2P/P2M conventions (`mc` value for P2P, verified-merchant indicators)? What share
   of real merchant QRs actually carry `mc`, which is optional? The NPCI primary spec was
   unreachable this session.
3. **Pix MCC.** Is the `0000` convention mandated or merely common? (BCB manual unreachable.)
4. **Plaid Enrich outside US/CA.** Quality and terms for non-US descriptors, such as Indian SMS
   or AA narration. Compare with the on-device resolver on a labelled sample.
5. **Plaid PFC v2 income labels.** Which detailed categories replace `INCOME_WAGES` and similar
   labels in v2? The taxonomy CSV on plaid.com was unreachable. Third-party open-source code
   transcribing `pfc-taxonomy-all.csv` refers to a v2 `INCOME_SALARY` label and describes v2 as a
   superset of v1 **(unverified against Plaid)**.
6. **Late-night lift.** Does the user's own late-night regret rate measurably improve
   intervention helpfulness over amount, velocity and category alone? Run the CJT lift test
   before shipping hour-based friction.
7. **"Trouble spots" geofences.** Would an opt-in, user-named geofence mode pass the expectation
   test, and with what false-positive rate? This needs a small consented study. It is not
   planned for MVP.
8. **Overture tile size.** What tile size and update cadence keep on-device POI packs small
   (target ≤ 20 MB per metro) while covering local merchants?
9. **Intermediary dictionary.** What is the best open source for intermediary patterns (payment
   gateways, delivery platforms, app-store billing) per country, and how should it be maintained?
10. **FinanceKit background delivery.** What is the real-world latency and reliability of
    `BackgroundDeliveryExtension`, and does Apple's `merchantName` differ from
    `originalTransactionDescription` enough to matter?
11. **Section 1033 in 2026.** Current text and status of the secondary-use limits, and how they
    apply to on-device derived features.
12. **India DPDP rules.** Phase-in dates and how "purpose" and "consent manager" provisions
    interact with AA purpose codes for derived context features **(unverified this session)**.
13. **Card-network APIs.** Can BRAKE get access to network merchant APIs (Visa, Mastercard)
    without being an issuer, and do the terms allow consumer-app display?

---

## References

Accessed 2026-10-04 unless noted. "Secondary" marks non-authoritative mirrors used because the
primary domain was unreachable.

1. https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml — Plaid official
   OpenAPI spec, version `2020-09-14_1.762.0`. Supports:
   - `Transaction` fields (`merchant_name`, `merchant_entity_id`, `counterparties`, beta
     `merchant_category_code`, `payment_channel`, `location`, `authorized_datetime` caveat);
   - `Counterparty.type` and `confidence_level` enums;
   - `PersonalFinanceCategoryVersion` (v2-only after 2025-12-03);
   - `TransactionStream`, `RecurringTransactionFrequency`, `TransactionStreamStatus`,
     `/transactions/recurring/get` guidance;
   - `/transactions/enrich` inputs and outputs, and the DoorDash/Burger King example.
2. https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/account-info-openapi.yaml
   — UK Open Banking Account and Transaction API v4.0.1: `OBMerchantDetails1`,
   `OBTransactionCardInstrument1` (`AuthorisationType`), transaction structure, conditional-field
   note.
3. https://raw.githubusercontent.com/postman-open-technologies/industry-standards/main/payment-services-directive/openapi/berlin-group/psd2-api-ais-single-cards%20v1.3.0%202021-06-30.yaml
   — (secondary mirror) Berlin Group NextGenPSD2 Extended Services AIS for Single Cards v1.3.0:
   `cardTransaction` fields, 4-char `merchantCategoryCode`.
4. https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/swagger-gen/api/cds_banking.json
   — Australia CDR banking API v1.36.0: `BankingTransactionV2` (`merchantName`,
   `merchantCategoryCode`, BPAY fields, `type` enum, pending/posted correlation caveat).
5. https://raw.githubusercontent.com/OpenBanking-Brasil/openapi/main/swagger-apis/credit-cards/2.3.0.yml
   — Open Finance Brasil credit-cards API 2.3.0: integer `payeeMCC`, `creditCardPayeeMCC` filter.
   A newer patch, `.../credit-cards/2.3.1.yml`, exists with the same `payeeMCC` definition
   (checked 2026-10-04).
6. https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/credit_card/others_creditcard.xsd
   and `.../credit_card/CreditCard.xml` — ReBIT credit-card FI schema (Sahamati copy):
   `Transaction@mcc` required, `Summary` (`dueDate`, `minDueAmount`, …).
7. https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/deposit/deposit.xsd
   and `.../deposit/Deposit.xml` — ReBIT deposit FI schema: `TransactionMode` enum, transaction
   attributes, no MCC.
8. https://raw.githubusercontent.com/SetuHQ/docs/main/content/data/account-aggregator/consent-object.mdx
   — AA consent object: purpose codes 101–105, `consentMode`, `fetchType`, frequency cap, `fiTypes`.
9. https://developer.apple.com/tutorials/data/documentation/financekit/transaction.json — FinanceKit
   `Transaction` properties.
10. https://developer.apple.com/tutorials/data/documentation/financekit/merchantcategorycode.json —
    `MerchantCategoryCode` `Int16` raw value.
11. https://developer.apple.com/tutorials/data/documentation/financekit.json — FinanceKit topics,
    managed entitlement, `NSFinancialDataUsageDescription`.
12. https://developer.apple.com/financekit/ — FinanceKit eligibility, US (iOS 17.4) and UK
    (iOS 18.4) availability, bank list, Finance-category requirement.
13. https://raw.githubusercontent.com/dongri/emv-qrcode/master/emv/mpm/emv_types.go — (secondary)
    EMV MPM tag IDs (52 MCC, 59 name, 60 city, 62 sub-tags, 01 = 11 static / 12 dynamic).
14. https://raw.githubusercontent.com/fonini/go-pix/master/pix/pix.go — (secondary) Pix BR Code
    generator sets tag 52 = `0000`.
15. https://raw.githubusercontent.com/googleapis/googleapis/master/google/maps/places/v1/place.proto
    — Google Places API (New) `Place` fields and `PriceLevel` enum.
16. https://cloud.google.com/maps-platform/terms/maps-service-terms — Google Maps Platform Service
    Specific Terms (last modified June 10, 2026; non-EEA billing accounts only): Places 14.1–14.3,
    General Service Terms §3 place_id caching. See ref 42 for the EEA version.
17. https://developer.apple.com/tutorials/data/documentation/mapkit/mkpointofinterestcategory.json —
    MapKit POI categories.
18. https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/README.md — NSI purpose,
    BSD-3 licence.
19. https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/data/brands/amenity/cafe.json
    and `.../data/brands/shop/supermarket.json` — NSI brand entries (Starbucks Q37158, DMart
    Q5203271), `locationSet`, `matchNames`, counts.
20. https://raw.githubusercontent.com/OvertureMaps/docs/main/docs/guides/places/index.mdx —
    Overture places guide: September 2026 counts and licences, taxonomy redesign, `categories`
    removal.
21. https://raw.githubusercontent.com/OvertureMaps/schema/main/packages/overture-schema-theme-places/src/overture/schema/places/place.py
    — Overture `Place` schema (`basic_category`, `taxonomy`, `brand.wikidata`, `confidence`,
    `operating_status`).
22. https://raw.githubusercontent.com/ntropy-network/ntropy-sdk/master/ntropy_sdk/transactions.py —
    Ntropy SDK models: entities and intermediaries, `mccs`, location, recurrence types and
    periodicities.
23. https://raw.githubusercontent.com/greggles/mcc-codes/main/mcc_codes.csv — (secondary)
    community MCC description table used for code meanings.
24. https://developer.android.com/develop/sensors-and-location/location/geofencing — 100 geofences
    per app, background-location requirement, latency, radius.
25. https://developer.android.com/develop/sensors-and-location/location/permissions/background —
    Android 10/11 background-location grant flow, "verify that access is necessary".
26. https://developer.android.com/develop/sensors-and-location/location/permissions — approximate
    (~3 km²) vs precise (~50 m), Android 12 user choice.
27. https://developer.android.com/guide/topics/permissions/private-alternatives/location-button —
    Android 17 location button, session-scoped precise location, Play policy requirement.
28. https://developer.apple.com/tutorials/data/documentation/corelocation/monitoring-the-user-s-proximity-to-geographic-regions.json
    — iOS 20-condition limit, `CLMonitor`.
29. https://developer.apple.com/tutorials/data/documentation/corelocation/clvisit.json — `CLVisit`
    fields.
30. https://developer.apple.com/tutorials/data/documentation/corelocation/claccuracyauthorization.json
    — reduced vs full accuracy, `NSLocationDefaultAccuracyReduced`.
31. https://developer.apple.com/tutorials/data/documentation/eventkit/accessing-the-event-store.json
    — EventKit write-only vs full access, EventKitUI without permission.
32. https://developer.android.com/identity/providers/calendar-provider — `READ_CALENDAR` /
    `WRITE_CALENDAR`; `ACTION_INSERT` needs no permission.
33. https://raw.githubusercontent.com/googleapis/google-api-go-client/main/calendar/v3/calendar-api.json
    — Google Calendar API OAuth scopes, including `calendar.app.created`.
34. https://raw.githubusercontent.com/merill/microsoft-info/main/_info/GraphDelegateRoles.csv —
    (secondary) Microsoft Graph `Calendars.Read` / `Calendars.ReadBasic` descriptions.
35. https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions
    — `ACTION_TIMEZONE_CHANGED` is an implicit-broadcast exception.
36. https://developer.apple.com/app-store/review/guidelines/ — App Review Guidelines (last updated
    June 8, 2026): 5.1.1(iii) data minimization; 5.1.2(i) third-party and third-party-AI sharing
    consent; 5.1.2(ii) repurposing (corrected from "5.1.2(i)"); 5.1.2(iii) and (iv); 5.1.5.
37. https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/schema.ttl — schema.org
    `Reservation` properties and subtypes, `Order` properties.
38. Local: `/home/user/badui/docs/brief.md`, `/home/user/badui/docs/architecture/fusion-and-reconciliation.md`,
    `/home/user/badui/packages/core/src/model/observation.ts`,
    `/home/user/badui/packages/capabilities/src/types.ts` — BRAKE requirements, fusion rules,
    existing `MerchantObservation`/`CategoryHint`/`Reference` model and registry types.
39. https://raw.githubusercontent.com/alltheplaces/alltheplaces/master/README.md,
    `.../LICENSE` and `.../DATA_FORMAT.md` — All the Places: CC-0 data, MIT code, weekly run,
    GeoJSON output with `brand:wikidata` (added by fact-check, 2026-10-04).
40. https://developer.apple.com/tutorials/data/documentation/foundation/nsnotification/name-swift.struct/nssystemtimezonedidchange.json
    — iOS `NSSystemTimeZoneDidChange` (added by fact-check).
41. https://raw.githubusercontent.com/rahulsharmadev0/knowledge-ocean/main/bundles/docs/linking.pdf.md
    — (secondary, AI-generated transcription) NPCI UPI Linking Specification v1.6 parameter table.
    `mc` is optional; `tr` is mandatory for merchant and dynamic links. Used only because
    npci.org.in was blocked; not authoritative.
42. https://cloud.google.com/terms/maps-platform/eea/maps-service-terms — Google Maps Platform EEA
    Service Specific Terms (last modified June 10, 2026): Places §15.1 "No Use With any Map",
    §15.2 EEA Permitted Uses, §15.4 30-day lat/lng caching (added by fact-check).

Not consulted (background knowledge only, flagged inline as unverified): ISO 18245 edition
history and the MCC 5723 controversy; NPCI UPI Linking Specification; BCB Pix manual; RBI
e-mandate rules; CFPB Section 1033 status; CJEU C-184/20 and C-21/23; Gelman et al. (2014),
Olafsson & Pagel (2018), Nissenbaum (2004); Google Play location policy text; Visa and
Mastercard merchant API documentation. (The NPCI spec is now covered only by a secondary
transcription; see ref 41.)

---

## Verification log

An adversarial fact-check ran on 2026-10-04. Web search was unavailable, so each artefact was
fetched directly and read. Verdicts:

- **confirmed**: the primary or cited artefact supports the claim as written;
- **corrected**: the doc was edited;
- **unverifiable**: the primary source was blocked or does not exist publicly. The claim stays
  marked (unverified) in the text.

| # | Claim | Verdict | Source |
|---|-------|---------|--------|
| 1 | Plaid OpenAPI spec is version `2020-09-14_1.762.0` | confirmed | https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml |
| 2 | Plaid `merchant_category_code` is beta, mostly card transactions, values may change | confirmed | same |
| 3 | Customers that enabled Transactions/Enrich on or after 2025-12-03 get only PFC v2 | confirmed | same (`PersonalFinanceCategoryVersion`) |
| 4 | `authorized_datetime` may contain default 00:00:00 | corrected: also "returned for select financial institutions" only; same caveat on `datetime` | same |
| 5 | Counterparty `type` enum (6 values) and `confidence_level` (>98 %, >90 %, LOW = cleansed name) | confirmed | same |
| 6 | `DD DOORDASH BURGERKIN` → DoorDash `marketplace` + Burger King `merchant` | confirmed | same |
| 7 | `location` only for physical stores, most likely large chains; `logo_url` 100×100 PNG on plaid-merchant-logos CDN | confirmed | same |
| 8 | Recurring: MATURE ≥ 3 (annual 2); `is_user_modified` discontinued; request ≥ 180 days; offered as add-on | confirmed | same |
| 9 | Enrich: max 100 transactions/request; location `country` is "US" or "CA" | confirmed | same |
| 10 | Plaid country coverage "US, CA, GB, EU" | corrected: `CountryCode` enum = US, CA, GB, NO + 16 EU states | same |
| 11 | UK OB v4.0.1 `MerchantCategoryCode` 3–4 chars, `MerchantName` 1–350, `AuthorisationType` enum, conditional-field rule | confirmed | https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/account-info-openapi.yaml |
| 12 | Berlin Group cards: `merchantCategoryCode` exactly 4 chars; `cardAcceptorId` ≤ 35; acceptor address/phone, `terminalId` | confirmed (secondary mirror) | https://raw.githubusercontent.com/postman-open-technologies/industry-standards/main/payment-services-directive/openapi/berlin-group/psd2-api-ais-single-cards%20v1.3.0%202021-06-30.yaml |
| 13 | AU CDR v1.36.0 `BankingTransactionV2` merchant + BPAY fields, `type` enum, pending/posted caveat | confirmed (v1.36.0 is the latest release notes on master; no 1.37.0 found) | https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/swagger-gen/api/cds_banking.json |
| 14 | Open Finance Brasil cards 2.3.0 integer `payeeMCC`, `creditCardPayeeMCC` filter | confirmed; corrected: 2.3.1 also exists | https://raw.githubusercontent.com/OpenBanking-Brasil/openapi/main/swagger-apis/credit-cards/2.3.1.yml |
| 15 | AA deposit `mode` enum, no MCC/merchant field | confirmed | https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/deposit/deposit.xsd |
| 16 | AA deposit `transactionTimestamp` "with UTC offset" | corrected: `xs:dateTime`, offset optional | same |
| 17 | AA credit-card `mcc` required; sample `mcc=""`; Summary `dueDate`/`minDueAmount`/…; `txnDate` date-only | confirmed | https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/credit_card/others_creditcard.xsd |
| 18 | AA purpose codes 101–105 (102 = spending patterns); max 1 fetch/hour | confirmed (Setu doc citing AA spec; ReBIT/Sahamati sites blocked) | https://raw.githubusercontent.com/SetuHQ/docs/main/content/data/account-aggregator/consent-object.mdx |
| 19 | FinanceKit `MerchantCategoryCode` raw value is `Int16` | confirmed | https://developer.apple.com/tutorials/data/documentation/financekit/merchantcategorycode.json |
| 20 | FinanceKit US iOS 17.4+ (Apple Card/Cash/Savings), UK iOS 18.4+ with 13 banks, Finance category | confirmed; corrected: UK list is "including" (non-exhaustive); Family exclusions added | https://developer.apple.com/financekit/ |
| 21 | FinanceKit requires an *organization* developer account | unverifiable: page says only "Account Holder", granted per bundle ID | same |
| 22 | EMV MPM: tag 52 MCC mandatory; 59/60 name and city; 61 postal; 62 sub-tags; 01 = 11/12 | confirmed (secondary parser); corrected: tag 01 and 61 optional, 59/60 mandatory | https://raw.githubusercontent.com/dongri/emv-qrcode/master/emv/mpm/emv_types.go |
| 23 | Pix BR Code tag 52 = `0000` | confirmed as implementation (go-pix); BCB mandate unverifiable | https://raw.githubusercontent.com/fonini/go-pix/master/pix/pix.go |
| 24 | UPI QR carries `pa`, `pn`, `mc`, `tr`, … before payment | corrected: `mc` optional; `tr` mandatory for merchant/dynamic; primary unverifiable | https://raw.githubusercontent.com/rahulsharmadev0/knowledge-ocean/main/bundles/docs/linking.pdf.md (secondary) |
| 25 | Google Maps Service Specific Terms last modified 2026-06-10; Places 14.1–14.3 | confirmed; corrected: applies to non-EEA billing only | https://cloud.google.com/maps-platform/terms/maps-service-terms |
| 26 | (missing) EEA Places terms | corrected/added: §15.1 "No Use With any Map", §15.2 Permitted Uses | https://cloud.google.com/terms/maps-platform/eea/maps-service-terms |
| 27 | Places `Place` proto fields and `PriceLevel` enum | confirmed | https://raw.githubusercontent.com/googleapis/googleapis/master/google/maps/places/v1/place.proto |
| 28 | NSI BSD-3; Starbucks Q37158 `amenity=cafe`; DMart Q5203271 India only; 507 cafe / 1,049 supermarket brands | confirmed | https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/data/brands/shop/supermarket.json |
| 29 | Overture Sept 2026 ≈ 81.6M places | corrected: 81,455,423 ≈ 81.5M | https://raw.githubusercontent.com/OvertureMaps/docs/main/docs/guides/places/index.mdx |
| 30 | Overture removed `categories` Sept 2026; L0 22→13; 2,108 re-pathed; ~280 basic; ~2,300 taxonomy | confirmed (guide also says "2.1k" and "about 300" elsewhere) | same |
| 31 | Overture releases monthly (was unverified); GERS stability (was unverified) | corrected: monthly confirmed; July 2026 one-time GERS churn | same |
| 32 | Ntropy `mccs: List[int]`, intermediaries, recurrence types | confirmed | https://raw.githubusercontent.com/ntropy-network/ntropy-sdk/master/ntropy_sdk/transactions.py |
| 33 | Android: 100 geofences/app; latency < 2 min, 2–3 min, up to 6 min; radius 100–150 m; background location on API 29+ | confirmed | https://developer.android.com/develop/sensors-and-location/location/geofencing |
| 34 | Android 11+ background location is granted only on a settings page | confirmed | https://developer.android.com/develop/sensors-and-location/location/permissions/background |
| 35 | Approximate location ≈ 3 km²; Android 12 approximate-only choice | confirmed | https://developer.android.com/develop/sensors-and-location/location/permissions |
| 36 | Android 17 (API 37) location button, Play requirement sentence, experimental Jetpack | confirmed; Play policy page unverifiable | https://developer.android.com/guide/topics/permissions/private-alternatives/location-button |
| 37 | `ACTION_TIMEZONE_CHANGED` is an implicit-broadcast exception | confirmed | https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions |
| 38 | iOS time-zone change API (was unverified) | corrected: `NSSystemTimeZoneDidChange` exists | https://developer.apple.com/tutorials/data/documentation/foundation/nsnotification/name-swift.struct/nssystemtimezonedidchange.json |
| 39 | iOS 20 monitored conditions; `CLVisit` fields; reduced accuracy | confirmed | https://developer.apple.com/tutorials/data/documentation/corelocation/monitoring-the-user-s-proximity-to-geographic-regions.json |
| 40 | EventKit write-only + "Don't request full access…"; EventKitUI without permission | confirmed | https://developer.apple.com/tutorials/data/documentation/eventkit/accessing-the-event-store.json |
| 41 | Android `ACTION_INSERT` needs no `WRITE_CALENDAR` | confirmed | https://developer.android.com/identity/providers/calendar-provider |
| 42 | Google `calendar.app.created` / `calendar.events.readonly` descriptions | confirmed | https://raw.githubusercontent.com/googleapis/google-api-go-client/main/calendar/v3/calendar-api.json |
| 43 | Graph `Calendars.ReadBasic` excludes body, attachments and extensions | confirmed (secondary) | https://raw.githubusercontent.com/merill/microsoft-info/main/_info/GraphDelegateRoles.csv |
| 44 | Apple 5.1.5, 5.1.2(iii), 5.1.2(iv), 5.1.1(iii) quotes | confirmed (guidelines last updated 2026-06-08) | https://developer.apple.com/app-store/review/guidelines/ |
| 45 | Apple "5.1.2(i)" repurposing quote | corrected: it is 5.1.2(ii) and ends "unless otherwise explicitly permitted by law"; 5.1.2(i) third-party-AI consent added | same |
| 46 | schema.org Reservation properties and subtypes; `reservationNumber` not in core | confirmed | https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/schema.ttl |
| 47 | MCC meanings; greggles table has 981 rows | confirmed | https://raw.githubusercontent.com/greggles/mcc-codes/main/mcc_codes.csv |
| 48 | Sensitive-MCC deny-list (8651, 8661, 8011, 8062, 8099, 5912, 7273, 7995) | corrected: incomplete; 16 codes added | same |
| 49 | MCC 5552 EV charging; 5723 firearms (ISO 2022, paused) | unverifiable: not in table; iso.org blocked | — |
| 50 | ISO 18245 current edition | unverifiable: iso.org blocked | — |
| 51 | CFPB §1033 2026 status | unverifiable: CFPB, Federal Register and eCFR blocked; Plaid spec says 1033 expiration not currently enforced | Plaid spec (indirect) |
| 52 | CJEU C-184/20, C-21/23; RBI e-mandate 24 h pre-debit; Gelman 2014; Olafsson & Pagel 2018; DPDP Rules phase-in | unverifiable: curia, rbi.org.in, meity blocked; no web search | — |
| 53 | Google Play background-location declaration details | unverifiable: support.google.com blocked | — |
| 54 | Card-network merchant APIs; Ntropy coverage and pricing; Plaid pricing | unverifiable: vendor portals blocked | — |
| 55 | (missing source) All the Places: CC-0, weekly, `brand:wikidata` | added | https://raw.githubusercontent.com/alltheplaces/alltheplaces/master/DATA_FORMAT.md |
