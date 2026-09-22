import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store/sqlite.js";
import type { EvidencePacket } from "../../src/core/evidence-packet.js";

function samplePacket(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    productIdentity: {
      url: "https://example.com/",
      productName: "Acme",
      category: "ai_saas",
      statedValueProposition: "Automate everything",
      targetAudience: "Not automatically detected in v0",
    },
    surfaceMap: {
      pagesInspected: ["https://example.com/"],
      primaryFlows: [],
      ctas: ["Start for free"],
      pagesNotReachable: [],
    },
    observedEvidence: [
      {
        id: "E1",
        sourceUrl: "https://example.com/",
        timestamp: "2026-09-22T00:00:00.000Z",
        evidenceType: "cta_placement",
        observation: "obs",
        rawExcerpt: "excerpt",
        confidence: "high",
      },
    ],
    behaviorEvidence: {},
    reliabilityEvidence: {},
    aiEvidence: {},
    codeContext: {},
    confidenceMetadata: {
      sourceReliability: "public_scan_only",
      freshness: "2026-09-22T00:00:00.000Z",
      contradictions: [],
      missingEvidenceSummary: "none",
    },
    ...overrides,
  };
}

describe("sqlite store", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a saved Evidence Packet", () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-test-"));
    const store = openStore(join(dir, "test.db"));
    const id = store.saveEvidencePacket(samplePacket());
    const loaded = store.getEvidencePacketById(id);
    store.close();

    expect(loaded).toBeDefined();
    expect(loaded?.productIdentity.productName).toBe("Acme");
    expect(loaded?.observedEvidence).toHaveLength(1);
  });

  it("lists saved packets newest first", () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-test-"));
    const store = openStore(join(dir, "test.db"));
    store.saveEvidencePacket(samplePacket({ productIdentity: { ...samplePacket().productIdentity, productName: "First" } }));
    store.saveEvidencePacket(samplePacket({ productIdentity: { ...samplePacket().productIdentity, productName: "Second" } }));
    const list = store.listEvidencePackets();
    store.close();

    expect(list).toHaveLength(2);
    expect(list[0]?.productName).toBe("Second");
    expect(list[1]?.productName).toBe("First");
  });

  it("runs migrations idempotently across reopens of the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-test-"));
    const path = join(dir, "test.db");
    const store1 = openStore(path);
    store1.saveEvidencePacket(samplePacket());
    store1.close();

    // Reopening must not fail or duplicate migrations.
    const store2 = openStore(path);
    const list = store2.listEvidencePackets();
    store2.close();

    expect(list).toHaveLength(1);
  });

  it("returns undefined for a packet id that does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-test-"));
    const store = openStore(join(dir, "test.db"));
    const loaded = store.getEvidencePacketById(999);
    store.close();
    expect(loaded).toBeUndefined();
  });
});
