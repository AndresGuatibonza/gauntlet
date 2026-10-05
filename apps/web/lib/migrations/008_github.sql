-- Gauntlet web app -- GitHub deep scan (PRD Build Order #4, §8.6-§8.7;
-- contract Amendment 3).
--
-- Access goes through a GitHub App with read-only Contents permission:
-- users pick which repositories it may read and can uninstall it at any
-- time. No GitHub token is stored anywhere: the user's token is used once,
-- at connection, to list what THAT user may read (stored below), and every
-- deep scan mints a one-hour installation token scoped to one repository.
--
-- github_installations / github_repository_access: per Gauntlet user, the
--   installations and repositories they proved access to at connection.
--   Refreshed (replaced) on every reconnection.
-- workspace_repositories: the one repository connected to a workspace
--   (one product). Disconnecting deletes it AND that workspace's repo
--   briefs: code evidence never outlives the connection (PRD §8.6
--   "easy disconnect/revocation").
-- repo_briefs: per (scan, card), the private code context + refinement
--   (analysis) and the repo-aware "Build this" package. Never part of the
--   public report (PRD §14: connected private evidence never leaks into a
--   shareable report). The analysis is stored as soon as it exists, so a
--   retry after a failed package step reuses it ("resumable", PRD §14).
--
-- Idempotent.
create table if not exists github_installations (
  owner_user_id uuid not null,
  installation_id bigint not null,
  account_login text not null,
  account_type text not null,
  refreshed_at timestamptz not null default now(),
  primary key (owner_user_id, installation_id)
);

create table if not exists github_repository_access (
  owner_user_id uuid not null,
  installation_id bigint not null,
  repository_id bigint not null,
  full_name text not null,
  default_branch text not null,
  private boolean not null,
  primary key (owner_user_id, repository_id),
  foreign key (owner_user_id, installation_id)
    references github_installations (owner_user_id, installation_id) on delete cascade
);

create table if not exists workspace_repositories (
  workspace_id uuid primary key references workspaces (id) on delete cascade,
  installation_id bigint not null,
  repository_id bigint not null,
  full_name text not null,
  default_branch text not null,
  connected_by uuid not null,
  connected_at timestamptz not null default now()
);

create table if not exists repo_briefs (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid not null references scan_jobs (id) on delete cascade,
  card_index integer not null check (card_index >= 0),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  repository_id bigint not null,
  full_name text not null,
  status text not null check (status in ('generating', 'ready', 'failed')),
  -- While generating: reading the repository, or writing the package.
  stage text check (stage in ('reading', 'writing')),
  analysis jsonb,
  package jsonb,
  error_message text,
  attempts integer not null default 1 check (attempts >= 1),
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repo_briefs_one_per_card unique (scan_job_id, card_index),
  constraint repo_briefs_package_iff_ready check ((status = 'ready') = (package is not null)),
  constraint repo_briefs_ready_has_analysis check (status <> 'ready' or analysis is not null)
);

create index if not exists repo_briefs_requested_idx on repo_briefs (requested_by, created_at desc);
create index if not exists repo_briefs_created_idx on repo_briefs (created_at desc);
create index if not exists repo_briefs_workspace_idx on repo_briefs (workspace_id);

-- PRD §11 events: github_connect_started / github_connected (scan events,
-- written by the server) and repo_brief_generated (a card event).
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
    'experiment_decision_recorded',
    'github_connect_started',
    'github_connected',
    'repo_brief_generated'
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
    'experiment_decision_recorded',
    'repo_brief_generated'
  )) = (card_index is not null)
);
