create extension if not exists pgcrypto;

create table if not exists public.county_expansion_profiles (
  id uuid primary key default gen_random_uuid(),
  state_code text not null check (state_code ~ '^[A-Z]{2}$'),
  county_name text not null,
  county_key text generated always as (lower(btrim(county_name))) stored,
  county_fips text,
  population bigint,
  number_of_incorporated_cities integer,
  school_district_density text,
  community_college_density text,
  university_density text,
  special_district_density text,
  water_district_density text,
  sanitation_district_density text,
  transit_agency_density text,
  housing_authority_density text,
  utility_density text,
  airport_presence text,
  port_presence text,
  public_hospital_presence text,
  court_presence text,
  library_system_presence text,
  public_safety_entity_density text,
  estimated_procurement_publisher_count integer,
  estimated_procurement_publisher_count_band text,
  platform_diversity text,
  engineering_reuse_potential text,
  expansion_score numeric(5,2) check (expansion_score is null or expansion_score between 0 and 100),
  priority_tier text,
  discovery_status text not null default 'NOT_STARTED',
  publishers_discovered integer not null default 0,
  platforms_identified integer not null default 0,
  class_a_platforms integer not null default 0,
  last_discovery_run_id uuid references public.publisher_discovery_runs(id) on delete set null,
  last_discovered_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (state_code, county_key)
);
create unique index if not exists county_expansion_profiles_fips_uidx on public.county_expansion_profiles(county_fips) where county_fips is not null;

create table if not exists public.procurement_platform_registry (
  id uuid primary key default gen_random_uuid(),
  platform_name text not null,
  platform_vendor text,
  platform_key text generated always as (lower(btrim(platform_name)) || '|' || lower(btrim(coalesce(platform_vendor,'')))) stored,
  official_website text,
  access_class text not null default 'UNKNOWN' check (access_class in ('CLASS_A','CLASS_B','CLASS_C','CLASS_D','UNKNOWN')),
  machine_to_machine_supported boolean,
  public_api_available boolean not null default false,
  api_documentation_url text,
  rss_available boolean not null default false,
  csv_available boolean not null default false,
  json_available boolean not null default false,
  xml_available boolean not null default false,
  open_data_available boolean not null default false,
  registration_required boolean,
  login_required boolean,
  stateful_session_required boolean,
  javascript_required boolean,
  browser_automation_required boolean,
  document_access_method text,
  pagination_method text,
  detail_resolution_method text,
  authentication_model text,
  anti_automation_indicators jsonb not null default '[]'::jsonb,
  recommended_connector_strategy text,
  connector_key text,
  connector_version text,
  connector_status text not null default 'UNASSIGNED',
  certification_status text not null default 'DEVELOPMENT',
  publisher_count integer not null default 0,
  engineering_complexity text not null default 'UNKNOWN' check (engineering_complexity in ('LOW','MODERATE','HIGH','VERY_HIGH','UNKNOWN')),
  reuse_score numeric(5,2) check (reuse_score is null or reuse_score between 0 and 100),
  connector_roi_score numeric(5,2) check (connector_roi_score is null or connector_roi_score between 0 and 100),
  last_verified_at timestamptz,
  verification_evidence jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform_key)
);
create index if not exists procurement_platform_registry_priority_idx on public.procurement_platform_registry(access_class,connector_roi_score desc,reuse_score desc);

create table if not exists public.procurement_connector_registry (
  id uuid primary key default gen_random_uuid(),
  connector_key text not null unique,
  connector_name text not null,
  platform_id uuid references public.procurement_platform_registry(id) on delete set null,
  connector_version text,
  connector_class text,
  runtime text not null default 'NETLIFY_FUNCTION',
  implementation_path text,
  supports_search boolean not null default false,
  supports_pagination boolean not null default false,
  supports_detail_resolution boolean not null default false,
  supports_requirements boolean not null default false,
  supports_contacts boolean not null default false,
  supports_attachments boolean not null default false,
  supports_qualification boolean not null default false,
  supports_deduplication boolean not null default false,
  supports_reconciliation boolean not null default false,
  supports_verification boolean not null default false,
  authentication_model text,
  certification_status text not null default 'DEVELOPMENT',
  engineering_status text not null default 'DEVELOPMENT',
  last_verified_at timestamptz,
  last_successful_run_at timestamptz,
  average_runtime_ms bigint,
  known_limitations jsonb not null default '[]'::jsonb,
  maintenance_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.publisher_registry
  add column if not exists county_name text,
  add column if not exists county_fips text,
  add column if not exists platform_id uuid references public.procurement_platform_registry(id) on delete set null,
  add column if not exists connector_registry_id uuid references public.procurement_connector_registry(id) on delete set null,
  add column if not exists access_class text,
  add column if not exists machine_to_machine_supported boolean,
  add column if not exists connector_strategy text,
  add column if not exists engineering_complexity text,
  add column if not exists reuse_score numeric(5,2),
  add column if not exists connector_roi_score numeric(5,2);

alter table public.publisher_discovery_runs
  add column if not exists county_name text,
  add column if not exists county_fips text,
  add column if not exists county_expansion_profile_id uuid references public.county_expansion_profiles(id) on delete set null;

alter table public.publisher_discovery_candidates
  add column if not exists county_name text,
  add column if not exists county_fips text,
  add column if not exists access_class text,
  add column if not exists machine_to_machine_supported boolean,
  add column if not exists connector_strategy text,
  add column if not exists engineering_complexity text,
  add column if not exists reuse_score numeric(5,2),
  add column if not exists connector_roi_score numeric(5,2);

create index if not exists publisher_registry_county_idx on public.publisher_registry(state_code,county_name,publisher_name);
create index if not exists publisher_registry_platform_idx on public.publisher_registry(platform_id,access_class);
create index if not exists publisher_discovery_runs_county_idx on public.publisher_discovery_runs(state_code,county_name,created_at desc);
create index if not exists publisher_discovery_candidates_county_idx on public.publisher_discovery_candidates(state_code,county_name,review_status);

alter table public.county_expansion_profiles enable row level security;
alter table public.procurement_platform_registry enable row level security;
alter table public.procurement_connector_registry enable row level security;
revoke all on public.county_expansion_profiles,public.procurement_platform_registry,public.procurement_connector_registry from anon,authenticated;
grant all on public.county_expansion_profiles,public.procurement_platform_registry,public.procurement_connector_registry to service_role;

comment on table public.county_expansion_profiles is 'County-centric procurement publisher expansion planning and reconciliation profiles.';
comment on table public.procurement_platform_registry is 'Shared procurement platform access intelligence and connector strategy registry.';
comment on table public.procurement_connector_registry is 'Versioned procurement connector capability, engineering, and certification registry.';
