// Part 3B/3C PERSISTENCE tests.
//
// src/store-supabase.js, src/store-memory.js and test/helpers/fake-postgrest.js
// already implement Part 3B (upsert a business, deduped on Google's place_id via
// the businesses_source_unique(owner_id,source,source_id) constraint) and Part 3C
// (link every discovered business to campaign_businesses) - see
// src/discover/discover.js's persistPage(), which is the "small server-side
// repository/service for inserting a business" Part 3B asked for. Nothing
// previously exercised that code against the mocked Supabase API. This file
// fills that gap. It does not change discover.js, map-place.js, google-places.js,
// store-supabase.js or store-memory.js - all of it already worked.
//
// MOCKED throughout: a fake PostgREST server (test/helpers/fake-postgrest.js,
// backed by MemoryStore, which mirrors the schema's constraints) stands in for
// Supabase, and either a hand-written stub or the fake Google server
// (test/helpers/fake-google.js) stands in for Google. No real network call is
// made anywhere in this file. See README "What is / is not tested".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SupabaseStore } from '../src/store-supabase.js';
import { StoreError } from '../src/errors.js';
import { mapPlace } from '../src/discover/map-place.js';
import { GooglePlacesClient } from '../src/discover/google-places.js';
import { discover, SOURCE } from '../src/discover/discover.js';
import { startFakePostgrest } from './helpers/fake-postgrest.js';
import { startFakeGoogle, makePlace, TEST_GOOGLE_KEY } from './helpers/fake-google.js';

let fake, store, ownerId;
const NOW = new Date('2026-09-22T12:00:00.000Z');

/** A `places` stub for discover() that needs no HTTP server - only Supabase behaviour is under test. */
function stubPlaces(rawPlaces, { nextPageToken = null } = {}) {
  const calls = [];
  const fn = { searchText: async (args) => { calls.push(args); return { places: rawPlaces, nextPageToken }; } };
  fn.calls = calls;
  return fn;
}

/** Same store, same live connection, but with one method shadowed - for race-condition tests. */
function wrapStore(base) {
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base);
}

function seedCampaign(fields = {}) { return fake.store.addCampaign({ owner_id: ownerId, industry: 'pizza', ...fields }); }
const row = (place, over = {}) => mapPlace(place, { category: 'pizza', ownerId, query: 'pizza in Houston, TX', fetchedAt: NOW.toISOString(), ...over }).row;

before(async () => {
  fake = await startFakePostgrest();
  store = new SupabaseStore({ url: fake.url, serviceKey: fake.serviceKey });
  ownerId = randomUUID();
});
after(() => fake.close());

// ===========================================================================
// SupabaseStore's Part 3B/3C methods, called directly (mocked Supabase API)
// ===========================================================================
describe('SupabaseStore - business + campaign_businesses methods', () => {
  test('findBusinessesBySource: empty id list short-circuits without an HTTP call', async () => {
    const before = fake.requests.length;
    assert.deepEqual(await store.findBusinessesBySource(ownerId, SOURCE, []), []);
    assert.equal(fake.requests.length, before);
  });

  test('findBusinessesBySource: unknown ids simply return no matches', async () => {
    assert.deepEqual(await store.findBusinessesBySource(ownerId, SOURCE, ['ChIJdoesNotExist000000000']), []);
  });

  test('findBusinessesBySource: rejects a malformed owner_id or place id before any HTTP call (client-side guard)', async () => {
    const before = fake.requests.length;
    await assert.rejects(store.findBusinessesBySource('not-a-uuid', SOURCE, ['x']), (e) => e instanceof StoreError && e.code === '22P02');
    await assert.rejects(store.findBusinessesBySource(ownerId, SOURCE, ['has spaces in it']), (e) => e instanceof StoreError && e.code === '22P02');
    assert.equal(fake.requests.length, before, 'a client-side validation failure must not reach the database');
  });

  test('insertBusinessesIgnoreDuplicates: new businesses are inserted, "yes" and "no" website/phone are both handled', async () => {
    const withSite = row(makePlace(101));
    const p = makePlace(102); delete p.websiteUri; delete p.nationalPhoneNumber; delete p.internationalPhoneNumber;
    const withoutSite = row(p);

    const inserted = await store.insertBusinessesIgnoreDuplicates([withSite, withoutSite]);
    assert.equal(inserted.length, 2);
    const a = inserted.find((r) => r.source_id === withSite.source_id);
    const b = inserted.find((r) => r.source_id === withoutSite.source_id);
    assert.ok(a.id && b.id, 'both rows get a generated id');
    assert.equal(a.website_url, withSite.website_url);
    assert.equal(b.website_url, null, 'missing website is stored as null, not fabricated');
    assert.equal(b.public_business_phone, null, 'missing phone is stored as null, not fabricated');
    assert.equal(b.business_name, withoutSite.business_name);

    const write = fake.requests.at(-1);
    assert.match(write.query, /on_conflict=owner_id,source,source_id/);
    assert.match(write.headers.prefer, /resolution=ignore-duplicates/);
    assert.match(write.headers.prefer, /return=representation/);
  });

  test('insertBusinessesIgnoreDuplicates: re-inserting an existing place_id returns nothing for it (no duplicate row is created)', async () => {
    const r = row(makePlace(103));
    const first = await store.insertBusinessesIgnoreDuplicates([r]);
    assert.equal(first.length, 1);

    const second = await store.insertBusinessesIgnoreDuplicates([r]); // identical owner+source+place_id
    assert.deepEqual(second, [], 'the duplicate is silently skipped, not re-created');

    const found = await store.findBusinessesBySource(ownerId, SOURCE, [r.source_id]);
    assert.equal(found.length, 1, 'exactly one business row exists for this place_id');
    assert.equal(found[0].id, first[0].id, 'it is the original row, unchanged');
  });

  test('insertBusinessesIgnoreDuplicates: a batch with one invalid row is rejected in full (all-or-nothing), nothing is inserted', async () => {
    const good = row(makePlace(104));
    const bad = { ...row(makePlace(105)), business_name: '   ' }; // blank name -> not-null violation
    await assert.rejects(store.insertBusinessesIgnoreDuplicates([good, bad]), (e) => e instanceof StoreError && e.code === '23502');
    assert.deepEqual(await store.findBusinessesBySource(ownerId, SOURCE, [good.source_id]), [], 'the good row in the same batch was not silently kept');
  });

  test('insertBusinessesIgnoreDuplicates: an out-of-range coordinate is rejected (defence in depth - map-place.js already nulls these, but the store checks too)', async () => {
    const bad = { ...row(makePlace(106)), latitude: 200 };
    await assert.rejects(store.insertBusinessesIgnoreDuplicates([bad]), (e) => e instanceof StoreError && e.code === '23514');
  });

  test('updateBusiness: patches only the given fields, and a re-fetch reflects it', async () => {
    const r = row(makePlace(107));
    const [created] = await store.insertBusinessesIgnoreDuplicates([r]);
    await store.updateBusiness(created.id, { public_business_phone: '(713) 555-9999' });
    const [found] = await store.findBusinessesBySource(ownerId, SOURCE, [r.source_id]);
    assert.equal(found.public_business_phone, '(713) 555-9999');
    assert.equal(found.business_name, r.business_name, 'other fields are untouched by a partial patch');
  });

  test('linkBusinessesToCampaign: links are created once, are idempotent on retry, and are per-campaign', async () => {
    const campaignA = seedCampaign();
    const campaignB = seedCampaign();
    const r = row(makePlace(108));
    const [biz] = await store.insertBusinessesIgnoreDuplicates([r]);

    const first = await store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: campaignA.id, business_id: biz.id }]);
    assert.equal(first.length, 1, 'a new link is created and returned');
    assert.match(fake.requests.at(-1).query, /on_conflict=campaign_id,business_id/);

    const retry = await store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: campaignA.id, business_id: biz.id }]);
    assert.deepEqual(retry, [], 'linking the same business to the same campaign again creates nothing new');

    const second = await store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: campaignB.id, business_id: biz.id }]);
    assert.equal(second.length, 1, 'the SAME business can be linked to a DIFFERENT campaign');
    assert.equal(fake.store.campaignBusinesses.filter((l) => l.business_id === biz.id).length, 2, 'one business, two campaign links, no duplicates within either');
  });

  test('linkBusinessesToCampaign: a link to an unknown campaign or business is rejected, not silently dropped', async () => {
    const r = row(makePlace(109));
    const [biz] = await store.insertBusinessesIgnoreDuplicates([r]);
    await assert.rejects(store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: randomUUID(), business_id: biz.id }]), (e) => e instanceof StoreError && e.code === '23503');
    await assert.rejects(store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: seedCampaign().id, business_id: randomUUID() }]), (e) => e instanceof StoreError && e.code === '23503');
  });

  test('database/API errors are surfaced, not swallowed: a failing write on businesses, PATCH or campaign_businesses rejects cleanly', async () => {
    fake.faults.push({ method: 'POST', table: 'businesses', status: 500, times: 1 });
    await assert.rejects(store.insertBusinessesIgnoreDuplicates([row(makePlace(110))]), (e) => e instanceof StoreError && e.status === 500);

    const [biz] = await store.insertBusinessesIgnoreDuplicates([row(makePlace(110))]); // retry without the fault: works normally
    assert.ok(biz.id);

    fake.faults.push({ method: 'PATCH', table: 'businesses', status: 503, times: 1 });
    await assert.rejects(store.updateBusiness(biz.id, { public_business_phone: '(713) 555-0000' }), (e) => e instanceof StoreError && e.status === 503);

    fake.faults.push({ method: 'POST', table: 'campaign_businesses', status: 500, times: 1 });
    await assert.rejects(store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: seedCampaign().id, business_id: biz.id }]), (e) => e instanceof StoreError && e.status === 500);

    fake.faults.push({ method: 'GET', table: 'businesses', status: 500, times: 1 });
    await assert.rejects(store.findBusinessesBySource(ownerId, SOURCE, [biz.source_id]), (e) => e instanceof StoreError && e.status === 500);
  });
});

// ===========================================================================
// discover() - the actual repository/service consumer of those store methods
// ===========================================================================
describe('discover() persistence (Part 3B save + Part 3C link, end to end against the mocked store)', () => {
  test('a new business is saved and linked to the campaign', async () => {
    const campaign = seedCampaign();
    const places = stubPlaces([makePlace(1)]);
    const out = await discover({ store, places, campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });

    assert.equal(out.status, 'completed');
    assert.equal(out.summary.created, 1);
    assert.equal(out.summary.already_existing, 0);
    assert.equal(out.summary.linked_new, 1);
    assert.equal(out.businesses.length, 1);
    assert.equal(out.businesses[0].created, true);
    assert.equal(out.businesses[0].linked_to_campaign, true);
    assert.ok(out.businesses[0].business_id);

    const [stored] = await store.findBusinessesBySource(ownerId, SOURCE, [out.businesses[0].place_id]);
    assert.equal(stored.id, out.businesses[0].business_id);
    assert.equal(fake.store.campaignBusinesses.some((l) => l.campaign_id === campaign.id && l.business_id === stored.id), true);
  });

  test('running discover() again for the same place_id does not create a duplicate business or a duplicate link', async () => {
    const campaign = seedCampaign();
    const place = makePlace(2);
    const first = await discover({ store, places: stubPlaces([place]), campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });
    assert.equal(first.summary.created, 1);

    const second = await discover({ store, places: stubPlaces([place]), campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });
    assert.equal(second.summary.created, 0);
    assert.equal(second.summary.already_existing, 1);
    assert.equal(second.summary.linked_new, 0);
    assert.equal(second.summary.already_linked, 1);
    assert.equal(second.businesses[0].business_id, first.businesses[0].business_id, 'same business row both times');

    const found = await store.findBusinessesBySource(ownerId, SOURCE, [place.id]);
    assert.equal(found.length, 1, 'still only one business row for this place_id');
    assert.equal(fake.store.campaignBusinesses.filter((l) => l.campaign_id === campaign.id && l.business_id === found[0].id).length, 1, 'still only one campaign link');
  });

  test('a business found with no website and no phone is still saved (fields are null, not fabricated or skipped)', async () => {
    const campaign = seedCampaign();
    const p = makePlace(3); delete p.websiteUri; delete p.nationalPhoneNumber; delete p.internationalPhoneNumber;
    const out = await discover({ store, places: stubPlaces([p]), campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });

    assert.equal(out.summary.created, 1);
    assert.equal(out.summary.without_website, 1);
    assert.equal(out.businesses[0].website_url, null);
    assert.equal(out.businesses[0].phone, null);
    assert.equal(out.businesses[0].name, p.displayName.text);
    const [stored] = await store.findBusinessesBySource(ownerId, SOURCE, [p.id]);
    assert.equal(stored.website_url, null);
    assert.equal(stored.public_business_phone, null);
  });

  test('the same business discovered under a SECOND campaign reuses the one business row and adds one more link', async () => {
    const place = makePlace(4);
    const campaignA = seedCampaign();
    const campaignB = seedCampaign();
    const a = await discover({ store, places: stubPlaces([place]), campaign: campaignA, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });
    const b = await discover({ store, places: stubPlaces([place]), campaign: campaignB, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });

    assert.equal(b.summary.created, 0, 'the business already exists (from campaign A) - not re-created');
    assert.equal(b.summary.linked_new, 1, 'but it IS newly linked to campaign B');
    assert.equal(a.businesses[0].business_id, b.businesses[0].business_id);
    const links = fake.store.campaignBusinesses.filter((l) => l.business_id === a.businesses[0].business_id);
    assert.equal(links.length, 2);
    assert.deepEqual(new Set(links.map((l) => l.campaign_id)), new Set([campaignA.id, campaignB.id]));
  });

  test('a race with a concurrent discovery run (another insert lands between our lookup and ours) resolves to the existing row, not a duplicate', async () => {
    const campaign = seedCampaign();
    const r = row(makePlace(5));
    const racingStore = wrapStore(store);
    let calls = 0;
    const originalFind = store.findBusinessesBySource.bind(store);
    racingStore.findBusinessesBySource = async (...args) => {
      calls++;
      const result = await originalFind(...args);
      if (calls === 1) await store.insertBusinessesIgnoreDuplicates([r]); // "another process" wins the race
      return result;
    };

    const out = await discover({ store: racingStore, places: stubPlaces([makePlace(5)]), campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } });
    assert.equal(out.summary.created, 0, 'we did not create it - the racing insert did');
    assert.equal(out.summary.already_existing, 1, 'we correctly resolved it as existing, without erroring');
    assert.equal(out.summary.linked_new, 1, 'it is still linked to the campaign');
    assert.ok(calls >= 2, 'the raced re-lookup path was actually exercised');

    const found = await store.findBusinessesBySource(ownerId, SOURCE, [r.source_id]);
    assert.equal(found.length, 1, 'no duplicate business was created by the race');
  });

  test('a database failure while saving is not swallowed: discover() rejects rather than reporting false success', async () => {
    const campaign = seedCampaign();
    fake.faults.push({ method: 'POST', table: 'businesses', status: 500, times: 1 });
    await assert.rejects(
      discover({ store, places: stubPlaces([makePlace(6)]), campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } }),
      (e) => e instanceof StoreError && e.status === 500,
    );
    const found = await store.findBusinessesBySource(ownerId, SOURCE, [makePlace(6).id]);
    assert.equal(found.length, 0, 'nothing was left half-saved');
  });

  test('a database failure while linking to the campaign is not swallowed', async () => {
    const campaign = seedCampaign();
    fake.faults.push({ method: 'POST', table: 'campaign_businesses', status: 500, times: 1 });
    await assert.rejects(
      discover({ store, places: stubPlaces([makePlace(7)]), campaign, category: 'pizza', location: 'Houston, TX', limit: 1, now: NOW, config: { sleep: async () => {} } }),
      (e) => e instanceof StoreError && e.status === 500,
    );
    // the business itself WAS saved (that write succeeded); it is simply not linked to this campaign yet.
    const [found] = await store.findBusinessesBySource(ownerId, SOURCE, [makePlace(7).id]);
    assert.ok(found, 'the business row exists');
    assert.equal(fake.store.campaignBusinesses.some((l) => l.campaign_id === campaign.id && l.business_id === found.id), false);
  });
});

// ===========================================================================
// Full pipeline: real GooglePlacesClient against the fake Google server, real
// SupabaseStore against the fake Postgrest server - proves the actual wiring
// (never exercised together before this file).
// ===========================================================================
describe('discover() full pipeline (fake Google server + fake Supabase server)', () => {
  test('search -> map -> save -> link works end to end across two pages, with a duplicate id skipped within one response', async () => {
    const dataset = [makePlace(21), makePlace(21), makePlace(22), makePlace(23)]; // id 21 appears twice in one page (Google-side dup)
    const google = await startFakeGoogle({ dataset });
    try {
      const campaign = seedCampaign();
      const places = new GooglePlacesClient({ apiKey: TEST_GOOGLE_KEY, baseUrl: google.url, sleep: async () => {} });
      const out = await discover({ store, places, campaign, category: 'pizza', location: 'Houston, TX', limit: 3, now: NOW, config: { sleep: async () => {}, maxPages: 5 } });

      assert.equal(out.status, 'completed');
      assert.equal(out.summary.duplicates_in_response, 1);
      assert.equal(out.summary.created, 3);
      assert.equal(out.summary.linked_new, 3);
      assert.deepEqual(new Set(out.businesses.map((b) => b.place_id)), new Set(['ChIJtestPlace021_abcdefghij', 'ChIJtestPlace022_abcdefghij', 'ChIJtestPlace023_abcdefghij']));
      for (const b of out.businesses) {
        const [stored] = await store.findBusinessesBySource(ownerId, SOURCE, [b.place_id]);
        assert.ok(stored, `${b.place_id} was actually persisted`);
        assert.equal(stored.owner_id, ownerId);
        assert.ok(fake.store.campaignBusinesses.some((l) => l.campaign_id === campaign.id && l.business_id === stored.id));
      }
    } finally { await google.close(); }
  });

  test('a Google-side failure after the first page still keeps what was already saved (status "partial")', async () => {
    const dataset = Array.from({ length: 25 }, (_, i) => makePlace(30 + i));
    const google = await startFakeGoogle({ dataset });
    google.failOnCall(2, { status: 500 }); // page 1 (call 1) succeeds, page 2 (call 2) fails
    try {
      const campaign = seedCampaign();
      const places = new GooglePlacesClient({ apiKey: TEST_GOOGLE_KEY, baseUrl: google.url, sleep: async () => {}, maxRetries: 0 });
      const out = await discover({ store, places, campaign, category: 'pizza', location: 'Houston, TX', limit: 25, now: NOW, config: { sleep: async () => {} } });

      assert.equal(out.status, 'partial');
      assert.equal(out.error.code, 'google_unavailable');
      assert.equal(out.summary.pages_fetched, 1);
      assert.equal(out.summary.created, 20, 'the first page (20 results) was saved before Google failed');
      const [stored] = await store.findBusinessesBySource(ownerId, SOURCE, [dataset[0].id]);
      assert.ok(stored, 'partially discovered businesses are not rolled back');
    } finally { await google.close(); }
  });
});
