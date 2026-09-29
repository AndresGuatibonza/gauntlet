# Gauntlet — Handoff

**Written:** 2026-09-29, at the end of Andres Guatibonza's engagement with
Starbound Scaling (through 2026-09-30). **Audience:** whoever picks up
Gauntlet next. The README is the reference for *how things work*; this
file is the short version of *where things stand, why, and what's next*.

## 1. Status in one paragraph

PRD v2 Build Orders **#0–#3 are built and deployed**. Anyone can paste a
public product URL into the web app on Vercel and, without an account,
get a ranked report of 3–5 evidence-backed Opportunity Cards (Scientist
+ Reviewer/Critic, both Claude calls), each showing the exact evidence it
cites, a proposed experiment, a "Build this" CTA and a five-point rating.
The public endpoint is rate-limited, and every step of the funnel plus
every card rating is logged to Postgres, so the **Concierge Validation
Plan can start now** and be measured with the SQL in the README. Nothing
from Build Order #4 onward (GitHub deep scan, real "Build this"
packages, auth, production data adapters) has been started — by design:
the PRD puts real-partner validation first.

## 2. What exists

| Piece | Where | State |
|---|---|---|
| Evidence contract (Evidence Packet, Opportunity Card, Reviewer checklist) | project doc `claude/gauntlet-evidence-contract-v0.md` | Ratified. Code mirrors it field-for-field; change the doc first. |
| Pipeline: fetch → discover → extract → Evidence Packet → Scientist → Reviewer | `packages/core` | Done. Static HTML only, respects robots.txt, ≤8 pages. |
| CLI (`scan`, `analyze`, local SQLite) | `packages/cli` | Done. |
| Web app: landing, async scan jobs, report page | `apps/web` (Next.js 15, Supabase Postgres, Vercel Hobby) | Deployed. |
| Scan quota (3/client, 20 global per 24h) | `apps/web/lib/rate-limit.ts`, migration 002 | Deployed, verified in production. |
| Evidence-rich cards, Build this CTA, ratings, funnel events | `components/opportunity-card.tsx`, `lib/events.ts`, migration 003 | Committed 2026-09-29 — see §6 for deploy status. |

Tests: `npm test` at the root runs all three workspaces (~108 tests:
CLI 5, core 56, web 47). `npm run typecheck` and `npm run lint` must be
clean before any commit.

## 3. Running it

- **Env vars** (`apps/web/.env.local` locally, Vercel project settings in
  prod): `DATABASE_URL` (Supabase **transaction pooler**, port 6543),
  `ANTHROPIC_API_KEY`, `SCAN_IP_HASH_SECRET` (required; long random
  string). Optional: `SCAN_LIMIT_PER_CLIENT_PER_DAY` (default 3),
  `SCAN_LIMIT_GLOBAL_PER_DAY` (default 20).
- **Migrations** are applied **by hand** in the Supabase SQL Editor, in
  order: `001_init.sql`, `002_scan_rate_limit.sql`, `003_scan_events.sql`
  (all idempotent). **Always apply a new migration before deploying the
  code that needs it** — the code assumes the schema exists.
- **Deploy** = push to `main` on `Starbound-Scaling/gauntlet` (Vercel
  builds from `apps/web`). Andres also mirrored to a personal remote.
- **Local dev quirks:** without Vercel's edge every local request shares
  one quota bucket — raise `SCAN_LIMIT_PER_CLIENT_PER_DAY` locally. On a
  corporate machine with TLS inspection (CrowdStrike Falcon etc.), Node
  needs `NODE_EXTRA_CA_CERTS` for both Supabase and the Claude API; the
  README has the full procedure and `npm run verify-tls`.

## 4. Decisions worth knowing (and why)

| Date | Decision | Why |
|---|---|---|
| 09-22 | Build Orders #1–#3 implemented before real-partner validation | Calibrate against real scans instead of waiting on recruitment (README "Scope decisions"). |
| 09-22 | Reviewer/Critic automated as a 2nd Claude call | Contract had it as a manual checklist; automated to run on every report. |
| 09-25 | Zero-evidence scans fail fast, before any Claude call | Otherwise the Scientist can't satisfy "cite real evidence" and fails with a misleading Zod error after 2 paid calls. |
| 09-25 | Sites that block bots (e.g. perplexity.ai → HTTP 403) are an **accepted v0 limitation** | No headless browser (cost, 300s ceiling), no user-agent spoofing (ethics, contract honesty). |
| 09-25 | Cards dropped by the Reviewer stay hidden (only a count is shown) | "Shorter" reports are the Reviewer working (contract §8.4), not a regression. |
| 09-28 | Scan quota 3/client + 20 global per rolling 24h, IP stored only as HMAC | Public unauthenticated endpoint spending Claude calls; numbers sized to the 10–20-partner concierge stage. |
| 09-29 | Funnel events + ratings in our own Postgres, not PostHog | No new vendor before validation; PostHog remains the PRD's candidate first data adapter. |
| — | Delivery flow: commits straight to `main` | Confirmed by Andres for Gauntlet (unlike Token Profiler's branch-per-feature). |

## 5. Known risks and debt (most important first)

1. **Dependency advisories** — `npm audit`: 7 (1 critical). Six are dev-only
   tooling (vitest/vite/esbuild; affect local dev/test servers, not the
   deployed app); one is Next via postcss (build-time CSS; ours only).
   All fixes are **major** upgrades (Vitest 5, Next 16): do them as one
   planned upgrade with the full test suite, never `npm audit fix --force`.
2. **No Postgres in CI.** The quota's concurrency guarantee and the
   events' dedupe/constraints were verified against a real Postgres 16 by
   hand (details in the commit messages of `1058553` and `915975f`), not by
   committed tests. First CI improvement: a Postgres service container +
   those scenarios as tests.
3. **No migration runner.** Three hand-applied SQL files is the limit;
   add a runner (even a tiny one with a `schema_migrations` table) before a
   fourth.
4. **Data retention is undefined** (PRD §18 open question). `scan_jobs` and
   `scan_events` keep rows forever. IPs are only stored as HMACs, but
   decide a retention window before real partner traffic grows.
5. **IP-based quota caveats.** Shared IPs (offices, NAT) share a quota;
   IPv6 rotation can partly evade the per-client limit — the 20/day global
   cap is the real cost ceiling. Revisit once real auth exists (quota per
   account).
6. **Scan coverage.** Static HTML only: JS-rendered sites yield little
   evidence; bot-blocking sites fail (clearly). Mature products tend to get
   2–3 cards, not 5 (contract §7.3) — expected, not a bug.
7. **`maxDuration = 300`** (Vercel Hobby). If a run needs both corrective
   retries it may hit the ceiling; move to Pro (800s) only when a real run
   proves it.
8. Minor: `GET /api/scans/<not-a-uuid>` returns 500 instead of 404 (from
   code reading; the new events route validates the id). Signup is a
   placeholder that only carries `?from=` and `?card=`.

## 6. Open at hand-off time

- Deploy of `d94e429` + `915975f` (migration 003 first) — check with
  `git log origin/main` whether it's live; if not, follow §3.
- Nobody outside the team has seen a report yet.

## 7. What's next, in PRD order

1. **Run the Concierge Validation Plan** (contract doc §4): 10–20 AI
   products with a founder/PM willing to review. Send them the report
   URL; the ratings and Build-this clicks are recorded automatically.
   Measure with the README's "Measuring the concierge validation" queries
   against the thresholds (top-3 usefulness ≥70%, action intent ≥30%,
   signup-equivalent ≥20%, false-confidence <10% — `wrong` ratings are
   only a proxy; confirm with the reviewer). This is a product decision
   for Khalil (product owner), not an engineering task.
2. Answer the PRD §18 questions the validation will surface — above all
   data retention and which categories to support.
3. Only if thresholds are met: **Build Order #4 — GitHub deep scan**
   (needs real auth first), then #5 "Build this" implementation packages,
   #6 first production data adapter (PostHog if partners use it), #7
   Experiment Ledger.

## 8. People and references

- **Khalil** — product owner, final architectural authority.
- **Andres Guatibonza** — built Build Orders #0–#3 (engagement ends 2026-09-30).
- PRD: `Gauntlet PRD v2 - Lean MVP` (project doc). Contract:
  `claude/gauntlet-evidence-contract-v0.md` (project doc). Repo README for
  everything operational.
