# Transaction reconciliation, transfer-vs-spending and recurring detection

> **Research stream 10.** Scope: how BRAKE should (1) decide which observations from different sources describe the same financial event (multi-source record linkage); (2) handle pending-to-posted transitions, FX and timezones; (3) normalize merchants; (4) tell real spending apart from transfers, card-bill payments, wallet loads, investments, loan payments, refunds, reimbursements and cash; (5) detect recurring payments and subscriptions; and (6) decide whether subscription intelligence belongs in the MVP. This document is the evidence base for `docs/architecture/fusion-and-reconciliation.md`.
>
> **Date:** 2026-10-04. Every time-sensitive claim carries an "as of" date or a spec version.
>
> **How this was researched:** The shared web-search budget ran out early in this session, and the egress proxy blocked most vendor and regulator websites (plaid.com, npci.org.in, rbi.org.in, consumerfinance.gov, developer.visa.com, docs.ntropy.com, arxiv.org, wikipedia.org). To compensate I used **machine-readable primary specifications published on GitHub by the standard owners**: Plaid's OpenAPI (`2020-09-14_1.762.0`), UK Open Banking Read/Write API v4.0.1, Australia's Consumer Data Standards v1.36.0, Open Finance Brasil accounts v2.4.2 and payments v1.2.0, and Sahamati's Account Aggregator XSDs. I also used Apple's FinanceKit documentation JSON, the Splink record-linkage docs, vendor SDKs and OpenAPI files (Ntropy SDK 5.6.0; a third-party mirror of Spade's OpenAPI), and two open-source personal-finance engines whose source shows tested heuristics (Sure, a Maybe Finance fork; Actual Budget). Anything I could not check against a primary source is marked **(unverified)**.
>
> **Fact-check pass (2026-10-04):** an adversarial review re-fetched the GitHub-hosted primary specifications and source files cited below and corrected several claims. The main ones: Plaid `running_balance` is flagged `x-hidden-from-docs`; India AA Deposit schema v2.0.0 has replaced v1.x; ISO `CCRD` does not reliably mean "credit-card bill payment"; the Pix `EndToEndId` minute has a ±12 h tolerance; UK OB `TransactionId` is optional; and the per-ASPSP Berlin Group facts come from 2019–2020 snapshots. Vendor and regulator websites (plaid.com, rbi.org.in, npci.org.in, specifications.rebit.org.in, consumerfinance.gov, ftc.gov, docs.ntropy.com, developer.visa.com) were still blocked, so claims that rest only on them remain **(unverified)**. See the **Verification log** at the end.

## Key takeaways for BRAKE

1. **No ecosystem guarantees an ID join from a pending record to its posted record.** Plaid's spec (`2020-09-14_1.762.0`) populates `pending_transaction_id` only "where applicable" and warns that "not all institutions provide pending transactions". Plaid's docs reportedly add that the link exists only when Plaid matches the pair, and that authorization holds can vanish **(docs page not fetched; unverified)**. UK Open Banking v4.0.1 has no field linking a pending entry to its booked entry. Australia's CDR says outright that there is "no provision in the standards to guarantee the ability to correlate a pending transaction with an associated posted transaction". In Brazil, `transactionId` may change until the record reaches `TRANSACAO_EFETIVADA`. India's AA deposit schema carries posted transactions only. **So BRAKE must treat pending-to-posted as a fuzzy *supersede* match with retraction semantics, not as a key lookup.**
2. **Strong cross-source keys exist, but each belongs to one rail and is often left blank:**
   - UPI RRN (12 characters);
   - Pix `EndToEndId` (32 characters, with the UTC minute embedded);
   - UK `TransactionReference` (which may carry the Faster Payments FPID);
   - SEPA `endToEndId` / `mandateId` / `creditorId`;
   - Plaid `transaction_id`, AA `txnId`, merchant order IDs.

   Implementations of the same standard populate different subsets. FinecoBank's NextGenPSD2 API documents `endToEndId` and `entryReference` as "currently not used". Key availability therefore has to be a **per-institution** registry fact, not a per-country one.
3. **"Balance after transaction" is an under-used matching key.** It is *required* (`currentBalance`, documented as "Available balance") in the deposit XSD hosted in Sahamati's GitHub repository. That XSD may be the v1.x schema: ReBIT's Deposit FI schema v2.0.0 replaced v1.x in production in July 2025 and changed which fields are mandatory, so whether the field is still mandatory is **(unverified)**. It is optional in UK OB (`Balance`, typed with an ISO balance-type code such as `ITAV` or `ITBD`). Plaid has `running_balance` (posted records only, when the institution provides it), but the field is flagged `x-hidden-from-docs: true` in the spec, so it is not part of the public API and its availability to BRAKE is **(unverified)**. Balance-after is also commonly present in Indian SMS and app alerts **(unverified per bank)**. An equal balance-after on the same account is near-decisive evidence that two observations are the same event. A balance chain also shows when events are missing or duplicated.
4. **Avoiding over-merges matters more than finding every match.** Use Fellegi–Sunter scoring (m/u probabilities, additive log-weights, three decision zones), with:
   - **term-frequency-adjusted amount weights**, because round amounts are weak evidence;
   - **complete-linkage assignment**: a new observation must be compatible with *every* member of a candidate, with no connected-components clustering;
   - a **one-event-per-source** constraint;
   - **bridge detection** for retroactive splits.

   The "clerical review" zone becomes a budgeted, one-tap user question.
5. **Transfer detection rests on equal-and-opposite matching between instruments the user owns, plus single-leg heuristics.** Open-source evidence: Sure auto-matches transfers at exact amount and same currency within ±4 days, widens to 30 days in its manual dialog, and allows a ±10% FX band only when both accounts are provider-linked. It assigns pairs greedily, one-to-one, ranking exact matches before FX guesses. For single-leg cases the signals are:
   - Plaid PFC (`TRANSFER_*`, `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`) and counterparty `type: payment_app`;
   - ISO 20022 category purpose codes in UK OB v4 (`GP2P`, `MP2P`, `MP2B`, `SALA`, `CASH`, `SWEP`, `TOPG`). `CCRD` is ambiguous: the code set defines it as "related to a payment of credit card" and has a sibling `DCRD`, "payment of debit card", which suggests both mark payments *made with* a card rather than card-bill settlements. Treat `CCRD` as a weak hint only **(semantics unverified)**;
   - Brazil's counterparty `partiePersonType` together with the counterparty's CPF/CNPJ;
   - self-names and own account masks in narrations.

   **When none of these resolves the type, the movement is "unclassified outflow": kept out of discretionary pace and asked about once per counterparty.**
6. **Credit-card bills:** count card purchases once and never count the bill payment. If the card account is not connected, show the payment as "card spending, unitemized" outside discretionary pace and invite the user to connect the card. India adds two traps: UPI payments drawn on RuPay credit cards (the UPI data model has a payer account type `CREDIT`) and EMI conversions **(unverified pattern)**.
7. **UPI P2P vs P2M is decided inside the network** (payee persona `PERSON`/`ENTITY`, payee MCC in the UPI data model), but third-party apps do not see that decision. BRAKE has three ways in:
   - the QR/intent `mc` field, when BRAKE scanned or launched the payment;
   - VPA and narration heuristics;
   - per-counterparty learning.

   Small merchants paid on personal VPAs are the dominant failure case.
8. **Recurring detection should be BRAKE's own on-device, provider-agnostic engine.** Shape:
   - group by merchant/counterparty key and currency;
   - cluster amounts within about 7.5% of the running mean. Sure uses 7.5% of the cluster's running mean. Actual Budget also uses 7.5%, but of the reference transaction's amount (`getApproxNumberThreshold`), not of a running mean;
   - use calendar-aware cadence with ±2-day day-of-month tolerance on a circular calendar;
   - use statuses that mirror Plaid's (`EARLY_DETECTION`, then `MATURE` at 3 or more occurrences, or 2 for annual streams, then `TOMBSTONED`).

   Plaid recurring streams and Ntropy/Spade recurrence are hints only. Plaid's streams are per account, have no quarterly enum, and Plaid has discontinued user modification of streams (`is_user_modified` is "always `false`").
9. **Subscription intelligence: only the part needed for correct spending interpretation belongs in the MVP.** That part is recurring obligations kept out of discretionary pace, plus "upcoming known bills". Renewal nudges, price-increase, free-trial, duplicate and dormant detection belong in **next**:
   - trials and price changes need email or mandate signals;
   - App Store / Google Play / PayPal descriptors hide the underlying service **(descriptor patterns unverified)**;
   - "dormant" needs usage data BRAKE does not have.
10. **Normalize merchants on-device first.** The enrichment vendors are B2B and mostly North-American:
   - Plaid Enrich: location schema is US/CA, 100 transactions per request;
   - Spade: real-time card enrichment for issuers;
   - Ntropy: person/organization counterparty plus intermediaries plus recurrence groups.

   Treat them as later, consented, long-tail options. Splitwise's self-serve API "may not be used in connection with any fee-based service", so shared-expense import needs a commercial licence.

---

## Sources investigated

Sections A–D cover the external sources (what each contributes *to reconciliation*). Detailed access, policy and coverage analysis for Plaid, AA, SMS, notifications and Gmail lives in their own research streams. Section E covers BRAKE-internal mechanisms; they are assessed with the same template because they are the "sources" of transfer, refund and recurring inferences.

### A. Ledger and aggregator feeds

#### A1. Plaid Transactions — `plaid-transactions`

- **What it is:** Plaid's cursor-based ledger feed. `/transactions/sync` returns `added`, `modified` and `removed` arrays plus `next_cursor` and `has_more`. A cursor obtained after all pages are pulled stays valid for at least one year. Status is reported via `transactions_update_status` (`NOT_READY`, `INITIAL_UPDATE_COMPLETE`, `HISTORICAL_UPDATE_COMPLETE`) [1].
- **Data actually available** (OpenAPI `2020-09-14_1.762.0`, as of 2026-10-04) [1]:
  - IDs and state: `transaction_id`, `account_id`, `pending`, `pending_transaction_id`.
  - Amount: `amount` is positive for outflow and negative for inflow. Refunds, credit-card payments and direct deposits are negative.
  - Currency: `iso_currency_code` or `unofficial_currency_code`.
  - Dates:
    - `date`: for pending records the date the transaction occurred; for posted records the date it posted;
    - `authorized_date` and `authorized_datetime`;
    - `datetime`, "returned for select financial institutions … may contain default time values (such as 00:00:00)".
  - Merchant: `merchant_name`, `merchant_entity_id` (stable, maps to the brand rather than the store), `name` (legacy), and `original_description` (only when `options.include_original_description=true`).
  - `payment_channel`: `online`, `in store`, `other`.
  - `personal_finance_category`: `primary`, `detailed`, `confidence_level` and `version`. `confidence_level` values: `VERY_HIGH` ">98%", `HIGH` ">90%", `MEDIUM`, `LOW`, `UNKNOWN`. `version` is `v1` or `v2`.
  - `counterparties[]`:
    - `name`, `entity_id`, `website`, `logo_url`, `confidence_level`;
    - `type`: `merchant`, `financial_institution`, `payment_app` ("a transfer or P2P app (e.g. Zelle)"), `marketplace`, `payment_terminal`, `income_source`;
    - `account_numbers` (BACS/international, "select financial institutions in Europe").
  - `transaction_code` ("European institutions, as well as certain institutions in the United States"): `adjustment`, `atm`, `bank charge`, `bill payment`, `cash`, `cash advance`, `cashback`, `cheque`, `direct debit`, `interest`, `late fee`, `membership fee`, `payment`, `purchase`, `refund`, `returned item fee`, `standing order`, `transfer`.
  - `payment_meta`: `reference_number`, `ppd_id`, `payee`, `payer`, `by_order_of`, `payment_method`, `payment_processor`, `reason`.
  - `merchant_category_code`: "in beta … populated primarily for card transactions, coverage varies".
  - `running_balance`: "Returned on posted transactions only, and not populated for every institution or every transaction. May not reconcile with the balances returned by `/accounts/balance/get`". It was added in spec `1.733.0` (per the plaid-openapi CHANGELOG) but is flagged **`x-hidden-from-docs: true`**. It is therefore absent from Plaid's public API reference, and whether BRAKE can receive it without special enablement is **(unverified)**.
  - Also `check_number`, `location`, `website`, `logo_url`, `account_owner`.
  - **PFC v2** became the only taxonomy for customers who enabled Transactions or Enrich on or after **2025-12-03**. Older customers stay on v1 unless they opt in [1][5]. v2 adds, among others, `LOAN_DISBURSEMENTS_BNPL`, `LOAN_PAYMENTS_EWA`, `TRANSFER_IN_WIRE` / `TRANSFER_OUT_WIRE` and `INCOME_GIG_ECONOMY`. It keeps `TRANSFER_OUT_ACCOUNT_TRANSFER`, `TRANSFER_OUT_SAVINGS`, `TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS`, `TRANSFER_OUT_WITHDRAWAL`, `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` and `RENT_AND_UTILITIES_RENT` [5]. **There is no purchase-refund category (only `INCOME_TAX_REFUND`) and no wallet-load category.** Refunds must be inferred from sign, merchant and `transaction_code: refund` where present.
- **Windows & latency:** POST-SPEND. "Plaid typically checks for new transactions data between one and four times per day, depending on the institution" [1]. `/transactions/refresh` forces a check, but it "is offered as an optional add-on to Transactions and has a separate fee model" [1]. Pending records reportedly move to posted "one to five business days later" [2] **(docs page not fetched; unverified)**. Webhooks: `SYNC_UPDATES_AVAILABLE`; the legacy `TRANSACTIONS_REMOVED` still fires [1][4].
- **Coverage:** see the Plaid stream. This document relies only on field semantics. Pending data: "Not all institutions provide pending transactions" [1].
- **Access requirements:** a Plaid contract. Default history (`days_requested`) is 90 days and the maximum is 730. In Production the minimum is 30 days. History length cannot be changed after Transactions is added to an Item [1].
- **Privacy & consent:** server-side aggregator with a per-Item access token. BRAKE should pass only normalized observations to the device-side fusion and should not keep raw descriptors server-side.
- **Reliability & failure modes** [1][2]:
  - When a pending record posts, its `transaction_id` appears in `removed` and a *new* posted record appears in `added`. The spec describes `pending_transaction_id` only as set "where applicable". The wording that the link exists "if Plaid matches" the two comes from the Plaid docs page [2], which was seen only as a search summary **(unverified)**. The spec does confirm that "Transactions are not immutable and can also be removed altogether by the institution" [1].
  - A pending record used as an authorization hold (gas stations, hotels, car rental) "may not convert to a posted transaction at all and will simply disappear" [2] **(docs page not fetched; unverified)**.
  - "Pending transaction details (name, type, amount, category ID) may change before they are settled."
  - `account_id` changes if Plaid "can't reconcile the account". `mask` "may be non-unique between an Item's accounts", so prefer `persistent_account_id` where supported. As of spec `1.762.0` that is "only for Items at institutions that use Tokenized Account Numbers (i.e., Chase, PNC, and US Bank)" [1].
  - `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` forces a restart of the whole pagination loop.
- **Dedup / reconciliation keys:** `transaction_id`, `pending_transaction_id`, `payment_meta.reference_number`, `merchant_entity_id`, `counterparties[].entity_id`, `account_id` / `persistent_account_id`, `running_balance`, and the 2–4 character `mask`.
- **Normalized observation:** `money_movement` with stage `pending` or `posted`. References:
  - `provider_transaction_id` = `transaction_id`, namespace `plaid:<item>`;
  - `provider_pending_id` = `pending_transaction_id`.

  `typeHints` come from PFC detailed categories, with confidence mapped from `confidence_level` (for example `VERY_HIGH` → 0.95, `HIGH` → 0.85, `MEDIUM` → 0.6, `LOW` → 0.35; these mappings are BRAKE design values). `counterparty.isMerchant` comes from the counterparty `type`. `occurredAt` comes from `authorized_datetime`, then `authorized_date`, then `date`, with date precision flagged. Base observation confidence is about 0.97 for posted records and 0.85 for pending records, because pending records may change.
- **Provenance sentence:** "From your Chase checking transactions (via Plaid), posted 2 Oct; authorized 30 Sep."
- **Recommendation: `mvp`** (US): implement `removed` as retraction, supersede pending with posted, and ingest PFC and counterparty types as type hints from day one.

#### A2. Plaid Recurring Transactions — `plaid-recurring-transactions`

- **What it is:** `/transactions/recurring/get`, "offered as an add-on to Transactions". It returns `inflow_streams[]` and `outflow_streams[]` of `TransactionStream`, plus `updated_datetime`. The `RECURRING_TRANSACTIONS_UPDATE` webhook carries `account_ids` [1].
- **Data:**
  - Identity: `stream_id`, `account_id`, `description`, `merchant_name`.
  - Dates: `first_date`, `last_date`, `predicted_next_date` ("only … if the next payment date can be predicted").
  - `frequency`: `WEEKLY`, `BIWEEKLY`, `SEMI_MONTHLY`, `MONTHLY`, `ANNUALLY`, `UNKNOWN`.
  - `transaction_ids[]`, sorted by posted date.
  - Amounts: `average_amount` and `last_amount`, each `{amount, iso_currency_code}`.
  - `is_active`.
  - `status`:
    - `MATURE`: "at least 3 transactions and happen on a regular cadence (For Annual … after 2 instances)";
    - `EARLY_DETECTION`;
    - `TOMBSTONED`: "no further transactions were found at the next expected date";
    - `UNKNOWN`.
  - `personal_finance_category`.
  - `is_user_modified`: "As the ability to modify transactions streams has been discontinued, this field will always be `false`".
- **Windows & latency:** POST-SPEND. It feeds PRE-SPEND context ("Netflix renews tomorrow") through `predicted_next_date`. Updates follow the 1–4×/day sync cadence.
- **Coverage:** wherever Plaid Transactions works. "For best results … request at least 180 days of history" [1].
- **Access:** product access request. Separately priced **(pricing unverified)**.
- **Privacy:** no extra data beyond Transactions.
- **Reliability & failure modes:**
  - streams are **per account**, so a subscription that moves to a new card becomes two streams;
  - the frequency enum has no quarterly or semi-annual values (they fall into `UNKNOWN`);
  - users cannot correct streams any more (modification discontinued). The spec lists a `/transactions/recurring/deactivate` path with an empty definition, so its status is unclear **(unverified)**;
  - early streams can tombstone after one missed charge.
- **Dedup keys:** `stream_id`, `transaction_ids[]`. These map Plaid streams onto BRAKE series.
- **Normalized observation:** not a transaction. Emit a context `subscription_event`-like "series hint" with `frequency`, `predicted_next_date` and `last_amount`, plus `recurring_series` link hints on the member candidates. Confidence is about 0.9 for `MATURE`, 0.5 for `EARLY_DETECTION` and 0.1 for `TOMBSTONED`.
- **Provenance sentence:** "Plaid flagged this as a monthly charge from Spotify on your Amex card."
- **Recommendation: `next`.** It is a useful prior for US users but cannot be the engine, because BRAKE must work identically on AA, SMS, notifications and manual data.

#### A3. Plaid Enrich — `plaid-enrich`

- **What it is:** `/transactions/enrich` "enriches raw transaction data … retrieved from other non-Plaid sources". It takes at most **100 transactions per request** [1].
- **Data:**
  - Input: `id`, `client_user_id`, `client_account_id`, `account_type`/`account_subtype`, `description`, `amount` (absolute value), `direction` (`INFLOW`/`OUTFLOW`), `iso_currency_code`, `mcc`, `date_posted`, and `location`, whose `country` is documented as `"US" or "CA"`.
  - Output (`enrichments`): `counterparties[]`, `entity_id`, `merchant_name`, `logo_url`, `website`, `phone_number`, `location`, `payment_channel`, `personal_finance_category` (with `version`), and optionally legacy categories. **The schema has no recurrence field.**
- **Windows & latency:** POST-SPEND. Synchronous API call **(latency unverified)**.
- **Coverage:** the location schema suggests US/Canada only **(unverified as a coverage statement)**. Not useful for India.
- **Access:** Plaid contract **(pricing unverified)**.
- **Privacy:** sends descriptors and amounts to a third party, so it needs explicit consent and a DPA. Weak fit with "local processing preferred".
- **Reliability & failure modes:** quality degrades with "unrealistic" amounts. US-centric merchant graph.
- **Keys:** `entity_id` (stable merchant ID usable as a merchant key across sources).
- **Normalized observation:** an enrichment patch (merchant key, display name, category hint) on an existing candidate, never a new candidate.
- **Provenance sentence:** "Merchant identified with Plaid's merchant database."
- **Recommendation: `later`.** For US users with Plaid, Transactions already returns the same enrichment. Its only value would be enriching US SMS, email or manual data, which is a small slice.

#### A4. Plaid Liabilities (credit cards) — `plaid-liabilities`

- **What it is:** the credit card liability object [1].
- **Data:** `last_payment_amount`, `last_payment_date` ("Availability … limited"), `last_statement_balance`, `last_statement_issue_date`, `minimum_payment_amount`, `next_payment_due_date`, `is_overdue` (limited), `aprs[]`.
- **Windows:** POST-SPEND (it confirms that a bank debit was a card payment). PRE-SPEND context (the due date counts as an upcoming known bill).
- **Access, privacy, coverage:** as for Plaid Transactions, as a separate product.
- **Reliability:** fields are sparsely populated by some issuers.
- **Keys:** `(account_id, last_payment_date, last_payment_amount)`. This matches the bank-side debit leg and the card-side credit leg.
- **Normalized observation:** `balance_snapshot` with `limit`, plus a "payment received" fact that adds about +3 nats to card-payment matching.
- **Provenance sentence:** "Your Amex statement shows a ₹/$ payment of 1,240.55 on 3 Oct, so we didn't count it as spending."
- **Recommendation: `next`.**

#### A5. India Account Aggregator (deposit and credit-card FI types) — `india-account-aggregator`

- **What it is:** the FI data schemas hosted in Sahamati's GitHub repository [6]. ReBIT is the authority for these schemas. **Version caveat (as of 2026-10-04):** ReBIT published Deposit, RD and TD FI schema **v2.0.0** (adoption circular dated 2025-01-23). Per Sahamati's adoption FAQ [25], FIPs had to decommission v1.x before 2025-07-12 and FIUs before 2025-07-27. v2 "changes mandatory/optional status, adds and deletes fields, and updates enumerations". The XSD consulted here constrains `version` to 0.0–2.0 but is not shown to be the v2.0.0 release. The field list and "required" flags below may therefore reflect v1.x, and must be re-checked against ReBIT's Deposit v2.0.0 release note before the parser is built **(unverified; specifications.rebit.org.in blocked)**.
- **Data actually available:**
  - **Deposit `Transaction`**, all attributes *required* in the XSD consulted [6]:
    - `type`: `CREDIT`/`DEBIT`;
    - `mode`: `CASH`, `ATM`, `CARD`, `UPI`, `FT`, `OTHERS`;
    - `amount`;
    - `currentBalance` (documented "Available balance");
    - `transactionTimestamp` (`xs:dateTime`) and `valueDate` (`xs:date`);
    - `txnId`: "Unique id of the transaction";
    - `narration`;
    - `reference`: "The cheque or reference no".

    The `Transactions` element is "Details of all transactions that have been **posted** in an account". The deposit schema does have a `Pending` element, but it is an amount with a transaction type, not a list of pending transactions.
  - **Credit card FI type** (`others_creditcard.xsd`; date-only `txnDate`, no balance-after): `txnId`, `txnType` (`DEBIT`/`CREDIT`), `txnDate`, `amount`, `valueDate`, `narration`, `statementDate`, **`mcc` (required)** and `maskedCardNumber`. The summary carries `currentDue`, `totalDueAmount`, `minDueAmount`, `dueDate`, `lastStatementDate`, `previousDueAmount`, `creditLimit` and `availableCredit` [6].
- **Windows & latency:** POST-SPEND. Data is fetched under a consent with a fetch frequency, so it is not real-time **(typical lag unverified; see the AA stream)**.
- **Coverage:** India; FIPs that are live on AA **(see the AA stream)**.
- **Access:** via an AA (as FIU or through a TSP). Consent artefact. RBI NBFC-AA regulation.
- **Privacy:** per-consent purpose and data-life; strongly aligned with per-source disconnect.
- **Reliability & failure modes:**
  - no pending records;
  - narration formats are bank-specific. UPI narrations commonly embed the RRN, payee name and VPA **(unverified per bank)**;
  - it is not known whether `txnId` stays stable across repeated fetches **(unverified; test per FIP)**;
  - card `mcc` is required by the schema but actual FIP population is **unverified**.
- **Dedup / reconciliation keys:**
  - `txnId` (namespace = FIP + linked account);
  - `reference`;
  - the RRN parsed out of `narration` (namespace `upi`);
  - `currentBalance`, as balance-after;
  - `maskedCardNumber` / masked account number (last4).
- **Normalized observation:** `money_movement` with stage `posted`. Rail is `account_to_account_instant/upi` when `mode=UPI`, `card` when `mode=CARD`, and `cash` when `mode` is `ATM`/`CASH`. Type hint `cash_withdrawal` for `mode=ATM`, confidence 0.9. Merchant/counterparty come from the parsed narration. Confidence is about 0.97 for amount and direction and about 0.6 for parsed counterparty fields.
- **Provenance sentence:** "Confirmed by your HDFC Bank statement (via Account Aggregator): ₹1,249 debited by UPI on 3 Oct."
- **Recommendation: `mvp`** (India). It is the ledger that later confirms or corrects real-time alerts. Balance-after makes the SMS/notification ↔ AA join very reliable, provided `currentBalance` is still mandatory in Deposit v2.0.0 **(unverified)**.

#### A6. UK Open Banking AIS — `uk-open-banking-ais`

- **What it is:** OBIE Account and Transaction API **v4.0.1** (`OBTransaction6`) [7].
- **Data:**
  - `TransactionId`: "unique and immutable" within the servicing institution, but **optional**. `OBTransaction6` requires only `AccountId`, `CreditDebitIndicator`, `Status`, `BookingDateTime` and `Amount`.
  - `TransactionReference`: "may … be the FPID in the Faster Payments context".
  - `StatementReference`, `CreditDebitIndicator` (`Credit`/`Debit`).
  - `Status`: `BOOK`, `PDNG`, `FUTR`, `INFO`, `RJCT`.
  - `TransactionMutability`: `Mutable`/`Immutable`.
  - `BookingDateTime` and `ValueDateTime`. "All date-time fields in responses must include the timezone."
  - `TransactionInformation` (narrative), `Amount`, `ChargeAmount`.
  - `CurrencyExchange`: `SourceCurrency`, `TargetCurrency`, `UnitCurrency`, `ExchangeRate`, `ContractIdentification`, `QuotationDate`, `InstructedAmount`.
  - `BankTransactionCode` (ISO `Code`/`SubCode`) and `ProprietaryBankTransactionCode`.
  - `Balance` (optional), i.e. the balance after the entry. It carries a `Type` from ISO balance-type codes (for example `ITAV` interim available vs `ITBD` interim booked), so the available-vs-booked ambiguity can be resolved when it is populated.
  - `MerchantDetails` (optional): `MerchantName`, `MerchantCategoryCode`.
  - `CreditorAccount`/`DebtorAccount`: `SchemeName`, `Identification`, `Name`, `SecondaryIdentification`, `Proxy`.
  - `CardInstrument`: `CardSchemeName`, `AuthorisationType` (`ConsumerDevice`/`Contactless`/`None`/`PIN`), `Name`, masked `Identification`.
  - `CategoryPurposeCode`, from ISO `ExternalCategoryPurpose1Code`. Includes `CCRD` "CreditCardPayment: Transaction is related to a payment of credit card", `DCRD` "related to a payment of debit card", `GP2P` "Debtor and Creditor are natural persons", `MP2P` "Mobile P2P Payment", `MP2B` "Mobile P2B Payment", `SALA`, `LOAN`, `TAXS`, `SUPP`, `CASH` ("general cash management instruction"), `SWEP`, `TOPG` [8]. The `DCRD` sibling suggests that `CCRD`/`DCRD` mark payments *made with* a card, not card-bill payments **(semantics unverified)**.
  - `PaymentPurposeCode`, `UltimateCreditor`, `UltimateDebtor`.
  - **There is no field linking a pending entry to its booked successor.**
- **Windows & latency:** POST-SPEND, with pending entries where banks expose them **(per-bank, unverified)**.
- **Coverage:** UK. **Whether production banks actually populate the v4 fields (purpose codes, mutability) is unverified.** Many may still serve v3.1.x.
- **Access:** FCA-authorised AISP or an agent of one. Periodic consent rules apply. My understanding is that FCA PS21/19 replaced the 90-day SCA re-authentication with a 90-day AISP consent reconfirmation from 2022-09-30 **(unverified this session; see the open-banking stream)**.
- **Privacy:** PSD2-style consent.
- **Reliability & failure modes:** mutable pending entries; counterparty identifiers present only for credit transfers; `TransactionId`, `Balance` and `MerchantDetails` are all optional in the schema.
- **Keys:** `TransactionId`, `TransactionReference` (FPID), `Balance`, `CreditorAccount.Identification` (to compare with the user's own accounts), `CardInstrument.Identification` (masked).
- **Normalized observation:** `money_movement`. `CategoryPurposeCode` becomes a type hint: `CCRD` → `credit_card_payment` at most 0.4, and only on a debit whose counterparty is a card issuer, because the code's semantics are ambiguous; `GP2P`/`MP2P` → `transfer/p2p_other` at 0.7; `SALA` → `income` at 0.9. If `CreditorAccount` equals an owned account, emit `transfer/own_account` at 0.95.
- **Provenance sentence:** "From your Monzo transactions (Open Banking): payment to your Barclays account ending 4421."
- **Recommendation: `next`** (UK).

#### A7. Berlin Group NextGenPSD2 AIS (EU) — `berlin-group-psd2-ais`

- **What it is:** the de-facto EU XS2A interface. Each ASPSP publishes its own implementation [9][10].
- **Data:**
  - Account reports carry `booked[]` and `pending[]` arrays [9].
  - `transactionDetails` (FinecoBank v1.3) [10]:
    - `transactionId`;
    - `entryReference`: "identification of the transaction as used e.g. for reference for deltafunction … same identification as … camt.05x";
    - `endToEndId`, `mandateId` ("e.g. a SEPA Mandate ID"), `checkId`, `creditorId` ("e.g. a SEPA Creditor ID");
    - `bookingDate`, `valueDate`, `transactionAmount`, `exchangeRate`;
    - `creditorName`/`creditorAccount`/`ultimateCreditor` and `debtorName`/`debtorAccount`/`ultimateDebtor`;
    - `remittanceInformationUnstructured`/`Structured`;
    - `bankTransactionCode` and `proprietaryBankTransactionCode`.
  - **FinecoBank marks `entryReference` and `endToEndId` as "currently not used".** BNP/Consorsbank's v1.3.6 schema omits `entryReference` and `creditorId` entirely [9][10]. **Dating caveat:** both files are historical copies in Yolt's provider repository. The Fineco file is "1.3 Feb 14th 2019"; the Consorsbank file is "1.3.6_2020-08-14 (last updated for BNP Nov. 5th 2020)". They show that field population varies by ASPSP, but neither bank's 2026 behaviour is verified **(unverified as of 2026-10-04)**.
- **Windows:** POST-SPEND.
- **Coverage:** EU/EEA, per ASPSP.
- **Access:** PSD2 AISP licence or a licensed aggregator.
- **Reliability:** field population varies by bank. Dates are date-only (`bookingDate`).
- **Keys:** `transactionId` (scope is ASPSP-specific; some use it only as an access ID), `endToEndId`, `mandateId` + `creditorId`. A SEPA direct debit's mandate+creditor identifies one recurring series exactly.
- **Normalized observation:** `money_movement`. A `mandate_id` reference produces an immediate `recurring_series` hint.
- **Provenance sentence:** "From your ING account (Open Banking): SEPA direct debit under mandate M-123 from Vodafone."
- **Recommendation: `next`** (EU), with per-ASPSP capability facts.

#### A8. Australia CDR banking — `australia-cdr-banking`

- **What it is:** Consumer Data Standards v1.36.0, `BankingTransactionV2` [11].
- **Data:**
  - `transactionId` ("mandatory (through hashing if necessary) unless there are specific and justifiable technical reasons why a transaction cannot be uniquely identified"; it is *not* in the schema's `required` list) and `isDetailAvailable`.
  - `type`: `FEE`, `INTEREST_CHARGED`, `INTEREST_PAID`, `TRANSFER_OUTGOING`, `TRANSFER_INCOMING`, `PAYMENT`, `DIRECT_DEBIT`, `OTHER`.
  - `status`: `PENDING`/`POSTED`, with the statement "no provision in the standards to guarantee the ability to correlate a pending transaction with an associated posted transaction".
  - `description`, `postingDateTime` (mandatory if posted), `valueDateTime`, `executionDateTime`.
  - `amount`: negative means outgoing.
  - `reference`, `merchantName`, `merchantCategoryCode`.
  - BPAY `billerCode`/`crn`; `apcaNumber`.
  - `instalmentPlanId`: links a transaction to an instalment (BNPL-style) plan, with the caveat that fee or repayment amounts "may not match a scheduled instalment amount". This is a useful model for India's EMI conversions.
- **Windows:** POST-SPEND.
- **Coverage:** Australia.
- **Access:** accredited data recipient (or a CDR representative).
- **Reliability:** transaction IDs may be hashes; pending↔posted is not correlated by design.
- **Keys:** `transactionId`, `reference`, BPAY `crn` (one biller account, so it marks a recurring bill), `merchantCategoryCode`.
- **Normalized observation:** `money_movement`. `type` maps to type hints: `TRANSFER_*` → transfer at 0.7, `DIRECT_DEBIT` → recurring hint, `FEE` → fee.
- **Provenance sentence:** "From your CommBank transactions (Consumer Data Right)."
- **Recommendation: `later`** (AU is not a launch market). The no-correlation statement is a design input now.

#### A9. Open Finance Brasil accounts and Pix — `brazil-open-finance`

- **What it is:** Open Finance Brasil Accounts API v2.4.2 and Payments API [12][13].
- **Data:**
  - `transactionId`: "ideally immutable", but it must at least follow the per-type immutability table in the API guidance. IDs for `PIX`, `TED`, same-institution transfers, `TARIFA_SERVICOS_AVULSOS` and `FOLHA_PAGAMENTO` must be immutable on D0. IDs for `DOC`, `BOLETO`, `CONVENIO_ARRECADACAO`, `PACOTE_TARIFA_SERVICOS`, `DEPOSITO`, `SAQUE` and others may become immutable only on D+1. Accounts v2.4.2 is the latest stable file as of 2026-10-04; 2.5.0 betas exist.
  - `completedAuthorisedPaymentType`:
    - `TRANSACAO_EFETIVADA`: the ID becomes immutable;
    - `LANCAMENTO_FUTURO`: future entry, the ID may change;
    - `TRANSACAO_PROCESSANDO`: processing, the ID may change.
  - `creditDebitType`: `CREDITO`/`DEBITO`.
  - `transactionName`.
  - `type`: `TED`, `DOC`, `PIX`, `TRANSFERENCIA_MESMA_INSTITUICAO`, `BOLETO`, `CONVENIO_ARRECADACAO`, `PACOTE_TARIFA_SERVICOS`, `TARIFA_SERVICOS_AVULSOS`, `FOLHA_PAGAMENTO`, `DEPOSITO`, `SAQUE`, `CARTAO`, `ENCARGOS_JUROS_CHEQUE_ESPECIAL`, `RENDIMENTO_APLIC_FINANCEIRA`, `PORTABILIDADE_SALARIO`, `RESGATE_APLIC_FINANCEIRA`, `OPERACAO_CREDITO`, `OUTROS`.
  - `transactionAmount{amount,currency}`, `transactionDateTime`.
  - **`partieCnpjCpf`**: the counterparty's tax ID. Mandatory for payment transactions since 2023-05-02 under IN BCB nº 371.
  - **`partiePersonType`**: `PESSOA_NATURAL`/`PESSOA_JURIDICA`.
  - `partieCompeCode`, `partieBranchCode`, `partieNumber`, `partieCheckDigit`.
  - **Pix `EndToEndId`** [13]: 32 characters in the pattern `E` + 8-digit ISPB + `yyyyMMddHHmm` + 11 alphanumerics. The timestamp is the UTC time of order submission (or of the scheduled send) and may differ from the SPI processing time by up to ±12 h. The ID is unique across the Pix settlement system (SPI). The format is taken from Payments API v1.2.0, an older version; the format itself is set by BCB's Pix rules.
- **Windows:** POST-SPEND.
- **Coverage:** Brazil.
- **Access:** Open Finance participant or regulated partner.
- **Privacy:** counterparty tax IDs are personal data of third parties. Hash them on ingestion.
- **Reliability:** pending and future entries can change ID. Use supersede matching, as with Plaid.
- **Keys:**
  - `transactionId` (only once `TRANSACAO_EFETIVADA`);
  - Pix `EndToEndId`, whose timestamp component gives a UTC `occurredAt` *bound* (±12 h), not a precise time;
  - the counterparty's CPF/CNPJ.

  If the counterparty CPF equals the user's own CPF, the transfer is near-certainly own-account. `PESSOA_JURIDICA` means P2M.
- **Normalized observation:** `money_movement` with `counterparty.isSelf` from tax-ID equality (0.98) and `counterparty.isMerchant` from person type (0.9).
- **Provenance sentence:** "From your Nubank statement (Open Finance): Pix to a company (CNPJ), so counted as a purchase."
- **Recommendation: `later`** (BR is not a launch market). The person-type and own-tax-ID pattern should shape BRAKE's counterparty model now.

#### A10. Apple FinanceKit transactions — `apple-financekit`

- **What it is:** on-device access to Apple Wallet financial data. Available since iOS/iPadOS 17.4. Requires a managed entitlement, an organization developer account and `NSFinancialDataUsageDescription` [14].
- **Data** (`Transaction` [14]):
  - `id`, `accountID`;
  - `transactionAmount`, `foreignCurrencyAmount`, `foreignCurrencyExchangeRate`, `creditDebitIndicator`;
  - `transactionDate` ("if available"), `postedDate`;
  - `merchantName`, `merchantCategoryCode` (ISO 18245);
  - `transactionDescription`, `originalTransactionDescription`;
  - `status`: `authorized`, `pending`, `booked`, `rejected`, `memo`;
  - `transactionType`: `adjustment`, `atm`, `billPayment`, `check`, `deposit`, `directDebit`, `directDeposit`, `dividend`, `fee`, `interest`, `loan`, `pointOfSale`, `refund`, `standingOrder`, `transfer`, `withdrawal`, `unknown`.
- **Windows:** POST-SPEND (near-real-time for Apple Card/Cash **(latency unverified)**). Since iOS/iPadOS 26.0, FinanceKit offers a `BackgroundDeliveryExtension`, "an extension used to receive updates about changes to data within the finance store". It may let BRAKE react to new transactions without the app open; actual latency is **(unverified)**.
- **Coverage:** iOS, accounts available in Wallet **(country/account coverage: see the FinanceKit stream)**.
- **Access:** Apple entitlement review.
- **Privacy:** on-device; very good fit.
- **Reliability:** whether `id` stays stable from `authorized` to `booked` is **unverified**. Test before relying on it.
- **Keys:** `id`, `accountID`, `foreignCurrencyAmount` (an exact FX bridge to email receipts in the merchant's currency).
- **Normalized observation:** `money_movement`. `transactionType` gives the type hint: `transfer` → transfer at 0.8, `billPayment` → bill at 0.7, `refund` → refund at 0.9.
- **Provenance sentence:** "From your Apple Card activity in Wallet."
- **Recommendation: `next`.** From a reconciliation view it is one of the cleanest feeds (status and type enums, original-currency amount).

### B. Real-time alert and communication sources (what they contribute to reconciliation)

#### B1. Bank SMS alerts — `sms-bank-alerts`; B2. Android notification listener — `android-notification-listener`

- **What they are:** templated debit/credit alerts, read either from SMS or from bank and wallet app notifications. Policy, permissions and parsing are covered in the SMS and notification streams.
- **Data (reconciliation-relevant)** **(formats unverified per bank)**:
  - amount and direction;
  - masked account or card last4;
  - merchant name or payee VPA/name;
  - for UPI, a "Ref No"/"UPI Ref" that is commonly the 12-digit RRN;
  - often "Avl Bal" (available balance after the transaction);
  - for cards, "Avl Lmt" (available credit limit), which is *not* a balance.
- **Windows & latency:** IN-SPEND / immediate POST-SPEND. Seconds to minutes.
- **Coverage:** SMS alerts are common in India per the brief. Android only (iOS gives no third-party access to SMS or other apps' notifications).
- **Reliability & failure modes:**
  - duplicate deliveries (SMS resend; a notification *updated* under the same key);
  - reversal alerts ("credited … reversal");
  - card alerts reporting limit rather than balance;
  - alerts for authorizations that later fail;
  - promotional or OTP messages, which must never be processed beyond classification.
- **Keys:** UPI RRN (namespace `upi`), last4, balance-after, alert timestamp (minute precision, device clock).
- **Normalized observation:** `money_movement` with stage `confirmed` and confidence about 0.95 (verified sender, matching template). RRN goes into `rail_reference`.
- **Provenance sentence:** "Detected from your HDFC transaction notification."
- **Recommendation:** `android-notification-listener`: **`mvp`** (India Android; the policy assessment belongs to that stream). `sms-bank-alerts`: **`research`** here, because its value for reconciliation is high but platform-policy eligibility is decided in the SMS stream.

#### B3. Email receipts, orders, refunds and subscriptions — `gmail-api`

- **What it is:** transactional email parsed into `order`, `receipt`, `refund_notice` and `subscription_event` observations. Scopes and verification are in the Gmail stream.
- **Data:** order IDs, totals with tax, shipping and discounts, line items, merchant-currency amounts, refund notices with the original order ID, trial start/end dates, renewal dates and prices, and app-store receipts that name the underlying service.
- **Windows:** PRE-SPEND (renewal and trial-ending warnings), POST-SPEND (receipts, refunds). Minutes after the event.
- **Reliability & failure modes:**
  - one order can produce several charges (split shipments; capture at shipment is common in e-commerce **(unverified per merchant)**);
  - one charge can cover several orders (marketplace bundling **(unverified)**);
  - email totals are in the merchant's currency while the bank shows the billing currency;
  - promotional emails look like receipts.
- **Keys:** `order_id` (namespace = merchant key), `invoice_id`, `receipt_id`, `subscription_id`.
- **Normalized observation:** `order`/`receipt` join a money-movement candidate. An `order_id` links several candidates as one purchase group. Subscription events are context.
- **Provenance sentence:** "Matched your bank transaction with an Amazon order confirmation."
- **Recommendation: `next`** from this stream's view. Email is the main input for subscription trials, price changes and refunds, but its access cost is assessed elsewhere.

#### B4. UPI AutoPay / e-mandates — `upi-autopay-mandate`

- **What it is:** standing authorizations for recurring debits. In the UPI data model a mandate has the fields below [15]. The source is Google Cloud's Issuer Switch API protos, read from a third-party mirror. The canonical `googleapis/googleapis` path returned 404 on 2026-10-04, and this is a vendor's model of UPI, not NPCI's specification. Treat the enums as indicative **(NPCI spec not verified)**.
  - a Unique Mandate Number (UMN) and payer/payee VPAs;
  - an amount with an amount rule `EXACT` or `MAX`;
  - a recurrence pattern: `AS_PRESENTED`, `DAILY`, `WEEKLY`, `FORTNIGHTLY`, `MONTHLY`, `BIMONTHLY`, `QUARTERLY`, `HALF_YEARLY`, `YEARLY`, `ONE_TIME`;
  - a recurrence rule type `ON`/`BEFORE`/`AFTER` with a value;
  - start/end dates, revocability, and a funds-blocked flag.

  BRAKE cannot call these APIs; it sees mandates only through user-facing messages:
  - mandate-created notifications and emails from PSP apps;
  - pre-debit notifications;
  - execution debits.
- **Policy context (unverified in this session):** RBI's e-mandate framework requires a pre-debit notification to the customer before each recurring charge (commonly cited as at least 24 hours before). It allows charges without additional factor of authentication (AFA) up to ₹15,000, and up to ₹1,00,000 for mutual-fund subscriptions, insurance premiums and credit-card bill payments.
- **Windows:** PRE-SPEND (the pre-debit notice is an advance renewal warning, ideal for "keep or review?"); POST-SPEND (execution).
- **Coverage:** India; cards, UPI, NACH.
- **Reliability:** message formats vary **(unverified)**. Mandates with `MAX` amount rules let charges vary.
- **Keys:** UMN (if present in messages **(unverified)**), payee VPA/name, mandate amount and recurrence.
- **Normalized observation:** `mandate` (context) founds a BRAKE recurring series with `expected cadence` and `max amount`. Pre-debit notices become `subscription_event: renewal_upcoming`.
- **Provenance sentence:** "Your bank told us Netflix will debit ₹649 tomorrow under your UPI AutoPay mandate."
- **Recommendation: `next`** (India). It is the most precise recurring signal in India and arrives before the money moves.

### C. Merchant normalization and enrichment

#### C1. On-device descriptor normalization — `merchant-descriptor-normalization`

- **What it is:** a deterministic pipeline that runs locally, plus a compact per-country merchant dictionary and per-user aliases learned from labels.
- **Inputs:** raw descriptors:
  - card: `AMZN Mktp US*2K4L…`, `SQ *BLUE BOTTLE`;
  - UPI narrations and VPAs;
  - SEPA remittance text.

  Plus MCC, the counterparty handle, and email/QR merchant names.
- **Algorithm:**
  1. Unicode NFKC; case-fold; collapse whitespace.
  2. Split off and record *intermediaries* rather than discarding them. Typical prefixes are aggregators, PSPs, POS providers and marketplaces (`SQ *`, `TST*`, `PAYPAL *`, `GOOGLE *`, `APPLE.COM/BILL`, Indian PG prefixes) **(prefix list must be curated; examples unverified)**. Ntropy models these as `intermediaries[]`; Spade as `thirdParties[]` ("Toast, Square, Uber Eats, Doordash"); Plaid as counterparty types `payment_terminal`/`marketplace` [1][16][17].
  3. Strip trailing high-entropy reference tokens (alphanumerics of 4 or more characters containing digits), store numbers (`#1234`), phone numbers, URLs, and city/state/country suffixes.
  4. Look up the dictionary: exact → alias → fuzzy (token Jaccard ≥ 0.8 or Jaro–Winkler ≥ 0.92, as initial values). Unresolved cleaned strings become their own key (`raw:<cleaned>`).
  5. Keep `raw`, `cleaned`, `intermediary`, `key`, `displayName` and a confidence.
- **Windows:** all three. Normalizing a QR or intent payee in-spend lets BRAKE recognise "your usual Swiggy".
- **Coverage:** global. The dictionary is per country (top merchants by share of spend).
- **Privacy:** fully local. Dictionary updates are downloaded; nothing is uploaded.
- **Failure modes:**
  - marketplace descriptors (Amazon marketplace vs Amazon retail vs Prime);
  - aggregator descriptors hiding the real service (app stores, PayPal);
  - franchise vs brand;
  - one merchant with many legal names (UPI merchant `legal` vs `brand` vs `franchise` names exist in the UPI data model [15]);
  - non-Latin scripts and transliteration (Hindi/Tamil SMS).
- **Keys produced:** `merchant_key`, used in fusion (merchant similarity) and recurring grouping.
- **Provenance sentence:** "We recognised 'AMZN Mktp US*2K4L' as Amazon."
- **Recommendation: `mvp`.**

#### C2. Merchant category codes (ISO 18245) — `mcc-iso-18245`

- **What it is:** a 4-digit code the acquirer assigns to the merchant. It is exposed by:
  - Plaid `merchant_category_code` (beta);
  - UK OB `MerchantDetails.MerchantCategoryCode`;
  - CDR `merchantCategoryCode`;
  - FinanceKit `merchantCategoryCode`;
  - AA credit card `mcc`;
  - UPI merchant `category_code`;
  - UPI QR/intent `mc` (see the UPI stream) [1][6][7][11][14][15].
- **Codes that matter for transfer-vs-spending** [18]. [18] is a community dataset, not the paywalled ISO 18245 text, and it has errors: it labels 6011 "Manual Cash Disbursements", where 6011 is conventionally *automated* cash disbursement.

  | MCC | Meaning |
  |---|---|
  | 4829 | Money orders / wire transfer |
  | 6010 / 6011 | Manual / automated cash disbursement |
  | 6012 | Financial institutions: merchandise and services |
  | 6051 | Non-financial institutions: foreign currency, money orders, travellers cheques (quasi-cash) |
  | 6211 | Security brokers/dealers |
  | 6300 | Insurance |
  | 6513 | Real-estate agents: rentals |
  | 9311 | Tax payments |
  | 8398 | Charitable organizations |
  | 7995 | Betting |
  | 5968 | Direct marketing: continuity/subscription |
  | 5815–5818 | Digital goods |
  | 5542 | Automated fuel dispensers (pre-auth hold pattern) |
  | 7011 / 7512 | Lodging / car rental (hold pattern) |

  6540 (commonly cited for stored-value/prepaid loads) was not in the dataset consulted **(unverified)**.
- **Windows:** IN-SPEND (when BRAKE observes a QR or intent), POST-SPEND.
- **Failure modes:**
  - the MCC describes the merchant's primary business, not the item bought (a supermarket selling electronics);
  - marketplaces and app stores carry one MCC for everything;
  - acquirers mis-assign codes;
  - population on bank feeds is partial.
- **Normalized observation:** `CategoryHint{scheme:"mcc"}` with confidence about 0.6. Type hints: 6010/6011 → `cash_withdrawal` at 0.9; 4829/6051 → transfer-like at 0.6; 6211 → `investment` at 0.7.
- **Provenance sentence:** "Category from the merchant's card category code (5411 Grocery)."
- **Recommendation: `mvp`** (use it wherever present).

#### C3. Ntropy — `ntropy-enrichment`

- **What it is:** a transaction enrichment API. SDK 5.6.0 was released 2026-08-29 and added `semi-monthly` periodicity [16].
- **Data:**
  - Input: `id`, `description` (≤1024 characters), `date`, `amount` (non-negative), `entry_type` (`outgoing`/`incoming`), `currency`, `account_holder_id`, `location`.
  - Output:
    - `entities.counterparty`, which has a **`type: person | organization`**, plus `id`, `name`, `website`, `logo`, `mccs[]` and `naics2017`;
    - `entities.intermediaries[]`;
    - `categories.general`;
    - structured `location`;
    - recurrence: `type` = `recurring` (varying price) | `subscription` (fixed price) | `one off`, with a `group_id`;
    - recurrence groups: `periodicity_in_days`; `periodicity` ∈ {daily, weekly, bi-weekly, semi-monthly, monthly, bi-monthly, quarterly, semi-yearly, yearly, other}; `average_amount`, `total_amount`, `start_date`, `end_date`, `transaction_ids[]`.
- **Windows:** POST-SPEND.
- **Coverage:** **unverified** (docs site blocked).
- **Access:** API key, commercial **(pricing unverified)**.
- **Privacy:** sends descriptors to a vendor; needs consent and a DPA.
- **Value for BRAKE:** its person/organization counterparty flag directly answers P2P vs P2M for descriptor-only data. Its split between `recurring` (variable) and `subscription` (fixed) is a good model to copy.
- **Provenance sentence:** "Ntropy identified the payee as a person, so we treated this as a transfer."
- **Recommendation: `research`.** Benchmark on Indian UPI narrations before considering it. Copy the data model regardless.

#### C4. Spade — `spade-enrichment`

- **What it is:** real-time card (and transfer) enrichment aimed at card issuers. It has east and west coast endpoints "to enable ultra low latency enrichment for realtime applications" [17] (via a third-party OpenAPI mirror; **verify against Spade's own docs**).
- **Data:**
  - `transferInfo`: `transferType` (`internal`, "between accounts owned by the same entity", vs `external`), `transferMethod` (`ach`, `cash`, `check`, `intrabank`, `rtp`, `wire`), `isAdjustmentOrRefund`;
  - `isPeerToPeer` and `isDigitalWallet` ("currently only available for transfers");
  - `recurrenceInfo`: `intervalType` (weekly…annually), `intervalDays`, `nextPaymentExpected`, `recentRecurrences[]` (premium);
  - `thirdParties[]`, `counterparty`.
- **Windows:** IN-SPEND for issuers (at authorization). For BRAKE, POST-SPEND only.
- **Coverage:** US-centric **(unverified)**.
- **Provenance sentence:** "Spade marked this transfer as between your own accounts."
- **Recommendation: `avoid`** for now. It is built for issuers and processors in the authorization path. Its transfer flags are a useful reference design.

#### C5. Visa Merchant Search — `visa-merchant-search`; C6. Heron Data — `heron-data`

- I could not reach developer.visa.com or Heron's documentation. Field lists, access terms and coverage are **unverified**.
- My understanding, not verified this session: Visa Merchant Search is a Visa Developer API for looking up merchant identity and category, aimed at issuers and acquirers with production approval.
- **Recommendation: `research`** for both. Do not plan around either.

### D. Shared-expense, account-ownership and user inputs

#### D1. Splitwise — `splitwise-api`

- **What it is:** a self-serve REST API with OAuth 2 (authorization-code flow) or an API key [19].
- **Data:** expense fields include `cost`, `currency_code`, `date`, `payment` (a settle-up flag), `repeats`/`repeat_interval`, `category`, `receipt`, `repayments[]`, and `users[]` with `paid_share`, `owed_share` and `net_balance`.
- **Policy constraint:** "The API is not intended for commercial use … may not be used in connection with any fee-based service". Commercial integrations need a licence from developers@splitwise.com. The self-serve API has "conservative rate and access limits". The terms also require "explicit consent from end users" [19].
- **Windows:** POST-SPEND (minutes to days after the purchase).
- **Use:** an expense's `paid_share` vs `owed_share` gives BRAKE the user's true personal share. Settle-up payments (`payment: true`) explain incoming P2P credits as reimbursements.
- **Provenance sentence:** "Your Splitwise expense shows your share of this ₹1,800 dinner was ₹600."
- **Recommendation: `later`**, needing a commercial licence. Until then use in-app "split this" one-tap labels.

#### D2. Owned-instrument registry — `owned-instrument-registry`

- **What it is:** BRAKE's local list of the user's own accounts, cards, wallets, UPI handles, brokerages and loans. It is built from:
  - connected sources (Plaid accounts with `mask`/type/subtype; AA linked accounts; masked card numbers);
  - instruments seen in alerts (last4);
  - the user's own CPF / name variants (`selfNames`);
  - explicit user confirmation ("Is account ••4421 yours?").
- **Why it matters:** every transfer rule depends on "is the other side mine?". Plaid's `mask` "may be non-unique", and `account_id` can change [1]. Key on (issuer, type, last4) plus provider IDs, and let the user merge entries.
- **Windows:** context for all three.
- **Privacy:** stores masked identifiers only, never full account numbers.
- **Provenance sentence:** "You told us account ••4421 is yours, so transfers to it aren't spending."
- **Recommendation: `mvp`.**

#### D3. User clarification prompts (clerical-review zone) — `user-clarification-prompts`

- **What it is:** the Fellegi–Sunter "possible link" zone, turned into one-tap questions: "Same as the ₹1,249 Amazon payment at 10:41? [Same] [Different]", "Was ₹50,000 to R. Sharma rent, family or a loan?".
- **Policy:** questions are driven by expected value of information, roughly P(uncertain) × amount × budget impact. Ask at most one question per counterparty or merchant per type; the answer becomes a rule. Keep a weekly question budget (a BRAKE design parameter, for example ≤3 per day and ≤10 per week, to be tuned in research).
- **Keys:** answers are stored as `UserAssertion`s anchored to observation IDs, so they survive recomputation.
- **Provenance sentence:** "You said payments to Ramesh K are family support."
- **Recommendation: `mvp`.**

### E. Reconciliation mechanisms (BRAKE-internal)

#### E1. Probabilistic record linkage (fusion) — `probabilistic-record-linkage`

- **What it is:** Fellegi–Sunter scoring adapted to streaming observations. Splink's documentation gives the following [20]:
  - Parameters:
    - λ: the prior probability that two records match;
    - *m* = Pr(observation | match), "largely a measure of data quality";
    - *u* = Pr(observation | non-match), "a measure of coincidence".
  - The match weight is `log2(λ/(1−λ)) + Σ log2(m_i/u_i)`, assuming independence between comparisons, so weights add.
  - **Term-frequency adjustments**: a match on a common value carries less evidence than a match on a rare one.
  - **Blocking** limits which pairs are compared; Splink advises "a longer list of strict blocking rules" over a short list of loose ones.
  - **Graph metrics** flag false positives: a *bridge* edge whose removal splits a cluster "can be signalers of false positives"; low cluster *density* signals weak support.

  The three decision regions (link / possible link for clerical review / non-link) come from Fellegi & Sunter (1969) [21].
- **BRAKE adaptation:**
  - **Blocking** on direction, currency (or an FX bridge), and amount and time windows per pair type, OR any shared strong reference. The architecture doc already defines these windows.
  - **Comparison levels with initial m/u values.** These are design priors to calibrate on labelled data. Natural-log weights match the architecture's `llr` scale.

    | Feature level | m | u | ln(m/u) |
    |---|---|---|---|
    | Same strong reference (same type+namespace) | 0.999 | 1e-6 | +13.8 (capped at +9) |
    | Different reference, same type+namespace | ~0 | — | **veto** |
    | Balance-after equal (same account) | 0.95 | 1e-4 | +9.2 |
    | Amount exact | 0.95 | u(amount) from user's history; e.g. 0.002 for ₹1,249, 0.05 for ₹100 | +6.2 / +2.9 |
    | Amount within pair tolerance (tips, FX) | 0.04 | 0.02 | +0.7 |
    | Amount mismatch | 0.01 | 0.97 | −4.6 |
    | Δt ≤ 10 min (alert↔alert / alert↔email) | 0.7 | 0.01 | +4.2 |
    | Δt ≤ 2 h | 0.2 | 0.05 | +1.4 |
    | Δt > 1 day (inside window) | 0.02 | 0.74 | −3.6 |
    | Merchant key equal | 0.6 | 0.02 | +3.4 |
    | Merchant clearly different | 0.15 | 0.93 | −1.8 |
    | Instrument last4 equal | 0.9 | 0.2 | +1.5 |
    | Any field missing on either side | — | — | 0 (neutral, never a penalty) |

  - **Term-frequency (TF) adjustment for amounts:** u(amount) is the smoothed frequency with which a random blocked pair from this user shares that exact amount. Round amounts and fixed-price items (₹10 UPI tea, $5 coffee) get small weights. Cap the amount weight between +2 and +7.
  - **Three zones:** link (posterior ≥ 0.9 and a 0.15 margin over the runner-up), possible duplicate (0.5–0.9; ask only if material), non-link. For ledger↔ledger pairs from *different* connections (SMS vs AA, Plaid vs FinanceKit), require posterior ≥ 0.95 **or** a strong reference or balance-after key. Two ledgers disagreeing is costly.
- **Avoiding over-merge and transitive-closure errors:**
  1. *No connected components.* An incoming observation joins at most one candidate, and only if it is compatible with **every** member (complete linkage, no member veto).
     - Failure example: SMS ₹500 at 10:00 (A) links to a Swiggy email for ₹500 at 10:05 (B). An AA posting of ₹500 with narration "…ZOMATO" (C) links to A by amount. Union–find would merge A+B+C; complete linkage refuses C because B–C merchants conflict.
  2. *One event per source:* two `money_movement`s from the same connection never merge unless they are a pending→posted pair. This is what keeps two genuine ₹100 coffees apart.
  3. *Retroactive split:* when new evidence lowers an existing link below threshold (a second Swiggy ₹500 email arrives), recompute the candidate. Treat a member whose removal changes the merchant or amount consensus as a *bridge*, detach it and re-ingest.
  4. *Order-level one-to-many:* an order split across several charges must **link** several candidates (a purchase group via `order_id`), not merge the charges.
- **Conflict resolution (which source wins per field):** follow the architecture's field-fusion table, with these evidence-based refinements:
  - for **card** rails, pending ledger and alert amounts are both authorization amounts; for **A2A** rails (UPI, Pix, FPS) the alert amount is final;
  - `occurredAt` precision order: alert timestamp > `authorized_datetime` (unless it is a default `00:00:00`) > `authorized_date` > posted `date`. The Pix `EndToEndId` minute is only a ±12 h bound and should be intersected with the other intervals, not ranked as a precise time;
  - merchant display: receipt/order/QR > enrichment entity > cleaned descriptor;
  - FX: `foreignCurrencyAmount` / `CurrencyExchange.InstructedAmount` give exact cross-currency bridges.
- **Provenance:** keep every member observation and the feature breakdown (`MatchAssessment.features`) so "How did BRAKE know this?" can say "matched by amount, time (2 min apart) and card ••1234".
- **Recommendation: `mvp`** (already specified; calibrate the m/u values with synthetic plus consented labelled data).

#### E2. Pending→posted supersession — `pending-posted-supersession`

| Situation | What changes | Matching rule (BRAKE) | Evidence |
|---|---|---|---|
| ID change on posting | New posted `transaction_id`; the pending ID moves to `removed` | Supersede via `pending_transaction_id` when present; otherwise fuzzy match (same account, same direction, merchant similarity ≥ 0.5, posted date − pending date ≤ 7 days) | Plaid [1][2] |
| No link field at all | Pending and booked are separate records | Always fuzzy; treat `Mutable`/`PENDING` records as provisional | UK OB v4.0.1 [7]; CDR [11] |
| ID mutable until final | `transactionId` may change | Re-key on `TRANSACAO_EFETIVADA`; supersede earlier versions | Brazil [12] |
| Posted only | No pending visible | The alert is the "pending/confirmed" observation; the ledger posts later | AA [6] |
| Tip added | Posted > pending | Allow up to +30% when instrument and merchant agree (architecture) | Tip ranges **(unverified)** |
| Fuel / hotel / car-rental hold | Hold disappears; final amount posts separately and may differ greatly | Treat pending records at MCC 5542/7011/7512 as *holds*: never count them as spending; match posted by merchant + instrument within 2 days (fuel) or 30 days (lodging/rental), amount unconstrained | Plaid on holds disappearing [2]; amounts and caps **(unverified)** |
| Card verification auth | $0/$1 or ₹1/₹2 pending, then removed | Never spending; record as an `app_context`-like trial/sign-up signal | **(unverified pattern)** |
| FX card purchase | Pending at authorization rate, posted at settlement rate; separate FX fee line | Amount tolerance band (for example ±3%); attach the fee line (`BANK_FEES_FOREIGN_TRANSACTION_FEES`) as an `fx_fee` component by same instrument and same/next day | PFC [5]; magnitudes **(unverified)** |
| Descriptor changes | Pending name differs from posted | Halve the weight of merchant mismatch for pending↔posted pairs | Plaid: "details (name, type, amount, category ID) may change" [1] |
| Date shift | Posted 1–5 business days later | Use `authorized_date` for both time proximity and recurring cadence | [1][2] |

- **Timezones:**
  - UK OB requires timezones on date-times [7]. Plaid `datetime` may contain default midnight values [1]. AA `transactionTimestamp` is `xs:dateTime`, with the offset optional in the XSD [6]. Pix encodes UTC minutes with a ±12 h tolerance [13].
  - Store `occurredAt` as an interval in UTC with a precision tag. When the timezone is unknown, a date-only value D is treated as [D−1 12:00Z, D+1 12:00Z], which covers UTC−12…UTC+14.
  - Time proximity is the distance between intervals.
  - Compute day-of-month for recurrence in the user's home timezone from the best-precision timestamp.
- **Retraction:** a Plaid `removed` record, an AA re-fetch without the record, or a reversal alert must retract the observation. If a POST-SPEND message was already shown, BRAKE corrects itself quietly ("That ₹1,249 payment was reversed") and does not leave a stale insight.
- **Provenance sentence:** "Your bank first showed this as pending at $42.10; it posted at $50.52 (tip added)."
- **Recommendation: `mvp`.**

#### E3. Balance continuity check — `balance-continuity-check`

- **What it is:** for any ledger that carries balance-after, use `currentBalance` (AA [6]; mandatory status in Deposit v2.0.0 unverified), `Balance` (UK OB [7]; optional, typed available/booked), `running_balance` (Plaid [1]; hidden from public docs, availability unverified) or the SMS "Avl Bal" **(unverified)**. Then:
  - verify `b_t = b_{t−1} − debit_t + credit_t`;
  - use equality of balance-after as a match feature (E1).
- **Uses:**
  - **find missing events:** a chain break means an alert was missed or the AA fetch is incomplete; prompt a fetch rather than the user;
  - **find duplicates:** two observations claiming the same balance step;
  - **join alerts to ledger records** with near certainty.
- **Failure modes:** "available" vs "current" balance (holds make them differ); intraday ordering of same-timestamp records; card "available limit" mistaken for balance.
- **Provenance sentence:** "Matched your HDFC alert to your bank statement: same amount and the same balance afterwards (₹23,410.55)."
- **Recommendation: `mvp`** where balances exist (India AA + alerts). Cheap and high-precision.

#### E4. Transfer-pair matching and single-leg transfer classification — `transfer-pair-matching`

- **Two-leg (equal-opposite) matching**, i.e. own-account transfers, savings sweeps and wallet top-ups from a connected bank:
  - **Candidates:** a debit on owned instrument A and a credit on owned instrument B ≠ A. Same currency with exact amount (± one minor unit); or different currencies within an FX band.
  - **Windows (from open source):**
    - Sure auto-matches within **±4 days**, with exact amount and same currency;
    - Sure's manual "match as transfer" dialog uses **30 days**;
    - cross-currency uses a **±10%** FX band by default (capped at 50%). It is only automatic when *both* accounts are provider-linked, because "a coincidental amount/FX-rate match applied here has no human reviewing it first" [22].
  - **Assignment:** one-to-one. Rank exact same-currency matches before FX guesses, then by date difference, and consume greedily. Otherwise "a coincidental cross-currency candidate one day closer would claim a transaction whose real exact-amount counterpart appears one day later" [22]. With several identical amounts on the same day, any one-to-one assignment gives correct totals; record the ambiguity in provenance.
  - **BRAKE windows (proposal):** instant rails (UPI, Pix, FPS, SEPA Inst, intrabank) ±1 day; card-to-card and wallet ±2 days; batch rails (ACH, NEFT, SEPA SCT) ±4 days; international wires ±7 days, plus the FX band only when both legs come from ledger sources.
- **Single-leg classification** (only one side is visible). Evidence, strongest first:
  1. The counterparty identifier equals an owned instrument: UK `CreditorAccount.Identification` [7]; Brazil `partieCnpjCpf` equal to the user's CPF [12]; a masked account in the narration matching the registry.
  2. Provider type hints: PFC `TRANSFER_OUT_ACCOUNT_TRANSFER`/`TRANSFER_OUT_SAVINGS`/`TRANSFER_IN_*` [5]; `transaction_code: transfer` [1]; CDR `TRANSFER_OUTGOING` [11]; FinanceKit `transfer` [14]; Spade `transferType: internal` [17].
  3. ISO category purpose codes: `SWEP`, `TOPG` (and, more weakly, `CASH`, "general cash management instruction") → own-account cash management; `GP2P`/`MP2P` → person-to-person [8].
  4. Self-name match in the narration or payee name (`selfNames`), with a fuzzy threshold.
  5. The user's previous answer for this counterparty key.
- **Default when uncertain:** type `transfer/unknown` with probability shown. **Excluded from discretionary pace; included in "money out" cash-flow views.** Ask once if material.
- **Provenance sentence:** "₹50,000 left your SBI account and arrived in your HDFC account the same day, so it's a transfer between your accounts."
- **Recommendation: `mvp`.**

#### E5. Credit-card bill payments — `credit-card-payment-matching`

- **Rule:** purchases on a card are spending when they happen. The bank→card payment is a `credit_card_payment` (an internal liability settlement) and **never** spending.
- **Matching:**
  - the bank debit leg (descriptor or biller naming the card issuer or a bill-pay app; PFC `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`; transaction code `bill payment`; ISO `CCRD` only as a weak hint, because its semantics are ambiguous);
  - the card credit leg (a "payment received" credit on the owned card: Plaid negative amount on the credit account; AA card `txnType=CREDIT`);
  - matched at the same amount within 1–5 days;
  - Liabilities `last_payment_amount`/`last_payment_date` [1], or AA `totalDueAmount`/`minDueAmount` [6], confirm the payment.
- **Card not connected:** the payment is still `credit_card_payment`, but BRAKE shows "Card spending: ₹X paid, not itemised. Connect the card to see where it went". It is excluded from discretionary pace, which avoids lumpy, late double counting.
- **India specifics:**
  - UPI payments funded from RuPay credit cards: the UPI data model has payer account type `CREDIT` [15]. They are card spend and must link to the card's statement line rather than a bank debit.
  - Bill-pay apps (BBPS/CRED-style) appear as the debit counterparty **(descriptor patterns unverified)**.
  - EMI conversions: a card purchase converted to EMI can appear as a reversal plus monthly EMI postings, interest and tax **(unverified; needs real statements)**. Count the original purchase once; treat EMIs as loan payments against it. Australia's CDR `instalmentPlanId` [11] is a model for linking instalments to their plan; no equivalent field was found in the AA credit-card XSD [6].
- **BNPL:** PFC v2 separates `LOAN_DISBURSEMENTS_BNPL` from loan payments [5]. Treat the purchase as spending at checkout and instalments as loan payments.
- **Provenance sentence:** "This ₹18,200 payment settled your ICICI card bill; the purchases on that card were already counted."
- **Recommendation: `mvp`.**

#### E6. P2P vs P2M — `p2p-p2m-classification`

- **What the rail knows that BRAKE does not:**
  - UPI participants have a persona `PERSON`/`ENTITY`;
  - merchants carry `category_code` (MCC), `type` `LARGE`/`SMALL`, `genre` `ONLINE`/`OFFLINE`, and `legal`/`brand`/`franchise` names;
  - exports include `PayeeMCC` "only if the payee is a merchant" [15].

  These live in issuer/PSP systems and are not exposed to third-party apps.
- **BRAKE evidence, strongest first:**
  1. BRAKE launched or scanned the payment, so it read `mc` from the QR/intent (UPI stream).
  2. A provider flag: Brazil `partiePersonType`, Ntropy `counterparty.type`, Spade `isPeerToPeer`, Plaid counterparty `type` (`payment_app` signals a transfer app, not the final payee), ISO `GP2P`/`MP2P`/`MP2B`.
  3. VPA/handle shape: a phone-number handle or personal name points to a person; known merchant/PSP handle patterns point to a merchant **(pattern lists must be curated; unverified)**.
  4. Behaviour: many small, irregular payments to one handle look like a merchant; round, large, regular amounts look like a person, rent or family.
  5. The user's label for this counterparty.
- **Failure cases:**
  - small merchants on personal VPAs (tea stalls, tutors, maids): these are real spending;
  - payments to friends for shared meals (spending by proxy);
  - Venmo/Zelle/Cash App funding debits: the bank shows only the app, not the final payee. Plaid tags Zelle as `payment_app` [1].
- **Policy:** a P2P payment of unknown purpose is `transfer/p2p_other` with type uncertainty. It is *not* added to discretionary pace until answered or learned. One question per new counterparty above a materiality threshold: "₹800 to Ramesh K: [Purchase] [Family] [Shared expense] [Other]".
- **Provenance sentence:** "You paid this UPI ID by scanning a merchant QR (category: restaurants), so we counted it as a purchase."
- **Recommendation: `mvp`** (conservative).

#### E7. Wallet loads, cash, investments, loans, rent, family — `transfer-type-heuristics`

| Movement | Signals | BRAKE type | Counts as discretionary spend? |
|---|---|---|---|
| Wallet top-up (prepaid wallet, Apple Cash, PayPal balance, UPI Lite) | Debit to own wallet; wallet "added money" alert; `isDigitalWallet` [17] | `transfer/wallet_load` | No **if** wallet spends are observed. If not, count the load as "unitemized wallet spending" at low confidence, and switch automatically once wallet spends are seen |
| Gift-card / stored-value purchase | Merchant gift-card SKU in receipt; MCC (6540 **unverified**) | `purchase` (gift) or `wallet_load` (own balance) | Ask if > threshold |
| ATM / cash withdrawal | AA `mode=ATM`; MCC 6010/6011; `transaction_code: atm`; PFC `TRANSFER_OUT_WITHDRAWAL` | `cash_withdrawal` | Separate "cash" bucket (spending unknown) |
| Investment (SIP via NACH/e-mandate, brokerage ACH) | MCC 6211; PFC `TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS`; ISO `SECU`; mandate with fund-house/exchange payee | `investment` | No (shown as savings/commitment) |
| Loan EMI / mortgage / car / student | PFC `LOAN_PAYMENTS_*`; CDR/AA direct debit; fixed monthly series | `loan_payment` | No (fixed commitment) |
| Rent | PFC `RENT_AND_UTILITIES_RENT`; MCC 6513 (rent via card platforms); large, fixed, monthly P2P to the same person | `purchase` (housing, essential) | Counts as spending (essential), excluded from discretionary pace |
| Family support | Recurring/irregular P2P to the same person; user label | `transfer/family` | No (user can opt in) |
| Salary / income | PFC `INCOME_SALARY`; ISO `SALA`; inflow series | `income` | n/a. Drives payday proximity |

- Sure's recurring engine documents a failure worth copying as a rule: brokerage dividends and 401(k) contributions arrive as monthly, tightly clustered amounts and were detected as subscriptions or income, so investment accounts are excluded from bill detection [22].
- **Provenance sentence:** "Detected as an ATM withdrawal from your bank statement. Tracked as cash, not as a purchase."
- **Recommendation: `mvp`** (rules plus learned per-counterparty answers).

#### E8. Refunds, reversals and chargebacks — `refund-reversal-matching`

- **Refund matching:**
  - criteria: a credit from the same merchant key (allowing descriptor drift) with amount ≤ the original;
  - window: 120 days for cards (architecture);
  - partial and multiple partial refunds are allowed, linking `refund_of` until Σrefunds ≤ original;
  - email refund notices carrying the `order_id` give a deterministic link;
  - when several originals are eligible, link to the most recent unrefunded purchase with the same amount and record the ambiguity.
- **Failed-payment reversals:** a debit then a credit of the same amount, often with the same RRN (or an `OriginalRRN` in the UPI dispute and complaint data model [15]). Treat as `cancelled`, not as purchase plus refund. RBI's turnaround-time framework (2019) requires auto-reversal of failed UPI debits by T+1, with compensation after that **(unverified in this session)**. Use a 5-day window.
- **Chargebacks:** a provisional "dispute credit" can be reversed again if the dispute is lost. Model it as status `refunded (provisional)` with a link that can be undone.
- **Disappearing holds:** a pending record removed without a posted successor is `cancelled`, not a refund [2].
- **Budget attribution:** in "what you spent" analytics, net the refund against the original purchase's period. In cash flow, show it on the day it lands.
- **Provenance sentence:** "Matched this ₹1,249 credit to your Amazon purchase of 3 Oct using the refund email for order #402-…."
- **Recommendation: `mvp`.**

#### E9. Reimbursements and shared expenses — `reimbursement-matching`

- **Signals:**
  - incoming P2P credits after a purchase, from counterparties labelled friend, colleague or employer;
  - Splitwise settle-ups (licensed);
  - email expense-report approvals **(unverified)**.
- **Algorithm:** within 45 days after a purchase P (or a batch of "work" purchases), search for a subset of incoming credits whose sum is P × k/n (n = 2…8 participants, k = 1…n−1), or Σ(work purchases) ± 1%. Use bounded subset-sum (≤4 credits, ≤20 candidates; the search is exponential otherwise). Then ask: "Did Priya's ₹600 pay you back for Saturday's ₹1,800 dinner?".
- **Effect:** personal spend = purchase − linked reimbursements. Ownership attribute becomes `shared`/`reimbursable`.
- **Failure modes:** coincidental sums; batch employer reimbursements spanning months; payback before the purchase (pre-payment).
- **Provenance sentence:** "Priya's ₹600 looks like a payback for Saturday's ₹1,800 dinner (a third of it)."
- **Recommendation: `next`.** In the MVP, offer manual "Split/Reimbursable" labels.

#### E10. Recurring-series detection — `recurring-series-detection`

- **Reference implementations:**
  - **Plaid:** statuses `EARLY_DETECTION` → `MATURE` (≥3 occurrences, or 2 for annual) → `TOMBSTONED` (missed the expected date); frequencies weekly/biweekly/semi-monthly/monthly/annual; ≥180 days of history recommended [1].
  - **Actual Budget:**
    - patterns: weekly, every-2-weeks, monthly on day X (X ≤ 28, because "28 is the max number of days that all months are guaranteed to have"), monthly last day, and the 1st/3rd or 2nd/4th weekday of the month;
    - occurrences searched ±2 days, with `rank = Σ 1/(dayDiff+1)`;
    - amount tolerance `round(|amount| × 0.075)`, relative to the reference transaction, not a running mean;
    - every expected occurrence in the window must be found;
    - the search is per account; transfers are excluded [23].
  - **Sure:**
    - groups by merchant (or name) + currency + account, *not* by amount;
    - clusters amounts within **7.5%** of the cluster's *running mean*, "so a price creep stays one series" while tiers stay separate;
    - minimum 3 occurrences to create (2 to *offer* a candidate);
    - lookback 3 months; the last occurrence must be within 45 days;
    - every occurrence must be within **2 days** of the expected day-of-month on a **circular** calendar ("a day-30 bill's February charge on the 28th is 2 away"). This replaced a standard-deviation test that "accepted charges scattered across the 5th, 10th and 15th";
    - new series land as `suggested`;
    - income is grouped by source rather than by amount ("variable paycheck … never forms an amount cluster");
    - transfers and investment accounts are excluded [22].
  - **Vendors:** Ntropy periodicities include quarterly and semi-yearly and separate `recurring` (variable) from `subscription` (fixed) [16]. Spade adds `intervalDays` and `nextPaymentExpected` [17].
- **BRAKE algorithm (proposal):**
  1. **Inputs:** fused candidates of type purchase/subscription/loan/rent/investment/income/P2P with a counterparty key. Exclude own-account transfers, but keep them in a separate "standing transfer" series type for savings sweeps.
  2. **Grouping key:** (direction, merchant key or hashed counterparty key, currency). **Not** account or card, because subscriptions move when a card is reissued. Add the instrument as a feature.
  3. **Amount clusters:** running-mean tolerance τ = max(7.5% × mean, one major currency unit). Tag clusters with coefficient of variation > 0.25 but strong cadence as **variable recurring** (utilities, usage billing).
  4. **Cadence:** gaps between `authorized_date`s (or alert timestamps).
     - Score candidate periods P ∈ {7, 14, semi-monthly, monthly, 61, 91, 182, 365} by the share of gaps within tolerance of k·P for k ∈ {1, 2}. k = 2 tolerates one missed observation and carries a penalty.
     - Tolerances: weekly ±1 day, biweekly ±2, monthly ±2 on the circular day-of-month calendar plus month-end and weekday rules, quarterly ±5, semi-annual ±7, annual ±7.
     - Accept the best P if its score is ≥ 0.75.
  5. **Status:**
     - `early`: 2 occurrences, or 1 occurrence plus external evidence (mandate, subscription email, Plaid stream);
     - `mature`: ≥3 occurrences, or ≥2 for annual;
     - `lapsed`: no charge by expected date + max(5 days, 0.25·P);
     - `ended`: explicit cancellation evidence or a user answer.
  6. **Prediction:** next date and amount, each with an interval. Predict amount = last amount (the current price), with the band from history.
  7. **User control:** users can merge, split, rename and end series. Plaid's discontinued stream modification is a reason to own this in BRAKE.
- **Failure cases to test:**
  - price creep forking series (fixed by running-mean clustering);
  - two tiers at one merchant;
  - scattered dates accepted by average-based tests;
  - salary or dividends detected as subscriptions;
  - habitual purchases (weekday coffee) looking weekly. Classify these as **habits**, not obligations; they are valuable PRE-SPEND intervention targets;
  - posting-lag jitter around weekends (use authorization dates);
  - annual subscriptions with only one observation in 180 days of history;
  - aggregator descriptors (app stores) mixing several services into one merchant key. Separate them by amount clusters plus email receipts.
- **Windows:** POST-SPEND detection; PRE-SPEND prediction ("renews tomorrow").
- **Provenance sentence:** "Charged on about the 5th of each month for the last 4 months (₹649 each time)."
- **Recommendation: `mvp`** (internal). It is needed to keep obligations out of discretionary pace and to know upcoming bills.

#### E11. Subscription intelligence — `subscription-intelligence`

| Feature | Required signals | Algorithm sketch | Main failure modes | Phase |
|---|---|---|---|---|
| Subscription identification | Mature series + fixed amount + subscription-type MCC (5968, 5815–5818) or a known subscription merchant, or a subscription email or mandate | Classify fixed-price recurring as `subscription` (Ntropy's fixed vs variable split [16]) | Variable bills mislabelled; gym vs membership | **MVP** (passive label) |
| Upcoming renewal | `predicted_next_date`; e-mandate pre-debit notice; renewal email | Notify only for mature series the user has not marked essential, at most once per cycle | Wrong date from posting lag; annual subs with thin history | **Next** (MVP: shown inside "upcoming bills", no push) |
| Free-trial conversion | Trial email (start/end); ₹1/$1 verification auth; mandate created with a small first amount | Pre-spend reminder N days before `trialEndsAt` | Without email there is no signal; auths are invisible on posted-only ledgers | **Next** (needs email/mandate) |
| Price increase | Mature fixed series; new amount beyond the band; price-change email | Flag if Δ ≥ max(3%, one unit) and the cadence fits; confirm with email or a second cycle | FX-driven variation for foreign-currency subscriptions; tax changes | **Next** |
| Duplicate subscription | Two active series, same service key (direct vs app-store billing) or same category with overlapping function | Inform, don't judge; ask "both intended?" | Family plans; separate profiles; aggregator descriptors | **Later** |
| Dormant subscription | Usage data (not available to BRAKE), or the user saying "I don't use this" | Ask at renewal: "Still using X?" | No usage signal; risk of nagging | **Later** (ask-based only) |

- **MVP verdict:**
  - *In:* recurring detection and passive subscription labelling. Both are needed for correct budget interpretation, payday and bill proximity, and keeping fixed costs out of "discretionary pace".
  - *Out (next):* proactive subscription management. It depends on email and mandates, is not BRAKE's differentiator (BRAKE is about spending decisions), and false alarms erode trust.
  - The one high-value early exception: India e-mandate pre-debit notices, which arrive *before* the charge with exact amount and date. Ship "keep or review?" for those as soon as the notification/SMS adapters parse them.
- **Provenance sentence:** "Netflix renews tomorrow for ₹649 — your bank sent the pre-debit notice for your AutoPay mandate."
- **Recommendation: `next`** (with the MVP subset above).

---

## Three-window classification

| Source / mechanism | Pre-spend | In-spend | Post-spend | Latency | Notes |
|---|---|---|---|---|---|
| `plaid-transactions` | — (context: balances) | — | ✔ | Hours; 1–4 checks/day; posting 1–5 business days | `pending_transaction_id` only when Plaid matches; holds vanish |
| `plaid-recurring-transactions` | ✔ (predicted next date) | — | ✔ | Hours | Per-account streams; add-on; ≥180 days of history |
| `plaid-enrich` | — | — | ✔ | API call | US/CA location schema; 100 txns per request |
| `plaid-liabilities` | ✔ (due dates) | — | ✔ | Hours–days | Confirms card payments |
| `india-account-aggregator` | — (context: balance) | — | ✔ | Per consent fetch (unverified) | Posted only; `currentBalance`; card `mcc` |
| `uk-open-banking-ais` | — | — | ✔ | Per fetch | No pending↔booked link; purpose codes in v4 |
| `berlin-group-psd2-ais` | — | — | ✔ | Per fetch | Booked/pending arrays; field population per ASPSP |
| `australia-cdr-banking` | — | — | ✔ | Per fetch | Explicitly no pending↔posted correlation |
| `brazil-open-finance` | — | — | ✔ | Per fetch | Counterparty person type plus tax ID; Pix E2E ID |
| `apple-financekit` | — | — | ✔ | Near-real-time (unverified) | Status and type enums; FX amount |
| `android-notification-listener` | — | ✔ | ✔ | Seconds | RRN, last4, balance-after |
| `sms-bank-alerts` | ✔ (pre-debit notices, unverified) | ✔ | ✔ | Seconds–minutes | Policy-gated |
| `gmail-api` | ✔ (renewal/trial notices) | — | ✔ | Minutes | Order IDs; refunds; merchant currency |
| `upi-autopay-mandate` | ✔ | — | ✔ | Hours before the debit (pre-debit) | Recurrence pattern, amount rule |
| `merchant-descriptor-normalization` | ✔ | ✔ | ✔ | Milliseconds (local) | Keeps intermediaries |
| `mcc-iso-18245` | — | ✔ (QR/intent) | ✔ | n/a | A merchant attribute, not the item bought |
| `ntropy-enrichment` | — | — | ✔ | API call | Person/organization counterparty; recurrence |
| `spade-enrichment` | — | (issuer only) | ✔ | Low ms (issuer path) | Transfer flags; US |
| `visa-merchant-search`, `heron-data` | ? | ? | ? | ? | Unverified |
| `splitwise-api` | — | — | ✔ | Minutes–days | Commercial licence needed |
| `owned-instrument-registry` | ✔ | ✔ | ✔ | n/a | Basis of every transfer rule |
| `user-clarification-prompts` | — | — | ✔ | User-paced | Clerical-review zone |
| `probabilistic-record-linkage` | ✔ (intent→purchase) | ✔ | ✔ | Milliseconds | Complete-linkage, TF-weighted |
| `pending-posted-supersession` | — | — | ✔ | On ledger update | Retraction semantics |
| `balance-continuity-check` | — | — | ✔ | On ledger update | Missing/duplicate detector |
| `transfer-pair-matching` | — | — | ✔ | On second leg (≤ days) | One-to-one ranked assignment |
| `credit-card-payment-matching` | ✔ (due date) | — | ✔ | Days | Never count bill payments |
| `p2p-p2m-classification` | — | ✔ (QR/intent `mc`) | ✔ | Immediate / learned | Conservative default |
| `transfer-type-heuristics` | — | — | ✔ | Immediate | Wallet, cash, investment, loan, rent |
| `refund-reversal-matching` | — | — | ✔ | Days–months | Partial refunds; provisional chargebacks |
| `reimbursement-matching` | — | — | ✔ | Days–weeks | Subset-sum plus confirmation |
| `recurring-series-detection` | ✔ (prediction) | — | ✔ | Batch, daily | Habits vs obligations |
| `subscription-intelligence` | ✔ | — | ✔ | Daily | MVP subset only |

---

## Implications for BRAKE architecture

### 1. Adapter contract additions (reconciliation-critical)

Every adapter should emit the following. These are proposals; the core model currently lacks some of them.

1. **Deterministic observation IDs** derived from provider IDs plus a content hash, so re-delivery is idempotent. Examples: Plaid `transaction_id`, an Android notification key plus post time, the SMS body hash plus minute.
2. **Typed, namespaced references:** `rail_reference` (UPI RRN, Pix `EndToEndId`, FPID, SEPA `endToEndId`), `provider_transaction_id`, `provider_pending_id`, `mandate_id` (SEPA mandate + creditor ID; UPI UMN), `order_id` (namespace = merchant key).
3. **Supersede and retract semantics:** Plaid `removed`; Brazil mutable IDs; UK `TransactionMutability: Mutable`; AA re-fetch. *Proposal:* add `supersedes?: ObservationId[]` and a retraction event to the observation stream.
4. **Balance-after.** *Proposal:* add `balanceAfter?: Money` to `Observation` (separate from `balance_snapshot` context), with a `balanceType` (`available` / `booked` / `unknown`). AA (`currentBalance`, documented "Available balance"), UK OB (`Balance`, optional, typed) and many alerts can carry it. Plaid `running_balance` is hidden from public docs. It is a near-decisive match key (E1, E3) when present.
5. **Time precision.** *Proposal:* `occurredAt` gets `precision: "minute" | "second" | "date"` and a `tzSource` (`explicit` / `institution` / `device` / `unknown`), so date-only records are compared as intervals.
6. **Counterparty legal-person type.** *Proposal:* `counterparty.personType?: "person" | "organization"` with a confidence, from Brazil `partiePersonType`, Ntropy `counterparty.type`, ISO `GP2P`/`MP2B`, or a UPI QR/intent `mc`. Hash third-party identifiers (VPA, CPF, account numbers) with a per-user salt before storing them.
7. **Purpose and type codes** pass through as `TypeHint`s with machine-readable reasons (`iso_purpose:CCRD`, `plaid_pfc:LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, `cdr_type:TRANSFER_OUTGOING`, `aa_mode:ATM`, `fk_type:transfer`). Adapters never decide BRAKE types; they report vendor vocabulary.
8. **Sign normalization.** The conventions differ:
   - Plaid: amount positive = outflow (on credit accounts a purchase is positive and a payment negative);
   - CDR: negative = outgoing;
   - UK OB: `CreditDebitIndicator`;
   - AA: `type`/`txnType`;
   - Brazil: `creditDebitType`;
   - Ntropy: `entry_type`, with Plaid Enrich `direction` and absolute amounts;
   - FinanceKit: `creditDebitIndicator`.

   Adapters must emit `direction` plus a positive amount. Unit-test the credit-card account cases explicitly.
9. **The raw descriptor stays on the device** (needed for normalization and user inspection, with an expiring excerpt). Server components never persist it.

### 2. Normalization pitfalls (checklist)

- Pending and posted descriptors differ; downweight merchant mismatch for those pairs.
- `date` semantics differ between pending (occurred) and posted (posted) records in Plaid. Use `authorized_date` for cadence and proximity.
- Default midnight times (`00:00:00`) are dates, not times.
- Plaid `mask` is not unique within an Item; `account_id` can change. AA `txnId` stability across fetches is untested.
- Same standard, different fields: FinecoBank does not populate `endToEndId`; BNP omits `creditorId`.
- MCC describes the merchant, not the purchase. Marketplace and app-store MCCs say nothing about the item.
- A card alert's "available limit" is not a balance.
- FX: email totals are in the merchant's currency; the bank shows the billing currency plus a separate FX-fee line. Use `foreignCurrencyAmount` / `InstructedAmount` when present; otherwise a tolerance band with a lower weight.
- One order ↔ several charges, and several orders ↔ one charge: link, don't merge.
- Round amounts: TF-adjust (₹100, ₹500, $10, $20 are weak evidence).

### 3. Spending semantics (what counts)

| Type | Discretionary pace | "Spent this month" | Cash flow |
|---|---|---|---|
| purchase (non-essential) | ✔ | ✔ | ✔ |
| purchase (essential: rent, utilities, groceries) | ✖ (shown separately) | ✔ | ✔ |
| subscription | ✖ (fixed costs) unless the user marks it discretionary | ✔ | ✔ |
| fee, tax | ✖ | ✔ | ✔ |
| refund | nets the original | nets the original's period | ✔ on arrival |
| reimbursement / shared expense | nets the original (personal share) | nets | ✔ |
| transfer: own account / wallet load | ✖ | ✖ (wallet load counts only if wallet spends are unobservable, flagged "unitemized") | ✔ |
| transfer: family / p2p_other (unknown) | ✖ until labelled | ✖ (shown as "unclassified outflow") | ✔ |
| credit_card_payment | ✖ | ✖ (card purchases already counted; "unitemized card spending" if the card is not connected) | ✔ |
| investment, loan_payment | ✖ | ✖ (commitments) | ✔ |
| cash_withdrawal | ✖ | "cash (untracked)" bucket | ✔ |

This table is the main protection against the brief's trust failure ("incorrectly calling transfers 'spending' destroys trust").

### 4. Capability-registry facts (by country, platform, institution)

Reconciliation needs a **third axis: institution/ASPSP/FIP**, because key availability varies within a country. Proposed capability IDs and facts, as of 2026-10-04:

| Capability id | Scope | Status | Evidence |
|---|---|---|---|
| `data:plaid.pending-link` | US (per institution) | limited | `pending_transaction_id` "where applicable"; not all institutions provide pending [1]; "if Plaid matches" wording unverified [2] |
| `data:plaid.recurring-streams` | US | available (add-on) | [1] |
| `data:plaid.pfc-v2` | US | available | default for enablements on or after 2025-12-03 [1] |
| `data:plaid.mcc` | US | limited (beta) | [1] |
| `data:plaid.running-balance` | US | unknown | in spec since 1.733.0 but `x-hidden-from-docs`; posted only; per institution [1][27] |
| `data:open-banking-ais.pending-link` | GB | unavailable | no field in v4.0.1 [7] |
| `data:open-banking-ais.purpose-code` | GB | emerging | v4.0.1 fields; adoption unverified; `CCRD` semantics ambiguous [7][8] |
| `data:open-banking-ais.mcc` | GB | limited | `MerchantDetails` optional [7] |
| `data:berlin-group.end-to-end-id` | EU (per ASPSP) | limited | Fineco "not used" (2019 snapshot) [10] |
| `data:berlin-group.mandate-id` | EU (per ASPSP) | limited | [9][10] |
| `data:cdr.pending-link` | AU | unavailable | explicit in the standard [11] |
| `data:cdr.transaction-type` | AU | available | enum [11] |
| `data:open-finance-br.counterparty-person-type` | BR | available | `partiePersonType`; tax ID mandatory since 2023-05-02 [12] |
| `data:open-finance-br.stable-id` | BR | limited | mutable until `TRANSACAO_EFETIVADA` [12] |
| `rail:pix.end-to-end-id` | BR | available | 32 characters, UTC minute with ±12 h tolerance [13] |
| `data:account-aggregator.pending` | IN | unavailable | posted-only schema (XSD consulted; v2.0.0 unverified) [6][25] |
| `data:account-aggregator.balance-after` | IN | available (re-verify for v2.0.0) | `currentBalance` required in the XSD consulted [6]; Deposit v2.0.0 changed mandatory flags [25] |
| `data:account-aggregator.card-mcc` | IN | limited | required in schema; FIP population unverified [6] |
| `rail:upi.rrn` | IN | available (in rail) | 12-character RRN in Google's Issuer Switch model (mirror; canonical path removed) [15]; NPCI spec and exposure via alerts/narration unverified |
| `rail:upi.payee-persona-visible` | IN | limited | only via QR/intent `mc` or heuristics [15] |
| `rail:upi.mandate` | IN | available | recurrence patterns [15] |
| `ext:splitwise` | GLOBAL | limited | non-commercial self-serve terms [19] |
| `data:financekit.status-type` | iOS (US accounts; coverage per FinanceKit stream) | available | [14] |

### 5. Evaluation plan

- **Synthetic scenario suite** (deterministic fixtures):
  - the brief's 4-observation example;
  - two identical coffees;
  - split shipments;
  - fuel hold;
  - tip;
  - FX purchase plus fee line;
  - UPI failure plus reversal;
  - card bill paid with the card both connected and not connected;
  - own transfer with both legs and with one leg;
  - rent P2P;
  - partial refunds;
  - a Splitwise-style 3-way split;
  - App Store aggregated subscriptions;
  - price creep;
  - weekday-coffee habit.
- **Metrics:**
  - auto-merge pairwise precision ≥ 0.995 (over-merge hides spending);
  - recall reported separately;
  - "false spending" rate (transfers counted as spend) as the top-line trust metric;
  - questions asked per user-week;
  - recurring precision@mature.
- **User corrections** ("Not the same", "This is a transfer") are labelled pairs used to re-estimate m/u values globally. Only aggregated, consented statistics leave the device.

---

## Risks, policy constraints and ethical concerns

- **Over-merging hides spending; over-splitting double counts it.** Both damage trust. Mitigations: one-event-per-source, complete linkage, keeping enrichment-only duplicates out of totals (architecture), visible provenance, one-tap "Not the same".
- **Mislabelling transfers as spending is the brief's named trust failure.** The conservative default is "unclassified outflow", kept out of discretionary pace. The opposite error (hiding real spending as "transfer") lets small merchants on personal VPAs vanish. Counter it with behavioural features and per-counterparty questions.
- **Third-party personal data:** P2P counterparties, landlord names, family members, CPFs and VPAs belong to people who did not consent to BRAKE. Hash identifiers with a per-user salt on device, show names only from the user's own data, never upload them, and allow deletion per counterparty.
- **Sensitive inferences:** recurring transfers reveal family support, rent, relationships, gambling (MCC 7995), medical and charity giving. Never use them in server-side analytics. Keep them out of any "regret" model unless the user opts in. Do not surface them in shareable screens.
- **Vendor enrichment** (Plaid Enrich, Ntropy, Spade) sends descriptors off-device. It requires explicit per-source consent and DPAs, and conflicts with local-first defaults. India's DPDP Act and GDPR purpose-limitation apply (details in the privacy stream).
- **Splitwise terms** prohibit fee-based use of the self-serve API and require explicit end-user consent [19].
- **Subscription nudges must not become dark patterns or scolding.** No guilt framing ("You wasted…"), at most one reminder per cycle, and "keep" must be as easy as "review". The US federal "click-to-cancel" rule was vacated in 2025 **(unverified in this session)**, so regulatory protection for cancellation varies; BRAKE should stay neutral and informative.
- **Corrections after the fact:** reversals, chargebacks lost and supersessions can retract insights already shown. BRAKE must correct itself visibly and calmly. Never leave a stale "38% above pace" message standing.
- **Regional rules unverified this session:** RBI e-mandate pre-debit and AFA thresholds; RBI failed-transaction TAT; card-network free-trial rules. Re-verify against primary sources before building features on their exact parameters.
- **Licences of the open-source references** (checked 2026-10-04): Sure is **AGPL-3.0** [22][26], so copying its code would bring copyleft obligations for a network service. Actual Budget's `LICENSE.txt` is **MIT** [23]. Re-implement Sure's ideas from this description; do not copy its code.
- **Ecosystem schema drift:** India AA moved to Deposit FI schema v2.0.0 in mid-2025 [25]; UK OB v4 adoption by production banks is unverified; the Berlin Group per-bank facts date from 2019–2020. Every capability fact derived from a schema file must carry the schema version and an "as of" date in the registry.

---

## Open questions

1. Does AA `txnId` stay stable across repeated fetches for the same FIP account, and is the RRN reliably present in UPI narrations, per major bank? This needs a data-collection study with consenting testers.
2. Which Indian banks' SMS and app notifications include balance-after and the UPI RRN, and in which formats? This decides how often SMS/notification ↔ AA joins can be near-deterministic.
3. Does FinanceKit keep the same `Transaction.id` from `authorized`/`pending` to `booked`?
4. How often does Plaid *fail* to set `pending_transaction_id` (per institution), and how should BRAKE weigh fuzzy supersession when it is missing?
5. What are realistic m/u values per pair type and country? This needs a consented labelled dataset or a synthetic generator calibrated on testers' real data, processed on device.
6. What are the right materiality thresholds and question budget per user? This needs A/B tests on answer rates and annoyance.
7. Should P2P payments to a counterparty later labelled "merchant" be counted retroactively in past discretionary pace (rewriting history) or only from now on?
8. Can UPI QR/intent `mc` values observed by BRAKE be cached per payee VPA to classify later non-BRAKE-initiated payments to the same VPA? The privacy and accuracy trade-offs are open.
9. What do EMI conversions, card-on-UPI payments and BBPS bill-pay look like in AA credit-card and deposit records? This needs real statement samples.
10. Which subscription-intelligence feature actually changes decisions (renewal "keep/review", trial-ending, price increase)? Measure intervention value before building duplicate or dormant detection.
11. Is Plaid Recurring worth its add-on cost if BRAKE's own engine gets within a few points of it on US data?
12. Should BRAKE ship a per-country merchant dictionary, and how is it built and updated without uploading user descriptors (for example from public merchant lists and opt-in contributions)?
13. Verify Visa Merchant Search, Heron Data and Ntropy coverage and terms when vendor sites are reachable.

---

## References

1. Plaid OpenAPI specification `2020-09-14_1.762.0`: https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml (repo: https://github.com/plaid/plaid-openapi). Supports:
   - the field definitions of `Transaction`/`TransactionBase`, `TransactionStream`, `RecurringTransactionFrequency`, `TransactionStreamStatus`, `PersonalFinanceCategory` (confidence levels, v1/v2 and the 2025-12-03 cut-over), `TransactionCounterparty`/`CounterpartyType`, `TransactionCode`, `PaymentMeta`, `TransactionsSyncResponse`, `LinkTokenTransactions.days_requested`, Enrich request/response, `CreditCardLiability` and `AccountBase`;
   - the endpoint descriptions for `/transactions/sync` (1–4 checks per day) and `/transactions/recurring/get` (add-on, ≥180 days of history).
2. Plaid, "Transactions — Transaction states": https://plaid.com/docs/transactions/transactions-data/. Consulted as a **search-result summary only** (direct fetch blocked). Supports: pending→posted after 1–5 business days; pending ID in `removed` and new posted record in `added`; `pending_transaction_id` set when Plaid matches; authorization holds (gas stations, hotels, rental cars) disappearing.
3. Plaid, "API — Transactions": https://plaid.com/docs/api/products/transactions/. Search-result listing only; content verified through [1].
4. Plaid, "Transactions webhooks": https://plaid.com/docs/transactions/webhooks/. Search-result summary: `TRANSACTIONS_REMOVED` fires most commonly for pending transactions.
5. Plaid PFC taxonomy CSV (third-party mirror of https://plaid.com/documents/pfc-taxonomy-all.csv, which was blocked): https://github.com/gburger5/Financial-Assistant/blob/HEAD/server/pfc-taxonomy-all.csv. Supports: PFCv2 detailed categories and the v1 mapping (transfer, loan, BNPL and rent categories; no refund or wallet category).
6. Sahamati Account Aggregator FI schemas: https://github.com/Sahamati/account-aggregator-standards. Files: `schemas/deposit/deposit.xsd` (Transaction attributes, mode enum, posted-only `Transactions`) and `schemas/credit_card/others_creditcard.xsd` (card transaction `mcc`, `maskedCardNumber`, statement/due fields). Re-fetched 2026-10-04. It is not shown to be ReBIT's Deposit v2.0.0; see [25].
7. UK Open Banking Read/Write API, Account and Transaction API v4.0.1: https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/account-info-openapi.yaml. Supports: the `OBTransaction6` fields, `Status`, `TransactionMutability`, timezone requirement, `CategoryPurposeCode`, `MerchantDetails`, `CurrencyExchange`, `Balance`, and the absence of a pending link.
8. Open Banking UK ISO External Code Sets: https://raw.githubusercontent.com/OpenBankingUK/External_Internal_CodeSets/main/ISO_External_Codeset.csv. Supports: definitions of `CCRD`, `DCRD`, `GP2P`, `MP2P`, `MP2B`, `SALA`, `LOAN`, `TAXS`, `SUPP`, `CASH`, `SWEP`, `TOPG`, `RRCT`.
9. NextGenPSD2 implementation by Consorsbank/BNP Paribas, v1.3.6 dated 2020-08-14, last updated 2020-11-05 (historical copy in Yolt's provider repo): https://github.com/Yolt-group/bespoke-providers/blob/HEAD/bespoke-consorsbank/swagger/psd2-api-bnp-wagger-v1.3.6.yaml. Supports: `accountReport.booked/pending`; the bank's subset of `transactionDetails`.
10. FinecoBank PSD2 API v1.3, dated 2019-02-14 (historical copy in Yolt's provider repo): https://github.com/Yolt-group/bespoke-providers/blob/HEAD/bespoke-fineco/swagger/fineco/finecobank-psd2-api-v2.yaml. Supports: the full NextGenPSD2 `transactionDetails` field list; `entryReference`/`endToEndId` "currently not used"; `mandateId`/`creditorId` semantics.
11. Australian Consumer Data Standards v1.36.0, banking API: https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/swagger-gen/api/cds_banking.json (repo: https://github.com/ConsumerDataStandardsAustralia/standards). Supports: `BankingTransactionV2` fields, the type enum, and the "no provision … to correlate a pending transaction with an associated posted transaction" statement.
12. Open Finance Brasil Accounts API v2.4.2: https://github.com/OpenBanking-Brasil/openapi/blob/main/swagger-apis/accounts/2.4.2.yml. Supports: `transactionId` immutability, `completedAuthorisedPaymentType`, the `EnumTransactionTypes`, `partieCnpjCpf` (mandatory since 2023-05-02, IN BCB 371) and `partiePersonType`.
13. Open Finance Brasil Payments API v1.2.0: https://github.com/OpenBanking-Brasil/openapi/blob/main/swagger-apis/payments/1.2.0.yml. Supports: the Pix `EndToEndId` format (32 characters, ISPB, UTC `yyyyMMddHHmm`, uniqueness in SPI).
14. Apple FinanceKit documentation: https://developer.apple.com/documentation/financekit/transaction (JSON: https://developer.apple.com/tutorials/data/documentation/financekit/transaction.json), `TransactionStatus`, `TransactionType`, and the framework overview https://developer.apple.com/documentation/financekit. Supports: field names, enums, iOS 17.4 availability and entitlement requirements.
15. Google Cloud Payment Gateway, Issuer Switch API v1 protos (`google.cloud.paymentgateway.issuerswitch.v1`, third-party mirror; the canonical `googleapis/googleapis` path returned 404 on 2026-10-04, so this is secondary evidence about a vendor's UPI model, not NPCI's spec): https://github.com/PatrickKoss/grpc-gateway-example/tree/HEAD/include/googleapis/google/cloud/paymentgateway/issuerswitch/v1 (`common_fields.proto`, `transactions.proto`). Supports: the UPI data-model concepts used here:
    - participant persona `PERSON`/`ENTITY`;
    - merchant MCC, `LARGE`/`SMALL`, `ONLINE`/`OFFLINE`, and brand/legal/franchise names;
    - RRN length of 12 and `OriginalRRN`;
    - payer account types including `CREDIT` and `PPIWALLET`;
    - mandate recurrence patterns, rule types and amount rules, and the UMN.
16. Ntropy SDK: https://github.com/ntropy-network/ntropy-sdk (`ntropy_sdk/transactions.py`, `CHANGELOG.md` 5.6.0 dated 2026-08-29, `tests/v3/test_recurrence_models.py`). Supports: counterparty `person`/`organization`, intermediaries, recurrence types and groups, and the periodicity enum.
17. Spade Card Enrichment API OpenAPI v2.7.3 (third-party mirror by API Evangelist): https://github.com/api-evangelist/spade/blob/main/openapi/spade-card-enrichment-api-openapi.yml. Supports: `transferType` internal/external, `isPeerToPeer`, `isDigitalWallet`, `isAdjustmentOrRefund`, `recurrenceInfo` and `thirdParties`. Verify against Spade's own documentation.
18. MCC dataset (community-maintained, not ISO; contains errors such as 6011's label): https://github.com/greggles/mcc-codes (`mcc_codes.json`). Supports: the MCC descriptions listed in C2 (4829, 5542, 5815–5818, 5968, 6010–6012, 6051, 6211, 6300, 6513, 7011, 7512, 7995, 8398, 9311).
19. Splitwise API documentation: https://github.com/splitwise/api-docs (`splitwise.yaml`, `schemas/expense.yaml`, `schemas/share.yaml`). Supports: OAuth 2 / API key, expense and share fields, and the non-commercial terms and consent requirements.
20. Splink documentation: https://github.com/moj-analytical-services/splink. Files: `docs/topic_guides/theory/fellegi_sunter.md`, `docs/topic_guides/comparisons/term-frequency.md`, `docs/topic_guides/blocking/blocking_rules.md`, `docs/topic_guides/evaluation/clusters/graph_metrics.md`. Supports: λ/m/u definitions, additive match weights, TF adjustments, blocking guidance, bridges and density as false-positive signals.
21. Fellegi, I. P. and Sunter, A. B. (1969), "A Theory for Record Linkage", *Journal of the American Statistical Association* 64(328), 1183–1210. Bibliographic reference only, not fetched. Supports: the three-region (link / possible link / non-link) decision rule.
22. Sure (open-source personal finance app, Maybe Finance fork): https://github.com/we-promise/sure. Files: `app/models/recurring_transaction/identifier.rb` (7.5% running-mean clustering, minimum occurrences, 45-day recency, ±2-day circular day-of-month, exclusions and documented failure cases) and `app/models/family/auto_transfer_matchable.rb` (4-day auto / 30-day manual windows, 10% FX band limited to linked accounts, ranked greedy one-to-one assignment).
23. Actual Budget: https://github.com/actualbudget/actual. Files: `packages/loot-core/src/server/schedules/find-schedules.ts` (schedule patterns, ±2-day search, rank formula, transfer exclusion) and `packages/loot-core/src/shared/rules.ts` (`getApproxNumberThreshold` = 7.5%).
24. BRAKE internal: `docs/brief.md` (requirements) and `docs/architecture/fusion-and-reconciliation.md` (current fusion and reconciliation design that this document supports).
