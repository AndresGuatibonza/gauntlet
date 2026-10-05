import { describe, it, expect } from "vitest";
import {
  ActionPackageSchema,
  checkDraftGrounding,
  citedEvidenceFor,
  ExperimentRecordSchema,
  generateActionPackage,
  planExperimentRecord,
  renderActionPackageMarkdown,
  renderCodingAgentPrompt,
  ActionPackageError,
  type ActionPackageDraft,
} from "../src/action-package.js";
import { fakeLlmClient, LlmCallError } from "../src/llm-client.js";
import type { OpportunityCard } from "../src/opportunity-card.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";

const card = fakeOpportunityCard({ evidenceRefs: ["E1", "E2"] }) as OpportunityCard;
const packet = fakeEvidencePacket();
const NOW = "2026-10-02T15:00:00.000Z";

function draft(overrides: Partial<ActionPackageDraft> = {}): ActionPackageDraft {
  return {
    objective: "Show the starting price next to the primary CTA for half of homepage visitors.",
    nonGoals: ["Changing plan prices", "Redesigning the pricing page"],
    likelyComponents: ["the homepage hero and its primary call to action", "the shared pricing data shown on the pricing page"],
    approach: ["Read the starting price from the same source the pricing page uses", "Render it next to the CTA when the flag is on"],
    featureFlag: { name: "homepage_cta_price", rollout: "50% of new homepage visitors, sticky per visitor" },
    acceptanceCriteria: [
      "With the flag on, the starting price appears within the hero next to the CTA",
      "The displayed price matches the pricing page",
      "With the flag off, the hero is unchanged",
    ],
    measurement: {
      howToMeasure: "Compare signup completion between flag-on and flag-off visitors",
      baseline: "Unknown; record two weeks of the current signup rate first",
      minimumDuration: "Two full weeks",
    },
    rollbackCriteria: ["Overall signup volume drops more than 5% in the variant"],
    risks: [{ risk: "Price shown out of sync with the pricing page", mitigation: "Read both from one source" }],
    missingContext: ["Where the CTA component and pricing data live in the code"],
    evidenceRefs: ["E1"],
    ...overrides,
  };
}

describe("generateActionPackage", () => {
  it("builds a valid package, copying the card's decided parts verbatim", async () => {
    const pkg = await generateActionPackage(card, packet, fakeLlmClient([JSON.stringify(draft())]), { now: () => NOW });
    expect(ActionPackageSchema.parse(pkg)).toEqual(pkg);
    expect(pkg.experiment).toEqual(card.experiment);
    expect(pkg.card.hypothesis).toBe(card.hypothesis);
    expect(pkg.codeContext).toBe("public_scan");
    expect(pkg.citedEvidence.map((e) => e.id)).toEqual(["E1", "E2"]);
    expect(pkg.generatedAt).toBe(NOW);
  });

  it("gives the model the card and only its cited evidence", async () => {
    let prompt = "";
    const client = fakeLlmClient((o) => {
      prompt = o.messages[0]!.content;
      return JSON.stringify(draft());
    });
    await generateActionPackage(card, packet, client);
    expect(prompt).toContain(card.hypothesis);
    expect(prompt).toContain('"id": "E2"');
    expect(prompt).not.toContain("rankScore");
  });

  it("retries once with the exact problem when the model names files, then succeeds", async () => {
    const bad = JSON.stringify(draft({ likelyComponents: ["src/components/Hero.tsx"] }));
    const prompts: string[] = [];
    const client = fakeLlmClient((o, i) => {
      prompts.push(o.messages.at(-1)!.content);
      return i === 0 ? bad : JSON.stringify(draft());
    });
    const pkg = await generateActionPackage(card, packet, client);
    expect(pkg.likelyComponents[0]).toContain("homepage hero");
    expect(prompts[1]).toContain("not files or code paths");
  });

  it("rejects evidence the card doesn't cite", () => {
    expect(checkDraftGrounding(draft({ evidenceRefs: ["E1", "E9"] }), card).join(" ")).toContain("found E9");
  });

  it.each([
    ["components/Pricing/"],
    ["components/Pricing"],
    ["app.vue"],
    ["the Next.js layout"],
    ["src/components/Hero.tsx"],
    ["the hero in ./marketing/hero"],
    ["~/web/pricing"],
    ["marketing/pricing/table"],
    ["the pricing table (lib/pricing)"],
    ["pricing-page/"],
  ])("rejects path-like component %s", (c) => {
    expect(checkDraftGrounding(draft({ likelyComponents: [c] }), card)).toHaveLength(1);
  });

  // Real production false positive (2026-10-05): a slash in a product term.
  it.each([
    ["the signup / onboarding flow"],
    ["Shared marketing-page pricing content block/snippet (new reusable component)"],
    ["the signup/onboarding flow"],
    ["API/webhooks settings page"],
    ["the pricing page at https://www.intercom.com/pricing/plans/compare"],
    ["the /pricing page"],
  ])("accepts product-term component %s", (c) => {
    expect(checkDraftGrounding(draft({ likelyComponents: [c] }), card)).toEqual([]);
  });

  it("fails clearly after two invalid responses", async () => {
    const client = fakeLlmClient(["not json", JSON.stringify({ objective: "x" })]);
    await expect(generateActionPackage(card, packet, client)).rejects.toThrow(/after 2 attempt\(s\)/);
  });

  it("wraps API failures and refuses an ungrounded card", async () => {
    const failing = { complete: async () => Promise.reject(new LlmCallError("Connection error.")) };
    await expect(generateActionPackage(card, packet, failing)).rejects.toBeInstanceOf(ActionPackageError);
    const orphan = { ...card, evidenceRefs: ["E99"] };
    await expect(generateActionPackage(orphan, packet, fakeLlmClient([]))).rejects.toThrow(/no evidence present/);
  });

  it("rejects unknown keys and a non-snake_case flag", async () => {
    const extra = JSON.stringify({ ...draft(), surprise: true });
    const badFlag = JSON.stringify(draft({ featureFlag: { name: "Homepage CTA", rollout: "50%" } }));
    await expect(generateActionPackage(card, packet, fakeLlmClient([extra, badFlag]))).rejects.toThrow(/snake_case/);
  });
});

describe("citedEvidenceFor", () => {
  it("resolves the card's refs in order and skips unknown ones", () => {
    expect(citedEvidenceFor({ ...card, evidenceRefs: ["E2", "E7", "E1"] }, packet).map((e) => e.id)).toEqual(["E2", "E1"]);
  });
});

describe("rendering", () => {
  it("renders the prompt and brief from the package, flag and decided experiment included", async () => {
    const pkg = await generateActionPackage(card, packet, fakeLlmClient([JSON.stringify(draft())]), { now: () => NOW });
    const prompt = renderCodingAgentPrompt(pkg);
    expect(prompt).toContain("`homepage_cta_price` (default off)");
    expect(prompt).toContain(`Primary metric: ${card.experiment.primaryMetric}`);
    expect(prompt).toContain("stop and report");
    const md = renderActionPackageMarkdown(pkg);
    expect(md).toContain(`# Implementation brief: ${card.title}`);
    expect(md).toContain("- E1:");
    expect(md).toContain(prompt);
  });
});

describe("experiment ledger record", () => {
  it("starts planned, with the hypothesis, evidence snapshot and flag", async () => {
    const pkg = await generateActionPackage(card, packet, fakeLlmClient([JSON.stringify(draft())]));
    const record = planExperimentRecord(pkg);
    expect(record).toMatchObject({ status: "planned", decision: null, change: { featureFlag: "homepage_cta_price" } });
    expect(record.evidenceSnapshot).toEqual(pkg.citedEvidence);
  });

  it("requires a decision and result exactly when decided", () => {
    const base = { hypothesis: "h", evidenceSnapshot: [{ id: "E1", observation: "o", sourceRef: "s" }], change: { featureFlag: "f", summary: "s" }, experiment: card.experiment, outcome: null };
    expect(ExperimentRecordSchema.safeParse({ ...base, status: "decided", result: "won", decision: "ship" }).success).toBe(true);
    expect(ExperimentRecordSchema.safeParse({ ...base, status: "decided", result: null, decision: "ship" }).success).toBe(false);
    expect(ExperimentRecordSchema.safeParse({ ...base, status: "running", result: null, decision: "ship" }).success).toBe(false);
    expect(ExperimentRecordSchema.safeParse({ ...base, status: "decided", result: "won", decision: null }).success).toBe(false);
  });
});
