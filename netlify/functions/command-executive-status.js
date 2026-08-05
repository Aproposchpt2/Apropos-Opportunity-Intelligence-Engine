import { response, requireDashboardAuth, db } from './_shared/native-runtime.js';

const lower=value=>String(value||'').toLowerCase();
const errorMessage=reason=>reason instanceof Error?reason.message:String(reason||'Unknown read failure');

async function safeRead(label,query){
  try{return{label,ok:true,data:await db(query),error:null}}
  catch(error){console.error(`command-executive-status ${label} read failed`,error);return{label,ok:false,data:[],error:errorMessage(error)}}
}

const groupBy=(rows,key)=>rows.reduce((map,row)=>{
  const value=row?.[key];
  if(value){if(!map.has(value))map.set(value,[]);map.get(value).push(row)}
  return map;
},new Map());

const latestBy=(rows,key)=>rows.reduce((map,row)=>{
  const value=row?.[key];
  if(value&&!map.has(value))map.set(value,row);
  return map;
},new Map());

const evidencePublisherId=run=>run?.execution_evidence?.publisher_id||run?.mission_config?.publisher_id||null;

export const handler=async event=>{
  if(event?.httpMethod==='OPTIONS')return response(200,{ok:true});
  if(event?.httpMethod!=='POST')return response(405,{error:'Method not allowed'});
  if(!requireDashboardAuth(event))return response(401,{error:'Unauthorized'});

  try{
    const results=await Promise.all([
      safeRead('command_runs','command_runs?select=*&order=created_at.desc&limit=100'),
      safeRead('command_missions','command_missions?select=*&order=created_at.desc&limit=200'),
      safeRead('command_tasks','command_tasks?select=*&order=created_at.desc&limit=500'),
      safeRead('command_task_attempts','command_task_attempts?select=*&order=started_at.desc&limit=500'),
      safeRead('publisher_registry','publisher_registry?select=*&order=updated_at.desc&limit=500'),
      safeRead('publisher_assignments','publisher_assignments?select=*&order=updated_at.desc&limit=500'),
      safeRead('connector_acceptance_registry','connector_acceptance_registry?select=*&order=updated_at.desc&limit=500'),
      safeRead('publisher_discovery_runs','publisher_discovery_runs?select=*&order=created_at.desc&limit=200'),
      safeRead('publisher_discovery_candidates','publisher_discovery_candidates?select=id,discovery_run_id,official_source_verified,duplicate_status,review_status,admitted_publisher_id,access_class,connector_strategy,engineering_complexity,created_at&order=created_at.desc&limit=1000'),
      safeRead('acquisition_runs','acquisition_runs?select=*&order=created_at.desc&limit=200'),
      safeRead('acquisition_raw_records','acquisition_raw_records?select=id,acquisition_run_id,publisher_id,processing_status,retrieval_timestamp,package_status,package_document_count,package_extracted_count,package_failed_count,match_readiness_status&order=retrieval_timestamp.desc&limit=1000'),
      safeRead('contract_package_documents','contract_package_documents?select=id,acquisition_run_id,publisher_id,byte_size,sha256,document_type,is_addendum,is_amendment,retrieval_status,extraction_status,retrieved_at,extracted_at&order=created_at.desc&limit=2000'),
      safeRead('system_status','system_status?singleton=eq.true&select=*')
    ]);

    const byLabel=Object.fromEntries(results.map(result=>[result.label,result]));
    if(!byLabel.command_runs.ok){
      return response(503,{error:'Executive status cannot load the authoritative command run stream.',degraded_reads:results.filter(item=>!item.ok).map(item=>({source:item.label,error:item.error})),generated_at:new Date().toISOString()});
    }

    const rows=label=>byLabel[label]?.data||[];
    const runs=rows('command_runs');
    const tasks=rows('command_tasks');
    const attempts=rows('command_task_attempts');
    const publishers=rows('publisher_registry');
    const assignments=rows('publisher_assignments');
    const acceptances=rows('connector_acceptance_registry');
    const discoveryRuns=rows('publisher_discovery_runs');
    const discoveryCandidates=rows('publisher_discovery_candidates');
    const acquisitionRuns=rows('acquisition_runs');
    const rawRecords=rows('acquisition_raw_records');
    const packageDocuments=rows('contract_package_documents');
    const systemRows=rows('system_status');
    const degradedReads=results.filter(item=>!item.ok).map(item=>({source:item.label,error:item.error}));

    const tasksByRun=groupBy(tasks,'run_id');
    const attemptsByTask=groupBy(attempts,'task_id');
    const publisherById=new Map(publishers.map(row=>[row.id,row]));
    const assignmentById=new Map(assignments.map(row=>[row.id,row]));
    const assignmentsByPublisher=latestBy(assignments,'publisher_id');
    const acceptanceByPublisher=latestBy(acceptances,'publisher_id');
    const discoveryByCommandRun=latestBy(discoveryRuns,'command_run_id');
    const candidatesByDiscovery=groupBy(discoveryCandidates,'discovery_run_id');
    const acquisitionByCommandRun=latestBy(acquisitionRuns,'command_run_id');
    const rawByAcquisition=groupBy(rawRecords,'acquisition_run_id');
    const docsByAcquisition=groupBy(packageDocuments,'acquisition_run_id');

    const enrichedRuns=runs.map(run=>{
      const commandTasks=tasksByRun.get(run.id)||[];
      const commandTaskAttempts=commandTasks.flatMap(task=>attemptsByTask.get(task.id)||[]);
      const publisherId=evidencePublisherId(run)||assignmentById.get(run.publisher_assignment_id)?.publisher_id||null;
      const publisher=publisherById.get(publisherId)||null;
      const assignment=assignmentById.get(run.publisher_assignment_id)||assignmentsByPublisher.get(publisherId)||null;
      const connectorAcceptance=acceptanceByPublisher.get(publisherId)||null;
      const discoveryRun=discoveryByCommandRun.get(run.id)||null;
      const candidateRows=discoveryRun?candidatesByDiscovery.get(discoveryRun.id)||[]:[];
      const acquisitionRun=acquisitionByCommandRun.get(run.id)||null;
      const acquisitionRaw=acquisitionRun?rawByAcquisition.get(acquisitionRun.id)||[]:[];
      const acquisitionDocuments=acquisitionRun?docsByAcquisition.get(acquisitionRun.id)||[]:[];
      const verifiedCandidates=candidateRows.filter(row=>row.official_source_verified).length;
      const classifiedCandidates=candidateRows.filter(row=>row.access_class||row.connector_strategy||row.engineering_complexity).length;

      return{
        ...run,
        publisher_name:publisher?.publisher_name||assignment?.publisher_name||run.execution_evidence?.publisher_name||null,
        command_tasks:commandTasks,
        command_task_attempts:commandTaskAttempts,
        monitor_evidence:{
          publisher,
          assignment,
          connector_acceptance:connectorAcceptance,
          discovery_run:discoveryRun,
          discovery_candidate_count:candidateRows.length,
          discovery_candidates_verified:verifiedCandidates,
          classification_count:classifiedCandidates,
          acquisition_run:acquisitionRun,
          acquisition_raw_record_count:acquisitionRaw.length,
          package_document_count:acquisitionDocuments.length,
          package_hash_verified_count:acquisitionDocuments.filter(row=>row.sha256).length,
          package_total_bytes:acquisitionDocuments.reduce((total,row)=>total+Number(row.byte_size||0),0),
          package_extracted_count:acquisitionDocuments.filter(row=>row.extraction_status==='COMPLETED'||row.extracted_at).length,
          package_extraction_failure_count:acquisitionDocuments.filter(row=>row.extraction_status==='FAILED').length,
          addenda_count:acquisitionDocuments.filter(row=>row.is_addendum).length,
          amendments_count:acquisitionDocuments.filter(row=>row.is_amendment).length,
          worker_claimed:Boolean(commandTasks.some(task=>task.started_at)||commandTaskAttempts.some(attempt=>attempt.started_at)||run.execution_evidence?.worker_claimed)
        }
      };
    });

    const activeStatuses=new Set(['queued','running','retrying','stopping']);
    const activeRuns=enrichedRuns.filter(run=>activeStatuses.has(lower(run.status)));
    const attentionRuns=enrichedRuns.filter(run=>run.action_required||['failed','interrupted','completed_with_failures','stopped'].includes(lower(run.status)));
    const operationalStatus=degradedReads.length?'DEGRADED':'OPERATIONAL';

    return response(200,{
      generated_at:new Date().toISOString(),
      system:{...(systemRows[0]||{}),operational_status:operationalStatus},
      totals:{active_missions:activeRuns.length,missions_requiring_attention:attentionRuns.length,publishers:publishers.length},
      runs:enrichedRuns,
      active_runs:activeRuns,
      attention_runs:attentionRuns,
      publisher_registry:publishers,
      acquisition:{recent_runs:acquisitionRuns,recent_raw_records:rawRecords,recent_raw_record_count:rawRecords.length,latest_run:acquisitionRuns[0]||null},
      health:{
        database:{status:degradedReads.length?'DEGRADED':'CONNECTED',source:'Netlify direct PostgREST reads',observed_at:new Date().toISOString(),degraded_reads:degradedReads},
        command_runtime:{status:activeRuns.length?'RUNNING':'IDLE',source:'command_runs',observed_at:enrichedRuns[0]?.last_activity_at||enrichedRuns[0]?.updated_at||enrichedRuns[0]?.created_at||new Date().toISOString()}
      }
    });
  }catch(error){
    console.error('command-executive-status failed',error);
    return response(500,{error:errorMessage(error)});
  }
};
