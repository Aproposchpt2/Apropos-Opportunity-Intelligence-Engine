(function(root){
  'use strict';
  const C=root.APIEMonitorCommon;
  if(!C)throw new Error('APIE Monitor Common must load before Monitor Registry.');
  const definitions=new Map(),aliases=new Map();
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const css=value=>`ecc-${String(value||'unknown').toLowerCase().replaceAll('_','-').replaceAll(' ','-')}`;

  function register(definition){
    if(!definition?.key)throw new Error('Mission monitor definition requires a key.');
    const key=C.upper(definition.key);
    definitions.set(key,{stallThresholds:{queued:60,running:120,document:300},...definition,key});
    for(const alias of definition.aliases||[])aliases.set(C.upper(alias),key);
  }
  function resolveKey(key){const normalized=C.upper(key);return aliases.get(normalized)||normalized}
  function get(key){return definitions.get(resolveKey(key))||null}
  function publisherName(run){
    const value=C.pick(run,['publisher_name','monitor_evidence.publisher.publisher_name','monitor_evidence.assignment.publisher_name','mission_config.publisher_name','execution_evidence.publisher_name']);
    return C.reported(value)?String(value):'NOT REPORTED';
  }

  function buildModel(run,now=Date.now()){
    const monitor=get(run?.mission_type_key);
    if(!monitor)return{supported:false,missionType:C.upper(run?.mission_type_key||'UNKNOWN'),title:'Unsupported mission monitor',description:'No mission-specific monitor definition is registered for this mission type.',runState:C.state(run||{},null,now),stages:[],metrics:[]};
    const runState=C.state(run,monitor,now);
    const stages=monitor.stages.map((stage,index)=>{
      const status=C.stageStatus(run,monitor,stage,index,runState);
      const progress=status==='COMPLETED'||status==='WARNING'?100:(status==='RUNNING'||status==='STALLED'?35:0);
      return{...stage,index:index+1,status,progress,detail:C.detail(run,stage)};
    });
    return{supported:true,missionType:monitor.key,displayName:monitor.displayName,description:monitor.description,reportLabel:monitor.reportLabel||'Mission Report',emptyMessage:monitor.emptyMessage||'No evidence has been reported for this mission.',runState,stages,metrics:C.metrics(run,monitor),publisherName:publisherName(run),stateCode:run.state_code||'ALL',activeAgent:run.assigned_agent||monitor.defaultAgent||C.pick(run,['command_tasks.0.assigned_agent'])||'NOT REPORTED',successCriteria:monitor.successCriteria||[],warningCriteria:monitor.warningCriteria||[],failureCriteria:monitor.failureCriteria||[],terminalEvidence:monitor.terminalEvidence||[]};
  }

  function stateLabel(model){const value=model.runState.key;return value==='COMPLETED_WITH_WARNINGS'?'COMPLETED WITH WARNINGS':String(value||'UNKNOWN').replaceAll('_',' ')}
  function stageMarkup(stage){return`<div class="ecc-stage-row ${css(stage.status)}"><div class="ecc-stage-heading"><span class="ecc-stage-number">${stage.index}</span><div><b>${esc(stage.label)}</b><small>${esc(stage.status)}</small></div><strong>${stage.progress}%</strong></div><div class="ecc-stage-detail"><span>${esc(stage.detail)}</span><small>${esc(stage.agent)}</small></div><progress class="ecc-stage-progress" max="100" value="${stage.progress}" aria-label="${esc(stage.label)} progress">${stage.progress}%</progress></div>`}
  function metricMarkup(metric){return`<span class="${metric.reported?'':'ecc-not-reported'}">${esc(metric.label)}<b>${esc(metric.value)}</b></span>`}

  function statusDetails(run,model){
    const state=model.runState.key;
    const common=[
      {label:'Authoritative Status',value:String(run.status||run.aadp_state||'UNKNOWN').toUpperCase()},
      {label:'Current Stage',value:run.current_stage||'NOT REPORTED'},
      {label:'Active Agent',value:model.activeAgent},
      {label:'Last Activity',value:C.timestamp(run.last_activity_at||run.updated_at)},
      {label:'Execution Time',value:C.duration(run)}
    ];
    if(state==='QUEUED'||state==='STALLED')common.push({label:'Worker Claimed',value:C.boolean(C.workerClaimed(run))},{label:'Seconds Without Activity',value:C.format(model.runState.secondsWithoutActivity,'count')},{label:'Dispatch State',value:C.pick(run,['execution_evidence.dispatch_state','execution_evidence.prior_stage'])||run.current_stage||'NOT REPORTED'});
    if(state==='RUNNING')common.push({label:'Current Operation',value:C.pick(run,['execution_evidence.current_operation','execution_evidence.operation','current_stage'])||'NOT REPORTED'},{label:'Current Record',value:C.currentRecord(run)||'NOT REPORTED'});
    if(state==='FAILED'||state==='BLOCKED')common.push({label:'Error Code',value:C.pick(run,['execution_evidence.error_code','command_task_attempts.0.error_code'])||'NOT REPORTED'},{label:'Error Message',value:run.result_summary||C.pick(run,['execution_evidence.error','command_task_attempts.0.error_message'])||'NOT REPORTED'},{label:'Action Required',value:C.boolean(run.action_required)},{label:'Retry Count',value:C.pick(run,['execution_evidence.retry_count','command_task_attempts.length'])??'NOT REPORTED'});
    if(state==='STOPPED')common.push({label:'Operator Stop Time',value:C.timestamp(run.stop_requested_at||run.completed_at)},{label:'Stage at Stop',value:C.pick(run,['execution_evidence.prior_stage','current_stage'])||'NOT REPORTED'},{label:'Resume Checkpoint',value:C.boolean(C.pick(run,['execution_evidence.checkpointed','execution_evidence.resume_checkpoint','resume_source_stage']))});
    if(state==='COMPLETED'||state==='COMPLETED_WITH_WARNINGS')common.push({label:'Warnings',value:C.format(run.warning_count,'count')},{label:'Failures',value:C.format(run.failure_count,'count')},{label:'Reconciliation',value:run.reconciliation_status||C.pick(run,['execution_evidence.reconciliation.status'])||'NOT REPORTED'},{label:'Validation',value:run.validation_status||'NOT REPORTED'});
    return common;
  }

  function renderCard(run,options={}){
    const model=buildModel(run,options.now||Date.now());
    const instance=run.task_force_instance_id||run.instance_id||`TF-${String(run.id||'UNKNOWN').slice(0,12).toUpperCase()}`;
    if(!model.supported)return`<article class="ecc-task-force-card ecc-unsupported"><header><div><small>TASK FORCE INSTANCE · ${esc(instance)}</small><h3>${esc(model.missionType)}</h3></div><span class="status-pill ecc-unsupported">UNSUPPORTED</span></header><div class="ecc-unsupported-monitor"><b>${esc(model.title)}</b><p>${esc(model.description)}</p><p>Mission type: ${esc(model.missionType)}</p></div></article>`;
    const state=stateLabel(model);
    const heading=`${model.displayName} · STATE: ${model.stateCode} · PUBLISHER: ${model.publisherName}`;
    const stateDetails=statusDetails(run,model);
    const reason=run.result_summary||C.pick(run,['execution_evidence.reason','execution_evidence.error']);
    const stalled=model.runState.key==='STALLED'?`<div class="ecc-stall-alert"><b>STALLED</b><span>No execution activity for ${esc(model.runState.secondsWithoutActivity)} seconds. Recommended action: verify worker dispatch and stop or resume from the last checkpoint.</span></div>`:'';
    const reportHref=run.report_reference||`/missions/?id=${encodeURIComponent(run.id||'')}`;
    return`<article class="ecc-task-force-card ${css(model.runState.key)}"><header><div><small>TASK FORCE INSTANCE · ${esc(instance)}</small><h3>${esc(heading)}</h3><p class="ecc-monitor-description">${esc(model.description)}</p></div><span class="status-pill ${css(model.runState.key)}">${esc(state)}</span></header>${stalled}<section class="ecc-stage-monitor" aria-label="${esc(model.displayName)} mission stages">${model.stages.map(stageMarkup).join('')}</section><section class="ecc-metric-section" aria-label="Task-specific metrics"><h4>Task-Specific Metrics</h4><div class="ecc-result-grid">${model.metrics.map(metricMarkup).join('')}</div></section><section class="ecc-run-state-section" aria-label="Run state evidence"><h4>Run-State Evidence</h4><div class="ecc-result-grid">${stateDetails.map(item=>`<span>${esc(item.label)}<b>${esc(item.value)}</b></span>`).join('')}</div></section>${reason?`<div class="ecc-result-reason"><span>Result Detail</span><b>${esc(reason)}</b></div>`:''}<a class="ecc-report-link" href="${esc(reportHref)}">VIEW ${esc(model.reportLabel).toUpperCase()}</a></article>`;
  }

  root.APIEMissionMonitors={register,get,buildModel,renderCard,definitions,aliases};
})(typeof window!=='undefined'?window:globalThis);
