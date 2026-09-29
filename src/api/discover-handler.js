// POST /api/discover - framework-agnostic handler.
//
//   Authorization: Bearer <DISCOVER_API_KEY | ANALYZE_API_KEY>
//   { "campaign_id": "<uuid>", "category": "pizza", "location": "Houston, TX", "limit": 20,
//     "page_token": "<optional, from a previous response>", "dry_run": false }
//
// Finds businesses with Google Places (New) Text Search, saves them (deduped on Google Place ID,
// businesses without websites included) and links each to the campaign. It never scores,
// analyzes, emails, or builds any dashboard.
import { discover } from '../discover/discover.js';
import { GooglePlacesError, MAX_RESULTS_PER_QUERY } from '../discover/google-places.js';
import { UUID, reply, fail, checkBearer } from './common.js';

const TEXT = /^[\p{L}\p{N} &'’,./+#-]+$/u;
const TOKEN = /^[A-Za-z0-9_=.:-]{10,2048}$/;
let inflight = 0;

export function parseDiscoverInput(body, { maxLimit = MAX_RESULTS_PER_QUERY } = {}) {
  const err = (code, message) => ({ error: { code, message } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err('invalid_body', 'Body must be a JSON object');
  if (!UUID.test(String(body.campaign_id ?? ''))) return err('invalid_campaign_id', 'campaign_id must be a UUID');
  const category = typeof body.category === 'string' ? body.category.replace(/\s+/g, ' ').trim() : '';
  if (category.length < 2 || category.length > 80 || !TEXT.test(category)) return err('invalid_category', 'category must be 2-80 characters of letters, digits, spaces and & \' , . / + # -');
  const location = typeof body.location === 'string' ? body.location.replace(/\s+/g, ' ').trim() : '';
  if (location.length < 2 || location.length > 120 || !TEXT.test(location)) return err('invalid_location', 'location must be 2-120 characters, for example "Houston, TX"');
  let limit = 20;
  if (body.limit !== undefined && body.limit !== null) {
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > maxLimit) return err('invalid_limit', `limit must be an integer from 1 to ${maxLimit}`);
    limit = body.limit;
  }
  if (body.page_token != null && (typeof body.page_token !== 'string' || !TOKEN.test(body.page_token))) return err('invalid_page_token', 'page_token must be the next_page_token returned by a previous call');
  if (body.dry_run != null && typeof body.dry_run !== 'boolean') return err('invalid_dry_run', 'dry_run must be a boolean');
  return { value: { campaign_id: body.campaign_id, category, location, limit, pageToken: body.page_token ?? null, dryRun: body.dry_run === true } };
}

export function createDiscoverHandler({ store, places, config = {}, now = () => new Date() }) {
  const cfg = {
    apiKey: config.apiKey,
    maxConcurrent: config.maxConcurrent ?? 2,
    maxLimit: Math.min(config.maxLimit ?? MAX_RESULTS_PER_QUERY, MAX_RESULTS_PER_QUERY),
    discover: { maxPages: 5, pageDelayMs: 150, regionCode: 'US', ...(config.discover || {}) },
  };

  return async function handle({ method, headers = {}, rawBody = '' }) {
    if (method !== 'POST') return { ...fail(405, 'method_not_allowed', 'Use POST'), headers: { allow: 'POST' } };
    const denied = checkBearer(headers, cfg.apiKey);
    if (denied) return denied;

    let body;
    try { body = JSON.parse(rawBody || '{}'); } catch { return fail(400, 'invalid_json', 'Body must be valid JSON'); }
    const parsed = parseDiscoverInput(body, { maxLimit: cfg.maxLimit });
    if (parsed.error) return fail(400, parsed.error.code, parsed.error.message);
    const input = parsed.value;

    if (inflight >= cfg.maxConcurrent) return { ...fail(429, 'too_many_requests', 'Too many discoveries in progress; retry shortly'), headers: { 'retry-after': '5' } };
    inflight++;
    try {
      const campaign = await store.getCampaign(input.campaign_id);
      if (!campaign) return fail(404, 'campaign_not_found', 'No campaign with that id');
      if (campaign.status === 'archived') return fail(409, 'campaign_archived', 'Archived campaigns cannot be extended');

      const result = await discover({
        store, places, campaign, category: input.category, location: input.location, limit: input.limit,
        pageToken: input.pageToken, dryRun: input.dryRun, now: now(), config: cfg.discover,
      });
      return reply(200, { ok: true, campaign_id: campaign.id, ...result });
    } catch (err) {
      if (err instanceof GooglePlacesError) return googleFailure(err, input);
      if (err?.name === 'StoreError') return fail(502, 'database_error', err.message, { db_code: err.code ?? null });
      console.error('[discover] unexpected error:', err?.message);
      return fail(500, 'internal_error', 'Unexpected error while discovering businesses');
    } finally {
      inflight--;
    }
  };
}

function googleFailure(err, input) {
  switch (err.kind) {
    case 'quota':
      return { ...fail(429, 'google_quota_exceeded', err.message, { retry_after_seconds: err.retryAfterSeconds }), headers: { 'retry-after': String(err.retryAfterSeconds ?? 30) } };
    case 'auth':
      return fail(502, 'google_auth_failed', err.message, { google_status: err.googleStatus });
    case 'bad_request':
      if (input.pageToken) return fail(400, 'invalid_page_token', 'Google rejected the page_token (it may have expired); start again without page_token', { google_status: err.googleStatus });
      return fail(502, 'google_bad_request', err.message, { google_status: err.googleStatus });
    case 'invalid_response':
      return fail(502, 'google_invalid_response', err.message);
    default:
      return fail(502, 'google_unavailable', err.message);
  }
}
