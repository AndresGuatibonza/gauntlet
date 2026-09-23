import { createServer } from "node:http";

const PAGES = {
  "/": `<html><head><title>EchoDesk | AI support copilot</title></head><body>
    <nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav>
    <h1>Resolve 70% of tickets automatically</h1>
    <a href="/start">Start for free</a>
    <a href="/demo">Book a demo</a>
    <p>Trusted by 500+ support teams.</p>
  </body></html>`,
  "/pricing": `<html><head><title>Pricing - EchoDesk</title></head><body>
    <h1>Simple pricing</h1>
    <p>Growth plan: unlimited AI resolutions for $30/mo (or $19.99/mo billed annually).</p>
    <form><input name="email"></form>
  </body></html>`,
  "/docs": `<html><head><title>Docs - EchoDesk</title></head><body>
    <h1>Documentation</h1>
    <p>Connect your helpdesk in 2 minutes.</p>
  </body></html>`,
};

const server = createServer((req, res) => {
  if (req.url === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nAllow: /\n");
    return;
  }
  const page = PAGES[req.url ?? "/"];
  if (page) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(8734, () => {
  console.log("fixture server listening on http://127.0.0.1:8734");
});
