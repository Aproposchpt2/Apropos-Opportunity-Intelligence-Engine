import { chromium } from 'playwright';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

const URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);
const PUBLISHER_ID = '0cf29ac8-f55b-4b46-ac2f-93d75694a318';
const ASSIGNMENT_ID = '052d5448-65fd-4070-b4ff-e6e13a157f00';
const BUCKET = 'solicitation-packages';
const BRANCH = 'caleprocure-persistence-validation-001';
const HOME = 'https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH = 'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const started = Date.now();
const hardStop = started + 25 * 60_000;
if (!URL || !KEY) throw new Error('SUPABASE_RUNTIME_CONFIGURATION_MISSING');

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const q = encodeURIComponent;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const safe = v => String(v || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200) || 'file';
const relayUrl = (bu, eventId) => `https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=${q(bu)}&AUC_ID=${q(eventId)}`;
const isAddendum = n => /addend|amend|revision|revised|supplement|questions|q[&_ -]*a|notice of change/i.test(String(n || ''));

async function api(table, method = 'GET', body = null, query = '') {
  const res = await fetch(`${URL}/rest/v1/${table}${query}`, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${table} ${method} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

function verify(body, filename) {
  const ext = path.extname(filename).toLowerCase();
  const head = body.subarray(0, 16);
  const text = body.subarray(0, Math.min(512, body.length)).toString('utf8').trim().toLowerCase();
  if (body.length < 64) return { valid: false, reason: 'FILE_TOO_SMALL' };
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return { valid: false, reason: 'HTML_RESPONSE_INSTEAD_OF_FILE' };
  if (ext === '.pdf') {
    const tail = body.subarray(Math.max(0, body.length - 4096)).toString('latin1');
    return head.toString('latin1').startsWith('%PDF-') && tail.includes('%%EOF') ? { valid: true, signature: 'PDF' } : { valid: false, reason: 'INVALID_PDF_SIGNATURE' };
  }
  if (['.xlsx','.xlsm','.docx','.pptx','.zip'].includes(ext)) return head[0] === 0x50 && head[1] === 0x4b ? { valid: true, signature: 'ZIP_CONTAINER' } : { valid: false, reason: 'INVALID_ZIP_SIGNATURE' };
  if (['.xls','.doc','.ppt'].includes(ext)) {
    const ole=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
    return ole.every((v,i)=>head[i]===v) ? { valid:true, signature:'OLE' } : { valid:false, reason:'INVALID_OLE_SIGNATURE' };
  }
  return { valid: true, signature: 'NON_HTML_BINARY_OR_TEXT' };
}

function identifiers(row) {
  const sr = String(row.source_record_id || '');
  const m = sr.match(/^([^:]+):(.+)$/);
  const payload = row.raw_source_payload || {};
  const bu = payload.business_unit || payload.event?.business_unit || payload.id?.business_unit || m?.[1];
  const eventId = payload.auc_id || payload.event_id || payload.event?.event_id || payload.id?.event_id || m?.[2];
  if (!bu || !eventId) return null;
  return { businessUnit: String(bu), eventId: String(eventId) };
}

async function selectQueue() {
  const rows = await api('state_contract_opportunities','GET',null,`?is_latest_version=eq.true&status=eq.open&package_status=neq.PACKAGE_COMPLETE&or=(source_platform.eq.caleprocure,official_url.ilike.*caleprocure*,source_url.ilike.*caleprocure*)&select=id,source_record_id,title,response_deadline,source_platform,official_url,source_url,raw_source_payload,package_status&order=response_deadline.asc.nullslast,source_record_id.asc&limit=40`);
  const selected=[]; const unresolved=[];
  for (const row of rows) {
    const ids=identifiers(row);
    if (!ids) { unresolved.push({source_record_id:row.source_record_id,reason:'FAILED_IDENTIFIER_RESOLUTION'}); continue; }
    selected.push({...row,...ids});
    if(selected.length===BATCH_SIZE) break;
  }
  return {selected,unresolved};
}

async function createProvenance(selected) {
  const batchId = `CALEPROCURE-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${process.env.GITHUB_RUN_ID || 'LOCAL'}`;
  const idem = `caleprocure-batch-${process.env.GITHUB_RUN_ID || batchId}`;
  let command=(await api('command_runs','GET',null,`?idempotency_key=eq.${q(idem)}&select=*&limit=1`))[0];
  if(!command) [command]=await api('command_runs','POST',{idempotency_key:idem,status:'running',aadp_state:'RUNNING',current_stage:'PACKAGE_ACQUISITION',mission_type_key:'CONTRACT_PACKAGE_ACQUISITION',mission_name:'Cal eProcure Queue Package Batch',state_code:'CA',assigned_agent:'Cal eProcure Queue Worker',publisher_assignment_id:ASSIGNMENT_ID,started_at:new Date().toISOString(),last_activity_at:new Date().toISOString(),execution_evidence:{batch_id:batchId,github_run_id:process.env.GITHUB_RUN_ID||null,branch:BRANCH,target:BATCH_SIZE,selected:selected.map(x=>x.source_record_id)}});
  let run=(await api('acquisition_runs','GET',null,`?command_run_id=eq.${command.id}&select=*&limit=1`))[0];
  if(!run) [run]=await api('acquisition_runs','POST',{command_run_id:command.id,assignment_id:ASSIGNMENT_ID,status:'RUNNING',records_discovered:selected.length,records_acquired:0,pages_processed:0,retrieval_failures:0,pagination_complete:false,started_at:new Date().toISOString(),reconciliation_status:'PENDING',qualification_status:'PENDING',validation_status:'PENDING',evidence:{batch_id:batchId,github_run_id:process.env.GITHUB_RUN_ID||null,worker:'scripts/acquire-caleprocure-package-batch.mjs',branch:BRANCH}});
  return {batchId,command,run};
}

async function upload(storagePath, body, mime, canonicalId, digest) {
  const existing=await api('contract_package_documents','GET',null,`?canonical_opportunity_id=eq.${canonicalId}&sha256=eq.${digest}&select=id,storage_path,byte_size&limit=1`);
  if(existing[0]) return existing[0].storage_path;
  const endpoint=`${URL}/storage/v1/object/${BUCKET}/${storagePath.split('/').map(q).join('/')}`;
  const res=await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':mime,'x-upsert':'false'},body});
  if(!res.ok && res.status!==409) throw new Error(`STORAGE_UPLOAD_FAILED ${res.status} ${await res.text()}`);
  return storagePath;
}

function mimeOf(name){const e=path.extname(name).toLowerCase();return ({'.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsm':'application/vnd.ms-excel.sheet.macroEnabled.12','.xls':'application/vnd.ms-excel','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.doc':'application/msword','.zip':'application/zip','.txt':'text/plain'}[e]||'application/octet-stream');}

async function openEvent(target) {
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1600,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',locale:'en-US'});
  const page=await context.newPage();
  for (const [url,wait] of [[HOME,2500],[SEARCH,4500],[relayUrl(target.businessUnit,target.eventId),6500]]) { await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000}); await page.waitForTimeout(wait); }
  await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({force:true,timeout:30000});
  await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0',{state:'visible',timeout:45000});
  await page.waitForTimeout(2000);
  const names=await page.locator('[name="ViewAttachmentsFileName"]').evaluateAll(nodes=>nodes.map(n=>(n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean));
  return {browser,context,page,names};
}

async function resetModal(page){await page.evaluate(()=>{try{clearAttachmentWrapper();}catch{} const l=document.querySelector('#downloadButton');if(l)l.setAttribute('href','#');const m=document.querySelector('#attachmentWrapperModal');if(m){m.classList.remove('show','in');m.style.display='none';}document.body.classList.remove('modal-open');document.querySelectorAll('.modal-backdrop').forEach(n=>n.remove());}).catch(()=>null);await page.waitForTimeout(400);}

async function capture(page,context,index,expectedName){
  await page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`).click({force:true,timeout:20000});
  await page.waitForFunction(()=>{const h=document.querySelector('#downloadButton')?.getAttribute('href')||'';return h&&h!=='#'&&!h.endsWith('#');},{timeout:35000});
  const href=await page.locator('#downloadButton').getAttribute('href');
  const responses=[]; const popupPromise=context.waitForEvent('page',{timeout:45000}).catch(()=>null); const downloadPromise=page.waitForEvent('download',{timeout:45000}).catch(()=>null);
  await page.evaluate(url=>{const a=document.createElement('a');a.href=url;a.target='_blank';a.style.display='none';document.body.appendChild(a);a.click();a.remove();},href);
  const download=await Promise.race([downloadPromise,popupPromise.then(()=>null)]);
  if(download){const filename=safe(download.suggestedFilename()||expectedName);const tmp=await download.createReadStream();const chunks=[];for await(const c of tmp)chunks.push(c);return {body:Buffer.concat(chunks),filename,sourceUrl:href,method:'download'};}
  const popup=await popupPromise; if(!popup) throw new Error('NO_DOWNLOAD_OR_POPUP');
  popup.on('response',r=>responses.push(r)); await popup.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>null); await popup.waitForTimeout(1800);
  let response=responses.find(r=>/viewredirect|\.(pdf|xlsm?|xlsx|docx?|zip)(?:$|\?)/i.test(r.url()));
  if(!response){await popup.reload({waitUntil:'domcontentloaded',timeout:30000}).catch(()=>null);await popup.waitForTimeout(1200);response=responses.find(r=>/viewredirect|\.(pdf|xlsm?|xlsx|docx?|zip)(?:$|\?)/i.test(r.url()));}
  if(!response) throw new Error('POPUP_FILE_RESPONSE_NOT_CAPTURED');
  const hdr=await response.allHeaders().catch(()=>({})); const body=await response.body(); let filename=hdr['content-disposition']?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]||hdr['content-disposition']?.match(/filename="?([^";]+)"?/i)?.[1]||expectedName;try{filename=decodeURIComponent(filename);}catch{} await popup.close().catch(()=>null);return {body,filename:safe(filename),sourceUrl:href,method:'popup'};
}

async function processContract(target, run) {
  const officialUrl=relayUrl(target.businessUnit,target.eventId);
  let raw=(await api('acquisition_raw_records','GET',null,`?acquisition_run_id=eq.${run.id}&source_record_id=eq.${q(target.source_record_id)}&select=*&limit=1`))[0];
  if(!raw) [raw]=await api('acquisition_raw_records','POST',{acquisition_run_id:run.id,assignment_id:ASSIGNMENT_ID,publisher_id:PUBLISHER_ID,source_record_id:target.source_record_id,source_url:officialUrl,raw_payload:{batch_id:process.env.GITHUB_RUN_ID||null,business_unit:target.businessUnit,auc_id:target.eventId,document_manifest:[],__package_extraction:{requirements_extraction_status:'NOT_STARTED'}},retrieval_timestamp:new Date().toISOString(),source_fingerprint:sha256(Buffer.from(`CALEPROCURE|${target.businessUnit}|${target.eventId}`)),content_fingerprint:sha256(Buffer.from(JSON.stringify(target))),source_version:'queue-worker-1.0',processing_status:'RAW',canonical_opportunity_id:target.id,detail_retrieved_at:new Date().toISOString(),detail_retrieval_status:'COMPLETE',document_manifest_count:0,addendum_count:0,amendment_count:0,package_status:'PACKAGE_DISCOVERED',match_readiness_status:'BLOCKED_PACKAGE_INCOMPLETE'});
  let names=null; const manifest=[]; let attempts=0;
  while(attempts<3){attempts++;let session;try{session=await openEvent(target);names=session.names;if(!names.length)throw new Error('EMPTY_ATTACHMENT_MANIFEST');
      for(let i=0;i<names.length;i++){if(Date.now()>hardStop)throw new Error('BATCH_RUNTIME_RESERVE_REACHED');const expected=names[i];const prior=await api('contract_package_documents','GET',null,`?raw_record_id=eq.${raw.id}&metadata->>manifest_index=eq.${i}&retrieval_status=eq.STORED&select=id,sha256,storage_path&limit=1`);if(prior[0]){manifest.push({index:i,expected_name:expected,status:'STORED',sha256:prior[0].sha256,storage_path:prior[0].storage_path});continue;}
        const got=await capture(session.page,session.context,i,expected);const integrity=verify(got.body,got.filename);if(!integrity.valid)throw new Error(`${integrity.reason}:${got.filename}`);const digest=sha256(got.body);const storagePath=`caleprocure/${target.id}/${target.eventId}/${digest}/${got.filename}`;await upload(storagePath,got.body,mimeOf(got.filename),target.id,digest);await api('contract_package_documents','POST',{acquisition_run_id:run.id,raw_record_id:raw.id,publisher_id:PUBLISHER_ID,canonical_opportunity_id:target.id,source_record_id:target.source_record_id,source_url:got.sourceUrl,final_url:got.sourceUrl,storage_bucket:BUCKET,storage_path:storagePath,original_filename:got.filename,document_type:isAddendum(got.filename)?'ADDENDUM':'SOLICITATION',mime_type:mimeOf(got.filename),file_extension:path.extname(got.filename),byte_size:got.body.length,sha256:digest,version_label:null,is_addendum:isAddendum(got.filename),is_amendment:isAddendum(got.filename),is_current:true,retrieval_status:'STORED',extraction_status:'NOT_STARTED',extracted_char_count:0,retrieval_attempt_count:attempts,last_error:null,retrieved_at:new Date().toISOString(),metadata:{manifest_index:i,expected_name:expected,integrity,session_attempt:attempts,batch_id:process.env.GITHUB_RUN_ID||null}},`?on_conflict=raw_record_id,source_url`);manifest.push({index:i,expected_name:expected,filename:got.filename,status:'STORED',byte_size:got.body.length,sha256:digest,storage_bucket:BUCKET,storage_path:storagePath,source_url:got.sourceUrl,integrity,session_attempt:attempts});await api('acquisition_raw_records','PATCH',{raw_payload:{batch_id:process.env.GITHUB_RUN_ID||null,business_unit:target.businessUnit,auc_id:target.eventId,document_manifest:manifest,__package_extraction:{requirements_extraction_status:'NOT_STARTED'}},document_manifest_count:names.length,package_document_count:manifest.length,package_status:'PACKAGE_DISCOVERED'},`?id=eq.${raw.id}`);await resetModal(session.page);}
      await session.browser.close();break;
    }catch(e){await session?.browser?.close().catch(()=>null);if(attempts>=3)throw e;}}
  const docs=await api('contract_package_documents','GET',null,`?canonical_opportunity_id=eq.${target.id}&retrieval_status=eq.STORED&select=id,sha256,byte_size,storage_path,original_filename`);const relevant=docs.filter(d=>d.storage_path?.includes(`/${target.eventId}/`));const hashes=new Set(relevant.map(d=>d.sha256));if(relevant.length!==names.length||hashes.size!==names.length)throw new Error(`PACKAGE_RECONCILIATION_FAILED manifest=${names.length} docs=${relevant.length} hashes=${hashes.size}`);
  const now=new Date().toISOString();const permanent=relevant.map(d=>({filename:d.original_filename,byte_size:Number(d.byte_size),sha256:d.sha256,storage_bucket:BUCKET,storage_path:d.storage_path,status:'STORED'}));await api('acquisition_raw_records','PATCH',{raw_payload:{batch_id:process.env.GITHUB_RUN_ID||null,business_unit:target.businessUnit,auc_id:target.eventId,document_manifest:permanent,__package_extraction:{requirements_extraction_status:'NOT_STARTED'}},document_manifest_count:names.length,package_status:'PACKAGE_COMPLETE',package_document_count:names.length,package_extracted_count:0,package_failed_count:0,package_completed_at:now,match_readiness_status:'BLOCKED_REQUIREMENTS_INCOMPLETE'},`?id=eq.${raw.id}`);await api('state_contract_opportunities','PATCH',{package_status:'PACKAGE_COMPLETE',package_document_count:names.length,package_extracted_count:0,package_failed_count:0,requirements_extraction_status:'NOT_STARTED',match_readiness_status:'BLOCKED_REQUIREMENTS_INCOMPLETE',package_manifest:permanent,package_completed_at:now,package_last_checked_at:now,document_urls:permanent},`?id=eq.${target.id}`);
  return {source_record_id:target.source_record_id,canonical_id:target.id,manifest:names.length,documents:relevant.length,storage:relevant.length,hashes:hashes.size,bytes:relevant.reduce((s,d)=>s+Number(d.byte_size||0),0)};
}

const {selected,unresolved}=await selectQueue();if(!selected.length)throw new Error('NO_ELIGIBLE_CONTRACTS');const {batchId,command,run}=await createProvenance(selected);const completed=[];const failed=[...unresolved];
for(const target of selected){try{completed.push(await processContract(target,run));}catch(e){failed.push({source_record_id:target.source_record_id,reason:e.message});}}
const remaining=(await api('state_contract_opportunities','GET',null,`?is_latest_version=eq.true&status=eq.open&package_status=neq.PACKAGE_COMPLETE&or=(source_platform.eq.caleprocure,official_url.ilike.*caleprocure*,source_url.ilike.*caleprocure*)&select=id`)).length;const result=completed.length===BATCH_SIZE?'SUCCESS':completed.length?'PARTIAL':'FAILED';const done=new Date().toISOString();await api('acquisition_runs','PATCH',{status:result==='FAILED'?'FAILED':'COMPLETED',records_acquired:completed.length,retrieval_failures:failed.length,pagination_complete:false,reconciliation_status:result==='SUCCESS'?'MATCHED':'PARTIAL',validation_status:result==='SUCCESS'?'PASSED':'REVIEW_REQUIRED',completed_at:done,evidence:{batch_id:batchId,completed,failed,remaining}},`?id=eq.${run.id}`);await api('command_runs','PATCH',{status:result==='FAILED'?'failed':'completed',aadp_state:result==='FAILED'?'FAILED':'COMPLETED',current_stage:'PACKAGE_BATCH_COMPLETED',records_discovered:selected.length,records_acquired:completed.length,records_accepted:completed.length,records_rejected:failed.length,warning_count:failed.length,failure_count:result==='FAILED'?failed.length:0,reconciliation_status:result==='SUCCESS'?'MATCHED':'PARTIAL',validation_status:result==='SUCCESS'?'PASSED':'REVIEW_REQUIRED',result_summary:`Cal eProcure batch ${batchId}: ${completed.length}/${BATCH_SIZE} packages complete.`,completed_at:done,last_activity_at:done},`?id=eq.${command.id}`);
const evidence={connect:'CONNECTED',contracts_acquired:`${completed.length} / ${BATCH_SIZE}`,result,batch_id:batchId,command_run_id:command.id,acquisition_run_id:run.id,completed_contracts:completed.map(x=>x.source_record_id),failed_or_incomplete_contracts:failed,documents_stored:completed.reduce((s,x)=>s+x.documents,0),storage_objects:completed.reduce((s,x)=>s+x.storage,0),unique_hashes:completed.reduce((s,x)=>s+x.hashes,0),remaining_open_incomplete_backlog:remaining,next_batch:result==='SUCCESS'?'AUTHORIZED':'BLOCKED',exact_blocker:result==='SUCCESS'?'NONE':failed.map(x=>`${x.source_record_id}:${x.reason}`).join('; ')};await fs.writeFile('caleprocure-package-batch-reconciliation.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));if(result==='FAILED')process.exit(1);