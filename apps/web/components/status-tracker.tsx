"use client";

/**
 * Editorial-style progress indicator for the four in-flight pipeline
 * stages (queued -> scanning -> analyzing -> reviewing). Deliberately not
 * a percentage bar -- we have no way to estimate remaining time, and a
 * fake-progress bar would be a lie; a sequence of stages that light up
 * as the real job.status (from GET /api/scans/:id) advances is an honest
 * representation of the same async pipeline documented in run-scan.ts.
 *
 * The pulse on the *current* stage is a separate element that mounts
 * only while that stage is active and unmounts the moment the job moves
 * past it (via AnimatePresence) -- rather than one persistent dot whose
 * animate target is switched between an infinite keyframe loop and a
 * static value. The latter looked right in principle but visibly kept
 * pulsing on already-completed stages in practice (confirmed by Andres
 * against the real running app) -- retargeting away from an infinite
 * repeat mid-cycle isn't something to rely on. A dot that fully unmounts
 * can't keep animating.
 *
 * Two follow-ups found by reading framer-motion 11's source, not guessed:
 *   1. `exit` without its own `transition` inherits the component's
 *      `transition` prop -- here `repeat: Infinity`. That exit animation
 *      never completes, so AnimatePresence never gets onExitComplete and
 *      never unmounts the pulse: it kept looping on completed stages. The
 *      exit now carries its own finite transition.
 *   2. The old loop went opacity 0.7 -> 0 and then restarted at 0.7, a
 *      visible pop every cycle. The keyframes now start AND end at
 *      opacity 0, so each repeat is seamless (a soft "breathing" pulse).
 *
 * Step-by-step display: the page polls every 2.5s, while queued/scanning
 * can finish in under a second, so the first poll often already reports
 * a later stage. useSteppedStage() walks the displayed stage forward one
 * step at a time instead of jumping. That is still honest: run-scan.ts
 * executes these stages strictly in order, so every stage shown really
 * did happen -- only the display is paced, never reordered or invented.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const STAGES = [
  { key: "queued", label: "Queued" },
  { key: "scanning", label: "Scanning" },
  { key: "analyzing", label: "Scientist" },
  { key: "reviewing", label: "Reviewer" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

/** Minimum time each stage stays visibly "active" while catching up. */
const STEP_MS = 700;

function stageIndex(key: StageKey): number {
  return STAGES.findIndex((s) => s.key === key);
}

/**
 * Returns the stage to DISPLAY given the real current stage: advances at
 * most one step per STEP_MS until it catches up. Never runs ahead of the
 * real stage; if the real stage were ever behind (not expected -- the
 * pipeline only moves forward), it snaps to it rather than lying.
 */
export function useSteppedStage(current: StageKey): StageKey {
  const [shownIndex, setShownIndex] = useState(0);
  const targetIndex = stageIndex(current);

  useEffect(() => {
    if (shownIndex > targetIndex) {
      setShownIndex(targetIndex);
      return;
    }
    if (shownIndex === targetIndex) return;
    const timer = setTimeout(() => setShownIndex((i) => i + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [shownIndex, targetIndex]);

  return STAGES[shownIndex]!.key;
}

export function StatusTracker({ current }: { current: StageKey }): React.JSX.Element {
  const currentIndex = stageIndex(current);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, margin: "28px 0" }}>
      {STAGES.map((stage, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
        return (
          <div key={stage.key} style={{ display: "flex", alignItems: "center", flex: i < STAGES.length - 1 ? 1 : "0 0 auto" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <div style={{ position: "relative", width: 8, height: 8 }}>
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: state === "pending" ? "var(--rule-strong)" : "var(--accent)",
                    transition: "background-color 0.4s ease",
                  }}
                />
                <AnimatePresence>
                  {state === "active" && (
                    <motion.div
                      initial={{ scale: 1, opacity: 0 }}
                      animate={{ scale: [1, 1.8, 2.4], opacity: [0, 0.45, 0] }}
                      exit={{ opacity: 0, transition: { duration: 0.3, ease: "easeOut" } }}
                      transition={{ duration: 2, times: [0, 0.35, 1], repeat: Infinity, ease: "easeInOut" }}
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: "50%",
                        background: "var(--accent)",
                      }}
                    />
                  )}
                </AnimatePresence>
              </div>
              <span
                className="eyebrow"
                style={{ color: state === "pending" ? "var(--ink-faint)" : "var(--ink-dim)", fontSize: 10 }}
              >
                {stage.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div style={{ flex: 1, height: 1, background: "var(--rule)", margin: "0 8px 20px", position: "relative", top: -8 }}>
                <motion.div
                  initial={false}
                  animate={{ width: i < currentIndex ? "100%" : "0%" }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  style={{ height: 1, background: "var(--accent)" }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
