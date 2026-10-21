#!/usr/bin/env node
// Explicit global Work ingress. The native caller supplies its real PreToolUse
// event plus the authorized implementation packet, never a route preference.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runNativeWorkCli({ argv = process.argv.slice(2), stdin = process.stdin,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) return 2;
  let registry;
  try {
    if (argv.length !== 2 || argv[0] !== '--home' || !argv[1]) throw Error('NATIVE_EXECUTION_USAGE');
    let bytes = '';
    for await (const chunk of stdin) { bytes += chunk; if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error('NATIVE_EXECUTION_INPUT_LIMIT'); }
    const { createGlobalProjectRegistry } = await import('../../v2/global/project-registry.mjs');
    const { executeNativeWork } = await import('./v2-work-execution.mjs');
    registry = createGlobalProjectRegistry({ home: resolve(argv[1]) });
    const result = await executeNativeWork(JSON.parse(bytes), { registry });
    stdout.write(JSON.stringify(result) + '\n'); return result.ok ? 0 : 1;
  } catch (error) { stderr.write(JSON.stringify({ ok: false, code: error.code ?? error.message ?? 'NATIVE_EXECUTION_FAILED' }) + '\n'); return 2; }
  finally { registry?.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runNativeWorkCli();
