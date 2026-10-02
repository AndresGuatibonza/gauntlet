import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import type { ActionPackage } from "@gauntlet/core";
import { planExperimentRecord } from "@gauntlet/core";
import { runMigrations } from "@/lib/migrate";
import { connect, createTestDatabase } from "./helpers";

let db: { url: string; drop: () => Promise<void> };
let sql: Client;
let store: typeof import("@/lib/store");
let dbModule: typeof import("@/lib/db");

const LIMITS = { perClient: 5, global: 40 };

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

async function doneScan(): Promise<string> {
  const r = await sql.query(`insert into scan_jobs (url, category, status) values ('https://a.com/', 'ai_saas', 'done') returning id`);
  return r.rows[0].id;
}

function fakePackage(): ActionPackage {
  return {
    objective: "o",
    nonGoals: ["n"],
    likelyComponents: ["the signup form"],
    approach: ["a", "b"],
    featureFlag: { name: "signup_price", rollout: "50%" },
    acceptanceCriteria: ["1", "2", "3"],
    measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "2 weeks" },
    rollbackCriteria: ["r"],
    risks: [{ risk: "x", mitigation: "y" }],
    missingContext: ["repo"],
    evidenceRefs: ["E1"],
    version: 1,
    generatedAt: "2026-10-02T15:00:00.000Z",
    product: { name: "A", url: "https://a.com/" },
    card: { title: "t", hypothesis: "h", changeSurface: "ux", missingEvidence: "me" },
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
    codeContext: "public_scan",
    citedEvidence: [{ id: "E1", observation: "obs", sourceRef: "https://a.com/" }],
  };
}

describe("claimActionPackage", () => {
  it("resolves concurrent clicks to exactly one generation", async () => {
    const scan = await doneScan();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.claimActionPackage(scan, 0, `client-${i}`, LIMITS)),
    );
    expect(results.filter((r) => r.outcome === "start")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "existing" && r.state.state === "generating")).toHaveLength(9);
    expect((await sql.query(`select count(*)::int as n from action_packages where scan_job_id = $1`, [scan])).rows[0].n).toBe(1);
  });

  it("enforces the per-client and global package quotas", async () => {
    const scan = await doneScan();
    const results = [];
    for (let card = 0; card < 7; card++) results.push(await store.claimActionPackage(scan, card, "busy-client", { perClient: 5, global: 999 }));
    expect(results.filter((r) => r.outcome === "start")).toHaveLength(5);
    const denied = results.at(-1)!;
    expect(denied).toMatchObject({ outcome: "denied", denial: { scope: "client" } });
    if (denied.outcome === "denied") expect(denied.denial.message).toContain("implementation brief limit");
  });

  it("retries a failed package up to the attempt cap, without a new quota slot", async () => {
    const scan = await doneScan();
    const first = await store.claimActionPackage(scan, 0, "retry-client", LIMITS);
    if (first.outcome !== "start") throw new Error("expected start");
    for (let attempt = 2; attempt <= store.MAX_PACKAGE_ATTEMPTS; attempt++) {
      await store.failActionPackage(first.id, "boom");
      expect(await store.claimActionPackage(scan, 0, "retry-client", LIMITS)).toEqual({ outcome: "start", id: first.id });
    }
    await store.failActionPackage(first.id, "boom");
    const final = await store.claimActionPackage(scan, 0, "retry-client", LIMITS);
    expect(final).toMatchObject({ outcome: "existing", state: { state: "failed", canRetry: false } });
  });

  it("treats a generation stuck past the limit as failed and lets it be retried", async () => {
    const scan = await doneScan();
    const claim = await store.claimActionPackage(scan, 0, "stale-client", LIMITS);
    if (claim.outcome !== "start") throw new Error("expected start");
    await sql.query(`update action_packages set updated_at = now() - interval '11 minutes' where id = $1`, [claim.id]);
    expect(await store.getActionPackage(scan, 0)).toMatchObject({ state: "failed", canRetry: true });
    expect(await store.claimActionPackage(scan, 0, "stale-client", LIMITS)).toEqual({ outcome: "start", id: claim.id });
  });
});

describe("completeActionPackage", () => {
  it("stores the package, starts the ledger record and records both events, exactly once", async () => {
    const scan = await doneScan();
    const claim = await store.claimActionPackage(scan, 2, "c", LIMITS);
    if (claim.outcome !== "start") throw new Error("expected start");
    const pkg = fakePackage();
    await store.completeActionPackage(claim.id, pkg, planExperimentRecord(pkg));
    await store.completeActionPackage(claim.id, pkg, planExperimentRecord(pkg)); // idempotent

    expect(await store.getActionPackage(scan, 2)).toEqual({ state: "ready", id: claim.id, package: pkg });
    const records = await sql.query(`select status, hypothesis, change, decision from experiment_records where action_package_id = $1`, [claim.id]);
    expect(records.rows).toEqual([{ status: "planned", hypothesis: "h", change: { featureFlag: "signup_price", summary: "o" }, decision: null }]);
    const events = await sql.query(`select event_type from scan_events where scan_job_id = $1 and card_index = 2 order by event_type`, [scan]);
    expect(events.rows.map((r) => r.event_type)).toEqual(["action_package_generated", "experiment_created"]);
  });

  it("accepts a result that arrives after the row was marked failed for taking too long", async () => {
    const scan = await doneScan();
    const claim = await store.claimActionPackage(scan, 0, "late", LIMITS);
    if (claim.outcome !== "start") throw new Error("expected start");
    await store.failActionPackage(claim.id, "too slow");
    const pkg = fakePackage();
    await store.completeActionPackage(claim.id, pkg, planExperimentRecord(pkg));
    expect((await store.getActionPackage(scan, 0)).state).toBe("ready");
  });
});

describe("constraints and retention", () => {
  it("rejects inconsistent rows at the database level", async () => {
    const scan = await doneScan();
    await expect(sql.query(`insert into action_packages (scan_job_id, card_index, status) values ($1, 0, 'ready')`, [scan])).rejects.toThrow(/package_iff_ready/);
    const pkgRow = await sql.query(`insert into action_packages (scan_job_id, card_index, status) values ($1, 1, 'generating') returning id`, [scan]);
    const base = `insert into experiment_records (scan_job_id, card_index, action_package_id, status, hypothesis, evidence_snapshot, change, experiment, result, decision)
                  values ($1, 1, $2, $3, 'h', '[]', '{}', '{}', $4, $5)`;
    await expect(sql.query(base, [scan, pkgRow.rows[0].id, "planned", "won", "ship"])).rejects.toThrow(/decision_iff_decided/);
    await expect(sql.query(base, [scan, pkgRow.rows[0].id, "decided", null, "ship"])).rejects.toThrow(/decision_has_result/);
  });

  it("deletes packages and ledger records with their scan, and clears package IP hashes after 48 h", async () => {
    const scan = await doneScan();
    const claim = await store.claimActionPackage(scan, 0, "old-client", LIMITS);
    if (claim.outcome !== "start") throw new Error("expected start");
    const pkg = fakePackage();
    await store.completeActionPackage(claim.id, pkg, planExperimentRecord(pkg));
    await sql.query(`update action_packages set created_at = now() - interval '3 days' where id = $1`, [claim.id]);

    await store.purgeExpiredData({ retentionDays: 180, ipHashHours: 48 });
    expect((await sql.query(`select client_ip_hash from action_packages where id = $1`, [claim.id])).rows[0].client_ip_hash).toBeNull();

    await sql.query(`delete from scan_jobs where id = $1`, [scan]);
    expect((await sql.query(`select count(*)::int as n from experiment_records where scan_job_id = $1`, [scan])).rows[0].n).toBe(0);
    expect((await sql.query(`select count(*)::int as n from action_packages where scan_job_id = $1`, [scan])).rows[0].n).toBe(0);
  });
});
