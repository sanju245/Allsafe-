// Small helpers shared by the /api/analyze and /api/discover handlers.
import { timingSafeEqual } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const reply = (status, body) => ({ status, body });
export const fail = (status, code, message, extra = {}) => reply(status, { ok: false, error: { code, message, ...extra } });

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Bearer-token check shared by every pipeline endpoint. Fails closed when no key is configured.
 * Returns null when the caller is authorised, otherwise a ready-to-send error reply.
 */
export function checkBearer(headers, apiKey) {
  if (!apiKey) return fail(500, 'server_misconfigured', 'API key is not configured on the server');
  const auth = String(headers?.authorization ?? headers?.Authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !safeEqual(token, apiKey)) return fail(401, 'unauthorized', 'Missing or invalid bearer token');
  return null;
}
