// Bounded, polite crawl of ONE business website: homepage + a few same-site pages
// that could hold the features we check (menu, order, booking, reservations, contact).
import { httpGetWithRetry, httpGet, parseRobots, robotsAllows } from './http.js';
import { parseHtml } from './html.js';
import { ROBOTS_TOKEN } from './constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CATEGORY_RULES = [
  ['menu', /menu|dishes|our-food|food-drink/i],
  ['order', /order|pickup|pick-up|delivery|takeout|take-out|catering/i],
  ['reservation', /reserv|book-a-table/i],
  ['booking', /book|appointment|schedule/i],
  ['contact', /contact|quote|get-in-touch|location|visit|hours|find-us|directions/i],
];

const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)(\?|#|$)/i;

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

function sameSite(a, b) {
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, '');
    const hb = new URL(b).hostname.toLowerCase().replace(/^www\./, '');
    return ha === hb;
  } catch { return false; }
}

export function categorize(link) {
  const hay = `${link.resolved ? new URL(link.resolved).pathname : ''} ${link.text}`;
  return CATEGORY_RULES.filter(([, re]) => re.test(hay)).map(([c]) => c);
}

function priorityCategories(profile) {
  const a = profile.known ? profile.applies : { menu: true, ordering: true, booking: true, reservations: true };
  const order = [];
  if (a.menu) order.push('menu');
  if (a.ordering) order.push('order');
  if (a.reservations) order.push('reservation');
  if (a.booking) order.push('booking');
  order.push('contact');
  return order;
}

function classifyPage(res) {
  const ctype = res.contentType || '';
  const looksHtml = /html|xml/i.test(ctype) || (!ctype && /<html|<body|<!doctype/i.test(res.body));
  const pageOk = res.ok && res.status >= 200 && res.status < 300;
  return { pageOk, isHtml: pageOk && looksHtml && !res.skippedBody };
}

export async function crawlSite({ websiteUrl, profile, http = {}, respectRobots = true, maxPages = 6, crawlDelayMs = 250, deadlineMs = 20_000 }) {
  const httpOpts = { ...http };
  const deadlineAt = Date.now() + deadlineMs;
  const crawl = {
    startUrl: websiteUrl, assumedScheme: false, home: null, pages: [], failures: [], robotsBlocked: [],
    skippedCandidates: [], inconclusiveReasons: [], robots: null,
  };

  let start = String(websiteUrl).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(start)) { start = 'https://' + start; crawl.assumedScheme = true; }
  crawl.startUrl = start;

  // ---- robots.txt for the start origin (checked before any page is fetched)
  const robotsCache = new Map();
  async function robotsFor(url) {
    if (!respectRobots) return null;
    const origin = new URL(url).origin;
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    const r = await httpGet(origin + '/robots.txt', { ...httpOpts, maxBytes: 200_000 });
    let rules = [];
    let status = 'none';
    if (r.ok && r.status >= 200 && r.status < 300) { rules = parseRobots(r.body, ROBOTS_TOKEN); status = 'applied'; }
    else if (r.ok && r.status >= 400 && r.status < 500) status = 'absent';
    else status = 'unavailable_allowing';
    const entry = { origin, rules, status };
    robotsCache.set(origin, entry);
    return entry;
  }
  async function allowed(url) {
    const entry = await robotsFor(url);
    if (!entry) return true;
    const u = new URL(url);
    return robotsAllows(entry.rules, u.pathname + u.search);
  }

  const homeAllowed = await allowed(start);
  crawl.robots = [...robotsCache.values()].map((r) => ({ origin: r.origin, status: r.status, rules: r.rules.length }));
  if (!homeAllowed) {
    crawl.home = { url: start, finalUrl: start, ok: false, blockedByRobots: true };
    crawl.robotsBlocked.push(start);
    crawl.inconclusiveReasons.push('robots_disallow_homepage');
    return crawl;
  }

  // ---- homepage
  let res = await httpGetWithRetry(start, httpOpts);
  if (crawl.assumedScheme && !res.ok && !['EBLOCKED', 'EBADURL'].includes(res.error?.code)) {
    const alt = 'http://' + start.slice('https://'.length);
    const res2 = await httpGetWithRetry(alt, httpOpts);
    crawl.schemeFallback = { tried: alt, ok: res2.ok };
    if (res2.ok) res = res2;
  }
  const home = { ...res, ...classifyPage(res), attempts: res.attempts };
  if (home.isHtml) {
    home.parsed = parseHtml(res.body, res.finalUrl);
    home.jsShell = home.parsed.isJsShell || !home.parsed.isHtmlDocument;
  }
  crawl.home = home;

  if (!home.isHtml) return crawl;
  crawl.pages.push({ url: start, finalUrl: res.finalUrl, status: res.status, parsed: home.parsed, jsShell: home.jsShell, truncated: res.truncated });

  if (home.jsShell) crawl.inconclusiveReasons.push('homepage_js_rendered');
  if (res.truncated) crawl.inconclusiveReasons.push('homepage_truncated');

  // ---- choose candidate pages from homepage links
  const wanted = priorityCategories(profile);
  const seen = new Set([normalizeUrl(res.finalUrl)]);
  const candidates = [];
  for (const link of home.parsed.links) {
    if (!link.resolved || !/^https?:/i.test(link.resolved)) continue;
    if (!sameSite(link.resolved, res.finalUrl) || FILE_EXT.test(link.resolved)) continue;
    const norm = normalizeUrl(link.resolved);
    if (!norm || seen.has(norm)) continue;
    const cats = categorize(link).filter((c) => wanted.includes(c));
    if (!cats.length) continue;
    seen.add(norm);
    candidates.push({ url: norm, rank: Math.min(...cats.map((c) => wanted.indexOf(c))), cats });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const chosen = candidates.slice(0, Math.max(0, maxPages - 1));
  crawl.skippedCandidates = candidates.slice(chosen.length).map((c) => c.url);
  if (crawl.skippedCandidates.length) crawl.inconclusiveReasons.push('candidate_cap_reached');

  // ---- fetch candidates (sequential + delay = polite)
  for (const c of chosen) {
    if (Date.now() + (httpOpts.timeoutMs ?? 10_000) > deadlineAt) {
      crawl.skippedCandidates.push(c.url);
      if (!crawl.inconclusiveReasons.includes('crawl_deadline_exceeded')) crawl.inconclusiveReasons.push('crawl_deadline_exceeded');
      continue;
    }
    if (!(await allowed(c.url))) {
      crawl.robotsBlocked.push(c.url);
      crawl.inconclusiveReasons.push(`robots_disallow:${new URL(c.url).pathname}`);
      continue;
    }
    if (crawlDelayMs) await sleep(crawlDelayMs);
    const r = await httpGetWithRetry(c.url, { ...httpOpts, attempts: 1 });
    const cls = classifyPage(r);
    if (!cls.isHtml) {
      crawl.failures.push({ url: c.url, status: r.status, error: r.error });
      crawl.inconclusiveReasons.push(`page_unavailable:${new URL(c.url).pathname}`);
      continue;
    }
    const parsed = parseHtml(r.body, r.finalUrl);
    const jsShell = parsed.isJsShell;
    crawl.pages.push({ url: c.url, finalUrl: r.finalUrl, status: r.status, parsed, jsShell, truncated: r.truncated, categories: c.cats });
    if (jsShell) crawl.inconclusiveReasons.push(`page_js_rendered:${new URL(c.url).pathname}`);
    if (r.truncated) crawl.inconclusiveReasons.push(`page_truncated:${new URL(c.url).pathname}`);
  }
  crawl.robots = [...robotsCache.values()].map((r) => ({ origin: r.origin, status: r.status, rules: r.rules.length }));
  return crawl;
}

/** A crawl is conclusive only when absence of a feature on inspected pages means something. */
export function isConclusive(crawl) {
  return !!(crawl && crawl.home?.isHtml && crawl.inconclusiveReasons.length === 0);
}
