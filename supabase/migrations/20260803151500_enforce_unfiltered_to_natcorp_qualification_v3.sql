-- NAT-CORP Contract Qualification V3
-- Authority boundary: connectors acquire; PostgreSQL qualifies; NAT-CORP receives qualified records only.

create or replace view public.procurement_contracts_unfiltered as
select ar.id, ar.acquisition_run_id, ar.assignment_id, ar.publisher_id,
       pr.publisher_name, pr.state_code, ar.source_record_id, ar.source_url,
       ar.raw_payload, ar.retrieval_timestamp, ar.processing_status,
       ar.detail_retrieval_status, ar.detail_retrieved_at,
       ar.detail_retrieval_error, ar.source_fingerprint,
       ar.content_fingerprint, ar.canonical_opportunity_id
from public.acquisition_raw_records ar
join public.publisher_registry pr on pr.id = ar.publisher_id;

comment on view public.procurement_contracts_unfiltered is
'Authoritative unfiltered intake surface. Every publisher record is preserved before extraction, qualification, or NAT-CORP admission.';

create or replace function public.natcorp_contact_method_from_payload(p_payload jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
select jsonb_strip_nulls(jsonb_build_object(
  'contact_name',nullif(btrim(coalesce(p_payload->>'contact_name',p_payload#>>'{contact,name}','')),''),
  'contact_email',nullif(btrim(coalesce(p_payload->>'contact_email',p_payload#>>'{contact,email}','')),''),
  'contact_phone',nullif(btrim(coalesce(p_payload->>'contact_phone',p_payload#>>'{contact,phone}','')),''),
  'contact_url',nullif(btrim(coalesce(
    p_payload->>'contact_url',p_payload->>'qa_url',p_payload->>'questions_url',
    p_payload->>'submission_url',p_payload->>'response_url',
    p_payload#>>'{contact,url}',p_payload#>>'{submission,url}',
    p_payload#>>'{requirements,response_method_url}','')),'')
));
$$;

create or replace function public.natcorp_contact_method_is_usable(p_contact jsonb)
returns boolean language sql immutable set search_path=public,pg_temp as $$
select nullif(btrim(coalesce(p_contact->>'contact_email','')),'') is not null
    or nullif(btrim(coalesce(p_contact->>'contact_phone','')),'') is not null
    or nullif(btrim(coalesce(p_contact->>'contact_url','')),'') is not null;
$$;

create or replace function public.aadp_qualify_raw_record(
  p_raw_record_id uuid,
  p_requirements text,
  p_contact text,
  p_responsible_entity text,
  p_lifecycle_status text default 'OPEN'
) returns public.aadp_record_disposition
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_disposition public.aadp_record_disposition;
  v_code text;
  v_run uuid;
  v_payload jsonb;
  v_contact jsonb;
  v_requirements_present boolean;
  v_contact_present boolean;
begin
  select acquisition_run_id,raw_payload into v_run,v_payload
  from public.acquisition_raw_records where id=p_raw_record_id for update;
  if not found then raise exception 'Raw record not found'; end if;

  v_contact := public.natcorp_contact_method_from_payload(v_payload)
    || case when nullif(btrim(coalesce(p_contact,'')),'') is not null
            then jsonb_build_object('legacy_contact_text',btrim(p_contact))
            else '{}'::jsonb end;
  v_requirements_present := nullif(btrim(coalesce(p_requirements,'')),'') is not null;
  v_contact_present := public.natcorp_contact_method_is_usable(v_contact)
    or nullif(btrim(coalesce(p_contact,'')),'') is not null;

  if upper(coalesce(p_lifecycle_status,'')) in ('CLOSED','EXPIRED','CANCELLED','WITHDRAWN','SUPERSEDED') then
    v_disposition := upper(p_lifecycle_status)::public.aadp_record_disposition;
    v_code := upper(p_lifecycle_status)||'_RECORD';
  elsif not v_requirements_present then
    v_disposition := 'REJECTED_INCOMPLETE'; v_code := 'MISSING_CONTRACT_REQUIREMENTS';
  elsif not v_contact_present then
    v_disposition := 'REJECTED_INCOMPLETE'; v_code := 'MISSING_CONTACT_METHOD';
  elsif nullif(btrim(coalesce(p_responsible_entity,'')),'') is null then
    v_disposition := 'REVIEW_REQUIRED'; v_code := 'MISSING_RESPONSIBLE_ENTITY';
  else
    v_disposition := 'QUALIFIED'; v_code := null;
  end if;

  insert into public.acquisition_record_dispositions(
    acquisition_run_id,raw_record_id,disposition,reason_code,evidence
  ) values (
    v_run,p_raw_record_id,v_disposition,v_code,
    jsonb_build_object(
      'ruleset','NATCORP-CONTRACT-QUALIFICATION-V3',
      'requirements_required_for_admission',true,
      'requirements_present',v_requirements_present,
      'contact_required_for_admission',true,
      'contact_present',v_contact_present,
      'contact_method',v_contact,
      'responsible_entity_required',true,
      'responsible_entity_present',nullif(btrim(coalesce(p_responsible_entity,'')),'') is not null,
      'lifecycle_status',upper(coalesce(p_lifecycle_status,'OPEN'))
    )
  ) on conflict(acquisition_run_id,raw_record_id) do update
    set disposition=excluded.disposition, reason_code=excluded.reason_code,
        evidence=excluded.evidence,
        qualified_record_id=case when excluded.disposition<>'QUALIFIED' then null
                                 else acquisition_record_dispositions.qualified_record_id end,
        disposed_at=now();

  if v_code is not null then
    insert into public.acquisition_rejections(acquisition_run_id,raw_record_id,rejection_code,evidence)
    values(v_run,p_raw_record_id,v_code,jsonb_build_object(
      'ruleset','NATCORP-CONTRACT-QUALIFICATION-V3',
      'requirements_present',v_requirements_present,
      'contact_present',v_contact_present,
      'contact_method',v_contact,
      'responsible_entity_present',nullif(btrim(coalesce(p_responsible_entity,'')),'') is not null
    ));
  end if;

  update public.acquisition_raw_records
  set processing_status=v_disposition::text,
      processing_attempt_count=processing_attempt_count+1
  where id=p_raw_record_id;
  return v_disposition;
end;
$$;

-- The router must qualify before canonical insertion. The deployed database definition
-- is authoritative and includes: extraction routing, substantive-requirement testing,
-- contact-method qualification, duplicate handling, canonical insertion, and evidence.
-- This guard prevents accidental fallback to the V2 rule where contact was optional.

do $$
begin
  if position('contact_required_for_admission'',true' in replace(pg_get_functiondef(
      'public.aadp_qualify_raw_record(uuid,text,text,text,text)'::regprocedure),' ','')) = 0 then
    raise exception 'NAT-CORP V3 contact admission gate was not installed';
  end if;
end $$;

create or replace view public.natcorp_qualified_contracts as
select * from public.state_contract_opportunities
where natcorp_release_status='eligible'
  and qa_status='qualified_v3'
  and public.natcorp_requirements_are_substantive(requirements)
  and (
    nullif(btrim(coalesce(contact_email,'')),'') is not null
    or nullif(btrim(coalesce(contact_phone,'')),'') is not null
    or nullif(btrim(coalesce(raw_source_payload->>'qualified_contact_url','')),'') is not null
  );

comment on view public.natcorp_qualified_contracts is
'NAT-CORP admission surface: substantive requirements plus usable contact/response method under V3.';
