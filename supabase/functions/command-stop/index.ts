import { corsHeaders, db, json, parseBody, recordEvent, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async(request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  try{
    const body=await parseBody(request)||{};const runId=String(body.run_id||'').trim();if(!runId)return json({error:'run_id is required'},400);
    const runs=await db(`command_runs?id=eq.${runId}&select=id,status`);if(!runs?.[0])return json({error:'run not found'},404);
    const now=new Date().toISOString();
    await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({status:'stopping',stop_requested_at:now,last_activity_at:now,current_stage:'STOP_REQUESTED'})});
    await db(`command_tasks?run_id=eq.${runId}&state=in.(READY,RETRY_PENDING,ASSIGNED)`,{method:'PATCH',body:JSON.stringify({state:'CANCELLED',completed_at:now,execution_evidence:{cancelled_by:'OPERATOR_STOP',cancelled_at:now}})});
    await db('system_status?singleton=eq.true',{method:'PATCH',body:JSON.stringify({current_execution_state:'stopping',updated_at:now})});
    await recordEvent(runId,null,'OPERATOR_STOP_REQUESTED','Operator requested mission stop',{stop_requested_at:now,pending_tasks_cancelled:true});
    return json({run_id:runId,status:'stopping',pending_tasks_cancelled:true});
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
}));