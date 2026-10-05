"use client";

/**
 * The Experiment Ledger record for one card, for the account that saved
 * the report (contract §2.3): planned -> running -> decided (ship / iterate
 * / discard, with its result), then an outcome once. The rules are enforced
 * by the server (applyExperimentUpdate); this only offers the next steps.
 */
import { useEffect, useState } from "react";
import type { ExperimentRecord } from "@gauntlet/core";

interface StoredExperiment {
  id: string;
  record: ExperimentRecord;
  decidedAt: string | null;
}

const DECISIONS = [
  { value: "ship", label: "Ship it" },
  { value: "iterate", label: "Iterate" },
  { value: "discard", label: "Discard" },
] as const;

const DECISION_LABEL: Record<string, string> = { ship: "Shipped", iterate: "Iterate", discard: "Discarded" };

type Update = { running: true } | { decision: string; result: string; outcome?: string } | { outcome: string };

export function ExperimentTracker({ scanId, cardIndex }: { scanId: string; cardIndex: number }): React.JSX.Element {
  const url = `/api/scans/${scanId}/cards/${cardIndex}/experiment`;
  const [experiment, setExperiment] = useState<StoredExperiment | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"none" | "decision" | "outcome">("none");
  const [decision, setDecision] = useState("ship");
  const [result, setResult] = useState("");
  const [outcome, setOutcome] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { experiment?: StoredExperiment | null; error?: string } | null;
        if (cancelled) return;
        if (!res.ok) setError(body?.error ?? "Couldn't load this experiment.");
        else setExperiment(body?.experiment ?? null);
      })
      .catch(() => !cancelled && setError("Couldn't load this experiment."));
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function save(update: Update): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
      const body = (await res.json().catch(() => null)) as { experiment?: StoredExperiment; error?: string } | null;
      if (!res.ok || !body?.experiment) {
        setError(body?.error ?? "Couldn't save this update.");
        return;
      }
      setExperiment(body.experiment);
      setForm("none");
    } catch {
      setError("Couldn't save this update. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (experiment === undefined && !error) return <p className="muted tracker-note">Loading the experiment…</p>;
  if (experiment === null) return <p className="muted tracker-note">This experiment hasn&apos;t been started yet.</p>;

  const record = experiment?.record;
  const status = record?.status;

  return (
    <div className="tracker" aria-label="Experiment tracking">
      <div className="tracker-head">
        <h4>Experiment</h4>
        {record && (
          <span className={`tracker-status tracker-${status}`}>
            {status === "decided" ? DECISION_LABEL[record.decision ?? ""] ?? "Decided" : status === "running" ? "Running" : "Planned"}
          </span>
        )}
      </div>

      {record?.result && (
        <p className="tracker-line">
          <strong>Result:</strong> {record.result}
        </p>
      )}
      {record?.outcome && (
        <p className="tracker-line">
          <strong>Outcome:</strong> {record.outcome}
        </p>
      )}

      {record && form === "none" && (
        <div className="tracker-actions">
          {status === "planned" && (
            <button type="button" className="secondary compact" disabled={busy} onClick={() => void save({ running: true })}>
              Mark as running
            </button>
          )}
          {status !== "decided" && (
            <button type="button" className="secondary compact" disabled={busy} onClick={() => setForm("decision")}>
              Record the result
            </button>
          )}
          {status === "decided" && !record.outcome && (
            <button type="button" className="secondary compact" disabled={busy} onClick={() => setForm("outcome")}>
              Add what happened next
            </button>
          )}
        </div>
      )}

      {form === "decision" && (
        <form
          className="tracker-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ decision, result, ...(outcome.trim() ? { outcome } : {}) });
          }}
        >
          <fieldset>
            <legend>Decision</legend>
            {DECISIONS.map((d) => (
              <label key={d.value}>
                <input type="radio" name="decision" value={d.value} checked={decision === d.value} onChange={() => setDecision(d.value)} />{" "}
                {d.label}
              </label>
            ))}
          </fieldset>
          <label className="tracker-field">
            What did the experiment show?
            <textarea required value={result} onChange={(e) => setResult(e.target.value)} rows={3} maxLength={2000} />
          </label>
          <p className="muted tracker-hint">A recorded decision is final: it becomes part of your experiment history.</p>
          <div className="tracker-actions">
            <button type="submit" className="compact" disabled={busy || result.trim() === ""}>
              Save decision
            </button>
            <button type="button" className="secondary compact" onClick={() => setForm("none")}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {form === "outcome" && (
        <form
          className="tracker-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ outcome });
          }}
        >
          <label className="tracker-field">
            What happened after the decision?
            <textarea required value={outcome} onChange={(e) => setOutcome(e.target.value)} rows={3} maxLength={2000} />
          </label>
          <div className="tracker-actions">
            <button type="submit" className="compact" disabled={busy || outcome.trim() === ""}>
              Save outcome
            </button>
            <button type="button" className="secondary compact" onClick={() => setForm("none")}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="error" role="alert" style={{ fontSize: 13, margin: "8px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}
