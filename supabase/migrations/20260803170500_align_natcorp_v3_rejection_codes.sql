-- Align NAT-CORP Qualification V3 with the authoritative acquisition_rejections taxonomy.

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
    v_disposition := 'REJECTED_INCOMPLETE'; v_code := 'MISSING_CONTRACT_CONTACT';
  elsif nullif(btrim(coalesce(p_responsible_entity,'')),'') is null then
    v_disposition := 'REVIEW_REQUIRED'; v_code := 'RESPONSIBLE_ENTITY_NOT_IDENTIFIED';
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

comment on function public.aadp_qualify_raw_record(uuid,text,text,text,text) is
'NAT-CORP Qualification V3 using the authoritative acquisition_rejections taxonomy.';
