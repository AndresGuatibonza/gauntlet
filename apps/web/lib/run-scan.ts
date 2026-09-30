/**
 * The actual scan -> Scientist -> Reviewer pipeline, run inside
 * `after()` (see app/api/scans/route.ts) so it continues after the HTTP
 * response has already gone back to the browser. Mirrors
 * packages/cli/src/index.ts's `scan` + `analyze` commands almost exactly --
 * same @gauntlet/core calls, same order -- adapted to report progress into
 * a scan_jobs row instead of console.log, and to end in a stored
 * error_message instead of a CLI exit code.
 *
 * Every stage is wrapped so a failure anywhere (a bad URL, a Claude API
 * error, a Reviewer dropping every card) lands the job in "failed" with a
 * real message, never leaves it stuck in an intermediate status forever --
 * the report page has nothing else to show the person if this hangs.
 */
import {
  nodeHttpClient,
  RobotsChecker,
  RateLimiter,
  PageFetcher,
  discoverAndFetchPages,
  DEFAULT_MAX_PAGES,
  extractPage,
  buildEvidencePacket,
  type PageScanResult,
  type EvidencePacket,
  EvidencePacketSchema,
  hasInsufficientEvidence,
  describeInsufficientEvidence,
  createAnthropicLlmClient,
  LlmCallError,
  generateOpportunityReport,
  ScientistError,
  reviewOpportunityReport,
  ReviewerError,
} from "@gauntlet/core";
import { recordScanEvent, updateScanJob } from "./store.js";

export async function runScanJob(jobId: string, url: string, category: "ai_tool" | "ai_saas"): Promise<void> {
  try {
    await updateScanJob(jobId, { status: "scanning" });

    const robots = new RobotsChecker(nodeHttpClient);
    const rateLimiter = new RateLimiter();
    const fetcher = new PageFetcher(nodeHttpClient, robots, rateLimiter);

    const { fetched, notReachable } = await discoverAndFetchPages(url, fetcher, DEFAULT_MAX_PAGES);
    const pages: PageScanResult[] = fetched.map((f) => ({
      fetch: f,
      extraction: f.ok && f.html ? extractPage(f.html, f.url) : null,
    }));

    const packet = buildEvidencePacket({
      homepageUrl: url,
      category,
      pages,
      notReachable,
      now: () => new Date().toISOString(),
    });

    const parsedPacket = EvidencePacketSchema.safeParse(packet);
    if (!parsedPacket.success) {
      // Same invariant the CLI enforces: never persist or hand to the
      // Scientist a packet that fails its own contract.
      await failJob(jobId, `Internal error: built Evidence Packet failed contract validation: ${parsedPacket.error.message}`);
      return;
    }

    // Zero evidence makes the Scientist's contract unsatisfiable (every card
    // must cite a real evidence id), so fail here with the real upstream
    // reason (e.g. HTTP 403) instead of burning two Claude calls on a
    // misleading "evidenceRefs must contain at least 1 element" error. The
    // packet is still stored so the failure can be inspected afterwards.
    if (hasInsufficientEvidence(parsedPacket.data)) {
      await failJob(jobId, describeInsufficientEvidence(parsedPacket.data), { evidencePacket: parsedPacket.data });
      return;
    }

    await updateScanJob(jobId, { status: "analyzing", evidencePacket: parsedPacket.data });

    let llmClient;
    try {
      llmClient = createAnthropicLlmClient();
    } catch (err) {
      await failJob(jobId, err instanceof Error ? err.message : String(err));
      return;
    }

    let scientistReport;
    try {
      scientistReport = await generateOpportunityReport(parsedPacket.data, llmClient);
    } catch (err) {
      await failJob(jobId, describeStageError("Scientist", err));
      return;
    }

    await updateScanJob(jobId, { status: "reviewing" });

    try {
      const reviewed = await reviewOpportunityReport(scientistReport, parsedPacket.data, llmClient);
      await updateScanJob(jobId, {
        status: "done",
        opportunityReport: reviewed.report,
        reviewRecords: reviewed.reviewRecords,
      });
      // Best-effort: a failed analytics write must never turn a finished,
      // stored report into a "failed" scan the visitor can't see.
      await recordScanEvent({ scanJobId: jobId, type: "scan_completed" }).catch((eventErr) => {
        console.error("[run-scan] could not record scan_completed:", eventErr);
      });
    } catch (err) {
      await failJob(jobId, describeStageError("Reviewer", err));
    }
  } catch (err) {
    // Catch-all: a failure in fetching/discovery itself (not caught by the
    // more specific blocks above) still has to land the job in "failed"
    // rather than leaving it stuck at "queued"/"scanning" forever.
    await failJob(jobId, err instanceof Error ? err.message : String(err)).catch(() => {
      // If even the failure write fails (e.g. the DB connection itself is
      // down), there's nothing further to do from inside a background
      // after() callback -- there's no request left to report to.
    });
  }
}

/**
 * The single way a job ends in "failed": stores the message (and, when
 * given, the packet for later inspection) and records the scan_failed
 * funnel event. The event write is best-effort -- analytics must never
 * mask or replace the real failure -- but the status update is not: if it
 * throws, the caller's catch-all still sees it.
 */
async function failJob(jobId: string, errorMessage: string, extra: { evidencePacket?: EvidencePacket } = {}): Promise<void> {
  await updateScanJob(jobId, { status: "failed", errorMessage, ...extra });
  await recordScanEvent({ scanJobId: jobId, type: "scan_failed" }).catch((eventErr) => {
    console.error("[run-scan] could not record scan_failed:", eventErr);
  });
}

function describeStageError(stage: "Scientist" | "Reviewer", err: unknown): string {
  if (err instanceof ScientistError || err instanceof ReviewerError || err instanceof LlmCallError) {
    return `${stage} error: ${err.message}`;
  }
  return `${stage} error (unexpected): ${err instanceof Error ? err.message : String(err)}`;
}
