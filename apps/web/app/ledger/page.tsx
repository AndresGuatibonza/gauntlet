/**
 * The signed-in user's Experiment Ledger (PRD Build Order #7: "learning
 * compounds across iterations"): every experiment started from their saved
 * reports, with its status, result, decision and outcome, newest first.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { FadeUp } from "@/components/motion";
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { listExperimentsForUser, type LedgerEntry } from "@/lib/store";

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
  let failed = false;
  try {
    entries = await listExperimentsForUser(user.id);
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
          Nothing here yet. Scan a product, then use <strong>Build this</strong> on an opportunity to start one.{" "}
          <Link href="/">Scan a product</Link>
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
