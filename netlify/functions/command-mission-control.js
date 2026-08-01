import { randomUUID } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db, header } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const STATIC_AGENTS = Object.freeze({
  ACQUISITION_DISCOVERY: 'Acquisition Operations'
});

export const handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const body = parseBody(event);
    const missionType = String(body.mission_type_key || '').trim().toUpperCase();
    const stateCode = String(body.state_code || '').trim().toUpperCase();
    const publisherScope = String(body.publisher_scope || 'ALL').trim().toUpperCase() || 'ALL';
    const publisherId = body.publisher_id ? String(body.publisher_id).trim() : null;

    if (!missionType || !/^[A-Z]{2}$/.test(stateCode)) {
      return response(400, { error: 'Task and State are required.' });
    }
    if (missionType !== 'ACQUISITION_DISCOVERY') {
      return response(409, { error: `${missionType} does not yet have a native Netlify runtime adapter.`, code: 'NETLIFY_RUNTIME_ADAPTER_REQUIRED' });
    }
    if (!['ALL', 'SINGLE'].includes(publisherScope)) {
      return response(400, { error: 'publisher_scope must be ALL or SINGLE.' });
    }
    if (publisherScope === 'SINGLE' && !publisherId) {
      return response(400, { error: 'publisher_id is required when publisher_scope is SINGLE.' });
    }

    const agent = STATIC_AGENTS[missionType];
    const missionName = String(body.mission_name || `${stateCode} — Acquisition Discovery`).trim();
    const createdAt = now();
    const runRows = await db('command_runs', {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: `ecc:${missionType}:${stateCode}:${publisherScope}:${publisherId || 'ALL'}:${randomUUID()}`,
        status: 'queued',
        current_stage: 'NETLIFY_EXECUTION_QUEUED',
        aadp_state: 'QUEUED',
        mission_type_key: missionType,
        mission_name: missionName,
        state_code: stateCode,
        assigned_agent: agent,
        started_at: createdAt,
        last_activity_at: createdAt,
        progress_mode: 'STAGE',
        progress_value: 5,
        execution_evidence: {
          source: 'EXECUTIVE_COMMAND_CENTER',
          runtime: 'NETLIFY_NATIVE',
          operator_authorized: true,
          publisher_scope: publisherScope,
          publisher_id: publisherId,
          assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
        }
      })
    });
    const run = runRows?.[0];
    if (!run?.id) throw new Error('Command run creation failed.');

    const missionRows = await db('command_missions', {
      method: 'POST',
      body: JSON.stringify({
        mission_type_key: missionType,
        mission_name: missionName,
        state_code: stateCode,
        assigned_agent: agent,
        authorization_state: 'AUTHORIZED',
        authorization_required: true,
        authorized_at: createdAt,
        command_run_id: run.id,
        mission_config: {
          source: 'EXECUTIVE_COMMAND_CENTER',
          runtime: 'NETLIFY_NATIVE',
          publisher_scope: publisherScope,
          publisher_id: publisherId,
          assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
        }
      })
    });
    const mission = missionRows?.[0];

    const host = header(event, 'host');
    const dashboardPassword = header(event, 'x-dashboard-password');
    if (!host) throw new Error('Netlify host context unavailable.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let workerResponse;
    try {
      workerResponse = await fetch(`https://${host}/.netlify/functions/command-acquisition-worker-background`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dashboard-password': dashboardPassword
        },
        body: JSON.stringify({
          command_run_id: run.id,
          state_code: stateCode,
          publisher_scope: publisherScope,
          publisher_id: publisherId
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!workerResponse.ok && workerResponse.status !== 202) {
      const detail = await workerResponse.text();
      await db(`command_runs?id=eq.${run.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', aadp_state: 'FAILED', current_stage: 'WORKER_DISPATCH_FAILED', action_required: true, completed_at: now(), last_activity_at: now(), result_summary: detail || `Worker dispatch failed (${workerResponse.status})` })
      });
      return response(502, { error: 'Native acquisition worker dispatch failed.', detail, run });
    }

    return response(202, {
      mission,
      run,
      execution: {
        runtime: 'NETLIFY_NATIVE',
        worker: 'command-acquisition-worker-background',
        dispatch_status: workerResponse.status,
        publisher_scope: publisherScope,
        publisher_id: publisherId,
        assigned_agent: agent
      }
    });
  } catch (error) {
    console.error('command-mission-control failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
