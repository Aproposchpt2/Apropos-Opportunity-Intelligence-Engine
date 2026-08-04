-- Corrective mission registry entry for the production runtime key.
-- The dashboard label is "Complete Contract Packages" while the governed key is CONTRACT_PACKAGE_ACQUISITION.

insert into public.command_mission_types (
  mission_type_key,
  display_name,
  methodology,
  methodology_version,
  registry_destination,
  verification_standard,
  duplicate_control_profile,
  research_resiliency,
  reporting_template,
  quality_control_requirements,
  state_context_required,
  agent_selection_behavior,
  enabled,
  created_at,
  updated_at
) values (
  'CONTRACT_PACKAGE_ACQUISITION',
  'Complete Contract Packages',
  jsonb_build_object(
    'purpose','Acquire, preserve, extract, classify, and consolidate every available official solicitation attachment before business matching',
    'execution_model','CHECKPOINTED_COMPLETE_CONTRACT_PACKAGE',
    'publisher_scope','SINGLE',
    'openai_usage','NONE',
    'package_completion_required_for_matching',true
  ),
  '1.0',
  'aadp_document_manifests,solicitation_package_documents,solicitation_documents,state_contract_opportunities',
  jsonb_build_object(
    'official_source_required',true,
    'private_archive_required',true,
    'checksum_required',true,
    'requirements_extraction_required',true,
    'package_complete_required',true,
    'match_ready_gate_required',true
  ),
  jsonb_build_object(
    'document_checksum_deduplication',true,
    'canonical_opportunity_linkage_required',true
  ),
  jsonb_build_object(
    'retry',true,
    'resume',true,
    'checkpointed',true,
    'batch_size_default',3
  ),
  'complete_contract_package_report',
  jsonb_build_object(
    'no_estimates',true,
    'preserve_original_files',true,
    'preserve_provenance',true,
    'block_matching_until_match_ready',true
  ),
  true,
  jsonb_build_object(
    'mode','SYSTEM_ASSIGNED',
    'agent','AADP Package Acquisition'
  ),
  true,
  now(),
  now()
)
on conflict (mission_type_key) do update set
  display_name=excluded.display_name,
  methodology=excluded.methodology,
  methodology_version=excluded.methodology_version,
  registry_destination=excluded.registry_destination,
  verification_standard=excluded.verification_standard,
  duplicate_control_profile=excluded.duplicate_control_profile,
  research_resiliency=excluded.research_resiliency,
  reporting_template=excluded.reporting_template,
  quality_control_requirements=excluded.quality_control_requirements,
  state_context_required=excluded.state_context_required,
  agent_selection_behavior=excluded.agent_selection_behavior,
  enabled=true,
  updated_at=now();

update public.command_mission_types
set enabled=false,
    updated_at=now()
where mission_type_key='COMPLETE_CONTRACT_PACKAGES';
