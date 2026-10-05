// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { core, getScanJob, getActionPackage, repoStore, mintRepositoryToken, readGitHubAppConfig } = vi.hoisted(() => ({
  core: {
    analyzeRepositoryForCard: vi.fn(),
    generateActionPackage: vi.fn(),
    createAnthropicLlmClient: vi.fn(() => ({ complete: vi.fn() })),
    createGitHubRepoReader: vi.fn(() => ({ reader: true })),
  },
  getScanJob: vi.fn(),
  getActionPackage: vi.fn(),
  repoStore: {
    completeRepoBrief: vi.fn(async () => {}),
    failRepoBrief: vi.fn(async () => {}),
    getRepoBriefAnalysis: vi.fn(),
    getScanWorkspace: vi.fn(),
    getWorkspaceRepository: vi.fn(),
    saveRepoBriefAnalysis: vi.fn(async () => {}),
  },
  mintRepositoryToken: vi.fn(async (..._args: unknown[]) => "ghs_one_repo"),
  readGitHubAppConfig: vi.fn((): unknown => ({ appId: "1" })),
}));
vi.mock("@gauntlet/core", async (orig) => ({ ...(await orig<typeof import("@gauntlet/core")>()), ...core }));
vi.mock("@/lib/store", () => ({ getScanJob, getActionPackage }));
vi.mock("@/lib/repo-store", () => repoStore);
vi.mock("@/lib/github-app", async (orig) => ({ ...(await orig<typeof import("@/lib/github-app")>()), mintRepositoryToken, readGitHubAppConfig }));

import { ActionPackageError, RepoAccessError, RepoAnalysisError, LlmCallError } from "@gauntlet/core";
import { GitHubAppError } from "@/lib/github-app";
import { repoBriefFailureMessage, runRepoBriefJob } from "@/lib/build-repo-brief";

const SCAN = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";
const card = { title: "Card" };
const packet = { productIdentity: {} };
const REPO = { installationId: 7, repositoryId: 42, fullName: "acme/web", defaultBranch: "main", connectedAt: "x" };
const analysis = { version: 1, codeContext: {}, refinement: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getScanJob.mockResolvedValue({ id: SCAN, status: "done", evidencePacket: packet, opportunityReport: { cards: [card] } });
  repoStore.getScanWorkspace.mockResolvedValue({ workspaceId: "w", ownerUserId: "u" });
  repoStore.getWorkspaceRepository.mockResolvedValue(REPO);
  getActionPackage.mockResolvedValue({ state: "ready", package: { likelyComponents: ["the hero"] } });
  core.analyzeRepositoryForCard.mockResolvedValue(analysis);
  core.generateActionPackage.mockResolvedValue({ pkg: true });
});

describe("runRepoBriefJob", () => {
  it("reads the one repository with a scoped token, stores the analysis, then writes the package", async () => {
    await runRepoBriefJob("b1", SCAN, 0, false);
    expect(mintRepositoryToken).toHaveBeenCalledWith({ appId: "1" }, 7, 42);
    expect(core.createGitHubRepoReader).toHaveBeenCalledWith({ token: "ghs_one_repo", repository: "acme/web", ref: "main" });
    expect(core.analyzeRepositoryForCard).toHaveBeenCalledWith(card, packet, { reader: true }, expect.anything(), { hints: ["the hero"] });
    expect(repoStore.saveRepoBriefAnalysis).toHaveBeenCalledWith("b1", analysis);
    expect(core.generateActionPackage).toHaveBeenCalledWith(card, packet, expect.anything(), { repoAnalysis: analysis });
    expect(repoStore.completeRepoBrief).toHaveBeenCalledWith("b1", { pkg: true });
    expect(repoStore.failRepoBrief).not.toHaveBeenCalled();
  });

  it("reuses a stored analysis on retry: no GitHub read, no analysis call", async () => {
    repoStore.getRepoBriefAnalysis.mockResolvedValue(analysis);
    await runRepoBriefJob("b1", SCAN, 0, true);
    expect(mintRepositoryToken).not.toHaveBeenCalled();
    expect(core.analyzeRepositoryForCard).not.toHaveBeenCalled();
    expect(repoStore.completeRepoBrief).toHaveBeenCalledWith("b1", { pkg: true });
  });

  it("fails cleanly when the repository was disconnected or the App isn't configured", async () => {
    repoStore.getWorkspaceRepository.mockResolvedValueOnce(null);
    await runRepoBriefJob("b1", SCAN, 0, false);
    expect(repoStore.failRepoBrief).toHaveBeenLastCalledWith("b1", expect.stringContaining("disconnected"));
    readGitHubAppConfig.mockReturnValueOnce(null);
    await runRepoBriefJob("b2", SCAN, 0, false);
    expect(repoStore.failRepoBrief).toHaveBeenLastCalledWith("b2", "GitHub connections are not available right now.");
    expect(core.analyzeRepositoryForCard).not.toHaveBeenCalled();
  });

  it("turns a lost installation into an actionable message naming the repository", async () => {
    mintRepositoryToken.mockRejectedValueOnce(new GitHubAppError("refused", "gone"));
    await runRepoBriefJob("b1", SCAN, 0, false);
    expect(repoStore.failRepoBrief).toHaveBeenCalledWith("b1", expect.stringContaining("Gauntlet can no longer read acme/web"));
    expect(repoStore.completeRepoBrief).not.toHaveBeenCalled();
  });
});

describe("repoBriefFailureMessage", () => {
  it.each([
    [new RepoAccessError("x", "unauthorized"), "can no longer read acme/web"],
    [new RepoAccessError("x", "not_found"), "can no longer read acme/web"],
    [new RepoAccessError("x", "rate_limited"), "rate limit"],
    [new GitHubAppError("x", "rate_limited"), "rate limit"],
    [new RepoAccessError("x", "failed"), "couldn't reach GitHub"],
    [new RepoAnalysisError("acme/web has no readable source files to analyze."), "acme/web has no readable source files to analyze. The repo-aware brief needs"],
    [new RepoAnalysisError("Could not produce a valid code analysis after 2 attempt(s). Last error: secret details"), "couldn't write a valid repo-aware brief"],
    [new ActionPackageError("x"), "couldn't write a valid repo-aware brief"],
    [new LlmCallError("x"), "couldn't write a valid repo-aware brief"],
    [new Error("db down"), "Something went wrong"],
  ])("maps %s", (err, expected) => {
    const message = repoBriefFailureMessage(err, "acme/web");
    expect(message).toContain(expected);
    expect(message).not.toContain("secret details");
  });
});
