# Supabase backend: accounts, sync and backup

> Decision: [ADR-005](adr/005-supabase-backend.md). Schema:
> `supabase/migrations/`. Client: `@brake/supabase` (`createSupabaseStore`).
> Contract: `BrakeStore` in `packages/core/src/store.ts`.

BRAKE processes on the device (ADR-004). Parsing, fusion, classification,
learning and decisions all run there. Supabase (Postgres, PostgREST and
Supabase Auth) gives a user three things the device cannot:

* **an account**, so the data belongs to a person and not to one phone;
* **multi-device sync**, so the phone, the browser extension and a second
  device see the same observations, labels, consent and question budget;
* **backup**, so losing a phone loses neither the spending history nor the
  user's own labels and consent receipts.

The database holds only the **source of truth** that the persistence port
defines (ADR-002). Everything else is derived on the device and rebuilt from
that truth.

```
 device (Android / iOS / extension / web)                      Supabase project (one region)
 ┌──────────────────────────────────────────────┐              ┌────────────────────────────────────────────┐
 │ capture → adapters → Observation             │              │ Auth: account, JWT (auth.uid())             │
 │            fusion engine ← assertions        │  supabase-js │ PostgREST → public tables (RLS per user)    │
 │            intelligence → BrakeEvents        │ ───────────► │   observations, assertions, consent, prefs  │
 │ BrakeStore (memory / on-device)              │   anon key + │ RPC: revoke_connection, export_my_data,     │
 │ BrakeStore (createSupabaseStore) ────────────┼── user JWT ─►│      erase_my_data                          │
 └──────────────────────────────────────────────┘              │ private: retention job (pg_cron, hourly),   │
                                                               │          card-number guard, admission       │
 webhook sources (planned) ── Edge Function relay ── service ─►│ Edge Functions: relays, account deletion    │
                              runs pure adapters      role     └────────────────────────────────────────────┘
```

## What is stored, and what never is

| Stored (source of truth) | Never stored |
|--------------------------|--------------|
| Source connections and the user's grant: scopes, purposes, retention policy, status | Raw payloads: SMS or email bodies, notification text, HTML pages, provider JSON |
| Append-only consent receipts | OTPs. Adapters drop OTP messages before parsing. |
| **Observations**: extracted, structured facts with provenance | Full card numbers (PANs), full account numbers, CVVs, national ids |
| A redacted evidence excerpt per observation, with an expiry, only where the connection's policy keeps one | `TransactionCandidate`s. They are derived, and any device rebuilds them deterministically. |
| User assertions (labels, satisfaction, same or different event, dismiss, confirm), anchored to observation ids | Intelligence patches and personal models (user model, regret model). These stay on the device (ADR-004). |
| Settings, budgets, goals, rules | Free-text answers. Prompt answers are option ids only. |
| Owned instruments, masked (last 4, an opaque provider reference, a public handle) | Provider credentials and OAuth tokens. These are not in this schema; see the relays section. |
| Prompt log (question budget, regret-prompt caps, nagging guard) | Other people's words. Messaging and other third-party-content sources keep no excerpt. |
| The public capability registry (not personal) | |

Supabase Auth holds the login identity (an email address or phone number) in
`auth.users`, in the same project. BRAKE's tables reference it only by
`user_id`.

The left column is what the store writes. The right column is kept out first
by the adapters on the device, and then by database constraints and triggers
that reject a buggy or hostile client's attempt to store it (see
[Defence in depth](#defence-in-depth-in-the-database)).

## Tables

Every user table has `user_id uuid not null references auth.users(id) on
delete cascade`. `user_id` defaults to `auth.uid()`, and rows are keyed by
`(user_id, id)`, so each user's ids are a separate namespace. Id-like text
columns are declared `collate "C"`, explained under
[Hydrating a device](#hydrating-a-device-from-the-store).

| Table | Port methods | Purpose | Clients may |
|-------|--------------|---------|-------------|
| `user_settings` | `getSettings`, `putSettings` | One row per user: locale, IANA time zone (so every device evaluates "local hours" rules alike), home country and currency, weekly question budget (0–50), regret prompts on or off. `updated_at` is set by the database. | select, insert, update, delete |
| `source_connections` | `upsertConnection`, `listConnections` | One user-granted connection to one source, such as "HDFC Bank SMS alerts" or "Gmail, receipts only". Holds `kind`, label, provider, status (`active`, `paused`, `revoked`), the exact scopes and purposes granted, and the retention policy (`excerpt_ttl_ms`, `observation_ttl_ms`). Revocation is final and the connection id is permanent. | select, insert, update. **No delete**: revoke instead. |
| `consent_events` | `appendConsentEvent`, `listConsentEvents` | The user's consent receipts: granted, paused, resumed, revoked, scopes changed, retention changed. Append-only. The id comes from an identity sequence. | select, insert |
| `observations` | `putObservations`, `listObservations`, `deleteObservations` | Extracted facts. `facts` is the whole Observation JSON except `evidence.excerpt` and `evidence.excerptExpiresAt`. The excerpt lives in `evidence_excerpt` and `excerpt_expires_at` so it can expire on its own. The columns (`kind`, `spend_window`, `stage`, `received_at`, `occurred_at`, `direction`, `amount_minor`, `currency`, `merchant_key`, `confidence`) are projections of `facts`, used for indexes, paging and retention. Composite foreign key to the owner's connection, `on delete cascade`. | select, insert, delete. **No update**: observations are immutable (ADR-002). |
| `user_assertions` | `putAssertion`, `listAssertions`, `deleteAssertion` | What the user told BRAKE. `body` is the whole UserAssertion. `anchors` (1–50 observation ids) has a GIN index because retention looks it up. Anchors are deliberately not foreign keys: an anchor may name an observation that only another device has synced so far, or one that retention or revocation has since removed. | select, insert, update, delete |
| `budgets` | `listBudgets`, `putBudget`, `deleteBudget` | A spending limit per category (or all) and period (weekly or monthly) in one currency. When `Budget.id` is absent the store derives `${category ?? "all"}:${period}:${currency}`. | select, insert, update, delete |
| `goals` | `listGoals`, `putGoal`, `deleteGoal` | Savings goals: target, saved, one currency, optional date. | select, insert, update, delete |
| `user_rules` | `listRules`, `putRule`, `deleteRule` | User-defined spending rules: description, level (`inform`, `reflect`, `pause`) and matching criteria (`rule` jsonb, limited to `category`, `minAmount`, `localHours` and `channel`). | select, insert, update, delete |
| `owned_instruments` | `listOwnedInstruments`, `putOwnedInstrument`, `deleteOwnedInstrument` | The user's own accounts, cards, wallets and UPI handles, which transfer-versus-spending reconciliation needs. Masked identifiers only: `last4` must match `^\d{4}$`. | select, insert, update, delete |
| `prompt_log` | `logPrompt`, `listPrompts` | Which question, regret prompt, intervention or insight was shown and when, and which option was chosen. Shared across devices so the question budget and the nagging guard hold whichever device asks. `anchor` is an observation id, because candidates are derived. `answer` must match `^[a-z0-9_:-]{1,64}$`. | select, insert, update, delete |
| `capability_registry` | (read by `@brake/capabilities`) | Versioned, public, non-personal registry documents covering countries, platforms and sources. | anon and authenticated: select. Only service_role writes. |

`exportAll` and `eraseAll` map to the RPCs `export_my_data()` and
`erase_my_data()`. `revokeConnection` maps to `revoke_connection()`.

## Access model: row-level security

PostgREST exposes every table in `public` as an HTTP API, and hosted Supabase
grants `anon`, `authenticated` and `service_role` broad default privileges on
every new table and function there. So the API is the schema, and the schema
has to defend itself:

1. **RLS is enabled on every table.** Without it, the default grants would
   give every signed-in user every row.
2. **Policies target only `authenticated`** and are keyed on
   `user_id = (select auth.uid())`, in `USING` (which rows can be seen,
   updated or deleted) and in `WITH CHECK` (which rows can be written). A
   client can neither read another user's row nor write a row with someone
   else's `user_id`, and an update cannot hand a row to another user.
3. **Why `(select auth.uid())` and not `auth.uid()`:** wrapped in a scalar
   subquery, the planner evaluates it once per statement (an InitPlan) and
   compares a constant, so the `(user_id, …)` indexes are used. A bare
   `auth.uid()` is a function call that can be re-evaluated for every row.
   Supabase's performance advisor flags the bare form. The result is the
   same, the cost is not.
4. **Explicit grants, least privilege.** The migration revokes Supabase's
   defaults from `anon` and `authenticated`. It then grants `authenticated`
   exactly the commands the port uses, table by table, and creates a policy
   only for each granted command. `TRUNCATE`, `REFERENCES` and `TRIGGER` are
   never granted: `TRUNCATE` bypasses RLS. `anon` (the public API key alone)
   gets nothing on user tables, because there is no anonymous BRAKE data.
   Anonymous sign-ins stay disabled in `config.toml`: an anonymous Supabase
   user receives the `authenticated` role.
5. **`service_role` keeps full access** and bypasses RLS. Its key exists only
   on trusted servers (Edge Functions, operational tooling), never in an app.
6. **Functions:** `EXECUTE` is revoked from `PUBLIC` and `anon` on every RPC.
   Every function sets `search_path = ''` and fully qualifies names, so a
   caller-controlled search path cannot redirect a `SECURITY DEFINER` body.
   Only `erase_my_data()`, the card-number trigger, the consent-id trigger
   and the retention job run as definer. `revoke_connection()` and
   `export_my_data()` run as the caller, under RLS, and also filter on
   `auth.uid()` explicitly.
7. **Internals live in schema `private`**, which the API does not expose and
   API roles cannot use: trigger helpers and `private.apply_retention()`.

The same policies cover Supabase's GraphQL endpoint (`graphql_public`),
because it executes as the same roles. The isolation tests in
`supabase/tests/db.test.ts` (SQL, as each role) and
`packages/supabase/test/store.db.test.ts` (supabase-js through PostgREST)
check that one user's token cannot read, overwrite, delete, revoke or erase
another user's data.

## Consent receipts are append-only

`consent_events` is the user's record of what they agreed to and when.
Clients have `SELECT` and `INSERT` only. With no `UPDATE` or `DELETE` grant
and no policy for either, both are refused twice over. A receipt that can be
edited is not a receipt. The id is `generated always as identity`. A trigger
also rejects `OVERRIDING SYSTEM VALUE` ids ahead of the sequence: the id is a
table-wide key, so claiming future ids would make other users' receipts
collide. Only `erase_my_data()` (the right to erasure) and account deletion
remove receipts.

## Revoke and purge

`revoke_connection(p_connection_id, p_at default now())` implements
`BrakeStore.revokeConnection`. In one transaction it:

1. locks the caller's connection row, raising `P0002` for an unknown
   connection and the same error for another user's, so the error does not
   reveal which ids exist;
2. sets `status = 'revoked'` and `revoked_at`, and appends a `revoked`
   consent receipt (once: a second revoke adds no receipt and keeps the
   original `revoked_at`);
3. deletes **every** observation of that connection, including ones anchored
   by user assertions (revocation outranks retention), and returns the count.

Devices then call `FusionEngine.removeObservations` and recompute. Nothing
else needs special handling (ADR-002).

Revocation is final:

* a trigger stops a revoked connection from becoming active again or
  changing `revoked_at`, and makes `connection_id` permanent;
* clients cannot `DELETE` a connection, which would erase the grant without
  a receipt and free its id;
* re-consenting creates a new connection id with a new `granted` receipt.

The `observations_admit` trigger silently skips observations that arrive
for a revoked connection. An offline device's queued sync therefore
completes, reports fewer inserted rows, and does not bring back data the
user asked to delete. The trigger reads the connection `FOR KEY SHARE`, so an
insert racing a concurrent revocation either waits and is then deleted, or
waits and then sees `revoked`.

## Retention job

`private.apply_retention(p_now default now())` is the server-side twin of
core's `applyRetention`, so the backup never keeps more than a device would:

* **Facts:** it deletes observations older than their connection's
  `observation_ttl_ms`. Age is measured from `least(occurred_at,
  received_at)`, so a future-dated event cannot extend its life. An
  observation that one of the same user's assertions anchors is kept, so the
  user's label does not silently disappear. `observation_ttl_ms = null`
  means keep until disconnect.
* **Excerpts:** it clears `evidence_excerpt` when the adapter's expiry or
  `received_at + excerpt_ttl_ms` has passed, whichever comes first, and
  clears every excerpt of a connection whose policy now keeps none
  (`excerpt_ttl_ms = 0`).
* TTL arithmetic is in numeric epoch milliseconds, so one user's absurd TTL
  cannot overflow and abort the job for everyone. An `UPDATE` only re-scans
  values that changed, so a row stored under an older detector cannot abort
  it either.

Writes are bounded as well: when an observation is inserted, the admission
trigger caps `excerpt_expires_at` at `received_at + excerpt_ttl_ms` and drops
the excerpt entirely for zero-TTL connections.

**Scheduling.** The functions migration schedules the job hourly at minute 7
(`brake_apply_retention`, `7 * * * *`) with `pg_cron`, **only when the
extension is available**. A guarded `DO` block keeps plain Postgres (local
tests, self-hosting without pg_cron) from failing the migration. Where it is
missing, run `select * from private.apply_retention();` from an external
scheduler as the database owner. Only the owner can execute it: not `anon`,
not `authenticated`, not even `service_role`.

## Export and erasure

* **Export** (`exportAll` → `export_my_data()`): returns
  `{ exported_at, user_settings: [...], source_connections: [...],
  consent_events: [...], observations: [...], user_assertions: [...],
  budgets: [...], goals: [...], user_rules: [...], owned_instruments: [...],
  prompt_log: [...] }` for `auth.uid()`. The store maps it back to the port's
  `BrakeExport` (camelCase domain objects in listing order). It raises
  `42501` without a signed-in user.
* **Erase data** (`eraseAll` → `erase_my_data()`): deletes every row of the
  caller in every table, consent receipts included. It is
  `SECURITY DEFINER` because receipts and connections are not deletable by
  clients, and it trusts nothing but `auth.uid()`. It raises `42501` when
  `auth.uid()` is null, so it can never match everything.
* **Delete the account:** removing the `auth.users` row requires Supabase
  Auth's admin API, which needs the service role key. That key must never
  ship in a client, so account deletion runs on a trusted server or in an
  Edge Function. The function verifies the caller's JWT, calls
  `auth.admin.deleteUser(<that user's id>)`, and the
  `on delete cascade` on every table removes anything still stored. The
  recommended flow is `eraseAll()` first (data is gone even if the next step
  fails), then the deletion function, then sign out and wipe local stores.
  After deletion, a stale device token can no longer write: every insert
  fails the `auth.users` foreign key.

## Defence in depth in the database

Adapters redact and minimise on the device. That is the primary control. The
database adds checks that a buggy or hostile client cannot bypass:

* **Card-number guard.** A trigger rejects (SQLSTATE `23514`) any row whose
  text contains what looks like a full card number. That means a Luhn-valid
  run of 13–19 contiguous digits, or a printed 4-4-4-4(-1..3) or 4-6-4/5
  layout with spaces or dashes, bounded by non-word characters (the adapters'
  redaction rule). It covers:
  * observation `facts` (every object key and every string value at any
    depth), `evidence_excerpt` and `merchant_key`;
  * assertion `body` and `anchors`;
  * prompt `anchor`;
  * connection `label` and `provider`;
  * instrument `issuer`, `account_ref` and `handle`.

  Exempt are string values at exactly five Observation paths, where machine
  identifiers are numeric by design and pass Luhn by chance (about 1 in 10):
  `merchant.website`, `intent.url`, `intent.productId`,
  `lineItems[n].productId` and `references[n].value`. A `url` or `references`
  anywhere else is scanned. JSON numbers are not scanned, because they are
  minor-unit amounts and epoch-millisecond instants. The error names the
  column but never echoes the value, so logs do not become where the leaked
  number ends up. On `UPDATE` only changed values are judged. Values over a
  column's size limit are not scanned at all, because the size check rejects
  them anyway and scanning them first would cost CPU.

  This is a backstop, not redaction. It misses other digit groupings, PANs
  glued to letters or `_`, and non-ASCII digits. It can also refuse a
  standalone 13–19 digit number that passes Luhn by chance. The in-memory
  store (`packages/core/src/store-memory.ts`) implements the same detector,
  and a parity test runs one corpus through both.
* **No raw payloads.** `facts` must be a JSON object without top-level
  `payload`, `raw`, `rawPayload`, `body`, `html` or `text`. It must not carry
  the excerpt, and it is limited to 32 KiB (`pg_column_size`).
* **Bounded sizes everywhere.** Ids and anchors are ≤ 512 characters. Grant
  lists are ≤ 64 entries and 8 KiB. Assertion bodies and anchors are ≤ 32
  KiB. Rule criteria are ≤ 4 KiB. Excerpts are ≤ 500 characters. A signed-in
  user cannot use the database as file storage or burn CPU on giant
  documents.
* **Projections agree with facts.** `observations.id` and `connection_id`
  must equal `facts.id` and `facts.source.connectionId`, because revocation
  and retention delete by the columns. Instants must be finite (`infinity`
  would never age out).
* **Integer money, closed vocabularies.** Amounts are `bigint` minor units
  (≥ 0, direction separate). Currencies and countries must be upper-case ISO
  codes. Every enum in the port has a check constraint.

The memory store enforces the same rules with the same SQLSTATEs, so code
that works against it does not start failing against Postgres.

## Hydrating a device from the store

Candidates are not stored, so a new or restored device rebuilds them. The
fusion engine is deterministic: the same observations, in the same order,
with the same assertions, give the same candidates and the same candidate
ids.

```ts
import { createClient } from "@supabase/supabase-js";
import { systemClock, type Observation } from "@brake/core";
// packages/core/src/fusion/engine.ts; not yet re-exported from @brake/core (see open items).
import { restoreFusionEngine } from "@brake/core/src/fusion/engine";
import { createSupabaseStore, type Database } from "@brake/supabase";

// The publishable values only (SUPABASE_URL, SUPABASE_ANON_KEY); the user signs in through Supabase Auth.
const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
const { data } = await client.auth.getSession();
const store = createSupabaseStore({ client, userId: data.session!.user.id });

// 1. Page through observations in the store's order: (receivedAt, id).
const observations: Observation[] = [];
let after: string | undefined;
do {
  const page = await store.listObservations({ after, limit: 1000 });
  observations.push(...page.items);
  after = page.next;
} while (after !== undefined);

// 2. Replay them with the user's assertions in one rebuild. Intelligence
//    patches are derived too, and are re-applied by the intelligence layer.
const engine = restoreFusionEngine(
  { version: 1, observations, assertions: await store.listAssertions(), patches: [] },
  { clock: systemClock },
);
```

Things to know:

* **Order is part of determinism.** Ties on `receivedAt` are ordered by id.
  The id columns are `collate "C"`, so Postgres orders by code point exactly
  as the in-memory store does, whatever default collation the hosted cluster
  was created with. Without that, a cluster with a linguistic default (for
  example en_US) would order `obs_a, obs_ä, obs_B, obs-c`. Pagination would
  still be complete, but the replay order, and therefore candidate ids,
  would differ between devices.
* **Candidate ids are local.** A device that ingested live (in arrival order)
  and one that replayed from the store can name a candidate differently.
  That is why everything shared references **observation** ids: assertion
  anchors, prompt-log anchors, intelligence patch anchors.
* **Incremental sync.** After hydration, a device writes new observations
  with `putObservations` (idempotent, `ON CONFLICT DO NOTHING`, 500 rows per
  atomic batch, safe to retry) and pulls others' with
  `listObservations({ since })`. A revoked connection's late rows are
  skipped server-side, and `inserted` reports what really landed.
* **Prompts and settings** are read on start-up (`listPrompts(since)`,
  `getSettings`) so the weekly question budget and nagging guard count every
  device's prompts.
* **Retention on the device** still runs `applyRetention`. The server job only
  guarantees that the backup is never kept longer.

Both stores implement the port: `createMemoryStore` (reference,
offline-only, tests) and `createSupabaseStore`. Both pass one contract suite,
`packages/core/test/store-contract.ts`, the second through supabase-js,
PostgREST 13 and Postgres 16. The Supabase client must be authenticated as
`userId`. Never construct it with a service-role client: `service_role`
bypasses RLS.

## Applying to a hosted project

1. **Create one project per residency zone** and pick its region
   deliberately. A Supabase project, its Auth users and its backups live in
   one region, so for example South Asia (Mumbai) serves users in India and
   an EU region (Frankfurt) serves EU users. Route each account to its
   zone's project at sign-up. Whether a given market legally requires
   residency is a question for counsel, per market.
2. **Link and push** with the Supabase CLI (installed separately; it is not
   an npm dependency of this repo):

   ```sh
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push --dry-run   # review the migrations it will apply
   supabase db push             # applies supabase/migrations in name order
   ```

   Only `supabase/migrations/` is pushed. `supabase/tests/shim.sql` stands in
   for Supabase locally and must never become a migration. `seed.sql` is
   intentionally empty.
3. **Check the retention schedule** after the push:
   `select jobname, schedule from cron.job;` should list
   `brake_apply_retention`. If the push printed a `pg_cron could not be
   enabled` warning, enable pg_cron (Dashboard → Database → Extensions) and
   re-run the scheduling block from the functions migration.
4. **Auth settings:** keep anonymous sign-ins disabled. Configure the sign-in
   methods the apps use, and the site and redirect URLs.
5. **API settings:** keep the exposed schemas at `public` (never `private`).
   Keep Max Rows at 1000, or pass the lower value as
   `createSupabaseStore({ maxRows })`.
6. **Keys and environment variables:**

   | Where | Variables | Notes |
   |-------|-----------|-------|
   | Apps, extensions, web clients | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Public by design. The anon (publishable) key only identifies the project; RLS and the user's JWT decide access. |
   | Trusted servers, Edge Functions only | `SUPABASE_SERVICE_ROLE_KEY` (plus the two above) | Bypasses RLS. Never in a client bundle, a mobile app, logs or a repository. Edge Functions receive it as a built-in secret. |

   Projects that use Supabase's newer publishable and secret API keys map
   them the same way (publishable on clients, secret on servers).
7. **Run Supabase's security and performance advisors** (Dashboard →
   Advisors). They should report no table without RLS, no mutable
   `search_path`, and no per-row `auth.uid()` calls.

Schema changes are API changes, because old app versions keep calling the
old columns. Ship migrations as expand-then-contract (add, backfill, switch
clients, then drop), and run `npm run test:db` on every migration.

## Local testing without Docker

The Supabase CLI's local stack needs Docker. The database tests do not:

```sh
npm run db:start   # PostgreSQL 16 on localhost:54329 (trust auth, disposable) + PostgREST 13.0.4 in .cache/postgrest
npm run test:db    # vitest --config vitest.db.config.ts
npm run db:stop    # stops the server, keeps the cluster
```

* `db:start` is idempotent. It needs PostgreSQL 16 server binaries
  (`BRAKE_PG_BIN` overrides the search) and downloads the PostgREST binary
  once. Override the port, data directory and OS user with `BRAKE_PG_PORT`,
  `BRAKE_PG_DIR` and `BRAKE_PG_OS_USER`. The tests read
  `BRAKE_TEST_DATABASE_URL` and `BRAKE_POSTGREST_BIN`.
* Each test file creates its own database (`brake_test_<pid>_<n>_<hex>`),
  applies `supabase/tests/shim.sql` and then every migration in name order,
  and drops the database afterwards, so parallel runs never collide. The
  shim recreates what hosted Supabase provides before any migration: the
  `anon`, `authenticated`, `service_role` and `authenticator` roles, a
  minimal `auth.users` with `auth.uid()` reading PostgREST's JWT claims, and
  Supabase's broad default grants (on purpose, so a missing revoke fails a
  test instead of leaking in production).
* `supabase/tests/harness.ts` runs SQL as each API role (`asUser`, `asAnon`,
  `asService`, `asRole`), signs HS256 JWTs, and starts a real PostgREST per
  test file on a free port, served under `/rest/v1` so supabase-js works
  unchanged.
* `supabase/tests/db.test.ts` covers the schema, RLS, grants, RPCs,
  retention and the security-review regressions.
  `packages/supabase/test/store.db.test.ts` runs the port's contract suite
  through supabase-js, plus isolation, batching, row caps, a non-UTC database
  time zone and an ICU (en-US) default collation.
* The shim is an approximation. pg_cron scheduling, Supabase Auth itself,
  asymmetric JWT signing keys and the non-superuser `postgres` role of
  hosted projects are not exercised. Run `supabase db push --dry-run`
  against a staging project before production.

## Planned: Edge Function relays for webhook sources

Some sources deliver to a server, not to a device: Plaid transaction
webhooks, Account Aggregator FI data for a Financial Information User (FIU),
and card-issuer or card-network feeds. They need a server for token custody
and webhook receipt (ADR-004). The plan is an Edge Function relay per source
family that:

1. **verifies the webhook** (the provider's signature or JWT) and fetches the
   data with the user's provider token. Tokens live in server-only storage
   (Supabase Vault or a table in a non-exposed schema), never in `public`;
2. **runs the same pure adapter** from `@brake/adapters` that a device would
   run. They are I/O-free TypeScript, portable to the Deno runtime. The raw
   payload exists only in the function's memory, and is never persisted,
   queued or logged;
3. **stores only the extracted observations**, through a narrow RPC granted
   only to `service_role`. The RPC takes the user and connection from the
   relay's own connection mapping, never from the payload, and checks that
   the connection belongs to that user. Admission (revoked connections
   skipped, excerpt policy) and the card-number guard apply exactly as for a
   device's writes. Deterministic observation ids make webhook retries
   no-ops;
4. **honours consent both ways:** a BRAKE revocation also revokes at the
   provider (for example, removing the Plaid item or revoking the AA
   consent), and a provider-side revocation notice revokes the BRAKE
   connection;
5. **runs in the project's region**, pinned where the platform allows, so
   payloads do not leave the residency zone.

Devices then receive these observations through normal sync. The relay
transmits and keeps less than forwarding raw payloads to devices would (see
ADR-005).

Account deletion (above) is the first Edge Function. The relays will be
built per source as those integrations land.

## Known limitations and open items

* **Retention TTL of zero.** Core's `validateRetentionPolicy` accepts
  `observationTtlMs = 0`. The schema (`observation_ttl_ms > 0`) and both
  stores reject it (`23514`). No default policy uses 0. Core should reject it
  too, or the product should define what "keep no facts" means.
* **No tombstones after `eraseAll`.** An offline device that later upserts
  its stale copy of a connection re-creates it. Deleting the auth account
  closes this, because stale tokens fail the foreign key.
* **Batch atomicity.** The Supabase store commits each 500-row batch
  separately. Every write is idempotent, so retrying is safe.
* **Large accounts.** `export_my_data()` is one statement, and the retention
  job runs unbatched across all users. Both may need paging or batching
  under hosted statement timeouts at scale.
* **No retention rule for `prompt_log`**, because the spec defines none.
* **Unused grants.** `user_settings` and `prompt_log` still grant `DELETE`,
  which the port does not use.
* **Core exports.** `@brake/core`'s index does not yet re-export
  `createMemoryStore`/`StoreError` (`store-memory.ts`) or the fusion engine
  factories (`fusion/engine.ts`). `packages/supabase/src/rows.ts` therefore
  keeps copies of a few store helpers, pinned to the originals by parity
  tests.
* **Plaintext at rest.** Facts are readable by the operator (`service_role`,
  database access), although the provider encrypts them at rest. Minimising,
  redacting and retaining less is the mitigation. End-to-end encryption
  would rule out the server-side guards, retention and relays (see ADR-005).
