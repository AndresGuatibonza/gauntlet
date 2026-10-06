/**
 * Background generation of one repo-aware brief (GitHub deep scan, PRD
 * Build Order #4), run inside after() by POST .../repo-brief. Mirrors
 * build-package.ts: every failure lands the row in "failed" with a message
 * the owner can act on; details go to the log only.
 *
 * Steps: mint a one-hour token for this one repository -> read it at the
 * default branch's current commit -> analyze it for the card (two Claude
 * calls) -> store the analysis -> write the repo-aware package (one Claude
 * call). A retry after the package step failed reuses the stored analysis.
 */
import {
  ActionPackageError,
  analyzeRepositoryForCard,
  createAnthropicLlmClient,
  createGitHubRepoReader,
  generateActionPackage,
  LlmCallError,
  RepoAccessError,
  RepoAnalysisError,
  type RepoAnalysis,
} from "@gauntlet/core";
import { getActionPackage, getScanJob } from "./store.js";
import { GitHubAppError, mintRepositoryToken, readGitHubAppConfig } from "./github-app.js";
import {
  completeRepoBrief,
  failRepoBrief,
  getRepoBriefAnalysis,
  getScanWorkspace,
  getWorkspaceRepository,
  saveRepoBriefAnalysis,
} from "./repo-store.js";
import { createUsageRecorder } from "./llm-usage.js";

/** What the owner sees for a failure; never internal details. */
export function repoBriefFailureMessage(err: unknown, repository: string): string {
  const lostAccess =
    (err instanceof GitHubAppError && err.kind === "gone") ||
    (err instanceof RepoAccessError && (err.kind === "unauthorized" || err.kind === "forbidden" || err.kind === "not_found"));
  if (lostAccess) {
    return `Gauntlet can no longer read ${repository}. Check that the Gauntlet GitHub App is still installed with access to it, then reconnect the repository.`;
  }
  if ((err instanceof GitHubAppError || err instanceof RepoAccessError) && err.kind === "rate_limited") {
    return "GitHub's rate limit was reached. Please try again in an hour.";
  }
  if (err instanceof RepoAnalysisError && /has no files|no readable source files|None of the files chosen/.test(err.message)) {
    return `${err.message} The repo-aware brief needs the product's source code.`;
  }
  if (err instanceof RepoAnalysisError || err instanceof ActionPackageError || err instanceof LlmCallError) {
    return "Gauntlet couldn't write a valid repo-aware brief this time. Please try again.";
  }
  if (err instanceof GitHubAppError || err instanceof RepoAccessError) {
    return "Gauntlet couldn't reach GitHub just now. Please try again.";
  }
  return "Something went wrong while writing the repo-aware brief. Please try again.";
}

export async function runRepoBriefJob(briefId: string, scanJobId: string, cardIndex: number, reuseAnalysis: boolean): Promise<void> {
  let repositoryName = "the repository";
  const usage = createUsageRecorder({ scanJobId, phase: "repo_brief", cardIndex });
  try {
    const job = await getScanJob(scanJobId);
    const card = job?.opportunityReport?.cards[cardIndex];
    if (!job || job.status !== "done" || !card || !job.evidencePacket) {
      await failRepoBrief(briefId, "This report or opportunity is no longer available.");
      return;
    }
    const workspace = await getScanWorkspace(scanJobId);
    const repository = workspace ? await getWorkspaceRepository(workspace.workspaceId) : null;
    if (!repository) {
      await failRepoBrief(briefId, "The repository was disconnected. Connect it again to write a repo-aware brief.");
      return;
    }
    repositoryName = repository.fullName;
    const config = readGitHubAppConfig();
    if (!config) {
      await failRepoBrief(briefId, "GitHub connections are not available right now.");
      return;
    }
    const llm = createAnthropicLlmClient({ onUsage: usage.onUsage });

    let analysis: RepoAnalysis | null = reuseAnalysis ? await getRepoBriefAnalysis(briefId) : null;
    if (!analysis) {
      const token = await mintRepositoryToken(config, repository.installationId, repository.repositoryId);
      const reader = createGitHubRepoReader({ token, repository: repository.fullName, ref: repository.defaultBranch });
      const publicPackage = await getActionPackage(scanJobId, cardIndex);
      analysis = await analyzeRepositoryForCard(card, job.evidencePacket, reader, llm, {
        hints: publicPackage.state === "ready" ? publicPackage.package.likelyComponents : [],
      });
      await saveRepoBriefAnalysis(briefId, analysis);
    }

    const pkg = await generateActionPackage(card, job.evidencePacket, llm, { repoAnalysis: analysis });
    await completeRepoBrief(briefId, pkg);
  } catch (err) {
    console.error("[repo-brief] generation failed:", err);
    await failRepoBrief(briefId, repoBriefFailureMessage(err, repositoryName)).catch((writeErr) => {
      console.error("[repo-brief] could not record the failure:", writeErr);
    });
  } finally {
    await usage.flush();
  }
}
