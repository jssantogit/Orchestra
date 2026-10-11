import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decideRoute } from '../.codex/astra-orchestra/routing-policy.mjs';
import {
  readCodexDirectWorkMode,
  decideCodexWork,
  createCodexDirectWorkPacket,
  createCodexQuickAuditPacket,
} from '../.codex/astra-orchestra/direct-work-routing.mjs';

test('Direct Work mode defaults to on while invalid explicit values fail safe to shadow', () => {
  assert.equal(readCodexDirectWorkMode({}), 'on');
  assert.equal(readCodexDirectWorkMode({ ORCHESTRA_DIRECT_WORK_MODE: '' }), 'on');
  assert.equal(readCodexDirectWorkMode({ ORCHESTRA_DIRECT_WORK_MODE: 'wat' }), 'shadow');
});

test('off preserves 0.10 routing exactly', () => {
  const facts = { taskAction: 'IMPLEMENT', implementationComplexity: 'normal', bounded: true };
  assert.deepEqual(
    decideCodexWork(facts, { env: { ORCHESTRA_DIRECT_WORK_MODE: 'off' } }),
    decideRoute(facts),
  );
});

test('shadow computes Direct Work without altering actual route', () => {
  const facts = { taskAction: 'IMPLEMENT', implementationComplexity: 'normal', bounded: true };
  const baseline = decideRoute(facts);
  const result = decideCodexWork(facts, { env: { ORCHESTRA_DIRECT_WORK_MODE: 'shadow' } });
  assert.equal(result.profile, baseline.profile);
  assert.equal(result.model, baseline.model);
  assert.equal(result.reason, baseline.reason);
  assert.equal(result.directWork.mode, 'DIRECT_WORK');
  assert.equal(result.directWork.shadow, true);
});

test('on routes normal bounded implementation through one Luna implementer only', () => {
  const result = decideCodexWork(
    { taskAction: 'IMPLEMENT', bounded: true, criticality: 'NORMAL' },
    { env: { ORCHESTRA_DIRECT_WORK_MODE: 'on' } },
  );
  assert.match(result.profile, /^luna-/);
  assert.equal(result.directWork.mode, 'DIRECT_WORK');
  assert.equal(result.directWork.primaryWorkerCount, 1);
  assert.equal(result.directWork.spawnInvestigator, false);
  assert.equal(result.directWork.spawnReviewerBeforeCandidate, false);
  assert.equal(result.directWork.quickAuditorProfile, 'luna-auditor');
});

test('on returns unresolved diagnosis to Sol control instead of implementer investigation', () => {
  const result = decideCodexWork(
    { taskAction: 'IMPLEMENT', bounded: true, unresolvedDiagnosis: true },
    { env: { ORCHESTRA_DIRECT_WORK_MODE: 'on' } },
  );
  assert.equal(result.profile, 'sol-medium');
  assert.equal(result.directWork.mode, 'GUIDED_WORK');
  assert.equal(result.directWork.controlReturned, true);
});

test('mechanical Direct Work may skip Quick Audit', () => {
  const result = decideCodexWork(
    { taskAction: 'MECHANICAL_FIX', bounded: true, mechanical: true },
    { env: { ORCHESTRA_DIRECT_WORK_MODE: 'on' } },
  );
  assert.equal(result.directWork.auditRequired, false);
  assert.equal(result.directWork.quickAuditorProfile, null);
});

test('worker packet attaches canonical implementation-ready packet rather than asking Luna to reclassify', () => {
  const packet = createCodexDirectWorkPacket({
    implementation: {
      taskId: 'task-1',
      candidateGeneration: 1,
      goal: 'persist refreshed chapters',
      direction: { cause: 'stale snapshot', change: 'invalidate after persistence', preserve: ['offline behavior'] },
      anchors: [{ symbol: 'ChapterRepository.refresh' }],
      scope: { allowedAreas: ['data/chapter/**'], forbidden: [] },
      permissions: { discovery: 'DIRECTED', tests: 'READ_ONLY', sideEffects: ['WORKSPACE_EDIT'] },
      validation: ['unit-tests'],
      failurePolicy: { selfCaused: 'REPAIR', unrelatedOrUncertain: 'RETURN_TO_CONTROL' },
    },
  });
  assert.equal(packet.direct_work.role, 'IMPLEMENTER');
  assert.equal(packet.direct_work.implementation_packet.direction.change, 'invalidate after persistence');
  assert.equal('prompt' in packet, false);
});

test('quick auditor receives only bounded verification inputs', () => {
  const packet = createCodexQuickAuditPacket({
    implementationPacket: { id: 'packet' },
    candidate: { candidateId: 'candidate-1' },
    diffRef: 'diff://candidate-1',
    changedFiles: ['src/a.js'],
    evidenceRefs: ['evidence://unit-tests'],
  });
  assert.deepEqual(
    Object.keys(packet).sort(),
    ['schema', 'role', 'implementationPacket', 'candidate', 'diffRef', 'changedFiles', 'evidenceRefs'].sort(),
  );
  assert.equal(packet.role, 'QUICK_AUDITOR');
});

test('Luna implementation profiles forbid reinterpretation, broad investigation, unauthorized tests, unrelated repair, spawning, and self-acceptance', () => {
  for (const name of ['luna-medium.toml', 'luna-high.toml', 'luna-max.toml']) {
    const text = readFileSync(new URL(`../.codex/agents/${name}`, import.meta.url), 'utf8');
    assert.match(text, /do not reinterpret/i);
    assert.match(text, /broad repository exploration/i);
    assert.match(text, /tests? (?:may change|only|mutation)/i);
    assert.match(text, /UNCERTAIN/i);
    assert.match(text, /Never (?:spawn|create\/coordinate)/i);
    assert.match(text, /never self-accept/i);
  }
});

test('Luna auditor is read-only and emits only PASS or BLOCKING_FINDING', () => {
  const text = readFileSync(new URL('../.codex/agents/luna-auditor.toml', import.meta.url), 'utf8');
  assert.match(text, /sandbox_mode = "read-only"/);
  assert.match(text, /Output only PASS.*BLOCKING_FINDING/s);
  assert.match(text, /no nit/i);
  assert.match(text, /never instruct the implementer directly/i);
});
