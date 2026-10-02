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
}: {
  view: PackageView;
  onRetry: () => void;
  connectRepoHref: string;
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
      {view.status === "ready" && <PackageBody view={view} connectRepoHref={connectRepoHref} />}
    </motion.section>
  );
}

function PackageBody({
  view,
  connectRepoHref,
}: {
  view: Extract<PackageView, { status: "ready" }>;
  connectRepoHref: string;
}): React.JSX.Element {
  const pkg = view.package;
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  async function copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(view.codingAgentPrompt);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([view.markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `gauntlet-brief-${pkg.featureFlag.name}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h3 className="package-title">Implementation brief</h3>
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
          {pkg.measurement.howToMeasure} Baseline: {pkg.measurement.baseline} Run for at least {pkg.measurement.minimumDuration}.
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
        <dt>Where in the product</dt>
        <dd>
          <ul>{pkg.likelyComponents.map((s) => <li key={s}>{s}</li>)}</ul>
        </dd>
      </dl>

      <div className="package-repo">
        <p>
          Written from the public website only, so it names parts of the product, not files. Connecting your repository
          would pin down: {pkg.missingContext.join("; ")}.
        </p>
        <a href={connectRepoHref}>Connect your repository</a>
      </div>
    </>
  );
}
