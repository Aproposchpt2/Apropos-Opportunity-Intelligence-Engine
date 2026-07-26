-- APIOS Command Center Automation Work Package 1
-- Checkpoint 4R evaluation-event idempotency hardening.
-- Additive corrective migration. Production activation remains separate.

with ranked_events as (
  select event_id,
         row_number() over (
           partition by evaluation_id, event_type, request_fingerprint
           order by occurred_at, event_id
         ) as duplicate_rank
  from public.contract_admission_events
  where event_type = 'EVALUATION_COMPLETED'
    and evaluation_id is not null
    and request_fingerprint is not null
)
delete from public.contract_admission_events e
using ranked_events d
where e.event_id = d.event_id
  and d.duplicate_rank > 1;

create unique index if not exists contract_admission_evaluation_event_unique_idx
  on public.contract_admission_events(evaluation_id, event_type, request_fingerprint)
  where event_type = 'EVALUATION_COMPLETED'
    and evaluation_id is not null
    and request_fingerprint is not null;

-- Recreate the evaluator's event insertion as conflict-safe by attaching a
-- trigger that suppresses an identical evaluation event before insertion.
create or replace function public.apios_prevent_duplicate_evaluation_event()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.event_type = 'EVALUATION_COMPLETED'
     and new.evaluation_id is not null
     and new.request_fingerprint is not null
     and exists (
       select 1
       from public.contract_admission_events e
       where e.evaluation_id = new.evaluation_id
         and e.event_type = new.event_type
         and e.request_fingerprint = new.request_fingerprint
     ) then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.apios_prevent_duplicate_evaluation_event() from public, anon, authenticated;

drop trigger if exists apios_prevent_duplicate_evaluation_event_trigger
  on public.contract_admission_events;

create trigger apios_prevent_duplicate_evaluation_event_trigger
before insert on public.contract_admission_events
for each row
execute function public.apios_prevent_duplicate_evaluation_event();
