import { defineConfig } from "vitest/config";

/**
 * Default, dependency-free test run (`npm test`). Database tests need a local
 * Postgres + PostgREST and run separately via `npm run test:db`.
 */
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.db.test.ts"],
  },
});
