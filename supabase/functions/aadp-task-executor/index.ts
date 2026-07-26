import { corsHeaders, db, json, parseBody, recordEvent } from '../_shared/command.ts';
import { validateAssignment } from '../_shared/aadp.ts';

type JsonRecord = Record<string, unknown>;

type TaskContext = {
  runId: string;
  taskId: string;
  taskType: string;
  assignment: JsonRecord;
};

const now = () => new Date().toISOString();

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function firstText(source: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return '';
}

function firstValue(source: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function extractRecords(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter(item => Object.keys(item).length > 0);
  const root = asRecord(payload);
  for (const key of ['records', 'items', 'results', 'data', 'opportunities', 'solicitations', 'notices']) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).map(asRecord).filter(item => Object.keys(item).length > 0);
  }
  return Object.keys(root).length ? [root] : [];
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function getNormalized(rawPayload: unknown): JsonRecord {
  const raw = asRecord(rawPayload);
  return asRecord(raw.__aadp_normalized ?? raw);
}

function buildNormalized(rawPayload: unknown, assignment: JsonRecord): JsonRecord {
  const raw = asRecord(rawPayload);
  const contact = asRecord(firstValue(raw, ['contact', 'pointOfContact', 'point_of_contact']));
  const sourceRecordId = firstText(raw, [
    'source_record_id', 'id', 'noticeId', 'notice_id', 'solicitationNumber', 'solicitation_number',
    'bidNumber', 'bid_number', 'referenceNumber', 'reference_number'
  ]);
  const sourceUrl = firstText(raw, ['official_source_url', 'source_url', 'url', 'detailUrl', 'detail_url', 'link']);
  const requirementsValue = firstValue(raw, ['requirements', 'requirements_text', 'scope', 'scope_of_work', 'description', 'summary']);
  const documentValue = firstValue(raw, ['document_urls', 'documents', 'attachments', 'files']);
  const status = firstText(raw, ['status', 'noticeStatus', 'notice_status', 'lifecycle_status']) || 'open';

  return {
    source_record_id: sourceRecordId,
    solicitation_number: firstText(raw, ['solicitation_number', 'solicitationNumber', 'bid_number', 'bidNumber', 'reference_number', 'referenceNumber']) || sourceRecordId,
    title: firstText(raw, ['title', 'name', 'solicitation_title', 'notice_title']) || `Procurement opportunity ${sourceRecordId || 'record'}`,
    description: firstText(raw, ['description', 'summary', 'scope', 'scope_of_work']),
    requirements: typeof requirementsValue === 'object' && requirementsValue !== null
      ? requirementsValue
      : requirementsValue ? { text: text(requirementsValue) } : {},
    document_urls: normalizeArray(documentValue).map(item => typeof item === 'string' ? item : asRecord(item)),
    status,
    response_deadline: firstText(raw, ['response_deadline', 'responseDeadline', 'deadline', 'due_date', 'dueDate', 'close_date', 'closeDate']) || null,
    posted_at: firstText(raw, ['posted_at', 'postedAt', 'posted_date', 'postedDate', 'publication_date']) || null,
    issuing_organization: firstText(raw, ['issuing_organization', 'organization', 'agency', 'department', 'buyer']) || text(assignment.publisher_name),
    issuing_department: firstText(raw, ['issuing_department', 'department', 'division']) || null,
    contact_name: firstText(raw, ['contact_name', 'contactName']) || firstText(contact, ['name', 'full_name']),
    contact_email: firstText(raw, ['contact_email', 'contactEmail', 'email']) || firstText(contact, ['email']),
    contact_phone: firstText(raw, ['contact_phone', 'contactPhone', 'phone']) || firstText(contact, ['phone', 'telephone']),
    official_source_url: firstText(raw, ['official_source_url', 'officialSourceUrl']) || sourceUrl,
    source_url: sourceUrl || text(assignment.search_endpoint),
    procurement_type: firstText(raw, ['procurement_type', 'procurementType', 'type', 'notice_type']) || null,
    state_code: firstText(raw, ['state_code', 'state', 'place_of_performance_state']) || null,
    place_of_performance_county: firstText(raw, ['county', 'place_of_performance_county']) || null,
    place_of_performance_city: firstText(raw, ['city', 'place_of_performance_city']) || null,
    raw
  };
}

async function acquisitionRun(runId: string): Promise<JsonRecord> {
  const rows = await db(`acquisition_runs?command_run_id=eq.${runId}&select=*&order=created_at.desc&limit=1`);
  const row = rows?.[0];
  if (!row) throw new Error('Acquisition run has not been initialized');
  return row;
}

async function publisher(assignment: JsonRecord): Promise<JsonRecord> {
  const id = text(assignment.publisher_id);
  const rows = await db(`publisher_registry?id=eq.${id}&select=*`);
  return rows?.[0] ?? {};
}

async function handleAssignment(ctx: TaskContext) {
  validateAssignment(ctx.assignment as any);
  return {
    metrics: { assignments_validated: 1 },
    evidence: {
      assignment_id: text(ctx.assignment.id),
      publisher_id: text(ctx.assignment.publisher_id),
      acquisition_method: text(ctx.assignment.acquisition_method),
      qualification_ruleset_version: text(ctx.assignment.qualification_ruleset_version)
    }
  };
}

async function handleRunStart(ctx: TaskContext) {
  const existing = await db(`acquisition_runs?command_run_id=eq.${ctx.runId}&select=*`);
  if (existing.length) {
    return { metrics: { acquisition_runs_created: 0 }, evidence: { acquisition_run_id: existing[0].id, idempotent: true } };
  }
  const created = await db('acquisition_runs', {
    method: 'POST',
    body: JSON.stringify({
      command_run_id: ctx.runId,
      assignment_id: ctx.assignment.id,
      status: 'RUNNING',
      started_at: now(),
      evidence: { executor: 'aadp-task-executor', graph_version: 'AADP-1.0' }
    })
  });
  return { metrics: { acquisition_runs_created: 1 }, evidence: { acquisition_run_id: created[0].id, idempotent: false } };
}

function buildPageUrl(endpoint: string, parameters: JsonRecord, instructions: JsonRecord, page: number): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  const mode = text(instructions.mode || instructions.type).toLowerCase();
  const pageParam = text(instructions.page_parameter || instructions.page_param) || 'page';
  const offsetParam = text(instructions.offset_parameter || instructions.offset_param) || 'offset';
  const pageSizeParam = text(instructions.page_size_parameter || instructions.limit_parameter) || 'limit';
  const pageSize = Number(instructions.page_size ?? instructions.limit ?? 100);
  if (mode === 'offset') url.searchParams.set(offsetParam, String((page - 1) * pageSize));
  else url.searchParams.set(pageParam, String(page));
  url.searchParams.set(pageSizeParam, String(pageSize));
  return url.toString();
}

async function handlePageFetch(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const assignment = ctx.assignment;
  const endpoint = text(assignment.search_endpoint);
  if (!endpoint) throw new Error('Publisher assignment has no search endpoint');

  const pagination = asRecord(assignment.pagination_instructions);
  const searchParameters = asRecord(assignment.search_parameters);
  const maxPages = Math.min(Math.max(Number(pagination.max_pages ?? 100), 1), 1000);
  const pageSize = Math.min(Math.max(Number(pagination.page_size ?? pagination.limit ?? 100), 1), 1000);
  const headers = asRecord(searchParameters.headers);
  delete searchParameters.headers;

  let pagesProcessed = 0;
  let discovered = 0;
  let acquired = 0;
  let failures = 0;
  let paginationComplete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = buildPageUrl(endpoint, searchParameters, pagination, page);
    const response = await fetch(pageUrl, { headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])) });
    if (!response.ok) {
      failures += 1;
      throw new Error(`Publisher retrieval failed (${response.status}) at page ${page}`);
    }
    const payload = await response.json();
    const records = extractRecords(payload);
    pagesProcessed += 1;
    discovered += records.length;

    for (const record of records) {
      const normalized = buildNormalized(record, assignment);
      const sourceRecordId = text(normalized.source_record_id) || await sha256(canonicalJson(record));
      const sourceUrl = text(normalized.source_url) || endpoint;
      const sourceFingerprint = await sha256(`${text(assignment.publisher_id)}|${sourceRecordId}|${sourceUrl}`);
      const contentFingerprint = await sha256(canonicalJson(record));
      const existing = await db(
        `acquisition_raw_records?publisher_id=eq.${assignment.publisher_id}&source_record_id=eq.${encodeURIComponent(sourceRecordId)}&source_fingerprint=eq.${sourceFingerprint}&select=id`
      );
      if (existing.length) continue;
      await db('acquisition_raw_records', {
        method: 'POST',
        body: JSON.stringify({
          acquisition_run_id: run.id,
          assignment_id: assignment.id,
          publisher_id: assignment.publisher_id,
          source_record_id: sourceRecordId,
          source_url: sourceUrl,
          raw_payload: record,
          source_fingerprint: sourceFingerprint,
          content_fingerprint: contentFingerprint,
          source_version: firstText(record, ['version', 'amendment_number', 'amendmentNumber']) || null,
          processing_status: 'RAW'
        })
      });
      acquired += 1;
    }

    const next = asRecord(payload).next;
    const hasMore = Boolean(asRecord(payload).has_more ?? asRecord(payload).hasMore);
    if (records.length === 0 || (!next && !hasMore && records.length < pageSize)) {
      paginationComplete = true;
      break;
    }
  }

  await db(`acquisition_runs?id=eq.${run.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      records_discovered: discovered,
      records_acquired: acquired,
      pages_processed: pagesProcessed,
      retrieval_failures: failures,
      pagination_complete: paginationComplete,
      evidence: { endpoint, max_pages: maxPages, page_size: pageSize, completed_at: now() }
    })
  });

  return {
    metrics: { pages_processed: pagesProcessed, records_discovered: discovered, records_acquired: acquired, retrieval_failures: failures },
    evidence: { acquisition_run_id: run.id, endpoint, pagination_complete: paginationComplete }
  };
}

async function handleRecordStore(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=id`);
  return { metrics: { raw_records_stored: rows.length }, evidence: { acquisition_run_id: run.id, raw_record_ids: rows.map((row: JsonRecord) => row.id) } };
}

async function handleRunClose(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=id`);
  await db(`acquisition_runs?id=eq.${run.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'PARTIALLY_COMPLETE', records_acquired: rows.length, completed_at: now() })
  });
  return { metrics: { acquisition_records_closed: rows.length }, evidence: { acquisition_run_id: run.id, acquisition_phase_complete: true } };
}

async function handleNormalization(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&processing_status=eq.RAW&select=*`);
  for (const row of rows) {
    const normalized = buildNormalized(row.raw_payload, ctx.assignment);
    await db(`acquisition_raw_records?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ raw_payload: { ...asRecord(row.raw_payload), __aadp_normalized: normalized }, processing_status: 'NORMALIZED' })
    });
  }
  return { metrics: { records_normalized: rows.length }, evidence: { acquisition_run_id: run.id, normalization_version: 'AADP-NORMALIZATION-V1' } };
}

async function handleDeduplication(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=*&order=retrieval_timestamp.desc`);
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.publisher_id}|${row.source_record_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    duplicates += 1;
    await db(`acquisition_raw_records?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ processing_status: 'DUPLICATE' }) });
    await db('acquisition_record_dispositions', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        acquisition_run_id: run.id,
        raw_record_id: row.id,
        disposition: 'DUPLICATE',
        reason_code: 'DUPLICATE_RECORD',
        evidence: { identity: key, deduplication_version: 'AADP-DEDUP-V1' }
      })
    });
  }
  return { metrics: { duplicate_records: duplicates, unique_records: seen.size }, evidence: { acquisition_run_id: run.id, identity: 'publisher_id|source_record_id' } };
}

async function handleQualification(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&processing_status=eq.NORMALIZED&select=*`);
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const normalized = getNormalized(row.raw_payload);
    const requirements = normalized.requirements && Object.keys(asRecord(normalized.requirements)).length
      ? canonicalJson(normalized.requirements)
      : '';
    const contact = [text(normalized.contact_name), text(normalized.contact_email), text(normalized.contact_phone)].filter(Boolean).join(' | ');
    const responsibleEntity = text(normalized.issuing_organization);
    const result = await db('rpc/aadp_qualify_raw_record', {
      method: 'POST',
      body: JSON.stringify({
        p_raw_record_id: row.id,
        p_requirements: requirements,
        p_contact: contact,
        p_responsible_entity: responsibleEntity,
        p_lifecycle_status: text(normalized.status) || 'OPEN'
      })
    });
    const disposition = text(Array.isArray(result) ? result[0] : result) || 'PROCESSING_ERROR';
    totals[disposition] = (totals[disposition] ?? 0) + 1;
  }
  return { metrics: { records_qualified_checked: rows.length, qualified: totals.QUALIFIED ?? 0, rejected_incomplete: totals.REJECTED_INCOMPLETE ?? 0 }, evidence: { acquisition_run_id: run.id, disposition_totals: totals } };
}

async function upsertQualifiedRecord(raw: JsonRecord, assignment: JsonRecord, publisherRow: JsonRecord): Promise<string> {
  const normalized = getNormalized(raw.raw_payload);
  const sourcePlatform = text(assignment.publisher_name);
  const sourceRecordId = text(raw.source_record_id);
  const existing = await db(`state_contract_opportunities?source_platform=eq.${encodeURIComponent(sourcePlatform)}&source_record_id=eq.${encodeURIComponent(sourceRecordId)}&select=id&limit=1`);
  const payload = {
    source_platform: sourcePlatform,
    source_record_id: sourceRecordId,
    source_url: text(normalized.source_url) || text(raw.source_url),
    official_source_url: text(normalized.official_source_url) || text(normalized.source_url) || text(raw.source_url),
    solicitation_number: text(normalized.solicitation_number) || sourceRecordId,
    title: text(normalized.title),
    description: text(normalized.description) || null,
    procurement_type: text(normalized.procurement_type) || null,
    status: text(normalized.status) || 'open',
    posted_at: normalized.posted_at || null,
    response_deadline: normalized.response_deadline || null,
    issuing_organization: text(normalized.issuing_organization) || text(assignment.publisher_name),
    issuing_department: text(normalized.issuing_department) || null,
    state_code: text(normalized.state_code) || text(publisherRow.state_code) || 'US',
    place_of_performance_county: text(normalized.place_of_performance_county) || null,
    place_of_performance_city: text(normalized.place_of_performance_city) || null,
    contact_name: text(normalized.contact_name) || null,
    contact_email: text(normalized.contact_email) || null,
    contact_phone: text(normalized.contact_phone) || null,
    requirements: normalized.requirements ?? {},
    document_urls: normalized.document_urls ?? [],
    content_fingerprint: raw.content_fingerprint,
    is_latest_version: true,
    qa_status: 'unverified',
    raw_source_payload: raw.raw_payload,
    updated_at: now()
  };
  if (existing.length) {
    await db(`state_contract_opportunities?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    return existing[0].id;
  }
  const created = await db('state_contract_opportunities', { method: 'POST', body: JSON.stringify(payload) });
  return created[0].id;
}

async function handleQualifiedUpsert(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const publisherRow = await publisher(ctx.assignment);
  const dispositions = await db(`acquisition_record_dispositions?acquisition_run_id=eq.${run.id}&disposition=eq.QUALIFIED&select=*`);
  let insertedOrUpdated = 0;
  for (const disposition of dispositions) {
    const rows = await db(`acquisition_raw_records?id=eq.${disposition.raw_record_id}&select=*`);
    if (!rows.length) continue;
    const qualifiedId = await upsertQualifiedRecord(rows[0], ctx.assignment, publisherRow);
    await db(`acquisition_record_dispositions?id=eq.${disposition.id}`, { method: 'PATCH', body: JSON.stringify({ qualified_record_id: qualifiedId }) });
    insertedOrUpdated += 1;
  }
  return { metrics: { qualified_records_upserted: insertedOrUpdated }, evidence: { acquisition_run_id: run.id, destination: 'public.state_contract_opportunities' } };
}

async function handleRejections(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const rows = await db(`acquisition_rejections?acquisition_run_id=eq.${run.id}&select=rejection_code`);
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.rejection_code] = (totals[row.rejection_code] ?? 0) + 1;
  return { metrics: { rejection_records: rows.length }, evidence: { acquisition_run_id: run.id, rejection_totals: totals } };
}

function procurementTerms(normalized: JsonRecord): string[] {
  const content = `${text(normalized.title)} ${text(normalized.description)} ${canonicalJson(normalized.requirements)}`.toLowerCase();
  const stop = new Set(['this','that','with','from','will','shall','have','into','their','there','where','which','contract','procurement','services']);
  const counts = new Map<string, number>();
  for (const token of content.match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (stop.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25).map(([term]) => term);
}

async function handleLanguageAnalysis(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const dispositions = await db(`acquisition_record_dispositions?acquisition_run_id=eq.${run.id}&disposition=eq.QUALIFIED&qualified_record_id=not.is.null&select=*`);
  let analyzed = 0;
  for (const disposition of dispositions) {
    const rawRows = await db(`acquisition_raw_records?id=eq.${disposition.raw_record_id}&select=*`);
    if (!rawRows.length) continue;
    const normalized = getNormalized(rawRows[0].raw_payload);
    const terms = procurementTerms(normalized);
    const existing = await db(`procurement_language_analysis?acquisition_run_id=eq.${run.id}&qualified_record_id=eq.${disposition.qualified_record_id}&select=id`);
    const payload = {
      acquisition_run_id: run.id,
      qualified_record_id: disposition.qualified_record_id,
      terms,
      requirement_concepts: normalizeArray(normalized.requirements),
      capability_concepts: terms.slice(0, 10),
      exclusions: [],
      confidence: terms.length >= 5 ? 0.8 : 0.5,
      evidence: { analysis_version: 'AADP-AOIE-LANGUAGE-V1', raw_record_id: disposition.raw_record_id }
    };
    if (existing.length) await db(`procurement_language_analysis?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await db('procurement_language_analysis', { method: 'POST', body: JSON.stringify(payload) });
    analyzed += 1;
  }
  return { metrics: { records_analyzed: analyzed }, evidence: { acquisition_run_id: run.id, analysis_version: 'AADP-AOIE-LANGUAGE-V1' } };
}

async function handleAoieReview(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const analyses = await db(`procurement_language_analysis?acquisition_run_id=eq.${run.id}&select=*`);
  const lowConfidence = analyses.filter((item: JsonRecord) => Number(item.confidence ?? 0) < 0.7).length;
  const existing = await db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=id`);
  const report = {
    result_indicator: lowConfidence > 0 ? 'NEEDS YOUR ATTENTION' : 'NO RECOMMENDATIONS AT THIS TIME',
    records_analyzed: analyses.length,
    low_confidence_analyses: lowConfidence,
    production_matching_changed: false
  };
  const payload = { acquisition_run_id: run.id, status: 'COMPLETED', records_analyzed: analyses.length, low_confidence_analyses: lowConfidence, report, started_at: now(), completed_at: now() };
  if (existing.length) await db(`aoie_batch_reviews?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  else await db('aoie_batch_reviews', { method: 'POST', body: JSON.stringify(payload) });
  return { metrics: { aoie_records_reviewed: analyses.length, low_confidence_analyses: lowConfidence }, evidence: { acquisition_run_id: run.id, ...report } };
}

async function handleRecommendationCreate(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const reviews = await db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=*`);
  const review = reviews[0];
  if (!review || Number(review.low_confidence_analyses ?? 0) === 0) {
    return { metrics: { recommendations_created: 0 }, evidence: { acquisition_run_id: run.id, result_indicator: 'NO RECOMMENDATIONS AT THIS TIME' } };
  }
  const existing = await db(`aoie_change_recommendations?batch_review_id=eq.${review.id}&recommendation_type=eq.MATCHING_RESEARCH_REVIEW&select=id`);
  if (!existing.length) {
    await db('aoie_change_recommendations', {
      method: 'POST',
      body: JSON.stringify({
        batch_review_id: review.id,
        recommendation_type: 'MATCHING_RESEARCH_REVIEW',
        state: 'RESEARCH_CANDIDATE',
        recommendation: { action: 'Review low-confidence procurement-language interpretations', production_change: false },
        research_evidence: { low_confidence_analyses: review.low_confidence_analyses, acquisition_run_id: run.id },
        production_applied: false
      })
    });
  }
  await recordEvent(ctx.runId, null, 'ACTION_NEEDED', 'AOIE recommendations require Project Owner review', {
    state: text((await publisher(ctx.assignment)).state_code),
    publisher: text(ctx.assignment.publisher_name),
    current_stage: ctx.taskType,
    reason: 'Low-confidence AOIE analyses require controlled review',
    recommended_action: 'Open AOIE Recommendations Report',
    resume_point: 'MATCHING_RECOMMENDATION_TEST',
    unrelated_publishers_may_continue: true
  });
  return { metrics: { recommendations_created: existing.length ? 0 : 1 }, evidence: { acquisition_run_id: run.id, result_indicator: 'NEEDS YOUR ATTENTION' } };
}

async function handleRecommendationTest(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const reviews = await db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=id`);
  if (!reviews.length) return { metrics: { recommendations_tested: 0 }, evidence: { acquisition_run_id: run.id, outcome: 'NO_RECOMMENDATIONS' } };
  const recommendations = await db(`aoie_change_recommendations?batch_review_id=eq.${reviews[0].id}&select=*`);
  for (const recommendation of recommendations) {
    await db(`aoie_change_recommendations?id=eq.${recommendation.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'TEST_CANDIDATE', test_result: { status: 'REQUIRES_CONTROLLED_COMPARISON', production_applied: false, tested_at: now() } })
    });
  }
  return { metrics: { recommendations_tested: recommendations.length }, evidence: { acquisition_run_id: run.id, production_matching_changed: false } };
}

async function handleReconciliation(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const result = await db('rpc/aadp_reconcile_run', { method: 'POST', body: JSON.stringify({ p_acquisition_run_id: run.id }) });
  const value = Array.isArray(result) ? result[0] : result;
  await db(`command_runs?id=eq.${ctx.runId}`, { method: 'PATCH', body: JSON.stringify({ reconciliation: value }) });
  return { metrics: { reconciliation_variance: Number(value?.variance ?? 0) }, evidence: { acquisition_run_id: run.id, reconciliation: value } };
}

async function handleExecutiveReport(ctx: TaskContext) {
  const run = await acquisitionRun(ctx.runId);
  const [raw, dispositions, rejections, analyses, reviews, recommendations, tasks, failures] = await Promise.all([
    db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&select=id`),
    db(`acquisition_record_dispositions?acquisition_run_id=eq.${run.id}&select=disposition`),
    db(`acquisition_rejections?acquisition_run_id=eq.${run.id}&select=rejection_code`),
    db(`procurement_language_analysis?acquisition_run_id=eq.${run.id}&select=id,confidence`),
    db(`aoie_batch_reviews?acquisition_run_id=eq.${run.id}&select=*`),
    db(`aoie_change_recommendations?batch_review_id=eq.${reviews?.[0]?.id ?? '00000000-0000-0000-0000-000000000000'}&select=*`).catch(() => []),
    db(`command_tasks?run_id=eq.${ctx.runId}&select=task_type,state,measurable_result`),
    db(`command_failures?run_id=eq.${ctx.runId}&select=*`)
  ]);
  const dispositionTotals: Record<string, number> = {};
  for (const row of dispositions) dispositionTotals[row.disposition] = (dispositionTotals[row.disposition] ?? 0) + 1;
  const reconciliation = await db('rpc/aadp_reconcile_run', { method: 'POST', body: JSON.stringify({ p_acquisition_run_id: run.id }) });
  const report = {
    command_run_id: ctx.runId,
    acquisition: { acquisition_run_id: run.id, records_retrieved: raw.length, pages_processed: run.pages_processed, retrieval_failures: run.retrieval_failures },
    processing: { dispositions: dispositionTotals, rejection_count: rejections.length },
    aoie: { analyses: analyses.length, review: reviews[0] ?? null, recommendations: recommendations.length, production_matching_changed: false },
    command_center: { tasks, failures: failures.length, action_needed: reviews[0]?.report?.result_indicator === 'NEEDS YOUR ATTENTION' },
    reconciliation: Array.isArray(reconciliation) ? reconciliation[0] : reconciliation
  };
  const existing = await db(`executive_run_reports?command_run_id=eq.${ctx.runId}&select=id`);
  const payload = { ...report, final_status: failures.length ? 'PARTIALLY_COMPLETE' : 'COMPLETED' };
  if (existing.length) await db(`executive_run_reports?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  else await db('executive_run_reports', { method: 'POST', body: JSON.stringify(payload) });
  await db(`acquisition_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: failures.length ? 'PARTIALLY_COMPLETE' : 'COMPLETED', completed_at: now() }) });
  return { metrics: { executive_reports_created: existing.length ? 0 : 1, final_records_reconciled: raw.length }, evidence: report };
}

async function dispatch(ctx: TaskContext) {
  switch (ctx.taskType) {
    case 'PUBLISHER_ASSIGNMENT_CREATE': return await handleAssignment(ctx);
    case 'ACQUISITION_RUN_START': return await handleRunStart(ctx);
    case 'ACQUISITION_PAGE_FETCH': return await handlePageFetch(ctx);
    case 'ACQUISITION_RECORD_STORE': return await handleRecordStore(ctx);
    case 'ACQUISITION_RUN_CLOSE': return await handleRunClose(ctx);
    case 'RECORD_NORMALIZATION': return await handleNormalization(ctx);
    case 'RECORD_DEDUPLICATION': return await handleDeduplication(ctx);
    case 'RECORD_QUALIFICATION': return await handleQualification(ctx);
    case 'QUALIFIED_RECORD_UPSERT': return await handleQualifiedUpsert(ctx);
    case 'REJECTION_RECORD_CREATE': return await handleRejections(ctx);
    case 'PROCUREMENT_LANGUAGE_ANALYSIS': return await handleLanguageAnalysis(ctx);
    case 'AOIE_BATCH_REVIEW': return await handleAoieReview(ctx);
    case 'MATCHING_RECOMMENDATION_CREATE': return await handleRecommendationCreate(ctx);
    case 'MATCHING_RECOMMENDATION_TEST': return await handleRecommendationTest(ctx);
    case 'RUN_RECONCILIATION': return await handleReconciliation(ctx);
    case 'EXECUTIVE_REPORT_CREATE': return await handleExecutiveReport(ctx);
    default:
      throw new Error(`AADP task handler not implemented for ${ctx.taskType}`);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    const runId = text(body.run_id);
    const taskId = text(body.task_id);
    const taskType = text(body.task_type);
    const assignment = asRecord(body.assignment);
    if (!runId || !taskId || !taskType) return json({ error: 'run_id, task_id, and task_type are required' }, 400);
    validateAssignment(assignment as any);
    const result = await dispatch({ runId, taskId, taskType, assignment });
    return json({ success: true, task_type: taskType, ...result });
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
