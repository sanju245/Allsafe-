// Pure rule-evaluation tests for src/score/rules.js. No store, no HTTP, no mocks
// of anything but plain check objects - these are the same shapes getCurrentChecks
// returns (id, check_type, result, evidence).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, RULES } from '../src/score/rules.js';

const DEFAULT_WEIGHTS = {
  no_website: 40, no_online_ordering: 25, no_online_booking: 25, no_online_menu: 15, poor_mobile: 20,
  outdated_website: 20, no_clear_cta: 10, phone_only_process: 15, social_only_presence: 20, poor_navigation: 10,
};

const chk = (id, check_type, result, evidence = {}) => ({ id, check_type, result, evidence });
const byRule = (reasons) => Object.fromEntries(reasons.map((r) => [r.rule_key, r]));

describe('evaluateRules', () => {
  test('positive signals: every matching "no" check fires its rule, with the exact configured points and the real check_id as evidence', () => {
    const checks = [
      chk('c-website', 'website_present', 'no', { basis: 'source_listing_has_no_website_field' }),
      chk('c-order', 'online_ordering', 'no'),
      chk('c-mobile', 'mobile_friendly', 'no'),
    ];
    const reasons = evaluateRules(checks, DEFAULT_WEIGHTS);
    const r = byRule(reasons);
    assert.equal(reasons.length, 3);
    assert.deepEqual(r.no_website, { rule_key: 'no_website', description: RULES.no_website.description, points: 40, check_id: 'c-website', supporting_check_ids: [] });
    assert.equal(r.no_online_ordering.points, 25);
    assert.equal(r.no_online_ordering.check_id, 'c-order');
    assert.equal(r.poor_mobile.points, 20);
    assert.equal(r.poor_mobile.check_id, 'c-mobile');
  });

  test('no opportunity signals: every check "yes" produces zero reasons', () => {
    const checks = [
      chk('a', 'website_present', 'yes'), chk('b', 'online_ordering', 'yes'), chk('c', 'online_booking', 'yes'),
      chk('d', 'online_menu', 'yes'), chk('e', 'mobile_friendly', 'yes'), chk('f', 'website_modern', 'yes'),
      chk('g', 'clear_cta', 'yes'), chk('h', 'good_navigation', 'yes'),
    ];
    assert.deepEqual(evaluateRules(checks, DEFAULT_WEIGHTS), []);
  });

  test('unknown checks never fire a rule - no evidence is invented', () => {
    const checks = [chk('a', 'website_present', 'unknown'), chk('b', 'online_ordering', 'unknown'), chk('c', 'mobile_friendly', 'no')];
    const reasons = evaluateRules(checks, DEFAULT_WEIGHTS);
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].rule_key, 'poor_mobile');
  });

  test('not_applicable checks never fire a rule', () => {
    const checks = [chk('a', 'online_booking', 'not_applicable'), chk('b', 'online_menu', 'not_applicable')];
    assert.deepEqual(evaluateRules(checks, DEFAULT_WEIGHTS), []);
  });

  test('a missing check (never run for this business) is simply absent from the reasons - no error, no fabricated result', () => {
    const checks = [chk('a', 'website_present', 'no', { basis: 'x' })]; // online_menu, mobile_friendly etc. were never run at all
    const reasons = evaluateRules(checks, DEFAULT_WEIGHTS);
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].rule_key, 'no_website');
  });

  test('no_website vs social_only_presence are mutually exclusive, routed by evidence.basis on the SAME check', () => {
    const genuinelyNone = evaluateRules([chk('a', 'website_present', 'no', { basis: 'source_listing_has_no_website_field' })], DEFAULT_WEIGHTS);
    assert.equal(genuinelyNone.length, 1);
    assert.equal(genuinelyNone[0].rule_key, 'no_website');
    assert.equal(genuinelyNone[0].points, 40);

    const socialOnly = evaluateRules([chk('b', 'website_present', 'no', { basis: 'listed_url_is_social_or_listing_page' })], DEFAULT_WEIGHTS);
    assert.equal(socialOnly.length, 1);
    assert.equal(socialOnly[0].rule_key, 'social_only_presence');
    assert.equal(socialOnly[0].points, 20);
    assert.equal(socialOnly[0].check_id, 'b');
  });

  test('website_present = "yes" fires neither no_website nor social_only_presence', () => {
    assert.deepEqual(evaluateRules([chk('a', 'website_present', 'yes')], DEFAULT_WEIGHTS), []);
  });

  describe('phone_only_process (composite evidence)', () => {
    test('fires from phone-based ordering evidence alone', () => {
      const checks = [chk('o', 'online_ordering', 'no', { phone_order_cta: [{ page: 'x' }] })];
      const reasons = evaluateRules(checks, DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process');
      assert.equal(reasons.length, 1);
      assert.equal(reasons[0].check_id, 'o');
      assert.deepEqual(reasons[0].supporting_check_ids, []);
    });

    test('fires from phone-based booking evidence alone', () => {
      const checks = [chk('b', 'online_booking', 'no', { phone_cta: [{ page: 'x' }] })];
      const reasons = evaluateRules(checks, DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process');
      assert.equal(reasons.length, 1);
      assert.equal(reasons[0].check_id, 'b');
    });

    test('both present: ordering is primary evidence, booking is supporting - fires exactly once', () => {
      const checks = [
        chk('o', 'online_ordering', 'no', { phone_order_cta: [{ page: 'x' }] }),
        chk('b', 'online_booking', 'no', { phone_cta: [{ page: 'y' }] }),
      ];
      const reasons = evaluateRules(checks, DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process');
      assert.equal(reasons.length, 1);
      assert.equal(reasons[0].check_id, 'o');
      assert.deepEqual(reasons[0].supporting_check_ids, ['b']);
    });

    test('does NOT fire on a plain "no" with no phone evidence, or when evidence.phone_order_cta is empty', () => {
      assert.deepEqual(evaluateRules([chk('o', 'online_ordering', 'no')], DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process'), []);
      assert.deepEqual(evaluateRules([chk('o', 'online_ordering', 'no', { phone_order_cta: [] })], DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process'), []);
    });

    test('does NOT fire when ordering/booking are "yes" or "unknown", even with stray phone_order_cta-shaped data', () => {
      assert.deepEqual(evaluateRules([chk('o', 'online_ordering', 'yes', { phone_order_cta: [{ page: 'x' }] })], DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process'), []);
      assert.deepEqual(evaluateRules([chk('o', 'online_ordering', 'unknown', { phone_order_cta: [{ page: 'x' }] })], DEFAULT_WEIGHTS).filter((r) => r.rule_key === 'phone_only_process'), []);
    });
  });

  test('a score_weights key with no matching rule is skipped, not guessed at', () => {
    const weights = { ...DEFAULT_WEIGHTS, some_future_signal: 99 };
    const checks = [chk('a', 'website_present', 'no', { basis: 'x' })];
    const reasons = evaluateRules(checks, weights);
    assert.ok(!reasons.some((r) => r.rule_key === 'some_future_signal'));
  });

  test('a malformed weight value (non-numeric) is skipped rather than treated as 0 or thrown', () => {
    const weights = { no_website: 'forty', poor_mobile: null, no_online_ordering: NaN, mobile_friendly: undefined };
    const checks = [chk('a', 'website_present', 'no', { basis: 'x' }), chk('b', 'mobile_friendly', 'no'), chk('c', 'online_ordering', 'no')];
    assert.deepEqual(evaluateRules(checks, weights), []);
  });

  test('points are passed through EXACTLY as the campaign configured them - proves this is campaign-configurable, not hardcoded', () => {
    const customWeights = { no_website: 7, poor_mobile: 3 };
    const checks = [chk('a', 'website_present', 'no', { basis: 'x' }), chk('b', 'mobile_friendly', 'no')];
    const reasons = evaluateRules(checks, customWeights);
    assert.equal(byRule(reasons).no_website.points, 7);
    assert.equal(byRule(reasons).poor_mobile.points, 3);
  });

  test('an empty or missing score_weights produces zero reasons, not an error', () => {
    assert.deepEqual(evaluateRules([chk('a', 'website_present', 'no', { basis: 'x' })], {}), []);
    assert.deepEqual(evaluateRules([chk('a', 'website_present', 'no', { basis: 'x' })], undefined), []);
  });

  test('an empty or missing checks array produces zero reasons, not an error', () => {
    assert.deepEqual(evaluateRules([], DEFAULT_WEIGHTS), []);
    assert.deepEqual(evaluateRules(undefined, DEFAULT_WEIGHTS), []);
  });
});
