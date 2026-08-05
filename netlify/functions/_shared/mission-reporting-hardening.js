import * as base from './mission-reporting.js';

export * from './mission-reporting.js';

function baselinePriority(row) {
  const acceptance = String(row?.acceptance_status || '').toUpperCase();
  const validation = String(row?.validation_status || '').toUpperCase();
  const certification = String(row?.acceptance_evidence?.certification_status || '').toUpperCase();
  return (acceptance === 'ACCEPTED' ? 100 : 0) +
    (certification === 'CERTIFIED' ? 50 : 0) +
    (validation === 'PASSED' ? 25 : 0) +
    (row?.accepted_at ? 10 : 0);
}

export function buildMissionReport(context, options = {}) {
  const hardenedContext = {
    ...context,
    baselineConnectorEvidence: [...(context.baselineConnectorEvidence || [])]
      .sort((left, right) => baselinePriority(right) - baselinePriority(left))
  };
  const report = base.buildMissionReport(hardenedContext, options);
  const missionType = base.normalizeMissionType(hardenedContext.run?.mission_type_key || hardenedContext.mission?.mission_type_key);
  const outcome = base.normalizeRunOutcome(hardenedContext.run?.status || hardenedContext.run?.aadp_state);

  if (missionType === 'VERIFY_PUBLISHER_CONNECTION' && outcome === 'DRAFT' && !base.workerClaimed(hardenedContext)) {
    const runState = `${hardenedContext.run?.status || ''} ${hardenedContext.run?.aadp_state || ''} ${hardenedContext.run?.current_stage || ''}`.toUpperCase();
    if (!runState.includes('STALL')) {
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
