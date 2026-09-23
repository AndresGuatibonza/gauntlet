/**
 * Peer Reviewer / Experiment Critic v0 (PRD §8.4 / contract doc §3)
 *
 * PRD §8.4: "V0 should act as a critic rather than a separate autonomous
 * workflow. It reviews the top recommendations before display... Return a
 * concise review record for debugging and future experiment memory."
 *
 * Scope decision (confirmed with Andres): this checklist -- originally
 * written in the contract doc as something Andres applied by hand during
 * the concierge round -- is now automated as a second Claude API call
 * against the Scientist's already-validated Opportunity Report, rather
 * than staying a manual step. It never re-derives evidence; it only
 * critiques the cards it is given, per the contract §3 checklist:
 *   - Does the conclusion outrun the evidence cited in evidenceRefs?
 *   - Is there an obvious confounder or alternative explanation not addressed?
 *   - Does the proposed primary_metric actually measure the stated outcome?
 *   - Is the experiment falsifiable, and does it change one thing at a time?
 *   - Should confidence be downgraded, or more evidence requested, before
 *     this ships in the report?
 * "A card that fails any check gets its confidence downgraded or is
 * dropped before the product sees the report -- never silently shipped as-is."
 */
import { z } from "zod";
import type { EvidencePacket } from "./evidence-packet.js";
import { CardConfidenceSchema, computeRankScore, type OpportunityCard, type OpportunityReport } from "./opportunity-card.js";
import { type LlmClient, type LlmMessage, LlmCallError } from "./llm-client.js";

export class ReviewerError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ReviewerError";
  }
}

// ---------------------------------------------------------------------------
// Review record -- "for debugging and future experiment memory" (PRD §8.4).
// One per card, keyed by the card's own index in the report so it survives
// drops/reordering cleanly.
// ---------------------------------------------------------------------------
export const ReviewVerdictSchema = z.enum(["pass", "downgrade_confidence", "drop"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewRecordSchema = z.object({
  cardIndex: z.number().int().min(0),
  cardTitle: z.string(),
  outrunsEvidence: z.boolean(),
  hasUnaddressedConfounder: z.boolean(),
  metricMatchesOutcome: z.boolean(),
  isFalsifiableAndSingleChange: z.boolean(),
  verdict: ReviewVerdictSchema,
  rationale: z.string(),
  // Only meaningful when verdict === "downgrade_confidence"; the reviewer's
  // requested new confidence level. We still cap it below the card's
  // current level (see applyReview) so a "downgrade" can never raise it.
  downgradedConfidenceLevel: z.enum(["low", "medium"]).optional(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

const ReviewResponseSchema = z.object({
  reviews: z.array(ReviewRecordSchema),
});

export interface ReviewedOpportunityReport {
  report: OpportunityReport;
  reviewRecords: ReviewRecord[];
}

const SYSTEM_PROMPT = `You are the Peer Reviewer / Experiment Critic for Gauntlet. You are given an Evidence Packet and a set of Opportunity Cards a separate Scientist component already generated from it. Your job is to critique each card against this checklist -- you do not generate new opportunities, and you never add evidence the packet does not contain.

For EVERY card, answer all four checklist questions and give a verdict:
1. outrunsEvidence: does the card's problemStatement/hypothesis claim more than what evidenceRefs actually supports?
2. hasUnaddressedConfounder: is there an obvious alternative explanation for the observation that the card ignores?
3. metricMatchesOutcome: does experiment.primaryMetric actually measure the outcome named in problemStatement? (false = mismatch)
4. isFalsifiableAndSingleChange: is the experiment falsifiable and does it change exactly one thing? (false = not falsifiable, or bundles multiple changes)

Verdict rules:
- "drop": the card fails badly enough (outruns evidence with no fix, or the experiment cannot be salvaged) that it should not ship at all.
- "downgrade_confidence": the card is usable but at least one check failed seriously enough that confidence must drop. Set downgradedConfidenceLevel to "low" or "medium" -- never higher than the card's current level.
- "pass": no check failed seriously enough to change confidence or drop the card.

Never invent a fifth checklist item and never rewrite the card's content -- your output is only the review verdicts.

Respond with ONLY a single JSON object, no markdown fences, no prose outside the JSON:
{
  "reviews": [
    {
      "cardIndex": number,       // 0-based index into the cards array you were given
      "cardTitle": string,
      "outrunsEvidence": boolean,
      "hasUnaddressedConfounder": boolean,
      "metricMatchesOutcome": boolean,
      "isFalsifiableAndSingleChange": boolean,
      "verdict": "pass" | "downgrade_confidence" | "drop",
      "rationale": string,
      "downgradedConfidenceLevel": "low" | "medium"  // only when verdict is "downgrade_confidence"
    }
  ]
}
One review record per card, same order as given, cardIndex matching its position.`;

function buildUserPrompt(report: OpportunityReport, packet: EvidencePacket): string {
  return `Evidence Packet (for context on what evidence actually exists):\n${JSON.stringify(packet.observedEvidence, null, 2)}\n\nOpportunity Cards to review:\n${JSON.stringify(report.cards, null, 2)}\n\nReview every card now, following the checklist exactly.`;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]!.trim() : trimmed;
}

const CONFIDENCE_RANK: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };

/**
 * Applies review verdicts to the report: drops "drop" cards, downgrades
 * confidence (and recomputes rankScore) for "downgrade_confidence" cards,
 * then re-enforces the contract's "exactly one build_this" invariant --
 * which a drop can break if the dropped card happened to be the
 * build_this pick. In that case the highest-ranked survivor is promoted.
 */
function applyReview(report: OpportunityReport, reviews: ReviewRecord[]): OpportunityReport {
  const reviewByIndex = new Map(reviews.map((r) => [r.cardIndex, r]));

  const survivors: OpportunityCard[] = [];
  report.cards.forEach((card, index) => {
    const review = reviewByIndex.get(index);
    if (!review || review.verdict === "pass") {
      survivors.push(card);
      return;
    }
    if (review.verdict === "drop") {
      return; // dropped, per contract §3: "never silently shipped as-is"
    }
    // downgrade_confidence
    const requestedLevel = review.downgradedConfidenceLevel ?? "low";
    const currentLevel = card.confidence.level;
    const newLevel = CONFIDENCE_RANK[requestedLevel] < CONFIDENCE_RANK[currentLevel] ? requestedLevel : currentLevel;
    // A downgraded level must drag evidenceQualityScore down with it, or
    // rankScore would not reflect the downgrade at all (e.g. a "medium"
    // card, score 2, downgraded to "low" must not keep scoring a 2).
    // "low" caps at 1, "medium" caps at 2 -- never raised, only lowered.
    const levelCap: Record<"low" | "medium" | "high", 1 | 2 | 3> = { low: 1, medium: 2, high: 3 };
    const newEvidenceQualityScore =
      newLevel === currentLevel
        ? card.confidence.evidenceQualityScore
        : (Math.min(levelCap[newLevel], card.confidence.evidenceQualityScore) as 1 | 2);
    const newConfidence = CardConfidenceSchema.parse({
      level: newLevel,
      evidenceQualityScore: newEvidenceQualityScore,
    });
    const downgraded: OpportunityCard = { ...card, confidence: newConfidence };
    survivors.push({ ...downgraded, rankScore: computeRankScore(downgraded) });
  });

  if (survivors.length === 0) {
    throw new ReviewerError("Every Opportunity Card was dropped by review -- the Evidence Packet did not support any card well enough to ship. Re-scan with more pages or connect more evidence sources before retrying the Scientist.");
  }

  survivors.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));

  const hasBuildThis = survivors.some((c) => c.nextAction === "build_this");
  if (!hasBuildThis) {
    // The original build_this card was dropped or downgraded away; promote
    // the highest-ranked survivor so the "exactly one build_this" invariant
    // (contract §2) still holds after review.
    survivors[0] = { ...survivors[0]!, nextAction: "build_this" };
  }

  return { cards: survivors };
}

export interface ReviewOpportunityReportOptions {
  maxAttempts?: number;
}

export async function reviewOpportunityReport(
  report: OpportunityReport,
  packet: EvidencePacket,
  llmClient: LlmClient,
  options: ReviewOpportunityReportOptions = {},
): Promise<ReviewedOpportunityReport> {
  const maxAttempts = options.maxAttempts ?? 2;
  const messages: LlmMessage[] = [{ role: "user", content: buildUserPrompt(report, packet) }];

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await llmClient.complete({ system: SYSTEM_PROMPT, messages });
    } catch (err) {
      if (err instanceof LlmCallError) {
        throw new ReviewerError(`Reviewer could not reach the Claude API (attempt ${attempt}/${maxAttempts}): ${err.message}`, err);
      }
      throw err;
    }

    let parsedJson: unknown;
    let jsonParseError: string | null = null;
    try {
      parsedJson = JSON.parse(extractJsonPayload(raw));
    } catch (err) {
      jsonParseError = `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (jsonParseError !== null) {
      lastError = jsonParseError;
    } else {
      const result = ReviewResponseSchema.safeParse(parsedJson);
      if (result.success && result.data.reviews.length === report.cards.length) {
        return { report: applyReview(report, result.data.reviews), reviewRecords: result.data.reviews };
      }
      lastError = result.success
        ? `Expected ${report.cards.length} review record(s), got ${result.data.reviews.length}.`
        : `Response did not match the review contract: ${result.error.message}`;
    }

    if (attempt < maxAttempts) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Your previous response failed validation: ${lastError}\n\nRespond again with ONLY the corrected JSON object -- one review record per card, in the same order.`,
      });
    }
  }

  throw new ReviewerError(`Reviewer failed to produce a contract-valid review after ${maxAttempts} attempt(s). Last error: ${lastError}`);
}
