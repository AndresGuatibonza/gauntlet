/**
 * The SQL guarantees that were previously only verified by hand: the scan
 * quota under concurrency, event idempotency and constraints, and the
 * progress column. Runs the real store functions against a migrated
 * throwaway database.
 */
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
  process.env["DATABASE_URL"] = db.url; // read by getPool() on first use
  store = await import("@/lib/store");
  dbModule = await import("@/lib/db");
});

afterAll(async () => {
  await dbModule.getPool().end();
  await sql.end();
  await db.drop();
});

async function count(query: string, params: unknown[] = []): Promise<number> {
  return (await sql.query(query, params)).rows[0].n;
}

describe("createScanJobWithinQuota", () => {
  it("never lets concurrent requests exceed the per-client limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.createScanJobWithinQuota("https://a.com/", "ai_saas", "client-a", { perClient: 3, global: 100 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.denial.scope === "client")).toBe(true);
    expect(await count(`select count(*)::int as n from scan_jobs where client_ip_hash = 'client-a'`)).toBe(3);
    // Every job has exactly its scan_started event, written in the same transaction.
    expect(await count(`select count(*)::int as n from scan_events e join scan_jobs j on j.id = e.scan_job_id
                        where j.client_ip_hash = 'client-a' and e.event_type = 'scan_started'`)).toBe(3);
  });

  it("enforces the global limit across clients", async () => {
    const before = await count(`select count(*)::int as n from scan_jobs`);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.createScanJobWithinQuota("https://b.com/", "ai_tool", `client-g${i}`, { perClient: 10, global: before + 2 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, denial: { scope: "global" } });
  });
});

describe("scan events", () => {
  async function newJob(): Promise<string> {
    const r = await store.createScanJobWithinQuota("https://c.com/", "ai_saas", `c-${Math.random()}`, { perClient: 99, global: 999 });
    if (!r.ok) throw new Error("quota");
    return r.id;
  }

  it("records each event once per client, and a changed rating replaces the earlier one", async () => {
    const id = await newJob();
    await store.recordScanEvent({ scanJobId: id, type: "report_viewed", clientIpHash: "x" });
    await store.recordScanEvent({ scanJobId: id, type: "report_viewed", clientIpHash: "x" });
    await store.recordScanEvent({ scanJobId: id, type: "report_viewed", clientIpHash: "y" });
    expect(await count(`select count(*)::int as n from scan_events where scan_job_id = $1 and event_type = 'report_viewed'`, [id])).toBe(2);

    const feedback = { scanJobId: id, type: "opportunity_feedback_submitted" as const, cardIndex: 0, clientIpHash: "x" };
    await store.recordScanEvent({ ...feedback, rating: "useful" });
    await store.recordScanEvent({ ...feedback, rating: "wrong" });
    const rows = await sql.query(`select rating from scan_events where scan_job_id = $1 and event_type = 'opportunity_feedback_submitted'`, [id]);
    expect(rows.rows).toEqual([{ rating: "wrong" }]);
  });

  it("rejects malformed events at the database level", async () => {
    const id = await newJob();
    await expect(sql.query(`insert into scan_events (scan_job_id, event_type, rating) values ($1, 'report_viewed', 'useful')`, [id])).rejects.toThrow(/rating_only_on_feedback/);
    await expect(sql.query(`insert into scan_events (scan_job_id, event_type, card_index) values ($1, 'report_viewed', 0)`, [id])).rejects.toThrow(/card_only_on_card_events/);
    await expect(sql.query(`insert into scan_events (scan_job_id, event_type) values ($1, 'made_up')`, [id])).rejects.toThrow(/event_type_check/);
  });

  it("deletes a job's events with the job", async () => {
    const id = await newJob();
    await sql.query(`delete from scan_jobs where id = $1`, [id]);
    expect(await count(`select count(*)::int as n from scan_events where scan_job_id = $1`, [id])).toBe(0);
  });
});

describe("progress", () => {
  it("stores the latest progress line and returns it with the job", async () => {
    const r = await store.createScanJobWithinQuota("https://d.com/", "ai_saas", "p", { perClient: 9, global: 999 });
    if (!r.ok) throw new Error("quota");
    await store.setScanProgress(r.id, { status: "scanning", message: "Reading /pricing (3 of 8)" });
    await store.setScanProgress(r.id, { status: "analyzing", message: "Analyzing 54 pieces of evidence from 8 pages" });
    expect((await store.getScanJob(r.id))?.progress).toEqual({ status: "analyzing", message: "Analyzing 54 pieces of evidence from 8 pages" });
  });
});
