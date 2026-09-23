"use client";

/**
 * Landing page (PRD §8.5: "no signup required for initial value"). One
 * input, one button, no account -- paste a public URL, get redirected to
 * the report page which does its own polling.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

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
      <h1>Gauntlet</h1>
      <p className="muted">
        Paste a public product URL. Gauntlet scans it, then a Product Scientist and a Reviewer/Critic
        produce 3-5 ranked, evidence-backed improvement opportunities -- with the single best next
        experiment to run first. No account needed to see it.
      </p>
      <form onSubmit={handleSubmit} className="card">
        <div style={{ marginBottom: 12 }}>
          <input
            type="url"
            required
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div style={{ marginBottom: 16, display: "flex", gap: 16, alignItems: "center" }}>
          <label className="muted" style={{ fontSize: 14 }}>
            <input
              type="radio"
              name="category"
              checked={category === "ai_saas"}
              onChange={() => setCategory("ai_saas")}
              disabled={submitting}
            />{" "}
            AI SaaS
          </label>
          <label className="muted" style={{ fontSize: 14 }}>
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
        <button type="submit" disabled={submitting || url.length === 0}>
          {submitting ? "Starting scan..." : "Scan this product"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </>
  );
}
