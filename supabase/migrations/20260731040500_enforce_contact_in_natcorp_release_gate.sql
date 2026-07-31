-- VAR corrective: NAT-CORP release eligibility requires a named contract contact
-- and at least one usable contact method, in addition to requirements/scope controls.
create or replace function public.natcorp_apply_release_gates(p_opportunity_ids uuid[] default null::uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  r record;
  v_reasons jsonb;
  v_status text;
  v_eligible integer := 0;
  v_enrichment integer := 0;
  v_rejected integer := 0;
begin
  for r in
    select * from public.state_contract_opportunities
    where p_opportunity_ids is null or id = any(p_opportunity_ids)
  loop
    v_reasons := '[]'::jsonb;
    if lower(coalesce(r.status,'')) not in ('open','active','posted','upcoming','open_continuous') then v_reasons := v_reasons || '"not_current"'::jsonb; end if;
    if r.response_deadline is null or r.response_deadline < now() then v_reasons := v_reasons || '"invalid_deadline"'::jsonb; end if;
    if nullif(coalesce(r.official_source_url,r.source_url),'') is null then v_reasons := v_reasons || '"missing_official_source"'::jsonb; end if;
    if nullif(r.issuing_organization,'') is null then v_reasons := v_reasons || '"missing_issuer"'::jsonb; end if;
    if nullif(r.contact_name,'') is null or (nullif(r.contact_email,'') is null and nullif(r.contact_phone,'') is null) then v_reasons := v_reasons || '"missing_contract_contact"'::jsonb; end if;
    if nullif(r.description,'') is null and jsonb_array_length(coalesce(r.document_urls,'[]'::jsonb))=0 then v_reasons := v_reasons || '"missing_scope_or_documents"'::jsonb; end if;
    if coalesce(r.requirements,'{}'::jsonb)='{}'::jsonb and coalesce(r.natcorp_contract_dna_status,'') <> 'complete' then v_reasons := v_reasons || '"missing_requirements"'::jsonb; end if;
    if r.duplicate_of is not null then v_reasons := v_reasons || '"duplicate"'::jsonb; end if;
    if not r.is_latest_version then v_reasons := v_reasons || '"superseded"'::jsonb; end if;
    if lower(coalesce(r.qa_status,'')) in ('rejected','failed') then v_reasons := v_reasons || '"qa_rejected"'::jsonb; end if;
    v_status := case
      when v_reasons='[]'::jsonb then 'eligible'
      when v_reasons ?| array['not_current','invalid_deadline','duplicate','superseded','qa_rejected'] then 'rejected'
      else 'enrichment_required'
    end;
    update public.state_contract_opportunities
       set natcorp_release_status=v_status,
           natcorp_release_reasons=v_reasons,
           natcorp_release_evaluated_at=now(),
           natcorp_released_at=case when v_status='eligible' then coalesce(natcorp_released_at,now()) else null end,
           updated_at=now()
     where id=r.id;
    if v_status='eligible' then v_eligible:=v_eligible+1;
    elsif v_status='enrichment_required' then v_enrichment:=v_enrichment+1;
    else v_rejected:=v_rejected+1;
    end if;
  end loop;
  return jsonb_build_object('eligible',v_eligible,'enrichment_required',v_enrichment,'rejected',v_rejected);
end;
$$;
