/**
 * The signed-in user's saved reports, newest first (header "Reports"). Each
 * opens the report, where its briefs, experiments and repository live.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { FadeUp } from "@/components/motion";
import { SavedReportsList } from "@/components/saved-reports";
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { listSavedReportsForUser, type SavedReport } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ReportsPage(): Promise<React.JSX.Element> {
  if (!readAuthConfig()) redirect("/signup");
  const user = await getSessionUser();
  if (!user) redirect("/signup?next=/reports");

  let reports: SavedReport[] = [];
  let failed = false;
  try {
    reports = await listSavedReportsForUser(user.id);
  } catch (err) {
    console.error("[reports]", err);
    failed = true;
  }

  return (
    <FadeUp>
      <h1 className="ledger-title">Your reports</h1>
      <p className="lede">Every report you saved to your workspace. Open one to build, track or connect its repository.</p>
      {failed && <p className="error" role="alert">Couldn&apos;t load your reports. Please reload the page.</p>}
      {!failed && reports.length === 0 && (
        <p className="muted" style={{ marginTop: 28 }}>
          No saved reports yet. Scan a product, then sign in from its report to save it. <Link href="/">Scan a product</Link>
        </p>
      )}
      {reports.length > 0 && (
        <section className="saved-reports" aria-label="Saved reports">
          <SavedReportsList reports={reports} />
        </section>
      )}
    </FadeUp>
  );
}
