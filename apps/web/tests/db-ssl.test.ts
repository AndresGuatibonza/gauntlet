// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { sslFor } from "@/lib/db";

afterEach(() => vi.unstubAllEnvs());

describe("sslFor", () => {
  it("always verifies TLS by default, including the Supabase CA", () => {
    const ssl = sslFor("postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres");
    expect(ssl && ssl.rejectUnauthorized).toBe(true);
  });

  it("allows DATABASE_SSL=disable only for a local database", () => {
    vi.stubEnv("DATABASE_SSL", "disable");
    expect(sslFor("postgresql://postgres@localhost:5432/postgres")).toBe(false);
    expect(sslFor("postgresql://postgres@127.0.0.1:5432/postgres")).toBe(false);
    expect(() => sslFor("postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres")).toThrow(/only allowed for a local database/);
  });
});
