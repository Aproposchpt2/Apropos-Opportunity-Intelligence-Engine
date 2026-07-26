-- AADP Operating System Version 1.0
-- Extends the existing AOIE Command Center without replacing AOIE or NAT-CORP.

create extension if not exists pgcrypto;

do $$ begin
  create type public.aadp_run_state as enum ('CREATED','AUTHORIZED','QUEUED','RUNNING','PAUSED','PARTIALLY_COMPLETE','COMPLETED','FAILED','CANCELLED','ESCALATED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.aadp_task_state as enum ('CREATED','BLOCKED','READY','ASSIGNED','RUNNING','RETRY_PENDING','COMPLETED','FAILED','CANCELLED','ESCALATED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.aadp_record_disposition as enum ('QUALIFIED','REJECTED_INCOMPLETE','REVIEW_REQUIRED','DUPLICATE','SUPERSEDED','CLOSED','EXPIRED','CANCELLED','WITHDRAWN','PROCESSING_ERROR');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.aadp_recommendation_state as enum ('OBSERVATION','RESEARCH_CANDIDATE','TEST_CANDIDATE','RECOMMENDED_UPDATE','APPROVED_UPDATE','REJECTED_UPDATE');
exception when duplicate_object then null; end $$;

create table if not exists public.command_definitions (
  id uuid primary key default gen_random_uuid(),
  command_key text not null unique,
  version text not null,
  task_graph jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.command_runs add column if not exists definition_id uuid references public.command_definitions(id);
alter table public.command_runs add column if not exists aadp_state public.aadp_run_state not null default 'CREATED';
alter table public.command_runs add column if not exists publisher_assignment_id uuid;
alter table public.command_runs add column if not exists reconciliation jsonb not null default '{}'::jsonb;

create table if not exists public.command_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.command_runs(id) on delete cascade,
  task_type text not null check (task_type in (
    'PUBLISHER_DISCOVERY','PUBLISHER_ACCESS_ASSESSMENT','PUBLISHER_REGISTRY_UPDATE','PUBLISHER_ASSIGNMENT_CREATE',
    'ACQUISITION_RUN_START','ACQUISITION_PAGE_FETCH','ACQUISITION_RECORD_STORE','ACQUISITION_RUN_CLOSE',
    'RECORD_NORMALIZATION','RECORD_DEDUPLICATION','RECORD_QUALIFICATION','QUALIFIED_RECORD_UPSERT',
    'REJECTION_RECORD_CREATE','DOCUMENT_DISCOVERY','DOCUMENT_RETRIEVAL','REQUIREMENT_EXTRACTION',
    'PROCUREMENT_LANGUAGE_ANALYSIS','AOIE_BATCH_REVIEW','MATCHING_RECOMMENDATION_CREATE',
    'MATCHING_RECOMMENDATION_TEST','RUN_RECONCILIATION','EXECUTIVE_REPORT_CREATE',
    'PUBLISHER_ACCESS_REASSESSMENT','TASK_RETRY','TASK_ESCALATION')),
  state public.aadp_task_state not null default 'CREATED',
  assigned_agent text,
  measurable_result jsonb not null default '{}'::jsonb,
  execution_evidence jsonb not null default '{}'::jsonb,
  input_payload jsonb not null default '{}'::jsonb,
  output_payload jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'COMPLETED' or (measurable_result <> '{}'::jsonb and execution_evidence <> '{}'::jsonb))
);

create table if not exists public.command_task_dependencies (
  task_id uuid not null references public.command_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.command_tasks(id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

create table if not exists public.command_task_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.command_tasks(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  state public.aadp_task_state not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  evidence jsonb not null default '{}'::jsonb,
  unique(task_id, attempt_number)
);

create table if not exists public.publisher_registry (
  id uuid primary key default gen_random_uuid(),
  publisher_name text not null,
  state_code text,
  organization_type text,
  official_website text,
  procurement_website text,
  acquisition_method text not null,
  search_endpoint text,
  vendor_registration_url text,
  verified boolean not null default false,
  access_status text not null default 'UNASSESSED',
  configuration jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(publisher_name, coalesce(state_code,''))
);

create table if not exists public.publisher_assignments (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references public.publisher_registry(id),
  publisher_name text not null,
  acquisition_method text not null,
  search_endpoint text,
  search_parameters jsonb not null default '{}'::jsonb,
  authorized_date_range tstzrange,
  authorized_status_range text[] not null default '{}'::text[],
  pagination_instructions jsonb not null default '{}'::jsonb,
  attachment_instructions jsonb not null default '{}'::jsonb,
  amendment_instructions jsonb not null default '{}'::jsonb,
  expected_source_identifiers text[] not null default '{}'::text[],
  raw_destination text not null default 'acquisition_raw_records',
  qualification_ruleset_version text not null,
  aoie_review_required boolean not null default true,
  execution_schedule text,
  retry_policy jsonb not null default '{"max_attempts":3}'::jsonb,
  runtime_limit_seconds integer not null default 3600,
  reporting_requirements jsonb not null default '{}'::jsonb,
  status text not null default 'CREATED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.command_runs drop constraint if exists command_runs_publisher_assignment_id_fkey;
alter table public.command_runs add constraint command_runs_publisher_assignment_id_fkey foreign key (publisher_assignment_id) references public.publisher_assignments(id);

create table if not exists public.acquisition_runs (
  id uuid primary key default gen_random_uuid(),
  command_run_id uuid not null references public.command_runs(id) on delete cascade,
  assignment_id uuid not null references public.publisher_assignments(id),
  status public.aadp_run_state not null default 'CREATED',
  records_discovered integer not null default 0,
  records_acquired integer not null default 0,
  pages_processed integer not null default 0,
  retrieval_failures integer not null default 0,
  pagination_complete boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.acquisition_raw_records (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  assignment_id uuid not null references public.publisher_assignments(id),
  publisher_id uuid not null references public.publisher_registry(id),
  source_record_id text not null,
  source_url text not null,
  raw_payload jsonb not null,
  retrieval_timestamp timestamptz not null default now(),
  source_fingerprint text not null,
  content_fingerprint text not null,
  source_version text,
  processing_status text not null default 'RAW',
  processing_attempt_count integer not null default 0,
  unique(publisher_id, source_record_id, source_fingerprint)
);

create table if not exists public.acquisition_record_dispositions (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  raw_record_id uuid not null references public.acquisition_raw_records(id) on delete cascade,
  disposition public.aadp_record_disposition not null,
  reason_code text,
  qualified_record_id uuid,
  evidence jsonb not null default '{}'::jsonb,
  disposed_at timestamptz not null default now(),
  unique(acquisition_run_id, raw_record_id)
);

create table if not exists public.acquisition_rejections (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  raw_record_id uuid not null references public.acquisition_raw_records(id) on delete cascade,
  rejection_code text not null check (rejection_code in (
    'MISSING_CONTRACT_REQUIREMENTS','MISSING_SCOPE_OF_WORK','MISSING_CONTRACT_CONTACT','CONTACT_NOT_VERIFIABLE',
    'RESPONSIBLE_ENTITY_NOT_IDENTIFIED','UNVERIFIED_OFFICIAL_SOURCE','INACCESSIBLE_SOLICITATION_PACKAGE',
    'REQUIREMENTS_NOT_EXTRACTABLE','DUPLICATE_RECORD','SUPERSEDED_RECORD','CLOSED_RECORD','EXPIRED_RECORD',
    'CANCELLED_RECORD','WITHDRAWN_RECORD','REVIEW_REQUIRED')),
  evidence jsonb not null default '{}'::jsonb,
  reprocessable boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.procurement_language_analysis (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  qualified_record_id uuid not null,
  terms jsonb not null default '[]'::jsonb,
  requirement_concepts jsonb not null default '[]'::jsonb,
  capability_concepts jsonb not null default '[]'::jsonb,
  exclusions jsonb not null default '[]'::jsonb,
  confidence numeric check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(acquisition_run_id, qualified_record_id)
);

create table if not exists public.aoie_batch_reviews (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null unique references public.acquisition_runs(id) on delete cascade,
  status text not null default 'CREATED',
  records_analyzed integer not null default 0,
  low_confidence_analyses integer not null default 0,
  report jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.aoie_change_recommendations (
  id uuid primary key default gen_random_uuid(),
  batch_review_id uuid not null references public.aoie_batch_reviews(id) on delete cascade,
  recommendation_type text not null,
  state public.aadp_recommendation_state not null default 'OBSERVATION',
  recommendation jsonb not null,
  research_evidence jsonb not null default '{}'::jsonb,
  test_result jsonb not null default '{}'::jsonb,
  production_applied boolean not null default false check (production_applied = false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.executive_run_reports (
  id uuid primary key default gen_random_uuid(),
  command_run_id uuid not null unique references public.command_runs(id) on delete cascade,
  acquisition jsonb not null,
  processing jsonb not null,
  aoie jsonb not null,
  command_center jsonb not null,
  reconciliation jsonb not null,
  final_status public.aadp_run_state not null,
  generated_at timestamptz not null default now()
);

create or replace function public.aadp_qualify_raw_record(p_raw_record_id uuid, p_requirements text, p_contact text, p_responsible_entity text, p_lifecycle_status text default 'OPEN')
returns public.aadp_record_disposition language plpgsql security definer set search_path = public as $$
declare v_disposition public.aadp_record_disposition; v_code text; v_run uuid;
begin
  select acquisition_run_id into v_run from public.acquisition_raw_records where id = p_raw_record_id for update;
  if not found then raise exception 'Raw record not found'; end if;
  if upper(coalesce(p_lifecycle_status,'')) in ('CLOSED','EXPIRED','CANCELLED','WITHDRAWN','SUPERSEDED') then
    v_disposition := upper(p_lifecycle_status)::public.aadp_record_disposition;
    v_code := upper(p_lifecycle_status) || '_RECORD';
  elsif nullif(btrim(coalesce(p_requirements,'')),'') is null then
    v_disposition := 'REJECTED_INCOMPLETE'; v_code := 'MISSING_CONTRACT_REQUIREMENTS';
  elsif nullif(btrim(coalesce(p_contact,'')),'') is null and nullif(btrim(coalesce(p_responsible_entity,'')),'') is null then
    v_disposition := 'REJECTED_INCOMPLETE'; v_code := 'MISSING_CONTRACT_CONTACT';
  else
    v_disposition := 'QUALIFIED'; v_code := null;
  end if;
  insert into public.acquisition_record_dispositions(acquisition_run_id,raw_record_id,disposition,reason_code,evidence)
  values(v_run,p_raw_record_id,v_disposition,v_code,jsonb_build_object('ruleset','AADP-QUALIFICATION-V1'))
  on conflict(acquisition_run_id,raw_record_id) do update set disposition=excluded.disposition,reason_code=excluded.reason_code,evidence=excluded.evidence,disposed_at=now();
  if v_code is not null then
    insert into public.acquisition_rejections(acquisition_run_id,raw_record_id,rejection_code,evidence)
    values(v_run,p_raw_record_id,v_code,jsonb_build_object('requirements_present',nullif(btrim(coalesce(p_requirements,'')),'') is not null,'contact_present',nullif(btrim(coalesce(p_contact,'')),'') is not null,'responsible_entity_present',nullif(btrim(coalesce(p_responsible_entity,'')),'') is not null));
  end if;
  update public.acquisition_raw_records set processing_status=v_disposition::text,processing_attempt_count=processing_attempt_count+1 where id=p_raw_record_id;
  return v_disposition;
end $$;

create or replace function public.aadp_reconcile_run(p_acquisition_run_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acquired bigint; v_disposed bigint; v_result jsonb;
begin
  select count(*) into v_acquired from public.acquisition_raw_records where acquisition_run_id=p_acquisition_run_id;
  select count(*) into v_disposed from public.acquisition_record_dispositions where acquisition_run_id=p_acquisition_run_id;
  v_result := jsonb_build_object('records_acquired',v_acquired,'records_disposed',v_disposed,'variance',v_acquired-v_disposed,'passed',v_acquired=v_disposed);
  if v_acquired <> v_disposed then raise exception 'AADP reconciliation failed: %', v_result; end if;
  return v_result;
end $$;

create index if not exists command_tasks_run_state_idx on public.command_tasks(run_id,state,created_at);
create index if not exists raw_records_run_status_idx on public.acquisition_raw_records(acquisition_run_id,processing_status);
create index if not exists dispositions_run_disposition_idx on public.acquisition_record_dispositions(acquisition_run_id,disposition);
create index if not exists analysis_run_idx on public.procurement_language_analysis(acquisition_run_id);

create trigger command_definitions_touch before update on public.command_definitions for each row execute function public.command_touch_updated_at();
create trigger command_tasks_touch before update on public.command_tasks for each row execute function public.command_touch_updated_at();
create trigger publisher_registry_touch before update on public.publisher_registry for each row execute function public.command_touch_updated_at();
create trigger publisher_assignments_touch before update on public.publisher_assignments for each row execute function public.command_touch_updated_at();
create trigger aoie_recommendations_touch before update on public.aoie_change_recommendations for each row execute function public.command_touch_updated_at();

alter table public.command_definitions enable row level security;
alter table public.command_tasks enable row level security;
alter table public.command_task_dependencies enable row level security;
alter table public.command_task_attempts enable row level security;
alter table public.publisher_registry enable row level security;
alter table public.publisher_assignments enable row level security;
alter table public.acquisition_runs enable row level security;
alter table public.acquisition_raw_records enable row level security;
alter table public.acquisition_record_dispositions enable row level security;
alter table public.acquisition_rejections enable row level security;
alter table public.procurement_language_analysis enable row level security;
alter table public.aoie_batch_reviews enable row level security;
alter table public.aoie_change_recommendations enable row level security;
alter table public.executive_run_reports enable row level security;

create policy aadp_operator_read_definitions on public.command_definitions for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_tasks on public.command_tasks for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_dependencies on public.command_task_dependencies for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_attempts on public.command_task_attempts for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_publishers on public.publisher_registry for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_assignments on public.publisher_assignments for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_acquisition_runs on public.acquisition_runs for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_raw on public.acquisition_raw_records for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_dispositions on public.acquisition_record_dispositions for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_rejections on public.acquisition_rejections for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_analysis on public.procurement_language_analysis for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_reviews on public.aoie_batch_reviews for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_recommendations on public.aoie_change_recommendations for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_reports on public.executive_run_reports for select to authenticated using (public.command_is_operator());

revoke insert,update,delete on public.command_definitions,public.command_tasks,public.command_task_dependencies,public.command_task_attempts,public.publisher_registry,public.publisher_assignments,public.acquisition_runs,public.acquisition_raw_records,public.acquisition_record_dispositions,public.acquisition_rejections,public.procurement_language_analysis,public.aoie_batch_reviews,public.aoie_change_recommendations,public.executive_run_reports from anon,authenticated;

insert into public.command_definitions(command_key,version,task_graph)
values('AADP_PUBLISHER_ACQUISITION','1.0','["PUBLISHER_ASSIGNMENT_CREATE","ACQUISITION_RUN_START","ACQUISITION_PAGE_FETCH","ACQUISITION_RECORD_STORE","ACQUISITION_RUN_CLOSE","RECORD_NORMALIZATION","RECORD_DEDUPLICATION","RECORD_QUALIFICATION","QUALIFIED_RECORD_UPSERT","REJECTION_RECORD_CREATE","RUN_RECONCILIATION","AOIE_BATCH_REVIEW","PROCUREMENT_LANGUAGE_ANALYSIS","MATCHING_RECOMMENDATION_CREATE","MATCHING_RECOMMENDATION_TEST","EXECUTIVE_REPORT_CREATE"]'::jsonb)
on conflict(command_key) do update set version=excluded.version,task_graph=excluded.task_graph,updated_at=now();