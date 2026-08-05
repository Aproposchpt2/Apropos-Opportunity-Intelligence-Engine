import * as base from './mission-reporting.js';
export * from './mission-reporting.js';

const STALL_SECONDS = 60;
const VERIFY_STAGES = [
  'Approved Publisher Profile Loaded',
  'Connector Resolved',
  'Listing or Search Connection Tested',
  'Detail and Evidence Validation',
  'EAG-001 Certification Decision'
];
const upper = value => String(value || base.NOT_REPORTED).trim().toUpperCase().replaceAll(' ', '_');
const ms = value => {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const evidenceLabel = label => ({
  label,
  class: label === 'EXISTING BASELINE' ? 'baseline' : label === 'CURRENT RUN' ? 'current' : label === 'DERIVED ANALYSIS' ? 'derived' : 'not-reported'
});
const pick = (source, paths, fallback = undefined) => base.first({ source }, paths.map(path => `source.${path}`), fallback);

function baselinePriority(row) {
  return (upper(row?.acceptance_status) === 'ACCEPTED' ? 100 : 0) +
    (upper(row?.acceptance_evidence?.certification_status) === 'CERTIFIED' ? 50 : 0) +
    (upper(row?.validation_status) === 'PASSED' ? 25 : 0) +
    (row?.accepted_at ? 10 : 0);
}

function authoritativeStatus(context) {
  return upper(context.run?.status || context.run?.aadp_state);
}

function inactivitySeconds(context, generatedAt) {
  const start = ms(context.run?.last_activity_at || context.run?.updated_at || context.run?.created_at);
  const end = ms(generatedAt);
  return start === null || end === null ? null : Math.max(0, Math.floor((end - start) / 1000));
}

function operationalOutcome(context, generatedAt) {
  const lifecycle = base.normalizeRunOutcome(context.run?.status || context.run?.aadp_state);
  if (lifecycle !== 'DRAFT') return lifecycle;
  const status = authoritativeStatus(context);
  if (['QUEUED', 'PENDING', 'CREATED'].includes(status)) {
    const idle = inactivitySeconds(context, generatedAt);
    return !base.workerClaimed(context) && idle !== null && idle > STALL_SECONDS ? 'STALLED_AT_CAPTURE' : 'QUEUED_AT_CAPTURE';
  }
  if (['RUNNING', 'PROCESSING', 'RETRYING', 'STOPPING'].includes(status)) return 'RUNNING_AT_CAPTURE';
  return `${status === base.NOT_REPORTED ? 'UNKNOWN' : status}_AT_CAPTURE`;
}

function currentEvidence(context) {
  const output = { ...(context.run?.execution_evidence || {}) };
  for (const row of context.tasks || []) Object.assign(output, row.execution_evidence || {}, row.measurable_result || {}, row.output_payload || {});
  for (const row of context.attempts || []) Object.assign(output, row.evidence || {});
  const connector = context.currentConnectorEvidence?.[0];
  return connector ? { ...output, ...connector, ...(connector.acceptance_evidence || {}) } : output;
}

function conciseBaseline(context) {
  const connector = context.baselineConnectorEvidence?.[0];
  if (!connector && !context.publisher) return { evidence_label: evidenceLabel('NOT REPORTED'), value: base.NOT_REPORTED };
  const source = {
    publisher: context.publisher || {}, connector: connector || {},
    acceptance: connector?.acceptance_evidence || {}, configuration: context.publisher?.configuration || {}
  };
  return {
    evidence_label: evidenceLabel('EXISTING BASELINE'),
    publisher_name: pick(source, ['publisher.publisher_name'], base.NOT_REPORTED),
    publisher_id: pick(source, ['publisher.id', 'connector.publisher_id'], base.NOT_REPORTED),
    connector_key: pick(source, ['connector.connector_key', 'configuration.connector_key'], base.NOT_REPORTED),
    connector_version: pick(source, ['connector.connector_version', 'acceptance.connector_version', 'configuration.connector_version'], base.NOT_REPORTED),
    existing_certification: pick(source, ['acceptance.certification_status', 'configuration.certification_status'], base.NOT_REPORTED),
    existing_acceptance_status: pick(source, ['connector.acceptance_status'], base.NOT_REPORTED),
    last_verified_date: pick(source, ['acceptance.verified_at', 'connector.tested_at', 'connector.accepted_at', 'publisher.last_verified_at'], base.NOT_REPORTED),
    existing_sample_size: pick(source, ['acceptance.sample_size'], base.NOT_REPORTED),
    existing_detail_page_result: pick(source, ['acceptance.detail_pages_successful', 'acceptance.detail_pages_passed'], base.NOT_REPORTED),
    existing_attachment_result: pick(source, ['acceptance.attachments_detected'], base.NOT_REPORTED),
    existing_contact_result: pick(source, ['acceptance.contacts_successful', 'acceptance.contacts_detected'], base.NOT_REPORTED),
    existing_requirements_result: pick(source, ['acceptance.requirements_successful', 'acceptance.requirements_detected', 'acceptance.requirements_status'], base.NOT_REPORTED),
    existing_pagination_result: pick(source, ['acceptance.pagination_status', 'acceptance.pagination_result'], base.NOT_REPORTED),
    official_endpoint: pick(source, ['acceptance.source_url', 'publisher.search_endpoint', 'configuration.primary_endpoint'], base.NOT_REPORTED),
    reference: 'Full baseline evidence is available in the machine-readable JSON export and expandable Evidence Appendix.'
  };
}

function conciseCurrent(context) {
  const row = context.currentConnectorEvidence?.[0];
  return row ? {
    evidence_label: evidenceLabel('CURRENT RUN'),
    connector_record_id: row.id || base.NOT_REPORTED,
    connector_key: row.connector_key || base.NOT_REPORTED,
    connector_version: row.connector_version || base.NOT_REPORTED,
    acceptance_status: row.acceptance_status || base.NOT_REPORTED,
    validation_status: row.validation_status || base.NOT_REPORTED,
    tested_at: row.tested_at || base.NOT_REPORTED
  } : {
    evidence_label: evidenceLabel('NOT REPORTED'), value: base.NOT_REPORTED,
    note: 'No connector acceptance record is tied to this command_run_id. Historical certification is baseline only.'
  };
}

function event(timestamp, name, status, source, classification = 'CURRENT RUN', detail = {}) {
  return timestamp ? { timestamp, event: name, status, evidence_classification: classification, evidence_source: source, ...detail } : null;
}

function verificationTimeline(context, generatedAt, outcome) {
  const rows = [event(context.run?.created_at, 'Run created', 'CREATED', 'command_runs.created_at')];
  const status = authoritativeStatus(context);
  if (['QUEUED', 'PENDING', 'CREATED'].includes(status) || upper(context.run?.current_stage).includes('QUEUED')) {
    const created = ms(context.run?.created_at), started = ms(context.run?.started_at);
    const queuedAt = started !== null && (created === null || started >= created) ? context.run.started_at : context.run?.created_at || context.run?.started_at;
    rows.push(event(queuedAt, 'Run queued', 'QUEUED', queuedAt === context.run?.started_at ? 'command_runs.started_at + current_stage' : 'command_runs.created_at + current_stage', 'CURRENT RUN',
      started !== null && created !== null && started < created ? { note: 'started_at predates row creation; created_at preserves evidence chronology.' } : {}));
  }
  if (base.workerClaimed(context)) {
    const claim = context.run?.execution_evidence?.worker_claimed_at || [...(context.attempts || []), ...(context.tasks || [])]
      .map(row => row.started_at).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
    rows.push(event(claim, 'Worker claimed', 'CLAIMED', 'current-run task or attempt evidence'));
  }
  for (const row of context.tasks || []) rows.push(event(row.started_at, `Worker activity: ${row.task_type || 'Task'}`, upper(row.state), 'command_tasks'));
  for (const row of context.attempts || []) rows.push(event(row.started_at, `Worker activity: attempt ${row.attempt_number || base.NOT_REPORTED}`, upper(row.state), 'command_task_attempts'));
  if (outcome === 'STALLED_AT_CAPTURE') {
    const last = ms(context.run?.last_activity_at || context.run?.updated_at || context.run?.created_at);
    rows.push(event(last === null ? null : new Date(last + STALL_SECONDS * 1000).toISOString(), 'Stall threshold exceeded', outcome,
      'derived from command_runs.last_activity_at and 60-second threshold', 'DERIVED ANALYSIS', { threshold_seconds: STALL_SECONDS }));
  }
  rows.push(event(context.run?.stop_requested_at, 'Operator stop request', 'STOP REQUESTED', 'command_runs.stop_requested_at'));
  rows.push(event(context.run?.completed_at, 'Run completed', status, 'command_runs.completed_at'));
  rows.push(event(generatedAt, 'Report generated', 'RECORDED', 'mission reporting system'));
  return rows.filter(Boolean).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function stage(name, status, classification, context, evidence = base.NOT_REPORTED, timestamp = base.NOT_REPORTED) {
  return {
    stage_name: name, stage_status: status, evidence_classification: classification,
    start_time: timestamp, completion_time: status === 'CURRENT RUN CONFIRMED' ? timestamp : base.NOT_REPORTED,
    responsible_agent: context.run?.assigned_agent || base.NOT_REPORTED,
    supporting_evidence: evidence, metrics_produced: base.NOT_REPORTED,
    warnings: base.NOT_REPORTED, errors: base.NOT_REPORTED, checkpoint: base.NOT_REPORTED,
    evidence_source: classification === 'EXISTING BASELINE' ? 'publisher_registry / connector_acceptance_registry' : classification === 'CURRENT RUN' ? 'current-run execution evidence' : base.NOT_REPORTED
  };
}

function verificationStages(context) {
  const evidence = currentEvidence(context), row = context.currentConnectorEvidence?.[0];
  const time = row?.tested_at || row?.created_at || row?.updated_at || base.NOT_REPORTED;
  const hasBaseline = Boolean(context.publisher || context.baselineConnectorEvidence?.[0]);
  const resolved = Boolean(row || pick(evidence, ['connector_key', 'connector_version']));
  const tested = base.reported(pick(evidence, ['endpoint_tested', 'endpoint', 'source_url', 'http_status', 'connection', 'search_http_result']));
  const detailed = base.reported(pick(evidence, ['sample_size', 'detail_pages_successful', 'detail_pages_passed', 'attachments_detected', 'contacts_successful', 'contacts_detected', 'requirements_successful', 'requirements_detected']));
  const decided = base.reported(pick(evidence, ['certification_decision', 'certification_status', 'eag_001_result'])) || Boolean(row?.acceptance_status && !['TESTING', 'PENDING'].includes(upper(row.acceptance_status)));
  const currentStage = (name, confirmed, detail) => stage(name, confirmed ? 'CURRENT RUN CONFIRMED' : 'NOT STARTED', confirmed ? 'CURRENT RUN' : 'NOT REPORTED', context, confirmed ? detail : base.NOT_REPORTED, confirmed ? time : base.NOT_REPORTED);
  return [
    stage(VERIFY_STAGES[0], hasBaseline ? 'EXISTING BASELINE CONFIRMED' : base.NOT_REPORTED, hasBaseline ? 'EXISTING BASELINE' : 'NOT REPORTED', context, hasBaseline ? conciseBaseline(context) : base.NOT_REPORTED),
    currentStage(VERIFY_STAGES[1], resolved, { connector_key: pick(evidence, ['connector_key'], base.NOT_REPORTED), connector_version: pick(evidence, ['connector_version'], base.NOT_REPORTED) }),
    currentStage(VERIFY_STAGES[2], tested, { endpoint: pick(evidence, ['endpoint_tested', 'endpoint', 'source_url'], base.NOT_REPORTED), result: pick(evidence, ['http_status', 'connection', 'search_http_result'], base.NOT_REPORTED) }),
    currentStage(VERIFY_STAGES[3], detailed, { sample_size: pick(evidence, ['sample_size'], base.NOT_REPORTED), detail_pages: pick(evidence, ['detail_pages_successful', 'detail_pages_passed'], base.NOT_REPORTED), attachments: pick(evidence, ['attachments_detected'], base.NOT_REPORTED), contacts: pick(evidence, ['contacts_successful', 'contacts_detected'], base.NOT_REPORTED), requirements: pick(evidence, ['requirements_successful', 'requirements_detected'], base.NOT_REPORTED) }),
    currentStage(VERIFY_STAGES[4], decided, { decision: pick(evidence, ['certification_decision', 'certification_status', 'eag_001_result'], base.NOT_REPORTED), acceptance_status: row?.acceptance_status || base.NOT_REPORTED })
  ];
}

function sourceCount(context, name, rows) {
  const source = (context.sourceStatus || []).find(item => item.source === name);
  return source?.status === 'READ'
    ? { value: (rows || []).length, evidence_classification: 'DERIVED ANALYSIS', evidence_source: `${name} successful query`, query_status: 'READ' }
    : { value: base.NOT_REPORTED, evidence_classification: 'NOT REPORTED', evidence_source: base.NOT_REPORTED, query_status: source?.status || 'NOT QUERIED' };
}

function applyZeroAudit(report, context, missionType) {
  if (missionType === 'VERIFY_PUBLISHER_CONNECTION' && !base.workerClaimed(context)) {
    report.records_or_documents_affected = {
      total: base.NOT_REPORTED, returned: base.NOT_REPORTED, truncated: base.NOT_REPORTED, records: base.NOT_REPORTED,
      evidence_classification: 'NOT REPORTED', note: 'This verification run produced no worker execution. A records-affected count does not apply.'
    };
  }
  report.registry_or_database_impact.affected_table_counts = {
    command_tasks: sourceCount(context, 'command_tasks', context.tasks),
    command_task_attempts: sourceCount(context, 'command_task_attempts', context.attempts),
    publisher_discovery_candidates: sourceCount(context, 'publisher_discovery_candidates', context.candidates),
    acquisition_runs: sourceCount(context, 'acquisition_runs', context.acquisitionRuns),
    acquisition_raw_records: sourceCount(context, 'acquisition_raw_records', context.rawRecords),
    contract_package_documents: sourceCount(context, 'contract_package_documents', context.packageDocs),
    state_contract_opportunities: sourceCount(context, 'state_contract_opportunities', context.opportunities)
  };
}

function attachRawEvidence(report, context) {
  report.evidence_appendix = {
    ...(report.evidence_appendix || {}),
    primary_report_reference: 'Full baseline and current-run raw evidence is available here and in the machine-readable JSON export. This appendix is excluded from the primary print/PDF narrative.',
    raw_baseline_evidence: { publisher_profile: context.publisher || base.NOT_REPORTED, connector_acceptance: context.baselineConnectorEvidence?.[0] || base.NOT_REPORTED },
    raw_current_run_evidence: {
      connector_acceptance: context.currentConnectorEvidence?.[0] || base.NOT_REPORTED,
      tasks: context.tasks || [], attempts: context.attempts || [], stages: context.stages || [],
      events: context.events || [], failures: context.failures || [], metrics: context.metrics || []
    }
  };
}

export function reportHash(report) {
  const snapshot = structuredClone(report);
  if (snapshot.report_metadata) delete snapshot.report_metadata.report_hash;
  const hash = base.reportHash(snapshot);
  if (report.report_metadata) report.report_metadata.report_hash = hash;
  return hash;
}

export function buildMissionReport(context, options = {}) {
  const hardened = { ...context, baselineConnectorEvidence: [...(context.baselineConnectorEvidence || [])].sort((a, b) => baselinePriority(b) - baselinePriority(a)) };
  const report = base.buildMissionReport(hardened, options);
  const missionType = base.normalizeMissionType(hardened.run?.mission_type_key || hardened.mission?.mission_type_key);
  const generatedAt = report.report_metadata?.generated_at || options.generatedAt || new Date().toISOString();
  const lifecycle = report.report_metadata?.report_state || (base.normalizeRunOutcome(hardened.run?.status || hardened.run?.aadp_state) === 'DRAFT' ? 'DRAFT' : 'FINAL');
  const outcome = operationalOutcome(hardened, generatedAt), authority = authoritativeStatus(hardened), claimed = base.workerClaimed(hardened);

  Object.assign(report.report_metadata, {
    production_deployment_context: options.production?.context || base.NOT_REPORTED,
    report_generation_timestamp: generatedAt,
    report_generator_version: 'APIE-MISSION-REPORTING-1.1-TRUTH-CORRECTION',
    report_hash: base.NOT_REPORTED
  });
  Object.assign(report.executive_determination, {
    report_lifecycle_state: lifecycle, authoritative_run_status: authority,
    derived_operational_outcome: outcome, outcome, worker_claimed: claimed
  });
  Object.assign(report.run_status, {
    report_lifecycle_state: lifecycle, authoritative_status: authority,
    derived_operational_outcome: outcome, report_outcome: outcome, worker_claimed: claimed,
    inactivity_seconds_at_capture: inactivitySeconds(hardened, generatedAt) ?? base.NOT_REPORTED,
    stall_threshold_seconds: STALL_SECONDS
  });

  if (missionType === 'VERIFY_PUBLISHER_CONNECTION') {
    if (outcome === 'STALLED_AT_CAPTURE') {
      report.executive_determination.determination = 'STALLED BEFORE WORKER CLAIM';
      report.executive_determination.summary = 'The authoritative run remains QUEUED. No worker claim exists, and the 60-second inactivity threshold was exceeded at report capture.';
      report.final_acceptance_decision.determination = 'STALLED BEFORE WORKER CLAIM';
      report.final_acceptance_decision.accepted = false;
    } else if (outcome === 'QUEUED_AT_CAPTURE' && lifecycle === 'DRAFT') {
      report.executive_determination.determination = 'REVIEW REQUIRED';
      report.executive_determination.summary = 'The authoritative run is QUEUED and has not exceeded the stall threshold at report capture.';
      report.final_acceptance_decision.determination = 'REVIEW REQUIRED';
      report.final_acceptance_decision.accepted = false;
    }
    report.publisher_and_connector.existing_baseline = conciseBaseline(hardened);
    report.publisher_and_connector.current_run = conciseCurrent(hardened);
    report.publisher_and_connector.assignment = hardened.assignment ? { evidence_label: evidenceLabel('EXISTING BASELINE'), id: hardened.assignment.id || base.NOT_REPORTED, status: hardened.assignment.status || base.NOT_REPORTED } : base.NOT_REPORTED;
    report.execution_timeline = verificationTimeline(hardened, generatedAt, outcome);
    report.stage_by_stage_evidence = verificationStages(hardened);
  }

  applyZeroAudit(report, hardened, missionType);
  attachRawEvidence(report, hardened);
  report.operator_actions = [
    ...(base.reported(hardened.run?.stop_requested_at) ? [{ action: 'STOP REQUESTED', timestamp: hardened.run.stop_requested_at, evidence_source: 'command_runs' }] : []),
    ...(hardened.audit || []).map(row => ({
      action: row.action_type || row.action || row.event_type || row.operation || base.NOT_REPORTED,
      timestamp: row.occurred_at || row.created_at || base.NOT_REPORTED,
      actor: row.actor_id || row.actor || row.performed_by || row.actor_type || base.NOT_REPORTED,
      actor_type: row.actor_type || base.NOT_REPORTED, reason: row.reason || base.NOT_REPORTED,
      evidence_source: 'command_audit_log'
    }))
  ];
  if (!report.operator_actions.length) report.operator_actions = [{ action: base.NOT_REPORTED, timestamp: base.NOT_REPORTED, evidence_source: base.NOT_REPORTED }];
  return report;
}
