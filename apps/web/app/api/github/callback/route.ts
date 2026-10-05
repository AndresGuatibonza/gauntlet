/**
 * GET /api/github/callback -- where GitHub returns after installing the
 * Gauntlet App or authorizing it (the App's "Callback URL").
 *
 * 1. The state must match the httpOnly cookie set by /api/github/connect.
 * 2. Without a code (installed without "request user authorization"), the
 *    owner is sent once more to GitHub to authorize, with the same state.
 * 3. The code becomes the user's token, used ONCE to list the App's
 *    installations and repositories this user can read; that list is
 *    stored, the token is dropped. Records github_connected (PRD §11).
 * 4. Back to the report: ?github=connected | no_repos | denied | error.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ipAddress } from "@vercel/functions";
import { getSessionUser } from "@/lib/auth/server";
import { authorizeUrl, exchangeOAuthCode, GitHubAppError, listUserAccess, readGitHubAppConfig } from "@/lib/github-app";
import { GITHUB_STATE_COOKIE, stateCookieOptions, verifyGitHubState } from "@/lib/github-state";
import { saveUserGitHubAccess } from "@/lib/repo-store";
import { recordScanEvent } from "@/lib/store";
import { hashClientIp, readIpHashSecret } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cookieStore = await cookies();
  const verified = verifyGitHubState(cookieStore.get(GITHUB_STATE_COOKIE)?.value, url.searchParams.get("state"));
  if (!verified) {
    // Not ours, expired, or replayed: never act on it.
    return NextResponse.redirect(new URL("/ledger?github=expired", url.origin), 303);
  }
  const { scanId } = verified;
  const finish = (reason: string) => {
    const response = NextResponse.redirect(new URL(`/scans/${scanId}?github=${reason}`, url.origin), 303);
    response.cookies.set(GITHUB_STATE_COOKIE, "", { ...stateCookieOptions(url.protocol === "https:"), maxAge: 0 });
    return response;
  };

  if (url.searchParams.get("error")) return finish("denied");

  let config;
  try {
    config = readGitHubAppConfig();
  } catch (err) {
    console.error("[github/callback] misconfigured:", err instanceof Error ? err.message : err);
    return finish("unavailable");
  }
  if (!config) return finish("unavailable");

  const redirectUri = `${url.origin}/api/github/callback`;
  const code = url.searchParams.get("code");
  if (!code) {
    // Installed (or changed) without user authorization: authorize now, same state, cookie kept.
    return NextResponse.redirect(authorizeUrl(config, url.searchParams.get("state")!, redirectUri), 303);
  }

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL(`/signup?next=${encodeURIComponent(`/scans/${scanId}`)}`, url.origin), 303);

  let repositoryCount: number;
  try {
    const token = await exchangeOAuthCode(config, code, redirectUri);
    const access = await listUserAccess(token);
    if (!access.complete) console.warn("[github/callback] access list truncated for a user with many repositories");
    await saveUserGitHubAccess(user.id, access.installations, access.repositories);
    repositoryCount = access.repositories.length;
  } catch (err) {
    console.error("[github/callback] connection failed:", err);
    return finish(err instanceof GitHubAppError && err.kind === "denied" ? "denied" : "error");
  }

  if (repositoryCount === 0) return finish("no_repos");
  try {
    await recordScanEvent({
      scanJobId: scanId,
      type: "github_connected",
      clientIpHash: hashClientIp(ipAddress(request), readIpHashSecret()),
    });
  } catch (err) {
    console.error("[github/callback] could not record github_connected:", err);
  }
  return finish("connected");
}
