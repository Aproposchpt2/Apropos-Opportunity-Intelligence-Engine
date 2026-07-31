-- VAR corrective: tolerate legacy discovery stage INSERTs while source callers use explicit on_conflict.
create or replace function public.command_stage_projection_insert_compat()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1 from public.command_stage_projection
    where command_run_id = new.command_run_id and stage_key = new.stage_key
  ) then
    update public.command_stage_projection
       set display_name = new.display_name,
           display_state = new.display_state,
           sequence_number = new.sequence_number,
           progress_value = new.progress_value,
           started_at = coalesce(new.started_at, started_at),
           completed_at = new.completed_at,
           records_processed = new.records_processed,
           warning_count = new.warning_count,
           failure_count = new.failure_count,
           retry_count = new.retry_count,
           source_projection = new.source_projection,
           evidence = new.evidence,
           updated_at = coalesce(new.updated_at, now())
     where command_run_id = new.command_run_id and stage_key = new.stage_key;
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists command_stage_projection_insert_compat_trg on public.command_stage_projection;
create trigger command_stage_projection_insert_compat_trg
before insert on public.command_stage_projection
for each row execute function public.command_stage_projection_insert_compat();
