import { describe, it, expect, vi } from "vitest";
import {
  RateLimiter,
  RobotsChecker,
  PageFetcher,
  type HttpClient,
  type HttpResponse,
  type Clock,
} from "../../src/core/fetcher.js";

function fakeHttpClient(responses: Record<string, HttpResponse | Error>): HttpClient {
  return {
    async get(url: string): Promise<HttpResponse> {
      const entry = responses[url];
      if (entry === undefined) {
        throw new Error(`no fake response configured for ${url}`);
      }
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

function fakeClock(): Clock & { advance(ms: number): void; sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
    sleeps,
  };
}

describe("RateLimiter", () => {
  it("does not wait on the first request to a host", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(500, clock);
    await limiter.waitForTurn("example.com");
    expect(clock.sleeps).toEqual([]);
  });

  it("waits the remaining delay when a second request comes in too soon", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(500, clock);
    await limiter.waitForTurn("example.com");
    clock.advance(100); // only 100ms elapsed, need 500ms between requests
    await limiter.waitForTurn("example.com");
    expect(clock.sleeps).toEqual([400]);
  });

  it("does not wait if enough time already elapsed", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(500, clock);
    await limiter.waitForTurn("example.com");
    clock.advance(600);
    await limiter.waitForTurn("example.com");
    expect(clock.sleeps).toEqual([]);
  });

  it("tracks hosts independently", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(500, clock);
    await limiter.waitForTurn("a.com");
    clock.advance(10);
    await limiter.waitForTurn("b.com");
    expect(clock.sleeps).toEqual([]);
  });
});

describe("RobotsChecker", () => {
  it("allows a URL when robots.txt permits it", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": {
        status: 200,
        body: "User-agent: *\nAllow: /\n",
        contentType: "text/plain",
      },
    });
    const checker = new RobotsChecker(http);
    const decision = await checker.isAllowed("https://example.com/pricing");
    expect(decision.allowed).toBe(true);
  });

  it("disallows a URL blocked by robots.txt", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /admin\n",
        contentType: "text/plain",
      },
    });
    const checker = new RobotsChecker(http);
    const decision = await checker.isAllowed("https://example.com/admin/secret");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("robots.txt");
  });

  it("default-allows when robots.txt is missing (404)", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": { status: 404, body: "", contentType: null },
    });
    const checker = new RobotsChecker(http);
    const decision = await checker.isAllowed("https://example.com/anything");
    expect(decision.allowed).toBe(true);
  });

  it("default-allows when fetching robots.txt throws", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": new Error("network down"),
    });
    const checker = new RobotsChecker(http);
    const decision = await checker.isAllowed("https://example.com/anything");
    expect(decision.allowed).toBe(true);
  });

  it("caches robots.txt per origin instead of refetching", async () => {
    const get = vi.fn(async (): Promise<HttpResponse> => ({
      status: 200,
      body: "User-agent: *\nAllow: /\n",
      contentType: "text/plain",
    }));
    const checker = new RobotsChecker({ get });
    await checker.isAllowed("https://example.com/a");
    await checker.isAllowed("https://example.com/b");
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("PageFetcher", () => {
  it("refuses to fetch a page disallowed by robots.txt", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /private\n",
        contentType: "text/plain",
      },
    });
    const fetcher = new PageFetcher(http, new RobotsChecker(http), new RateLimiter(0, fakeClock()));
    const result = await fetcher.fetch("https://example.com/private/data");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("robots.txt");
  });

  it("returns the page HTML on success", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": { status: 404, body: "", contentType: null },
      "https://example.com/": { status: 200, body: "<html></html>", contentType: "text/html" },
    });
    const fetcher = new PageFetcher(http, new RobotsChecker(http), new RateLimiter(0, fakeClock()));
    const result = await fetcher.fetch("https://example.com/");
    expect(result.ok).toBe(true);
    expect(result.html).toBe("<html></html>");
  });

  it("reports failure on HTTP error status", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": { status: 404, body: "", contentType: null },
      "https://example.com/gone": { status: 404, body: "", contentType: "text/html" },
    });
    const fetcher = new PageFetcher(http, new RobotsChecker(http), new RateLimiter(0, fakeClock()));
    const result = await fetcher.fetch("https://example.com/gone");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("404");
  });

  it("rejects non-HTML content types", async () => {
    const http = fakeHttpClient({
      "https://example.com/robots.txt": { status: 404, body: "", contentType: null },
      "https://example.com/file.pdf": { status: 200, body: "%PDF-1.4", contentType: "application/pdf" },
    });
    const fetcher = new PageFetcher(http, new RobotsChecker(http), new RateLimiter(0, fakeClock()));
    const result = await fetcher.fetch("https://example.com/file.pdf");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("non-HTML");
  });
});
