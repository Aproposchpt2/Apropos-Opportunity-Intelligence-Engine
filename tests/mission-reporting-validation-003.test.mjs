import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attachReportHash,
  buildMissionReport,
  deriveOperationalOutcome,
  reportHash,
  NOT_REPORTED
} from '../netlify/functions/_shared/mission-reporting-hardening.js';

const run = {
  id: '3258d329-a84c-4598-8597-8ae163e4c628',
  status: 'queued',
  aadp_state: 'QUEUED',
  current_stage: 'NETLIFY_EXECUTION_QUEUED',
  mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
  mission_name: 'Verify Publisher Connection — California — Los Angeles County — Publisher County of Los Angeles',
  state_code: 'CA',
  assigned_agent: 'Publisher Engineering',
  created_at: '2026-08-05T22:53:29.766885Z',
  updated_at: '2026-08-05T22:53:29.766885Z',
  started_at: '2026-08-05T22:53:29.693Z',
  last_activity_at: '2026-08-05T22:53:29.693Z',
  completed_at: null,
  stop_requested_at: null,
  warning_count: 0,
  failure_count: 0,
  reconciliation_status: 'PENDING',
  validation_status: 'PENDING',
  registry_impact: {},
  execution_evidence: {
    source: 'EXECUTIVE_COMMAND_CENTER',
    runtime: 'NETLIFY_NATIVE',
    county_fips: '06037',
    county_name: 'Los Angeles County',
    publisher_id: 'c87c5927-5e29-48ef-8a18-fd671ffac709',
    execution_model: 'EAG_001_READ_ONLY',
    publisher_scope: 'SINGLE',
    geographic_scope: 'COUNTY',
    operator_authorized: true,
    publisher_approval_required: true
  }
};

const publisher = {
  id: 'c87c5927-5e29-48ef-8a18-fd671ffac709',
  publisher_name: 'County of Los Angeles',
  state_code: 'CA',
  county_name: 'Los Angeles County',
  county_fips: '06037',
  verified: true,
  access_status: 'READY',
  last_verified_at: '2026-08-04T16:09:00.976Z',
  configuration: {}
};

const acceptedBaseline = {
  id: 'f726481a-d59b-4fec-8513-8f2f12619eaf',
  publisher_id: publisher.id,
  connector_key: 'LA_COUNTY_ECAPS',
  connector_version: '1.2.0',
  acceptance_status: 'ACCEPTED',
  validation_status: 'PASSED',
  accepted_at: '2026-08-04T16:09:00.976Z',
  tested_at: '2026-08-04T16:09:00.976Z',
  acceptance_evidence: {
    gate: 'EAG-001',
    connection: 'PASS',
    sample_size: 10,
    records_parsed: 10,
    detail_pages_successful: 10,
    certification_status: 'CERTIFIED',
    ready_for_acquisition: true
  }
};

const laterTestingBaseline = {
  id: 'b7965d3c-226f-4adc-9308-5e142f7a48b4',
  publisher_id: publisher.id,
  connector_key: 'LA_COUNTY_ECAPS',
  connector_version: '1.0',
  acceptance_status: 'TESTING',
  validation_status: 'WARNING',
  updated_at: '2026-08-04T16:20:45.028Z',
  acceptance_evidence: { publisher_reported_total: 229 }
};

function context(overrides = {}) {
  return {
    run,
    mission: null,
    publisher,
    assignment: null,
    currentConnectorEvidence: [],
    baselineConnectorEvidence: [laterTestingBaseline, acceptedBaseline],
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
    sourceStatus: [
      { source: 'command_runs', status: 'READ', records: 1 },
      { source: 'command_tasks', status: 'READ', records: 0 },
      { source: 'command_task_attempts', status: 'READ', records: 0 },
      { source: 'connector_acceptance_registry', status: 'READ', records: 2 }
    ],
    ...overrides
  };
}

const generatedAt = '2026-08-06T01:12:00.000Z';
const production = {
  commit: 'preview-validated-commit',
  deployId: 'preview-deploy-id',
  context: 'deploy-preview',
  url: 'https://apie.aproposgroupllc.com'
};

test('existing queued run is DRAFT with a separate STALLED_AT_CAPTURE operational outcome', () => {
  const report = buildMissionReport(context(), {
    generatedAt,
    reportVersion: 1,
    reportState: 'DRAFT',
    production
  });
  assert.equal(report.report_metadata.report_state, 'DRAFT');
  assert.equal(report.run_status.authoritative_status, 'QUEUED');
  assert.equal(report.run_status.derived_operational_outcome, 'STALLED_AT_CAPTURE');
  assert.equal(report.executive_determination.report_lifecycle_state, 'DRAFT');
  assert.equal(report.executive_determination.operational_outcome, 'STALLED_AT_CAPTURE');
  assert.equal(report.executive_determination.determination, 'STALLED BEFORE WORKER CLAIM');
  assert.equal(report.run_status.worker_claimed, false);
  assert.equal(deriveOperationalOutcome(context(), generatedAt), 'STALLED_AT_CAPTURE');
});

test('queued report displays exactly the five EAG-001 stages without fabricated execution', () => {
  const report = buildMissionReport(context(), { generatedAt, reportState: 'DRAFT', production });
  assert.deepEqual(report.stage_by_stage_evidence.map(stage => stage.stage_name), [
    'Approved Publisher Profile Loaded',
    'Connector Resolved',
    'Listing or Search Connection Tested',
    'Detail and Evidence Validation',
    'EAG-001 Certification Decision'
  ]);
  assert.ok(report.stage_by_stage_evidence.every(stage => stage.stage_status === NOT_REPORTED));
});

test('timeline excludes worker claim and includes the derived stall threshold event', () => {
  const report = buildMissionReport(context(), { generatedAt, reportState: 'DRAFT', production });
  assert.ok(!report.execution_timeline.some(event => /worker claimed/i.test(event.event)));
  const stall = report.execution_timeline.find(event => event.status === 'STALLED_AT_CAPTURE');
  assert.ok(stall);
  assert.equal(stall.timestamp, '2026-08-05T22:54:29.693Z');
  assert.equal(stall.threshold_seconds, 60);
});

test('current-run EAG-001 evidence remains NOT REPORTED and certified baseline is contextual only', () => {
  const report = buildMissionReport(context(), { generatedAt, reportState: 'DRAFT', production });
  assert.equal(report.publisher_and_connector.existing_baseline.connector.id, acceptedBaseline.id);
  assert.equal(report.publisher_and_connector.existing_baseline.certification_summary, 'CERTIFIED — EXISTING BASELINE ONLY');
  assert.equal(report.publisher_and_connector.current_run.eag_001_result, NOT_REPORTED);
  const result = report.task_specific_metrics.find(metric => metric.label === 'EAG-001 Result');
  assert.equal(result.value, NOT_REPORTED);
  assert.equal(result.source, NOT_REPORTED);
});

test('report provenance and self-verifying hash are populated', () => {
  const report = buildMissionReport(context(), { generatedAt, reportVersion: 1, reportState: 'DRAFT', production });
  const hash = reportHash(report);
  attachReportHash(report, hash);
  assert.equal(report.report_metadata.production_git_commit, production.commit);
  assert.equal(report.report_metadata.production_netlify_deploy, production.deployId);
  assert.equal(report.report_metadata.deployment_context, production.context);
  assert.equal(report.report_metadata.production_url, production.url);
  assert.equal(report.report_metadata.report_generator_version, 'APIE-MISSION-REPORTING-1.1');
  assert.equal(report.report_metadata.generated_at, generatedAt);
  assert.equal(report.report_metadata.report_hash, hash);
  assert.equal(reportHash(report), hash);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('stopped snapshot becomes FINAL Version 2 and references Version 1', () => {
  const stopped = {
    ...run,
    status: 'stopped',
    aadp_state: 'CANCELLED',
    current_stage: 'OPERATOR_FORCE_STOPPED',
    completed_at: '2026-08-06T01:30:00.000Z',
    stop_requested_at: '2026-08-06T01:30:00.000Z',
    execution_evidence: {
      ...run.execution_evidence,
      worker_claimed: false,
      prior_stage: 'NETLIFY_EXECUTION_QUEUED',
      last_checkpoint: 'NETLIFY_EXECUTION_QUEUED'
    }
  };
  const report = buildMissionReport(context({ run: stopped }), {
    generatedAt: '2026-08-06T01:31:00.000Z',
    reportVersion: 2,
    reportState: 'FINAL',
    supersedesReportId: 'version-1-report-id',
    production
  });
  assert.equal(report.report_metadata.report_version, 2);
  assert.equal(report.report_metadata.report_state, 'FINAL');
  assert.equal(report.report_metadata.supersedes_report_id, 'version-1-report-id');
  assert.equal(report.final_acceptance_decision.determination, 'STOPPED BEFORE VERIFICATION');
  assert.equal(report.run_status.worker_claimed, false);
  assert.equal(report.restart_or_follow_up_instructions.checkpoint, 'NETLIFY_EXECUTION_QUEUED');
});

test('print view is concise while JSON export retains the complete report object', () => {
  const source = readFileSync(new URL('../assets/mission-report.js', import.meta.url), 'utf8');
  assert.match(source, /function connectorSummary/);
  assert.match(source, /printable_view_uses_concise_publisher_and_connector_summary/);
  assert.match(source, /includes_full_raw_evidence: true/);
  assert.doesNotMatch(source, /renderValue\(baseline, 1\)/);
  assert.doesNotMatch(source, /renderValue\(current, 1\)/);
});

test('versioning endpoint and migration preserve DRAFT Version 1 and create later FINAL versions', () => {
  const endpoint = readFileSync(new URL('../netlify/functions/mission-report.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20260806012000_mission_report_draft_versioning.sql', import.meta.url), 'utf8');
  assert.match(endpoint, /action === 'capture'/);
  assert.match(endpoint, /const nextVersion = latest \? Number\(latest\.report_version\) \+ 1 : 1/);
  assert.match(endpoint, /supersedesReportId: latest\?\.id/);
  assert.match(migration, /report_state in \('DRAFT', 'FINAL', 'AMENDED'\)/);
  assert.match(migration, /report_version > 1 and supersedes_report_id is not null/);
});
