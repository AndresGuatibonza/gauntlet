"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAuthConfig } from "./config";

/**
 * Browser client for starting OAuth. NEXT_PUBLIC_* values are inlined at
 * build time, so they are read explicitly here rather than via process.env[key].
 */
export function createSupabaseBrowserClient(): SupabaseClient | null {
  const config = readAuthConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return config ? createBrowserClient(config.url, config.publishableKey) : null;
}
