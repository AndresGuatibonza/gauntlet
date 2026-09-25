// Preflight check: confirms both TLS-trust paths this project depends on
// (the Supabase Postgres pooler, and the Claude API) actually work right
// now, in ONE command -- instead of the multi-step investigation Build
// Order #3 needed the first two times this broke (a missing
// NODE_EXTRA_CA_CERTS file, then Falcon rotating its interception root
// overnight). Run this any time a scan fails with a certificate error
// before assuming it's a code problem.
//
// Usage: node scripts/verify-tls.mjs
//
// Reads DATABASE_URL from apps/web/.env.local to find the Postgres host
// automatically (never prints the password), and ANTHROPIC_API_KEY the
// same way test-anthropic-tls.mjs does.
import net from "node:net";
import tls from "node:tls";
import { readFileSync, existsSync } from "node:fs";
import { rootCertificates } from "node:tls";

function readEnvLocal() {
  const path = "apps/web/.env.local";
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const out = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = readEnvLocal();
const extraCaCertsPath = process.env["NODE_EXTRA_CA_CERTS"];
console.log("NODE_EXTRA_CA_CERTS =", extraCaCertsPath ?? "(not set)");

let ca;
if (extraCaCertsPath) {
  try {
    const extraCaCerts = readFileSync(extraCaCertsPath, "utf-8");
    const count = (extraCaCerts.match(/BEGIN CERTIFICATE/g) || []).length;
    console.log(`Loaded ${count} cert(s) from the extra CA file.`);
    ca = [...rootCertificates, extraCaCerts];
  } catch (err) {
    console.error(`Could not read NODE_EXTRA_CA_CERTS file: ${err.message}`);
    console.error("-- that alone explains any failure below. Re-check the path/regenerate the file per the README.");
  }
}

let pgOk = false;
let anthropicOk = false;

// --- Postgres ---
function extractPgHostPort(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    return { host: u.hostname, port: Number(u.port || 5432) };
  } catch {
    return null;
  }
}

const pgTarget = extractPgHostPort(env["DATABASE_URL"]);
if (!pgTarget) {
  console.log("\n[Postgres] SKIPPED -- no DATABASE_URL found in apps/web/.env.local.");
} else {
  console.log(`\n[Postgres] Testing ${pgTarget.host}:${pgTarget.port} ...`);
  pgOk = await new Promise((resolve) => {
    const raw = net.connect(pgTarget.port, pgTarget.host, () => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      raw.write(req);
    });
    raw.once("data", (chunk) => {
      if (chunk.toString("latin1")[0] !== "S") {
        console.error("[Postgres] Server declined SSL upgrade.");
        resolve(false);
        return;
      }
      const socket = tls.connect({ socket: raw, servername: pgTarget.host, rejectUnauthorized: true, ca }, () => {
        console.log("[Postgres] OK -- TLS handshake succeeded, authorized:", socket.authorized);
        socket.end();
        resolve(true);
      });
      socket.on("error", (err) => {
        console.error("[Postgres] FAILED:", err.message, `(${err.code})`);
        resolve(false);
      });
    });
    raw.on("error", (err) => {
      console.error("[Postgres] TCP error:", err.message);
      resolve(false);
    });
    setTimeout(() => resolve(false), 10000);
  });
}

// --- Anthropic API ---
const apiKey = process.env["ANTHROPIC_API_KEY"] || env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.log("\n[Anthropic] SKIPPED -- no ANTHROPIC_API_KEY found (env or apps/web/.env.local).");
} else {
  console.log("\n[Anthropic] Testing a real API call ...");
  try {
    const { Agent: HttpsAgent } = await import("node:https");
    const httpAgent = ca ? new HttpsAgent({ keepAlive: true, ca }) : undefined;
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic(httpAgent ? { apiKey, httpAgent } : { apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    console.log("[Anthropic] OK --", JSON.stringify(response.content));
    anthropicOk = true;
  } catch (err) {
    console.error("[Anthropic] FAILED:", err?.message);
    console.error("  cause:", err?.cause?.message ?? err?.cause, `(${err?.cause?.code ?? err?.code ?? "?"})`);
  }
}

console.log("\n--- Summary ---");
console.log("Postgres :", pgOk ? "OK" : "FAILED/SKIPPED");
console.log("Anthropic:", anthropicOk ? "OK" : "FAILED/SKIPPED");
if (!pgOk || !anthropicOk) {
  console.log(
    "\nOn a corporate machine with TLS-inspecting endpoint security, a FAILED " +
      "result here (not SKIPPED) usually means the cert file needs " +
      "regenerating -- see the README's 'On a corporate machine...' section.",
  );
  process.exit(1);
}
process.exit(0);
