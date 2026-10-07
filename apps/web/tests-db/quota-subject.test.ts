import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { runMigrations } from "@/lib/migrate";
import { connect, createTestDatabase } from "./helpers";

let db: { url: string; drop: () => Promise<void> };
let sql: Client;
let store: typeof import("@/lib/store");
let dbModule: typeof import("@/lib/db");

const IP = "a".repeat(64);
const SCAN_LIMITS = { perClient: 2, global: 40 };

beforeAll(async () => {
  db = await createTestDatabase();
  sql = await connect(db.url);
  await runMigrations(sql);
  process.env["DATABASE_URL"] = db.url;
  store = await import("@/lib/store");
  dbModule = await import("@/lib/db");
});

afterAll(async () => {
  await dbModule.getPool().end();
  await sql.end();
  await db.drop();
});

async function scan(subject: string): Promise<boolean> {
  const r = await store.createScanJobWithinQuota("https://a.com/", "ai_saas", IP, SCAN_LIMITS, null, subject);
  return r.ok;
}

describe("quota subjects", () => {
  it("gives each account behind one shared IP its own allowance, apart from anonymous use of that IP", async () => {
    expect([await scan("user:alice"), await scan("user:alice"), await scan("user:alice")]).toEqual([true, true, false]);
    expect([await scan("user:bob"), await scan("user:bob")]).toEqual([true, true]);
    expect([await scan(`ip:${IP}`), await scan(`ip:${IP}`), await scan(`ip:${IP}`)]).toEqual([true, true, false]);
    const stored = await sql.query(`select quota_subject, client_ip_hash from scan_jobs where quota_subject = 'user:bob'`);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0].client_ip_hash).toBe(IP); // still kept for event dedupe until the 48 h purge
  });

  it("defaults to the client IP when no subject is given, and the global cap still binds everyone", async () => {
    await sql.query("delete from scan_jobs");
    expect((await store.createScanJobWithinQuota("https://a.com/", "ai_saas", IP, SCAN_LIMITS)).ok).toBe(true);
    expect((await sql.query(`select quota_subject from scan_jobs`)).rows[0].quota_subject).toBe(`ip:${IP}`);
    const tight = { perClient: 10, global: 2 };
    expect((await store.createScanJobWithinQuota("https://a.com/", "ai_saas", IP, tight, null, "user:carol")).ok).toBe(true);
    const denied = await store.createScanJobWithinQuota("https://a.com/", "ai_saas", IP, tight, null, "user:dave");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denial.scope).toBe("global");
  });

  it("counts briefs per account too", async () => {
    const id = (await sql.query(`insert into scan_jobs (url, category, status) values ('https://a.com/', 'ai_saas', 'done') returning id`)).rows[0].id;
    const limits = { perClient: 1, global: 40 };
    expect((await store.claimActionPackage(id, 0, IP, limits, "user:erin")).outcome).toBe("start");
    expect((await store.claimActionPackage(id, 1, IP, limits, "user:erin")).outcome).toBe("denied");
    expect((await store.claimActionPackage(id, 1, IP, limits, "user:frank")).outcome).toBe("start");
    const rows = await sql.query(`select quota_subject from action_packages where scan_job_id = $1 order by card_index`, [id]);
    expect(rows.rows.map((r) => r.quota_subject)).toEqual(["user:erin", "user:frank"]);
  });

  it("clears quota subjects with the IP hashes after 48 hours", async () => {
    await sql.query(`update scan_jobs set created_at = now() - interval '3 days'`);
    await sql.query(`update action_packages set created_at = now() - interval '3 days'`);
    await store.purgeExpiredData({ retentionDays: 180, ipHashHours: 48 });
    expect((await sql.query(`select count(*)::int as n from scan_jobs where quota_subject is not null or client_ip_hash is not null`)).rows[0].n).toBe(0);
    expect((await sql.query(`select count(*)::int as n from action_packages where quota_subject is not null`)).rows[0].n).toBe(0);
  });

  it("backfills rows created before migration 010 from their IP hash, and rejects malformed subjects", async () => {
    const id = (await sql.query(`insert into scan_jobs (url, category, status, client_ip_hash) values ('https://a.com/', 'ai_saas', 'queued', $1) returning id`, [IP])).rows[0].id;
    expect((await sql.query(`select quota_subject from scan_jobs where id = $1`, [id])).rows[0].quota_subject).toBeNull();
    await sql.query(readFileSync(join(process.cwd(), "lib/migrations/010_quota_subject.sql"), "utf8")); // idempotent re-run
    expect((await sql.query(`select quota_subject from scan_jobs where id = $1`, [id])).rows[0].quota_subject).toBe(`ip:${IP}`);
    await expect(sql.query(`update scan_jobs set quota_subject = 'someone' where id = $1`, [id])).rejects.toThrow(/quota_subject_shape/);
  });
});
