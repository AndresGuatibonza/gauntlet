/**
 * Browser-side view of a scan job: the shape GET /api/scans/:id returns,
 * the polling hook, and the activity-line copy shown under the stage
 * tracker while a scan runs.
 */
"use client";

import { useEffect, useState } from "react";
import type { EvidencePacket, OpportunityCard, ReviewRecord } from "@gauntlet/core";
import type { ScanProgress } from "./progress";

export type ScanJobStatus = "queued" | "scanning" | "analyzing" | "reviewing" | "done" | "failed";
export type InFlightStage = "queued" | "scanning" | "analyzing" | "reviewing";

export interface ScanJobResponse {
  id: string;
  url: string;
  status: ScanJobStatus;
  evidencePacket: EvidencePacket | null;
  opportunityReport: { cards: OpportunityCard[] } | null;
  reviewRecords: ReviewRecord[] | null;
  errorMessage: string | null;
  progress?: ScanProgress | null;
}

const JOB_PATH = /^\/scans\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** "/scans/<uuid>" -> "<uuid>"; anything else -> null. The URL is the source of truth for which scan is shown. */
export function jobIdFromPath(pathname: string | null): string | null {
  return pathname?.match(JOB_PATH)?.[1] ?? null;
}

export const POLL_INTERVAL_MS = 2500;

/**
 * Polls GET /api/scans/:id until the job is done or failed. Keeps polling
 * through a transient error (one flaky request) and reports it; only a
 * final job state stops it. Returns nothing for a null id.
 */
export function useScanJob(jobId: string | null): { job: ScanJobResponse | null; pollError: string | null } {
  const [job, setJob] = useState<ScanJobResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    setJob(null);
    setPollError(null);
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/scans/${jobId}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status}).`);
        }
        const data = (await res.json()) as ScanJobResponse;
        if (cancelled) return;
        setJob(data);
        setPollError(null);
        if (data.status !== "done" && data.status !== "failed") {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  // Never hand back the previous scan's job while the new one loads.
  return { job: job && job.id === jobId ? job : null, pollError };
}

/**
 * A few plain words per stage (Khalil's request) describing what that
 * stage really does. Shown when the scan hasn't reported a more specific
 * step, and rotated during the two long Claude calls, which can't report
 * finer progress of their own.
 */
export const STAGE_PHRASES: Record<InFlightStage, readonly string[]> = {
  queued: ["Getting things ready"],
  scanning: ["Checking your application", "Reading your public pages"],
  analyzing: ["Running through design choices", "Looking for what to test next", "Drafting opportunities"],
  reviewing: ["Challenging each recommendation", "Checking every claim against the evidence", "Ranking what holds up"],
};

/**
 * The lines the activity line cycles through for the stage on screen.
 * The scan's own progress message comes first, but only while the job is
 * really in that stage AND that is the stage displayed -- so a message is
 * never shown under the wrong stage while the tracker catches up.
 * While scanning, a real message is shown alone: it changes page by page.
 */
export function activityLines(shownStage: InFlightStage, job: ScanJobResponse | null): string[] {
  const phrases = [...STAGE_PHRASES[shownStage]];
  const progress = job?.progress;
  if (!progress || progress.status !== shownStage || job?.status !== shownStage) return phrases;
  if (shownStage === "scanning") return [progress.message];
  return [progress.message, ...phrases.filter((p) => p !== progress.message)];
}

/** "https://www.intercom.com/pricing" -> { host: "intercom.com", rest: "/pricing" }. */
export function displayUrl(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return { host: parsed.hostname.replace(/^www\./, ""), rest: `${path}${parsed.search}` };
  } catch {
    return { host: url, rest: "" };
  }
}
