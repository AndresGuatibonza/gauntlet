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
