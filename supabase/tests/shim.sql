-- =============================================================================
-- LOCAL-ONLY Supabase compatibility shim. NEVER add this file to migrations.
--
-- Hosted Supabase (and `supabase start`) ship these objects before any
-- migration runs. Plain Postgres has none of them, so database tests apply
-- this file first and then every file in supabase/migrations in name order.
-- It reproduces only what BRAKE's schema relies on, as Supabase defines it:
--
--   * the API roles: anon, authenticated, service_role (BYPASSRLS) and the
--     PostgREST login role authenticator (NOINHERIT, may SET ROLE to the three);
--   * schema auth with a minimal auth.users and auth.uid()/role()/jwt(), which
--     read the JWT claims PostgREST puts in the `request.jwt.claims` setting;
--   * schema extensions;
--   * Supabase's *broad default grants* on schema public. These are the
--     dangerous part to forget: on hosted Supabase every table and function the
--     migrations create in public is automatically granted to anon,
--     authenticated and service_role, so the migrations must revoke and
--     re-grant explicitly. Testing without these defaults would hide exactly
--     the mistakes that leak data in production.
--
-- Roles are cluster-wide while every test uses its own database, so role
-- creation tolerates concurrent runs creating the same role.
-- =============================================================================

-- ---------------------------------------------------------------- roles ----
do $roles$
declare
  r record;
begin
  for r in
    select * from (values
      ('anon',          'create role anon nologin noinherit'),
      ('authenticated', 'create role authenticated nologin noinherit'),
      ('service_role',  'create role service_role nologin noinherit bypassrls'),
      ('authenticator', 'create role authenticator login noinherit')
    ) as t(name, ddl)
  loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = r.name) then
      begin
        execute r.ddl;
      exception when duplicate_object or unique_violation then
        null; -- another test database created it concurrently
      end;
    end if;
  end loop;

  for r in select unnest(array['anon', 'authenticated', 'service_role']) as name loop
    if not pg_catalog.pg_has_role('authenticator', r.name, 'member') then
      begin
        execute format('grant %I to authenticator', r.name);
      exception when duplicate_object or unique_violation then
        null;
      end;
    end if;
  end loop;
end
$roles$;

-- ----------------------------------------------------------------- auth ----
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- The real auth.users has dozens of columns owned by GoTrue; BRAKE only
-- references the primary key (every user row cascades from it).
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Same definitions as Supabase: prefer the legacy per-claim settings, fall
-- back to the JSON claims document PostgREST >= 9 sets per request.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- ----------------------------------------------------------- extensions ----
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- ------------------------------------------- Supabase default privileges ----
grant usage on schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
