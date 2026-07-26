-- AADP Operating System Version 1.0
-- Development migration only. No production execution is authorized.

create extension if not exists pgcrypto;

create type public.aadp_run_state as enum ('CREATED','AUTHORIZED','QUEUED','RUNNING','PAUSED','PARTIALLY_COMPLETE','COMPLETED','FAILED','CANCELLED','ESCALATED');
create type public.aadp_task_state as enum ('CREATED','BLOCKED','READY','ASSIGNED','RUNNING','RETRY_PENDING','COMPLETED','FAILED','CANCELLED','ESCALATED');
create type public.aadp_record_disposition as enum ('QUALIFIED','REJECTED_INCOMPLETE','REVIEW_REQUIRED','DUPLICATE','SUPERSEDED','CLOSED','EXPIRED','CANCELLED','WITHDRAWN','PROCESSING_ERROR');
create type public.aadp_recommendation_state as enum ('OBSERVATION','RESEARCH_CANDIDATE','TEST_CANDIDATE','RECOMMENDED_UPDATE','APPROVED_UPDATE','REJECTED_UPDATE');

create table if not exists public.command_definitions (
  id uuid primary key default gen_random_uuid(), code text unique not null, name text not null,
  version text not null default '1.0', task_graph jsonb not null default '[]', is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.command_runs (
  id uuid primary key default gen_random_uuid(), command_definition_id uuid references public.command_definitions(id),
  state public.aadp_run_state not null default 'CREATED', authorization_evidence jsonb not null default '{}',
  started_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.command_tasks (
  id uuid primary key default gen_random_uuid(), command_run_id uuid not null references public.command_runs(id) on delete cascade,
  task_type text not null, state public.aadp_task_state not null default 'CREATED', assigned_agent text,
  input jsonb not null default '{}', measurable_result jsonb, execution_evidence jsonb,
  retry_policy jsonb not null default '{"max_attempts":3}', attempt_count integer not null default 0,
  available_at timestamptz not null default now(), started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint command_task_completion_evidence check (state <> 'COMPLETED' or (measurable_result is not null and execution_evidence is not null))
);
create table if not exists public.command_task_dependencies (
  task_id uuid not null references public.command_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.command_tasks(id) on delete cascade,
  primary key(task_id, depends_on_task_id), constraint no_self_dependency check(task_id <> depends_on_task_id)
);
create table if not exists public.command_task_attempts (
  id uuid primary key default gen_random_uuid(), task_id uuid not null references public.command_tasks(id) on delete cascade,
  attempt_number integer not null, state public.aadp_task_state not null, started_at timestamptz not null default now(),
  completed_at timestamptz, result jsonb, evidence jsonb, error jsonb, unique(task_id, attempt_number)
);
create table if not exists public.command_events (
  id bigint generated always as identity primary key, command_run_id uuid references public.command_runs(id) on delete cascade,
  task_id uuid references public.command_tasks(id) on delete cascade, event_type text not null, payload jsonb not null default '{}', occurred_at timestamptz not null default now()
);
create table if not exists public.command_failures (
  id uuid primary key default gen_random_uuid(), command_run_id uuid not null references public.command_runs(id) on delete cascade,
  task_id uuid references public.command_tasks(id), failure_code text not null, detail jsonb not null default '{}',
  retryable boolean not null default false, resolved_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.command_metrics (
  command_run_id uuid not null references public.command_runs(id) on delete cascade, metric_name text not null,
  metric_value numeric not null default 0, dimensions jsonb not null default '{}', measured_at timestamptz not null default now(),
  primary key(command_run_id, metric_name, measured_at)
);

create table if not exists public.publisher_registry (
  id uuid primary key default gen_random_uuid(), publisher_key text unique not null, publisher_name text not null,
  jurisdiction jsonb not null default '{}', official_website text, procurement_website text, platform text,
  technology_vendor text, acquisition_method text not null, search_endpoint text, search_parameters jsonb not null default '{}',
  pagination_instructions jsonb not null default '{}', attachment_instructions jsonb not null default '{}',
  amendment_instructions jsonb not null default '{}', authentication_requirements jsonb not null default '{}',
  verification_status text not null default 'UNVERIFIED', verified_at timestamptz, acquisition_schedule text,
  is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.publisher_assignments (
  id uuid primary key default gen_random_uuid(), publisher_id uuid not null references public.publisher_registry(id),
  command_run_id uuid references public.command_runs(id), acquisition_method text not null, search_endpoint text,
  search_parameters jsonb not null default '{}', authorized_date_range tstzrange, authorized_status_range text[] not null default '{}',
  pagination_instructions jsonb not null default '{}', attachment_instructions jsonb not null default '{}',
  amendment_instructions jsonb not null default '{}', expected_source_identifiers text[] not null default '{}',
  raw_destination text not null default 'acquisition_raw_records', qualification_ruleset_version text not null default 'AADP-QUAL-1.0',
  aoie_review_required boolean not null default true, execution_schedule text, retry_policy jsonb not null default '{"max_attempts":3}',
  runtime_limit_seconds integer not null default 3600, reporting_requirements jsonb not null default '{}',
  status text not null default 'CREATED', created_at timestamptz not null default now()
);
create table if not exists public.acquisition_runs (
  id uuid primary key default gen_random_uuid(), assignment_id uuid not null references public.publisher_assignments(id),
  command_run_id uuid references public.command_runs(id), state public.aadp_run_state not null default 'CREATED',
  pages_processed integer not null default 0, records_discovered integer not null default 0, records_acquired integer not null default 0,
  retrieval_failures integer not null default 0, pagination_complete boolean not null default false,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.acquisition_raw_records (
  id uuid primary key default gen_random_uuid(), acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  assignment_id uuid not null references public.publisher_assignments(id), publisher_id uuid not null references public.publisher_registry(id),
  source_record_id text not null, source_url text, raw_payload jsonb not null, retrieved_at timestamptz not null default now(),
  source_fingerprint text not null, content_fingerprint text not null, source_version text,
  processing_status text not null default 'PENDING', processing_attempt_count integer not null default 0,
  unique(publisher_id, source_record_id, source_fingerprint)
);
create table if not exists public.acquisition_record_dispositions (
  raw_record_id uuid primary key references public.acquisition_raw_records(id) on delete cascade,
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  disposition public.aadp_record_disposition not null, reason_codes text[] not null default '{}',
  qualified_record_id uuid, evidence jsonb not null default '{}', disposed_at timestamptz not null default now()
);
create table if not exists public.acquisition_rejections (
  id uuid primary key default gen_random_uuid(), raw_record_id uuid not null references public.acquisition_raw_records(id) on delete cascade,
  rejection_code text not null, detail jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists public.procurement_language_analysis (
  id uuid primary key default gen_random_uuid(), acquisition_run_id uuid not null references public.acquisition_runs(id),
  qualified_record_id uuid not null, analysis_version text not null, terms jsonb not null default '[]', capability_concepts jsonb not null default '[]',
  exclusions jsonb not null default '[]', confidence numeric, source_evidence jsonb not null default '[]', created_at timestamptz not null default now()
);
create table if not exists public.aoie_batch_reviews (
  id uuid primary key default gen_random_uuid(), acquisition_run_id uuid unique not null references public.acquisition_runs(id),
  status text not null default 'CREATED', report jsonb not null default '{}', records_analyzed integer not null default 0,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.aoie_change_recommendations (
  id uuid primary key default gen_random_uuid(), batch_review_id uuid not null references public.aoie_batch_reviews(id) on delete cascade,
  state public.aadp_recommendation_state not null default 'OBSERVATION', recommendation_type text not null,
  supporting_record_ids uuid[] not null default '{}', proposed_behavior jsonb not null, expected_improvement jsonb not null default '{}',
  risk jsonb not null default '{}', test_method jsonb, measured_result jsonb, created_at timestamptz not null default now()
);
create table if not exists public.executive_run_reports (
  id uuid primary key default gen_random_uuid(), command_run_id uuid unique not null references public.command_runs(id),
  acquisition_run_id uuid references public.acquisition_runs(id), report jsonb not null, reconciliation_passed boolean not null,
  generated_at timestamptz not null default now()
);

create index if not exists command_tasks_ready_idx on public.command_tasks(state, available_at);
create index if not exists raw_records_run_idx on public.acquisition_raw_records(acquisition_run_id, processing_status);
create index if not exists dispositions_run_idx on public.acquisition_record_dispositions(acquisition_run_id, disposition);

create or replace function public.aadp_qualify_raw_record(p_raw_record_id uuid)
returns public.aadp_record_disposition language plpgsql security invoker as $$
declare r public.acquisition_raw_records; requirements_text text; contact_text text; result public.aadp_record_disposition; reasons text[] := '{}';
begin
  select * into strict r from public.acquisition_raw_records where id = p_raw_record_id for update;
  requirements_text := concat_ws(' ', r.raw_payload->>'description', r.raw_payload->>'scope_of_work', r.raw_payload->>'requirements', r.raw_payload->>'deliverables');
  contact_text := concat_ws(' ', r.raw_payload->>'contact_name', r.raw_payload->>'contact_email', r.raw_payload->>'contact_phone', r.raw_payload->>'responsible_entity', r.raw_payload->>'inquiry_method');
  if coalesce(length(trim(requirements_text)),0) < 25 then reasons := array_append(reasons,'MISSING_CONTRACT_REQUIREMENTS'); end if;
  if coalesce(length(trim(contact_text)),0) < 3 then reasons := array_append(reasons,'MISSING_CONTRACT_CONTACT'); end if;
  result := case when cardinality(reasons)=0 then 'QUALIFIED'::public.aadp_record_disposition else 'REJECTED_INCOMPLETE'::public.aadp_record_disposition end;
  insert into public.acquisition_record_dispositions(raw_record_id, acquisition_run_id, disposition, reason_codes, evidence)
  values(r.id,r.acquisition_run_id,result,reasons,jsonb_build_object('ruleset','AADP-QUAL-1.0','source_fingerprint',r.source_fingerprint,'content_fingerprint',r.content_fingerprint))
  on conflict(raw_record_id) do update set disposition=excluded.disposition, reason_codes=excluded.reason_codes, evidence=excluded.evidence, disposed_at=now();
  update public.acquisition_raw_records set processing_status='DISPOSED', processing_attempt_count=processing_attempt_count+1 where id=r.id;
  return result;
end $$;

create or replace function public.aadp_reconcile_acquisition_run(p_acquisition_run_id uuid)
returns jsonb language sql stable as $$
with acquired as (select count(*)::int n from public.acquisition_raw_records where acquisition_run_id=p_acquisition_run_id),
disposed as (select disposition,count(*)::int n from public.acquisition_record_dispositions where acquisition_run_id=p_acquisition_run_id group by disposition),
totals as (select coalesce((select n from acquired),0) acquired, coalesce(sum(n),0)::int disposed, coalesce(jsonb_object_agg(disposition,n),'{}') counts from disposed)
select jsonb_build_object('records_acquired',acquired,'records_disposed',disposed,'variance',acquired-disposed,'passed',acquired=disposed,'dispositions',counts) from totals;
$$;

comment on function public.aadp_qualify_raw_record(uuid) is 'Authoritative AADP V1 PostgreSQL qualification gate. Acquisition agents must not make this decision.';
comment on function public.aadp_reconcile_acquisition_run(uuid) is 'Fails reconciliation whenever any acquired record lacks exactly one final disposition.';
