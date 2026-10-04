# Privacy, legal and regulatory constraints for BRAKE (research stream 11)

> **Scope.** The privacy, data-protection, financial-regulation, interception and platform-policy
> constraints on every signal source BRAKE might use, and the privacy requirements the architecture
> must meet as a result. Jurisdictions in depth: EU (GDPR, ePrivacy, AI Act, PSD2/PSD3), UK (UK GDPR,
> Data (Use and Access) Act 2025, FCA open banking), India (DPDP Act 2023 and DPDP Rules 2025, RBI
> Account Aggregator, RBI payment-data localisation, CERT-In, IT Act), United States (GLBA, FTC Act,
> CFPB Section 1033, CCPA/CPRA and other state laws, Washington My Health My Data Act, wiretap
> statutes). Platforms: Google API Services User Data Policy and Workspace policy, Google Play, Android
> OS, Apple App Store and frameworks, Chrome Web Store. Card data: PCI DSS. Technical patterns:
> on-device processing, local-first storage, encryption, retention, consent receipts, provenance,
> federated learning and differential privacy, LLM processing.
>
> **Date:** 2026-10-04. Every time-sensitive claim carries an evidence tag (see "Evidence legend"
> below). **This is engineering and product research, not legal advice.** Every [U] item has to be
> confirmed by qualified counsel in that jurisdiction before anyone relies on it.
>
> **Fact-check pass (2026-10-04).** An adversarial review re-checked about 30 load-bearing claims. It
> corrected several items: the Android 17 SMS OTP scope, the AI Act Digital Omnibus status, UK open
> banking re-authentication, the AA Directions citation, DPDP minimum-retention rules, TRAI suffix
> semantics and the Chrome Web Store citation. It also added missing items: Play Protect sideload
> blocking in India, the low-RAM listener limit and Android developer verification. Results are in
> "Verification log" at the end. Most regulator sites (EUR-Lex, RBI, MeitY, CFPB, FTC, eCFR, Google
> support and policy sites, developer.chrome.com) were still blocked during the review. Where a
> statute or policy text could only be read from a verbatim copy in a public GitHub repository, the
> claim stays tagged [S] and the log says so.
>
> **Key takeaways for BRAKE**
>
> 1. **Parsing on the device is the strongest legal de-risker BRAKE has.** Under Apple's definition,
>    data that is processed on the device and not transmitted off it is not "collected" [V]. Keeping
>    message content on the phone also keeps it away from any person other than the recipient, which
>    is the core of the interception theories (UK IPA, California CIPA) [U]. It also shrinks BRAKE's
>    exposure to CCPA "sensitive personal information" (the contents of email and text messages) [U],
>    to GDPR Article 9 inferences and to Google Limited Use transfer rules [V]. Make "extract facts on
>    the device, discard the raw message" the default for SMS, notifications and email.
> 2. **India: BRAKE cannot itself consume Account Aggregator data.** A Financial Information User must be
>    "registered with and regulated by any financial sector regulator" [S]. That wording appears in the
>    2016 Master Direction and is kept in the RBI (NBFC – Account Aggregator) Directions, 2025. The
>    Indian MVP should rely on Android notification access and SMS bank alerts on the device. Google
>    Play has an exception for "SMS-based money management" covering READ_SMS and RECEIVE_SMS [S]. AA
>    should come later, through a regulated partner. The DPDP Rules are G.S.R. 846(E), dated 13 Nov
>    2025. Consent-manager registration (Rule 4) commences on **13 Nov 2026** and the substantive
>    obligations on **13 May 2027** [S]. Build to DPDP now, and note that DPDP Rules 6(1)(e) and 8(3)
>    set a **one-year minimum** retention for processing logs and the associated personal data [S].
>    That floor cuts against BRAKE's "discard raw data" defaults, and counsel needs to settle how they
>    fit together (see A6).
> 3. **US: Section 1033 is not in force.** The 2024 rule is enjoined (E.D. Ky. preliminary injunction,
>    Oct 2025) and the CFPB is rewriting it. The reconsideration NPRM went to OIRA in **early Aug 2026**,
>    reported on 6 Aug 2026 [S]. Whether it has been published in the Federal Register as of
>    2026-10-04 could not be confirmed (unverified). US bank data therefore depends on
>    aggregator contracts (Plaid and others), not on a legal right of access. Even so, BRAKE should
>    adopt the 2024 rule's obligations for third parties as its design baseline [U]: authorisation of
>    at most one year, no targeted ads, no cross-selling, no sale of data, and a revocation mechanism.
>    BRAKE should also assume the GLBA Safeguards Rule applies [U].
> 4. **Purchase data reveals special categories and health data.** Under the CJEU case law on indirect
>    revelation of sensitive data, pharmacy, clinic, religious-donation, party-donation and union-dues
>    payments can be GDPR Article 9 data [U]. In Washington State, inferring health status from
>    non-health data creates "consumer health data", which needs separate consent and carries a
>    private right of action [U]. BRAKE's "Medical" label needs special-category handling (explicit
>    consent, or keep the inference on the device and out of every cross-user use).
> 5. **Gmail is the most heavily regulated source.** `gmail.readonly` is a Restricted scope, and so is
>    `gmail.metadata` [S]. Under `gmail.metadata` the `q` search parameter "cannot be used" (Gmail API
>    discovery document, revision 20260928) [V]. Server-side use triggers Google's
>    annual third-party security assessment [V]. Limited Use applies to derived data as well as raw
>    data [V]. It forbids ads, sale, credit-worthiness use and human reading without consent [V], and
>    the Workspace policy forbids training non-personalised AI/ML models [S]. Gmail-derived facts must
>    therefore never feed cross-user models. Two lighter routes exist: a user-configured forwarding
>    address, where BRAKE is the intended recipient, and an on-device client.
> 6. **The EU and UK require explicit consent and a DPIA.** In the EU, reading other apps'
>    notifications on the device needs consent under ePrivacy Article 5(3) [U]. A DPIA is effectively
>    mandatory, because BRAKE meets several WP248 high-risk criteria [U]. AIS data has to come through
>    a licensed AISP or an agent arrangement [U]. Since 2 Feb 2025, AI Act Article 5 has banned
>    manipulative techniques and the exploitation of economic vulnerability [U]. The Article 50
>    transparency duties have applied since **2 Aug 2026**. The Digital Omnibus on AI, Regulation (EU)
>    2026/1744 (in force 27 Jul 2026), did not move them; it deferred only the high-risk obligations [S].
>    A conversational "Ask BRAKE" must therefore say that it is an AI system. BRAKE's friction
>    must be configured by the user, aligned with the user's own goals, transparent, and never
>    deceptive.
> 7. **The OS vendors keep tightening access.** Android 15 redacts notifications that contain an OTP
>    when they go to untrusted listeners [V]. Android 17 holds WebOTP SMS back for three hours from
>    any app that is not the intended recipient, whatever the app's target SDK [V]. For apps that
>    **target Android 17 (API 37)**, the same three-hour hold also covers *standard* SMS that contain an
>    OTP [V]. In India, Play Protect blocks internet-sideloaded apps that request SMS or
>    notification-listener access [S]. Apple requires explicit permission before
>    personal data goes to third-party AI (5.1.2(i)) [V]. FinanceKit is a managed entitlement that
>    Apple reviews case by case [V]. Adapters must expect degraded content and must never depend on,
>    or keep, OTPs.
> 8. **PCI DSS: stay out of scope by never holding a full card number (PAN).** Store at most the last
>    four digits. Receipt photos, screenshots and OCR must detect and redact Luhn-valid PANs before
>    anything is stored or sent [U].
> 9. **Model processing should run on the device by default.** Apple Foundation Models (on-device or
>    Private Cloud Compute) and Gemini Nano via AICore are the options; AICore "doesn't store any
>    record of the input data or the resulting outputs" [V]. A cloud LLM needs separate opt-in
>    consent, contracts for zero retention and no training, pre-redaction, and defences against prompt
>    injection, since emails are attacker-controlled input.
> 10. **Every adapter must declare a machine-readable `PolicyProfile`.** It covers legal basis, consent
>     receipt, where processing happens, retention class, whether cross-user learning is allowed,
>     special-category risk and third-party data. The capability registry must also carry legal facts
>     with `as_of` dates. That way features degrade by policy as well as by technical availability.

---

## Evidence legend and method

| Tag | Meaning |
|-----|---------|
| **[V]** | Verified in this session against the fetched text of a primary source (official docs, spec, policy page) or an official machine-readable spec. |
| **[S]** | Supported only by a secondary source, a search-engine result snippet, or a verbatim copy of a statute or policy in a public GitHub repository (fact-check pass) retrieved in this session. The primary page could not be fetched. |
| **[U]** | Unverified. This comes from the researcher's prior knowledge (training data to mid-2026). The primary source was **blocked by this session's network egress proxy**, so it could not be re-checked. Treat it as a hypothesis for counsel to confirm. |

**Method note.** The session's web search budget was exhausted after a handful of queries. Its outbound
proxy blocked most regulator and legal domains (EUR-Lex, EDPB, ICO, legislation.gov.uk, RBI, NPCI,
MeitY/PIB, CFPB, FTC, eCFR, Cornell LII, CPPA, Washington legislature, PCI SSC, Google support and
developer sites, Microsoft Learn, Chrome developer docs). `developer.apple.com`, `developer.android.com`,
`github.com` and `raw.githubusercontent.com` were reachable. Google's policy texts were read from
cached copies and public secondary analyses (see References). That is why many legal statements are
tagged [U]. **Before launch in any country, a verification pass against primary sources is required**
(see Open questions).

---

## Sources investigated

This stream looks at each source **through a legal, policy and privacy lens**. Other streams (01-10, 12,
13) cover API mechanics in depth. The section has two parts:

- **Part A** covers the cross-cutting legal regimes. Every source inherits these.
- **Part B** covers each signal source or mechanism, using the template the other streams use.

### Part A — Cross-cutting legal regimes

#### A1. EU GDPR and UK GDPR

- **Role.** BRAKE is a *controller* for everything it decides to process. Vendors (cloud hosting, LLM
  providers, aggregators acting on BRAKE's instructions) are *processors* and need Article 28
  contracts [U]. An aggregator or AISP that provides a regulated service directly to the user is
  usually an independent controller [U].
- **Lawful basis (Art. 6).** Article 6(1)(b), performance of a contract, fits features the user
  explicitly asks for, such as "track my spending from these connected sources" [U]. Consent
  (Art. 6(1)(a)) is still needed where ePrivacy Art. 5(3) applies (see A2) and for optional analytics.
  Legitimate interests (Art. 6(1)(f)) is the realistic basis for **counterparty ("silent party")
  data**, such as payee names in transactions and senders inside receipts. It can be used **only** to
  provide the user's service, never for profiling those third parties. That is the position the EDPB
  took for PSD2 in Guidelines 06/2020 [U].
- **Special categories (Art. 9).** Transactions can reveal health (pharmacy, clinic, therapy), religion
  (church or temple donations), political opinions (party donations), trade-union membership (dues) and
  sex life (dating apps, clinics). The CJEU treats data that **indirectly** reveals such information as
  special category. See C-184/20 *OT* (1 Aug 2022), C-252/21 *Meta v Bundeskartellamt* (4 Jul 2023) and
  C-21/23 *Lindenapotheke* (4 Oct 2024), which concerned online pharmacy order data [U]. BRAKE's choices
  are three: (a) get **explicit consent** under Art. 9(2)(a) for categories that touch these areas;
  (b) keep the inference on the device and out of any cross-user use; or (c) suppress the category and
  show "Personal" instead.
- **Data minimisation and storage limitation** (Art. 5(1)(c), (e)) and **data protection by design and
  by default** (Art. 25) [U]. These directly back the brief's rules "collect, store, retain, transmit
  the minimum" and "persist extracted facts instead of raw emails".
- **DPIA (Art. 35).** The WP29/EDPB WP248 guidance lists nine high-risk criteria and says two or more
  usually require a DPIA. BRAKE meets at least five [U]:
  - evaluation and profiling (spending behaviour, regret prediction);
  - "sensitive data or data of a highly personal nature", where WP248 names financial data;
  - matching or combining datasets (bank + email + SMS + notifications);
  - innovative technology (on-device ML, LLM extraction);
  - potentially vulnerable data subjects (people in financial difficulty).

  **A DPIA before EU/UK launch is a must.**
- **Automated decision-making (Art. 22).** This covers decisions "based solely on automated processing"
  that produce legal or similarly significant effects. Most BRAKE nudges ("38% above your usual pace")
  probably fall outside it. **Hard blocking of payments, shielding of essential apps, or anything
  feeding credit or eligibility decisions could fall inside.** The CJEU read "decision" broadly in
  C-634/21 *SCHUFA* (7 Dec 2023) [U]. The design rule: **every intervention can be overridden by the
  user, the user configures it, and it is explainable.** BRAKE never feeds lenders.
- **UK.** The Data (Use and Access) Act 2025 received Royal Assent on 19 Jun 2025 and was commenced in
  stages. Section 80 replaces UK GDPR Art. 22 with Articles 22A-22D, which are more permissive except
  where special-category data is involved. That section and most of the other data-protection
  amendments came into force on **5 Feb 2026** under the Commencement No. 6 Regulations (SI 2026/82)
  [S, as of 2026-10-04]. The Act also adds "recognised legitimate interests" and smart-data powers that
  will underpin the future open-banking regime [U].
- **Data subject rights.** Access (Art. 15), erasure (Art. 17), portability (Art. 20), one-month response
  (Art. 12(3)) [U]. These make **user export and delete** first-class product features.
- **Breach.** Notify the supervisory authority within 72 hours (Art. 33) and notify individuals without
  undue delay if the risk is high (Art. 34) [U].
- **Transfers.** EU to US transfers rely on the EU-US Data Privacy Framework (adequacy decision of
  10 Jul 2023) or on SCCs. LLM and cloud vendors must be checked [U].
- **Fines.** Up to EUR 20m or 4% of global turnover (Art. 83(5)) [U].

#### A2. EU ePrivacy Directive Art. 5(3) and UK PECR reg. 6 (terminal equipment)

- Storing information on, or gaining access to information already stored on, a user's device needs
  consent. The exception is where this is *strictly necessary* for a service the user explicitly
  requested [U].
- The EDPB's Guidelines 2/2023 on the technical scope of Art. 5(3) read "gaining access" broadly [U].
- BRAKE's position: a Notification Listener or SMS reader that accesses other apps' content is
  plausibly covered. Obtain **specific opt-in consent per source**, even if Art. 6(1)(b) is the GDPR
  basis. The proposed ePrivacy Regulation was withdrawn in 2025: the College approved the withdrawal on
  16 Jul 2025, and it was published as OJ C/2025/5423 on 6 Oct 2025 [S]. The Directive, as transposed
  nationally, therefore still governs. The Commission's "Digital Omnibus" proposal COM(2025) 837 of
  19 Nov 2025 would move the terminal-equipment rules into the GDPR. As of Sep 2026 it was still in the
  legislative procedure and not adopted [S]; re-check before relying on Art. 5(3).

#### A3. EU AI Act (Regulation (EU) 2024/1689)

- **Art. 5 prohibitions** have applied since **2 Feb 2025** [U]. They include:
  - (a) subliminal, purposefully manipulative or deceptive techniques that materially distort
    behaviour and cause significant harm;
  - (b) exploiting vulnerabilities due to age, disability or **"a specific social or economic
    situation"**.
- BRAKE's interventions aim to *help* the user, but BRAKE must still avoid deceptive urgency, fake
  scarcity, shaming, and targeting people *because* they are in financial distress.
- **Art. 50 transparency obligations** (telling people they are interacting with an AI system) have
  **applied since 2 Aug 2026** [S]. The Digital Omnibus on AI is Regulation (EU) 2026/1744: adopted
  8 Jul 2026, published in the OJ on 24 Jul 2026, in force 27 Jul 2026 [S]. It deferred the Annex III
  high-risk obligations to **2 Dec 2027** and the Annex I obligations to 2 Aug 2028. It did **not** delay
  Art. 50 or the Art. 5 prohibitions; it added new Art. 5 prohibitions that apply from 2 Dec 2026 [S].
  BRAKE's conversational features must therefore disclose that they are AI now.
- **Annex III high-risk** use cases include creditworthiness evaluation [U]. These obligations now apply
  from 2 Dec 2027 [S]. BRAKE must never score
  credit or feed lenders. Google Limited Use independently forbids using Google data for credit or
  lending [V].

#### A4. EU PSD2 → PSD3/PSR, and FiDA

- **Account information service (AIS)** is a regulated payment service. An AISP needs registration
  (PSD2 Art. 33) and professional indemnity insurance [U].
- PSD2 **Art. 67** limits an AISP to the designated accounts and transactions. It may **not request
  sensitive payment data** and may **not use, access or store data for purposes other than the AIS
  explicitly requested by the user** [U]. If BRAKE ever becomes an AISP, its whole product purpose has
  to be framed as the AIS the user asked for.
- Practical models [U]:
  - (i) BRAKE becomes an AISP;
  - (ii) BRAKE becomes a registered **agent** of a licensed AISP;
  - (iii) a licensed AISP provides the AIS to the user and, with the user's consent, delivers data to
    BRAKE, which is common under "licence-as-a-service" offerings. How (iii) is characterised varies
    by national competent authority and needs counsel. The EBA's Report on White Labelling
    (EBA/REP/2025/30, Oct 2025) flags these arrangements and plans supervisory-convergence work in
    2026 on whether the partner is an outsourcer, an agent or something else [S]. Model (iii) may
    therefore be re-characterised.
- Bank-side SCA re-authentication for AIS access moved from 90 to 180 days under Delegated Regulation
  (EU) 2022/2360, which has applied since 25 Jul 2023 [S]. Some aggregators still enforce 90 days.
- **PSD3/PSR**: a provisional political agreement was reached on 27 Nov 2025, and the ECON committee
  endorsed the texts in May 2026. As of 2026-10-04, formal adoption and OJ publication were
  unconfirmed [S]. The package includes a user-facing **permissions dashboard** for AIS access [U].
  **FiDA** status as of 2026 was not verified [U].

#### A5. UK open banking and FCA

- AIS needs FCA registration as an AISP, or BRAKE can act as an agent of one. Agents appear on the
  FCA register [U].
- Once FCA-regulated, BRAKE would be subject to the Consumer Duty [U].
- **Re-authentication differs from the EU.** The UK SCA-RTS Art. 10A (FCA PS21/19, in force 2022)
  removed periodic bank-side SCA for AIS access after the first connection. Instead, the AISP must have
  the user **reconfirm consent with the AISP every 90 days** (SCA-RTS Art. 36(6)), or stop background
  access [S]. Do not apply the EU 180-day model to UK users.
- Consent in the UK Open Banking (OBIE) spec is explicit and bounded. `/account-access-consents`
  carries `Permissions` (e.g. `ReadTransactionsDetail`, `ReadTransactionsDebits`),
  `ExpirationDateTime` ("If this is not populated, the permissions will be open ended") and
  `TransactionFromDateTime`/`TransactionToDateTime` [V]. That is a good model for BRAKE's own consent
  receipts.

#### A6. India: DPDP Act 2023 and DPDP Rules 2025

- **Status.** The DPDP Rules 2025 are G.S.R. 846(E), dated **13 Nov 2025** (Gazette ID
  CG-DL-E-14112025; PIB release 14 Nov 2025). A corrigendum, G.S.R. 892(E) of 10 Dec 2025, made clerical
  fixes only. The Act's own commencement notification is G.S.R. 843(E), of the same date [S].
  Commencement is phased [S]:
  - Rules 1, 2 and 17-21 (Data Protection Board) took effect on publication;
  - Rule 4 (Consent Manager registration) takes effect one year later, on **13 Nov 2026**;
  - Rules 3, 5-16, 22 and 23 (the substantive obligations), and the matching Act sections, take effect
    18 months later, on **13 May 2027**.

  No amendment changing this timeline was found as of 2026-10-04 (unverified against the eGazette).
- **Act obligations (to build for now)** [U]:
  - Notice in clear language, available in English or any Eighth Schedule language (s.5).
  - Consent that is "free, specific, informed, unconditional and unambiguous with a clear affirmative
    action", limited to the necessary data, and as easy to withdraw as to give (s.6).
  - "Certain legitimate uses" (s.7) are narrow.
  - Fiduciary duties (s.8): reasonable security safeguards, breach intimation to the Board **and to
    each affected Data Principal**, and erasure once the purpose is served or consent is withdrawn.
  - Children under **18** need verifiable parental consent, and **tracking, behavioural monitoring and
    targeted advertising directed at children are prohibited** (s.9). BRAKE is behavioural monitoring
    by nature, so it **must be 18+ only** in India.
  - Significant Data Fiduciaries (s.10) have extra duties (DPO in India, independent audit, periodic
    DPIA).
  - Rights: access to a summary, correction and erasure, grievance redressal, nomination (ss.11-14).
  - Cross-border transfer is allowed except to countries the government restricts (s.16). Sectoral
    rules with stricter localisation, such as RBI's, prevail.
  - Penalties reach **INR 250 crore** for a failure of security safeguards [U].
- **Rules details (from secondary summaries; check against the gazette)** [U]:
  - security safeguards include encryption, obfuscation and masking, and access control. **Rule
    6(1)(e)** requires the fiduciary to "retain such logs and personal data for a period of one year"
    [S, verbatim mirror];
  - **minimum retention (Rule 8(3)).** A Data Fiduciary must retain "such personal data, associated
    traffic data and other logs of the processing for a minimum period of one year from the date of
    such processing" for the Seventh Schedule purposes, and then erase it [S, verbatim mirror]. This
    is a **floor, not a ceiling**. It is in tension with BRAKE's "process then discard" (R0), "delete
    raw MIME within 24 h" (R0s) and "Disconnect and delete" rules for any India data that BRAKE
    processes as a fiduciary. Whether the floor reaches data processed only on the user's device, and
    whether keeping only content-free logs satisfies it, are open questions for counsel (see Open
    questions);
  - breach: intimate the Board without delay, with a detailed report within **72 hours**;
  - large e-commerce, gaming and social platforms must erase data after a period of inactivity, with
    48-hour prior notice;
  - Data Principal requests must be answered within a set period (reported as 90 days);
  - Consent Managers must be Indian companies meeting net-worth and technical conditions.
- **Interim regime.** Until the relevant DPDP provisions commence, IT Act s.43A and the **SPDI Rules
  2011** still apply. They classify "financial information such as bank account or credit card or debit
  card or other payment instrument details" as *sensitive personal data*. That means written
  (electronic) consent, a published privacy policy and "reasonable security practices", for example
  IS/ISO/IEC 27001 [U]. The DPDP Act omits s.43A on commencement [U].
- **Consent Managers** (DPDP s.6(7)-(9)) are interoperable consent platforms registered with the Board.
  None could be registered before 13 Nov 2026 [S]. They are a "later" integration target for BRAKE's
  per-source consent.

#### A7. India: RBI Account Aggregator, payment-data localisation, CERT-In, telecom

- **AA FIU eligibility.** Under para 3(1)(xii) of the 2016 NBFC-AA Master Direction
  (DNBR.PD.009/03.10.119/2016-17), a Financial Information User is "an entity registered with and
  regulated by any financial sector regulator" (RBI, SEBI, IRDAI, PFRDA) [S, verbatim mirror of the RBI
  page]. RBI's 2025 consolidation re-issued the framework as the **Reserve Bank of India (Non-Banking
  Financial Companies – Account Aggregator) Directions, 2025**, which keeps the same definition as
  definition (12) [S, third-party extract; issue date and clause number not checked against rbi.org.in].
  Cite the 2025 Directions going forward. **An unregulated budgeting app cannot be an FIU.** The routes
  are:
  - partner with a regulated FIU, with BRAKE as its technology service provider and the FIU as the
    consent-requesting entity;
  - obtain a registration that makes BRAKE a regulated entity, for example as an investment adviser.
    Whether that fits BRAKE's purpose is an open question.
- **The consent artefact is a model for BRAKE.** The Sahamati/ReBIT AA API spec v1.1.2 `ConsentDetail`
  requires [V]:
  - `consentStart` and `consentExpiry`;
  - `consentMode`, one of `VIEW|STORE|QUERY|STREAM`;
  - `fetchType`, `ONETIME` or `PERIODIC`;
  - `consentTypes`, from `PROFILE|SUMMARY|TRANSACTIONS`;
  - `fiTypes`, `DataConsumer`, `Customer`, `Purpose`, `FIDataRange`;
  - `DataLife` ("How long consumer is allowed to store data", unit `DAY|MONTH|YEAR|INF`);
  - `Frequency`.

  Sahamati's **Fair Use** templates cap purpose, frequency, validity, consent type and data range.
  AAs are the "primary enforcers" and FIPs can act as a second line [V].
- **Payment-data localisation.** RBI's circular of 6 Apr 2018 ("Storage of Payment System Data") and
  its 2019 FAQs require payment *system providers* (and, through them, their service providers) to
  store end-to-end payment data only in India. Data processed abroad must be brought back and deleted
  abroad within a short window [U]. BRAKE observing a user's *own* UPI alerts is not a system
  provider. **The rule does flow down** if BRAKE becomes a vendor to a PSO, TPAP, bank or FIU partner.
  The pragmatic default is **an India hosting region for Indian users' data** [U].
- **CERT-In Directions (28 Apr 2022, No. 20(3)/2022-CERT-In).** Reportable cyber incidents must be
  reported **within 6 hours**, and ICT logs must be kept for **180 days within India** [S, verbatim
  mirror]. Logs must therefore hold no message
  content (see PR-27).
- **Interception and unauthorised access.** The relevant law is the IT Act ss.43, 66 and 72A and the
  interception provisions of the Telecommunications Act 2023 / IT Act s.69 [U]. A user reading their
  own messages through their own app is not interception. The risk comes from **BRAKE's servers
  obtaining content**, which is another argument for doing the extraction on the device.
- **SMS sender headers.** Under TRAI's commercial-communication rules (TCCCPR 2018), transactional and
  service SMS use registered headers. The TCCCP (Second Amendment) Regulations 2025 (gazetted 12 Feb
  2025, with suffixes reported live from about 6 May 2025) added category suffixes: `-P` promotional,
  `-S` service, `-T` transactional and `-G` government [S, several secondary sources]. Several sources
  report that `-T` is now essentially OTP traffic, while bank debit and credit alerts are usually `-S`
  [S]. Rollout is uneven, and the same bank appears with and without a suffix [S]. **Use the suffix as
  a hint, not as a gate**: allowlist the 6-character bank header, treat `-P` as never-financial, and
  treat `-T` as likely OTP to discard. Allowlisting by header lets BRAKE avoid touching personal SMS at
  all.

#### A8. United States: GLBA and the FTC Safeguards Rule

- A "financial institution" is one "significantly engaged" in financial activities (activities
  "financial in nature" under BHC Act §4(k)) [S]. These include data processing of financial data [U].
  Personal-finance apps that aggregate account data are widely treated as covered, and the 2024
  §1033 rule required authorised third parties to comply with the GLBA Safeguards framework [U].
  **BRAKE should plan as if covered.**
- The amended **FTC Safeguards Rule** (16 CFR 314) requires [U]:
  - a Qualified Individual, a written risk assessment and a written information security program;
  - **encryption of customer information in transit and at rest**, and **MFA**;
  - secure disposal of customer information **no later than two years after last use** unless it is
    still needed;
  - change management, annual penetration tests and vulnerability scans every six months;
  - an incident response plan and an annual report to the board.
- Since **13 May 2024**, a *notification event* that "involves the information of at least 500
  consumers" must be reported to the FTC "as soon as possible, and no later than 30 days after
  discovery" (16 CFR 314.4(j)(1)) [S, verbatim mirror; effective date U].
- The GLBA Privacy Rule (Reg P) applies notice and **reuse/redisclosure limits** to nonpublic personal
  information received from banks through aggregators [U].

#### A9. United States: CFPB Section 1033 (Personal Financial Data Rights)

- **Status, as of 2026-10-04** [S]:
  - the rule was finalised in Oct 2024;
  - the first compliance date (1 Apr 2026) never took effect, because a federal court enjoined
    enforcement while the CFPB reconsiders;
  - an ANPR came in Aug 2025, covering data-access fees, who counts as a representative, security
    and privacy;
  - the injunction is a preliminary injunction from the E.D. Ky. (Oct 2025); the rule is enjoined, not
    vacated [S];
  - the reconsideration **NPRM was sent to OIRA in early Aug 2026**, reported on 6 Aug 2026 (one
    secondary source says 5 Aug). Publication was expected in late 2026 or early 2027 and had not been
    confirmed as of 2026-10-04 [S].
- **Design baseline even while enjoined.** The 2024 rule's authorised-third-party duties are a sound,
  defensible standard [U]:
  - limit collection, use and retention to what is *reasonably necessary* for the product the
    consumer asked for;
  - **no targeted advertising, cross-selling or sale** of covered data;
  - authorisation lasting **at most one year** before re-authorisation;
  - an easy revocation mechanism, with deletion on revocation;
  - GLBA-grade security.
- **Implication.** BRAKE's US bank connectivity rests on aggregator contracts and on bank-aggregator
  agreements, including possible **bank data-access fees**, a live issue in the reconsideration [S].
  It does not rest on a statutory right.

#### A10. United States: FTC Act §5 and health-data enforcement

- Deceptive or unfair practices cover:
  - misrepresenting data use;
  - **changing privacy terms retroactively** to use existing data for AI (FTC business blog,
    Feb 2024);
  - keeping data longer than needed [U].
- FTC orders have required **written data retention schedules** and minimisation, for example
  *Drizly* (2022) and *Blackbaud* (2024) [U]. Sensitive-data cases include *GoodRx* (2023, the first
  Health Breach Notification Rule case), *BetterHelp* (2023) and *Avast* (2024, browsing data) [U].
- The **Health Breach Notification Rule** was amended in 2024 (effective 29 Jul 2024). It applies to
  health apps that draw identifiable health information from multiple sources [U]. BRAKE stays clear
  of it unless it builds health-spend or medical-bill features that turn it into a personal health
  record.
- **COPPA** was amended in 2025 [U]. BRAKE should be 18+.

#### A11. United States: CCPA/CPRA, other state laws, Washington MHMDA

- **CCPA/CPRA (California)** [U; the SPI wording below was checked against a verbatim mirror of Civ.
  Code §1798.140(ae)(1)(E), S]:
  - The GLBA exemption is **data-level**. It covers only personal information collected or processed
    under GLBA. Email-derived, device-derived and inferred data stay in scope.
  - **"Sensitive personal information"** includes:
    - account log-in or financial account / card number *in combination with* access credentials;
    - precise geolocation;
    - **"the contents of a consumer's mail, email, and text messages unless the business is the
      intended recipient of the communication"**.

    BRAKE parsing SMS and email on its servers is therefore SPI processing. If the parsing happens only
    on the device and the content never reaches BRAKE, whether BRAKE has "collected" SPI at all is
    arguable, and counsel should decide. Consumers can **limit** SPI use to what is needed to provide
    the service (§1798.121).
  - **A forwarding-address design makes BRAKE the intended recipient** of what the user forwards.
  - CPPA regulations on **risk assessments, cybersecurity audits and ADMT** took effect on
    **1 Jan 2026**, with staggered compliance dates. ADMT duties attach to "significant decisions",
    which include financial services [U].
- **Other states.** About twenty states have comprehensive privacy laws by 2026 [U]. Most exempt GLBA
  *entities*, but some exempt only GLBA *data*. Maryland's MODPA took effect on 1 Oct 2025 and applies
  to processing from 1 Apr 2026 (unverified). It uses a strict "strictly necessary" standard for
  sensitive data and bans its sale [U]. BRAKE cannot count on an entity-level exemption.
- **Washington My Health My Data Act (RCW 19.373)** [U; the definition wording was checked against a
  verbatim mirror of RCW 19.373.010(8), S]:
  - "Consumer health data" covers "use or purchase of prescribed medication" (8)(b)(iv). It also
    covers information "derived or extrapolated from nonhealth information (such as proxy, derivative,
    inferred, or emergent data by any means, including algorithms or machine learning)" (8)(b)(xiii).
    Pharmacy purchases are therefore squarely in scope.
  - It needs **separate consent to collect** and separate consent to share, and a signed
    authorisation to sell.
  - There is no revenue threshold, and violations are enforceable through a **private right of
    action** under the Washington Consumer Protection Act. Nevada (SB 370) and Connecticut have similar
    consent rules, but Nevada's law does **not** create a private right of action (unverified).

  For a Washington user, BRAKE labelling a pharmacy or clinic spend as "Medical" is very likely
  consumer health data.

#### A12. Interception, wiretap and computer-misuse law (reading SMS, notifications, email)

- **US federal** [U]:
  - The Wiretap Act (18 U.S.C. §2511(2)(d)) allows interception with **one party's** consent, and the
    user is the recipient.
  - The Stored Communications Act is satisfied by **authorised** access through the user's OAuth
    grant.
  - The CFAA prohibits accessing a *bank's* systems with shared credentials outside its terms, so
    BRAKE must not scrape with credentials.
- **California CIPA** (Penal Code §§631, 632.7, 638.51) [U]:
  - It needs **all-party** consent for reading messages *in transit* and is heavily litigated against
    third-party "eavesdropper" vendors.
  - Reading messages *after delivery*, on the device, is a much weaker theory.
  - BRAKE should never sit in the message path (no proxying, no carrier/RCS interception) and should
    process content on the device.
- **UK IPA 2016** [U]:
  - Interception "in the course of transmission" can include a communication *stored in or by the
    system* after transmission (s.4(4)).
  - Lawful authority without a warrant generally requires sender **and** recipient consent (s.44).
  - Interception means making content available to a person **other than** the sender or intended
    recipient.

  Extraction on the device, *on behalf of the recipient*, with no human or server access to the
  content, is the defensible design. Uploading raw messages to BRAKE servers is the risky design.
- **India.** See A7.
- **Counterparties' data.** Messages and receipts contain third parties' data: payee names, UPI VPAs
  (often phone-number based), friends in shared bills, email senders. BRAKE needs:
  - a legitimate-interests and minimisation analysis (GDPR) [U];
  - no use beyond the user's service;
  - **keyed hashing of counterparty identifiers** for recurrence and transfer detection;
  - no contact-graph building. Apple 5.1.2(iv) bars building contact databases from user data [V].

#### A13. PCI DSS (card data)

- PCI DSS applies to entities that store, process or transmit cardholder data (the full PAN) or
  sensitive authentication data [U]. Version 4.0.1 is current, and its future-dated requirements
  became mandatory on 31 Mar 2025 [U].
- **Truncated** PANs (at most first 6 + last 4, or first 8 + last 4 for 8-digit BINs under PCI SSC
  guidance) are not cardholder data in scope [U].
- **Rule for BRAKE: never ingest, store or transmit a full PAN, CVV or PIN; keep `last4` only.**
- Risks:
  - OCR of receipts and screenshots can capture a full PAN;
  - users may paste card numbers into "manual entry";
  - a few issuers' emails show more digits.

  BRAKE needs Luhn-based PAN detection and redaction **before** persistence, logging or any network
  call.

#### A14. Platform policies

- **Google API Services User Data Policy** (last updated 15 Feb 2024) [V]. The fact-check pass
  re-confirmed the clauses below against the Open Terms Archive snapshot of the page, which still
  shows "Last updated February 15, 2024". developers.google.com itself was blocked:
  - "Request the minimum relevant permissions", with no "future proof" scopes and incremental auth
    in context.
  - Restricted and Sensitive scopes are subject to **Limited Use**. Use is limited to "providing or
    improving user-facing features that are prominent in the requesting application's user
    interface".
  - Transfers are allowed only for those features with consent, or for security, legal or M&A
    reasons.
  - Humans may not read the data except with affirmative agreement for specific messages, for
    security, for legal reasons, or for aggregated internal operations.
  - "Transferring, selling, or using user data for serving ads" and "to determine credit-worthiness
    or for lending purposes" are prohibited.
  - These requirements "apply to the raw data obtained from the scopes and data aggregated,
    anonymized, or derived from them".
  - "Applications must pass an annual security assessment and obtain a Letter of Assessment from a
    Google-designated third party", depending on scope and user count.
- **Google Workspace API user data and developer policy** [S]:
  - It prohibits using Workspace data to train non-personalised AI/ML models, and developers must
    commit to this in their privacy policy.
  - A 2026 secondary analysis reports further requirements: an in-product disclosure *immediately
    before* an affirmative consent; coverage of MCPs and agent tools; prompt-injection protection;
    HSM-equivalent key management; reporting incidents to Google.
- **Gmail scopes.**
  - `gmail.metadata` ("View your email message metadata such as labels and headers, but not the email
    body") and `gmail.readonly` ("View your email messages and settings") are listed in the Gmail API
    discovery document. The fact-check pass re-fetched it at revision 20260928 [V].
  - The same discovery document says the `users.messages.list` `q` parameter "cannot be used when
    accessing the api using the gmail.metadata scope" [V].
  - Secondary sources report that **both scopes are Restricted** [S]. The classification table on
    developers.google.com could not be fetched.
  - Testing-mode projects are capped at 100 test users [S]. A project in "Testing" status "is issued
    a refresh token expiring in 7 days", unless it requests only the basic profile scopes [S, Google
    OAuth doc text quoted in several repositories].
- **Google Play SMS/Call Log policy** [S]:
  - Apps that are not the default handler need a declared exception.
  - Listed exceptions include **"SMS-based money management"** (apps that track and manage budgets;
    `READ_SMS`, `RECEIVE_SMS`, `RECEIVE_MMS`, `RECEIVE_WAP_PUSH`) and **"SMS-based financial
    transactions"** (e.g. UPI).
  - Permissions are allowed only for critical, current features promoted in the store listing.
  - The "SMS-based money management" row ("For example, apps that track and manage budget"; `READ_SMS,
    RECEIVE_MMS, RECEIVE_SMS, RECEIVE_WAP_PUSH`) is quoted the same way by several independent
    developer repositories [S]. support.google.com was blocked during the fact-check.
- **Play Protect and distribution outside Play** [S]:
  - Since Oct 2024, Play Protect's "enhanced fraud protection" in **India** blocks installation of
    *internet-sideloaded* apps (from browsers, messaging apps or file managers) that request
    `RECEIVE_SMS`, `READ_SMS`, notification-listener or accessibility access. Testers in India who
    install a BRAKE APK from a browser or chat link will usually be blocked; `adb` installs are
    reportedly exempt. Distribute the Indian beta through Play testing tracks.
  - Android developer verification is reported to be enforced on certified devices from 30 Sep 2026
    in Brazil, Indonesia, Singapore and Thailand, and globally in 2027. Builds outside Play will need
    a verified developer identity.
- **Google Play User Data policy** [U]:
  - It requires an in-app **prominent disclosure** shown in normal use, followed by affirmative
    consent, before sensitive data is collected.
  - The Data safety form is required [V], and SDK data must be declared [V].
  - There appears to be no dedicated Play declaration form for notification-listener access [U].
  - The AccessibilityService API is restricted to genuine accessibility uses (`isAccessibilityTool`)
    [U].
- **Android OS** [V]:
  - The NotificationListenerService needs the user to enable *Notification access* in Settings.
  - Android 15: "Android will stop untrusted apps that implement a NotificationListenerService from
    reading unredacted content from notifications where an OTP has been detected".
  - Android 17: if an app with SMS permission is not the intended recipient of a WebOTP message, the
    message is withheld from it for **three hours**. During that time the `SMS_RECEIVED_ACTION`
    broadcast is withheld and SMS-provider queries are filtered. This applies to all apps whatever
    their target API level. The default SMS app, companion apps and some others are exempt.
  - Android 17, **apps targeting API 37+**: the same three-hour hold applies to *standard* SMS that
    contain an OTP ("SMS messages containing an OTP that do not use the WebOTP or SMS Retriever
    formats"). BRAKE discards OTPs anyway. The risk is that a bank alert that also carries an OTP-like
    code could arrive three hours late or be misclassified. Raising targetSdk to 37 needs testing
    against real Indian bank SMS.
  - Notification listeners "cannot get notification access or be bound by the system on low-RAM
    devices running Android Q (and below)", and the system ignores listeners running in a work
    profile. Low-RAM Android Go phones are common in India, so the listener path is unavailable on
    some entry-level devices.
  - Android 13 added the `POST_NOTIFICATIONS` runtime permission, which BRAKE needs for its own
    one-tap prompts.
  - Auto Backup copies databases and shared prefs to Google Drive by default, up to 25 MB. It is
    end-to-end encrypted on Android 9+ with a screen lock. It is controllable through
    `dataExtractionRules`, whose `<cloud-backup>`, `<device-transfer>` and, from Android 16 QPR2,
    `<cross-platform-transfer>` (transfer to iOS) sections need separate exclusions.
  - "Key material never enters the application process" for Android Keystore keys.
- **Apple App Store** [V]:
  - 5.1.1(i) requires a privacy policy explaining retention and deletion and how to revoke consent.
  - 5.1.1(ii) requires consent, a way to withdraw it, and that **paid** functionality not depend on
    granting data access.
  - 5.1.1(iv) says "where possible, provide alternative solutions for users who don't grant consent".
    5.1.2(i) bars requiring users to enable system functionalities (push, location, tracking) to use
    the app. Together these support, but do not literally mandate, a fully functional manual mode.
  - 5.1.1(iii) requires data minimisation.
  - 5.1.1(v) requires in-app account deletion.
  - 5.1.1(ix) says apps in "highly regulated fields (such as banking and financial services ...)
    should be submitted by a legal entity that provides the services, and not by an individual
    developer". The word is "should", and the rule is enforced in review.
  - 5.1.2(i): "You must clearly disclose where personal data will be shared with third parties,
    **including with third-party AI**, and obtain explicit permission before doing so".
  - 5.1.2(ii) bars repurposing without further consent.
  - 5.1.2(iii) bars surreptitiously building user profiles.
  - App Privacy "Collect" means "transmitting data off the device in a way that allows you and/or
    your third-party partners to access it for a period longer than what is necessary to service the
    transmitted request in real time".
  - "Emails or Text Messages" and "Other Financial Info" are disclosure categories.
  - Privacy manifests (`PrivacyInfo.xcprivacy`) are required.
  - **FinanceKit** needs a *managed entitlement*: an organisation-level account, an Account Holder
    request, and criteria that "Apple reviews". This was re-confirmed in the fact-check pass. The docs
    page does not state country availability, which remains (unverified).
- **Chrome Web Store** [S]:
  - Limited Use covers **all** user data an extension handles.
  - It requires a single purpose and a public compliance statement.
  - A policy update was published at https://developer.chrome.com/blog/cws-policy-updates-2026 and took
    effect on **1 Aug 2026**; the page could not be fetched. Many independent developer repositories
    quote it: "Any user data collected by an extension must now be strictly necessary to the
    extension's disclosed single purpose", and all data collection must be "prominently disclosed to
    the user — regardless of whether the data is closely related to the extension's single purpose".
    The earlier citation for this point, an AI-generated artifact in a third-party repository, has been
    replaced.
- **Microsoft Graph (Outlook)** [U]: delegated `Mail.Read` or `Mail.ReadBasic`, Microsoft APIs Terms of
  Use, publisher verification (many tenants block user consent to unverified publishers), and admin
  consent in some organisations.

---

### Part B — Per-source assessments (legal and privacy lens)

Each block follows the shared template. Field names and dedup keys are given only where they matter to
privacy design. Streams 01-08 own the full technical detail.

#### B1. `android-notification-listener` — Android NotificationListenerService

- **What it is.** A user-granted special access ("Notification access") that lets BRAKE read the
  notifications other apps post, such as bank, UPI, wallet and card apps [V].
- **Data actually available.** For each `StatusBarNotification`: package name, post time, and the
  notification `extras` (title, text, big text, sub-text). Usually these give amount, currency,
  merchant or payee, instrument mask (`XX1234`), balance and sometimes a reference number. OTP
  notifications are redacted for untrusted listeners on Android 15+ [V].
- **Windows / latency.** IN-SPEND and POST-SPEND. Arrives within seconds of the debit.
- **Coverage.** Android globally. The strongest coverage is India (bank and UPI apps notify on every
  debit), followed by other markets where bank apps push alerts.
- **Access requirements.**
  - User toggle in system Settings.
  - Play prominent disclosure and consent [U]; Data safety declaration [V].
  - EU: ePrivacy Art. 5(3) consent [U].
  - Sideloaded builds may hit Android's "restricted settings" gate [U].
- **Privacy and consent model.** **Very high sensitivity.** The listener sees *every* notification,
  including chats, health apps and 2FA. Requirements:
  - process in memory against an **allowlist of financial package names** chosen by the user;
  - drop everything else without logging or persisting it;
  - parse on the device;
  - persist extracted facts only;
  - never upload notification text by default.
- **Reliability and failure modes.** Notification text formats change. Some OEM battery optimisers kill
  listeners. The OS may redact more content over time. The user can revoke access at any time.
  Listeners cannot be bound on low-RAM devices running Android 10 (Q) or earlier, and are ignored in
  work profiles [V]. In India, Play Protect blocks sideloaded APKs that request listener access [S],
  so the source works only for Play-distributed builds.
- **Dedup keys.** Package name + post time + amount + `last4`. A bank reference, UPI RRN or UTR if
  present.
- **Normalized observation.** A `money_movement` observation at stage `confirmed`, with amount,
  currency, direction, `merchant_raw`, instrument `last4`, rail hint and references. Confidence is
  about 0.95 for kind and amount when a bank-specific parser matches, and lower for generic parsers.
- **Provenance sentence.** "Detected from your HDFC Bank app notification on this phone (the
  notification itself was not stored)."
- **Recommendation: `mvp`** (Android; flagship for India). This is the best-coverage, lowest-latency
  source that needs no regulated status. It is legally defensible *only* with an allowlist, extraction
  on the device and per-source consent.

#### B2. `android-sms-bank-alerts` — Android SMS inbox and broadcast (`READ_SMS`/`RECEIVE_SMS`)

- **What it is.** Reading bank, card and UPI alert SMS through the SMS provider and the
  `SMS_RECEIVED` broadcast.
- **Data actually available.** Sender address or header (e.g. `AX-HDFCBK-S`), body and timestamp.
  Bodies typically include amount, account mask, merchant/VPA, UPI reference and available balance.
  READ_SMS also allows **historical backfill**, which is valuable during onboarding.
- **Windows / latency.** IN-SPEND and POST-SPEND. Seconds.
- **Coverage.** India (ubiquitous), and other SMS-alert markets in Africa, the Middle East and South
  Asia [U]. **Not available on iOS.**
- **Access requirements.** Google Play SMS permission declaration under the **"SMS-based money
  management"** exception [S]. Approval is discretionary: the feature must be core and promoted in
  the listing [S]. Android 17 withholds WebOTP SMS from non-recipients for three hours [V]. Apps that
  target API 37+ also have *standard* OTP-bearing SMS withheld for three hours [V].
- **Privacy and consent model.** **Very high sensitivity.** The permission exposes *all* personal SMS
  and OTPs. Requirements:
  - parse only messages whose sender header is on a **financial sender allowlist**. In India the TRAI
    suffix is a hint: bank alerts are mostly `-S`, `-T` is mostly OTP and `-P` is promotional [S];
    see A7;
  - never read, store or upload anything else;
  - **detect and discard OTP messages without processing them**;
  - limit backfill to a user-chosen window, e.g. 90 days.
- **Reliability and failure modes.** Play may reject or revoke the exception. DLT template changes
  alter formats. Dual SIM and RCS move bank messages out of the SMS store [U].
- **Dedup keys.** UPI RRN / UTR, account mask + amount + timestamp, merchant/VPA.
- **Normalized observation.** A `money_movement` observation, `confirmed`, as in B1. A sender-header
  allowlist match raises the prior confidence.
- **Provenance sentence.** "Read from an SMS alert sent by HDFC Bank (AX-HDFCBK). BRAKE only reads
  messages from bank senders you approved."
- **Recommendation: `mvp`** for India Android, *conditional on Play approval*. The fallback is B1,
  which sees SMS-app notifications without READ_SMS.

#### B3. `ios-message-filter-extension` — ILMessageFilterExtension (SMS filtering)

- **What it is.** An Apple extension point to "identify and filter unwanted SMS and MMS messages". It
  can defer to the developer's server through Associated Domains [V].
- **Data actually available.** For messages from unknown senders: sender and body, delivered *to the
  extension* for a filter verdict [U].
- **Windows / latency.** Would be IN-SPEND and POST-SPEND.
- **Coverage.** iOS. Transactional sub-categories exist in some markets, e.g. India [U].
- **Access requirements and policy.** The purpose of this API is **spam and junk filtering**. Using it
  to harvest financial data for another feature conflicts with purpose limitation (App Review
  5.1.2(ii)) [V] and with the extension's sandboxing [U].
- **Recommendation: `avoid`** as a transaction source. Stream 04 should confirm what the extension can
  persist and share.

#### B4. `gmail-api` — Gmail API via Google OAuth

- **What it is.** OAuth access to a user's Gmail for transactional emails: order confirmations,
  receipts, bank alerts, subscriptions, refunds.
- **Data actually available.** Under `gmail.readonly`: messages, headers (From, Subject, Date,
  Message-ID), body parts and attachments. Under `gmail.metadata`: headers and labels only, with no
  body [V] and no `q` search [V, Gmail discovery document rev. 20260928].
- **Windows / latency.** POST-SPEND, from seconds to minutes. Push uses Pub/Sub `watch`. Some
  PRE-SPEND value comes from renewal and trial-ending emails.
- **Coverage.** Global. Gmail's market share is large, but the "Gmail" adapter is one of N email
  adapters.
- **Access requirements.**
  - `gmail.readonly` is Restricted [S]. It needs app verification, an allowed use case and **an annual
    third-party security assessment (Letter of Assessment)** [V].
  - Restricted-scope review takes weeks [S]. Lab costs are reported in the hundreds to thousands of
    dollars a year [S].
  - Limited Use, including derived data [V]. No generalised model training [S]. Human reading only with
    affirmative agreement for specific messages [V].
- **Privacy and consent model.** **Very high sensitivity**: the whole mailbox, plus third parties'
  messages. Requirements:
  - filter by sender allowlist and query (`from:(orders@... OR ...)`) so BRAKE fetches *only* candidate
    messages;
  - extract on the device where feasible;
  - keep facts and discard bodies;
  - never send email content to a cloud LLM without a separate, explicit consent (Apple 5.1.2(i) [V];
    Workspace policy [S]).
- **Reliability and failure modes.** Verification denial or lapse revokes access for all users.
  Templates drift. Prompt-injection content can arrive in emails.
- **Dedup keys.** Merchant order number, `Message-ID`, invoice number, amount + merchant + date.
- **Normalized observation.** `order` / `receipt` / `subscription_event` / `refund_notice`, carrying
  line items. Confidence for the amount is about 0.8. Category comes from the line items.
- **Provenance sentence.** "Matched your bank transaction with an Amazon order confirmation email
  (order 402-…). BRAKE kept the items and total, not the email."
- **Recommendation: `next`.** The value is high, but the compliance cost (CASA, verification) and the
  legal sensitivity are high too. Ship once the forwarding route (B6) and extraction on the device are
  proven.

#### B5. `outlook-microsoft-graph` — Microsoft Graph Mail

- **What it is.** Delegated `Mail.Read` (or `Mail.ReadBasic`, which excludes the body) on
  Outlook.com and M365 mailboxes [U].
- **Data, windows and keys.** As for B4. Graph change notifications provide near-real-time delivery
  [U].
- **Access requirements.** Microsoft APIs Terms of Use, publisher verification, and tenant consent
  policies that may require admin consent for work accounts [U].
- **Privacy.** As for B4. Work mailboxes add employer-data concerns, so default to personal accounts.
- **Provenance sentence.** "Found in a receipt email in your Outlook inbox."
- **Recommendation: `next`**, after Gmail, sharing the same extraction pipeline.

#### B6. `email-forwarding` — user-configured forwarding to a BRAKE address

- **What it is.** The user forwards receipts manually, or sets a filter rule that forwards matching
  emails to `u-<random>@in.brake.app`.
- **Data actually available.** The full forwarded message, but **only what the user chose to
  forward**.
- **Windows / latency.** POST-SPEND. Seconds to minutes.
- **Coverage.** Any email provider. Platform-agnostic.
- **Access requirements.** No OAuth scope, so no Google restricted-scope assessment applies [S]. BRAKE
  is the **intended recipient**, which lowers the CCPA SPI concern [U]. The interception theory falls
  away because the user sends the message [U].
- **Privacy and consent model.** BRAKE's servers receive content, so it needs:
  - immediate extraction;
  - deletion of the raw MIME after parsing (target under 24 h);
  - encryption at rest;
  - no human access;
  - rejection of messages not forwarded by a verified user address (SPF/DKIM/ARC checks) to stop
    injection or spoofing.
- **Dedup keys.** As for B4.
- **Provenance sentence.** "From a receipt you forwarded to BRAKE on 3 Oct."
- **Recommendation: `next`** (an early candidate). It has the best legal profile of any email route
  because consent is per message and only the selected data flows.

#### B7. `imap-app-password` — IMAP with stored credentials or app passwords

- **What it is.** BRAKE stores mailbox credentials and polls over IMAP.
- **Policy.** It requires holding credentials. Google and Microsoft have moved away from basic and
  "less secure" authentication [U], and it bypasses the providers' consent and Limited Use frameworks.
  **High breach impact.**
- **Recommendation: `avoid`.**

#### B8. `plaid-transactions` — US aggregators (Plaid, and similar)

- **What it is.** Consumer-permissioned bank and card data through an aggregator.
- **Data actually available.** `transaction_id`, `pending_transaction_id`, `account_id`, `amount`,
  `iso_currency_code`, `authorized_datetime`, `merchant_name`, `merchant_entity_id`,
  `personal_finance_category`, `counterparties`, balances [V, Plaid OpenAPI]. Incremental updates
  come through `/transactions/sync` [V].
- **Windows / latency.** POST-SPEND. Pending entries take minutes to hours; posted entries 1-3 days.
- **Coverage.** US and Canada. The UK and EU through the aggregator's regulated entities [U].
- **Access requirements.** An aggregator contract and production review [U]. GLBA Safeguards and
  Privacy Rule are likely to apply [U]. The legal framework for access (1033) is enjoined and being
  rewritten [S]. Banks may charge aggregators fees [S].
- **Privacy and consent model.**
  - The user consents in the aggregator's Link flow.
  - Users can revoke at my.plaid.com [V].
  - BRAKE must call **`/item/remove`** on disconnect. Plaid calls this "a recommended best practice when
    offboarding users or if a user chooses to disconnect" [V].
  - Plaid warns that for some OAuth institutions a removed Item "may still show as an active connection
    in the institution's OAuth permission manager" [V]. BRAKE's disconnect UI must tell the user
    this.
  - Apply the 1033 baseline: 12-month re-authorisation, no ads, no cross-sell, no sale [U].
- **Reliability and failure modes.** Connection breakage, OAuth migrations, bank fee disputes.
- **Dedup keys.** `transaction_id`, and `pending_transaction_id` linking pending to posted.
- **Normalized observation.** `money_movement`, `pending` or `posted`. Ledger-grade confidence of 1.0
  weight.
- **Provenance sentence.** "Imported from your Chase checking account through Plaid (posted 3 Oct)."
- **Recommendation: `next`.** It becomes `mvp` only if the US is the launch market, and only after a
  GLBA-grade security program exists.

#### B9. `eu-psd2-ais` and `uk-open-banking-ais` — open banking account information

- **What it is.** Regulated AIS access to payment accounts through bank APIs.
- **Data actually available.** Account and transaction detail within the consented `Permissions`. In
  the UK the consent carries `ExpirationDateTime` and transaction date bounds [V].
- **Windows / latency.** POST-SPEND. Minutes to a day, depending on the bank.
- **Coverage.** EU/EEA and UK.
- **Access requirements.** BRAKE must become an AISP, become an AISP's agent, or receive data from an
  AISP that serves the user [U]. White-label arrangements are under EBA scrutiny in 2026 [S]. The
  re-authentication cadence differs. In the **EU**, bank-side SCA repeats at most every **180 days**
  under Delegated Regulation 2022/2360, in force since 25 Jul 2023 [S]. In the **UK**, there is no
  periodic bank-side SCA, but the AISP must have the user **reconfirm every 90 days** (SCA-RTS
  Art. 36(6)) [S]. PSD2 Art. 67 purpose limitation applies in the EU [U].
- **Privacy and consent model.** GDPR plus PSD2 "explicit consent". Silent-party data must be handled
  under legitimate interests and used only for the service [U]. Do not request "sensitive payment
  data" [U].
- **Dedup keys.** Bank `TransactionId`, `TransactionReference`, and amount + booking date.
- **Provenance sentence.** "From your Monzo account through open banking (consent expires 2 Apr 2027)."
- **Recommendation: `next`** through a licensed AISP partner (agent or licence-as-a-service). Own
  licensing is `later`.

#### B10. `india-account-aggregator` — RBI Account Aggregator

- **What it is.** Consented, encrypted FIP → AA → FIU data sharing.
- **Data actually available.** FI schemas such as deposit and credit card, with transactions, balances
  and profile, limited by `consentTypes`, `FIDataRange`, `fetchType`/`Frequency` and `DataLife` [V].
- **Windows / latency.** POST-SPEND. A periodic fetch every few hours to daily, within Fair Use
  limits [V].
- **Coverage.** India. Bank participation is broad but uneven [U].
- **Access requirements.** **Only regulated entities can be FIUs** [S]. BRAKE needs a regulated
  partner FIU, or a regulatory status of its own.
- **Privacy and consent model.** The consent artefact holds purpose, data life, frequency and range.
  The FIU must store data no longer than `DataLife`. DPDP applies on top.
- **Dedup keys.** The FIP transaction reference (`txnId`), UPI reference in narration, amount +
  `valueDate`.
- **Provenance sentence.** "Shared by your bank through Account Aggregator (consent: monthly, valid until
  Mar 2027)."
- **Recommendation: `research`** on the regulatory path, then **`next`** through a regulated FIU
  partner. It is not in the MVP because BRAKE cannot be an FIU unregulated.

#### B11. `apple-financekit` — Apple FinanceKit

- **What it is.** Access on the device to financial data in Apple Wallet (Apple Card, Apple Cash and
  other supported accounts), plus Wallet orders [V].
- **Access requirements.** A **managed entitlement** that requires: meeting Apple's criteria, an
  organisation-level account, an Account Holder request, and a usage-description string [V]. Country
  availability was not verified here [U]. Stream 02/04 owns it.
- **Privacy.** Data is read on the device behind user authorisation (`requestAuthorization()`) [V].
  This aligns well with local-first storage. Under Apple's definition, data not transmitted off the
  device is not "collected" [V].
- **Windows.** POST-SPEND, with near-real-time pending entries [U].
- **Provenance sentence.** "From Apple Wallet on this iPhone (Apple Card)."
- **Recommendation: `next`** (US iOS). It depends on the entitlement.

#### B12. `card-linked-transaction-feeds` — card network or issuer feeds (card-linked offers, issuer webhooks)

- **What it is.** Real-time authorisation feeds through network programs or issuer partnerships.
- **Policy.** Network program rules restrict data use, typically to the offer program. Partnerships are
  needed. PCI scope arises if a full PAN is ever handled, so tokens only [U].
- **Windows.** IN-SPEND (authorisation) and POST-SPEND.
- **Recommendation: `later`.** It is partnership-gated, and purpose restrictions may not allow
  budgeting use.

#### B13. `upi-intent-url` and `qr-code-scan` — payment QR and intent data

- **What it is.** The user scans a merchant QR with BRAKE, or BRAKE receives a `upi://pay?...` intent,
  *before* paying.
- **Data actually available.** `pa` (payee VPA), `pn` (payee name), `am` (amount), `cu`, `mc` (merchant
  category code) and `tr`/`tn` references, where present [U; stream 05].
- **Windows / latency.** PRE-SPEND and IN-SPEND. Instant.
- **Privacy.** Low to medium. It is user-initiated. A P2P payee's VPA or name is third-party personal
  data, so hash it for storage and show it only on the device.
- **Policy questions.** Whether an app that receives a UPI intent and forwards it to a PSP app needs any
  NPCI or TPAP standing is not verified [U]. Never initiate or alter payment instructions.
- **Provenance sentence.** "You scanned this merchant's QR in BRAKE before paying."
- **Recommendation: `mvp`** for QR scan (camera, user-initiated). **`research`** for intent interception
  until the NPCI position is confirmed.

#### B14. `receipt-ocr` — receipt photos and screenshots (OCR on the device)

- **What it is.** The user shares or photographs a receipt, invoice or screenshot.
- **Data actually available.** Merchant, date, total, tax, line items, payment mask. Sometimes a **full
  PAN** or loyalty IDs.
- **Windows.** POST-SPEND. PRE-SPEND for price tags.
- **Privacy.** Run OCR on the device (Apple Vision, ML Kit). Detect and redact PANs (Luhn) before
  persistence (A13). Discard the image after extraction unless the user pins it. Apple recommends
  out-of-process pickers and share sheets rather than full photo access [V].
- **Recommendation: `mvp`.** It is user-initiated and low risk if the redaction rules hold.

#### B15. `manual-entry` — manual transactions and "Should I buy this?"

- **Privacy.** Lowest risk. Still screen free text for PANs and accidental sensitive data.
- **Windows.** PRE-SPEND (intent) and POST-SPEND.
- **Recommendation: `mvp`.** It is the graceful-degradation floor, and it needs no permissions.

#### B16. `chrome-extension` — browser extension on checkout and order pages

- **What it is.** A content script on allowlisted retailer checkout and order pages that reads cart
  totals and order details.
- **Windows.** PRE-SPEND and IN-SPEND (cart and checkout). POST-SPEND (order page).
- **Access requirements.** Chrome Web Store single-purpose and Limited Use rules, which cover all data
  the extension handles [S]. From 1 Aug 2026, collected data must be "strictly necessary" to the
  disclosed single purpose, and all collection must be prominently disclosed [S]. Narrow host
  permissions.
- **Privacy.** Never read pages outside the allowlist. Never capture form fields (card, password).
  Extract on the client.
- **Provenance sentence.** "From the Amazon checkout page you were viewing (BRAKE extension)."
- **Recommendation: `next`** (desktop pre-spend surface).

#### B17. `android-accessibility-service` — reading screens through AccessibilityService

- **Policy.** Restricted by Play to accessibility tools [U]. It reads everything on screen, including
  banking-app screens and passwords. Its abuse profile resembles stalkerware.
- **Recommendation: `avoid`.**

#### B18. `bank-credential-scraping` — storing bank credentials and screen-scraping

- **Policy.** It breaches bank terms (CFAA risk in the US [U]). PSD2 SCA and 1033 push the industry
  away from it [U]. Holding credentials has a large breach impact.
- **Recommendation: `avoid`.**

#### B19. `ios-screen-time-api` — FamilyControls / ManagedSettings / DeviceActivity

- **What it is.** Shielding chosen apps and websites (pre-spend friction). Activity is exposed as
  **opaque tokens**, not app identities, in the main app [U; stream 04].
- **Privacy.** It is private by design. Its legal risk lies in **coercive or third-party use**
  (family-control modes), so use individual authorisation only.
- **Windows.** PRE-SPEND.
- **Recommendation: `next`** (stream 04 owns the entitlement details).

#### B20. `device-location` and `calendar-events` — contextual signals

- **Policy.** Precise geolocation is SPI under CCPA and sensitive under several state laws [U]. Play and
  iOS add background-location restrictions [U]. Calendars contain third-party data.
- **Recommendation: `later`** (coarse, user-initiated only). Avoid background location tracking.

#### B21. `on-device-llm-extraction` — processing mechanism

- **What it is.** Structured extraction from notification, SMS and email text with on-device models:
  - **Apple Foundation Models**: on-device, with Private Cloud Compute or "any server model provider"
    for harder tasks [V];
  - **Gemini Nano** via AICore and ML Kit GenAI: "AICore is built to isolate each request and doesn't
    store any record of the input data or the resulting outputs" [V];
  - deterministic per-bank parsers as the first tier.
- **Privacy.** The content never leaves the device. This satisfies the minimisation and interception
  arguments.
- **Caveat.** Using Private Cloud Compute or a server provider changes the analysis (see B22).
- **Recommendation: `mvp`.** Parsers first, then the on-device model as fallback.

#### B22. `cloud-llm-extraction` — processing mechanism

- **Policy.**
  - Apple: explicit permission before sharing with third-party AI [V].
  - Google Workspace data: no generalised training, and the provider must not retain the data [S].
  - GDPR: a processor contract, a transfer mechanism and a DPIA [U].
  - India: localisation if it flows down from a partner [U].
  - Emails are attacker-controlled, so prompt injection is a risk [S].
- **Recommendation: `avoid` by default.** Move to `later` as an explicit, per-feature opt-in, with all
  of the following:
  - zero data retention and no-training contracts;
  - pre-redaction (PAN, OTP, account numbers, counterparties);
  - schema-constrained output;
  - no tool use;
  - never for Gmail-derived data unless every Workspace condition is met.

#### B23. `federated-learning-dp` — cross-user learning mechanism

- **What it is.** Improving merchant normalisation, categorisation and regret priors across users
  without centralising raw data, using federated averaging with secure aggregation and/or
  differential privacy. Mature open-source DP libraries cover ε- and (ε,δ)-DP aggregation and privacy
  budget accounting, e.g. Google's `differential-privacy` with PipelineDP4j and `dp_accounting` [V].
- **Policy.**
  - The source policy decides eligibility. Gmail-derived and other Google-API-derived data are
    **ineligible** (Limited Use covers derived data, and non-personalised training is barred [V][S]).
  - Special-category inferences are ineligible.
  - AA data is limited to its consent purpose.
- **Recommendation: `later`.** In the MVP, use per-user on-device personalisation and curated public
  merchant dictionaries.

#### B24. `india-dpdp-consent-manager` — DPDP Consent Manager integration

- **What it is.** A registered, interoperable consent platform through which users give, review and
  withdraw consent across data fiduciaries [S].
- **Status.** Registration under Rule 4 opens on 13 Nov 2026 [S]. No operators were verified as of
  2026-10-04.
- **Recommendation: `research` / `later`.** Design BRAKE's consent receipts so they can be exported to
  a Consent Manager.

---

## Three-window classification

From a legal and privacy perspective. "Gate" means the main legal or policy precondition.

| Source | Pre-spend | In-spend | Post-spend | Latency | Notes (gate) |
|---|---|---|---|---|---|
| android-notification-listener | — | Yes | Yes | seconds | User toggle; Play prominent disclosure; EU ePrivacy consent; allowlist + on-device only; OTP redaction (Android 15+); no low-RAM ≤Q devices; India sideload block |
| android-sms-bank-alerts | — | Yes | Yes (+backfill) | seconds | Play "SMS-based money management" exception; sender allowlist; drop OTPs; Android 17 WebOTP delay (all apps) and standard-SMS OTP delay (targetSdk 37+) |
| ios-message-filter-extension | — | (Yes) | (Yes) | seconds | Purpose is spam filtering → avoid |
| gmail-api | (renewal/trial emails) | — | Yes | sec–min | Restricted scope, annual security assessment, Limited Use (incl. derived), no generalised training |
| outlook-microsoft-graph | (renewals) | — | Yes | sec–min | Publisher verification, tenant consent |
| email-forwarding | (renewals) | — | Yes | sec–min | BRAKE is intended recipient; delete raw MIME < 24 h |
| imap-app-password | — | — | Yes | minutes | Credentials → avoid |
| plaid-transactions | — | — | Yes | min–days | Contract; GLBA; 1033 enjoined; /item/remove on disconnect |
| eu-psd2-ais / uk-open-banking-ais | — | — | Yes | min–day | AISP licence/agent; Art. 67 purpose limits; EU 180-day bank SCA; UK 90-day AISP reconfirmation |
| india-account-aggregator | — | — | Yes | hours–day | FIU must be regulated; DataLife; Fair Use |
| apple-financekit | — | — | Yes | near-real-time (U) | Managed entitlement |
| card-linked-transaction-feeds | — | Yes (auth) | Yes | seconds | Network program purpose limits; PCI |
| upi-intent-url / qr-code-scan | Yes | Yes | — | instant | User-initiated; NPCI stance on intent handling unverified |
| receipt-ocr | (price tag) | — | Yes | user-paced | PAN redaction; discard image |
| manual-entry | Yes | — | Yes | user-paced | Lowest risk |
| chrome-extension | Yes | Yes | Yes (order page) | instant | CWS single purpose + Limited Use (Aug 2026) |
| android-accessibility-service | (Yes) | (Yes) | (Yes) | instant | Avoid |
| bank-credential-scraping | — | — | Yes | hours | Avoid |
| ios-screen-time-api | Yes | — | — | instant | Individual authorisation only; entitlement |
| device-location / calendar-events | Yes | (Yes) | — | varies | SPI (precise geo); later, coarse, user-initiated |
| on-device-llm-extraction | n/a | n/a | n/a | sub-second–seconds | Mechanism; preferred |
| cloud-llm-extraction | n/a | n/a | n/a | seconds | Mechanism; opt-in only |
| federated-learning-dp | n/a | n/a | n/a | days | Mechanism; eligibility by source policy |

---

## Implications for BRAKE architecture

### 1. Every adapter declares a `PolicyProfile`

The fusion layer already keeps `FieldProvenance` (see `docs/architecture/fusion-and-reconciliation.md`).
Add a **static, reviewed policy declaration per adapter**, plus **per-observation policy tags** that
travel with each fact and propagate to the derived `TransactionCandidate`. Proposed shape:

```yaml
PolicyProfile:
  source_id: android-sms-bank-alerts
  adapter_version: 3
  data_categories: [financial_transaction, account_mask, counterparty_identifier]
  may_contain: [otp, personal_messages, third_party_personal_data, special_category_inference]
  ingest_filter: sender_allowlist            # what is dropped before parsing, never persisted
  processing_locus: device_only              # device_only | device_then_e2ee_sync | server
  raw_retention: none                        # none | ttl_24h | user_pinned
  fact_retention_class: R2                   # see retention table
  legal_basis:                               # per jurisdiction, resolved via capability registry
    EU: {gdpr: contract_6_1_b, eprivacy_5_3: consent, art9: explicit_consent_if_sensitive}
    IN: {dpdp: consent}
    US: {glba: likely_covered, ccpa_spi: true}
  platform_gates: [play_sms_permission_declaration, play_prominent_disclosure]
  cross_user_learning: forbidden             # forbidden | dp_aggregate_only | allowed
  cloud_llm: forbidden                       # forbidden | opt_in_zdr | allowed
  human_review: forbidden_without_specific_consent
  third_party_data_handling: keyed_hash      # counterparties hashed with per-user key
  pan_redaction: required
  disconnect_semantics: delete_observations_and_recompute
```

**Policy propagation.** A candidate inherits the *most restrictive* tags of all its member
observations. For example, if any member is Gmail-derived, the candidate is excluded from cross-user
learning. The fusion layer already recomputes candidates when a source is disconnected, and that
recomputation must also recompute the policy tags.

### 2. Capability registry: legal facts with `as_of`

Legal facts belong in the same machine-readable registry as technical capabilities, so features are
gated by policy as well as by availability:

```yaml
- {country: IN, capability: account-aggregator-direct-fiu, status: limited,
   note: "FIU must be registered with and regulated by a financial sector regulator", as_of: 2026-10-04, evidence: S}
- {country: IN, capability: dpdp-substantive-obligations, status: emerging, effective: 2027-05-13, evidence: S}
- {country: IN, capability: dpdp-min-retention-1y, status: emerging, effective: 2027-05-13,
   note: "Rules 6(1)(e), 8(3): retain processing logs + associated personal data >= 1 year", evidence: S}
- {country: IN, capability: dpdp-consent-manager, status: emerging, effective: 2026-11-13, evidence: S}
- {country: IN, capability: play-sms-money-management-exception, status: available, evidence: S}
- {country: US, capability: cfpb-1033-data-access-right, status: unavailable,
   note: "2024 rule enjoined; reconsideration NPRM at OIRA since 2026-08-06", evidence: S}
- {country: US, capability: wa-consumer-health-data-consent, status: available, note: "separate consent for health inferences", evidence: U}
- {country: EU, capability: eprivacy-device-access-consent, status: available, note: "opt-in per device-reading source", evidence: U}
- {country: GLOBAL, capability: android-otp-notification-redaction, status: available, note: "Android 15+", evidence: V}
```

The product reads these the same way it reads technical capabilities. A Washington user with no
health-data consent gets "Personal" rather than "Medical". An EU user who has not given the ePrivacy
consent never sees the notification adapter turn on silently.

### 3. Normalisation pitfalls with privacy consequences

- **Raw text leaking into "facts".** `merchant_raw` from SMS can embed a person's name or phone-number
  VPA (`98xxxxxx12@ybl`). Classify each counterparty as *merchant* or *person*. Store persons only as
  `HMAC(user_key, normalized_vpa)` plus a display name kept on the device.
- **OTPs and credentials.** Drop any message or notification matching OTP patterns before parsing. Never
  store "Available balance" alongside full account numbers. Store masks only.
- **PANs in OCR and free text.** Run the Luhn redaction pass on every text field before persistence and
  before any network call.
- **Sensitive merchant categories.** Mark categories such as pharmacy, hospital, clinic, religious
  organisation, political organisation, union, dating or adult, and gambling as `special_category_risk`.
  Route them through consent-aware labelling, and never into cross-user models, notifications on the
  lock screen, or analytics.
- **Lock-screen leakage.** BRAKE's own one-tap labelling notifications (e.g. "₹1,249 at Apollo
  Pharmacy — Medical?") are visible on the lock screen. Default to a redacted public version (e.g.
  `setPublicVersion()` on Android [V]) and generic text for sensitive categories.
- **Logs and crash reports.** These must never contain message bodies, merchant strings tied to user
  IDs, or tokens (CERT-In keeps logs for 180 days, so put no content in them [U]).
- **Backups.** Android Auto Backup copies databases by default [V]. Exclude raw buffers, tokens and
  evidence snippets with `dataExtractionRules`. Keep tokens in Keystore/Keychain with device-only
  access.

### 4. Retention schedule (proposed defaults; counsel to confirm)

| Class | Data | Where | Default retention | Driver |
|---|---|---|---|---|
| R0 | Raw ingress (notification/SMS/email body, receipt image) | device memory / encrypted temp | process then discard; max 24 h if parsing is deferred; never synced | minimisation; Apple "collect" definition [V]; interception risk [U] |
| R0s | Raw forwarded email (B6) | server, encrypted | delete after extraction, max 24 h | minimisation; breach impact |
| R1 | Evidence snippet (redacted one-liner for "How did BRAKE know?") | device | 30 days, user-toggleable | transparency vs minimisation |
| R2 | Extracted observation (facts) | device; optional E2EE sync | rolling 24 months (user choice 3/12/24) | regret/recurring learning needs history |
| R3 | TransactionCandidate (derived) | device / sync | recomputed; deleted when all member observations are deleted | reversibility |
| R4 | User labels / assertions | device / sync | until user deletes | user-generated |
| R5 | Aggregator / OAuth tokens | Keychain/Keystore, or server KMS/HSM | until disconnect; **revoke upstream + delete immediately** | Google OAuth policy [S]; Plaid `/item/remove` [V] |
| R6 | AA FI data | partner FIU / BRAKE | ≤ consent `DataLife` | AA spec [V] |
| R7 | Consent receipts | device + server | life of account + counsel-set limitation period | proof of consent (GDPR Art. 7(1)) [U]; DPDP [U] |
| R8 | Security/audit logs (no content) | server | the longest of the legal minimums (India: 180 days CERT-In [S]; DPDP Rules 6(1)(e)/8(3) at least 1 year [S]) | legal |
| R9 | DP-aggregated statistics | server | indefinite | only from eligible sources |

The FTC Safeguards Rule's "dispose within two years of last use" [U] is consistent with R2.

**India caveat (from 13 May 2027).** DPDP Rule 8(3) requires a Data Fiduciary to keep "such personal
data, associated traffic data and other logs of the processing" for **at least one year** [S]. R0s
(raw forwarded email deleted within 24 h), R2's user-chosen 3-month option, and "Disconnect and delete"
may conflict with that floor for Indian users' server-side data. Counsel must decide whether keeping
content-free processing logs plus the extracted facts for one year satisfies the rule. Until then, the
registry entry `IN/dpdp-min-retention-1y` should drive an India-specific retention profile instead of
silently shortening deletion.

### 5. Consent receipts (per source, per scope)

Model the receipt on the AA `ConsentDetail` [V] and the OBIE consent fields [V]. ISO/IEC TS 27560
(consent record structure) and the Kantara Consent Receipt specification are relevant standards [U].

```json
{
  "receipt_id": "cr_…", "user_id": "…", "source_id": "gmail-api", "adapter_version": 4,
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "ingest_filter": {"senders": ["auto-confirm@amazon.in", "…"], "window_days": 90},
  "purposes": ["detect_purchases", "itemise_transactions", "detect_subscriptions"],
  "processing_locus": "device_only", "cloud_llm": false, "cross_user_learning": false,
  "retention": {"raw": "none", "facts": "P24M"},
  "processors": [], "jurisdiction": "IN", "legal_basis": "dpdp_consent",
  "notice_version": "2026-10-01-en", "language": "en",
  "granted_at": "2026-10-04T10:00:00+05:30", "expires_at": "2027-10-04T10:00:00+05:30",
  "withdrawn_at": null, "evidence_hash": "sha256:…"
}
```

- Show receipts in a "Connected sources" screen. Each receipt shows what is read, what is kept, for how
  long, and when it expires, with a one-tap **Disconnect and delete**.
- Re-prompt at expiry. A 12-month default mirrors the 1033 baseline [U].

### 6. Provenance that is honest and itself minimal

- Provenance sentences must state **what was read and what was kept**. For example: "Detected from your
  HDFC Bank SMS alert. BRAKE kept the amount, merchant and card ending 1234, not the message."
- After a source is disconnected, provenance must not reveal deleted content. It may say "from a source
  you disconnected".
- Every inference that drives an intervention needs a "Why am I seeing this?" explanation (Art. 22 and
  AI Act transparency; Apple 5.1.2 [V]).

### 7. Model and LLM processing rules

1. Tiered extraction: deterministic parsers, then on-device model, then (opt-in only) cloud model.
2. Before any cloud call, redact PANs, OTPs, account numbers, counterparties' names, VPAs and phone
   numbers.
3. Treat email and SMS as **untrusted input**: output must follow a strict schema, no tool calls run on
   message-derived prompts, and all output is validated.
4. Contracts must guarantee **zero data retention and no training**. EU data needs transfer
   safeguards. Apple 5.1.2(i) requires explicit permission [V].
5. No Gmail or Workspace-derived data goes to any non-personalised training [S][V].

### 8. Security baseline (GLBA, DPDP and Google combined)

- Encryption at rest on the device: SQLCipher or an OS-protected file class, with keys in
  Keystore/Keychain [V].
- Encryption at rest on the server, with KMS/HSM. Encryption in transit with TLS 1.2+.
- MFA for staff access. No standing human access to user content.
- An annual penetration test and scheduled vulnerability scanning [U].
- An incident response plan covering every clock: 6 h (CERT-In) [U], 72 h (GDPR, DPDP Rules) [U],
  30 days to the FTC for 500+ consumers [U], and prompt notice to Google for Google data [S].
- Google's annual security assessment for server-side restricted scopes [V].

### 9. Privacy requirements BRAKE's architecture must satisfy

MUST = launch-blocking. SHOULD = strong default. Tags show the main drivers.

**Collection and minimisation**

- **PR-01 (MUST)** Each adapter filters at ingress: a package allowlist (notifications), a sender-header
  allowlist (SMS), and sender/query filters (email). Anything not matched is discarded in memory and
  never logged or persisted. *(GDPR Art. 5/25; DPDP s.6; Google minimum scopes [V])*
- **PR-02 (MUST)** Request the narrowest permission or scope, incrementally, at the moment the feature
  is used. No "future-proof" scopes. *(Google UDP [V]; Apple 5.1.1(iii) [V])*
- **PR-03 (MUST)** Never collect OTPs, passwords, full PANs, CVVs or full account numbers. Apply OTP
  filtering and Luhn PAN redaction to all text paths, OCR and manual entry. *(PCI DSS [U]; Android 15/17
  [V])*
- **PR-04 (MUST)** Store extracted facts, not raw messages. Raw content is ephemeral (R0) by default.
  *(brief; minimisation)*

**Processing locus**

- **PR-05 (MUST)** Extract SMS, notifications and on-device email on the device by default. Uploading
  raw content needs a separate, explicit, revocable opt-in per source. *(interception risk [U]; Apple
  "collect" [V]; CCPA SPI [U])*
- **PR-06 (MUST)** A cloud LLM is used only after explicit opt-in, with zero retention and no training,
  pre-redaction and schema-constrained output. Gmail-derived data is never used for non-personalised
  training. *(Apple 5.1.2(i) [V]; Workspace policy [S])*
- **PR-07 (SHOULD)** Data of Indian users is hosted in an India region. BRAKE can sign localisation
  flow-downs from partners. *(RBI 2018 [U]; DPDP s.16 [U])*

**Consent and control**

- **PR-08 (MUST)** Consent is given per source and per scope, with a prominent in-app disclosure
  *immediately before* the OS/OAuth prompt. The disclosure says what is read, what is kept, for how
  long, where it is processed, and who sees it. *(Play prominent disclosure [U]; Workspace [S]; DPDP s.5-6
  [U]; ePrivacy 5(3) [U])*
- **PR-09 (MUST)** A machine-readable consent receipt (section 5) is created for each grant, change and
  withdrawal. It is shown to the user and kept as proof.
- **PR-10 (MUST)** One-tap **Disconnect and delete** per source. It revokes upstream tokens (Google
  revoke, Plaid `/item/remove` [V], AA consent revoke), deletes the source's observations and
  recomputes candidates and policy tags. The UI warns where the upstream may still show the
  connection [V].
- **PR-11 (MUST)** No core feature may depend on granting a data source. Manual mode stays fully
  functional. *(brief's graceful degradation; supported by Apple 5.1.1(ii) "paid functionality",
  5.1.1(iv) "provide alternative solutions" and 5.1.2(i) [V], which do not literally require this)*
- **PR-12 (SHOULD)** Consent expires by default after 12 months for financial-data sources, with
  re-confirmation. *(1033 baseline [U])*
- **PR-13 (MUST)** 18+ only. An age gate is required. Do not process data of known minors. *(DPDP s.9
  [U]; COPPA [U])*

**Retention and deletion**

- **PR-14 (MUST)** An enforced retention schedule (section 4), with TTL jobs on the device and on the
  server and audit evidence. *(FTC orders [U]; Safeguards 2-year disposal [U]; DPDP s.8(7) [U])*
- **PR-15 (MUST)** Full account deletion in-app. It covers server data, sync copies and backups
  according to a documented backup lifecycle. *(Apple 5.1.1(v) [V]; GDPR Art. 17 [U])*
- **PR-16 (MUST)** User export in a structured, machine-readable format: observations, candidates,
  labels, consent receipts. *(GDPR Art. 20 [U]; DPDP s.11 [U]; CCPA [U])*
- **PR-17 (MUST)** AA-sourced data is stored no longer than the consent `DataLife`, and used only for
  the consent `Purpose`. *(AA spec [V])*

**Transparency and provenance**

- **PR-18 (MUST)** Every candidate and every intervention has an inspectable "How did BRAKE know?" view,
  built from `FieldProvenance` and stating what was read and what was kept (section 6).
- **PR-19 (MUST)** Every intervention can be overridden and configured by the user. No hard payment
  blocking without prior user configuration. *(GDPR Art. 22 [U]; AI Act Art. 5 [U])*
- **PR-20 (MUST)** No manipulative patterns: no false urgency, shame, deceptive framing or exploitation
  of financial distress. Intervention copy is reviewed against a written policy. *(AI Act Art. 5(1)(a)-(b)
  [U]; FTC §5 [U]; brief "without scolding")*

**Sensitive data and third parties**

- **PR-21 (MUST)** Special-category and health inferences (Medical, pharmacy, religion, politics,
  union, sexual life) are tagged `special_category_risk`, need explicit consent (EU) or separate consent
  (WA MHMDA), are kept out of cross-user learning and analytics, and are redacted on the lock screen.
  *(GDPR Art. 9 [U]; MHMDA [U])*
- **PR-22 (MUST)** Counterparty identifiers (person names, VPAs, phone numbers, email senders who are
  individuals) are stored as keyed hashes plus display names kept on the device. No contact graph is
  built, and nothing is used beyond the user's service. *(GDPR silent-party [U]; Apple 5.1.2(iv) [V])*
- **PR-23 (MUST)** No sale of data. No advertising use. No credit or lending use. No sharing with data
  brokers. No App Tracking Transparency tracking. *(Google UDP [V]; 1033 baseline [U]; Apple tracking
  definition [V])*
- **PR-24 (SHOULD)** Anti-abuse: no feature lets one person observe another adult's spending without
  that person's own authenticated consent on their own device. Show a persistent, visible indicator
  while device-reading sources are active. *(stalkerware/coercive-control risk)*

**Learning and AI**

- **PR-25 (MUST)** Personalisation runs per user and on the device by default. Cross-user learning uses
  only sources whose `PolicyProfile.cross_user_learning ≠ forbidden`, and only with DP and/or secure
  aggregation, with documented ε budgets. *(Limited Use incl. derived data [V])*
- **PR-26 (MUST)** No human review of user content except with specific, logged user consent for
  specific items (support tickets), or for security or legal necessity. *(Google UDP [V])*

**Security**

- **PR-27 (MUST)** Content-free logging and telemetry: no message bodies, no merchant strings joined to
  identities, no tokens. Crash reporters are scrubbed. *(CERT-In logs [U]; Google [S])*
- **PR-28 (MUST)** Encryption at rest (device and server) and in transit. Keys in Keystore/Keychain or
  KMS/HSM. Tokens encrypted and device-bound where possible. *(FTC Safeguards [U]; DPDP Rules [U]; Google
  [S]; Android Keystore [V])*
- **PR-29 (MUST)** Exclude raw buffers, tokens and evidence snippets from OS backups (`dataExtractionRules`
  on Android [V]; iOS: do not rely on `isExcludedFromBackup` for user documents [V]. Use
  device-only Keychain classes for secrets.)
- **PR-30 (MUST)** An incident response plan covering every regulatory clock (6 h CERT-In, 72 h
  GDPR/DPDP, 30 days FTC, Google notice) and notification of affected users. *(A6-A8 [U]; [S])*
- **PR-30a (MUST, India)** An India retention profile that reconciles minimisation with the DPDP
  Rule 6(1)(e)/8(3) one-year minimum for processing logs and associated personal data, as decided by
  counsel before 13 May 2027. *(DPDP Rules [S])*
- **PR-30b (MUST, EU)** Conversational or generative features ("Ask BRAKE") disclose that the user is
  interacting with an AI system. *(AI Act Art. 50, applicable since 2 Aug 2026 [S])*
- **PR-31 (MUST)** A written information security program with a Qualified Individual, risk assessment,
  annual penetration test, vulnerability scanning and MFA. *(FTC Safeguards [U])*
- **PR-32 (MUST if Gmail is server-side)** Pass Google restricted-scope verification and the annual
  security assessment before public launch. Keep separate test and production Google projects.
  *(Google UDP [V]; [S])*

**Governance and compliance**

- **PR-33 (MUST)** Complete a DPIA before launch in the EU/UK, and DPDP-grade impact documentation for
  India. Review on every new source adapter. *(GDPR Art. 35 [U]; DPDP s.10 [U])*
- **PR-34 (MUST)** Privacy policy and store disclosures generated from the `PolicyProfile`s, so they
  cannot drift from the code. This covers the Play Data safety form [V], App Privacy labels [V],
  privacy manifests [V] and a Google Limited Use statement [S].
- **PR-35 (MUST)** A material change in data use needs fresh consent, and is never applied
  retroactively to old data. *(Google UDP [V]; Apple 5.1.2(ii) [V]; FTC AI guidance [U])*
- **PR-36 (MUST)** A legal entity publishes the apps. *(Apple 5.1.1(ix) [V])*
- **PR-37 (MUST)** Never act as, or claim to be, a regulated AIS/FIU/payment provider without the
  licence or partner arrangement. Product copy for AA and open-banking features must name the regulated
  partner. *(PSD2 [U]; RBI AA [S])*
- **PR-38 (SHOULD)** Each country's legal facts are kept in the capability registry with `as_of` and
  an evidence level. A quarterly review job flags anything older than 6 months.
- **PR-39 (SHOULD)** India: interfaces designed so consent receipts can be exported to a DPDP Consent
  Manager once registrations exist. *(DPDP Rules Rule 4 [S])*
- **PR-40 (SHOULD)** A US state-law matrix (CCPA SPI "right to limit", WA MHMDA consent, Maryland
  minimisation). Honour opt-out preference signals such as GPC on the web [U].

---

## Risks, policy constraints and ethical concerns

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Play rejects or revokes the SMS permission exception → Indian SMS backfill lost | Medium | High (IN) | Treat notification listener as primary; READ_SMS optional; core listing copy on budgeting; PR-01/PR-03 |
| 2 | OS tightening (more notification redaction, listener restrictions) | High over 2-3 yrs | High | Multi-source fusion; parsers resilient to partial text; manual and QR floor |
| 3 | Gmail verification fails or lapses → all users lose email source | Medium | Medium | Forwarding address as alternative; on-device client; budget for annual assessment |
| 4 | Special-category or health inference exposure (GDPR Art. 9, WA MHMDA private suits) | Medium | High | PR-21; on-device only; consent; suppression |
| 5 | Interception or wiretap claims (CIPA-style class actions) if content flows to servers | Low-Medium | High | PR-05; BRAKE is never in the transit path; forwarding = intended recipient |
| 6 | Regulatory perimeter creep: BRAKE's features look like AIS (EU/UK) or need FIU status (IN) | Medium | High | PR-37; partner models; counsel review per market |
| 7 | 1033 rewrite allows bank fees or narrows third-party access → US data cost rises | Medium | Medium | Diversify: email, FinanceKit, manual, card feeds |
| 8 | Breach of a centralised store of financial and behavioural data | Low-Medium | Severe | Local-first; minimisation; encryption; R0 ephemeral raw |
| 9 | LLM vendor retention or training on user data; prompt injection from emails | Medium | High | PR-06; on-device first; schema-constrained extraction |
| 10 | PAN captured in OCR or screenshots → PCI scope and breach severity | Medium | Medium | PR-03 Luhn redaction before persistence |
| 11 | Lock-screen or notification leakage of sensitive spends | Medium | Medium | Public-version notifications; generic copy |

**Ethical concerns**

- **Financial surveillance and coercive control.** Notification and SMS access plus spending analytics is
  exactly what an abusive partner might want. BRAKE must have no remote or "family monitoring" view of
  another adult, must keep its indicators visible, and must have no hidden mode (PR-24). This also
  matches app-store stalkerware policies [U].
- **Vulnerability.** People in debt, with gambling problems or with compulsive buying are the users who
  could benefit most and be harmed most. The EU AI Act names "specific social or economic situation" as
  a vulnerability that must not be exploited [U]. BRAKE should never monetise vulnerability (no lending
  or BNPL offers), should avoid diagnosing language ("addiction"), and should offer signposting rather
  than escalating friction.
- **Regret tracking.** "Regretted" labels and late-night patterns are intimate psychological data. Keep
  them on the device, make them deletable, and do not use them in cross-user models without DP and
  explicit opt-in.
- **Autonomy.** Friction must be set by the user and easy to turn off. The brief's "without scolding" is
  both an ethical and a legal (dark-pattern) requirement.
- **Third parties who never consented.** Friends in split bills and P2P payees are processed without
  their knowledge. Minimise, hash and never surface them outside the user's own view.
- **Collection merely because it is possible.** Every new source needs a written purpose and value case
  in its `PolicyProfile` before it ships, which puts the brief's "do not collect context merely because
  it is technically available" into practice.

---

## Open questions

1. **Primary-source verification pass (launch-blocking).** Re-verify every [U] item against EUR-Lex,
   ICO, legislation.gov.uk, the eGazette (DPDP Rules), RBI, CERT-In, eCFR (16 CFR 313/314), CPPA, the
   Washington RCW and PCI SSC. This session's network policy blocked them.
2. **India FIU path.** Can BRAKE get AA data through a regulated partner as a technology service
   provider while still offering its own budgeting product, and how must the consent `Purpose` and
   Fair Use template be set for a PFM use case? Is any registration (e.g. SEBI investment adviser)
   proportionate for BRAKE?
3. **DPDP Rules details.** What are the exact Rule 3 notice contents, the Rule 8/Third Schedule
   applicability (does BRAKE ever cross the thresholds?), the response timelines, and has any
   amendment changed the 18-month timeline? Most important: how does the **Rule 8(3) / 6(1)(e)
   one-year minimum retention** of "personal data, associated traffic data and other logs of the
   processing" apply to an app that extracts facts on the device and deletes raw content quickly?
   Does it reach data BRAKE never receives?
4. **Play SMS exception in practice (2026).** What approval rates and listing requirements apply to
   Indian budgeting apps requesting READ_SMS under "SMS-based money management"? Does Play require the
   Financial features declaration?
5. **EU ePrivacy Art. 5(3) for notification reading.** Does the "strictly necessary for a service
   explicitly requested" exemption apply, or is consent always required? Is there national DPA
   guidance (CNIL, BfDI)?
6. **EU/UK AIS model.** Can BRAKE receive AIS data from a licensed AISP under licence-as-a-service
   without being an agent, under FCA and under the relevant EU national authorities? What do PSD3/PSR
   "permission dashboards" require of downstream recipients?
7. **US GLBA status.** Is BRAKE a "financial institution" under the FTC Privacy and Safeguards Rules if
   it receives aggregator data? What reuse limits does it inherit from banks?
8. **CCPA SPI and forwarding.** Does acting as the "intended recipient" of forwarded receipts take that
   content out of the SPI definition, and what notice is required?
9. **WA MHMDA scope.** Does a spending category label ("Medical") count as consumer health data even
   when it stays on the device and is never "collected" by BRAKE's servers?
10. **NPCI.** Can a non-PSP app register as a handler for `upi://` intents and forward them to a PSP app
    for pre-spend friction, or does that require TPAP status or breach NPCI rules?
11. **Gmail on the device only.** If the Gmail API is called from the device and data never touches
    BRAKE servers, which verification and assessment obligations remain?
12. **AI Act.** Answered in part: the Digital Omnibus on AI (Reg. (EU) 2026/1744) is in force and
    deferred only high-risk duties, and Art. 50 has applied since 2 Aug 2026 [S]. Still open: confirm
    against EUR-Lex, and decide whether any non-conversational BRAKE intervention model falls under
    Art. 50.
13. **Cross-border LLM.** Which on-device and Private Cloud Compute paths count as "not collected" for
    App Privacy, and what do Indian localisation flow-downs from partners allow?

---

## References

Each entry says how it was consulted. **F** = fetched in this session. **C** = read from a cached copy
in the shared research scratchpad, retrieved from the cited public URL. **SN** = search-result snippet
only, because the page itself was blocked.

1. https://developer.apple.com/app-store/review/guidelines/ — **F**. Verbatim 5.1.1(i)-(x), 5.1.2(i)-(vii) including the "third-party AI" explicit-permission rule, 5.1.3.
2. https://developer.apple.com/app-store/app-privacy-details/ — **F**. Definition of "Collect" (off-device transmission); "Emails or Text Messages", "Payment Info", "Other Financial Info", "Sensitive Info" categories.
3. https://developer.apple.com/app-store/user-privacy-and-data-use/ — **F**. Definition of tracking; on-device linking is not tracking; data-broker definition.
4. https://developer.apple.com/documentation/financekit (JSON: /tutorials/data/documentation/financekit.json) — **F**. FinanceKit managed entitlement, organisation account, Account Holder, Apple review criteria, `requestAuthorization()`.
5. https://developer.apple.com/documentation/foundationmodels — **F**. On-device and Private Cloud Compute models; server model providers.
6. https://developer.apple.com/documentation/bundleresources/privacy-manifest-files — **F**. `PrivacyInfo.xcprivacy` requirements.
7. https://developer.apple.com/documentation/foundation/urlresourcevalues/isexcludedfrombackup — **F**. Backup exclusion is for caches, not user documents.
8. https://developer.apple.com/documentation/identitylookup and https://developer.apple.com/documentation/identitylookup/creating-a-message-filter-app-extension — **F**. Message Filter extension purpose and server deferral.
9. https://developer.android.com/reference/android/service/notification/NotificationListenerService — **F**. Listener permission and user enablement.
10. https://developer.android.com/about/versions/15/behavior-changes-all — **F**. OTP redaction for untrusted notification listeners.
11. https://developer.android.com/about/versions/17/behavior-changes-all — **F** (page last updated 2026-10-01). SMS OTP three-hour protection extended to WebOTP; Keystore per-app limits.
12. https://developer.android.com/about/versions/16/behavior-changes-all — **F**. No notification/SMS privacy changes relevant to BRAKE.
13. https://developer.android.com/about/versions/13/behavior-changes-all — **F**. `POST_NOTIFICATIONS` runtime permission.
14. https://developer.android.com/identity/data/autobackup — **F**. Auto Backup defaults, 25 MB, E2E encryption on Android 9+, `dataExtractionRules`.
15. https://developer.android.com/privacy-and-security/keystore — **F**. Non-exportable keys, StrongBox, authentication-bound keys.
16. https://developer.android.com/ai/gemini-nano — **F**. AICore isolation; "doesn't store any record of the input data or the resulting outputs".
17. https://developer.android.com/guide/topics/permissions/default-handlers — **F**. Default-handler rule, with exceptions defined in the Play Console Help Center.
18. https://developer.android.com/privacy-and-security/about and https://developer.android.com/privacy-and-security/declare-data-use — **F**. Data safety form obligation, including SDK data.
19. https://developers.google.com/terms/api-services-user-data-policy — **C** (text "Last updated February 15, 2024"). Minimum scopes, Limited Use (incl. derived data), human-reading limits, ads/credit prohibitions, annual security assessment.
20. https://developers.google.com/workspace/workspace-api-user-data-developer-policy — **SN**. No training of non-personalised AI/ML models with Workspace data; privacy-policy commitment.
21. https://workspace.google.com/blog/ai-and-machine-learning/api-policy-protections — **SN**. Workspace API policy protections for generative AI.
22. https://support.google.com/googleplay/android-developer/answer/10208820 — **SN**. Play SMS/Call Log exceptions: "SMS-based money management" and "SMS-based financial transactions" with the permission lists.
23. https://raw.githubusercontent.com/OxFrancesco/BeeGreat/HEAD/docs/research/google-api-user-data-policy-compliance.md — **C** (secondary, dated 2026-08-13). Summary of 2026 Workspace policy: pre-consent disclosure, agents/MCP coverage, prompt-injection protection, key management, incident reporting, test-mode limits.
24. ~~https://raw.githubusercontent.com/jacklvd/boomerang/HEAD/.claude/artifacts/restricted-scope-gate.html~~ — **removed as a citation (fact-check).** This is an AI-generated research artifact in a third-party repository, not a reliable secondary source. The Chrome Web Store claim now cites https://developer.chrome.com/blog/cws-policy-updates-2026 (primary; blocked, not fetched), corroborated by verbatim quotes in several independent developer repositories. CASA cost figures from that artifact remain (unverified).
25. https://raw.githubusercontent.com/yadava5/applied/HEAD/docs/google/RESTRICTED-SCOPE-JUSTIFICATION.md — **C** (secondary; a third-party app's verification write-up). Used only for "`gmail.metadata` is Restricted" [S]. The `q` restriction is now cited to the official discovery document (#26).
26. Gmail API discovery document, https://gmail.googleapis.com/$discovery/rest?version=v1 — **F** (fact-check pass, revision 20260928). Official OAuth scope list and descriptions; `users.messages.list` `q`: "Parameter cannot be used when accessing the api using the gmail.metadata scope."
27. https://github.com/Sahamati/account-aggregator-standards (specs/aa.yaml, version 1.1.2) — **F/C**. `ConsentDetail` required fields, `consentMode`, `DataLife`, `Frequency`, `FIDataRange`.
28. https://github.com/Sahamati/fair-use-implementation-guidelines-for-aa (README) — **F**. Fair Use templates; AAs as primary enforcers; FIUs' DPDP/RBI compliance.
29. https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml — **C** (URL verified 200). Transaction fields; `/item/remove` semantics; my.plaid.com revocation; OAuth permission-manager caveat.
30. UK Open Banking Account and Transaction API Specification (OpenAPI; repository github.com/OpenBankingUK/read-write-api-specs) — **C**. `/account-access-consents` `Permissions`, `ExpirationDateTime`, transaction date bounds.
31. https://raw.githubusercontent.com/google/differential-privacy/main/README.md — **F**. DP libraries (PipelineDP4j, Privacy on Beam, `dp_accounting`).
32. https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf; https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Rules,_2025; https://www.tcsa.in/resources/dpdp-rules-2025-implementation-roadmap; https://www.privybyidfy.com/blog/dpdp-compliance-guide-2026-what-indian-enterprises-must-do-before-may-2027 — **SN**. DPDP Rules notified 14 Nov 2025; phases (immediate / 12 months Rule 4 / 18 months, about 13 May 2027). *Fact-check:* the Rules are G.S.R. 846(E) dated 13 Nov 2025 (eGazette 267650, https://egazette.gov.in/WriteReadData/2025/267650.pdf; blocked). The commencement dates of 13 Nov 2026 and 13 May 2027 and the text of Rules 6(1)(e) and 8(3) were read from verbatim mirrors (github.com/securzecom/dpdpa-docs; github.com/NarendraKarki/ai-governance).
33. https://www.cozen.com/news-resources/publications/2026/section-1033-compliance-date-open-banking-rule-enjoined-and-under-reconsideration; https://www.consumerfinancemonitor.com/2026/08/06/cfpb-sends-new-section-1033-open-banking-proposal-to-oira-for-review/; https://openbankingtracker.com/guides/section-1033-status; https://risktemplate.com/blog/2026-09-28-cfpb-section-1033-rewrite-data-access-fees-open-banking-fintech-2026/ — **SN**. 1033 enjoined; 1 Apr 2026 compliance date not in effect; Aug 2025 ANPR; NPRM to OIRA 6 Aug 2026; data-access fees under reconsideration.
34. https://taxguru.in/rbi/account-aggregator-framework-complete-application-to-compliance-guide-fintech-founders-nbfc-professionals.html; https://derechoconsulting.com/account-aggregator-compliance-india/ — **SN** (taxguru blocked in the fact-check pass). AA Master Direction clause 3(xii): FIU is "registered with and regulated by any financial sector regulator". Primary: https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10598 (blocked). The verbatim text was confirmed in a scraped copy (github.com/sukeesh/graphrag-1, `BS_ViewMasDirections/10598.txt`, "xii. 'Financial information user' means an entity registered with and regulated by any financial sector regulator"). The 2025 Directions ("Reserve Bank of India (Non-Banking Financial Companies - Account Aggregator) Directions, 2025", RBI MD id 12936 per a third-party extract in github.com/piyushsr-0708/RegIntelAI-V2) keep the definition as item (12).
35. https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know — **SN**. Safeguards Rule "financial institution" (significantly engaged in financial activities) and covered-entity examples.
36. https://developer.android.com/about/versions/17/behavior-changes-17 — **F** (fact-check pass). "OTP protection for standard SMS messages": for apps targeting API 37+, OTP-bearing standard SMS are withheld for three hours.
37. https://raw.githubusercontent.com/OpenTermsArchive/contrib-versions/main/Google%20APIs/Developer%20Terms.md — **F** (Open Terms Archive copy of the Google API Services User Data Policy, "Last updated February 15, 2024"). Limited Use incl. derived data; ads and credit prohibitions; annual security assessment wording.
38. https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/account-info-openapi.yaml — **F**. `ExpirationDateTime` "If this is not populated, the permissions will be open ended."
39. https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/specs/aa.yaml — **F** (v1.1.2). `ConsentDetail` required fields; `consentMode` enum; `DataLife` "How long consumer is allowed to store data".
40. Verbatim statute and regulation copies on GitHub, consulted because the official sites were blocked (all **S**): Cal. Civ. Code §1798.140 (github.com/owassmer/handoff, `CA_CIV_1798.140.txt`); RCW 19.373.010(8) (github.com/open-agreements/open-agreements, `practice-guides/privacy/us/washington.md`); 16 CFR 314.4(j)(1) (same repository, and github.com/zerobias-org/framework); CERT-In Directions of 28 Apr 2022 (github.com/garvjain7/complysense-knowledge-base); DPDP Rules 2025 (github.com/securzecom/dpdpa-docs).
41. Secondary summaries (all **S**): EU AI Act Digital Omnibus, Reg. (EU) 2026/1744 (github.com/RDNordic/eu-ai-compliance-toolkit, `eu-ai-act/omnibus-2026-changes.md`, updated 2026-08-18); ePrivacy Regulation withdrawal, OJ C/2025/5423 (github.com/TVALOUR/website-builder, `profiles/_research/eu.md`); DUAA commencement SI 2026/82 (github.com/ThomasMoreAI/legal-skills-open); PSD3/PSR status (github.com/personamanagmentlayer/pcl, `stdlib/domains/finance-expert/references/compliance-regulatory.md`); UK SCA-RTS Art. 10A and Art. 36(6) (github.com/danialeyz/Willow, `tasks/V1/12-bank-aggregation.md`); TRAI TCCCP (Second Amendment) Regulations 2025 suffixes (github.com/unixipher/paymentgateway, `data/trai/README.md`; github.com/divyanshg03/razorpay-ai-revenue-recovery); Play Protect India sideload blocking and Android developer verification (github.com/Anton-gil/chaufferone, `docs/handoff-v2.md`).

---

## Verification log

Adversarial fact-check pass, 2026-10-04. Verdicts: **confirmed** (supported by the source as stated, at
the evidence level shown), **corrected** (the document text was changed), **unverifiable** (no primary
or adequate secondary source could be reached; the text is now marked accordingly). "Mirror" means a
verbatim copy of the official text in a public GitHub repository; the official site was blocked.

| # | Claim | Verdict | Source |
|---|---|---|---|
| 1 | Apple App Privacy: "collect" means transmitting off-device beyond real-time servicing; on-device-only data is not collected | confirmed [V] | https://developer.apple.com/app-store/app-privacy-details/ |
| 2 | Apple 5.1.2(i): explicit permission before sharing personal data with third parties "including with third-party AI" | confirmed [V] | https://developer.apple.com/app-store/review/guidelines/ |
| 3 | Apple 5.1.1(ix): finance apps must be submitted by a legal entity | corrected (the guideline says "should", for "highly regulated fields") [V] | https://developer.apple.com/app-store/review/guidelines/ |
| 4 | Apple 5.1.1(ii)/(iv) require that core functionality not depend on data access | corrected ((ii) covers *paid* functionality; (iv) says "where possible, provide alternative solutions") [V] | https://developer.apple.com/app-store/review/guidelines/ |
| 5 | FinanceKit is a managed entitlement: org account, Account Holder, Apple review | confirmed [V]; country availability unverifiable | https://developer.apple.com/tutorials/data/documentation/financekit.json |
| 6 | Apple Foundation Models: on-device, Private Cloud Compute or "any server model provider" | confirmed [V] | https://developer.apple.com/tutorials/data/documentation/foundationmodels.json |
| 7 | Gemini Nano/AICore "doesn't store any record of the input data or the resulting outputs" | confirmed [V] | https://developer.android.com/ai/gemini-nano |
| 8 | Android 15 redacts OTP notifications for untrusted NotificationListenerService apps | confirmed [V] | https://developer.android.com/about/versions/15/behavior-changes-all |
| 9 | Android 17 withholds WebOTP SMS for 3 h from non-recipient apps | confirmed and expanded [V]: applies to all apps; apps targeting API 37+ also have standard OTP-bearing SMS withheld for 3 h | https://developer.android.com/about/versions/17/behavior-changes-all ; https://developer.android.com/about/versions/17/behavior-changes-17 |
| 10 | NotificationListenerService needs user enablement; no other limits noted | corrected (added: unavailable on low-RAM devices running Android 10 or earlier; ignored in work profiles) [V] | https://developer.android.com/reference/android/service/notification/NotificationListenerService |
| 11 | Auto Backup: 25 MB, E2E on Android 9+ with screen lock, `dataExtractionRules` | confirmed [V]; added the `<cross-platform-transfer>` section (Android 16 QPR2+) | https://developer.android.com/identity/data/autobackup |
| 12 | Google UDP: Limited Use covers raw, aggregated, anonymised and derived data; no ads or credit use; annual security assessment and Letter of Assessment; last updated 15 Feb 2024 | confirmed (Open Terms Archive copy of the primary page) | https://raw.githubusercontent.com/OpenTermsArchive/contrib-versions/main/Google%20APIs/Developer%20Terms.md |
| 13 | `gmail.metadata` cannot run `q` queries | confirmed, upgraded [S]→[V] | https://gmail.googleapis.com/$discovery/rest?version=v1 (rev. 20260928) |
| 14 | `gmail.metadata` and `gmail.readonly` are Restricted | unverifiable at primary (developers.google.com blocked); kept [S] | https://developers.google.com/workspace/gmail/api/auth/scopes (not fetched) |
| 15 | Workspace policy forbids training generalised/non-personalised AI/ML | confirmed [S] (the commitment wording is widespread in privacy policies; primary blocked) | https://developers.google.com/workspace/workspace-api-user-data-developer-policy (not fetched) |
| 16 | OAuth "Testing" projects: 7-day refresh tokens; 100 test users | confirmed [S] (Google doc text quoted in several repositories) | https://developers.google.com/identity/protocols/oauth2 (not fetched) |
| 17 | Play SMS exception "SMS-based money management" (READ_SMS, RECEIVE_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH) | confirmed [S] (support.google.com blocked; the same quote appears in several repositories) | https://support.google.com/googleplay/android-developer/answer/10208820 (not fetched) |
| 18 | Chrome Web Store Limited Use tightened from 1 Aug 2026 | confirmed [S]; citation corrected (the AI-generated artifact was replaced with the primary blog URL and multi-repo corroboration) | https://developer.chrome.com/blog/cws-policy-updates-2026 (not fetched) |
| 19 | AA FIU must be "registered with and regulated by any financial sector regulator", clause 3(xii) | confirmed [S] (mirror of RBI MD id 10598); corrected to cite the 2025 consolidated AA Directions, item (12) | rbi.org.in MD 10598 (blocked); github.com/sukeesh/graphrag-1 |
| 20 | Sahamati `ConsentDetail` fields and `DataLife` units | confirmed [V] | https://raw.githubusercontent.com/Sahamati/account-aggregator-standards/main/specs/aa.yaml |
| 21 | Sahamati Fair Use: AAs are the "primary enforcers", FIPs a second line | confirmed [V] | https://raw.githubusercontent.com/Sahamati/fair-use-implementation-guidelines-for-aa/main/README.md |
| 22 | DPDP Rules notified 14 Nov 2025; Rule 4 about Nov 2026; substantive obligations about 13 May 2027 | corrected/refined [S]: G.S.R. 846(E) dated 13 Nov 2025; Rule 4 from 13 Nov 2026; substantive obligations from 13 May 2027 | mirrors: github.com/securzecom/dpdpa-docs, github.com/NarendraKarki/ai-governance |
| 23 | DPDP Rules keep logs for at least one year | corrected/expanded [S]: Rule 6(1)(e) keeps logs and personal data for one year; Rule 8(3) sets a one-year minimum for personal data, traffic data and processing logs. Missing tension with R0/R0s flagged | mirror: github.com/securzecom/dpdpa-docs (Rules 06 and 08) |
| 24 | DPDP s.9 bans tracking and behavioural monitoring of children | confirmed [S] (secondary summary of the Act) | github.com/NarendraKarki/ai-governance |
| 25 | CERT-In Directions (28 Apr 2022): 6-hour reporting; 180-day logs in India | confirmed [S] (mirror) | github.com/garvjain7/complysense-knowledge-base (CERT_IN_Directions.md) |
| 26 | TRAI `-S`/`-T`/`-P`/`-G` suffixes, and that `-S`/`-T` identify bank alerts | corrected [S]: TCCCP (Second Amendment) Regulations 2025 (12 Feb 2025); `-T` is mostly OTP, bank alerts mostly `-S`; rollout uneven | github.com/unixipher/paymentgateway; github.com/Yashwant00CR7/Finance-Manager |
| 27 | CFPB 1033: enjoined; 1 Apr 2026 date not in effect; NPRM to OIRA 6 Aug 2026 | confirmed with caveat [S]: E.D. Ky. preliminary injunction (Oct 2025); NPRM to OIRA early Aug 2026 (reported 6 Aug; one source says 5 Aug); publication unconfirmed | consumerfinancemonitor.com (blocked); several consistent secondary repos |
| 28 | FTC Safeguards: FTC notice within 30 days for 500+ consumers | confirmed [S] (mirror of 16 CFR 314.4(j)(1)); effective date 13 May 2024 unverifiable | github.com/zerobias-org/framework |
| 29 | CCPA SPI includes contents of mail, email and texts unless the business is the intended recipient | confirmed [S] (mirror of §1798.140(ae)) | github.com/owassmer/handoff |
| 30 | WA MHMDA covers health data derived from non-health data; private right of action; "Nevada and Connecticut similar" | confirmed definition [S] (mirror of RCW 19.373.010(8)); corrected: Nevada SB 370 has no private right of action (unverified) | github.com/open-agreements/open-agreements |
| 31 | AI Act Art. 50 scheduled for 2 Aug 2026; Digital Omnibus unverified | corrected [S]: Reg. (EU) 2026/1744 in force 27 Jul 2026; Art. 50 applies since 2 Aug 2026; Annex III high-risk deferred to 2 Dec 2027 | github.com/RDNordic/eu-ai-compliance-toolkit |
| 32 | ePrivacy Regulation withdrawn in 2025 | confirmed [S]: OJ C/2025/5423, 6 Oct 2025; Digital Omnibus COM(2025) 837 still pending | github.com/TVALOUR/website-builder |
| 33 | PSD3/PSR provisional agreement in late Nov 2025 | confirmed [S] (27 Nov 2025); formal adoption still unconfirmed as of 2026-10-04 | github.com/personamanagmentlayer/pcl |
| 34 | AIS re-authentication 180 days (EU and UK) | corrected [S]: EU 180 days under Del. Reg. 2022/2360 from 25 Jul 2023; UK has no periodic bank SCA and a 90-day AISP reconfirmation (SCA-RTS Arts 10A, 36(6)) | github.com/danialeyz/Willow; github.com/cto-mtm/teremu-app |
| 35 | UK DUAA "being commenced in stages" | corrected [S]: Arts 22A-22D in force from 5 Feb 2026 (SI 2026/82) | github.com/ThomasMoreAI/legal-skills-open |
| 36 | UK OBIE `ExpirationDateTime` open-ended if unset | confirmed [V] | https://raw.githubusercontent.com/OpenBankingUK/read-write-api-specs/master/dist/openapi/account-info-openapi.yaml |
| 37 | Plaid `/item/remove` best practice, OAuth permission-manager caveat, my.plaid.com, transaction fields | confirmed [V] | https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml |
| 38 | Google DP libraries (PipelineDP4j, Privacy on Beam, `dp_accounting`) | confirmed [V] | https://raw.githubusercontent.com/google/differential-privacy/main/README.md |
| 39 | Message Filter extension's purpose is filtering unwanted SMS; server deferral via Associated Domains | confirmed [V]; "sees only unknown senders" remains unverifiable | https://developer.apple.com/tutorials/data/documentation/identitylookup/creating-a-message-filter-app-extension.json |
| 40 | Play Protect sideload blocking in India; Android developer verification from 30 Sep 2026 | added (missing from the original) [S] | github.com/Anton-gil/chaufferone (secondary) |

**Remaining unverifiable items** (still marked [U] or "(unverified)" in the text): FinanceKit country
availability; the iOS message filter's unknown-senders scope; Android "restricted settings" for
sideloaded builds; whether Play needs a declaration for notification-listener access; PCI DSS 4.0.1
details and truncation rules; EDPB Guidelines 2/2023 and the CJEU case citations; GLBA
"financial institution" status for BRAKE; HBNR and COPPA dates; MODPA dates; the NPCI position on
`upi://` intent handling; RBI payment-data localisation flow-down; Microsoft Graph publisher
verification rules; CASA cost figures; and the 2026 Workspace policy additions reported by reference
#23.
