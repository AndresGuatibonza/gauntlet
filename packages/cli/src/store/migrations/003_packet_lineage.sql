ALTER TABLE evidence_packets ADD COLUMN derived_from_packet_id INTEGER REFERENCES evidence_packets(id);

CREATE INDEX IF NOT EXISTS idx_evidence_packets_derived_from ON evidence_packets(derived_from_packet_id);
