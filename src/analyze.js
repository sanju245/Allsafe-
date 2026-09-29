// Orchestrates: crawl one site -> run detectors -> build check rows (never guess).
import { randomUUID } from 'node:crypto';
import { crawlSite, isConclusive } from './crawl.js';
import { runDetectors } from './detect.js';
import { resolveProfile } from './industry.js';
import { makeCheck } from './check.js';
import { expiryOverride } from './freshness.js';
import { ANALYZER_CHECK_TYPES } from './constants.js';
import { isNonWebsiteHost } from './platforms.js';

/**
 * @param input  { business_id?, owner_id?, name?, industry?, website_url, source?, source_url? }
 * @param opts   { now?, staleAfterDays?, http?, respectRobots?, maxPages?, crawlDelayMs?, deadlineMs?, crawl? }
 *               `crawl` lets tests inject a pre-made crawl.
 */
export async function analyzeBusiness(input, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const staleAfterDays = opts.staleAfterDays ?? 30;
  const profile = resolveProfile(input.industry);
  const listing = {
    website_url: input.website_url ?? null,
    source: input.source ?? null,
    source_url: input.source_url ?? null,
  };

  const hasRealUrl = !!listing.website_url && String(listing.website_url).trim() !== '';
  let crawl = opts.crawl ?? null;
  if (!crawl && hasRealUrl) {
    // social / listing URLs are classified without any fetch
    const asUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(listing.website_url) ? listing.website_url : 'https://' + listing.website_url;
    if (!isNonWebsiteHost(asUrl)) {
      crawl = await crawlSite({
        websiteUrl: listing.website_url, profile, http: opts.http || {},
        respectRobots: opts.respectRobots ?? true, maxPages: opts.maxPages ?? 6,
        crawlDelayMs: opts.crawlDelayMs ?? 250, deadlineMs: opts.deadlineMs ?? 20_000,
      });
    }
  }

  const { state, conclusive, drafts } = runDetectors({ listing, profile, crawl, now });

  // assign ids first so derived checks can point at the check they depend on
  const ids = new Map(drafts.map((d) => [d.type, randomUUID()]));
  const checks = drafts.map((d) => {
    const derived = d.derivedFrom ? { check_type: d.derivedFrom, check_id: ids.get(d.derivedFrom) } : null;
    const row = makeCheck({
      id: ids.get(d.type), ownerId: input.owner_id, businessId: input.business_id,
      type: d.type, result: d.result, confidence: d.confidence, evidenceUrl: d.evidenceUrl,
      excerpt: d.excerpt, evidence: d.evidence,
      method: d.method ?? 'http_crawl',
      httpStatus: d.httpStatus ?? ((d.method ?? 'http_crawl') === 'http_crawl' ? crawl?.home?.status ?? null : null),
      error: d.error ?? null, checkedAt: now,
    });
    // derived_from is internal system metadata (a check_type + our own generated check_id) -
    // never scraped page content - so it's attached AFTER makeCheck()'s privacy redaction,
    // not passed through it: a UUID that happens to contain a long run of digits must never
    // be mangled by the phone-number redaction meant for scraped text.
    if (derived) row.evidence = { ...row.evidence, derived_from: derived };
    row.expires_at = expiryOverride({ result: row.result, checkType: row.check_type, evidence: row.evidence }, now, staleAfterDays);
    return row;
  });

  // hard guarantee: exactly one row per analyzer check type
  const missing = ANALYZER_CHECK_TYPES.filter((t) => !checks.some((c) => c.check_type === t));
  if (missing.length) throw new Error(`detectors did not produce: ${missing.join(', ')}`);

  return {
    checks,
    siteState: state.kind,
    conclusive,
    profile: { key: profile.key, known: profile.known },
    crawl: crawl ? summarizeCrawl(crawl) : null,
  };
}

export function summarizeCrawl(crawl) {
  return {
    start_url: crawl.startUrl,
    final_url: crawl.home?.finalUrl ?? null,
    status: crawl.home?.status ?? null,
    error: crawl.home?.error ?? null,
    redirects: crawl.home?.redirects ?? [],
    pages_inspected: crawl.pages.map((p) => p.finalUrl),
    failures: crawl.failures,
    robots_blocked: crawl.robotsBlocked,
    skipped_candidates: crawl.skippedCandidates,
    inconclusive_reasons: crawl.inconclusiveReasons,
    conclusive: isConclusive(crawl),
    robots: crawl.robots,
  };
}
