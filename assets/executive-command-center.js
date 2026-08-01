const ECC={data:null,timer:null};
const q=id=>document.getElementById(id);
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
const lower=v=>String(v??'').toLowerCase();
const num=v=>Number(v||0).toLocaleString();
const when=v=>v?new Date(v).toLocaleString():'—';
const ms=v=>v?new Date(v).getTime():0;
const cls=s=>`ecc-${String(s||'unknown').toLowerCase().replaceAll('_','-').replaceAll(' ','-')}`;

function resultLabel(r){
  const status=lower(r.status||r.aadp_state);
  const failures=Number(r.failure_count||0);
  const warnings=Number(r.warning_count||0);
  if(r.action_required||status==='blocked')return'BLOCKED';
  if(status==='failed'||status==='completed_with_failures'||failures>0)return'FAIL';
  if(status==='completed_with_warnings'||(status==='completed'&&warnings>0))return'PASS WITH WARNINGS';
  if(status==='completed')return'PASS';
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
function elapsed(r){
  const start=ms(r.started_at||r.created_at),end=ms(r.completed_at||r.last_activity_at||r.updated_at)||Date.now();
  if(!start)return'—';
  const total=Math.max(0,Math.floor((end-start)/1000));
  const h=String(Math.floor(total/3600)).padStart(2,'0');
  const m=String(Math.floor((total%3600)/60)).padStart(2,'0');
  const s=String(total%60).padStart(2,'0');
  return`${h}:${m}:${s}`;
}

function taskForceCard(r){
  const result=resultLabel(r);
  const complete=['PASS','PASS WITH WARNINGS','FAIL','BLOCKED'].includes(result);
  const pct=Math.max(0,Math.min(100,Number(r.progress_value||0)));
  const discovered=records(r,'records_discovered',records(r,'result_count',0));
  const acquired=records(r,'records_acquired',records(r,'records_processed',0));
  const accepted=records(r,'records_accepted',Math.max(0,Number(acquired)-Number(records(r,'records_rejected',0))));
  const rejected=records(r,'records_rejected',records(r,'failure_count',0));
  const task=String(r.mission_type_key||r.mission_name||'TASK FORCE').replaceAll('_',' ');
  const heading=`${task} STATE: ${stateName(r)} PUBLISHER: ${publisherName(r)}`;
  const details=complete
    ?`<div class="ecc-result-grid"><span>Result<b>${esc(result)}</b></span><span>Records Discovered<b>${num(discovered)}</b></span><span>Records Acquired<b>${num(acquired)}</b></span><span>Records Accepted<b>${num(accepted)}</b></span><span>Records Rejected<b>${num(rejected)}</b></span><span>Completed<b>${when(r.completed_at||r.updated_at)}</b></span><span>Execution Time<b>${elapsed(r)}</b></span></div>`
    :`<div class="ecc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div><div class="ecc-result-grid"><span>Status<b>${esc(result)}</b></span><span>Current Stage<b>${esc(r.current_stage||'Initializing')}</b></span><span>Progress<b>${pct}%</b></span><span>Records Acquired<b>${num(acquired)}</b></span><span>Last Activity<b>${when(r.last_activity_at||r.updated_at)}</b></span><span>Elapsed Time<b>${elapsed(r)}</b></span></div>`;
  return`<article class="ecc-task-force-card ${cls(result)}"><header><div><small>TASK FORCE INSTANCE · ${esc(instanceId(r))}</small><h3>${esc(heading)}</h3></div><span class="status-pill ${cls(result)}">${esc(result)}</span></header>${details}<a class="ecc-report-link" href="/missions/?id=${encodeURIComponent(r.id)}">VIEW REPORT</a></article>`;
}

function uniqueRuns(data){
  const all=[...(data.active_runs||[]),...(data.attention_runs||[]),...(data.runs||[])];
  const map=new Map();
  all.forEach(r=>{if(r?.id&&!map.has(r.id))map.set(r.id,r)});
  return[...map.values()].sort((a,b)=>ms(b.last_activity_at||b.updated_at||b.created_at)-ms(a.last_activity_at||a.updated_at||a.created_at)).slice(0,20);
}

async function eccLoad(){
  try{ECC.data=await invoke('command-executive-status',{});eccRender()}
  catch(error){console.error('Executive status unavailable:',error);const monitor=q('eccTaskForceMonitor');if(monitor)monitor.innerHTML=`<p class="ecc-empty">Activity Monitor unavailable: ${esc(error.message||error)}</p>`}
}

function eccRender(){
  if(!ECC.data)return;
  const updated=q('eccUpdated');
  if(updated)updated.textContent=`Updated ${new Date(ECC.data.generated_at||Date.now()).toLocaleTimeString()}`;
  const monitor=q('eccTaskForceMonitor');
  if(!monitor)return;
  const runs=uniqueRuns(ECC.data);
  monitor.innerHTML=runs.length?runs.map(taskForceCard).join(''):'<p class="ecc-empty">No Task Force Instances are available.</p>';
}

window.addEventListener('apie:authenticated',()=>{eccLoad();clearInterval(ECC.timer);ECC.timer=setInterval(eccLoad,15000)});
