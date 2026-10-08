import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSchema } from '../../core/schema/validator.mjs';

const validPacket = {
  schema: 'orchestra.implementation-packet.v1',
  taskId: 'chapter-refresh-fix',
  candidateGeneration: 17,
  goal: 'correct chapter updates after refresh',
  direction: {
    cause: 'observer can retain a stale snapshot after persistence',
    change: 'invalidate or refresh the snapshot after successful persistence',
    preserve: ['current offline behavior', 'public API'],
  },
  anchors: [{ symbol: 'ChapterRepository.refresh' }],
  scope: {
    allowedAreas: ['domain/chapter/**'],
    forbidden: ['public API redesign'],
  },
  permissions: {
    discovery: 'DIRECTED',
    tests: 'MODIFY_AUTHORIZED_TARGETS',
    sideEffects: ['WORKSPACE_EDIT', 'LOCAL_TEST'],
  },
  validation: ['affected repository tests'],
  failurePolicy: {
    selfCaused: 'REPAIR',
    unrelatedOrUncertain: 'RETURN_TO_CONTROL',
  },
};

test('implementation packet schema accepts canonical packet and fails closed on unknown fields', () => {
  assert.equal(validateSchema('implementation-packet.v1.schema.json', validPacket).valid, true);
  assert.equal(validateSchema('implementation-packet.v1.schema.json', { ...validPacket, transcript: 'forbidden' }).valid, false);
});

test('implementation packet rejects missing taskId and invalid discovery mode', () => {
  const { taskId, ...withoutTask } = validPacket;
  assert.equal(validateSchema('implementation-packet.v1.schema.json', withoutTask).valid, false);
  assert.equal(validateSchema('implementation-packet.v1.schema.json', {
    ...validPacket,
    permissions: { ...validPacket.permissions, discovery: 'OPEN_ENDED' },
  }).valid, false);
});

test('work lease requires bounded factual authority fields and non-negative generation', () => {
  const lease = {
    schema: 'orchestra.work-lease.v1',
    projectLineage: 'tsuzuki',
    workspaceId: 'primary',
    taskId: 'chapter-refresh-fix',
    generation: 18,
    state: 'IMPLEMENTING',
    actor: { provider: 'codex', sessionIdHash: 'abc123' },
    capabilities: ['WORKSPACE_EDIT'],
  };
  assert.equal(validateSchema('work-lease.v1.schema.json', lease).valid, true);
  assert.equal(validateSchema('work-lease.v1.schema.json', { ...lease, generation: -1 }).valid, false);
  assert.equal(validateSchema('work-lease.v1.schema.json', { ...lease, conversationId: 'raw-provider-field' }).valid, false);
});
