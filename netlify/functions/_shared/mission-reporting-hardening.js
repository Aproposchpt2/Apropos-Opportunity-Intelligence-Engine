import * as base from './mission-reporting.js';

export * from './mission-reporting.js';

export const REPORT_GENERATOR_VERSION = 'APIE-MISSION-REPORTING-1.1';
export const QUEUED_WORKER_STALL_THRESHOLD_SECONDS = 60;

const VERIFY_STAGES = Object.freeze([
  'Approved Publisher Profile Loaded',
  'Connector Resolved',
  'Listing or Search Connection Tested',
  'Detail and Evidence Validation',
  'EAG-001 Certification Decision'
]);

function baselinePriority(row) {
  const acceptance = String(row?.acceptance_status || '').toUpperCase();
  const validation = String(row?.validation_status || '').toUpperCase();
  const certification = String(row?.acceptance_evidence?.certification_status || '').toUpperCase();
  return (acceptance === 'ACCEPTED' ? 100 : 0) +
    (certification === 'CERTIFIED' ? 50 : 0) +
    (validation === 'PASSED' ? 25 : 0) +
    (row?.accepted_at ? 10 : 0);
}

function timestamp(value) {
  const parsed = new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function authoritativeStatus(context) {
  return String(context.run?.status || context.run?.aadp_state || base.NOT_REPORTED)
    .trim()
    .toUpperCase()
    .replaceAll(' ', '_');
}

export function deriveOperationalOutcome(context, generatedAt = new Date().toISOString()) {
  const status = authoritativeStatus(context);
  const normalized = base.normalizeRunOutcome(status);
  if (normalized !== 'DRAFT') return normalized;

  if (!base.workerClaimed(context) && ['QUEUED', 'PENDING', 'CREATED'].includes(status)) {
    const last = timestamp(
      context.run?.last_activity_at ||
      context.run?.updated_at ||
      context.run?.created_at ||
      context.run?.started_at
    );
    const capture = timestamp(generatedAt);
    if (last && capture) {
      const elapsedSeconds = Math.max(0, (capture.getTime() - last.getTime()) / 1000);
      return elapsedSeconds >= QUEUED_WORKER_STALL_THRESHOLD_SECONDS
        ? 'STALLED_AT_CAPTURE'
        : 'QUEUED_AT_CAPTURE';
    }
    return 'QUEUED_AT_CAPTURE';
  }

  return base.workerClaimed(context) ? 'RUNNING_AT_CAPTURE' : 'DRAFT_AT_CAPTURE';
}

function stallThresholdTimestamp(context) {
  const last = timestamp(
    context.run?.last_activity_at ||
    context.run?.updated_at ||
    context.run?.created_at ||
    context.run?.started_at
  );
  return last
    ? new Date(last.getTime() + QUEUED_WORKER_STALL_THRESHOLD_SECONDS * 1000).toISOString()
    : null;
}

function matchedStageEvidence(context, stageName) {
  const rows = [
    ...(context.stages || []),
    ...(context.tasks || []).map(row => ({ ...row, stage_name: row.task_type, status: row.state, __source: 'command_tasks' }))
  ];
  const tokens = stageName.toUpperCase().split(/\W+/).filter(token => token.length > 4);
  return rows.find(row => {
    const haystack = String(row.stage_name || row.display_name || row.stage_key || row.task_type || '').toUpperCase();
    return tokens.some(token => haystack.includes(token));
  });
}

function verifyStageEvidence(context) {
  return VERIFY_STAGES.map(stageName => {
    const row = matchedStageEvidence(context, stageName);
    if (!row) return {
      stage_name: stageName,
      stage_status: base.NOT_REPORTED,
      start_time: base.NOT_REPORTED,
      completion_time: base.NOT_REPORTED,
      responsible_agent: context.run?.assigned_agent || base.NOT_REPORTED,
      supporting_evidence: base.NOT_REPORTED,
      metrics_produced: base.NOT_REPORTED,
      warnings: base.NOT_REPORTED,
      errors: base.NOT_REPORTED,
      checkpoint: base.NOT_REPORTED,
      evidence_source: 'CURRENT RUN — no task, attempt, or stage evidence emitted'
    };
    return base.buildStageEvidence({ ...context, stages: [row], tasks: [] })[0];
  });
}

function correctedTimeline(report, context, generatedAt, operationalOutcome) {
  const rows = (report.execution_timeline || []).filter(item =>
    item.event !== 'Run started / worker claimed' && item.event !== 'Report generated'
  );

  if (operationalOutcome === 'STALLED_AT_CAPTURE') {
    rows.push({
      timestamp: stallThresholdTimestamp(context) || generatedAt,
      event: 'Queued-worker stall threshold exceeded',
      status: 'STALLED_AT_CAPTURE',
      evidence_source: 'DERIVED ANALYSIS',
      threshold_seconds: QUEUED_WORKER_STALL_THRESHOLD_SECONDS,
      detail: 'No worker task or attempt was recorded before the queued-worker threshold elapsed.'
    });
  }

  rows.push({
    timestamp: generatedAt,
    event: 'Report generated',
    status: 'RECORDED',
    evidence_source: 'mission reporting system'
  });

  return rows
    .filter(item => item?.timestamp)
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

function baselineCertificationSummary(baseline) {
  const certification = String(baseline?.acceptance_evidence?.certification_status || '').toUpperCase();
  const accepted = String(baseline?.acceptance_status || '').toUpperCase();
  return certification === 'CERTIFIED' && accepted === 'ACCEPTED'
    ? 'CERTIFIED — EXISTING BASELINE ONLY'
    : base.NOT_REPORTED;
}

export function attachReportHash(report, hash) {
  report.report_metadata.report_hash = hash || base.NOT_REPORTED;
  return report;
}

export function buildMissionReport(context, options = {}) {
  const hardenedContext = {
    ...context,
    baselineConnectorEvidence: [...(context.baselineConnectorEvidence || [])]
      .sort((left, right) => baselinePriority(right) - baselinePriority(left))
  };
  const report = base.buildMissionReport(hardenedContext, options);
  const missionType = base.normalizeMissionType(
    hardenedContext.run?.mission_type_key || hardenedContext.mission?.mission_type_key
  );
  const generatedAt = report.report_metadata.generated_at;
  const operationalOutcome = deriveOperationalOutcome(hardenedContext, generatedAt);
  const lifecycleState = report.report_metadata.report_state;

  report.report_metadata.report_generator_version = REPORT_GENERATOR_VERSION;
  report.report_metadata.deployment_context = options.production?.context || base.NOT_REPORTED;
  report.report_metadata.report_hash = base.NOT_REPORTED;

  report.executive_determination.report_lifecycle_state = lifecycleState;
  report.executive_determination.operational_outcome = operationalOutcome;
  report.run_status.report_state = lifecycleState;
  report.run_status.authoritative_status = authoritativeStatus(hardenedContext);
  report.run_status.derived_operational_outcome = operationalOutcome;
  report.run_status.worker_claimed = base.workerClaimed(hardenedContext);

  if (missionType === 'VERIFY_PUBLISHER_CONNECTION') {
    report.stage_by_stage_evidence = verifyStageEvidence(hardenedContext);
    report.execution_timeline = correctedTimeline(report, hardenedContext, generatedAt, operationalOutcome);

    const baseline = report.publisher_and_connector?.existing_baseline;
    if (baseline?.connector) {
      baseline.certification_summary = baselineCertificationSummary(baseline.connector);
      baseline.context_notice = 'Historical certification is contextual baseline evidence and is not credited to this run.';
    }

    if (!base.workerClaimed(hardenedContext)) {
      report.publisher_and_connector.current_run = {
        evidence_label: { label: 'NOT REPORTED', class: 'not-reported' },
        value: base.NOT_REPORTED,
        eag_001_result: base.NOT_REPORTED,
        note: 'No current-run worker task or attempt occurred. Existing connector certification remains baseline-only.'
      };
    }

    if (operationalOutcome === 'STALLED_AT_CAPTURE') {
      report.executive_determination.determination = 'STALLED BEFORE WORKER CLAIM';
      report.executive_determination.summary =
        'The report lifecycle state is DRAFT. At capture, the authoritative run remained QUEUED and had exceeded the worker-claim threshold without a task or attempt.';
      report.final_acceptance_decision.determination = 'STALLED BEFORE WORKER CLAIM';
      report.final_acceptance_decision.accepted = false;
    } else if (lifecycleState === 'DRAFT' && !base.workerClaimed(hardenedContext)) {
      report.executive_determination.determination = 'REVIEW REQUIRED';
      report.final_acceptance_decision.determination = 'REVIEW REQUIRED';
      report.final_acceptance_decision.accepted = false;
    }
  }

  const operatorActions = [];
  if (base.reported(hardenedContext.run?.stop_requested_at)) {
    operatorActions.push({
      action: 'STOP REQUESTED',
      timestamp: hardenedContext.run.stop_requested_at,
      evidence_source: 'command_runs'
    });
  }
  for (const row of hardenedContext.audit || []) {
    operatorActions.push({
      action: row.action_type || row.action || row.event_type || row.operation || base.NOT_REPORTED,
      timestamp: row.occurred_at || row.created_at || base.NOT_REPORTED,
      actor: row.actor_id || row.actor || row.performed_by || row.actor_type || base.NOT_REPORTED,
      actor_type: row.actor_type || base.NOT_REPORTED,
      reason: row.reason || base.NOT_REPORTED,
      evidence_source: 'command_audit_log'
    });
  }
  report.operator_actions = operatorActions.length
    ? operatorActions
    : [{ action: base.NOT_REPORTED, timestamp: base.NOT_REPORTED, evidence_source: base.NOT_REPORTED }];

  return report;
}
