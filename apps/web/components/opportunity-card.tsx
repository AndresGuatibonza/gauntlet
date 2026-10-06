"use client";

/**
 * One Opportunity Card, rendered per PRD §8.5's report structure:
 * observation -> why it matters -> hypothesis -> proposed experiment ->
 * success metric -> evidence, plus the visible confidence boundary
 * ("what Gauntlet can see" vs "what connecting data would confirm").
 *
 * Every field comes straight from the Opportunity Card contract (§2) or
 * the Evidence Packet (§1) -- no copy invented to fill the layout. PRD
 * §8.5 also lists "assumptions"; the contract has no such field, so it is
 * deliberately not rendered rather than synthesized here.
 *
 * Cited evidence is resolved against the job's own Evidence Packet, so
 * the reader sees the actual excerpt and source page behind each claim --
 * the thing that makes a recommendation defensible rather than generic.
 *
 * Layout is compact so a report reads as a ranked list first: the header
 * (rank, change surface, title, score chips) is always visible; the body
 * (hypothesis, then Summary / Evidence / Experiment tabs, then actions) is
 * expanded on the hero only and toggled from the title on the others.
 *
 * Actions (optional, so the card stays a plain presentational component):
 * the PRD's primary "Build this" CTA and the contract §4 five-point
 * rating. The component only reports clicks; the page owns sending them.
 */
import { useId, useState } from "react";
import type { ChangeSurface, EvidenceItem, OpportunityCard } from "@gauntlet/core";
import { CARD_RATINGS, CARD_RATING_LABEL, type CardRating } from "@/lib/events";

const CHANGE_SURFACE_LABEL: Record<ChangeSurface, string> = {
  prompt: "Prompt",
  model: "Model",
  ux: "UX / messaging",
  backend: "Backend",
  data: "Data",
  tool: "Tooling",
  reliability: "Reliability",
  other: "Other",
};

/** Long raw excerpts are trimmed for display; the full text stays in the packet. */
export const MAX_EXCERPT_CHARS = 280;

export function truncateExcerpt(text: string, max = MAX_EXCERPT_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Only http(s) sources become links. Evidence URLs come from our own
 * same-origin crawler, but zod's .url() also accepts schemes like
 * "javascript:", so the check is here, at the point of rendering an href.
 */
export function safeSourceLink(url: string): { href: string; label: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return { href: parsed.toString(), label: `${parsed.hostname}${path}` };
  } catch {
    return null;
  }
}

export type CardSection = "evidence" | "experiment";

export interface CardActions {
  rating: CardRating | null;
  feedbackError: string | null;
  onRate: (rating: CardRating) => void;
  onBuildThis: () => void;
  /** True while the implementation brief is being written: the button can't start a second one. */
  buildBusy?: boolean;
  /** Rendered under the actions: the "Build this" implementation brief, once requested. */
  packageSlot?: React.ReactNode;
  /** The visitor switched to the Evidence or Experiment tab (not fired for the tab already shown). */
  onSectionOpened: (section: CardSection) => void;
}

const LEVEL_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

type CardTab = "summary" | "evidence" | "experiment";

export function OpportunityCardView({
  card,
  isHero,
  rank,
  evidenceById,
  actions,
  briefReady,
}: {
  card: OpportunityCard;
  isHero?: boolean;
  /** Position in the report (1 = the hero), shown before the change surface. */
  rank?: number;
  evidenceById: ReadonlyMap<string, EvidenceItem>;
  actions?: CardActions;
  /** An implementation brief already exists: flagged in the header so a collapsed card shows it. */
  briefReady?: boolean;
}): React.JSX.Element {
  // Only the hero starts expanded: the rest read as a ranked list of
  // titles and scores until the visitor opens one. Collapsed bodies stay
  // mounted (hidden), so a brief being written keeps polling.
  const [expanded, setExpanded] = useState(Boolean(isHero));
  const [tab, setTab] = useState<CardTab>("summary");
  const baseId = useId();
  const bodyId = `${baseId}-body`;
  const tabs: { id: CardTab; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "evidence", label: `Evidence (${card.evidenceRefs.length})` },
    { id: "experiment", label: "Experiment" },
  ];

  function selectTab(next: CardTab): void {
    if (next === tab) return;
    // Evidence and Experiment were collapsed sections before tabs; their
    // first view is still what the funnel events record.
    if (next !== "summary") actions?.onSectionOpened(next);
    setTab(next);
  }

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    selectTab(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  }

  return (
    <article className={isHero ? "card hero" : "card"} data-expanded={expanded}>
      {isHero && <span className="badge">Best next experiment</span>}
      <p className="eyebrow card-eyebrow">
        {rank !== undefined && <span className="card-rank">#{rank}</span>}
        {CHANGE_SURFACE_LABEL[card.changeSurface]}
      </p>
      <h2 className="card-title">
        <button type="button" className="card-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((o) => !o)}>
          <span>{card.title}</span>
          <span className="card-toggle-icon" aria-hidden="true" />
        </button>
      </h2>
      <ul className="card-chips" aria-label="Scores">
        <li>
          Impact <strong>{LEVEL_LABEL[card.expectedImpact.level] ?? card.expectedImpact.level}</strong>
        </li>
        <li>
          Effort <strong>{LEVEL_LABEL[card.effort.level] ?? card.effort.level}</strong>
        </li>
        <li>
          Confidence <strong>{LEVEL_LABEL[card.confidence.level] ?? card.confidence.level}</strong>
        </li>
        <li>
          Evidence <strong>{card.confidence.evidenceQualityScore}/3</strong>
        </li>
        {briefReady && <li className="chip-ready">Brief ready</li>}
      </ul>

      <div id={bodyId} className="card-body" hidden={!expanded}>
        <p className="card-hypothesis">{card.hypothesis}</p>

        <div className="card-tabs" role="tablist" aria-label="Opportunity details">
          {tabs.map((t) => (
            <button
              key={t.id}
              id={`${baseId}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => selectTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div id={`${baseId}-panel-summary`} role="tabpanel" aria-labelledby={`${baseId}-tab-summary`} hidden={tab !== "summary"} className="card-panel">
          <dl className="card-facts">
            <dt>Why it matters</dt>
            <dd>{card.problemStatement}</dd>
            <dt>Seen on the public surface</dt>
            <dd>{card.observation}</dd>
            <dt>Repo or analytics data would confirm</dt>
            <dd>{card.missingEvidence}</dd>
            <dt>Scores</dt>
            <dd>
              <span className="card-fact-label">Impact:</span> {card.expectedImpact.rationale}{" "}
              <span className="card-fact-label">Effort:</span> {card.effort.explanation}
            </dd>
          </dl>
        </div>

        <div id={`${baseId}-panel-evidence`} role="tabpanel" aria-labelledby={`${baseId}-tab-evidence`} hidden={tab !== "evidence"} className="card-panel">
          <ol className="evidence-list">
            {card.evidenceRefs.map((ref) => (
              <EvidenceEntry key={ref} refId={ref} item={evidenceById.get(ref)} />
            ))}
          </ol>
        </div>

        <div id={`${baseId}-panel-experiment`} role="tabpanel" aria-labelledby={`${baseId}-tab-experiment`} hidden={tab !== "experiment"} className="card-panel">
          <dl className="experiment">
            <dt>Control</dt>
            <dd>{card.experiment.control}</dd>
            <dt>Variant</dt>
            <dd>{card.experiment.variant}</dd>
            <dt>Audience</dt>
            <dd>{card.experiment.audience}</dd>
            <dt>Primary metric</dt>
            <dd>{card.experiment.primaryMetric}</dd>
            <dt>Guardrails</dt>
            <dd>{card.experiment.guardrails}</dd>
            <dt>Stopping rule</dt>
            <dd>{card.experiment.stoppingRule}</dd>
          </dl>
        </div>

        {actions && <CardActionsRow actions={actions} isHero={isHero} />}
      </div>
    </article>
  );
}

function CardActionsRow({ actions, isHero }: { actions: CardActions; isHero?: boolean }): React.JSX.Element {
  return (
    <div className="card-actions">
      <button
        type="button"
        className={isHero ? undefined : "secondary"}
        onClick={actions.onBuildThis}
        disabled={actions.buildBusy}
      >
        Build this &#8594;
      </button>
      <div className="feedback" role="group" aria-label="Rate this opportunity">
        <span className="feedback-prompt">How does this land?</span>
        {CARD_RATINGS.map((rating) => (
          <button
            key={rating}
            type="button"
            className="chip"
            aria-pressed={actions.rating === rating}
            onClick={() => actions.onRate(rating)}
          >
            {CARD_RATING_LABEL[rating]}
          </button>
        ))}
      </div>
      {actions.feedbackError && (
        <p className="error" role="alert" style={{ fontSize: 13, margin: 0 }}>
          {actions.feedbackError}
        </p>
      )}
      {actions.packageSlot}
    </div>
  );
}

function EvidenceEntry({ refId, item }: { refId: string; item: EvidenceItem | undefined }): React.JSX.Element {
  if (!item) {
    // Unreachable for a validated report (scientist.ts rejects orphan
    // refs), but a report stored before that check -- or a packet edited
    // by hand -- must not crash the whole page.
    return (
      <li>
        <span className="evidence-id">{refId}</span>
        <span className="muted"> Not found in this scan&apos;s evidence.</span>
      </li>
    );
  }
  const source = safeSourceLink(item.sourceUrl);
  return (
    <li>
      <span className="evidence-id">{refId}</span> {item.observation}
      {item.rawExcerpt.trim() && <blockquote>{truncateExcerpt(item.rawExcerpt)}</blockquote>}
      <span className="evidence-meta">
        {source ? (
          <a href={source.href} target="_blank" rel="noopener noreferrer nofollow">
            {source.label}
          </a>
        ) : (
          item.sourceUrl
        )}
        {" · "}
        {item.confidence} confidence
      </span>
    </li>
  );
}
