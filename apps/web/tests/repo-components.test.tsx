import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RepoConnection } from "@/components/repo-connection";
import { RepoBriefPanel, toBriefView } from "@/components/repo-brief-panel";
import type { UseRepository } from "@/lib/use-repository";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SHA = "c".repeat(40);

function analysis() {
  return {
    version: 1,
    generatedAt: "2026-10-05T15:00:00.000Z",
    cardTitle: "Card",
    selection: [{ path: "apps/web/app/page.tsx", reason: "hero" }],
    codeContext: {
      source: { provider: "github", repository: "acme/web", ref: SHA, pulledAt: "2026-10-05T15:00:00.000Z", filesInTree: 40, treeTruncated: false, filesInspected: ["apps/web/app/page.tsx", "package.json"] },
      items: [
        { id: "C1", sourceRef: `github:acme/web@${SHA}`, evidenceType: "architecture", observation: "Monorepo with apps/web.", rawExcerpt: "{}", confidence: "high", path: null, lines: null },
        {
          id: "C2",
          sourceRef: `github:acme/web@${SHA}:apps/web/app/page.tsx#L3-L4`,
          evidenceType: "code_location",
          observation: "The hero renders the CTA.",
          rawExcerpt: "export default function Home() {\n  return <a>Start</a>;",
          confidence: "high",
          path: "apps/web/app/page.tsx",
          lines: { start: 3, end: 4 },
        },
      ],
      notInspected: ["No CODEOWNERS file: code ownership is not discoverable from the repository."],
    },
    refinement: {
      confidence: { level: "high", rationale: "One component renders it.", evidenceRefs: ["C2"] },
      effort: { level: "low", rationale: "A flag hook exists.", evidenceRefs: ["C2"] },
      implementationSurface: [{ path: "apps/web/app/page.tsx", role: "Renders the hero CTA." }],
      experimentNotes: ["Reuse posthog-js flags."],
      contradictions: ["The pricing page is a CMS page, not code."],
      stillMissing: ["Current flag rollout."],
    },
  };
}

function pkg() {
  return {
    objective: "Show the price next to the CTA.", nonGoals: ["n"], likelyComponents: ["apps/web/app/page.tsx -- the hero"], approach: ["a", "b"],
    featureFlag: { name: "homepage_price", rollout: "50%" }, acceptanceCriteria: ["1", "2", "3"],
    measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "2 weeks" }, rollbackCriteria: ["r"],
    risks: [{ risk: "x", mitigation: "y" }], missingContext: ["Rollout state"], evidenceRefs: ["C2"], version: 1,
    generatedAt: "2026-10-05T15:00:00.000Z", product: { name: "Acme", url: "https://acme.com/" },
    card: { title: "Card", hypothesis: "h", changeSurface: "ux", missingEvidence: "me" },
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
    codeContext: "github", repository: { name: "acme/web", ref: SHA, filesInspected: 2 },
    citedEvidence: [{ id: "C2", observation: "o", sourceRef: "s" }],
  };
}

const ready = () => ({ status: "ready", repository: "acme/web", analysis: analysis(), package: pkg(), codingAgentPrompt: "PROMPT", markdown: "# MD" });
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("toBriefView", () => {
  it("maps every API answer, and keeps polling only while generating", () => {
    expect(toBriefView(202, { status: "generating", stage: "reading" })).toBeNull();
    expect(toBriefView(200, { status: "none" })).toEqual({ status: "none" });
    expect(toBriefView(429, { error: "Limit" })).toEqual({ status: "failed", error: "Limit", canRetry: false });
    expect(toBriefView(409, { error: "Use Build this first" })).toEqual({ status: "failed", error: "Use Build this first", canRetry: true });
    expect(toBriefView(403, { error: "Only the owner" })).toEqual({ status: "failed", error: "Only the owner", canRetry: false });
    expect(toBriefView(200, { status: "failed", error: "x", canRetry: true })).toEqual({ status: "failed", error: "x", canRetry: true });
    expect(toBriefView(200, { status: "ready" })).toMatchObject({ status: "failed", error: "The repo-aware brief came back incomplete." });
    expect(toBriefView(500, null)).toEqual({ status: "failed", error: "Request failed (500).", canRetry: true });
  });
});

describe("RepoBriefPanel", () => {
  it("offers to write the brief, follows it, then shows what the code changed and the rewritten brief", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ status: "none" }))
      .mockResolvedValueOnce(reply({ status: "generating", stage: "reading", repository: "acme/web" }, 202))
      .mockResolvedValueOnce(reply(ready()));
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByText, getByRole, container } = render(<RepoBriefPanel scanId="s1" cardIndex={1} repository="acme/web" />);

    fireEvent.click(await findByText("Write a repo-aware brief"));
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/scans/s1/cards/1/repo-brief");
    expect(fetchMock.mock.calls[1]![1].method).toBe("POST");
    await findByText("Reading acme/web");

    await findByText("What the code changes", undefined, { timeout: 5000 });
    expect(fetchMock.mock.calls[2]![1].method).toBe("GET");
    expect(getByText("High")).toBeTruthy();
    expect(getByText("Renders the hero CTA.")).toBeTruthy();
    expect(getByText("The pricing page is a CMS page, not code.")).toBeTruthy();
    expect(getByText("Code evidence (2)")).toBeTruthy();
    expect(container.querySelector("pre.code-excerpt")!.textContent).toBe("export default function Home() {\n  return <a>Start</a>;");
    expect(getByText("Repo-aware implementation brief")).toBeTruthy();
    expect(getByText("Where to change it")).toBeTruthy();
    expect(getByRole("button", { name: "Copy prompt for your coding agent" })).toBeTruthy();
    expect(getByText("What this targeted read could not settle:")).toBeTruthy();
  });

  it("leads with how the code moved the card's confidence and effort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(ready())));
    const { findByRole, container } = render(
      <RepoBriefPanel scanId="s1" cardIndex={0} repository="acme/web" publicLevels={{ confidence: "medium", effort: "low" }} />,
    );
    const deltas = await findByRole("list", { name: "Revised scores" });
    const items = Array.from(deltas.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual(["Confidence Medium → High", "Effort Low (unchanged)"]);
    expect(deltas.querySelector("s")!.textContent).toBe("Medium");
    const more = Array.from(container.querySelectorAll("details")).find((d) => d.textContent!.includes("Running it here"))!;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("Reuse posthog-js flags.");
    expect(more.textContent).toContain("Current flag rollout.");
  });

  it("shows only the repo-aware level when the public one is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(ready())));
    const { findByRole } = render(<RepoBriefPanel scanId="s1" cardIndex={0} repository="acme/web" />);
    const deltas = await findByRole("list", { name: "Revised scores" });
    expect(Array.from(deltas.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["Confidence High", "Effort Low"]);
    expect(deltas.querySelector("s")).toBeNull();
  });

  it("shows an existing failure with a retry that starts again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ status: "failed", error: "Gauntlet can no longer read acme/web.", canRetry: true }))
      .mockResolvedValueOnce(reply(ready()));
    vi.stubGlobal("fetch", fetchMock);
    const { findByText } = render(<RepoBriefPanel scanId="s1" cardIndex={0} repository="acme/web" />);
    fireEvent.click(await findByText("Try again"));
    await findByText("What the code changes");
    expect(fetchMock.mock.calls[1]![1].method).toBe("POST");
  });
});

function repoHook(overrides: Partial<UseRepository> = {}): UseRepository {
  return {
    connection: { status: "ready", connected: null, accessible: [] },
    busy: false,
    actionError: null,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("RepoConnection", () => {
  it("invites the owner to connect GitHub when nothing is accessible yet", () => {
    const { getByText } = render(<RepoConnection scanId="s1" cardIndex={0} repo={repoHook()} />);
    expect(getByText("Connect GitHub").getAttribute("href")).toBe("/api/github/connect?scan=s1");
    expect(getByText("Already installed the app?").getAttribute("href")).toBe("/api/github/connect?scan=s1&mode=authorize");
  });

  it("lets the owner pick one of their repositories", async () => {
    const repo = repoHook({
      connection: {
        status: "ready",
        connected: null,
        accessible: [
          { repositoryId: 1, fullName: "acme/api", private: true },
          { repositoryId: 2, fullName: "acme/web", private: false },
        ],
      },
    });
    const { getByLabelText, getByText } = render(<RepoConnection scanId="s1" cardIndex={0} repo={repo} />);
    fireEvent.change(getByLabelText("Which repository holds this product's code?"), { target: { value: "2" } });
    fireEvent.click(getByText("Use this repository"));
    await waitFor(() => expect(repo.connect).toHaveBeenCalledWith(2));
    expect(getByText("acme/api (private)")).toBeTruthy();
    expect(getByText("Give Gauntlet access to another repository")).toBeTruthy();
  });

  it("shows the connected repository with a disconnect, and the brief panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ status: "none" })));
    const repo = repoHook({
      connection: { status: "ready", connected: { repositoryId: 2, fullName: "acme/web", defaultBranch: "main", connectedAt: "x" }, accessible: [] },
    });
    const { getByText, findByText } = render(<RepoConnection scanId="s1" cardIndex={0} repo={repo} />);
    expect(getByText("acme/web")).toBeTruthy();
    fireEvent.click(getByText("Disconnect"));
    expect(repo.disconnect).toHaveBeenCalled();
    await findByText("Write a repo-aware brief");
  });

  it("says when GitHub isn't available, and surfaces action errors", () => {
    const { getByText, rerender } = render(<RepoConnection scanId="s1" cardIndex={0} repo={repoHook({ connection: { status: "unavailable" } })} />);
    expect(getByText("Connecting a GitHub repository isn't available yet.")).toBeTruthy();
    rerender(<RepoConnection scanId="s1" cardIndex={0} repo={repoHook({ actionError: "Gauntlet can't read that repository." })} />);
    expect(getByText("Gauntlet can't read that repository.")).toBeTruthy();
  });
});
