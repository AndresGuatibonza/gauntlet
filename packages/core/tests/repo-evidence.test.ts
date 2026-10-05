import { describe, it, expect } from "vitest";
import {
  candidatePaths,
  CodeContextSchema,
  codeSourceRef,
  createInMemoryRepoReader,
  detectRepoSignals,
  isIgnoredPath,
  MAX_CANDIDATE_PATHS,
  MAX_READ_FILE_BYTES,
  type RepoSnapshot,
} from "../src/repo-evidence.js";
import { sampleRepoFiles, SHA } from "./repo-fixtures.js";

async function signalsFor(files: Record<string, string>, truncated = false) {
  const reader = createInMemoryRepoReader({ repository: "acme/web", ref: SHA, files, truncated });
  const snapshot = await reader.snapshot();
  return { snapshot, signals: await detectRepoSignals(snapshot, reader) };
}

describe("detectRepoSignals", () => {
  it("reads layout, declared dependencies by role, tests, CI/deployment and ownership", async () => {
    const { signals } = await signalsFor(sampleRepoFiles());
    const byType = (t: string) => signals.items.filter((i) => i.evidenceType === t);

    const [architecture, framework] = byType("architecture");
    expect(architecture!.observation).toContain("monorepo with packages in apps/web, packages/core");
    expect(architecture!.observation).toContain("TypeScript");
    expect(framework!.observation).toBe("The repository declares application frameworks: next, react (in apps/web/package.json).");

    const ai = byType("ai_usage")[0]!;
    expect(ai.observation).toContain("@anthropic-ai/sdk");
    expect(ai.observation).toContain("anthropic");
    expect(ai.observation).toContain("openai");
    // "openai-whisper" is not "openai": the Python match is per dependency word.
    expect(JSON.parse(ai.rawExcerpt)["services/ml/requirements.txt"]).toEqual(["anthropic"]);

    expect(byType("feature_flag_pattern")[0]!.observation).toContain("posthog-js");
    expect(byType("analytics_instrumentation")[0]!.observation).toContain("@vercel/analytics");
    // Vendored dependencies never count.
    expect(JSON.stringify(signals.items)).not.toContain("launchdarkly");

    const tests = byType("test_coverage");
    expect(tests.map((t) => t.observation).join(" ")).toContain("vitest");
    expect(tests.find((t) => t.observation.includes("test file(s)"))!.observation).toContain("apps/web/tests/home.test.tsx");

    expect(byType("deployment")[0]!.observation).toBe("CI configuration: .github/workflows/ci.yml; deployment configuration: vercel.json.");
    const owners = byType("ownership")[0]!;
    expect(owners.rawExcerpt).toBe("* @acme/platform\napps/web/ @acme/growth");
    expect(owners.lines).toEqual({ start: 2, end: 3 });
    expect(owners.sourceRef).toBe(`github:acme/web@${SHA}:.github/CODEOWNERS#L2-L3`);

    expect(signals.filesRead).toEqual(
      expect.arrayContaining(["package.json", "apps/web/package.json", "packages/core/package.json", "services/ml/requirements.txt", ".github/CODEOWNERS"]),
    );
    expect(signals.notInspected).toEqual([]);
    // Every deterministic item is high confidence except a "no tests found" absence.
    expect(signals.items.every((i) => i.confidence === "high")).toBe(true);
  });

  it("says what it could not see: no CODEOWNERS, no flag library, broken manifests, a truncated tree", async () => {
    const { signals } = await signalsFor({ "package.json": "{ not json", "src/index.js": "console.log(1)\n" }, true);
    expect(signals.notInspected).toEqual([
      "The provider returned a partial file tree (very large repository); files outside it were not considered.",
      "package.json (not valid JSON)",
      "No feature-flag library is declared in the manifests read; the codebase may use an in-house mechanism or none.",
      "No CODEOWNERS file: code ownership is not discoverable from the repository.",
    ]);
    const tests = signals.items.find((i) => i.evidenceType === "test_coverage")!;
    expect(tests.observation).toMatch(/^No test files were found/);
    expect(tests.confidence).toBe("medium");
  });

  it("produces items that fit the §1.7 contract once numbered", async () => {
    const { snapshot, signals } = await signalsFor(sampleRepoFiles());
    const context = {
      source: {
        provider: "github" as const,
        repository: snapshot.repository,
        ref: snapshot.ref,
        pulledAt: "2026-10-05T15:00:00.000Z",
        filesInTree: snapshot.entries.length,
        treeTruncated: false,
        filesInspected: signals.filesRead,
      },
      items: signals.items.map((item, i) => ({ ...item, id: `C${i + 1}` })),
      notInspected: signals.notInspected,
    };
    expect(CodeContextSchema.parse(context)).toEqual(context);
  });
});

describe("CodeContextSchema", () => {
  const base = {
    source: { provider: "github", repository: "acme/web", ref: SHA, pulledAt: "2026-10-05T15:00:00.000Z", filesInTree: 3, treeTruncated: false, filesInspected: ["a.ts"] },
    items: [{ id: "C1", sourceRef: "github:acme/web@x", evidenceType: "architecture", observation: "o", rawExcerpt: "{}", confidence: "high", path: null, lines: null }],
    notInspected: [],
  };

  it("rejects duplicate ids and line citations in files that were not inspected", () => {
    const dup = { ...base, items: [base.items[0], base.items[0]] };
    expect(CodeContextSchema.safeParse(dup).success).toBe(false);
    const uninspected = { ...base, items: [{ ...base.items[0], path: "b.ts", lines: { start: 1, end: 2 } }] };
    expect(CodeContextSchema.safeParse(uninspected).error?.issues[0]?.message).toBe('C1 cites lines in "b.ts", which was not inspected.');
    expect(CodeContextSchema.safeParse({ ...base, items: [{ ...base.items[0], path: "a.ts", lines: { start: 3, end: 1 } }] }).success).toBe(false);
  });

  it("requires a commit SHA and an owner/name repository", () => {
    expect(CodeContextSchema.safeParse({ ...base, source: { ...base.source, ref: "main" } }).success).toBe(false);
    expect(CodeContextSchema.safeParse({ ...base, source: { ...base.source, repository: "acme" } }).success).toBe(false);
  });
});

describe("codeSourceRef and isIgnoredPath", () => {
  it("pins references to the commit", () => {
    expect(codeSourceRef("a/b", SHA)).toBe(`github:a/b@${SHA}`);
    expect(codeSourceRef("a/b", SHA, "x/y.ts")).toBe(`github:a/b@${SHA}:x/y.ts`);
    expect(codeSourceRef("a/b", SHA, "x/y.ts", { start: 3, end: 9 })).toBe(`github:a/b@${SHA}:x/y.ts#L3-L9`);
  });

  it("ignores vendored and generated directories at any depth", () => {
    expect(isIgnoredPath("node_modules/x/index.js")).toBe(true);
    expect(isIgnoredPath("apps/web/.next/x.js")).toBe(true);
    expect(isIgnoredPath("src/distribution.ts")).toBe(false);
  });
});

describe("candidatePaths", () => {
  it("offers readable source files only, and lists the ones over the size limit", async () => {
    const files = { ...sampleRepoFiles(), "package-lock.json": "{}", "apps/web/huge.json": "x".repeat(MAX_READ_FILE_BYTES + 1), "dist/app.min.js": "x" };
    const snapshot = await createInMemoryRepoReader({ repository: "acme/web", ref: SHA, files }).snapshot();
    const { paths, tooLarge, omitted } = candidatePaths(snapshot, "pricing");
    expect(paths).toContain("apps/web/app/page.tsx");
    expect(paths).toContain(".github/CODEOWNERS");
    expect(paths).not.toContain("package-lock.json");
    expect(paths).not.toContain("apps/web/public/logo.png");
    expect(paths.some((p) => p.includes("node_modules") || p.includes(".next") || p.startsWith("dist/"))).toBe(false);
    expect(tooLarge).toEqual(["apps/web/huge.json"]);
    expect(omitted).toBe(0);
    expect(paths).toEqual([...paths].sort());
  });

  it("keeps the files that share the card's words when a repository is too large", () => {
    const entries = Array.from({ length: MAX_CANDIDATE_PATHS + 50 }, (_, i) => ({ path: `src/module${i}/file.ts`, size: 10 }));
    entries.push({ path: "src/marketing/PricingTable.tsx", size: 10 });
    const snapshot: RepoSnapshot = { repository: "acme/web", ref: SHA, entries, truncated: false };
    const { paths, omitted } = candidatePaths(snapshot, "Show the pricing table near the signup button");
    expect(paths).toHaveLength(MAX_CANDIDATE_PATHS);
    expect(omitted).toBe(51);
    expect(paths).toContain("src/marketing/PricingTable.tsx");
  });
});
