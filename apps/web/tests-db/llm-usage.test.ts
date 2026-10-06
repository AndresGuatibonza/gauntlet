import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { runMigrations } from "@/lib/migrate";
import { connect, createTestDatabase } from "./helpers";
import type { LlmCallRow } from "@/lib/llm-usage";

let db: { url: string; drop: () => Promise<void> };
let sql: Client;
let usage: typeof import("@/lib/llm-usage");
let dbModule: typeof import("@/lib/db");

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connect(db.url);
  await runMigrations(sql);
  process.env["DATABASE_URL"] = db.url;
  usage = await import("@/lib/llm-usage");
  dbModule = await import("@/lib/db");
});

afterAll(async () => {
  await dbModule.getPool().end();
  await sql.end();
  await db.drop();
});

async function doneScan(): Promise<string> {
  const r = await sql.query(`insert into scan_jobs (url, category, status) values ('https://a.com/', 'ai_saas', 'done') returning id`);
  return r.rows[0].id;
}

function row(scanJobId: string, overrides: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    scanJobId,
    phase: "scan",
    cardIndex: null,
    purpose: "scientist",
    model: "claude-sonnet-5",
    promptHash: "aaaaaaaaaaaa",
    appVersion: "b0707be12345",
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.04,
    stopReason: "end_turn",
    durationMs: 900,
    ok: true,
    ...overrides,
  };
}

describe("llm_calls", () => {
  it("summarizes what produced a report and each brief, and what they cost", async () => {
    const scan = await doneScan();
    await usage.insertLlmCall(row(scan));
    await usage.insertLlmCall(row(scan, { purpose: "reviewer", promptHash: "bbbbbbbbbbbb", costUsd: 0.02, inputTokens: 5000, outputTokens: 1000 }));
    await usage.insertLlmCall(row(scan, { phase: "package", cardIndex: 1, purpose: "action_package", promptHash: "cccccccccccc", costUsd: 0.03 }));
    await usage.insertLlmCall(row(scan, { phase: "package", cardIndex: 1, purpose: "action_package", promptHash: "cccccccccccc", ok: false, outputTokens: 0, inputTokens: 0, costUsd: 0, stopReason: null }));

    const gen = await usage.getScanGeneration(scan);
    expect(gen.parts.map((p) => [p.phase, p.cardIndex])).toEqual([
      ["scan", null],
      ["package", 1],
    ]);
    expect(gen.parts[0]).toMatchObject({
      models: ["claude-sonnet-5"],
      prompts: [
        { purpose: "reviewer", promptHash: "bbbbbbbbbbbb" },
        { purpose: "scientist", promptHash: "aaaaaaaaaaaa" },
      ],
      appVersions: ["b0707be12345"],
      totals: { calls: 2, failedCalls: 0, inputTokens: 15_000, outputTokens: 3_000, costUsd: 0.06, unpricedCalls: 0 },
    });
    expect(gen.parts[1]!.prompts).toEqual([{ purpose: "action_package", promptHash: "cccccccccccc" }]);
    expect(gen.parts[1]!.totals).toMatchObject({ calls: 2, failedCalls: 1, costUsd: 0.03 });
    expect(gen.totals).toMatchObject({ calls: 4, failedCalls: 1, costUsd: 0.09 });

    expect(await usage.getScanGeneration(await doneScan())).toEqual({
      parts: [],
      totals: { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, unpricedCalls: 0 },
    });
  });

  it("averages cost per scan and per brief, and counts unpriced calls apart", async () => {
    await sql.query("delete from llm_calls");
    const a = await doneScan();
    const b = await doneScan();
    await usage.insertLlmCall(row(a, { costUsd: 0.05 }));
    await usage.insertLlmCall(row(a, { purpose: "reviewer", costUsd: 0.03 }));
    await usage.insertLlmCall(row(b, { costUsd: 0.04 }));
    await usage.insertLlmCall(row(a, { phase: "repo_brief", cardIndex: 0, purpose: "repo_selection", costUsd: null, model: "other" }));

    const summary = await usage.usageSummary(7);
    const scan = summary.byPhase.find((p) => p.phase === "scan")!;
    expect(scan).toMatchObject({ units: 2, averageCostUsd: 0.06, totals: { calls: 3, costUsd: 0.12 } });
    const repo = summary.byPhase.find((p) => p.phase === "repo_brief")!;
    expect(repo).toMatchObject({ units: 1, averageCostUsd: null, totals: { unpricedCalls: 1, costUsd: null } });
    expect(summary.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    await expect(usage.usageSummary(0)).rejects.toThrow(RangeError);
  });

  it("keeps cost history after the scan is deleted", async () => {
    const scan = await doneScan();
    await usage.insertLlmCall(row(scan));
    await sql.query("delete from scan_jobs where id = $1", [scan]);
    expect((await usage.getScanGeneration(scan)).totals.calls).toBe(1);
  });

  it("rejects inconsistent rows at the database level", async () => {
    const scan = await doneScan();
    await expect(usage.insertLlmCall(row(scan, { cardIndex: 0 }))).rejects.toThrow(/llm_calls_card_matches_phase/);
    await expect(usage.insertLlmCall(row(scan, { phase: "package", cardIndex: null }))).rejects.toThrow(/llm_calls_card_matches_phase/);
    await expect(usage.insertLlmCall(row(scan, { promptHash: "not-a-hash" }))).rejects.toThrow(/prompt_hash/);
    await expect(usage.insertLlmCall(row(scan, { purpose: "anything" }))).rejects.toThrow(/purpose/);
    await expect(usage.insertLlmCall(row(scan, { inputTokens: -1 }))).rejects.toThrow(/input_tokens/);
  });

  it("feeds a recorder end to end", async () => {
    const scan = await doneScan();
    const recorder = usage.createUsageRecorder({ scanJobId: scan, phase: "repo_brief", cardIndex: 2 }, { version: null, log: { info: () => {}, error: () => {} } });
    recorder.onUsage({ purpose: "repo_analysis", model: "claude-sonnet-5", promptHash: "dddddddddddd", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: "end_turn", durationMs: 5, ok: true });
    await recorder.flush();
    const gen = await usage.getScanGeneration(scan);
    expect(gen.parts).toEqual([
      expect.objectContaining({ phase: "repo_brief", cardIndex: 2, appVersions: [], prompts: [{ purpose: "repo_analysis", promptHash: "dddddddddddd" }] }),
    ]);
  });
});
