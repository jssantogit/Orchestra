import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImplementationPacket, assessImplementationReadiness } from '../../core/workflow/implementation-packet.mjs';

function packet(overrides = {}) {
  return buildImplementationPacket({
    taskId: 'task-1',
    candidateGeneration: 3,
    goal: 'persist refreshed chapters',
    direction: { cause: 'observer retains stale snapshot', change: 'invalidate snapshot after persistence', preserve: ['offline behavior'] },
    anchors: [{ symbol: 'ChapterRepository.refresh' }, { testHint: 'ChapterRepositoryTest' }],
    scope: { allowedAreas: ['data/chapter/**'], forbidden: ['public API redesign'] },
    permissions: { discovery: 'DIRECTED', tests: 'MODIFY_AUTHORIZED_TARGETS', sideEffects: ['WORKSPACE_EDIT','LOCAL_TEST'] },
    validation: ['chapter repository tests'],
    failurePolicy: { selfCaused: 'REPAIR', unrelatedOrUncertain: 'RETURN_TO_CONTROL' },
    ...overrides,
  });
}

test('resolved packet is implementation-ready without exact paths', () => {
  const value = packet();
  assert.equal(value.anchors.some((anchor) => 'file' in anchor), false);
  assert.deepEqual(assessImplementationReadiness(value), { ready: true, reason: 'IMPLEMENTATION_READY' });
});

test('direction equivalent to find the bug is insufficient', () => {
  const value = packet({ direction: { cause: 'unknown', change: 'find the bug', preserve: [] } });
  assert.deepEqual(assessImplementationReadiness(value), { ready: false, reason: 'PACKET_INSUFFICIENT' });
});

test('direction that still asks for investigation is insufficient', () => {
  const value = packet({ direction: { cause: 'investigate root cause', change: 'determine the fix', preserve: [] } });
  assert.equal(assessImplementationReadiness(value).ready, false);
});
