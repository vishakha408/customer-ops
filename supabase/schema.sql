-- ============================================================================
-- AI-Powered Customer Operations System - Supabase schema
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: objects are created only if they do not already exist.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enum-like check constraints (kept as text + CHECK so values are easy to
-- extend later without migrations).
-- ---------------------------------------------------------------------------

create table if not exists public.customers (
  id                uuid primary key default gen_random_uuid(),
  email             text not null unique,
  full_name         text,
  phone             text,
  plan              text not null default 'starter',
  lifetime_value    numeric(12, 2) not null default 0,
  open_requests     integer not null default 0,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.requests (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid references public.customers (id) on delete set null,
  -- email transport metadata
  thread_id          text,
  message_id         text,
  source             text not null default 'email'
                       check (source in ('email', 'webhook', 'dashboard')),
  subject            text not null default '(no subject)',
  body               text not null default '',
  sender_email       text not null,
  -- AI analysis (written by the n8n AI agent)
  intent             text,
  category           text,
  priority           text not null default 'medium'
                       check (priority in ('low', 'medium', 'high', 'urgent')),
  sentiment          text not null default 'neutral'
                       check (sentiment in ('positive', 'neutral', 'negative', 'angry')),
  summary            text,
  recommended_action text,
  decision           text not null default 'pending'
                       check (decision in ('pending', 'auto_resolve', 'human_review', 'escalate')),
  confidence         numeric(4, 3),
  raw_analysis       jsonb,
  -- workflow state
  status             text not null default 'new'
                       check (status in (
                         'new', 'analyzing', 'auto_handled',
                         'pending_review', 'in_progress', 'resolved', 'failed'
                       )),
  assigned_to        text,
  resolution_note    text,
  reply_sent         boolean not null default false,
  last_error         text,
  analyzed_at        timestamptz,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.request_activities (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests (id) on delete cascade,
  type        text not null default 'status_change',
  actor       text not null default 'system'
                check (actor in ('system', 'agent', 'n8n', 'human')),
  message     text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists requests_status_idx     on public.requests (status);
create index if not exists requests_priority_idx   on public.requests (priority);
create index if not exists requests_created_at_idx on public.requests (created_at desc);
create index if not exists requests_customer_idx   on public.requests (customer_id);
create index if not exists activities_request_idx  on public.request_activities (request_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

drop trigger if exists requests_updated_at on public.requests;
create trigger requests_updated_at
  before update on public.requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Activity helper: any status change automatically gets a timeline entry,
-- even if a caller forgets to insert one.
-- ---------------------------------------------------------------------------
create or replace function public.log_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    insert into public.request_activities (request_id, type, actor, message, metadata)
    values (
      new.id,
      'status_change',
      case when new.assigned_to is not null and new.assigned_to <> ''
           then 'human' else 'system' end,
      format('Status changed from %s to %s', old.status, new.status),
      jsonb_build_object('from', old.status, 'to', new.status)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists requests_status_activity on public.requests;
create trigger requests_status_activity
  after update of status on public.requests
  for each row execute function public.log_status_change();

-- Keep customers.open_requests in sync
create or replace function public.refresh_open_requests()
returns trigger
language plpgsql
as $$
begin
  update public.customers c
     set open_requests = (
       select count(*) from public.requests r
        where r.customer_id = c.id
          and r.status in ('new', 'analyzing', 'pending_review', 'in_progress')
     )
  where c.id = coalesce(new.customer_id, old.customer_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists requests_refresh_open_requests on public.requests;
create trigger requests_refresh_open_requests
  after insert or update or delete on public.requests
  for each row execute function public.refresh_open_requests();

-- ---------------------------------------------------------------------------
-- Dashboard metrics RPC (one round-trip for the dashboard header cards)
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_metrics()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'total',            count(*) filter (where true),
    'new',              count(*) filter (where status = 'new'),
    'analyzing',        count(*) filter (where status = 'analyzing'),
    'pending_review',   count(*) filter (where status = 'pending_review'),
    'in_progress',      count(*) filter (where status = 'in_progress'),
    'auto_handled',     count(*) filter (where status = 'auto_handled'),
    'resolved',         count(*) filter (where status = 'resolved'),
    'failed',           count(*) filter (where status = 'failed'),
    'urgent_open',      count(*) filter (
                          where priority = 'urgent'
                            and status in ('new', 'analyzing', 'pending_review', 'in_progress')
                        ),
    'negative_sentiment_open', count(*) filter (
                          where sentiment in ('negative', 'angry')
                            and status in ('new', 'analyzing', 'pending_review', 'in_progress')
                        ),
    'avg_minutes_to_resolve', (
      select round(avg(extract(epoch from (resolved_at - created_at)) / 60.0))::int
        from public.requests
       where resolved_at is not null and created_at is not null
    )
  )
  from public.requests;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: dashboard + n8n use the service role (bypasses RLS);
-- anon key only gets read access, so public keys stay safe.
-- ---------------------------------------------------------------------------
alter table public.customers          enable row level security;
alter table public.requests           enable row level security;
alter table public.request_activities enable row level security;

drop policy if exists "anon can read requests" on public.requests;
create policy "anon can read requests"
  on public.requests for select
  to anon
  using (true);

drop policy if exists "anon can read customers" on public.customers;
create policy "anon can read customers"
  on public.customers for select
  to anon
  using (true);

drop policy if exists "anon can read activities" on public.request_activities;
create policy "anon can read activities"
  on public.request_activities for select
  to anon
  using (true);

-- No insert/update/delete policies for anon: writes go through the
-- service-role key (dashboard API routes + n8n).
