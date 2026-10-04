import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterResult,
  CountryCode,
  Direction,
  InstrumentObservation,
  MerchantChannel,
  MerchantObservation,
  Observation,
  RawSignal,
  Reference,
  SignalAdapter,
  SourceRef,
  SpendWindow,
  TransactionStatus,
  TypeHint,
} from "@brake/core";
import {
  contentKey,
  describeMoney,
  isRecord,
  measuredInstant,
  mccHints,
  normalizeCurrency,
  normalizeMcc,
  parseDecimalAmount,
  parseInstant,
  scrubDescriptor,
  stageWord,
  text,
} from "./ledger-mapping";
import { observationId } from "./shared/text";

/**
 * Card-linked transaction events -> observations.
 *
 * The payload is BRAKE's normalized card-linked webhook, modelled on Fidel
 * API's Select Transactions object (Fidel docs source, select/transactions.md;
 * docs/research/02 §C1): `id`, `amount` (major units; refunds are negative on
 * both their auth and clearing events), `currency`, `datetime` (local time at
 * the location, no offset — `location.timezone` gives the zone), `auth`,
 * `cleared`, `cardPresent`, `authCode`, `card{id, firstNumbers, lastNumbers,
 * scheme}`, `brand{name}`, `descriptor{merchantName, storeName}`,
 * `merchantCategoryCode`, `location{…, countryCode (alpha-3), timezone}`,
 * `identifiers{visaAuthCode, mastercardAuthCode, mastercardRefNumber,
 * amexApprovalCode, MID, …}`, `refundTransactionId` / `originalTransactionId`.
 * A plain `merchant{name, mcc, address}` object is accepted for feeds that
 * already normalize merchants.
 *
 * Lifecycle: an `auth` event arrives seconds after the tap (in-spend,
 * pending); `cleared` arrives 48–72 h later (post-spend, posted). The
 * transaction `id` is the same on both, so they share a provider id and fuse.
 *
 * Coverage caveat: card-linked programmes only see enrolled merchants, so
 * silence from this feed is never evidence of no spending.
 */

export interface CardFeedCard {
  readonly id: string;
  /** BIN. Never copied into an observation (with last4 it narrows the PAN). */
  readonly firstNumbers?: string;
  readonly lastNumbers?: string;
  /** visa | mastercard | amex */
  readonly scheme?: string;
}

export interface CardFeedLocation {
  readonly id?: string;
  readonly address?: string;
  readonly city?: string;
  /** ISO 3166-1 alpha-3 in Fidel ("GBR"); alpha-2 also accepted. */
  readonly countryCode?: string;
  readonly postcode?: string;
  /** IANA zone of the location ("Europe/London"). */
  readonly timezone?: string;
}

export interface CardFeedIdentifiers {
  readonly MID?: string | null;
  readonly amexApprovalCode?: string | null;
  readonly mastercardAuthCode?: string | null;
  readonly mastercardRefNumber?: string | null;
  readonly mastercardTransactionSequenceNumber?: string | null;
  readonly visaAuthCode?: string | null;
}

export interface CardFeedEvent {
  /** Webhook event name when the relay passes it ("transaction.auth", "transaction.clearing", "transaction.refund"). */
  readonly event?: string;
  readonly id: string;
  /** Major units; negative for refunds. */
  readonly amount: number | string;
  readonly currency: string;
  /** Local time at the location ("2026-10-03T19:42:10"), or ISO 8601 with an offset. */
  readonly datetime: string;
  /** When the provider created the record (UTC). */
  readonly created?: string;
  readonly auth: boolean;
  readonly cleared: boolean;
  readonly cardPresent?: boolean | null;
  readonly authCode?: string | null;
  readonly approvalCode?: string | null;
  readonly refundTransactionId?: string | null;
  readonly originalTransactionId?: string | null;
  readonly card: CardFeedCard;
  readonly merchant?: { readonly name: string; readonly mcc?: string | number | null; readonly address?: string | null } | null;
  readonly brand?: { readonly id?: string; readonly name?: string } | null;
  readonly descriptor?: { readonly merchantName?: string | null; readonly storeName?: string | null } | null;
  readonly merchantCategoryCode?: string | number | null;
  readonly location?: CardFeedLocation | null;
  readonly identifiers?: CardFeedIdentifiers | null;
  /** apple_pay | google_pay | samsung_pay … */
  readonly wallet?: string | null;
  readonly programId?: string;
  readonly accountId?: string;
  /** Card-linking service behind the feed, as configured by the relay ("Fidel API"). */
  readonly provider?: string;
}

/** ISO 3166-1 alpha-3 -> alpha-2 for the markets card-linked programmes cover (data pack). */
const ALPHA3: Readonly<Record<string, CountryCode>> = {
  USA: "US", GBR: "GB", IRL: "IE", CAN: "CA", SWE: "SE", ARE: "AE", JPN: "JP", AUS: "AU", NZL: "NZ", FRA: "FR",
  DEU: "DE", ESP: "ES", ITA: "IT", NLD: "NL", BEL: "BE", PRT: "PT", AUT: "AT", CHE: "CH", NOR: "NO", DNK: "DK",
  FIN: "FI", POL: "PL", SGP: "SG", HKG: "HK", IND: "IN", BRA: "BR", MEX: "MX", ZAF: "ZA", SAU: "SA", ISR: "IL",
};

const ADAPTER_ID = "card-feed";

const DESCRIPTOR: AdapterDescriptor = {
  id: ADAPTER_ID,
  kind: "card_feed",
  displayName: "Card-linked transaction feed",
  windows: ["in_spend", "post_spend"],
  platforms: ["server"],
  requiresCapabilities: ["data:card-linked-feed"],
  privacy: {
    sensitivity: "high",
    dataCategories: ["purchases on your linked card at participating merchants (amount, merchant, time)", "the last four digits of the card"],
    processing: "server",
  },
};

export function createCardFeedAdapter(): SignalAdapter<CardFeedEvent> {
  return {
    descriptor: DESCRIPTOR,
    parse(signal: RawSignal<CardFeedEvent>, ctx: AdapterContext): AdapterResult {
      const p = signal.payload as unknown;
      if (!isRecord(p) || !isRecord(p.card)) return { status: "rejected", reason: "card feed event needs an object with a card" };
      const e = p as unknown as CardFeedEvent;
      const id = text(e.id);
      const cardId = text(e.card.id);
      const currency = normalizeCurrency(e.currency) ?? normalizeCurrency(ctx.defaultCurrency);
      const amount = currency ? parseDecimalAmount(e.amount, currency) : null;
      if (!id || !cardId || !amount) return { status: "rejected", reason: "card feed event needs id, card.id, amount and currency" };

      const refund = amount.negative || /refund/i.test(text(e.event) ?? "");
      const direction: Direction = refund ? "credit" : "debit";
      const cleared = e.cleared === true || /clear/i.test(text(e.event) ?? "");
      const stage: TransactionStatus = cleared ? "posted" : "pending";
      // An authorization arrives seconds after the tap; a clearing record days later.
      const window: SpendWindow = cleared || refund ? "post_spend" : "in_spend";

      const scheme = text(e.card.scheme)?.toLowerCase();
      const last4 = text(e.card.lastNumbers);
      const instrument: InstrumentObservation = {
        type: "card",
        accountRef: cardId,
        ...(last4 && /^\d{4}$/.test(last4) ? { last4 } : {}),
        ...(scheme ? { network: scheme } : {}),
      };
      const merchant = merchantFor(e);
      const location = isRecord(e.location) ? e.location : undefined;
      const occurredAt = occurredAtFor(e, location, ctx);
      const country = countryOf(location?.countryCode) ?? ctx.country;

      const references: Reference[] = [{ type: "provider_transaction_id", value: id, namespace: `card-feed:${cardId}` }];
      const ids = isRecord(e.identifiers) ? e.identifiers : undefined;
      const authCode = text(e.authCode) ?? text(ids?.visaAuthCode) ?? text(ids?.mastercardAuthCode) ?? text(ids?.amexApprovalCode) ?? text(e.approvalCode);
      // Auth codes are short and reused, so fusion uses them as a supporting feature, not an event id.
      if (authCode) references.push({ type: "auth_code", value: authCode.toUpperCase(), namespace: scheme ?? "card" });
      const banknet = text(ids?.mastercardRefNumber);
      if (banknet && scheme === "mastercard") references.push({ type: "rail_reference", value: banknet, namespace: "mastercard" });

      const typeHints: TypeHint[] = refund
        ? [{ type: "refund", confidence: 0.9, reason: "card_feed:refund" }]
        : [{ type: "purchase", confidence: 0.7, reason: "card_feed:card_purchase" }];

      const provider = text(e.provider);
      const cardLabel = `${scheme ? `${capitalize(scheme)} ` : ""}card${instrument.last4 ? ` ••${instrument.last4}` : ""}`;
      const source: SourceRef = {
        adapterId: ADAPTER_ID,
        kind: "card_feed",
        connectionId: signal.connectionId,
        label: `${cardLabel} linked to BRAKE${provider ? ` (via ${provider})` : ""}`,
        ...(provider ? { provider } : {}),
      };
      const who = merchant?.name ?? merchant?.raw;
      const summary =
        `The card network reported a ${refund ? `${stageWord(stage)} refund` : `${stageWord(stage)} payment`} of ${describeMoney(amount.money, ctx.locale)}` +
        (who ? ` ${refund ? "from" : "at"} ${who}` : "") +
        ` on your ${cardLabel}.`;

      const observation: Observation = {
        // auth and clearing share `id`: the stage and amount make each lifecycle event its own observation.
        id: observationId(ADAPTER_ID, signal.connectionId, `txn:${id}#${contentKey(stage, direction, amount.money.minor, amount.money.currency)}`),
        source,
        kind: "money_movement",
        window,
        stage,
        receivedAt: signal.receivedAt,
        ...(occurredAt ? { occurredAt } : {}),
        direction,
        amount: { value: amount.money, confidence: cleared ? 0.99 : 0.95 },
        ...(merchant ? { merchant } : {}),
        instrument,
        rail: { family: "card", ...(scheme ? { scheme } : {}) },
        ...(country ? { country } : {}),
        references,
        ...(merchant?.mcc ? { categoryHints: mccHints(merchant.mcc) } : {}),
        typeHints,
        confidence: 0.95,
        evidence: { summary },
      };
      return { status: "observations", observations: [observation] };
    },
  };
}

function merchantFor(e: CardFeedEvent): MerchantObservation | undefined {
  const m = isRecord(e.merchant) ? e.merchant : undefined;
  const descriptor = isRecord(e.descriptor) ? e.descriptor : undefined;
  const brand = isRecord(e.brand) ? e.brand : undefined;
  const raw = scrubDescriptor(descriptor?.merchantName) ?? scrubDescriptor(m?.name) ?? scrubDescriptor(brand?.name) ?? scrubDescriptor(descriptor?.storeName);
  if (!raw) return undefined;
  const name = scrubDescriptor(brand?.name) ?? scrubDescriptor(m?.name) ?? scrubDescriptor(descriptor?.storeName);
  const mcc = normalizeMcc(m?.mcc ?? e.merchantCategoryCode);
  const channel: MerchantChannel | undefined = e.cardPresent === true ? "in_store" : e.cardPresent === false ? "online" : undefined;
  return {
    raw,
    ...(name ? { name } : {}),
    ...(mcc ? { mcc } : {}),
    ...(channel ? { channel } : {}),
    // Network-grade merchant identity from an enrolled location.
    confidence: 0.95,
  };
}

function occurredAtFor(e: CardFeedEvent, location: CardFeedLocation | undefined, ctx: AdapterContext): Observation["occurredAt"] {
  const zone = text(location?.timezone);
  const local = parseInstant(e.datetime, { timeZone: zone ?? ctx.timeZone ?? "UTC" });
  // Without the location's zone, a local wall-clock time is only approximately placed.
  if (local) return measuredInstant(local, zone || /[zZ]|[+-]\d{2}:?\d{2}$/.test(e.datetime) ? 0.95 : 0.7);
  const created = parseInstant(e.created);
  return created ? measuredInstant(created, 0.8) : undefined;
}

function countryOf(code: unknown): CountryCode | undefined {
  const c = text(code)?.toUpperCase();
  if (!c) return undefined;
  if (/^[A-Z]{2}$/.test(c)) return c;
  return ALPHA3[c];
}

function capitalize(s: string): string {
  return s === "amex" ? "Amex" : s.charAt(0).toUpperCase() + s.slice(1);
}
