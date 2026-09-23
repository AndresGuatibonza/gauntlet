/**
 * GET /api/scans/:id -- polled by the report page (app/scans/[id]/page.tsx)
 * every few seconds until status is "done" or "failed".
 */
import { NextResponse } from "next/server";
import { getScanJob } from "@/lib/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
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
