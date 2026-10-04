# 09: Behavioral science for BRAKE: interventions, regret and learning loops

> **Scope.** This stream covers the behavioral evidence and the learning-loop design behind BRAKE's
> value: friction and pause interventions, cooling-off periods, pain of paying and payment-method
> effects, mental accounting, impulse-buying triggers (time of day, mood, social media, scarcity
> cues, BNPL), commitment devices, implementation intentions, goal salience, reactance and why
> shaming backfires, notification fatigue, autonomy-supportive design, avoiding dark patterns,
> measuring regret and satisfaction after the fact, labeling burden, uncertainty-driven active
> learning, and how to communicate uncertainty. It ends with concrete policies: when to intervene,
> how strongly, how to phrase post-spend insights, how many questions to ask per week, and how to
> sample regret prompts.
>
> **Date:** 2026-10-04. **Author:** research stream 09.
>
> **Verification status. Read this first.** This session could reach only `developer.apple.com` and
> `developer.android.com`. The egress proxy blocked publisher, PubMed, DOI, NBER, arXiv, regulator
> (CFPB, FCA, FTC, gov.uk, EUR-Lex) and Wikipedia hosts, and the shared web-search quota was
> already used up. So:
> - **[V]** marks a platform fact verified on 2026-10-04 against a page listed in References §A.
> - **[L]** marks a finding from the established peer-reviewed literature, cited from the author's
>   knowledge. The bibliographic details are believed correct but were **not** re-fetched in this
>   session. Any number I am not sure of is also marked **(unverified)**.
> - **[D]** marks a BRAKE design default proposed here. It is a starting value to tune by experiment,
>   not an evidence-derived constant.
> - Regulatory dates after mid-2025 are marked **(unverified)** and must be re-checked before use.
>
> ### Key takeaways for BRAKE
> 1. **Friction works when it is chosen, brief and skippable.** The one sec field study [L] found
>    that a few seconds of self-chosen friction before opening an app cut opening attempts
>    substantially. In-spend friction should follow that shape: user-selected surfaces, a pause of
>    seconds, and "Continue" always visible. Model-initiated interventions are capped at a
>    non-blocking nudge. Strong friction (holds, cooling-off) comes **only** from rules the user wrote.
> 2. **Scolding defeats the product.** Controlling language triggers reactance [L]. Shame drives
>    withdrawal and avoidance [L]. People already avoid financial information when the news is bad
>    (the "ostrich effect" [L]). A scolding BRAKE gets muted, then uninstalled. Post-spend copy should
>    be informational, compare the user with their own baseline, look forward, and leave the choice
>    explicitly with the user. When there is no insight, BRAKE says nothing.
> 3. **Attention is the budget.** Proposed hard caps [D]: at most 1 model-initiated push per day,
>    at most 4 non-user-requested prompts per week across all types (insights, questions, regret
>    checks), and 1 weekly digest. Questions are paced against a shadow price (§Implications 4.3).
>    Notification-disable and "stop asking" rates serve as guardrail metrics. The platforms already
>    penalize noise: Android 15 cools down rapid repeat notifications [V], Android 13+ ships
>    notifications **off by default** [V], and the Apple HIG warns that repeated notifications lead
>    people to turn off all of an app's notifications [V].
> 4. **Ask by expected value of information (EVOI), never by default.** Ask about a transaction only
>    when the answer changes something: a budget interpretation (especially transfer vs spending), a
>    future intervention, or many future transactions through merchant-level propagation. After
>    onboarding, ask 2–3 questions a week at most [D]. Each question offers the top-2 predicted
>    answers plus "Other…": Android allows at most **3** action buttons [V], and iOS shows at most
>    **2** when space is limited [V].
> 5. **Regret prompts should be rare, delayed and randomized.** Default to 1 per week [D]. The delay
>    depends on purchase type: consumables and experiences after ≈18–36 h; physical goods ≈3 days
>    after delivery; always before the return window closes. Part of the selection must be random,
>    with logged propensities. A sampler that only asks about purchases it already suspects are
>    regretted produces a biased regret model, which inverse-propensity weighting corrects. Never show
>    regret totals, streaks or scores.
> 6. **Learn "worth it", not just "regret".** Long-run regrets often concern *under*-spending,
>    especially on experiences (hyperopia [L]). Experiential purchases also look better in memory
>    over time [L]. "Tightwads" already feel too much pain of paying [L]. BRAKE's personalization has
>    to be able to *reduce* friction and say "this kind of spending is usually worth it for you".
> 7. **Express uncertainty in counts from the user's own history**, e.g. "You marked 4 of your last
>    6 late-night gadget buys as 'wish I hadn't'". Back this with BRAKE's confidence bands
>    (statement / "looks like" / question / silence). People interpret verbal hedges such as
>    "likely" inconsistently, and less so when a number is attached [L].
> 8. **Treat late-night, mood and social-media triggers as hypotheses to learn per user, not as
>    rules.** The evidence is mostly lab-based or correlational. Ego depletion, the usual
>    "late-night willpower" story, failed a large preregistered replication [L]. Use local time as a
>    cheap feature. **Never** infer emotion passively.
> 9. **Optimize decision quality, not engagement.** Primary outcomes: the share of discretionary
>    spending later rated "worth it", the inverse-propensity-weighted (IPW) regret rate, goal
>    progress, and the CFPB Financial Well-Being Scale. Autonomy and notification-disable rates are
>    guardrails. Use micro-randomized trials [L] to estimate the in-context effect of each
>    intervention type.
> 10. **BRAKE's own UX is regulated design.** India's CCPA guidelines list 13 dark patterns,
>     including *confirm shaming* and *nagging* [L]. EU DSA Art. 25 and EU AI Act Art. 5 (in force
>     since 2 Feb 2025) bans on manipulation [L] apply to BRAKE's paywall, cancellation flow and
>     interventions. Friction that the user authored, that is transparent and that the user can
>     reverse is defensible. Obstructing disconnection, cancellation or data deletion is not.

---

## Evidence base (condensed, decision-oriented)

This section summarizes what the literature says and what each finding means for BRAKE. The
"Sources investigated" section then assesses each signal or mechanism BRAKE could use.

### E1. Friction and pause interventions

| Finding | Status | BRAKE implication |
|---|---|---|
| **Grüning, Riedel & Lorenz-Spreen (2023), PNAS 120(8) e2213114120.** The self-nudge app *one sec* puts a short delay (a breathing animation lasting seconds) plus a "do you still want to open X?" choice before a user-selected app opens. The reported results: about a third of opening attempts (≈36%) ended at the friction screen, and opening attempts on target apps fell by ≈57% over ~6 weeks. **(Figures recalled from the abstract, unverified this session.)** The users installed the app and chose the target apps themselves, so self-selection is part of the effect. | [L] | This is the strongest direct evidence for a **brief, self-chosen, skippable** pause. It supports app-launch friction on shopping apps the user selects, and a pause at BRAKE-owned hand-offs such as the QR→UPI intent. It does **not** support imposing friction the user did not choose. |
| **Hot–cold empathy gaps / visceral states** (Loewenstein 1996, OBHDP 65(3); Loewenstein 2005, Health Psychology 24(4S)). Cravings are strong in the moment and fade with time. People in a "cold" state underestimate how they will behave in a "hot" one. | [L] | Theory for why **delay** helps. Even a short delay moves the decision away from the peak of the craving. Cooling-off is a mechanism, not a punishment. |
| **Asymmetric paternalism / cooling-off** (Camerer, Issacharoff, Loewenstein, O'Donoghue & Rabin 2003, U. Penn Law Review 151(3)). Cooling-off periods are offered as a low-cost intervention: they help people in hot states and cost little to deliberate choosers. | [L] | This justifies BRAKE's **"tighten now, loosen later"** pattern for user-authored rules. |
| **Legal cooling-off precedents.** The EU Consumer Rights Directive 2011/83/EU gives a 14-day right of withdrawal for distance contracts. The US FTC Cooling-Off Rule (16 CFR 429) gives 3 business days for door-to-door and temporary-location sales. | [L] | The "return window" is a real **post-spend regret remedy**. A regret signal is most useful when the purchase can still be returned or cancelled. |
| **Gambling self-limits.** Regulators and banks delay the *loosening* of self-imposed limits: UK Gambling Commission remote technical standards apply increases to deposit limits only after a cooling-off period (≈24 h), and UK app banks impose a waiting period (e.g. 48 h) before a user-enabled gambling block can be switched off. **(Unverified as of 2026; re-check.)** | [L] | This is the precedent for **delayed loosening** of BRAKE rules: 24 h [D]. |
| **"Sleep on it" is not magic.** The "unconscious thought advantage" did not hold up in a meta-analysis and large replication (Nieuwenstein et al. 2015, Judgment and Decision Making 10(1)). | [L] | Do not claim that delay improves decisions in itself. Claim that it lets the craving subside and gives the user a chance to check against their goals. |
| **Habituation.** Repeated identical warnings become "wallpaper"; varying the warning's form (polymorphic warnings) slows habituation (Anderson, Vance, Kirwan et al. 2016, J. Management Information Systems 33(3)). | [L] | The same pause shown on every checkout stops working. Rotate formats, keep pauses rare, and watch the user's proceed-through rate. |

**Optimal pause length.** No study establishes an optimal in-spend pause for purchases. one sec
uses seconds, and the legal and banking precedents use 24–48 h for *loosening* commitments. BRAKE
should therefore run two different mechanisms: an **in-the-moment pause** of 3–10 s [D], and an
**opt-in hold** of 24 h by default (choices 1 h / 24 h / 72 h / 7 d) [D]. The hold works by saving
the item to a BRAKE wishlist and sending a reminder at the end of the hold.

### E2. Pain of paying, payment-method effects and mental accounting

| Finding | Status | BRAKE implication |
|---|---|---|
| **Prelec & Loewenstein (1998), "The Red and the Black", Marketing Science 17(1).** Paying hurts. The pain is reduced by *decoupling* payment from consumption (prepaying, credit, bundles), and people prefer prepaying for consumption. | [L] | Card, UPI, wallet, one-click and BNPL payments all decouple. BRAKE can **re-couple** gently by making the amount and its effect salient at the moment of choice. |
| **Prelec & Simester (2001), Marketing Letters 12(1).** In sealed-bid auctions, credit-card payers bid much more, up to roughly double in one auction **(magnitude unverified)**. Earlier: Feinberg (1986) JCR 13(3), credit-card cues raise spending; Hirschman (1979) JCR. | [L] | Payment form is a real lever. **The magnitudes vary widely across studies and some samples are small**, so treat the direction as reliable and the size as unknown. |
| **Soman (2001), JCR 27(4).** Payment "rehearsal" (writing out the amount) and "immediacy" (money visibly leaving at once) reduce later spending. Card and cheque payers who had not rehearsed recalled past spending worse. | [L] | Post-spend "rehearsal", i.e. an accurate running total in context, plausibly restores some of the pain cash used to provide. This is one reason the brief's "₹500 at Swiggy, food this week 38% above your usual pace" is the right *kind* of message. |
| **Raghubir & Srivastava (2008), J. Exp. Psych.: Applied 14(3).** Willingness to spend rises as payment becomes less transparent: cash, then card, then gift card or scrip. | [L] | Wallet, UPI Lite, stored value and BNPL are lower-transparency forms. Expect these rails to carry more regretted spending. Use `rail.family` as a model feature. |
| **Knutson, Rick, Wimmer, Prelec & Loewenstein (2007), Neuron 53(1).** Insula activation in response to an excessive price predicted *not* buying. **Banker, Dunfield, Huang & Prelec (2021), Scientific Reports 11.** Credit-card cues engaged reward circuitry **(details unverified)**. | [L] | Neural evidence that is consistent with "pain of paying". It is not needed for product decisions. |
| **Rick, Cryder & Loewenstein (2008), JCR 34(6), "Tightwads and spendthrifts".** Individual differences in pain of paying, measured with a short Spendthrift–Tightwad scale. Tightwads outnumbered spendthrifts (reported ≈3:2, **unverified**). Lowering the pain of paying raises tightwads' spending more. | [L] | **The same nudge is wrong for different users.** Adding pain to an already-tight user can harm wellbeing. Personalize the direction of intervention (see `spending-style-self-assessment`). |
| **Shah, Eisenkraft, Bettman & Chartrand (2016), JCR 42(5), "Paper or plastic?"** Paying in cash increased emotional connection to the purchase afterwards. | [L] | Satisfaction is partly a product of the payment mode. Record `rail` alongside satisfaction labels. |
| **Mental accounting** (Thaler 1985, Marketing Science 4(3); Thaler 1999, JBDM 12(3)) and **mental budgeting** (Heath & Soll 1996, JCR 23(1)). People track spending against category budgets, tend to *underestimate* small and miscategorized spending, and treat money as non-fungible. | [L] | BRAKE's categories and "pace" messages **work through** mental accounts, so the user's own accounts beat a generic taxonomy. Miscategorization (a transfer counted as spending) also distorts the user's mental account. That is why the brief says it "destroys trust". |
| **Mobile and instant rails.** Studies generally find that mobile and contactless payment lowers payment salience and may raise willingness to pay (e.g. Boden, Maier & Wilken 2020, J. Retailing & Consumer Services, **details unverified**). India-specific causal evidence that UPI raises spending exists only in working papers and surveys **(unverified)**. | [L] | Plausible but not settled. Learn the effect per user instead of hard-coding it. India: UPI Lite allows PIN-less small payments (per-transaction cap raised to ₹1,000 in Dec 2024, **unverified**), which removes the one friction moment UPI had for small amounts. |

### E3. Impulse-buying triggers

| Trigger | Evidence quality | Key sources | BRAKE use |
|---|---|---|---|
| **Impulse buying as a construct** | Strong descriptive evidence | Rook (1987) JCR 14(2): a sudden, powerful urge, often with hedonic complexity and conflict | Defines `intent = impulsive` and `purchase_context = saw_and_bought` |
| **Self-regulatory depletion** ("tired, late, weak willpower") | **Contested** | Vohs & Faber (2007) JCR 33(4) found depletion increased impulse buying. The **multisite preregistered replication** of ego depletion found an effect near zero, d≈0.04 (Hagger et al. 2016, Perspectives on Psych. Science 11(4)) | Do **not** build a universal "late night = weak willpower" rule. |
| **Late night / sleep loss** | Moderate (lab), weak (field) | Sleep deprivation shifted economic preferences toward gain-seeking (Venkatraman et al. 2011, J. Neuroscience 31(10), **details unverified**). I found no peer-reviewed field estimate of a "late-night ecommerce regret" effect. | Use local hour as a **cheap feature**. Learn per user whether late-night purchases are regretted (the brief's example), and offer a user-authored rule only when the pattern is credible for that user. |
| **Sadness / negative mood** | Moderate (lab) | Lerner, Small & Loewenstein (2004) Psych Science 15(5): sadness raised buying prices. Cryder et al. (2008) Psych Science 19(6), "Misery is not miserly". Atalay & Meloy (2011) Psychology & Marketing 28(6), retail therapy. Rick, Pereira & Burson (2014) JCP 24(3): shopping can reduce residual sadness. | Mood affects spending, **and** some mood-driven spending is functional. **Never infer mood passively.** An optional self-report tag ("bought this to feel better") can be learned from. |
| **Social media** | Moderate (lab + correlational) | Wilcox & Stephen (2013) JCR 40(1): browsing close friends' content on social networks raised self-esteem and lowered subsequent self-control. Heavier network use correlated with higher credit-card debt. | Cross-app surveillance is invasive. Offer **user-selected** shielding of social shopping surfaces instead (see `app-launch-friction`), and the "share to BRAKE" check. |
| **Scarcity and urgency cues** | Strong for prevalence, moderate for effect | Mathur et al. (2019) Proc. ACM HCI 3(CSCW): a crawl of ~11K shopping sites found **1,818** dark-pattern instances, including countdown timers, low-stock and "high demand" messages, some demonstrably fake. Lynn (1991) meta-analysis: scarcity raises perceived value. FTC staff report *Bringing Dark Patterns to Light* (Sept 2022). | Counter-messaging in-spend ("this timer resets on reload") is possible via a browser extension (`dark-pattern-cue-detection`), but **later**. |
| **BNPL** | Moderate | CFPB *Buy Now, Pay Later: Market trends and consumer impacts* (Sept 2022). CFPB Making Ends Meet analysis of BNPL users (Jan 2025, **unverified**). Di Maggio, Katz & Williams (2022) NBER w30508: BNPL access raised total retail spending (**magnitude unverified**). Guttman-Kenney, Firth & Gathergood (2023) J. Behavioral & Experimental Finance: UK BNPL purchases were often repaid by credit card. | `rail.family = "bnpl"` is a strong candidate feature for regret and for **upcoming-instalment** insights. Regulation is moving: UK FCA regulation of deferred payment credit from 15 Jul 2026, EU CCD2 applying from 20 Nov 2026 (**both unverified**). |
| **Payday / liquidity** | Strong | Stephens (2003) AER 93(1), consumption spikes on cheque arrival. Gelman et al. (2014) Science 345(6193), using personal-finance-app data, found spending responds to paycheck arrival. Olafsson & Pagel (2018) RFS 31(11): spending spikes at payday even among liquid users, using Icelandic PFM data. | `payday-proximity` is a well-supported context feature. It is also a **fresh-start** moment for goal check-ins. |

### E4. Commitment devices, implementation intentions and goal salience

| Finding | Status | BRAKE implication |
|---|---|---|
| **SEED, Ashraf, Karlan & Yin (2006), QJE 121(2).** A voluntary commitment savings account in the Philippines. About 28% of those offered took it up, and treatment-group savings balances rose by ≈81 percentage points relative to control after 12 months **(as reported; unverified this session)**. | [L] | **Voluntary** commitments help a minority who want them. Offer them; never default users into restriction. |
| **SMarT, Thaler & Benartzi (2004), JPE 112(S1).** Users pre-commit to saving more out of *future* raises. Participants' saving rates rose from ≈3.5% to ≈13.6% over ~40 months. | [L] | Commitments framed around future events ("when payday comes, move ₹X first") are easier to accept than present sacrifice. |
| **Bryan, Karlan & Nelson (2010), Annual Review of Economics 2.** Review: take-up of commitment devices is modest, and some takers default on them. Soft commitments (no penalty) are taken up more and have weaker effects. | [L] | BRAKE commitments should be **soft** (a pause or hold, never a lock on the user's money). Expect a minority to opt in. |
| **Implementation intentions** (Gollwitzer 1999, Am. Psychologist 54(7)). Gollwitzer & Sheeran (2006) meta-analysis, Adv. Exp. Soc. Psych. 38: **94 independent tests, d≈0.65** on goal attainment. | [L] | Let users write **if–then rules** in their own words ("If I'm buying clothes after 11 pm, then I'll add them to my list and decide tomorrow"). These rules are BRAKE's highest-value, lowest-reactance intervention triggers. |
| **Reminders and goal salience** (Karlan, McConnell, Mullainathan & Zinman 2016, Management Science 62(12)). SMS reminders raised savings (≈6%), and reminders that mentioned the specific goal worked better **(exact figures unverified)**. Soman & Cheema (2011) JMR 48: earmarking and partitioning money (e.g. a child's photo on the envelope) increased saving. | [L] | Name the user's goal in the intervention ("Goa trip: ₹12,000 to go"). Do not use a generic "save money". |
| **Fresh-start effect** (Dai, Milkman & Riis 2014, Management Science 60(10)). Temporal landmarks such as a new week, new month or birthday increase aspirational behavior. | [L] | Schedule goal check-ins and rule suggestions on landmarks (Monday, the 1st, payday), not at random times. |
| **Goal setting in fintech apps** (Gargano & Rossi 2024, Journal of Finance, **venue/details unverified**). Setting goals in a savings app was associated with more saving. | [L] | Goal setting belongs in onboarding for users with no connected source ("User C" in the brief). |
| **Opportunity-cost neglect** (Frederick, Novemsky, Wang, Dhar & Nowlis 2009, JCR 36(4); Spiller 2011, JCR 38(4)). Simply reminding people what else the money could buy shifted choices toward cheaper options. | [L] | The cheapest effective in-spend nudge is to show the trade-off in the user's own terms ("= 2 weeks of your Goa fund"). It informs without judging. |

### E5. Reactance, shame, avoidance and autonomy

| Finding | Status | BRAKE implication |
|---|---|---|
| **Psychological reactance** (Brehm 1966; Rains 2013 meta-analysis, Human Communication Research 39(1)). Threats to freedom produce anger, counter-arguing and the opposite behavior. **Miller et al. (2007), HCR 33(2).** Controlling language ("you must", "you should") raised reactance, and a freedom-restoring postscript reduced it. | [L] | Avoid imperatives and "should". Close interventions with an explicit freedom statement ("Your call.", "Totally fine if this was planned."). |
| **"But you are free"** (Carpenter 2013 meta-analysis, Communication Studies 64(1)). Explicitly reminding people that they are free to refuse *increased* compliance with requests **(effect size unverified)**. | [L] | Freedom language is not just polite. It makes the reflection prompt work better. |
| **Shame vs guilt** (Tangney, Stuewig & Mashek 2007, Annual Review of Psychology 58). Shame, a global "I am bad", leads to withdrawal, hiding and defensiveness. Guilt, a specific "I did a bad thing", leads to repair. | [L] | Never characterize the *person* ("impulsive", "bad with money"). If a pattern is surfaced, attach it to a context ("late-night gadget buys"), never to the self, and pair it with an action the user controls. |
| **Ostrich effect** (Karlsson, Loewenstein & Seppi 2009, J. Risk & Uncertainty 38(2); Sicherman, Loewenstein, Seppi & Utkus 2016, RFS 29(4)). Investors look at their accounts less after bad news. Olafsson & Pagel (NBER WP 23945, "The ostrich in us"), using PFM login data: people check finances more after paydays and less when balances are low **(unverified details)**. | [L] | A BRAKE that delivers bad news in a judgmental frame trains users to look away exactly when it matters. Keep the information value high and the emotional cost low. |
| **Side effects of nudges** (Medina 2021, RFS 34(5)). Credit-card payment reminders reduced late fees but **raised overdraft fees**, consistent with limited attention being reallocated **(magnitudes unverified)**. Stango & Zinman (2014) RFS 27(4): answering survey questions about overdrafts reduced overdrafting, and the effect decayed over time. | [L] | (1) Interventions move attention around rather than creating it, so measure **net** outcomes. (2) **Asking questions is itself an intervention** (question–behavior effect: Sprott et al. 2006; meta-analyses by Wood et al. 2016 PSPR and Spangenberg et al. 2016 JCP, small effects). Labeling prompts are part of the treatment and must be counted in experiments. |
| **Social comparison and boomerangs** (Schultz et al. 2007, Psych Science 18(5); Allcott 2011, J. Public Econ. 95(9–10), ≈2% energy reduction from Opower reports; Allcott & Rogers 2014, AER 104(10): effects decay between reports and repeated reports build persistence). Descriptive norms pull below-average users *up*, the "boomerang". | [L] | Compare users with **their own baseline**, not with peers. Peer comparison risks shaming high spenders and licensing low spenders to spend more. Expect intervention effects to decay and to need spaced repetition, not a daily drip. |
| **Self-determination theory** (Ryan & Deci 2000, Am. Psychologist 55(1)) and **METUX** (Peters, Calvo & Ryan 2018, Frontiers in Psychology 9). Supporting autonomy, competence and relatedness sustains engagement and wellbeing. Controlling design undermines intrinsic motivation. | [L] | Design for perceived autonomy: user-authored rules, explanations ("You asked BRAKE to…"), an intensity setting, and one-tap "not now" and "stop this". |
| **Boosts and self-nudging** (Hertwig & Grüne-Yanoff 2017, Perspectives on Psych. Science 12(6); Reijula & Hertwig 2022, Behavioural Public Policy 6(1)). Interventions that build the person's own competence, or let them configure their own environment, are more transparent and more legitimate than externally imposed nudges. | [L] | BRAKE's identity should be a **self-nudging tool**: the user designs their own choice environment, and BRAKE supplies evidence and good defaults. |
| **Algorithm aversion** (Dietvorst, Simmons & Massey 2015, JEP: General 144(1)). People abandon algorithms after seeing them err. **Dietvorst et al. 2018, Management Science 64(3):** people keep using imperfect algorithms if they can modify them, even slightly. | [L] | One-tap correction and adjustable rules are *trust* features as well as data collection. |

### E6. Notification fatigue and alert burden

| Finding | Status | BRAKE implication |
|---|---|---|
| Smartphone users receive dozens of notifications a day: **≈63.5/day** in a small in-situ study (Pielot, Church & de Oliveira 2014, MobileHCI). Mehrotra et al. (2016, CHI): receptivity depends on content, sender and context, not just timing. | [L] | BRAKE competes for scarce attention. Every send must carry value. |
| One notification is enough to disrupt attention (Stothart, Mitchum & Yehnert 2015, JEP: HPP 41(4)). Kushlev, Proulx & Dunn (2016, CHI): turning notifications on raised inattention and hyperactivity symptoms. **Fitz et al. (2019), Computers in Human Behavior:** batching notifications ~3×/day improved wellbeing, while switching them off entirely raised anxiety and fear of missing out **(details unverified)**. | [L] | **Batch** non-urgent content into a digest. Make "quiet mode" one tap, but don't make BRAKE silent by default. Users who switch it off entirely may simply worry more. |
| **Clinical alert fatigue**: 49–96% of drug-safety alerts are overridden (van der Sijs et al. 2006, JAMIA 13(2)). Acceptance falls as repeated alerts for the same patient pile up (Ancker et al. 2017, BMC Med. Inform. Decis. Mak. 17; the size of the per-repeat drop is **unverified**). | [L] | Repeated low-value alerts erode the value of the high-value ones. Rate-limit by **topic** as well as by count. |
| **Just-in-time adaptive interventions** (Nahum-Shani et al. 2018, Annals of Behavioral Medicine 52(6)): define decision points, tailoring variables, intervention options and decision rules, and treat "do nothing" as an option. **Micro-randomized trials** (Klasnja et al. 2015, Health Psychology 34(S)). HeartSteps (Klasnja et al. 2019, Ann. Behav. Med. 53(6)): contextual activity suggestions had a positive short-term effect that **declined over time in the study** **(numbers unverified)**. | [L] | BRAKE's intervention engine *is* a JITAI. Use its vocabulary and evaluate it with micro-randomization. Plan for decay. |
| **Apple HIG (Notifications):** "Avoid sending multiple notifications for the same thing, even if someone hasn't responded… people may turn off all notifications from your app." It also says to avoid sensitive or personal information in notifications, and that the detail view can contain **up to four** buttons. | [V] | Never re-send an unanswered question. Expire it silently into the weekly review. |
| **Apple App Store Review Guideline 4.5.4:** push notifications "should not be used to send sensitive personal or confidential information" and need explicit opt-in for marketing. | [V] | Amounts and merchants on the lock screen carry policy and privacy risk. Generate notifications **locally** (local notification requests) from on-device data where possible, and default to hidden previews for amounts (see Risks). |
| **iOS interruption levels (iOS 15+):** `passive` (no screen wake or sound), `active`, `timeSensitive` ("breaks through system notification controls") and `critical`. `relevanceScore` (0–1) picks the featured notification in the summary. | [V] | Map BRAKE content to levels: digests and post-spend insights → `passive`; one-tap labels → `active`; reserve `timeSensitive` for *user-requested* reminders (a hold expiring, a refund deadline). BRAKE never needs `critical`. |
| **Android:** notifications must be on a channel (8.0+). Users control each channel, and the app **cannot change a channel's importance after creating it**. Android 13+ needs `POST_NOTIFICATIONS` and "notifications are off by default". Android 15 **cooldown** "reduces the appearance, sound volume and vibration intensity for repetitive notifications for up to two minutes". At most **3 action buttons**. | [V] | Create separate channels (`insights`, `questions`, `holds_and_reminders`, `digest`) so users can mute one type without losing all of BRAKE. Ask for notification permission **in context**, e.g. when the user creates their first hold, as Android's guidance recommends. |

### E7. Dark patterns BRAKE must avoid (and may help counter)

- **Taxonomy and prevalence.** Mathur et al. (2019) catalogued sneaking, urgency, misdirection,
  social proof, scarcity, obstruction and forced action [L]. The FTC staff report (Sept 2022) adds
  enforcement framing [L].
- **India: CCPA *Guidelines for Prevention and Regulation of Dark Patterns, 2023*** (notified
  30 Nov 2023). It lists **13** patterns: false urgency, basket sneaking, confirm shaming, forced
  action, subscription trap, interface interference, bait and switch, drip pricing, disguised
  advertisement, nagging, trick question, SaaS billing and rogue malware [L]. *Confirm shaming*
  (e.g. "No thanks, I like wasting money") and *nagging* are the traps a "spending coach" falls into
  most easily.
- **EU:** DSA Art. 25 (Reg. (EU) 2022/2065) prohibits online interfaces that deceive or manipulate
  [L]. EDPB Guidelines 03/2022 cover deceptive design patterns [L]. **EU AI Act** (Reg. (EU)
  2024/1689) Art. 5(1)(a)–(b) prohibits AI systems that use manipulative or deceptive techniques,
  or exploit vulnerabilities due to age, disability or a specific social or economic situation, to
  materially distort behavior in a way that causes significant harm. These prohibitions apply from
  2 Feb 2025 [L]. BRAKE's interventions are meant to benefit the user, but they must stay
  **transparent** (no subliminal tricks), and BRAKE should document why each one is not
  "materially distorting".
- **US:** FTC Act §5 enforcement against dark patterns [L]. Under California's CPRA, agreement
  obtained through dark patterns does not count as consent [L].
- **Apple:** Guideline 3.1.2(a) removes apps that trick users into subscriptions [V], which matters
  for BRAKE's own monetization.
- **Implication.** BRAKE's own subscription and paywall, cancellation flow, source-disconnect flow
  and data-deletion flow must be **frictionless**. Friction is acceptable only where the user asked
  for it, to protect a goal they set. That asymmetry is BRAKE's ethical line, and it should be
  written into product policy.

### E8. Regret and satisfaction measurement

| Finding | Status | BRAKE implication |
|---|---|---|
| **Time course of regret** (Gilovich & Medvec 1995, Psych. Review 102(2)). Regrets of *action* dominate in the short term, and regrets of *inaction* in the long term. | [L] | A prompt 24–72 h after purchase mainly captures action regret ("I shouldn't have bought it"). That is the signal BRAKE needs for impulse interventions, but it is not the whole of wellbeing. |
| **Material vs experiential** (Van Boven & Gilovich 2003, JPSP 85(6); Rosenzweig & Gilovich 2012, JPSP 102(2)). Experiences bring more lasting happiness. Material purchases produce more *buyer's remorse*, and experiences more *missed-opportunity* regret. **Rosy view** (Mitchell et al. 1997, JESP 33(4)): experiences are remembered more positively than they were rated at the time. Nicolao, Irwin & Goodman (2009) JCR 36(2): the experiential advantage holds for positive outcomes. | [L] | **Delay must depend on purchase type**, and ratings of experiences drift upward over time. Ask about experiences early (next day). Ask about goods after delivery and some use. Record `delay_hours` with every label so models can correct for it. |
| **Hyperopia** (Kivetz & Keinan 2006, JCR 33(2); Keinan & Kivetz 2008, JMR 45(6)). Looking back over long horizons, people increasingly regret *not* indulging. | [L] | BRAKE must not optimize only to minimize short-term regret. Learn **worth-it** patterns and occasionally affirm them ("Dinners with friends are almost always 'worth it' for you"). |
| **Regret regulation** (Zeelenberg & Pieters 2007, JCP 17(1); Tsiros & Mittal 2000, JCR 26(4); Inman & Zeelenberg 2002, JCR 29(1)). Regret motivates corrective action (returns, switching) and is lower when a decision feels justifiable. | [L] | Pair a regret answer with a **remedy** where one exists (return window, cancel subscription, set a rule). Regret with no remedy is just guilt. |
| **Experience sampling and the Day Reconstruction Method** (Csikszentmihalyi & Larson 1987; Shiffman, Stone & Hufford 2008, Annu. Rev. Clin. Psych. 4; Kahneman et al. 2004, Science 306). In-the-moment and reconstructed ratings differ, and the *remembering* self drives future choices. | [L] | For personalizing *future* decisions, the retrospective (remembering-self) rating is the right target. That supports the brief's delayed prompt. |
| **Compliance in experience-sampling research.** Meta-analyses report average compliance of roughly 75–80% in research studies (e.g. Wrzus & Neubauer 2023, Assessment 30(3); Vachon et al. 2019, JMIR 21(12), **figures unverified**). Compliance falls as studies go on (Rintala et al. 2019, Psych. Assessment 31(2)). Longer questionnaires raise burden more than higher frequency does (Eisele et al. 2022, Assessment 29(2), **unverified**). These participants were **paid and consented to research**. | [L] | Expect consumer response rates far below research levels and declining over time. Keep each prompt to **one tap**, and accept that most will go unanswered. |
| **Mood at the time of asking** (Schwarz & Clore 1983, JPSP 45(3), mood-as-information). Current mood colors evaluative judgments. | [L] | Don't ask at night, after another negative message, or in the same notification as a budget overrun. Record the context of the ask. |
| **Spending–personality fit** (Matz, Gladstone & Stillwell 2016, Psych Science 27(5)): spending that fits one's personality predicted higher life satisfaction in bank-transaction data. **Gladstone, Matz & Lemaire 2019, Psych Science 30(7):** personality traits can be inferred from transactions. | [L] | (1) Satisfaction really is personal, which justifies personalization. (2) Transaction data reveals traits, so learned regret and satisfaction profiles are **highly sensitive** derived data. Keep them on-device or encrypted, and never use them for marketing. |
| **Self-tracking cost** (Etkin 2016, JCR 42(6), "The hidden cost of personal quantification"). Measuring an enjoyable activity made people do more of it but enjoy it less, and reduced continued engagement. | [L] | The core argument for **not** creating an obsessive regret loop. Rating every purchase turns spending into homework and can drain the enjoyment from purchases that were fine. |

**Is regret feedback known to improve personalization?** I found no peer-reviewed study of
retrospective purchase-satisfaction prompts *improving* a personal-finance recommender (as of my
knowledge, **unverified**). The mechanism is plausible: per-user heterogeneity in satisfaction is
well documented, and implicit signals such as returns and cancellations are sparse. BRAKE should
treat this as a **product hypothesis to test**: does adding regret labels improve (a) prediction of
held-out regret labels and (b) user-rated helpfulness of interventions, compared with a model built
only from categories and implicit signals?

### E9. Labeling burden and active learning

- **No public evidence answers the specific question of how many transaction labels users will give
  before churning.** I could not verify any dataset on personal-finance-app labeling tolerance; this
  is an open question. The closest analog evidence:
  - Kaye et al. 2014 (CHI, "Money talks"): people track finances in idiosyncratic, often lapsed ways.
  - Epstein et al. 2015 (UbiComp, lived informatics) and 2016 (CHI, "Beyond abandonment"): lapsing
    and abandonment are normal phases of self-tracking.
  - Cordeiro et al. 2015 (CHI): food journaling: logging burden and negative nudges drive
    abandonment.
  - Choe et al. 2017 (IEEE Pervasive Computing): recommends **semi-automated** tracking (automate
    capture, ask humans only for what machines can't infer).
  - Response rates in experience-sampling research decline over time even for paid participants
    (E8). [all L]
- **Active learning.** Settles 2009 (UW–Madison TR 1648) surveys the field: uncertainty sampling
  (Lewis & Gale 1994), query-by-committee, expected error reduction (Roy & McCallum 2001), and
  **cost-sensitive** active learning, where annotation cost varies by query. **Kapoor & Horvitz
  2008** (CHI, "Experience sampling for building predictive user models") compared policies for when
  to ask users. Decision-theoretic, value-of-information policies built good models with fewer
  interruptions than random or fixed-schedule asking [L]. Horvitz 1999 (CHI, mixed-initiative
  principles): act, ask or do nothing depending on expected utility under uncertainty, and account
  for the cost of interrupting [L].
- **Humans are not oracles.** Amershi, Cakmak, Knox & Kulesza (2014, AI Magazine 35(4)): people
  dislike being peppered with questions, give noisy labels and want to give richer feedback than
  "label this" [L]. Cakmak, Chao & Thomaz (2010, IEEE TAMD): constant questioning by a learner was
  perceived as annoying, and mixed-initiative questioning was preferred [L]. Kulesza et al. 2015 (IUI,
  explanatory debugging): letting users correct the *reason* ("always treat Swiggy as Eating out")
  generalizes faster than labeling instances [L].
- **Guidelines for human–AI interaction** (Amershi et al. 2019, CHI; 18 guidelines) [L]. Those most
  relevant to BRAKE: G1 "Make clear what the system can do", G2 "Make clear how well the system can
  do what it can do", G3 "Time services based on context", G9 "Support efficient correction",
  G11 "Make clear why the system did what it did", G13 "Learn from user behavior", G14 "Update and
  adapt cautiously", G17 "Provide global controls".
- **Selection bias.** Users choose which items to rate, so ratings are missing *not at random*
  (Marlin & Zemel 2009, RecSys) [L]. Inverse-propensity weighting fixes the bias when the system
  controls who is asked and logs the probability (Schnabel et al. 2016, ICML, "Recommendations as
  treatments"; Joachims, Swaminathan & Schnabel 2017, WSDM) [L]. → **BRAKE must log the probability
  that each prompt was shown.**

### E10. Communicating uncertainty

- **Verbal probability words are vague and vary by person and context** (Kent 1964, "Words of
  estimative probability"; Wallsten et al. 1986, JEP: General 115(4); Mosteller & Youtz 1990,
  Statistical Science 5(1)) [L].
- **IPCC calibrated language** (AR5 guidance note, Mastrandrea et al. 2010): *virtually certain*
  99–100%, *very likely* 90–100%, *likely* 66–100%, *about as likely as not* 33–66%, *unlikely*
  0–33%, *very unlikely* 0–10% [L]. Lay readers still read these terms *regressively* (toward 50%).
  Pairing the words with numeric ranges improves understanding (Budescu, Broomell & Por 2009, Psych
  Science 20(3)), and the effect holds across languages (Budescu et al. 2014, Nature Climate Change
  4) [L].
- **Directionality.** "Some chance" and "not certain" can describe the same probability but push
  decisions in opposite directions (Teigen & Brun 1999, OBHDP 80(2)) [L]. BRAKE's medium-confidence
  phrase "Looks like…" is positive-directional, which is right for transaction facts.
- **Trust.** van der Bles et al. (2020, PNAS 117(14)): numeric uncertainty (a range) slightly
  lowered trust in the *number* but not in the *source*, while vague verbal uncertainty did more
  damage [L]. Showing confidence information can help users calibrate when to rely on AI, although
  explanations did not always do so (Zhang, Liao & Bellamy 2020, FAT*; Yin, Wortman Vaughan &
  Wallach 2019, CHI) [L].
- **Natural frequencies** (Gigerenzer & Hoffrage 1995, Psych. Review 102(4)): "4 out of 6" is
  understood far better than "67%", and it shows the sample size, i.e. the uncertainty, without
  extra words [L]. Kay et al. (2016, CHI, "When (ish) is my bus?"): frequency-framed displays work
  in everyday mobile apps [L].
- **OS-level summarization risk.** iOS ranks notifications in summaries by `relevanceScore` [V], and
  AI-generated notification summaries on current OSes may paraphrase app text (**unverified**
  detail). Hedges can get lost. Put the hedge *in the title* ("Was this ₹850 at Starbucks?") rather
  than in a trailing clause.

---

## Sources investigated

Here "sources" means the **behavioral signals and intervention/feedback mechanisms** BRAKE would
build. Financial data sources (Plaid, Account Aggregator, SMS, Gmail) are covered by other streams;
this stream gives their *behavioral* role in the window table. Each mechanism below emits
observations (`Observation`) or user assertions (`UserAssertion` in
`packages/core/src/model/assertion.ts`), or consumes candidates (`TransactionCandidate`).

### 1. `manual-purchase-check`: "Should I buy this?"

- **What it is.** The user types or shares a prospective purchase (price, item, URL, photo of a
  price tag). BRAKE answers with context (budget pace, goal impact, the user's own history with
  similar purchases) and offers *Buy*, *Hold 24 h* or *Skip*.
- **Data available.** `intent.via = "should_i_buy"`; `intent.title`, `intent.url`, `amount`
  (user-entered; ±15% if parsed from a page), `merchant.raw` (optional), category hint (keyword),
  plus `planned?` (one optional tap). It also yields the **user's own decision**: buy, hold or skip.
- **Windows.** PRE-SPEND (primary), IN-SPEND (when used at the shelf or checkout). Latency is
  immediate because the user drives it.
- **Coverage.** All countries and platforms (iOS, Android, web). It works for "User C" with no
  connected financial source.
- **Access.** None. Share-sheet and App Intents integration on iOS, `ACTION_SEND` on Android.
- **Privacy and consent.** The lowest of any mechanism: the user deliberately sends the data.
  Store the minimum: amount, category, decision and timestamps. Keep URLs for 30 days [D] to link
  to an order.
- **Reliability and failure modes.** Selection effects: users check purchases they already doubt,
  so labels from this surface are **not** representative. Mark them `surface = manual_check` and
  exclude them from IPW regret estimates, or weight them separately.
- **Dedup/reconciliation keys.** `purchase_intent` founds an intent-stage candidate. Later
  observations join it forward-only within `intentHorizonMs` (24 h) and ±15% amount, as the fusion
  spec defines. Also `intent.url` and `productId`. The user's decision becomes `IntentOutcome`.
- **Normalized observation.** `kind: "purchase_intent"`, `window: "pre_spend"`,
  `stage: "intent"`, `confidence` ≈ 0.9 that the user is considering it (the amount is
  user-entered); `typeHints: purchase`.
- **Behavioral value.** High. This is a **self-nudge**: the user asks, so there is little
  reactance. Opportunity-cost framing (E4) fits here. Purchases that went through a check give the
  model **"planned"** evidence.
- **Provenance sentence.** "You asked BRAKE about this on Tue 14:05."
- **Recommendation: `mvp`.** It is the only pre-spend mechanism that works everywhere, and the
  evidence for self-chosen reflection supports it.

### 2. `cooling-off-hold`: wishlist plus timed reminder

- **What it is.** The user parks an item for a chosen time (1 h / **24 h default** / 72 h / 7 d).
  At the end, BRAKE asks "Still want it?" with [Buy] [Extend] [Drop]. Holds can be ad hoc, or
  created automatically by a **user-authored rule** (e.g. "electronics over ₹5,000 → 24 h hold").
- **Data available.** `hold_id`, `created_at`, `duration`, `item/amount/category`, `origin`
  (ad_hoc | rule:<id>), `outcome` (bought | dropped | extended | expired), `outcome_at`.
- **Windows.** PRE-SPEND; IN-SPEND when it is triggered from a checkout surface. Latency: the hold
  duration.
- **Coverage.** Global, all platforms. On iOS, a reminder that the *user requested* is a legitimate
  use of `timeSensitive` [V]. Otherwise use `active`.
- **Access.** None. Reminders are scheduled as local notifications.
- **Privacy.** Low. Expire dropped holds after 30 days [D].
- **Reliability.** BRAKE cannot stop the user buying elsewhere during a hold. That is fine: the aim
  is reflection, not enforcement. Abandoned holds (no answer at expiry) are a **weak positive**
  signal that the item wasn't wanted.
- **Dedup keys.** `hold_id` links to the `purchase_intent` observation. Any later `money_movement`
  or `order` matching the item (amount ±15%, merchant/URL) closes the hold as *bought*.
- **Normalized output.** It updates the `purchase_intent` candidate's `intentOutcome`. It is not a
  new observation kind.
- **Behavioral value.** High and well grounded: hot–cold gap, asymmetric paternalism, and the
  wishlist-and-cart behavior consumers already show (Close & Kukar-Kinney 2010, J. Business
  Research, carts used as wishlists) [L].
- **Provenance sentence.** "You put this on hold yesterday at 23:40, using your 'late-night
  electronics' rule."
- **Recommendation: `mvp`.**

### 3. `app-launch-friction`: pause before user-selected shopping apps

- **What it is.** A one-sec-style pause when the user opens a shopping, food-delivery or social
  shopping app they **chose** to shield. It shows their goal or recent pace for a few seconds, then
  offers [Continue] and [Not now].
- **Platform mechanisms.**
  - iOS: `FamilyControls` with **individual** authorization. The doc says this "requires approval
    from the owner of the device" (biometric) and that "you must request permission to use the
    entitlement" (`com.apple.developer.family-controls`) before App Store submission [V].
    `ManagedSettings.ShieldSettings` covers `applications`, `applicationCategories` and
    `webDomains` [V]. `ShieldActionDelegate` handles button presses. The system gives the extension
    an **opaque token** rather than the app's name [V], and `ShieldActionResponse` can be `.close`,
    `.defer` or `.none` [V]. `DeviceActivity` schedules shields, e.g. only 23:00–05:00 [V].
  - Android: no equivalent first-party API. The options are `UsageStatsManager` polling (special
    permission, not real-time) or an AccessibilityService, which Google Play restricts. See the
    device-signals stream; the policy status was **not verified here**.
- **Data available.** `shield_event {token or package, local_time, action: continue|close}`. On
  iOS, the app identity is a token. BRAKE knows only what the user labelled it.
- **Windows.** PRE-SPEND. Latency: real time at app open.
- **Coverage.** iOS 16+ for individual authorization **(version unverified)**. Android is limited
  and research-grade. Works in all countries.
- **Access.** Apple entitlement approval (a gating risk for timing). Google Play policy review on
  Android.
- **Privacy.** Medium. App-usage events are sensitive, but iOS tokens are privacy-preserving. Store
  counts per day, not timelines [D].
- **Reliability and failure modes.** Habituation: the proceed-through rate climbs toward 100%
  (Anderson et al. 2016). Users switch to the mobile web (cover `webDomains`). The pause can annoy
  if it triggers on non-shopping use of the same app.
- **Dedup keys.** None. Context only. `app_context` observations never found candidates (fusion
  spec).
- **Normalized observation.** `kind: "app_context"`, `window: "pre_spend"`, `stage: "intent"`,
  confidence 1.0 that the app opened and ≈0.2–0.4 that it was a purchase occasion [D].
- **Behavioral value.** The one sec evidence is directly relevant (E1). It is the strongest
  evidence-backed pre-spend friction BRAKE can deploy, and it is **only legitimate as opt-in**.
- **Provenance sentence.** "You asked BRAKE to pause Myntra after 11 pm."
- **Recommendation: `next`.** Apply for the iOS entitlement early. On Android it is `research`
  until the policy review is done.

### 4. `user-goals-and-rules`: goals, if–then plans and soft commitments

- **What it is.** User-authored goals ("Goa trip ₹40,000 by Dec") and rules of the form *if
  [context] then [BRAKE action]*: pause, hold, notify, or "don't bother me about X". It also covers
  "tighten now, loosen later": relaxing a rule takes effect after 24 h [D] and the user is told so
  up front.
- **Data available.** `goal {name, target, deadline, linked_categories}`,
  `rule {id, condition(category|merchant|amount|hour|rail|app_token), action, strength, created_at,
  loosen_delay}`, rule firing log.
- **Windows.** Feeds all three windows as tailoring variables and intervention options.
- **Coverage.** Global, all platforms.
- **Access.** None.
- **Privacy.** Low to medium, because goals can be intimate (e.g. "debt payoff"). Keep them local.
- **Reliability.** Rules are only as good as BRAKE's sensing. A rule on a context BRAKE cannot sense
  for this user (e.g. a merchant rule without a transaction source) must be shown as **inactive**,
  driven by the capability registry.
- **Dedup keys.** `rule_id`, `goal_id`. They attach to `InterventionEvent` records.
- **Normalized output.** `kind: "user_rule"` source (already in `SignalSourceKind`). Rules are
  configuration, not observations.
- **Behavioral value.** Highest. Implementation intentions (d≈0.65), commitment devices, goal
  salience and the fresh-start effect all converge here, and user-authored triggers minimize
  reactance (E4, E5).
- **Provenance sentence.** "You set this rule on 3 Sep: hold electronics over ₹5,000 for a day."
- **Recommendation: `mvp`.**

### 5. `time-of-day-context`

- **What it is.** Local time, day of week and a late-night flag, computed on-device.
- **Data available.** `local_hour`, `weekday`, `is_late_night` (23:00–04:59 local [D]), user time
  zone. Derived from `occurredAt` or the event time.
- **Windows.** PRE-SPEND and IN-SPEND (as a tailoring variable), POST-SPEND (as a regret-model
  feature). Latency: none.
- **Coverage.** Global.
- **Access and privacy.** None, low. Note that bank `occurredAt` is often **date-only**, so hour
  features are only valid when the timestamp comes from a real-time source (notification, SMS,
  intent). Carry `occurredAt.confidence`.
- **Reliability.** Weak causal evidence for a *universal* late-night effect (E3). Its value is as a
  per-user feature.
- **Normalized output.** A feature, not an observation.
- **Provenance sentence.** "Based on when you usually shop."
- **Recommendation: `mvp`.** It is cheap and local. Use it as a **feature**, never as a universal
  trigger.

### 6. `payday-proximity`

- **What it is.** Days since and until detected income. Detection uses recurring credits marked
  `income`, or the user's stated payday.
- **Data available.** `days_since_income`, `days_to_income`, `income_regularity`.
- **Windows.** PRE-SPEND (more spending right after payday) and POST-SPEND (pace normalization).
  Latency: daily.
- **Coverage.** Depends on a financial source with credits, or on a manual payday entry, which is
  global.
- **Privacy.** Medium: income is sensitive. Derive it on-device and store the date pattern, not
  amounts [D].
- **Reliability.** Irregular income (gig, freelance) breaks it. Fall back to "start of month".
- **Behavioral value.** Strong evidence for payday spending spikes (E3) and for fresh starts (E4).
- **Provenance sentence.** "You told BRAKE you're paid on the 1st" / "Based on your salary credit
  on the 1st."
- **Recommendation: `next`.** Manual payday entry can ship in the MVP.

### 7. `spending-velocity-baseline`: the user's own pace

- **What it is.** Rolling per-category spending pace against the user's **own** trailing baseline,
  e.g. a robust median of the last 8 comparable weeks, aligned by weekday.
- **Data available.** `category`, `period_to_date`, `baseline_median`, `baseline_mad`,
  `pct_vs_usual`, `n_weeks_history`.
- **Windows.** POST-SPEND (immediate insight) and PRE-SPEND (context in checks and pauses).
  Latency: as fast as the fastest connected transaction source.
- **Coverage.** Needs ≥4 weeks of data in the category [D] before any "% above usual" claim.
- **Privacy.** Low. Derived and local.
- **Reliability and failure modes.** Miscategorization, transfers counted as spending, and partial
  source coverage. If BRAKE sees only one card, "your food spending" is wrong. **The scope must be
  stated**: "on cards BRAKE can see". Suppress pace claims when coverage is partial and unknown.
- **Normalized output.** Insight object `{metric, value, baseline, n, coverage_note}`.
- **Behavioral value.** It is the core of non-scolding post-spend messaging: self-referenced, with
  no peer comparison (E5), and restoring payment "rehearsal" (E2).
- **Provenance sentence.** "Compared with your last 8 weeks of food spending on your HDFC card."
- **Recommendation: `mvp`.**

### 8. `notification-quick-action-labeling`: one-tap labels

- **What it is.** A notification about a likely transaction with 2–3 predicted label buttons.
- **Platform limits.** Android allows "up to three action buttons" [V], and text input through
  direct reply (`RemoteInput`, Android 7.0+) [V]. iOS `UNNotificationCategory` shows "up to 10
  actions" when space is unlimited and "at most two" when space is limited [V]. The HIG says the
  detail view can hold "up to four buttons" [V]. `UNTextInputNotificationAction` takes typed text
  [V]. The `customDismissAction` option sends dismissals to the delegate [V], which lets BRAKE learn
  "ignored" vs "dismissed".
- **Data available.** `question_id`, `candidate anchors`, `attribute_asked` (category | type |
  essentiality | ownership), `options_shown[]` with model probabilities, `answer | dismissed |
  expired`, `latency_to_answer`, `surface`, `propensity`, `policy_version`.
- **Windows.** POST-SPEND. Latency: seconds to minutes after the candidate reaches `confirmed`.
- **Coverage.** Global. Android 13+ needs `POST_NOTIFICATIONS`, which is off by default [V].
- **Access.** Notification permission only.
- **Privacy.** Medium: amount and merchant on the lock screen. Use Android `VISIBILITY_PRIVATE`
  with a `setPublicVersion` like "1 purchase to confirm" [V], and on iOS keep amounts out of the
  title when previews are shown on the lock screen. Generate locally where possible.
- **Reliability.** Answers are noisy, because users tap the first plausible button. Answer quality
  falls with the number of options and with fatigue. Expect low response rates. **(No verified
  benchmark; measure.)**
- **Dedup keys.** The answer is a `LabelAssertion` anchored to observation ids, so it survives
  re-fusion (as the model already provides). `question_id` prevents double-asking.
- **Normalized output.** `LabelAssertion {field, value}` with confidence ≈0.9 [D], reduced if
  answered in under 1 s or against a strong prior.
- **Behavioral value.** Necessary for transfer-vs-spend correctness and for categories. Asking also
  has a small **question–behavior effect** (E5).
- **Provenance sentence.** "You labeled this as 'Gift' on 12 Sep."
- **Recommendation: `mvp`**, under the EVOI policy and question budget (§Implications 4.3).

### 9. `weekly-review-session`: batched, opt-in review

- **What it is.** A once-a-week, ≤2-minute in-app review on a day the user picks (default Sunday
  evening or Monday morning, a fresh-start landmark [D]). It shows ≤5 items ranked by EVOI, plus
  one optional reflection ("Anything from this week you're especially glad you bought?").
- **Data available.** Same as #8 plus `session_id`, `items_offered`, `items_answered`.
- **Windows.** POST-SPEND. Latency: up to 7 days.
- **Coverage.** Global. It is the main labeling channel on platforms or for users without
  notifications.
- **Privacy.** Low, because it happens in-app.
- **Reliability.** Recall degrades with delay, so prefer *recognition* questions (choose from
  options) over recall. Batching is supported by the notification-batching evidence (Fitz et al.,
  E6).
- **Behavioral value.** It turns many interruptions into one, and it is a natural place for
  "worth it" affirmations (hyperopia, E8).
- **Provenance sentence.** "From your weekly review on 28 Sep."
- **Recommendation: `mvp`.**

### 10. `retrospective-regret-prompt`

- **What it is.** "That ₹6,200 purchase from Saturday: glad you bought it?" with [Glad I did]
  [It's fine] [Wish I hadn't]. The prompt is sparse, delayed and sampled.
- **Data available.** `SatisfactionAssertion {value: worth_it|neutral|regretted, askedAt}`. Add
  these fields [D]: `propensity`, `delay_hours`, `delay_bucket`, `selection_reason`
  (random|uncertainty|user_requested), `ask_context` (local hour, weekday), `prompt_variant`,
  `remedy_offered`.
- **Windows.** POST-SPEND, delayed 18 h to 14 d depending on type (§Implications 4.4).
- **Coverage.** Global. Needs at least one source that produces confirmed candidates, or manual
  entries.
- **Privacy.** **High.** Regret profiles are sensitive inferred data (E8: transactions reveal
  personality). Keep them local, encrypted and excluded from analytics by default. Never ask about
  sensitive categories: health, pharmacy, religion and donations, adult content, legal fees, or
  anything the user marked private.
- **Reliability and failure modes.** Selection bias if not randomized. Mood at asking time. Rosy
  view for experiences. Dissonance reduction, where people justify past choices. Social
  desirability. Shared or gift purchases. **Purchase not actually the user's** (low candidate
  confidence → do not ask).
- **Dedup keys.** Anchored to candidate observation ids. One regret question per
  `deduplicationGroup`, ever.
- **Normalized output.** `SatisfactionAssertion`. It is a label for the per-user regret model, used
  with IPW weight `1/propensity`.
- **Behavioral value.** This is the key personalization signal for *which* interventions to offer.
  Measurement burden and obsession risks have to be actively managed (E8, Risks).
- **Provenance sentence.** "You told BRAKE you were glad about 5 of your last 6 restaurant
  outings."
- **Recommendation: `mvp`** at ≤1 per week, with stop rules. Expanding the frequency is
  `research`.

### 11. `implicit-outcome-signals`: returns, refunds, cancellations and abandoned holds

- **What it is.** Revealed-preference outcomes:
  - a refund or return linked to a purchase (a strong regret proxy, but also fit or defect returns);
  - subscription cancelled within its first cycle or after a trial;
  - BNPL purchase followed by a refund;
  - a hold that expired or was dropped;
  - "Skip" in a manual check;
  - a duplicate purchase later refunded.
- **Data available.** `refund_notice` and credit `money_movement` linked to the original candidate
  (the reconciliation layer's "refund of" link), `subscription_event: cancelled`, `IntentOutcome`.
- **Windows.** POST-SPEND. Latency from days to weeks (refunds can take up to 10 days to match,
  per the fusion spec).
- **Coverage.** Depends on email, bank or AA sources (other streams).
- **Privacy.** Low incremental cost; it is derived from data already held.
- **Reliability.** Ambiguous: returns can mean wrong size, not regret. Treat as a *soft* label
  (e.g. P(regret | return) ≈ 0.5 [D], learned per user by occasionally asking "Returned because…?
  [Didn't need it] [Wrong fit/defective]").
- **Dedup keys.** Order id, refund-to-purchase reconciliation links.
- **Behavioral value.** Labels at zero burden. Also **actionable**: a regret answer plus a known
  return window becomes a remedy ("Amazon's return window for this order is open until 14 Oct",
  from the order email).
- **Provenance sentence.** "You returned this order on 20 Sep (from Amazon's refund email)."
- **Recommendation: `next`.** It needs the email and refund reconciliation adapters.

### 12. `intervention-response-telemetry`

- **What it is.** A log of every intervention decision, including **"no intervention"** at each
  eligible decision point, and the user's response.
- **Data available.** `InterventionEvent {id, decision_point_id, candidate/intent anchors, level
  (L0–L4), variant, propensity, rule_id?, model_p_regret, model_uncertainty, shown_at, response
  (continue|hold|skip|dismiss|stop_this|ignored), response_latency_ms, downstream_outcome
  (bought_within_24h|no_purchase), later_satisfaction?}`.
- **Windows.** PRE-SPEND and IN-SPEND (the events), POST-SPEND (outcomes). Latency: real time.
- **Coverage.** Global.
- **Privacy.** Medium. Keep the raw log local, and send only aggregated, privacy-protected metrics
  if the user opts in [D].
- **Reliability.** The "downstream outcome" needs a purchase-sensing source. Without one it is
  unknown, not "no purchase".
- **Behavioral value.** Essential for the micro-randomized evaluation (E6), for habituation
  detection, and for the user's own "what has BRAKE done for me" view.
- **Provenance sentence.** "BRAKE paused Myntra 3 times this week. You continued twice."
- **Recommendation: `mvp`.**

### 13. `notification-engagement-telemetry`

- **What it is.** Delivery and engagement state used to detect fatigue.
- **Data available.** Open, action, dismiss (iOS `customDismissAction` [V]; Android delete intent),
  expire. Per-channel enabled state. On Android, channel importance is user-controlled after
  creation [V], so BRAKE reads it (`NotificationManager`) to detect a muted channel (API names from
  the Android reference, not re-fetched). On iOS, authorization status from
  `getNotificationSettings`.
- **Windows.** Meta, across all windows.
- **Coverage.** Global.
- **Privacy.** Low.
- **Reliability.** iOS reports a dismissal only when the user explicitly dismisses. Clearing
  notifications in bulk may not be reported.
- **Behavioral value.** Feeds the **fatigue term** in the asking cost and the adaptive budget.
  Muting a channel is a strong negative signal: BRAKE should stop pushing that type and offer it in
  the digest instead.
- **Recommendation: `mvp`.**

### 14. `mood-self-report` (optional) and `passive-emotion-inference` (avoid)

- **What it is.** (a) An optional tag on a purchase or check: "Why now?" [Planned] [Treat]
  [Bored] [Stressed] [Social]. (b) Inferring emotion from typing, voice, camera, app usage or
  messages.
- **Windows.** PRE-SPEND (a only, inside a manual check) and POST-SPEND (a, as an optional
  extension of the regret prompt).
- **Privacy.** (a) High, but volunteered; keep it local. (b) **Very high**: it is surveillance, and
  emotion recognition is a sensitive area under the EU AI Act (Art. 5 bans it in workplaces and
  education; Annex III lists it as high-risk [L]).
- **Behavioral value.** Mood effects are real (E3), but some mood-driven spending is functional.
  Self-labeling ("Stressed") may in itself help self-regulation **(unverified; research)**.
- **Recommendation.** `mood-self-report`: **`research`**, an optional tag behind a setting.
  `passive-emotion-inference`: **`avoid`**.

### 15. `app-usage-context`: what the user was doing before buying

- **What it is.** Recording, for example, "scrolled Instagram 25 min, then opened Myntra" via usage
  stats or accessibility.
- **Privacy.** **Very high**: a cross-app activity timeline. iOS does not expose this to third
  parties outside the opaque-token `DeviceActivity` model [V]. On Android it requires a special
  permission and is policy-sensitive (not verified here).
- **Behavioral value.** Plausible (Wilcox & Stephen), but the same benefit is available through
  user-selected shielding (#3) without building a surveillance timeline.
- **Recommendation: `avoid`.** At most, `DeviceActivity` thresholds on apps the user selected, with
  counts kept on-device.

### 16. `dark-pattern-cue-detection`: counter-messaging at checkout

- **What it is.** A browser extension detects urgency and scarcity elements on checkout pages
  (countdown timers, "only 2 left", "X people viewing"), in the spirit of Mathur et al.'s crawler.
  It annotates them neutrally ("Timers like this often reset; there's no need to rush").
- **Data available.** `cue_type`, `page_domain`, `cart_total` (if the extension reads the
  checkout), `timer_resets_observed`.
- **Windows.** IN-SPEND. Latency: real time.
- **Coverage.** Desktop browsers and some mobile browsers (Safari Web Extensions). Low reach on
  mobile-first markets.
- **Access.** Extension-store review. Host permissions on shopping domains are a heavy permission
  ask.
- **Privacy.** High, because the extension sees browsing. Restrict it to a merchant allowlist and
  process on-device.
- **Reliability.** Detection heuristics are brittle. A false "fake urgency" claim about a merchant
  is a **legal and defamation risk**. Phrase it generically and never say "this site is lying".
- **Behavioral value.** Plausible. Debiasing urgency restores the time a cooling-off needs.
- **Recommendation: `later`.** It depends on the browser-extension adapter (another stream).

### 17. `bnpl-usage-signal`

- **What it is.** Detection that a purchase used BNPL: `rail.family = "bnpl"` from the instrument,
  an order email ("Pay in 4"), or a checkout page. Also covers upcoming instalments.
- **Data available.** `rail.family`, `instalment_count`, `next_due`, `instalment_amount` (from
  provider emails or apps, other streams).
- **Windows.** IN-SPEND (via the extension: "This splits into 4 × ₹1,250; first one today") and
  POST-SPEND (instalment calendar, total outstanding BNPL across providers).
- **Coverage.** Strong BNPL markets: US, UK, AU, DE, Nordics, plus India's EMI and pay-later
  products. Regulatory regimes are changing in 2026 (UK, EU; **unverified**).
- **Privacy.** Medium.
- **Behavioral value.** BNPL decouples payment from consumption (E2) and was linked to higher
  spending (E3). The aggregated "BNPL due next 30 days" view is a high-value, non-judgmental
  insight.
- **Dedup keys.** BNPL provider order id and merchant order id. The **instalment debits** must link
  to the original purchase so they are not counted as new spending (reconciliation layer).
- **Provenance sentence.** "From Klarna's payment schedule email."
- **Recommendation: `next`.**

### 18. `spending-style-self-assessment`

- **What it is.** An optional onboarding item using the short Spendthrift–Tightwad scale (Rick et
  al. 2008) [L], or one plain question: "Which bothers you more: spending on things you later don't
  value, or holding back on things you would have enjoyed?"
- **Windows.** A prior for all windows.
- **Privacy.** Low to medium; keep it local.
- **Behavioral value.** It sets the **direction** of personalization (E2): add friction for
  spendthrift-leaning users, and offer permission and reassurance ("worth it" patterns) for
  tightwad-leaning users. This prevents BRAKE from harming users who already under-spend.
- **Recommendation: `next`** (MVP: the single plain question).

### 19. `financial-wellbeing-scale`: outcome measure

- **What it is.** The CFPB Financial Well-Being Scale (10-item, with an abbreviated 5-item
  version) [L; the CFPB site was not reachable this session], given at onboarding and then
  quarterly, as an optional "check-in".
- **Windows.** None (an evaluation instrument).
- **Behavioral value.** It anchors product evaluation to wellbeing, not engagement. Add a single
  autonomy item [D]: "BRAKE respects my choices about money" (1–5).
- **Recommendation: `next`.**

### 20. `location-geofence-context`

- **What it is.** "You're at the mall". Either continuous location or user-defined geofences.
- **Privacy.** **Very high** for continuous tracking. User-defined geofences processed on-device
  are lower, but still sensitive.
- **Behavioral value.** Speculative. Physical-store pre-spend moments are better served by
  QR, price-tag photo and manual check (#1).
- **Recommendation: `research`** (user-defined geofences only). Continuous location: `avoid`.

---

## Three-window classification

| Source / mechanism | Pre-spend | In-spend | Post-spend | Latency | Notes |
|---|---|---|---|---|---|
| `manual-purchase-check` | ●● primary | ● at shelf/checkout | ○ links to the outcome | Immediate | User-initiated self-nudge. Works with zero connected sources |
| `cooling-off-hold` | ●● | ● from a checkout surface | ○ outcome | Hold length (default 24 h) | Strong friction, **only** user-chosen |
| `app-launch-friction` | ●● | — | — | Real time | iOS FamilyControls entitlement. Android is research-only |
| `user-goals-and-rules` | ●● | ●● | ● | n/a (config) | Source of all strong interventions |
| `time-of-day-context` | ● | ● | ● (regret feature) | None | Bank timestamps are often date-only |
| `payday-proximity` | ● | ○ | ● | Daily | Fresh-start landmark |
| `spending-velocity-baseline` | ● (context in checks) | ● (context in pauses) | ●● | As fast as the fastest txn source | Needs ≥4 weeks. State coverage |
| `notification-quick-action-labeling` | — | — | ●● | Seconds–minutes | Android ≤3 buttons; iOS ≤2 when space is limited |
| `weekly-review-session` | — | — | ●● | ≤7 days | Batched, ≤5 items |
| `retrospective-regret-prompt` | — | — | ●● | 18 h–14 d by type | ≤1/week, randomized, propensity logged |
| `implicit-outcome-signals` | — | — | ●● | Days–weeks | Returns are ambiguous labels |
| `intervention-response-telemetry` | ● | ● | ● (outcomes) | Real time | Logs "no intervention" too |
| `notification-engagement-telemetry` | meta | meta | meta | Real time | Fatigue detector |
| `mood-self-report` | ○ (in a check) | — | ○ | Immediate | Research; opt-in |
| `passive-emotion-inference` | ✕ | ✕ | ✕ | — | Avoid |
| `app-usage-context` | ✕ | — | — | — | Avoid; use shielding |
| `dark-pattern-cue-detection` | — | ●● | — | Real time | Browser extension; later |
| `bnpl-usage-signal` | — | ● (extension) | ●● | Minutes–days | Link instalments to the purchase |
| `spending-style-self-assessment` | prior | prior | prior | Onboarding | Sets intervention *direction* |
| `financial-wellbeing-scale` | — | — | eval | Quarterly | Outcome metric |
| `location-geofence-context` | ○ | — | — | Real time | Research; user-defined only |

Key: ●● primary, ● useful, ○ marginal, — not applicable, ✕ do not use.

---

## Implications for BRAKE architecture

### 4.1 Intervention ladder and decision rule

**Ladder.** Levels are product-wide, and every surface maps onto them:

| Level | Name | Examples | Who can trigger | Blocking? |
|---|---|---|---|---|
| L0 | Silent | Update model and digest only | Anyone (default) | No |
| L1 | Ambient | Widget, in-app feed, weekly digest; iOS `passive`, Android `IMPORTANCE_LOW` | Model | No |
| L2 | Reflective nudge | One sentence of context plus a freedom statement, in-spend inside BRAKE surfaces or post-spend as an `active` notification | Model (budgeted) or rule | No |
| L3 | Pause | 3–10 s screen with goal or trade-off, then [Continue] [Hold] [Skip] | **Rule or user setting only** | Soft (seconds) |
| L4 | Hold | Save to wishlist and remind after N hours. Override needs one extra confirm | **User-authored rule only** | Soft (BRAKE never blocks payment rails) |

**Decision rule** (JITAI form [L], expected-utility form after Horvitz 1999 [L]). At each decision
point *d* (shield open, manual check, QR scan→intent, extension checkout, candidate
`confirmed`):

```
eligible_levels = levels permitted by (user intensity setting, rule match, surface, capability)
for k in eligible_levels:
    benefit_k = P_regret_lower(d) * stake(d) * responsiveness_k(user)        # conservative for k ≥ L3
              + info_value(d)                                                  # e.g. learning about this stratum
    cost_k    = c_interrupt[k] + c_autonomy[k] + fatigue(user, last_7d) + context_penalty(d)
choose argmax_k (benefit_k - cost_k), with L0 when all ≤ 0
randomize between the top choice and L0 with p_explore (default 0.2) and log the propensity
```

- `P_regret_lower` is the lower 80% credible bound of the per-user regret posterior for d's
  stratum for L2, and the 90% bound for L3 [D]. The brief says low-confidence inferences should
  rarely trigger strong friction, and the conservative bound implements that.
- `stake(d)` is the amount relative to the user's discretionary baseline (log-scaled) [D].
- `responsiveness_k` is learned from `intervention-response-telemetry`. If the user continues
  through ≥5 consecutive pauses for the same rule, `responsiveness` → ~0, and BRAKE **offers to
  edit the rule** instead of continuing (anti-wallpaper) [D].
- **Candidate confidence gates.** Never run L2+ on a *post-spend* candidate with `confidence <
  0.8`. Below that, the only allowed action is a *question* ("Was this ₹850 at Starbucks?"),
  consistent with the brief's confidence-aware UX.
- **Cold start.** In the first 4 weeks, or before 20 satisfaction labels [D], model-initiated
  actions are capped at L1/L2. L3/L4 come only from rules.

**Hard caps** [D]:

| Budget | Default | User range |
|---|---|---|
| Model-initiated pushes (insights + nudges) | ≤1/day, ≤3/week | Off to 2/day |
| Questions (labels) by push | ≤3/week in weeks 1–2, then ≤2/week; never >1/day | 0–5/week |
| Regret prompts | ≤1/week | 0–3/week ("help BRAKE learn faster") |
| Total non-user-requested prompts | ≤4/week (all types together) | — |
| Weekly digest | 1/week | Off, weekly, or monthly |
| User-requested reminders (holds) | Unlimited | — |
| Quiet hours (no pushes except user-requested reminders) | 22:00–08:00 local | User-set |
| Same-topic repeat | Never re-send an unanswered item (HIG [V]); it expires into the weekly review | — |

Shield pauses and manual checks are *pulled* by the user's own action, so they don't count against
push budgets. Habituation monitoring still applies.

### 4.2 Post-spend insight policy: "say something only if it changes understanding"

Send a post-spend message only if at least one **insight trigger** fires. Otherwise update silently
(L0/L1):

1. **Pace deviation.** Category period-to-date ≥ +25% vs the user's baseline, with ≥4 weeks of
   history, the transaction ≥ the 50th-percentile discretionary amount, and coverage known [D].
2. **Actionable window.** The return or cancellation window is open (from an order email), a
   subscription renews in ≤3 days, a free trial converts, there is a likely duplicate charge, or a
   refund is overdue.
3. **Goal impact.** The purchase moves a user goal's ETA by ≥1 week [D].
4. **Transfer clarification needed** (asked as a question, not an insight).
5. **User-requested alerts** (rule).

**Phrasing rules** (from E2, E4, E5 and E10):

| Do | Don't |
|---|---|
| Compare with the user's own baseline: "38% above your usual pace" | Compare with peers ("people like you spend…") |
| One fact, one number, one optional action | Several facts or a scolding preamble |
| Neutral verbs: "spent", "paid", "is at" | Moral words: "splurge", "wasted", "guilty", "bad", "oops", "again" |
| Explicit freedom: "Your call." / "Fine if planned." | Imperatives: "You should stop…", "Don't…" |
| Attach patterns to contexts: "late-night gadget buys" | Attach patterns to people: "you're impulsive" |
| Frequency format from the user's history: "4 of your last 6…" | Bare percentages from small samples: "67% regret rate" |
| Remedy when it exists: "still returnable until 14 Oct" | Regret without remedy |
| Silence when nothing is new | "You spent ₹500." (the brief's own counterexample) |
| Neutral colors for individual purchases | Red or alarm styling on individual purchases |

**Templates** (English; localize with native review, because calibration words do not translate
one-to-one [L]):

- *Pace:* "₹500 at Swiggy. Food delivery this week is ₹2,150, about 38% above your usual pace."
- *Actionable:* "This ₹3,400 Myntra order is still cancellable until it ships (from Myntra's order
  email). Want a reminder tomorrow morning?" Late-night purchases are surfaced the **next morning**,
  never at night [D].
- *Goal:* "Goa trip fund: this moves your target date by about a week. Fine if planned. Want to
  adjust the goal?"
- *Worth-it affirmation (hyperopia guard):* "Dinners out with friends: you've called 7 of your last
  8 'worth it'. Nothing to change here."
- *Pattern offer (post-hoc, ≤1/month):* "You marked 4 of your last 6 late-night electronics buys as
  'wish I hadn't'. Want BRAKE to hold late-night electronics for a day? [Set it up] [No thanks]".
  The decline button stays neutral (no confirm-shaming).

### 4.3 Question policy: EVOI with a weekly budget

For candidate *c* and attribute *a* (category | transaction_type | essentiality | ownership |
intent):

```
EVOI(c,a) = V_now(c,a) + V_future(c,a) − C_ask(u,t)

V_now    = Σ_y P(y) · [loss under current best interpretation − loss if y were known]
           # e.g. transfer-vs-spend on ₹50,000: P(transfer) · amount_weight · w_trust (large)
V_future = n_future(merchant or pattern, 90 d) · Δaccuracy(a | label) · v_correct
           # merchant-level propagation: a label for a recurring merchant pays off many times
C_ask    = c0 + c_fatigue · questions_last_7d + c_context(quiet hours, recent intervention, muted channel)
ask iff EVOI ≥ λ_t   and   budget not exhausted
λ_{t+1}  = λ_t · exp(η · (asked_t − B_target) / B_target)          # budget pacing (shadow price)
```

**MVP heuristic** (before EVOI is calibrated) [D]. Ask if (top-1 probability < 0.6 **or** a
plausible transfer/refund/reimbursement has P ≥ 0.2) **and** amount ≥ the materiality floor
(≈ the user's 40th-percentile discretionary amount, at least a currency-specific floor such as
₹200 or $10) **and** the merchant has not been labeled before **and** no similar question went
out in the last 24 h.

**Never ask** when top-1 probability ≥ 0.9, the merchant's label was confirmed ≥2 times, the
candidate's confidence is < 0.5 (it may not exist), or the category is sensitive.

**One question per item.** Ask the single attribute with the highest EVOI. Never chain questions.

**Options.** The two most probable values plus "Other…", which opens the app. On Android the third
button is "Other" (≤3 [V]). On iOS, assume 2 visible when space is limited [V] and put "Other" in
the expanded list. If P(transfer) is material, one of the two options **must** be "Not spending
(transfer)".

**Generalize after answering.** After a label, offer the rule once: "Always treat Swiggy as
Eating out? [Yes] [Just this once]" (explanatory-debugging principle [L]). A "yes" removes all
future questions for that merchant and attribute.

**Onboarding burst.** Offer an optional in-app "Teach BRAKE in 2 minutes" with ≤10 highest-EVOI
historical items. It is opt-in and does not count against the weekly push budget.

**Stop rules** [D]:
- 3 consecutive ignored questions → halve the budget for 2 weeks.
- A muted `questions` channel → move questions into the weekly review only.
- "Stop asking about this" → permanent exclusion for that merchant or category.

**What to measure** (to answer the open "how many labels before churn" question):
- the label-response curve P(answer | questions in trailing 7 d, tenure);
- 7-day and 30-day retention against the questions-received tercile (with randomized budgets,
  this is a causal estimate);
- correction rate after auto-labeling.

### 4.4 Regret-prompt sampling policy

**Eligibility** [D]. Candidate `status ∈ {confirmed, posted}`, `confidence ≥ 0.8`, P(discretionary)
≥ 0.5, amount ≥ materiality floor, not refunded or cancelled, not a transfer, investment, bill,
rent, medical or sensitive category, not a shared or business expense, not already asked
(`deduplicationGroup`), and the user hasn't opted out of the category.

**Selection** (each week, choose ≤K, default K=1):
- With probability 0.5, sample **uniformly** from the eligible set, stratified by amount band
  (exploration; gives unbiased base rates).
- Otherwise pick the eligible purchase whose stratum has the **highest posterior variance** of
  regret rate, weighted by stake (uncertainty sampling).
- Strata [D]: category group × amount band (relative to the user's distribution) × channel
  (online/in-store) × late-night flag × planned (prior intent observed vs not) × rail family.
- **Log the propensity** π for every asked purchase, and for the eligible set it was drawn from.

**Timing** (delay from purchase) [D], following E1/E8:

| Purchase type | Ask at | Why |
|---|---|---|
| Food, drinks, entertainment, rides, experiences | 18–36 h after, in the user's morning window | Action regret is fresh. Prevents rosy-view drift |
| Physical goods with a delivery signal | ~3 days after delivery, and **before** the return window ends | User has had the item. The remedy is still possible |
| Physical goods without a delivery signal | 5–7 days after purchase | Approximate delivery plus use |
| Large planned purchases (prior intent observed, ≥90th percentile) | 14–30 days, ≤1 per quarter | Rarely regretted. Low information value |
| Subscriptions | Not a regret prompt. A **"keep?"** check 3 days before renewal | Actionable decision, different question |
| In-store impulse (no intent, no order) | 18–36 h | No remedy usually. Learning only |

**Delivery.** Not in quiet hours. Not within 2 h of another BRAKE prompt. Not in the same
notification as a budget-pace message. If unanswered, it **expires into the weekly review once**,
then is dropped. It is never re-sent.

**Estimation.** Horvitz–Thompson/IPW regret rate per stratum, with hierarchical shrinkage toward
the user's overall rate and a population prior. The population prior is shipped as a static,
aggregate-only prior or learned via opt-in aggregate analytics [D]. Show a pattern to the user only
when n ≥ 5 answered in that stratum and posterior P(stratum rate − user rate ≥ 0.15) ≥ 0.8 [D].

**Anti-obsession guardrails** [D]:
- No regret counters, totals, streaks, scores or "money wasted" figures. Ever.
- "Wish I hadn't" ≥3 times in a week → no more regret prompts that week, and the next message is
  supportive and remedy-focused (or nothing).
- ≥3 ignored regret prompts → pause them for 4 weeks, then ask once in-app whether to keep them.
- Respondents who answer *every* prompt within seconds, at night, for weeks get a gentle frequency
  reduction. This is detection of possible over-monitoring, not a diagnosis.
- Always offer [Don't ask about these] (category-level) and a global off switch. Both are honored
  immediately.

**Research mode** (opt-in) [D]. Randomize the delay bucket (1 d / 3 d / 7 d / 14 d) to estimate
empirically how delay affects ratings and response rates. This is the most direct way to settle
the brief's "24–72 h?" question for BRAKE's population.

### 4.5 Calibrated language contract

Map BRAKE's internal probabilities to fixed surface forms. Keep the mapping in **one** module so
copy can't drift [D]:

| Internal confidence (fact about a transaction) | Surface form | Example |
|---|---|---|
| ≥ 0.95 | Plain statement | "₹850 at Starbucks" |
| 0.80–0.95 | "Looks like…" | "Looks like you spent about ₹850 at Starbucks." |
| 0.50–0.80 | Question in the **title** | "Was this ₹850 at Starbucks?" |
| < 0.50 | Silent. Weekly review only, as a question | — |

| Prediction about the user (regret, pattern) | Surface form |
|---|---|
| n < 5 | Don't surface |
| n ≥ 5 | Natural frequency from the user's own answers: "You said 'wish I hadn't' about 4 of your last 6…" |
| Never | "You'll regret this", "Most people regret…", bare percentages |

Provenance is always one tap away ("How did BRAKE know this?"). The source label comes from
`SourceRef.label`, and the user's own answers are cited as their own words.

### 4.6 Adapter and data-model notes

- **New record types** [D]: `InterventionEvent` (§12 fields) and `QuestionEvent` (§8 fields)
  stored alongside `UserAssertion`. Extend `SatisfactionAssertion` with `propensity`,
  `delayHours`, `selectionReason`, `askContext` and `promptVariant`. Without propensity, regret
  learning is biased (E9).
- **Rules and goals** are `user_rule` sources. A rule's `condition` must be expressed in
  **capability-checked** predicates (`merchant`, `category`, `amount`, `hour`, `rail.family`,
  `app_token`). The registry decides whether a rule can be sensed for this user, and inactive rules
  are shown as such.
- **Surface limits** go into `PlatformProfile.surface` [V]:
  - Android: `maxQuickActions: 3`, `supportsTextInput: true` (RemoteInput, API 24+).
  - iOS: `maxQuickActions: 2` (limited-space display; up to 10 when expanded, HIG detail view up to
    4), `supportsTextInput: true` (`UNTextInputNotificationAction`).
  - Web and desktop: not verified here.
- **Channels and levels** [V]:
  - Android channels `questions` (`IMPORTANCE_DEFAULT`), `insights` (`IMPORTANCE_LOW`), `digest`
    (`IMPORTANCE_MIN`), `reminders` (`IMPORTANCE_DEFAULT`; user-requested holds). Importance can't
    be changed after creation, so pick conservatively.
  - iOS: `passive` for insights and digest, `active` for questions, `timeSensitive` only for
    user-requested hold reminders. Set `relevanceScore` by EVOI.
- **Normalization pitfalls.**
  1. Satisfaction depends on delay and context. Never pool a 1-day and a 30-day rating without a
     delay covariate.
  2. "Discretionary" ≠ "regretted" ≠ "impulsive". Keep them as separate attributes (the model
     already does). Don't infer regret from essentiality.
  3. Timestamps from ledger sources are often date-only, which corrupts `is_late_night`. Use the
     hour only when `occurredAt` comes from a real-time source.
  4. Shared, gift and reimbursable purchases distort personal regret, so exclude them.
  5. Manual-check labels are a self-selected sample. Tag the surface.
  6. Partial source coverage makes "pace" claims wrong. Carry a coverage note into every insight.
- **Capability-registry facts this stream contributes** (platform scope, verified 2026-10-04):
  `os:post-notifications-runtime` (Android 13+, default off), `os:notification-cooldown` (Android
  15+), `os:notification-interruption-levels` (iOS 15+), `os:screen-time-shield` (iOS,
  FamilyControls individual authorization; **entitlement approval required**; Android
  unavailable). Country-scope regulatory facts are in the structured summary (dark-pattern
  regulation IN/EU/US; statutory withdrawal right EU; BNPL regimes GB/EU/US).

### 4.7 Evaluation plan

- **Micro-randomized trial (MRT) from day one** [L]. At each eligible decision point, randomize L0
  vs the policy's chosen level (e.g. p=0.5 in beta, 0.2 in production). Primary proximal outcomes:
  purchase within 24 h (when sensed) and the later satisfaction label. Moderators: tenure, time of
  day, rule vs model origin, intensity setting. Expect effect decay (HeartSteps, Opower) and
  estimate it explicitly.
- **Distal outcomes.** IPW share of discretionary spending later rated "worth it", goal progress,
  CFPB FWB quarterly, autonomy item, 90-day retention.
- **Guardrails.** Channel-mute rate, "stop asking" taps, uninstall within 48 h of an intervention,
  share of interventions continued through (habituation), complaint keywords.
- **Do not** optimize opens, sessions or time in app.

---

## Risks, policy constraints and ethical concerns

1. **Scolding and shame create disengagement and harm.** Reactance and shame (E5) produce
   avoidance, so BRAKE stops being useful exactly when finances are bad. *Mitigation:* the copy
   rules in 4.2, a lint-able banned-words list in localization, and qualitative review of every
   template in each language.
2. **Obsessive tracking and financial anxiety.** Quantification can erode enjoyment (Etkin 2016),
   and regret loops can feed rumination. Compulsive buying affects a meaningful minority (pooled
   prevalence ≈4.9% in Maraz, Griffiths & Demetrovics 2016, Addiction 111(3), **as recalled,
   unverified**). *Mitigation:* the guardrails in 4.4, no gamified restraint, an easy quiet mode, and
   neutral pointers to help (debt advice and similar services, localized) offered **without
   diagnosis** when the user asks for help or sets restrictive rules.
3. **Paternalism and autonomy.** Model-initiated strong friction would be paternalistic and is a
   legal risk (EU AI Act Art. 5 "materially distorting behaviour"; dark-pattern regimes).
   *Mitigation:* L3/L4 only from user-authored rules; an explanation on every intervention; an
   intensity setting defaulting to "Gentle"; "tighten now, loosen later" only with prior disclosure,
   and only for rules the user made.
4. **BRAKE's own dark patterns.** Paywalls, cancellation, disconnect and delete flows must be
   frictionless. Never use confirm shaming ("No, I like overspending"), nagging, false urgency or
   subscription traps (India CCPA's 13 patterns; EU DSA Art. 25; FTC; Apple 3.1.2(a) [V]). India's
   *nagging* definition specifically covers repeated interruptions **(exact text unverified)**,
   which turns BRAKE's notification budget into a compliance matter.
5. **Sensitive notification content.** Apple 4.5.4 says push notifications "should not be used to
   send sensitive personal or confidential information" [V], and the HIG says to avoid private
   information [V]. *Mitigation:* generate notifications locally, use lock-screen-safe public
   versions (Android `VISIBILITY_PRIVATE` + `setPublicVersion` [V]), and offer a setting to hide
   amounts. Whether bank-style amount notifications are acceptable under 4.5.4 is an interpretation
   question (Open questions).
6. **Inferred sensitive data.** Regret, mood and spending-style profiles reveal personality and
   potentially special-category data: health purchases, religion, sexuality-related spending
   (Gladstone et al. 2019 [L]). *Mitigation:* on-device storage, exclusion of sensitive categories
   from prompts and patterns, no transmission without opt-in, deletion along with the source
   (assertions anchored to purged observations are deleted too).
7. **Biased learning.** Non-random asking produces wrong "you usually regret X" claims, which then
   become unjust nudges. *Mitigation:* propensity logging and IPW, minimum n, and frequency-format
   disclosure of n.
8. **Habituation and decay.** Interventions lose force (Anderson 2016; Allcott & Rogers 2014;
   HeartSteps). *Mitigation:* rarity, rotating formats, rule-edit offers, and decay modeled in the
   MRT.
9. **Measurement reactivity.** Asking changes behavior (Stango & Zinman 2014; question–behavior
   effect), which confounds evaluation. *Mitigation:* count questions as treatments in the MRT.
10. **Over-restraint harms some users.** Tightwads and hyperopic regret (E2, E8). *Mitigation:*
    the spending-style prior, "worth it" affirmations, and allowing personalization to *reduce*
    friction.
11. **Platform gating.** The iOS FamilyControls entitlement needs Apple approval [V]. Android
    app-launch friction depends on Play policy for UsageStats and Accessibility (not verified here).
    Android 13+ notification permission is off by default [V]: without a well-timed ask, the
    post-spend loop does not exist.
12. **Evidence quality.** Several classic effects are smaller than first reported or are contested
    (ego depletion; payment-method magnitudes; unconscious thought). BRAKE's claims to users and
    investors should rest on BRAKE's own randomized data within months of launch.
13. **Verification gap in this document.** Literature figures marked (unverified) and regulatory
    dates after mid-2025 must be re-checked against primary sources before they are used in
    marketing, compliance or registry `asOf` facts.

---

## Open questions

1. **Label tolerance.** How many push questions per week can BRAKE ask before 30-day retention
   drops? No public benchmark could be verified. Settle it with randomized budgets (0/1/2/4 per
   week) in beta.
2. **Optimal regret delay** for each purchase type in BRAKE's markets (India vs US): run the
   randomized delay buckets from 4.4.
3. **Do regret labels improve personalization** over implicit signals and categories alone, on
   held-out regret and on user-rated intervention helpfulness?
4. **Does an in-spend pause on BRAKE-owned hand-offs** (QR → UPI intent) reduce later-regretted
   spending, or only shift it to other rails? This needs whole-wallet sensing.
5. **What in-spend pause length** (3 s vs 10 s vs reflection-question-only) maximizes the
   abandon rate for later-regretted purchases while minimizing annoyance for later-endorsed ones?
6. **Apple 4.5.4 interpretation.** Are amount+merchant notifications acceptable if generated
   locally? Is the FamilyControls entitlement grantable for a non-parental "self-control" finance
   app in 2026?
7. **Android app-launch friction.** Does current Google Play policy (2026) permit UsageStats- or
   Accessibility-based shielding for a self-control use case? (Device-signals stream.)
8. **Localization of calibrated phrases.** Do Hindi, Tamil and Hinglish hedges ("shayad",
   "lagta hai") map to the same confidence bands? This needs native-speaker calibration tests
   (cross-language variation in Budescu et al. 2014 [L]).
9. **India CCPA "nagging" scope.** Does it apply to a non-transactional coaching app's prompts?
   Check the self-audit advisories issued in 2025 (unverified).
10. **Vulnerable users.** What is a safe, non-diagnostic response when interaction patterns
    suggest compulsive buying or distress, and which local services to point to?
11. **Population priors without centralizing sensitive data.** Can regret priors be learned with
    aggregate-only or federated methods with acceptable privacy guarantees?
12. **Does the one sec effect transfer from social apps to shopping apps**, and does it persist
    beyond ~6 weeks?

---

## References

### A. URLs actually consulted in this session (fetched 2026-10-04)

1. https://developer.android.com/training/notify-user/build-notification: "A notification can offer
   up to three action buttons"; direct reply (`RemoteInput`, Android 7.0/API 24); update
   rate-limiting; lock-screen visibility `VISIBILITY_PUBLIC/SECRET/PRIVATE` and
   `setPublicVersion()`.
2. https://developer.android.com/develop/ui/compose/notifications: importance levels; channels
   required since Android 8.0; **Android 15 notification cooldown** ("reduces the appearance, sound
   volume and vibration intensity for repetitive notifications for up to two minutes").
3. https://developer.android.com/develop/ui/compose/notifications/notification-permission:
   `POST_NOTIFICATIONS` on Android 13+; "notifications are off by default" for new installs;
   request in context (e.g. after an order).
4. https://developer.android.com/develop/ui/views/notifications/channels: importance table
   (`IMPORTANCE_HIGH/DEFAULT/LOW/MIN/NONE`); importance cannot be changed programmatically after
   creation.
5. https://developer.android.com/about/versions/16/behavior-changes-all: no notification behavior
   changes listed for all apps in Android 16 ("progress-centric notifications" listed as a feature).
6. https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel
   (fetched via the docs JSON endpoint): `passive`, `active`, `timeSensitive` ("breaks through
   system notification controls"), `critical`; iOS 15.0+.
7. https://developer.apple.com/documentation/usernotifications/unnotificationcategory: "When the
   system has unlimited space, the system displays up to 10 actions. When the system has limited
   space, the system displays at most two actions."
8. https://developer.apple.com/design/human-interface-guidelines/notifications: detail view "up to
   four buttons"; avoid sensitive information; "Avoid sending multiple notifications for the same
   thing…".
9. https://developer.apple.com/app-store/review/guidelines/: 4.5.4 (push notifications, sensitive
   info, marketing opt-in); 5.1.1(ix) (regulated fields submitted by legal entity); 3.2.1(viii);
   3.1.2(a) (subscription trickery); 3.2.2(ix) (loan apps).
10. https://developer.apple.com/documentation/usernotifications/unnotificationcontent/relevancescore:
    a 0–1 score sorts notifications, and the highest is featured in the summary.
11. https://developer.apple.com/documentation/usernotifications/untextinputnotificationaction:
    an action that accepts typed text.
12. https://developer.apple.com/documentation/usernotifications/unnotificationcategoryoptions/customdismissaction:
    sends dismiss actions to the delegate.
13. https://developer.apple.com/documentation/familycontrols: individual authorization needs
    device-owner approval; the entitlement `com.apple.developer.family-controls` must be requested
    before App Store submission.
14. https://developer.apple.com/documentation/managedsettings/shieldsettings: shield
    `applications`, `applicationCategories`, `webDomains`.
15. https://developer.apple.com/documentation/managedsettings/shieldactiondelegate: handles shield
    button actions; the system provides opaque tokens, not app names.
16. https://developer.apple.com/documentation/managedsettings/shieldactionresponse: `close`,
    `defer`, `none`, `openParentalControlsApp`.
17. https://developer.apple.com/documentation/deviceactivity: privacy-preserving monitoring of app
    and web activity with schedules and thresholds.

*Attempted but blocked by the session's egress proxy:* pnas.org (one sec paper), pubmed, Europe
PMC, OpenAlex, Crossref, doi.org, arXiv, nber.org, consumerfinance.gov, fca.org.uk, ftc.gov,
gov.uk, eur-lex.europa.eu, ipcc.ch, one-sec.app, wikipedia.org, semanticscholar.org, osf.io,
bi.team, support.google.com, learn.microsoft.com. The shared web-search quota was exhausted before
this stream began.

### B. Literature cited but not fetched in this session (bibliographic; verify before external use)

18. Grüning, D. J., Riedel, F., & Lorenz-Spreen, P. (2023). Directing smartphone use through the
    self-nudge app one sec. *PNAS* 120(8), e2213114120. (https://www.pnas.org/doi/10.1073/pnas.2213114120, blocked.)
    Brief self-chosen friction reduces app opening.
19. Prelec, D., & Loewenstein, G. (1998). The red and the black. *Marketing Science* 17(1). Pain of
    paying, coupling.
20. Prelec, D., & Simester, D. (2001). Always leave home without it. *Marketing Letters* 12(1).
    Credit-card willingness-to-pay premium.
21. Soman, D. (2001). Effects of payment mechanism on spending behavior. *JCR* 27(4). Rehearsal
    and immediacy.
22. Raghubir, P., & Srivastava, J. (2008). Monopoly money. *J. Exp. Psych.: Applied* 14(3).
    Payment transparency.
23. Knutson, B., et al. (2007). Neural predictors of purchases. *Neuron* 53(1).
24. Rick, S., Cryder, C., & Loewenstein, G. (2008). Tightwads and spendthrifts. *JCR* 34(6).
25. Shah, A. M., et al. (2016). "Paper or plastic?" *JCR* 42(5).
26. Thaler, R. H. (1985). Mental accounting and consumer choice. *Marketing Science* 4(3); Thaler
    (1999) *JBDM* 12(3); Heath, C., & Soll, J. B. (1996). Mental budgeting. *JCR* 23(1).
27. Loewenstein, G. (1996). Out of control. *OBHDP* 65(3); (2005) Hot-cold empathy gaps. *Health
    Psychology* 24(4S).
28. Camerer, C., et al. (2003). Regulation for conservatives. *U. Penn. Law Review* 151(3).
29. Nieuwenstein, M. R., et al. (2015). Unconscious thought advantage meta-analysis/replication.
    *Judgment and Decision Making* 10(1).
30. Anderson, B. B., et al. (2016). From warning to wallpaper. *J. Management Information Systems*
    33(3).
31. Rook, D. W. (1987). The buying impulse. *JCR* 14(2).
32. Vohs, K. D., & Faber, R. J. (2007). Spent resources. *JCR* 33(4); Hagger, M. S., et al. (2016).
    Multisite preregistered test of ego depletion. *Perspectives on Psych. Science* 11(4).
33. Lerner, J. S., Small, D. A., & Loewenstein, G. (2004). *Psych Science* 15(5); Cryder, C. E., et
    al. (2008). *Psych Science* 19(6); Atalay, A. S., & Meloy, M. G. (2011). *Psychology &
    Marketing* 28(6); Rick, S. I., Pereira, B., & Burson, K. A. (2014). *JCP* 24(3).
34. Wilcox, K., & Stephen, A. T. (2013). Are close friends the enemy? *JCR* 40(1).
35. Mathur, A., et al. (2019). Dark patterns at scale. *Proc. ACM HCI* 3(CSCW). Lynn, M. (1991).
    Scarcity effects on value. *Psychology & Marketing* 8(1).
36. US FTC (2022). *Bringing Dark Patterns to Light* (staff report). (ftc.gov, blocked.)
37. India Central Consumer Protection Authority (2023). *Guidelines for Prevention and Regulation
    of Dark Patterns, 2023* (30 Nov 2023). (Not fetched.)
38. Regulation (EU) 2022/2065 (Digital Services Act), Art. 25; Regulation (EU) 2024/1689 (AI Act),
    Art. 5; Directive 2011/83/EU (Consumer Rights), Art. 9; EDPB Guidelines 03/2022. (EUR-Lex,
    blocked.)
39. CFPB (2022). *Buy Now, Pay Later: Market trends and consumer impacts*. Di Maggio, M., Katz, J.,
    & Williams, E. (2022). Buy now, pay later. NBER WP 30508. Guttman-Kenney, B., Firth, C., &
    Gathergood, J. (2023). *J. Behavioral & Experimental Finance*.
40. Stephens, M. (2003). "3rd of tha month". *AER* 93(1); Gelman, M., et al. (2014). *Science*
    345(6193); Olafsson, A., & Pagel, M. (2018). The liquid hand-to-mouth. *RFS* 31(11); Olafsson
    & Pagel, The ostrich in us, NBER WP 23945.
41. Ashraf, N., Karlan, D., & Yin, W. (2006). Tying Odysseus to the mast. *QJE* 121(2).
42. Thaler, R. H., & Benartzi, S. (2004). Save More Tomorrow. *JPE* 112(S1).
43. Bryan, G., Karlan, D., & Nelson, S. (2010). Commitment devices. *Annual Review of Economics* 2.
44. Gollwitzer, P. M. (1999). *Am. Psychologist* 54(7); Gollwitzer, P. M., & Sheeran, P. (2006).
    *Adv. Exp. Soc. Psych.* 38.
45. Karlan, D., et al. (2016). Getting to the top of mind. *Management Science* 62(12); Soman, D.,
    & Cheema, A. (2011). Earmarking and partitioning. *JMR* 48.
46. Dai, H., Milkman, K. L., & Riis, J. (2014). The fresh start effect. *Management Science*
    60(10).
47. Frederick, S., et al. (2009). Opportunity cost neglect. *JCR* 36(4); Spiller, S. A. (2011).
    *JCR* 38(4).
48. Brehm, J. W. (1966). *A Theory of Psychological Reactance*; Rains, S. A. (2013). *Human
    Communication Research* 39(1); Miller, C. H., et al. (2007). *HCR* 33(2); Carpenter, C. J.
    (2013). *Communication Studies* 64(1).
49. Tangney, J. P., Stuewig, J., & Mashek, D. J. (2007). Moral emotions and moral behavior.
    *Annual Review of Psychology* 58.
50. Karlsson, N., Loewenstein, G., & Seppi, D. (2009). The ostrich effect. *J. Risk & Uncertainty*
    38(2); Sicherman, N., et al. (2016). Financial attention. *RFS* 29(4).
51. Medina, P. C. (2021). Side effects of nudging. *RFS* 34(5); Stango, V., & Zinman, J. (2014).
    Limited and varying consumer attention. *RFS* 27(4).
52. Sprott, D. E., et al. (2006). The question–behavior effect. *Social Influence* 1(2); Wood, C.,
    et al. (2016). *PSPR* 20(3); Spangenberg, E. R., et al. (2016). *JCP* 26(3).
53. Schultz, P. W., et al. (2007). *Psych Science* 18(5); Allcott, H. (2011). *J. Public Econ.*
    95(9–10); Allcott, H., & Rogers, T. (2014). *AER* 104(10).
54. Ryan, R. M., & Deci, E. L. (2000). *Am. Psychologist* 55(1); Peters, D., Calvo, R. A., & Ryan,
    R. M. (2018). *Frontiers in Psychology* 9.
55. Hertwig, R., & Grüne-Yanoff, T. (2017). Nudging and boosting. *Perspectives on Psych. Science*
    12(6); Reijula, S., & Hertwig, R. (2022). Self-nudging. *Behavioural Public Policy* 6(1).
56. Dietvorst, B. J., Simmons, J. P., & Massey, C. (2015). Algorithm aversion. *JEP: General*
    144(1); (2018) *Management Science* 64(3).
57. Pielot, M., Church, K., & de Oliveira, R. (2014). In-situ study of mobile phone notifications.
    *MobileHCI*; Mehrotra, A., et al. (2016). *CHI*; Stothart, C., et al. (2015). *JEP: HPP*
    41(4); Kushlev, K., et al. (2016). *CHI*; Fitz, N., et al. (2019). Batching smartphone
    notifications. *Computers in Human Behavior*.
58. van der Sijs, H., et al. (2006). Overriding of drug safety alerts. *JAMIA* 13(2); Ancker,
    J. S., et al. (2017). *BMC Med. Inform. Decis. Mak.* 17.
59. Nahum-Shani, I., et al. (2018). JITAIs. *Annals of Behavioral Medicine* 52(6); Klasnja, P., et
    al. (2015). Micro-randomized trials. *Health Psychology* 34(S); Klasnja, P., et al. (2019).
    HeartSteps MRT. *Annals of Behavioral Medicine* 53(6).
60. Gilovich, T., & Medvec, V. H. (1995). The experience of regret. *Psych. Review* 102(2).
61. Van Boven, L., & Gilovich, T. (2003). To do or to have? *JPSP* 85(6); Rosenzweig, E., &
    Gilovich, T. (2012). *JPSP* 102(2); Mitchell, T. R., et al. (1997). Rosy view. *JESP* 33(4);
    Nicolao, L., Irwin, J. R., & Goodman, J. K. (2009). *JCR* 36(2).
62. Kivetz, R., & Keinan, A. (2006). Repenting hyperopia. *JCR* 33(2); Keinan, A., & Kivetz, R.
    (2008). *JMR* 45(6).
63. Zeelenberg, M., & Pieters, R. (2007). Regret regulation 1.0. *JCP* 17(1); Tsiros, M., &
    Mittal, V. (2000). *JCR* 26(4); Inman, J. J., & Zeelenberg, M. (2002). *JCR* 29(1).
64. Csikszentmihalyi, M., & Larson, R. (1987). Validity and reliability of ESM. *J. Nervous &
    Mental Disease* 175(9); Shiffman, S., Stone, A. A., & Hufford, M. R. (2008). EMA. *Annu. Rev.
    Clin. Psych.* 4; Kahneman, D., et al. (2004). DRM. *Science* 306.
65. Wrzus, C., & Neubauer, A. B. (2023). EMA meta-analysis. *Assessment* 30(3); Vachon, H., et al.
    (2019). *JMIR* 21(12); Rintala, A., et al. (2019). *Psych. Assessment* 31(2); Eisele, G., et
    al. (2022). *Assessment* 29(2).
66. Schwarz, N., & Clore, G. L. (1983). Mood, misattribution, and judgments of well-being. *JPSP*
    45(3).
67. Matz, S. C., Gladstone, J. J., & Stillwell, D. (2016). *Psych Science* 27(5); Gladstone, J. J.,
    Matz, S. C., & Lemaire, A. (2019). *Psych Science* 30(7).
68. Etkin, J. (2016). The hidden cost of personal quantification. *JCR* 42(6).
69. Kaye, J., et al. (2014). Money talks. *CHI*; Epstein, D. A., et al. (2015). Lived informatics.
    *UbiComp*; Epstein, D. A., et al. (2016). Beyond abandonment. *CHI*; Cordeiro, F., et al.
    (2015). Food journaling. *CHI*; Choe, E. K., et al. (2017). Semi-automated tracking. *IEEE
    Pervasive Computing* 16(1).
70. Settles, B. (2009). *Active Learning Literature Survey*, UW–Madison CS TR 1648; Lewis, D. D., &
    Gale, W. A. (1994). *SIGIR*; Roy, N., & McCallum, A. (2001). *ICML*.
71. Kapoor, A., & Horvitz, E. (2008). Experience sampling for building predictive user models.
    *CHI*; Horvitz, E. (1999). Principles of mixed-initiative user interfaces. *CHI*.
72. Amershi, S., et al. (2014). Power to the people. *AI Magazine* 35(4); Amershi, S., et al.
    (2019). Guidelines for human-AI interaction. *CHI*; Cakmak, M., Chao, C., & Thomaz, A. L.
    (2010). *IEEE TAMD*; Kulesza, T., et al. (2015). Explanatory debugging. *IUI*.
73. Marlin, B. M., & Zemel, R. S. (2009). *RecSys*; Schnabel, T., et al. (2016). Recommendations
    as treatments. *ICML*; Joachims, T., Swaminathan, A., & Schnabel, T. (2017). *WSDM*.
74. Kent, S. (1964). Words of estimative probability; Wallsten, T. S., et al. (1986). *JEP:
    General* 115(4); Mosteller, F., & Youtz, C. (1990). *Statistical Science* 5(1).
75. Mastrandrea, M. D., et al. (2010). IPCC AR5 guidance note on consistent treatment of
    uncertainties (https://www.ipcc.ch/site/assets/uploads/2017/08/AR5_Uncertainty_Guidance_Note.pdf,
    blocked); Budescu, D. V., Broomell, S., & Por, H.-H. (2009). *Psych Science* 20(3); Budescu,
    D. V., et al. (2014). *Nature Climate Change* 4.
76. Teigen, K. H., & Brun, W. (1999). Directionality of verbal probability expressions. *OBHDP*
    80(2).
77. van der Bles, A. M., et al. (2020). Effects of communicating uncertainty on public trust.
    *PNAS* 117(14); Zhang, Y., Liao, Q. V., & Bellamy, R. K. E. (2020). *FAT\**; Yin, M., Wortman
    Vaughan, J., & Wallach, H. (2019). *CHI*.
78. Gigerenzer, G., & Hoffrage, U. (1995). Frequency formats. *Psych. Review* 102(4); Kay, M., et
    al. (2016). When (ish) is my bus? *CHI*.
79. Maraz, A., Griffiths, M. D., & Demetrovics, Z. (2016). Prevalence of compulsive buying.
    *Addiction* 111(3).
80. Close, A. G., & Kukar-Kinney, M. (2010). Beyond buying: online shopping cart use. *J. Business
    Research* 63(9–10).
81. CFPB Financial Well-Being Scale (10-item and 5-item versions) (consumerfinance.gov, blocked).
