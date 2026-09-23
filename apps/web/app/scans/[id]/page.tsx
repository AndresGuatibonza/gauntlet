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
import type { OpportunityCard, ReviewRecord } from "@gauntlet/core";

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
  queued: "Queued...",
  scanning: "Scanning the site...",
  analyzing: "Product Scientist is generating opportunities...",
  reviewing: "Reviewer/Critic is checking each one...",
  done: "Done",
  failed: "Failed",
};

export default function ScanReportPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const [job, setJob] = useState<ScanJobResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

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
    return <p className="muted">{pollError ?? "Loading..."}</p>;
  }

  if (job.status === "failed") {
    return (
      <div className="card">
        <p className="error">Scan failed: {job.errorMessage}</p>
        <Link href="/">
          <button className="secondary">Try another URL</button>
        </Link>
      </div>
    );
  }

  if (job.status !== "done" || !job.opportunityReport) {
    return (
      <div className="card">
        <p>{STATUS_LABEL[job.status]}</p>
        <p className="muted">Scanning {job.url} -- this page updates on its own, no need to refresh.</p>
        {pollError && <p className="muted">(one poll attempt failed, retrying: {pollError})</p>}
      </div>
    );
  }

  const cards = job.opportunityReport.cards;
  const hero = cards.find((c) => c.nextAction === "build_this");
  const rest = cards.filter((c) => c.nextAction !== "build_this");
  const dropped = (job.reviewRecords ?? []).filter((r) => r.verdict === "drop");

  return (
    <>
      <p className="muted">Report for {job.url}</p>
      {hero && <OpportunityCardView card={hero} isHero />}
      {rest.map((card, i) => (
        <OpportunityCardView key={i} card={card} />
      ))}
      {dropped.length > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          The Reviewer/Critic dropped {dropped.length} additional candidate{dropped.length > 1 ? "s" : ""} that
          didn&apos;t hold up to evidence review.
        </p>
      )}
      <Link href={`/signup?from=${job.id}`}>
        <button style={{ marginTop: 12 }}>Make this recommendation smarter -&gt;</button>
      </Link>
    </>
  );
}

function OpportunityCardView({ card, isHero }: { card: OpportunityCard; isHero?: boolean }): React.JSX.Element {
  return (
    <div className={isHero ? "card hero" : "card"}>
      {isHero && <span className="badge">Best next experiment</span>}
      <h2 style={{ marginTop: isHero ? 8 : 0 }}>{card.title}</h2>
      <p>{card.hypothesis}</p>
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
          <p style={{ margin: "6px 0 0" }}>{card.observation}</p>
        </div>
        <div>
          <strong>What connecting repo/analytics data would confirm</strong>
          <p style={{ margin: "6px 0 0" }}>{card.missingEvidence}</p>
        </div>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>
          Proposed experiment
        </summary>
        <p style={{ fontSize: 14 }}>
          <strong>Control:</strong> {card.experiment.control}
          <br />
          <strong>Variant:</strong> {card.experiment.variant}
          <br />
          <strong>Primary metric:</strong> {card.experiment.primaryMetric}
          <br />
          <strong>Stopping rule:</strong> {card.experiment.stoppingRule}
        </p>
      </details>
    </div>
  );
}
