/**
 * Pure helpers for accounts: the scan claim token and canonical product
 * URLs for workspaces. No I/O here, so they are unit-testable.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh claim token (returned once to the browser) and the hash stored for it. */
export function newClaimToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashClaimToken(token) };
}

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented token against the stored hash. */
export function claimTokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return false;
  const given = Buffer.from(hashClaimToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** Workspaces are one per product: "https://www.Intercom.com/pricing?x=1" -> "https://www.intercom.com". */
export function canonicalProductUrl(url: string): string {
  return new URL(url).origin.toLowerCase();
}
