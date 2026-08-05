import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMissionReport,
  buildStageEvidence,
  canonicalize,
  isTerminalOutcome,
  missionMetrics,
  normalizeRunOutcome,
  reportHash,
  resolveReportDefinition,
  workerClaimed,
  NOT_REPORTED
} from '../netlify/functions/_shared/mission-reporting.js';

const stoppedRun = {
  id: 'cebe99ba-d2e4-4820-a15f-0f67af1f0df1',
  status: 'stopped',
  current_stage: 'OPERATOR_FORCE_STOPPED',
  mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
  mission_name: 'Verify Publisher Connection — California — Los Angeles County — Publisher County of Los Angeles',
  state_code: 'CA',
  assigned_agent: 'Publisher Engineering',
  started_at: '2026-08-05T19:43:49.457Z',
  completed_at: '2026-08-05T19:50:04.816Z',
  created_at: '2026-08-05T19:43:49.547Z',
  stop_requested_at: '2026-08-05T19:50:04.816Z',
  last_activity_at: '2026-08-05T19:50:04.816Z',
  warning_count: 0,
  failure_count: 0,
  reconciliation_status: 'PENDING',
  validation_status: 'PENDING',
  registry_impact: {},
  execution_evidence: {
    county_name: 'Los Angeles County',
    county_fips: '06037',
    publisher_id: 'publisher-la',
    worker_claimed: false,
    prior_stage: 'NETLIFY_EXECUTION_QUEUED',
    reason: 'Worker did not claim queued EAG-001 run'
  }
};

const mission = {
  mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
  mission_name: stoppedRun.mission_name,
  state_code: 'CA',
  assigned_agent: 'Publisher Engineering',
  authorization_state: 'AUTHORIZED',
  authorized_at: '2026-08-05T19:43:49.457Z',
  mission_config: {
    county_name: 'Los Angeles County',
    county_fips: '06037',
    publisher_id: 'publisher-la',
    execution_model: 'EAG_001_READ_ONLY'
  },
  blocking_reasons: []
};

const publisher = {
  id: 'publisher-la',
  publisher_name: 'County of Los Angeles',
  state_code: 'CA',
  county_name: 'Los Angeles County',
  county_fips: '06037',
  access_status: 'READY',
  configuration: {
    connector_key: 'LA_COUNTY_ECAPS',
    connector_version: '1.2.0',
    certification_status: 'CERTIFIED',
    publisher_profile_approved: true,
    profile_complete: true
  }
};

const baselineConnector = {
  id: 'baseline-acceptance',
  publisher_id: 'publisher-la',
  connector_key: 'LA_COUNTY_ECAPS',
  connector_version: '1.2.0',
  acceptance_status: 'ACCEPTED',
  last_command_run_id: null,
  acceptance_evidence: {
    eag_001_result: 'PASS',
    certification_status: 'CERTIFIED',
    sample_size: 10,
    records_parsed: 10
  }
};

function context(overrides = {}) {
  return {
    run: stoppedRun,
    mission,
    publisher,
    assignment: null,
    currentConnectorEvidence: [],
    baselineConnectorEvidence: [baselineConnector],
    tasks: [],
    attempts: [],
    stages: [],
    events: [],
    failures: [],
    metrics: [],
    audit: [],
    existingReports: [],
    acquisitionRuns: [],
    rawRecords: [],
    dispositions: [],
    rejections: [],
    packageDocs: [],
    opportunities: [],
    candidates: [],
    discoveryAssignments: [],
    readFailures: [],
    sourceStatus: [],
    ...overrides
  };
}

test('normalizes exact terminal and draft outcomes', () => {
  assert.equal(normalizeRunOutcome('completed_with_warnings'), 'COMPLETED_WITH_WARNINGS');
  assert.equal(normalizeRunOutcome('cancelled'), 'STOPPED');
  assert.equal(normalizeRunOutcome('running'), 'DRAFT');
  assert.equal(isTerminalOutcome('stopped'), true);
  assert.equal(isTerminalOutcome('queued'), false);
});

test('all current mission types have a report definition', () => {
  for (const type of [
    'PUBLISHER_DISCOVERY', 'VERIFY_PUBLISHER_CONNECTION', 'ACQUISITION_DISCOVERY',
    'CONTRACT_PACKAGE_ACQUISITION', 'BUSINESS_DEVELOPMENT_DISCOVERY',
    'OPPORTUNITY_PARTNER_DISCOVERY', 'INSTITUTIONAL_BUYER_DISCOVERY',
    'STATE_MISSION', 'AADP_PROCESSING', 'AOIE_ANALYSIS',
    'PROCUREMENT_INVENTORY', 'CONTRACT_LIFECYCLE'
  ]) assert.ok(resolveReportDefinition(type), type);
});

test('unknown mission types are explicitly unsupported', () => {
  assert.equal(resolveReportDefinition('UNKNOWN_MISSION'), null);
  assert.throws(
    () => buildMissionReport(context({ run: { ...stoppedRun, mission_type_key: 'UNKNOWN_MISSION' } })),
    error => error.code === 'UNSUPPORTED_REPORT_TYPE'
  );
});

test('stopped LA County run reports worker not claimed and no current EAG-001 result', () => {
  const report = buildMissionReport(context(), {
    generatedAt: '2026-08-05T22:00:00.000Z',
    reportState: 'FINAL'
  });
  assert.equal(report.run_status.worker_claimed, false);
  assert.equal(report.executive_determination.outcome, 'STOPPED');
  assert.equal(report.final_acceptance_decision.determination, 'STOPPED BEFORE VERIFICATION');
  const result = report.task_specific_metrics.find(item => item.label === 'EAG-001 Result');
  assert.equal(result.source, 'NOT REPORTED');
  assert.equal(result.value, NOT_REPORTED);
});

test('historical connector certification is baseline evidence only', () => {
  const report = buildMissionReport(context(), { reportState: 'FINAL' });
  assert.equal(report.publisher_and_connector.existing_baseline.evidence_label.label, 'EXISTING BASELINE');
  assert.equal(report.publisher_and_connector.current_run.evidence_label.label, 'NOT REPORTED');
  assert.match(report.publisher_and_connector.current_run.note, /Historical connector certification/);
});

test('current connector evidence is current only when tied to command_run_id', () => {
  const current = { ...baselineConnector, id: 'current', last_command_run_id: stoppedRun.id, acceptance_status: 'TESTING', acceptance_evidence: { eag_001_result: 'FAILED' } };
  const metrics = missionMetrics(context({ currentConnectorEvidence: [current] }));
  const result = metrics.find(item => item.label === 'EAG-001 Result');
  assert.equal(result.source, 'CURRENT RUN');
  assert.equal(result.value, 'FAILED');
});

test('stage completion is never inferred from progress_value', () => {
  const stages = buildStageEvidence(context({
    run: { ...stoppedRun, progress_value: 100 },
    tasks: [{ task_type: 'VERIFY_CONNECTION', state: 'CREATED', created_at: '2026-08-05T19:43:50Z', execution_evidence: {} }]
  }));
  assert.equal(stages[0].stage_status, 'CREATED');
  assert.notEqual(stages[0].stage_status, 'COMPLETED');
});

test('missing stage evidence displays NOT REPORTED', () => {
  const stages = buildStageEvidence(context());
  assert.equal(stages[0].stage_name, NOT_REPORTED);
  assert.equal(stages[0].stage_status, NOT_REPORTED);
});

test('publisher verification report excludes discovery metrics', () => {
  const metrics = missionMetrics(context());
  assert.ok(metrics.some(item => item.label === 'EAG-001 Result'));
  assert.ok(!metrics.some(item => item.label === 'Candidates Discovered'));
});

test('package report excludes publisher validation metrics', () => {
  const packageContext = context({
    run: { ...stoppedRun, mission_type_key: 'CONTRACT_PACKAGE_ACQUISITION', status: 'completed' },
    mission: { ...mission, mission_type_key: 'CONTRACT_PACKAGE_ACQUISITION' }
  });
  const metrics = missionMetrics(packageContext);
  assert.ok(metrics.some(item => item.label === 'Documents Downloaded'));
  assert.ok(!metrics.some(item => item.label === 'EAG-001 Result'));
});

test('timeline includes actual stop and report generation timestamps', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:00:00.000Z', reportState: 'FINAL' });
  assert.ok(report.execution_timeline.some(item => item.event === 'Operator stop request' && item.timestamp === stoppedRun.stop_requested_at));
  assert.ok(report.execution_timeline.some(item => item.event === 'Report generated' && item.timestamp === '2026-08-05T22:00:00.000Z'));
});

test('report hash is deterministic for equivalent report data', () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.deepEqual(canonicalize(left), canonicalize(right));
  assert.equal(reportHash(left), reportHash(right));
  assert.match(reportHash(left), /^[0-9a-f]{64}$/);
});

test('final and amended report states preserve explicit versions', () => {
  const finalReport = buildMissionReport(context(), { reportVersion: 1, reportState: 'FINAL', generatedAt: '2026-08-05T22:00:00Z' });
  const amended = buildMissionReport(context(), {
    reportVersion: 2,
    reportState: 'AMENDED',
    generatedAt: '2026-08-05T23:00:00Z',
    amendmentReason: 'Corrected evidence source label',
    supersedesReportId: 'report-v1',
    originalEvidenceHash: reportHash(finalReport)
  });
  assert.equal(finalReport.report_metadata.report_version, 1);
  assert.equal(amended.report_metadata.report_version, 2);
  assert.equal(amended.report_metadata.report_state, 'AMENDED');
  assert.equal(amended.report_metadata.supersedes_report_id, 'report-v1');
  assert.equal(amended.report_metadata.amendment_reason, 'Corrected evidence source label');
});

test('worker claim requires explicit task or attempt evidence when explicit flag is absent', () => {
  const noFlag = context({ run: { ...stoppedRun, execution_evidence: {} } });
  assert.equal(workerClaimed(noFlag), false);
  assert.equal(workerClaimed({ ...noFlag, attempts: [{ started_at: '2026-08-05T19:44:00Z' }] }), true);
});

test('report contains all eighteen common sections plus metadata', () => {
  const report = buildMissionReport(context(), { reportState: 'FINAL' });
  for (const key of [
    'executive_determination', 'mission_identity', 'authorized_scope', 'publisher_and_connector',
    'run_status', 'execution_timeline', 'stage_by_stage_evidence', 'task_specific_metrics',
    'records_or_documents_affected', 'warnings', 'failures', 'reconciliation',
    'registry_or_database_impact', 'artifacts_and_hashes', 'operator_actions',
    'final_acceptance_decision', 'restart_or_follow_up_instructions', 'evidence_appendix'
  ]) assert.ok(Object.hasOwn(report, key), key);
  assert.ok(report.report_metadata);
});
