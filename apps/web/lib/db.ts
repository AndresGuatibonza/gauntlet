/**
 * Postgres connection pool for the web app, pointed at Supabase's
 * transaction-mode pooler (Supavisor/PgBouncer, port 6543) -- required
 * because a serverless function opens many short-lived connections, which
 * would exhaust Postgres' own connection limit against the direct port.
 *
 * Two things transaction mode requires that a normal `pg` setup doesn't
 * (per Supabase's own docs, confirmed 2026-09):
 *   1. No named/server-side prepared statements. We never pass `{ name, ... }`
 *      to a query, only `pool.query(text, values)` -- that uses the
 *      extended protocol's *unnamed* statement, which transaction mode
 *      tolerates fine.
 *   2. A small pool per function instance -- the pooler is already doing
 *      the real pooling upstream; a large local pool just adds redundant
 *      connections behind the pooler's, which is what "pool exhausted"
 *      reports usually turn out to be.
 *
 * attachDatabasePool() (from @vercel/functions) is Vercel's own hook for
 * fluid compute: it releases idle clients before an instance suspends,
 * instead of leaking a connection every time an instance is recycled.
 */
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy apps/web/.env.example to .env.local and fill in the Supabase transaction-pooler connection string.",
    );
  }

  pool = new Pool({
    connectionString,
    max: 3,
    ssl: { rejectUnauthorized: true },
  });
  attachDatabasePool(pool);
  return pool;
}
