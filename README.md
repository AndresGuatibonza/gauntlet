# Gauntlet

Gauntlet is the "Product Scientist & Fast-Value Loop": point it at a public
product URL and it builds a normalized Evidence Packet, then ranks
improvement opportunities and proposes a defensible experiment for each.
See the Gauntlet PRD v2 (Lean MVP) for the full product spec and Build
Order sequence.

**Status: Build Order #0 (evidence contract) done. Build Order #1 (Public
URL Ingestion Engine) done and validated against real internet. Build
Order #2 (Product Scientist v0 + Reviewer/Critic) done and validated
against a real Claude API call against the real otter.ai Evidence
Packet -- 5 Opportunity Cards generated, 2 downgraded by the Reviewer,
exactly one `build_this`, every card traceable to real evidence.** The
Evidence Packet & Scientist Output Contract itself
lives in the shared project doc `claude/gauntlet-evidence-contract-v0.md`,
not in this repo -- that doc also records two manual concierge dry-runs (a
real product, Otter.ai, and a synthetic one, EchoDesk) used to calibrate
the contract before any code was written, per the PRD's own sequencing
rule: *"do not build a generalized ingestion platform before proving that
one small Evidence Packet can produce recommendations users trust."*

**Scope decision, confirmed with Andres:** the Concierge Validation Plan
(§4 of the contract doc) is still open -- no real design partner has run
through the full loop, only the two calibration dry-runs. Build Order #2
was implemented anyway (same call as Build Order #1: implement now,
calibrate against real scans rather than waiting on partner recruitment).
The Reviewer/Critic (§8.4), originally scoped in the contract doc as a
manual checklist Andres applies by hand, is likewise automated here as a
second Claude API call, not a manual step -- also confirmed with Andres.

## What's built

- **Fetcher** (`src/core/fetcher.ts`) -- real `robots.txt` compliance (a
  disallowed path is refused, not silently fetched) and a real per-host
  rate limit, not a cosmetic delay.
- **Page discovery** (`src/core/page-discovery.ts`) -- starts at the
  homepage, follows only same-origin links whose URL or link text matches a
  disclosed keyword list (pricing/docs/help/product/etc.), up to an explicit
  page cap (default 8, homepage included). Nothing about the bound is
  hidden from the caller.
- **Extractor** (`src/core/extractor.ts`) -- turns static HTML into
  evidence items: calls-to-action, navigation structure, forms, price-like
  figures (only when a billing-period unit like `/mo` or `per user` is
  present), and unverifiable-sounding social-proof claims ("trusted by
  500+"). Deliberately does **not** attempt to auto-detect `docs_gap`
  (absence of a topic is a human judgment call), JS-rendered `error_state`,
  or `technical_signal` requiring interaction -- a static-HTML-only scan
  cannot do these reliably without inferring beyond what it actually
  observed, which the contract's own non-goal forbids. These evidence types
  stay valid for the manual/concierge process.
- **Normalizer** (`src/core/normalizer.ts`) -- assembles the full Evidence
  Packet. Candidate pricing contradictions are *flagged for human review*,
  never resolved automatically, and only when both pages being compared
  show exactly one price figure each (matching the shape of the real
  Otter.ai finding this is modeled on: one plan, two different numbers
  across two pages). A page listing several plans is not cross-checked
  against another page automatically -- see "Known limitations" below.
- **Product Scientist** (`src/core/scientist.ts`) -- turns a stored
  Evidence Packet into 3-5 ranked Opportunity Cards (contract §2), each
  with an observation, problem statement, falsifiable hypothesis, MVP-level
  experiment design, impact/effort/confidence, and `evidenceRefs`. Calls
  the Claude API (`src/core/llm-client.ts`, injectable for tests) once per
  packet with a prompt that states the contract's ground rules verbatim,
  validates the response with Zod, and enforces one rule Zod cannot: every
  `evidenceRefs` id must exist in the packet actually given to it -- a
  cited id the packet doesn't contain is treated as a failed generation
  (one automatic corrective retry), never silently accepted.
- **Reviewer/Critic** (`src/core/reviewer.ts`) -- a second Claude API call
  that applies the contract's §3 checklist to every card the Scientist
  produced (does the conclusion outrun the evidence? unaddressed
  confounder? does the metric match the outcome? is it falsifiable and
  single-change?), and can drop a card or downgrade its confidence
  (recomputing `rankScore` accordingly). If the dropped/downgraded card was
  the one marked "Best next experiment", the highest-ranked survivor is
  automatically promoted so the contract's "exactly one `build_this`"
  invariant always holds after review. Every verdict is kept as a
  `review_records` row, per PRD §8.4 ("a concise review record for
  debugging and future experiment memory"), including for dropped cards.
- **SQLite store** (`src/store/sqlite.ts`) -- same local-first,
  migration-tracked pattern as Token Profiler. Evidence Packets,
  Opportunity Reports, and review records are all persisted; an Opportunity
  Report can be re-displayed later without re-calling the Claude API.
- **CLI** -- `gauntlet scan <url>` (Build Order #1), `gauntlet analyze
  <packetId>` (Build Order #2: runs Scientist then Reviewer against an
  already-scanned packet).

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
- If the Reviewer drops every card (the Evidence Packet didn't support any
  card well enough to ship), `gauntlet analyze` fails loudly rather than
  returning an empty report -- the fix is a re-scan with more pages or
  connecting more evidence sources, not silently shipping nothing.
- Found and fixed against the real `analyze` smoke test, not
  hypothetically: the model spends part of its token budget on an internal
  "thinking" block before the final text block. At the original
  `maxTokens: 4096`, a real run hit `stop_reason: "max_tokens"` having
  produced only a thinking block and zero text -- `llm-client.ts` now
  requests 16000 tokens and, on this same failure mode, throws an error
  naming the `stop_reason` and the block types actually returned instead
  of a bare "no text block" dead end.
- If your network runs corporate TLS inspection (e.g. CrowdStrike Falcon,
  Cisco Umbrella, Zscaler, Netskope) `analyze`'s Claude API call will fail
  with `unable to verify the first certificate` until Node is told to
  trust that interception CA -- see "Usage" below. This isn't a bug in
  Gauntlet; every Node process on that machine hits the same wall, `scan`
  is just never affected because it never calls an external API host that
  isn't allowlisted the same way.

## Usage

```
npm install
npm run typecheck && npm run lint && npm test
npm run build
node dist/cli/index.cjs scan https://example.com --category ai_saas --max-pages 8 --db ./gauntlet.db --out ./scans/example.json
node dist/cli/index.cjs analyze 1 --db ./gauntlet.db --out ./scans/example-report.json
```

- `--category` is `ai_tool` or `ai_saas` (default `ai_saas`), per the
  concierge round's scope decision.
- `--max-pages` bounds total pages fetched, homepage included (default 8).
- `--out` is optional; when set, the full Evidence Packet (or Opportunity
  Report) is also written as JSON. Ad hoc scan output belongs under
  `scans/` (gitignored), not committed, unless it's an intentional fixture.
- `analyze` needs `ANTHROPIC_API_KEY` set in the shell, or in a `.env` file
  at the repo root (loaded automatically via Node's built-in
  `--env-file`-equivalent loader; **never commit `.env`** -- it's already
  gitignored). Get a real key from console.anthropic.com -- it starts with
  `sk-ant-api03-` and is over 100 characters; a short `apikey_...`-style
  token is from a different system and will get a 401 here. This is the
  only command in the CLI that calls out to a paid API; `scan` never does.

On Windows, if `npm install` reports install scripts blocked for
`better-sqlite3` or `esbuild`, approve them and rebuild:

```
npm install-scripts approve better-sqlite3
npm install-scripts approve esbuild
npm rebuild
```

**On a corporate machine with TLS-inspecting endpoint security** (found
during this Build Order's real smoke test, behind CrowdStrike Falcon --
the same fix applies to Cisco Umbrella/Zscaler/Netskope-style inspection),
`analyze` will fail with `unable to verify the first certificate` unless
Node is told to trust the local interception root CA:

1. Find the exact certificate your network presents for the API host --
   don't guess which root in your certificate store it is:
   ```
   node scripts/get-chain.mjs
   ```
   This prints the Subject/Issuer actually returned for
   `api.anthropic.com` and saves it to `corp-ca-chain.pem`. If it's a
   self-signed root (Issuer == Subject), it won't be sent over the wire --
   export that exact certificate by name from Windows' Trusted Root store
   (`certmgr.msc` -> Trusted Root Certification Authorities -> find it by
   the CN the script printed -> Export -> Base-64 encoded X.509 (.CER)) and
   use that file instead.
2. Point Node at it -- **must be set before Node starts**, so it can't
   live in `.env` (that's loaded by our own code, after Node's TLS module
   already initialized):
   ```
   set NODE_EXTRA_CA_CERTS=C:\path\to\your-exported-cert.pem
   ```
3. Re-run `analyze`. `llm-client.ts` reads this env var itself and passes
   it to the Anthropic SDK's `httpAgent` explicitly (combined with Node's
   normal public CA list) rather than relying on `fetch`/undici to honor
   the env var on every internal code path, which isn't guaranteed.

## What's next

1. Build Order #3 (Pre-auth Report UI) is next in the PRD's own sequence.
2. The Concierge Validation Plan (§4) is still open -- no real design
   partner has seen a report yet. That recruitment stays a product
   decision for Andres, not something to keep deferring indefinitely now
   that there's a working report to actually show someone.
