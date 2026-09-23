import { describe, it, expect } from "vitest";
import { reviewOpportunityReport, ReviewerError } from "../../src/core/reviewer.js";
import { fakeLlmClient, LlmCallError } from "../../src/core/llm-client.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";
import { computeRankScore, type OpportunityReport } from "../../src/core/opportunity-card.js";

function threeCardReport(): OpportunityReport {
  const cards = [
    { ...fakeOpportunityCard({ nextAction: "build_this" }) },
    { ...fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate" }) },
    { ...fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }) },
  ] as OpportunityReport["cards"];
  cards.forEach((c) => (c.rankScore = computeRankScore(c)));
  return { cards };
}

function allPassJson(report: OpportunityReport) {
  return JSON.stringify({
    reviews: report.cards.map((card, i) => ({
      cardIndex: i,
      cardTitle: card.title,
      outrunsEvidence: false,
      hasUnaddressedConfounder: false,
      metricMatchesOutcome: true,
      isFalsifiableAndSingleChange: true,
      verdict: "pass",
      rationale: "Checks out against the cited evidence.",
    })),
  });
}

describe("reviewOpportunityReport", () => {
  it("keeps all cards unchanged when every review verdict is pass", async () => {
    const packet = fakeEvidencePacket();
    const report = threeCardReport();
    const client = fakeLlmClient([allPassJson(report)]);
    const result = await reviewOpportunityReport(report, packet, client);
    expect(result.report.cards).toHaveLength(3);
    expect(result.report.cards.filter((c) => c.nextAction === "build_this")).toHaveLength(1);
  });

  it("drops a card with verdict=drop and does not lose the exactly-one-build_this invariant", async () => {
    const packet = fakeEvidencePacket();
    const report = threeCardReport(); // card 0 is build_this
    const reviews = report.cards.map((card, i) => ({
      cardIndex: i,
      cardTitle: card.title,
      outrunsEvidence: i === 0,
      hasUnaddressedConfounder: false,
      metricMatchesOutcome: true,
      isFalsifiableAndSingleChange: true,
      verdict: i === 0 ? "drop" : "pass",
      rationale: i === 0 ? "Conclusion outruns the cited evidence." : "Fine.",
    }));
    const client = fakeLlmClient([JSON.stringify({ reviews })]);
    const result = await reviewOpportunityReport(report, packet, client);
    expect(result.report.cards).toHaveLength(2);
    expect(result.report.cards.some((c) => c.title === report.cards[0]!.title)).toBe(false);
    // The build_this card was dropped -- the highest-ranked survivor must be promoted.
    expect(result.report.cards.filter((c) => c.nextAction === "build_this")).toHaveLength(1);
  });

  it("downgrades confidence and recomputes rankScore, never raising confidence above the requested level", async () => {
    const packet = fakeEvidencePacket();
    const report = threeCardReport();
    const originalScore = report.cards[1]!.rankScore;
    const reviews = report.cards.map((card, i) => ({
      cardIndex: i,
      cardTitle: card.title,
      outrunsEvidence: false,
      hasUnaddressedConfounder: i === 1,
      metricMatchesOutcome: true,
      isFalsifiableAndSingleChange: true,
      verdict: i === 1 ? "downgrade_confidence" : "pass",
      rationale: i === 1 ? "Confounder not addressed." : "Fine.",
      downgradedConfidenceLevel: i === 1 ? "low" : undefined,
    }));
    const client = fakeLlmClient([JSON.stringify({ reviews })]);
    const result = await reviewOpportunityReport(report, packet, client);
    const downgradedCard = result.report.cards.find((c) => c.title === "Card 2");
    expect(downgradedCard?.confidence.level).toBe("low");
    expect(downgradedCard?.rankScore).toBeLessThan(originalScore ?? Infinity);
  });

  it("throws ReviewerError when every card is dropped", async () => {
    const packet = fakeEvidencePacket();
    const report = threeCardReport();
    const reviews = report.cards.map((card, i) => ({
      cardIndex: i,
      cardTitle: card.title,
      outrunsEvidence: true,
      hasUnaddressedConfounder: false,
      metricMatchesOutcome: true,
      isFalsifiableAndSingleChange: true,
      verdict: "drop",
      rationale: "Outruns evidence.",
    }));
    const client = fakeLlmClient([JSON.stringify({ reviews })]);
    await expect(reviewOpportunityReport(report, packet, client)).rejects.toThrow(ReviewerError);
  });

  it("throws ReviewerError (not a raw error) when the Claude API call itself fails", async () => {
    const packet = fakeEvidencePacket();
    const report = threeCardReport();
    const client = fakeLlmClient(() => {
      throw new LlmCallError("simulated network failure");
    });
    await expect(reviewOpportunityReport(report, packet, client, { maxAttempts: 1 })).rejects.toThrow(ReviewerError);
  });

  it("retries once on a malformed review response before giving up", async () => {
    const packet = fakeEvidencePacket();
    const report = threeCardReport();
    const client = fakeLlmClient(["not json", allPassJson(report)]);
    const result = await reviewOpportunityReport(report, packet, client, { maxAttempts: 2 });
    expect(result.report.cards).toHaveLength(3);
  });
});
