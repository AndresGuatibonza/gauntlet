// One-off diagnostic: reproduces exactly llm-client.ts's buildHttpAgent()
// (same CA combination) and makes one real, minimal Claude API call,
// entirely outside Next.js -- isolates whether a TLS/cert issue is real
// at the Node level, or specific to something Next.js's own fetch
// patching does to outgoing requests inside a route handler.
//
// Reads ANTHROPIC_API_KEY from the environment, or if not set, parses it
// out of apps/web/.env.local itself (never prints the key value).
import { readFileSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import { rootCertificates } from "node:tls";
import { existsSync } from "node:fs";

function loadApiKey() {
  if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"];
  const envPath = "apps/web/.env.local";
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, "utf-8");
  const match = content.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("No ANTHROPIC_API_KEY found (env or apps/web/.env.local).");
  process.exit(1);
}
console.log("API key loaded:", apiKey.slice(0, 8) + "..." + apiKey.slice(-4));

const extraCaCertsPath = process.env["NODE_EXTRA_CA_CERTS"];
console.log("NODE_EXTRA_CA_CERTS =", extraCaCertsPath);

let httpAgent;
if (extraCaCertsPath) {
  const extraCaCerts = readFileSync(extraCaCertsPath, "utf-8");
  console.log(`Combining rootCertificates + ${(extraCaCerts.match(/BEGIN CERTIFICATE/g) || []).length} certs from extra file.`);
  httpAgent = new HttpsAgent({ keepAlive: true, ca: [...rootCertificates, extraCaCerts] });
} else {
  console.log("No NODE_EXTRA_CA_CERTS -- using SDK default agent.");
}

const { default: Anthropic } = await import("@anthropic-ai/sdk");
const client = new Anthropic(httpAgent ? { apiKey, httpAgent } : { apiKey });

try {
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  console.log("SUCCESS. Response:", JSON.stringify(response.content));
} catch (err) {
  console.error("FAILED:", err?.message);
  console.error("cause:", err?.cause?.message ?? err?.cause);
  console.error("code:", err?.cause?.code ?? err?.code);
}
