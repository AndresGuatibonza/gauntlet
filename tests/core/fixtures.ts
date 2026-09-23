import type { EvidencePacket } from "../../src/core/evidence-packet.js";

/** Minimal, contract-valid Evidence Packet fixture shared by scientist/reviewer tests. */
export function fakeEvidencePacket(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    productIdentity: {
      url: "https://example.com/",
      productName: "Example",
      category: "ai_saas",
      statedValueProposition: "Resolve tickets automatically",
      targetAudience: "not detected in v0 (static-HTML scan only)",
    },
    surfaceMap: {
      pagesInspected: ["https://example.com/", "https://example.com/pricing"],
      primaryFlows: [],
      ctas: ["Start for free"],
      pagesNotReachable: [],
    },
    observedEvidence: [
      {
        id: "E1",
        sourceUrl: "https://example.com/",
        timestamp: "2026-09-22T00:00:00.000Z",
        evidenceType: "cta_placement",
        observation: "Page presents 1 distinct call-to-action label(s): Start for free.",
        rawExcerpt: "Start for free",
        confidence: "high",
      },
      {
        id: "E2",
        sourceUrl: "https://example.com/pricing",
        timestamp: "2026-09-22T00:00:00.000Z",
        evidenceType: "pricing",
        observation: "Page contains 1 distinct price-like figure(s).",
        rawExcerpt: "$30/mo",
        confidence: "high",
      },
    ],
    behaviorEvidence: {},
    reliabilityEvidence: {},
    aiEvidence: {},
    codeContext: {},
    confidenceMetadata: {
      sourceReliability: "public_scan_only",
      freshness: "2026-09-22T00:00:00.000Z",
      contradictions: [],
      missingEvidenceSummary: "No analytics/observability/repo connected in v0.",
    },
    ...overrides,
  };
}

/** A single contract-valid Opportunity Card, for reviewer.test.ts fixtures. */
export function fakeOpportunityCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: "Clarify pricing before the CTA",
    observation: "Homepage CTA leads to signup before pricing is shown.",
    problemStatement: "Users may abandon signup when pricing is unclear upfront.",
    hypothesis: "Showing the price near the CTA will reduce signup abandonment.",
    changeSurface: "ux",
    experiment: {
      control: "Current homepage",
      variant: "Homepage with price shown next to CTA",
      audience: "100% of homepage visitors",
      primaryMetric: "Signup completion rate",
      guardrails: "Overall signup volume does not drop >5%",
      stoppingRule: "Stop after 2 weeks or 1000 signups per arm",
    },
    expectedImpact: { level: "medium", rationale: "Pricing clarity is a common conversion lever.", score: 2 },
    effort: { level: "low", explanation: "Single copy/layout change.", score: 1 },
    confidence: { level: "medium", evidenceQualityScore: 2 },
    missingEvidence: "No funnel analytics connected to confirm drop-off point.",
    nextAction: "build_this",
    evidenceRefs: ["E1", "E2"],
    ...overrides,
  };
}
