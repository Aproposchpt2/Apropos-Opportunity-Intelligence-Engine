alter table public.command_runs
  add column if not exists records_discovered integer not null default 0,
  add column if not exists records_acquired integer not null default 0,
  add column if not exists records_accepted integer not null default 0,
  add column if not exists records_rejected integer not null default 0;

alter table public.command_runs
  drop constraint if exists command_runs_records_discovered_nonnegative,
  drop constraint if exists command_runs_records_acquired_nonnegative,
  drop constraint if exists command_runs_records_accepted_nonnegative,
  drop constraint if exists command_runs_records_rejected_nonnegative;

alter table public.command_runs
  add constraint command_runs_records_discovered_nonnegative check (records_discovered >= 0),
  add constraint command_runs_records_acquired_nonnegative check (records_acquired >= 0),
  add constraint command_runs_records_accepted_nonnegative check (records_accepted >= 0),
  add constraint command_runs_records_rejected_nonnegative check (records_rejected >= 0);

comment on column public.command_runs.records_discovered is 'Source records or candidates identified during the command run.';
comment on column public.command_runs.records_acquired is 'Records successfully retrieved or staged during the command run.';
comment on column public.command_runs.records_accepted is 'Records accepted by the governed downstream qualification workflow.';
comment on column public.command_runs.records_rejected is 'Records rejected or failed during the governed downstream workflow.';
