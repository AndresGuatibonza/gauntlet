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
 */
import type { ChangeSurface, EvidenceItem, OpportunityCard } from "@gauntlet/core";

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

export function OpportunityCardView({
  card,
  isHero,
  evidenceById,
}: {
  card: OpportunityCard;
  isHero?: boolean;
  evidenceById: ReadonlyMap<string, EvidenceItem>;
}): React.JSX.Element {
  return (
    <div className={isHero ? "card hero" : "card"}>
      {isHero && <span className="badge">Best next experiment</span>}
      <p className="eyebrow" style={{ marginTop: isHero ? 16 : 0 }}>
        {CHANGE_SURFACE_LABEL[card.changeSurface]}
      </p>
      <h2 style={{ fontSize: isHero ? 28 : 22, marginTop: 6 }}>{card.title}</h2>
      <p className="muted" style={{ marginTop: 10 }}>{card.hypothesis}</p>

      <div className="why-it-matters">
        <strong>Why it matters</strong>
        {card.problemStatement}
      </div>

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
      <div className="rationale">
        <p>
          <span>Impact:</span> {card.expectedImpact.rationale}
        </p>
        <p>
          <span>Effort:</span> {card.effort.explanation}
        </p>
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

      <details style={{ marginTop: 16 }} open={isHero}>
        <summary style={{ cursor: "pointer" }}>Evidence ({card.evidenceRefs.length})</summary>
        <ol className="evidence-list">
          {card.evidenceRefs.map((ref) => (
            <EvidenceEntry key={ref} refId={ref} item={evidenceById.get(ref)} />
          ))}
        </ol>
      </details>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer" }}>Proposed experiment</summary>
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
      </details>
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
