/**
 * Keeps the Supabase session fresh: on each page request, getClaims()
 * refreshes an expiring access token and the new cookies are written to
 * both the request (for this render) and the response (for the browser).
 * The pattern follows Supabase's Next.js SSR guide; nothing may run between
 * creating the client and getClaims(), and the response object returned
 * must be the one carrying the cookies.
 *
 * Without auth configured it does nothing. API routes and static assets
 * are excluded: API routes read the session themselves when they need it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { readAuthConfig } from "@/lib/auth/config";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const config = readAuthConfig();
  if (!config) return response;

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  try {
    await supabase.auth.getClaims();
  } catch (err) {
    // An unreachable Auth server must not take pages down; the visitor is treated as signed out.
    console.error("[middleware] session refresh failed:", err);
  }
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
