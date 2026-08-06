begin;

alter table public.mission_execution_reports
  drop constraint if exists mission_execution_reports_report_state_check;

alter table public.mission_execution_reports
  drop constraint if exists mission_execution_reports_state_fields_check;

alter table public.mission_execution_reports
  add constraint mission_execution_reports_report_state_check
  check (report_state in ('DRAFT', 'FINAL', 'AMENDED'));

alter table public.mission_execution_reports
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
      and (
        (report_version = 1 and supersedes_report_id is null)
        or
        (report_version > 1 and supersedes_report_id is not null)
      )
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

comment on table public.mission_execution_reports is
  'Immutable mission execution report snapshots. DRAFT Version 1 may be preserved before a terminal run; a later FINAL version must supersede the prior snapshot without overwriting it.';

comment on column public.mission_execution_reports.supersedes_report_id is
  'References the immutable prior report snapshot superseded by a later FINAL or AMENDED version.';

commit;

-- Rollback is intentionally not automated because report snapshots may exist
-- under the DRAFT-to-FINAL version model after this migration is applied.
