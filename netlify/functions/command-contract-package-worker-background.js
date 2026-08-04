import { response, parseBody, requireDashboardAuth, db, header } from './_shared/native-runtime.js';
import { processPackageBatch } from './_shared/contract-package-engine.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
async function patchRun(id, values) {
  await db(`command_runs?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...values, last_activity_at: now() }) });
}
async function latestReadyAssignment(publisherId) {
  return (await db(`publisher_assignments?publisher_id=eq.${encodeURIComponent(publisherId)}&status=eq.READY&select=*&order=updated_at.desc&limit=1`))?.[0] || null;
}
async function latestAcquisitionRun(assignmentId) {
  return (await db(`acquisition_runs?assignment_id=eq.${encodeURIComponent(assignmentId)}&status=in.(COMPLETED,PARTIALLY_COMPLETE)&select=*&order=started_at.desc&limit=1`))?.[0] || null;
}
async function routePending(acquisitionRunId) {
  const totals = { claimed: 0, canonical_inserted: 0, duplicates: 0, extraction_required: 0, contact_required: 0, rejected: 0 };
  for (let pass = 0; pass < 20; pass++) {
    const result = await db('rpc/aadp_route_pending_raw_records', { method: 'POST', body: JSON.stringify({ p_batch_size: 500, p_acquisition_run_id: acquisitionRunId }) }) || {};
    for (const key of Object.keys(totals)) totals[key] += Number(result[key] || 0);
    if (!Number(result.claimed || 0)) break;
  }
  return totals;
}
async function packageStats(acquisitionRunId) {
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&select=package_status,match_readiness_status,package_document_count,package_extracted_count,package_failed_count`) || [];
  const stats = { total: rows.length, complete: 0, partial: 0, failed: 0, match_ready: 0, documents: 0, extracted: 0, document_failures: 0 };
  for (const row of rows) {
    if (row.package_status === 'PACKAGE_COMPLETE') stats.complete++;
    else if (row.package_status === 'PACKAGE_FAILED') stats.failed++;
    else if (row.package_status !== 'PACKAGE_NOT_STARTED') stats.partial++;
    if (row.match_readiness_status === 'MATCH_READY') stats.match_ready++;
    stats.documents += Number(row.package_document_count || 0);
    stats.extracted += Number(row.package_extracted_count || 0);
    stats.document_failures += Number(row.package_failed_count || 0);
  }
  return stats;
}

export const handler = async event => {
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  const body = parseBody(event);
  const commandRunId = txt(body.command_run_id);
  const publisherId = txt(body.publisher_id);
  const stateCode = txt(body.state_code).toUpperCase();
  const batchSize = Math.max(1, Math.min(Number(body.batch_size || 3), 8));
  if (!commandRunId || !publisherId || !/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'command_run_id, publisher_id, and state_code are required.' });

  try {
    const assignment = await latestReadyAssignment(publisherId);
    if (!assignment) throw new Error('The selected publisher has no READY acquisition assignment.');
    const acquisitionRun = body.acquisition_run_id
      ? (await db(`acquisition_runs?id=eq.${encodeURIComponent(body.acquisition_run_id)}&assignment_id=eq.${assignment.id}&select=*`))?.[0]
      : await latestAcquisitionRun(assignment.id);
    if (!acquisitionRun?.id) throw new Error('No completed acquisition run is available for package processing. Run Acquisition Discovery first.');

    await patchRun(commandRunId, {
      status: 'running', aadp_state: 'RUNNING', current_stage: 'CONTRACT_PACKAGE_ACQUISITION', progress_value: 10,
      result_summary: `Processing official solicitation packages in resumable batches of ${batchSize}.`, action_required: false
    });

    let processedThisInvocation = 0;
    const batch = await processPackageBatch({
      db,
      acquisitionRunId: acquisitionRun.id,
      batchSize,
      onRecord: async result => {
        processedThisInvocation++;
        const stats = await packageStats(acquisitionRun.id);
        const completed = stats.complete + stats.failed;
        const progress = Math.min(92, 10 + Math.round((completed / Math.max(stats.total, 1)) * 82));
        await patchRun(commandRunId, {
          current_stage: 'CONTRACT_PACKAGE_ACQUISITION',
          progress_value: progress,
          records_discovered: stats.total,
          records_acquired: stats.documents,
          records_accepted: stats.match_ready,
          warning_count: stats.partial + stats.failed,
          result_summary: `${result.source_record_id}: ${result.package_status}. Packages complete ${stats.complete}/${stats.total}; match-ready ${stats.match_ready}; documents stored ${stats.documents}.`
        });
      }
    });

    if (batch.remaining > 0) {
      const host = header(event, 'host');
      const password = header(event, 'x-dashboard-password');
      if (!host || !password) throw new Error('Internal continuation context is unavailable.');
      const continuation = await fetch(`https://${host}/.netlify/functions/command-contract-package-worker-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
        body: JSON.stringify({ command_run_id: commandRunId, publisher_id: publisherId, state_code: stateCode, acquisition_run_id: acquisitionRun.id, batch_size: batchSize })
      });
      if (!continuation.ok && continuation.status !== 202) throw new Error(`Package continuation dispatch failed (${continuation.status}).`);
      return response(202, { ok: true, command_run_id: commandRunId, acquisition_run_id: acquisitionRun.id, processed: processedThisInvocation, remaining: batch.remaining });
    }

    const qualification = await routePending(acquisitionRun.id);
    const stats = await packageStats(acquisitionRun.id);
    const warning = stats.partial > 0 || stats.failed > 0 || stats.document_failures > 0;
    const completedAt = now();
    const summary = `Complete Contract Packages: ${stats.complete}/${stats.total} complete; ${stats.match_ready} match-ready; ${stats.documents} official files preserved; ${stats.extracted} documents extracted; ${stats.failed} package failures; ${stats.partial} partial packages.`;
    await db(`acquisition_runs?id=eq.${acquisitionRun.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        qualification_status: warning ? 'PARTIAL' : 'COMPLETED',
        validation_status: warning ? 'WARNING' : 'PASSED',
        evidence: { ...(acquisitionRun.evidence || {}), complete_contract_packages: stats, package_qualification: qualification, completed_at: completedAt }
      })
    });
    await patchRun(commandRunId, {
      status: 'completed', aadp_state: 'COMPLETED', current_stage: 'CONTRACT_PACKAGE_COMPLETED', progress_value: 100,
      records_discovered: stats.total, records_acquired: stats.documents, records_accepted: stats.match_ready, records_rejected: stats.failed,
      warning_count: warning ? stats.partial + stats.failed : 0, failure_count: 0, action_required: warning,
      completed_at: completedAt, validation_status: warning ? 'WARNING' : 'PASSED', qualification_status: warning ? 'PARTIAL' : 'COMPLETED',
      result_summary: summary,
      execution_evidence: { acquisition_run_id: acquisitionRun.id, publisher_id: publisherId, package_stats: stats, qualification }
    });
    return response(200, { ok: true, command_run_id: commandRunId, acquisition_run_id: acquisitionRun.id, stats, qualification });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('command-contract-package-worker-background failed', error);
    await patchRun(commandRunId, { status: 'failed', aadp_state: 'FAILED', current_stage: 'CONTRACT_PACKAGE_FAILED', progress_value: 100, failure_count: 1, action_required: true, completed_at: now(), validation_status: 'FAILED', result_summary: message }).catch(() => null);
    return response(500, { error: message });
  }
};
