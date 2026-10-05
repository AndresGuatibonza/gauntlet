"use client";

/**
 * The repo-aware brief for one card (owner only): starts it, follows it
 * while Gauntlet reads the repository and writes, then shows what the code
 * changed about the card (contract §2.4), the code evidence it rests on
 * (§1.7) and the rewritten brief, which names real files.
 */
import { useEffect, useRef, useState } from "react";
import type { ActionPackage, RepoAnalysis } from "@gauntlet/core";
import { ActivityLine } from "@/components/activity-line";
import { BriefDetails } from "@/components/action-package-panel";

const POLL_MS = 3000;
const POLL_LIMIT_MS = 7 * 60 * 1000;

type BriefView =
  | { status: "loading" }
  | { status: "none" }
  | { status: "generating"; stage: "reading" | "writing" }
  | { status: "failed"; error: string; canRetry: boolean }
  | { status: "ready"; analysis: RepoAnalysis; package: ActionPackage; codingAgentPrompt: string; markdown: string };

type BriefResponse = {
  status?: string;
  stage?: "reading" | "writing";
  error?: string;
  canRetry?: boolean;
  analysis?: RepoAnalysis;
  package?: ActionPackage;
  codingAgentPrompt?: string;
  markdown?: string;
};

/** One API response -> what to show; null = still generating, keep polling. */
export function toBriefView(status: number, body: BriefResponse | null): BriefView | null {
  if (!body) return { status: "failed", error: `Request failed (${status}).`, canRetry: true };
  if (status === 429) return { status: "failed", error: body.error ?? "Limit reached for now.", canRetry: false };
  if (status >= 400) return { status: "failed", error: body.error ?? `Request failed (${status}).`, canRetry: status >= 500 || status === 409 };
  switch (body.status) {
    case "ready":
      return body.analysis && body.package && body.codingAgentPrompt && body.markdown
        ? { status: "ready", analysis: body.analysis, package: body.package, codingAgentPrompt: body.codingAgentPrompt, markdown: body.markdown }
        : { status: "failed", error: "The repo-aware brief came back incomplete.", canRetry: true };
    case "generating":
      return null;
    case "failed":
      return { status: "failed", error: body.error ?? "Writing the repo-aware brief failed.", canRetry: body.canRetry ?? false };
    case "none":
      return { status: "none" };
    default:
      return { status: "failed", error: "The repo-aware brief could not be started.", canRetry: true };
  }
}

function activity(stage: "reading" | "writing", repository: string): string[] {
  return stage === "reading"
    ? [`Reading ${repository}`, "Choosing the files this experiment touches", "Checking every claim against the code"]
    : ["Writing the repo-aware brief", "Pinning the change to real files", "Planning the flag with the code's own tools"];
}

export function RepoBriefPanel({ scanId, cardIndex, repository }: { scanId: string; cardIndex: number; repository: string }): React.JSX.Element {
  const url = `/api/scans/${scanId}/cards/${cardIndex}/repo-brief`;
  const [view, setView] = useState<BriefView>({ status: "loading" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const stage = useRef<"reading" | "writing">("reading");
  const alive = useRef(true);

  async function step(method: "GET" | "POST"): Promise<void> {
    let next: BriefView | null;
    try {
      const res = await fetch(url, { method, cache: "no-store" });
      const body = (await res.json().catch(() => null)) as BriefResponse | null;
      if (body?.stage) stage.current = body.stage;
      next = toBriefView(res.status, body);
    } catch {
      next = Date.now() - startedAt.current < POLL_LIMIT_MS ? null : { status: "failed", error: "Lost connection while writing the brief.", canRetry: true };
    }
    if (!alive.current) return;
    if (!next && Date.now() - startedAt.current > POLL_LIMIT_MS) {
      next = { status: "failed", error: "This is taking too long. Please try again.", canRetry: true };
    }
    if (next) {
      setView(next);
      return;
    }
    setView({ status: "generating", stage: stage.current });
    timer.current = setTimeout(() => void step("GET"), POLL_MS);
  }

  function start(method: "GET" | "POST"): void {
    if (timer.current) clearTimeout(timer.current);
    startedAt.current = Date.now();
    if (method === "POST") {
      stage.current = "reading";
      setView({ status: "generating", stage: "reading" });
    }
    void step(method);
  }

  // On mount: pick up an existing brief (or one still being written); stop polling on unmount.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    alive.current = true;
    startRef.current("GET");
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [url]);

  return (
    <section className="repo-brief" aria-label="Repo-aware brief">
      {view.status === "loading" && <p className="muted repo-note">Checking for a repo-aware brief…</p>}
      {view.status === "none" && (
        <div className="repo-brief-start">
          <p className="repo-note">
            Read <code>{repository}</code> for this experiment and rewrite the brief with the files to change, the flag and
            analytics tools the code already uses, and a revised effort and confidence.
          </p>
          <button type="button" onClick={() => start("POST")}>
            Write a repo-aware brief
          </button>
        </div>
      )}
      {view.status === "generating" && <ActivityLine lines={activity(view.stage, repository)} />}
      {view.status === "failed" && (
        <div role="alert">
          <p className="error" style={{ margin: 0, fontSize: 14 }}>{view.error}</p>
          {view.canRetry && (
            <button type="button" className="secondary compact" style={{ marginTop: 12 }} onClick={() => start("POST")}>
              Try again
            </button>
          )}
        </div>
      )}
      {view.status === "ready" && <RepoBriefReady view={view} />}
    </section>
  );
}

const LEVEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

function RepoBriefReady({ view }: { view: Extract<BriefView, { status: "ready" }> }): React.JSX.Element {
  const { analysis, package: pkg } = view;
  const { refinement, codeContext } = analysis;
  const evidence = codeContext.items;
  return (
    <>
      <h3 className="package-title">What the code changes</h3>
      <p className="muted repo-note">
        From {codeContext.source.filesInspected.length} file(s) of <code>{codeContext.source.repository}</code> at{" "}
        <code>{codeContext.source.ref.slice(0, 7)}</code>, read {new Date(codeContext.source.pulledAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
      </p>
      <dl className="package-sections">
        <dt>Confidence</dt>
        <dd>
          <strong>{LEVEL[refinement.confidence.level]}</strong> — {refinement.confidence.rationale} <Refs ids={refinement.confidence.evidenceRefs} />
        </dd>
        <dt>Effort</dt>
        <dd>
          <strong>{LEVEL[refinement.effort.level]}</strong> — {refinement.effort.rationale} <Refs ids={refinement.effort.evidenceRefs} />
        </dd>
        {refinement.implementationSurface.length > 0 && (
          <>
            <dt>Files to change</dt>
            <dd>
              <ul>
                {refinement.implementationSurface.map((s) => (
                  <li key={s.path}>
                    <code>{s.path}</code> <span className="muted">{s.role}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {refinement.experimentNotes.length > 0 && (
          <>
            <dt>Running the experiment here</dt>
            <dd>
              <ul>{refinement.experimentNotes.map((n) => <li key={n}>{n}</li>)}</ul>
            </dd>
          </>
        )}
        {refinement.contradictions.length > 0 && (
          <>
            <dt>Where the code disagrees with the public scan</dt>
            <dd>
              <ul>{refinement.contradictions.map((n) => <li key={n}>{n}</li>)}</ul>
            </dd>
          </>
        )}
        <dt>Still open</dt>
        <dd>
          <ul>{refinement.stillMissing.map((n) => <li key={n}>{n}</li>)}</ul>
        </dd>
      </dl>

      <details className="code-evidence">
        <summary>Code evidence ({evidence.length})</summary>
        <ol>
          {evidence.map((item) => (
            <li key={item.id} id={`code-${item.id}`}>
              <p>
                <strong>{item.id}</strong> {item.observation}
              </p>
              {item.path && (
                <p className="muted code-evidence-ref">
                  <code>
                    {item.path}
                    {item.lines ? `:${item.lines.start}-${item.lines.end}` : ""}
                  </code>
                </p>
              )}
              {item.lines && <pre className="code-excerpt">{item.rawExcerpt}</pre>}
            </li>
          ))}
        </ol>
        {codeContext.notInspected.length > 0 && (
          <>
            <p className="muted">Not inspected:</p>
            <ul className="muted">{codeContext.notInspected.map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        )}
      </details>

      <div className="repo-brief-package">
        <BriefDetails
          pkg={pkg}
          codingAgentPrompt={view.codingAgentPrompt}
          markdown={view.markdown}
          downloadPrefix="gauntlet-repo-brief"
          title="Repo-aware implementation brief"
        >
          {pkg.missingContext.length > 0 && (
            <div className="package-repo">
              <p>What this targeted read could not settle:</p>
              <ul>{pkg.missingContext.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
        </BriefDetails>
      </div>
    </>
  );
}

function Refs({ ids }: { ids: string[] }): React.JSX.Element {
  return <span className="muted">({ids.join(", ")})</span>;
}
