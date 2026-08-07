-- Rollback for APIE Mission Reporting Source-of-Truth lifecycle persistence v2
-- This rollback is intentionally non-destructive and aborts if v2-only rows exist.

begin;

do $$
begin
  if exists (
    select 1 from public.mission_execution_reports
    where report_state not in ('FINAL', 'AMENDED')
  ) then
    raise exception 'Rollback blocked: DRAFT or SUPERSEDED report versions exist. Preserve/export them and execute an explicitly authorized data-transition plan first.';
  end if;

  if exists (
    select 1 from public.mission_execution_reports
    where report_state = 'FINAL' and supersedes_report_id is not null
  ) then
    raise exception 'Rollback blocked: a FINAL report supersedes an earlier immutable version and cannot satisfy the legacy constraint.';
  end if;
end;
$$;

drop policy if exists mission_execution_reports_executive_read on public.mission_execution_reports;
revoke select on table public.mission_execution_reports from authenticated;

drop trigger if exists mission_execution_reports_immutable on public.mission_execution_reports;
drop trigger if exists mission_execution_reports_prepare_insert on public.mission_execution_reports;
drop function if exists public.prevent_mission_execution_report_mutation();
drop function if exists public.prepare_mission_execution_report_insert();

drop index if exists public.mission_execution_reports_report_id_unique;

alter table public.mission_execution_reports
  drop constraint if exists mission_execution_reports_report_state_check,
  drop constraint if exists mission_execution_reports_state_fields_check;

alter table public.mission_execution_reports
  add constraint mission_execution_reports_report_state_check
    check (report_state in ('FINAL', 'AMENDED')),
  add constraint mission_execution_reports_state_fields_check
    check (
      (
        report_state = 'FINAL'
        and finalized_at is not null
        and amended_at is null
        and amendment_reason is null
        and supersedes_report_id is null
      )
      or
      (
        report_state = 'AMENDED'
        and finalized_at is not null
        and amended_at is not null
        and nullif(trim(amendment_reason), '') is not null
        and supersedes_report_id is not null
      )
    );

alter table public.mission_execution_reports
  drop column if exists production_provenance,
  drop column if exists authoritative_run_status,
  drop column if exists operational_outcome,
  drop column if exists report_id;

commit;
