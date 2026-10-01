import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TokenProfilerError, type EvidencePacket, type JsonGetter } from "@gauntlet/core";
import { openStore } from "../src/store/sqlite.js";
import {
  CODING_AGENT_CONNECTORS,
  enrichPacketWithTokenProfiler,
  resolveTokenProfilerQuery,
} from "../src/token-profiler-option.js";

const NOW = () => new Date("2026-10-01T12:00:00.000Z");

describe("resolveTokenProfilerQuery", () => {
  it("returns undefined without --token-profiler (plain public-scan analysis)", () => {
    expect(resolveTokenProfilerQuery({}, NOW)).toBeUndefined();
  });

  it("rejects --tp-* flags without --token-profiler", () => {
    expect(() => resolveTokenProfilerQuery({ tpConnector: ["opentelemetry"] }, NOW)).toThrow(/only apply together with --token-profiler/);
    expect(() => resolveTokenProfilerQuery({ tpSince: "2026-09-01" }, NOW)).toThrow(TokenProfilerError);
  });

  it("defaults the window to the last 30 days ending now", () => {
    expect(resolveTokenProfilerQuery({ tokenProfiler: "http://localhost:4317/", tpConnector: ["opentelemetry"] }, NOW)).toEqual({
      baseUrl: "http://localhost:4317",
      connectors: ["opentelemetry"],
      since: "2026-09-01T12:00:00.000Z",
      until: "2026-10-01T12:00:00.000Z",
    });
  });

  it("treats date-only bounds as whole UTC days and de-duplicates connectors", () => {
    const q = resolveTokenProfilerQuery(
      { tokenProfiler: "http://localhost:4317", tpConnector: ["opentelemetry", "file", "opentelemetry"], tpSince: "2026-09-01", tpUntil: "2026-09-30" },
      NOW,
    );
    expect(q).toMatchObject({ connectors: ["file", "opentelemetry"], since: "2026-09-01T00:00:00.000Z", until: "2026-09-30T23:59:59.999Z" });
  });

  it("accepts full timestamps as given", () => {
    const q = resolveTokenProfilerQuery(
      { tokenProfiler: "http://localhost:4317", tpConnector: ["file"], tpSince: "2026-09-01T08:00:00Z", tpUntil: "2026-09-02T08:00:00+02:00" },
      NOW,
    );
    expect(q).toMatchObject({ since: "2026-09-01T08:00:00.000Z", until: "2026-09-02T06:00:00.000Z" });
  });

  it("requires an explicit connector, so the trace source is always a deliberate choice", () => {
    expect(() => resolveTokenProfilerQuery({ tokenProfiler: "http://localhost:4317", tpConnector: [] }, NOW)).toThrow(/at least one --tp-connector/);
  });

  it.each(CODING_AGENT_CONNECTORS)("rejects the coding-agent connector %s", (connector) => {
    expect(() => resolveTokenProfilerQuery({ tokenProfiler: "http://localhost:4317", tpConnector: ["opentelemetry", connector] }, NOW)).toThrow(
      /coding-agent usage/,
    );
  });

  it("rejects malformed URLs, dates and inverted windows", () => {
    const base = { tpConnector: ["file"] };
    expect(() => resolveTokenProfilerQuery({ ...base, tokenProfiler: "localhost:4317" }, NOW)).toThrow(/http\(s\) URL|must be a URL/);
    expect(() => resolveTokenProfilerQuery({ ...base, tokenProfiler: "not a url" }, NOW)).toThrow(/must be a URL/);
    expect(() => resolveTokenProfilerQuery({ ...base, tokenProfiler: "http://localhost:4317", tpSince: "Sep 1" }, NOW)).toThrow(/ISO date/);
    expect(() => resolveTokenProfilerQuery({ ...base, tokenProfiler: "http://localhost:4317", tpSince: "2026-13-45" }, NOW)).toThrow(/ISO date/);
    expect(() =>
      resolveTokenProfilerQuery({ ...base, tokenProfiler: "http://localhost:4317", tpSince: "2026-09-30", tpUntil: "2026-09-01" }, NOW),
    ).toThrow(/must be before/);
  });
});

function publicPacket(): EvidencePacket {
  return {
    productIdentity: { url: "https://example.com/", productName: "Acme", category: "ai_saas", statedValueProposition: "x", targetAudience: "y" },
    surfaceMap: { pagesInspected: ["https://example.com/"], primaryFlows: [], ctas: [], pagesNotReachable: [] },
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
    confidenceMetadata: { sourceReliability: "public_scan_only", freshness: "2026-09-22T00:00:00.000Z", contradictions: [], missingEvidenceSummary: "none" },
  };
}

const BASE = "http://localhost:4317";
const QUERY = { baseUrl: BASE, connectors: ["opentelemetry"], since: "2026-09-01T00:00:00.000Z", until: "2026-09-30T23:59:59.999Z" };

function fakeTokenProfiler(): JsonGetter {
  const routes: Record<string, unknown> = {
    [`${BASE}/api/sessions?connector=opentelemetry`]: [
      {
        sessionId: "s1",
        firstOccurredAt: "2026-09-10T00:00:00.000Z",
        lastOccurredAt: "2026-09-10T00:05:00.000Z",
        invocationCount: 1,
        connectors: ["opentelemetry"],
        providers: ["openai"],
        models: ["gpt-5"],
      },
    ],
    [`${BASE}/api/sessions/s1/events`]: [
      {
        invocationId: "i1",
        sessionId: "s1",
        connector: "opentelemetry",
        provider: "openai",
        actualModel: "gpt-5",
        occurredAt: "2026-09-10T00:00:00.000Z",
        status: "success",
        normalizedUsage: { inputTokensTotal: 900, generatedTokensTotal: 100, totalTokens: 1000 },
        usageProvenance: { inputTokensTotal: "reported", generatedTokensTotal: "reported" },
      },
    ],
    [`${BASE}/api/sessions/s1/flags`]: [],
    [`${BASE}/api/sessions/s1/context-analysis`]: null,
  };
  return async (url) => {
    if (!(url in routes)) throw new TokenProfilerError(`HTTP 404 for ${url}`);
    return routes[url];
  };
}

describe("enrichPacketWithTokenProfiler", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("saves a new, linked, trace-enriched packet and leaves the public-scan packet unchanged", async () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-tp-"));
    const store = openStore(join(dir, "test.db"));
    const sourceId = store.saveEvidencePacket(publicPacket());
    const before = JSON.stringify(store.getEvidencePacketById(sourceId));

    const result = await enrichPacketWithTokenProfiler(store, sourceId, store.getEvidencePacketById(sourceId)!, QUERY, fakeTokenProfiler());

    expect(result.packetId).not.toBe(sourceId);
    expect(JSON.stringify(store.getEvidencePacketById(sourceId))).toBe(before);
    const saved = store.getEvidencePacketById(result.packetId)!;
    expect(saved.confidenceMetadata.sourceReliability).toBe("public_scan_plus_ai_traces");
    expect(saved.aiEvidence).toEqual(result.aiEvidence);
    expect(result.aiEvidence.items.map((i) => i.id)).toEqual(["A1", "A2"]);
    expect(store.getPacketLineage(result.packetId)).toBe(sourceId);
    expect(store.getPacketLineage(sourceId)).toBeUndefined();
    store.close();
  });

  it("refuses to enrich an already-enriched packet and points at its public-scan source", async () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-tp-"));
    const store = openStore(join(dir, "test.db"));
    const sourceId = store.saveEvidencePacket(publicPacket());
    const first = await enrichPacketWithTokenProfiler(store, sourceId, publicPacket(), QUERY, fakeTokenProfiler());
    await expect(enrichPacketWithTokenProfiler(store, first.packetId, first.packet, QUERY, fakeTokenProfiler())).rejects.toThrow(
      `enrich its public-scan packet #${sourceId} instead`,
    );
    store.close();
  });

  it("saves nothing when Token Profiler can't be read", async () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-tp-"));
    const store = openStore(join(dir, "test.db"));
    const sourceId = store.saveEvidencePacket(publicPacket());
    const down: JsonGetter = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(enrichPacketWithTokenProfiler(store, sourceId, publicPacket(), QUERY, down)).rejects.toThrow(TokenProfilerError);
    expect(store.listEvidencePackets()).toHaveLength(1);
    store.close();
  });
});

describe("003_packet_lineage migration", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("upgrades a database created before it without losing packets", () => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-tp-"));
    const path = join(dir, "old.db");
    const old = new Database(path);
    const migrations = join(__dirname, "../src/store/migrations");
    old.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const name of ["001_init", "002_opportunity_reports"]) {
      old.exec(readFileSync(join(migrations, `${name}.sql`), "utf-8"));
      old.prepare("INSERT INTO _migrations VALUES (?, ?)").run(name, "2026-09-01T00:00:00.000Z");
    }
    old
      .prepare("INSERT INTO evidence_packets (url, product_name, category, scanned_at, packet_json) VALUES (?, ?, ?, ?, ?)")
      .run("https://example.com/", "Acme", "ai_saas", "2026-09-22T00:00:00.000Z", JSON.stringify(publicPacket()));
    old.close();

    const store = openStore(path);
    expect(store.getEvidencePacketById(1)?.productIdentity.productName).toBe("Acme");
    expect(store.getPacketLineage(1)).toBeUndefined();
    const derived = store.saveEvidencePacket(publicPacket(), { derivedFromPacketId: 1 });
    expect(store.getPacketLineage(derived)).toBe(1);
    store.close();
  });
});
