-- =============================================================================
-- BRAKE schema: the persistence port (packages/core/src/store.ts) on Supabase.
--
-- What lives here, and why so little:
--   Processing (parsing, fusion, classification, learning) runs on the device
--   (ADR-004). The database is an account / multi-device sync / backup store
--   for the *source of truth* only (ADR-002): consent, extracted observations,
--   the user's assertions and preferences, and learning-loop bookkeeping.
--   TransactionCandidates are derived and are deliberately NOT stored: any
--   device rebuilds them deterministically, and a disconnect needs to purge
--   only observations.
--
-- What must never live here (brief, PRIVACY PRINCIPLE): raw payloads (SMS or
-- email bodies, provider JSON), OTPs, full card/account numbers. Adapters drop
-- or redact those on the device; the constraints and triggers below are
-- defence in depth, so a buggy client cannot quietly widen what is stored.
--
-- Access model (Supabase realism): hosted Supabase grants anon, authenticated
-- and service_role ALL on every new table and function in schema public. So
-- every user table here (a) enables row-level security, (b) has policies only
-- for `authenticated`, keyed on user_id = (select auth.uid()) in both USING and
-- WITH CHECK, and (c) explicitly revokes the default grants from anon and
-- re-grants authenticated only the commands it needs (never TRUNCATE, which
-- bypasses row-level security, nor REFERENCES/TRIGGER). service_role keeps
-- full access (it bypasses RLS) for operational tooling.
--
-- Every user table:
--   * has user_id uuid not null references auth.users(id) on delete cascade,
--     so deleting the auth account deletes everything about the user;
--   * defaults user_id to auth.uid(), so clients need not send it (RLS still
--     rejects any other value);
--   * keys rows by (user_id, id): ids are namespaces per user, so an id chosen
--     by one user can never collide with, or reveal, another user's row;
--   * declares its id-like text columns (ids, connection ids, anchors)
--     collate "C": listings and the observation keyset cursor order ties by
--     these ids, and every device must see the same order as the in-memory
--     reference store (code point order) whatever default collation the
--     project's cluster was created with (a linguistic one such as en_US
--     sorts "obs_B" between "obs_a" and "obs-c"). Ids are opaque, so a
--     byte-order comparison is also the only meaningful one, and the fastest.
--     Columns compared with each other (observations.id with anchors,
--     connection_id with its foreign key) must share it.
-- =============================================================================

-- Supabase's PostgREST does not expose this schema; it holds internals that
-- must never be callable through the API (retention job, trigger helpers).
create schema if not exists private;
revoke all on schema private from public;
-- Functions are executable by PUBLIC by default; nothing in private should be.
alter default privileges in schema private revoke execute on functions from public;

-- ------------------------------------------------------------ helpers -----

/** Luhn checksum over a 13-19 digit string (the shape of a full card number). */
create or replace function private.luhn_valid(p_digits text)
returns boolean
language sql
immutable strict parallel safe
set search_path = ''
as $$
  select p_digits ~ '^[0-9]{13,19}$'
     and (
       select sum(
                case when (length(p_digits) - i) % 2 = 1
                     then case when d * 2 > 9 then d * 2 - 9 else d * 2 end
                     else d
                end
              ) % 10 = 0
       from generate_series(1, length(p_digits)) as i,
            lateral (select substr(p_digits, i, 1)::int as d) as digit
     )
$$;

/**
 * True when the text contains what looks like a full card number: a Luhn-valid
 * digit run bounded by non-word characters (the same boundary rule as the
 * adapters' redactSensitive), either contiguous (13-19 digits) or in a printed
 * card layout (4-4-4-4[-1..3], or 4-6-4/5 for Amex/Diners) with spaces/dashes.
 * Other separated groupings are not joined: "408-1234567-1234567" is an order
 * number, not a card. Masked numbers ("••••1234", "XX1234") and 12-digit UPI
 * RRNs never match.
 */
create or replace function private.contains_card_number(p_text text)
returns boolean
language sql
immutable strict parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from (values
      ('\y[0-9]{13,19}\y'),
      ('\y[0-9]{4}(?:[ -][0-9]{4}){3}(?:[ -][0-9]{1,3})?\y'),
      ('\y[0-9]{4}[ -][0-9]{6}[ -][0-9]{4,5}\y')
    ) as shapes(re)
    cross join lateral regexp_matches(p_text, shapes.re, 'g') as m
    where private.luhn_valid(regexp_replace(m[1], '[ -]', '', 'g'))
  )
$$;

/**
 * Every string value in a JSON document, at any depth, except machine
 * identifiers whose formats are numeric by design and collide with Luhn by
 * chance (about 1 in 10 of any digit string passes the checksum):
 *   - any `productId` (GTIN/EAN/UPC barcodes are 12-14 digits),
 *   - any `url` / `website` (shop URLs carry long numeric item ids),
 *   - `references[n].value` (ACH trace numbers, card-network transaction ids,
 *     order numbers are 13-19 digit identifiers).
 * Numbers are not scanned either: JSON numbers in BRAKE documents are
 * amounts and epoch-millisecond instants (13 digits). Free text (summaries,
 * merchant strings, names, descriptions, labels) is always scanned.
 */
create or replace function private.scannable_strings(p_doc jsonb)
returns setof text
language sql
immutable strict parallel safe
set search_path = ''
as $$
  with recursive walk(path, node) as (
    select array[]::text[], p_doc
    union all
    select w.path || child.key, child.value
    from walk as w
    cross join lateral (
      select o.key, o.value
      from jsonb_each(case when jsonb_typeof(w.node) = 'object' then w.node else '{}'::jsonb end) as o
      union all
      select (a.ord - 1)::text, a.value
      from jsonb_array_elements(case when jsonb_typeof(w.node) = 'array' then w.node else '[]'::jsonb end)
           with ordinality as a(value, ord)
    ) as child
  )
  select w.node #>> '{}'
  from walk as w
  where jsonb_typeof(w.node) = 'string'
    and coalesce(w.path[cardinality(w.path)], '') not in ('productId', 'url', 'website')
    and not (
      cardinality(w.path) >= 3
      and w.path[cardinality(w.path) - 2] = 'references'
      and w.path[cardinality(w.path)] = 'value'
    )
$$;

create or replace function private.json_contains_card_number(p_doc jsonb)
returns boolean
language sql
immutable strict parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from private.scannable_strings(p_doc) as s(v) where private.contains_card_number(s.v)
  )
$$;

/*
 * Change-aware scanners for the card-number trigger. Each is true only when
 * the value is new (differs from the old row; on INSERT OLD reads as NULL) and
 * small enough to be stored at all:
 *   - unchanged values are not re-judged on UPDATE, so a row stored before a
 *     later migration tightened the detector cannot make every UPDATE of it
 *     fail — least of all the retention job's, which would then abort for
 *     every user, every hour;
 *   - oversized values are not scanned: BEFORE triggers run before CHECK
 *     constraints, so scanning a multi-megabyte document first would let any
 *     signed-in user burn seconds of database CPU per request only to be
 *     rejected by the size check afterwards. Every scanned column has a size
 *     CHECK no larger than the limit passed here, so skipping is safe.
 */
create or replace function private.new_text_has_card_number(p_new text, p_old text, p_max_chars integer)
returns boolean
language sql
immutable parallel safe
set search_path = ''
as $$
  select coalesce(
    p_new is distinct from p_old
      and char_length(p_new) <= p_max_chars
      and private.contains_card_number(p_new),
    false)
$$;

create or replace function private.new_texts_have_card_number(p_new text[], p_old text[], p_max_bytes integer)
returns boolean
language sql
immutable parallel safe
set search_path = ''
as $$
  select coalesce(
    p_new is distinct from p_old
      and pg_catalog.pg_column_size(p_new) <= p_max_bytes
      and exists (select 1 from pg_catalog.unnest(p_new) as v(s) where private.contains_card_number(v.s)),
    false)
$$;

create or replace function private.new_json_has_card_number(p_new jsonb, p_old jsonb, p_max_bytes integer)
returns boolean
language sql
immutable parallel safe
set search_path = ''
as $$
  select coalesce(
    p_new is distinct from p_old
      and pg_catalog.pg_column_size(p_new) <= p_max_bytes
      and private.json_contains_card_number(p_new),
    false)
$$;

/**
 * Trigger: reject rows whose stored text contains a full card number.
 * Defence in depth behind the adapters' on-device redaction, on every column
 * an adapter-, store- or user-supplied string lands in outside of ids that
 * are already judged inside facts/body: observation facts, excerpt and
 * merchant key; assertion bodies and anchors; prompt anchors; connection
 * labels/providers (the same strings facts.source carries); and owned
 * instruments, whose columns must only ever hold masked identifiers.
 * The error names the column but never echoes the value: database and API
 * logs must not become the place where the leaked number ends up.
 * SECURITY DEFINER only so the caller needs no access to schema private; it
 * reads nothing but NEW and OLD.
 */
create or replace function private.reject_card_numbers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text;
begin
  -- OLD reads as NULL on INSERT, so every non-null value counts as new.
  if tg_table_name = 'observations' then
    v_column := case
      when private.new_json_has_card_number(new.facts, old.facts, 32768) then 'facts'
      when private.new_text_has_card_number(new.evidence_excerpt, old.evidence_excerpt, 500) then 'evidence_excerpt'
      when private.new_text_has_card_number(new.merchant_key, old.merchant_key, 256) then 'merchant_key'
    end;
  elsif tg_table_name = 'user_assertions' then
    v_column := case
      when private.new_json_has_card_number(new.body, old.body, 32768) then 'body'
      when private.new_texts_have_card_number(new.anchors, old.anchors, 32768) then 'anchors'
    end;
  elsif tg_table_name = 'owned_instruments' then
    v_column := case
      when private.new_text_has_card_number(new.account_ref, old.account_ref, 256) then 'account_ref'
      when private.new_text_has_card_number(new.handle, old.handle, 256) then 'handle'
      when private.new_text_has_card_number(new.issuer, old.issuer, 200) then 'issuer'
    end;
  elsif tg_table_name = 'source_connections' then
    v_column := case
      when private.new_text_has_card_number(new.label, old.label, 120) then 'label'
      when private.new_text_has_card_number(new.provider, old.provider, 200) then 'provider'
    end;
  elsif tg_table_name = 'prompt_log' then
    v_column := case
      when private.new_text_has_card_number(new.anchor, old.anchor, 512) then 'anchor'
    end;
  end if;

  if v_column is not null then
    raise exception '%.% contains what looks like a full card number', tg_table_name, v_column
      using errcode = 'check_violation', hint = 'Redact card numbers on the device; store last 4 digits only.';
  end if;
  return new;
end
$$;

/** Trigger: maintain updated_at for rows whose timestamp is owned by the database. */
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

/**
 * Trigger: revocation is final (as in the consent registry, packages/core
 * privacy/consent.ts). Re-consenting creates a new connection id with a new
 * receipt, so a revoked grant can never be silently revived with stale scopes,
 * e.g. by an offline device upserting its older copy of the connection.
 *
 * A connection's id is permanent for the same reason: consent receipts and
 * observations refer to it by value, and renaming a revoked row would free its
 * id for a fresh 'active' insert of the stale grant. (Deleting the row is not
 * granted to clients at all; see access control below.) A change of user_id
 * is left to the row-level security WITH CHECK, which reports it as such.
 */
create or replace function private.keep_revocation_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.connection_id is distinct from old.connection_id then
    raise exception 'a connection id is permanent; re-consent must create a new connection'
      using errcode = 'check_violation';
  end if;
  if old.status = 'revoked' and (new.status <> 'revoked' or new.revoked_at is distinct from old.revoked_at) then
    raise exception 'connection % is revoked; re-consent must create a new connection', old.connection_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

/**
 * Trigger (BEFORE INSERT): admit an observation to its connection.
 *
 *  1. Drop observations that arrive for a revoked connection. With several
 *     devices, one may revoke a source while another (offline) still has
 *     queued observations from it; re-inserting them would resurrect data the
 *     user asked to delete. The row is skipped rather than raised, so the
 *     other device's sync completes and simply reports fewer inserted rows.
 *     The connection row is read FOR KEY SHARE (the lock the foreign key check
 *     takes anyway, compatible with ordinary connection updates). Without the
 *     lock this check races revoke_connection(): an insert that read 'active'
 *     just before a concurrent revocation committed would land after its
 *     purge and survive it. With it, either the revocation waits for this
 *     insert and then deletes the row, or this insert waits for the
 *     revocation and then sees 'revoked'. (A row lock needs the UPDATE
 *     privilege, which authenticated has on source_connections for upserts.)
 *  2. Store the minimum excerpt, by the connection's own policy (the rule the
 *     store applies on the device, storableExcerpt, and the retention job
 *     applies later): none at all when the policy keeps none (excerpt_ttl_ms
 *     = 0, e.g. messaging: other people's words), and never an expiry later
 *     than received_at + excerpt_ttl_ms, so no client can keep an excerpt
 *     beyond the policy ('infinity' included). Expiries are compared in epoch
 *     milliseconds (numeric), so an absurd TTL cannot overflow.
 *
 * SECURITY INVOKER on purpose: the lookup runs under the caller's row-level
 * security, so a forged user_id finds nothing here and is then rejected by the
 * WITH CHECK policy, instead of leaking whether another user's connection is
 * revoked; and an unknown connection is left to the foreign key.
 */
create or replace function private.admit_observation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- First instant past timestamptz's range (294277-01-01 UTC), in epoch ms.
  c_end_of_time_ms constant numeric := 9224318016000000;
  v_status text;
  v_excerpt_ttl_ms bigint;
  v_cap_ms numeric;
begin
  select c.status, c.excerpt_ttl_ms
    into v_status, v_excerpt_ttl_ms
  from public.source_connections as c
  where c.user_id = new.user_id
    and c.connection_id = new.connection_id
  for key share;

  if not found then
    return new;
  end if;

  if v_status = 'revoked' then
    return null;
  end if;

  if new.evidence_excerpt is not null then
    if v_excerpt_ttl_ms = 0 then
      new.evidence_excerpt := null;
      new.excerpt_expires_at := null;
    elsif new.excerpt_expires_at is not null then
      v_cap_ms := extract(epoch from new.received_at) * 1000 + v_excerpt_ttl_ms;
      -- A cap past the end of time is no cap: an infinite expiry is then left
      -- to the observations_finite_instants check, which rejects it.
      if v_cap_ms < extract(epoch from new.excerpt_expires_at) * 1000 and v_cap_ms < c_end_of_time_ms then
        new.excerpt_expires_at := pg_catalog.to_timestamp((v_cap_ms / 1000)::double precision);
      end if;
    end if;
  end if;
  return new;
end
$$;

revoke all on all functions in schema private from public;

-- ------------------------------------------------------- user_settings -----

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  locale text not null check (char_length(locale) between 2 and 64),
  -- IANA time zone; only needed so every device evaluates "local hours" rules alike.
  time_zone text not null check (char_length(time_zone) between 1 and 64),
  home_country char(2) check (home_country ~ '^[A-Z]{2}$'),
  home_currency char(3) check (home_currency ~ '^[A-Z]{3}$'),
  -- Max classification questions per 7 days: BRAKE must not nag (brief: one-tap labeling).
  question_weekly_budget smallint not null default 5 check (question_weekly_budget between 0 and 50),
  regret_prompts_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_settings is
  'BRAKE UserSettings (store.ts). One row per user; updated_at is maintained by the database.';

create trigger user_settings_touch_updated_at
  before update on public.user_settings
  for each row execute function private.touch_updated_at();

-- -------------------------------------------------- source_connections -----

-- Size bounds, here and on every table below: no column a client writes is
-- unbounded. Ids are short hashes or opaque provider ids (512 characters is
-- generous); arrays and documents get byte budgets. Without them any signed-in
-- user could store megabytes per row (storage denial of service) or park raw
-- text in an id or anchor column, where no other check looks.
create table public.source_connections (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connection_id text collate "C" not null check (char_length(connection_id) <= 512),
  adapter_id text not null check (char_length(adapter_id) <= 128),
  kind text not null check (kind in (
    'open_banking', 'account_aggregator', 'card_feed', 'issuer_webhook', 'neobank_api',
    'wallet_history', 'os_wallet', 'notification', 'sms', 'messaging', 'email',
    'payment_intent', 'qr_scan', 'checkout', 'merchant_partner', 'payment_partner',
    'manual', 'receipt', 'share', 'voice', 'barcode', 'browser_extension',
    'app_activity', 'user_rule'
  )),
  -- Shown in settings and provenance sentences; a label, not a place for content.
  label text not null check (char_length(label) between 1 and 120),
  provider text check (char_length(provider) <= 200),
  status text not null check (status in ('active', 'paused', 'revoked')),
  -- Exactly what the user granted and why, as shown at consent time.
  scopes text[] not null default '{}' check (cardinality(scopes) <= 64 and pg_column_size(scopes) <= 8192),
  purposes text[] not null default '{}' check (cardinality(purposes) <= 64 and pg_column_size(purposes) <= 8192),
  -- The connection's retention policy (privacy/retention.ts) drives private.apply_retention.
  excerpt_ttl_ms bigint not null check (excerpt_ttl_ms >= 0),
  -- null = keep extracted facts until the user deletes them or disconnects.
  observation_ttl_ms bigint check (observation_ttl_ms is null or observation_ttl_ms > 0),
  granted_at timestamptz not null,
  -- Domain timestamp (SourceConnection.updatedAt), written by the client.
  updated_at timestamptz not null,
  revoked_at timestamptz,
  primary key (user_id, connection_id),
  constraint source_connections_revoked_at check (status <> 'revoked' or revoked_at is not null)
);

comment on table public.source_connections is
  'One user-granted connection of one signal source (consent). Revocation is final; revoke via public.revoke_connection().';

create trigger source_connections_keep_revocation_final
  before update on public.source_connections
  for each row execute function private.keep_revocation_final();

create trigger source_connections_reject_card_numbers
  before insert or update on public.source_connections
  for each row execute function private.reject_card_numbers();

-- ------------------------------------------------------ consent_events -----

-- The user's consent receipts. Append-only for API roles: a receipt that can
-- be edited or deleted is not a receipt. Only erase_my_data() (the user's
-- right to erasure) and account deletion remove them.
create table public.consent_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connection_id text collate "C" not null check (char_length(connection_id) <= 512),
  action text not null check (action in (
    'granted', 'paused', 'resumed', 'revoked', 'scopes_changed', 'retention_changed'
  )),
  at timestamptz not null,
  scopes text[] not null default '{}' check (cardinality(scopes) <= 64 and pg_column_size(scopes) <= 8192),
  purposes text[] not null default '{}' check (cardinality(purposes) <= 64 and pg_column_size(purposes) <= 8192)
);

comment on table public.consent_events is
  'Append-only consent receipts (ConsentEvent). API roles may select and insert only.';

create index consent_events_user_connection_at_idx
  on public.consent_events (user_id, connection_id, at);

/**
 * Trigger: receipt ids come from the sequence, never from a client.
 * `generated always` refuses a client id on a plain INSERT, but any role with
 * INSERT may add OVERRIDING SYSTEM VALUE. The id is a table-wide key, so a
 * client that claimed ids *ahead* of the sequence would make other users'
 * receipts (and revoke_connection(), which appends one) fail with a unique
 * violation once the sequence got there: a cross-user denial of service. An id
 * the sequence produced is never ahead of its last value, so that is the test.
 * SECURITY DEFINER only to read the sequence, which API roles cannot.
 */
create or replace function private.consent_event_id_from_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id > (select s.last_value from public.consent_events_id_seq as s) then
    raise exception 'consent receipt ids are assigned by the database'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function private.consent_event_id_from_sequence() from public;

create trigger consent_events_id_from_sequence
  before insert on public.consent_events
  for each row execute function private.consent_event_id_from_sequence();

-- -------------------------------------------------------- observations -----

-- Extracted facts, never raw payloads. Searchable columns are projections of
-- `facts` for indexing and retention; `facts` is the Observation JSON minus
-- the evidence excerpt, which lives in its own column so it can expire.
create table public.observations (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text collate "C" not null check (char_length(id) <= 512),
  connection_id text collate "C" not null,
  adapter_id text not null check (char_length(adapter_id) <= 128),
  source_kind text not null check (source_kind in (
    'open_banking', 'account_aggregator', 'card_feed', 'issuer_webhook', 'neobank_api',
    'wallet_history', 'os_wallet', 'notification', 'sms', 'messaging', 'email',
    'payment_intent', 'qr_scan', 'checkout', 'merchant_partner', 'payment_partner',
    'manual', 'receipt', 'share', 'voice', 'barcode', 'browser_extension',
    'app_activity', 'user_rule'
  )),
  kind text not null check (kind in (
    'purchase_intent', 'checkout', 'money_movement', 'order', 'receipt', 'invoice',
    'delivery', 'subscription_event', 'refund_notice', 'booking', 'mandate',
    'balance_snapshot', 'app_context'
  )),
  spend_window text not null check (spend_window in ('pre_spend', 'in_spend', 'post_spend')),
  stage text not null check (stage in (
    'intent', 'pending', 'confirmed', 'posted', 'refunded', 'cancelled', 'unknown'
  )),
  received_at timestamptz not null,
  occurred_at timestamptz,
  direction text check (direction in ('debit', 'credit')),
  -- Integer minor units, never floating point; direction is carried separately.
  amount_minor bigint check (amount_minor >= 0),
  currency char(3) check (currency ~ '^[A-Z]{3}$'),
  merchant_key text check (char_length(merchant_key) <= 256),
  confidence real not null check (confidence between 0 and 1),
  facts jsonb not null,
  -- Redacted, expiring snippet for "How did BRAKE know this?". It may never
  -- outlive its expiry, so an expiry is required whenever an excerpt exists.
  evidence_excerpt text check (char_length(evidence_excerpt) <= 500),
  excerpt_expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  -- Composite key: an observation can only belong to its owner's connection,
  -- and revoking/deleting the connection removes its observations.
  foreign key (user_id, connection_id)
    references public.source_connections (user_id, connection_id) on delete cascade,
  constraint observations_excerpt_has_expiry
    check (evidence_excerpt is null or excerpt_expires_at is not null),
  constraint observations_facts_is_object
    check (jsonb_typeof(facts) = 'object'),
  -- Raw-payload smuggling guard: these are the names a careless client would
  -- use to attach the original message, page or provider response.
  constraint observations_facts_no_raw_payload
    check (not (facts ?| array['payload', 'raw', 'rawPayload', 'body', 'html', 'text'])),
  -- The excerpt must not escape its expiry by also living inside facts.
  constraint observations_facts_no_excerpt
    check (not coalesce((facts -> 'evidence') ?| array['excerpt', 'excerptExpiresAt'], false)),
  -- An extracted observation is a few hundred bytes; 32 KiB leaves room for
  -- long receipts' line items while making whole documents impossible to store.
  constraint observations_facts_size
    check (pg_column_size(facts) <= 32768),
  -- The key columns are projections of facts and must agree with it: revocation
  -- and retention delete by these columns, so facts filed under another
  -- connection (or id) would survive their own connection's revocation while
  -- every device still reads them as that connection's.
  constraint observations_id_matches_facts
    check ((facts ->> 'id') is not distinct from id),
  constraint observations_connection_matches_facts
    check ((facts #>> '{source,connectionId}') is not distinct from connection_id),
  -- Retention compares these instants; 'infinity' would keep a fact or an
  -- excerpt forever (and no device can parse it back either).
  constraint observations_finite_instants
    check (
      isfinite(received_at)
      and (occurred_at is null or isfinite(occurred_at))
      and (excerpt_expires_at is null or isfinite(excerpt_expires_at))
    )
);

comment on table public.observations is
  'Immutable extracted facts from one source (Observation, ADR-002): clients may insert and delete, never update. Never raw payloads. facts = Observation JSON without evidence.excerpt/excerptExpiresAt.';

-- Paged sync by receivedAt (store.listObservations cursor order).
create index observations_user_received_idx on public.observations (user_id, received_at, id);
-- Revocation and per-connection listing.
create index observations_user_connection_idx on public.observations (user_id, connection_id);
-- Candidate blocking lookups by amount (fusion runs on device, but a device
-- restoring from backup pages through this).
create index observations_user_amount_idx on public.observations (user_id, currency, amount_minor, occurred_at);
-- Lets the retention job find the (few) rows that still carry an excerpt.
create index observations_excerpt_expiry_idx on public.observations (excerpt_expires_at)
  where evidence_excerpt is not null;

-- BEFORE triggers fire in name order: admission (revoked connection, excerpt
-- policy) runs before the card-number scan, so a late observation of a
-- revoked connection is skipped rather than scanned, and an excerpt the policy
-- drops is never judged.
create trigger observations_admit
  before insert on public.observations
  for each row execute function private.admit_observation();

create trigger observations_reject_card_numbers
  before insert or update on public.observations
  for each row execute function private.reject_card_numbers();

-- ----------------------------------------------------- user_assertions -----

create table public.user_assertions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text collate "C" not null check (char_length(id) <= 512),
  kind text not null check (kind in (
    'label', 'satisfaction', 'same_event', 'different_events', 'dismiss', 'confirm'
  )),
  at timestamptz not null,
  -- Observation ids, not candidate ids, so assertions survive re-fusion (ADR-002).
  -- Not foreign keys: an anchor may name an observation that only another
  -- device has synced yet, or one that retention/revocation has since removed.
  -- Up to 50 ids of at most 512 characters: a byte budget, not free text.
  anchors text[] collate "C" not null check (
    cardinality(anchors) between 1 and 50
    and array_position(anchors, null) is null
    and pg_column_size(anchors) <= 32768
  ),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  primary key (user_id, id),
  -- A UserAssertion is a few hundred bytes (its anchors included); the same
  -- 32 KiB budget as observation facts.
  constraint user_assertions_body_size check (pg_column_size(body) <= 32768)
);

comment on table public.user_assertions is
  'What the user told BRAKE (UserAssertion), anchored to observation ids. body = the whole UserAssertion JSON.';

-- private.apply_retention keeps anchored observations: anchors @> array[id].
create index user_assertions_anchors_idx on public.user_assertions using gin (anchors);

create trigger user_assertions_reject_card_numbers
  before insert or update on public.user_assertions
  for each row execute function private.reject_card_numbers();

-- ------------------------------------------------------------- budgets -----

create table public.budgets (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- When Budget.id is absent the store derives `${category ?? "all"}:${period}:${currency}`.
  id text collate "C" not null check (char_length(id) <= 512),
  category text check (char_length(category) <= 256),
  limit_minor bigint not null check (limit_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  period text not null check (period in ('weekly', 'monthly')),
  primary key (user_id, id)
);

-- --------------------------------------------------------------- goals -----

create table public.goals (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text collate "C" not null check (char_length(id) <= 512),
  name text not null check (char_length(name) <= 80),
  target_minor bigint not null check (target_minor > 0),
  saved_minor bigint not null check (saved_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  target_date timestamptz,
  primary key (user_id, id)
);

-- ---------------------------------------------------------- user_rules -----

create table public.user_rules (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text collate "C" not null check (char_length(id) <= 512),
  description text not null check (char_length(description) <= 200),
  level text not null check (level in ('inform', 'reflect', 'pause')),
  -- Only the rule's matching criteria (a category id, an amount, two hours, a
  -- channel: well under 1 KiB); anything else is not a rule.
  rule jsonb not null default '{}' check (
    jsonb_typeof(rule) = 'object'
    and (rule - array['category', 'minAmount', 'localHours', 'channel']) = '{}'::jsonb
    and pg_column_size(rule) <= 4096
  ),
  primary key (user_id, id)
);

-- --------------------------------------------------- owned_instruments -----

-- Masked identifiers only: last 4 digits, an opaque provider reference, or a
-- public handle. A full card/account number has no column to live in, and the
-- card-number trigger keeps one out of the free-text columns too (an opaque
-- reference is exactly where a careless client would put the real number).
create table public.owned_instruments (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text collate "C" not null check (char_length(id) <= 512),
  type text not null check (type in ('bank_account', 'card', 'wallet', 'upi_handle', 'brokerage', 'loan')),
  issuer text check (char_length(issuer) <= 200),
  last4 text check (last4 ~ '^[0-9]{4}$'),
  account_ref text check (char_length(account_ref) <= 256),
  handle text check (char_length(handle) <= 256),
  card_kind text check (card_kind in ('credit', 'debit', 'prepaid')),
  primary key (user_id, id)
);

create trigger owned_instruments_reject_card_numbers
  before insert or update on public.owned_instruments
  for each row execute function private.reject_card_numbers();

-- ---------------------------------------------------------- prompt_log -----

-- Shared across devices so the question budget, regret-prompt caps and the
-- nagging guard hold no matter which device asks.
create table public.prompt_log (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text collate "C" not null check (char_length(id) <= 512),
  kind text not null check (kind in ('question', 'regret_prompt', 'intervention', 'insight')),
  -- An observation id of the candidate the prompt was about (candidates are derived).
  anchor text collate "C" check (char_length(anchor) <= 512),
  shown_at timestamptz not null,
  answered_at timestamptz,
  -- Option ids ("shopping", "dismissed", "satisfaction:regretted") only, never free text.
  answer text check (answer ~ '^[a-z0-9_:-]{1,64}$'),
  primary key (user_id, id)
);

create index prompt_log_user_shown_idx on public.prompt_log (user_id, shown_at);

create trigger prompt_log_reject_card_numbers
  before insert or update on public.prompt_log
  for each row execute function private.reject_card_numbers();

-- ------------------------------------------------- capability_registry -----

-- Public, non-personal document (packages/capabilities): which sources exist
-- per country/platform. Readable by anyone, published only by service_role.
create table public.capability_registry (
  version text primary key,
  published_at timestamptz not null default now(),
  document jsonb not null check (jsonb_typeof(document) = 'object')
);

-- ========================================================== access control ==

-- Row-level security on every table. Supabase's linter flags any public table
-- without it, and without it the default grants would expose every row.
alter table public.user_settings enable row level security;
alter table public.source_connections enable row level security;
alter table public.consent_events enable row level security;
alter table public.observations enable row level security;
alter table public.user_assertions enable row level security;
alter table public.budgets enable row level security;
alter table public.goals enable row level security;
alter table public.user_rules enable row level security;
alter table public.owned_instruments enable row level security;
alter table public.prompt_log enable row level security;
alter table public.capability_registry enable row level security;

-- Undo Supabase's default "grant all to anon, authenticated, service_role" on
-- every user table, then grant authenticated exactly the commands the
-- persistence port (packages/core/src/store.ts) needs, table by table, with a
-- policy for each granted command and none for the others. anon (the public
-- API key) gets nothing: there is no anonymous BRAKE data. Deliberately absent:
--   * source_connections DELETE: the port never deletes a connection; it is
--     revoked through revoke_connection() and removed only by erase_my_data()
--     or account deletion. A client DELETE would erase the grant without a
--     receipt and free its id, so a stale 'active' copy upserted by an offline
--     device would be re-created: revocation would no longer be final.
--   * observations UPDATE: observations are immutable (ADR-002) and the port
--     only inserts (ON CONFLICT DO NOTHING) and deletes them. An UPDATE could
--     extend an excerpt's life past its policy or re-file a fact under another
--     connection after the admission checks ran.
--   * consent_events UPDATE/DELETE: append-only receipts (below).
do $grants$
declare
  t record;
begin
  for t in
    select * from (values
      ('user_settings',      true,  true),
      ('source_connections', true,  false),
      ('observations',       false, true),
      ('user_assertions',    true,  true),
      ('budgets',            true,  true),
      ('goals',              true,  true),
      ('user_rules',         true,  true),
      ('owned_instruments',  true,  true),
      ('prompt_log',         true,  true)
    ) as v(name, can_update, can_delete)
  loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t.name);
    execute format('grant select, insert on table public.%I to authenticated', t.name);
    execute format('grant all on table public.%I to service_role', t.name);

    -- (select auth.uid()) is evaluated once per statement (an initplan), not per row.
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t.name || '_select_own', t.name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',
      t.name || '_insert_own', t.name);
    if t.can_update then
      execute format('grant update on table public.%I to authenticated', t.name);
      execute format(
        'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
        t.name || '_update_own', t.name);
    end if;
    if t.can_delete then
      execute format('grant delete on table public.%I to authenticated', t.name);
      execute format(
        'create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))',
        t.name || '_delete_own', t.name);
    end if;
  end loop;
end
$grants$;

-- consent_events: append-only receipts. No UPDATE/DELETE grant and no
-- UPDATE/DELETE policy, so both are refused twice over.
revoke all on table public.consent_events from public, anon, authenticated;
grant select, insert on table public.consent_events to authenticated;
grant all on table public.consent_events to service_role;
revoke all on sequence public.consent_events_id_seq from public, anon, authenticated;
grant all on sequence public.consent_events_id_seq to service_role;

create policy consent_events_select_own on public.consent_events
  for select to authenticated using (user_id = (select auth.uid()));
create policy consent_events_insert_own on public.consent_events
  for insert to authenticated with check (user_id = (select auth.uid()));

-- capability_registry: world-readable, writable by service_role only
-- (service_role bypasses RLS; there is deliberately no write policy).
revoke all on table public.capability_registry from public, anon, authenticated;
grant select on table public.capability_registry to anon, authenticated;
grant all on table public.capability_registry to service_role;

create policy capability_registry_read on public.capability_registry
  for select to anon, authenticated using (true);
