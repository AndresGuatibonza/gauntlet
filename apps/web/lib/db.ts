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
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";

let pool: Pool | undefined;

/**
 * Same rationale as llm-client.ts's buildHttpAgent(): NODE_EXTRA_CA_CERTS
 * is only reliably honored by Node's own core modules (https/tls), and
 * even then only if the file it points to actually exists and loads
 * cleanly -- if it fails, Node just prints a warning and silently falls
 * back to the public CA list, which is exactly what happened here (the
 * env var pointed at a since-deleted/missing file). Rather than trust
 * that silent fallback again, we read the file ourselves and fail loudly
 * and specifically if it's missing, instead of failing later with an
 * opaque "self-signed certificate in certificate chain" from deep inside
 * `pg`.
 */
function buildSslConfig(): { rejectUnauthorized: boolean; ca?: (string | Buffer)[] } {
  const extraCaCertsPath = process.env["NODE_EXTRA_CA_CERTS"];
  if (!extraCaCertsPath) {
    return { rejectUnauthorized: true };
  }
  let extraCaCerts: string;
  try {
    extraCaCerts = readFileSync(extraCaCertsPath, "utf-8");
  } catch (err) {
    throw new Error(
      `NODE_EXTRA_CA_CERTS is set to "${extraCaCertsPath}" but that file could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        `On a corporate machine with TLS-inspecting endpoint security, re-run scripts/get-chain.mjs against the Supabase pooler host to regenerate it (see README).`,
    );
  }
  return { rejectUnauthorized: true, ca: [...rootCertificates, extraCaCerts] };
}

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
    ssl: buildSslConfig(),
  });
  attachDatabasePool(pool);
  return pool;
}
