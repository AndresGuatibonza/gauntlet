/**
 * scan_jobs data access. Mirrors the CLI's store.ts pattern (a small
 * typed interface over the raw driver) but against Postgres/jsonb instead
 * of SQLite -- see lib/migrations/001_init.sql for why this is one table,
 * not the CLI's normalized three.
 */
import {
  ExperimentRecordSchema,
  type ActionPackage,
  type EvidencePacket,
  type ExperimentRecord,
  type OpportunityReport,
  type ReviewRecord,
} from "@gauntlet/core";
import { getPool } from "./db.js";
import { evaluateScanQuota, QUOTA_WINDOW_SECONDS, type QuotaDenial, type ScanLimits } from "./rate-limit.js";
import type { CardRating, ScanEventType } from "./events.js";
import type { ScanProgress } from "./progress.js";
import { canonicalProductUrl, claimTokenMatches } from "./accounts.js";

export type ScanJobStatus = "queued" | "scanning" | "analyzing" | "reviewing" | "done" | "failed";

export interface ScanJob {
  id: string;
  url: string;
  category: "ai_tool" | "ai_saas";
  status: ScanJobStatus;
  evidencePacket: EvidencePacket | null;
  opportunityReport: OpportunityReport | null;
  reviewRecords: ReviewRecord[] | null;
  errorMessage: string | null;
  /** Latest progress line (migration 005); null before it exists or when none was written. */
  progress: ScanProgress | null;
  createdAt: string;
  updatedAt: string;
}

interface ScanJobRow {
  id: string;
  url: string;
  category: string;
  status: string;
  evidence_packet: EvidencePacket | null;
  opportunity_report: OpportunityReport | null;
  review_records: ReviewRecord[] | null;
  error_message: string | null;
  // Absent (undefined) until migration 005 is applied.
  progress?: ScanProgress | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: ScanJobRow): ScanJob {
  return {
    id: row.id,
    url: row.url,
    category: row.category as ScanJob["category"],
    status: row.status as ScanJobStatus,
    evidencePacket: row.evidence_packet,
    opportunityReport: row.opportunity_report,
    reviewRecords: row.review_records,
    errorMessage: row.error_message,
    progress: row.progress ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads both quota scopes and, only if both allow it, inserts the job --
 * all inside ONE transaction holding a transaction-scoped advisory lock,
 * so two concurrent requests can't both read "2 of 3 used" and both
 * insert. The lock serializes scan creation globally, which is fine at
 * this volume (the global quota itself is ~20/day) and is released
 * automatically at commit/rollback -- compatible with Supabase's
 * transaction-mode pooler, which pins one server connection for the
 * duration of a transaction.
 *
 * All time math uses the database's now(), not the function instance's
 * clock, so the window can't drift between Vercel and Postgres.
 */
const SCAN_QUOTA_LOCK_KEY = 7254001; // arbitrary, only needs to be unique within this database

/**
 * Rolling-window usage of one quota-bearing table: per-client count, global
 * count, and when a slot frees in each. The table name is a closed union,
 * never user input.
 */
function quotaUsageSql(table: "scan_jobs" | "action_packages"): string {
  return `
  with win as (select now() - make_interval(secs => $4) as since)
  select
    now() as now,
    (select count(*)::int from ${table}, win
      where client_ip_hash = $1 and created_at > win.since) as client_count,
    (select created_at from ${table}, win
      where client_ip_hash = $1 and created_at > win.since
      order by created_at desc offset ($2::int - 1) limit 1) as client_slot_frees_from,
    (select count(*)::int from ${table}, win
      where created_at > win.since) as global_count,
    (select created_at from ${table}, win
      where created_at > win.since
      order by created_at desc offset ($3::int - 1) limit 1) as global_slot_frees_from
`;
}

interface QuotaUsageRow {
  now: Date;
  client_count: number;
  client_slot_frees_from: Date | null;
  global_count: number;
  global_slot_frees_from: Date | null;
}

export type CreateScanJobResult = { ok: true; id: string } | { ok: false; denial: QuotaDenial };

/** Creates a job in "queued" state if the client and global quotas allow it. */
export async function createScanJobWithinQuota(
  url: string,
  category: "ai_tool" | "ai_saas",
  clientIpHash: string,
  limits: ScanLimits,
  /** SHA-256 of the claim token handed to the browser (lib/accounts.ts). */
  claimTokenHash: string | null = null,
): Promise<CreateScanJobResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [SCAN_QUOTA_LOCK_KEY]);

    const usage = await client.query<QuotaUsageRow>(quotaUsageSql("scan_jobs"), [
      clientIpHash,
      limits.perClient,
      limits.global,
      QUOTA_WINDOW_SECONDS,
    ]);
    const row = usage.rows[0];
    if (!row) {
      // Unreachable: a SELECT with no FROM always returns exactly one row.
      throw new Error("createScanJobWithinQuota: quota usage query returned no row");
    }

    const decision = evaluateScanQuota({
      client: { count: row.client_count, slotFreesFromCreatedAt: row.client_slot_frees_from },
      global: { count: row.global_count, slotFreesFromCreatedAt: row.global_slot_frees_from },
      limits,
      now: row.now,
    });
    if (!decision.allowed) {
      await client.query("rollback");
      return { ok: false, denial: decision };
    }

    const inserted = await client.query<{ id: string }>(
      `insert into scan_jobs (url, category, status, client_ip_hash, claim_token_hash)
       values ($1, $2, 'queued', $3, $4) returning id`,
      [url, category, clientIpHash, claimTokenHash],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      // Same "never assume" guard the previous createScanJob had.
      throw new Error("createScanJobWithinQuota: insert returned no id");
    }
    // Funnel event, in the same transaction as the job: a scan can never
    // exist without its scan_started row, or vice versa.
    await client.query(
      `insert into scan_events (scan_job_id, event_type, client_ip_hash) values ($1, 'scan_started', $2)`,
      [id, clientIpHash],
    );
    await client.query("commit");
    return { ok: true, id };
  } catch (err) {
    await client.query("rollback").catch(() => {
      // The original error is the one worth surfacing.
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function getScanJob(id: string): Promise<ScanJob | null> {
  const result = await getPool().query<ScanJobRow>(`select * from scan_jobs where id = $1`, [id]);
  const row = result.rows[0];
  return row ? rowToJob(row) : null;
}

/**
 * Partial update -- only the columns present in `fields` are touched, so a
 * status-only update (e.g. "scanning" -> "analyzing") never has to resend
 * the evidence packet it already wrote. updated_at is always bumped.
 */
export async function updateScanJob(
  id: string,
  fields: Partial<{
    status: ScanJobStatus;
    evidencePacket: EvidencePacket;
    opportunityReport: OpportunityReport;
    reviewRecords: ReviewRecord[];
    errorMessage: string;
  }>,
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (fields.status !== undefined) {
    setClauses.push(`status = $${i++}`);
    values.push(fields.status);
  }
  if (fields.evidencePacket !== undefined) {
    setClauses.push(`evidence_packet = $${i++}`);
    values.push(JSON.stringify(fields.evidencePacket));
  }
  if (fields.opportunityReport !== undefined) {
    setClauses.push(`opportunity_report = $${i++}`);
    values.push(JSON.stringify(fields.opportunityReport));
  }
  if (fields.reviewRecords !== undefined) {
    setClauses.push(`review_records = $${i++}`);
    values.push(JSON.stringify(fields.reviewRecords));
  }
  if (fields.errorMessage !== undefined) {
    setClauses.push(`error_message = $${i++}`);
    values.push(fields.errorMessage);
  }
  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = now()`);
  values.push(id);
  await getPool().query(`update scan_jobs set ${setClauses.join(", ")} where id = $${i}`, values);
}

/**
 * Writes the progress line only -- deliberately separate from
 * updateScanJob, so a missing `progress` column (migration 005 not yet
 * applied) can only fail this best-effort write, never a status change.
 * Does not bump updated_at: progress is display data, not a job change.
 */
export async function setScanProgress(id: string, progress: ScanProgress): Promise<void> {
  await getPool().query(`update scan_jobs set progress = $1 where id = $2`, [JSON.stringify(progress), id]);
}

export interface ScanEventInput {
  scanJobId: string;
  type: ScanEventType;
  cardIndex?: number;
  cardTitle?: string | null;
  rating?: CardRating;
  clientIpHash?: string | null;
}

/**
 * Records one funnel event (migrations/003_scan_events.sql). Idempotent
 * per (scan, type, card, client) via scan_events_dedupe_idx: a repeated
 * event is a no-op, except feedback, where the latest rating replaces the
 * earlier one -- a changed mind is one vote, not two.
 */
export async function recordScanEvent(event: ScanEventInput): Promise<void> {
  const onConflict =
    event.type === "opportunity_feedback_submitted"
      ? "do update set rating = excluded.rating, card_title = excluded.card_title, updated_at = now()"
      : "do nothing";
  await getPool().query(
    `insert into scan_events (scan_job_id, event_type, card_index, card_title, rating, client_ip_hash)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (scan_job_id, event_type, (coalesce(card_index, -1)), (coalesce(client_ip_hash, '')))
     ${onConflict}`,
    [
      event.scanJobId,
      event.type,
      event.cardIndex ?? null,
      event.cardTitle ?? null,
      event.rating ?? null,
      event.clientIpHash ?? null,
    ],
  );
}

/**
 * A job still "in flight" this long after it was created can't finish:
 * the pipeline runs inside one function invocation, capped at
 * maxDuration (300 s, app/api/scans/route.ts). If the platform killed it
 * mid-scan, nothing would ever write a final status and the report page
 * would poll forever. 10 minutes leaves a wide margin over 300 s.
 */
export const STALE_JOB_MINUTES = 10;

export const STALE_JOB_MESSAGE =
  "The scan stopped before it could finish (it ran past the time limit). Nothing was charged to you -- please try again.";

/**
 * Marks timed-out in-flight jobs as failed and records scan_failed for
 * them, in one statement. With `jobId`, only that job (used by the polling
 * endpoint, so a stuck scan ends the next time anyone looks at it); without,
 * every stale job (the daily maintenance run). Returns the ids it failed.
 */
export async function expireStaleJobs(jobId?: string): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `with expired as (
       update scan_jobs
          set status = 'failed', error_message = $1, updated_at = now()
        where status in ('queued', 'scanning', 'analyzing', 'reviewing')
          and created_at < now() - make_interval(mins => $2)
          and ($3::uuid is null or id = $3::uuid)
        returning id
     ), events as (
       insert into scan_events (scan_job_id, event_type)
       select id, 'scan_failed' from expired
       on conflict do nothing
     )
     select id from expired`,
    [STALE_JOB_MESSAGE, STALE_JOB_MINUTES, jobId ?? null],
  );
  return result.rows.map((r) => r.id);
}

export interface RetentionPolicy {
  /** Whole scans (and, by cascade, their events) older than this are deleted. */
  retentionDays: number;
  /** The quota only looks back 24 h; client IP hashes are cleared after this. */
  ipHashHours: number;
}

/**
 * Data retention (PRD §18 open question; policy in TECHNICAL_OVERVIEW.md). One
 * transaction: clear client IP hashes on scan_jobs and action_packages once
 * their quotas no longer need them, then delete scans past the retention
 * period (packages and ledger records cascade with them). scan_events rows
 * go with their scan (on delete cascade); their own client hash is kept
 * until then because it is part of the per-client dedupe key.
 */
export async function purgeExpiredData(policy: RetentionPolicy): Promise<{ ipHashesCleared: number; scansDeleted: number }> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const cleared = await client.query(
      `update scan_jobs set client_ip_hash = null
        where client_ip_hash is not null and created_at < now() - make_interval(hours => $1)`,
      [policy.ipHashHours],
    );
    const clearedPackages = await client.query(
      `update action_packages set client_ip_hash = null
        where client_ip_hash is not null and created_at < now() - make_interval(hours => $1)`,
      [policy.ipHashHours],
    );
    // Anonymous scans only: a scan saved to an account's workspace is kept.
    const deleted = await client.query(
      `delete from scan_jobs where workspace_id is null and created_at < now() - make_interval(days => $1)`,
      [
      policy.retentionDays,
    ]);
    await client.query("commit");
    return { ipHashesCleared: (cleared.rowCount ?? 0) + (clearedPackages.rowCount ?? 0), scansDeleted: deleted.rowCount ?? 0 };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// "Build this" implementation packages + Experiment Ledger (migration 006)
// ---------------------------------------------------------------------------

/** Generation is one Claude call (+1 corrective retry) inside a 300 s function. */
export const STALE_PACKAGE_MINUTES = 10;
export const MAX_PACKAGE_ATTEMPTS = 3;
const PACKAGE_LOCK_KEY = 7254003; // distinct from the scan quota (7254001) and migrations (7254002)

export type ActionPackageState =
  | { state: "ready"; id: string; package: ActionPackage }
  | { state: "generating"; id: string }
  | { state: "failed"; id: string; errorMessage: string; canRetry: boolean }
  | { state: "none" };

interface ActionPackageRow {
  id: string;
  status: "generating" | "ready" | "failed";
  package: ActionPackage | null;
  error_message: string | null;
  attempts: number;
  stale: boolean;
}

function rowToPackageState(row: ActionPackageRow): ActionPackageState {
  if (row.status === "ready" && row.package) return { state: "ready", id: row.id, package: row.package };
  if (row.status === "generating" && !row.stale) return { state: "generating", id: row.id };
  const canRetry = row.attempts < MAX_PACKAGE_ATTEMPTS;
  // The stored message invites a retry; once none are left, say so instead.
  const errorMessage = !canRetry
    ? `Gauntlet couldn't write this implementation brief after ${row.attempts} tries, so this opportunity can't be retried. Try Build this on another opportunity.`
    : row.status === "generating"
      ? "Writing the implementation brief took too long and was stopped."
      : (row.error_message ?? "Writing the implementation brief failed.");
  return { state: "failed", id: row.id, errorMessage, canRetry };
}

const PACKAGE_ROW_SQL = `select id, status, package, error_message, attempts,
  (status = 'generating' and updated_at < now() - make_interval(mins => ${STALE_PACKAGE_MINUTES})) as stale
  from action_packages where scan_job_id = $1 and card_index = $2`;

export async function getActionPackage(scanJobId: string, cardIndex: number): Promise<ActionPackageState> {
  const result = await getPool().query<ActionPackageRow>(PACKAGE_ROW_SQL, [scanJobId, cardIndex]);
  const row = result.rows[0];
  return row ? rowToPackageState(row) : { state: "none" };
}

export type ClaimActionPackageResult =
  | { outcome: "start"; id: string }
  | { outcome: "existing"; state: Exclude<ActionPackageState, { state: "none" }> }
  | { outcome: "denied"; denial: QuotaDenial };

/**
 * Decides, atomically, whether this request should start a generation:
 * - a ready or in-progress package is returned as is (no second Claude call);
 * - a failed (or timed-out) one is restarted while attempts remain;
 * - a new one must fit the package quota, then is inserted as "generating".
 * One transaction under an advisory lock, so concurrent clicks resolve to
 * exactly one generation and the quota can't be overrun.
 */
export async function claimActionPackage(
  scanJobId: string,
  cardIndex: number,
  clientIpHash: string,
  limits: ScanLimits,
): Promise<ClaimActionPackageResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [PACKAGE_LOCK_KEY]);

    const existing = (await client.query<ActionPackageRow>(PACKAGE_ROW_SQL, [scanJobId, cardIndex])).rows[0];
    if (existing) {
      const state = rowToPackageState(existing);
      if (state.state === "failed" && state.canRetry) {
        await client.query(
          `update action_packages set status = 'generating', error_message = null, attempts = attempts + 1, updated_at = now()
            where id = $1`,
          [existing.id],
        );
        await client.query("commit");
        return { outcome: "start", id: existing.id };
      }
      await client.query("commit");
      return { outcome: "existing", state: state as Exclude<ActionPackageState, { state: "none" }> };
    }

    const usage = await client.query<QuotaUsageRow>(quotaUsageSql("action_packages"), [
      clientIpHash,
      limits.perClient,
      limits.global,
      QUOTA_WINDOW_SECONDS,
    ]);
    const row = usage.rows[0];
    if (!row) throw new Error("claimActionPackage: quota usage query returned no row");
    const decision = evaluateScanQuota({
      client: { count: row.client_count, slotFreesFromCreatedAt: row.client_slot_frees_from },
      global: { count: row.global_count, slotFreesFromCreatedAt: row.global_slot_frees_from },
      limits,
      now: row.now,
      noun: "implementation brief",
    });
    if (!decision.allowed) {
      await client.query("rollback");
      return { outcome: "denied", denial: decision };
    }
    const inserted = await client.query<{ id: string }>(
      `insert into action_packages (scan_job_id, card_index, status, client_ip_hash) values ($1, $2, 'generating', $3) returning id`,
      [scanJobId, cardIndex, clientIpHash],
    );
    await client.query("commit");
    return { outcome: "start", id: inserted.rows[0]!.id };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stores a generated package and starts its Experiment Ledger record, with
 * both PRD §11 events, in one transaction. Accepts a row that was marked
 * failed for taking too long: the work finished and is valid.
 */
export async function completeActionPackage(
  id: string,
  pkg: ActionPackage,
  record: ExperimentRecord,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const updated = await client.query<{ scan_job_id: string; card_index: number }>(
      `update action_packages set status = 'ready', package = $2, error_message = null, updated_at = now()
        where id = $1 and status <> 'ready' returning scan_job_id, card_index`,
      [id, JSON.stringify(pkg)],
    );
    const target = updated.rows[0];
    if (!target) {
      await client.query("rollback");
      return; // already completed by an earlier run
    }
    await client.query(
      `insert into experiment_records
         (scan_job_id, card_index, action_package_id, status, hypothesis, evidence_snapshot, change, experiment)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (action_package_id) do nothing`,
      [
        target.scan_job_id,
        target.card_index,
        id,
        record.status,
        record.hypothesis,
        JSON.stringify(record.evidenceSnapshot),
        JSON.stringify(record.change),
        JSON.stringify(record.experiment),
      ],
    );
    await client.query(
      `insert into scan_events (scan_job_id, event_type, card_index)
       values ($1, 'action_package_generated', $2), ($1, 'experiment_created', $2)
       on conflict do nothing`,
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

export async function failActionPackage(id: string, errorMessage: string): Promise<void> {
  await getPool().query(
    `update action_packages set status = 'failed', error_message = $2, updated_at = now() where id = $1 and status = 'generating'`,
    [id, errorMessage],
  );
}

// ---------------------------------------------------------------------------
// Accounts: workspaces, claiming scans, the web Experiment Ledger (migration 007)
// ---------------------------------------------------------------------------

export type ClaimScanResult =
  | { outcome: "claimed" | "already_yours"; workspaceId: string }
  | { outcome: "not_found" | "invalid_token" | "claimed_by_other" };

/**
 * Saves a scan to the user's workspace for that product (created on first
 * use). Requires the scan's claim token, so only the browser that started
 * the scan can claim it. Idempotent for the same user.
 */
export async function claimScan(scanJobId: string, token: string, userId: string): Promise<ClaimScanResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const scan = (
      await client.query<{ url: string; claim_token_hash: string | null; workspace_id: string | null; evidence_packet: EvidencePacket | null }>(
        `select url, claim_token_hash, workspace_id, evidence_packet from scan_jobs where id = $1 for update`,
        [scanJobId],
      )
    ).rows[0];
    if (!scan) {
      await client.query("rollback");
      return { outcome: "not_found" };
    }
    if (!claimTokenMatches(token, scan.claim_token_hash)) {
      await client.query("rollback");
      return { outcome: "invalid_token" };
    }
    if (scan.workspace_id) {
      const owner = (await client.query<{ owner_user_id: string }>(`select owner_user_id from workspaces where id = $1`, [scan.workspace_id]))
        .rows[0];
      await client.query("rollback");
      return owner?.owner_user_id === userId
        ? { outcome: "already_yours", workspaceId: scan.workspace_id }
        : { outcome: "claimed_by_other" };
    }
    const productUrl = canonicalProductUrl(scan.url);
    const productName = scan.evidence_packet?.productIdentity.productName ?? new URL(productUrl).hostname;
    const workspace = await client.query<{ id: string }>(
      `insert into workspaces (owner_user_id, product_url, product_name) values ($1, $2, $3)
       on conflict (owner_user_id, product_url) do update set product_name = excluded.product_name
       returning id`,
      [userId, productUrl, productName],
    );
    const workspaceId = workspace.rows[0]!.id;
    await client.query(`update scan_jobs set workspace_id = $2, claimed_at = now() where id = $1`, [scanJobId, workspaceId]);
    await client.query("commit");
    return { outcome: "claimed", workspaceId };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The account that owns a scan (through its workspace), or null when anonymous or unknown. */
export async function getScanOwner(scanJobId: string): Promise<string | null> {
  const result = await getPool().query<{ owner_user_id: string }>(
    `select w.owner_user_id from scan_jobs s join workspaces w on w.id = s.workspace_id where s.id = $1`,
    [scanJobId],
  );
  return result.rows[0]?.owner_user_id ?? null;
}

export interface StoredExperiment {
  id: string;
  scanJobId: string;
  cardIndex: number;
  record: ExperimentRecord;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExperimentRow {
  id: string;
  scan_job_id: string;
  card_index: number;
  status: ExperimentRecord["status"];
  hypothesis: string;
  evidence_snapshot: ExperimentRecord["evidenceSnapshot"];
  change: ExperimentRecord["change"];
  experiment: ExperimentRecord["experiment"];
  result: string | null;
  decision: ExperimentRecord["decision"];
  outcome: string | null;
  decided_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowToExperiment(row: ExperimentRow): StoredExperiment {
  return {
    id: row.id,
    scanJobId: row.scan_job_id,
    cardIndex: row.card_index,
    record: {
      hypothesis: row.hypothesis,
      evidenceSnapshot: row.evidence_snapshot,
      change: row.change,
      experiment: row.experiment,
      status: row.status,
      result: row.result,
      decision: row.decision,
      outcome: row.outcome,
    },
    decidedAt: iso(row.decided_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export async function getExperimentForCard(scanJobId: string, cardIndex: number): Promise<StoredExperiment | null> {
  const result = await getPool().query<ExperimentRow>(
    `select * from experiment_records where scan_job_id = $1 and card_index = $2`,
    [scanJobId, cardIndex],
  );
  return result.rows[0] ? rowToExperiment(result.rows[0]) : null;
}

/**
 * Writes the next state of an experiment, validated by the shared ledger
 * rules (the caller computed `next` from `previous` with
 * applyExperimentUpdate). Optimistic: the write only applies while the
 * stored status, decision and outcome still equal `previous`, so two tabs
 * can't record two decisions; otherwise it reports "conflict". Recording a decision also writes the
 * PRD §11 event experiment_decision_recorded, in the same transaction.
 */
export async function updateExperiment(
  id: string,
  previous: ExperimentRecord,
  next: ExperimentRecord,
  userId: string,
): Promise<{ outcome: "updated"; experiment: StoredExperiment } | { outcome: "conflict" }> {
  const record = ExperimentRecordSchema.parse(next);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const updated = await client.query<ExperimentRow>(
      `update experiment_records
          set status = $3, result = $4, decision = $5, outcome = $6, updated_at = now(),
              decided_at = case when $3 = 'decided' and decided_at is null then now() else decided_at end,
              decided_by = case when $3 = 'decided' and decided_by is null then $7::uuid else decided_by end
        where id = $1 and status = $2
          and decision is not distinct from $8 and outcome is not distinct from $9
        returning *`,
      [id, previous.status, record.status, record.result, record.decision, record.outcome, userId, previous.decision, previous.outcome],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("rollback");
      return { outcome: "conflict" };
    }
    if (record.status === "decided") {
      await client.query(
        `insert into scan_events (scan_job_id, event_type, card_index) values ($1, 'experiment_decision_recorded', $2)
         on conflict do nothing`,
        [row.scan_job_id, row.card_index],
      );
    }
    await client.query("commit");
    return { outcome: "updated", experiment: rowToExperiment(row) };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface LedgerEntry extends StoredExperiment {
  productName: string;
  productUrl: string;
  cardTitle: string;
}

/** Every experiment in the user's workspaces, newest first. */
export async function listExperimentsForUser(userId: string): Promise<LedgerEntry[]> {
  const result = await getPool().query<ExperimentRow & { product_name: string; product_url: string; card_title: string }>(
    `select e.*, w.product_name, w.product_url, p.package->'card'->>'title' as card_title
       from experiment_records e
       join scan_jobs s on s.id = e.scan_job_id
       join workspaces w on w.id = s.workspace_id
       join action_packages p on p.id = e.action_package_id
      where w.owner_user_id = $1
      order by e.created_at desc
      limit 200`,
    [userId],
  );
  return result.rows.map((r) => ({
    ...rowToExperiment(r),
    productName: r.product_name,
    productUrl: r.product_url,
    cardTitle: r.card_title,
  }));
}

export interface SavedReport {
  scanId: string;
  productName: string;
  productUrl: string;
  scannedAt: string;
  opportunityCount: number;
}

/** The finished reports saved to the user's workspaces, newest first: the way back to each one. */
export async function listSavedReportsForUser(userId: string): Promise<SavedReport[]> {
  const result = await getPool().query<{
    id: string;
    product_name: string;
    product_url: string;
    created_at: Date;
    card_count: number | null;
  }>(
    `select s.id, w.product_name, w.product_url, s.created_at,
            jsonb_array_length(s.opportunity_report->'cards') as card_count
       from scan_jobs s
       join workspaces w on w.id = s.workspace_id
      where w.owner_user_id = $1 and s.status = 'done'
      order by s.created_at desc
      limit 50`,
    [userId],
  );
  return result.rows.map((r) => ({
    scanId: r.id,
    productName: r.product_name,
    productUrl: r.product_url,
    scannedAt: r.created_at.toISOString(),
    opportunityCount: r.card_count ?? 0,
  }));
}
