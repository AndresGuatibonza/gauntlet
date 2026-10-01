/**
 * `gauntlet analyze <packetId> --token-profiler <url>` (evidence contract
 * Amendment 1): read the scanned product's OWN AI traces from a local Token
 * Profiler, attach them to a copy of the public-scan packet as §1.6
 * aiEvidence, and save that copy as a new packet. The public-scan packet is
 * never modified, and nothing here reaches the hosted web app (PRD §8.6).
 *
 * Kept out of index.ts so option parsing and enrichment are unit-testable
 * without spawning the CLI or calling Claude.
 */
import {
  attachAiEvidence,
  buildAiEvidence,
  EvidencePacketSchema,
  isPopulatedAiEvidence,
  readTokenProfiler,
  TokenProfilerError,
  type EvidencePacket,
  type JsonGetter,
  type PopulatedAiEvidence,
  type TokenProfilerQuery,
} from "@gauntlet/core";
import type { GauntletStore } from "./store/sqlite.js";

export const DEFAULT_TP_WINDOW_DAYS = 30;

/**
 * Connector labels Token Profiler assigns to coding agents (verified in its
 * src/connectors: otlp-claude-code-logs.ts, otlp-codex-traces.ts,
 * opencode.ts). Their sessions are a development team's own tool usage,
 * not the scanned product's AI behavior, so the contract (§1.6) excludes
 * them. Product traces arrive through `opentelemetry`, `file` or `hermes`.
 */
export const CODING_AGENT_CONNECTORS: readonly string[] = [
  "claude-code",
  "claude-code-desktop",
  "codex-cli",
  "codex-desktop",
  "opencode",
];

export interface TokenProfilerCliOptions {
  tokenProfiler?: string;
  tpConnector?: string[];
  tpSince?: string;
  tpUntil?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-01" -> start (or end) of that UTC day; full ISO timestamps pass through. */
function parseWindowBound(value: string, flag: string, endOfDay: boolean): Date {
  const iso = DATE_ONLY.test(value) ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value;
  const date = new Date(iso);
  // Reject anything Date accepts loosely but isn't ISO-8601 (e.g. "Sep 1").
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new TokenProfilerError(`${flag} must be an ISO date (2026-09-01) or timestamp (2026-09-01T00:00:00Z); got "${value}".`);
  }
  return date;
}

/**
 * Turns the CLI flags into a Token Profiler query, or returns undefined when
 * --token-profiler wasn't given (plain public-scan analysis). Every invalid
 * combination fails here, before the store is opened or Claude is called.
 */
export function resolveTokenProfilerQuery(
  opts: TokenProfilerCliOptions,
  now: () => Date = () => new Date(),
): TokenProfilerQuery | undefined {
  const connectors = opts.tpConnector ?? [];
  if (!opts.tokenProfiler) {
    if (connectors.length > 0 || opts.tpSince || opts.tpUntil) {
      throw new TokenProfilerError("--tp-connector, --tp-since and --tp-until only apply together with --token-profiler <url>.");
    }
    return undefined;
  }

  let base: URL;
  try {
    base = new URL(opts.tokenProfiler);
  } catch {
    throw new TokenProfilerError(`--token-profiler must be a URL such as http://localhost:4317; got "${opts.tokenProfiler}".`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TokenProfilerError(`--token-profiler must be an http(s) URL; got "${opts.tokenProfiler}".`);
  }

  if (connectors.length === 0) {
    throw new TokenProfilerError(
      "--token-profiler needs at least one --tp-connector naming where the product's own AI traces are stored " +
        "(e.g. --tp-connector opentelemetry). The connector list is in the Token Profiler dashboard's filters.",
    );
  }
  const codingAgents = connectors.filter((c) => CODING_AGENT_CONNECTORS.includes(c));
  if (codingAgents.length > 0) {
    throw new TokenProfilerError(
      `--tp-connector ${codingAgents.join(", ")} records coding-agent usage, not the scanned product's AI traces, ` +
        "so it can't be AI evidence for this product (evidence contract §1.6).",
    );
  }

  const until = opts.tpUntil ? parseWindowBound(opts.tpUntil, "--tp-until", true) : now();
  const since = opts.tpSince
    ? parseWindowBound(opts.tpSince, "--tp-since", false)
    : new Date(until.getTime() - DEFAULT_TP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (since.getTime() >= until.getTime()) {
    throw new TokenProfilerError(`--tp-since (${since.toISOString()}) must be before --tp-until (${until.toISOString()}).`);
  }

  return {
    baseUrl: base.toString().replace(/\/+$/, ""),
    connectors: [...new Set(connectors)].sort(),
    since: since.toISOString(),
    until: until.toISOString(),
  };
}

export interface EnrichmentResult {
  packetId: number;
  packet: EvidencePacket;
  aiEvidence: PopulatedAiEvidence;
}

/**
 * Reads Token Profiler, builds §1.6 aiEvidence, and saves the enriched copy
 * as a NEW packet linked to its source. Throws TokenProfilerError for every
 * expected failure (Token Profiler down, nothing in the window, packet
 * already enriched) so the caller can stop before calling Claude.
 */
export async function enrichPacketWithTokenProfiler(
  store: GauntletStore,
  sourcePacketId: number,
  sourcePacket: EvidencePacket,
  query: TokenProfilerQuery,
  get?: JsonGetter,
): Promise<EnrichmentResult> {
  if (isPopulatedAiEvidence(sourcePacket.aiEvidence)) {
    const origin = store.getPacketLineage(sourcePacketId);
    throw new TokenProfilerError(
      `Evidence Packet #${sourcePacketId} already includes AI evidence` +
        (origin ? `; enrich its public-scan packet #${origin} instead.` : "."),
    );
  }

  const snapshot = await readTokenProfiler(query, get);
  const aiEvidence = buildAiEvidence(snapshot);
  const enriched = attachAiEvidence(sourcePacket, aiEvidence);

  // Same guarantee as `scan`: never persist a packet the contract rejects.
  const parsed = EvidencePacketSchema.safeParse(enriched);
  if (!parsed.success) {
    throw new Error(`Internal error: enriched Evidence Packet failed contract validation: ${parsed.error.message}`);
  }

  const packetId = store.saveEvidencePacket(parsed.data, { derivedFromPacketId: sourcePacketId });
  return { packetId, packet: parsed.data, aiEvidence };
}

export function printAiEvidenceSummary(result: EnrichmentResult, sourcePacketId: number): void {
  const { source, items, notEvaluable } = result.aiEvidence;
  console.log(`Enriched Evidence Packet #${result.packetId} saved (from public-scan packet #${sourcePacketId}, which is unchanged).`);
  console.log(
    `  AI evidence: ${source.sessionCount} session(s), ${source.invocationCount} invocation(s) from ${source.connectors.join(", ")}, ` +
      `${source.window.from} to ${source.window.to}`,
  );
  for (const item of items) {
    console.log(`    ${item.id} [${item.evidenceType}, ${item.confidence}] ${item.observation}`);
  }
  if (notEvaluable.length > 0) {
    console.log(`  Not evaluable (${notEvaluable.length}):`);
    for (const note of notEvaluable) console.log(`    - ${note}`);
  }
  console.log("");
}
