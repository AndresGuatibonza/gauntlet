/**
 * GauntletTokenProfilerAdapter (evidence contract Amendment 1, §1.6).
 *
 * Reads a LOCAL Token Profiler through its HTTP API, read-only, and maps
 * what it finds into the Evidence Packet's `aiEvidence`. The Token Profiler
 * v3 architecture keeps the two domain models separate on purpose ("a
 * Gauntlet-specific adapter translates profiler output into Gauntlet's own
 * Evidence Packet model"), so everything Token-Profiler-shaped stays in this
 * file and nothing in Token Profiler changes.
 *
 * Two halves, kept apart so the mapping is testable without a server:
 *   1. readTokenProfiler(): HTTP. Validates every response with zod -- a
 *      payload that doesn't look like Token Profiler's is an error, never
 *      silently coerced.
 *   2. buildAiEvidence(): pure and deterministic. No LLM, no estimation:
 *      only sums, counts and ratios of what Token Profiler reported.
 *
 * Privacy: Token Profiler never captures prompt/response content, and this
 * adapter forwards only aggregates, flag values and component TYPES with
 * token counts (never component hashes or content).
 *
 * Only the Gauntlet CLI calls this. Token Profiler is local-only (no auth),
 * so the hosted web app cannot and must not read it (PRD §8.6).
 */
import { z } from "zod";
import {
  type AiEvidenceItem,
  type EvidencePacket,
  type PopulatedAiEvidence,
  isPopulatedAiEvidence,
} from "./evidence-packet.js";

export class TokenProfilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenProfilerError";
  }
}

// ---------------------------------------------------------------------------
// Token Profiler API shapes (only the fields this adapter reads; extra
// fields are ignored so a newer Token Profiler doesn't break the adapter).
// ---------------------------------------------------------------------------
const TpSessionSummarySchema = z.object({
  sessionId: z.string(),
  firstOccurredAt: z.string(),
  lastOccurredAt: z.string(),
  invocationCount: z.number(),
  connectors: z.array(z.string()),
});
export type TpSessionSummary = z.infer<typeof TpSessionSummarySchema>;

const MeasurementSourceSchema = z.enum(["reported", "derived_exact", "locally_counted", "derived_approximate", "unavailable"]);

const TpEventSchema = z.object({
  invocationId: z.string(),
  sessionId: z.string(),
  connector: z.string(),
  provider: z.string(),
  actualModel: z.string(),
  occurredAt: z.string(),
  status: z.enum(["success", "failure", "cancelled"]),
  attempt: z.number().optional(),
  normalizedUsage: z.object({
    inputTokensTotal: z.number().optional(),
    generatedTokensTotal: z.number().optional(),
    reasoningTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }),
  usageProvenance: z
    .object({
      inputTokensTotal: MeasurementSourceSchema.optional(),
      generatedTokensTotal: MeasurementSourceSchema.optional(),
      totalTokens: MeasurementSourceSchema.optional(),
    })
    .default({}),
  contextComponents: z.array(z.object({ componentType: z.string(), tokenCount: z.number().optional() })).optional(),
});
export type TpEvent = z.infer<typeof TpEventSchema>;

const TpFlagSchema = z.object({
  flag: z.string(),
  scope: z.enum(["session", "invocation"]),
  invocationId: z.string().optional(),
  observedValue: z.number(),
  threshold: z.number(),
  detail: z.string(),
});
export type TpFlag = z.infer<typeof TpFlagSchema>;

const TpContextAnalysisSchema = z
  .object({
    totalContextTokens: z.number(),
    repeatedContextTokens: z.number(),
    // Token Profiler's top components by totalTokens (= tokenCount x occurrenceCount),
    // which can include components sent only once. Hashes are not read.
    topRepeatedComponents: z.array(z.object({ componentType: z.string(), totalTokens: z.number(), occurrenceCount: z.number() })),
  })
  .nullable();
export type TpContextAnalysis = z.infer<typeof TpContextAnalysisSchema>;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** GET a URL and return parsed JSON. Injectable so tests need no server. */
export type JsonGetter = (url: string) => Promise<unknown>;

const REQUEST_TIMEOUT_MS = 10_000;

export const fetchJson: JsonGetter = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new TokenProfilerError(`Token Profiler returned HTTP ${res.status} for ${url}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Upper bound on sessions read in one run (3 requests each). The most recent
 * sessions in the window are kept; the cut is reported in notEvaluable.
 */
export const MAX_SESSIONS = 500;

export interface TokenProfilerQuery {
  /** Token Profiler base URL, e.g. http://localhost:4317 */
  baseUrl: string;
  /** Connectors to include. Empty = every connector. */
  connectors: string[];
  /** Window, inclusive, ISO 8601. A session is included when it STARTED inside it. */
  since: string;
  until: string;
}

export interface TokenProfilerSessionData {
  summary: TpSessionSummary;
  events: TpEvent[];
  flags: TpFlag[];
  contextAnalysis: TpContextAnalysis;
}

export interface TokenProfilerSnapshot {
  query: TokenProfilerQuery;
  pulledAt: string;
  sessions: TokenProfilerSessionData[];
  /** Per-connector count of ALL stored sessions (Token Profiler's SESSION_OUTLIER comparison base). */
  storedSessionsByConnector: Record<string, number>;
  /** Sessions that matched but whose detail could not be read, with the reason. */
  skippedSessions: Array<{ sessionId: string; reason: string }>;
  /** Sessions that matched but were left out by MAX_SESSIONS. */
  truncatedSessionCount: number;
}

function describeFetchFailure(err: unknown): string {
  if (err instanceof TokenProfilerError) return err.message;
  if (err instanceof Error && err.name === "AbortError") return `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `${err instanceof Error ? err.message : String(err)}${cause}`;
}

async function getValidated<S extends z.ZodTypeAny>(get: JsonGetter, url: string, schema: S, what: string): Promise<z.output<S>> {
  const body = await get(url);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new TokenProfilerError(
      `Unexpected response from Token Profiler ${what} (${url}): ${parsed.error.issues[0]?.message ?? "invalid shape"}. Is this URL a Token Profiler dashboard?`,
    );
  }
  return parsed.data;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Reads everything the adapter needs for the query window. Fails loudly when
 * Token Profiler can't be reached or no session matches -- the CLI must
 * never continue with empty AI evidence that could read as "no problems".
 */
export async function readTokenProfiler(
  query: TokenProfilerQuery,
  get: JsonGetter = fetchJson,
  now: () => string = () => new Date().toISOString(),
): Promise<TokenProfilerSnapshot> {
  const base = trimSlash(query.baseUrl);
  const sessionsSchema = z.array(TpSessionSummarySchema);

  // Store-wide session lists per connector: both the candidates for the
  // window and the comparison base Token Profiler uses for SESSION_OUTLIER.
  const connectorsToList = query.connectors.length > 0 ? query.connectors : [undefined];
  const byId = new Map<string, TpSessionSummary>();
  const storedSessionsByConnector: Record<string, number> = {};
  for (const connector of connectorsToList) {
    const url = connector === undefined ? `${base}/api/sessions` : `${base}/api/sessions?connector=${encodeURIComponent(connector)}`;
    let list: TpSessionSummary[];
    try {
      list = await getValidated(get, url, sessionsSchema, "/api/sessions");
    } catch (err) {
      if (err instanceof TokenProfilerError) {
        // Something answered at this URL, but not as Token Profiler's API
        // (an HTTP error status or an unexpected body).
        throw new TokenProfilerError(
          `${base} responded, but not as a Token Profiler dashboard. ${err.message} Check the --token-profiler URL (the dashboard prints it on \`token-profiler open\`).`,
        );
      }
      throw new TokenProfilerError(
        `Could not read Token Profiler at ${base}: ${describeFetchFailure(err)}. Is it running? Start it with \`token-profiler open\`.`,
      );
    }
    for (const session of list) {
      byId.set(session.sessionId, session);
      for (const c of session.connectors) storedSessionsByConnector[c] = (storedSessionsByConnector[c] ?? 0) + 1;
    }
  }

  const since = Date.parse(query.since);
  const until = Date.parse(query.until);
  const inWindow = [...byId.values()]
    .filter((s) => {
      const started = Date.parse(s.firstOccurredAt);
      return started >= since && started <= until;
    })
    .sort((a, b) => b.firstOccurredAt.localeCompare(a.firstOccurredAt));

  if (inWindow.length === 0) {
    const which = query.connectors.length > 0 ? `connector(s) ${query.connectors.join(", ")}` : "any connector";
    throw new TokenProfilerError(
      `No Token Profiler sessions from ${which} started between ${query.since} and ${query.until}. Nothing to add as AI evidence; widen the window or check the connector names (see the dashboard's filters).`,
    );
  }

  const selected = inWindow.slice(0, MAX_SESSIONS);
  const sessions: TokenProfilerSessionData[] = [];
  const skippedSessions: TokenProfilerSnapshot["skippedSessions"] = [];
  for (const summary of selected) {
    const id = encodeURIComponent(summary.sessionId);
    try {
      const [events, flags, contextAnalysis] = await Promise.all([
        getValidated(get, `${base}/api/sessions/${id}/events`, z.array(TpEventSchema), "/events"),
        getValidated(get, `${base}/api/sessions/${id}/flags`, z.array(TpFlagSchema), "/flags"),
        getValidated(get, `${base}/api/sessions/${id}/context-analysis`, TpContextAnalysisSchema, "/context-analysis"),
      ]);
      sessions.push({ summary, events, flags, contextAnalysis });
    } catch (err) {
      skippedSessions.push({ sessionId: summary.sessionId, reason: describeFetchFailure(err) });
    }
  }

  if (sessions.length === 0) {
    throw new TokenProfilerError(
      `Found ${selected.length} matching Token Profiler session(s) but could not read any of them (first error: ${skippedSessions[0]?.reason ?? "unknown"}).`,
    );
  }

  return {
    query,
    pulledAt: now(),
    sessions,
    storedSessionsByConnector,
    skippedSessions,
    truncatedSessionCount: inWindow.length - selected.length,
  };
}

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

/**
 * Mirrors Token Profiler's own DEFAULT_THRESHOLDS.minComparableSamples
 * (src/core/deterministic-flags.ts): percentile flags cannot fire below it.
 */
export const TOKEN_PROFILER_MIN_COMPARABLE_SAMPLES = 20;

const TRUSTED_SOURCES = new Set(["reported", "derived_exact"]);
const MAX_EXAMPLE_SESSIONS = 3;
const MAX_COMPONENT_TYPES = 5;

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

/** total tokens of one invocation: reported total, else input + output when both are known. */
function eventTotal(e: TpEvent): number | undefined {
  const u = e.normalizedUsage;
  if (u.totalTokens !== undefined) return u.totalTokens;
  if (u.inputTokensTotal !== undefined && u.generatedTokensTotal !== undefined) return u.inputTokensTotal + u.generatedTokensTotal;
  return undefined;
}

/** "high" only when every token figure used came straight from the provider (or exact arithmetic on it). */
function usageConfidence(events: TpEvent[]): "high" | "medium" {
  for (const e of events) {
    for (const field of ["inputTokensTotal", "generatedTokensTotal"] as const) {
      if (e.normalizedUsage[field] === undefined) continue;
      const source = e.usageProvenance[field];
      if (!source || !TRUSTED_SOURCES.has(source)) return "medium";
    }
  }
  return "high";
}

function windowOf(snapshot: TokenProfilerSnapshot): { from: string; to: string } {
  return { from: new Date(snapshot.query.since).toISOString(), to: new Date(snapshot.query.until).toISOString() };
}

/**
 * Builds §1.6 AI evidence from a snapshot. Deterministic: the same snapshot
 * always produces the same items, ids and text.
 */
export function buildAiEvidence(snapshot: TokenProfilerSnapshot): PopulatedAiEvidence {
  const sessions = snapshot.sessions;
  const events = sessions.flatMap((s) => s.events);
  const items: Omit<AiEvidenceItem, "id">[] = [];
  const timestamp = snapshot.pulledAt;
  const confidence = usageConfidence(events);

  // 1. usage_profile
  const byModel = new Map<string, { invocations: number; input: number; output: number; total: number }>();
  let missingUsage = 0;
  for (const e of events) {
    const key = `${e.provider}/${e.actualModel}`;
    const row = byModel.get(key) ?? { invocations: 0, input: 0, output: 0, total: 0 };
    row.invocations += 1;
    row.input += e.normalizedUsage.inputTokensTotal ?? 0;
    row.output += e.normalizedUsage.generatedTokensTotal ?? 0;
    const total = eventTotal(e);
    if (total === undefined) missingUsage += 1;
    row.total += total ?? 0;
    byModel.set(key, row);
  }
  const models = [...byModel.entries()].sort((a, b) => b[1].total - a[1].total);
  const totalTokens = sum(models.map(([, r]) => r.total));
  items.push({
    sourceRef: "token-profiler:window",
    timestamp,
    evidenceType: "usage_profile",
    observation:
      `${sessions.length} session(s) with ${events.length} model invocation(s) used ${totalTokens} tokens; ` +
      models
        .slice(0, 3)
        .map(([model, r]) => `${model} accounts for ${pct(r.total, totalTokens)} of them`)
        .join(", ") +
      ".",
    rawExcerpt: JSON.stringify({
      sessions: sessions.length,
      invocations: events.length,
      totalTokens,
      invocationsWithoutUsage: missingUsage,
      byModel: Object.fromEntries(models),
    }),
    confidence,
  });

  // 2. failure_rate
  if (events.length > 0) {
    const failed = events.filter((e) => e.status !== "success");
    const failedTokens = sum(failed.map((e) => eventTotal(e) ?? 0));
    items.push({
      sourceRef: "token-profiler:window",
      timestamp,
      evidenceType: "failure_rate",
      observation: `${failed.length} of ${events.length} model invocations (${pct(failed.length, events.length)}) did not succeed, accounting for ${failedTokens} tokens.`,
      rawExcerpt: JSON.stringify({
        invocations: events.length,
        failed: failed.filter((e) => e.status === "failure").length,
        cancelled: failed.filter((e) => e.status === "cancelled").length,
        failedTokens,
      }),
      confidence,
    });
  }

  // 3. anomaly_flag, one item per flag name that fired
  const fired = new Map<string, Array<{ sessionId: string; flag: TpFlag }>>();
  for (const s of sessions) {
    for (const flag of s.flags) {
      const list = fired.get(flag.flag) ?? [];
      list.push({ sessionId: s.summary.sessionId, flag });
      fired.set(flag.flag, list);
    }
  }
  for (const [name, hits] of [...fired.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const affected = [...new Set(hits.map((h) => h.sessionId))];
    const observed = hits.map((h) => h.flag.observedValue);
    items.push({
      sourceRef: affected.length === 1 ? `token-profiler:session/${affected[0]}` : "token-profiler:window",
      timestamp,
      evidenceType: "anomaly_flag",
      observation: `${name} fired in ${affected.length} of ${sessions.length} session(s) (${hits.length} time(s)); example: ${hits[0]!.flag.detail}`,
      rawExcerpt: JSON.stringify({
        flag: name,
        sessionsAffected: affected.length,
        sessionsEvaluated: sessions.length,
        occurrences: hits.length,
        observedMin: Math.min(...observed),
        observedMax: Math.max(...observed),
        threshold: hits[0]!.flag.threshold,
        exampleSessions: affected.slice(0, MAX_EXAMPLE_SESSIONS),
      }),
      confidence,
    });
  }

  // 4. context_repetition
  const analyzed = sessions.filter((s) => s.contextAnalysis !== null);
  if (analyzed.length > 0) {
    const totalContext = sum(analyzed.map((s) => s.contextAnalysis!.totalContextTokens));
    const repeated = sum(analyzed.map((s) => s.contextAnalysis!.repeatedContextTokens));
    const byType = new Map<string, number>();
    for (const s of analyzed) {
      for (const c of s.contextAnalysis!.topRepeatedComponents) {
        // Only the re-sent copies count as repetition: (occurrences - 1) of them.
        if (c.occurrenceCount < 2) continue;
        const resent = Math.round((c.totalTokens * (c.occurrenceCount - 1)) / c.occurrenceCount);
        byType.set(c.componentType, (byType.get(c.componentType) ?? 0) + resent);
      }
    }
    const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COMPONENT_TYPES);
    items.push({
      sourceRef: "token-profiler:window",
      timestamp,
      evidenceType: "context_repetition",
      observation:
        `${pct(repeated, totalContext)} of attributed context tokens were re-sent content across ${analyzed.length} session(s)` +
        (types.length > 0 ? `; most-repeated component type: ${types[0]![0]}.` : "."),
      rawExcerpt: JSON.stringify({
        sessionsWithContextData: analyzed.length,
        totalContextTokens: totalContext,
        repeatedContextTokens: repeated,
        // Re-sent tokens per component type, from each session's top components only (not exhaustive).
        resentTokensByComponentType: Object.fromEntries(types),
      }),
      // Component token counts come from connector-side attribution, not the provider's bill.
      confidence: "medium",
    });
  }

  return {
    source: {
      system: "token_profiler",
      connectors: [...new Set(events.map((e) => e.connector))].sort(),
      window: windowOf(snapshot),
      sessionCount: sessions.length,
      invocationCount: events.length,
      pulledAt: snapshot.pulledAt,
    },
    items: items.map((item, i) => ({ id: `A${i + 1}`, ...item })),
    notEvaluable: notEvaluableChecks(snapshot, fired),
  };
}

/**
 * Names the checks that could not run (or may not have run) for this data,
 * so a flag that did not fire is never read as "no problem". Derived only
 * from what the data shows, using Token Profiler's documented preconditions.
 */
function notEvaluableChecks(snapshot: TokenProfilerSnapshot, fired: Map<string, unknown>): string[] {
  const notes: string[] = [];
  const events = snapshot.sessions.flatMap((s) => s.events);
  const min = TOKEN_PROFILER_MIN_COMPARABLE_SAMPLES;

  // SESSION_OUTLIER compares against other stored sessions of the same connector.
  if (!fired.has("SESSION_OUTLIER")) {
    const thin = Object.entries(snapshot.storedSessionsByConnector)
      .filter(([, count]) => count - 1 < min)
      .map(([connector, count]) => `${connector} (${count} stored session(s))`);
    if (thin.length > 0) {
      notes.push(`SESSION_OUTLIER: needs at least ${min} other sessions per connector; not evaluable for ${thin.join(", ")}.`);
    }
  }

  // INPUT_BLOAT / OUTPUT_BLOAT compare against other stored invocations of the
  // same provider/model. The API doesn't expose that store-wide count, so the
  // window is a lower bound: fewer than min+1 here means it MAY not have run.
  for (const flag of ["INPUT_BLOAT", "OUTPUT_BLOAT"]) {
    if (fired.has(flag)) continue;
    const perModel = new Map<string, number>();
    for (const e of events) perModel.set(`${e.provider}/${e.actualModel}`, (perModel.get(`${e.provider}/${e.actualModel}`) ?? 0) + 1);
    const thin = [...perModel.entries()].filter(([, n]) => n <= min).map(([m, n]) => `${m} (${n} in window)`);
    if (thin.length > 0) {
      notes.push(`${flag}: needs at least ${min} comparable invocations per model; may not have been evaluated for ${thin.join(", ")}.`);
    }
  }

  if (!fired.has("REASONING_HEAVY") && !events.some((e) => e.normalizedUsage.reasoningTokens !== undefined)) {
    notes.push("REASONING_HEAVY: no invocation reports reasoning tokens.");
  }
  if (!fired.has("RETRY_HEAVY") && !events.some((e) => e.attempt !== undefined)) {
    notes.push("RETRY_HEAVY: no invocation reports an attempt number.");
  }
  const componentTypes = new Set(events.flatMap((e) => (e.contextComponents ?? []).map((c) => c.componentType)));
  if (!fired.has("CONTEXT_REPEAT") && componentTypes.size === 0) {
    notes.push("CONTEXT_REPEAT and context_repetition: no invocation reports context components.");
  }
  if (!fired.has("HISTORY_BLOAT") && !componentTypes.has("conversation_history")) {
    notes.push('HISTORY_BLOAT: no invocation reports a "conversation_history" context component.');
  }
  if (!fired.has("SCHEMA_BLOAT") && !componentTypes.has("tool_schema")) {
    notes.push('SCHEMA_BLOAT: no invocation reports a "tool_schema" context component.');
  }

  for (const skipped of snapshot.skippedSessions) {
    notes.push(`Session ${skipped.sessionId} excluded: could not be read (${skipped.reason}).`);
  }
  if (snapshot.truncatedSessionCount > 0) {
    notes.push(
      `Only the ${MAX_SESSIONS} most recent matching sessions were analyzed; ${snapshot.truncatedSessionCount} older one(s) were left out.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Attaching to a packet
// ---------------------------------------------------------------------------

/**
 * Returns a NEW packet with aiEvidence populated (the public-scan packet is
 * never modified), sourceReliability raised to "public_scan_plus_ai_traces",
 * and the AI coverage limits added to missingEvidenceSummary (§1.8).
 */
export function attachAiEvidence(packet: EvidencePacket, aiEvidence: PopulatedAiEvidence): EvidencePacket {
  if (isPopulatedAiEvidence(packet.aiEvidence)) {
    throw new TokenProfilerError(
      "This Evidence Packet already has AI evidence. Run the analysis on the original public-scan packet instead.",
    );
  }
  const { source, notEvaluable } = aiEvidence;
  const coverage =
    `AI evidence (Token Profiler) covers ${source.sessionCount} session(s) and ${source.invocationCount} invocation(s) ` +
    `from connector(s) ${source.connectors.join(", ") || "none"}, sessions started ${source.window.from} to ${source.window.to}; ` +
    "it does not cover other connectors, other dates, or any prompt/response content" +
    (notEvaluable.length > 0 ? `. Checks not evaluable: ${notEvaluable.join(" ")}` : ".");
  const existing = packet.confidenceMetadata.missingEvidenceSummary.trim();
  return {
    ...packet,
    aiEvidence,
    confidenceMetadata: {
      ...packet.confidenceMetadata,
      sourceReliability: "public_scan_plus_ai_traces",
      missingEvidenceSummary: existing ? `${/[.!?]$/.test(existing) ? existing : `${existing}.`} ${coverage}` : coverage,
    },
  };
}
