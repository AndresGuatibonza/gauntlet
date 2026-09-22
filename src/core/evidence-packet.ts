/**
 * Evidence Packet & Scientist Output Contract (v0)
 *
 * These types are a direct, field-for-field mirror of the contract defined in
 * the project doc `claude/gauntlet-evidence-contract-v0.md` (§1). Do not add
 * or rename fields here without updating that doc first — it is the source
 * of truth, this file is the implementation of it.
 *
 * Per Gauntlet PRD v2 §8.1/§8.2 and the contract's own explicit non-goal:
 * this Ingestion Engine never infers hidden backend behavior, real user
 * behavior, or AI model behavior from frontend appearance alone. Anything
 * not directly observable goes into `missingEvidenceSummary`, never into an
 * evidence item as if it were observed fact.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// §1.1 Product identity
// ---------------------------------------------------------------------------
export const ProductIdentitySchema = z.object({
  url: z.string().url(),
  productName: z.string(),
  category: z.enum(["ai_tool", "ai_saas"]),
  statedValueProposition: z.string(),
  targetAudience: z.string(),
});
export type ProductIdentity = z.infer<typeof ProductIdentitySchema>;

// ---------------------------------------------------------------------------
// §1.2 Surface map
// ---------------------------------------------------------------------------
export const UnreachablePageSchema = z.object({
  url: z.string().url(),
  reason: z.string(),
});
export type UnreachablePage = z.infer<typeof UnreachablePageSchema>;

export const SurfaceMapSchema = z.object({
  pagesInspected: z.array(z.string().url()),
  primaryFlows: z.array(z.string()),
  ctas: z.array(z.string()),
  pagesNotReachable: z.array(UnreachablePageSchema),
});
export type SurfaceMap = z.infer<typeof SurfaceMapSchema>;

// ---------------------------------------------------------------------------
// §1.3 Observed evidence (the core evidence list)
// ---------------------------------------------------------------------------
export const EvidenceTypeSchema = z.enum([
  "copy",
  "ui_structure",
  "cta_placement",
  "pricing",
  "docs_gap",
  "error_state",
  "technical_signal",
  "other",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceConfidenceSchema = z.enum(["high", "medium", "low"]);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string(),
  sourceUrl: z.string().url(),
  timestamp: z.string().datetime(),
  evidenceType: EvidenceTypeSchema,
  observation: z.string(),
  rawExcerpt: z.string(),
  confidence: EvidenceConfidenceSchema,
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// ---------------------------------------------------------------------------
// §1.4-1.7 Reserved field groups -- not populated in the public-scan-only
// Ingestion Engine (Build Order #1). Present but empty, per the contract's
// own instruction, so the Scientist's input shape never has to change once
// these become real (analytics / observability / repo / AI-trace adapters,
// Build Order #4+).
// ---------------------------------------------------------------------------
export const ReservedEmptySchema = z.object({}).strict();
export type ReservedEmpty = z.infer<typeof ReservedEmptySchema>;

// ---------------------------------------------------------------------------
// §1.8 Confidence metadata (packet-level)
// ---------------------------------------------------------------------------
export const SourceReliabilitySchema = z.enum(["public_scan_only"]);

export const ConfidenceMetadataSchema = z.object({
  sourceReliability: SourceReliabilitySchema,
  freshness: z.string().datetime(),
  // The Ingestion Engine flags *candidate* contradictions for human review;
  // it does not resolve them. Auto-resolving a factual conflict from raw
  // page text would itself be an unsupported inference -- exactly what the
  // contract's non-goal forbids. See normalizer.ts for the (deliberately
  // narrow) heuristic used to populate this list.
  contradictions: z.array(z.string()),
  missingEvidenceSummary: z.string(),
});
export type ConfidenceMetadata = z.infer<typeof ConfidenceMetadataSchema>;

// ---------------------------------------------------------------------------
// Full Evidence Packet
// ---------------------------------------------------------------------------
export const EvidencePacketSchema = z.object({
  productIdentity: ProductIdentitySchema,
  surfaceMap: SurfaceMapSchema,
  observedEvidence: z.array(EvidenceItemSchema),
  behaviorEvidence: ReservedEmptySchema,
  reliabilityEvidence: ReservedEmptySchema,
  aiEvidence: ReservedEmptySchema,
  codeContext: ReservedEmptySchema,
  confidenceMetadata: ConfidenceMetadataSchema,
});
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;
