create table if not exists public.command_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  command_run_id uuid not null references public.command_runs(id) on delete cascade,
  mission_type_key text not null references public.command_mission_types(mission_type_key),
  state_code text not null,
  status text not null default 'QUEUED',
  current_stage text,
  research_query text,
  result_count integer not null default 0,
  evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(command_run_id)
);

create table if not exists public.command_discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references public.command_discovery_runs(id) on delete cascade,
  mission_type_key text not null,
  state_code text not null,
  organization_name text not null,
  organization_type text,
  official_website text,
  relevant_program text,
  qualification_summary text,
  commercial_fit text,
  decision_maker_name text,
  decision_maker_title text,
  decision_maker_email text,
  source_urls jsonb not null default '[]'::jsonb,
  source_verified boolean not null default false,
  duplicate_status text not null default 'NOT_CHECKED',
  review_status text not null default 'PENDING_REVIEW',
  prospect_score numeric,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists command_discovery_candidates_lookup_idx on public.command_discovery_candidates(mission_type_key,state_code,review_status);
create unique index if not exists command_discovery_candidates_run_name_uq on public.command_discovery_candidates(discovery_run_id,lower(organization_name));

create table if not exists public.business_development_registry (
  id uuid primary key default gen_random_uuid(), state_code text not null, organization_name text not null, organization_type text,
  official_website text, relevant_program text, qualification_summary text, decision_maker_name text, decision_maker_title text,
  decision_maker_email text, official_sources jsonb not null default '[]'::jsonb, verified boolean not null default false,
  status text not null default 'ACTIVE', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(state_code,organization_name)
);
create table if not exists public.opportunity_partner_registry (
  id uuid primary key default gen_random_uuid(), state_code text not null, organization_name text not null, organization_type text,
  official_website text, relevant_program text, qualification_summary text, decision_maker_name text, decision_maker_title text,
  decision_maker_email text, official_sources jsonb not null default '[]'::jsonb, verified boolean not null default false,
  status text not null default 'ACTIVE', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(state_code,organization_name)
);
create table if not exists public.institutional_buyer_registry (
  id uuid primary key default gen_random_uuid(), state_code text not null, organization_name text not null, organization_type text,
  official_website text, relevant_program text, qualification_summary text, commercial_fit text, decision_maker_name text,
  decision_maker_title text, decision_maker_email text, official_sources jsonb not null default '[]'::jsonb,
  verified boolean not null default false, prospect_score numeric, status text not null default 'ACTIVE',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(state_code,organization_name)
);

alter table public.command_discovery_runs enable row level security;
alter table public.command_discovery_candidates enable row level security;
alter table public.business_development_registry enable row level security;
alter table public.opportunity_partner_registry enable row level security;
alter table public.institutional_buyer_registry enable row level security;

drop policy if exists command_discovery_runs_operator_read on public.command_discovery_runs;
create policy command_discovery_runs_operator_read on public.command_discovery_runs for select to authenticated using (public.command_is_operator());
drop policy if exists command_discovery_candidates_operator_read on public.command_discovery_candidates;
create policy command_discovery_candidates_operator_read on public.command_discovery_candidates for select to authenticated using (public.command_is_operator());
drop policy if exists business_development_registry_operator_read on public.business_development_registry;
create policy business_development_registry_operator_read on public.business_development_registry for select to authenticated using (public.command_is_operator());
drop policy if exists opportunity_partner_registry_operator_read on public.opportunity_partner_registry;
create policy opportunity_partner_registry_operator_read on public.opportunity_partner_registry for select to authenticated using (public.command_is_operator());
drop policy if exists institutional_buyer_registry_operator_read on public.institutional_buyer_registry;
create policy institutional_buyer_registry_operator_read on public.institutional_buyer_registry for select to authenticated using (public.command_is_operator());

revoke all on public.command_discovery_runs, public.command_discovery_candidates, public.business_development_registry, public.opportunity_partner_registry, public.institutional_buyer_registry from anon, authenticated;
grant select on public.command_discovery_runs, public.command_discovery_candidates, public.business_development_registry, public.opportunity_partner_registry, public.institutional_buyer_registry to authenticated;
grant all on public.command_discovery_runs, public.command_discovery_candidates, public.business_development_registry, public.opportunity_partner_registry, public.institutional_buyer_registry to service_role;