/**
 * GET /api/github/connect?scan=<id> -- starts connecting a GitHub
 * repository from a saved report (PRD §5 step 6, §8.6). Owner only.
 *
 * Sends the owner to GitHub to install the Gauntlet App (or change which
 * repositories it may read); GitHub returns to /api/github/callback. With
 * ?mode=authorize it skips installing and only asks GitHub who the user is
 * -- for an App already installed, so we can list what they can read.
 * Records github_connect_started (PRD §11).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ipAddress } from "@vercel/functions";
import { getSessionUser } from "@/lib/auth/server";
import { authorizeUrl, installUrl, readGitHubAppConfig } from "@/lib/github-app";
import { GITHUB_STATE_COOKIE, newGitHubState, stateCookieOptions } from "@/lib/github-state";
import { getScanOwner, recordScanEvent } from "@/lib/store";
import { hashClientIp, readIpHashSecret } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scanId = url.searchParams.get("scan");
  if (!scanId || !z.string().uuid().safeParse(scanId).success) {
    return NextResponse.redirect(new URL("/ledger", url.origin), 303);
  }
  const back = (reason: string) => NextResponse.redirect(new URL(`/scans/${scanId}?github=${reason}`, url.origin), 303);

  let config;
  try {
    config = readGitHubAppConfig();
  } catch (err) {
    console.error("[github/connect] misconfigured:", err instanceof Error ? err.message : err);
    return back("unavailable");
  }
  if (!config) return back("unavailable");

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL(`/signup?next=${encodeURIComponent(`/scans/${scanId}`)}`, url.origin), 303);
  try {
    if ((await getScanOwner(scanId)) !== user.id) return back("not_owner");
  } catch (err) {
    console.error("[github/connect] owner lookup failed:", err);
    return back("error");
  }

  const { state, cookieValue } = newGitHubState(scanId);
  const target =
    url.searchParams.get("mode") === "authorize"
      ? authorizeUrl(config, state, `${url.origin}/api/github/callback`)
      : installUrl(config, state);
  const response = NextResponse.redirect(target, 303);
  response.cookies.set(GITHUB_STATE_COOKIE, cookieValue, stateCookieOptions(url.protocol === "https:"));

  try {
    await recordScanEvent({
      scanJobId: scanId,
      type: "github_connect_started",
      clientIpHash: hashClientIp(ipAddress(request), readIpHashSecret()),
    });
  } catch (err) {
    console.error("[github/connect] could not record github_connect_started:", err);
  }
  return response;
}
