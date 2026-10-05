# ADR-005: Supabase as the backend for accounts, sync and backup

Status: accepted · 2026-10-04

## Context

ADR-004 keeps processing on the device. Users still need things one device
cannot give them:

* an account that outlives a phone;
* the same observations, labels, consent and question budget on every device
  (phone, browser extension, web);
* a backup of their spending history and of their own labels and consent
  receipts.

Some sources, such as Plaid webhooks, Account Aggregator FI data and card
feeds, also deliver only to a server.

ADR-002 defines what must persist: observations, user assertions, consent
and preferences. The persistence port `BrakeStore`
(`packages/core/src/store.ts`) is the contract. Whatever backend holds that
data sees some of the most sensitive data a person has. It must therefore:

* isolate each user's rows in the data layer itself, not in client code;
* enforce the privacy principle (collect, store, retain and transmit the
  minimum) with more than client discipline;
* run retention without a device being online;
* support export and erasure;
* let BRAKE place data in the region its users live in (for example India
  and the EU).

## Decision

* **Supabase is BRAKE's backend database**: Postgres, PostgREST and Supabase
  Auth, with pg_cron for scheduling and Edge Functions for server-side code.
  It is used for accounts, multi-device sync and backup only. Parsing,
  fusion, classification, learning and decisions stay on the device.
* **The database stores only the port's source of truth:**
  * source connections and append-only consent receipts;
  * observations (extracted facts, never raw payloads, plus an expiring
    redacted excerpt);
  * user assertions;
  * settings, budgets, goals and rules;
  * masked owned instruments;
  * the prompt log;
  * a public capability-registry table.

  Candidates are derived and are not stored. Devices rebuild them by
  replaying observations and assertions into the deterministic fusion
  engine.
* **Isolation is row-level security keyed on `auth.uid()`.** Every user
  table has RLS enabled and policies for `authenticated` with
  `user_id = (select auth.uid())` in `USING` and `WITH CHECK`. Supabase's
  default grants are revoked explicitly. `anon` gets nothing on user tables,
  and `authenticated` gets exactly the commands the port uses. The service
  role key exists only on trusted servers.
* **The database enforces privacy rules as defence in depth:**
  * a card-number trigger;
  * forbidden raw-payload keys;
  * size bounds;
  * immutable observations;
  * final revocation that purges observations (`revoke_connection`);
  * the excerpt policy applied at insert;
  * an hourly retention job (`private.apply_retention`, scheduled with
    pg_cron where available).
* **User rights are RPCs:** `export_my_data()` and `erase_my_data()`.
  Deleting the Auth user (through the Auth admin API, from an Edge Function)
  cascades to every table.
* **One Supabase project per residency zone**, for example South Asia
  (Mumbai) for India and an EU region for the EU. Each account is assigned to
  its zone's project at sign-up.
* **This refines ADR-004 for webhook sources.** A planned Edge Function relay
  runs the same pure adapters server-side and stores only the extracted
  observations, instead of forwarding the raw payload to a device. The raw
  payload already arrives at a server. Extracting there means it is never
  queued, stored or sent onward, so BRAKE transmits and keeps less.

The schema is in `supabase/migrations/` and the client in `@brake/supabase`.
Details are in [docs/architecture/supabase.md](../supabase.md).

## Why Supabase fits

* **Postgres:** relational integrity and composite foreign keys, check
  constraints, triggers and `jsonb`. These let the database itself refuse
  what BRAKE must never store, and they keep the data portable to any
  Postgres.
* **Row-level security:** isolation is declared once in the database and
  applies to every path in: PostgREST, GraphQL and RPCs. Tests prove it per
  role.
* **Supabase Auth:** accounts with email, OTP or OAuth, and JWTs whose `sub`
  is the `auth.uid()` that RLS uses. No bespoke auth server.
* **PostgREST and supabase-js:** clients talk to the tables directly under
  RLS, with no API server to write, secure and operate.
* **pg_cron:** retention runs inside the database, hourly, whether or not a
  device is online.
* **Edge Functions:** a place for the few server-side jobs: webhook relays,
  account deletion with the service key, and publishing the capability
  registry.
* **Regions:** projects can be created in regions that match where users
  live, including Mumbai and several EU regions.
* **Open source with an exit path:** the migrations run on plain Postgres
  with a small shim (the test suite does exactly that). Self-hosted Supabase
  or plain Postgres plus PostgREST remains a fallback.

## Consequences

* **Every table is a public API.** Every new table needs RLS, explicit
  grants and revokes, and policies in the same migration. The
  database-tests shim reproduces Supabase's broad default grants so that a
  missing revoke fails a test. Run `npm run test:db` on every migration.
* **Schema changes are API changes.** Shipped app versions keep calling the
  old columns, so migrations must be expand-then-contract.
* **Two stores, one contract:**
  * the in-memory reference store (offline-only and tests);
  * the Supabase store.

  Both pass `packages/core/test/store-contract.ts`. A rule added to the
  schema must be mirrored in the memory store, or the stores drift.
* **Ordering is part of determinism.** Id columns are `collate "C"`, so every
  device replays observations in the same order regardless of the cluster's
  default collation.
* **Plaintext facts on a server.** Observations are minimised and redacted,
  and the provider encrypts them at rest, but they are readable by the
  operator (service role, database access). This is the main privacy cost of
  sync. It is bounded by what is stored, how long it is kept, and who holds
  the service key.
* **A hosted dependency.** BRAKE accepts Supabase's availability, statement
  timeouts and row caps. The store pages within Max Rows, batches writes and
  makes every write idempotent.
* **Residency means multiple projects.** Each zone is a separate project with
  its own Auth users. There is no import RPC yet, so moving an account
  between zones means re-syncing from a device into the new project and then
  erasing the old one.
* **Retention needs pg_cron.** On a cluster without it, the job must be
  scheduled externally, and a deployment check must confirm the schedule.
* **Local-only use stays possible.** A device can use the memory or
  on-device store alone. Sync is an addition, not a requirement of the
  engines.

## Alternatives considered

* **Firebase / Firestore.** Mature offline sync, Auth, regions (including
  Mumbai and the EU) and Cloud Functions. Rejected because:
  * isolation and validation would live in Security Rules, a second
    language that cannot express the defence-in-depth checks BRAKE relies on
    (a Luhn scan over nested documents, cross-row checks such as "this
    connection is revoked", serialised revocation);
  * account deletion and revocation would need Cloud Functions to fan out
    deletes, where Postgres uses `on delete cascade` and one transaction;
  * it is proprietary, so there is no "run it on any Postgres" exit.
* **Self-hosted Postgres with our own API and auth.** Maximum control and
  residency, with the same schema. Rejected for now: BRAKE would have to
  build and operate an auth service, an API layer, backups and
  point-in-time recovery, patching and on-call, and that effort is better
  spent on the product. Because the schema is plain Postgres and the tests
  run against plain Postgres and PostgREST, this remains the fallback if
  hosting terms, cost or residency require it.
* **Local-only (no backend).** The strongest privacy posture. Rejected as the
  only mode:
  * a lost phone loses the history, the user's labels and the consent
    receipts;
  * there is no multi-device experience (the browser extension and the
    phone could not share a question budget or labels);
  * webhook-only sources cannot work without a server anyway.

  Local-only remains a supported way to run, because the engines depend
  only on the port.
* **End-to-end encrypted blob sync** (on any backend). Not chosen now: the
  server could no longer enforce the card-number guard, size and raw-payload
  checks, revocation purge or retention, and relays could not write
  observations for the user. It is worth revisiting for selected fields (for
  example excerpts or merchant text) once the guards' value is weighed
  against client-held keys.
