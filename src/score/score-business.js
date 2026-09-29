// Part 4A: Opportunity Scoring Foundation.
//
// This module decides WHICH rules fired (rules.js) and writes the resulting
// score_reasons; the actual scoring MATH - sum, clamp to [0,100], assign a tier
// from the campaign's own hot_min_score/warm_min_score, and updating
// campaign_businesses - happens ONLY inside the schema's existing
// public.apply_score(uuid,int) function, called here over RPC. Nothing in this
// file re-derives a score or a tier on its own; the response is read back from
// what apply_score() actually wrote, so there is exactly one place the scoring
// math lives.
//
// Idempotent by construction: every call uses score_version = (current + 1),
// so re-scoring the same business never collides with a previous run, and
// every past version's score_reasons stays in place as a full audit trail.
import { evaluateRules } from './rules.js';

export class ScoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScoreError';
    this.code = code; // invalid_input | campaign_not_found | invalid_campaign_config | not_linked
  }
}

/**
 * @param {object} params
 * @param {object} params.store - getCampaign, getCampaignBusiness, getCurrentChecks,
 *   insertScoreReasons, applyScore, deleteScoreReasons (SupabaseStore or a compatible test double).
 * @param {string} params.campaignId
 * @param {string} params.businessId
 * @returns {Promise<{campaign_business_id, score_version, opportunity_score, priority,
 *   scored_at, rules_applied, rules_configured, reasons}>}
 */
export async function scoreBusiness({ store, campaignId, businessId }) {
  if (!campaignId) throw new ScoreError('invalid_input', 'campaignId is required');
  if (!businessId) throw new ScoreError('invalid_input', 'businessId is required');

  const campaign = await store.getCampaign(campaignId);
  if (!campaign) throw new ScoreError('campaign_not_found', `No campaign with id ${campaignId}`);
  if (!campaign.score_weights || typeof campaign.score_weights !== 'object' || Array.isArray(campaign.score_weights)) {
    throw new ScoreError('invalid_campaign_config', `Campaign ${campaignId} has no score_weights configured`);
  }

  // Scoring lives on the campaign_businesses row - a business must already be
  // linked to this campaign (Part 3C) before it can be scored for it.
  const cb = await store.getCampaignBusiness(campaignId, businessId);
  if (!cb) throw new ScoreError('not_linked', `Business ${businessId} is not linked to campaign ${campaignId} (run discovery first)`);

  const checks = await store.getCurrentChecks(businessId); // "current verified checks" = is_current rows
  const reasons = evaluateRules(checks, campaign.score_weights);
  const nextVersion = (cb.score_version ?? 0) + 1;

  const rows = reasons.map((r) => ({
    owner_id: campaign.owner_id,
    campaign_id: campaignId,
    business_id: businessId,
    campaign_business_id: cb.id,
    score_version: nextVersion,
    rule_key: r.rule_key,
    description: r.description,
    points: r.points,
    check_id: r.check_id,
    supporting_check_ids: r.supporting_check_ids,
  }));

  // No signals firing is a valid, real result (score 0) - still worth recording
  // via apply_score() below so score_version/scored_at reflect that this business
  // WAS scored, just skip the empty insert.
  if (rows.length) await store.insertScoreReasons(rows);

  try {
    await store.applyScore(cb.id, nextVersion);
  } catch (err) {
    // Compensate: don't leave orphaned score_reasons for a version campaign_businesses
    // never actually reached - otherwise a retry reusing the same next-version number
    // would collide with them instead of cleanly redoing this run.
    if (rows.length) await store.deleteScoreReasons(cb.id, nextVersion).catch(() => {});
    throw err;
  }

  // Read back what apply_score() actually wrote - the single source of truth for
  // the score and tier; nothing here recomputes either.
  const updated = await store.getCampaignBusiness(campaignId, businessId);
  return {
    campaign_business_id: cb.id,
    score_version: nextVersion,
    opportunity_score: updated?.opportunity_score ?? null,
    priority: updated?.priority ?? null,
    scored_at: updated?.scored_at ?? null,
    rules_applied: reasons.length,
    rules_configured: Object.keys(campaign.score_weights).length,
    reasons: reasons.map(({ rule_key, description, points }) => ({ rule_key, description, points })),
  };
}
