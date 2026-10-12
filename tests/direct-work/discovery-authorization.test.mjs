import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCOVERY_MODES } from '../../core/domain/implementation-packet.mjs';
import { DISCOVERY_OPERATIONS, authorizeDiscovery } from '../../core/policy/discovery-authorization.mjs';

const anchors = [
  { symbol: 'ChapterRepository.refresh' },
  { file: 'data/chapter/ChapterRepository.kt' },
  { exactText: 'observeChapters()' },
  { testHint: 'ChapterRepositoryTest' },
];

function allowed(operation, target, relation, mode = DISCOVERY_MODES.DIRECTED) {
  return authorizeDiscovery({ mode, operation, target, anchors, relation });
}

test('DIRECTED permits anchor-bound exact lookups and local windows', () => {
  assert.equal(allowed(DISCOVERY_OPERATIONS.EXACT_SYMBOL, 'ChapterRepository.refresh', 'ANCHOR_SYMBOL').allowed, true);
  assert.equal(allowed(DISCOVERY_OPERATIONS.NARROW_FILE_PATTERN, 'data/chapter/ChapterRepository.kt', 'ANCHOR_FILE').allowed, true);
  assert.equal(allowed(DISCOVERY_OPERATIONS.EXACT_TEXT, 'observeChapters()', 'ANCHOR_TEXT').allowed, true);
  assert.equal(allowed(DISCOVERY_OPERATIONS.LOCAL_WINDOW, 'data/chapter/ChapterRepository.kt', 'ANCHOR_LOCAL_WINDOW').allowed, true);
  assert.equal(allowed(DISCOVERY_OPERATIONS.DIRECT_REFERENCE, 'ChapterStore', 'DIRECT_REFERENCE').allowed, true);
  assert.equal(allowed(DISCOVERY_OPERATIONS.MATCHING_TEST, 'ChapterRepositoryTest.kt', 'MATCHING_TEST').allowed, true);
});

test('DIRECTED denies broad exploration and alternative-solution search', () => {
  for (const operation of [DISCOVERY_OPERATIONS.BROAD_SEARCH, DISCOVERY_OPERATIONS.ARCHITECTURE_EXPLORE, DISCOVERY_OPERATIONS.GIT_HISTORY]) {
    assert.equal(allowed(operation, 'repo', 'DISCOVERY').allowed, false);
  }
  assert.equal(allowed(DISCOVERY_OPERATIONS.DIRECT_REFERENCE, 'OtherArchitecture', 'ALTERNATIVE_SOLUTION').allowed, false);
});

test('git history requires a separate explicit policy grant', () => {
  assert.equal(allowed(DISCOVERY_OPERATIONS.GIT_HISTORY, 'task-history', 'EXPLICIT_POLICY_GRANT').allowed, true);
});

test('NONE allows only declared target local context', () => {
  assert.equal(allowed(DISCOVERY_OPERATIONS.LOCAL_WINDOW, 'data/chapter/ChapterRepository.kt', 'DECLARED_TARGET', DISCOVERY_MODES.NONE).allowed, true);
  assert.equal(allowed(DISCOVERY_OPERATIONS.EXACT_SYMBOL, 'ChapterRepository.refresh', 'ANCHOR_SYMBOL', DISCOVERY_MODES.NONE).allowed, false);
});
