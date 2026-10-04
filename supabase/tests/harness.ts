/**
 * Database test harness for BRAKE's Supabase schema.
 *
 * Docker (and therefore `supabase start`) is not assumed. Tests run against a
 * plain PostgreSQL 16 (`npm run db:start`) plus a PostgREST binary, which is
 * what the Supabase API is built on. Each test file gets its own database:
 *
 *   createTestDatabase()  CREATE DATABASE brake_test_<pid>_<n>_<rand>, apply
 *                         supabase/tests/shim.sql (the Supabase roles, auth
 *                         schema and default grants) and then every file in
 *                         supabase/migrations in name order — the same order
 *                         `supabase db reset` uses — and DROP it afterwards, so
 *                         parallel runs never share state.
 *   asUser / asAnon / asService
 *                         run SQL exactly the way PostgREST does for a request:
 *                         in a transaction, `set_config('role', …, true)` plus
 *                         the JWT claims in `request.jwt.claims`. Row-level
 *                         security therefore sees the same auth.uid()/role it
 *                         would in production.
 *   startPostgrest()      the real PostgREST against a test database, with a
 *                         tiny proxy that serves it under /rest/v1 so
 *                         `@supabase/supabase-js` can talk to it unchanged.
 *
 * No dependencies beyond `pg` and node built-ins (JWTs are signed with
 * node:crypto HS256, like Supabase's legacy JWT secret).
 */
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool, escapeIdentifier } from "pg";
import type { PoolClient } from "pg";

export type { PoolClient } from "pg";

/** Repository root (this file lives in supabase/tests). */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
export const SHIM_FILE = path.join(REPO_ROOT, "supabase", "tests", "shim.sql");

/** Superuser connection to the maintenance database of the local test cluster. */
export const ADMIN_URL = process.env.BRAKE_TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/postgres";

export const POSTGREST_BIN = process.env.BRAKE_POSTGREST_BIN ?? path.join(REPO_ROOT, ".cache", "postgrest", "postgrest");

/** The three API roles Supabase maps JWTs onto. */
export type ApiRole = "anon" | "authenticated" | "service_role";

export interface JwtClaims {
  readonly role: string;
  readonly sub?: string;
  readonly [claim: string]: unknown;
}

export interface TestDatabase {
  readonly name: string;
  /** Connection string of the test database, as the superuser. */
  readonly url: string;
  /** Superuser pool. Bypasses row-level security: use it for setup and to inspect what is really stored. */
  readonly pool: Pool;
  /** Run `fn` in one transaction as role `authenticated` with `sub` = userId (a signed-in user). */
  asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Run `fn` as role `anon` (a request carrying only the public anon key). */
  asAnon<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Run `fn` as role `service_role` (the secret service key; bypasses row-level security). */
  asService<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Run `fn` with an arbitrary API role and claims, e.g. `authenticated` without a `sub`. */
  asRole<T>(role: ApiRole, claims: JwtClaims | null, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Insert an auth.users row (what Supabase Auth does on sign-up) and return its id. */
  createUser(email?: string): Promise<string>;
  /** Close the pool and DROP the database. Idempotent. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Superuser URL of an existing database on the target cluster. Default: ADMIN_URL. */
  readonly adminUrl?: string;
  /** Apply supabase/migrations after the shim (default true). */
  readonly migrate?: boolean;
}

let databaseCounter = 0;

/** True when the local test cluster accepts connections (use with `describe.skipIf`). */
export async function isDatabaseAvailable(adminUrl: string = ADMIN_URL): Promise<boolean> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Migration files in the order Supabase applies them (lexicographic by name). */
export async function migrationFiles(): Promise<string[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql")).sort();
  return names.map((n) => path.join(MIGRATIONS_DIR, n));
}

/**
 * Create an isolated database with the Supabase shim and every migration applied.
 * Each SQL file runs as one implicit transaction (a multi-statement simple
 * query), so a failing migration leaves nothing half-applied.
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = options.adminUrl ?? ADMIN_URL;
  databaseCounter += 1;
  const name = `brake_test_${process.pid}_${databaseCounter}_${randomBytes(3).toString("hex")}`;

  await withAdmin(adminUrl, async (admin) => {
    // template0: never inherit objects someone added to template1 on a shared cluster.
    await admin.query(`create database ${escapeIdentifier(name)} template template0`);
  });

  const url = databaseUrl(adminUrl, name);
  try {
    const setup = new Client({ connectionString: url });
    await setup.connect();
    try {
      await applySqlFile(setup, SHIM_FILE, { retries: 3 });
      if (options.migrate ?? true) {
        for (const file of await migrationFiles()) await applySqlFile(setup, file);
      }
    } finally {
      await setup.end();
    }
  } catch (error) {
    await dropDatabase(adminUrl, name).catch(() => undefined);
    throw error;
  }

  const pool = new Pool({ connectionString: url, max: 5 });
  // An idle client can lose its connection when the database is dropped; never crash the run for that.
  pool.on("error", () => undefined);
  let dropped = false;

  async function asRole<T>(role: ApiRole, claims: JwtClaims | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Exactly what PostgREST does per request (transaction-local role + claims).
      await client.query("select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)", [
        role,
        claims === null ? "" : JSON.stringify(claims),
      ]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    name,
    url,
    pool,
    asRole,
    asUser: (userId, fn) => asRole("authenticated", { sub: userId, role: "authenticated", aud: "authenticated" }, fn),
    asAnon: (fn) => asRole("anon", { role: "anon" }, fn),
    asService: (fn) => asRole("service_role", { role: "service_role" }, fn),
    async createUser(email) {
      const result = await pool.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [
        email ?? `user-${randomBytes(4).toString("hex")}@example.test`,
      ]);
      const id = result.rows[0]?.id;
      if (!id) throw new Error("auth.users insert returned no id");
      return id;
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end().catch(() => undefined);
      await dropDatabase(adminUrl, name);
    },
  };
}

async function applySqlFile(client: Client, file: string, opts: { retries?: number } = {}): Promise<void> {
  const sql = await readFile(file, "utf8");
  const attempts = 1 + (opts.retries ?? 0);
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(sql);
      return;
    } catch (error) {
      // Roles are cluster-wide: two runs bootstrapping them at once can collide; just retry.
      const code = (error as { code?: string }).code;
      const transient = code === "23505" || code === "42710" || code === "XX000" || code === "40001";
      if (attempt < attempts && transient) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Applying ${path.relative(REPO_ROOT, file)} failed: ${message}`, { cause: error });
    }
  }
}

async function withAdmin<T>(adminUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test PostgreSQL at ${redactUrl(adminUrl)}; start it with \`npm run db:start\` ` +
        `or set BRAKE_TEST_DATABASE_URL.`,
      { cause: error },
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withAdmin(adminUrl, (admin) => admin.query(`drop database if exists ${escapeIdentifier(name)} with (force)`));
}

function databaseUrl(adminUrl: string, database: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

function redactUrl(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
}

// ---------------------------------------------------------------- JWT -----

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign an HS256 JWT the way Supabase Auth's legacy JWT secret does. PostgREST
 * switches to the `role` claim and exposes all claims in `request.jwt.claims`.
 */
export function signJwt(claims: JwtClaims, secret: string, options: { expiresInSeconds?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...(claims.role === "authenticated" ? { aud: "authenticated" } : {}),
    iat: now,
    exp: now + (options.expiresInSeconds ?? 3600),
    ...claims,
  };
  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

// ----------------------------------------------------------- PostgREST -----

export interface PostgrestServer {
  /** PostgREST root: tables at `${url}/observations`, functions at `${url}/rpc/<name>`. */
  readonly url: string;
  /** Base URL for `createClient(supabaseUrl, key)`: PostgREST served under /rest/v1 like Supabase. */
  readonly supabaseUrl: string;
  readonly jwtSecret: string;
  /** JWT with role anon (the public "anon key"). */
  readonly anonKey: string;
  /** JWT with role service_role (the secret "service role key"). */
  readonly serviceRoleKey: string;
  /** Access token of a signed-in user (role authenticated, sub = userId). */
  userToken(userId: string): string;
  stop(): Promise<void>;
}

export interface StartPostgrestOptions {
  readonly jwtSecret?: string;
  readonly bin?: string;
  /** Max time to wait for the schema cache to load. Default 20 s. */
  readonly readyTimeoutMs?: number;
}

/**
 * Spawn PostgREST (logging in as `authenticator`, like Supabase) against the
 * given test database on a free port. Call `stop()` in afterAll.
 */
export async function startPostgrest(dbUrl: string, options: StartPostgrestOptions = {}): Promise<PostgrestServer> {
  const bin = options.bin ?? POSTGREST_BIN;
  if (!existsSync(bin)) {
    throw new Error(`PostgREST binary not found at ${bin}; run \`npm run db:start\` or set BRAKE_POSTGREST_BIN.`);
  }
  const jwtSecret = options.jwtSecret ?? randomBytes(32).toString("hex");
  const [port, adminPort] = [await freePort(), await freePort()];

  const authenticatorUrl = new URL(dbUrl);
  authenticatorUrl.username = "authenticator";
  authenticatorUrl.password = "";

  const child = spawn(bin, [], {
    env: {
      PATH: process.env.PATH ?? "",
      PGRST_DB_URI: authenticatorUrl.toString(),
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_EXTRA_SEARCH_PATH: "public, extensions",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_DB_POOL: "4",
      PGRST_DB_CHANNEL_ENABLED: "false",
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(port),
      PGRST_ADMIN_SERVER_PORT: String(adminPort),
      PGRST_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
  for (;;) {
    if (exited) {
      process.removeListener("exit", killOnExit);
      throw new Error(`PostgREST exited during startup:\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/ready`);
      if (res.status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      process.removeListener("exit", killOnExit);
      throw new Error(`PostgREST did not become ready:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const proxy = await startRestProxy(port);
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    url,
    supabaseUrl: `http://127.0.0.1:${proxyPort}`,
    jwtSecret,
    anonKey: signJwt({ role: "anon" }, jwtSecret),
    serviceRoleKey: signJwt({ role: "service_role" }, jwtSecret),
    userToken: (userId) => signJwt({ sub: userId, role: "authenticated" }, jwtSecret),
    async stop() {
      process.removeListener("exit", killOnExit);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      if (!exited) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        await exitPromise;
        clearTimeout(timer);
      }
    },
  };
}

/** Serve PostgREST under /rest/v1 (Supabase's path) so supabase-js works against it unmodified. */
async function startRestProxy(targetPort: number): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const prefix = "/rest/v1";
    const target = req.url ?? "/";
    if (!(target === prefix || target.startsWith(`${prefix}/`) || target.startsWith(`${prefix}?`))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `No local stand-in for ${target}; only ${prefix} (PostgREST) is served.` }));
      return;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: target.slice(prefix.length) || "/",
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: error.message }));
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
