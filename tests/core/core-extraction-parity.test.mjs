import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modules = [
  ['evidence-federation', '../../core/evidence/evidence-federation.mjs'],
  ['evidence-watch', '../../core/evidence/evidence-watch.mjs'],
  ['feedback-plane', '../../core/feedback/feedback-plane.mjs'],
];

function text(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

for (const [name, canonicalPath] of modules) {
  test(`${name} provider copies are byte-identical before extraction`, () => {
    const codex = text(`../../runtimes/codex/.codex/astra-orchestra/${name}.mjs`);
    const antigravity = text(`../../runtimes/antigravity/.agents/skills/orchestra/${name}.mjs`);
    assert.equal(codex, antigravity);
  });

  test(`${name} compatibility facades preserve canonical exports`, async () => {
    const canonical = await import(canonicalPath);
    const codex = await import(`../../runtimes/codex/.codex/astra-orchestra/${name}.mjs`);
    const antigravity = await import(`../../runtimes/antigravity/.agents/skills/orchestra/${name}.mjs`);
    assert.deepEqual(Object.keys(codex).sort(), Object.keys(canonical).sort());
    assert.deepEqual(Object.keys(antigravity).sort(), Object.keys(canonical).sort());
  });
}

test('evidence-watch representative behavior survives extraction', async () => {
  const canonical = await import('../../core/evidence/evidence-watch.mjs');
  const activeState = { taskId: 't1', attempt: 0, mutationSeq: 1 };
  const requirement = { id: 'ci', provider: 'github', watchPolicy: { initialBackoffMs: 1000, maxBackoffMs: 2000, timeoutMs: 10000 } };
  const watch = canonical.ensureEvidenceWatch(activeState, requirement, 1000);
  assert.equal(watch.status, 'READY_TO_POLL');
  assert.equal(canonical.shouldPollEvidenceWatch(activeState, requirement, 1000).poll, true);
});

test('feedback-plane representative declaration validation survives extraction', async () => {
  const canonical = await import('../../core/feedback/feedback-plane.mjs');
  const result = canonical.validateFeedbackDeclaration({
    type: 'HYPOTHESIS', key: 'h1', statement: 'change fixes bug', falsifier: 'test still fails',
  });
  assert.equal(result.valid, true);
  assert.equal(result.type, 'HYPOTHESIS');
});
