// One-off diagnostic: reproduces exactly db.ts's SSL config (rootCertificates
// + NODE_EXTRA_CA_CERTS file, rejectUnauthorized: true) against the real
// Postgres host, isolating whether the CA bundle itself is the problem or
// something in the pg/Next.js layering above it.
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";

const HOST = process.argv[2];
const PORT = Number(process.argv[3] ?? 6543);

if (!HOST) {
  console.error("Usage: node scripts/test-pg-tls.mjs <host> [port]");
  process.exit(1);
}

const extraCaCertsPath = process.env["NODE_EXTRA_CA_CERTS"];
console.log("NODE_EXTRA_CA_CERTS =", extraCaCertsPath);
let ca;
if (extraCaCertsPath) {
  const extraCaCerts = readFileSync(extraCaCertsPath, "utf-8");
  console.log(`Read ${extraCaCerts.length} bytes, ${(extraCaCerts.match(/BEGIN CERTIFICATE/g) || []).length} certs from extra file.`);
  ca = [...rootCertificates, extraCaCerts];
} else {
  console.log("No NODE_EXTRA_CA_CERTS set -- using default roots only.");
}

const raw = net.connect(PORT, HOST, () => {
  const req = Buffer.alloc(8);
  req.writeInt32BE(8, 0);
  req.writeInt32BE(80877103, 4);
  raw.write(req);
});
raw.once("data", (chunk) => {
  const reply = chunk.toString("latin1")[0];
  console.log("SSLRequest reply byte:", reply);
  if (reply !== "S") {
    console.error("Server declined SSL upgrade.");
    process.exit(1);
  }
  const socket = tls.connect(
    { socket: raw, servername: HOST, rejectUnauthorized: true, ca },
    () => {
      console.log("TLS HANDSHAKE SUCCEEDED. Authorized:", socket.authorized);
      socket.end();
      process.exit(0);
    },
  );
  socket.on("error", (err) => {
    console.error("TLS ERROR:", err.message);
    console.error("err.code:", err.code);
    process.exit(1);
  });
});
raw.on("error", (err) => {
  console.error("TCP ERROR:", err.message);
  process.exit(1);
});
