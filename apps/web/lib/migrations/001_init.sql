-- Gauntlet web app -- scan_jobs table.
--
-- Deliberately one wide table with jsonb columns, not the CLI's normalized
-- evidence_packets/opportunity_reports/review_records tables (see
-- packages/cli/src/store/sqlite.ts). Different consumer, different shape:
-- the CLI needs to browse and re-query many packets/reports over time; the
-- web app's job store only ever needs "the one finished artifact for this
-- job id", polled until it's ready. Normalizing that would buy nothing here
-- and cost a join on every poll.
--
-- Apply this manually via the Supabase SQL editor (or `psql`) against the
-- DIRECT connection (port 5432, not the pooler) -- there's no automated
-- migration runner for the web app yet; one migration doesn't earn one.
create extension if not exists pgcrypto;

create table if not exists scan_jobs (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  category text not null check (category in ('ai_tool', 'ai_saas')),
  status text not null check (
    status in ('queued', 'scanning', 'analyzing', 'reviewing', 'done', 'failed')
  ),
  evidence_packet jsonb,
  opportunity_report jsonb,
  review_records jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scan_jobs_created_at_idx on scan_jobs (created_at desc);
