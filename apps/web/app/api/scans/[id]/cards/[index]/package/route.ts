/**
 * "Build this" implementation package for one card of a finished report
 * (PRD §8.8).
 *
 * POST starts generation (or returns the existing package): 202
 *   { status: "generating" } while the single Claude call runs in after(),
 *   200 { status: "ready", package } when it already exists, 429 when the
 *   package quota is used up, 409 when the report isn't finished.
 * GET reports the current state for polling.
 *
 * At most one package per card: concurrent clicks resolve to one
 * generation (claimActionPackage). Package quota: PACKAGE_LIMIT_* env vars.
 */
import { after, NextResponse } from "next/server";
import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { renderCodingAgentPrompt, renderActionPackageMarkdown, type ActionPackage } from "@gauntlet/core";
import { claimActionPackage, getActionPackage, getScanJob, type ActionPackageState } from "@/lib/store";
import { hashClientIp, readIpHashSecret, readPackageLimits } from "@/lib/rate-limit";
import { runActionPackageJob } from "@/lib/build-package";

export const maxDuration = 300;

const ParamsSchema = z.object({
  id: z.string().uuid(),
  index: z.coerce.number().int().min(0).max(49),
});

type Params = { params: Promise<{ id: string; index: string }> };

function present(pkg: ActionPackage): { package: ActionPackage; codingAgentPrompt: string; markdown: string } {
  return { package: pkg, codingAgentPrompt: renderCodingAgentPrompt(pkg), markdown: renderActionPackageMarkdown(pkg) };
}

function stateResponse(state: ActionPackageState): Response {
  switch (state.state) {
    case "ready":
      return NextResponse.json({ status: "ready", ...present(state.package) });
    case "generating":
      return NextResponse.json({ status: "generating" }, { status: 202 });
    case "failed":
      return NextResponse.json({ status: "failed", error: state.errorMessage, canRetry: state.canRetry });
    case "none":
      return NextResponse.json({ status: "none" });
  }
}

/** Shared checks: valid ids, finished report, existing card. */
async function resolveTarget(context: Params): Promise<{ id: string; index: number } | Response> {
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return NextResponse.json({ error: "No such opportunity." }, { status: 404 });
  const { id, index } = parsed.data;
  const job = await getScanJob(id);
  if (!job) return NextResponse.json({ error: "No such opportunity." }, { status: 404 });
  if (job.status !== "done" || !job.opportunityReport) {
    return NextResponse.json({ error: "This scan has no finished report yet." }, { status: 409 });
  }
  if (!job.opportunityReport.cards[index]) {
    return NextResponse.json({ error: `This report has no opportunity #${index}.` }, { status: 404 });
  }
  return { id, index };
}

export async function GET(_request: Request, context: Params): Promise<Response> {
  try {
    const target = await resolveTarget(context);
    if (target instanceof Response) return target;
    return stateResponse(await getActionPackage(target.id, target.index));
  } catch (err) {
    console.error("[package GET]", err);
    return NextResponse.json({ error: "Could not read the implementation brief." }, { status: 500 });
  }
}

export async function POST(request: Request, context: Params): Promise<Response> {
  let limits;
  let clientIpHash: string;
  try {
    limits = readPackageLimits();
    clientIpHash = hashClientIp(ipAddress(request), readIpHashSecret());
  } catch (err) {
    console.error("[package POST] quota misconfigured:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Implementation briefs are temporarily unavailable." }, { status: 500 });
  }

  try {
    const target = await resolveTarget(context);
    if (target instanceof Response) return target;

    const claim = await claimActionPackage(target.id, target.index, clientIpHash, limits);
    if (claim.outcome === "denied") {
      return NextResponse.json(
        { error: claim.denial.message },
        { status: 429, headers: { "Retry-After": String(claim.denial.retryAfterSeconds) } },
      );
    }
    if (claim.outcome === "existing") return stateResponse(claim.state);

    after(() => runActionPackageJob(claim.id, target.id, target.index));
    return NextResponse.json({ status: "generating" }, { status: 202 });
  } catch (err) {
    console.error("[package POST]", err);
    return NextResponse.json({ error: "Could not start the implementation brief." }, { status: 500 });
  }
}
