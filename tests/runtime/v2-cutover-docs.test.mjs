import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = [
  'docs/architecture.md',
  'docs/project-runtime.md',
  'docs/codex.md',
  'docs/antigravity.md',
  'docs/dream-layer.md',
];
const CUTOVER = 'docs/release/v2-cutover-runbook.md';
const ROLLBACK = 'docs/release/v2-rollback-runbook.md';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function normalized(text) {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function sentences(text) {
  return normalized(text).split(/(?<=[.!?])\s+/);
}

function assertNoAffirmativeLocalBrainInstruction(path) {
  for (const sentence of sentences(read(path))) {
    const normalV2 = /\b(normal v2|v2 default|default v2|v2 registered projects?)\b/.test(sentence);
    const localBrain = /\b(copy|install|materialize)\w*\b[^.]{0,180}\b(full|complete)\b[^.]{0,100}\b(runtime|brain|governance)\b/.test(sentence);
    const prohibition = /\b(must not|do not|does not|never|without)\b/.test(sentence);

    if (normalV2 && localBrain && !prohibition) {
      assert.fail(`${path}: normal v2 must not affirmatively materialize a full project-local governance brain`);
    }
  }
}

test('v2 user-facing docs describe the global control plane as the normal topology', () => {
  for (const path of DOCS) {
    const body = normalized(read(path));
    assert.match(body, /global (engine|control plane|orchestra home)/, path);
    assert.match(body, /thin (provider )?shim/, path);
    assert.match(body, /project[- ]local.*(compatibility|migration)|compatibility.*project[- ]local|legacy.*compatibility/, path);
  }
});

test('v2 docs do not instruct normal operation to copy or install a full local governance brain', () => {
  for (const path of DOCS) {
    assertNoAffirmativeLocalBrainInstruction(path);
  }
});

test('cutover runbook encodes the default switch without erasing v1 history', () => {
  const body = normalized(read(CUTOVER));
  assert.match(body, /global (engine|control plane)/);
  assert.match(body, /thin (provider )?shim/);
  assert.match(body, /work (unit|authority)|current work/);
  assert.match(body, /work lease.*not.*normal|session handoff.*not.*normal/);
  assert.match(body, /global.*(recovery|upgrade)|recovery.*global.*upgrade/);
  assert.match(body, /v1.*compatibility|compatibility.*v1/);
  assert.match(body, /do not.*(delete|remove).*v1|v1.*not.*removed/);
  assert.match(body, /operator.*(approval|authorize)/);
});

test('rollback runbook preserves artifacts and restores an explicit supported topology', () => {
  const body = normalized(read(ROLLBACK));
  assert.match(body, /previous.*v2.*(image|integration)|v2.*rollback.*image/);
  assert.match(body, /v1.*compatibility/);
  assert.match(body, /preserv(ed|e).*artifact|artifact.*audit/);
  assert.match(body, /global.*(status|recovery)|status.*global/);
  assert.match(body, /operator.*(approval|authorize)/);
});
