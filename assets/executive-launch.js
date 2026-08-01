const TASKS={
  PUBLISHER_DISCOVERY:{agent:'Publisher Discovery',state:'required',field:{id:'discovery_scope',label:'Discovery Scope',type:'select',options:[['STATEWIDE','Statewide publishers'],['STATE_AND_LOCAL','State and local publishers'],['REFRESH','Refresh existing publisher intelligence']]},operation:'command-mission-control'},
  ACQUISITION_DISCOVERY:{agent:'Acquisition Operations',state:'required',publisher:true,operation:'command-acquisition-mission'},
  STATE_MISSION:{agent:'State Operations',state:'required',field:{id:'state_operation',label:'Operation',type:'select',options:[['EVALUATE_READINESS','Evaluate operational state'],['RECONCILE_CAPABILITIES','Reconcile capabilities'],['REFRESH_STATE_INTELLIGENCE','Refresh state intelligence']]},operation:'command-mission-control'},
  AADP_PROCESSING:{agent:'AADP Processing',state:'optional',field:{id:'processing_scope',label:'Processing Scope',type:'select',options:[['UNPROCESSED','Unprocessed acquisition records'],['FAILED_RETRYABLE','Retryable failures'],['RECENT','Recently acquired records'],['ALL_PENDING','All pending records']]},operation:'command-automated-task'},
  AOIE_ANALYSIS:{agent:'AOIE Analysis',state:'optional',field:{id:'analysis_scope',label:'Analysis Scope',type:'select',options:[['NEWLY_QUALIFIED','Newly qualified opportunities'],['UNANALYZED','Unanalyzed opportunities'],['REFRESH','Refresh existing analysis']]},operation:'command-automated-task'},
  PROCUREMENT_INVENTORY:{agent:'Inventory Control',state:'optional',field:{id:'inventory_operation',label:'Operation',type:'select',options:[['VALIDATE_ACTIVE','Validate active opportunities'],['RECONCILE_DUPLICATES','Reconcile duplicates'],['VERIFY_PROVENANCE','Verify provenance'],['REFRESH_PRESENTATION','Refresh presentation eligibility']]},operation:'command-automated-task'},
  CONTRACT_LIFECYCLE:{agent:'Contract Lifecycle',state:'optional',field:{id:'lifecycle_operation',label:'Operation',type:'select',options:[['RECONCILE','Reconcile deadlines and status'],['VERIFY_EXPIRED','Verify expired opportunities'],['CHECK_AMENDMENTS','Check amendments'],['REFRESH_ALL','Refresh lifecycle state']]},operation:'command-automated-task'},
  BUSINESS_DEVELOPMENT_DISCOVERY:{agent:'Business Development Discovery',state:'required',operation:'command-mission-control'},
  OPPORTUNITY_PARTNER_DISCOVERY:{agent:'Opportunity Partner Discovery',state:'required',operation:'command-mission-control'},
  INSTITUTIONAL_BUYER_DISCOVERY:{agent:'Institutional Buyer Discovery',state:'required',operation:'command-mission-control'}
};
const taskEl=()=>document.getElementById('eccMissionType');
const stateEl=()=>document.getElementById('eccMissionState');
const configEl=()=>document.getElementById('eccTaskConfiguration');
const escAttr=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function selectedText(el){return el?.selectedOptions?.[0]?.textContent?.trim()||''}
function setAgent(agent=''){document.getElementById('eccAgent').value=agent;document.getElementById('eccAgentDisplay').value=agent||'Select a task'}
function renderField(field){if(!field)return'';if(field.type==='select')return `<label>${escAttr(field.label)}<select id="eccDynamicField" data-key="${escAttr(field.id)}" required><option value="">Select ${escAttr(field.label.toLowerCase())}</option>${field.options.map(([v,l])=>`<option value="${escAttr(v)}">${escAttr(l)}</option>`).join('')}</select></label>`;return''}
async function renderPublisherSelector(){
  const state=stateEl().value;
  if(!state||state==='ALL'){
    configEl().innerHTML='<label>Publisher<select id="eccPublisher"><option value="ALL" selected>ALL</option></select><small>Select a specific state to load individual publishers.</small></label>';
    return;
  }
  configEl().innerHTML='<label>Publisher<select id="eccPublisher" disabled><option value="ALL" selected>ALL</option></select><small>Loading publishers…</small></label>';
  try{
    const d=await invoke('command-publisher-options',{state_code:state});
    const rows=d.publishers||[];
    configEl().innerHTML=`<label>Publisher<select id="eccPublisher"><option value="ALL" selected>ALL</option>${rows.map(p=>`<option value="${escAttr(p.publisher_id)}" data-method="${escAttr(p.acquisition_method||'AUTO')}" data-endpoint="${escAttr(p.search_endpoint||'')}" data-platform="${escAttr(p.platform||'')}">${escAttr(p.publisher_name)} — ${escAttr(p.acquisition_method||'AUTO')}</option>`).join('')}</select><small>ALL is the default. Select one publisher only when narrower execution is required.</small></label>`;
  }catch(err){configEl().innerHTML=`<label>Publisher<select id="eccPublisher"><option value="ALL" selected>ALL</option></select><small>${escAttr(err.message)}</small></label>`}
}
async function configureTask(){
  const task=TASKS[taskEl().value];setAgent(task?.agent||'');configEl().innerHTML='';
  stateEl().required=Boolean(task&&task.state==='required');
  const all=stateEl().querySelector('option[value="ALL"]');if(all)all.disabled=Boolean(task&&task.state==='required');
  if(!task)return;
  if(task.publisher)await renderPublisherSelector();else configEl().innerHTML=renderField(task.field)
}
function buildConfiguration(){
  const cfg={automation_mode:'FULLY_AUTOMATED',operator_controls:['TASK','STATE','TARGET','EXECUTE'],manual_onboarding:false,manual_assignment:false,manual_connector_configuration:false};
  const dynamic=document.getElementById('eccDynamicField');if(dynamic)cfg[dynamic.dataset.key]=dynamic.value;
  const publisher=document.getElementById('eccPublisher');
  if(publisher){
    if(publisher.value==='ALL'){cfg.publisher_scope='ALL';cfg.publisher_id=null;cfg.publisher_name='ALL';cfg.acquisition_method='AUTO'}
    else if(publisher.value){const o=publisher.selectedOptions[0];cfg.publisher_scope='SINGLE';cfg.publisher_id=publisher.value;cfg.publisher_name=o.textContent.split(' — ')[0];cfg.acquisition_method=o.dataset.method||'AUTO';cfg.search_endpoint=o.dataset.endpoint||null;cfg.platform=o.dataset.platform||null}
  }
  return cfg
}
function resolveRunId(result){
  return result?.run?.id||result?.run_id||result?.command_run_id||result?.mission?.command_run_id||result?.execution?.run_id||result?.execution?.command_run_id||null;
}
window.addEventListener('apie:authenticated',configureTask);
taskEl().addEventListener('change',configureTask);
stateEl().addEventListener('change',configureTask);
document.getElementById('eccLaunchForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const msg=document.getElementById('eccLaunchMessage'),missionType=taskEl().value,task=TASKS[missionType],stateCode=stateEl().value,agent=document.getElementById('eccAgent').value;
  if(!task||!agent){msg.textContent='Select a task before execution.';return}
  if(task.state==='required'&&(!stateCode||stateCode==='ALL')){msg.textContent='Select one state for this task.';return}
  const dynamic=document.getElementById('eccDynamicField');if(dynamic&&!dynamic.value){msg.textContent=`Select ${dynamic.closest('label').childNodes[0].textContent.trim()}.`;return}
  const config=buildConfiguration();
  const publisherLabel=config.publisher_name||'ALL';
  const payload={mission_type_key:missionType,state_code:stateCode==='ALL'?null:stateCode,assigned_agent:agent,mission_name:`${selectedText(taskEl())} — ${stateCode==='ALL'?'All States':selectedText(stateEl())} — Publisher ${publisherLabel}`,mission_config:config,...config};
  window.eccBeginTaskForce?.(missionType,stateCode==='ALL'?null:stateCode);
  msg.textContent='APIE is resolving configuration and executing the Task Force…';
  try{
    const r=await invoke(task.operation,payload);
    const runId=resolveRunId(r);
    window.eccFocusTaskForce?.(runId);
    msg.textContent=`Task Force launched. ${r.execution?.status||r.run?.status||'Monitoring started'}.`;
    await eccLoad();
  }catch(err){
    window.eccClearTaskForceMonitor?.();
    msg.textContent=err.message;
  }
});
