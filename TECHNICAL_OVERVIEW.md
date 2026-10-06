# Gauntlet — Technical Overview

Gauntlet is the "Product Scientist & Fast-Value Loop" from PRD v2 (Lean
MVP). Given a public product URL, it collects observable evidence from
the product's public pages, turns it into a normalized Evidence Packet,
and uses two Claude calls to produce 3–5 ranked, evidence-backed
improvement opportunities, each with a proposed experiment. This file
explains what is built, how it works and what it is made of. The README
is the detailed operational reference.

## 1. Scope implemented

PRD Build Orders **#0–#5 and #7 (minimal)**, plus the pieces needed to run
the concierge validation on real products:

| Build Order | What it is | Where |
|---|---|---|
| #0 Evidence contract | Evidence Packet, Opportunity Card and Reviewer checklist schemas | project doc `claude/gauntlet-evidence-contract-v0.md`, mirrored in `packages/core` |
| #1 Public URL Ingestion Engine | Fetch, discover, extract, normalize into an Evidence Packet | `packages/core` |
| #2 Product Scientist v0 + Reviewer/Critic | Two Claude calls: generate cards, then review them | `packages/core` |
| #3 Pre-auth Report UI | Public web app: scan without an account, see the report | `apps/web` |
| Additions | Scan quota, cited evidence on cards, "Build this" CTA, card ratings, funnel events, light/dark themes | `apps/web` |
| Contract Amendment 1 | The product's own AI traces from a local Token Profiler as citable evidence (`A1, A2...`), CLI only | `packages/core`, `packages/cli` |
| #5 "Build this" handoff (Amendment 2) | Implementation package per card: objective, approach, feature flag, acceptance criteria, measurement, rollback, risks, coding-agent prompt | `packages/core`, `apps/web`, `packages/cli` |
| #7 Experiment Ledger, minimal (Amendment 2) | Every package starts a `planned` record; results and decisions recorded in the CLI and, for saved reports, in the web app | `packages/core`, `apps/web`, `packages/cli` |
| Accounts (PRD §8.6, §17) | Sign in with GitHub (Supabase Auth), workspaces per product, saving a report with proof of authorship, `/ledger` | `apps/web` |
| #4 GitHub deep scan (Amendment 3) | A read-only GitHub App connects a repository to a workspace; per card, a targeted read writes code evidence (C*), a refinement of the card and a repo-aware brief naming real files, private to the owner | `packages/core`, `apps/web` |

Not started: production data adapters (#6), execution adapter / PR creation (#8).

## 2. Components

npm workspaces monorepo, TypeScript (ESM) throughout.

```
packages/core   Framework-agnostic pipeline. No build step: package
                exports point at src/index.ts and consumers compile it.
packages/cli    Local CLI (`scan`, `analyze [--token-profiler]`) with SQLite storage.
apps/web        Next.js 15 app on Vercel, Postgres (Supabase) storage.
```

**`packages/core`**

| Module | Responsibility |
|---|---|
| `fetcher.ts` | HTTP client with robots.txt checking, a per-host rate limit (500 ms between requests) and a 10 s timeout. |
| `page-discovery.ts` | From the homepage, follows same-origin links whose path or text matches keywords (pricing, plans, docs, help, faq, support, product, features, about...), up to 8 pages. Records unreachable pages with their reason. |
| `extractor.ts` | Static-HTML extraction with cheerio (no JavaScript execution). Emits evidence items of type `copy`, `ui_structure`, `cta_placement` and `pricing` (pricing only with a billing unit, so a bare "$100" is not counted). |
| `normalizer.ts` | Builds the Evidence Packet: product identity, surface map, evidence items with ids (E1, E2...), confidence metadata, and candidate pricing contradictions flagged for human review, never auto-resolved. |
| `evidence-packet.ts` | Zod schema for the packet, plus `hasInsufficientEvidence` / `describeInsufficientEvidence` (the zero-evidence guard). Cross-field rules: `aiEvidence` is populated exactly when `sourceReliability` is `public_scan_plus_ai_traces`, and every citable id (E* and A*) is unique. `citableEvidenceIds()` lists them. |
| `token-profiler-adapter.ts` | Contract §1.6. `readTokenProfiler()` reads a local Token Profiler's HTTP API (sessions, events, flags, context analysis), validating every response. `buildAiEvidence()` deterministically maps it to `aiEvidence` items (usage profile, failure rate, one item per fired flag, context repetition) plus a `notEvaluable` list. `attachAiEvidence()` returns an enriched copy of a packet. |
| `opportunity-card.ts` | Zod schema for cards and reports; `computeRankScore = impact × evidenceQuality ÷ effort` (each 1–3). |
| `llm-client.ts` | Anthropic SDK wrapper. Model `claude-sonnet-5`, `max_tokens` 16000 (the model spends part of the budget on thinking before the text block; 4096 truncated real responses). Honors `NODE_EXTRA_CA_CERTS` for TLS-intercepting networks. |
| `scientist.ts` | First Claude call. Must return 3–5 cards, exactly one `build_this`, and cite only evidence ids that exist in the packet (E*, and A* when the packet carries AI evidence). Invalid output gets one corrective retry with the exact validation error. Cards are ranked by `rankScore`. |
| `action-package.ts` | "Build this" (contract §2.2–§2.3). `generateActionPackage()`: one Claude call (+1 corrective retry) writes the engineering parts; the card's hypothesis, experiment and cited evidence are copied in verbatim; rejects evidence the card doesn't cite and file-path-like components. `renderCodingAgentPrompt()` / `renderActionPackageMarkdown()`: templates over the validated package. `planExperimentRecord()` and `ExperimentRecordSchema` (ledger rules). |
| `repo-evidence.ts` | Contract §1.7. `RepoReader` (one repository at one commit), the code context schema (C* items pinned to a commit, line citations only in inspected files), `detectRepoSignals()` (no LLM: layout, languages, declared framework/AI/flag/analytics/test libraries, test files, CI/deployment, CODEOWNERS) and `candidatePaths()` (bounded list of readable source files). Strict `owner/name` validation. |
| `repo-analysis.ts` | Contract §2.4. `analyzeRepositoryForCard()`: one Claude call picks ≤12 files for the card (unknown paths dropped), a second writes code evidence whose quote must appear in the cited lines (Gauntlet copies the lines) and the refinement (confidence, effort, files to change, experiment notes, contradictions, still missing). Corrective retry on any violation. |
| `github-repo-reader.ts` | GitHub REST `RepoReader` with an issued token: commit SHA of the branch, recursive tree, raw files at that commit (size-bounded, binary dropped); typed errors (unauthorized, forbidden, not found, rate limited, failed). |
| `reviewer.ts` | Second Claude call. Applies the contract's four-question checklist to each card: `pass`, `downgrade_confidence` (can only lower, and lowers the evidence-quality score with it) or `drop`. Re-ranks survivors and re-promotes the top one to `build_this` if the original was dropped. Fails if every card is dropped. One corrective retry. |

**`apps/web`**

| Path | Responsibility |
|---|---|
| `app/page.tsx` | Landing page; renders the single-page scan flow. |
| `app/api/scans/route.ts` | `POST /api/scans`: validates the URL (HTTPS only), checks the quota, creates the job, starts the pipeline in the background, returns `202 { id }`. |
| `app/api/scans/[id]/route.ts` | `GET /api/scans/:id`: returns the job (status, Evidence Packet, report, review records, error). 404 for unknown or malformed ids. |
| `app/api/scans/[id]/events/route.ts` | `POST /api/scans/:id/events`: records report-page events and card ratings (§4). |
| `app/scans/[id]/page.tsx` | Shared/refreshed report link; renders the same flow, which reads the scan id from the address. |
| `components/scan-experience.tsx` | The whole flow in place: URL form → compact bar + stage tracker + activity line → report. Address moves to `/scans/<id>` via `history.pushState` (no reload); Back returns to the form. |
| `components/scan-report.tsx` | The finished report and its funnel/feedback events. |
| `app/api/scans/[id]/cards/[index]/package/route.ts` | `POST` starts (or returns) the card's implementation package; `GET` for polling. |
| `lib/build-package.ts` | Background package generation inside `after()`; every failure ends in `failed` with a plain message. |
| `components/action-package-panel.tsx` | The brief inside a card: progress line, then the package with "Copy prompt for your coding agent" and "Download brief (.md)". |
| `middleware.ts` | Refreshes the Supabase session on page requests (no-op without auth configured). |
| `lib/auth/` | `config.ts` (optional auth config, same-site redirect guard), `server.ts` (`getSessionUser()` via `getClaims()`), `browser.ts`. |
| `app/signup/page.tsx`, `components/sign-in-panel.tsx` | Sign in with GitHub; returns to the report the visitor came from. |
| `app/auth/callback/route.ts`, `app/auth/signout/route.ts` | OAuth code exchange (+ `signup_completed`), sign-out (POST only). |
| `app/api/scans/[id]/claim`, `.../viewer`, `.../cards/[index]/experiment` | Save a scan to the workspace (claim token), what the viewer may do, owner-only ledger updates. |
| `lib/accounts.ts`, `lib/claim-storage.ts`, `lib/use-viewer.ts` | Claim tokens and canonical product URLs; the browser's copy of the token; viewer state and the automatic save after sign-in. |
| `components/experiment-tracker.tsx`, `app/ledger/page.tsx` | Ledger tracking under a brief; the user's experiments. |
| `app/reports/page.tsx`, `components/saved-reports.tsx` | The user's saved reports. |
| `components/account-nav.tsx`, `components/site-nav.tsx` | Header navigation: the server part reads the session, the client part renders the links (current area marked) and the narrow-screen menu. |
| `lib/github-app.ts`, `lib/github-state.ts` | The GitHub App: config, App JWT (RS256), one-repository read-only installation tokens, the OAuth code exchange and listing what the user can read; the httpOnly state cookie for the connection round trip. |
| `app/api/github/connect`, `app/api/github/callback` | Start the connection from a report (install or authorize, `github_connect_started`) and finish it (verify state, store what the user can read, `github_connected`). |
| `app/api/scans/[id]/repository`, `.../cards/[index]/repo-brief` | Owner-only: connect/disconnect the workspace's repository; start and poll the repo-aware brief for a card. |
| `lib/repo-store.ts`, `lib/build-repo-brief.ts` | Data access for migration 008 (access lists, workspace repositories, repo briefs with their claim/quota/retry rules); the background job (token → read → analysis → package) and its user-facing error messages. |
| `lib/use-repository.ts`, `components/repo-connection.tsx`, `components/repo-brief-panel.tsx` | The owner's repository connection under a brief, and the repo-aware brief view (what the code changes, code evidence, the rewritten brief). |
| `components/activity-line.tsx` | The live "what it's doing now" line under the tracker. |
| `lib/scan-client.ts` | Polling hook, job response type, stage phrases and the activity-line selection rule. |
| `lib/progress.ts` | Serialized, best-effort progress writer used by the pipeline. |
| `lib/run-scan.ts` | The pipeline for one job, run inside Next.js `after()` (the function keeps running after the HTTP response). |
| `lib/store.ts`, `lib/db.ts` | Postgres access through Supabase's transaction pooler; TLS with Supabase's own CA embedded (`lib/supabase-ca.ts`). |
| `lib/rate-limit.ts` | Scan quota logic and client IP hashing. |
| `lib/events.ts` | Event and rating vocabulary, request schema, validation against the job. |
| `components/opportunity-card.tsx` | One card: evidence, rationale, experiment, actions. |
| `components/status-tracker.tsx` | Stage indicator (queued → scanning → analyzing → reviewing). |
| `components/theme-toggle.tsx` | Light/dark switch. |
| `app/globals.css` | Design tokens for both themes and all component styles. |

**`packages/cli`**

| Path | Responsibility |
|---|---|
| `src/index.ts` | `scan` and `analyze` commands. |
| `src/ledger.ts` | `gauntlet build` (package + planned ledger record, never generated twice for a card) and `gauntlet ledger` / `ledger record` (transition rules). |
| `src/token-profiler-option.ts` | `--token-profiler` flags → a validated query (window, connectors; coding-agent connectors refused), and the enrichment step that saves the new packet. |
| `src/store/sqlite.ts` | SQLite store with inline, tracked migrations (`001_init`, `002_opportunity_reports`, `003_packet_lineage`). |

## 3. How a scan works

1. **Request.** The landing page sends `POST /api/scans { url, category }`.
2. **Quota and job creation, in one transaction.** Under a Postgres
   advisory lock, the server counts the client's scans and all scans in
   the last 24 h. If either limit is reached it returns `429` with
   `Retry-After` and a readable message. Otherwise it inserts the
   `scan_jobs` row (status `queued`) and a `scan_started` event, commits,
   and responds `202` with the job id.
3. **Pipeline (background, `lib/run-scan.ts`).** Status moves through:
   - `scanning`: fetch and discover pages, extract evidence, build and
     validate the Evidence Packet. Each page fetch reports a progress
     line ("Reading /pricing (3 of 8)").
   - **Zero-evidence guard**: if no evidence was collected (for example,
     the site answers the scanner with HTTP 403), the job fails right here
     with the real reason and no Claude call is made.
   - `analyzing`: Scientist call (progress: "Analyzing N pieces of
     evidence from M pages").
   - `reviewing`: Reviewer call (progress: "Reviewing N candidate
     opportunities").
   - Progress is written to `scan_jobs.progress` as `{status, message}`,
     serialized and best-effort: a failed progress write is logged and
     never fails the scan.
   - `done`: report and review records stored, `scan_completed` recorded
     (best effort; a failed event write never fails a finished scan).
   - Any error at any stage sets `failed` with a specific message and
     records `scan_failed` (one `failJob` helper for every failure path); a
     job is never left stuck in an intermediate status.
4. **One page, three states.** Submitting the form morphs the URL field
   into a compact bar with the scanned site, and the address becomes
   `/scans/<id>` without a reload. The page polls `GET /api/scans/:id`
   every 2.5 s. The stage tracker advances at most one stage every 700 ms
   so fast stages are still shown in order. Under it, an activity line
   shows the pipeline's own progress message, but only while the job is in
   that stage and that stage is the one displayed; during the two Claude
   calls it alternates with short stage phrases ("Running through design
   choices", "Checking every claim against the evidence"). On `done` the
   progress view gives way to the report in place, "Best next experiment"
   first, and `report_viewed` is recorded. On `failed` the form returns
   with the reason and the URL pre-filled ("Try again"). "Scan another"
   returns to the empty form.
5. **Interaction.** Each card has a "Build this" button (records
   `build_this_requested` and goes to the signup placeholder with the card)
   and a rating: obvious / useful / surprising / wrong / would act now
   (records `opportunity_feedback_submitted`). Opening a card's Evidence or
   Proposed experiment records `evidence_viewed` / `opportunity_opened`,
   and "Make this recommendation smarter" records
   `deepen_analysis_clicked`.

A real scan in production takes about 2–3 minutes; the Vercel function
limit is 300 s (`maxDuration` on the Hobby plan).

### Adding the product's AI traces (CLI only)

`gauntlet analyze <packetId> --token-profiler http://localhost:4317 --tp-connector <name> [--tp-since] [--tp-until]`:

1. Flags are validated before anything is read: a URL, at least one
   connector, no coding-agent connector (`claude-code`,
   `claude-code-desktop`, `codex-cli`, `codex-desktop`, `opencode`), and a
   valid window (default: the 30 days ending now; date-only bounds cover
   the whole UTC day). The Claude client is created next, so a missing
   key fails before anything is saved.
2. The adapter lists each connector's sessions, keeps those that
   *started* in the window (newest first, at most 500), and reads each
   one's events, flags and context analysis. A session that can't be read
   is skipped and named in `notEvaluable`; if none can be read, the run
   stops.
3. `buildAiEvidence()` produces, in order: `A1` usage profile (tokens by
   provider/model), `A2` failure rate, one `anomaly_flag` per fired flag
   (sessions affected, observed range, threshold, example session ids),
   and `context_repetition` (re-sent tokens by component type). Confidence
   is `high` only when the token counts are provider-reported or exactly
   derived; context attribution is always `medium`. Only aggregates,
   flags and component types with token counts are kept: no prompt or
   response content, no component hashes.
4. `notEvaluable` names each Token Profiler check that could not run on
   this data, using Token Profiler's own preconditions: `SESSION_OUTLIER`
   needs 20 other sessions per connector; `INPUT_BLOAT` / `OUTPUT_BLOAT`
   need 20 comparable invocations per model; `REASONING_HEAVY` needs
   reasoning tokens; `RETRY_HEAVY` needs attempt numbers;
   `CONTEXT_REPEAT`, `HISTORY_BLOAT` and `SCHEMA_BLOAT` need context
   components of the right type.
5. The enriched copy (`sourceReliability: public_scan_plus_ai_traces`, the
   coverage appended to `missingEvidenceSummary`) is validated against the
   contract and saved as a new packet with `derived_from_packet_id`
   pointing at the original, which is never modified. The Scientist and
   Reviewer then run on the new packet; both see the AI evidence and its
   `notEvaluable` list, and the Reviewer's first checklist question fails a
   card that treats partial trace coverage as complete.

### "Build this" (implementation package + ledger record)

1. "Build this" on a card records `build_this_requested` and calls `POST
   /api/scans/:id/cards/:index/package` (finished report and existing card
   only).
2. `claimActionPackage` decides atomically, under an advisory lock: a ready
   or in-progress package is returned as is; a failed (or stuck past 10
   minutes) one is restarted while fewer than 3 attempts were made; a new
   one must fit the package quota (5 per client, 40 in total per 24 h,
   separate from scans) and is inserted as `generating`. Concurrent clicks
   therefore cost one Claude call.
3. `after()` runs `generateActionPackage`. The draft is validated against
   the contract plus grounding checks (only the card's evidence; likely
   components in product terms, never files or code paths, with one
   corrective retry). The code-path check (`looksLikeCodePath`) flags file
   extensions and slashed words that look like code (`./x`, `x/`, three or
   more segments, or a source directory such as `src/`, `components/`), not
   any slash: a production run was rejected for "content block/snippet".
   On success, one transaction stores the package, creates its `planned`
   `experiment_records` row and records `action_package_generated` and
   `experiment_created`.
4. The card polls `GET` every 3 s and then shows the brief: objective,
   feature flag, approach, acceptance criteria, measurement, rollback,
   non-goals, risks, likely components, what a repository connection would
   add (with a link through signup that keeps the scan and card), "Copy
   prompt for your coding agent" and "Download brief (.md)". A limit or
   failure is shown in the card; failures can be retried.
5. In the CLI, `gauntlet build <reportId> [--card n]` does the same against
   SQLite and `gauntlet ledger record <id> --running | --decision
   ship|iterate|discard --result "..." [--outcome "..."]` completes the
   record. A decided record is final.

### Accounts

1. Signing in (`/signup?from=<scan>`) starts GitHub OAuth through Supabase
   Auth (`signup_started` when it starts from a report). The callback
   exchanges the code for a session cookie, records `signup_completed`, and
   returns to the report (same-site paths only).
2. The report asks `GET /api/scans/:id/viewer` what the visitor may do. A
   signed-in visitor whose browser holds the scan's claim token (it ran the
   scan) saves it automatically with `POST /api/scans/:id/claim`; the
   token is then forgotten. Claiming is atomic: two accounts racing for one
   scan resolve to one owner.
3. Under a brief, the owner tracks the experiment (`POST
   .../experiment`): the shared rules in `@gauntlet/core` decide what is
   allowed, the write is optimistic (a second tab's conflicting decision
   gets 409), and a decision records `experiment_decision_recorded`.
4. `/ledger` lists the user's experiments, then their saved reports (the
   way back to a report to start the next experiment).
5. Without `NEXT_PUBLIC_SUPABASE_*`, none of this appears and nothing else
   changes.

### GitHub deep scan (repo-aware brief)

1. **Connect.** Under a brief, the owner clicks "Connect GitHub"
   (`/api/github/connect?scan=`): an httpOnly state cookie is set and the
   owner installs the Gauntlet App on the repositories they choose
   (Contents read-only), or, if it is already installed, only authorizes
   it. GitHub returns to `/api/github/callback`: the state must match the
   cookie; the OAuth code becomes the user's token, used once to list the
   App's installations and the repositories *this user* can read (GitHub's
   intersection), which replace any earlier list; the token is dropped.
2. **Choose.** Back on the report, the owner picks the product's
   repository from that list (`POST /api/scans/:id/repository`); one per
   workspace. Switching repositories deletes the briefs written from the
   previous one; disconnecting deletes the link and all of them.
3. **Write.** "Write a repo-aware brief" (`POST .../repo-brief`) needs the
   card's public brief first (so its ledger record exists). It is claimed
   like packages (advisory lock, 10 per account and 60 in total per 24 h,
   3 attempts, stuck after 10 minutes). In `after()`: an installation
   token for that one repository (1 hour) → the default branch's current
   commit → `analyzeRepositoryForCard` (two Claude calls) → the analysis is
   stored (a retry reuses it) → `generateActionPackage` with the analysis
   (codeContext `github`, may name only inspected files and cite C*) →
   `repo_brief_generated`.
4. **Read.** The owner sees what the code changes (revised confidence and
   effort with their C* refs, files to change, experiment notes,
   contradictions, still open), the code evidence with the cited lines,
   and the rewritten brief with "Copy prompt" and download. Nothing of it
   is in the public report or its API.

## 4. Data model (Postgres)

Migrations live in `apps/web/lib/migrations/` and are applied with
`npm run migrate --workspace=web` (runner in `lib/migrate.ts`). The runner
records each applied file with its SHA-256 in `schema_migrations`, applies
each pending file in its own transaction under an advisory lock, and
stops if an applied file was later edited (a change belongs in a new
file). Files must be numbered consecutively (`NNN_snake_case.sql`). Every
migration so far is idempotent, so a database migrated by hand before the
runner existed is adopted by simply running it.

**`001_init.sql` — `scan_jobs`**: one row per scan. `id` (uuid), `url`,
`category`, `status`, `evidence_packet` (jsonb), `opportunity_report`
(jsonb), `review_records` (jsonb), `error_message`, timestamps. One wide
table because the web app only ever reads "the finished artifact for this
job".

**`002_scan_rate_limit.sql`**: adds `scan_jobs.client_ip_hash` plus an
index. The client IP is stored only as HMAC-SHA256 keyed with
`SCAN_IP_HASH_SECRET`, never in clear text.

**`003_scan_events.sql` — `scan_events`**: one row per funnel event.
As created, `event_type` is one of the five events named in the
contract's validation plan: `scan_started`, `scan_completed`,
`report_viewed`, `opportunity_feedback_submitted`, `build_this_requested`
(004 adds four more). Card events carry
`card_index` (rank position) and a `card_title` snapshot; ratings carry
`rating`. A unique index on (scan, type, card, client hash) makes every
event idempotent per client; a new rating from the same client replaces
the earlier one. Check constraints reject a rating on a non-feedback
event, a card index on a non-card event, and unknown types. Rows cascade
on job deletion.

**`004_more_scan_events.sql`**: widens the two check constraints for four
more events from PRD §11: `scan_failed` (server), `deepen_analysis_clicked`
(report-level), `evidence_viewed` and `opportunity_opened` (card events).
PRD's `build_this_clicked` is `build_this_requested` here. Existing rows
satisfy the new constraints.

**`005_scan_progress.sql`**: adds nullable `scan_jobs.progress` (jsonb,
`{status, message}`), the activity line's source. Writes to it are
best-effort, so code deployed before this migration still scans, only
without the activity line.

**`006_action_packages.sql`**: `action_packages` (one per scan and card;
`status` generating/ready/failed, `package` jsonb present exactly when
ready, `attempts`, `client_ip_hash` for the package quota) and
`experiment_records` (one per package; `status`, hypothesis, evidence
snapshot, change, experiment, result, decision, outcome; a decision exists
exactly when decided, and always with its result). Both cascade with their
scan. Widens the event constraints for `action_package_generated` and
`experiment_created` (card events).

**`007_accounts.sql`**: `workspaces` (owner user id, canonical product
URL, name; one per product per account); `scan_jobs.claim_token_hash`,
`workspace_id`, `claimed_at`; `experiment_records.decided_by`; events
`signup_started`, `signup_completed` (report-level) and
`experiment_decision_recorded` (card event). User ids are Supabase Auth
ids stored without a foreign key into the `auth` schema, so the schema
also runs on plain Postgres (CI).

**`008_github.sql`**: `github_installations` and `github_repository_access`
(per user, what they proved they can read at connection; replaced on each
reconnection), `workspace_repositories` (one repository per workspace) and
`repo_briefs` (per scan and card: status, stage reading/writing, analysis
jsonb, package jsonb present exactly when ready and only with an analysis,
attempts, requested_by for the per-account quota). Events
`github_connect_started`, `github_connected` (report-level) and
`repo_brief_generated` (card event). No GitHub token is stored anywhere.

The README section "Measuring the concierge validation" has the SQL for
the funnel and for the contract's thresholds (top-3 usefulness, action
intent, `wrong` ratings as a proxy for false confidence).

## 5. Security and abuse controls

- **Scan quota**: 3 scans per client and 20 in total per rolling 24 h,
  counted from `scan_jobs` (failed scans count too). Configurable by env
  var. Clients are identified by `x-real-ip`, which Vercel overwrites to
  prevent spoofing. Missing or invalid quota configuration makes the
  endpoint refuse scans (500) instead of running without limits.
- **Event endpoint**: strict schema (only the report-page events; a
  client cannot send server events or set its own identity), accepted only
  for a finished report and an existing card, idempotent per client.
- **Rendering**: evidence source links are rendered only for `http(s)`
  URLs, with `rel="noopener noreferrer nofollow"`.
- **GitHub**: a GitHub App with Contents read-only on the repositories the
  user selects. No token is stored: the user's token is used once at
  connection; each deep scan mints a one-hour token restricted to one
  repository. The connection round trip is bound to the browser by an
  httpOnly state cookie; a repository can be connected only if the user
  proved they can read it. Code evidence is owner-only and never part of
  the shareable report or its API (PRD §8.6, §14); disconnecting deletes
  it. Repository names are validated against GitHub's rules before any URL
  is built.
- **Secrets**: never committed; `.env*`, `*.pem` and `*.cer` are
  git-ignored. Configuration errors are logged server-side and returned to
  visitors as generic messages.

## 6. Web UI

- **Cards** show: change surface, title, hypothesis, why it matters,
  impact / effort / confidence / evidence quality with their rationales,
  what the public surface shows versus what connected data would confirm,
  the cited evidence (observation, excerpt, source link, confidence) and
  the full experiment (control, variant, audience, primary metric,
  guardrails, stopping rule). The PRD also lists "assumptions"; the
  contract has no such field, so it is not shown.
- **Themes**: every color is a CSS token defined for a light and a dark
  palette. Light is the default for everyone, whatever the OS prefers; the
  header switch sets `data-theme` on `<html>` and stores it in
  `localStorage`. A small inline script applies the stored choice before
  first paint, so there is no flash of the wrong theme. Storage failures
  are tolerated.
- **Navigation**: the header links every area so nothing needs Back: New
  scan, Reports (`/reports`, saved reports) and Experiments (`/ledger`)
  for signed-in users, and Sign in / Sign out. The current area is marked;
  under 720px the links fold into a "Menu" panel (closes on navigation,
  Escape or a click outside).
- **Layout**: one centered column of 1040px (`--page-width`); on screens
  of 900px and up a brief's sections flow into two columns.
- Fonts: Fraunces (display) and Inter (body), loaded with a plain
  `<link>` rather than `next/font`, so builds do not fetch fonts through
  Node on TLS-intercepting networks.

## 7. Configuration and deployment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **transaction pooler** connection string (port 6543). |
| `ANTHROPIC_API_KEY` | yes | Claude API key. |
| `SCAN_IP_HASH_SECRET` | yes | Key for hashing client IPs (long random string). |
| `SCAN_LIMIT_PER_CLIENT_PER_DAY` | no | Default 3. |
| `SCAN_LIMIT_GLOBAL_PER_DAY` | no | Default 20. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | no | Turn on accounts (Supabase Auth, GitHub). Public values; never the secret key. Setup steps in the README. |
| `PACKAGE_LIMIT_PER_CLIENT_PER_DAY` | no | Default 5. Implementation briefs per client per 24 h. |
| `PACKAGE_LIMIT_GLOBAL_PER_DAY` | no | Default 40. Implementation briefs in total per 24 h. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` | no | Turn on the GitHub deep scan (needs accounts). Server-only secrets. Setup in the README. |
| `REPO_BRIEF_LIMIT_PER_USER_PER_DAY`, `REPO_BRIEF_LIMIT_GLOBAL_PER_DAY` | no | Defaults 10 and 60. Repo-aware briefs per account and in total per 24 h. |
| `CRON_SECRET` | yes, for maintenance | Authorizes the daily maintenance endpoint; Vercel Cron sends it automatically. At least 16 characters. Without it the endpoint refuses every call. |
| `SCAN_RETENTION_DAYS` | no | Default 180, minimum 30. Scans older than this are deleted with their events. |
| `MIGRATION_DATABASE_URL` | no | Database for `npm run migrate`; defaults to `DATABASE_URL`. |
| `DATABASE_SSL` | tests only | `disable` turns TLS off, and is refused for any host other than localhost. CI and local test databases only. |
| `NODE_EXTRA_CA_CERTS` | local only | Needed on machines with TLS-intercepting security software; see README and `npm run verify-tls`. |

- Deploy: push to `main`; Vercel builds `apps/web` (Root Directory
  `apps/web`). **Run `npm run migrate --workspace=web` against Supabase
  before deploying code that needs a new migration.**
- **Daily maintenance** (`apps/web/vercel.json` cron → `GET
  /api/cron/maintenance`, 07:17 UTC): fails scans stuck in flight past 10
  minutes, clears client IP hashes (scans and packages) older than 48 h,
  and deletes anonymous scans older than `SCAN_RETENTION_DAYS` with their
  events; scans saved to a workspace are kept. Idempotent.
- **Stuck scans** also end on their own: the polling endpoint fails a scan
  that is still in flight 10 minutes after it was created (the pipeline is
  capped at 300 s, so it can no longer finish), records `scan_failed`, and
  the page shows the reason with "Try again".
- **CI** (`.github/workflows/ci.yml`, every push and PR): typecheck, lint,
  tests, CLI and web builds; and a Postgres 16 job that runs the
  migrations twice and the database integration tests.
- Local: `cd apps/web && npm run dev`. Without Vercel in front, every
  local request shares one quota bucket; raise
  `SCAN_LIMIT_PER_CLIENT_PER_DAY` in `.env.local`.

## 8. Testing

`npm test` at the repo root runs all three workspaces (about 370 tests:
CLI 35, core 152, web 181), plus 40 database integration tests. `npm run typecheck` and `npm run lint` are
expected to be clean.

- `packages/core`: fetcher, discovery, extractor, normalizer, Scientist,
  Reviewer and the zero-evidence guard, with fakes for HTTP and Claude.
- Token Profiler integration: the adapter against a fake HTTP API (window
  filtering, every failure mode, partial session failures), the evidence
  builder's numbers and `notEvaluable` rules, the packet schema's
  cross-field rules, A* citations in the Scientist and Reviewer, the CLI
  flag validation, the enrichment's lineage and the `003` migration on an
  existing database. Verified end to end against a real Token Profiler
  build loaded with 114 synthetic product invocations, up to the Claude
  call.
- Single-page flow: the progress writer's ordering and failure handling,
  the activity-line rule (a message never appears under the wrong stage)
  and its rotation; the full flow verified in Chromium against a
  production build with a mocked API: morph, address change, each stage's
  line, report in place, refresh, Back/Forward, "Scan another", a failed
  scan, mobile width and reduced motion, in both themes.
- `apps/web`: component tests with jsdom and Testing Library (status
  tracker, cards and their actions, theme switch, repository connection
  and repo-aware brief) and unit tests for the quota and event validation.
- GitHub deep scan: deterministic signals on a sample monorepo (and on
  this repository), candidate bounding, selection and analysis validation
  (invented paths, misquoted lines, id sequence, unknown refs, uninspected
  files), corrective retries, the GitHub reader against a fake API (every
  HTTP failure, path encoding, size and binary limits, name validation),
  the App JWT signature, token scoping, the OAuth exchange, pagination,
  the state cookie, every route's authorization, and the owner flow in
  Chromium against a production build (connect, pick, write, read) in both
  themes and at mobile width.
- Database integration tests (`apps/web/tests-db`, `npm run test:db`):
  the migration runner (fresh database, adopting a hand-migrated one with
  data, edited-file refusal, rollback of a failing file, concurrent
  runners), the scan quota under 12 concurrent requests, event dedupe,
  rating upsert and constraints, cascade deletes, progress, stale-scan
  expiry, the retention purge, and packages (10 concurrent clicks start one
  generation, package quota, retry cap, stuck generations, ledger record
  and events written exactly once, constraints, cascades), and accounts
  (claim tokens, one workspace per product, two accounts racing for one
  scan, the ledger flow with its event, two tabs racing to decide, saved
  scans surviving the purge), and the GitHub deep scan (access replaced on
  reconnection, connecting only readable repositories, briefs deleted on
  switch and disconnect, concurrent claims starting one generation, retry
  cap reusing the stored analysis, stuck briefs, per-account quota, the
  ready-needs-analysis constraint, cascades). Each file uses its own throwaway
  database. Run locally with
  `TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres DATABASE_SSL=disable npm run test:db --workspace=web`.

## 9. Technical decisions

| Decision | Reason |
|---|---|
| Async job + polling instead of one long request | The pipeline can exceed a single request's time budget; `after()` keeps the work running after the response. |
| Reviewer/Critic as a second Claude call | The contract's checklist runs on every report instead of by hand. |
| Zero-evidence scans fail before any Claude call | With no evidence the Scientist cannot satisfy "cite real evidence ids", and would fail with a misleading validation error after two paid calls. |
| Bot-blocking sites are an accepted v0 limitation | A headless browser adds cost and time against the 300 s ceiling; spoofing a browser user agent would bypass the site's intent. |
| Dropped cards are not shown, only counted | Shorter reports are the Reviewer working as the contract intends. |
| Quota counted from Postgres, no new service | Bounded cost on a public endpoint without adding infrastructure; numbers sized to a 10–20-product validation round. |
| IPs stored as keyed HMAC | An unkeyed hash of an IPv4 address can be brute-forced; data retention is still undefined. |
| Events and ratings in the app's own Postgres | No analytics vendor before validation; PostHog remains the PRD's candidate first data adapter. |
| Token Profiler integration through the CLI only | The hosted app cannot reach a local dashboard, and trace-derived evidence must not appear in public reports (PRD §8.6). |
| A new packet for trace-enriched analysis | The public-scan packet stays a faithful record of the public scan; lineage links the two. |
| Deterministic trace adapter, no LLM summarization | Every A* number is reproducible from Token Profiler's data. |
| `notEvaluable` instead of silence | An unevaluated check must not read as "no problem found". |
| Supabase Auth, GitHub sign-in only | "Standard infrastructure" (PRD §9) on the Supabase project already in use; GitHub is the PRD's first repository provider. Email needs a custom SMTP provider (Supabase's default only reaches the project team, 2/hour). |
| `getClaims()` on the server, never `getSession()` | Verifies the token's signature on each call (Supabase guidance). Next's control-flow errors are rethrown so pages that read the session are never prerendered as signed out. |
| Claim token to save a report | A public report link must not let anyone take ownership; only the browser that ran the scan holds the token, and only its hash is stored. |
| Ledger rules shared in `@gauntlet/core` | The CLI and the web app can't disagree about what a valid transition is. |
| Accounts optional at runtime | Without the Supabase variables the app behaves exactly as before; a misconfiguration can't take scans down. |
| Package fields the card already settled are copied, not regenerated | The brief can't drift from the reviewed experiment; the model only writes what the card doesn't have. |
| No file names until a repository is connected | A brief written from the public site that names files would be invented; path-like components are rejected. With a repository, only inspected files may be named. |
| Prompt and Markdown rendered by templates | They always match the validated package. Answers PRD §18: package and coding-agent prompt. |
| One package per card, claimed before the Claude call | Concurrent clicks and reloads never pay twice; separate package quota bounds cost. |
| Ledger decisions in the CLI until accounts exist | Recording a decision needs an identity; anonymous web visitors only create `planned` records. |
| Migration runner with checksums instead of hand-applied SQL | A forgotten or edited migration is caught before it reaches production; concurrent runs are serialized. |
| Retention: IP hashes 48 h, scans 180 days | The quota only needs 24 h of IP hashes; 180 days covers a validation round and its follow-up. Closes PRD §18's retention question. |
| Stuck scans failed by the polling endpoint, not only the cron | A visitor watching a killed scan gets an answer within one poll, not the next day. |
| `DATABASE_SSL=disable` only for localhost | CI needs a plain local Postgres; refusing it for any other host means it can never turn TLS off against Supabase. |
| GitHub App, not an OAuth `repo` scope | `repo` grants read and write to every repository; the App reads only Contents, only where installed, and is revoked by uninstalling (PRD §8.6). |
| No stored GitHub tokens | The user's token proves access once; one-hour, one-repository installation tokens are minted per deep scan. Nothing to leak at rest. |
| Targeted retrieval, at most 12 files per card | PRD §8.7 ("never require full-repo embedding/indexing"); bounded cost and context (PRD §14). |
| Deterministic signals before the model | Stack, flag and analytics libraries and ownership are facts read from manifests, reproducible and always grounded. |
| Gauntlet copies cited lines; the model only quotes | A citation is verified to exist in the file; the excerpt shown is the file's own text. |
| Repo-aware brief is a second, private package | The public report stays shareable; the reviewed card and its ledger record are never rewritten (contract Amendment 3). |
| Analysis stored before the package step | A retry after a failed package step doesn't re-read the repository or repeat two Claude calls (PRD §14 "resumable"). |
| `@gauntlet/core` has no build step | Next.js transpiles it (`transpilePackages`); one source of truth for CLI and web. |

## 10. Known limitations and risks

1. **Dependency advisories**: `npm audit` reports 7. Six are dev-only
   tooling (vitest, vite, esbuild) that affect local dev servers, not the
   deployed app; one is Next.js via postcss (build-time CSS processing).
   All fixes need major upgrades (Next 16, Vitest 5); do them as one
   planned upgrade, never `npm audit fix --force`.
2. **Retention of event IP hashes**: `scan_events.client_ip_hash` is kept
   until its scan is deleted (180 days), because it is part of the
   per-client dedupe key; clearing it early could merge distinct visitors'
   events. Revisit if a shorter window is required.
3. **Maintenance runs once a day** (Vercel Hobby cron limit). Stuck scans
   don't depend on it (the polling endpoint ends them), but the purge does.
4. **IP-based quota**: shared IPs share a quota and IPv6 rotation can
   partly evade the per-client limit; the global daily cap is the real
   cost ceiling. Move to per-account quotas once authentication exists.
5. **Scan coverage**: static HTML only, so JavaScript-rendered sites yield
   little evidence and bot-blocking sites fail with a clear message.
   Mature products often get 2–3 cards rather than 5.
6. **300 s function limit** (Vercel Hobby): a run that needs both
   corrective retries could approach it; move to Pro (800 s) only if a real
   run shows it.
7. **Accounts are GitHub-only** and quotas are still per IP, not per
   account. A report can only be saved from the browser that ran it
   (scans created before accounts existed can't be saved).
8. **GitHub deep scan scope**: GitHub only; the default branch at the time
   of the request; at most 12 files (≤800 lines, ≤60 KB each) per card, so
   code outside them is not seen; trees over GitHub's recursive limit are
   partial (recorded). Declared dependencies are not proof of use on a
   given path. Access lists are refreshed only on reconnection; access
   removed on GitHub surfaces as a clear error at the next deep scan.
   Verified once in production (2026-10-06) on this repository: it picked
   the right files, found two facts the public scan had wrong (an existing
   placeholder, a second form field) and lowered confidence accordingly.
9. **Token Profiler coverage**: AI evidence covers only the chosen
   connectors and window, and at most 500 sessions. Token Profiler has no
   date filter, so every session of a connector is listed and filtered
   locally. Product traces must arrive through a non-coding-agent
   connector (`opentelemetry`, `file`, `hermes`); not yet run against a
   real product's traces.

## 11. Next steps (PRD order)

1. **Concierge Validation Plan** (contract §4): run 10–20 real AI products
   through the app, collect ratings and "Build this" clicks, and measure
   against the thresholds (top-3 usefulness ≥70%, action intent ≥30%,
   signup-equivalent ≥20%, false confidence <10%).
2. Resolve the PRD §18 questions the validation raises, starting with
   supported product categories (data retention is decided; see §7).
3. Build Order #6 (first production data adapter; PostHog by default), chosen
   by what the concierge round shows (contract §6).
