import { db, header, parseBody, response, verifyDashboardToken } from './_shared/native-runtime.js';
import { normalizeRunOutcome, NOT_REPORTED } from './_shared/mission-reporting.js';

function authenticated(event) {
  const bearer = String(header(event, 'authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return bearer ? verifyDashboardToken(bearer) : null;
}

function contains(value, query) {
  return String(value || '').toLowerCase().includes(String(query || '').toLowerCase());
}

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!authenticated(event)) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  try {
    const [runs, reports] = await Promise.all([
      db('command_runs?select=id,mission_type_key,mission_name,state_code,status,started_at,completed_at,created_at,warning_count,failure_count,execution_evidence,report_reference&order=created_at.desc&limit=500'),
      db('mission_execution_reports?select=id,command_run_id,mission_type_key,report_version,report_state,report_hash,report_data,generated_at,finalized_at,amended_at&order=report_version.desc')
    ]);

    const latestByRun = new Map();
    for (const item of reports || []) {
      if (!latestByRun.has(String(item.command_run_id))) latestByRun.set(String(item.command_run_id), item);
    }

    let rows = (runs || []).map(run => {
      const stored = latestByRun.get(String(run.id));
      const metadata = stored?.report_data?.report_metadata || {};
      const publisher = stored?.report_data?.publisher_and_connector?.publisher_name ||
        run.execution_evidence?.publisher_name || NOT_REPORTED;
      const connector = stored?.report_data?.publisher_and_connector?.existing_baseline?.connector?.connector_key ||
        stored?.report_data?.publisher_and_connector?.current_run?.connector?.connector_key ||
        run.execution_evidence?.connector_key || NOT_REPORTED;
      return {
        report_id: metadata.report_id || NOT_REPORTED,
        run_id: run.id,
        mission_type_key: run.mission_type_key || NOT_REPORTED,
        mission: run.mission_name || NOT_REPORTED,
        publisher,
        connector,
        state: run.state_code || NOT_REPORTED,
        status: normalizeRunOutcome(run.status),
        authoritative_status: String(run.status || NOT_REPORTED).toUpperCase(),
        started: run.started_at || NOT_REPORTED,
        completed: run.completed_at || NOT_REPORTED,
        report_version: stored?.report_version || NOT_REPORTED,
        report_state: stored?.report_state || (normalizeRunOutcome(run.status) === 'DRAFT' ? 'DRAFT' : 'NOT GENERATED'),
        warnings: Number(run.warning_count || 0),
        failures: Number(run.failure_count || 0),
        final_determination: stored?.report_data?.final_acceptance_decision?.determination || NOT_REPORTED,
        certification: stored?.report_data?.publisher_and_connector?.existing_baseline?.connector?.acceptance_status || NOT_REPORTED,
        generated_at: stored?.generated_at || NOT_REPORTED,
        view_url: `/missions/?id=${encodeURIComponent(run.id)}`
      };
    });

    if (body.mission_type_key) rows = rows.filter(row => String(row.mission_type_key).toUpperCase() === String(body.mission_type_key).toUpperCase());
    if (body.state) rows = rows.filter(row => String(row.state).toUpperCase() === String(body.state).toUpperCase());
    if (body.status) rows = rows.filter(row => String(row.status).toUpperCase() === String(body.status).toUpperCase());
    if (body.run_id) rows = rows.filter(row => contains(row.run_id, body.run_id));
    if (body.publisher) rows = rows.filter(row => contains(row.publisher, body.publisher));
    if (body.connector) rows = rows.filter(row => contains(row.connector, body.connector));
    if (body.certification) rows = rows.filter(row => contains(row.certification, body.certification));
    if (body.warning_count !== undefined && body.warning_count !== '') rows = rows.filter(row => row.warnings >= Number(body.warning_count));
    if (body.failure_count !== undefined && body.failure_count !== '') rows = rows.filter(row => row.failures >= Number(body.failure_count));
    if (body.date_from) rows = rows.filter(row => new Date(row.started === NOT_REPORTED ? 0 : row.started) >= new Date(body.date_from));
    if (body.date_to) rows = rows.filter(row => new Date(row.started === NOT_REPORTED ? 0 : row.started) <= new Date(`${body.date_to}T23:59:59.999Z`));

    return response(200, {
      generated_at: new Date().toISOString(),
      total: rows.length,
      reports: rows.slice(0, 250)
    });
  } catch (error) {
    console.error('mission-reports failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
