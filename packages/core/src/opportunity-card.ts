/**
 * Scientist Output Contract -- Opportunity Card (v0)
 *
 * Field-for-field mirror of `claude/gauntlet-evidence-contract-v0.md` §2.
 * That doc is the source of truth; this file is the implementation of it.
 * Do not add/rename/loosen a field here without updating that doc first.
 *
 * Per PRD §8.3: every report contains 3-5 of these, ranked, with exactly one
 * marked `nextAction: "build_this"` (the "Best next experiment").
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared 1-3 numeric scale used by impact/effort/confidence/evidenceQuality
// for rank_score, per §2.1: "numeric scale 1-3 per factor for v0... the
// written rationale accompanying the score is what a human concierge
// reviewer actually judges; the formula is a tie-breaker, not the product."
// ---------------------------------------------------------------------------
export const RankFactorScoreSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type RankFactorScore = z.infer<typeof RankFactorScoreSchema>;

export const ImpactLevelSchema = z.enum(["low", "medium", "high"]);
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>;

export const EffortLevelSchema = z.enum(["low", "medium", "high"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const ConfidenceLevelSchema = z.enum(["low", "medium", "high"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const ChangeSurfaceSchema = z.enum([
  "prompt",
  "model",
  "ux",
  "backend",
  "data",
  "tool",
  "reliability",
  "other",
]);
export type ChangeSurface = z.infer<typeof ChangeSurfaceSchema>;

export const NextActionSchema = z.enum([
  "build_this",
  "connect_data_to_validate",
  "do_not_prioritize_yet",
]);
export type NextAction = z.infer<typeof NextActionSchema>;

// ---------------------------------------------------------------------------
// Experiment -- MVP-level, per PRD §8.3: "control, variant, audience/traffic,
// primary metric, guardrails, and stopping rule at an MVP level."
// ---------------------------------------------------------------------------
export const ExperimentSchema = z.object({
  control: z.string(),
  variant: z.string(),
  audience: z.string(),
  primaryMetric: z.string(),
  guardrails: z.string(),
  stoppingRule: z.string(),
});
export type Experiment = z.infer<typeof ExperimentSchema>;

// ---------------------------------------------------------------------------
// expected_impact / effort / confidence are each "enum + string" per §2:
// a level plus a one-sentence rationale -- "no fabricated precision."
// ---------------------------------------------------------------------------
export const ExpectedImpactSchema = z.object({
  level: ImpactLevelSchema,
  rationale: z.string(),
  score: RankFactorScoreSchema,
});
export type ExpectedImpact = z.infer<typeof ExpectedImpactSchema>;

export const EffortSchema = z.object({
  level: EffortLevelSchema,
  explanation: z.string(),
  score: RankFactorScoreSchema,
});
export type Effort = z.infer<typeof EffortSchema>;

export const CardConfidenceSchema = z.object({
  level: ConfidenceLevelSchema,
  evidenceQualityScore: RankFactorScoreSchema,
});
export type CardConfidence = z.infer<typeof CardConfidenceSchema>;

// ---------------------------------------------------------------------------
// Full Opportunity Card, per §2
// ---------------------------------------------------------------------------
export const OpportunityCardSchema = z.object({
  title: z.string(),
  observation: z.string(),
  problemStatement: z.string(),
  hypothesis: z.string(),
  changeSurface: ChangeSurfaceSchema,
  experiment: ExperimentSchema,
  expectedImpact: ExpectedImpactSchema,
  effort: EffortSchema,
  confidence: CardConfidenceSchema,
  missingEvidence: z.string(),
  nextAction: NextActionSchema,
  // Every claim traces back to an Evidence Packet item id (e.g. "E3") --
  // no orphan claims, per §2's `evidence_refs` note.
  evidenceRefs: z.array(z.string()).min(1),
  // Not part of the LLM-authored contract fields -- computed by us in
  // scientist.ts from the four scores above, per §2.1's formula. Kept on the
  // same object so a card is self-contained once ranked.
  rankScore: z.number().optional(),
});
export type OpportunityCard = z.infer<typeof OpportunityCardSchema>;

/**
 * §2.1: rank_score = impact x confidence x evidence_quality / effort.
 * A pure function so scientist.ts and its tests can call it without going
 * through the LLM round-trip.
 */
export function computeRankScore(card: Pick<OpportunityCard, "expectedImpact" | "confidence" | "effort">): number {
  const { score: impact } = card.expectedImpact;
  const { evidenceQualityScore } = card.confidence;
  const { score: effort } = card.effort;
  return (impact * evidenceQualityScore) / effort;
}

/**
 * The set of Opportunity Cards for one Evidence Packet, per §2: "every
 * report contains 3-5 of these, ranked, with exactly one marked
 * next_action: 'build_this'." Validated as a set (not just per-card) so that
 * cross-card invariant is enforced in one place.
 */
export const OpportunityReportSchema = z
  .object({
    cards: z.array(OpportunityCardSchema).min(3).max(5),
  })
  .refine(
    (report) => report.cards.filter((c) => c.nextAction === "build_this").length === 1,
    { message: "Exactly one Opportunity Card must have nextAction \"build_this\" (the Best next experiment), per contract §2." },
  );
export type OpportunityReport = z.infer<typeof OpportunityReportSchema>;
