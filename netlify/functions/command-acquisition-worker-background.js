import { createHash } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const arr = value => Array.isArray(value) ? value : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function latestAssignmentPerPublisher(assignments) {
  const selected = new Map();
  for (const assignment of assignments || []) {
    const key = String(assignment.publisher_id || '');
    if (key && !selected.has(key)) selected.set(key, assignment);
  }
  return [...selected.values()];
}

function buildProfile(assignment, publisher) {
  const params = parseObject(assignment.search_parameters);
  const config = { ...parseObject(publisher.configuration), ...parseObject(params.connection_config) };
  return {
    method: txt(assignment.acquisition_method || config.access_method || publisher.acquisition_method).toUpperCase(),
    endpoint: txt(assignment.search_endpoint || config.primary_endpoint || publisher.search_endpoint || publisher.procurement_website || publisher.official_website),
    procurement_platform: txt(config.procurement_platform) || null,
    technology_vendor: txt(config.technology_vendor) || null,
    vendor_registration_url: txt(config.vendor_registration_url || publisher.vendor_registration_url) || null,
    registration_required: config.registration_required === true,
    authentication_required: config.authentication_required === true,
    access_instructions: txt(config.access_instructions) || null,
    official_sources: arr(config.official_sources)
  };
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUrl(href, base) {
  try { return new URL(href, base).toString().replace(/#.*$/, ''); } catch { return null; }
}

function isExcludedLink(url, label) {
  const text = `${url} ${label}`.toLowerCase();
  return /\b(signup|sign-up|register|registration|login|log-in|help|faq|training|vendor|supplier|privacy|terms|contact|about|calendar|archive)\b/.test(text);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const opportunity = /\b(rfp|rfq|ifb|itb|bid|solicitation|proposal|quote|tender|opportunit|contract|addendum|project)\b/i;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const label = stripHtml(match[2]);
    const url = resolveUrl(txt(match[1]), baseUrl);
    if (!url || !/^https?:/i.test(url) || !opportunity.test(`${label} ${url}`) || isExcludedLink(url, label) || seen.has(url)) continue;
    seen.add(url);
    links.push({ title: label || 'Solicitation opportunity', source_url: url, discovered_from: baseUrl });
    if (links.length >= 100) break;
  }
  return links;
}

function recordsFromJson(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['results','items','records','data','opportunities','notices','solicitations','projects']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function deriveFields(text, fallbackTitle) {
  const clean = stripHtml(text).slice(0, 30000);
  const title = txt(fallbackTitle) || clean.slice(0, 220) || 'Solicitation opportunity';
  const solicitation = clean.match(/(?:solicitation|bid|rfp|rfq|ifb|itb|project)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/i)?.[1] || null;
  const email = clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  const phone = clean.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/)?.[0] || null;
  const deadlineText = clean.match(/(?:due|deadline|responses? due|proposal due|bid opening)\s*(?:date)?\s*[:\-]?\s*([^.;]{6,70})/i)?.[1] || null;
  const procurementSignals = (clean.match(/\b(scope of work|statement of work|requirements?|deliverables?|request for proposal|request for qualifications|invitation for bid|solicitation|bid opening|proposal due)\b/gi) || []).length;
  return { title, description: clean, solicitation_number: solicitation, contact_email: email, contact_phone: phone, deadline_text: deadlineText, procurementSignals };
}

async function fetchUrl(url, accept = 'text/html,application/json,application/pdf;q=0.9,*/*;q=0.8') {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'APROPOS-APIE-AcquisitionDiscovery/3.0', 'Cache-Control': 'no-cache' },
        redirect: 'follow', signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      return { contentType, text, finalUrl: res.url || url, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(400);
    } finally { clearTimeout(timer); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function enrichCandidate(candidate, profile) {
  const fetched = await fetchUrl(candidate.source_url);
  if (fetched.contentType.includes('json')) {
    let payload;
    try { payload = JSON.parse(fetched.text); } catch { payload = null; }
    const rows = recordsFromJson(payload);
    if (rows.length === 1) {
      const row = rows[0];
      const description = txt(row.description || row.summary || row.scope || row.requirements_text);
      return description.length >= 80 ? { ...row, title: txt(row.title || row.name || candidate.title), description, source_url: fetched.finalUrl } : null;
    }
  }
  if (fetched.contentType.includes('pdf') || /\.pdf(?:$|\?)/i.test(fetched.finalUrl)) {
    return { ...candidate, record_type: 'SOLICITATION_DOCUMENT', title: candidate.title || fetched.finalUrl.split('/').pop(), description: `Official solicitation document available at ${fetched.finalUrl}. Procurement requirements require document extraction.`, document_url: fetched.finalUrl, source_url: fetched.finalUrl, extraction_required: true };
  }
  const fields = deriveFields(fetched.text, candidate.title);
  if (fields.description.length < 200 || fields.procurementSignals < 2) return null;
  return { ...candidate, ...fields, record_type: 'INDIVIDUAL_SOLICITATION_DETAIL', source_url: fetched.finalUrl, official_source_url: fetched.finalUrl, requirements: { scope: fields.description } };
}

async function insertRawRows(rows) {
  if (!rows.length) return [];
  try {
    return await db('acquisition_raw_records?on_conflict=publisher_id,source_record_id,source_fingerprint', {
      method: 'POST', body: JSON.stringify(rows), headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }
    }) || [];
  } catch (error) {
    if (/duplicate key value|unique constraint/i.test(error instanceof Error ? error.message : String(error))) return [];
    throw error;
  }
}

async function routePending(batchSize = 500) {
  try {
    const result = await db('rpc/aadp_route_pending_raw_records', { method: 'POST', body: JSON.stringify({ p_batch_size: batchSize }) });
    return result || {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  const body = parseBody(event);
  const commandRunId = txt(body.command_run_id);
  const stateCode = txt(body.state_code).toUpperCase();
  const publisherScope = txt(body.publisher_scope || 'ALL').toUpperCase();
  const publisherId = body.publisher_id ? txt(body.publisher_id) : null;
  if (!commandRunId || !/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'command_run_id and state_code are required' });

  try {
    await db(`command_runs?id=eq.${commandRunId}`, { method: 'PATCH', body: JSON.stringify({ status:'running', aadp_state:'RUNNING', current_stage:'RESOLVING_PUBLISHER_CONNECTION_PROFILES', progress_value:5, last_activity_at:now() }) });
    const publisherFilter = publisherScope === 'SINGLE' ? `&id=eq.${encodeURIComponent(publisherId)}` : '';
    const publishers = await db(`publisher_registry?state_code=eq.${stateCode}&verified=eq.true${publisherFilter}&select=*`);
    const ids = new Set((publishers || []).map(p => String(p.id)));
    const assignments = await db('publisher_assignments?status=eq.READY&select=*&order=updated_at.desc');
    const selected = latestAssignmentPerPublisher((assignments || []).filter(a => ids.has(String(a.publisher_id))));
    if (!selected.length) throw new Error(`No READY publisher connection assignments are available for ${stateCode}.`);

    let publisherSuccess = 0, discovered = 0, detailed = 0, insertedCount = 0, failures = 0, duplicateCount = 0;
    const failureDetails = [];
    const maxDetails = publisherScope === 'SINGLE' ? 100 : 250;
    let detailBudget = maxDetails;

    for (let index = 0; index < selected.length; index++) {
      const assignment = selected[index];
      const publisher = publishers.find(p => String(p.id) === String(assignment.publisher_id)) || {};
      const profile = buildProfile(assignment, publisher);
      const run = (await db('acquisition_runs', { method:'POST', body:JSON.stringify({ command_run_id:commandRunId, assignment_id:assignment.id, status:'RUNNING', started_at:now(), evidence:{ publisher_connection_profile:profile, handoff_source:'PUBLISHER_DISCOVERY' } }) }))?.[0];
      try {
        if (!profile.endpoint) throw new Error('Publisher has no acquisition endpoint');
        const root = await fetchUrl(profile.endpoint, profile.method === 'API' ? 'application/json,*/*;q=0.8' : undefined);
        let candidates = [];
        let directRecords = [];
        if (root.contentType.includes('json')) {
          let payload; try { payload = JSON.parse(root.text); } catch { payload = null; }
          directRecords = recordsFromJson(payload);
        } else if (root.contentType.includes('pdf')) {
          candidates = [{ title: root.finalUrl.split('/').pop(), source_url: root.finalUrl }];
        } else {
          candidates = extractLinks(root.text, root.finalUrl);
          const rootFields = deriveFields(root.text, publisher.publisher_name);
          if (!candidates.length && rootFields.procurementSignals >= 2 && rootFields.description.length >= 200) directRecords = [{ ...rootFields, record_type:'INDIVIDUAL_SOLICITATION_DETAIL', source_url:root.finalUrl, official_source_url:root.finalUrl, requirements:{ scope:rootFields.description } }];
        }
        discovered += directRecords.length + candidates.length;
        const detailTargets = candidates.slice(0, Math.max(0, Math.min(detailBudget, 25)));
        detailBudget -= detailTargets.length;
        const enriched = [...directRecords];
        for (let offset = 0; offset < detailTargets.length; offset += 5) {
          const batch = detailTargets.slice(offset, offset + 5);
          const results = await Promise.all(batch.map(item => enrichCandidate(item, profile).catch(() => null)));
          enriched.push(...results.filter(Boolean));
        }
        detailed += enriched.length;
        const rawRows = enriched.map((record, recordIndex) => {
          const sourceUrl = txt(record.source_url || profile.endpoint);
          const sourceId = txt(record.id || record.noticeId || record.solicitation_number || record.solicitationNumber || sourceUrl || `${assignment.id}-${recordIndex}`);
          const serialized = JSON.stringify(record);
          return {
            acquisition_run_id: run.id, assignment_id: assignment.id, publisher_id: assignment.publisher_id,
            source_record_id: sourceId, source_url: sourceUrl,
            raw_payload: { ...record, issuing_organization: publisher.publisher_name, state_code: stateCode, __acquisition_method:profile.method, __procurement_platform:profile.procurement_platform, __publisher_connection_profile:profile, __source_page_type:'SOLICITATION_DETAIL' },
            source_fingerprint: hash(`${assignment.publisher_id}:${sourceId}:${sourceUrl}`), content_fingerprint: hash(serialized), processing_status:'RAW', detail_retrieval_status:'COMPLETE', detail_retrieved_at:now()
          };
        });
        const inserted = await insertRawRows(rawRows);
        insertedCount += inserted.length;
        duplicateCount += rawRows.length - inserted.length;
        publisherSuccess++;
        await db(`acquisition_runs?id=eq.${run.id}`, { method:'PATCH', body:JSON.stringify({ status:'COMPLETED', records_discovered:candidates.length + directRecords.length, records_acquired:inserted.length, pages_processed:1 + detailTargets.length, pagination_complete:true, completed_at:now(), evidence:{ profile, solicitation_candidates:candidates.length, detail_pages_retrieved:enriched.length, duplicates:rawRows.length-inserted.length } }) });
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        failureDetails.push({ publisher_name:publisher.publisher_name, endpoint:profile.endpoint, error:message });
        if (run?.id) await db(`acquisition_runs?id=eq.${run.id}`, { method:'PATCH', body:JSON.stringify({ status:'FAILED', retrieval_failures:1, completed_at:now(), evidence:{ profile, error:message } }) }).catch(()=>null);
      }
      const progress = Math.min(90, 10 + Math.round(((index + 1) / selected.length) * 80));
      await db(`command_runs?id=eq.${commandRunId}`, { method:'PATCH', body:JSON.stringify({ current_stage:'RETRIEVING_SOLICITATION_DETAILS', progress_value:progress, records_discovered:discovered, records_acquired:insertedCount, failure_count:failures, last_activity_at:now() }) });
    }

    await db(`command_runs?id=eq.${commandRunId}`, { method:'PATCH', body:JSON.stringify({ current_stage:'POSTGRES_QUALIFICATION_ROUTING', progress_value:94, last_activity_at:now() }) });
    const routing = await routePending(500);
    const canonicalInserted = Number(routing?.canonical_inserted || 0);
    const extractionRequired = Number(routing?.extraction_required || 0);
    const summary = `Acquisition Discovery processed ${selected.length} publisher profiles, discovered ${discovered} candidates, retrieved ${detailed} solicitation details, stored ${insertedCount} new enriched records, and routed ${canonicalInserted} contracts into the canonical repository.`;
    const partial = failures > 0;
    await db(`command_runs?id=eq.${commandRunId}`, { method:'PATCH', body:JSON.stringify({ status:'completed', aadp_state:partial?'PARTIALLY_COMPLETE':'COMPLETED', current_stage:'COMPLETED', progress_value:100, records_discovered:discovered, records_acquired:insertedCount, records_accepted:canonicalInserted, records_rejected:Number(routing?.rejected||0), warning_count:failures+duplicateCount+extractionRequired, failure_count:0, action_required:partial, completed_at:now(), last_activity_at:now(), result_summary:summary, execution_evidence:{ publishers_processed:selected.length, publishers_succeeded:publisherSuccess, solicitation_candidates_discovered:discovered, detail_records_retrieved:detailed, enriched_raw_records_inserted:insertedCount, canonical_contracts_inserted:canonicalInserted, extraction_required:extractionRequired, duplicate_or_existing_records:duplicateCount, routing_result:routing, failures, failure_details:failureDetails, completion_classification:partial?'COMPLETED_WITH_WARNINGS':'COMPLETED' } }) });
    return response(200, { ok:true, command_run_id:commandRunId, publishers_processed:selected.length, publishers_succeeded:publisherSuccess, solicitation_candidates_discovered:discovered, detail_records_retrieved:detailed, enriched_raw_records_inserted:insertedCount, canonical_contracts_inserted:canonicalInserted, routing_result:routing, failures, failure_details:failureDetails });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db(`command_runs?id=eq.${commandRunId}`, { method:'PATCH', body:JSON.stringify({ status:'failed', aadp_state:'FAILED', current_stage:'WORKER_FAILED', action_required:true, completed_at:now(), last_activity_at:now(), result_summary:message }) }).catch(()=>null);
    return response(500, { error:message });
  }
};
