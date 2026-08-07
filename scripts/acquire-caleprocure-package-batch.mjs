import { mkdir, writeFile } from 'node:fs/promises';
import { acquireCandidate } from './caleprocure-batch/acquire.mjs';
import {
  ARTIFACT_ROOT,
  BATCH_ID,
  TARGET_COMPLETIONS,
  encode,
  loadCandidatePool,
  now,
  parseIdentifiers,
  rest,
} from './caleprocure-batch/runtime.mjs';

async function main() {
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  const candidates = await loadCandidatePool();

  const previous = await rest(
    'acquisition_raw_records',
    'GET',
    null,
    '?publisher_id=not.is.null&assignment_id=not.is.null&source_record_id=not.is.null&select=publisher_id,assignment_id,source_record_id&order=retrieval_timestamp.desc&limit=100',
  );
  const knownCalEprocureRecord = previous.find((record) => parseIdentifiers(record));
  if (!knownCalEprocureRecord) throw new Error('CALEPROCURE_ASSIGNMENT_OR_PUBLISHER_NOT_RESOLVED');

  const assignmentId = knownCalEprocureRecord.assignment_id;
  const publisherId = knownCalEprocureRecord.publisher_id;

  let command = (
    await rest('command_runs', 'GET', null, `?idempotency_key=eq.${encode(BATCH_ID)}&select=*&limit=1`)
  )[0];
  if (!command) {
    [command] = await rest('command_runs', 'POST', {
      idempotency_key: BATCH_ID,
      status: 'running',
      aadp_state: 'RUNNING',
      current_stage: 'PACKAGE_ACQUISITION',
      mission_type_key: 'CONTRACT_PACKAGE_ACQUISITION',
      mission_name: 'Cal eProcure Five Contract Package Batch',
      state_code: 'CA',
      assigned_agent: 'Cal eProcure Package Acquisition Agent',
      publisher_assignment_id: assignmentId,
      started_at: now(),
      last_activity_at: now(),
      execution_evidence: {
        batch_id: BATCH_ID,
        github_run_id: process.env.GITHUB_RUN_ID || null,
        repository_commit: process.env.GITHUB_SHA || null,
        candidate_source_record_ids: candidates.map((candidate) => candidate.source_record_id),
      },
    });
  }

  let run = (
    await rest('acquisition_runs', 'GET', null, `?command_run_id=eq.${command.id}&select=*&limit=1`)
  )[0];
  if (!run) {
    [run] = await rest('acquisition_runs', 'POST', {
      command_run_id: command.id,
      assignment_id: assignmentId,
      status: 'RUNNING',
      records_discovered: 0,
      records_acquired: 0,
      pages_processed: 0,
      retrieval_failures: 0,
      pagination_complete: false,
      started_at: now(),
      reconciliation_status: 'PENDING',
      qualification_status: 'PENDING',
      validation_status: 'PENDING',
      evidence: {
        batch_id: BATCH_ID,
        github_run_id: process.env.GITHUB_RUN_ID || null,
        repository_commit: process.env.GITHUB_SHA || null,
      },
    });
  }

  const results = [];
  const completed = [];

  for (const candidate of candidates) {
    if (completed.length >= TARGET_COMPLETIONS) break;

    let result;
    try {
      result = await acquireCandidate(candidate, run, assignmentId, publisherId);
    } catch (error) {
      result = {
        source_record_id: candidate.source_record_id,
        canonical_id: candidate.id,
        complete: false,
        quarantined: false,
        reason: error.message,
        official_manifest_count: 0,
        verified_downloaded_files: 0,
        stored_package_document_rows: 0,
        storage_objects: 0,
        unique_hashes: 0,
      };
    }

    results.push(result);
    if (result.complete) completed.push(result);

    await rest('acquisition_runs', 'PATCH', {
      records_discovered: results.length,
      records_acquired: completed.length,
      retrieval_failures: results.filter((item) => !item.complete).length,
      pages_processed: results.length,
      evidence: {
        batch_id: BATCH_ID,
        github_run_id: process.env.GITHUB_RUN_ID || null,
        repository_commit: process.env.GITHUB_SHA || null,
        results,
      },
    }, `?id=eq.${run.id}`);
  }

  const targetReached = completed.length === TARGET_COMPLETIONS;
  const failedCandidates = results.filter((item) => !item.complete);
  const terminal = now();

  await rest('acquisition_runs', 'PATCH', {
    status: targetReached ? 'COMPLETED' : completed.length ? 'PARTIALLY_COMPLETE' : 'FAILED',
    records_discovered: results.length,
    records_acquired: completed.length,
    retrieval_failures: failedCandidates.length,
    pagination_complete: true,
    reconciliation_status: targetReached ? 'MATCHED' : 'MISMATCH',
    validation_status: targetReached ? 'PASSED' : 'FAILED',
    completed_at: terminal,
    evidence: {
      batch_id: BATCH_ID,
      github_run_id: process.env.GITHUB_RUN_ID || null,
      repository_commit: process.env.GITHUB_SHA || null,
      results,
    },
  }, `?id=eq.${run.id}`);

  await rest('command_runs', 'PATCH', {
    status: targetReached ? 'completed' : completed.length ? 'completed_with_failures' : 'failed',
    aadp_state: targetReached ? 'COMPLETED' : completed.length ? 'PARTIALLY_COMPLETE' : 'FAILED',
    current_stage: 'PACKAGE_ACQUISITION_COMPLETED',
    records_discovered: results.length,
    records_acquired: completed.length,
    records_accepted: completed.length,
    records_rejected: failedCandidates.length,
    failure_count: failedCandidates.length,
    reconciliation_status: targetReached ? 'MATCHED' : 'MISMATCH',
    validation_status: targetReached ? 'PASSED' : 'FAILED',
    result_summary: `${completed.length} of ${TARGET_COMPLETIONS} Cal eProcure contract packages completed after ${results.length} candidate attempts.`,
    completed_at: terminal,
    last_activity_at: terminal,
  }, `?id=eq.${command.id}`);

  const allIncomplete = await rest(
    'state_contract_opportunities',
    'GET',
    null,
    '?source_platform=eq.caleprocure&is_latest_version=eq.true&status=eq.open&or=(package_status.is.null,package_status.neq.PACKAGE_COMPLETE)&select=id',
  );
  const eligibleRemaining = await rest(
    'state_contract_opportunities',
    'GET',
    null,
    '?source_platform=eq.caleprocure&is_latest_version=eq.true&status=eq.open&or=(package_status.is.null,package_status.in.(PACKAGE_NOT_STARTED,PACKAGE_DISCOVERED,PACKAGE_DOWNLOADING,PACKAGE_PARTIAL,PACKAGE_EXTRACTED))&select=id',
  );

  const evidence = {
    connect: 'CONNECTED',
    contracts_acquired: `${completed.length} / ${TARGET_COMPLETIONS}`,
    result: targetReached ? 'SUCCESS' : completed.length ? 'PARTIAL' : 'FAILED',
    batch_id: BATCH_ID,
    command_run_id: command.id,
    acquisition_run_id: run.id,
    completed_contracts: completed.map((item) => item.source_record_id),
    quarantined_contracts: failedCandidates
      .filter((item) => item.quarantined)
      .map((item) => ({ source_record_id: item.source_record_id, reason: item.reason })),
    failed_or_incomplete_contracts: failedCandidates.map((item) => ({
      source_record_id: item.source_record_id,
      reason: item.reason,
    })),
    candidates_attempted: results.length,
    documents_stored: results.reduce((sum, item) => sum + item.stored_package_document_rows, 0),
    storage_objects: results.reduce((sum, item) => sum + item.storage_objects, 0),
    unique_hashes: results.reduce((sum, item) => sum + item.unique_hashes, 0),
    remaining_open_incomplete_backlog: allIncomplete.length,
    remaining_eligible_backlog: eligibleRemaining.length,
    exact_blocker: targetReached
      ? 'NONE'
      : failedCandidates.map((item) => `${item.source_record_id}: ${item.reason}`).join(' | '),
    results,
  };

  await writeFile('caleprocure-package-batch-result.json', JSON.stringify(evidence, null, 2));
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(evidence)}\n`, resolve));
  process.exit(targetReached ? 0 : 1);
}

main().catch(async (error) => {
  const failure = {
    connect: 'FAILED',
    contracts_acquired: `0 / ${TARGET_COMPLETIONS}`,
    result: 'FAILED',
    batch_id: BATCH_ID,
    exact_blocker: error.message,
  };
  await writeFile('caleprocure-package-batch-result.json', JSON.stringify(failure, null, 2)).catch(() => null);
  process.stderr.write(`${error.stack || error.message}\n`, () => process.exit(1));
});
