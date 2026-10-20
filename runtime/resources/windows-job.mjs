import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let api;

function windowsApi() {
  if (api) return api;
  const ffi = require('koffi');
  const basic = ffi.struct('OrchestraJobBasicLimits', {
    PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr_t', PriorityClass: 'uint32', SchedulingClass: 'uint32',
  });
  const io = ffi.struct('OrchestraJobIo', {
    ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
  });
  const limits = ffi.struct('OrchestraJobExtendedLimits', {
    BasicLimitInformation: basic, IoInfo: io, ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t',
  });
  const accounting = ffi.struct('OrchestraJobAccounting', {
    TotalUserTime: 'int64', TotalKernelTime: 'int64', ThisPeriodTotalUserTime: 'int64', ThisPeriodTotalKernelTime: 'int64',
    TotalPageFaultCount: 'uint32', TotalProcesses: 'uint32', ActiveProcesses: 'uint32', TotalTerminatedProcesses: 'uint32',
  });
  const kernel = ffi.load('kernel32.dll');
  api = {
    ffi, limits, accounting,
    create: kernel.func('void * __stdcall CreateJobObjectW(void *attributes, const void *name)'),
    set: kernel.func('int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32 length)'),
    query: kernel.func('int __stdcall QueryInformationJobObject(void *job, int infoClass, void *info, uint32 length, void *returned)'),
    open: kernel.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)'),
    assign: kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    current: kernel.func('void * __stdcall GetCurrentProcess()'),
    isInJob: kernel.func('int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *result)'),
  };
  return api;
}

export function readWindowsJobBudget() {
  const native = windowsApi();
  const inJob = [0];
  if (!native.isInJob(native.current(), null, inJob)) throw new Error('RESOURCE_JOB_UNVERIFIED');
  if (!inJob[0]) return {};
  const info = Buffer.alloc(native.ffi.sizeof(native.limits));
  if (!native.query(null, 9, info, info.length, null)) throw new Error('RESOURCE_JOB_UNVERIFIED');
  const limits = native.ffi.decode(info, native.limits);
  if (!(limits.BasicLimitInformation.LimitFlags & 0x200)) return {};
  const limit = Number(limits.JobMemoryLimit);
  return { constrainedBytes: limit, containerAvailableBytes: Math.max(0, limit - Number(limits.PeakJobMemoryUsed)) };
}

export function attachWindowsJob(pid, memoryBytes) {
  const native = windowsApi();
  const job = native.create(null, null);
  if (!job) throw new Error('RESOURCE_CONTAINMENT_UNAVAILABLE');
  let processHandle;
  try {
    const info = Buffer.alloc(native.ffi.sizeof(native.limits));
    native.ffi.encode(info, native.limits, { BasicLimitInformation: { LimitFlags: 0x200 }, JobMemoryLimit: memoryBytes });
    if (!native.set(job, 9, info, info.length)) throw new Error('RESOURCE_CONTAINMENT_UNAVAILABLE');
    processHandle = native.open(0x0101, 0, pid);
    if (!processHandle || !native.assign(job, processHandle)) throw new Error('RESOURCE_CONTAINMENT_UNAVAILABLE');
    return {
      inspect() {
        const accounting = Buffer.alloc(native.ffi.sizeof(native.accounting));
        const info = Buffer.alloc(native.ffi.sizeof(native.limits));
        if (!native.query(job, 1, accounting, accounting.length, null)
          || !native.query(job, 9, info, info.length, null)) throw new Error('RESOURCE_CONTAINMENT_UNAVAILABLE');
        return { activeProcesses: native.ffi.decode(accounting, native.accounting).ActiveProcesses,
          peakCommitBytes: Number(native.ffi.decode(info, native.limits).PeakJobMemoryUsed), limitBytes: memoryBytes };
      },
      close() { native.close(job); },
    };
  } catch (error) {
    native.close(job);
    throw error;
  } finally {
    if (processHandle) native.close(processHandle);
  }
}
