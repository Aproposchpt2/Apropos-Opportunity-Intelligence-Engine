-- AADP Version 1 integrated runtime acceptance corrective migration.
-- Adds semantic completion, version governance, process projections, and qualified-destination security.

create type public.aadp_semantic_completion_state as enum (
  'SEMANTICALLY_COMPLETE','SEMANTICALLY_INCOMPLETE','COMPLETED_WITH_WARNINGS','ACTION_NEEDED','FAILED'
);

alter table public.command_runs
  add column if not exists semantic_state public.aadp_semantic_completion_state,
  add column if not exists semantic_validation jsonb not null default '{}'::jsonb,
  add column if not exists resume_source_stage text,
  add column if not exists resumed_at timestamptz;

alter table public.acquisition_raw_records
  add column if not exists canonical_opportunity_id text,
  add column if not exists version_id uuid default gen_random_uuid(),
  add column if not exists version_number integer,
  add column if not exists predecessor_record_id uuid references public.acquisition_raw_records(id),
  add column if not exists superseded_by_record_id uuid references public.acquisition_raw_records(id),
  add column if not exists amendment_of_record_id uuid references public.acquisition_raw_records(id),
  add column if not exists is_current_version boolean not null default true,
  add column if not exists version_effective_at timestamptz,
  add column if not exists version_detected_at timestamptz not null default now(),
  add column if not exists version_reason text,
  add column if not exists content_changed boolean not null default false,
  add column if not exists lifecycle_changed boolean not null default false,
  add column if not exists deadline_changed boolean not null default false,
  add column if not exists requirements_changed boolean not null default false,
  add column if not exists contact_changed boolean not null default false,
  add column if not exists documents_changed boolean not null default false;

alter table public.acquisition_raw_records
  drop constraint if exists acquisition_raw_records_publisher_id_source_record_id_source_f_key;

create unique index if not exists acquisition_raw_records_version_identity_unique_idx
  on public.acquisition_raw_records(publisher_id, source_record_id, content_fingerprint);

create index if not exists acquisition_raw_records_canonical_current_idx
  on public.acquisition_raw_records(publisher_id, canonical_opportunity_id, is_current_version, version_detected_at desc);

create table if not exists public.aadp_record_version_relationships (
  id uuid primary key default gen_random_uuid(),
  acquisition_run_id uuid not null references public.acquisition_runs(id) on delete cascade,
  publisher_id uuid not null references public.publisher_registry(id),
  canonical_opportunity_id text not null,
  record_id uuid not null references public.acquisition_raw_records(id) on delete cascade,
  related_record_id uuid references public.acquisition_raw_records(id),
  relationship_type text not null check (relationship_type in (
    'EXACT_DUPLICATE','CONTENT_UPDATE','AMENDMENT','NEW_SOURCE_VERSION',
    'SUPERSEDED_PREDECESSOR','CURRENT_LATEST_VERSION'
  )),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(record_id, relationship_type, related_record_id)
);

create table if not exists public.aadp_process_stage_projection (
  id uuid primary key default gen_random_uuid(),
  command_run_id uuid not null references public.command_runs(id) on delete cascade,
  acquisition_run_id uuid references public.acquisition_runs(id) on delete cascade,
  state_code text,
  publisher_id uuid references public.publisher_registry(id),
  publisher_name text,
  stage_key text not null,
  display_name text not null,
  display_state text not null check (display_state in (
    'NOT STARTED','QUEUED','IN PROGRESS','COMPLETED','COMPLETED WITH WARNINGS',
    'ACTION NEEDED','FAILED','CANCELLED'
  )),
  started_at timestamptz,
  completed_at timestamptz,
  records_processed integer not null default 0,
  warning_count integer not null default 0,
  failure_count integer not null default 0,
  retry_count integer not null default 0,
  evidence jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(command_run_id, stage_key)
);

create table if not exists public.aadp_recommendation_decisions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.aoie_change_recommendations(id) on delete cascade,
  decision text not null check (decision in (
    'APPROVE FOR FURTHER TESTING','RETURN FOR RESEARCH','DEFER','REJECT','ACCEPT NO CHANGE'
  )),
  decision_evidence jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id),
  decided_at timestamptz not null default now()
);

create or replace function public.aadp_validate_semantic_completion(p_command_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acquisition_run_id uuid;
  v_raw bigint := 0;
  v_disposed bigint := 0;
  v_qualified bigint := 0;
  v_qualified_upserts bigint := 0;
  v_analyses bigint := 0;
  v_reviewed bigint := 0;
  v_recommendations bigint := 0;
  v_open_mandatory_alerts bigint := 0;
  v_nonterminal_tasks bigint := 0;
  v_reconciliation jsonb := '{}'::jsonb;
  v_valid boolean;
  v_result jsonb;
begin
  select id into v_acquisition_run_id
  from public.acquisition_runs
  where command_run_id = p_command_run_id
  order by created_at desc limit 1;

  if v_acquisition_run_id is null then
    raise exception 'AADP semantic validation failed: acquisition run not found';
  end if;

  select count(*) into v_raw from public.acquisition_raw_records where acquisition_run_id = v_acquisition_run_id;
  select count(*) into v_disposed from public.acquisition_record_dispositions where acquisition_run_id = v_acquisition_run_id;
  select count(*) into v_qualified from public.acquisition_record_dispositions where acquisition_run_id = v_acquisition_run_id and disposition = 'QUALIFIED';
  select count(*) into v_qualified_upserts from public.acquisition_record_dispositions where acquisition_run_id = v_acquisition_run_id and disposition = 'QUALIFIED' and qualified_record_id is not null;
  select count(*) into v_analyses from public.procurement_language_analysis where acquisition_run_id = v_acquisition_run_id;
  select coalesce(max(records_analyzed),0) into v_reviewed from public.aoie_batch_reviews where acquisition_run_id = v_acquisition_run_id and status = 'COMPLETED';
  select count(*) into v_recommendations from public.aoie_change_recommendations r join public.aoie_batch_reviews b on b.id = r.batch_review_id where b.acquisition_run_id = v_acquisition_run_id;
  select count(*) into v_open_mandatory_alerts from public.aadp_action_needed_alerts where command_run_id = p_command_run_id and status = 'OPEN';
  select count(*) into v_nonterminal_tasks from public.command_tasks where run_id = p_command_run_id and state not in ('COMPLETED','CANCELLED');
  select reconciliation into v_reconciliation from public.command_runs where id = p_command_run_id;

  v_valid :=
    v_raw = v_disposed and
    v_qualified = v_qualified_upserts and
    v_qualified = v_analyses and
    v_analyses = v_reviewed and
    coalesce((v_reconciliation->>'passed')::boolean,false) and
    v_open_mandatory_alerts = 0 and
    v_nonterminal_tasks = 0;

  v_result := jsonb_build_object(
    'valid', v_valid,
    'raw_records', v_raw,
    'terminal_dispositions', v_disposed,
    'qualified_records', v_qualified,
    'qualified_upserts', v_qualified_upserts,
    'procurement_language_analyses', v_analyses,
    'aoie_records_analyzed', v_reviewed,
    'recommendations', v_recommendations,
    'open_mandatory_action_needed', v_open_mandatory_alerts,
    'nonterminal_tasks', v_nonterminal_tasks,
    'reconciliation', v_reconciliation,
    'aoie_result', case when v_analyses = v_reviewed then 'VALID' else 'INVALID' end
  );

  update public.command_runs
  set semantic_state = case when v_valid then 'SEMANTICALLY_COMPLETE'::public.aadp_semantic_completion_state
                            when v_open_mandatory_alerts > 0 then 'ACTION_NEEDED'::public.aadp_semantic_completion_state
                            else 'SEMANTICALLY_INCOMPLETE'::public.aadp_semantic_completion_state end,
      semantic_validation = v_result
  where id = p_command_run_id;

  return v_result;
end
$$;

revoke all on function public.aadp_validate_semantic_completion(uuid) from public, anon, authenticated;
grant execute on function public.aadp_validate_semantic_completion(uuid) to service_role;

alter table public.aadp_record_version_relationships enable row level security;
alter table public.aadp_process_stage_projection enable row level security;
alter table public.aadp_recommendation_decisions enable row level security;

create policy aadp_operator_read_version_relationships on public.aadp_record_version_relationships
  for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_process_projection on public.aadp_process_stage_projection
  for select to authenticated using (public.command_is_operator());
create policy aadp_operator_read_recommendation_decisions on public.aadp_recommendation_decisions
  for select to authenticated using (public.command_is_operator());

revoke all on public.aadp_record_version_relationships, public.aadp_process_stage_projection, public.aadp_recommendation_decisions from anon, public;
revoke insert, update, delete on public.aadp_record_version_relationships, public.aadp_process_stage_projection, public.aadp_recommendation_decisions from authenticated;
grant select, insert, update, delete on public.aadp_record_version_relationships, public.aadp_process_stage_projection, public.aadp_recommendation_decisions to service_role;

-- Qualified destination: server writes, internal operator reads, no anonymous access.
alter table public.state_contract_opportunities enable row level security;
revoke all on public.state_contract_opportunities from anon, public;
revoke insert, update, delete on public.state_contract_opportunities from authenticated;
grant select on public.state_contract_opportunities to authenticated;
grant select, insert, update, delete on public.state_contract_opportunities to service_role;

drop policy if exists state_contract_opportunities_operator_read on public.state_contract_opportunities;
create policy state_contract_opportunities_operator_read
  on public.state_contract_opportunities for select to authenticated
  using (public.command_is_operator());

update public.command_definitions
set task_graph = '["PUBLISHER_ASSIGNMENT_CREATE","ACQUISITION_RUN_START","ACQUISITION_PAGE_FETCH","ACQUISITION_RECORD_STORE","ACQUISITION_RUN_CLOSE","RECORD_NORMALIZATION","RECORD_DEDUPLICATION","RECORD_QUALIFICATION","QUALIFIED_RECORD_UPSERT","REJECTION_RECORD_CREATE","RUN_RECONCILIATION","PROCUREMENT_LANGUAGE_ANALYSIS","AOIE_BATCH_REVIEW","MATCHING_RECOMMENDATION_CREATE","MATCHING_RECOMMENDATION_TEST","EXECUTIVE_REPORT_CREATE"]'::jsonb,
    version = '1.1',
    updated_at = now()
where command_key = 'AADP_PUBLISHER_ACQUISITION';
