/**
 * The signed-in user's Experiment Ledger (PRD Build Order #7: "learning
 * compounds across iterations"): every experiment started from their saved
 * reports, with its status, result, decision and outcome, newest first --
 * then the saved reports themselves, the way back to start the next one.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { FadeUp } from "@/components/motion";
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { listExperimentsForUser, listSavedReportsForUser, type LedgerEntry, type SavedReport } from "@/lib/store";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { planned: "Planned", running: "Running" };
const DECISION: Record<string, string> = { ship: "Shipped", iterate: "Iterate", discard: "Discarded" };

function statusLabel(e: LedgerEntry): string {
  return e.record.status === "decided" ? (DECISION[e.record.decision ?? ""] ?? "Decided") : (STATUS[e.record.status] ?? e.record.status);
}

export default async function LedgerPage(): Promise<React.JSX.Element> {
  if (!readAuthConfig()) redirect("/signup");
  const user = await getSessionUser();
  if (!user) redirect("/signup?next=/ledger");

  let entries: LedgerEntry[] = [];
  let reports: SavedReport[] = [];
  let failed = false;
  try {
    [entries, reports] = await Promise.all([listExperimentsForUser(user.id), listSavedReportsForUser(user.id)]);
  } catch (err) {
    console.error("[ledger]", err);
    failed = true;
  }

  return (
    <FadeUp>
      <h1 className="ledger-title">Your experiments</h1>
      <p className="lede">Every experiment started with &ldquo;Build this&rdquo; on a report you saved, and what came of it.</p>
      {failed && <p className="error" role="alert">Couldn&apos;t load your experiments. Please reload the page.</p>}
      {!failed && entries.length === 0 && (
        <p className="muted" style={{ marginTop: 28 }}>
          {reports.length > 0 ? (
            <>
              No experiments yet. Open one of your saved reports below and use <strong>Build this</strong> on an
              opportunity to start one.
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
      {!failed && reports.length > 0 && <SavedReports reports={reports} />}
    </FadeUp>
  );
}

function SavedReports({ reports }: { reports: SavedReport[] }): React.JSX.Element {
  return (
    <section className="saved-reports" aria-labelledby="saved-reports-title">
      <h2 id="saved-reports-title" className="saved-reports-title">
        Saved reports
      </h2>
      <ul className="saved-report-list">
        {reports.map((r) => (
          <li key={r.scanId}>
            <Link href={`/scans/${r.scanId}`} className="saved-report">
              <span className="saved-report-name">{r.productName}</span>
              <span className="muted saved-report-meta">
                {new Date(r.scannedAt).toLocaleDateString("en-US", { dateStyle: "medium" })} &middot;{" "}
                {r.opportunityCount} {r.opportunityCount === 1 ? "opportunity" : "opportunities"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
