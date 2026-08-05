import * as base from './mission-reporting.js';

export * from './mission-reporting.js';

export function buildMissionReport(context, options = {}) {
  const report = base.buildMissionReport(context, options);
  const missionType = base.normalizeMissionType(context.run?.mission_type_key || context.mission?.mission_type_key);
  const outcome = base.normalizeRunOutcome(context.run?.status || context.run?.aadp_state);

  if (missionType === 'VERIFY_PUBLISHER_CONNECTION' && outcome === 'DRAFT' && !base.workerClaimed(context)) {
    const runState = `${context.run?.status || ''} ${context.run?.aadp_state || ''} ${context.run?.current_stage || ''}`.toUpperCase();
    if (!runState.includes('STALL')) {
      report.executive_determination.determination = 'REVIEW REQUIRED';
      report.final_acceptance_decision.determination = 'REVIEW REQUIRED';
      report.final_acceptance_decision.accepted = false;
    }
  }

  const operatorActions = [];
  if (base.reported(context.run?.stop_requested_at)) {
    operatorActions.push({
      action: 'STOP REQUESTED',
      timestamp: context.run.stop_requested_at,
      evidence_source: 'command_runs'
    });
  }
  for (const row of context.audit || []) {
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
