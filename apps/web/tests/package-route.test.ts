// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const after = vi.fn();
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after }));
vi.mock("@vercel/functions", () => ({ ipAddress: () => "203.0.113.7" }));

const getScanJob = vi.fn();
const claimActionPackage = vi.fn();
const getActionPackage = vi.fn();
vi.mock("@/lib/store", () => ({ getScanJob, claimActionPackage, getActionPackage }));
vi.mock("@/lib/build-package", () => ({ runActionPackageJob: vi.fn() }));
const getSessionUser = vi.fn(async (): Promise<{ id: string } | null> => null);
vi.mock("@/lib/auth/server", () => ({ getSessionUser }));

const ID = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";
const doneJob = { id: ID, status: "done", opportunityReport: { cards: [{ title: "a" }, { title: "b" }] } };

async function call(method: "GET" | "POST", id = ID, index = "1"): Promise<Response> {
  const route = await import("@/app/api/scans/[id]/cards/[index]/package/route");
  return route[method](new Request(`http://x/api/scans/${id}/cards/${index}/package`, { method }), {
    params: Promise.resolve({ id, index }),
  });
}

beforeEach(() => {
  vi.stubEnv("SCAN_IP_HASH_SECRET", "a-long-test-secret-value-123");
  vi.clearAllMocks();
  getScanJob.mockResolvedValue(doneJob);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/scans/:id/cards/:index/package", () => {
  it("starts one background generation and answers 202", async () => {
    claimActionPackage.mockResolvedValue({ outcome: "start", id: "pkg-1" });
    const res = await call("POST");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "generating" });
    expect(after).toHaveBeenCalledTimes(1);
    expect(claimActionPackage).toHaveBeenCalledWith(
      ID,
      1,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      { perClient: 5, global: 40 },
      expect.stringMatching(/^ip:[0-9a-f]{64}$/),
    );
  });

  it("counts a signed-in visitor's brief against their account, with the account allowance", async () => {
    getSessionUser.mockResolvedValueOnce({ id: "user-1" });
    claimActionPackage.mockResolvedValue({ outcome: "start", id: "pkg-1" });
    await call("POST");
    expect(claimActionPackage).toHaveBeenCalledWith(ID, 1, expect.any(String), { perClient: 10, global: 40 }, "user:user-1");
  });

  it("adds the sign-in hint to an anonymous visitor's own limit only when accounts exist", async () => {
    const denied = { outcome: "denied", denial: { allowed: false, scope: "client", retryAfterSeconds: 60, message: "You've reached the limit." } };
    claimActionPackage.mockResolvedValue(denied);
    expect((await (await call("POST")).json()).error).toBe("You've reached the limit.");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    expect((await (await call("POST")).json()).error).toBe("You've reached the limit. Signing in with GitHub raises your daily limit.");
  });

  it("returns an existing package without generating again", async () => {
    const pkg = {
      objective: "o", nonGoals: ["n"], likelyComponents: ["c"], approach: ["a", "b"],
      featureFlag: { name: "flag_x", rollout: "50%" }, acceptanceCriteria: ["1", "2", "3"],
      measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "d" }, rollbackCriteria: ["r"],
      risks: [{ risk: "x", mitigation: "y" }], missingContext: ["m"], evidenceRefs: ["E1"], version: 1,
      generatedAt: "2026-10-02T15:00:00.000Z", product: { name: "P", url: "https://p.com/" },
      card: { title: "t", hypothesis: "h", changeSurface: "ux", missingEvidence: "me" },
      experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
      codeContext: "public_scan", citedEvidence: [{ id: "E1", observation: "o", sourceRef: "s" }],
    };
    claimActionPackage.mockResolvedValue({ outcome: "existing", state: { state: "ready", id: "pkg-1", package: pkg } });
    const res = await call("POST");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.codingAgentPrompt).toContain("`flag_x` (default off)");
    expect(body.markdown).toContain("# Implementation brief: t");
    expect(after).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After when the package quota is used up", async () => {
    claimActionPackage.mockResolvedValue({ outcome: "denied", denial: { allowed: false, scope: "client", retryAfterSeconds: 120, message: "limit" } });
    const res = await call("POST");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("refuses unknown cards, unfinished reports and malformed ids before claiming anything", async () => {
    expect((await call("POST", ID, "7")).status).toBe(404);
    expect((await call("POST", "not-a-uuid")).status).toBe(404);
    expect((await call("POST", ID, "-1")).status).toBe(404);
    getScanJob.mockResolvedValue({ ...doneJob, status: "analyzing", opportunityReport: null });
    expect((await call("POST")).status).toBe(409);
    expect(claimActionPackage).not.toHaveBeenCalled();
  });

  it("fails closed when the IP hash secret is missing", async () => {
    vi.stubEnv("SCAN_IP_HASH_SECRET", "");
    expect((await call("POST")).status).toBe(500);
    expect(claimActionPackage).not.toHaveBeenCalled();
  });
});

describe("GET /api/scans/:id/cards/:index/package", () => {
  it("reports each state for polling", async () => {
    getActionPackage.mockResolvedValueOnce({ state: "generating", id: "p" });
    expect((await call("GET")).status).toBe(202);
    getActionPackage.mockResolvedValueOnce({ state: "failed", id: "p", errorMessage: "boom", canRetry: true });
    expect(await (await call("GET")).json()).toEqual({ status: "failed", error: "boom", canRetry: true });
    getActionPackage.mockResolvedValueOnce({ state: "none" });
    expect(await (await call("GET")).json()).toEqual({ status: "none" });
  });
});
