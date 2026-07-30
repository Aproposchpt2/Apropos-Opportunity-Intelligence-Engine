import { corsHeaders, db, invoke, json, parseBody , requireServiceRole } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;
const now = () => new Date().toISOString();
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as JsonRecord).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;/g,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').trim();
}

function firstText(source: JsonRecord, keys: string[]): string {
  for (const key of keys) { const value = text(source[key]); if (value) return value; }
  return '';
}

function recordsFromJson(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter(row => Object.keys(row).length);
  const root = asRecord(payload);
  for (const key of ['records','items','results','data','projects','opportunities','solicitations','notices']) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).map(asRecord).filter(row => Object.keys(row).length);
  }
  return Object.keys(root).length ? [root] : [];
}

function absolute(base: string, href: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function recordsFromOpenGovHtml(html: string, baseUrl: string): JsonRecord[] {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const records: JsonRecord[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => stripHtml(match[1]));
    const anchor = row.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor || cells.length < 2) continue;
    const href = absolute(baseUrl, anchor[1]);
    const title = stripHtml(anchor[2]) || cells[0];
    const projectId = cells.find(cell => /^\d{5,}$/.test(cell)) || href.match(/\/projects?\/([^/?#]+)/i)?.[1] || '';
    if (!projectId || /project title/i.test(title)) continue;
    const status = cells.find(cell => /^(open|closed|cancelled|awarded|evaluation|pending)$/i.test(cell)) || '';
    const dates = cells.filter(cell => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cell));
    const addenda = cells.find(cell => /^\d+$/.test(cell) && cell !== projectId) || '0';
    records.push({
      id: projectId,
      source_record_id: projectId,
      solicitation_number: projectId,
      title,
      status,
      addenda_count: Number(addenda),
      release_date: dates[0] || null,
      due_date: dates[1] || null,
      source_url: href,
      official_source_url: href,
      platform: 'OpenGov Procurement'
    });
  }
  return records;
}

async function acquisitionRun(runId: string): Promise<JsonRecord> {
  const rows = await db(`acquisition_runs?command_run_id=eq.${runId}&select=*&order=created_at.desc&limit=1`);
  if (!rows?.[0]) throw new Error('Acquisition run has not been initialized');
  return rows[0];
}

function buildUrl(endpoint: string, parameters: JsonRecord, pagination: JsonRecord, page: number): string {
  const url = new URL(endpoint);
  for (const [key,value] of Object.entries(parameters)) {
    if (key === 'headers' || key.startsWith('acceptance_') || value == null) continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key,String(item)));
    else url.searchParams.set(key,String(value));
  }
  const mode = text(pagination.mode || pagination.type).toLowerCase();
  const size = Math.min(Math.max(Number(pagination.page_size ?? pagination.limit ?? 100),1),1000);
  if (mode === 'offset') url.searchParams.set(text(pagination.offset_parameter || pagination.offset_param) || 'offset', String((page - 1) * size));
  else if (mode !== 'none' && mode !== 'html') url.searchParams.set(text(pagination.page_parameter || pagination.page_param) || 'page', String(page));
  if (mode !== 'none' && mode !== 'html') url.searchParams.set(text(pagination.page_size_parameter || pagination.limit_parameter) || 'limit', String(size));
  return url.toString();
}

async function fetchPayload(url: string, headers: JsonRecord) {
  const response = await fetch(url,{headers:Object.fromEntries(Object.entries(headers).map(([key,value])=>[key,String(value)])),redirect:'follow'});
  if (!response.ok) throw new Error(`Publisher retrieval failed (${response.status}) for ${url}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json')) return { kind:'json', payload:await response.json(), finalUrl:response.url };
  return { kind:'html', payload:await response.text(), finalUrl:response.url };
}

async function storeRecord(run: JsonRecord, assignment: JsonRecord, record: JsonRecord, endpoint: string) {
  const sourceRecordId = firstText(record,['source_record_id','id','project_id','projectId','solicitation_number','solicitationNumber']) || await sha256(canonicalJson(record));
  const sourceUrl = firstText(record,['official_source_url','source_url','url','detail_url','detailUrl','link']) || endpoint;
  const contentFingerprint = await sha256(canonicalJson(record));
  const sourceFingerprint = await sha256(`${text(assignment.publisher_id)}|${sourceRecordId}|${sourceUrl}`);
  const existing = await db(`acquisition_raw_records?publisher_id=eq.${assignment.publisher_id}&source_record_id=eq.${encodeURIComponent(sourceRecordId)}&content_fingerprint=eq.${contentFingerprint}&select=id`);
  if (existing.length) return false;
  await db('acquisition_raw_records',{method:'POST',body:JSON.stringify({
    acquisition_run_id:run.id,assignment_id:assignment.id,publisher_id:assignment.publisher_id,
    source_record_id:sourceRecordId,source_url:sourceUrl,raw_payload:record,source_fingerprint:sourceFingerprint,
    content_fingerprint:contentFingerprint,canonical_opportunity_id:firstText(record,['canonical_opportunity_id','solicitation_number','solicitationNumber']) || sourceRecordId,
    source_version:firstText(record,['version','revision','addendum_number','amendment_number']) || null,
    version_effective_at:firstText(record,['last_modified','updated_at','release_date','publication_date']) || null,processing_status:'RAW'
  })});
  return true;
}

async function handleEnumeration(body: JsonRecord) {
  const runId = text(body.run_id), assignment = asRecord(body.assignment), run = await acquisitionRun(runId);
  const endpoint = text(assignment.search_endpoint);
  if (!endpoint) throw new Error('Publisher assignment has no search endpoint');
  const parameters = asRecord(assignment.search_parameters), headers = asRecord(parameters.headers), pagination = asRecord(assignment.pagination_instructions);
  const mode = text(pagination.mode || pagination.type).toLowerCase();
  const maxPages = mode === 'html' || mode === 'none' ? 1 : Math.min(Math.max(Number(pagination.max_pages ?? 100),1),1000);
  const pageSize = Math.min(Math.max(Number(pagination.page_size ?? pagination.limit ?? 100),1),1000);
  let pages = 0, discovered = 0, acquired = 0, paginationComplete = false;
  for (let page=1; page<=maxPages; page+=1) {
    const pageUrl = buildUrl(endpoint,parameters,pagination,page);
    const result = await fetchPayload(pageUrl,headers);
    const records = result.kind === 'json' ? recordsFromJson(result.payload) : recordsFromOpenGovHtml(String(result.payload),result.finalUrl);
    pages += 1; discovered += records.length;
    for (const record of records) if (await storeRecord(run,assignment,record,endpoint)) acquired += 1;
    const root = asRecord(result.payload);
    if (result.kind === 'html' || records.length === 0 || (!root.next && !Boolean(root.has_more ?? root.hasMore) && records.length < pageSize)) { paginationComplete = true; break; }
  }
  await db(`acquisition_runs?id=eq.${run.id}`,{method:'PATCH',body:JSON.stringify({records_discovered:discovered,records_acquired:acquired,pages_processed:pages,retrieval_failures:0,pagination_complete:paginationComplete,evidence:{adapter:'OPENGOV_PUBLIC_PORTAL_V1',endpoint,completed_at:now()}})});
  return {success:true,task_type:'ACQUISITION_PAGE_FETCH',metrics:{pages_processed:pages,records_discovered:discovered,records_acquired:acquired,retrieval_failures:0},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V1',endpoint,pagination_complete:paginationComplete}};
}

function linksFromHtml(html: string, baseUrl: string) {
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(match => ({url:absolute(baseUrl,match[1]),label:stripHtml(match[2])}));
  const unique = new Map<string,{url:string;label:string}>();
  for (const link of links) if (/\.(pdf|docx?|xlsx?|csv|zip)(\?|$)/i.test(link.url) || /(addendum|amendment|attachment|document|specification|scope|bid form|question|answer)/i.test(`${link.label} ${link.url}`)) unique.set(link.url,link);
  return [...unique.values()];
}

async function handleDetail(body: JsonRecord) {
  const run = await acquisitionRun(text(body.run_id));
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);
  let retrieved = 0, failed = 0;
  for (const row of rows) {
    try {
      const response = await fetch(text(row.source_url),{redirect:'follow'});
      if (!response.ok) throw new Error(String(response.status));
      const contentType = response.headers.get('content-type') || '';
      const detail = contentType.includes('json') ? await response.json() : await response.text();
      const raw = asRecord(row.raw_payload);
      await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({raw_payload:{...raw,__aadp_detail:detail,__aadp_detail_retrieved_at:now()},detail_retrieved_at:now(),detail_retrieval_status:'SUCCESS'})});
      retrieved += 1;
    } catch (error) {
      failed += 1;
      await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({detail_retrieval_status:'FAILED',detail_retrieval_error:error instanceof Error?error.message:String(error)})});
    }
  }
  return {success:true,task_type:'PROJECT_DETAIL_RETRIEVAL',metrics:{detail_records_retrieved:retrieved,detail_retrieval_failures:failed},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V1'}};
}

async function handleDocuments(body: JsonRecord) {
  const run = await acquisitionRun(text(body.run_id));
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);
  let manifests = 0, documents = 0;
  for (const row of rows) {
    const raw = asRecord(row.raw_payload), detail = raw.__aadp_detail;
    let entries: {url:string;label:string}[] = [];
    if (typeof detail === 'string') entries = linksFromHtml(detail,text(row.source_url));
    else {
      const object = asRecord(detail);
      for (const item of array(object.attachments ?? object.documents ?? object.files ?? object.addenda ?? object.amendments)) {
        const value = typeof item === 'string' ? {url:item,label:item} : asRecord(item);
        const url = firstText(value,['url','href','download_url','downloadUrl']);
        if (url) entries.push({url:absolute(text(row.source_url),url),label:firstText(value,['label','name','title','filename']) || url});
      }
    }
    const unique = [...new Map(entries.map(entry=>[entry.url,entry])).values()];
    await db('aadp_document_manifests',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({acquisition_run_id:run.id,raw_record_id:row.id,source_record_id:row.source_record_id,manifest:{documents:unique,addenda:unique.filter(item=>/addend/i.test(item.label)),amendments:unique.filter(item=>/amend/i.test(item.label)),questions_answers:unique.filter(item=>/(question|answer|q&a)/i.test(item.label))},document_count:unique.length,retrieved_at:now()})});
    manifests += 1; documents += unique.length;
  }
  return {success:true,task_type:'DOCUMENT_RETRIEVAL',metrics:{document_manifests:manifests,documents_discovered:documents},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V1'}};
}

async function handleRequirements(body: JsonRecord) {
  const run = await acquisitionRun(text(body.run_id));
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);
  let extracted = 0;
  for (const row of rows) {
    const raw = asRecord(row.raw_payload), detail = raw.__aadp_detail;
    const detailText = typeof detail === 'string' ? stripHtml(detail) : canonicalJson(detail);
    const normalized = asRecord(raw.__aadp_normalized);
    const requirements = firstText(normalized,['requirements_text','description']) || firstText(raw,['requirements','scope','description','summary']) || detailText;
    const deadline = firstText(raw,['due_date','response_deadline','deadline','close_date','closeDate']);
    const status = firstText(raw,['status','lifecycle_status']) || 'Open';
    await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({raw_payload:{...raw,__aadp_normalized:{...normalized,source_record_id:row.source_record_id,solicitation_number:firstText(raw,['solicitation_number','project_id','id'])||row.source_record_id,title:firstText(raw,['title','name'])||`Procurement opportunity ${row.source_record_id}`,description:firstText(raw,['description','summary'])||detailText.slice(0,4000),requirements:{text:requirements},status,response_deadline:deadline||null,issuing_organization:text(asRecord(body.assignment).publisher_name),source_url:row.source_url,official_source_url:row.source_url,document_urls:[]},__aadp_requirements_extracted_at:now()},processing_status:'NORMALIZED'})});
    extracted += 1;
  }
  return {success:true,task_type:'REQUIREMENT_EXTRACTION',metrics:{requirements_extracted:extracted},evidence:{acquisition_run_id:run.id,adapter:'OPENGOV_PUBLIC_PORTAL_V1'}};
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  if (request.method !== 'POST') return json({error:'Method not allowed'},405);
  try {
    const body = asRecord(await parseBody(request));
    const assignment = asRecord(body.assignment);
    const platform = `${text(assignment.acquisition_method)} ${text(assignment.publisher_name)} ${canonicalJson(assignment.search_parameters)}`.toUpperCase();
    const isOpenGov = platform.includes('OPENGOV') || text(assignment.search_endpoint).includes('procurement.opengov.com');
    if (!isOpenGov) return json(await invoke('aadp-task-executor-v2',body));
    switch (text(body.task_type)) {
      case 'ACQUISITION_PAGE_FETCH': return json(await handleEnumeration(body));
      case 'PROJECT_DETAIL_RETRIEVAL': return json(await handleDetail(body));
      case 'DOCUMENT_DISCOVERY':
      case 'DOCUMENT_RETRIEVAL': return json(await handleDocuments(body));
      case 'REQUIREMENT_EXTRACTION': return json(await handleRequirements(body));
      default: return json(await invoke('aadp-task-executor-v2',body));
    }
  } catch (error) {
    return json({success:false,error:error instanceof Error?error.message:String(error)},500);
  }
});
