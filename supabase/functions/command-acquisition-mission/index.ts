import { corsHeaders, db, json, parseBody, requireDashboardAuth, invoke } from '../_shared/command.ts';

type J=Record<string,unknown>;
const rec=(v:unknown):J=>v&&typeof v==='object'&&!Array.isArray(v)?v as J:{};
const txt=(v:unknown)=>typeof v==='string'?v.trim():v==null?'':String(v);
const upper=(v:unknown)=>txt(v).toUpperCase();
function engineFor(method:string){const m=upper(method);if(m.includes('OCDS'))return'OCDS_ACQUISITION_ENGINE';if(m.includes('API'))return'OFFICIAL_API_ACQUISITION_ENGINE';if(m.includes('BULK'))return'BULK_DATA_ACQUISITION_ENGINE';if(m.includes('OPEN_DATA'))return'OPEN_DATA_ACQUISITION_ENGINE';if(m.includes('FEED'))return'STRUCTURED_FEED_ACQUISITION_ENGINE';if(m.includes('SEARCH'))return'SEARCH_ENDPOINT_ACQUISITION_ENGINE';if(m.includes('PORTAL'))return'PUBLIC_PORTAL_ACQUISITION_ENGINE';if(m.includes('DOCUMENT'))return'DOCUMENT_FEED_ACQUISITION_ENGINE';return'ADAPTIVE_OFFICIAL_SOURCE_ENGINE'}

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  const authError=await requireDashboardAuth(request);if(authError)return authError;
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const body=rec(await parseBody(request));
    const stateCode=upper(body.state_code),agent=txt(body.assigned_agent),publisherId=txt(body.publisher_id);
    if(!stateCode||!agent||!publisherId)return json({error:'State, Publishing Agency, and Agent are required.'},400);
    const publisher=(await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${encodeURIComponent(stateCode)}&select=*`))?.[0];
    if(!publisher)return json({error:'Selected Publishing Agency is not available for the selected state.'},409);
    const endpoint=txt(publisher.search_endpoint)||txt(publisher.procurement_website)||txt(publisher.official_website);
    if(!endpoint)return json({error:'Publishing Agency has no official access endpoint. Run Publisher Discovery to refresh source intelligence.'},409);
    const method=upper(publisher.acquisition_method)||'AUTO_RESOLVE';
    const engine=engineFor(method);
    let assignment=(await db(`publisher_assignments?publisher_id=eq.${encodeURIComponent(publisherId)}&select=*&order=updated_at.desc&limit=1`))?.[0];
    const now=new Date().toISOString();
    const generatedInstructions={
      generated_by:'APIE_AUTOMATED_TASK_CONFIGURATION',
      state_code:stateCode,
      publisher_id:publisherId,
      publisher_name:publisher.publisher_name,
      official_website:publisher.official_website||null,
      procurement_website:publisher.procurement_website||null,
      search_endpoint:endpoint,
      acquisition_method:method,
      acquisition_engine:engine,
      source_authority:'OFFICIAL_PUBLISHER_SOURCE',
      preserve_raw_evidence:true,
      normalize_through_aadp:true,
      duplicate_control:true,
      retain_provenance:true,
      operator_configuration_required:false
    };
    if(!assignment){
      assignment=(await db('publisher_assignments',{method:'POST',body:JSON.stringify({
        publisher_id:publisherId,
        publisher_name:publisher.publisher_name,
        acquisition_method:method,
        search_endpoint:endpoint,
        search_parameters:{automation_mode:'FULLY_AUTOMATED',engine,generated_instructions:generatedInstructions},
        pagination_instructions:{mode:'AUTO_DETECT'},
        attachment_instructions:{mode:'AUTO_DISCOVER_OFFICIAL_DOCUMENTS'},
        amendment_instructions:{mode:'AUTO_RECONCILE'},
        expected_source_identifiers:[],
        qualification_ruleset_version:'AADP-AUTOMATED-V1',
        aoie_review_required:true,
        retry_policy:{max_attempts:3,backoff:'EXPONENTIAL',resume_from_checkpoint:true},
        runtime_limit_seconds:3600,
        reporting_requirements:{actual_records:true,warnings:true,failures:true,evidence:true},
        status:'READY',updated_at:now
      })}))[0];
    }else{
      assignment=(await db(`publisher_assignments?id=eq.${assignment.id}`,{method:'PATCH',body:JSON.stringify({
        publisher_name:publisher.publisher_name,
        acquisition_method:method,
        search_endpoint:endpoint,
        search_parameters:{...(assignment.search_parameters||{}),automation_mode:'FULLY_AUTOMATED',engine,generated_instructions:generatedInstructions},
        status:'READY',updated_at:now
      })}))[0];
    }
    const missionName=txt(body.mission_name)||`${stateCode} — Acquisition Discovery — ${publisher.publisher_name}`;
    const idem=`ecc-acquisition:${stateCode}:${publisherId}:${new Date().toISOString().slice(0,10)}`;
    const execution=rec(await invoke('command-aadp-run',{assignment_id:assignment.id,idempotency_key:idem}));
    const runId=txt(execution.run_id);if(!runId)throw new Error('AADP runtime did not return a command run.');
    const run=(await db(`command_runs?id=eq.${runId}&select=*`))?.[0];if(!run)throw new Error('Authoritative command run was not found.');
    const evidence={...generatedInstructions,source:'EXECUTIVE_COMMAND_CENTER',operator_authorized:true,assignment_id:assignment.id,assignment_generated_automatically:true};
    await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({mission_type_key:'ACQUISITION_DISCOVERY',mission_name:missionName,state_code:stateCode,assigned_agent:agent,last_activity_at:now,execution_evidence:evidence})});
    const mission=(await db('command_missions',{method:'POST',body:JSON.stringify({mission_type_key:'ACQUISITION_DISCOVERY',mission_name:missionName,state_code:stateCode,assigned_agent:agent,authorization_state:'AUTHORIZED',authorization_required:true,authorized_at:now,command_run_id:runId,mission_config:evidence})}))[0];
    await db('command_audit_log',{method:'POST',body:JSON.stringify({entity_type:'MISSION',entity_id:mission.id,action_type:'MISSION_AUTHORIZED',actor_type:'OPERATOR',command_run_id:runId,previous_state:{},new_state:{authorization_state:'AUTHORIZED',publisher_id:publisherId,assignment_id:assignment.id,automation_mode:'FULLY_AUTOMATED'},reason:'Operator selected task, state, and publisher; APIE generated the acquisition configuration automatically.',evidence})});
    return json({mission,run:{...run,mission_type_key:'ACQUISITION_DISCOVERY',mission_name:missionName,state_code:stateCode,assigned_agent:agent},execution,publisher:{id:publisherId,name:publisher.publisher_name,method,endpoint},assignment:{id:assignment.id,status:'READY',generated_automatically:true},engine},202);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},500);}
});
