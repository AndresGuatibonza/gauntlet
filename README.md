# Gauntlet

Gauntlet is the "Product Scientist & Fast-Value Loop": point it at a public
product URL and it builds a normalized Evidence Packet, then (in later
Build Orders) ranks improvement opportunities and proposes a defensible
experiment for each. See the Gauntlet PRD v2 (Lean MVP) for the full product
spec and Build Order sequence.

**Status: Build Order #0 (evidence contract) done. Build Order #1 (Public
URL Ingestion Engine) done and validated against real internet, not just
local fixtures.** The Evidence Packet & Scientist Output Contract itself
(the normalized schema this Ingestion Engine produces) lives in the shared
project doc `claude/gauntlet-evidence-contract-v0.md`, not in this repo --
that doc also records two manual concierge dry-runs (a real product,
Otter.ai, and a synthetic one, EchoDesk) used to calibrate the contract
before any code was written, per the PRD's own sequencing rule: *"do not
build a generalized ingestion platform before proving that one small
Evidence Packet can produce recommendations users trust."*

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
- **SQLite store** (`src/store/sqlite.ts`) -- same local-first,
  migration-tracked pattern as Token Profiler. No hosted account, no API
  key, nothing to provision.
- **CLI** -- `gauntlet scan <url>`.

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

## Usage

```
npm install
npm run typecheck && npm run lint && npm test
npm run build
node dist/cli/index.cjs scan https://example.com --category ai_saas --max-pages 8 --db ./gauntlet.db --out ./scans/example.json
```

- `--category` is `ai_tool` or `ai_saas` (default `ai_saas`), per the
  concierge round's scope decision.
- `--max-pages` bounds total pages fetched, homepage included (default 8).
- `--out` is optional; when set, the full Evidence Packet is also written
  as JSON. Ad hoc scan output belongs under `scans/` (gitignored), not
  committed, unless it's an intentional fixture.

On Windows, if `npm install` reports install scripts blocked for
`better-sqlite3` or `esbuild`, approve them and rebuild:

```
npm install-scripts approve better-sqlite3
npm install-scripts approve esbuild
npm rebuild
```

## What's next

Per the PRD's Build Order, #2 (Product Scientist v0 -- ranking opportunities
and generating an experiment from the Evidence Packet) is next. But per the
same PRD's critical sequencing rule, the Concierge Validation Plan (§4 of
the contract doc) is still open: no real design partner has run through the
full loop yet, only the two calibration dry-runs recorded there. That
recruitment is a product decision, not an engineering one, and Build Order
#2 should not start speculatively ahead of it.
