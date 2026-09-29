import { describe, it, expect } from "vitest";
import { CARD_RATINGS, ClientEventSchema, SCAN_EVENT_TYPES, validateClientEvent } from "@/lib/events";

const doneJob = {
  status: "done",
  opportunityReport: { cards: [{ title: "Card A" }, { title: "Card B" }, { title: "Card C" }] },
};

describe("contract vocabulary", () => {
  it("uses exactly the five events and five ratings named in contract §4", () => {
    expect(SCAN_EVENT_TYPES).toEqual([
      "scan_started",
      "scan_completed",
      "report_viewed",
      "opportunity_feedback_submitted",
      "build_this_requested",
    ]);
    expect(CARD_RATINGS).toEqual(["obvious", "useful", "surprising", "wrong", "would_act_now"]);
  });
});

describe("ClientEventSchema", () => {
  it("accepts the three browser events", () => {
    expect(ClientEventSchema.safeParse({ type: "report_viewed" }).success).toBe(true);
    expect(
      ClientEventSchema.safeParse({ type: "opportunity_feedback_submitted", cardIndex: 0, rating: "useful" }).success,
    ).toBe(true);
    expect(ClientEventSchema.safeParse({ type: "build_this_requested", cardIndex: 2 }).success).toBe(true);
  });

  it.each([
    [{ type: "scan_started" }, "server-only event"],
    [{ type: "scan_completed" }, "server-only event"],
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
  });
});
