"use client";

/**
 * The finished report (PRD §8.5): the hero "Best next experiment"
 * (nextAction === "build_this") first, then the rest, each via
 * opportunity-card.tsx with cited evidence resolved against this job's own
 * Evidence Packet. Owns the report's funnel and feedback events.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import type { EvidenceItem } from "@gauntlet/core";
import { FadeUp, StaggerItem, StaggerList } from "@/components/motion";
import { OpportunityCardView, type CardActions, type CardSection } from "@/components/opportunity-card";
import type { CardRating, ClientEvent } from "@/lib/events";
import type { ScanJobResponse } from "@/lib/scan-client";

/**
 * Sends one funnel/feedback event (POST /api/scans/:id/events). Never
 * throws: analytics must not break the report. `keepalive` lets an event
 * sent right before navigating away (Build this) still reach the server.
 */
export async function sendScanEvent(jobId: string, event: ClientEvent, keepalive = false): Promise<boolean> {
  try {
    const res = await fetch(`/api/scans/${jobId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      keepalive,
    });
    return res.ok;
  } catch {
    return false;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ScanReport({ job }: { job: ScanJobResponse }): React.JSX.Element {
  const router = useRouter();
  // Per-card rating/error, keyed by the card's index in the report.
  const [ratings, setRatings] = useState<Record<number, CardRating>>({});
  const [feedbackErrors, setFeedbackErrors] = useState<Record<number, string>>({});
  const reportViewedSent = useRef(false);
  // "cardIndex:section" keys already sent; the server dedupes per client
  // anyway, this only avoids repeat requests.
  const openedSections = useRef(new Set<string>());

  useEffect(() => {
    // Once per report shown; the server also dedupes per client.
    if (reportViewedSent.current) return;
    reportViewedSent.current = true;
    void sendScanEvent(job.id, { type: "report_viewed" });
  }, [job.id]);

  function rateCard(cardIndex: number, rating: CardRating): void {
    const previous = ratings[cardIndex];
    // Optimistic: show the choice immediately, roll back if it didn't save.
    setRatings((r) => ({ ...r, [cardIndex]: rating }));
    setFeedbackErrors(({ [cardIndex]: _cleared, ...rest }) => rest);
    void sendScanEvent(job.id, { type: "opportunity_feedback_submitted", cardIndex, rating }).then((ok) => {
      if (ok) return;
      setRatings(({ [cardIndex]: _failed, ...rest }) => (previous ? { ...rest, [cardIndex]: previous } : rest));
      setFeedbackErrors((e) => ({ ...e, [cardIndex]: "Couldn't save your rating. Please try again." }));
    });
  }

  function buildThis(cardIndex: number): void {
    void sendScanEvent(job.id, { type: "build_this_requested", cardIndex }, true);
    router.push(`/signup?from=${job.id}&card=${cardIndex}`);
  }

  function sectionOpened(cardIndex: number, section: CardSection): void {
    const key = `${cardIndex}:${section}`;
    if (openedSections.current.has(key)) return;
    openedSections.current.add(key);
    const type = section === "evidence" ? "evidence_viewed" : "opportunity_opened";
    void sendScanEvent(job.id, { type, cardIndex });
  }

  function actionsFor(cardIndex: number): CardActions {
    return {
      onSectionOpened: (section) => sectionOpened(cardIndex, section),
      rating: ratings[cardIndex] ?? null,
      feedbackError: feedbackErrors[cardIndex] ?? null,
      onRate: (rating) => rateCard(cardIndex, rating),
      onBuildThis: () => buildThis(cardIndex),
    };
  }

  const cards = job.opportunityReport?.cards ?? [];
  // Keep each card's index in the report: events reference cards by it.
  const indexed = cards.map((card, index) => ({ card, index }));
  const hero = indexed.find(({ card }) => card.nextAction === "build_this");
  const rest = indexed.filter(({ card }) => card.nextAction !== "build_this");
  const dropped = (job.reviewRecords ?? []).filter((r) => r.verdict === "drop");
  const evidence = job.evidencePacket?.observedEvidence ?? [];
  const pagesRead = job.evidencePacket?.surfaceMap.pagesInspected.length ?? 0;
  const evidenceById = new Map<string, EvidenceItem>(evidence.map((item) => [item.id, item]));

  return (
    <>
      <FadeUp>
        <h2 className="report-title">{plural(cards.length, "opportunity", "opportunities")} worth testing</h2>
        <p className="report-summary">
          Ranked by impact, evidence and effort, from {plural(evidence.length, "piece", "pieces")} of evidence across{" "}
          {plural(pagesRead, "public page", "public pages")}. The first one is the experiment to run next.
        </p>
      </FadeUp>

      <StaggerList className="card-stack">
        {hero && (
          <StaggerItem>
            <OpportunityCardView card={hero.card} isHero evidenceById={evidenceById} actions={actionsFor(hero.index)} />
          </StaggerItem>
        )}
        {rest.map(({ card, index }) => (
          <StaggerItem key={index}>
            <OpportunityCardView card={card} evidenceById={evidenceById} actions={actionsFor(index)} />
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
        <Link
          href={`/signup?from=${job.id}`}
          onClick={() => void sendScanEvent(job.id, { type: "deepen_analysis_clicked" }, true)}
        >
          <motion.button style={{ marginTop: 20 }} whileTap={{ scale: 0.97 }}>
            Make this recommendation smarter &#8594;
          </motion.button>
        </Link>
      </FadeUp>
    </>
  );
}
