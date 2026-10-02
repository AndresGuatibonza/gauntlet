import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { runMigrations } from "@/lib/migrate";
import { connect, createTestDatabase } from "./helpers";

let db: { url: string; drop: () => Promise<void> };
let sql: Client;
let store: typeof import("@/lib/store");
let dbModule: typeof import("@/lib/db");

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

async function job(status: string, ageMinutes: number, ipHash: string | null = "h"): Promise<string> {
  const r = await sql.query(
    `insert into scan_jobs (url, category, status, client_ip_hash, created_at)
     values ('https://a.com/', 'ai_saas', $1, $2, now() - make_interval(mins => $3)) returning id`,
    [status, ipHash, ageMinutes],
  );
  return r.rows[0].id;
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await sql.query(`select status from scan_jobs where id = $1`, [id])).rows[0]?.status;
}

describe("expireStaleJobs", () => {
  it("fails in-flight jobs older than the limit, records scan_failed once, and leaves everything else alone", async () => {
    const stuck = await job("analyzing", store.STALE_JOB_MINUTES + 1);
    const running = await job("scanning", 2);
    const finished = await job("done", 60);

    expect(await store.expireStaleJobs()).toEqual([stuck]);
    expect(await statusOf(stuck)).toBe("failed");
    expect((await store.getScanJob(stuck))?.errorMessage).toBe(store.STALE_JOB_MESSAGE);
    expect(await statusOf(running)).toBe("scanning");
    expect(await statusOf(finished)).toBe("done");

    expect(await store.expireStaleJobs()).toEqual([]); // idempotent
    const events = await sql.query(`select count(*)::int as n from scan_events where scan_job_id = $1 and event_type = 'scan_failed'`, [stuck]);
    expect(events.rows[0].n).toBe(1);
  });

  it("can target a single job (the polling endpoint)", async () => {
    const a = await job("queued", 30);
    const b = await job("queued", 30);
    expect(await store.expireStaleJobs(a)).toEqual([a]);
    expect(await statusOf(b)).toBe("queued");
  });
});

describe("purgeExpiredData", () => {
  it("clears old IP hashes, deletes scans past retention with their events, and keeps recent data", async () => {
    const fresh = await job("done", 60);
    const twoDaysOld = await job("done", 60 * 49);
    const ancient = await job("done", 60 * 24 * 181);
    await sql.query(`insert into scan_events (scan_job_id, event_type) values ($1, 'report_viewed')`, [ancient]);

    const result = await store.purgeExpiredData({ retentionDays: 180, ipHashHours: 48 });
    expect(result.scansDeleted).toBeGreaterThanOrEqual(1);
    expect(await statusOf(ancient)).toBeUndefined();
    expect((await sql.query(`select count(*)::int as n from scan_events where scan_job_id = $1`, [ancient])).rows[0].n).toBe(0);
    const hashes = await sql.query(`select id, client_ip_hash from scan_jobs where id = any($1)`, [[fresh, twoDaysOld]]);
    const byId = Object.fromEntries(hashes.rows.map((r) => [r.id, r.client_ip_hash]));
    expect(byId[fresh]).toBe("h");
    expect(byId[twoDaysOld]).toBeNull();
  });
});
