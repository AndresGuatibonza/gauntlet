/**
 * The repo-aware brief for one card (GitHub deep scan, PRD §8.7; contract
 * §1.7, §2.2, §2.4). Owner only: it holds private code evidence and is never
 * part of the shareable report (PRD §14).
 *
 * POST starts it (or returns the existing one): needs a connected
 * repository and the card's public brief ("Build this" first, which also
 * started its ledger record). 202 { status: "generating", stage } while
 * reading the repository and writing; 429 over the per-account quota.
 * GET reports the state for polling: ready -> the analysis (code evidence
 * and refinement) and the repo-aware package with its prompt and Markdown.
 * 401 signed out · 403 not the owner · 404 unknown · 409 not possible yet.
 */
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { renderActionPackageMarkdown, renderCodingAgentPrompt } from "@gauntlet/core";
import { getSessionUser } from "@/lib/auth/server";
import { readGitHubAppConfig } from "@/lib/github-app";
import { readRepoBriefLimits } from "@/lib/rate-limit";
import { claimRepoBrief, getRepoBrief, getScanWorkspace, getWorkspaceRepository, type RepoBriefState, type ScanWorkspace } from "@/lib/repo-store";
import { getActionPackage, getScanJob } from "@/lib/store";
import { runRepoBriefJob } from "@/lib/build-repo-brief";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0).max(49) });
type Params = { params: Promise<{ id: string; index: string }> };

function stateResponse(state: RepoBriefState): Response {
  switch (state.state) {
    case "ready":
      return NextResponse.json({
        status: "ready",
        repository: state.repository,
        analysis: state.analysis,
        package: state.package,
        codingAgentPrompt: renderCodingAgentPrompt(state.package),
        markdown: renderActionPackageMarkdown(state.package),
      });
    case "generating":
      return NextResponse.json({ status: "generating", stage: state.stage, repository: state.repository }, { status: 202 });
    case "failed":
      return NextResponse.json({ status: "failed", error: state.errorMessage, canRetry: state.canRetry, repository: state.repository });
    case "none":
      return NextResponse.json({ status: "none" });
  }
}

async function authorize(context: Params): Promise<{ id: string; index: number; userId: string; workspace: ScanWorkspace } | Response> {
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return NextResponse.json({ error: "No such opportunity." }, { status: 404 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to see the repo-aware brief." }, { status: 401 });
  const workspace = await getScanWorkspace(params.data.id);
  if (!workspace) return NextResponse.json({ error: "No such opportunity." }, { status: 404 });
  if (workspace.ownerUserId !== user.id) {
    return NextResponse.json({ error: "Only the account that saved this report can see its repo-aware briefs." }, { status: 403 });
  }
  return { ...params.data, userId: user.id, workspace };
}

export async function GET(_request: Request, context: Params): Promise<Response> {
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;
    return stateResponse(await getRepoBrief(target.id, target.index));
  } catch (err) {
    console.error("[repo-brief GET]", err);
    return NextResponse.json({ error: "Could not read the repo-aware brief." }, { status: 500 });
  }
}

export async function POST(_request: Request, context: Params): Promise<Response> {
  let limits;
  try {
    limits = readRepoBriefLimits();
  } catch (err) {
    console.error("[repo-brief POST] quota misconfigured:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Repo-aware briefs are temporarily unavailable." }, { status: 500 });
  }
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;

    let configured = false;
    try {
      configured = readGitHubAppConfig() !== null;
    } catch (err) {
      console.error("[repo-brief POST] GitHub App misconfigured:", err instanceof Error ? err.message : err);
    }
    if (!configured) return NextResponse.json({ error: "GitHub connections are not available right now." }, { status: 503 });

    const job = await getScanJob(target.id);
    if (!job || job.status !== "done" || !job.opportunityReport?.cards[target.index]) {
      return NextResponse.json({ error: "No such opportunity." }, { status: 404 });
    }
    const repository = await getWorkspaceRepository(target.workspace.workspaceId);
    if (!repository) return NextResponse.json({ error: "Connect a GitHub repository first." }, { status: 409 });
    const publicPackage = await getActionPackage(target.id, target.index);
    if (publicPackage.state !== "ready") {
      return NextResponse.json({ error: "Use Build this on this opportunity first: the repo-aware brief refines it." }, { status: 409 });
    }

    const claim = await claimRepoBrief({
      scanJobId: target.id,
      cardIndex: target.index,
      workspaceId: target.workspace.workspaceId,
      repository,
      userId: target.userId,
      limits,
    });
    if (claim.outcome === "denied") {
      return NextResponse.json(
        { error: claim.denial.message },
        { status: 429, headers: { "Retry-After": String(claim.denial.retryAfterSeconds) } },
      );
    }
    if (claim.outcome === "existing") return stateResponse(claim.state);

    after(() => runRepoBriefJob(claim.id, target.id, target.index, claim.reuseAnalysis));
    return NextResponse.json(
      { status: "generating", stage: claim.reuseAnalysis ? "writing" : "reading", repository: repository.fullName },
      { status: 202 },
    );
  } catch (err) {
    console.error("[repo-brief POST]", err);
    return NextResponse.json({ error: "Could not start the repo-aware brief." }, { status: 500 });
  }
}
