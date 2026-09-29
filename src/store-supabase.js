// Talks to Supabase through PostgREST (the same API supabase-js uses), with the
// SERVICE ROLE key. Server-side only. No dependencies.
import { StoreError } from './errors.js';
import { assertSafeTarget } from './safety.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (id, name) => { if (!UUID.test(String(id))) throw new StoreError(`${name} must be a UUID`, { code: '22P02', status: 400 }); return String(id); };

export class SupabaseStore {
  constructor({ url, serviceKey, confirmRemoteHost, fetchImpl = globalThis.fetch }) {
    if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    this.target = assertSafeTarget(url, confirmRemoteHost);
    this.base = url.replace(/\/+$/, '') + '/rest/v1';
    this.key = serviceKey;
    this.fetch = fetchImpl;
  }

  async rest(method, path, { query = '', body, prefer } = {}) {
    const res = await this.fetch(`${this.base}/${path}${query ? '?' + query : ''}`, {
      method,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(prefer ? { prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      throw new StoreError(json?.message || `HTTP ${res.status}`, { code: json?.code ?? null, status: res.status, details: json?.details ?? null, hint: json?.hint ?? null });
    }
    return json;
  }

  async getBusiness(id) {
    const rows = await this.rest('GET', 'businesses', { query: `id=eq.${need(id, 'business_id')}&select=id,owner_id,business_name,industry,website_url,website_status,source,source_id,source_url,city,state` });
    return rows?.[0] ?? null;
  }

  async getCampaign(id) {
    const rows = await this.rest('GET', 'campaigns', { query: `id=eq.${need(id, 'campaign_id')}&select=id,owner_id,industry,required_checks,stale_after_days,status,score_weights,hot_min_score,warm_min_score` });
    return rows?.[0] ?? null;
  }

  getCurrentChecks(businessId) {
    return this.rest('GET', 'checks', { query: `business_id=eq.${need(businessId, 'business_id')}&is_current=is.true&select=*` });
  }

  getChecks(businessId) {
    return this.rest('GET', 'checks', { query: `business_id=eq.${need(businessId, 'business_id')}&select=*&order=checked_at.desc,created_at.desc` });
  }

  /** One request = one transaction: either every row is stored or none is. */
  insertChecks(rows) {
    return this.rest('POST', 'checks', { body: rows, prefer: 'return=representation' });
  }

  insertEvent(row) {
    return this.rest('POST', 'events', { body: row, prefer: 'return=minimal' });
  }

  // ---------------------------------------------------------------- discovery (Part 3)

  static BUSINESS_COLUMNS = 'id,source_id,industry,business_name,sub_industry,address_line,city,state,postal_code,country,latitude,longitude,website_url,website_domain,public_business_phone,source_url,source_rating,source_review_count,dedupe_key,raw_source';

  /** Existing businesses for a set of source ids (Google Place IDs), scoped to one owner. */
  async findBusinessesBySource(ownerId, source, sourceIds) {
    if (!sourceIds.length) return [];
    const ids = sourceIds.map((id) => {
      if (!/^[A-Za-z0-9_-]{5,300}$/.test(String(id))) throw new StoreError('source_id has an unexpected format', { code: '22P02', status: 400 });
      return `"${id}"`;
    });
    return this.rest('GET', 'businesses', {
      query: `owner_id=eq.${need(ownerId, 'owner_id')}&source=eq.${encodeURIComponent(source)}&source_id=in.(${ids.join(',')})&select=${SupabaseStore.BUSINESS_COLUMNS}`,
    });
  }

  /** INSERT ... ON CONFLICT (owner_id, source, source_id) DO NOTHING. Returns ONLY the rows actually inserted. */
  insertBusinessesIgnoreDuplicates(rows) {
    return this.rest('POST', 'businesses', {
      query: 'on_conflict=owner_id,source,source_id', body: rows, prefer: 'resolution=ignore-duplicates,return=representation',
    });
  }

  updateBusiness(id, patch) {
    return this.rest('PATCH', 'businesses', { query: `id=eq.${need(id, 'business_id')}`, body: patch, prefer: 'return=minimal' });
  }

  /** INSERT ... ON CONFLICT (campaign_id, business_id) DO NOTHING. Returns ONLY newly created links. */
  linkBusinessesToCampaign(rows) {
    return this.rest('POST', 'campaign_businesses', {
      query: 'on_conflict=campaign_id,business_id', body: rows, prefer: 'resolution=ignore-duplicates,return=representation',
    });
  }

  insertEvents(rows) {
    return this.rest('POST', 'events', { body: rows, prefer: 'return=minimal' });
  }

  // ---------------------------------------------------------------- scoring (Part 4A)

  async getCampaignBusiness(campaignId, businessId) {
    const rows = await this.rest('GET', 'campaign_businesses', {
      query: `campaign_id=eq.${need(campaignId, 'campaign_id')}&business_id=eq.${need(businessId, 'business_id')}&select=*`,
    });
    return rows?.[0] ?? null;
  }

  /** Every campaign this business is linked to, independent of any single campaign_id. */
  async getCampaignBusinessesForBusiness(businessId) {
    return this.rest('GET', 'campaign_businesses', {
      query: `business_id=eq.${need(businessId, 'business_id')}&select=*`,
    });
  }

  /** score_reasons is append-only audit trail; no on_conflict - a duplicate (cb, version, rule_key) is a real bug and must error. */
  insertScoreReasons(rows) {
    return this.rest('POST', 'score_reasons', { body: rows, prefer: 'return=minimal' });
  }

  /** Compensating rollback only - used when apply_score() fails after reasons for a new version were written, so a retry can safely reuse that version. */
  deleteScoreReasons(campaignBusinessId, scoreVersion) {
    return this.rest('DELETE', 'score_reasons', {
      query: `campaign_business_id=eq.${need(campaignBusinessId, 'campaign_business_id')}&score_version=eq.${Number(scoreVersion)}`,
      prefer: 'return=minimal',
    });
  }

  /** Calls the EXISTING public.apply_score(uuid,int) function - sums score_reasons for that version, caps 0-100, sets tier, updates campaign_businesses. Returns the total score. */
  applyScore(campaignBusinessId, scoreVersion) {
    return this.rest('POST', 'rpc/apply_score', {
      body: { p_campaign_business_id: need(campaignBusinessId, 'campaign_business_id'), p_score_version: Number(scoreVersion) },
    });
  }
}
