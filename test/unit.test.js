import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHtml } from '../src/html.js';
import { redact, makeCheck, hasEvidence } from '../src/check.js';
import { needsReanalysis, expiryOverride, staleAt } from '../src/freshness.js';
import { parseRobots, robotsAllows, isPrivateAddress, httpGet } from '../src/http.js';
import { CHECK_TYPES, ANALYZER_CHECK_TYPES, RESULTS } from '../src/constants.js';
import { MemoryStore } from '../src/store-memory.js';
import { assertSafeTarget } from '../src/safety.js';
import { parseWebsiteUrl } from '../src/api/handler.js';
import { resolveProfile, appliesTo } from '../src/industry.js';
import { matchPlatform, isNonWebsiteHost } from '../src/platforms.js';

describe('schema compatibility (no schema change needed)', () => {
  const sql = fs.readFileSync(new URL('./fixtures/reference_schema.sql', import.meta.url), 'utf8');
  const enumValues = (name) => {
    const m = sql.match(new RegExp(`create type public\\.${name} as enum \\(([\\s\\S]*?)\\);`));
    assert.ok(m, `enum ${name} not found in schema`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  test('CHECK_TYPES equals the existing public.check_type enum', () => {
    assert.deepEqual([...CHECK_TYPES].sort(), enumValues('check_type').sort());
  });
  test('RESULTS equals the existing public.check_result enum', () => {
    assert.deepEqual([...RESULTS].sort(), enumValues('check_result').sort());
  });
  test('analyzer produces exactly the 14 requested checks, all valid enum values', () => {
    assert.equal(ANALYZER_CHECK_TYPES.length, 14);
    assert.deepEqual([...ANALYZER_CHECK_TYPES].sort(), [
      'clear_cta', 'contact_form', 'direct_ordering', 'good_navigation', 'hours_and_location', 'mobile_friendly',
      'online_booking', 'online_menu', 'online_ordering', 'reservations', 'third_party_ordering',
      'website_modern', 'website_present', 'website_reachable',
    ]);
    for (const t of ANALYZER_CHECK_TYPES) assert.ok(CHECK_TYPES.includes(t), t);
  });
});

describe('never-guess rules (makeCheck)', () => {
  test('yes/no without an evidence URL is stored as unknown, with the attempt recorded', () => {
    for (const r of ['yes', 'no']) {
      const c = makeCheck({ type: 'online_menu', result: r, evidence: { note: 'x' } });
      assert.equal(c.result, 'unknown');
      assert.equal(c.evidence.downgraded.from, r);
      assert.equal(c.confidence, null);
    }
  });
  test('yes/no with an evidence URL is kept', () => {
    const c = makeCheck({ type: 'online_menu', result: 'yes', confidence: 0.8, evidenceUrl: 'https://a.example/menu' });
    assert.equal(c.result, 'yes');
    assert.equal(c.confidence, 0.8);
    assert.ok(c.checked_at && c.method && c.checker_version);
  });
  test('unknown and not_applicable need no evidence URL', () => {
    assert.equal(makeCheck({ type: 'reservations', result: 'unknown' }).result, 'unknown');
    assert.equal(makeCheck({ type: 'reservations', result: 'not_applicable' }).result, 'not_applicable');
  });
  test('rejects values outside the enums', () => {
    assert.throws(() => makeCheck({ type: 'made_up', result: 'yes' }));
    assert.throws(() => makeCheck({ type: 'online_menu', result: 'maybe' }));
  });
  test('hasEvidence mirrors the SQL constraint', () => {
    assert.equal(hasEvidence({ evidence: {} }), false);
    assert.equal(hasEvidence({ evidence: { a: 1 } }), true);
    assert.equal(hasEvidence({ evidence_url: 'x', evidence: {} }), true);
  });
});

describe('privacy redaction', () => {
  test('phones, emails, tel:/mailto: links never survive', () => {
    const out = redact('<a href="tel:+17135550142">Call (713) 555-0142 or 713-555-0142 or +1 713 555 0142</a> mail owner@shop.com mailto:a@b.co');
    assert.doesNotMatch(out, /713|555|owner@|a@b\.co|0142/);
  });
  test('prices, hours and ZIPs are left alone', () => {
    assert.equal(redact('$12.50 open 11:00-22:00 Houston TX 77002'), '$12.50 open 11:00-22:00 Houston TX 77002');
  });
  test('makeCheck redacts evidence and excerpt', () => {
    const c = makeCheck({ type: 'online_ordering', result: 'no', evidenceUrl: 'https://a.example/', excerpt: 'Call (713) 555-0142', evidence: { text: 'x@y.com' } });
    // scoped to the fields redaction actually touches - the row's own randomly-generated
    // id/checker_version/checked_at are unrelated and could coincidentally contain "555".
    assert.doesNotMatch(JSON.stringify({ excerpt: c.evidence_excerpt, evidence: c.evidence }), /555|x@y\.com/);
  });
});

describe('HTML extraction', () => {
  const html = `<!DOCTYPE html><html><head><title>T &amp; Co</title><meta name="viewport" content="width=device-width"><meta name="generator" content="WordPress 6.4">
  <script type="application/ld+json">{"@type":"Restaurant","openingHours":"Mo-Su 11:00-22:00"}</script><script>var x="<a href=hidden>";</script></head>
  <body><header><nav><a href="/menu">Menu</a><a href="https://order.toasttab.com/x"><img alt="Order online"></a></nav></header>
  <button>Book Now</button><form action="/c"><input type="email" name="e"><textarea></textarea><button>Send</button></form><font>x</font></body></html>`;
  const p = parseHtml(html, 'https://a.example/');
  test('title, doctype, generator, JSON-LD', () => {
    assert.equal(p.title, 'T & Co');
    assert.match(p.doctype, /html/i);
    assert.equal(p.generator, 'WordPress 6.4');
    assert.equal(p.jsonLd.length, 1);
  });
  test('links resolve, keep nav/header flags, image alt becomes text, script text ignored', () => {
    assert.equal(p.links.length, 2);
    assert.equal(p.links[0].resolved, 'https://a.example/menu');
    assert.equal(p.links[1].text.trim(), 'Order online');
    assert.ok(p.links.every((l) => l.inNav && l.inHeader));
  });
  test('buttons, forms and legacy counters', () => {
    assert.ok(p.buttons.some((b) => b.text.trim() === 'Book Now'));
    assert.equal(p.forms.length, 1);
    assert.equal(p.forms[0].textareas, 1);
    assert.equal(p.legacy.fontTags, 1);
  });
  test('JS shell detection', () => {
    const shell = parseHtml('<html><head><script src="/a.js"></script></head><body><div id="root"></div></body></html>', 'https://a.example/');
    assert.equal(shell.isJsShell, true);
    assert.equal(p.isJsShell, false);
  });
});

describe('freshness (mirrors public.campaign_business_needs_reanalysis)', () => {
  const day = 86400000;
  const now = new Date('2026-09-21T12:00:00Z');
  const mk = (type, daysAgo, extra = {}) => ({ check_type: type, is_current: true, checked_at: new Date(now - daysAgo * day).toISOString(), expires_at: null, ...extra });
  test('missing required check => needs re-analysis', () => {
    const r = needsReanalysis({ requiredChecks: ['website_present', 'online_menu'], currentChecks: [mk('website_present', 1)], staleAfterDays: 30, now });
    assert.deepEqual(r.missing, ['online_menu']);
    assert.equal(r.needs, true);
  });
  test('older than stale_after_days => stale; younger => fresh', () => {
    assert.deepEqual(needsReanalysis({ requiredChecks: ['website_present'], currentChecks: [mk('website_present', 31)], staleAfterDays: 30, now }).stale, ['website_present']);
    assert.equal(needsReanalysis({ requiredChecks: ['website_present'], currentChecks: [mk('website_present', 29)], staleAfterDays: 30, now }).needs, false);
  });
  test('own expires_at wins over the campaign window', () => {
    const c = mk('website_reachable', 5, { expires_at: new Date(now - day).toISOString() });
    assert.equal(needsReanalysis({ requiredChecks: ['website_reachable'], currentChecks: [c], staleAfterDays: 30, now }).needs, true);
    assert.equal(staleAt(c, 30).toISOString(), c.expires_at);
  });
  test('non-current rows are ignored', () => {
    const r = needsReanalysis({ requiredChecks: ['website_present'], currentChecks: [mk('website_present', 1, { is_current: false })], staleAfterDays: 30, now });
    assert.deepEqual(r.missing, ['website_present']);
  });
  test('early re-check only ever SHORTENS the window', () => {
    assert.equal(expiryOverride({ result: 'no', checkType: 'website_reachable' }, now, 30), new Date(now.getTime() + 3 * day).toISOString());
    assert.equal(expiryOverride({ result: 'no', checkType: 'website_reachable' }, now, 2), null);
    assert.equal(expiryOverride({ result: 'yes', checkType: 'website_reachable' }, now, 30), null);
  });
});

describe('robots.txt', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /private/*.pdf$\nAllow: /admin/public\n', 'allsafesiteanalyzer');
  test('disallow / allow with longest match and wildcards', () => {
    assert.equal(robotsAllows(rules, '/menu'), true);
    assert.equal(robotsAllows(rules, '/admin/x'), false);
    assert.equal(robotsAllows(rules, '/admin/public/a'), true);
    assert.equal(robotsAllows(rules, '/private/a.pdf'), false);
    assert.equal(robotsAllows(rules, '/private/a.html'), true);
  });
  test('a group naming our agent wins over *', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: AllSafeSiteAnalyzer\nAllow: /\n', 'allsafesiteanalyzer');
    assert.equal(robotsAllows(r, '/anything'), true);
  });
});

describe('SSRF guard', () => {
  test('private / loopback / link-local / metadata addresses are private', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(a), true, a);
    for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700:10::6814:179a']) assert.equal(isPrivateAddress(a), false, a);
  });
  test('http client refuses private targets by default (no request is made)', async () => {
    for (const u of ['http://127.0.0.1:9/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      const r = await httpGet(u, { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'EBLOCKED', u);
    }
  });
  test('localhost by name is refused at connect time too', async () => {
    const r = await httpGet('http://localhost:9/', { timeoutMs: 1000 });
    assert.equal(r.error.code, 'EBLOCKED');
  });
});

describe('endpoint URL validation', () => {
  test('accepts normal URLs and adds https when the scheme is missing', () => {
    assert.equal(parseWebsiteUrl('https://example.com/menu').url, 'https://example.com/menu');
    assert.equal(parseWebsiteUrl('example.com').url, 'https://example.com/');
    assert.equal(parseWebsiteUrl(null).url, null);
    assert.equal(parseWebsiteUrl('  ').url, null);
  });
  test('rejects bad schemes, credentials, private hosts, odd ports, non-strings', () => {
    for (const bad of ['ftp://a.com', 'javascript:alert(1)', 'https://user:pw@a.com', 'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/', 'https://a.internal/', 'https://a.com:22/', 'not a url at all', 42, {}]) {
      assert.ok(parseWebsiteUrl(bad).error, String(bad));
    }
  });
});

describe('platform + industry tables', () => {
  test('platform matching is by hostname, not substring', () => {
    assert.equal(matchPlatform('https://order.toasttab.com/online/x')?.name, 'Toast');
    assert.equal(matchPlatform('https://www.doordash.com/store/x')?.kind, 'marketplace');
    assert.equal(matchPlatform('https://www.fresha.com/a/x')?.kind, 'booking');
    assert.equal(matchPlatform('https://notdoordash.com/x'), null);
    assert.equal(matchPlatform('https://evil.example/?u=doordash.com'), null);
    assert.equal(matchPlatform('https://squareup.com/appointments/book/x')?.kind, 'booking');
    assert.equal(matchPlatform('https://squareup.com/about'), null);
  });
  test('social/listing URLs are not websites', () => {
    assert.equal(isNonWebsiteHost('https://www.facebook.com/x'), true);
    assert.equal(isNonWebsiteHost('https://linktr.ee/x'), true);
    assert.equal(isNonWebsiteHost('https://mikespizza.com'), false);
  });
  test('industry relevance: irrelevant features are not_applicable, unknown industries are never guessed', () => {
    assert.equal(appliesTo(resolveProfile('Pizza shops'), 'online_booking'), false);
    assert.equal(appliesTo(resolveProfile('Pizza shops'), 'online_ordering'), true);
    assert.equal(appliesTo(resolveProfile('Barbers'), 'online_menu'), false);
    assert.equal(appliesTo(resolveProfile('Restaurant'), 'reservations'), true);
    assert.equal(appliesTo(resolveProfile('Cafe'), 'reservations'), false);
    assert.equal(appliesTo(resolveProfile('Widget Store'), 'online_menu'), true);
    assert.equal(resolveProfile('Widget Store').known, false);
  });
});

describe('MemoryStore enforces the same rules as the schema', () => {
  const setup = () => {
    const s = new MemoryStore();
    const b = s.addBusiness({ owner_id: 'o1', business_name: 'X' });
    const row = (o = {}) => ({ owner_id: 'o1', business_id: b.id, check_type: 'online_menu', result: 'yes', evidence_url: 'https://x/', evidence: {}, method: 'http_crawl', checked_at: new Date().toISOString(), ...o });
    return { s, b, row };
  };
  test('yes/no without evidence is rejected (23514); unknown is accepted', async () => {
    const { s, row } = setup();
    await assert.rejects(s.insertChecks([row({ evidence_url: null })]), (e) => e.code === '23514');
    await s.insertChecks([row({ result: 'unknown', evidence_url: null })]);
  });
  test('a new check supersedes the previous one; history is preserved', async () => {
    const { s, b, row } = setup();
    await s.insertChecks([row({ result: 'no' })]);
    await s.insertChecks([row({ result: 'yes' })]);
    const all = await s.getChecks(b.id);
    const cur = await s.getCurrentChecks(b.id);
    assert.equal(all.length, 2);
    assert.equal(cur.length, 1);
    assert.equal(cur[0].result, 'yes');
    assert.equal(all.filter((c) => c.is_current).length, 1);
  });
  test('invalid enum values and unknown business are rejected', async () => {
    const { s, row } = setup();
    await assert.rejects(s.insertChecks([row({ check_type: 'nope' })]), (e) => e.code === '22P02');
    await assert.rejects(s.insertChecks([row({ business_id: 'missing' })]), (e) => e.code === '23503');
  });
  test('a bad row rolls back the whole batch', async () => {
    const { s, b, row } = setup();
    await assert.rejects(s.insertChecks([row(), row({ check_type: 'reservations', result: 'no', evidence_url: null })]));
    assert.equal((await s.getChecks(b.id)).length, 0);
  });
});

describe('write-target safety', () => {
  test('local hosts are allowed', () => {
    for (const u of ['http://127.0.0.1:54321', 'http://localhost:54321', 'http://host.docker.internal:54321']) assert.equal(assertSafeTarget(u).local, true);
  });
  test('remote hosts are refused unless the exact host is confirmed', () => {
    assert.throws(() => assertSafeTarget('https://abcd.supabase.co'), /Refusing to write to non-local database/);
    assert.throws(() => assertSafeTarget('https://abcd.supabase.co', 'other.supabase.co'), /Refusing/);
    assert.equal(assertSafeTarget('https://abcd.supabase.co', 'abcd.supabase.co').confirmed, true);
  });
});
