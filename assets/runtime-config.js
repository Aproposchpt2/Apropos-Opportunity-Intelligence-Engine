window.AP_COMMAND_CONFIG = Object.freeze({
  supabaseUrl: '',
  anonKey: ''
});

(() => {
  const style = document.createElement('style');
  style.textContent = `
    .primary-action.apie-cta-initiated {
      background: linear-gradient(135deg,#f59e0b,#facc15) !important;
      color:#1f1300 !important;
      box-shadow:0 0 0 3px rgba(245,158,11,.18),0 10px 24px rgba(245,158,11,.22) !important;
      filter:none !important;
      transform:none !important;
    }
    .ecc-step-hidden{display:none!important}
    .ecc-progressive-step{animation:eccStepIn .22s ease both}
    @keyframes eccStepIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
    .ecc-execute.apie-cta-armed{
      background:#102033!important;
      color:#ffd873!important;
      border:1px solid rgba(255,216,115,.75)!important;
      box-shadow:0 0 0 2px rgba(255,216,115,.08)!important;
    }
    .ecc-execute.apie-cta-running{
      background:linear-gradient(135deg,#38bdf8,#2563eb)!important;
      color:#fff!important;
      border:0!important;
      box-shadow:0 0 0 3px rgba(56,189,248,.14),0 10px 28px rgba(37,99,235,.24)!important;
    }
    .ecc-execute.apie-cta-failed{
      background:linear-gradient(135deg,#b91c1c,#ef4444)!important;
      color:#fff!important;
      border:0!important;
    }
    .ecc-launch-card{
      display:grid;gap:.7rem;margin:.85rem 0 0;padding:.9rem;border:1px solid rgba(125,211,252,.25);
      border-left:4px solid #7dd3fc;border-radius:8px;background:rgba(2,8,20,.28)
    }
    .ecc-launch-card[hidden]{display:none!important}
    .ecc-launch-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.7rem}
    .ecc-launch-card-kicker{margin:0;color:#7dd3fc;font-size:.72rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
    .ecc-launch-card-title{margin:.15rem 0 0;color:#fff;font-size:.9rem;font-weight:800;line-height:1.35}
    .ecc-launch-card-status{flex:0 0 auto;padding:.28rem .5rem;border:1px solid rgba(125,211,252,.35);border-radius:999px;color:#7dd3fc;font-size:.68rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .ecc-launch-card-grid{display:grid;grid-template-columns:1fr 1fr;gap:.55rem}
    .ecc-launch-card-field{min-width:0;padding:.55rem;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);border-radius:5px}
    .ecc-launch-card-field small{display:block;margin-bottom:.16rem;color:#8996a7;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase}
    .ecc-launch-card-field strong{display:block;color:#eef4fb;font-size:.78rem;line-height:1.35;overflow-wrap:anywhere}
    .ecc-launch-progress{width:100%;height:6px;border:0;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.1);appearance:none}
    .ecc-launch-progress::-webkit-progress-bar{background:rgba(255,255,255,.1)}
    .ecc-launch-progress::-webkit-progress-value{background:#38bdf8}
    .ecc-launch-progress::-moz-progress-bar{background:#38bdf8}
    .ecc-launch-log{display:grid;gap:.28rem;max-height:104px;overflow:auto;padding:.55rem;border:1px solid rgba(255,255,255,.08);border-radius:5px;background:rgba(0,0,0,.16)}
    .ecc-launch-log small{color:#aebccf;font-size:.7rem;line-height:1.35}
    @media(max-width:720px){.ecc-launch-card-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!['eccLaunchForm','gateForm'].includes(form.id)) return;
    const button = form.querySelector('button[type="submit"].primary-action');
    if (!button) return;
    button.classList.remove('apie-cta-armed','apie-cta-running','apie-cta-failed');
    button.classList.add('apie-cta-initiated');
    button.setAttribute('data-cta-initiated','true');
    button.setAttribute('aria-busy','true');
    if(form.id==='eccLaunchForm') button.textContent='MISSION INITIATED';
  }, true);

  document.addEventListener('input', event => {
    const form = event.target?.closest?.('form');
    if (!form || !['eccLaunchForm','gateForm'].includes(form.id)) return;
    const button = form.querySelector('button[type="submit"].primary-action');
    if (!button) return;
    button.classList.remove('apie-cta-initiated','apie-cta-running','apie-cta-failed');
    button.removeAttribute('data-cta-initiated');
    button.removeAttribute('aria-busy');
  });

  window.addEventListener('DOMContentLoaded', () => {
    const form=document.getElementById('eccLaunchForm');
    const task=document.getElementById('eccMissionType');
    const state=document.getElementById('eccMissionState');
    const config=document.getElementById('eccTaskConfiguration');
    const agent=document.getElementById('eccAgentDisplay');
    const execute=form?.querySelector('.ecc-execute');
    if(!form||!task||!state||!config||!agent||!execute)return;

    const stateStep=state.closest('label');
    const agentStep=agent.closest('label');
    let focusedRunId=null;
    let missionStartedAt=0;
    let missionLabel='';
    let missionLog=[];
    let pollTimer=null;

    const card=document.createElement('section');
    card.id='eccLaunchCard';
    card.className='ecc-launch-card';
    card.hidden=true;
    card.setAttribute('aria-live','polite');
    card.innerHTML=`
      <div class="ecc-launch-card-head">
        <div><p class="ecc-launch-card-kicker">LIVE MISSION</p><p id="eccLaunchCardTitle" class="ecc-launch-card-title">Waiting for mission</p></div>
        <span id="eccLaunchCardStatus" class="ecc-launch-card-status">PENDING</span>
      </div>
      <div class="ecc-launch-card-grid">
        <div class="ecc-launch-card-field"><small>Mission ID</small><strong id="eccLaunchCardId">Pending assignment</strong></div>
        <div class="ecc-launch-card-field"><small>Current Stage</small><strong id="eccLaunchCardStage">Submission initiated</strong></div>
        <div class="ecc-launch-card-field"><small>Progress</small><strong id="eccLaunchCardProgressText">0%</strong></div>
        <div class="ecc-launch-card-field"><small>Started</small><strong id="eccLaunchCardStarted">—</strong></div>
      </div>
      <progress id="eccLaunchCardProgress" class="ecc-launch-progress" max="100" value="0"></progress>
      <div id="eccLaunchCardLog" class="ecc-launch-log"><small>Waiting for execution telemetry…</small></div>`;
    document.getElementById('eccLaunchMessage')?.insertAdjacentElement('afterend',card);

    const show=(el,visible)=>{
      if(!el)return;
      const wasHidden=el.classList.contains('ecc-step-hidden');
      el.classList.toggle('ecc-step-hidden',!visible);
      if(visible&&wasHidden){el.classList.remove('ecc-progressive-step');void el.offsetWidth;el.classList.add('ecc-progressive-step')}
    };
    const selectionComplete=select=>Boolean(select&&!select.disabled&&select.value);

    function processContainer(container,unlocked=true){
      for(const child of Array.from(container.children)){
        if(child.id==='eccPublisherFields'){
          show(child,unlocked);
          if(unlocked)unlocked=processContainer(child,unlocked);
          continue;
        }
        if(child.matches?.('label')){
          show(child,unlocked);
          const select=child.querySelector('select[required]');
          if(unlocked&&select&&!selectionComplete(select))unlocked=false;
          continue;
        }
        show(child,unlocked);
      }
      return unlocked;
    }

    function refreshFlow(){
      const hasTask=Boolean(task.value);
      show(stateStep,hasTask);
      const hasState=hasTask&&Boolean(state.value);
      show(config,hasState);
      let ready=hasState;
      if(hasState)ready=processContainer(config,true);
      const dynamic=config.querySelectorAll('select[required]');
      if(hasState&&dynamic.length)ready=ready&&Array.from(dynamic).every(selectionComplete);
      show(agentStep,ready);
      show(execute,ready);
      if(ready&&!execute.classList.contains('apie-cta-initiated')&&!execute.classList.contains('apie-cta-running')){
        execute.classList.remove('apie-cta-failed');
        execute.classList.add('apie-cta-armed');
        execute.textContent='EXECUTE — ARMED';
        execute.removeAttribute('aria-busy');
      }
    }

    function addLog(stage){
      const clean=String(stage||'').trim();
      if(!clean||missionLog.at(-1)?.stage===clean)return;
      missionLog.push({stage:clean,time:new Date()});
      missionLog=missionLog.slice(-5);
      const log=document.getElementById('eccLaunchCardLog');
      if(log)log.innerHTML=missionLog.map(item=>`<small>${item.time.toLocaleTimeString()} · ${item.stage.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</small>`).join('');
    }

    function updateCard(run={}){
      card.hidden=false;
      const status=String(run.status||'queued').toUpperCase();
      const stage=String(run.current_stage||run.stage||'POSTGRES EXECUTION REQUESTED');
      const progress=Math.max(0,Math.min(100,Number(run.progress_value??0)||0));
      const started=run.started_at||run.created_at||(missionStartedAt?new Date(missionStartedAt).toISOString():null);
      document.getElementById('eccLaunchCardTitle').textContent=run.mission_name||missionLabel||'Task Force Mission';
      document.getElementById('eccLaunchCardStatus').textContent=status;
      document.getElementById('eccLaunchCardId').textContent=run.id||focusedRunId||'Pending assignment';
      document.getElementById('eccLaunchCardStage').textContent=stage.replaceAll('_',' ');
      document.getElementById('eccLaunchCardProgressText').textContent=`${progress.toFixed(0)}%`;
      document.getElementById('eccLaunchCardStarted').textContent=started?new Date(started).toLocaleTimeString():'—';
      document.getElementById('eccLaunchCardProgress').value=progress;
      addLog(stage.replaceAll('_',' '));
      if(run.last_error)addLog(`ERROR: ${run.last_error}`);
      if(run.result_summary&&['COMPLETED','FAILED'].includes(status))addLog(run.result_summary);
    }

    async function pollFocusedRun(){
      if(!focusedRunId||typeof invoke!=='function')return;
      try{
        const data=await invoke('command-executive-status',{});
        const runs=[...(data.active_runs||[]),...(data.attention_runs||[]),...(data.runs||[])];
        const run=runs.find(item=>String(item.id)===String(focusedRunId));
        if(!run)return;
        updateCard(run);
        const status=String(run.status||'').toUpperCase();
        if(['COMPLETED','FAILED','CANCELLED','STOPPED'].includes(status)){
          clearInterval(pollTimer);pollTimer=null;
          execute.classList.remove('apie-cta-initiated','apie-cta-running','apie-cta-armed');
          execute.removeAttribute('aria-busy');
          if(status==='COMPLETED'){
            execute.classList.add('apie-cta-armed');execute.textContent='EXECUTE — READY';
          }else{
            execute.classList.add('apie-cta-failed');execute.textContent='MISSION NEEDS REVIEW';
          }
        }
      }catch(error){addLog(`Telemetry unavailable: ${error.message||error}`)}
    }

    const beginOriginal=window.eccBeginTaskForce;
    window.eccBeginTaskForce=(missionType,stateCode)=>{
      missionStartedAt=Date.now();
      missionLabel=`${task.selectedOptions?.[0]?.textContent?.trim()||missionType} — ${state.selectedOptions?.[0]?.textContent?.trim()||stateCode||''}`;
      focusedRunId=null;missionLog=[];card.hidden=false;
      updateCard({status:'SUBMITTING',current_stage:'COMMAND SUBMISSION',progress_value:1,mission_name:missionLabel,started_at:new Date(missionStartedAt).toISOString()});
      return beginOriginal?.(missionType,stateCode);
    };

    const focusOriginal=window.eccFocusTaskForce;
    window.eccFocusTaskForce=runId=>{
      focusedRunId=runId?String(runId):null;
      execute.classList.remove('apie-cta-initiated','apie-cta-armed','apie-cta-failed');
      execute.classList.add('apie-cta-running');
      execute.textContent='MISSION RUNNING';
      execute.setAttribute('aria-busy','true');
      updateCard({id:focusedRunId,status:'QUEUED',current_stage:'POSTGRES EXECUTION QUEUED',progress_value:5,mission_name:missionLabel,started_at:new Date(missionStartedAt||Date.now()).toISOString()});
      clearInterval(pollTimer);pollTimer=setInterval(pollFocusedRun,10000);pollFocusedRun();
      return focusOriginal?.(runId);
    };

    const clearOriginal=window.eccClearTaskForceMonitor;
    window.eccClearTaskForceMonitor=()=>{
      clearInterval(pollTimer);pollTimer=null;
      if(execute.classList.contains('apie-cta-initiated')){
        execute.classList.remove('apie-cta-initiated','apie-cta-running','apie-cta-armed');
        execute.classList.add('apie-cta-failed');
        execute.textContent='MISSION NOT LAUNCHED';
        execute.removeAttribute('aria-busy');
        updateCard({id:focusedRunId,status:'ERROR',current_stage:'SUBMISSION FAILED',progress_value:0,mission_name:missionLabel,started_at:new Date(missionStartedAt||Date.now()).toISOString()});
      }
      return clearOriginal?.();
    };

    form.addEventListener('change',()=>setTimeout(refreshFlow,0));
    form.addEventListener('input',()=>setTimeout(refreshFlow,0));
    const observer=new MutationObserver(()=>setTimeout(refreshFlow,0));
    observer.observe(config,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
    window.addEventListener('apie:authenticated',()=>setTimeout(refreshFlow,0));
    refreshFlow();
  });
})();

(() => {
  const script = document.createElement('script');
  script.src = 'assets/multi-agent-ui.js';
  script.defer = true;
  document.head.appendChild(script);
})();
