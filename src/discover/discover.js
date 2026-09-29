// Discovery core: search Google Places -> map -> upsert businesses (deduped on Google Place ID)
// -> link to the campaign. Idempotent: running it again never duplicates a business or a
// campaign link, and never overwrites data owned by other stages (analysis results,
// scores, lead status).
import { mapPlace } from './map-place.js';
import { MAX_PAGE_SIZE, MAX_RESULTS_PER_QUERY, GooglePlacesError } from './google-places.js';

export const SOURCE = 'google_places';

// Public listing fields that discovery may refresh on an existing business.
export const REFRESHABLE_FIELDS = [
  'business_name', 'sub_industry', 'address_line', 'city', 'state', 'postal_code', 'country',
  'latitude', 'longitude', 'website_url', 'website_domain', 'public_business_phone',
  'source_url', 'source_rating', 'source_review_count', 'dedupe_key',
];

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

const same = (a, b) => a === b || (a != null && typeof b === 'number' && Number(a) === b);

/** Only non-null new values may change a stored value: a refresh never erases what we already know. */
export function diffPatch(existing, incoming) {
  const patch = {};
  for (const f of REFRESHABLE_FIELDS) {
    const next = incoming[f];
    if (next === null || next === undefined) continue;
    if (!same(existing[f], next)) patch[f] = next;
  }
  if (existing.industry == null && incoming.industry) patch.industry = incoming.industry;
  return patch;
}

async function persistPage({ store, campaign, rows, now }) {
  const out = { created: [], existing: [], updated: [], linkedNew: 0, alreadyLinked: 0, byPlace: new Map() };
  if (!rows.length) return out;
  const ownerId = campaign.owner_id;
  const ids = rows.map((r) => r.source_id);

  // 1) which of these Place IDs do we already have?
  const existingRows = await store.findBusinessesBySource(ownerId, SOURCE, ids);
  const known = new Map(existingRows.map((r) => [r.source_id, r]));

  // 2) insert the new ones; ON CONFLICT DO NOTHING makes concurrent runs safe
  const fresh = rows.filter((r) => !known.has(r.source_id));
  const insertedRows = fresh.length ? await store.insertBusinessesIgnoreDuplicates(fresh) : [];
  const inserted = new Map(insertedRows.map((r) => [r.source_id, r]));
  const raced = fresh.filter((r) => !inserted.has(r.source_id)); // another run inserted them first
  if (raced.length) {
    for (const r of await store.findBusinessesBySource(ownerId, SOURCE, raced.map((x) => x.source_id))) known.set(r.source_id, r);
  }

  // 3) refresh public fields of businesses we already had (never null-out, never touch other stages' columns)
  const byId = new Map();
  for (const r of rows) {
    const row = inserted.get(r.source_id) ?? known.get(r.source_id);
    if (!row) throw new Error(`business for place ${r.source_id} could not be stored or found`);
    const wasCreated = inserted.has(r.source_id);
    let wasUpdated = false;
    if (!wasCreated) {
      const patch = diffPatch(row, r);
      if (Object.keys(patch).length) {
        await store.updateBusiness(row.id, { ...patch, raw_source: { ...(row.raw_source || {}), ...r.raw_source } });
        wasUpdated = true;
      }
    }
    byId.set(r.source_id, { id: row.id, row: r, created: wasCreated, updated: wasUpdated });
  }

  // 4) link EVERY discovered business to the campaign (existing links are left untouched)
  const linkRows = [...byId.values()].map((b) => ({ owner_id: ownerId, campaign_id: campaign.id, business_id: b.id }));
  const linked = await store.linkBusinessesToCampaign(linkRows);
  const linkedIds = new Set(linked.map((l) => l.business_id));

  // 5) history: one event per NEW business
  const createdEntries = [...byId.values()].filter((b) => b.created);
  if (createdEntries.length) {
    try {
      await store.insertEvents(createdEntries.map((b) => ({
        owner_id: ownerId, event_type: 'business.discovered', entity_type: 'business', entity_id: b.id,
        campaign_id: campaign.id, business_id: b.id, actor: 'system',
        payload: { source: SOURCE, place_id: b.row.source_id, has_website: !!b.row.website_url, query: b.row.raw_source.query },
      })));
    } catch { out.eventsFailed = true; } // audit history is best-effort: never hide saved businesses
  }

  for (const [placeId, b] of byId) {
    out.byPlace.set(placeId, { ...b, linkedNew: linkedIds.has(b.id) });
    if (b.created) out.created.push(placeId); else out.existing.push(placeId);
    if (b.updated) out.updated.push(placeId);
    if (linkedIds.has(b.id)) out.linkedNew++; else out.alreadyLinked++;
  }
  return out;
}

/**
 * @param places  a GooglePlacesClient (or anything with searchText())
 * @returns summary + per-business results; throws GooglePlacesError if the FIRST page fails,
 *          otherwise returns status 'partial' with what was already saved.
 */
export async function discover({ store, places, campaign, category, location, limit, pageToken = null, dryRun = false, now = new Date(), config = {} }) {
  const cfg = { maxPages: 5, pageDelayMs: 150, regionCode: 'US', includePureServiceAreaBusinesses: true, sleep: sleepReal, ...config };
  const query = `${category} in ${location}`;
  const target = Math.min(limit, MAX_RESULTS_PER_QUERY);
  const fetchedAt = now.toISOString();

  const summary = {
    pages_fetched: 0, places_returned: 0, discovered: 0, created: 0, updated: 0, already_existing: 0,
    linked_new: 0, already_linked: 0, skipped_closed: 0, skipped_invalid: 0, duplicates_in_response: 0,
    with_website: 0, without_website: 0,
  };
  const warnings = [];
  const businesses = [];
  const seen = new Set();
  let token = pageToken;
  let nextPageToken = null;
  let exhausted = false;
  let partialError = null;
  let saved = 0;

  while (saved < target && summary.pages_fetched < cfg.maxPages) {
    const pageSize = Math.min(MAX_PAGE_SIZE, target - saved);
    let page;
    try {
      page = await places.searchText({
        query, pageSize, pageToken: token, regionCode: cfg.regionCode, includePureServiceAreaBusinesses: cfg.includePureServiceAreaBusinesses,
      });
    } catch (err) {
      if (summary.pages_fetched === 0 || !(err instanceof GooglePlacesError)) throw err;
      partialError = err;
      break;
    }
    summary.pages_fetched++;

    const rows = [];
    for (const place of page.places) {
      summary.places_returned++;
      const m = mapPlace(place, { category, ownerId: campaign.owner_id, query, fetchedAt, defaultCountry: cfg.regionCode });
      if (m.skip === 'invalid') { summary.skipped_invalid++; continue; }
      if (m.skip === 'closed') { summary.skipped_closed++; continue; }
      if (seen.has(m.row.source_id)) { summary.duplicates_in_response++; continue; }
      if (saved + rows.length >= target) { warnings.push('google_returned_more_than_requested_page_size_extra_results_ignored'); page.nextPageToken = null; break; }
      seen.add(m.row.source_id);
      rows.push(m.row);
    }

    if (!dryRun) {
      const res = await persistPage({ store, campaign, rows, now });
      summary.created += res.created.length;
      summary.updated += res.updated.length;
      summary.already_existing += res.existing.length;
      summary.linked_new += res.linkedNew;
      if (res.eventsFailed && !warnings.includes('event_log_failed')) warnings.push('event_log_failed');
      summary.already_linked += res.alreadyLinked;
      for (const r of rows) {
        const b = res.byPlace.get(r.source_id);
        businesses.push({ business_id: b.id, place_id: r.source_id, name: r.business_name, address_line: r.address_line, city: r.city, state: r.state, postal_code: r.postal_code, latitude: r.latitude, longitude: r.longitude, phone: r.public_business_phone, website_url: r.website_url, category: r.industry, created: b.created, updated: b.updated, linked_to_campaign: true, newly_linked: b.linkedNew });
      }
    } else {
      for (const r of rows) businesses.push({ business_id: null, place_id: r.source_id, name: r.business_name, address_line: r.address_line, city: r.city, state: r.state, postal_code: r.postal_code, latitude: r.latitude, longitude: r.longitude, phone: r.public_business_phone, website_url: r.website_url, category: r.industry, created: null, updated: null, linked_to_campaign: false, newly_linked: false });
    }
    for (const r of rows) (r.website_url ? summary.with_website++ : summary.without_website++);
    saved += rows.length;
    summary.discovered = saved;

    token = page.nextPageToken;
    nextPageToken = token;
    if (!token) { exhausted = true; break; }
    if (saved < target && summary.pages_fetched < cfg.maxPages) await cfg.sleep(cfg.pageDelayMs);
  }

  if (saved >= target && nextPageToken) warnings.push('limit_reached_more_results_available_use_next_page_token');
  if (summary.pages_fetched >= cfg.maxPages && saved < target && nextPageToken) warnings.push('page_cap_reached_use_next_page_token_to_continue');

  if (!dryRun) {
    await store.insertEvents([{
      owner_id: campaign.owner_id, event_type: 'discovery.completed', entity_type: 'campaign', entity_id: campaign.id,
      campaign_id: campaign.id, business_id: null, actor: 'system',
      payload: { source: SOURCE, query, requested_limit: limit, status: partialError ? 'partial' : 'completed', summary, error: partialError ? { kind: partialError.kind, status: partialError.status } : null },
    }]).catch(() => { /* an audit-event failure must not hide saved businesses */ });
  }

  return {
    status: partialError ? 'partial' : 'completed',
    query, dry_run: dryRun, requested_limit: limit, summary, businesses,
    next_page_token: nextPageToken, exhausted, warnings,
    error: partialError ? { code: `google_${partialError.kind}`, message: partialError.message, retry_after_seconds: partialError.retryAfterSeconds } : null,
  };
}
