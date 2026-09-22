CREATE TABLE IF NOT EXISTS evidence_packets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL,
  product_name    TEXT NOT NULL,
  category        TEXT NOT NULL,
  scanned_at       TEXT NOT NULL,
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
