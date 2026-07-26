import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_STAGES,
  STAGE_DEPENDENCIES,
  canRunStage,
  applyStageFailure,
  requireCurrentAdmissionForStage,
  deriveEnterpriseStatus
} from '../netlify/functions/_shared/admission-workflow.mjs';

import {
  AdmissionControlError,
  getCurrentAdmittedContract,
  getAoieCandidate,
  validateAnalyzeFitContract
} from '../netlify/functions/_shared/admission-control.mjs';

test('admission evaluation and AOIE are separate governed stages', () => {
  assert.ok(WORKFLOW_STAGES.includes('ADMISSION_EVALUATION'));
  assert.ok(WORKFLOW_STAGES.includes('PROMOTION_OR_REJECTION'));
  assert.ok(WORKFLOW_STAGES.includes('AOIE_MATCHING'));
  assert.deepEqual(STAGE_DEPENDENCIES.AOIE_MATCHING, ['PROMOTION_OR_REJECTION']);
});

test('AOIE cannot run before promotion or rejection completes', () => {
  const result = canRunStage('AOIE_MATCHING', { ADMISSION_EVALUATION: 'COMPLETED' });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockedBy, ['PROMOTION_OR_REJECTION']);
});

test('admission failure blocks AOIE, delivery, and Analyze Fit', () => {
  const state = applyStageFailure('ADMISSION_EVALUATION', {}, 'MISSING_CONTRACT_CONTACT');
  assert.equal(state.stageStates.AOIE_MATCHING, 'BLOCKED');
  assert.equal(state.stageStates.NATCORP_DELIVERY, 'BLOCKED');
  assert.equal(state.stageStates.ANALYZE_FIT, 'BLOCKED');
  assert.equal(state.enterpriseStatus, 'CRITICAL');
});

test('downstream stages require admitted_contract_id', () => {
  for (const stage of ['AOIE_MATCHING', 'NATCORP_DELIVERY', 'ANALYZE_FIT']) {
    assert.throws(() => requireCurrentAdmissionForStage(stage, null), { code: 'NOT_ADMITTED' });
  }
});

test('revoked admission is denied downstream', () => {
  assert.throws(
    () => requireCurrentAdmissionForStage('ANALYZE_FIT', { admitted_contract_id: '1', admission_status: 'REVOKED' }),
    { code: 'ADMISSION_INACTIVE' }
  );
});

test('enterprise status is critical when admission control is unhealthy', () => {
  assert.equal(deriveEnterpriseStatus({ admission_service_healthy: false }), 'CRITICAL');
  assert.equal(deriveEnterpriseStatus({ unauthorized_admission_attempt_count: 1 }), 'CRITICAL');
});

function mockSingle(data, error = null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data, error }) };
            }
          };
        }
      };
    }
  };
}

test('current admitted contract lookup fails closed', async () => {
  await assert.rejects(
    () => getCurrentAdmittedContract(mockSingle(null), 'contract-1'),
    (error) => error instanceof AdmissionControlError && error.code === 'NOT_ADMITTED'
  );
});

test('AOIE reads admitted-only source and fails closed', async () => {
  await assert.rejects(
    () => getAoieCandidate(mockSingle(null), 'contract-1'),
    (error) => error instanceof AdmissionControlError && error.code === 'NOT_ADMITTED'
  );
});

test('Analyze Fit rejects expired admitted contracts', async () => {
  const expired = {
    admitted_contract_id: 'contract-1',
    lifecycle_status: 'OPEN',
    response_deadline: '2020-01-01T00:00:00Z',
    contact_evidence_id: 'contact',
    scope_evidence_id: 'scope',
    requirements_evidence_manifest: []
  };
  await assert.rejects(
    () => validateAnalyzeFitContract(mockSingle(expired), 'contract-1'),
    (error) => error instanceof AdmissionControlError && error.code === 'CONTRACT_EXPIRED'
  );
});
