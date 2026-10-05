/**
 * CSRF protection for the GitHub connection round trip. /api/github/connect
 * sets a random state in an httpOnly cookie and sends the same state to
 * GitHub; /api/github/callback only proceeds when GitHub returns it and the
 * cookie still holds it. The cookie also carries the report to return to
 * (a scan id we validated), so nothing from the query decides the redirect.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const GITHUB_STATE_COOKIE = "gauntlet_github_state";
/** The round trip includes installing the App; 15 minutes is generous. */
export const GITHUB_STATE_MAX_AGE_SECONDS = 15 * 60;

const StateCookieSchema = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), scanId: z.string().uuid() }).strict();

export function newGitHubState(scanId: string): { state: string; cookieValue: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, cookieValue: Buffer.from(JSON.stringify({ state, scanId })).toString("base64url") };
}

/** The scan to return to when the returned state matches the cookie; null otherwise. */
export function verifyGitHubState(cookieValue: string | undefined, returnedState: string | null): { scanId: string } | null {
  if (!cookieValue || !returnedState) return null;
  let parsed;
  try {
    parsed = StateCookieSchema.safeParse(JSON.parse(Buffer.from(cookieValue, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const expected = Buffer.from(parsed.data.state);
  const actual = Buffer.from(returnedState);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { scanId: parsed.data.scanId };
}

export function stateCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/api/github",
    maxAge: GITHUB_STATE_MAX_AGE_SECONDS,
  };
}
