import { describe, it, expect } from "vitest";
import { reviewOpportunityReport, ReviewerError } from "../src/reviewer.js";
import { fakeLlmClient, LlmCallError } from "../src/llm-client.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";
import { computeRankScore, type OpportunityReport } from "../src/opportunity-card.js";

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

describe("reviewOpportunityReport with AI evidence (contract Amendment 1)", () => {
  it("shows the reviewer the AI evidence and its coverage limits, and the partial-coverage rule", async () => {
    const { attachAiEvidence } = await import("../src/token-profiler-adapter.js");
    const packet = attachAiEvidence(fakeEvidencePacket(), {
      source: {
        system: "token_profiler",
        connectors: ["otel"],
        window: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" },
        sessionCount: 3,
        invocationCount: 40,
        pulledAt: "2026-10-01T12:00:00.000Z",
      },
      items: [
        {
          id: "A1",
          sourceRef: "token-profiler:window",
          timestamp: "2026-10-01T12:00:00.000Z",
          evidenceType: "failure_rate",
          observation: "6 of 40 model invocations (15.0%) did not succeed.",
          rawExcerpt: "{}",
          confidence: "high",
        },
      ],
      notEvaluable: ["RETRY_HEAVY: no invocation reports an attempt number."],
    });
    const report = threeCardReport();
    let system = "";
    let user = "";
    const client = fakeLlmClient((options) => {
      system = options.system;
      user = options.messages.map((m) => m.content).join("\n");
      return allPassJson(report);
    });
    await reviewOpportunityReport(report, packet, client);
    expect(user).toContain("6 of 40 model invocations");
    expect(user).toContain("RETRY_HEAVY");
    expect(system + user).toMatch(/notEvaluable/);
  });

  it("does not add an AI evidence section for a public-scan-only packet", async () => {
    const report = threeCardReport();
    let user = "";
    const client = fakeLlmClient((options) => {
      user = options.messages.map((m) => m.content).join("\n");
      return allPassJson(report);
    });
    await reviewOpportunityReport(report, fakeEvidencePacket(), client);
    expect(user).not.toContain("token_profiler");
  });
});
