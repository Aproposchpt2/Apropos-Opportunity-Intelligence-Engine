import { db, response } from './native-runtime.js';

const now=()=>new Date().toISOString();
const text=v=>typeof v==='string'?v.trim():v==null?'':String(v);
const arr=v=>Array.isArray(v)?v:[];
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};

export const DISCOVERY_CONFIG=Object.freeze({
  BUSINESS_DEVELOPMENT_DISCOVERY:{
    label:'Business Development Discovery',registry:'business_development_registry',target:'business-development advisory organizations',
    criteria:'Require a functioning advisory, counseling, accelerator, technical-assistance, or business-growth pathway accessible to APROPOS. Generic directory presence is insufficient.'
  },
  OPPORTUNITY_PARTNER_DISCOVERY:{
    label:'Opportunity Partner Discovery',registry:'opportunity_partner_registry',target:'procurement opportunity access partners',
    criteria:'Identify organizations that can expand procurement opportunity access through contracting, supplier-development, small-business, referral, training, or community programs.'
  },
  INSTITUTIONAL_BUYER_DISCOVERY:{
    label:'Institutional Buyer Discovery',registry:'institutional_buyer_registry',target:'institutional buyers and pilot sponsors',
    criteria:'Identify organizations capable of buying, sponsoring, piloting, licensing, distributing, funding, or strategically supporting APROPOS procurement intelligence.'
  }
});

function outputText(data){
  if(typeof data.output_text==='string')return data.output_text;
  for(const item of arr(data.output))for(const part of arr(obj(item).content)){const p=obj(part);if(p.type==='output_text'&&typeof p.text==='string')return p.text;}
  return'';
}
function parseJson(raw){
  const cleaned=String(raw||'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try{return JSON.parse(cleaned)}catch{const a=cleaned.indexOf('{'),b=cleaned.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(cleaned.slice(a,b+1));throw new Error('Research provider returned invalid JSON.');}
}
async function patchRun(id,body){return db(`command_runs?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({...body,last_activity_at:now()})});}
async function stage(runId,key,name,state,progress,records=0,evidence={}){
  return db('command_stage_projection?on_conflict=command_run_id,stage_key',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({command_run_id:runId,stage_key:key,display_name:name,display_state:state,sequence_number:{OFFICIAL_SOURCE_RESEARCH:1,SOURCE_VALIDATION:2,CANDIDATE_STAGING:3,REGISTRY_PREPARATION:4,MISSION_COMPLETION:5}[key]||99,progress_value:progress,started_at:state==='IN PROGRESS'?now():null,completed_at:['COMPLETED','FAILED','WARNING'].includes(state)?now():null,records_processed:records,warning_count:state==='WARNING'?1:0,failure_count:state==='FAILED'?1:0,retry_count:0,source_projection:'NETLIFY_NATIVE_DISCOVERY',evidence,updated_at:now()})});
}
async function fail(runId,message,evidence={}){
  await patchRun(runId,{status:'failed',aadp_state:'FAILED',current_stage:'FAILED',progress_value:100,failure_count:1,action_required:true,completed_at:now(),result_summary:message,execution_evidence:{runtime:'NETLIFY_NATIVE',...evidence,error:message}});
  return response(500,{error:message});
}

export async function executeResearchDiscovery({event,missionType}){
  const cfg=DISCOVERY_CONFIG[missionType];
  if(!cfg)return response(400,{error:'Unsupported discovery mission type.'});
  const body=event?.body?JSON.parse(event.body):{};
  const runId=text(body.command_run_id),stateCode=text(body.state_code).toUpperCase(),scope=text(body.discovery_scope||'STATEWIDE').toUpperCase();
  if(!runId||!/^[A-Z]{2}$/.test(stateCode))return response(400,{error:'command_run_id and state_code are required.'});
  try{
    const key=Netlify.env.get('OPENAI_API_KEY')||'';
    if(!key)return fail(runId,'Autonomous official-source research provider is not configured.');
    const model=Netlify.env.get('OPENAI_DISCOVERY_MODEL')||'gpt-5.6';
    await patchRun(runId,{status:'running',aadp_state:'RUNNING',current_stage:'OFFICIAL_SOURCE_RESEARCH',progress_value:10,action_required:false});
    await stage(runId,'OFFICIAL_SOURCE_RESEARCH','Official Source Research','IN PROGRESS',10);
    const prompt=`You are the APROPOS autonomous discovery research agent. Mission: ${cfg.label}. State: ${stateCode}. Scope: ${scope}. Research target: ${cfg.target}. ${cfg.criteria} Use official organizational or government sources whenever possible. Do not invent facts. Return up to 12 candidates as ONLY JSON {"candidates":[{"organization_name":"","organization_type":"","official_website":"","relevant_program":"","qualification_summary":"","commercial_fit":"","decision_maker_name":"","decision_maker_title":"","decision_maker_email":"","source_urls":[""],"prospect_score":0}]}`;
    const provider=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,tools:[{type:'web_search',search_context_size:'medium'}],input:prompt})});
    const payload=obj(await provider.json().catch(()=>({})));
    if(!provider.ok)throw new Error(`Official-source research provider failed (${provider.status}): ${text(obj(payload.error).message)||'unknown error'}`);
    const candidates=arr(obj(parseJson(outputText(payload))).candidates).map(obj).filter(x=>text(x.organization_name));
    await stage(runId,'OFFICIAL_SOURCE_RESEARCH','Official Source Research','COMPLETED',25,candidates.length,{model,provider:'openai_responses_web_search'});
    await patchRun(runId,{current_stage:'SOURCE_VALIDATION',progress_value:30,records_discovered:candidates.length});
    await stage(runId,'SOURCE_VALIDATION','Source Validation','IN PROGRESS',30,candidates.length);
    const existing=await db(`${cfg.registry}?state_code=eq.${stateCode}&select=organization_name`);
    const names=new Set((existing||[]).map(x=>text(x.organization_name).toLowerCase()));
    const validated=candidates.map(x=>{const sources=arr(x.source_urls).map(text).filter(Boolean);return{...x,source_urls:sources,source_verified:sources.length>0&&!!text(x.official_website),duplicate_status:names.has(text(x.organization_name).toLowerCase())?'EXISTING_REGISTRY_MATCH':'NO_MATCH'};});
    const verified=validated.filter(x=>x.source_verified).length,duplicates=validated.filter(x=>x.duplicate_status==='EXISTING_REGISTRY_MATCH').length;
    await stage(runId,'SOURCE_VALIDATION','Source Validation','COMPLETED',45,validated.length,{verified,duplicates});
    await patchRun(runId,{current_stage:'CANDIDATE_STAGING',progress_value:50});
    await stage(runId,'CANDIDATE_STAGING','Candidate Staging','IN PROGRESS',50);
    const runRows=await db('command_discovery_runs',{method:'POST',body:JSON.stringify({command_run_id:runId,mission_type_key:missionType,state_code:stateCode,status:'RUNNING',current_stage:'CANDIDATE_STAGING',research_query:`${stateCode} ${cfg.label}`,evidence:{scope,runtime:'NETLIFY_NATIVE'}})});
    const discoveryRun=runRows?.[0];
    let staged=0;
    for(const x of validated){
      await db('command_discovery_candidates',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({discovery_run_id:discoveryRun?.id,mission_type_key:missionType,state_code:stateCode,organization_name:text(x.organization_name),organization_type:text(x.organization_type)||null,official_website:text(x.official_website)||null,relevant_program:text(x.relevant_program)||null,qualification_summary:text(x.qualification_summary)||null,commercial_fit:text(x.commercial_fit)||null,decision_maker_name:text(x.decision_maker_name)||null,decision_maker_title:text(x.decision_maker_title)||null,decision_maker_email:text(x.decision_maker_email)||null,source_urls:x.source_urls,source_verified:x.source_verified,duplicate_status:x.duplicate_status,review_status:x.source_verified?'PENDING_REVIEW':'RESEARCH_REQUIRED',prospect_score:Number(x.prospect_score||0),evidence:{provider:'openai_responses_web_search',model,runtime:'NETLIFY_NATIVE'}})});
      staged++;
    }
    await stage(runId,'CANDIDATE_STAGING','Candidate Staging','COMPLETED',65,staged,{verified,duplicates});
    await patchRun(runId,{current_stage:'REGISTRY_PREPARATION',progress_value:70,records_acquired:staged,records_accepted:verified,records_rejected:Math.max(0,staged-verified)});
    await stage(runId,'REGISTRY_PREPARATION','Registry Preparation','COMPLETED',90,staged,{registry:cfg.registry,candidates_staged:staged,official_sources_verified:verified,duplicate_matches:duplicates});
    const warnings=Math.max(0,staged-verified);
    const summary=`${staged} ${cfg.label.toLowerCase()} candidates staged; ${verified} contain official-source evidence${warnings?`; ${warnings} require further research`:''}.`;
    await stage(runId,'MISSION_COMPLETION','Mission Completion',warnings?'WARNING':'COMPLETED',100,staged,{warnings});
    await patchRun(runId,{status:'completed',aadp_state:warnings?'PARTIALLY_COMPLETE':'COMPLETED',current_stage:'COMPLETED',progress_value:100,warning_count:warnings,failure_count:0,action_required:warnings>0,completed_at:now(),result_summary:summary,execution_evidence:{runtime:'NETLIFY_NATIVE',mission_type_key:missionType,state_code:stateCode,scope,candidates_staged:staged,official_sources_verified:verified,duplicate_matches:duplicates,registry:cfg.registry}});
    if(discoveryRun?.id)await db(`command_discovery_runs?id=eq.${discoveryRun.id}`,{method:'PATCH',body:JSON.stringify({status:warnings?'COMPLETED_WITH_WARNINGS':'COMPLETED',current_stage:'COMPLETED',result_count:staged,completed_at:now(),updated_at:now(),evidence:{candidates_staged:staged,official_sources_verified:verified,duplicate_matches:duplicates,registry:cfg.registry}})});
    return response(200,{ok:true,mission_type_key:missionType,candidates_staged:staged,official_sources_verified:verified,warnings});
  }catch(error){console.error(`${missionType} worker failed`,error);return fail(runId,error instanceof Error?error.message:String(error),{mission_type_key:missionType,state_code:stateCode});}
}
