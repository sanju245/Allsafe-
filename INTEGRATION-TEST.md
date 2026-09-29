# AllSafe Discovery — Real Integration Test

**Status: not executed.** This sandbox has no outbound internet access (every
external host is blocked), so nothing here has been run against a real Google
or Supabase. Everything below was verified by reading the code
(`src/api/bootstrap.js`, `src/api/discover-handler.js`, `src/discover/*.js`,
`src/safety.js`) — not by running it. Section 6 gives the honest readiness
assessment.

Do not paste real key values back into this chat or into logs. The sanity
check in step 3 confirms a variable is *set* without printing its value.

---

## 1. Environment variables

| Variable | Required? | Used by | Default if unset |
|---|---|---|---|
| `SUPABASE_URL` | **Yes** | `bootstrap.js` → both handlers | — |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | `bootstrap.js` → both handlers | — |
| `GOOGLE_PLACES_API_KEY` | **Yes** | `bootstrap.js` → `GooglePlacesClient` | — |
| `ANALYZE_API_KEY` | **Yes** — see note | `server.js` startup, `/api/analyze` | — |
| `ANALYZE_CONFIRM_REMOTE_DB` | **Yes, for a real project** — see note | `src/safety.js` | — |
| `DISCOVER_API_KEY` | No | `/api/discover` bearer auth | falls back to `ANALYZE_API_KEY` |
| `DISCOVER_MAX_LIMIT` | No | caps the request's `limit` | `60` (Google's own per-query cap) |
| `DISCOVER_MAX_PAGES` | No | pagination loop in `discover.js` | `5` |
| `DISCOVER_PAGE_DELAY_MS` | No | delay between pages | `150` |
| `DISCOVER_REGION_CODE` | No | passed to Google + fallback country | `US` |
| `DISCOVER_TIMEOUT_MS` | No | per-request timeout to Google | `10000` |

I checked each one is actually read where it should be: `DISCOVER_MAX_LIMIT` →
`parseDiscoverInput`'s limit validation, `DISCOVER_MAX_PAGES`/`DISCOVER_PAGE_DELAY_MS`/`DISCOVER_REGION_CODE`
→ `discover.js`'s `cfg.maxPages` / `cfg.pageDelayMs` / `cfg.regionCode` (the
last one also becomes `mapPlace`'s address-country fallback), `DISCOVER_TIMEOUT_MS`
→ `GooglePlacesClient`'s fetch timeout. All confirmed wired correctly.

Two important notes not on your original list, found by tracing the code:

- **`ANALYZE_API_KEY` is required even for a discovery-only test.**
  `server.js` builds the *analyze* handler unconditionally at startup
  (`handlerFromEnv()`) and exits if that fails — before it ever routes a
  single request to `/api/discover`.
- **`ANALYZE_CONFIRM_REMOTE_DB` is required for any real Supabase project.**
  `src/safety.js` refuses to write to any host that isn't `localhost` /
  `127.0.0.1` / `host.docker.internal` unless you explicitly confirm the
  exact hostname. A real `https://xxxx.supabase.co` URL will be **rejected**
  without this. Set it to your project's hostname only, e.g.
  `ANALYZE_CONFIRM_REMOTE_DB=xxxx.supabase.co`.

---

## 2. Supabase setup steps

1. **Run the schema** (`allsafe_schema.sql` from Part 1) against your project's SQL editor, if you haven't already.
2. **Create at least one Auth user** (Authentication → Users → Add user, any email/password). The seed campaign's `owner_id` is a foreign key to `auth.users`, and the schema's seed step silently skips itself if no user exists yet.
3. **Get a campaign_id.** The schema already seeds a matching campaign (`slug='test-pizza-houston'`, industry Pizza, Houston/TX) — reuse it:
   ```sql
   select id from public.campaigns where slug = 'test-pizza-houston';
   ```
   If it's empty (no auth user existed when you ran the schema), either re-run just that seed `do $$ ... $$;` block from the schema file, or insert one manually:
   ```sql
   insert into public.campaigns (owner_id, name, slug, industry, country, state, city)
   select id, 'Integration test', 'integration-test', 'Pizza', 'US', 'TX', 'Houston'
   from auth.users order by created_at limit 1
   returning id;
   ```
4. **Get your API URL and service role key**: Project Settings → API → `Project URL` (→ `SUPABASE_URL`) and `service_role` key (→ `SUPABASE_SERVICE_ROLE_KEY`, under "Reveal" — never the `anon` key).
5. **Google side**: in Google Cloud Console, enable **"Places API (New)"** for your project and attach a billing account (Text Search is a paid, metered call). Make sure the key isn't restricted away from your server's IP.

---

## 3. Exact command

```bash
# --- set these in your own shell, never in a file you commit ---
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...
export ANALYZE_CONFIRM_REMOTE_DB=xxxx.supabase.co   # must match SUPABASE_URL's host exactly
export GOOGLE_PLACES_API_KEY=...
export ANALYZE_API_KEY=some-long-random-string       # required at startup either way
export DISCOVER_API_KEY=$ANALYZE_API_KEY              # or set a separate one
export DISCOVER_MAX_LIMIT=3                            # belt-and-braces cap for this small test

# sanity check: confirms each var is SET, never prints the value
for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ANALYZE_CONFIRM_REMOTE_DB GOOGLE_PLACES_API_KEY ANALYZE_API_KEY DISCOVER_API_KEY; do
  [ -n "${!v}" ] && echo "$v is set" || echo "$v is MISSING"
done

npm start   # http://localhost:8787  — leave this running in its own terminal
```

In a second terminal:

```bash
CAMPAIGN_ID=$(psql "$YOUR_DIRECT_DB_URL" -tAc "select id from public.campaigns where slug='test-pizza-houston'")
# or just paste the id you got from Supabase's SQL editor in step 2.3 above

curl -s -X POST http://localhost:8787/api/discover \
  -H "Authorization: Bearer $DISCOVER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"campaign_id\":\"$CAMPAIGN_ID\",\"category\":\"pizza\",\"location\":\"Houston, TX\",\"limit\":3}"
```

Plain `curl -s` only prints the response body — it never echoes the request
headers (which carry your bearer token), so this is safe to leave in your
terminal scrollback. Avoid adding `-v`/`--trace`, which would print them.

---

## 4. Expected results

**HTTP response** (shape, not exact values):
```json
{
  "ok": true,
  "campaign_id": "...",
  "status": "completed",
  "summary": { "pages_fetched": 1, "created": 3, "already_existing": 0,
               "linked_new": 3, "already_linked": 0, "with_website": ?, "without_website": ? },
  "businesses": [ { "business_id": "...", "place_id": "ChIJ...", "name": "...",
                     "created": true, "linked_to_campaign": true, "newly_linked": true }, ... ]
}
```

**Database, via Supabase's SQL editor** (`CAMPAIGN_ID` from step 2.3):

```sql
-- business saved (expect 3 rows, source_id = a real Google place_id, owner_id set)
select id, business_name, source, source_id, website_url, public_business_phone, city, state
from public.businesses
where owner_id = (select owner_id from public.campaigns where id = '<CAMPAIGN_ID>')
order by created_at desc limit 5;

-- campaign_businesses linked (expect 3 rows, one per business above)
select cb.business_id, b.business_name, cb.lead_status
from public.campaign_businesses cb join public.businesses b on b.id = cb.business_id
where cb.campaign_id = '<CAMPAIGN_ID>';

-- no duplicate records (expect ZERO rows)
select source_id, count(*)
from public.businesses
where owner_id = (select owner_id from public.campaigns where id = '<CAMPAIGN_ID>')
group by source_id having count(*) > 1;
```

**Re-run the exact same curl command a second time.** Expect
`"created": 0, "already_existing": 3, "linked_new": 0, "already_linked": 3`,
and the duplicate-check query above should still return zero rows. (Google's
result order/set is normally stable within a few minutes for the same query;
if it returns one different business the second time, you'd see one more
`created` row rather than a duplicate — the query above is the real proof of
no duplicates either way.)

---

## 5. Missing configuration / documentation

- `ANALYZE_CONFIRM_REMOTE_DB` isn't in your env var list but is **required**
  for a real Supabase project (see §1) — the single most likely reason a
  first attempt would fail.
- `.env.example` still only documents `GOOGLE_PLACES_API_KEY`; none of the
  six `DISCOVER_*` vars or `ANALYZE_CONFIRM_REMOTE_DB` are in it (flagged,
  not fixed, in the last two turns — still outstanding).
- `README.md` doesn't document `/api/discover` at all yet.
- No .env file itself exists yet in the project — only `.env.example`.

## 6. Is the existing code ready for a real test?

Yes, by static inspection: env vars are read where they should be, the
service-role key and Places API key are never logged (`GooglePlacesClient`
scrubs its key from every error message; catch blocks elsewhere print only
`err.message`, never headers or env), and Part 3B/3C/3D's mocked tests
already prove the save-dedupe-link logic is correct end to end. What's
**not** verified is anything specific to a real network: real Google response
shapes/latency, real Supabase RLS/policy behavior under the service role, and
real timing. That only gets checked by you actually running the steps above.
