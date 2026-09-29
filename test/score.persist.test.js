// Part 4A persistence tests: scoreBusiness() against a MOCKED Supabase API
// (test/helpers/fake-postgrest.js -> MemoryStore, which now also mirrors
// score_reasons' constraints and the existing public.apply_score() function).
// No real network call is made anywhere in this file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SupabaseStore } from '../src/store-supabase.js';
import { StoreError } from '../src/errors.js';
import { scoreBusiness, ScoreError } from '../src/score/score-business.js';
import { startFakePostgrest } from './helpers/fake-postgrest.js';

let fake, store, ownerId;

before(async () => { fake = await startFakePostgrest(); store = new SupabaseStore({ url: fake.url, serviceKey: fake.serviceKey }); ownerId = randomUUID(); });
after(() => fake.close());

function seedCampaign(fields = {}) { return fake.store.addCampaign({ owner_id: ownerId, industry: 'pizza', ...fields }); }
function seedBusiness(fields = {}) { return fake.store.addBusiness({ owner_id: ownerId, business_name: 'Test Biz', ...fields }); }
async function link(campaign, business) { const [cb] = await store.linkBusinessesToCampaign([{ owner_id: ownerId, campaign_id: campaign.id, business_id: business.id }]); return cb; }

/** Inserts one 'is_current' check directly (bypasses the analyzer - only the shape matters here). */
async function addCheck(business, checkType, result, evidence = {}) {
  const [row] = await store.insertChecks([{
    owner_id: ownerId, business_id: business.id, check_type: checkType, result, evidence,
    method: 'manual', checked_at: new Date().toISOString(), is_current: true,
    ...(result === 'yes' || result === 'no' ? { evidence_url: 'https://example.test/', confidence: 0.9 } : {}),
  }]);
  return row;
}

function scoreReasonsFor(cbId, version) {
  return fake.store.scoreReasons.filter((r) => r.campaign_business_id === cbId && (version === undefined || r.score_version === version));
}

describe('scoreBusiness - required scenarios', () => {
  test('1. positive opportunity signals: score/tier/reasons reflect the real weighted "no" checks', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    const cb = await link(campaign, business);
    await addCheck(business, 'website_present', 'no', { basis: 'source_listing_has_no_website_field' }); // 40
    await addCheck(business, 'online_ordering', 'no'); // 25
    await addCheck(business, 'mobile_friendly', 'no'); // 20
    await addCheck(business, 'clear_cta', 'yes');

    const out = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });

    assert.equal(out.opportunity_score, 85);
    assert.equal(out.priority, 'hot'); // >= hot_min_score (70)
    assert.equal(out.score_version, 1);
    assert.equal(out.rules_applied, 3);
    assert.ok(out.scored_at);
    assert.deepEqual(new Set(out.reasons.map((r) => r.rule_key)), new Set(['no_website', 'no_online_ordering', 'poor_mobile']));

    const stored = await store.getCampaignBusiness(campaign.id, business.id);
    assert.equal(stored.opportunity_score, 85);
    assert.equal(stored.priority, 'hot');
    assert.equal(stored.score_version, 1);

    const reasons = scoreReasonsFor(cb.id, 1);
    assert.equal(reasons.length, 3);
    for (const r of reasons) assert.ok(r.check_id, `${r.rule_key} cites a real check_id as evidence`);
  });

  test('2. no opportunity signals: score is 0, tier is "low", but the business IS recorded as scored', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    const cb = await link(campaign, business);
    await addCheck(business, 'website_present', 'yes');
    await addCheck(business, 'online_ordering', 'yes');
    await addCheck(business, 'mobile_friendly', 'yes');

    const out = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });
    assert.equal(out.opportunity_score, 0);
    assert.equal(out.priority, 'low');
    assert.equal(out.score_version, 1, 'scoring ran and produced a real version, even with zero reasons');
    assert.equal(out.rules_applied, 0);
    assert.ok(out.scored_at);
    assert.deepEqual(out.reasons, []);
    assert.deepEqual(scoreReasonsFor(cb.id), []);

    const stored = await store.getCampaignBusiness(campaign.id, business.id);
    assert.equal(stored.score_version, 1, 'campaign_businesses reflects that a scoring pass happened');
  });

  test('3. unknown checks: an inconclusive check contributes nothing, other definite signals still count', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    await link(campaign, business);
    await addCheck(business, 'website_present', 'unknown');
    await addCheck(business, 'mobile_friendly', 'no'); // 20

    const out = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });
    assert.equal(out.opportunity_score, 20);
    assert.equal(out.rules_applied, 1);
    assert.deepEqual(out.reasons.map((r) => r.rule_key), ['poor_mobile']);
  });

  test('4. missing checks: a check that was never run at all is treated the same as "no evidence", not an error', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    await link(campaign, business);
    await addCheck(business, 'clear_cta', 'no'); // only ONE check exists at all for this business

    const out = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });
    assert.equal(out.opportunity_score, 10);
    assert.deepEqual(out.reasons.map((r) => r.rule_key), ['no_clear_cta']);
  });

  test('5. re-running scoring: idempotent, versions increment, history is preserved, and a real change updates the score', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    const cb = await link(campaign, business);
    await addCheck(business, 'mobile_friendly', 'no'); // 20

    const first = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });
    assert.equal(first.score_version, 1);
    assert.equal(first.opportunity_score, 20);

    const second = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id }); // nothing changed
    assert.equal(second.score_version, 2);
    assert.equal(second.opportunity_score, 20, 'same underlying checks -> same score');
    assert.equal(scoreReasonsFor(cb.id, 1).length, 1, 'version 1 reasons are still there');
    assert.equal(scoreReasonsFor(cb.id, 2).length, 1, 'version 2 has its own reasons');
    assert.notEqual(scoreReasonsFor(cb.id, 1)[0].id, scoreReasonsFor(cb.id, 2)[0].id);

    await addCheck(business, 'mobile_friendly', 'yes'); // the site got fixed
    const third = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });
    assert.equal(third.score_version, 3);
    assert.equal(third.opportunity_score, 0, 'the score reflects the CURRENT check, not the stale history');
    assert.equal(scoreReasonsFor(cb.id, 3).length, 0);
    assert.equal(scoreReasonsFor(cb.id, 1).length, 1, 'older versions are never rewritten');
    assert.equal(scoreReasonsFor(cb.id).length, 2, 'total reasons across all versions: v1(1) + v2(1) + v3(0)');
  });

  test('6. invalid campaign/business is rejected clearly, without touching any data', async () => {
    const before = fake.store.scoreReasons.length;
    await assert.rejects(scoreBusiness({ store, campaignId: randomUUID(), businessId: randomUUID() }), (e) => e instanceof ScoreError && e.code === 'campaign_not_found');

    const campaign = seedCampaign();
    const business = seedBusiness(); // never linked to this campaign
    await assert.rejects(scoreBusiness({ store, campaignId: campaign.id, businessId: business.id }), (e) => e instanceof ScoreError && e.code === 'not_linked');

    const unconfigured = seedCampaign({ score_weights: null });
    const business2 = seedBusiness();
    await link(unconfigured, business2);
    await assert.rejects(scoreBusiness({ store, campaignId: unconfigured.id, businessId: business2.id }), (e) => e instanceof ScoreError && e.code === 'invalid_campaign_config');

    await assert.rejects(scoreBusiness({ store, campaignId: null, businessId: business.id }), (e) => e instanceof ScoreError && e.code === 'invalid_input');
    assert.equal(fake.store.scoreReasons.length, before, 'none of these invalid attempts wrote anything');
  });

  test('7. a database error is surfaced safely, leaves no partial state, and a retry afterwards succeeds cleanly', async () => {
    const campaign = seedCampaign();
    const business = seedBusiness();
    const cb = await link(campaign, business);
    await addCheck(business, 'mobile_friendly', 'no');

    // (a) the score_reasons insert itself fails - nothing should be written at all.
    fake.faults.push({ method: 'POST', table: 'score_reasons', status: 500, times: 1 });
    await assert.rejects(scoreBusiness({ store, campaignId: campaign.id, businessId: business.id }), (e) => e instanceof StoreError && e.status === 500);
    assert.equal(scoreReasonsFor(cb.id).length, 0);
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 0, 'campaign_businesses is untouched by the failed attempt');

    // (b) score_reasons is written, but apply_score() itself fails - the orphaned reasons
    // must be rolled back so a retry can safely reuse the same next-version number.
    fake.faults.push({ method: 'POST', table: 'rpc/apply_score', status: 500, times: 1 });
    await assert.rejects(scoreBusiness({ store, campaignId: campaign.id, businessId: business.id }), (e) => e instanceof StoreError && e.status === 500);
    assert.equal(scoreReasonsFor(cb.id).length, 0, 'the orphaned version-1 reasons were rolled back');
    assert.equal((await store.getCampaignBusiness(campaign.id, business.id)).score_version, 0, 'still untouched');

    // (c) retry with no fault: succeeds, reuses version 1 (no collision from the rolled-back attempt).
    const out = await scoreBusiness({ store, campaignId: campaign.id, businessId: business.id });
    assert.equal(out.score_version, 1);
    assert.equal(out.opportunity_score, 20);
    assert.equal(scoreReasonsFor(cb.id, 1).length, 1);
  });
});
