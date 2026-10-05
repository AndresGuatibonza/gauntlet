/** POST /auth/signout -- ends the session and returns home. POST only, so a link or prefetch can't sign anyone out. */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/server";

export async function POST(request: Request): Promise<Response> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase?.auth.signOut();
  } catch (err) {
    console.error("[auth/signout]", err);
  }
  return NextResponse.redirect(new URL("/", request.url), 303);
}
