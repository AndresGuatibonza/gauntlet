/**
 * Server-side session access (Route Handlers, Server Components).
 * Identity comes from getClaims(), which verifies the access token's
 * signature on every call (Supabase's guidance: never trust getSession()
 * on the server). Any real failure -- auth not configured, Supabase
 * unreachable, invalid token -- reads as "signed out", never as an error
 * page. Next's own control-flow errors are rethrown (see below).
 */
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAuthConfig } from "./config";

export interface SessionUser {
  id: string;
  /** GitHub login when signed in with GitHub, else null. */
  login: string | null;
  avatarUrl: string | null;
}

export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  const config = readAuthConfig();
  if (!config) return null;
  const cookieStore = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components can't set cookies; the middleware refreshes the session instead.
        }
      },
    },
  });
}

function stringClaim(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The verified signed-in user, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) return null;
    const meta = data.claims["user_metadata"];
    return {
      id: data.claims.sub,
      login: stringClaim(meta, "user_name") ?? stringClaim(meta, "preferred_username"),
      avatarUrl: stringClaim(meta, "avatar_url"),
    };
  } catch (err) {
    // Next signals "this page reads cookies, render it per request" by
    // throwing; swallowing that would prerender pages as signed out.
    unstable_rethrow(err);
    console.error("[auth] could not read the session:", err);
    return null;
  }
}
