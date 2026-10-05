"use client";

/**
 * The whole scan flow on one page: paste a URL -> the input morphs into a
 * compact bar holding the scanned site -> the stage tracker and a live
 * activity line show what the scan is doing -> the report appears in place.
 *
 * Which scan is on screen is derived from the URL (/scans/<id>), never
 * held separately: after a scan starts, history.pushState moves the
 * address to /scans/<id> without a reload (Next.js syncs usePathname with
 * it), so the report is shareable, survives a refresh, and Back returns
 * to the empty form. The /scans/[id] route renders this same component
 * for anyone opening a shared link.
 *
 * The stage tracker and its heading (status-tracker.tsx) are reused
 * unchanged; the activity line under it is the addition.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "framer-motion";
import { StatusTracker, useSteppedStage } from "@/components/status-tracker";
import { ActivityLine } from "@/components/activity-line";
import { ScanReport } from "@/components/scan-report";
import { storeClaimToken } from "@/lib/claim-storage";
import {
  activityLines,
  displayUrl,
  jobIdFromPath,
  useScanJob,
  type InFlightStage,
  type ScanJobResponse,
} from "@/lib/scan-client";

type Category = "ai_saas" | "ai_tool";

/** The serif heading above the tracker, unchanged from the original report page. */
const STAGE_HEADING: Record<InFlightStage, string> = {
  queued: "Queued…",
  scanning: "Scanning the site…",
  analyzing: "Product Scientist is generating opportunities…",
  reviewing: "Reviewer/Critic is checking each one…",
};

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];
const MORPH = { type: "spring", stiffness: 260, damping: 32 } as const;

/** A submitted scan whose job id may not be known yet (POST in flight). */
interface Submission {
  url: string;
  id: string | null;
}

export function ScanExperience(): React.JSX.Element {
  const pathname = usePathname();
  const routeJobId = jobIdFromPath(pathname);

  const [url, setUrl] = useState("");
  const [category, setCategory] = useState<Category>("ai_saas");
  const [formError, setFormError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);

  // Once the address shows the submitted scan (or the visitor navigated
  // anywhere else, e.g. Back), the URL is again the only source of truth.
  useEffect(() => {
    setSubmission(null);
  }, [routeJobId]);

  // A new submission wins over the scan in the address (e.g. retrying from a failed one).
  const activeJobId = submission ? submission.id : routeJobId;
  const { job, pollError } = useScanJob(activeJobId);

  const failedJob = job?.status === "failed" ? job : null;
  // Pre-fill the form with the URL that failed, so retrying is one click.
  const failedUrl = failedJob?.url ?? null;
  useEffect(() => {
    if (failedUrl) setUrl(failedUrl);
  }, [failedUrl]);

  const view: "form" | "progress" | "report" =
    submission !== null
      ? "progress"
      : !activeJobId || failedJob
        ? "form"
        : job?.status === "done" && job.opportunityReport
          ? "report"
          : "progress";

  async function startScan(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    setSubmission({ url, id: null });
    try {
      const res = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, category }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status}).`);
      }
      const { id, claimToken } = (await res.json()) as { id: string; claimToken?: string };
      if (claimToken) storeClaimToken(id, claimToken);
      setSubmission({ url, id });
      window.history.pushState(null, "", `/scans/${id}`);
    } catch (err) {
      setSubmission(null);
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  function scanAnother(): void {
    setUrl("");
    setFormError(null);
    window.history.pushState(null, "", "/");
  }

  const barUrl = submission?.url ?? job?.url ?? "";

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        <AnimatePresence initial={false}>
          {view === "form" && !failedJob && (
            <motion.div
              key="intro"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
            >
              <p className="eyebrow">Product Scientist &amp; Fast-Value Loop</p>
              <h1 className="intro-title">Gauntlet</h1>
              <p className="lede">
                Paste a public product URL. Gauntlet reads its public pages, then a Product Scientist and a
                Reviewer/Critic rank 3&ndash;5 evidence-backed opportunities, with the single best experiment to run
                first. No account needed.
              </p>
            </motion.div>
          )}
          {failedJob && view === "form" && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
            >
              <h1 className="failed-title">We couldn&apos;t finish scanning {displayUrl(failedJob.url).host}</h1>
              <p className="failed-reason">{failedJob.errorMessage}</p>
              <p className="muted" style={{ fontSize: 14, margin: "8px 0 0" }}>
                Check the address or try another product.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {view === "form" ? (
          <ScanForm
            url={url}
            onUrlChange={setUrl}
            category={category}
            onCategoryChange={setCategory}
            onSubmit={startScan}
            error={formError}
            submitLabel={failedJob ? "Try again" : "Scan this product"}
          />
        ) : (
          <ScanBar url={barUrl} onScanAnother={view === "report" ? scanAnother : undefined} />
        )}

        <AnimatePresence mode="wait">
          {view === "progress" && (
            <motion.div
              key="progress"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT, delay: 0.15 } }}
              exit={{ opacity: 0, y: -12, transition: { duration: 0.3, ease: "easeIn" } }}
            >
              <ScanProgress job={job} pollError={pollError} />
            </motion.div>
          )}
          {view === "report" && job && (
            <motion.div key={`report-${job.id}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <ScanReport job={job} />
            </motion.div>
          )}
        </AnimatePresence>
      </LayoutGroup>
    </MotionConfig>
  );
}

function ScanForm(props: {
  url: string;
  onUrlChange: (url: string) => void;
  category: Category;
  onCategoryChange: (category: Category) => void;
  onSubmit: (e: React.FormEvent) => void;
  error: string | null;
  submitLabel: string;
}): React.JSX.Element {
  return (
    <div className="scan-form">
      <motion.form layoutId="scan-field" transition={MORPH} className="scan-field" onSubmit={props.onSubmit}>
        <input
          type="url"
          required
          aria-label="Public product URL"
          placeholder="https://your-product.com"
          value={props.url}
          onChange={(e) => props.onUrlChange(e.target.value)}
        />
        <motion.button type="submit" disabled={props.url.length === 0} whileTap={{ scale: 0.97 }}>
          {props.submitLabel}
        </motion.button>
      </motion.form>
      <motion.fieldset
        className="scan-options"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { delay: 0.2 } }}
      >
        <legend className="visually-hidden">Product category</legend>
        {(
          [
            ["ai_saas", "AI SaaS"],
            ["ai_tool", "AI tool"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="muted">
            <input
              type="radio"
              name="category"
              checked={props.category === value}
              onChange={() => props.onCategoryChange(value)}
            />{" "}
            {label}
          </label>
        ))}
      </motion.fieldset>
      <AnimatePresence>
        {props.error && (
          <motion.p
            className="error"
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{ marginTop: 4, fontSize: 14 }}
          >
            {props.error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The input, collapsed: which site is being scanned, and a way to start over once the report is in. */
function ScanBar({ url, onScanAnother }: { url: string; onScanAnother?: () => void }): React.JSX.Element {
  const { host, rest } = displayUrl(url);
  return (
    <motion.div layoutId="scan-field" transition={MORPH} className="scan-bar">
      <motion.p className="scan-bar-target" layout="position" title={url}>
        <span className="scan-bar-host">{host}</span>
        {rest && <span className="scan-bar-rest">{rest}</span>}
      </motion.p>
      <AnimatePresence>
        {onScanAnother && (
          <motion.button
            key="again"
            type="button"
            className="secondary compact"
            onClick={onScanAnother}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0, transition: { delay: 0.3 } }}
            exit={{ opacity: 0 }}
          >
            Scan another
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** The original loading section (heading + stage tracker), plus the live activity line. */
function ScanProgress({ job, pollError }: { job: ScanJobResponse | null; pollError: string | null }): React.JSX.Element {
  const liveStage: InFlightStage =
    !job || job.status === "done" || job.status === "failed" ? (job ? "reviewing" : "queued") : job.status;
  const shownStage = useSteppedStage(liveStage);
  return (
    <div className="scan-progress">
      <p style={{ fontFamily: "var(--serif)", fontSize: 22, marginTop: 10 }}>{STAGE_HEADING[shownStage]}</p>
      <StatusTracker current={shownStage} />
      <ActivityLine lines={activityLines(shownStage, job)} />
      <p className="muted" style={{ fontSize: 14 }}>This page updates on its own &mdash; no need to refresh.</p>
      {pollError && <p className="muted" style={{ fontSize: 13 }}>(one poll attempt failed, retrying: {pollError})</p>}
    </div>
  );
}
