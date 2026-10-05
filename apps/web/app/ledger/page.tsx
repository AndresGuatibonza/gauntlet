/**
 * The signed-in user's Experiment Ledger (PRD Build Order #7: "learning
 * compounds across iterations"): every experiment started from their saved
 * reports, with its status, result, decision and outcome, newest first.
 * Saved reports themselves have their own page (/reports).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { FadeUp } from "@/components/motion";
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { listExperimentsForUser, listSavedReportsForUser, type LedgerEntry } from "@/lib/store";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { planned: "Planned", running: "Running" };
const DECISION: Record<string, string> = { ship: "Shipped", iterate: "Iterate", discard: "Discarded" };

function statusLabel(e: LedgerEntry): string {
  return e.record.status === "decided" ? (DECISION[e.record.decision ?? ""] ?? "Decided") : (STATUS[e.record.status] ?? e.record.status);
}

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // Coming back from GitHub with an expired or foreign state (app/api/github/callback).
  const githubExpired = (await searchParams)["github"] === "expired";
  if (!readAuthConfig()) redirect("/signup");
  const user = await getSessionUser();
  if (!user) redirect("/signup?next=/ledger");

  let entries: LedgerEntry[] = [];
  let reportCount = 0;
  let failed = false;
  try {
    const [found, reports] = await Promise.all([listExperimentsForUser(user.id), listSavedReportsForUser(user.id)]);
    entries = found;
    reportCount = reports.length;
  } catch (err) {
    console.error("[ledger]", err);
    failed = true;
  }

  return (
    <FadeUp>
      <h1 className="ledger-title">Your experiments</h1>
      <p className="lede">Every experiment started with &ldquo;Build this&rdquo; on a report you saved, and what came of it.</p>
      {githubExpired && (
        <p className="error" role="alert">
          That GitHub connection link expired or didn&apos;t start here. Open the report and connect GitHub again.
        </p>
      )}
      {failed && <p className="error" role="alert">Couldn&apos;t load your experiments. Please reload the page.</p>}
      {!failed && entries.length === 0 && (
        <p className="muted" style={{ marginTop: 28 }}>
          {reportCount > 0 ? (
            <>
              No experiments yet. Open one of <Link href="/reports">your saved reports</Link> and use{" "}
              <strong>Build this</strong> on an opportunity to start one.
            </>
          ) : (
            <>
              Nothing here yet. Scan a product, sign in from its report to save it, then use <strong>Build this</strong>{" "}
              on an opportunity to start an experiment. <Link href="/">Scan a product</Link>
            </>
          )}
        </p>
      )}
      <ol className="ledger-list">
        {entries.map((e) => (
          <li key={e.id} className="ledger-entry">
            <div className="ledger-entry-head">
              <span className={`tracker-status tracker-${e.record.status}`}>{statusLabel(e)}</span>
              <span className="muted ledger-product">{e.productName}</span>
            </div>
            <Link href={`/scans/${e.scanJobId}`} className="ledger-card">
              {e.cardTitle}
            </Link>
            <p className="muted ledger-hypothesis">{e.record.hypothesis}</p>
            <p className="ledger-meta">
              Flag <code>{e.record.change.featureFlag}</code>
              {e.decidedAt ? ` · decided ${new Date(e.decidedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}
            </p>
            {e.record.result && (
              <p className="tracker-line">
                <strong>Result:</strong> {e.record.result}
              </p>
            )}
            {e.record.outcome && (
              <p className="tracker-line">
                <strong>Outcome:</strong> {e.record.outcome}
              </p>
            )}
          </li>
        ))}
      </ol>
    </FadeUp>
  );
}
