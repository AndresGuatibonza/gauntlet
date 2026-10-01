import { describe, it, expect } from "vitest";
import { discoverAndFetchPages } from "../src/page-discovery.js";
import type { PageFetcher, FetchResult } from "../src/fetcher.js";

function fakeFetcher(pages: Record<string, FetchResult>): PageFetcher {
  return {
    async fetch(url: string): Promise<FetchResult> {
      return pages[url] ?? { url, ok: false, reason: "not configured in fake" };
    },
  } as PageFetcher;
}

const HOMEPAGE_HTML = `
<html><body>
  <nav>
    <a href="/pricing">Pricing</a>
    <a href="/docs">Docs</a>
    <a href="/about">About</a>
    <a href="/random-page">Random</a>
    <a href="https://other-domain.com/pricing">External pricing (different origin)</a>
  </nav>
</body></html>
`;

describe("discoverAndFetchPages", () => {
  it("records the homepage as not reachable and stops when the homepage itself fails", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/": { url: "https://example.com/", ok: false, reason: "HTTP 403" },
    });
    const result = await discoverAndFetchPages("https://example.com/", fetcher);
    expect(result.notReachable).toEqual([{ url: "https://example.com/", reason: "HTTP 403" }]);
    expect(result.fetched).toHaveLength(1);
  });

  it("follows only same-origin, keyword-relevant links, up to the page budget", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/": { url: "https://example.com/", ok: true, html: HOMEPAGE_HTML, status: 200 },
      "https://example.com/pricing": { url: "https://example.com/pricing", ok: true, html: "<html></html>", status: 200 },
      "https://example.com/docs": { url: "https://example.com/docs", ok: true, html: "<html></html>", status: 200 },
      "https://example.com/about": { url: "https://example.com/about", ok: true, html: "<html></html>", status: 200 },
    });
    const result = await discoverAndFetchPages("https://example.com/", fetcher, 8);
    const fetchedUrls = result.fetched.map((f) => f.url);
    expect(fetchedUrls).toContain("https://example.com/");
    expect(fetchedUrls).toContain("https://example.com/pricing");
    expect(fetchedUrls).toContain("https://example.com/docs");
    expect(fetchedUrls).toContain("https://example.com/about");
    // Not relevant to any keyword, and a different origin -- neither followed.
    expect(fetchedUrls).not.toContain("https://example.com/random-page");
    expect(fetchedUrls).not.toContain("https://other-domain.com/pricing");
  });

  it("respects the explicit max-pages bound", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/": { url: "https://example.com/", ok: true, html: HOMEPAGE_HTML, status: 200 },
      "https://example.com/pricing": { url: "https://example.com/pricing", ok: true, html: "<html></html>", status: 200 },
      "https://example.com/docs": { url: "https://example.com/docs", ok: true, html: "<html></html>", status: 200 },
      "https://example.com/about": { url: "https://example.com/about", ok: true, html: "<html></html>", status: 200 },
    });
    // Budget of 2 means homepage + only 1 more page.
    const result = await discoverAndFetchPages("https://example.com/", fetcher, 2);
    expect(result.fetched).toHaveLength(2);
  });

  it("records candidate pages that fail to fetch as not reachable", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/": { url: "https://example.com/", ok: true, html: HOMEPAGE_HTML, status: 200 },
      "https://example.com/pricing": { url: "https://example.com/pricing", ok: false, reason: "HTTP 500" },
      "https://example.com/docs": { url: "https://example.com/docs", ok: true, html: "<html></html>", status: 200 },
      "https://example.com/about": { url: "https://example.com/about", ok: true, html: "<html></html>", status: 200 },
    });
    const result = await discoverAndFetchPages("https://example.com/", fetcher, 8);
    expect(result.notReachable).toEqual([{ url: "https://example.com/pricing", reason: "HTTP 500" }]);
  });
});

describe("discoverAndFetchPages progress", () => {
  const pages: Record<string, FetchResult> = {
    "https://example.com/": { url: "https://example.com/", ok: true, html: HOMEPAGE_HTML, status: 200 },
    "https://example.com/pricing": { url: "https://example.com/pricing", ok: true, html: "<html></html>", status: 200 },
    "https://example.com/docs": { url: "https://example.com/docs", ok: true, html: "<html></html>", status: 200 },
    "https://example.com/about": { url: "https://example.com/about", ok: true, html: "<html></html>", status: 200 },
  };

  it("reports each page right before it is fetched, in order, with a 1-based index and the planned total", async () => {
    const events: unknown[] = [];
    await discoverAndFetchPages("https://example.com/", fakeFetcher(pages), 3, (p) => events.push(p));
    expect(events).toEqual([
      { kind: "homepage", url: "https://example.com/" },
      { kind: "page", url: "https://example.com/pricing", index: 2, total: 3 },
      { kind: "page", url: "https://example.com/docs", index: 3, total: 3 },
    ]);
  });

  it("keeps scanning when the listener throws", async () => {
    const result = await discoverAndFetchPages("https://example.com/", fakeFetcher(pages), 8, () => {
      throw new Error("display failed");
    });
    expect(result.fetched.map((f) => f.url)).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/docs",
      "https://example.com/about",
    ]);
  });
});
