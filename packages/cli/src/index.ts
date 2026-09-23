#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import {
  nodeHttpClient,
  RobotsChecker,
  RateLimiter,
  PageFetcher,
  discoverAndFetchPages,
  DEFAULT_MAX_PAGES,
  extractPage,
  buildEvidencePacket,
  type PageScanResult,
  EvidencePacketSchema,
  createAnthropicLlmClient,
  LlmCallError,
  generateOpportunityReport,
  ScientistError,
  reviewOpportunityReport,
  ReviewerError,
  type ReviewRecord,
  type OpportunityCard,
  type OpportunityReport,
} from "@gauntlet/core";
import { openStore } from "./store/sqlite.js";

// Node 20.6+ built-in .env loader. Optional -- ANTHROPIC_API_KEY may also
// already be set in the shell. Never throws if the file is absent; a
// missing key is instead reported clearly by createAnthropicLlmClient when
// `analyze` actually needs it.
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // no .env file present at cwd -- fall through silently and rely on
  // whatever ANTHROPIC_API_KEY is already set in the shell environment.
}

const program = new Command();

program
  .name("gauntlet")
  .description("Gauntlet - Product Scientist & Fast-Value Loop (Build Order #1: Ingestion Engine, #2: Scientist + Reviewer)");

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

program
  .command("analyze")
  .description("Run the Product Scientist + Reviewer/Critic on a previously scanned Evidence Packet")
  .argument("<packetId>", "Evidence Packet id, as printed by `gauntlet scan`")
  .option("--db <path>", "SQLite database path", "./gauntlet.db")
  .option("--out <path>", "Also write the Opportunity Report as JSON to this path")
  .action(async (packetIdArg: string, opts: { db: string; out?: string }) => {
    const packetId = Number.parseInt(packetIdArg, 10);
    if (!Number.isFinite(packetId) || packetId < 1) {
      console.error("Error: <packetId> must be a positive integer.");
      process.exitCode = 1;
      return;
    }

    const store = openStore(opts.db);
    const packet = store.getEvidencePacketById(packetId);
    if (!packet) {
      console.error(`Error: no Evidence Packet with id ${packetId} in ${opts.db}. Run \`gauntlet scan\` first.`);
      store.close();
      process.exitCode = 1;
      return;
    }

    let llmClient;
    try {
      llmClient = createAnthropicLlmClient();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      store.close();
      process.exitCode = 1;
      return;
    }

    console.log(`Running Product Scientist on Evidence Packet #${packetId} (${packet.productIdentity.productName})...`);
    let scientistReport;
    try {
      scientistReport = await generateOpportunityReport(packet, llmClient);
    } catch (err) {
      console.error(describeAnalysisError("Scientist", err));
      store.close();
      process.exitCode = 1;
      return;
    }
    console.log(`  Generated ${scientistReport.cards.length} candidate Opportunity Card(s).`);

    console.log("Running Reviewer/Critic on the generated cards...");
    let reviewed;
    try {
      reviewed = await reviewOpportunityReport(scientistReport, packet, llmClient);
    } catch (err) {
      console.error(describeAnalysisError("Reviewer", err));
      store.close();
      process.exitCode = 1;
      return;
    }

    const reportId = store.saveOpportunityReport(packetId, reviewed.report, reviewed.reviewRecords);
    store.close();

    if (opts.out) {
      writeFileSync(opts.out, JSON.stringify(reviewed, null, 2), "utf-8");
    }

    printAnalysisSummary(reviewed.report, reviewed.reviewRecords, reportId, opts.out);
  });

function describeAnalysisError(component: "Scientist" | "Reviewer", err: unknown): string {
  if (err instanceof ScientistError || err instanceof ReviewerError) {
    return `${component} error: ${err.message}`;
  }
  if (err instanceof LlmCallError) {
    return `${component} error: ${err.message}`;
  }
  return `${component} error (unexpected): ${err instanceof Error ? err.message : String(err)}`;
}

function printAnalysisSummary(
  report: OpportunityReport,
  reviewRecords: ReviewRecord[],
  reportId: number,
  outPath: string | undefined,
): void {
  console.log("");
  console.log(`Opportunity Report #${reportId} saved (${report.cards.length} card(s) survived review).`);
  const dropped = reviewRecords.filter((r) => r.verdict === "drop");
  const downgraded = reviewRecords.filter((r) => r.verdict === "downgrade_confidence");
  if (dropped.length > 0) {
    console.log(`  Dropped by Reviewer: ${dropped.length} card(s) -- ${dropped.map((r) => r.cardTitle).join(", ")}`);
  }
  if (downgraded.length > 0) {
    console.log(`  Confidence downgraded: ${downgraded.length} card(s) -- ${downgraded.map((r) => r.cardTitle).join(", ")}`);
  }
  console.log("");
  report.cards.forEach((card: OpportunityCard, i: number) => {
    const marker = card.nextAction === "build_this" ? " <-- Best next experiment" : "";
    console.log(`${i + 1}. [${card.nextAction}]${marker} ${card.title}`);
    console.log(`   Impact: ${card.expectedImpact.level} | Effort: ${card.effort.level} | Confidence: ${card.confidence.level} | rank_score: ${card.rankScore?.toFixed(2)}`);
    console.log(`   Hypothesis: ${card.hypothesis}`);
    console.log(`   Missing evidence: ${card.missingEvidence}`);
    console.log("");
  });
  if (outPath) {
    console.log(`Full report + review records written to ${outPath}`);
  }
}

program.parseAsync(process.argv);
