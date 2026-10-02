/**
 * Local SQLite store for Evidence Packets (PRD §9 "Evidence Store: persist
 * raw + normalized evidence, source metadata, freshness"). Mirrors Token
 * Profiler's local-first, migration-tracked pattern.
 *
 * Migration SQL is kept inline (mirrored in
 * packages/cli/src/store/migrations/*.sql for human review) rather than read from
 * disk at runtime, so the compiled/bundled CLI never depends on a migrations
 * folder shipping alongside dist/.
 */
import Database from "better-sqlite3";
import type { ActionPackage, EvidencePacket, ExperimentRecord, OpportunityCard, OpportunityReport, ReviewRecord } from "@gauntlet/core";

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "001_init",
    sql: `
CREATE TABLE IF NOT EXISTS evidence_packets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL,
  product_name    TEXT NOT NULL,
  category        TEXT NOT NULL,
  scanned_at      TEXT NOT NULL,
  packet_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_packets_url ON evidence_packets(url);

CREATE TABLE IF NOT EXISTS evidence_items (
  id              TEXT NOT NULL,
  packet_id       INTEGER NOT NULL REFERENCES evidence_packets(id),
  source_url      TEXT NOT NULL,
  evidence_type   TEXT NOT NULL,
  observation     TEXT NOT NULL,
  raw_excerpt     TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  PRIMARY KEY (packet_id, id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_items_packet ON evidence_items(packet_id);
CREATE INDEX IF NOT EXISTS idx_evidence_items_type ON evidence_items(evidence_type);
`,
  },
  {
    // Build Order #2: Product Scientist v0 + Reviewer/Critic (PRD §8.3/§8.4).
    // One row per generated report (tied to the packet it was generated
    // from) plus one row per surviving Opportunity Card, so a report can be
    // re-displayed without re-calling the Claude API. review_records is kept
    // as its own table -- "for debugging and future experiment memory"
    // (PRD §8.4) -- separately from the cards, since a dropped card still
    // needs to be inspectable even though it does not appear in cards.
    name: "002_opportunity_reports",
    sql: `
CREATE TABLE IF NOT EXISTS opportunity_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id       INTEGER NOT NULL REFERENCES evidence_packets(id),
  generated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunity_reports_packet ON opportunity_reports(packet_id);

CREATE TABLE IF NOT EXISTS opportunity_cards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id       INTEGER NOT NULL REFERENCES opportunity_reports(id),
  rank_position   INTEGER NOT NULL,
  next_action     TEXT NOT NULL,
  rank_score      REAL,
  card_json       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunity_cards_report ON opportunity_cards(report_id);

CREATE TABLE IF NOT EXISTS review_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id       INTEGER NOT NULL REFERENCES opportunity_reports(id),
  card_index      INTEGER NOT NULL,
  verdict         TEXT NOT NULL,
  record_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_records_report ON review_records(report_id);
`,
  },
  {
    // Evidence contract Amendment 1: `analyze --token-profiler` saves the
    // trace-enriched packet as a NEW row instead of mutating the public-scan
    // packet. This column links the copy back to the packet it came from;
    // NULL for every packet produced by `scan`. Only §1.3 items are mirrored
    // into evidence_items -- §1.6 AI items live in packet_json.
    name: "003_packet_lineage",
    sql: `
ALTER TABLE evidence_packets ADD COLUMN derived_from_packet_id INTEGER REFERENCES evidence_packets(id);

CREATE INDEX IF NOT EXISTS idx_evidence_packets_derived_from ON evidence_packets(derived_from_packet_id);
`,
  },
  {
    // "Build this" implementation packages and the Experiment Ledger
    // (evidence contract §2.2-§2.3). One package per (report, card); each
    // starts one ledger record, "planned" until a result and decision are
    // recorded with `gauntlet ledger record`. A decided record is final.
    name: "004_action_packages_and_ledger",
    sql: `
CREATE TABLE IF NOT EXISTS action_packages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id       INTEGER NOT NULL REFERENCES opportunity_reports(id),
  card_index      INTEGER NOT NULL CHECK (card_index >= 0),
  package_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (report_id, card_index)
);

CREATE TABLE IF NOT EXISTS experiment_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  action_package_id   INTEGER NOT NULL UNIQUE REFERENCES action_packages(id),
  status              TEXT NOT NULL CHECK (status IN ('planned', 'running', 'decided')),
  record_json         TEXT NOT NULL,
  decided_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
`,
  },
];

export interface SavedOpportunityReport {
  id: number;
  packetId: number;
  generatedAt: string;
  report: OpportunityReport;
  reviewRecords: ReviewRecord[];
}

export interface GauntletStore {
  saveEvidencePacket(packet: EvidencePacket, options?: { derivedFromPacketId?: number }): number;
  /** The packet this one was derived from (Amendment 1 enrichment), or undefined for a public-scan packet. */
  getPacketLineage(id: number): number | undefined;
  getEvidencePacketById(id: number): EvidencePacket | undefined;
  listEvidencePackets(): Array<{ id: number; url: string; productName: string; scannedAt: string }>;
  saveOpportunityReport(packetId: number, report: OpportunityReport, reviewRecords: ReviewRecord[]): number;
  getOpportunityReportById(id: number): SavedOpportunityReport | undefined;
  getActionPackage(reportId: number, cardIndex: number): SavedActionPackage | undefined;
  /** Saves a package and its planned ledger record in one transaction. */
  saveActionPackage(reportId: number, cardIndex: number, pkg: ActionPackage, record: ExperimentRecord): SavedActionPackage;
  getExperiment(id: number): SavedExperiment | undefined;
  listExperiments(): SavedExperiment[];
  updateExperiment(id: number, record: ExperimentRecord): void;
  close(): void;
}

export interface SavedActionPackage {
  id: number;
  reportId: number;
  cardIndex: number;
  package: ActionPackage;
  experimentId: number;
}

export interface SavedExperiment {
  id: number;
  actionPackageId: number;
  reportId: number;
  cardIndex: number;
  productName: string;
  record: ExperimentRecord;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((row) => (row as { name: string }).name),
  );

  const insertMigration = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.exec(migration.sql);
    insertMigration.run(migration.name, new Date().toISOString());
  }
}

export function openStore(path: string): GauntletStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runMigrations(db);

  const insertPacket = db.prepare(
    `INSERT INTO evidence_packets (url, product_name, category, scanned_at, packet_json, derived_from_packet_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO evidence_items (id, packet_id, source_url, evidence_type, observation, raw_excerpt, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectPacketById = db.prepare("SELECT packet_json FROM evidence_packets WHERE id = ?");
  const selectLineage = db.prepare("SELECT derived_from_packet_id AS derivedFrom FROM evidence_packets WHERE id = ?");
  const selectAllPackets = db.prepare(
    "SELECT id, url, product_name AS productName, scanned_at AS scannedAt FROM evidence_packets ORDER BY id DESC",
  );

  const insertReport = db.prepare(
    `INSERT INTO opportunity_reports (packet_id, generated_at) VALUES (?, ?)`,
  );
  const insertCard = db.prepare(
    `INSERT INTO opportunity_cards (report_id, rank_position, next_action, rank_score, card_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertReviewRecord = db.prepare(
    `INSERT INTO review_records (report_id, card_index, verdict, record_json)
     VALUES (?, ?, ?, ?)`,
  );
  const selectReportById = db.prepare(
    "SELECT id, packet_id AS packetId, generated_at AS generatedAt FROM opportunity_reports WHERE id = ?",
  );
  const selectCardsByReport = db.prepare(
    "SELECT card_json FROM opportunity_cards WHERE report_id = ? ORDER BY rank_position ASC",
  );
  const selectReviewRecordsByReport = db.prepare(
    "SELECT record_json FROM review_records WHERE report_id = ? ORDER BY card_index ASC",
  );

  function listExperimentRows(where: string, params: unknown[]): SavedExperiment[] {
    const rows = db
      .prepare(
        `SELECT e.id, e.action_package_id AS actionPackageId, p.report_id AS reportId, p.card_index AS cardIndex,
                e.record_json AS recordJson, p.package_json AS packageJson,
                e.decided_at AS decidedAt, e.created_at AS createdAt, e.updated_at AS updatedAt
           FROM experiment_records e JOIN action_packages p ON p.id = e.action_package_id
           ${where} ORDER BY e.id DESC`,
      )
      .all(...params) as Array<{
      id: number;
      actionPackageId: number;
      reportId: number;
      cardIndex: number;
      recordJson: string;
      packageJson: string;
      decidedAt: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      actionPackageId: r.actionPackageId,
      reportId: r.reportId,
      cardIndex: r.cardIndex,
      productName: (JSON.parse(r.packageJson) as ActionPackage).product.name,
      record: JSON.parse(r.recordJson) as ExperimentRecord,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  return {
    saveEvidencePacket(packet: EvidencePacket, options?: { derivedFromPacketId?: number }): number {
      const result = db.transaction(() => {
        const insertResult = insertPacket.run(
          packet.productIdentity.url,
          packet.productIdentity.productName,
          packet.productIdentity.category,
          packet.confidenceMetadata.freshness,
          JSON.stringify(packet),
          options?.derivedFromPacketId ?? null,
        );
        const packetId = Number(insertResult.lastInsertRowid);
        for (const item of packet.observedEvidence) {
          insertItem.run(
            item.id,
            packetId,
            item.sourceUrl,
            item.evidenceType,
            item.observation,
            item.rawExcerpt,
            item.confidence,
          );
        }
        return packetId;
      })();
      return result;
    },

    getEvidencePacketById(id: number): EvidencePacket | undefined {
      const row = selectPacketById.get(id) as { packet_json: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.packet_json) as EvidencePacket;
    },

    getPacketLineage(id: number): number | undefined {
      const row = selectLineage.get(id) as { derivedFrom: number | null } | undefined;
      return row?.derivedFrom ?? undefined;
    },

    listEvidencePackets() {
      return selectAllPackets.all() as Array<{ id: number; url: string; productName: string; scannedAt: string }>;
    },

    saveOpportunityReport(packetId: number, report: OpportunityReport, reviewRecords: ReviewRecord[]): number {
      return db.transaction(() => {
        const generatedAt = new Date().toISOString();
        const insertResult = insertReport.run(packetId, generatedAt);
        const reportId = Number(insertResult.lastInsertRowid);
        report.cards.forEach((card: OpportunityCard, index: number) => {
          insertCard.run(reportId, index, card.nextAction, card.rankScore ?? null, JSON.stringify(card));
        });
        reviewRecords.forEach((record) => {
          insertReviewRecord.run(reportId, record.cardIndex, record.verdict, JSON.stringify(record));
        });
        return reportId;
      })();
    },

    getOpportunityReportById(id: number): SavedOpportunityReport | undefined {
      const row = selectReportById.get(id) as { id: number; packetId: number; generatedAt: string } | undefined;
      if (!row) return undefined;
      const cardRows = selectCardsByReport.all(id) as Array<{ card_json: string }>;
      const reviewRows = selectReviewRecordsByReport.all(id) as Array<{ record_json: string }>;
      return {
        id: row.id,
        packetId: row.packetId,
        generatedAt: row.generatedAt,
        report: { cards: cardRows.map((r) => JSON.parse(r.card_json) as OpportunityCard) },
        reviewRecords: reviewRows.map((r) => JSON.parse(r.record_json) as ReviewRecord),
      };
    },

    getActionPackage(reportId: number, cardIndex: number): SavedActionPackage | undefined {
      const row = db
        .prepare(
          `SELECT p.id, p.report_id AS reportId, p.card_index AS cardIndex, p.package_json AS packageJson, e.id AS experimentId
             FROM action_packages p JOIN experiment_records e ON e.action_package_id = p.id
            WHERE p.report_id = ? AND p.card_index = ?`,
        )
        .get(reportId, cardIndex) as
        | { id: number; reportId: number; cardIndex: number; packageJson: string; experimentId: number }
        | undefined;
      if (!row) return undefined;
      return { id: row.id, reportId: row.reportId, cardIndex: row.cardIndex, package: JSON.parse(row.packageJson), experimentId: row.experimentId };
    },

    saveActionPackage(reportId, cardIndex, pkg, record): SavedActionPackage {
      return db.transaction(() => {
        const now = new Date().toISOString();
        const packageId = Number(
          db
            .prepare(`INSERT INTO action_packages (report_id, card_index, package_json, created_at) VALUES (?, ?, ?, ?)`)
            .run(reportId, cardIndex, JSON.stringify(pkg), now).lastInsertRowid,
        );
        const experimentId = Number(
          db
            .prepare(
              `INSERT INTO experiment_records (action_package_id, status, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(packageId, record.status, JSON.stringify(record), now, now).lastInsertRowid,
        );
        return { id: packageId, reportId, cardIndex, package: pkg, experimentId };
      })();
    },

    getExperiment(id: number): SavedExperiment | undefined {
      return listExperimentRows(`WHERE e.id = ?`, [id])[0];
    },

    listExperiments(): SavedExperiment[] {
      return listExperimentRows("", []);
    },

    updateExperiment(id: number, record: ExperimentRecord): void {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE experiment_records SET status = ?, record_json = ?, updated_at = ?,
                decided_at = CASE WHEN ? = 'decided' THEN ? ELSE decided_at END
          WHERE id = ?`,
      ).run(record.status, JSON.stringify(record), now, record.status, now, id);
    },

    close(): void {
      db.close();
    },
  };
}
