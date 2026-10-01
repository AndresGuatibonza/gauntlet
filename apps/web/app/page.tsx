/**
 * Landing page (PRD §8.5: "no signup required for initial value"). The
 * whole flow -- URL in, live progress, report -- happens in place; see
 * components/scan-experience.tsx.
 */
import { ScanExperience } from "@/components/scan-experience";

export default function HomePage(): React.JSX.Element {
  return <ScanExperience />;
}
