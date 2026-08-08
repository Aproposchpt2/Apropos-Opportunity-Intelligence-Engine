import { createHash, randomUUID } from 'node:crypto';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const WORKER_ID = process.env.PUBLISHER_VERIFICATION_WORKER_ID || `github-actions:eag001:${process.env.GITHUB_RUN_ID || randomUUID()}:${process.env.GITHUB_RUN_ATTEMPT || 1}`;
const LEASE_SECONDS = Number(process.env.PUBLISHER_VERIFICATION_LEASE_SECONDS || 900);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json'
};

async function rpc(name, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${name} failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function firstRow(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value && typeof value === 'object' ? value : null;
}

async function heartbeat(queueId, stage) {
  return rpc('heartbeat_command_execution', {
    p_queue_id: queueId,
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
    p_stage: stage
  });
}

async function processOne() {
  const job = firstRow(await rpc('claim_next_publisher_verification_execution', {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS
  }));

  if (!job) {
    console.log('No queued VERIFY_PUBLISHER_CONNECTION jobs.');
    return;
  }

  const payload = job.payload || {};
  const evidence = payload.execution_evidence || {};
  const stateCode = String(payload.state_code || evidence.state_code || '').toUpperCase();
  const publisherId = payload.publisher_id || evidence.publisher_id || null;
  const queueId = job.queue_id;
  const commandRunId = job.command_run_id;

  if (!queueId || !commandRunId || !publisherId || !/^[A-Z]{2}$/.test(stateCode)) {
    const error = 'Publisher verification queue payload is missing queue_id, command_run_id, publisher_id, or valid state_code.';
    await rpc('fail_command_execution_terminal', { p_queue_id: queueId, p_worker_id: WORKER_ID, p_result: {}, p_error: error }).catch(() => null);
    throw new Error(error);
  }

  const localPassword = `eag001-${randomUUID()}`;
  process.env.EXECUTIVE_AUTH_HASH = createHash('sha256').update(localPassword).digest('hex');

  try {
    await heartbeat(queueId, 'EAG_001_PROFILE_LOADING');
    const { handler } = await import('../netlify/functions/command-verify-publisher-connection-background.js');
    await heartbeat(queueId, 'EAG_001_WORKER_RUNNING');

    const response = await handler({
      httpMethod: 'POST',
      headers: {
        'x-dashboard-password': localPassword,
        'x-postgres-worker-id': WORKER_ID
      },
      body: JSON.stringify({
        command_run_id: commandRunId,
        state_code: stateCode,
        publisher_id: publisherId,
        publisher_scope: 'SINGLE',
        sample_size: 5
      })
    });

    const statusCode = Number(response?.statusCode || 500);
    let body = {};
    try { body = response?.body ? JSON.parse(response.body) : {}; } catch { body = { raw_body: response?.body || '' }; }

    if (statusCode < 200 || statusCode >= 300) {
      const error = body?.error || `EAG-001 worker returned HTTP ${statusCode}.`;
      await rpc('fail_command_execution_terminal', {
        p_queue_id: queueId,
        p_worker_id: WORKER_ID,
        p_result: body,
        p_error: error
      });
      throw new Error(error);
    }

    await heartbeat(queueId, 'EAG_001_FINALIZING');
    await rpc('finish_command_execution', {
      p_queue_id: queueId,
      p_worker_id: WORKER_ID,
      p_success: true,
      p_result: body,
      p_error: null
    });

    console.log(JSON.stringify({ queue_id: queueId, command_run_id: commandRunId, status: 'COMPLETED', result: body }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

await processOne();
