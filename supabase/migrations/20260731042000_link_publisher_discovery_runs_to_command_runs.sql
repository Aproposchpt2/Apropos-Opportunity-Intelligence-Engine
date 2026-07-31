alter table public.publisher_discovery_runs
  add column if not exists command_run_id uuid references public.command_runs(id) on delete set null;

create index if not exists publisher_discovery_runs_command_run_id_idx
  on public.publisher_discovery_runs(command_run_id, created_at desc);
