create or replace function public.command_runs_normalize_progress_mode()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.progress_mode = 'DETERMINATE' then
    new.progress_mode := 'STAGE';
  end if;
  return new;
end;
$$;

drop trigger if exists command_runs_normalize_progress_mode_trigger
on public.command_runs;

create trigger command_runs_normalize_progress_mode_trigger
before insert or update of progress_mode
on public.command_runs
for each row
execute function public.command_runs_normalize_progress_mode();

comment on function public.command_runs_normalize_progress_mode() is
'Normalizes the legacy DETERMINATE progress mode to the approved STAGE value before command_runs constraints are evaluated.';
