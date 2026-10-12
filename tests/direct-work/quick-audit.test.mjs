import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuickAuditResult } from '../../core/audit/quick-audit.mjs';

const packet = {
  taskId: 'task-1',
  goal: 'persist refreshed chapters',
  direction: { cause: 'stale snapshot', change: 'invalidate after persistence', preserve: ['offline behavior'] },
};
const candidate = { taskId: 'task-1', candidateId: 'candidate-7', generation: 7 };

function audit(overrides = {}) {
  return {
    schema: 'orchestra.audit-result.v1',
    taskId: 'task-1',
    candidateId: 'candidate-7',
    candidateGeneration: 7,
    verdict: 'PASS',
    findings: [],
    ...overrides,
  };
}

test('PASS is valid only with zero findings and matching candidate', () => {
  assert.deepEqual(evaluateQuickAuditResult({ packet, candidate, audit: audit(), changedFiles: ['data/chapter/Repository.kt'] }), {
    valid: true,
    verdict: 'PASS',
    findings: [],
    reason: 'AUDIT_PASS',
  });
});

test('blocking finding on changed code tied to packet is valid', () => {
  const finding = {
    location: { path: 'data/chapter/Repository.kt', line: 83 },
    packetRequirement: 'offline behavior',
    issue: 'invalidation runs before persistence succeeds',
    evidence: 'added hunk executes before save completion',
  };
  const result = evaluateQuickAuditResult({
    packet,
    candidate,
    changedFiles: ['data/chapter/Repository.kt'],
    audit: audit({ verdict: 'BLOCKING_FINDING', findings: [finding] }),
  });
  assert.equal(result.valid, true);
  assert.equal(result.verdict, 'BLOCKING_FINDING');
});

test('finding about unrelated code smell is rejected as audit scope violation', () => {
  const result = evaluateQuickAuditResult({
    packet,
    candidate,
    changedFiles: ['data/chapter/Repository.kt'],
    audit: audit({ verdict: 'BLOCKING_FINDING', findings: [{
      location: { path: 'unrelated/Cache.kt', line: 9 },
      packetRequirement: 'clean architecture',
      issue: 'class is too large',
      evidence: 'unrelated file has many methods',
    }] }),
  });
  assert.deepEqual(result, { valid: false, verdict: 'BLOCKING_FINDING', findings: [], reason: 'AUDIT_SCOPE_VIOLATION' });
});

test('nit/severity shaped output is rejected by canonical audit schema', () => {
  const result = evaluateQuickAuditResult({
    packet,
    candidate,
    changedFiles: ['data/chapter/Repository.kt'],
    audit: audit({ verdict: 'BLOCKING_FINDING', findings: [{
      location: { path: 'data/chapter/Repository.kt', line: 83 },
      packetRequirement: 'offline behavior',
      issue: 'style nit',
      evidence: 'spacing',
      severity: 'nit',
    }] }),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'AUDIT_SCHEMA_INVALID');
});

test('stale audit candidate generation is rejected', () => {
  const result = evaluateQuickAuditResult({ packet, candidate, changedFiles: [], audit: audit({ candidateGeneration: 6 }) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'AUDIT_CANDIDATE_MISMATCH');
});
