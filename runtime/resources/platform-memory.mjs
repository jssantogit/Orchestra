import { freemem, totalmem } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { createRequire } from 'node:module';
import { readWindowsJobBudget } from './windows-job.mjs';

const require = createRequire(import.meta.url);
let performanceInfo;

const bytes = (value) => Number.isSafeInteger(value) && value >= 0;

export function normalizeMemorySample(input) {
  if (!input || !bytes(input.physicalBytes) || input.physicalBytes === 0
    || !bytes(input.availableBytes)
    || (input.commitAvailableBytes != null && !bytes(input.commitAvailableBytes))
    || (input.constrainedBytes != null && !bytes(input.constrainedBytes))
    || (input.containerAvailableBytes != null && !bytes(input.containerAvailableBytes))) {
    return { verified: false, reason: 'RESOURCE_UNVERIFIED' };
  }
  const effectiveBytes = Math.min(input.physicalBytes, input.constrainedBytes || Infinity);
  return {
    verified: true,
    physicalBytes: input.physicalBytes,
    effectiveBytes,
    availableBytes: Math.min(input.availableBytes, effectiveBytes, input.containerAvailableBytes ?? Infinity),
    commitAvailableBytes: input.commitAvailableBytes ?? null,
    pressured: input.pressured === true,
    controllerRssBytes: process.memoryUsage.rss(),
  };
}

function windowsCommit() {
  if (!performanceInfo) {
    const ffi = require('koffi');
    const structure = ffi.struct('OrchestraPerformanceInfo', {
      cb: 'uint32', CommitTotal: 'size_t', CommitLimit: 'size_t', CommitPeak: 'size_t',
      PhysicalTotal: 'size_t', PhysicalAvailable: 'size_t', SystemCache: 'size_t',
      KernelTotal: 'size_t', KernelPaged: 'size_t', KernelNonpaged: 'size_t',
      PageSize: 'size_t', HandleCount: 'uint32', ProcessCount: 'uint32', ThreadCount: 'uint32',
    });
    const query = ffi.load('kernel32.dll').func('int __stdcall K32GetPerformanceInfo(_Out_ OrchestraPerformanceInfo *info, uint32 size)');
    performanceInfo = () => {
      const value = { cb: ffi.sizeof(structure) };
      if (!query(value, value.cb)) throw new Error('RESOURCE_PROBE_FAILED');
      const commitAvailableBytes = (Number(value.CommitLimit) - Number(value.CommitTotal)) * Number(value.PageSize);
      return { commitAvailableBytes };
    };
  }
  return performanceInfo();
}

function cgroupPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !/[\x00-\x1f\\]/.test(value)
    && (value === '/' || value.slice(1).split('/').every(part => part && part !== '.' && part !== '..'));
}

function processInCgroup(read, path) {
  const value = read(posix.join(path, 'cgroup.procs'));
  if (value.length > 131072 || !/^(?:[1-9][0-9]*\n)*$/.test(value)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  return value.split('\n').includes(String(process.pid));
}

function namespaceProcessCgroup({ read, list, mount, mountedRoot, member }) {
  // /.. denotes an ancestor outside the caller's cgroup namespace, not /.
  // Resolve it only by an unambiguous live PID association beneath that mount.
  if (!/^\/(?:\.\.)(?:\/\.\.)*$/.test(mountedRoot)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const depth = mountedRoot.split('/').length - 1;
  if (depth > 8) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  let roots = [mount], visited = 0;
  for (let level = 0; level < depth; level++) {
    const next = [];
    for (const root of roots) {
      for (const entry of list(root)) {
        if (!entry.name || entry.name.includes('/') || !cgroupPath(posix.join(root, entry.name)) || ['.', '..'].includes(entry.name)
          || entry.isSymbolicLink()) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
        if (!entry.isDirectory()) continue;
        if (++visited > 128) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
        next.push(posix.join(root, entry.name));
      }
    }
    roots = next;
  }
  const matches = roots.map(root => {
    let path = root;
    for (const part of member.slice(1).split('/').filter(Boolean)) {
      const entries = list(path).filter(entry => entry.name === part);
      if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].isSymbolicLink()) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
      path = posix.join(path, part);
    }
    return path;
  }).filter(path => processInCgroup(read, path));
  if (matches.length !== 1) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  return matches[0];
}

function linuxContainer(read = (path) => readFileSync(path, 'utf8'), list = (path) => readdirSync(path, { withFileTypes: true })) {
  const memberships = read('/proc/self/cgroup').split('\n').filter((line) => line.startsWith('0::'));
  if (memberships.length !== 1) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const membership = memberships[0];
  const mounts = read('/proc/self/mountinfo').split('\n').filter((line) => line.includes(' - cgroup2 '));
  if (mounts.length !== 1) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const fields = mounts[0].split(' ');
  const mount = decode(fields[4]);
  const mountedRoot = decode(fields[3]);
  const member = membership.slice(3);
  if (!cgroupPath(mount) || !cgroupPath(member)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const namespaced = !cgroupPath(mountedRoot);
  if (!namespaced && member !== mountedRoot && !member.startsWith(`${mountedRoot === '/' ? '' : mountedRoot}/`)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const processGroup = namespaced
    ? namespaceProcessCgroup({ read, list, mount, mountedRoot, member })
    : posix.resolve(mount, `.${member.slice(mountedRoot === '/' ? 0 : mountedRoot.length) || '/'}`);
  let cursor = processGroup;
  if (cursor !== mount && !cursor.startsWith(`${mount}/`)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  let constrainedBytes = 0;
  let containerAvailableBytes = Infinity;
  let pressured = false;
  for (let depth = 0; depth < 128; depth++) {
    const maximum = read(posix.join(cursor, 'memory.max')).trim();
    const currentValue = read(posix.join(cursor, 'memory.current')).trim();
    const current = Number(currentValue);
    const high = read(posix.join(cursor, 'memory.high')).trim();
    const numeric = value => /^[0-9]+$/.test(value) && bytes(Number(value));
    if (!numeric(currentValue) || (maximum !== 'max' && (!numeric(maximum) || Number(maximum) === 0))
      || (high !== 'max' && !numeric(high))) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
    if (maximum !== 'max') {
      const limit = Number(maximum);
      constrainedBytes = constrainedBytes ? Math.min(constrainedBytes, limit) : limit;
      containerAvailableBytes = Math.min(containerAvailableBytes, Math.max(0, limit - current));
    }
    if (high !== 'max' && current >= Number(high)) pressured = true;
    if (cursor === mount) {
      // Migration or a changed mount while sampling cannot authorize admission.
      if (read('/proc/self/cgroup').split('\n').filter(line => line.startsWith('0::')).join('\n') !== membership
        || read('/proc/self/mountinfo').split('\n').filter(line => line.includes(' - cgroup2 ')).join('\n') !== mounts[0]
        || (namespaced && !processInCgroup(read, processGroup))) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
      return { constrainedBytes, ...(Number.isFinite(containerAvailableBytes) ? { containerAvailableBytes } : {}), pressured };
    }
    cursor = posix.dirname(cursor);
  }
  throw new Error('RESOURCE_CGROUP_UNVERIFIED');
}

export function sampleMemory({ platform = process.platform, read, list } = {}) {
  try {
    const native = platform === 'win32' ? { ...windowsCommit(), ...readWindowsJobBudget() } : platform === 'linux' ? linuxContainer(read, list) : {};
    const nodeLimit = process.constrainedMemory?.() ?? 0;
    const constrainedBytes = native.constrainedBytes && nodeLimit ? Math.min(native.constrainedBytes, nodeLimit) : native.constrainedBytes || nodeLimit;
    return normalizeMemorySample({ physicalBytes: totalmem(), availableBytes: Math.min(freemem(), process.availableMemory?.() ?? freemem()), ...native, constrainedBytes });
  } catch {
    return { verified: false, reason: 'RESOURCE_UNVERIFIED' };
  }
}
