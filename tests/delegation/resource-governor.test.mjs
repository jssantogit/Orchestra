import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceGovernor, withResourceAdmission } from '../../runtime/resources/governor.mjs';
import { normalizeMemorySample, sampleMemory } from '../../runtime/resources/platform-memory.mjs';
import { runBoundedProcess } from '../../runtime/delegation/process-runner.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GiB = 1024 ** 3;
const sample = (availableBytes = 3 * GiB) => ({ verified: true, physicalBytes: 4 * GiB, effectiveBytes: 4 * GiB, availableBytes, commitAvailableBytes: availableBytes, pressured: false });
function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), 'orchestra-resource-'));
  return Promise.resolve().then(() => run(home)).finally(() => rmSync(home, { recursive: true, force: true }));
}

test('4 GiB budget is shared by Projects and survives a new governor instance', () => fixture(async (home) => {
  const governor = createResourceGovernor({ home, sample: () => sample() });
  const first = governor.reserve({ projectRef: 'project-a', bytes: 1.5 * GiB });
  assert.equal(first.ok, true);
  const second = createResourceGovernor({ home, sample: () => sample() }).reserve({ projectRef: 'project-b', bytes: 1.5 * GiB });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(governor.release(first.leaseId, { terminalVerified: false }).ok, false);
  assert.equal(governor.inspect().leases.length, 1);
  assert.equal(governor.release(first.leaseId, { terminalVerified: true }).ok, true);
  assert.equal(governor.reserve({ projectRef: 'project-b', bytes: 1.5 * GiB }).ok, true);
}));

test('8 GiB admits more capacity without artificial profile switches', () => fixture(async (home) => {
  const governor = createResourceGovernor({ home, sample: () => ({ ...sample(6 * GiB), physicalBytes: 8 * GiB, effectiveBytes: 8 * GiB }) });
  assert.equal(governor.reserve({ projectRef: 'a', bytes: 1.5 * GiB }).ok, true);
  assert.equal(governor.reserve({ projectRef: 'b', bytes: 1.5 * GiB }).ok, true);
}));

test('Windows commit pressure, probe failure and invalid numbers fail closed before work', () => fixture(async (home) => {
  for (const value of [null, { ...sample(), commitAvailableBytes: 128 * 1024 ** 2 }, { ...sample(), availableBytes: NaN }, { ...sample(), pressured: true }]) {
    let called = false;
    const governor = createResourceGovernor({ home, sample: () => value });
    const result = await withResourceAdmission({ governor }, async () => { called = true; });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  }
}));

test('deferred cancellation and deadlines never allocate a reservation', () => fixture(async (home) => {
  const governor = createResourceGovernor({ home, sample: () => sample() });
  const signal = AbortSignal.abort();
  assert.equal((await withResourceAdmission({ governor, signal }, () => assert.fail())).reason, 'RESOURCE_CANCELLED');
  assert.equal((await withResourceAdmission({ governor, deadlineAt: 1 }, () => assert.fail())).reason, 'RESOURCE_DEADLINE_EXCEEDED');
  assert.deepEqual(governor.inspect().leases, []);
}));

test('UNKNOWN retains budget; pressure can be rechecked without implicit route fallback', () => fixture(async (home) => {
  let available = 0;
  const governor = createResourceGovernor({ home, sample: () => sample(available) });
  assert.equal((await withResourceAdmission({ governor }, () => assert.fail())).ok, false);
  available = 3 * GiB;
  const result = await withResourceAdmission({ governor }, async () => ({ ok: false, state: 'UNKNOWN' }));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(governor.inspect().leases.length, 1);
}));

test('effective container memory and Windows commit are independent constraints', () => {
  const value = normalizeMemorySample({ physicalBytes: 16 * GiB, availableBytes: 10 * GiB, constrainedBytes: 4 * GiB, containerAvailableBytes: GiB, commitAvailableBytes: 8 * GiB });
  assert.equal(value.effectiveBytes, 4 * GiB);
  assert.equal(value.availableBytes, GiB);
  assert.equal(normalizeMemorySample({ physicalBytes: GiB, availableBytes: Infinity }).verified, false);
});

test('runner rejects pressure before spawning and does not execute argv side effects', () => fixture(async (home) => {
  const governor = createResourceGovernor({ home, sample: () => sample(0) });
  await assert.rejects(runBoundedProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000, maxOutputBytes: 64, resourceGovernor: governor }), { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
}));

test('active worker stops fail-closed if memory proof disappears', () => fixture(async (home) => {
  const base = createResourceGovernor({ home, sample: () => sample() });
  let checks = 0;
  const governor = { ...base, recheck: (id) => ++checks === 1 ? base.recheck(id) : { ok: false, reason: 'RESOURCE_UNVERIFIED' } };
  await assert.rejects(runBoundedProcess({ resourceGovernor: governor, command: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'], timeoutMs: 6000, maxOutputBytes: 64 }), { code: 'RESOURCE_PRESSURE' });
  assert.equal(base.inspect().leases.length, 1);
}));

test('a process cannot inherit a reservation for a different Home', () => fixture(async (home) => {
  const governor = createResourceGovernor({ home, sample: () => sample() });
  const result = await withResourceAdmission({ governor }, () => withResourceAdmission({ home: join(home, 'other') }, () => assert.fail('cross-Home reservation')));
  assert.equal(result.reason, 'RESOURCE_RESERVATION_SCOPE_MISMATCH');
}));

test('cgroup ancestor high pressure blocks even if a child has unlimited memory', () => {
  const files = {
    '/proc/self/cgroup': '0::/parent/child\n',
    '/proc/self/mountinfo': '20 19 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
  };
  for (const [path, limit, current, high] of [
    ['/sys/fs/cgroup/parent/child', 'max', 1, 'max'],
    ['/sys/fs/cgroup/parent', 4 * GiB, 3 * GiB, 2 * GiB],
    ['/sys/fs/cgroup', 'max', 3 * GiB, 'max'],
  ]) {
    files[`${path}/memory.max`] = String(limit);
    files[`${path}/memory.current`] = String(current);
    files[`${path}/memory.high`] = String(high);
  }
  const value = sampleMemory({ platform: 'linux', read: (path) => { if (!(path in files)) throw Error('missing'); return files[path]; } });
  assert.equal(value.effectiveBytes, 4 * GiB);
  assert.equal(value.pressured, true);
});

test('two independent Node controllers cannot both reserve the same Home capacity', () => fixture(async (home) => {
  const execute = (project) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../helpers/resource-reserve-child.mjs', import.meta.url)), home, project], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (bytes) => { if (output.length < 4096) output += bytes; });
    child.once('error', reject);
    child.once('close', (code) => { try { assert.equal(code, 0); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
  const results = await Promise.all([execute('a'), execute('b')]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(createResourceGovernor({ home }).inspect().leases.length, 1);
}));

test('a real inherited Windows Job keeps budget reserved while a descendant lives', { skip: process.platform !== 'win32' }, () => fixture(async (home) => {
  const governor = createResourceGovernor({ home, sample: () => sample() });
  await assert.rejects(runBoundedProcess({ resourceGovernor: governor, command: process.execPath,
    args: ['-e', "process.stdin.once('end',()=>{require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{detached:true,stdio:'ignore'}).unref();process.stdout.write('done');});process.stdin.resume()"], timeoutMs: 5000, maxOutputBytes: 1024 }), { code: 'RESOURCE_PROCESS_TREE_UNVERIFIED' });
  assert.equal(governor.inspect().leases.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(governor.inspect().leases.length, 1, 'no implicit expiry/release after an uncertain tree');
}));
