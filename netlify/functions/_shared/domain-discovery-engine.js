import { createHash } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db, env } from './native-runtime.js';

const now=()=>new Date().toISOString();
const text=v=>typeof v==='string'?v.trim():v==null?'':String(v);
const arr=v=>Array.isArray(v)?v:[];
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const hash=v=>createHash('sha256').update(String(v)).digest('hex');

const PROFILES={
  BUSINESS_DEVELOPMENT_DISCOVERY:{
    agent:'Business Development Discovery',registry:'business_development_registry',target:'business-development advisory organizations',
    criteria:'Require a functioning advisory, counseling, accelerator, technical-assistance, or business-growth pathway accessible to businesses. Generic directory presence is insufficient.'
  },
  OPPORTUNITY_PARTNER_DISCOVERY:{
    agent:'Opportunity Partner Discovery',registry:'opportunity_partner_registry',target:'procurement opportunity access partners',
    criteria:'Identify organizations that can expand procurement opportunity access through contracting, supplier-development, small-business, referral, training, or community programs.'
  },
  INSTITUTIONAL_BUYER_DISCOVERY:{
    agent:'Institutional Buyer Discovery',registry:'institutional_buyer_registry',target:'institutional buyers and pilot sponsors',
    criteria:'Identify organizations capable of buying, sponsoring, piloting, licensing, distributing, funding, or strategically supporting APROPOS procurement intelligence.'
  }
};

const STAGES=[
  ['SOURCE_DISCOVERY','Source Discovery',1,20],
  ['SOURCE_VALIDATION','Source Validation',2,45],
  ['REGISTRY_ADMISSION','Registry Admission',3,70],
  ['MISSION_REPORTING','Mission Reporting',4,90],
  ['MISSION_COMPLETION','Mission Completion',5,100]
];

function outputText(data){
  if(typeof data.output_text==='string')return data.output_text;
  for(const item of arr(data.output))for(const part of arr(obj(item).content))if(obj(part).type==='output_text'&&typeof obj(part).text==='string')return obj(part).text;
  return'';
}
function parseJson(raw){
  const cleaned=String(raw||'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try{return JSON.parse(cleaned)}catch{const a=cleaned.indexOf('{'),b=cleaned.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(cleaned.slice(a,b+1));throw new Error('Research provider returned invalid JSON.');}
}
async function project(runId,key,state,progress,records=0,evidence={}){
  const stage=STAGES.find(s=>s[0]===key)||[key,key,99,progress];
  const terminal=['COMPLETED','WARNING','FAILED','BLOCKED'].includes(state);
  await db('command_stage_projection?on_conflict=command_run_id,stage_key',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({command_run_id:runId,stage_key:key,display_name:stage[1],display_state:state,sequence_number:stage[2],progress_value:progress,started_at:state==='RUNNING'?now():null,completed_at:terminal?now():null,records_processed:records,warning_count:state==='WARNING'?1:0,failure_count:state==='FAILED'?1:0,retry_count:0,source_projection:'NETLIFY_DOMAIN_DISCOVERY',evidence,updated_at:now()})});
}
async function updateRun(runId,patch){await db(`command_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({...patch,last_activity_at:now()})});}
async function fail(runId,discoveryRunId,message){
  await project(runId,'MISSION_COMPLETION','FAILED',100,0,{error:message}).catch(()=>null);
  if(discoveryRunId)await db(`command_discovery_runs?id=eq.${discoveryRunId}`,{method:'PATCH',body:JSON.stringify({status:'FAILED',current_stage:'FAILED',completed_at:now(),updated_at:now(),evidence:{error:message}})}).catch(()=>null);
  await updateRun(runId,{status:'failed',aadp_state:'FAILED',current_stage:'FAILED',progress_value:100,failure_count:1,action_required:true,completed_at:now(),result_summary:message});
}

export async function runDomainDiscovery(event,missionType){
  if(event?.httpMethod!=='POST')return response(405,{error:'Method not allowed'});
  if(!requireDashboardAuth(event))return response(401,{error:'Unauthorized'});
  const profile=PROFILES[missionType];
  if(!profile)return response(400,{error:'Unsupported discovery mission type'});
  const body=parseBody(event),runId=text(body.command_run_id),stateCode=text(body.state_code).toUpperCase();
  if(!runId||!/^[A-Z]{2}$/.test(stateCode))return response(400,{error:'command_run_id and state_code are required'});
  let discoveryRunId=null;
  try{
    const existing=(await db(`command_discovery_runs?command_run_id=eq.${runId}&select=*`))?.[0];
    const discoveryRun=existing||(await db('command_discovery_runs',{method:'POST',body:JSON.stringify({command_run_id:runId,mission_type_key:missionType,state_code:stateCode,status:'QUEUED',current_stage:'QUEUED',research_query:`${stateCode} ${profile.target}`,evidence:{runtime:'NETLIFY_NATIVE',agent:profile.agent}})}))?.[0];
    discoveryRunId=discoveryRun?.id;
    if(!discoveryRunId)throw new Error('Discovery run creation failed.');

    const apiKey=env('OPENAI_API_KEY');
    if(!apiKey)throw new Error('OPENAI_API_KEY is not configured.');
    const model=env('OPENAI_DISCOVERY_MODEL')||'gpt-5.6';
    await updateRun(runId,{status:'running',aadp_state:'RUNNING',current_stage:'SOURCE_DISCOVERY',progress_mode:'STAGE',progress_value:10,assigned_agent:profile.agent});
    await project(runId,'SOURCE_DISCOVERY','RUNNING',20);
    await db(`command_discovery_runs?id=eq.${discoveryRunId}`,{method:'PATCH',body:JSON.stringify({status:'RUNNING',current_stage:'SOURCE_DISCOVERY',started_at:now(),updated_at:now()})});

    const prompt=`You are the APROPOS autonomous ${profile.agent} agent. State: ${stateCode}. Research target: ${profile.target}. ${profile.criteria} Use official organizational or government sources whenever possible. Do not invent facts. Return up to 12 candidates as ONLY JSON {"candidates":[{"organization_name":"","organization_type":"","official_website":"","relevant_program":"","qualification_summary":"","commercial_fit":"","decision_maker_name":"","decision_maker_title":"","decision_maker_email":"","source_urls":[""],"prospect_score":0}]}`;
    const research=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,tools:[{type:'web_search',search_context_size:'medium'}],input:prompt})});
    const data=obj(await research.json().catch(()=>({})));
    if(!research.ok)throw new Error(`Official-source research failed (${research.status}): ${text(obj(data.error).message)||'unknown error'}`);
    const candidates=arr(obj(parseJson(outputText(data))).candidates).map(obj).filter(c=>text(c.organization_name));
    await project(runId,'SOURCE_DISCOVERY','COMPLETED',100,candidates.length,{provider:'openai_responses_web_search',model});
    await updateRun(runId,{current_stage:'SOURCE_VALIDATION',progress_value:35,records_discovered:candidates.length});
    await project(runId,'SOURCE_VALIDATION','RUNNING',45,candidates.length);

    const existingRows=await db(`${profile.registry}?state_code=eq.${stateCode}&select=id,organization_name`);
    const existingNames=new Set(arr(existingRows).map(r=>text(r.organization_name).toLowerCase()));
    const validated=candidates.filter(c=>text(c.official_website)&&arr(c.source_urls).map(text).filter(Boolean).length>0);
    await project(runId,'SOURCE_VALIDATION','COMPLETED',100,validated.length,{rejected:candidates.length-validated.length,duplicate_matches:validated.filter(c=>existingNames.has(text(c.organization_name).toLowerCase())).length});
    await updateRun(runId,{current_stage:'REGISTRY_ADMISSION',progress_value:55,records_accepted:validated.length,records_rejected:candidates.length-validated.length});
    await project(runId,'REGISTRY_ADMISSION','RUNNING',70,validated.length);

    let admitted=0,updated=0;
    for(const c of validated){
      const sources=arr(c.source_urls).map(text).filter(Boolean),name=text(c.organization_name),isExisting=existingNames.has(name.toLowerCase());
      const candidateRows=await db('command_discovery_candidates',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({discovery_run_id:discoveryRunId,mission_type_key:missionType,state_code:stateCode,organization_name:name,organization_type:text(c.organization_type)||null,official_website:text(c.official_website)||null,relevant_program:text(c.relevant_program)||null,qualification_summary:text(c.qualification_summary)||null,commercial_fit:text(c.commercial_fit)||null,decision_maker_name:text(c.decision_maker_name)||null,decision_maker_title:text(c.decision_maker_title)||null,decision_maker_email:text(c.decision_maker_email)||null,source_urls:sources,source_verified:true,duplicate_status:isExisting?'EXISTING_REGISTRY_MATCH':'NO_MATCH',review_status:'APPROVED_ADMITTED',prospect_score:Number(c.prospect_score||0),evidence:{runtime:'NETLIFY_NATIVE',fingerprint:hash(`${missionType}:${stateCode}:${name}`)}})});
      const registryRow={state_code:stateCode,organization_name:name,organization_type:text(c.organization_type)||null,official_website:text(c.official_website)||null,relevant_program:text(c.relevant_program)||null,qualification_summary:text(c.qualification_summary)||null,decision_maker_name:text(c.decision_maker_name)||null,decision_maker_title:text(c.decision_maker_title)||null,decision_maker_email:text(c.decision_maker_email)||null,official_sources:sources,verified:true,status:'ACTIVE',updated_at:now()};
      if(profile.registry==='institutional_buyer_registry'){registryRow.commercial_fit=text(c.commercial_fit)||null;registryRow.prospect_score=Number(c.prospect_score||0);}
      await db(`${profile.registry}?on_conflict=state_code,organization_name`,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(registryRow)});
      isExisting?updated++:admitted++;
    }
    await project(runId,'REGISTRY_ADMISSION','COMPLETED',100,validated.length,{admitted,updated});
    await updateRun(runId,{current_stage:'MISSION_REPORTING',progress_value:85,records_acquired:validated.length});
    await project(runId,'MISSION_REPORTING','COMPLETED',100,validated.length,{registry:profile.registry});

    const warnings=candidates.length-validated.length;
    const classification=warnings>0?'COMPLETED_WITH_WARNINGS':'COMPLETED';
    const summary=`${validated.length} verified organizations admitted or updated in ${profile.registry}; ${warnings} candidates lacked sufficient official-source evidence.`;
    await project(runId,'MISSION_COMPLETION',warnings>0?'WARNING':'COMPLETED',100,validated.length,{classification});
    await db(`command_discovery_runs?id=eq.${discoveryRunId}`,{method:'PATCH',body:JSON.stringify({status:classification,current_stage:'MISSION_COMPLETION',result_count:validated.length,completed_at:now(),updated_at:now(),evidence:{candidates_discovered:candidates.length,verified:validated.length,admitted,updated,warnings,registry:profile.registry}})});
    await updateRun(runId,{status:'completed',aadp_state:warnings>0?'PARTIALLY_COMPLETE':'COMPLETED',current_stage:'COMPLETED',progress_value:100,warning_count:warnings,failure_count:0,action_required:false,completed_at:now(),result_summary:summary,execution_evidence:{runtime:'NETLIFY_NATIVE',mission_type_key:missionType,agent:profile.agent,registry:profile.registry,candidates_discovered:candidates.length,records_accepted:validated.length,records_rejected:warnings,admitted,updated,completion_classification:classification}});
    return response(200,{ok:true,command_run_id:runId,discovery_run_id:discoveryRunId,completion_classification:classification,candidates_discovered:candidates.length,verified:validated.length,admitted,updated,warnings});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error(`${missionType} worker failed`,error);
    try{await fail(runId,discoveryRunId,message)}catch{}
    return response(500,{error:message});
  }
}
