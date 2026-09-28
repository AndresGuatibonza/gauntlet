-- Gauntlet web app -- per-client scan quota (see lib/rate-limit.ts).
--
-- The public POST /api/scans endpoint is unauthenticated, and every scan
-- crawls up to 8 pages of a third-party site and makes 2+ Claude API
-- calls. PRD v2 §18 lists "How do we prevent repeated anonymous scans from
-- becoming an unbounded compute/crawl vector?" as open; this is the
-- minimal answer: a rolling per-client and global quota counted straight
-- from scan_jobs, no new infrastructure.
--
-- The client IP is stored only as an HMAC-SHA256 digest keyed with
-- SCAN_IP_HASH_SECRET -- never in the clear. Retention policy for
-- anonymous scans is still an open PRD question; not storing raw IPs keeps
-- that question from getting harder in the meantime.
--
-- Rows created before this migration keep client_ip_hash = null: they
-- still count toward the global quota, never toward any per-client one.
--
-- Apply manually via the Supabase SQL editor, same as 001_init.sql, and
-- BEFORE deploying the code that uses it: the new POST /api/scans inserts
-- into client_ip_hash and fails without this column.
alter table scan_jobs add column if not exists client_ip_hash text;

create index if not exists scan_jobs_client_ip_hash_created_at_idx
  on scan_jobs (client_ip_hash, created_at desc);
