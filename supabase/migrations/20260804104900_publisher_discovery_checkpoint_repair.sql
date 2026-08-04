-- Publisher Discovery checkpoint repair. Preserves all admitted publisher and candidate evidence.

update public.command_runs
set status='failed', aadp_state='FAILED', current_stage='INTERRUPTED_TIMEOUT_SUPERSEDED',
    action_required=true, failure_count=greatest(coalesce(failure_count,0),1),
    completed_at=coalesce(completed_at,now()), last_activity_at=now(), updated_at=now(),
    result_summary='Execution exceeded the background-function lifecycle and was superseded by checkpoint repair. Persisted publisher records were preserved.',
    execution_evidence=coalesce(execution_evidence,'{}'::jsonb)||jsonb_build_object('repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','interrupted',true,'superseded',true,'records_preserved',true,'repaired_at',now())
where id in ('7e0d2ed3-9517-44ed-b783-17478bfd077c'::uuid,'22042209-4e6a-4154-b435-2703c1abc558'::uuid)
  and status in ('queued','running');

update public.command_runs
set status='failed', aadp_state='FAILED', current_stage='INTERRUPTED_TIMEOUT_SUPERSEDED',
    action_required=true, failure_count=greatest(coalesce(failure_count,0),1),
    completed_at=coalesce(completed_at,now()), last_activity_at=now(), updated_at=now(),
    result_summary='Child task interrupted by timeout and superseded. Persisted candidate and publisher evidence was preserved.',
    execution_evidence=coalesce(execution_evidence,'{}'::jsonb)||jsonb_build_object('repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','interrupted',true,'superseded',true,'records_preserved',true,'repaired_at',now())
where parent_run_id in ('7e0d2ed3-9517-44ed-b783-17478bfd077c'::uuid,'22042209-4e6a-4154-b435-2703c1abc558'::uuid)
  and status in ('queued','running');

update public.publisher_discovery_runs
set status='FAILED', current_stage='INTERRUPTED_TIMEOUT_SUPERSEDED', completed_at=coalesce(completed_at,now()), updated_at=now(),
    evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object('repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','interrupted',true,'superseded',true,'records_preserved',true,'repaired_at',now())
where command_run_id in ('7e0d2ed3-9517-44ed-b783-17478bfd077c'::uuid,'22042209-4e6a-4154-b435-2703c1abc558'::uuid)
  and status in ('CREATED','AUTHORIZED','QUEUED','RUNNING','PAUSED','PARTIALLY_COMPLETE');

update public.publisher_discovery_runs
set status='FAILED', current_stage='SUPERSEDED_BY_CHECKPOINT_REPAIR', completed_at=coalesce(completed_at,now()), updated_at=now(),
    evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object('repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','superseded_by_discovery_run_id','b29cada5-0db2-4446-98d4-5d61c206eb16','records_preserved',true,'repaired_at',now())
where command_run_id='5ee86db3-fdac-4a5d-be29-7a5046effb96'::uuid
  and id<>'b29cada5-0db2-4446-98d4-5d61c206eb16'::uuid
  and status in ('CREATED','AUTHORIZED','QUEUED','RUNNING','PAUSED','PARTIALLY_COMPLETE');

update public.publisher_discovery_runs
set status='RUNNING', current_stage='ENTITY_CLASS_13', completed_at=null, updated_at=now(),
    governance=coalesce(governance,'{}'::jsonb)||jsonb_build_object('execution_model','ONE_ENTITY_CLASS_PER_BACKGROUND_INVOCATION','checkpoint_after_each_unit',true,'resume_from_first_unfinished_unit',true,'repair_resume_unit','ENTITY_CLASS_13'),
    evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object('repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','engine','CHECKPOINTED_ENTITY_CLASS_ORCHESTRATOR','resume_unit','ENTITY_CLASS_13','completed_units_preserved',12,'records_preserved',true,'repaired_at',now())
where id='b29cada5-0db2-4446-98d4-5d61c206eb16'::uuid;

update public.command_runs
set status='completed',
    aadp_state=(case when coalesce(records_rejected,0)>0 then 'PARTIALLY_COMPLETE' else 'COMPLETED' end)::aadp_run_state,
    current_stage=case when idempotency_key like '%:ENTITY_CLASS_06' then 'COMPLETED_NO_RESULTS' when coalesce(records_rejected,0)>0 then 'COMPLETED_WITH_WARNINGS' else 'COMPLETED' end,
    progress_value=100, completed_at=coalesce(completed_at,last_activity_at,now()),
    action_required=coalesce(records_rejected,0)>0, failure_count=0, updated_at=now(),
    execution_evidence=coalesce(execution_evidence,'{}'::jsonb)||jsonb_build_object('checkpoint_restored',true,'repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','repaired_at',now())
where parent_run_id='5ee86db3-fdac-4a5d-be29-7a5046effb96'::uuid
  and substring(idempotency_key from 'ENTITY_CLASS_[0-9]{2}') in ('ENTITY_CLASS_01','ENTITY_CLASS_02','ENTITY_CLASS_03','ENTITY_CLASS_04','ENTITY_CLASS_05','ENTITY_CLASS_06','ENTITY_CLASS_07','ENTITY_CLASS_08','ENTITY_CLASS_09','ENTITY_CLASS_10','ENTITY_CLASS_11','ENTITY_CLASS_12');

update public.command_runs
set status='failed', aadp_state='FAILED', current_stage='INTERRUPTED_TIMEOUT_RETRYABLE', action_required=false,
    failure_count=greatest(coalesce(failure_count,0),1), completed_at=coalesce(completed_at,now()), last_activity_at=now(), updated_at=now(),
    result_summary='Interrupted by the prior monolithic background invocation. Checkpoint repair will retry this unit only.',
    execution_evidence=coalesce(execution_evidence,'{}'::jsonb)||jsonb_build_object('retryable',true,'repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','repaired_at',now())
where parent_run_id='5ee86db3-fdac-4a5d-be29-7a5046effb96'::uuid
  and substring(idempotency_key from 'ENTITY_CLASS_[0-9]{2}')='ENTITY_CLASS_13';

update public.command_runs
set status='queued', aadp_state='QUEUED', current_stage='REPAIR_RESUME_QUEUED', progress_value=28,
    records_discovered=71, records_acquired=71, records_accepted=70, records_rejected=1,
    warning_count=1, failure_count=0, action_required=false, completed_at=null, last_activity_at=now(), updated_at=now(),
    result_summary='Checkpoint repair complete. Classes 1-12 and 70 admitted publishers are preserved. Resume queued at Class 13 of 41.',
    execution_evidence=coalesce(execution_evidence,'{}'::jsonb)||jsonb_build_object('repair_code','PUBLISHER_DISCOVERY_CHECKPOINT_REPAIR','execution_model','ONE_ENTITY_CLASS_PER_BACKGROUND_INVOCATION','checkpointed',true,'canonical_discovery_run_id','b29cada5-0db2-4446-98d4-5d61c206eb16','resume_unit_index',12,'resume_unit_key','ENTITY_CLASS_13','completed_units_preserved',12,'candidate_rows_preserved',71,'admitted_publishers_preserved',70,'repaired_at',now())
where id='5ee86db3-fdac-4a5d-be29-7a5046effb96'::uuid;

create unique index if not exists command_runs_active_county_discovery_uidx
on public.command_runs(state_code,coalesce(execution_evidence->>'county_fips',''),upper(coalesce(execution_evidence->>'county_name','')))
where mission_type_key='PUBLISHER_DISCOVERY' and status in ('queued','running');

create unique index if not exists publisher_discovery_runs_one_active_per_command_uidx
on public.publisher_discovery_runs(command_run_id)
where command_run_id is not null and status in ('CREATED','AUTHORIZED','QUEUED','RUNNING','PAUSED','PARTIALLY_COMPLETE');
