// One-off diagnostic script (not part of the product) -- connects to a
// given host/port, walks the certificate chain the network actually
// presents (via node:tls, the same stack our own code uses), prints
// Subject/Issuer for each certificate, and saves the whole chain as one
// PEM file so it can be pointed at via NODE_EXTRA_CA_CERTS.
//
// CAVEAT, confirmed the hard way during Build Order #3: this only
// captures what's actually sent over the wire. For a genuinely
// MITM-intercepted host (a corporate TLS-inspecting proxy reissuing its
// own certificate), that's a dynamically-minted LEAF certificate, not
// the proxy's own root -- the root is never sent over the wire, since
// the client is expected to already trust it via the OS certificate
// store. A captured leaf can stop validating the very next connection
// if the proxy mints a fresh one per session. For that case, export the
// proxy's actual root from Windows' Trusted Root store instead (see
// README's TLS-inspecting-endpoint-security section) rather than
// trusting this script's output as-is. This script's output IS the
// right thing to use as-is for a host with its own genuine, non-public
// private root that isn't being intercepted at all (check: is the
// *issuer* on the leaf actually your interception vendor, or the
// destination's own CA?).
//
// Usage:
//   node scripts/get-chain.mjs [host] [port] [outFile]
//
// Defaults to api.anthropic.com:443 (the original Build Order #2 use
// case) if no args are given. For a plain HTTPS-style port (443, or any
// port that starts a TLS handshake immediately on connect), that's all
// you need:
//
//   node scripts/get-chain.mjs api.anthropic.com 443 falcon-root.pem
//
// Postgres (including Supabase's pooler, port 6543 or 5432) does NOT
// start with a TLS ClientHello -- the client has to speak the Postgres
// wire protocol first: send an 8-byte SSLRequest packet and wait for a
// single 'S' (0x53) byte back before upgrading the same TCP socket to
// TLS. Pass --pg to do that negotiation first:
//
//   node scripts/get-chain.mjs aws-0-us-east-1.pooler.supabase.com 6543 falcon-root.pem --pg
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--pg");
const isPg = process.argv.includes("--pg");
const HOST = args[0] ?? "api.anthropic.com";
const PORT = Number(args[1] ?? 443);
const OUT_FILE = args[2] ?? "corp-ca-chain.pem";

function dumpChainAndExit(socket) {
  let cert = socket.getPeerCertificate(true);
  const certs = [];
  const seen = new Set();
  while (cert && Object.keys(cert).length > 0 && !seen.has(cert.fingerprint)) {
    seen.add(cert.fingerprint);
    certs.push(cert);
    if (cert.issuerCertificate && cert.issuerCertificate.fingerprint !== cert.fingerprint) {
      cert = cert.issuerCertificate;
    } else {
      break;
    }
  }

  if (certs.length === 0) {
    console.error("No certificates were returned by the peer at all -- something else is wrong.");
    socket.end();
    process.exit(1);
  }

  let pem = "";
  certs.forEach((c, i) => {
    console.log(`[${i}] Subject: ${JSON.stringify(c.subject)}`);
    console.log(`[${i}] Issuer:  ${JSON.stringify(c.issuer)}`);
    const b64 = c.raw.toString("base64").replace(/(.{64})/g, "$1\n");
    pem += `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  });
  fs.writeFileSync(OUT_FILE, pem);
  console.log(`Saved ${certs.length} cert(s) to ${OUT_FILE}`);
  socket.end();
  process.exit(0);
}

if (!isPg) {
  const socket = tls.connect(PORT, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
    dumpChainAndExit(socket);
  });
  socket.on("error", (err) => {
    console.error("ERROR:", err.message);
    process.exit(1);
  });
} else {
  // Postgres SSLRequest handshake: an 8-byte message, length=8 (int32) +
  // the fixed SSL request code 80877103 (int32), per the Postgres wire
  // protocol docs. The server replies with a single byte: 'S' (0x53)
  // means "go ahead, upgrade to TLS"; 'N' (0x4e) means it won't.
  const raw = net.connect(PORT, HOST, () => {
    const req = Buffer.alloc(8);
    req.writeInt32BE(8, 0);
    req.writeInt32BE(80877103, 4);
    raw.write(req);
  });
  raw.once("data", (chunk) => {
    const reply = chunk.toString("latin1")[0];
    if (reply !== "S") {
      console.error(`Server declined SSL upgrade (replied '${reply}', expected 'S') -- can't inspect a chain that's never negotiated.`);
      raw.end();
      process.exit(1);
    }
    const socket = tls.connect(
      { socket: raw, servername: HOST, rejectUnauthorized: false },
      () => dumpChainAndExit(socket),
    );
    socket.on("error", (err) => {
      console.error("ERROR:", err.message);
      process.exit(1);
    });
  });
  raw.on("error", (err) => {
    console.error("ERROR (TCP):", err.message);
    process.exit(1);
  });
}
