-- PDAS / AADP VAR-readiness corrective migration
-- Addresses PDAS/AADP-specific performance advisor findings and reasserts operator-function privilege boundaries.

create index if not exists aadp_action_needed_alerts_command_run_id_idx
  on public.aadp_action_needed_alerts(command_run_id);
create index if not exists aadp_action_needed_alerts_discovery_run_id_idx
  on public.aadp_action_needed_alerts(discovery_run_id);
create index if not exists aadp_action_needed_alerts_publisher_id_idx
  on public.aadp_action_needed_alerts(publisher_id);

create index if not exists aadp_document_manifests_raw_record_id_idx
  on public.aadp_document_manifests(raw_record_id);

create index if not exists aadp_process_stage_projection_acquisition_run_id_idx
  on public.aadp_process_stage_projection(acquisition_run_id);
create index if not exists aadp_process_stage_projection_publisher_id_idx
  on public.aadp_process_stage_projection(publisher_id);

create index if not exists aadp_recommendation_decisions_recommendation_id_idx
  on public.aadp_recommendation_decisions(recommendation_id);
create index if not exists aadp_recommendation_decisions_decided_by_idx
  on public.aadp_recommendation_decisions(decided_by);

create index if not exists aadp_record_version_relationships_acquisition_run_id_idx
  on public.aadp_record_version_relationships(acquisition_run_id);
create index if not exists aadp_record_version_relationships_publisher_id_idx
  on public.aadp_record_version_relationships(publisher_id);
create index if not exists aadp_record_version_relationships_related_record_id_idx
  on public.aadp_record_version_relationships(related_record_id);

create index if not exists acquisition_raw_records_assignment_id_idx
  on public.acquisition_raw_records(assignment_id);
create index if not exists acquisition_raw_records_predecessor_record_id_idx
  on public.acquisition_raw_records(predecessor_record_id);
create index if not exists acquisition_raw_records_superseded_by_record_id_idx
  on public.acquisition_raw_records(superseded_by_record_id);
create index if not exists acquisition_raw_records_amendment_of_record_id_idx
  on public.acquisition_raw_records(amendment_of_record_id);

create index if not exists acquisition_record_dispositions_raw_record_id_idx
  on public.acquisition_record_dispositions(raw_record_id);

create index if not exists acquisition_rejections_acquisition_run_id_idx
  on public.acquisition_rejections(acquisition_run_id);
create index if not exists acquisition_rejections_raw_record_id_idx
  on public.acquisition_rejections(raw_record_id);

create index if not exists acquisition_runs_command_run_id_idx
  on public.acquisition_runs(command_run_id);

create index if not exists aoie_change_recommendations_batch_review_id_idx
  on public.aoie_change_recommendations(batch_review_id);

create index if not exists command_runs_definition_id_idx
  on public.command_runs(definition_id);
create index if not exists command_runs_publisher_assignment_id_idx
  on public.command_runs(publisher_assignment_id);
create index if not exists command_runs_requested_by_idx
  on public.command_runs(requested_by);

create index if not exists command_task_dependencies_depends_on_task_id_idx
  on public.command_task_dependencies(depends_on_task_id);

create index if not exists publisher_assignments_publisher_id_idx
  on public.publisher_assignments(publisher_id);

create index if not exists system_status_current_run_id_idx
  on public.system_status(current_run_id);

revoke all on function public.command_is_operator() from public, anon;
grant execute on function public.command_is_operator() to authenticated;

comment on function public.command_is_operator() is
  'Returns whether the authenticated identity is an authorized Command Center operator. Anonymous execution is revoked; authenticated execution is required by RLS policies.';
