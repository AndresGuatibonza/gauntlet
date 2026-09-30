-- Gauntlet web app -- the rest of PRD v2 §11's V0 events that have a
-- feature to attach to today.
--
-- 003 created scan_events with the five events from the contract's
-- Concierge Validation Plan. PRD §11 lists more; these four apply to what
-- exists now:
--   scan_failed             -- server: a scan ended in "failed" (any stage)
--   deepen_analysis_clicked -- "Make this recommendation smarter" clicked
--   evidence_viewed         -- a card's Evidence section opened by the visitor
--   opportunity_opened      -- a card's Proposed experiment opened by the visitor
-- The last two are card events (carry card_index). PRD's build_this_clicked
-- is recorded as build_this_requested (the contract's name, since 003).
-- Signup, GitHub, source-connection and experiment events wait for the
-- features they describe.
--
-- Only the two CHECK constraints change; existing rows satisfy the new
-- definitions. Idempotent. Apply after 003, BEFORE deploying the code that
-- writes these events.
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
    'deepen_analysis_clicked'
  )
);

alter table scan_events drop constraint if exists scan_events_card_only_on_card_events;
alter table scan_events add constraint scan_events_card_only_on_card_events check (
  (event_type in (
    'opportunity_opened',
    'evidence_viewed',
    'opportunity_feedback_submitted',
    'build_this_requested'
  )) = (card_index is not null)
);
