# AllSafe – Part 2: Website Analyzer

`POST /api/analyze` inspects one business website and records **14 evidence-backed checks** in the
existing append-only `public.checks` table. It does not discover businesses, score, send email or build a
dashboard, and it needs **no schema change** (all 14 check types and all 4 result values already exist in
`public.check_type` / `public.check_result`).

Zero npm dependencies. Node >= 20.

## Run it

```bash
npm test                       # 73 tests (unit + end-to-end smoke); writes reports/smoke-report.md

# 1) point it at a LOCAL Supabase (supabase start), never production
cp .env.example .env           # fill in the three required values, then:
set -a; . ./.env; set +a
npm start                      # http://localhost:8787/api/analyze   (GET /api/health too)
```

Create a test business (SQL editor of the local Supabase; uses your first auth user):

```sql
insert into public.businesses (owner_id, business_name, industry, source, source_id, source_url, website_url)
select id, 'Test Pizza', 'pizza', 'manual', 'test-001', 'https://maps.example.test/test-001', 'https://SOME-PUBLIC-SITE.com'
from auth.users order by created_at limit 1
returning id;
```

Call it:

```bash
curl -s -X POST http://localhost:8787/api/analyze \
  -H "authorization: Bearer $ANALYZE_API_KEY" -H "content-type: application/json" \
  -d '{"business_id":"<uuid from above>","website_url":"https://SOME-PUBLIC-SITE.com"}'
```

Inspect what was stored:

```sql
select check_type, result, confidence, evidence_url, http_status, checked_at, is_current
from public.checks where business_id = '<uuid>' order by check_type, checked_at desc;
```

Run it a second time: the new rows are inserted, the previous ones flip to `is_current = false` (the schema's
trigger does this), nothing is deleted.

Try real public sites **without any database**:

```bash
npm run analyze -- --url https://some-restaurant.com --industry restaurant --verbose
npm run live -- "https://a.com|restaurant" "https://b.com|barber"     # table per site + reports/live-*.json
```

### Deploy
* **Vercel:** `api/analyze.js` is picked up automatically; `vercel.json` sets `maxDuration: 30` (lower `ANALYZE_DEADLINE_MS` if your plan's timeout is shorter).
* **Netlify:** `netlify/functions/analyze.mjs` serves `/api/analyze` (`config.path`). Sync functions time out at ~10 s by default (26 s max): set `ANALYZE_DEADLINE_MS=8000`.
* Set the same env vars in the host. A **remote** Supabase URL is refused unless `ANALYZE_CONFIRM_REMOTE_DB=<that exact host>` is also set (deliberate write guard).

## API

`POST /api/analyze`, header `Authorization: Bearer <ANALYZE_API_KEY>`

```json
{ "business_id": "<uuid>", "website_url": "https://example.com",
  "campaign_id": "<uuid, optional>", "force": false }
```
* `website_url: null` (or "") = the business has no website. Nothing is fetched.
* `campaign_id` (optional): if all of the campaign's `required_checks` are still fresh (`stale_after_days`), the call returns `status: "skipped_fresh"` and writes nothing. `force: true` overrides.
* `owner_id` is always taken from the `businesses` row; anything else the caller sends is ignored.

`200` → `{ ok, status: "analyzed", summary: {yes,no,unknown,not_applicable}, conclusive, site_state, checks: [14 rows incl. evidence], crawl, scoring }`
Errors: `400` validation · `401` auth · `404` unknown business/campaign · `405` · `409` concurrent analysis · `429` busy · `502` database rejected the write · `500`.

### `scoring`

After checks are persisted, every campaign the business is linked to is scored (`campaign_id` in the request is not required for this — it scores *all* linked campaigns, not just the one named, if any). This never fails the request: a bad campaign config, a database error, or even the whole scoring step failing still returns `200 analyzed` with the checks intact.

```json
"scoring": {
  "attempted": true,
  "campaigns_scored": 1,
  "campaigns_failed": 0,
  "results": [
    { "campaign_id": "...", "ok": true, "campaign_business_id": "...", "score_version": 3,
      "opportunity_score": 65, "priority": "warm", "scored_at": "...",
      "rules_applied": 3, "rules_configured": 10, "reasons": [ { "rule_key": "poor_mobile", "description": "...", "points": 20 } ] }
  ]
}
```
A campaign that failed to score appears instead as `{ "campaign_id": "...", "ok": false, "error": { "name", "code", "message" } }`; a total failure (e.g. the lookup itself erroring) instead sets `scoring.error` with `results: []`. A business linked to no campaign gets `results: []` with no error. The `scoring` field is **absent entirely** on a `skipped_fresh` response — scoring only runs when checks were actually (re-)persisted in that request.

## What each check means

| check | yes | no | unknown / not_applicable |
|---|---|---|---|
| website_present | listing has a real (non-social) URL | listing has no URL (low confidence, listing-only evidence) or the URL is a social/listing page | – |
| website_reachable | page answered 2xx HTML | connection failure after retry, 404/410/5xx, redirect loop, site's own TLS fault (expired / self-signed / wrong host) | 401/403/429 (refused us), robots block, untrusted TLS chain (could be our trust store), SSRF-blocked; n/a if no website |
| mobile_friendly | `<meta viewport width=device-width>` | missing / fixed-width viewport | can't fetch |
| website_modern | no outdated markup and >= 4 of 5 modern signals | Flash / frames / marquee, or >= 2 soft signals (legacy doctype, table layout, deprecated tags, copyright year >= 4 yrs old) | JS-only page, mixed signals |
| clear_cta | order/book/reserve/call/quote link or button in header/nav or among first 25 links | conclusive homepage with none | present but not prominent, JS-only |
| good_navigation | 3-12 labelled internal links in `<nav>`/`<header>`, none unlabelled | no nav and < 3 labelled internal links | anything in between |
| hours_and_location | opening hours AND an address signal (JSON-LD, `<address>`, street+state+ZIP, map link) found | conclusive crawl, at least one missing | inconclusive crawl |
| online_menu | HTML page with >= 6 US-dollar prices, or menu on a known platform | conclusive crawl, none (or **PDF-only**) | inconclusive |
| online_ordering / direct_ordering / third_party_ordering | known platform link/embed (Toast, Square, ChowNow, DoorDash, Uber Eats, ...), or "Order online" link to a verified checkout page | conclusive crawl, none (phone-based ordering is noted in evidence) | "Order" link that can't be verified; inconclusive |
| online_booking / reservations | known platform (Fresha, Booksy, Vagaro, OpenTable, Resy, ...) or verified booking page | conclusive crawl, none | as above |
| contact_form | HTML form with textarea / email+fields, or embedded form platform | conclusive crawl, none | inconclusive |

`not_applicable` is also used for features irrelevant to the industry (e.g. `online_menu` for a barber).
An unrecognised industry is never guessed at: every feature is checked normally.

**"no" is only reported when the crawl was conclusive**: homepage is server-rendered HTML, every candidate page
(menu / order / book / reserve / contact / location / hours, up to 6 pages) was fetched, robots.txt did not block
any, and the page cap wasn't hit. Otherwise absence is `unknown`. Pages are only *read*: no JavaScript is run, no form is submitted.

Every `yes`/`no` row is stored with `evidence_url`, `method`, `http_status`, `checked_at`, `confidence`, a redacted
`evidence_excerpt` and structured `evidence` (JSON). A `yes`/`no` that cannot cite an evidence URL is stored as `unknown`
(the attempted value is kept in `evidence.downgraded`). Unreachable results expire after 3 days instead of the campaign window.

## Privacy & safety
* Phone numbers, emails, `tel:`/`mailto:` links are redacted before anything is stored; street addresses are never stored (only "an address was found on <page>"); no form values, cookies or page bodies are kept.
* SSRF guard: private, loopback, link-local and cloud-metadata addresses are refused (checked again at connect time), only ports 80/443/8080/8443, no URL credentials.
* Politeness: honours robots.txt, identifies itself (`ANALYZE_USER_AGENT`), sequential requests with a delay, response-size and time caps.
* The endpoint fails closed without `ANALYZE_API_KEY`, is bearer-protected, and caps concurrent analyses (429).

## Known limitations
* Text/markup heuristics: hours or menus shown only as images, prices not in US dollars, or content injected by JavaScript are not detected (they yield `no` only on server-rendered pages, otherwise `unknown`; the evidence says so).
* `website_present = no` for a missing listing URL is based on the source listing only (confidence 0.6); it is not an independent search. Outreach must say "I couldn't find a dedicated website", not "you have no website".
* Crawl scope is the homepage plus keyword-matched same-site pages; sites that hide the menu under an unusual link name can be missed.
* Detection tables (`src/platforms.js`) will need extending as you meet more platforms.

## Layout
```
api/analyze.js + vercel.json   Vercel function          netlify/functions/analyze.mjs   Netlify function
server.js                      local / self-hosted      src/api/handler.js              the endpoint logic
src/analyze.js                 crawl -> detect -> rows  src/crawl.js  src/detect.js     the analyzer
src/http.js  src/html.js       safe fetch, robots, parsing
src/check.js                   never-guess + redaction  src/freshness.js                stale_after_days logic
src/store-supabase.js          PostgREST (service role) src/safety.js                   local-only write guard
src/store-memory.js            test double mirroring the schema's rules
test/                          unit + smoke tests, fixture sites, fake PostgREST
```
