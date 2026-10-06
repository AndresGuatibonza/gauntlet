// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import type { LlmUsage } from "@gauntlet/core";
import { appVersion, createUsageRecorder, toLlmCallRow, type LlmCallRow } from "@/lib/llm-usage";

const SCAN = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";

function usage(overrides: Partial<LlmUsage> = {}): LlmUsage {
  return {
    purpose: "scientist",
    model: "claude-sonnet-5",
    promptHash: "0123456789ab",
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    stopReason: "end_turn",
    durationMs: 1234.6,
    ok: true,
    ...overrides,
  };
}

describe("toLlmCallRow", () => {
  it("adds the target, commit and estimated cost; a scan's calls belong to no card", () => {
    const row = toLlmCallRow({ scanJobId: SCAN, phase: "scan", cardIndex: 3 }, usage(), "abc123def456");
    expect(row).toEqual({
      scanJobId: SCAN,
      phase: "scan",
      cardIndex: null,
      purpose: "scientist",
      model: "claude-sonnet-5",
      promptHash: "0123456789ab",
      appVersion: "abc123def456",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.04, // 10k * $2/M + 2k * $10/M
      stopReason: "end_turn",
      durationMs: 1235,
      ok: true,
    });
    expect(toLlmCallRow({ scanJobId: SCAN, phase: "package", cardIndex: 2 }, usage(), null).cardIndex).toBe(2);
  });

  it("leaves the cost empty for a model without a price", () => {
    expect(toLlmCallRow({ scanJobId: SCAN, phase: "scan" }, usage({ model: "unknown-model" }), null).costUsd).toBeNull();
  });
});

describe("appVersion", () => {
  it("is the deployed commit, shortened, or null outside a deployment", () => {
    expect(appVersion({ VERCEL_GIT_COMMIT_SHA: "b0707be1234567890abcdef" })).toBe("b0707be12345");
    expect(appVersion({})).toBeNull();
    expect(appVersion({ VERCEL_GIT_COMMIT_SHA: "  " })).toBeNull();
  });
});

describe("createUsageRecorder", () => {
  it("writes and logs each call as it happens; flush waits for every write", async () => {
    const rows: LlmCallRow[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const insert = vi.fn(async (row: LlmCallRow) => {
      await gate;
      rows.push(row);
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const recorder = createUsageRecorder({ scanJobId: SCAN, phase: "package", cardIndex: 1 }, { insert, version: null, log });

    recorder.onUsage(usage({ purpose: "action_package" }));
    recorder.onUsage(usage({ purpose: "action_package", ok: false, outputTokens: 0 }));
    expect(insert).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.info.mock.calls[0]![0] as string)).toMatchObject({ event: "llm_call", phase: "package", cardIndex: 1, costUsd: 0.04 });

    let flushed = false;
    const flushing = recorder.flush().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(rows.map((r) => r.ok)).toEqual([true, false]);
  });

  it("never throws when a write fails: it logs, and flush still resolves", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const recorder = createUsageRecorder({ scanJobId: SCAN, phase: "scan" }, { insert: async () => Promise.reject(new Error("relation does not exist")), version: null, log });
    recorder.onUsage(usage());
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("[llm-usage] could not record a model call:", "relation does not exist");
  });

  it("flushes immediately when no call was made", async () => {
    await expect(createUsageRecorder({ scanJobId: SCAN, phase: "scan" }, { insert: vi.fn(), version: null }).flush()).resolves.toBeUndefined();
  });
});

describe("usage report text", () => {
  it("prints per-phase totals with averages, per-day rows, and marks unpriced calls", async () => {
    const { formatUsageSummary, formatScanGeneration, formatUsd } = await import("@/lib/usage-report");
    const totals = { calls: 3, failedCalls: 1, inputTokens: 25_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, unpricedCalls: 0 };
    const text = formatUsageSummary(
      {
        since: "2026-09-06T00:00:00.000Z",
        byPhase: [
          { phase: "scan", units: 2, totals, averageCostUsd: 0.05 },
          { phase: "repo_brief", units: 1, totals: { ...totals, costUsd: null, unpricedCalls: 3 }, averageCostUsd: null },
        ],
        byDay: [{ day: "2026-10-06", phase: "scan", totals }],
      },
      30,
    );
    expect(text).toContain("last 30 day(s)");
    expect(text).toMatch(/Scans\s+2\s+3\s+1\s+25,000\s+5,000\s+\$0\.10\s+\$0\.05/);
    expect(text).toContain("n/a (+3 unpriced)");
    expect(text).toMatch(/2026-10-06\s+Scans/);
    expect(formatUsageSummary({ since: "x", byPhase: [], byDay: [] }, 7)).toBe("No model calls in the last 7 day(s).");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0)).toBe("$0.00");

    const gen = formatScanGeneration(SCAN, {
      parts: [
        { phase: "scan", cardIndex: null, models: ["claude-sonnet-5"], prompts: [{ purpose: "scientist", promptHash: "aaaaaaaaaaaa" }], appVersions: ["b0707be12345"], totals },
        { phase: "repo_brief", cardIndex: 2, models: ["claude-sonnet-5"], prompts: [{ purpose: null, promptHash: "bbbbbbbbbbbb" }], appVersions: [], totals },
      ],
      totals,
    });
    expect(gen).toContain("Scan (Scientist + Reviewer): 3 call(s), 1 failed, $0.10");
    expect(gen).toContain("prompts: scientist@aaaaaaaaaaaa");
    expect(gen).toContain("Repo brief for card #2");
    expect(gen).toContain("prompts: unlabeled@bbbbbbbbbbbb");
    expect(gen).toContain("commit: n/a");
  });
});
