// Part 3 UNIT tests. Every Google response here is a MOCK (injected fetch / canned objects);
// nothing in this file talks to Google or to a database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapPlace } from '../src/discover/map-place.js';
import { GooglePlacesClient, GooglePlacesError, FIELD_MASK, MAX_PAGE_SIZE } from '../src/discover/google-places.js';
import { diffPatch } from '../src/discover/discover.js';
import { parseDiscoverInput } from '../src/api/discover-handler.js';
import { makePlace, TEST_GOOGLE_KEY } from './helpers/fake-google.js';

const OPTS = { category: 'pizza', ownerId: '00000000-0000-4000-8000-000000000001', query: 'pizza in Houston, TX', fetchedAt: '2026-09-21T00:00:00.000Z' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('mapPlace (mocked Places objects -> businesses row)', () => {
  test('a complete place maps every requested field', () => {
    const { row } = mapPlace(makePlace(7), OPTS);
    assert.equal(row.business_name, 'Pizza Place 007');
    assert.equal(row.source, 'google_places');
    assert.equal(row.source_id, 'ChIJtestPlace007_abcdefghij');
    assert.equal(row.address_line, '107 Main St');
    assert.equal(row.city, 'Houston');
    assert.equal(row.state, 'TX');
    assert.equal(row.postal_code, '77002');
    assert.equal(row.country, 'US');
    assert.ok(Math.abs(row.latitude - 29.767) < 1e-9);
    assert.ok(Math.abs(row.longitude + 95.367) < 1e-9);
    assert.equal(row.website_url, 'https://pizza007.example.com/');
    assert.equal(row.website_domain, 'pizza007.example.com');
    assert.equal(row.public_business_phone, '(713) 555-1007');
    assert.equal(row.industry, 'pizza');
    assert.equal(row.sub_industry, 'Pizza restaurant');
    assert.equal(row.source_url, 'https://maps.google.com/?cid=1007');
    assert.equal(row.source_rating, 4.4);
    assert.equal(row.source_review_count, 107);
    assert.equal(row.owner_id, OPTS.ownerId);
    assert.match(row.dedupe_key, /^pizza place 007\|7135551007$/);
  });

  test('a business WITHOUT a website (and without a phone) is still mapped', () => {
    const p = makePlace(3);
    delete p.websiteUri; delete p.nationalPhoneNumber; delete p.internationalPhoneNumber;
    const { row, skip } = mapPlace(p, OPTS);
    assert.equal(skip, undefined);
    assert.equal(row.website_url, null);
    assert.equal(row.website_domain, null);
    assert.equal(row.public_business_phone, null);
    assert.equal(row.business_name, 'Pizza Place 003');
    assert.match(row.dedupe_key, /^pizza place 003\|$/);
  });

  test('the international number is used when there is no national one', () => {
    const p = makePlace(4); delete p.nationalPhoneNumber;
    assert.equal(mapPlace(p, OPTS).row.public_business_phone, '+1 713-555-1004');
  });

  test('a Facebook page in websiteUri is kept as-is (the Analyze stage decides what it means)', () => {
    const { row } = mapPlace(makePlace(5, { websiteUri: 'https://www.facebook.com/mikespizza' }), OPTS);
    assert.equal(row.website_url, 'https://www.facebook.com/mikespizza');
    assert.equal(row.website_domain, 'facebook.com');
  });

  test('non-http(s) website values are dropped', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'not a url', '', 42]) assert.equal(mapPlace(makePlace(6, { websiteUri: bad }), OPTS).row.website_url, null, String(bad));
  });

  test('permanently or temporarily closed businesses are skipped, not saved', () => {
    assert.equal(mapPlace(makePlace(1, { businessStatus: 'CLOSED_PERMANENTLY' }), OPTS).skip, 'closed');
    assert.equal(mapPlace(makePlace(1, { businessStatus: 'CLOSED_TEMPORARILY' }), OPTS).skip, 'closed');
    assert.ok(mapPlace(makePlace(1, { businessStatus: 'OPERATIONAL' }), OPTS).row);
    assert.ok(mapPlace(makePlace(1, { businessStatus: undefined }), OPTS).row, 'unknown status is not treated as closed');
  });

  test('places without a usable id or name are invalid', () => {
    for (const p of [null, 'x', {}, makePlace(1, { id: undefined }), makePlace(1, { id: 'a b' }), makePlace(1, { id: 'x'.repeat(400) }), makePlace(1, { displayName: undefined }), makePlace(1, { displayName: { text: '   ' } })]) {
      assert.equal(mapPlace(p, OPTS).skip, 'invalid', JSON.stringify(p)?.slice(0, 60));
    }
  });

  test('out-of-range coordinates and ratings become null instead of failing the insert', () => {
    const { row } = mapPlace(makePlace(2, { location: { latitude: 123, longitude: -500 }, rating: 12, userRatingCount: -4 }), OPTS);
    assert.equal(row.latitude, null);
    assert.equal(row.longitude, null);
    assert.equal(row.source_rating, null);
    assert.equal(row.source_review_count, null);
    assert.equal(mapPlace(makePlace(2, { location: undefined }), OPTS).row.latitude, null);
  });

  test('address falls back to formattedAddress when components are missing', () => {
    const { row } = mapPlace(makePlace(8, { addressComponents: undefined, formattedAddress: '555 Oak Ave, Dallas, TX 75201, USA' }), OPTS);
    assert.equal(row.address_line, '555 Oak Ave');
    assert.equal(row.city, 'Dallas');
    assert.equal(row.state, 'TX');
    assert.equal(row.postal_code, '75201');
  });

  test('a service-area business with no address at all is still saved', () => {
    const p = makePlace(9); delete p.formattedAddress; delete p.addressComponents; delete p.location;
    const { row } = mapPlace(p, OPTS);
    assert.equal(row.address_line, null);
    assert.equal(row.latitude, null);
    assert.equal(row.country, 'US');
  });

  test('no personal data: reviews / photos / authors are never mapped, raw_source is provenance only', () => {
    const p = makePlace(10, { reviews: [{ authorAttribution: { displayName: 'Jane Doe' }, text: { text: 'great' } }], photos: [{ authorAttributions: [{ displayName: 'John' }] }] });
    const { row } = mapPlace(p, OPTS);
    const blob = JSON.stringify(row);
    assert.doesNotMatch(blob, /Jane|John|authorAttribution|reviews|photos|great/);
    assert.deepEqual(Object.keys(row.raw_source).sort(), ['business_status', 'fetched_at', 'primary_type', 'provider', 'query', 'types']);
    assert.ok(!('public_business_email' in row));
  });

  test('control characters and huge strings are cleaned', () => {
    const { row } = mapPlace(makePlace(11, { displayName: { text: 'Joe\u0000\u0007 \n Pizza' } }), OPTS);
    assert.equal(row.business_name, 'Joe Pizza');
  });
});

describe('GooglePlacesClient (mocked fetch)', () => {
  const mk = (fetchImpl, over = {}) => new GooglePlacesClient({ apiKey: TEST_GOOGLE_KEY, fetchImpl, sleep: async () => {}, random: () => 0, ...over });

  test('sends a POST to places:searchText with header auth and a field mask; the key is never in the URL', async () => {
    const calls = [];
    const c = mk(async (url, init) => { calls.push({ url, init }); return json({ places: [makePlace(1)], nextPageToken: 'tok-1234567890' }); });
    const out = await c.searchText({ query: 'pizza in Houston, TX', pageSize: 50, pageToken: 'prev-token-123456', regionCode: 'US' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['x-goog-api-key'], TEST_GOOGLE_KEY);
    assert.equal(calls[0].init.headers['x-goog-fieldmask'], FIELD_MASK);
    assert.doesNotMatch(calls[0].url, /key=|AIza|DO-NOT-LEAK/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.textQuery, 'pizza in Houston, TX');
    assert.equal(body.pageSize, MAX_PAGE_SIZE, 'pageSize is clamped to 20');
    assert.equal(body.pageToken, 'prev-token-123456');
    assert.equal(body.regionCode, 'US');
    assert.equal(body.includePureServiceAreaBusinesses, true);
    assert.equal(out.places.length, 1);
    assert.equal(out.nextPageToken, 'tok-1234567890');
  });

  test('the field mask requests only listing data: no reviews, photos, summaries or hours', () => {
    const paths = FIELD_MASK.split(',');
    assert.ok(paths.includes('nextPageToken'));
    for (const forbidden of ['places.reviews', 'places.photos', 'places.reviewSummary', 'places.generativeSummary', 'places.regularOpeningHours', 'places.editorialSummary']) assert.ok(!paths.includes(forbidden), forbidden);
    assert.ok(!FIELD_MASK.includes('*'));
    assert.ok(!FIELD_MASK.includes(' '), 'Google forbids spaces in the field list');
  });

  test('pageSize below 1 is raised to 1', async () => {
    let body;
    await mk(async (u, init) => { body = JSON.parse(init.body); return json({}); }).searchText({ query: 'q', pageSize: 0 });
    assert.equal(body.pageSize, 1);
  });

  test('an empty result set ({}) is not an error', async () => {
    const out = await mk(async () => json({})).searchText({ query: 'q' });
    assert.deepEqual(out, { places: [], nextPageToken: null });
  });

  test('429 with a short Retry-After is retried and then succeeds', async () => {
    const sleeps = [];
    let n = 0;
    const c = mk(async () => (++n === 1 ? json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429, { 'retry-after': '2' }) : json({ places: [makePlace(1)] })), { sleep: async (ms) => { sleeps.push(ms); } });
    const out = await c.searchText({ query: 'q' });
    assert.equal(out.places.length, 1);
    assert.equal(c.requestCount, 2);
    assert.ok(sleeps[0] >= 2000, 'honours Retry-After');
  });

  test('a persistent 429 gives up after maxRetries with a quota error', async () => {
    const c = mk(async () => json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429));
    await assert.rejects(c.searchText({ query: 'q' }), (e) => e instanceof GooglePlacesError && e.kind === 'quota' && e.retryAfterSeconds === 30);
    assert.equal(c.requestCount, 3);
  });

  test('a huge Retry-After is not waited for', async () => {
    const c = mk(async () => json({}, 429, { 'retry-after': '3600' }));
    await assert.rejects(c.searchText({ query: 'q' }), (e) => e.kind === 'quota' && e.retryAfterSeconds === 3600);
    assert.equal(c.requestCount, 1);
  });

  test('5xx is retried; a persistent 503 becomes "unavailable"', async () => {
    let n = 0;
    const ok = mk(async () => (++n < 3 ? json({}, 500) : json({ places: [] })));
    assert.deepEqual((await ok.searchText({ query: 'q' })).places, []);
    const down = mk(async () => json({ error: { message: 'x' } }, 503));
    await assert.rejects(down.searchText({ query: 'q' }), (e) => e.kind === 'unavailable' && e.status === 503);
    assert.equal(down.requestCount, 3);
  });

  test('a non-JSON error body (e.g. an HTML page from a proxy) still produces a clean, non-crashing error', async () => {
    const c = mk(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await assert.rejects(c.searchText({ query: 'q' }), (e) => e instanceof GooglePlacesError && e.kind === 'unavailable' && e.status === 502 && !e.message.includes('<html>'));
  });

  test('network failures and timeouts are retried, then reported as unavailable', async () => {
    const c = mk(async () => { throw Object.assign(new Error('connect ECONNRESET https://x?key=' + TEST_GOOGLE_KEY), { name: 'TypeError' }); });
    await assert.rejects(c.searchText({ query: 'q' }), (e) => e.kind === 'unavailable' && !e.message.includes(TEST_GOOGLE_KEY));
    assert.equal(c.requestCount, 3);
    const t = mk(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
    await assert.rejects(t.searchText({ query: 'q' }), /timed out/);
  });

  test('401/403 is an auth error, never retried, and never echoes the API key', async () => {
    const c = mk(async () => json({ error: { status: 'PERMISSION_DENIED', message: `API key ${TEST_GOOGLE_KEY} is not authorized` } }, 403));
    await assert.rejects(c.searchText({ query: 'q' }), (e) => e.kind === 'auth' && e.googleStatus === 'PERMISSION_DENIED' && !JSON.stringify(e).includes(TEST_GOOGLE_KEY) && !e.message.includes(TEST_GOOGLE_KEY));
    assert.equal(c.requestCount, 1);
  });

  test('400 is a bad_request, never retried, key scrubbed from Google\'s message', async () => {
    const c = mk(async () => json({ error: { status: 'INVALID_ARGUMENT', message: `bad token for ${TEST_GOOGLE_KEY}` } }, 400));
    await assert.rejects(c.searchText({ query: 'q', pageToken: 'x'.repeat(20) }), (e) => e.kind === 'bad_request' && !e.message.includes(TEST_GOOGLE_KEY) && e.message.includes('[redacted]'));
    assert.equal(c.requestCount, 1);
  });

  test('malformed 200 responses are rejected as invalid_response', async () => {
    const bad = [
      () => new Response('<html>oops</html>', { status: 200 }),
      () => new Response('', { status: 200 }),
      () => json([1, 2, 3]),
      () => json({ places: 'nope' }),
      () => json({ places: {} }),
      () => json({ places: [], nextPageToken: 12345 }),
      () => json(null),
    ];
    for (const b of bad) await assert.rejects(mk(async () => b()).searchText({ query: 'q' }), (e) => e.kind === 'invalid_response');
  });

  test('a missing API key is refused at construction', () => {
    assert.throws(() => new GooglePlacesClient({}), /GOOGLE_PLACES_API_KEY/);
    assert.throws(() => new GooglePlacesClient({ apiKey: 42 }), /GOOGLE_PLACES_API_KEY/);
  });
});

describe('diffPatch (refresh rules)', () => {
  const stored = { business_name: 'Old Name', sub_industry: 'Pizza restaurant', address_line: '1 Main St', city: 'Houston', state: 'TX', postal_code: '77002', country: 'US', latitude: 29.7, longitude: -95.3, website_url: 'https://old.example.com/', website_domain: 'old.example.com', public_business_phone: '(713) 555-0001', source_url: 'https://maps.google.com/?cid=1', source_rating: 4.4, source_review_count: 10, dedupe_key: 'old name|7135550001', industry: 'pizza' };
  test('unchanged data produces an empty patch', () => { assert.deepEqual(diffPatch(stored, { ...stored }), {}); });
  test('changed non-null values are patched', () => {
    assert.deepEqual(diffPatch(stored, { ...stored, business_name: 'New Name', public_business_phone: '(713) 555-0002', source_review_count: 11 }), { business_name: 'New Name', public_business_phone: '(713) 555-0002', source_review_count: 11 });
  });
  test('a refresh never erases a stored value with null', () => {
    assert.deepEqual(diffPatch(stored, { ...stored, website_url: null, website_domain: null, public_business_phone: null, latitude: null }), {});
  });
  test('numeric strings from the database compare equal to numbers', () => {
    assert.deepEqual(diffPatch({ ...stored, source_rating: '4.4', latitude: '29.7' }, { ...stored }), {});
  });
  test('missing values are filled in; industry is only set when empty', () => {
    assert.deepEqual(diffPatch({ ...stored, website_url: null, industry: null }, { ...stored, industry: 'cafe' }), { website_url: 'https://old.example.com/', industry: 'cafe' });
    assert.deepEqual(diffPatch(stored, { ...stored, industry: 'cafe' }), {}, 'an existing industry is not overwritten');
  });
  test('columns owned by other stages are never part of a patch', () => {
    const patch = diffPatch(stored, { ...stored, website_status: 'active', online_ordering: 'yes', social_media: { x: 1 }, last_analyzed_at: 'now' });
    assert.deepEqual(patch, {});
  });
});

describe('POST /api/discover input validation', () => {
  const ok = { campaign_id: '11111111-1111-4111-8111-111111111111', category: 'pizza', location: 'Houston, TX', limit: 20 };
  test('a valid body parses; limit defaults to 20; text is trimmed and collapsed', () => {
    assert.deepEqual(parseDiscoverInput(ok).value, { campaign_id: ok.campaign_id, category: 'pizza', location: 'Houston, TX', limit: 20, pageToken: null, dryRun: false });
    assert.equal(parseDiscoverInput({ ...ok, limit: undefined }).value.limit, 20);
    assert.equal(parseDiscoverInput({ ...ok, category: '  hair   salon ', location: ' New  York, NY ' }).value.category, 'hair salon');
    assert.equal(parseDiscoverInput({ ...ok, category: 'pizza\n\tshop' }).value.category, 'pizza shop', 'newlines/tabs are collapsed into spaces');
  });
  test('rejects bad campaign ids, categories, locations, limits, tokens and flags', () => {
    const cases = [
      [{ ...ok, campaign_id: 'x' }, 'invalid_campaign_id'], [{ ...ok, campaign_id: undefined }, 'invalid_campaign_id'],
      [{ ...ok, category: '' }, 'invalid_category'], [{ ...ok, category: 'p' }, 'invalid_category'], [{ ...ok, category: 'x'.repeat(81) }, 'invalid_category'],
      [{ ...ok, category: 'pizza<script>' }, 'invalid_category'], [{ ...ok, category: 5 }, 'invalid_category'],
      [{ ...ok, location: '' }, 'invalid_location'], [{ ...ok, location: 'a;b|c' }, 'invalid_location'], [{ ...ok, location: 'x'.repeat(121) }, 'invalid_location'],
      [{ ...ok, limit: 0 }, 'invalid_limit'], [{ ...ok, limit: 61 }, 'invalid_limit'], [{ ...ok, limit: 2.5 }, 'invalid_limit'], [{ ...ok, limit: '20' }, 'invalid_limit'],
      [{ ...ok, page_token: 'short' }, 'invalid_page_token'], [{ ...ok, page_token: 'has spaces in it ok' }, 'invalid_page_token'], [{ ...ok, page_token: 12345678901 }, 'invalid_page_token'],
      [{ ...ok, dry_run: 'yes' }, 'invalid_dry_run'], [null, 'invalid_body'], [[], 'invalid_body'],
    ];
    for (const [body, code] of cases) assert.equal(parseDiscoverInput(body).error?.code, code, `${code}: ${JSON.stringify(body)?.slice(0, 80)}`);
  });
  test('accepts unicode place names and a real-looking page token', () => {
    assert.ok(parseDiscoverInput({ ...ok, category: 'café', location: 'São Paulo, Brazil' }).value);
    assert.ok(parseDiscoverInput({ ...ok, page_token: 'AeCrKXsZWzNVbPzO-MRWPu52jWO_Xx8aKwOQ69_Je3DxRpfdjClq8Ekwh3UcF2h2Jn75kL6PtWLGV4ecQri-GEUKN_OFpJkdVc-JL4Q' }).value.pageToken);
  });
  test('maxLimit is configurable but never above Google\'s 60', () => {
    assert.equal(parseDiscoverInput({ ...ok, limit: 30 }, { maxLimit: 25 }).error.code, 'invalid_limit');
    assert.equal(parseDiscoverInput({ ...ok, limit: 60 }, { maxLimit: 60 }).value.limit, 60);
  });
});
