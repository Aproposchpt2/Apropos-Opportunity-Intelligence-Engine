import { corsHeaders, db, json, parseBody, recordEvent, requireDashboardAuth, requireServiceRole } from '../_shared/command.ts';
import { createTaskGraph, runAadpTask, validateAssignment } from '../_shared/aadp.ts';

type JsonRecord = Record<string, unknown>;
const asRecord=(v:unknown):JsonRecord=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonRecord:{};
const text=(v:unknown):string=>typeof v==='string'?v.trim():v==null?'':String(v);

async function authorize(request:Request){const serviceError=requireServiceRole(request);if(!serviceError)return null;return await requireDashboardAuth(request);}

async function refreshStageProjection(runId:string,assignment:JsonRecord){
  const tasks=await db(`command_tasks?run_id=eq.${runId}&select=*&order=created_at.asc`);
  const acquisitionRuns=await db(`acquisition_runs?command_run_id=eq.${runId}&select=id&order=created_at.desc&limit=1`);
  const acquisitionRunId=acquisitionRuns?.[0]?.id??null;
  const stageMap:Record<string,string>={PUBLISHER_ASSIGNMENT_CREATE:'PUBLISHER ASSIGNMENT',ACQUISITION_RUN_START:'ACQUISITION START',ACQUISITION_PAGE_FETCH:'RECORD RETRIEVAL',ACQUISITION_RECORD_STORE:'RAW STORAGE',ACQUISITION_RUN_CLOSE:'ACQUISITION CLOSE',RECORD_NORMALIZATION:'POSTGRESQL PROCESSING',RECORD_DEDUPLICATION:'VERSION AND DUPLICATE CONTROL',RECORD_QUALIFICATION:'CONTRACT QUALIFICATION',QUALIFIED_RECORD_UPSERT:'NEW CONTRACT APPROVED TO ADD',REJECTION_RECORD_CREATE:'TERMINAL DISPOSITIONS',RUN_RECONCILIATION:'RECONCILIATION',PROCUREMENT_LANGUAGE_ANALYSIS:'CONTRACT ANALYSIS',AOIE_BATCH_REVIEW:'AOIE REVIEW',MATCHING_RECOMMENDATION_CREATE:'CHANGE OR NO CHANGE',MATCHING_RECOMMENDATION_TEST:'RECOMMENDATION TESTING',EXECUTIVE_REPORT_CREATE:'EXECUTIVE REPORT'};
  for(const task of tasks){
    const displayState=task.state==='COMPLETED'?'COMPLETED':task.state==='RUNNING'?'IN PROGRESS':['READY','ASSIGNED'].includes(task.state)?'QUEUED':task.state==='RETRY_PENDING'?'ACTION NEEDED':['ESCALATED','FAILED'].includes(task.state)?'FAILED':task.state==='CANCELLED'?'CANCELLED':'NOT STARTED';
    const attempts=Number(task.output_payload?.attempt_count??0),warnings=task.state==='RETRY_PENDING'?1:0,failures=['FAILED','ESCALATED'].includes(task.state)?1:0;
    const records=Number(Object.values(asRecord(task.measurable_result)).find(v=>typeof v==='number')??0);
    await db('aadp_process_stage_projection',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({command_run_id:runId,acquisition_run_id:acquisitionRunId,publisher_id:assignment.publisher_id,publisher_name:assignment.publisher_name,stage_key:task.task_type,display_name:stageMap[task.task_type]??String(task.task_type).replaceAll('_',' '),display_state:displayState,started_at:task.started_at,completed_at:task.completed_at,records_processed:records,warning_count:warnings,failure_count:failures,retry_count:Math.max(0,attempts-1),evidence:{task_id:task.id,measurable_result:task.measurable_result,execution_evidence:task.execution_evidence},updated_at:new Date().toISOString()})});
  }
}
async function semanticValidation(runId:string){const r=await db('rpc/aadp_validate_semantic_completion',{method:'POST',body:JSON.stringify({p_command_run_id:runId})});return Array.isArray(r)?r[0]:r;}
async function isStopRequested(runId:string){const rows=await db(`command_runs?id=eq.${runId}&select=status,stop_requested_at`);const r=rows?.[0];return Boolean(r?.stop_requested_at)||String(r?.status||'').toLowerCase()==='stopping';}
async function cancelPendingTasks(runId:string){const now=new Date().toISOString();await db(`command_tasks?run_id=eq.${runId}&state=in.(READY,RETRY_PENDING,ASSIGNED)`,{method:'PATCH',body:JSON.stringify({state:'CANCELLED',completed_at:now,execution_evidence:{cancelled_by:'OPERATOR_STOP',cancelled_at:now}})});}
async function finalizeStopped(runId:string,assignment:JsonRecord){const now=new Date().toISOString();await cancelPendingTasks(runId);await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({status:'stopped',aadp_state:'PAUSED',current_stage:'STOPPED_BY_OPERATOR',completed_at:now,last_activity_at:now,action_required:false,result_summary:'Stopped by operator request.'})});await refreshStageProjection(runId,assignment);await recordEvent(runId,null,'AADP_RUN_STOPPED','AADP run stopped by operator request',{stop_propagated:true});}

async function executeRun(runId:string,assignment:JsonRecord){
  let terminalFailure=false,safetyCounter=0;
  await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({status:'running',aadp_state:'RUNNING',last_activity_at:new Date().toISOString()})});
  while(safetyCounter<100){
    safetyCounter++;
    if(await isStopRequested(runId)){await finalizeStopped(runId,assignment);return;}
    const ready=await db(`command_tasks?run_id=eq.${runId}&state=in.(READY,RETRY_PENDING)&select=*&order=created_at.asc&limit=1`);
    if(!ready.length)break;
    const task=ready[0];
    if(task.state==='RETRY_PENDING'&&task.scheduled_for&&new Date(task.scheduled_for).getTime()>Date.now()){await new Promise(r=>setTimeout(r,Math.min(1000,new Date(task.scheduled_for).getTime()-Date.now())));continue;}
    if(await isStopRequested(runId)){await finalizeStopped(runId,assignment);return;}
    await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({current_stage:task.task_type,last_activity_at:new Date().toISOString()})});
    const outcome=await runAadpTask(runId,task,assignment);
    await refreshStageProjection(runId,assignment);
    if(await isStopRequested(runId)){await finalizeStopped(runId,assignment);return;}
    if(!outcome.ok&&!outcome.retry){terminalFailure=true;break;}
  }
  const remaining=await db(`command_tasks?run_id=eq.${runId}&state=not.in.(COMPLETED,CANCELLED)&select=id,state,task_type`);
  let semantic:JsonRecord={};if(!terminalFailure&&remaining.length===0)semantic=asRecord(await semanticValidation(runId));
  const complete=semantic.valid===true,finalAadpState=terminalFailure?'ESCALATED':complete?'COMPLETED':remaining.length?'PARTIALLY_COMPLETE':'PAUSED',finalStatus=terminalFailure?'failed':complete?'completed':'completed_with_failures';
  await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({aadp_state:finalAadpState,status:finalStatus,completed_at:complete||terminalFailure?new Date().toISOString():null,current_stage:null,last_activity_at:new Date().toISOString(),action_required:terminalFailure||(!complete&&remaining.length>0),execution_evidence:{assignment_id:assignment.id,architecture:'AADP-OS-V1.2-STOP-AWARE',remaining_tasks:remaining,semantic_completion:semantic}})});
  await refreshStageProjection(runId,assignment);await recordEvent(runId,null,complete?'AADP_RUN_SEMANTICALLY_COMPLETE':terminalFailure?'AADP_RUN_FAILED':'AADP_RUN_ACTION_NEEDED',`AADP run finished as ${finalAadpState}`,{remaining_tasks:remaining.length,semantic_completion:semantic});
}

Deno.serve(async(request:Request)=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await authorize(request);if(authError)return authError;
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const body=asRecord(await parseBody(request));const resumeRunId=text(body.resume_run_id);let run:JsonRecord,assignment:JsonRecord;
    if(resumeRunId){
      const runs=await db(`command_runs?id=eq.${resumeRunId}&select=*`);run=runs?.[0];if(!run)return json({error:'Command run not found'},404);
      const assignments=await db(`publisher_assignments?id=eq.${run.publisher_assignment_id}&select=*`);assignment=assignments?.[0];if(!assignment)return json({error:'Publisher assignment not found'},404);validateAssignment(assignment as any);
      const interrupted=await db(`command_tasks?run_id=eq.${resumeRunId}&state=in.(RETRY_PENDING,ESCALATED,FAILED,READY,CANCELLED)&select=*&order=created_at.asc&limit=1`);const resumeStage=interrupted?.[0]?.task_type??null;
      if(interrupted?.[0]&&['ESCALATED','FAILED','CANCELLED'].includes(interrupted[0].state))await db(`command_tasks?id=eq.${interrupted[0].id}`,{method:'PATCH',body:JSON.stringify({state:'RETRY_PENDING',scheduled_for:new Date().toISOString(),completed_at:null})});
      await db(`command_runs?id=eq.${resumeRunId}`,{method:'PATCH',body:JSON.stringify({aadp_state:'RUNNING',status:'running',stop_requested_at:null,resume_source_stage:resumeStage,resumed_at:new Date().toISOString(),completed_at:null,action_required:false})});await recordEvent(resumeRunId,null,'AADP_RUN_RESUMED','AADP publisher run resumed from last unresolved stage',{resume_source_stage:resumeStage});
    }else{
      const assignmentId=text(body.assignment_id);if(!assignmentId)return json({error:'assignment_id is required'},400);
      const assignments=await db(`publisher_assignments?id=eq.${assignmentId}&select=*`);assignment=assignments?.[0];if(!assignment)return json({error:'Publisher assignment not found'},404);validateAssignment(assignment as any);
      const idempotencyKey=text(body.idempotency_key)||`aadp:${assignmentId}:${new Date().toISOString().slice(0,10)}`;const existing=await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`);if(existing.length)return json({run_id:existing[0].id,status:existing[0].aadp_state,idempotent_replay:true},202);
      const definitions=await db('command_definitions?command_key=eq.AADP_PUBLISHER_ACQUISITION&select=id&order=updated_at.desc&limit=1');const created=await db('command_runs',{method:'POST',body:JSON.stringify({idempotency_key:idempotencyKey,definition_id:definitions?.[0]?.id??null,publisher_assignment_id:assignmentId,status:'queued',aadp_state:'QUEUED',current_stage:'PUBLISHER_ASSIGNMENT_CREATE',last_activity_at:new Date().toISOString(),progress_mode:'STAGE',progress_value:0,execution_evidence:{assignment_id:assignmentId,architecture:'AADP-OS-V1.2-STOP-AWARE',asynchronous_submission:true}})});run=created[0];const tasks=await createTaskGraph(run.id as string);await recordEvent(run.id as string,null,'AADP_RUN_SUBMITTED','AADP publisher acquisition run submitted',{assignment_id:assignmentId,task_count:tasks.length});
    }
    EdgeRuntime.waitUntil(executeRun(run.id as string,assignment));return json({run_id:run.id,status:'QUEUED',asynchronous:true,poll:`command_runs?id=eq.${run.id}`},202);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
});