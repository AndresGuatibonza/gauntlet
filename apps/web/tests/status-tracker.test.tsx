import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useSteppedStage, StatusTracker, type StageKey } from "@/components/status-tracker";

function Probe({ current, log }: { current: StageKey; log: string[] }): React.JSX.Element {
  const shown = useSteppedStage(current);
  log.push(shown);
  return <span data-testid="stage">{shown}</span>;
}

/** Pulse elements are the round divs WITHOUT the base dot's color transition. */
function pulseCount(container: HTMLElement): number {
  return Array.from(container.querySelectorAll<HTMLElement>('div[style*="border-radius: 50%"]')).filter(
    (el) => !(el.getAttribute("style") ?? "").includes("background-color 0.4s"),
  ).length;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSteppedStage", () => {
  it("walks queued -> scanning -> analyzing one step per 700ms when the first poll already says analyzing", () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { getByTestId } = render(<Probe current="analyzing" log={log} />);
    expect(getByTestId("stage").textContent).toBe("queued");

    act(() => void vi.advanceTimersByTime(699));
    expect(getByTestId("stage").textContent).toBe("queued");

    act(() => void vi.advanceTimersByTime(1));
    expect(getByTestId("stage").textContent).toBe("scanning");

    act(() => void vi.advanceTimersByTime(700));
    expect(getByTestId("stage").textContent).toBe("analyzing");

    // Never runs ahead of the real stage.
    act(() => void vi.advanceTimersByTime(5000));
    expect(getByTestId("stage").textContent).toBe("analyzing");

    // No stage skipped, none repeated out of order.
    expect([...new Set(log)]).toEqual(["queued", "scanning", "analyzing"]);
  });

  it("keeps stepping when the real stage advances mid catch-up", () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { getByTestId, rerender } = render(<Probe current="scanning" log={log} />);
    act(() => void vi.advanceTimersByTime(700));
    rerender(<Probe current="reviewing" log={log} />);
    // One act() per step: React commits and runs the effect that schedules
    // the next timer only after each act() returns.
    act(() => void vi.advanceTimersByTime(700));
    act(() => void vi.advanceTimersByTime(700));
    expect(getByTestId("stage").textContent).toBe("reviewing");
    expect([...new Set(log)]).toEqual(["queued", "scanning", "analyzing", "reviewing"]);
  });
});

describe("StatusTracker pulse", () => {
  it("renders a pulse on the active stage only", () => {
    const { container } = render(<StatusTracker current="analyzing" />);
    expect(pulseCount(container)).toBe(1);
  });

  // Regression test: the pulse's exit used to inherit `repeat: Infinity`,
  // so it never completed and the completed stage kept a visible pulse.
  // Verified to FAIL against that previous code. Real timers on purpose --
  // framer-motion drives the animation itself.
  it("unmounts the previous stage's pulse once the stage completes", async () => {
    const { container, rerender } = render(<StatusTracker current="scanning" />);
    // Let the pulse get mid-loop first; switching right after mount does
    // not reproduce the stuck exit.
    await act(async () => wait(500));
    rerender(<StatusTracker current="analyzing" />);
    await act(async () => wait(900));
    expect(pulseCount(container)).toBe(1);
  });
});
