import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  IP_HASH_HOURS,
  isAuthorizedCronRequest,
  readRetentionPolicy,
  RetentionConfigError,
} from "@/lib/retention";

describe("readRetentionPolicy", () => {
  it("defaults to 180 days and 48 h for IP hashes", () => {
    expect(readRetentionPolicy({})).toEqual({ retentionDays: DEFAULT_RETENTION_DAYS, ipHashHours: IP_HASH_HOURS });
    expect(readRetentionPolicy({ SCAN_RETENTION_DAYS: " " }).retentionDays).toBe(180);
  });

  it("accepts a whole number of at least 30 days", () => {
    expect(readRetentionPolicy({ SCAN_RETENTION_DAYS: "90" }).retentionDays).toBe(90);
  });

  it.each(["7", "0", "-5", "45.5", "ninety"])("refuses %s instead of purging with a surprising value", (value) => {
    expect(() => readRetentionPolicy({ SCAN_RETENTION_DAYS: value })).toThrow(RetentionConfigError);
  });
});

describe("isAuthorizedCronRequest", () => {
  const secret = "s3cret-value-for-cron-1234";

  it("accepts exactly the bearer secret", () => {
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("refuses wrong, missing or prefix-only credentials", () => {
    expect(isAuthorizedCronRequest(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedCronRequest(secret, secret)).toBe(false);
    expect(isAuthorizedCronRequest(null, secret)).toBe(false);
  });

  it("fails closed when no usable secret is configured", () => {
    expect(isAuthorizedCronRequest("Bearer ", undefined)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer short", "short")).toBe(false);
  });
});
