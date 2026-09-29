// Netlify Function (v2)  ->  POST /api/discover
import { discoverHandlerFromEnv } from '../../src/api/bootstrap.js';

export const config = { path: '/api/discover' };

export default async (req) => {
  try {
    const raw = req.method === 'POST' ? await req.text() : '';
    const out = await discoverHandlerFromEnv()({ method: req.method, headers: Object.fromEntries(req.headers), rawBody: raw });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json', ...(out.headers || {}) } });
  } catch (err) {
    console.error('[discover] startup error:', err.message);
    return new Response(JSON.stringify({ ok: false, error: { code: 'server_misconfigured', message: 'Server is not configured' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
};
