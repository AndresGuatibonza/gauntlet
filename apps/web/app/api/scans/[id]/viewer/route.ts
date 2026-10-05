/**
 * GET /api/scans/:id/viewer -- what the person looking at a report can do:
 * whether sign-in exists here, who they are, and whether the report is
 * theirs. Never exposes the owner's identity to anyone else.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { getScanOwner } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "No such scan." }, { status: 404 });
  const authAvailable = readAuthConfig() !== null;
  const user = authAvailable ? await getSessionUser() : null;
  let owner: string | null = null;
  try {
    owner = await getScanOwner(id);
  } catch (err) {
    console.error("[viewer]", err);
  }
  return NextResponse.json({
    authAvailable,
    signedIn: user !== null,
    login: user?.login ?? null,
    isOwner: user !== null && owner === user.id,
    claimed: owner !== null,
  });
}
