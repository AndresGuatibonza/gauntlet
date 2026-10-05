/**
 * Data access for the GitHub deep scan (migration 008): what each user may
 * read on GitHub, the repository connected to each workspace, and the
 * private repo-aware briefs. Kept apart from store.ts (public reports,
 * accounts) on purpose: everything here is authenticated evidence (PRD §8.6
 * "separate public evidence from authenticated evidence in storage").
 */
import type { ActionPackage, RepoAnalysis } from "@gauntlet/core";
import { getPool } from "./db.js";
import { evaluateScanQuota, QUOTA_WINDOW_SECONDS, type QuotaDenial, type ScanLimits } from "./rate-limit.js";
import type { AccessibleRepository, UserInstallation } from "./github-app.js";

// ---------------------------------------------------------------------------
// Access, as proven at connection
// ---------------------------------------------------------------------------

/**
 * Replaces the user's installations and accessible repositories with what
 * GitHub just reported for them: access removed on GitHub disappears here.
 * A workspace connected to a repository the user can no longer read keeps
 * its link until the next deep scan fails (GitHub is the authority; the
 * installation token is refused) or the user disconnects it.
 */
export async function saveUserGitHubAccess(
  userId: string,
  installations: readonly UserInstallation[],
  repositories: readonly AccessibleRepository[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`delete from github_installations where owner_user_id = $1`, [userId]);
    for (const i of installations) {
      await client.query(
        `insert into github_installations (owner_user_id, installation_id, account_login, account_type) values ($1, $2, $3, $4)`,
        [userId, i.installationId, i.accountLogin, i.accountType],
      );
    }
    const known = new Set(installations.map((i) => i.installationId));
    for (const r of repositories) {
      if (!known.has(r.installationId)) continue;
      await client.query(
        `insert into github_repository_access (owner_user_id, installation_id, repository_id, full_name, default_branch, private)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (owner_user_id, repository_id) do update
           set installation_id = excluded.installation_id, full_name = excluded.full_name,
               default_branch = excluded.default_branch, private = excluded.private`,
        [userId, r.installationId, r.repositoryId, r.fullName, r.defaultBranch, r.private],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listAccessibleRepositories(userId: string): Promise<AccessibleRepository[]> {
  const result = await getPool().query<{
    installation_id: string;
    repository_id: string;
    full_name: string;
    default_branch: string;
    private: boolean;
  }>(
    `select installation_id, repository_id, full_name, default_branch, private
       from github_repository_access where owner_user_id = $1 order by lower(full_name)`,
    [userId],
  );
  return result.rows.map((r) => ({
    installationId: Number(r.installation_id),
    repositoryId: Number(r.repository_id),
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

// ---------------------------------------------------------------------------
// The repository connected to a workspace
// ---------------------------------------------------------------------------

export interface ScanWorkspace {
  workspaceId: string;
  ownerUserId: string;
}

/** The workspace a scan was saved to, with its owner; null for anonymous or unknown scans. */
export async function getScanWorkspace(scanJobId: string): Promise<ScanWorkspace | null> {
  const result = await getPool().query<{ workspace_id: string; owner_user_id: string }>(
    `select w.id as workspace_id, w.owner_user_id from scan_jobs s join workspaces w on w.id = s.workspace_id where s.id = $1`,
    [scanJobId],
  );
  const row = result.rows[0];
  return row ? { workspaceId: row.workspace_id, ownerUserId: row.owner_user_id } : null;
}

export interface WorkspaceRepository {
  installationId: number;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  connectedAt: string;
}

export async function getWorkspaceRepository(workspaceId: string): Promise<WorkspaceRepository | null> {
  const result = await getPool().query<{
    installation_id: string;
    repository_id: string;
    full_name: string;
    default_branch: string;
    connected_at: Date;
  }>(`select installation_id, repository_id, full_name, default_branch, connected_at from workspace_repositories where workspace_id = $1`, [workspaceId]);
  const r = result.rows[0];
  return r
    ? {
        installationId: Number(r.installation_id),
        repositoryId: Number(r.repository_id),
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        connectedAt: r.connected_at.toISOString(),
      }
    : null;
}

export type ConnectRepositoryResult = { outcome: "connected"; repository: WorkspaceRepository } | { outcome: "not_accessible" };

/**
 * Connects one of the user's accessible repositories to the workspace.
 * Switching to another repository deletes the briefs written from the
 * previous one: code evidence belongs to the connection that produced it.
 */
export async function connectWorkspaceRepository(workspaceId: string, userId: string, repositoryId: number): Promise<ConnectRepositoryResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const access = (
      await client.query<{ installation_id: string; full_name: string; default_branch: string }>(
        `select installation_id, full_name, default_branch from github_repository_access where owner_user_id = $1 and repository_id = $2`,
        [userId, repositoryId],
      )
    ).rows[0];
    if (!access) {
      await client.query("rollback");
      return { outcome: "not_accessible" };
    }
    await client.query(`delete from repo_briefs where workspace_id = $1 and repository_id <> $2`, [workspaceId, repositoryId]);
    const saved = await client.query<{ connected_at: Date }>(
      `insert into workspace_repositories (workspace_id, installation_id, repository_id, full_name, default_branch, connected_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (workspace_id) do update
         set installation_id = excluded.installation_id, repository_id = excluded.repository_id, full_name = excluded.full_name,
             default_branch = excluded.default_branch, connected_by = excluded.connected_by,
             connected_at = case when workspace_repositories.repository_id = excluded.repository_id
                                 then workspace_repositories.connected_at else now() end
       returning connected_at`,
      [workspaceId, access.installation_id, repositoryId, access.full_name, access.default_branch, userId],
    );
    await client.query("commit");
    return {
      outcome: "connected",
      repository: {
        installationId: Number(access.installation_id),
        repositoryId,
        fullName: access.full_name,
        defaultBranch: access.default_branch,
        connectedAt: saved.rows[0]!.connected_at.toISOString(),
      },
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Disconnects the workspace's repository and deletes every brief written from it. */
export async function disconnectWorkspaceRepository(workspaceId: string): Promise<{ disconnected: boolean; briefsDeleted: number }> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const briefs = await client.query(`delete from repo_briefs where workspace_id = $1`, [workspaceId]);
    const link = await client.query(`delete from workspace_repositories where workspace_id = $1`, [workspaceId]);
    await client.query("commit");
    return { disconnected: (link.rowCount ?? 0) > 0, briefsDeleted: briefs.rowCount ?? 0 };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Repo-aware briefs
// ---------------------------------------------------------------------------

/** Reading the repository and writing the package run inside one 300 s function. */
export const STALE_REPO_BRIEF_MINUTES = 10;
export const MAX_REPO_BRIEF_ATTEMPTS = 3;
const REPO_BRIEF_LOCK_KEY = 7254004; // distinct from 7254001 (scans), 7254002 (migrations), 7254003 (packages)

export type RepoBriefState =
  | { state: "ready"; id: string; repository: string; analysis: RepoAnalysis; package: ActionPackage }
  | { state: "generating"; id: string; repository: string; stage: "reading" | "writing" }
  | { state: "failed"; id: string; repository: string; errorMessage: string; canRetry: boolean }
  | { state: "none" };

interface RepoBriefRow {
  id: string;
  status: "generating" | "ready" | "failed";
  stage: "reading" | "writing" | null;
  repository_id: string;
  full_name: string;
  analysis: RepoAnalysis | null;
  package: ActionPackage | null;
  error_message: string | null;
  attempts: number;
  stale: boolean;
}

function rowToState(row: RepoBriefRow): Exclude<RepoBriefState, { state: "none" }> {
  if (row.status === "ready" && row.package && row.analysis) {
    return { state: "ready", id: row.id, repository: row.full_name, analysis: row.analysis, package: row.package };
  }
  if (row.status === "generating" && !row.stale) return { state: "generating", id: row.id, repository: row.full_name, stage: row.stage ?? "reading" };
  const canRetry = row.attempts < MAX_REPO_BRIEF_ATTEMPTS;
  const errorMessage = !canRetry
    ? `Gauntlet couldn't write this repo-aware brief after ${row.attempts} tries, so it can't be retried for this opportunity.`
    : row.status === "generating"
      ? "Reading the repository and writing the brief took too long and was stopped."
      : (row.error_message ?? "Writing the repo-aware brief failed.");
  return { state: "failed", id: row.id, repository: row.full_name, errorMessage, canRetry };
}

const BRIEF_ROW_SQL = `select id, status, stage, repository_id, full_name, analysis, package, error_message, attempts,
  (status = 'generating' and updated_at < now() - make_interval(mins => ${STALE_REPO_BRIEF_MINUTES})) as stale
  from repo_briefs where scan_job_id = $1 and card_index = $2`;

export async function getRepoBrief(scanJobId: string, cardIndex: number): Promise<RepoBriefState> {
  const row = (await getPool().query<RepoBriefRow>(BRIEF_ROW_SQL, [scanJobId, cardIndex])).rows[0];
  return row ? rowToState(row) : { state: "none" };
}

/** The stored analysis of a brief, for a retry that only needs to rewrite the package. */
export async function getRepoBriefAnalysis(id: string): Promise<RepoAnalysis | null> {
  const row = (await getPool().query<{ analysis: RepoAnalysis | null }>(`select analysis from repo_briefs where id = $1`, [id])).rows[0];
  return row?.analysis ?? null;
}

const QUOTA_SQL = `
  with win as (select now() - make_interval(secs => $4) as since)
  select
    now() as now,
    (select count(*)::int from repo_briefs, win where requested_by = $1 and created_at > win.since) as client_count,
    (select created_at from repo_briefs, win where requested_by = $1 and created_at > win.since
      order by created_at desc offset ($2::int - 1) limit 1) as client_slot_frees_from,
    (select count(*)::int from repo_briefs, win where created_at > win.since) as global_count,
    (select created_at from repo_briefs, win where created_at > win.since
      order by created_at desc offset ($3::int - 1) limit 1) as global_slot_frees_from`;

export type ClaimRepoBriefResult =
  | { outcome: "start"; id: string; reuseAnalysis: boolean }
  | { outcome: "existing"; state: Exclude<RepoBriefState, { state: "none" }> }
  | { outcome: "denied"; denial: QuotaDenial };

/**
 * Decides, atomically, whether to start a repo-aware brief for a card:
 * - ready (for the connected repository) or in progress: returned as is;
 * - failed: restarted while attempts remain, reusing a stored analysis;
 * - none, or written from a different repository: a new one, within the
 *   per-account quota (it reads the repository and calls Claude again).
 */
export async function claimRepoBrief(input: {
  scanJobId: string;
  cardIndex: number;
  workspaceId: string;
  repository: Pick<WorkspaceRepository, "repositoryId" | "fullName">;
  userId: string;
  limits: ScanLimits;
}): Promise<ClaimRepoBriefResult> {
  const { scanJobId, cardIndex, workspaceId, repository, userId, limits } = input;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [REPO_BRIEF_LOCK_KEY]);

    const existing = (await client.query<RepoBriefRow>(BRIEF_ROW_SQL, [scanJobId, cardIndex])).rows[0];
    const sameRepository = existing && Number(existing.repository_id) === repository.repositoryId;
    if (existing && sameRepository) {
      const state = rowToState(existing);
      if (state.state === "failed" && state.canRetry) {
        await client.query(
          `update repo_briefs set status = 'generating', stage = case when analysis is null then 'reading' else 'writing' end,
             error_message = null, attempts = attempts + 1, requested_by = $2, updated_at = now() where id = $1`,
          [existing.id, userId],
        );
        await client.query("commit");
        return { outcome: "start", id: existing.id, reuseAnalysis: existing.analysis !== null };
      }
      await client.query("commit");
      return { outcome: "existing", state };
    }

    const usage = (
      await client.query<{
        now: Date;
        client_count: number;
        client_slot_frees_from: Date | null;
        global_count: number;
        global_slot_frees_from: Date | null;
      }>(QUOTA_SQL, [userId, limits.perClient, limits.global, QUOTA_WINDOW_SECONDS])
    ).rows[0];
    if (!usage) throw new Error("claimRepoBrief: quota usage query returned no row");
    const decision = evaluateScanQuota({
      client: { count: usage.client_count, slotFreesFromCreatedAt: usage.client_slot_frees_from },
      global: { count: usage.global_count, slotFreesFromCreatedAt: usage.global_slot_frees_from },
      limits,
      now: usage.now,
      noun: "repo-aware brief",
    });
    if (!decision.allowed) {
      await client.query("rollback");
      return { outcome: "denied", denial: decision };
    }
    if (existing) await client.query(`delete from repo_briefs where id = $1`, [existing.id]);
    const inserted = await client.query<{ id: string }>(
      `insert into repo_briefs (scan_job_id, card_index, workspace_id, repository_id, full_name, status, stage, requested_by)
       values ($1, $2, $3, $4, $5, 'generating', 'reading', $6) returning id`,
      [scanJobId, cardIndex, workspaceId, repository.repositoryId, repository.fullName, userId],
    );
    await client.query("commit");
    return { outcome: "start", id: inserted.rows[0]!.id, reuseAnalysis: false };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Keeps the analysis as soon as it exists, and moves on to writing the package. */
export async function saveRepoBriefAnalysis(id: string, analysis: RepoAnalysis): Promise<void> {
  await getPool().query(
    `update repo_briefs set analysis = $2, stage = 'writing', updated_at = now() where id = $1 and status = 'generating'`,
    [id, JSON.stringify(analysis)],
  );
}

/** Stores the repo-aware package and records repo_brief_generated, in one transaction. */
export async function completeRepoBrief(id: string, pkg: ActionPackage): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const updated = await client.query<{ scan_job_id: string; card_index: number }>(
      `update repo_briefs set status = 'ready', stage = null, package = $2, error_message = null, updated_at = now()
        where id = $1 and status <> 'ready' and analysis is not null returning scan_job_id, card_index`,
      [id, JSON.stringify(pkg)],
    );
    const target = updated.rows[0];
    if (!target) {
      await client.query("rollback");
      return; // completed by an earlier run, or deleted by a disconnect meanwhile
    }
    await client.query(
      `insert into scan_events (scan_job_id, event_type, card_index) values ($1, 'repo_brief_generated', $2) on conflict do nothing`,
      [target.scan_job_id, target.card_index],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function failRepoBrief(id: string, errorMessage: string): Promise<void> {
  await getPool().query(
    `update repo_briefs set status = 'failed', stage = null, error_message = $2, updated_at = now() where id = $1 and status = 'generating'`,
    [id, errorMessage],
  );
}
