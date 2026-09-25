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
import { SUPABASE_CA_PEM } from "./supabase-ca.js";

let pool: Pool | undefined;

/**
 * The Supabase pooler's own root (SUPABASE_CA_PEM) is needed on every
 * environment -- confirmed the hard way on a real Vercel deployment,
 * which has no corporate proxy in the picture at all. NODE_EXTRA_CA_CERTS
 * is a separate, machine-specific concern (corporate TLS-inspecting
 * endpoint security -- see the README) layered on top of that, not a
 * replacement for it: same rationale as llm-client.ts's buildHttpAgent(),
 * the env var is only reliably honored by Node's own core https/tls
 * modules, and only if the file it points to loads cleanly -- if it's
 * set but unreadable, we fail loudly and specifically instead of letting
 * it fail later with an opaque "self-signed certificate in certificate
 * chain" from deep inside `pg`.
 */
function buildSslConfig(): { rejectUnauthorized: boolean; ca: (string | Buffer)[] } {
  const ca: (string | Buffer)[] = [...rootCertificates, SUPABASE_CA_PEM];

  const extraCaCertsPath = process.env["NODE_EXTRA_CA_CERTS"];
  if (extraCaCertsPath) {
    try {
      ca.push(readFileSync(extraCaCertsPath, "utf-8"));
    } catch (err) {
      throw new Error(
        `NODE_EXTRA_CA_CERTS is set to "${extraCaCertsPath}" but that file could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
          `On a corporate machine with TLS-inspecting endpoint security, re-run scripts/get-chain.mjs against the Supabase pooler host to regenerate it (see README).`,
      );
    }
  }

  return { rejectUnauthorized: true, ca };
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
