/**
 * Migration runner for the web app's Postgres (Supabase). Replaces
 * pasting each file into the SQL Editor by hand.
 *
 * - Applied migrations are recorded in schema_migrations with a SHA-256 of
 *   the file. A recorded migration whose file has since changed stops the
 *   run: an applied migration is history, and a change belongs in a new file.
 * - Each pending migration runs in its own transaction, together with its
 *   schema_migrations row, so a failure leaves nothing half-applied and the
 *   next run retries exactly that file.
 * - A transaction-scoped advisory lock serializes concurrent runs (two
 *   deploys, or a deploy and a person), and works through Supabase's
 *   transaction-mode pooler.
 * - Files are applied in filename order (001_..., 002_...). Every file
 *   written so far is idempotent, so a database migrated by hand before
 *   this runner existed is brought under it by simply running it: the first
 *   run re-applies 001-005 harmlessly and records them.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientBase } from "pg";

export const MIGRATIONS_DIR = join(__dirname, "migrations");
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 7254002; // distinct from the scan-quota lock (7254001)

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Reads and validates the migration files: well-named, numbered without gaps or duplicates. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const migrations: MigrationFile[] = [];
  files.forEach((file, i) => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) {
      throw new MigrationError(`Migration file "${file}" must be named NNN_snake_case.sql.`);
    }
    const expected = String(i + 1).padStart(3, "0");
    if (match[1] !== expected) {
      throw new MigrationError(`Migration numbering must be consecutive from 001: expected ${expected}_..., found "${file}".`);
    }
    const sql = readFileSync(join(dir, file), "utf-8");
    migrations.push({ name: file.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") });
  });
  return migrations;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

/**
 * Creates schema_migrations under the advisory lock: two runners racing on
 * a bare `create table if not exists` collide in the catalog (found by the
 * concurrency test), so the check-and-create must be serialized too.
 */
async function ensureTable(client: ClientBase): Promise<void> {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function readApplied(client: ClientBase): Promise<Map<string, string>> {
  const rows = await client.query<{ name: string; checksum: string }>(`select name, checksum from schema_migrations`);
  return new Map(rows.rows.map((r) => [r.name, r.checksum]));
}

/** Fails if a recorded migration's file changed, or a recorded migration has no file. */
function verifyHistory(migrations: MigrationFile[], applied: Map<string, string>): void {
  const byName = new Map(migrations.map((m) => [m.name, m]));
  for (const [name, checksum] of applied) {
    const file = byName.get(name);
    if (!file) {
      throw new MigrationError(`schema_migrations records "${name}" but there is no such file. Restore it; never delete an applied migration.`);
    }
    if (file.checksum !== checksum) {
      throw new MigrationError(
        `Migration "${name}" was changed after it was applied (checksum mismatch). Revert the edit and put the change in a new migration.`,
      );
    }
  }
}

export async function migrationStatus(client: ClientBase, migrations: MigrationFile[] = loadMigrations()): Promise<MigrationStatus> {
  await ensureTable(client);
  const applied = await readApplied(client);
  verifyHistory(migrations, applied);
  return {
    applied: migrations.filter((m) => applied.has(m.name)).map((m) => m.name),
    pending: migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
  };
}

/**
 * Applies every pending migration, in order, each in its own transaction.
 * Returns the names applied. On a failure, throws a MigrationError naming
 * the file; migrations before it stay applied, it and later ones don't.
 */
export async function runMigrations(
  client: ClientBase,
  migrations: MigrationFile[] = loadMigrations(),
  log: (line: string) => void = () => {},
): Promise<string[]> {
  await ensureTable(client);
  const appliedNow: string[] = [];
  for (const migration of migrations) {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      // Re-read under the lock: another runner may have applied it meanwhile.
      const applied = await readApplied(client);
      verifyHistory(migrations, applied);
      if (applied.has(migration.name)) {
        await client.query("rollback");
        continue;
      }
      await client.query(migration.sql);
      await client.query(`insert into schema_migrations (name, checksum) values ($1, $2)`, [migration.name, migration.checksum]);
      await client.query("commit");
      appliedNow.push(migration.name);
      log(`applied ${migration.name}`);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(`Migration "${migration.name}" failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return appliedNow;
}
