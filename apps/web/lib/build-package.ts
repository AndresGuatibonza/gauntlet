/**
 * Background generation of one "Build this" implementation package, run
 * inside after() by POST /api/scans/:id/cards/:index/package. Mirrors
 * run-scan.ts: every failure lands the row in "failed" with a readable
 * message, so the card never shows a spinner forever (and a row that is
 * somehow left "generating" is treated as failed after
 * STALE_PACKAGE_MINUTES anyway).
 */
import {
  ActionPackageError,
  createAnthropicLlmClient,
  generateActionPackage,
  LlmCallError,
  planExperimentRecord,
} from "@gauntlet/core";
import { completeActionPackage, failActionPackage, getScanJob } from "./store.js";
import { createUsageRecorder } from "./llm-usage.js";

export async function runActionPackageJob(packageId: string, scanJobId: string, cardIndex: number): Promise<void> {
  const usage = createUsageRecorder({ scanJobId, phase: "package", cardIndex });
  try {
    const job = await getScanJob(scanJobId);
    const card = job?.opportunityReport?.cards[cardIndex];
    if (!job || job.status !== "done" || !card || !job.evidencePacket) {
      await failActionPackage(packageId, "This report or opportunity is no longer available.");
      return;
    }
    const pkg = await generateActionPackage(card, job.evidencePacket, createAnthropicLlmClient({ onUsage: usage.onUsage }));
    await completeActionPackage(packageId, pkg, planExperimentRecord(pkg));
  } catch (err) {
    // Details go to the log; the visitor gets a plain, actionable message.
    console.error("[build-package] generation failed:", err);
    const message =
      err instanceof ActionPackageError || err instanceof LlmCallError
        ? "Gauntlet couldn't write a valid implementation brief this time. Please try again."
        : "Something went wrong while writing the implementation brief. Please try again.";
    await failActionPackage(packageId, message).catch((writeErr) => {
      console.error("[build-package] could not record the failure:", writeErr);
    });
  } finally {
    await usage.flush();
  }
}
