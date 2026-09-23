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
