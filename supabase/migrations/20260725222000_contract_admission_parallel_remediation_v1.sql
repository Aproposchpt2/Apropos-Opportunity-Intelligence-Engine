-- APIOS Command Center Automation Work Package 1
-- Checkpoint 4R parallel production-readiness remediation.
-- Additive implementation-branch migration. Production activation remains separate.

-- ---------------------------------------------------------------------------
-- Safe JSON helpers. These functions fail closed for malformed or unexpected
-- JSON shapes and are used by the evaluator and restrictive fallback.
-- ---------------------------------------------------------------------------
create or replace function public.apios_jsonb_nonempty_array(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select case
    when jsonb_typeof(p_value) = 'array' then jsonb_array_length(p_value) > 0
    else false
  end;
$$;

create or replace function public.apios_jsonb_substantive_requirements(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select case jsonb_typeof(p_value)
    when 'object' then p_value <> '{}'::jsonb
    when 'array' then jsonb_array_length(p_value) > 0
    else false
  end;
$$;

revoke all on function public.apios_jsonb_nonempty_array(jsonb) from public, anon, authenticated;
revoke all on function public.apios_jsonb_substantive_requirements(jsonb) from public, anon, authenticated;
grant execute on function public.apios_jsonb_nonempty_array(jsonb) to service_role;
grant execute on function public.apios_jsonb_substantive_requirements(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Foreign-key covering indexes. Existing primary, unique, composite, and
-- partial indexes were reviewed before these single-column indexes were added.
-- The rejection-ledger evaluation FK is already covered by the unique
-- contract_rejection_evaluation_unique_idx and is intentionally not duplicated.
-- ---------------------------------------------------------------------------
create index if not exists admitted_contracts_contact_evidence_id_idx
  on public.admitted_contracts(contact_evidence_id);
create index if not exists admitted_contracts_official_source_evidence_id_idx
  on public.admitted_contracts(official_source_evidence_id);
create index if not exists admitted_contracts_policy_id_idx
  on public.admitted_contracts(policy_id);
create index if not exists admitted_contracts_scope_evidence_id_idx
  on public.admitted_contracts(scope_evidence_id);
create index if not exists admitted_contracts_superseded_by_id_idx
  on public.admitted_contracts(superseded_by_admitted_contract_id);

create index if not exists apios_natcorp_delivery_v2_evaluation_id_idx
  on public.apios_natcorp_delivery_feed_v2(evaluation_id);
create index if not exists apios_natcorp_delivery_v2_policy_id_idx
  on public.apios_natcorp_delivery_feed_v2(policy_id);

create index if not exists contract_admission_evaluations_policy_id_idx
  on public.contract_admission_evaluations(policy_id);

create index if not exists contract_admission_events_admitted_contract_id_idx
  on public.contract_admission_events(admitted_contract_id);
create index if not exists contract_admission_events_evaluation_id_idx
  on public.contract_admission_events(evaluation_id);
create index if not exists contract_admission_events_policy_id_idx
  on public.contract_admission_events(policy_id);

create index if not exists contract_admission_review_candidate_id_idx
  on public.contract_admission_review_queue(candidate_opportunity_id);
create index if not exists contract_admission_review_evaluation_id_idx
  on public.contract_admission_review_queue(evaluation_id);

create index if not exists contract_evidence_references_evaluation_id_idx
  on public.contract_evidence_references(evaluation_id);

create index if not exists contract_rejection_ledger_policy_id_idx
  on public.contract_rejection_ledger(policy_id);
create index if not exists contract_rejection_ledger_superseded_eval_id_idx
  on public.contract_rejection_ledger(superseded_by_evaluation_id);

create index if not exists contract_admission_policy_superseded_by_id_idx
  on public.contract_admission_policy_versions(superseded_by_policy_id);

create index if not exists state_contract_opportunities_duplicate_of_idx
  on public.state_contract_opportunities(duplicate_of);

create index if not exists piee_document_sources_opportunity_id_idx
  on piee.document_sources(opportunity_id);
create index if not exists piee_document_sources_profile_id_idx
  on piee.document_sources(solicitation_profile_id);
create index if not exists piee_solicitation_profiles_opportunity_id_idx
  on piee.solicitation_profiles(opportunity_id);

-- ---------------------------------------------------------------------------
-- Review queue and event idempotency under concurrent execution.
-- ---------------------------------------------------------------------------
create unique index if not exists contract_review_one_active_evaluation_idx
  on public.contract_admission_review_queue(evaluation_id)
  where review_status in ('OPEN','ASSIGNED','IN_REVIEW');

create unique index if not exists contract_admission_request_event_unique_idx
  on public.contract_admission_events(candidate_opportunity_id,event_type,request_fingerprint)
  where request_fingerprint is not null;

create or replace function public.apios_prevent_duplicate_request_event()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.request_fingerprint is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        concat_ws('|',coalesce(new.candidate_opportunity_id::text,''),new.event_type,new.request_fingerprint),
        0
      )
    );

    if exists (
      select 1
      from public.contract_admission_events e
      where e.candidate_opportunity_id is not distinct from new.candidate_opportunity_id
        and e.event_type = new.event_type
        and e.request_fingerprint = new.request_fingerprint
    ) then
      return null;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.apios_prevent_duplicate_request_event() from public, anon, authenticated;

drop trigger if exists apios_prevent_duplicate_evaluation_event_trigger
  on public.contract_admission_events;
drop trigger if exists apios_prevent_duplicate_request_event_trigger
  on public.contract_admission_events;

create trigger apios_prevent_duplicate_request_event_trigger
before insert on public.contract_admission_events
for each row
execute function public.apios_prevent_duplicate_request_event();

-- ---------------------------------------------------------------------------
-- Restrictive emergency fallback. This is not Policy 1.0 admission and is not
-- an admitted-contract source. Unexpected JSON shapes are excluded.
-- ---------------------------------------------------------------------------
create or replace view public.apios_restrictive_legacy_delivery_fallback_v1
with (security_invoker=true) as
select o.*
from public.state_contract_opportunities o
where o.natcorp_release_status = 'eligible'
  and (
    nullif(btrim(o.contact_email),'') is not null
    or nullif(btrim(o.contact_phone),'') is not null
  )
  and nullif(btrim(o.description),'') is not null
  and public.apios_jsonb_substantive_requirements(o.requirements)
  and nullif(btrim(coalesce(o.official_source_url,o.source_url)),'') is not null
  and public.apios_jsonb_nonempty_array(o.document_urls)
  and lower(coalesce(o.status,'')) in ('open','active','posted','upcoming','open_continuous')
  and (
    lower(coalesce(o.status,'')) = 'open_continuous'
    or (o.response_deadline is not null and o.response_deadline > now())
  )
  and o.duplicate_of is null
  and coalesce(o.is_latest_version,false)
  and lower(coalesce(o.qa_status,'')) not in ('rejected','failed')
  and lower(coalesce(o.natcorp_contract_dna_status,'')) not in ('failed','error','blocked','review_required')
  and lower(coalesce(o.natcorp_release_reasons,'[]'::jsonb)::text) not like all (array[
    '%document%access%fail%',
    '%customer%release%fail%',
    '%enrichment%fail%',
    '%extraction%review%required%',
    '%mandatory evidence%unresolved%'
  ])
  and lower(coalesce(o.raw_source_payload,'{}'::jsonb)::text) not like all (array[
    '%document%access%fail%',
    '%customer%release%fail%',
    '%enrichment%fail%',
    '%extraction%review%required%',
    '%mandatory evidence%unresolved%'
  ]);

-- ---------------------------------------------------------------------------
-- Least-privilege direct object boundary. New tables remain RLS fail-closed.
-- Downstream reads are server-mediated and no browser role receives direct
-- admission, evidence, delivery, or metric access.
-- ---------------------------------------------------------------------------
alter view public.admitted_contracts_current set (security_invoker=true);
alter view public.aoie_admitted_contract_candidates_v1 set (security_invoker=true);
alter view public.apios_natcorp_delivery_current_v2 set (security_invoker=true);
alter view public.apios_contract_admission_metrics_v1 set (security_invoker=true);
alter view public.apios_restrictive_legacy_delivery_fallback_v1 set (security_invoker=true);

revoke all on table public.contract_admission_policy_versions from public, anon, authenticated;
revoke all on table public.contract_admission_evaluations from public, anon, authenticated;
revoke all on table public.contract_evidence_references from public, anon, authenticated;
revoke all on table public.contract_rejection_ledger from public, anon, authenticated;
revoke all on table public.contract_admission_review_queue from public, anon, authenticated;
revoke all on table public.admitted_contracts from public, anon, authenticated;
revoke all on table public.contract_admission_events from public, anon, authenticated;
revoke all on table public.apios_natcorp_delivery_feed_v2 from public, anon, authenticated;

revoke all on table public.admitted_contracts_current from public, anon, authenticated;
revoke all on table public.aoie_admitted_contract_candidates_v1 from public, anon, authenticated;
revoke all on table public.apios_natcorp_delivery_current_v2 from public, anon, authenticated;
revoke all on table public.apios_contract_admission_metrics_v1 from public, anon, authenticated;
revoke all on table public.apios_restrictive_legacy_delivery_fallback_v1 from public, anon, authenticated;

grant select on table public.admitted_contracts_current to service_role;
grant select on table public.aoie_admitted_contract_candidates_v1 to service_role;
grant select on table public.apios_natcorp_delivery_current_v2 to service_role;
grant select on table public.apios_contract_admission_metrics_v1 to service_role;
grant select on table public.apios_restrictive_legacy_delivery_fallback_v1 to service_role;

create or replace function public.apios_read_aoie_admitted_contract_candidates_v1(
  p_limit integer default 100,
  p_offset integer default 0
)
returns setof public.aoie_admitted_contract_candidates_v1
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  return query
  select *
  from public.aoie_admitted_contract_candidates_v1
  order by response_deadline nulls last, admitted_contract_id
  limit greatest(1,least(coalesce(p_limit,100),1000))
  offset greatest(coalesce(p_offset,0),0);
end;
$$;

create or replace function public.apios_read_natcorp_delivery_current_v2(
  p_limit integer default 100,
  p_offset integer default 0
)
returns setof public.apios_natcorp_delivery_current_v2
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  return query
  select *
  from public.apios_natcorp_delivery_current_v2
  order by response_deadline nulls last, delivery_feed_id
  limit greatest(1,least(coalesce(p_limit,100),1000))
  offset greatest(coalesce(p_offset,0),0);
end;
$$;

create or replace function public.apios_read_contract_admission_metrics_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  select to_jsonb(m) into v_result
  from public.apios_contract_admission_metrics_v1 m;

  return coalesce(v_result,'{}'::jsonb);
end;
$$;

create or replace function public.apios_read_restrictive_legacy_fallback_v1(
  p_limit integer default 100,
  p_offset integer default 0
)
returns setof public.apios_restrictive_legacy_delivery_fallback_v1
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  return query
  select *
  from public.apios_restrictive_legacy_delivery_fallback_v1
  order by response_deadline nulls last, id
  limit greatest(1,least(coalesce(p_limit,100),1000))
  offset greatest(coalesce(p_offset,0),0);
end;
$$;

revoke all on function public.apios_read_aoie_admitted_contract_candidates_v1(integer,integer) from public, anon, authenticated;
revoke all on function public.apios_read_natcorp_delivery_current_v2(integer,integer) from public, anon, authenticated;
revoke all on function public.apios_read_contract_admission_metrics_v1() from public, anon, authenticated;
revoke all on function public.apios_read_restrictive_legacy_fallback_v1(integer,integer) from public, anon, authenticated;

grant execute on function public.apios_read_aoie_admitted_contract_candidates_v1(integer,integer) to service_role;
grant execute on function public.apios_read_natcorp_delivery_current_v2(integer,integer) to service_role;
grant execute on function public.apios_read_contract_admission_metrics_v1() to service_role;
grant execute on function public.apios_read_restrictive_legacy_fallback_v1(integer,integer) to service_role;
