import { describe, it, expect } from "vitest";
import { generateOpportunityReport, ScientistError } from "../src/scientist.js";
import { fakeLlmClient, LlmCallError } from "../src/llm-client.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";

function validReportJson(cardOverrides: Array<Record<string, unknown>> = []) {
  const base = [
    fakeOpportunityCard({ nextAction: "build_this" }),
    fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate" }),
    fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
  ];
  const cards = cardOverrides.length > 0 ? cardOverrides : base;
  return JSON.stringify({ cards });
}

describe("generateOpportunityReport", () => {
  it("parses a valid response into a ranked OpportunityReport", async () => {
    const packet = fakeEvidencePacket();
    const client = fakeLlmClient([validReportJson()]);
    const report = await generateOpportunityReport(packet, client);
    expect(report.cards).toHaveLength(3);
    expect(report.cards.filter((c) => c.nextAction === "build_this")).toHaveLength(1);
    // Ranked by rankScore descending.
    for (let i = 1; i < report.cards.length; i++) {
      expect(report.cards[i - 1]!.rankScore ?? 0).toBeGreaterThanOrEqual(report.cards[i]!.rankScore ?? 0);
    }
  });

  it("strips markdown code fences the model adds despite instructions not to", async () => {
    const packet = fakeEvidencePacket();
    const client = fakeLlmClient([`\`\`\`json\n${validReportJson()}\n\`\`\``]);
    const report = await generateOpportunityReport(packet, client);
    expect(report.cards).toHaveLength(3);
  });

  it("rejects a card that cites an evidence id not present in the packet, and retries", async () => {
    const packet = fakeEvidencePacket(); // only has E1, E2
    const badFirstAttempt = validReportJson([
      fakeOpportunityCard({ nextAction: "build_this", evidenceRefs: ["E1", "E99"] }),
      fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate" }),
      fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
    ]);
    const client = fakeLlmClient([badFirstAttempt, validReportJson()]);
    const report = await generateOpportunityReport(packet, client);
    expect(report.cards).toHaveLength(3);
    expect(report.cards.every((c) => c.evidenceRefs.every((ref) => ["E1", "E2"].includes(ref)))).toBe(true);
  });

  it("throws ScientistError after exhausting retries on persistently invalid JSON", async () => {
    const packet = fakeEvidencePacket();
    const client = fakeLlmClient(["not json at all", "still not json"]);
    await expect(generateOpportunityReport(packet, client, { maxAttempts: 2 })).rejects.toThrow(ScientistError);
  });

  it("throws ScientistError (not a raw error) when the Claude API call itself fails", async () => {
    const packet = fakeEvidencePacket();
    const client = fakeLlmClient(() => {
      throw new LlmCallError("simulated network failure");
    });
    await expect(generateOpportunityReport(packet, client, { maxAttempts: 1 })).rejects.toThrow(ScientistError);
  });

  it("rejects a report with fewer than 3 or more than 5 cards", async () => {
    const packet = fakeEvidencePacket();
    const tooFew = JSON.stringify({ cards: [fakeOpportunityCard({ nextAction: "build_this" })] });
    const client = fakeLlmClient([tooFew, validReportJson()]);
    const report = await generateOpportunityReport(packet, client);
    // Second (corrective) attempt succeeds.
    expect(report.cards).toHaveLength(3);
  });
});

describe("generateOpportunityReport with AI evidence (contract Amendment 1)", () => {
  async function enrichedPacket() {
    const { attachAiEvidence } = await import("../src/token-profiler-adapter.js");
    return attachAiEvidence(fakeEvidencePacket(), {
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
          evidenceType: "anomaly_flag",
          observation: "CONTEXT_REPEAT fired in 3 of 3 session(s).",
          rawExcerpt: "{}",
          confidence: "high",
        },
      ],
      notEvaluable: ["RETRY_HEAVY: no invocation reports an attempt number."],
    });
  }

  it("accepts cards citing A* ids and sends the AI evidence to the model", async () => {
    const packet = await enrichedPacket();
    const prompts: string[] = [];
    const client = fakeLlmClient((options) => {
      prompts.push(JSON.stringify(options.messages));
      return validReportJson([
        fakeOpportunityCard({ nextAction: "build_this", evidenceRefs: ["A1"], changeSurface: "prompt" }),
        fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate", evidenceRefs: ["E1", "A1"] }),
        fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
      ]);
    });
    const report = await generateOpportunityReport(packet, client);
    expect(report.cards.some((c) => c.evidenceRefs.includes("A1"))).toBe(true);
    expect(prompts[0]).toContain("CONTEXT_REPEAT fired");
    expect(prompts[0]).toContain("notEvaluable");
  });

  it("still rejects an A* id that isn't in the packet", async () => {
    const packet = await enrichedPacket();
    const bad = validReportJson([
      fakeOpportunityCard({ nextAction: "build_this", evidenceRefs: ["A9"] }),
      fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate" }),
      fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
    ]);
    await expect(generateOpportunityReport(packet, fakeLlmClient([bad, bad]))).rejects.toThrow(/A9/);
  });

  it("rejects A* ids on a public-scan-only packet", async () => {
    const bad = validReportJson([
      fakeOpportunityCard({ nextAction: "build_this", evidenceRefs: ["A1"] }),
      fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate" }),
      fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
    ]);
    await expect(generateOpportunityReport(fakeEvidencePacket(), fakeLlmClient([bad, bad]))).rejects.toThrow(/A1/);
  });
});
