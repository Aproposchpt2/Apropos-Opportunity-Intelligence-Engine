import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';
import { resolveConnector } from './_shared/acquisition-connectors/index.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
async function patchRun(id, values) { await db(`command_runs?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...values, last_activity_at: now() }) }); }
async function latestReadyAssignment(id) { return (await db(`publisher_assignments?publisher_id=eq.${encodeURIComponent(id)}&status=eq.READY&select=*&order=updated_at.desc&limit=1`))?.[0] || null; }

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  const body = parseBody(event), commandRunId = txt(body.command_run_id), stateCode = txt(body.state_code).toUpperCase(), publisherId = txt(body.publisher_id);
  if (!commandRunId || !/^[A-Z]{2}$/.test(stateCode) || !publisherId) return response(400, { error: 'command_run_id, state_code, and publisher_id are required.' });

  try {
    await patchRun(commandRunId, { status: 'running', aadp_state: 'RUNNING', current_stage: 'EAG_001_RESOLVING_CONNECTOR', progress_value: 10, validation_status: 'PENDING', result_summary: 'Resolving the publisher profile and production connector.' });
    const publisher = (await db(`publisher_registry?id=eq.${encodeURIComponent(publisherId)}&state_code=eq.${stateCode}&verified=eq.true&select=*`))?.[0];
    if (!publisher) throw new Error('The selected verified publisher was not found.');
    const assignment = await latestReadyAssignment(publisherId);
    if (!assignment) throw new Error('The selected publisher has no READY acquisition assignment.');
    const connector = resolveConnector({ publisher, assignment });
    if (typeof connector.verify !== 'function') throw new Error(`${connector.key} does not implement EAG-001 verify().`);
    const endpoint = txt(assignment.search_endpoint || publisher.search_endpoint || publisher.procurement_website || publisher.official_website);

    await patchRun(commandRunId, { current_stage: 'EAG_001_VERIFYING_SEARCH', progress_value: 25, result_summary: `${publisher.publisher_name}: verifying structured solicitation records.` });
    const report = await connector.verify({ endpoint, sampleSize: Number(body.sample_size || 10), onSample: async status => {
      const pct = 35 + Math.round((status.processed / Math.max(status.total, 1)) * 50);
      await patchRun(commandRunId, { current_stage: 'EAG_001_VERIFYING_DETAIL_RECORDS', progress_value: Math.min(85, pct), result_summary: `Detail verification: ${status.processed}/${status.total}; ${status.passed} passed.` });
    }});

    const certification = report.ready_for_acquisition ? 'CERTIFIED' : 'TESTING';
    await db('connector_acceptance_registry?on_conflict=publisher_id,connector_key,connector_version', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ publisher_id: publisher.id, connector_key: connector.key, connector_version: connector.version || '1.0.0', acceptance_status: certification, validation_status: report.ready_for_acquisition ? 'PASSED' : 'WARNING', reconciliation_status: report.pagination_status === 'PASS' ? 'MATCHED' : 'PARTIAL', publisher_reported_total: report.publisher_reported_total, records_acquired: report.records_parsed, acceptance_evidence: report, tested_at: now(), accepted_at: report.ready_for_acquisition ? now() : null, updated_at: now() })
    });
    await db(`publisher_registry?id=eq.${publisher.id}`, { method: 'PATCH', body: JSON.stringify({ configuration: { ...(publisher.configuration || {}), connector_key: connector.key, connector_version: connector.version || '1.0.0', certification_status: certification, last_verification_at: now(), eag_001: report }, updated_at: now() }) });

    const summary = `${publisher.publisher_name}: EAG-001 ${report.ready_for_acquisition ? 'PASS' : 'WARNING'}; ${report.records_parsed} structured records; detail sample ${report.detail_pages_successful}/${report.sample_size}; pagination ${report.pagination_status}; certification ${certification}.`;
    await patchRun(commandRunId, { status: 'completed', aadp_state: 'COMPLETED', current_stage: 'EAG_001_COMPLETED', progress_value: 100, records_discovered: report.records_parsed, records_acquired: 0, records_accepted: report.detail_pages_successful, records_rejected: report.failures, warning_count: report.ready_for_acquisition ? 0 : 1, action_required: !report.ready_for_acquisition, completed_at: now(), validation_status: report.ready_for_acquisition ? 'PASSED' : 'WARNING', result_summary: summary, execution_evidence: report });
    return response(200, { ok: true, command_run_id: commandRunId, publisher_name: publisher.publisher_name, connector_key: connector.key, certification_status: certification, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchRun(commandRunId, { status: 'failed', aadp_state: 'FAILED', current_stage: 'EAG_001_FAILED', progress_value: 100, failure_count: 1, action_required: true, completed_at: now(), validation_status: 'FAILED', result_summary: message }).catch(() => null);
    return response(500, { error: message });
  }
};
