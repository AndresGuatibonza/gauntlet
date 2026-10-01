/**
 * A shared or refreshed report link (/scans/<id>). Renders the same
 * single-page flow as the landing page, which reads the scan id from the
 * address -- so a link opened mid-scan shows live progress, and a finished
 * one shows the report.
 */
import { ScanExperience } from "@/components/scan-experience";

export default function ScanReportPage(): React.JSX.Element {
  return <ScanExperience />;
}
