/**
 * Public page fetching for the Ingestion Engine (PRD §8.1):
 *   - "Respect access controls, robots/policies, rate limits, and pages that
 *     are actually reachable without credentials."
 *
 * Both robots.txt compliance and rate limiting are real, not hand-waved:
 * this module refuses to fetch a path disallowed by robots.txt, and it
 * enforces a minimum delay between requests to the same host regardless of
 * how many pages the caller asks for.
 */
import robotsParserImport from "robots-parser";

/**
 * robots-parser@3.0.1 ships a broken index.d.ts (it contains both a
 * shorthand ambient `declare module 'robots-parser';` and a proper default
 * export declaration in the same file), which makes TS treat the import as
 * uncallable. Rather than suppress the type error, declare the real shape
 * we depend on locally and cast once, here, at the single call site.
 */
interface RobotsTxt {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
const robotsParser = robotsParserImport as unknown as (url: string, robotstxt: string) => RobotsTxt;

export const USER_AGENT = "GauntletIngestionBot/0.1 (+https://gauntlet.dev/bot)";

export interface HttpClient {
  get(url: string, timeoutMs: number): Promise<HttpResponse>;
}

export interface HttpResponse {
  status: number;
  body: string;
  contentType: string | null;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const nodeClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const nodeHttpClient: HttpClient = {
  async get(url: string, timeoutMs: number): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      const body = await res.text();
      return {
        status: res.status,
        body,
        contentType: res.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Per-host minimum delay enforced between requests, in milliseconds. */
export const DEFAULT_RATE_LIMIT_MS = 500;

export class RateLimiter {
  private readonly lastRequestAtByHost = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number = DEFAULT_RATE_LIMIT_MS,
    private readonly clock: Clock = nodeClock,
  ) {}

  async waitForTurn(host: string): Promise<void> {
    const last = this.lastRequestAtByHost.get(host);
    const now = this.clock.now();
    if (last !== undefined) {
      const elapsed = now - last;
      const remaining = this.minDelayMs - elapsed;
      if (remaining > 0) {
        await this.clock.sleep(remaining);
      }
    }
    this.lastRequestAtByHost.set(host, this.clock.now());
  }
}

export interface RobotsDecision {
  allowed: boolean;
  reason?: string;
}

export class RobotsChecker {
  private readonly cache = new Map<string, RobotsTxt | null>();

  constructor(
    private readonly httpClient: HttpClient,
    private readonly timeoutMs: number = 10_000,
  ) {}

  async isAllowed(url: string): Promise<RobotsDecision> {
    const origin = new URL(url).origin;
    let robots = this.cache.get(origin);
    if (robots === undefined) {
      robots = await this.loadRobots(origin);
      this.cache.set(origin, robots);
    }
    if (robots === null) {
      // No robots.txt (or it failed to load): default-allow, per common
      // crawler convention -- absence of a policy is not a denial.
      return { allowed: true };
    }
    const allowed = robots.isAllowed(url, USER_AGENT);
    if (allowed === false) {
      return { allowed: false, reason: "disallowed by robots.txt" };
    }
    return { allowed: true };
  }

  private async loadRobots(origin: string): Promise<RobotsTxt | null> {
    try {
      const robotsUrl = `${origin}/robots.txt`;
      const res = await this.httpClient.get(robotsUrl, this.timeoutMs);
      if (res.status >= 400) {
        return null;
      }
      return robotsParser(robotsUrl, res.body);
    } catch {
      return null;
    }
  }
}

export interface FetchResult {
  url: string;
  ok: boolean;
  status?: number;
  html?: string;
  reason?: string;
}

export class PageFetcher {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly robots: RobotsChecker,
    private readonly rateLimiter: RateLimiter,
    private readonly timeoutMs: number = 10_000,
  ) {}

  async fetch(url: string): Promise<FetchResult> {
    const decision = await this.robots.isAllowed(url);
    if (!decision.allowed) {
      return { url, ok: false, reason: decision.reason ?? "disallowed by robots.txt" };
    }

    const host = new URL(url).host;
    await this.rateLimiter.waitForTurn(host);

    try {
      const res = await this.httpClient.get(url, this.timeoutMs);
      if (res.status >= 400) {
        return { url, ok: false, status: res.status, reason: `HTTP ${res.status}` };
      }
      const contentType = res.contentType ?? "";
      if (!contentType.includes("text/html") && contentType !== "") {
        return { url, ok: false, reason: `non-HTML content-type: ${contentType}` };
      }
      return { url, ok: true, status: res.status, html: res.body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { url, ok: false, reason: `fetch failed: ${message}` };
    }
  }
}
