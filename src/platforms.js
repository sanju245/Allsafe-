// Known third-party platforms, matched on hostname (and optional path) of links,
// iframes and script sources. kinds:
//   direct_ordering  white-label ordering on/for the business's own brand
//   marketplace      third-party delivery marketplace
//   booking | reservation | form | menu | builder

export const PLATFORMS = [
  // ordering: direct / white-label
  { id: 'toast',    name: 'Toast',    kind: 'direct_ordering', hosts: ['toasttab.com'] },
  { id: 'square_online', name: 'Square Online', kind: 'direct_ordering', hosts: ['square.site', 'order.squareup.com'] },
  { id: 'chownow',  name: 'ChowNow',  kind: 'direct_ordering', hosts: ['chownow.com'] },
  { id: 'clover',   name: 'Clover',   kind: 'direct_ordering', hosts: ['clover.com'], pathIncludes: ['/online-ordering'] },
  { id: 'menufy',   name: 'Menufy',   kind: 'direct_ordering', hosts: ['menufy.com'] },
  { id: 'popmenu',  name: 'Popmenu',  kind: 'menu',            hosts: ['popmenu.com'] },
  // ordering: marketplaces
  { id: 'ubereats', name: 'Uber Eats', kind: 'marketplace', hosts: ['ubereats.com'] },
  { id: 'doordash', name: 'DoorDash',  kind: 'marketplace', hosts: ['doordash.com'] },
  { id: 'grubhub',  name: 'Grubhub',   kind: 'marketplace', hosts: ['grubhub.com', 'seamless.com'] },
  { id: 'postmates', name: 'Postmates', kind: 'marketplace', hosts: ['postmates.com'] },
  { id: 'slice',    name: 'Slice',     kind: 'marketplace', hosts: ['slicelife.com'] },
  // booking
  { id: 'fresha',   name: 'Fresha',   kind: 'booking', hosts: ['fresha.com'] },
  { id: 'booksy',   name: 'Booksy',   kind: 'booking', hosts: ['booksy.com'] },
  { id: 'vagaro',   name: 'Vagaro',   kind: 'booking', hosts: ['vagaro.com'] },
  { id: 'acuity',   name: 'Acuity Scheduling', kind: 'booking', hosts: ['acuityscheduling.com', 'as.me'] },
  { id: 'calendly', name: 'Calendly', kind: 'booking', hosts: ['calendly.com'] },
  { id: 'setmore',  name: 'Setmore',  kind: 'booking', hosts: ['setmore.com'] },
  { id: 'mindbody', name: 'Mindbody', kind: 'booking', hosts: ['mindbodyonline.com'] },
  { id: 'styleseat', name: 'StyleSeat', kind: 'booking', hosts: ['styleseat.com'] },
  { id: 'schedulicity', name: 'Schedulicity', kind: 'booking', hosts: ['schedulicity.com'] },
  { id: 'glossgenius', name: 'GlossGenius', kind: 'booking', hosts: ['glossgenius.com'] },
  { id: 'square_appointments', name: 'Square Appointments', kind: 'booking', hosts: ['book.squareup.com'] },
  { id: 'square_appointments_path', name: 'Square Appointments', kind: 'booking', hosts: ['squareup.com'], pathIncludes: ['/appointments'] },
  { id: 'housecallpro', name: 'Housecall Pro', kind: 'booking', hosts: ['housecallpro.com'] },
  { id: 'jobber', name: 'Jobber', kind: 'booking', hosts: ['getjobber.com'] },
  // reservations
  { id: 'opentable', name: 'OpenTable', kind: 'reservation', hosts: ['opentable.com'] },
  { id: 'resy',      name: 'Resy',      kind: 'reservation', hosts: ['resy.com'] },
  { id: 'tock',      name: 'Tock',      kind: 'reservation', hosts: ['exploretock.com'] },
  { id: 'sevenrooms', name: 'SevenRooms', kind: 'reservation', hosts: ['sevenrooms.com'] },
  { id: 'yelp_reservations', name: 'Yelp Reservations', kind: 'reservation', hosts: ['yelp.com'], pathIncludes: ['/reservations'] },
  // embedded forms
  { id: 'jotform',  name: 'Jotform',  kind: 'form', hosts: ['jotform.com'] },
  { id: 'typeform', name: 'Typeform', kind: 'form', hosts: ['typeform.com'] },
  { id: 'google_forms', name: 'Google Forms', kind: 'form', hosts: ['docs.google.com'], pathIncludes: ['/forms'] },
  { id: 'hubspot_forms', name: 'HubSpot Forms', kind: 'form', hosts: ['hsforms.com', 'hsforms.net'] },
  // site builders (context only)
  { id: 'wix',        name: 'Wix',         kind: 'builder', hosts: ['wixsite.com', 'wixstatic.com', 'parastorage.com'] },
  { id: 'squarespace', name: 'Squarespace', kind: 'builder', hosts: ['squarespace.com', 'squarespace-cdn.com'] },
  { id: 'shopify',    name: 'Shopify',     kind: 'builder', hosts: ['cdn.shopify.com', 'myshopify.com'] },
  { id: 'godaddy',    name: 'GoDaddy Website Builder', kind: 'builder', hosts: ['godaddysites.com', 'img1.wsimg.com'] },
  { id: 'weebly',     name: 'Weebly',      kind: 'builder', hosts: ['weebly.com', 'editmysite.com'] },
  { id: 'webflow',    name: 'Webflow',     kind: 'builder', hosts: ['webflow.com', 'website-files.com'] },
];

// URLs that are a social profile / listing page, not a dedicated business website.
export const NON_WEBSITE_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com',
  'linkedin.com', 'youtube.com', 'linktr.ee', 'linktree.com', 'beacons.ai',
  'yelp.com', 'tripadvisor.com', 'google.com', 'goo.gl', 'g.page', 'maps.app.goo.gl',
  'nextdoor.com', 'thumbtack.com',
];

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function matchPlatform(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  for (const p of PLATFORMS) {
    if (!p.hosts.some((d) => hostMatches(host, d))) continue;
    if (p.pathIncludes && !p.pathIncludes.some((s) => path.includes(s))) continue;
    return p;
  }
  return null;
}

export function isNonWebsiteHost(url) {
  const host = hostOf(url);
  if (!host) return false;
  return NON_WEBSITE_HOSTS.some((d) => hostMatches(host, d)) &&
    // google.com/maps style pages only; a bare google.com site is not a business site either
    true;
}

/** Generator-meta / asset-path hints for builders (context only). */
export function builderFromGenerator(text) {
  const t = String(text || '').toLowerCase();
  const table = [
    ['wix', /wix\.com/], ['squarespace', /squarespace/], ['wordpress', /wordpress/],
    ['shopify', /shopify/], ['webflow', /webflow/], ['godaddy', /godaddy|starfield/], ['weebly', /weebly/],
  ];
  for (const [id, re] of table) if (re.test(t)) return id;
  return null;
}
