/**
 * `gauntlet build` and `gauntlet ledger` (evidence contract §2.2-§2.3):
 * turn a report's card into an implementation package, and keep the
 * Experiment Ledger -- hypothesis, evidence snapshot, change, result,
 * decision, outcome -- for it. Local-first: the CLI's user is the one
 * deciding, so results and decisions can be recorded here today.
 *
 * Kept out of index.ts so the rules are unit-testable without Claude.
 */
import {
  ExperimentDecisionSchema,
  ExperimentRecordSchema,
  generateActionPackage,
  planExperimentRecord,
  type ExperimentRecord,
  type LlmClient,
  type OpportunityReport,
} from "@gauntlet/core";
import type { GauntletStore, SavedActionPackage, SavedExperiment } from "./store/sqlite.js";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** --card is 1-based as printed by `analyze`; default: the "Best next experiment". */
export function resolveCardIndex(report: OpportunityReport, cardArg: string | undefined): number {
  if (cardArg === undefined) {
    const index = report.cards.findIndex((c) => c.nextAction === "build_this");
    if (index < 0) throw new LedgerError("This report has no card marked as the best next experiment; pass --card <n>.");
    return index;
  }
  const n = Number(cardArg);
  if (!Number.isInteger(n) || n < 1 || n > report.cards.length) {
    throw new LedgerError(`--card must be a number from 1 to ${report.cards.length} (as numbered by \`gauntlet analyze\`).`);
  }
  return n - 1;
}

export interface BuildResult {
  saved: SavedActionPackage;
  created: boolean;
}

/**
 * Returns the card's existing package, or generates one (one Claude call
 * plus one corrective retry) and saves it with its planned ledger record.
 * Never generates twice for the same card.
 */
export async function buildPackage(
  store: GauntletStore,
  reportId: number,
  cardArg: string | undefined,
  llm: () => LlmClient,
): Promise<BuildResult> {
  const saved = store.getOpportunityReportById(reportId);
  if (!saved) throw new LedgerError(`No Opportunity Report #${reportId}. Run \`gauntlet analyze\` first.`);
  const packet = store.getEvidencePacketById(saved.packetId);
  if (!packet) throw new LedgerError(`Report #${reportId}'s Evidence Packet #${saved.packetId} is missing from this database.`);
  const cardIndex = resolveCardIndex(saved.report, cardArg);

  const existing = store.getActionPackage(reportId, cardIndex);
  if (existing) return { saved: existing, created: false };

  const pkg = await generateActionPackage(saved.report.cards[cardIndex]!, packet, llm());
  return { saved: store.saveActionPackage(reportId, cardIndex, pkg, planExperimentRecord(pkg)), created: true };
}

export interface ExperimentUpdate {
  running?: boolean;
  decision?: string;
  result?: string;
  outcome?: string;
}

/**
 * The ledger's transition rules: planned -> running -> decided (or straight
 * to decided). A decision needs its result. A decided record is history and
 * can't be changed; an outcome (what happened after the decision) can still
 * be added to it once.
 */
export function applyExperimentUpdate(current: ExperimentRecord, update: ExperimentUpdate): ExperimentRecord {
  const { running, decision, result, outcome } = update;
  if (!running && decision === undefined && result === undefined && outcome === undefined) {
    throw new LedgerError("Nothing to record: pass --running, or --decision with --result, and/or --outcome.");
  }
  if (running && decision !== undefined) throw new LedgerError("Pass either --running or --decision, not both.");

  if (current.status === "decided") {
    if (running || decision !== undefined || result !== undefined) {
      throw new LedgerError("This experiment is already decided; a decision is history. Record a new experiment instead.");
    }
    if (current.outcome) throw new LedgerError("This experiment already has an outcome recorded.");
    return ExperimentRecordSchema.parse({ ...current, outcome: outcome!.trim() });
  }

  if (running) {
    if (current.status === "running") throw new LedgerError("This experiment is already running.");
    if (result !== undefined || outcome !== undefined) throw new LedgerError("--result and --outcome are recorded with --decision.");
    return ExperimentRecordSchema.parse({ ...current, status: "running" });
  }

  if (decision === undefined) throw new LedgerError("--result and --outcome need --decision (ship, iterate or discard).");
  const parsedDecision = ExperimentDecisionSchema.safeParse(decision);
  if (!parsedDecision.success) throw new LedgerError(`--decision must be ship, iterate or discard; got "${decision}".`);
  if (!result?.trim()) throw new LedgerError("A decision needs its --result: what the experiment showed.");

  return ExperimentRecordSchema.parse({
    ...current,
    status: "decided",
    decision: parsedDecision.data,
    result: result.trim(),
    outcome: outcome?.trim() || null,
  });
}

export function recordExperiment(store: GauntletStore, id: number, update: ExperimentUpdate): SavedExperiment {
  const experiment = store.getExperiment(id);
  if (!experiment) throw new LedgerError(`No experiment #${id}. List them with \`gauntlet ledger\`.`);
  store.updateExperiment(id, applyExperimentUpdate(experiment.record, update));
  return store.getExperiment(id)!;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatLedger(experiments: SavedExperiment[]): string {
  if (experiments.length === 0) return "The Experiment Ledger is empty. Start one with `gauntlet build <reportId>`.";
  return experiments
    .map((e) => {
      const r = e.record;
      const state = r.status === "decided" ? `decided: ${r.decision}` : r.status;
      const lines = [
        `#${e.id} [${state}] ${e.productName} -- flag ${r.change.featureFlag} (report #${e.reportId}, card ${e.cardIndex + 1})`,
        `   Hypothesis: ${clip(r.hypothesis, 160)}`,
      ];
      if (r.result) lines.push(`   Result: ${clip(r.result, 160)}`);
      if (r.outcome) lines.push(`   Outcome: ${clip(r.outcome, 160)}`);
      return lines.join("\n");
    })
    .join("\n");
}
