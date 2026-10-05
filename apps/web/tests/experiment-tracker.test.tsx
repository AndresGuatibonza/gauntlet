import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ExperimentTracker } from "@/components/experiment-tracker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = {
  hypothesis: "h", evidenceSnapshot: [], change: { featureFlag: "f", summary: "s" },
  experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
  result: null, decision: null, outcome: null,
};

function respond(record: Record<string, unknown>, status = 200) {
  return { ok: status < 400, status, json: async () => (status < 400 ? { experiment: { id: "e", record: { ...base, ...record }, decidedAt: null } } : { error: record["error"] }) };
}

describe("ExperimentTracker", () => {
  it("walks planned -> running -> decided -> outcome, sending each update", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ status: "planned" }))
      .mockResolvedValueOnce(respond({ status: "running" }))
      .mockResolvedValueOnce(respond({ status: "decided", decision: "discard", result: "No lift" }))
      .mockResolvedValueOnce(respond({ status: "decided", decision: "discard", result: "No lift", outcome: "Reverted" }));
    vi.stubGlobal("fetch", fetchMock);
    const { getByText, findByText, getByRole, container } = render(<ExperimentTracker scanId="s1" cardIndex={2} />);

    fireEvent.click(await findByText("Mark as running"));
    await findByText("Running");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/scans/s1/cards/2/experiment");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ running: true });

    fireEvent.click(getByText("Record the result"));
    expect((getByText("Save decision") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("radio", { name: /Discard/ }));
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "No lift" } });
    fireEvent.click(getByText("Save decision"));
    await findByText("Discarded");
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({ decision: "discard", result: "No lift" });
    expect(getByText("No lift")).toBeTruthy();

    fireEvent.click(getByText("Add what happened next"));
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "Reverted" } });
    fireEvent.click(getByText("Save outcome"));
    await findByText("Reverted");
  });

  it("shows the server's reason when an update is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(respond({ status: "planned" })).mockResolvedValueOnce(respond({ error: "This experiment changed in the meantime. Reload to see it." }, 409)),
    );
    const { findByText } = render(<ExperimentTracker scanId="s1" cardIndex={0} />);
    fireEvent.click(await findByText("Mark as running"));
    await waitFor(async () => expect(await findByText(/changed in the meantime/)).toBeTruthy());
  });

  it("says when the experiment hasn't started", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ experiment: null }) }));
    const { findByText } = render(<ExperimentTracker scanId="s1" cardIndex={0} />);
    await findByText(/hasn't been started yet/);
  });
});
