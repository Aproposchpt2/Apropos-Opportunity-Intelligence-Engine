import { response, parseBody, requireDashboardAuth, db, header } from './_shared/native-runtime.js';
import { processPackageBatch } from './_shared/contract-package-engine.js';

const now = () => new Date().toISOString();
const txt = value => String(value ?? '').trim();
const ACTIVE_PACKAGE_STATUSES = 'PACKAGE_NOT_STARTED,PACKAGE_DISCOVERED,PACKAGE_REVALIDATION_REQUIRED';

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
function isLaCountyRow(row) {
  const source = txt(row.source_url);
  const platform = txt(row.raw_payload?.procurement_platform);
  return /camisvr\.co\.la\.ca\.us/i.test(source) || /Los Angeles County eCAPS/i.test(platform);
}
async function prepareLaCountyRows(acquisitionRunId) {
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&package_status=eq.PACKAGE_NOT_STARTED&select=id,source_url,raw_payload,document_manifest_count&limit=1000`) || [];
  let prepared = 0;
  for (const row of rows) {
    if (!isLaCountyRow(row)) continue;
    const payload = row.raw_payload || {};
    const urls = Array.isArray(payload.document_urls) && payload.document_urls.length ? payload.document_urls : [row.source_url].filter(Boolean);
    await db(`acquisition_raw_records?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        package_status: 'PACKAGE_DISCOVERED',
        document_manifest_count: Math.max(1, Number(row.document_manifest_count || 0)),
        raw_payload: { ...payload, document_urls: urls, __package_manifest_resolver: 'LA_COUNTY_ECAPS_ATTACHMENT_API' }
      })
    });
    prepared++;
  }
  return prepared;
}
async function synchronizePackageEvidence(result) {
  const raw = (await db(`acquisition_raw_records?id=eq.${encodeURIComponent(result.raw_record_id)}&select=id,processing_status,raw_payload,canonical_opportunity_id,package_status`))?.[0];
  if (!raw) return;
  const documentRows = await db(`contract_package_documents?raw_record_id=eq.${encodeURIComponent(raw.id)}&select=source_url,storage_bucket,storage_path,original_filename,document_type,mime_type,byte_size,sha256,version_label,is_addendum,is_amendment,retrieval_status,extraction_status&order=created_at.asc`) || [];
  const solicitation = (await db(`solicitation_documents?raw_record_id=eq.${encodeURIComponent(raw.id)}&select=raw_text,requirements_matrix,document_manifest,package_status,requirements_extracted_at&limit=1`))?.[0] || null;
  const sourceUrls = [...new Set(documentRows.map(row => row.source_url).filter(Boolean))];
  const manifest = documentRows.map(row => ({
    source_url: row.source_url,
    storage_bucket: row.storage_bucket,
    storage_path: row.storage_path,
    filename: row.original_filename,
    document_type: row.document_type,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    version_label: row.version_label,
    is_addendum: row.is_addendum,
    is_amendment: row.is_amendment,
    retrieval_status: row.retrieval_status,
    extraction_status: row.extraction_status
  }));
  const packageComplete = result.package_status === 'PACKAGE_COMPLETE';
  const terminalRawStatus = packageComplete ? 'PACKAGE_COMPLETE' : 'PACKAGE_EXTRACTED';
  const payload = {
    ...(raw.raw_payload || {}),
    document_urls: sourceUrls,
    document_manifest: manifest,
    requirements_text: solicitation?.raw_text || raw.raw_payload?.requirements_text || null,
    requirements: solicitation?.requirements_matrix || raw.raw_payload?.requirements || null,
    __package_extraction: {
      status: result.package_status,
      terminal_raw_status: terminalRawStatus,
      requirements_extraction_status: result.requirements_extraction_status || null,
      document_count: result.document_count || documentRows.length,
      stored_count: result.stored_count || 0,
      extracted_count: result.extracted_count || 0,
      failed_count: result.failed_count || 0,
      requirements_char_count: result.requirements_char_count || 0,
      synchronized_at: now()
    }
  };
  const rawPatch = { package_status: terminalRawStatus, raw_payload: payload };
  if (packageComplete && raw.processing_status === 'EXTRACTION_REQUIRED') rawPatch.processing_status = 'RAW';
  await db(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', body: JSON.stringify(rawPatch) });
  if (raw.canonical_opportunity_id) {
    await db(`state_contract_opportunities?id=eq.${encodeURIComponent(raw.canonical_opportunity_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ document_urls: sourceUrls, package_manifest: manifest, package_last_checked_at: now(), updated_at: now() })
    });
  }
}
async function remainingUnprocessed(acquisitionRunId) {
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&package_status=in.(${ACTIVE_PACKAGE_STATUSES})&select=id,source_url,raw_payload,document_manifest_count&limit=1000`) || [];
  return rows.filter(row => Number(row.document_manifest_count || 0) > 0 || Array.isArray(row.raw_payload?.document_urls) || isLaCountyRow(row)).length;
}
async function packageStats(acquisitionRunId) {
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&select=package_status,match_readiness_status,package_document_count,package_extracted_count,package_failed_count`) || [];
  const stats = { total: rows.length, pending: 0, processed: 0, complete: 0, partial: 0, failed: 0, match_ready: 0, documents: 0, extracted: 0, document_failures: 0 };
  for (const row of rows) {
    if (['PACKAGE_NOT_STARTED', 'PACKAGE_DISCOVERED', 'PACKAGE_DOWNLOADING', 'PACKAGE_REVALIDATION_REQUIRED'].includes(row.package_status)) stats.pending++;
    else stats.processed++;
    if (row.package_status === 'PACKAGE_COMPLETE') stats.complete++;
    else if (row.package_status === 'PACKAGE_FAILED') stats.failed++;
    else if (!['PACKAGE_NOT_STARTED', 'PACKAGE_DISCOVERED', 'PACKAGE_DOWNLOADING', 'PACKAGE_REVALIDATION_REQUIRED'].includes(row.package_status)) stats.partial++;
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

    const prepared = await prepareLaCountyRows(acquisitionRun.id);
    await patchRun(commandRunId, {
      status: 'running', aadp_state: 'RUNNING', current_stage: 'CONTRACT_PACKAGE_ACQUISITION', progress_value: 10,
      result_summary: `Processing official solicitation packages in resumable batches of ${batchSize}.${prepared ? ` ${prepared} LA County records prepared from the official attachment interface.` : ''}`,
      action_required: false
    });

    let processedThisInvocation = 0;
    await processPackageBatch({
      db,
      acquisitionRunId: acquisitionRun.id,
      batchSize,
      onRecord: async result => {
        processedThisInvocation++;
        await synchronizePackageEvidence(result);
        const stats = await packageStats(acquisitionRun.id);
        const progress = Math.min(92, 10 + Math.round((stats.processed / Math.max(stats.total, 1)) * 82));
        await patchRun(commandRunId, {
          current_stage: 'CONTRACT_PACKAGE_ACQUISITION',
          progress_value: progress,
          records_discovered: stats.total,
          records_acquired: stats.documents,
          records_accepted: stats.match_ready,
          warning_count: stats.partial + stats.failed,
          result_summary: `${result.source_record_id}: ${result.package_status}. Processed ${stats.processed}/${stats.total}; packages complete ${stats.complete}; match-ready ${stats.match_ready}; official files preserved ${stats.documents}.`
        });
      }
    });

    const remaining = await remainingUnprocessed(acquisitionRun.id);
    if (remaining > 0) {
      const host = header(event, 'host');
      const password = header(event, 'x-dashboard-password');
      if (!host || !password) throw new Error('Internal continuation context is unavailable.');
      const continuation = await fetch(`https://${host}/.netlify/functions/command-contract-package-worker-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
        body: JSON.stringify({ command_run_id: commandRunId, publisher_id: publisherId, state_code: stateCode, acquisition_run_id: acquisitionRun.id, batch_size: batchSize })
      });
      if (!continuation.ok && continuation.status !== 202) throw new Error(`Package continuation dispatch failed (${continuation.status}).`);
      return response(202, { ok: true, command_run_id: commandRunId, acquisition_run_id: acquisitionRun.id, processed: processedThisInvocation, remaining });
    }

    const qualification = await routePending(acquisitionRun.id);
    const stats = await packageStats(acquisitionRun.id);
    const warning = stats.partial > 0 || stats.failed > 0 || stats.document_failures > 0 || stats.pending > 0;
    const completedAt = now();
    const summary = `Complete Contract Packages: ${stats.complete}/${stats.total} complete; ${stats.match_ready} match-ready; ${stats.documents} official files preserved; ${stats.extracted} documents extracted; ${stats.document_failures} document failures; ${stats.partial} packages require review.`;
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
      warning_count: warning ? stats.partial + stats.failed + stats.document_failures : 0, failure_count: 0, action_required: warning,
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
