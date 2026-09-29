// Local / self-hosted server:  node server.js   (PORT defaults to 8787)
import http from 'node:http';
import { handlerFromEnv, discoverHandlerFromEnv } from './src/api/bootstrap.js';

const MAX_BODY = 16 * 1024;
const port = Number(process.env.PORT || 8787);
let handle;
try { handle = handlerFromEnv(); } catch (err) { console.error('Startup error:', err.message); process.exit(1); }

const server = http.createServer(async (req, res) => {
  const send = (status, body, headers = {}) => { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  try {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') return send(200, { ok: true });
  const route = url.pathname === '/api/analyze' ? 'analyze' : url.pathname === '/api/discover' ? 'discover' : null;
  if (!route) return send(404, { ok: false, error: { code: 'not_found', message: 'Not found' } });
  let raw = '';
  let tooBig = false;
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) { tooBig = true; break; } }
  if (tooBig) return send(413, { ok: false, error: { code: 'payload_too_large', message: 'Body too large' } });
  let target = handle;
  if (route === 'discover') {
    try { target = discoverHandlerFromEnv(); }
    catch (err) { console.error('[server] discover not configured:', err.message); return send(500, { ok: false, error: { code: 'server_misconfigured', message: 'Discovery is not configured (see GOOGLE_PLACES_API_KEY)' } }); }
  }
  const out = await target({ method: req.method, headers: req.headers, rawBody: raw });
  send(out.status, out.body, out.headers);
  } catch (err) {
    console.error('[server] unexpected error:', err?.message);
    send(500, { ok: false, error: { code: 'internal_error', message: 'Unexpected error' } });
  }
});
server.listen(port, () => console.log(`AllSafe pipeline listening on http://localhost:${port}  (POST /api/analyze, POST /api/discover)`));
