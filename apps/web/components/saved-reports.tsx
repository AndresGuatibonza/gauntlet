/**
 * The finished reports saved to the user's workspaces (/reports): the way
 * back to any report without its link.
 */
import Link from "next/link";
import type { SavedReport } from "@/lib/store";

export function SavedReportsList({ reports }: { reports: SavedReport[] }): React.JSX.Element {
  return (
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
  );
}
