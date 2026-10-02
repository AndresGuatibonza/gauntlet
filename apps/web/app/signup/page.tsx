/**
 * Placeholder only (confirmed with Andres: "solo un placeholder por
 * ahora" -- real auth is out of scope for Build Order #3). Keeps the
 * originating scan id in the URL so that when real signup lands, wiring
 * "carry this report over into the new account" (PRD §8.5) has a job id
 * to attach, instead of that state having been silently dropped here.
 * The "Connect your repository" link under a card's implementation brief
 * also passes the card (`card`, its index in the report), so the selected
 * opportunity survives the hop (PRD §17: "preserves the selected
 * opportunity through signup"); repo connection is what will turn that
 * brief repo-aware (Build Order #4).
 */
import Link from "next/link";
import { FadeUp } from "@/components/motion";

export default async function SignupPlaceholderPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; card?: string }>;
}): Promise<React.JSX.Element> {
  const { from, card } = await searchParams;
  const cardNumber = card !== undefined && /^\d{1,2}$/.test(card) ? Number(card) + 1 : null;
  return (
    <FadeUp>
      <p className="eyebrow">Coming soon</p>
      <h2 style={{ fontSize: 30, marginTop: 10 }}>Accounts aren&apos;t built yet</h2>
      <p className="lede">
        This is a placeholder. When account creation lands, it will pick up right where you left off
        {from ? ` (report ${from})` : ""} instead of starting over.
      </p>
      {cardNumber !== null && (
        <p className="muted" style={{ fontSize: 14, marginTop: 12 }}>
          You asked to connect your repository for opportunity #{cardNumber}, so its implementation brief can point at
          real files. We&apos;ve noted your interest.
        </p>
      )}
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
