import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  decideCodexWork,
  readCodexDirectWorkMode,
} from '../../runtimes/codex/.codex/astra-orchestra/direct-work-routing.mjs';
import {
  decideAntigravityWork,
  readAntigravityDirectWorkMode,
} from '../../runtimes/antigravity/.agents/skills/orchestra/direct-work-routing.mjs';
import { evaluateDirectWorkToolUse } from '../../runtimes/antigravity/.agents/skills/orchestra/direct-work-tool-policy.mjs';

function normalized(result) {
  return {
    mode: result.directWork.mode,
    auditRequired: result.directWork.auditRequired,
    primaryWorkerCount: result.directWork.primaryWorkerCount,
    spawnInvestigator: result.directWork.spawnInvestigator,
    spawnReviewerBeforeCandidate: result.directWork.spawnReviewerBeforeCandidate,
  };
}

test('provider gates default Direct Work to on and keep invalid explicit values fail-safe in shadow', () => {
  for (const readMode of [readCodexDirectWorkMode, readAntigravityDirectWorkMode]) {
    assert.equal(readMode({}), 'on');
    assert.equal(readMode({ ORCHESTRA_DIRECT_WORK_MODE: '' }), 'on');
    assert.equal(readMode({ ORCHESTRA_DIRECT_WORK_MODE: 'off' }), 'off');
    assert.equal(readMode({ ORCHESTRA_DIRECT_WORK_MODE: 'shadow' }), 'shadow');
    assert.equal(readMode({ ORCHESTRA_DIRECT_WORK_MODE: 'on' }), 'on');
    assert.equal(readMode({ ORCHESTRA_DIRECT_WORK_MODE: 'invalid' }), 'shadow');
  }
});

for (const facts of [
  { taskAction: 'IMPLEMENT', bounded: true, criticality: 'NORMAL' },
  { taskAction: 'MECHANICAL_FIX', bounded: true, mechanical: true },
  { taskAction: 'IMPLEMENT', bounded: true, unresolvedDiagnosis: true },
  { taskAction: 'IMPLEMENT', bounded: true, independentWorkstreams: 2 },
]) {
  test(`Codex and Antigravity normalize Direct Work equally: ${JSON.stringify(facts)}`, () => {
    const env = { ORCHESTRA_DIRECT_WORK_MODE: 'on' };
    assert.deepEqual(normalized(decideAntigravityWork(facts, { env })), normalized(decideCodexWork(facts, { env })));
  });
}

test('Antigravity Direct Work guard denies broad/unanchored discovery and unauthorized test edits', () => {
  const packet = {
    anchors: [{ symbol: 'ChapterRepository.refresh' }, { testHint: 'ChapterRepositoryTest' }],
    permissions: { discovery: 'DIRECTED', tests: 'READ_ONLY' },
  };
  assert.equal(evaluateDirectWorkToolUse({ toolName: 'grep_search', toolArgs: { query: 'everything' }, implementationPacket: packet }).allowed, false);
  assert.equal(evaluateDirectWorkToolUse({ toolName: 'grep_search', toolArgs: { query: 'ChapterRepository.refresh' }, implementationPacket: packet }).allowed, true);
  assert.equal(evaluateDirectWorkToolUse({ toolName: 'write_to_file', toolArgs: { path: 'tests/ChapterRepositoryTest.kt' }, implementationPacket: packet }).allowed, false);
  assert.equal(evaluateDirectWorkToolUse({ toolName: 'invoke_subagent', toolArgs: {}, implementationPacket: packet }).allowed, false);
});

test('Antigravity hook registry activates the Direct Work guard', () => {
  const hooks = JSON.parse(readFileSync(new URL('../../runtimes/antigravity/.agents/hooks.json', import.meta.url), 'utf8'));
  assert.equal(hooks['direct-work-boundary'].PreToolUse[0].hooks[0].command, 'node hooks/direct-work-pre-tool-guard.mjs');
});
