/**
 * npm run usage [-- --days 30] [-- --scan <report id>]
 *
 * Model usage and estimated cost from llm_calls (migration 009): per phase
 * (scans, briefs, repo briefs, with the average per unit) and per day; or,
 * with --scan, the models, prompt fingerprints and commits that produced
 * one report and its briefs. Reads DATABASE_URL from apps/web/.env.local
 * when present. Read-only.
 */
import { getPool } from "../lib/db";
import { getScanGeneration, usageSummary } from "../lib/llm-usage";
import { formatScanGeneration, formatUsageSummary } from "../lib/usage-report";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile?.(".env.local");
  } catch {
    // No .env.local: rely on the environment.
  }
  const scan = option("--scan");
  const daysText = option("--days") ?? "30";
  const days = Number(daysText);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error(`--days must be a whole number from 1 to 3650 (got "${daysText}").`);
    return 1;
  }
  if (scan !== undefined && !/^[0-9a-f-]{36}$/i.test(scan)) {
    console.error(`--scan must be a report id (got "${scan}").`);
    return 1;
  }
  try {
    console.log(scan ? formatScanGeneration(scan, await getScanGeneration(scan)) : formatUsageSummary(await usageSummary(days), days));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(/llm_calls/.test(message) && /does not exist/.test(message) ? "Run `npm run migrate` first (migration 009 adds llm_calls)." : `Could not read usage: ${message}`);
    return 1;
  } finally {
    await getPool().end().catch(() => {});
  }
}

main().then((code) => process.exit(code));
