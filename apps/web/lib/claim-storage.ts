"use client";

/**
 * Where the browser keeps a scan's claim token (lib/accounts.ts) until the
 * visitor signs in and saves the scan. Per-browser convenience by design:
 * storage can be unavailable (private mode, blocked site data), so every
 * access is guarded and "no token" simply means "can't claim from here".
 */
const key = (scanId: string) => `gauntlet:claim:${scanId}`;

export function storeClaimToken(scanId: string, token: string): void {
  try {
    window.localStorage.setItem(key(scanId), token);
  } catch {
    // Storage unavailable: the scan still works, it just can't be claimed later from this browser.
  }
}

export function readClaimToken(scanId: string): string | null {
  try {
    return window.localStorage.getItem(key(scanId));
  } catch {
    return null;
  }
}

export function forgetClaimToken(scanId: string): void {
  try {
    window.localStorage.removeItem(key(scanId));
  } catch {
    // Nothing to clean up.
  }
}
