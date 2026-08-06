import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMissionReport,
  resolveAuthoritativeBaselineConnector
} from '../netlify/functions/_shared/mission-reporting-hardening.js';

const accepted = {
  id: 'f726481a-d59b-4fec-8513-8f2f12619eaf',
  publisher_id: 'c87c5927-5e29-48ef-8a18-fd671ffac709',
  connector_key: 'LA_COUNTY_ECAPS',
  connector_version: '1.2.0',
  acceptance_status: 'ACCEPTED',
  validation_status: 'PASSED',
  tested_at: '2026-08-04T16:09:00.976Z',
  accepted_at: '2026-08-04T16:09:00.976Z',
  acceptance_evidence: {
    connector_key: 'LA_COUNTY_ECAPS',
    connector_version: '1.2.0',
    certification_status: 'CERTIFIED',
    verified_at: '2026-08-04T16:09:00.976Z',
    sample_size: 10,
    detail_pages_successful: 10,
    attachments_detected: 10,
    contacts_successful: 10,
    requirements_successful: 10
  }
};

const laterTesting = {
  id: 'b7965d3c-226f-4adc-9308-5e142f7a48b4',
  publisher_id: accepted.publisher_id,
  connector_key: 'LA_COUNTY_ECAPS',
  connector_version: '1.0',
  acceptance_status: 'TESTING',
  validation_status: 'WARNING',
  tested_at: '2026-08-04T16:20:45.028Z'
};

const genericAccepted = {
  id: '0aabd426-f39f-414b-abc0-0c726fe7bbde',
  publisher_id: accepted.publisher_id,
  connector_key: 'us-ca-los-angeles-county-bid-listing-api-v1',
  connector_version: '1.0.0',
  acceptance_status: 'ACCEPTED',
  validation_status: 'PASSED',
  accepted_at: '2026-08-05T00:00:00.000Z',
  acceptance_evidence: { certification_status: 'CERTIFIED' }
};

function context() {
  return {
    run: {
      id: '3258d329-a84c-4598-8597-8ae163e4c628',
      mission_type_key: 'VERIFY_PUBLISHER_CONNECTION',
      status: 'queued',
      aadp_state: 'QUEUED',
      current_stage: 'NETLIFY_EXECUTION_QUEUED',
      created_at: '2026-08-05T22:53:29.766115Z',
      updated_at: '2026-08-05T22:53:29.693000Z',
      last_activity_at: '2026-08-05T22:53:29.693000Z',
      execution_evidence: {},
      assigned_agent: 'Publisher Engineering'
    },
    mission: { mission_type_key: 'VERIFY_PUBLISHER_CONNECTION' },
    publisher: {
      id: accepted.publisher_id,
      publisher_name: 'County of Los Angeles',
      last_verified_at: '2026-08-04T16:09:00.976Z',
      configuration: {
        connector_key: 'LA_COUNTY_ECAPS',
        connector_version: '1.2.0',
        certification_status: 'CERTIFIED',
        approval_evidence: {
          connector_acceptance_registry_id: accepted.id,
          verified_at: '2026-08-04T16:09:00.976Z'
        }
      }
    },
    baselineConnectorEvidence: [laterTesting, genericAccepted, accepted],
    currentConnectorEvidence: [],
    tasks: [], attempts: [], stages: [], events: [], failures: [], metrics: [], audit: [],
    candidates: [], acquisitionRuns: [], rawRecords: [], packageDocs: [], opportunities: [],
    sourceStatus: []
  };
}

test('publisher configuration resolves LA_COUNTY_ECAPS Version 1.2.0', () => {
  const resolution = resolveAuthoritativeBaselineConnector(context());
  assert.equal(resolution.selected.connector_key, 'LA_COUNTY_ECAPS');
  assert.equal(resolution.selected.connector_version, '1.2.0');
});

test('accepted record ID is authoritative', () => {
  const resolution = resolveAuthoritativeBaselineConnector(context());
  assert.equal(resolution.selected.id, 'f726481a-d59b-4fec-8513-8f2f12619eaf');
  assert.equal(resolution.selected.acceptance_status, 'ACCEPTED');
  assert.equal(resolution.selected.acceptance_evidence.certification_status, 'CERTIFIED');
});

test('later TESTING record cannot replace accepted baseline', () => {
  const resolution = resolveAuthoritativeBaselineConnector(context());
  assert.notEqual(resolution.selected.id, laterTesting.id);
  assert.ok(resolution.supplemental.some(row => row.id === laterTesting.id));
});

test('generic catalog identifier cannot override publisher configuration', () => {
  const resolution = resolveAuthoritativeBaselineConnector(context());
  assert.notEqual(resolution.selected.id, genericAccepted.id);
  assert.equal(resolution.configured_connector_key, 'LA_COUNTY_ECAPS');
});

test('rendered report exposes exact authoritative baseline evidence', () => {
  const report = buildMissionReport(context(), {
    generatedAt: '2026-08-06T04:30:00.000Z',
    reportId: 'MR-3258D329-V1',
    reportVersion: 1,
    reportState: 'DRAFT',
    production: { context: 'deploy-preview' }
  });
  const baseline = report.publisher_and_connector.existing_baseline;
  assert.equal(baseline.connector_key, 'LA_COUNTY_ECAPS');
  assert.equal(baseline.connector_version, '1.2.0');
  assert.equal(baseline.connector_acceptance_record_id, accepted.id);
  assert.equal(baseline.existing_acceptance_status, 'ACCEPTED');
  assert.equal(baseline.existing_certification, 'CERTIFIED');
  assert.equal(baseline.last_verified_date, '2026-08-04T16:09:00.976Z');
  assert.equal(baseline.evidence_scope, 'EXISTING BASELINE ONLY');
});
