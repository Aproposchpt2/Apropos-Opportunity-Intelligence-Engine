-- Durable EAG-001 Publisher Connection Verification execution via PostgreSQL + GitHub Actions.

create or replace function public.enqueue_command_execution(p_run_id uuid, p_runtime text default 'GITHUB_ACTIONS'::text, p_priority integer default 100)
returns public.command_execution_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_run public.command_runs%rowtype;
  v_queue public.command_execution_queue%rowtype;
  v_publisher_id text;
  v_publisher_scope text;
begin
  select * into v_run from public.command_runs where id = p_run_id;
  if not found then raise exception 'command run % not found', p_run_id; end if;
  if coalesce(v_run.mission_type_key,'') not in ('ACQUISITION_DISCOVERY','CONTRACT_PACKAGE_ACQUISITION','PUBLISHER_DISCOVERY','VERIFY_PUBLISHER_CONNECTION') then
    raise exception 'mission type % is not Postgre-orchestrated', v_run.mission_type_key;
  end if;

  v_publisher_id := nullif(trim(coalesce(v_run.execution_evidence->>'publisher_id','')), '');
  v_publisher_scope := upper(coalesce(nullif(trim(v_run.execution_evidence->>'publisher_scope'),''), case when v_publisher_id is not null then 'SINGLE' else 'ALL' end));

  insert into public.command_execution_queue (command_run_id, mission_type_key, runtime, state, priority, payload, available_at, updated_at)
  values (
    v_run.id, v_run.mission_type_key, coalesce(nullif(trim(p_runtime),''),'GITHUB_ACTIONS'), 'QUEUED', coalesce(p_priority,100),
    jsonb_build_object(
      'mission_name', v_run.mission_name,
      'state_code', upper(v_run.state_code),
      'assigned_agent', v_run.assigned_agent,
      'publisher_id', v_publisher_id,
      'publisher_scope', v_publisher_scope,
      'execution_evidence', v_run.execution_evidence,
      'execution_envelope', jsonb_build_object(
        'state_code', upper(v_run.state_code), 'publisher_id', v_publisher_id, 'publisher_scope', v_publisher_scope,
        'county_name', v_run.execution_evidence->>'county_name', 'county_fips', v_run.execution_evidence->>'county_fips',
        'discovery_scope', v_run.execution_evidence->>'discovery_scope', 'sealed_at', now(), 'immutable', true
      )
    ), now(), now()
  )
  on conflict (command_run_id) do update set
    mission_type_key=excluded.mission_type_key, runtime=excluded.runtime,
    state=case when command_execution_queue.state in ('COMPLETED','CANCELLED') then command_execution_queue.state else 'QUEUED' end,
    priority=excluded.priority, payload=command_execution_queue.payload, available_at=now(), claimed_by=null, claimed_at=null,
    lease_expires_at=null, heartbeat_at=null, updated_at=now()
  returning * into v_queue;

  update public.command_runs
     set status='queued', aadp_state='QUEUED', current_stage='POSTGRES_EXECUTION_QUEUED', last_activity_at=now(), updated_at=now(),
         execution_evidence=coalesce(execution_evidence,'{}'::jsonb) || jsonb_build_object(
           'runtime','SUPABASE_POSTGRES','orchestration','SUPABASE_POSTGRES','worker_runtime',v_queue.runtime,
           'queue_id',v_queue.id,'execution_envelope_sealed',true)
   where id=p_run_id;
  return v_queue;
end;
$function$;

create or replace function public.command_execution_queue_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status='queued'
     and new.mission_type_key in ('ACQUISITION_DISCOVERY','CONTRACT_PACKAGE_ACQUISITION','PUBLISHER_DISCOVERY','VERIFY_PUBLISHER_CONNECTION')
     and coalesce(new.execution_evidence->>'orchestration','') <> 'SUPABASE_POSTGRES'
     and not exists (select 1 from public.command_execution_queue q where q.command_run_id=new.id)
  then
    perform public.enqueue_command_execution(new.id,'GITHUB_ACTIONS',100);
  end if;
  return new;
end;
$function$;

create or replace function public.claim_next_publisher_verification_execution(p_worker_id text, p_lease_seconds integer default 1800)
returns table(queue_id uuid, command_run_id uuid, mission_type_key text, runtime text, attempt_count integer, payload jsonb, mission_config jsonb)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_run_id uuid;
begin
  with candidate as (
    select q.id,q.command_run_id from public.command_execution_queue q
     where q.state in ('QUEUED','RETRY_PENDING') and q.mission_type_key='VERIFY_PUBLISHER_CONNECTION'
       and q.available_at<=now() and q.attempt_count<q.max_attempts
     order by q.priority desc,q.created_at for update skip locked limit 1
  )
  update public.command_execution_queue q
     set state='CLAIMED', claimed_by=p_worker_id, claimed_at=now(), heartbeat_at=now(),
         lease_expires_at=now()+make_interval(secs=>greatest(60,coalesce(p_lease_seconds,1800))),
         attempt_count=q.attempt_count+1, updated_at=now()
    from candidate c where q.id=c.id
  returning q.id,q.command_run_id into v_id,v_run_id;
  if v_id is null then return; end if;

  update public.command_runs set status='running',aadp_state='RUNNING',current_stage='EAG_001_WORKER_CLAIMED',
    started_at=coalesce(started_at,now()),last_activity_at=now(),updated_at=now() where id=v_run_id;

  return query
  select q.id,q.command_run_id,q.mission_type_key,q.runtime,q.attempt_count,q.payload,coalesce(m.mission_config,'{}'::jsonb)
    from public.command_execution_queue q left join public.command_missions m on m.command_run_id=q.command_run_id
   where q.id=v_id order by m.created_at desc limit 1;
end;
$function$;

create or replace function public.fail_command_execution_terminal(p_queue_id uuid,p_worker_id text,p_result jsonb default '{}'::jsonb,p_error text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_run_id uuid;
begin
  select command_run_id into v_run_id from public.command_execution_queue
   where id=p_queue_id and claimed_by=p_worker_id and state in ('CLAIMED','RUNNING') for update;
  if v_run_id is null then return false; end if;
  update public.command_execution_queue set state='FAILED',last_error=p_error,result=coalesce(p_result,'{}'::jsonb),
    completed_at=now(),lease_expires_at=null,heartbeat_at=now(),updated_at=now() where id=p_queue_id;
  update public.command_runs set status='failed'::command_run_status,aadp_state='FAILED'::aadp_run_state,
    current_stage=case when current_stage like 'EAG_001_%' then current_stage else 'POSTGRES_EXECUTION_FAILED' end,
    action_required=true,result_summary=coalesce(p_error,result_summary),last_activity_at=now(),updated_at=now() where id=v_run_id;
  return true;
end;
$function$;

create or replace function public.claim_next_command_execution(p_worker_id text,p_lease_seconds integer default 1800)
returns table(queue_id uuid,command_run_id uuid,mission_type_key text,runtime text,attempt_count integer,payload jsonb,mission_config jsonb)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid; v_run_id uuid;
begin
  with candidate as (
    select q.id,q.command_run_id from public.command_execution_queue q
     where q.state in ('QUEUED','RETRY_PENDING') and q.mission_type_key <> 'VERIFY_PUBLISHER_CONNECTION'
       and q.available_at<=now() and q.attempt_count<q.max_attempts
     order by q.priority desc,q.created_at for update skip locked limit 1
  )
  update public.command_execution_queue q set state='CLAIMED',claimed_by=p_worker_id,claimed_at=now(),heartbeat_at=now(),
    lease_expires_at=now()+make_interval(secs=>greatest(60,coalesce(p_lease_seconds,1800))),attempt_count=q.attempt_count+1,updated_at=now()
    from candidate c where q.id=c.id returning q.id,q.command_run_id into v_id,v_run_id;
  if v_id is null then return; end if;
  update public.command_runs set status='running',aadp_state='RUNNING',current_stage='POSTGRES_EXECUTION_CLAIMED',
    started_at=coalesce(started_at,now()),last_activity_at=now(),updated_at=now() where id=v_run_id;
  return query select q.id,q.command_run_id,q.mission_type_key,q.runtime,q.attempt_count,q.payload,coalesce(m.mission_config,'{}'::jsonb)
    from public.command_execution_queue q left join public.command_missions m on m.command_run_id=q.command_run_id
    where q.id=v_id order by m.created_at desc limit 1;
end;
$function$;
