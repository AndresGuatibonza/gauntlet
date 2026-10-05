"use client";

/**
 * The GitHub repository connected to a saved report (owner only), shared by
 * every card of the report: GET/POST/DELETE /api/scans/:id/repository.
 */
import { useCallback, useEffect, useState } from "react";

export interface ConnectedRepository {
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  connectedAt: string;
}

export interface AccessibleRepositoryView {
  repositoryId: number;
  fullName: string;
  private: boolean;
}

export type RepositoryConnection =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "unavailable" }
  | { status: "ready"; connected: ConnectedRepository | null; accessible: AccessibleRepositoryView[] };

export interface UseRepository {
  connection: RepositoryConnection;
  busy: boolean;
  actionError: string | null;
  connect: (repositoryId: number) => Promise<void>;
  disconnect: () => Promise<void>;
}

/** Inactive (no requests) until `enabled`: only the report's owner has a repository. */
export function useRepository(scanId: string, enabled: boolean): UseRepository {
  const url = `/api/scans/${scanId}/repository`;
  const [connection, setConnection] = useState<RepositoryConnection>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { available?: boolean; connected?: ConnectedRepository | null; accessible?: AccessibleRepositoryView[]; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          setConnection({ status: "error", error: body?.error ?? "Couldn't load the repository connection." });
        } else if (!body.available) {
          setConnection({ status: "unavailable" });
        } else {
          setConnection({ status: "ready", connected: body.connected ?? null, accessible: body.accessible ?? [] });
        }
      })
      .catch(() => !cancelled && setConnection({ status: "error", error: "Couldn't load the repository connection." }));
    return () => {
      cancelled = true;
    };
  }, [url, enabled]);

  const connect = useCallback(
    async (repositoryId: number) => {
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId }) });
        const body = (await res.json().catch(() => null)) as { connected?: ConnectedRepository; error?: string } | null;
        if (!res.ok || !body?.connected) {
          setActionError(body?.error ?? "Couldn't connect the repository.");
          return;
        }
        const connected = body.connected;
        setConnection((c) => (c.status === "ready" ? { ...c, connected } : c));
      } catch {
        setActionError("Couldn't connect the repository. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [url],
  );

  const disconnect = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? "Couldn't disconnect the repository.");
        return;
      }
      setConnection((c) => (c.status === "ready" ? { ...c, connected: null } : c));
    } catch {
      setActionError("Couldn't disconnect the repository. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [url]);

  return { connection, busy, actionError, connect, disconnect };
}
