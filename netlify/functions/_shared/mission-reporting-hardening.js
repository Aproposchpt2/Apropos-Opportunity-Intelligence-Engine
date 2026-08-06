import * as v1 from './mission-reporting-hardening-v1.js';
export * from './mission-reporting-hardening-v1.js';

const normalized = value => String(value || '').trim().toUpperCase();
const same = (left, right) => normalized(left) === normalized(right);
const certified = (row, configuration = {}) => same(
  row?.acceptance_evidence?.certification_status || row?.certification_status || configuration?.certification_status,
  'CERTIFIED'
);
const accepted = row => same(row?.acceptance_status, 'ACCEPTED');

function evidenceTimestamp(row) {
  return row?.acceptance_evidence?.verified_at || row?.tested_at || row?.accepted_at || row?.updated_at || row?.created_at || null;
}

function evidenceScore(row, configuredAcceptanceId, configuration) {
  return (String(row?.id || '') === String(configuredAcceptanceId || '') ? 10_000 : 0) +
    (accepted(row) ? 1_000 : 0) +
    (certified(row, configuration) ? 100 : 0) +
    (same(row?.validation_status, 'PASSED') ? 10 : 0) +
    (evidenceTimestamp(row) ? new Date(evidenceTimestamp(row)).getTime() / 1e15 : 0);
}

/**
 * Resolve the publisher's authoritative baseline connector.
 *
 * Evidence hierarchy:
 * 1. Publisher Registry configured connector key and version.
 * 2. Matching ACCEPTED connector-acceptance record.
 * 3. Matching certification evidence.
 * 4. TESTING/warning and generic catalog records remain supplemental only.
 */
export function resolveAuthoritativeBaselineConnector(context = {}) {
  const configuration = context.publisher?.configuration || {};
  const configuredKey = configuration.connector_key || null;
  const configuredVersion = configuration.connector_version || null;
  const configuredAcceptanceId = configuration.approval_evidence?.connector_acceptance_registry_id || null;
  const rows = [...(context.baselineConnectorEvidence || [])];

  if (!configuredKey || !configuredVersion) {
    return {
      selected: null,
      supplemental: rows,
      configured_connector_key: configuredKey || v1.NOT_REPORTED,
      configured_connector_version: configuredVersion || v1.NOT_REPORTED,
      configured_acceptance_record_id: configuredAcceptanceId || v1.NOT_REPORTED,
      selection_status: 'PUBLISHER CONFIGURATION NOT REPORTED'
    };
  }

  const configuredMatches = rows.filter(row =>
    same(row?.connector_key, configuredKey) &&
    same(row?.connector_version, configuredVersion)
  );
  const acceptedMatches = configuredMatches.filter(accepted);
  const exactAccepted = acceptedMatches.find(row => String(row?.id || '') === String(configuredAcceptanceId || '')) || null;
  const selected = exactAccepted || [...acceptedMatches].sort(
    (left, right) => evidenceScore(right, configuredAcceptanceId, configuration) - evidenceScore(left, configuredAcceptanceId, configuration)
  )[0] || null;

  return {
    selected,
    supplemental: rows.filter(row => row !== selected),
    configured_connector_key: configuredKey,
    configured_connector_version: configuredVersion,
    configured_acceptance_record_id: configuredAcceptanceId || v1.NOT_REPORTED,
    selection_status: selected ? 'AUTHORITATIVE BASELINE RESOLVED' : 'MATCHING ACCEPTED BASELINE NOT REPORTED',
    selection_hierarchy: [
      'PUBLISHER_REGISTRY_CONFIGURATION',
      'MATCHING_ACCEPTED_CONNECTOR_ACCEPTANCE_RECORD',
      'MATCHING_CERTIFICATION_EVIDENCE',
      'SUPPLEMENTAL_TESTING_OR_WARNING_EVIDENCE'
    ]
  };
}

export function buildMissionReport(context, options = {}) {
  const resolution = resolveAuthoritativeBaselineConnector(context);
  const hardened = {
    ...context,
    baselineConnectorEvidence: resolution.selected
      ? [resolution.selected, ...resolution.supplemental]
      : []
  };
  const report = v1.buildMissionReport(hardened, options);

  if (report?.report_metadata) {
    report.report_metadata.report_generator_version = 'APIE-MISSION-REPORTING-1.2-TRUTH-CORRECTION-SOURCE-OF-TRUTH';
  }

  if (report?.publisher_and_connector) {
    const existing = report.publisher_and_connector.existing_baseline || {};
    const configuration = context.publisher?.configuration || {};
    const selected = resolution.selected;
    Object.assign(existing, {
      publisher_id: context.publisher?.id || selected?.publisher_id || v1.NOT_REPORTED,
      connector_key: resolution.configured_connector_key,
      connector_version: resolution.configured_connector_version,
      connector_acceptance_record_id: selected?.id || v1.NOT_REPORTED,
      existing_acceptance_status: selected?.acceptance_status || v1.NOT_REPORTED,
      existing_certification: selected
        ? selected.acceptance_evidence?.certification_status || selected.certification_status || configuration.certification_status || v1.NOT_REPORTED
        : v1.NOT_REPORTED,
      last_verified_date: selected
        ? configuration.approval_evidence?.verified_at || selected.acceptance_evidence?.verified_at || selected.tested_at || selected.accepted_at || context.publisher?.last_verified_at || v1.NOT_REPORTED
        : v1.NOT_REPORTED,
      evidence_scope: 'EXISTING BASELINE ONLY',
      selection_status: resolution.selection_status,
      selection_hierarchy: resolution.selection_hierarchy
    });
    report.publisher_and_connector.existing_baseline = existing;
  }

  report.evidence_appendix = {
    ...(report.evidence_appendix || {}),
    authoritative_connector_resolution: {
      publisher_id: context.publisher?.id || v1.NOT_REPORTED,
      configured_connector_key: resolution.configured_connector_key,
      configured_connector_version: resolution.configured_connector_version,
      configured_acceptance_record_id: resolution.configured_acceptance_record_id,
      selected_acceptance_record: resolution.selected || v1.NOT_REPORTED,
      supplemental_connector_records: resolution.supplemental,
      selection_status: resolution.selection_status,
      selection_hierarchy: resolution.selection_hierarchy
    }
  };

  if (report.evidence_appendix?.raw_baseline_evidence) {
    report.evidence_appendix.raw_baseline_evidence.connector_acceptance = resolution.selected || v1.NOT_REPORTED;
    report.evidence_appendix.raw_baseline_evidence.supplemental_connector_records = resolution.supplemental;
  }

  return report;
}

export const reportHash = v1.reportHash;
