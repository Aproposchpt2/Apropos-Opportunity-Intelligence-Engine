const ECC={data:null,timer:null,focusRunId:null,focusStartedAt:0,focusMissionType:null,focusState:null,monitorAssets:null};
const q=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ms=value=>value?new Date(value).getTime():0;

function loadStyle(href){
  if(document.querySelector(`link[data-ecc-monitor-style="${href}"]`))return;
  const link=document.createElement('link');
  link.rel='stylesheet';link.href=href;link.dataset.eccMonitorStyle=href;
  document.head.appendChild(link);
}

function loadScript(src){
  return new Promise((resolve,reject)=>{
    if(document.querySelector(`script[data-ecc-monitor-script="${src}"]`)){resolve();return}
    const script=document.createElement('script');
    script.src=src;script.async=false;script.dataset.eccMonitorScript=src;
    script.onload=resolve;script.onerror=()=>reject(new Error(`Unable to load ${src}`));
    document.head.appendChild(script);
  });
}

function ensureMonitorAssets(){
  if(ECC.monitorAssets)return ECC.monitorAssets;
  ECC.monitorAssets=(async()=>{
    loadStyle('assets/task-force-monitors/monitor.css');
    for(const src of [
      'assets/task-force-monitors/monitor-common.js',
      'assets/task-force-monitors/monitor-registry.js',
      'assets/task-force-monitors/publisher-discovery-monitor.js',
      'assets/task-force-monitors/publisher-verification-monitor.js',
      'assets/task-force-monitors/acquisition-discovery-monitor.js',
      'assets/task-force-monitors/contract-package-monitor.js',
      'assets/task-force-monitors/business-development-monitor.js',
      'assets/task-force-monitors/opportunity-partner-monitor.js',
      'assets/task-force-monitors/institutional-buyer-monitor.js',
      'assets/task-force-monitors/supplemental-monitors.js'
    ])await loadScript(src);
    if(!window.APIEMissionMonitors)throw new Error('Mission monitor registry failed to initialize.');
  })();
  return ECC.monitorAssets;
}

function uniqueRuns(data){
  const all=[...(data.active_runs||[]),...(data.attention_runs||[]),...(data.runs||[])];
  const map=new Map();
  all.forEach(run=>{if(run?.id&&!map.has(run.id))map.set(run.id,run)});
  return[...map.values()].sort((a,b)=>ms(b.last_activity_at||b.updated_at||b.created_at)-ms(a.last_activity_at||a.updated_at||a.created_at));
}

function focusedRun(data){
  const runs=uniqueRuns(data);
  if(ECC.focusRunId)return runs.find(run=>String(run.id)===String(ECC.focusRunId))||null;
  if(!ECC.focusStartedAt)return null;
  return runs.find(run=>{
    const created=ms(run.started_at||run.created_at||run.updated_at);
    const typeMatches=!ECC.focusMissionType||String(run.mission_type_key||'').toUpperCase()===ECC.focusMissionType;
    const stateMatches=!ECC.focusState||String(run.state_code||'').toUpperCase()===ECC.focusState;
    return created>=ECC.focusStartedAt-5000&&typeMatches&&stateMatches;
  })||null;
}

function setMonitorMessage(message){
  const monitor=q('eccTaskForceMonitor');
  if(monitor)monitor.innerHTML=`<p class="ecc-empty">${esc(message)}</p>`;
}

window.eccBeginTaskForce=(missionType,stateCode)=>{
  ECC.focusRunId=null;ECC.focusStartedAt=Date.now();
  ECC.focusMissionType=String(missionType||'').toUpperCase()||null;
  ECC.focusState=String(stateCode||'').toUpperCase()||null;
  setMonitorMessage('Launching the selected Task Force…');
};
window.eccFocusTaskForce=runId=>{ECC.focusRunId=runId?String(runId):null;eccRender()};
window.eccClearTaskForceMonitor=()=>{
  ECC.focusRunId=null;ECC.focusStartedAt=0;ECC.focusMissionType=null;ECC.focusState=null;
  setMonitorMessage('Execute a task to begin monitoring.');
};

async function eccLoad(){
  try{await ensureMonitorAssets();ECC.data=await invoke('command-executive-status',{});eccRender()}
  catch(error){console.error('Executive status unavailable:',error);setMonitorMessage(`Activity Monitor unavailable: ${error.message||error}`)}
}

function eccRender(){
  if(!ECC.data)return;
  const updated=q('eccUpdated');
  if(updated)updated.textContent=`Updated ${new Date(ECC.data.generated_at||Date.now()).toLocaleTimeString()}`;
  const monitor=q('eccTaskForceMonitor');if(!monitor)return;
  const run=focusedRun(ECC.data);
  if(run&&!ECC.focusRunId)ECC.focusRunId=String(run.id);
  if(run){monitor.innerHTML=window.APIEMissionMonitors.renderCard(run);return}
  monitor.innerHTML=ECC.focusStartedAt
    ?'<p class="ecc-empty">Task Force accepted. Waiting for its live monitor record…</p>'
    :'<p class="ecc-empty">Execute a task to begin monitoring.</p>';
}

window.addEventListener('apie:authenticated',async()=>{
  window.eccClearTaskForceMonitor();clearInterval(ECC.timer);
  await eccLoad();ECC.timer=setInterval(eccLoad,5000);
});
