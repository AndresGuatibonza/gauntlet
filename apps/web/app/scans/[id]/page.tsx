"use client";

/**
 * Report page (PRD §8.5). Polls GET /api/scans/:id every 2.5s until the
 * job is "done" or "failed" -- no websockets/SSE for v0, a plain poll is
 * simpler and the job usually finishes in well under a minute anyway.
 *
 * Renders, per card: the hero "Best next experiment" (nextAction ===
 * "build_this") first, then the rest; for each card, the
 * observation/evidenceRefs side ("what Gauntlet can see from public
 * surface") against missingEvidence ("what connecting repo/data would
 * confirm") -- straight from the existing Opportunity Card contract
 * fields, no new copy invented to fill that PRD requirement.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import type { OpportunityCard, ReviewRecord } from "@gauntlet/core";
import { FadeUp, StaggerItem, StaggerList } from "@/components/motion";
import { StatusTracker, useSteppedStage } from "@/components/status-tracker";

type ScanJobStatus = "queued" | "scanning" | "analyzing" | "reviewing" | "done" | "failed";

interface ScanJobResponse {
  id: string;
  url: string;
  status: ScanJobStatus;
  opportunityReport: { cards: OpportunityCard[] } | null;
  reviewRecords: ReviewRecord[] | null;
  errorMessage: string | null;
}

const STATUS_LABEL: Record<ScanJobStatus, string> = {
  queued: "Queued…",
  scanning: "Scanning the site…",
  analyzing: "Product Scientist is generating opportunities…",
  reviewing: "Reviewer/Critic is checking each one…",
  done: "Done",
  failed: "Failed",
};

export default function ScanReportPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const [job, setJob] = useState<ScanJobResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  // Paced display stage (see status-tracker.tsx). Called unconditionally,
  // before any early return, per the Rules of Hooks; "failed"/"done" never
  // reach the tracker, so they map to the last in-flight stage here.
  const liveStage = !job || job.status === "done" || job.status === "failed" ? "reviewing" : job.status;
  const shownStage = useSteppedStage(job ? liveStage : "queued");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/scans/${params.id}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status}).`);
        }
        const data = (await res.json()) as ScanJobResponse;
        if (cancelled) return;
        setJob(data);
        setPollError(null);
        if (data.status !== "done" && data.status !== "failed") {
          timer = setTimeout(poll, 2500);
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : String(err));
        // Keep polling even after a transient error (e.g. one flaky
        // request) -- only stop if the job itself reaches a final state.
        timer = setTimeout(poll, 2500);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [params.id]);

  if (!job) {
    return <p className="muted">{pollError ?? "Loading…"}</p>;
  }

  if (job.status === "failed") {
    return (
      <FadeUp>
        <p className="error">Scan failed: {job.errorMessage}</p>
        <Link href="/">
          <button className="secondary">Try another URL</button>
        </Link>
      </FadeUp>
    );
  }

  if (job.status !== "done" || !job.opportunityReport) {
    return (
      <FadeUp>
        <p className="eyebrow">Report for {job.url}</p>
        <p style={{ fontFamily: "var(--serif)", fontSize: 22, marginTop: 10 }}>{STATUS_LABEL[shownStage]}</p>
        <StatusTracker current={shownStage} />
        <p className="muted" style={{ fontSize: 14 }}>This page updates on its own &mdash; no need to refresh.</p>
        {pollError && <p className="muted" style={{ fontSize: 13 }}>(one poll attempt failed, retrying: {pollError})</p>}
      </FadeUp>
    );
  }

  const cards = job.opportunityReport.cards;
  const hero = cards.find((c) => c.nextAction === "build_this");
  const rest = cards.filter((c) => c.nextAction !== "build_this");
  const dropped = (job.reviewRecords ?? []).filter((r) => r.verdict === "drop");

  return (
    <>
      <FadeUp>
        <p className="eyebrow">Report</p>
        <p className="lede" style={{ marginTop: 6 }}>{job.url}</p>
      </FadeUp>

      <StaggerList>
        {hero && (
          <StaggerItem>
            <OpportunityCardView card={hero} isHero />
          </StaggerItem>
        )}
        {rest.map((card, i) => (
          <StaggerItem key={i}>
            <OpportunityCardView card={card} />
          </StaggerItem>
        ))}
      </StaggerList>

      {dropped.length > 0 && (
        <FadeUp delay={0.2}>
          <p className="muted" style={{ fontSize: 13 }}>
            The Reviewer/Critic dropped {dropped.length} additional candidate{dropped.length > 1 ? "s" : ""} that
            didn&apos;t hold up to evidence review.
          </p>
        </FadeUp>
      )}

      <FadeUp delay={0.25}>
        <Link href={`/signup?from=${job.id}`}>
          <motion.button style={{ marginTop: 20 }} whileTap={{ scale: 0.97 }}>
            Make this recommendation smarter &#8594;
          </motion.button>
        </Link>
      </FadeUp>
    </>
  );
}

function OpportunityCardView({ card, isHero }: { card: OpportunityCard; isHero?: boolean }): React.JSX.Element {
  return (
    <div className={isHero ? "card hero" : "card"}>
      {isHero && <span className="badge">Best next experiment</span>}
      <h2 style={{ fontSize: isHero ? 28 : 22, marginTop: isHero ? 14 : 0 }}>{card.title}</h2>
      <p className="muted" style={{ marginTop: 10 }}>{card.hypothesis}</p>
      <div className="metrics">
        <div className="metric">
          <strong>Impact</strong>
          {card.expectedImpact.level}
        </div>
        <div className="metric">
          <strong>Effort</strong>
          {card.effort.level}
        </div>
        <div className="metric">
          <strong>Confidence</strong>
          {card.confidence.level}
        </div>
        <div className="metric">
          <strong>Evidence quality</strong>
          {card.confidence.evidenceQualityScore}/3
        </div>
      </div>
      <div className="evidence-split">
        <div>
          <strong>What Gauntlet can see from the public surface</strong>
          {card.observation}
        </div>
        <div>
          <strong>What connecting repo/analytics data would confirm</strong>
          {card.missingEvidence}
        </div>
      </div>
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer" }}>Proposed experiment</summary>
        <p style={{ fontSize: 14 }} className="muted">
          <strong style={{ color: "var(--ink)" }}>Control:</strong> {card.experiment.control}
          <br />
          <strong style={{ color: "var(--ink)" }}>Variant:</strong> {card.experiment.variant}
          <br />
          <strong style={{ color: "var(--ink)" }}>Primary metric:</strong> {card.experiment.primaryMetric}
          <br />
          <strong style={{ color: "var(--ink)" }}>Stopping rule:</strong> {card.experiment.stoppingRule}
        </p>
      </details>
    </div>
  );
}
