import { corsHeaders, db, json, parseBody, requireDashboardAuth, invoke } from '../_shared/command.ts';

type J=Record<string,unknown>;
const rec=(v:unknown):J=>v&&typeof v==='object'&&!Array.isArray(v)?v as J:{};
const txt=(v:unknown)=>typeof v==='string'?v.trim():v==null?'':String(v);
const upper=(v:unknown)=>txt(v).toUpperCase();
const TASKS:Record<string,{agent:string,worker?:string}>={
  AADP_PROCESSING:{agent:'AADP Processing',worker:'agent-intelligence-processing'},
  AOIE_ANALYSIS:{agent:'AOIE Analysis',worker:'agent-eligibility-matching'},
  PROCUREMENT_INVENTORY:{agent:'Inventory Control'},
  CONTRACT_LIFECYCLE:{agent:'Contract Lifecycle'}
};

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const body=rec(await parseBody(request)),missionType=upper(body.mission_type_key),stateCode=upper(body.state_code)||null;
    const task=TASKS[missionType];if(!task)return json({error:'Unsupported automated task.'},400);
    const now=new Date().toISOString(),missionName=txt(body.mission_name)||`${stateCode||'Enterprise'} — ${missionType.replaceAll('_',' ')}`;
    const run=(await db('command_runs',{method:'POST',body:JSON.stringify({
      idempotency_key:`ecc-auto:${missionType}:${stateCode||'ALL'}:${crypto.randomUUID()}`,
      status:'running',current_stage:'CONFIGURATION_RESOLVED',aadp_state:'RUNNING',mission_type_key:missionType,
      mission_name:missionName,state_code:stateCode,assigned_agent:task.agent,started_at:now,last_activity_at:now,
      progress_mode:'STAGE',progress_value:10,execution_evidence:{source:'EXECUTIVE_COMMAND_CENTER',automation_mode:'FULLY_AUTOMATED',operator_configuration:body.mission_config||{}}
    })}))[0];
    const mission=(await db('command_missions',{method:'POST',body:JSON.stringify({mission_type_key:missionType,mission_name:missionName,state_code:stateCode,assigned_agent:task.agent,authorization_state:'AUTHORIZED',authorization_required:true,authorized_at:now,command_run_id:run.id,mission_config:{automation_mode:'FULLY_AUTOMATED',operator_configuration:body.mission_config||{}}})}))[0];
    let execution:any={};
    if(task.worker){execution=await invoke(task.worker,{run_id:run.id,job_id:null,state_code:stateCode,scope:body.mission_config||{}})}
    else if(missionType==='PROCUREMENT_INVENTORY'){
      const filter=stateCode?`&state_code=eq.${encodeURIComponent(stateCode)}`:'';
      const rows=await db(`state_contract_opportunities?select=id,status,lifecycle_verification_required,natcorp_contract_dna_status${filter}`);
      execution={records_processed:rows.length,open_records:rows.filter((x:any)=>txt(x.status).toLowerCase()==='open').length,lifecycle_review:rows.filter((x:any)=>x.lifecycle_verification_required).length,contract_dna_complete:rows.filter((x:any)=>txt(x.natcorp_contract_dna_status).toLowerCase()==='complete').length};
    }else{
      const filter=stateCode?`&state_code=eq.${encodeURIComponent(stateCode)}`:'';
      const opportunities=await db(`state_contract_opportunities?select=id,status,response_deadline,lifecycle_verification_required${filter}`);
      const events=await db('contract_lifecycle_events?select=id,evaluated_at&order=evaluated_at.desc&limit=500');
      execution={records_processed:opportunities.length,verification_required:opportunities.filter((x:any)=>x.lifecycle_verification_required).length,recent_lifecycle_events:events.length};
    }
    const completedAt=new Date().toISOString(),records=Number(execution.records_processed||execution.metrics?.documents_processed||0);
    await db(`command_runs?id=eq.${run.id}`,{method:'PATCH',body:JSON.stringify({status:'completed',aadp_state:'COMPLETED',current_stage:'COMPLETED',progress_value:100,records_processed:records,last_activity_at:completedAt,completed_at:completedAt,action_required:false,result_summary:`${missionName} completed. ${records} record(s) processed.`,execution_evidence:{source:'EXECUTIVE_COMMAND_CENTER',automation_mode:'FULLY_AUTOMATED',actual_results:execution}})});
    await db('command_audit_log',{method:'POST',body:JSON.stringify({entity_type:'MISSION',entity_id:mission.id,action_type:'AUTOMATED_TASK_COMPLETED',actor_type:'SYSTEM',command_run_id:run.id,previous_state:{status:'running'},new_state:{status:'completed',records_processed:records},reason:'APIE resolved and executed the task configuration automatically.',evidence:{mission_type:missionType,state_code:stateCode,actual_results:execution}})});
    return json({mission,run:{...run,status:'completed',current_stage:'COMPLETED',progress_value:100,records_processed:records},execution},202);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500)}
});
