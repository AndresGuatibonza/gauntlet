"use client";

/**
 * One short line under the stage tracker saying what the scan is doing
 * right now. Cycles through `lines` (see activityLines in
 * lib/scan-client.ts); when the first line changes -- the scan reported a
 * new step -- it shows that one immediately instead of waiting its turn.
 * Announced politely to screen readers.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

export const ACTIVITY_ROTATE_MS = 3200;

export function ActivityLine({
  lines,
  rotateMs = ACTIVITY_ROTATE_MS,
}: {
  lines: string[];
  rotateMs?: number;
}): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const lead = lines[0] ?? "";
  const count = lines.length;

  useEffect(() => {
    setIndex(0);
  }, [lead, count]);

  useEffect(() => {
    if (count < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), rotateMs);
    return () => clearInterval(timer);
  }, [lead, count, rotateMs]);

  const text = lines[index % Math.max(count, 1)] ?? "";

  return (
    <p className="activity-line" role="status" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          style={{ display: "inline-block" }}
        >
          {text}
          <span aria-hidden="true">…</span>
        </motion.span>
      </AnimatePresence>
    </p>
  );
}
