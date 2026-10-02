// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const expireStaleJobs = vi.fn(async () => ["a"]);
const purgeExpiredData = vi.fn(async () => ({ ipHashesCleared: 2, scansDeleted: 1 }));
vi.mock("@/lib/store", () => ({ expireStaleJobs, purgeExpiredData }));

const SECRET = "cron-secret-for-tests-123456";

function call(auth?: string): Promise<Response> {
  return import("@/app/api/cron/maintenance/route").then(({ GET }) =>
    GET(new Request("http://x/api/cron/maintenance", { headers: auth ? { authorization: auth } : {} })),
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  expireStaleJobs.mockClear();
  purgeExpiredData.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/cron/maintenance", () => {
  it("refuses requests without the cron secret and touches nothing", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(expireStaleJobs).not.toHaveBeenCalled();
  });

  it("expires stale scans and applies the retention policy", async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staleScansFailed: 1, ipHashesCleared: 2, scansDeleted: 1, retentionDays: 180 });
    expect(purgeExpiredData).toHaveBeenCalledWith({ retentionDays: 180, ipHashHours: 48 });
  });

  it("refuses to purge with an invalid retention setting", async () => {
    vi.stubEnv("SCAN_RETENTION_DAYS", "3");
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(purgeExpiredData).not.toHaveBeenCalled();
  });
});
