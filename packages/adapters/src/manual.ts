import { DAY, isOneTimePasswordMessage, parseAmount, redactSensitive } from "@brake/core";
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CategoryHint,
  CountryCode,
  CurrencyCode,
  EpochMillis,
  MerchantObservation,
  Money,
  Observation,
  RawSignal,
  SignalAdapter,
  SourceRef,
} from "@brake/core";
import { detectCurrency, extractAmount, normalizeWhitespace, observationId } from "./shared/text";
import { summaryMoney } from "./upi";

/**
 * User-authored inputs: the "Should I buy this?" check (widgets, controls,
 * share/paste front doors), manual spend logging (cash, unconnected cards,
 * users with no connected accounts) and voice (Siri App Intents and similar).
 *
 * The user typed it, so facts are reliable but not infallible (typos,
 * recall): spent entries carry confidence 0.9, below a templated bank alert.
 * Purchase likelihood of an intent is learned elsewhere and never folded into
 * observation confidence (docs/research/08-manual-and-pre-spend-surfaces.md §1, §4, §18).
 */

export type ManualMode = "should_i_buy" | "spent" | "voice";

export interface ManualInput {
  readonly mode: ManualMode;
  /** As typed ("24,900", "₹24,900", "about 2.5k"). */
  readonly amount?: string;
  readonly currency?: string;
  readonly merchant?: string;
  readonly note?: string;
  /** BRAKE category id ("eating_out.cafe"). */
  readonly category?: string;
  readonly at: EpochMillis;
  /** Transcribed voice request ("should I buy AirPods for 24,900"). */
  readonly utterance?: string;
}

const ADAPTER_ID = "manual";
const EXCERPT_TTL = 7 * DAY;

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "manual",
  displayName: "Your own entries",
  windows: ["pre_spend", "post_spend"],
  platforms: ["android", "ios", "web", "desktop"],
  requiresCapabilities: [],
  privacy: {
    sensitivity: "low",
    dataCategories: ["amounts, merchants and notes you type or say to BRAKE"],
    processing: "on_device",
  },
};

/** BRAKE taxonomy ids, copied from intelligence/taxonomy.ts (adapters must not import intelligence). */
const BRAKE_CATEGORIES: ReadonlySet<string> = new Set([
  "groceries", "eating_out", "eating_out.restaurant", "eating_out.delivery", "eating_out.cafe",
  "shopping", "shopping.electronics", "shopping.clothing", "shopping.online_marketplace",
  "household", "personal_care", "health", "bills", "bills.utilities", "bills.phone_internet", "bills.insurance",
  "housing", "housing.rent", "transport", "transport.fuel", "transport.public", "transport.rideshare",
  "entertainment", "entertainment.streaming", "entertainment.events", "entertainment.gaming",
  "travel", "travel.flights", "travel.lodging", "education", "gifts", "donations", "pets", "fees", "taxes", "other",
]);

/* ------------------------------------------------------------------ */
/* Utterance grammar (data)                                            */
/* ------------------------------------------------------------------ */

/** Openers of a "should I buy …?" question (en, pt, es). */
const ASK_LEADS: readonly RegExp[] = [
  /^(?:hey\s+\w+[,!]?\s+)?(?:should|shall|can|could|may)\s+i\s+(?:really\s+|actually\s+|still\s+)?(?:buy|get|order|purchase|afford|book)\s+/i,
  /^(?:is\s+it\s+(?:ok|okay|fine|wise|smart|a\s+good\s+idea)\s+(?:to|if\s+i)\s+(?:buy|get|order|purchase|book))\s+/i,
  /^(?:i(?:'m|\s+am)?\s+)?(?:thinking\s+(?:of|about)|planning\s+(?:to|on)|about\s+to|want(?:ing)?\s+to|wanna|would\s+like\s+to)\s+(?:buy(?:ing)?|get(?:ting)?|order(?:ing)?|purchas(?:e|ing)|book(?:ing)?)\s+/i,
  /^(?:ask\s+brake\s+about|check|what\s+about)\s+(?:buying\s+)?/i,
  /^(?:devo|posso|deveria)\s+comprar\s+/i,
  /^(?:debo|puedo|deber[ií]a)\s+comprar\s+/i,
];

/** Openers of a past spend ("I spent 450 on lunch at Subway"). */
const SPENT_LEADS: readonly RegExp[] = [
  /^(?:i\s+)?(?:just\s+)?(?:spent|paid)\s+/i,
  /^(?:i\s+)?(?:just\s+)?(?:bought|ordered|purchased)\s+/i,
  /^(?:log|add|record)\s+(?:an?\s+)?(?:expense|purchase|spend|payment)\s*(?:of\s+)?/i,
  /^(?:eu\s+)?(?:gastei|paguei|comprei)\s+/i,
  /^(?:gast[eé]|pagu[eé]|compr[eé])\s+/i,
];

const APPROXIMATE = /\b(?:about|around|roughly|approx(?:imately)?|almost|nearly|maybe|under|over|or\s+so|ish|cerca\s+de|mais\s+ou\s+menos|aproximadamente|unos|unas)\b|~/i;

/** Spoken multipliers. "mil" is Portuguese/Spanish for thousand ("2 mil reais"). */
const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3, grand: 1e3, mil: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, million: 1e6,
};

/** Spoken currency words -> a marker the shared detector resolves (country-aware for "$"/"Rs"/"kr"). */
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  rupee: "Rs", rupees: "Rs", rs: "Rs", dollar: "$", dollars: "$", bucks: "$", euro: "€", euros: "€", reais: "R$", real: "R$",
  pound: "£", pounds: "£", quid: "£", rand: "ZAR", naira: "₦", shilling: "KSh", shillings: "KSh", baht: "฿", ringgit: "RM", yen: "¥",
  pesos: "$", peso: "$",
};

/** Words after a number that make it a spec, not a price ("55 inch", "256 GB", "iPhone 16 Pro"). */
const UNIT_AFTER = /^\s*(?:inch(?:es)?|in\b|"|gb|tb|mb|mm|cm|m\b|kg|g\b|ml|l\b|pack|pcs|pieces|hp|w\b|mp|th\b|st\b|nd\b|rd\b|years?|months?|days?|hours?|pro\b|max\b|plus\b|ultra\b|mini\b|x\b|%)/i;

/** Words before a number that make it a price. */
const PRICE_BEFORE = /(?:\bfor|\bat|\bcosting|\bcosts?|\bworth|\bprice(?:d)?|\bof|\bis|\bspent|\bpaid|\bpay|\bpor|\bpara|\bde|\babout|\baround|\bunder|~)\s*$/i;

const MERCHANT_PHRASE = /\s+(?:from|on|at|via|na|no|em|en)\s+((?:[A-Z0-9][\w&'’.-]*)(?:\s+[A-Z][\w&'’.-]*)*)/;

const ARTICLES = /^(?:a|an|the|some|um|uma|un|una|o|os|as|el|la|los|las)\s+/i;

export interface ParsedUtterance {
  readonly intent: "should_i_buy" | "spent" | "unknown";
  readonly title?: string;
  readonly merchant?: string;
  readonly amount?: Money;
  readonly approximate: boolean;
}

interface NumberCandidate {
  readonly start: number;
  readonly end: number;
  readonly money: Money;
  readonly score: number;
}

/**
 * Parse a spoken request: "should I buy AirPods for 24,900", "can I afford a
 * trip to Goa for 40k", "I spent 450 on lunch at Subway", "devo comprar um
 * tênis por 300 reais". Currency comes from a spoken marker/word, else
 * `defaultCurrency`; without either, the amount is left out.
 */
export function parseUtterance(
  utterance: string,
  opts: { readonly defaultCurrency?: CurrencyCode; readonly country?: CountryCode } = {},
): ParsedUtterance {
  let text = normalizeWhitespace(utterance).replace(/[?!.]+$/, "").replace(/\s*,?\s*(?:please|por favor)$/i, "");
  let intent: ParsedUtterance["intent"] = "unknown";
  for (const re of ASK_LEADS) {
    if (re.test(text)) {
      text = text.replace(re, "");
      intent = "should_i_buy";
      break;
    }
  }
  if (intent === "unknown") {
    for (const re of SPENT_LEADS) {
      if (re.test(text)) {
        text = text.replace(re, "");
        intent = "spent";
        break;
      }
    }
  }
  // After a spent lead the first number is the price ("450 on lunch at Subway").
  const best = pickAmount(text, opts, intent === "spent");
  const approximate = APPROXIMATE.test(utterance);
  if (best) {
    // Peel stacked price words ("for about", "costing around").
    let before = text.slice(0, best.start);
    for (let k = 0; k < 3 && PRICE_BEFORE.test(before); k++) before = before.replace(PRICE_BEFORE, "");
    text = `${before} ${text.slice(best.end)}`;
  }
  text = text.replace(/\b(?:about|around|roughly|approx(?:imately)?|maybe|or\s+so|ish)\b/gi, " ");
  let merchant: string | undefined;
  const m = MERCHANT_PHRASE.exec(` ${text}`);
  if (m?.[1]) {
    merchant = m[1].trim();
    text = ` ${text}`.replace(m[0], " ");
  }
  const title = normalizeWhitespace(text)
    .replace(/^(?:on|for|in|em|no|na|en)\s+/i, "")
    .replace(ARTICLES, "")
    .replace(/[\s,;:-]+$/, "")
    .trim();
  return {
    intent,
    ...(title && /\p{L}/u.test(title) ? { title } : {}),
    ...(merchant ? { merchant } : {}),
    ...(best ? { amount: best.money } : {}),
    approximate,
  };
}

function pickAmount(
  text: string,
  opts: { readonly defaultCurrency?: CurrencyCode; readonly country?: CountryCode },
  firstIsPrice: boolean,
): NumberCandidate | null {
  const candidates: NumberCandidate[] = [];
  // Currency-marked amounts first ("₹29,990", "R$ 1.899", "$80").
  const marked = extractAmount(text, opts);
  if (marked) candidates.push({ start: marked.index, end: marked.index + marked.raw.length, money: marked.money, score: 5 });

  const re = /(?<![\w.,-])(\d[\d,.]*\d|\d)(?:\s*(k|thousand|grand|mil|lakhs?|lacs?|crores?|cr|million)\b)?(?:\s*(rupees?|rs|dollars?|bucks|euros?|reais|real|pounds?|quid|rand|naira|shillings?|baht|ringgit|yen|pesos?)\b)?(?![\w-])/gi;
  for (const mm of text.matchAll(re)) {
    const start = mm.index ?? 0;
    if (marked && start >= marked.index && start < marked.index + marked.raw.length) continue;
    const end = start + mm[0].length;
    const word = mm[3]?.toLowerCase();
    const marker = word ? CURRENCY_WORDS[word] : undefined;
    const currency = (marker ? detectCurrency(marker, opts) : null) ?? opts.defaultCurrency;
    if (!currency) continue;
    const base = parseAmount(mm[1] ?? "", currency);
    if (!base) continue;
    const mult = mm[2] ? MULTIPLIERS[mm[2].toLowerCase()] ?? 1 : 1;
    let score = 0;
    if (marker) score += 3;
    if (mult > 1) score += 2;
    if (PRICE_BEFORE.test(text.slice(0, start))) score += 2;
    if (/[,.]/.test(mm[1] ?? "")) score += 1;
    if (firstIsPrice && candidates.length === (marked ? 1 : 0) && start === firstNumberIndex(text)) score += 2;
    if (!marker && mult === 1 && UNIT_AFTER.test(text.slice(end))) score -= 4;
    candidates.push({ start, end, money: { minor: Math.round(base.minor * mult), currency: base.currency }, score });
  }
  const sorted = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || b.start - a.start);
  return sorted[0] ?? null;
}

function firstNumberIndex(text: string): number {
  return /\d/.exec(text)?.index ?? -1;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export function createManualAdapter(): SignalAdapter<ManualInput> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<ManualInput>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload;
      if (!p || typeof p !== "object") return { status: "rejected", reason: "payload missing" };
      if (p.mode !== "should_i_buy" && p.mode !== "spent" && p.mode !== "voice") return { status: "rejected", reason: `unknown mode ${String(p.mode)}` };
      const freeText = [p.utterance, p.note, p.merchant].filter((t): t is string => typeof t === "string").join("\n");
      if (freeText && isOneTimePasswordMessage(freeText)) return { status: "ignored", reason: "otp" };
      const at = Number.isFinite(p.at) ? p.at : signal.receivedAt;

      const typedCurrency = typeof p.currency === "string" && /^[A-Za-z]{3}$/.test(p.currency.trim()) ? p.currency.trim().toUpperCase() : undefined;
      const currencyDefault = typedCurrency ?? ctx.defaultCurrency;
      const typed = typeof p.amount === "string" && p.amount.trim() ? typedAmount(p.amount, typedCurrency, ctx) : null;

      const spoken =
        p.mode === "voice" && typeof p.utterance === "string" && p.utterance.trim()
          ? parseUtterance(p.utterance, { ...(currencyDefault ? { defaultCurrency: currencyDefault } : {}), ...(ctx.country ? { country: ctx.country } : {}) })
          : null;
      if (p.mode === "voice" && !spoken && !typed) return { status: "rejected", reason: "voice input without an utterance" };

      // Typed/structured fields (e.g. App Intent parameters) win over what was parsed from speech.
      const amount = typed?.money ?? spoken?.amount;
      const approximate = typed ? typed.approximate : spoken?.approximate ?? false;
      const merchantName = cleanText(p.merchant) ?? spoken?.merchant;
      const title = cleanText(p.note) ?? spoken?.title;
      const spent = p.mode === "spent" || spoken?.intent === "spent";
      const fromVoice = p.mode === "voice";

      const category = cleanText(p.category);
      const categoryHints: CategoryHint[] = category
        ? BRAKE_CATEGORIES.has(category)
          ? [{ scheme: "brake", value: category, confidence: spent ? 0.95 : 0.9 }]
          : [{ scheme: "keyword", value: category.toLowerCase(), confidence: 0.6 }]
        : [];
      const merchant: MerchantObservation | undefined = merchantName
        ? { raw: merchantName, name: merchantName, channel: "unknown", confidence: spent ? 0.8 : 0.7 }
        : undefined;

      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "manual",
        connectionId: signal.connectionId,
        label: fromVoice ? "voice request" : spent ? "manual entry" : "“Should I buy this?” check",
      };
      const id = observationId(ADAPTER_ID, signal.connectionId, `${p.mode}|${at}|${p.amount ?? ""}|${p.merchant ?? ""}|${p.note ?? ""}|${p.utterance ?? ""}`);
      const amountText = amount ? `${approximate ? "about " : ""}${summaryMoney(amount, ctx.locale)}` : undefined;
      // Speech recognition mangles numbers more often than a keypad does.
      const amountConfidence = typed ? 0.9 : 0.8;
      const utteranceExcerpt =
        fromVoice && p.utterance ? { excerpt: redactSensitive(normalizeWhitespace(p.utterance)).text.slice(0, 200), excerptExpiresAt: signal.receivedAt + EXCERPT_TTL } : {};

      if (spent) {
        if (!amount) return { status: "rejected", reason: "a spent entry needs an amount" };
        const observation: Observation = {
          id,
          source,
          kind: "money_movement",
          window: "post_spend",
          stage: "confirmed",
          receivedAt: signal.receivedAt,
          // The user picks or accepts the time; "earlier today" entries are approximate.
          occurredAt: { value: at, confidence: 0.8 },
          direction: "debit",
          amount: { value: amount, confidence: amountConfidence, ...(approximate ? { approximate: true } : {}) },
          ...(merchant ? { merchant } : {}),
          references: [],
          ...(categoryHints.length > 0 ? { categoryHints } : {}),
          typeHints: [{ type: "purchase", confidence: 0.6, reason: "manual:spent" }],
          confidence: fromVoice ? 0.8 : 0.9,
          evidence: {
            summary: `You ${fromVoice ? "told BRAKE you spent" : "added"} ${amountText}${merchantName ? ` at ${merchantName}` : ""}${title ? ` (${title})` : ""}.`,
            ...utteranceExcerpt,
          },
        };
        return { status: "observations", observations: [observation] };
      }

      if (!amount && !merchantName && !title) return { status: "rejected", reason: "nothing to check: no amount, merchant or item" };
      const observation: Observation = {
        id,
        source,
        kind: "purchase_intent",
        window: "pre_spend",
        stage: "intent",
        receivedAt: signal.receivedAt,
        occurredAt: { value: at, confidence: 0.95 },
        direction: "debit",
        ...(amount ? { amount: { value: amount, confidence: amountConfidence, approximate } } : {}),
        ...(merchant ? { merchant } : {}),
        references: [],
        ...(categoryHints.length > 0 ? { categoryHints } : {}),
        intent: { via: fromVoice ? "voice" : "should_i_buy", ...(title ? { title } : {}) },
        confidence: fromVoice ? 0.8 : 0.9,
        evidence: {
          summary: `You asked BRAKE about ${title ?? "a purchase"}${merchantName ? ` from ${merchantName}` : ""}${amountText ? ` for ${amountText}` : ""}.`,
          ...utteranceExcerpt,
        },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

function cleanText(v: string | undefined): string | undefined {
  const t = typeof v === "string" ? normalizeWhitespace(v) : "";
  return t === "" ? undefined : t;
}

/** A keypad amount: currency marker in the text, else the typed currency, else the user's default. */
function typedAmount(text: string, currency: CurrencyCode | undefined, ctx: AdapterContext): { money: Money; approximate: boolean } | null {
  const approximate = APPROXIMATE.test(text);
  const marked = extractAmount(text, ctx);
  if (marked) return { money: marked.money, approximate };
  const resolved = currency ?? ctx.defaultCurrency;
  if (!resolved) return null;
  const k = /(\d[\d.,]*)\s*(k|lakh|lakhs|lac|crore|cr|mil)\b/i.exec(text);
  if (k) {
    const base = parseAmount(k[1] ?? "", resolved);
    const mult = MULTIPLIERS[(k[2] ?? "").toLowerCase()] ?? 1;
    return base ? { money: { minor: Math.round(base.minor * mult), currency: base.currency }, approximate } : null;
  }
  const money = parseAmount(text, resolved);
  return money && money.minor > 0 ? { money, approximate } : null;
}
