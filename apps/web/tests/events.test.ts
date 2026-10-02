import { describe, it, expect } from "vitest";
import { CARD_RATINGS, ClientEventSchema, SCAN_EVENT_TYPES, validateClientEvent } from "@/lib/events";

const doneJob = {
  status: "done",
  opportunityReport: { cards: [{ title: "Card A" }, { title: "Card B" }, { title: "Card C" }] },
};

describe("contract vocabulary", () => {
  it("uses the contract §4 events plus the PRD §11 events that have a feature today", () => {
    expect(SCAN_EVENT_TYPES).toEqual([
      "scan_started",
      "scan_completed",
      "scan_failed",
      "report_viewed",
      "opportunity_opened",
      "evidence_viewed",
      "opportunity_feedback_submitted",
      "build_this_requested",
      "deepen_analysis_clicked",
      "action_package_generated",
      "experiment_created",
    ]);
    expect(CARD_RATINGS).toEqual(["obvious", "useful", "surprising", "wrong", "would_act_now"]);
  });
});

describe("ClientEventSchema", () => {
  it.each(["action_package_generated", "experiment_created"])("never accepts the server-only event %s from a browser", (type) => {
    expect(ClientEventSchema.safeParse({ type, cardIndex: 0 }).success).toBe(false);
  });

  it("accepts the browser events", () => {
    expect(ClientEventSchema.safeParse({ type: "report_viewed" }).success).toBe(true);
    expect(ClientEventSchema.safeParse({ type: "deepen_analysis_clicked" }).success).toBe(true);
    expect(ClientEventSchema.safeParse({ type: "evidence_viewed", cardIndex: 0 }).success).toBe(true);
    expect(ClientEventSchema.safeParse({ type: "opportunity_opened", cardIndex: 1 }).success).toBe(true);
    expect(
      ClientEventSchema.safeParse({ type: "opportunity_feedback_submitted", cardIndex: 0, rating: "useful" }).success,
    ).toBe(true);
    expect(ClientEventSchema.safeParse({ type: "build_this_requested", cardIndex: 2 }).success).toBe(true);
  });

  it.each([
    [{ type: "scan_started" }, "server-only event"],
    [{ type: "scan_completed" }, "server-only event"],
    [{ type: "scan_failed" }, "server-only event"],
    [{ type: "evidence_viewed" }, "card event without a card"],
    [{ type: "deepen_analysis_clicked", cardIndex: 0 }, "report event with a card"],
    [{ type: "opportunity_feedback_submitted", cardIndex: 0, rating: "meh" }, "unknown rating"],
    [{ type: "opportunity_feedback_submitted", cardIndex: 0 }, "missing rating"],
    [{ type: "build_this_requested" }, "missing card"],
    [{ type: "build_this_requested", cardIndex: -1 }, "negative card"],
    [{ type: "build_this_requested", cardIndex: 1.5 }, "fractional card"],
    [{ type: "report_viewed", cardIndex: 0 }, "extra field"],
    [{ type: "report_viewed", clientIpHash: "spoofed" }, "client can't set its own identity"],
  ])("rejects %j (%s)", (body: unknown, _why: string) => {
    expect(ClientEventSchema.safeParse(body).success).toBe(false);
  });
});

describe("validateClientEvent", () => {
  it("resolves the card title for card events", () => {
    expect(validateClientEvent({ type: "build_this_requested", cardIndex: 1 }, doneJob)).toEqual({
      ok: true,
      cardTitle: "Card B",
    });
    expect(validateClientEvent({ type: "report_viewed" }, doneJob)).toEqual({ ok: true, cardTitle: null });
    expect(validateClientEvent({ type: "deepen_analysis_clicked" }, doneJob)).toEqual({ ok: true, cardTitle: null });
    expect(validateClientEvent({ type: "evidence_viewed", cardIndex: 2 }, doneJob)).toEqual({ ok: true, cardTitle: "Card C" });
  });

  it("rejects events on a report that isn't finished", () => {
    expect(validateClientEvent({ type: "report_viewed" }, { status: "analyzing", opportunityReport: null })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(validateClientEvent({ type: "report_viewed" }, { status: "failed", opportunityReport: null })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("rejects a card index outside the report", () => {
    expect(
      validateClientEvent({ type: "opportunity_feedback_submitted", cardIndex: 3, rating: "wrong" }, doneJob),
    ).toMatchObject({ ok: false, status: 422 });
    expect(validateClientEvent({ type: "opportunity_opened", cardIndex: 9 }, doneJob)).toMatchObject({
      ok: false,
      status: 422,
    });
  });
});
