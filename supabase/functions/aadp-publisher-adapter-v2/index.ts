import { corsHeaders, db, invoke, json, parseBody } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;
const now = () => new Date().toISOString();
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as JsonRecord).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}` : JSON.stringify(value ?? null);
async function sha256(value:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function stripHtml(value:string){return value.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;/g,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').trim();}
function firstText(source:JsonRecord,keys:string[]){for(const key of keys){const value=text(source[key]);if(value)return value;}return '';}
function absolute(base:string,href:string){try{return new URL(href,base).toString();}catch{return href;}}

function decodeEmbeddedObject(fragment:string):JsonRecord|null{
  try {
    const decoded = JSON.parse(`"${fragment.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
    return asRecord(JSON.parse(decoded));
  } catch {
    try { return asRecord(JSON.parse(fragment.replace(/\\"/g,'"').replace(/\\u002F/g,'/').replace(/\\u003C/g,'<').replace(/\\u003E/g,'>'))); } catch { return null; }
  }
}

function recordsFromOpenGovSsr(html:string,baseUrl:string):JsonRecord[]{
  const normalized = html.replace(/&quot;/g,'"');
  const fragments = [...normalized.matchAll(/\{\\?"releaseProjectDate\\?":.*?\\?"comingSoon\\?":(?:null|true|false)\}/gs)].map(m=>m[0]);
  const records:JsonRecord[]=[];
  const seen=new Set<string>();
  for(const fragment of fragments){
    const object=decodeEmbeddedObject(fragment);
    if(!object)continue;
    const internalId=text(object.id);
    const financialId=text(object.financialId);
    const title=text(object.title);
    if(!internalId||!title)continue;
    const sourceRecordId=financialId||internalId;
    if(seen.has(sourceRecordId))continue;
    seen.add(sourceRecordId);
    const addenda=array(object.addendums);
    const organization=asRecord(asRecord(object.government).organization);
    const department=asRecord(object.department);
    const detailUrl=absolute(baseUrl,`/portal/tucson-az/projects/${internalId}`);
    records.push({
      id:sourceRecordId,source_record_id:sourceRecordId,project_id:financialId||sourceRecordId,
      platform_project_id:internalId,solicitation_number:financialId||sourceRecordId,title,
      description:stripHtml(text(object.summary)),summary:stripHtml(text(object.summary)),
      status:text(object.status)||'open',release_date:text(object.releaseProjectDate)||null,
      due_date:text(object.proposalDeadline)||null,addenda_count:addenda.length,addenda,
      department_id:text(department.id)||null,department_name:text(department.name)||null,
      solicitation_type:text(asRecord(object.template).title)||null,
      issuing_organization:text(organization.name)||'City of Tucson',state_code:text(organization.state)||'AZ',
      source_url:detailUrl,official_source_url:detailUrl,platform:'OpenGov Procurement',
      is_private:Boolean(object.isPrivate),is_paused:Boolean(object.isPaused),coming_soon:Boolean(object.comingSoon)
    });
  }
  return records;
}

function recordsFromOpenGovHtml(html:string,baseUrl:string):JsonRecord[]{
  const ssr=recordsFromOpenGovSsr(html,baseUrl); if(ssr.length)return ssr;
  const rows=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]); const records:JsonRecord[]=[];
  for(const row of rows){const cells=[...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>stripHtml(m[1]));const anchor=row.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);if(!anchor||cells.length<2)continue;const href=absolute(baseUrl,anchor[1]);const title=stripHtml(anchor[2])||cells[0];const internalId=href.match(/\/projects?\/([^/?#]+)/i)?.[1]||'';const projectId=cells.find(c=>/^[A-Za-z0-9_-]{4,}$/.test(c)&&!/^open|closed$/i.test(c))||internalId;if(!projectId||/project title/i.test(title))continue;const dates=cells.filter(c=>/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c));records.push({id:projectId,source_record_id:projectId,platform_project_id:internalId||projectId,solicitation_number:projectId,title,status:cells.find(c=>/^(open|closed|cancelled|awarded|evaluation|pending)$/i.test(c))||'',release_date:dates[0]||null,due_date:dates[1]||null,source_url:href,official_source_url:href,platform:'OpenGov Procurement'});}return records;
}

async function acquisitionRun(runId:string){const rows=await db(`acquisition_runs?command_run_id=eq.${runId}&select=*&order=created_at.desc&limit=1`);if(!rows?.[0])throw new Error('Acquisition run has not been initialized');return rows[0];}
async function fetchPayload(url:string,headers:JsonRecord){const response=await fetch(url,{headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,String(v)])),redirect:'follow'});if(!response.ok)throw new Error(`Publisher retrieval failed (${response.status}) for ${url}`);const contentType=response.headers.get('content-type')||'';return contentType.includes('json')?{kind:'json',payload:await response.json(),finalUrl:response.url}:{kind:'html',payload:await response.text(),finalUrl:response.url};}
function recordsFromJson(payload:unknown):JsonRecord[]{if(Array.isArray(payload))return payload.map(asRecord).filter(r=>Object.keys(r).length);const root=asRecord(payload);for(const key of ['records','items','results','data','projects','opportunities','solicitations','notices'])if(Array.isArray(root[key]))return (root[key] as unknown[]).map(asRecord).filter(r=>Object.keys(r).length);return [];}
async function storeRecord(run:JsonRecord,assignment:JsonRecord,record:JsonRecord,endpoint:string){const sourceRecordId=firstText(record,['source_record_id','financialId','id','project_id'])||await sha256(canonicalJson(record));const sourceUrl=firstText(record,['official_source_url','source_url','url'])||endpoint;const contentFingerprint=await sha256(canonicalJson(record));const sourceFingerprint=await sha256(`${text(assignment.publisher_id)}|${sourceRecordId}|${sourceUrl}`);const existing=await db(`acquisition_raw_records?publisher_id=eq.${assignment.publisher_id}&source_record_id=eq.${encodeURIComponent(sourceRecordId)}&content_fingerprint=eq.${contentFingerprint}&select=id`);if(existing.length)return false;await db('acquisition_raw_records',{method:'POST',body:JSON.stringify({acquisition_run_id:run.id,assignment_id:assignment.id,publisher_id:assignment.publisher_id,source_record_id:sourceRecordId,source_url:sourceUrl,raw_payload:record,source_fingerprint:sourceFingerprint,content_fingerprint:contentFingerprint,canonical_opportunity_id:firstText(record,['solicitation_number','project_id'])||sourceRecordId,version_effective_at:firstText(record,['release_date'])||null,processing_status:'RAW'})});return true;}

async function handleEnumeration(body:JsonRecord){const runId=text(body.run_id),assignment=asRecord(body.assignment),run=await acquisitionRun(runId);const endpoint=text(assignment.search_endpoint);const parameters=asRecord(assignment.search_parameters),headers=asRecord(parameters.headers);const result=await fetchPayload(endpoint,headers);const records=result.kind==='json'?recordsFromJson(result.payload):recordsFromOpenGovHtml(String(result.payload),result.finalUrl);let acquired=0;for(const record of records)if(await storeRecord(run,assignment,record,endpoint))acquired++;await db(`acquisition_runs?id=eq.${run.id}`,{method:'PATCH',body:JSON.stringify({records_discovered:records.length,records_acquired:acquired,pages_processed:1,retrieval_failures:0,pagination_complete:true,evidence:{adapter:'OPENGOV_PUBLIC_PORTAL_V2_SSR',endpoint,completed_at:now(),records_parsed:records.length}})});if(records.length===0)throw new Error('OpenGov public portal returned HTML but no project records were parsed');return {success:true,task_type:'ACQUISITION_PAGE_FETCH',metrics:{pages_processed:1,records_discovered:records.length,records_acquired:acquired,retrieval_failures:0},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V2_SSR',endpoint,pagination_complete:true,sample_source_record_ids:records.slice(0,5).map(r=>r.source_record_id)}};}

function linksFromHtml(html:string,baseUrl:string){const links=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({url:absolute(baseUrl,m[1]),label:stripHtml(m[2])}));return [...new Map(links.filter(l=>/\.(pdf|docx?|xlsx?|csv|zip)(\?|$)/i.test(l.url)||/(addendum|amendment|attachment|document|specification|scope|bid form|question|answer)/i.test(`${l.label} ${l.url}`)).map(l=>[l.url,l])).values()];}
async function handleDetail(body:JsonRecord){const run=await acquisitionRun(text(body.run_id));const rows=await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);let retrieved=0,failed=0;for(const row of rows){try{const response=await fetch(text(row.source_url),{redirect:'follow'});if(!response.ok)throw new Error(String(response.status));const detail=await response.text();const raw=asRecord(row.raw_payload);await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({raw_payload:{...raw,__aadp_detail:detail,__aadp_detail_retrieved_at:now()},detail_retrieved_at:now(),detail_retrieval_status:'SUCCESS'})});retrieved++;}catch(error){failed++;await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({detail_retrieval_status:'FAILED',detail_retrieval_error:error instanceof Error?error.message:String(error)})});}}return {success:true,task_type:'PROJECT_DETAIL_RETRIEVAL',metrics:{detail_records_retrieved:retrieved,detail_retrieval_failures:failed},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V2_SSR'}};}
async function handleDocuments(body:JsonRecord){const run=await acquisitionRun(text(body.run_id));const rows=await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);let manifests=0,documents=0;for(const row of rows){const raw=asRecord(row.raw_payload),detail=raw.__aadp_detail;const entries=typeof detail==='string'?linksFromHtml(detail,text(row.source_url)):[];await db('aadp_document_manifests',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({acquisition_run_id:run.id,raw_record_id:row.id,source_record_id:row.source_record_id,manifest:{documents:entries,addenda:entries.filter(i=>/addend/i.test(i.label)),amendments:entries.filter(i=>/amend/i.test(i.label)),questions_answers:entries.filter(i=>/(question|answer|q&a)/i.test(i.label))},document_count:entries.length,retrieved_at:now()})});manifests++;documents+=entries.length;}return {success:true,task_type:text(body.task_type),metrics:{document_manifests:manifests,documents_discovered:documents},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V2_SSR'}};}
async function handleRequirements(body:JsonRecord){const run=await acquisitionRun(text(body.run_id));const rows=await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);let extracted=0;for(const row of rows){const raw=asRecord(row.raw_payload);const description=firstText(raw,['description','summary']);await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({raw_payload:{...raw,__aadp_normalized:{source_record_id:row.source_record_id,solicitation_number:firstText(raw,['solicitation_number','project_id'])||row.source_record_id,title:firstText(raw,['title'])||`Procurement opportunity ${row.source_record_id}`,description,requirements:{text:description},status:firstText(raw,['status'])||'Open',response_deadline:firstText(raw,['due_date'])||null,issuing_organization:text(asRecord(body.assignment).publisher_name),source_url:row.source_url,official_source_url:row.source_url,document_urls:[]},__aadp_requirements_extracted_at:now()},processing_status:'NORMALIZED'})});extracted++;}return {success:true,task_type:'REQUIREMENT_EXTRACTION',metrics:{requirements_extracted:extracted},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V2_SSR'}};}

Deno.serve(async(request:Request)=>{if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});if(request.method!=='POST')return json({error:'Method not allowed'},405);try{const body=asRecord(await parseBody(request));const assignment=asRecord(body.assignment);const isOpenGov=`${text(assignment.acquisition_method)} ${text(assignment.search_endpoint)}`.toUpperCase().includes('OPENGOV');if(!isOpenGov)return json(await invoke('aadp-task-executor-v2',body));switch(text(body.task_type)){case'ACQUISITION_PAGE_FETCH':return json(await handleEnumeration(body));case'PROJECT_DETAIL_RETRIEVAL':return json(await handleDetail(body));case'DOCUMENT_DISCOVERY':case'DOCUMENT_RETRIEVAL':return json(await handleDocuments(body));case'REQUIREMENT_EXTRACTION':return json(await handleRequirements(body));default:return json(await invoke('aadp-task-executor-v2',body));}}catch(error){return json({success:false,error:error instanceof Error?error.message:String(error)},500);}});