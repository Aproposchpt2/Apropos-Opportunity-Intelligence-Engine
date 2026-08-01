const ECC={data:null,timer:null,focusRunId:null,focusStartedAt:0,focusMissionType:null,focusState:null};
const q=id=>document.getElementById(id);
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
const lower=v=>String(v??'').toLowerCase();
const num=v=>Number(v||0).toLocaleString();
const when=v=>v?new Date(v).toLocaleString():'—';
const ms=v=>v?new Date(v).getTime():0;
const pct=(a,b)=>Number(b)>0?`${Math.round((Number(a||0)/Number(b))*100)}%`:'0%';
const cls=s=>`ecc-${String(s||'unknown').toLowerCase().replaceAll('_','-').replaceAll(' ','-')}`;

function resultLabel(r){
  const status=lower(r.status||r.aadp_state);
  const failures=Number(r.failure_count||0);
  const warnings=Number(r.warning_count||0);
  if(status==='completed_with_warnings'||status==='completed_with_failures'||status==='partially_complete'||(status==='completed'&&(warnings>0||failures>0)))return'PASS WITH WARNINGS';
  if(status==='completed')return'PASS';
  if(status==='failed')return'FAIL';
  if(status==='blocked'||(r.action_required&&!['completed','completed_with_warnings','completed_with_failures','partially_complete'].includes(status)))return'BLOCKED';
  if(status==='queued'||status==='pending')return'QUEUED';
  if(status==='running'||status==='processing')return'RUNNING';
  return String(r.status||r.aadp_state||'UNKNOWN').replaceAll('_',' ').toUpperCase();
}

function publisherName(r){
  const cfg=r.mission_config||{};
  const evidence=r.execution_evidence||{};
  return r.publisher_name||cfg.publisher_name||evidence.publisher_name||'ALL';
}

function stateName(r){return r.state_name||r.state_code||'ALL';}
function instanceId(r){return r.task_force_instance_id||r.instance_id||`TF-${String(r.id||'UNKNOWN').slice(0,12).toUpperCase()}`;}
function records(r,key,fallback=0){return r[key]??r.execution_evidence?.[key]??r.result?.[key]??fallback;}
function blockerReason(r){return r.result_summary||r.blocker_reason||r.error_message||r.execution_evidence?.error||'';}
function elapsed(r){
  const start=ms(r.started_at||r.created_at),end=ms(r.completed_at||r.last_activity_at||r.updated_at)||Date.now();
  if(!start)return'—';
  const total=Math.max(0,Math.floor((end-start)/1000));
  const h=String(Math.floor(total/3600)).padStart(2,'0');
  const m=String(Math.floor((total%3600)/60)).padStart(2,'0');
  const s=String(total%60).padStart(2,'0');
  return`${h}:${m}:${s}`;
}

const STAGES=[
  {key:'publisher-discovery',label:'Publisher Discovery',agent:'Publisher Discovery Agent',range:[0,25]},
  {key:'publisher-validation',label:'Publisher Validation',agent:'Publisher Validation Engine',range:[25,45]},
  {key:'assignment-creation',label:'Assignment Creation',agent:'Assignment Orchestrator',range:[45,65]},
  {key:'acquisition-discovery',label:'Acquisition Discovery',agent:'Acquisition Operations',range:[65,95]},
  {key:'mission-completion',label:'Mission Completion',agent:'Mission Orchestrator',range:[95,100]}
];

function currentStageIndex(r){
  const stage=String(r.current_stage||'').toUpperCase();
  if(stage.includes('PUBLISHER_DISCOVERY'))return 0;
  if(stage.includes('PUBLISHER_VALIDATION')||stage.includes('DUPLICATE')||stage.includes('CANDIDATE'))return 1;
  if(stage.includes('ASSIGNMENT')||stage.includes('ACQUISITION_QUEUED')||stage.includes('HANDOFF'))return 2;
  if(stage.includes('RESOLVING_PUBLISHERS')||stage.includes('ACQUIRING')||stage.includes('ACQUISITION'))return 3;
  if(stage.includes('COMPLETE')||stage.includes('FAILED')||stage.includes('BLOCKED'))return 4;
  const progress=Number(r.progress_value||0);
  if(progress<25)return 0;if(progress<45)return 1;if(progress<65)return 2;if(progress<95)return 3;return 4;
}

function stageDetail(r,index,status){
  const evidence=r.execution_evidence||{};
  const discovered=Number(records(r,'records_discovered',0));
  const accepted=Number(records(r,'records_accepted',discovered));
  const acquired=Number(records(r,'records_acquired',0));
  const processed=Number(evidence.publishers_processed||accepted||0);
  const warnings=Number(r.warning_count||evidence.failures||0);
  if(status==='PENDING')return'Waiting for the preceding stage';
  if(index===0)return status==='RUNNING'?'Researching official publisher sources':`${num(discovered)} publishers discovered`;
  if(index===1)return status==='RUNNING'?'Verifying official sources and acquisition access':`${num(accepted)} publishers validated`;
  if(index===2)return status==='RUNNING'?'Creating and refreshing READY assignments':`${num(accepted)} assignments ready`;
  if(index===3)return status==='RUNNING'?`${num(acquired)} records acquired so far`:`${num(Math.max(0,processed-warnings))} publishers succeeded · ${num(acquired)} records acquired`;
  if(status==='WARNING')return`${num(warnings)} acquisition warnings require report review`;
  if(status==='FAIL'||status==='BLOCKED')return blockerReason(r)||'Mission requires attention';
  return resultLabel(r)==='PASS'?'Mission completed successfully':'Mission outcome recorded';
}

function stageModels(r){
  const result=resultLabel(r);
  const terminal=['PASS','PASS WITH WARNINGS','FAIL','BLOCKED'].includes(result);
  const active=currentStageIndex(r);
  const overall=Math.max(0,Math.min(100,Number(r.progress_value||0)));
  return STAGES.map((stage,index)=>{
    let status='PENDING';
    let progress=0;
    if(terminal){
      if(index<4){status='COMPLETED';progress=100;}
      else{status=result==='PASS'?'COMPLETED':result==='PASS WITH WARNINGS'?'WARNING':result;progress=100;}
    }else if(index<active){status='COMPLETED';progress=100;}
    else if(index===active){
      status='RUNNING';
      const [start,end]=stage.range;
      progress=Math.max(4,Math.min(100,Math.round(((overall-start)/Math.max(1,end-start))*100)));
    }
    return{...stage,index:index+1,status,progress,detail:stageDetail(r,index,status)};
  });
}

function stageMonitor(r){
  return`<section class="ecc-stage-monitor" aria-label="Five-stage mission progress">${stageModels(r).map(stage=>`<div class="ecc-stage-row ${cls(stage.status)}"><div class="ecc-stage-heading"><span class="ecc-stage-number">${stage.index}</span><div><b>${esc(stage.label)}</b><small>${esc(stage.status.replaceAll('_',' '))}</small></div><strong>${stage.progress}%</strong></div><div class="ecc-stage-detail"><span>${esc(stage.detail)}</span><small>${esc(stage.agent)}</small></div><progress class="ecc-stage-progress" max="100" value="${stage.progress}" aria-label="${esc(stage.label)} progress">${stage.progress}%</progress></div>`).join('')}</section>`;
}

function missionAnalytics(r){
  const evidence=r.execution_evidence||{};
  const processed=Number(evidence.publishers_processed||records(r,'records_accepted',records(r,'records_discovered',0))||0);
  const warnings=Number(r.warning_count||evidence.failures||0);
  const successful=Math.max(0,processed-warnings);
  const acquired=Number(records(r,'records_acquired',0));
  if(!processed)return'';
  return`<section class="ecc-mission-analytics" aria-label="Mission performance"><span>Publishers Processed<b>${num(processed)}</b></span><span>Publishers Successful<b>${num(successful)}</b></span><span>Publisher Success Rate<b>${pct(successful,processed)}</b></span><span>Acquisition Yield<b>${pct(acquired,processed)}</b></span></section>`;
}

function taskForceCard(r){
  const result=resultLabel(r);
  const complete=['PASS','PASS WITH WARNINGS','FAIL','BLOCKED'].includes(result);
  const discovered=records(r,'records_discovered',records(r,'result_count',0));
  const acquired=records(r,'records_acquired',records(r,'records_processed',0));
  const accepted=records(r,'records_accepted',Math.max(0,Number(acquired)-Number(records(r,'records_rejected',0))));
  const rejected=records(r,'records_rejected',records(r,'failure_count',0));
  const task=String(r.mission_type_key||r.mission_name||'TASK FORCE').replaceAll('_',' ');
  const heading=`${task} STATE: ${stateName(r)} PUBLISHER: ${publisherName(r)}`;
  const reason=blockerReason(r);
  const reasonMarkup=complete&&reason?`<div class="ecc-result-reason"><span>${result==='BLOCKED'?'Blocker':'Result Detail'}</span><b>${esc(reason)}</b></div>`:'';
  const details=complete
    ?`${missionAnalytics(r)}<div class="ecc-result-grid"><span>Result<b>${esc(result)}</b></span><span>Records Discovered<b>${num(discovered)}</b></span><span>Records Acquired<b>${num(acquired)}</b></span><span>Records Accepted<b>${num(accepted)}</b></span><span>Records Rejected<b>${num(rejected)}</b></span><span>Completed<b>${when(r.completed_at||r.updated_at)}</b></span><span>Execution Time<b>${elapsed(r)}</b></span></div>${reasonMarkup}`
    :`<div class="ecc-result-grid"><span>Status<b>${esc(result)}</b></span><span>Current Stage<b>${esc(r.current_stage||'Initializing')}</b></span><span>Overall Progress<b>${Math.max(0,Math.min(100,Number(r.progress_value||0)))}%</b></span><span>Records Acquired<b>${num(acquired)}</b></span><span>Active Agent<b>${esc(stageModels(r).find(stage=>stage.status==='RUNNING')?.agent||'Mission Orchestrator')}</b></span><span>Elapsed Time<b>${elapsed(r)}</b></span></div>`;
  return`<article class="ecc-task-force-card ${cls(result)}"><header><div><small>TASK FORCE INSTANCE · ${esc(instanceId(r))}</small><h3>${esc(heading)}</h3></div><span class="status-pill ${cls(result)}">${esc(result)}</span></header>${stageMonitor(r)}${details}<a class="ecc-report-link" href="/missions/?id=${encodeURIComponent(r.id)}">VIEW REPORT</a></article>`;
}

function uniqueRuns(data){
  const all=[...(data.active_runs||[]),...(data.attention_runs||[]),...(data.runs||[])];
  const map=new Map();
  all.forEach(r=>{if(r?.id&&!map.has(r.id))map.set(r.id,r)});
  return[...map.values()].sort((a,b)=>ms(b.last_activity_at||b.updated_at||b.created_at)-ms(a.last_activity_at||a.updated_at||a.created_at));
}

function focusedRun(data){
  const runs=uniqueRuns(data);
  if(ECC.focusRunId)return runs.find(r=>String(r.id)===String(ECC.focusRunId))||null;
  if(!ECC.focusStartedAt)return null;
  return runs.find(r=>{
    const created=ms(r.started_at||r.created_at||r.updated_at);
    const typeMatches=!ECC.focusMissionType||String(r.mission_type_key||'').toUpperCase()===ECC.focusMissionType;
    const stateMatches=!ECC.focusState||String(r.state_code||'').toUpperCase()===ECC.focusState;
    return created>=ECC.focusStartedAt-5000&&typeMatches&&stateMatches;
  })||null;
}

function setMonitorMessage(message){
  const monitor=q('eccTaskForceMonitor');
  if(monitor)monitor.innerHTML=`<p class="ecc-empty">${esc(message)}</p>`;
}

window.eccBeginTaskForce=(missionType,stateCode)=>{
  ECC.focusRunId=null;
  ECC.focusStartedAt=Date.now();
  ECC.focusMissionType=String(missionType||'').toUpperCase()||null;
  ECC.focusState=String(stateCode||'').toUpperCase()||null;
  setMonitorMessage('Launching the selected Task Force…');
};

window.eccFocusTaskForce=runId=>{
  ECC.focusRunId=runId?String(runId):null;
  eccRender();
};

window.eccClearTaskForceMonitor=()=>{
  ECC.focusRunId=null;
  ECC.focusStartedAt=0;
  ECC.focusMissionType=null;
  ECC.focusState=null;
  setMonitorMessage('Execute a task to begin monitoring.');
};

async function eccLoad(){
  try{ECC.data=await invoke('command-executive-status',{});eccRender()}
  catch(error){console.error('Executive status unavailable:',error);setMonitorMessage(`Activity Monitor unavailable: ${error.message||error}`)}
}

function eccRender(){
  if(!ECC.data)return;
  const updated=q('eccUpdated');
  if(updated)updated.textContent=`Updated ${new Date(ECC.data.generated_at||Date.now()).toLocaleTimeString()}`;
  const monitor=q('eccTaskForceMonitor');
  if(!monitor)return;
  const run=focusedRun(ECC.data);
  if(run&&!ECC.focusRunId)ECC.focusRunId=String(run.id);
  monitor.innerHTML=run?taskForceCard(run):ECC.focusStartedAt
    ?'<p class="ecc-empty">Task Force accepted. Waiting for its live monitor record…</p>'
    :'<p class="ecc-empty">Execute a task to begin monitoring.</p>';
}

window.addEventListener('apie:authenticated',()=>{
  window.eccClearTaskForceMonitor();
  clearInterval(ECC.timer);
  ECC.timer=setInterval(eccLoad,5000);
});
