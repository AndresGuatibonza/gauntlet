-- Gauntlet web app -- one row per model call, for reproducibility and cost
-- observability.
--
-- Reproducibility: every stored output (a report's Scientist and Reviewer
-- passes, a "Build this" brief, a repo-aware brief) can be traced to the
-- model that served it, the fingerprint of the exact system prompt
-- (first 12 hex digits of its SHA-256, see promptFingerprint in
-- @gauntlet/core) and the deployed commit.
--
-- Observability: tokens per call (input, output, cache read/write), the
-- estimated cost at the prices in @gauntlet/core's llm-pricing.ts, the stop
-- reason, the duration and whether the call returned text. Failed calls
-- are recorded too (zero tokens when the API was never reached).
--
-- No prompt or response text, no IP, no user identity. scan_job_id is
-- deliberately not a foreign key: rows outlive their scan's retention, so
-- cost history (and the per-scan / per-brief averages, which group by it)
-- survives the scans it came from. Writes are best-effort in the
-- code: a deploy that reaches production before this migration still
-- works, only without usage rows. Idempotent.
create table if not exists llm_calls (
  id bigint generated always as identity primary key,
  scan_job_id uuid not null,
  phase text not null check (phase in ('scan', 'package', 'repo_brief')),
  card_index integer check (card_index >= 0),
  purpose text check (purpose in ('scientist', 'reviewer', 'action_package', 'repo_selection', 'repo_analysis')),
  model text not null,
  prompt_hash text not null check (prompt_hash ~ '^[0-9a-f]{12}$'),
  app_version text,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  stop_reason text,
  duration_ms integer not null check (duration_ms >= 0),
  ok boolean not null,
  created_at timestamptz not null default now(),
  -- A scan's own calls belong to no card; brief calls always to one.
  constraint llm_calls_card_matches_phase check ((phase = 'scan') = (card_index is null))
);

create index if not exists llm_calls_scan_idx on llm_calls (scan_job_id, phase, card_index);
create index if not exists llm_calls_created_idx on llm_calls (created_at desc);
