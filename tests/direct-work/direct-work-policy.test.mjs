import test from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_MODES, selectExecutionMode } from '../../core/workflow/direct-work-policy.mjs';
import { DIRECT_WORK_STATES, transitionDirectWork } from '../../core/workflow/direct-work-state.mjs';

test('normal bounded code change selects Direct Work with audit', () => {
  const result = selectExecutionMode({ bounded: true, criticality: 'NORMAL', independentWorkstreams: 1 });
  assert.deepEqual(result, { mode: EXECUTION_MODES.DIRECT_WORK, reason: 'BOUNDED_DIRECT_WORK', auditRequired: true });
});

test('mechanical or low-risk work skips Quick Audit', () => {
  assert.equal(selectExecutionMode({ bounded: true, mechanical: true }).auditRequired, false);
  assert.equal(selectExecutionMode({ bounded: true, lowRisk: true }).auditRequired, false);
});

test('unresolved diagnosis escalates to Guided Work', () => {
  assert.equal(selectExecutionMode({ bounded: true, unresolvedDiagnosis: true }).mode, EXECUTION_MODES.GUIDED_WORK);
});

test('multiple workstreams or critical migration escalate to Orchestrated Work', () => {
  assert.equal(selectExecutionMode({ bounded: true, independentWorkstreams: 2 }).mode, EXECUTION_MODES.ORCHESTRATED_WORK);
  assert.equal(selectExecutionMode({ bounded: true, migrationSensitive: true, criticality: 'CRITICAL' }).mode, EXECUTION_MODES.ORCHESTRATED_WORK);
});

test('provider and model names cannot affect lane selection', () => {
  const base = selectExecutionMode({ bounded: true, criticality: 'NORMAL' });
  const named = selectExecutionMode({ bounded: true, criticality: 'NORMAL', provider: 'codex', model: 'expensive-specialist' });
  assert.deepEqual(named, base);
});

test('explicit escalation can only move toward heavier modes', () => {
  assert.equal(selectExecutionMode({ bounded: true, requestedMode: EXECUTION_MODES.GUIDED_WORK }).mode, EXECUTION_MODES.GUIDED_WORK);
  assert.equal(selectExecutionMode({ bounded: false, requestedMode: EXECUTION_MODES.DIRECT_WORK }).mode, EXECUTION_MODES.GUIDED_WORK);
});

test('Direct Work state machine follows candidate verification and control acceptance', () => {
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.INTAKE, 'RESOLVE').nextState, DIRECT_WORK_STATES.RESOLVING);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.RESOLVING, 'PACKET_READY').nextState, DIRECT_WORK_STATES.IMPLEMENTATION_READY);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.IMPLEMENTATION_READY, 'IMPLEMENT').nextState, DIRECT_WORK_STATES.IMPLEMENTING);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.IMPLEMENTING, 'CANDIDATE_CREATED').nextState, DIRECT_WORK_STATES.CANDIDATE_READY);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.CANDIDATE_READY, 'VERIFY').nextState, DIRECT_WORK_STATES.EVIDENCE_PENDING);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.EVIDENCE_PENDING, 'EVIDENCE_READY_AUDIT_PENDING').nextState, DIRECT_WORK_STATES.AUDIT_PENDING);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.AUDIT_PENDING, 'VERIFICATION_READY').nextState, DIRECT_WORK_STATES.ACCEPTANCE);
  assert.equal(transitionDirectWork(DIRECT_WORK_STATES.ACCEPTANCE, 'ACCEPT').nextState, DIRECT_WORK_STATES.DONE);
});

test('invalid transition fails closed without changing state', () => {
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.IMPLEMENTING, 'ACCEPT'), {
    allowed: false,
    nextState: DIRECT_WORK_STATES.IMPLEMENTING,
    reason: 'TRANSITION_NOT_ALLOWED',
  });
});
