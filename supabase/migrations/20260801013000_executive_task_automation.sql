insert into public.command_mission_types (
  mission_type_key,display_name,methodology,methodology_version,registry_destination,
  verification_standard,duplicate_control_profile,research_resiliency,reporting_template,
  quality_control_requirements,state_context_required,agent_selection_behavior,enabled,updated_at
) values
('AADP_PROCESSING','AADP Processing','{"automation_mode":"FULLY_AUTOMATED","scope_resolved_from_operator_selection":true}'::jsonb,'1.0','acquisition_raw_records','{"evidence_required":true}'::jsonb,'{"enabled":true}'::jsonb,'{"retry":true,"resume":true}'::jsonb,'ACTUAL_RESULTS_ONLY','{"no_estimates":true,"preserve_provenance":true}'::jsonb,false,'{"mode":"SYSTEM_ASSIGNED","agent":"AADP Processing"}'::jsonb,true,now()),
('AOIE_ANALYSIS','AOIE Analysis','{"automation_mode":"FULLY_AUTOMATED","scope_resolved_from_operator_selection":true}'::jsonb,'1.0','state_contract_opportunities','{"evidence_required":true}'::jsonb,'{"enabled":true}'::jsonb,'{"retry":true,"resume":true}'::jsonb,'ACTUAL_RESULTS_ONLY','{"no_estimates":true,"explainable_results":true}'::jsonb,false,'{"mode":"SYSTEM_ASSIGNED","agent":"AOIE Analysis"}'::jsonb,true,now()),
('PROCUREMENT_INVENTORY','Procurement Inventory Maintenance','{"automation_mode":"FULLY_AUTOMATED","canonical_table":"state_contract_opportunities"}'::jsonb,'1.0','state_contract_opportunities','{"evidence_required":true}'::jsonb,'{"enabled":true}'::jsonb,'{"retry":true,"resume":true}'::jsonb,'ACTUAL_RESULTS_ONLY','{"no_estimates":true,"no_blind_deletion":true}'::jsonb,false,'{"mode":"SYSTEM_ASSIGNED","agent":"Inventory Control"}'::jsonb,true,now()),
('CONTRACT_LIFECYCLE','Contract Lifecycle','{"automation_mode":"FULLY_AUTOMATED","historical_retention":true}'::jsonb,'1.0','contract_lifecycle_events','{"evidence_required":true}'::jsonb,'{"enabled":true}'::jsonb,'{"retry":true,"resume":true}'::jsonb,'ACTUAL_RESULTS_ONLY','{"no_estimates":true,"preserve_history":true}'::jsonb,false,'{"mode":"SYSTEM_ASSIGNED","agent":"Contract Lifecycle"}'::jsonb,true,now())
on conflict (mission_type_key) do update set
  display_name=excluded.display_name,
  methodology=excluded.methodology,
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
