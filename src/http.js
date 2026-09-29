// Minimal, dependency-free HTTP client for crawling untrusted sites safely:
//  - SSRF guard: blocks private / loopback / link-local targets at connect time
//    (DNS-rebinding safe) and for literal IPs. Tests opt in with allowPrivate.
//  - timeouts, response-size cap, manual redirect following (chain recorded)
//  - only reads text-like bodies
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { USER_AGENT } from './constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coded = (code, message) => Object.assign(new Error(message), { code });

export function isPrivateAddress(addr) {
  const a = String(addr).toLowerCase();
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return (
      p === 0 || p === 10 || p === 127 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 192 && q === 0) ||
      (p === 198 && (q === 18 || q === 19)) ||
      p >= 224
    );
  }
  if (net.isIPv6(a)) {
    if (a === '::' || a === '::1') return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') ||
      a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb');
  }
  return true; // not an IP we understand: treat as unsafe
}

function makeLookup(allowPrivate) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (!allowPrivate) {
        const bad = list.find((x) => isPrivateAddress(x.address));
        if (bad) return cb(coded('EBLOCKED', `blocked non-public address ${bad.address}`));
      }
      return cb(null, address, family);
    });
  };
}

function requestOnce(urlStr, o) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(coded('EBADURL', `invalid URL: ${urlStr}`)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(coded('EBADPROTO', `unsupported protocol ${u.protocol}`));
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!o.allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
      return reject(coded('EBLOCKED', `blocked non-public address ${host}`));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: host,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      agent: false,
      lookup: makeLookup(o.allowPrivate),
      ca: o.ca,
      rejectUnauthorized: true,
      headers: {
        'user-agent': o.userAgent,
        accept: o.accept,
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.8',
      },
    }, (res) => {
      const status = res.statusCode;
      const headers = res.headers;
      const ctype = String(headers['content-type'] || '');
      const readable = !ctype || /^(text\/|application\/(xhtml\+xml|xml|json))/i.test(ctype);
      if (!readable) {
        res.destroy();
        clearTimeout(deadline);
        return resolve({ status, headers, body: '', bytes: 0, truncated: false, contentType: ctype, skippedBody: true });
      }
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let bytes = 0;
      let done = false;
      const finish = (truncated) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        resolve({
          status, headers, body: Buffer.concat(chunks).toString('utf8'),
          bytes, truncated, contentType: ctype, skippedBody: false,
        });
      };
      stream.on('data', (c) => {
        chunks.push(c);
        bytes += c.length;
        if (bytes >= o.maxBytes) { finish(true); res.destroy(); }
      });
      stream.on('end', () => finish(false));
      stream.on('error', (e) => { if (!done) { done = true; clearTimeout(deadline); reject(e); } });
      res.on('error', (e) => { if (!done) { done = true; clearTimeout(deadline); reject(e); } });
    });
    const deadline = setTimeout(() => req.destroy(coded('ETIMEDOUT', `timed out after ${o.timeoutMs}ms`)), o.timeoutMs);
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.end();
  });
}

/** One logical GET with redirects. Never throws: transport problems are returned in `error`. */
export async function httpGet(rawUrl, opts = {}) {
  const o = {
    timeoutMs: 10_000, maxBytes: 1_000_000, maxRedirects: 5, allowPrivate: false,
    userAgent: USER_AGENT, ca: undefined,
    accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,*/*;q=0.3',
    ...opts,
  };
  const started = Date.now();
  const redirects = [];
  let current = rawUrl;
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    let res;
    try {
      res = await requestOnce(current, o);
    } catch (err) {
      return {
        ok: false, url: rawUrl, finalUrl: current, status: null, headers: {}, body: '',
        bytes: 0, truncated: false, contentType: '', redirects,
        error: { code: err.code || 'EUNKNOWN', message: String(err.message || err) },
        durationMs: Date.now() - started,
      };
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      let next;
      try { next = new URL(res.headers.location, current).toString(); }
      catch { next = null; }
      if (!next) break;
      redirects.push({ from: current, to: next, status: res.status });
      if (hop === o.maxRedirects) {
        return {
          ok: false, url: rawUrl, finalUrl: current, status: res.status, headers: res.headers, body: '',
          bytes: 0, truncated: false, contentType: '', redirects,
          error: { code: 'EMAXREDIRECTS', message: `more than ${o.maxRedirects} redirects` },
          durationMs: Date.now() - started,
        };
      }
      current = next;
      continue;
    }
    return {
      ok: true, url: rawUrl, finalUrl: current, status: res.status, headers: res.headers,
      body: res.body, bytes: res.bytes, truncated: res.truncated, contentType: res.contentType,
      skippedBody: res.skippedBody, redirects, error: null, durationMs: Date.now() - started,
    };
  }
  return {
    ok: false, url: rawUrl, finalUrl: current, status: null, headers: {}, body: '', bytes: 0,
    truncated: false, contentType: '', redirects,
    error: { code: 'EREDIRECT', message: 'redirect without usable Location header' },
    durationMs: Date.now() - started,
  };
}

const TRANSIENT = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);

/** GET with a small retry for transient failures (timeouts, resets, 5xx). */
export async function httpGetWithRetry(url, opts = {}) {
  const attempts = opts.attempts ?? 2;
  let last;
  let n = 0;
  for (; n < attempts; n++) {
    last = await httpGet(url, opts);
    const transient = last.error ? TRANSIENT.has(last.error.code) : last.status >= 500;
    if (!transient) { n++; break; }
    if (n < attempts - 1) await sleep(opts.retryDelayMs ?? 1500);
  }
  return { ...last, attempts: Math.min(n, attempts) };
}

// ---------------------------------------------------------------- robots.txt

export function parseRobots(text, token) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', pattern: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const tok = String(token).toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && tok.includes(a)));
  const star = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length ? specific : star;
  return chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
}

function patternToRegExp(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function robotsAllows(rules, pathWithQuery) {
  let best = null;
  for (const r of rules) {
    if (!patternToRegExp(r.pattern).test(pathWithQuery)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}
