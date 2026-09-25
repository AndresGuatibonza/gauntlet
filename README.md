# Gauntlet

Gauntlet is the "Product Scientist & Fast-Value Loop": point it at a public
product URL and it builds a normalized Evidence Packet, then ranks
improvement opportunities and proposes a defensible experiment for each.
See the Gauntlet PRD v2 (Lean MVP) for the full product spec and Build
Order sequence.

**Status:** Build Order #0 (evidence contract) done. Build Order #1
(Public URL Ingestion Engine) done and validated against real internet.
Build Order #2 (Product Scientist v0 + Reviewer/Critic) done and validated
against a real Claude API call against the real otter.ai Evidence Packet
-- 5 Opportunity Cards generated, 2 downgraded by the Reviewer, exactly
one `build_this`, every card traceable to real evidence. **Build Order #3
(Pre-auth Report UI, `apps/web`) is built and validated end-to-end**: a
real Supabase project, a real async scan job through the running Next.js
app, a real Claude API call, polled to completion and rendered as a
ranked report -- confirmed against a second real run on `https://otter.ai/`
(4 Opportunity Cards, ranked by impact/effort/confidence, each with its
supporting evidence and a proposed experiment). See "What's next" for
what's still open.

The Evidence Packet & Scientist Output Contract itself lives in the
shared project doc `claude/gauntlet-evidence-contract-v0.md`, not in this
repo -- that doc also records two manual concierge dry-runs (a real
product, Otter.ai, and a synthetic one, EchoDesk) used to calibrate the
contract before any code was written, per the PRD's own sequencing rule:
*"do not build a generalized ingestion platform before proving that one
small Evidence Packet can produce recommendations users trust."*

**Scope decisions, confirmed with Andres:**
- The Concierge Validation Plan (§4 of the contract doc) is still open --
  no real design partner has run through the full loop, only the two
  calibration dry-runs. Build Orders #1-#3 were all implemented anyway
  (implement now, calibrate against real scans rather than waiting on
  partner recruitment).
- The Reviewer/Critic (§8.4), originally scoped in the contract doc as a
  manual checklist Andres applies by hand, is automated here as a second
  Claude API call, not a manual step.
- Build Order #3 is a real publicly hosted web app (Next.js on Vercel),
  not a local-only UI, per the PRD's own §8.5. Signup is a placeholder
  only -- real auth is out of scope for this Build Order.

## Repo layout

An npm workspaces monorepo, split when Build Order #3 needed to share the
scan/Scientist/Reviewer pipeline between the CLI and a new web app
without duplicating it:

```
packages/core/   @gauntlet/core -- the framework-agnostic pipeline:
                 fetcher, page-discovery, extractor, normalizer,
                 evidence-packet, opportunity-card, scientist, reviewer,
                 llm-client. No CLI or storage concerns.
packages/cli/    @gauntlet/cli -- the local-first CLI. SQLite store
                 (evidence_packets / opportunity_reports / review_records,
                 normalized, browsable across time).
apps/web/        The public Pre-auth Report UI (Build Order #3). Supabase
                 Postgres store (one wide scan_jobs table, not normalized
                 -- see apps/web/lib/migrations/001_init.sql for why).
```

## What's built

- **Fetcher** (`packages/core/src/fetcher.ts`) -- real `robots.txt`
  compliance (a disallowed path is refused, not silently fetched) and a
  real per-host rate limit, not a cosmetic delay.
- **Page discovery** (`packages/core/src/page-discovery.ts`) -- starts at
  the homepage, follows only same-origin links whose URL or link text
  matches a disclosed keyword list (pricing/docs/help/product/etc.), up
  to an explicit page cap (default 8, homepage included).
- **Extractor** (`packages/core/src/extractor.ts`) -- turns static HTML
  into evidence items: calls-to-action, navigation structure, forms,
  price-like figures (only when a billing-period unit like `/mo` or `per
  user` is present), and unverifiable-sounding social-proof claims
  ("trusted by 500+"). Deliberately does **not** attempt to auto-detect
  `docs_gap`, JS-rendered `error_state`, or `technical_signal` requiring
  interaction -- those stay valid for the manual/concierge process.
- **Normalizer** (`packages/core/src/normalizer.ts`) -- assembles the
  full Evidence Packet. Candidate pricing contradictions are *flagged for
  human review*, never resolved automatically, and only when both pages
  being compared show exactly one price figure each.
- **Product Scientist** (`packages/core/src/scientist.ts`) -- turns an
  Evidence Packet into 3-5 ranked Opportunity Cards (contract §2). Calls
  the Claude API (`packages/core/src/llm-client.ts`, injectable for
  tests) once per packet, validates the response with Zod, and enforces
  one rule Zod cannot: every `evidenceRefs` id must exist in the packet
  actually given to it (one automatic corrective retry on failure).
- **Reviewer/Critic** (`packages/core/src/reviewer.ts`) -- a second
  Claude API call that applies the contract's §3 checklist to every card,
  and can drop a card or downgrade its confidence. If the dropped/
  downgraded card was "Best next experiment", the highest-ranked survivor
  is automatically promoted so the "exactly one `build_this`" invariant
  always holds after review.
- **CLI** (`packages/cli`) -- `gauntlet scan <url>` (Build Order #1),
  `gauntlet analyze <packetId>` (Build Order #2), local-first SQLite.
- **Web app** (`apps/web`, Build Order #3) -- landing page (paste a
  public URL, no account), an async job API, and a polling report page.
  Architecture, decided with Andres before writing code:
  - **Async job pattern, not a single synchronous request.** Checked
    Vercel's actual current limits before deciding (2026-09): Hobby is a
    fixed 300s ceiling; the scan+Scientist+Reviewer pipeline, with
    either component's one automatic corrective retry, can plausibly
    exceed that. `POST /api/scans` creates a `scan_jobs` row and returns
    its id immediately; the pipeline runs via Next.js's `after()`
    (stable since 15.1), which keeps the function alive past the
    response, up to `maxDuration = 300` -- Hobby's ceiling, since
    that's the plan in use for the MVP. `GET /api/scans/:id` is polled
    by the report page every 2.5s until the job is `done` or `failed`.
  - **Supabase Postgres, not SQLite** -- no persistent disk on typical
    serverless hosting. The **transaction-mode pooler** (port `6543`),
    never the direct connection (`5432`): a serverless function opens
    many short-lived connections, which would exhaust Postgres' own
    connection limit against the direct port.
  - **One wide `scan_jobs` table with jsonb columns**, not the CLI's
    normalized three tables -- this store only ever needs "the one
    finished artifact for this job id," polled until ready, never
    browsing history across time. A join would buy nothing here.
  - Every pipeline stage failure (bad URL, Claude API error, every card
    dropped by the Reviewer, a DB error creating or reading the job)
    lands the job in `failed` with a real message -- never left stuck in
    an intermediate status with nothing for the report page to show.

## Known limitations (v0, by design)

- `target_audience` and `primary_flows` are not reliably auto-extractable
  from static HTML and are left as an explicit "not detected" placeholder
  rather than guessed.
- No JavaScript execution: a live chat widget's actual behavior, or any
  client-rendered content, is invisible to this scan.
- Pricing-contradiction detection is intentionally narrow (see Normalizer
  above). It will miss a real conflict buried across two multi-plan pages,
  and that gap is named in the packet's `missingEvidenceSummary`, not
  hidden.
- Found and fixed against a real scan, not hypothetically: the first
  version of the pricing pattern matched any bare `$N` anywhere on the
  page, which misclassified unrelated numbers on otter.ai's press page as
  pricing evidence. The pattern now requires a billing-period unit nearby.
- If the Reviewer drops every card, `gauntlet analyze` (and the web app's
  job runner) fails loudly rather than returning an empty report -- the
  fix is a re-scan with more pages or connecting more evidence sources,
  not silently shipping nothing.
- Found and fixed against the real `analyze` smoke test, not
  hypothetically: the model spends part of its token budget on an internal
  "thinking" block before the final text block. At the original
  `maxTokens: 4096`, a real run hit `stop_reason: "max_tokens"` having
  produced only a thinking block and zero text -- `llm-client.ts` now
  requests 16000 tokens and, on this same failure mode, throws an error
  naming the `stop_reason` and the block types actually returned instead
  of a bare "no text block" dead end.
- If your network runs corporate TLS inspection (e.g. CrowdStrike Falcon,
  Cisco Umbrella, Zscaler, Netskope) any Claude API call will fail with
  `unable to verify the first certificate` until Node is told to trust
  that interception CA -- see "Usage" below. This isn't a bug in
  Gauntlet; every Node process on that machine hits the same wall.
- `apps/web`'s lint/test/typecheck are all clean, but there are no
  automated tests for it yet -- its code is fundamentally "call a real
  Postgres, call a real Claude API," which unit tests with fakes wouldn't
  meaningfully cover. It's validated by a real end-to-end run instead
  (Supabase project + a real scan through the running app), still
  pending as of this writing.
- `eslint`'s `no-undef` rule is turned off repo-wide (see
  `.eslintrc.json`). `@typescript-eslint/parser` without
  `eslint-plugin-react` wired in produces false positives against
  ambient/global types (the JSX namespace, DOM lib globals in
  `apps/web`); `tsc` (via `npm run typecheck`) already owns catching
  real undefined-identifier bugs, so this is the standard TS+ESLint
  advice, not a gap.

## Usage

### CLI (`@gauntlet/cli`)

```
npm install
npm run typecheck && npm run lint && npm test
npm run build
node packages/cli/dist/index.cjs scan https://example.com --category ai_saas --max-pages 8 --db ./gauntlet.db --out ./scans/example.json
node packages/cli/dist/index.cjs analyze 1 --db ./gauntlet.db --out ./scans/example-report.json
```

(`npm install`/`typecheck`/`lint`/`test`/`build` all run from the repo
root -- npm workspaces fan them out to every package that defines them.)

- `--category` is `ai_tool` or `ai_saas` (default `ai_saas`).
- `--max-pages` bounds total pages fetched, homepage included (default 8).
- `--out` is optional; when set, the full Evidence Packet (or Opportunity
  Report) is also written as JSON. Ad hoc scan output belongs under
  `scans/` (gitignored), not committed, unless it's an intentional fixture.
- `analyze` needs `ANTHROPIC_API_KEY` set in the shell, or in a `.env` file
  at the repo root. Get a real key from console.anthropic.com -- it starts
  with `sk-ant-api03-` and is over 100 characters; a short `apikey_...`-
  style token is from a different system and will get a 401 here.

On Windows, if `npm install` reports install scripts blocked for
`better-sqlite3` or `esbuild`, approve them and rebuild:

```
npm install-scripts approve better-sqlite3
npm install-scripts approve esbuild
npm rebuild
```

**On a corporate machine with TLS-inspecting endpoint security** (found
during Build Order #2's real smoke test, behind CrowdStrike Falcon --
the same fix applies to Cisco Umbrella/Zscaler/Netskope-style inspection),
any Claude API call will fail with `unable to verify the first
certificate` (and, per Build Order #3, any Postgres/Supabase connection
will fail with `self-signed certificate in certificate chain`, or
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` if the interceptor rotated its root --
see the note below) unless Node is told to trust the local interception
root CA.

**Before doing anything else, check whether this is actually the
problem**: `npm run verify-tls` makes a real Postgres TLS handshake and a
real Claude API call using the exact same CA setup the app uses, and
prints OK/FAILED for each in one shot -- much faster than re-deriving the
diagnosis from scratch every time this comes up (it has come up twice
so far in Build Order #3, for two different underlying reasons).

1. Figure out what you actually need, per host -- these are two
   different situations that happen to produce a similar-looking error,
   confirmed by testing both on a real corporate machine:

   - **A host that's genuinely MITM-intercepted** (Falcon reissuing its
     own certificate for the destination -- this is what happens for
     `api.anthropic.com`): don't capture the certificate off the wire.
     An intercepting proxy mints a fresh leaf certificate per
     connection/session, so a leaf you captured now can (and, per Build
     Order #3's real test, did) stop validating the very next
     connection. What you need is the proxy's own trust anchor -- the
     self-signed root it uses to sign every leaf it mints, already
     installed in Windows' own trust store for the interception to work
     at all:
     ```
     certmgr.msc  ->  Trusted Root Certification Authorities  ->  Certificates
     ```
     Find it by publisher (`CrowdStrike` / `Falcon ROOT CA Proxy`, or
     your vendor's equivalent for Umbrella/Zscaler/Netskope), right-click
     -> All Tasks -> Export -> **Base-64 encoded X.509 (.CER)** (not the
     binary DER option). That file's contents are plain PEM and can be
     concatenated straight into your combined CA file. Once this exact
     root is in the file, it validates *any* leaf Falcon mints for *any*
     intercepted host, not just the one you happened to capture.

   - **A host with its own private root that's simply not in the public
     CA bundle, not intercepted at all** (this is what Supabase's pooler
     turned out to be: its chain terminates in a self-signed
     `CN=Supabase Root 2021 CA`, and the *issuer* on the leaf was
     Supabase's own intermediate, not CrowdStrike -- no interception in
     play). Here the real chain genuinely is sent over the wire, so
     capturing it is correct and sufficient. Postgres negotiates TLS
     differently than HTTPS (a startup `SSLRequest` packet, then an
     upgrade), so pass `--pg`:
     ```
     node scripts/get-chain.mjs aws-0-<region>.pooler.supabase.com 6543 supabase-chain.pem --pg
     ```
     (Use the exact pooler host from your Supabase project's Connection
     Info -- Transaction pooler tab.)

   Either way, check what actually came back (`Subject` vs `Issuer` in
   the script's own printed output, or the exported cert) before
   trusting it -- don't assume every corporate-network TLS error is the
   same root, or that it's an interception at all. Concatenate whatever
   real/exported certs you end up with into one file (order doesn't
   matter; Node's `ca` list tolerates unrelated extra certs fine, each
   connection only needs *its own* matching entry present anywhere in
   the list):
   ```
   copy /b falcon-ca-root-real.cer+supabase-chain.pem falcon-root.pem
   ```

   **This file does not survive a machine/profile reset or a moved
   folder** -- if `NODE_EXTRA_CA_CERTS` is set but the file it points to
   is missing, Node prints `Warning: Ignoring extra certs from ...,
   load failed: ... No such file or directory` and silently falls back
   to the public CA list only, so every intercepted connection (API
   *and* DB) starts failing again with no obvious link back to this
   step. That warning line in your terminal output is the tell -- if you
   see it, regenerate the file with the steps above.

   **Nor does it survive Falcon rotating its own interception root** --
   confirmed the hard way (Build Order #3, one day apart): the exact same
   setup that worked one day failed the next with `unable to verify the
   first certificate` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, with no code
   or file-missing warning involved -- the file was present and intact,
   just signed by a root CrowdStrike had since replaced (confirmed via
   the sha256 fingerprint of the exported cert differing between days,
   same Subject/Issuer name both times). There's no warning for this one
   -- the leaf's *signature* fails to verify, not "file missing". If a
   previously-working corporate-intercepted connection starts failing
   with a signature/verification error (not a missing-file warning) and
   nothing in the repo changed, re-export the root from `certmgr.msc`
   again before assuming it's a code regression -- `scripts/get-chain.mjs`
   only re-confirms *whose* CA is signing today's leaf (still
   `CN=Falcon ROOT CA Proxy` in both cases here), not whether that
   specific key is the one your saved file has -- comparing the fingerprint
   of your saved cert against a fresh export is what actually tells you.
2. Point Node at it -- **must be set before Node starts**, so it can't
   live in `.env` (that's loaded by our own code, after Node's TLS module
   already initialized):
   ```
   set NODE_EXTRA_CA_CERTS=C:\path\to\your-exported-cert.pem
   ```
3. Re-run. `llm-client.ts` reads this env var itself and passes it to the
   Anthropic SDK's `httpAgent` explicitly (combined with Node's normal
   public CA list) rather than relying on `fetch`/undici to honor the env
   var on every internal code path, which isn't guaranteed.

### Web app (`apps/web`, Build Order #3)

**Validated end-to-end** against a real Supabase project and a real scan.
Setup steps, for a fresh environment:

1. Create a Supabase project (supabase.com -> New project). Note the DB
   password you set.
2. Dashboard -> **Connect** -> **Transaction pooler** tab -> copy that
   connection string (port `6543`). Not the direct connection (`5432`) --
   see "Known limitations"/the code comments in `apps/web/lib/db.ts` for
   why that distinction matters for serverless.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`, fill in
   `DATABASE_URL` (the pooler string above) and `ANTHROPIC_API_KEY`.
4. Run `apps/web/lib/migrations/001_init.sql` once via Supabase's SQL
   Editor (or `psql` against the direct connection). No automated
   migration runner for the web app yet -- one migration doesn't earn one.
5. `cd apps/web && npm run dev`, open `http://localhost:3000`, paste a
   real public URL.

**On a corporate machine with TLS-inspecting endpoint security**, both
the Supabase connection (step 4/5) and the Claude API call can fail with
a certificate error the first time -- that's the section right above
this one ("On a corporate machine..."), not a bug in this setup. It's a
real, previously-hit-and-fixed case, not a hypothetical: see that
section before assuming a fresh Supabase/API key setup is wrong.

Deploying to Vercel: import the repo, set the **Root Directory** to
`apps/web`, add the same two env vars in Vercel's project settings.
Currently sized for the **Hobby** plan (`maxDuration = 300` in
`apps/web/app/api/scans/route.ts`); if a real run shows the pipeline
routinely needs more than 300s (most likely: both the Scientist and the
Reviewer needing their one corrective retry in the same run), that's the
concrete signal to move to Pro and raise that constant to 800 -- not
something to pre-optimize for without a real run proving it's needed.

## What's next

1. The Concierge Validation Plan (§4) is still open -- no real design
   partner has seen a report yet. That recruitment stays a product
   decision for Andres, not something to keep deferring indefinitely now
   that there's a working, publicly-hostable, end-to-end-validated report
   to actually show someone.
2. `apps/web` has not yet been deployed to Vercel itself (see the
   "Deploying to Vercel" note above) -- local end-to-end works; a real
   deployed instance, with its own env vars set in Vercel and a real
   `maxDuration` under real network latency (not local), is a separate
   claim from "works on localhost" and hasn't been tested yet.
