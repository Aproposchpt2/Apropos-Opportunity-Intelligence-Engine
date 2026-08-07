import { randomUUID } from 'node:crypto';
import {
  db,
  env,
  header,
  parseBody,
  response,
  verifyDashboardToken
} from './_shared/native-runtime.js';
import {
  attachReportHash,
  buildMissionReport,
  isTerminalOutcome,
  reportHash,
  resolveReportDefinition,
  NOT_REPORTED
} from './_shared/mission-reporting-hardening.js';

const enc = value => encodeURIComponent(String(value || ''));
const inFilter = values => `(${values.map(value => `"${String(value).replaceAll('"', '\\"')}"`).join(',')})`;

function authenticatedOperator(event) {
  const authorization = String(header(event, 'authorization') || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return bearer ? verifyDashboardToken(bearer) : null;
}

async function safeRead(name, request, readFailures, sourceStatus) {
  try {
    const rows = await db(request);
    sourceStatus.push({
      source: name,
      status: 'READ',
      records: Array.isArray(rows) ? rows.length : (rows ? 1 : 0)
    });
    return rows || [];
  } catch (error) {
    readFailures.push({ source: name, error: error instanceof Error ? error.message : String(error) });
    sourceStatus.push({ source: name, status: 'UNAVAILABLE', records: NOT_REPORTED });
    return [];
  }
}

async function loadContext(commandRunId) {
  const readFailures = [];
  const sourceStatus = [];
  const run = (await safeRead(
    'command_runs',
    `command_runs?id=eq.${enc(commandRunId)}&select=*`,
    readFailures,
    sourceStatus
  ))?.[0];
  if (!run) return { notFound: true, readFailures, sourceStatus };

  const [
    missions,
    commandStages,
    unifiedStages,
    tasks,
    events,
    failures,
    metrics,
    audit,
    existingReports,
    acquisitionRuns,
    discoveryRuns,
    scheduleRuns
  ] = await Promise.all([
    safeRead('command_missions', `command_missions?command_run_id=eq.${enc(commandRunId)}&select=*&order=created_at.desc&limit=1`, readFailures, sourceStatus),
    safeRead('command_stage_projection', `command_stage_projection?command_run_id=eq.${enc(commandRunId)}&select=*&order=sequence_number.asc`, readFailures, sourceStatus),
    safeRead('command_unified_stage_projection', `command_unified_stage_projection?command_run_id=eq.${enc(commandRunId)}&select=*&order=updated_at.asc`, readFailures, sourceStatus),
    safeRead('command_tasks', `command_tasks?run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures, sourceStatus),
    safeRead('command_events', `command_events?run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures, sourceStatus),
    safeRead('command_failures', `command_failures?run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures, sourceStatus),
    safeRead('command_metrics', `command_metrics?run_id=eq.${enc(commandRunId)}&select=*&order=recorded_at.asc`, readFailures, sourceStatus),
    safeRead('command_audit_log', `command_audit_log?command_run_id=eq.${enc(commandRunId)}&select=*&order=occurred_at.asc`, readFailures, sourceStatus),
    safeRead('executive_run_reports', `executive_run_reports?command_run_id=eq.${enc(commandRunId)}&select=*&order=generated_at.asc`, readFailures, sourceStatus),
    safeRead('acquisition_runs', `acquisition_runs?command_run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures, sourceStatus),
    safeRead('publisher_discovery_runs', `publisher_discovery_runs?command_run_id=eq.${enc(commandRunId)}&select=*&order=created_at.desc&limit=1`, readFailures, sourceStatus),
    safeRead('operations_schedule_runs', `operations_schedule_runs?command_run_id=eq.${enc(commandRunId)}&select=*&order=created_at.asc`, readFailures, sourceStatus)
  ]);

  const mission = missions[0] || null;
  const discovery = discoveryRuns[0] || null;
  const stages = commandStages.length
    ? commandStages.map(row => ({ ...row, __source: 'command_stage_projection' }))
    : unifiedStages.map(row => ({ ...row, __source: 'command_unified_stage_projection' }));

  let attempts = [];
  const taskIds = tasks.map(item => item.id).filter(Boolean);
  if (taskIds.length) attempts = await safeRead(
    'command_task_attempts',
    `command_task_attempts?task_id=in.${inFilter(taskIds)}&select=*&order=started_at.asc`,
    readFailures,
    sourceStatus
  );

  let candidates = [];
  if (discovery?.id) candidates = await safeRead(
    'publisher_discovery_candidates',
    `publisher_discovery_candidates?discovery_run_id=eq.${enc(discovery.id)}&select=*&order=created_at.asc`,
    readFailures,
    sourceStatus
  );

  const evidence = run.execution_evidence || {};
  const publisherId = evidence.publisher_id || mission?.mission_config?.publisher_id || null;
  const assignmentId = run.publisher_assignment_id || evidence.assignment_id ||
    mission?.mission_config?.assignment_id || acquisitionRuns[0]?.assignment_id || null;

  let assignment = null;
  if (assignmentId) assignment = (await safeRead(
    'publisher_assignments',
    `publisher_assignments?id=eq.${enc(assignmentId)}&select=*`,
    readFailures,
    sourceStatus
  ))?.[0] || null;

  const resolvedPublisherId = publisherId || assignment?.publisher_id || null;
  let publisher = null;
  let connectorRows = [];
  if (resolvedPublisherId) {
    [publisher, connectorRows] = await Promise.all([
      safeRead('publisher_registry', `publisher_registry?id=eq.${enc(resolvedPublisherId)}&select=*`, readFailures, sourceStatus)
        .then(rows => rows[0] || null),
      safeRead('connector_acceptance_registry', `connector_acceptance_registry?publisher_id=eq.${enc(resolvedPublisherId)}&select=*&order=updated_at.desc`, readFailures, sourceStatus)
    ]);
  }

  let discoveryAssignments = [];
  const admittedPublisherIds = [...new Set(candidates.map(item => item.admitted_publisher_id).filter(Boolean))];
  if (admittedPublisherIds.length) discoveryAssignments = await safeRead(
    'publisher_assignments',
    `publisher_assignments?publisher_id=in.${inFilter(admittedPublisherIds)}&select=*`,
    readFailures,
    sourceStatus
  );

  let rawRecords = [];
  let dispositions = [];
  let rejections = [];
  let packageDocs = [];
  const acquisitionRunIds = acquisitionRuns.map(item => item.id).filter(Boolean);
  if (acquisitionRunIds.length) {
    const filter = inFilter(acquisitionRunIds);
    [rawRecords, dispositions, rejections, packageDocs] = await Promise.all([
      safeRead('acquisition_raw_records', `acquisition_raw_records?acquisition_run_id=in.${filter}&select=*&order=retrieval_timestamp.asc`, readFailures, sourceStatus),
      safeRead('acquisition_record_dispositions', `acquisition_record_dispositions?acquisition_run_id=in.${filter}&select=*`, readFailures, sourceStatus),
      safeRead('acquisition_rejections', `acquisition_rejections?acquisition_run_id=in.${filter}&select=*`, readFailures, sourceStatus),
      safeRead('contract_package_documents', `contract_package_documents?acquisition_run_id=in.${filter}&select=*&order=created_at.asc`, readFailures, sourceStatus)
    ]);
  }

  if (!packageDocs.length && rawRecords.length) {
    const rawIds = rawRecords.map(item => item.id).filter(Boolean);
    if (rawIds.length) packageDocs = await safeRead(
      'contract_package_documents',
      `contract_package_documents?raw_record_id=in.${inFilter(rawIds)}&select=*&order=created_at.asc`,
      readFailures,
      sourceStatus
    );
  }

  const opportunities = await safeRead(
    'state_contract_opportunities',
    `state_contract_opportunities?ingestion_run_id=eq.${enc(commandRunId)}&select=id,solicitation_number,title,status,package_status,match_readiness_status,created_at,updated_at&order=created_at.asc`,
    readFailures,
    sourceStatus
  );

  const currentConnectorEvidence = connectorRows.filter(item =>
    String(item.last_command_run_id || '') === String(commandRunId)
  );
  const baselineConnectorEvidence = connectorRows.filter(item =>
    String(item.last_command_run_id || '') !== String(commandRunId)
  );

  return {
    run,
    mission,
    stages,
    tasks,
    attempts,
    events,
    failures,
    metrics,
    audit,
    existingReports,
    acquisitionRuns,
    rawRecords,
    dispositions,
    rejections,
    packageDocs,
    opportunities,
    discovery,
    candidates,
    assignment,
    publisher,
    currentConnectorEvidence,
    baselineConnectorEvidence,
    discoveryAssignments,
    scheduleRuns,
    readFailures,
    sourceStatus
  };
}

async function storedReports(commandRunId) {
  return db(`mission_execution_reports?command_run_id=eq.${enc(commandRunId)}&select=*&order=report_version.desc`);
}

function productionEvidence() {
  return {
    commit: env('COMMIT_REF') || env('HEAD') || NOT_REPORTED,
    deployId: env('DEPLOY_ID') || NOT_REPORTED,
    url: env('URL') || env('DEPLOY_PRIME_URL') || env('DEPLOY_URL') || NOT_REPORTED,
    deploymentUrl: env('DEPLOY_PRIME_URL') || env('DEPLOY_URL') || env('URL') || NOT_REPORTED,
    context: env('CONTEXT') || NOT_REPORTED
  };
}

function storedPayload(row) {
  const report = structuredClone(row.report_data);
  attachReportHash(report, row.report_hash);
  return {
    report,
    storage: {
      id: row.id,
      command_run_id: row.command_run_id,
      mission_type_key: row.mission_type_key,
      report_version: row.report_version,
      report_state: row.report_state,
      report_hash: row.report_hash,
      generated_at: row.generated_at,
      finalized_at: row.finalized_at,
      amended_at: row.amended_at,
      supersedes_report_id: row.supersedes_report_id
    },
    persisted: true
  };
}

function generatedPayload(report, hash, context, version, state, generatedAt) {
  attachReportHash(report, hash);
  return {
    report,
    storage: {
      id: NOT_REPORTED,
      command_run_id: context.run.id,
      mission_type_key: context.run.mission_type_key,
      report_version: version,
      report_state: state,
      report_hash: hash,
      generated_at: generatedAt,
      supersedes_report_id: NOT_REPORTED
    },
    persisted: false
  };
}

async function insertReport({
  id,
  commandRunId,
  missionTypeKey,
  version,
  state,
  report,
  hash,
  generatedAt,
  finalizedAt = null,
  amendedAt = null,
  amendmentReason = null,
  supersedesReportId = null,
  createdBy
}) {
  const inserted = await db('mission_execution_reports', {
    method: 'POST',
    body: JSON.stringify({
      id,
      command_run_id: commandRunId,
      mission_type_key: missionTypeKey,
      report_version: version,
      report_state: state,
      report_data: report,
      report_hash: hash,
      generated_at: generatedAt,
      finalized_at: finalizedAt,
      amended_at: amendedAt,
      amendment_reason: amendmentReason,
      supersedes_report_id: supersedesReportId,
      created_by: createdBy
    })
  });
  return inserted[0];
}

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const operator = authenticatedOperator(event);
  if (!operator) return response(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const commandRunId = String(body.command_run_id || body.run_id || '').trim();
  if (!commandRunId) return response(400, { error: 'command_run_id required' });

  try {
    const reports = await storedReports(commandRunId);
    const requestedVersion = Number(body.report_version || 0);
    if (requestedVersion) {
      const existing = reports.find(item => Number(item.report_version) === requestedVersion);
      return existing
        ? response(200, storedPayload(existing))
        : response(404, {
          error: 'Report version not found',
          command_run_id: commandRunId,
          report_version: requestedVersion
        });
    }

    const context = await loadContext(commandRunId);
    if (context.notFound) return response(404, { error: 'Report not found', command_run_id: commandRunId });

    const definition = resolveReportDefinition(context.run.mission_type_key);
    if (!definition) return response(422, {
      error: 'UNSUPPORTED REPORT TYPE',
      code: 'UNSUPPORTED_REPORT_TYPE',
      mission_type_key: context.run.mission_type_key || NOT_REPORTED
    });

    if (context.readFailures.length) return response(503, {
      error: 'One or more required evidence sources are unavailable. The report was not generated because unknown evidence cannot be represented as zero.',
      code: 'EVIDENCE_SOURCE_UNAVAILABLE',
      command_run_id: commandRunId,
      source_failures: context.readFailures
    });

    const action = String(body.action || 'read').trim().toLowerCase();
    const terminal = isTerminalOutcome(context.run.status || context.run.aadp_state);
    const latest = reports[0] || null;

    if (action === 'amend') {
      if (!terminal) return response(409, { error: 'Only terminal reports may be amended.' });
      const reason = String(body.amendment_reason || '').trim();
      if (!reason) return response(400, { error: 'amendment_reason required' });
      if (!latest || !['FINAL', 'AMENDED'].includes(String(latest.report_state).toUpperCase())) {
        return response(409, { error: 'A FINAL report must exist before an amendment can be created.' });
      }

      const original = reports.at(-1);
      const nextVersion = Number(latest.report_version) + 1;
      const generatedAt = new Date().toISOString();
      const id = randomUUID();
      const report = buildMissionReport(context, {
        generatedAt,
        reportId: `MR-${commandRunId.slice(0, 8).toUpperCase()}-V${nextVersion}`,
        reportVersion: nextVersion,
        reportState: 'AMENDED',
        amendmentReason: reason,
        supersedesReportId: latest.id,
        originalEvidenceHash: original.report_hash,
        finalizedAt: latest.finalized_at,
        production: productionEvidence()
      });
      const hash = reportHash(report);
      attachReportHash(report, hash);
      const inserted = await insertReport({
        id,
        commandRunId,
        missionTypeKey: context.run.mission_type_key,
        version: nextVersion,
        state: 'AMENDED',
        report,
        hash,
        generatedAt,
        finalizedAt: latest.finalized_at,
        amendedAt: generatedAt,
        amendmentReason: reason,
        supersedesReportId: latest.id,
        createdBy: operator.email
      });
      return response(200, storedPayload(inserted));
    }

    if (!terminal && latest?.report_state === 'DRAFT') return response(200, storedPayload(latest));
    if (terminal && ['FINAL', 'AMENDED'].includes(String(latest?.report_state || '').toUpperCase())) {
      return response(200, storedPayload(latest));
    }

    const generatedAt = new Date().toISOString();
    const nextVersion = latest ? Number(latest.report_version) + 1 : 1;
    const reportState = terminal ? 'FINAL' : 'DRAFT';
    const report = buildMissionReport(context, {
      generatedAt,
      reportId: `MR-${commandRunId.slice(0, 8).toUpperCase()}-V${nextVersion}`,
      reportVersion: nextVersion,
      reportState,
      supersedesReportId: latest?.id || NOT_REPORTED,
      finalizedAt: terminal ? generatedAt : undefined,
      production: productionEvidence()
    });
    const hash = reportHash(report);
    attachReportHash(report, hash);

    const persistDraft = action === 'capture' || body.persist_draft === true;
    if (!terminal && !persistDraft) {
      return response(200, generatedPayload(report, hash, context, nextVersion, 'DRAFT', generatedAt));
    }

    if (!terminal && reports.length) {
      return response(409, {
        error: 'An immutable DRAFT version already exists for this run.',
        code: 'DRAFT_ALREADY_PRESERVED',
        command_run_id: commandRunId,
        report_version: latest.report_version
      });
    }

    const id = randomUUID();
    const inserted = await insertReport({
      id,
      commandRunId,
      missionTypeKey: context.run.mission_type_key,
      version: nextVersion,
      state: reportState,
      report,
      hash,
      generatedAt,
      finalizedAt: terminal ? generatedAt : null,
      supersedesReportId: latest?.id || null,
      createdBy: operator.email
    });
    return response(200, storedPayload(inserted));
  } catch (error) {
    if (error?.code === '23505') {
      const reports = await storedReports(commandRunId);
      if (reports.length) return response(200, storedPayload(reports[0]));
    }
    console.error('mission-report failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
