import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { sampleMemory } from './platform-memory.mjs';

const context = new AsyncLocalStorage();
const MiB = 1024 ** 2;
export const DEFAULT_WORKER_BYTES = 1536 * MiB;
const fail = (reason) => ({ ok: false, status: 'DEFERRED', reason });
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function defaultHome() {
  if (process.env.ORCHESTRA_HOME) return resolve(process.env.ORCHESTRA_HOME);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Orchestra');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Orchestra');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'orchestra');
}

export function createResourceGovernor({ home = defaultHome(), sample = sampleMemory } = {}) {
  mkdirSync(home, { recursive: true });
  const canonicalHome = realpathSync(home);
  const root = join(canonicalHome, 'resources');
  const file = join(root, 'reservations.json');
  const lock = join(root, 'admission.lock');
  function read() {
    if (!existsSync(file)) return [];
    if (lstatSync(file).isSymbolicLink() || statSync(file).size > 65536) throw new Error('RESOURCE_JOURNAL_INVALID');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    if (envelope.schema !== 'orchestra.resource-reservations.v1'
      || envelope.digest !== digest(JSON.stringify(envelope.leases))) throw new Error('RESOURCE_JOURNAL_INVALID');
    const value = envelope.leases;
    if (!Array.isArray(value) || value.length > 64 || value.some((row) =>
      typeof row.leaseId !== 'string' || !Number.isSafeInteger(row.bytes) || row.bytes <= 0)) throw new Error('RESOURCE_JOURNAL_INVALID');
    return value;
  }
  function transaction(change) {
    mkdirSync(root, { recursive: true });
    try { mkdirSync(lock); } catch { return fail('RESOURCE_BUDGET_UNAVAILABLE'); }
    try {
      const leases = read();
      const result = change(leases);
      if (result.ok) {
        const temporary = join(root, `${randomUUID()}.tmp`);
        writeFileSync(temporary, JSON.stringify({ schema: 'orchestra.resource-reservations.v1', leases, digest: digest(JSON.stringify(leases)) }), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      }
      return result;
    } catch {
      return fail('RESOURCE_JOURNAL_UNVERIFIED');
    } finally { rmdirSync(lock); }
  }
  function budget(reserved, requested) {
    let facts;
    try { facts = sample(); } catch { return fail('RESOURCE_UNVERIFIED'); }
    if (!facts?.verified || !Number.isSafeInteger(facts.effectiveBytes) || facts.effectiveBytes <= 0
      || !Number.isSafeInteger(facts.availableBytes) || facts.availableBytes < 0
      || (facts.commitAvailableBytes != null && (!Number.isSafeInteger(facts.commitAvailableBytes) || facts.commitAvailableBytes < 0))) return fail('RESOURCE_UNVERIFIED');
    const safetyBytes = Math.max(512 * MiB, Math.ceil(facts.effectiveBytes * 0.2));
    const capacity = Math.min(facts.availableBytes, facts.commitAvailableBytes ?? Infinity) - safetyBytes;
    if (facts.pressured || reserved + requested > capacity) return fail('RESOURCE_BUDGET_UNAVAILABLE');
    return { ok: true, facts, safetyBytes };
  }
  return {
    home: canonicalHome,
    reserve({ projectRef = 'provider-process', operationRef = randomUUID(), bytes = DEFAULT_WORKER_BYTES } = {}) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 ** 3) return fail('RESOURCE_REQUEST_INVALID');
      return transaction((leases) => {
        if (leases.length >= 64) return fail('RESOURCE_BUDGET_UNAVAILABLE');
        const admitted = budget(leases.reduce((sum, row) => sum + row.bytes, 0), bytes);
        if (!admitted.ok) return admitted;
        const leaseId = randomUUID();
        leases.push({ leaseId, bytes, projectRef: digest(String(projectRef)), operationRef: digest(String(operationRef)), createdAt: new Date().toISOString() });
        return { ok: true, leaseId, bytes, safetyBytes: admitted.safetyBytes };
      });
    },
    recheck(leaseId) {
      try {
        const leases = read();
        if (!leases.some((row) => row.leaseId === leaseId)) return fail('RESOURCE_RESERVATION_REQUIRED');
        return budget(0, 0);
      } catch { return fail('RESOURCE_JOURNAL_UNVERIFIED'); }
    },
    release(leaseId, { terminalVerified = false } = {}) {
      if (!terminalVerified) return fail('RESOURCE_TERMINAL_PROOF_REQUIRED');
      return transaction((leases) => {
        const index = leases.findIndex((row) => row.leaseId === leaseId);
        if (index < 0) return fail('RESOURCE_RESERVATION_REQUIRED');
        leases.splice(index, 1);
        return { ok: true };
      });
    },
    inspect() {
      try { return { ok: true, admissionLocked: existsSync(lock), humanGate: existsSync(lock), leases: read() }; } catch { return fail('RESOURCE_JOURNAL_UNVERIFIED'); }
    },
  };
}

export function currentResourceAdmission() { return context.getStore() ?? null; }

export async function withResourceAdmission({ governor, home, projectRef, operationRef, bytes, workers = 1, signal, deadlineAt } = {}, run) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) return fail('RESOURCE_REQUEST_INVALID');
  if (signal?.aborted) return fail('RESOURCE_CANCELLED');
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)) return fail('RESOURCE_DEADLINE_EXCEEDED');
  const existing = currentResourceAdmission();
  if (existing) {
    const requestedHome = home ? resolve(home) : null;
    const normalizeHome = (value) => process.platform === 'win32' ? value?.toLowerCase() : value;
    if (requestedHome && normalizeHome(requestedHome) !== normalizeHome(existing.governor.home)) return fail('RESOURCE_RESERVATION_SCOPE_MISMATCH');
    const check = existing.governor.recheck(existing.leaseId);
    if (!check.ok) return check;
    return run(existing);
  }
  const resource = governor ?? createResourceGovernor({ home });
  const reservation = resource.reserve({ projectRef, operationRef, bytes: bytes ?? workers * DEFAULT_WORKER_BYTES });
  if (!reservation.ok) return reservation;
  const active = { governor: resource, leaseId: reservation.leaseId, bytes: reservation.bytes ?? bytes ?? workers * DEFAULT_WORKER_BYTES, spawned: false, uncertain: false, activeChildren: 0, workers };
  try {
    const result = await context.run(active, () => run(active));
    if ((active.spawned && result?.ok === false) || result?.state === 'UNKNOWN' || result?.workflowState === 'UNKNOWN'
      || result?.reason?.includes('UNCERTAIN') || result?.reason?.includes('UNVERIFIED')
      || result?.code?.includes('UNVERIFIED') || result?.code?.includes('UNCERTAIN')) active.uncertain = true;
    return result;
  } catch (error) {
    if (active.spawned) active.uncertain = true;
    throw error;
  } finally {
    if (!active.uncertain && active.activeChildren === 0) resource.release(reservation.leaseId, { terminalVerified: true });
  }
}
