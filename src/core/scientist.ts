/**
 * Product Scientist v0 (PRD §8.3 / contract doc §2)
 *
 * Purpose: "turn evidence into ranked, testable product-improvement
 * opportunities. The Scientist must be product-outcome oriented, not
 * merely defect oriented."
 *
 * This is a natural-language reasoning task (observation -> problem
 * statement -> falsifiable hypothesis -> experiment), not a deterministic
 * rules task like the extractor/normalizer -- so it is implemented as a
 * single Claude API call per Evidence Packet (via the injectable
 * LlmClient), with the response strictly validated against the Opportunity
 * Card contract before it is trusted for anything downstream.
 *
 * Hard rule enforced here, on top of what Zod checks: `evidenceRefs` must
 * point at real ids from the Evidence Packet's `observedEvidence`. Per the
 * contract's own non-goal ("no orphan claims"), a card citing an id that
 * does not exist in the packet is a contract violation, not a stylistic
 * nit -- it means the model asserted evidence it was not given. That is
 * treated as a failed generation, not silently downgraded.
 */
import type { EvidencePacket } from "./evidence-packet.js";
import { OpportunityReportSchema, computeRankScore, type OpportunityCard, type OpportunityReport } from "./opportunity-card.js";
import { type LlmClient, type LlmMessage, LlmCallError } from "./llm-client.js";

export class ScientistError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScientistError";
  }
}

const SYSTEM_PROMPT = `You are the Product Scientist component of Gauntlet, a tool that turns a public-website scan (an "Evidence Packet") into ranked, testable product-improvement opportunities.

Ground rules, non-negotiable:
1. Every factual claim in every card must trace back to one or more evidence item ids from the packet's observedEvidence list (field "evidenceRefs"). Never cite an id that is not in the packet. Never invent evidence.
2. Never infer hidden backend behavior, real user behavior, or AI model behavior from frontend appearance alone. If evidence is missing for a claim, do not make the claim -- reflect the gap in "missingEvidence" instead.
3. Be product-outcome oriented (conversion, activation, retention, trust), not merely defect-oriented (do not just list typos or minor UI nits).
4. Every hypothesis must be falsifiable -- a specific, testable statement, not a vague wish like "improve onboarding."
5. Do not fabricate false precision. Impact and effort are directional judgments with a one-sentence rationale, not fake statistics.
6. Output exactly 3 to 5 Opportunity Cards, ranked best-first, with EXACTLY ONE card marked "nextAction": "build_this" (the single best next experiment). The rest get "connect_data_to_validate" or "do_not_prioritize_yet".

Output format:
Respond with ONLY a single JSON object, no markdown code fences, no prose before or after. The object has this exact shape:
{
  "cards": [
    {
      "title": string,
      "observation": string,
      "problemStatement": string,
      "hypothesis": string,
      "changeSurface": "prompt" | "model" | "ux" | "backend" | "data" | "tool" | "reliability" | "other",
      "experiment": {
        "control": string,
        "variant": string,
        "audience": string,
        "primaryMetric": string,
        "guardrails": string,
        "stoppingRule": string
      },
      "expectedImpact": { "level": "low" | "medium" | "high", "rationale": string, "score": 1 | 2 | 3 },
      "effort": { "level": "low" | "medium" | "high", "explanation": string, "score": 1 | 2 | 3 },
      "confidence": { "level": "low" | "medium" | "high", "evidenceQualityScore": 1 | 2 | 3 },
      "missingEvidence": string,
      "nextAction": "build_this" | "connect_data_to_validate" | "do_not_prioritize_yet",
      "evidenceRefs": [string, ...]  // must be ids that appear in the provided Evidence Packet
    }
  ]
}`;

function buildUserPrompt(packet: EvidencePacket): string {
  return `Here is the Evidence Packet for ${packet.productIdentity.productName} (${packet.productIdentity.url}):\n\n${JSON.stringify(packet, null, 2)}\n\nGenerate the Opportunity Cards now, following every ground rule exactly.`;
}

/**
 * Strips markdown code fences if the model added them despite instructions
 * not to -- observed as a real, common LLM failure mode, not hypothetical.
 */
function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function validEvidenceIds(packet: EvidencePacket): Set<string> {
  return new Set(packet.observedEvidence.map((item) => item.id));
}

function checkNoOrphanRefs(report: OpportunityReport, packet: EvidencePacket): string[] {
  const validIds = validEvidenceIds(packet);
  const problems: string[] = [];
  report.cards.forEach((card, i) => {
    const orphans = card.evidenceRefs.filter((ref) => !validIds.has(ref));
    if (orphans.length > 0) {
      problems.push(`Card #${i + 1} ("${card.title}") cites evidence id(s) not present in the packet: ${orphans.join(", ")}.`);
    }
  });
  return problems;
}

function parseAndValidate(raw: string, packet: EvidencePacket): { report: OpportunityReport } | { error: string } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJsonPayload(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Response was not valid JSON: ${message}` };
  }

  const result = OpportunityReportSchema.safeParse(parsedJson);
  if (!result.success) {
    return { error: `Response did not match the Opportunity Card contract: ${result.error.message}` };
  }

  const orphanProblems = checkNoOrphanRefs(result.data, packet);
  if (orphanProblems.length > 0) {
    return { error: `evidenceRefs must only cite ids present in the Evidence Packet. ${orphanProblems.join(" ")}` };
  }

  return { report: result.data };
}

function withRankScores(report: OpportunityReport): OpportunityReport {
  const scored: OpportunityCard[] = report.cards
    .map((card) => ({ ...card, rankScore: computeRankScore(card) }))
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
  return { cards: scored };
}

export interface GenerateOpportunityReportOptions {
  /** How many total attempts (1 initial + retries) before giving up. Default 2. */
  maxAttempts?: number;
}

/**
 * Generates and validates the Opportunity Report for one Evidence Packet.
 * On a malformed/contract-violating response, sends one corrective
 * follow-up turn showing the model exactly what was wrong before giving up
 * -- this is the "robust error handling" the project instructions require,
 * not a bare try/catch that surfaces a raw parse error to the caller.
 */
export async function generateOpportunityReport(
  packet: EvidencePacket,
  llmClient: LlmClient,
  options: GenerateOpportunityReportOptions = {},
): Promise<OpportunityReport> {
  const maxAttempts = options.maxAttempts ?? 2;
  const messages: LlmMessage[] = [{ role: "user", content: buildUserPrompt(packet) }];

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await llmClient.complete({ system: SYSTEM_PROMPT, messages });
    } catch (err) {
      if (err instanceof LlmCallError) {
        throw new ScientistError(`Scientist could not reach the Claude API (attempt ${attempt}/${maxAttempts}): ${err.message}`, err);
      }
      throw err;
    }

    const outcome = parseAndValidate(raw, packet);
    if ("report" in outcome) {
      return withRankScores(outcome.report);
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

  throw new ScientistError(
    `Scientist failed to produce a contract-valid Opportunity Report after ${maxAttempts} attempt(s). Last error: ${lastError}`,
  );
}
