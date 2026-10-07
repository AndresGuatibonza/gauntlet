import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BehaviorSourceError, type BehaviorSnapshot, type BehaviorSource, type EvidencePacket } from "@gauntlet/core";
import { openStore } from "../src/store/sqlite.js";
import { enrichPacketWithBehavior, resolvePostHogRun } from "../src/posthog-option.js";

const NOW = () => new Date("2026-10-07T12:00:00.000Z");
const ENV = { POSTHOG_PERSONAL_API_KEY: "phx_test_key_0123456789", POSTHOG_PROJECT_ID: "12345" };

function publicPacket(): EvidencePacket {
  return {
    productIdentity: { url: "https://acme.com/", productName: "Acme", category: "ai_saas", statedValueProposition: "v", targetAudience: "t" },
    surfaceMap: { pagesInspected: ["https://acme.com/"], primaryFlows: [], ctas: [], pagesNotReachable: [] },
    observedEvidence: [
      { id: "E1", sourceUrl: "https://acme.com/", timestamp: "2026-10-01T00:00:00.000Z", evidenceType: "copy", observation: "o", rawExcerpt: "r", confidence: "high" },
    ],
    behaviorEvidence: {},
    reliabilityEvidence: {},
    aiEvidence: {},
    codeContext: {},
    confidenceMetadata: { sourceReliability: "public_scan_only", freshness: "2026-10-01T00:00:00.000Z", contradictions: [], missingEvidenceSummary: "No analytics." },
  };
}

describe("resolvePostHogRun", () => {
  it("returns undefined without --posthog, and rejects --ph-* flags on their own", () => {
    expect(resolvePostHogRun({}, ENV, NOW)).toBeUndefined();
    expect(() => resolvePostHogRun({ phFunnel: ["a=x>y"] }, ENV, NOW)).toThrow(/only apply together with --posthog/);
  });

  it("requires the key and project id from the environment, never from flags", () => {
    expect(() => resolvePostHogRun({ posthog: true }, {}, NOW)).toThrow(/POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID/);
    expect(() => resolvePostHogRun({ posthog: true }, { POSTHOG_PROJECT_ID: "1" }, NOW)).toThrow(BehaviorSourceError);
  });

  it("defaults to US cloud and the last 30 days; date-only bounds cover whole UTC days", () => {
    const run = resolvePostHogRun({ posthog: true }, ENV, NOW)!;
    expect(run.host).toBe("https://us.posthog.com");
    expect(run.projectId).toBe("12345");
    expect(run.query).toEqual({ from: "2026-09-07T12:00:00.000Z", to: "2026-10-07T12:00:00.000Z", funnels: [] });

    const eu = resolvePostHogRun(
      { posthog: true, phSince: "2026-09-01", phUntil: "2026-09-30", phFunnel: ["activation:7d=$pageview>signed_up"] },
      { ...ENV, POSTHOG_HOST: "https://eu.posthog.com" },
      NOW,
    )!;
    expect(eu.host).toBe("https://eu.posthog.com");
    expect(eu.query).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      funnels: [{ name: "activation", steps: ["$pageview", "signed_up"], windowDays: 7 }],
    });
  });

  it("rejects bad dates, inverted windows, bad funnels and a non-https host", () => {
    for (const opts of [
      { posthog: true, phSince: "Sep 1" },
      { posthog: true, phSince: "2026-10-01", phUntil: "2026-09-01" },
      { posthog: true, phFunnel: ["no-equals"] },
      { posthog: true, phFunnel: ["a=x"] },
    ]) {
      expect(() => resolvePostHogRun(opts, ENV, NOW)).toThrow(BehaviorSourceError);
    }
    expect(() => resolvePostHogRun({ posthog: true }, { ...ENV, POSTHOG_HOST: "http://posthog.example.com" }, NOW)).toThrow(/https/);
  });
});

function fakeSource(snapshot?: Partial<BehaviorSnapshot>, fail?: Error): BehaviorSource {
  return {
    system: "posthog",
    async read(query) {
      if (fail) throw fail;
      return {
        system: "posthog",
        host: "https://us.posthog.com",
        project: "12345",
        query,
        pulledAt: "2026-10-07T12:00:00.000Z",
        eventCount: 10,
        distinctEventCount: 1,
        topEvents: [{ event: "$pageview", count: 10 }],
        funnels: [],
        experiments: [],
        flags: [],
        notes: [],
        ...snapshot,
      };
    },
  };
}

const QUERY = { from: "2026-09-07T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", funnels: [] };

describe("enrichPacketWithBehavior", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("saves a new, linked, behavior-enriched packet and leaves the source packet unchanged", async () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-ph-"));
    const store = openStore(join(dir, "test.db"));
    const sourceId = store.saveEvidencePacket(publicPacket());
    const before = JSON.stringify(store.getEvidencePacketById(sourceId));
    const result = await enrichPacketWithBehavior(store, sourceId, store.getEvidencePacketById(sourceId)!, { source: fakeSource(), query: QUERY });
    expect(result.packetId).not.toBe(sourceId);
    expect(JSON.stringify(store.getEvidencePacketById(sourceId))).toBe(before);
    const saved = store.getEvidencePacketById(result.packetId)!;
    expect(saved.confidenceMetadata.sourceReliability).toBe("public_scan_plus_behavior");
    expect(result.behavior.items.map((i) => i.id)).toEqual(["B1", "B2", "B3"]);
    expect(store.getPacketLineage(result.packetId)).toBe(sourceId);

    await expect(enrichPacketWithBehavior(store, result.packetId, result.packet, { source: fakeSource(), query: QUERY })).rejects.toThrow(
      `enrich its public-scan packet #${sourceId} instead`,
    );
    store.close();
  });

  it("saves nothing when PostHog can't be read", async () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-ph-"));
    const store = openStore(join(dir, "test.db"));
    const sourceId = store.saveEvidencePacket(publicPacket());
    await expect(
      enrichPacketWithBehavior(store, sourceId, publicPacket(), { source: fakeSource(undefined, new BehaviorSourceError("down", "failed")), query: QUERY }),
    ).rejects.toThrow(BehaviorSourceError);
    expect(store.listEvidencePackets()).toHaveLength(1);
    store.close();
  });
});
