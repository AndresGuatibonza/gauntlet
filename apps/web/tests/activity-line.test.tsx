import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { ActivityLine } from "@/components/activity-line";

// Real timers: framer-motion's exit animation (mode="wait") runs on its own
// frame loop, which fake timers don't drive -- same reason as status-tracker.test.tsx.
afterEach(() => cleanup());

function shown(container: HTMLElement): string {
  return container.querySelector(".activity-line")?.textContent ?? "";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ActivityLine", () => {
  it("rotates through the lines and is announced politely", async () => {
    const { container } = render(<ActivityLine lines={["One", "Two"]} rotateMs={700} />);
    const line = container.querySelector(".activity-line")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(shown(container)).toBe("One…");
    await waitFor(() => expect(shown(container)).toBe("Two…"), { timeout: 2000 });
  });

  it("jumps straight to a new real step instead of waiting its turn", async () => {
    const { container, rerender } = render(<ActivityLine lines={["Reading the homepage"]} rotateMs={60_000} />);
    rerender(<ActivityLine lines={["Reading /pricing (2 of 8)"]} rotateMs={60_000} />);
    await waitFor(() => expect(shown(container)).toBe("Reading /pricing (2 of 8)…"), { timeout: 2000 });
  });

  it("does not rotate a single line", async () => {
    const { container } = render(<ActivityLine lines={["Getting things ready"]} rotateMs={50} />);
    await wait(400);
    expect(shown(container)).toBe("Getting things ready…");
  });
});
