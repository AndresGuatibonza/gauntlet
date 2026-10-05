-- Gauntlet web app -- accounts (Supabase Auth, sign-in with GitHub):
-- workspaces, claiming a scan, and recording Experiment Ledger decisions
-- (PRD §8.6 "create a workspace from the scanned product and persist the
-- Evidence Packet/report"; PRD §17 "preserves the selected opportunity
-- through signup").
--
-- User ids are Supabase Auth user ids (auth.users.id). They are stored as
-- plain uuids with no foreign key into the auth schema, so this schema also
-- runs on a plain Postgres (CI) and never couples to Supabase internals.
--
-- Claiming needs proof of authorship: POST /api/scans returns a random
-- claim token once, only its SHA-256 is stored, and only a browser holding
-- the token can save that scan to an account. People who were sent the
-- report link can read it but not take it.
--
-- Claimed scans belong to a workspace and are no longer anonymous, so the
-- retention purge (anonymous scans only) skips them. Idempotent.
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  -- Canonical origin of the scanned product, e.g. https://www.intercom.com
  product_url text not null,
  product_name text not null,
  created_at timestamptz not null default now(),
  constraint workspaces_one_per_product unique (owner_user_id, product_url)
);

alter table scan_jobs add column if not exists claim_token_hash text;
alter table scan_jobs add column if not exists workspace_id uuid references workspaces (id) on delete set null;
alter table scan_jobs add column if not exists claimed_at timestamptz;
create index if not exists scan_jobs_workspace_idx on scan_jobs (workspace_id);

-- Who recorded the experiment's decision (Supabase Auth user id).
alter table experiment_records add column if not exists decided_by uuid;

-- PRD §11 events for accounts and the ledger.
alter table scan_events drop constraint if exists scan_events_event_type_check;
alter table scan_events add constraint scan_events_event_type_check check (
  event_type in (
    'scan_started',
    'scan_completed',
    'scan_failed',
    'report_viewed',
    'opportunity_opened',
    'evidence_viewed',
    'opportunity_feedback_submitted',
    'build_this_requested',
    'deepen_analysis_clicked',
    'action_package_generated',
    'experiment_created',
    'signup_started',
    'signup_completed',
    'experiment_decision_recorded'
  )
);

alter table scan_events drop constraint if exists scan_events_card_only_on_card_events;
alter table scan_events add constraint scan_events_card_only_on_card_events check (
  (event_type in (
    'opportunity_opened',
    'evidence_viewed',
    'opportunity_feedback_submitted',
    'build_this_requested',
    'action_package_generated',
    'experiment_created',
    'experiment_decision_recorded'
  )) = (card_index is not null)
);
