import { randomUUID } from 'node:crypto';
import { CHECK_TYPES, RESULTS, CHECKER_VERSION } from './constants.js';

// ---- privacy: nothing that looks like a personal contact detail is ever stored.
const REDACTIONS = [
  [/\b(tel|mailto|sms|whatsapp):[^\s"'<>]*/gi, '$1:[redacted]'],
  [/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi, '[redacted-email]'],
  [/\(\d{3}\)\s?\d{3}[-.\s]\d{4}/g, '[redacted-phone]'],
  [/(?<![\d$])(?:\+?\d{1,2}[-.\s])?\d{3}[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g, '[redacted-phone]'],
  [/(?<![\d$.])\d{10,15}(?!\d)/g, '[redacted-number]'],
];

export function redact(text) {
  let s = String(text);
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  return s;
}

export function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

export function excerpt(text, max = 300) {
  if (text == null) return null;
  // eslint-disable-next-line no-control-regex
  const s = redact(String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Mirrors the SQL constraint checks_evidence_required. */
export function hasEvidence(row) {
  return row.evidence_url != null || row.evidence_excerpt != null ||
    (row.evidence && Object.keys(row.evidence).length > 0);
}

/**
 * Build one row for public.checks.
 *
 * Rules (never guess):
 *  - A 'yes' / 'no' MUST cite an evidence_url. If it cannot, it is stored as
 *    'unknown' and the attempted result is preserved in evidence.downgraded.
 *  - 'unknown' and 'not_applicable' may carry evidence (the reason) but do not need a URL.
 */
export function makeCheck(d) {
  if (!CHECK_TYPES.includes(d.type)) throw new Error(`unknown check_type: ${d.type}`);
  if (!RESULTS.includes(d.result)) throw new Error(`invalid result: ${d.result}`);

  let result = d.result;
  const evidence = redactDeep({ ...(d.evidence || {}) });
  const evidenceUrl = d.evidenceUrl ?? null;

  if ((result === 'yes' || result === 'no') && !evidenceUrl) {
    evidence.downgraded = { from: result, reason: 'missing_evidence_url' };
    result = 'unknown';
  }

  const confidence = result === 'unknown' || result === 'not_applicable' ? null : (d.confidence ?? null);

  return {
    id: d.id ?? randomUUID(),
    owner_id: d.ownerId ?? null,
    business_id: d.businessId ?? null,
    check_type: d.type,
    result,
    confidence,
    evidence_url: evidenceUrl,
    evidence_excerpt: excerpt(d.excerpt),
    evidence,
    method: d.method ?? 'http_crawl',
    checker_version: CHECKER_VERSION,
    http_status: d.httpStatus ?? null,
    error: d.error ?? null,
    checked_at: (d.checkedAt instanceof Date ? d.checkedAt : new Date(d.checkedAt ?? Date.now())).toISOString(),
    expires_at: d.expiresAt ?? null,
    is_current: true,
  };
}
