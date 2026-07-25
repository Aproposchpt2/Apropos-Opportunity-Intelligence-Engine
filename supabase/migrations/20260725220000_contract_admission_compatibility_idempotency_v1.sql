-- APIOS Command Center Automation Work Package 1
-- Checkpoint 4R compatibility and idempotency hardening.
-- Additive corrective migration. Production activation remains separate.

-- pgcrypto is installed in the extensions schema in the production-compatible
-- Supabase environment. Keep a fixed, explicit search path so digest() resolves
-- without allowing caller-controlled schema resolution.
do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'apios_admission_caller_authorized',
        'evaluate_contract_candidate',
        'promote_candidate_to_admitted_contract',
        'revoke_admitted_contract',
        'activate_contract_admission_policy',
        'is_contract_currently_admitted',
        'get_current_admitted_contract',
        'publish_admitted_contract_to_natcorp',
        'remove_contract_from_natcorp_delivery'
      ])
  loop
    execute format(
      'alter function %s set search_path = public, extensions, pg_temp',
      v_function
    );
  end loop;
end;
$$;

-- Preserve one rejection-ledger record per immutable evaluation. Remove only
-- duplicate shadow/development rows, retaining the earliest authoritative row.
with ranked_rejections as (
  select rejection_id,
         row_number() over (
           partition by evaluation_id
           order by rejected_at, created_at, rejection_id
         ) as duplicate_rank
  from public.contract_rejection_ledger
)
delete from public.contract_rejection_ledger r
using ranked_rejections d
where r.rejection_id = d.rejection_id
  and d.duplicate_rank > 1;

create unique index if not exists contract_rejection_evaluation_unique_idx
  on public.contract_rejection_ledger(evaluation_id);

-- The evaluator already uses ON CONFLICT DO NOTHING. The unique evaluation
-- index now gives that clause a deterministic idempotency boundary.
