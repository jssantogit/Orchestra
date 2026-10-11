export const TEST_CHANGE_KINDS = Object.freeze({
  REGRESSION_COVERAGE: 'REGRESSION_COVERAGE',
  EXPECTED_BEHAVIOR_UPDATE: 'EXPECTED_BEHAVIOR_UPDATE',
  NEW_TEST: 'NEW_TEST',
});

const VALID_CHANGE_KINDS = new Set(Object.values(TEST_CHANGE_KINDS));

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function matchesAuthorizedHint(testPath, anchors) {
  const path = normalize(testPath);
  if (!path) return false;
  return (Array.isArray(anchors) ? anchors : []).some((anchor) => {
    const hint = normalize(anchor?.testHint);
    return hint && path.includes(hint);
  });
}

export function authorizeTestMutation({ packet, testPath, changeKind } = {}) {
  if (packet?.permissions?.tests !== 'MODIFY_AUTHORIZED_TARGETS') {
    return Object.freeze({ allowed: false, reason: 'TEST_MUTATION_NOT_AUTHORIZED' });
  }
  if (!VALID_CHANGE_KINDS.has(changeKind)) {
    return Object.freeze({ allowed: false, reason: 'TEST_CHANGE_KIND_NOT_AUTHORIZED' });
  }
  if (!matchesAuthorizedHint(testPath, packet?.anchors)) {
    return Object.freeze({ allowed: false, reason: 'TEST_TARGET_NOT_AUTHORIZED' });
  }
  return Object.freeze({ allowed: true, reason: 'TEST_MUTATION_AUTHORIZED' });
}
