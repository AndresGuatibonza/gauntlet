import { nodeHttpClient, RobotsChecker, RateLimiter, PageFetcher } from "../src/core/fetcher.ts";
import { discoverAndFetchPages } from "../src/core/page-discovery.ts";
import { extractPage } from "../src/core/extractor.ts";
import { buildEvidencePacket } from "../src/core/normalizer.ts";
import { EvidencePacketSchema } from "../src/core/evidence-packet.ts";

const url = "http://127.0.0.1:8734/";
const robots = new RobotsChecker(nodeHttpClient);
const rateLimiter = new RateLimiter(50);
const fetcher = new PageFetcher(nodeHttpClient, robots, rateLimiter);

const { fetched, notReachable } = await discoverAndFetchPages(url, fetcher, 5);
const pages = fetched.map((f) => ({ fetch: f, extraction: f.ok && f.html ? extractPage(f.html, f.url) : null }));
const packet = buildEvidencePacket({
  homepageUrl: url,
  category: "ai_saas",
  pages,
  notReachable,
  now: () => new Date().toISOString(),
});
const parsed = EvidencePacketSchema.safeParse(packet);
console.log("schema valid:", parsed.success);
if (!parsed.success) console.log(parsed.error.message);
console.log(JSON.stringify(packet, null, 2));
