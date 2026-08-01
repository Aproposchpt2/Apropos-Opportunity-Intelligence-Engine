import { corsHeaders, db, json, parseBody, requireDashboardAuth, invoke } from '../_shared/command.ts';

type J=Record<string,unknown>;
const rec=(v:unknown):J=>v&&typeof v==='object'&&!Array.isArray(v)?v as J:{};
const txt=(v:unknown)=>typeof v==='string'?v.trim():v==null?'':String(v);

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const body=rec(await parseBody(request));
    const stateCode=txt(body.state_code).toUpperCase(),agent=txt(body.assigned_agent),publisherId=txt(body.publisher_id),assignmentId=txt(body.assignment_id);
    if(!stateCode||!agent||!publisherId||!assignmentId)return json({error:'State, Publishing Agency, READY assignment, and Agent are required.'},400);
    const publisher=(await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${encodeURIComponent(stateCode)}&verified=eq.true&access_status=eq.APPROVED_FOR_REGISTRY&select=*`))?.[0];
    if(!publisher)return json({error:'Selected Publishing Agency is not an approved verified publisher for the selected state.'},409);
    const assignment=(await db(`publisher_assignments?id=eq.${encodeURIComponent(assignmentId)}&publisher_id=eq.${encodeURIComponent(publisherId)}&status=eq.READY&select=*`))?.[0];
    if(!assignment)return json({error:'Selected Publishing Agency does not have the selected READY acquisition assignment.'},409);
    const missionName=txt(body.mission_name)||`${stateCode} — Acquisition Discovery — ${publisher.publisher_name}`;
    const idem=`ecc-acquisition:${stateCode}:${publisherId}:${assignmentId}:${new Date().toISOString().slice(0,10)}`;
    const execution=rec(await invoke('command-aadp-run',{assignment_id:assignmentId,idempotency_key:idem}));
    const runId=txt(execution.run_id);if(!runId)throw new Error('AADP runtime did not return a command run.');
    const run=(await db(`command_runs?id=eq.${runId}&select=*`))?.[0];if(!run)throw new Error('Authoritative command run was not found.');
    const now=new Date().toISOString(),evidence={source:'EXECUTIVE_COMMAND_CENTER',operator_authorized:true,state_code:stateCode,publisher_id:publisherId,publisher_name:publisher.publisher_name,assignment_id:assignmentId,assignment_status:'READY',publisher_bound:true};
    await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({mission_type_key:'ACQUISITION_DISCOVERY',mission_name:missionName,state_code:stateCode,assigned_agent:agent,last_activity_at:now,execution_evidence:evidence})});
    const mission=(await db('command_missions',{method:'POST',body:JSON.stringify({mission_type_key:'ACQUISITION_DISCOVERY',mission_name:missionName,state_code:stateCode,assigned_agent:agent,authorization_state:'AUTHORIZED',authorization_required:true,authorized_at:now,command_run_id:runId,mission_config:evidence})}))[0];
    await db('command_audit_log',{method:'POST',body:JSON.stringify({entity_type:'MISSION',entity_id:mission.id,action_type:'MISSION_AUTHORIZED',actor_type:'OPERATOR',command_run_id:runId,previous_state:{},new_state:{authorization_state:'AUTHORIZED',publisher_id:publisherId,assignment_id:assignmentId},reason:'Operator authorized publisher-specific Acquisition Discovery',evidence})});
    return json({mission,run:{...run,mission_type_key:'ACQUISITION_DISCOVERY',mission_name:missionName,state_code:stateCode,assigned_agent:agent},execution,publisher:{id:publisherId,name:publisher.publisher_name},assignment:{id:assignmentId,status:'READY'}},202);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
});
