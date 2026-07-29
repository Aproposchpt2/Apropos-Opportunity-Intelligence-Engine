-- APIOS Executive Command Center Operational Orchestration Upgrade
-- Checkpoint 3 / Gate B: generalized mission execution contract.
-- Repository implementation only until separately authorized for database application.

create table public.command_missions (
  id uuid primary key default gen_random_uuid(),
  mission_type_key text not null references public.command_mission_types(mission_type_key),
  mission_name text not null,
  state_code text,
  assigned_agent text not null,
  mission_config jsonb not null default '{}'::jsonb,
  authorization_state text not null default 'PENDING_AUTHORIZATION',
  authorization_required boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  authorized_by uuid references auth.users(id) on delete set null,
  authorized_at timestamptz,
  command_run_id uuid unique references public.command_runs(id) on delete set null,
  blocking_reasons jsonb not null default '[]'::jsonb,
  readiness_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint command_missions_state_code_check check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  constraint command_missions_authorization_state_check check (authorization_state in ('PENDING_AUTHORIZATION','AUTHORIZED','BLOCKED','CANCELLED'))
);

create index command_missions_type_created_idx on public.command_missions(mission_type_key,created_at desc);
create index command_missions_state_created_idx on public.command_missions(state_code,created_at desc) where state_code is not null;
create index command_missions_authorization_idx on public.command_missions(authorization_state,created_at desc);

create trigger command_missions_touch_updated_at before update on public.command_missions
for each row execute function public.command_touch_updated_at();

alter table public.command_missions enable row level security;
grant select on public.command_missions to authenticated;
grant all on public.command_missions to service_role;
revoke all on public.command_missions from anon;
create policy command_missions_operator_read on public.command_missions
for select to authenticated using (public.command_is_operator());

create or replace function public.command_create_mission(
  p_mission_type_key text,
  p_mission_name text,
  p_state_code text,
  p_assigned_agent text,
  p_mission_config jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_type public.command_mission_types%rowtype;
  v_mission_id uuid;
  v_state text := upper(nullif(btrim(p_state_code),''));
  v_authorization_state text;
  v_blocking_reasons jsonb := '[]'::jsonb;
begin
  if not public.command_is_operator() then raise exception 'Command Center operator authorization required'; end if;
  select * into v_type from public.command_mission_types where mission_type_key=upper(btrim(p_mission_type_key)) and enabled=true;
  if not found then raise exception 'Unknown or disabled mission type'; end if;
  if nullif(btrim(p_mission_name),'') is null then raise exception 'mission_name is required'; end if;
  if nullif(btrim(p_assigned_agent),'') is null then raise exception 'assigned_agent is required'; end if;
  if v_type.state_context_required and (v_state is null or v_state !~ '^[A-Z]{2}$') then raise exception 'A two-letter state_code is required for this mission type'; end if;

  if v_type.default_command_definition_id is null then
    v_authorization_state := 'BLOCKED';
    v_blocking_reasons := jsonb_build_array(jsonb_build_object('code','RUNTIME_NOT_IMPLEMENTED','message','Mission type is registered but no authorized runtime command definition exists.'));
  else
    v_authorization_state := 'PENDING_AUTHORIZATION';
  end if;

  insert into public.command_missions(mission_type_key,mission_name,state_code,assigned_agent,mission_config,authorization_state,created_by,blocking_reasons,readiness_evidence)
  values (v_type.mission_type_key,btrim(p_mission_name),v_state,btrim(p_assigned_agent),coalesce(p_mission_config,'{}'::jsonb),v_authorization_state,auth.uid(),v_blocking_reasons,
          jsonb_build_object('mission_type_enabled',true,'state_context_satisfied',(not v_type.state_context_required or v_state is not null),'agent_assigned',true,'runtime_definition_available',(v_type.default_command_definition_id is not null)))
  returning id into v_mission_id;

  insert into public.command_audit_log(entity_type,entity_id,action_type,actor_type,actor_id,reason,new_state,evidence)
  values ('COMMAND_MISSION',v_mission_id::text,'MISSION_CREATED','OPERATOR',auth.uid()::text,'Generalized mission record created without self-authorization.',jsonb_build_object('authorization_state',v_authorization_state),jsonb_build_object('mission_type_key',v_type.mission_type_key,'state_code',v_state));
  return v_mission_id;
end $$;

revoke all on function public.command_create_mission(text,text,text,text,jsonb) from public;
grant execute on function public.command_create_mission(text,text,text,text,jsonb) to authenticated,service_role;

create or replace function public.command_authorize_mission(p_mission_id uuid)
returns uuid
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_mission public.command_missions%rowtype;
  v_definition_id uuid;
begin
  if not public.command_is_operator() then raise exception 'Command Center operator authorization required'; end if;
  select * into v_mission from public.command_missions where id=p_mission_id for update;
  if not found then raise exception 'Mission not found'; end if;
  select default_command_definition_id into v_definition_id from public.command_mission_types where mission_type_key=v_mission.mission_type_key and enabled=true;
  if v_mission.authorization_state='BLOCKED' then raise exception 'Blocked mission cannot be authorized'; end if;
  if v_mission.authorization_state='CANCELLED' then raise exception 'Cancelled mission cannot be authorized'; end if;
  if v_definition_id is null then raise exception 'Mission type has no authorized runtime command definition'; end if;

  update public.command_missions set authorization_state='AUTHORIZED',authorized_by=auth.uid(),authorized_at=now() where id=p_mission_id;
  insert into public.command_audit_log(entity_type,entity_id,action_type,actor_type,actor_id,reason,previous_state,new_state,evidence)
  values ('COMMAND_MISSION',p_mission_id::text,'MISSION_AUTHORIZED','OPERATOR',auth.uid()::text,'Operator explicitly authorized mission execution.',jsonb_build_object('authorization_state',v_mission.authorization_state),jsonb_build_object('authorization_state','AUTHORIZED'),jsonb_build_object('default_command_definition_id',v_definition_id));
  return p_mission_id;
end $$;

revoke all on function public.command_authorize_mission(uuid) from public;
grant execute on function public.command_authorize_mission(uuid) to authenticated,service_role;

create or replace function public.command_bind_mission_run(p_mission_id uuid,p_command_run_id uuid)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_mission public.command_missions%rowtype;
  v_run public.command_runs%rowtype;
  v_definition_id uuid;
begin
  select * into v_mission from public.command_missions where id=p_mission_id for update;
  if not found then raise exception 'Mission not found'; end if;
  if v_mission.authorization_state<>'AUTHORIZED' then raise exception 'Mission is not authorized'; end if;
  if v_mission.command_run_id is not null and v_mission.command_run_id<>p_command_run_id then raise exception 'Mission already bound to another command run'; end if;
  select * into v_run from public.command_runs where id=p_command_run_id for update;
  if not found then raise exception 'Command run not found'; end if;
  select default_command_definition_id into v_definition_id from public.command_mission_types where mission_type_key=v_mission.mission_type_key and enabled=true;
  if v_definition_id is null then raise exception 'Mission type is registered but not executable'; end if;
  if v_run.definition_id is distinct from v_definition_id then raise exception 'Command run definition does not match mission type definition'; end if;

  update public.command_runs set mission_type_key=v_mission.mission_type_key,mission_name=v_mission.mission_name,state_code=v_mission.state_code,assigned_agent=v_mission.assigned_agent,last_activity_at=coalesce(last_activity_at,updated_at) where id=p_command_run_id;
  update public.command_missions set command_run_id=p_command_run_id where id=p_mission_id;
  insert into public.command_audit_log(entity_type,entity_id,action_type,actor_type,command_run_id,reason,new_state,evidence)
  values ('COMMAND_MISSION',p_mission_id::text,'MISSION_RUN_BOUND','SYSTEM',p_command_run_id,'Authorized mission bound to its mission-specific command run without changing canonical execution state.',jsonb_build_object('command_run_id',p_command_run_id),jsonb_build_object('mission_type_key',v_mission.mission_type_key,'definition_id',v_definition_id));
  return p_command_run_id;
end $$;

revoke all on function public.command_bind_mission_run(uuid,uuid) from public,authenticated;
grant execute on function public.command_bind_mission_run(uuid,uuid) to service_role;

create or replace view public.command_mission_execution_contract with (security_invoker=true) as
select m.id mission_id,m.mission_type_key,m.mission_name,m.state_code,m.assigned_agent,m.authorization_state,m.authorization_required,
       case when mt.default_command_definition_id is null then 'REGISTERED_NOT_EXECUTABLE' else 'EXECUTABLE' end execution_capability,
       m.command_run_id,r.status canonical_execution_state,r.aadp_state mission_specific_state,
       case when m.authorization_state='CANCELLED' then 'CANCELLED'
            when m.authorization_state='BLOCKED' then 'BLOCKED'
            when m.authorization_state='PENDING_AUTHORIZATION' then 'PENDING AUTHORIZATION'
            when m.authorization_state='AUTHORIZED' and r.id is null then 'AUTHORIZED'
            when r.id is not null then public.command_derive_executive_state(r.status,r.aadp_state)
            else 'READY' end executive_display_state,
       case when m.authorization_state in ('BLOCKED','PENDING_AUTHORIZATION') then true
            when r.action_required then true
            when r.status in ('interrupted','failed','completed_with_failures') then true
            when r.aadp_state='ESCALATED' then true else false end action_required,
       m.blocking_reasons,m.readiness_evidence,r.current_stage,r.progress_mode,r.progress_value,r.started_at,
       coalesce(r.last_activity_at,r.updated_at,m.updated_at) last_activity_at,r.completed_at,r.result_summary,r.registry_impact,r.report_reference,r.execution_evidence,m.created_at,m.authorized_at
from public.command_missions m
join public.command_mission_types mt on mt.mission_type_key=m.mission_type_key
left join public.command_runs r on r.id=m.command_run_id;

grant select on public.command_mission_execution_contract to authenticated,service_role;
revoke all on public.command_mission_execution_contract from anon;

create or replace view public.command_unified_stage_projection with (security_invoker=true) as
select g.command_run_id,g.stage_key,g.display_name,g.display_state,g.sequence_number,g.progress_value,g.started_at,g.completed_at,g.records_processed,g.warning_count,g.failure_count,g.retry_count,coalesce(g.source_projection,'GENERIC') source_projection,g.evidence,g.updated_at
from public.command_stage_projection g
union all
select a.command_run_id,a.stage_key,a.display_name,a.display_state,row_number() over(partition by a.command_run_id order by coalesce(a.started_at,a.updated_at),a.stage_key)::integer sequence_number,null::numeric progress_value,a.started_at,a.completed_at,a.records_processed,a.warning_count,a.failure_count,a.retry_count,'AADP'::text source_projection,a.evidence,a.updated_at
from public.aadp_process_stage_projection a;

grant select on public.command_unified_stage_projection to authenticated,service_role;
revoke all on public.command_unified_stage_projection from anon;

create or replace view public.command_mission_notification_eligibility with (security_invoker=true) as
select c.mission_id,c.command_run_id,c.state_code,
       case when c.executive_display_state='PENDING AUTHORIZATION' then 'ACTION_REQUIRED'
            when c.executive_display_state='FAILED' then 'MISSION_FAILED'
            when c.executive_display_state='COMPLETED WITH WARNINGS' then 'MISSION_COMPLETE_WITH_WARNINGS'
            when c.executive_display_state='COMPLETED' then 'MISSION_COMPLETE'
            when c.action_required then 'ACTION_REQUIRED' else null end notification_type,
       c.executive_display_state,c.action_required
from public.command_mission_execution_contract c;

grant select on public.command_mission_notification_eligibility to authenticated,service_role;
revoke all on public.command_mission_notification_eligibility from anon;

-- command_runs.status remains canonical execution state; authorization_state is governance state only.
-- Registered mission types without an authorized command definition remain representable but non-executable.
-- No scheduler, state orchestration, lifecycle Apply Mode, notification delivery, or NAT-CORP change is activated here.
