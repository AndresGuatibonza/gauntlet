import { describe, it, expect } from "vitest";
import {
  attachAiEvidence,
  buildAiEvidence,
  readTokenProfiler,
  TokenProfilerError,
  TOKEN_PROFILER_MIN_COMPARABLE_SAMPLES,
  type JsonGetter,
  type TokenProfilerSnapshot,
  type TpEvent,
} from "../src/token-profiler-adapter.js";
import { EvidencePacketSchema, hasInsufficientEvidence, citableEvidenceIds } from "../src/evidence-packet.js";
import { fakeEvidencePacket } from "./fixtures.js";

const BASE = "http://localhost:4317";
const PULLED_AT = "2026-10-01T12:00:00.000Z";

function event(overrides: Partial<TpEvent> & { sessionId: string }): TpEvent {
  return {
    invocationId: `${overrides.sessionId}-${Math.random().toString(36).slice(2, 8)}`,
    connector: "otel",
    provider: "anthropic",
    actualModel: "claude-sonnet-5",
    occurredAt: "2026-09-20T10:00:00.000Z",
    status: "success",
    normalizedUsage: { inputTokensTotal: 1000, generatedTokensTotal: 200, totalTokens: 1200 },
    usageProvenance: { inputTokensTotal: "reported", generatedTokensTotal: "reported", totalTokens: "derived_exact" },
    ...overrides,
  };
}

function session(id: string, firstOccurredAt: string, connector = "otel") {
  return {
    sessionId: id,
    firstOccurredAt,
    lastOccurredAt: firstOccurredAt,
    invocationCount: 1,
    connectors: [connector],
    providers: ["anthropic"],
    models: ["claude-sonnet-5"],
    inputTokensTotal: 1000,
    generatedTokensTotal: 200,
    totalTokens: 1200,
    failureCount: 0,
  };
}

/** A fake Token Profiler API: routes -> JSON, records every URL requested. */
function fakeApi(routes: Record<string, unknown>) {
  const requested: string[] = [];
  const get: JsonGetter = async (url) => {
    requested.push(url);
    if (!(url in routes)) throw new TokenProfilerError(`Token Profiler returned HTTP 404 for ${url}.`);
    const value = routes[url];
    if (value instanceof Error) throw value;
    return value;
  };
  return { get, requested };
}

function sessionRoutes(id: string, events: TpEvent[], flags: unknown[] = [], ctx: unknown = null) {
  return {
    [`${BASE}/api/sessions/${id}/events`]: events,
    [`${BASE}/api/sessions/${id}/flags`]: flags,
    [`${BASE}/api/sessions/${id}/context-analysis`]: ctx,
  };
}

const QUERY = { baseUrl: BASE, connectors: ["otel"], since: "2026-09-01T00:00:00.000Z", until: "2026-09-30T23:59:59.999Z" };

describe("readTokenProfiler", () => {
  it("reads only the requested connector and only sessions that started inside the window", async () => {
    const { get, requested } = fakeApi({
      [`${BASE}/api/sessions?connector=otel`]: [
        session("in-1", "2026-09-10T00:00:00.000Z"),
        session("in-2", "2026-09-29T00:00:00.000Z"),
        session("before", "2026-08-31T23:59:59.000Z"),
        session("after", "2026-10-01T00:00:00.000Z"),
      ],
      ...sessionRoutes("in-1", [event({ sessionId: "in-1" })]),
      ...sessionRoutes("in-2", [event({ sessionId: "in-2" })]),
    });
    const snap = await readTokenProfiler(QUERY, get, () => PULLED_AT);
    expect(snap.sessions.map((s) => s.summary.sessionId)).toEqual(["in-2", "in-1"]); // newest first
    expect(requested.some((u) => u.includes("/before/") || u.includes("/after/"))).toBe(false);
    expect(snap.storedSessionsByConnector).toEqual({ otel: 4 });
    expect(snap.pulledAt).toBe(PULLED_AT);
  });

  it("lists every connector when none is given", async () => {
    const { get, requested } = fakeApi({
      [`${BASE}/api/sessions`]: [session("s1", "2026-09-10T00:00:00.000Z")],
      ...sessionRoutes("s1", [event({ sessionId: "s1" })]),
    });
    await readTokenProfiler({ ...QUERY, connectors: [] }, get);
    expect(requested[0]).toBe(`${BASE}/api/sessions`);
  });

  it("fails clearly, naming the URL and how to start it, when Token Profiler can't be reached", async () => {
    const get: JsonGetter = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:4317") });
    };
    const err = await readTokenProfiler(QUERY, get).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenProfilerError);
    expect((err as Error).message).toContain(BASE);
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect((err as Error).message).toContain("token-profiler open");
  });

  it("rejects a response that isn't Token Profiler's shape instead of coercing it", async () => {
    const { get } = fakeApi({ [`${BASE}/api/sessions?connector=otel`]: { hello: "world" } });
    await expect(readTokenProfiler(QUERY, get)).rejects.toThrow(/responded, but not as a Token Profiler dashboard\. Unexpected response/);
  });

  it("reports an HTTP error status as the wrong URL, not as Token Profiler being down", async () => {
    const { get } = fakeApi({});
    const err = (await readTokenProfiler(QUERY, get).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("HTTP 404");
    expect(err.message).toContain("Check the --token-profiler URL");
    expect(err.message).not.toContain("Is it running");
    expect(err.message).not.toContain("..");
  });

  it("refuses to continue when no session matches, so empty AI evidence can never read as 'no problems'", async () => {
    const { get } = fakeApi({ [`${BASE}/api/sessions?connector=otel`]: [session("old", "2026-01-01T00:00:00.000Z")] });
    await expect(readTokenProfiler(QUERY, get)).rejects.toThrow(/No Token Profiler sessions from connector\(s\) otel/);
  });

  it("excludes a session whose detail can't be read, and records why", async () => {
    const { get } = fakeApi({
      [`${BASE}/api/sessions?connector=otel`]: [session("ok", "2026-09-10T00:00:00.000Z"), session("broken", "2026-09-11T00:00:00.000Z")],
      ...sessionRoutes("ok", [event({ sessionId: "ok" })]),
      [`${BASE}/api/sessions/broken/events`]: [event({ sessionId: "broken" })],
      // flags and context-analysis for "broken" are missing -> 404
    });
    const snap = await readTokenProfiler(QUERY, get);
    expect(snap.sessions.map((s) => s.summary.sessionId)).toEqual(["ok"]);
    expect(snap.skippedSessions).toEqual([{ sessionId: "broken", reason: expect.stringContaining("404") }]);
    expect(buildAiEvidence(snap).notEvaluable.join(" ")).toContain("Session broken excluded");
  });

  it("fails when every matching session is unreadable", async () => {
    const { get } = fakeApi({ [`${BASE}/api/sessions?connector=otel`]: [session("broken", "2026-09-11T00:00:00.000Z")] });
    await expect(readTokenProfiler(QUERY, get)).rejects.toThrow(/could not read any of them/);
  });
});

function snapshot(sessions: TokenProfilerSnapshot["sessions"], overrides: Partial<TokenProfilerSnapshot> = {}): TokenProfilerSnapshot {
  return {
    query: QUERY,
    pulledAt: PULLED_AT,
    sessions,
    storedSessionsByConnector: { otel: 50 },
    skippedSessions: [],
    truncatedSessionCount: 0,
    ...overrides,
  };
}

function sessionData(id: string, events: TpEvent[], flags: TokenProfilerSnapshot["sessions"][number]["flags"] = [], contextAnalysis: TokenProfilerSnapshot["sessions"][number]["contextAnalysis"] = null) {
  return { summary: session(id, "2026-09-10T00:00:00.000Z"), events, flags, contextAnalysis };
}

describe("buildAiEvidence", () => {
  const flag = (name: string, observedValue: number, threshold = 0.7) => ({
    flag: name,
    scope: "session" as const,
    observedValue,
    threshold,
    detail: `${name} detail ${observedValue}`,
  });

  const snap = snapshot([
    sessionData(
      "s1",
      [
        event({ sessionId: "s1" }),
        event({ sessionId: "s1", actualModel: "claude-haiku-4-5", normalizedUsage: { inputTokensTotal: 300, generatedTokensTotal: 100, totalTokens: 400 } }),
        event({ sessionId: "s1", status: "failure", normalizedUsage: { inputTokensTotal: 50, generatedTokensTotal: 0, totalTokens: 50 } }),
      ],
      [flag("CONTEXT_REPEAT", 0.8), flag("INPUT_BLOAT", 9000, 5000)],
      {
        totalContextTokens: 1000,
        repeatedContextTokens: 750,
        topRepeatedComponents: [
          { componentType: "system_prompt", totalTokens: 600, componentHash: "SECRET-HASH", occurrenceCount: 4 } as never,
          { componentType: "tool_schema", totalTokens: 150, occurrenceCount: 3 },
          { componentType: "current_request", totalTokens: 90, occurrenceCount: 1 },
        ],
      },
    ),
    sessionData("s2", [event({ sessionId: "s2", status: "cancelled", normalizedUsage: { inputTokensTotal: 10, generatedTokensTotal: 0 } })], [flag("CONTEXT_REPEAT", 0.9)]),
  ]);

  it("produces items in contract order with sequential A* ids", () => {
    const ai = buildAiEvidence(snap);
    expect(ai.items.map((i) => [i.id, i.evidenceType])).toEqual([
      ["A1", "usage_profile"],
      ["A2", "failure_rate"],
      ["A3", "anomaly_flag"], // CONTEXT_REPEAT (alphabetical)
      ["A4", "anomaly_flag"], // INPUT_BLOAT
      ["A5", "context_repetition"],
    ]);
    expect(ai.source).toEqual({
      system: "token_profiler",
      connectors: ["otel"],
      window: { from: QUERY.since, to: QUERY.until },
      sessionCount: 2,
      invocationCount: 4,
      pulledAt: PULLED_AT,
    });
  });

  it("computes usage, per-model split and failures from the reported numbers only", () => {
    const [usage, failures] = buildAiEvidence(snap).items;
    const u = JSON.parse(usage!.rawExcerpt);
    // 1200 + 400 + 50 + (10 + 0 derived, since totalTokens is missing) = 1660
    expect(u.totalTokens).toBe(1660);
    expect(u.byModel["anthropic/claude-sonnet-5"].total).toBe(1260);
    expect(u.byModel["anthropic/claude-haiku-4-5"].total).toBe(400);
    expect(usage!.observation).toContain("2 session(s) with 4 model invocation(s) used 1660 tokens");
    const f = JSON.parse(failures!.rawExcerpt);
    expect(f).toEqual({ invocations: 4, failed: 1, cancelled: 1, failedTokens: 60 });
    expect(failures!.observation).toContain("2 of 4 model invocations (50.0%) did not succeed");
  });

  it("groups each fired flag across sessions", () => {
    const repeat = buildAiEvidence(snap).items[2]!;
    expect(JSON.parse(repeat.rawExcerpt)).toEqual({
      flag: "CONTEXT_REPEAT",
      sessionsAffected: 2,
      sessionsEvaluated: 2,
      occurrences: 2,
      observedMin: 0.8,
      observedMax: 0.9,
      threshold: 0.7,
      exampleSessions: ["s1", "s2"],
    });
    expect(repeat.sourceRef).toBe("token-profiler:window");
    expect(buildAiEvidence(snap).items[3]!.sourceRef).toBe("token-profiler:session/s1");
  });

  it("reports context repetition by component TYPE only -- never hashes or content", () => {
    const ctx = buildAiEvidence(snap).items[4]!;
    expect(ctx.rawExcerpt).not.toContain("SECRET-HASH");
    // Only re-sent copies count: 600 * 3/4 and 150 * 2/3; a component sent once is not repetition.
    expect(JSON.parse(ctx.rawExcerpt).resentTokensByComponentType).toEqual({ system_prompt: 450, tool_schema: 100 });
    expect(ctx.observation).toContain("75.0% of attributed context tokens");
    expect(ctx.confidence).toBe("medium");
  });

  it("marks usage-based items medium confidence when any token figure isn't provider-reported", () => {
    const approx = snapshot([
      sessionData("s1", [event({ sessionId: "s1", usageProvenance: { inputTokensTotal: "derived_approximate", generatedTokensTotal: "reported" } })]),
    ]);
    expect(buildAiEvidence(approx).items[0]!.confidence).toBe("medium");
    expect(buildAiEvidence(snap).items[0]!.confidence).toBe("high");
  });

  it("names checks that could not run instead of implying they found nothing", () => {
    const thin = snapshot([sessionData("s1", [event({ sessionId: "s1" })])], { storedSessionsByConnector: { otel: 5 } });
    const notes = buildAiEvidence(thin).notEvaluable.join("\n");
    expect(notes).toContain(`SESSION_OUTLIER: needs at least ${TOKEN_PROFILER_MIN_COMPARABLE_SAMPLES} other sessions per connector; not evaluable for otel (5 stored session(s))`);
    expect(notes).toContain("INPUT_BLOAT: needs at least 20 comparable invocations per model; may not have been evaluated");
    expect(notes).toContain("REASONING_HEAVY: no invocation reports reasoning tokens");
    expect(notes).toContain("RETRY_HEAVY: no invocation reports an attempt number");
    expect(notes).toContain("CONTEXT_REPEAT and context_repetition: no invocation reports context components");
    expect(notes).toContain('SCHEMA_BLOAT: no invocation reports a "tool_schema" context component');
  });

  it("does not list a check as not evaluable when its flag fired or its inputs exist", () => {
    const rich = snapshot([
      sessionData(
        "s1",
        Array.from({ length: 30 }, () =>
          event({
            sessionId: "s1",
            attempt: 1,
            normalizedUsage: { inputTokensTotal: 1, generatedTokensTotal: 1, reasoningTokens: 1 },
            contextComponents: [
              { componentType: "conversation_history", tokenCount: 1 },
              { componentType: "tool_schema", tokenCount: 1 },
            ],
          }),
        ),
        [flag("SESSION_OUTLIER", 9, 1)],
      ),
    ]);
    expect(buildAiEvidence(rich).notEvaluable).toEqual([]);
  });

  it("reports truncation", () => {
    const truncated = snapshot([sessionData("s1", [event({ sessionId: "s1" })])], { truncatedSessionCount: 7 });
    expect(buildAiEvidence(truncated).notEvaluable.join(" ")).toContain("7 older one(s) were left out");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildAiEvidence(snap))).toBe(JSON.stringify(buildAiEvidence(snap)));
  });
});

describe("attachAiEvidence + the packet contract", () => {
  const ai = buildAiEvidence(
    snapshot([sessionData("s1", [event({ sessionId: "s1" })])], { storedSessionsByConnector: { otel: 2 } }),
  );

  it("returns a new valid packet and leaves the public-scan packet untouched", () => {
    const original = fakeEvidencePacket();
    const before = JSON.stringify(original);
    const enriched = attachAiEvidence(original, ai);
    expect(JSON.stringify(original)).toBe(before);
    expect(EvidencePacketSchema.safeParse(enriched).success).toBe(true);
    expect(enriched.confidenceMetadata.sourceReliability).toBe("public_scan_plus_ai_traces");
    expect(enriched.confidenceMetadata.missingEvidenceSummary).toContain("AI evidence (Token Profiler) covers 1 session(s)");
    expect(enriched.confidenceMetadata.missingEvidenceSummary).toContain("SESSION_OUTLIER");
    expect(citableEvidenceIds(enriched)).toEqual(["E1", "E2", "A1", "A2"]);
  });

  it("refuses to enrich a packet that already has AI evidence", () => {
    expect(() => attachAiEvidence(attachAiEvidence(fakeEvidencePacket(), ai), ai)).toThrow(/already has AI evidence/);
  });

  it("schema: reliability must match whether AI evidence is present", () => {
    const enriched = attachAiEvidence(fakeEvidencePacket(), ai);
    const lying = { ...enriched, confidenceMetadata: { ...enriched.confidenceMetadata, sourceReliability: "public_scan_only" } };
    expect(EvidencePacketSchema.safeParse(lying).success).toBe(false);
    const claiming = fakeEvidencePacket({
      confidenceMetadata: { ...fakeEvidencePacket().confidenceMetadata, sourceReliability: "public_scan_plus_ai_traces" },
    });
    expect(EvidencePacketSchema.safeParse(claiming).success).toBe(false);
    expect(EvidencePacketSchema.safeParse(fakeEvidencePacket()).success).toBe(true); // existing packets stay valid
  });

  it("schema: rejects AI ids that aren't A1, A2... and duplicate ids", () => {
    const enriched = attachAiEvidence(fakeEvidencePacket(), ai);
    const badId = structuredClone(enriched);
    (badId.aiEvidence as typeof ai).items[0]!.id = "E1";
    expect(EvidencePacketSchema.safeParse(badId).success).toBe(false);
    const dup = structuredClone(enriched);
    (dup.aiEvidence as typeof ai).items[1]!.id = "A1";
    expect(EvidencePacketSchema.safeParse(dup).success).toBe(false);
  });

  it("zero-evidence guard counts AI evidence as citable", () => {
    const noScanEvidence = fakeEvidencePacket({ observedEvidence: [] });
    expect(hasInsufficientEvidence(noScanEvidence)).toBe(true);
    expect(hasInsufficientEvidence(attachAiEvidence(noScanEvidence, ai))).toBe(false);
  });
});
