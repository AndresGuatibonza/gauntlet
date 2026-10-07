-- Gauntlet web app -- quotas per account for signed-in visitors.
--
-- Until now the scan and "Build this" quotas counted by client IP hash, so
-- people behind one shared IP shared one allowance and a rotating IPv6
-- address could partly evade it. quota_subject is who a row counts
-- against: 'user:<account id>' when the request came from a signed-in
-- account, 'ip:<client IP HMAC>' otherwise. The quota queries count by it;
-- the global caps are unchanged.
--
-- Existing rows are backfilled from client_ip_hash, so allowances already
-- used today still count. Like client_ip_hash, quota_subject is cleared by
-- the daily maintenance after 48 hours (the quota window is 24 hours).
-- Idempotent.
alter table scan_jobs add column if not exists quota_subject text;
alter table action_packages add column if not exists quota_subject text;

update scan_jobs set quota_subject = 'ip:' || client_ip_hash
 where quota_subject is null and client_ip_hash is not null;
update action_packages set quota_subject = 'ip:' || client_ip_hash
 where quota_subject is null and client_ip_hash is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'scan_jobs_quota_subject_shape') then
    alter table scan_jobs add constraint scan_jobs_quota_subject_shape
      check (quota_subject is null or quota_subject ~ '^(user|ip):.+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'action_packages_quota_subject_shape') then
    alter table action_packages add constraint action_packages_quota_subject_shape
      check (quota_subject is null or quota_subject ~ '^(user|ip):.+$');
  end if;
end $$;

create index if not exists scan_jobs_quota_subject_created_idx on scan_jobs (quota_subject, created_at desc);
create index if not exists action_packages_quota_subject_created_idx on action_packages (quota_subject, created_at desc);
