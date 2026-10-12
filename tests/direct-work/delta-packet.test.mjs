import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaPacket, validateDeltaPacket } from '../../core/workflow/delta-packet.mjs';

const originalPacket = {
  schema: 'orchestra.implementation-packet.v1',
  taskId: 'task-1',
  candidateGeneration: 4,
  goal: 'persist refreshed chapters',
  direction: { cause: 'stale snapshot', change: 'invalidate after persistence', preserve: ['offline behavior'] },
  anchors: [{ symbol: 'ChapterRepository.refresh' }],
  scope: { allowedAreas: ['data/chapter/**'], forbidden: ['public API redesign'] },
  permissions: { discovery: 'DIRECTED', tests: 'READ_ONLY', sideEffects: ['WORKSPACE_EDIT'] },
  validation: ['chapter repository tests'],
  failurePolicy: { selfCaused: 'REPAIR', unrelatedOrUncertain: 'RETURN_TO_CONTROL' },
};

const candidate = {
  schema: 'orchestra.candidate.v1',
  taskId: 'task-1',
  candidateId: 'candidate-4',
  generation: 4,
  workspaceId: 'primary',
  headSha: 'abc123',
};

test('delta preserves lineage/direction, narrows correction, and increments generation', () => {
  const delta = createDeltaPacket({
    originalPacket,
    candidate,
    confirmedFinding: { code: 'OFFLINE_REGRESSION', location: 'data/chapter/Repository.kt:83', issue: 'invalidates before save' },
    correctionArea: { allowedAreas: ['data/chapter/**'] },
    revalidation: ['chapter repository tests'],
  });
  assert.equal(validateDeltaPacket(delta).valid, true);
  assert.equal(delta.taskId, originalPacket.taskId);
  assert.equal(delta.parentCandidateId, candidate.candidateId);
  assert.equal(delta.baseCandidateGeneration, 4);
  assert.equal(delta.candidateGeneration, 5);
  assert.deepEqual(delta.direction, originalPacket.direction);
  assert.equal(delta.discovery, 'DIRECTED');
  assert.equal(delta.confirmedFinding.code, 'OFFLINE_REGRESSION');
});

test('delta cannot widen original correction scope', () => {
  assert.throws(() => createDeltaPacket({
    originalPacket,
    candidate,
    confirmedFinding: { code: 'X', location: 'other/file.js:1', issue: 'x' },
    correctionArea: { allowedAreas: ['other/**'] },
    revalidation: ['tests'],
  }), /widens original scope/);
});

test('delta never grants INVESTIGATIVE discovery', () => {
  const investigative = { ...originalPacket, permissions: { ...originalPacket.permissions, discovery: 'INVESTIGATIVE' } };
  const delta = createDeltaPacket({
    originalPacket: investigative,
    candidate,
    confirmedFinding: { code: 'X', location: 'data/chapter/Repository.kt:83', issue: 'x' },
    correctionArea: { allowedAreas: ['data/chapter/**'] },
    revalidation: ['tests'],
  });
  assert.equal(delta.discovery, 'DIRECTED');
});

test('delta rejects stale or foreign candidate lineage', () => {
  assert.throws(() => createDeltaPacket({
    originalPacket,
    candidate: { ...candidate, taskId: 'other-task' },
    confirmedFinding: { code: 'X', location: 'data/chapter/Repository.kt:83', issue: 'x' },
    correctionArea: { allowedAreas: ['data/chapter/**'] },
    revalidation: ['tests'],
  }), /lineage/);
});
