-- APIOS Command Center Automation Work Package 1
-- Checkpoint 4R runtime hardening discovered during parallel repository audit.
-- Additive corrective migration. Production activation remains separate.

-- ---------------------------------------------------------------------------
-- Evaluator hardening:
--   * safe JSON-shape handling
--   * continuous-open deadline handling
--   * verified issuing-organization evidence
--   * evidence-set fingerprint in immutable evaluation identity
--   * missing-vs-unverifiable contact distinction
--   * immutable evaluation replay without updated_at mutation
--   * concurrent review/rejection/event idempotency
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_contract_candidate(
  p_candidate_opportunity_id uuid,
  p_evaluation_reason text default 'CHECKPOINT_3',
  p_correlation_id uuid default extensions.gen_random_uuid(),
  p_run_id uuid default null,
  p_requested_policy_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_candidate public.state_contract_opportunities%rowtype;
  v_policy public.contract_admission_policy_versions%rowtype;
  v_source_fingerprint text;
  v_document_fingerprint text;
  v_evidence_fingerprint text;
  v_input_fingerprint text;
  v_codes text[] := '{}';
  v_status text;
  v_evaluation_id uuid;
  v_contact_verified boolean := false;
  v_scope_verified boolean := false;
  v_requirements_verified boolean := false;
  v_source_verified boolean := false;
  v_issuer_verified boolean := false;
  v_document_verified boolean := false;
  v_review_required boolean := false;
  v_evidence_manifest jsonb;
  v_idempotent boolean := false;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into v_candidate
  from public.state_contract_opportunities
  where id = p_candidate_opportunity_id
  for share;

  if not found then
    return jsonb_build_object(
      'success',false,
      'status','NOT_FOUND',
      'candidate_opportunity_id',p_candidate_opportunity_id,
      'correlation_id',p_correlation_id
    );
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
    return jsonb_build_object(
      'success',false,
      'status','POLICY_UNAVAILABLE',
      'reason_codes',jsonb_build_array('POLICY_VERSION_INVALID'),
      'candidate_opportunity_id',p_candidate_opportunity_id,
      'correlation_id',p_correlation_id
    );
  end if;

  v_source_fingerprint := coalesce(
    nullif(v_candidate.content_fingerprint,''),
    encode(
      extensions.digest(
        concat_ws('|',v_candidate.id::text,v_candidate.official_source_url,v_candidate.source_url,v_candidate.updated_at::text),
        'sha256'
      ),
      'hex'
    )
  );

  v_document_fingerprint := encode(
    extensions.digest(coalesce(v_candidate.document_urls,'[]'::jsonb)::text,'sha256'),
    'hex'
  );

  select
    exists(
      select 1 from public.contract_evidence_references e
      where e.candidate_opportunity_id=v_candidate.id
        and e.evidence_type='OFFICIAL_SOURCE'
        and e.verification_status='VERIFIED'
        and e.source_fingerprint=v_source_fingerprint
    ),
    exists(
      select 1 from public.contract_evidence_references e
      where e.candidate_opportunity_id=v_candidate.id
        and e.evidence_type='ISSUING_ORGANIZATION'
        and e.verification_status='VERIFIED'
        and e.source_fingerprint=v_source_fingerprint
    ),
    exists(
      select 1 from public.contract_evidence_references e
      where e.candidate_opportunity_id=v_candidate.id
        and e.evidence_type='CONTACT'
        and e.verification_status='VERIFIED'
        and e.source_fingerprint=v_source_fingerprint
    ),
    exists(
      select 1 from public.contract_evidence_references e
      where e.candidate_opportunity_id=v_candidate.id
        and e.evidence_type='SCOPE'
        and e.verification_status='VERIFIED'
        and e.source_fingerprint=v_source_fingerprint
    ),
    exists(
      select 1 from public.contract_evidence_references e
      where e.candidate_opportunity_id=v_candidate.id
        and e.evidence_type='REQUIREMENT'
        and e.verification_status='VERIFIED'
        and e.source_fingerprint=v_source_fingerprint
    ),
    exists(
      select 1 from public.contract_evidence_references e
      where e.candidate_opportunity_id=v_candidate.id
        and e.evidence_type='DOCUMENT_VERSION'
        and e.verification_status='VERIFIED'
        and coalesce(e.document_fingerprint,'')=v_document_fingerprint
    )
  into
    v_source_verified,
    v_issuer_verified,
    v_contact_verified,
    v_scope_verified,
    v_requirements_verified,
    v_document_verified;

  select encode(
    extensions.digest(
      coalesce(
        string_agg(
          concat_ws('|',
            e.evidence_reference_id::text,
            e.evidence_type,
            e.verification_status,
            coalesce(e.source_object_type,''),
            coalesce(e.source_object_id,''),
            coalesce(e.document_id,''),
            coalesce(e.document_version,''),
            coalesce(e.source_fingerprint,''),
            coalesce(e.document_fingerprint,''),
            coalesce(e.verified_at::text,''),
            e.created_at::text
          ),
          '||' order by e.evidence_type,e.evidence_reference_id
        ),
        'NO_EVIDENCE'
      ),
      'sha256'
    ),
    'hex'
  ) into v_evidence_fingerprint
  from public.contract_evidence_references e
  where e.candidate_opportunity_id=v_candidate.id
    and e.evidence_type in (
      'OFFICIAL_SOURCE','ISSUING_ORGANIZATION','CONTACT','SCOPE',
      'REQUIREMENT','DOCUMENT_VERSION','DEADLINE','LIFECYCLE','QA'
    );

  v_input_fingerprint := encode(
    extensions.digest(
      concat_ws('|',
        v_source_fingerprint,
        v_document_fingerprint,
        v_evidence_fingerprint,
        v_candidate.status,
        v_candidate.response_deadline::text,
        v_candidate.contact_name,
        v_candidate.contact_email,
        v_candidate.contact_phone,
        v_candidate.description,
        coalesce(v_candidate.requirements,'{}'::jsonb)::text,
        v_candidate.qa_status,
        v_candidate.is_latest_version::text,
        v_candidate.duplicate_of::text,
        p_evaluation_reason
      ),
      'sha256'
    ),
    'hex'
  );

  if nullif(btrim(coalesce(v_candidate.official_source_url,v_candidate.source_url)),'') is null
     or not v_source_verified then
    v_codes := array_append(v_codes,'UNVERIFIED_OFFICIAL_SOURCE');
  end if;

  if nullif(btrim(v_candidate.issuing_organization),'') is null
     or not v_issuer_verified then
    v_codes := array_append(v_codes,'ISSUING_ORGANIZATION_UNVERIFIED');
  end if;

  if lower(coalesce(v_candidate.status,'')) not in ('open','active','posted','upcoming','open_continuous') then
    v_codes := array_append(v_codes,'CLOSED_OR_EXPIRED');
  end if;

  if lower(coalesce(v_candidate.status,'')) <> 'open_continuous'
     and (v_candidate.response_deadline is null or v_candidate.response_deadline <= now()) then
    v_codes := array_append(v_codes,'INVALID_DEADLINE');
  end if;

  if nullif(btrim(v_candidate.contact_email),'') is null
     and nullif(btrim(v_candidate.contact_phone),'') is null then
    v_codes := array_append(v_codes,'MISSING_CONTRACT_CONTACT');
  elsif not v_contact_verified then
    v_codes := array_append(v_codes,'CONTACT_NOT_VERIFIABLE');
  end if;

  if nullif(btrim(v_candidate.description),'') is null or not v_scope_verified then
    v_codes := array_append(v_codes,'MISSING_SCOPE_OF_WORK');
  end if;

  if not public.apios_jsonb_substantive_requirements(v_candidate.requirements) then
    v_codes := array_append(v_codes,'MISSING_CONTRACT_REQUIREMENTS');
  elsif not v_requirements_verified then
    v_codes := array_append(v_codes,'REQUIREMENTS_NOT_EXTRACTABLE');
  end if;

  if not public.apios_jsonb_nonempty_array(v_candidate.document_urls) then
    v_codes := array_append(v_codes,'INACCESSIBLE_SOLICITATION_PACKAGE');
  elsif not v_document_verified then
    v_review_required := true;
    v_codes := array_append(v_codes,'DOCUMENT_VERSION_UNCERTAIN');
  end if;

  if v_candidate.duplicate_of is not null then
    v_codes := array_append(v_codes,'DUPLICATE_CANDIDATE');
  end if;

  if not coalesce(v_candidate.is_latest_version,false) then
    v_codes := array_append(v_codes,'SUPERSEDED_VERSION');
  end if;

  if lower(coalesce(v_candidate.qa_status,'')) in ('rejected','failed') then
    v_codes := array_append(v_codes,'QA_POLICY_FAILURE');
  end if;

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
    'issuing_organization_verified',v_issuer_verified,
    'contact_verified',v_contact_verified,
    'scope_verified',v_scope_verified,
    'requirements_verified',v_requirements_verified,
    'document_version_verified',v_document_verified,
    'evidence_set_fingerprint',v_evidence_fingerprint,
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
    case when v_issuer_verified then 'VERIFIED' else 'FAILED' end,
    case when lower(coalesce(v_candidate.status,'')) in ('open','active','posted','upcoming','open_continuous') then 'OPEN' else 'FAILED' end,
    case when lower(coalesce(v_candidate.status,''))='open_continuous'
           or (v_candidate.response_deadline is not null and v_candidate.response_deadline>now())
         then 'VALID' else 'FAILED' end,
    case when v_contact_verified then 'VERIFIED' else 'FAILED' end,
    case when v_scope_verified then 'VERIFIED' else 'FAILED' end,
    case when v_requirements_verified then 'VERIFIED' else 'FAILED' end,
    case when v_document_verified then 'VERIFIED' when v_review_required then 'REVIEW_REQUIRED' else 'FAILED' end,
    case when v_candidate.duplicate_of is null then 'PASSED' else 'FAILED' end,
    case when coalesce(v_candidate.is_latest_version,false) then 'PASSED' else 'FAILED' end,
    case when lower(coalesce(v_candidate.qa_status,'')) not in ('rejected','failed') then 'PASSED' else 'FAILED' end,
    case when v_status='ADMITTED' then '{}'::text[] else v_codes end,
    v_evidence_manifest,v_source_fingerprint,v_document_fingerprint,v_input_fingerprint,
    'APIOS_ADMISSION_EVALUATOR',now(),v_status='REVIEW_REQUIRED',p_correlation_id,p_run_id
  )
  on conflict (candidate_opportunity_id,policy_id,source_fingerprint,document_fingerprint,evaluation_input_fingerprint)
  do nothing
  returning evaluation_id into v_evaluation_id;

  if v_evaluation_id is null then
    v_idempotent := true;
    select evaluation_id into v_evaluation_id
    from public.contract_admission_evaluations
    where candidate_opportunity_id=v_candidate.id
      and policy_id=v_policy.policy_id
      and source_fingerprint=v_source_fingerprint
      and document_fingerprint=v_document_fingerprint
      and evaluation_input_fingerprint=v_input_fingerprint;
  end if;

  if v_status='REJECTED' then
    insert into public.contract_rejection_ledger(
      evaluation_id,candidate_opportunity_id,policy_id,rejection_codes,rejection_summary,
      evidence_manifest,rejected_by,rejected_at,correlation_id,run_id
    ) values (
      v_evaluation_id,v_candidate.id,v_policy.policy_id,v_codes,
      'Candidate failed mandatory admission controls.',v_evidence_manifest,
      'APIOS_ADMISSION_EVALUATOR',now(),p_correlation_id,p_run_id
    )
    on conflict (evaluation_id) do nothing;
  elsif v_status='REVIEW_REQUIRED' then
    insert into public.contract_admission_review_queue(
      evaluation_id,candidate_opportunity_id,review_reason_codes,review_priority,review_status,evidence_manifest
    ) values (
      v_evaluation_id,v_candidate.id,v_codes,'HIGH','OPEN',v_evidence_manifest
    )
    on conflict do nothing;
  end if;

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,event_type,new_state,policy_id,actor_type,actor_id,
    reason_codes,evidence_manifest,correlation_id,run_id,request_fingerprint
  ) values (
    v_candidate.id,v_evaluation_id,'EVALUATION_COMPLETED',jsonb_build_object('status',v_status),
    v_policy.policy_id,'SERVICE','APIOS_ADMISSION_EVALUATOR',
    case when v_status='ADMITTED' then '{}'::text[] else v_codes end,
    v_evidence_manifest,p_correlation_id,p_run_id,v_input_fingerprint
  )
  on conflict do nothing;

  return jsonb_build_object(
    'success',true,
    'status',v_status,
    'idempotent',v_idempotent,
    'candidate_opportunity_id',v_candidate.id,
    'evaluation_id',v_evaluation_id,
    'policy_version',v_policy.policy_version,
    'reason_codes',to_jsonb(case when v_status='ADMITTED' then '{}'::text[] else v_codes end),
    'evidence_set_fingerprint',v_evidence_fingerprint,
    'correlation_id',p_correlation_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Promotion hardening and current-admission invalidation.
-- ---------------------------------------------------------------------------
create or replace function public.promote_candidate_to_admitted_contract(
  p_candidate_opportunity_id uuid,
  p_expected_evaluation_id uuid default null,
  p_correlation_id uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_candidate public.state_contract_opportunities%rowtype;
  v_policy public.contract_admission_policy_versions%rowtype;
  v_eval public.contract_admission_evaluations%rowtype;
  v_existing public.admitted_contracts%rowtype;
  v_official uuid;
  v_issuer uuid;
  v_contact uuid;
  v_scope uuid;
  v_document uuid;
  v_requirements jsonb;
  v_admitted_id uuid;
  v_current_source_fingerprint text;
  v_current_document_fingerprint text;
  v_request_fingerprint text;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_candidate_opportunity_id::text,0));

  select * into v_candidate
  from public.state_contract_opportunities
  where id=p_candidate_opportunity_id
  for share;

  if not found then
    return jsonb_build_object('success',false,'status','NOT_FOUND','correlation_id',p_correlation_id);
  end if;

  select * into v_policy
  from public.contract_admission_policy_versions
  where policy_status='ACTIVE'
  limit 1;

  if v_policy.policy_id is null then
    return jsonb_build_object(
      'success',false,'status','POLICY_UNAVAILABLE',
      'reason_codes',jsonb_build_array('POLICY_VERSION_INVALID'),
      'correlation_id',p_correlation_id
    );
  end if;

  select * into v_eval
  from public.contract_admission_evaluations
  where candidate_opportunity_id=v_candidate.id
    and policy_id=v_policy.policy_id
    and evaluation_status='ADMITTED'
    and (p_expected_evaluation_id is null or evaluation_id=p_expected_evaluation_id)
  order by evaluated_at desc
  limit 1;

  if v_eval.evaluation_id is null then
    return jsonb_build_object(
      'success',false,'status','PROMOTION_DENIED',
      'reason_codes',jsonb_build_array('ADMISSION_DECISION_REVERSED'),
      'correlation_id',p_correlation_id
    );
  end if;

  v_current_source_fingerprint := coalesce(
    nullif(v_candidate.content_fingerprint,''),
    encode(
      extensions.digest(
        concat_ws('|',v_candidate.id::text,v_candidate.official_source_url,v_candidate.source_url,v_candidate.updated_at::text),
        'sha256'
      ),
      'hex'
    )
  );

  v_current_document_fingerprint := encode(
    extensions.digest(coalesce(v_candidate.document_urls,'[]'::jsonb)::text,'sha256'),
    'hex'
  );

  if v_eval.source_fingerprint <> v_current_source_fingerprint
     or v_eval.document_fingerprint <> v_current_document_fingerprint then
    return jsonb_build_object(
      'success',false,'status','PROMOTION_DENIED',
      'reason_codes',jsonb_build_array('EVIDENCE_FINGERPRINT_MISMATCH'),
      'correlation_id',p_correlation_id
    );
  end if;

  select evidence_reference_id into v_official
  from public.contract_evidence_references
  where candidate_opportunity_id=v_candidate.id
    and evidence_type='OFFICIAL_SOURCE'
    and verification_status='VERIFIED'
    and source_fingerprint=v_eval.source_fingerprint
  order by verified_at desc nulls last
  limit 1;

  select evidence_reference_id into v_issuer
  from public.contract_evidence_references
  where candidate_opportunity_id=v_candidate.id
    and evidence_type='ISSUING_ORGANIZATION'
    and verification_status='VERIFIED'
    and source_fingerprint=v_eval.source_fingerprint
  order by verified_at desc nulls last
  limit 1;

  select evidence_reference_id into v_contact
  from public.contract_evidence_references
  where candidate_opportunity_id=v_candidate.id
    and evidence_type='CONTACT'
    and verification_status='VERIFIED'
    and source_fingerprint=v_eval.source_fingerprint
  order by verified_at desc nulls last
  limit 1;

  select evidence_reference_id into v_scope
  from public.contract_evidence_references
  where candidate_opportunity_id=v_candidate.id
    and evidence_type='SCOPE'
    and verification_status='VERIFIED'
    and source_fingerprint=v_eval.source_fingerprint
  order by verified_at desc nulls last
  limit 1;

  select evidence_reference_id into v_document
  from public.contract_evidence_references
  where candidate_opportunity_id=v_candidate.id
    and evidence_type='DOCUMENT_VERSION'
    and verification_status='VERIFIED'
    and document_fingerprint=v_eval.document_fingerprint
  order by verified_at desc nulls last
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'evidence_reference_id',evidence_reference_id,
        'document_id',document_id,
        'document_version',document_version
      ) order by evidence_reference_id
    ),
    '[]'::jsonb
  ) into v_requirements
  from public.contract_evidence_references
  where candidate_opportunity_id=v_candidate.id
    and evidence_type='REQUIREMENT'
    and verification_status='VERIFIED'
    and source_fingerprint=v_eval.source_fingerprint;

  if v_official is null
     or v_issuer is null
     or v_contact is null
     or v_scope is null
     or v_document is null
     or not public.apios_jsonb_nonempty_array(v_requirements) then
    return jsonb_build_object(
      'success',false,'status','PROMOTION_DENIED',
      'reason_codes',jsonb_build_array('INSUFFICIENT_PROCUREMENT_INFORMATION'),
      'correlation_id',p_correlation_id
    );
  end if;

  if lower(coalesce(v_candidate.status,'')) not in ('open','active','posted','upcoming','open_continuous')
     or (
       lower(coalesce(v_candidate.status,'')) <> 'open_continuous'
       and (v_candidate.response_deadline is null or v_candidate.response_deadline<=now())
     )
     or v_candidate.duplicate_of is not null
     or not coalesce(v_candidate.is_latest_version,false)
     or lower(coalesce(v_candidate.qa_status,'')) in ('rejected','failed') then
    return jsonb_build_object(
      'success',false,'status','PROMOTION_DENIED',
      'reason_codes',jsonb_build_array('CLOSED_OR_EXPIRED'),
      'correlation_id',p_correlation_id
    );
  end if;

  select * into v_existing
  from public.admitted_contracts
  where candidate_opportunity_id=v_candidate.id
    and document_fingerprint=v_eval.document_fingerprint
    and admission_status='ADMITTED'
  limit 1;

  if v_existing.admitted_contract_id is not null then
    return jsonb_build_object(
      'success',true,'status','ADMITTED','idempotent',true,
      'candidate_opportunity_id',v_candidate.id,
      'evaluation_id',v_eval.evaluation_id,
      'admitted_contract_id',v_existing.admitted_contract_id,
      'policy_version',v_policy.policy_version,
      'correlation_id',p_correlation_id
    );
  end if;

  insert into public.admitted_contracts(
    candidate_opportunity_id,evaluation_id,policy_id,admission_status,admitted_at,admitted_by,
    current_document_version,official_source_evidence_id,contact_evidence_id,scope_evidence_id,
    requirements_evidence_manifest,source_fingerprint,document_fingerprint,lifecycle_status,response_deadline
  ) values (
    v_candidate.id,v_eval.evaluation_id,v_policy.policy_id,'ADMITTED',now(),'APIOS_ADMISSION_PROMOTER',
    v_eval.document_fingerprint,v_official,v_contact,v_scope,v_requirements,
    v_eval.source_fingerprint,v_eval.document_fingerprint,
    case when lower(v_candidate.status)='open_continuous' then 'OPEN_CONTINUOUS' else 'OPEN' end,
    v_candidate.response_deadline
  )
  returning admitted_contract_id into v_admitted_id;

  v_request_fingerprint := encode(
    extensions.digest(
      concat_ws('|','ADMITTED',v_candidate.id::text,v_eval.evaluation_id::text,v_eval.document_fingerprint,v_policy.policy_id::text),
      'sha256'
    ),
    'hex'
  );

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,new_state,policy_id,
    actor_type,actor_id,evidence_manifest,correlation_id,request_fingerprint
  ) values (
    v_candidate.id,v_eval.evaluation_id,v_admitted_id,'ADMITTED',
    jsonb_build_object('admission_status','ADMITTED'),v_policy.policy_id,
    'SERVICE','APIOS_ADMISSION_PROMOTER',v_eval.evidence_manifest,p_correlation_id,v_request_fingerprint
  )
  on conflict do nothing;

  return jsonb_build_object(
    'success',true,'status','ADMITTED','idempotent',false,
    'candidate_opportunity_id',v_candidate.id,
    'evaluation_id',v_eval.evaluation_id,
    'admitted_contract_id',v_admitted_id,
    'policy_version',v_policy.policy_version,
    'correlation_id',p_correlation_id
  );
end;
$$;

create or replace view public.admitted_contracts_current
with (security_invoker=true) as
select
  a.admitted_contract_id,
  a.candidate_opportunity_id,
  a.evaluation_id,
  a.policy_id,
  a.admission_status,
  a.admitted_at,
  a.admitted_by,
  a.current_document_version,
  a.official_source_evidence_id,
  a.contact_evidence_id,
  a.scope_evidence_id,
  a.requirements_evidence_manifest,
  a.source_fingerprint,
  a.document_fingerprint,
  a.lifecycle_status,
  a.response_deadline,
  a.revoked_at,
  a.revoked_by,
  a.revocation_reason_codes,
  a.superseded_by_admitted_contract_id,
  a.created_at,
  a.updated_at,
  o.title,
  o.solicitation_number,
  o.issuing_organization,
  coalesce(o.official_source_url,o.source_url) as official_source_url,
  o.procurement_type,
  o.state_code,
  o.place_of_performance_county as county,
  o.place_of_performance_city as city,
  o.naics_codes,
  o.unspsc_codes,
  o.commodity_codes,
  o.requirements,
  o.natcorp_contract_dna_status
from public.admitted_contracts a
join public.contract_admission_evaluations e on e.evaluation_id=a.evaluation_id
join public.state_contract_opportunities o on o.id=a.candidate_opportunity_id
where a.admission_status='ADMITTED'
  and a.revoked_at is null
  and lower(a.lifecycle_status) in ('open','active','posted','upcoming','open_continuous')
  and (
    lower(a.lifecycle_status)='open_continuous'
    or (a.response_deadline is not null and a.response_deadline>now())
  )
  and e.evaluation_status='ADMITTED'
  and o.duplicate_of is null
  and coalesce(o.is_latest_version,false)
  and lower(coalesce(o.qa_status,'')) not in ('rejected','failed')
  and a.source_fingerprint = coalesce(
    nullif(o.content_fingerprint,''),
    encode(
      extensions.digest(
        concat_ws('|',o.id::text,o.official_source_url,o.source_url,o.updated_at::text),
        'sha256'
      ),
      'hex'
    )
  )
  and a.document_fingerprint = encode(
    extensions.digest(coalesce(o.document_urls,'[]'::jsonb)::text,'sha256'),
    'hex'
  )
  and public.apios_jsonb_nonempty_array(a.requirements_evidence_manifest)
  and exists(
    select 1 from public.contract_evidence_references er
    where er.evidence_reference_id=a.official_source_evidence_id
      and er.verification_status='VERIFIED'
      and er.source_fingerprint=a.source_fingerprint
  )
  and exists(
    select 1 from public.contract_evidence_references er
    where er.evidence_reference_id=a.contact_evidence_id
      and er.verification_status='VERIFIED'
      and er.source_fingerprint=a.source_fingerprint
  )
  and exists(
    select 1 from public.contract_evidence_references er
    where er.evidence_reference_id=a.scope_evidence_id
      and er.verification_status='VERIFIED'
      and er.source_fingerprint=a.source_fingerprint
  )
  and exists(
    select 1 from public.contract_evidence_references er
    where er.candidate_opportunity_id=a.candidate_opportunity_id
      and er.evidence_type='DOCUMENT_VERSION'
      and er.verification_status='VERIFIED'
      and er.document_fingerprint=a.document_fingerprint
  );

create or replace view public.aoie_admitted_contract_candidates_v1
with (security_invoker=true) as
select * from public.admitted_contracts_current;

-- ---------------------------------------------------------------------------
-- Policy activation audit and safe supersession link.
-- ---------------------------------------------------------------------------
create or replace function public.activate_contract_admission_policy(
  p_policy_id uuid,
  p_approval_actor text,
  p_correlation_id uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_policy public.contract_admission_policy_versions%rowtype;
  v_request_fingerprint text;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('APROPOS_CONTRACT_ADMISSION_POLICY',0));

  select * into v_policy
  from public.contract_admission_policy_versions
  where policy_id=p_policy_id
  for update;

  if not found then
    return jsonb_build_object('success',false,'status','NOT_FOUND','correlation_id',p_correlation_id);
  end if;

  if v_policy.policy_status='ACTIVE' then
    return jsonb_build_object(
      'success',true,'status','ACTIVE','idempotent',true,
      'policy_id',p_policy_id,'policy_version',v_policy.policy_version,
      'correlation_id',p_correlation_id
    );
  end if;

  if v_policy.policy_status<>'APPROVED' then
    return jsonb_build_object(
      'success',false,'status','ACTIVATION_DENIED',
      'reason_codes',jsonb_build_array('POLICY_VERSION_INVALID'),
      'correlation_id',p_correlation_id
    );
  end if;

  update public.contract_admission_policy_versions
  set policy_status='SUPERSEDED',
      superseded_at=now(),
      superseded_by_policy_id=p_policy_id,
      updated_at=now()
  where policy_status='ACTIVE';

  update public.contract_admission_policy_versions
  set policy_status='ACTIVE',
      effective_at=coalesce(effective_at,now()),
      activated_at=now(),
      activated_by=p_approval_actor,
      updated_at=now()
  where policy_id=p_policy_id;

  v_request_fingerprint := encode(
    extensions.digest(concat_ws('|','POLICY_ACTIVATED',p_policy_id::text,v_policy.policy_fingerprint),'sha256'),
    'hex'
  );

  insert into public.contract_admission_events(
    event_type,new_state,policy_id,actor_type,actor_id,correlation_id,request_fingerprint
  ) values (
    'POLICY_ACTIVATED',jsonb_build_object('policy_status','ACTIVE','policy_version',v_policy.policy_version),
    p_policy_id,'SERVICE',p_approval_actor,p_correlation_id,v_request_fingerprint
  )
  on conflict do nothing;

  return jsonb_build_object(
    'success',true,'status','ACTIVE','idempotent',false,
    'policy_id',p_policy_id,'policy_version',v_policy.policy_version,
    'correlation_id',p_correlation_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Revocation idempotency and deterministic event identity.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_admitted_contract(
  p_admitted_contract_id uuid,
  p_reason_codes text[],
  p_actor_id text default 'APIOS_ADMISSION_REVOKER',
  p_correlation_id uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admission public.admitted_contracts%rowtype;
  v_request_fingerprint text;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  if cardinality(coalesce(p_reason_codes,'{}'::text[]))=0 then
    raise exception 'at least one revocation reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_admitted_contract_id::text,0));

  select * into v_admission
  from public.admitted_contracts
  where admitted_contract_id=p_admitted_contract_id
  for update;

  if not found then
    return jsonb_build_object('success',false,'status','NOT_FOUND','correlation_id',p_correlation_id);
  end if;

  if v_admission.admission_status='REVOKED' then
    return jsonb_build_object(
      'success',true,'status','REVOKED','idempotent',true,
      'admitted_contract_id',p_admitted_contract_id,
      'correlation_id',p_correlation_id
    );
  end if;

  update public.admitted_contracts
  set admission_status='REVOKED',
      revoked_at=now(),
      revoked_by=p_actor_id,
      revocation_reason_codes=p_reason_codes,
      updated_at=now()
  where admitted_contract_id=p_admitted_contract_id;

  update public.apios_natcorp_delivery_feed_v2
  set delivery_status='REVOKED',
      removal_reason_codes=p_reason_codes,
      updated_at=now()
  where admitted_contract_id=p_admitted_contract_id
    and delivery_status in ('READY','RELEASED','HELD');

  v_request_fingerprint := encode(
    extensions.digest(
      concat_ws('|','ADMISSION_REVOKED',p_admitted_contract_id::text,array_to_string(p_reason_codes,',')),
      'sha256'
    ),
    'hex'
  );

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,prior_state,new_state,
    policy_id,actor_type,actor_id,reason_codes,correlation_id,request_fingerprint
  ) values (
    v_admission.candidate_opportunity_id,v_admission.evaluation_id,p_admitted_contract_id,
    'ADMISSION_REVOKED',jsonb_build_object('admission_status',v_admission.admission_status),
    jsonb_build_object('admission_status','REVOKED'),v_admission.policy_id,
    'SERVICE',p_actor_id,p_reason_codes,p_correlation_id,v_request_fingerprint
  )
  on conflict do nothing;

  return jsonb_build_object(
    'success',true,'status','REVOKED','idempotent',false,
    'admitted_contract_id',p_admitted_contract_id,
    'correlation_id',p_correlation_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Delivery uniqueness when optional identifiers are NULL, plus event-safe
-- publication and removal.
-- ---------------------------------------------------------------------------
drop index if exists public.apios_natcorp_delivery_feed_v_admitted_contract_id_business_key;

create unique index if not exists apios_natcorp_delivery_v2_identity_unique_idx
  on public.apios_natcorp_delivery_feed_v2(
    admitted_contract_id,
    coalesce(business_profile_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(match_id,'00000000-0000-0000-0000-000000000000'::uuid),
    delivery_fingerprint
  );

create or replace function public.publish_admitted_contract_to_natcorp(
  p_admitted_contract_id uuid,
  p_business_profile_id uuid default null,
  p_match_id uuid default null,
  p_match_explanation jsonb default '{}'::jsonb,
  p_run_id uuid default null,
  p_correlation_id uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_contract record;
  v_fingerprint text;
  v_delivery_id uuid;
  v_existing_status text;
  v_idempotent boolean := false;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  select * into v_contract
  from public.admitted_contracts_current
  where admitted_contract_id=p_admitted_contract_id;

  if not found then
    return jsonb_build_object(
      'success',false,'status','NOT_ADMITTED',
      'admitted_contract_id',p_admitted_contract_id,
      'correlation_id',p_correlation_id
    );
  end if;

  v_fingerprint := encode(
    extensions.digest(
      concat_ws('|',
        v_contract.admitted_contract_id::text,
        coalesce(p_business_profile_id::text,''),
        coalesce(p_match_id::text,''),
        v_contract.document_fingerprint,
        v_contract.policy_id::text,
        coalesce(p_match_explanation,'{}'::jsonb)::text
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended(v_fingerprint,0));

  select delivery_feed_id,delivery_status
  into v_delivery_id,v_existing_status
  from public.apios_natcorp_delivery_feed_v2
  where admitted_contract_id=v_contract.admitted_contract_id
    and business_profile_id is not distinct from p_business_profile_id
    and match_id is not distinct from p_match_id
    and delivery_fingerprint=v_fingerprint
  limit 1
  for update;

  if v_delivery_id is null then
    insert into public.apios_natcorp_delivery_feed_v2(
      admitted_contract_id,candidate_opportunity_id,evaluation_id,policy_id,
      business_profile_id,match_id,delivery_status,release_timestamp,
      expiration_timestamp,match_explanation,delivery_fingerprint,correlation_id,run_id
    ) values (
      v_contract.admitted_contract_id,v_contract.candidate_opportunity_id,
      v_contract.evaluation_id,v_contract.policy_id,p_business_profile_id,p_match_id,
      'RELEASED',now(),v_contract.response_deadline,
      coalesce(p_match_explanation,'{}'::jsonb),v_fingerprint,p_correlation_id,p_run_id
    )
    returning delivery_feed_id into v_delivery_id;
  else
    v_idempotent := v_existing_status='RELEASED';
    update public.apios_natcorp_delivery_feed_v2
    set delivery_status='RELEASED',
        release_timestamp=coalesce(release_timestamp,now()),
        expiration_timestamp=v_contract.response_deadline,
        match_explanation=coalesce(p_match_explanation,'{}'::jsonb),
        updated_at=now()
    where delivery_feed_id=v_delivery_id;
  end if;

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,new_state,policy_id,
    actor_type,actor_id,evidence_manifest,correlation_id,run_id,request_fingerprint
  ) values (
    v_contract.candidate_opportunity_id,v_contract.evaluation_id,v_contract.admitted_contract_id,
    'DELIVERY_PUBLISHED',jsonb_build_object('delivery_status','RELEASED','delivery_feed_id',v_delivery_id),
    v_contract.policy_id,'SERVICE','APIOS_DELIVERY_RECONCILER',
    jsonb_build_object('match_id',p_match_id,'business_profile_id',p_business_profile_id),
    p_correlation_id,p_run_id,v_fingerprint
  )
  on conflict do nothing;

  return jsonb_build_object(
    'success',true,'status','RELEASED','idempotent',v_idempotent,
    'delivery_feed_id',v_delivery_id,
    'admitted_contract_id',p_admitted_contract_id,
    'correlation_id',p_correlation_id
  );
end;
$$;

create or replace function public.remove_contract_from_natcorp_delivery(
  p_admitted_contract_id uuid,
  p_reason_codes text[],
  p_run_id uuid default null,
  p_correlation_id uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_updated integer := 0;
  v_admission public.admitted_contracts%rowtype;
  v_target_status text;
  v_request_fingerprint text;
begin
  if not public.apios_admission_caller_authorized() then
    raise exception 'service role required' using errcode='42501';
  end if;

  if cardinality(coalesce(p_reason_codes,'{}'::text[]))=0 then
    raise exception 'at least one removal reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_admitted_contract_id::text,0));

  select * into v_admission
  from public.admitted_contracts
  where admitted_contract_id=p_admitted_contract_id;

  if not found then
    return jsonb_build_object(
      'success',false,'status','NOT_FOUND',
      'admitted_contract_id',p_admitted_contract_id,
      'correlation_id',p_correlation_id
    );
  end if;

  v_target_status := case
    when v_admission.admission_status='REVOKED' then 'REVOKED'
    when v_admission.admission_status='SUPERSEDED' then 'SUPERSEDED'
    when v_admission.admission_status in ('EXPIRED','CLOSED','CANCELLED','WITHDRAWN') then 'EXPIRED'
    else 'REMOVED'
  end;

  update public.apios_natcorp_delivery_feed_v2
  set delivery_status=v_target_status,
      removal_reason_codes=p_reason_codes,
      updated_at=now()
  where admitted_contract_id=p_admitted_contract_id
    and delivery_status in ('READY','RELEASED','HELD');

  get diagnostics v_updated=row_count;

  if v_updated=0 then
    return jsonb_build_object(
      'success',true,'status',v_target_status,'idempotent',true,'updated',0,
      'admitted_contract_id',p_admitted_contract_id,
      'correlation_id',p_correlation_id
    );
  end if;

  v_request_fingerprint := encode(
    extensions.digest(
      concat_ws('|','DELIVERY_REMOVED',p_admitted_contract_id::text,v_target_status,array_to_string(p_reason_codes,',')),
      'sha256'
    ),
    'hex'
  );

  insert into public.contract_admission_events(
    candidate_opportunity_id,evaluation_id,admitted_contract_id,event_type,prior_state,new_state,
    policy_id,actor_type,actor_id,reason_codes,correlation_id,run_id,request_fingerprint
  ) values (
    v_admission.candidate_opportunity_id,v_admission.evaluation_id,p_admitted_contract_id,
    'DELIVERY_REMOVED',jsonb_build_object('active_delivery_records',v_updated),
    jsonb_build_object('delivery_status',v_target_status),v_admission.policy_id,
    'SERVICE','APIOS_DELIVERY_RECONCILER',p_reason_codes,p_correlation_id,p_run_id,v_request_fingerprint
  )
  on conflict do nothing;

  return jsonb_build_object(
    'success',true,'status',v_target_status,'idempotent',false,'updated',v_updated,
    'admitted_contract_id',p_admitted_contract_id,
    'correlation_id',p_correlation_id
  );
end;
$$;

-- Reassert the privileged execution boundary after replacement.
revoke all on function public.evaluate_contract_candidate(uuid,text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.promote_candidate_to_admitted_contract(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.revoke_admitted_contract(uuid,text[],text,uuid) from public, anon, authenticated;
revoke all on function public.activate_contract_admission_policy(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.publish_admitted_contract_to_natcorp(uuid,uuid,uuid,jsonb,uuid,uuid) from public, anon, authenticated;
revoke all on function public.remove_contract_from_natcorp_delivery(uuid,text[],uuid,uuid) from public, anon, authenticated;

grant execute on function public.evaluate_contract_candidate(uuid,text,uuid,uuid,text) to service_role;
grant execute on function public.promote_candidate_to_admitted_contract(uuid,uuid,uuid) to service_role;
grant execute on function public.revoke_admitted_contract(uuid,text[],text,uuid) to service_role;
grant execute on function public.activate_contract_admission_policy(uuid,text,uuid) to service_role;
grant execute on function public.publish_admitted_contract_to_natcorp(uuid,uuid,uuid,jsonb,uuid,uuid) to service_role;
grant execute on function public.remove_contract_from_natcorp_delivery(uuid,text[],uuid,uuid) to service_role;
