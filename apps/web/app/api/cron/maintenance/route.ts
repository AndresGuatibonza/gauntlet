/**
 * GET /api/cron/maintenance -- daily housekeeping, run by Vercel Cron
 * (apps/web/vercel.json):
 *   1. fail any scan stuck in flight past STALE_JOB_MINUTES;
 *   2. apply the data-retention policy (lib/retention.ts).
 * Requires `Authorization: Bearer $CRON_SECRET`; refuses everything when
 * CRON_SECRET isn't configured. Idempotent: running it twice is harmless.
 */
import { NextResponse } from "next/server";
import { expireStaleJobs, purgeExpiredData } from "@/lib/store";
import { isAuthorizedCronRequest, readRetentionPolicy, RetentionConfigError } from "@/lib/retention";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env["CRON_SECRET"])) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  let policy;
  try {
    policy = readRetentionPolicy();
  } catch (err) {
    console.error("[maintenance]", err);
    return NextResponse.json({ error: err instanceof RetentionConfigError ? err.message : "Bad configuration." }, { status: 500 });
  }
  try {
    const expired = await expireStaleJobs();
    const purged = await purgeExpiredData(policy);
    const summary = { staleScansFailed: expired.length, ...purged, retentionDays: policy.retentionDays };
    console.log("[maintenance]", JSON.stringify(summary));
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[maintenance] failed:", err);
    return NextResponse.json({ error: "Maintenance failed; see the function logs." }, { status: 500 });
  }
}
