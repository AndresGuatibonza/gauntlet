import { describe, it, expect, vi } from "vitest";
import { createProgressReporter, describePage, plural, type ScanProgress } from "@/lib/progress";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createProgressReporter", () => {
  it("writes reports strictly in order, so a slow write can't land after a newer one", async () => {
    const written: string[] = [];
    const first = deferred();
    const write = vi.fn(async (p: ScanProgress) => {
      if (p.message === "page 2") await first.promise;
      written.push(p.message);
    });
    const reporter = createProgressReporter(write);
    reporter.report("scanning", "page 2");
    reporter.report("scanning", "page 3");
    await Promise.resolve();
    expect(written).toEqual([]); // page 3 waits for page 2
    first.resolve();
    await reporter.flush();
    expect(written).toEqual(["page 2", "page 3"]);
  });

  it("drops a failed write, reports it, and keeps writing later ones", async () => {
    const errors: unknown[] = [];
    const written: string[] = [];
    const reporter = createProgressReporter(
      async (p) => {
        if (p.message === "bad") throw new Error('column "progress" does not exist');
        written.push(p.message);
      },
      (err) => errors.push(err),
    );
    reporter.report("scanning", "bad");
    reporter.report("analyzing", "good");
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(written).toEqual(["good"]);
    expect(errors).toHaveLength(1);
  });
});

describe("describePage", () => {
  it("names the page by its path, never the full URL", () => {
    expect(describePage("https://example.com/")).toBe("the homepage");
    expect(describePage("https://example.com/pricing?ref=nav")).toBe("/pricing");
    expect(describePage("https://example.com/docs/")).toBe("/docs");
    expect(describePage("https://example.com/" + "a".repeat(80))).toHaveLength(40);
    expect(describePage("not a url")).toBe("a page");
  });

  it("pluralizes counts", () => {
    expect(plural(1, "page", "pages")).toBe("1 page");
    expect(plural(8, "page", "pages")).toBe("8 pages");
  });
});
