import { describe, it, expect } from "vitest";
import { buildEvidencePacket, type PageScanResult } from "../../src/core/normalizer.js";
import { EvidencePacketSchema } from "../../src/core/evidence-packet.js";
import type { PageExtraction } from "../../src/core/extractor.js";

const FIXED_NOW = () => "2026-09-22T00:00:00.000Z";

function fakeExtraction(overrides: Partial<PageExtraction> = {}): PageExtraction {
  return {
    evidence: [],
    ctaTexts: [],
    navItems: [],
    pageTitle: null,
    firstHeading: null,
    ...overrides,
  };
}

describe("buildEvidencePacket", () => {
  it("derives the product name from the homepage title, stripping a pipe-separated suffix", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "<html></html>" },
        extraction: fakeExtraction({ pageTitle: "Acme AI | The best support copilot" }),
      },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable: [],
      now: FIXED_NOW,
    });
    expect(packet.productIdentity.productName).toBe("Acme AI");
  });

  it("falls back to the hostname when no title was extracted", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "<html></html>" },
        extraction: fakeExtraction(),
      },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable: [],
      now: FIXED_NOW,
    });
    expect(packet.productIdentity.productName).toBe("example.com");
  });

  it("assigns sequential ids across evidence collected from multiple pages", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          evidence: [
            { sourceUrl: "https://example.com/", evidenceType: "cta_placement", observation: "o1", rawExcerpt: "r1", confidence: "high" },
          ],
        }),
      },
      {
        fetch: { url: "https://example.com/pricing", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          evidence: [
            { sourceUrl: "https://example.com/pricing", evidenceType: "pricing", observation: "o2", rawExcerpt: "r2", confidence: "high" },
          ],
        }),
      },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable: [],
      now: FIXED_NOW,
    });
    expect(packet.observedEvidence.map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("flags a candidate contradiction when pricing evidence differs across pages", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          evidence: [
            { sourceUrl: "https://example.com/", evidenceType: "pricing", observation: "o", rawExcerpt: "$19.99/mo", confidence: "high" },
          ],
        }),
      },
      {
        fetch: { url: "https://example.com/pricing", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          evidence: [
            { sourceUrl: "https://example.com/pricing", evidenceType: "pricing", observation: "o", rawExcerpt: "$30/mo", confidence: "high" },
          ],
        }),
      },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable: [],
      now: FIXED_NOW,
    });
    expect(packet.confidenceMetadata.contradictions).toHaveLength(1);
    expect(packet.confidenceMetadata.contradictions[0]).toContain("Pricing figures differ");
  });

  it("does not flag a contradiction when pricing evidence matches across pages", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          evidence: [
            { sourceUrl: "https://example.com/", evidenceType: "pricing", observation: "o", rawExcerpt: "$19.99/mo", confidence: "high" },
          ],
        }),
      },
      {
        fetch: { url: "https://example.com/pricing", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          evidence: [
            { sourceUrl: "https://example.com/pricing", evidenceType: "pricing", observation: "o", rawExcerpt: "$19.99/mo", confidence: "high" },
          ],
        }),
      },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable: [],
      now: FIXED_NOW,
    });
    expect(packet.confidenceMetadata.contradictions).toHaveLength(0);
  });

  it("propagates not-reachable pages into the surface map", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "" },
        extraction: fakeExtraction(),
      },
    ];
    const notReachable = [{ url: "https://example.com/help", reason: "bot protection" }];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable,
      now: FIXED_NOW,
    });
    expect(packet.surfaceMap.pagesNotReachable).toEqual(notReachable);
  });

  it("excludes failed-fetch pages from pagesInspected", () => {
    const pages: PageScanResult[] = [
      { fetch: { url: "https://example.com/", ok: true, status: 200, html: "" }, extraction: fakeExtraction() },
      { fetch: { url: "https://example.com/gone", ok: false, reason: "HTTP 404" }, extraction: null },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_saas",
      pages,
      notReachable: [{ url: "https://example.com/gone", reason: "HTTP 404" }],
      now: FIXED_NOW,
    });
    expect(packet.surfaceMap.pagesInspected).toEqual(["https://example.com/"]);
  });

  it("always produces a packet that satisfies the contract schema", () => {
    const pages: PageScanResult[] = [
      {
        fetch: { url: "https://example.com/", ok: true, status: 200, html: "" },
        extraction: fakeExtraction({
          pageTitle: "Acme",
          firstHeading: "Automate everything",
          ctaTexts: ["Start for free"],
          evidence: [
            { sourceUrl: "https://example.com/", evidenceType: "cta_placement", observation: "o", rawExcerpt: "r", confidence: "high" },
          ],
        }),
      },
    ];
    const packet = buildEvidencePacket({
      homepageUrl: "https://example.com/",
      category: "ai_tool",
      pages,
      notReachable: [],
      now: FIXED_NOW,
    });
    const parsed = EvidencePacketSchema.safeParse(packet);
    expect(parsed.success).toBe(true);
  });
});
