"use client";

/**
 * The finished report (PRD §8.5): the hero "Best next experiment"
 * (nextAction === "build_this") first, then the rest, each via
 * opportunity-card.tsx with cited evidence resolved against this job's own
 * Evidence Packet. Owns the report's funnel and feedback events.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import type { EvidenceItem } from "@gauntlet/core";
import { FadeUp, StaggerItem, StaggerList } from "@/components/motion";
import { OpportunityCardView, type CardActions, type CardSection } from "@/components/opportunity-card";
import type { CardRating, ClientEvent } from "@/lib/events";
import type { ScanJobResponse } from "@/lib/scan-client";
import { ActionPackagePanel, type PackageView } from "@/components/action-package-panel";
import { ExperimentTracker } from "@/components/experiment-tracker";
import { useViewer, type ClaimState, type Viewer } from "@/lib/use-viewer";
import { useRepository } from "@/lib/use-repository";
import { RepoConnection } from "@/components/repo-connection";

/** What came back from the GitHub round trip (?github=...), in words. */
const GITHUB_RETURN: Record<string, { text: string; error: boolean }> = {
  connected: { text: "GitHub is connected. Choose this product's repository under a brief to write a repo-aware version.", error: false },
  no_repos: { text: "The Gauntlet GitHub app can't read any repository for your account yet. Give it access to this product's repository on GitHub, then connect again.", error: true },
  denied: { text: "The GitHub connection was cancelled.", error: true },
  not_owner: { text: "Only the account that saved this report can connect a repository to it.", error: true },
  unavailable: { text: "Connecting GitHub isn't available right now.", error: true },
  error: { text: "Couldn't connect GitHub. Please try again.", error: true },
};

/** Reads ?github=... once, then removes it from the address bar. */
function useGitHubReturn(): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const github = url.searchParams.get("github");
    if (!github) return;
    setValue(github in GITHUB_RETURN ? github : "error");
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  return value;
}

const PACKAGE_POLL_MS = 3000;
/** Generation runs inside one 300 s function; stop polling well after that. */
const PACKAGE_POLL_LIMIT_MS = 6 * 60 * 1000;

type PackageResponse =
  | { status: "ready"; package: Extract<PackageView, { status: "ready" }>["package"]; codingAgentPrompt: string; markdown: string }
  | { status: "generating" }
  | { status: "failed"; error: string; canRetry: boolean }
  | { status: "none" };

/** Turns one package API response into what the card shows; null = keep polling. */
function toPackageView(res: Response, body: (PackageResponse & { error?: string }) | null): PackageView | null {
  if (!body) return { status: "failed", error: `Request failed (${res.status}).`, canRetry: true };
  if (res.status === 429) return { status: "failed", error: body.error ?? "Limit reached for now.", canRetry: false };
  if (!res.ok && res.status !== 202) return { status: "failed", error: body.error ?? `Request failed (${res.status}).`, canRetry: res.status >= 500 };
  switch (body.status) {
    case "ready":
      return { status: "ready", package: body.package, codingAgentPrompt: body.codingAgentPrompt, markdown: body.markdown };
    case "failed":
      return { status: "failed", error: body.error, canRetry: body.canRetry };
    case "generating":
      return null;
    default:
      return { status: "failed", error: "The implementation brief could not be started.", canRetry: true };
  }
}

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
  // Per-card rating/error, keyed by the card's index in the report.
  const [ratings, setRatings] = useState<Record<number, CardRating>>({});
  const [feedbackErrors, setFeedbackErrors] = useState<Record<number, string>>({});
  const reportViewedSent = useRef(false);
  // "cardIndex:section" keys already sent; the server dedupes per client
  // anyway, this only avoids repeat requests.
  const openedSections = useRef(new Set<string>());
  // "Build this" implementation briefs, per card index.
  const [packages, setPackages] = useState<Record<number, PackageView>>({});
  const pollTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const { viewer, hasToken, claimState, claimError } = useViewer(job.id);
  const signInHref = `/signup?from=${job.id}`;
  const repo = useRepository(job.id, viewer?.isOwner === true);
  const githubReturn = useGitHubReturn();

  useEffect(() => {
    const timers = pollTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

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

  function setPackage(cardIndex: number, view: PackageView): void {
    setPackages((p) => ({ ...p, [cardIndex]: view }));
  }

  /** Requests the brief (POST), then polls (GET) until it is ready or failed. */
  async function requestPackage(cardIndex: number): Promise<void> {
    const url = `/api/scans/${job.id}/cards/${cardIndex}/package`;
    const startedAt = Date.now();
    setPackage(cardIndex, { status: "generating" });

    async function step(method: "POST" | "GET"): Promise<void> {
      let view: PackageView | null;
      try {
        const res = await fetch(url, { method, cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (PackageResponse & { error?: string }) | null;
        view = toPackageView(res, body);
      } catch {
        view = Date.now() - startedAt < PACKAGE_POLL_LIMIT_MS ? null : { status: "failed", error: "Lost connection while writing the brief.", canRetry: true };
      }
      if (view) {
        setPackage(cardIndex, view);
        return;
      }
      if (Date.now() - startedAt > PACKAGE_POLL_LIMIT_MS) {
        setPackage(cardIndex, { status: "failed", error: "Writing the brief is taking too long. Please try again.", canRetry: true });
        return;
      }
      pollTimers.current.set(cardIndex, setTimeout(() => void step("GET"), PACKAGE_POLL_MS));
    }

    await step("POST");
  }

  function buildThis(cardIndex: number): void {
    void sendScanEvent(job.id, { type: "build_this_requested", cardIndex });
    void requestPackage(cardIndex);
  }

  function sectionOpened(cardIndex: number, section: CardSection): void {
    const key = `${cardIndex}:${section}`;
    if (openedSections.current.has(key)) return;
    openedSections.current.add(key);
    const type = section === "evidence" ? "evidence_viewed" : "opportunity_opened";
    void sendScanEvent(job.id, { type, cardIndex });
  }

  /** Under a ready brief: ledger tracking for the owner, or how to get it. */
  function trackingFor(cardIndex: number): React.ReactNode {
    if (viewer?.isOwner) return <ExperimentTracker scanId={job.id} cardIndex={cardIndex} />;
    if (viewer?.authAvailable && !viewer.signedIn && hasToken) {
      return (
        <p className="tracker-note">
          <a href={signInHref}>Sign in with GitHub</a> to save this report and track this experiment&apos;s result.
        </p>
      );
    }
    return null;
  }

  function actionsFor(cardIndex: number): CardActions {
    return {
      onSectionOpened: (section) => sectionOpened(cardIndex, section),
      rating: ratings[cardIndex] ?? null,
      feedbackError: feedbackErrors[cardIndex] ?? null,
      onRate: (rating) => rateCard(cardIndex, rating),
      onBuildThis: () => buildThis(cardIndex),
      buildBusy: packages[cardIndex]?.status === "generating",
      packageSlot: packages[cardIndex] ? (
        <ActionPackagePanel
          view={packages[cardIndex]}
          onRetry={() => void requestPackage(cardIndex)}
          connectRepoHref={`/signup?from=${job.id}&card=${cardIndex}`}
          tracking={trackingFor(cardIndex)}
          repoSlot={viewer?.isOwner ? <RepoConnection scanId={job.id} cardIndex={cardIndex} repo={repo} /> : undefined}
        />
      ) : null,
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
        <AccountBanner
          viewer={viewer}
          hasToken={hasToken}
          claimState={claimState}
          claimError={claimError}
          signInHref={signInHref}
        />
        {githubReturn && (
          <p className={`account-banner${GITHUB_RETURN[githubReturn]!.error ? " error" : ""}`} role={GITHUB_RETURN[githubReturn]!.error ? "alert" : "status"}>
            {GITHUB_RETURN[githubReturn]!.text}
          </p>
        )}
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

/** One line about saving the report: the offer to sign in, or where it was saved. Silent otherwise. */
function AccountBanner({
  viewer,
  hasToken,
  claimState,
  claimError,
  signInHref,
}: {
  viewer: Viewer | null;
  hasToken: boolean;
  claimState: ClaimState;
  claimError: string | null;
  signInHref: string;
}): React.JSX.Element | null {
  if (!viewer?.authAvailable) return null;
  if (claimState === "error" && claimError) {
    return <p className="account-banner error" role="alert">{claimError}</p>;
  }
  if (claimState === "saving") return <p className="account-banner muted">Saving this report to your workspace…</p>;
  if (viewer.isOwner) {
    return (
      <p className="account-banner">
        {claimState === "saved" ? "Saved to your workspace." : "In your workspace."} <a href="/ledger">Your experiments</a>
      </p>
    );
  }
  if (!viewer.signedIn && hasToken) {
    return (
      <p className="account-banner">
        <a href={signInHref}>Sign in with GitHub</a>{" "}
        to save this report and track the experiments you run from it.
      </p>
    );
  }
  return null;
}
