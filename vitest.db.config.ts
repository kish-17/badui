import { defineConfig } from "vitest/config";

/**
 * Database tests (`npm run test:db`): they need the local PostgreSQL 16 and
 * PostgREST from `npm run db:start`, so they are kept out of the default,
 * dependency-free `npm test`. Each file creates and drops its own database,
 * but files still run one at a time: every file spawns PostgREST and opens
 * pools, and the shared local cluster is small.
 */
export default defineConfig({
  test: {
    include: ["supabase/tests/**/*.test.ts", "packages/*/test/**/*.db.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
