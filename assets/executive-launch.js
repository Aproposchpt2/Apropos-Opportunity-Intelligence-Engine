const TASKS={
  PUBLISHER_DISCOVERY:{agent:'Publisher Discovery',state:'required',field:{id:'discovery_scope',label:'Discovery Scope',type:'select',defaultValue:'STATEWIDE_ALL',options:[['STATEWIDE_ALL','Comprehensive — all publisher classes (Recommended)'],['STATE_AND_LOCAL','Expanded — state and local ecosystem'],['STATEWIDE','Core — statewide publishers'],['REFRESH','Refresh existing publisher intelligence']]},operation:'command-mission-control'},
  ACQUISITION_DISCOVERY:{agent:'Acquisition Operations',state:'required',publisher:true,operation:'command-mission-control'},
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
function renderField(field){
  if(!field)return'';
  if(field.type==='select'){
    const hasDefault=Boolean(field.defaultValue);
    const placeholder=hasDefault?'':`<option value="">Select ${escAttr(field.label.toLowerCase())}</option>`;
    const options=field.options.map(([v,l])=>`<option value="${escAttr(v)}"${v===field.defaultValue?' selected':''}>${escAttr(l)}</option>`).join('');
    return `<label>${escAttr(field.label)}<select id="eccDynamicField" data-key="${escAttr(field.id)}" required>${placeholder}${options}</select></label>`;
  }
  return'';
}
function updateConnectorDisplay(){
  const publisher=document.getElementById('eccPublisher');
  const display=document.getElementById('eccConnectorDisplay');
  if(!publisher||!display)return;
  const option=publisher.selectedOptions?.[0];
  display.value=option?.dataset?.connector||'Select a publisher';
}
async function renderPublisherSelector(){
  const state=stateEl().value;
  if(!state||state==='ALL'){
    configEl().innerHTML='<label>Publisher<select id="eccPublisher" required disabled><option value="">Select one state first</option></select><small>Acquisition Discovery requires one state and one publisher.</small></label><label>Connector<input id="eccConnectorDisplay" value="Select a publisher" readonly></label>';
    return;
  }
  configEl().innerHTML='<label>Publisher<select id="eccPublisher" required disabled><option value="">Loading publisher profiles…</option></select><small>Loading verified publisher profiles.</small></label><label>Connector<input id="eccConnectorDisplay" value="Resolving…" readonly></label>';
  try{
    const d=await invoke('command-publisher-options',{state_code:state});
    const rows=d.publishers||[];
    const options=rows.map(p=>`<option value="${escAttr(p.publisher_id)}" data-method="${escAttr(p.acquisition_method||'AUTO')}" data-endpoint="${escAttr(p.search_endpoint||'')}" data-platform="${escAttr(p.platform||'')}" data-connector="${escAttr(p.connector_label||'CONNECTOR PROFILE REQUIRED')}"${p.selectable?'':' disabled'}>${escAttr(p.publisher_name)} — ${escAttr(p.connector_label||'CONNECTOR PROFILE REQUIRED')}${p.selectable?'':' — NOT READY'}</option>`).join('');
    configEl().innerHTML=`<label>Publisher<select id="eccPublisher" required><option value="" selected>Select one publisher</option>${options}</select><small>One publisher is required. Publishers without an approved connector profile cannot be executed.</small></label><label>Connector<input id="eccConnectorDisplay" value="Select a publisher" readonly><small>The connector is resolved from the approved Publisher Profile.</small></label>`;
    document.getElementById('eccPublisher')?.addEventListener('change',updateConnectorDisplay);
  }catch(err){configEl().innerHTML=`<label>Publisher<select id="eccPublisher" required disabled><option value="">Publisher profiles unavailable</option></select><small>${escAttr(err.message)}</small></label><label>Connector<input id="eccConnectorDisplay" value="Unavailable" readonly></label>`}
}
async function configureTask(){
  const task=TASKS[taskEl().value];setAgent(task?.agent||'');configEl().innerHTML='';
  stateEl().required=Boolean(task&&task.state==='required');
  const all=stateEl().querySelector('option[value="ALL"]');if(all)all.disabled=Boolean(task&&task.state==='required');
  if(!task)return;
  if(task.publisher)await renderPublisherSelector();else configEl().innerHTML=renderField(task.field)
}
function buildConfiguration(){
  const cfg={automation_mode:'FULLY_AUTOMATED',operator_controls:['TASK','STATE','PUBLISHER','EXECUTE'],manual_onboarding:false,manual_assignment:false,manual_connector_configuration:false};
  const dynamic=document.getElementById('eccDynamicField');if(dynamic)cfg[dynamic.dataset.key]=dynamic.value;
  const publisher=document.getElementById('eccPublisher');
  if(publisher?.value){
    const o=publisher.selectedOptions[0];
    cfg.publisher_scope='SINGLE';
    cfg.publisher_id=publisher.value;
    cfg.publisher_name=o.textContent.split(' — ')[0];
    cfg.acquisition_method=o.dataset.method||'AUTO';
    cfg.search_endpoint=o.dataset.endpoint||null;
    cfg.platform=o.dataset.platform||null;
    cfg.connector_key=o.dataset.connector||null;
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
  const publisher=document.getElementById('eccPublisher');
  if(task.publisher&&(!publisher||!publisher.value)){msg.textContent='Select one READY publisher before executing Acquisition Discovery.';return}
  const config=buildConfiguration();
  const publisherLabel=config.publisher_name||'Not selected';
  const payload={mission_type_key:missionType,state_code:stateCode==='ALL'?null:stateCode,assigned_agent:agent,mission_name:`${selectedText(taskEl())} — ${stateCode==='ALL'?'All States':selectedText(stateEl())} — Publisher ${publisherLabel}`,mission_config:config,...config};
  window.eccBeginTaskForce?.(missionType,stateCode==='ALL'?null:stateCode);
  msg.textContent='APIE is resolving the Publisher Profile and executing the assigned connector…';
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
