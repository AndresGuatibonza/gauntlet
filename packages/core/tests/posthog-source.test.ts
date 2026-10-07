import { describe, it, expect, vi } from "vitest";
import { BehaviorSourceError, buildBehaviorEvidence, createPostHogSource, normalizePostHogHost } from "../src/index.js";

const KEY = "phx_test_key_0123456789";
const HOST = "https://us.posthog.com";
const BASE = `${HOST}/api/projects/12345`;
const QUERY = {
  from: "2026-09-07T00:00:00.000Z",
  to: "2026-10-07T00:00:00.000Z",
  funnels: [{ name: "activation", steps: ["$pageview", "signed_up"] }],
};

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, init: init ?? {}, body });
    const { status = 200, body: out } = handler(url, init ?? {});
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function queryName(init: RequestInit): string {
  return (JSON.parse(String(init.body)) as { name: string }).name;
}

/** A PostHog that answers everything Gauntlet asks. */
const healthy: Handler = (url, init) => {
  if (url === `${BASE}/query/`) {
    switch (queryName(init)) {
      case "gauntlet_event_totals":
        return { body: { results: [[48210, 31]], columns: ["events", "names"] } };
      case "gauntlet_top_events":
        return { body: { results: [["$pageview", 30000], ["signed_up", 900]] } };
      case "gauntlet_funnel":
        return {
          body: {
            results: [
              { action_id: "signed_up", name: "signed_up", order: 1, count: 640, median_conversion_time: 300, people: ["should-be-ignored"] },
              { action_id: "$pageview", name: "$pageview", order: 0, count: 8000, median_conversion_time: null, people: [] },
            ],
          },
        };
    }
  }
  if (url.startsWith(`${BASE}/experiments/`)) {
    return {
      body: {
        next: null,
        results: [
          { name: "Hero price", feature_flag_key: "hero_price", start_date: "2026-09-20T00:00:00Z", end_date: null, archived: false },
          { name: "Draft", feature_flag_key: "d", start_date: null, end_date: null, archived: false },
          { name: "Archived", feature_flag_key: "x", start_date: "2026-01-01T00:00:00Z", end_date: null, archived: true },
        ],
      },
    };
  }
  if (url.startsWith(`${BASE}/feature_flags/`)) {
    return {
      body: {
        next: null,
        results: [
          { key: "hero_price", active: true, deleted: false, filters: { groups: [{ properties: [], rollout_percentage: 50 }], multivariate: { variants: [{ key: "control" }, { key: "test" }] } } },
          { key: "targeted", active: true, deleted: false, filters: { groups: [{ properties: [{ key: "email" }], rollout_percentage: 100 }] } },
          { key: "gone", active: false, deleted: true, filters: {} },
        ],
      },
    };
  }
  return { status: 404, body: { detail: "Not found" } };
};

describe("createPostHogSource", () => {
  it("reads totals, top events, funnels and inventories, authenticated, with no person data", async () => {
    const { impl, calls } = fakeFetch(healthy);
    const source = createPostHogSource({ host: `${HOST}/`, projectId: "12345", apiKey: KEY, fetchImpl: impl, now: () => "2026-10-07T12:00:00.000Z" });
    const snap = await source.read(QUERY);

    expect(snap).toMatchObject({
      system: "posthog",
      host: HOST,
      project: "12345",
      eventCount: 48210,
      distinctEventCount: 31,
      topEvents: [
        { event: "$pageview", count: 30000 },
        { event: "signed_up", count: 900 },
      ],
      funnels: [
        {
          name: "activation",
          windowDays: 14,
          steps: [
            { event: "$pageview", count: 8000, medianSecondsFromPrevious: null },
            { event: "signed_up", count: 640, medianSecondsFromPrevious: 300 },
          ],
        },
      ],
      experiments: [
        { name: "Hero price", flagKey: "hero_price", status: "running" },
        { name: "Draft", flagKey: "d", status: "draft" },
      ],
      flags: [
        { key: "hero_price", active: true, rolloutPercentage: 50, variants: ["control", "test"] },
        { key: "targeted", active: true, rolloutPercentage: null, variants: [] },
      ],
      notes: [],
    });

    // Every request carries the key as a Bearer token, to the configured host only.
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${KEY}`);
      expect(new URL(c.url).origin).toBe(HOST);
    }
    const [totals, top, funnel] = calls.filter((c) => c.url === `${BASE}/query/`).map((c) => c.body!);
    expect((totals!["query"] as { query: string }).query).toBe(
      "SELECT count() AS events, uniq(event) AS names FROM events WHERE timestamp >= toDateTime('2026-09-07 00:00:00') AND timestamp < toDateTime('2026-10-07 00:00:00')",
    );
    expect((top!["query"] as { query: string }).query).toContain("GROUP BY event ORDER BY c DESC LIMIT 25");
    expect(funnel!["query"]).toEqual({
      kind: "FunnelsQuery",
      dateRange: { date_from: QUERY.from, date_to: QUERY.to, explicitDate: true },
      series: [
        { kind: "EventsNode", event: "$pageview" },
        { kind: "EventsNode", event: "signed_up" },
      ],
      funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: "day" },
    });
    // Nothing in any request asks for persons, distinct ids or properties.
    expect(JSON.stringify(calls.map((c) => [c.url, c.body]))).not.toMatch(/person|distinct_id|properties\.|recording/i);
    expect(JSON.stringify(snap)).not.toContain("should-be-ignored");

    // And it maps cleanly.
    expect(buildBehaviorEvidence(snap).items).toHaveLength(4);
  });

  it("treats a missing optional permission as not evaluable, not as a failure", async () => {
    const { impl } = fakeFetch((url, init) => (url.includes("/experiments/") || url.includes("/feature_flags/") ? { status: 403, body: {} } : healthy(url, init)));
    const snap = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: impl }).read(QUERY);
    expect(snap.experiments).toBeNull();
    expect(snap.flags).toBeNull();
    expect(buildBehaviorEvidence(snap).notEvaluable).toContain("Experiments could not be listed (missing permission), so running experiments are unknown.");
  });

  it("follows pagination on the same host, bounds it, and refuses a link to another host", async () => {
    let page = 0;
    const { impl } = fakeFetch((url, init) => {
      if (url.includes("/feature_flags/")) {
        page += 1;
        return { body: { next: `${BASE}/feature_flags/?limit=100&offset=${page * 100}`, results: [{ key: `f${page}`, active: true, filters: {} }] } };
      }
      return healthy(url, init);
    });
    const snap = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: impl }).read(QUERY);
    expect(snap.flags).toHaveLength(5);
    expect(snap.notes).toEqual(["Only the first 500 feature flags were read."]);

    const leaked = fakeFetch((url, init) =>
      url.includes("/experiments/") ? { body: { next: "https://evil.example/steal", results: [] } } : healthy(url, init),
    );
    const err = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: leaked.impl }).read(QUERY).catch((e) => e);
    expect(err).toBeInstanceOf(BehaviorSourceError);
    expect(err.message).toContain("another host");
    expect(leaked.calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("maps HTTP failures to typed errors, never echoing the key", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "failed"],
    ] as const) {
      const { impl } = fakeFetch(() => ({ status, body: { detail: "x" } }));
      const err = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: impl }).read(QUERY).catch((e) => e);
      expect(err).toBeInstanceOf(BehaviorSourceError);
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain(KEY);
    }
  });

  it("rejects responses that don't look like PostHog's", async () => {
    const cases: Handler[] = [
      () => ({ body: "<html>" }),
      () => ({ body: { results: "nope" } }),
      (url, init) => (queryName(init) === "gauntlet_funnel" ? { body: { results: [{ order: 0, count: 5 }] } } : healthy(url, init)),
      (url, init) => (queryName(init) === "gauntlet_event_totals" ? { body: { results: [["many", "names"]] } } : healthy(url, init)),
    ];
    for (const handler of cases) {
      const { impl } = fakeFetch(handler);
      const err = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: impl }).read(QUERY).catch((e) => e);
      expect(err).toBeInstanceOf(BehaviorSourceError);
      expect(err.kind).toBe("invalid_response");
    }
  });

  it("reports a network failure or timeout plainly", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: down }).read(QUERY).catch((e) => e);
    expect(err.message).toBe("PostHog could not be reached while reading event totals (network error).");

    const slow = ((_: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const late = await createPostHogSource({ host: HOST, projectId: "12345", apiKey: KEY, fetchImpl: slow, timeoutMs: 20 }).read(QUERY).catch((e) => e);
    expect(late.message).toContain("timed out");
  });

  it("validates its configuration and the query before any request", async () => {
    const { impl, calls } = fakeFetch(healthy);
    expect(() => createPostHogSource({ host: "http://posthog.example.com", projectId: "1", apiKey: KEY, fetchImpl: impl })).toThrow(/https/);
    expect(() => createPostHogSource({ host: HOST, projectId: "abc", apiKey: KEY, fetchImpl: impl })).toThrow(/project id/);
    expect(() => createPostHogSource({ host: HOST, projectId: "1", apiKey: "", fetchImpl: impl })).toThrow(/API key/);
    await expect(createPostHogSource({ host: HOST, projectId: "1", apiKey: KEY, fetchImpl: impl }).read({ ...QUERY, to: QUERY.from })).rejects.toThrow(BehaviorSourceError);
    expect(calls).toHaveLength(0);
    expect(normalizePostHogHost("http://localhost:8000/")).toBe("http://localhost:8000");
    expect(normalizePostHogHost("https://eu.posthog.com/project/1")).toBe("https://eu.posthog.com");
    expect(() => normalizePostHogHost("https://user:pass@us.posthog.com")).toThrow(/credentials/);
  });
});
