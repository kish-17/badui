import { DAY, HOUR } from "@brake/core";
import type {
  CandidateId,
  CandidateLink,
  CandidateLinkKind,
  CandidatePatch,
  CategoryId,
  Direction,
  Inference,
  InferenceBasis,
  InstrumentObservation,
  Money,
  OwnedInstrument,
  Ownership,
  TransactionCandidate,
  TransactionType,
  TransferKind,
} from "@brake/core";
import type { Distribution, Reconciler, ReconciliationContext, ReconciliationResult, UserModel } from "./contracts";
import { confidenceTier } from "./copy";
import { isLikelyDuplicate } from "./spending";
import { UNCATEGORIZED } from "./taxonomy";

/**
 * Reconciliation: how *different* events relate (fusion decides which
 * observations are the *same* event). A ₹50,000 debit may be rent, an
 * investment, a move to the user's own account, a card bill, family support,
 * a loan instalment or a real purchase; calling the wrong ones "spending"
 * destroys trust, so this module:
 *
 *  1. pairs equal-and-opposite legs between the user's own instruments
 *     (own-account transfers, wallet loads, card-bill payments, brokerage and
 *     loan accounts);
 *  2. matches refunds to the purchases they reverse;
 *  3. matches person-to-person credits to the purchase they pay back a share of;
 *  4. reads single legs from normalized descriptor text, ISO 18245 codes,
 *     rail family and counterparty shape (person vs business), plus the
 *     "same person, monthly, large, early in the month" rent pattern.
 *
 * It never looks at which provider, adapter, country or OS produced a
 * candidate — only at normalized candidate fields and standard vocabularies.
 * Every output is an `Inference` that keeps its alternatives, so an uncertain
 * case ("0.6 transfer / 0.4 purchase") reaches the question policy intact.
 * User-set types are never changed, and per-counterparty answers from the
 * user model outweigh heuristics in proportion to how many there are.
 *
 * Reconciliation is idempotent: its own earlier output (basis
 * "reconciliation") is never treated as evidence, and a candidate whose
 * reconciliation-owned fields already match gets no patch.
 */

export interface ReconcilerOptions {
  /** Max time between the two legs of an own-account transfer or wallet load. Default 3 days. */
  readonly transferWindowMs?: number;
  /** Max time between a bank debit and the payment credit on the card account (posting lag over a weekend). Default 5 days. */
  readonly cardPaymentWindowMs?: number;
  /** Max time from a purchase to its refund. Default 120 days. */
  readonly refundWindowMs?: number;
  /**
   * Max time from a movement that was never spending (card bill, EMI, SIP,
   * transfer) to the credit that reverses it in full (a returned mandate, a
   * failed payment auto-reversed). Default 5 days.
   */
  readonly reversalWindowMs?: number;
  /** Max time from a purchase to a person paying back a share of it. Default 30 days. */
  readonly reimbursementWindowMs?: number;
  /** Relative tolerance when testing whether a credit is a 1/k share of a purchase. Default 0.05. */
  readonly shareTolerance?: number;
  /** Largest number of people a purchase is assumed to be split between. Default 10. */
  readonly maxShareDivisor?: number;
  /** Minimum probability for a transfer-pair or refund link. Default 0.6. */
  readonly linkThreshold?: number;
  /** Minimum probability for a reimbursement link (they are weaker by nature). Default 0.4. */
  readonly reimbursementLinkThreshold?: number;
  /** Minimum refund-link probability before an original's status becomes "refunded". Default 0.75. */
  readonly refundedStatusThreshold?: number;
  /** Pseudo-count k against which user-model evidence n is weighed: w = n / (n + k). Default 2. */
  readonly userModelPseudoCount?: number;
}

export const DEFAULT_RECONCILER_OPTIONS: Required<ReconcilerOptions> = {
  transferWindowMs: 3 * DAY,
  cardPaymentWindowMs: 5 * DAY,
  refundWindowMs: 120 * DAY,
  reversalWindowMs: 5 * DAY,
  reimbursementWindowMs: 30 * DAY,
  shareTolerance: 0.05,
  maxShareDivisor: 10,
  linkThreshold: 0.6,
  reimbursementLinkThreshold: 0.4,
  refundedStatusThreshold: 0.75,
  userModelPseudoCount: 2,
};

/** Link kinds this module owns; a patch's `links` replaces exactly these on the candidate. */
export const RECONCILIATION_LINK_KINDS: ReadonlySet<CandidateLinkKind> = new Set([
  "transfer_counterpart",
  "card_payment_for",
  "refund_of",
  "refunded_by",
  "reimbursement_of",
]);

export function createReconciler(options: ReconcilerOptions = {}): Reconciler {
  const opts: Required<ReconcilerOptions> = { ...DEFAULT_RECONCILER_OPTIONS, ...options };
  return {
    reconcile(candidates: readonly TransactionCandidate[], ctx: ReconciliationContext): ReconciliationResult {
      return reconcileAll(candidates, ctx, opts);
    },
  };
}

/**
 * Plain-language answer to "How did BRAKE know this?" for a reconciliation
 * link, worded to its probability (never more certain than the match).
 */
export function explainReconciliationLink(link: CandidateLink): string | null {
  const sure = confidenceTier(link.probability) === "high";
  switch (link.kind) {
    case "transfer_counterpart":
      return sure
        ? "Matched with the other side of a transfer between your own accounts, so it isn't counted as spending."
        : "Looks like one side of a transfer between your own accounts.";
    case "card_payment_for":
      return sure
        ? "Matched with the payment received on your credit card. The purchases on that card are counted once, when they happen."
        : "Looks like a payment towards your credit card bill.";
    // Worded for both a refund of a purchase and a reversal of a payment (a returned card-bill autopay).
    case "refund_of":
      return sure ? "Matched as a refund or reversal of an earlier payment." : "Looks like a refund or reversal of an earlier payment.";
    case "refunded_by":
      return sure ? "This payment was refunded or reversed later." : "A later credit looks like a refund or reversal of this payment.";
    case "reimbursement_of":
      return sure
        ? "Matched as someone paying you back a share of an earlier purchase."
        : "Looks like someone paying you back a share of an earlier purchase.";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                 */
/* ------------------------------------------------------------------ */

/** Accent-free lower case with every non-alphanumeric run a single space ("SEPA-Überweisung" -> "sepa uberweisung"). */
function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whole-word alternation over normalized text; phrases may hold regex fragments. */
function words(...phrases: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${phrases.join("|")})\\b`);
}

function anyOf(...res: readonly RegExp[]): RegExp {
  return new RegExp(res.map((r) => `(?:${r.source})`).join("|"));
}

/**
 * Descriptor vocabulary in the languages BRAKE's first markets write
 * narrations in. These describe what money *did* (fee, ATM, card bill,
 * salary…), never who reported it, so they hold for any bank or rail.
 */
type Flag =
  | "fee"
  | "gst"
  | "education"
  | "tax"
  | "cash"
  | "cc"
  | "cc_app"
  | "card_payment_credit"
  | "loan"
  | "invest"
  | "wallet_strong"
  | "wallet_weak"
  | "wallet_context"
  | "airtime"
  | "own"
  | "own_unless"
  | "split"
  | "rent"
  | "rent_goods"
  | "refund"
  | "cashback"
  | "salary"
  | "interest"
  | "reimb"
  | "cashout"
  | "payout"
  | "disbursal"
  | "deposit"
  | "p2p_rail"
  | "merchant_rail"
  | "debit_card"
  | "card_present";

const LEXICON: ReadonlyArray<readonly [Flag, RegExp]> = [
  ["fee", words("fee", "fees", "charge", "charges", "chrg", "chrgs", "chg", "chgs", "penalty", "commission", "comision", "comissao", "tarifa", "tarifas", "\\w*entgelt", "\\w*gebuhr\\w*", "\\w*gebuehr\\w*", "frais", "cotisation", "transaction cost", "nsf")],
  ["gst", words("gst", "igst", "cgst", "sgst")],
  ["education", words("school", "tuition", "college", "university", "exam", "admission", "application", "course", "coaching", "registration", "matricula", "mensalidade", "schule", "ecole")],
  ["tax", words("tax", "taxes", "income tax", "advance tax", "self assessment", "tds", "irs", "usataxpymt", "eftps", "hmrc", "finanzamt", "\\w*steuer\\w*", "impot", "impots", "dgfip", "receita federal", "darf", "iptu", "ipva", "kra", "cbdt", "oltas", "franchise tax")],
  ["cash", words("atm", "atw", "nwd", "cash withdrawal", "cash wdl", "cash wd", "customer withdrawal", "withdrawal at agent", "withdraw from agent", "agent withdrawal", "withdraw cash", "saque", "banco24horas", "bargeld\\w*", "geldautomat", "retrait", "retiro", "cajero", "cash advance", "cardless cash")],
  [
    "cc",
    anyOf(
      /\b(?:credit card|creditcard|credit crd|cr card|crcard|cc|crd)(?: \w+){0,3} (?:payment|pymt|pmt|paymt|autopay|auto pay|epay|epayment|e payment|bill|repayment|payoff)\b/,
      /\b(?:payment|pymt|pmt|autopay|epay|epayment|e payment|bill ?pay|bill payment)(?: (?!by\b|with\b|via\b|using\b|at\b)\w+){0,3} (?:credit card|creditcard|cc|crd|card|cards|crcard)\b/,
      /\b(?:crcardpmt|ccpay\w*|kreditkart\w*)\b/,
      /\bfatura(?: \w+){0,2} (?:cartao|credito|card|nubank)\b|\bcartao(?: \w+){0,2} fatura\b/,
      /\bpago(?: \w+){0,3} tarjeta\b/,
      /\bbbps\b.*\b(?:card|credit)\b/,
      /\b(?:amex|american express|discover|barclaycard|synchrony|applecard|apple card|capital one)\b.*\b(?:payment|pymt|pmt|autopay|epay|epayment)\b/,
    ),
  ],
  ["cc_app", words("cred", "cred club")],
  ["card_payment_credit", words("payment received", "payment recd", "pymt recd", "pmt recd", "payment thank you", "thank you for your payment", "payment thankyou", "thank you payment", "autopay payment", "automatic payment", "payment credit", "pagamento recebido", "zahlung erhalten", "pago recibido")],
  ["loan", words("emi", "loan", "loans", "mortgage", "repayment", "navient", "nelnet", "sallie mae", "mohela", "aidvantage", "lendingclub", "lending club", "upstart", "financiamento", "emprestimo", "consignado", "prestamo", "hipoteca", "darlehen", "tilgung", "kredit", "kreditrate", "echeance pret", "remboursement pret", "fuliza", "overdraw", "od loan", "hire purchase")],
  ["invest", words("sip", "mutual funds?", "mf", "asset management", "asset mgmt", "elss", "nps", "ppf", "index fund", "etf", "iccl", "indian clearing\\w*", "clearing corp\\w*", "nse clearing", "bse ltd", "bse limited", "bse star", "cams", "kfin\\w*", "zerodha", "groww", "upstox", "kuvera", "paytm money", "smallcase", "vanguard", "fidelity", "schwab", "robinhood", "etrade", "e trade", "wealthfront", "betterment", "acorns", "stash", "webull", "interactive brokers", "ibkr", "trade republic", "scalable capital", "degiro", "trading ?212", "hargreaves lansdown", "aj bell", "nutmeg", "moneybox", "freetrade", "xp investimentos", "tesouro direto", "aplicacao", "aplic", "cdb", "corretora", "nuinvest", "coinbase", "binance", "kraken", "crypto", "brokerage", "broking", "invest", "investment", "investments", "investing", "securities", "sparplan", "wertpapier\\w*", "fonds", "fondos", "unit trust", "mmf", "money market", "sacco", "roth ira", "ira contrib\\w*", "401k", "pension", "stocks and shares", "fixed deposit", "recurring deposit", "term deposit", "assurance vie", "previdencia")],
  ["wallet_strong", words("add money", "added money", "money added", "add funds", "add cash", "load money", "wallet load\\w*", "load wallet", "wallet top ?up", "wallet recharge", "recharge wallet", "guthaben aufladen", "recarga de saldo", "adicionar saldo")],
  ["wallet_weak", words("top ?up", "reload", "aufladen")],
  ["wallet_context", words("wallet", "balance", "saldo", "guthaben", "paypal", "venmo", "cash app", "cashapp", "revolut", "wise", "transferwise", "paytm", "phonepe", "mobikwik", "freecharge", "amazon pay", "apple cash", "picpay", "mercado ?pago", "skrill", "neteller", "payoneer", "m ?pesa", "airtel money", "momo", "gcash", "grabpay", "gopay", "monzo", "n26", "starling", "chime", "prepaid card", "travel card", "forex card")],
  ["airtime", words("airtime", "prepaid mobile", "mobile prepaid", "mobile recharge", "mobile top ?up", "data bundle", "bundles?", "dth", "fastag", "metro", "transit", "oyster", "phone credit", "celular", "handy")],
  ["own", words("self", "to self", "self transfer", "own account", "own acct", "own a c", "between accounts", "internal transfer", "transfer (?:to|from) (?:sav\\w*|chk|checking|savings)", "to savings", "from savings", "sweep", "auto sweep", "umbuchung", "ubertrag", "uebertrag", "eigenubertrag", "virement interne", "virement compte a compte", "livret", "traspaso", "transf entre contas", "transferencia entre contas", "mesma titularidade", "m ?shwari deposit", "m ?shwari withdraw\\w*", "lock savings", "savings pot", "round ?up")],
  ["own_unless", words("self service", "self storage", "self help", "self assessment", "self employed")],
  ["split", words("split", "splitwise", "settle up", "settleup", "my share", "your share", "share of", "dividir", "rachar", "partage")],
  ["rent", words("rent", "rental", "house rent", "room rent", "flat rent", "landlord", "lease", "aluguel", "aluguer", "\\w*miete", "mietzahlung", "loyer", "loyers", "alquiler", "arriendo", "kodi")],
  ["rent_goods", words("car", "cars", "vehicle", "equipment", "bike", "scooter", "camera", "costume", "movie", "video", "tools?", "hertz", "avis", "sixt", "zipcar", "u ?haul", "budget", "enterprise")],
  ["refund", words("refund", "refunded", "refunds", "rfnd", "refnd", "reversal", "reversed", "rev", "rtn", "chargeback", "return", "returned", "credit adj\\w*", "merchandise credit", "estorno", "estornado", "devolucao", "devolucion", "reembolso", "erstattung", "ruckerstattung", "rueckerstattung", "remboursement", "storno", "cancel\\w*", "annulation", "tax ref", "treas 310")],
  ["cashback", words("cashback", "cash back", "reward", "rewards", "points redemption", "statement credit", "promo credit")],
  ["salary", words("salary", "salaries", "sal (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|cr|credit|for)", "payroll", "wages?", "paycheck", "direct dep", "dir dep", "directdep", "direct deposit", "stipend", "salario", "salarios", "vencimentos?", "holerite", "folha de pagamento", "lohn", "gehalt", "bezuge", "bezuege", "salaire", "nomina", "sueldo", "mshahara", "gusto", "adp", "paychex", "deel", "rippling", "justworks", "trinet", "pension", "pensao", "aposentadoria", "inss")],
  ["interest", words("interest", "int pd", "int paid", "int cr", "int credit", "int coll", "credit interest", "dividends?", "zinsen", "habenzinsen", "juros", "rendimentos?", "interets", "intereses")],
  ["reimb", words("reimb\\w*", "expense claim", "exp claim", "expenses claim", "reembolso de despesas", "spesen\\w*", "auslagen\\w*", "note de frais", "per diem")],
  ["cashout", words("cashout", "cash out", "instant transfer", "transfer to bank", "withdraw to bank", "withdrawal to bank", "standard transfer", "payout to bank")],
  ["payout", words("payouts?", "settlement", "remittance")],
  ["disbursal", words("disburs\\w*", "loan proceeds", "loan credit")],
  ["deposit", words("cash deposit", "deposit at agent", "deposit of funds", "cdm", "atm deposit", "deposito em dinheiro", "bareinzahlung", "versement especes")],
  ["p2p_rail", words("send money", "sent money", "money sent", "sent to", "received from", "zelle", "venmo", "cash app", "cashapp", "pix", "faster payments?", "fps", "p2p", "p2a", "mmt", "imps", "neft", "rtgs", "transfer to", "transfer from", "trf to", "trf from", "u?e?berweisung", "virement", "transferencia", "interac", "e ?transfer", "paypal friends", "swish", "blik", "mobilepay", "vipps", "twint", "bizum", "payid", "osko", "paylah", "paynow", "promptpay", "bank transfer")],
  ["merchant_rail", words("pos", "ecom", "e com", "purchase", "pay ?bill", "buy goods", "till \\d+", "merchant", "merchant payment", "lipa na m ?pesa", "qr", "www", "com", "online", "store", "shop", "debit card", "visa", "mastercard", "rupay", "contactless", "compra", "kartenzahlung", "paiement carte", "cb", "lastschrift", "direct debit", "dd")],
  // The card that *paid* is a debit/prepaid card: "PAYMENT … DEBIT CARD" is a purchase, not a card bill.
  ["debit_card", words("debit card", "debitcard", "debit crd", "visa debit", "debit mastercard", "debit mc", "prepaid card", "cartao de debito", "cartao debito", "tarjeta de debito", "carte de debit", "girocard", "maestro")],
  // A card or cash terminal took part, so any masked number in the narration is the paying card, not a payee.
  ["card_present", words("pos", "ecom", "e com", "purchase", "contactless", "debit card", "store", "shop", "buy goods", "till \\d+", "atm", "atw", "nwd", "compra", "kartenzahlung", "paiement carte")],
];

/** Wording that names a *credit* card explicitly; it keeps a card-bill reading even next to "debit card". */
const CREDIT_CARD_NAMED = words("credit card", "creditcard", "credit crd", "cr card", "crcard", "cc", "kreditkart\\w*", "cartao de credito", "tarjeta de credito", "carte de credit");

/** Any payment wording on a credit-card credit ("ONLINE PAYMENT", "PAGAMENTO"): on a credit card that is the bill being paid. */
const PAYMENT_WORD = words("payment", "pymt", "pmt", "paymt", "autopay", "pagamento", "pago", "zahlung", "paiement");

/**
 * Legal-entity suffixes, tested on the whole narration when no party name
 * could be extracted ("NEFT DR-…-ACME PVT LTD-INV4411"). Short ambiguous ones
 * (AG, SA, NV, CO) are left to the extracted name.
 */
const LEGAL_ENTITY = words("ltd", "limited", "pvt", "llc", "llp", "inc", "corp", "corporation", "gmbh", "ltda", "eireli", "plc", "pty", "sarl");
/** The counterparty's bank named in a narration ("STATE BANK OF INDIA LTD") is not the payee. */
const BANK_ENTITY = /\bbank(?: of(?: [a-z]+){1,2})? (?:ltd|limited|plc|inc|corp|ag)\b/g;

/** Words that mark a party as an organization rather than a person. */
const BUSINESS = words("ltd", "limited", "pvt", "private", "llc", "llp", "inc", "corp", "corporation", "co", "company", "gmbh", "ag", "sa", "sas", "sarl", "ltda", "eireli", "bv", "nv", "plc", "pty", "stores?", "shop", "mart", "market", "supermarket", "restaurant", "cafe", "hotel", "services?", "enterprises?", "traders?", "trading", "industries", "solutions", "technologies", "tech", "systems", "foods?", "pharma\\w*", "medical", "hospital", "clinic", "school", "college", "university", "bank", "insurance", "finance", "financial", "capital", "holdings", "group", "international", "global", "online", "retail", "telecom", "energy", "power", "electric\\w*", "water", "gas", "airlines?", "airways", "travels?", "tours", "motors?", "automobiles", "fashion", "apparel", "electronics", "furniture", "bakery", "kitchen", "pizza", "burger", "coffee", "bar", "pub", "club", "gym", "fitness", "salon", "spa", "labs?", "studio", "media", "digital", "network", "logistics", "express", "agency", "associates", "partners", "properties", "realty", "apartments", "management", "mgmt", "clearing", "fund", "funds", "broking", "securities");

/** Tokens that are never part of a party name in a narration. */
const NAME_STOP = new Set([
  "upi", "dr", "cr", "debit", "credit", "imps", "neft", "rtgs", "nach", "ach", "p2a", "p2m", "mmt", "ref", "txn", "payment",
  "pay", "paid", "money", "send", "sent", "transfer", "trf", "to", "from", "by", "via", "mob", "mobile", "bank", "account", "acct",
  "ac", "sav", "savings", "chk", "checking", "card", "rent", "miete", "aluguel", "salary", "emi", "loan", "sip", "pix", "zelle",
  "venmo", "sepa", "uberweisung", "ueberweisung", "gutschrift", "enviado", "enviada", "recebido", "recebida", "for", "and", "the",
  "on", "at", "of", "in", "id", "no", "ending", "share", "split", "dinner", "lunch", "faster", "payments", "standing", "order",
]);
const LEADING_FILLER = new Set(["de", "da", "do", "a", "the", "mr", "mrs", "ms", "dr", "sr", "sra"]);
const MONTHS = new Set([
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "january", "february", "march", "april",
  "june", "july", "august", "september", "october", "november", "december", "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro", "januar", "februar", "marz", "juni", "juli", "oktober", "dezember",
  "enero", "febrero", "mayo", "septiembre", "octubre", "noviembre", "diciembre",
]);

/** Generic tokens that say nothing about which merchant a descriptor names. */
const MERCHANT_NOISE = new Set([
  "upi", "dr", "cr", "pos", "ach", "nach", "neft", "imps", "rtgs", "ecom", "www", "com", "net", "org", "in", "co", "ltd", "pvt",
  "inc", "llc", "the", "and", "for", "of", "to", "from", "by", "via", "on", "at", "payment", "purchase", "txn", "ref", "rev",
  "refund", "refunded", "reversal", "reversed", "return", "returned", "credit", "debit", "card", "visa", "mastercard", "rupay",
  "online", "store", "transfer", "chargeback", "estorno", "erstattung", "reembolso", "devolucao", "cancelled", "canceled",
  "cancellation", "adj", "adjustment", "merchandise", "pix", "sepa", "compra", "pagamento", "lastschrift", "gutschrift",
]);

/* ------------------------------------------------------------------ */
/* ISO 18245 merchant category codes that describe money movements      */
/* ------------------------------------------------------------------ */

type MccClass = "none" | "ordinary" | "cash" | "invest" | "tax" | "stored_value" | "money_transfer" | "rent";

const MCC_CLASSES: ReadonlyMap<string, MccClass> = new Map([
  ["6010", "cash"],
  ["6011", "cash"],
  ["6211", "invest"],
  ["9311", "tax"],
  ["6540", "stored_value"],
  ["6051", "stored_value"],
  ["4829", "money_transfer"],
  ["6536", "money_transfer"],
  ["6537", "money_transfer"],
  ["6538", "money_transfer"],
  ["6513", "rent"],
]);

function mccClassOf(mcc: string | undefined): MccClass {
  if (!mcc) return "none";
  const code = mcc.trim().padStart(4, "0");
  if (!/^\d{4}$/.test(code) || code === "0000") return "none";
  return MCC_CLASSES.get(code) ?? "ordinary";
}

/* ------------------------------------------------------------------ */
/* Views: everything reconciliation reads about one candidate          */
/* ------------------------------------------------------------------ */

type Dest = "card" | "wallet" | "brokerage" | "loan" | "account";
type Shape = "person" | "business" | "unknown";

interface PersonEvidence {
  /** Probability the other party is a person rather than a business. */
  readonly p: number;
  /** Number of features that contributed (0 = nothing known). */
  readonly evidence: number;
}

interface View {
  readonly c: TransactionCandidate;
  readonly id: CandidateId;
  readonly t: number;
  readonly direction: Direction;
  readonly amount: Money | null;
  readonly original: Money | null;
  readonly text: string;
  readonly flags: ReadonlySet<Flag>;
  readonly mccClass: MccClass;
  readonly partyName: string | null;
  readonly partyShape: Shape;
  readonly handleShape: Shape;
  readonly person: PersonEvidence;
  readonly selfMatch: boolean;
  readonly surnameMatch: boolean;
  readonly isSelf: number;
  /** Index of this leg's own instrument in ctx.ownedInstruments, or -1. */
  readonly ownedIndex: number;
  /** Index of the owned instrument the counterparty is (paying one's own account), or -1. */
  readonly targetIndex: number;
  readonly onCreditCard: boolean;
  readonly onWallet: boolean;
  readonly userType: TransactionType | null;
  /** Keys the user model may have learned this counterparty or merchant under. */
  readonly keys: readonly string[];
  /** Stable key for grouping payments to the same party. */
  readonly partyKey: string | null;
  /** Distinctive merchant words, computed once (refund matching compares many pairs). */
  readonly merchantTokens: ReadonlySet<string>;
  /** Words of the normalized merchant key, when there is one. */
  readonly keyTokens: ReadonlySet<string> | null;
}

function isReconcilable(c: TransactionCandidate): boolean {
  if (c.status === "intent" || c.status === "cancelled") return false;
  if (c.direction === "unknown") return false;
  return !isLikelyDuplicate(c);
}

function buildView(c: TransactionCandidate, ctx: ReconciliationContext): View {
  const owned = ctx.ownedInstruments;
  const direction = c.direction as Direction;
  const textSources = [c.merchant.raw, c.merchant.displayName, c.merchant.normalized, c.counterparty?.name];
  const text = normalizeText(textSources.filter((s): s is string => !!s).join(" "));
  const flags = new Set<Flag>();
  for (const [flag, re] of LEXICON) if (re.test(text)) flags.add(flag);
  // "POS PAYMENT DEBIT CARD …" matches the card-bill pattern ("payment … card"), but it names the card that paid.
  if (flags.has("cc") && flags.has("debit_card") && !CREDIT_CARD_NAMED.test(text)) flags.delete("cc");
  const mccClass = mccClassOf(c.merchant.mcc);

  const partyName = c.counterparty?.name ? normalizeText(c.counterparty.name) || null : extractPartyName(c.merchant.raw);
  const partyShape: Shape = partyName ? nameShape(partyName) : LEGAL_ENTITY.test(text.replace(BANK_ENTITY, " ")) ? "business" : "unknown";
  const handle = c.counterparty?.handle ?? c.merchant.handle ?? null;
  const handleShape = handle ? shapeOfHandle(handle) : "unknown";
  const selfMatch = matchesSelf(partyName, text, ctx.selfNames);
  const surnameMatch = !selfMatch && sharesSurname(partyName, ctx.selfNames);
  const isSelf = c.counterparty?.isSelf ?? 0;

  const ownedIndex = ownedIndexOf(c.instrument, owned);
  const ownedHere = ownedIndex >= 0 ? owned[ownedIndex] : undefined;
  // At a card or cash terminal a masked number in the narration is the paying card ("POS 5123XXXXXX1234 AMAZON").
  const atTerminal = mccClass === "ordinary" || mccClass === "cash" || c.paymentRail.family === "card" || flags.has("card_present") || flags.has("cash");
  const targetIndex = ownedTargetOf(c, ownedIndex, owned, !atTerminal);
  const onCreditCard =
    (ownedHere?.type === "card" && ownedHere.cardKind === "credit") || (c.instrument?.type === "card" && c.instrument.cardKind === "credit");
  const onWallet =
    ownedHere?.type === "wallet" ||
    c.instrument?.type === "wallet" ||
    c.instrument?.type === "mobile_money" ||
    (c.instrument?.type === "card" && c.instrument.cardKind === "prepaid");

  const keys = unique([
    c.merchant.normalized,
    c.counterparty?.handle,
    c.merchant.handle,
    c.counterparty?.handle?.toLowerCase(),
    partyName,
  ]);
  const partyKey = c.counterparty?.handle?.toLowerCase() ?? partyName ?? c.merchant.normalized ?? null;

  return {
    c,
    id: c.id,
    t: c.timestampEstimated,
    direction,
    // A zero amount (card verification, a $0 authorization) relates to nothing.
    amount: positive(c.amount?.value),
    original: positive(c.originalAmount),
    text,
    flags,
    mccClass,
    partyName,
    partyShape,
    handleShape,
    person: personEvidence(c, flags, partyName, partyShape, handleShape, mccClass),
    selfMatch,
    surnameMatch,
    isSelf,
    ownedIndex,
    targetIndex,
    onCreditCard,
    onWallet,
    userType: c.transactionType.userSet ? c.transactionType.value : null,
    keys,
    partyKey,
    merchantTokens: merchantTokenSet(c),
    keyTokens: c.merchant.normalized ? distinctiveTokens(c.merchant.normalized) : null,
  };
}

function positive(m: Money | undefined): Money | null {
  return m && m.minor > 0 ? m : null;
}

function unique(xs: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const x of xs) if (x && !out.includes(x)) out.push(x);
  return out;
}

/**
 * Pull a payee/payer name out of a narration when no counterparty field was
 * supplied: the alphabetic segment of a slash-separated narration
 * ("…/627712345678/RAHUL SHARMA/…"), or the words after "to/from/an/para".
 * Business names are returned too ("ACME PVT LTD"): their shape is evidence
 * the payment went to a merchant, which matters as much as a person's name.
 */
function extractPartyName(raw: string | null): string | null {
  if (!raw) return null;
  const segments = raw.split(/[/|*]+/).map(normalizeText).filter(Boolean);
  if (segments.length >= 3) {
    for (const seg of segments) {
      const toks = seg.split(" ");
      if (seg.length >= 4 && toks.length <= 4 && toks.every((t) => /^[a-z]+$/.test(t) && !NAME_STOP.has(t))) return seg;
    }
  }
  // "A/C" normalizes to "a c"; fold it so it stops the name like any account word.
  const text = normalizeText(raw).replace(/\ba c\b/g, "ac");
  const m = /\b(?:to|from|an|von|para|enviado|enviada|recebido|recebida)\s+([a-z]+(?:\s[a-z]+){0,5})/.exec(text);
  if (!m?.[1]) return null;
  const kept: string[] = [];
  for (const tok of m[1].split(" ")) {
    if (kept.length === 0 && LEADING_FILLER.has(tok)) continue;
    // Masked digits ("XX5678" leaves "xx") end the name.
    if (NAME_STOP.has(tok) || MONTHS.has(tok) || /^x+$/.test(tok)) break;
    kept.push(tok);
  }
  if (kept.length === 0 || kept.length > 4) return null;
  // Initials alone ("J") are not a name; "J SMITH" is.
  if (kept.every((t) => t.length <= 1)) return null;
  return kept.join(" ");
}

function nameShape(name: string | null): Shape {
  if (!name) return "unknown";
  if (BUSINESS.test(name)) return "business";
  const toks = name.split(" ");
  if (toks.length > 4 || !toks.every((t) => /^[a-z]+$/.test(t))) return "unknown";
  return "person";
}

/** Business-looking payment handles: QR/terminal/gateway prefixes and "biz" hosts. */
const BUSINESS_HANDLE_TOKEN = /^(?:q\d{6,}|\w*qr\w*|biz\w*|merchant\w*|store\w*|shop\w*|pos|rzp\w*|razorpay\w*|cashfree\w*|payu\w*|billdesk\w*|bharatpe\w*|gpay\w*|mswipe\w*|pinelabs\w*|ezetap\w*|easebuzz\w*|juspay\w*|instamojo\w*|stripe\w*|sumup\w*)$/;

function shapeOfHandle(handle: string): Shape {
  const lower = handle.toLowerCase();
  const at = lower.indexOf("@");
  const local = at >= 0 ? lower.slice(0, at) : lower;
  const host = at >= 0 ? lower.slice(at + 1) : "";
  if (/biz/.test(host) || local.split(/[^a-z0-9]+/).some((t) => BUSINESS_HANDLE_TOKEN.test(t))) return "business";
  if (/^\+?\d{8,15}$/.test(local)) return "person";
  if (/^[a-z]+(?:[._-]?[a-z]+)*\d{0,4}$/.test(local)) return "person";
  return "unknown";
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * How likely the other party is a person (P2P) rather than a business (P2M),
 * as additive log-odds over independent cues. Merchant codes and card rails
 * almost always mean a business; a personal-looking name or handle on an
 * account-to-account rail suggests a person, but small merchants paid on
 * personal handles are common, so those cues stay modest.
 */
function personEvidence(
  c: TransactionCandidate,
  flags: ReadonlySet<Flag>,
  partyName: string | null,
  partyShape: Shape,
  handleShape: Shape,
  mccClass: MccClass,
): PersonEvidence {
  let lo = 0;
  let n = 0;
  if (mccClass !== "none" && mccClass !== "money_transfer") {
    lo -= 3;
    n += 1;
  }
  const isMerchant = c.counterparty?.isMerchant;
  if (isMerchant !== undefined) {
    lo += 5 * (0.5 - isMerchant);
    n += 1;
  }
  if (handleShape !== "unknown") {
    lo += handleShape === "business" ? -2 : 0.7;
    n += 1;
  }
  if (partyShape === "business") {
    lo -= 2.5;
    n += 1;
  } else if (partyShape === "person" && partyName) {
    lo += partyName.includes(" ") ? 1.2 : 0.5;
    n += 1;
  }
  if (flags.has("p2p_rail")) {
    lo += 0.8;
    n += 1;
  }
  if (flags.has("merchant_rail")) {
    lo -= 1.2;
    n += 1;
  }
  if (c.paymentRail.family === "card") {
    lo -= 2.5;
    n += 1;
  } else if (c.paymentRail.family === "direct_debit") {
    lo -= 1.5;
    n += 1;
  }
  return { p: n === 0 ? 0.5 : sigmoid(lo), evidence: n };
}

function nameTokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => /^[a-z]+$/.test(t));
}

/** "P SHARMA" or "Priya Sharma" for self name "Priya Sharma"; also the full self name inside the narration. */
function matchesSelf(partyName: string | null, text: string, selfNames: readonly string[]): boolean {
  const padded = ` ${text} `;
  for (const self of selfNames) {
    const s = nameTokens(self);
    if (s.length === 0) continue;
    if (s.length >= 2 && padded.includes(` ${s.join(" ")} `)) return true;
    if (!partyName) continue;
    const p = nameTokens(partyName);
    if (p.length === 0) continue;
    if (p.join(" ") === s.join(" ")) return true;
    if (p.length < 2 || s.length < 2) continue;
    if (p[p.length - 1] !== s[s.length - 1]) continue;
    const pf = p[0]!;
    const sf = s[0]!;
    if (pf === sf || (pf.length === 1 && sf.startsWith(pf)) || (sf.length === 1 && pf.startsWith(sf))) return true;
  }
  return false;
}

/** Same family name as the user but a different person: a weak hint for family transfers. */
function sharesSurname(partyName: string | null, selfNames: readonly string[]): boolean {
  if (!partyName) return false;
  const p = nameTokens(partyName);
  if (p.length < 2) return false;
  const last = p[p.length - 1]!;
  return selfNames.some((self) => {
    const s = nameTokens(self);
    return s.length >= 2 && last.length >= 3 && s[s.length - 1] === last;
  });
}

/* ------------------------------------------------------------------ */
/* Owned instruments                                                    */
/* ------------------------------------------------------------------ */

const COMPATIBLE: Readonly<Record<InstrumentObservation["type"], readonly OwnedInstrument["type"][]>> = {
  card: ["card"],
  bank_account: ["bank_account", "upi_handle"],
  upi_handle: ["upi_handle", "bank_account"],
  wallet: ["wallet"],
  mobile_money: ["wallet"],
  bnpl: ["loan", "card"],
  cash: [],
  other: ["brokerage", "loan", "bank_account", "wallet"],
};

function issuersCompatible(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  const x = normalizeText(a);
  const y = normalizeText(b);
  const fx = x.split(" ")[0] ?? "";
  const fy = y.split(" ")[0] ?? "";
  return x === y || (fx.length >= 2 && fx === fy) || x.includes(y) || y.includes(x);
}

function ownedIndexOf(inst: InstrumentObservation | undefined, owned: readonly OwnedInstrument[]): number {
  if (!inst) return -1;
  for (let i = 0; i < owned.length; i++) {
    const o = owned[i]!;
    if (inst.accountRef && o.accountRef) {
      if (inst.accountRef === o.accountRef) return i;
      continue;
    }
    if (inst.last4 && o.last4 === inst.last4 && COMPATIBLE[inst.type].includes(o.type) && issuersCompatible(inst.issuer, o.issuer)) return i;
  }
  return -1;
}

/**
 * A masked account/card number in a narration: "XX5678", "**5678", "...5678",
 * "ending in 5678", "A/c 5678", "Acct #5678". A bare "#1234" is not one:
 * store and cheque numbers use it ("TARGET #1234", "CHECK #1234").
 */
const MASKED_LAST4 = /(?:x{2,}|\*{2,}|\.{2,}|…|ending(?: in)?\s|(?:a\/c|acct|account|card)(?: no\.?)?\s?#?\s?x*)\s*(\d{4})(?!\d)/gi;

/**
 * The owned instrument a debit pays into (or a credit came from), when the
 * counterparty identifies one. Masked numbers in the narration count only
 * when `readNarration` (not at a card or cash terminal, where they name the
 * paying card).
 */
function ownedTargetOf(c: TransactionCandidate, ownedIndex: number, owned: readonly OwnedInstrument[], readNarration: boolean): number {
  const handle = (c.counterparty?.handle ?? c.merchant.handle)?.toLowerCase();
  if (handle) {
    for (let i = 0; i < owned.length; i++) {
      if (i !== ownedIndex && owned[i]!.handle?.toLowerCase() === handle) return i;
    }
  }
  if (!readNarration) return -1;
  const raw = [c.merchant.raw, c.counterparty?.name, c.counterparty?.handle].filter(Boolean).join(" ");
  for (const m of raw.matchAll(MASKED_LAST4)) {
    const last4 = m[1];
    if (!last4 || last4 === c.instrument?.last4) continue;
    for (let i = 0; i < owned.length; i++) {
      if (i !== ownedIndex && owned[i]!.last4 === last4) return i;
    }
  }
  return -1;
}

function destinationOfOwned(o: OwnedInstrument): Dest {
  switch (o.type) {
    case "card":
      return o.cardKind === "prepaid" ? "wallet" : o.cardKind === "debit" ? "account" : "card";
    case "wallet":
      return "wallet";
    case "brokerage":
      return "brokerage";
    case "loan":
      return "loan";
    default:
      return "account";
  }
}

/** Where the credit leg of a pair landed decides what the pair means. */
function destinationOf(v: View, owned: readonly OwnedInstrument[]): Dest {
  if (v.onCreditCard) return "card";
  const o = v.ownedIndex >= 0 ? owned[v.ownedIndex] : undefined;
  if (o?.type === "brokerage") return "brokerage";
  if (o?.type === "loan") return "loan";
  if (v.onWallet) return "wallet";
  return "account";
}

const DEST_TYPE: Readonly<Record<Dest, readonly [TransactionType, TransferKind | undefined]>> = {
  card: ["credit_card_payment", undefined],
  wallet: ["transfer", "wallet_load"],
  brokerage: ["investment", undefined],
  loan: ["loan_payment", undefined],
  account: ["transfer", "own_account"],
};

/* ------------------------------------------------------------------ */
/* Distributions and verdicts                                           */
/* ------------------------------------------------------------------ */

type TypeDist = ReadonlyArray<readonly [TransactionType, number]>;

interface Verdict {
  readonly dist: TypeDist;
  readonly transferKind?: TransferKind;
  /** True when the verdict relates this candidate to another one (pair, refund, reimbursement). */
  readonly relational: boolean;
  readonly basis: readonly InferenceBasis[];
  readonly category?: { readonly id: CategoryId; readonly p: number };
}

function normalizeDist(dist: TypeDist): Array<[TransactionType, number]> {
  const acc = new Map<TransactionType, number>();
  for (const [t, p] of dist) if (p > 0) acc.set(t, (acc.get(t) ?? 0) + p);
  const total = [...acc.values()].reduce((s, p) => s + p, 0);
  if (total <= 0) return [["unknown", 1]];
  return [...acc].map(([t, p]): [TransactionType, number] => [t, p / total]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function mixDist(parts: ReadonlyArray<readonly [TypeDist, number]>): TypeDist {
  const out: Array<[TransactionType, number]> = [];
  for (const [dist, w] of parts) if (w > 0) for (const [t, p] of normalizeDist(dist)) out.push([t, p * w]);
  return normalizeDist(out);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function verdict(dist: TypeDist, transferKind?: TransferKind, basis: readonly InferenceBasis[] = [], category?: Verdict["category"]): Verdict {
  return {
    dist: normalizeDist(dist),
    ...(transferKind ? { transferKind } : {}),
    relational: false,
    basis,
    ...(category ? { category } : {}),
  };
}

/**
 * A keyword reading in the presence of an ordinary merchant code is less
 * trustworthy (a supermarket descriptor can contain "fee"), so part of its
 * mass moves to "purchase".
 */
function dampenForMerchant(dist: TypeDist, v: View): TypeDist {
  if (v.mccClass !== "ordinary") return dist;
  const out: Array<[TransactionType, number]> = [];
  let moved = 0;
  for (const [t, p] of normalizeDist(dist)) {
    if (t === "purchase") out.push([t, p]);
    else {
      out.push([t, p * 0.75]);
      moved += p * 0.25;
    }
  }
  out.push(["purchase", moved]);
  return out;
}

function p2pKind(v: View): TransferKind {
  return v.surnameMatch ? "family" : "p2p_other";
}

function hasOwnWords(v: View): boolean {
  return v.flags.has("own") && !v.flags.has("own_unless");
}

function rentKeyword(v: View): boolean {
  return v.flags.has("rent") && !v.flags.has("rent_goods") && (v.mccClass === "none" || v.mccClass === "rent");
}

/** What one leg says on its own: descriptor words, merchant code, rail, counterparty shape. */
function singleLegVerdict(v: View, owned: readonly OwnedInstrument[], rentPattern: boolean, walletSpendsObserved: boolean): Verdict | null {
  return v.direction === "debit" ? debitVerdict(v, owned, rentPattern, walletSpendsObserved) : creditVerdict(v);
}

function debitVerdict(v: View, owned: readonly OwnedInstrument[], rentPattern: boolean, walletSpendsObserved: boolean): Verdict | null {
  const f = v.flags;
  const kw = (dist: TypeDist, kind?: TransferKind, basis: readonly InferenceBasis[] = []) => verdict(dampenForMerchant(dist, v), kind, basis);
  // A wallet load is neutral only when BRAKE can see what the wallet later pays;
  // otherwise the load is the last observable point of the spending.
  const walletP = walletSpendsObserved ? 0.8 : 0.65;

  if (v.targetIndex >= 0) {
    const dest = destinationOfOwned(owned[v.targetIndex]!);
    const [type, kind] = DEST_TYPE[dest];
    const p = dest === "account" ? 0.75 : dest === "wallet" ? walletP : 0.85;
    return verdict([[type, p], ["purchase", 1 - p]], kind);
  }
  if (f.has("fee") && !f.has("education")) return kw([["fee", 0.85], ["purchase", 0.1], ["tax", 0.05]]);
  if (f.has("gst")) return kw([["fee", 0.7], ["tax", 0.2], ["purchase", 0.1]]);
  if (f.has("tax") || v.mccClass === "tax") return kw([["tax", 0.85], ["purchase", 0.1], ["fee", 0.05]], undefined, mccBasis(v, "tax"));
  if (f.has("cash") || v.mccClass === "cash") {
    return verdict([["cash_withdrawal", 0.92], ["purchase", 0.05], ["transfer", 0.03]], "own_account", mccBasis(v, "cash"));
  }
  // A charge *on* the credit card never pays that card's bill ("SI AUTOPAY NETFLIX CARD" is the card paying Netflix).
  if (f.has("cc") && !v.onCreditCard) return kw([["credit_card_payment", 0.88], ["transfer", 0.07], ["purchase", 0.05]], "own_account");
  if (f.has("cc_app") && !v.onCreditCard) return kw([["credit_card_payment", 0.72], ["purchase", 0.2], ["transfer", 0.08]], "own_account");
  if (f.has("loan")) return kw([["loan_payment", 0.85], ["purchase", 0.1], ["transfer", 0.05]]);
  if (f.has("invest") || v.mccClass === "invest") {
    return kw([["investment", 0.85], ["transfer", 0.1], ["purchase", 0.05]], "own_account", mccBasis(v, "invest"));
  }
  if (f.has("wallet_strong") || (f.has("wallet_weak") && f.has("wallet_context") && !f.has("airtime"))) {
    return kw([["transfer", walletP], ["purchase", 1 - walletP]], "wallet_load");
  }
  if (v.mccClass === "stored_value") return verdict([["transfer", 0.6], ["purchase", 0.4]], "wallet_load", ["source_hint"]);
  const own = ownLegProbability(v);
  if (own > 0) return verdict([["transfer", own], ["purchase", 1 - own]], "own_account");

  const rentKw = rentKeyword(v);
  if (rentKw || v.mccClass === "rent" || rentPattern) return rentVerdict(v, rentKw, rentPattern);
  if (f.has("split") && v.person.evidence > 0 && v.person.p >= 0.5) {
    return verdict([["shared_expense", 0.6], ["transfer", 0.4]], p2pKind(v));
  }
  if (v.mccClass === "money_transfer") return verdict([["transfer", 0.6], ["purchase", 0.4]], p2pKind(v), ["source_hint"]);
  if (v.person.evidence === 0) return null;
  // P2P vs P2M: never fully certain from shape alone (tutors, maids and
  // tea stalls are paid on personal handles), so transfer tops out at 0.75.
  const pTransfer = 0.05 + 0.7 * v.person.p;
  return verdict([["transfer", pTransfer], ["purchase", 1 - pTransfer]], p2pKind(v), v.mccClass === "ordinary" ? ["source_hint"] : []);
}

function mccBasis(v: View, cls: MccClass): readonly InferenceBasis[] {
  return v.mccClass === cls ? ["source_hint"] : [];
}

/** Probability a single leg moves money between the user's own accounts, from self names, isSelf and wording. */
function ownLegProbability(v: View): number {
  const ps: number[] = [];
  if (hasOwnWords(v)) ps.push(0.75);
  if (v.selfMatch) ps.push(0.72);
  if (v.isSelf >= 0.8) ps.push(0.55 + 0.3 * v.isSelf);
  if (ps.length === 0) return 0;
  return Math.min(0.88, Math.max(...ps) + 0.05 * (ps.length - 1));
}

/**
 * Rent is a purchase (housing), not a transfer, even when it is paid to a
 * person. The strongest cue is a rental merchant code or a business landlord
 * named with rent words; a person paid "rent", or a large monthly payment to
 * the same person early in the month, stays moderate with family support as
 * the alternative.
 */
function rentVerdict(v: View, rentKw: boolean, pattern: boolean): Verdict {
  const merchantish = v.person.evidence > 0 && v.person.p < 0.4;
  const p = v.mccClass === "rent" || (rentKw && merchantish) ? 0.85 : rentKw && pattern ? 0.75 : rentKw ? 0.65 : 0.6;
  const basis: InferenceBasis[] = [];
  if (pattern) basis.push("recurrence");
  if (v.mccClass === "rent") basis.push("source_hint");
  return verdict([["purchase", p], ["transfer", 1 - p]], "family", basis, { id: "housing.rent", p });
}

/** The non-spending movement a reversal credit's words name, if any. */
function reversedNeutralType(f: ReadonlySet<Flag>): TransactionType | null {
  if (f.has("cc") || f.has("cc_app")) return "credit_card_payment";
  if (f.has("loan")) return "loan_payment";
  if (f.has("invest")) return "investment";
  return null;
}

function creditVerdict(v: View): Verdict | null {
  const f = v.flags;
  // Money arriving from one of the user's own instruments (a wallet cash-out, a savings sweep).
  if (v.targetIndex >= 0) return verdict([["transfer", 0.75], ["income", 0.25]], "own_account");
  if (f.has("card_payment_credit") && (v.onCreditCard || v.c.instrument?.type === "card" || /\bthank ?you\b/.test(v.text))) {
    return verdict([["credit_card_payment", 0.9], ["refund", 0.1]]);
  }
  if (f.has("reimb")) return verdict([["reimbursement", 0.8], ["income", 0.2]]);
  if (f.has("refund")) {
    // A returned mandate or reversed payment for a movement that was never spending
    // ("NACH RTN … MF SIP", "CC PAYMENT REVERSAL") gives that movement back; it offsets no spending.
    const reversed = reversedNeutralType(f);
    if (reversed) return verdict([[reversed, 0.65], ["refund", 0.2], ["transfer", 0.15]]);
    return verdict([["refund", 0.8], ["income", 0.1], ["transfer", 0.1]]);
  }
  if (f.has("cashback")) return verdict([["refund", 0.6], ["income", 0.4]]);
  if (v.mccClass === "ordinary") return verdict([["refund", 0.75], ["income", 0.15], ["transfer", 0.1]], undefined, ["source_hint"]);
  if (f.has("salary")) return verdict([["income", 0.92], ["transfer", 0.08]]);
  if (f.has("interest")) return verdict([["income", 0.88], ["transfer", 0.12]]);
  const own = Math.max(ownLegProbability(v), f.has("cashout") ? 0.75 : 0);
  if (own > 0) return verdict([["transfer", own], ["income", 1 - own]], "own_account");
  if (f.has("invest")) return verdict([["transfer", 0.6], ["income", 0.4]], "own_account");
  if (f.has("disbursal")) return verdict([["transfer", 0.6], ["income", 0.4]], "unknown");
  if (f.has("deposit")) return verdict([["transfer", 0.7], ["income", 0.3]], "own_account");
  if (f.has("payout")) return verdict([["income", 0.6], ["transfer", 0.4]], "unknown");
  if (f.has("tax")) return verdict([["refund", 0.6], ["income", 0.4]]);
  if (v.person.evidence > 0 && v.person.p >= 0.6) {
    return verdict([["transfer", 0.6], ["income", 0.25], ["reimbursement", 0.15]], p2pKind(v));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Rent pattern: same party, ~monthly, large, around the turn of month */
/* ------------------------------------------------------------------ */

const MONTH_MS = 30.44 * DAY;

function isMonthlyGap(gap: number): boolean {
  for (let k = 1; k <= 3; k++) if (Math.abs(gap - k * MONTH_MS) <= 4 * DAY) return true;
  return false;
}

/** Day 1–10 of the month, or the last days before it (time-zone slack and early payers). */
function aroundMonthStart(t: number): boolean {
  const day = new Date(t).getUTCDate();
  return day <= 10 || day >= 28;
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function rentPatternIds(views: readonly View[]): Set<CandidateId> {
  const amountsByCurrency = new Map<string, number[]>();
  for (const v of views) {
    if (v.direction !== "debit" || !v.amount) continue;
    const list = amountsByCurrency.get(v.amount.currency) ?? [];
    list.push(v.amount.minor);
    amountsByCurrency.set(v.amount.currency, list);
  }
  for (const list of amountsByCurrency.values()) list.sort((a, b) => a - b);
  // "Large" is relative to this user's own debits, never a currency-specific threshold.
  const isLarge = (m: Money): boolean => {
    const sorted = amountsByCurrency.get(m.currency) ?? [];
    const med = median(sorted);
    if (sorted.length < 5) return m.minor >= med;
    const p75 = sorted[Math.floor(0.75 * (sorted.length - 1))]!;
    return m.minor >= 3 * med && m.minor >= p75;
  };

  const groups = new Map<string, View[]>();
  for (const v of views) {
    if (v.direction !== "debit" || !v.amount || !v.partyKey || v.mccClass !== "none") continue;
    // The pattern is for rent paid to a *person*. A monthly insurance premium or
    // utility bill to a party of unknown shape is not evidence of rent.
    if (v.person.evidence === 0 || v.person.p < 0.5) continue;
    const key = `${v.partyKey}|${v.amount.currency}`;
    const g = groups.get(key) ?? [];
    g.push(v);
    groups.set(key, g);
  }
  const out = new Set<CandidateId>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const m of g) {
      const amount = m.amount!;
      const monthly = g.some(
        (n) => n !== m && Math.abs(n.amount!.minor - amount.minor) <= 0.1 * amount.minor && isMonthlyGap(Math.abs(n.t - m.t)),
      );
      if (monthly && aroundMonthStart(m.t) && isLarge(amount)) out.add(m.id);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Amounts                                                              */
/* ------------------------------------------------------------------ */

function sameAmount(a: Money | null, b: Money | null): boolean {
  return !!a && !!b && a.currency === b.currency && Math.abs(a.minor - b.minor) <= 1;
}

/** Equal amounts, exactly or bridged through an original (pre-conversion) amount. */
function amountsBridge(a: View, b: View): { readonly fx: boolean } | null {
  if (sameAmount(a.amount, b.amount)) return { fx: false };
  if (sameAmount(a.original, b.original) || sameAmount(a.original, b.amount) || sameAmount(a.amount, b.original)) return { fx: true };
  return null;
}

/**
 * Amounts of a later credit and an earlier debit in one comparable currency.
 * Original (pre-conversion) amounts come first: a merchant refunds in its own
 * currency, while the converted amount drifts with the exchange rate.
 */
function comparableAmounts(credit: View, debit: View): { readonly credit: number; readonly debit: number } | null {
  const pairs: ReadonlyArray<readonly [Money | null, Money | null]> = [
    [credit.original, debit.original],
    [credit.amount, debit.amount],
    [credit.amount, debit.original],
    [credit.original, debit.amount],
  ];
  for (const [x, y] of pairs) if (x && y && x.currency === y.currency && y.minor > 0) return { credit: x.minor, debit: y.minor };
  return null;
}

/* ------------------------------------------------------------------ */
/* Pair helpers                                                         */
/* ------------------------------------------------------------------ */

/** First index whose time is ≥ t in a time-ordered list (binary search). */
function lowerBound(sorted: readonly View[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sameInstrument(a: View, b: View): boolean {
  if (a.ownedIndex >= 0 && a.ownedIndex === b.ownedIndex) return true;
  const ia = a.c.instrument;
  const ib = b.c.instrument;
  if (!ia || !ib) return false;
  if (ia.accountRef && ib.accountRef) return ia.accountRef === ib.accountRef;
  return !!ia.last4 && ia.last4 === ib.last4 && ia.type === ib.type;
}

/** Both legs carry the same rail reference (UPI RRN, Pix end-to-end id, ACH trace…). */
function sharedRailReference(a: View, b: View): boolean {
  return a.c.references.some(
    (r) => r.type === "rail_reference" && b.c.references.some((s) => s.type === r.type && s.namespace === r.namespace && s.value === r.value),
  );
}

function merchantLike(v: View): boolean {
  return v.mccClass === "ordinary" || (v.c.counterparty?.isMerchant ?? 0) >= 0.8 || v.handleShape === "business";
}

/** A named person on the other side who is not the user. */
function otherParty(v: View): boolean {
  return !!v.partyName && v.partyShape === "person" && !v.selfMatch && v.isSelf < 0.8;
}

function timeBonus(dt: number): number {
  return dt <= HOUR ? 1 : dt <= DAY ? 0.5 : 0;
}

const PAIR_TYPES: ReadonlySet<TransactionType> = new Set(["transfer", "credit_card_payment", "investment", "loan_payment"]);

/** A user-set type may only be paired as the kind of movement the user said it was. */
function pairable(v: View): boolean {
  if (!v.userType) return true;
  if (!PAIR_TYPES.has(v.userType)) return false;
  return !(v.userType === "transfer" && (v.c.transferKind === "family" || v.c.transferKind === "p2p_other"));
}

function userSays(v: View, type: TransactionType): boolean {
  return v.userType === type;
}

const CREDIT_NOT_TRANSFER: readonly Flag[] = ["refund", "salary", "interest", "cashback", "reimb"];
/** Debit wording that names a different kind of movement than a plain move between own accounts. */
const DEBIT_NOT_OWN_TRANSFER: readonly Flag[] = ["invest", "loan", "fee", "gst", "tax", "cash", "cc", "cc_app"];

/**
 * Probability a debit and an equal credit are one move between the user's
 * own instruments. Requires ownership evidence (both instruments owned, a
 * self name, isSelf, own-account wording or the counterparty being an owned
 * instrument). Merchants, named third parties and wording that names another
 * kind of movement count against it, because equal amounts alone are a
 * coincidence when every account is connected.
 */
function ownPairProbability(d: View, c: View, dest: Dest, dt: number, fx: boolean): number | null {
  const bothOwned = d.ownedIndex >= 0 && c.ownedIndex >= 0 && d.ownedIndex !== c.ownedIndex;
  const targetLink = (d.targetIndex >= 0 && d.targetIndex === c.ownedIndex) || (c.targetIndex >= 0 && c.targetIndex === d.ownedIndex);
  const selfName = d.selfMatch || c.selfMatch;
  const isSelf = Math.max(d.isSelf, c.isSelf);
  const ownWords = hasOwnWords(d) || hasOwnWords(c) || c.flags.has("cashout");
  const walletWords = dest === "wallet" && (d.flags.has("wallet_strong") || d.flags.has("wallet_weak"));
  const userOwn = [d, c].some((v) => v.userType === "transfer" && (v.c.transferKind === "own_account" || v.c.transferKind === "wallet_load"));
  if (!(bothOwned || targetLink || selfName || isSelf >= 0.8 || ownWords || walletWords || userOwn)) return null;

  let lo = -1;
  if (bothOwned) lo += 2.5;
  else if (d.ownedIndex >= 0 || c.ownedIndex >= 0) lo += 0.5;
  if (targetLink) lo += 3;
  if (selfName) lo += 2.5;
  if (isSelf >= 0.5) lo += 2.5 * isSelf;
  if (ownWords) lo += 1.5;
  if (walletWords) lo += 1.5;
  if (userOwn) lo += 2;
  if (sharedRailReference(d, c)) lo += 2;
  lo += timeBonus(dt);
  if (fx) lo -= 0.5;
  if (merchantLike(d) || merchantLike(c)) lo -= 3;
  if (otherParty(d) || otherParty(c)) lo -= 2.5;
  if (CREDIT_NOT_TRANSFER.some((f) => c.flags.has(f))) lo -= 3;
  if (d.onCreditCard) lo -= 2;
  // A SIP into an owned brokerage or an EMI into an owned loan account fits its destination;
  // the same words next to an unrelated credit on a savings account do not.
  if ((dest === "brokerage" && d.flags.has("invest")) || (dest === "loan" && d.flags.has("loan"))) lo += 1.5;
  else if (DEBIT_NOT_OWN_TRANSFER.some((f) => d.flags.has(f)) || rentKeyword(d)) lo -= 2.5;
  return Math.min(0.98, sigmoid(lo));
}

/**
 * Probability a bank debit is the payment that a credit on the user's credit
 * card records. Equal amounts alone are not enough: one side must say it is a
 * card-bill payment (bill-pay wording on the debit, the debit naming the
 * card, payment wording on the card credit) or the user must have said so.
 * Otherwise a merchant refund on the card would neutralize an unrelated bill.
 */
function cardPairProbability(d: View, c: View, dt: number): number | null {
  if (d.onCreditCard) return null;
  const bankSide = d.flags.has("cc") || d.flags.has("cc_app") || (d.targetIndex >= 0 && d.targetIndex === c.ownedIndex);
  const cardSide = c.flags.has("card_payment_credit") || c.flags.has("cc") || PAYMENT_WORD.test(c.text);
  const userSaid = userSays(d, "credit_card_payment") || userSays(c, "credit_card_payment");
  if (!bankSide && !cardSide && !userSaid && !sharedRailReference(d, c)) return null;
  let lo = -1;
  if (c.flags.has("card_payment_credit")) lo += 2.5;
  if (d.flags.has("cc")) lo += 2;
  else if (d.flags.has("cc_app")) lo += 1.5;
  if (d.targetIndex >= 0 && d.targetIndex === c.ownedIndex) lo += 3;
  if (c.ownedIndex >= 0) lo += 1;
  if (d.ownedIndex >= 0) lo += 0.5;
  if (c.mccClass !== "none" || c.flags.has("refund") || c.flags.has("cashback")) lo -= 4;
  if (merchantLike(d)) lo -= 3;
  if (otherParty(d)) lo -= 1;
  if (userSays(d, "credit_card_payment")) lo += 2;
  if (userSays(c, "credit_card_payment")) lo += 2;
  if (sharedRailReference(d, c)) lo += 2;
  lo += timeBonus(dt);
  if (c.t < d.t - DAY) lo -= 1;
  return Math.min(0.98, sigmoid(lo));
}

interface PairMatch {
  readonly d: View;
  readonly c: View;
  readonly p: number;
  readonly dest: Dest;
  readonly dt: number;
  readonly fx: boolean;
}

/**
 * Equal-and-opposite legs, assigned one-to-one and greedily: exact
 * same-currency matches before FX-bridged ones, then by probability, then
 * by closeness in time (a coincidental FX match one day closer must not
 * steal a leg from its exact counterpart).
 */
function findPairs(views: readonly View[], owned: readonly OwnedInstrument[], opts: Required<ReconcilerOptions>): PairMatch[] {
  const debits = views.filter((v) => v.direction === "debit" && v.amount && pairable(v));
  const credits = views.filter((v) => v.direction === "credit" && v.amount && pairable(v));
  const maxWindow = Math.max(opts.transferWindowMs, opts.cardPaymentWindowMs);
  const found: PairMatch[] = [];
  for (const d of debits) {
    // Views are time-ordered, so only the credits inside the window are visited.
    for (let i = lowerBound(credits, d.t - maxWindow); i < credits.length && credits[i]!.t <= d.t + maxWindow; i++) {
      const c = credits[i]!;
      const dt = Math.abs(c.t - d.t);
      if (sameInstrument(d, c)) continue;
      const bridge = amountsBridge(d, c);
      if (!bridge) continue;
      const dest = destinationOf(c, owned);
      if (dt > (dest === "card" ? opts.cardPaymentWindowMs : opts.transferWindowMs)) continue;
      const p = dest === "card" ? cardPairProbability(d, c, dt) : ownPairProbability(d, c, dest, dt, bridge.fx);
      if (p === null || p < opts.linkThreshold) continue;
      found.push({ d, c, p, dest, dt, fx: bridge.fx });
    }
  }
  found.sort(
    (a, b) =>
      Number(a.fx) - Number(b.fx) || b.p - a.p || a.dt - b.dt || a.d.id.localeCompare(b.d.id) || a.c.id.localeCompare(b.c.id),
  );
  const used = new Set<CandidateId>();
  const out: PairMatch[] = [];
  for (const m of found) {
    if (used.has(m.d.id) || used.has(m.c.id)) continue;
    used.add(m.d.id);
    used.add(m.c.id);
    out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Refunds                                                              */
/* ------------------------------------------------------------------ */

function distinctiveTokens(text: string): Set<string> {
  return new Set(normalizeText(text).split(" ").filter((t) => t.length >= 3 && !/\d/.test(t) && !MERCHANT_NOISE.has(t)));
}

function merchantTokenSet(c: TransactionCandidate): Set<string> {
  return distinctiveTokens([c.merchant.normalized, c.merchant.displayName, c.merchant.raw].filter(Boolean).join(" "));
}

/**
 * Card descriptors cut names at a fixed width ("MERCADOLIVR"), so a prefix
 * that is long enough and covers most of the word is the same word.
 * "STAR" is not "STARBUCKS", and "APPLE" is not "APPLEBEES".
 */
function truncationOf(x: string, y: string): boolean {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && short.length / long.length >= 0.6 && long.startsWith(short);
}

function tokenOverlap(ta: ReadonlySet<string>, tb: ReadonlySet<string>, allowTruncation: boolean): number {
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const x of ta) {
    for (const y of tb) {
      if (x === y || (allowTruncation && truncationOf(x, y))) {
        shared += 1;
        break;
      }
    }
  }
  return shared / Math.min(ta.size, tb.size);
}

/**
 * Same merchant: equal normalized keys, or descriptor word overlap. When both
 * candidates carry a normalized key and the keys differ, the merchant
 * normalizer has already said "different merchants"; only the keys' own words
 * are compared then ("amazon" / "amazon_pay"), never loose descriptor text.
 */
function merchantSimilarity(a: View, b: View): number {
  const ka = a.c.merchant.normalized;
  const kb = b.c.merchant.normalized;
  if (ka && kb) return ka === kb ? 1 : tokenOverlap(a.keyTokens ?? new Set(), b.keyTokens ?? new Set(), false);
  return tokenOverlap(a.merchantTokens, b.merchantTokens, true);
}

/**
 * Index keys under which a refund can meet its original: the normalized key,
 * each merchant word cut to five letters (the shortest prefix
 * `truncationOf` accepts, so truncated descriptors share a key), and rail
 * references. Every pair `merchantSimilarity` or a shared reference could
 * accept shares at least one key, so the index only skips hopeless pairs.
 */
function refundIndexKeys(v: View): string[] {
  const keys: string[] = [];
  if (v.c.merchant.normalized) keys.push(`k:${v.c.merchant.normalized}`);
  for (const t of v.merchantTokens) keys.push(`w:${t.slice(0, 5)}`);
  for (const r of v.c.references) if (r.type === "rail_reference") keys.push(`r:${r.namespace ?? ""}:${r.value}`);
  return keys;
}

const REFUNDABLE_TYPES: ReadonlySet<TransactionType> = new Set(["purchase", "subscription", "fee", "tax", "shared_expense", "business_expense"]);
const SPENDING_LIKE = REFUNDABLE_TYPES;
const SHAREABLE_TYPES: ReadonlySet<TransactionType> = new Set(["purchase", "subscription", "shared_expense", "business_expense"]);

/** The type belief before relating candidates: the user's label, else the more confident of this module's reading and a classifier's. */
function priorType(v: View, base: Verdict | null): { readonly type: TransactionType; readonly p: number } | null {
  if (v.userType) return { type: v.userType, p: 1 };
  const own = base ? { type: normalizeDist(base.dist)[0]![0], p: normalizeDist(base.dist)[0]![1] } : null;
  const existing = v.c.transactionType;
  const foreign = isForeignInformed(existing) ? { type: existing.value, p: existing.confidence } : null;
  if (own && foreign) return foreign.p > own.p ? foreign : own;
  return own ?? foreign;
}

function isForeignInformed(inf: Inference<TransactionType>): boolean {
  return !inf.userSet && inf.confidence > 0 && inf.value !== "unknown" && !inf.basis.includes("reconciliation") && !inf.basis.includes("none");
}

function refundableOriginal(v: View, base: Verdict | null): boolean {
  if (v.direction !== "debit" || !v.amount) return false;
  const prior = priorType(v, base);
  if (!prior) return true;
  if (v.userType) return REFUNDABLE_TYPES.has(v.userType);
  return REFUNDABLE_TYPES.has(prior.type) || prior.p < 0.6;
}

/** What an original debit most likely was: the user's label, else the more confident of this module's reading and a classifier's. */
function originalTypeDist(v: View, base: Verdict | null): TypeDist {
  if (v.userType) return [[v.userType, 1]];
  const existing = v.c.transactionType;
  const ownTop = base ? normalizeDist(base.dist)[0]![1] : 0;
  if (isForeignInformed(existing) && (!base || existing.confidence > ownTop)) {
    return [[existing.value, existing.confidence], ...existing.alternatives.map((a): readonly [TransactionType, number] => [a.value, a.probability])];
  }
  return base?.dist ?? [["purchase", 1]];
}

/** Movements that, given back, are the same movement reversed rather than a refund of spending. */
const REVERSED_AS_ITSELF: ReadonlySet<TransactionType> = new Set(["transfer", "investment", "loan_payment", "credit_card_payment", "cash_withdrawal"]);

/**
 * Giving back a purchase is a refund (it offsets spending); giving back a
 * transfer, SIP, EMI, card-bill payment or cash withdrawal is that movement
 * reversed (it offsets nothing). An ambiguous original keeps its ambiguity.
 */
function reversalDist(original: TypeDist): TypeDist {
  return original.map(([t, p]): readonly [TransactionType, number] => [REVERSED_AS_ITSELF.has(t) ? t : "refund", p]);
}

function refundableCredit(v: View): boolean {
  if (v.direction !== "credit" || !v.amount) return false;
  if (v.userType && v.userType !== "refund") return false;
  const f = v.flags;
  if (f.has("salary") || f.has("interest") || f.has("card_payment_credit") || f.has("reimb") || f.has("cashout") || f.has("deposit")) return false;
  if (v.selfMatch || v.isSelf >= 0.8 || v.targetIndex >= 0) return false;
  // A person sending money back is not a merchant refund unless the narration says so.
  return !(v.person.evidence > 0 && v.person.p >= 0.7 && !f.has("refund"));
}

interface RefundState {
  /** Fraction of the original already refunded. */
  fraction: number;
  /** The original's amount in the unit the fractions were measured in (minor units). */
  readonly debitMinor: number;
  readonly probabilities: number[];
}

/** Float slack for comparing sums of fractions against "within one minor unit". */
const MINOR_EPSILON = 1e-6;

function refundProbability(r: View, o: View, similarity: number, exactFull: boolean, completes: boolean, dt: number): number {
  const keysEqual = !!r.c.merchant.normalized && r.c.merchant.normalized === o.c.merchant.normalized;
  let lo = -1.5;
  lo += keysEqual ? 3 : 3 * similarity - 0.5;
  if (sharedRailReference(r, o)) lo += 4;
  if (r.flags.has("refund")) lo += 2;
  if (exactFull) lo += 1.5;
  else if (completes) lo += 1;
  if (dt <= 30 * DAY) lo += 0.5;
  if (r.flags.has("cashback")) lo -= 2;
  if (userSays(r, "refund")) lo += 2;
  return Math.min(0.98, sigmoid(lo));
}

interface RefundMatch {
  readonly refund: View;
  readonly original: View;
  readonly p: number;
}

/**
 * Credits from the merchant of an earlier purchase, amount ≤ what is left
 * to refund, within the window. Each refund links to exactly one original:
 * an exact-amount, not-yet-refunded, most recent one first. Several partial
 * refunds may share an original until together they cover it.
 *
 * A movement that was never spending (card bill, EMI, SIP, transfer) can be
 * given back too — a returned mandate, a failed payment reversed — but only
 * in full, soon, and with reversal wording or the same rail reference, since
 * there is no purchase to anchor the match.
 */
function matchRefunds(
  views: readonly View[],
  baselines: ReadonlyMap<CandidateId, Verdict | null>,
  taken: ReadonlySet<CandidateId>,
  opts: Required<ReconcilerOptions>,
): { readonly matches: RefundMatch[]; readonly fullyRefunded: Set<CandidateId> } {
  const originals = views.filter((v) => !taken.has(v.id) && v.direction === "debit" && !!v.amount);
  const refundable = new Set(originals.filter((v) => refundableOriginal(v, baselines.get(v.id) ?? null)).map((v) => v.id));
  const refunds = views.filter((v) => !taken.has(v.id) && refundableCredit(v));
  const lookBack = Math.max(opts.refundWindowMs, opts.reversalWindowMs);
  const state = new Map<CandidateId, RefundState>();
  const matches: RefundMatch[] = [];

  // Originals by merchant word/key/reference; each bucket keeps the views' time order.
  const index = new Map<string, View[]>();
  for (const o of originals) {
    for (const key of refundIndexKeys(o)) {
      const bucket = index.get(key);
      if (bucket) bucket.push(o);
      else index.set(key, [o]);
    }
  }
  /** Originals that share a merchant word, key or reference with the credit, inside the refund window before it. */
  const plausibleOriginals = (r: View): View[] => {
    const seen = new Set<CandidateId>();
    const found: View[] = [];
    for (const key of refundIndexKeys(r)) {
      const bucket = index.get(key) ?? [];
      for (let i = lowerBound(bucket, r.t - lookBack); i < bucket.length && bucket[i]!.t <= r.t; i++) {
        const o = bucket[i]!;
        if (!seen.has(o.id)) {
          seen.add(o.id);
          found.push(o);
        }
      }
    }
    return found;
  };

  for (const r of refunds) {
    const options: Array<{ o: View; p: number; exact: boolean; fresh: boolean; dt: number; fraction: number; debitMinor: number }> = [];
    for (const o of plausibleOriginals(r)) {
      const dt = r.t - o.t;
      if (o.id === r.id) continue;
      const reversal = !refundable.has(o.id);
      if (dt > (reversal ? opts.reversalWindowMs : opts.refundWindowMs)) continue;
      if (reversal && !(r.flags.has("refund") || sharedRailReference(r, o))) continue;
      const amounts = comparableAmounts(r, o);
      if (!amounts) continue;
      const s = state.get(o.id);
      if (reversal && s) continue;
      const done = s?.fraction ?? 0;
      const remainingMinor = (1 - done) * amounts.debit;
      if (amounts.credit > remainingMinor + 1 + MINOR_EPSILON) continue;
      const similarity = merchantSimilarity(r, o);
      if (similarity < 0.6 && !sharedRailReference(r, o)) continue;
      const exactFull = Math.abs(amounts.credit - amounts.debit) <= 1;
      if (reversal && !exactFull) continue;
      const completes = Math.abs(amounts.credit - remainingMinor) <= 1 + MINOR_EPSILON;
      const p = refundProbability(r, o, similarity, exactFull, completes, dt);
      if (p < opts.linkThreshold) continue;
      options.push({ o, p, exact: exactFull || completes, fresh: !s, dt, fraction: amounts.credit / amounts.debit, debitMinor: amounts.debit });
    }
    options.sort(
      (a, b) => Number(b.exact) - Number(a.exact) || Number(b.fresh) - Number(a.fresh) || a.dt - b.dt || a.o.id.localeCompare(b.o.id),
    );
    const best = options[0];
    if (!best) continue;
    const s = state.get(best.o.id) ?? { fraction: 0, debitMinor: best.debitMinor, probabilities: [] };
    s.fraction += best.fraction;
    s.probabilities.push(best.p);
    state.set(best.o.id, s);
    matches.push({ refund: r, original: best.o, p: best.p });
  }

  // Fully refunded when what is left is at most one minor unit. Compared in minor units with
  // slack, because "fraction ≥ 1 − 1/amount" fails in floating point for amounts like 4599.
  const fullyRefunded = new Set<CandidateId>();
  for (const [id, s] of state) {
    const leftMinor = (1 - s.fraction) * s.debitMinor;
    if (leftMinor <= 1 + MINOR_EPSILON && s.probabilities.every((p) => p >= opts.refundedStatusThreshold)) fullyRefunded.add(id);
  }
  return { matches, fullyRefunded };
}

/* ------------------------------------------------------------------ */
/* Reimbursements and shared expenses                                   */
/* ------------------------------------------------------------------ */

interface ReimbursementMatch {
  readonly credit: View;
  readonly purchase: View;
  /** Probability the credit is a reimbursement at all. */
  readonly pType: number;
  /** Probability it reimburses this particular purchase. */
  readonly pLink: number;
  /** 1 = the whole amount (an expense paid back), k ≥ 2 = a 1/k share. */
  readonly k: number;
}

function reimbursingCredit(v: View): boolean {
  if (v.direction !== "credit" || !v.amount) return false;
  if (v.userType && v.userType !== "reimbursement") return false;
  const f = v.flags;
  const blocked: readonly Flag[] = ["salary", "interest", "refund", "cashback", "card_payment_credit", "cashout", "deposit", "disbursal", "payout", "invest", "tax"];
  if (blocked.some((x) => f.has(x))) return false;
  if (v.selfMatch || v.isSelf >= 0.8 || v.targetIndex >= 0 || hasOwnWords(v)) return false;
  if (v.mccClass !== "none" && v.mccClass !== "money_transfer") return false;
  return (v.person.evidence > 0 && v.person.p >= 0.6) || f.has("reimb") || f.has("split");
}

function shareablePurchase(v: View, base: Verdict | null, refunded: ReadonlySet<CandidateId>): boolean {
  if (v.direction !== "debit" || !v.amount || v.c.status === "refunded" || refunded.has(v.id)) return false;
  if (v.userType) return SHAREABLE_TYPES.has(v.userType);
  const prior = priorType(v, base);
  return !prior || SHAREABLE_TYPES.has(prior.type) || prior.p < 0.5;
}

/** Smallest k for which the credit is a 1/k share of the purchase (k = 1 only when the narration says "reimbursement"). */
function shareDivisor(credit: number, purchase: number, allowWhole: boolean, opts: Required<ReconcilerOptions>): number | null {
  for (let k = allowWhole ? 1 : 2; k <= opts.maxShareDivisor; k++) {
    if (Math.abs(credit * k - purchase) <= opts.shareTolerance * purchase) return k;
  }
  return null;
}

/** People settle a split together: paybacks for one bill arrive within about a week of each other. */
const SETTLE_UP_SPAN_MS = 7 * DAY;

/**
 * Person-to-person credits after a purchase that look like shares of it.
 * Pass 1 links credits that are a clean 1/k share (closest purchase first).
 * Pass 2 lets further credits from *other* people join a purchase that
 * already has a share-matched payback, while the total stays ≤ the purchase
 * and they arrive within a week of that payback (a gift weeks later is not
 * part of the split).
 * Pass 3 accepts, at low probability, two or more paybacks from different
 * people that arrive close together and sum to a sizeable part of one purchase.
 */
function matchReimbursements(
  views: readonly View[],
  baselines: ReadonlyMap<CandidateId, Verdict | null>,
  taken: ReadonlySet<CandidateId>,
  refunded: ReadonlySet<CandidateId>,
  opts: Required<ReconcilerOptions>,
): ReimbursementMatch[] {
  // Both lists keep the views' time order, which the windowed loops below rely on.
  const credits = views.filter((v) => !taken.has(v.id) && reimbursingCredit(v));
  const purchases = views.filter((v) => !taken.has(v.id) && shareablePurchase(v, baselines.get(v.id) ?? null, refunded));
  const remaining = new Map(purchases.map((p) => [p.id, p.amount!.minor] as const));
  const parties = new Map<CandidateId, Set<string>>();
  /** When the first share-matched payback for a purchase arrived. */
  const anchoredAt = new Map<CandidateId, number>();
  const claimed = new Set<CandidateId>();
  const out: ReimbursementMatch[] = [];
  const W = opts.reimbursementWindowMs;
  const inWindow = (cr: View, pu: View) => cr.t - pu.t >= 0 && cr.t - pu.t <= W && cr.amount!.currency === pu.amount!.currency;
  /** Purchases in the window before a credit, oldest first. */
  const purchasesBefore = (cr: View): View[] => {
    const found: View[] = [];
    for (let i = lowerBound(purchases, cr.t - W); i < purchases.length && purchases[i]!.t <= cr.t; i++) found.push(purchases[i]!);
    return found;
  };
  const claim = (cr: View, pu: View, pType: number, pLink: number, k: number) => {
    claimed.add(cr.id);
    remaining.set(pu.id, (remaining.get(pu.id) ?? 0) - cr.amount!.minor);
    const set = parties.get(pu.id) ?? new Set<string>();
    set.add(cr.partyKey ?? cr.id);
    parties.set(pu.id, set);
    out.push({ credit: cr, purchase: pu, pType, pLink, k });
  };

  // Pass 1: clean shares.
  for (const cr of credits) {
    const fits: Array<{ pu: View; k: number; dt: number }> = [];
    for (const pu of purchasesBefore(cr)) {
      if (!inWindow(cr, pu)) continue;
      if (cr.amount!.minor > (remaining.get(pu.id) ?? 0) + 1) continue;
      const k = shareDivisor(cr.amount!.minor, pu.amount!.minor, cr.flags.has("reimb"), opts);
      if (k !== null) fits.push({ pu, k, dt: cr.t - pu.t });
    }
    fits.sort((a, b) => a.dt - b.dt || a.k - b.k || a.pu.id.localeCompare(b.pu.id));
    const best = fits[0];
    if (!best) continue;
    const words = cr.flags.has("split") || cr.flags.has("reimb") ? 0.1 : 0;
    const pType = Math.min(0.85, (best.k <= 4 ? 0.7 : best.k <= 6 ? 0.6 : 0.5) + words);
    // Several purchases fit equally well: the credit is still a payback, but which one is less certain.
    const pLink = pType / Math.sqrt(fits.length);
    if (pLink >= opts.reimbursementLinkThreshold) {
      claim(cr, best.pu, pType, pLink, best.k);
      if (!anchoredAt.has(best.pu.id)) anchoredAt.set(best.pu.id, cr.t);
    }
  }

  // Pass 2: other people joining an anchored split, settled around the same time.
  for (const cr of credits) {
    if (claimed.has(cr.id)) continue;
    const options = purchasesBefore(cr)
      .filter((pu) => anchoredAt.has(pu.id) && inWindow(cr, pu) && Math.abs(cr.t - anchoredAt.get(pu.id)!) <= SETTLE_UP_SPAN_MS)
      .filter((pu) => cr.amount!.minor <= (remaining.get(pu.id) ?? 0) + 1 && !parties.get(pu.id)!.has(cr.partyKey ?? cr.id))
      .sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
    const pu = options[0];
    if (pu) claim(cr, pu, 0.5, 0.45, 0);
  }

  // Pass 3: unanchored paybacks from several people (newest purchase first, so each credit goes to the closest one before it).
  const unanchored = purchases.filter((pu) => !parties.has(pu.id)).sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
  for (const pu of unanchored) {
    const group: View[] = [];
    const seen = new Set<string>();
    let sum = 0;
    for (let i = lowerBound(credits, pu.t); i < credits.length && credits[i]!.t <= pu.t + W; i++) {
      const cr = credits[i]!;
      if (claimed.has(cr.id) || !inWindow(cr, pu)) continue;
      const party = cr.partyKey ?? cr.id;
      if (seen.has(party) || sum + cr.amount!.minor > pu.amount!.minor) continue;
      if (group.length > 0 && cr.t - group[0]!.t > SETTLE_UP_SPAN_MS) break;
      group.push(cr);
      seen.add(party);
      sum += cr.amount!.minor;
    }
    if (group.length >= 2 && sum * 3 >= pu.amount!.minor) for (const cr of group) claim(cr, pu, 0.5, 0.4, 0);
  }
  return out.filter((m) => m.pLink >= opts.reimbursementLinkThreshold);
}

/* ------------------------------------------------------------------ */
/* User model                                                           */
/* ------------------------------------------------------------------ */

function topEntry<T extends string>(d: Distribution<T>): { readonly value: T; readonly probability: number } | null {
  let best: { readonly value: T; readonly probability: number } | null = null;
  for (const e of d.entries) if (!best || e.probability > best.probability) best = e;
  return best;
}

/** What the user has taught BRAKE about this counterparty/merchant, by the key with the most evidence. */
function userOpinion(v: View, model: UserModel) {
  let types: Distribution<TransactionType> | null = null;
  let kinds: Distribution<TransferKind> | null = null;
  for (const key of v.keys) {
    const t = model.typeFor(key);
    if (t && t.evidence > 0 && t.entries.length > 0 && (!types || t.evidence > types.evidence)) types = t;
    const k = model.transferKindFor(key);
    if (k && k.evidence > 0 && k.entries.length > 0 && (!kinds || k.evidence > kinds.evidence)) kinds = k;
  }
  return { types, kinds };
}

function toInference(dist: TypeDist, basis: readonly InferenceBasis[]): Inference<TransactionType> {
  const [top, ...rest] = normalizeDist(dist);
  const [value, confidence] = top!;
  return {
    value,
    confidence: round3(confidence),
    alternatives: rest.filter(([, p]) => p >= 0.005).map(([t, p]) => ({ value: t, probability: round3(p) })),
    basis: unique(["reconciliation", ...basis]) as InferenceBasis[],
    userSet: false,
  };
}

/** Blend the heuristic verdict with the user's own answers: w = n / (n + k), k doubled for structural matches. */
function finalize(v: View, ver: Verdict, model: UserModel, opts: Required<ReconcilerOptions>) {
  const { types, kinds } = userOpinion(v, model);
  let dist = ver.dist;
  const basis = [...ver.basis];
  let kind = ver.transferKind;
  if (types) {
    const k = ver.relational ? 2 * opts.userModelPseudoCount : opts.userModelPseudoCount;
    const w = types.evidence / (types.evidence + k);
    const learned: TypeDist = types.entries.map((e) => [e.value, e.probability] as const);
    dist = mixDist([
      [dist, 1 - w],
      [learned, w],
    ]);
    basis.push("user_history");
  }
  const learnedKind = kinds ? topEntry(kinds) : null;
  if (kinds && learnedKind && learnedKind.value !== "unknown" && (!ver.relational || kinds.evidence >= 3)) {
    kind = learnedKind.value;
    if (!basis.includes("user_history")) basis.push("user_history");
  }
  const inference = toInference(dist, basis);
  return { inference, kind };
}

/* ------------------------------------------------------------------ */
/* Assembly                                                             */
/* ------------------------------------------------------------------ */

interface Draft {
  relational?: Verdict;
  readonly links: CandidateLink[];
  status?: "refunded";
  ownership?: Inference<Ownership>;
}

function relationalVerdict(p: number, related: TypeDist, kind: TransferKind | undefined, base: Verdict | null, direction: Direction): Verdict {
  // If the relation is wrong, the leg means what it means on its own.
  const fallback: TypeDist = base?.dist ?? (direction === "debit" ? [["purchase", 1]] : [["unknown", 1]]);
  return {
    dist: mixDist([
      [related, p],
      [fallback, 1 - p],
    ]),
    ...(kind ? { transferKind: kind } : base?.transferKind ? { transferKind: base.transferKind } : {}),
    relational: true,
    basis: base?.basis ?? [],
  };
}

function sameInference<T extends string>(a: Inference<T>, b: Inference<T>): boolean {
  if (a.value !== b.value || a.userSet !== b.userSet || Math.abs(a.confidence - b.confidence) >= 0.01) return false;
  if (a.alternatives.length !== b.alternatives.length) return false;
  return a.alternatives.every((x, i) => {
    const y = b.alternatives[i];
    return !!y && y.value === x.value && Math.abs(y.probability - x.probability) < 0.01;
  });
}

function linkKey(l: CandidateLink): string {
  return `${l.kind}|${l.target}`;
}

function sameLinks(a: readonly CandidateLink[], b: readonly CandidateLink[]): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((l) => [linkKey(l), l] as const));
  return a.every((l) => {
    const other = byKey.get(linkKey(l));
    return !!other && Math.abs(other.probability - l.probability) < 0.01;
  });
}

type MutablePatch = { -readonly [K in keyof CandidatePatch]?: CandidatePatch[K] };

function unknownType(): Inference<TransactionType> {
  return { value: "unknown", confidence: 0, alternatives: [], basis: ["none"], userSet: false };
}

function assemble(
  v: View,
  base: Verdict | null,
  draft: Draft | undefined,
  ctx: ReconciliationContext,
  opts: Required<ReconcilerOptions>,
): CandidatePatch | null {
  const c = v.c;
  const patch: MutablePatch = {};
  const ver = draft?.relational ?? base;
  /** The type the candidate ends up with: the user's, the classifier's, or this module's. */
  let effective: Inference<TransactionType> = c.transactionType;

  if (!c.transactionType.userSet) {
    if (ver) {
      const { inference, kind } = finalize(v, ver, ctx.userModel, opts);
      const existing = c.transactionType;
      // A classifier that is at least as sure from its own evidence keeps its
      // reading of a single leg, and "paid a merchant, so a purchase" adds
      // nothing to a more specific spending type (subscription, fee…).
      // Relations between candidates are new evidence a classifier cannot have.
      const deferToClassifier =
        !ver.relational &&
        isForeignInformed(existing) &&
        (existing.confidence >= inference.confidence || (inference.value === "purchase" && SPENDING_LIKE.has(existing.value)));
      if (!deferToClassifier) {
        if (!sameInference(inference, existing)) patch.transactionType = inference;
        if (inference.value === "transfer" && kind && kind !== c.transferKind) patch.transferKind = kind;
        effective = inference;
      } else if (existing.value === "transfer" && inference.value === "transfer" && kind && (!c.transferKind || c.transferKind === "unknown")) {
        patch.transferKind = kind;
      }
    } else if (c.transactionType.basis.includes("reconciliation")) {
      // This module's earlier reading no longer holds (a leg or original was removed).
      effective = unknownType();
      patch.transactionType = effective;
    }
  }

  // Rent: a category only reconciliation can see (pattern across months).
  if (ver?.category && effective.value === "purchase" && !c.category.userSet && !userTaughtOtherCategory(v, ctx.userModel, ver.category.id)) {
    const p = round3(Math.min(ver.category.p, effective.confidence));
    const ex = c.category;
    const replaceable = ex.basis.includes("reconciliation") || ex.confidence < p;
    if (replaceable && !(ex.value === ver.category.id && Math.abs(ex.confidence - p) < 0.01)) {
      patch.category = { value: ver.category.id, confidence: p, alternatives: [], basis: unique(["reconciliation", ...ver.basis]) as InferenceBasis[], userSet: false };
    }
  } else if (!c.category.userSet && c.category.basis.includes("reconciliation")) {
    // This module's earlier rent reading no longer holds (the user taught "family", a month dropped out…):
    // hand the category back uninformed rather than leave "Rent" on a family transfer.
    patch.category = { value: UNCATEGORIZED, confidence: 0, alternatives: [], basis: ["none"], userSet: false };
  }

  const links = (draft?.links ?? []).map((l) => {
    const prior = c.links.find((x) => linkKey(x) === linkKey(l));
    return prior ? { ...l, createdAt: prior.createdAt } : l;
  });
  const ownedLinks = c.links.filter((l) => RECONCILIATION_LINK_KINDS.has(l.kind));
  if (!sameLinks(links, ownedLinks)) patch.links = links;

  if (draft?.status === "refunded" && c.status !== "refunded") patch.status = "refunded";

  const own = c.attributes.ownership;
  if (!own.userSet) {
    if (draft?.ownership) {
      const replaceable = own.basis.includes("reconciliation") || own.basis.includes("none") || own.confidence < draft.ownership.confidence;
      if (replaceable && !sameInference(draft.ownership, own)) patch.attributes = { ownership: draft.ownership };
    } else if (own.basis.includes("reconciliation")) {
      patch.attributes = { ownership: { value: "personal", confidence: 0, alternatives: [], basis: ["none"], userSet: false } };
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function userTaughtOtherCategory(v: View, model: UserModel, category: CategoryId): boolean {
  for (const key of v.keys) {
    const d = model.categoryFor(key);
    const top = d && d.evidence >= 1 ? topEntry(d) : null;
    if (top && top.value !== category) return true;
  }
  return false;
}

function sharedOwnership(pType: number, k: number): Inference<Ownership> {
  // Never more certain than ~0.6 without the user saying so.
  const p = round3(Math.min(0.6, pType));
  const value: Ownership = k === 1 ? "reimbursable" : "shared";
  return { value, confidence: p, alternatives: [{ value: "personal", probability: round3(1 - p) }], basis: ["reconciliation"], userSet: false };
}

function reconcileAll(
  candidates: readonly TransactionCandidate[],
  ctx: ReconciliationContext,
  opts: Required<ReconcilerOptions>,
): ReconciliationResult {
  const owned = ctx.ownedInstruments;
  const views = candidates
    .filter(isReconcilable)
    .map((c) => buildView(c, ctx))
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  const rentIds = rentPatternIds(views);
  const walletSpendsObserved = views.some((v) => v.direction === "debit" && v.onWallet);
  const baselines = new Map<CandidateId, Verdict | null>();
  for (const v of views) baselines.set(v.id, singleLegVerdict(v, owned, rentIds.has(v.id), walletSpendsObserved));

  const drafts = new Map<CandidateId, Draft>();
  const draftOf = (id: CandidateId): Draft => {
    let d = drafts.get(id);
    if (!d) {
      d = { links: [] };
      drafts.set(id, d);
    }
    return d;
  };
  const link = (from: View, kind: CandidateLinkKind, to: View, p: number) => {
    draftOf(from.id).links.push({ kind, target: to.id, probability: round3(p), createdAt: ctx.now });
  };
  const taken = new Set<CandidateId>();

  // 1. Equal-and-opposite legs between the user's own instruments.
  for (const m of findPairs(views, owned, opts)) {
    const [type, kind] = DEST_TYPE[m.dest];
    draftOf(m.d.id).relational = relationalVerdict(m.p, [[type, 1]], kind, baselines.get(m.d.id) ?? null, "debit");
    draftOf(m.c.id).relational = relationalVerdict(m.p, [[type, 1]], kind, baselines.get(m.c.id) ?? null, "credit");
    if (m.dest === "card") link(m.d, "card_payment_for", m.c, m.p);
    else link(m.d, "transfer_counterpart", m.c, m.p);
    link(m.c, "transfer_counterpart", m.d, m.p);
    taken.add(m.d.id);
    taken.add(m.c.id);
  }

  // 2. Refunds of earlier purchases, and reversals of movements that were never spending.
  const { matches: refunds, fullyRefunded } = matchRefunds(views, baselines, taken, opts);
  for (const m of refunds) {
    const o = m.original;
    const oBase = baselines.get(o.id) ?? null;
    const given = reversalDist(originalTypeDist(o, oBase));
    const kind = o.userType ? o.c.transferKind : (oBase?.transferKind ?? o.c.transferKind);
    draftOf(m.refund.id).relational = relationalVerdict(m.p, given, kind, baselines.get(m.refund.id) ?? null, "credit");
    link(m.refund, "refund_of", m.original, m.p);
    link(m.original, "refunded_by", m.refund, m.p);
    taken.add(m.refund.id);
  }
  for (const id of fullyRefunded) draftOf(id).status = "refunded";

  // 3. Paybacks for shared purchases.
  for (const m of matchReimbursements(views, baselines, taken, fullyRefunded, opts)) {
    draftOf(m.credit.id).relational = relationalVerdict(m.pType, [["reimbursement", 1]], undefined, baselines.get(m.credit.id) ?? null, "credit");
    link(m.credit, "reimbursement_of", m.purchase, m.pLink);
    const d = draftOf(m.purchase.id);
    const ownership = sharedOwnership(m.pType, m.k);
    if (!d.ownership || d.ownership.confidence < ownership.confidence) d.ownership = ownership;
  }

  const patches = new Map<CandidateId, CandidatePatch>();
  for (const v of views) {
    const patch = assemble(v, baselines.get(v.id) ?? null, drafts.get(v.id), ctx, opts);
    if (patch) patches.set(v.id, patch);
  }
  return { patches };
}
