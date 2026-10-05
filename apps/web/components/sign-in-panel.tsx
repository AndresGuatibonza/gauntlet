"use client";

/**
 * "Continue with GitHub" (Supabase Auth, OAuth + PKCE). GitHub returns to
 * /auth/callback, which sets the session and sends the visitor back to
 * `next` -- usually the report they came from, which then saves itself to
 * their workspace. Records signup_started when the sign-in starts from a
 * report (PRD §11).
 */
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/auth/browser";

export function SignInPanel({ next, scanId }: { next: string; scanId: string | null }): React.JSX.Element {
  const [state, setState] = useState<"idle" | "redirecting" | "error">("idle");

  async function signIn(): Promise<void> {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setState("error");
      return;
    }
    setState("redirecting");
    if (scanId) {
      void fetch(`/api/scans/${scanId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "signup_started" }),
        keepalive: true,
      }).catch(() => {});
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (error) setState("error");
  }

  return (
    <div className="sign-in">
      <button type="button" onClick={() => void signIn()} disabled={state === "redirecting"}>
        {state === "redirecting" ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {state === "error" && (
        <p className="error" role="alert" style={{ fontSize: 14 }}>
          Sign-in couldn&apos;t start. Please try again in a moment.
        </p>
      )}
      <p className="muted sign-in-note">
        Gauntlet only reads your public GitHub profile to identify you. It does not get access to your repositories.
      </p>
    </div>
  );
}
