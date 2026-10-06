// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionPackage } from "@gauntlet/core";

const getScanJob = vi.fn();
const listActionPackages = vi.fn();
vi.mock("@/lib/store", () => ({ getScanJob, listActionPackages }));

const ID = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";
const doneJob = { id: ID, status: "done", opportunityReport: { cards: [{ title: "a" }, { title: "b" }] } };

const pkg = {
  objective: "o", nonGoals: ["n"], likelyComponents: ["c"], approach: ["a", "b"],
  featureFlag: { name: "flag_x", rollout: "50%" }, acceptanceCriteria: ["1", "2", "3"],
  measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "d" }, rollbackCriteria: ["r"],
  risks: [{ risk: "x", mitigation: "y" }], missingContext: ["m"], evidenceRefs: ["E1"], version: 1,
  generatedAt: "2026-10-02T15:00:00.000Z", product: { name: "P", url: "https://p.com/" },
  card: { title: "t", hypothesis: "h", changeSurface: "ux", missingEvidence: "me" },
  experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
  codeContext: "public_scan", citedEvidence: [{ id: "E1", observation: "o", sourceRef: "s" }],
} as unknown as ActionPackage;

async function call(id = ID): Promise<Response> {
  const route = await import("@/app/api/scans/[id]/packages/route");
  return route.GET(new Request(`http://x/api/scans/${id}/packages`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getScanJob.mockResolvedValue(doneJob);
});

describe("GET /api/scans/:id/packages", () => {
  it("lists every brief by card, in the per-card route's shape, never cached", async () => {
    listActionPackages.mockResolvedValue([
      { cardIndex: 0, state: { state: "ready", id: "p0", package: pkg } },
      { cardIndex: 1, state: { state: "generating", id: "p1" } },
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { packages: Record<string, unknown>[] };
    expect(body.packages).toHaveLength(2);
    expect(body.packages[0]).toMatchObject({ cardIndex: 0, status: "ready", package: { objective: "o" } });
    expect(body.packages[0]!["codingAgentPrompt"]).toEqual(expect.any(String));
    expect(body.packages[0]!["markdown"]).toContain("flag_x");
    expect(body.packages[1]).toEqual({ cardIndex: 1, status: "generating" });
    expect(listActionPackages).toHaveBeenCalledWith(ID);
  });

  it("passes on a failure with its retry flag, and drops rows for cards the report doesn't have", async () => {
    listActionPackages.mockResolvedValue([
      { cardIndex: 1, state: { state: "failed", id: "p1", errorMessage: "boom", canRetry: false } },
      { cardIndex: 7, state: { state: "ready", id: "p7", package: pkg } },
    ]);
    expect(await (await call()).json()).toEqual({ packages: [{ cardIndex: 1, status: "failed", error: "boom", canRetry: false }] });
  });

  it("has none for an unfinished report, 404s an unknown or malformed id, 500s a database error", async () => {
    getScanJob.mockResolvedValueOnce({ id: ID, status: "running", opportunityReport: null });
    expect(await (await call()).json()).toEqual({ packages: [] });
    expect(listActionPackages).not.toHaveBeenCalled();

    getScanJob.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    expect((await call("not-a-uuid")).status).toBe(404);

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    getScanJob.mockRejectedValueOnce(new Error("db down"));
    expect((await call()).status).toBe(500);
  });
});
