/**
 * Header account area (server component): "Sign in" when signed out,
 * "@login · Experiments · Sign out" when signed in, nothing when accounts
 * aren't configured. Reads the verified session (getClaims).
 */
import Link from "next/link";
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";

export async function AccountNav(): Promise<React.JSX.Element | null> {
  if (!readAuthConfig()) return null;
  const user = await getSessionUser();
  if (!user) {
    return (
      <Link href="/signup" className="account-link">
        Sign in
      </Link>
    );
  }
  return (
    <nav className="account-nav" aria-label="Account">
      <Link href="/ledger" className="account-link">
        Experiments
      </Link>
      <form action="/auth/signout" method="post">
        <button type="submit" className="account-signout" title={user.login ? `Signed in as @${user.login}` : "Signed in"}>
          Sign out
        </button>
      </form>
    </nav>
  );
}
