import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const validPacket = {
  schema: 'orchestra.implementation-packet.v1',
  taskId: 'standalone-packet',
  candidateGeneration: 1,
  goal: 'prove standalone validation',
  direction: { cause: 'known', change: 'bounded', preserve: [] },
  anchors: [{ symbol: 'target' }],
  scope: { allowedAreas: ['src/**'], forbidden: [] },
  permissions: { discovery: 'DIRECTED', tests: 'READ_ONLY', sideEffects: [] },
  validation: ['unit'],
  failurePolicy: { selfCaused: 'REPAIR', unrelatedOrUncertain: 'RETURN_TO_CONTROL' },
};

test('schema validator executes without repository node_modules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-schema-'));
  const fixtureCore = join(root, 'core');
  mkdirSync(fixtureCore, { recursive: true });
  cpSync(new URL('../../core/schema', import.meta.url), join(fixtureCore, 'schema'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');

  const { validateSchema } = await import(pathToFileURL(join(fixtureCore, 'schema', 'validator.mjs')).href);
  assert.equal(validateSchema('implementation-packet.v1.schema.json', validPacket).valid, true);
  assert.equal(validateSchema('implementation-packet.v1.schema.json', { ...validPacket, taskId: undefined }).valid, false);
});
