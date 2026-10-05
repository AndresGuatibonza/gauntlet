import { describe, it, expect } from "vitest";
import {
  analyzeRepositoryForCard,
  citedCodeEvidence,
  MAX_FILE_LINES,
  parseAnalysis,
  parseSelection,
  RepoAnalysisError,
  RepoAnalysisSchema,
  shownFile,
} from "../src/repo-analysis.js";
import { createInMemoryRepoReader, detectRepoSignals, RepoAccessError, type RepoReader } from "../src/repo-evidence.js";
import { fakeLlmClient, LlmCallError } from "../src/llm-client.js";
import type { OpportunityCard } from "../src/opportunity-card.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";
import { sampleRepoFiles, SHA } from "./repo-fixtures.js";

const card = fakeOpportunityCard() as OpportunityCard;
const packet = fakeEvidencePacket();
const NOW = "2026-10-05T15:00:00.000Z";

function reader(files = sampleRepoFiles()): RepoReader {
  return createInMemoryRepoReader({ repository: "acme/web", ref: SHA, files });
}

async function signalCount(): Promise<number> {
  const r = reader();
  return (await detectRepoSignals(await r.snapshot(), r)).items.length;
}

function selection(paths = ["apps/web/app/page.tsx", "apps/web/tests/home.test.tsx"]): string {
  return JSON.stringify({ files: paths.map((path) => ({ path, reason: `Relevant: ${path}` })) });
}

function analysis(first: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    items: [
      {
        id: `C${first}`,
        path: "apps/web/app/page.tsx",
        startLine: 3,
        endLine: 10,
        evidenceType: "code_location",
        observation: "The homepage hero renders the primary CTA and, behind a PostHog flag, a price.",
        quote: 'const showPrice = useFeatureFlagEnabled("homepage_price");',
        confidence: "high",
      },
      {
        id: `C${first + 1}`,
        path: "apps/web/tests/home.test.tsx",
        startLine: 1,
        endLine: 1,
        evidenceType: "test_coverage",
        observation: "The homepage has a render test.",
        quote: 'it("renders"',
        confidence: "medium",
      },
    ],
    refinement: {
      confidence: { level: "high", rationale: "The flag and the hero are in one component.", evidenceRefs: [`C${first}`, "E1"] },
      effort: { level: "low", rationale: "A PostHog flag already gates the price.", evidenceRefs: [`C${first}`, "C4"] },
      implementationSurface: [{ path: "apps/web/app/page.tsx", role: "Renders the hero CTA and the flagged price." }],
      experimentNotes: ["Reuse the existing posthog-js flag hook; PostHog also records the exposure."],
      contradictions: [],
      stillMissing: ["Whether the homepage_price flag is already rolled out to anyone."],
    },
    ...overrides,
  });
}

/** An analysis that adds no items of its own, citing only deterministic and public evidence. */
function analysisWithoutItems(): string {
  const parsed = JSON.parse(analysis(0)) as { refinement: Record<string, { evidenceRefs?: string[] }> };
  parsed.refinement.confidence!.evidenceRefs = ["E1"];
  parsed.refinement.effort!.evidenceRefs = ["C4"];
  return JSON.stringify({ items: [], refinement: parsed.refinement });
}

describe("analyzeRepositoryForCard", () => {
  it("selects files, cites grounded lines and refines the card", async () => {
    const k = await signalCount();
    const prompts: string[] = [];
    const llm = fakeLlmClient((o, i) => {
      prompts.push(o.messages.at(-1)!.content);
      return i === 0 ? selection() : analysis(k + 1);
    });
    const result = await analyzeRepositoryForCard(card, packet, reader(), llm, { now: () => NOW });

    expect(RepoAnalysisSchema.parse(result)).toEqual(result);
    const { source, items } = result.codeContext;
    expect(source).toMatchObject({ provider: "github", repository: "acme/web", ref: SHA, pulledAt: NOW, treeTruncated: false });
    expect(source.filesInspected).toEqual(expect.arrayContaining(["apps/web/app/page.tsx", "apps/web/tests/home.test.tsx", "package.json"]));
    expect(items.map((i) => i.id)).toEqual(Array.from({ length: k + 2 }, (_, i) => `C${i + 1}`));

    const hero = items[k]!;
    // The excerpt is the file's own lines, copied by Gauntlet, not the model's quote.
    expect(hero.rawExcerpt).toBe(sampleRepoFiles()["apps/web/app/page.tsx"]!.split("\n").slice(2, 10).join("\n"));
    expect(hero.sourceRef).toBe(`github:acme/web@${SHA}:apps/web/app/page.tsx#L3-L10`);
    expect(hero.lines).toEqual({ start: 3, end: 10 });
    expect(result.refinement.implementationSurface[0]!.path).toBe("apps/web/app/page.tsx");
    expect(result.selection.map((s) => s.path)).toEqual(["apps/web/app/page.tsx", "apps/web/tests/home.test.tsx"]);

    // The selection prompt lists candidates, never vendored files; the analysis prompt numbers lines.
    expect(prompts[0]).toContain("apps/web/app/page.tsx");
    expect(prompts[0]).not.toContain("node_modules");
    expect(prompts[1]).toContain('4|   const showPrice = useFeatureFlagEnabled("homepage_price");');
    expect(prompts[1]).toContain(`Your first item id is C${k + 1}.`);
    expect(citedCodeEvidence(result, [`C${k + 1}`, "E1"]).map((c) => c.id)).toEqual([`C${k + 1}`]);
  });

  it("drops invented paths from the selection and records files it could not read", async () => {
    const k = await signalCount();
    const files = sampleRepoFiles();
    const r = reader(files);
    const flaky: RepoReader = {
      snapshot: () => r.snapshot(),
      readText: async (path) => (path === "apps/web/app/pricing/page.tsx" ? null : r.readText(path)),
    };
    const llm = fakeLlmClient([
      selection(["apps/web/app/page.tsx", "src/does-not-exist.ts", "apps/web/app/pricing/page.tsx"]),
      analysisWithoutItems(),
    ]);
    const result = await analyzeRepositoryForCard(card, packet, flaky, llm, { now: () => NOW });
    expect(result.selection.map((s) => s.path)).toEqual(["apps/web/app/page.tsx"]);
    expect(result.codeContext.notInspected).toContain("apps/web/app/pricing/page.tsx (could not be read)");
    expect(result.codeContext.items).toHaveLength(k);
  });

  it("sends a misquoted item back with the exact problem, then accepts the fix", async () => {
    const k = await signalCount();
    const bad = analysis(k + 1).replace('const showPrice = useFeatureFlagEnabled(\\"homepage_price\\");', "const showPrice = true;");
    const prompts: string[] = [];
    const llm = fakeLlmClient((o, i) => {
      prompts.push(o.messages.at(-1)!.content);
      return [selection(), bad, analysis(k + 1)][i]!;
    });
    const result = await analyzeRepositoryForCard(card, packet, reader(), llm);
    expect(prompts[2]).toContain(`C${k + 1}'s quote is not in apps/web/app/page.tsx lines 3-10`);
    expect(result.codeContext.items).toHaveLength(k + 2);
  });

  it("fails clearly after two invalid analyses, and wraps API failures", async () => {
    const k = await signalCount();
    const surface = analysis(k + 1).replace('"implementationSurface":[{"path":"apps/web/app/page.tsx"', '"implementationSurface":[{"path":"apps/web/app/missing.tsx"');
    await expect(analyzeRepositoryForCard(card, packet, reader(), fakeLlmClient([selection(), surface, surface]))).rejects.toThrow(
      /code analysis after 2 attempt\(s\).*"apps\/web\/app\/missing.tsx", which was not inspected/,
    );
    const failing = { complete: async () => Promise.reject(new LlmCallError("Connection error.")) };
    const err = await analyzeRepositoryForCard(card, packet, reader(), failing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoAnalysisError);
    expect((err as Error).message).toContain("during file selection");
  });

  it("refuses an empty repository and passes repository access errors through", async () => {
    await expect(analyzeRepositoryForCard(card, packet, reader({}), fakeLlmClient([]))).rejects.toThrow(/has no files/);
    const revoked: RepoReader = {
      snapshot: async () => Promise.reject(new RepoAccessError("GitHub rejected the access token.", "unauthorized")),
      readText: async () => null,
    };
    await expect(analyzeRepositoryForCard(card, packet, revoked, fakeLlmClient([]))).rejects.toBeInstanceOf(RepoAccessError);
  });

  it("fails when none of the chosen files can be read", async () => {
    const r = reader();
    const unreadable: RepoReader = { snapshot: () => r.snapshot(), readText: async (p) => (p.endsWith("package.json") || p.endsWith("CODEOWNERS") ? r.readText(p) : null) };
    await expect(analyzeRepositoryForCard(card, packet, unreadable, fakeLlmClient([selection()]))).rejects.toThrow(/None of the files chosen/);
  });
});

describe("parseSelection", () => {
  const candidates = new Set(["a.ts", "b.ts"]);

  it("keeps known paths once, in order", () => {
    const raw = JSON.stringify({ files: [{ path: "b.ts", reason: "r" }, { path: "zz.ts", reason: "r" }, { path: "b.ts", reason: "again" }, { path: "a.ts", reason: "r" }] });
    expect(parseSelection(raw, candidates)).toEqual({ selection: [{ path: "b.ts", reason: "r" }, { path: "a.ts", reason: "r" }] });
  });

  it("explains when nothing chosen exists, and rejects bad shapes", () => {
    expect(parseSelection(JSON.stringify({ files: [{ path: "src/a.ts", reason: "r" }] }), candidates)).toEqual({
      error: 'None of the chosen paths is in the file list ("src/a.ts"). Copy paths exactly from the list.',
    });
    expect("error" in parseSelection("nope", candidates)).toBe(true);
    expect("error" in parseSelection(JSON.stringify({ files: [] }), candidates)).toBe(true);
    expect("error" in parseSelection(JSON.stringify({ files: [{ path: "a.ts", reason: "r", extra: 1 }] }), candidates)).toBe(true);
  });
});

describe("parseAnalysis", () => {
  const file = shownFile("x.ts", "one\ntwo\nthree\n");
  const context = { repository: "acme/web", ref: SHA, files: [file], signalCount: 2, cardEvidenceRefs: ["E1"], inspected: new Set(["x.ts", "package.json"]) };
  const refinement = {
    confidence: { level: "medium", rationale: "r", evidenceRefs: ["C1"] },
    effort: { level: "low", rationale: "r", evidenceRefs: ["E1"] },
    implementationSurface: [] as { path: string; role: string }[],
    experimentNotes: [],
    contradictions: [],
    stillMissing: ["s"],
  };
  const item = { id: "C3", path: "x.ts", startLine: 2, endLine: 3, evidenceType: "code_location", observation: "o", quote: "two three", confidence: "high" };
  const run = (items: unknown[], ref = refinement) => parseAnalysis(JSON.stringify({ items, refinement: ref }), context);

  it("accepts a quote across lines (whitespace-insensitive)", () => {
    const ok = run([item]);
    expect("error" in ok).toBe(false);
    if (!("error" in ok)) expect(ok.items[0]!.rawExcerpt).toBe("two\nthree");
  });

  it.each([
    [{ ...item, id: "C5" }, 'must be "C3"'],
    [{ ...item, path: "y.ts" }, '"y.ts", which is not one of the files shown'],
    [{ ...item, endLine: 4 }, "only lines 1-3 were shown"],
    [{ ...item, quote: "four" }, "quote is not in x.ts lines 2-3"],
  ])("rejects an ungrounded item (%#)", (bad, message) => {
    const result = run([bad]);
    expect("error" in result && result.error).toContain(message);
  });

  it("rejects unknown evidence refs and implementation files that were not inspected", () => {
    const result = run([item], {
      ...refinement,
      confidence: { ...refinement.confidence, evidenceRefs: ["C9", "E7"] },
      implementationSurface: [{ path: "z.ts", role: "r" }],
    });
    expect("error" in result && result.error).toContain("unknown ids: C9, E7");
    expect("error" in result && result.error).toContain('"z.ts", which was not inspected');
  });
});

describe("shownFile", () => {
  it("numbers lines, drops the trailing newline and bounds long files", () => {
    expect(shownFile("a", "x\r\ny\n")).toEqual({ path: "a", lines: ["x", "y"], totalLines: 2 });
    const long = shownFile("b", Array.from({ length: MAX_FILE_LINES + 5 }, (_, i) => `l${i}`).join("\n"));
    expect(long.lines).toHaveLength(MAX_FILE_LINES);
    expect(long.totalLines).toBe(MAX_FILE_LINES + 5);
  });
});
