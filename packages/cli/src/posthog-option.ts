/**
 * `gauntlet analyze <packetId> --posthog` (evidence contract Amendment 4,
 * draft): read the scanned product's OWN product analytics from PostHog,
 * attach them to a copy of the public-scan packet as §1.4 behaviorEvidence,
 * and save that copy as a new packet. The public-scan packet is never
 * modified.
 *
 * Credentials come from the environment only, never from a flag (flags end
 * up in shell history):
 *   POSTHOG_PERSONAL_API_KEY  personal API key, scopes query:read
 *                             (+ experiment:read, feature_flag:read optional)
 *   POSTHOG_PROJECT_ID        numeric project id
 *   POSTHOG_HOST              default https://us.posthog.com
 *
 * Kept out of index.ts so option parsing and enrichment are unit-testable
 * without spawning the CLI or calling Claude.
 */
import {
  attachBehaviorEvidence,
  BehaviorSourceError,
  buildBehaviorEvidence,
  createPostHogSource,
  EvidencePacketSchema,
  isPopulatedBehaviorEvidence,
  parseFunnelSpec,
  validateBehaviorQuery,
  type BehaviorQuery,
  type BehaviorSource,
  type EvidencePacket,
  type PopulatedBehaviorEvidence,
} from "@gauntlet/core";
import type { GauntletStore } from "./store/sqlite.js";

export const DEFAULT_PH_WINDOW_DAYS = 30;
export const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";

export interface PostHogCliOptions {
  posthog?: boolean;
  phSince?: string;
  phUntil?: string;
  phFunnel?: string[];
}

export interface PostHogRun {
  source: BehaviorSource;
  query: BehaviorQuery;
  host: string;
  projectId: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-01" -> start of that UTC day (since) or start of the next day (until, exclusive). */
function parseBound(value: string, flag: string, isUntil: boolean): Date {
  const date = DATE_ONLY.test(value)
    ? new Date(new Date(`${value}T00:00:00.000Z`).getTime() + (isUntil ? 86_400_000 : 0))
    : new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new BehaviorSourceError(`${flag} must be an ISO date (2026-09-01) or timestamp (2026-09-01T00:00:00Z); got "${value}".`, "invalid_response");
  }
  return date;
}

/**
 * Turns the flags and environment into a PostHog read, or undefined when
 * --posthog wasn't given. Every invalid combination fails here, before the
 * store is opened or Claude is called.
 */
export function resolvePostHogRun(
  opts: PostHogCliOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date(),
  fetchImpl?: typeof fetch,
): PostHogRun | undefined {
  const funnels = opts.phFunnel ?? [];
  if (!opts.posthog) {
    if (funnels.length > 0 || opts.phSince || opts.phUntil) {
      throw new BehaviorSourceError("--ph-funnel, --ph-since and --ph-until only apply together with --posthog.", "invalid_response");
    }
    return undefined;
  }
  const apiKey = env["POSTHOG_PERSONAL_API_KEY"]?.trim();
  const projectId = env["POSTHOG_PROJECT_ID"]?.trim();
  if (!apiKey || !projectId) {
    throw new BehaviorSourceError(
      "--posthog needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in the environment " +
        "(a personal API key with the query:read scope, and the numeric project id). Keys are never passed as flags.",
      "unauthorized",
    );
  }
  const until = opts.phUntil ? parseBound(opts.phUntil, "--ph-until", true) : now();
  const since = opts.phSince ? parseBound(opts.phSince, "--ph-since", false) : new Date(until.getTime() - DEFAULT_PH_WINDOW_DAYS * 86_400_000);
  const query = validateBehaviorQuery({ from: since.toISOString(), to: until.toISOString(), funnels: funnels.map(parseFunnelSpec) });
  const host = env["POSTHOG_HOST"]?.trim() || DEFAULT_POSTHOG_HOST;
  const source = createPostHogSource({ host, projectId, apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  return { source, query, host, projectId };
}

export interface BehaviorEnrichmentResult {
  packetId: number;
  packet: EvidencePacket;
  behavior: PopulatedBehaviorEvidence;
}

/**
 * Reads the analytics source, builds §1.4 behaviorEvidence, and saves the
 * enriched copy as a NEW packet linked to its source. Throws
 * BehaviorSourceError for every expected failure so the caller can stop
 * before calling Claude.
 */
export async function enrichPacketWithBehavior(
  store: GauntletStore,
  sourcePacketId: number,
  sourcePacket: EvidencePacket,
  run: Pick<PostHogRun, "source" | "query">,
): Promise<BehaviorEnrichmentResult> {
  if (isPopulatedBehaviorEvidence(sourcePacket.behaviorEvidence)) {
    const origin = store.getPacketLineage(sourcePacketId);
    throw new BehaviorSourceError(
      `Evidence Packet #${sourcePacketId} already includes behavior evidence` + (origin ? `; enrich its public-scan packet #${origin} instead.` : "."),
    );
  }
  const snapshot = await run.source.read(run.query);
  const behavior = buildBehaviorEvidence(snapshot);
  const enriched = attachBehaviorEvidence(sourcePacket, behavior);
  const parsed = EvidencePacketSchema.safeParse(enriched);
  if (!parsed.success) {
    throw new Error(`Internal error: enriched Evidence Packet failed contract validation: ${parsed.error.message}`);
  }
  const packetId = store.saveEvidencePacket(parsed.data, { derivedFromPacketId: sourcePacketId });
  return { packetId, packet: parsed.data, behavior };
}

export function printBehaviorSummary(result: BehaviorEnrichmentResult, sourcePacketId: number): void {
  const { source, items, notEvaluable } = result.behavior;
  console.log(`Enriched Evidence Packet #${result.packetId} saved (from packet #${sourcePacketId}, which is unchanged).`);
  console.log(`  Behavior evidence: ${source.system} project ${source.project}, ${source.eventCount} event(s), ${source.window.from} to ${source.window.to}`);
  for (const item of items) console.log(`    ${item.id} [${item.evidenceType}, ${item.confidence}] ${item.observation}`);
  if (notEvaluable.length > 0) {
    console.log(`  Not evaluable (${notEvaluable.length}):`);
    for (const note of notEvaluable) console.log(`    - ${note}`);
  }
  console.log("");
}
