"use client";

/**
 * What the person looking at a report can do (GET /api/scans/:id/viewer),
 * and the automatic "save to my workspace" step: when a signed-in visitor
 * holds this scan's claim token (they ran it in this browser) and the scan
 * isn't saved yet, it is claimed once, silently. The token is then
 * forgotten: it has no further use.
 */
import { useEffect, useState } from "react";
import { forgetClaimToken, readClaimToken } from "./claim-storage";

export interface Viewer {
  authAvailable: boolean;
  signedIn: boolean;
  login: string | null;
  isOwner: boolean;
  claimed: boolean;
}

export type ClaimState = "idle" | "saving" | "saved" | "error";

export function useViewer(scanId: string): { viewer: Viewer | null; hasToken: boolean; claimState: ClaimState; claimError: string | null } {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [claimState, setClaimState] = useState<ClaimState>("idle");
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = readClaimToken(scanId);
    setHasToken(token !== null);

    async function run(): Promise<void> {
      const res = await fetch(`/api/scans/${scanId}/viewer`, { cache: "no-store" });
      if (!res.ok) return;
      const v = (await res.json()) as Viewer;
      if (cancelled) return;
      setViewer(v);
      if (!v.signedIn || v.claimed || !token) return;

      setClaimState("saving");
      const claim = await fetch(`/api/scans/${scanId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (cancelled) return;
      if (claim.ok) {
        forgetClaimToken(scanId);
        setHasToken(false);
        setViewer({ ...v, claimed: true, isOwner: true });
        setClaimState("saved");
        return;
      }
      const body = (await claim.json().catch(() => null)) as { error?: string } | null;
      if (claim.status === 403) {
        forgetClaimToken(scanId);
        setHasToken(false);
      }
      setClaimError(body?.error ?? "Couldn't save this report to your account.");
      setClaimState("error");
    }

    run().catch(() => {
      // Viewer info is an enhancement; the report itself works without it.
    });
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  return { viewer, hasToken, claimState, claimError };
}
