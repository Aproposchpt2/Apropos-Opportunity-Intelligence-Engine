import { corsHeaders, db, invoke, json, parseBody, recordEvent , requireServiceRole } from '../_shared/command.ts';

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

function firstText(source: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return '';
}

function extractRecords(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter(row => Object.keys(row).length);
  const root = asRecord(payload);
  for (const key of ['records','items','results','data','opportunities','solicitations','notices']) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).map(asRecord).filter(row => Object.keys(row).length);
  }
  return Object.keys(root).length ? [root] : [];
}

function normalized(row: JsonRecord): JsonRecord {
  const raw = asRecord(row.raw_payload);
  return asRecord(raw.__aadp_normalized ?? raw);
}

function buildPageUrl(endpoint: string, parameters: JsonRecord, instructions: JsonRecord, page: number): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'headers' || key.startsWith('acceptance_') || value == null) continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  const mode = text(instructions.mode || instructions.type).toLowerCase();
  const pageSize = Number(instructions.page_size ?? instructions.limit ?? 100);
  if (mode === 'offset') url.searchParams.set(text(instructions.offset_parameter || instructions.offset_param) || 'offset', String((page - 1) * pageSize));
  else url.searchParams.set(text(instructions.page_parameter || instructions.page_param) || 'page', String(page));
  url.searchParams.set(text(instructions.page_size_parameter || instructions.limit_parameter) || 'limit', String(pageSize));
  return url.toString();
}

async function acquisitionRun(runId: string): Promise<JsonRecord> {
  const rows = await db(`acquisition_runs?command_run_id=eq.${runId}&select=*&order=created_at.desc&limit=1`);
  if (!rows?.[0]) throw new Error('Acquisition run has not been initialized');
  return rows[0];
}

async function handlePageFetch(body: JsonRecord) {
  const runId = text(body.run_id);
  const assignment = asRecord(body.assignment);
  const attemptNumber = Number(body.attempt_number ?? 1);
  const parameters = asRecord(assignment.search_parameters);
  const failOnceTask = text(parameters.acceptance_fail_once_task);
  if (failOnceTask === 'ACQUISITION_PAGE_FETCH' && attemptNumber === 1) {
    throw new Error('CONTROLLED_TRANSIENT_ACCEPTANCE_FAILURE');
  }

  const run = await acquisitionRun(runId);
  const endpoint = text(assignment.search_endpoint);
  if (!endpoint) throw new Error('Publisher assignment has no search endpoint');
  const pagination = asRecord(assignment.pagination_instructions);
  const maxPages = Math.min(Math.max(Number(pagination.max_pages ?? 100), 1), 1000);
  const pageSize = Math.min(Math.max(Number(pagination.page_size ?? pagination.limit ?? 100), 1), 1000);
  const headers = asRecord(parameters.headers);
  let pagesProcessed = 0;
  let discovered = 0;
  let acquired = 0;
  let failures = 0;
  let paginationComplete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = buildPageUrl(endpoint, parameters, pagination, page);
    const response = await fetch(pageUrl, { headers: Object.fromEntries(Object.entries(headers).map(([key,value]) => [key,String(value)])) });
    if (!response.ok) {
      failures += 1;
      throw new Error(`Publisher retrieval failed (${response.status}) at page ${page}`);
    }
    const payload = await response.json();
    const records = extractRecords(payload);
    pagesProcessed += 1;
    discovered += records.length;
    for (const record of records) {
      const sourceRecordId = firstText(record, ['source_record_id','id','noticeId','notice_id','solicitationNumber','solicitation_number','bidNumber','bid_number','referenceNumber','reference_number']) || await sha256(canonicalJson(record));
      const sourceUrl = firstText(record, ['official_source_url','source_url','url','detailUrl','detail_url','link']) || endpoint;
      const contentFingerprint = await sha256(canonicalJson(record));
      const sourceFingerprint = await sha256(`${text(assignment.publisher_id)}|${sourceRecordId}|${sourceUrl}`);
      const existing = await db(`acquisition_raw_records?publisher_id=eq.${assignment.publisher_id}&source_record_id=eq.${encodeURIComponent(sourceRecordId)}&content_fingerprint=eq.${contentFingerprint}&select=id`);
      if (existing.length) continue;
      const sourceVersion = firstText(record, ['version','revision','revision_number','amendment_number','amendmentNumber']);
      await db('acquisition_raw_records', { method: 'POST', body: JSON.stringify({
        acquisition_run_id: run.id,
        assignment_id: assignment.id,
        publisher_id: assignment.publisher_id,
        source_record_id: sourceRecordId,
        source_url: sourceUrl,
        raw_payload: record,
        source_fingerprint: sourceFingerprint,
        content_fingerprint: contentFingerprint,
        source_version: sourceVersion || null,
        canonical_opportunity_id: firstText(record, ['canonical_opportunity_id','parent_opportunity_id','parentOpportunityId','solicitation_number','solicitationNumber']) || sourceRecordId,
        version_number: Number(sourceVersion) || null,
        version_effective_at: firstText(record, ['last_modified','lastModified','publication_date','posted_at','postedAt']) || null,
        processing_status: 'RAW'
      }) });
      acquired += 1;
    }
    const root = asRecord(payload);
    if (records.length === 0 || (!root.next && !Boolean(root.has_more ?? root.hasMore) && records.length < pageSize)) {
      paginationComplete = true;
      break;
    }
  }

  await db(`acquisition_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({
    records_discovered: discovered,
    records_acquired: acquired,
    pages_processed: pagesProcessed,
    retrieval_failures: failures,
    pagination_complete: paginationComplete,
    evidence: { endpoint, max_pages: maxPages, page_size: pageSize, completed_at: now(), attempt_number: attemptNumber }
  }) });
  return { success: true, task_type: 'ACQUISITION_PAGE_FETCH', metrics: { pages_processed: pagesProcessed, records_discovered: discovered, records_acquired: acquired, retrieval_failures: failures }, evidence: { acquisition_run_id: run.id, endpoint, pagination_complete: paginationComplete, attempt_number: attemptNumber } };
}

function materialDiff(previous: JsonRecord, current: JsonRecord) {
  const previousNormalized = normalized(previous);
  const currentNormalized = normalized(current);
  return {
    content_changed: text(previous.content_fingerprint) !== text(current.content_fingerprint),
    lifecycle_changed: text(previousNormalized.status) !== text(currentNormalized.status),
    deadline_changed: text(previousNormalized.response_deadline) !== text(currentNormalized.response_deadline),
    requirements_changed: canonicalJson(previousNormalized.requirements) !== canonicalJson(currentNormalized.requirements),
    contact_changed: [previousNormalized.contact_name,previousNormalized.contact_email,previousNormalized.contact_phone].map(text).join('|') !== [currentNormalized.contact_name,currentNormalized.contact_email,currentNormalized.contact_phone].map(text).join('|'),
    documents_changed: canonicalJson(previousNormalized.document_urls) !== canonicalJson(currentNormalized.document_urls)
  };
}

async function relationship(runId: string, publisherId: string, canonicalId: string, recordId: string, relatedId: string | null, type: string, evidence: JsonRecord) {
  await db('aadp_record_version_relationships', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ acquisition_run_id: runId, publisher_id: publisherId, canonical_opportunity_id: canonicalId, record_id: recordId, related_record_id: relatedId, relationship_type: type, evidence }) });
}

async function handleVersionGovernance(body: JsonRecord) {
  const run = await acquisitionRun(text(body.run_id));
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=*&order=version_detected_at.asc,retrieval_timestamp.asc`);
  const groups = new Map<string, JsonRecord[]>();
  for (const row of rows) {
    const item = normalized(row);
    const canonicalId = text(row.canonical_opportunity_id) || text(item.solicitation_number) || text(row.source_record_id);
    const key = `${row.publisher_id}|${canonicalId}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...row, canonical_id: canonicalId }]);
  }
  let exactDuplicates = 0;
  let contentUpdates = 0;
  let amendments = 0;
  let superseded = 0;
  let current = 0;

  for (const group of groups.values()) {
    group.sort((a,b) => Number(a.version_number ?? 0) - Number(b.version_number ?? 0) || String(a.version_effective_at ?? a.retrieval_timestamp).localeCompare(String(b.version_effective_at ?? b.retrieval_timestamp)));
    let predecessor: JsonRecord | null = null;
    for (const row of group) {
      const item = normalized(row);
      const explicitAmendment = firstText(asRecord(row.raw_payload), ['amendment_of_record_id','amendmentOf','parent_record_id']);
      if (!predecessor) {
        await db(`acquisition_raw_records?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ canonical_opportunity_id: row.canonical_id, is_current_version: true, version_reason: 'CURRENT_LATEST_VERSION' }) });
        await relationship(run.id as string, row.publisher_id as string, row.canonical_id as string, row.id as string, null, 'CURRENT_LATEST_VERSION', { source_version: row.source_version });
        predecessor = row;
        current += 1;
        continue;
      }
      if (text(predecessor.content_fingerprint) === text(row.content_fingerprint)) {
        exactDuplicates += 1;
        await db(`acquisition_raw_records?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ processing_status: 'DUPLICATE', is_current_version: false, predecessor_record_id: predecessor.id, version_reason: 'EXACT_DUPLICATE' }) });
        await db('acquisition_record_dispositions', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ acquisition_run_id: run.id, raw_record_id: row.id, disposition: 'DUPLICATE', reason_code: 'DUPLICATE_RECORD', evidence: { relationship: 'EXACT_DUPLICATE', predecessor_record_id: predecessor.id } }) });
        await relationship(run.id as string, row.publisher_id as string, row.canonical_id as string, row.id as string, predecessor.id as string, 'EXACT_DUPLICATE', {});
        continue;
      }
      const diff = materialDiff(predecessor, row);
      const relationshipType = explicitAmendment ? 'AMENDMENT' : Number(row.version_number ?? 0) > Number(predecessor.version_number ?? 0) ? 'NEW_SOURCE_VERSION' : 'CONTENT_UPDATE';
      if (relationshipType === 'AMENDMENT') amendments += 1; else contentUpdates += 1;
      superseded += 1;
      await db(`acquisition_raw_records?id=eq.${predecessor.id}`, { method: 'PATCH', body: JSON.stringify({ processing_status: 'SUPERSEDED', is_current_version: false, superseded_by_record_id: row.id, version_reason: 'SUPERSEDED_PREDECESSOR', ...diff }) });
      await db('acquisition_record_dispositions', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ acquisition_run_id: run.id, raw_record_id: predecessor.id, disposition: 'SUPERSEDED', reason_code: 'SUPERSEDED_RECORD', evidence: { relationship: 'SUPERSEDED_PREDECESSOR', superseded_by_record_id: row.id, ...diff } }) });
      await relationship(run.id as string, predecessor.publisher_id as string, predecessor.canonical_id as string, predecessor.id as string, row.id as string, 'SUPERSEDED_PREDECESSOR', diff);
      await db(`acquisition_raw_records?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ canonical_opportunity_id: row.canonical_id, predecessor_record_id: predecessor.id, amendment_of_record_id: relationshipType === 'AMENDMENT' ? predecessor.id : null, is_current_version: true, version_reason: relationshipType, ...diff }) });
      await relationship(run.id as string, row.publisher_id as string, row.canonical_id as string, row.id as string, predecessor.id as string, relationshipType, diff);
      predecessor = row;
    }
  }
  return { success: true, task_type: 'RECORD_DEDUPLICATION', metrics: { exact_duplicates: exactDuplicates, content_updates: contentUpdates, amendments, superseded_predecessors: superseded, current_latest_versions: current }, evidence: { acquisition_run_id: run.id, version_model: 'AADP-VERSION-GOVERNANCE-V1', groups: groups.size } };
}

async function handleAoieReview(body: JsonRecord) {
  const runId = text(body.run_id);
  const run = await acquisitionRun(runId);
  const qualified = await db(`acquisition_record_dispositions?acquisition_run_id=eq.${run.id}&disposition=eq.QUALIFIED&qualified_record_id=not.is.null&select=id`);
  const analyses = await db(`procurement_language_analysis?acquisition_run_id=eq.${run.id}&select=*`);
  const expected = qualified.length;
  const actual = analyses.length;
  if (expected !== actual) {
    const variance = expected - actual;
    await db('aadp_action_needed_alerts', { method: 'POST', body: JSON.stringify({ command_run_id: runId, state_code: null, publisher_id: body.assignment?.publisher_id, publisher_name: body.assignment?.publisher_name, current_stage: 'AOIE_BATCH_REVIEW', reason: 'AOIE analysis population does not reconcile.', supporting_evidence: { expected_analysis_count: expected, actual_analysis_count: actual, variance }, risk: 'Recommendation determination would be incomplete.', recommended_action: 'Send to Engineering Review', resume_point: 'PROCUREMENT_LANGUAGE_ANALYSIS', unrelated_publishers_may_continue: true }) });
    throw new Error(`AOIE_ANALYSIS_COUNT_VARIANCE:${variance}`);
  }
  const lowConfidence = analyses.filter((item: JsonRecord) => Number(item.confidence ?? 0) < 0.7).length;
  const existing = await db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=id`);
  const report = { result_indicator: lowConfidence > 0 ? 'NEEDS YOUR ATTENTION' : 'NO RECOMMENDATIONS AT THIS TIME', expected_analysis_count: expected, actual_analysis_count: actual, records_analyzed: actual, low_confidence_analyses: lowConfidence, count_variance: 0, production_matching_changed: false, aoie_result: 'VALID' };
  const payload = { acquisition_run_id: run.id, status: 'COMPLETED', records_analyzed: actual, low_confidence_analyses: lowConfidence, report, started_at: now(), completed_at: now() };
  if (existing.length) await db(`aoie_batch_reviews?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  else await db('aoie_batch_reviews', { method: 'POST', body: JSON.stringify(payload) });
  return { success: true, task_type: 'AOIE_BATCH_REVIEW', metrics: { aoie_records_reviewed: actual, low_confidence_analyses: lowConfidence, aoie_count_variance: 0 }, evidence: { acquisition_run_id: run.id, ...report } };
}

async function handleExecutiveReport(body: JsonRecord) {
  const runId = text(body.run_id);
  const run = await acquisitionRun(runId);
  const [raw, dispositions, rejections, analyses, reviews, tasks, failures, alerts] = await Promise.all([
    db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=id`),
    db(`acquisition_record_dispositions?acquisition_run_id=eq.${run.id}&select=disposition,qualified_record_id`),
    db(`acquisition_rejections?acquisition_run_id=eq.${run.id}&select=rejection_code`),
    db(`procurement_language_analysis?acquisition_run_id=eq.${run.id}&select=id,confidence`),
    db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=*`),
    db(`command_tasks?run_id=eq.${runId}&select=task_type,state,measurable_result`),
    db(`command_failures?run_id=eq.${runId}&select=*`),
    db(`aadp_action_needed_alerts?command_run_id=eq.${runId}&status=eq.OPEN&select=*`)
  ]);
  const review = reviews?.[0] ?? null;
  const recommendations = review ? await db(`aoie_change_recommendations?batch_review_id=eq.${review.id}&select=*`) : [];
  const reconciliationResult = await db('rpc/aadp_reconcile_run', { method: 'POST', body: JSON.stringify({ p_acquisition_run_id: run.id }) });
  const reconciliation = Array.isArray(reconciliationResult) ? reconciliationResult[0] : reconciliationResult;
  const totals: Record<string,number> = {};
  for (const row of dispositions) totals[row.disposition] = (totals[row.disposition] ?? 0) + 1;
  const aoieValid = Boolean(review?.report?.aoie_result === 'VALID' && Number(review.records_analyzed) === analyses.length && analyses.length === Number(totals.QUALIFIED ?? 0));
  const report = {
    command_run_id: runId,
    acquisition: { acquisition_run_id: run.id, records_retrieved: raw.length, pages_processed: Number(run.pages_processed ?? 0), retrieval_failures: Number(run.retrieval_failures ?? 0), pagination_complete: Boolean(run.pagination_complete) },
    processing: { dispositions: totals, rejection_count: rejections.length, qualified_count: Number(totals.QUALIFIED ?? 0) },
    aoie: { analyses: analyses.length, review, recommendations: recommendations.length, result_indicator: review?.report?.result_indicator ?? 'NEEDS YOUR ATTENTION', production_matching_changed: false, aoie_result: aoieValid ? 'VALID' : 'INVALID' },
    command_center: { tasks, failures: failures.length, unresolved_action_needed: alerts.length },
    reconciliation
  };
  const existing = await db(`executive_run_reports?command_run_id=eq.${runId}&select=id`);
  const finalStatus = aoieValid && alerts.length === 0 && reconciliation?.passed ? 'COMPLETED' : 'ACTION_NEEDED';
  const payload = { ...report, final_status: finalStatus === 'COMPLETED' ? 'COMPLETED' : 'PARTIALLY_COMPLETE' };
  if (existing.length) await db(`executive_run_reports?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  else await db('executive_run_reports', { method: 'POST', body: JSON.stringify(payload) });
  return { success: true, task_type: 'EXECUTIVE_REPORT_CREATE', metrics: { executive_reports_created: existing.length ? 0 : 1, final_records_reconciled: raw.length, aoie_result_valid: aoieValid ? 1 : 0 }, evidence: report };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    const taskType = text(body.task_type);
    if (!taskType || !text(body.run_id)) return json({ error: 'run_id and task_type are required' }, 400);
    if (taskType === 'ACQUISITION_PAGE_FETCH') return json(await handlePageFetch(body));
    if (taskType === 'RECORD_DEDUPLICATION') return json(await handleVersionGovernance(body));
    if (taskType === 'AOIE_BATCH_REVIEW') return json(await handleAoieReview(body));
    if (taskType === 'EXECUTIVE_REPORT_CREATE') return json(await handleExecutiveReport(body));
    return json(await invoke('aadp-task-executor', body));
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
