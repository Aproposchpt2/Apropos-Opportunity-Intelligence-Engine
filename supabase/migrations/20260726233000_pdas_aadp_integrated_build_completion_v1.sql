-- PDAS / AADP Operating System Version 1.0 integrated build completion.
-- Adds complete publisher detail/document stages and the City of Tucson OpenGov reference adapter configuration.

alter table public.acquisition_raw_records
  add column if not exists detail_retrieved_at timestamptz,
  add column if not exists detail_retrieval_status text not null default 'PENDING',
  add column if not exists detail_retrieval_error text;

create table if not exists public.aadp_document_manifests (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  raw_record_id uuid not null references public.acquisition_raw_records(id) on delete cascade,
  source_record_id text not null,
  manifest jsonb not null default '{}'::jsonb,
  document_count integer not null default 0,
  retrieved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(acquisition_run_id,raw_record_id)
);

alter table public.aadp_document_manifests enable row level security;
drop policy if exists aadp_operator_read_document_manifests on public.aadp_document_manifests;
create policy aadp_operator_read_document_manifests on public.aadp_document_manifests
  for select to authenticated using (public.command_is_operator());
revoke all on public.aadp_document_manifests from anon, public;
revoke insert,update,delete on public.aadp_document_manifests from authenticated;
grant select,insert,update,delete on public.aadp_document_manifests to service_role;

-- Add the integrated task stage to the existing constrained task vocabulary.
alter table public.command_tasks drop constraint if exists command_tasks_task_type_check;
alter table public.command_tasks add constraint command_tasks_task_type_check check (task_type in (
  'PUBLISHER_DISCOVERY','PUBLISHER_ACCESS_ASSESSMENT','PUBLISHER_REGISTRY_UPDATE','PUBLISHER_ASSIGNMENT_CREATE',
  'ACQUISITION_RUN_START','ACQUISITION_PAGE_FETCH','PROJECT_DETAIL_RETRIEVAL','ACQUISITION_RECORD_STORE','ACQUISITION_RUN_CLOSE',
  'DOCUMENT_DISCOVERY','DOCUMENT_RETRIEVAL','REQUIREMENT_EXTRACTION','RECORD_NORMALIZATION','RECORD_DEDUPLICATION',
  'RECORD_QUALIFICATION','QUALIFIED_RECORD_UPSERT','REJECTION_RECORD_CREATE','PROCUREMENT_LANGUAGE_ANALYSIS',
  'AOIE_BATCH_REVIEW','MATCHING_RECOMMENDATION_CREATE','MATCHING_RECOMMENDATION_TEST','RUN_RECONCILIATION',
  'EXECUTIVE_REPORT_CREATE','PUBLISHER_ACCESS_REASSESSMENT','TASK_RETRY','TASK_ESCALATION'
));

update public.command_definitions
set version='1.2',
    task_graph='["PUBLISHER_ASSIGNMENT_CREATE","ACQUISITION_RUN_START","ACQUISITION_PAGE_FETCH","PROJECT_DETAIL_RETRIEVAL","ACQUISITION_RECORD_STORE","ACQUISITION_RUN_CLOSE","DOCUMENT_DISCOVERY","DOCUMENT_RETRIEVAL","REQUIREMENT_EXTRACTION","RECORD_NORMALIZATION","RECORD_DEDUPLICATION","RECORD_QUALIFICATION","QUALIFIED_RECORD_UPSERT","REJECTION_RECORD_CREATE","RUN_RECONCILIATION","PROCUREMENT_LANGUAGE_ANALYSIS","AOIE_BATCH_REVIEW","MATCHING_RECOMMENDATION_CREATE","MATCHING_RECOMMENDATION_TEST","EXECUTIVE_REPORT_CREATE"]'::jsonb,
    updated_at=now()
where command_key='AADP_PUBLISHER_ACQUISITION';

-- Reference publisher registry record. This is configuration only; no acquisition run or production write is executed.
insert into public.publisher_registry(
  publisher_name,state_code,organization_type,official_website,procurement_website,
  acquisition_method,search_endpoint,vendor_registration_url,verified,access_status,
  configuration,last_verified_at
) values (
  'City of Tucson','AZ','City',
  'https://www.tucsonaz.gov/Departments/Business-Services-Department/Procurement',
  'https://procurement.opengov.com/portal/tucson-az',
  'OPENGOV_PUBLIC_PORTAL',
  'https://procurement.opengov.com/portal/embed/tucson-az/project-list',
  'https://procurement.opengov.com/signup',
  true,'PUBLIC_PORTAL_VERIFIED',
  jsonb_build_object(
    'procurement_authority','Business Services Department Procurement Division',
    'platform','OpenGov Procurement',
    'agency_slug','tucson-az',
    'portal_url','https://procurement.opengov.com/portal/tucson-az',
    'public_project_list_url','https://procurement.opengov.com/portal/embed/tucson-az/project-list',
    'general_contact','Procurement@tucsonaz.gov',
    'adapter','OPENGOV_PUBLIC_PORTAL_V1',
    'acquisition_boundary','PUBLICLY_ACCESSIBLE_CONTENT_ONLY'
  ),now()
)
on conflict (publisher_name,(coalesce(state_code,''))) do update set
  organization_type=excluded.organization_type,
  official_website=excluded.official_website,
  procurement_website=excluded.procurement_website,
  acquisition_method=excluded.acquisition_method,
  search_endpoint=excluded.search_endpoint,
  vendor_registration_url=excluded.vendor_registration_url,
  verified=excluded.verified,
  access_status=excluded.access_status,
  configuration=excluded.configuration,
  last_verified_at=excluded.last_verified_at,
  updated_at=now();

insert into public.publisher_assignments(
  publisher_id,publisher_name,acquisition_method,search_endpoint,search_parameters,
  authorized_status_range,pagination_instructions,attachment_instructions,amendment_instructions,
  expected_source_identifiers,qualification_ruleset_version,aoie_review_required,retry_policy,
  runtime_limit_seconds,reporting_requirements,status
)
select
  id,publisher_name,'OPENGOV_PUBLIC_PORTAL',search_endpoint,
  jsonb_build_object('portal_slug','tucson-az','headers',jsonb_build_object('Accept','text/html,application/json')),
  array['Open','Pending','Evaluation','Awarded','Closed','Cancelled'],
  jsonb_build_object('mode','html','max_pages',1,'page_size',1000),
  jsonb_build_object('public_only',true,'manifest_required',true),
  jsonb_build_object('addenda',true,'amendments',true,'questions_answers','WHEN_PUBLIC'),
  array['source_record_id','solicitation_number','official_source_url'],
  'AADP-QUALIFICATION-V1',true,jsonb_build_object('max_attempts',3,'backoff_seconds',15),
  3600,jsonb_build_object('executive_report',true,'document_manifest',true,'version_lineage',true),'READY'
from public.publisher_registry
where publisher_name='City of Tucson' and state_code='AZ'
  and not exists (
    select 1 from public.publisher_assignments a
    where a.publisher_id=publisher_registry.id and a.acquisition_method='OPENGOV_PUBLIC_PORTAL'
  );

create index if not exists aadp_document_manifests_run_record_idx
  on public.aadp_document_manifests(acquisition_run_id,raw_record_id);
