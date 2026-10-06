/**
 * Model-call accounting (migration 009): one llm_calls row per Claude call
 * made by a scan, a "Build this" brief or a repo-aware brief, with the
 * model, prompt fingerprint, deployed commit, tokens and estimated cost.
 *
 * Recording is best-effort by design: a failed insert is logged and never
 * fails or delays the job it describes beyond the final flush().
 */
import { estimateCostUsd, type LlmUsage } from "@gauntlet/core";
import { getPool } from "./db.js";

export type UsagePhase = "scan" | "package" | "repo_brief";

export interface UsageTarget {
  scanJobId: string;
  phase: UsagePhase;
  /** Required for "package" and "repo_brief", absent for "scan". */
  cardIndex?: number;
}

export interface LlmCallRow {
  scanJobId: string;
  phase: UsagePhase;
  cardIndex: number | null;
  purpose: string | null;
  model: string;
  promptHash: string;
  appVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  stopReason: string | null;
  durationMs: number;
  ok: boolean;
}

/** The deployed commit (Vercel sets it), shortened; null outside a deployment. */
export function appVersion(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const sha = env["VERCEL_GIT_COMMIT_SHA"]?.trim();
  return sha ? sha.slice(0, 12) : null;
}

export function toLlmCallRow(target: UsageTarget, usage: LlmUsage, version: string | null): LlmCallRow {
  return {
    scanJobId: target.scanJobId,
    phase: target.phase,
    cardIndex: target.phase === "scan" ? null : (target.cardIndex ?? null),
    purpose: usage.purpose,
    model: usage.model,
    promptHash: usage.promptHash,
    appVersion: version,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: estimateCostUsd(usage),
    stopReason: usage.stopReason,
    durationMs: Math.max(0, Math.round(usage.durationMs)),
    ok: usage.ok,
  };
}

export async function insertLlmCall(row: LlmCallRow): Promise<void> {
  await getPool().query(
    `insert into llm_calls (scan_job_id, phase, card_index, purpose, model, prompt_hash, app_version,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, stop_reason, duration_ms, ok)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      row.scanJobId,
      row.phase,
      row.cardIndex,
      row.purpose,
      row.model,
      row.promptHash,
      row.appVersion,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.costUsd,
      row.stopReason,
      row.durationMs,
      row.ok,
    ],
  );
}

export interface UsageRecorder {
  /** Pass as createAnthropicLlmClient({ onUsage }). */
  onUsage: (usage: LlmUsage) => void;
  /** Waits for every pending write; never throws. Call before the job returns. */
  flush: () => Promise<void>;
}

/**
 * Collects one job's calls. Each call is written as it happens (so a job
 * that dies halfway still leaves its calls) and logged as one JSON line,
 * which keeps the numbers visible in the platform logs even when the
 * database write fails.
 */
export function createUsageRecorder(
  target: UsageTarget,
  deps: { insert?: (row: LlmCallRow) => Promise<void>; version?: string | null; log?: Pick<Console, "info" | "error"> } = {},
): UsageRecorder {
  const insert = deps.insert ?? insertLlmCall;
  const version = deps.version === undefined ? appVersion() : deps.version;
  const log = deps.log ?? console;
  const pending: Promise<void>[] = [];

  return {
    onUsage(usage) {
      const row = toLlmCallRow(target, usage, version);
      log.info(JSON.stringify({ event: "llm_call", ...row }));
      pending.push(
        insert(row).catch((err: unknown) => {
          log.error("[llm-usage] could not record a model call:", err instanceof Error ? err.message : err);
        }),
      );
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the priced calls; null when none was priced. */
  costUsd: number | null;
  /** Calls with no estimate (unpriced model): the cost above leaves them out. */
  unpricedCalls: number;
}

export interface ScanGeneration {
  /** Per phase and card: what produced the stored output, and its totals. */
  parts: {
    phase: UsagePhase;
    cardIndex: number | null;
    models: string[];
    prompts: { purpose: string | null; promptHash: string }[];
    appVersions: string[];
    totals: UsageTotals;
  }[];
  totals: UsageTotals;
}

type TotalsRow = {
  calls: string;
  failed_calls: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_usd: string | null;
  unpriced_calls: string;
};

const TOTALS_SQL = `count(*) as calls,
  count(*) filter (where not ok) as failed_calls,
  coalesce(sum(input_tokens), 0) as input_tokens,
  coalesce(sum(output_tokens), 0) as output_tokens,
  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
  coalesce(sum(cache_write_tokens), 0) as cache_write_tokens,
  sum(cost_usd) as cost_usd,
  count(*) filter (where cost_usd is null) as unpriced_calls`;

function toTotals(r: TotalsRow): UsageTotals {
  return {
    calls: Number(r.calls),
    failedCalls: Number(r.failed_calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    unpricedCalls: Number(r.unpriced_calls),
  };
}

/** What produced one report and its briefs (models, prompt fingerprints, commits), and what it cost. */
export async function getScanGeneration(scanJobId: string): Promise<ScanGeneration> {
  const pool = getPool();
  const parts = await pool.query<
    TotalsRow & { phase: UsagePhase; card_index: number | null; models: string[]; prompts: { purpose: string | null; promptHash: string }[]; app_versions: string[] }
  >(
    `select phase, card_index,
       array_agg(distinct model order by model) as models,
       (select coalesce(jsonb_agg(p order by p->>'purpose', p->>'promptHash'), '[]'::jsonb)
          from (select distinct jsonb_build_object('purpose', c2.purpose, 'promptHash', c2.prompt_hash) as p
                  from llm_calls c2
                 where c2.scan_job_id = c.scan_job_id and c2.phase = c.phase
                   and c2.card_index is not distinct from c.card_index) d) as prompts,
       coalesce(array_agg(distinct app_version order by app_version) filter (where app_version is not null), '{}') as app_versions,
       ${TOTALS_SQL}
     from llm_calls c
     where scan_job_id = $1
     group by scan_job_id, phase, card_index
     order by case phase when 'scan' then 0 when 'package' then 1 else 2 end, card_index nulls first`,
    [scanJobId],
  );
  const totals = await pool.query<TotalsRow>(`select ${TOTALS_SQL} from llm_calls where scan_job_id = $1`, [scanJobId]);
  return {
    parts: parts.rows.map((r) => ({
      phase: r.phase,
      cardIndex: r.card_index,
      models: r.models,
      prompts: r.prompts,
      appVersions: r.app_versions,
      totals: toTotals(r),
    })),
    totals: toTotals(totals.rows[0]!),
  };
}

export interface PhaseUsage {
  phase: UsagePhase;
  /** Distinct scans (phase "scan") or briefs (scan + card) that made calls. */
  units: number;
  totals: UsageTotals;
  /** costUsd / units, when priced. */
  averageCostUsd: number | null;
}

export interface DailyUsage {
  day: string;
  phase: UsagePhase;
  totals: UsageTotals;
}

/** Usage over the last `days` days: per phase (with the average per scan or brief) and per UTC day. */
export async function usageSummary(days: number): Promise<{ since: string; byPhase: PhaseUsage[]; byDay: DailyUsage[] }> {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new RangeError("days must be an integer from 1 to 3650");
  const pool = getPool();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const byPhase = await pool.query<TotalsRow & { phase: UsagePhase; units: string }>(
    `select phase,
       count(distinct (scan_job_id, coalesce(card_index, -1))) as units,
       ${TOTALS_SQL}
     from llm_calls where created_at >= $1
     group by phase
     order by case phase when 'scan' then 0 when 'package' then 1 else 2 end`,
    [since],
  );
  const byDay = await pool.query<TotalsRow & { day: string; phase: UsagePhase }>(
    `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, phase, ${TOTALS_SQL}
     from llm_calls where created_at >= $1
     group by 1, 2
     order by 1 desc, case phase when 'scan' then 0 when 'package' then 1 else 2 end`,
    [since],
  );
  return {
    since,
    byPhase: byPhase.rows.map((r) => {
      const totals = toTotals(r);
      const units = Number(r.units);
      return {
        phase: r.phase,
        units,
        totals,
        averageCostUsd: totals.costUsd === null || units === 0 ? null : Math.round((totals.costUsd / units) * 1_000_000) / 1_000_000,
      };
    }),
    byDay: byDay.rows.map((r) => ({ day: r.day, phase: r.phase, totals: toTotals(r) })),
  };
}
