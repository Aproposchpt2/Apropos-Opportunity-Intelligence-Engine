-- APIOS Command Center Automation Work Package 1
-- Safe rollback for the privileged function layer.
-- This rollback removes execution paths only. It preserves all admission evidence and history.

revoke all on function public.evaluate_contract_candidate(uuid,text,uuid,uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.promote_candidate_to_admitted_contract(uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.revoke_admitted_contract(uuid,text[],text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.activate_contract_admission_policy(uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_contract_currently_admitted(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_current_admitted_contract(uuid) from public, anon, authenticated, service_role;
revoke all on function public.apios_admission_caller_authorized() from public, anon, authenticated, service_role;

drop function if exists public.get_current_admitted_contract(uuid);
drop function if exists public.is_contract_currently_admitted(uuid);
drop function if exists public.activate_contract_admission_policy(uuid,text,uuid);
drop function if exists public.revoke_admitted_contract(uuid,text[],text,uuid);
drop function if exists public.promote_candidate_to_admitted_contract(uuid,uuid,uuid);
drop function if exists public.evaluate_contract_candidate(uuid,text,uuid,uuid,text);
drop function if exists public.apios_admission_caller_authorized();

-- Admission tables, evaluations, evidence, rejection records, admissions, and events are intentionally preserved.
