-- Gauntlet web app -- "Build this" implementation packages (PRD Build
-- Order #5, §8.8) and the minimal Experiment Ledger (Build Order #7; PRD §9:
-- "build minimal from day one"). Contract: evidence contract §2.2-§2.3.
--
-- action_packages: at most one per (scan, card). A row is claimed in
-- "generating" before the single Claude call, so concurrent clicks never
-- pay for two generations; "attempts" caps retries after failures.
--
-- experiment_records: the ledger entry each package starts, "planned" until
-- a result and decision are recorded (with identity: the CLI today, the web
-- app once accounts exist). The evidence snapshot is copied in, so the
-- record keeps what the decision was based on even if a report changes.
--
-- Both cascade with their scan, so the retention policy (scans after
-- SCAN_RETENTION_DAYS) covers them too. Idempotent.
create table if not exists action_packages (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs (id) on delete cascade,
  card_index integer not null check (card_index >= 0),
  status text not null check (status in ('generating', 'ready', 'failed')),
  package jsonb,
  error_message text,
  attempts integer not null default 1 check (attempts >= 1),
  -- HMAC of the requesting client's IP, for the package quota only.
  client_ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_packages_one_per_card unique (scan_job_id, card_index),
  constraint action_packages_package_iff_ready check ((status = 'ready') = (package is not null))
);

create index if not exists action_packages_client_created_idx on action_packages (client_ip_hash, created_at desc);
create index if not exists action_packages_created_idx on action_packages (created_at desc);

create table if not exists experiment_records (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs (id) on delete cascade,
  card_index integer not null check (card_index >= 0),
  action_package_id uuid not null unique references action_packages (id) on delete cascade,
  status text not null default 'planned' check (status in ('planned', 'running', 'decided')),
  hypothesis text not null,
  evidence_snapshot jsonb not null,
  change jsonb not null,
  experiment jsonb not null,
  result text,
  decision text check (decision in ('ship', 'iterate', 'discard')),
  outcome text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint experiment_records_decision_iff_decided check ((status = 'decided') = (decision is not null)),
  constraint experiment_records_decision_has_result check (decision is null or result is not null)
);

-- PRD §11 events for this feature, written by the server: both are card events.
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
    'experiment_created'
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
    'experiment_created'
  )) = (card_index is not null)
);
