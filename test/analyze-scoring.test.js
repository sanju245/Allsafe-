// Part 5C tests: the Analyzer -> Scoring integration in src/api/handler.js.
// A stub `analyze` function is injected via createHandler()'s own extension
// point, so these tests exercise the REAL handler.js code path - real
// insertChecks(), real scoreAllCampaignsForBusiness() - without needing any
// real/fake website crawl. No real network call is made anywhere in this file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/api/handler.js';
import { SupabaseStore } from '../src/store-supabase.js';
import { makeCheck } from '../src/check.js';
import { ANALYZER_CHECK_TYPES } from '../src/constants.js';
import { startFakePostgrest } from './helpers/fake-postgrest.js';

const API_KEY = 'test-api-key';
let fake, store, ownerId;

before(async () => { fake = await startFakePostgrest(); store = new SupabaseStore({ url: fake.url, serviceKey: fake.serviceKey }); ownerId = randomUUID(); });
after(() => fake.close());

function seedCampaign(fields = {}) { return fake.store.addCampaign({ owner_id: ownerId, industry: 'pizza', ...fields }); }
function seedBusiness(fields = {}) { return fake.store.addBusiness({ owner_id: ownerId, business_name: 'Test Biz', website_url: 'https://example.test/', ...fields }); }
async function link(campaign, business) { const [cb] = await store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: campaign.id, business_id: business.id }]); return cb; }

/**
 * Stand-in for analyzeBusiness(): produces exactly one 'no' check (the given
 * type) and marks the rest 'not_applicable' - a controlled, deterministic
 * check set to score against, with no real or fake HTTP crawl involved.
 */
function fakeAnalyze(signalType = 'mobile_friendly') {
  return async ({ business_id, owner_id }) => {
    const now = new Date();
    const checks = ANALYZER_CHECK_TYPES.map((type) => (type === signalType
      ? makeCheck({ businessId: business_id, ownerId: owner_id, type, result: 'no', evidenceUrl: 'https://example.test/', confidence: 0.8, method: 'manual', checkedAt: now })
      : makeCheck({ businessId: business_id, ownerId: owner_id, type, result: 'not_applicable', method: 'manual', checkedAt: now })));
    return { checks, siteState: 'ok', conclusive: true, profile: { key: 'pizza', known: true }, crawl: null };
  };
}

function makeHandler(over = {}) {
  return createHandler({
    store, analyze: fakeAnalyze(over.signalType), now: over.now,
    config: { apiKey: API_KEY, allowPrivateNetworks: true, allowAnyPort: true, ...over.config },
  });
}
const call = (handle, body, token = API_KEY) => handle({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: JSON.stringify(body) });

describe('POST /api/analyze -> scoring integration', () => {
  test('1. business with no campaign links: 200, checks persisted, scoring.results is empty', async () => {
    const business = seedBusiness();
    const out = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'analyzed');
    assert.equal(out.body.checks.length, 14);
    assert.deepEqual(out.body.scoring, { attempted: true, campaigns_scored: 0, campaigns_failed: 0, results: [] });
  });

  test('2. one linked campaign: 200, scoring.results has the correct score/tier', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    await link(campaign, business);
    const out = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out.status, 200);
    assert.equal(out.body.scoring.attempted, true);
    assert.equal(out.body.scoring.campaigns_scored, 1);
    assert.equal(out.body.scoring.campaigns_failed, 0);
    assert.equal(out.body.scoring.results.length, 1);
    const r = out.body.scoring.results[0];
    assert.equal(r.ok, true);
    assert.equal(r.campaign_id, campaign.id);
    assert.equal(r.opportunity_score, 20); // default poor_mobile weight
    assert.equal(r.priority, 'low');
    assert.equal(r.score_version, 1);
  });

  test('3. multiple linked campaigns: all are scored and present in scoring.results, each with its own weights', async () => {
    const campaignA = seedCampaign();
    const campaignB = seedCampaign({ score_weights: { poor_mobile: 5 } });
    const business = seedBusiness();
    await link(campaignA, business);
    await link(campaignB, business);
    const out = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out.body.scoring.campaigns_scored, 2);
    const byId = Object.fromEntries(out.body.scoring.results.map((r) => [r.campaign_id, r]));
    assert.equal(byId[campaignA.id].opportunity_score, 20);
    assert.equal(byId[campaignB.id].opportunity_score, 5);
  });

  test('4. one campaign fails (bad config): still 200, mixed ok:true/false, the other campaign is unaffected', async () => {
    const good = seedCampaign();
    const bad = seedCampaign({ score_weights: null });
    const business = seedBusiness();
    await link(good, business);
    await link(bad, business);
    const out = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'analyzed');
    assert.equal(out.body.scoring.campaigns_scored, 1);
    assert.equal(out.body.scoring.campaigns_failed, 1);
    const byId = Object.fromEntries(out.body.scoring.results.map((r) => [r.campaign_id, r]));
    assert.equal(byId[good.id].ok, true);
    assert.equal(byId[bad.id].ok, false);
    assert.equal(byId[bad.id].error.code, 'invalid_campaign_config');
  });

  test('5. the whole scoring lookup fails: still 200 with checks intact, scoring.error populated, not a 502', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    await link(campaign, business);
    fake.faults.push({ method: 'GET', table: 'campaign_businesses', status: 500, times: 1 });
    const out = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out.status, 200, 'a scoring-subsystem failure must never turn a successful analysis into an error response');
    assert.equal(out.body.status, 'analyzed');
    assert.equal(out.body.checks.length, 14, 'checks were still persisted and returned');
    assert.equal(out.body.scoring.attempted, true);
    assert.equal(out.body.scoring.campaigns_scored, 0);
    assert.equal(out.body.scoring.campaigns_failed, 0);
    assert.deepEqual(out.body.scoring.results, []);
    assert.ok(out.body.scoring.error, 'a top-level error explains the lookup failure');
  });

  test('6. insertChecks() fails (409 concurrent / 502 db error): scoring is never attempted', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    await link(campaign, business);

    fake.faults.push({ method: 'POST', table: 'checks', status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "checks_one_current_idx"' }, times: 1 });
    const before1 = fake.store.scoreReasons.length;
    const out1 = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out1.status, 409);
    assert.equal(out1.body.error.code, 'concurrent_analysis');
    assert.ok(!('scoring' in out1.body));
    assert.equal(fake.store.scoreReasons.length, before1, 'scoring must not have run');
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 0);

    fake.faults.push({ method: 'POST', table: 'checks', status: 500, times: 1 });
    const before2 = fake.store.scoreReasons.length;
    const out2 = await call(makeHandler(), { business_id: business.id, website_url: business.website_url });
    assert.equal(out2.status, 502);
    assert.equal(out2.body.error.code, 'database_error');
    assert.ok(!('scoring' in out2.body));
    assert.equal(fake.store.scoreReasons.length, before2, 'scoring must not have run');
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 0);
  });

  test('7. skipped_fresh: scoring never runs', async () => {
    const campaign = seedCampaign({ required_checks: ['mobile_friendly'], stale_after_days: 30 });
    const business = seedBusiness();
    await link(campaign, business);
    const handler = makeHandler();
    const first = await call(handler, { business_id: business.id, website_url: business.website_url, campaign_id: campaign.id });
    assert.equal(first.body.status, 'analyzed');
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 1);

    const before = fake.store.scoreReasons.length;
    const second = await call(handler, { business_id: business.id, website_url: business.website_url, campaign_id: campaign.id });
    assert.equal(second.body.status, 'skipped_fresh');
    assert.ok(!('scoring' in second.body), 'skipped_fresh responses carry no scoring field at all');
    assert.equal(fake.store.scoreReasons.length, before, 'no new scoring activity happened');
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 1, 'version unchanged');
  });

  test('8. force:true re-analysis: scoring re-runs and the version increments again', async () => {
    const campaign = seedCampaign({ required_checks: ['mobile_friendly'], stale_after_days: 30 });
    const business = seedBusiness();
    await link(campaign, business);
    const handler = makeHandler();
    await call(handler, { business_id: business.id, website_url: business.website_url, campaign_id: campaign.id });
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 1);

    const out = await call(handler, { business_id: business.id, website_url: business.website_url, campaign_id: campaign.id, force: true });
    assert.equal(out.body.status, 'analyzed');
    assert.equal(out.body.scoring.results[0].score_version, 2, 'force re-triggers analysis AND scoring');
  });

  test('9. campaign_id omitted from the request: every linked campaign is still scored', async () => {
    const campaignA = seedCampaign();
    const campaignB = seedCampaign();
    const business = seedBusiness();
    await link(campaignA, business);
    await link(campaignB, business);
    const out = await call(makeHandler(), { business_id: business.id, website_url: business.website_url }); // no campaign_id at all
    assert.equal(out.body.scoring.campaigns_scored, 2);
    assert.deepEqual(new Set(out.body.scoring.results.map((r) => r.campaign_id)), new Set([campaignA.id, campaignB.id]));
  });
});
