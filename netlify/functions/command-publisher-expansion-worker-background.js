import { response, parseBody, requireDashboardAuth, db, env, header } from './_shared/native-runtime.js';
import { PUBLISHER_DISCOVERY_ENTITY_CLASSES, PUBLISHER_DISCOVERY_TAXONOMY_VERSION, normalizeDiscoveryClassification } from './_shared/publisher-discovery-taxonomy.js';
import { buildPublisherExpansionPlan } from './_shared/publisher-expansion-engine.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const arr = value => Array.isArray(value) ? value : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const supportedMethods = new Set(['API', 'PUBLIC_SEARCH', 'PUBLIC_PORTAL', 'DOCUMENT_FEED']);
const supportedStateCodes = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
  'AS','GU','MP','PR','VI'
]);
const terminalChildStatuses = new Set(['completed', 'cancelled']);

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of arr(data?.output)) {
    for (const part of arr(item?.content)) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
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

function fatalProviderFailure(status, message) {
  const normalized = txt(message).toLowerCase();
  return status === 401
    || status === 403
    || (status === 429 && /no credits remaining|insufficient_quota|billing|credit balance|quota exceeded/.test(normalized));
}

function chainAuthorized(event) {
  const supplied = txt(header(event, 'x-publisher-chain-token'));
  const expected = txt(env('PUBLISHER_CHAIN_TOKEN'));
  return Boolean(supplied && expected && supplied === expected);
}

async function patchRun(id, values) {
  await db(`command_runs?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...values, last_activity_at: now(), updated_at: now() })
  });
}

async function getParentRun(commandRunId) {
  return (await db(`command_runs?id=eq.${commandRunId}&select=*&limit=1`))?.[0] || null;
}

async function getOrCreateDiscoveryRun({ commandRunId, stateCode, discoveryScope }) {
  const existing = await db(`publisher_discovery_runs?command_run_id=eq.${commandRunId}&status=in.(CREATED,AUTHORIZED,QUEUED,RUNNING,PAUSED,PARTIALLY_COMPLETE)&select=*&order=created_at.asc&limit=1`).catch(() => []);
  if (existing?.[0]) return existing[0];
  return (await db('publisher_discovery_runs', {
    method: 'POST',
    body: JSON.stringify({
      command_run_id: commandRunId,
      state_code: stateCode,
      mission_name: `${stateCode} — Checkpointed Entity-Class Publisher Discovery`,
      discovery_scope: discoveryScope,
      organization_types: [...PUBLISHER_DISCOVERY_ENTITY_CLASSES],
      intelligence_provider: 'OPENAI_WEB_SEARCH',
      operator_name: 'Executive Command Center',
      governance: {
        taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
        execution_model: 'ONE_ENTITY_CLASS_PER_BACKGROUND_INVOCATION',
        entity_class_task_count: PUBLISHER_DISCOVERY_ENTITY_CLASSES.length,
        task_trigger_rule: 'TERMINAL_UNIT_DISPATCHES_NEXT',
        checkpoint_after_each_unit: true,
        resume_from_first_unfinished_unit: true,
        objective_validation_auto_admission: true,
        isolate_incomplete_candidates: true,
        idempotent_candidate_staging: true,
        separate_acquisition_task: true,
        provider_retry_attempts: 2,
        provider_fatal_error_policy: 'STOP_AFTER_FIRST_AUTH_OR_BILLING_FAILURE'
      },
      status: 'RUNNING',
      current_stage: 'CHECKPOINT_INITIALIZATION',
      started_at: now(),
      evidence: {
        source: 'EXECUTIVE_COMMAND_CENTER',
        runtime: 'NETLIFY_NATIVE',
        engine: 'CHECKPOINTED_ENTITY_CLASS_ORCHESTRATOR'
      }
    })
  }))?.[0] || null;
}

async function getChildRuns(parentRunId) {
  return await db(`command_runs?parent_run_id=eq.${parentRunId}&mission_type_key=eq.PUBLISHER_DISCOVERY_CLASS&select=*&order=created_at.asc`).catch(() => []);
}

function unitKeyFromChild(row) {
  return txt(row?.execution_evidence?.strategyKey || row?.execution_evidence?.unit_key || row?.execution_evidence?.entity_class_key || row?.execution_evidence?.entity_class?.key)
    || txt(row?.idempotency_key).match(/ENTITY_CLASS_\d{2}/)?.[0]
    || null;
}

function firstUnfinishedIndex(plan, childRuns) {
  const byKey = new Map();
  for (const row of arr(childRuns)) {
    const key = unitKeyFromChild(row);
    if (key) byKey.set(key, row);
  }
  for (let index = 0; index < plan.length; index++) {
    const row = byKey.get(plan[index].key);
    if (!row || !terminalChildStatuses.has(txt(row.status).toLowerCase())) return index;
  }
  return plan.length;
}

async function createOrClaimChildRun({ parentRunId, stateCode, unit, discoveryScope }) {
  const idempotencyKey = `publisher-class:${parentRunId}:${unit.key}`;
  const existing = (await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*&limit=1`).catch(() => []))?.[0] || null;
  if (existing) {
    if (terminalChildStatuses.has(txt(existing.status).toLowerCase())) return { row: existing, alreadyTerminal: true };
    const last = Date.parse(existing.last_activity_at || existing.started_at || 0);
    const fresh = Number.isFinite(last) && Date.now() - last < 13 * 60 * 1000;
    if (txt(existing.status).toLowerCase() === 'running' && fresh) return { row: existing, busy: true };
    await patchRun(existing.id, {
      status: 'running', aadp_state: 'RUNNING', current_stage: 'ENTITY_CLASS_RESEARCH',
      progress_value: 5, completed_at: null, action_required: false,
      result_summary: `Resuming ${unit.entityClass} in ${stateCode}.`,
      execution_evidence: {
        ...(existing.execution_evidence || {}),
        strategyKey: unit.key,
        sequence: unit.sequence,
        entityClass: unit.entityClass,
        discovery_scope: discoveryScope,
        checkpoint_model: 'ONE_UNIT_PER_INVOCATION'
      }
    });
    return { row: { ...existing, status: 'running' }, resumed: true };
  }
  const created = await db('command_runs', {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      status: 'running', aadp_state: 'RUNNING', mission_type_key: 'PUBLISHER_DISCOVERY_CLASS',
      mission_name: `${stateCode} — ${unit.entityClass}`, state_code: stateCode,
      assigned_agent: 'Publisher Expansion', parent_run_id: parentRunId,
      current_stage: 'ENTITY_CLASS_RESEARCH', started_at: now(), last_activity_at: now(),
      progress_mode: 'STAGE', progress_value: 5,
      result_summary: `Searching ${unit.entityClass} in ${stateCode}.`,
      execution_evidence: {
        strategyKey: unit.key, sequence: unit.sequence, entityClass: unit.entityClass,
        discovery_scope: discoveryScope, checkpoint_model: 'ONE_UNIT_PER_INVOCATION'
      }
    })
  });
  return { row: created?.[0] || null };
}

async function researchUnit({ apiKey, model, unit }) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const providerResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          reasoning: { effort: 'low' },
          tools: [{ type: 'web_search', search_context_size: 'high' }],
          input: unit.prompt
        }),
        signal: AbortSignal.timeout(120000)
      });
      const providerData = await providerResponse.json().catch(() => ({}));
      if (!providerResponse.ok) {
        const providerMessage = providerData?.error?.message || 'unknown provider error';
        const providerError = new Error(`${unit.key} failed (${providerResponse.status}): ${providerMessage}`);
        Object.assign(providerError, {
          attempts: attempt,
          providerStatus: providerResponse.status,
          fatalProvider: fatalProviderFailure(providerResponse.status, providerMessage)
        });
        throw providerError;
      }
      const candidates = arr(parseJson(outputText(providerData))?.candidates)
        .filter(candidate => txt(candidate?.publisher_name))
        .map(candidate => ({
          ...candidate,
          discovery_strategies: [unit.key],
          discovery_entity_classes: [unit.entityClass]
        }));
      return { candidates, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (error?.fatalProvider === true) throw error;
      if (attempt < 2) await sleep(1500);
    }
  }
  throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), { attempts: 2 });
}

async function stageCandidate(values) {
  try {
    return {
      row: (await db('publisher_discovery_candidates', { method: 'POST', body: JSON.stringify(values) }))?.[0] || null,
      duplicate: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate key value|unique constraint|publisher_discovery_candidate_run_name_unique_idx/i.test(message)) throw error;
    const existing = await db(`publisher_discovery_candidates?discovery_run_id=eq.${values.discovery_run_id}&publisher_name=eq.${encodeURIComponent(values.publisher_name)}&select=*&limit=1`).catch(() => []);
    const row = existing?.[0] || null;
    if (!row?.id) return { row: null, duplicate: true };
    const patch = {
      ...values,
      official_sources: [...new Set([...arr(row.official_sources), ...arr(values.official_sources)].map(txt).filter(Boolean))],
      official_source_verified: row.official_source_verified === true || values.official_source_verified === true,
      review_notes: [txt(row.review_notes), txt(values.review_notes), 'Duplicate candidate evidence merged during checkpoint replay.'].filter(Boolean).join(' '),
      updated_at: now()
    };
    await db(`publisher_discovery_candidates?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    return { row: { ...row, ...patch }, duplicate: true };
  }
}

function buildConnectionConfig(candidate, endpoint, sources) {
  const method = txt(candidate.acquisition_method).toUpperCase();
  return {
    configuration_version: 'PUBLISHER-CONNECTION-V3',
    access_method: method,
    primary_endpoint: endpoint,
    procurement_platform: txt(candidate.procurement_platform) || null,
    technology_vendor: txt(candidate.technology_vendor) || null,
    vendor_registration_url: txt(candidate.vendor_registration_url) || null,
    registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
    authentication_required: candidate.authentication_required === true,
    public_access_verified: candidate.official_source_verified === true,
    official_sources: sources,
    discovery_entity_classes: arr(candidate.discovery_entity_classes)
  };
}

async function upsertPublisher(candidate, stateCode, sourceVerified, endpoint, sources) {
  const name = txt(candidate.publisher_name);
  const classification = normalizeDiscoveryClassification(candidate);
  const connectionConfig = buildConnectionConfig(candidate, endpoint, sources);
  const existing = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(name)}&state_code=eq.${stateCode}&select=*`);
  const values = {
    publisher_name: name, state_code: stateCode,
    county_name: classification.county_name || null, county_fips: classification.county_fips || null,
    organization_type: txt(candidate.organization_type) || null,
    official_website: txt(candidate.official_website) || null,
    procurement_website: txt(candidate.procurement_website) || null,
    acquisition_method: connectionConfig.access_method,
    search_endpoint: endpoint,
    vendor_registration_url: connectionConfig.vendor_registration_url,
    verified: sourceVerified, access_status: 'READY', last_verified_at: now(), updated_at: now(),
    access_class: classification.access_class || 'UNKNOWN',
    machine_to_machine_supported: classification.machine_to_machine_supported,
    connector_strategy: classification.connector_strategy || 'ENGINEERING_REVIEW_REQUIRED',
    engineering_complexity: classification.engineering_complexity || 'UNKNOWN',
    reuse_score: classification.reuse_score,
    connector_roi_score: classification.connector_roi_score,
    configuration: { ...connectionConfig, ...classification, admission_mode: 'AUTOMATED_OBJECTIVE_VALIDATION' }
  };
  if (existing?.[0]?.id) {
    await db(`publisher_registry?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(values) });
    return { ...existing[0], ...values };
  }
  return (await db('publisher_registry', { method: 'POST', body: JSON.stringify(values) }))?.[0];
}

async function upsertAssignment(publisher, candidate, endpoint, sources) {
  const classification = normalizeDiscoveryClassification(candidate);
  const connectionConfig = buildConnectionConfig(candidate, endpoint, sources);
  const existing = await db(`publisher_assignments?publisher_id=eq.${publisher.id}&select=*&order=updated_at.desc`);
  const values = {
    publisher_id: publisher.id, publisher_name: publisher.publisher_name,
    acquisition_method: connectionConfig.access_method, search_endpoint: endpoint,
    search_parameters: {
      state_code: publisher.state_code, county_name: classification.county_name || null,
      source: 'PUBLISHER_DISCOVERY_REPORT', connection_config: connectionConfig, ...classification
    },
    authorized_status_range: ['OPEN', 'POSTED', 'ACTIVE'],
    pagination_instructions: { follow_next_page: true, stop_when_no_new_opportunities: true },
    attachment_instructions: { follow_solicitation_documents: true, extract_requirements_from_documents: true, preserve_document_urls: true },
    amendment_instructions: { capture_addenda: true, link_to_parent_solicitation: true },
    expected_source_identifiers: ['solicitation_number', 'notice_id', 'project_id', 'bid_number'],
    raw_destination: 'acquisition_raw_records', qualification_ruleset_version: 'AADP-QUALIFICATION-V2',
    aoie_review_required: true, retry_policy: { max_attempts: 3 }, runtime_limit_seconds: 3600,
    reporting_requirements: { preserve_provenance: true, report_rejections: true, report_connection_method_used: true },
    status: 'READY', updated_at: now()
  };
  if (existing?.[0]?.id) {
    await db(`publisher_assignments?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(values) });
    return { ...existing[0], ...values };
  }
  return (await db('publisher_assignments', { method: 'POST', body: JSON.stringify(values) }))?.[0];
}

async function processCandidate({ candidate, discoveryRunId, stateCode, unit }) {
  const name = txt(candidate.publisher_name);
  const sources = arr(candidate.official_sources).map(txt).filter(Boolean);
  const sourceVerified = candidate.official_source_verified === true && sources.length > 0;
  const method = txt(candidate.acquisition_method).toUpperCase();
  const endpoint = txt(candidate.search_endpoint || candidate.procurement_website || candidate.official_website) || null;
  const classification = normalizeDiscoveryClassification({ ...candidate, discovery_strategies: [unit.key] });
  const eligible = sourceVerified && supportedMethods.has(method) && Boolean(endpoint);
  const existing = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(name)}&state_code=eq.${stateCode}&select=id`);
  const duplicateId = existing?.[0]?.id || null;
  const stagedCandidate = await stageCandidate({
    discovery_run_id: discoveryRunId, publisher_name: name, state_code: stateCode,
    county_name: classification.county_name || null, county_fips: classification.county_fips || null,
    organization_type: txt(candidate.organization_type) || unit.entityClass,
    official_website: txt(candidate.official_website) || null,
    procurement_website: txt(candidate.procurement_website) || null,
    acquisition_method: method || 'UNASSESSED', search_endpoint: txt(candidate.search_endpoint) || null,
    vendor_registration_url: txt(candidate.vendor_registration_url) || null,
    procurement_platform: txt(candidate.procurement_platform) || null,
    technology_vendor: txt(candidate.technology_vendor) || null,
    registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
    access_class: classification.access_class || 'UNKNOWN',
    machine_to_machine_supported: classification.machine_to_machine_supported,
    connector_strategy: classification.connector_strategy || 'ENGINEERING_REVIEW_REQUIRED',
    engineering_complexity: classification.engineering_complexity || 'UNKNOWN',
    reuse_score: classification.reuse_score, connector_roi_score: classification.connector_roi_score,
    official_sources: sources, official_source_verified: sourceVerified,
    duplicate_publisher_id: duplicateId, duplicate_status: duplicateId ? 'EXISTING_REGISTRY_MATCH' : 'NO_MATCH',
    review_status: eligible ? 'AUTO_APPROVED' : 'EXCEPTION_REVIEW',
    review_notes: eligible ? `Validated by ${unit.key}: ${unit.entityClass}.` : `Unit ${unit.key} requires exception review.`,
    reviewed_at: now()
  });
  if (!eligible) return { staged: 1, ready: 0, exception: 1, duplicateRegistry: duplicateId ? 1 : 0, duplicateCandidate: stagedCandidate.duplicate ? 1 : 0 };
  const publisher = await upsertPublisher({ ...candidate, organization_type: txt(candidate.organization_type) || unit.entityClass }, stateCode, sourceVerified, endpoint, sources);
  if (!publisher?.id) return { staged: 1, ready: 0, exception: 1, duplicateRegistry: duplicateId ? 1 : 0, duplicateCandidate: stagedCandidate.duplicate ? 1 : 0 };
  const assignment = await upsertAssignment(publisher, candidate, endpoint, sources);
  if (!assignment?.id) return { staged: 1, ready: 0, exception: 1, duplicateRegistry: duplicateId ? 1 : 0, duplicateCandidate: stagedCandidate.duplicate ? 1 : 0 };
  if (stagedCandidate.row?.id) {
    await db(`publisher_discovery_candidates?id=eq.${stagedCandidate.row.id}`, {
      method: 'PATCH', body: JSON.stringify({ admitted_publisher_id: publisher.id, updated_at: now() })
    });
  }
  return { staged: 1, ready: 1, exception: 0, duplicateRegistry: duplicateId ? 1 : 0, duplicateCandidate: stagedCandidate.duplicate ? 1 : 0 };
}

async function summarize(discoveryRunId, parentRunId) {
  const candidates = await db(`publisher_discovery_candidates?discovery_run_id=eq.${discoveryRunId}&select=id,official_source_verified,review_status,admitted_publisher_id`).catch(() => []);
  const children = await getChildRuns(parentRunId);
  const unitResults = children.map(row => row.execution_evidence || {}).filter(item => item.strategyKey);
  return {
    candidates,
    children,
    unitResults,
    staged: candidates.length,
    ready: candidates.filter(row => row.admitted_publisher_id).length,
    exceptions: candidates.filter(row => row.review_status === 'EXCEPTION_REVIEW').length,
    officialSources: candidates.filter(row => row.official_source_verified === true).length,
    failedUnits: children.filter(row => txt(row.status).toLowerCase() === 'failed').length,
    warningUnits: children.filter(row => Number(row.warning_count || 0) > 0).length,
    noResultUnits: children.filter(row => txt(row.current_stage) === 'COMPLETED_NO_RESULTS').length
  };
}

async function dispatchNext({ event, payload }) {
  const host = header(event, 'host');
  const chainToken = txt(env('PUBLISHER_CHAIN_TOKEN'));
  if (!host || !chainToken) throw new Error('Publisher chain dispatch configuration is incomplete.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://${host}/.netlify/functions/command-publisher-expansion-worker-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-publisher-chain-token': chainToken },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok && res.status !== 202) throw new Error(`Next unit dispatch failed (${res.status}): ${await res.text()}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function finalizeMission({ commandRunId, discoveryRunId, stateCode, plan }) {
  const summary = await summarize(discoveryRunId, commandRunId);
  const evidence = {
    runtime: 'NETLIFY_NATIVE', engine: 'CHECKPOINTED_ENTITY_CLASS_ORCHESTRATOR',
    taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
    unit_results: summary.unitResults,
    candidates_staged: summary.staged, assignments_ready: summary.ready,
    exceptions_isolated: summary.exceptions, separate_acquisition_task: true,
    handoff_artifact: 'publisher_assignments.search_parameters.connection_config'
  };
  await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'COMPLETED', current_stage: 'ALL_ENTITY_CLASS_TASKS_TERMINAL',
      official_sources_identified: summary.officialSources,
      publishers_presented: summary.staged, publishers_approved: summary.ready,
      completed_at: now(), updated_at: now(), evidence
    })
  });
  await patchRun(commandRunId, {
    status: 'completed', aadp_state: summary.failedUnits || summary.warningUnits ? 'PARTIALLY_COMPLETE' : 'COMPLETED',
    current_stage: 'ALL_ENTITY_CLASS_TASKS_TERMINAL', progress_value: 100,
    records_discovered: summary.staged, records_acquired: summary.staged,
    records_accepted: summary.ready, records_rejected: summary.exceptions,
    warning_count: summary.failedUnits + summary.warningUnits, failure_count: 0,
    action_required: summary.failedUnits > 0 || summary.warningUnits > 0,
    completed_at: now(),
    result_summary: `${plan.length} entity-class checkpoints reached terminal status for ${stateCode}: ${summary.ready} READY assignments, ${summary.failedUnits} failed tasks, ${summary.noResultUnits} zero-result tasks.`,
    execution_evidence: evidence
  });
}

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event) && !chainAuthorized(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = txt(body.command_run_id);
  const stateCode = txt(body.state_code).toUpperCase();
  const discoveryScope = txt(body.discovery_scope || 'STATE_AND_LOCAL').toUpperCase();
  const requestedIndex = Number.isInteger(body.unit_index) ? body.unit_index : Number(body.unit_index);
  if (!commandRunId || !supportedStateCodes.has(stateCode)) {
    return response(400, { error: 'command_run_id and a supported U.S. state or territory code are required' });
  }

  let discoveryRunId = txt(body.discovery_run_id) || null;
  try {
    const parent = await getParentRun(commandRunId);
    if (!parent) return response(404, { error: 'Command run not found.' });
    if (['completed', 'cancelled'].includes(txt(parent.status).toLowerCase())) return response(200, { ok: true, terminal: true, command_run_id: commandRunId });

    const plan = buildPublisherExpansionPlan({ stateCode, discoveryScope });
    let discoveryRun = discoveryRunId
      ? (await db(`publisher_discovery_runs?id=eq.${discoveryRunId}&command_run_id=eq.${commandRunId}&select=*&limit=1`))?.[0]
      : null;
    if (!discoveryRun) discoveryRun = await getOrCreateDiscoveryRun({ commandRunId, stateCode, discoveryScope });
    discoveryRunId = discoveryRun?.id || null;
    if (!discoveryRunId) throw new Error('Publisher discovery run initialization failed.');

    const childRuns = await getChildRuns(commandRunId);
    const nextIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0
      ? requestedIndex
      : firstUnfinishedIndex(plan, childRuns);

    if (nextIndex >= plan.length) {
      await finalizeMission({ commandRunId, discoveryRunId, stateCode, plan });
      return response(200, { ok: true, completed: true, command_run_id: commandRunId, discovery_run_id: discoveryRunId });
    }

    const unit = plan[nextIndex];
    const claim = await createOrClaimChildRun({ parentRunId: commandRunId, stateCode, unit, discoveryScope });
    if (claim.alreadyTerminal) {
      await dispatchNext({ event, payload: { command_run_id: commandRunId, discovery_run_id: discoveryRunId, state_code: stateCode, discovery_scope: discoveryScope, unit_index: nextIndex + 1 } });
      return response(202, { ok: true, skipped_terminal_unit: unit.key });
    }
    if (claim.busy) return response(202, { ok: true, already_running: unit.key });
    const childRunId = claim.row?.id;
    if (!childRunId) throw new Error(`Unable to claim ${unit.key}.`);

    const progress = Math.max(2, Math.round((nextIndex / plan.length) * 94));
    await patchRun(commandRunId, {
      status: 'running', aadp_state: 'RUNNING', current_stage: `${unit.key}_RUNNING`, progress_value: progress,
      records_discovered: Number(parent.records_discovered || 0),
      records_acquired: Number(parent.records_acquired || 0),
      records_accepted: Number(parent.records_accepted || 0),
      result_summary: `Checkpoint ${unit.sequence} of ${plan.length}: ${unit.entityClass}.`
    });
    await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'RUNNING', current_stage: unit.key, completed_at: null, updated_at: now(), evidence: { ...(discoveryRun.evidence || {}), latest_unit: unit, checkpointed: true } })
    });

    const apiKey = env('OPENAI_API_KEY');
    if (!apiKey) throw new Error('Autonomous publisher research provider is not configured.');
    const model = env('OPENAI_DISCOVERY_MODEL') || 'gpt-5.6-terra';

    try {
      const research = await researchUnit({ apiKey, model, unit });
      let staged = 0, ready = 0, exceptions = 0, duplicateRegistry = 0, duplicateCandidates = 0;
      for (const candidate of research.candidates) {
        const result = await processCandidate({ candidate, discoveryRunId, stateCode, unit });
        staged += result.staged; ready += result.ready; exceptions += result.exception;
        duplicateRegistry += result.duplicateRegistry; duplicateCandidates += result.duplicateCandidate;
      }
      const unitStatus = research.candidates.length === 0 ? 'COMPLETED_NO_RESULTS' : exceptions > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
      const result = {
        strategyKey: unit.key, sequence: unit.sequence, entityClass: unit.entityClass, status: unitStatus,
        candidatesFound: research.candidates.length, candidatesVerified: staged - exceptions,
        assignmentsReady: ready, attempts: research.attempts, childRunId,
        duplicateRegistryMatches: duplicateRegistry, duplicateCandidateRows: duplicateCandidates
      };
      await patchRun(childRunId, {
        status: 'completed', aadp_state: exceptions ? 'PARTIALLY_COMPLETE' : 'COMPLETED', current_stage: unitStatus,
        progress_value: 100, completed_at: now(), records_discovered: research.candidates.length,
        records_acquired: staged, records_accepted: ready, records_rejected: exceptions,
        warning_count: exceptions, failure_count: 0, action_required: exceptions > 0,
        result_summary: `${unit.entityClass}: ${research.candidates.length} candidates, ${ready} READY assignments, ${exceptions} exceptions.`,
        execution_evidence: result
      });
      const summary = await summarize(discoveryRunId, commandRunId);
      await patchRun(commandRunId, {
        records_discovered: summary.staged, records_acquired: summary.staged,
        records_accepted: summary.ready, records_rejected: summary.exceptions,
        progress_value: Math.max(progress, Math.round(((nextIndex + 1) / plan.length) * 94)),
        result_summary: `${unit.entityClass} complete. ${summary.ready} READY assignments preserved; dispatching checkpoint ${nextIndex + 2} of ${plan.length}.`
      });
      await dispatchNext({ event, payload: { command_run_id: commandRunId, discovery_run_id: discoveryRunId, state_code: stateCode, discovery_scope: discoveryScope, unit_index: nextIndex + 1 } });
      return response(202, { ok: true, completed_unit: unit.key, next_unit_index: nextIndex + 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatalProvider = error?.fatalProvider === true;
      const result = {
        strategyKey: unit.key, sequence: unit.sequence, entityClass: unit.entityClass,
        status: fatalProvider ? 'PROVIDER_BLOCKED' : 'PROVIDER_FAILED', attempts: Number(error?.attempts || 2),
        error: message, childRunId
      };
      await patchRun(childRunId, {
        status: 'failed', aadp_state: 'FAILED', current_stage: result.status,
        progress_value: 100, completed_at: now(), failure_count: 1, action_required: true,
        result_summary: fatalProvider
          ? `${unit.entityClass} stopped because provider authentication, quota, or billing is unavailable.`
          : `${unit.entityClass} failed after controlled retries. The next checkpoint will continue.`,
        execution_evidence: result
      });
      if (fatalProvider) {
        await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'PAUSED', current_stage: 'PROVIDER_BLOCKED', updated_at: now(), evidence: { ...(discoveryRun.evidence || {}), error: message, fatal_provider: true } })
        });
        await patchRun(commandRunId, {
          status: 'failed', aadp_state: 'FAILED', current_stage: 'PROVIDER_BLOCKED', action_required: true,
          failure_count: Number(parent.failure_count || 0) + 1, completed_at: now(), result_summary: message
        });
        return response(503, { error: message, fatal_provider: true });
      }
      await dispatchNext({ event, payload: { command_run_id: commandRunId, discovery_run_id: discoveryRunId, state_code: stateCode, discovery_scope: discoveryScope, unit_index: nextIndex + 1 } });
      return response(202, { ok: false, failed_unit: unit.key, next_unit_index: nextIndex + 1, error: message });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('command-publisher-expansion-worker-background failed', error);
    if (discoveryRunId) {
      await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'PAUSED', current_stage: 'ORCHESTRATION_PAUSED', updated_at: now(), evidence: { error: message, checkpointed: true } })
      }).catch(() => null);
    }
    await patchRun(commandRunId, {
      status: 'failed', aadp_state: 'FAILED', current_stage: 'ORCHESTRATION_PAUSED', action_required: true,
      failure_count: 1, completed_at: now(), result_summary: message
    }).catch(() => null);
    return response(500, { error: message, checkpointed: true });
  }
};
