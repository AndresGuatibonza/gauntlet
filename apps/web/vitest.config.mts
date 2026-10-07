import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Component tests for the web app. Next compiles JSX with React's
// automatic runtime, so Vite's transformer (oxc since Vite 8) is told to
// do the same here; without it a .tsx under test is not transformed the
// way the app is and fails to parse. The "@/..." alias mirrors
// tsconfig.json's paths entry.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
