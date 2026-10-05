/**
 * Sign in (PRD §8.6, §17): accounts exist so a report can be saved to a
 * workspace and its experiments tracked. Reached from a report ("Sign in
 * with GitHub", "Connect your repository") with ?from=<scan>&card=<n>; after
 * GitHub, the visitor returns to that report, which saves itself. Without
 * Supabase Auth configured the page says accounts aren't available, and
 * nothing else changes.
 */
import Link from "next/link";
import { FadeUp } from "@/components/motion";
import { SignInPanel } from "@/components/sign-in-panel";
import { readAuthConfig, safeNextPath } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, string> = {
  denied: "GitHub sign-in was cancelled.",
  missing_code: "GitHub didn't complete the sign-in. Please try again.",
  exchange: "The sign-in link expired or was already used. Please try again.",
  unavailable: "Sign-in isn't available right now.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; card?: string; next?: string; error?: string }>;
}): Promise<React.JSX.Element> {
  const { from, card, next, error } = await searchParams;
  const scanId = from && UUID.test(from) ? from : null;
  const returnTo = scanId ? `/scans/${scanId}` : safeNextPath(next, "/");
  const cardNumber = card !== undefined && /^\d{1,2}$/.test(card) ? Number(card) + 1 : null;

  if (!readAuthConfig()) {
    return (
      <FadeUp>
        <p className="eyebrow">Coming soon</p>
        <h2 style={{ fontSize: 30, marginTop: 10 }}>Accounts aren&apos;t available yet</h2>
        <p className="lede">Reports, briefs and feedback all work without an account in the meantime.</p>
        {scanId && (
          <Link href={returnTo}>
            <button className="secondary" style={{ marginTop: 24 }}>Back to report</button>
          </Link>
        )}
      </FadeUp>
    );
  }

  const user = await getSessionUser();
  if (user) {
    return (
      <FadeUp>
        <h2 style={{ fontSize: 30 }}>You&apos;re signed in{user.login ? ` as @${user.login}` : ""}</h2>
        <p className="lede">Reports you run in this browser are saved to your workspace when you open them.</p>
        <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
          <Link href={returnTo}>
            <button>{scanId ? "Back to report" : "Scan a product"}</button>
          </Link>
          <Link href="/ledger">
            <button className="secondary">Your experiments</button>
          </Link>
        </div>
      </FadeUp>
    );
  }

  return (
    <FadeUp>
      <h2 style={{ fontSize: 30 }}>Save this report and track what you test</h2>
      <p className="lede">
        Sign in to keep {scanId ? "this report" : "your reports"} in a workspace and record what each experiment showed and
        what you decided.
        {cardNumber !== null &&
          ` Connecting a repository to make opportunity #${cardNumber}'s brief point at real files is the next step after this.`}
      </p>
      {error && ERRORS[error] && (
        <p className="error" role="alert" style={{ fontSize: 14, marginTop: 16 }}>
          {ERRORS[error]}
        </p>
      )}
      <SignInPanel next={returnTo} scanId={scanId} />
      {scanId && (
        <p style={{ marginTop: 20, fontSize: 14 }}>
          <Link href={returnTo}>Back to report</Link>
        </p>
      )}
    </FadeUp>
  );
}
