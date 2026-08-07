import { randomUUID } from 'node:crypto';
import {
  db,
  header,
  parseBody,
  response,
  verifyDashboardToken
} from './_shared/native-runtime.js';
import { handler as legacyHandler } from './mission-report-legacy.js';
import { NOT_REPORTED } from './_shared/mission-reporting-hardening.js';

const enc = value => encodeURIComponent(String(value || ''));

function authenticatedOperator(event) {
  const authorization = String(header(event, 'authorization') || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return bearer ? verifyDashboardToken(bearer) : null;
}

function parseLegacyPayload(result) {
  if (!result || Number(result.statusCode) !== 200) return null;
  if (typeof result.body === 'object' && result.body !== null) return result.body;
  try {
    return JSON.parse(String(result.body || '{}'));
  } catch {
    return null;
  }
}

async function storedDraft(commandRunId, reportVersion) {
  const rows = await db(
    `mission_execution_reports?command_run_id=eq.${enc(commandRunId)}` +
    `&report_version=eq.${enc(reportVersion)}&select=*&limit=1`
  );
  return rows?.[0] || null;
}

function storedPayload(row) {
  return {
    report: row.report_data,
    storage: {
      id: row.id,
      report_id: row.report_id || row.report_data?.report_metadata?.report_id || NOT_REPORTED,
      command_run_id: row.command_run_id,
      mission_type_key: row.mission_type_key,
      report_version: row.report_version,
      report_state: row.report_state,
      operational_outcome: row.operational_outcome,
      authoritative_run_status: row.authoritative_run_status,
      report_hash: row.report_hash,
      generated_at: row.generated_at,
      finalized_at: row.finalized_at,
      amended_at: row.amended_at,
      supersedes_report_id: row.supersedes_report_id,
      production_provenance: row.production_provenance
    },
    persisted: true
  };
}

function migrationPendingPayload(payload, error) {
  return {
    ...payload,
    storage: {
      ...(payload.storage || {}),
      persistence_status: 'MIGRATION_REQUIRED',
      migration: '20260806040000_mission_report_lifecycle_source_of_truth_v2.sql',
      authoritative_database_modified: false,
      migration_error_code: error?.code || NOT_REPORTED
    },
    persisted: false
  };
}

function isLifecycleMigrationPending(error) {
  const message = String(error?.message || error || '');
  return ['23514', '42703', 'PGRST204'].includes(String(error?.code || '')) ||
    /report_state_check|state_fields_check|report_id|operational_outcome|authoritative_run_status|production_provenance/i.test(message);
}

export const handler = async event => {
  const legacyResult = await legacyHandler(event);
  const payload = parseLegacyPayload(legacyResult);

  if (!payload || payload.persisted !== false || String(payload.storage?.report_state || '').toUpperCase() !== 'DRAFT') {
    return legacyResult;
  }

  const operator = authenticatedOperator(event);
  if (!operator) return legacyResult;

  const body = parseBody(event);
  const commandRunId = String(body.command_run_id || body.run_id || payload.storage?.command_run_id || '').trim();
  const reportVersion = Number(payload.storage?.report_version || payload.report?.report_metadata?.report_version || 1);
  if (!commandRunId) return legacyResult;

  try {
    const existing = await storedDraft(commandRunId, reportVersion);
    if (existing) return response(200, storedPayload(existing));

    const report = payload.report;
    const metadata = report?.report_metadata || {};
    const outcome = report?.executive_determination?.derived_operational_outcome || report?.run_status?.derived_operational_outcome || NOT_REPORTED;
    const authoritativeStatus = report?.executive_determination?.authoritative_run_status || report?.run_status?.authoritative_status || NOT_REPORTED;
    const productionProvenance = {
      preview_git_commit: metadata.preview_git_commit || NOT_REPORTED,
      preview_netlify_deploy: metadata.preview_netlify_deploy || NOT_REPORTED,
      preview_url: metadata.preview_url || NOT_REPORTED,
      preview_context: metadata.production_deployment_context || NOT_REPORTED,
      production_baseline_git_commit: metadata.production_baseline_git_commit || NOT_REPORTED,
      production_baseline_netlify_deploy: metadata.production_baseline_netlify_deploy || NOT_REPORTED,
      production_baseline_url: metadata.production_baseline_url || NOT_REPORTED,
      report_generator_version: metadata.report_generator_version || NOT_REPORTED
    };

    const inserted = await db('mission_execution_reports', {
      method: 'POST',
      body: JSON.stringify({
        id: randomUUID(),
        report_id: metadata.report_id,
        command_run_id: commandRunId,
        mission_type_key: report?.mission_identity?.mission_type_key || payload.storage?.mission_type_key,
        report_version: reportVersion,
        report_state: 'DRAFT',
        operational_outcome: outcome,
        authoritative_run_status: authoritativeStatus,
        report_data: report,
        report_hash: payload.storage?.report_hash || metadata.report_hash,
        generated_at: metadata.generated_at || payload.storage?.generated_at,
        finalized_at: null,
        supersedes_report_id: null,
        production_provenance: productionProvenance,
        created_by: operator.email
      })
    });
    return response(200, storedPayload(inserted[0]));
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await storedDraft(commandRunId, reportVersion);
      if (existing) return response(200, storedPayload(existing));
    }
    if (isLifecycleMigrationPending(error)) {
      return response(200, migrationPendingPayload(payload, error));
    }
    throw error;
  }
};
