// Evidence-based detectors. Each returns a draft for ONE check_type.
//
// Ground rules (never guess):
//   yes  = a positive signal was observed (and we cite the URL where)
//   no   = the source/site was inspected conclusively and the signal is absent
//   unknown = could not verify (blocked, JS-only pages, failed page fetches, ...)
//   not_applicable = the feature is irrelevant for the industry, or has no
//                    meaning without a website (e.g. HTTPS of a non-existent site)
// Absence is only reported as 'no' when the crawl was CONCLUSIVE.

import { matchPlatform, isNonWebsiteHost, hostOf } from './platforms.js';
import { appliesTo } from './industry.js';
import { isConclusive, normalizeUrl } from './crawl.js';

// TLS problems that are the SITE's fault vs. ones that may just be our trust store / a proxy.
const TLS_SITE_FAULT = new Set(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_NOT_YET_VALID']);
const TLS_AMBIGUOUS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN']);

const ORDER_TEXT = /\b(order (online|now|ahead|pickup|for pickup|delivery|takeout|here|food)|online ordering|start (your )?order|place (an )?order|order & pay)\b/i;
const BOOK_TEXT = /\b(book (now|online|today|an appointment|your appointment|appointment|a (table|visit|service|cut|session|consultation|appointment))|schedule (an? )?(appointment|service|visit|consultation|online|now)|request (an? )?appointment|online booking|make (an? )?(appointment|booking))\b/i;
const RESERVE_TEXT = /\b(reserve( a table)?|reservations?|book a table|book your table)\b/i;
const CHECKOUT_RE = /add to (cart|order|basket)|view (cart|basket)|your (cart|basket)|checkout|place order|order summary|pickup time|choose (pickup|delivery)|delivery address/i;
const BOOKING_PAGE_RE = /select (a )?(service|date|time)|choose (a )?(service|date|time)|available times?|pick a (date|time)/i;
const PARTY_RE = /party size|number of (guests|people)|guests?\b/i;
const PRICE_RE = /\$\s?\d{1,3}(?:[.,]\d{2})?/g;
const CTA_STRONG = /\b(order (online|now|ahead|pickup|delivery|takeout)|online ordering|book (now|online|an appointment|appointment|a table|your (appointment|visit|table))|schedule (an? )?(appointment|service|now|online|visit)|reserve( a table| now| your table)?|call (us|now|today)|get (a |your )?(free )?(quote|estimate)|request (a |an )?(free )?(quote|estimate|appointment)|free (quote|estimate))\b/i;
const CTA_WEAK = /\b(contact us|get in touch|reservations?)\b/i;
const HOURS_RES = [
  /\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)\b[^.\n]{0,60}?\b\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)/i,
  /\bopen\s+(daily|7 days|every day|24 hours)/i,
  /\b(hours|open)\b[^.]{0,40}\d{1,2}(:\d{2})?\s?(am|pm)\s?(-|–|—|to)\s?\d{1,2}(:\d{2})?\s?(am|pm)/i,
];
const STREET_RE = /\b\d{1,5}\s+[A-Za-z0-9.'\s]{2,40}?\b(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Pkwy|Parkway|Ct|Court|Pl|Place)\b\.?,?\s+[A-Za-z.\s]{2,30},?\s+[A-Z]{2}\s+\d{5}\b/;
const MAP_HOST = /(^|\.)(maps\.google\.com|maps\.apple\.com|openstreetmap\.org|maps\.app\.goo\.gl)$/i;

// ----------------------------------------------------------------- helpers

function sameSite(a, b) {
  const ha = hostOf(a), hb = hostOf(b);
  return !!ha && ha === hb;
}

function targetPage(crawl, url) {
  const n = normalizeUrl(url);
  return crawl.pages.find((p) => normalizeUrl(p.finalUrl) === n || normalizeUrl(p.url) === n);
}

function resources(crawl) {
  const items = [];
  for (const p of crawl.pages) {
    for (const a of p.parsed.links) {
      const t = a.text.replace(/\s+/g, ' ').trim();
      items.push({ kind: 'anchor', page: p.finalUrl, url: a.resolved, scheme: a.scheme, href: a.href, text: t, html: `${a.openTag}${t.slice(0, 80)}</a>` });
    }
    for (const f of p.parsed.iframes) items.push({ kind: 'iframe', page: p.finalUrl, url: f.resolved, html: f.html });
    for (const s of p.parsed.scripts) if (s.resolved) items.push({ kind: 'script', page: p.finalUrl, url: s.resolved, html: s.html });
    for (const l of p.parsed.linkTags) if (l.resolved) items.push({ kind: 'link', page: p.finalUrl, url: l.resolved, html: null });
  }
  return items;
}

function pagesInspected(crawl) {
  return crawl.pages.map((p) => p.finalUrl);
}

const hitEv = (h) => ({
  signal: h.kind, platform: h.platform?.name ?? null, platform_kind: h.platform?.kind ?? null,
  url: h.url, page: h.page, text: h.text || undefined,
});

function inconclusiveEvidence(ctx) {
  const reasons = ctx.crawl.inconclusiveReasons;
  return {
    reason: 'inconclusive_crawl',
    inconclusive_reasons: reasons,
    pages_inspected: pagesInspected(ctx.crawl),
    transient: reasons.some((r) => r.startsWith('page_unavailable')),
  };
}

function scopeEvidence(ctx, extra = {}) {
  return { conclusive: true, scope: 'pages_inspected', pages_inspected: pagesInspected(ctx.crawl), ...extra };
}

// -------------------------------------------------------------- site state

export function classifySite(listing, crawl) {
  const raw = (listing.website_url || '').trim();
  if (!raw) return { kind: 'no_website' };
  const asUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  if (isNonWebsiteHost(asUrl)) return { kind: 'social_only', host: hostOf(asUrl), listedUrl: asUrl };
  const home = crawl?.home;
  if (!home) return { kind: 'unreachable', listedUrl: asUrl };
  if (home.blockedByRobots) return { kind: 'blocked', reason: 'robots_disallow', listedUrl: asUrl };
  if (!home.ok) {
    const code = home.error?.code;
    if (code === 'EBLOCKED' || code === 'EBADURL' || code === 'EBADPROTO') return { kind: 'blocked', reason: code === 'EBLOCKED' ? 'ssrf_guard' : 'bad_url', listedUrl: asUrl };
    // Untrusted-chain errors can be caused by OUR trust store or a proxy: do not blame the site.
    if (TLS_AMBIGUOUS.has(code)) return { kind: 'blocked', reason: 'tls_chain_not_verifiable', listedUrl: asUrl };
    return { kind: 'unreachable', listedUrl: asUrl };
  }
  if ([404, 410].includes(home.status) || home.status >= 500) return { kind: 'unreachable', listedUrl: asUrl };
  if (home.status >= 400) return { kind: 'blocked', reason: 'http_' + home.status, listedUrl: asUrl };
  if (!home.isHtml) return { kind: 'non_html', listedUrl: asUrl };
  return { kind: 'ok', listedUrl: asUrl };
}

const noSite = (ctx) => ctx.state.kind === 'no_website' || ctx.state.kind === 'social_only';
const notApplicableFeature = (ctx, type) => !appliesTo(ctx.profile, type);

function naProfile(ctx, type) {
  return { type, result: 'not_applicable', method: 'industry_profile', evidence: { reason: 'feature_not_relevant_for_industry', industry: ctx.profile.key } };
}
function naNoSite(type) {
  return { type, result: 'not_applicable', method: 'derived', evidence: { reason: 'no_dedicated_website' } };
}
function unknownNoSite(type, note) {
  return { type, result: 'unknown', method: 'derived', evidence: { reason: 'no_dedicated_website_to_inspect', note } };
}
function unknownNotFetched(ctx, type) {
  return {
    type, result: 'unknown', method: 'http_crawl',
    evidence: { reason: 'site_not_inspected', site_state: ctx.state.kind, detail: ctx.state.reason || null, transient: ctx.state.kind === 'blocked' && (ctx.state.reason || '').startsWith('http_') },
  };
}

// ------------------------------------------------------------ core website

function websitePresent(ctx) {
  const { listing, state } = ctx;
  const type = 'website_present';
  if (state.kind === 'no_website') {
    return {
      type, result: 'no', confidence: 0.6, method: 'source_listing', evidenceUrl: listing.source_url || null,
      evidence: {
        basis: 'source_listing_has_no_website_field', source: listing.source || null,
        verification: 'source_listing_only', independent_search_performed: false,
        caveat: 'Absent from the source listing; not independently searched. Outreach may only say a dedicated website was not found.',
      },
    };
  }
  if (state.kind === 'social_only') {
    return {
      type, result: 'no', confidence: 0.9, method: 'source_listing', evidenceUrl: state.listedUrl,
      evidence: { basis: 'listed_url_is_social_or_listing_page', host: state.host, listed_url: state.listedUrl, source: listing.source || null },
    };
  }
  const home = ctx.crawl?.home;
  return {
    type, result: 'yes', confidence: 0.95, method: 'source_listing', evidenceUrl: state.listedUrl,
    evidence: {
      basis: 'source_listing_website_url', source: listing.source || null, listed_url: state.listedUrl,
      observed_status: home?.status ?? null, observed_error: home?.error?.code ?? null,
    },
  };
}

function websiteReachable(ctx) {
  const type = 'website_reachable';
  const { state, crawl } = ctx;
  if (noSite(ctx)) return naNoSite(type);
  const home = crawl.home;
  if (state.kind === 'ok' || state.kind === 'non_html') {
    const offsite = home.redirects.length > 0 && hostOf(home.finalUrl) !== hostOf(state.listedUrl);
    return {
      type, result: 'yes', confidence: 0.95, evidenceUrl: home.finalUrl, httpStatus: home.status,
      evidence: {
        final_url: home.finalUrl, status: home.status, redirects: home.redirects, redirected_offsite: offsite,
        served_over_https: home.finalUrl.startsWith('https://'),
        attempts: home.attempts, duration_ms: home.durationMs, content_type: home.contentType || null,
        note: state.kind === 'non_html' ? 'responded, but not an HTML page' : undefined,
      },
    };
  }
  if (state.kind === 'unreachable') {
    return {
      type, result: 'no', confidence: 0.8, evidenceUrl: state.listedUrl, httpStatus: home.status ?? null,
      error: home.error ? `${home.error.code}: ${home.error.message}` : `HTTP ${home.status}`,
      evidence: { attempts: home.attempts ?? 1, status: home.status ?? null, error: home.error ?? null, redirects: home.redirects ?? [], note: 'no successful response after retry; re-check is scheduled sooner than normal' },
    };
  }
  return {
    type, result: 'unknown', httpStatus: home.status ?? null, error: home.error ? `${home.error.code}: ${home.error.message}` : null,
    evidence: { reason: 'access_refused_or_not_attempted', detail: state.reason, status: home.status ?? null, transient: state.reason?.startsWith('http_') || false },
  };
}

function mobileFriendly(ctx) {
  const type = 'mobile_friendly';
  if (noSite(ctx)) return naNoSite(type);
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  const home = ctx.crawl.home;
  const meta = home.parsed.metas.find((m) => (m.name || '').toLowerCase() === 'viewport');
  const content = meta?.content ?? null;
  const base = { page: home.finalUrl, signal: 'viewport_meta', limitation: 'meta viewport only; page layout was not rendered or tested' };
  if (meta && /width\s*=\s*device-width/i.test(content)) {
    return {
      type, result: 'yes', confidence: 0.7, evidenceUrl: home.finalUrl,
      excerpt: `<meta name="viewport" content="${content}">`,
      evidence: { ...base, viewport: content, zoom_disabled: /user-scalable\s*=\s*(no|0)/i.test(content) },
    };
  }
  return {
    type, result: 'no', confidence: 0.8, evidenceUrl: home.finalUrl,
    excerpt: meta ? `<meta name="viewport" content="${content}">` : null,
    evidence: { ...base, viewport: content, reason: meta ? 'viewport_not_device_width' : 'no_viewport_meta' },
  };
}

// ---------------------------------------------------- feature evaluation

function evaluateFeature(ctx, { kinds, textRe, corroborate }) {
  const items = resources(ctx.crawl);
  const platformHits = items
    .map((i) => ({ ...i, platform: i.url ? matchPlatform(i.url) : null }))
    .filter((i) => i.platform && kinds.includes(i.platform.kind));
  const textAnchors = items.filter((i) => i.kind === 'anchor' && (textRe.test(i.text) || (i.text.toLowerCase() === 'order' && textRe === ORDER_TEXT)));
  const phoneCta = textAnchors.filter((a) => a.scheme === 'tel');
  const linkAnchors = textAnchors.filter((a) => a.url && !matchPlatform(a.url));
  const corroborated = [], ambiguous = [], external = [];
  for (const a of linkAnchors) {
    if (!sameSite(a.url, a.page)) { external.push(a); continue; }
    const tp = targetPage(ctx.crawl, a.url);
    if (tp && corroborate(tp)) corroborated.push({ ...a, target: tp.finalUrl });
    else ambiguous.push({ ...a, target: tp ? tp.finalUrl : null, target_crawled: !!tp });
  }
  return { platformHits, corroborated, external, ambiguous, phoneCta };
}

const pageHasPlatform = (p, kinds) => [
  ...p.parsed.links.map((l) => l.resolved), ...p.parsed.iframes.map((f) => f.resolved), ...p.parsed.scripts.map((s) => s.resolved),
].some((u) => { const m = u && matchPlatform(u); return m && kinds.includes(m.kind); });
const pageHasDateTimeInputs = (p) => p.parsed.forms.some((f) => f.inputs.some((i) => ['date', 'time', 'datetime-local'].includes(i.type)));

const corroborateOrder = (p) => CHECKOUT_RE.test(p.parsed.text) || p.parsed.forms.some((f) => /cart|checkout/i.test(f.action)) || pageHasPlatform(p, ['direct_ordering', 'marketplace']);
const corroborateBooking = (p) => pageHasDateTimeInputs(p) || BOOKING_PAGE_RE.test(p.parsed.text) || pageHasPlatform(p, ['booking']);
const corroborateReservation = (p) => pageHasPlatform(p, ['reservation']) || (pageHasDateTimeInputs(p) && PARTY_RE.test(p.parsed.text));

const phoneCtaEv = (ev) => ev.phoneCta.map((a) => ({ page: a.page, text: a.text, href: a.href }));

function orderingChecks(ctx) {
  const types = ['online_ordering', 'direct_ordering', 'third_party_ordering'];
  const out = [];
  const skip = types.filter((t) => notApplicableFeature(ctx, t));
  if (skip.length) return types.map((t) => naProfile(ctx, t));
  if (noSite(ctx)) {
    return [
      unknownNoSite('online_ordering', 'ordering may exist on third-party platforms; not inspected'),
      { type: 'direct_ordering', result: 'no', confidence: ctx.wsConfidence, method: 'derived', derivedFrom: 'website_present', evidenceUrl: ctx.noSiteEvidenceUrl, evidence: { basis: 'no_dedicated_website_so_no_direct_ordering' } },
      unknownNoSite('third_party_ordering', 'third-party marketplaces not inspected'),
    ];
  }
  if (ctx.state.kind !== 'ok') return types.map((t) => unknownNotFetched(ctx, t));

  const ev = evaluateFeature(ctx, { kinds: ['direct_ordering', 'marketplace'], textRe: ORDER_TEXT, corroborate: corroborateOrder });
  const direct = ev.platformHits.filter((h) => h.platform.kind === 'direct_ordering');
  const market = ev.platformHits.filter((h) => h.platform.kind === 'marketplace');
  const anyYes = direct.length || market.length || ev.corroborated.length || ev.external.length;
  const platforms = [...new Set([...direct, ...market].map((h) => h.platform.name))];

  // online_ordering (any)
  if (anyYes) {
    const first = direct[0] ?? ev.corroborated[0] ?? market[0] ?? ev.external[0];
    const conf = direct[0] ? 0.9 : ev.corroborated[0] ? 0.8 : market[0] ? 0.85 : 0.7;
    out.push({
      type: 'online_ordering', result: 'yes', confidence: conf, evidenceUrl: first.page, excerpt: first.html,
      evidence: { signals: [...direct, ...market].map(hitEv).slice(0, 6).concat(ev.corroborated.map((a) => ({ signal: 'internal_order_page_with_checkout', url: a.target, page: a.page })), ev.external.map((a) => ({ signal: 'order_link_unrecognised_host', url: a.url, page: a.page, text: a.text }))).slice(0, 8), platforms },
    });
  } else if (ev.ambiguous.length) {
    out.push({ type: 'online_ordering', result: 'unknown', evidence: { reason: 'order_link_found_but_unverified', links: ev.ambiguous.map((a) => ({ page: a.page, url: a.url, text: a.text, target_crawled: a.target_crawled })), transient: false } });
  } else if (ctx.conclusive) {
    out.push({
      type: 'online_ordering', result: 'no', confidence: 0.8, evidenceUrl: ctx.crawl.home.finalUrl,
      evidence: scopeEvidence(ctx, { signals_searched: ['ordering_platform_links', 'order_now_links', 'checkout_forms'], phone_order_cta: phoneCtaEv(ev), note: ev.phoneCta.length ? 'ordering appears to be phone-based' : undefined }),
    });
  } else {
    out.push({ type: 'online_ordering', result: 'unknown', evidence: inconclusiveEvidence(ctx) });
  }

  // direct_ordering
  if (direct.length || ev.corroborated.length) {
    const first = direct[0] ?? ev.corroborated[0];
    out.push({ type: 'direct_ordering', result: 'yes', confidence: direct[0] ? 0.85 : 0.75, evidenceUrl: first.page, excerpt: first.html, evidence: { signals: direct.map(hitEv).concat(ev.corroborated.map((a) => ({ signal: 'internal_order_page_with_checkout', url: a.target }))).slice(0, 6) } });
  } else if (ev.external.length || ev.ambiguous.length) {
    out.push({ type: 'direct_ordering', result: 'unknown', evidence: { reason: 'ordering_link_platform_unrecognised_or_unverified', links: [...ev.external, ...ev.ambiguous].map((a) => ({ page: a.page, url: a.url, text: a.text })).slice(0, 5), transient: false } });
  } else if (ctx.conclusive) {
    out.push({ type: 'direct_ordering', result: 'no', confidence: 0.75, evidenceUrl: ctx.crawl.home.finalUrl, evidence: scopeEvidence(ctx, { basis: market.length ? 'only_third_party_marketplaces_found' : 'no_ordering_signals_found', marketplaces: [...new Set(market.map((h) => h.platform.name))] }) });
  } else {
    out.push({ type: 'direct_ordering', result: 'unknown', evidence: inconclusiveEvidence(ctx) });
  }

  // third_party_ordering
  if (market.length) {
    out.push({ type: 'third_party_ordering', result: 'yes', confidence: 0.9, evidenceUrl: market[0].page, excerpt: market[0].html, evidence: { platforms: [...new Set(market.map((h) => h.platform.name))], signals: market.map(hitEv).slice(0, 6) } });
  } else if (ev.external.length) {
    out.push({ type: 'third_party_ordering', result: 'unknown', evidence: { reason: 'unrecognised_ordering_host_may_be_a_marketplace', links: ev.external.map((a) => ({ page: a.page, url: a.url })).slice(0, 5), transient: false } });
  } else if (ctx.conclusive) {
    out.push({ type: 'third_party_ordering', result: 'no', confidence: 0.75, evidenceUrl: ctx.crawl.home.finalUrl, evidence: scopeEvidence(ctx, { marketplaces_searched: ['Uber Eats', 'DoorDash', 'Grubhub', 'Postmates', 'Slice'] }) });
  } else {
    out.push({ type: 'third_party_ordering', result: 'unknown', evidence: inconclusiveEvidence(ctx) });
  }
  return out;
}

function bookingLike(ctx, type, { kinds, textRe, corroborate, label }) {
  if (notApplicableFeature(ctx, type)) return naProfile(ctx, type);
  if (noSite(ctx)) return unknownNoSite(type, `${label} may exist on a third-party platform; not inspected`);
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  const ev = evaluateFeature(ctx, { kinds, textRe, corroborate });
  const hit = ev.platformHits[0] ?? ev.corroborated[0] ?? ev.external[0];
  if (hit) {
    const conf = ev.platformHits[0] ? 0.9 : ev.corroborated[0] ? 0.8 : 0.7;
    return {
      type, result: 'yes', confidence: conf, evidenceUrl: hit.page, excerpt: hit.html,
      evidence: {
        signals: ev.platformHits.map(hitEv).concat(ev.corroborated.map((a) => ({ signal: 'internal_page_with_booking_inputs', url: a.target })), ev.external.map((a) => ({ signal: 'link_unrecognised_host', url: a.url, text: a.text }))).slice(0, 6),
        platforms: [...new Set(ev.platformHits.map((h) => h.platform.name))],
      },
    };
  }
  if (ev.ambiguous.length) {
    return { type, result: 'unknown', evidence: { reason: `${label}_link_found_but_unverified`, links: ev.ambiguous.map((a) => ({ page: a.page, url: a.url, text: a.text, target_crawled: a.target_crawled })), transient: false } };
  }
  if (ctx.conclusive) {
    return {
      type, result: 'no', confidence: 0.75, evidenceUrl: ctx.crawl.home.finalUrl,
      evidence: scopeEvidence(ctx, { signals_searched: [`${label}_platform_links`, `${label}_links`, 'date_time_forms'], phone_cta: phoneCtaEv(ev), note: ev.phoneCta.length ? `${label} appears to be phone-based` : undefined }),
    };
  }
  return { type, result: 'unknown', evidence: inconclusiveEvidence(ctx) };
}

const onlineBooking = (ctx) => bookingLike(ctx, 'online_booking', { kinds: ['booking'], textRe: BOOK_TEXT, corroborate: corroborateBooking, label: 'booking' });
const reservations = (ctx) => bookingLike(ctx, 'reservations', { kinds: ['reservation'], textRe: RESERVE_TEXT, corroborate: corroborateReservation, label: 'reservation' });

function onlineMenu(ctx) {
  const type = 'online_menu';
  if (notApplicableFeature(ctx, type)) return naProfile(ctx, type);
  if (noSite(ctx)) return unknownNoSite(type, 'menu may exist on social media or a third-party platform; not inspected');
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);

  const priced = ctx.crawl.pages
    .map((p) => ({ p, prices: (p.parsed.text.match(PRICE_RE) || []).length }))
    .filter((x) => x.prices >= 6)
    .sort((a, b) => b.prices - a.prices);
  if (priced.length) {
    const { p, prices } = priced[0];
    const i = p.parsed.text.search(PRICE_RE);
    return {
      type, result: 'yes', confidence: 0.85, evidenceUrl: p.finalUrl,
      excerpt: p.parsed.text.slice(Math.max(0, i - 60), i + 160),
      evidence: { signal: 'html_menu_with_prices', page: p.finalUrl, price_count: prices, other_pages: priced.slice(1).map((x) => x.p.finalUrl) },
    };
  }
  const items = resources(ctx.crawl);
  const platformMenu = items.map((i) => ({ ...i, platform: i.url ? matchPlatform(i.url) : null }))
    .filter((i) => i.platform && ['menu', 'direct_ordering'].includes(i.platform.kind));
  if (platformMenu.length) {
    const h = platformMenu[0];
    return { type, result: 'yes', confidence: 0.7, evidenceUrl: h.page, excerpt: h.html, evidence: { signal: 'menu_viewable_on_platform', platform: h.platform.name, url: h.url } };
  }
  const pdfs = items.filter((i) => i.kind === 'anchor' && i.url && /\.pdf(\?|#|$)/i.test(i.url) && /menu/i.test(`${i.url} ${i.text}`));
  if (pdfs.length) {
    return {
      type, result: ctx.conclusive ? 'no' : 'unknown', confidence: ctx.conclusive ? 0.8 : undefined,
      evidenceUrl: pdfs[0].page, excerpt: pdfs[0].html,
      evidence: ctx.conclusive
        ? scopeEvidence(ctx, { signal: 'menu_only_as_pdf', pdf_urls: pdfs.map((x) => x.url).slice(0, 5) })
        : { ...inconclusiveEvidence(ctx), pdf_urls: pdfs.map((x) => x.url).slice(0, 5) },
    };
  }
  if (ctx.conclusive) {
    return { type, result: 'no', confidence: 0.65, evidenceUrl: ctx.crawl.home.finalUrl, evidence: scopeEvidence(ctx, { signal: 'no_menu_found', limitation: 'text-based; looks for 6+ US-dollar prices, menu platforms and menu PDFs - menus published only as images are not detected' }) };
  }
  return { type, result: 'unknown', evidence: inconclusiveEvidence(ctx) };
}

function contactForm(ctx) {
  const type = 'contact_form';
  if (noSite(ctx)) {
    return { type, result: 'no', confidence: ctx.wsConfidence, method: 'derived', derivedFrom: 'website_present', evidenceUrl: ctx.noSiteEvidenceUrl, evidence: { basis: 'no_dedicated_website_so_no_contact_form' } };
  }
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  for (const p of ctx.crawl.pages) {
    for (const f of p.parsed.forms) {
      const blob = `${f.text} ${f.action} ${f.inputs.map((i) => `${i.name} ${i.placeholder}`).join(' ')}`;
      const hasEmail = f.inputs.some((i) => i.type === 'email' || /e-?mail/i.test(i.name));
      const looksNoise = /search|log ?in|sign ?in|password|newsletter|subscribe/i.test(blob);
      const isContact = (f.textareas > 0 && !/search|log ?in|password/i.test(blob)) ||
        (hasEmail && f.hasSubmit && !looksNoise && f.inputs.filter((i) => ['text', 'tel', 'email'].includes(i.type)).length >= 2);
      if (isContact) {
        return {
          type, result: 'yes', confidence: f.textareas > 0 ? 0.85 : 0.75, evidenceUrl: p.finalUrl, excerpt: `${f.openTag} (${f.inputs.length} inputs, ${f.textareas} textarea)`,
          evidence: { signal: 'html_form', page: p.finalUrl, inputs: f.inputs.length, textareas: f.textareas, action: (f.action || '').split('?')[0] || null },
        };
      }
    }
  }
  const embeds = resources(ctx.crawl).map((i) => ({ ...i, platform: i.url ? matchPlatform(i.url) : null })).filter((i) => i.platform?.kind === 'form' && i.kind !== 'anchor');
  if (embeds.length) return { type, result: 'yes', confidence: 0.8, evidenceUrl: embeds[0].page, excerpt: embeds[0].html, evidence: { signal: 'embedded_form', platform: embeds[0].platform.name, url: embeds[0].url } };
  if (ctx.conclusive) return { type, result: 'no', confidence: 0.75, evidenceUrl: ctx.crawl.home.finalUrl, evidence: scopeEvidence(ctx, { signal: 'no_contact_or_quote_form_found' }) };
  return { type, result: 'unknown', evidence: inconclusiveEvidence(ctx) };
}

// ------------------------------------------- quality / presentation checks
// These are heuristics over static markup. They are deliberately conservative:
// a 'yes'/'no' needs concrete, listed signals; anything mixed or JS-only is 'unknown'.

const LANDMARKS = ['header', 'nav', 'main', 'footer', 'section', 'article', 'aside'];

function copyrightYear(text) {
  let latest = null;
  for (const m of text.matchAll(/(?:©|copyright|\(c\))\s*(?:(?:19|20)\d{2}\s*[-–—]\s*)?((?:19|20)\d{2})/gi)) {
    const y = Number(m[1]);
    if (latest === null || y > latest) latest = y;
  }
  return latest;
}

function websiteModern(ctx) {
  const type = 'website_modern';
  if (noSite(ctx)) return naNoSite(type);
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  const home = ctx.crawl.home;
  const p = home.parsed;
  if (home.jsShell) return { type, result: 'unknown', evidence: { reason: 'js_rendered_page_markup_not_assessable', page: home.finalUrl, transient: false } };

  const L = p.legacy;
  const hard = [];
  const soft = [];
  if (L.flash) hard.push({ indicator: 'flash_embed', count: L.flash });
  if (L.frames) hard.push({ indicator: 'html_frames', count: L.frames });
  if (L.marquee + L.blink) hard.push({ indicator: 'marquee_or_blink', count: L.marquee + L.blink });
  const presentational = L.fontTags + L.centerTags + L.bgcolorAttrs;
  if (presentational >= 3) soft.push({ indicator: 'deprecated_presentational_markup', count: presentational });
  if (p.doctype && /public/i.test(p.doctype) && /html 4|xhtml 1|html 3/i.test(p.doctype)) soft.push({ indicator: 'legacy_doctype', doctype: p.doctype });
  else if (!p.doctype && p.isHtmlDocument) soft.push({ indicator: 'no_doctype_quirks_mode' });
  const landmarkCount = LANDMARKS.reduce((n, t) => n + (p.tagCounts[t] || 0), 0);
  if ((p.tagCounts.table || 0) >= 5 && landmarkCount === 0) soft.push({ indicator: 'table_based_layout', tables: p.tagCounts.table });
  const year = copyrightYear(p.text);
  const yearNow = ctx.now.getUTCFullYear();
  if (year !== null && yearNow - year >= 4) soft.push({ indicator: 'stale_copyright_year', latest_year: year });

  const viewport = p.metas.find((m) => (m.name || '').toLowerCase() === 'viewport');
  const modernSignals = [
    /^<!doctype html>$/i.test((p.doctype || '').trim()) && 'html5_doctype',
    viewport && /device-width/i.test(viewport.content || '') && 'responsive_viewport',
    landmarkCount >= 2 && 'semantic_landmarks',
    p.hasCharset && 'charset_declared',
    home.finalUrl.startsWith('https://') && 'https',
  ].filter(Boolean);

  const evidenceBase = { page: home.finalUrl, modern_signals: modernSignals, limitation: 'markup-level signals only; visual design is not assessed' };
  const excerptText = p.doctype || null;
  if (hard.length >= 1 || soft.length >= 2) {
    return { type, result: 'no', confidence: hard.length ? 0.85 : 0.7, evidenceUrl: home.finalUrl, excerpt: excerptText, evidence: { ...evidenceBase, outdated_indicators: [...hard, ...soft] } };
  }
  if (soft.length === 0 && modernSignals.length >= 4) {
    return { type, result: 'yes', confidence: 0.6, evidenceUrl: home.finalUrl, excerpt: excerptText, evidence: { ...evidenceBase, outdated_indicators: [], latest_copyright_year: year } };
  }
  return { type, result: 'unknown', evidence: { ...evidenceBase, reason: 'mixed_or_insufficient_signals', outdated_indicators: soft, transient: false } };
}

function clearCta(ctx) {
  const type = 'clear_cta';
  if (noSite(ctx)) return naNoSite(type);
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  const home = ctx.crawl.home;
  const page = ctx.crawl.pages[0];
  const p = page.parsed;
  if (home.jsShell || page.truncated) return { type, result: 'unknown', evidence: { reason: home.jsShell ? 'js_rendered_page' : 'page_truncated', page: home.finalUrl, transient: false } };

  const cands = [];
  const consider = (el, kind, text, html, isTel) => {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    const strong = isTel || CTA_STRONG.test(t);
    const weak = !strong && CTA_WEAK.test(t);
    if (!strong && !weak) return;
    cands.push({ kind, text: t.slice(0, 60), strength: strong ? 'strong' : 'weak', prominent: !!(el.inHeader || el.inNav || el.index < 25), html, index: el.index });
  };
  for (const l of p.links) consider(l, 'link', l.text, `${l.openTag}${l.text.trim().slice(0, 60)}</a>`, l.scheme === 'tel');
  for (const b of p.buttons) consider(b, 'button', b.text, `${b.openTag}${b.text.trim().slice(0, 60)}</button>`, false);
  const hasPlatformLink = resources({ pages: [page] }).some((i) => i.url && ['direct_ordering', 'booking', 'reservation'].includes(matchPlatform(i.url)?.kind));

  const strongProminent = cands.find((c) => c.strength === 'strong' && c.prominent);
  const weakProminent = cands.find((c) => c.prominent);
  if (strongProminent || weakProminent) {
    const c = strongProminent || weakProminent;
    return {
      type, result: 'yes', confidence: c.strength === 'strong' ? 0.8 : 0.6, evidenceUrl: home.finalUrl, excerpt: c.html,
      evidence: { page: home.finalUrl, cta: { kind: c.kind, text: c.text, strength: c.strength, position: c.index }, total_cta_candidates: cands.length, rule: 'action link/button in header/nav or among the first 25 links', limitation: 'text-based detection' },
    };
  }
  if (cands.length || hasPlatformLink) {
    return { type, result: 'unknown', evidence: { reason: 'cta_present_but_not_obviously_placed', page: home.finalUrl, candidates: cands.slice(0, 5).map(({ html, ...r }) => r), transient: false } };
  }
  return {
    type, result: 'no', confidence: 0.6, evidenceUrl: home.finalUrl,
    evidence: { page: home.finalUrl, links_scanned: p.links.length, buttons_scanned: p.buttons.length, limitation: 'text-based detection; image-only buttons and script-injected CTAs are not detected' },
  };
}

function goodNavigation(ctx) {
  const type = 'good_navigation';
  if (noSite(ctx)) return naNoSite(type);
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  const home = ctx.crawl.home;
  const p = ctx.crawl.pages[0].parsed;
  if (home.jsShell) return { type, result: 'unknown', evidence: { reason: 'js_rendered_page', page: home.finalUrl, transient: false } };

  const internalLabelled = (l) => l.resolved && sameSite(l.resolved, home.finalUrl) && l.text.trim().length > 0 && l.text.trim().length <= 40;
  const navLinks = p.links.filter((l) => l.inNav);
  const headerLinks = p.links.filter((l) => l.inHeader);
  const pool = navLinks.length ? navLinks : headerLinks;
  const source = navLinks.length ? 'nav_element' : headerLinks.length ? 'header_element' : null;
  const labelled = pool.filter(internalLabelled);
  const labels = [...new Set(labelled.map((l) => l.text.trim().replace(/\s+/g, ' ')))];
  const unlabelled = pool.filter((l) => l.resolved && sameSite(l.resolved, home.finalUrl) && !l.text.trim()).length;

  if (source && labels.length >= 3 && labels.length <= 12 && unlabelled === 0) {
    return { type, result: 'yes', confidence: 0.65, evidenceUrl: home.finalUrl, evidence: { page: home.finalUrl, source, labels, rule: '3-12 labelled internal links in nav/header, none unlabelled', limitation: 'structure only; usability not tested' } };
  }
  const internalTotal = p.links.filter(internalLabelled).length;
  if (!source && internalTotal < 3) {
    return { type, result: 'no', confidence: 0.7, evidenceUrl: home.finalUrl, evidence: { page: home.finalUrl, nav_landmark: false, header_links: 0, labelled_internal_links: internalTotal, rule: 'no nav/header links and fewer than 3 labelled internal links on the page' } };
  }
  return { type, result: 'unknown', evidence: { reason: 'navigation_not_clearly_good_or_bad', page: home.finalUrl, source, label_count: labels.length, unlabelled_links: unlabelled, transient: false } };
}

function jsonLdFind(nodes, keys) {
  const hits = {};
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (keys.includes(k) && v) hits[k] = true;
        walk(v);
      }
    }
  };
  nodes.forEach(walk);
  return hits;
}

function hoursAndLocation(ctx) {
  const type = 'hours_and_location';
  if (noSite(ctx)) return naNoSite(type);
  if (ctx.state.kind !== 'ok') return unknownNotFetched(ctx, type);
  const hours = { found: false };
  const location = { found: false };
  for (const pg of ctx.crawl.pages) {
    const p = pg.parsed;
    const ld = [];
    for (const raw of p.jsonLd) { try { ld.push(JSON.parse(raw)); } catch { /* ignore malformed JSON-LD */ } }
    const ldHits = jsonLdFind(ld, ['openingHours', 'openingHoursSpecification', 'address']);
    if (!hours.found && (ldHits.openingHours || ldHits.openingHoursSpecification)) Object.assign(hours, { found: true, signal: 'json_ld_opening_hours', page: pg.finalUrl });
    if (!hours.found) {
      for (const re of HOURS_RES) {
        const m = p.text.match(re);
        if (m) { Object.assign(hours, { found: true, signal: 'hours_text', page: pg.finalUrl, snippet: m[0] }); break; }
      }
    }
    if (!location.found && ldHits.address) Object.assign(location, { found: true, signal: 'json_ld_address', page: pg.finalUrl });
    if (!location.found && p.tagCounts.address) Object.assign(location, { found: true, signal: 'address_element', page: pg.finalUrl });
    if (!location.found && STREET_RE.test(p.text)) Object.assign(location, { found: true, signal: 'street_address_with_state_zip', page: pg.finalUrl });
    if (!location.found) {
      const mapItem = resources({ pages: [pg] }).find((i) => i.url && i.kind !== 'link' && i.kind !== 'script' && (MAP_HOST.test(hostOf(i.url) || '') || /google\.[a-z.]+\/maps/i.test(i.url)));
      if (mapItem) Object.assign(location, { found: true, signal: 'map_link_or_embed', page: pg.finalUrl });
    }
  }
  // NOTE: address text is intentionally not stored, only the signal and the page.
  const present = { hours: hours.found, location: location.found };
  const evidence = { present, hours: hours.found ? { signal: hours.signal, page: hours.page } : null, location: location.found ? { signal: location.signal, page: location.page } : null };
  if (hours.found && location.found) {
    return { type, result: 'yes', confidence: 0.8, evidenceUrl: hours.page, excerpt: hours.snippet ?? null, evidence };
  }
  if (ctx.conclusive) {
    return {
      type, result: 'no', confidence: 0.6, evidenceUrl: ctx.crawl.home.finalUrl,
      evidence: scopeEvidence(ctx, { ...evidence, limitation: 'text-based detection; hours or address shown only in images/embedded widgets are not detected' }),
    };
  }
  return { type, result: 'unknown', evidence: { ...inconclusiveEvidence(ctx), present } };
}

// ------------------------------------------------------------------- main

export function runDetectors({ listing, profile, crawl, now = new Date() }) {
  const state = classifySite(listing, crawl);
  const ctx = { listing, profile, crawl, state, now, conclusive: state.kind === 'ok' && isConclusive(crawl) };
  // Website-absence details reused by derived checks.
  ctx.noSiteEvidenceUrl = state.kind === 'social_only' ? state.listedUrl : (listing.source_url || null);
  ctx.wsConfidence = state.kind === 'social_only' ? 0.9 : 0.6;

  const ordering = orderingChecks(ctx);
  const byType = {
    website_present: websitePresent(ctx),
    website_reachable: websiteReachable(ctx),
    mobile_friendly: mobileFriendly(ctx),
    website_modern: websiteModern(ctx),
    clear_cta: clearCta(ctx),
    good_navigation: goodNavigation(ctx),
    hours_and_location: hoursAndLocation(ctx),
    online_menu: onlineMenu(ctx),
    online_ordering: ordering.find((d) => d.type === 'online_ordering'),
    direct_ordering: ordering.find((d) => d.type === 'direct_ordering'),
    third_party_ordering: ordering.find((d) => d.type === 'third_party_ordering'),
    online_booking: onlineBooking(ctx),
    reservations: reservations(ctx),
    contact_form: contactForm(ctx),
  };
  return { state, conclusive: ctx.conclusive, drafts: Object.values(byType) };
}
