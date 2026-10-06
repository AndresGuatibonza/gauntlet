/**
 * Plain-text tables for `npm run usage` (scripts/usage.ts): model usage
 * and estimated cost per phase and per day, or what produced one report.
 */
import { PRICES_AS_OF } from "@gauntlet/core";
import type { DailyUsage, PhaseUsage, ScanGeneration, UsageTotals } from "./llm-usage.js";

const PHASE_LABEL = { scan: "Scans", package: "Briefs", repo_brief: "Repo briefs" } as const;

export function formatUsd(value: number | null): string {
  if (value === null) return "n/a";
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function costCell(t: UsageTotals): string {
  return t.unpricedCalls > 0 ? `${formatUsd(t.costUsd)} (+${t.unpricedCalls} unpriced)` : formatUsd(t.costUsd);
}

export function formatUsageSummary(summary: { since: string; byPhase: PhaseUsage[]; byDay: DailyUsage[] }, days: number): string {
  if (summary.byPhase.length === 0) return `No model calls in the last ${days} day(s).`;
  const byPhase = table(
    ["Phase", "Units", "Calls", "Failed", "Input tokens", "Output tokens", "Cost", "Avg / unit"],
    summary.byPhase.map((p) => [
      PHASE_LABEL[p.phase],
      String(p.units),
      String(p.totals.calls),
      String(p.totals.failedCalls),
      formatTokens(p.totals.inputTokens),
      formatTokens(p.totals.outputTokens),
      costCell(p.totals),
      formatUsd(p.averageCostUsd),
    ]),
  );
  const byDay = table(
    ["Day (UTC)", "Phase", "Calls", "Failed", "Input tokens", "Output tokens", "Cost"],
    summary.byDay.map((d) => [
      d.day,
      PHASE_LABEL[d.phase],
      String(d.totals.calls),
      String(d.totals.failedCalls),
      formatTokens(d.totals.inputTokens),
      formatTokens(d.totals.outputTokens),
      costCell(d.totals),
    ]),
  );
  return [
    `Model usage, last ${days} day(s) (since ${summary.since}). Costs are estimates at prices as of ${PRICES_AS_OF}.`,
    "",
    byPhase,
    "",
    byDay,
  ].join("\n");
}

export function formatScanGeneration(scanJobId: string, gen: ScanGeneration): string {
  if (gen.parts.length === 0) return `No model calls recorded for ${scanJobId}.`;
  const lines = [`Report ${scanJobId}: ${gen.totals.calls} call(s), ${costCell(gen.totals)} estimated.`, ""];
  for (const part of gen.parts) {
    const label = part.phase === "scan" ? "Scan (Scientist + Reviewer)" : `${PHASE_LABEL[part.phase].slice(0, -1)} for card #${part.cardIndex}`;
    lines.push(`${label}: ${part.totals.calls} call(s), ${part.totals.failedCalls} failed, ${costCell(part.totals)}`);
    lines.push(`  model: ${part.models.join(", ")}`);
    lines.push(`  prompts: ${part.prompts.map((p) => `${p.purpose ?? "unlabeled"}@${p.promptHash}`).join(", ")}`);
    lines.push(`  commit: ${part.appVersions.join(", ") || "n/a"}`);
  }
  return lines.join("\n");
}
