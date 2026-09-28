import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCAN_LIMITS,
  QUOTA_WINDOW_SECONDS,
  RateLimitConfigError,
  UNKNOWN_CLIENT,
  describeWait,
  evaluateScanQuota,
  hashClientIp,
  readIpHashSecret,
  readScanLimits,
  type QuotaUsage,
} from "@/lib/rate-limit";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const LIMITS = { perClient: 3, global: 20 };
const HOUR = 60 * 60 * 1000;

function usage(count: number, slotFreesFromCreatedAt: Date | null = null): QuotaUsage {
  return { count, slotFreesFromCreatedAt };
}

describe("readScanLimits", () => {
  it("defaults to the restrictive early-access numbers (3 per client, 20 global)", () => {
    expect(readScanLimits({})).toEqual({ perClient: 3, global: 20 });
    expect(DEFAULT_SCAN_LIMITS).toEqual({ perClient: 3, global: 20 });
  });

  it("accepts positive integer overrides", () => {
    expect(
      readScanLimits({ SCAN_LIMIT_PER_CLIENT_PER_DAY: "5", SCAN_LIMIT_GLOBAL_PER_DAY: " 50 " }),
    ).toEqual({ perClient: 5, global: 50 });
  });

  it.each(["0", "-1", "2.5", "abc", "1e3x"])("rejects %s instead of silently disabling the limit", (bad) => {
    expect(() => readScanLimits({ SCAN_LIMIT_PER_CLIENT_PER_DAY: bad })).toThrow(RateLimitConfigError);
  });
});

describe("readIpHashSecret", () => {
  it("fails closed when missing or too short", () => {
    expect(() => readIpHashSecret({})).toThrow(RateLimitConfigError);
    expect(() => readIpHashSecret({ SCAN_IP_HASH_SECRET: "short" })).toThrow(RateLimitConfigError);
  });

  it("returns a long enough secret", () => {
    expect(readIpHashSecret({ SCAN_IP_HASH_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
  });
});

describe("hashClientIp", () => {
  const secret = "s".repeat(32);

  it("never returns the raw IP and is stable for the same IP", () => {
    const a = hashClientIp("203.0.113.7", secret);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.7");
    expect(hashClientIp("203.0.113.7", secret)).toBe(a);
  });

  it("depends on the secret (keyed, not a plain brute-forceable hash)", () => {
    expect(hashClientIp("203.0.113.7", secret)).not.toBe(hashClientIp("203.0.113.7", "t".repeat(32)));
  });

  it("puts every request without an IP into one shared bucket", () => {
    expect(hashClientIp(undefined, secret)).toBe(hashClientIp("", secret));
    expect(hashClientIp(undefined, secret)).toBe(hashClientIp(UNKNOWN_CLIENT, secret));
  });
});

describe("evaluateScanQuota", () => {
  it("allows a scan under both limits", () => {
    expect(evaluateScanQuota({ client: usage(2), global: usage(19), limits: LIMITS, now: NOW })).toEqual({
      allowed: true,
    });
  });

  it("denies the 4th scan from one client and says when a slot frees up", () => {
    // The 3rd most recent scan was 20h ago -> it leaves the 24h window in 4h.
    const decision = evaluateScanQuota({
      client: usage(3, new Date(NOW.getTime() - 20 * HOUR)),
      global: usage(5),
      limits: LIMITS,
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, scope: "client", retryAfterSeconds: 4 * 3600 });
    if (!decision.allowed) expect(decision.message).toContain("about 4 hours");
  });

  it("reports global capacity first when both limits are hit", () => {
    const decision = evaluateScanQuota({
      client: usage(3, new Date(NOW.getTime() - 1 * HOUR)),
      global: usage(20, new Date(NOW.getTime() - 23 * HOUR)),
      limits: LIMITS,
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, scope: "global", retryAfterSeconds: 3600 });
  });

  it("still denies when usage exceeds a limit that was lowered", () => {
    const decision = evaluateScanQuota({
      client: usage(1),
      global: usage(30, new Date(NOW.getTime() - 2 * HOUR)),
      limits: LIMITS,
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, scope: "global", retryAfterSeconds: 22 * 3600 });
  });

  it("never returns a zero or negative Retry-After", () => {
    const decision = evaluateScanQuota({
      client: usage(3, new Date(NOW.getTime() - QUOTA_WINDOW_SECONDS * 1000 - 5000)),
      global: usage(0),
      limits: LIMITS,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterSeconds).toBe(1);
  });
});

describe("describeWait", () => {
  it("uses minutes under an hour and hours otherwise, rounding up", () => {
    expect(describeWait(1)).toBe("about 1 minute");
    expect(describeWait(125)).toBe("about 3 minutes");
    expect(describeWait(3600)).toBe("about 1 hour");
    expect(describeWait(3601)).toBe("about 2 hours");
  });
});
