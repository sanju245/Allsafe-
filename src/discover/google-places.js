// Google Places API (New) - Text Search client.
//   POST https://places.googleapis.com/v1/places:searchText
//   auth: X-Goog-Api-Key header (the key is NEVER put in a URL, log line or returned error)
//   cost control: X-Goog-FieldMask lists ONLY the fields we store (no reviews, photos, author data)
//
// Documented limits (developers.google.com/maps/documentation/places/web-service/text-search):
//   pageSize 1-20; max 60 results across all pages; every parameter except
//   pageSize/pageToken must be identical between pages.

export const PLACES_BASE_URL = 'https://places.googleapis.com';
export const MAX_PAGE_SIZE = 20;
export const MAX_RESULTS_PER_QUERY = 60;

// Pro SKU fields + Enterprise SKU fields (phone, website, rating) - see README "Cost".
export const FIELD_MASK = [
  'nextPageToken',
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
  'places.googleMapsUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
].join(',');

/**
 * kind: 'quota' | 'auth' | 'bad_request' | 'unavailable' | 'invalid_response'
 * Safe to show to callers: never contains the API key.
 */
export class GooglePlacesError extends Error {
  constructor(kind, message, { status = null, googleStatus = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'GooglePlacesError';
    this.kind = kind;
    this.status = status;
    this.googleStatus = googleStatus; // e.g. PERMISSION_DENIED, RESOURCE_EXHAUSTED
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export class GooglePlacesClient {
  constructor({
    apiKey, baseUrl = PLACES_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 10_000,
    maxRetries = 2, backoffMs = 400, maxRetryAfterMs = 5_000, sleep = sleepReal, random = Math.random,
  } = {}) {
    if (!apiKey || typeof apiKey !== 'string') throw new Error('GOOGLE_PLACES_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
    this.maxRetryAfterMs = maxRetryAfterMs;
    this.sleep = sleep;
    this.random = random;
    this.requestCount = 0; // real HTTP requests made (including retries) - handy for quota accounting
  }

  #scrub(text) {
    return String(text ?? '').split(this.apiKey).join('[redacted]').slice(0, 300);
  }

  /** @returns {{ places: object[], nextPageToken: string|null }} */
  async searchText({ query, pageSize = MAX_PAGE_SIZE, pageToken = null, regionCode, languageCode = 'en', includePureServiceAreaBusinesses = true }) {
    const body = {
      textQuery: query,
      pageSize: Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize)),
      languageCode,
      includePureServiceAreaBusinesses,
      ...(regionCode ? { regionCode } : {}),
      ...(pageToken ? { pageToken } : {}),
    };
    let attempt = 0;
    for (;;) {
      this.requestCount++;
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}/v1/places:searchText`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey, 'x-goog-fieldmask': FIELD_MASK },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) { await this.#backoff(attempt++); continue; }
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new GooglePlacesError('unavailable', timedOut ? 'Google Places request timed out' : 'Could not reach Google Places');
      }

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }

      if (res.ok) {
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new GooglePlacesError('invalid_response', 'Google Places returned a response that is not a JSON object', { status: res.status });
        if (json.places !== undefined && !Array.isArray(json.places)) throw new GooglePlacesError('invalid_response', 'Google Places returned "places" that is not an array', { status: res.status });
        if (json.nextPageToken !== undefined && typeof json.nextPageToken !== 'string') throw new GooglePlacesError('invalid_response', 'Google Places returned a non-string nextPageToken', { status: res.status });
        return { places: json.places ?? [], nextPageToken: json.nextPageToken || null };
      }

      const gStatus = json?.error?.status ?? null;
      const gMessage = this.#scrub(json?.error?.message ?? `HTTP ${res.status}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;

      if (res.status === 429 || gStatus === 'RESOURCE_EXHAUSTED') {
        const waitMs = (retryAfterSeconds ?? 0) * 1000;
        if (attempt < this.maxRetries && waitMs <= this.maxRetryAfterMs) { await this.#backoff(attempt++, waitMs); continue; }
        throw new GooglePlacesError('quota', 'Google Places quota or rate limit reached', { status: 429, googleStatus: gStatus, retryAfterSeconds: retryAfterSeconds ?? 30 });
      }
      if (res.status >= 500) {
        if (attempt < this.maxRetries) { await this.#backoff(attempt++); continue; }
        throw new GooglePlacesError('unavailable', `Google Places is unavailable (HTTP ${res.status})`, { status: res.status, googleStatus: gStatus });
      }
      if (res.status === 401 || res.status === 403) {
        throw new GooglePlacesError('auth', 'Google rejected the request: check that the API key is valid, Places API (New) is enabled, billing is active and the key is not restricted away from this server', { status: res.status, googleStatus: gStatus });
      }
      throw new GooglePlacesError('bad_request', `Google Places rejected the request: ${gMessage}`, { status: res.status, googleStatus: gStatus });
    }
  }

  async #backoff(attempt, minMs = 0) {
    const ms = Math.max(minMs, this.backoffMs * 2 ** attempt + Math.floor(this.random() * 100));
    await this.sleep(ms);
  }
}
