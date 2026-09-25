"use client";

/**
 * Landing page (PRD §8.5: "no signup required for initial value"). One
 * input, one button, no account -- paste a public URL, get redirected to
 * the report page which does its own polling.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { FadeUp } from "@/components/motion";

export default function HomePage(): React.JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState<"ai_saas" | "ai_tool">("ai_saas");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, category }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status}).`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/scans/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <>
      <FadeUp>
        <p className="eyebrow">Product Scientist &amp; Fast-Value Loop</p>
        <h1 style={{ fontSize: "clamp(40px, 8vw, 64px)", marginTop: 10 }}>Gauntlet</h1>
        <p className="lede">
          Paste a public product URL. Gauntlet scans it, then a Product Scientist and a Reviewer/Critic
          produce 3&ndash;5 ranked, evidence-backed improvement opportunities &mdash; with the single best next
          experiment to run first. No account needed to see it.
        </p>
      </FadeUp>

      <hr className="rule" />

      <FadeUp delay={0.15}>
        <form onSubmit={handleSubmit}>
          <input
            type="url"
            required
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={submitting}
          />
          <div style={{ marginTop: 22, marginBottom: 28, display: "flex", gap: 24, alignItems: "center" }}>
            <label className="muted" style={{ fontSize: 14, cursor: "pointer" }}>
              <input
                type="radio"
                name="category"
                checked={category === "ai_saas"}
                onChange={() => setCategory("ai_saas")}
                disabled={submitting}
              />{" "}
              AI SaaS
            </label>
            <label className="muted" style={{ fontSize: 14, cursor: "pointer" }}>
              <input
                type="radio"
                name="category"
                checked={category === "ai_tool"}
                onChange={() => setCategory("ai_tool")}
                disabled={submitting}
              />{" "}
              AI tool
            </label>
          </div>
          <motion.button type="submit" disabled={submitting || url.length === 0} whileTap={{ scale: 0.97 }}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={submitting ? "loading" : "idle"}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                style={{ display: "inline-block" }}
              >
                {submitting ? "Starting scan…" : "Scan this product"}
              </motion.span>
            </AnimatePresence>
          </motion.button>
          <AnimatePresence>
            {error && (
              <motion.p
                className="error"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                style={{ marginTop: 16, fontSize: 14 }}
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </form>
      </FadeUp>
    </>
  );
}
