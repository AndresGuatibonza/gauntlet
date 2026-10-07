/**
 * Scan quota for the public, unauthenticated POST /api/scans endpoint.
 *
 * Why this exists: every scan crawls up to 8 pages of a third-party site
 * and makes at least two Claude API calls billed to our key. Without a
 * limit, anyone who finds the URL can run that in a loop. PRD v2 §18 lists
 * this as an open question; this is the minimal, no-new-infrastructure
 * answer (counts come straight from scan_jobs -- see
 * migrations/002_scan_rate_limit.sql and store.ts).
 *
 * Default numbers (chosen deliberately restrictive, 2026-09-28): the current stage is the Concierge Validation Plan -- 10-20
 * design partners in total (contract doc §4) -- so no legitimate visitor
 * needs more than a handful of scans a day, and the whole product doesn't
 * need more than ~20. Both are overridable per environment:
 *   SCAN_LIMIT_PER_CLIENT_PER_DAY  (default 3)
 *   SCAN_LIMIT_GLOBAL_PER_DAY      (default 20)
 *
 * Every scan attempt counts, including ones that later fail: a failed
 * scan still crawled the target site, and some failures (Scientist
 * errors) still spent Claude calls.
 *
 * The client is identified by IP. On Vercel, x-real-ip / x-forwarded-for
 * are overwritten by Vercel's edge "to prevent IP spoofing" (Vercel docs,
 * Request headers, checked 2026-09-28), so they can be trusted there. The
 * IP is never stored raw -- only an HMAC-SHA256 keyed with
 * SCAN_IP_HASH_SECRET (an unkeyed hash of an IPv4 address is trivially
 * brute-forced).
 */
import { createHmac } from "node:crypto";

/** Rolling quota window. */
export const QUOTA_WINDOW_SECONDS = 24 * 60 * 60;

export const DEFAULT_SCAN_LIMITS = { perClient: 3, perAccount: 5, global: 20 } as const;

/** One quota as applied to one request: the requester's own allowance and the product-wide cap. */
export interface ScanLimits {
  perClient: number;
  global: number;
}

/**
 * A quota's configured allowances. Signed-in visitors are counted per
 * account (perAccount), anonymous ones per client IP (perClient); the
 * global cap covers both and is the real cost ceiling.
 */
export interface QuotaLimits extends ScanLimits {
  perAccount: number;
}

/** Misconfiguration of the quota's own env vars -- a server problem, not the visitor's. */
export class RateLimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitConfigError";
  }
}

type Env = Record<string, string | undefined>;

function parseLimit(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new RateLimitConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

export function readScanLimits(env: Env = process.env): QuotaLimits {
  return {
    perClient: parseLimit(env, "SCAN_LIMIT_PER_CLIENT_PER_DAY", DEFAULT_SCAN_LIMITS.perClient),
    perAccount: parseLimit(env, "SCAN_LIMIT_PER_ACCOUNT_PER_DAY", DEFAULT_SCAN_LIMITS.perAccount),
    global: parseLimit(env, "SCAN_LIMIT_GLOBAL_PER_DAY", DEFAULT_SCAN_LIMITS.global),
  };
}

/**
 * "Build this" implementation packages: one Claude call each, so they get
 * their own, separate daily allowance (PACKAGE_LIMIT_*).
 */
export const DEFAULT_PACKAGE_LIMITS = { perClient: 5, perAccount: 10, global: 40 } as const;

export function readPackageLimits(env: Env = process.env): QuotaLimits {
  return {
    perClient: parseLimit(env, "PACKAGE_LIMIT_PER_CLIENT_PER_DAY", DEFAULT_PACKAGE_LIMITS.perClient),
    perAccount: parseLimit(env, "PACKAGE_LIMIT_PER_ACCOUNT_PER_DAY", DEFAULT_PACKAGE_LIMITS.perAccount),
    global: parseLimit(env, "PACKAGE_LIMIT_GLOBAL_PER_DAY", DEFAULT_PACKAGE_LIMITS.global),
  };
}

/**
 * Who a scan or brief counts against (stored as quota_subject, migration
 * 010): the signed-in account when there is one, so people behind a
 * shared or rotating IP each get their own allowance; otherwise the
 * client's IP hash. Both are opaque: an account id or an HMAC, never an IP.
 */
export type QuotaSubject = { kind: "account"; key: string } | { kind: "client"; key: string };

export function quotaSubject(userId: string | null | undefined, clientIpHash: string): QuotaSubject {
  return userId ? { kind: "account", key: `user:${userId}` } : { kind: "client", key: `ip:${clientIpHash}` };
}

/** The allowance that applies to this subject, plus the global cap. */
export function limitsFor(subject: QuotaSubject, limits: QuotaLimits): ScanLimits {
  return { perClient: subject.kind === "account" ? limits.perAccount : limits.perClient, global: limits.global };
}

/**
 * Repo-aware briefs (GitHub deep scan): two or three Claude calls and a
 * repository read each, only for signed-in owners of a saved report, so
 * the allowance is per account (REPO_BRIEF_LIMIT_*).
 */
export const DEFAULT_REPO_BRIEF_LIMITS = { perClient: 10, global: 60 } as const;

export function readRepoBriefLimits(env: Env = process.env): ScanLimits {
  return {
    perClient: parseLimit(env, "REPO_BRIEF_LIMIT_PER_USER_PER_DAY", DEFAULT_REPO_BRIEF_LIMITS.perClient),
    global: parseLimit(env, "REPO_BRIEF_LIMIT_GLOBAL_PER_DAY", DEFAULT_REPO_BRIEF_LIMITS.global),
  };
}

/** Minimum secret length; anything shorter is almost certainly a placeholder. */
const MIN_SECRET_LENGTH = 16;

/**
 * Fails closed: without the secret there is no safe way to identify
 * clients, and silently skipping the quota would reopen exactly the hole
 * this module closes.
 */
export function readIpHashSecret(env: Env = process.env): string {
  const secret = env["SCAN_IP_HASH_SECRET"];
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new RateLimitConfigError(
      `SCAN_IP_HASH_SECRET is not set or shorter than ${MIN_SECRET_LENGTH} characters. ` +
        "Set it to a long random string (see apps/web/.env.example).",
    );
  }
  return secret;
}

/**
 * Bucket used when no client IP is available (local `next dev`, which has
 * no Vercel edge in front of it). All such requests share ONE quota --
 * restrictive on purpose rather than unlimited.
 */
export const UNKNOWN_CLIENT = "unknown-client";

export function hashClientIp(ip: string | undefined, secret: string): string {
  const key = ip?.trim() || UNKNOWN_CLIENT;
  return createHmac("sha256", secret).update(key).digest("hex");
}

/**
 * Usage of one quota scope inside the current window, as read from the DB:
 * how many scans it has, and the created_at of the scan whose expiry would
 * free a slot (the `limit`-th most recent one) -- null if fewer than
 * `limit` scans exist in the window.
 */
export interface QuotaUsage {
  count: number;
  slotFreesFromCreatedAt: Date | null;
}

export type QuotaDenial = {
  allowed: false;
  scope: "client" | "global";
  retryAfterSeconds: number;
  message: string;
};

export type QuotaDecision = { allowed: true } | QuotaDenial;

function secondsUntilSlotFrees(usage: QuotaUsage, now: Date): number {
  if (!usage.slotFreesFromCreatedAt) return QUOTA_WINDOW_SECONDS;
  const freesAtMs = usage.slotFreesFromCreatedAt.getTime() + QUOTA_WINDOW_SECONDS * 1000;
  return Math.max(1, Math.ceil((freesAtMs - now.getTime()) / 1000));
}

export function describeWait(seconds: number): string {
  if (seconds < 60 * 60) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Global capacity is checked first: if the whole product is at capacity,
 * telling a visitor about their own per-client allowance would be
 * misleading -- they couldn't scan even with allowance left.
 */
export function evaluateScanQuota(input: {
  client: QuotaUsage;
  global: QuotaUsage;
  limits: ScanLimits;
  now: Date;
  /** What is being limited, for the messages. Default "scan". */
  noun?: string;
}): QuotaDecision {
  const { client, global, limits, now } = input;
  const noun = input.noun ?? "scan";

  if (global.count >= limits.global) {
    const retryAfterSeconds = secondsUntilSlotFrees(global, now);
    return {
      allowed: false,
      scope: "global",
      retryAfterSeconds,
      message:
        `Gauntlet has reached its daily ${noun} capacity (${limits.global} ${noun}s per 24 hours) while in early access. ` +
        `Please try again in ${describeWait(retryAfterSeconds)}.`,
    };
  }

  if (client.count >= limits.perClient) {
    const retryAfterSeconds = secondsUntilSlotFrees(client, now);
    return {
      allowed: false,
      scope: "client",
      retryAfterSeconds,
      message:
        `You've reached the ${noun} limit for now (${limits.perClient} ${noun}s per 24 hours) while Gauntlet is in early access. ` +
        `Please try again in ${describeWait(retryAfterSeconds)}.`,
    };
  }

  return { allowed: true };
}

/**
 * An anonymous visitor who used up their own allowance is told that
 * signing in raises it -- only when accounts exist and the global cap is
 * not the reason.
 */
export function withSignInHint(
  denial: { scope: "client" | "global"; message: string },
  subjectKind: QuotaSubject["kind"],
  accountsEnabled: boolean,
): string {
  if (denial.scope !== "client" || subjectKind !== "client" || !accountsEnabled) return denial.message;
  return `${denial.message} Signing in with GitHub raises your daily limit.`;
}
