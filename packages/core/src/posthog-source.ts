/**
 * PostHog behavior source (evidence contract Amendment 4, draft; PRD Build
 * Order #6, "start with one analytics source -- recommended: PostHog").
 *
 * Reads, read-only, with a personal API key scoped to:
 *   query:read         event volume (HogQL) and funnels (FunnelsQuery)
 *   experiment:read    the experiment inventory   (optional)
 *   feature_flag:read  the feature-flag inventory (optional)
 * A missing optional scope is reported in notEvaluable, never fatal.
 *
 * Minimum entities only (PRD §8 "ingest only the minimum entities"): event
 * names with counts, funnel step counts for the funnels asked for, and the
 * names, flag keys and dates of experiments and flags. Never persons,
 * distinct ids, property values or recordings: no request here asks for
 * them, and funnel responses' "people" fields are ignored.
 *
 * The key is sent only to the configured host: pagination links pointing
 * anywhere else are refused, and the key never appears in an error.
 *
 * Verified against PostHog's published API reference (2026-10-07): POST
 * /api/projects/:id/query/ (HogQLQuery, FunnelsQuery), GET
 * /api/projects/:id/experiments/, GET /api/projects/:id/feature_flags/,
 * Bearer personal API keys, 2400 query requests per hour. Not yet run
 * against a live PostHog project.
 */
import { z } from "zod";
import {
  BehaviorSourceError,
  MAX_TOP_EVENTS,
  validateBehaviorQuery,
  type BehaviorQuery,
  type BehaviorSnapshot,
  type BehaviorSource,
  type ExperimentSummary,
  type FlagSummary,
  type MeasuredFunnel,
} from "./behavior-evidence.js";

export interface PostHogSourceOptions {
  /** App host, e.g. https://us.posthog.com, https://eu.posthog.com or a self-hosted URL. */
  host: string;
  /** Numeric project id (Project settings -> Project ID). */
  projectId: string;
  /** Personal API key (phx_...). */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 5;
const PAGE_SIZE = 100;

/** Validates and normalizes the host: https (http only for localhost), no path, no credentials. */
export function normalizePostHogHost(host: string): string {
  let url: URL;
  try {
    url = new URL(host.trim());
  } catch {
    throw new BehaviorSourceError(`"${host}" is not a valid PostHog host URL.`, "invalid_response");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new BehaviorSourceError("The PostHog host must use https.", "invalid_response");
  }
  if (url.username || url.password) throw new BehaviorSourceError("The PostHog host must not contain credentials.", "invalid_response");
  return url.origin;
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields read; extra fields are ignored)
// ---------------------------------------------------------------------------

const HogQLResponseSchema = z.object({ results: z.array(z.array(z.unknown())) });

const FunnelStepSchema = z.object({
  name: z.string().nullish(),
  action_id: z.union([z.string(), z.number()]).nullish(),
  order: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  median_conversion_time: z.number().nonnegative().nullish(),
});
const FunnelResponseSchema = z.object({
  // A funnel without breakdown returns the steps; some versions wrap them once more.
  results: z.union([z.array(FunnelStepSchema), z.array(z.array(FunnelStepSchema))]),
});

const PageSchema = <T extends z.ZodTypeAny>(item: T) => z.object({ next: z.string().nullish(), results: z.array(item) });

const ExperimentSchema = z.object({
  name: z.string(),
  feature_flag_key: z.string().nullish(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  archived: z.boolean().nullish(),
});

const FlagSchema = z.object({
  key: z.string(),
  active: z.boolean(),
  deleted: z.boolean().nullish(),
  filters: z
    .object({
      groups: z.array(z.object({ properties: z.array(z.unknown()).nullish(), rollout_percentage: z.number().nullish() })).nullish(),
      multivariate: z.object({ variants: z.array(z.object({ key: z.string() })) }).nullish(),
    })
    .passthrough()
    .nullish(),
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function errorKind(status: number): BehaviorSourceError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "failed";
}

function explain(kind: BehaviorSourceError["kind"], what: string): string {
  switch (kind) {
    case "unauthorized":
      return `PostHog rejected the API key while reading ${what}. Check POSTHOG_PERSONAL_API_KEY.`;
    case "forbidden":
      return `The PostHog API key lacks the permission to read ${what}.`;
    case "not_found":
      return `PostHog has no such project (reading ${what}). Check the host and project id.`;
    case "rate_limited":
      return `PostHog's rate limit was reached while reading ${what}. Try again later.`;
    default:
      return `PostHog could not be read (${what}).`;
  }
}

export function createPostHogSource(options: PostHogSourceOptions): BehaviorSource {
  const host = normalizePostHogHost(options.host);
  const projectId = options.projectId.trim();
  if (!/^\d{1,12}$/.test(projectId)) throw new BehaviorSourceError("The PostHog project id must be its number (Project settings -> Project ID).", "invalid_response");
  const apiKey = options.apiKey.trim();
  if (apiKey.length < 10) throw new BehaviorSourceError("A PostHog personal API key is required.", "unauthorized");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());
  const projectBase = `${host}/api/projects/${projectId}`;

  async function request<S extends z.ZodTypeAny>(url: string, init: RequestInit, schema: S, what: string): Promise<z.output<S>> {
    if (new URL(url).origin !== host) {
      throw new BehaviorSourceError(`PostHog returned a link to another host while reading ${what}; refused.`, "invalid_response");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${timeoutMs / 1000}s` : "network error";
      throw new BehaviorSourceError(`PostHog could not be reached while reading ${what} (${reason}).`, "failed");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const kind = errorKind(res.status);
      throw new BehaviorSourceError(`${explain(kind, what)} (HTTP ${res.status})`, kind);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BehaviorSourceError(`PostHog returned something that is not JSON while reading ${what}.`, "invalid_response");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new BehaviorSourceError(
        `Unexpected response from PostHog while reading ${what}: ${parsed.error.issues[0]?.message ?? "invalid shape"}.`,
        "invalid_response",
      );
    }
    return parsed.data;
  }

  function query<S extends z.ZodTypeAny>(body: object, schema: S, what: string): Promise<z.output<S>> {
    return request(`${projectBase}/query/`, { method: "POST", body: JSON.stringify(body) }, schema, what);
  }

  async function list<S extends z.ZodTypeAny>(path: string, item: S, what: string): Promise<{ results: z.output<S>[]; truncated: boolean }> {
    const results: z.output<S>[] = [];
    let url: string | null = `${projectBase}/${path}/?limit=${PAGE_SIZE}`;
    for (let page = 0; url && page < MAX_LIST_PAGES; page++) {
      const body: { next?: string | null | undefined; results: z.output<S>[] } = await request(url, { method: "GET" }, PageSchema(item), what);
      results.push(...body.results);
      url = body.next ?? null;
    }
    return { results, truncated: url !== null };
  }

  /** "2026-10-01 00:00:00": built from a validated Date, never from caller text. */
  function hogqlTime(iso: string): string {
    return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
  }

  return {
    system: "posthog",
    async read(raw: BehaviorQuery): Promise<BehaviorSnapshot> {
      const q = validateBehaviorQuery(raw);
      const where = `timestamp >= toDateTime('${hogqlTime(q.from)}') AND timestamp < toDateTime('${hogqlTime(q.to)}')`;
      const notes: string[] = [];

      // Totals and top events first: they prove the key and project work.
      const totals = await query(
        { query: { kind: "HogQLQuery", query: `SELECT count() AS events, uniq(event) AS names FROM events WHERE ${where}` }, name: "gauntlet_event_totals" },
        HogQLResponseSchema,
        "event totals",
      );
      const row = totals.results[0] ?? [0, 0];
      const eventCount = Number(row[0] ?? 0);
      const distinctEventCount = Number(row[1] ?? 0);
      if (!Number.isFinite(eventCount) || !Number.isFinite(distinctEventCount)) {
        throw new BehaviorSourceError("Unexpected response from PostHog while reading event totals: counts are not numbers.", "invalid_response");
      }
      const topRows = await query(
        {
          query: {
            kind: "HogQLQuery",
            query: `SELECT event, count() AS c FROM events WHERE ${where} GROUP BY event ORDER BY c DESC LIMIT ${MAX_TOP_EVENTS}`,
          },
          name: "gauntlet_top_events",
        },
        HogQLResponseSchema,
        "top events",
      );
      const topEvents = topRows.results
        .map((r) => ({ event: String(r[0]), count: Number(r[1]) }))
        .filter((e) => e.event && Number.isFinite(e.count));

      const funnels: MeasuredFunnel[] = [];
      for (const spec of q.funnels) {
        const windowDays = spec.windowDays ?? 14;
        const body = await query(
          {
            query: {
              kind: "FunnelsQuery",
              dateRange: { date_from: q.from, date_to: q.to, explicitDate: true },
              series: spec.steps.map((event) => ({ kind: "EventsNode", event })),
              funnelsFilter: { funnelWindowInterval: windowDays, funnelWindowIntervalUnit: "day" },
            },
            name: "gauntlet_funnel",
          },
          FunnelResponseSchema,
          `funnel "${spec.name}"`,
        );
        const flat = (Array.isArray(body.results[0]) ? body.results[0] : body.results) as z.output<typeof FunnelStepSchema>[];
        const steps = [...flat].sort((a, b) => a.order - b.order);
        if (steps.length !== spec.steps.length) {
          throw new BehaviorSourceError(
            `Unexpected response from PostHog for funnel "${spec.name}": ${steps.length} step(s) for ${spec.steps.length} event(s).`,
            "invalid_response",
          );
        }
        funnels.push({
          name: spec.name,
          windowDays,
          steps: steps.map((s, i) => ({
            event: spec.steps[i]!,
            count: s.count,
            medianSecondsFromPrevious: i === 0 ? null : (s.median_conversion_time ?? null),
          })),
        });
      }

      const experiments = await optionalList("experiments", ExperimentSchema, "experiments", notes, (all) =>
        all
          .filter((e) => !e.archived)
          .map(
            (e): ExperimentSummary => ({
              name: e.name,
              flagKey: e.feature_flag_key ?? null,
              status: !e.start_date ? "draft" : e.end_date ? "complete" : "running",
              startDate: e.start_date ?? null,
              endDate: e.end_date ?? null,
            }),
          ),
      );
      const flags = await optionalList("feature_flags", FlagSchema, "feature flags", notes, (all) =>
        all
          .filter((f) => !f.deleted)
          .map((f): FlagSummary => {
            const groups = f.filters?.groups ?? [];
            const single = groups.length === 1 && (groups[0]!.properties ?? []).length === 0 ? groups[0]!.rollout_percentage : null;
            return {
              key: f.key,
              active: f.active,
              rolloutPercentage: typeof single === "number" ? single : null,
              variants: f.filters?.multivariate?.variants.map((v) => v.key) ?? [],
            };
          }),
      );

      return {
        system: "posthog",
        host,
        project: projectId,
        query: q,
        pulledAt: now(),
        eventCount,
        distinctEventCount,
        topEvents,
        funnels,
        experiments,
        flags,
        notes,
      };
    },
  };

  /** A list that needs an optional scope: null (with a note) when forbidden; other failures still throw. */
  async function optionalList<S extends z.ZodTypeAny, T>(
    path: string,
    item: S,
    what: string,
    notes: string[],
    map: (all: z.output<S>[]) => T[],
  ): Promise<T[] | null> {
    try {
      const { results, truncated } = await list(path, item, what);
      if (truncated) notes.push(`Only the first ${MAX_LIST_PAGES * PAGE_SIZE} ${what} were read.`);
      return map(results);
    } catch (err) {
      if (err instanceof BehaviorSourceError && err.kind === "forbidden") return null;
      throw err;
    }
  }
}
