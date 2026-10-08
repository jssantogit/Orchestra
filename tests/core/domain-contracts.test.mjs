import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISCOVERY_MODES,
  validateImplementationPacket,
  assertImplementationPacket,
} from '../../core/domain/implementation-packet.mjs';
import { validateScopeContract } from '../../core/domain/scope-contract.mjs';
import { validateCandidate } from '../../core/domain/candidate.mjs';
import { validateEvidence } from '../../core/domain/evidence.mjs';
import { validateAuditResult } from '../../core/domain/audit-result.mjs';
import { validateWorkLease } from '../../core/domain/work-lease.mjs';
import { validateRuntimeEvent } from '../../core/domain/runtime-event.mjs';

const actor = { provider: 'codex', sessionIdHash: 'hash-1' };

const packet = {
  schema: 'orchestra.implementation-packet.v1',
  taskId: 'task-1',
  candidateGeneration: 1,
  goal: 'bounded change',
  direction: { cause: 'known', change: 'change target', preserve: ['public API'] },
  anchors: [{ symbol: 'Target.run' }],
  scope: { allowedAreas: ['src/**'], forbidden: ['unrelated/**'] },
  permissions: { discovery: 'DIRECTED', tests: 'READ_ONLY', sideEffects: ['WORKSPACE_EDIT'] },
  validation: ['unit tests'],
  failurePolicy: { selfCaused: 'REPAIR', unrelatedOrUncertain: 'RETURN_TO_CONTROL' },
};

test('discovery vocabulary is provider-neutral and exact', () => {
  assert.deepEqual(DISCOVERY_MODES, Object.freeze({ NONE: 'NONE', DIRECTED: 'DIRECTED', INVESTIGATIVE: 'INVESTIGATIVE' }));
  assert.equal(validateImplementationPacket(packet).valid, true);
  assert.equal(assertImplementationPacket(packet), packet);
});

test('domain contracts do not accept provider control fields at top level', () => {
  for (const field of ['session_id', 'conversationId', 'model', 'gpt-6-sol', 'geminiModel']) {
    assert.equal(validateImplementationPacket({ ...packet, [field]: 'provider-detail' }).valid, false, field);
  }
});

test('raw actor provenance is bounded to explicit actor objects', () => {
  assert.equal(validateCandidate({
    schema: 'orchestra.candidate.v1', taskId: 'task-1', generation: 1,
    identity: 'sha:abc', changedFiles: ['src/a.mjs'], actor,
  }).valid, true);

  assert.equal(validateWorkLease({
    schema: 'orchestra.work-lease.v1', projectLineage: 'project', workspaceId: 'primary',
    taskId: 'task-1', generation: 1, state: 'CONTROL', actor, capabilities: ['CONTROL'],
  }).valid, true);

  assert.equal(validateWorkLease({
    schema: 'orchestra.work-lease.v1', projectLineage: 'project', workspaceId: 'primary',
    taskId: 'task-1', generation: 1, state: 'CONTROL', actor, capabilities: ['CONTROL'],
    conversationId: 'raw-id',
  }).valid, false);
});

test('all canonical domain validators expose compact schema results', () => {
  assert.equal(validateScopeContract({}).valid, false);
  assert.equal(validateEvidence({}).valid, false);
  assert.equal(validateAuditResult({}).valid, false);
  assert.equal(validateRuntimeEvent({}).valid, false);
});
