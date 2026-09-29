// MOCK of the Google Places API (New) Text Search endpoint, for tests only.
// It reproduces the documented behaviour that matters to us: header auth, required field mask,
// pageSize 1-20, nextPageToken pagination that requires identical other parameters,
// a 60-result cap, and field-mask filtering. It is NOT Google and proves nothing about Google's servers.
import http from 'node:http';

export const TEST_GOOGLE_KEY = 'test-google-key-DO-NOT-LEAK-123';

export function makePlace(i, over = {}) {
  const n = String(i).padStart(3, '0');
  return {
    id: `ChIJtestPlace${n}_abcdefghij`,
    displayName: { text: `Pizza Place ${n}`, languageCode: 'en' },
    formattedAddress: `${100 + i} Main St, Houston, TX 77002, USA`,
    addressComponents: [
      { longText: String(100 + i), shortText: String(100 + i), types: ['street_number'] },
      { longText: 'Main Street', shortText: 'Main St', types: ['route'] },
      { longText: 'Houston', shortText: 'Houston', types: ['locality', 'political'] },
      { longText: 'Texas', shortText: 'TX', types: ['administrative_area_level_1', 'political'] },
      { longText: 'United States', shortText: 'US', types: ['country', 'political'] },
      { longText: '77002', shortText: '77002', types: ['postal_code'] },
    ],
    location: { latitude: 29.76 + i / 1000, longitude: -95.36 - i / 1000 },
    types: ['pizza_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    primaryType: 'pizza_restaurant',
    primaryTypeDisplayName: { text: 'Pizza restaurant', languageCode: 'en' },
    businessStatus: 'OPERATIONAL',
    googleMapsUri: `https://maps.google.com/?cid=${1000 + i}`,
    nationalPhoneNumber: `(713) 555-${String(1000 + i).slice(-4)}`,
    internationalPhoneNumber: `+1 713-555-${String(1000 + i).slice(-4)}`,
    websiteUri: `https://pizza${n}.example.com/`,
    rating: 4.4,
    userRatingCount: 100 + i,
    ...over,
  };
}

/** n places; every `noWebsiteEvery`-th one has no websiteUri (Google omits the key entirely). */
export function makePlaces(n, { start = 1, noWebsiteEvery = 0 } = {}) {
  return Array.from({ length: n }, (_, k) => {
    const i = start + k;
    const p = makePlace(i);
    if (noWebsiteEvery && i % noWebsiteEvery === 0) delete p.websiteUri;
    return p;
  });
}

const pick = (place, paths) => {
  const out = {};
  for (const p of paths) if (p in place) out[p] = place[p];
  return out;
};

export async function startFakeGoogle({ apiKey = TEST_GOOGLE_KEY, dataset = [] } = {}) {
  const state = { dataset, requests: [], faults: [], calls: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const err = (status, gStatus, message) => send(status, { error: { code: status, message, status: gStatus } });
    state.calls++;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const fault = state.faults.find((f) => f.call === state.calls || (f.fromCall && state.calls >= f.fromCall) || f.always);
    if (fault) {
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      return send(fault.status, fault.body ?? { error: { code: fault.status, message: 'injected', status: fault.googleStatus ?? 'INTERNAL' } }, fault.headers);
    }

    if (req.method !== 'POST' || !req.url.startsWith('/v1/places:searchText')) return err(404, 'NOT_FOUND', 'not found');
    if (req.headers['x-goog-api-key'] !== apiKey) return err(403, 'PERMISSION_DENIED', 'API key not valid. Please pass a valid API key.');
    const mask = req.headers['x-goog-fieldmask'];
    if (!mask) return err(400, 'INVALID_ARGUMENT', 'FieldMask is required');
    if (!body || typeof body.textQuery !== 'string' || !body.textQuery) return err(400, 'INVALID_ARGUMENT', 'textQuery is required');
    const pageSize = Math.min(20, Number(body.pageSize) || 20);
    if (!(pageSize >= 1)) return err(400, 'INVALID_ARGUMENT', 'pageSize must be between 1 and 20');

    const { pageToken, pageSize: _ps, ...rest } = body;
    const sig = JSON.stringify(rest);
    let offset = 0;
    if (pageToken) {
      let tok;
      try { tok = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')); } catch { return err(400, 'INVALID_ARGUMENT', 'Invalid page token'); }
      if (tok.sig !== sig) return err(400, 'INVALID_ARGUMENT', 'Request parameters must match the request that produced the page token');
      offset = tok.offset;
    }
    const all = (typeof state.dataset === 'function' ? state.dataset(body.textQuery) : state.dataset).slice(0, 60);
    const slice = all.slice(offset, offset + pageSize);
    const paths = mask.split(',').filter((p) => p.startsWith('places.')).map((p) => p.slice('places.'.length));
    const out = {};
    if (slice.length) out.places = slice.map((p) => pick(p, paths));
    const nextOffset = offset + slice.length;
    if (mask.split(',').includes('nextPageToken') && nextOffset < all.length) {
      out.nextPageToken = Buffer.from(JSON.stringify({ sig, offset: nextOffset })).toString('base64url');
    }
    return send(200, out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`, apiKey,
    failOnCall(call, spec) { state.faults.push({ call, ...spec }); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  });
}
