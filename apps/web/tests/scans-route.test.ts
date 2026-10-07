// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const after = vi.fn();
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after }));
vi.mock("@vercel/functions", () => ({ ipAddress: () => "203.0.113.7" }));
const createScanJobWithinQuota = vi.fn();
vi.mock("@/lib/store", () => ({ createScanJobWithinQuota }));
vi.mock("@/lib/run-scan", () => ({ runScanJob: vi.fn() }));
const getSessionUser = vi.fn(async (): Promise<{ id: string } | null> => null);
vi.mock("@/lib/auth/server", () => ({ getSessionUser }));

async function post(body: unknown = { url: "https://acme.com", category: "ai_saas" }): Promise<Response> {
  const { POST } = await import("@/app/api/scans/route");
  return POST(new Request("http://x/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SCAN_IP_HASH_SECRET", "a-long-test-secret-value-123");
  createScanJobWithinQuota.mockResolvedValue({ ok: true, id: "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/scans quota subject", () => {
  it("counts an anonymous scan against the client IP hash, with the client allowance", async () => {
    const res = await post();
    expect(res.status).toBe(202);
    const [, , ipHash, limits, , subject] = createScanJobWithinQuota.mock.calls[0]!;
    expect(ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(limits).toEqual({ perClient: 3, global: 20 });
    expect(subject).toBe(`ip:${ipHash}`);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("counts a signed-in visitor's scan against their account, with the account allowance", async () => {
    getSessionUser.mockResolvedValueOnce({ id: "user-1" });
    vi.stubEnv("SCAN_LIMIT_PER_ACCOUNT_PER_DAY", "7");
    await post();
    const [, , , limits, , subject] = createScanJobWithinQuota.mock.calls[0]!;
    expect(limits).toEqual({ perClient: 7, global: 20 });
    expect(subject).toBe("user:user-1");
  });

  it("answers 429 with Retry-After and the hint for an anonymous visitor when accounts exist", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    createScanJobWithinQuota.mockResolvedValue({ ok: false, denial: { allowed: false, scope: "client", retryAfterSeconds: 90, message: "Limit reached." } });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("90");
    expect((await res.json()).error).toBe("Limit reached. Signing in with GitHub raises your daily limit.");
  });

  it("fails closed on a bad account limit, before creating anything", async () => {
    vi.stubEnv("SCAN_LIMIT_PER_ACCOUNT_PER_DAY", "0");
    expect((await post()).status).toBe(500);
    expect(createScanJobWithinQuota).not.toHaveBeenCalled();
  });
});
