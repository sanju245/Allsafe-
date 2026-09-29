import { DAY_MS } from './constants.js';

/**
 * Mirrors public.campaign_business_needs_reanalysis():
 * a required check is stale when it is missing, past its own expires_at, or
 * (no expires_at) older than the campaign's stale_after_days.
 */
export function staleAt(check, staleAfterDays) {
  if (check.expires_at) return new Date(check.expires_at);
  return new Date(new Date(check.checked_at).getTime() + staleAfterDays * DAY_MS);
}

export function needsReanalysis({ requiredChecks, currentChecks, staleAfterDays, now = new Date() }) {
  const byType = new Map();
  for (const c of currentChecks) if (c.is_current) byType.set(c.check_type, c);
  const missing = [];
  const stale = [];
  for (const type of requiredChecks) {
    const c = byType.get(type);
    if (!c) missing.push(type);
    else if (staleAt(c, staleAfterDays) <= now) stale.push(type);
  }
  return { needs: missing.length + stale.length > 0, missing, stale };
}

// Results that deserve an earlier re-look than the campaign's normal window.
const SHORT_RECHECK_DAYS = { unreachable: 3, transient_unknown: 7 };

/**
 * Optional early-expiry override, or null to let the campaign window apply.
 * Only ever SHORTENS the window (a later change to stale_after_days still applies otherwise).
 */
export function expiryOverride({ result, checkType, evidence }, checkedAt, staleAfterDays) {
  let days = null;
  if (checkType === 'website_reachable' && result === 'no') days = SHORT_RECHECK_DAYS.unreachable;
  else if (result === 'unknown' && evidence?.transient) days = SHORT_RECHECK_DAYS.transient_unknown;
  if (days == null || days >= staleAfterDays) return null;
  return new Date(checkedAt.getTime() + days * DAY_MS).toISOString();
}
