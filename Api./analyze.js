// Vercel serverless function  ->  POST /api/analyze
import { handlerFromEnv } from '../src/api/bootstrap.js';

export default async function vercelHandler(req, res) {
  try {
    const raw = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : '';
    const out = await handlerFromEnv()({ method: req.method, headers: req.headers, rawBody: raw });
    Object.entries(out.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[analyze] startup error:', err.message);
    res.status(500).json({ ok: false, error: { code: 'server_misconfigured', message: 'Server is not configured' } });
  }
}
