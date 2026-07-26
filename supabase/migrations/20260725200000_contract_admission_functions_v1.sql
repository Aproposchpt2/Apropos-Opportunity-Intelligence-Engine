-- APIOS Command Center Automation Work Package 1
-- Privileged contract-admission function layer. Additive only; production activation is separate.

create or replace function public.apios_admission_caller_authorized()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
      or session_user in ('postgres', 'service_role');
$$;

revoke all on function public.apios_admission_caller_authorized() from public, anon, authenticated;
grant execute on function public.apios_admission_caller_authorized() to service_role;

create or replace function public.evaluate_contract_candidate(
  p_candidate_opportunity_id uuid,
  p_evaluation_reason text default 'CHECKPOINT_3',
  p_correlation_id uuid default gen_random_uuid(),
  p_run_id uuid default null,
  p_requested_policy_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.state_contract_opportunities%rowtype;
  v_policy public.contract_admission_policy_versions%rowtype;
  v_source_fingerprint text;
  v_document_fingerprint text;
  v_input_fingerprint text;
  v_codes text[] := '{}';
  v_status text;
  v_evaluation_id uuid;
  v_contact_verified boolean;
  v_scope_verified boolean;
  v_requirements_verified boolean;
  v_source_verified boolean;
  v_document_verified boolean;
  v_review_required boolean := false;
  v_evidence_manifest jsonb;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into v_candidate
  from public.state_contract_opportunities
  where id = p_candidate_opportunity_id
  for share;

  if not found then
    return jsonb_build_object('success', false, 'status', 'NOT_FOUND', 'candidate_opportunity_id', p_candidate_opportunity_id, 'correlation_id', p_correlation_id);
  end if;

  if p_requested_policy_version is null then
    select * into v_policy
    from public.contract_admission_policy_versions
    where policy_status = 'ACTIVE'
    order by activated_at desc nulls last
    limit 1;
  else
    select * into v_policy
    from public.contract_admission_policy_versions
    where policy_version = p_requested_policy_version
      and policy_status in ('APPROVED','ACTIVE')
    limit 1;
  end if;

  if v_policy.policy_id is null then
    return jsonb_build_object('success', false, 'status', 'POLICY_UNAVAILABLE', 'reason_codes', jsonb_build_array('POLICY_VERSION_INVALID'), 'candidate_opportunity_id', p_candidate_opportunity_id, 'correlation_id', p_correlation_id);
  end if;

  v_source_fingerprint := coalesce(nullif(v_candidate.content_fingerprint,''), encode(digest(concat_ws('|',v_candidate.id::text,v_candidate.official_source_url,v_candidate.source_url,v_candidate.updated_at::text),'sha256'),'hex'));
  v_document_fingerprint := encode(digest(coalesce(v_candidate.document_urls,'[]'::jsonb)::text,'sha256'),'hex');
  v_input_fingerprint := encode(digest(concat_ws('|',v_source_fingerprint,v_document_fingerprint,v_candidate.status,v_candidate.response_deadline::text,v_candidate.contact_name,v_candidate.contact_email,v_candidate.contact_phone,v_candidate.description,coalesce(v_candidate.requirements,'{}'::jsonb)::text,v_candidate.qa_status,v_candidate.is_latest_version::text,v_candidate.duplicate_of::text,p_evaluation_reason),'sha256'),'hex');

  select exists(select 1 from public.contract_evidence_references e where e.candidate_opportunity_id=v_candidate.id and e.evidence_type='OFFICIAL_SOURCE' and e.verification_status='VERIFIED' and e.source_fingerprint=v_source_fingerprint),
         exists(select 1 from public.contract_evidence_references e where e.candidate_opportunity_id=v_candidate.id and e.evidence_type='CONTACT' and e.verification_status='VERIFIED' and e.source_fingerprint=v_source_fingerprint),
         exists(select 1 from public.contract_evidence_references e where e.candidate_opportunity_id=v_candidate.id and e.evidence_type='SCOPE' and e.verification_status='VERIFIED' and e.source_fingerprint=v_source_fingerprint),
         exists(select 1 from public.contract_evidence_references e where e.candidate_opportunity_id=v_candidate.id and e.evidence_type='REQUIREMENT' and e.verification_status='VERIFIED' and e.source_fingerprint=v_source_fingerprint),
         exists(select 1 from public.contract_evidence_references e where e.candidate_opportunity_id=v_candidate.id and e.evidence_type='DOCUMENT_VERSION' and e.verification_status='VERIFIED' and coalesce(e.document_fingerprint,'')=v_document_fingerprint)
    into v_source_verified,v_contact_verified,v_scope_verified,v_requirements_verified,v_document_verified;

  if nullif(coalesce(v_candidate.official_source_url,v_candidate.source_url),'') is null or not v_source_verified then v_codes := array_append(v_codes,'UNVERIFIED_OFFICIAL_SOURCE'); end if;
  if nullif(v_candidate.issuing_organization,'') is null then v_codes := array_append(v_codes,'ISSUING_ORGANIZATION_UNVERIFIED'); end if;
  if lower(coalesce(v_candidate.status,'')) not in ('open','active','posted','upcoming','open_continuous') then v_codes := array_append(v_codes,'CLOSED_OR_EXPIRED'); end if;
  if v_candidate.response_deadline is null or (lower(coalesce(v_candidate.status,'')) <> 'open_continuous' and v_candidate.response_deadline <= now()) then v_codes := array_append(v_codes,'INVALID_DEADLINE'); end if;
  if (nullif(v_candidate.contact_email,'') is null and nullif(v_candidate.contact_phone,'') is null) or not v_contact_verified then v_codes := array_append(v_codes,'MISSING_CONTRACT_CONTACT'); end if;
  if nullif(v_candidate.description,'') is null or not v_scope_verified then v_codes := array_append(v_codes,'MISSING_SCOPE_OF_WORK'); end if;
  if coalesce(v_candidate.requirements,'{}'::jsonb)='{}'::jsonb or not v_requirements_verified then v_codes := array_append(v_codes,'MISSING_CONTRACT_REQUIREMENTS'); end if;
  if jsonb_array_length(coalesce(v_candidate.document_urls,'[]'::jsonb))=0 then v_codes := array_append(v_codes,'INACCESSIBLE_SOLICITATION_PACKAGE');
  elsif not v_document_verified then v_review_required := true; v_codes := array_append(v_codes,'DOCUMENT_VERSION_UNCERTAIN'); end if;
  if v_candidate.duplicate_of is not null then v_codes := array_append(v_codes,'DUPLICATE_CANDIDATE'); end if;
  if not coalesce(v_candidate.is_latest_version,false) then v_codes := array_append(v_codes,'SUPERSEDED_VERSION'); end if;
  if lower(coalesce(v_candidate.qa_status,'')) in ('rejected','failed') then v_codes := array_append(v_codes,'QA_POLICY_FAILURE'); end if;

  v_codes := array(select distinct x from unnest(v_codes) x order by x);

  if cardinality(v_codes)=0 then
    v_status := 'ADMITTED';
  elsif v_review_required and v_codes <@ array['DOCUMENT_VERSION_UNCERTAIN']::text[] then
    v_status := 'REVIEW_REQUIRED';
  else
    v_status := 'REJECTED';
  end if;

  v_evidence_manifest := jsonb_build_object(
    'official_source_verified',v_source_verified,
    'contact_verified',v_contact_verified,
    'scope_verified',v_scope_verified,
    'requirements_verified',v_requirements_verified,
    'document_version_verified',v_document_verified,
    'evaluation_reason',p_evaluation_reason
  );

  insert into public.contract_admission_evaluations(
    candidate_opportunity_id,policy_id,evaluation_status,official_source_status,issuer_status,lifecycle_status,deadline_status,
    contact_status,scope_status,requirements_status,document_status,duplicate_status,supersession_status,qa_status,
    rejection_codes,evidence_manifest,source_fingerprint,document_fingerprint,evaluation_input_fingerprint,evaluated_by,evaluated_at,
    review_required,correlation_id,run_id
  ) values (
    v_candidate.id,v_policy.policy_id,v_status,
    case when v_source_verified then 'VERIFIED' else 'FAILED' end,
    case when nullif(v_candidate.issuing_organization,'') is not null then 'VERIFIED' else 'FAILED' end,
    case when lower(coalesce(v_candidate.status,'')) in ('open','active','posted','upcoming','open_continuous') then 'OPEN' else 'FAILED' end,
    case when v_candidate.response_deadline is not null and (lower(coalesce(v_candidate.status,''))='open_continuous' or v_candidate.response_deadline>now()) then 'VALID' else 'FAILED' end,
    case when v_contact_verified then 'VERIFIED' else 'FAILED' end,
    case when v_scope_verified then 'VERIFIED' else 'FAILED' end,
    case when v_requirements_verified then 'VERIFIED' else 'FAILED' end,
    case when v_document_verified then 'VERIFIED' when v_review_required then 'REVIEW_REQUIRED' else 'FAILED' end,
    case when v_candidate.duplicate_of is null then 'PASSED' else 'FAILED' end,
    case when coalesce(v_candidate.is_latest_version,false) then 'PASSED' else 'FAILED' end,
    case when lower(coalesce(v_candidate.qa_status,'')) not in ('rejected','failed') then 'PASSED' else 'FAILED' end,
    case when v_status='ADMITTED' then '{}'::text[] else v_codes end,
    v_evidence_manifest,v_source_fingerprint,v_document_fingerprint,v_input_fingerprint,'APIOS_ADMISSION_EVALUATOR',now(),
    v_status='REVIEW_REQUIRED',p_correlation_id,p_run_id
  )
  on conflict (candidate_opportunity_id,policy_id,source_fingerprint,document_fingerprint,evaluation_input_fingerprint)
  do update set updated_at=now()
  returning evaluation_id into v_evaluation_id;

  if v_status='REJECTED' then
    insert into public.contract_rejection_ledger(evaluation_id,candidate_opportunity_id,policy_id,rejection_codes,rejection_summary,evidence_manifest,rejected_by,rejected_at,correlation_id,run_id)
    values(v_evaluation_id,v_candidate.id,v_policy.policy_id,v_codes,'Candidate failed mandatory admission controls.',v_evidence_manifest,'APIOS_ADMISSION_EVALUATOR',now(),p_correlation_id,p_run_id)
    on conflict do nothing;
  elsif v_status='REVIEW_REQUIRED' then
    insert into public.contract_admission_review_queue(evaluation_id,candidate_opportunity_id,review_reason_codes,review_priority,review_status,evidence_manifest)
    select v_evaluation_id,v_candidate.id,v_codes,'HIGH','OPEN',v_evidence_manifest
    where not exists(select 1 from public.contract_admission_review_queue q where q.evaluation_id=v_evaluation_id and q.review_status in ('OPEN','ASSIGNED','IN_REVIEW'));
  end if;

  insert into public.contract_admission_events(candidate_opportunity_id,evaluation_id,event_type,new_state,policy_id,actor_type,actor_id,reason_codes,evidence_manifest,correlation_id,run_id,request_fingerprint)
  values(v_candidate.id,v_evaluation_id,'EVALUATION_COMPLETED',jsonb_build_object('status',v_status),v_policy.policy_id,'SERVICE','APIOS_ADMISSION_EVALUATOR',case when v_status='ADMITTED' then '{}'::text[] else v_codes end,v_evidence_manifest,p_correlation_id,p_run_id,v_input_fingerprint);

  return jsonb_build_object('success',true,'status',v_status,'candidate_opportunity_id',v_candidate.id,'evaluation_id',v_evaluation_id,'policy_version',v_policy.policy_version,'reason_codes',to_jsonb(case when v_status='ADMITTED' then '{}'::text[] else v_codes end),'correlation_id',p_correlation_id);
end;
$$;

create or replace function public.promote_candidate_to_admitted_contract(
  p_candidate_opportunity_id uuid,
  p_expected_evaluation_id uuid default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.state_contract_opportunities%rowtype;
  v_policy public.contract_admission_policy_versions%rowtype;
  v_eval public.contract_admission_evaluations%rowtype;
  v_existing public.admitted_contracts%rowtype;
  v_official uuid; v_contact uuid; v_scope uuid;
  v_requirements jsonb;
  v_admitted_id uuid;
begin
  if not public.apios_admission_caller_authorized() then raise exception 'service role required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_opportunity_id::text,0));

  select * into v_candidate from public.state_contract_opportunities where id=p_candidate_opportunity_id for share;
  if not found then return jsonb_build_object('success',false,'status','NOT_FOUND','correlation_id',p_correlation_id); end if;
  select * into v_policy from public.contract_admission_policy_versions where policy_status='ACTIVE' limit 1;
  if v_policy.policy_id is null then return jsonb_build_object('success',false,'status','POLICY_UNAVAILABLE','reason_codes',jsonb_build_array('POLICY_VERSION_INVALID'),'correlation_id',p_correlation_id); end if;

  select * into v_eval
  from public.contract_admission_evaluations
  where candidate_opportunity_id=v_candidate.id
    and policy_id=v_policy.policy_id
    and evaluation_status='ADMITTED'
    and (p_expected_evaluation_id is null or evaluation_id=p_expected_evaluation_id)
  order by evaluated_at desc limit 1;

  if v_eval.evaluation_id is null then
    insert into public.contract_admission_events(candidate_opportunity_id,event_type,policy_id,actor_type,actor_id,reason_codes,correlation_id)
    values(v_candidate.id,'PROMOTION_DENIED',v_policy.policy_id,'SERVICE','APIOS_ADMISSION_PROMOTER',array['ADMISSION_DECISION_REVERSED'],p_correlation_id);
    return jsonb_build_object('success',false,'status','PROMOTION_DENIED','reason_codes',jsonb_build_array('ADMISSION_DECISION_REVERSED'),'correlation_id',p_correlation_id);
  end if;

  if v_eval.source_fingerprint <> coalesce(nullif(v_candidate.content_fingerprint,''),encode(digest(concat_ws('|',v_candidate.id::text,v_candidate.official_source_url,v_candidate.source_url,v_candidate.updated_at::text),'sha256'),'hex'))
     or v_eval.document_fingerprint <> encode(digest(coalesce(v_candidate.document_urls,'[]'::jsonb)::text,'sha256'),'hex') then
    return jsonb_build_object('success',false,'status','PROMOTION_DENIED','reason_codes',jsonb_build_array('EVIDENCE_FINGERPRINT_MISMATCH'),'correlation_id',p_correlation_id);
  end if;

  select evidence_reference_id into v_official from public.contract_evidence_references where candidate_opportunity_id=v_candidate.id and evidence_type='OFFICIAL_SOURCE' and verification_status='VERIFIED' and source_fingerprint=v_eval.source_fingerprint order by verified_at desc nulls last limit 1;
  select evidence_reference_id into v_contact from public.contract_evidence_references where candidate_opportunity_id=v_candidate.id and evidence_type='CONTACT' and verification_status='VERIFIED' and source_fingerprint=v_eval.source_fingerprint order by verified_at desc nulls last limit 1;
  select evidence_reference_id into v_scope from public.contract_evidence_references where candidate_opportunity_id=v_candidate.id and evidence_type='SCOPE' and verification_status='VERIFIED' and source_fingerprint=v_eval.source_fingerprint order by verified_at desc nulls last limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('evidence_reference_id',evidence_reference_id,'document_id',document_id,'document_version',document_version)), '[]'::jsonb) into v_requirements from public.contract_evidence_references where candidate_opportunity_id=v_candidate.id and evidence_type='REQUIREMENT' and verification_status='VERIFIED' and source_fingerprint=v_eval.source_fingerprint;

  if v_official is null or v_contact is null or v_scope is null or jsonb_array_length(v_requirements)=0 then
    return jsonb_build_object('success',false,'status','PROMOTION_DENIED','reason_codes',jsonb_build_array('INSUFFICIENT_PROCUREMENT_INFORMATION'),'correlation_id',p_correlation_id);
  end if;
  if lower(coalesce(v_candidate.status,'')) not in ('open','active','posted','upcoming','open_continuous') or (lower(coalesce(v_candidate.status,''))<>'open_continuous' and (v_candidate.response_deadline is null or v_candidate.response_deadline<=now())) then
    return jsonb_build_object('success',false,'status','PROMOTION_DENIED','reason_codes',jsonb_build_array('CLOSED_OR_EXPIRED'),'correlation_id',p_correlation_id);
  end if;

  select * into v_existing from public.admitted_contracts where candidate_opportunity_id=v_candidate.id and document_fingerprint=v_eval.document_fingerprint and admission_status='ADMITTED' limit 1;
  if v_existing.admitted_contract_id is not null then
    return jsonb_build_object('success',true,'status','ADMITTED','idempotent',true,'candidate_opportunity_id',v_candidate.id,'evaluation_id',v_eval.evaluation_id,'admitted_contract_id',v_existing.admitted_contract_id,'policy_version',v_policy.policy_version,'correlation_id',p_correlation_id);
  end if;

  insert into public.admitted_contracts(candidate_opportunity_id,evaluation_id,policy_id,admission_status,admitted_at,admitted_by,current_document_version,official_source_evidence_id,contact_evidence_id,scope_evidence_id,requirements_evidence_manifest,source_fingerprint,document_fingerprint,lifecycle_status,response_deadline)
  values(v_candidate.id,v_eval.evaluation_id,v_policy.policy_id,'ADMITTED',now(),'APIOS_ADMISSION_PROMOTER',v_eval.document_fingerprint,v_official,v_contact,v_scope,v_requirements,v_eval.source_fingerprint,v_eval.document_fingerprint,'OPEN',v_candidate.response_deadline)
  returning admitted_contract_id into v_admitted_id;

  insert into public.contract_admission_events(candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,new_state,policy_id,actor_type,actor_id,evidence_manifest,correlation_id)
  values(v_candidate.id,v_eval.evaluation_id,v_admitted_id,'ADMITTED',jsonb_build_object('admission_status','ADMITTED'),v_policy.policy_id,'SERVICE','APIOS_ADMISSION_PROMOTER',v_eval.evidence_manifest,p_correlation_id);

  return jsonb_build_object('success',true,'status','ADMITTED','idempotent',false,'candidate_opportunity_id',v_candidate.id,'evaluation_id',v_eval.evaluation_id,'admitted_contract_id',v_admitted_id,'policy_version',v_policy.policy_version,'correlation_id',p_correlation_id);
end;
$$;

create or replace function public.revoke_admitted_contract(
  p_admitted_contract_id uuid,
  p_reason_codes text[],
  p_actor_id text default 'APIOS_ADMISSION_REVOKER',
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_admission public.admitted_contracts%rowtype;
begin
  if not public.apios_admission_caller_authorized() then raise exception 'service role required' using errcode='42501'; end if;
  if cardinality(coalesce(p_reason_codes,'{}'::text[]))=0 then raise exception 'at least one revocation reason is required'; end if;
  select * into v_admission from public.admitted_contracts where admitted_contract_id=p_admitted_contract_id for update;
  if not found then return jsonb_build_object('success',false,'status','NOT_FOUND','correlation_id',p_correlation_id); end if;
  if v_admission.admission_status='REVOKED' then return jsonb_build_object('success',true,'status','REVOKED','idempotent',true,'admitted_contract_id',p_admitted_contract_id,'correlation_id',p_correlation_id); end if;
  update public.admitted_contracts set admission_status='REVOKED',revoked_at=now(),revoked_by=p_actor_id,revocation_reason_codes=p_reason_codes,updated_at=now() where admitted_contract_id=p_admitted_contract_id;
  insert into public.contract_admission_events(candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,prior_state,new_state,policy_id,actor_type,actor_id,reason_codes,correlation_id)
  values(v_admission.candidate_opportunity_id,v_admission.evaluation_id,p_admitted_contract_id,'ADMISSION_REVOKED',jsonb_build_object('admission_status',v_admission.admission_status),jsonb_build_object('admission_status','REVOKED'),v_admission.policy_id,'SERVICE',p_actor_id,p_reason_codes,p_correlation_id);
  return jsonb_build_object('success',true,'status','REVOKED','idempotent',false,'admitted_contract_id',p_admitted_contract_id,'correlation_id',p_correlation_id);
end;
$$;

create or replace function public.activate_contract_admission_policy(
  p_policy_id uuid,
  p_approval_actor text,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_policy public.contract_admission_policy_versions%rowtype;
begin
  if not public.apios_admission_caller_authorized() then raise exception 'service role required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('APROPOS_CONTRACT_ADMISSION_POLICY',0));
  select * into v_policy from public.contract_admission_policy_versions where policy_id=p_policy_id for update;
  if not found then return jsonb_build_object('success',false,'status','NOT_FOUND','correlation_id',p_correlation_id); end if;
  if v_policy.policy_status='ACTIVE' then return jsonb_build_object('success',true,'status','ACTIVE','idempotent',true,'policy_id',p_policy_id,'policy_version',v_policy.policy_version,'correlation_id',p_correlation_id); end if;
  if v_policy.policy_status<>'APPROVED' then return jsonb_build_object('success',false,'status','ACTIVATION_DENIED','reason_codes',jsonb_build_array('POLICY_VERSION_INVALID'),'correlation_id',p_correlation_id); end if;
  update public.contract_admission_policy_versions set policy_status='SUPERSEDED',superseded_at=now(),updated_at=now() where policy_status='ACTIVE';
  update public.contract_admission_policy_versions set policy_status='ACTIVE',effective_at=coalesce(effective_at,now()),activated_at=now(),activated_by=p_approval_actor,updated_at=now() where policy_id=p_policy_id;
  return jsonb_build_object('success',true,'status','ACTIVE','idempotent',false,'policy_id',p_policy_id,'policy_version',v_policy.policy_version,'correlation_id',p_correlation_id);
end;
$$;

create or replace function public.is_contract_currently_admitted(p_admitted_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists(select 1 from public.admitted_contracts_current where admitted_contract_id=p_admitted_contract_id);
$$;

create or replace function public.get_current_admitted_contract(p_admitted_contract_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(x) from public.admitted_contracts_current x where x.admitted_contract_id=p_admitted_contract_id;
$$;

revoke all on function public.evaluate_contract_candidate(uuid,text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.promote_candidate_to_admitted_contract(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.revoke_admitted_contract(uuid,text[],text,uuid) from public, anon, authenticated;
revoke all on function public.activate_contract_admission_policy(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.is_contract_currently_admitted(uuid) from public, anon, authenticated;
revoke all on function public.get_current_admitted_contract(uuid) from public, anon, authenticated;

grant execute on function public.evaluate_contract_candidate(uuid,text,uuid,uuid,text) to service_role;
grant execute on function public.promote_candidate_to_admitted_contract(uuid,uuid,uuid) to service_role;
grant execute on function public.revoke_admitted_contract(uuid,text[],text,uuid) to service_role;
grant execute on function public.activate_contract_admission_policy(uuid,text,uuid) to service_role;
grant execute on function public.is_contract_currently_admitted(uuid) to service_role;
grant execute on function public.get_current_admitted_contract(uuid) to service_role;
