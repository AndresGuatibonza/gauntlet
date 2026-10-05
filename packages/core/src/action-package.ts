/**
 * "Build this" handoff (PRD Build Order #5, §8.8) and the minimal
 * Experiment Ledger record it starts (Build Order #7, PRD §9 "build
 * minimal from day one").
 *
 * Contract: claude/gauntlet-evidence-contract-v0.md §2.2 and §2.3
 * (Amendment 2). That doc is the source of truth.
 *
 * Design rules, all enforced here rather than trusted to the model:
 * - What the Opportunity Card already settled (hypothesis, the experiment's
 *   control/variant/audience/metric/guardrails/stopping rule, cited
 *   evidence) is copied into the package verbatim. The model only writes
 *   the engineering parts the card doesn't have.
 * - No repository is connected yet, so the package must not name files or
 *   paths: components are described in product terms, and what a repo
 *   connection would add goes in missingContext. File-path-looking
 *   components are rejected.
 * - The package may only cite evidence its card cites.
 * - The coding-agent prompt and the Markdown brief are rendered from the
 *   validated package by templates, so they can never drift from it.
 */
import { z } from "zod";
import type { EvidencePacket } from "./evidence-packet.js";
import { isPopulatedAiEvidence } from "./evidence-packet.js";
import { LlmCallError, type LlmClient, type LlmMessage } from "./llm-client.js";
import { ExperimentSchema, ChangeSurfaceSchema, type OpportunityCard } from "./opportunity-card.js";

export const ACTION_PACKAGE_VERSION = 1;

export class ActionPackageError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ActionPackageError";
  }
}

const text = z.string().trim().min(1);

/** The part the model writes. Strict: unknown keys are a contract violation. */
export const ActionPackageDraftSchema = z
  .object({
    objective: text,
    nonGoals: z.array(text).min(1).max(6),
    likelyComponents: z.array(text).min(1).max(8),
    approach: z.array(text).min(2).max(10),
    featureFlag: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/, "featureFlag.name must be snake_case, 3-49 characters"),
        rollout: text,
      })
      .strict(),
    acceptanceCriteria: z.array(text).min(3).max(10),
    measurement: z.object({ howToMeasure: text, baseline: text, minimumDuration: text }).strict(),
    rollbackCriteria: z.array(text).min(1).max(6),
    risks: z.array(z.object({ risk: text, mitigation: text }).strict()).min(1).max(6),
    missingContext: z.array(text).min(1).max(8),
    evidenceRefs: z.array(text).min(1),
  })
  .strict();
export type ActionPackageDraft = z.infer<typeof ActionPackageDraftSchema>;

export const CitedEvidenceSchema = z.object({
  id: z.string(),
  observation: z.string(),
  sourceRef: z.string(),
});
export type CitedEvidence = z.infer<typeof CitedEvidenceSchema>;

export const ActionPackageSchema = ActionPackageDraftSchema.extend({
  version: z.literal(ACTION_PACKAGE_VERSION),
  generatedAt: z.string().datetime(),
  product: z.object({ name: z.string(), url: z.string() }),
  card: z.object({
    title: z.string(),
    hypothesis: z.string(),
    changeSurface: ChangeSurfaceSchema,
    missingEvidence: z.string(),
  }),
  experiment: ExperimentSchema,
  /** What the package was grounded on. Only "public_scan" until GitHub deep scan (#4) exists. */
  codeContext: z.literal("public_scan"),
  citedEvidence: z.array(CitedEvidenceSchema).min(1),
});
export type ActionPackage = z.infer<typeof ActionPackageSchema>;

// A component that names a file or code path ("src/app.tsx",
// "components/Pricing/"): the package has no repository to know those from.
// A slash alone is not a path: product terms use it ("content block/snippet",
// "signup/onboarding"), so a slashed word is flagged only when it looks like
// code -- relative or home-anchored, ending in "/", three or more segments, or
// starting with a conventional source directory (lowercase, as in code).
const SOURCE_FILE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs|py|go|rb|java|kt|swift|php|cs|css|scss|html|vue|svelte|json|ya?ml|sql)\b/i;
const SOURCE_DIRECTORIES = new Set([
  "src", "app", "apps", "lib", "libs", "components", "pages", "packages", "server", "client", "api", "routes",
  "utils", "hooks", "styles", "public", "test", "tests", "spec", "config", "scripts", "modules", "views",
  "controllers", "models", "services", "store", "assets", "internal", "cmd", "pkg",
]);

/** True when a likelyComponents entry names a file or code path rather than a part of the product. */
export function looksLikeCodePath(component: string): boolean {
  if (SOURCE_FILE_EXTENSION.test(component)) return true;
  return component.split(/\s+/).some((rawWord) => {
    const word = rawWord.replace(/^[("'`]+|[)"'`,.;:]+$/g, "");
    if (!word.includes("/") || word.includes("://")) return false;
    if (/^(\.{1,2}|~)\//.test(word)) return true;
    if (/[\w-]\/$/.test(word)) return true;
    const segments = word.split("/").filter(Boolean);
    if (segments.length >= 3) return true;
    return segments.length >= 2 && SOURCE_DIRECTORIES.has(segments[0]!);
  });
}

/** The card's own cited evidence, resolved against the packet (E* and A* items). */
export function citedEvidenceFor(card: OpportunityCard, packet: EvidencePacket): CitedEvidence[] {
  const byId = new Map<string, CitedEvidence>();
  for (const item of packet.observedEvidence) {
    byId.set(item.id, { id: item.id, observation: item.observation, sourceRef: item.sourceUrl });
  }
  if (isPopulatedAiEvidence(packet.aiEvidence)) {
    for (const item of packet.aiEvidence.items) {
      byId.set(item.id, { id: item.id, observation: item.observation, sourceRef: item.sourceRef });
    }
  }
  return card.evidenceRefs.map((id) => byId.get(id)).filter((e): e is CitedEvidence => e !== undefined);
}

const SYSTEM_PROMPT = `You are the "Build this" handoff component of Gauntlet. Given one Opportunity Card (a ranked, evidence-backed product experiment) and the evidence it cites, you write the engineering-ready parts of an implementation package for the product team.

Ground rules, non-negotiable:
1. The card's hypothesis and experiment (control, variant, audience, primary metric, guardrails, stopping rule) are already decided and will be copied into the package verbatim. Implement exactly that experiment; do not redesign it, add variants, or change the metric.
2. No code repository is connected. Never name files, directories, functions, classes or code paths, and never guess the tech stack. Describe "likelyComponents" in product terms (for example "the pricing page's plan comparison section", "the signup form"). Put what a repository connection would clarify in "missingContext".
3. Every factual claim about the product must trace to the cited evidence. "evidenceRefs" may only contain ids from the card's evidenceRefs.
4. The change must be shippable behind a feature flag and reversible. "featureFlag.name" is snake_case.
5. Acceptance criteria are concrete and checkable by a reviewer (observable behavior, not intentions). Rollback criteria are measurable conditions that trigger turning the flag off, consistent with the card's guardrails.
6. Do not fabricate precision: no invented baselines, traffic numbers or effect sizes. If a baseline is unknown, say how to establish it.
7. Non-goals keep the change to one thing at a time.

Output format:
Respond with ONLY a single JSON object, no markdown code fences, no prose before or after:
{
  "objective": string,
  "nonGoals": [string, ...],              // 1-6
  "likelyComponents": [string, ...],      // 1-8, product terms only
  "approach": [string, ...],              // 2-10 ordered steps
  "featureFlag": { "name": string, "rollout": string },
  "acceptanceCriteria": [string, ...],    // 3-10
  "measurement": { "howToMeasure": string, "baseline": string, "minimumDuration": string },
  "rollbackCriteria": [string, ...],      // 1-6
  "risks": [{ "risk": string, "mitigation": string }, ...],  // 1-6
  "missingContext": [string, ...],        // 1-8
  "evidenceRefs": [string, ...]           // subset of the card's evidenceRefs
}`;

function buildUserPrompt(card: OpportunityCard, packet: EvidencePacket, cited: CitedEvidence[]): string {
  const { rankScore: _rank, ...cardForPrompt } = card;
  return [
    `Product: ${packet.productIdentity.productName} (${packet.productIdentity.url}), category ${packet.productIdentity.category}.`,
    `Stated value proposition: ${packet.productIdentity.statedValueProposition}`,
    "",
    "Opportunity Card:",
    JSON.stringify(cardForPrompt, null, 2),
    "",
    "Evidence the card cites:",
    JSON.stringify(cited, null, 2),
    "",
    "Write the implementation package now, following every ground rule exactly.",
  ].join("\n");
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** Contract checks that zod can't express: grounding and no invented code locations. */
export function checkDraftGrounding(draft: ActionPackageDraft, card: OpportunityCard): string[] {
  const problems: string[] = [];
  const allowed = new Set(card.evidenceRefs);
  const foreign = draft.evidenceRefs.filter((id) => !allowed.has(id));
  if (foreign.length > 0) {
    problems.push(`evidenceRefs may only cite the card's evidence (${card.evidenceRefs.join(", ")}); found ${foreign.join(", ")}.`);
  }
  const pathLike = draft.likelyComponents.filter(looksLikeCodePath);
  if (pathLike.length > 0) {
    problems.push(
      `likelyComponents must be product terms, not files or code paths (no repository is connected): ${pathLike.map((c) => `"${c}"`).join(", ")}.`,
    );
  }
  return problems;
}

function parseDraft(raw: string, card: OpportunityCard): { draft: ActionPackageDraft } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonPayload(raw));
  } catch (err) {
    return { error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = ActionPackageDraftSchema.safeParse(json);
  if (!parsed.success) {
    return { error: `Response did not match the implementation package contract: ${parsed.error.message}` };
  }
  const problems = checkDraftGrounding(parsed.data, card);
  if (problems.length > 0) return { error: problems.join(" ") };
  return { draft: parsed.data };
}

export interface GenerateActionPackageOptions {
  /** Total attempts (1 + corrective retries). Default 2, like the Scientist and Reviewer. */
  maxAttempts?: number;
  now?: () => string;
}

/**
 * One Claude call (plus one corrective retry on a contract violation)
 * turns a card into a validated ActionPackage.
 */
export async function generateActionPackage(
  card: OpportunityCard,
  packet: EvidencePacket,
  llmClient: LlmClient,
  options: GenerateActionPackageOptions = {},
): Promise<ActionPackage> {
  const maxAttempts = options.maxAttempts ?? 2;
  const cited = citedEvidenceFor(card, packet);
  if (cited.length === 0) {
    throw new ActionPackageError("The card cites no evidence present in its Evidence Packet; refusing to write an ungrounded package.");
  }
  const messages: LlmMessage[] = [{ role: "user", content: buildUserPrompt(card, packet, cited) }];

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await llmClient.complete({ system: SYSTEM_PROMPT, messages, maxTokens: 8000 });
    } catch (err) {
      if (err instanceof LlmCallError) {
        throw new ActionPackageError(`Could not reach the Claude API (attempt ${attempt}/${maxAttempts}): ${err.message}`, err);
      }
      throw err;
    }
    const outcome = parseDraft(raw, card);
    if ("draft" in outcome) {
      return ActionPackageSchema.parse({
        ...outcome.draft,
        version: ACTION_PACKAGE_VERSION,
        generatedAt: (options.now ?? (() => new Date().toISOString()))(),
        product: { name: packet.productIdentity.productName, url: packet.productIdentity.url },
        card: {
          title: card.title,
          hypothesis: card.hypothesis,
          changeSurface: card.changeSurface,
          missingEvidence: card.missingEvidence,
        },
        experiment: card.experiment,
        codeContext: "public_scan",
        citedEvidence: cited,
      });
    }
    lastError = outcome.error;
    if (attempt < maxAttempts) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Your previous response failed validation: ${outcome.error}\n\nRespond again with ONLY the corrected JSON object, following the exact contract shape and ground rules from the system prompt.`,
      });
    }
  }
  throw new ActionPackageError(`Could not produce a contract-valid implementation package after ${maxAttempts} attempt(s). Last error: ${lastError}`);
}

function bullets(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

function numbered(items: readonly string[]): string {
  return items.map((i, n) => `${n + 1}. ${i}`).join("\n");
}

/**
 * A provider-neutral brief to paste into the team's coding agent (PRD
 * §8.8's "interim execution path"). Rendered from the package, so it
 * always matches it.
 */
export function renderCodingAgentPrompt(pkg: ActionPackage): string {
  const e = pkg.experiment;
  return `You are implementing one product experiment in this codebase for ${pkg.product.name} (${pkg.product.url}).

## Objective
${pkg.objective}

Hypothesis being tested: ${pkg.card.hypothesis}

## Before you change anything
This plan was written from the product's public website only; no one has looked at this repository yet. First locate where these live in the code:
${bullets(pkg.likelyComponents)}
If you can't find them, or the codebase works differently than this plan assumes, stop and report what you found instead of guessing.

## The experiment (already decided -- do not redesign it)
- Control: ${e.control}
- Variant: ${e.variant}
- Audience: ${e.audience}
- Primary metric: ${e.primaryMetric}
- Guardrails: ${e.guardrails}
- Stopping rule: ${e.stoppingRule}

## Implementation
Put the whole change behind the feature flag \`${pkg.featureFlag.name}\` (default off). Rollout: ${pkg.featureFlag.rollout}
${numbered(pkg.approach)}

## Out of scope
${bullets(pkg.nonGoals)}

## Done when
${bullets(pkg.acceptanceCriteria)}
- With \`${pkg.featureFlag.name}\` off, behavior is exactly as before.

## Measurement
${pkg.measurement.howToMeasure}
Baseline: ${pkg.measurement.baseline}
Run for at least: ${pkg.measurement.minimumDuration}

## Roll back (turn the flag off) if
${bullets(pkg.rollbackCriteria)}

Make the smallest change that satisfies the above, add tests for both flag states, and summarize what you changed and anything you couldn't verify.`;
}

/** The full package as a Markdown brief (download / CLI output). */
export function renderActionPackageMarkdown(pkg: ActionPackage): string {
  const e = pkg.experiment;
  return `# Implementation brief: ${pkg.card.title}

${pkg.product.name} (${pkg.product.url}) · generated ${pkg.generatedAt} by Gauntlet from the public website only (no repository connected).

## Objective
${pkg.objective}

**Hypothesis:** ${pkg.card.hypothesis}

## Non-goals
${bullets(pkg.nonGoals)}

## Likely components
${bullets(pkg.likelyComponents)}

## Proposed approach
${numbered(pkg.approach)}

## Experiment and feature flag
- Flag: \`${pkg.featureFlag.name}\` (default off). Rollout: ${pkg.featureFlag.rollout}
- Control: ${e.control}
- Variant: ${e.variant}
- Audience: ${e.audience}
- Primary metric: ${e.primaryMetric}
- Guardrails: ${e.guardrails}
- Stopping rule: ${e.stoppingRule}

## Acceptance criteria
${bullets(pkg.acceptanceCriteria)}

## Measurement plan
- How: ${pkg.measurement.howToMeasure}
- Baseline: ${pkg.measurement.baseline}
- Minimum duration: ${pkg.measurement.minimumDuration}

## Rollback criteria
${bullets(pkg.rollbackCriteria)}

## Risks
${pkg.risks.map((r) => `- **${r.risk}** Mitigation: ${r.mitigation}`).join("\n")}

## Missing context
${bullets(pkg.missingContext)}
- The card's own open question: ${pkg.card.missingEvidence}

## Evidence
${pkg.citedEvidence.map((c) => `- ${c.id}: ${c.observation} (${c.sourceRef})`).join("\n")}

## Prompt for your coding agent

\`\`\`text
${renderCodingAgentPrompt(pkg)}
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Experiment Ledger (contract §2.3): the record a package starts.
// ---------------------------------------------------------------------------

export const ExperimentStatusSchema = z.enum(["planned", "running", "decided"]);
export const ExperimentDecisionSchema = z.enum(["ship", "iterate", "discard"]);

export const ExperimentRecordSchema = z
  .object({
    hypothesis: z.string(),
    evidenceSnapshot: z.array(CitedEvidenceSchema).min(1),
    change: z.object({ featureFlag: z.string(), summary: z.string() }),
    experiment: ExperimentSchema,
    status: ExperimentStatusSchema,
    result: z.string().nullable(),
    decision: ExperimentDecisionSchema.nullable(),
    outcome: z.string().nullable(),
  })
  .superRefine((r, ctx) => {
    // A decision exists exactly when the record is decided, and always with its result.
    if ((r.status === "decided") !== (r.decision !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "decision is required exactly when status is \"decided\"" });
    }
    if (r.decision !== null && !r.result) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a decided experiment must record its result" });
    }
  });
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;

/** The planned ledger record for a freshly generated package. */
export function planExperimentRecord(pkg: ActionPackage): ExperimentRecord {
  return ExperimentRecordSchema.parse({
    hypothesis: pkg.card.hypothesis,
    evidenceSnapshot: pkg.citedEvidence,
    change: { featureFlag: pkg.featureFlag.name, summary: pkg.objective },
    experiment: pkg.experiment,
    status: "planned",
    result: null,
    decision: null,
    outcome: null,
  });
}

export class ExperimentUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentUpdateError";
  }
}

export interface ExperimentUpdate {
  running?: boolean;
  decision?: string;
  result?: string;
  outcome?: string;
}

/**
 * The ledger's transition rules: planned -> running -> decided (or straight
 * to decided). A decision needs its result. A decided record is history and
 * can't be changed; an outcome (what happened after the decision) can still
 * be added to it once.
 */
export function applyExperimentUpdate(current: ExperimentRecord, update: ExperimentUpdate): ExperimentRecord {
  const { running, decision, result, outcome } = update;
  if (!running && decision === undefined && result === undefined && outcome === undefined) {
    throw new ExperimentUpdateError("Nothing to record: mark the experiment running, or record a decision with its result, and/or an outcome.");
  }
  if (running && decision !== undefined) throw new ExperimentUpdateError("Mark it running or record a decision, not both.");

  if (current.status === "decided") {
    if (running || decision !== undefined || result !== undefined) {
      throw new ExperimentUpdateError("This experiment is already decided; a decision is history. Record a new experiment instead.");
    }
    if (current.outcome) throw new ExperimentUpdateError("This experiment already has an outcome recorded.");
    return ExperimentRecordSchema.parse({ ...current, outcome: outcome!.trim() });
  }

  if (running) {
    if (current.status === "running") throw new ExperimentUpdateError("This experiment is already running.");
    if (result !== undefined || outcome !== undefined) throw new ExperimentUpdateError("A result and outcome are recorded together with the decision.");
    return ExperimentRecordSchema.parse({ ...current, status: "running" });
  }

  if (decision === undefined) throw new ExperimentUpdateError("A result or outcome needs a decision (ship, iterate or discard).");
  const parsedDecision = ExperimentDecisionSchema.safeParse(decision);
  if (!parsedDecision.success) throw new ExperimentUpdateError(`The decision must be ship, iterate or discard; got "${decision}".`);
  if (!result?.trim()) throw new ExperimentUpdateError("A decision needs its result: what the experiment showed.");

  return ExperimentRecordSchema.parse({
    ...current,
    status: "decided",
    decision: parsedDecision.data,
    result: result.trim(),
    outcome: outcome?.trim() || null,
  });
}

