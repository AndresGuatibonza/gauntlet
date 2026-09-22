#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import {
  nodeHttpClient,
  RobotsChecker,
  RateLimiter,
  PageFetcher,
} from "../core/fetcher.js";
import { discoverAndFetchPages, DEFAULT_MAX_PAGES } from "../core/page-discovery.js";
import { extractPage } from "../core/extractor.js";
import { buildEvidencePacket, type PageScanResult } from "../core/normalizer.js";
import { EvidencePacketSchema } from "../core/evidence-packet.js";
import { openStore } from "../store/sqlite.js";

const program = new Command();

program
  .name("gauntlet")
  .description("Gauntlet - Product Scientist & Fast-Value Loop (Build Order #1: Ingestion Engine)");

program
  .command("scan")
  .description("Scan a public product URL and produce a normalized Evidence Packet")
  .argument("<url>", "Public HTTPS URL of the product's homepage")
  .option("--category <category>", "ai_tool or ai_saas", "ai_saas")
  .option("--max-pages <n>", "Maximum pages to fetch, homepage included", String(DEFAULT_MAX_PAGES))
  .option("--db <path>", "SQLite database path", "./gauntlet.db")
  .option("--out <path>", "Also write the Evidence Packet as JSON to this path")
  .action(async (url: string, opts: { category: string; maxPages: string; db: string; out?: string }) => {
    if (!url.startsWith("https://")) {
      console.error("Error: URL must be a public HTTPS URL (per PRD §8.1).");
      process.exitCode = 1;
      return;
    }
    if (opts.category !== "ai_tool" && opts.category !== "ai_saas") {
      console.error('Error: --category must be "ai_tool" or "ai_saas".');
      process.exitCode = 1;
      return;
    }
    const maxPages = Number.parseInt(opts.maxPages, 10);
    if (!Number.isFinite(maxPages) || maxPages < 1) {
      console.error("Error: --max-pages must be a positive integer.");
      process.exitCode = 1;
      return;
    }
    const category: "ai_tool" | "ai_saas" = opts.category === "ai_tool" ? "ai_tool" : "ai_saas";

    console.log(`Scanning ${url} (category: ${category}, max pages: ${maxPages})...`);

    const robots = new RobotsChecker(nodeHttpClient);
    const rateLimiter = new RateLimiter();
    const fetcher = new PageFetcher(nodeHttpClient, robots, rateLimiter);

    const { fetched, notReachable } = await discoverAndFetchPages(url, fetcher, maxPages);

    const pages: PageScanResult[] = fetched.map((f) => ({
      fetch: f,
      extraction: f.ok && f.html ? extractPage(f.html, f.url) : null,
    }));

    const packet = buildEvidencePacket({
      homepageUrl: url,
      category,
      pages,
      notReachable,
      now: () => new Date().toISOString(),
    });

    // Validate the packet against the contract before persisting or
    // printing anything -- a build-time guarantee that this Ingestion
    // Engine never emits something the Scientist's contract doesn't expect.
    const parsed = EvidencePacketSchema.safeParse(packet);
    if (!parsed.success) {
      console.error("Internal error: built Evidence Packet failed contract validation:");
      console.error(parsed.error.message);
      process.exitCode = 1;
      return;
    }

    const store = openStore(opts.db);
    const packetId = store.saveEvidencePacket(parsed.data);
    store.close();

    if (opts.out) {
      writeFileSync(opts.out, JSON.stringify(parsed.data, null, 2), "utf-8");
    }

    printSummary(parsed.data, packetId, opts.out);
  });

function printSummary(
  packet: ReturnType<typeof EvidencePacketSchema.parse>,
  packetId: number,
  outPath: string | undefined,
): void {
  console.log("");
  console.log(`Evidence Packet #${packetId} saved.`);
  console.log(`  Product: ${packet.productIdentity.productName}`);
  console.log(`  Pages inspected: ${packet.surfaceMap.pagesInspected.length}`);
  if (packet.surfaceMap.pagesNotReachable.length > 0) {
    console.log(`  Pages not reachable: ${packet.surfaceMap.pagesNotReachable.length}`);
    for (const p of packet.surfaceMap.pagesNotReachable) {
      console.log(`    - ${p.url} (${p.reason})`);
    }
  }
  console.log(`  Evidence items: ${packet.observedEvidence.length}`);
  const byType = new Map<string, number>();
  for (const item of packet.observedEvidence) {
    byType.set(item.evidenceType, (byType.get(item.evidenceType) ?? 0) + 1);
  }
  for (const [type, count] of byType) {
    console.log(`    - ${type}: ${count}`);
  }
  if (packet.confidenceMetadata.contradictions.length > 0) {
    console.log(`  Candidate contradictions flagged for review:`);
    for (const c of packet.confidenceMetadata.contradictions) {
      console.log(`    - ${c}`);
    }
  }
  console.log(`  Missing evidence: ${packet.confidenceMetadata.missingEvidenceSummary}`);
  if (outPath) {
    console.log(`  Full packet written to ${outPath}`);
  }
}

program.parseAsync(process.argv);
