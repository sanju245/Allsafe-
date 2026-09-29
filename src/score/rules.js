// Part 4A: rule -> evidence mapping for opportunity scoring.
//
// Each key below corresponds to a key in campaigns.score_weights - the schema's
// OWN default set (see reference_schema.sql). The point VALUE for a rule always
// comes from the campaign's score_weights (data, configurable per campaign);
// this file only decides WHETHER a rule fires and WHICH check proves it (code).
//
// A rule fires ONLY on a CURRENT, definite 'no' result. 'unknown', 'not_applicable',
// and a missing check (never run) never fire a rule - there is no evidence to
// invent, so the honest contribution is zero, silently. An score_weights key with
// no matching rule here (a custom key we don't know how to evaluate) is skipped,
// never guessed at.

function simpleNoRule(checkType) {
  return (byType) => {
    const c = byType[checkType];
    if (!c || c.result !== 'no') return null;
    return { checkId: c.id, supportingCheckIds: [] };
  };
}

export const RULES = {
  no_website: {
    description: 'No dedicated website found',
    evaluate: (byType) => {
      const c = byType.website_present;
      if (!c || c.result !== 'no' || c.evidence?.basis === 'listed_url_is_social_or_listing_page') return null;
      return { checkId: c.id, supportingCheckIds: [] };
    },
  },
  social_only_presence: {
    description: 'Only a social media or listing page found, no dedicated website',
    evaluate: (byType) => {
      const c = byType.website_present;
      if (!c || c.result !== 'no' || c.evidence?.basis !== 'listed_url_is_social_or_listing_page') return null;
      return { checkId: c.id, supportingCheckIds: [] };
    },
  },
  no_online_ordering: { description: 'No online ordering available', evaluate: simpleNoRule('online_ordering') },
  no_online_booking: { description: 'No online booking available', evaluate: simpleNoRule('online_booking') },
  no_online_menu: { description: 'No online menu found', evaluate: simpleNoRule('online_menu') },
  poor_mobile: { description: 'Website is not mobile-friendly', evaluate: simpleNoRule('mobile_friendly') },
  outdated_website: { description: 'Website appears outdated', evaluate: simpleNoRule('website_modern') },
  no_clear_cta: { description: 'No clear call-to-action found on the website', evaluate: simpleNoRule('clear_cta') },
  poor_navigation: { description: 'Website navigation is unclear', evaluate: simpleNoRule('good_navigation') },
  // Composite: the analyzer records a phone-based CTA as evidence on a 'no' ordering/booking
  // check (see src/detect.js's phone_order_cta / phone_cta) - reading that is still reading
  // existing evidence, not inventing it.
  phone_only_process: {
    description: 'Ordering or booking appears to rely on phone calls',
    evaluate: (byType) => {
      const o = byType.online_ordering;
      const b = byType.online_booking;
      const oPhone = o?.result === 'no' && Array.isArray(o.evidence?.phone_order_cta) && o.evidence.phone_order_cta.length > 0;
      const bPhone = b?.result === 'no' && Array.isArray(b.evidence?.phone_cta) && b.evidence.phone_cta.length > 0;
      if (!oPhone && !bPhone) return null;
      const primary = oPhone ? o : b;
      return { checkId: primary.id, supportingCheckIds: oPhone && bPhone ? [b.id] : [] };
    },
  },
};

/**
 * @param {object[]} checks - the business's CURRENT checks: [{ id, check_type, result, evidence }]
 * @param {object} scoreWeights - the campaign's score_weights JSONB
 * @returns {{rule_key:string, description:string, points:number, check_id:string, supporting_check_ids:string[]}[]}
 *   Only the rules that actually fired, in score_weights' own key order.
 */
export function evaluateRules(checks, scoreWeights) {
  const byType = Object.fromEntries((checks || []).map((c) => [c.check_type, c]));
  const reasons = [];
  for (const [ruleKey, points] of Object.entries(scoreWeights || {})) {
    if (typeof points !== 'number' || !Number.isFinite(points)) continue; // malformed weight - never invent a value
    const rule = RULES[ruleKey];
    if (!rule) continue; // no evaluator for this key - skip, don't guess
    const hit = rule.evaluate(byType);
    if (!hit) continue;
    reasons.push({ rule_key: ruleKey, description: rule.description, points, check_id: hit.checkId, supporting_check_ids: hit.supportingCheckIds });
  }
  return reasons;
}
