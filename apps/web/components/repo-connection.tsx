"use client";

/**
 * For the report's owner, under a ready brief: the GitHub repository behind
 * this product (PRD §5 step 6) and, once connected, the repo-aware brief for
 * this card. The connection is per workspace (product), so it is the same
 * under every card; the brief is per card.
 */
import { useEffect, useState } from "react";
import type { UseRepository } from "@/lib/use-repository";
import { RepoBriefPanel, type PublicLevels } from "@/components/repo-brief-panel";

export function RepoConnection({
  scanId,
  cardIndex,
  repo,
  publicLevels,
}: {
  scanId: string;
  cardIndex: number;
  repo: UseRepository;
  /** The card's public-scan confidence and effort, shown against the repo-aware ones. */
  publicLevels?: PublicLevels;
}): React.JSX.Element {
  const { connection, busy, actionError, connect, disconnect } = repo;
  const connectHref = `/api/github/connect?scan=${scanId}`;

  if (connection.status === "loading") return <p className="muted repo-note">Checking the repository connection…</p>;
  if (connection.status === "error") return <p className="error repo-note" role="alert">{connection.error}</p>;
  if (connection.status === "unavailable") {
    return <p className="muted repo-note">Connecting a GitHub repository isn&apos;t available yet.</p>;
  }

  const { connected, accessible } = connection;
  if (connected) {
    return (
      <div className="repo-connection">
        <p className="repo-connected">
          Repository <code>{connected.fullName}</code> <span className="muted">({connected.defaultBranch})</span>
          <button type="button" className="link-button" onClick={() => void disconnect()} disabled={busy}>
            Disconnect
          </button>
        </p>
        {actionError && <p className="error repo-note" role="alert">{actionError}</p>}
        <RepoBriefPanel key={connected.repositoryId} scanId={scanId} cardIndex={cardIndex} repository={connected.fullName} publicLevels={publicLevels} />
      </div>
    );
  }

  return (
    <div className="repo-connection">
      {accessible.length > 0 ? (
        <RepoPicker repositories={accessible} busy={busy} onConnect={(id) => void connect(id)} />
      ) : (
        <p className="repo-note">
          Connect the product&apos;s GitHub repository and Gauntlet reads the files this experiment touches, then rewrites the
          brief with real file locations. Read-only, on the repositories you choose.
        </p>
      )}
      {actionError && <p className="error repo-note" role="alert">{actionError}</p>}
      <p className="repo-links">
        <a href={connectHref} className={accessible.length > 0 ? undefined : "repo-connect-primary"}>
          {accessible.length > 0 ? "Give Gauntlet access to another repository" : "Connect GitHub"}
        </a>
        {accessible.length === 0 && (
          <a href={`${connectHref}&mode=authorize`} className="muted">
            Already installed the app?
          </a>
        )}
      </p>
    </div>
  );
}

function RepoPicker({
  repositories,
  busy,
  onConnect,
}: {
  repositories: { repositoryId: number; fullName: string; private: boolean }[];
  busy: boolean;
  onConnect: (repositoryId: number) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<number>(repositories[0]!.repositoryId);
  // Keep the selection valid if the list changes.
  useEffect(() => {
    if (!repositories.some((r) => r.repositoryId === selected)) setSelected(repositories[0]!.repositoryId);
  }, [repositories, selected]);

  return (
    <form
      className="repo-picker"
      onSubmit={(e) => {
        e.preventDefault();
        onConnect(selected);
      }}
    >
      <label htmlFor="repo-picker-select">Which repository holds this product&apos;s code?</label>
      <div className="repo-picker-row">
        <select id="repo-picker-select" value={selected} onChange={(e) => setSelected(Number(e.target.value))} disabled={busy}>
          {repositories.map((r) => (
            <option key={r.repositoryId} value={r.repositoryId}>
              {r.fullName}
              {r.private ? " (private)" : ""}
            </option>
          ))}
        </select>
        <button type="submit" className="compact" disabled={busy}>
          {busy ? "Connecting…" : "Use this repository"}
        </button>
      </div>
    </form>
  );
}
