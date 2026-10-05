"use client";

/**
 * The "Build this" result inside a card (PRD §8.8): while the brief is
 * written, an activity line; then the implementation package with a
 * copyable prompt for the team's coding agent and a Markdown download.
 * Purely presentational -- state and requests live in scan-report.tsx.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import type { ActionPackage } from "@gauntlet/core";
import { ActivityLine } from "@/components/activity-line";

export type PackageView =
  | { status: "generating" }
  | { status: "ready"; package: ActionPackage; codingAgentPrompt: string; markdown: string }
  | { status: "failed"; error: string; canRetry: boolean };

const GENERATING_LINES = [
  "Writing the implementation brief",
  "Turning the experiment into acceptance criteria",
  "Planning the feature flag and rollback",
];

export function ActionPackagePanel({
  view,
  onRetry,
  connectRepoHref,
  tracking,
  repoSlot,
}: {
  view: PackageView;
  onRetry: () => void;
  connectRepoHref: string;
  /** Experiment Ledger tracking, shown under a ready brief (scan-report.tsx decides what fits the viewer). */
  tracking?: React.ReactNode;
  /** For the report's owner: the GitHub connection and repo-aware brief, in place of the "Connect your repository" link. */
  repoSlot?: React.ReactNode;
}): React.JSX.Element {
  return (
    <motion.section
      className="package-panel"
      aria-label="Implementation brief"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      {view.status === "generating" && <ActivityLine lines={GENERATING_LINES} />}
      {view.status === "failed" && (
        <div role="alert">
          <p className="error" style={{ margin: 0, fontSize: 14 }}>{view.error}</p>
          {view.canRetry && (
            <button type="button" className="secondary compact" style={{ marginTop: 12 }} onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
      {view.status === "ready" && (
        <BriefDetails pkg={view.package} codingAgentPrompt={view.codingAgentPrompt} markdown={view.markdown} downloadPrefix="gauntlet-brief">
          <div className="package-repo">
            <p>
              Written from the public website only, so it names parts of the product, not files. Connecting your repository
              would pin down:
            </p>
            <ul>{view.package.missingContext.map((s) => <li key={s}>{s}</li>)}</ul>
            {repoSlot ?? <a href={connectRepoHref}>Connect your repository</a>}
          </div>
        </BriefDetails>
      )}
      {view.status === "ready" && tracking}
    </motion.section>
  );
}

/**
 * One implementation brief: copy/download actions and its sections. Shared
 * by the public brief and the repo-aware one (repo-brief-panel.tsx); what
 * follows the sections (repository context) is the caller's `children`.
 */
export function BriefDetails({
  pkg,
  codingAgentPrompt,
  markdown,
  downloadPrefix,
  title = "Implementation brief",
  children,
}: {
  pkg: ActionPackage;
  codingAgentPrompt: string;
  markdown: string;
  downloadPrefix: string;
  title?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const componentsLabel = pkg.codeContext === "github" ? "Where to change it" : "Where in the product";

  async function copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codingAgentPrompt);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${downloadPrefix}-${pkg.featureFlag.name}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h3 className="package-title">{title}</h3>
      <p className="package-objective">{pkg.objective}</p>

      <div className="package-actions">
        <button type="button" onClick={() => void copyPrompt()}>
          {copied === "copied" ? "Prompt copied" : "Copy prompt for your coding agent"}
        </button>
        <button type="button" className="secondary" onClick={download}>
          Download brief (.md)
        </button>
      </div>
      {copied === "failed" && (
        <p className="error" role="alert" style={{ fontSize: 13 }}>
          Your browser blocked copying. Use &ldquo;Download brief&rdquo;; the prompt is at the end of the file.
        </p>
      )}

      <dl className="package-sections">
        <dt>Feature flag</dt>
        <dd>
          <code>{pkg.featureFlag.name}</code>, off by default. {pkg.featureFlag.rollout}
        </dd>
        <dt>Approach</dt>
        <dd>
          <ol>{pkg.approach.map((s) => <li key={s}>{s}</li>)}</ol>
        </dd>
        <dt>Done when</dt>
        <dd>
          <ul>{pkg.acceptanceCriteria.map((s) => <li key={s}>{s}</li>)}</ul>
        </dd>
        <dt>Measure</dt>
        <dd>
          <p className="package-line">{pkg.measurement.howToMeasure}</p>
          <p className="package-line">
            <span className="muted">Baseline:</span> {pkg.measurement.baseline}
          </p>
          <p className="package-line">
            <span className="muted">Minimum duration:</span> {pkg.measurement.minimumDuration}
          </p>
        </dd>
        <dt>Roll back if</dt>
        <dd>
          <ul>{pkg.rollbackCriteria.map((s) => <li key={s}>{s}</li>)}</ul>
        </dd>
        <dt>Not in scope</dt>
        <dd>
          <ul>{pkg.nonGoals.map((s) => <li key={s}>{s}</li>)}</ul>
        </dd>
        <dt>Risks</dt>
        <dd>
          <ul>
            {pkg.risks.map((r) => (
              <li key={r.risk}>
                {r.risk} <span className="muted">Mitigation: {r.mitigation}</span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>{componentsLabel}</dt>
        <dd>
          <ul>{pkg.likelyComponents.map((s) => <li key={s}>{s}</li>)}</ul>
        </dd>
      </dl>

      {children}
    </>
  );
}
