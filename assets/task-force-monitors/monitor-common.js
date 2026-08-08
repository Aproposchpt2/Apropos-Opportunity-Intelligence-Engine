(function(root){
  'use strict';

  const NOT_REPORTED='NOT REPORTED';
  const TERMINAL_SUCCESS=new Set(['completed','completed_with_warnings','completed_with_failures','partially_complete']);
  const TERMINAL_FAILURE=new Set(['failed','blocked','interrupted']);
  const STOPPED=new Set(['stopped','cancelled','canceled']);

  const lower=value=>String(value??'').trim().toLowerCase();
  const upper=value=>String(value??'').trim().toUpperCase();
  const reported=value=>value!==undefined&&value!==null&&value!=='';
  const ms=value=>value?new Date(value).getTime():0;
  const secondsSince=(value,now=Date.now())=>value?Math.max(0,Math.floor((now-ms(value))/1000)):null;

  function get(source,path){
    if(!source||!path)return undefined;
    return String(path).split('.').reduce((value,key)=>value==null?undefined:value[key],source);
  }

  function pick(run,paths){
    for(const path of paths||[]){
      const value=get(run,path);
      if(reported(value))return value;
    }
    return undefined;
  }

  function hasAny(run,paths){return (paths||[]).some(path=>reported(get(run,path)))}
  function hasAll(run,paths){return (paths||[]).every(path=>reported(get(run,path)))}

  function count(value){
    if(!reported(value))return NOT_REPORTED;
    const numeric=Number(value);
    return Number.isFinite(numeric)?numeric.toLocaleString():String(value);
  }

  function percent(value){
    if(!reported(value))return NOT_REPORTED;
    const numeric=Number(value);
    return Number.isFinite(numeric)?`${Math.round(numeric)}%`:String(value);
  }

  function boolean(value){
    if(!reported(value))return NOT_REPORTED;
    if(value===true||String(value).toLowerCase()==='true')return'YES';
    if(value===false||String(value).toLowerCase()==='false')return'NO';
    return String(value);
  }

  function timestamp(value){return reported(value)?new Date(value).toLocaleString():NOT_REPORTED}

  function duration(run){
    const start=ms(run.started_at||run.created_at);
    const end=ms(run.completed_at||run.last_activity_at||run.updated_at)||Date.now();
    if(!start)return NOT_REPORTED;
    const total=Math.max(0,Math.floor((end-start)/1000));
    const h=String(Math.floor(total/3600)).padStart(2,'0');
    const m=String(Math.floor((total%3600)/60)).padStart(2,'0');
    const s=String(total%60).padStart(2,'0');
    return`${h}:${m}:${s}`;
  }

  function format(value,type='text'){
    if(type==='count')return count(value);
    if(type==='percent')return percent(value);
    if(type==='boolean')return boolean(value);
    if(type==='timestamp')return timestamp(value);
    if(type==='json')return reported(value)?JSON.stringify(value):NOT_REPORTED;
    return reported(value)?String(value):NOT_REPORTED;
  }

  function workerClaimed(run){
    const explicit=pick(run,['execution_evidence.worker_claimed','monitor_evidence.worker_claimed','command_tasks.0.started_at','command_task_attempts.0.started_at']);
    if(reported(explicit))return explicit===true||String(explicit).toLowerCase()==='true';
    return Boolean(run.started_at)&&!['queued','pending'].includes(lower(run.status));
  }

  function currentRecord(run){
    return pick(run,['execution_evidence.current_document','execution_evidence.current_contract','execution_evidence.current_record','execution_evidence.current_page','execution_evidence.current_batch','execution_evidence.current_entity_class','execution_evidence.entityClass','monitor_evidence.current_operation']);
  }

  function state(run,monitor,now=Date.now()){
    const raw=lower(run.status||run.aadp_state);
    if(STOPPED.has(raw)||upper(run.current_stage).includes('STOPPED')||upper(run.aadp_state)==='CANCELLED')return{key:'STOPPED',derived:false,secondsWithoutActivity:secondsSince(run.last_activity_at||run.updated_at||run.created_at,now)};
    if(TERMINAL_FAILURE.has(raw)||upper(run.aadp_state)==='FAILED')return{key:raw==='blocked'?'BLOCKED':'FAILED',derived:false,secondsWithoutActivity:secondsSince(run.last_activity_at||run.updated_at||run.created_at,now)};
    if(TERMINAL_SUCCESS.has(raw)||upper(run.aadp_state)==='COMPLETED'){
      const warnings=Number(run.warning_count||0),failures=Number(run.failure_count||0);
      return{key:warnings||failures||raw!=='completed'?'COMPLETED_WITH_WARNINGS':'COMPLETED',derived:false,secondsWithoutActivity:0};
    }
    const queued=['queued','pending'].includes(raw);
    const running=['running','processing','retrying','stopping'].includes(raw);
    const last=run.last_activity_at||run.updated_at||run.started_at||run.created_at;
    const age=secondsSince(last,now)??0;
    const thresholds=monitor?.stallThresholds||{};
    const queuedThreshold=Number(thresholds.queued||60);
    let runningThreshold=Number(thresholds.running||120);
    if(monitor?.key==='CONTRACT_PACKAGE_ACQUISITION'&&currentRecord(run))runningThreshold=Number(thresholds.document||300);
    if(queued&&!workerClaimed(run)&&age>queuedThreshold)return{key:'STALLED',derived:true,authoritative:'QUEUED',secondsWithoutActivity:age,threshold:queuedThreshold};
    if(running&&age>runningThreshold)return{key:'STALLED',derived:true,authoritative:'RUNNING',secondsWithoutActivity:age,threshold:runningThreshold};
    if(queued)return{key:'QUEUED',derived:false,secondsWithoutActivity:age};
    if(running)return{key:'RUNNING',derived:false,secondsWithoutActivity:age};
    return{key:upper(run.status||run.aadp_state||'UNKNOWN'),derived:false,secondsWithoutActivity:age};
  }

  function matchesCurrentStage(run,patterns){
    const current=upper(run.current_stage);
    const prior=upper(get(run,'execution_evidence.prior_stage'));
    return (patterns||[]).some(pattern=>current.includes(upper(pattern))||prior.includes(upper(pattern)));
  }

  function evidenceForStage(run,stage){
    if(typeof stage.completionTest==='function')return stage.completionTest(run)===true;
    const paths=stage.completionEvidence||stage.evidence||[];
    return stage.requireAll?hasAll(run,paths):hasAny(run,paths);
  }

  function activeStageIndex(run,monitor){
    const stages=monitor.stages||[];
    const currentIndex=stages.findIndex(stage=>matchesCurrentStage(run,stage.currentStages));
    const evidenced=stages.map((stage,i)=>evidenceForStage(run,stage)?i:-1).filter(i=>i>=0);
    const evidenceIndex=evidenced.length?Math.min(stages.length-1,Math.max(...evidenced)+1):-1;
    if(currentIndex>=0&&evidenceIndex>=0)return Math.max(currentIndex,evidenceIndex);
    if(currentIndex>=0)return currentIndex;
    if(evidenceIndex>=0)return evidenceIndex;
    return 0;
  }

  function stageStatus(run,monitor,stage,index,runState){
    const evidenced=evidenceForStage(run,stage);
    const active=activeStageIndex(run,monitor);
    const isActive=index===active;
    if(runState.key==='STOPPED'){if(isActive)return'STOPPED';return evidenced?'COMPLETED':'NOT REPORTED'}
    if(runState.key==='FAILED'||runState.key==='BLOCKED'){if(isActive)return runState.key;return evidenced?'COMPLETED':'NOT REPORTED'}
    if(runState.key==='COMPLETED'||runState.key==='COMPLETED_WITH_WARNINGS'){
      if(!evidenced)return'NOT REPORTED';
      if(index===monitor.stages.length-1&&runState.key==='COMPLETED_WITH_WARNINGS')return'WARNING';
      return'COMPLETED';
    }
    if(runState.key==='QUEUED')return index===0?'QUEUED':'PENDING';
    if(runState.key==='RUNNING'||runState.key==='STALLED'){
      if(isActive)return runState.key;
      if(evidenced)return'COMPLETED';
      return index<active?'NOT REPORTED':'PENDING';
    }
    return evidenced?'COMPLETED':'NOT REPORTED';
  }

  function detail(run,stage){
    if(typeof stage.detail==='function')return stage.detail(run);
    for(const item of stage.detailFields||[]){
      const value=pick(run,item.paths||[]);
      if(reported(value))return`${item.label}: ${format(value,item.type)}`;
    }
    return stage.emptyDetail||'No stage evidence reported.';
  }

  function metrics(run,monitor){
    return (monitor.metrics||[]).map(metric=>{
      const value=typeof metric.value==='function'?metric.value(run):pick(run,metric.paths||[]);
      return{label:metric.label,value:format(value,metric.type),reported:reported(value)};
    });
  }

  function summarize(run,items){
    const parts=[];
    for(const item of items||[]){
      const value=pick(run,item.paths||[]);
      if(reported(value))parts.push(`${item.label}: ${format(value,item.type)}`);
    }
    return parts.length?parts.join(' · '):'No supporting evidence reported.';
  }

  root.APIEMonitorCommon={NOT_REPORTED,lower,upper,reported,get,pick,hasAny,hasAll,count,percent,boolean,timestamp,duration,format,workerClaimed,currentRecord,state,matchesCurrentStage,evidenceForStage,activeStageIndex,stageStatus,detail,metrics,summarize,secondsSince};
})(typeof window!=='undefined'?window:globalThis);
