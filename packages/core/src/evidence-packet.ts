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
// §1.4, §1.5, §1.7 Reserved field groups -- not populated yet. Present but
// empty, per the contract's own instruction, so the Scientist's input shape
// never has to change once these become real (analytics / observability /
// repo adapters, Build Order #4+).
// ---------------------------------------------------------------------------
export const ReservedEmptySchema = z.object({}).strict();
export type ReservedEmpty = z.infer<typeof ReservedEmptySchema>;

// ---------------------------------------------------------------------------
// §1.6 AI evidence (contract Amendment 1). Empty ({}) in every public-scan
// packet; populated only by the CLI from a local Token Profiler (see
// token-profiler-adapter.ts). Items are citable like §1.3 items, with ids
// A1, A2... that never collide with §1.3's E1, E2...
// ---------------------------------------------------------------------------
export const AiEvidenceTypeSchema = z.enum(["usage_profile", "failure_rate", "anomaly_flag", "context_repetition"]);
export type AiEvidenceType = z.infer<typeof AiEvidenceTypeSchema>;

export const AiEvidenceItemSchema = z
  .object({
    id: z.string().regex(/^A[1-9]\d*$/, 'AI evidence ids are "A1", "A2", ...'),
    sourceRef: z.string().min(1),
    timestamp: z.string().datetime(),
    evidenceType: AiEvidenceTypeSchema,
    observation: z.string().min(1),
    rawExcerpt: z.string(),
    // "low" is deliberately not allowed: every item is a deterministic
    // aggregate. "medium" marks figures that rest on estimated or partial
    // token provenance.
    confidence: z.enum(["high", "medium"]),
  })
  .strict();
export type AiEvidenceItem = z.infer<typeof AiEvidenceItemSchema>;

export const AiEvidenceSourceSchema = z
  .object({
    system: z.literal("token_profiler"),
    connectors: z.array(z.string()),
    window: z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict(),
    sessionCount: z.number().int().nonnegative(),
    invocationCount: z.number().int().nonnegative(),
    pulledAt: z.string().datetime(),
  })
  .strict();
export type AiEvidenceSource = z.infer<typeof AiEvidenceSourceSchema>;

export const PopulatedAiEvidenceSchema = z
  .object({
    source: AiEvidenceSourceSchema,
    items: z.array(AiEvidenceItemSchema).min(1),
    // Checks that could not run for this data. Never to be read as "no
    // problem found" (contract §1.6).
    notEvaluable: z.array(z.string()),
  })
  .strict();
export type PopulatedAiEvidence = z.infer<typeof PopulatedAiEvidenceSchema>;

export const AiEvidenceSchema = z.union([PopulatedAiEvidenceSchema, ReservedEmptySchema]);
export type AiEvidence = z.infer<typeof AiEvidenceSchema>;

export function isPopulatedAiEvidence(value: AiEvidence): value is PopulatedAiEvidence {
  return "items" in value;
}

// ---------------------------------------------------------------------------
// §1.8 Confidence metadata (packet-level)
// ---------------------------------------------------------------------------
export const SourceReliabilitySchema = z.enum(["public_scan_only", "public_scan_plus_ai_traces"]);

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
export const EvidencePacketSchema = z
  .object({
    productIdentity: ProductIdentitySchema,
    surfaceMap: SurfaceMapSchema,
    observedEvidence: z.array(EvidenceItemSchema),
    behaviorEvidence: ReservedEmptySchema,
    reliabilityEvidence: ReservedEmptySchema,
    aiEvidence: AiEvidenceSchema,
    codeContext: ReservedEmptySchema,
    confidenceMetadata: ConfidenceMetadataSchema,
  })
  .superRefine((packet, ctx) => {
    // sourceReliability must say whether trace evidence is present, so a
    // reader (or the Scientist) can never mistake one kind of packet for
    // the other.
    const hasTraces = isPopulatedAiEvidence(packet.aiEvidence);
    const declared = packet.confidenceMetadata.sourceReliability;
    if (hasTraces !== (declared === "public_scan_plus_ai_traces")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidenceMetadata", "sourceReliability"],
        message: hasTraces
          ? 'A packet with populated aiEvidence must declare sourceReliability "public_scan_plus_ai_traces".'
          : 'sourceReliability "public_scan_plus_ai_traces" requires populated aiEvidence.',
      });
    }
    // Every citable id must be unique across §1.3 and §1.6.
    const seen = new Set<string>();
    for (const id of citableEvidenceIds(packet)) {
      if (seen.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["aiEvidence"], message: `Duplicate evidence id "${id}".` });
      }
      seen.add(id);
    }
  });
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;

/**
 * Every id an Opportunity Card may cite in evidenceRefs: §1.3 items (E*)
 * plus, when present, §1.6 AI evidence items (A*). Returned as an array (in
 * packet order) so duplicates stay detectable.
 */
export function citableEvidenceIds(packet: Pick<EvidencePacket, "observedEvidence" | "aiEvidence">): string[] {
  const ids = packet.observedEvidence.map((item) => item.id);
  if (isPopulatedAiEvidence(packet.aiEvidence)) ids.push(...packet.aiEvidence.items.map((item) => item.id));
  return ids;
}

// ---------------------------------------------------------------------------
// Pre-Scientist guard: is there anything to analyze at all?
// ---------------------------------------------------------------------------
// The Opportunity Card contract (§2) requires every card to cite at least one
// real `observedEvidence` id. A packet with zero evidence items therefore
// makes the Scientist's task impossible by construction -- it cannot satisfy
// "3-5 cards" and "cite real ids" at the same time. Its corrective retry
// cannot fix that either, because the problem is not formatting, it is that
// there is nothing to cite. Callers must check this BEFORE spending a Claude
// API call, and fail with the real upstream reason instead of a misleading
// Zod "evidenceRefs must contain at least 1 element" error.
//
// This is a strict emptiness check on purpose. "Too little evidence to be
// useful" is a judgment call the contract does not define yet; inventing a
// numeric threshold here would be undocumented architecture.

/** Max unreachable pages listed individually in the explanation. */
const MAX_UNREACHABLE_LISTED = 3;

export function hasInsufficientEvidence(packet: EvidencePacket): boolean {
  return citableEvidenceIds(packet).length === 0;
}

/**
 * Human-readable explanation of WHY a packet has no evidence, built only from
 * what the packet itself recorded (fetch failure reasons, pages inspected) --
 * no guessing beyond the one documented v0 limitation (no JS execution).
 */
export function describeInsufficientEvidence(packet: EvidencePacket): string {
  const url = packet.productIdentity.url;
  const { pagesInspected, pagesNotReachable } = packet.surfaceMap;
  const causes: string[] = [];

  if (pagesNotReachable.length > 0) {
    const listed = pagesNotReachable
      .slice(0, MAX_UNREACHABLE_LISTED)
      .map((p) => `${p.url} (${p.reason})`)
      .join("; ");
    const extra = pagesNotReachable.length - MAX_UNREACHABLE_LISTED;
    causes.push(
      `${pagesNotReachable.length} page(s) could not be fetched: ${listed}` +
        (extra > 0 ? `; and ${extra} more` : "") +
        ". The site may be blocking automated requests.",
    );
  }

  if (pagesInspected.length > 0) {
    causes.push(
      `${pagesInspected.length} page(s) were fetched but yielded no extractable evidence from their static HTML. ` +
        "The site likely renders its content with JavaScript, which this v0 scanner does not execute.",
    );
  }

  if (causes.length === 0) {
    causes.push("No pages were fetched or reported as unreachable.");
  }

  return (
    `No observable evidence could be collected from ${url}, so there is nothing for the Product Scientist to cite. ` +
    `${causes.join(" ")} No analysis was run (no Claude API call was made).`
  );
}
