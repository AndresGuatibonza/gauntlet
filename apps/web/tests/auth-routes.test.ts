// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@vercel/functions", () => ({ ipAddress: () => "203.0.113.9" }));

const exchangeCodeForSession = vi.fn();
const createSupabaseServerClient = vi.fn(async () => ({ auth: { exchangeCodeForSession } }));
const getSessionUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({ createSupabaseServerClient, getSessionUser }));

const recordScanEvent = vi.fn(async () => {});
const claimScan = vi.fn();
const getScanOwner = vi.fn();
const getExperimentForCard = vi.fn();
const updateExperiment = vi.fn();
vi.mock("@/lib/store", () => ({ recordScanEvent, claimScan, getScanOwner, getExperimentForCard, updateExperiment }));

const SCAN = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";
const USER = { id: "11111111-2222-4333-8444-555555555555", login: "andres", avatarUrl: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SCAN_IP_HASH_SECRET", "a-long-test-secret-value-123");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /auth/callback", () => {
  async function callback(query: string): Promise<Response> {
    const { GET } = await import("@/app/auth/callback/route");
    return GET(new Request(`https://g.app/auth/callback?${query}`));
  }

  it("sets the session, records signup_completed for a report, and returns to it", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await callback(`code=abc&next=${encodeURIComponent(`/scans/${SCAN}`)}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://g.app/scans/${SCAN}`);
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(recordScanEvent).toHaveBeenCalledWith(expect.objectContaining({ scanJobId: SCAN, type: "signup_completed" }));
  });

  it("never redirects off-site", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await callback(`code=abc&next=${encodeURIComponent("https://evil.example")}`);
    expect(res.headers.get("location")).toBe("https://g.app/");
    expect(recordScanEvent).not.toHaveBeenCalled();
  });

  it("sends failures back to sign-in with a reason, and still signs in if analytics fail", async () => {
    expect((await callback("next=/ledger")).headers.get("location")).toContain("/signup?error=missing_code");
    expect((await callback("error=access_denied")).headers.get("location")).toContain("error=denied");
    exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    expect((await callback("code=x")).headers.get("location")).toContain("error=exchange");
    exchangeCodeForSession.mockResolvedValue({ error: null });
    recordScanEvent.mockRejectedValueOnce(new Error("db down"));
    expect((await callback(`code=y&next=/scans/${SCAN}`)).headers.get("location")).toBe(`https://g.app/scans/${SCAN}`);
  });
});

describe("POST /api/scans/:id/claim", () => {
  async function claim(body: unknown): Promise<Response> {
    const { POST } = await import("@/app/api/scans/[id]/claim/route");
    return POST(new Request("https://g.app/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: SCAN }) });
  }
  const token = "t".repeat(43);

  it("requires a signed-in user and a token", async () => {
    expect((await claim({})).status).toBe(400);
    getSessionUser.mockResolvedValue(null);
    expect((await claim({ token })).status).toBe(401);
    expect(claimScan).not.toHaveBeenCalled();
  });

  it("maps every claim outcome", async () => {
    getSessionUser.mockResolvedValue(USER);
    claimScan.mockResolvedValueOnce({ outcome: "claimed", workspaceId: "w" });
    expect(await (await claim({ token })).json()).toEqual({ status: "claimed", workspaceId: "w" });
    claimScan.mockResolvedValueOnce({ outcome: "invalid_token" });
    expect((await claim({ token })).status).toBe(403);
    claimScan.mockResolvedValueOnce({ outcome: "claimed_by_other" });
    expect((await claim({ token })).status).toBe(403);
    claimScan.mockResolvedValueOnce({ outcome: "not_found" });
    expect((await claim({ token })).status).toBe(404);
    expect(claimScan).toHaveBeenCalledWith(SCAN, token, USER.id);
  });
});

describe("/api/scans/:id/cards/:index/experiment", () => {
  const planned = {
    hypothesis: "h", evidenceSnapshot: [{ id: "E1", observation: "o", sourceRef: "s" }], change: { featureFlag: "f", summary: "s" },
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
    status: "planned", result: null, decision: null, outcome: null,
  };
  const stored = { id: "e1", scanJobId: SCAN, cardIndex: 0, record: planned, decidedAt: null, createdAt: "", updatedAt: "" };

  async function post(body: unknown): Promise<Response> {
    const { POST } = await import("@/app/api/scans/[id]/cards/[index]/experiment/route");
    return POST(new Request("https://g.app/x", { method: "POST", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: SCAN, index: "0" }),
    });
  }

  it("is for the owner only", async () => {
    getSessionUser.mockResolvedValue(null);
    expect((await post({ running: true })).status).toBe(401);
    getSessionUser.mockResolvedValue(USER);
    getScanOwner.mockResolvedValue("someone-else");
    expect((await post({ running: true })).status).toBe(403);
    expect(updateExperiment).not.toHaveBeenCalled();
  });

  it("applies the shared ledger rules and saves", async () => {
    getSessionUser.mockResolvedValue(USER);
    getScanOwner.mockResolvedValue(USER.id);
    getExperimentForCard.mockResolvedValue(stored);
    updateExperiment.mockImplementation(async (_id, _prev, next) => ({ outcome: "updated", experiment: { ...stored, record: next } }));
    const res = await post({ decision: "ship", result: "Signups +8%" });
    expect(res.status).toBe(200);
    expect((await res.json()).experiment.record).toMatchObject({ status: "decided", decision: "ship", result: "Signups +8%" });
    expect(updateExperiment).toHaveBeenCalledWith("e1", planned, expect.objectContaining({ status: "decided" }), USER.id);
  });

  it("explains refusals: rule violations, conflicts, bad input, missing record", async () => {
    getSessionUser.mockResolvedValue(USER);
    getScanOwner.mockResolvedValue(USER.id);
    getExperimentForCard.mockResolvedValue(stored);
    const rule = await post({ decision: "ship" });
    expect(rule.status).toBe(422);
    expect((await rule.json()).error).toContain("needs its result");
    updateExperiment.mockResolvedValue({ outcome: "conflict" });
    expect((await post({ running: true })).status).toBe(409);
    expect((await post({ decision: "maybe", result: "x" })).status).toBe(400);
    expect((await post({ running: true, admin: true })).status).toBe(400);
    getExperimentForCard.mockResolvedValue(null);
    expect((await post({ running: true })).status).toBe(404);
  });
});
