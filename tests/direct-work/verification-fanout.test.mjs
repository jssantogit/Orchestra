import test from 'node:test';
import assert from 'node:assert/strict';
import { planVerificationFanout } from '../../core/workflow/verification-fanout.mjs';
import { summarizeDirectWorkEconomy } from '../../benchmarks/turn-economy/direct-work-metrics.mjs';

test('normal Direct Work starts evidence and Quick Audit in parallel', () => {
  assert.deepEqual(
    planVerificationFanout({ candidate: { candidateId: 'c1' }, requiredEvidence: ['unit'], auditRequired: true }),
    { parallel: ['EVIDENCE', 'QUICK_AUDIT'], acceptanceWaitsFor: ['EVIDENCE', 'QUICK_AUDIT'] },
  );
});

test('mechanical Direct Work may start evidence only', () => {
  assert.deepEqual(
    planVerificationFanout({ candidate: { candidateId: 'c1' }, requiredEvidence: ['format'], auditRequired: false }),
    { parallel: ['EVIDENCE'], acceptanceWaitsFor: ['EVIDENCE'] },
  );
});

test('audit-only verification is valid when evidence is not required', () => {
  assert.deepEqual(
    planVerificationFanout({ candidate: { candidateId: 'c1' }, requiredEvidence: [], auditRequired: true }),
    { parallel: ['QUICK_AUDIT'], acceptanceWaitsFor: ['QUICK_AUDIT'] },
  );
});

test('economy snapshot preserves Web-like turn metrics and Direct Work counters', () => {
  assert.deepEqual(summarizeDirectWorkEconomy({
    lane: 'DIRECT_WORK',
    control_turns: 2,
    worker_turns: 3,
    repository_discovery_ops: 1,
    redundant_reads: 0,
    turns_to_first_edit: 2,
    delegations: 1,
    model_handoffs: 2,
    quick_audit_invocations: 1,
    candidate_generations: 1,
    approximate_cost: 0.02,
  }), {
    lane: 'DIRECT_WORK',
    control_turns: 2,
    worker_turns: 3,
    repository_discovery_ops: 1,
    redundant_reads: 0,
    turns_to_first_edit: 2,
    delegations: 1,
    model_handoffs: 2,
    quick_audit_invocations: 1,
    candidate_generations: 1,
    approximate_cost: 0.02,
  });
});
