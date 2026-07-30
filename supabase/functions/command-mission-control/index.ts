import { corsHeaders, db, json, parseBody, requireDashboardAuth, invoke } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError=await requireDashboardAuth(request); if(authError)return authError;
  try{
    const body=await parseBody(request) || {};
    const missionType=String(body.mission_type_key||'').trim().toUpperCase();
    const missionName=String(body.mission_name||'').trim();
    const agent=String(body.assigned_agent||'').trim();
    const stateCode=String(body.state_code||'').trim().toUpperCase()||null;
    if(!missionType||!missionName||!agent)return json({error:'Mission Type, Mission Name, and Agent are required.'},400);
    const types=await db(`command_mission_types?mission_type_key=eq.${encodeURIComponent(missionType)}&enabled=eq.true&select=*`);
    const type=types?.[0]; if(!type)return json({error:'Mission type is not enabled.'},400);
    if(type.state_context_required && !stateCode)return json({error:'This mission type requires state context.'},400);
    const runtimeSupported=['PUBLISHER_DISCOVERY'].includes(missionType);
    if(!runtimeSupported)return json({error:`${type.display_name} governance exists, but an autonomous runtime adapter is not yet deployed. No false mission was launched.`,code:'RUNTIME_ADAPTER_REQUIRED'},409);
    const mission=(await db('command_missions',{method:'POST',body:JSON.stringify({mission_type_key:missionType,mission_name:missionName,state_code:stateCode,assigned_agent:agent,authorization_state:'AUTHORIZED',authorization_required:true,authorized_at:new Date().toISOString(),mission_config:{source:'EXECUTIVE_COMMAND_CENTER',defaults_resolved:true}})}))[0];
    let execution:any=null;
    if(missionType==='PUBLISHER_DISCOVERY'){
      execution=await invoke('command-aadp-publisher-discovery',{state_code:stateCode,mission_name:missionName,discovery_scope:'STATEWIDE_ALL',organization_types:['State Agencies','Counties','Cities / Municipalities','Universities','Community Colleges','School Districts','Transportation Authorities','Public Utilities','Water Districts','Special Districts','Public Authorities','Independent Agencies','Other Public Procurement Publishers'],provider:'system_default',operator:'Executive Command Center',notes:'Authorized through simplified Executive Mission Control.'});
    }
    await db('command_audit_log',{method:'POST',body:JSON.stringify({entity_type:'MISSION',entity_id:mission.id,action_type:'MISSION_AUTHORIZED',actor_type:'OPERATOR',previous_state:{},new_state:{authorization_state:'AUTHORIZED',execution},reason:'Operator authorized mission from Executive Command Center',evidence:{mission_type:missionType,state_code:stateCode}})});
    return json({mission,execution},202);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500)}
});
