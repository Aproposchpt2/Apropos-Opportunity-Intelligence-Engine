-- APIOS Command Center Automation Work Package 1
-- Admitted-only delivery control plane. Additive only; production cutover is separate.

create table if not exists public.apios_natcorp_delivery_feed_v2 (
  delivery_feed_id uuid primary key default gen_random_uuid(),
  admitted_contract_id uuid not null references public.admitted_contracts(admitted_contract_id),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  evaluation_id uuid not null references public.contract_admission_evaluations(evaluation_id),
  policy_id uuid not null references public.contract_admission_policy_versions(policy_id),
  business_profile_id uuid,
  match_id uuid,
  delivery_status text not null check (delivery_status in ('READY','RELEASED','HELD','REMOVED','EXPIRED','REVOKED','SUPERSEDED')),
  release_timestamp timestamptz,
  expiration_timestamp timestamptz,
  match_explanation jsonb not null default '{}'::jsonb,
  delivery_fingerprint text not null,
  removal_reason_codes text[] not null default '{}',
  correlation_id uuid not null,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(admitted_contract_id,business_profile_id,match_id,delivery_fingerprint)
);

create index if not exists apios_natcorp_delivery_v2_status_idx
  on public.apios_natcorp_delivery_feed_v2(delivery_status,expiration_timestamp);
create index if not exists apios_natcorp_delivery_v2_candidate_idx
  on public.apios_natcorp_delivery_feed_v2(candidate_opportunity_id,created_at desc);

alter table public.apios_natcorp_delivery_feed_v2 enable row level security;
revoke all on public.apios_natcorp_delivery_feed_v2 from anon, authenticated;

create or replace function public.publish_admitted_contract_to_natcorp(
  p_admitted_contract_id uuid,
  p_business_profile_id uuid default null,
  p_match_id uuid default null,
  p_match_explanation jsonb default '{}'::jsonb,
  p_run_id uuid default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_fingerprint text;
  v_delivery_id uuid;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  select * into v_contract
  from public.admitted_contracts_current
  where admitted_contract_id=p_admitted_contract_id;

  if not found then
    return jsonb_build_object('success',false,'status','NOT_ADMITTED','admitted_contract_id',p_admitted_contract_id,'correlation_id',p_correlation_id);
  end if;

  v_fingerprint := encode(digest(concat_ws('|',v_contract.admitted_contract_id::text,coalesce(p_business_profile_id::text,''),coalesce(p_match_id::text,''),v_contract.document_fingerprint,v_contract.policy_id::text,coalesce(p_match_explanation,'{}'::jsonb)::text),'sha256'),'hex');

  insert into public.apios_natcorp_delivery_feed_v2(
    admitted_contract_id,candidate_opportunity_id,evaluation_id,policy_id,business_profile_id,match_id,
    delivery_status,release_timestamp,expiration_timestamp,match_explanation,delivery_fingerprint,correlation_id,run_id
  ) values (
    v_contract.admitted_contract_id,v_contract.candidate_opportunity_id,v_contract.evaluation_id,v_contract.policy_id,
    p_business_profile_id,p_match_id,'RELEASED',now(),v_contract.response_deadline,
    coalesce(p_match_explanation,'{}'::jsonb),v_fingerprint,p_correlation_id,p_run_id
  )
  on conflict(admitted_contract_id,business_profile_id,match_id,delivery_fingerprint)
  do update set delivery_status='RELEASED',release_timestamp=coalesce(public.apios_natcorp_delivery_feed_v2.release_timestamp,excluded.release_timestamp),expiration_timestamp=excluded.expiration_timestamp,updated_at=now()
  returning delivery_feed_id into v_delivery_id;

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,new_state,policy_id,
    actor_type,actor_id,evidence_manifest,correlation_id,run_id,request_fingerprint
  ) values (
    v_contract.candidate_opportunity_id,v_contract.evaluation_id,v_contract.admitted_contract_id,'DELIVERY_PUBLISHED',
    jsonb_build_object('delivery_status','RELEASED','delivery_feed_id',v_delivery_id),v_contract.policy_id,
    'SERVICE','APIOS_DELIVERY_RECONCILER',jsonb_build_object('match_id',p_match_id,'business_profile_id',p_business_profile_id),
    p_correlation_id,p_run_id,v_fingerprint
  );

  return jsonb_build_object('success',true,'status','RELEASED','delivery_feed_id',v_delivery_id,'admitted_contract_id',p_admitted_contract_id,'correlation_id',p_correlation_id);
end;
$$;

create or replace function public.remove_contract_from_natcorp_delivery(
  p_admitted_contract_id uuid,
  p_reason_codes text[],
  p_run_id uuid default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer := 0;
  v_admission public.admitted_contracts%rowtype;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;
  if cardinality(coalesce(p_reason_codes,'{}'::text[]))=0 then
    raise exception 'at least one removal reason is required';
  end if;

  select * into v_admission from public.admitted_contracts where admitted_contract_id=p_admitted_contract_id;
  if not found then
    return jsonb_build_object('success',false,'status','NOT_FOUND','admitted_contract_id',p_admitted_contract_id,'correlation_id',p_correlation_id);
  end if;

  update public.apios_natcorp_delivery_feed_v2
  set delivery_status=case
        when v_admission.admission_status='REVOKED' then 'REVOKED'
        when v_admission.admission_status='SUPERSEDED' then 'SUPERSEDED'
        when v_admission.admission_status in ('EXPIRED','CLOSED','CANCELLED','WITHDRAWN') then 'EXPIRED'
        else 'REMOVED'
      end,
      removal_reason_codes=p_reason_codes,
      updated_at=now()
  where admitted_contract_id=p_admitted_contract_id
    and delivery_status in ('READY','RELEASED','HELD');
  get diagnostics v_updated=row_count;

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,prior_state,new_state,policy_id,
    actor_type,actor_id,reason_codes,correlation_id,run_id
  ) values (
    v_admission.candidate_opportunity_id,v_admission.evaluation_id,p_admitted_contract_id,'DELIVERY_REMOVED',
    jsonb_build_object('active_delivery_records',v_updated),jsonb_build_object('delivery_status','REMOVED'),v_admission.policy_id,
    'SERVICE','APIOS_DELIVERY_RECONCILER',p_reason_codes,p_correlation_id,p_run_id
  );

  return jsonb_build_object('success',true,'status','REMOVED','updated',v_updated,'admitted_contract_id',p_admitted_contract_id,'correlation_id',p_correlation_id);
end;
$$;

create or replace view public.apios_natcorp_delivery_current_v2
with (security_invoker=true) as
select d.*, c.title, c.solicitation_number, c.issuing_organization, c.official_source_url,
       c.procurement_type, c.state_code, c.county, c.city, c.response_deadline
from public.apios_natcorp_delivery_feed_v2 d
join public.admitted_contracts_current c on c.admitted_contract_id=d.admitted_contract_id
where d.delivery_status='RELEASED'
  and (d.expiration_timestamp is null or d.expiration_timestamp>now());

create or replace view public.apios_contract_admission_metrics_v1
with (security_invoker=true) as
select
  (select count(*) from public.state_contract_opportunities) as candidate_count,
  (select count(*) from public.contract_admission_evaluations where evaluation_status='PENDING') as pending_evaluation_count,
  (select count(*) from public.contract_admission_evaluations where evaluation_status='REJECTED') as rejected_evaluation_count,
  (select count(*) from public.contract_admission_review_queue where review_status in ('OPEN','ASSIGNED','IN_REVIEW')) as review_queue_count,
  (select count(*) from public.admitted_contracts_current) as current_admitted_count,
  (select count(*) from public.admitted_contracts where admission_status='REVOKED') as revoked_count,
  (select count(*) from public.apios_natcorp_delivery_current_v2) as current_natcorp_delivery_count,
  (select count(*) from public.contract_admission_events where event_type='UNAUTHORIZED_ATTEMPT') as unauthorized_attempt_count;

revoke all on function public.publish_admitted_contract_to_natcorp(uuid,uuid,uuid,jsonb,uuid,uuid) from public, anon, authenticated;
revoke all on function public.remove_contract_from_natcorp_delivery(uuid,text[],uuid,uuid) from public, anon, authenticated;
grant execute on function public.publish_admitted_contract_to_natcorp(uuid,uuid,uuid,jsonb,uuid,uuid) to service_role;
grant execute on function public.remove_contract_from_natcorp_delivery(uuid,text[],uuid,uuid) to service_role;
