// Local fixture websites for tests. Each mimics a real-world pattern.
// NOTE: these are synthetic pages served from 127.0.0.1 - they are NOT real public websites.
import http from 'node:http';
import net from 'node:net';

export function startSite(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const path = req.url.split('#')[0];
    hits.push({ method: req.method, path, ua: req.headers['user-agent'] });
    const r = routes[path] ?? routes[path.split('?')[0]];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><body><h1>Not found</h1></body></html>'); }
    const spec = typeof r === 'string' ? { body: r } : r;
    res.writeHead(spec.status ?? 200, { 'content-type': spec.type ?? 'text/html; charset=utf-8', ...(spec.headers || {}) });
    res.end(spec.body ?? '');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`, port, hits,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

export async function closedPortUrl() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return `http://127.0.0.1:${port}`;
}

const YEAR = new Date().getUTCFullYear();

const head = (title, extra = '') => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">${extra}</head>`;

const footer = (extra = '') => `<footer><p>Open Monday - Sunday 11:00 AM - 10:00 PM</p>
<address>1201 Main Street, Houston, TX 77002</address>${extra}<p>&copy; ${YEAR} Sample Business</p></footer>`;

export const priced = (n = 10) => Array.from({ length: n }, (_, i) => `<li>Item ${i + 1} <span>$${8 + i}.50</span></li>`).join('');

// ---- B: restaurant, HTML menu, phone-only ordering, contact form, hours + address
export const restaurantMenuNoOrdering = () => ({
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /admin\n' },
  '/': `${head('Mike\'s Grill')}<body><header><nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main><h1>Mike's Grill</h1><p>Family owned grill serving the Heights since 1998. Come hungry, leave happy. We use fresh ingredients every day and cook everything to order.</p>
<a class="btn" href="tel:+17135550142">Order Now: (713) 555-0142</a>
<a href="/menu">See our menu</a></main>${footer()}</body></html>`,
  '/menu': `${head('Menu')}<body><header><nav><a href="/">Home</a> <a href="/menu">Menu</a></nav></header><main><h1>Menu</h1><ul>${priced(12)}</ul><p>Call to order: (713) 555-0142</p></main>${footer()}</body></html>`,
  '/contact': `${head('Contact')}<body><header><nav><a href="/">Home</a></nav></header><main><h1>Contact</h1>
<form action="/send" method="post"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form></main>${footer()}</body></html>`,
});

// ---- C: restaurant with Toast ordering + DoorDash link + OpenTable-free
export const restaurantWithOrdering = () => ({
  '/': `${head('Casa Verde')}<body><header><nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="https://order.toasttab.com/online/casa-verde-houston">Order Online</a> <a href="/contact">Contact</a></nav></header>
<main><h1>Casa Verde</h1><p>Fresh Tex-Mex made daily in the heart of Houston. Dine in, take out or order delivery with our partners.</p>
<a href="https://www.doordash.com/store/casa-verde-houston-12345/">Also on DoorDash</a></main>${footer()}</body></html>`,
  '/menu': `${head('Menu')}<body><header><nav><a href="/">Home</a></nav></header><main><h1>Menu</h1><ul>${priced(15)}</ul></main>${footer()}</body></html>`,
  '/contact': `${head('Contact')}<body><header><nav><a href="/">Home</a></nav></header><main><h1>Contact</h1>
<form action="/send" method="post"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea><input type="submit" value="Send"></form></main>${footer()}</body></html>`,
});

// ---- D: barbershop with Fresha booking
export const barberWithBooking = () => ({
  '/': `${head('Kings Barbershop')}<body><header><nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/team">Barbers</a> <a href="/contact">Contact</a></nav></header>
<main><h1>Kings Barbershop</h1><p>Classic cuts, hot towel shaves and beard trims in downtown Dallas. Walk-ins welcome, appointments preferred.</p>
<a class="cta" href="https://www.fresha.com/a/kings-barbershop-dallas-abc123">Book Now</a></main>${footer()}</body></html>`,
  '/services': `${head('Services')}<body><header><nav><a href="/">Home</a></nav></header><main><h1>Services</h1><ul><li>Haircut $35</li><li>Shave $30</li></ul></main>${footer()}</body></html>`,
  '/contact': `${head('Contact')}<body><header><nav><a href="/">Home</a></nav></header><main><h1>Contact</h1>
<form action="/send" method="post"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form></main>${footer()}</body></html>`,
});

// ---- F: JavaScript-rendered single-page app (features cannot be determined from static HTML)
export const spaShell = () => ({
  '/': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Bella Pizza</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><script defer src="/static/js/main.4f2a.js"></script><link rel="stylesheet" href="/static/css/main.css"></head>
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`,
  '/static/js/main.4f2a.js': { type: 'application/javascript', body: 'console.log("app")' },
});

// ---- legacy / outdated site
export const legacySite = () => ({
  '/': `<html><head><title>Joe's Auto</title></head><body bgcolor="#ffffcc"><center><font face="Arial" size="5">Welcome to Joe's Auto Repair</font></center>
<marquee>Special this month: oil change!</marquee>
<table><tr><td><font size="3">Home</font></td><td><font size="3">Services</font></td></tr></table>
<table><tr><td><table><tr><td>content</td></tr></table></td></tr></table><table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>
<p>Copyright 2009 Joe's Auto Repair. All rights reserved. We fix all makes and models with honest service and fair prices for our customers.</p></body></html>`,
});

// ---- menu only as a PDF
export const pdfMenuOnly = () => ({
  '/': `${head('Luigi\'s Pizza')}<body><header><nav><a href="/">Home</a> <a href="/menu.pdf">Download our menu</a> <a href="/contact">Contact</a></nav></header>
<main><h1>Luigi's Pizza</h1><p>Wood-fired pizza and pasta since 1985. Family recipes passed down through generations, served with warmth and a smile every single day of the week.</p></main>${footer()}</body></html>`,
  '/contact': `${head('Contact')}<body><header><nav><a href="/">Home</a></nav></header><main><h1>Contact us</h1><p>Visit us any day.</p></main>${footer()}</body></html>`,
  '/menu.pdf': { type: 'application/pdf', body: '%PDF-1.4 fake' },
});

// ---- "Order online" link that leads to a page that only says call us
export const orderLinkUnverified = () => ({
  '/': `${head('Tony\'s Pizza')}<body><header><nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/order-online">Order Online</a></nav></header>
<main><h1>Tony's Pizza</h1><p>Hand-tossed pizza made fresh to order, with local ingredients and a whole lot of love from our family kitchen.</p></main>${footer()}</body></html>`,
  '/menu': `${head('Menu')}<body><main><h1>Menu</h1><ul>${priced(8)}</ul></main></body></html>`,
  '/order-online': `${head('Order')}<body><main><h1>Ordering</h1><p>Please call us to place your order. We will have it ready in 20 minutes.</p></main></body></html>`,
});

// ---- plain page with nothing actionable at all
export const plainNoCta = () => ({
  '/': `${head('Sunrise Cleaning')}<body><h1>Sunrise Cleaning</h1><p>We clean homes and offices across the county with care and attention to detail. Established in 2010, family run, fully insured and background checked for your peace of mind.</p>
<p>Serving residential and commercial customers with weekly, biweekly and monthly plans tailored to your schedule and your budget, always with a satisfaction guarantee.</p></body></html>`,
});

// ---- robots.txt blocks the menu page
export const robotsBlocksMenu = () => ({
  ...restaurantMenuNoOrdering(),
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /menu\n' },
});

export const serverError = () => ({ '/': { status: 503, body: '<html><body>Service Unavailable</body></html>' } });
export const forbidden = () => ({ '/': { status: 403, body: 'Forbidden' } });
export const redirectsElsewhere = (target) => ({ '/': { status: 301, headers: { location: target }, body: '' } });
