import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import type { ActionPackage, RepoAnalysis } from "@gauntlet/core";
import { runMigrations } from "@/lib/migrate";
import { newClaimToken } from "@/lib/accounts";
import { connect, createTestDatabase } from "./helpers";

let db: { url: string; drop: () => Promise<void> };
let sql: Client;
let store: typeof import("@/lib/store");
let repos: typeof import("@/lib/repo-store");
let dbModule: typeof import("@/lib/db");

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const LIMITS = { perClient: 3, global: 50 };

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connect(db.url);
  await runMigrations(sql);
  process.env["DATABASE_URL"] = db.url;
  store = await import("@/lib/store");
  repos = await import("@/lib/repo-store");
  dbModule = await import("@/lib/db");
});

afterAll(async () => {
  await dbModule.getPool().end();
  await sql.end();
  await db.drop();
});

/** A finished scan saved to `owner`'s workspace. */
async function savedScan(owner: string, url = "https://acme.com/"): Promise<{ scanId: string; workspaceId: string }> {
  const claim = newClaimToken();
  const r = await store.createScanJobWithinQuota(url, "ai_saas", `c-${Math.random()}`, { perClient: 99, global: 999 }, claim.hash);
  if (!r.ok) throw new Error("quota");
  await sql.query(`update scan_jobs set status = 'done' where id = $1`, [r.id]);
  const claimed = await store.claimScan(r.id, claim.token, owner);
  if (claimed.outcome !== "claimed" && claimed.outcome !== "already_yours") throw new Error(claimed.outcome);
  return { scanId: r.id, workspaceId: claimed.workspaceId };
}

async function grant(owner: string, repositories: { id: number; name: string }[], installationId = 7): Promise<void> {
  await repos.saveUserGitHubAccess(
    owner,
    [{ installationId, accountLogin: "acme", accountType: "Organization" }],
    repositories.map((r) => ({ installationId, repositoryId: r.id, fullName: r.name, defaultBranch: "main", private: true })),
  );
}

const analysis = { version: 1, generatedAt: "2026-10-05T15:00:00.000Z" } as unknown as RepoAnalysis;
const pkg = { objective: "o", codeContext: "github" } as unknown as ActionPackage;

describe("GitHub access and workspace repositories", () => {
  it("replaces a user's access on every connection; access removed on GitHub disappears", async () => {
    await grant(ALICE, [{ id: 1, name: "acme/api" }, { id: 2, name: "acme/web" }]);
    expect((await repos.listAccessibleRepositories(ALICE)).map((r) => r.fullName)).toEqual(["acme/api", "acme/web"]);
    await grant(ALICE, [{ id: 2, name: "acme/web" }]);
    expect((await repos.listAccessibleRepositories(ALICE)).map((r) => r.repositoryId)).toEqual([2]);
    expect(await repos.listAccessibleRepositories(BOB)).toEqual([]);
    // A repository listed under an installation the user doesn't have is ignored.
    await repos.saveUserGitHubAccess(BOB, [], [{ installationId: 99, repositoryId: 5, fullName: "x/y", defaultBranch: "main", private: false }]);
    expect(await repos.listAccessibleRepositories(BOB)).toEqual([]);
  });

  it("connects only a repository the owner proved access to, one per workspace", async () => {
    const { workspaceId, scanId } = await savedScan(ALICE);
    await grant(ALICE, [{ id: 2, name: "acme/web" }]);
    expect(await repos.connectWorkspaceRepository(workspaceId, ALICE, 3)).toEqual({ outcome: "not_accessible" });
    expect(await repos.connectWorkspaceRepository(workspaceId, BOB, 2)).toEqual({ outcome: "not_accessible" });
    const connected = await repos.connectWorkspaceRepository(workspaceId, ALICE, 2);
    expect(connected).toMatchObject({ outcome: "connected", repository: { repositoryId: 2, fullName: "acme/web", installationId: 7, defaultBranch: "main" } });
    expect(await repos.getWorkspaceRepository(workspaceId)).toMatchObject({ repositoryId: 2 });
    expect(await repos.getScanWorkspace(scanId)).toEqual({ workspaceId, ownerUserId: ALICE });
  });

  it("deletes the briefs written from a repository when it is switched or disconnected", async () => {
    const { workspaceId, scanId } = await savedScan(ALICE, "https://switch.example/");
    await grant(ALICE, [{ id: 2, name: "acme/web" }, { id: 4, name: "acme/site" }]);
    await repos.connectWorkspaceRepository(workspaceId, ALICE, 2);
    const claim = await repos.claimRepoBrief({ scanJobId: scanId, cardIndex: 0, workspaceId, repository: { repositoryId: 2, fullName: "acme/web" }, userId: ALICE, limits: LIMITS });
    expect(claim.outcome).toBe("start");
    // Reconnecting the same repository keeps its briefs.
    await repos.connectWorkspaceRepository(workspaceId, ALICE, 2);
    expect((await repos.getRepoBrief(scanId, 0)).state).toBe("generating");
    await repos.connectWorkspaceRepository(workspaceId, ALICE, 4);
    expect(await repos.getRepoBrief(scanId, 0)).toEqual({ state: "none" });

    await repos.claimRepoBrief({ scanJobId: scanId, cardIndex: 1, workspaceId, repository: { repositoryId: 4, fullName: "acme/site" }, userId: ALICE, limits: LIMITS });
    expect(await repos.disconnectWorkspaceRepository(workspaceId)).toEqual({ disconnected: true, briefsDeleted: 1 });
    expect(await repos.getWorkspaceRepository(workspaceId)).toBeNull();
    expect(await repos.disconnectWorkspaceRepository(workspaceId)).toEqual({ disconnected: false, briefsDeleted: 0 });
  });
});

describe("repo-aware briefs", () => {
  async function setup(owner = BOB) {
    const { workspaceId, scanId } = await savedScan(owner, `https://brief-${Math.random()}.example/`);
    const repository = { repositoryId: 10, fullName: "bob/app" };
    const claim = (cardIndex = 0, limits = { perClient: 50, global: 500 }) =>
      repos.claimRepoBrief({ scanJobId: scanId, cardIndex, workspaceId, repository, userId: owner, limits });
    return { workspaceId, scanId, claim };
  }

  it("generates once for concurrent requests, stores the analysis, then completes with its event", async () => {
    const { scanId, claim } = await setup();
    const [a, b] = await Promise.all([claim(), claim()]);
    const starts = [a, b].filter((c) => c.outcome === "start");
    expect(starts).toHaveLength(1);
    expect([a, b].find((c) => c.outcome === "existing")).toMatchObject({ state: { state: "generating", stage: "reading", repository: "bob/app" } });
    const id = (starts[0] as { id: string }).id;

    await repos.saveRepoBriefAnalysis(id, analysis);
    expect(await repos.getRepoBrief(scanId, 0)).toMatchObject({ state: "generating", stage: "writing" });
    expect(await repos.getRepoBriefAnalysis(id)).toEqual(analysis);

    await repos.completeRepoBrief(id, pkg);
    await repos.completeRepoBrief(id, pkg); // a second completion is a no-op
    expect(await repos.getRepoBrief(scanId, 0)).toEqual({ state: "ready", id, repository: "bob/app", analysis, package: pkg });
    const events = await sql.query(`select event_type, card_index from scan_events where scan_job_id = $1 and event_type = 'repo_brief_generated'`, [scanId]);
    expect(events.rows).toEqual([{ event_type: "repo_brief_generated", card_index: 0 }]);
    // Ready: asking again returns it, no new generation.
    expect(await claim()).toMatchObject({ outcome: "existing", state: { state: "ready" } });
  });

  it("retries a failure up to the cap, reusing a stored analysis, then says it can't be retried", async () => {
    const { scanId, claim } = await setup();
    const first = await claim();
    if (first.outcome !== "start") throw new Error("expected start");
    await repos.saveRepoBriefAnalysis(first.id, analysis);
    await repos.failRepoBrief(first.id, "Gauntlet couldn't write a valid repo-aware brief this time. Please try again.");
    expect(await repos.getRepoBrief(scanId, 0)).toMatchObject({ state: "failed", canRetry: true });

    expect(await claim()).toEqual({ outcome: "start", id: first.id, reuseAnalysis: true });
    expect(await repos.getRepoBrief(scanId, 0)).toMatchObject({ state: "generating", stage: "writing" });
    await repos.failRepoBrief(first.id, "boom");
    expect(await claim()).toEqual({ outcome: "start", id: first.id, reuseAnalysis: true });
    await repos.failRepoBrief(first.id, "boom");
    const final = await claim();
    expect(final).toMatchObject({ outcome: "existing", state: { state: "failed", canRetry: false } });
    if (final.outcome === "existing" && final.state.state === "failed") expect(final.state.errorMessage).toContain("after 3 tries");
  });

  it("treats a generation stuck past the limit as failed and retryable", async () => {
    const { scanId, claim } = await setup();
    const first = await claim();
    if (first.outcome !== "start") throw new Error("expected start");
    await sql.query(`update repo_briefs set updated_at = now() - interval '11 minutes' where id = $1`, [first.id]);
    expect(await repos.getRepoBrief(scanId, 0)).toMatchObject({ state: "failed", canRetry: true, errorMessage: expect.stringContaining("took too long") });
    expect(await claim()).toEqual({ outcome: "start", id: first.id, reuseAnalysis: false });
  });

  it("limits new briefs per account, but not retries", async () => {
    const owner = "dddddddd-0000-4000-8000-0000000000d4";
    const { claim } = await setup(owner);
    const limits = { perClient: 2, global: 500 };
    expect((await claim(0, limits)).outcome).toBe("start");
    expect((await claim(1, limits)).outcome).toBe("start");
    const denied = await claim(2, limits);
    expect(denied).toMatchObject({ outcome: "denied", denial: { scope: "client" } });
    if (denied.outcome === "denied") expect(denied.denial.message).toContain("repo-aware brief limit");
  });

  it("enforces the contract in the database: a ready brief has both its analysis and package", async () => {
    const { scanId, claim } = await setup();
    const first = await claim();
    if (first.outcome !== "start") throw new Error("expected start");
    // Completing without an analysis does nothing (and the constraint would refuse it anyway).
    await repos.completeRepoBrief(first.id, pkg);
    expect((await repos.getRepoBrief(scanId, 0)).state).toBe("generating");
    await expect(sql.query(`update repo_briefs set status = 'ready', package = '{}' where id = $1`, [first.id])).rejects.toThrow(/repo_briefs_ready_has_analysis/);
    await expect(
      sql.query(`insert into scan_events (scan_job_id, event_type) values ($1, 'repo_brief_generated')`, [scanId]),
    ).rejects.toThrow(/scan_events_card_only_on_card_events/);
    await sql.query(`insert into scan_events (scan_job_id, event_type) values ($1, 'github_connected')`, [scanId]);
  });

  it("goes away with its scan and its workspace", async () => {
    const { scanId, workspaceId, claim } = await setup();
    await claim();
    await sql.query(`delete from scan_jobs where id = $1`, [scanId]);
    expect((await sql.query(`select count(*)::int as n from repo_briefs where workspace_id = $1`, [workspaceId])).rows[0].n).toBe(0);
  });
});
