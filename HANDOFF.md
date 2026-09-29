# Gauntlet — Technical Handoff

Gauntlet is the "Product Scientist & Fast-Value Loop" from PRD v2 (Lean
MVP). Given a public product URL, it collects observable evidence from
the product's public pages, turns it into a normalized Evidence Packet,
and uses two Claude calls to produce 3–5 ranked, evidence-backed
improvement opportunities, each with a proposed experiment. This file
explains what is built, how it works and what it is made of. The README
is the detailed operational reference.

## 1. Scope implemented

PRD Build Orders **#0–#3**, plus the pieces needed to run the concierge
validation on real products:

| Build Order | What it is | Where |
|---|---|---|
| #0 Evidence contract | Evidence Packet, Opportunity Card and Reviewer checklist schemas | project doc `claude/gauntlet-evidence-contract-v0.md`, mirrored in `packages/core` |
| #1 Public URL Ingestion Engine | Fetch, discover, extract, normalize into an Evidence Packet | `packages/core` |
| #2 Product Scientist v0 + Reviewer/Critic | Two Claude calls: generate cards, then review them | `packages/core` |
| #3 Pre-auth Report UI | Public web app: scan without an account, see the report | `apps/web` |
| Additions | Scan quota, cited evidence on cards, "Build this" CTA, card ratings, funnel events, light/dark themes | `apps/web` |

Not started (by PRD sequencing): GitHub deep scan (#4), "Build this"
implementation packages (#5), production data adapters (#6), Experiment
Ledger (#7), real authentication.

## 2. Components

npm workspaces monorepo, TypeScript (ESM) throughout.

```
packages/core   Framework-agnostic pipeline. No build step: package
                exports point at src/index.ts and consumers compile it.
packages/cli    Local CLI (`scan`, `analyze`) with SQLite storage.
apps/web        Next.js 15 app on Vercel, Postgres (Supabase) storage.
```

**`packages/core`**

| Module | Responsibility |
|---|---|
| `fetcher.ts` | HTTP client with robots.txt checking, a per-host rate limit (500 ms between requests) and a 10 s timeout. |
| `page-discovery.ts` | From the homepage, follows same-origin links whose path or text matches keywords (pricing, plans, docs, help, faq, support, product, features, about...), up to 8 pages. Records unreachable pages with their reason. |
| `extractor.ts` | Static-HTML extraction with cheerio (no JavaScript execution). Emits evidence items of type `copy`, `ui_structure`, `cta_placement` and `pricing` (pricing only with a billing unit, so a bare "$100" is not counted). |
| `normalizer.ts` | Builds the Evidence Packet: product identity, surface map, evidence items with ids (E1, E2...), confidence metadata, and candidate pricing contradictions flagged for human review, never auto-resolved. |
| `evidence-packet.ts` | Zod schema for the packet, plus `hasInsufficientEvidence` / `describeInsufficientEvidence` (the zero-evidence guard). |
| `opportunity-card.ts` | Zod schema for cards and reports; `computeRankScore = impact × evidenceQuality ÷ effort` (each 1–3). |
| `llm-client.ts` | Anthropic SDK wrapper. Model `claude-sonnet-5`, `max_tokens` 16000 (the model spends part of the budget on thinking before the text block; 4096 truncated real responses). Honors `NODE_EXTRA_CA_CERTS` for TLS-intercepting networks. |
| `scientist.ts` | First Claude call. Must return 3–5 cards, exactly one `build_this`, and cite only evidence ids that exist in the packet. Invalid output gets one corrective retry with the exact validation error. Cards are ranked by `rankScore`. |
| `reviewer.ts` | Second Claude call. Applies the contract's four-question checklist to each card: `pass`, `downgrade_confidence` (can only lower, and lowers the evidence-quality score with it) or `drop`. Re-ranks survivors and re-promotes the top one to `build_this` if the original was dropped. Fails if every card is dropped. One corrective retry. |

**`apps/web`**

| Path | Responsibility |
|---|---|
| `app/page.tsx` | Landing page: URL input, category (AI SaaS / AI tool), starts a scan. |
| `app/api/scans/route.ts` | `POST /api/scans`: validates the URL (HTTPS only), checks the quota, creates the job, starts the pipeline in the background, returns `202 { id }`. |
| `app/api/scans/[id]/route.ts` | `GET /api/scans/:id`: returns the job (status, Evidence Packet, report, review records, error). 404 for unknown or malformed ids. |
| `app/api/scans/[id]/events/route.ts` | `POST /api/scans/:id/events`: records report-page events and card ratings (§4). |
| `app/scans/[id]/page.tsx` | Report page: polls every 2.5 s, shows the status tracker, then the cards. |
| `app/signup/page.tsx` | Placeholder that carries `?from=<job>` and `?card=<index>` for when real signup exists. |
| `lib/run-scan.ts` | The pipeline for one job, run inside Next.js `after()` (the function keeps running after the HTTP response). |
| `lib/store.ts`, `lib/db.ts` | Postgres access through Supabase's transaction pooler; TLS with Supabase's own CA embedded (`lib/supabase-ca.ts`). |
| `lib/rate-limit.ts` | Scan quota logic and client IP hashing. |
| `lib/events.ts` | Event and rating vocabulary, request schema, validation against the job. |
| `components/opportunity-card.tsx` | One card: evidence, rationale, experiment, actions. |
| `components/status-tracker.tsx` | Stage indicator (queued → scanning → analyzing → reviewing). |
| `components/theme-toggle.tsx` | Light/dark switch. |
| `app/globals.css` | Design tokens for both themes and all component styles. |

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
     validate the Evidence Packet.
   - **Zero-evidence guard**: if no evidence was collected (for example,
     the site answers the scanner with HTTP 403), the job fails right here
     with the real reason and no Claude call is made.
   - `analyzing`: Scientist call.
   - `reviewing`: Reviewer call.
   - `done`: report and review records stored, `scan_completed` recorded
     (best effort; a failed event write never fails a finished scan).
   - Any error at any stage sets `failed` with a specific message; a job is
     never left stuck in an intermediate status.
4. **Report page.** Polls `GET /api/scans/:id` every 2.5 s. The tracker
   advances at most one stage every 700 ms so fast stages are still shown
   in order. On `done` it renders the cards, the "Best next experiment"
   first, and records `report_viewed`.
5. **Interaction.** Each card has a "Build this" button (records
   `build_this_requested` and goes to the signup placeholder with the card)
   and a rating: obvious / useful / surprising / wrong / would act now
   (records `opportunity_feedback_submitted`).

A real scan in production takes about 2–3 minutes; the Vercel function
limit is 300 s (`maxDuration` on the Hobby plan).

## 4. Data model (Postgres)

Migrations live in `apps/web/lib/migrations/` and are applied by hand, in
order, in the Supabase SQL Editor. All are idempotent.

**`001_init.sql` — `scan_jobs`**: one row per scan. `id` (uuid), `url`,
`category`, `status`, `evidence_packet` (jsonb), `opportunity_report`
(jsonb), `review_records` (jsonb), `error_message`, timestamps. One wide
table because the web app only ever reads "the finished artifact for this
job".

**`002_scan_rate_limit.sql`**: adds `scan_jobs.client_ip_hash` plus an
index. The client IP is stored only as HMAC-SHA256 keyed with
`SCAN_IP_HASH_SECRET`, never in clear text.

**`003_scan_events.sql` — `scan_events`**: one row per funnel event.
`event_type` is one of the five events named in the contract's validation
plan: `scan_started`, `scan_completed`, `report_viewed`,
`opportunity_feedback_submitted`, `build_this_requested`. Card events carry
`card_index` (rank position) and a `card_title` snapshot; ratings carry
`rating`. A unique index on (scan, type, card, client hash) makes every
event idempotent per client; a new rating from the same client replaces
the earlier one. Check constraints reject a rating on a non-feedback
event, a card index on a non-card event, and unknown types. Rows cascade
on job deletion.

The README section "Measuring the concierge validation" has the SQL for
the funnel and for the contract's thresholds (top-3 usefulness, action
intent, `wrong` ratings as a proxy for false confidence).

## 5. Security and abuse controls

- **Scan quota**: 3 scans per client and 20 in total per rolling 24 h,
  counted from `scan_jobs` (failed scans count too). Configurable by env
  var. Clients are identified by `x-real-ip`, which Vercel overwrites to
  prevent spoofing. Missing or invalid quota configuration makes the
  endpoint refuse scans (500) instead of running without limits.
- **Event endpoint**: strict schema (only the three browser events; a
  client cannot send server events or set its own identity), accepted only
  for a finished report and an existing card, idempotent per client.
- **Rendering**: evidence source links are rendered only for `http(s)`
  URLs, with `rel="noopener noreferrer nofollow"`.
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
- **Themes**: every color is a CSS token defined for a dark and a light
  palette. With no choice stored the page follows the OS
  (`prefers-color-scheme`); the header switch sets `data-theme` on
  `<html>` and stores it in `localStorage`. A small inline script applies
  the stored choice before first paint, so there is no flash of the wrong
  theme. Storage failures are tolerated.
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
| `NODE_EXTRA_CA_CERTS` | local only | Needed on machines with TLS-intercepting security software; see README and `npm run verify-tls`. |

- Deploy: push to `main`; Vercel builds `apps/web` (Root Directory
  `apps/web`). **Apply any new migration before deploying the code that
  uses it.**
- Local: `cd apps/web && npm run dev`. Without Vercel in front, every
  local request shares one quota bucket; raise
  `SCAN_LIMIT_PER_CLIENT_PER_DAY` in `.env.local`.

## 8. Testing

`npm test` at the repo root runs all three workspaces (about 115 tests:
CLI 5, core 56, web 54). `npm run typecheck` and `npm run lint` are
expected to be clean.

- `packages/core`: fetcher, discovery, extractor, normalizer, Scientist,
  Reviewer and the zero-evidence guard, with fakes for HTTP and Claude.
- `apps/web`: component tests with jsdom and Testing Library (status
  tracker, cards and their actions, theme switch) and unit tests for the
  quota and event validation.
- Not in the automated suite: SQL behavior. The quota's concurrency
  guarantee (12 concurrent requests with a limit of 3 create exactly 3
  jobs; 5 without the advisory lock) and the events table's dedupe,
  upsert, constraints and threshold queries were verified by hand against
  a real Postgres 16.

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
| `@gauntlet/core` has no build step | Next.js transpiles it (`transpilePackages`); one source of truth for CLI and web. |

## 10. Known limitations and risks

1. **Dependency advisories**: `npm audit` reports 7. Six are dev-only
   tooling (vitest, vite, esbuild) that affect local dev servers, not the
   deployed app; one is Next.js via postcss (build-time CSS processing).
   All fixes need major upgrades (Next 16, Vitest 5); do them as one
   planned upgrade, never `npm audit fix --force`.
2. **No Postgres in CI**: the SQL guarantees above are not re-checked
   automatically. First CI improvement: a Postgres service container
   running those scenarios.
3. **No migration runner**: three hand-applied migrations; add a runner
   with a `schema_migrations` table before a fourth.
4. **No data-retention policy** (PRD §18): `scan_jobs` and `scan_events`
   are kept indefinitely.
5. **IP-based quota**: shared IPs share a quota and IPv6 rotation can
   partly evade the per-client limit; the global daily cap is the real
   cost ceiling. Move to per-account quotas once authentication exists.
6. **Scan coverage**: static HTML only, so JavaScript-rendered sites yield
   little evidence and bot-blocking sites fail with a clear message.
   Mature products often get 2–3 cards rather than 5.
7. **300 s function limit** (Vercel Hobby): a run that needs both
   corrective retries could approach it; move to Pro (800 s) only if a real
   run shows it.
8. **Signup is a placeholder**: it only carries the scan and card ids.

## 11. Next steps (PRD order)

1. **Concierge Validation Plan** (contract §4): run 10–20 real AI products
   through the app, collect ratings and "Build this" clicks, and measure
   against the thresholds (top-3 usefulness ≥70%, action intent ≥30%,
   signup-equivalent ≥20%, false confidence <10%).
2. Resolve the PRD §18 questions the validation raises, starting with
   data retention and supported product categories.
3. If the thresholds are met: authentication, then Build Order #4 (GitHub
   deep scan), #5 ("Build this" implementation packages), #6 (first
   production data adapter) and #7 (Experiment Ledger).
