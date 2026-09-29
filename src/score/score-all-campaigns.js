// Part 5B: score every campaign a business belongs to, independently.
//
// This module does NOT change scoring behavior at all - scoreBusiness() (from
// score-business.js) is called exactly as it already exists, once per campaign.
// Each call gets its own read-modify-write cycle, its own score_version, its
// own rollback-on-failure (see score-business.js) - nothing here duplicates or
// alters any of that. This file only finds which campaigns to loop over, and
// makes sure one campaign's failure never stops the others from being scored.
import { scoreBusiness } from './score-business.js';

/**
 * @param {object} params
 * @param {object} params.store - anything scoreBusiness() needs, plus
 *   getCampaignBusinessesForBusiness(businessId).
 * @param {string} params.businessId
 * @returns {Promise<{business_id: string, results: Array<
 *   ({campaign_id: string, ok: true} & Awaited<ReturnType<typeof scoreBusiness>>) |
 *   {campaign_id: string, ok: false, error: {name: string, code?: string, message: string}}
 * >}>}
 */
export async function scoreAllCampaignsForBusiness({ store, businessId }) {
  if (!businessId) throw new Error('scoreAllCampaignsForBusiness: businessId is required');

  const links = await store.getCampaignBusinessesForBusiness(businessId);
  if (!links || links.length === 0) return { business_id: businessId, results: [] };

  const results = [];
  // Sequential on purpose: keeps failures easy to reason about and avoids
  // amplifying load on a business that belongs to many campaigns at once.
  for (const link of links) {
    try {
      const result = await scoreBusiness({ store, campaignId: link.campaign_id, businessId });
      results.push({ campaign_id: link.campaign_id, ok: true, ...result });
    } catch (err) {
      // One campaign's failure (bad config, a transient DB error, ...) must never
      // stop the rest of the loop - each campaign is fully independent.
      results.push({ campaign_id: link.campaign_id, ok: false, error: { name: err.name, code: err.code, message: err.message } });
    }
  }
  return { business_id: businessId, results };
}
