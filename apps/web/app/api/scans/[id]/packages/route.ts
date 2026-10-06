/**
 * GET: every "Build this" brief of a finished report, by card, so the
 * report shows them again when it is reopened instead of waiting for
 * another click. Same body per card as GET cards/[index]/package, plus
 * its cardIndex; cards never built are left out. A report that isn't
 * finished has none.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getScanJob, listActionPackages } from "@/lib/store";
import { packageStateBody } from "@/lib/package-response";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Params): Promise<Response> {
  const parsed = z.string().uuid().safeParse((await context.params).id);
  if (!parsed.success) return NextResponse.json({ error: "No such report." }, { status: 404 });
  try {
    const job = await getScanJob(parsed.data);
    if (!job) return NextResponse.json({ error: "No such report." }, { status: 404 });
    if (job.status !== "done" || !job.opportunityReport) return NextResponse.json({ packages: [] });
    const cardCount = job.opportunityReport.cards.length;
    const packages = (await listActionPackages(parsed.data))
      .filter(({ cardIndex }) => cardIndex < cardCount)
      .map(({ cardIndex, state }) => ({ cardIndex, ...packageStateBody(state) }));
    return NextResponse.json({ packages }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[packages GET]", err);
    return NextResponse.json({ error: "Could not read this report's implementation briefs." }, { status: 500 });
  }
}
