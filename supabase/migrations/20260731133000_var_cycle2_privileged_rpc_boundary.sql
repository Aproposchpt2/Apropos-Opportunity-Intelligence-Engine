-- APIOS VAR Cycle 2 remediation
-- Closes VAR-DEF-001 and VAR-DEF-003 by making privileged SECURITY DEFINER
-- operations service-role-only. Browser/operator actions must traverse authenticated
-- server-side control functions; anon/authenticated roles may not invoke these RPCs.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and p.proname = any(array[
        'aadp_qualify_raw_record',
        'aadp_reconcile_run',
        'aadp_validate_semantic_completion',
        'apios_apply_release_decisions',
        'apios_get_document_status',
        'apios_publish_releases',
        'apios_register_documents',
        'apios_set_contract_dna_status',
        'apios_upsert_solicitation_profiles',
        'command_authorize_mission',
        'command_bind_mission_run',
        'command_create_mission',
        'command_verify_dashboard_password',
        'dedup_scan_candidates',
        'enqueue_scan_continue',
        'generate_iron_condor_candidates',
        'natcorp_apply_release_gates',
        'natcorp_build_business_dna',
        'natcorp_build_contract_dna',
        'natcorp_create_business_discovery_command',
        'natcorp_create_business_discovery_command_core',
        'natcorp_disposition_candidate',
        'natcorp_expire_aged_contracts',
        'natcorp_get_contract_dna',
        'natcorp_record_business_discovery_candidates',
        'natcorp_register_documents',
        'natcorp_select_business_discovery_candidate',
        'piee_claim_pending_documents',
        'piee_get_pending_document_sources',
        'piee_mark_document_retrieval',
        'piee_update_document_source'
      ]::text[])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end $$;

-- command_is_operator is intentionally callable by authenticated users because it
-- performs the operator identity decision. It is not itself a privileged mutation.
revoke execute on function public.command_is_operator() from public, anon;
grant execute on function public.command_is_operator() to authenticated, service_role;

-- Migration-level assertions for the exact VAR exploit surfaces.
do $$
declare
  sig regprocedure;
begin
  foreach sig in array array[
    'public.natcorp_create_business_discovery_command(uuid)'::regprocedure,
    'public.natcorp_record_business_discovery_candidates(uuid,jsonb)'::regprocedure,
    'public.natcorp_select_business_discovery_candidate(uuid,uuid)'::regprocedure,
    'public.natcorp_disposition_candidate(uuid,text,text,text)'::regprocedure,
    'public.natcorp_build_business_dna(uuid)'::regprocedure,
    'public.natcorp_get_contract_dna(uuid)'::regprocedure,
    'public.command_bind_mission_run(uuid,uuid)'::regprocedure
  ]
  loop
    if has_function_privilege('anon', sig, 'EXECUTE')
       or has_function_privilege('authenticated', sig, 'EXECUTE') then
      raise exception 'VAR privileged RPC boundary failed for %', sig;
    end if;
    if not has_function_privilege('service_role', sig, 'EXECUTE') then
      raise exception 'VAR service-role execution missing for %', sig;
    end if;
  end loop;
end $$;
