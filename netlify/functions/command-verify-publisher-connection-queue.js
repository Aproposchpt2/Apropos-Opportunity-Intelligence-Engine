import { randomUUID } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();

const approved = configuration => {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  return cfg.publisher_profile_approved === true
    && cfg.profile_complete === true
    && cfg.approved_for_operator_menu === true
    && txt(cfg.approval_status).toUpperCase() === 'APPROVED';
};

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const body = parseBody(event);
    const stateCode = txt(body.state_code).toUpperCase();
    const countyName = txt(body.county_name);
    const countyFips = txt(body.county_fips) || null;
    const publisherId = txt(body.publisher_id);
    if (!/^[A-Z]{2}$/.test(stateCode) || !countyName || !publisherId) {
      return response(400, { error: 'state_code, county_name, and publisher_id are required.' });
    }

    const publisher = (await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${stateCode}&county_name=eq.${encodeURIComponent(countyName)}&verified=eq.true&select=id,publisher_name,configuration`))?.[0];
    if (!publisher) return response(404, { error: 'Selected verified publisher profile was not found.' });
    const configuration = publisher.configuration && typeof publisher.configuration === 'object' ? publisher.configuration : {};
    if (!approved(configuration)) {
      return response(403, { error: `${publisher.publisher_name} is not approved for operator access. Complete the APROPOS Publisher Profile and approval review first.`, code: 'PUBLISHER_APPROVAL_REQUIRED' });
    }

    const createdAt = now();
    const missionName = `Verify Publisher Connection — ${stateCode} — ${countyName} — Publisher ${publisher.publisher_name}`;
    const missionConfig = {
      source: 'EXECUTIVE_COMMAND_CENTER',
      runtime: 'SUPABASE_POSTGRES',
      dispatch_model: 'SUPABASE_POSTGRES_QUEUE',
      worker_runtime: 'GITHUB_ACTIONS',
      execution_model: 'EAG_001_READ_ONLY',
      publisher_scope: 'SINGLE',
      publisher_id: publisher.id,
      publisher_name: publisher.publisher_name,
      county_name: countyName,
      county_fips: countyFips,
      geographic_scope: 'COUNTY',
      publisher_approval_required: true,
      checkpointed: true,
      operator_authorized: true,
      assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
    };

    const runRows = await db('command_runs', { method: 'POST', body: JSON.stringify({
      idempotency_key: `ecc:VERIFY_PUBLISHER_CONNECTION:${stateCode}:${publisher.id}:${randomUUID()}`,
      status: 'queued',
      current_stage: 'POSTGRES_EXECUTION_REQUESTED',
      aadp_state: 'QUEUED',
      mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
      mission_name: missionName,
      state_code: stateCode,
      assigned_agent: 'Publisher Engineering',
      started_at: createdAt,
      last_activity_at: createdAt,
      progress_mode: 'STAGE',
      progress_value: 5,
      validation_status: 'PENDING',
      execution_evidence: missionConfig
    }) });
    const run = runRows?.[0];
    if (!run?.id) throw new Error('Publisher verification command run creation failed.');

    const missionRows = await db('command_missions', { method: 'POST', body: JSON.stringify({
      mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
      mission_name: missionName,
      state_code: stateCode,
      assigned_agent: 'Publisher Engineering',
      authorization_state: 'AUTHORIZED',
      authorization_required: true,
      authorized_at: createdAt,
      command_run_id: run.id,
      mission_config: missionConfig
    }) });

    return response(202, {
      mission: missionRows?.[0] || null,
      run,
      execution: {
        runtime: 'SUPABASE_POSTGRES',
        worker: 'GITHUB_ACTIONS',
        dispatch_status: 'QUEUED',
        assigned_agent: 'Publisher Engineering',
        publisher_scope: 'SINGLE',
        publisher_id: publisher.id,
        execution_model: 'EAG_001_READ_ONLY'
      }
    });
  } catch (error) {
    console.error('command-verify-publisher-connection-queue failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
