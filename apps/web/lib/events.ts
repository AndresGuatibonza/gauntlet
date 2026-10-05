/**
 * Report funnel events + per-card feedback (PRD v2 §17; contract doc §4).
 *
 * The five event names and the five-point rating scale are taken verbatim
 * from the contract's Concierge Validation Plan, so the numbers it asks
 * for (top-3 usefulness, action intent, false-confidence rate) can be
 * computed straight from scan_events -- see the README for the queries.
 *
 * Four more come from PRD §11's V0 list (migration 004): scan_failed,
 * deepen_analysis_clicked, evidence_viewed and opportunity_opened. PRD's
 * build_this_clicked is recorded under the contract's name,
 * build_this_requested.
 *
 * scan_started / scan_completed / scan_failed are written by the server
 * itself (store.ts, run-scan.ts). Only the report-page events in
 * ClientEventSchema can be sent by the browser, and each is validated
 * against the job it names.
 */
import { z } from "zod";

export const SCAN_EVENT_TYPES = [
  "scan_started",
  "scan_completed",
  "scan_failed",
  "report_viewed",
  "opportunity_opened",
  "evidence_viewed",
  "opportunity_feedback_submitted",
  "build_this_requested",
  "deepen_analysis_clicked",
  // Server-written, migration 006: a "Build this" package was generated and
  // its Experiment Ledger record created (PRD §11).
  "action_package_generated",
  "experiment_created",
  // Migration 007, PRD §11: sign-in started from a report (browser), sign-in
  // completed from a report (server, auth callback), and a ledger decision
  // recorded in the web app (server).
  "signup_started",
  "signup_completed",
  "experiment_decision_recorded",
] as const;
export type ScanEventType = (typeof SCAN_EVENT_TYPES)[number];

/** Contract doc §4 step 3: "obvious / useful / surprising / wrong / would act now". */
export const CARD_RATINGS = ["obvious", "useful", "surprising", "wrong", "would_act_now"] as const;
export type CardRating = (typeof CARD_RATINGS)[number];

export const CARD_RATING_LABEL: Record<CardRating, string> = {
  obvious: "Obvious",
  useful: "Useful",
  surprising: "Surprising",
  wrong: "Wrong",
  would_act_now: "Would act now",
};

const CardIndexSchema = z.number().int().min(0).max(49);

/** The only events a browser may send. */
export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("report_viewed") }).strict(),
  z.object({ type: z.literal("deepen_analysis_clicked") }).strict(),
  z.object({ type: z.literal("opportunity_opened"), cardIndex: CardIndexSchema }).strict(),
  z.object({ type: z.literal("evidence_viewed"), cardIndex: CardIndexSchema }).strict(),
  z
    .object({
      type: z.literal("opportunity_feedback_submitted"),
      cardIndex: CardIndexSchema,
      rating: z.enum(CARD_RATINGS),
    })
    .strict(),
  z.object({ type: z.literal("build_this_requested"), cardIndex: CardIndexSchema }).strict(),
  z.object({ type: z.literal("signup_started") }).strict(),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export interface EventTargetJob {
  status: string;
  opportunityReport: { cards: Array<{ title: string }> } | null;
}

export type EventValidation =
  | { ok: true; cardTitle: string | null }
  | { ok: false; status: 409 | 422; error: string };

/**
 * Checks a parsed client event against the job it targets: events only
 * make sense on a finished report, and a card event must name a card that
 * actually exists in it.
 */
export function validateClientEvent(event: ClientEvent, job: EventTargetJob): EventValidation {
  if (job.status !== "done" || !job.opportunityReport) {
    return { ok: false, status: 409, error: "This scan has no finished report yet." };
  }
  if (!("cardIndex" in event)) return { ok: true, cardTitle: null };

  const card = job.opportunityReport.cards[event.cardIndex];
  if (!card) {
    return { ok: false, status: 422, error: `This report has no opportunity #${event.cardIndex}.` };
  }
  return { ok: true, cardTitle: card.title };
}
