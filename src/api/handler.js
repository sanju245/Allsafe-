// POST /api/analyze  - framework-agnostic handler (Vercel / Netlify / node:http adapters call this).
//
//   Authorization: Bearer <ANALYZE_API_KEY>
//   { "business_id": "<uuid>", "website_url": "https://example.com",
//     "campaign_id": "<uuid, optional>", "force": false }
//
// Writes 14 rows to public.checks through the existing append-only mechanism
// (the DB flips the previous rows to is_current=false). After checks are
// successfully persisted, also scores every campaign the business is linked
// to (Part 5C) - best-effort: a scoring failure, per-campaign or total, never
// fails the analysis response; see the `scoring` field below. Never sends
// email, never discovers businesses.
import net from 'node:net';
import { analyzeBusiness } from '../analyze.js';
import { needsReanalysis } from '../freshness.js';
import { isPrivateAddress } from '../http.js';
import { CHECKER_VERSION } from '../constants.js';
import { scoreAllCampaignsForBusiness } from '../score/score-all-campaigns.js';
import { UUID, reply, fail, checkBearer } from './common.js';

const WEB_PORTS = new Set(['', '80', '443', '8080', '8443']);

/** Returns { url } (normalised), { url: null } (no website), or { error }. */
export function parseWebsiteUrl(input, { allowAnyPort = false, allowPrivate = false } = {}) {
  if (input === null) return { url: null };
  if (typeof input !== 'string') return { error: 'website_url must be a string or null' };
  const raw = input.trim();
  if (!raw) return { url: null };
  if (raw.length > 2048) return { error: 'website_url is too long' };
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(candidate); } catch { return { error: 'website_url is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'website_url must use http or https' };
  if (u.username || u.password) return { error: 'website_url must not contain credentials' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { error: 'website_url host is not allowed' };
    if (net.isIP(host) && isPrivateAddress(host)) return { error: 'website_url must not point to a private or reserved address' };
  }
  if (!allowAnyPort && !WEB_PORTS.has(u.port)) return { error: 'website_url port is not allowed' };
  return { url: u.toString() };
}

let inflight = 0;

export function createHandler({ store, config = {}, now = () => new Date(), analyze = analyzeBusiness }) {
  const cfg = {
    apiKey: config.apiKey,
    maxConcurrent: config.maxConcurrent ?? 3,
    allowPrivateNetworks: config.allowPrivateNetworks ?? false, // tests only
    allowAnyPort: config.allowAnyPort ?? false,                 // tests only
    http: { timeoutMs: 6000, retryDelayMs: 800, ...(config.http || {}) },
    deadlineMs: config.deadlineMs ?? 20_000,
    maxPages: config.maxPages ?? 6,
    crawlDelayMs: config.crawlDelayMs ?? 250,
    defaultStaleAfterDays: config.defaultStaleAfterDays ?? 30,
  };

  return async function handle({ method, headers = {}, rawBody = '' }) {
    if (method !== 'POST') return { ...fail(405, 'method_not_allowed', 'Use POST'), headers: { allow: 'POST' } };

    // ---- auth (fail closed)
    if (!cfg.apiKey) return fail(500, 'server_misconfigured', 'ANALYZE_API_KEY is not set');
    const denied = checkBearer(headers, cfg.apiKey);
    if (denied) return denied;

    // ---- input
    let body;
    try { body = JSON.parse(rawBody || '{}'); } catch { return fail(400, 'invalid_json', 'Body must be valid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_body', 'Body must be a JSON object');
    if (!UUID.test(String(body.business_id ?? ''))) return fail(400, 'invalid_business_id', 'business_id must be a UUID');
    if (!('website_url' in body)) return fail(400, 'missing_website_url', 'website_url is required (use null if the business has no website)');
    if (body.campaign_id != null && !UUID.test(String(body.campaign_id))) return fail(400, 'invalid_campaign_id', 'campaign_id must be a UUID');
    if (body.force != null && typeof body.force !== 'boolean') return fail(400, 'invalid_force', 'force must be a boolean');
    const parsed = parseWebsiteUrl(body.website_url, { allowAnyPort: cfg.allowAnyPort, allowPrivate: cfg.allowPrivateNetworks });
    if (parsed.error) return fail(400, 'invalid_website_url', parsed.error);

    if (inflight >= cfg.maxConcurrent) return { ...fail(429, 'too_many_requests', 'Too many analyses in progress; retry shortly'), headers: { 'retry-after': '5' } };
    inflight++;
    try {
      // ---- business (owner_id is taken from the database, never from the caller)
      const business = await store.getBusiness(body.business_id);
      if (!business) return fail(404, 'business_not_found', 'No business with that id');

      // ---- optional freshness gate (campaign's stale_after_days)
      let staleAfterDays = cfg.defaultStaleAfterDays;
      let campaign = null;
      if (body.campaign_id) {
        campaign = await store.getCampaign(body.campaign_id);
        if (!campaign) return fail(404, 'campaign_not_found', 'No campaign with that id');
        staleAfterDays = campaign.stale_after_days ?? staleAfterDays;
        if (!body.force) {
          const current = await store.getCurrentChecks(business.id);
          const fresh = needsReanalysis({ requiredChecks: campaign.required_checks ?? [], currentChecks: current, staleAfterDays, now: now() });
          if (!fresh.needs && (campaign.required_checks ?? []).length > 0) {
            return reply(200, { ok: true, status: 'skipped_fresh', business_id: business.id, message: 'All required checks are still fresh; pass force=true to re-analyze' });
          }
        }
      }

      // ---- analyze
      const industry = business.industry ?? campaign?.industry ?? null;
      const analysis = await analyze({
        business_id: business.id, owner_id: business.owner_id, name: business.business_name, industry,
        website_url: parsed.url, source: business.source ?? null, source_url: business.source_url ?? null,
      }, {
        now: now(), staleAfterDays,
        http: { allowPrivate: cfg.allowPrivateNetworks, ...cfg.http },
        deadlineMs: cfg.deadlineMs, maxPages: cfg.maxPages, crawlDelayMs: cfg.crawlDelayMs,
      });

      // ---- persist through the existing append-only checks table
      let stored;
      try {
        stored = await store.insertChecks(analysis.checks);
      } catch (err) {
        if (err?.code === '23505') return fail(409, 'concurrent_analysis', 'Another analysis for this business is running; retry');
        if (err?.name === 'StoreError') return fail(502, 'database_error', err.message, { db_code: err.code ?? null });
        throw err;
      }
      const summary = { yes: 0, no: 0, unknown: 0, not_applicable: 0 };
      for (const c of analysis.checks) summary[c.result]++;
      await store.insertEvent({
        owner_id: business.owner_id, event_type: 'analysis.completed', entity_type: 'business', entity_id: business.id,
        campaign_id: campaign?.id ?? null, business_id: business.id, actor: 'system',
        payload: { checker_version: CHECKER_VERSION, website_url: parsed.url, site_state: analysis.siteState, conclusive: analysis.conclusive, summary, inconclusive_reasons: analysis.crawl?.inconclusive_reasons ?? [] },
      }).catch(() => { /* an audit-event failure must not hide successfully stored checks */ });

      // ---- score every campaign this business is linked to (Part 5C) - best-effort:
      // reused exactly as scoreAllCampaignsForBusiness() already exists (no campaign_id
      // needed here; it discovers every linked campaign itself). A per-campaign failure
      // is already isolated inside that function; this try/catch additionally covers a
      // TOTAL failure (e.g. the initial lookup itself erroring) so that even that can
      // never turn a successful analysis into an error response.
      let scoring;
      try {
        const scored = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
        scoring = {
          attempted: true,
          campaigns_scored: scored.results.filter((r) => r.ok).length,
          campaigns_failed: scored.results.filter((r) => !r.ok).length,
          results: scored.results,
        };
      } catch (err) {
        scoring = {
          attempted: true, campaigns_scored: 0, campaigns_failed: 0, results: [],
          error: { name: err?.name ?? 'Error', code: err?.code ?? null, message: err?.message ?? 'Unknown scoring error' },
        };
      }

      return reply(200, {
        ok: true, status: 'analyzed', business_id: business.id, website_url: parsed.url, analyzed_at: analysis.checks[0].checked_at,
        checker_version: CHECKER_VERSION, site_state: analysis.siteState, conclusive: analysis.conclusive, summary,
        checks: (stored ?? analysis.checks).map((c) => ({
          id: c.id, check_type: c.check_type, result: c.result, confidence: c.confidence, evidence_url: c.evidence_url,
          evidence_excerpt: c.evidence_excerpt, method: c.method, http_status: c.http_status, checked_at: c.checked_at,
          expires_at: c.expires_at, is_current: c.is_current, evidence: c.evidence, error: c.error,
        })),
        crawl: analysis.crawl,
        scoring,
      });
    } catch (err) {
      if (err?.name === 'StoreError') return fail(502, 'database_error', err.message, { db_code: err.code ?? null });
      console.error('[analyze] unexpected error:', err?.message);
      return fail(500, 'internal_error', 'Unexpected error while analyzing');
    } finally {
      inflight--;
    }
  };
}
