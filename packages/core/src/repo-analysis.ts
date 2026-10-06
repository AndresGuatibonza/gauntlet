/**
 * GitHub deep scan, part 2 (PRD Build Order #4, §8.7): the code context and
 * repo-aware refinement for ONE Opportunity Card.
 *
 * Contract: claude/gauntlet-evidence-contract-v0.md §1.7 and §2.4
 * (Amendment 3). That doc is the source of truth.
 *
 * analyzeRepositoryForCard:
 * 1. Snapshot the tree at one commit; deterministic signals (repo-evidence.ts).
 * 2. Selection (one Claude call): up to MAX_SELECTED_FILES candidate paths
 *    relevant to this card. Paths outside the candidate list are dropped.
 * 3. Read those files (bounded), number their lines.
 * 4. Analysis (one Claude call): code evidence items that cite a file it was
 *    shown and a line range in it, with a short quote that must appear in
 *    those lines -- plus the refinement of the card (confidence, effort,
 *    implementation surface, experiment notes, contradictions, still missing).
 *    Gauntlet copies the cited lines itself; the model never supplies them.
 * Every rule is enforced here; a response that breaks one is sent back once
 * with the exact problem, like the Scientist, Reviewer and "Build this".
 */
import { z } from "zod";
import type { EvidencePacket } from "./evidence-packet.js";
import { LlmCallError, type LlmClient, type LlmMessage, type LlmPurpose } from "./llm-client.js";
import { ConfidenceLevelSchema, EffortLevelSchema, type OpportunityCard } from "./opportunity-card.js";
import { citedEvidenceFor, type CitedEvidence } from "./action-package.js";
import {
  candidatePaths,
  codeSourceRef,
  CodeContextSchema,
  CodeEvidenceTypeSchema,
  detectRepoSignals,
  RepoAccessError,
  type CodeEvidenceDraft,
  type CodeEvidenceItem,
  type RepoReader,
} from "./repo-evidence.js";

export const REPO_ANALYSIS_VERSION = 1;
export const MAX_SELECTED_FILES = 12;
/** Lines of one file shown to the model; longer files are cut there (and the cut is recorded). */
export const MAX_FILE_LINES = 800;
const MAX_FILE_CHARS = 60_000;
/** All selected files together, so the analysis prompt stays bounded (PRD §14). */
const MAX_TOTAL_CHARS = 240_000;
const MAX_CITED_LINES = 60;
const MAX_QUOTE_CHARS = 600;
const MAX_EXCERPT_CHARS = 1_500;

export class RepoAnalysisError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RepoAnalysisError";
  }
}

const text = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Contract §2.4
// ---------------------------------------------------------------------------

const RevisedLevelSchema = <T extends z.ZodTypeAny>(level: T) =>
  z.object({ level, rationale: text, evidenceRefs: z.array(text).min(1) }).strict();

export const RepoRefinementSchema = z
  .object({
    confidence: RevisedLevelSchema(ConfidenceLevelSchema),
    effort: RevisedLevelSchema(EffortLevelSchema),
    implementationSurface: z.array(z.object({ path: text, role: text }).strict()).max(10),
    experimentNotes: z.array(text).max(5),
    contradictions: z.array(text).max(5),
    stillMissing: z.array(text).min(1).max(6),
  })
  .strict();
export type RepoRefinement = z.infer<typeof RepoRefinementSchema>;

export const FileSelectionSchema = z.array(z.object({ path: text, reason: text }).strict()).min(1).max(MAX_SELECTED_FILES);
export type FileSelection = z.infer<typeof FileSelectionSchema>;

export const RepoAnalysisSchema = z
  .object({
    version: z.literal(REPO_ANALYSIS_VERSION),
    generatedAt: z.string().datetime(),
    cardTitle: z.string(),
    selection: FileSelectionSchema,
    codeContext: CodeContextSchema,
    refinement: RepoRefinementSchema,
  })
  .strict();
export type RepoAnalysis = z.infer<typeof RepoAnalysisSchema>;

// ---------------------------------------------------------------------------
// Model outputs
// ---------------------------------------------------------------------------

const SelectionResponseSchema = z.object({ files: z.array(z.object({ path: text, reason: text }).strict()).min(1).max(MAX_SELECTED_FILES) }).strict();

const ModelItemSchema = z
  .object({
    id: z.string(),
    path: text,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    evidenceType: CodeEvidenceTypeSchema,
    observation: text,
    quote: text,
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const AnalysisResponseSchema = z
  .object({
    items: z.array(ModelItemSchema).max(15),
    refinement: RepoRefinementSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** The card as the model sees it: without the computed rank score. */
function cardForPrompt(card: OpportunityCard): Omit<OpportunityCard, "rankScore"> {
  const rest: Partial<OpportunityCard> = { ...card };
  delete rest.rankScore;
  return rest as Omit<OpportunityCard, "rankScore">;
}

const SELECTION_SYSTEM = `You are the file-selection step of Gauntlet's GitHub deep scan. Given one product Opportunity Card (an evidence-backed experiment chosen from the product's public website) and the list of source files in the product's repository, you pick the few files an engineer would open first to implement and measure THIS card's experiment.

Rules:
1. Choose 1-${MAX_SELECTED_FILES} paths, copied exactly from the list. Never invent or shorten a path.
2. Prefer: the code that renders or serves the surface the card changes; where a similar feature flag or experiment is already read; where analytics events for the card's primary metric would be sent; the tests next to that code. Skip generic config unless the card is about it.
3. Do not analyze yet; just choose. "reason" is one short sentence per file.

Respond with ONLY one JSON object, no code fences, no prose:
{"files": [{"path": string, "reason": string}, ...]}`;

function selectionPrompt(card: OpportunityCard, packet: EvidencePacket, signals: CodeEvidenceItem[], paths: string[], omitted: number): string {
  return [
    `Product: ${packet.productIdentity.productName} (${packet.productIdentity.url}).`,
    "",
    "Opportunity Card:",
    JSON.stringify(cardForPrompt(card), null, 2),
    "",
    "What Gauntlet already knows about the repository (deterministic):",
    signals.map((s) => `- ${s.id}: ${s.observation}`).join("\n"),
    "",
    `Source files (${paths.length}${omitted ? `; ${omitted} less related files omitted` : ""}):`,
    paths.join("\n"),
  ].join("\n");
}

const ANALYSIS_SYSTEM = `You are the code-analysis step of Gauntlet's GitHub deep scan. You read the files chosen for ONE product Opportunity Card and report what the code shows about implementing and measuring that card's experiment. You refine the existing card; you never start an unrelated analysis.

Ground rules, non-negotiable:
1. Every item cites one file you were shown and a line range in it (startLine..endLine, at most ${MAX_CITED_LINES} lines, within the lines shown). "quote" is a short exact snippet (one or two lines, copied character for character) from inside that range. An item whose quote is not in those lines is rejected.
2. Observations are factual statements about the code, one sentence each. No guesses about runtime behavior, traffic or users.
3. Item ids continue the existing sequence: the deterministic items are C1..C{k}; yours are C{k+1}, C{k+2}, ... in order.
4. The refinement revises the card using code evidence:
   - confidence and effort: a level, a one-sentence rationale, and evidenceRefs (ids of C items, and the card's own E*/A* ids if relevant).
   - implementationSurface: files from the ones you were shown, each with its role in this change. Empty if the repository does not contain the code this card needs; say so in stillMissing.
   - experimentNotes: how to run the card's experiment in this codebase (an existing flag or analytics library, where events are sent). Do not redesign the experiment.
   - contradictions: where the code contradicts what the card assumed from the public website. Empty if none.
   - stillMissing: what this targeted read could not settle (1-6).

Respond with ONLY one JSON object, no code fences, no prose:
{
  "items": [{"id": "C<n>", "path": string, "startLine": number, "endLine": number, "evidenceType": "architecture"|"dependency"|"code_location"|"ai_usage"|"feature_flag_pattern"|"analytics_instrumentation"|"test_coverage"|"ownership"|"deployment", "observation": string, "quote": string, "confidence": "high"|"medium"|"low"}, ...],   // 0-15
  "refinement": {
    "confidence": {"level": "low"|"medium"|"high", "rationale": string, "evidenceRefs": [string, ...]},
    "effort": {"level": "low"|"medium"|"high", "rationale": string, "evidenceRefs": [string, ...]},
    "implementationSurface": [{"path": string, "role": string}, ...],   // 0-10
    "experimentNotes": [string, ...],   // 0-5
    "contradictions": [string, ...],    // 0-5
    "stillMissing": [string, ...]       // 1-6
  }
}`;

export interface ShownFile {
  path: string;
  /** Lines shown to the model (1-based numbering). */
  lines: string[];
  totalLines: number;
}

function numbered(file: ShownFile): string {
  const width = String(file.lines.length).length;
  const body = file.lines.map((line, i) => `${String(i + 1).padStart(width, " ")}| ${line}`).join("\n");
  const cut = file.lines.length < file.totalLines ? ` (first ${file.lines.length} of ${file.totalLines} lines)` : ` (${file.totalLines} lines)`;
  return `=== FILE: ${file.path}${cut} ===\n${body}`;
}

function analysisPrompt(
  card: OpportunityCard,
  packet: EvidencePacket,
  cited: CitedEvidence[],
  signals: CodeEvidenceItem[],
  selection: FileSelection,
  files: ShownFile[],
): string {
  return [
    `Product: ${packet.productIdentity.productName} (${packet.productIdentity.url}).`,
    "",
    "Opportunity Card:",
    JSON.stringify(cardForPrompt(card), null, 2),
    "",
    "Public evidence the card cites:",
    JSON.stringify(cited, null, 2),
    "",
    `Deterministic code evidence (C1..C${signals.length}):`,
    signals.map((s) => `- ${s.id} [${s.evidenceType}]: ${s.observation}`).join("\n"),
    "",
    "Why these files were chosen:",
    selection.map((s) => `- ${s.path}: ${s.reason}`).join("\n"),
    "",
    files.map(numbered).join("\n\n"),
    "",
    `Write the code evidence and the refinement now. Your first item id is C${signals.length + 1}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1]!.trim() : trimmed);
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Validates a selection against the candidate list; unknown paths are dropped, duplicates merged. */
export function parseSelection(raw: string, candidates: ReadonlySet<string>): { selection: FileSelection } | { error: string } {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (err) {
    return { error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = SelectionResponseSchema.safeParse(json);
  if (!parsed.success) return { error: `Response did not match the selection shape: ${parsed.error.message}` };
  const seen = new Set<string>();
  const kept = parsed.data.files.filter((f) => {
    if (!candidates.has(f.path) || seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
  if (kept.length === 0) {
    return { error: `None of the chosen paths is in the file list (${parsed.data.files.map((f) => `"${f.path}"`).join(", ")}). Copy paths exactly from the list.` };
  }
  return { selection: kept };
}

export interface ParsedAnalysis {
  items: CodeEvidenceItem[];
  refinement: RepoRefinement;
}

/** Validates the analysis: grounded line ranges and quotes, id sequence, refs, inspected paths. */
export function parseAnalysis(
  raw: string,
  context: {
    repository: string;
    ref: string;
    files: ShownFile[];
    signalCount: number;
    cardEvidenceRefs: readonly string[];
    inspected: ReadonlySet<string>;
  },
): ParsedAnalysis | { error: string } {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (err) {
    return { error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = AnalysisResponseSchema.safeParse(json);
  if (!parsed.success) return { error: `Response did not match the analysis contract: ${parsed.error.message}` };

  const problems: string[] = [];
  const byPath = new Map(context.files.map((f) => [f.path, f]));
  const items: CodeEvidenceItem[] = [];
  parsed.data.items.forEach((item, i) => {
    const expectedId = `C${context.signalCount + 1 + i}`;
    if (item.id !== expectedId) problems.push(`Item ${i + 1} has id "${item.id}"; ids continue the sequence, so it must be "${expectedId}".`);
    const file = byPath.get(item.path);
    if (!file) {
      problems.push(`${item.id} cites "${item.path}", which is not one of the files shown.`);
      return;
    }
    if (item.endLine < item.startLine || item.endLine > file.lines.length) {
      problems.push(`${item.id} cites lines ${item.startLine}-${item.endLine} of ${item.path}, but only lines 1-${file.lines.length} were shown.`);
      return;
    }
    if (item.endLine - item.startLine + 1 > MAX_CITED_LINES) {
      problems.push(`${item.id} cites ${item.endLine - item.startLine + 1} lines; cite at most ${MAX_CITED_LINES}.`);
      return;
    }
    const range = file.lines.slice(item.startLine - 1, item.endLine);
    const quote = normalize(item.quote);
    if (quote.length > MAX_QUOTE_CHARS || !normalize(range.join("\n")).includes(quote)) {
      problems.push(`${item.id}'s quote is not in ${item.path} lines ${item.startLine}-${item.endLine}; quote a short exact snippet from inside the cited lines.`);
      return;
    }
    const lines = { start: item.startLine, end: item.endLine };
    const excerpt = range.join("\n");
    items.push({
      id: item.id,
      sourceRef: codeSourceRef(context.repository, context.ref, item.path, lines),
      evidenceType: item.evidenceType,
      observation: item.observation.trim(),
      rawExcerpt: excerpt.length > MAX_EXCERPT_CHARS ? `${excerpt.slice(0, MAX_EXCERPT_CHARS)}…` : excerpt,
      confidence: item.confidence,
      path: item.path,
      lines,
    });
  });

  const refinement = parsed.data.refinement;
  const knownRefs = new Set([
    ...Array.from({ length: context.signalCount + parsed.data.items.length }, (_, i) => `C${i + 1}`),
    ...context.cardEvidenceRefs,
  ]);
  for (const key of ["confidence", "effort"] as const) {
    const unknown = refinement[key].evidenceRefs.filter((r) => !knownRefs.has(r));
    if (unknown.length) problems.push(`refinement.${key}.evidenceRefs cites unknown ids: ${unknown.join(", ")}.`);
  }
  const surfacePaths = new Set<string>();
  for (const s of refinement.implementationSurface) {
    if (!context.inspected.has(s.path)) problems.push(`refinement.implementationSurface names "${s.path}", which was not inspected.`);
    if (surfacePaths.has(s.path)) problems.push(`refinement.implementationSurface lists "${s.path}" twice.`);
    surfacePaths.add(s.path);
  }

  if (problems.length > 0) return { error: problems.join(" ") };
  return { items, refinement };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface AnalyzeRepositoryOptions {
  /** Attempts per model step (1 + corrective retries). Default 2, like the other steps. */
  maxAttempts?: number;
  now?: () => string;
  /** Extra words for picking candidates in a huge repository, e.g. the public package's likely components. */
  hints?: readonly string[];
}

async function callWithRetry<T>(
  llm: LlmClient,
  system: string,
  firstPrompt: string,
  maxTokens: number,
  maxAttempts: number,
  parse: (raw: string) => T | { error: string },
  step: string,
  purpose: LlmPurpose,
): Promise<T> {
  const messages: LlmMessage[] = [{ role: "user", content: firstPrompt }];
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await llm.complete({ system, messages, maxTokens, purpose });
    } catch (err) {
      if (err instanceof LlmCallError) throw new RepoAnalysisError(`Could not reach the Claude API during ${step} (attempt ${attempt}/${maxAttempts}): ${err.message}`, err);
      throw err;
    }
    const outcome = parse(raw);
    if (!(typeof outcome === "object" && outcome !== null && "error" in outcome)) return outcome as T;
    lastError = (outcome as { error: string }).error;
    if (attempt < maxAttempts) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Your previous response failed validation: ${lastError}\n\nRespond again with ONLY the corrected JSON object, following the exact shape and rules from the system prompt.`,
      });
    }
  }
  throw new RepoAnalysisError(`Could not produce a valid ${step} after ${maxAttempts} attempt(s). Last error: ${lastError}`);
}

/** Splits a file into the lines shown to the model, within the per-file bounds. */
export function shownFile(path: string, content: string): ShownFile {
  const all = content.replace(/\r\n?/g, "\n").split("\n");
  if (all.length > 1 && all.at(-1) === "") all.pop();
  const lines: string[] = [];
  let chars = 0;
  for (const line of all) {
    if (lines.length >= MAX_FILE_LINES || chars + line.length > MAX_FILE_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return { path, lines, totalLines: all.length };
}

/**
 * The deep scan for one card. Throws RepoAccessError when the repository
 * can't be read, RepoAnalysisError when the model can't produce a valid
 * selection/analysis, or when nothing relevant could be read.
 */
export async function analyzeRepositoryForCard(
  card: OpportunityCard,
  packet: EvidencePacket,
  reader: RepoReader,
  llm: LlmClient,
  options: AnalyzeRepositoryOptions = {},
): Promise<RepoAnalysis> {
  const maxAttempts = options.maxAttempts ?? 2;
  const now = options.now ?? (() => new Date().toISOString());
  const pulledAt = now();

  const snapshot = await reader.snapshot();
  if (snapshot.entries.length === 0) throw new RepoAnalysisError(`${snapshot.repository} has no files at ${snapshot.ref}.`);

  const signals = await detectRepoSignals(snapshot, reader);
  const signalItems: CodeEvidenceItem[] = signals.items.map((item: CodeEvidenceDraft, i) => ({ ...item, id: `C${i + 1}` }));
  const notInspected = [...signals.notInspected];

  const cardText = [card.title, card.observation, card.hypothesis, card.changeSurface, card.experiment.primaryMetric, ...(options.hints ?? [])].join(" ");
  const candidates = candidatePaths(snapshot, cardText);
  if (candidates.omitted > 0) notInspected.push(`${candidates.omitted} less related source files were not offered for selection (repository size bound).`);
  for (const path of candidates.tooLarge.slice(0, 10)) notInspected.push(`${path} (over the ${Math.round(200_000 / 1000)} KB read limit)`);
  if (candidates.paths.length === 0) throw new RepoAnalysisError(`${snapshot.repository} has no readable source files to analyze.`);

  const selection = await callWithRetry(
    llm,
    SELECTION_SYSTEM,
    selectionPrompt(card, packet, signalItems, candidates.paths, candidates.omitted),
    6000,
    maxAttempts,
    (raw) => {
      const result = parseSelection(raw, new Set(candidates.paths));
      return "error" in result ? result : result.selection;
    },
    "file selection",
    "repo_selection",
  );

  const files: ShownFile[] = [];
  let total = 0;
  for (const choice of selection) {
    let content: string | null;
    try {
      content = await reader.readText(choice.path);
    } catch (err) {
      if (err instanceof RepoAccessError && err.kind !== "not_found") throw err;
      content = null;
    }
    if (content === null) {
      notInspected.push(`${choice.path} (could not be read)`);
      continue;
    }
    const file = shownFile(choice.path, content);
    const size = file.lines.reduce((n, l) => n + l.length + 1, 0);
    if (total + size > MAX_TOTAL_CHARS) {
      notInspected.push(`${choice.path} (skipped: the analysis read limit was reached)`);
      continue;
    }
    total += size;
    if (file.lines.length < file.totalLines) notInspected.push(`${choice.path} beyond line ${file.lines.length}`);
    files.push(file);
  }
  if (files.length === 0) throw new RepoAnalysisError("None of the files chosen for this opportunity could be read.");

  const inspected = new Set([...signals.filesRead, ...files.map((f) => f.path)]);
  const cited = citedEvidenceFor(card, packet);
  const analysis = await callWithRetry<ParsedAnalysis>(
    llm,
    ANALYSIS_SYSTEM,
    analysisPrompt(card, packet, cited, signalItems, selection, files),
    12000,
    maxAttempts,
    (raw) =>
      parseAnalysis(raw, {
        repository: snapshot.repository,
        ref: snapshot.ref,
        files,
        signalCount: signalItems.length,
        cardEvidenceRefs: card.evidenceRefs,
        inspected,
      }),
    "code analysis",
    "repo_analysis",
  );

  return RepoAnalysisSchema.parse({
    version: REPO_ANALYSIS_VERSION,
    generatedAt: now(),
    cardTitle: card.title,
    selection: selection.filter((s) => files.some((f) => f.path === s.path)),
    codeContext: {
      source: {
        provider: "github",
        repository: snapshot.repository,
        ref: snapshot.ref,
        pulledAt,
        filesInTree: snapshot.entries.length,
        treeTruncated: snapshot.truncated,
        filesInspected: [...inspected].sort(),
      },
      items: [...signalItems, ...analysis.items],
      notInspected,
    },
    refinement: analysis.refinement,
  });
}

/** The code evidence a package cites, resolved for its citedEvidence. */
export function citedCodeEvidence(analysis: RepoAnalysis, refs: readonly string[]): CitedEvidence[] {
  const wanted = new Set(refs);
  return analysis.codeContext.items.filter((i) => wanted.has(i.id)).map((i) => ({ id: i.id, observation: i.observation, sourceRef: i.sourceRef }));
}
