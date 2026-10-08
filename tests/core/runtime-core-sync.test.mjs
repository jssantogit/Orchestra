import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { syncRuntimeCore } from '../../scripts/sync-runtime-core.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-core-sync-'));
  mkdirSync(join(root, 'core', 'schema', 'generated'), { recursive: true });
  mkdirSync(join(root, 'core', 'domain'), { recursive: true });
  mkdirSync(join(root, 'schemas'), { recursive: true });
  mkdirSync(join(root, 'providers'), { recursive: true });

  writeFileSync(join(root, 'core', 'schema', 'validator.mjs'), "export function validateSchema(){ return { valid: true, errors: [] }; }\n");
  writeFileSync(join(root, 'core', 'schema', 'generated', 'sample.mjs'), 'export default () => true;\n');
  writeFileSync(join(root, 'core', 'domain', 'sample.mjs'), "export const DOMAIN = 'neutral';\n");
  writeFileSync(join(root, 'schemas', 'sample.schema.json'), '{"type":"object"}\n');
  writeFileSync(join(root, 'providers', 'codex-only.mjs'), "export const MODEL = 'gpt-provider-detail';\n");

  return root;
}

function mirror(root, provider) {
  return provider === 'codex'
    ? join(root, 'runtimes', 'codex', '.codex', 'astra-orchestra', 'core')
    : join(root, 'runtimes', 'antigravity', '.agents', 'skills', 'orchestra', 'core');
}

test('check-only reports missing runtime-core mirrors without mutating them', () => {
  const root = fixture();
  const result = syncRuntimeCore({ repoRoot: root, checkOnly: true });
  assert.ok(result.missing.length > 0);
  assert.equal(result.changed.length, 0);
  assert.equal(existsSync(mirror(root, 'codex')), false);
});

test('sync mirrors canonical core and schemas, then check-only is clean', () => {
  const root = fixture();
  const written = syncRuntimeCore({ repoRoot: root });
  assert.ok(written.changed.length > 0);

  for (const provider of ['codex', 'antigravity']) {
    const target = mirror(root, provider);
    assert.equal(readFileSync(join(target, 'domain', 'sample.mjs'), 'utf8'), "export const DOMAIN = 'neutral';\n");
    assert.equal(readFileSync(join(target, 'schemas', 'sample.schema.json'), 'utf8'), '{"type":"object"}\n');
    assert.equal(existsSync(join(target, 'providers', 'codex-only.mjs')), false);
    assert.equal(existsSync(join(target, '.orchestra-core-manifest.json')), true);
  }

  assert.deepEqual(syncRuntimeCore({ repoRoot: root, checkOnly: true }), { changed: [], stale: [], missing: [] });
});

test('check-only detects stale content and sync repairs it exactly', () => {
  const root = fixture();
  syncRuntimeCore({ repoRoot: root });
  const target = join(mirror(root, 'codex'), 'domain', 'sample.mjs');
  writeFileSync(target, "export const DOMAIN = 'provider-mutated';\n");

  const stale = syncRuntimeCore({ repoRoot: root, checkOnly: true });
  assert.ok(stale.stale.some((path) => path.endsWith('domain/sample.mjs')));
  syncRuntimeCore({ repoRoot: root });
  assert.equal(readFileSync(target, 'utf8'), "export const DOMAIN = 'neutral';\n");
});

test('mirrored schema runtime executes in an isolated project without node_modules', async () => {
  const root = fixture();
  syncRuntimeCore({ repoRoot: root });
  const isolated = mirror(root, 'codex');
  const module = await import(pathToFileURL(join(isolated, 'schema', 'validator.mjs')).href);
  assert.deepEqual(module.validateSchema('anything', {}), { valid: true, errors: [] });
});
