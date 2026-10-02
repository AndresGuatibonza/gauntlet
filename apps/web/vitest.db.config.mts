import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database integration tests (tests-db/), run against a real Postgres:
// TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres DATABASE_SSL=disable npm run test:db
// Each test file creates and drops its own throwaway database, so files
// can't see each other's rows. Not part of `npm test`: CI runs it in a
// separate job with a Postgres service container.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests-db/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
