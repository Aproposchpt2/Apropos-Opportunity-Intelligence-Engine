const { randomUUID } = require('node:crypto');
const { response, parseBody, requireDashboardAuth, db, header } = require('../lib/native-runtime');

const now = () => new Date().toISOString();

exports.handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const body = parseBody(event);
    const missionType = String(body.mission_type_key || '').trim().toUpperCase();
    const stateCode = String(body.state_code || '').trim().toUpperCase();
    const agent = String(body.assigned_agent || '').trim();
    const publisherScope = String(body.publisher_scope || body.publisher_id || 'ALL').trim() || 'ALL';

    if (!missionType || !/^[A-Z]{2}$/.test(stateCode) || !agent) {
      return response(400, { error: 'Task, State, and Agent are required.' });
    }
    if (missionType !== 'ACQUISITION_DISCOVERY') {
      return response(409, { error: `${missionType} does not yet have a native Netlify runtime adapter.`, code: 'NETLIFY_RUNTIME_ADAPTER_REQUIRED' });
    }

    const missionName = String(body.mission_name || `${stateCode} — Acquisition Discovery`).trim();
    const createdAt = now();
    const runRows = await db('command_runs', {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: `ecc:${missionType}:${stateCode}:${randomUUID()}`,
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
          publisher_scope: publisherScope
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
          publisher_scope: publisherScope
        }
      })
    });
    const mission = missionRows?.[0];

    const host = header(event, 'host');
    const dashboardPassword = header(event, 'x-dashboard-password');
    if (!host) throw new Error('Netlify host context unavailable.');

    const workerResponse = await fetch(`https://${host}/.netlify/functions/command-acquisition-worker-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dashboard-password': dashboardPassword
      },
      body: JSON.stringify({ command_run_id: run.id, state_code: stateCode, publisher_scope: publisherScope }),
      signal: AbortSignal.timeout(10000)
    });

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
        dispatch_status: workerResponse.status
      }
    });
  } catch (error) {
    console.error('command-mission-control failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
