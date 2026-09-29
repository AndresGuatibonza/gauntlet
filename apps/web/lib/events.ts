/**
 * Report funnel events + per-card feedback (PRD v2 §17; contract doc §4).
 *
 * The five event names and the five-point rating scale are taken verbatim
 * from the contract's Concierge Validation Plan, so the numbers it asks
 * for (top-3 usefulness, action intent, false-confidence rate) can be
 * computed straight from scan_events -- see the README for the queries.
 *
 * scan_started / scan_completed are written by the server itself
 * (store.ts, run-scan.ts). Only the three report-page events below can be
 * sent by the browser, and each is validated against the job it names.
 */
import { z } from "zod";

export const SCAN_EVENT_TYPES = [
  "scan_started",
  "scan_completed",
  "report_viewed",
  "opportunity_feedback_submitted",
  "build_this_requested",
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
  z
    .object({
      type: z.literal("opportunity_feedback_submitted"),
      cardIndex: CardIndexSchema,
      rating: z.enum(CARD_RATINGS),
    })
    .strict(),
  z.object({ type: z.literal("build_this_requested"), cardIndex: CardIndexSchema }).strict(),
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
  if (event.type === "report_viewed") return { ok: true, cardTitle: null };

  const card = job.opportunityReport.cards[event.cardIndex];
  if (!card) {
    return { ok: false, status: 422, error: `This report has no opportunity #${event.cardIndex}.` };
  }
  return { ok: true, cardTitle: card.title };
}
