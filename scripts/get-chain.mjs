// One-off diagnostic script (not part of the product) -- connects to
// api.anthropic.com, walks the certificate chain the network actually
// presents (via node:tls, the same stack the CLI itself uses), prints
// Subject/Issuer for each certificate, and saves the whole chain as one
// PEM file so it can be pointed at via NODE_EXTRA_CA_CERTS.
import tls from "node:tls";
import fs from "node:fs";

const HOST = "api.anthropic.com";
const OUT_FILE = "corp-ca-chain.pem";

const socket = tls.connect(
  443,
  HOST,
  { rejectUnauthorized: false, servername: HOST },
  () => {
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
  },
);

socket.on("error", (err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
