import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

const ZIP=process.argv[2];
const EXPECTED='91aee569cb7ff82a51b20ee1cb29c0aea85731e61298967ff89538b1f4657b50';
const URL=process.env.SUPABASE_URL?.replace(/\/$/,'');
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET='solicitation-packages';
const PUBLISHER='0cf29ac8-f55b-4b46-ac2f-93d75694a318';
const ASSIGNMENT='052d5448-65fd-4070-b4ff-e6e13a157f00';
const EVENTS={
 '0000039706':{businessUnit:'7760',sourceRecordId:'7760:0000039706',canonicalId:'591c9503-1eaa-486b-880d-ca0eca4c2928',expected:12},
 '7CA07976':{businessUnit:'3540',sourceRecordId:'3540:7CA07976',canonicalId:'0b2b7937-4b0e-4f19-bd97-9cb9c5f16602',expected:3},
 '0000039831':{businessUnit:'0820',sourceRecordId:'0820:0000039831',canonicalId:'806352ab-045b-4d93-9e6c-bfd4806e84bc',expected:3}
};
if(!ZIP||!URL||!KEY) throw new Error('Required runtime input unavailable');
const headers={apikey:KEY,Authorization:`Bearer ${KEY}`};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const q=encodeURIComponent;
async function api(table,method='GET',body=null,query=''){
 const r=await fetch(`${URL}/rest/v1/${table}${query}`,{method,headers:{...headers,'Content-Type':'application/json',Prefer:'return=representation,resolution=merge-duplicates'},body:body?JSON.stringify(body):undefined});
 const text=await r.text(); if(!r.ok) throw new Error(`${table} ${method} ${r.status}: ${text}`); return text?JSON.parse(text):[];
}
async function upload(storagePath,body,mime){
 const endpoint=`${URL}/storage/v1/object/${BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
 let r=await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':mime,'x-upsert':'false'},body});
 if(r.status===409){
   const existing=await api('contract_package_documents','GET',null,`?storage_path=eq.${q(storagePath)}&select=byte_size,sha256&limit=1`);
   if(!existing[0]||Number(existing[0].byte_size)!==body.length||existing[0].sha256!==sha(body)) throw new Error(`STORAGE_PATH_INTEGRITY_CONFLICT ${storagePath}`);
 } else if(!r.ok) throw new Error(`storage upload ${r.status}: ${await r.text()}`);
}
function mimeOf(name){const e=path.extname(name).toLowerCase();return ({'.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xls':'application/vnd.ms-excel','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.doc':'application/msword','.zip':'application/zip','.txt':'text/plain'}[e]||'application/octet-stream');}
const zipBytes=await fs.readFile(ZIP); const digest=sha(zipBytes); if(digest!==EXPECTED) throw new Error(`ARTIFACT_DIGEST_MISMATCH expected=${EXPECTED} actual=${digest}`);
const tmp=path.resolve('.tmp-caleprocure-persistence'); await fs.rm(tmp,{recursive:true,force:true}); await fs.mkdir(tmp,{recursive:true}); new AdmZip(ZIP).extractAllTo(tmp,true);
async function walk(dir){const out=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);d.isDirectory()?out.push(...await walk(p)):out.push(p);}return out;}
const files=await walk(tmp); const findOne=n=>files.find(f=>path.basename(f)===n);
const campaign=JSON.parse(await fs.readFile(findOne('campaign-summary.json'),'utf8'));
if(campaign.target_count!==3||campaign.complete_count!==3||campaign.incomplete_count!==0||campaign.official_file_count!==18||campaign.downloaded_count!==18||campaign.failed_count!==0) throw new Error('CAMPAIGN_RECONCILIATION_FAILED');
const idem='caleprocure-artifact-8921004540';
let command=(await api('command_runs','GET',null,`?idempotency_key=eq.${q(idem)}&select=*&limit=1`))[0];
if(!command){[command]=await api('command_runs','POST',{idempotency_key:idem,status:'running',aadp_state:'RUNNING',current_stage:'PACKAGE_PERSISTENCE',mission_type_key:'CONTRACT_PACKAGE_ACQUISITION',mission_name:'Cal eProcure Artifact Persistence Validation',state_code:'CA',assigned_agent:'Cal eProcure Package Persistence Agent',publisher_assignment_id:ASSIGNMENT,started_at:new Date().toISOString(),last_activity_at:new Date().toISOString(),execution_evidence:{source:'GITHUB_ACTIONS_ARTIFACT_IMPORT',artifact_id:8921004540,workflow_run_id:30983127437,artifact_sha256:digest}});}
let run=(await api('acquisition_runs','GET',null,`?command_run_id=eq.${command.id}&select=*&limit=1`))[0];
if(!run){[run]=await api('acquisition_runs','POST',{command_run_id:command.id,assignment_id:ASSIGNMENT,status:'RUNNING',records_discovered:3,records_acquired:0,pages_processed:0,retrieval_failures:0,pagination_complete:false,started_at:new Date().toISOString(),reconciliation_status:'PENDING',qualification_status:'PENDING',validation_status:'PENDING',evidence:{source:'GITHUB_ACTIONS_ARTIFACT',artifact_id:8921004540,workflow_run_id:30983127437,repository_commit:'320d65be270a80fe1776912dc74da75e203b58e8',artifact_sha256:digest,contracts_expected:3,documents_expected:18,expected_document_bytes:61693738,acquisition_method:'VERIFIED_ARTIFACT_IMPORT'}});}
const results=[];
for(const [eventId,cfg] of Object.entries(EVENTS)){
 const summaryFile=files.find(f=>path.basename(f)==='summary.json'&&f.includes(eventId));
 const manifestFile=files.find(f=>path.basename(f)==='manifest.json'&&f.includes(eventId));
 if(!summaryFile||!manifestFile) throw new Error(`MISSING_EVENT_EVIDENCE ${eventId}`);
 const summary=JSON.parse(await fs.readFile(summaryFile,'utf8')); const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
 if(!summary.package_complete||summary.official_file_count!==cfg.expected||manifest.length!==cfg.expected) throw new Error(`EVENT_MANIFEST_FAILED ${eventId}`);
 const canonical=(await api('state_contract_opportunities','GET',null,`?id=eq.${cfg.canonicalId}&source_record_id=eq.${q(cfg.sourceRecordId)}&select=id,package_status&limit=2`)); if(canonical.length!==1) throw new Error(`IDENTITY_CONFLICT ${eventId}`);
 const sourceFingerprint=sha(Buffer.from(`CALEPROCURE|${cfg.businessUnit}|${eventId}`)); const contentFingerprint=sha(Buffer.from(JSON.stringify(manifest)));
 let raw=(await api('acquisition_raw_records','GET',null,`?acquisition_run_id=eq.${run.id}&source_record_id=eq.${q(cfg.sourceRecordId)}&select=*&limit=1`))[0];
 if(!raw){[raw]=await api('acquisition_raw_records','POST',{acquisition_run_id:run.id,assignment_id:ASSIGNMENT,publisher_id:PUBLISHER,source_record_id:cfg.sourceRecordId,source_url:`https://caleprocure.ca.gov/event/${cfg.businessUnit}/${eventId}`,raw_payload:{artifact_id:8921004540,workflow_run_id:30983127437,artifact_sha256:digest,business_unit:cfg.businessUnit,auc_id:eventId,manifest},retrieval_timestamp:new Date().toISOString(),source_fingerprint:sourceFingerprint,content_fingerprint:contentFingerprint,source_version:'1.4.1',processing_status:'RAW',canonical_opportunity_id:cfg.canonicalId,detail_retrieved_at:new Date().toISOString(),detail_retrieval_status:'COMPLETE',document_manifest_count:cfg.expected,addendum_count:manifest.filter(x=>x.addendum_like).length,amendment_count:manifest.filter(x=>x.addendum_like).length,package_status:'PACKAGE_DISCOVERED',match_readiness_status:'BLOCKED_PACKAGE_INCOMPLETE'});}
 await api('aadp_document_manifests','POST',{acquisition_run_id:run.id,raw_record_id:raw.id,source_record_id:cfg.sourceRecordId,manifest,document_count:cfg.expected,package_status:'PACKAGE_DISCOVERED',storage_document_count:0,extracted_document_count:0,failed_document_count:0,updated_at:new Date().toISOString()},`?on_conflict=acquisition_run_id,raw_record_id`);
 const permanent=[];
 for(const item of manifest){const file=files.find(f=>f.includes(eventId)&&f.includes(`${path.sep}official-files${path.sep}`)&&path.basename(f)===item.filename); if(!file) throw new Error(`MISSING_FILE ${eventId} ${item.filename}`); const body=await fs.readFile(file); const actual=sha(body); if(body.length!==Number(item.byte_size)||actual!==item.sha256) throw new Error(`DOCUMENT_HASH_MISMATCH ${eventId} ${item.filename}`); const storagePath=`caleprocure/${cfg.canonicalId}/${eventId}/${actual}/${item.filename}`; await upload(storagePath,body,mimeOf(item.filename)); const sourceUrl=item.source_url||`github-actions://artifact/8921004540/${eventId}/${item.filename}`; await api('contract_package_documents','POST',{acquisition_run_id:run.id,raw_record_id:raw.id,publisher_id:PUBLISHER,canonical_opportunity_id:cfg.canonicalId,source_record_id:cfg.sourceRecordId,source_url:sourceUrl,final_url:item.source_url||null,storage_bucket:BUCKET,storage_path:storagePath,original_filename:item.filename,document_type:item.addendum_like?'ADDENDUM':'SOLICITATION',mime_type:mimeOf(item.filename),file_extension:path.extname(item.filename),byte_size:body.length,sha256:actual,version_label:null,is_addendum:Boolean(item.addendum_like),is_amendment:Boolean(item.addendum_like),is_current:true,retrieval_status:'STORED',extraction_status:'NOT_STARTED',extracted_char_count:0,retrieval_attempt_count:1,last_error:null,retrieved_at:new Date().toISOString(),metadata:{artifact_id:8921004540,workflow_run_id:30983127437,manifest_index:item.index,integrity:item.integrity}},`?on_conflict=raw_record_id,source_url`); permanent.push({...item,storage_bucket:BUCKET,storage_path:storagePath,retrieval_status:'STORED',extraction_status:'NOT_STARTED'});}
 const docs=await api('contract_package_documents','GET',null,`?canonical_opportunity_id=eq.${cfg.canonicalId}&retrieval_status=eq.STORED&select=id,sha256,byte_size,storage_path`); const unique=new Set(docs.map(x=>x.sha256)); if(docs.length!==cfg.expected||unique.size!==cfg.expected) throw new Error(`DOCUMENT_RECONCILIATION_FAILED ${eventId}`);
 const now=new Date().toISOString(); await api('acquisition_raw_records','PATCH',{package_status:'PACKAGE_COMPLETE',package_document_count:cfg.expected,package_extracted_count:0,package_failed_count:0,package_completed_at:now,match_readiness_status:'BLOCKED_REQUIREMENTS_INCOMPLETE'},`?id=eq.${raw.id}`);
 await api('aadp_document_manifests','PATCH',{manifest:permanent,package_status:'PACKAGE_COMPLETE',document_count:cfg.expected,storage_document_count:cfg.expected,extracted_document_count:0,failed_document_count:0,completed_at:now,updated_at:now},`?acquisition_run_id=eq.${run.id}&raw_record_id=eq.${raw.id}`);
 await api('state_contract_opportunities','PATCH',{package_status:'PACKAGE_COMPLETE',package_document_count:cfg.expected,package_extracted_count:0,package_failed_count:0,requirements_extraction_status:'NOT_STARTED',match_readiness_status:'BLOCKED_REQUIREMENTS_INCOMPLETE',package_manifest:permanent,package_completed_at:now,package_last_checked_at:now,document_urls:permanent.map(x=>({storage_bucket:BUCKET,storage_path:x.storage_path,sha256:x.sha256,filename:x.filename})),raw_source_payload:{artifact_import:{artifact_id:8921004540,workflow_run_id:30983127437,artifact_sha256:digest,imported_at:now}}},`?id=eq.${cfg.canonicalId}`);
 results.push({event_id:eventId,canonical_id:cfg.canonicalId,raw_record_id:raw.id,manifest:cfg.expected,artifact:cfg.expected,documents:docs.length,storage:docs.length,hashes:unique.size,failed:0,bytes:docs.reduce((s,x)=>s+Number(x.byte_size||0),0)});
}
const totalBytes=results.reduce((s,x)=>s+x.bytes,0); if(totalBytes!==61693738) throw new Error(`TOTAL_BYTES_MISMATCH ${totalBytes}`);
const done=new Date().toISOString(); await api('acquisition_runs','PATCH',{status:'COMPLETED',records_acquired:3,retrieval_failures:0,pagination_complete:true,reconciliation_status:'MATCHED',validation_status:'PASSED',qualification_status:'PENDING',completed_at:done,evidence:{source:'GITHUB_ACTIONS_ARTIFACT',artifact_id:8921004540,workflow_run_id:30983127437,artifact_sha256:digest,total_contracts:3,total_documents:18,total_bytes:totalBytes,results}},`?id=eq.${run.id}`);
await api('command_runs','PATCH',{status:'completed',aadp_state:'COMPLETED',current_stage:'PACKAGE_PERSISTENCE_COMPLETED',records_discovered:3,records_acquired:3,records_accepted:3,records_rejected:0,warning_count:0,failure_count:0,reconciliation_status:'MATCHED',validation_status:'PASSED',result_summary:'Three verified Cal eProcure solicitation packages containing 18 official documents were permanently persisted and reconciled against Supabase Storage and the contract package registry.',completed_at:done,last_activity_at:done},`?id=eq.${command.id}`);
const evidence={connect:'CONNECTED',contracts_acquired:'3 / 3',result:'SUCCESS',command_run_id:command.id,acquisition_run_id:run.id,artifact_sha256:digest,total_verified_documents:18,total_verified_bytes:totalBytes,events:results,database_persistence:'VERIFIED',storage_persistence:'VERIFIED',exact_blocker:'NONE'};
await fs.writeFile('caleprocure-persistence-reconciliation.json',JSON.stringify(evidence,null,2)); console.log(JSON.stringify({status:'SUCCESS',command_run_id:command.id,acquisition_run_id:run.id,contracts:3,documents:18,bytes:totalBytes}));