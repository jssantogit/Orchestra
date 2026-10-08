import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncRuntimeCore } from './sync-runtime-core.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-schema-validators.mjs'), '--check'], { stdio: 'inherit' });
} catch {
  console.error('Schema validators: DRIFT');
  process.exit(1);
}

const result = syncRuntimeCore({ repoRoot, checkOnly: true });
if (result.missing.length || result.stale.length) {
  console.error(`Runtime core mirror: ${result.missing.length ? 'MISSING' : 'DRIFT'}`);
  for (const path of result.missing) console.error(`MISSING ${path}`);
  for (const path of result.stale) console.error(`STALE ${path}`);
  process.exit(1);
}

console.log('Schema validators: OK');
console.log('Runtime core mirror: OK');
