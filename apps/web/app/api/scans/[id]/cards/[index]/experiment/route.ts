/**
 * The Experiment Ledger record for one card (contract §2.3), owner only.
 * GET -> { experiment } (null before "Build this" created one).
 * POST { running?: true, decision?, result?, outcome? } applies the shared
 * ledger rules (applyExperimentUpdate in @gauntlet/core):
 *   200 { experiment } · 401 signed out · 403 not the owner · 404 no record
 *   409 changed meanwhile (reload) · 422 the rules refuse the update
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { applyExperimentUpdate, ExperimentUpdateError } from "@gauntlet/core";
import { getSessionUser } from "@/lib/auth/server";
import { getExperimentForCard, getScanOwner, updateExperiment } from "@/lib/store";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0).max(49) });
const text = z.string().trim().min(1).max(2000);
const UpdateSchema = z
  .object({
    running: z.literal(true).optional(),
    decision: z.enum(["ship", "iterate", "discard"]).optional(),
    result: text.optional(),
    outcome: text.optional(),
  })
  .strict();

type Params = { params: Promise<{ id: string; index: string }> };

/** Resolves the target and checks ownership; returns a Response on refusal. */
async function authorize(context: Params): Promise<{ id: string; index: number; userId: string } | Response> {
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return NextResponse.json({ error: "No such experiment." }, { status: 404 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to track this experiment." }, { status: 401 });
  const owner = await getScanOwner(params.data.id);
  if (owner !== user.id) return NextResponse.json({ error: "Only the account that saved this report can track it." }, { status: 403 });
  return { ...params.data, userId: user.id };
}

export async function GET(_request: Request, context: Params): Promise<Response> {
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;
    return NextResponse.json({ experiment: await getExperimentForCard(target.id, target.index) });
  } catch (err) {
    console.error("[experiment GET]", err);
    return NextResponse.json({ error: "Could not read this experiment." }, { status: 500 });
  }
}

export async function POST(request: Request, context: Params): Promise<Response> {
  const body = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Invalid update." }, { status: 400 });
  try {
    const target = await authorize(context);
    if (target instanceof Response) return target;
    const current = await getExperimentForCard(target.id, target.index);
    if (!current) return NextResponse.json({ error: "Use Build this first: it starts the experiment." }, { status: 404 });

    let next;
    try {
      next = applyExperimentUpdate(current.record, body.data);
    } catch (err) {
      if (err instanceof ExperimentUpdateError) return NextResponse.json({ error: err.message }, { status: 422 });
      throw err;
    }
    const saved = await updateExperiment(current.id, current.record, next, target.userId);
    if (saved.outcome === "conflict") {
      return NextResponse.json({ error: "This experiment changed in the meantime. Reload to see it." }, { status: 409 });
    }
    return NextResponse.json({ experiment: saved.experiment });
  } catch (err) {
    console.error("[experiment POST]", err);
    return NextResponse.json({ error: "Could not save this update." }, { status: 500 });
  }
}
