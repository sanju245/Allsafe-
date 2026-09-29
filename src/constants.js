// Shared constants. CHECK_TYPES mirrors the existing Postgres enum public.check_type
// (no schema change needed); test/unit.test.js parses the schema and fails on drift.

export const CHECKER_VERSION = '0.1.0';
export const USER_AGENT = 'AllSafeSiteAnalyzer/0.1 (+https://allsafe.example/bot; business website research)';
export const ROBOTS_TOKEN = 'allsafesiteanalyzer';

export const RESULTS = ['yes', 'no', 'unknown', 'not_applicable'];

export const CHECK_TYPES = [
  'website_present', 'website_reachable', 'website_modern', 'mobile_friendly',
  'clear_cta', 'good_navigation', 'hours_and_location', 'online_menu',
  'online_ordering', 'direct_ordering', 'third_party_ordering', 'online_booking',
  'reservations', 'contact_form', 'social_presence', 'phone_listed',
];

// What this Analyze stage actually produces (one row per type, every run).
export const ANALYZER_CHECK_TYPES = [
  'website_present', 'website_reachable', 'mobile_friendly', 'website_modern',
  'clear_cta', 'good_navigation', 'hours_and_location',
  'online_menu', 'online_ordering', 'direct_ordering', 'third_party_ordering',
  'online_booking', 'reservations', 'contact_form',
];

export const DAY_MS = 24 * 60 * 60 * 1000;
