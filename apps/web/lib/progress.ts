/**
 * The "what is the scan doing right now" line (a product requirement:
 * stream a few words per stage instead of only a moving dot). run-scan.ts reports
 * real steps here; the report page displays them under the stage tracker.
 *
 * Writes are serialized (each waits for the previous one), so a slow write
 * for page 2 can never land after, and overwrite, the message for page 3.
 * They are also best-effort: a failed progress write is logged and dropped,
 * never allowed to fail the scan itself.
 */
import type { ScanJobStatus } from "./store.js";

export type InFlightStatus = Extract<ScanJobStatus, "queued" | "scanning" | "analyzing" | "reviewing">;

export interface ScanProgress {
  status: InFlightStatus;
  message: string;
}

export interface ProgressReporter {
  report(status: InFlightStatus, message: string): void;
  /** Resolves once every report made so far has been written (or dropped). */
  flush(): Promise<void>;
}

export function createProgressReporter(
  write: (progress: ScanProgress) => Promise<void>,
  onError: (err: unknown) => void = (err) => console.error("[run-scan] could not record progress:", err),
): ProgressReporter {
  let chain: Promise<void> = Promise.resolve();
  return {
    report(status, message) {
      chain = chain.then(() => write({ status, message })).catch(onError);
    },
    flush() {
      return chain;
    },
  };
}

const MAX_PATH_LENGTH = 40;

/** "https://x.com/pricing?a=1" -> "/pricing"; the homepage -> "the homepage". */
export function describePage(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "a page";
  }
  if (path === "/" || path === "") return "the homepage";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length > MAX_PATH_LENGTH ? `${trimmed.slice(0, MAX_PATH_LENGTH - 1)}…` : trimmed;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
