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

const confirmed = (checkpoint, evidenceSource, detail = null) => ({
  checkpoint,
  status: 'CONFIRMED',
  evidence_source: evidenceSource,
  ...(detail ? { detail } : {})
});

const notConfirmed = (checkpoint, evidenceSource, detail = null) => ({
  checkpoint,
  status: 'NOT CONFIRMED',
  evidence_source: evidenceSource,
  ...(detail ? { detail } : {})
});

const notApplicable = checkpoint => ({
  checkpoint,
  status: 'NOT APPLICABLE',
  evidence_source: 'MISSION TYPE'
});

function acquisitionDiagnosticTrace(context, report) {
  const run = context.run || {};
  const evidence = run.execution_evidence || {};
  const stage = String(run.current_stage || '').toUpperCase();
  const claimed = base.workerClaimed(context);
  const acquisitionRuns = context.acquisitionRuns || [];
  const rawRecords = context.rawRecords || [];
  const dispositions = context.dispositions || [];
  const rejections = context.rejections || [];
  const opportunities = context.opportunities || [];
  const terminal = base.isTerminalOutcome(run.status || run.aadp_state);

  const adapter = evidence.connector_key || evidence.adapter_key || evidence.acquisition_method ||
    context.assignment?.acquisition_method || context.publisher?.configuration?.connector_key || null;
  const queueConfirmed = stage.includes('POSTGRES_EXECUTION') || stage.includes('GITHUB_WORKER') || claimed || acquisitionRuns.length > 0;
  const acquisitionStarted = acquisitionRuns.length > 0 || rawRecords.length > 0 || stage.includes('ACQUISITION');
  const qualificationRouted = dispositions.length > 0 || rejections.length > 0 || opportunities.length > 0 || stage.includes('QUALIFICATION') || stage.includes('ROUTING');

  const checkpoints = [
    confirmed('COMMAND ACCEPTED', 'command_runs / command_missions', run.id || base.NOT_REPORTED),
    queueConfirmed
      ? confirmed('QUEUE CREATED', 'command_runs.current_stage / execution evidence', run.current_stage || 'POSTGRES EXECUTION QUEUED')
      : notConfirmed('QUEUE CREATED', 'command_runs.current_stage'),
    claimed
      ? confirmed('WORKER CLAIMED', 'command task / attempt / worker evidence')
      : notConfirmed('WORKER CLAIMED', 'command task / attempt / worker evidence'),
    adapter
      ? confirmed('ADAPTER SELECTED', 'mission/run/publisher connector evidence', adapter)
      : notConfirmed('ADAPTER SELECTED', 'mission/run/publisher connector evidence'),
    acquisitionStarted
      ? confirmed('ACQUISITION STARTED', acquisitionRuns.length ? 'acquisition_runs' : 'command_runs.current_stage')
      : notConfirmed('ACQUISITION STARTED', 'acquisition_runs / command_runs.current_stage'),
    rawRecords.length > 0
      ? confirmed('RAW PERSISTENCE', 'acquisition_raw_records', `${rawRecords.length} raw record(s)`)
      : notConfirmed('RAW PERSISTENCE', 'acquisition_raw_records'),
    qualificationRouted
      ? confirmed('QUALIFICATION ROUTED', dispositions.length || rejections.length ? 'acquisition_record_dispositions / acquisition_rejections' : 'state_contract_opportunities / current stage')
      : notConfirmed('QUALIFICATION ROUTED', 'acquisition_record_dispositions / acquisition_rejections'),
    opportunities.length > 0
      ? confirmed('CANONICAL PERSISTENCE', 'state_contract_opportunities', `${opportunities.length} canonical record(s)`)
      : notConfirmed('CANONICAL PERSISTENCE', 'state_contract_opportunities'),
    terminal
      ? confirmed('TERMINAL RESULT', 'command_runs.status', String(run.status || run.aadp_state || '').toUpperCase())
      : notConfirmed('TERMINAL RESULT', 'command_runs.status', 'Run is non-terminal')
  ];

  const lastConfirmedIndex = checkpoints.reduce((last, item, index) => item.status === 'CONFIRMED' ? index : last, -1);
  const firstUnconfirmedAfterLast = checkpoints.find((item, index) => index > lastConfirmedIndex && item.status === 'NOT CONFIRMED');
  const lastConfirmed = lastConfirmedIndex >= 0 ? checkpoints[lastConfirmedIndex] : null;

  return {
    diagnostic_policy: 'NO TROUBLESHOOTING BY INFERENCE WHEN A MISSION REPORT CAN IDENTIFY THE LAST CONFIRMED CHECKPOINT.',
    mission_type: 'ACQUISITION_DISCOVERY',
    last_confirmed_checkpoint: lastConfirmed?.checkpoint || base.NOT_REPORTED,
    next_unconfirmed_checkpoint: firstUnconfirmedAfterLast?.checkpoint || (terminal ? 'NONE — TERMINAL' : base.NOT_REPORTED),
    troubleshooting_start_point: firstUnconfirmedAfterLast?.checkpoint || lastConfirmed?.checkpoint || base.NOT_REPORTED,
    checkpoints,
    evidence_labels: {
      current_run: 'Authoritative for current execution state.',
      existing_baseline: 'Context only; never credited as current-run execution.',
      derived_analysis: 'Derived only from evidence read for this report.',
      not_reported: 'Unknown; never converted to zero or success.'
    }
  };
}

function genericDiagnosticTrace(context, missionType) {
  const run = context.run || {};
  const stage = String(run.current_stage || '').toUpperCase();
  const claimed = base.workerClaimed(context);
  const terminal = base.isTerminalOutcome(run.status || run.aadp_state);
  const queueConfirmed = stage.includes('POSTGRES_EXECUTION') || stage.includes('GITHUB_WORKER') || claimed;
  const workEvidence = (context.tasks || []).length > 0 || (context.stages || []).some(row => base.reported(row.started_at));

  const checkpoints = [
    confirmed('COMMAND ACCEPTED', 'command_runs / command_missions', run.id || base.NOT_REPORTED),
    queueConfirmed
      ? confirmed('QUEUE CREATED', 'command_runs.current_stage / execution evidence', run.current_stage || base.NOT_REPORTED)
      : notConfirmed('QUEUE CREATED', 'command_runs.current_stage'),
    claimed
      ? confirmed('WORKER CLAIMED', 'command task / attempt / worker evidence')
      : notConfirmed('WORKER CLAIMED', 'command task / attempt / worker evidence'),
    workEvidence
      ? confirmed('MISSION WORK STARTED', 'command_tasks / stage projection')
      : notConfirmed('MISSION WORK STARTED', 'command_tasks / stage projection'),
    terminal
      ? confirmed('TERMINAL RESULT', 'command_runs.status', String(run.status || run.aadp_state || '').toUpperCase())
      : notConfirmed('TERMINAL RESULT', 'command_runs.status', 'Run is non-terminal')
  ];

  if (missionType === 'ACQUISITION_DISCOVERY') return null;
  if (!['CONTRACT_PACKAGE_ACQUISITION'].includes(missionType)) checkpoints.splice(4, 0, notApplicable('CANONICAL PERSISTENCE'));

  const lastConfirmedIndex = checkpoints.reduce((last, item, index) => item.status === 'CONFIRMED' ? index : last, -1);
  const firstUnconfirmedAfterLast = checkpoints.find((item, index) => index > lastConfirmedIndex && item.status === 'NOT CONFIRMED');
  const lastConfirmed = lastConfirmedIndex >= 0 ? checkpoints[lastConfirmedIndex] : null;

  return {
    diagnostic_policy: 'NO TROUBLESHOOTING BY INFERENCE WHEN A MISSION REPORT CAN IDENTIFY THE LAST CONFIRMED CHECKPOINT.',
    mission_type: missionType || base.NOT_REPORTED,
    last_confirmed_checkpoint: lastConfirmed?.checkpoint || base.NOT_REPORTED,
    next_unconfirmed_checkpoint: firstUnconfirmedAfterLast?.checkpoint || (terminal ? 'NONE — TERMINAL' : base.NOT_REPORTED),
    troubleshooting_start_point: firstUnconfirmedAfterLast?.checkpoint || lastConfirmed?.checkpoint || base.NOT_REPORTED,
    checkpoints,
    evidence_labels: {
      current_run: 'Authoritative for current execution state.',
      existing_baseline: 'Context only; never credited as current-run execution.',
      derived_analysis: 'Derived only from evidence read for this report.',
      not_reported: 'Unknown; never converted to zero or success.'
    }
  };
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

  const executionTeam = hardenedContext.mission?.mission_config?.execution_team || hardenedContext.run?.execution_evidence?.execution_team || null;
  report.agent_team = executionTeam ? {
    evidence_label: 'CURRENT RUN',
    institutional_model: executionTeam.model || 'POSTGRES_CHECKPOINTED_STAGE_OWNERSHIP',
    version: executionTeam.version || hardenedContext.run?.execution_evidence?.execution_team_version || base.NOT_REPORTED,
    team_label: executionTeam.team_label || base.NOT_REPORTED,
    lead_agent: executionTeam.lead_agent || hardenedContext.run?.assigned_agent || base.NOT_REPORTED,
    agent_count: executionTeam.agent_count || executionTeam.agents?.length || base.NOT_REPORTED,
    exchange_medium: executionTeam.exchange_medium || 'SUPABASE_POSTGRES',
    concurrency_policy: executionTeam.concurrency_policy || base.NOT_REPORTED,
    stage_owners: executionTeam.agents || [],
    governance_rule: 'Agents own bounded stages. PostgreSQL owns the mission, checkpoint state, retries, and evidence continuity.'
  } : {
    evidence_label: 'NOT REPORTED',
    institutional_model: base.NOT_REPORTED,
    note: 'This run predates or did not pass through the APIE multi-agent mission-control wrapper.'
  };

  report.diagnostic_trace = missionType === 'ACQUISITION_DISCOVERY'
    ? acquisitionDiagnosticTrace(hardenedContext, report)
    : genericDiagnosticTrace(hardenedContext, missionType);

  report.report_metadata.report_generator_version = 'APIE-MISSION-REPORTING-1.2-MULTI-AGENT-DIAGNOSTIC';
  report.evidence_appendix = {
    ...(report.evidence_appendix || {}),
    diagnostic_rule: 'CURRENT RUN evidence defines the troubleshooting checkpoint. EXISTING BASELINE may explain configuration but cannot prove present execution.',
    diagnostic_trace_version: 'APIE-DIAGNOSTIC-TRACE-1.0',
    multi_agent_governance_version: 'APIE-MULTI-AGENT-1.0'
  };

  return report;
}
