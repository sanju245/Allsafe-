// End-to-end smoke tests: POST /api/analyze handler -> real analyzer (real HTTP crawl of local
// fixture sites) -> real SupabaseStore HTTP code -> fake PostgREST backed by a rules-mirroring store.
// Writes reports/smoke-report.md (+ .json) with input / detected result / evidence / DB record per scenario.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/api/handler.js';
import { handlerFromEnv, resetCache } from '../src/api/bootstrap.js';
import { SupabaseStore } from '../src/store-supabase.js';
import { StoreError } from '../src/errors.js';
import { ANALYZER_CHECK_TYPES } from '../src/constants.js';
import { classifySite } from '../src/detect.js';
import { startFakePostgrest } from './helpers/fake-postgrest.js';
import * as S from './helpers/sites.js';
import vercelFn from '../api/analyze.js';
import netlifyFn from '../netlify/functions/analyze.mjs';

const API_KEY = 'test-api-key';
const DAY = 86400000;
let fake, store, ownerId, clock;
const report = [];
const sites = [];

const cfg = (over = {}) => ({
  apiKey: API_KEY, allowPrivateNetworks: true, allowAnyPort: true, crawlDelayMs: 0, deadlineMs: 15_000,
  http: { retryDelayMs: 5, timeoutMs: 3000 }, ...over,
});
let handle;
const call = (payload, { token = API_KEY, method = 'POST', h = handle, raw } = {}) =>
  h({ method, headers: token === null ? {} : { authorization: `Bearer ${token}` }, rawBody: raw ?? JSON.stringify(payload) });

function seedBusiness(fields = {}) {
  return fake.store.addBusiness({ owner_id: ownerId, business_name: 'Test Business', industry: 'pizza', source_url: 'https://maps.example.test/place/abc', ...fields });
}
async function serve(routes) { const s = await S.startSite(routes); sites.push(s); return s; }
const rowsOf = (businessId, { history = false } = {}) => fake.store.checks.filter((c) => c.business_id === businessId && (history || c.is_current));
const byType = (rows) => Object.fromEntries(rows.map((r) => [r.check_type, r]));
const strip = (s, base) => (s == null ? s : String(s).replaceAll(base ?? '\u0000', '<site>'));

function invariants(body, businessId, site) {
  assert.equal(body.ok, true);
  assert.equal(body.status, 'analyzed');
  const rows = rowsOf(businessId);
  assert.equal(rows.length, 14, 'exactly one current row per requested check');
  assert.deepEqual(rows.map((r) => r.check_type).sort(), [...ANALYZER_CHECK_TYPES].sort());
  for (const r of rows) {
    assert.ok(['yes', 'no', 'unknown', 'not_applicable'].includes(r.result), `${r.check_type} result`);
    assert.ok(r.method && r.checker_version && r.checked_at, `${r.check_type} bookkeeping columns`);
    assert.equal(r.owner_id, ownerId, 'owner_id comes from the business row');
    assert.equal(r.is_current, true);
    if (r.result === 'yes' || r.result === 'no') {
      assert.ok(r.evidence_url, `${r.check_type}=${r.result} must cite an evidence URL`);
      assert.ok(r.evidence_excerpt || Object.keys(r.evidence).length, `${r.check_type}=${r.result} must carry evidence`);
      assert.ok(r.confidence > 0 && r.confidence <= 1, `${r.check_type} confidence`);
    }
    if (r.result === 'unknown' || r.result === 'not_applicable') assert.equal(r.confidence, null);
  }
  const blob = JSON.stringify(rows);
  assert.doesNotMatch(blob, /\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{3}[-.]\d{3}[-.]\d{4}|\+1\d{10}|[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}|mailto:|tel:\+?\d/i, 'no phone numbers / emails stored');
  if (site) assert.ok(site.hits.every((h) => h.method === 'GET'), 'crawler only ever issues GET (no form submission)');
}

async function scenario(id, title, { site, websiteUrl, industry, sourceUrl }, expected, extra = () => {}) {
  const business = seedBusiness({ industry, ...(sourceUrl ? { source_url: sourceUrl } : {}) });
  const input = { business_id: business.id, website_url: websiteUrl };
  const before = fake.requests.length;
  const out = await call(input);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const body = out.body;
  invariants(body, business.id, site);
  const rows = byType(rowsOf(business.id));
  for (const [type, want] of Object.entries(expected)) assert.equal(rows[type].result, want, `${id}: ${type} expected ${want} got ${rows[type].result}`);
  const writes = fake.requests.slice(before).filter((r) => r.method === 'POST' && r.path.endsWith('/checks'));
  assert.equal(writes.length, 1, 'all 14 rows are written in ONE request (one transaction)');
  assert.equal(JSON.parse(writes[0].body).length, 14);
  extra({ body, rows, business: fake.store.businesses.get(business.id), site });
  const base = site?.url;
  report.push({
    id, title, input: { ...input, industry, website_url: strip(websiteUrl, base) ?? null },
    summary: body.summary, site_state: body.site_state, conclusive: body.conclusive,
    detected: ANALYZER_CHECK_TYPES.map((t) => {
      const r = rows[t];
      return { check_type: t, result: r.result, confidence: r.confidence, http_status: r.http_status, evidence_url: strip(r.evidence_url, base), evidence_excerpt: strip(r.evidence_excerpt, base), reason: r.evidence?.reason ?? r.evidence?.basis ?? r.evidence?.signal ?? null };
    }),
    db: ANALYZER_CHECK_TYPES.map((t) => {
      const r = rows[t];
      return { id: r.id.slice(0, 8), check_type: t, result: r.result, confidence: r.confidence, evidence_url: strip(r.evidence_url, base), evidence_excerpt: strip(r.evidence_excerpt, base), method: r.method, http_status: r.http_status, checked_at: r.checked_at, expires_at: r.expires_at, is_current: r.is_current, evidence: JSON.parse(strip(JSON.stringify(r.evidence), base)) };
    }),
    business_summary: (({ website_status, online_ordering, online_menu, online_booking, reservation_available, last_analyzed_at }) => ({ website_status, online_ordering, online_menu, online_booking, reservation_available, last_analyzed_at }))(fake.store.businesses.get(business.id)),
    crawl: body.crawl ? { ...body.crawl, start_url: strip(body.crawl.start_url, base), final_url: strip(body.crawl.final_url, base), pages_inspected: body.crawl.pages_inspected.map((u) => strip(u, base)), redirects: undefined, robots: undefined } : null,
    http_requests_to_site: site ? site.hits.map((h) => `${h.method} ${h.path}`) : [],
  });
  return { body, rows, business };
}

before(async () => {
  fake = await startFakePostgrest();
  store = new SupabaseStore({ url: fake.url, serviceKey: fake.serviceKey });
  ownerId = randomUUID();
  clock = new Date();
  handle = createHandler({ store, config: cfg(), now: () => clock });
});

after(async () => {
  for (const s of sites) await s.close();
  await fake.close();
  fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../reports/smoke-report.json', import.meta.url), JSON.stringify(report, null, 2));
  const md = ['# Smoke test report', '', `Generated ${new Date().toISOString()}. Fixture sites are synthetic pages served from 127.0.0.1; the database is a rules-mirroring fake PostgREST (not Postgres).`, ''];
  for (const s of report) {
    md.push(`## ${s.id}. ${s.title}`, '', '**Input**', '```json', JSON.stringify(s.input, null, 2), '```', '',
      `**Detected** (site_state=\`${s.site_state}\`, conclusive=\`${s.conclusive}\`, summary=${JSON.stringify(s.summary)})`, '',
      '| check | result | conf | http | evidence url | why / excerpt |', '|---|---|---|---|---|---|');
    for (const d of s.detected) md.push(`| ${d.check_type} | **${d.result}** | ${d.confidence ?? ''} | ${d.http_status ?? ''} | ${d.evidence_url ?? ''} | ${(d.evidence_excerpt ?? d.reason ?? '').replace(/\|/g, '\\|').slice(0, 90)} |`);
    md.push('', '**Database records (public.checks, is_current = true)**', '```json', JSON.stringify(s.db.map(({ evidence, ...r }) => r), null, 1), '```', '',
      '**businesses summary columns after insert**', '```json', JSON.stringify(s.business_summary), '```', '',
      `**HTTP requests made to the site:** ${s.http_requests_to_site.join(', ') || '(none)'}`, '');
  }
  fs.writeFileSync(new URL('../reports/smoke-report.md', import.meta.url), md.join('\n'));
});

describe('Scenarios (input -> detected result -> evidence -> DB record)', () => {
  test('A. business with no website', async () => {
    const src = 'https://maps.example.test/place/joes-pizza';
    await scenario('A', 'Business with no website (source listing has none)', { websiteUrl: null, industry: 'pizza', sourceUrl: src }, {
      website_present: 'no', website_reachable: 'not_applicable', mobile_friendly: 'not_applicable', website_modern: 'not_applicable',
      clear_cta: 'not_applicable', good_navigation: 'not_applicable', hours_and_location: 'not_applicable',
      online_menu: 'unknown', online_ordering: 'unknown', direct_ordering: 'no', third_party_ordering: 'unknown',
      online_booking: 'not_applicable', reservations: 'not_applicable', contact_form: 'no',
    }, ({ rows, business, body }) => {
      assert.equal(rows.website_present.evidence_url, src);
      assert.equal(rows.website_present.evidence.verification, 'source_listing_only');
      assert.equal(rows.website_present.confidence, 0.6, 'low confidence: listing-only evidence');
      assert.equal(rows.direct_ordering.evidence.derived_from.check_id, rows.website_present.id, 'derived check points at its parent');
      assert.equal(business.website_status, 'none_found');
      assert.equal(body.crawl, null, 'nothing was fetched');
    });
  });

  test('B. restaurant with a menu but no detectable online ordering', async () => {
    const site = await serve(S.restaurantMenuNoOrdering());
    await scenario('B', 'Restaurant with HTML menu, phone-only ordering', { site, websiteUrl: site.url + '/', industry: 'restaurant' }, {
      website_present: 'yes', website_reachable: 'yes', mobile_friendly: 'yes', website_modern: 'yes', clear_cta: 'yes', good_navigation: 'yes',
      hours_and_location: 'yes', online_menu: 'yes', online_ordering: 'no', direct_ordering: 'no', third_party_ordering: 'no',
      online_booking: 'not_applicable', reservations: 'no', contact_form: 'yes',
    }, ({ rows, business }) => {
      assert.match(rows.online_menu.evidence_url, /\/menu$/);
      assert.ok(rows.online_menu.evidence.price_count >= 6);
      assert.equal(rows.online_ordering.evidence.phone_order_cta.length, 1, 'phone-based ordering CTA recorded (number redacted)');
      assert.equal(rows.online_ordering.evidence.conclusive, true);
      assert.deepEqual(rows.online_ordering.evidence.pages_inspected.map((u) => u.replace(site.url, '')), ['/', '/menu', '/contact']);
      assert.equal(business.website_status, 'active');
      assert.equal(business.online_ordering, 'no');
      assert.equal(business.online_menu, 'yes');
    });
  });

  test('C. restaurant with online ordering (Toast + DoorDash)', async () => {
    const site = await serve(S.restaurantWithOrdering());
    await scenario('C', 'Restaurant with online ordering', { site, websiteUrl: site.url, industry: 'restaurant' }, {
      website_present: 'yes', website_reachable: 'yes', online_menu: 'yes', online_ordering: 'yes', direct_ordering: 'yes', third_party_ordering: 'yes',
      online_booking: 'not_applicable', reservations: 'no', contact_form: 'yes',
    }, ({ rows, business }) => {
      assert.match(rows.online_ordering.evidence_excerpt, /order\.toasttab\.com/);
      assert.ok(rows.online_ordering.evidence.platforms.includes('Toast'));
      assert.ok(rows.online_ordering.evidence.platforms.includes('DoorDash'));
      assert.deepEqual(rows.third_party_ordering.evidence.platforms, ['DoorDash']);
      assert.equal(business.online_ordering, 'yes');
    });
  });

  test('D. barbershop with online booking (Fresha)', async () => {
    const site = await serve(S.barberWithBooking());
    await scenario('D', 'Business with online booking', { site, websiteUrl: site.url, industry: 'Barbers' }, {
      website_present: 'yes', website_reachable: 'yes', online_booking: 'yes', online_menu: 'not_applicable', online_ordering: 'not_applicable',
      direct_ordering: 'not_applicable', third_party_ordering: 'not_applicable', reservations: 'not_applicable', contact_form: 'yes', clear_cta: 'yes',
    }, ({ rows, business }) => {
      assert.match(rows.online_booking.evidence_excerpt, /fresha\.com/);
      assert.deepEqual(rows.online_booking.evidence.platforms, ['Fresha']);
      assert.equal(business.online_booking, 'yes');
    });
  });

  test('E. website that cannot be reached (connection refused)', async () => {
    const dead = (await S.closedPortUrl()) + '/';
    await scenario('E', 'Website cannot be reached (connection refused)', { websiteUrl: dead, industry: 'pizza' }, {
      website_present: 'yes', website_reachable: 'no', mobile_friendly: 'unknown', website_modern: 'unknown', clear_cta: 'unknown',
      good_navigation: 'unknown', hours_and_location: 'unknown', online_menu: 'unknown', online_ordering: 'unknown', direct_ordering: 'unknown',
      third_party_ordering: 'unknown', contact_form: 'unknown', online_booking: 'not_applicable', reservations: 'not_applicable',
    }, ({ rows, business }) => {
      assert.match(rows.website_reachable.error, /ECONNREFUSED/);
      assert.equal(rows.website_reachable.evidence.attempts, 2, 'retried once before concluding');
      const days = (new Date(rows.website_reachable.expires_at) - new Date(rows.website_reachable.checked_at)) / DAY;
      assert.equal(days, 3, 'unreachable results expire early so they are re-checked sooner');
      assert.equal(business.website_status, 'unreachable');
    });
  });

  test('E2. website answers HTTP 503', async () => {
    const site = await serve(S.serverError());
    await scenario('E2', 'Website returns HTTP 503', { site, websiteUrl: site.url, industry: 'pizza' }, {
      website_present: 'yes', website_reachable: 'no', online_menu: 'unknown', contact_form: 'unknown',
    }, ({ rows }) => { assert.equal(rows.website_reachable.http_status, 503); });
  });

  test('F. website where features cannot be determined (JavaScript-only page)', async () => {
    const site = await serve(S.spaShell());
    await scenario('F', 'JavaScript-rendered page: features cannot be determined', { site, websiteUrl: site.url, industry: 'pizza' }, {
      website_present: 'yes', website_reachable: 'yes', mobile_friendly: 'yes', website_modern: 'unknown', clear_cta: 'unknown', good_navigation: 'unknown',
      hours_and_location: 'unknown', online_menu: 'unknown', online_ordering: 'unknown', direct_ordering: 'unknown', third_party_ordering: 'unknown',
      contact_form: 'unknown', online_booking: 'not_applicable', reservations: 'not_applicable',
    }, ({ rows }) => {
      assert.ok(rows.online_menu.evidence.inconclusive_reasons.includes('homepage_js_rendered'));
      assert.deepEqual(site.hits.map((h) => h.path), ['/robots.txt', '/'], 'scripts are never fetched or executed');
    });
  });

  test('G. outdated site: legacy markup, no viewport, nothing actionable', async () => {
    const site = await serve(S.legacySite());
    await scenario('G', 'Outdated site (marquee, font tags, tables, no viewport)', { site, websiteUrl: site.url, industry: 'auto repair' }, {
      website_present: 'yes', mobile_friendly: 'no', website_modern: 'no', clear_cta: 'no', good_navigation: 'no',
      hours_and_location: 'no', online_booking: 'no', contact_form: 'no', online_menu: 'not_applicable',
    }, ({ rows }) => {
      const ind = rows.website_modern.evidence.outdated_indicators.map((i) => i.indicator);
      assert.ok(ind.includes('marquee_or_blink'));
      assert.equal(rows.website_modern.confidence, 0.85);
    });
  });

  test('H. menu available only as a PDF', async () => {
    const site = await serve(S.pdfMenuOnly());
    await scenario('H', 'Menu only as PDF', { site, websiteUrl: site.url, industry: 'pizza' }, { online_menu: 'no', online_ordering: 'no', good_navigation: 'yes' },
      ({ rows }) => { assert.equal(rows.online_menu.evidence.signal, 'menu_only_as_pdf'); assert.match(rows.online_menu.evidence.pdf_urls[0], /menu\.pdf$/); });
  });

  test('I. "Order Online" link whose page cannot be verified stays unknown', async () => {
    const site = await serve(S.orderLinkUnverified());
    await scenario('I', 'Order link found but not verifiable', { site, websiteUrl: site.url, industry: 'pizza' }, { online_ordering: 'unknown', direct_ordering: 'unknown', online_menu: 'yes' },
      ({ rows }) => { assert.equal(rows.online_ordering.evidence.reason, 'order_link_found_but_unverified'); });
  });

  test('J. robots.txt disallows the menu page: it is not fetched and dependent checks are unknown', async () => {
    const site = await serve(S.robotsBlocksMenu());
    await scenario('J', 'robots.txt blocks /menu', { site, websiteUrl: site.url, industry: 'restaurant' }, { online_menu: 'unknown', online_ordering: 'unknown', reservations: 'unknown', contact_form: 'yes' },
      ({ rows }) => {
        assert.ok(!site.hits.some((h) => h.path === '/menu'), '/menu must never be requested');
        assert.ok(rows.online_menu.evidence.inconclusive_reasons.includes('robots_disallow:/menu'));
      });
  });

  test('K. listed "website" is a Facebook page: not a website, and nothing is fetched', async () => {
    await scenario('K', 'Listing URL is a social page', { websiteUrl: 'https://www.facebook.com/mikespizzahouston', industry: 'pizza' },
      { website_present: 'no', website_reachable: 'not_applicable', direct_ordering: 'no', contact_form: 'no' },
      ({ rows, body }) => { assert.equal(rows.website_present.evidence.basis, 'listed_url_is_social_or_listing_page'); assert.equal(rows.website_present.confidence, 0.9); assert.equal(body.crawl, null); });
  });

  test('M. website refuses us with HTTP 403: unknown, never "no"', async () => {
    const site = await serve(S.forbidden());
    await scenario('M', 'Website returns HTTP 403', { site, websiteUrl: site.url, industry: 'pizza' }, { website_present: 'yes', website_reachable: 'unknown', online_menu: 'unknown' },
      ({ rows }) => { assert.equal(rows.website_reachable.http_status, 403); });
  });

  test('N. plain page with no call to action at all', async () => {
    const site = await serve(S.plainNoCta());
    await scenario('N', 'No CTA, no navigation, no forms', { site, websiteUrl: site.url, industry: 'cleaning' }, { clear_cta: 'no', good_navigation: 'no', online_booking: 'no', contact_form: 'no', hours_and_location: 'no' });
  });
});

describe('TLS', () => {
  let tmp, key, cert;
  const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  before(() => {
    if (!haveOpenssl) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allsafe-tls-'));
    key = path.join(tmp, 'k.pem'); cert = path.join(tmp, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  });
  const startHttps = () => new Promise((resolve) => {
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(S.barberWithBooking()['/']); });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `https://127.0.0.1:${server.address().port}` }));
  });

  test('valid HTTPS site is reachable and recorded as served over https', { skip: !haveOpenssl && 'openssl not available' }, async () => {
    const { server, url } = await startHttps();
    try {
      const h = createHandler({ store, config: cfg({ http: { retryDelayMs: 5, timeoutMs: 3000, ca: fs.readFileSync(cert) } }), now: () => clock });
      const b = seedBusiness({ industry: 'barber' });
      const out = await call({ business_id: b.id, website_url: url }, { h });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const rows = byType(rowsOf(b.id));
      assert.equal(rows.website_reachable.result, 'yes');
      assert.equal(rows.website_reachable.evidence.served_over_https, true);
    } finally { server.closeAllConnections?.(); server.close(); }
  });

  test('self-signed certificate is a site fault: reachable = no, with the TLS error as evidence', { skip: !haveOpenssl && 'openssl not available' }, async () => {
    const { server, url } = await startHttps();
    try {
      const b = seedBusiness({ industry: 'barber' });
      const out = await call({ business_id: b.id, website_url: url });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const rows = byType(rowsOf(b.id));
      assert.equal(rows.website_reachable.result, 'no');
      assert.match(rows.website_reachable.error, /SELF_SIGNED|DEPTH_ZERO/);
    } finally { server.closeAllConnections?.(); server.close(); }
  });

  test('an untrusted chain could be OUR trust store, so it is unknown; an expired cert is the site\'s fault', () => {
    const mk = (code) => classifySite({ website_url: 'https://a.example' }, { home: { ok: false, error: { code }, redirects: [] } }).kind;
    assert.equal(mk('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'blocked');
    assert.equal(mk('SELF_SIGNED_CERT_IN_CHAIN'), 'blocked');
    assert.equal(mk('CERT_HAS_EXPIRED'), 'unreachable');
    assert.equal(mk('ENOTFOUND'), 'unreachable');
    assert.equal(mk('EBLOCKED'), 'blocked');
  });
});

describe('Append-only history + stale_after_days', () => {
  test('re-analysis keeps history and flips only the newest rows to is_current; freshness is respected', async () => {
    const site = await serve(S.restaurantMenuNoOrdering());
    const campaign = fake.store.addCampaign({ owner_id: ownerId, industry: 'restaurant', stale_after_days: 30, required_checks: ['website_present', 'online_menu', 'online_ordering'] });
    const b = seedBusiness({ industry: 'restaurant' });
    const payload = { business_id: b.id, website_url: site.url, campaign_id: campaign.id };
    clock = new Date();

    let out = await call(payload);
    assert.equal(out.body.status, 'analyzed');
    assert.equal(rowsOf(b.id, { history: true }).length, 14);

    clock = new Date(clock.getTime() + 1 * DAY);
    out = await call(payload);
    assert.equal(out.body.status, 'skipped_fresh', 'fresh checks are not re-run');
    assert.equal(rowsOf(b.id, { history: true }).length, 14, 'nothing written when skipped');

    clock = new Date(clock.getTime() + 30 * DAY);
    out = await call(payload);
    assert.equal(out.body.status, 'analyzed', 'stale checks trigger a new analysis');
    const all = rowsOf(b.id, { history: true });
    assert.equal(all.length, 28, 'history preserved');
    assert.equal(all.filter((r) => r.is_current).length, 14, 'only the newest 14 are current');
    assert.equal(new Set(all.filter((r) => r.is_current).map((r) => r.check_type)).size, 14);
    assert.ok(all.filter((r) => !r.is_current).every((r) => new Date(r.checked_at) < clock));

    out = await call({ ...payload, force: true });
    assert.equal(out.body.status, 'analyzed', 'force always re-analyzes');
    assert.equal(rowsOf(b.id, { history: true }).length, 42);
    clock = new Date();
  });

  test('an unreachable result expires after 3 days even though the campaign window is 30', async () => {
    const dead = (await S.closedPortUrl()) + '/';
    const campaign = fake.store.addCampaign({ owner_id: ownerId, industry: 'pizza', stale_after_days: 30, required_checks: ['website_reachable'] });
    const b = seedBusiness({ industry: 'pizza' });
    const payload = { business_id: b.id, website_url: dead, campaign_id: campaign.id };
    clock = new Date();
    assert.equal((await call(payload)).body.status, 'analyzed');
    clock = new Date(clock.getTime() + 2 * DAY);
    assert.equal((await call(payload)).body.status, 'skipped_fresh');
    clock = new Date(clock.getTime() + 2 * DAY);
    assert.equal((await call(payload)).body.status, 'analyzed', 're-checked after ~4 days');
    clock = new Date();
  });
});

describe('POST /api/analyze contract', () => {
  const good = () => ({ business_id: seedBusiness().id, website_url: null });

  test('only POST is accepted', async () => { assert.equal((await call({}, { method: 'GET' })).status, 405); });
  test('missing or wrong bearer token is 401 and nothing is written', async () => {
    const before = fake.store.checks.length;
    assert.equal((await call(good(), { token: null })).status, 401);
    assert.equal((await call(good(), { token: 'nope' })).status, 401);
    assert.equal(fake.store.checks.length, before);
  });
  test('fails closed when ANALYZE_API_KEY is not configured', async () => {
    const h = createHandler({ store, config: cfg({ apiKey: undefined }) });
    assert.equal((await call(good(), { h })).status, 500);
  });
  test('validation errors are 400', async () => {
    const b = seedBusiness();
    for (const [payload, code, opts] of [
      [{ website_url: null }, 'invalid_business_id'],
      [{ business_id: 'not-a-uuid', website_url: null }, 'invalid_business_id'],
      [{ business_id: b.id }, 'missing_website_url'],
      [{ business_id: b.id, website_url: 'ftp://x.com' }, 'invalid_website_url'],
      [{ business_id: b.id, website_url: 'https://user:pw@x.com' }, 'invalid_website_url'],
      [{ business_id: b.id, website_url: null, campaign_id: 'x' }, 'invalid_campaign_id'],
      [{ business_id: b.id, website_url: null, force: 'yes' }, 'invalid_force'],
      [null, 'invalid_body', { raw: 'null' }],
      [null, 'invalid_json', { raw: '{oops' }],
    ]) {
      const out = await call(payload, opts);
      assert.equal(out.status, 400, code);
      assert.equal(out.body.error.code, code);
    }
  });
  test('production config refuses private / loopback targets (SSRF)', async () => {
    const prod = createHandler({ store, config: { apiKey: API_KEY } });
    const b = seedBusiness();
    for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'https://a.example:22/']) {
      const out = await call({ business_id: b.id, website_url: u }, { h: prod });
      assert.equal(out.status, 400, u);
    }
    assert.equal(rowsOf(b.id).length, 0);
  });
  test('unknown business / campaign are 404', async () => {
    assert.equal((await call({ business_id: randomUUID(), website_url: null })).status, 404);
    assert.equal((await call({ business_id: seedBusiness().id, website_url: null, campaign_id: randomUUID() })).body.error.code, 'campaign_not_found');
  });
  test('owner_id and other extra fields from the caller are ignored', async () => {
    const b = seedBusiness();
    const out = await call({ business_id: b.id, website_url: null, owner_id: 'attacker', is_current: false, check_type: 'x' });
    assert.equal(out.status, 200);
    assert.ok(rowsOf(b.id).every((r) => r.owner_id === ownerId));
  });
  test('every request to the database carries the service key; the response reports what was stored', async () => {
    const b = seedBusiness();
    const out = await call({ business_id: b.id, website_url: null });
    assert.equal(out.body.checks.length, 14);
    assert.ok(out.body.checks.every((c) => c.id && c.check_type && c.result && c.method && c.checked_at));
    assert.ok(fake.requests.every((r) => r.headers.apikey === fake.serviceKey && r.headers.authorization === `Bearer ${fake.serviceKey}`));
  });
  test('database rejections map to 502 / 409 and nothing is reported as stored', async () => {
    const b = seedBusiness();
    const failing = (code) => ({ getBusiness: async () => ({ id: b.id, owner_id: ownerId, industry: 'pizza' }), getCampaign: async () => null, getCurrentChecks: async () => [], insertChecks: async () => { throw new StoreError('db said no', { code }); }, insertEvent: async () => {} });
    assert.equal((await call({ business_id: b.id, website_url: null }, { h: createHandler({ store: failing('23514'), config: cfg() }) })).status, 502);
    const dup = await call({ business_id: b.id, website_url: null }, { h: createHandler({ store: failing('23505'), config: cfg() }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'concurrent_analysis');
  });
  test('a failing audit-event write does not hide stored checks', async () => {
    const b = seedBusiness();
    const s2 = { getBusiness: (id) => store.getBusiness(id), getCampaign: (id) => store.getCampaign(id), getCurrentChecks: (id) => store.getCurrentChecks(id), insertChecks: (r) => store.insertChecks(r), insertEvent: async () => { throw new Error('events down'); } };
    const out = await call({ business_id: b.id, website_url: null }, { h: createHandler({ store: s2, config: cfg() }) });
    assert.equal(out.status, 200);
    assert.equal(rowsOf(b.id).length, 14);
  });
  test('concurrency cap returns 429', async () => {
    const b = seedBusiness();
    const slow = createHandler({ store, config: cfg({ maxConcurrent: 1 }), analyze: async (i, o) => { await new Promise((r) => setTimeout(r, 150)); return (await import('../src/analyze.js')).analyzeBusiness(i, o); } });
    const [x, y] = await Promise.all([call({ business_id: b.id, website_url: null }, { h: slow }), call({ business_id: b.id, website_url: null }, { h: slow })]);
    assert.deepEqual([x.status, y.status].sort(), [200, 429]);
  });
  test('an analysis event is written for audit', async () => {
    const b = seedBusiness();
    await call({ business_id: b.id, website_url: null });
    const ev = fake.store.events.filter((e) => e.business_id === b.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].event_type, 'analysis.completed');
    assert.equal(ev[0].payload.summary.not_applicable > 0, true);
  });
});

describe('Vercel and Netlify adapters', () => {
  const saved = { ...process.env };
  const setEnv = (over) => { resetCache(); Object.assign(process.env, { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey, ANALYZE_API_KEY: API_KEY }, over); };
  after(() => { process.env = saved; resetCache(); });

  const res = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

  test('Vercel: parsed JSON body, bearer auth, 200 with 14 checks', async () => {
    setEnv({});
    const b = seedBusiness();
    const r = res();
    await vercelFn({ method: 'POST', headers: { authorization: `Bearer ${API_KEY}` }, body: { business_id: b.id, website_url: null } }, r);
    assert.equal(r.code, 200);
    assert.equal(r.body.checks.length, 14);
  });
  test('Vercel: 401 without token', async () => {
    setEnv({});
    const r = res();
    await vercelFn({ method: 'POST', headers: {}, body: {} }, r);
    assert.equal(r.code, 401);
  });
  test('Netlify: Request/Response', async () => {
    setEnv({});
    const b = seedBusiness();
    const resp = await netlifyFn(new Request('http://x/api/analyze', { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ business_id: b.id, website_url: null }) }));
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).checks.length, 14);
  });
  test('missing configuration is a clean 500, not a crash', async () => {
    resetCache();
    process.env = { ...saved }; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = res();
    await vercelFn({ method: 'POST', headers: {}, body: {} }, r);
    assert.equal(r.code, 500);
    assert.equal(r.body.error.code, 'server_misconfigured');
  });
  test('a remote database is refused unless explicitly confirmed', () => {
    resetCache();
    assert.throws(() => handlerFromEnv({ SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ANALYZE_API_KEY: 'k' }), /Refusing to write to non-local database/);
    resetCache();
    assert.ok(handlerFromEnv({ SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ANALYZE_API_KEY: 'k', ANALYZE_CONFIRM_REMOTE_DB: 'abcd.supabase.co' }));
    resetCache();
  });
});

describe('server.js speaks real HTTP', () => {
  test('health, 404, 401, 413, 400 and 200 over a real socket', async () => {
    const { spawn } = await import('node:child_process');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { PATH: process.env.PATH, PORT: String(port), SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey, ANALYZE_API_KEY: API_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server did not start')), 5000);
        child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
        child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
      });
      const base = `http://127.0.0.1:${port}`;
      const post = (body, token = API_KEY) => fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      assert.equal((await fetch(`${base}/nope`)).status, 404);
      assert.equal((await post('{}', null)).status, 401);
      assert.equal((await post('x'.repeat(20 * 1024))).status, 413);
      assert.equal((await post('{"business_id":"bad"}')).status, 400);
      const b = seedBusiness();
      const ok = await post(JSON.stringify({ business_id: b.id, website_url: null }));
      assert.equal(ok.status, 200);
      const json = await ok.json();
      assert.equal(json.status, 'analyzed');
      assert.equal(json.checks.length, 14);
    } finally { child.kill(); }
  });
});
