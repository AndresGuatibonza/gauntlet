import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, within, fireEvent } from "@testing-library/react";
import type { EvidenceItem, OpportunityCard } from "@gauntlet/core";
import {
  OpportunityCardView,
  safeSourceLink,
  truncateExcerpt,
  MAX_EXCERPT_CHARS,
  type CardActions,
} from "@/components/opportunity-card";

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

describe("card actions", () => {
  function actions(overrides: Partial<CardActions> = {}): CardActions {
    return {
      rating: null,
      feedbackError: null,
      onRate: vi.fn(),
      onBuildThis: vi.fn(),
      onSectionOpened: vi.fn(),
      ...overrides,
    };
  }

  it("renders no actions when none are passed (presentational use)", () => {
    const { queryByText, queryByRole } = render(<OpportunityCardView card={card()} evidenceById={EVIDENCE} />);
    expect(queryByText("Build this", { exact: false })).toBeNull();
    expect(queryByRole("group", { name: "Rate this opportunity" })).toBeNull();
  });

  it("reports Build this clicks and each of the five contract ratings", () => {
    const a = actions();
    const { getByText, getByRole } = render(<OpportunityCardView card={card()} evidenceById={EVIDENCE} actions={a} />);
    fireEvent.click(getByText("Build this", { exact: false }));
    expect(a.onBuildThis).toHaveBeenCalledTimes(1);

    const group = within(getByRole("group", { name: "Rate this opportunity" }));
    const expected = [
      ["Obvious", "obvious"],
      ["Useful", "useful"],
      ["Surprising", "surprising"],
      ["Wrong", "wrong"],
      ["Would act now", "would_act_now"],
    ] as const;
    for (const [label, value] of expected) {
      fireEvent.click(group.getByRole("button", { name: label }));
      expect(a.onRate).toHaveBeenLastCalledWith(value);
    }
    expect(a.onRate).toHaveBeenCalledTimes(5);
  });

  it("marks only the selected rating as pressed and shows a save error", () => {
    const { getByRole, getByText } = render(
      <OpportunityCardView
        card={card()}
        evidenceById={EVIDENCE}
        actions={actions({ rating: "useful", feedbackError: "Couldn't save your rating. Please try again." })}
      />,
    );
    expect(getByRole("button", { name: "Useful" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "Wrong" }).getAttribute("aria-pressed")).toBe("false");
    expect(getByText("Couldn't save your rating.", { exact: false })).toBeTruthy();
  });

  it("reports opening Evidence and Proposed experiment, once per open, not on close", () => {
    const a = actions();
    const { getByText } = render(<OpportunityCardView card={card()} evidenceById={EVIDENCE} actions={a} />);
    const evidence = getByText("Evidence (2)");
    const experiment = getByText("Proposed experiment");

    fireEvent.click(evidence); // closed -> opening
    expect(a.onSectionOpened).toHaveBeenLastCalledWith("evidence");
    (evidence.parentElement as HTMLDetailsElement).open = true; // jsdom doesn't toggle on click
    fireEvent.click(evidence); // open -> closing: not an "opened" event
    expect(a.onSectionOpened).toHaveBeenCalledTimes(1);

    fireEvent.click(experiment);
    expect(a.onSectionOpened).toHaveBeenLastCalledWith("experiment");
    expect(a.onSectionOpened).toHaveBeenCalledTimes(2);
  });

  it("does not count the hero's pre-opened Evidence as viewed until the visitor opens it", () => {
    const a = actions();
    const { getByText } = render(<OpportunityCardView card={card()} isHero evidenceById={EVIDENCE} actions={a} />);
    expect(a.onSectionOpened).not.toHaveBeenCalled();
    fireEvent.click(getByText("Evidence (2)")); // already open -> this click closes it
    expect(a.onSectionOpened).not.toHaveBeenCalled();
  });

  it("styles Build this as the primary CTA on the hero card only", () => {
    const hero = render(<OpportunityCardView card={card()} isHero evidenceById={EVIDENCE} actions={actions()} />);
    expect(hero.getByText("Build this", { exact: false }).className).toBe("");
    cleanup();
    const other = render(<OpportunityCardView card={card()} evidenceById={EVIDENCE} actions={actions()} />);
    expect(other.getByText("Build this", { exact: false }).className).toBe("secondary");
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
