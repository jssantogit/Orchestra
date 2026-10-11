import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDirectWorkAcceptance } from '../../core/acceptance/direct-work.mjs';

const packet = {
  taskId: 'task-1',
  candidateGeneration: 7,
  validation: ['unit-tests', 'formatter'],
};
const candidate = {
  schema: 'orchestra.candidate.v1',
  taskId: 'task-1',
  candidateId: 'candidate-7',
  generation: 7,
  workspaceId: 'primary',
  headSha: 'abc123',
};
function evidence(kind, overrides = {}) {
  return {
    schema: 'orchestra.evidence.v1', taskId: 'task-1', candidateId: 'candidate-7', candidateGeneration: 7,
    kind, status: 'PASSED', source: { provider: 'ci', reference: `run://${kind}` }, ...overrides,
  };
}
function audit(overrides = {}) {
  return {
    schema: 'orchestra.audit-result.v1', taskId: 'task-1', candidateId: 'candidate-7', candidateGeneration: 7,
    verdict: 'PASS', findings: [], ...overrides,
  };
}

test('matching passed evidence and required PASS audit accepts candidate', () => {
  const result = evaluateDirectWorkAcceptance({ packet, candidate, evidence: [evidence('unit-tests'), evidence('formatter')], audit: audit(), auditRequired: true, currentGeneration: 7 });
  assert.deepEqual(result, { accepted: true, reason: 'ACCEPTED' });
});

test('stale candidate, evidence, or audit generation fails closed', () => {
  assert.equal(evaluateDirectWorkAcceptance({ packet, candidate, evidence: [evidence('unit-tests'), evidence('formatter')], audit: audit(), auditRequired: true, currentGeneration: 8 }).accepted, false);
  assert.equal(evaluateDirectWorkAcceptance({ packet, candidate, evidence: [evidence('unit-tests', { candidateGeneration: 6 }), evidence('formatter')], audit: audit(), auditRequired: true, currentGeneration: 7 }).accepted, false);
  assert.equal(evaluateDirectWorkAcceptance({ packet, candidate, evidence: [evidence('unit-tests'), evidence('formatter')], audit: audit({ candidateGeneration: 6 }), auditRequired: true, currentGeneration: 7 }).accepted, false);
});

test('failed tool output cannot satisfy required evidence', () => {
  const result = evaluateDirectWorkAcceptance({ packet, candidate, evidence: [evidence('unit-tests', { status: 'FAILED' }), evidence('formatter')], audit: audit(), auditRequired: true, currentGeneration: 7 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'REQUIRED_EVIDENCE_NOT_PASSED');
});

test('missing audit does not block evidence-only low-risk work', () => {
  const result = evaluateDirectWorkAcceptance({ packet, candidate, evidence: [evidence('unit-tests'), evidence('formatter')], audit: null, auditRequired: false, currentGeneration: 7 });
  assert.deepEqual(result, { accepted: true, reason: 'ACCEPTED' });
});
