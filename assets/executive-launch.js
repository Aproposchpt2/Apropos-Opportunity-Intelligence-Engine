const TASKS={
  PUBLISHER_DISCOVERY:{agent:'Publisher Discovery',state:'required',county:true,operation:'command-mission-control'},
  VERIFY_PUBLISHER_CONNECTION:{agent:'Publisher Engineering',state:'required',county:true,publisher:true,operation:'command-verify-publisher-connection-queue'},
  ACQUISITION_DISCOVERY:{agent:'Acquisition Operations',state:'required',county:true,publisher:true,operation:'command-mission-control'},
  CONTRACT_PACKAGE_ACQUISITION:{agent:'AADP Package Acquisition',state:'required',county:true,publisher:true,operation:'command-mission-control'},
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
  const county=document.getElementById('eccCounty');
  const fields=document.getElementById('eccPublisherFields');
  const verification=taskEl().value==='VERIFY_PUBLISHER_CONNECTION';
  if(!fields)return;
  if(!state||state==='ALL'||!county?.value){
    fields.innerHTML='<label>Publisher<select id="eccPublisher" required disabled><option value="">Select one county first</option></select><small>This task requires one state, one county, and one publisher.</small></label><label>Connector<input id="eccConnectorDisplay" value="Select a publisher" readonly></label>';
    return;
  }
  fields.innerHTML='<label>Publisher<select id="eccPublisher" required disabled><option value="">Loading eligible publishers…</option></select><small>Loading verified READY publishers for the selected county.</small></label><label>Connector<input id="eccConnectorDisplay" value="Resolving…" readonly></label>';
  try{
    const d=await invoke('command-publisher-options',{state_code:state,county_name:county.value,include_testing:true});
    const rows=d.publishers||[];
    const options=rows.map(p=>{
      const status=p.certification_status||'DEVELOPMENT';
      const connector=p.connector_label||'CONNECTOR PROFILE REQUIRED';
      return `<option value="${escAttr(p.publisher_id)}" data-method="${escAttr(p.acquisition_method||'AUTO')}" data-endpoint="${escAttr(p.search_endpoint||'')}" data-platform="${escAttr(p.platform||'')}" data-connector="${escAttr(connector)}" data-execution-mode="${escAttr(p.execution_mode||'VERIFICATION_REQUIRED')}">${escAttr(p.publisher_name)} — ${escAttr(status)}</option>`;
    }).join('');
    const empty=rows.length?'':`<option value="" disabled>No verified READY publishers are registered for ${escAttr(county.value)}</option>`;
    const note=verification
      ?'Select one eligible publisher. EAG-001 performs a read-only connection validation.'
      :taskEl().value==='ACQUISITION_DISCOVERY'
        ?'Publisher Scope is fixed to SINGLE. Select one eligible publisher at a time. Publishers that still require certification will be identified before acquisition begins.'
        :'Select one eligible publisher at a time.';
    fields.innerHTML=`<label>Publisher<select id="eccPublisher" required><option value="" selected>Select one publisher</option>${empty}${options}</select><small>${note}</small></label><label>Connector<input id="eccConnectorDisplay" value="Select a publisher" readonly><small>The connector is resolved from the selected Publisher Profile.</small></label>`;
    document.getElementById('eccPublisher')?.addEventListener('change',updateConnectorDisplay);
  }catch(err){fields.innerHTML=`<label>Publisher<select id="eccPublisher" required disabled><option value="">Publisher profiles unavailable</option></select><small>${escAttr(err.message)}</small></label><label>Connector<input id="eccConnectorDisplay" value="Unavailable" readonly></label>`}
}
async function renderCountyScope(task){
  const state=stateEl().value;
  if(!state||state==='ALL'){
    configEl().innerHTML=`<label>County<select id="eccCounty" required disabled><option value="">Select one state first</option></select><small>County-centric tasks require one state and one county.</small></label>${task.publisher?'<div id="eccPublisherFields"></div>':''}`;
    if(task.publisher)await renderPublisherSelector();
    return;
  }
  configEl().innerHTML=`<label>County<select id="eccCounty" required disabled><option value="">Loading county profiles…</option></select><small>Loading county expansion profiles.</small></label>${task.publisher?'<div id="eccPublisherFields"></div>':''}`;
  try{
    const d=await invoke('command-county-options',{state_code:state});
    const rows=d.counties||[];
    const options=rows.map(c=>`<option value="${escAttr(c.county_name)}" data-fips="${escAttr(c.county_fips||'')}">${escAttr(c.county_name)}${c.county_fips?` — ${escAttr(c.county_fips)}`:''}</option>`).join('');
    const empty=rows.length?'':`<option value="" disabled>No county expansion profiles are registered for ${escAttr(state)}</option>`;
    configEl().innerHTML=`<label>County<select id="eccCounty" required><option value="" selected>Select one county</option>${empty}${options}</select><small>Publisher tasks are filtered to the selected county.</small></label>${task.publisher?'<div id="eccPublisherFields"></div>':''}`;
    document.getElementById('eccCounty')?.addEventListener('change',()=>task.publisher&&renderPublisherSelector());
    if(task.publisher)await renderPublisherSelector();
  }catch(err){configEl().innerHTML=`<label>County<select id="eccCounty" required disabled><option value="">County profiles unavailable</option></select><small>${escAttr(err.message)}</small></label>${task.publisher?'<div id="eccPublisherFields"></div>':''}`}
}
async function configureTask(){
  const task=TASKS[taskEl().value];setAgent(task?.agent||'');configEl().innerHTML='';
  stateEl().required=Boolean(task&&task.state==='required');
  const all=stateEl().querySelector('option[value="ALL"]');if(all)all.disabled=Boolean(task&&task.state==='required');
  if(!task)return;
  if(task.county)await renderCountyScope(task);else configEl().innerHTML=renderField(task.field)
}
function buildConfiguration(){
  const cfg={automation_mode:'FULLY_AUTOMATED',operator_controls:['TASK','STATE','COUNTY','PUBLISHER','EXECUTE'],manual_onboarding:false,manual_assignment:false,manual_connector_configuration:false,publisher_scope:'SINGLE'};
  const dynamic=document.getElementById('eccDynamicField');if(dynamic)cfg[dynamic.dataset.key]=dynamic.value;
  const county=document.getElementById('eccCounty');
  if(county?.value){const o=county.selectedOptions[0];cfg.county_name=county.value;cfg.county_fips=o?.dataset?.fips||null;cfg.geographic_scope='COUNTY'}
  const publisher=document.getElementById('eccPublisher');
  if(publisher?.value){
    const o=publisher.selectedOptions[0];
    cfg.publisher_id=publisher.value;cfg.publisher_name=o.textContent.split(' — ')[0];cfg.acquisition_method=o.dataset.method||'AUTO';cfg.search_endpoint=o.dataset.endpoint||null;cfg.platform=o.dataset.platform||null;cfg.connector_key=o.dataset.connector||null;cfg.execution_mode=o.dataset.executionMode||null;
  }
  return cfg
}
function resolveRunId(result){return result?.run?.id||result?.run_id||result?.command_run_id||result?.mission?.command_run_id||result?.execution?.run_id||result?.execution?.command_run_id||null}
window.addEventListener('apie:authenticated',configureTask);
taskEl().addEventListener('change',configureTask);
stateEl().addEventListener('change',configureTask);
document.getElementById('eccLaunchForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const msg=document.getElementById('eccLaunchMessage'),missionType=taskEl().value,task=TASKS[missionType],stateCode=stateEl().value,agent=document.getElementById('eccAgent').value;
  if(!task||!agent){msg.textContent='Select a task before execution.';return}
  if(task.state==='required'&&(!stateCode||stateCode==='ALL')){msg.textContent='Select one state for this task.';return}
  const dynamic=document.getElementById('eccDynamicField');if(dynamic&&!dynamic.value){msg.textContent=`Select ${dynamic.closest('label').childNodes[0].textContent.trim()}.`;return}
  const county=document.getElementById('eccCounty');
  if(task.county&&(!county||!county.value)){msg.textContent='Select one county before execution.';return}
  const publisher=document.getElementById('eccPublisher');
  if(task.publisher&&(!publisher||!publisher.value)){msg.textContent='Select one publisher before execution.';return}
  const config=buildConfiguration(),publisherLabel=config.publisher_name||'Not selected',countyLabel=config.county_name||'No county';
  const publisherMissionLabel=task.publisher?` — Publisher ${publisherLabel}`:'';
  const payload={mission_type_key:missionType,state_code:stateCode==='ALL'?null:stateCode,assigned_agent:agent,mission_name:`${selectedText(taskEl())} — ${stateCode==='ALL'?'All States':selectedText(stateEl())} — ${countyLabel}${publisherMissionLabel}`,mission_config:config,...config};
  window.eccBeginTaskForce?.(missionType,stateCode==='ALL'?null:stateCode);
  msg.textContent=missionType==='VERIFY_PUBLISHER_CONNECTION'?'EAG-001 is testing the selected publisher connection…':missionType==='PUBLISHER_DISCOVERY'?`APIE is launching county-centric publisher and platform discovery for ${countyLabel}…`:missionType==='CONTRACT_PACKAGE_ACQUISITION'?`AADP is retrieving the complete official solicitation package for ${publisherLabel}…`:'APIE is launching a single-publisher acquisition mission…';
  try{const r=await invoke(task.operation,payload);const runId=resolveRunId(r);window.eccFocusTaskForce?.(runId);msg.textContent=`Task Force launched. ${r.execution?.status||r.execution?.dispatch_status||r.run?.status||'Monitoring started'}.`;await eccLoad()}
  catch(err){window.eccClearTaskForceMonitor?.();msg.textContent=err.message}
});