import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureAttachment, openEvent, resetAttachmentModal } from './browser.mjs';
import {
  ARTIFACT_ROOT,
  BATCH_ID,
  MAX_SESSION_ATTEMPTS,
  STORAGE_BUCKET,
  SUPABASE_URL,
  authHeaders,
  contentType,
  digest,
  encode,
  now,
  relayUrl,
  rest,
  safeFilename,
  uploadAndVerify,
} from './runtime.mjs';

async function checkpoint(run, raw, target, manifest, status = 'PACKAGE_DISCOVERED', error = null) {
  const stored = manifest.filter((item) => item.retrieval_status === 'STORED').length;
  const failed = manifest.filter((item) => item.status === 'FAILED_ATTEMPT').length;
  const detailStatus = status === 'PACKAGE_COMPLETE' ? 'COMPLETE' : status === 'PACKAGE_FAILED' ? 'FAILED' : 'IN_PROGRESS';

  await rest('aadp_document_manifests', 'POST', {
    acquisition_run_id: run.id,
    raw_record_id: raw.id,
    source_record_id: target.source_record_id,
    manifest,
    document_count: manifest.length,
    package_status: status,
    storage_document_count: stored,
    extracted_document_count: 0,
    failed_document_count: failed,
    updated_at: now(),
  }, '?on_conflict=acquisition_run_id,raw_record_id');

  await rest('acquisition_raw_records', 'PATCH', {
    raw_payload: {
      business_unit: target.businessUnit,
      auc_id: target.eventId,
      relay_url: relayUrl(target),
      manifest,
    },
    document_manifest_count: manifest.length,
    package_status: status,
    package_document_count: stored,
    package_failed_count: status === 'PACKAGE_FAILED' ? MAX_SESSION_ATTEMPTS : failed,
    detail_retrieved_at: now(),
    detail_retrieval_status: detailStatus,
    detail_retrieval_error: error,
    match_readiness_status: status === 'PACKAGE_COMPLETE'
      ? 'BLOCKED_REQUIREMENTS_INCOMPLETE'
      : status === 'PACKAGE_FAILED'
        ? 'REVIEW_REQUIRED'
        : 'BLOCKED_PACKAGE_INCOMPLETE',
  }, `?id=eq.${raw.id}`);
}

async function quarantineCandidate(target, raw, run, manifest, error) {
  const timestamp = now();
  await checkpoint(run, raw, target, manifest, 'PACKAGE_FAILED', error);
  await rest('state_contract_opportunities', 'PATCH', {
    package_status: 'PACKAGE_FAILED',
    package_failed_count: MAX_SESSION_ATTEMPTS,
    package_last_checked_at: timestamp,
    match_readiness_status: 'REVIEW_REQUIRED',
    raw_source_payload: {
      live_package_batch_failure: {
        batch_id: BATCH_ID,
        acquisition_run_id: run.id,
        failed_at: timestamp,
        error,
        session_attempts: MAX_SESSION_ATTEMPTS,
      },
    },
  }, `?id=eq.${target.id}`);
}

export async function acquireCandidate(target, run, assignmentId, publisherId) {
  const directory = path.join(ARTIFACT_ROOT, safeFilename(target.source_record_id));
  const filesDirectory = path.join(directory, 'official-files');
  await mkdir(filesDirectory, { recursive: true });

  const fingerprint = digest(Buffer.from(`CALEPROCURE|${target.businessUnit}|${target.eventId}`));
  let raw = (await rest('acquisition_raw_records', 'GET', null,
    `?acquisition_run_id=eq.${run.id}&source_record_id=eq.${encode(target.source_record_id)}&select=*&limit=1`))[0];

  if (!raw) {
    [raw] = await rest('acquisition_raw_records', 'POST', {
      acquisition_run_id: run.id,
      assignment_id: assignmentId,
      publisher_id: publisherId,
      source_record_id: target.source_record_id,
      source_url: relayUrl(target),
      raw_payload: { business_unit: target.businessUnit, auc_id: target.eventId, manifest: [] },
      retrieval_timestamp: now(),
      source_fingerprint: fingerprint,
      content_fingerprint: fingerprint,
      source_version: 'live-batch-2',
      processing_status: 'RAW',
      canonical_opportunity_id: target.id,
      detail_retrieval_status: 'IN_PROGRESS',
      package_status: 'PACKAGE_DISCOVERED',
      match_readiness_status: 'BLOCKED_PACKAGE_INCOMPLETE',
    });
  }

  const manifestRecord = (await rest('aadp_document_manifests', 'GET', null,
    `?acquisition_run_id=eq.${run.id}&raw_record_id=eq.${raw.id}&select=manifest&limit=1`))[0];
  let manifest = Array.isArray(manifestRecord?.manifest) ? manifestRecord.manifest : [];
  let officialNames = null;
  let lastError = null;
  const events = [];

  for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt += 1) {
    let session;
    try {
      session = await openEvent(target, events);
      officialNames = session.names;

      for (let index = 0; index < officialNames.length; index += 1) {
        const expectedName = officialNames[index];
        const alreadyStored = manifest.find((item) => item.index === index && item.status === 'DOWNLOADED' && item.retrieval_status === 'STORED');
        if (alreadyStored) continue;

        try {
          const { body, record } = await captureAttachment({
            page: session.page,
            context: session.context,
            index,
            expectedName,
            filesDirectory,
          });
          const storagePath = `caleprocure/${target.id}/${target.eventId}/${record.sha256}/${record.filename}`;
          await uploadAndVerify(storagePath, body, contentType(record.filename));

          const permanentRecord = {
            ...record,
            storage_bucket: STORAGE_BUCKET,
            storage_path: storagePath,
            retrieval_status: 'STORED',
            extraction_status: 'NOT_STARTED',
          };

          await rest('contract_package_documents', 'POST', {
            acquisition_run_id: run.id,
            raw_record_id: raw.id,
            publisher_id: publisherId,
            canonical_opportunity_id: target.id,
            source_record_id: target.source_record_id,
            source_url: record.source_url,
            final_url: record.source_url,
            storage_bucket: STORAGE_BUCKET,
            storage_path: storagePath,
            original_filename: record.filename,
            document_type: record.addendum_like ? 'ADDENDUM' : 'SOLICITATION',
            mime_type: contentType(record.filename),
            file_extension: path.extname(record.filename),
            byte_size: body.length,
            sha256: record.sha256,
            is_addendum: Boolean(record.addendum_like),
            is_amendment: Boolean(record.addendum_like),
            is_current: true,
            retrieval_status: 'STORED',
            extraction_status: 'NOT_STARTED',
            extracted_char_count: 0,
            retrieval_attempt_count: attempt,
            last_error: null,
            retrieved_at: now(),
            metadata: {
              manifest_index: index,
              integrity: record.integrity,
              acquisition_method: record.method,
            },
          }, '?on_conflict=raw_record_id,source_url');

          manifest = manifest.filter((item) => item.index !== index);
          manifest.push(permanentRecord);
          manifest.sort((a, b) => a.index - b.index);
          await checkpoint(run, raw, target, manifest);
          await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
          await resetAttachmentModal(session.page);
        } catch (error) {
          lastError = error;
          manifest = manifest.filter((item) => item.index !== index);
          manifest.push({
            index,
            expected_name: expectedName,
            status: 'FAILED_ATTEMPT',
            session_attempt: attempt,
            error: error.message,
          });
          manifest.sort((a, b) => a.index - b.index);
          await checkpoint(run, raw, target, manifest, 'PACKAGE_PARTIAL', error.message);
          throw error;
        }
      }

      await session.browser.close().catch(() => null);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      events.push({ type: 'session-attempt-failed', session_attempt: attempt, error: error.message });
      await session?.browser?.close().catch(() => null);
    }
  }

  const officialCount = officialNames?.length || 0;
  const rows = await rest('contract_package_documents', 'GET', null,
    `?canonical_opportunity_id=eq.${target.id}&retrieval_status=eq.STORED&select=id,sha256,storage_path,byte_size`);
  const batchRows = rows.filter((row) => manifest.some((item) => item.storage_path === row.storage_path));
  const uniqueHashes = new Set(batchRows.map((row) => row.sha256));

  let storageObjects = 0;
  for (const row of batchRows) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${row.storage_path.split('/').map(encode).join('/')}`, { headers: authHeaders });
    if (response.ok) storageObjects += 1;
  }

  const downloadedCount = manifest.filter((item) => item.status === 'DOWNLOADED' && item.retrieval_status === 'STORED').length;
  const complete = officialCount > 0 &&
    officialCount === downloadedCount &&
    officialCount === batchRows.length &&
    officialCount === storageObjects &&
    officialCount === uniqueHashes.size;

  if (complete) {
    const timestamp = now();
    await checkpoint(run, raw, target, manifest, 'PACKAGE_COMPLETE');
    await rest('state_contract_opportunities', 'PATCH', {
      package_status: 'PACKAGE_COMPLETE',
      package_document_count: officialCount,
      package_extracted_count: 0,
      package_failed_count: 0,
      requirements_extraction_status: 'NOT_STARTED',
      match_readiness_status: 'BLOCKED_REQUIREMENTS_INCOMPLETE',
      package_manifest: manifest,
      package_completed_at: timestamp,
      package_last_checked_at: timestamp,
      document_urls: manifest.map((item) => ({
        storage_bucket: STORAGE_BUCKET,
        storage_path: item.storage_path,
        sha256: item.sha256,
        filename: item.filename,
      })),
      raw_source_payload: {
        live_package_batch: {
          batch_id: BATCH_ID,
          acquisition_run_id: run.id,
          completed_at: timestamp,
        },
      },
    }, `?id=eq.${target.id}`);
  } else {
    const failureReason = lastError?.message ||
      `RECONCILIATION_MISMATCH manifest=${officialCount} downloaded=${downloadedCount} rows=${batchRows.length} storage=${storageObjects} hashes=${uniqueHashes.size}`;
    await quarantineCandidate(target, raw, run, manifest, failureReason);
  }

  await writeFile(path.join(directory, 'events.json'), JSON.stringify(events, null, 2));
  return {
    source_record_id: target.source_record_id,
    canonical_id: target.id,
    official_manifest_count: officialCount,
    verified_downloaded_files: downloadedCount,
    stored_package_document_rows: batchRows.length,
    storage_objects: storageObjects,
    unique_hashes: uniqueHashes.size,
    complete,
    quarantined: !complete,
    reason: complete ? null : lastError?.message ||
      `RECONCILIATION_MISMATCH manifest=${officialCount} downloaded=${downloadedCount} rows=${batchRows.length} storage=${storageObjects} hashes=${uniqueHashes.size}`,
  };
}
