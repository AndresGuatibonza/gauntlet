// @vitest-environment node
import { describe, it, expect } from "vitest";
import { canonicalProductUrl, claimTokenMatches, hashClaimToken, newClaimToken } from "@/lib/accounts";
import { readAuthConfig, safeNextPath } from "@/lib/auth/config";

describe("claim tokens", () => {
  it("are random, URL-safe, and only their hash is kept", () => {
    const a = newClaimToken();
    const b = newClaimToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(hashClaimToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });

  it("match only the original token", () => {
    const { token, hash } = newClaimToken();
    expect(claimTokenMatches(token, hash)).toBe(true);
    expect(claimTokenMatches(newClaimToken().token, hash)).toBe(false);
    expect(claimTokenMatches(token, null)).toBe(false);
    expect(claimTokenMatches("short", hash)).toBe(false);
    expect(claimTokenMatches(`${token}'; drop table`, hash)).toBe(false);
  });
});

describe("canonicalProductUrl", () => {
  it("reduces a URL to its lower-case origin", () => {
    expect(canonicalProductUrl("https://www.Intercom.com/pricing?x=1")).toBe("https://www.intercom.com");
    expect(canonicalProductUrl("https://app.example.com:8443/a")).toBe("https://app.example.com:8443");
  });
});

describe("readAuthConfig", () => {
  it("is off unless both public values are set", () => {
    expect(readAuthConfig({})).toBeNull();
    expect(readAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toBeNull();
    expect(readAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_1" })).toEqual({
      url: "https://x.supabase.co",
      publishableKey: "sb_publishable_1",
    });
  });

  it("accepts the legacy anon key name", () => {
    expect(readAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJ" })?.publishableKey).toBe("eyJ");
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/scans/abc?card=1")).toBe("/scans/abc?card=1");
    expect(safeNextPath("/ledger")).toBe("/ledger");
  });

  it.each(["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, undefined, "ledger"])(
    "refuses %s as a redirect target",
    (next) => {
      expect(safeNextPath(next as string | null | undefined)).toBe("/");
    },
  );
});
