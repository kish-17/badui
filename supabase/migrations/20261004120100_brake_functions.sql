-- =============================================================================
-- BRAKE functions: user-rights RPCs and the retention job.
--
-- Conventions (Supabase security advisor):
--   * every function sets search_path = '' and fully qualifies every name, so
--     a caller-controlled search_path can never redirect a SECURITY DEFINER
--     body to look-alike objects;
--   * SECURITY DEFINER only where the caller must do something its own grants
--     forbid (erase_my_data deletes append-only consent receipts); everything
--     else runs as the caller, under row-level security, and additionally
--     filters by auth.uid() explicitly;
--   * PUBLIC and anon lose EXECUTE explicitly: Postgres grants EXECUTE to
--     PUBLIC by default and Supabase additionally grants it to anon.
-- =============================================================================

-- ------------------------------------------------------ revoke_connection --

/**
 * Withdraw consent for one of the caller's connections (BrakeStore.revokeConnection):
 * mark it revoked, append the 'revoked' consent receipt, and delete every
 * observation it produced — including ones anchored by user assertions:
 * revocation outranks retention. Returns the number of observations deleted.
 *
 * Idempotent: revoking an already revoked connection appends no second
 * receipt and keeps the original revoked_at (it still purges any stragglers).
 * A connection that is not the caller's raises exactly like one that does not
 * exist, so the error is not an oracle for other users' connection ids.
 */
create or replace function public.revoke_connection(p_connection_id text, p_at timestamptz default now())
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_connection public.source_connections%rowtype;
  v_deleted integer;
begin
  if v_uid is null then
    raise exception 'revoke_connection requires a signed-in user' using errcode = 'insufficient_privilege';
  end if;

  select * into v_connection
  from public.source_connections as c
  where c.user_id = v_uid and c.connection_id = p_connection_id
  for update;

  if not found then
    raise exception 'connection not found' using errcode = 'no_data_found';
  end if;

  if v_connection.status <> 'revoked' then
    update public.source_connections as c
    set status = 'revoked', revoked_at = p_at, updated_at = p_at
    where c.user_id = v_uid and c.connection_id = p_connection_id;

    insert into public.consent_events (user_id, connection_id, action, at, scopes, purposes)
    values (v_uid, p_connection_id, 'revoked', p_at, v_connection.scopes, v_connection.purposes);
  end if;

  delete from public.observations as o
  where o.user_id = v_uid and o.connection_id = p_connection_id;
  get diagnostics v_deleted = row_count;

  return v_deleted;
end
$$;

comment on function public.revoke_connection(text, timestamptz) is
  'Revoke one of the caller''s source connections: status revoked + consent receipt + delete its observations. Returns deleted observation count.';

revoke all on function public.revoke_connection(text, timestamptz) from public, anon;
grant execute on function public.revoke_connection(text, timestamptz) to authenticated, service_role;

-- -------------------------------------------------------- export_my_data --

/**
 * Data portability (BrakeStore.exportAll): every row stored about the caller,
 * keyed by table name, each value an array of that table's rows (snake_case
 * columns as stored, user_id included) in a stable order, plus exported_at.
 * Runs as the caller: row-level security and the explicit user filter agree.
 */
create or replace function public.export_my_data()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'export_my_data requires a signed-in user' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'user_settings', coalesce((
      select jsonb_agg(to_jsonb(t)) from public.user_settings as t where t.user_id = v_uid), '[]'::jsonb),
    'source_connections', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.granted_at, t.connection_id)
      from public.source_connections as t where t.user_id = v_uid), '[]'::jsonb),
    'consent_events', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.at, t.id)
      from public.consent_events as t where t.user_id = v_uid), '[]'::jsonb),
    'observations', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.received_at, t.id)
      from public.observations as t where t.user_id = v_uid), '[]'::jsonb),
    'user_assertions', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.at, t.id)
      from public.user_assertions as t where t.user_id = v_uid), '[]'::jsonb),
    'budgets', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.id) from public.budgets as t where t.user_id = v_uid), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.id) from public.goals as t where t.user_id = v_uid), '[]'::jsonb),
    'user_rules', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.id) from public.user_rules as t where t.user_id = v_uid), '[]'::jsonb),
    'owned_instruments', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.id) from public.owned_instruments as t where t.user_id = v_uid), '[]'::jsonb),
    'prompt_log', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.shown_at, t.id)
      from public.prompt_log as t where t.user_id = v_uid), '[]'::jsonb)
  );
end
$$;

comment on function public.export_my_data() is
  'Everything stored about the caller as JSON: {exported_at, <table>: [rows...]} for every user table.';

revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated, service_role;

-- --------------------------------------------------------- erase_my_data --

/**
 * Right to erasure (BrakeStore.eraseAll): delete every row of the caller in
 * every table, consent receipts included. The auth account itself is removed
 * by Supabase Auth (deleting auth.users cascades here as well).
 *
 * SECURITY DEFINER because consent_events is append-only for the caller and
 * clients cannot delete source_connections (revocation must stay final); the
 * body therefore never trusts anything but auth.uid(), and refuses to run
 * without one (anon, or service_role without a user) instead of matching
 * nothing — or everything.
 */
create or replace function public.erase_my_data()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'erase_my_data requires a signed-in user' using errcode = 'insufficient_privilege';
  end if;

  delete from public.observations where user_id = v_uid;
  delete from public.user_assertions where user_id = v_uid;
  delete from public.consent_events where user_id = v_uid;
  delete from public.source_connections where user_id = v_uid;
  delete from public.user_settings where user_id = v_uid;
  delete from public.budgets where user_id = v_uid;
  delete from public.goals where user_id = v_uid;
  delete from public.user_rules where user_id = v_uid;
  delete from public.owned_instruments where user_id = v_uid;
  delete from public.prompt_log where user_id = v_uid;
end
$$;

comment on function public.erase_my_data() is
  'Delete every row belonging to the caller in every BRAKE table, consent receipts included.';

revoke all on function public.erase_my_data() from public, anon;
grant execute on function public.erase_my_data() to authenticated, service_role;

-- ------------------------------------------------- private.apply_retention --

/**
 * Server-side twin of applyRetention (packages/core/src/privacy/retention.ts)
 * for synced copies, so the backup never keeps more than the device would:
 *
 *  1. Delete observations past their connection's observation_ttl_ms, measured
 *     from when the event happened but never later than when BRAKE received it
 *     (a future-dated occurred_at must not extend retention) — unless one of
 *     the same user's assertions anchors them: deleting it would make the
 *     user's label silently disappear.
 *  2. Null evidence excerpts that expired, by the adapter's own expiry or by the
 *     connection's excerpt_ttl_ms from received_at, whichever is stricter, and
 *     every excerpt of a connection whose policy now keeps none (TTL 0). This
 *     also applies to anchored observations: the assertion needs the fact, not
 *     the text. Nulling an excerpt never re-runs the card-number scan over the
 *     row's unchanged facts (the trigger judges changed values only), so one
 *     row stored under an older, looser detector cannot abort the job for
 *     every user.
 *
 * TTL arithmetic is done in numeric epoch milliseconds rather than intervals,
 * so an absurd client-supplied TTL cannot overflow and abort the job for
 * every user. Only the owner (postgres / pg_cron) can run it.
 */
create or replace function private.apply_retention(p_now timestamptz default now())
returns table (excerpts_cleared integer, observations_deleted integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now_ms numeric := extract(epoch from p_now) * 1000;
  v_deleted integer;
  v_cleared integer;
begin
  delete from public.observations as o
  using public.source_connections as c
  where c.user_id = o.user_id
    and c.connection_id = o.connection_id
    and c.observation_ttl_ms is not null
    and extract(epoch from least(o.occurred_at, o.received_at)) * 1000 + c.observation_ttl_ms <= v_now_ms
    and not exists (
      select 1
      from public.user_assertions as a
      where a.user_id = o.user_id
        and a.anchors @> array[o.id]
    );
  get diagnostics v_deleted = row_count;

  update public.observations as o
  set evidence_excerpt = null,
      excerpt_expires_at = null
  from public.source_connections as c
  where c.user_id = o.user_id
    and c.connection_id = o.connection_id
    and o.evidence_excerpt is not null
    and (
      -- A zero TTL keeps no excerpt, whatever the clocks say (core's
      -- isExcerptExpired): a device clock running fast must not keep one alive.
      c.excerpt_ttl_ms = 0
      or o.excerpt_expires_at <= p_now
      or extract(epoch from o.received_at) * 1000 + c.excerpt_ttl_ms <= v_now_ms
    );
  get diagnostics v_cleared = row_count;

  excerpts_cleared := v_cleared;
  observations_deleted := v_deleted;
  return next;
end
$$;

comment on function private.apply_retention(timestamptz) is
  'Retention job: delete TTL-expired unanchored observations and clear expired evidence excerpts. Scheduled hourly by pg_cron when available.';

revoke all on function private.apply_retention(timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------- hourly with pg_cron --

-- Hosted Supabase ships pg_cron; plain Postgres (local tests, self-hosting
-- without it) does not. The migration must succeed either way, so the
-- schedule is created only when the extension can be enabled; otherwise run
-- `select * from private.apply_retention()` from an external scheduler.
-- cron.schedule() upserts by job name, so re-running is harmless.
do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available; private.apply_retention() is not scheduled';
    return;
  end if;

  begin
    create extension if not exists pg_cron;
    perform cron.schedule('brake_apply_retention', '7 * * * *', 'select * from private.apply_retention()');
  exception when others then
    raise warning 'pg_cron could not be enabled (%); private.apply_retention() is not scheduled', sqlerrm;
  end;
end
$cron$;
