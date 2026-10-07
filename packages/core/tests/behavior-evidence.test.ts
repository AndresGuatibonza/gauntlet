import { describe, it, expect } from "vitest";
import {
  attachAiEvidence,
  attachBehaviorEvidence,
  BehaviorSourceError,
  buildBehaviorEvidence,
  citableEvidenceIds,
  citedEvidenceFor,
  EvidencePacketSchema,
  fakeLlmClient,
  generateOpportunityReport,
  MIN_FUNNEL_ENTRANTS,
  parseFunnelSpec,
  PopulatedBehaviorEvidenceSchema,
  reviewOpportunityReport,
  sourceReliabilityFor,
  validateBehaviorQuery,
  type BehaviorSnapshot,
  type OpportunityCard,
  type PopulatedAiEvidence,
} from "../src/index.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";

const PULLED = "2026-10-07T12:00:00.000Z";

function snapshot(overrides: Partial<BehaviorSnapshot> = {}): BehaviorSnapshot {
  return {
    system: "posthog",
    host: "https://us.posthog.com",
    project: "12345",
    query: {
      from: "2026-09-07T00:00:00.000Z",
      to: "2026-10-07T00:00:00.000Z",
      funnels: [{ name: "activation", steps: ["$pageview", "signed_up", "scan_started"], windowDays: 14 }],
    },
    pulledAt: PULLED,
    eventCount: 48_210,
    distinctEventCount: 31,
    topEvents: [
      { event: "$pageview", count: 30_000 },
      { event: "$autocapture", count: 12_000 },
      { event: "signed_up", count: 900 },
    ],
    funnels: [
      {
        name: "activation",
        windowDays: 14,
        steps: [
          { event: "$pageview", count: 8000, medianSecondsFromPrevious: null },
          { event: "signed_up", count: 640, medianSecondsFromPrevious: 300 },
          { event: "scan_started", count: 320, medianSecondsFromPrevious: 3600 },
        ],
      },
    ],
    experiments: [
      { name: "Hero price", flagKey: "hero_price", status: "running", startDate: "2026-09-20T00:00:00Z", endDate: null },
      { name: "Old test", flagKey: "old", status: "complete", startDate: "2026-08-01T00:00:00Z", endDate: "2026-08-20T00:00:00Z" },
    ],
    flags: [
      { key: "hero_price", active: true, rolloutPercentage: 50, variants: ["control", "test"] },
      { key: "beta_dashboard", active: true, rolloutPercentage: null, variants: [] },
      { key: "legacy", active: false, rolloutPercentage: 0, variants: [] },
    ],
    notes: [],
    ...overrides,
  };
}

describe("buildBehaviorEvidence", () => {
  it("maps a snapshot to B* items in a fixed order, with exact figures and coverage", () => {
    const evidence = buildBehaviorEvidence(snapshot());
    expect(PopulatedBehaviorEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidence.items.map((i) => [i.id, i.evidenceType])).toEqual([
      ["B1", "event_volume"],
      ["B2", "funnel_conversion"],
      ["B3", "experiment_inventory"],
      ["B4", "feature_flag_inventory"],
    ]);
    expect(evidence.source).toEqual({
      system: "posthog",
      host: "https://us.posthog.com",
      project: "12345",
      window: { from: "2026-09-07T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z" },
      eventCount: 48_210,
      pulledAt: PULLED,
    });
    const [volume, funnel, experiments, flags] = evidence.items;
    expect(volume!.observation).toContain("48210 events of 31 distinct names");
    expect(volume!.observation).toContain("$pageview (30000)");
    expect(funnel!.sourceRef).toBe("posthog:project/12345/funnel/activation");
    expect(funnel!.observation).toBe(
      'Funnel "activation": 8000 entered at $pageview and 320 reached scan_started (4.0% within 14 days); the largest drop is $pageview > signed_up (8.0% continue).',
    );
    expect(JSON.parse(funnel!.rawExcerpt)).toMatchObject({
      overallConversion: 0.04,
      stepConversion: [
        { from: "$pageview", to: "signed_up", rate: 0.08, medianSeconds: 300 },
        { from: "signed_up", to: "scan_started", rate: 0.5, medianSeconds: 3600 },
      ],
    });
    expect(funnel!.confidence).toBe("high");
    expect(experiments!.observation).toBe('The analytics project has 2 experiment(s): 1 running, 1 complete; running: "Hero price" (flag hero_price).');
    expect(flags!.observation).toBe("The analytics project has 3 feature flag(s), 2 active: hero_price (50%), beta_dashboard.");
    expect(evidence.notEvaluable).toEqual([
      "Experiment results are not read: an experiment's status says it ran, not what it showed.",
      "Only the 3 most frequent of 31 event names are listed.",
    ]);
  });

  it("is deterministic", () => {
    expect(buildBehaviorEvidence(snapshot())).toEqual(buildBehaviorEvidence(snapshot()));
  });

  it("marks a small funnel as medium confidence and says why", () => {
    const small = snapshot({
      funnels: [
        {
          name: "activation",
          windowDays: 14,
          steps: [
            { event: "$pageview", count: MIN_FUNNEL_ENTRANTS - 1, medianSecondsFromPrevious: null },
            { event: "signed_up", count: 9, medianSecondsFromPrevious: null },
          ],
        },
      ],
    });
    const evidence = buildBehaviorEvidence(small);
    expect(evidence.items[1]!.confidence).toBe("medium");
    expect(evidence.notEvaluable).toContain(`Funnel "activation": only 99 entrants (fewer than ${MIN_FUNNEL_ENTRANTS}), so its conversion is a small sample.`);
  });

  it("says what it could not see: no funnels asked, inventories without permission, no events", () => {
    const evidence = buildBehaviorEvidence(
      snapshot({
        query: { from: "2026-09-07T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", funnels: [] },
        funnels: [],
        experiments: null,
        flags: null,
        eventCount: 0,
        distinctEventCount: 0,
        topEvents: [],
        notes: ["Only the first 500 feature flags were read."],
      }),
    );
    expect(evidence.items.map((i) => i.evidenceType)).toEqual(["event_volume"]);
    expect(evidence.items[0]!.observation).toBe("No events were recorded between 2026-09-07T00:00:00.000Z and 2026-10-07T00:00:00.000Z.");
    expect(evidence.notEvaluable).toEqual([
      "Only the first 500 feature flags were read.",
      "Funnel conversion: no funnel was specified, so no step-to-step conversion was measured.",
      "Experiments could not be listed (missing permission), so running experiments are unknown.",
      "Feature flags could not be listed (missing permission), so existing flags are unknown.",
      "Experiment results are not read: an experiment's status says it ran, not what it showed.",
    ]);
  });

  it("handles a funnel with no entrants without dividing by zero", () => {
    const evidence = buildBehaviorEvidence(
      snapshot({
        funnels: [{ name: "activation", windowDays: 14, steps: [{ event: "a", count: 0, medianSecondsFromPrevious: null }, { event: "b", count: 0, medianSecondsFromPrevious: null }] }],
      }),
    );
    expect(evidence.items[1]!.observation).toContain("had no entrants");
    expect(JSON.parse(evidence.items[1]!.rawExcerpt).overallConversion).toBeNull();
  });
});

describe("queries", () => {
  it("validates the window and funnels before any request", () => {
    const ok = validateBehaviorQuery({ from: "2026-09-07", to: "2026-10-07", funnels: [{ name: " a ", steps: ["x", "y"] }] });
    expect(ok).toEqual({ from: "2026-09-07T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", funnels: [{ name: "a", steps: ["x", "y"], windowDays: 14 }] });
    const bad: [string, Parameters<typeof validateBehaviorQuery>[0]][] = [
      ["end after", { from: "2026-10-07", to: "2026-10-01", funnels: [] }],
      ["at most 90 days", { from: "2026-01-01", to: "2026-10-01", funnels: [] }],
      ["valid ISO", { from: "yesterday", to: "2026-10-01", funnels: [] }],
      ["2 to 6 steps", { from: "2026-09-07", to: "2026-10-07", funnels: [{ name: "a", steps: ["x"] }] }],
      ["invalid event name", { from: "2026-09-07", to: "2026-10-07", funnels: [{ name: "a", steps: ["x", "y'); DROP"] }] }],
      ["listed twice", { from: "2026-09-07", to: "2026-10-07", funnels: [{ name: "a", steps: ["x", "y"] }, { name: "a", steps: ["x", "y"] }] }],
      ["1 to 90 days", { from: "2026-09-07", to: "2026-10-07", funnels: [{ name: "a", steps: ["x", "y"], windowDays: 0 }] }],
    ];
    for (const [message, query] of bad) expect(() => validateBehaviorQuery(query), message).toThrow(BehaviorSourceError);
  });

  it("parses the CLI funnel syntax, with an optional window", () => {
    expect(parseFunnelSpec("activation=$pageview>signed_up > scan_started")).toEqual({ name: "activation", steps: ["$pageview", "signed_up", "scan_started"] });
    expect(parseFunnelSpec("activation:7d=a>b")).toEqual({ name: "activation", steps: ["a", "b"], windowDays: 7 });
    expect(() => parseFunnelSpec("a>b")).toThrow(BehaviorSourceError);
  });
});

describe("the packet with behavior evidence", () => {
  const behavior = buildBehaviorEvidence(snapshot());

  it("attaches to a copy, raises sourceReliability and states coverage limits", () => {
    const packet = fakeEvidencePacket();
    const enriched = attachBehaviorEvidence(packet, behavior);
    expect(packet.behaviorEvidence).toEqual({});
    expect(EvidencePacketSchema.parse(enriched)).toBeTruthy();
    expect(enriched.confidenceMetadata.sourceReliability).toBe("public_scan_plus_behavior");
    expect(enriched.confidenceMetadata.missingEvidenceSummary).toMatch(/^No analytics\/observability\/repo connected in v0\. Behavior evidence \(posthog, project 12345\) covers 48210 event\(s\)/);
    expect(citableEvidenceIds(enriched)).toEqual(["E1", "E2", "B1", "B2", "B3", "B4"]);
    expect(() => attachBehaviorEvidence(enriched, behavior)).toThrow(BehaviorSourceError);
  });

  it("combines with AI traces in either order into one sourceReliability", () => {
    const ai: PopulatedAiEvidence = {
      source: { system: "token_profiler", connectors: ["opentelemetry"], window: { from: PULLED, to: PULLED }, sessionCount: 1, invocationCount: 1, pulledAt: PULLED },
      items: [{ id: "A1", sourceRef: "token-profiler:window", timestamp: PULLED, evidenceType: "usage_profile", observation: "o", rawExcerpt: "{}", confidence: "high" }],
      notEvaluable: [],
    };
    const both1 = attachAiEvidence(attachBehaviorEvidence(fakeEvidencePacket(), behavior), ai);
    const both2 = attachBehaviorEvidence(attachAiEvidence(fakeEvidencePacket(), ai), behavior);
    for (const p of [both1, both2]) {
      expect(p.confidenceMetadata.sourceReliability).toBe("public_scan_plus_behavior_and_ai_traces");
      expect(EvidencePacketSchema.safeParse(p).success).toBe(true);
    }
    expect(sourceReliabilityFor(false, false)).toBe("public_scan_only");
  });

  it("rejects a packet whose sourceReliability or ids don't match its evidence", () => {
    const enriched = attachBehaviorEvidence(fakeEvidencePacket(), behavior);
    const wrong = { ...enriched, confidenceMetadata: { ...enriched.confidenceMetadata, sourceReliability: "public_scan_only" as const } };
    const result = EvidencePacketSchema.safeParse(wrong);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe('A packet with behaviorEvidence must declare sourceReliability "public_scan_plus_behavior".');
    const badId = { ...enriched, behaviorEvidence: { ...behavior, items: [{ ...behavior.items[0]!, id: "E1" }] } };
    expect(EvidencePacketSchema.safeParse(badId).success).toBe(false);
  });

  it("lets the Scientist cite B* ids, shows them to the Reviewer, and resolves them in a brief", async () => {
    const packet = attachBehaviorEvidence(fakeEvidencePacket(), behavior);
    const cards = [
      fakeOpportunityCard({ nextAction: "build_this", evidenceRefs: ["E1", "B2"] }),
      fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate", evidenceRefs: ["B3"] }),
      fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
    ];
    const prompts: string[] = [];
    const report = await generateOpportunityReport(
      packet,
      fakeLlmClient((o) => {
        prompts.push(o.system + o.messages.map((m) => m.content).join(""));
        return JSON.stringify({ cards });
      }),
    );
    expect(report.cards.map((c) => c.evidenceRefs)).toContainEqual(["E1", "B2"]);
    expect(prompts[0]).toContain("behaviorEvidence.items (B1, B2, ...)");
    expect(prompts[0]).toContain('"B2"');

    const reviewPrompts: string[] = [];
    await reviewOpportunityReport(
      report,
      packet,
      fakeLlmClient((o) => {
        reviewPrompts.push(o.messages[0]!.content);
        return JSON.stringify({ reviews: report.cards.map((c, i) => ({ cardIndex: i, cardTitle: c.title, outrunsEvidence: false, hasUnaddressedConfounder: false, metricMatchesOutcome: true, isFalsifiableAndSingleChange: true, verdict: "pass", rationale: "ok" })) });
      }),
    );
    expect(reviewPrompts[0]).toContain("Behavior evidence from the product's own analytics (cards may cite these B* ids)");

    const cited = citedEvidenceFor(cards[0] as unknown as OpportunityCard, packet);
    expect(cited.map((c) => [c.id, c.sourceRef])).toEqual([
      ["E1", "https://example.com/"],
      ["B2", "posthog:project/12345/funnel/activation"],
    ]);
  });

  it("still rejects B* ids when the packet has no behavior evidence", async () => {
    const cards = [
      fakeOpportunityCard({ nextAction: "build_this", evidenceRefs: ["B1"] }),
      fakeOpportunityCard({ title: "Card 2", nextAction: "connect_data_to_validate" }),
      fakeOpportunityCard({ title: "Card 3", nextAction: "do_not_prioritize_yet" }),
    ];
    await expect(generateOpportunityReport(fakeEvidencePacket(), fakeLlmClient(() => JSON.stringify({ cards })))).rejects.toThrow(/B1/);
  });
});
