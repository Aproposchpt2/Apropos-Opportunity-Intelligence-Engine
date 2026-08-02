import { response, parseBody, requireDashboardAuth, db, env, header } from './_shared/native-runtime.js';
import { PUBLISHER_DISCOVERY_ENTITY_CLASSES, PUBLISHER_DISCOVERY_TAXONOMY_VERSION, normalizeDiscoveryClassification } from './_shared/publisher-discovery-taxonomy.js';
import { buildPublisherExpansionPlan, mergePublisherCandidates, calculateCoverageSummary } from './_shared/publisher-expansion-engine.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const arr = value => Array.isArray(value) ? value : [];
const supportedMethods = new Set(['API', 'PUBLIC_SEARCH', 'PUBLIC_PORTAL', 'DOCUMENT_FEED']);

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of arr(data?.output)) for (const part of arr(item?.content)) if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
  return '';
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Publisher research returned invalid JSON.');
  }
}

async function patchRun(id, values) {
  await db(`command_runs?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...values, last_activity_at: now() }) });
}

async function researchWave({ apiKey, model, wave }) {
  const providerResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, reasoning: { effort: 'low' }, tools: [{ type: 'web_search', search_context_size: 'medium' }], input: wave.prompt }),
    signal: AbortSignal.timeout(120000)
  });
  const providerData = await providerResponse.json().catch(() => ({}));
  if (!providerResponse.ok) throw new Error(`${wave.key} failed (${providerResponse.status}): ${providerData?.error?.message || 'unknown provider error'}`);
  return arr(parseJson(outputText(providerData))?.candidates).filter(candidate => txt(candidate?.publisher_name));
}

async function stageCandidate(values) {
  try {
    const row = (await db('publisher_discovery_candidates', {
      method: 'POST',
      body: JSON.stringify(values)
    }))?.[0] || null;
    return { row, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate key value|unique constraint|publisher_discovery_candidate_run_name_unique_idx/i.test(message)) throw error;

    const existing = await db(
      `publisher_discovery_candidates?discovery_run_id=eq.${values.discovery_run_id}&publisher_name=eq.${encodeURIComponent(values.publisher_name)}&select=*&limit=1`
    ).catch(() => []);
    const row = existing?.[0] || null;

    if (row?.id) {
      const mergedSources = [...new Set([...arr(row.official_sources), ...arr(values.official_sources)].map(txt).filter(Boolean))];
      const patch = {
        ...values,
        official_sources: mergedSources,
        official_source_verified: row.official_source_verified === true || values.official_source_verified === true,
        duplicate_status: values.duplicate_status === 'EXISTING_REGISTRY_MATCH' ? values.duplicate_status : row.duplicate_status,
        review_notes: [txt(row.review_notes), txt(values.review_notes), 'Duplicate candidate evidence merged during idempotent staging.'].filter(Boolean).join(' '),
        updated_at: now()
      };
      await db(`publisher_discovery_candidates?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => null);
      return { row: { ...row, ...patch }, duplicate: true };
    }

    return { row: null, duplicate: true };
  }
}

async function upsertPublisher(candidate, stateCode, sourceVerified, endpoint, sources) {
  const name = txt(candidate.publisher_name);
  const classification = normalizeDiscoveryClassification(candidate);
  const existing = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(name)}&state_code=eq.${stateCode}&select=*`);
  const values = {
    publisher_name: name, state_code: stateCode, organization_type: txt(candidate.organization_type) || null,
    official_website: txt(candidate.official_website) || null, procurement_website: txt(candidate.procurement_website) || null,
    acquisition_method: txt(candidate.acquisition_method).toUpperCase(), search_endpoint: endpoint,
    vendor_registration_url: txt(candidate.vendor_registration_url) || null, verified: sourceVerified,
    access_status: 'READY', last_verified_at: now(), updated_at: now(),
    configuration: {
      procurement_platform: txt(candidate.procurement_platform) || null,
      technology_vendor: txt(candidate.technology_vendor) || null,
      registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
      official_sources: sources, ...classification, admission_mode: 'AUTOMATED_OBJECTIVE_VALIDATION'
    }
  };
  if (existing?.[0]?.id) {
    await db(`publisher_registry?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(values) });
    return { ...existing[0], ...values };
  }
  return (await db('publisher_registry', { method: 'POST', body: JSON.stringify(values) }))?.[0];
}

async function upsertAssignment(publisher, candidate, endpoint) {
  const classification = normalizeDiscoveryClassification(candidate);
  const existing = await db(`publisher_assignments?publisher_id=eq.${publisher.id}&select=*&order=updated_at.desc`);
  const values = {
    publisher_id: publisher.id, publisher_name: publisher.publisher_name,
    acquisition_method: txt(candidate.acquisition_method).toUpperCase(), search_endpoint: endpoint,
    search_parameters: { state_code: publisher.state_code, source: 'PUBLISHER_EXPANSION_ENGINE', ...classification },
    authorized_status_range: ['OPEN', 'POSTED', 'ACTIVE'], pagination_instructions: {}, attachment_instructions: {}, amendment_instructions: {}, expected_source_identifiers: [],
    raw_destination: 'acquisition_raw_records', qualification_ruleset_version: 'AADP-QUALIFICATION-V1', aoie_review_required: true,
    retry_policy: { max_attempts: 3 }, runtime_limit_seconds: 3600,
    reporting_requirements: { preserve_provenance: true, report_rejections: true, distinguish_opportunity_channel: true },
    status: 'READY', updated_at: now()
  };
  if (existing?.[0]?.id) {
    await db(`publisher_assignments?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(values) });
    return { ...existing[0], ...values };
  }
  return (await db('publisher_assignments', { method: 'POST', body: JSON.stringify(values) }))?.[0];
}

async function dispatchAcquisition(event, commandRunId, stateCode) {
  const host = header(event, 'host');
  const password = header(event, 'x-dashboard-password');
  if (!host) throw new Error('Netlify host context unavailable for acquisition handoff.');
  const res = await fetch(`https://${host}/.netlify/functions/command-acquisition-worker-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
    body: JSON.stringify({ command_run_id: commandRunId, state_code: stateCode, publisher_scope: 'ALL', publisher_id: null })
  });
  if (!res.ok && res.status !== 202) throw new Error(`Acquisition worker dispatch failed (${res.status}): ${await res.text()}`);
  return res.status;
}

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = txt(body.command_run_id);
  const stateCode = txt(body.state_code).toUpperCase();
  const discoveryScope = txt(body.discovery_scope || 'STATE_AND_LOCAL').toUpperCase();
  if (!commandRunId || !/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'command_run_id and state_code are required' });

  let discoveryRunId = null;
  try {
    await patchRun(commandRunId, { status: 'running', aadp_state: 'RUNNING', current_stage: 'PUBLISHER_EXPANSION_PLANNING', progress_value: 5, result_summary: 'Publisher Expansion Engine is preparing targeted official-source search waves.' });
    const plan = buildPublisherExpansionPlan({ stateCode, discoveryScope });
    const existingPublishers = await db(`publisher_registry?state_code=eq.${stateCode}&select=id,organization_type,publisher_name`);

    const discoveryRun = (await db('publisher_discovery_runs', { method: 'POST', body: JSON.stringify({
      command_run_id: commandRunId, state_code: stateCode, mission_name: `${stateCode} — Multi-Wave Publisher Expansion`, discovery_scope: discoveryScope,
      organization_types: [...PUBLISHER_DISCOVERY_ENTITY_CLASSES], intelligence_provider: 'OPENAI_WEB_SEARCH', operator_name: 'Executive Command Center',
      governance: { objective_validation_auto_admission: true, isolate_incomplete_candidates: true, preserve_contract_filters: true, taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION, search_wave_count: plan.length, idempotent_candidate_staging: true },
      status: 'RUNNING', current_stage: 'MULTI_WAVE_RESEARCH', started_at: now(),
      evidence: { source: 'EXECUTIVE_COMMAND_CENTER', runtime: 'NETLIFY_NATIVE', engine: 'PUBLISHER_EXPANSION_ENGINE', taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION }
    }) }))?.[0];
    discoveryRunId = discoveryRun?.id;
    if (!discoveryRunId) throw new Error('Publisher discovery run creation failed.');

    const apiKey = env('OPENAI_API_KEY');
    if (!apiKey) throw new Error('Autonomous publisher research provider is not configured.');
    const model = env('OPENAI_DISCOVERY_MODEL') || 'gpt-5.6-terra';
    const batches = [];
    const strategyResults = [];

    for (let index = 0; index < plan.length; index++) {
      const wave = plan[index];
      await patchRun(commandRunId, {
        current_stage: `PUBLISHER_SEARCH_${wave.key}`,
        progress_value: 10 + Math.round((index / plan.length) * 35),
        result_summary: `Search wave ${index + 1} of ${plan.length}: ${wave.label}.`
      });
      try {
        const candidates = await researchWave({ apiKey, model, wave });
        batches.push({ strategyKey: wave.key, candidates });
        strategyResults.push({ strategyKey: wave.key, status: 'COMPLETED', candidatesFound: candidates.length });
      } catch (error) {
        strategyResults.push({ strategyKey: wave.key, status: 'FAILED', candidatesFound: 0, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const candidates = mergePublisherCandidates(batches);
    if (!candidates.length) throw new Error(`All publisher search waves completed without usable candidates. ${strategyResults.filter(item => item.error).map(item => item.error).join(' | ')}`);
    const coverage = calculateCoverageSummary({ candidates, existingPublishers: arr(existingPublishers), strategyResults });
    await patchRun(commandRunId, { current_stage: 'PUBLISHER_VALIDATION', progress_value: 50, records_discovered: candidates.length, execution_evidence: { engine: 'PUBLISHER_EXPANSION_ENGINE', coverage } });

    let staged = 0, ready = 0, exceptions = 0, duplicates = 0, candidateDuplicates = 0;
    for (const candidate of candidates) {
      const name = txt(candidate.publisher_name);
      const sources = arr(candidate.official_sources).map(txt).filter(Boolean);
      const sourceVerified = candidate.official_source_verified === true && sources.length > 0;
      const method = txt(candidate.acquisition_method).toUpperCase();
      const endpoint = txt(candidate.search_endpoint || candidate.procurement_website || candidate.official_website) || null;
      const classification = normalizeDiscoveryClassification(candidate);
      const eligible = sourceVerified && supportedMethods.has(method) && Boolean(endpoint);
      const existing = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(name)}&state_code=eq.${stateCode}&select=id`);
      const duplicateId = existing?.[0]?.id || null;
      if (duplicateId) duplicates++;

      const stagedCandidate = await stageCandidate({
        discovery_run_id: discoveryRunId, publisher_name: name, state_code: stateCode, organization_type: txt(candidate.organization_type) || null,
        official_website: txt(candidate.official_website) || null, procurement_website: txt(candidate.procurement_website) || null,
        acquisition_method: method || 'UNASSESSED', search_endpoint: txt(candidate.search_endpoint) || null,
        vendor_registration_url: txt(candidate.vendor_registration_url) || null, procurement_platform: txt(candidate.procurement_platform) || null,
        technology_vendor: txt(candidate.technology_vendor) || null, registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
        official_sources: sources, official_source_verified: sourceVerified, duplicate_publisher_id: duplicateId,
        duplicate_status: duplicateId ? 'EXISTING_REGISTRY_MATCH' : 'NO_MATCH', review_status: eligible ? 'AUTO_APPROVED' : 'EXCEPTION_REVIEW',
        review_notes: eligible ? `Validated through ${classification.discovery_strategies.join(', ') || 'expanded discovery'}.` : 'Missing official verification, supported acquisition method, or usable endpoint.', reviewed_at: now()
      });
      const candidateRow = stagedCandidate.row;
      if (stagedCandidate.duplicate) candidateDuplicates++;
      staged++;

      if (!eligible) { exceptions++; continue; }
      const publisher = await upsertPublisher(candidate, stateCode, sourceVerified, endpoint, sources);
      if (!publisher?.id) { exceptions++; continue; }
      const assignment = await upsertAssignment(publisher, candidate, endpoint);
      if (!assignment?.id) { exceptions++; continue; }
      ready++;
      if (candidateRow?.id) await db(`publisher_discovery_candidates?id=eq.${candidateRow.id}`, { method: 'PATCH', body: JSON.stringify({ admitted_publisher_id: publisher.id, updated_at: now() }) });
    }

    const evidence = { runtime: 'NETLIFY_NATIVE', engine: 'PUBLISHER_EXPANSION_ENGINE', taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION, coverage, candidates_staged: staged, assignments_ready: ready, exceptions_isolated: exceptions, duplicate_registry_matches: duplicates, duplicate_candidate_rows_merged_or_skipped: candidateDuplicates, idempotent_candidate_staging: true };
    await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, { method: 'PATCH', body: JSON.stringify({
      status: ready ? 'COMPLETED' : 'PAUSED', current_stage: ready ? 'ACQUISITION_HANDOFF' : 'NO_READY_ASSIGNMENTS',
      official_sources_identified: candidates.filter(candidate => candidate.official_source_verified === true).length,
      publishers_presented: staged, completed_at: now(), updated_at: now(), evidence
    }) });

    if (!ready) {
      await patchRun(commandRunId, { status: 'interrupted', aadp_state: 'PAUSED', current_stage: 'NO_READY_ASSIGNMENTS', progress_value: 100, records_acquired: staged, records_accepted: 0, records_rejected: exceptions, action_required: true, completed_at: now(), result_summary: `${staged} candidates staged across ${coverage.strategy_completed} completed search waves; none passed acquisition admission. ${candidateDuplicates} duplicate candidate rows were safely merged or skipped.` });
      return response(200, { ok: true, command_run_id: commandRunId, discovery_run_id: discoveryRunId, candidates_staged: staged, assignments_ready: 0, duplicate_candidate_rows: candidateDuplicates, coverage, action_required: true });
    }

    await patchRun(commandRunId, { status: 'running', aadp_state: 'RUNNING', current_stage: 'ACQUISITION_QUEUED', progress_value: 70, records_acquired: staged, records_accepted: ready, records_rejected: exceptions, action_required: false, result_summary: `${ready} publishers are acquisition-ready after ${coverage.strategy_completed} targeted search waves. ${candidateDuplicates} duplicate candidate rows were safely merged or skipped. Contract acquisition is launching.`, execution_evidence: evidence });
    const dispatchStatus = await dispatchAcquisition(event, commandRunId, stateCode);
    return response(202, { ok: true, command_run_id: commandRunId, discovery_run_id: discoveryRunId, candidates_staged: staged, assignments_ready: ready, exceptions_isolated: exceptions, duplicate_candidate_rows: candidateDuplicates, acquisition_dispatch_status: dispatchStatus, coverage, autonomous_continuation: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('command-publisher-expansion-worker-background failed', error);
    if (discoveryRunId) await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, { method: 'PATCH', body: JSON.stringify({ status: 'FAILED', current_stage: 'ORCHESTRATION_FAILED', completed_at: now(), updated_at: now(), evidence: { error: message, engine: 'PUBLISHER_EXPANSION_ENGINE' } }) }).catch(() => null);
    await patchRun(commandRunId, { status: 'failed', aadp_state: 'FAILED', current_stage: 'ORCHESTRATION_FAILED', progress_value: 100, failure_count: 1, action_required: true, completed_at: now(), result_summary: message }).catch(() => null);
    return response(500, { error: message });
  }
};
