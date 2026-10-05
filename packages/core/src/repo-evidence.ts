/**
 * GitHub deep scan, part 1 (PRD Build Order #4, §8.7): the code context
 * contract and everything that needs no model.
 *
 * Contract: claude/gauntlet-evidence-contract-v0.md §1.7 (Amendment 3).
 * That doc is the source of truth.
 *
 * - RepoReader: a provider-neutral, read-only view of one repository at one
 *   commit (GitHub in production, in memory in tests).
 * - detectRepoSignals: deterministic code evidence read from a few known
 *   files -- layout and languages, declared dependencies by role (framework,
 *   AI SDKs, feature-flag, analytics and test libraries), test files, CI and
 *   deployment configuration, CODEOWNERS. No LLM, so these items are
 *   reproducible and always grounded.
 * - candidatePaths: the bounded list of source files the model may choose
 *   from for one card (repo-analysis.ts).
 */
import { z } from "zod";
import { EvidenceConfidenceSchema } from "./evidence-packet.js";

// ---------------------------------------------------------------------------
// Reading a repository
// ---------------------------------------------------------------------------

export interface RepoTreeEntry {
  path: string;
  /** Bytes, as reported by the provider. */
  size: number;
}

export interface RepoSnapshot {
  /** "owner/name". */
  repository: string;
  /** The commit SHA everything is read at. */
  ref: string;
  /** Files only (no directories). */
  entries: RepoTreeEntry[];
  /** The provider returned a partial tree. */
  truncated: boolean;
}

export interface RepoReader {
  snapshot(): Promise<RepoSnapshot>;
  /** UTF-8 text of one file at the snapshot's commit; null when missing, binary or too large. */
  readText(path: string): Promise<string | null>;
}

export type RepoAccessErrorKind = "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "failed";

/** The repository could not be read (revoked access, deleted repo, rate limit, network). */
export class RepoAccessError extends Error {
  constructor(
    message: string,
    public readonly kind: RepoAccessErrorKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RepoAccessError";
  }
}

/** Files larger than this are never read (they are listed as not inspected instead). */
export const MAX_READ_FILE_BYTES = 200_000;

/** A reader over fixed contents: tests, and any caller that already holds the files. */
export function createInMemoryRepoReader(options: {
  repository: string;
  ref: string;
  files: Record<string, string>;
  truncated?: boolean;
}): RepoReader {
  const entries = Object.entries(options.files).map(([path, content]) => ({
    path,
    size: Buffer.byteLength(content, "utf8"),
  }));
  return {
    async snapshot() {
      return { repository: options.repository, ref: options.ref, entries, truncated: options.truncated ?? false };
    },
    async readText(path) {
      const content = options.files[path];
      if (content === undefined || Buffer.byteLength(content, "utf8") > MAX_READ_FILE_BYTES) return null;
      return looksBinary(content) ? null : content;
    },
  };
}

/** A NUL byte in the first 8 KB means binary, as git itself decides. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\u0000");
}

// ---------------------------------------------------------------------------
// Contract §1.7
// ---------------------------------------------------------------------------

const text = z.string().trim().min(1);

export const CodeEvidenceTypeSchema = z.enum([
  "architecture",
  "dependency",
  "code_location",
  "ai_usage",
  "feature_flag_pattern",
  "analytics_instrumentation",
  "test_coverage",
  "ownership",
  "deployment",
]);
export type CodeEvidenceType = z.infer<typeof CodeEvidenceTypeSchema>;

export const LineRangeSchema = z
  .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
  .strict()
  .refine((r) => r.end >= r.start, "lines.end must not be before lines.start");

export const CodeEvidenceItemSchema = z
  .object({
    id: z.string().regex(/^C[1-9]\d*$/, "code evidence ids are C1, C2, ..."),
    sourceRef: text,
    evidenceType: CodeEvidenceTypeSchema,
    observation: text,
    rawExcerpt: z.string(),
    confidence: EvidenceConfidenceSchema,
    path: z.string().nullable(),
    lines: LineRangeSchema.nullable(),
  })
  .strict();
export type CodeEvidenceItem = z.infer<typeof CodeEvidenceItemSchema>;

/**
 * "owner/name" as GitHub allows it: an owner of letters, digits and inner
 * hyphens; a name of letters, digits, ".", "_" and "-" that is not "." or
 * "..". Anything else is refused before it reaches a URL.
 */
export const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export function isRepositoryName(value: string): boolean {
  return REPOSITORY_NAME.test(value);
}

export const CodeContextSourceSchema = z
  .object({
    provider: z.literal("github"),
    repository: z.string().regex(REPOSITORY_NAME, "repository is owner/name"),
    ref: z.string().regex(/^[0-9a-f]{7,40}$/, "ref is a commit SHA"),
    pulledAt: z.string().datetime(),
    filesInTree: z.number().int().min(0),
    treeTruncated: z.boolean(),
    filesInspected: z.array(z.string()),
  })
  .strict();
export type CodeContextSource = z.infer<typeof CodeContextSourceSchema>;

export const CodeContextSchema = z
  .object({
    source: CodeContextSourceSchema,
    items: z.array(CodeEvidenceItemSchema).min(1),
    notInspected: z.array(z.string()),
  })
  .strict()
  .superRefine((ctx, issues) => {
    const seen = new Set<string>();
    const inspected = new Set(ctx.source.filesInspected);
    for (const item of ctx.items) {
      if (seen.has(item.id)) {
        issues.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: `Duplicate code evidence id "${item.id}".` });
      }
      seen.add(item.id);
      // A cited line range is only verifiable in a file that was read.
      if (item.lines && (!item.path || !inspected.has(item.path))) {
        issues.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items"],
          message: `${item.id} cites lines in "${item.path ?? "(no path)"}", which was not inspected.`,
        });
      }
    }
  });
export type CodeContext = z.infer<typeof CodeContextSchema>;

/** "github:owner/name@sha[:path[#La-Lb]]" -- every item is pinned to one commit. */
export function codeSourceRef(repository: string, ref: string, path?: string | null, lines?: { start: number; end: number } | null): string {
  const base = `github:${repository}@${ref}`;
  if (!path) return base;
  return lines ? `${base}:${path}#L${lines.start}-L${lines.end}` : `${base}:${path}`;
}

// ---------------------------------------------------------------------------
// Deterministic signals
// ---------------------------------------------------------------------------

/** A §1.7 item before it is numbered. */
export type CodeEvidenceDraft = Omit<CodeEvidenceItem, "id">;

export interface RepoSignals {
  items: CodeEvidenceDraft[];
  /** Files read to produce them (manifests, CODEOWNERS...). */
  filesRead: string[];
  notInspected: string[];
}

/** Directories that never hold the product's own source. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", "coverage",
  ".git", "__pycache__", ".venv", "venv", "env", "target", ".turbo", ".cache", ".vercel", ".idea", ".vscode",
  "bower_components", "Pods", ".gradle", "tmp", ".pytest_cache", ".mypy_cache", "storybook-static",
]);

export function isIgnoredPath(path: string): boolean {
  return path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function depth(path: string): number {
  return path.split("/").length - 1;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

type DependencyRole = "framework" | "ai" | "flags" | "analytics" | "tests";

interface CatalogEntry {
  role: DependencyRole;
  /** Exact npm names, or a scope/prefix ending in "/" or "-". */
  npm?: readonly string[];
  /** Python distribution names (matched case-insensitively as words). */
  python?: readonly string[];
}

// Libraries whose presence says something about how this card's change
// would be built or measured. Deliberately short: a match is a fact, a
// miss means nothing.
const CATALOG: readonly CatalogEntry[] = [
  {
    role: "framework",
    npm: ["next", "react", "vue", "nuxt", "svelte", "@sveltejs/kit", "@remix-run/react", "astro", "@angular/core", "express", "fastify", "@nestjs/core", "hono", "solid-js", "gatsby"],
    python: ["django", "flask", "fastapi", "streamlit", "gradio"],
  },
  {
    role: "ai",
    npm: ["openai", "@anthropic-ai/sdk", "ai", "@ai-sdk/", "langchain", "@langchain/", "llamaindex", "cohere-ai", "@google/generative-ai", "@google/genai", "@mistralai/mistralai", "groq-sdk", "replicate", "@huggingface/inference", "@pinecone-database/pinecone", "@modelcontextprotocol/sdk"],
    python: ["openai", "anthropic", "langchain", "langchain-core", "langchain-openai", "langgraph", "llama-index", "litellm", "cohere", "google-generativeai", "google-genai", "transformers", "instructor", "dspy"],
  },
  {
    role: "flags",
    npm: ["launchdarkly-node-server-sdk", "launchdarkly-js-client-sdk", "launchdarkly-react-client-sdk", "@launchdarkly/", "posthog-js", "posthog-node", "@growthbook/", "unleash-client", "@unleash/", "flagsmith", "flagsmith-nodejs", "@statsig/", "statsig-node", "statsig-js", "@vercel/flags", "flags", "@openfeature/", "@splitsoftware/", "@optimizely/", "configcat-"],
    python: ["launchdarkly-server-sdk", "posthog", "growthbook", "UnleashClient", "flagsmith", "statsig", "openfeature-sdk"],
  },
  {
    role: "analytics",
    npm: ["posthog-js", "posthog-node", "@amplitude/", "amplitude-js", "mixpanel", "mixpanel-browser", "@segment/", "@vercel/analytics", "@datadog/", "dd-trace", "@sentry/", "@heap/", "@rudderstack/", "plausible-tracker"],
    python: ["posthog", "mixpanel", "amplitude-analytics", "segment-analytics-python", "sentry-sdk", "ddtrace"],
  },
  {
    role: "tests",
    npm: ["vitest", "jest", "mocha", "@playwright/test", "playwright", "cypress", "@testing-library/", "ava", "jasmine"],
    python: ["pytest", "hypothesis", "nose2"],
  },
];

const ROLE_INFO: Record<DependencyRole, { type: CodeEvidenceType; label: string }> = {
  framework: { type: "architecture", label: "application frameworks" },
  ai: { type: "ai_usage", label: "AI/LLM SDKs" },
  flags: { type: "feature_flag_pattern", label: "feature-flag or experimentation libraries" },
  analytics: { type: "analytics_instrumentation", label: "analytics or monitoring libraries" },
  tests: { type: "test_coverage", label: "test frameworks" },
};

function npmMatches(name: string, pattern: string): boolean {
  return pattern.endsWith("/") || pattern.endsWith("-") ? name.startsWith(pattern) : name === pattern;
}

/** Declared dependencies of one package.json, or null if it isn't valid JSON. */
function npmDependencies(content: string): string[] | null {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = json[key];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
    }
    return [...names];
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python names from the catalog that a requirements/pyproject file mentions as a dependency word. */
function pythonMatches(content: string, names: readonly string[]): string[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .join("\n");
  return names.filter((name) => new RegExp(`(^|[\\s"',\\[])${escapeRegExp(name)}(?=$|[\\s"'<>=~!;,\\[\\]])`, "im").test(lines));
}

const MANIFEST_LIMIT = 8;
const PYTHON_MANIFESTS = /^(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/;
const CI_FILES = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml)$/;
const DEPLOY_FILES = /^(vercel\.json|netlify\.toml|Dockerfile(\.[\w-]+)?|docker-compose[\w.-]*\.ya?ml|fly\.toml|render\.yaml|app\.yaml|Procfile|serverless\.ya?ml|wrangler\.toml|railway\.json|amplify\.yml|firebase\.json)$/;
const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|cypress)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
const WORKSPACE_FILES = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rb: "Ruby", go: "Go", java: "Java", kt: "Kotlin", swift: "Swift", php: "PHP", cs: "C#", rs: "Rust",
  vue: "Vue", svelte: "Svelte", astro: "Astro", ex: "Elixir", exs: "Elixir", scala: "Scala", dart: "Dart",
};

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function listPreview(items: readonly string[], max = 6): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/**
 * Deterministic §1.7 items for a snapshot. Reads only package manifests,
 * workspace files and CODEOWNERS; everything else comes from the file list.
 */
export async function detectRepoSignals(snapshot: RepoSnapshot, reader: Pick<RepoReader, "readText">): Promise<RepoSignals> {
  const { repository, ref } = snapshot;
  const files = snapshot.entries.filter((e) => !isIgnoredPath(e.path));
  const paths = files.map((e) => e.path);
  const items: CodeEvidenceDraft[] = [];
  const filesRead: string[] = [];
  const notInspected: string[] = [];

  if (snapshot.truncated) {
    notInspected.push("The provider returned a partial file tree (very large repository); files outside it were not considered.");
  }

  // Layout, languages and workspaces -> one architecture item.
  const topLevel = [...new Set(paths.filter((p) => depth(p) > 0).map((p) => p.split("/")[0]!))].sort();
  const languageCounts = new Map<string, number>();
  for (const p of paths) {
    const language = LANGUAGE_BY_EXTENSION[extensionOf(p)];
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const manifests = paths
    .filter((p) => baseName(p) === "package.json" && depth(p) <= 3)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, MANIFEST_LIMIT);
  const workspaceMarkers = WORKSPACE_FILES.filter((f) => paths.includes(f));
  const workspaceDirs = manifests.filter((p) => depth(p) > 0).map((p) => p.slice(0, p.lastIndexOf("/")));
  const isMonorepo = workspaceMarkers.length > 0 || workspaceDirs.length > 1;
  items.push({
    sourceRef: codeSourceRef(repository, ref),
    evidenceType: "architecture",
    observation:
      `The repository has ${files.length} source-tree files` +
      (languages.length ? `, mostly ${languages.map(([l]) => l).join(", ")}` : "") +
      (topLevel.length ? `; top-level directories: ${listPreview(topLevel, 10)}` : "") +
      (isMonorepo ? `; it is a monorepo with packages in ${listPreview(workspaceDirs, 8)}.` : "."),
    rawExcerpt: compactJson({
      files: files.length,
      languages: Object.fromEntries(languages),
      topLevel: topLevel.slice(0, 30),
      workspaces: isMonorepo ? workspaceDirs : [],
      workspaceConfig: workspaceMarkers,
    }),
    confidence: "high",
    path: null,
    lines: null,
  });

  // Declared dependencies, by role.
  const found = new Map<DependencyRole, Map<string, Set<string>>>(); // role -> manifest -> names
  const record = (role: DependencyRole, manifest: string, name: string) => {
    const byManifest = found.get(role) ?? new Map<string, Set<string>>();
    const names = byManifest.get(manifest) ?? new Set<string>();
    names.add(name);
    byManifest.set(manifest, names);
    found.set(role, byManifest);
  };
  for (const manifest of manifests) {
    const content = await reader.readText(manifest);
    if (content === null) {
      notInspected.push(`${manifest} (could not be read)`);
      continue;
    }
    filesRead.push(manifest);
    const deps = npmDependencies(content);
    if (!deps) {
      notInspected.push(`${manifest} (not valid JSON)`);
      continue;
    }
    for (const entry of CATALOG) {
      for (const dep of deps) if (entry.npm?.some((pattern) => npmMatches(dep, pattern))) record(entry.role, manifest, dep);
    }
  }
  const pythonManifests = paths
    .filter((p) => PYTHON_MANIFESTS.test(baseName(p)) && depth(p) <= 2)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, 4);
  for (const manifest of pythonManifests) {
    const content = await reader.readText(manifest);
    if (content === null) {
      notInspected.push(`${manifest} (could not be read)`);
      continue;
    }
    filesRead.push(manifest);
    for (const entry of CATALOG) {
      for (const name of pythonMatches(content, entry.python ?? [])) record(entry.role, manifest, name);
    }
  }
  for (const role of ["framework", "ai", "flags", "analytics", "tests"] as const) {
    const byManifest = found.get(role);
    if (!byManifest) continue;
    const all = [...new Set([...byManifest.values()].flatMap((s) => [...s]))].sort();
    const manifestsWithRole = [...byManifest.keys()];
    items.push({
      sourceRef: codeSourceRef(repository, ref, manifestsWithRole[0]),
      evidenceType: ROLE_INFO[role].type,
      observation: `The repository declares ${ROLE_INFO[role].label}: ${listPreview(all, 8)} (in ${listPreview(manifestsWithRole, 4)}).`,
      rawExcerpt: compactJson(Object.fromEntries([...byManifest.entries()].map(([m, s]) => [m, [...s].sort()]))),
      confidence: "high",
      path: manifestsWithRole[0]!,
      lines: null,
    });
  }
  if (!found.has("flags")) {
    notInspected.push("No feature-flag library is declared in the manifests read; the codebase may use an in-house mechanism or none.");
  }

  // Test files.
  const testFiles = paths.filter((p) => TEST_FILE.test(p));
  items.push({
    sourceRef: codeSourceRef(repository, ref, testFiles[0] ?? null),
    evidenceType: "test_coverage",
    observation:
      testFiles.length > 0
        ? `${testFiles.length} test file(s) found by common naming, e.g. ${listPreview(testFiles, 3)}.`
        : "No test files were found by common naming conventions (tests/, __tests__/, *.test.*, *.spec.*, test_*.py).",
    rawExcerpt: compactJson({ count: testFiles.length, examples: testFiles.slice(0, 10) }),
    confidence: testFiles.length > 0 ? "high" : "medium",
    path: testFiles[0] ?? null,
    lines: null,
  });

  // CI and deployment configuration.
  const ci = paths.filter((p) => CI_FILES.test(p));
  const deploy = paths.filter((p) => DEPLOY_FILES.test(baseName(p)) && depth(p) <= 3);
  if (ci.length > 0 || deploy.length > 0) {
    items.push({
      sourceRef: codeSourceRef(repository, ref, ci[0] ?? deploy[0]),
      evidenceType: "deployment",
      observation:
        [ci.length ? `CI configuration: ${listPreview(ci, 4)}` : "", deploy.length ? `deployment configuration: ${listPreview(deploy, 4)}` : ""]
          .filter(Boolean)
          .join("; ") + ".",
      rawExcerpt: compactJson({ ci, deployment: deploy }),
      confidence: "high",
      path: ci[0] ?? deploy[0]!,
      lines: null,
    });
  }

  // Ownership.
  const codeowners = CODEOWNERS_PATHS.find((p) => paths.includes(p));
  if (codeowners) {
    const content = await reader.readText(codeowners);
    if (content === null) {
      notInspected.push(`${codeowners} (could not be read)`);
    } else {
      filesRead.push(codeowners);
      const lines = content.split(/\r?\n/);
      const rules = lines
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter((l) => l.line && !l.line.startsWith("#"));
      if (rules.length > 0) {
        const shown = rules.slice(0, 20);
        items.push({
          sourceRef: codeSourceRef(repository, ref, codeowners, { start: shown[0]!.n, end: shown.at(-1)!.n }),
          evidenceType: "ownership",
          observation: `${codeowners} assigns owners with ${rules.length} rule(s).`,
          rawExcerpt: shown.map((l) => l.line).join("\n"),
          confidence: "high",
          path: codeowners,
          lines: { start: shown[0]!.n, end: shown.at(-1)!.n },
        });
      }
    }
  } else {
    notInspected.push("No CODEOWNERS file: code ownership is not discoverable from the repository.");
  }

  return { items, filesRead, notInspected };
}

// ---------------------------------------------------------------------------
// Candidate files for a card
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "java", "kt", "swift", "php", "cs", "rs",
  "vue", "svelte", "astro", "html", "css", "scss", "sass", "less", "md", "mdx", "json", "yaml", "yml", "toml",
  "sql", "graphql", "gql", "prisma", "txt", "ex", "exs", "scala", "dart", "liquid", "hbs", "ejs", "erb", "njk",
]);
const NEVER_CANDIDATES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$|\.map$|\.d\.ts$/;
const EXTENSIONLESS_CANDIDATES = new Set(["Dockerfile", "Procfile", "CODEOWNERS", "Makefile"]);

/** Most paths the selection prompt lists: bounded context (PRD §14 cost control). */
export const MAX_CANDIDATE_PATHS = 2500;

function tokens(textValue: string): Set<string> {
  return new Set(
    textValue
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4)
      .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t)),
  );
}

/**
 * Source files the model may choose from: readable text, not vendored or
 * generated, under the size limit. When there are more than
 * MAX_CANDIDATE_PATHS, the ones sharing the most words with the card are
 * kept, so a large repository still yields the relevant part.
 */
export function candidatePaths(snapshot: RepoSnapshot, cardText: string): { paths: string[]; tooLarge: string[]; omitted: number } {
  const tooLarge: string[] = [];
  const eligible: string[] = [];
  for (const entry of snapshot.entries) {
    const { path } = entry;
    if (isIgnoredPath(path) || NEVER_CANDIDATES.test(path)) continue;
    const ext = extensionOf(path);
    if (!SOURCE_EXTENSIONS.has(ext) && !EXTENSIONLESS_CANDIDATES.has(baseName(path))) continue;
    if (entry.size > MAX_READ_FILE_BYTES) {
      tooLarge.push(path);
      continue;
    }
    eligible.push(path);
  }
  if (eligible.length <= MAX_CANDIDATE_PATHS) return { paths: eligible.sort(), tooLarge, omitted: 0 };

  const wanted = tokens(cardText);
  const scored = eligible.map((path, index) => {
    const pathTokens = tokens(path.replace(/([a-z])([A-Z])/g, "$1 $2"));
    let score = 0;
    for (const t of pathTokens) if (wanted.has(t)) score += 2;
    if (/\.(md|mdx|json|ya?ml|toml|txt)$/.test(path)) score -= 1; // prefer code when trimming
    return { path, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const kept = scored.slice(0, MAX_CANDIDATE_PATHS).map((s) => s.path);
  return { paths: kept.sort(), tooLarge, omitted: eligible.length - kept.length };
}
