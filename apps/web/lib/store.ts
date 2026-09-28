/**
 * scan_jobs data access. Mirrors the CLI's store.ts pattern (a small
 * typed interface over the raw driver) but against Postgres/jsonb instead
 * of SQLite -- see lib/migrations/001_init.sql for why this is one table,
 * not the CLI's normalized three.
 */
import type { EvidencePacket, OpportunityReport, ReviewRecord } from "@gauntlet/core";
import { getPool } from "./db.js";
import { evaluateScanQuota, QUOTA_WINDOW_SECONDS, type QuotaDenial, type ScanLimits } from "./rate-limit.js";

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

const QUOTA_USAGE_SQL = `
  with win as (select now() - make_interval(secs => $4) as since)
  select
    now() as now,
    (select count(*)::int from scan_jobs, win
      where client_ip_hash = $1 and created_at > win.since) as client_count,
    (select created_at from scan_jobs, win
      where client_ip_hash = $1 and created_at > win.since
      order by created_at desc offset ($2::int - 1) limit 1) as client_slot_frees_from,
    (select count(*)::int from scan_jobs, win
      where created_at > win.since) as global_count,
    (select created_at from scan_jobs, win
      where created_at > win.since
      order by created_at desc offset ($3::int - 1) limit 1) as global_slot_frees_from
`;

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
): Promise<CreateScanJobResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [SCAN_QUOTA_LOCK_KEY]);

    const usage = await client.query<QuotaUsageRow>(QUOTA_USAGE_SQL, [
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
      `insert into scan_jobs (url, category, status, client_ip_hash) values ($1, $2, 'queued', $3) returning id`,
      [url, category, clientIpHash],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      // Same "never assume" guard the previous createScanJob had.
      throw new Error("createScanJobWithinQuota: insert returned no id");
    }
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
