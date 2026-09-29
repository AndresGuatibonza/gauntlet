import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, within } from "@testing-library/react";
import type { EvidenceItem, OpportunityCard } from "@gauntlet/core";
import { OpportunityCardView, safeSourceLink, truncateExcerpt, MAX_EXCERPT_CHARS } from "@/components/opportunity-card";

afterEach(cleanup);

function evidence(id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id,
    sourceUrl: "https://example.com/pricing",
    timestamp: "2026-09-29T00:00:00.000Z",
    evidenceType: "pricing",
    observation: `Observation for ${id}.`,
    rawExcerpt: `Raw excerpt for ${id}`,
    confidence: "high",
    ...overrides,
  };
}

function card(overrides: Partial<OpportunityCard> = {}): OpportunityCard {
  return {
    title: "Clarify overage policy",
    observation: "Pricing page lists limits but no overage behavior.",
    problemStatement: "Buyers can't predict cost past the plan limit.",
    hypothesis: "Stating the overage policy increases paid conversion.",
    changeSurface: "ux",
    experiment: {
      control: "Current pricing page",
      variant: "Pricing page with overage policy",
      audience: "50% of pricing-page visitors",
      primaryMetric: "Paid conversion",
      guardrails: "Support tickets about billing",
      stoppingRule: "Two weeks or 1,000 visitors per arm",
    },
    expectedImpact: { level: "medium", rationale: "Pricing clarity affects the purchase step.", score: 2 },
    effort: { level: "low", explanation: "Copy change only.", score: 3 },
    confidence: { level: "medium", evidenceQualityScore: 2 },
    missingEvidence: "Funnel drop-off on the pricing step.",
    nextAction: "build_this",
    evidenceRefs: ["E1", "E2"],
    ...overrides,
  };
}

const EVIDENCE = new Map([
  ["E1", evidence("E1")],
  ["E2", evidence("E2", { sourceUrl: "https://example.com/", rawExcerpt: "Start for free" })],
]);

describe("OpportunityCardView", () => {
  it("renders every contract field the PRD report structure asks for", () => {
    const { getByText } = render(<OpportunityCardView card={card()} isHero evidenceById={EVIDENCE} />);
    for (const text of [
      "Best next experiment",
      "UX / messaging",
      "Clarify overage policy",
      "Stating the overage policy increases paid conversion.",
      "Buyers can't predict cost past the plan limit.",
      "Pricing clarity affects the purchase step.",
      "Copy change only.",
      "Pricing page lists limits but no overage behavior.",
      "Funnel drop-off on the pricing step.",
      "50% of pricing-page visitors",
      "Support tickets about billing",
      "Two weeks or 1,000 visitors per arm",
    ]) {
      expect(getByText(text, { exact: false })).toBeTruthy();
    }
  });

  it("resolves each cited evidence id to its observation, excerpt and source link", () => {
    const { container } = render(<OpportunityCardView card={card()} evidenceById={EVIDENCE} />);
    const items = container.querySelectorAll(".evidence-list li");
    expect(items).toHaveLength(2);
    const first = within(items[0] as HTMLElement);
    expect(first.getByText("E1")).toBeTruthy();
    expect(first.getByText("Observation for E1.", { exact: false })).toBeTruthy();
    expect(first.getByText("Raw excerpt for E1")).toBeTruthy();
    const link = first.getByRole("link") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/pricing");
    expect(link.textContent).toBe("example.com/pricing");
    expect(link.rel).toContain("noopener");
    expect(within(items[1] as HTMLElement).getByRole("link").textContent).toBe("example.com");
  });

  it("opens the evidence list on the hero card only", () => {
    const hero = render(<OpportunityCardView card={card()} isHero evidenceById={EVIDENCE} />);
    expect((hero.container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
    cleanup();
    const other = render(<OpportunityCardView card={card()} evidenceById={EVIDENCE} />);
    expect((other.container.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("degrades gracefully when a cited id is missing from the packet", () => {
    const { getByText } = render(
      <OpportunityCardView card={card({ evidenceRefs: ["E9"] })} evidenceById={EVIDENCE} />,
    );
    expect(getByText("E9")).toBeTruthy();
    expect(getByText("Not found in this scan's evidence.", { exact: false })).toBeTruthy();
  });

  it("never renders a non-http(s) source as a link", () => {
    const evil = new Map([["E1", evidence("E1", { sourceUrl: "javascript:alert(1)" })]]);
    const { container } = render(<OpportunityCardView card={card({ evidenceRefs: ["E1"] })} evidenceById={evil} />);
    expect(container.querySelector(".evidence-list a")).toBeNull();
  });
});

describe("helpers", () => {
  it("safeSourceLink only accepts http(s)", () => {
    expect(safeSourceLink("https://a.com/x")).toEqual({ href: "https://a.com/x", label: "a.com/x" });
    expect(safeSourceLink("javascript:alert(1)")).toBeNull();
    expect(safeSourceLink("data:text/html,hi")).toBeNull();
    expect(safeSourceLink("not a url")).toBeNull();
  });

  it("truncateExcerpt collapses whitespace and caps length with an ellipsis", () => {
    expect(truncateExcerpt("a   b\n\nc")).toBe("a b c");
    const long = "x".repeat(MAX_EXCERPT_CHARS + 50);
    const out = truncateExcerpt(long);
    expect(out.length).toBe(MAX_EXCERPT_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});
