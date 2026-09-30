/**
 * POST /api/scans/:id/events -- funnel events + per-card feedback sent by
 * the report page (lib/events.ts). Public and unauthenticated like the
 * rest of the pre-auth flow, so:
 *   - the body is a strict whitelist (lib/events.ts ClientEventSchema;
 *     scan_started/scan_completed/scan_failed are server-only),
 *   - the event must match a finished report and a real card in it,
 *   - every event is idempotent per client (hashed IP), so repeating it
 *     can't inflate counts.
 * Returns 204 on success.
 */
import { NextResponse } from "next/server";
import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { ClientEventSchema, validateClientEvent } from "@/lib/events";
import { hashClientIp, readIpHashSecret } from "@/lib/rate-limit";
import { getScanJob, recordScanEvent } from "@/lib/store";

const JobIdSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!JobIdSchema.safeParse(id).success) {
    return NextResponse.json({ error: "No scan job with that id." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = ClientEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid event." }, { status: 400 });
  }
  const event = parsed.data;

  let clientIpHash: string;
  try {
    clientIpHash = hashClientIp(ipAddress(request), readIpHashSecret());
  } catch (err) {
    console.error("[POST /api/scans/:id/events] IP hash misconfigured:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Temporarily unavailable due to a server configuration problem." }, { status: 500 });
  }

  try {
    const job = await getScanJob(id);
    if (!job) {
      return NextResponse.json({ error: "No scan job with that id." }, { status: 404 });
    }
    const check = validateClientEvent(event, job);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: check.status });
    }
    await recordScanEvent({
      scanJobId: id,
      type: event.type,
      cardIndex: "cardIndex" in event ? event.cardIndex : undefined,
      cardTitle: check.cardTitle,
      rating: event.type === "opportunity_feedback_submitted" ? event.rating : undefined,
      clientIpHash,
    });
  } catch (err) {
    // Most likely: migration 003_scan_events.sql not applied yet.
    console.error("[POST /api/scans/:id/events] could not record event:", err);
    return NextResponse.json({ error: "Could not record this event." }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
