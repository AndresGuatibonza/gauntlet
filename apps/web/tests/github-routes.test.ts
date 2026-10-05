// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const after = vi.fn();
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after }));
vi.mock("@vercel/functions", () => ({ ipAddress: () => "203.0.113.9" }));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined) }) }));

const getSessionUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({ getSessionUser }));

const getScanOwner = vi.fn();
const recordScanEvent = vi.fn(async () => {});
const getScanJob = vi.fn();
const getActionPackage = vi.fn();
vi.mock("@/lib/store", () => ({ getScanOwner, recordScanEvent, getScanJob, getActionPackage }));

const repoStore = {
  saveUserGitHubAccess: vi.fn(async () => {}),
  listAccessibleRepositories: vi.fn(async (): Promise<unknown[]> => []),
  getScanWorkspace: vi.fn(),
  getWorkspaceRepository: vi.fn(),
  connectWorkspaceRepository: vi.fn(),
  disconnectWorkspaceRepository: vi.fn(),
  claimRepoBrief: vi.fn(),
  getRepoBrief: vi.fn(),
};
vi.mock("@/lib/repo-store", () => repoStore);

const exchangeOAuthCode = vi.fn();
const listUserAccess = vi.fn();
const readGitHubAppConfig = vi.fn();
vi.mock("@/lib/github-app", async (orig) => {
  const real = await orig<typeof import("@/lib/github-app")>();
  return { ...real, exchangeOAuthCode, listUserAccess, readGitHubAppConfig };
});
const runRepoBriefJob = vi.fn();
vi.mock("@/lib/build-repo-brief", () => ({ runRepoBriefJob }));

import { GITHUB_STATE_COOKIE, newGitHubState } from "@/lib/github-state";

const SCAN = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";
const USER = { id: "11111111-2222-4333-8444-555555555555", login: "andres", avatarUrl: null };
const CONFIG = { appId: "1", slug: "gauntlet-dev", clientId: "Iv1", clientSecret: "s", privateKey: {} };
const WORKSPACE = { workspaceId: "aaaaaaaa-0000-4000-8000-000000000001", ownerUserId: USER.id };
const REPO = { installationId: 7, repositoryId: 42, fullName: "acme/web", defaultBranch: "main", connectedAt: "2026-10-05T15:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  cookieJar.clear();
  vi.stubEnv("SCAN_IP_HASH_SECRET", "a-long-test-secret-value-123");
  readGitHubAppConfig.mockReturnValue(CONFIG);
  getSessionUser.mockResolvedValue(USER);
  getScanOwner.mockResolvedValue(USER.id);
  repoStore.getScanWorkspace.mockResolvedValue(WORKSPACE);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/github/connect", () => {
  async function connect(query: string): Promise<Response> {
    const { GET } = await import("@/app/api/github/connect/route");
    return GET(new Request(`https://g.app/api/github/connect?${query}`));
  }

  it("sends the owner to install the App with a state cookie, and records github_connect_started", async () => {
    const res = await connect(`scan=${SCAN}`);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/apps/gauntlet-dev/installations/select_target");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${GITHUB_STATE_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\/api\/github/);
    expect(recordScanEvent).toHaveBeenCalledWith(expect.objectContaining({ scanJobId: SCAN, type: "github_connect_started" }));
  });

  it("with mode=authorize goes straight to GitHub's authorization", async () => {
    const location = new URL((await connect(`scan=${SCAN}&mode=authorize`)).headers.get("location")!);
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("https://g.app/api/github/callback");
  });

  it("refuses visitors who don't own the report, and works without the App configured by saying so", async () => {
    getSessionUser.mockResolvedValueOnce(null);
    expect((await connect(`scan=${SCAN}`)).headers.get("location")).toBe(`https://g.app/signup?next=${encodeURIComponent(`/scans/${SCAN}`)}`);
    getScanOwner.mockResolvedValueOnce("someone-else");
    expect((await connect(`scan=${SCAN}`)).headers.get("location")).toBe(`https://g.app/scans/${SCAN}?github=not_owner`);
    readGitHubAppConfig.mockReturnValueOnce(null);
    expect((await connect(`scan=${SCAN}`)).headers.get("location")).toBe(`https://g.app/scans/${SCAN}?github=unavailable`);
    expect((await connect("scan=not-a-uuid")).headers.get("location")).toBe("https://g.app/ledger");
    expect(recordScanEvent).not.toHaveBeenCalled();
  });
});

describe("GET /api/github/callback", () => {
  async function callback(query: string, withCookie = true): Promise<{ res: Response; state: string }> {
    const { state, cookieValue } = newGitHubState(SCAN);
    if (withCookie) cookieJar.set(GITHUB_STATE_COOKIE, cookieValue);
    const { GET } = await import("@/app/api/github/callback/route");
    const res = await GET(new Request(`https://g.app/api/github/callback?state=${state}&${query}`));
    return { res, state };
  }

  it("stores what the user can read, records github_connected and returns to the report", async () => {
    exchangeOAuthCode.mockResolvedValue("ghu_token");
    const access = {
      installations: [{ installationId: 7, accountLogin: "acme", accountType: "Organization" }],
      repositories: [{ installationId: 7, repositoryId: 42, fullName: "acme/web", defaultBranch: "main", private: true }],
      complete: true,
    };
    listUserAccess.mockResolvedValue(access);
    const { res } = await callback("code=abc&installation_id=7&setup_action=install");
    expect(res.headers.get("location")).toBe(`https://g.app/scans/${SCAN}?github=connected`);
    expect(exchangeOAuthCode).toHaveBeenCalledWith(CONFIG, "abc", "https://g.app/api/github/callback");
    expect(repoStore.saveUserGitHubAccess).toHaveBeenCalledWith(USER.id, access.installations, access.repositories);
    expect(recordScanEvent).toHaveBeenCalledWith(expect.objectContaining({ scanJobId: SCAN, type: "github_connected" }));
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${GITHUB_STATE_COOKIE}=;`));
  });

  it("never acts on a state it didn't issue", async () => {
    const { res } = await callback("code=abc", false);
    expect(res.headers.get("location")).toBe("https://g.app/ledger?github=expired");
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("asks GitHub to authorize when the install came back without a code", async () => {
    const { res, state } = await callback("installation_id=7&setup_action=update");
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("state")).toBe(state);
  });

  it("reports cancellations, refused codes, no repositories and failures", async () => {
    expect((await callback("error=access_denied")).res.headers.get("location")).toContain("github=denied");
    const { GitHubAppError } = await import("@/lib/github-app");
    exchangeOAuthCode.mockRejectedValueOnce(new GitHubAppError("bad code", "denied"));
    expect((await callback("code=old")).res.headers.get("location")).toContain("github=denied");
    exchangeOAuthCode.mockResolvedValue("ghu");
    listUserAccess.mockResolvedValueOnce({ installations: [], repositories: [], complete: true });
    expect((await callback("code=x")).res.headers.get("location")).toContain("github=no_repos");
    listUserAccess.mockRejectedValueOnce(new Error("boom"));
    expect((await callback("code=y")).res.headers.get("location")).toContain("github=error");
    expect(recordScanEvent).not.toHaveBeenCalled();
  });
});

describe("/api/scans/:id/repository", () => {
  async function call(method: "GET" | "POST" | "DELETE", body?: unknown): Promise<Response> {
    const route = await import("@/app/api/scans/[id]/repository/route");
    const init: RequestInit = { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    return route[method](new Request("https://g.app/x", init), { params: Promise.resolve({ id: SCAN }) });
  }

  it("shows the connection and what the owner can read", async () => {
    repoStore.getWorkspaceRepository.mockResolvedValue(REPO);
    repoStore.listAccessibleRepositories.mockResolvedValue([{ installationId: 7, repositoryId: 42, fullName: "acme/web", defaultBranch: "main", private: true }]);
    expect(await (await call("GET")).json()).toEqual({
      available: true,
      connected: { repositoryId: 42, fullName: "acme/web", defaultBranch: "main", connectedAt: REPO.connectedAt },
      accessible: [{ repositoryId: 42, fullName: "acme/web", private: true }],
    });
  });

  it("is owner only", async () => {
    getSessionUser.mockResolvedValueOnce(null);
    expect((await call("GET")).status).toBe(401);
    repoStore.getScanWorkspace.mockResolvedValueOnce({ ...WORKSPACE, ownerUserId: "other" });
    expect((await call("DELETE")).status).toBe(403);
    repoStore.getScanWorkspace.mockResolvedValueOnce(null);
    expect((await call("GET")).status).toBe(404);
    expect(repoStore.disconnectWorkspaceRepository).not.toHaveBeenCalled();
  });

  it("connects only a repository the owner can read, and disconnects", async () => {
    expect((await call("POST", { repositoryId: "42" })).status).toBe(400);
    repoStore.connectWorkspaceRepository.mockResolvedValueOnce({ outcome: "not_accessible" });
    expect((await call("POST", { repositoryId: 99 })).status).toBe(404);
    repoStore.connectWorkspaceRepository.mockResolvedValueOnce({ outcome: "connected", repository: REPO });
    const res = await call("POST", { repositoryId: 42 });
    expect(await res.json()).toEqual({ connected: { repositoryId: 42, fullName: "acme/web", defaultBranch: "main", connectedAt: REPO.connectedAt } });
    expect(repoStore.connectWorkspaceRepository).toHaveBeenLastCalledWith(WORKSPACE.workspaceId, USER.id, 42);
    repoStore.disconnectWorkspaceRepository.mockResolvedValueOnce({ disconnected: true, briefsDeleted: 2 });
    expect(await (await call("DELETE")).json()).toEqual({ disconnected: true, briefsDeleted: 2 });
  });

  it("reports when GitHub connections aren't configured", async () => {
    readGitHubAppConfig.mockReturnValue(null);
    repoStore.getWorkspaceRepository.mockResolvedValue(null);
    expect((await (await call("GET")).json()).available).toBe(false);
    expect((await call("POST", { repositoryId: 42 })).status).toBe(503);
  });
});

describe("/api/scans/:id/cards/:index/repo-brief", () => {
  async function call(method: "GET" | "POST"): Promise<Response> {
    const route = await import("@/app/api/scans/[id]/cards/[index]/repo-brief/route");
    return route[method](new Request("https://g.app/x", { method }), { params: Promise.resolve({ id: SCAN, index: "0" }) });
  }

  beforeEach(() => {
    getScanJob.mockResolvedValue({ id: SCAN, status: "done", opportunityReport: { cards: [{ title: "a" }] } });
    repoStore.getWorkspaceRepository.mockResolvedValue(REPO);
    getActionPackage.mockResolvedValue({ state: "ready", id: "p", package: {} });
  });

  it("starts one background job for the owner and answers 202", async () => {
    repoStore.claimRepoBrief.mockResolvedValue({ outcome: "start", id: "b1", reuseAnalysis: false });
    const res = await call("POST");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "generating", stage: "reading", repository: "acme/web" });
    expect(after).toHaveBeenCalledTimes(1);
    expect(repoStore.claimRepoBrief).toHaveBeenCalledWith({
      scanJobId: SCAN,
      cardIndex: 0,
      workspaceId: WORKSPACE.workspaceId,
      repository: REPO,
      userId: USER.id,
      limits: { perClient: 10, global: 60 },
    });
    await (after.mock.calls[0]![0] as () => Promise<void>)();
    expect(runRepoBriefJob).toHaveBeenCalledWith("b1", SCAN, 0, false);
  });

  it("needs a connected repository and the card's public brief first", async () => {
    repoStore.getWorkspaceRepository.mockResolvedValueOnce(null);
    expect((await call("POST")).status).toBe(409);
    getActionPackage.mockResolvedValueOnce({ state: "none" });
    const res = await call("POST");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Build this");
    expect(repoStore.claimRepoBrief).not.toHaveBeenCalled();
  });

  it("enforces the per-account quota and never shows briefs to others", async () => {
    repoStore.claimRepoBrief.mockResolvedValue({ outcome: "denied", denial: { allowed: false, scope: "client", retryAfterSeconds: 60, message: "limit" } });
    const res = await call("POST");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    repoStore.getScanWorkspace.mockResolvedValue({ ...WORKSPACE, ownerUserId: "other" });
    expect((await call("GET")).status).toBe(403);
    expect(repoStore.getRepoBrief).not.toHaveBeenCalled();
  });

  it("reports each state for polling", async () => {
    repoStore.getRepoBrief.mockResolvedValueOnce({ state: "generating", id: "b", repository: "acme/web", stage: "writing" });
    const generating = await call("GET");
    expect(generating.status).toBe(202);
    expect(await generating.json()).toEqual({ status: "generating", stage: "writing", repository: "acme/web" });
    repoStore.getRepoBrief.mockResolvedValueOnce({ state: "failed", id: "b", repository: "acme/web", errorMessage: "nope", canRetry: true });
    expect(await (await call("GET")).json()).toEqual({ status: "failed", error: "nope", canRetry: true, repository: "acme/web" });
    repoStore.getRepoBrief.mockResolvedValueOnce({ state: "none" });
    expect(await (await call("GET")).json()).toEqual({ status: "none" });
  });
});
