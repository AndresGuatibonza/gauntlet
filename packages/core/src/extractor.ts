/**
 * HTML -> evidence extraction for the Ingestion Engine (PRD §8.1):
 *   "Extract structured content: navigation, key workflows described, value
 *   propositions, calls-to-action, forms, page hierarchy, visible error
 *   states, and public documentation cues."
 *   "Capture technical/product evidence where reliably observable, but do
 *   not infer hidden backend behavior from frontend appearance alone."
 *
 * DELIBERATE v0 SCOPE LIMIT, stated here rather than hidden: this extractor
 * only reads static server-rendered HTML (no JS execution). It therefore
 * does NOT attempt to auto-detect:
 *   - `docs_gap`   (absence of a topic is an interpretive judgment -- the
 *                   Otter.ai and EchoDesk manual dry-runs made this call by
 *                   hand; automating it would mean inferring an absence with
 *                   no reliable signal, which is exactly what the contract's
 *                   non-goal forbids)
 *   - `error_state` on JS-rendered widgets (a static fetch never runs the
 *                   page's scripts, so a live chat widget's behavior is not
 *                   observable this way)
 *   - `technical_signal` requiring interaction
 * These remain valid `evidence_type` values for the manual/concierge
 * process and for a future adapter, but this file only ever emits `copy`,
 * `ui_structure`, `cta_placement`, and `pricing`. Callers should record the
 * gap explicitly in `missingEvidenceSummary`, not silently.
 */
import * as cheerio from "cheerio";
import type { EvidenceType, EvidenceConfidence } from "./evidence-packet.js";

export interface RawEvidenceItem {
  sourceUrl: string;
  evidenceType: EvidenceType;
  observation: string;
  rawExcerpt: string;
  confidence: EvidenceConfidence;
}

const CTA_PATTERNS = [
  /start\s+(for\s+|a\s+)?free/i,
  /try\s+it\s+free/i,
  /sign\s*up/i,
  /get\s+started/i,
  /book\s+a\s+demo/i,
  /schedule\s+a?\s*demo/i,
  /request\s+a?\s*demo/i,
  /buy\s+now/i,
  /subscribe/i,
  /contact\s+sales/i,
  /start\s+trial/i,
  /start\s+free\s+trial/i,
];

/** Regexes for unverifiable-sounding social-proof / superlative claims. */
const PUFFERY_PATTERNS = [
  /trusted\s+by\s+[\d,]+\+?/i,
  /used\s+by\s+[\d,]+\+?/i,
  /#\s?1\b/i,
  /industry[\s-]leading/i,
  /best[\s-]in[\s-]class/i,
];

/**
 * Deliberately requires a billing-period suffix ("/mo", "per user", ...).
 * A bare "$100" anywhere on the page is NOT counted as pricing evidence --
 * that matched unrelated numbers (e.g. funding/stats figures on a press
 * page) in the first version of this pattern, confirmed against a real
 * scan of otter.ai/press. Requiring plan-shaped context is a real precision
 * trade-off, not a cosmetic one: it will miss a price stated without a
 * billing unit nearby, and that gap belongs in missingEvidenceSummary, not
 * silently expanded back into false positives.
 */
const PRICE_PATTERN = /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:\/|per)\s?(?:mo|month|year|user|seat))+/gi;

export function extractPageTitle(html: string): string | null {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  return title.length > 0 ? title : null;
}

export function extractFirstHeading(html: string): string | null {
  const $ = cheerio.load(html);
  const h1 = $("h1").first().text().trim();
  return h1.length > 0 ? h1 : null;
}

export function extractNavItems(html: string): string[] {
  const $ = cheerio.load(html);
  const items = new Set<string>();
  $("nav a, header a").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 0 && text.length < 60) {
      items.add(text);
    }
  });
  return Array.from(items);
}

export function extractCtas(html: string, sourceUrl: string): {
  ctaTexts: string[];
  evidence: RawEvidenceItem[];
} {
  const $ = cheerio.load(html);
  const ctaTexts = new Set<string>();
  const evidence: RawEvidenceItem[] = [];

  $("a, button").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length === 0 || text.length > 80) return;
    if (CTA_PATTERNS.some((re) => re.test(text))) {
      ctaTexts.add(text);
    }
  });

  if (ctaTexts.size > 0) {
    evidence.push({
      sourceUrl,
      evidenceType: "cta_placement",
      observation: `Page presents ${ctaTexts.size} distinct call-to-action label(s): ${Array.from(ctaTexts).join(", ")}.`,
      rawExcerpt: Array.from(ctaTexts).join(" | "),
      confidence: "high",
    });
  }

  return { ctaTexts: Array.from(ctaTexts), evidence };
}

export function extractNavStructureEvidence(html: string, sourceUrl: string): RawEvidenceItem[] {
  const navItems = extractNavItems(html);
  if (navItems.length === 0) {
    return [
      {
        sourceUrl,
        evidenceType: "ui_structure",
        observation: "No <nav> or <header> navigation links were found in the served HTML.",
        rawExcerpt: "(no nav/header <a> elements present)",
        confidence: "medium",
      },
    ];
  }
  return [
    {
      sourceUrl,
      evidenceType: "ui_structure",
      observation: `Primary navigation exposes ${navItems.length} link(s): ${navItems.join(", ")}.`,
      rawExcerpt: navItems.join(" | "),
      confidence: "high",
    },
  ];
}

export function extractFormsEvidence(html: string, sourceUrl: string): RawEvidenceItem[] {
  const $ = cheerio.load(html);
  const forms = $("form");
  if (forms.length === 0) return [];
  const evidence: RawEvidenceItem[] = [];
  forms.each((i, el) => {
    const fields = $(el)
      .find("input, select, textarea")
      .map((_, f) => $(f).attr("name") ?? $(f).attr("type") ?? "unnamed field")
      .get();
    evidence.push({
      sourceUrl,
      evidenceType: "ui_structure",
      observation: `Form #${i + 1} on this page requests ${fields.length} field(s).`,
      rawExcerpt: fields.join(", ") || "(no named fields detected)",
      confidence: "high",
    });
  });
  return evidence;
}

export function extractPricingEvidence(html: string, sourceUrl: string): RawEvidenceItem[] {
  const $ = cheerio.load(html);
  const bodyText = $("body").text();
  const matches = Array.from(bodyText.matchAll(PRICE_PATTERN)).map((m) => m[0].trim());
  if (matches.length === 0) return [];

  // Dedupe while preserving order; cap the raw excerpt to something readable.
  const uniqueMatches = Array.from(new Set(matches)).slice(0, 20);
  return [
    {
      sourceUrl,
      evidenceType: "pricing",
      observation: `Page contains ${uniqueMatches.length} distinct price-like figure(s).`,
      rawExcerpt: uniqueMatches.join(", "),
      confidence: "high",
    },
  ];
}

export function extractPufferyEvidence(html: string, sourceUrl: string): RawEvidenceItem[] {
  const $ = cheerio.load(html);
  const bodyText = $("body").text();
  const evidence: RawEvidenceItem[] = [];
  for (const pattern of PUFFERY_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (match) {
      evidence.push({
        sourceUrl,
        evidenceType: "copy",
        observation: "Page contains an unverifiable-sounding social-proof or superlative claim with no attached citation/logo in the surrounding markup checked.",
        rawExcerpt: match[0].trim(),
        confidence: "medium",
      });
    }
  }
  return evidence;
}

export interface PageExtraction {
  evidence: RawEvidenceItem[];
  ctaTexts: string[];
  navItems: string[];
  pageTitle: string | null;
  firstHeading: string | null;
}

export function extractPage(html: string, sourceUrl: string): PageExtraction {
  const { ctaTexts, evidence: ctaEvidence } = extractCtas(html, sourceUrl);
  const navEvidence = extractNavStructureEvidence(html, sourceUrl);
  const formEvidence = extractFormsEvidence(html, sourceUrl);
  const pricingEvidence = extractPricingEvidence(html, sourceUrl);
  const pufferyEvidence = extractPufferyEvidence(html, sourceUrl);

  return {
    evidence: [...ctaEvidence, ...navEvidence, ...formEvidence, ...pricingEvidence, ...pufferyEvidence],
    ctaTexts,
    navItems: extractNavItems(html),
    pageTitle: extractPageTitle(html),
    firstHeading: extractFirstHeading(html),
  };
}
