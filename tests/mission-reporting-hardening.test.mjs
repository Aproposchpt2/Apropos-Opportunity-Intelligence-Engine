import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMissionReport } from '../netlify/functions/_shared/mission-reporting-hardening.js';

const baseRun = {
  id: 'run-1',
  status: 'queued',
  current_stage: 'NETLIFY_EXECUTION_QUEUED',
  mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
  mission_name: 'Verify Publisher Connection',
  execution_evidence: { worker_claimed: false },
  warning_count: 0,
  failure_count: 0
};

const context = overrides => ({
  run: baseRun,
  mission: { mission_type_key: 'VERIFY_PUBLISHER_CONNECTION', mission_name: 'Verify Publisher Connection' },
  publisher: null,
  assignment: null,
  currentConnectorEvidence: [],
  baselineConnectorEvidence: [],
  tasks: [], attempts: [], stages: [], events: [], failures: [], metrics: [], audit: [],
  existingReports: [], acquisitionRuns: [], rawRecords: [], dispositions: [], rejections: [],
  packageDocs: [], opportunities: [], candidates: [], discoveryAssignments: [], readFailures: [], sourceStatus: [],
  ...overrides
});

test('queued verification remains REVIEW REQUIRED unless explicitly stalled', () => {
  const queued = buildMissionReport(context(), { reportState: 'DRAFT' });
  assert.equal(queued.final_acceptance_decision.determination, 'REVIEW REQUIRED');

  const stalled = buildMissionReport(context({ run: { ...baseRun, current_stage: 'STALLED_AT_CAPTURE' } }), { reportState: 'DRAFT' });
  assert.equal(stalled.final_acceptance_decision.determination, 'STALLED BEFORE WORKER CLAIM');
});

test('audit actions preserve command_audit_log action and actor fields', () => {
  const report = buildMissionReport(context({
    run: { ...baseRun, status: 'stopped', stop_requested_at: '2026-08-05T21:00:00Z' },
    audit: [{
      action_type: 'OPERATOR_REVIEWED', actor_type: 'EXECUTIVE', actor_id: 'operator-1',
      reason: 'Evidence reviewed', occurred_at: '2026-08-05T21:01:00Z'
    }]
  }), { reportState: 'FINAL' });
  const action = report.operator_actions.find(item => item.action === 'OPERATOR_REVIEWED');
  assert.equal(action.actor, 'operator-1');
  assert.equal(action.actor_type, 'EXECUTIVE');
  assert.equal(action.reason, 'Evidence reviewed');
});

test('certified accepted baseline connector outranks a later testing record', () => {
  const report = buildMissionReport(context({
    publisher: {
      id: 'publisher-1',
      publisher_name: 'County of Los Angeles',
      configuration: { connector_key: 'LA_COUNTY_ECAPS', connector_version: '1.2.0', certification_status: 'CERTIFIED' }
    },
    baselineConnectorEvidence: [
      {
        id: 'testing-later', connector_key: 'LA_COUNTY_ECAPS', connector_version: '1.0',
        acceptance_status: 'TESTING', validation_status: 'WARNING', updated_at: '2026-08-04T16:20:45Z'
      },
      {
        id: 'accepted-certified', connector_key: 'LA_COUNTY_ECAPS', connector_version: '1.2.0',
        acceptance_status: 'ACCEPTED', validation_status: 'PASSED', accepted_at: '2026-08-04T16:09:00Z',
        acceptance_evidence: { certification_status: 'CERTIFIED', connection: 'PASS' }
      }
    ]
  }), { reportState: 'DRAFT' });
  assert.equal(report.publisher_and_connector.existing_baseline.connector.id, 'accepted-certified');
  const version = report.task_specific_metrics.find(item => item.label === 'Connector Version');
  assert.equal(version.value, '1.2.0');
});
