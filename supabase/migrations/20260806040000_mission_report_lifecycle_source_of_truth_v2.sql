-- APIE Mission Reporting Source-of-Truth lifecycle persistence v2
-- VALIDATION BRANCH ONLY. Do not apply without explicit production authorization.

begin;

alter table public.mission_execution_reports
  add column if not exists report_id text,
  add column if not exists operational_outcome text,
  add column if not exists authoritative_run_status text,
  add column if not exists production_provenance jsonb not null default '{}'::jsonb;

update public.mission_execution_reports
set
  report_id = coalesce(
    nullif(report_id, ''),
    nullif(report_data #>> '{report_metadata,report_id}', ''),
    'MR-' || upper(substr(command_run_id::text, 1, 8)) || '-V' || report_version::text
  ),
  operational_outcome = coalesce(
    nullif(operational_outcome, ''),
    nullif(report_data #>> '{executive_determination,derived_operational_outcome}', ''),
    nullif(report_data #>> '{run_status,derived_operational_outcome}', ''),
    'NOT REPORTED'
  ),
  authoritative_run_status = coalesce(
    nullif(authoritative_run_status, ''),
    nullif(report_data #>> '{executive_determination,authoritative_run_status}', ''),
    nullif(report_data #>> '{run_status,authoritative_status}', ''),
    'NOT REPORTED'
  ),
  production_provenance = case
    when production_provenance = '{}'::jsonb then jsonb_strip_nulls(jsonb_build_object(
      'preview_git_commit', report_data #>> '{report_metadata,preview_git_commit}',
      'preview_netlify_deploy', report_data #>> '{report_metadata,preview_netlify_deploy}',
      'preview_url', report_data #>> '{report_metadata,preview_url}',
      'preview_context', report_data #>> '{report_metadata,production_deployment_context}',
      'production_baseline_git_commit', report_data #>> '{report_metadata,production_baseline_git_commit}',
      'production_baseline_netlify_deploy', report_data #>> '{report_metadata,production_baseline_netlify_deploy}',
      'production_baseline_url', report_data #>> '{report_metadata,production_baseline_url}',
      'report_generator_version', report_data #>> '{report_metadata,report_generator_version}'
    ))
    else production_provenance
  end;

alter table public.mission_execution_reports
  alter column report_id set not null,
  alter column command_run_id set not null,
  alter column report_version set not null,
  alter column report_state set not null,
  alter column operational_outcome set not null,
  alter column authoritative_run_status set not null,
  alter column report_data set not null,
  alter column report_hash set not null,
  alter column generated_at set not null;

create unique index if not exists mission_execution_reports_report_id_unique
  on public.mission_execution_reports (report_id);

create unique index if not exists mission_execution_reports_run_version_unique
  on public.mission_execution_reports (command_run_id, report_version);

alter table public.mission_execution_reports
  drop constraint if exists mission_execution_reports_report_state_check,
  drop constraint if exists mission_execution_reports_state_fields_check;

alter table public.mission_execution_reports
  add constraint mission_execution_reports_report_state_check
    check (report_state in ('DRAFT', 'FINAL', 'AMENDED', 'SUPERSEDED')),
  add constraint mission_execution_reports_state_fields_check
    check (
      (
        report_state = 'DRAFT'
        and finalized_at is null
        and amended_at is null
        and amendment_reason is null
        and supersedes_report_id is null
      )
      or
      (
        report_state = 'FINAL'
        and finalized_at is not null
        and amended_at is null
        and amendment_reason is null
        and (report_version = 1 or supersedes_report_id is not null)
      )
      or
      (
        report_state = 'AMENDED'
        and finalized_at is not null
        and amended_at is not null
        and nullif(trim(amendment_reason), '') is not null
        and supersedes_report_id is not null
      )
      or
      (
        report_state = 'SUPERSEDED'
        and finalized_at is not null
        and supersedes_report_id is not null
      )
    );

create or replace function public.prepare_mission_execution_report_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prior_report public.mission_execution_reports%rowtype;
  superseded_report public.mission_execution_reports%rowtype;
begin
  new.report_id := coalesce(
    nullif(trim(new.report_id), ''),
    nullif(new.report_data #>> '{report_metadata,report_id}', ''),
    'MR-' || upper(substr(new.command_run_id::text, 1, 8)) || '-V' || new.report_version::text
  );
  new.operational_outcome := coalesce(
    nullif(trim(new.operational_outcome), ''),
    nullif(new.report_data #>> '{executive_determination,derived_operational_outcome}', ''),
    nullif(new.report_data #>> '{run_status,derived_operational_outcome}', ''),
    'NOT REPORTED'
  );
  new.authoritative_run_status := coalesce(
    nullif(trim(new.authoritative_run_status), ''),
    nullif(new.report_data #>> '{executive_determination,authoritative_run_status}', ''),
    nullif(new.report_data #>> '{run_status,authoritative_status}', ''),
    'NOT REPORTED'
  );
  if new.production_provenance is null or new.production_provenance = '{}'::jsonb then
    new.production_provenance := jsonb_strip_nulls(jsonb_build_object(
      'preview_git_commit', new.report_data #>> '{report_metadata,preview_git_commit}',
      'preview_netlify_deploy', new.report_data #>> '{report_metadata,preview_netlify_deploy}',
      'preview_url', new.report_data #>> '{report_metadata,preview_url}',
      'preview_context', new.report_data #>> '{report_metadata,production_deployment_context}',
      'production_baseline_git_commit', new.report_data #>> '{report_metadata,production_baseline_git_commit}',
      'production_baseline_netlify_deploy', new.report_data #>> '{report_metadata,production_baseline_netlify_deploy}',
      'production_baseline_url', new.report_data #>> '{report_metadata,production_baseline_url}',
      'report_generator_version', new.report_data #>> '{report_metadata,report_generator_version}'
    ));
  end if;

  if new.report_version > 1 then
    select * into prior_report
    from public.mission_execution_reports
    where command_run_id = new.command_run_id
      and report_version = new.report_version - 1;

    if not found then
      raise exception using
        errcode = '23514',
        message = 'Report version sequence is incomplete; the immediately preceding immutable version is required.';
    end if;

    if new.supersedes_report_id is null then
      new.supersedes_report_id := prior_report.id;
    elsif new.supersedes_report_id <> prior_report.id then
      raise exception using
        errcode = '23514',
        message = 'supersedes_report_id must reference the immediately preceding report version.';
    end if;

    if new.report_hash = prior_report.report_hash then
      raise exception using
        errcode = '23514',
        message = 'A new report version must have a distinct deterministic evidence hash.';
    end if;
  end if;

  if new.supersedes_report_id is not null then
    select * into superseded_report
    from public.mission_execution_reports
    where id = new.supersedes_report_id;

    if not found
       or superseded_report.command_run_id <> new.command_run_id
       or superseded_report.report_version >= new.report_version then
      raise exception using
        errcode = '23514',
        message = 'Supersession must reference an earlier immutable version for the same command run.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.prevent_mission_execution_report_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Mission execution reports are immutable. Create a new report version instead of updating or deleting an existing version.';
end;
$$;

drop trigger if exists mission_execution_reports_prepare_insert on public.mission_execution_reports;
create trigger mission_execution_reports_prepare_insert
before insert on public.mission_execution_reports
for each row execute function public.prepare_mission_execution_report_insert();

drop trigger if exists mission_execution_reports_immutable on public.mission_execution_reports;
create trigger mission_execution_reports_immutable
before update or delete on public.mission_execution_reports
for each row execute function public.prevent_mission_execution_report_mutation();

alter table public.mission_execution_reports enable row level security;

revoke all on table public.mission_execution_reports from anon, authenticated;
grant select on table public.mission_execution_reports to authenticated;

drop policy if exists mission_execution_reports_executive_read on public.mission_execution_reports;
create policy mission_execution_reports_executive_read
on public.mission_execution_reports
for select
to authenticated
using (
  coalesce(
    auth.jwt() -> 'app_metadata' ->> 'role',
    auth.jwt() -> 'user_metadata' ->> 'role',
    ''
  ) in ('executive', 'owner')
);

revoke update, delete, truncate on table public.mission_execution_reports from service_role;
grant select, insert on table public.mission_execution_reports to service_role;

comment on table public.mission_execution_reports is
  'Immutable, versioned APIE mission reports. DRAFT V1 may be followed by FINAL V2, AMENDED, or SUPERSEDED versions without overwriting prior evidence.';

commit;
