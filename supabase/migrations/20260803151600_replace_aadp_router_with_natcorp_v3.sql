create or replace function public.aadp_route_pending_raw_records(p_batch_size integer default 100)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r record; v_claimed int:=0; v_inserted int:=0; v_duplicates int:=0;
  v_extraction_required int:=0; v_rejected int:=0; v_contact_required int:=0;
  v_opportunity_id uuid; v_title text; v_description text; v_requirements jsonb;
  v_issuer text; v_state text; v_platform text; v_status text; v_deadline timestamptz;
  v_contact jsonb; v_contact_name text; v_contact_email text; v_contact_phone text; v_contact_url text;
  v_disposition public.aadp_record_disposition;
begin
  for r in
    select ar.*,pr.publisher_name,pr.state_code,pr.configuration,pa.acquisition_method
    from public.acquisition_raw_records ar
    join public.publisher_registry pr on pr.id=ar.publisher_id
    join public.publisher_assignments pa on pa.id=ar.assignment_id
    where ar.processing_status='RAW'
    order by ar.retrieval_timestamp,ar.id
    for update of ar skip locked
    limit greatest(1,least(coalesce(p_batch_size,100),500))
  loop
    v_claimed:=v_claimed+1;
    v_title:=nullif(btrim(coalesce(r.raw_payload->>'title',r.raw_payload->>'name',r.raw_payload->>'solicitation_title','')),'');
    v_description:=nullif(btrim(coalesce(r.raw_payload->>'description',r.raw_payload->>'summary',r.raw_payload->>'scope',r.raw_payload->>'requirements_text',r.raw_payload#>>'{requirements,scope}','')),'');
    v_issuer:=coalesce(nullif(btrim(r.raw_payload->>'issuing_organization'),''),nullif(btrim(r.raw_payload->>'agency'),''),r.publisher_name);
    v_state:=coalesce(nullif(btrim(r.raw_payload->>'state_code'),''),r.state_code);
    v_platform:=coalesce(nullif(btrim(r.raw_payload->>'platform'),''),nullif(btrim(r.raw_payload->>'__procurement_platform'),''),r.acquisition_method,'UNKNOWN');
    v_status:=lower(coalesce(nullif(btrim(r.raw_payload->>'status'),''),'open'));
    begin
      v_deadline:=coalesce(nullif(r.raw_payload->>'response_deadline','')::timestamptz,nullif(r.raw_payload->>'due_date','')::timestamptz,nullif(r.raw_payload->>'deadline','')::timestamptz);
    exception when others then v_deadline:=null; end;

    v_contact:=public.natcorp_contact_method_from_payload(r.raw_payload);
    v_contact_name:=nullif(v_contact->>'contact_name','');
    v_contact_email:=nullif(v_contact->>'contact_email','');
    v_contact_phone:=nullif(v_contact->>'contact_phone','');
    v_contact_url:=nullif(v_contact->>'contact_url','');

    if v_description is null or length(v_description)<80 or v_title is null
       or lower(coalesce(r.raw_payload->>'record_type','')) in ('individual_solicitation_candidate','publisher_or_portal_landing_page') then
      update public.acquisition_raw_records
      set processing_status='EXTRACTION_REQUIRED',processing_attempt_count=processing_attempt_count+1,
          detail_retrieval_status=case when detail_retrieval_status='COMPLETE' then detail_retrieval_status else 'PENDING' end
      where id=r.id;
      v_extraction_required:=v_extraction_required+1; continue;
    end if;

    v_requirements:=case
      when jsonb_typeof(r.raw_payload->'requirements') in ('object','array','string') and r.raw_payload->'requirements'<>'{}'::jsonb
      then r.raw_payload->'requirements' else jsonb_build_object('scope',v_description) end;

    if not public.natcorp_requirements_are_substantive(v_requirements) then
      perform public.aadp_qualify_raw_record(r.id,null,concat_ws(' | ',v_contact_email,v_contact_phone,v_contact_url),v_issuer,v_status);
      v_rejected:=v_rejected+1; continue;
    end if;

    v_disposition:=public.aadp_qualify_raw_record(r.id,v_description,concat_ws(' | ',v_contact_email,v_contact_phone,v_contact_url),v_issuer,v_status);
    if v_disposition<>'QUALIFIED' then
      if exists(select 1 from public.acquisition_record_dispositions d where d.raw_record_id=r.id and d.reason_code='MISSING_CONTACT_METHOD')
      then v_contact_required:=v_contact_required+1; else v_rejected:=v_rejected+1; end if;
      continue;
    end if;

    select o.id into v_opportunity_id from public.state_contract_opportunities o
    where (o.source_fingerprint is not null and o.source_fingerprint=r.source_fingerprint)
       or (o.source_platform=v_platform and o.source_record_id=r.source_record_id) limit 1;
    if v_opportunity_id is not null then
      update public.acquisition_raw_records set processing_status='DUPLICATE',canonical_opportunity_id=v_opportunity_id::text where id=r.id;
      update public.acquisition_record_dispositions
      set disposition='DUPLICATE',reason_code='EXISTING_CANONICAL_RECORD',qualified_record_id=v_opportunity_id,
          evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object('duplicate_of',v_opportunity_id)
      where raw_record_id=r.id;
      v_duplicates:=v_duplicates+1; continue;
    end if;

    insert into public.state_contract_opportunities(
      state_code,issuing_organization,source_platform,source_record_id,source_url,official_source_url,
      vendor_registration_url,solicitation_number,title,description,procurement_type,notice_type,status,
      response_deadline,contact_name,contact_email,contact_phone,requirements,raw_source_payload,
      source_fingerprint,content_fingerprint,acquisition_method,ingestion_run_id,qa_status,
      natcorp_release_status,natcorp_release_reasons,natcorp_release_evaluated_at,natcorp_released_at
    ) values(
      v_state,v_issuer,v_platform,r.source_record_id,r.source_url,coalesce(nullif(r.raw_payload->>'official_source_url',''),r.source_url),
      nullif(r.raw_payload#>>'{__publisher_connection_profile,vendor_registration_url}',''),
      coalesce(nullif(r.raw_payload->>'solicitation_number',''),nullif(r.raw_payload->>'bid_number','')),
      v_title,v_description,nullif(r.raw_payload->>'procurement_type',''),nullif(r.raw_payload->>'notice_type',''),
      case when v_status in ('open','active','posted','upcoming','open_continuous') then v_status else 'open' end,
      v_deadline,v_contact_name,v_contact_email,v_contact_phone,v_requirements,
      r.raw_payload||case when v_contact_url is not null then jsonb_build_object('qualified_contact_url',v_contact_url) else '{}'::jsonb end,
      r.source_fingerprint,r.content_fingerprint,r.acquisition_method,r.acquisition_run_id::text,'qualified_v3',
      'eligible',jsonb_build_array('SUBSTANTIVE_REQUIREMENTS','USABLE_CONTACT_METHOD','OPEN_OFFICIAL_SOURCE'),now(),now()
    ) returning id into v_opportunity_id;

    update public.acquisition_raw_records set processing_status='CANONICAL',canonical_opportunity_id=v_opportunity_id::text where id=r.id;
    update public.acquisition_record_dispositions
    set qualified_record_id=v_opportunity_id,evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object(
      'canonical_opportunity_id',v_opportunity_id,'routing_job','aadp_route_pending_raw_records_v3','natcorp_admission_gate_passed',true)
    where raw_record_id=r.id;
    v_inserted:=v_inserted+1;
  end loop;

  return jsonb_build_object('ruleset','NATCORP-CONTRACT-QUALIFICATION-V3','claimed',v_claimed,
    'canonical_inserted',v_inserted,'duplicates',v_duplicates,'extraction_required',v_extraction_required,
    'contact_required',v_contact_required,'rejected',v_rejected);
end;
$$;
