import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMissionReport,
  reportHash
} from '../netlify/functions/_shared/mission-reporting-hardening.js';

const baseRun = {
  id: '3258d329-a84c-4598-8597-8ae163e4c628',
  status: 'queued',
  aadp_state: 'QUEUED',
  current_stage: 'NETLIFY_EXECUTION_QUEUED',
  created_at: '2026-08-05T22:53:29.766Z',
  started_at: '2026-08-05T22:53:29.693Z',
  last_activity_at: '2026-08-05T22:53:29.693Z',
  mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
  mission_name: 'Verify Publisher Connection',
  assigned_agent: 'Publisher Engineering',
  execution_evidence: { publisher_id: 'publisher-1', worker_claimed: false },
  warning_count: 0,
  failure_count: 0
};

const context = overrides => ({
  run: baseRun,
  mission: { mission_type_key: 'VERIFY_PUBLISHER_CONNECTION', mission_name: 'Verify Publisher Connection' },
  publisher: {
    id: 'publisher-1',
    publisher_name: 'County of Los Angeles',
    search_endpoint: 'https://example.test',
    configuration: {
      connector_key: 'LA_COUNTY_ECAPS',
      connector_version: '1.2.0',
      certification_status: 'CERTIFIED'
    }
  },
  assignment: null,
  currentConnectorEvidence: [],
  baselineConnectorEvidence: [{
    id: 'accepted-certified',
    publisher_id: 'publisher-1',
    connector_key: 'LA_COUNTY_ECAPS',
    connector_version: '1.2.0',
    acceptance_status: 'ACCEPTED',
    validation_status: 'PASSED',
    tested_at: '2026-08-04T16:09:00Z',
    acceptance_evidence: {
      certification_status: 'CERTIFIED',
      sample_size: 10,
      detail_pages_successful: 10,
      attachments_detected: 10,
      contacts_successful: 10,
      requirements_successful: 10,
      pagination_status: 'PASS',
      source_url: 'https://example.test'
    }
  }],
  tasks: [], attempts: [], stages: [], events: [], failures: [], metrics: [], audit: [],
  existingReports: [], acquisitionRuns: [], rawRecords: [], dispositions: [], rejections: [],
  packageDocs: [], opportunities: [], candidates: [], discoveryAssignments: [], readFailures: [],
  sourceStatus: [
    { source: 'command_tasks', status: 'READ', records: 0 },
    { source: 'state_contract_opportunities', status: 'READ', records: 0 }
  ],
  ...overrides
});

test('queued run older than 60 seconds is DRAFT + QUEUED + STALLED_AT_CAPTURE', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z', reportState: 'DRAFT' });
  assert.equal(report.report_metadata.report_state, 'DRAFT');
  assert.equal(report.run_status.authoritative_status, 'QUEUED');
  assert.equal(report.run_status.derived_operational_outcome, 'STALLED_AT_CAPTURE');
  assert.equal(report.executive_determination.determination, 'STALLED BEFORE WORKER CLAIM');
  assert.equal(report.run_status.worker_claimed, false);
});

test('queued run younger than 60 seconds is QUEUED_AT_CAPTURE', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:54:00Z', reportState: 'DRAFT' });
  assert.equal(report.report_metadata.report_state, 'DRAFT');
  assert.equal(report.run_status.authoritative_status, 'QUEUED');
  assert.equal(report.run_status.derived_operational_outcome, 'QUEUED_AT_CAPTURE');
});

test('timeline does not imply worker claim without evidence', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z' });
  assert.deepEqual(report.execution_timeline.map(item => item.event), [
    'Run created', 'Run queued', 'Stall threshold exceeded', 'Report generated'
  ]);
  assert.equal(report.execution_timeline.some(item => item.event === 'Worker claimed'), false);
  assert.equal(report.execution_timeline.some(item => item.event === 'Run started / worker claimed'), false);
});

test('historical connector certification remains compressed EXISTING BASELINE', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z' });
  const baseline = report.publisher_and_connector.existing_baseline;
  assert.equal(baseline.evidence_label.label, 'EXISTING BASELINE');
  assert.equal(baseline.existing_certification, 'CERTIFIED');
  assert.equal(baseline.connector_version, '1.2.0');
  assert.equal('connector' in baseline, false);
});

test('historical certification cannot complete the current EAG-001 decision stage', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z' });
  assert.equal(report.stage_by_stage_evidence.length, 5);
  assert.equal(report.stage_by_stage_evidence[0].stage_status, 'EXISTING BASELINE CONFIRMED');
  assert.equal(report.stage_by_stage_evidence[4].stage_name, 'EAG-001 Certification Decision');
  assert.equal(report.stage_by_stage_evidence[4].stage_status, 'NOT STARTED');
});

test('raw evidence remains available in the machine-readable appendix', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z' });
  assert.equal(report.evidence_appendix.raw_baseline_evidence.connector_acceptance.id, 'accepted-certified');
  assert.match(report.evidence_appendix.primary_report_reference, /machine-readable JSON export/i);
});

test('production provenance includes commit, deploy, context, URL, generator, timestamp, and hash', () => {
  const report = buildMissionReport(context(), {
    generatedAt: '2026-08-05T22:55:00Z',
    production: { commit: 'abc123', deployId: 'deploy-1', context: 'production', url: 'https://apie.example' }
  });
  const hash = reportHash(report);
  assert.equal(report.report_metadata.production_git_commit, 'abc123');
  assert.equal(report.report_metadata.production_netlify_deploy, 'deploy-1');
  assert.equal(report.report_metadata.production_deployment_context, 'production');
  assert.equal(report.report_metadata.production_url, 'https://apie.example');
  assert.equal(report.report_metadata.report_generation_timestamp, '2026-08-05T22:55:00Z');
  assert.match(report.report_metadata.report_generator_version, /TRUTH-CORRECTION/);
  assert.equal(report.report_metadata.report_hash, hash);
});

test('zero is used only for a source successfully queried', () => {
  const report = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z' });
  assert.equal(report.registry_or_database_impact.affected_table_counts.command_tasks.value, 0);
  assert.equal(report.registry_or_database_impact.affected_table_counts.command_tasks.query_status, 'READ');
  assert.equal(report.registry_or_database_impact.affected_table_counts.command_task_attempts.value, 'NOT REPORTED');
  assert.equal(report.records_or_documents_affected.total, 'NOT REPORTED');
});

test('stopped run remains FINAL and STOPPED BEFORE VERIFICATION', () => {
  const report = buildMissionReport(context({
    run: { ...baseRun, status: 'stopped', aadp_state: 'CANCELLED', completed_at: '2026-08-05T23:00:00Z' }
  }), { generatedAt: '2026-08-05T23:00:01Z', reportState: 'FINAL' });
  assert.equal(report.report_metadata.report_state, 'FINAL');
  assert.equal(report.run_status.authoritative_status, 'STOPPED');
  assert.equal(report.executive_determination.determination, 'STOPPED BEFORE VERIFICATION');
});

test('report hash changes when evidence changes', () => {
  const first = buildMissionReport(context(), { generatedAt: '2026-08-05T22:55:00Z' });
  const firstHash = reportHash(first);
  const second = buildMissionReport(context({
    run: { ...baseRun, last_activity_at: '2026-08-05T22:54:30Z' }
  }), { generatedAt: '2026-08-05T22:55:00Z' });
  assert.notEqual(firstHash, reportHash(second));
});

test('report versions remain distinct and hash independently', () => {
  const first = buildMissionReport(context(), {
    generatedAt: '2026-08-05T22:55:00Z', reportVersion: 1, reportId: 'MR-V1'
  });
  const amended = buildMissionReport(context(), {
    generatedAt: '2026-08-05T22:56:00Z', reportVersion: 2, reportId: 'MR-V2', reportState: 'AMENDED'
  });
  assert.equal(first.report_metadata.report_version, 1);
  assert.equal(amended.report_metadata.report_version, 2);
  assert.notEqual(reportHash(first), reportHash(amended));
});

test('audit actions preserve authoritative action and actor fields', () => {
  const report = buildMissionReport(context({
    audit: [{
      action_type: 'OPERATOR_REVIEWED', actor_type: 'EXECUTIVE', actor_id: 'operator-1',
      reason: 'Evidence reviewed', occurred_at: '2026-08-05T23:01:00Z'
    }]
  }), { generatedAt: '2026-08-05T23:02:00Z' });
  assert.deepEqual(report.operator_actions[0], {
    action: 'OPERATOR_REVIEWED', timestamp: '2026-08-05T23:01:00Z',
    actor: 'operator-1', actor_type: 'EXECUTIVE', reason: 'Evidence reviewed',
    evidence_source: 'command_audit_log'
  });
});

test('primary print report excludes raw appendix while JSON export preserves it', () => {
  const js = readFileSync(new URL('../assets/mission-report.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../assets/mission-report-correction.css', import.meta.url), 'utf8');
  assert.match(js, /evidence-appendix-details/);
  assert.match(js, /exportPayload = \{ report: loadedReport, storage: loadedStorage \}/);
  assert.match(css, /@media print[\s\S]*evidence-appendix-details[\s\S]*display: none/);
});
