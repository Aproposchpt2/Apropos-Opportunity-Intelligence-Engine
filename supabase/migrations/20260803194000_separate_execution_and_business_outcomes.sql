alter table public.command_runs
  add column if not exists reconciliation_status text not null default 'PENDING',
  add column if not exists qualification_status text not null default 'PENDING',
  add column if not exists validation_status text not null default 'PENDING',
  add column if not exists qualification_summary jsonb not null default '{}'::jsonb,
  add column if not exists reconciliation_diagnostics jsonb not null default '{}'::jsonb;

alter table public.acquisition_runs
  add column if not exists reconciliation_status text not null default 'PENDING',
  add column if not exists qualification_status text not null default 'PENDING',
  add column if not exists validation_status text not null default 'PENDING';

do $$ begin alter table public.command_runs add constraint command_runs_reconciliation_status_ck check (reconciliation_status in ('PENDING','MATCHED','PARTIAL','MISMATCH','FAILED')); exception when duplicate_object then null; end $$;
do $$ begin alter table public.command_runs add constraint command_runs_qualification_status_ck check (qualification_status in ('PENDING','RUNNING','COMPLETED','FAILED')); exception when duplicate_object then null; end $$;
do $$ begin alter table public.command_runs add constraint command_runs_validation_status_ck check (validation_status in ('PENDING','PASSED','WARNING','FAILED')); exception when duplicate_object then null; end $$;
do $$ begin alter table public.acquisition_runs add constraint acquisition_runs_reconciliation_status_ck check (reconciliation_status in ('PENDING','MATCHED','PARTIAL','MISMATCH','FAILED')); exception when duplicate_object then null; end $$;
do $$ begin alter table public.acquisition_runs add constraint acquisition_runs_qualification_status_ck check (qualification_status in ('PENDING','RUNNING','COMPLETED','FAILED')); exception when duplicate_object then null; end $$;
do $$ begin alter table public.acquisition_runs add constraint acquisition_runs_validation_status_ck check (validation_status in ('PENDING','PASSED','WARNING','FAILED')); exception when duplicate_object then null; end $$;

create table if not exists public.connector_acceptance_registry (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references public.publisher_registry(id) on delete cascade,
  connector_key text not null,
  connector_version text not null default '1.0',
  acceptance_status text not null default 'PENDING' check (acceptance_status in ('NOT_STARTED','PENDING','TESTING','ACCEPTED','REJECTED','REVALIDATION_REQUIRED')),
  last_command_run_id uuid references public.command_runs(id) on delete set null,
  last_acquisition_run_id uuid references public.acquisition_runs(id) on delete set null,
  publisher_reported_total integer,
  records_acquired integer,
  records_qualified integer,
  extraction_required integer,
  contact_required integer,
  records_rejected integer,
  duplicates integer,
  reconciliation_status text,
  qualification_status text,
  validation_status text,
  acceptance_evidence jsonb not null default '{}'::jsonb,
  tested_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (publisher_id, connector_key, connector_version)
);
create index if not exists connector_acceptance_registry_status_idx on public.connector_acceptance_registry(acceptance_status,updated_at desc);
