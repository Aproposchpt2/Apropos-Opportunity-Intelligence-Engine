import { createHash } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';
import { resolveConnector } from './_shared/acquisition-connectors/index.js';

const now=()=>new Date().toISOString();
const txt=v=>String(v??'').trim();
const hash=v=>createHash('sha256').update(String(v)).digest('hex');

async function patchRun(id,values){
  await db(`command_runs?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({...values,last_activity_at:now()})});
}
async function latestReadyAssignment(publisherId){
  return (await db(`publisher_assignments?publisher_id=eq.${encodeURIComponent(publisherId)}&status=eq.READY&select=*&order=updated_at.desc&limit=1`))?.[0]||null;
}
async function insertRawRows(rows){
  if(!rows.length)return[];
  return await db('acquisition_raw_records?on_conflict=acquisition_run_id,publisher_id,source_record_id,source_fingerprint',{
    method:'POST',body:JSON.stringify(rows),headers:{Prefer:'resolution=ignore-duplicates,return=representation'}
  })||[];
}
async function routeAcquisitionRun(acquisitionRunId,batchSize=500){
  const totals={claimed:0,canonical_inserted:0,duplicates:0,extraction_required:0,contact_required:0,rejected:0};
  for(let pass=0;pass<20;pass++){
    const result=await db('rpc/aadp_route_pending_raw_records',{method:'POST',body:JSON.stringify({p_batch_size:batchSize,p_acquisition_run_id:acquisitionRunId})})||{};
    for(const key of Object.keys(totals))totals[key]+=Number(result[key]||0);
    if(Number(result.claimed||0)===0)break;
  }
  const remaining=await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&processing_status=eq.RAW&select=id`);
  return {...totals,remaining_raw:remaining?.length||0,ruleset:'NATCORP-CONTRACT-QUALIFICATION-V3'};
}
async function previousPublisherSnapshot(publisherId,currentRunId){
  const rows=await db(`acquisition_raw_records?publisher_id=eq.${encodeURIComponent(publisherId)}&acquisition_run_id=neq.${encodeURIComponent(currentRunId)}&select=acquisition_run_id,source_record_id,retrieval_timestamp&order=retrieval_timestamp.desc&limit=1000`);
  if(!rows?.length)return[];
  const latestRun=rows[0].acquisition_run_id;
  return rows.filter(r=>r.acquisition_run_id===latestRun).map(r=>r.source_record_id);
}
async function upsertAcceptance({publisher,connector,commandRunId,acquisitionRunId,totalReported,acquired,routing,duplicates,reconciliationStatus,qualificationStatus,validationStatus,diagnostics}){
  await db('connector_acceptance_registry?on_conflict=publisher_id,connector_key,connector_version',{
    method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({
      publisher_id:publisher.id,connector_key:connector.key,connector_version:'1.0',acceptance_status:'TESTING',
      last_command_run_id:commandRunId,last_acquisition_run_id:acquisitionRunId,publisher_reported_total:totalReported,
      records_acquired:acquired,records_qualified:Number(routing.canonical_inserted||0),extraction_required:Number(routing.extraction_required||0),
      contact_required:Number(routing.contact_required||0),records_rejected:Number(routing.rejected||0),duplicates,
      reconciliation_status:reconciliationStatus,qualification_status:qualificationStatus,validation_status:validationStatus,
      acceptance_evidence:{diagnostics,qualification:routing},tested_at:now(),updated_at:now()
    })
  });
}

export const handler=async event=>{
  if(event?.httpMethod!=='POST')return response(405,{error:'Method not allowed'});
  if(!requireDashboardAuth(event))return response(401,{error:'Unauthorized'});
  const body=parseBody(event),commandRunId=txt(body.command_run_id),stateCode=txt(body.state_code).toUpperCase(),publisherId=txt(body.publisher_id);
  if(!commandRunId||!/^[A-Z]{2}$/.test(stateCode)||!publisherId)return response(400,{error:'command_run_id, state_code, and publisher_id are required.'});

  let acquisitionRunId=null;
  try{
    await patchRun(commandRunId,{status:'running',aadp_state:'RUNNING',current_stage:'RESOLVING_SINGLE_PUBLISHER_CONNECTOR',progress_value:5,reconciliation_status:'PENDING',qualification_status:'PENDING',validation_status:'PENDING',result_summary:'Resolving the approved connector for one publisher.'});
    const publisher=(await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${stateCode}&verified=eq.true&select=*`))?.[0];
    if(!publisher)throw new Error('The selected verified publisher was not found for this state.');
    const assignment=await latestReadyAssignment(publisherId);
    if(!assignment)throw new Error('The selected publisher has no READY acquisition assignment.');
    const connector=resolveConnector({publisher,assignment});
    const endpoint=txt(assignment.search_endpoint||publisher.search_endpoint||publisher.procurement_website||publisher.official_website);
    const run=(await db('acquisition_runs',{method:'POST',body:JSON.stringify({command_run_id:commandRunId,assignment_id:assignment.id,status:'RUNNING',started_at:now(),reconciliation_status:'PENDING',qualification_status:'PENDING',validation_status:'PENDING',evidence:{execution_mode:'SINGLE_PUBLISHER',connector_key:connector.key,publisher_id:publisher.id,publisher_name:publisher.publisher_name,endpoint}})}))?.[0];
    acquisitionRunId=run?.id;
    if(!acquisitionRunId)throw new Error('Acquisition run creation failed.');

    const result=await connector.acquire({endpoint,onPage:async progress=>{
      const percentage=Math.min(85,10+Math.round((progress.page/Math.max(progress.totalPages,1))*75));
      await patchRun(commandRunId,{current_stage:'ACQUIRING_SINGLE_PUBLISHER',progress_value:percentage,records_discovered:progress.page===progress.totalPages?progress.totalReported:undefined,result_summary:`${publisher.publisher_name}: page ${progress.page} of ${progress.totalPages}.`});
    }});
    const rawRows=result.records.map(record=>{
      const sourceId=txt(record.source_record_id||record.solicitation_number),sourceUrl=txt(record.source_url||result.source_url||endpoint),serialized=JSON.stringify(record);
      return {acquisition_run_id:acquisitionRunId,assignment_id:assignment.id,publisher_id:publisher.id,source_record_id:sourceId,source_url:sourceUrl,raw_payload:{...record,__connector_key:connector.key,__source_page_type:'SOLICITATION_LISTING',__execution_mode:'SINGLE_PUBLISHER'},source_fingerprint:hash(`${publisher.id}:${sourceId}:${sourceUrl}`),content_fingerprint:hash(serialized),processing_status:'RAW',detail_retrieval_status:'LISTING_COMPLETE',detail_retrieved_at:now()};
    });
    const inserted=await insertRawRows(rawRows),ingestionDuplicates=rawRows.length-inserted.length;
    await patchRun(commandRunId,{current_stage:'POSTGRES_QUALIFICATION_ROUTING',progress_value:92,records_discovered:rawRows.length,records_acquired:inserted.length,qualification_status:'RUNNING',result_summary:`${publisher.publisher_name}: acquisition complete; PostgreSQL qualification is processing this run.`});
    const routing=await routeAcquisitionRun(acquisitionRunId,Math.max(500,rawRows.length));
    if(routing.remaining_raw>0)throw new Error(`PostgreSQL qualification incomplete: ${routing.remaining_raw} records remain RAW for this run.`);

    const totalReported=Number(result.total_reported||0),difference=totalReported?rawRows.length-totalReported:0,countMatches=result.reconciliation?.count_matches!==false&&(!totalReported||difference===0);
    const previousIds=await previousPublisherSnapshot(publisher.id,acquisitionRunId),currentIds=new Set(rawRows.map(r=>r.source_record_id));
    const missingFromCurrent=previousIds.filter(id=>!currentIds.has(id));
    const reconciliationStatus=countMatches?'MATCHED':(Math.abs(difference)<=Math.max(1,Math.ceil(totalReported*.02))?'PARTIAL':'MISMATCH');
    const qualificationStatus='COMPLETED',validationStatus=countMatches?'PASSED':'WARNING';
    const diagnostics={publisher_reported_total:totalReported||null,records_collected:rawRows.length,difference,missing_from_previous_snapshot:missingFromCurrent.slice(0,100),missing_count:missingFromCurrent.length,count_matches:countMatches,pages_processed:result.pages_processed};
    const completedAt=now(),accepted=Number(routing.canonical_inserted||0),rejected=Number(routing.rejected||0)+Number(routing.contact_required||0),allDuplicates=ingestionDuplicates+Number(routing.duplicates||0);

    await db(`acquisition_runs?id=eq.${acquisitionRunId}`,{method:'PATCH',body:JSON.stringify({status:countMatches?'COMPLETED':'PARTIALLY_COMPLETE',records_discovered:rawRows.length,records_acquired:inserted.length,pages_processed:result.pages_processed,pagination_complete:countMatches,completed_at:completedAt,reconciliation_status:reconciliationStatus,qualification_status:qualificationStatus,validation_status:validationStatus,evidence:{connector_key:connector.key,execution_mode:'SINGLE_PUBLISHER',publisher_reported_total:totalReported||null,unique_records:rawRows.length,inserted_records:inserted.length,ingestion_duplicates:ingestionDuplicates,reconciliation:diagnostics,qualification:routing}})});
    await patchRun(commandRunId,{status:'completed',aadp_state:'COMPLETED',current_stage:'COMPLETED',progress_value:100,records_discovered:rawRows.length,records_acquired:inserted.length,records_accepted:accepted,records_rejected:rejected,failure_count:0,warning_count:countMatches?0:1,action_required:!countMatches,completed_at:completedAt,reconciliation_status:reconciliationStatus,qualification_status:qualificationStatus,validation_status:validationStatus,qualification_summary:routing,reconciliation_diagnostics:diagnostics,reconciliation:diagnostics,result_summary:`${publisher.publisher_name}: ${rawRows.length}/${totalReported||'unknown'} collected; qualification complete — ${accepted} accepted, ${routing.extraction_required} extraction required, ${routing.contact_required} contact required, ${routing.rejected} rejected, ${allDuplicates} duplicates. Reconciliation ${reconciliationStatus}; validation ${validationStatus}.`,execution_evidence:{connector_key:connector.key,publisher_id:publisher.id,reconciliation:diagnostics,qualification:routing,ingestion_duplicates:ingestionDuplicates}});
    await upsertAcceptance({publisher,connector,commandRunId,acquisitionRunId,totalReported:totalReported||null,acquired:rawRows.length,routing,duplicates:allDuplicates,reconciliationStatus,qualificationStatus,validationStatus,diagnostics});
    return response(200,{ok:true,command_run_id:commandRunId,acquisition_run_id:acquisitionRunId,publisher_id:publisher.id,publisher_name:publisher.publisher_name,connector_key:connector.key,total_reported:totalReported||null,records_collected:rawRows.length,records_inserted:inserted.length,records_accepted:accepted,records_rejected:rejected,duplicates:allDuplicates,extraction_required:routing.extraction_required,contact_required:routing.contact_required,pages_processed:result.pages_processed,reconciliation_status:reconciliationStatus,qualification_status:qualificationStatus,validation_status:validationStatus,reconciliation:diagnostics,qualification:routing});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error('command-single-publisher-acquisition-background failed',error);
    if(acquisitionRunId)await db(`acquisition_runs?id=eq.${acquisitionRunId}`,{method:'PATCH',body:JSON.stringify({status:'FAILED',retrieval_failures:1,completed_at:now(),qualification_status:'FAILED',validation_status:'FAILED',evidence:{error:message,execution_mode:'SINGLE_PUBLISHER'}})}).catch(()=>null);
    await patchRun(commandRunId,{status:'failed',aadp_state:'FAILED',current_stage:'QUALIFICATION_OR_ACQUISITION_FAILED',progress_value:100,failure_count:1,action_required:true,completed_at:now(),qualification_status:'FAILED',validation_status:'FAILED',result_summary:message}).catch(()=>null);
    return response(500,{error:message});
  }
};