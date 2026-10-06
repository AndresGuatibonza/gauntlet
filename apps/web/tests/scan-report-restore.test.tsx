import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { ActionPackage, OpportunityCard } from "@gauntlet/core";
import { ScanReport, restoredView } from "@/components/scan-report";
import type { ScanJobResponse } from "@/lib/scan-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ID = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";

function card(title: string, nextAction: OpportunityCard["nextAction"]): OpportunityCard {
  return {
    title,
    observation: "o",
    problemStatement: "p",
    hypothesis: `h ${title}`,
    changeSurface: "ux",
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "m", guardrails: "g", stoppingRule: "s" },
    expectedImpact: { level: "medium", rationale: "r", score: 2 },
    effort: { level: "low", explanation: "e", score: 3 },
    confidence: { level: "medium", evidenceQualityScore: 2 },
    missingEvidence: "me",
    nextAction,
    evidenceRefs: [],
  };
}

const job = {
  id: ID,
  url: "https://acme.com/",
  status: "done",
  evidencePacket: null,
  opportunityReport: { cards: [card("First", "build_this"), card("Second", "do_not_prioritize_yet"), card("Third", "do_not_prioritize_yet")] },
  reviewRecords: [],
  errorMessage: null,
} as unknown as ScanJobResponse;

const pkg = {
  objective: "Restored objective.",
  nonGoals: ["n"],
  likelyComponents: ["the hero"],
  approach: ["a"],
  featureFlag: { name: "restored_flag", rollout: "50%" },
  acceptanceCriteria: ["1"],
  measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "d" },
  rollbackCriteria: ["r"],
  risks: [{ risk: "x", mitigation: "y" }],
  missingContext: ["m"],
} as unknown as ActionPackage;

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

/** Routes the report's requests; `packages` is what GET /packages lists. */
function stubFetch(packages: unknown[], perCard: (index: number, method: string) => Promise<Response>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/packages")) return json({ packages });
    if (url.endsWith("/viewer")) return json({ authAvailable: false, signedIn: false, login: null, isOwner: false, claimed: false });
    if (url.endsWith("/events")) return Promise.resolve(new Response(null, { status: 204 }));
    const m = url.match(/\/cards\/(\d+)\/package$/);
    if (m) return perCard(Number(m[1]), init?.method ?? "GET");
    return json({ status: "none" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("reopening a report", () => {
  it("shows briefs already written, without another Build this, and flags them on the card", async () => {
    const fetchMock = stubFetch(
      [
        { cardIndex: 0, status: "ready", package: pkg, codingAgentPrompt: "P", markdown: "M" },
        { cardIndex: 2, status: "failed", error: "Writing failed.", canRetry: true },
      ],
      () => json({ status: "none" }),
    );
    const { findByText, getAllByText, getByText } = render(<ScanReport job={job} />);

    expect(await findByText("Restored objective.")).toBeTruthy();
    expect(getAllByText("Brief ready")).toHaveLength(1);
    expect(getByText("Writing failed.")).toBeTruthy();
    // Nothing was requested again for any card.
    expect(fetchMock.mock.calls.filter(([u]) => /\/cards\/\d+\/package$/.test(String(u)))).toHaveLength(0);
  });

  it("follows a brief still being written until it is ready, with GET only", async () => {
    let polls = 0;
    const fetchMock = stubFetch([{ cardIndex: 1, status: "generating" }], (index, method) => {
      expect(index).toBe(1);
      expect(method).toBe("GET");
      polls += 1;
      return json({ status: "ready", package: pkg, codingAgentPrompt: "P", markdown: "M" });
    });
    const { findByText } = render(<ScanReport job={job} />);
    expect(await findByText("Restored objective.")).toBeTruthy();
    expect(polls).toBe(1);
    expect(fetchMock.mock.calls.filter(([u, init]) => /\/package$/.test(String(u)) && (init as RequestInit).method === "POST")).toHaveLength(0);
  });

  it("still works when the list can't be loaded: Build this asks as before", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/packages")) return Promise.reject(new Error("offline"));
        if (url.endsWith("/viewer")) return json({ authAvailable: false });
        if (url.endsWith("/events")) return Promise.resolve(new Response(null, { status: 204 }));
        if (url.endsWith("/cards/0/package") && init?.method === "POST") return json({ status: "ready", package: pkg, codingAgentPrompt: "P", markdown: "M" });
        return json({ status: "none" });
      }),
    );
    const { getAllByText, findByText } = render(<ScanReport job={job} />);
    await waitFor(() => expect(getAllByText("Build this", { exact: false }).length).toBe(3));
    fireEvent.click(getAllByText("Build this", { exact: false })[0]!);
    expect(await findByText("Restored objective.")).toBeTruthy();
  });
});

describe("restoredView", () => {
  it("keeps ready and failed briefs, and leaves ones being written to polling", () => {
    expect(restoredView({ cardIndex: 0, status: "ready", package: pkg, codingAgentPrompt: "P", markdown: "M" })).toEqual({
      status: "ready",
      package: pkg,
      codingAgentPrompt: "P",
      markdown: "M",
    });
    expect(restoredView({ cardIndex: 0, status: "failed", error: "e", canRetry: false })).toEqual({ status: "failed", error: "e", canRetry: false });
    expect(restoredView({ cardIndex: 0, status: "generating" })).toBeNull();
    expect(restoredView({ cardIndex: 0, status: "none" })).toBeNull();
  });
});
