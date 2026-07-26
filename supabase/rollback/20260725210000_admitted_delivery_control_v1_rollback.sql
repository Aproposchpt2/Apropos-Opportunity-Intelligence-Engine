-- Safe rollback for admitted-only NAT-CORP delivery control.
-- Preserves delivery and admission history while removing active execution paths.

revoke all on function public.publish_admitted_contract_to_natcorp(uuid,uuid,uuid,jsonb,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.remove_contract_from_natcorp_delivery(uuid,text[],uuid,uuid) from public, anon, authenticated, service_role;

drop view if exists public.apios_contract_admission_metrics_v1;
drop view if exists public.apios_natcorp_delivery_current_v2;

drop function if exists public.remove_contract_from_natcorp_delivery(uuid,text[],uuid,uuid);
drop function if exists public.publish_admitted_contract_to_natcorp(uuid,uuid,uuid,jsonb,uuid,uuid);

-- The delivery feed table is intentionally retained as historical evidence.
revoke all on public.apios_natcorp_delivery_feed_v2 from anon, authenticated;
