/**
 * POST /api/scans -- creates a scan job and returns its id immediately.
 * The actual pipeline (lib/run-scan.ts) runs via `after()`, which keeps
 * the function alive past the response, up to `maxDuration` below.
 *
 * maxDuration = 300 matches the Hobby plan's fixed ceiling (Vercel's
 * current limits, checked 2026-09: Hobby is 300s default *and* max; Pro
 * goes to 800s, 1800s in beta). Confirmed with Andres: deploying on Hobby
 * for the MVP. If the pipeline is later found to routinely need more than
 * 300s (most likely case: both the Scientist and the Reviewer need their
 * one automatic corrective retry in the same run), that's the concrete
 * signal to move to Pro and raise this to 800 -- not something to
 * pre-optimize for without a real run proving it's needed.
 *
 * Every scan is quota-checked before it's created (lib/rate-limit.ts):
 * this endpoint is public and unauthenticated, and each scan crawls a
 * third-party site and spends Claude API calls. Over quota -> 429 with a
 * Retry-After header and a human-readable message the landing page shows
 * as-is.
 */
import { NextResponse, after } from "next/server";
import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { createScanJobWithinQuota } from "@/lib/store";
import { hashClientIp, readIpHashSecret, readScanLimits, type ScanLimits } from "@/lib/rate-limit";
import { runScanJob } from "@/lib/run-scan";

export const maxDuration = 300;

const CreateScanSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith("https://"), {
    message: "URL must be a public HTTPS URL (per PRD §8.1).",
  }),
  category: z.enum(["ai_tool", "ai_saas"]).default("ai_saas"),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = CreateScanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  // Quota config errors are the server's fault, not the visitor's: fail
  // closed with a 500 rather than running scans with no limit at all. The
  // detail (which env var) goes to the server log only -- this endpoint is
  // public, and env var names are not something to hand to any visitor.
  let limits: ScanLimits;
  let clientIpHash: string;
  try {
    limits = readScanLimits();
    clientIpHash = hashClientIp(ipAddress(request), readIpHashSecret());
  } catch (err) {
    console.error("[POST /api/scans] scan quota misconfigured:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Scans are temporarily unavailable due to a server configuration problem." },
      { status: 500 },
    );
  }

  let jobId: string;
  try {
    const result = await createScanJobWithinQuota(parsed.data.url, parsed.data.category, clientIpHash, limits);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.denial.message },
        { status: 429, headers: { "Retry-After": String(result.denial.retryAfterSeconds) } },
      );
    }
    jobId = result.id;
  } catch (err) {
    // Most likely cause: DATABASE_URL misconfigured or a migration in
    // lib/migrations/ (001_init.sql, 002_scan_rate_limit.sql) hasn't been
    // applied yet -- surface the real message rather than letting this
    // throw into Next's generic, unstructured 500 (which the frontend can
    // still fall back to, but with no actionable detail).
    return NextResponse.json(
      { error: `Could not create scan job: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // Schedule the pipeline to run after this response is sent. If the
  // pipeline itself throws, runScanJob's own top-level catch writes
  // status "failed" -- this callback never needs its own try/catch.
  after(() => runScanJob(jobId, parsed.data.url, parsed.data.category));

  return NextResponse.json({ id: jobId }, { status: 202 });
}
