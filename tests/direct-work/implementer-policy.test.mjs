import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTestMutation } from '../../core/policy/test-mutation.mjs';
import { FAILURE_RELATIONS, IMPLEMENTATION_ACTIONS, nextImplementationAction, createFailureReturn } from '../../core/workflow/implementation-result.mjs';

function packet(tests = 'MODIFY_AUTHORIZED_TARGETS') {
  return {
    permissions: { tests },
    anchors: [{ testHint: 'ChapterRepositoryTest' }],
  };
}

test('test mutation requires explicit packet authorization and matching target', () => {
  assert.equal(authorizeTestMutation({ packet: packet('READ_ONLY'), testPath: 'test/ChapterRepositoryTest.kt', changeKind: 'REGRESSION_COVERAGE' }).allowed, false);
  assert.equal(authorizeTestMutation({ packet: packet(), testPath: 'test/ChapterRepositoryTest.kt', changeKind: 'REGRESSION_COVERAGE' }).allowed, true);
  assert.equal(authorizeTestMutation({ packet: packet(), testPath: 'test/UnrelatedTest.kt', changeKind: 'REGRESSION_COVERAGE' }).allowed, false);
});

test('only SELF_CAUSED failures may be repaired by implementer', () => {
  assert.equal(nextImplementationAction({ failureRelation: FAILURE_RELATIONS.SELF_CAUSED }), IMPLEMENTATION_ACTIONS.REPAIR);
  assert.equal(nextImplementationAction({ failureRelation: FAILURE_RELATIONS.UNRELATED }), IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL);
  assert.equal(nextImplementationAction({ failureRelation: FAILURE_RELATIONS.UNCERTAIN }), IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL);
});

test('external failure return preserves factual command/evidence/candidate boundary', () => {
  const result = createFailureReturn({
    command: 'npm test',
    evidenceRef: 'evidence://run/42',
    boundary: 'unrelated lint failure',
    candidate: { candidateId: 'candidate-4', generation: 4, headSha: 'abc123' },
  });
  assert.deepEqual(result, {
    action: IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL,
    command: 'npm test',
    evidenceRef: 'evidence://run/42',
    boundary: 'unrelated lint failure',
    candidate: { candidateId: 'candidate-4', generation: 4, headSha: 'abc123' },
  });
});
