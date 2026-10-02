/**
 * GET /api/scans/:id -- polled by the report page (app/scans/[id]/page.tsx)
 * every few seconds until status is "done" or "failed".
 *
 * A malformed id is a 404, not a 500: without this check Postgres rejects
 * it as invalid uuid syntax and the request surfaced as a server error.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { expireStaleJobs, getScanJob } from "@/lib/store";

const JobIdSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!JobIdSchema.safeParse(id).success) {
    return NextResponse.json({ error: "No scan job with that id." }, { status: 404 });
  }
  // A scan killed mid-run by the platform would otherwise poll forever:
  // end it here, the first time anyone looks after it timed out. Best
  // effort -- the read below still answers if this write fails.
  await expireStaleJobs(id).catch((err) => console.error("[scans/:id] could not expire stale job:", err));
  let job;
  try {
    job = await getScanJob(id);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read scan job: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
  if (!job) {
    return NextResponse.json({ error: "No scan job with that id." }, { status: 404 });
  }
  return NextResponse.json(job);
}
