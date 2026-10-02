import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLlmClient, type EvidencePacket, type ExperimentRecord, type OpportunityReport } from "@gauntlet/core";
import { openStore, type GauntletStore } from "../src/store/sqlite.js";
import { applyExperimentUpdate, buildPackage, formatLedger, LedgerError, recordExperiment, resolveCardIndex } from "../src/ledger.js";

let dir: string;
let store: GauntletStore;

afterEach(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const packet: EvidencePacket = {
  productIdentity: { url: "https://acme.com/", productName: "Acme", category: "ai_saas", statedValueProposition: "x", targetAudience: "y" },
  surfaceMap: { pagesInspected: ["https://acme.com/"], primaryFlows: [], ctas: [], pagesNotReachable: [] },
  observedEvidence: [
    { id: "E1", sourceUrl: "https://acme.com/", timestamp: "2026-09-22T00:00:00.000Z", evidenceType: "cta_placement", observation: "CTA before pricing", rawExcerpt: "Start", confidence: "high" },
  ],
  behaviorEvidence: {},
  reliabilityEvidence: {},
  aiEvidence: {},
  codeContext: {},
  confidenceMetadata: { sourceReliability: "public_scan_only", freshness: "2026-09-22T00:00:00.000Z", contradictions: [], missingEvidenceSummary: "none" },
};

function card(title: string, nextAction: "build_this" | "connect_data_to_validate" | "do_not_prioritize_yet") {
  return {
    title, observation: "o", problemStatement: "p", hypothesis: `If ${title}, signups rise`, changeSurface: "ux" as const,
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "signup rate", guardrails: "g", stoppingRule: "s" },
    expectedImpact: { level: "medium" as const, rationale: "r", score: 2 as const },
    effort: { level: "low" as const, explanation: "e", score: 1 as const },
    confidence: { level: "medium" as const, evidenceQualityScore: 2 as const },
    missingEvidence: "m", nextAction, evidenceRefs: ["E1"],
  };
}

const report: OpportunityReport = { cards: [card("A", "connect_data_to_validate"), card("B", "build_this"), card("C", "do_not_prioritize_yet")] };

const draft = JSON.stringify({
  objective: "Show the price by the CTA", nonGoals: ["Changing prices"], likelyComponents: ["the homepage hero"],
  approach: ["one", "two"], featureFlag: { name: "hero_price", rollout: "50%" },
  acceptanceCriteria: ["a", "b", "c"], measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "2 weeks" },
  rollbackCriteria: ["r"], risks: [{ risk: "x", mitigation: "y" }], missingContext: ["repo"], evidenceRefs: ["E1"],
});

function setup(): number {
  dir = mkdtempSync(join(tmpdir(), "gauntlet-ledger-"));
  store = openStore(join(dir, "test.db"));
  const packetId = store.saveEvidencePacket(packet);
  return store.saveOpportunityReport(packetId, report, []);
}

describe("resolveCardIndex", () => {
  it("defaults to the best next experiment and accepts 1-based card numbers", () => {
    expect(resolveCardIndex(report, undefined)).toBe(1);
    expect(resolveCardIndex(report, "3")).toBe(2);
    expect(() => resolveCardIndex(report, "0")).toThrow(LedgerError);
    expect(() => resolveCardIndex(report, "4")).toThrow(/1 to 3/);
    expect(() => resolveCardIndex(report, "two")).toThrow(LedgerError);
  });
});

describe("buildPackage", () => {
  it("generates once, saves the package with a planned ledger record, and reuses it afterwards", async () => {
    const reportId = setup();
    let calls = 0;
    const llm = () => fakeLlmClient(() => (calls++, draft));
    const first = await buildPackage(store, reportId, undefined, llm);
    expect(first.created).toBe(true);
    expect(first.saved.package.card.title).toBe("B");
    const again = await buildPackage(store, reportId, undefined, llm);
    expect(again).toEqual({ saved: first.saved, created: false });
    expect(calls).toBe(1);
    const [experiment] = store.listExperiments();
    expect(experiment).toMatchObject({ id: first.saved.experimentId, productName: "Acme", record: { status: "planned", hypothesis: "If B, signups rise" } });
  });

  it("explains a missing report", async () => {
    setup();
    await expect(buildPackage(store, 99, undefined, () => fakeLlmClient([]))).rejects.toThrow(/No Opportunity Report #99/);
  });
});

describe("ledger transitions", () => {
  const planned: ExperimentRecord = {
    hypothesis: "h", evidenceSnapshot: [{ id: "E1", observation: "o", sourceRef: "s" }], change: { featureFlag: "f", summary: "s" },
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
    status: "planned", result: null, decision: null, outcome: null,
  };

  it("goes planned -> running -> decided, and adds the outcome once", () => {
    const running = applyExperimentUpdate(planned, { running: true });
    expect(running.status).toBe("running");
    const decided = applyExperimentUpdate(running, { decision: "ship", result: "Signups +8% over 2 weeks" });
    expect(decided).toMatchObject({ status: "decided", decision: "ship", result: "Signups +8% over 2 weeks", outcome: null });
    const withOutcome = applyExperimentUpdate(decided, { outcome: "Kept for all visitors" });
    expect(withOutcome.outcome).toBe("Kept for all visitors");
    expect(() => applyExperimentUpdate(withOutcome, { outcome: "again" })).toThrow(/already has an outcome/);
  });

  it("can decide straight from planned", () => {
    expect(applyExperimentUpdate(planned, { decision: "discard", result: "No effect" }).status).toBe("decided");
  });

  it.each([
    [{}, /Nothing to record/],
    [{ decision: "ship" }, /needs its --result/],
    [{ decision: "maybe", result: "r" }, /ship, iterate or discard/],
    [{ result: "r" }, /need --decision/],
    [{ running: true, decision: "ship", result: "r" }, /either --running or --decision/],
    [{ running: true, result: "r" }, /recorded with --decision/],
  ])("refuses %o", (update, message) => {
    expect(() => applyExperimentUpdate(planned, update)).toThrow(message);
  });

  it("never changes a decided record's decision or result", () => {
    const decided = applyExperimentUpdate(planned, { decision: "ship", result: "r" });
    expect(() => applyExperimentUpdate(decided, { decision: "discard", result: "x" })).toThrow(/already decided/);
    expect(() => applyExperimentUpdate(decided, { running: true })).toThrow(/already decided/);
  });

  it("persists updates and lists them", async () => {
    const reportId = setup();
    const { saved } = await buildPackage(store, reportId, "1", () => fakeLlmClient([draft]));
    recordExperiment(store, saved.experimentId, { running: true });
    const decided = recordExperiment(store, saved.experimentId, { decision: "iterate", result: "Mixed", outcome: undefined });
    expect(decided.decidedAt).not.toBeNull();
    const text = formatLedger(store.listExperiments());
    expect(text).toContain(`#${saved.experimentId} [decided: iterate] Acme -- flag hero_price (report #${reportId}, card 1)`);
    expect(text).toContain("Result: Mixed");
    expect(() => recordExperiment(store, 999, { running: true })).toThrow(/No experiment #999/);
  });

  it("explains an empty ledger", () => {
    expect(formatLedger([])).toContain("empty");
  });
});
