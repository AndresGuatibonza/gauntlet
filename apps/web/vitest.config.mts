import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Component tests for the web app. Next compiles JSX with the automatic
// runtime (tsconfig "jsx": "preserve" hands it to Next's compiler), so
// esbuild is told to do the same here -- otherwise every .tsx under test
// fails with "React is not defined". The "@/..." alias mirrors
// tsconfig.json's paths entry.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
