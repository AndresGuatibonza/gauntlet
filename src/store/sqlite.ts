/**
 * Local SQLite store for Evidence Packets (PRD §9 "Evidence Store: persist
 * raw + normalized evidence, source metadata, freshness"). Mirrors Token
 * Profiler's local-first, migration-tracked pattern.
 *
 * Migration SQL is kept inline (mirrored in
 * src/store/migrations/001_init.sql for human review) rather than read from
 * disk at runtime, so the compiled/bundled CLI never depends on a migrations
 * folder shipping alongside dist/.
 */
import Database from "better-sqlite3";
import type { EvidencePacket } from "../core/evidence-packet.js";

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
];

export interface GauntletStore {
  saveEvidencePacket(packet: EvidencePacket): number;
  getEvidencePacketById(id: number): EvidencePacket | undefined;
  listEvidencePackets(): Array<{ id: number; url: string; productName: string; scannedAt: string }>;
  close(): void;
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
    `INSERT INTO evidence_packets (url, product_name, category, scanned_at, packet_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO evidence_items (id, packet_id, source_url, evidence_type, observation, raw_excerpt, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectPacketById = db.prepare("SELECT packet_json FROM evidence_packets WHERE id = ?");
  const selectAllPackets = db.prepare(
    "SELECT id, url, product_name AS productName, scanned_at AS scannedAt FROM evidence_packets ORDER BY id DESC",
  );

  return {
    saveEvidencePacket(packet: EvidencePacket): number {
      const result = db.transaction(() => {
        const insertResult = insertPacket.run(
          packet.productIdentity.url,
          packet.productIdentity.productName,
          packet.productIdentity.category,
          packet.confidenceMetadata.freshness,
          JSON.stringify(packet),
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

    listEvidencePackets() {
      return selectAllPackets.all() as Array<{ id: number; url: string; productName: string; scannedAt: string }>;
    },

    close(): void {
      db.close();
    },
  };
}
