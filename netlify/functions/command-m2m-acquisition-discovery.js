import { randomUUID } from 'node:crypto';
import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();

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

    if (!/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Valid state_code is required.' });
    if (!countyName) return response(400, { error: 'county_name is required.' });
    if (!publisherId) return response(400, { error: 'publisher_id is required.' });

    const publisher = (await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${encodeURIComponent(stateCode)}&county_name=eq.${encodeURIComponent(countyName)}&select=id,publisher_name,state_code,county_name,county_fips,machine_to_machine_supported,acquisition_method,search_endpoint,procurement_website,official_website,configuration`))?.[0];

    if (!publisher) return response(404, { error: 'Selected M2M publisher was not found in the selected county.' });

    const configuration = publisher.configuration && typeof publisher.configuration === 'object' ? publisher.configuration : {};
    const machineToMachine = publisher.machine_to_machine_supported === true || configuration.machine_to_machine_supported === true;
    if (!machineToMachine) return response(409, { error: `${publisher.publisher_name} is not classified as a machine-to-machine publisher.`, code: 'M2M_REQUIRED' });

    const createdAt = now();
    const missionName = `M2M Acquisition Discovery — ${stateCode} — ${countyName} — Publisher ${publisher.publisher_name}`;
    const missionConfig = {
      source: 'EXECUTIVE_COMMAND_CENTER',
      runtime: 'SUPABASE_POSTGRES',
      operator_authorized: true,
      publisher_scope: 'SINGLE',
      publisher_id: publisher.id,
      publisher_name: publisher.publisher_name,
      county_name: countyName,
      county_fips: countyFips || publisher.county_fips || null,
      geographic_scope: 'COUNTY',
      machine_to_machine_supported: true,
      discovery_gate: 'M2M_CLASSIFICATION_ONLY',
      publisher_approval_required: false,
      publisher_certification_required: false,
      verified_required: false,
      ready_status_required: false,
      endpoint_prevalidation_required: false,
      authentication_prevalidation_required: false,
      execution_model: 'PUBLISHER_ADAPTER_DISPATCH',
      dispatch_model: 'SUPABASE_POSTGRES_QUEUE',
      acquisition_method_hint: publisher.acquisition_method || null,
      search_endpoint_hint: publisher.search_endpoint || publisher.procurement_website || publisher.official_website || null,
      assigned_agent_source: 'SYSTEM_STATIC_CONFIGURATION'
    };

    const runRows = await db('command_runs', {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: `ecc:ACQUISITION_DISCOVERY:${stateCode}:SINGLE:${publisher.id}:${randomUUID()}`,
        status: 'queued',
        current_stage: 'POSTGRES_EXECUTION_REQUESTED',
        aadp_state: 'QUEUED',
        mission_type_key: 'ACQUISITION_DISCOVERY',
        mission_name: missionName,
        state_code: stateCode,
        assigned_agent: 'Acquisition Operations',
        started_at: createdAt,
        last_activity_at: createdAt,
        progress_mode: 'STAGE',
        progress_value: 5,
        execution_evidence: missionConfig
      })
    });

    const run = runRows?.[0];
    if (!run?.id) throw new Error('M2M Acquisition Discovery command run creation failed.');

    const missionRows = await db('command_missions', {
      method: 'POST',
      body: JSON.stringify({
        mission_type_key: 'ACQUISITION_DISCOVERY',
        mission_name: missionName,
        state_code: stateCode,
        assigned_agent: 'Acquisition Operations',
        authorization_state: 'AUTHORIZED',
        authorization_required: true,
        authorized_at: createdAt,
        command_run_id: run.id,
        mission_config: missionConfig
      })
    });

    return response(202, {
      mission: missionRows?.[0] || null,
      run,
      execution: {
        runtime: 'SUPABASE_POSTGRES',
        worker: 'GITHUB_ACTIONS',
        dispatch_status: 'QUEUED',
        assigned_agent: 'Acquisition Operations',
        publisher_scope: 'SINGLE',
        publisher_id: publisher.id,
        discovery_gate: 'M2M_CLASSIFICATION_ONLY',
        certification_required: false,
        approval_required: false
      }
    });
  } catch (error) {
    console.error('command-m2m-acquisition-discovery failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};