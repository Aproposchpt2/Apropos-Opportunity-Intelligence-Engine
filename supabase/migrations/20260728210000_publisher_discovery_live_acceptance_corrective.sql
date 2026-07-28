-- APIOS Publisher Discovery Live Acceptance Test corrective engineering
-- Document: APIOS-CC-PUBLISHER-DISCOVERY-LAT-001-CORRECTIVE-01
-- Discovery missions must exist before any publisher is known and must stage
-- candidates for human review before authoritative Publisher Registry admission.

alter table public.publisher_discovery_runs
  add column if not exists mission_name text,
  add column if not exists discovery_scope text,
  add column if not exists organization_types text[] not null default '{}'::text[],
  add column if not exists intelligence_provider text,
  add column if not exists operator_name text,
  add column if not exists governance jsonb not null default jsonb_build_object(
    'official_source_research_required', true,
    'duplicate_registry_detection_required', true,
    'candidate_record_creation_enabled', true,
    'human_review_before_registry_admission_required', true
  );

create table if not exists public.publisher_discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references public.publisher_discovery_runs(id) on delete cascade,
  publisher_name text not null,
  state_code text not null,
  organization_type text,
  official_website text,
  procurement_website text,
  acquisition_method text not null default 'UNASSESSED',
  search_endpoint text,
  vendor_registration_url text,
  procurement_platform text,
  technology_vendor text,
  registration_required boolean,
  official_sources jsonb not null default '[]'::jsonb,
  official_source_verified boolean not null default false,
  duplicate_publisher_id uuid references public.publisher_registry(id),
  duplicate_status text not null default 'UNCHECKED' check (duplicate_status in ('UNCHECKED','NO_MATCH','EXISTING_REGISTRY_MATCH')),
  review_status text not null default 'PENDING_REVIEW' check (review_status in ('RESEARCH_REQUIRED','PENDING_REVIEW','APPROVED_ADMITTED','REJECTED')),
  review_notes text,
  reviewed_at timestamptz,
  admitted_publisher_id uuid references public.publisher_registry(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists publisher_discovery_candidate_run_name_unique_idx
  on public.publisher_discovery_candidates (discovery_run_id, lower(publisher_name));
create index if not exists publisher_discovery_candidate_review_idx
  on public.publisher_discovery_candidates (discovery_run_id, review_status, created_at);
create index if not exists publisher_discovery_candidate_duplicate_idx
  on public.publisher_discovery_candidates (duplicate_publisher_id)
  where duplicate_publisher_id is not null;

drop trigger if exists publisher_discovery_candidates_touch on public.publisher_discovery_candidates;
create trigger publisher_discovery_candidates_touch
  before update on public.publisher_discovery_candidates
  for each row execute function public.command_touch_updated_at();

alter table public.publisher_discovery_candidates enable row level security;
drop policy if exists aadp_operator_read_discovery_candidates on public.publisher_discovery_candidates;
create policy aadp_operator_read_discovery_candidates
  on public.publisher_discovery_candidates
  for select to authenticated
  using (public.command_is_operator());

revoke all on public.publisher_discovery_candidates from anon;
revoke insert, update, delete on public.publisher_discovery_candidates from authenticated;
grant select on public.publisher_discovery_candidates to authenticated;
grant all on public.publisher_discovery_candidates to service_role;

-- The authoritative registry remains protected: candidates can only be admitted
-- by the server-side human-review command after official-source and duplicate gates.
comment on table public.publisher_discovery_candidates is
  'Discovery staging area. Records are non-authoritative until human approval admits them to publisher_registry.';
