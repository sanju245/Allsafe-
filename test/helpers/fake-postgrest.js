// A tiny fake of Supabase's PostgREST API backed by MemoryStore, so the real
// SupabaseStore HTTP code path (URLs, headers, bodies, error mapping) is exercised
// in tests without a database. It is NOT Postgres - see README "What is / is not tested".
import http from 'node:http';
import { MemoryStore } from '../../src/store-memory.js';
import { StoreError } from '../../src/errors.js';

export async function startFakePostgrest({ serviceKey = 'test-service-key' } = {}) {
  const store = new MemoryStore();
  const requests = [];
  const faults = []; // { method, table, status, body, times } - inject database failures
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: raw });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.headers.apikey !== serviceKey || req.headers.authorization !== `Bearer ${serviceKey}`) return send(401, { message: 'Invalid API key' });
    const q = url.searchParams;
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    const table = url.pathname.replace('/rest/v1/', '');
    const preferHeader = String(req.headers.prefer || '');
    const fault = faults.find((f) => f.times > 0 && f.method === req.method && f.table === table);
    if (fault) { fault.times--; return send(fault.status, fault.body ?? { code: 'XX000', message: 'injected database failure' }); }
    try {
      if (req.method === 'GET' && table === 'businesses' && q.get('source_id')) {
        const inList = q.get('source_id').replace(/^in\.\(/, '').replace(/\)$/, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
        return send(200, await store.findBusinessesBySource(eq('owner_id'), eq('source'), inList));
      }
      if (req.method === 'POST' && table === 'businesses') {
        const rows = JSON.parse(raw);
        const inserted = await store.insertBusinessesIgnoreDuplicates(Array.isArray(rows) ? rows : [rows]);
        return send(201, preferHeader.includes('return=representation') ? inserted : undefined);
      }
      if (req.method === 'PATCH' && table === 'businesses') { await store.updateBusiness(eq('id'), JSON.parse(raw)); return send(204); }
      if (req.method === 'POST' && table === 'campaign_businesses') {
        const rows = JSON.parse(raw);
        const linked = await store.linkBusinessesToCampaign(Array.isArray(rows) ? rows : [rows]);
        return send(201, preferHeader.includes('return=representation') ? linked : undefined);
      }
      if (req.method === 'GET' && table === 'campaign_businesses' && q.get('campaign_id') && q.get('business_id')) {
        const cb = await store.getCampaignBusiness(eq('campaign_id'), eq('business_id'));
        return send(200, cb ? [cb] : []);
      }
      if (req.method === 'GET' && table === 'campaign_businesses' && q.get('business_id') && !q.get('campaign_id')) {
        const rows = await store.getCampaignBusinessesForBusiness(eq('business_id'));
        return send(200, rows);
      }
      if (req.method === 'POST' && table === 'score_reasons') {
        const rows = JSON.parse(raw);
        const stored = await store.insertScoreReasons(Array.isArray(rows) ? rows : [rows]);
        return send(201, preferHeader.includes('return=representation') ? stored : undefined);
      }
      if (req.method === 'DELETE' && table === 'score_reasons') {
        await store.deleteScoreReasons(eq('campaign_business_id'), Number(eq('score_version')));
        return send(204);
      }
      if (req.method === 'POST' && table === 'rpc/apply_score') {
        const body = JSON.parse(raw);
        const total = await store.applyScore(body.p_campaign_business_id, body.p_score_version);
        return send(200, total);
      }
      if (req.method === 'GET' && table === 'businesses') { const b = await store.getBusiness(eq('id')); return send(200, b ? [b] : []); }
      if (req.method === 'GET' && table === 'campaigns') { const c = await store.getCampaign(eq('id')); return send(200, c ? [c] : []); }
      if (req.method === 'GET' && table === 'checks') {
        const bid = eq('business_id');
        return send(200, q.get('is_current') === 'is.true' ? await store.getCurrentChecks(bid) : await store.getChecks(bid));
      }
      if (req.method === 'POST' && table === 'checks') {
        const rows = JSON.parse(raw);
        const stored = await store.insertChecks(Array.isArray(rows) ? rows : [rows]);
        return send(201, req.headers.prefer?.includes('return=representation') ? stored : undefined);
      }
      if (req.method === 'POST' && table === 'events') { const body = JSON.parse(raw); await store.insertEvents(Array.isArray(body) ? body : [body]); return send(201); }
      return send(404, { message: `no route ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof StoreError) return send(err.status || 400, { code: err.code, message: err.message, details: null, hint: null });
      return send(500, { message: String(err.message || err) });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, serviceKey, store, requests, faults, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
