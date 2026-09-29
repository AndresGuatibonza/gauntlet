-- Gauntlet web app -- report funnel events and per-card feedback.
--
-- PRD v2 §17 requires that "the user can provide structured feedback on
-- the recommendations" and that "the team can measure the scan -> report
-- -> action -> signup funnel end to end". The contract doc's Concierge
-- Validation Plan (§4) names the exact events to log from session one and
-- the per-card rating scale; this table stores exactly those, in our own
-- Postgres (decided with Andres 2026-09-29: no external analytics service
-- yet -- PostHog stays the PRD's candidate for the first data adapter).
--
-- One row per (scan, event type, card, client): every client-sent event is
-- idempotent per client, so the public events endpoint can't be used to
-- inflate counts. A changed rating updates the existing row (latest
-- answer wins) instead of adding a second vote.
--
-- Apply manually via the Supabase SQL editor after 001 and 002, BEFORE
-- deploying the code that writes to it.
create table if not exists scan_events (
  id bigserial primary key,
  scan_job_id uuid not null references scan_jobs (id) on delete cascade,
  event_type text not null check (
    event_type in (
      'scan_started',
      'scan_completed',
      'report_viewed',
      'opportunity_feedback_submitted',
      'build_this_requested'
    )
  ),
  -- Position of the card in opportunity_report.cards (rank order), plus a
  -- title snapshot so feedback stays readable in plain SQL.
  card_index integer check (card_index >= 0),
  card_title text,
  rating text check (
    rating in ('obvious', 'useful', 'surprising', 'wrong', 'would_act_now')
  ),
  -- HMAC of the client IP (same key as scan_jobs.client_ip_hash), never raw.
  client_ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scan_events_rating_only_on_feedback check (
    (event_type = 'opportunity_feedback_submitted') = (rating is not null)
  ),
  constraint scan_events_card_only_on_card_events check (
    (event_type in ('opportunity_feedback_submitted', 'build_this_requested')) = (card_index is not null)
  )
);

create unique index if not exists scan_events_dedupe_idx
  on scan_events (scan_job_id, event_type, (coalesce(card_index, -1)), (coalesce(client_ip_hash, '')));

create index if not exists scan_events_type_created_at_idx
  on scan_events (event_type, created_at desc);
