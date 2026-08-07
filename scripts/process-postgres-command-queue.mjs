import { createHash, randomUUID } from 'node:crypto';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const WORKER_ID = process.env.POSTGRES_QUEUE_WORKER_ID || `github-actions:${process.env.GITHUB_RUN_ID || randomUUID()}`;
const LEASE_SECONDS = Number(process.env.POSTGRES_QUEUE_LEASE_SECONDS || 900);
const MAX_JOBS = Math.max(1, Math.min(10, Number(process.env.POSTGRES_QUEUE_MAX_JOBS || 1)));

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json'
};

async function rpc(name, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
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

async function finish(queueId, success, result = {}, error = null) {
  return rpc('finish_command_execution', {
    p_queue_id: queueId,
    p_worker_id: WORKER_ID,
    p_success: success,
    p_result: result,
    p_error: error
  });
}

async function runAcquisitionDiscovery(job) {
  const payload = job.payload || {};
  const evidence = payload.execution_evidence || {};
  const commandRunId = job.command_run_id;
  const stateCode = String(payload.state_code || evidence.state_code || '').toUpperCase();
  const publisherScope = String(evidence.publisher_scope || payload.publisher_scope || 'ALL').toUpperCase();
  const publisherId = evidence.publisher_id || payload.publisher_id || null;

  if (!commandRunId || !/^[A-Z]{2}$/.test(stateCode)) {
    throw new Error('Queued acquisition discovery job is missing command_run_id or state_code.');
  }

  // Reuse the existing native acquisition implementation directly inside the
  // GitHub runner. This does not invoke Netlify and therefore is not subject
  // to Netlify request/background-function execution limits.
  const localPassword = `queue-${randomUUID()}`;
  process.env.EXECUTIVE_AUTH_HASH = createHash('sha256').update(localPassword).digest('hex');

  const { handler } = await import('../netlify/functions/command-acquisition-worker-background.js');
  const event = {
    httpMethod: 'POST',
    headers: { 'x-dashboard-password': localPassword },
    body: JSON.stringify({
      command_run_id: commandRunId,
      state_code: stateCode,
      publisher_scope: publisherScope,
      publisher_id: publisherId
    })
  };

  await heartbeat(job.id, 'GITHUB_ACQUISITION_DISCOVERY_RUNNING');
  const response = await handler(event);
  const statusCode = Number(response?.statusCode || 500);
  let body = {};
  try { body = response?.body ? JSON.parse(response.body) : {}; }
  catch { body = { raw_body: response?.body || '' }; }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Acquisition discovery worker returned HTTP ${statusCode}: ${JSON.stringify(body)}`);
  }

  return { status_code: statusCode, ...body };
}

async function executeJob(job) {
  const missionType = String(job.mission_type_key || '').toUpperCase();
  switch (missionType) {
    case 'ACQUISITION_DISCOVERY':
      return runAcquisitionDiscovery(job);
    default:
      throw new Error(`No GitHub PostgreSQL queue adapter is configured for mission type ${missionType || 'UNKNOWN'}.`);
  }
}

async function processOne() {
  await rpc('recover_expired_command_executions', {});
  const claimed = firstRow(await rpc('claim_next_command_execution', {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS
  }));

  if (!claimed) {
    console.log('POSTGRES_QUEUE_EMPTY');
    return false;
  }

  console.log(`POSTGRES_QUEUE_CLAIMED ${claimed.id} ${claimed.command_run_id} ${claimed.mission_type_key}`);
  const timer = setInterval(() => {
    heartbeat(claimed.id, 'GITHUB_WORKER_HEARTBEAT').catch(error => {
      console.error(`Heartbeat failed: ${error.message}`);
    });
  }, Math.max(30_000, Math.floor((LEASE_SECONDS * 1000) / 3)));

  try {
    const result = await executeJob(claimed);
    await heartbeat(claimed.id, 'GITHUB_WORKER_FINALIZING');
    await finish(claimed.id, true, {
      worker_id: WORKER_ID,
      github_run_id: process.env.GITHUB_RUN_ID || null,
      github_sha: process.env.GITHUB_SHA || null,
      result
    }, null);
    console.log(`POSTGRES_QUEUE_COMPLETED ${claimed.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish(claimed.id, false, {
      worker_id: WORKER_ID,
      github_run_id: process.env.GITHUB_RUN_ID || null,
      github_sha: process.env.GITHUB_SHA || null
    }, message).catch(finishError => console.error(`Finish RPC failed: ${finishError.message}`));
    console.error(`POSTGRES_QUEUE_FAILED ${claimed.id}: ${message}`);
    throw error;
  } finally {
    clearInterval(timer);
  }

  return true;
}

let processed = 0;
while (processed < MAX_JOBS) {
  const didWork = await processOne();
  if (!didWork) break;
  processed += 1;
}
console.log(`POSTGRES_QUEUE_WORKER_DONE processed=${processed}`);
