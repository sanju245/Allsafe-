// Maps one Google Places (New) `Place` object to a row for public.businesses.
// Only public business-listing fields are read. Reviews, photos and author data
// are never requested (see FIELD_MASK) and never mapped.
import { hostOf } from '../platforms.js';

const PLACE_ID = /^[A-Za-z0-9_-]{5,300}$/;
const CLOSED = new Set(['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY']);

const clean = (v, max = 300) => {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

const component = (place, type, key = 'longText') => {
  const c = (place.addressComponents || []).find((x) => Array.isArray(x?.types) && x.types.includes(type));
  return clean(c?.[key], 120);
};

function parseAddress(place) {
  const number = component(place, 'street_number');
  const route = component(place, 'route', 'shortText');
  let address_line = [number, route].filter(Boolean).join(' ') || null;
  const city = component(place, 'locality') ?? component(place, 'postal_town') ?? component(place, 'sublocality_level_1') ?? component(place, 'administrative_area_level_3');
  let state = component(place, 'administrative_area_level_1', 'shortText');
  let postal_code = component(place, 'postal_code');
  let country = component(place, 'country', 'shortText');

  // Fallback when addressComponents are missing: "123 Main St, Houston, TX 77002, USA"
  const formatted = clean(place.formattedAddress, 400);
  if (formatted && !address_line && !city) {
    const parts = formatted.split(',').map((x) => x.trim());
    const us = parts.length >= 3 && /^[A-Z]{2}\s+\d{5}(-\d{4})?$/.test(parts[parts.length - 2] ?? parts[parts.length - 1]);
    if (us) {
      address_line = parts[0];
      const m = parts[parts.length - 2].match(/^([A-Z]{2})\s+(\d{5})/);
      state = state ?? m?.[1] ?? null;
      postal_code = postal_code ?? m?.[2] ?? null;
      return { address_line, city: parts[parts.length - 3] ?? null, state, postal_code, country: country ?? 'US' };
    }
    address_line = parts[0];
  }
  return { address_line, city, state, postal_code, country };
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

function normalizeUrl(v) {
  const s = clean(v, 2048);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @returns {{ row: object } | { skip: 'invalid' | 'closed', reason: string }}
 */
export function mapPlace(place, { category, ownerId, query, fetchedAt, defaultCountry = 'US' }) {
  if (!place || typeof place !== 'object') return { skip: 'invalid', reason: 'not_an_object' };
  const id = typeof place.id === 'string' ? place.id : null;
  if (!id || !PLACE_ID.test(id)) return { skip: 'invalid', reason: 'missing_or_malformed_place_id' };
  const name = clean(place.displayName?.text, 200);
  if (!name) return { skip: 'invalid', reason: 'missing_name', placeId: id };
  if (CLOSED.has(place.businessStatus)) return { skip: 'closed', reason: place.businessStatus, placeId: id };

  const addr = parseAddress(place);
  const website_url = normalizeUrl(place.websiteUri);
  const website_domain = website_url ? hostOf(website_url) : null;
  const phone = clean(place.nationalPhoneNumber, 40) ?? clean(place.internationalPhoneNumber, 40);
  const digits = (phone || '').replace(/\D/g, '').slice(-10);
  const rating = num(place.rating, 0, 9.9);
  const reviews = Number.isInteger(place.userRatingCount) && place.userRatingCount >= 0 ? place.userRatingCount : null;
  const mapsUri = clean(place.googleMapsUri, 2048);

  const row = {
    owner_id: ownerId,
    business_name: name,
    industry: clean(category, 80),
    sub_industry: clean(place.primaryTypeDisplayName?.text, 120) ?? clean(place.primaryType, 120),
    address_line: addr.address_line,
    city: addr.city,
    state: addr.state,
    postal_code: addr.postal_code,
    country: addr.country ?? defaultCountry,
    latitude: num(place.location?.latitude, -90, 90),
    longitude: num(place.location?.longitude, -180, 180),
    website_url,
    website_domain,
    public_business_phone: phone,
    source: 'google_places',
    source_id: id,
    source_url: mapsUri && /^https:\/\//i.test(mapsUri) ? mapsUri : null,
    source_rating: rating === null ? null : Math.round(rating * 10) / 10,
    source_review_count: reviews,
    dedupe_key: `${norm(name)}|${digits || website_domain || ''}`,
    // Deliberately small: provenance only. No addresses, hours, reviews or photos.
    raw_source: {
      provider: 'google_places_v1',
      fetched_at: fetchedAt,
      query,
      business_status: typeof place.businessStatus === 'string' ? place.businessStatus : null,
      primary_type: clean(place.primaryType, 80),
      types: Array.isArray(place.types) ? place.types.filter((t) => typeof t === 'string').slice(0, 10) : [],
    },
  };
  return { row };
}
