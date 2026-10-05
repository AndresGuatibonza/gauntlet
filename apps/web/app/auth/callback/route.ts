/**
 * GET /auth/callback?code=...&next=/scans/<id> -- where GitHub sign-in
 * returns (via Supabase Auth, PKCE). Exchanges the code for a session
 * cookie, records signup_completed when the sign-in started from a report
 * (PRD §11 "Signup after report"), and returns the visitor to `next`
 * (same-site paths only). Any failure lands back on /signup with a reason.
 */
import { NextResponse } from "next/server";
import { ipAddress } from "@vercel/functions";
import { createSupabaseServerClient } from "@/lib/auth/server";
import { safeNextPath } from "@/lib/auth/config";
import { jobIdFromPath } from "@/lib/scan-paths";
import { recordScanEvent } from "@/lib/store";
import { hashClientIp, readIpHashSecret } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const failed = (reason: string) =>
    NextResponse.redirect(new URL(`/signup?error=${reason}&next=${encodeURIComponent(next)}`, url.origin), 303);

  if (url.searchParams.get("error")) return failed("denied");
  if (!code) return failed("missing_code");

  const supabase = await createSupabaseServerClient();
  if (!supabase) return failed("unavailable");
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[auth/callback] code exchange failed:", error.message);
      return failed("exchange");
    }
  } catch (err) {
    console.error("[auth/callback] code exchange threw:", err);
    return failed("exchange");
  }

  const scanId = jobIdFromPath(new URL(next, url.origin).pathname);
  if (scanId) {
    try {
      await recordScanEvent({
        scanJobId: scanId,
        type: "signup_completed",
        clientIpHash: hashClientIp(ipAddress(request), readIpHashSecret()),
      });
    } catch (err) {
      // Analytics must never block a successful sign-in.
      console.error("[auth/callback] could not record signup_completed:", err);
    }
  }
  return NextResponse.redirect(new URL(next, url.origin), 303);
}
