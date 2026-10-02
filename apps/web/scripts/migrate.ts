/**
 * npm run migrate [-- --status]
 *
 * Applies pending migrations from lib/migrations/ to MIGRATION_DATABASE_URL
 * (or DATABASE_URL). Reads apps/web/.env.local when present. Uses the same
 * TLS rules as the app (lib/db.ts): verified TLS with Supabase's CA, plus
 * NODE_EXTRA_CA_CERTS on a machine behind TLS inspection.
 */
import { Client } from "pg";
import { sslFor } from "../lib/db";
import { MigrationError, migrationStatus, runMigrations } from "../lib/migrate";

async function main(): Promise<number> {
  try {
    process.loadEnvFile?.(".env.local");
  } catch {
    // No .env.local: rely on the environment.
  }
  const connectionString = process.env["MIGRATION_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    console.error("Set MIGRATION_DATABASE_URL (or DATABASE_URL) to the database to migrate.");
    return 1;
  }
  const statusOnly = process.argv.includes("--status");
  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  try {
    await client.connect();
    if (statusOnly) {
      const { applied, pending } = await migrationStatus(client);
      console.log(`Applied (${applied.length}): ${applied.join(", ") || "none"}`);
      console.log(`Pending (${pending.length}): ${pending.join(", ") || "none"}`);
      return 0;
    }
    const applied = await runMigrations(client, undefined, (line) => console.log(line));
    console.log(applied.length > 0 ? `Done: ${applied.length} migration(s) applied.` : "Database is up to date.");
    return 0;
  } catch (err) {
    console.error(err instanceof MigrationError ? `Migration error: ${err.message}` : `Could not migrate: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then((code) => process.exit(code));
