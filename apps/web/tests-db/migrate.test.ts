import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { loadMigrations, migrationStatus, runMigrations, MIGRATIONS_DIR, MigrationError } from "@/lib/migrate";
import { connect, createTestDatabase } from "./helpers";

let db: { url: string; drop: () => Promise<void> };
let client: Client;

beforeEach(async () => {
  db = await createTestDatabase();
  client = await connect(db.url);
});

afterEach(async () => {
  await client.end();
  await db.drop();
});

function copyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-migrations-"));
  for (const m of loadMigrations()) writeFileSync(join(dir, `${m.name}.sql`), m.sql);
  return dir;
}

describe("runMigrations", () => {
  it("applies every migration once, in order; a second run applies nothing", async () => {
    const all = loadMigrations().map((m) => m.name);
    expect(await runMigrations(client)).toEqual(all);
    expect(await runMigrations(client)).toEqual([]);
    expect(await migrationStatus(client)).toEqual({ applied: all, pending: [] });
    const cols = await client.query(`select column_name from information_schema.columns where table_name = 'scan_jobs'`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(["client_ip_hash", "progress"]));
  });

  it("adopts a database that was migrated by hand, without touching its data", async () => {
    // Production today: 001-005 pasted into the SQL Editor, rows present, no schema_migrations.
    for (const m of loadMigrations()) await client.query(m.sql);
    const job = await client.query(`insert into scan_jobs (url, category, status, client_ip_hash) values ('https://a.com/', 'ai_saas', 'done', 'h') returning id`);
    await client.query(`insert into scan_events (scan_job_id, event_type, client_ip_hash) values ($1, 'scan_started', 'h')`, [job.rows[0].id]);

    expect(await runMigrations(client)).toHaveLength(loadMigrations().length);
    expect((await client.query(`select count(*)::int as n from scan_jobs`)).rows[0].n).toBe(1);
    expect((await client.query(`select count(*)::int as n from scan_events`)).rows[0].n).toBe(1);
    // The widened event constraint from 004 survived re-running 003.
    await client.query(`insert into scan_events (scan_job_id, event_type) values ($1, 'scan_failed')`, [job.rows[0].id]);
  });

  it("refuses to run when an applied migration was edited afterwards", async () => {
    const dir = copyMigrations();
    try {
      await runMigrations(client, loadMigrations(dir));
      writeFileSync(join(dir, "002_scan_rate_limit.sql"), readFileSync(join(dir, "002_scan_rate_limit.sql"), "utf-8") + "\n-- edited\n");
      await expect(runMigrations(client, loadMigrations(dir))).rejects.toThrow(/"002_scan_rate_limit" was changed after it was applied/);
      await expect(migrationStatus(client, loadMigrations(dir))).rejects.toBeInstanceOf(MigrationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failing migration completely and keeps the ones before it", async () => {
    const dir = copyMigrations();
    try {
      const next = String(loadMigrations().length + 1).padStart(3, "0");
      writeFileSync(join(dir, `${next}_broken.sql`), "create table half_done (id int);\nselect * from no_such_table;\n");
      await expect(runMigrations(client, loadMigrations(dir))).rejects.toThrow(new RegExp(`"${next}_broken" failed and was rolled back`));
      const status = await migrationStatus(client, loadMigrations(dir));
      expect(status.pending).toEqual([`${next}_broken`]);
      expect((await client.query(`select to_regclass('half_done') as t`)).rows[0].t).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent runners: each migration is applied exactly once", async () => {
    const other = await connect(db.url);
    try {
      const [a, b] = await Promise.all([runMigrations(client), runMigrations(other)]);
      expect([...a, ...b].sort()).toEqual(loadMigrations().map((m) => m.name));
    } finally {
      await other.end();
    }
  });
});

describe("loadMigrations", () => {
  it("reads the real migrations folder in order", () => {
    expect(loadMigrations(MIGRATIONS_DIR)[0]?.name).toBe("001_init");
  });

  it("rejects gaps and badly named files", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-migrations-"));
    try {
      writeFileSync(join(dir, "001_a.sql"), "select 1;");
      writeFileSync(join(dir, "003_c.sql"), "select 1;");
      expect(() => loadMigrations(dir)).toThrow(/expected 002_/);
      rmSync(join(dir, "003_c.sql"));
      writeFileSync(join(dir, "002 bad.sql"), "select 1;");
      expect(() => loadMigrations(dir)).toThrow(/NNN_snake_case/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
