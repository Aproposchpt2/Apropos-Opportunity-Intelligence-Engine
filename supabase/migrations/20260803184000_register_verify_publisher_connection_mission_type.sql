insert into public.command_mission_types (
  mission_type_key,
  display_name,
  methodology,
  methodology_version,
  default_command_definition_id,
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
  'VERIFY_PUBLISHER_CONNECTION',
  'Verify Publisher Connection',
  jsonb_build_object(
    'purpose','Execute Engineering Acceptance Gate EAG-001 against one publisher using the production connector without acquiring contracts',
    'execution_mode','READ_ONLY',
    'publisher_scope','SINGLE',
    'certification_gate','EAG-001'
  ),
  '1.0',
  null,
  'connector_acceptance_registry',
  jsonb_build_object(
    'structured_contract_records_required',true,
    'contract_specific_detail_resolution_required',true,
    'sample_detail_validation_required',true,
    'repository_writes_prohibited',true
  ),
  jsonb_build_object('not_applicable',true),
  jsonb_build_object('retry',true,'resume',false,'fail_closed',true),
  'publisher_connection_verification_report',
  jsonb_build_object(
    'same_production_connector_required',true,
    'certification_evidence_required',true,
    'acquisition_blocked_until_certified',true
  ),
  true,
  jsonb_build_object('mode','SYSTEM_ASSIGNED','agent','Publisher Engineering'),
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