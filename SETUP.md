# AllSafe — Setup Guide (start here)

Covers the whole project as it stands today: website analysis, business
discovery, and opportunity scoring (now automatically chained after
analysis). Nothing in this guide has been run for real from this environment
— it has no outbound internet access — so treat every step as unverified
against a real Google/Supabase until you run it yourself.

---

## Step 1 — Get the files, check Node

Unzip the project (see below) into a folder, e.g. `allsafe-analyze/`.

```bash
cd allsafe-analyze
node -v        # need >= 20
```
Zero npm dependencies — `npm install` is a no-op, but run it anyway to be safe.

## Step 2 — Create a Supabase project and run the schema

1. Create a project at [supabase.com](https://supabase.com) and wait for it to finish provisioning.
2. **Authentication → Users → Add user** — create at least one user (any email/password). The seed campaign's `owner_id` is a foreign key to `auth.users`, and the schema silently skips seeding if none exists yet.
3. **SQL Editor** → paste the full contents of `test/fixtures/reference_schema.sql` → Run. This is the real, deployable schema (kept in `test/` only because the test suite also reads it to confirm the code matches it).
4. **Project Settings → API** → copy the **Project URL** and the **`service_role`** key (click "Reveal" — never the `anon` key).

## Step 3 — Get a Google Places API key

1. Google Cloud Console → enable **"Places API (New)"** for your project.
2. Attach a billing account (Text Search is a paid, metered call).
3. Create an API key. Restrict it to your server's IP if you can — it's read server-side only, never sent to a browser.

## Step 4 — Configure environment variables

```bash
cp .env.example .env
```
Fill in at minimum: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANALYZE_API_KEY` (make up a long random string), `GOOGLE_PLACES_API_KEY`. If `SUPABASE_URL` is a real project (not `localhost`), also set `ANALYZE_CONFIRM_REMOTE_DB` to that exact hostname — the code refuses to write anywhere else without it, on purpose.

Load them into your shell before running anything:
```bash
set -a; . ./.env; set +a
```

## Step 5 — Run the test suite (sanity check first)

```bash
npm test
```
Expect `175 pass, 0 fail` — every test here is mocked, so this confirms the code itself is healthy *before* you point it at anything real.

## Step 6 — Start the server

```bash
npm start
```
Listens on `http://localhost:8787` (`$PORT` to change it). `GET /api/health` should return `{"ok":true}`.

## Step 7 — Find a campaign to test with

The schema seeded one for you — grab its id from Supabase's SQL editor:
```sql
select id from public.campaigns where slug = 'test-pizza-houston';
```
(If empty, no auth user existed when you ran the schema — see Step 2.2, then re-run just the seed `do $$ ... $$;` block at the bottom of the schema file.)

## Step 8 — Discover some real businesses

```bash
CAMPAIGN_ID="<paste the id from step 7>"

curl -s -X POST http://localhost:8787/api/discover \
  -H "Authorization: Bearer $ANALYZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"campaign_id\":\"$CAMPAIGN_ID\",\"category\":\"pizza\",\"location\":\"Houston, TX\",\"limit\":3}"
```
This creates up to 3 real businesses (from Google) and links each to that campaign. Copy a `business_id` and `website_url` from the response for the next step.

## Step 9 — Analyze one of them (this now also scores it automatically)

```bash
curl -s -X POST http://localhost:8787/api/analyze \
  -H "Authorization: Bearer $ANALYZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"business_id\":\"<business_id from step 8>\",\"website_url\":\"<its website_url, or null>\"}"
```
The response includes 14 evidence-backed website checks, **and** a `scoring` field — every campaign that business is linked to gets scored right after its checks are saved, with no extra call needed. See `README.md`'s "`scoring`" section for the exact shape.

## Step 10 — Verify in Supabase

```sql
-- the business, with its checks summary
select business_name, website_status, online_ordering, online_menu from public.businesses where id = '<business_id>';

-- the score and why it got it
select opportunity_score, priority, score_version from public.campaign_businesses where business_id = '<business_id>';
select rule_key, description, points from public.score_reasons where campaign_business_id =
  (select id from public.campaign_businesses where business_id = '<business_id>' and campaign_id = '<CAMPAIGN_ID>');

-- no duplicate businesses
select source_id, count(*) from public.businesses group by source_id having count(*) > 1;  -- expect zero rows
```

## Step 11 — (optional) Deploy

- **Vercel**: `api/analyze.js` and `api/discover.js` are picked up automatically; `vercel.json` sets the function timeout.
- **Netlify**: `netlify/functions/analyze.mjs` and `discover.mjs` serve the same two routes.
- Set the same env vars in the host's dashboard. Re-check `ANALYZE_CONFIRM_REMOTE_DB` matches your real Supabase host exactly.

---

## Where to go for more detail
- `README.md` — full API reference (request/response shapes, what each check means, privacy/safety notes).
- `INTEGRATION-TEST.md` — a deeper walkthrough specifically for testing discovery against real Google + Supabase, with more verification SQL.

## What's not built yet
No dashboard, no outreach/email, no 24/7 automation. Scoring is wired into analysis but not yet gated by anything (it scores unconditionally once checks are saved) — that's as far as it's been taken.
