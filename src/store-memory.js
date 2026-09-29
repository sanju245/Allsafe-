// In-memory stand-in that ENFORCES THE SAME RULES as the Postgres schema
// (evidence constraint, one current row per (business, type), append-only, FK,
// summary columns maintained like the checks_after_insert_summary trigger).
// Used by tests and by the fake PostgREST server; never used in production.
import { randomUUID } from 'node:crypto';
import { CHECK_TYPES, RESULTS } from './constants.js';
import { hasEvidence } from './check.js';
import { StoreError } from './errors.js';

export class MemoryStore {
  constructor() { this.campaigns = new Map(); this.businesses = new Map(); this.checks = []; this.events = []; this.campaignBusinesses = []; this.scoreReasons = []; }

  addCampaign(c) {
    const row = {
      id: randomUUID(), stale_after_days: 30, required_checks: [], status: 'draft',
      // mirrors campaigns.score_weights / hot_min_score / warm_min_score DEFAULTs in the schema
      score_weights: {
        no_website: 40, no_online_ordering: 25, no_online_booking: 25, no_online_menu: 15, poor_mobile: 20,
        outdated_website: 20, no_clear_cta: 10, phone_only_process: 15, social_only_presence: 20, poor_navigation: 10,
      },
      hot_min_score: 70, warm_min_score: 40,
      ...c,
    };
    this.campaigns.set(row.id, row);
    return row;
  }

  addBusiness(b) {
    const row = {
      id: randomUUID(), website_status: 'unknown', online_ordering: 'unknown', online_menu: 'unknown',
      online_booking: 'unknown', reservation_available: 'unknown', last_analyzed_at: null,
      source: 'google_places', source_id: randomUUID(), ...b,
    };
    this.businesses.set(row.id, row);
    return row;
  }

  async getBusiness(id) { return this.businesses.get(id) ?? null; }
  async getCampaign(id) { return this.campaigns.get(id) ?? null; }
  async getCurrentChecks(businessId) { return this.checks.filter((c) => c.business_id === businessId && c.is_current); }
  async getChecks(businessId) {
    return this.checks.filter((c) => c.business_id === businessId)
      .sort((a, b) => (a.checked_at < b.checked_at ? 1 : a.checked_at > b.checked_at ? -1 : b.seq - a.seq));
  }

  static validate(row, store) {
    const bad = (code, message) => { throw new StoreError(message, { code, status: code === '23503' ? 409 : 400 }); };
    if (!CHECK_TYPES.includes(row.check_type)) bad('22P02', `invalid input value for enum check_type: "${row.check_type}"`);
    if (!RESULTS.includes(row.result)) bad('22P02', `invalid input value for enum check_result: "${row.result}"`);
    if (!row.method) bad('23502', 'null value in column "method" violates not-null constraint');
    if (!row.business_id || !store.businesses.has(row.business_id)) bad('23503', 'insert or update on table "checks" violates foreign key constraint "checks_business_id_fkey"');
    if (!row.owner_id) bad('23502', 'null value in column "owner_id" violates not-null constraint');
    if (row.confidence != null && (row.confidence < 0 || row.confidence > 1)) bad('23514', 'new row for relation "checks" violates check constraint "checks_confidence_check"');
    if (!['unknown', 'not_applicable'].includes(row.result) && !hasEvidence(row)) {
      bad('23514', 'new row for relation "checks" violates check constraint "checks_evidence_required"');
    }
  }

  async insertChecks(rows) {
    rows.forEach((r) => MemoryStore.validate(r, this)); // all-or-nothing, like one SQL statement
    const seen = new Set();
    for (const r of rows) {
      const k = `${r.business_id}|${r.check_type}`;
      if (r.is_current !== false && seen.has(k)) throw new StoreError('duplicate key value violates unique constraint "checks_one_current_idx"', { code: '23505', status: 409 });
      if (r.is_current !== false) seen.add(k);
    }
    const stored = [];
    for (const r of rows) {
      if (r.is_current !== false) {
        for (const old of this.checks) if (old.business_id === r.business_id && old.check_type === r.check_type && old.is_current) old.is_current = false;
      }
      const row = { is_current: true, created_at: new Date().toISOString(), ...r, id: r.id ?? randomUUID(), seq: this.checks.length };
      this.checks.push(row);
      stored.push(row);
    }
    for (const bid of new Set(rows.map((r) => r.business_id))) this.#refreshSummary(bid);
    return stored.map(({ seq, ...rest }) => rest);
  }

  // ---------------------------------------------------------------- discovery (Part 3)
  // Mirrors: businesses NOT NULL / range checks / unique (owner_id, source, source_id),
  //          campaign_businesses FKs / unique (campaign_id, business_id) and column defaults.

  static #bad(code, message, status = 400) { throw new StoreError(message, { code, status }); }

  static validateBusiness(r) {
    const bad = MemoryStore.#bad;
    if (!r.owner_id) bad('23502', 'null value in column "owner_id" of relation "businesses" violates not-null constraint');
    if (typeof r.business_name !== 'string' || !r.business_name.trim()) bad('23502', 'null value in column "business_name" of relation "businesses" violates not-null constraint');
    if (typeof r.source_id !== 'string' || !r.source_id) bad('23502', 'null value in column "source_id" of relation "businesses" violates not-null constraint');
    if (r.latitude != null && !(r.latitude >= -90 && r.latitude <= 90)) bad('23514', 'new row for relation "businesses" violates check constraint "businesses_latitude_check"');
    if (r.longitude != null && !(r.longitude >= -180 && r.longitude <= 180)) bad('23514', 'new row for relation "businesses" violates check constraint "businesses_longitude_check"');
    if (r.source_rating != null && !(r.source_rating >= 0 && r.source_rating < 10)) bad('22003', 'numeric field overflow');
  }

  async findBusinessesBySource(ownerId, source, sourceIds) {
    const want = new Set(sourceIds);
    return [...this.businesses.values()].filter((b) => b.owner_id === ownerId && b.source === source && want.has(b.source_id)).map((b) => ({ ...b }));
  }

  /** INSERT ... ON CONFLICT (owner_id, source, source_id) DO NOTHING; returns only inserted rows. All-or-nothing on validation. */
  async insertBusinessesIgnoreDuplicates(rows) {
    rows.forEach((r) => MemoryStore.validateBusiness(r));
    const out = [];
    for (const r of rows) {
      const source = r.source ?? 'google_places';
      const dup = [...this.businesses.values()].some((b) => b.owner_id === r.owner_id && b.source === source && b.source_id === r.source_id);
      if (dup) continue;
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(), industry: null, sub_industry: null, address_line: null, city: null, state: null, postal_code: null, country: 'US',
        latitude: null, longitude: null, website_url: null, website_domain: null, public_business_email: null, public_business_phone: null,
        whatsapp: null, social_media: {}, hours: null, source_url: null, source_rating: null, source_review_count: null, dedupe_key: null, raw_source: null,
        website_status: 'unknown', online_ordering: 'unknown', online_menu: 'unknown', online_booking: 'unknown', reservation_available: 'unknown',
        last_analyzed_at: null, first_seen_at: now, created_at: now, updated_at: now, ...r, source,
      };
      this.businesses.set(row.id, row);
      out.push({ ...row });
    }
    return out;
  }

  async updateBusiness(id, patch) {
    const b = this.businesses.get(id);
    if (!b) return null;
    MemoryStore.validateBusiness({ ...b, ...patch });
    Object.assign(b, patch, { updated_at: new Date().toISOString() });
    return null;
  }

  /** INSERT ... ON CONFLICT (campaign_id, business_id) DO NOTHING; returns only newly created links. */
  async linkBusinessesToCampaign(rows) {
    for (const r of rows) {
      if (!this.campaigns.has(r.campaign_id)) MemoryStore.#bad('23503', 'insert or update on table "campaign_businesses" violates foreign key constraint "campaign_businesses_campaign_id_fkey"', 409);
      if (!this.businesses.has(r.business_id)) MemoryStore.#bad('23503', 'insert or update on table "campaign_businesses" violates foreign key constraint "campaign_businesses_business_id_fkey"', 409);
      if (!r.owner_id) MemoryStore.#bad('23502', 'null value in column "owner_id" of relation "campaign_businesses" violates not-null constraint');
    }
    const out = [];
    for (const r of rows) {
      if (this.campaignBusinesses.some((l) => l.campaign_id === r.campaign_id && l.business_id === r.business_id)) continue;
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(), lead_status: 'new', opportunity_score: null, priority: 'unscored', opportunity_type: [], verified_problems: [],
        recommended_features: [], score_version: 0, scored_at: null, qualified_at: null, notes: null, created_at: now, updated_at: now, ...r,
      };
      this.campaignBusinesses.push(row);
      out.push({ ...row });
    }
    return out;
  }

  async insertEvents(rows) { for (const e of rows) await this.insertEvent(e); return null; }

  async insertEvent(e) { this.events.push({ id: this.events.length + 1, occurred_at: new Date().toISOString(), ...e }); return null; }

  // ---------------------------------------------------------------- scoring (Part 4A)
  // Mirrors: score_reasons' FKs (campaign_business_id,campaign_id,business_id) and
  // (check_id,business_id), its points check and (cb,version,rule_key) uniqueness,
  // and public.apply_score(uuid,int) exactly (sum -> clamp[0,100] -> tier -> update cb).

  async getCampaignBusiness(campaignId, businessId) {
    const row = this.campaignBusinesses.find((r) => r.campaign_id === campaignId && r.business_id === businessId);
    return row ? { ...row } : null;
  }

  async getCampaignBusinessesForBusiness(businessId) {
    return this.campaignBusinesses.filter((r) => r.business_id === businessId).map((r) => ({ ...r }));
  }

  static validateScoreReason(r, store) {
    const bad = MemoryStore.#bad;
    if (!r.owner_id) bad('23502', 'null value in column "owner_id" of relation "score_reasons" violates not-null constraint');
    if (typeof r.rule_key !== 'string' || !r.rule_key) bad('23502', 'null value in column "rule_key" of relation "score_reasons" violates not-null constraint');
    if (typeof r.description !== 'string' || !r.description) bad('23502', 'null value in column "description" of relation "score_reasons" violates not-null constraint');
    if (typeof r.points !== 'number' || r.points < -100 || r.points > 100) bad('23514', 'new row for relation "score_reasons" violates check constraint "score_reasons_points_check"');
    if (!Number.isInteger(r.score_version)) bad('23502', 'null value in column "score_version" of relation "score_reasons" violates not-null constraint');
    const cb = store.campaignBusinesses.find((x) => x.id === r.campaign_business_id);
    if (!cb || cb.campaign_id !== r.campaign_id || cb.business_id !== r.business_id) {
      bad('23503', 'insert or update on table "score_reasons" violates foreign key constraint "score_reasons_cb_fk"', 409);
    }
    const chk = store.checks.find((c) => c.id === r.check_id);
    if (!chk || chk.business_id !== r.business_id) {
      bad('23503', 'insert or update on table "score_reasons" violates foreign key constraint "score_reasons_check_fk"', 409);
    }
  }

  /** No on_conflict - append-only audit trail. All rows validated first (all-or-nothing), then a (cb,version,rule_key) collision is a real, surfaced error. */
  async insertScoreReasons(rows) {
    rows.forEach((r) => MemoryStore.validateScoreReason(r, this));
    const seen = new Set();
    for (const r of rows) {
      const k = `${r.campaign_business_id}|${r.score_version}|${r.rule_key}`;
      const dup = seen.has(k) || this.scoreReasons.some((x) => x.campaign_business_id === r.campaign_business_id && x.score_version === r.score_version && x.rule_key === r.rule_key);
      if (dup) MemoryStore.#bad('23505', 'duplicate key value violates unique constraint "score_reasons_unique"', 409);
      seen.add(k);
    }
    const now = new Date().toISOString();
    const out = rows.map((r) => ({ id: randomUUID(), supporting_check_ids: [], created_at: now, ...r }));
    this.scoreReasons.push(...out);
    return out.map((r) => ({ ...r }));
  }

  async deleteScoreReasons(campaignBusinessId, scoreVersion) {
    this.scoreReasons = this.scoreReasons.filter((r) => !(r.campaign_business_id === campaignBusinessId && r.score_version === scoreVersion));
    return null;
  }

  /** Mirrors public.apply_score(uuid,int): raises if the cb row doesn't exist; otherwise sums THIS version's reasons, clamps to [0,100], sets tier from the campaign's own thresholds, and updates campaign_businesses. */
  async applyScore(campaignBusinessId, scoreVersion) {
    const cb = this.campaignBusinesses.find((r) => r.id === campaignBusinessId);
    if (!cb) throw new StoreError(`campaign_business ${campaignBusinessId} not found`, { code: 'P0001', status: 400 });
    const campaign = this.campaigns.get(cb.campaign_id);
    const hot = campaign?.hot_min_score ?? 70;
    const warm = campaign?.warm_min_score ?? 40;
    const sum = this.scoreReasons
      .filter((r) => r.campaign_business_id === campaignBusinessId && r.score_version === scoreVersion)
      .reduce((total, r) => total + r.points, 0);
    const clamped = Math.min(100, Math.max(0, sum));
    cb.opportunity_score = clamped;
    cb.priority = clamped >= hot ? 'hot' : clamped >= warm ? 'warm' : 'low';
    cb.score_version = scoreVersion;
    cb.scored_at = new Date().toISOString();
    cb.updated_at = cb.scored_at;
    return clamped;
  }

  #refreshSummary(businessId) {
    const b = this.businesses.get(businessId);
    const cur = (t) => this.checks.find((c) => c.business_id === businessId && c.check_type === t && c.is_current)?.result;
    b.online_ordering = cur('online_ordering') ?? 'unknown';
    b.online_menu = cur('online_menu') ?? 'unknown';
    b.online_booking = cur('online_booking') ?? 'unknown';
    b.reservation_available = cur('reservations') ?? 'unknown';
    const present = cur('website_present'), reach = cur('website_reachable');
    if (present === 'no') b.website_status = 'none_found';
    else if (present === 'yes' && reach === 'no') b.website_status = 'unreachable';
    else if (present === 'yes' && reach === 'yes') b.website_status = 'active';
    const times = this.checks.filter((c) => c.business_id === businessId && c.is_current).map((c) => c.checked_at);
    b.last_analyzed_at = times.sort().at(-1) ?? null;
  }
}
