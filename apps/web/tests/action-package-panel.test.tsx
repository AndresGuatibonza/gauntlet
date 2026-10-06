import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { ActionPackage } from "@gauntlet/core";
import { ActionPackagePanel } from "@/components/action-package-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pkg = {
  objective: "Show the starting price next to the main call to action.",
  nonGoals: ["Changing prices"],
  likelyComponents: ["the homepage hero"],
  approach: ["Read the price from the pricing source", "Render it when the flag is on"],
  featureFlag: { name: "hero_price", rollout: "50% of new visitors" },
  acceptanceCriteria: ["Price visible with flag on", "Matches pricing page", "Unchanged with flag off"],
  measurement: { howToMeasure: "Compare signup completion", baseline: "Measure two weeks first", minimumDuration: "two weeks" },
  rollbackCriteria: ["Signups drop more than 5%"],
  risks: [{ risk: "Stale price", mitigation: "Single source" }],
  missingContext: ["where the hero component lives"],
} as unknown as ActionPackage;

const ready = { status: "ready" as const, package: pkg, codingAgentPrompt: "PROMPT TEXT", markdown: "# Brief" };

describe("ActionPackagePanel", () => {
  it("shows live progress while the brief is written", () => {
    const { container } = render(<ActionPackagePanel view={{ status: "generating" }} onRetry={vi.fn()} connectRepoHref="/signup" />);
    expect(container.querySelector(".activity-line")?.textContent).toContain("Writing the implementation brief");
  });

  it("offers a retry only when the failure allows one", () => {
    const onRetry = vi.fn();
    const { getByText, rerender, queryByText } = render(
      <ActionPackagePanel view={{ status: "failed", error: "Something went wrong.", canRetry: true }} onRetry={onRetry} connectRepoHref="/signup" />,
    );
    fireEvent.click(getByText("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ActionPackagePanel view={{ status: "failed", error: "Limit reached.", canRetry: false }} onRetry={onRetry} connectRepoHref="/signup" />);
    expect(queryByText("Try again")).toBeNull();
    expect(getByText("Limit reached.")).toBeTruthy();
  });

  it("renders the brief and links repo connection through signup", () => {
    const { getByText } = render(<ActionPackagePanel view={ready} onRetry={vi.fn()} connectRepoHref="/signup?from=j&card=0" />);
    expect(getByText(pkg.objective)).toBeTruthy();
    expect(getByText("hero_price")).toBeTruthy();
    expect(getByText("Unchanged with flag off")).toBeTruthy();
    expect(getByText("Connect your repository").getAttribute("href")).toBe("/signup?from=j&card=0");
  });

  it("leads with the objective, flag and where to change it, and folds the full plan", () => {
    const { container, getByText } = render(<ActionPackagePanel view={ready} onRetry={vi.fn()} connectRepoHref="/signup" />);
    const summary = container.querySelector(".package-summary") as HTMLElement;
    expect(summary.textContent).toContain("hero_price");
    expect(summary.textContent).toContain("the homepage hero");
    const more = container.querySelector("details.brief-more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.contains(getByText("Read the price from the pricing source"))).toBe(true);
    expect(more.contains(getByText("Signups drop more than 5%"))).toBe(true);
    expect(more.contains(getByText("Stale price", { exact: false }))).toBe(true);
  });

  it("copies the coding-agent prompt, and explains the fallback when copying is blocked", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const { getByText, findByText } = render(<ActionPackagePanel view={ready} onRetry={vi.fn()} connectRepoHref="/signup" />);
    fireEvent.click(getByText("Copy prompt for your coding agent"));
    await findByText("Prompt copied");
    expect(writeText).toHaveBeenCalledWith("PROMPT TEXT");
    fireEvent.click(getByText("Prompt copied"));
    await waitFor(() => expect(getByText(/Your browser blocked copying/)).toBeTruthy());
  });

  it("downloads the brief as a Markdown file named after the flag", () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("gauntlet-brief-hero_price.md");
    });
    const { getByText } = render(<ActionPackagePanel view={ready} onRetry={vi.fn()} connectRepoHref="/signup" />);
    fireEvent.click(getByText("Download brief (.md)"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});
