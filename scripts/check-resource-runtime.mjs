import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sampleMemory } from '../runtime/resources/platform-memory.mjs';
import { createResourceGovernor, withResourceAdmission } from '../runtime/resources/governor.mjs';
import { attachWindowsJob } from '../runtime/resources/windows-job.mjs';
import { runBoundedProcess } from '../runtime/delegation/process-runner.mjs';
import { selectExecutionMode } from '../core/workflow/direct-work-policy.mjs';

const GiB = 1024 ** 3;
const output = process.env.ORCHESTRA_RESOURCE_EVIDENCE || join(tmpdir(), 'orchestra-resource-check.json');
if (process.argv.includes('--windows-limit')) {
  assert.equal(process.platform, 'win32');
  const self = pathToFileURL(resolve(process.argv[1])).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `process.stdin.once('data',()=>import(${JSON.stringify(self)}))`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let job;
  const stdout = [];
  let captured = 0;
  child.stdout.on('data', (bytes) => { captured += bytes.length; if (captured <= 65536) stdout.push(bytes); });
  child.stderr.on('data', (bytes) => process.stderr.write(bytes));
  child.once('spawn', () => {
    try { job = attachWindowsJob(child.pid, 4 * GiB); child.stdin.end('run'); }
    catch { child.kill(); }
  });
  const deadline = setTimeout(() => child.kill(), 30000);
  child.once('close', (code) => {
    clearTimeout(deadline);
    const containment = job?.inspect();
    job?.close();
    assert.equal(code, 0);
    assert.equal(containment.activeProcesses, 0);
    const evidence = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    assert.equal(evidence.memory.effectiveBytes, 4 * GiB);
    writeFileSync(output, JSON.stringify({ ...evidence, containment }, null, 2));
    console.log(JSON.stringify({ ...evidence, containment }));
  });
} else {
  const memory = sampleMemory();
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (process.env.EXPECTED_HEAD) assert.equal(headSha, process.env.EXPECTED_HEAD);
  assert.equal(memory.verified, true);
  assert.ok(memory.effectiveBytes <= 4 * GiB, 'must use a real cgroup/Job memory limit, not an environment flag');
  const home = mkdtempSync(join(tmpdir(), 'orchestra-resource-actual-'));
  const governor = createResourceGovernor({ home });
  const directTimes = [];
  for (let batch = 0; batch < 100; batch++) {
    const start = performance.now();
    for (let call = 0; call < 1000; call++) assert.equal(selectExecutionMode({ lowRisk: true }).mode, 'DIRECT_WORK');
    directTimes.push((performance.now() - start) / 1000);
  }
  directTimes.sort((a, b) => a - b);
  const before = process.memoryUsage.rss();
  const start = performance.now();
  const controlled = await withResourceAdmission({ governor, bytes: 256 * 1024 ** 2 }, async () => {
    const result = await runBoundedProcess({ command: process.execPath, args: ['-e', "process.stdout.write(JSON.stringify({rss:process.memoryUsage.rss(),node:process.version}))"], timeoutMs: 10000, maxOutputBytes: 1024 });
    assert.equal(result.exitCode, 0);
    return { ok: true, worker: JSON.parse(result.stdout), resourceUsage: result.resourceUsage ?? null };
  });
  let externalPressure = null;
  if (process.platform === 'linux') {
    const filler = spawn(process.execPath, ['-e', "globalThis.bytes=Buffer.alloc(2*1024**3,1);process.stdout.write('READY');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    let timer;
    try {
      await new Promise((resolveReady, rejectReady) => {
        timer = setTimeout(() => rejectReady(Error('pressure workload timeout')), 15000);
        filler.once('error', rejectReady);
        filler.once('exit', () => rejectReady(Error('pressure workload exited before readiness')));
        filler.stdout.once('data', (bytes) => bytes.toString() === 'READY' ? resolveReady() : rejectReady(Error('pressure workload invalid')));
      });
      const underPressure = sampleMemory();
      const attempt = await withResourceAdmission({ governor, projectRef: 'second-project-under-pressure' }, () => assert.fail('heavy work must not start under real cgroup pressure'));
      assert.equal(attempt.reason, 'RESOURCE_BUDGET_UNAVAILABLE');
      externalPressure = { touchedBytes: 2 * GiB, memory: underPressure, attempt };
    } finally {
      clearTimeout(timer);
      const closed = new Promise((resolveClose) => filler.once('close', resolveClose));
      filler.kill('SIGKILL');
      await closed;
    }
    const resumed = await withResourceAdmission({ governor, projectRef: 'fresh-revalidated-attempt', bytes: 256 * 1024 ** 2 }, async () => ({ ok: true }));
    assert.equal(resumed.ok, true);
    externalPressure.capacityRecheckedAfterOwnerClose = true;
  }
  const pressure = createResourceGovernor({ home, sample: () => ({ ...sampleMemory(), availableBytes: 0 }) });
  let spawned = false;
  const denied = await withResourceAdmission({ governor: pressure }, () => { spawned = true; });
  assert.equal(denied.ok, false);
  assert.equal(spawned, false);
  const body = { schema: 'orchestra.resource-limited-check.v1', headSha, node: process.version, platform: process.platform, realMemoryLimit: true, memory, controlledWorker: controlled, pressure: denied, activeRssBytes: process.memoryUsage.rss(), beforeRssBytes: before, peakRssKiB: process.resourceUsage().maxRSS, admissionAndControlledWorkerMs: performance.now() - start, directSelectionP95Ms: directTimes[95], nativeProviderEvidence: false, retainedReservations: governor.inspect().leases.length, homeIdentity: `sha256:${createHash('sha256').update(home).digest('hex')}`, limitations: ['Controlled Node child is not a native provider', 'No native RSI or provider field success inferred from this check', 'Host memory pressure can defer even the controlled child'] };
  writeFileSync(output, JSON.stringify(body, null, 2));
  body.externalPressure = externalPressure;
  writeFileSync(output, JSON.stringify(body, null, 2));
  console.log(JSON.stringify(body));
}
