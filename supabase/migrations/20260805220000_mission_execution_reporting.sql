begin;

create table if not exists public.mission_execution_reports (
  id uuid primary key default gen_random_uuid(),
  command_run_id uuid not null references public.command_runs(id) on delete restrict,
  mission_type_key text not null,
  report_version integer not null check (report_version > 0),
  report_state text not null check (report_state in ('FINAL', 'AMENDED')),
  report_data jsonb not null,
  report_hash text not null check (report_hash ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null default now(),
  finalized_at timestamptz,
  amended_at timestamptz,
  amendment_reason text,
  supersedes_report_id uuid references public.mission_execution_reports(id) on delete restrict,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mission_execution_reports_run_version_unique unique (command_run_id, report_version),
  constraint mission_execution_reports_state_fields_check check (
    (report_state = 'FINAL' and finalized_at is not null and amended_at is null and amendment_reason is null and supersedes_report_id is null)
    or
    (report_state = 'AMENDED' and finalized_at is not null and amended_at is not null and nullif(trim(amendment_reason), '') is not null and supersedes_report_id is not null)
  )
);

create index if not exists mission_execution_reports_run_idx
  on public.mission_execution_reports (command_run_id, report_version desc);

create index if not exists mission_execution_reports_type_generated_idx
  on public.mission_execution_reports (mission_type_key, generated_at desc);

create index if not exists mission_execution_reports_state_generated_idx
  on public.mission_execution_reports (report_state, generated_at desc);

create or replace function public.prevent_mission_execution_report_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Mission execution report snapshots are immutable. Create an AMENDED version instead.'
    using errcode = '55000';
end;
$$;

drop trigger if exists mission_execution_reports_immutable_update on public.mission_execution_reports;
create trigger mission_execution_reports_immutable_update
before update on public.mission_execution_reports
for each row execute function public.prevent_mission_execution_report_mutation();

drop trigger if exists mission_execution_reports_immutable_delete on public.mission_execution_reports;
create trigger mission_execution_reports_immutable_delete
before delete on public.mission_execution_reports
for each row execute function public.prevent_mission_execution_report_mutation();

alter table public.mission_execution_reports enable row level security;

revoke all on table public.mission_execution_reports from public, anon, authenticated;
grant select, insert on table public.mission_execution_reports to service_role;

comment on table public.mission_execution_reports is
  'Immutable mission-specific execution report snapshots keyed by command_run_id and report_version. DRAFT reports are generated at read time and are not persisted.';

comment on column public.mission_execution_reports.report_hash is
  'SHA-256 hash of the canonical report_data snapshot.';

commit;

-- Rollback plan (manual, destructive only with explicit authorization):
-- drop trigger if exists mission_execution_reports_immutable_delete on public.mission_execution_reports;
-- drop trigger if exists mission_execution_reports_immutable_update on public.mission_execution_reports;
-- drop function if exists public.prevent_mission_execution_report_mutation();
-- drop table if exists public.mission_execution_reports;
