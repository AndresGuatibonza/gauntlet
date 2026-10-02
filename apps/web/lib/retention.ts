/**
 * Retention settings and the maintenance endpoint's authorization.
 *
 * Policy (decided 2026-10-02 to close PRD §18's "data-retention policy for
 * anonymous scans"):
 *   - client IP hashes on scan_jobs: cleared after 48 h (the quota window is
 *     24 h; nothing else reads them);
 *   - whole anonymous scans and their events: deleted after 180 days by
 *     default (SCAN_RETENTION_DAYS, at least 30 so a validation round's
 *     data can't be purged mid-round by a typo).
 */
import { timingSafeEqual } from "node:crypto";
import type { RetentionPolicy } from "./store";

export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 30;
export const IP_HASH_HOURS = 48;

export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

export function readRetentionPolicy(env: Record<string, string | undefined> = process.env): RetentionPolicy {
  const raw = env["SCAN_RETENTION_DAYS"];
  if (raw === undefined || raw.trim() === "") return { retentionDays: DEFAULT_RETENTION_DAYS, ipHashHours: IP_HASH_HOURS };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new RetentionConfigError(`SCAN_RETENTION_DAYS must be a whole number of days, at least ${MIN_RETENTION_DAYS}; got "${raw}".`);
  }
  return { retentionDays: days, ipHashHours: IP_HASH_HOURS };
}

/**
 * Vercel Cron calls the endpoint with `Authorization: Bearer <CRON_SECRET>`
 * when CRON_SECRET is set on the project. Fails closed: with no secret
 * configured, nobody is authorized.
 */
export function isAuthorizedCronRequest(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
