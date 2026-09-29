// Part 5B tests: multi-campaign scoring, against the mocked Supabase API.
// No real network call is made anywhere in this file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SupabaseStore } from '../src/store-supabase.js';
import { StoreError } from '../src/errors.js';
import { scoreBusiness, ScoreError } from '../src/score/score-business.js';
import { scoreAllCampaignsForBusiness } from '../src/score/score-all-campaigns.js';
import { startFakePostgrest } from './helpers/fake-postgrest.js';

let fake, store, ownerId;

before(async () => { fake = await startFakePostgrest(); store = new SupabaseStore({ url: fake.url, serviceKey: fake.serviceKey }); ownerId = randomUUID(); });
after(() => fake.close());

function seedCampaign(fields = {}) { return fake.store.addCampaign({ owner_id: ownerId, industry: 'pizza', ...fields }); }
function seedBusiness(fields = {}) { return fake.store.addBusiness({ owner_id: ownerId, business_name: 'Test Biz', ...fields }); }
async function link(campaign, business) { const [cb] = await store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: campaign.id, business_id: business.id }]); return cb; }
async function addCheck(business, checkType, result, evidence = {}) {
  const [row] = await store.insertChecks([{
    owner_id: ownerId, business_id: business.id, check_type: checkType, result, evidence,
    method: 'manual', checked_at: new Date().toISOString(), is_current: true,
    ...(result === 'yes' || result === 'no' ? { evidence_url: 'https://example.test/', confidence: 0.9 } : {}),
  }]);
  return row;
}
function byCampaign(out, campaignId) { return out.results.find((r) => r.campaign_id === campaignId); }

/** Same store, same live connection, but with one method shadowed/tracked - for the sequential-processing check. */
function wrapStore(base) { return Object.assign(Object.create(Object.getPrototypeOf(base)), base); }

describe('getCampaignBusinessesForBusiness', () => {
  test('returns every campaign a business is linked to, and only that business', async () => {
    const business = seedBusiness();
    const other = seedBusiness();
    const campaignA = seedCampaign();
    const campaignB = seedCampaign();
    await link(campaignA, business);
    await link(campaignB, business);
    await link(campaignA, other); // different business - must not appear

    const rows = await store.getCampaignBusinessesForBusiness(business.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((r) => r.campaign_id)), new Set([campaignA.id, campaignB.id]));
    assert.ok(rows.every((r) => r.business_id === business.id));
  });

  test('returns an empty array for a business linked to nothing', async () => {
    const business = seedBusiness();
    assert.deepEqual(await store.getCampaignBusinessesForBusiness(business.id), []);
  });

  test('rejects a malformed business_id client-side, without an HTTP call', async () => {
    const before = fake.requests.length;
    await assert.rejects(store.getCampaignBusinessesForBusiness('not-a-uuid'), (e) => e instanceof StoreError && e.code === '22P02');
    assert.equal(fake.requests.length, before);
  });
});

describe('scoreAllCampaignsForBusiness', () => {
  test('zero campaigns: returns an empty result, not an error, and writes nothing', async () => {
    const business = seedBusiness();
    const before = fake.store.scoreReasons.length;
    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
    assert.deepEqual(out, { business_id: business.id, results: [] });
    assert.equal(fake.store.scoreReasons.length, before);
  });

  test('one campaign: behaves exactly like calling scoreBusiness() directly', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    await link(campaign, business);
    await addCheck(business, 'mobile_friendly', 'no'); // 20

    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
    assert.equal(out.business_id, business.id);
    assert.equal(out.results.length, 1);
    const r = out.results[0];
    assert.equal(r.ok, true);
    assert.equal(r.campaign_id, campaign.id);
    assert.equal(r.opportunity_score, 20);
    assert.equal(r.score_version, 1);
  });

  test('multiple campaigns: each is scored with its OWN score_weights against the SAME checks, independently', async () => {
    const campaignA = seedCampaign({ score_weights: { poor_mobile: 20 } });
    const campaignB = seedCampaign({ score_weights: { poor_mobile: 3 } }); // same signal, different weight
    const business = seedBusiness();
    await link(campaignA, business);
    await link(campaignB, business);
    await addCheck(business, 'mobile_friendly', 'no');

    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
    assert.equal(out.results.length, 2);
    assert.equal(byCampaign(out, campaignA.id).opportunity_score, 20);
    assert.equal(byCampaign(out, campaignB.id).opportunity_score, 3);
    // each campaign's OWN version, both starting fresh
    assert.equal(byCampaign(out, campaignA.id).score_version, 1);
    assert.equal(byCampaign(out, campaignB.id).score_version, 1);
  });

  test('one campaign failing (bad config) does not prevent the other from being scored', async () => {
    const good = seedCampaign();
    const bad = seedCampaign({ score_weights: null }); // invalid config
    const business = seedBusiness();
    await link(good, business);
    await link(bad, business);
    await addCheck(business, 'mobile_friendly', 'no');

    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
    assert.equal(out.results.length, 2);

    const goodResult = byCampaign(out, good.id);
    assert.equal(goodResult.ok, true);
    assert.equal(goodResult.opportunity_score, 20);

    const badResult = byCampaign(out, bad.id);
    assert.equal(badResult.ok, false);
    assert.equal(badResult.error.name, 'ScoreError');
    assert.equal(badResult.error.code, 'invalid_campaign_config');
  });

  test('one campaign failing (a genuine DB error) still lets a later campaign in the same run succeed', async () => {
    const first = seedCampaign();
    const second = seedCampaign();
    const business = seedBusiness();
    await link(first, business);
    await link(second, business);
    await addCheck(business, 'mobile_friendly', 'no');

    fake.faults.push({ method: 'POST', table: 'score_reasons', status: 500, times: 1 }); // only the FIRST write fails
    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });

    const r1 = byCampaign(out, first.id);
    const r2 = byCampaign(out, second.id);
    assert.equal(r1.ok, false);
    assert.equal(r1.error.name, 'StoreError');
    assert.equal(r2.ok, true, 'the second campaign in the same run is unaffected by the first one failing');
    assert.equal(r2.opportunity_score, 20);

    // the failed campaign left no orphaned state, and can be retried cleanly afterwards
    assert.equal((await store.getCampaignBusiness(first.id, business.id)).score_version, 0);
    const retry = await scoreBusiness({ store, campaignId: first.id, businessId: business.id });
    assert.equal(retry.score_version, 1);
  });

  test('correct campaign_id / business_id are reported for every result, including failures', async () => {
    const campaignA = seedCampaign();
    const campaignB = seedCampaign({ score_weights: null });
    const business = seedBusiness();
    const cbA = await link(campaignA, business);
    await link(campaignB, business);
    await addCheck(business, 'mobile_friendly', 'no');

    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
    assert.equal(out.business_id, business.id);
    for (const r of out.results) assert.equal(r.campaign_id, r.ok ? byCampaign(out, r.campaign_id).campaign_id : r.campaign_id); // sanity: every result carries a campaign_id
    assert.equal(byCampaign(out, campaignA.id).campaign_business_id, cbA.id);
    assert.equal(byCampaign(out, campaignA.id).campaign_id, campaignA.id);
    assert.equal(byCampaign(out, campaignB.id).campaign_id, campaignB.id);
    assert.deepEqual(new Set(out.results.map((r) => r.campaign_id)), new Set([campaignA.id, campaignB.id]));
  });

  test('existing score/version behavior is intact: a campaign scored earlier keeps its own history and continues incrementing, unaffected by a sibling campaign scored for the first time here', async () => {
    const campaignA = seedCampaign();
    const campaignB = seedCampaign();
    const business = seedBusiness();
    const cbA = await link(campaignA, business);
    await link(campaignB, business);
    await addCheck(business, 'mobile_friendly', 'no');

    const pre = await scoreBusiness({ store, campaignId: campaignA.id, businessId: business.id }); // campaign A scored once, directly, BEFORE the multi-campaign call
    assert.equal(pre.score_version, 1);

    const out = await scoreAllCampaignsForBusiness({ store, businessId: business.id });
    assert.equal(byCampaign(out, campaignA.id).score_version, 2, 'campaign A continues from where it left off');
    assert.equal(byCampaign(out, campaignB.id).score_version, 1, 'campaign B starts fresh, independently');

    const v1Reasons = fake.store.scoreReasons.filter((r) => r.campaign_business_id === cbA.id && r.score_version === 1);
    assert.equal(v1Reasons.length, 1, 'campaign A\'s original version-1 score_reasons are still there, untouched');
  });

  test('campaigns are processed sequentially, not in parallel', async () => {
    const business = seedBusiness();
    for (let i = 0; i < 3; i++) await link(seedCampaign(), business);
    await addCheck(business, 'mobile_friendly', 'no');

    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;
    const tracked = wrapStore(store);
    const originalGetCampaign = store.getCampaign.bind(store);
    tracked.getCampaign = async (id) => {
      inFlight++; callCount++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await originalGetCampaign(id); } finally { inFlight--; }
    };

    const out = await scoreAllCampaignsForBusiness({ store: tracked, businessId: business.id });
    assert.equal(out.results.length, 3);
    assert.equal(callCount, 3, 'one getCampaign call per campaign');
    assert.equal(maxInFlight, 1, 'never more than one campaign in flight at a time');
  });

  test('businessId is required', async () => {
    await assert.rejects(scoreAllCampaignsForBusiness({ store, businessId: null }), /businessId is required/);
  });

  test('a business linked to nothing among several existing, unrelated campaigns still returns empty - no false matches', async () => {
    seedCampaign(); seedCampaign(); // unrelated campaigns exist in the store
    const business = seedBusiness();
    assert.deepEqual(await scoreAllCampaignsForBusiness({ store, businessId: business.id }), { business_id: business.id, results: [] });
  });
});
