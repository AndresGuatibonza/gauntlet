/**
 * Supabase Auth configuration (sign-in with GitHub). Optional by design:
 * without these two public values the app runs exactly as before --
 * anonymous scans, reports and briefs -- and every account feature says
 * sign-in isn't available instead of failing.
 *
 * Both values are public (they ship to the browser); the publishable key
 * only allows what the project's auth settings allow. Never put the
 * service-role / secret key here.
 */
export interface AuthConfig {
  url: string;
  publishableKey: string;
}

type Env = Record<string, string | undefined>;

export function readAuthConfig(env: Env = process.env): AuthConfig | null {
  const url = env["NEXT_PUBLIC_SUPABASE_URL"]?.trim();
  // Supabase's current name, with the legacy anon key accepted as a fallback.
  const publishableKey = (env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ?? env["NEXT_PUBLIC_SUPABASE_ANON_KEY"])?.trim();
  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}

/**
 * Only same-site paths may be redirect targets after sign-in: "/scans/..."
 * yes; "https://evil.example", "//evil.example" or "/\\evil" no.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  try {
    const parsed = new URL(next, "https://gauntlet.invalid");
    if (parsed.origin !== "https://gauntlet.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}
