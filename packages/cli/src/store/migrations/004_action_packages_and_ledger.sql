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
