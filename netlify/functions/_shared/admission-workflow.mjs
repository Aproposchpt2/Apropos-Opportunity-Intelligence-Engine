export const WORKFLOW_STAGES = Object.freeze([
  'ACQUISITION',
  'DOCUMENT_REGISTRATION',
  'DOCUMENT_RETRIEVAL',
  'EVIDENCE_EXTRACTION',
  'CONTRACT_INTELLIGENCE',
  'ADMISSION_EVALUATION',
  'PROMOTION_OR_REJECTION',
  'AOIE_MATCHING',
  'NATCORP_DELIVERY',
  'ANALYZE_FIT',
  'EXECUTIVE_REPORTING'
]);

export const STAGE_DEPENDENCIES = Object.freeze({
  ACQUISITION: [],
  DOCUMENT_REGISTRATION: ['ACQUISITION'],
  DOCUMENT_RETRIEVAL: ['DOCUMENT_REGISTRATION'],
  EVIDENCE_EXTRACTION: ['DOCUMENT_RETRIEVAL'],
  CONTRACT_INTELLIGENCE: ['EVIDENCE_EXTRACTION'],
  ADMISSION_EVALUATION: ['CONTRACT_INTELLIGENCE'],
  PROMOTION_OR_REJECTION: ['ADMISSION_EVALUATION'],
  AOIE_MATCHING: ['PROMOTION_OR_REJECTION'],
  NATCORP_DELIVERY: ['AOIE_MATCHING'],
  ANALYZE_FIT: ['NATCORP_DELIVERY'],
  EXECUTIVE_REPORTING: ['PROMOTION_OR_REJECTION']
});

const TERMINAL_SUCCESS = new Set(['COMPLETED', 'ADMITTED', 'REJECTED', 'SKIPPED']);
const FAIL_CLOSED_STAGES = new Set([
  'DOCUMENT_REGISTRATION',
  'DOCUMENT_RETRIEVAL',
  'EVIDENCE_EXTRACTION',
  'CONTRACT_INTELLIGENCE',
  'ADMISSION_EVALUATION',
  'PROMOTION_OR_REJECTION',
  'AOIE_MATCHING',
  'NATCORP_DELIVERY',
  'ANALYZE_FIT'
]);

export function assertKnownStage(stage) {
  if (!WORKFLOW_STAGES.includes(stage)) throw new Error(`Unknown workflow stage: ${stage}`);
}

export function canRunStage(stage, stageStates = {}) {
  assertKnownStage(stage);
  const dependencies = STAGE_DEPENDENCIES[stage];
  const blockedBy = dependencies.filter((dependency) => !TERMINAL_SUCCESS.has(stageStates[dependency]));
  return { allowed: blockedBy.length === 0, blockedBy };
}

export function downstreamStages(stage) {
  assertKnownStage(stage);
  const start = WORKFLOW_STAGES.indexOf(stage);
  return WORKFLOW_STAGES.slice(start + 1);
}

export function applyStageFailure(stage, candidateState, reasonCode) {
  assertKnownStage(stage);
  const next = structuredClone(candidateState ?? {});
  next.stageStates ??= {};
  next.failures ??= [];
  next.stageStates[stage] = 'FAILED';
  next.failures.push({ stage, reasonCode, occurredAt: new Date().toISOString() });

  if (FAIL_CLOSED_STAGES.has(stage)) {
    for (const downstream of downstreamStages(stage)) {
      if (downstream === 'EXECUTIVE_REPORTING') continue;
      next.stageStates[downstream] = 'BLOCKED';
    }
  }

  next.enterpriseStatus = FAIL_CLOSED_STAGES.has(stage) ? 'CRITICAL' : 'DEGRADED';
  return next;
}

export function requireCurrentAdmissionForStage(stage, admittedContract) {
  if (!['AOIE_MATCHING', 'NATCORP_DELIVERY', 'ANALYZE_FIT'].includes(stage)) return;
  if (!admittedContract?.admitted_contract_id) {
    const error = new Error(`${stage} requires a current admitted contract.`);
    error.code = 'NOT_ADMITTED';
    throw error;
  }
  if (String(admittedContract.admission_status ?? 'ADMITTED').toUpperCase() !== 'ADMITTED') {
    const error = new Error(`${stage} cannot process a revoked or inactive contract.`);
    error.code = 'ADMISSION_INACTIVE';
    throw error;
  }
}

export function deriveEnterpriseStatus(metrics) {
  const critical = Number(metrics?.unauthorized_admission_attempt_count ?? 0) > 0
    || Number(metrics?.non_admitted_delivery_count ?? 0) > 0
    || metrics?.active_policy_valid === false
    || metrics?.admission_service_healthy === false;
  if (critical) return 'CRITICAL';

  const degraded = Number(metrics?.pending_evaluation_count ?? 0) > Number(metrics?.evaluation_backlog_threshold ?? 100)
    || Number(metrics?.review_queue_count ?? 0) > Number(metrics?.review_queue_threshold ?? 25)
    || metrics?.reconciliation_complete === false;
  return degraded ? 'DEGRADED' : 'OPERATIONAL';
}
