/**
 * Placeholder only (confirmed with Andres: "solo un placeholder por
 * ahora" -- real auth is out of scope for Build Order #3). Keeps the
 * originating scan id in the URL so that when real signup lands, wiring
 * "carry this report over into the new account" (PRD §8.5) has a job id
 * to attach, instead of that state having been silently dropped here.
 */
import Link from "next/link";
import { FadeUp } from "@/components/motion";

export default async function SignupPlaceholderPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}): Promise<React.JSX.Element> {
  const { from } = await searchParams;
  return (
    <FadeUp>
      <p className="eyebrow">Coming soon</p>
      <h2 style={{ fontSize: 30, marginTop: 10 }}>Accounts aren&apos;t built yet</h2>
      <p className="lede">
        This is a placeholder. When account creation lands, it will pick up right where you left off
        {from ? ` (report ${from})` : ""} instead of starting over.
      </p>
      {from && (
        <Link href={`/scans/${from}`}>
          <button className="secondary" style={{ marginTop: 24 }}>
            Back to report
          </button>
        </Link>
      )}
    </FadeUp>
  );
}
