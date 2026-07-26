-- AADP V1 database acceptance tests. Run against an isolated shadow database only.
begin;

do $$
declare publisher uuid; assignment uuid; run_id uuid; complete_raw uuid; missing_req uuid; missing_contact uuid; d public.aadp_record_disposition; rec jsonb;
begin
  insert into public.publisher_registry(publisher_key,publisher_name,acquisition_method,verification_status,verified_at)
  values('AADP-TEST-001','AADP Shadow Test Publisher','OFFICIAL_API','VERIFIED',now()) returning id into publisher;

  insert into public.publisher_assignments(publisher_id,acquisition_method,status)
  values(publisher,'OFFICIAL_API','AUTHORIZED') returning id into assignment;

  insert into public.acquisition_runs(assignment_id,state,started_at,records_acquired,pagination_complete)
  values(assignment,'RUNNING',now(),3,true) returning id into run_id;

  insert into public.acquisition_raw_records(acquisition_run_id,assignment_id,publisher_id,source_record_id,raw_payload,source_fingerprint,content_fingerprint)
  values(run_id,assignment,publisher,'COMPLETE-1',jsonb_build_object('description','Provide managed network operations, monitoring, incident response, reporting, and documented service deliverables.','contact_email','procurement@example.gov','responsible_entity','Procurement Division'),'src-complete','content-complete') returning id into complete_raw;

  insert into public.acquisition_raw_records(acquisition_run_id,assignment_id,publisher_id,source_record_id,raw_payload,source_fingerprint,content_fingerprint)
  values(run_id,assignment,publisher,'NO-REQ-1',jsonb_build_object('title','General Notice','contact_email','procurement@example.gov'),'src-no-req','content-no-req') returning id into missing_req;

  insert into public.acquisition_raw_records(acquisition_run_id,assignment_id,publisher_id,source_record_id,raw_payload,source_fingerprint,content_fingerprint)
  values(run_id,assignment,publisher,'NO-CONTACT-1',jsonb_build_object('description','Supply and install commercial lighting fixtures, controls, commissioning, training, warranty support, and closeout documentation.'),'src-no-contact','content-no-contact') returning id into missing_contact;

  d := public.aadp_qualify_raw_record(complete_raw);
  if d <> 'QUALIFIED' then raise exception 'Expected complete record QUALIFIED, got %', d; end if;

  d := public.aadp_qualify_raw_record(missing_req);
  if d <> 'REJECTED_INCOMPLETE' then raise exception 'Expected missing requirements rejected, got %', d; end if;
  if not exists(select 1 from public.acquisition_record_dispositions where raw_record_id=missing_req and 'MISSING_CONTRACT_REQUIREMENTS'=any(reason_codes)) then
    raise exception 'Missing requirement reason code not stored';
  end if;

  d := public.aadp_qualify_raw_record(missing_contact);
  if d <> 'REJECTED_INCOMPLETE' then raise exception 'Expected missing contact rejected, got %', d; end if;
  if not exists(select 1 from public.acquisition_record_dispositions where raw_record_id=missing_contact and 'MISSING_CONTRACT_CONTACT'=any(reason_codes)) then
    raise exception 'Missing contact reason code not stored';
  end if;

  rec := public.aadp_reconcile_acquisition_run(run_id);
  if coalesce((rec->>'passed')::boolean,false) is not true then raise exception 'Expected reconciliation pass: %', rec; end if;
  if (rec->>'variance')::int <> 0 then raise exception 'Expected zero variance: %', rec; end if;
end $$;

-- Completion without evidence must be rejected by the table constraint.
do $$
declare command_id uuid; run_id uuid; violated boolean := false;
begin
  insert into public.command_definitions(code,name) values('AADP-TEST-COMMAND','AADP test command') returning id into command_id;
  insert into public.command_runs(command_definition_id,state) values(command_id,'AUTHORIZED') returning id into run_id;
  begin
    insert into public.command_tasks(command_run_id,task_type,state) values(run_id,'RUN_RECONCILIATION','COMPLETED');
  exception when check_violation then violated := true;
  end;
  if not violated then raise exception 'Task completion evidence constraint did not reject invalid completion'; end if;
end $$;

rollback;
