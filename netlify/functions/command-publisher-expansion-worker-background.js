import { response, parseBody, requireDashboardAuth, db, env } from './_shared/native-runtime.js';
import { PUBLISHER_DISCOVERY_ENTITY_CLASSES, PUBLISHER_DISCOVERY_TAXONOMY_VERSION, normalizeDiscoveryClassification } from './_shared/publisher-discovery-taxonomy.js';
import { buildPublisherExpansionPlan, mergePublisherCandidates, calculateCoverageSummary } from './_shared/publisher-expansion-engine.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const arr = value => Array.isArray(value) ? value : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const supportedMethods = new Set(['API', 'PUBLIC_SEARCH', 'PUBLIC_PORTAL', 'DOCUMENT_FEED']);
const supportedStateCodes = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
  'AS','GU','MP','PR','VI'
]);

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

async function patchRun(id, values) {
  await db(`command_runs?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...values, last_activity_at: now(), updated_at: now() })
  });
}

async function createChildRun({ parentRunId, stateCode, unit, discoveryScope }) {
  const idempotencyKey = `publisher-class:${parentRunId}:${unit.key}`;
  try {
    const created = await db('command_runs', {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        status: 'running',
        aadp_state: 'RUNNING',
        mission_type_key: 'PUBLISHER_DISCOVERY_CLASS',
        mission_name: `${stateCode} — ${unit.entityClass}`,
        state_code: stateCode,
        assigned_agent: 'Publisher Expansion',
        parent_run_id: parentRunId,
        current_stage: 'ENTITY_CLASS_RESEARCH',
        started_at: now(),
        last_activity_at: now(),
        progress_mode: 'STAGE',
        progress_value: 5,
        result_summary: `Searching ${unit.entityClass} in ${stateCode}.`,
        execution_evidence: {
          entity_class: unit.entityClass,
          sequence: unit.sequence,
          discovery_scope: discoveryScope,
          trigger_rule: 'ANY_TERMINAL_STATE_TRIGGERS_NEXT'
        }
      })
    });
    return created?.[0] || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate key|unique constraint/i.test(message)) throw error;
    const existing = await db(`command_runs?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*&limit=1`).catch(() => []);
    const row = existing?.[0] || null;
    if (row?.id) {
      await patchRun(row.id, {
        status: 'running', aadp_state: 'RUNNING', current_stage: 'ENTITY_CLASS_RESEARCH',
        progress_value: 5, started_at: row.started_at || now(), completed_at: null,
        result_summary: `Reprocessing ${unit.entityClass} in ${stateCode}.`
      });
    }
    return row;
  }
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
    if (row?.id) {
      const patch = {
        ...values,
        official_sources: [...new Set([...arr(row.official_sources), ...arr(values.official_sources)].map(txt).filter(Boolean))],
        official_source_verified: row.official_source_verified === true || values.official_source_verified === true,
        review_notes: [txt(row.review_notes), txt(values.review_notes), 'Duplicate candidate evidence merged during idempotent staging.'].filter(Boolean).join(' '),
        updated_at: now()
      };
      await db(`publisher_discovery_candidates?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => null);
      return { row: { ...row, ...patch }, duplicate: true };
    }
    return { row: null, duplicate: true };
  }
}

function buildConnectionConfig(candidate, endpoint, sources) {
  const method = txt(candidate.acquisition_method).toUpperCase();
  return {
    configuration_version: 'PUBLISHER-CONNECTION-V2',
    access_method: method,
    primary_endpoint: endpoint,
    procurement_platform: txt(candidate.procurement_platform) || null,
    technology_vendor: txt(candidate.technology_vendor) || null,
    vendor_registration_url: txt(candidate.vendor_registration_url) || null,
    registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
    authentication_required: candidate.authentication_required === true,
    public_access_verified: candidate.official_source_verified === true,
    official_sources: sources,
    discovery_entity_classes: arr(candidate.discovery_entity_classes),
    access_instructions: {
      API: 'Use the verified API endpoint, preserve pagination, and retrieve individual opportunity objects.',
      PUBLIC_SEARCH: 'Open the verified public search page, identify active solicitation listings, follow every individual opportunity detail link, retrieve attachments, and extract substantive contract requirements.',
      PUBLIC_PORTAL: 'Use the verified procurement portal and platform-specific public access path. Traverse listings and detail pages. Do not store a portal landing page as a contract.',
      DOCUMENT_FEED: 'Enumerate procurement notices and documents from the verified feed, retrieve each solicitation document, and extract substantive contract requirements.'
    }[method] || 'Use the verified official source and resolve individual solicitation records with substantive requirements.'
  };
}

async function upsertPublisher(candidate, stateCode, sourceVerified, endpoint, sources) {
  const name = txt(candidate.publisher_name);
  const classification = normalizeDiscoveryClassification(candidate);
  const connectionConfig = buildConnectionConfig(candidate, endpoint, sources);
  const existing = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(name)}&state_code=eq.${stateCode}&select=*`);
  const values = {
    publisher_name: name,
    state_code: stateCode,
    organization_type: txt(candidate.organization_type) || null,
    official_website: txt(candidate.official_website) || null,
    procurement_website: txt(candidate.procurement_website) || null,
    acquisition_method: connectionConfig.access_method,
    search_endpoint: endpoint,
    vendor_registration_url: connectionConfig.vendor_registration_url,
    verified: sourceVerified,
    access_status: 'READY',
    last_verified_at: now(),
    updated_at: now(),
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
    publisher_id: publisher.id,
    publisher_name: publisher.publisher_name,
    acquisition_method: connectionConfig.access_method,
    search_endpoint: endpoint,
    search_parameters: {
      state_code: publisher.state_code,
      source: 'PUBLISHER_DISCOVERY_REPORT',
      connection_config: connectionConfig,
      acquisition_command: {
        objective: 'Discover, retrieve, and enrich individual active procurement opportunities from this publisher.',
        required_sequence: ['open_verified_endpoint', 'traverse_listing', 'follow_detail_links', 'retrieve_documents', 'extract_substantive_requirements'],
        reject_page_types: ['publisher_homepage', 'procurement_landing_page', 'generic_portal_shell', 'vendor_registration_page', 'help_page'],
        required_output: 'contract_specific_records_with_substantive_requirements',
        completion_gate: 'Do not count a solicitation as enriched until substantive contract requirements are extracted from the detail page or associated official document.',
        preserve_source_provenance: true
      },
      ...classification
    },
    authorized_status_range: ['OPEN', 'POSTED', 'ACTIVE'],
    pagination_instructions: { follow_next_page: true, stop_when_no_new_opportunities: true },
    attachment_instructions: { follow_solicitation_documents: true, extract_requirements_from_documents: true, preserve_document_urls: true },
    amendment_instructions: { capture_addenda: true, link_to_parent_solicitation: true },
    expected_source_identifiers: ['solicitation_number', 'notice_id', 'project_id', 'bid_number'],
    raw_destination: 'acquisition_raw_records',
    qualification_ruleset_version: 'AADP-QUALIFICATION-V2',
    aoie_review_required: true,
    retry_policy: { max_attempts: 3 },
    runtime_limit_seconds: 3600,
    reporting_requirements: {
      preserve_provenance: true,
      report_rejections: true,
      distinguish_opportunity_channel: true,
      report_connection_method_used: true,
      report_listing_pages_traversed: true,
      report_individual_solicitations_found: true,
      report_detail_pages_retrieved: true,
      report_requirements_extracted: true
    },
    status: 'READY',
    updated_at: now()
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
    discovery_run_id: discoveryRunId,
    publisher_name: name,
    state_code: stateCode,
    organization_type: txt(candidate.organization_type) || unit.entityClass,
    official_website: txt(candidate.official_website) || null,
    procurement_website: txt(candidate.procurement_website) || null,
    acquisition_method: method || 'UNASSESSED',
    search_endpoint: txt(candidate.search_endpoint) || null,
    vendor_registration_url: txt(candidate.vendor_registration_url) || null,
    procurement_platform: txt(candidate.procurement_platform) || null,
    technology_vendor: txt(candidate.technology_vendor) || null,
    registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
    official_sources: sources,
    official_source_verified: sourceVerified,
    duplicate_publisher_id: duplicateId,
    duplicate_status: duplicateId ? 'EXISTING_REGISTRY_MATCH' : 'NO_MATCH',
    review_status: eligible ? 'AUTO_APPROVED' : 'EXCEPTION_REVIEW',
    review_notes: eligible ? `Validated by ${unit.key}: ${unit.entityClass}.` : `Unit ${unit.key} found the candidate, but official verification, supported access method, or usable endpoint is incomplete.`,
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

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = txt(body.command_run_id);
  const stateCode = txt(body.state_code).toUpperCase();
  const discoveryScope = txt(body.discovery_scope || 'STATE_AND_LOCAL').toUpperCase();
  if (!commandRunId || !supportedStateCodes.has(stateCode)) {
    return response(400, { error: 'command_run_id and a supported U.S. state or territory code are required' });
  }

  let discoveryRunId = null;
  const unitResults = [];
  try {
    const plan = buildPublisherExpansionPlan({ stateCode, discoveryScope });
    await patchRun(commandRunId, {
      status: 'running', aadp_state: 'RUNNING', current_stage: 'ENTITY_CLASS_ORCHESTRATION', progress_value: 1,
      result_summary: `Publisher Discovery will execute ${plan.length} entity-class search tasks in succession for ${stateCode}.`
    });
    const existingPublishers = await db(`publisher_registry?state_code=eq.${stateCode}&select=id,organization_type,publisher_name`);
    const discoveryRun = (await db('publisher_discovery_runs', { method: 'POST', body: JSON.stringify({
      command_run_id: commandRunId,
      state_code: stateCode,
      mission_name: `${stateCode} — Sequential Entity-Class Publisher Discovery`,
      discovery_scope: discoveryScope,
      organization_types: [...PUBLISHER_DISCOVERY_ENTITY_CLASSES],
      intelligence_provider: 'OPENAI_WEB_SEARCH',
      operator_name: 'Executive Command Center',
      governance: {
        taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
        execution_model: 'ONE_ENTITY_CLASS_PER_CHILD_TASK',
        entity_class_task_count: plan.length,
        task_trigger_rule: 'SUCCESS_OR_FAILURE_TRIGGERS_NEXT',
        objective_validation_auto_admission: true,
        isolate_incomplete_candidates: true,
        idempotent_candidate_staging: true,
        separate_acquisition_task: true,
        provider_retry_attempts: 2,
        provider_fatal_error_policy: 'STOP_AFTER_FIRST_AUTH_OR_BILLING_FAILURE',
        nationwide_state_support: true
      },
      status: 'RUNNING',
      current_stage: 'ENTITY_CLASS_TASK_01',
      started_at: now(),
      evidence: { source: 'EXECUTIVE_COMMAND_CENTER', runtime: 'NETLIFY_NATIVE', engine: 'SEQUENTIAL_ENTITY_CLASS_ORCHESTRATOR' }
    }) }))?.[0];
    discoveryRunId = discoveryRun?.id;
    if (!discoveryRunId) throw new Error('Publisher discovery run creation failed.');

    const apiKey = env('OPENAI_API_KEY');
    if (!apiKey) throw new Error('Autonomous publisher research provider is not configured.');
    const model = env('OPENAI_DISCOVERY_MODEL') || 'gpt-5.6-terra';
    const batches = [];
    let staged = 0, ready = 0, exceptions = 0, duplicateRegistry = 0, duplicateCandidates = 0;

    for (let index = 0; index < plan.length; index++) {
      const unit = plan[index];
      const childRun = await createChildRun({ parentRunId: commandRunId, stateCode, unit, discoveryScope });
      const childRunId = childRun?.id || null;
      const parentProgress = Math.max(2, Math.round((index / plan.length) * 94));
      await patchRun(commandRunId, {
        current_stage: `${unit.key}_RUNNING`,
        progress_value: parentProgress,
        result_summary: `Entity-class task ${unit.sequence} of ${plan.length}: ${unit.entityClass}.`
      });
      await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
        method: 'PATCH', body: JSON.stringify({ current_stage: unit.key, updated_at: now(), evidence: { latest_unit: unit, unit_results: unitResults } })
      }).catch(() => null);

      try {
        const research = await researchUnit({ apiKey, model, unit });
        batches.push({ strategyKey: unit.key, entityClass: unit.entityClass, candidates: research.candidates });
        let unitStaged = 0, unitReady = 0, unitExceptions = 0;
        for (const candidate of research.candidates) {
          const result = await processCandidate({ candidate, discoveryRunId, stateCode, unit });
          unitStaged += result.staged;
          unitReady += result.ready;
          unitExceptions += result.exception;
          staged += result.staged;
          ready += result.ready;
          exceptions += result.exception;
          duplicateRegistry += result.duplicateRegistry;
          duplicateCandidates += result.duplicateCandidate;
        }
        const unitStatus = research.candidates.length === 0
          ? 'COMPLETED_NO_RESULTS'
          : unitExceptions > 0
            ? 'COMPLETED_WITH_WARNINGS'
            : 'COMPLETED';
        const result = {
          strategyKey: unit.key,
          sequence: unit.sequence,
          entityClass: unit.entityClass,
          status: unitStatus,
          candidatesFound: research.candidates.length,
          candidatesVerified: unitStaged - unitExceptions,
          assignmentsReady: unitReady,
          attempts: research.attempts,
          childRunId
        };
        unitResults.push(result);
        if (childRunId) {
          await patchRun(childRunId, {
            status: 'completed', aadp_state: unitExceptions ? 'PARTIALLY_COMPLETE' : 'COMPLETED',
            current_stage: unitStatus, progress_value: 100, completed_at: now(),
            records_discovered: research.candidates.length, records_acquired: unitStaged,
            records_accepted: unitReady, records_rejected: unitExceptions,
            warning_count: unitExceptions, failure_count: 0, action_required: unitExceptions > 0,
            result_summary: `${unit.entityClass}: ${research.candidates.length} candidates, ${unitReady} READY assignments, ${unitExceptions} exceptions.`,
            execution_evidence: result
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fatalProvider = error?.fatalProvider === true;
        const result = {
          strategyKey: unit.key,
          sequence: unit.sequence,
          entityClass: unit.entityClass,
          status: fatalProvider ? 'PROVIDER_BLOCKED' : 'PROVIDER_FAILED',
          candidatesFound: 0,
          candidatesVerified: 0,
          assignmentsReady: 0,
          attempts: Number(error?.attempts || 2),
          error: message,
          childRunId
        };
        unitResults.push(result);
        if (childRunId) {
          await patchRun(childRunId, {
            status: 'failed', aadp_state: 'FAILED', current_stage: fatalProvider ? 'PROVIDER_BLOCKED' : 'PROVIDER_FAILED',
            progress_value: 100, completed_at: now(), failure_count: 1, action_required: true,
            result_summary: fatalProvider
              ? `${unit.entityClass} stopped because provider authentication, quota, or billing is unavailable. No further entity-class tasks were launched.`
              : `${unit.entityClass} search failed after controlled retries. The next entity-class task was triggered.`,
            execution_evidence: result
          }).catch(() => null);
        }
        if (fatalProvider) {
          const fatalError = new Error(`Publisher Discovery stopped after ${unit.key}: ${message}`);
          Object.assign(fatalError, { fatalProvider: true, providerStatus: error?.providerStatus, attempts: error?.attempts });
          throw fatalError;
        }
      }
      // Non-fatal terminal states intentionally advance to the next unit.
    }

    const candidates = mergePublisherCandidates(batches);
    const coverage = calculateCoverageSummary({ candidates, existingPublishers: arr(existingPublishers), strategyResults: unitResults });
    const failedUnits = unitResults.filter(item => ['PROVIDER_FAILED', 'VALIDATION_FAILED', 'PERSISTENCE_FAILED'].includes(item.status)).length;
    const warningUnits = unitResults.filter(item => item.status === 'COMPLETED_WITH_WARNINGS').length;
    const noResultUnits = unitResults.filter(item => item.status === 'COMPLETED_NO_RESULTS').length;
    const evidence = {
      runtime: 'NETLIFY_NATIVE',
      engine: 'SEQUENTIAL_ENTITY_CLASS_ORCHESTRATOR',
      taxonomy_version: PUBLISHER_DISCOVERY_TAXONOMY_VERSION,
      nationwide_state_support: true,
      coverage,
      unit_results: unitResults,
      candidates_staged: staged,
      assignments_ready: ready,
      exceptions_isolated: exceptions,
      duplicate_registry_matches: duplicateRegistry,
      duplicate_candidate_rows_merged_or_skipped: duplicateCandidates,
      existing_publishers_before_run: arr(existingPublishers).length,
      separate_acquisition_task: true,
      handoff_artifact: 'publisher_assignments.search_parameters.connection_config'
    };

    await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'COMPLETED',
        current_stage: 'ALL_ENTITY_CLASS_TASKS_TERMINAL',
        official_sources_identified: candidates.filter(candidate => candidate.official_source_verified === true).length,
        publishers_presented: staged,
        publishers_approved: ready,
        completed_at: now(), updated_at: now(), evidence
      })
    });

    await patchRun(commandRunId, {
      status: 'completed',
      aadp_state: failedUnits || warningUnits ? 'PARTIALLY_COMPLETE' : 'COMPLETED',
      current_stage: 'ALL_ENTITY_CLASS_TASKS_TERMINAL',
      progress_value: 100,
      records_discovered: candidates.length,
      records_acquired: staged,
      records_accepted: ready,
      records_rejected: exceptions,
      warning_count: failedUnits + warningUnits,
      failure_count: 0,
      action_required: failedUnits > 0 || warningUnits > 0,
      completed_at: now(),
      result_summary: `${plan.length} entity-class tasks reached terminal status for ${stateCode}: ${ready} READY assignments, ${failedUnits} failed tasks, ${noResultUnits} zero-result tasks.`,
      execution_evidence: evidence
    });

    return response(200, {
      ok: true,
      command_run_id: commandRunId,
      discovery_run_id: discoveryRunId,
      state_code: stateCode,
      entity_class_tasks: plan.length,
      tasks_terminal: unitResults.length,
      failed_tasks: failedUnits,
      no_result_tasks: noResultUnits,
      candidates_staged: staged,
      assignments_ready: ready,
      exceptions_isolated: exceptions,
      unit_results: unitResults,
      acquisition_launched: false,
      next_authorized_task: 'ACQUISITION_DISCOVERY'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fatalProvider = error?.fatalProvider === true;
    console.error('command-publisher-expansion-worker-background failed', error);
    if (discoveryRunId) {
      await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'FAILED',
          current_stage: fatalProvider ? 'PROVIDER_BLOCKED' : 'ORCHESTRATION_FAILED',
          completed_at: now(),
          updated_at: now(),
          evidence: { error: message, fatal_provider: fatalProvider, unit_results: unitResults }
        })
      }).catch(() => null);
    }
    await patchRun(commandRunId, {
      status: 'failed', aadp_state: 'FAILED', current_stage: fatalProvider ? 'PROVIDER_BLOCKED' : 'ORCHESTRATION_FAILED', progress_value: 100,
      failure_count: 1, action_required: true, completed_at: now(), result_summary: message,
      execution_evidence: { fatal_provider: fatalProvider, provider_status: error?.providerStatus || null, unit_results: unitResults }
    }).catch(() => null);
    return response(fatalProvider ? 503 : 500, { error: message, fatal_provider: fatalProvider, unit_results: unitResults });
  }
};
