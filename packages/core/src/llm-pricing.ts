/**
 * Estimated cost of model calls, for observability (what a scan, a brief
 * or a repo-aware brief costs), never for billing.
 *
 * Prices are USD per million tokens, per model, as published at
 * PRICES_AS_OF. Token counts are always stored as well, so a cost can be
 * recomputed if prices change; a model missing from the table has no
 * estimate (null) rather than a guessed one.
 */
import type { LlmUsage } from "./llm-client.js";

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICES_AS_OF = "2026-10-06";

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

/**
 * Longest table key the model id starts with, so a dated snapshot
 * ("claude-sonnet-5-20260601") prices like its alias.
 */
export function priceFor(model: string, prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES): ModelPrice | null {
  let best: string | null = null;
  for (const key of Object.keys(prices)) {
    if ((model === key || model.startsWith(`${key}-`)) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? null : prices[best]!;
}

/** Estimated USD for one call, rounded to a millionth of a dollar; null for an unpriced model. */
export function estimateCostUsd(
  usage: Pick<LlmUsage, "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): number | null {
  const price = priceFor(usage.model, prices);
  if (!price) return null;
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
