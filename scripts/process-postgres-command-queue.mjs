import { createHash, randomUUID } from 'node:crypto';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const WORKER_ID = process.env.POSTGRES_QUEUE_WORKER_ID || `github-actions:${process.env.GITHUB_RUN_ID || randomUUID()}`;
const LEASE_SECONDS = Number(process.env.POSTGRES_QUEUE_LEASE_SECONDS || 900);
const MAX_JOBS = Math.max(1, Math.min(10, Number(process.env.POSTGRES_QUEUE_MAX_JOBS || 1)));
const SUPPORTED_STATES = new Set(['CA', 'NV', 'AZ']);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

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

async function dbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function firstRow(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value && typeof value === 'object' ? value : null;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

async function heartbeat(queueId, stage) {
  return rpc('heartbeat_command_execution', { p_queue_id: queueId, p_worker_id: WORKER_ID, p_lease_seconds: LEASE_SECONDS, p_stage: stage });
}

async function finish(queueId, success, result = {}, error = null) {
  return rpc('finish_command_execution', { p_queue_id: queueId, p_worker_id: WORKER_ID, p_success: success, p_result: result, p_error: error });
}

async function resolvePublisherAdapter(publisherId) {
  const publishers = await dbGet(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&select=id,publisher_name,state_code,acquisition_method,search_endpoint,procurement_website,configuration`);
  const publisher = firstRow(publishers);
  if (!publisher) throw new Error(`Publisher ${publisherId} was not found.`);

  const assignments = await dbGet(`publisher_assignments?publisher_id=eq.${encodeURIComponent(publisherId)}&status=eq.READY&select=*&order=updated_at.desc&limit=1`);
  const assignment = firstRow(assignments);
  if (!assignment) throw new Error(`Publisher ${publisherId} has no READY acquisition assignment.`);

  const params = asObject(assignment.search_parameters);
  const connection = { ...asObject(publisher.configuration), ...asObject(params.connection_config) };
  const method = String(assignment.acquisition_method || connection.access_method || publisher.acquisition_method || '').toUpperCase();
  const endpoint = String(assignment.search_endpoint || connection.primary_endpoint || publisher.search_endpoint || publisher.procurement_website || '').trim();
  const platform = String(connection.procurement_platform || params.procurement_platform || '').trim();
  const browserRequired = params.browser_automation_required === true || connection.browser_automation_required === true || params.javascript_required === true || params.stateful_session_required === true;

  let adapterKey = 'DIRECT_HTTP';
  if (/caleprocure/i.test(`${endpoint} ${platform}`)) adapterKey = 'CALEPROCURE_PLAYWRIGHT';
  else if (browserRequired) adapterKey = 'BROWSER_PUBLIC_SEARCH';
  else if (method === 'API') adapterKey = 'API';

  return { adapterKey, publisher, assignment, endpoint, platform, browserRequired, method };
}

async function createBrowserBridge(profile) {
  if (!['BROWSER_PUBLIC_SEARCH', 'CALEPROCURE_PLAYWRIGHT'].includes(profile.adapterKey)) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 APROPOS-APIE/1.0' });
  const endpointHost = (() => { try { return new URL(profile.endpoint).hostname; } catch { return ''; } })();
  return {
    async fetch(url, init = {}) {
      const method = String(init?.method || 'GET').toUpperCase();
      let parsed;
      try { parsed = new URL(url); } catch { return null; }
      if (method !== 'GET' || !/^https?:$/.test(parsed.protocol) || parsed.hostname !== endpointHost || /\.pdf(?:$|\?)/i.test(parsed.href)) return null;
      const page = await context.newPage();
      try {
        const response = await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(1500);
        return new Response(await page.content(), { status: response?.status() || 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      } finally { await page.close().catch(() => null); }
    },
    async close() { await context.close().catch(() => null); await browser.close().catch(() => null); }
  };
}

function normalizeRawPayloadState(body, stateCode) {
  const rows = Array.isArray(body) ? body : [body];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    row.raw_payload = { ...asObject(row.raw_payload), state_code: stateCode, __authoritative_state_code: stateCode };
  }
  return Array.isArray(body) ? rows : rows[0];
}

function installAcquisitionCompatibilityFetch({ stateCode, browserBridge }) {
  const nativeFetch = globalThis.fetch;
  const acquisitionRunIds = [];
  globalThis.fetch = async (input, init = {}) => {
    let url = typeof input === 'string' ? input : input?.url;
    let nextInit = init;
    if (typeof url === 'string' && browserBridge && !url.startsWith(SUPABASE_URL)) {
      const browserResponse = await browserBridge.fetch(url, nextInit).catch(() => null);
      if (browserResponse) return browserResponse;
    }
    if (typeof url === 'string' && url.includes('/rest/v1/acquisition_raw_records?')) {
      const parsed = new URL(url);
      if (parsed.searchParams.get('on_conflict') === 'publisher_id,source_record_id,source_fingerprint') {
        parsed.searchParams.set('on_conflict', 'acquisition_run_id,publisher_id,source_record_id,source_fingerprint');
        url = parsed.toString();
      }
      try {
        const body = nextInit?.body ? JSON.parse(nextInit.body) : null;
        if (body) nextInit = { ...nextInit, body: JSON.stringify(normalizeRawPayloadState(body, stateCode)) };
      } catch {}
    }
    if (typeof url === 'string' && url.includes('/rest/v1/rpc/aadp_route_pending_raw_records')) {
      try {
        const body = nextInit?.body ? JSON.parse(nextInit.body) : {};
        if (!Object.prototype.hasOwnProperty.call(body, 'p_acquisition_run_id')) {
          if (acquisitionRunIds.length !== 1) throw new Error(`Qualification routing requires exactly one acquisition run; observed ${acquisitionRunIds.length}.`);
          nextInit = { ...nextInit, body: JSON.stringify({ ...body, p_acquisition_run_id: acquisitionRunIds[0] }) };
        }
      } catch (error) {
        if (error instanceof Error && /Qualification routing requires/.test(error.message)) throw error;
      }
    }
    const response = await nativeFetch(url || input, nextInit);
    if (typeof url === 'string' && url.includes('/rest/v1/acquisition_runs') && String(nextInit?.method || 'GET').toUpperCase() === 'POST' && response.ok) {
      try {
        const payload = await response.clone().json();
        for (const row of Array.isArray(payload) ? payload : [payload]) if (row?.id && !acquisitionRunIds.includes(row.id)) acquisitionRunIds.push(row.id);
      } catch {}
    }
    return response;
  };
  return () => { globalThis.fetch = nativeFetch; };
}

async function runAcquisitionDiscovery(job) {
  const payload = job.payload || {};
  const evidence = payload.execution_evidence || {};
  const commandRunId = job.command_run_id;
  const queueId = job.queue_id;
  const stateCode = String(payload.state_code || evidence.state_code || '').toUpperCase();
  const publisherScope = String(evidence.publisher_scope || payload.publisher_scope || 'ALL').toUpperCase();
  const publisherId = evidence.publisher_id || payload.publisher_id || null;
  if (!queueId || !commandRunId || !SUPPORTED_STATES.has(stateCode)) throw new Error('Queued acquisition discovery job is missing queue_id/command_run_id or has an unsupported state_code.');
  if (publisherScope !== 'SINGLE' || !publisherId) throw new Error('PostgreSQL acquisition discovery requires an immutable SINGLE publisher scope and publisher_id.');

  const profile = await resolvePublisherAdapter(publisherId);
  if (String(profile.publisher.state_code || '').toUpperCase() !== stateCode) throw new Error(`Publisher state ${profile.publisher.state_code || 'UNKNOWN'} conflicts with mission state ${stateCode}.`);

  await heartbeat(queueId, `ADAPTER_${profile.adapterKey}_SELECTED`);
  const browserBridge = await createBrowserBridge(profile);
  const localPassword = `queue-${randomUUID()}`;
  process.env.EXECUTIVE_AUTH_HASH = createHash('sha256').update(localPassword).digest('hex');
  const restoreFetch = installAcquisitionCompatibilityFetch({ stateCode, browserBridge });
  try {
    const { handler } = await import('../netlify/functions/command-acquisition-worker-background.js');
    const event = { httpMethod: 'POST', headers: { 'x-dashboard-password': localPassword }, body: JSON.stringify({ command_run_id: commandRunId, state_code: stateCode, publisher_scope: 'SINGLE', publisher_id: publisherId }) };
    await heartbeat(queueId, `GITHUB_${profile.adapterKey}_RUNNING`);
    const response = await handler(event);
    const statusCode = Number(response?.statusCode || 500);
    let body = {};
    try { body = response?.body ? JSON.parse(response.body) : {}; } catch { body = { raw_body: response?.body || '' }; }
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Acquisition discovery worker returned HTTP ${statusCode}: ${JSON.stringify(body)}`);
    if (Number(body?.publishers_processed || 0) !== 1) throw new Error(`Single-publisher scope violated: worker processed ${body?.publishers_processed ?? 'unknown'} publishers.`);
    if (Number(body?.failures || 0) > 0 || body?.routing_result?.error) throw new Error(`Acquisition discovery completed with runtime defects: ${JSON.stringify({ failures: body?.failures || 0, failure_details: body?.failure_details || [], routing_result: body?.routing_result || {} })}`);
    return { status_code: statusCode, adapter_key: profile.adapterKey, publisher_id: publisherId, authoritative_state_code: stateCode, ...body };
  } finally {
    restoreFetch();
    await browserBridge?.close().catch(() => null);
  }
}

async function runPublisherDiscovery(job) {
  const payload = job.payload || {};
  const evidence = payload.execution_evidence || {};
  const commandRunId = job.command_run_id;
  const queueId = job.queue_id;
  const stateCode = String(payload.state_code || evidence.state_code || '').toUpperCase();
  const discoveryScope = String(evidence.discovery_scope || payload.execution_envelope?.discovery_scope || 'STATE_AND_LOCAL');
  if (!queueId || !commandRunId || !SUPPORTED_STATES.has(stateCode)) throw new Error('Queued publisher discovery job is missing queue_id/command_run_id or has an unsupported state_code.');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for GitHub publisher discovery execution.');

  const localPassword = `publisher-queue-${randomUUID()}`;
  const localChainToken = `publisher-chain-${randomUUID()}`;
  const localHost = 'publisher-discovery.local';
  process.env.EXECUTIVE_AUTH_HASH = createHash('sha256').update(localPassword).digest('hex');
  process.env.PUBLISHER_CHAIN_TOKEN = localChainToken;

  const nativeFetch = globalThis.fetch;
  let nextPayload = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url === `https://${localHost}/.netlify/functions/command-publisher-expansion-worker-background`) {
      try { nextPayload = init?.body ? JSON.parse(init.body) : null; } catch { nextPayload = null; }
      return new Response(JSON.stringify({ ok: true, local_dispatch: true }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return nativeFetch(input, init);
  };

  try {
    const { handler } = await import('../netlify/functions/command-publisher-expansion-worker-background.js');
    let currentPayload = { command_run_id: commandRunId, state_code: stateCode, discovery_scope: discoveryScope };
    let iterations = 0;
    while (iterations < 100) {
      iterations += 1;
      nextPayload = null;
      await heartbeat(queueId, `GITHUB_PUBLISHER_DISCOVERY_CHECKPOINT_${iterations}`);
      const response = await handler({
        httpMethod: 'POST',
        headers: { host: localHost, 'x-dashboard-password': localPassword, 'x-publisher-chain-token': localChainToken },
        body: JSON.stringify(currentPayload)
      });
      const statusCode = Number(response?.statusCode || 500);
      let body = {};
      try { body = response?.body ? JSON.parse(response.body) : {}; } catch { body = { raw_body: response?.body || '' }; }
      if (statusCode < 200 || statusCode >= 300) throw new Error(`Publisher discovery worker returned HTTP ${statusCode}: ${JSON.stringify(body)}`);

      const parent = firstRow(await dbGet(`command_runs?id=eq.${encodeURIComponent(commandRunId)}&select=id,status,current_stage,aadp_state,records_discovered,records_acquired,records_accepted,records_rejected,warning_count,failure_count,result_summary,execution_evidence`));
      if (body?.completed === true || ['completed', 'cancelled'].includes(String(parent?.status || '').toLowerCase())) {
        const discoveryRun = firstRow(await dbGet(`publisher_discovery_runs?command_run_id=eq.${encodeURIComponent(commandRunId)}&select=id,status,current_stage,publishers_presented,publishers_approved,official_sources_identified,evidence&order=created_at.desc&limit=1`).catch(() => []));
        return { status_code: statusCode, authoritative_state_code: stateCode, discovery_scope: discoveryScope, checkpoints_processed: iterations, command_run: parent, publisher_discovery_run: discoveryRun };
      }
      if (!nextPayload) throw new Error(`Publisher discovery checkpoint ${iterations} did not reach terminal state or provide the next checkpoint payload.`);
      currentPayload = nextPayload;
    }
    throw new Error('Publisher discovery exceeded the 100-checkpoint safety limit.');
  } finally { globalThis.fetch = nativeFetch; }
}

async function executeJob(job) {
  const missionType = String(job.mission_type_key || '').toUpperCase();
  switch (missionType) {
    case 'ACQUISITION_DISCOVERY': return runAcquisitionDiscovery(job);
    case 'PUBLISHER_DISCOVERY': return runPublisherDiscovery(job);
    default: throw new Error(`No GitHub PostgreSQL queue adapter is configured for mission type ${missionType || 'UNKNOWN'}.`);
  }
}

async function processOne() {
  await rpc('recover_expired_command_executions', {});
  const claimed = firstRow(await rpc('claim_next_command_execution', { p_worker_id: WORKER_ID, p_lease_seconds: LEASE_SECONDS }));
  if (!claimed) { console.log('POSTGRES_QUEUE_EMPTY'); return false; }
  if (!claimed.queue_id) throw new Error('Claim RPC returned a job without queue_id.');
  console.log(`POSTGRES_QUEUE_CLAIMED ${claimed.queue_id} ${claimed.command_run_id} ${claimed.mission_type_key}`);
  const timer = setInterval(() => {
    heartbeat(claimed.queue_id, 'GITHUB_WORKER_HEARTBEAT').catch(error => console.error(`Heartbeat failed: ${error.message}`));
  }, Math.max(30_000, Math.floor((LEASE_SECONDS * 1000) / 3)));
  try {
    const result = await executeJob(claimed);
    await heartbeat(claimed.queue_id, 'GITHUB_WORKER_FINALIZING');
    await finish(claimed.queue_id, true, { worker_id: WORKER_ID, github_run_id: process.env.GITHUB_RUN_ID || null, github_sha: process.env.GITHUB_SHA || null, result }, null);
    console.log(`POSTGRES_QUEUE_COMPLETED ${claimed.queue_id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish(claimed.queue_id, false, { worker_id: WORKER_ID, github_run_id: process.env.GITHUB_RUN_ID || null, github_sha: process.env.GITHUB_SHA || null }, message).catch(finishError => console.error(`Finish RPC failed: ${finishError.message}`));
    console.error(`POSTGRES_QUEUE_FAILED ${claimed.queue_id}: ${message}`);
    throw error;
  } finally { clearInterval(timer); }
  return true;
}

let processed = 0;
while (processed < MAX_JOBS) {
  const didWork = await processOne();
  if (!didWork) break;
  processed += 1;
}
console.log(`POSTGRES_QUEUE_WORKER_DONE processed=${processed}`);
