-- =====================================================================
-- AllSafe Local Business Website Opportunity Finder -- MVP schema
-- Target : Supabase (Postgres 15+). Run once, top to bottom, in the SQL
--          Editor of a fresh project (the script is not re-runnable;
--          a teardown block is at the bottom, commented out).
--
-- RELATIONSHIPS
--
--   auth.users (owner)
--       |
--       +-- campaigns ----------------------+
--       |                                   |  (many-to-many)
--       +-- businesses ---- campaign_businesses
--              |                  |   (per-campaign score, tier, lead status)
--              |                  |
--              +-- checks <-------+-- score_reasons  (each reason -> exactly one
--              |   (append-only        primary check row = its evidence)
--              |    evidence log)
--              |
--              +-- outreach  (drafts/sends per campaign_business)
--                     |
--                     +-- replies --(unsubscribe)--> suppression
--
--   events = append-only audit history for everything above.
--
-- KEY RULES ENFORCED IN THE DATABASE
--   * check result is yes / no / unknown / not_applicable; yes/no MUST carry
--     evidence, otherwise the row has to be 'unknown'.
--   * checks are append-only history; one row per (business, type) is
--     is_current. Evidence columns cannot be edited after insert.
--   * every score_reason points at a check that belongs to the same business.
--   * auto_send defaults to false per campaign and cannot be turned on
--     without a send limit and a postal address (CAN-SPAM).
--   * outreach cannot be approved/queued/sent if the recipient is
--     suppressed, the lead is opted out / interested / customer, or the
--     business has stale or missing required checks.
--   * an 'unsubscribe' reply auto-suppresses the sender and cancels
--     pending outreach; positive replies stop automatic follow-ups.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------

create type public.campaign_status as enum ('draft', 'active', 'paused', 'archived');

-- Answer to "does the business have X?" (or, for quality checks, "is X good?").
-- 'unknown' = could not verify. 'not_applicable' = irrelevant for this industry.
create type public.check_result as enum ('yes', 'no', 'unknown', 'not_applicable');

create type public.check_type as enum (
  'website_present',      -- yes = a dedicated website exists
  'website_reachable',    -- yes = loads without error
  'website_modern',       -- yes = not visibly outdated
  'mobile_friendly',      -- yes = responsive / usable on mobile
  'clear_cta',            -- yes = obvious contact / booking / order CTA
  'good_navigation',      -- yes = navigation is clear
  'hours_and_location',   -- yes = hours and address shown on site
  'online_menu',          -- yes = menu viewable online (not just a PDF/social post)
  'online_ordering',      -- yes = any online ordering
  'direct_ordering',      -- yes = ordering on the business's own site
  'third_party_ordering', -- yes = ordering only via a third-party platform
  'online_booking',       -- yes = online appointment booking
  'reservations',         -- yes = online table reservation
  'contact_form',         -- yes = contact / quote request form
  'social_presence',      -- yes = social profile found
  'phone_listed'          -- yes = public phone number found
);

create type public.website_status as enum (
  'unknown', 'none_found', 'active', 'unreachable', 'broken', 'redirects'
);

create type public.priority_tier as enum ('unscored', 'hot', 'warm', 'low');

create type public.lead_status as enum (
  'new', 'qualified', 'contacted', 'replied', 'interested',
  'meeting', 'customer', 'not_interested', 'disqualified', 'opted_out'
);

create type public.outreach_status as enum (
  'draft', 'pending_approval', 'approved', 'queued',
  'sent', 'delivered', 'bounced', 'failed', 'cancelled'
);

create type public.reply_classification as enum (
  'unclassified', 'interested', 'question', 'not_interested',
  'out_of_office', 'unsubscribe', 'bounce', 'other'
);

create type public.suppression_type as enum ('email', 'domain');

create type public.suppression_reason as enum (
  'opt_out', 'bounce_hard', 'complaint', 'invalid', 'manual'
);

-- ---------------------------------------------------------------------
-- 2. HELPER: updated_at
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. CAMPAIGNS
-- ---------------------------------------------------------------------

create table public.campaigns (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null default auth.uid()
                          references auth.users (id) on delete cascade,
  name                  text not null,
  slug                  text not null,
  status                public.campaign_status not null default 'draft',

  -- targeting
  industry              text not null,
  sub_industries        text[] not null default '{}',
  search_terms          text[] not null default '{}',
  country               text not null default 'US',
  state                 text,
  city                  text,
  postal_codes          text[] not null default '{}',
  goal                  text,
  target_lead_count     int check (target_lead_count is null or target_lead_count > 0),

  -- analysis / scoring config
  required_checks       public.check_type[] not null
                          default array['website_present', 'website_reachable', 'mobile_friendly']::public.check_type[],
  stale_after_days      int not null default 30 check (stale_after_days between 1 and 365),
  score_weights         jsonb not null default '{
      "no_website": 40,
      "no_online_ordering": 25,
      "no_online_booking": 25,
      "no_online_menu": 15,
      "poor_mobile": 20,
      "outdated_website": 20,
      "no_clear_cta": 10,
      "phone_only_process": 15,
      "social_only_presence": 20,
      "poor_navigation": 10
  }'::jsonb,
  hot_min_score         smallint not null default 70 check (hot_min_score between 0 and 100),
  warm_min_score        smallint not null default 40 check (warm_min_score between 0 and 100),

  -- outreach controls (auto_send is OFF by default, per campaign)
  auto_send             boolean not null default false,
  auto_send_min_priority public.priority_tier not null default 'hot',
  daily_send_limit      int not null default 0 check (daily_send_limit >= 0),
  sender_name           text,
  sender_business       text,
  reply_to_email        text,
  sender_postal_address text,   -- required for commercial email (CAN-SPAM)

  config                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint campaigns_slug_unique unique (owner_id, slug),
  constraint campaigns_thresholds check (hot_min_score > warm_min_score),
  constraint campaigns_weights_object check (jsonb_typeof(score_weights) = 'object'),
  constraint campaigns_auto_send_tier check (auto_send_min_priority in ('hot', 'warm')),
  constraint campaigns_auto_send_guard check (
    not auto_send or (daily_send_limit > 0 and sender_postal_address is not null)
  )
);

create index campaigns_owner_status_idx on public.campaigns (owner_id, status);

create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. BUSINESSES  (one row per real-world business, shared across campaigns)
-- ---------------------------------------------------------------------

create table public.businesses (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null default auth.uid()
                           references auth.users (id) on delete cascade,

  business_name          text not null,
  industry               text,
  sub_industry           text,

  address_line           text,
  city                   text,
  state                  text,
  postal_code            text,
  country                text not null default 'US',
  latitude               double precision check (latitude between -90 and 90),
  longitude              double precision check (longitude between -180 and 180),

  website_url            text,
  website_domain         text,   -- normalized host, for dedupe / suppression
  website_status         public.website_status not null default 'unknown',

  public_business_email  text,   -- only publicly listed business emails
  public_business_phone  text,
  whatsapp               text,   -- only where publicly listed
  social_media           jsonb not null default '{}'::jsonb,
  hours                  jsonb,

  -- Denormalized summary of CURRENT checks (maintained by trigger on checks;
  -- checks remain the source of truth).
  online_ordering        public.check_result not null default 'unknown',
  online_menu            public.check_result not null default 'unknown',
  online_booking         public.check_result not null default 'unknown',
  reservation_available  public.check_result not null default 'unknown',
  last_analyzed_at       timestamptz,

  -- provenance
  source                 text not null default 'google_places',
  source_id              text not null,          -- e.g. Google place_id
  source_url             text,
  source_rating          numeric(2, 1),
  source_review_count    int,
  dedupe_key             text,                   -- normalized name+phone/domain fallback
  raw_source             jsonb,

  first_seen_at          timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint businesses_source_unique unique (owner_id, source, source_id)
);

create index businesses_owner_idx        on public.businesses (owner_id);
create index businesses_geo_idx          on public.businesses (owner_id, country, state, city, industry);
create index businesses_domain_idx       on public.businesses (owner_id, website_domain) where website_domain is not null;
create index businesses_dedupe_idx       on public.businesses (owner_id, dedupe_key)     where dedupe_key is not null;
create index businesses_email_idx        on public.businesses (owner_id, lower(public_business_email)) where public_business_email is not null;
create index businesses_last_analyzed_idx on public.businesses (last_analyzed_at);

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. CAMPAIGN_BUSINESSES  (a business can belong to many campaigns;
--    score / tier / lead status are per campaign because weights differ)
-- ---------------------------------------------------------------------

create table public.campaign_businesses (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null default auth.uid()
                          references auth.users (id) on delete cascade,
  campaign_id           uuid not null references public.campaigns (id) on delete cascade,
  business_id           uuid not null references public.businesses (id) on delete cascade,

  lead_status           public.lead_status not null default 'new',
  opportunity_score     smallint check (opportunity_score between 0 and 100),
  priority              public.priority_tier not null default 'unscored',
  opportunity_type      text[] not null default '{}',   -- e.g. {no_website,online_ordering}
  verified_problems     jsonb not null default '[]'::jsonb,
  recommended_features  jsonb not null default '[]'::jsonb,
  score_version         int not null default 0,
  scored_at             timestamptz,
  qualified_at          timestamptz,
  notes                 text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint campaign_businesses_unique unique (campaign_id, business_id),
  -- targets for composite FKs (keeps children consistent with their parent row)
  constraint campaign_businesses_key unique (id, campaign_id, business_id),
  constraint campaign_businesses_score_priority check (
    (opportunity_score is null) = (priority = 'unscored')
  )
);

create index cb_owner_idx          on public.campaign_businesses (owner_id);
create index cb_campaign_rank_idx  on public.campaign_businesses (campaign_id, priority, opportunity_score desc);
create index cb_campaign_status_idx on public.campaign_businesses (campaign_id, lead_status);
create index cb_business_idx       on public.campaign_businesses (business_id);
create index cb_opp_type_idx       on public.campaign_businesses using gin (opportunity_type);

create trigger campaign_businesses_set_updated_at
  before update on public.campaign_businesses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. CHECKS  (append-only evidence log; 'unknown' is a first-class result)
-- ---------------------------------------------------------------------

create table public.checks (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid()
                      references auth.users (id) on delete cascade,
  business_id       uuid not null references public.businesses (id) on delete cascade,

  check_type        public.check_type not null,
  result            public.check_result not null default 'unknown',
  confidence        numeric(3, 2) check (confidence between 0 and 1),

  -- evidence
  evidence_url      text,
  evidence_excerpt  text,
  evidence          jsonb not null default '{}'::jsonb,   -- http status, detected platform, etc.
  method            text not null,                        -- http_fetch | html_parse | places_api | manual ...
  checker_version   text,
  http_status       int,
  error             text,

  checked_at        timestamptz not null default now(),
  expires_at        timestamptz,        -- optional override of the campaign stale window
  is_current        boolean not null default true,
  created_at        timestamptz not null default now(),

  constraint checks_id_business_key unique (id, business_id),

  -- A yes/no/not_applicable answer must be backed by something concrete.
  -- If it cannot be, the honest result is 'unknown'.
  constraint checks_evidence_required check (
    result in ('unknown', 'not_applicable')
    or evidence_url is not null
    or evidence_excerpt is not null
    or evidence <> '{}'::jsonb
  )
);

-- exactly one current row per (business, check type)
create unique index checks_one_current_idx
  on public.checks (business_id, check_type) where is_current;
create index checks_owner_idx        on public.checks (owner_id);
create index checks_business_hist_idx on public.checks (business_id, check_type, checked_at desc);
create index checks_current_age_idx  on public.checks (checked_at) where is_current;
create index checks_current_expiry_idx on public.checks (expires_at) where is_current and expires_at is not null;

-- New current check supersedes the previous current row for that type.
create or replace function public.checks_supersede_previous()
returns trigger
language plpgsql
as $$
begin
  if new.is_current then
    update public.checks
       set is_current = false
     where business_id = new.business_id
       and check_type  = new.check_type
       and is_current;
  end if;
  return new;
end;
$$;

create trigger checks_before_insert_supersede
  before insert on public.checks
  for each row execute function public.checks_supersede_previous();

-- Evidence is immutable: only is_current / expires_at may change afterwards.
create or replace function public.checks_block_evidence_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.business_id, new.check_type, new.result, new.confidence, new.evidence_url,
      new.evidence_excerpt, new.evidence, new.method, new.checker_version,
      new.http_status, new.error, new.checked_at)
     is distinct from
     (old.business_id, old.check_type, old.result, old.confidence, old.evidence_url,
      old.evidence_excerpt, old.evidence, old.method, old.checker_version,
      old.http_status, old.error, old.checked_at)
  then
    raise exception 'checks are append-only: insert a new check instead of editing evidence';
  end if;
  return new;
end;
$$;

create trigger checks_before_update_immutable
  before update on public.checks
  for each row execute function public.checks_block_evidence_edit();

-- Keep businesses' summary columns in sync with current checks.
create or replace function public.refresh_business_summary(p_business_id uuid)
returns void
language sql
as $$
  update public.businesses b
     set online_ordering = coalesce((select k.result from public.checks k
           where k.business_id = b.id and k.check_type = 'online_ordering' and k.is_current), 'unknown'),
         online_menu = coalesce((select k.result from public.checks k
           where k.business_id = b.id and k.check_type = 'online_menu' and k.is_current), 'unknown'),
         online_booking = coalesce((select k.result from public.checks k
           where k.business_id = b.id and k.check_type = 'online_booking' and k.is_current), 'unknown'),
         reservation_available = coalesce((select k.result from public.checks k
           where k.business_id = b.id and k.check_type = 'reservations' and k.is_current), 'unknown'),
         website_status = case
           when (select k.result from public.checks k where k.business_id = b.id
                   and k.check_type = 'website_present' and k.is_current) = 'no'
             then 'none_found'::public.website_status
           when (select k.result from public.checks k where k.business_id = b.id
                   and k.check_type = 'website_present' and k.is_current) = 'yes'
                and (select k.result from public.checks k where k.business_id = b.id
                   and k.check_type = 'website_reachable' and k.is_current) = 'no'
             then 'unreachable'::public.website_status
           when (select k.result from public.checks k where k.business_id = b.id
                   and k.check_type = 'website_present' and k.is_current) = 'yes'
                and (select k.result from public.checks k where k.business_id = b.id
                   and k.check_type = 'website_reachable' and k.is_current) = 'yes'
             then 'active'::public.website_status
           else b.website_status
         end,
         last_analyzed_at = (select max(k.checked_at) from public.checks k
                              where k.business_id = b.id and k.is_current)
   where b.id = p_business_id;
$$;

create or replace function public.checks_after_insert_refresh()
returns trigger
language plpgsql
as $$
begin
  perform public.refresh_business_summary(new.business_id);
  return new;
end;
$$;

create trigger checks_after_insert_summary
  after insert on public.checks
  for each row execute function public.checks_after_insert_refresh();

-- ---------------------------------------------------------------------
-- 7. SCORE_REASONS  (every point is traceable to the check that produced it)
-- ---------------------------------------------------------------------

create table public.score_reasons (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid()
                         references auth.users (id) on delete cascade,
  campaign_id          uuid not null,
  business_id          uuid not null,
  campaign_business_id uuid not null,
  score_version        int not null,
  rule_key             text not null,        -- key from campaigns.score_weights
  description          text not null,        -- human-readable reason
  points               smallint not null check (points between -100 and 100),

  check_id             uuid not null,        -- primary evidence (REQUIRED)
  supporting_check_ids uuid[] not null default '{}',  -- extra evidence for derived rules

  created_at           timestamptz not null default now(),

  constraint score_reasons_unique unique (campaign_business_id, score_version, rule_key),

  -- reason must belong to the same campaign/business pair...
  constraint score_reasons_cb_fk foreign key (campaign_business_id, campaign_id, business_id)
    references public.campaign_businesses (id, campaign_id, business_id) on delete cascade,
  -- ...and its evidence must be a check of that same business. (NO ACTION, not
  -- CASCADE: a check that backs a score cannot be deleted on its own.)
  constraint score_reasons_check_fk foreign key (check_id, business_id)
    references public.checks (id, business_id)
);

create index score_reasons_owner_idx on public.score_reasons (owner_id);
create index score_reasons_cb_idx    on public.score_reasons (campaign_business_id, score_version);
create index score_reasons_check_idx on public.score_reasons (check_id);

-- Sum the reasons for a score version, cap at 100, set score + tier.
create or replace function public.apply_score(p_campaign_business_id uuid, p_score_version int)
returns smallint
language plpgsql
as $$
declare
  v_total smallint;
  v_hot   smallint;
  v_warm  smallint;
  v_tier  public.priority_tier;
begin
  select c.hot_min_score, c.warm_min_score
    into v_hot, v_warm
    from public.campaign_businesses cb
    join public.campaigns c on c.id = cb.campaign_id
   where cb.id = p_campaign_business_id;

  if not found then
    raise exception 'campaign_business % not found', p_campaign_business_id;
  end if;

  select least(100, greatest(0, coalesce(sum(sr.points), 0)))::smallint
    into v_total
    from public.score_reasons sr
   where sr.campaign_business_id = p_campaign_business_id
     and sr.score_version = p_score_version;

  v_tier := case
              when v_total >= v_hot  then 'hot'::public.priority_tier
              when v_total >= v_warm then 'warm'::public.priority_tier
              else 'low'::public.priority_tier
            end;

  update public.campaign_businesses
     set opportunity_score = v_total,
         priority          = v_tier,
         score_version     = p_score_version,
         scored_at         = now()
   where id = p_campaign_business_id;

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. STALENESS  (re-analyze before outreach)
-- A required check is stale when it is missing, or past expires_at, or
-- (if expires_at is null) older than the campaign's stale_after_days.
-- ---------------------------------------------------------------------

create or replace function public.campaign_business_needs_reanalysis(p_campaign_business_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from public.campaign_businesses cb
      join public.campaigns c on c.id = cb.campaign_id
      cross join lateral unnest(c.required_checks) as r(check_type)
      left join public.checks k
             on k.business_id = cb.business_id
            and k.check_type  = r.check_type
            and k.is_current
     where cb.id = p_campaign_business_id
       and (
             k.id is null
          or coalesce(k.expires_at, k.checked_at + make_interval(days => c.stale_after_days)) <= now()
       )
  );
$$;

-- Current checks that are past their stale time, per campaign.
create view public.v_stale_checks with (security_invoker = true) as
select cb.campaign_id,
       cb.id  as campaign_business_id,
       k.business_id,
       k.id   as check_id,
       k.check_type,
       k.checked_at,
       coalesce(k.expires_at, k.checked_at + make_interval(days => c.stale_after_days)) as stale_at
  from public.checks k
  join public.campaign_businesses cb on cb.business_id = k.business_id
  join public.campaigns c            on c.id = cb.campaign_id
 where k.is_current
   and coalesce(k.expires_at, k.checked_at + make_interval(days => c.stale_after_days)) <= now();

-- Work queue for the Analyze stage: missing or stale required checks.
create view public.v_reanalysis_queue with (security_invoker = true) as
select cb.campaign_id,
       cb.id          as campaign_business_id,
       cb.business_id,
       cb.priority,
       cb.opportunity_score,
       cb.lead_status,
       f.missing_checks,
       f.stale_checks,
       f.last_checked_at
  from public.campaign_businesses cb
  join public.campaigns c on c.id = cb.campaign_id
  cross join lateral (
    select count(*) filter (where k.id is null) as missing_checks,
           count(*) filter (
             where k.id is not null
               and coalesce(k.expires_at, k.checked_at + make_interval(days => c.stale_after_days)) <= now()
           ) as stale_checks,
           max(k.checked_at) as last_checked_at
      from unnest(c.required_checks) as r(check_type)
      left join public.checks k
             on k.business_id = cb.business_id
            and k.check_type  = r.check_type
            and k.is_current
  ) f
 where c.status <> 'archived'
   and cb.lead_status not in ('opted_out', 'disqualified', 'customer')
   and (f.missing_checks > 0 or f.stale_checks > 0);

-- ---------------------------------------------------------------------
-- 9. SUPPRESSION  (global do-not-contact list, per owner)
-- ---------------------------------------------------------------------

create table public.suppression (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  type        public.suppression_type not null default 'email',
  value       text not null,
  reason      public.suppression_reason not null,
  reply_id    uuid,        -- FK added after replies exists
  note        text,
  created_at  timestamptz not null default now(),

  constraint suppression_unique unique (owner_id, type, value),
  constraint suppression_value_normalized check (value = lower(btrim(value)) and value <> '')
);

create index suppression_owner_idx on public.suppression (owner_id);

create or replace function public.is_suppressed(p_owner_id uuid, p_email text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from public.suppression s
     where s.owner_id = p_owner_id
       and (
            (s.type = 'email'  and s.value = lower(btrim(p_email)))
         or (s.type = 'domain' and s.value = lower(split_part(btrim(p_email), '@', 2)))
       )
  );
$$;

-- ---------------------------------------------------------------------
-- 10. OUTREACH  (drafts and send history; NO sending logic in this schema)
-- ---------------------------------------------------------------------

create table public.outreach (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid()
                         references auth.users (id) on delete cascade,
  campaign_id          uuid not null,
  business_id          uuid not null,
  campaign_business_id uuid not null,

  channel              text not null default 'email' check (channel = 'email'),
  sequence_step        smallint not null default 1 check (sequence_step >= 1),
  status               public.outreach_status not null default 'draft',

  to_email             text not null,
  subject              text not null,
  body_text            text not null,
  body_html            text,

  -- "Only verified claims": checks the copy relies on, and which claim maps to which check.
  evidence_check_ids   uuid[] not null default '{}',
  claims               jsonb not null default '[]'::jsonb,   -- [{ "text": "...", "check_id": "..." }]

  approval_method      text check (approval_method in ('human', 'auto')),
  approved_by          uuid references auth.users (id) on delete set null,
  approved_at          timestamptz,
  scheduled_for        timestamptz,
  sent_at              timestamptz,
  provider             text,
  provider_message_id  text,
  error                text,
  unsubscribe_token    uuid not null default gen_random_uuid(),
  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint outreach_cb_fk foreign key (campaign_business_id, campaign_id, business_id)
    references public.campaign_businesses (id, campaign_id, business_id),
  constraint outreach_unsubscribe_token_unique unique (unsubscribe_token),
  constraint outreach_to_email_format check (
    to_email = lower(btrim(to_email)) and to_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint outreach_approval_required check (
    status in ('draft', 'pending_approval', 'cancelled', 'failed')
    or (approved_at is not null and approval_method is not null)
  ),
  constraint outreach_human_approver check (
    approval_method is distinct from 'human' or approved_by is not null
  ),
  constraint outreach_needs_evidence check (
    status in ('draft', 'pending_approval', 'cancelled', 'failed')
    or cardinality(evidence_check_ids) > 0
  )
);

-- one live email per lead per sequence step (cancelled drafts can be redone)
create unique index outreach_step_unique_idx
  on public.outreach (campaign_business_id, sequence_step) where status <> 'cancelled';
create index outreach_owner_idx     on public.outreach (owner_id);
create index outreach_campaign_status_idx on public.outreach (campaign_id, status);
create index outreach_cb_idx        on public.outreach (campaign_business_id);
create index outreach_to_email_idx  on public.outreach (owner_id, to_email);
create index outreach_due_idx       on public.outreach (scheduled_for) where status in ('approved', 'queued');

create trigger outreach_set_updated_at
  before update on public.outreach
  for each row execute function public.set_updated_at();

-- Gate: nothing moves to approved/queued/sent unless it is safe to contact.
create or replace function public.enforce_outreach_gate()
returns trigger
language plpgsql
as $$
declare
  v_lead  public.lead_status;
  v_auto  boolean;
begin
  if new.status in ('approved', 'queued', 'sent') then

    -- on UPDATE, only gate real status transitions
    if tg_op = 'UPDATE' then
      if old.status = new.status then
        return new;
      end if;
    end if;

    if public.is_suppressed(new.owner_id, new.to_email) then
      raise exception 'blocked: % is on the suppression list', new.to_email;
    end if;

    select cb.lead_status into v_lead
      from public.campaign_businesses cb where cb.id = new.campaign_business_id;
    if v_lead in ('opted_out', 'disqualified', 'not_interested', 'interested', 'meeting', 'customer') then
      raise exception 'blocked: lead status is %, automatic outreach not allowed', v_lead;
    end if;

    if public.campaign_business_needs_reanalysis(new.campaign_business_id) then
      raise exception 'blocked: stale or missing required checks; re-analyze before outreach';
    end if;

    if new.approval_method = 'auto' then
      select c.auto_send into v_auto from public.campaigns c where c.id = new.campaign_id;
      if not coalesce(v_auto, false) then
        raise exception 'blocked: campaign auto_send is off';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger outreach_gate
  before insert or update of status on public.outreach
  for each row execute function public.enforce_outreach_gate();

-- ---------------------------------------------------------------------
-- 11. REPLIES
-- ---------------------------------------------------------------------

create table public.replies (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null default auth.uid()
                              references auth.users (id) on delete cascade,
  outreach_id               uuid references public.outreach (id),   -- null if unmatched
  business_id               uuid references public.businesses (id) on delete set null,

  received_at               timestamptz not null default now(),
  from_email                text,
  subject                   text,
  body_text                 text,
  provider_message_id       text,
  in_reply_to               text,
  raw                       jsonb,

  classification            public.reply_classification not null default 'unclassified',
  classification_confidence numeric(3, 2) check (classification_confidence between 0 and 1),
  classified_by             text check (classified_by in ('ai', 'human')),

  handled                   boolean not null default false,
  handled_at                timestamptz,
  handled_by                uuid references auth.users (id) on delete set null,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index replies_owner_idx    on public.replies (owner_id);
create index replies_outreach_idx on public.replies (outreach_id);
create index replies_business_idx on public.replies (business_id);
create index replies_inbox_idx    on public.replies (owner_id, received_at desc) where not handled;

create trigger replies_set_updated_at
  before update on public.replies
  for each row execute function public.set_updated_at();

alter table public.suppression
  add constraint suppression_reply_fk foreign key (reply_id)
  references public.replies (id) on delete set null;

-- ---------------------------------------------------------------------
-- 12. EVENTS  (append-only history)
-- ---------------------------------------------------------------------

create table public.events (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  event_type  text not null,            -- e.g. business.discovered, check.recorded, outreach.approved
  entity_type text not null,            -- campaign | business | check | outreach | reply | suppression
  entity_id   uuid,
  campaign_id uuid references public.campaigns (id) on delete set null,
  business_id uuid references public.businesses (id) on delete set null,
  actor       text not null default 'system',   -- system | ai | user:<uuid>
  payload     jsonb not null default '{}'::jsonb
);

create index events_owner_time_idx    on public.events (owner_id, occurred_at desc);
create index events_entity_idx        on public.events (entity_type, entity_id, occurred_at desc);
create index events_business_idx      on public.events (business_id, occurred_at desc);
create index events_campaign_idx      on public.events (campaign_id, occurred_at desc);
create index events_type_idx          on public.events (event_type, occurred_at desc);

create or replace function public.events_block_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'events are append-only';
end;
$$;

create trigger events_no_update
  before update on public.events
  for each row execute function public.events_block_update();

-- ---------------------------------------------------------------------
-- 13. REPLY HANDLING + AUTO_SEND AUDIT TRIGGERS
-- SECURITY DEFINER so they can write suppression/events regardless of the
-- caller's table grants; search_path is pinned and all names are qualified.
-- ---------------------------------------------------------------------

create or replace function public.handle_reply_classification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cb    uuid;
  v_camp  uuid;
  v_biz   uuid;
begin
  if tg_op = 'UPDATE' and new.classification is not distinct from old.classification then
    return new;
  end if;

  if new.outreach_id is not null then
    select o.campaign_business_id, o.campaign_id, o.business_id
      into v_cb, v_camp, v_biz
      from public.outreach o
     where o.id = new.outreach_id;
  end if;

  -- Opt-out: suppress immediately, whatever else happens.
  if new.classification = 'unsubscribe' and new.from_email is not null then
    insert into public.suppression (owner_id, type, value, reason, reply_id, note)
    values (new.owner_id, 'email', lower(btrim(new.from_email)), 'opt_out', new.id,
            'auto: reply classified as unsubscribe')
    on conflict (owner_id, type, value) do nothing;
  end if;

  -- Human replies stop automatic follow-ups.
  if v_cb is not null
     and new.classification in ('unsubscribe', 'interested', 'question', 'not_interested') then

    update public.campaign_businesses cb
       set lead_status = case new.classification
             when 'unsubscribe'     then 'opted_out'::public.lead_status
             when 'interested'      then 'interested'::public.lead_status
             when 'not_interested'  then 'not_interested'::public.lead_status
             else 'replied'::public.lead_status
           end
     where cb.id = v_cb
       and (new.classification = 'unsubscribe'
            or cb.lead_status in ('new', 'qualified', 'contacted', 'replied'));

    update public.outreach o
       set status = 'cancelled'
     where o.campaign_business_id = v_cb
       and o.status in ('draft', 'pending_approval', 'approved', 'queued');

    insert into public.events (owner_id, event_type, entity_type, entity_id, campaign_id, business_id, actor, payload)
    values (new.owner_id, 'reply.classified', 'reply', new.id, v_camp, v_biz, 'system',
            jsonb_build_object('classification', new.classification, 'followups_cancelled', true));
  end if;

  return new;
end;
$$;

create trigger replies_handle_classification
  after insert or update of classification on public.replies
  for each row execute function public.handle_reply_classification();

create or replace function public.log_auto_send_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.auto_send is distinct from old.auto_send then
    insert into public.events (owner_id, event_type, entity_type, entity_id, campaign_id, actor, payload)
    values (new.owner_id, 'campaign.auto_send_changed', 'campaign', new.id, new.id,
            coalesce('user:' || (select auth.uid())::text, 'system'),
            jsonb_build_object('from', old.auto_send, 'to', new.auto_send));
  end if;
  return new;
end;
$$;

create trigger campaigns_log_auto_send
  after update of auto_send on public.campaigns
  for each row execute function public.log_auto_send_change();

-- ---------------------------------------------------------------------
-- 14. REPORT VIEW  (the MVP report)
-- ---------------------------------------------------------------------

create view public.v_campaign_report with (security_invoker = true) as
select cb.campaign_id,
       cb.id            as campaign_business_id,
       b.id             as business_id,
       b.business_name,
       b.city,
       b.state,
       b.website_url,
       b.website_status,
       b.online_ordering,
       b.online_menu,
       b.online_booking,
       b.reservation_available,
       cb.opportunity_type,
       cb.opportunity_score,
       cb.priority,
       cb.lead_status,
       cb.scored_at,
       public.campaign_business_needs_reanalysis(cb.id) as needs_reanalysis
  from public.campaign_businesses cb
  join public.businesses b on b.id = cb.business_id;

-- Every point in a score, with its evidence.
create view public.v_score_traceability with (security_invoker = true) as
select sr.campaign_business_id,
       sr.score_version,
       sr.rule_key,
       sr.description,
       sr.points,
       k.id          as check_id,
       k.check_type,
       k.result,
       k.evidence_url,
       k.evidence_excerpt,
       k.checked_at,
       k.is_current  as evidence_still_current
  from public.score_reasons sr
  join public.checks k on k.id = sr.check_id;

-- ---------------------------------------------------------------------
-- 15. ROW LEVEL SECURITY
--
-- Model: single-owner rows (owner_id = auth.uid()). The dashboard uses the
-- anon key + a logged-in user, so these policies apply.
-- The pipeline (Netlify/Vercel functions) must use the SERVICE ROLE key,
-- server-side only: it bypasses RLS and is the only writer of checks,
-- score_reasons, events, and send-related outreach statuses.
-- NEVER expose the service role key in browser code.
-- ---------------------------------------------------------------------

alter table public.campaigns           enable row level security;
alter table public.businesses          enable row level security;
alter table public.campaign_businesses enable row level security;
alter table public.checks              enable row level security;
alter table public.score_reasons       enable row level security;
alter table public.outreach            enable row level security;
alter table public.replies             enable row level security;
alter table public.suppression         enable row level security;
alter table public.events              enable row level security;

-- Full owner access
create policy campaigns_owner_all on public.campaigns
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy businesses_owner_all on public.businesses
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy cb_owner_all on public.campaign_businesses
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Read-only from the dashboard (written by the pipeline)
create policy checks_owner_select on public.checks
  for select to authenticated using (owner_id = (select auth.uid()));

create policy score_reasons_owner_select on public.score_reasons
  for select to authenticated using (owner_id = (select auth.uid()));

create policy events_owner_select on public.events
  for select to authenticated using (owner_id = (select auth.uid()));

-- Outreach: users can draft, approve and cancel; only the service role can
-- move a message to queued/sent/delivered/bounced/failed.
create policy outreach_owner_select on public.outreach
  for select to authenticated using (owner_id = (select auth.uid()));

create policy outreach_owner_insert on public.outreach
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and status in ('draft', 'pending_approval'));

create policy outreach_owner_update on public.outreach
  for update to authenticated
  using (owner_id = (select auth.uid()) and status in ('draft', 'pending_approval', 'approved'))
  with check (
    owner_id = (select auth.uid())
    and status in ('draft', 'pending_approval', 'approved', 'cancelled')
    and (status <> 'approved'
         or (approval_method = 'human' and approved_by = (select auth.uid())))
  );

-- Replies: read, and mark handled / reclassify
create policy replies_owner_select on public.replies
  for select to authenticated using (owner_id = (select auth.uid()));

create policy replies_owner_update on public.replies
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Suppression: read and add only. No update/delete from the client, so an
-- opt-out cannot be removed by accident (service role can, if ever needed).
create policy suppression_owner_select on public.suppression
  for select to authenticated using (owner_id = (select auth.uid()));

create policy suppression_owner_insert on public.suppression
  for insert to authenticated with check (owner_id = (select auth.uid()));

-- Table privileges (belt and braces on top of RLS)
revoke all on
  public.campaigns, public.businesses, public.campaign_businesses, public.checks,
  public.score_reasons, public.outreach, public.replies, public.suppression, public.events,
  public.v_stale_checks, public.v_reanalysis_queue, public.v_campaign_report, public.v_score_traceability
from anon;

revoke insert, update, delete on public.checks, public.score_reasons, public.events from authenticated;
revoke update, delete on public.suppression from authenticated;
revoke delete on public.outreach, public.replies from authenticated;

-- Functions: signed-in users only (anon and PUBLIC cannot call them)
revoke execute on function public.apply_score(uuid, int)                        from public, anon;
revoke execute on function public.refresh_business_summary(uuid)               from public, anon;
revoke execute on function public.campaign_business_needs_reanalysis(uuid)     from public, anon;
revoke execute on function public.is_suppressed(uuid, text)                     from public, anon;
revoke execute on function public.handle_reply_classification()                from public, anon, authenticated;
revoke execute on function public.log_auto_send_change()                       from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 16. SEED: test campaign (auto_send stays OFF)
-- Uses the first auth user. Sign up once in Supabase Auth, then run this
-- block (or the whole script after signing up).
-- ---------------------------------------------------------------------

do $$
declare
  v_owner uuid;
begin
  select id into v_owner from auth.users order by created_at asc limit 1;

  if v_owner is null then
    raise notice 'No auth user yet: seed campaign skipped. Create a user, then re-run this block.';
    return;
  end if;

  insert into public.campaigns (
    owner_id, name, slug, status, industry, sub_industries, search_terms,
    country, state, city, goal, target_lead_count, required_checks,
    stale_after_days, sender_name, sender_business, config
  ) values (
    v_owner,
    'TEST - Pizza shops, Houston TX',
    'test-pizza-houston',
    'draft',
    'Pizza',
    array['pizza shop', 'pizza restaurant', 'takeaway pizza'],
    array['pizza shops', 'pizza restaurants', 'takeaway pizza', 'local pizza businesses'],
    'US', 'TX', 'Houston',
    'Find pizza businesses without a website or online ordering.',
    100,
    array['website_present', 'website_reachable', 'mobile_friendly',
          'online_menu', 'online_ordering', 'direct_ordering', 'clear_cta']::public.check_type[],
    30,
    'Sanjay',
    'AllSafe IT Solution',
    '{"seed": true, "note": "test campaign - safe to delete"}'::jsonb
  )
  on conflict (owner_id, slug) do nothing;
end;
$$;

commit;

-- =====================================================================
-- SMOKE TESTS (run manually; wrap in a transaction and roll back)
-- =====================================================================
-- 1) auto_send guard should fail (no limit / no postal address):
--    update public.campaigns set auto_send = true where slug = 'test-pizza-houston';
-- 2) yes/no without evidence should fail:
--    insert into public.checks (business_id, check_type, result, method)
--    values ('<business uuid>', 'website_present', 'no', 'manual');
-- 3) same insert with result 'unknown' should succeed.
-- 4) Reports:
--    select * from public.v_campaign_report where campaign_id = '<campaign uuid>';
--    select * from public.v_reanalysis_queue;
--    select * from public.v_score_traceability where campaign_business_id = '<cb uuid>';

-- =====================================================================
-- TEARDOWN (destructive; test projects only)
-- =====================================================================
-- drop view  if exists public.v_score_traceability, public.v_campaign_report,
--                      public.v_reanalysis_queue, public.v_stale_checks;
-- drop table if exists public.events, public.replies, public.outreach, public.suppression,
--                      public.score_reasons, public.checks, public.campaign_businesses,
--                      public.businesses, public.campaigns cascade;
-- drop function if exists public.apply_score(uuid, int), public.refresh_business_summary(uuid),
--   public.campaign_business_needs_reanalysis(uuid), public.is_suppressed(uuid, text),
--   public.checks_supersede_previous(), public.checks_block_evidence_edit(),
--   public.checks_after_insert_refresh(), public.enforce_outreach_gate(),
--   public.events_block_update(), public.handle_reply_classification(),
--   public.log_auto_send_change(), public.set_updated_at();
-- drop type if exists public.suppression_reason, public.suppression_type,
--   public.reply_classification, public.outreach_status, public.lead_status,
--   public.priority_tier, public.website_status, public.check_type,
--   public.check_result, public.campaign_status;
