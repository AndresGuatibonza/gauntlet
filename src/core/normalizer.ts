/**
 * Evidence Normalizer (PRD §8.1/§8.2, §9 "Evidence Normalizer -- Core
 * contract"): maps whatever the Ingestion Engine collected into the single
 * Evidence Packet contract, independent of the crawling implementation.
 *
 * Honesty constraints carried over deliberately from the manual Otter.ai /
 * EchoDesk concierge dry-runs (see claude/gauntlet-evidence-contract-v0.md
 * §7-8 in the project doc):
 *   - `targetAudience` and `primaryFlows` are NOT reliably auto-extractable
 *     from static HTML in v0. Rather than fabricate a guess, they are left
 *     as an explicit "not detected" placeholder and the gap is named in
 *     `missingEvidenceSummary`.
 *   - `contradictions` are FLAGGED, never resolved. The heuristic here is
 *     narrow on purpose: if pricing evidence was extracted from more than
 *     one page and the raw text differs, that's surfaced as a candidate
 *     contradiction for a human to verify -- exactly the manual step that
 *     caught the real Otter.ai homepage/pricing-page conflict.
 */
import type {
  EvidencePacket,
  EvidenceItem,
  ProductIdentity,
  SurfaceMap,
  ConfidenceMetadata,
} from "./evidence-packet.js";
import type { FetchResult } from "./fetcher.js";
import type { PageExtraction } from "./extractor.js";

export interface PageScanResult {
  fetch: FetchResult;
  extraction: PageExtraction | null;
}

export interface NormalizerInput {
  homepageUrl: string;
  category: "ai_tool" | "ai_saas";
  pages: PageScanResult[];
  notReachable: Array<{ url: string; reason: string }>;
  now: () => string;
}

function deriveProductName(pageTitle: string | null, homepageUrl: string): string {
  if (pageTitle) {
    const firstSegment = pageTitle.split(/[|\-–—]/)[0]?.trim();
    if (firstSegment && firstSegment.length > 0 && firstSegment.length <= 60) {
      return firstSegment;
    }
    return pageTitle;
  }
  try {
    return new URL(homepageUrl).hostname;
  } catch {
    return homepageUrl;
  }
}

const NOT_DETECTED_V0 = "Not automatically detected in v0 (static-HTML-only scan) -- requires manual read or a future extraction pass.";

function buildProductIdentity(input: NormalizerInput): ProductIdentity {
  const homepage = input.pages.find((p) => p.fetch.url === input.homepageUrl);
  const extraction = homepage?.extraction ?? null;

  return {
    url: input.homepageUrl,
    productName: deriveProductName(extraction?.pageTitle ?? null, input.homepageUrl),
    category: input.category,
    statedValueProposition: extraction?.firstHeading ?? extraction?.pageTitle ?? NOT_DETECTED_V0,
    targetAudience: NOT_DETECTED_V0,
  };
}

function buildSurfaceMap(input: NormalizerInput): SurfaceMap {
  const ctas = new Set<string>();
  const pagesInspected: string[] = [];

  for (const page of input.pages) {
    if (page.fetch.ok) {
      pagesInspected.push(page.fetch.url);
      for (const cta of page.extraction?.ctaTexts ?? []) {
        ctas.add(cta);
      }
    }
  }

  return {
    pagesInspected,
    // Not reliably auto-extractable from static HTML alone in v0; see
    // module doc. Left empty rather than fabricated.
    primaryFlows: [],
    ctas: Array.from(ctas),
    pagesNotReachable: input.notReachable,
  };
}

function buildObservedEvidence(input: NormalizerInput, timestamp: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let counter = 1;

  for (const page of input.pages) {
    if (!page.fetch.ok || !page.extraction) continue;
    for (const raw of page.extraction.evidence) {
      items.push({
        id: `E${counter}`,
        sourceUrl: raw.sourceUrl,
        timestamp,
        evidenceType: raw.evidenceType,
        observation: raw.observation,
        rawExcerpt: raw.rawExcerpt,
        confidence: raw.confidence,
      });
      counter += 1;
    }
  }

  return items;
}

/**
 * Narrow, disclosed heuristic: flag (never resolve) a candidate
 * contradiction when pricing evidence extracted from two different pages
 * has different raw text. This is exactly the check that a human did by
 * hand for the Otter.ai pilot -- automating only the "flag for review" step,
 * not the judgment of whether it's a real conflict.
 *
 * IMPORTANT SCOPE LIMIT, found by running this against the real otter.ai
 * site: comparing whole raw-excerpt strings across pages produced 3 "candidate
 * contradictions" that were not real conflicts at all -- a detail page simply
 * listing several plans/billing cycles will almost always differ, in raw
 * text, from a homepage showing one headline number, even when every one of
 * those figures is mutually consistent (one of them, in the real scan, was
 * literally the same $19.99 shown on both pages, buried in a longer list).
 * The real manual finding this heuristic is meant to approximate (Otter.ai's
 * "6,000 minutes" vs "Unlimited" claim for the same named Business plan) was
 * a single-figure-vs-single-figure conflict, not a set-difference. So this
 * only compares pages where BOTH sides extracted exactly one distinct price
 * figure -- matching that same shape -- and skips (rather than guesses at)
 * any page with multiple prices, since associating a price with a specific
 * plan name is out of scope for v0 per the contract's non-goal.
 */
function findCandidatePricingContradictions(evidence: EvidenceItem[]): string[] {
  const pricingValuesByPage = new Map<string, string[]>();
  for (const item of evidence) {
    if (item.evidenceType !== "pricing") continue;
    const values = item.rawExcerpt.split(", ").map((v) => v.trim());
    const existing = pricingValuesByPage.get(item.sourceUrl) ?? [];
    pricingValuesByPage.set(item.sourceUrl, [...existing, ...values]);
  }

  const singleValuePages = Array.from(pricingValuesByPage.entries()).filter(
    ([, values]) => values.length === 1,
  ) as Array<[string, [string]]>;

  const contradictions: string[] = [];
  for (let i = 0; i < singleValuePages.length; i += 1) {
    for (let j = i + 1; j < singleValuePages.length; j += 1) {
      const [urlA, [valueA]] = singleValuePages[i]!;
      const [urlB, [valueB]] = singleValuePages[j]!;
      if (valueA !== valueB) {
        contradictions.push(
          `Pricing figures differ between ${urlA} ("${valueA}") and ${urlB} ("${valueB}") -- needs human verification before treating as a real conflict, per the contract's non-goal.`,
        );
      }
    }
  }
  return contradictions;
}

function buildConfidenceMetadata(evidence: EvidenceItem[], timestamp: string): ConfidenceMetadata {
  const gaps = [
    "public_scan_only: no repo, analytics, or observability connected",
    "no JS execution: interactive/dynamic content (e.g. live chat widgets) is not observed",
    "docs_gap findings require a human judgment about absence and are not auto-detected",
    "target_audience and primary_flows are not reliably auto-extractable from static HTML in v0",
    "pages listing multiple price points are not cross-checked against each other -- associating a figure with a specific plan name is out of scope for v0, so consistency across multi-plan pricing pages requires manual review",
  ];

  return {
    sourceReliability: "public_scan_only",
    freshness: timestamp,
    contradictions: findCandidatePricingContradictions(evidence),
    missingEvidenceSummary: gaps.join("; "),
  };
}

export function buildEvidencePacket(input: NormalizerInput): EvidencePacket {
  const timestamp = input.now();
  const observedEvidence = buildObservedEvidence(input, timestamp);

  return {
    productIdentity: buildProductIdentity(input),
    surfaceMap: buildSurfaceMap(input),
    observedEvidence,
    behaviorEvidence: {},
    reliabilityEvidence: {},
    aiEvidence: {},
    codeContext: {},
    confidenceMetadata: buildConfidenceMetadata(observedEvidence, timestamp),
  };
}
