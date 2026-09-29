import { SupabaseStore } from '../store-supabase.js';
import { createHandler } from './handler.js';
import { createDiscoverHandler } from './discover-handler.js';
import { GooglePlacesClient } from '../discover/google-places.js';

let cached;

/** Builds the handler from environment variables (lazy, cached per warm instance). */
export function handlerFromEnv(env = process.env) {
  if (cached) return cached;
  const store = new SupabaseStore({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    confirmRemoteHost: env.ANALYZE_CONFIRM_REMOTE_DB,
  });
  cached = createHandler({
    store,
    config: {
      apiKey: env.ANALYZE_API_KEY,
      deadlineMs: env.ANALYZE_DEADLINE_MS ? Number(env.ANALYZE_DEADLINE_MS) : undefined,
      http: {
        ...(env.ANALYZE_HTTP_TIMEOUT_MS ? { timeoutMs: Number(env.ANALYZE_HTTP_TIMEOUT_MS) } : {}),
        ...(env.ANALYZE_USER_AGENT ? { userAgent: env.ANALYZE_USER_AGENT } : {}),
      },
    },
  });
  return cached;
}

export function resetCache() { cached = undefined; cachedDiscover = undefined; }

let cachedDiscover;

/** Discovery needs the same Supabase settings plus GOOGLE_PLACES_API_KEY (server-side only). */
export function discoverHandlerFromEnv(env = process.env) {
  if (cachedDiscover) return cachedDiscover;
  const store = new SupabaseStore({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    confirmRemoteHost: env.ANALYZE_CONFIRM_REMOTE_DB,
  });
  const places = new GooglePlacesClient({
    apiKey: env.GOOGLE_PLACES_API_KEY,
    ...(env.DISCOVER_TIMEOUT_MS ? { timeoutMs: Number(env.DISCOVER_TIMEOUT_MS) } : {}),
  });
  cachedDiscover = createDiscoverHandler({
    store, places,
    config: {
      apiKey: env.DISCOVER_API_KEY || env.ANALYZE_API_KEY,
      ...(env.DISCOVER_MAX_LIMIT ? { maxLimit: Number(env.DISCOVER_MAX_LIMIT) } : {}),
      discover: {
        ...(env.DISCOVER_MAX_PAGES ? { maxPages: Number(env.DISCOVER_MAX_PAGES) } : {}),
        ...(env.DISCOVER_PAGE_DELAY_MS ? { pageDelayMs: Number(env.DISCOVER_PAGE_DELAY_MS) } : {}),
        ...(env.DISCOVER_REGION_CODE ? { regionCode: env.DISCOVER_REGION_CODE } : {}),
      },
    },
  });
  return cachedDiscover;
}

export function resetDiscoverCache() { cachedDiscover = undefined; }
