import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { validateWorkLease } from "../domain/work-lease.mjs";
import { acquireAtomicLock, releaseAtomicLock } from "./atomic-lock.mjs";

const STATE_DIR = ".orchestra/state";
const TERMINAL_STATES = new Set(["DONE", "BLOCKED"]);

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function paths(repoRoot) {
  const root = resolve(repoRoot);
  const stateDir = join(root, STATE_DIR);
  return {
    root,
    stateDir,
    lease: join(stateDir, "work-lease.json"),
    lock: join(stateDir, "work-lease.claim.lock"),
  };
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") return null;
  const provider = String(actor.provider || "").trim();
  const sessionIdHash = String(actor.sessionIdHash || "").trim();
  if (!provider || !sessionIdHash) return null;
  return { provider, sessionIdHash };
}

function sameActor(a, b) {
  return Boolean(a && b && a.provider === b.provider && a.sessionIdHash === b.sessionIdHash);
}

function normalizedCapabilities(capabilities) {
  return [...new Set((Array.isArray(capabilities) ? capabilities : []).map((v) => String(v).trim()).filter(Boolean))].sort();
}

function writeLease(path, lease) {
  const validation = validateWorkLease(lease);
  if (!validation.valid) {
    const error = new Error("ORCHESTRA_WORK_LEASE_INVALID");
    error.code = "ORCHESTRA_WORK_LEASE_INVALID";
    error.errors = validation.errors;
    throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(lease, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  return lease;
}

function lineageFor(repoRoot) {
  return `workspace-${digest(resolve(repoRoot)).slice(0, 24)}`;
}

export function readWorkLease(repoRoot, workspaceId = "primary") {
  const p = paths(repoRoot);
  if (!existsSync(p.lease)) return { exists: false, valid: true, lease: null, path: p.lease };
  try {
    const lease = JSON.parse(readFileSync(p.lease, "utf8"));
    const validation = validateWorkLease(lease);
    if (!validation.valid) return { exists: true, valid: false, lease, reason: "LEASE_SCHEMA_INVALID", errors: validation.errors, path: p.lease };
    if (lease.workspaceId !== workspaceId) return { exists: true, valid: false, lease, reason: "LEASE_WORKSPACE_MISMATCH", path: p.lease };
    return { exists: true, valid: true, lease, path: p.lease };
  } catch {
    return { exists: true, valid: false, lease: null, reason: "LEASE_PARSE_INVALID", path: p.lease };
  }
}

function withClaimLock(repoRoot, actor, fn) {
  const p = paths(repoRoot);
  const ownerIdHash = digest(`${actor.provider}:${actor.sessionIdHash}`);
  const lock = acquireAtomicLock(p.lock, { ownerIdHash, staleAfterMs: 30_000 });
  if (!lock.acquired) return { locked: false, reason: lock.reason };
  try {
    return { locked: true, value: fn(p) };
  } finally {
    releaseAtomicLock(lock.handle);
  }
}

export function claimWorkLease(repoRoot, {
  workspaceId = "primary",
  taskId,
  actor,
  capabilities,
  expectedGeneration = null,
  candidate = null,
} = {}) {
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor || !String(taskId || "").trim()) return { claimed: false, lease: null, reason: "LEASE_IDENTITY_INVALID" };
  const caps = normalizedCapabilities(capabilities);
  const attempt = withClaimLock(repoRoot, normalizedActor, (p) => {
    const current = readWorkLease(repoRoot, workspaceId);
    if (!current.valid) return { claimed: false, lease: current.lease, reason: current.reason || "LEASE_IDENTITY_INVALID" };

    if (!current.exists) {
      if (expectedGeneration !== null && expectedGeneration !== -1) return { claimed: false, lease: null, reason: "STALE_WORK_LEASE" };
      const lease = {
        schema: "orchestra.work-lease.v1",
        projectLineage: lineageFor(repoRoot),
        workspaceId,
        taskId: String(taskId),
        generation: 0,
        state: caps.includes("WORKSPACE_EDIT") ? "IMPLEMENTING" : "CONTROL",
        actor: normalizedActor,
        capabilities: caps,
        candidate: candidate ?? null,
      };
      return { claimed: true, lease: writeLease(p.lease, lease), reason: null };
    }

    const lease = current.lease;
    if (expectedGeneration !== null && expectedGeneration !== lease.generation) {
      return { claimed: false, lease, reason: "STALE_WORK_LEASE" };
    }

    if (!TERMINAL_STATES.has(lease.state) && lease.capabilities.includes("WORKSPACE_EDIT") && !sameActor(lease.actor, normalizedActor)) {
      return { claimed: false, lease, reason: "WRITE_LEASE_ACTIVE" };
    }

    if (!TERMINAL_STATES.has(lease.state) && sameActor(lease.actor, normalizedActor) && lease.taskId === String(taskId)) {
      return { claimed: true, lease, reason: null };
    }

    const next = {
      schema: "orchestra.work-lease.v1",
      projectLineage: lease.projectLineage,
      workspaceId,
      taskId: String(taskId),
      generation: lease.generation + 1,
      state: caps.includes("WORKSPACE_EDIT") ? "IMPLEMENTING" : "CONTROL",
      actor: normalizedActor,
      capabilities: caps,
      candidate: candidate ?? lease.candidate ?? null,
    };
    return { claimed: true, lease: writeLease(p.lease, next), reason: null };
  });
  return attempt.locked ? attempt.value : { claimed: false, lease: null, reason: attempt.reason };
}

export function transitionWorkLease(repoRoot, { generation, state, actor, capabilities, candidate } = {}) {
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor || !Number.isInteger(generation)) return { changed: false, lease: null, reason: "LEASE_IDENTITY_INVALID" };
  const attempt = withClaimLock(repoRoot, normalizedActor, (p) => {
    const current = readWorkLease(repoRoot);
    if (!current.exists || !current.valid) return { changed: false, lease: current.lease, reason: current.reason || "LEASE_IDENTITY_INVALID" };
    const lease = current.lease;
    if (lease.generation !== generation) return { changed: false, lease, reason: "STALE_WORK_LEASE" };
    if (!sameActor(lease.actor, normalizedActor)) return { changed: false, lease, reason: "LEASE_IDENTITY_INVALID" };
    const next = {
      ...lease,
      state: state || lease.state,
      capabilities: capabilities === undefined ? lease.capabilities : normalizedCapabilities(capabilities),
      candidate: candidate === undefined ? lease.candidate : candidate,
    };
    return { changed: true, lease: writeLease(p.lease, next), reason: null };
  });
  return attempt.locked ? attempt.value : { changed: false, lease: null, reason: attempt.reason };
}

export function releaseWorkLease(repoRoot, { generation, actor, terminalState = "DONE" } = {}) {
  if (!TERMINAL_STATES.has(terminalState)) return { released: false, lease: null, reason: "LEASE_TERMINAL_STATE_INVALID" };
  const result = transitionWorkLease(repoRoot, { generation, actor, state: terminalState, capabilities: [] });
  return { released: result.changed, lease: result.lease, reason: result.reason };
}
