create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'solicitation-packages',
  'solicitation-packages',
  false,
  52428800,
  array[
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.contract_package_documents (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid references public.acquisition_runs(id) on delete set null,
  raw_record_id uuid not null references public.acquisition_raw_records(id) on delete cascade,
  publisher_id uuid references public.publisher_registry(id) on delete set null,
  canonical_opportunity_id uuid references public.state_contract_opportunities(id) on delete set null,
  source_record_id text not null,
  source_url text not null,
  final_url text,
  storage_bucket text,
  storage_path text,
  original_filename text,
  document_type text not null default 'OTHER',
  mime_type text,
  file_extension text,
  byte_size bigint,
  sha256 text,
  version_label text,
  is_addendum boolean not null default false,
  is_amendment boolean not null default false,
  is_current boolean not null default true,
  retrieval_status text not null default 'DISCOVERED' check (retrieval_status in ('DISCOVERED','DOWNLOADING','STORED','FAILED','SKIPPED')),
  extraction_status text not null default 'NOT_STARTED' check (extraction_status in ('NOT_STARTED','EXTRACTING','EXTRACTED','NOT_TEXTUAL','FAILED','SKIPPED')),
  extracted_text text,
  extracted_char_count integer not null default 0 check (extracted_char_count >= 0),
  retrieval_attempt_count integer not null default 0 check (retrieval_attempt_count >= 0),
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  retrieved_at timestamptz,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (raw_record_id, source_url)
);

create index if not exists contract_package_documents_raw_status_idx
  on public.contract_package_documents (raw_record_id, retrieval_status, extraction_status);
create index if not exists contract_package_documents_canonical_idx
  on public.contract_package_documents (canonical_opportunity_id, is_current);
create index if not exists contract_package_documents_sha_idx
  on public.contract_package_documents (sha256) where sha256 is not null;

alter table public.contract_package_documents enable row level security;
revoke all on public.contract_package_documents from anon, authenticated;
grant all on public.contract_package_documents to service_role;
drop policy if exists aadp_operator_read_contract_package_documents on public.contract_package_documents;
create policy aadp_operator_read_contract_package_documents
  on public.contract_package_documents for select to authenticated
  using (public.command_is_operator());

alter table public.acquisition_raw_records
  add column if not exists package_status text not null default 'PACKAGE_NOT_STARTED',
  add column if not exists package_document_count integer not null default 0,
  add column if not exists package_extracted_count integer not null default 0,
  add column if not exists package_failed_count integer not null default 0,
  add column if not exists package_completed_at timestamptz,
  add column if not exists requirements_extracted_at timestamptz,
  add column if not exists match_readiness_status text not null default 'BLOCKED_PACKAGE_INCOMPLETE';

alter table public.acquisition_raw_records
  drop constraint if exists acquisition_raw_records_package_status_check,
  add constraint acquisition_raw_records_package_status_check check (package_status in ('PACKAGE_NOT_STARTED','PACKAGE_DISCOVERED','PACKAGE_DOWNLOADING','PACKAGE_PARTIAL','PACKAGE_EXTRACTED','PACKAGE_COMPLETE','PACKAGE_FAILED','PACKAGE_REVALIDATION_REQUIRED')),
  drop constraint if exists acquisition_raw_records_match_readiness_status_check,
  add constraint acquisition_raw_records_match_readiness_status_check check (match_readiness_status in ('BLOCKED_PACKAGE_INCOMPLETE','BLOCKED_REQUIREMENTS_INCOMPLETE','REVIEW_REQUIRED','MATCH_READY'));

alter table public.aadp_document_manifests
  add column if not exists package_status text not null default 'PACKAGE_DISCOVERED',
  add column if not exists storage_document_count integer not null default 0,
  add column if not exists extracted_document_count integer not null default 0,
  add column if not exists failed_document_count integer not null default 0,
  add column if not exists requirements_char_count integer not null default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.solicitation_documents
  add column if not exists raw_record_id uuid references public.acquisition_raw_records(id) on delete set null,
  add column if not exists source_record_id text,
  add column if not exists document_manifest jsonb not null default '[]'::jsonb,
  add column if not exists package_status text not null default 'PACKAGE_NOT_STARTED',
  add column if not exists extraction_engine text,
  add column if not exists requirements_extracted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.state_contract_opportunities
  add column if not exists package_status text not null default 'PACKAGE_NOT_STARTED',
  add column if not exists package_document_count integer not null default 0,
  add column if not exists package_extracted_count integer not null default 0,
  add column if not exists package_failed_count integer not null default 0,
  add column if not exists requirements_extraction_status text not null default 'NOT_STARTED',
  add column if not exists match_readiness_status text not null default 'BLOCKED_PACKAGE_INCOMPLETE',
  add column if not exists package_manifest jsonb not null default '[]'::jsonb,
  add column if not exists package_completed_at timestamptz,
  add column if not exists package_last_checked_at timestamptz;

alter table public.state_contract_opportunities
  drop constraint if exists state_contract_opportunities_package_status_check,
  add constraint state_contract_opportunities_package_status_check check (package_status in ('PACKAGE_NOT_STARTED','PACKAGE_DISCOVERED','PACKAGE_DOWNLOADING','PACKAGE_PARTIAL','PACKAGE_EXTRACTED','PACKAGE_COMPLETE','PACKAGE_FAILED','PACKAGE_REVALIDATION_REQUIRED')),
  drop constraint if exists state_contract_opportunities_requirements_extraction_status_check,
  add constraint state_contract_opportunities_requirements_extraction_status_check check (requirements_extraction_status in ('NOT_STARTED','PARTIAL','COMPLETE','FAILED','REVIEW_REQUIRED')),
  drop constraint if exists state_contract_opportunities_match_readiness_status_check,
  add constraint state_contract_opportunities_match_readiness_status_check check (match_readiness_status in ('BLOCKED_PACKAGE_INCOMPLETE','BLOCKED_REQUIREMENTS_INCOMPLETE','REVIEW_REQUIRED','MATCH_READY'));

create or replace function public.enforce_contract_package_readiness()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.package_status = 'PACKAGE_COMPLETE'
     and new.requirements_extraction_status = 'COMPLETE'
     and coalesce(new.package_document_count, 0) > 0
     and coalesce(new.package_failed_count, 0) = 0 then
    new.match_readiness_status := 'MATCH_READY';
  elsif new.package_status <> 'PACKAGE_COMPLETE' then
    new.match_readiness_status := 'BLOCKED_PACKAGE_INCOMPLETE';
  elsif new.requirements_extraction_status <> 'COMPLETE' then
    new.match_readiness_status := 'BLOCKED_REQUIREMENTS_INCOMPLETE';
  else
    new.match_readiness_status := 'REVIEW_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists state_contract_package_readiness_guard on public.state_contract_opportunities;
create trigger state_contract_package_readiness_guard
before insert or update of package_status, package_document_count, package_failed_count, requirements_extraction_status, match_readiness_status
on public.state_contract_opportunities
for each row execute function public.enforce_contract_package_readiness();

update public.acquisition_raw_records
set package_status = case when coalesce(document_manifest_count, 0) > 0 then 'PACKAGE_DISCOVERED' else 'PACKAGE_NOT_STARTED' end,
    match_readiness_status = 'BLOCKED_PACKAGE_INCOMPLETE'
where package_status = 'PACKAGE_NOT_STARTED';

update public.state_contract_opportunities
set match_readiness_status = 'BLOCKED_PACKAGE_INCOMPLETE',
    package_status = coalesce(package_status, 'PACKAGE_NOT_STARTED'),
    requirements_extraction_status = coalesce(requirements_extraction_status, 'NOT_STARTED');

create or replace function public.contract_active_presentation_eligible(p_opportunity_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when o.id is null then false
    when o.match_readiness_status <> 'MATCH_READY' then false
    when o.package_status <> 'PACKAGE_COMPLETE' then false
    when o.requirements_extraction_status <> 'COMPLETE' then false
    when o.is_latest_version is not true then false
    when o.duplicate_of is not null then false
    when lower(o.status) not in ('open','open_continuous') then false
    when lower(o.status)='open_continuous' then true
    when o.response_deadline is not null and o.response_deadline<=now() then false
    when o.lifecycle_status in ('CLOSED','AWARDED','EXPIRED','CANCELLED','ARCHIVED') then false
    when o.lifecycle_verification_required then false
    else true
  end
  from public.state_contract_opportunities o
  where o.id=p_opportunity_id
$$;

create or replace view public.natcorp_qualified_contracts as
select o.*
from public.state_contract_opportunities o
where o.natcorp_release_status = 'eligible'
  and o.qa_status = 'qualified_v3'
  and o.package_status = 'PACKAGE_COMPLETE'
  and o.requirements_extraction_status = 'COMPLETE'
  and o.match_readiness_status = 'MATCH_READY'
  and public.natcorp_requirements_are_substantive(o.requirements)
  and (
    nullif(btrim(coalesce(o.contact_email, '')), '') is not null
    or nullif(btrim(coalesce(o.contact_phone, '')), '') is not null
    or nullif(btrim(coalesce(o.raw_source_payload ->> 'qualified_contact_url', '')), '') is not null
  );

create or replace view public.contract_presentation_eligibility as
select
  o.id as opportunity_id,
  o.state_code,
  o.status as source_status,
  o.lifecycle_status,
  o.response_deadline,
  o.last_verified_at,
  o.last_seen_at,
  o.last_changed_at,
  o.is_latest_version,
  public.contract_active_presentation_eligible(o.id) as active_presentation_eligible,
  case
    when o.package_status <> 'PACKAGE_COMPLETE' then 'PACKAGE_INCOMPLETE'
    when o.requirements_extraction_status <> 'COMPLETE' then 'REQUIREMENTS_INCOMPLETE'
    when o.match_readiness_status <> 'MATCH_READY' then 'MATCH_NOT_READY'
    when o.is_latest_version is not true then 'NOT_LATEST_VERSION'
    when o.duplicate_of is not null then 'DUPLICATE_RECORD'
    when lower(o.status) <> all (array['open','open_continuous']) then 'SOURCE_STATUS_NOT_OPEN'
    when o.lifecycle_verification_required then 'VERIFICATION_REQUIRED'
    when o.lifecycle_status = any (array['CLOSED','AWARDED','EXPIRED','CANCELLED','ARCHIVED']) then 'LIFECYCLE_NOT_ACTIVE'
    when lower(o.status) = 'open_continuous' then 'OPEN_CONTINUOUS'
    when o.response_deadline is not null and o.response_deadline <= now() then 'RESPONSE_DEADLINE_PASSED'
    else 'ACTIVE_EVIDENCE_SATISFIED'
  end as eligibility_reason,
  o.package_status,
  o.requirements_extraction_status,
  o.match_readiness_status
from public.state_contract_opportunities o;
