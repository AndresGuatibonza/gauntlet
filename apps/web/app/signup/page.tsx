/**
 * Placeholder only (confirmed with Andres: "solo un placeholder por
 * ahora" -- real auth is out of scope for Build Order #3). Keeps the
 * originating scan id in the URL so that when real signup lands, wiring
 * "carry this report over into the new account" (PRD §8.5) has a job id
 * to attach, instead of that state having been silently dropped here.
 */
import Link from "next/link";

export default async function SignupPlaceholderPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}): Promise<React.JSX.Element> {
  const { from } = await searchParams;
  return (
    <div className="card">
      <h2>Coming soon</h2>
      <p className="muted">
        Account creation isn&apos;t built yet -- this is a placeholder. When it lands, it will pick up right
        where you left off{from ? ` (report ${from})` : ""} instead of starting over.
      </p>
      {from && (
        <Link href={`/scans/${from}`}>
          <button className="secondary">Back to report</button>
        </Link>
      )}
    </div>
  );
}
