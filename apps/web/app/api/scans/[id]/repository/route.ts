/**
 * The GitHub repository connected to a saved report's workspace (PRD
 * §8.6-§8.7). Owner only.
 * GET    -> { available, connected, accessible }: whether GitHub connections
 *           are configured, the connected repository (or null), and the
 *           repositories this account proved it can read.
 * POST   { repositoryId } -> { connected } · 404 when it isn't in that list.
 * DELETE -> { disconnected, briefsDeleted }: removes the link and every
 *           repo-aware brief written from it.
 * 401 signed out · 403 not the owner · 404 unknown or unsaved report.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/server";
import { readGitHubAppConfig } from "@/lib/github-app";
import {
  connectWorkspaceRepository,
  disconnectWorkspaceRepository,
  getScanWorkspace,
  getWorkspaceRepository,
  listAccessibleRepositories,
  type ScanWorkspace,
} from "@/lib/repo-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function githubAvailable(): boolean {
  try {
    return readGitHubAppConfig() !== null;
  } catch (err) {
    console.error("[repository] GitHub App misconfigured:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function authorize(context: Params): Promise<{ userId: string; workspace: ScanWorkspace } | Response> {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "No such report." }, { status: 404 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to connect a repository." }, { status: 401 });
  const workspace = await getScanWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Save this report to your workspace first." }, { status: 404 });
  if (workspace.ownerUserId !== user.id) {
    return NextResponse.json({ error: "Only the account that saved this report can connect a repository." }, { status: 403 });
  }
  return { userId: user.id, workspace };
}

export async function GET(_request: Request, context: Params): Promise<Response> {
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;
    const [connected, accessible] = await Promise.all([
      getWorkspaceRepository(target.workspace.workspaceId),
      listAccessibleRepositories(target.userId),
    ]);
    return NextResponse.json({
      available: githubAvailable(),
      connected: connected ? { repositoryId: connected.repositoryId, fullName: connected.fullName, defaultBranch: connected.defaultBranch, connectedAt: connected.connectedAt } : null,
      accessible: accessible.map((r) => ({ repositoryId: r.repositoryId, fullName: r.fullName, private: r.private })),
    });
  } catch (err) {
    console.error("[repository GET]", err);
    return NextResponse.json({ error: "Could not read the repository connection." }, { status: 500 });
  }
}

const ConnectSchema = z.object({ repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

export async function POST(request: Request, context: Params): Promise<Response> {
  const body = ConnectSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Choose a repository." }, { status: 400 });
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;
    if (!githubAvailable()) return NextResponse.json({ error: "GitHub connections are not available right now." }, { status: 503 });
    const result = await connectWorkspaceRepository(target.workspace.workspaceId, target.userId, body.data.repositoryId);
    if (result.outcome === "not_accessible") {
      return NextResponse.json({ error: "Gauntlet can't read that repository for your account. Connect GitHub again and give the app access to it." }, { status: 404 });
    }
    const r = result.repository;
    return NextResponse.json({ connected: { repositoryId: r.repositoryId, fullName: r.fullName, defaultBranch: r.defaultBranch, connectedAt: r.connectedAt } });
  } catch (err) {
    console.error("[repository POST]", err);
    return NextResponse.json({ error: "Could not connect the repository." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: Params): Promise<Response> {
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;
    return NextResponse.json(await disconnectWorkspaceRepository(target.workspace.workspaceId));
  } catch (err) {
    console.error("[repository DELETE]", err);
    return NextResponse.json({ error: "Could not disconnect the repository." }, { status: 500 });
  }
}
