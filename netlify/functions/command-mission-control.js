import { randomUUID } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db, header } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const MISSION_ADAPTERS = Object.freeze({
  VERIFY_PUBLISHER_CONNECTION: { agent: 'Publisher Engineering', label: 'Verify Publisher Connection', worker: 'command-verify-publisher-connection-background', kind: 'publisher_verification' },
  ACQUISITION_DISCOVERY: { agent: 'Acquisition Operations', label: 'Acquisition Discovery', worker: 'command-single-publisher-acquisition-background', kind: 'acquisition' },
  CONTRACT_PACKAGE_ACQUISITION: { agent: 'AADP Package Acquisition', label: 'Complete Contract Packages', worker: 'command-contract-package-worker-background', kind: 'package' },
  PUBLISHER_DISCOVERY: { agent: 'Publisher Expansion', label: 'Publisher Discovery', worker: 'command-publisher-expansion-worker-background', kind: 'publisher' },
  BUSINESS_DEVELOPMENT_DISCOVERY: { agent: 'Business Development Discovery', label: 'Business Development Discovery', worker: 'command-business-development-discovery-worker-background', kind: 'research' },
  OPPORTUNITY_PARTNER_DISCOVERY: { agent: 'Opportunity Partner Discovery', label: 'Opportunity Partner Discovery', worker: 'command-opportunity-partner-discovery-worker-background', kind: 'research' },
  INSTITUTIONAL_BUYER_DISCOVERY: { agent: 'Institutional Buyer Discovery', label: 'Institutional Buyer Discovery', worker: 'command-institutional-buyer-discovery-worker-background', kind: 'research' }
});

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
    if (!adapter) return response(409, { error: `${missionType} does not yet have a native Netlify runtime adapter.`, code: 'NETLIFY_RUNTIME_ADAPTER_REQUIRED' });

    const requiresPublisher = ['acquisition', 'package', 'publisher_verification'].includes(adapter.kind);
    const requiresCounty = ['publisher', 'acquisition', 'package', 'publisher_verification'].includes(adapter.kind);
    const publisherScope = requiresPublisher ? 'SINGLE' : null;
    const publisherId = requiresPublisher && body.publisher_id ? txt(body.publisher_id) : null;
    if (requiresCounty && !countyName) return response(400, { error: 'county_name is required for county-centric publisher tasks.', code: 'COUNTY_SCOPE_REQUIRED' });
    if (requiresPublisher && !publisherId) return response(400, { error: 'publisher_id is required. This task executes one publisher at a time.', code: 'SINGLE_PUBLISHER_REQUIRED' });

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
    }

    if (requiresPublisher) {
      const publisher = (await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${stateCode}&county_name=eq.${encodeURIComponent(countyName)}&select=id,publisher_name,county_name,configuration`))?.[0];
      if (!publisher) return response(404, { error: 'Selected publisher profile was not found in the selected county.' });
      if (['acquisition', 'package'].includes(adapter.kind)) {
        const certification = String(publisher.configuration?.certification_status || 'DEVELOPMENT').toUpperCase();
        if (!['CERTIFIED', 'PRODUCTION'].includes(certification)) return response(409, {
          error: `${publisher.publisher_name} has not passed EAG-001. Run Verify Publisher Connection first.`,
          code: 'PUBLISHER_CERTIFICATION_REQUIRED', certification_status: certification
        });
      }
    }

    const missionName = txt(body.mission_name || `${stateCode} — ${countyName || 'Statewide'} — ${adapter.label}`);
    const createdAt = now();
    const configuration = requiresPublisher
      ? {
          publisher_scope: 'SINGLE', publisher_id: publisherId, county_name: countyName, county_fips: countyFips,
          geographic_scope: 'COUNTY',
          execution_model: adapter.kind === 'publisher_verification'
            ? 'EAG_001_READ_ONLY'
            : adapter.kind === 'package'
              ? 'CHECKPOINTED_COMPLETE_CONTRACT_PACKAGE'
              : 'PUBLISHER_SPECIFIC_CONNECTOR'
        }
      : adapter.kind === 'publisher'
        ? {
            discovery_scope: discoveryScope, county_name: countyName, county_fips: countyFips, geographic_scope: 'COUNTY',
            autonomous_research: true, platform_classification_required: true, mission_adapter: adapter.worker,
            execution_model: 'ONE_ENTITY_CLASS_PER_BACKGROUND_INVOCATION', checkpointed: true
          }
        : { discovery_scope: discoveryScope, autonomous_research: true, mission_adapter: adapter.worker };

    const scopeKey = publisherScope || discoveryScope || countyScope || 'DEFAULT';
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
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
