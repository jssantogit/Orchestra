import { freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
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

function linuxContainer(read = (path) => readFileSync(path, 'utf8')) {
  const membership = read('/proc/self/cgroup').split('\n').find((line) => line.startsWith('0::'));
  if (!membership) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const mounts = read('/proc/self/mountinfo').split('\n').filter((line) => line.includes(' - cgroup2 '));
  if (mounts.length !== 1) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const fields = mounts[0].split(' ');
  const mount = decode(fields[4]);
  const mountedRoot = decode(fields[3]);
  const member = membership.slice(3);
  if (member !== mountedRoot && !member.startsWith(`${mountedRoot === '/' ? '' : mountedRoot}/`)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  let cursor = posix.resolve(mount, `.${member.slice(mountedRoot === '/' ? 0 : mountedRoot.length) || '/'}`);
  if (cursor !== mount && !cursor.startsWith(`${mount}/`)) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
  let constrainedBytes = 0;
  let containerAvailableBytes = Infinity;
  let pressured = false;
  for (let depth = 0; depth < 128; depth++) {
    const maximum = read(posix.join(cursor, 'memory.max')).trim();
    const current = Number(read(posix.join(cursor, 'memory.current')).trim());
    const high = read(posix.join(cursor, 'memory.high')).trim();
    if (!bytes(current) || (maximum !== 'max' && !bytes(Number(maximum)))
      || (high !== 'max' && !bytes(Number(high)))) throw new Error('RESOURCE_CGROUP_UNVERIFIED');
    if (maximum !== 'max') {
      const limit = Number(maximum);
      constrainedBytes = constrainedBytes ? Math.min(constrainedBytes, limit) : limit;
      containerAvailableBytes = Math.min(containerAvailableBytes, Math.max(0, limit - current));
    }
    if (high !== 'max' && current >= Number(high)) pressured = true;
    if (cursor === mount) return { constrainedBytes, ...(Number.isFinite(containerAvailableBytes) ? { containerAvailableBytes } : {}), pressured };
    cursor = posix.dirname(cursor);
  }
  throw new Error('RESOURCE_CGROUP_UNVERIFIED');
}

export function sampleMemory({ platform = process.platform, read } = {}) {
  try {
    const native = platform === 'win32' ? { ...windowsCommit(), ...readWindowsJobBudget() } : platform === 'linux' ? linuxContainer(read) : {};
    const nodeLimit = process.constrainedMemory?.() ?? 0;
    const constrainedBytes = native.constrainedBytes && nodeLimit ? Math.min(native.constrainedBytes, nodeLimit) : native.constrainedBytes || nodeLimit;
    return normalizeMemorySample({ physicalBytes: totalmem(), availableBytes: Math.min(freemem(), process.availableMemory?.() ?? freemem()), ...native, constrainedBytes });
  } catch {
    return { verified: false, reason: 'RESOURCE_UNVERIFIED' };
  }
}
