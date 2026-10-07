/**
 * Behavior evidence (evidence contract Amendment 4, draft, §1.4): what a
 * product-analytics source says about real usage, as citable B* items.
 *
 * Vendor-neutral by design (PRD §8 "keep the adapter interface generic
 * enough for Amplitude/Pendo later"): a source adapter (posthog-source.ts
 * today) only has to produce a BehaviorSnapshot; everything after that --
 * the mapping to evidence items, the coverage notes, attaching to a packet
 * -- lives here and never depends on the vendor.
 *
 * The mapping is pure and deterministic: no LLM, no estimation, only the
 * counts and ratios the source reported. Privacy: a snapshot carries event
 * names and counts, funnel step counts, experiment and flag inventories --
 * never people, distinct ids, property values or recordings.
 */
import {
  type BehaviorEvidenceItem,
  type BehaviorSystem,
  type EvidencePacket,
  type PopulatedBehaviorEvidence,
  isPopulatedAiEvidence,
  isPopulatedBehaviorEvidence,
  sourceReliabilityFor,
} from "./evidence-packet.js";

export class BehaviorSourceError extends Error {
  constructor(
    message: string,
    /** What went wrong, so callers can explain it without parsing text. */
    public readonly kind: "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "invalid_response" | "failed" = "failed",
  ) {
    super(message);
    this.name = "BehaviorSourceError";
  }
}

// ---------------------------------------------------------------------------
// The vendor-neutral snapshot every source adapter produces
// ---------------------------------------------------------------------------

/** A funnel to measure: ordered event names (2-6), named for the report. */
export interface FunnelSpec {
  name: string;
  steps: string[];
  /** Conversion window per entrant, in days (default 14). */
  windowDays?: number;
}

export interface BehaviorQuery {
  /** Window, ISO 8601, from inclusive, to exclusive. */
  from: string;
  to: string;
  funnels: FunnelSpec[];
}

export interface EventCount {
  event: string;
  count: number;
}

export interface FunnelStep {
  event: string;
  /** People (or sessions, per the source's funnel definition) who reached this step. */
  count: number;
  /** Median seconds from the previous step, when the source reports it. */
  medianSecondsFromPrevious: number | null;
}

export interface MeasuredFunnel {
  name: string;
  windowDays: number;
  steps: FunnelStep[];
}

export interface ExperimentSummary {
  name: string;
  flagKey: string | null;
  /** draft / running / complete, from start and end dates. */
  status: "draft" | "running" | "complete";
  startDate: string | null;
  endDate: string | null;
}

export interface FlagSummary {
  key: string;
  active: boolean;
  /** Overall rollout when the source states a single one; null for targeted or multi-condition flags. */
  rolloutPercentage: number | null;
  variants: string[];
}

export interface BehaviorSnapshot {
  system: BehaviorSystem;
  host: string;
  project: string;
  query: BehaviorQuery;
  pulledAt: string;
  /** Every event in the window, and how many distinct names. */
  eventCount: number;
  distinctEventCount: number;
  /** Most frequent events first; at most MAX_TOP_EVENTS. */
  topEvents: EventCount[];
  funnels: MeasuredFunnel[];
  /** Null when the source could not list them (missing permission): reported in notEvaluable. */
  experiments: ExperimentSummary[] | null;
  flags: FlagSummary[] | null;
  /** What the adapter itself could not read, in plain words. */
  notes: string[];
}

/** Any analytics adapter: one read per analysis, returning a snapshot or throwing BehaviorSourceError. */
export interface BehaviorSource {
  readonly system: BehaviorSystem;
  read(query: BehaviorQuery): Promise<BehaviorSnapshot>;
}

// ---------------------------------------------------------------------------
// Validation of what callers ask for
// ---------------------------------------------------------------------------

export const MAX_TOP_EVENTS = 25;
export const MAX_FUNNELS = 5;
export const MAX_FUNNEL_STEPS = 6;
export const MAX_WINDOW_DAYS = 90;
/** Below this many entrants a funnel's conversion is reported with medium confidence. */
export const MIN_FUNNEL_ENTRANTS = 100;
/** Event names as analytics tools emit them ("$pageview", "signed_up", "Checkout Started"). */
const EVENT_NAME = /^[\w$][\w$ .:\-/]{0,199}$/;

/**
 * Checks a query before any request: a bounded window, 0-5 funnels of 2-6
 * plausible event names. Throws BehaviorSourceError with the first problem.
 */
export function validateBehaviorQuery(query: BehaviorQuery): BehaviorQuery {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new BehaviorSourceError("The window needs valid ISO 8601 dates.", "invalid_response");
  if (to <= from) throw new BehaviorSourceError("The window must end after it starts.", "invalid_response");
  if (to - from > MAX_WINDOW_DAYS * 86_400_000) throw new BehaviorSourceError(`The window can be at most ${MAX_WINDOW_DAYS} days.`, "invalid_response");
  if (query.funnels.length > MAX_FUNNELS) throw new BehaviorSourceError(`At most ${MAX_FUNNELS} funnels per analysis.`, "invalid_response");
  const names = new Set<string>();
  for (const f of query.funnels) {
    if (!f.name.trim()) throw new BehaviorSourceError("Every funnel needs a name.", "invalid_response");
    if (names.has(f.name)) throw new BehaviorSourceError(`Funnel "${f.name}" is listed twice.`, "invalid_response");
    names.add(f.name);
    if (f.steps.length < 2 || f.steps.length > MAX_FUNNEL_STEPS) {
      throw new BehaviorSourceError(`Funnel "${f.name}" needs 2 to ${MAX_FUNNEL_STEPS} steps.`, "invalid_response");
    }
    const bad = f.steps.find((s) => !EVENT_NAME.test(s));
    if (bad !== undefined) throw new BehaviorSourceError(`Funnel "${f.name}" has an invalid event name: "${bad}".`, "invalid_response");
    if (f.windowDays !== undefined && (!Number.isInteger(f.windowDays) || f.windowDays < 1 || f.windowDays > 90)) {
      throw new BehaviorSourceError(`Funnel "${f.name}" window must be 1 to 90 days.`, "invalid_response");
    }
  }
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    funnels: query.funnels.map((f) => ({ name: f.name.trim(), steps: f.steps, windowDays: f.windowDays ?? 14 })),
  };
}

/**
 * Parses the CLI's funnel syntax: "name=event_a>event_b>event_c", with an
 * optional ":Nd" window suffix on the name ("activation:7d=signed_up>created_project").
 */
export function parseFunnelSpec(text: string): FunnelSpec {
  const at = text.indexOf("=");
  if (at <= 0) throw new BehaviorSourceError(`Funnel "${text}" must look like name=event_a>event_b.`, "invalid_response");
  const head = text.slice(0, at).trim();
  const steps = text
    .slice(at + 1)
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  const m = head.match(/^(.*?):(\d+)d$/);
  return m ? { name: m[1]!.trim(), steps, windowDays: Number(m[2]) } : { name: head, steps };
}

// ---------------------------------------------------------------------------
// Mapping to evidence (deterministic)
// ---------------------------------------------------------------------------

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;
}

function refBase(snapshot: BehaviorSnapshot): string {
  return `${snapshot.system}:project/${snapshot.project}`;
}

/**
 * Builds §1.4 from a snapshot, in a fixed order so the same snapshot always
 * yields the same items, ids and text:
 * 1. event_volume, one item;
 * 2. funnel_conversion, one per measured funnel;
 * 3. experiment_inventory, one item when experiments could be listed;
 * 4. feature_flag_inventory, one item when flags could be listed.
 */
export function buildBehaviorEvidence(snapshot: BehaviorSnapshot): PopulatedBehaviorEvidence {
  const items: Omit<BehaviorEvidenceItem, "id">[] = [];
  const timestamp = snapshot.pulledAt;
  const base = refBase(snapshot);
  const { from, to } = snapshot.query;

  // 1. event_volume
  const top = snapshot.topEvents.slice(0, MAX_TOP_EVENTS);
  items.push({
    sourceRef: `${base}/events`,
    timestamp,
    evidenceType: "event_volume",
    observation:
      snapshot.eventCount === 0
        ? `No events were recorded between ${from} and ${to}.`
        : `${snapshot.eventCount} events of ${snapshot.distinctEventCount} distinct names were recorded between ${from} and ${to}; ` +
          `the most frequent were ${top
            .slice(0, 5)
            .map((e) => `${e.event} (${e.count})`)
            .join(", ")}.`,
    rawExcerpt: JSON.stringify({ eventCount: snapshot.eventCount, distinctEventCount: snapshot.distinctEventCount, topEvents: top }),
    confidence: "high",
  });

  // 2. funnel_conversion
  for (const funnel of snapshot.funnels) {
    const entrants = funnel.steps[0]?.count ?? 0;
    const last = funnel.steps[funnel.steps.length - 1]?.count ?? 0;
    const stepRates = funnel.steps.slice(1).map((s, i) => ({
      from: funnel.steps[i]!.event,
      to: s.event,
      rate: ratio(s.count, funnel.steps[i]!.count),
      medianSeconds: s.medianSecondsFromPrevious,
    }));
    const worst = stepRates
      .filter((r) => r.rate !== null)
      .reduce<(typeof stepRates)[number] | null>((w, r) => (w === null || (r.rate ?? 1) < (w.rate ?? 1) ? r : w), null);
    items.push({
      sourceRef: `${base}/funnel/${encodeURIComponent(funnel.name)}`,
      timestamp,
      evidenceType: "funnel_conversion",
      observation:
        entrants === 0
          ? `Funnel "${funnel.name}" (${funnel.steps.map((s) => s.event).join(" > ")}) had no entrants between ${from} and ${to}.`
          : `Funnel "${funnel.name}": ${entrants} entered at ${funnel.steps[0]!.event} and ${last} reached ${funnel.steps[funnel.steps.length - 1]!.event} ` +
            `(${pct(last, entrants)} within ${funnel.windowDays} days)` +
            (worst ? `; the largest drop is ${worst.from} > ${worst.to} (${(worst.rate! * 100).toFixed(1)}% continue).` : "."),
      rawExcerpt: JSON.stringify({
        windowDays: funnel.windowDays,
        steps: funnel.steps,
        overallConversion: ratio(last, entrants),
        stepConversion: stepRates,
      }),
      confidence: entrants >= MIN_FUNNEL_ENTRANTS ? "high" : "medium",
    });
  }

  // 3. experiment_inventory
  if (snapshot.experiments) {
    const running = snapshot.experiments.filter((e) => e.status === "running");
    const complete = snapshot.experiments.filter((e) => e.status === "complete");
    items.push({
      sourceRef: `${base}/experiments`,
      timestamp,
      evidenceType: "experiment_inventory",
      observation:
        snapshot.experiments.length === 0
          ? "The analytics project has no experiments."
          : `The analytics project has ${snapshot.experiments.length} experiment(s): ${running.length} running, ${complete.length} complete` +
            (running.length > 0 ? `; running: ${running.map((e) => `"${e.name}"${e.flagKey ? ` (flag ${e.flagKey})` : ""}`).join(", ")}.` : "."),
      rawExcerpt: JSON.stringify(snapshot.experiments),
      confidence: "high",
    });
  }

  // 4. feature_flag_inventory
  if (snapshot.flags) {
    const active = snapshot.flags.filter((f) => f.active);
    items.push({
      sourceRef: `${base}/feature_flags`,
      timestamp,
      evidenceType: "feature_flag_inventory",
      observation:
        snapshot.flags.length === 0
          ? "The analytics project has no feature flags."
          : `The analytics project has ${snapshot.flags.length} feature flag(s), ${active.length} active` +
            (active.length > 0
              ? `: ${active
                  .slice(0, 10)
                  .map((f) => (f.rolloutPercentage === null ? f.key : `${f.key} (${f.rolloutPercentage}%)`))
                  .join(", ")}${active.length > 10 ? ", ..." : ""}.`
              : "."),
      rawExcerpt: JSON.stringify(snapshot.flags),
      confidence: "high",
    });
  }

  return {
    source: {
      system: snapshot.system,
      host: snapshot.host,
      project: snapshot.project,
      window: { from, to },
      eventCount: snapshot.eventCount,
      pulledAt: snapshot.pulledAt,
    },
    items: items.map((item, i) => ({ id: `B${i + 1}`, ...item })),
    notEvaluable: notEvaluable(snapshot),
  };
}

function notEvaluable(snapshot: BehaviorSnapshot): string[] {
  const notes = [...snapshot.notes];
  if (snapshot.query.funnels.length === 0) {
    notes.push("Funnel conversion: no funnel was specified, so no step-to-step conversion was measured.");
  }
  for (const f of snapshot.funnels) {
    const entrants = f.steps[0]?.count ?? 0;
    if (entrants > 0 && entrants < MIN_FUNNEL_ENTRANTS) {
      notes.push(`Funnel "${f.name}": only ${entrants} entrants (fewer than ${MIN_FUNNEL_ENTRANTS}), so its conversion is a small sample.`);
    }
  }
  if (snapshot.experiments === null) notes.push("Experiments could not be listed (missing permission), so running experiments are unknown.");
  if (snapshot.flags === null) notes.push("Feature flags could not be listed (missing permission), so existing flags are unknown.");
  notes.push("Experiment results are not read: an experiment's status says it ran, not what it showed.");
  if (snapshot.distinctEventCount > snapshot.topEvents.length) {
    notes.push(`Only the ${snapshot.topEvents.length} most frequent of ${snapshot.distinctEventCount} event names are listed.`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Attaching to a packet
// ---------------------------------------------------------------------------

/**
 * Returns a NEW packet with behaviorEvidence populated (the public-scan
 * packet is never modified), sourceReliability raised to include behavior,
 * and the analytics coverage limits added to missingEvidenceSummary (§1.8).
 */
export function attachBehaviorEvidence(packet: EvidencePacket, behavior: PopulatedBehaviorEvidence): EvidencePacket {
  if (isPopulatedBehaviorEvidence(packet.behaviorEvidence)) {
    throw new BehaviorSourceError(
      "This Evidence Packet already has behavior evidence. Run the analysis on the original public-scan packet instead.",
    );
  }
  const { source, notEvaluable: limits } = behavior;
  const coverage =
    `Behavior evidence (${source.system}, project ${source.project}) covers ${source.eventCount} event(s) between ${source.window.from} and ${source.window.to}; ` +
    "it covers only aggregates of what the product already tracks, not untracked behavior, individual users or other dates" +
    (limits.length > 0 ? `. Not evaluable: ${limits.join(" ")}` : ".");
  const existing = packet.confidenceMetadata.missingEvidenceSummary.trim();
  return {
    ...packet,
    behaviorEvidence: behavior,
    confidenceMetadata: {
      ...packet.confidenceMetadata,
      sourceReliability: sourceReliabilityFor(true, isPopulatedAiEvidence(packet.aiEvidence)),
      missingEvidenceSummary: existing ? `${/[.!?]$/.test(existing) ? existing : `${existing}.`} ${coverage}` : coverage,
    },
  };
}
