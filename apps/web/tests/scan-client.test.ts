import { describe, it, expect } from "vitest";
import { activityLines, displayUrl, jobIdFromPath, STAGE_PHRASES, type ScanJobResponse } from "@/lib/scan-client";

const ID = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";

function job(overrides: Partial<ScanJobResponse>): ScanJobResponse {
  return {
    id: ID,
    url: "https://example.com/",
    status: "scanning",
    evidencePacket: null,
    opportunityReport: null,
    reviewRecords: null,
    errorMessage: null,
    progress: null,
    ...overrides,
  };
}

describe("jobIdFromPath", () => {
  it("reads the scan id only from /scans/<uuid>", () => {
    expect(jobIdFromPath(`/scans/${ID}`)).toBe(ID);
    expect(jobIdFromPath(`/scans/${ID}/`)).toBe(ID);
    expect(jobIdFromPath("/")).toBeNull();
    expect(jobIdFromPath("/scans/not-a-uuid")).toBeNull();
    expect(jobIdFromPath("/signup")).toBeNull();
    expect(jobIdFromPath(null)).toBeNull();
  });
});

describe("activityLines", () => {
  it("falls back to the stage's own phrases when the scan reported nothing", () => {
    expect(activityLines("queued", null)).toEqual(["Getting things ready"]);
    expect(activityLines("analyzing", job({ status: "analyzing" }))).toEqual([...STAGE_PHRASES.analyzing]);
  });

  it("shows a scanning step alone, since it changes page by page", () => {
    const j = job({ progress: { status: "scanning", message: "Reading /pricing (3 of 8)" } });
    expect(activityLines("scanning", j)).toEqual(["Reading /pricing (3 of 8)"]);
  });

  it("leads with the real step during the long stages, then rotates the stage phrases", () => {
    const j = job({ status: "analyzing", progress: { status: "analyzing", message: "Analyzing 54 pieces of evidence from 8 pages" } });
    expect(activityLines("analyzing", j)).toEqual([
      "Analyzing 54 pieces of evidence from 8 pages",
      ...STAGE_PHRASES.analyzing,
    ]);
  });

  it("never shows a message under a stage it doesn't belong to", () => {
    // The tracker is still catching up (shows scanning) while the job is already analyzing.
    const ahead = job({ status: "analyzing", progress: { status: "analyzing", message: "Analyzing 54 pieces" } });
    expect(activityLines("scanning", ahead)).toEqual([...STAGE_PHRASES.scanning]);
    // A stale scanning message left over after the status moved on.
    const stale = job({ status: "analyzing", progress: { status: "scanning", message: "Reading /about (8 of 8)" } });
    expect(activityLines("analyzing", stale)).toEqual([...STAGE_PHRASES.analyzing]);
  });
});

describe("displayUrl", () => {
  it("splits the host from the rest and drops www", () => {
    expect(displayUrl("https://www.intercom.com/")).toEqual({ host: "intercom.com", rest: "" });
    expect(displayUrl("https://app.example.com/pricing/?a=1")).toEqual({ host: "app.example.com", rest: "/pricing?a=1" });
    expect(displayUrl("garbage")).toEqual({ host: "garbage", rest: "" });
  });
});
