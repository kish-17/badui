# 01 - Open banking, aggregators and bank APIs

> **Scope.** Bank-ledger data that reaches BRAKE through regulated or commercial account-information channels: Plaid (Transactions, Recurring, Balance, Enrich), India's Account Aggregator (AA) network, UK Open Banking (AIS, standing orders/direct debits, VRP), EU PSD2 AIS and its successors (PSD3/PSR, FiDA), Brazil Open Finance, Australia CDR, US FDX/Section 1033, Canada consumer-driven banking, Singapore SGFinDex, Saudi/UAE, Japan, Mexico, and the aggregator market (TrueLayer, Tink, Salt Edge, GoCardless Bank Account Data, MX, Mastercard/Finicity, Yodlee, Akoya, Belvo, Basiq, Setu/Finvu/OneMoney/Anumati). Card-linked feeds, issuer webhooks, neobank personal APIs and Apple FinanceKit are stream 02.
>
> **Date:** 2026-10-04.
>
> **Verification legend.** **[V]** = verified in this session against the primary source listed in References (official OpenAPI/XSD specs and standards-body repositories). **(unverified)** = from prior knowledge (training data to mid-2026) that could not be re-checked in this session; treat as a lead, not a fact. Session constraint: regulator, vendor-documentation and news sites (plaid.com, consumerfinance.gov, fca.org.uk, europa.eu, rbi.org.in, sahamati.org.in, the aggregator websites) were blocked by the network egress proxy, and the shared web-search budget was used up. So the **time-sensitive regulatory statuses in this document are the weakest part** and need a verification pass. The machine-readable specs fetched from GitHub (Plaid OpenAPI 2020-09-14_1.762.0 as of Sept 2026, Sahamati AA specs and fair-use rules, OBIE v4.0.1, CDR standards, Open Finance Brasil) are strong.
>
> **Key takeaways for BRAKE**
>
> 1. **Bank-ledger rails are POST-SPEND sources, not IN-SPEND ones.** Plaid checks institutions "between one and four times per day" [V]. EU AIS unattended access is capped at 4 calls per day by the RTS, and a Berlin Group implementation enforces `frequencyPerDay` ≤ 4 [V]. The India AA fair-use template for purpose 102 (spending and budgeting) allows at most **45 fetches per calendar month** [V]. In every market, real-time awareness has to come from device and alert signals (streams 03/07). Ledger sources are the *confirmation and correction* layer of fusion, and the main source of pre-spend *context* (balances, recurring obligations).
> 2. **Plaid is the only turnkey MVP ledger source.** Link supports 20 countries: US, CA, GB, IE and 16 EU/EEA markets [V]. It does not cover India, Brazil, Australia or Mexico [V, by absence from the `CountryCode` enum]. Build on `/transactions/sync` + `SYNC_UPDATES_AVAILABLE`. Plaid is also the only regime examined that links pending and posted records explicitly: `pending_transaction_id` on the posted record [V].
> 3. **Pending→posted correlation does not carry over between regimes.** The Australian CDR standard says outright that there is "no provision in the standards to guarantee the ability to correlate a pending transaction with an associated posted transaction" [V]. In Brazil a `transactionId` may change until `TRANSACAO_EFETIVADA` [V]. UK OBIE marks records `Mutable`/`Immutable` [V]. The AA deposit schema carries posted transactions only [V]. Fusion must therefore treat provider ids as *namespaced and mutable until final*, and fall back to fuzzy matching.
> 4. **India AA gives high-quality data, but BRAKE cannot hold the FIU role unless it is regulated.** The FIU must be a financial-sector-regulated entity (RBI NBFC-AA Master Direction, unverified this session), so BRAKE needs a regulated FIU partner or its own licence. The purpose-102 template is PERIODIC, consent ≤ 1 year, FI data range ≤ 13 months, ≤ 45 pulls/month, and **Data Life 31 days**, after which the FIU must purge [V]. That forces a "derive, then forget raw" design for AA data.
> 5. **Sign and amount conventions differ, so the adapter boundary must normalize them.** In Plaid a positive `amount` is an outflow [V]. In CDR a negative amount is outgoing [V]. UK, Brazil and AA use an unsigned amount plus a debit/credit indicator [V]. The AA XSD types `amount` as `xs:float` [V], so parse it as a decimal string.
> 6. **Recurring-obligation data is the most useful pre-spend output these rails produce.** Examples: Plaid recurring streams (`predicted_next_date`, `MATURE`/`EARLY_DETECTION`/`TOMBSTONED`) [V]; MX `repeating_transactions` (`predicted_occurs_on`) [V]; UK `/standing-orders`, `/direct-debits`, `/scheduled-payments` [V]; Brazil `LANCAMENTO_FUTURO` entries up to 12 months ahead [V]. This is what powers "Netflix renews tomorrow" without scolding.
> 7. **Licensing by region.** US: no licence, but an aggregator contract plus GLBA/FTC Safeguards duties (unverified). UK/EU: AISP registration, or operating under or as an agent of an aggregator's AIS permission (unverified details). India: regulated FIU. Brazil: BCB-authorised receiver. Australia: ADR, or a CDR representative of one (unverified). Recommended start is the aggregator-licence/agent model in UK/EU and a regulated FIU partner in India.
> 8. **2026 regulatory picture.** Plaid's Sept-2026 spec says its 1033 re-authorization logic is "not currently used… may enable… if 1033-related expiration begins to be enforced" [V], so US §1033 obligations were not being enforced as of Sept 2026. PSD3/PSR were politically agreed in late 2025 but are not yet applicable (unverified). FiDA's fate is unclear (unverified). Canada's framework is not live for consumers (unverified). Australia's CDR standards reached v1.36.0 on 2025-12-04 and include the March 2025 non-bank lending (NBL) and BNPL rules [V].
> 9. **Avoid list.** Do not start a new build on GoCardless Bank Account Data: its official client libraries are "no longer actively updated or maintained" [V]. SGFinDex is closed to third parties (unverified). Avoid credential-scraping paths wherever an API path exists.
> 10. **Every aggregator integration needs a backend** for client secrets, access tokens and webhooks (Plaid `item_id`/`access_token`, AA FIU keys). This conflicts with BRAKE's local-first preference. Design a minimal "token vault + relay" that holds credentials, pulls deltas, forwards the minimum to the device and enforces per-source retention.

---

## Sources investigated

Each source below covers: what it is · data (concrete fields) · windows and latency · coverage · access · privacy/consent · reliability · dedup keys · normalized observation · provenance sentence · recommendation.

### 1. Plaid Transactions (`/transactions/sync`) - id `plaid-transactions`

**What it is.** Plaid's aggregated transaction feed for `credit`, `depository` and some `loan` accounts (`student`, `mortgage`). Investments use a separate endpoint [V].

**Integration flow [V]**
- Initialise Transactions in `/link/token/create`.
- `transactions.days_requested` defaults to 90 days. Production requests at least 30 days. The maximum is "up to 2 years", per the webhook description.
- `days_requested` cannot be raised after initialisation. More history requires deleting the Item and re-linking.
- `/transactions/sync` request:
  - `cursor`: at most 256 chars of base64. The special value `"now"` is only for migrating from `/transactions/get`.
  - `count`: 1-500, default 100.
  - `options`: `include_original_description`, `personal_finance_category_version`, `account_id`, `days_requested`.
- Response:
  - `added[]`, `modified[]`, `removed[]`, where a removed entry has only `{transaction_id, account_id}`.
  - `next_cursor`: "valid for at least 1 year" once pagination finishes.
  - `has_more`, `accounts[]`.
  - `transactions_update_status`: `NOT_READY`, `INITIAL_UPDATE_COMPLETE`, `HISTORICAL_UPDATE_COMPLETE`, `TRANSACTIONS_UPDATE_STATUS_UNKNOWN`.
- On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, restart the whole pagination loop from the first page's cursor.

**Webhooks [V]**
- `SYNC_UPDATES_AVAILABLE` (`webhook_type: TRANSACTIONS`) carries `item_id`, `user_id`, `initial_update_complete`, `historical_update_complete` and `environment`.
  - `initial_update_complete` means the most recent 30 days are available.
  - `historical_update_complete` means the full requested history (up to 2 years) is available.
- Per Plaid docs (seen via search snippet only), the webhook fires only after `/transactions/sync` has been called at least once for the Item.
- Legacy `DEFAULT_UPDATE` and `TRANSACTIONS_REMOVED` still fire for backward compatibility.
- `/transactions/refresh` forces an extra on-demand extraction on top of the periodic "one or more times per day" checks.
- `item.status.transactions.last_successful_update` (from `/item/get`) gives data freshness.

**Transaction object fields [V]**

| Group | Fields |
|---|---|
| Identity | `transaction_id`, `account_id`, `pending`, `pending_transaction_id` |
| Amount | `amount` ("Positive values when money moves out of the account; negative values when money moves in"), `iso_currency_code`, `unofficial_currency_code` |
| Dates | `date` (occurred date while pending, posted date once posted), `authorized_date`, `authorized_datetime`, `datetime` |
| Merchant | `merchant_name`, `merchant_entity_id` (stable, brand-level), `logo_url`, `website`, `name` (legacy), `original_description` (opt-in) |
| Counterparties | `counterparties[]` = {`name`, `entity_id`, `type` ∈ `merchant`, `financial_institution`, `payment_app`, `marketplace`, `payment_terminal`, `income_source`; `website`, `logo_url`, `confidence_level`, `phone_number`, `account_numbers`} |
| Category | `personal_finance_category` {`primary`, `detailed`, `confidence_level` ∈ `VERY_HIGH` (>98%), `HIGH` (>90%), `MEDIUM`, `LOW`, `UNKNOWN`, `version` ∈ `v1`/`v2`}; `personal_finance_category_icon_url`; `business_finance_category`; legacy `category`/`category_id` |
| Channel/codes | `payment_channel` ∈ `online`/`in store`/`other`; `merchant_category_code` (**beta**, mostly card); `transaction_code` (populated for European and some US institutions) ∈ `adjustment`, `atm`, `bank charge`, `bill payment`, `cash`, `cash advance`, `cashback`, `cheque`, `direct debit`, `interest`, `late fee`, `membership fee`, `payment`, `purchase`, `refund`, `returned item fee`, `standing order`, `transfer` |
| Transfer metadata | `payment_meta` {`reference_number`, `ppd_id`, `payee`, `payer`, `by_order_of`, `payment_method`, `payment_processor`, `reason`} |
| Other | `location`, `check_number`, `running_balance` (new; posted only; "may not reconcile" with balance endpoints), `account_owner` |

**Taxonomy [V].** Customers that enabled Transactions or Enrich **on or after 3 Dec 2025 can only receive PFC `v2`**. Earlier customers get `v1` by default and can request `v2`. The taxonomy CSV is linked from the spec (`plaid.com/documents/pfc-taxonomy-all.csv`) but was not fetched. The v1 primaries include `INCOME`, `TRANSFER_IN`, `TRANSFER_OUT`, `LOAN_PAYMENTS`, `BANK_FEES`, `FOOD_AND_DRINK`, `GENERAL_MERCHANDISE`, `RENT_AND_UTILITIES`, `TRAVEL` and others (unverified this session; v2 differs).

**Pending vs posted.**
- Pending details "may change before they are settled", and "Not all institutions provide pending transactions" [V].
- When a pending item posts, Plaid surfaces the posted record with a new `transaction_id` whose `pending_transaction_id` points at the pending one, and the pending one appears in `removed` (Plaid docs, not re-fetched; consistent with the field definitions [V]).
- More generally, "Transactions are not immutable and can also be removed altogether by the institution" [V].

**Windows and latency.**
- **POST-SPEND.** Pending items typically arrive hours after a card authorisation, posted items 1-3 business days later (typical, unverified). Plaid polls 1-4 times per day per institution [V].
- **PRE-SPEND context:** balances, history-derived pace and payday detection.
- **Not IN-SPEND.**

**Coverage.** Link `CountryCode` enum: US, GB, ES, NL, FR, IE, CA, DE, IT, PL, DK, NO, SE, EE, LT, LV, PT, BE, AT, FI [V]. Reach is strongest in the US and Canada. UK/EU coverage runs over PSD2 APIs and competes with local aggregators. Works on iOS, Android and web through Link SDKs; the server holds tokens.

**Access and cost.**
- Plaid contract plus production access approval (process details unverified).
- Transactions is billed per Item, as a "billed product". Balance is "billed on a pay-per-call basis" [V]. Recurring Transactions is an add-on that needs a product-access request [V].
- List prices are not public and could not be verified.
- Plaid Portal: end users manage connections there. Partner customer-support info is "mandatory for partners whose Plaid accounts were created after November 26, 2024 and will be mandatory for all partners by the 1033 compliance deadline" [V].
- OAuth2 delegated tokens with a `transactions:read` scope were added in 2026 [V].

**Privacy and consent.**
- Data Transparency Messaging records `consented_products`, `consented_use_cases` and `consented_data_scopes` (e.g. `account_balance_info`, `transactions`) on `/item/get` [V].
- `consent_expiration_time` is set "only [for] institutions in Europe and a small number of institutions in the US" [V].
- Lifecycle webhooks [V]:
  - `PENDING_EXPIRATION`: EU/UK, 7 days before expiry.
  - `PENDING_DISCONNECT`: US/CA, 7 days before disconnection.
  - `USER_PERMISSION_REVOKED`: "may not always fire" when the user revokes at the bank.
  - `ITEM_ERROR`: user goes through Link update mode.
- Minimise by requesting only the `transactions` product. Do not add `identity`/`auth` unless needed.
- `original_description` is opt-in: leave it off unless merchant parsing fails.

**Reliability and failure modes.**
- Institution outages and `ITEM_LOGIN_REQUIRED` re-auth churn.
- Missing pending items at some banks.
- Pending amounts that change: tips, fuel and hotel holds (generic card behaviour).
- Pending items that vanish: auth reversals arrive as `removed`.
- Duplicate Items: "linking the same account at the same institution twice will result in two Items with different `item_id` values" [V]. Their `transaction_id`s differ, so cross-Item duplicates need account-mask matching.
- Missed webhooks: poll on a timer as a fallback, using `transactions_update_status` [V].

**Dedup and reconciliation keys.**
- `transaction_id` (namespace: Item).
- `pending_transaction_id` (links posted to pending).
- `payment_meta.reference_number`, `check_number`.
- `merchant_entity_id` / `counterparties[].entity_id` (merchant-level, not event-level).
- `authorized_datetime` (best occurred-at).
- Account `mask` + institution for cross-source joins with SMS/notification alerts that show "XX1234".

**Normalized BRAKE observation.**
- `kind: money_movement`.
- `stage: pending | posted`. A removed pending item becomes `cancelled` unless superseded.
- `direction` from the sign; `amount` = |amount| in minor units with currency.
- `occurredAt` = `authorized_datetime` ?? `datetime` ?? `date`, marked date-only when only `date` exists.
- `merchant` {raw: `original_description` or `name`, name: `merchant_name`, key: `merchant_entity_id`, mcc, website, channel from `payment_channel`, confidence mapped from counterparty `confidence_level`}.
- `references`:
  - `provider_transaction_id` (ns `plaid:item_id`)
  - `provider_pending_id`
  - `rail_reference` (`payment_meta.reference_number`)
- `categoryHints` (PFC, with `version` and `confidence_level`).
- `typeHints`: TRANSFER_*, LOAN_PAYMENTS, `transaction_code`, counterparty `type`.
- Suggested confidence priors (design proposal, not a vendor fact):
  - Posted: amount/direction 0.99.
  - Pending: 0.9 by default, 0.75 for MCC/PFC classes with known holds (restaurants, fuel, lodging, car rental).
  - Merchant: VERY_HIGH→0.97, HIGH→0.9, MEDIUM→0.7, LOW→0.45, UNKNOWN→0.5.

**Provenance sentences.**
- Posted: "Confirmed by a posted transaction on your Chase checking (via Plaid, synced 9:14)."
- Pending: "Seen as a pending charge on your Amex card via Plaid; the final amount can change."

**Recommendation: `mvp`** for US/CA (and as the UK/EU fallback aggregator). It gives the cleanest pending/posted lifecycle, a merchant entity graph and confidence-scored categories. It fits User B (iPhone + USA + Plaid). It does not cover India.

### 2. Plaid Recurring Transactions - id `plaid-recurring-transactions`

**Data [V]**
- `/transactions/recurring/get` returns `inflow_streams[]` and `outflow_streams[]`, each a `TransactionStream`:
  - Identity and description: `stream_id`, `account_id`, `description`, `merchant_name`, `personal_finance_category`.
  - Timing: `first_date`, `last_date`, `predicted_next_date`.
  - `frequency` ∈ `WEEKLY`, `BIWEEKLY`, `SEMI_MONTHLY`, `MONTHLY`, `ANNUALLY`, `UNKNOWN`.
  - Amounts and members: `transaction_ids[]`, `average_amount`, `last_amount` (each {`amount`, `iso_currency_code`}).
  - State: `is_active`; `status` ∈ `MATURE` (at least 3 transactions, or 2 for annual), `EARLY_DETECTION`, `TOMBSTONED`, `UNKNOWN`.
  - `is_user_modified` is "always `false`" because stream editing was discontinued.
- `updated_datetime`.
- Webhook `RECURRING_TRANSACTIONS_UPDATE` {`item_id`, `account_ids[]`}.
- Plaid recommends at least 180 days of history.

**Windows.** PRE-SPEND (upcoming renewals, bills and paydays from `predicted_next_date`) and POST-SPEND (subscription identification). Latency follows Transactions (daily-ish).

**Coverage and access.** An add-on to Transactions with an access request [V]. Country availability beyond US/CA is unverified.

**Reliability.**
- Statistical detection, so price changes and irregular billers produce `EARLY_DETECTION`/`TOMBSTONED` churn.
- Users cannot correct streams through the API [V], so BRAKE must keep its own user-assertion layer.

**Dedup keys.** `stream_id`, `transaction_ids[]` (which tie streams to ledger observations).

**Observation.** `kind: subscription_event` or `mandate`-like context, carrying `subscription.period`, `nextExpected` and `amountTypical`. Confidence: `MATURE` 0.85, `EARLY_DETECTION` 0.5.

**Provenance.** "Plaid found 4 monthly payments to Netflix on your Chase card; next expected 12 Oct."

**Recommendation: `next`.** Highly relevant to the brief's renewal intervention, but BRAKE should run its own recurrence detector (stream 09) so the feature works on AA/SMS data too. Use Plaid streams as one input.

### 3. Plaid Balance - id `plaid-balance`

**Data [V].** `AccountBalance` {`available`, `current`, `limit`, `iso_currency_code`, `unofficial_currency_code`, `last_updated_datetime` (populated only for Capital One `ins_128026`)}.

**Two read paths [V]:**
- `/accounts/balance/get` forces a real-time refresh: "typically less than 10 seconds, but occasionally up to 30 seconds or more". Billed per call.
- `/accounts/get` is free and cached. For Transactions Items the balance "will typically update about once a day".

**Windows.** PRE-SPEND ("can I afford this?", low-balance context) and POST-SPEND (financial state update).

**Recommendation: `next`.** Use the free cached balance by default. Only call real-time balance on an explicit user action such as "Should I buy this?". Balance is affordability context, not a transaction signal.

**Provenance.** "Balance from your Chase checking via Plaid, updated about 6 hours ago."

### 4. Plaid Enrich (non-Plaid transactions) - id `plaid-enrich`

`/transactions/enrich` "enriches raw transaction data generated by your own banking products or retrieved from other non-Plaid sources" [V].

- Input `ClientProvidedTransaction`: `id`, `client_user_id`, `client_account_id`, `account_type`, `account_subtype`, `description`, `amount` (absolute), `direction`, `iso_currency_code`, `location`, `mcc`, `date_posted` [V].
- Output: PFC, counterparties and merchant fields.

Possible use: normalising merchants from SMS/notification/AA narrations. Country support outside the US is unverified. It sends the user's transaction text to a third party, which works against local-first.

**Recommendation: `research`.** Benchmark it against on-device merchant normalisation (stream 09) before sending any data.

### 5. India Account Aggregator (Sahamati/ReBIT) - id `india-account-aggregator`

**Roles.**
- **FIP** (data holder: banks, AMCs, depositories, insurers, pension, GSTN).
- **AA** (RBI-licensed NBFC-AA; consent manager and data-blind pipe).
- **FIU** (data consumer).
- **TSPs** (technical service providers that integrate FIUs/FIPs; not data owners).

**Consent and data flow.**
- "All consent necessarily have to be generated directly on application provided by AA" [V].
- FI data is encrypted FIP→FIU with ECDH key material (`KeyMaterial` in the spec; Sahamati's `rahasya` library implements Curve25519 DH) [V], so the AA cannot read it.
- APIs (spec v1.1.2 in the Sahamati repo) [V]: `/Consent`, `/Consent/handle/{consentHandle}`, `/Consent/{id}`, `/FI/request`, `/FI/fetch/{sessionId}` (partial fetch via `?fipid=&linkRefNumber=`), `/Consent/Notification`, `/FI/Notification`, `/Account/link/Notification`, `/Heartbeat`.
- `FIStatus` ∈ `READY`, `DENIED`, `PENDING`, `DELIVERED`, `TIMEOUT`; `sessionStatus` ∈ `ACTIVE`, `COMPLETED`, `EXPIRED`, `FAILED` [V].

**Consent artefact (`ConsentDetail`) [V]**

| Field | Values / notes |
|---|---|
| `consentStart`, `consentExpiry` | date-times; post-dated consent allowed |
| `consentMode` | `VIEW`, `STORE`, `QUERY`, `STREAM` |
| `fetchType` | `ONETIME`, `PERIODIC` |
| `consentTypes` | `PROFILE`, `SUMMARY`, `TRANSACTIONS` (min 1) |
| `fiTypes` | e.g. `DEPOSIT` |
| `DataConsumer` {id, type `FIU`/`AA`}, `DataProvider` {id, type `FIP`/`AA`}, `Customer` {id e.g. `user@aa`} | |
| `Accounts[]` | {`fiType`, `fipId`, `accType`, `linkRefNumber`, `maskedAccNumber`} |
| `Purpose` | {`code` (e.g. `101`), `refUri` (e.g. `https://api.rebit.org.in/aa/purpose/101.xml`), `text` (e.g. "Wealth management service"), `Category`} |
| `FIDataRange` | {`from`, `to`} |
| `DataLife` | {`unit` ∈ `DAY`,`MONTH`,`YEAR`,`INF`; `value`} - "for how long can the FIU/AA Application store the data" |
| `Frequency` | {`unit` ∈ `HOUR`,`DAY`,`MONTH`,`YEAR`; `value`} - "UNIT - Month, Value - 6 … make 6 times FI request per month" |
| `DataFilter[]` | {`type` ∈ `TRANSACTIONTYPE`,`TRANSACTIONAMOUNT`; `operator` ∈ `=`,`!=`,`>`,`<`,`>=`,`<=`; `value`} |

**Fair-use ceilings (Sahamati Fair Use Template rules, enforced by AAs and optionally FIPs; violations return HTTP 412) [V]**

| Purpose | Fetch | FI types | Max consent | Max FI data range (and per request) | Frequency ceiling | Data life | Consent types |
|---|---|---|---|---|---|---|---|
| 101 (wealth mgmt) | PERIODIC | DEPOSIT, TD, RD, insurance, NPS, GSTR1_3B… | 1 year | 13 months | 1/day or 31/month | 31 days / 1 month | P, S, T |
| **102 (spending/budgeting)** | PERIODIC | DEPOSIT, TD, RD, insurance, NPS, GSTR1_3B… | **1 year** | **13 months** | **1/day or 45/month** (calendar month; "45 per month must not be interpreted as 1.5 per day") | **31 days / 1 month** (template CT019 variant: **7 days**) | P, S, T |
| 102 (SEBI types: SIP, equities, MF…) | PERIODIC | | 1 year | 10 years (2 years per request) | 45/month | 31 days | P, S, T |
| 103 (aggregated statement) | ONETIME | most | 1 month | 14 months | n/a | 31 days | P, S, T |
| 104 (monitoring) | PERIODIC | most | 5 years | 6 months | 5/month | 31 days | P, S, T |
| 105 (one-time check) | ONETIME | DEPOSIT etc. | 1 day | 1 day | n/a | 1 day | P, S |

- Data Life is "the time period available for the FIU to process the data for the consented purpose, post which it is archived and not available for processing again. FIUs are expected to 'delete' or 'purge' the data after the Data Life time-window expires" [V].
- FIUs "must display the exact purpose text as provided in the template" [V].
- Purpose 102's text is recalled as "Customer spending patterns, budget or other reportings" (ReBIT spec; unverified this session).

**Deposit transaction schema (`deposit.xsd`, Sahamati repo) [V]**
- `Account` attributes: `maskedAccNumber`, `linkedAccRef`, `version` (≤ 2.0).
- `Profile/Holders/Holder`: `name`, `dob`, `mobile`, `email`, `pan`, `address`, `nominee`, `ckycCompliance`. This is highly sensitive; do not request `PROFILE`.
- `Summary`: `currentBalance`, `currency`, `balanceDateTime`, `type` (`SAVINGS`/`CURRENT`), `branch`, `ifscCode`, `micrCode`, `openingDate`, `facility` (`OD`/`CC`), `currentODLimit`, `drawingLimit`, `status`.
- `Transactions` ("Details of all transactions that have been **posted**", with `startDate`/`endDate`) contains `Transaction`:
  - `txnId`
  - `type` ∈ `CREDIT`/`DEBIT`
  - `mode` ∈ `CASH`, `ATM`, `CARD`, `UPI`, `FT`, `OTHERS`
  - `amount` (`xs:float`)
  - `currentBalance`
  - `transactionTimestamp` (dateTime)
  - `valueDate`
  - `narration`
  - `reference` ("The cheque or reference no").
- **Schema v2.0.0** for Deposit/RD/TD has been active since 23 Jan 2025, with ecosystem cut-over June-July 2025: FIPs decommission v1 by 12 Jul 2025, FIUs by 27 Jul 2025 [V, Sahamati FAQ]. It changes mandatory/optional status, adds and deletes fields, and updates enums. The exact v2 field deltas could not be fetched (ReBIT site blocked). Re-check `txnId`, `narration` and `reference` semantics against v2 before building the parser.

**Credit card schema (`others_creditcard.xsd`) [V]**
- `Summary`: `currentDue`, `lastStatementDate`, `dueDate`, `previousDueAmount`, `totalDueAmount`, `minDueAmount`, `creditLimit`, `cashLimit`, `availableCredit`, `loyaltyPoints`, `financeCharges`.
- `Card`: `cardType` (`MASTER_CARD`, `VISA`, `RUPAY`, `OTHERS`), `maskedCardNumber`.
- `Transaction`: `txnId`, `txnType`, `txnDate`, `amount`, `valueDate`, `narration`, `statementDate`, **`mcc`**, `maskedCardNumber`.
- Card `dueDate`/`totalDueAmount` are useful PRE-SPEND obligations. The `mcc` is a rare structured category signal in India.

**Other FI types [V].** AIF, bonds, CDs, CIS, commercial paper, credit card, debentures, deposit, EPF, equities, ETF, government securities, IDR, InvIT, insurance, mutual funds, NPS, PPF, REIT, recurring deposit, SIP, term deposit, ULIP. SIP/MF/RD data helps classify investment debits as transfers rather than spending.

**Windows and latency.**
- POST-SPEND only (posted-only).
- On-demand pulls, bounded by the frequency ceiling: at most 45 per calendar month under purpose 102.
- Fetch time and FIP success rates vary by bank (Sahamati publishes FIP metrics; numbers unverified).
- PRE-SPEND context from balances and card dues.

**Coverage.** India only. Most major banks act as FIPs (unverified count). Adoption figures (billions of accounts "AA-enabled", tens to hundreds of millions of consents) could not be verified this session; take them from Sahamati's dashboard.

**Access.**
- The FIU must be "registered with and regulated by any financial sector regulator" (RBI Master Direction NBFC-AA 2016; unverified this session). BRAKE as an unregulated app therefore needs one of:
  - (a) a regulated FIU partner (NBFC, SEBI-registered investment adviser, etc.) that owns the purpose and data, with BRAKE as its technology provider. Purpose fidelity and data-life rules then bind both.
  - (b) its own regulated status.
  - (c) an AA's own "self-view" style app or a regulated partner's front-end (structures unverified).
- Integration goes through an AA or TSP. Setu (Pine Labs) and Finvu are FIU-integration routes (Finvu named as an AA in Sahamati's repo [V]; others such as OneMoney and Anumati are unverified).
- Fair-use template compliance is mandatory.
- DPDP Act 2023 and its Rules apply (status of the Rules unverified).

**Privacy.** Strongest consent model of any rail. It is purpose-bound, time-boxed, frequency-capped and revocable in the AA app, with encryption to the FIU. Use `DataFilter`/`consentTypes` to minimise: request `SUMMARY` + `TRANSACTIONS`, never `PROFILE`.

**Reliability and failure modes.**
- FIP downtime and slow fetches; FIStatus `TIMEOUT`/`DENIED`.
- No pending state.
- Free-text `narration` (UPI narrations commonly embed the payee VPA and an RRN, but formats differ per bank; unverified).
- Float amounts.
- Data-life purges that break naive history-based features.
- Consent expiry after at most 1 year (needs re-consent UX).

**Dedup keys.**
- `txnId` (namespace: FIP + `linkedAccRef`).
- `reference` (cheque/UTR/RRN when the bank populates it).
- UPI RRN parsed from `narration` → `rail_reference` (joins SMS/notification alerts that quote the same RRN).
- `maskedAccNumber` last 4 digits.
- `transactionTimestamp` + amount.

**Observation.**
- `kind: money_movement`, `stage: posted`.
- `rail` from `mode` (UPI→upi, CARD→card, FT→bank_transfer).
- `merchant.raw = narration`, with handle/VPA parsed. Merchant confidence 0.4-0.8 depending on parse.
- `balance_snapshot` from `currentBalance`.
- Amount/direction confidence 0.99.

**Provenance.** "From your HDFC Bank statement shared through your Account Aggregator consent (fetched today 10:05)."

**Recommendation: `next`** (with a parallel `research` track on the FIU partner structure). It is the highest-quality posted ledger in India, but regulation gates it. The brief's User A gets near-real-time awareness from notifications/SMS anyway. AA then adds completeness, correction and transfer/investment disambiguation.

### 6. UK Open Banking AIS (OBIE Read/Write v4.0.1) - id `uk-open-banking-ais`

**Endpoints [V].** `/account-access-consents`, `/accounts`, `/balances`, `/transactions`, `/standing-orders`, `/direct-debits`, `/scheduled-payments`, `/beneficiaries`, `/statements`, `/party`, `/products`, `/offers`.

**Consent [V].**
- `Permissions[]`, e.g. `ReadAccountsBasic`, `ReadBalances`, `ReadTransactionsBasic|Detail|Credits|Debits`, `ReadStandingOrdersDetail`, `ReadDirectDebits`, `ReadScheduledPaymentsDetail`, `ReadPAN`.
- `ExpirationDateTime` (open-ended if absent).
- `TransactionFromDateTime`, `TransactionToDateTime`.

**`OBTransaction6` [V]**
- Identity: `TransactionId` ("unique and immutable"), `TransactionReference` ("may… be the FPID in the Faster Payments context"), `StatementReference`.
- Direction and status: `CreditDebitIndicator`; `Status` ∈ `BOOK`, `PDNG`, `FUTR`, `INFO`, `RJCT`; **`TransactionMutability`** ∈ `Mutable`/`Immutable`.
- Dates and amounts: `BookingDateTime`, `ValueDateTime`, `Amount`, `ChargeAmount`, `CurrencyExchange`.
- Description and codes: `TransactionInformation`, `BankTransactionCode` {`Code`,`SubCode`}, `ProprietaryBankTransactionCode`.
- `Balance` (after transaction).
- `MerchantDetails` {`MerchantName`, `MerchantCategoryCode`}.
- `CardInstrument` {`CardSchemeName`, `AuthorisationType` ∈ `ConsumerDevice`,`Contactless`,`None`,`PIN`, `Name`, `Identification`}.
- Parties: `CreditorAccount`/`DebtorAccount` (incl. `Proxy`), `CreditorAgent`/`DebtorAgent`, `UltimateCreditor`/`UltimateDebtor`.
- Purpose codes: `CategoryPurposeCode`, `PaymentPurposeCode` (ISO 20022).

**Recurring obligations [V].**
- Standing orders: `NextPaymentDateTime`, `NextPaymentAmount`, `LastPaymentDateTime`, `FinalPaymentAmount`, `NumberOfPayments`, `StandingOrderStatusCode`.
- Direct debits: `DirectDebitId`, `Name`, `DirectDebitStatusCode`, `PreviousPaymentDateTime`, `PreviousPaymentAmount`, `MandateRelatedInformation`.
- Scheduled payments: `ScheduledPaymentDateTime`, `ScheduledType`, `InstructedAmount`, `CreditorAccount`.

**No push for new transactions [V].** The OBIE event-notification spec defines only `urn:uk:org:openbanking:events:resource-update`, so AIS is poll-based.

**Windows.** POST-SPEND. Polling is constrained by the RTS rule of ≤ 4 unattended accesses per 24 h (onshored EU rule; unverified for the UK specifically). PRE-SPEND context comes from standing orders, DDs and scheduled payments.

**Coverage.** All CMA9 banks plus many others. Usage grew to more than 10 million users by 2024 (unverified).

**Access (unverified details).**
- Become a registered AISP (RAISP) under the Payment Services Regulations 2017.
- Or become an agent of an authorised AISP (TrueLayer, Plaid UK, Tink, Yapily and others offer this).
- Or receive data as a client where the aggregator is the AISP of record.
- The FCA perimeter question (who "provides" AIS to the user) must be answered with counsel.

**Re-authentication.**
- FCA PS21/19 (Nov 2021) removed bank-side 90-day SCA for AIS through AISPs and replaced it with the AISP reconfirming consent with the user every 90 days (in force 30 Sept 2022; unverified).
- Whether the FCA has since relaxed the 90-day reconfirmation (2025-2026) is unverified: see Open questions.

**Dedup keys.** `TransactionId`, `TransactionReference` (FPID), `MerchantDetails` + `CardInstrument.Identification` (masked PAN), `BookingDateTime`.

**Observation.** As for Plaid. `PDNG` maps to pending; `BOOK` + `Immutable` to posted. `FUTR` becomes an obligation observation, not spending.

**Provenance.** "From your Monzo account via Open Banking (connected through TrueLayer), booked 3 Oct."

**Recommendation: `next`** (UK launch), via an aggregator's licence or agency. Commercially, TrueLayer or Plaid UK are the shortlist.

### 7. UK Variable Recurring Payments - id `uk-open-banking-vrp`

**What it is.** OBIE VRP v4.0.1 `ControlParameters` include `VRPType` ∈ `UK.OBIE.VRPType.Sweeping` / `UK.OBIE.VRPType.Other`, `MaximumIndividualAmount` and `PeriodicLimits` [V]. Plaid's institutions API exposes `supports_commercial_payment_consents`, "whether the institution supports commercial variable recurring payment (cVRP) consents" [V]. So cVRP was live at some institutions by 2026. Scope and phasing of the national cVRP rollout are unverified.

**Relevance to BRAKE.** A *write* capability, not a signal. Example: an opt-in "move what I didn't spend to savings" sweep, a positive-framing intervention.

**Recommendation: `later`.** It requires PISP permissions and raises consumer-duty questions.

### 8. EU PSD2 AIS (Berlin Group NextGenPSD2, STET, national standards) - id `eu-psd2-ais`

**Data.**
- A bank implementation of the Berlin Group OpenAPI (Consorsbank/BNP Paribas/DAB, v1.3.6) obtained this session exposes `transactionDetails` with `transactionId`, `endToEndId`, `mandateId`, `bookingDate`, `valueDate`, `transactionAmount`, `creditorName`, `creditorAccount`, `debtorName`, `debtorAccount`, `remittanceInformationUnstructured`, `proprietaryBankTransactionCode`.
- Lists are split into `booked`/`pending` according to `bookingStatus` ∈ `booked`/`pending`/`both`.
- Consent: `recurringIndicator`, `validUntil`, `frequencyPerDay` ("greater equal to one and less equal to 4") [V].
- The full Berlin Group schema has more (e.g. `entryReference`, `bankTransactionCode`, `balanceAfterTransaction`; unverified). **Banks implement subsets**, which is a normalisation pitfall in itself.

**Rules.**
- RTS (Delegated Reg. 2018/389) Art. 36(5) caps unattended AIS at 4 times per 24 h (unverified this session, but consistent with the spec limit [V]).
- Delegated Reg. 2022/2360 made the AIS SCA exemption mandatory with **180-day** renewal, applying from 25 Jul 2023 (unverified this session). Plaid's EU Items carry `consent_expiration_time` and `PENDING_EXPIRATION` [V].

**PSD3/PSR and FiDA as of 2026 (unverified).**
- Council and Parliament reached a provisional agreement on PSD3 + PSR in late Nov 2025. Formal adoption and an application date around 18-21 months after entry into force put practical effect in 2027-2028.
- Expected AIS changes: bank-provided permission dashboards, stronger anti-obstruction rules, and a revised SCA-renewal approach.
- FiDA (Financial Data Access, proposed June 2023) stalled in trilogue, with Commission signals in 2025 about narrowing or withdrawing it. Status in Oct 2026 unknown.

**Access.** AISP registration with a home NCA plus passporting, or acting as an agent of a licensed AISP / using "licence-as-a-service" from Tink, Salt Edge, TrueLayer or Plaid (unverified specifics). Professional indemnity insurance is required for AISP registration (unverified).

**Recommendation: `next`** for EU via an aggregator. Do not integrate banks directly.

### 9. Brazil Open Finance (Open Finance Brasil) - id `brazil-open-finance`

**Consents API v3.3.0 [V].**
- Permissions include `ACCOUNTS_READ`, `ACCOUNTS_BALANCES_READ`, `ACCOUNTS_TRANSACTIONS_READ`, `ACCOUNTS_OVERDRAFT_LIMITS_READ`, `CREDIT_CARDS_ACCOUNTS_READ`, `CREDIT_CARDS_ACCOUNTS_BILLS_READ`, `CREDIT_CARDS_ACCOUNTS_BILLS_TRANSACTIONS_READ`, `CREDIT_CARDS_ACCOUNTS_TRANSACTIONS_READ`, loans/financings and others.
- `expirationDateTime` is omitted for **indefinite** consents.
- Status goes `AWAITING_AUTHORISATION` → `AUTHORISED`, or `REJECTED` after 60 minutes.
- Renewals via `POST /consents/{consentId}/extends`.
- `isLinked` flags the "Jornada Otimizada" (optimised journey).

**Accounts API v2.4.2 [V].**
- `/accounts/{id}/transactions` covers up to 12 months back and 12 months **forward**.
- `/transactions-current` covers 7 days back and 12 months forward.
- Fields:
  - `transactionId`: should be immutable but must at minimum follow per-type immutability rules.
  - `completedAuthorisedPaymentType` ∈ `TRANSACAO_EFETIVADA` (id now immutable), `LANCAMENTO_FUTURO` (future-dated; id may change), `TRANSACAO_PROCESSANDO` (processing; id may change).
  - `creditDebitType` ∈ `CREDITO`/`DEBITO`, `transactionName`.
  - `type` ∈ `TED`, `DOC`, `PIX`, `TRANSFERENCIA_MESMA_INSTITUICAO`, `BOLETO`, `CONVENIO_ARRECADACAO`, `PACOTE_TARIFA_SERVICOS`, `TARIFA_SERVICOS_AVULSOS`, `FOLHA_PAGAMENTO`, `DEPOSITO`, `SAQUE`, `CARTAO`, `ENCARGOS_JUROS_CHEQUE_ESPECIAL`, `RENDIMENTO_APLIC_FINANCEIRA`, `PORTABILIDADE_SALARIO`, `RESGATE_APLIC_FINANCEIRA`, `OPERACAO_CREDITO`, `OUTROS`.
  - `transactionAmount` {`amount`, `currency`}, `transactionDateTime`.
  - **`partieCnpjCpf`** is mandatory for payment transactions since 2 May 2023 (IN BCB 371). Also `partiePersonType`, `partieCompeCode`, `partieBranchCode`, `partieNumber`, `partieCheckDigit`.

**Why it matters to BRAKE.**
- Counterparty CPF/CNPJ gives the best transfer-vs-spending signal of any regime. A CPF equal to the user's own CPF means an own-account transfer; a CNPJ means a business, i.e. a merchant.
- `LANCAMENTO_FUTURO` is a native forward obligations feed.

**Windows.** POST-SPEND plus strong PRE-SPEND obligations. Latency is near-same-day for Pix (unverified).

**Access.** Receivers must be BCB-authorised institutions (unverified). The practical route is partnering with an authorised data receiver or platform (e.g. Belvo; unverified). Adoption metrics are unverified.

**Recommendation: `later`** (Brazil is not in the initial market set). Keep the adapter design compatible: mutable ids and future entries.

### 10. Australia Consumer Data Right (banking, NBL/BNPL) - id `australia-cdr`

**`BankingTransaction` fields [V]**
- `accountId`, `transactionId` (mandatory "through hashing if necessary").
- `isDetailAvailable`.
- `type` ∈ `DIRECT_DEBIT`, `FEE`, `INTEREST_CHARGED`, `INTEREST_PAID`, `OTHER`, `PAYMENT`, `TRANSFER_INCOMING`, `TRANSFER_OUTGOING`.
- `status` ∈ `PENDING`/`POSTED`.
- `description`, `postingDateTime`, `valueDateTime`, `executionDateTime`.
- `amount` ("Negative values mean money was outgoing"); `currency` (default `AUD`).
- `reference`, `merchantName`, `merchantCategoryCode`.
- BPAY `billerCode`/`billerName`/`crn`; `apcaNumber`.

The standard explicitly provides **no pending↔posted correlation** [V].

**Standards status [V].**
- v1.36.0 (2025-12-04, white-label brands).
- v1.35.0 (2025-07-29) incorporated the March 2025 Rules amendment covering non-bank lending (NBL) and BNPL.
- The obsolete Transaction Detail v2 can be retired after 7 Dec 2026.
- The standards index lists banking and energy API sets only.

**Access (unverified).** Become an accredited data recipient (ADR), operate as a CDR representative under a principal ADR (e.g. via Basiq), or use the trusted-adviser/insight disclosure pathways. Consents last up to 12 months, with deletion or de-identification obligations.

**Recommendation: `later`.**

### 11. US bank APIs / FDX and Section 1033 - id `us-fdx-bank-apis`

**Mechanism.** Large US banks expose FDX-based APIs to aggregators (Plaid, MX, Finicity, Yodlee) and through Akoya's network, not to individual apps (unverified).

**1033 status.**
- CFPB finalised the Personal Financial Data Rights rule in Oct 2024, with staggered compliance from 2026 to 2030.
- Banks sued in E.D. Kentucky.
- In 2025 CFPB began reconsidering the rule (ANPR, Aug 2025), and compliance was stayed or enjoined pending reconsideration.
- In July 2025 JPMorgan moved to charge aggregators for data access, followed by bilateral deals (all unverified this session).
- Primary-spec evidence [V]: Plaid's Sept-2026 OpenAPI says its 1033 reauthorization field is "not currently used. Plaid may enable this field in the future if 1033-related expiration begins to be enforced". 1033 consent fields (`consented_use_cases`, `consented_data_scopes`) already exist.

**Implication.** Do not plan on a free, guaranteed, rule-based right of access in 2026-2027. Access cost may rise through aggregator pricing.

**Recommendation: `avoid`** for direct integration; consume through Plaid/MX.

### 12. Canada consumer-driven banking - id `canada-consumer-driven-banking`

**Status (unverified).**
- The Consumer-Driven Banking Act was enacted in 2024 (Budget Implementation Act, Bill C-69).
- Budget 2025 proposed completing the framework, with the Bank of Canada as overseer, phase-1 read access in 2026 and write access in 2027.
- No live consumer regime was confirmed this session.
- In the meantime, aggregators (Plaid supports `CA` [V]; Flinks and MX, unverified) use bank APIs and some credential-based access.

**Recommendation: `research`.** Serve Canada through Plaid until the regime goes live.

### 13. Singapore SGFinDex - id `singapore-sgfindex`

MAS plus the Smart Nation office. Singpass-consented data sharing among participating banks, insurers and government agencies (CPF, HDB, IRAS), viewed in participating FIs' apps and MyMoneySense (unverified). It is not open to third-party fintechs.

**Recommendation: `avoid`.** Singapore users need device, email and manual sources.

### 14. Saudi Arabia (SAMA Open Banking Framework) and UAE (CBUAE Open Finance) - ids `saudi-open-banking`, `uae-open-finance`

**Saudi Arabia (unverified).** SAMA published an AIS framework (2022) and a PIS framework (2023), with a regulatory sandbox and licensing for fintechs.

**UAE (unverified).** CBUAE issued an Open Finance Regulation (2024) with a central "Al Tareq"/Nebras infrastructure, licensing Open Finance service providers, and a rollout from 2025.

Coverage via global aggregators is thin. Both markets have significant expat populations, which suits BRAKE's international ambition.

**Recommendation: `research`.**

### 15. Japan (Electronic Payment Intermediary registration) - id `japan-bank-api-episp`

**Status (unverified).** The 2017 Banking Act amendment (in force June 2018) requires registration with the FSA as an electronic settlement intermediary (電子決済等代行業) and contracts with each bank for read ("参照系") APIs. Banks may charge fees. Money Forward and Moneytree are incumbents and offer B2B data platforms.

**Recommendation: `research`** (partner route).

### 16. Mexico (Ley Fintech Art. 76) - id `mexico-open-finance`

**Status (unverified).** The law (2018) mandates open APIs, but secondary rules for transactional data were not issued. Aggregators such as Belvo rely on consented credential-based access and bank partnerships.

**Recommendation: `research`/`later`.** Avoid credential sharing.

### 17. Aggregator landscape (beyond Plaid)

| Aggregator (id) | Markets | Client licensing model | Notable data features | BRAKE fit | Verification |
|---|---|---|---|---|---|
| TrueLayer (`truelayer-data-api`) | UK, EU | AISP/PISP; agent and "unregulated client" models | Data API: accounts, balance, `transactions`, separate `transactions/pending`, `standing_orders`, `direct_debits`, cards; fields incl. `transaction_id`, `normalised_provider_transaction_id`, `provider_transaction_id`, `transaction_classification`, `merchant_name`, `running_balance`; webhooks; VRP | **next** (UK primary) | unverified (docs blocked) |
| Tink (`tink-data`) | EU/UK (Visa-owned) | licensed PI; licence-as-a-service | broad PSD2 coverage, enrichment/categorisation, account check, income | **next** (EU option) | unverified |
| Salt Edge (`salt-edge-account-information`) | 50+ countries claimed | licensed AISP in EU/UK; partner programme for unlicensed clients | wide but uneven coverage; screen-scraping in some markets | later | unverified |
| GoCardless Bank Account Data (`gocardless-bank-account-data`) | EU/UK (ex-Nordigen) | GoCardless as AISP | Berlin-Group-like booked/pending lists, `requisition`/agreement model, low cost historically | **avoid** for new builds: official SDKs "no longer actively updated or maintained" [V]; new-signup status unverified | partly [V] |
| MX (`mx-platform`) | US/CA | data access + enrichment contracts | transaction `status` (POSTED/PENDING), `category`/`top_level_category`, `merchant_guid`, `merchant_category_code`, `is_subscription`, `is_recurring`, `is_bill_pay`, `is_direct_deposit`, `transacted_at` vs `posted_at`; `/users/{user_guid}/repeating_transactions` with `recurrence_type` (`EVERY_MONTH`…) and `predicted_occurs_on` [V] | later (US redundancy) | [V] spec |
| Mastercard Open Banking/Finicity (`mastercard-open-banking-finicity`) | US/CA, UK/EU (via Aiia) | aggregator contract | strong in lending/verification | later | unverified |
| Envestnet Yodlee (`yodlee`) | global incl. US; Indian AA licence via an affiliate (unverified) | aggregator contract | long-tail coverage, older stack; ownership changed in 2025 (unverified) | later | unverified |
| Akoya (`akoya-data-access-network`) | US | network for licensed aggregators/fintechs; API-only, no scraping, FDX | bank-owned "data access network" | avoid direct (reach it through aggregators) | unverified |
| Belvo (`belvo`) | Brazil, Mexico, Colombia | receiver under Open Finance Brasil; credential connectors elsewhere | Pix payments, enrichment | later (LatAm) | unverified |
| Basiq (`basiq`) | Australia | ADR with CDR-representative model | CDR + legacy connectors, enrichment | later (AU) | unverified |
| Setu / Finvu / OneMoney / Anumati (`india-aa-providers-and-tsps`) | India | AAs (Finvu, OneMoney, Anumati) and TSP/FIU tooling (Setu) | AA consent and FI fetch plumbing; all subject to fair-use rules [V] | **next** with a regulated FIU | partly [V] |

---

## Three-window classification

| Source | Pre-spend | In-spend | Post-spend | Typical latency | Notes |
|---|---|---|---|---|---|
| plaid-transactions | context (pace, payday, history) | no | **yes** (pending + posted) | pending: hours; posted: 1-3 business days; polls 1-4×/day [V] + `/transactions/refresh` | best pending→posted linkage; webhook-driven |
| plaid-recurring-transactions | **yes** (`predicted_next_date`) | no | yes (subscription id) | daily-ish | add-on; ≥180 days history recommended [V] |
| plaid-balance | **yes** (affordability) | marginal (user-invoked check) | yes (state update) | cached ~daily; real-time <10-30 s per call [V] | real-time is pay-per-call |
| plaid-enrich | no | no | yes (enriches other sources) | sync API | sends data off-device |
| india-account-aggregator | context (balances, card dues) | no | **yes** (posted only) | on-demand; ≤45 pulls/month under purpose 102 [V] | data life 31 days; regulated FIU needed |
| uk-open-banking-ais | **yes** (standing orders, DDs, scheduled) | no | **yes** | poll; ≤4 unattended/day (unverified for UK) | no transaction push events [V] |
| uk-open-banking-vrp | action (sweeps) | no | no | n/a | write capability, later |
| eu-psd2-ais | context | no | **yes** | poll; ≤4 unattended/day [V spec] | 180-day re-auth; bank subsets |
| brazil-open-finance | **yes** (`LANCAMENTO_FUTURO`, 12 months forward) | no | **yes** | near-real-time for Pix (unverified) | mutable ids until `TRANSACAO_EFETIVADA` |
| australia-cdr | context | no | **yes** | poll | no pending↔posted correlation [V] |
| us-fdx-bank-apis | context | no | yes | via aggregators | 1033 not enforced (2026) |
| canada-consumer-driven-banking | - | - | (future) | - | not live (unverified) |
| singapore-sgfindex | - | - | - | - | closed to third parties |
| saudi / uae open finance | context | no | yes | poll | licensing unclear |
| japan-bank-api-episp | context | no | yes | poll | registration required |
| mexico-open-finance | - | - | limited | - | no transactional mandate |
| truelayer / tink / salt-edge / mx / finicity / yodlee / belvo / basiq | as their underlying regime | no | yes | regime-bound | aggregator choice per market |

**Conclusion.** No account-data rail provides IN-SPEND sensing. In fusion they serve as the *ledger of record*: they confirm or correct alert-derived candidates, catch misses, resolve transfers across linked accounts, and feed obligations and balances into PRE-SPEND context.

---

## Implications for BRAKE architecture

### Adapter design

1. **One `LedgerAdapter` contract, many providers.**
   - Every provider exposes the same operations: `link()` (consent UX handoff), `sync(cursor) → {added, modified, removed, nextCursor}`, `onProviderEvent(webhook)`, `consentStatus()` and `disconnect()`.
   - Providers without a native delta API (AA, UK OB, CDR, Brazil) get a synthetic cursor: the last fetched range plus a content hash per `txnId`.
   - Plaid maps 1:1.
2. **Webhooks are triggers, not data.** `SYNC_UPDATES_AVAILABLE`, `RECURRING_TRANSACTIONS_UPDATE` and AA `/FI/Notification` (`FIStatus: READY`) only schedule a pull. Keep a timer-based fallback poll, because webhooks can be missed [V: `transactions_update_status` exists for recovery].
3. **Tombstones are first-class.**
   - `removed[]` (Plaid), disappearing `PDNG` rows (UK) and `TRANSACAO_PROCESSANDO` ids that change (Brazil) must retract observations, not delete history.
   - Use the observation model's reversibility (docs/architecture/fusion-and-reconciliation.md).
   - A removed pending without a posted successor becomes `cancelled`. A removed pending *with* a successor is superseded.
4. **Namespaced references.** Emit `provider_transaction_id` with namespace `plaid:{item_id}`, `aa:{fipId}:{linkedAccRef}`, `obie:{aspsp}:{AccountId}`, `cdr:{dataHolder}:{accountId}`, `ofb:{org}:{accountId}`. Emit `provider_pending_id` only where the provider asserts the link (Plaid). For all others, the posted record matches its pending predecessor through fuzzy scoring: same account, amount within tolerance, `authorized_date`/`executionDateTime`.
5. **Consent lifecycle lives in the adapter.**
   - Per-source expiry and re-consent nudges: Plaid `PENDING_EXPIRATION`/`PENDING_DISCONNECT` (7 days) [V]; AA `consentExpiry` (≤ 1 year under 102) [V]; EU 180 days; UK 90-day reconfirmation (unverified current rule); Brazil indefinite/extendable [V]; CDR ≤ 12 months (unverified).
   - On disconnect, purge provider tokens and that source's observations, then recompute candidates.
6. **Retention by source.** AA `DataLife` (31 days under 102; 7 days under CT019) [V] requires purging raw FI data. Design every ledger adapter so that:
   - raw payloads are never persisted beyond a short processing window;
   - only extracted observation facts and user assertions persist.
   - Whether *derived* facts outlive Data Life is a legal question: see Open questions.
7. **Server footprint.**
   - Aggregators need a backend: client secrets, `access_token`s, webhook endpoints, AA FIU private keys for decrypting FI data.
   - Proposal: a minimal relay that stores tokens in a KMS-backed vault and fetches deltas.
   - The relay then either (a) normalises server-side and forwards only observations (encrypted to the device key), or (b) forwards encrypted raw deltas for on-device normalisation.
   - The relay keeps no long-lived copy beyond cursors.

### Normalization pitfalls (cross-regime mapping)

| BRAKE field | Plaid | India AA (deposit) | UK OBIE v4 | AU CDR | Brazil OFB |
|---|---|---|---|---|---|
| provider id | `transaction_id` (new id on post) | `txnId` | `TransactionId` (immutable) | `transactionId` (may be hashed) | `transactionId` (mutable until `TRANSACAO_EFETIVADA`) |
| pending link | `pending_transaction_id` | none (posted-only) | `Status=PDNG` + `TransactionMutability` | **none guaranteed** | `TRANSACAO_PROCESSANDO` |
| direction | sign: **+ = outflow** | `type` DEBIT/CREDIT | `CreditDebitIndicator` | sign: **− = outgoing** | `creditDebitType` |
| amount type | JSON number | **`xs:float`** | string amount + currency | `AmountString` | number (2-4 decimals) |
| occurred at | `authorized_datetime` > `datetime` > `date` | `transactionTimestamp`; `valueDate` (date) | `BookingDateTime`, `ValueDateTime` | `executionDateTime`, `postingDateTime` | `transactionDateTime` |
| merchant | `merchant_name`, `merchant_entity_id`, `counterparties[]` (+confidence) | `narration` only | `MerchantDetails.MerchantName` | `merchantName` | `transactionName` + `partieCnpjCpf` |
| MCC | `merchant_category_code` (beta) | credit-card FI `mcc` | `MerchantCategoryCode` | `merchantCategoryCode` | n/a in accounts |
| rail | `payment_channel`, `payment_meta.payment_method`, `transaction_code` | `mode` (UPI/CARD/FT/ATM/CASH) | `BankTransactionCode`, `CardInstrument` | `type`, BPAY fields | `type` (PIX/TED/BOLETO/CARTAO…) |
| transfer hints | PFC `TRANSFER_*`, `LOAN_PAYMENTS`; counterparty `financial_institution`/`payment_app` | `mode=FT`; SIP/MF FI types | `CreditorAccount`/`DebtorAccount`, `CategoryPurposeCode` | `TRANSFER_INCOMING/OUTGOING` | `partieCnpjCpf` (own CPF ⇒ own transfer), `TRANSFERENCIA_MESMA_INSTITUICAO` |
| balance after | `running_balance` (sparse) | `currentBalance` (every row) | `Balance` | n/a | n/a |

Further pitfalls:
- **Date-only values.** Plaid `date`, AA `valueDate` and CDR value dates lack a time; mark `occurredAt` precision.
- **Timezones.** AA timestamps are IST in practice (unverified). Plaid `datetime` is ISO with Z. Never compare a date-only value against an alert timestamp without a ±1-day window.
- **Taxonomy versions.** PFC v1 vs v2 [V]; keep `{provider, taxonomy, version}` on every `CategoryHint`.
- **Cross-Item duplicates.** The same account linked twice through Plaid gives different ids [V]. The same account linked through both Plaid and an alternative aggregator is also duplicated. Deduplicate accounts first: institution + mask + currency + balance trajectory.
- **Credit-card double counting.** A card purchase appears on the card account, and the card bill payment appears on the checking account (Plaid `LOAN_PAYMENTS`; AA deposit row with the card issuer in the narration). Only the former is spending.

### Capability-registry facts (country × capability)

The capability ids follow `packages/capabilities/src/types.ts` (`data:plaid`, `data:open-banking-ais`, `data:account-aggregator`, …). All entries are `asOf: 2026-10-04`; citation numbers refer to References.

```yaml
US: { data:plaid: available [1], data:us-1033-rights: limited (not enforced per Plaid spec) [1], data:fdx-via-aggregators: available (unverified) }
CA: { data:plaid: available [1], data:open-banking-ais (regulated): emerging (unverified) }
GB: { data:plaid: available [1], data:open-banking-ais: available [12], data:open-banking-standing-orders-dd: available [12], pay:vrp-sweeping: available [13], pay:cvrp: emerging [1] }
EU (IE FR ES NL DE IT PL DK SE EE LT LV PT BE AT FI) + NO: { data:plaid: available [1], data:open-banking-ais: available (PSD2), regime:psd3-psr: emerging (unverified), regime:fida: unknown (unverified) }
IN: { data:account-aggregator: available-with-regulated-FIU [5][8], data:plaid: unavailable [1], data:aa-purpose-102-max-fetches-per-month: 45 [8], data:aa-purpose-102-data-life-days: 31 [8] }
BR: { data:open-finance-br: available (authorised receivers) [16][17], data:future-dated-debits: available [16], data:plaid: unavailable [1] }
AU: { data:cdr-banking: available (ADR/representative) [14][15], data:cdr-nbl-bnpl: emerging [15], data:plaid: unavailable [1] }
SG: { data:sgfindex: unavailable-to-third-parties (unverified) }
SA: { data:open-banking-ais: emerging (unverified) }   AE: { data:open-finance: emerging (unverified) }
JP: { data:bank-api-episp: available-with-registration (unverified) }
MX: { data:open-finance-mx: limited (unverified) }
```

### Product consequences
- **User A** (India, Android): real-time from notifications/SMS; AA (when partnered) adds posted truth, balances, card dues and investment disambiguation.
- **User B** (US, iPhone): Plaid gives pending within hours and posted within days. Pre-spend comes from recurring streams and balance. In-spend sensing must come from stream 02/04 sources (FinanceKit, Wallet automations).
- **User C** (no linked account): unaffected; the ledger is an enhancement, never a dependency.

---

## Risks, policy constraints and ethical concerns

1. **Licensing and perimeter risk.**
   - India: BRAKE cannot lawfully be an FIU without regulation, and a "partner FIU" model must keep purpose, data life and display text intact [V fair-use].
   - UK/EU: presenting aggregated data as BRAKE's own service may itself be AIS, so counsel must confirm the agent vs client model.
2. **Regulatory flux in 2026.** Several rule sets are unsettled: US §1033 reconsideration and bank data-access fees (unverified details); PSD3/PSR application dates and AIS dashboard rules (unverified); FiDA (unverified); Canada's launch timing (unverified); UK smart-data and 90-day rules (unverified). The registry must carry `asOf` and citations, and `auditRegistry` must flag stale facts.
3. **Concentration and security.** A store of aggregator tokens is a high-value target. Mitigations: KMS-wrapped tokens, least-scope products, no `identity`/`auth`/`PROFILE` scopes, short raw-data retention, and per-source disconnect that actually revokes provider-side (`/item/remove`, AA consent revoke).
4. **Cost risk.** Per-Item monthly pricing (Plaid Transactions), per-call pricing (Balance) [V model; prices unverified], and potential pass-through of bank access fees. Free-tier users may not be economically linkable. Gate ledger linking by value, or let the user choose.
5. **Data-life conflicts.** AA's 31-day Data Life [V] conflicts with BRAKE's learning loop (regret patterns over months). Legal review is needed on whether derived, user-confirmed labels may be kept.
6. **Consent fatigue and dark patterns.** Re-consent cycles (AA ≤ 1 year, EU 180 days, UK 90-day reconfirmation) must be honest, not nagging. Never pre-tick extra scopes. Show exactly what each source contributes ("Linking HDFC lets BRAKE confirm amounts and spot transfers").
7. **Not becoming a credit bureau or lender.** Plaid's CRA/"Plaid Check" products are a separate regime (FCRA in the US) [V: separate `cra/*` endpoints]. BRAKE must not use ledger data for eligibility decisions or share it for advertising.
8. **Screen scraping.** Some aggregator connectors outside regulated APIs still use credentials (Mexico, parts of Canada and APAC; unverified). Treat credential-sharing connectors as `avoid` unless no API path exists and the user is clearly informed.
9. **Mis-classification harm.** Calling transfers, investments or card payments "spending" "destroys trust" (brief). Ledger data must feed transfer detection before any spending insight is shown.

---

## Open questions

1. **India FIU structure.** Which regulated-partner model (NBFC, SEBI RIA, other) lets BRAKE use purpose-102 data for nudges? Can BRAKE persist *derived* facts (categories, regret labels) beyond the 31-day Data Life?
2. **AA schema v2.** What are the exact Deposit v2.0.0 field changes (ReBIT release note), and does v2 standardise UPI RRN or counterparty fields in `reference`/`narration`?
3. **India adoption.** Current AA adoption: number of FIPs live for DEPOSIT, consent success rates, median FI-fetch latency. Source: the Sahamati dashboard, not verifiable this session.
4. **US.** What is the CFPB's §1033 rule status in Oct 2026 (revised proposal? new compliance dates?), and how are bank data-access fees affecting Plaid/MX pricing for consumer PFM apps?
5. **UK.** Has the FCA removed or relaxed the AISP 90-day reconfirmation since 2025? What is the cVRP rollout scope in 2026, and can a consumer app use sweeping VRP for savings nudges without PISP authorisation via a partner?
6. **EU.** PSD3/PSR publication and application dates. Does the PSR's permission dashboard give BRAKE a revocation event it can consume? Is FiDA alive?
7. **Plaid.** Is Recurring Transactions available outside US/CA? What do `/transactions/refresh` and Recurring cost? Is PFC v2's primary list compatible with BRAKE's taxonomy (fetch `pfc-taxonomy-all.csv`)?
8. **UK/EU vendor.** TrueLayer vs Tink vs Plaid UK on pending coverage, standing-order and direct-debit support, webhook reliability and agent-model terms.
9. **Canada.** Is the regime live in 2026 and accrediting third parties? Plaid vs Flinks coverage until then.
10. **Brazil.** Partner route and cost to receive Open Finance data as an unlicensed app.

---

## References

1. https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml - Plaid OpenAPI `2020-09-14_1.762.0` (current master as of Sept 2026). Supports: Transaction fields, sign convention, `pending`/`pending_transaction_id`; `/transactions/sync` params and limits; `SYNC_UPDATES_AVAILABLE`, `RECURRING_TRANSACTIONS_UPDATE`, `PENDING_EXPIRATION`, `PENDING_DISCONNECT`, `USER_PERMISSION_REVOKED`; 1-4 checks/day; `/transactions/refresh`; TransactionStream model; balance endpoints and latencies; PFC v1/v2 and the 3 Dec 2025 rule; `CountryCode` enum; `consent_expiration_time`; 1033 notes; `/transactions/enrich` input; cVRP flag; billing model (billed products vs pay-per-call).
2. https://raw.githubusercontent.com/plaid/plaid-openapi/master/CHANGELOG.md - Plaid schema changelog: `running_balance`, `merchant_category_code` (beta), `transactions:read` OAuth scope, `supports_commercial_payment_consents`, 1033 consent fields.
3. https://raw.githubusercontent.com/plaid/plaid-node/master/CHANGELOG.md - maps plaid-node 48.0.0 to OAS 1.762.0.
4. https://registry.npmjs.org/plaid - npm release timestamps (plaid-node 47.0.0 published 2026-09-01), dating the spec.
5. https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/specs/aa.yaml - AA API v1.1.2: ConsentDetail fields (`consentMode`, `fetchType`, `consentTypes`, `DataLife`, `Frequency`, `DataFilter`, `Purpose`), endpoints, FIStatus/sessionStatus, partial fetch, "consent… generated directly on application provided by AA".
6. https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/specs/fiu.yaml and https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/specs/fip.yaml - FIU/FIP endpoint sets.
7. https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/deposit/deposit.xsd - deposit FI schema (posted-only transactions; `txnId`, `type`, `mode`, `amount` xs:float, `currentBalance`, `transactionTimestamp`, `valueDate`, `narration`, `reference`; Summary and Holder fields). Also https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/credit_card/others_creditcard.xsd (card summary and `mcc`), https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/schemas/readme.md (FI type list), https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/readme.md (repo scope).
8. https://raw.githubusercontent.com/Sahamati/fair-use-implementation-guidelines-for-aa/main/README.md plus the files `AAs - Fair Use Implementation Guidelines.md`, `AAs - Consent Request Rules and Rule Matching Guidelines.md`, `AAs - FI-Request Rules and Rule Matching guidelines.md`, `FIUs - Fair Use Implementation Guidelines.md` and `FIPs - Fair Use Implementation Guidelines.md` in the same repo - purpose-code fair-use ceilings (frequency, data life, consent expiry, FI data range), 412 error handling, exact-purpose-text rule, Data Life purge semantics, Finvu named as an AA.
9. https://github.com/Sahamati - Sahamati GitHub organisation listing (fair-use, CX guidelines, `rahasya` Curve25519 library, FI schema v2 adoption repos).
10. https://github.com/Sahamati/AA-Ecosystem-FISchema-v2-Adoption and https://raw.githubusercontent.com/Sahamati/AA-Ecosystem-FISchema-v2-Adoption/main/FAQs%20on%20FI%20Schema%20Adoption.md - Deposit/RD/TD schema v2.0.0 (active 23 Jan 2025; FIP/FIU cut-over June-July 2025); SEBI and insurance schemas still v1.
11. https://raw.githubusercontent.com/Sahamati/documentation/main/frequently-asked-questions.md - SahamatiNet router context (minor).
12. https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/account-info-openapi.yaml - OBIE Account & Transaction API v4.0.1: endpoints, permissions, `OBTransaction6` fields, status and mutability codes, standing orders, direct debits, scheduled payments.
13. https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/vrp-openapi.yaml - VRP v4.0.1 control parameters and `OBVRPConsentType` (Sweeping/Other). Also https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/event-notifications-openapi.yaml (only `resource-update` events) and https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/README.md (spec index).
14. https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/slate/source/includes/obsolete/get-transaction-detail-v2.html.md - CDR `BankingTransaction` fields and enums; "no provision… to correlate a pending transaction with an associated posted transaction"; v2 retirement after 7 Dec 2026.
15. https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/slate/source/includes/changelog.md - CDR standards v1.36.0 (2025-12-04), v1.35.0 (2025-07-29, March 2025 Rules incl. NBL/BNPL). Also https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/slate/source/index.html.md (banking + energy API sets) and https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/README.md (DSB/ACCC/OAIC roles).
16. https://raw.githubusercontent.com/OpenBanking-Brasil/openapi/main/swagger-apis/accounts/2.4.2.yml - Open Finance Brasil Accounts API v2.4.2: transaction fields, `completedAuthorisedPaymentType`, `type` enum, `partieCnpjCpf` (IN BCB 371), 12-month back/forward windows, `transactions-current` 7-day window.
17. https://raw.githubusercontent.com/OpenBanking-Brasil/openapi/main/swagger-apis/consents/3.3.0.yml - Consents API v3.3.0: permissions, indefinite consents, `isLinked`, 60-minute rejection, extensions. Also https://raw.githubusercontent.com/OpenBanking-Brasil/openapi/main/README.md (repo scope).
18. https://raw.githubusercontent.com/mxenabled/openapi/master/openapi/mx_platform_api.yml - MX Platform API: TransactionResponse fields (`status`, `is_subscription`, `is_recurring`, `merchant_guid`, …) and `repeating_transactions` (`recurrence_type`, `predicted_occurs_on`).
19. https://raw.githubusercontent.com/nordigen/nordigen-python/master/README.md and https://pypi.org/pypi/nordigen/json - GoCardless Bank Account Data client "no longer actively updated or maintained"; last release 1.4.2 (2025-04-07); requisition/agreement flow.
20. WebSearch result set for "Plaid /transactions/sync pending_transaction_id SYNC_UPDATES_AVAILABLE webhook documentation" (pointing to https://plaid.com/docs/api/products/transactions/ and https://plaid.com/docs/transactions/sync-migration/; pages themselves blocked). Supports: webhook fires only after the first `/transactions/sync` call; `initial_update_complete`/`historical_update_complete` semantics.
21. A bank implementation of the Berlin Group NextGenPSD2 XS2A OpenAPI (Consorsbank / BNP Paribas Wealth Management / DAB, "1.3.6_2020-08-14"; it references https://www.berlin-group.org/nextgenpsd2-downloads). It was obtained earlier in this session from a GitHub-hosted copy whose exact URL was not retained. Supports: `frequencyPerDay` 1-4, `recurringIndicator`, `validUntil`, `bookingStatus`, and the `transactionDetails` subset. Treat as illustrative.
