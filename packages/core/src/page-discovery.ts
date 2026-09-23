/**
 * Bounded page discovery for the Ingestion Engine (PRD §8.1):
 *   "Discover a bounded set of relevant pages (homepage, product pages,
 *   pricing, docs/help pages when publicly linked)."
 *
 * The bound is explicit and disclosed (DEFAULT_MAX_PAGES), never a silent
 * cap the caller can't see or reason about.
 */
import * as cheerio from "cheerio";
import type { PageFetcher, FetchResult } from "./fetcher.js";
import type { UnreachablePage } from "./evidence-packet.js";

/** Total pages fetched per scan, homepage included. Explicit, not hidden. */
export const DEFAULT_MAX_PAGES = 8;

/**
 * Path/link-text keywords used to decide which discovered links are worth
 * following. This is a relevance filter, not a guarantee of coverage --
 * pages that don't match any keyword are simply not visited in v0.
 */
export const RELEVANT_KEYWORDS = [
  "pricing",
  "plans",
  "price",
  "docs",
  "documentation",
  "help",
  "faq",
  "support",
  "product",
  "features",
  "about",
];

export interface DiscoveryResult {
  fetched: FetchResult[];
  notReachable: UnreachablePage[];
}

function isRelevant(url: string, linkText: string): boolean {
  const haystack = `${url} ${linkText}`.toLowerCase();
  return RELEVANT_KEYWORDS.some((kw) => haystack.includes(kw));
}

function extractSameOriginLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const links: Array<{ url: string; text: string }> = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return;
    }
    resolved.hash = "";
    if (resolved.origin !== origin) return;
    const normalized = resolved.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    links.push({ url: normalized, text: $(el).text().trim() });
  });

  return links;
}

export async function discoverAndFetchPages(
  homepageUrl: string,
  fetcher: PageFetcher,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<DiscoveryResult> {
  const fetched: FetchResult[] = [];
  const notReachable: UnreachablePage[] = [];

  const homepageResult = await fetcher.fetch(homepageUrl);
  fetched.push(homepageResult);
  if (!homepageResult.ok) {
    notReachable.push({ url: homepageUrl, reason: homepageResult.reason ?? "unknown fetch failure" });
    // Can't discover further links without the homepage.
    return { fetched, notReachable };
  }

  const links = extractSameOriginLinks(homepageResult.html ?? "", homepageUrl);
  const candidates = links.filter((l) => isRelevant(l.url, l.text));

  const remainingBudget = Math.max(0, maxPages - 1);
  const toVisit = candidates.slice(0, remainingBudget);

  for (const candidate of toVisit) {
    const result = await fetcher.fetch(candidate.url);
    fetched.push(result);
    if (!result.ok) {
      notReachable.push({ url: candidate.url, reason: result.reason ?? "unknown fetch failure" });
    }
  }

  return { fetched, notReachable };
}
