import { describe, it, expect } from "vitest";
import {
  extractPageTitle,
  extractFirstHeading,
  extractNavItems,
  extractCtas,
  extractPricingEvidence,
  extractPufferyEvidence,
  extractFormsEvidence,
  extractPage,
} from "../src/extractor.js";

describe("extractPageTitle / extractFirstHeading", () => {
  it("extracts the title and first h1", () => {
    const html = "<html><head><title>Acme | Pricing</title></head><body><h1>Simple pricing</h1></body></html>";
    expect(extractPageTitle(html)).toBe("Acme | Pricing");
    expect(extractFirstHeading(html)).toBe("Simple pricing");
  });

  it("returns null when absent", () => {
    expect(extractPageTitle("<html><body></body></html>")).toBeNull();
    expect(extractFirstHeading("<html><body></body></html>")).toBeNull();
  });
});

describe("extractNavItems", () => {
  it("collects nav/header link text, deduped", () => {
    const html = `<html><body>
      <nav><a href="/a">Home</a><a href="/b">Pricing</a><a href="/a">Home</a></nav>
    </body></html>`;
    expect(extractNavItems(html)).toEqual(["Home", "Pricing"]);
  });
});

describe("extractCtas", () => {
  it("detects known CTA phrasing and ignores generic links", () => {
    const html = `<html><body>
      <a href="/x">Start for free</a>
      <button>Book a demo</button>
      <a href="/y">Learn more</a>
    </body></html>`;
    const { ctaTexts } = extractCtas(html, "https://example.com/");
    expect(ctaTexts).toContain("Start for free");
    expect(ctaTexts).toContain("Book a demo");
    expect(ctaTexts).not.toContain("Learn more");
  });

  it("produces one evidence item summarizing all CTAs found on the page", () => {
    const html = `<a href="/x">Sign up</a><a href="/y">Contact sales</a>`;
    const { evidence } = extractCtas(html, "https://example.com/");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.evidenceType).toBe("cta_placement");
    expect(evidence[0]?.confidence).toBe("high");
  });

  it("produces no evidence when no CTA is found", () => {
    const { evidence } = extractCtas("<a href='/y'>Learn more</a>", "https://example.com/");
    expect(evidence).toHaveLength(0);
  });
});

describe("extractPricingEvidence", () => {
  it("extracts distinct price-like figures", () => {
    const html = `<body>Growth plan: $30/mo. Enterprise: $19.99/user. Free tier: $0.</body>`;
    const evidence = extractPricingEvidence(html, "https://example.com/pricing");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.evidenceType).toBe("pricing");
    expect(evidence[0]?.rawExcerpt).toContain("$30");
  });

  it("returns nothing when no price-like text is present", () => {
    expect(extractPricingEvidence("<body>No numbers here.</body>", "https://example.com/")).toHaveLength(0);
  });
});

describe("extractPufferyEvidence", () => {
  it("flags an unverifiable social-proof claim", () => {
    const html = `<body>Trusted by 500+ support teams worldwide.</body>`;
    const evidence = extractPufferyEvidence(html, "https://example.com/");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.evidenceType).toBe("copy");
    expect(evidence[0]?.confidence).toBe("medium");
  });

  it("does not flag ordinary copy", () => {
    expect(extractPufferyEvidence("<body>We help teams write better docs.</body>", "https://example.com/")).toHaveLength(0);
  });
});

describe("extractFormsEvidence", () => {
  it("reports one evidence item per form with field count", () => {
    const html = `<form><input name="email"><input name="password" type="password"></form>`;
    const evidence = extractFormsEvidence(html, "https://example.com/signup");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.observation).toContain("2 field(s)");
  });

  it("returns nothing when there are no forms", () => {
    expect(extractFormsEvidence("<body>no forms</body>", "https://example.com/")).toHaveLength(0);
  });
});

describe("extractPage", () => {
  it("combines all extractors into one PageExtraction result", () => {
    const html = `<html><head><title>Acme AI</title></head><body>
      <h1>Automate your support</h1>
      <nav><a href="/pricing">Pricing</a></nav>
      <a href="/start">Start for free</a>
      <p>Trusted by 1,000+ teams. Plans from $19.99/mo.</p>
    </body></html>`;
    const result = extractPage(html, "https://example.com/");
    expect(result.pageTitle).toBe("Acme AI");
    expect(result.firstHeading).toBe("Automate your support");
    expect(result.navItems).toEqual(["Pricing"]);
    expect(result.ctaTexts).toContain("Start for free");
    const types = result.evidence.map((e) => e.evidenceType);
    expect(types).toContain("cta_placement");
    expect(types).toContain("ui_structure");
    expect(types).toContain("pricing");
    expect(types).toContain("copy");
  });
});
