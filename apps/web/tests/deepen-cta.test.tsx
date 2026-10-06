import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { DeepenCta } from "@/components/scan-report";
import type { RepositoryConnection } from "@/lib/use-repository";

afterEach(cleanup);

const notConnected: RepositoryConnection = { status: "ready", connected: null, accessible: [] };
const connected: RepositoryConnection = {
  status: "ready",
  connected: { repositoryId: 1, fullName: "acme/web", defaultBranch: "main", connectedAt: "2026-10-05T15:00:00.000Z" },
  accessible: [],
};

function link(container: HTMLElement): HTMLAnchorElement | null {
  return container.querySelector("a");
}

describe("DeepenCta (Make this recommendation smarter)", () => {
  it("sends visitors to sign in first, and reports the click", () => {
    const onClick = vi.fn();
    const { container } = render(<DeepenCta scanId="s1" isOwner={false} connection={{ status: "loading" }} onClick={onClick} />);
    expect(link(container)!.getAttribute("href")).toBe("/signup?from=s1");
    fireEvent.click(link(container)!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sends the owner straight to connecting GitHub when no repository is connected", () => {
    const { container } = render(<DeepenCta scanId="s1" isOwner connection={notConnected} onClick={vi.fn()} />);
    expect(link(container)!.getAttribute("href")).toBe("/api/github/connect?scan=s1");
  });

  it("steps aside for the owner once a repository is connected, or while GitHub can't be used", () => {
    for (const connection of [connected, { status: "loading" }, { status: "unavailable" }, { status: "error", error: "x" }] as RepositoryConnection[]) {
      const { container } = render(<DeepenCta scanId="s1" isOwner connection={connection} onClick={vi.fn()} />);
      expect(link(container)).toBeNull();
      cleanup();
    }
  });
});
