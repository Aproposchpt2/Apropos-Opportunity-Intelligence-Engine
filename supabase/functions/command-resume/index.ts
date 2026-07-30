import { corsHeaders, db, invoke, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

Deno.serve(async(request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});const authError=await requireDashboardAuth(request);if(authError)return authError;
  try{const body=await parseBody(request)||{},runId=String(body.run_id||'').trim();if(!runId)return json({error:'run_id is required'},400);const run=(await db(`command_runs?id=eq.${runId}&select=*`))[0];if(!run)return json({error:'Run not found'},404);if(!['failed','interrupted','stopped','completed_with_failures','paused'].includes(String(run.status||'').toLowerCase()))return json({error:`Run cannot resume from status ${run.status}`},409);
    await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({status:'running',stop_requested_at:null,completed_at:null,action_required:false,last_activity_at:new Date().toISOString()})});
    const type=String(run.mission_type_key||'').toUpperCase();let result:any;
    if(type==='ACQUISITION_DISCOVERY'||run.publisher_assignment_id)result=await invoke('command-aadp-run',{resume_run_id:runId});
    else if(type==='PUBLISHER_DISCOVERY'){const ds=await db(`publisher_discovery_runs?state_code=eq.${run.state_code}&mission_name=eq.${encodeURIComponent(run.mission_name||'')}&select=*&order=created_at.desc&limit=1`);result=await invoke('command-aadp-publisher-discovery',{state_code:run.state_code,discovery_run_id:ds?.[0]?.id||undefined,discovery_scope:'STATEWIDE_ALL',organization_types:['State Agencies','Counties','Cities / Municipalities','Universities','Community Colleges','School Districts','Transportation Authorities','Public Utilities','Water Districts','Special Districts','Public Authorities','Independent Agencies','Other Public Procurement Publishers'],mission_name:run.mission_name,command_run_id:runId,autonomous_research:true,action:'START'});}
    else if(['BUSINESS_DEVELOPMENT_DISCOVERY','OPPORTUNITY_PARTNER_DISCOVERY','INSTITUTIONAL_BUYER_DISCOVERY'].includes(type))result=await invoke('command-research-discovery',{command_run_id:runId,mission_type_key:type,mission_name:run.mission_name,state_code:run.state_code,assigned_agent:run.assigned_agent});
    else result=await invoke('command-begin-daily-operations',{operation_date:String(run.idempotency_key||'').replace('daily:',''),resume_run_id:runId});
    return json(result,202);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
}));