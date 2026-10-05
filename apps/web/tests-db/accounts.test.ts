import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { applyExperimentUpdate, planExperimentRecord, type ActionPackage } from "@gauntlet/core";
import { runMigrations } from "@/lib/migrate";
import { newClaimToken } from "@/lib/accounts";
import { connect, createTestDatabase } from "./helpers";

let db: { url: string; drop: () => Promise<void> };
let sql: Client;
let store: typeof import("@/lib/store");
let dbModule: typeof import("@/lib/db");

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";

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

async function scan(url = "https://www.Acme.com/pricing"): Promise<{ id: string; token: string }> {
  const claim = newClaimToken();
  const r = await store.createScanJobWithinQuota(url, "ai_saas", `c-${Math.random()}`, { perClient: 99, global: 999 }, claim.hash);
  if (!r.ok) throw new Error("quota");
  await sql.query(`update scan_jobs set status = 'done' where id = $1`, [r.id]);
  return { id: r.id, token: claim.token };
}

function pkg(): ActionPackage {
  return {
    objective: "o", nonGoals: ["n"], likelyComponents: ["the signup form"], approach: ["a", "b"],
    featureFlag: { name: "signup_price", rollout: "50%" }, acceptanceCriteria: ["1", "2", "3"],
    measurement: { howToMeasure: "m", baseline: "b", minimumDuration: "2 weeks" }, rollbackCriteria: ["r"],
    risks: [{ risk: "x", mitigation: "y" }], missingContext: ["repo"], evidenceRefs: ["E1"], version: 1,
    generatedAt: "2026-10-05T15:00:00.000Z", product: { name: "Acme", url: "https://acme.com/" },
    card: { title: "Show the price", hypothesis: "h", changeSurface: "ux", missingEvidence: "me" },
    experiment: { control: "c", variant: "v", audience: "a", primaryMetric: "p", guardrails: "g", stoppingRule: "s" },
    codeContext: "public_scan", citedEvidence: [{ id: "E1", observation: "obs", sourceRef: "https://acme.com/" }],
  };
}

async function experimentFor(scanId: string): Promise<void> {
  const claim = await store.claimActionPackage(scanId, 0, "c", { perClient: 99, global: 999 });
  if (claim.outcome !== "start") throw new Error("expected start");
  await store.completeActionPackage(claim.id, pkg(), planExperimentRecord(pkg()));
}

describe("claimScan", () => {
  it("needs the scan's own token, and saves it to one workspace per product", async () => {
    const a = await scan();
    expect(await store.claimScan(a.id, newClaimToken().token, ALICE)).toEqual({ outcome: "invalid_token" });
    const first = await store.claimScan(a.id, a.token, ALICE);
    expect(first.outcome).toBe("claimed");
    expect(await store.claimScan(a.id, a.token, ALICE)).toEqual({ outcome: "already_yours", workspaceId: (first as { workspaceId: string }).workspaceId });
    expect(await store.claimScan(a.id, a.token, BOB)).toEqual({ outcome: "claimed_by_other" });
    expect(await store.getScanOwner(a.id)).toBe(ALICE);

    const again = await scan("https://www.acme.com/");
    const second = await store.claimScan(again.id, again.token, ALICE);
    expect(second).toEqual({ outcome: "claimed", workspaceId: (first as { workspaceId: string }).workspaceId });
    expect((await sql.query(`select count(*)::int as n from workspaces where owner_user_id = $1`, [ALICE])).rows[0].n).toBe(1);
  });

  it("refuses scans without a token (created before accounts) and unknown scans", async () => {
    const r = await sql.query(`insert into scan_jobs (url, category, status) values ('https://old.com/', 'ai_saas', 'done') returning id`);
    expect(await store.claimScan(r.rows[0].id, newClaimToken().token, ALICE)).toEqual({ outcome: "invalid_token" });
    expect(await store.claimScan("00000000-0000-4000-8000-000000000000", newClaimToken().token, ALICE)).toEqual({ outcome: "not_found" });
    expect(await store.getScanOwner(r.rows[0].id)).toBeNull();
  });

  it("resolves two simultaneous claims by different users to exactly one owner", async () => {
    const s = await scan("https://race.com/");
    const results = await Promise.all([store.claimScan(s.id, s.token, ALICE), store.claimScan(s.id, s.token, BOB)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["claimed", "claimed_by_other"]);
  });
});

describe("web Experiment Ledger", () => {
  it("records running, then a decision with its event, then an outcome; and lists it for the owner", async () => {
    const s = await scan("https://ledger.com/");
    await store.claimScan(s.id, s.token, ALICE);
    await experimentFor(s.id);

    let current = (await store.getExperimentForCard(s.id, 0))!;
    expect(current.record.status).toBe("planned");
    let saved = await store.updateExperiment(current.id, current.record, applyExperimentUpdate(current.record, { running: true }), ALICE);
    expect(saved.outcome).toBe("updated");

    current = (await store.getExperimentForCard(s.id, 0))!;
    saved = await store.updateExperiment(current.id, current.record, applyExperimentUpdate(current.record, { decision: "ship", result: "+8%" }), ALICE);
    expect(saved).toMatchObject({ outcome: "updated", experiment: { record: { status: "decided", decision: "ship" } } });
    const row = (await sql.query(`select decided_at, decided_by from experiment_records where id = $1`, [current.id])).rows[0];
    expect(row.decided_by).toBe(ALICE);
    expect(row.decided_at).not.toBeNull();
    const events = await sql.query(`select count(*)::int as n from scan_events where scan_job_id = $1 and event_type = 'experiment_decision_recorded'`, [s.id]);
    expect(events.rows[0].n).toBe(1);

    current = (await store.getExperimentForCard(s.id, 0))!;
    await store.updateExperiment(current.id, current.record, applyExperimentUpdate(current.record, { outcome: "Rolled out" }), ALICE);

    const ledger = await store.listExperimentsForUser(ALICE);
    expect(ledger.find((e) => e.scanJobId === s.id)).toMatchObject({ productName: "ledger.com", cardTitle: "Show the price", record: { outcome: "Rolled out" } });
    expect(await store.listExperimentsForUser(BOB)).toEqual([]);
  });

  it("lets only one of two concurrent decisions win", async () => {
    const s = await scan("https://twotabs.com/");
    await store.claimScan(s.id, s.token, ALICE);
    await experimentFor(s.id);
    const read = (await store.getExperimentForCard(s.id, 0))!;
    const [a, b] = await Promise.all([
      store.updateExperiment(read.id, read.record, applyExperimentUpdate(read.record, { decision: "ship", result: "tab A" }), ALICE),
      store.updateExperiment(read.id, read.record, applyExperimentUpdate(read.record, { decision: "discard", result: "tab B" }), ALICE),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["conflict", "updated"]);
  });
});

describe("retention with accounts", () => {
  it("purges old anonymous scans but keeps saved ones", async () => {
    const saved = await scan("https://kept.com/");
    await store.claimScan(saved.id, saved.token, ALICE);
    const anonymous = await scan("https://gone.com/");
    await sql.query(`update scan_jobs set created_at = now() - interval '200 days' where id = any($1)`, [[saved.id, anonymous.id]]);
    await store.purgeExpiredData({ retentionDays: 180, ipHashHours: 48 });
    const left = await sql.query(`select id from scan_jobs where id = any($1)`, [[saved.id, anonymous.id]]);
    expect(left.rows.map((r) => r.id)).toEqual([saved.id]);
  });
});
