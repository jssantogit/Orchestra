import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doctor = readFileSync(new URL('../../scripts/doctor.sh', import.meta.url), 'utf8');

test('Doctor reports canonical schema and runtime-core mirror health', () => {
  assert.match(doctor, /check-runtime-core\.mjs/);
  assert.match(doctor, /Schema validators: OK/);
  assert.match(doctor, /Runtime core mirror: OK/);
  assert.match(doctor, /Runtime core mirror: DRIFT|Runtime core mirror: MISSING/);
});
