import { randomUUID } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db, header } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const MISSION_ADAPTERS = Object.freeze({
  ACQUISITION_DISCOVERY: { agent: 'Acquisition Operations', label: 'Acquisition Discovery', worker: 'command-acquisition-worker-background', kind: 'acquisition' },
  PUBLISHER_DISCOVERY: { agent: 'Publisher Expansion', label: 'Publisher Expansion', worker: 'command-publisher-expansion-worker-background', kind: 'publisher' },
  BUSINESS_DEVELOPMENT_DISCOVERY: { agent: 'Business Development Discovery', label: 'Business Development Discovery', worker: 'command-business-development-discovery-worker-background', kind: 'research' },
  OPPORTUNITY_PARTNER_DISCOVERY: { agent: 'Opportunity Partner Discovery', label: 'Opportunity Partner Discovery', worker: 'command-opportunity-partner-discovery-worker-background', kind: 'research' },
  INSTITUTIONAL_BUYER_DISCOVERY: { agent: 'Institutional Buyer Discovery', label: 'Institutional Buyer Discovery', worker: 'command-institutional-buyer-discovery-worker-background', kind: 'research' }
});

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const body = parseBody(event);
    const missionType = String(body.mission_type_key || '').trim().toUpperCase();
    const stateCode = String(body.state_code || '').trim().toUpperCase();
    const adapter = MISSION_ADAPTERS[missionType];
    if (!missionType || !/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Task and State are required.' });
    if (!adapter) return response(409, { error: `${missionType} does not yet have a native Netlify runtime adapter.`, code: 'NETLIFY_RUNTIME_ADAPTER_REQUIRED' });

    const publisherScope = adapter.kind === 'acquisition' ? String(body.publisher_scope || 'ALL').trim().toUpperCase() || 'ALL' : null;
    const publisherId = adapter.kind === 'acquisition' && body.publisher_id ? String(body.publisher_id).trim() : null;
    const discoveryScope = adapter.kind !== 'acquisition' ? String(body.discovery_scope || 'STATEWIDE').trim().toUpperCase() : null;

    if (adapter.kind === 'acquisition') {
      if (!['ALL', 'SINGLE'].includes(publisherScope)) return response(400, { error: 'publisher_scope must be ALL or SINGLE.' });
      if (publisherScope === 'SINGLE' && !publisherId) return response(400, { error: 'publisher_id is required when publisher_scope is SINGLE.' });
    } else if (!['STATEWIDE', 'STATEWIDE_ALL', 'STATE_AND_LOCAL', 'REFRESH'].includes(discoveryScope)) {
      return response(400, { error: 'Unsupported discovery scope.' });
    }

    const missionName = String(body.mission_name || `${stateCode} — ${adapter.label}`).trim();
    const createdAt = now();
    const configuration = adapter.kind === 'acquisition'
      ? { publisher_scope: publisherScope, publisher_id: publisherId }
      : { discovery_scope: discoveryScope, autonomous_research: true, mission_adapter: adapter.worker };

    const runRows = await db('command_runs', {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: `ecc:${missionType}:${stateCode}:${publisherScope || discoveryScope || 'DEFAULT'}:${publisherId || 'ALL'}:${randomUUID()}`,
        status: 'queued', current_stage: 'NETLIFY_EXECUTION_QUEUED', aadp_state: 'QUEUED',
        mission_type_key: missionType, mission_name: missionName, state_code: stateCode,
        assigned_agent: adapter.agent, started_at: createdAt, last_activity_at: createdAt,
        progress_mode: 'STAGE', progress_value: 5,
        execution_evidence: { source: 'EXECUTIVE_COMMAND_CENTER', runtime: 'NETLIFY_NATIVE', operator_authorized: true, ...configuration, assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION' }
      })
    });
    const run = runRows?.[0];
    if (!run?.id) throw new Error('Command run creation failed.');

    const missionRows = await db('command_missions', {
      method: 'POST',
      body: JSON.stringify({
        mission_type_key: missionType, mission_name: missionName, state_code: stateCode,
        assigned_agent: adapter.agent, authorization_state: 'AUTHORIZED', authorization_required: true,
        authorized_at: createdAt, command_run_id: run.id,
        mission_config: { source: 'EXECUTIVE_COMMAND_CENTER', runtime: 'NETLIFY_NATIVE', ...configuration, assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION' }
      })
    });
    const mission = missionRows?.[0];

    const host = header(event, 'host');
    const dashboardPassword = header(event, 'x-dashboard-password');
    if (!host) throw new Error('Netlify host context unavailable.');
    const workerPayload = adapter.kind === 'acquisition'
      ? { command_run_id: run.id, state_code: stateCode, publisher_scope: publisherScope, publisher_id: publisherId }
      : { command_run_id: run.id, mission_type_key: missionType, mission_name: missionName, state_code: stateCode, discovery_scope: discoveryScope };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let workerResponse;
    try {
      workerResponse = await fetch(`https://${host}/.netlify/functions/${adapter.worker}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': dashboardPassword },
        body: JSON.stringify(workerPayload), signal: controller.signal
      });
    } finally { clearTimeout(timeout); }

    if (!workerResponse.ok && workerResponse.status !== 202) {
      const detail = await workerResponse.text();
      await db(`command_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', aadp_state: 'FAILED', current_stage: 'WORKER_DISPATCH_FAILED', action_required: true, completed_at: now(), last_activity_at: now(), result_summary: detail || `Worker dispatch failed (${workerResponse.status})` }) });
      return response(502, { error: `Native ${adapter.label} worker dispatch failed.`, detail, run });
    }

    return response(202, { mission, run, execution: { runtime: 'NETLIFY_NATIVE', worker: adapter.worker, dispatch_status: workerResponse.status, assigned_agent: adapter.agent, ...configuration } });
  } catch (error) {
    console.error('command-mission-control failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
