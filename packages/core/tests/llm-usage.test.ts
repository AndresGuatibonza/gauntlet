import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import {
  createAnthropicLlmClient,
  estimateCostUsd,
  fakeLlmClient,
  generateActionPackage,
  LlmCallError,
  priceFor,
  promptFingerprint,
  generateOpportunityReport,
  reviewOpportunityReport,
  type LlmUsage,
  type OpportunityCard,
} from "../src/index.js";
import { fakeEvidencePacket, fakeOpportunityCard } from "./fixtures.js";

beforeEach(() => create.mockReset());

function reply(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-5-20260601",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

describe("promptFingerprint", () => {
  it("is 12 hex digits, stable for the same text and different for any edit", () => {
    const a = promptFingerprint("You are the Scientist.");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(promptFingerprint("You are the Scientist.")).toBe(a);
    expect(promptFingerprint("You are the Scientist!")).not.toBe(a);
  });
});

describe("createAnthropicLlmClient usage", () => {
  it("reports one record per call: step, served model, prompt fingerprint, tokens, stop reason", async () => {
    create.mockResolvedValue(reply());
    const usages: LlmUsage[] = [];
    const llm = createAnthropicLlmClient({ apiKey: "k", onUsage: (u) => usages.push(u) });
    expect(await llm.complete({ system: "SYS", messages: [{ role: "user", content: "hi" }], purpose: "scientist" })).toBe("hello");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      purpose: "scientist",
      model: "claude-sonnet-5-20260601",
      promptHash: promptFingerprint("SYS"),
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      stopReason: "end_turn",
      ok: true,
    });
    expect(usages[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("still records a billed response that had no text, and a transport failure with zero tokens", async () => {
    const usages: LlmUsage[] = [];
    const llm = createAnthropicLlmClient({ apiKey: "k", model: "claude-sonnet-5", onUsage: (u) => usages.push(u) });

    create.mockResolvedValueOnce(reply({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "..." }] }));
    await expect(llm.complete({ system: "S", messages: [] })).rejects.toBeInstanceOf(LlmCallError);
    expect(usages[0]).toMatchObject({ ok: false, stopReason: "max_tokens", outputTokens: 300, purpose: null });

    create.mockRejectedValueOnce(new Error("Connection error."));
    await expect(llm.complete({ system: "S", messages: [], purpose: "reviewer" })).rejects.toBeInstanceOf(LlmCallError);
    expect(usages[1]).toMatchObject({ ok: false, stopReason: null, inputTokens: 0, outputTokens: 0, model: "claude-sonnet-5", purpose: "reviewer" });
  });

  it("treats missing or malformed usage fields as zero", async () => {
    create.mockResolvedValue(reply({ usage: { input_tokens: -5, output_tokens: "x" } }));
    const usages: LlmUsage[] = [];
    await createAnthropicLlmClient({ apiKey: "k", onUsage: (u) => usages.push(u) }).complete({ system: "S", messages: [] });
    expect(usages[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("never lets a failing usage callback fail the call", async () => {
    create.mockResolvedValue(reply());
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const llm = createAnthropicLlmClient({
      apiKey: "k",
      onUsage: () => {
        throw new Error("db down");
      },
    });
    expect(await llm.complete({ system: "S", messages: [] })).toBe("hello");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("estimateCostUsd", () => {
  it("prices a dated snapshot like its alias, per million tokens", () => {
    expect(priceFor("claude-sonnet-5-20260601")).toEqual(priceFor("claude-sonnet-5"));
    // 1200 in * $2 + 300 out * $10 + 100 cache read * $0.2 = 0.0024 + 0.003 + 0.00002
    expect(
      estimateCostUsd({ model: "claude-sonnet-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 0 }),
    ).toBeCloseTo(0.00542, 6);
  });

  it("gives no estimate for an unpriced model, and never prices a lookalike prefix", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCostUsd({ ...usage, model: "some-other-model" })).toBeNull();
    expect(priceFor("claude-sonnet-50")).toBeNull();
  });
});

describe("call purposes", () => {
  it("the Scientist, Reviewer and brief steps label their calls", async () => {
    const seen: (string | undefined)[] = [];
    const llm = fakeLlmClient((options) => {
      seen.push(options.purpose);
      return "not json";
    });
    const packet = fakeEvidencePacket();
    const card = fakeOpportunityCard() as unknown as OpportunityCard;

    await generateOpportunityReport(packet, llm).catch(() => undefined);
    expect(new Set(seen)).toEqual(new Set(["scientist"]));
    seen.length = 0;
    await reviewOpportunityReport({ cards: [card] }, packet, llm).catch(() => undefined);
    expect(new Set(seen)).toEqual(new Set(["reviewer"]));
    seen.length = 0;
    await generateActionPackage(card, packet, llm).catch(() => undefined);
    expect(new Set(seen)).toEqual(new Set(["action_package"]));
  });
});
