/**
 * POST /api/scans/:id/claim { token } -- saves a scan to the signed-in
 * user's workspace for that product. Requires the claim token the browser
 * received when it started the scan (lib/accounts.ts).
 *   200 { workspaceId, status: "claimed" | "already_yours" }
 *   401 not signed in · 403 wrong token or someone else's scan · 404 unknown scan
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/server";
import { claimScan } from "@/lib/store";

const BodySchema = z.object({ token: z.string().min(20).max(100) }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "No such scan." }, { status: 404 });
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "A claim token is required." }, { status: 400 });

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to save this report." }, { status: 401 });

  try {
    const result = await claimScan(id, body.data.token, user.id);
    switch (result.outcome) {
      case "claimed":
      case "already_yours":
        return NextResponse.json({ status: result.outcome, workspaceId: result.workspaceId });
      case "not_found":
        return NextResponse.json({ error: "No such scan." }, { status: 404 });
      case "invalid_token":
        return NextResponse.json({ error: "Only the browser that ran this scan can save it." }, { status: 403 });
      case "claimed_by_other":
        return NextResponse.json({ error: "This report is already saved to another account." }, { status: 403 });
    }
  } catch (err) {
    console.error("[claim]", err);
    return NextResponse.json({ error: "Could not save this report." }, { status: 500 });
  }
}
