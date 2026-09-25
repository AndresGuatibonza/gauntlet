import { describe, it, expect } from "vitest";
import { hasInsufficientEvidence, describeInsufficientEvidence } from "../src/evidence-packet.js";
import { fakeEvidencePacket } from "./fixtures.js";

describe("hasInsufficientEvidence", () => {
  it("is false when the packet has at least one evidence item", () => {
    expect(hasInsufficientEvidence(fakeEvidencePacket())).toBe(false);
  });

  it("is true when observedEvidence is empty", () => {
    expect(hasInsufficientEvidence(fakeEvidencePacket({ observedEvidence: [] }))).toBe(true);
  });
});

describe("describeInsufficientEvidence", () => {
  it("names the real fetch failure reason when the site blocked every page (e.g. HTTP 403)", () => {
    const packet = fakeEvidencePacket({
      observedEvidence: [],
      surfaceMap: {
        pagesInspected: [],
        primaryFlows: [],
        ctas: [],
        pagesNotReachable: [{ url: "https://www.perplexity.ai/", reason: "HTTP 403" }],
      },
    });
    const message = describeInsufficientEvidence(packet);
    expect(message).toContain("https://example.com/");
    expect(message).toContain("https://www.perplexity.ai/ (HTTP 403)");
    expect(message).toContain("blocking automated requests");
    expect(message).toContain("no Claude API call was made");
    expect(message).not.toContain("JavaScript");
  });

  it("points at JS rendering when pages were fetched but yielded no evidence", () => {
    const packet = fakeEvidencePacket({
      observedEvidence: [],
      surfaceMap: {
        pagesInspected: ["https://example.com/"],
        primaryFlows: [],
        ctas: [],
        pagesNotReachable: [],
      },
    });
    const message = describeInsufficientEvidence(packet);
    expect(message).toContain("1 page(s) were fetched but yielded no extractable evidence");
    expect(message).toContain("JavaScript");
    expect(message).not.toContain("could not be fetched");
  });

  it("lists at most 3 unreachable pages and summarizes the rest", () => {
    const pagesNotReachable = [1, 2, 3, 4, 5].map((n) => ({
      url: `https://example.com/p${n}`,
      reason: "timeout",
    }));
    const packet = fakeEvidencePacket({
      observedEvidence: [],
      surfaceMap: { pagesInspected: [], primaryFlows: [], ctas: [], pagesNotReachable },
    });
    const message = describeInsufficientEvidence(packet);
    expect(message).toContain("5 page(s) could not be fetched");
    expect(message).toContain("https://example.com/p3 (timeout)");
    expect(message).not.toContain("https://example.com/p4");
    expect(message).toContain("and 2 more");
  });

  it("still returns a clear message when nothing was fetched or reported unreachable", () => {
    const packet = fakeEvidencePacket({
      observedEvidence: [],
      surfaceMap: { pagesInspected: [], primaryFlows: [], ctas: [], pagesNotReachable: [] },
    });
    expect(describeInsufficientEvidence(packet)).toContain("No pages were fetched or reported as unreachable.");
  });
});
