// Which feature checks are relevant for which kind of business.
// Irrelevant checks are recorded as 'not_applicable' (never silently skipped).
// Unrecognised industries are NOT guessed at: every feature is detected normally.

const PROFILES = {
  restaurant: { ordering: true,  menu: true,  booking: false, reservations: true  },
  cafe:       { ordering: true,  menu: true,  booking: false, reservations: false },
  pizza:      { ordering: true,  menu: true,  booking: false, reservations: false },
  fast_food:  { ordering: true,  menu: true,  booking: false, reservations: false },
  barber:     { ordering: false, menu: false, booking: true,  reservations: false },
  salon:      { ordering: false, menu: false, booking: true,  reservations: false },
  cleaning:   { ordering: false, menu: false, booking: true,  reservations: false },
  auto_repair:{ ordering: false, menu: false, booking: true,  reservations: false },
};

const ALIASES = [
  [/pizz/, 'pizza'],
  [/burger|fast[\s_-]?food|fried chicken|sandwich|takeaway|takeout|food truck/, 'fast_food'],
  [/caf[eé]|coffee|bakery|dessert|ice cream|juice|smoothie/, 'cafe'],
  [/restaurant|diner|bistro|grill/, 'restaurant'],
  [/barber|men'?s grooming/, 'barber'],
  [/salon|spa\b|nail|beauty|hair/, 'salon'],
  [/clean|maid|janitorial/, 'cleaning'],
  [/auto[\s_-]?repair|mechanic|garage|car repair/, 'auto_repair'],
];

export function resolveProfile(industry) {
  const raw = String(industry ?? '').trim().toLowerCase();
  const direct = PROFILES[raw.replace(/[\s-]+/g, '_')];
  if (direct) return { key: raw.replace(/[\s-]+/g, '_'), known: true, applies: direct };
  for (const [re, key] of ALIASES) {
    if (re.test(raw)) return { key, known: true, applies: PROFILES[key] };
  }
  return { key: raw || 'unspecified', known: false, applies: null };
}

const FEATURE_OF = {
  online_menu: 'menu',
  online_ordering: 'ordering',
  direct_ordering: 'ordering',
  third_party_ordering: 'ordering',
  online_booking: 'booking',
  reservations: 'reservations',
};

/** false only when the industry is known AND the feature is irrelevant to it. */
export function appliesTo(profile, checkType) {
  const feature = FEATURE_OF[checkType];
  if (!feature || !profile.known) return true;
  return profile.applies[feature];
}
