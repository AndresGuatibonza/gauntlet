export const SHA = "a".repeat(40);

/** A small Next.js + Python monorepo, with vendored noise that must be ignored. */
export function sampleRepoFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "packages/*"], devDependencies: { vitest: "^3", typescript: "^5" } }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "apps/web/package.json": JSON.stringify({
      dependencies: { next: "15.5.0", react: "19.0.0", openai: "^5", "posthog-js": "^1", "@vercel/analytics": "^1" },
      devDependencies: { "@playwright/test": "^1" },
    }),
    "apps/web/app/page.tsx": [
      'import { useFeatureFlagEnabled } from "posthog-js/react";',
      "",
      "export default function Home() {",
      '  const showPrice = useFeatureFlagEnabled("homepage_price");',
      "  return (",
      '    <section className="hero">',
      '      <a href="/signup">Start for free</a>',
      '      {showPrice && <span className="price">$30/mo</span>}',
      "    </section>",
      "  );",
      "}",
    ].join("\n"),
    "apps/web/app/pricing/page.tsx": 'export default function Pricing() {\n  return <h1>Pricing</h1>;\n}\n',
    "apps/web/tests/home.test.tsx": 'it("renders", () => {});\n',
    "packages/core/package.json": JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "^0.32", zod: "^3" } }),
    "packages/core/src/llm.ts": 'import Anthropic from "@anthropic-ai/sdk";\nexport const client = new Anthropic();\n',
    "services/ml/requirements.txt": "anthropic==0.40.0\nopenai-whisper==1.0  # not openai\npytest>=8\n",
    ".github/workflows/ci.yml": "on: push\njobs: {}\n",
    "vercel.json": "{}",
    ".github/CODEOWNERS": "# owners\n* @acme/platform\napps/web/ @acme/growth\n",
    "node_modules/next/package.json": JSON.stringify({ dependencies: { "launchdarkly-node-server-sdk": "1" } }),
    "apps/web/.next/server/page.js": "compiled",
    "apps/web/public/logo.png": "\u0000PNG",
  };
}

/** A contract-valid repo analysis of the sample repository, for package tests. */
export function sampleRepoAnalysis() {
  return {
    version: 1 as const,
    generatedAt: "2026-10-05T15:00:00.000Z",
    cardTitle: "Clarify pricing before the CTA",
    selection: [{ path: "apps/web/app/page.tsx", reason: "Renders the homepage hero." }],
    codeContext: {
      source: {
        provider: "github" as const,
        repository: "acme/web",
        ref: SHA,
        pulledAt: "2026-10-05T15:00:00.000Z",
        filesInTree: 15,
        treeTruncated: false,
        filesInspected: ["apps/web/app/page.tsx", "apps/web/package.json", "package.json"],
      },
      items: [
        {
          id: "C1",
          sourceRef: `github:acme/web@${SHA}:apps/web/package.json`,
          evidenceType: "feature_flag_pattern" as const,
          observation: "The repository declares feature-flag or experimentation libraries: posthog-js (in apps/web/package.json).",
          rawExcerpt: '{"apps/web/package.json":["posthog-js"]}',
          confidence: "high" as const,
          path: "apps/web/package.json",
          lines: null,
        },
        {
          id: "C2",
          sourceRef: `github:acme/web@${SHA}:apps/web/app/page.tsx#L3-L10`,
          evidenceType: "code_location" as const,
          observation: "The homepage hero renders the primary CTA and, behind a PostHog flag, a price.",
          rawExcerpt: "export default function Home() {",
          confidence: "high" as const,
          path: "apps/web/app/page.tsx",
          lines: { start: 3, end: 10 },
        },
      ],
      notInspected: [],
    },
    refinement: {
      confidence: { level: "high" as const, rationale: "One component renders the CTA.", evidenceRefs: ["C2"] },
      effort: { level: "low" as const, rationale: "A PostHog flag hook already exists.", evidenceRefs: ["C1", "C2"] },
      implementationSurface: [{ path: "apps/web/app/page.tsx", role: "Renders the hero CTA." }],
      experimentNotes: ["Reuse posthog-js flags."],
      contradictions: [],
      stillMissing: ["Current rollout of homepage_price."],
    },
  };
}
