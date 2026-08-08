import { randomUUID } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db, header } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const MISSION_ADAPTERS = Object.freeze({
  VERIFY_PUBLISHER_CONNECTION: { agent: 'Publisher Engineering', label: 'Verify Publisher Connection', worker: 'command-verify-publisher-connection-background', kind: 'publisher_verification' },
  ACQUISITION_DISCOVERY: { agent: 'Acquisition Operations', label: 'M2M Acquisition Discovery', worker: null, kind: 'acquisition' },
  CONTRACT_PACKAGE_ACQUISITION: { agent: 'AADP Package Acquisition', label: 'Complete Contract Packages', worker: 'command-contract-package-worker-background', kind: 'package' },
  PUBLISHER_DISCOVERY: { agent: 'Publisher Expansion', label: 'Publisher Discovery', worker: null, kind: 'publisher' },
  BUSINESS_DEVELOPMENT_DISCOVERY: { agent: 'Business Development Discovery', label: 'Business Development Discovery', worker: 'command-business-development-discovery-worker-background', kind: 'research' },
  OPPORTUNITY_PARTNER_DISCOVERY: { agent: 'Opportunity Partner Discovery', label: 'Opportunity Partner Discovery', worker: 'command-opportunity-partner-discovery-worker-background', kind: 'research' },
  INSTITUTIONAL_BUYER_DISCOVERY: { agent: 'Institutional Buyer Discovery', label: 'Institutional Buyer Discovery', worker: 'command-institutional-buyer-discovery-worker-background', kind: 'research' }
});

const isApprovedPublisher = configuration => {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  return cfg.publisher_profile_approved === true
    && cfg.profile_complete === true
    && cfg.approved_for_operator_menu === true
    && txt(cfg.approval_status).toUpperCase() === 'APPROVED';
};

const isCertifiedPublisher = configuration => {
  const certification = txt(configuration?.certification_status || 'DEVELOPMENT').toUpperCase();
  return ['CERTIFIED', 'PRODUCTION'].includes(certification);
};

const isM2MDiscoveryReady = (publisher, configuration) => {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  const endpoint = txt(publisher?.search_endpoint || publisher?.procurement_website || publisher?.official_website || cfg.primary_endpoint || cfg.listing_url || cfg.official_procurement_url);
  const machineToMachine = publisher?.machine_to_machine_supported === true || cfg.machine_to_machine_supported === true;
  return publisher?.verified === true
    && txt(publisher?.access_status).toUpperCase() === 'READY'
    && machineToMachine
    && Boolean(endpoint)
    && cfg.authentication_required !== true
    && cfg.login_required !== true;
};

async function findActiveCountyDiscovery(stateCode, countyFips, countyName) {
  const encodedState = encodeURIComponent(stateCode);
  const rows = await db(`command_runs?mission_type_key=eq.PUBLISHER_DISCOVERY&state_code=eq.${encodedState}&status=in.(queued,running)&select=id,mission_name,status,current_stage,last_activity_at,execution_evidence&order=started_at.desc`).catch(() => []);
  return (rows || []).find(row => {
    const evidence = row.execution_evidence || {};
    const sameFips = countyFips && txt(evidence.county_fips) === countyFips;
    const sameName = txt(evidence.county_name).toUpperCase() === countyName.toUpperCase();
    return sameFips || sameName;
  }) || null;
}

async function loadPublisher({ publisherId, stateCode, countyName, approvalRequired = true, m2mDiscoveryRequired = false }) {
  const publisher = (await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${stateCode}&county_name=eq.${encodeURIComponent(countyName)}&select=id,publisher_name,state_code,county_name,verified,access_status,machine_to_machine_supported,acquisition_method,search_endpoint,procurement_website,official_website,configuration`))?.[0];
  if (!publisher) throw Object.assign(new Error('Selected publisher profile was not found in the selected county.'), { statusCode: 404 });
  const configuration = publisher.configuration && typeof publisher.configuration === 'object' ? publisher.configuration : {};
  if (m2mDiscoveryRequired && !isM2MDiscoveryReady(publisher, configuration)) {
    throw Object.assign(new Error(`${publisher.publisher_name} is not eligible for M2M Acquisition Discovery. The publisher must be VERIFIED, READY, machine-to-machine supported, expose a usable endpoint, and not require login/authentication for discovery.`), { statusCode: 409, code: 'M2M_DISCOVERY_NOT_READY' });
  }
  if (approvalRequired && !isApprovedPublisher(configuration)) {
    throw Object.assign(new Error(`${publisher.publisher_name} is not approved for operator access. Complete the APROPOS Publisher Profile and approval review first.`), { statusCode: 403, code: 'PUBLISHER_APPROVAL_REQUIRED' });
  }
  return { ...publisher, configuration };
}

async function createPublisherAcquisitionRun({ publisher, stateCode, countyName, countyFips, adapter, parentBatchId = null }) {
  const createdAt = now();
  const configuration = {
    publisher_scope: 'SINGLE',
    publisher_id: publisher.id,
    publisher_name: publisher.publisher_name,
    county_name: countyName,
    county_fips: countyFips,
    geographic_scope: 'COUNTY',
    publisher_approval_required: false,
    publisher_certification_required: false,
    discovery_gate: 'M2M_DISCOVERY_READY',
    execution_model: 'PUBLISHER_ADAPTER_DISPATCH',
    dispatch_model: 'SUPABASE_POSTGRES_QUEUE',
    parent_batch_id: parentBatchId
  };
  const missionName = `M2M Acquisition Discovery — ${stateCode} — ${countyName} — Publisher ${publisher.publisher_name}`;
  const runRows = await db('command_runs', { method: 'POST', body: JSON.stringify({
    idempotency_key: `ecc:ACQUISITION_DISCOVERY:${stateCode}:SINGLE:${publisher.id}:${randomUUID()}`,
    status: 'queued',
    current_stage: 'POSTGRES_EXECUTION_REQUESTED',
    aadp_state: 'QUEUED',
    mission_type_key: 'ACQUISITION_DISCOVERY',
    mission_name: missionName,
    state_code: stateCode,
    assigned_agent: adapter.agent,
    started_at: createdAt,
    last_activity_at: createdAt,
    progress_mode: 'STAGE',
    progress_value: 5,
    execution_evidence: {
      source: 'EXECUTIVE_COMMAND_CENTER',
      runtime: 'SUPABASE_POSTGRES',
      operator_authorized: true,
      ...configuration,
      assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
    }
  }) });
  const run = runRows?.[0];
  if (!run?.id) throw new Error('Command run creation failed.');
  const missionRows = await db('command_missions', { method: 'POST', body: JSON.stringify({
    mission_type_key: 'ACQUISITION_DISCOVERY',
    mission_name: missionName,
    state_code: stateCode,
    assigned_agent: adapter.agent,
    authorization_state: 'AUTHORIZED',
    authorization_required: true,
    authorized_at: createdAt,
    command_run_id: run.id,
    mission_config: {
      source: 'EXECUTIVE_COMMAND_CENTER',
      runtime: 'SUPABASE_POSTGRES',
      ...configuration,
      assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
    }
  }) });
  return { run, mission: missionRows?.[0] || null, configuration };
}

async function createPublisherDiscoveryRun({ stateCode, countyName, countyFips, discoveryScope, adapter, missionName }) {
  const createdAt = now();
  const configuration = {
    discovery_scope: discoveryScope,
    county_name: countyName,
    county_fips: countyFips,
    geographic_scope: 'COUNTY',
    autonomous_research: true,
    platform_classification_required: true,
    mission_adapter: 'GITHUB_ACTIONS_PUBLISHER_DISCOVERY',
    execution_model: 'CHECKPOINTED_ENTITY_CLASS_GITHUB_LOOP',
    dispatch_model: 'SUPABASE_POSTGRES_QUEUE',
    checkpointed: true
  };
  const runRows = await db('command_runs', { method: 'POST', body: JSON.stringify({
    idempotency_key: `ecc:PUBLISHER_DISCOVERY:${stateCode}:${discoveryScope}:${randomUUID()}`,
    status: 'queued',
    current_stage: 'POSTGRES_EXECUTION_REQUESTED',
    aadp_state: 'QUEUED',
    mission_type_key: 'PUBLISHER_DISCOVERY',
    mission_name: missionName,
    state_code: stateCode,
    assigned_agent: adapter.agent,
    started_at: createdAt,
    last_activity_at: createdAt,
    progress_mode: 'STAGE',
    progress_value: 5,
    execution_evidence: {
      source: 'EXECUTIVE_COMMAND_CENTER',
      runtime: 'SUPABASE_POSTGRES',
      operator_authorized: true,
      ...configuration,
      assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
    }
  }) });
  const run = runRows?.[0];
  if (!run?.id) throw new Error('Publisher Discovery command run creation failed.');
  const missionRows = await db('command_missions', { method: 'POST', body: JSON.stringify({
    mission_type_key: 'PUBLISHER_DISCOVERY',
    mission_name: missionName,
    state_code: stateCode,
    assigned_agent: adapter.agent,
    authorization_state: 'AUTHORIZED',
    authorization_required: true,
    authorized_at: createdAt,
    command_run_id: run.id,
    mission_config: {
      source: 'EXECUTIVE_COMMAND_CENTER',
      runtime: 'SUPABASE_POSTGRES',
      ...configuration,
      assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
    }
  }) });
  return { run, mission: missionRows?.[0] || null, configuration };
}

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  try {
    const body = parseBody(event);
    const missionType = txt(body.mission_type_key).toUpperCase();
    const stateCode = txt(body.state_code).toUpperCase();
    const countyName = txt(body.county_name);
    const countyFips = txt(body.county_fips) || null;
    const adapter = MISSION_ADAPTERS[missionType];
    if (!missionType || !/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Task and State are required.' });
    if (!adapter) return response(409, { error: `${missionType} does not yet have a native runtime adapter.`, code: 'RUNTIME_ADAPTER_REQUIRED' });

    const requiresPublisher = ['acquisition', 'package', 'publisher_verification'].includes(adapter.kind);
    const requiresCounty = ['publisher', 'acquisition', 'package', 'publisher_verification'].includes(adapter.kind);
    const requestedPublisherScope = adapter.kind === 'acquisition'
      ? txt(body.publisher_scope || 'SINGLE').toUpperCase()
      : requiresPublisher ? 'SINGLE' : null;
    const publisherId = requiresPublisher && body.publisher_id ? txt(body.publisher_id) : null;
    if (requiresCounty && !countyName) return response(400, { error: 'county_name is required for county-centric publisher tasks.', code: 'COUNTY_SCOPE_REQUIRED' });
    if (adapter.kind === 'acquisition' && requestedPublisherScope !== 'SINGLE') {
      return response(400, { error: 'M2M Acquisition Discovery is fixed to SINGLE publisher execution.', code: 'PUBLISHER_SCOPE_INVALID' });
    }
    if (requiresPublisher && requestedPublisherScope === 'SINGLE' && !publisherId) return response(400, { error: 'publisher_id is required for SINGLE publisher execution.', code: 'SINGLE_PUBLISHER_REQUIRED' });

    const countyScope = requiresCounty ? `COUNTY|${countyFips || ''}|${countyName.toUpperCase()}` : null;
    const discoveryScope = adapter.kind === 'publisher'
      ? countyScope
      : requiresPublisher
        ? null
        : txt(body.discovery_scope || 'STATEWIDE').toUpperCase();
    if (adapter.kind === 'research' && !['STATEWIDE', 'STATEWIDE_ALL', 'STATE_AND_LOCAL', 'REFRESH'].includes(discoveryScope)) {
      return response(400, { error: 'Unsupported discovery scope.' });
    }

    if (adapter.kind === 'publisher') {
      const active = await findActiveCountyDiscovery(stateCode, countyFips, countyName);
      if (active) return response(409, {
        error: `Publisher Discovery is already active for ${countyName}. Resume or review the existing run instead of launching a duplicate.`,
        code: 'COUNTY_DISCOVERY_ALREADY_ACTIVE',
        active_run_id: active.id,
        active_stage: active.current_stage,
        last_activity_at: active.last_activity_at
      });
      const missionName = txt(body.mission_name || `${adapter.label} — ${stateCode} — ${countyName}`);
      const created = await createPublisherDiscoveryRun({ stateCode, countyName, countyFips, discoveryScope, adapter, missionName });
      return response(202, {
        mission: created.mission,
        run: created.run,
        execution: {
          runtime: 'SUPABASE_POSTGRES',
          worker: 'GITHUB_ACTIONS',
          dispatch_status: 'QUEUED',
          assigned_agent: adapter.agent,
          discovery_scope: discoveryScope,
          queue_model: 'CHECKPOINTED_ENTITY_CLASS_GITHUB_LOOP'
        }
      });
    }

    if (adapter.kind === 'acquisition') {
      const publisher = await loadPublisher({ publisherId, stateCode, countyName, approvalRequired: false, m2mDiscoveryRequired: true });
      const created = await createPublisherAcquisitionRun({ publisher, stateCode, countyName, countyFips, adapter });
      return response(202, {
        mission: created.mission,
        run: created.run,
        execution: {
          runtime: 'SUPABASE_POSTGRES',
          worker: 'GITHUB_ACTIONS',
          dispatch_status: 'QUEUED',
          assigned_agent: adapter.agent,
          publisher_scope: 'SINGLE',
          publisher_id: publisher.id,
          discovery_gate: 'M2M_DISCOVERY_READY',
          certification_required: false
        }
      });
    }

    if (requiresPublisher) {
      const publisher = await loadPublisher({ publisherId, stateCode, countyName });
      if (adapter.kind === 'package' && !isCertifiedPublisher(publisher.configuration)) return response(409, {
        error: `${publisher.publisher_name} has not passed EAG-001. Run Verify Publisher Connection first.`,
        code: 'PUBLISHER_CERTIFICATION_REQUIRED', certification_status: txt(publisher.configuration.certification_status || 'DEVELOPMENT').toUpperCase()
      });
    }

    const missionName = txt(body.mission_name || `${stateCode} — ${countyName || 'Statewide'} — ${adapter.label}`);
    const createdAt = now();
    const configuration = requiresPublisher
      ? {
          publisher_scope: 'SINGLE', publisher_id: publisherId, county_name: countyName, county_fips: countyFips,
          geographic_scope: 'COUNTY',
          publisher_approval_required: true,
          execution_model: adapter.kind === 'publisher_verification'
            ? 'EAG_001_READ_ONLY'
            : 'CHECKPOINTED_COMPLETE_CONTRACT_PACKAGE'
        }
      : { discovery_scope: discoveryScope, autonomous_research: true, mission_adapter: adapter.worker };

    const scopeKey = requestedPublisherScope || discoveryScope || countyScope || 'DEFAULT';
    const runRows = await db('command_runs', { method: 'POST', body: JSON.stringify({
      idempotency_key: `ecc:${missionType}:${stateCode}:${scopeKey}:${publisherId || 'ALL'}:${randomUUID()}`,
      status: 'queued', current_stage: 'NETLIFY_EXECUTION_QUEUED', aadp_state: 'QUEUED', mission_type_key: missionType, mission_name: missionName, state_code: stateCode,
      assigned_agent: adapter.agent, started_at: createdAt, last_activity_at: createdAt, progress_mode: 'STAGE', progress_value: 5,
      execution_evidence: { source: 'EXECUTIVE_COMMAND_CENTER', runtime: 'NETLIFY_NATIVE', operator_authorized: true, ...configuration, assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION' }
    }) });
    const run = runRows?.[0];
    if (!run?.id) throw new Error('Command run creation failed.');
    const missionRows = await db('command_missions', { method: 'POST', body: JSON.stringify({
      mission_type_key: missionType, mission_name: missionName, state_code: stateCode, assigned_agent: adapter.agent, authorization_state: 'AUTHORIZED', authorization_required: true,
      authorized_at: createdAt, command_run_id: run.id, mission_config: { source: 'EXECUTIVE_COMMAND_CENTER', runtime: 'NETLIFY_NATIVE', ...configuration, assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION' }
    }) });
    const mission = missionRows?.[0];
    const host = header(event, 'host'), dashboardPassword = header(event, 'x-dashboard-password');
    if (!host) throw new Error('Netlify host context unavailable.');
    const workerPayload = requiresPublisher
      ? { command_run_id: run.id, state_code: stateCode, county_name: countyName, county_fips: countyFips, publisher_scope: 'SINGLE', publisher_id: publisherId, sample_size: Number(body.sample_size || 10), batch_size: Number(body.batch_size || 3) }
      : { command_run_id: run.id, mission_type_key: missionType, mission_name: missionName, state_code: stateCode, county_name: countyName || null, county_fips: countyFips, discovery_scope: discoveryScope };

    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    let workerResponse;
    try {
      workerResponse = await fetch(`https://${host}/.netlify/functions/${adapter.worker}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': dashboardPassword }, body: JSON.stringify(workerPayload), signal: controller.signal });
    } finally { clearTimeout(timeout); }
    if (!workerResponse.ok && workerResponse.status !== 202) {
      const detail = await workerResponse.text();
      await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', aadp_state: 'FAILED', current_stage: 'WORKER_DISPATCH_FAILED', action_required: true, completed_at: now(), last_activity_at: now(), result_summary: detail || `Worker dispatch failed (${workerResponse.status})` }) });
      return response(502, { error: `Native ${adapter.label} worker dispatch failed.`, detail, run });
    }
    return response(202, { mission, run, execution: { runtime: 'NETLIFY_NATIVE', worker: adapter.worker, dispatch_status: workerResponse.status, assigned_agent: adapter.agent, ...configuration } });
  } catch (error) {
    console.error('command-mission-control failed', error);
    if (/duplicate key value.*command_runs_active_county_discovery_uidx/i.test(error instanceof Error ? error.message : String(error))) {
      return response(409, { error: 'Publisher Discovery is already active for the selected county.', code: 'COUNTY_DISCOVERY_ALREADY_ACTIVE' });
    }
    return response(error?.statusCode || 500, { error: error instanceof Error ? error.message : String(error), code: error?.code || undefined });
  }
};