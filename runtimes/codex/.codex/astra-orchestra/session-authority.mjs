import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export const CODEX_SESSION_AUTHORITY_SCHEMA = "orchestra.codex-session-authority.v1";
export const CODEX_SESSION_HANDOFF_SCHEMA = "orchestra.codex-session-handoff.v1";
export const CODEX_SESSION_HANDOFF_STATUSES = Object.freeze({
  ARMED: "ARMED",
  CLAIMED: "CLAIMED",
  CANCELLED: "CANCELLED",
});
export const CODEX_SESSION_HANDOFF_MODE = "MILESTONE_BOUNDARY";
export const CODEX_SESSION_AUTHORITY_STATUSES = Object.freeze({
  ACTIVE: "ACTIVE",
  TRANSFERRING: "TRANSFERRING",
});

const QUIESCENT_STATES = new Set(["INTAKE", "DONE", "BLOCKED", "HUMAN_GATE"]);
const RUNTIME_STATE_DIR = ".codex/orchestra-state";
const FORBIDDEN_CAPSULE_KEYS = new Set([
  "transcript", "transcripts", "transcript_path", "messages", "prompt", "prompts",
  "reasoning", "thinking", "chainOfThought", "chain_of_thought", "stdout", "stderr",
  "credentials", "secret", "secrets", "environment", "env", "raw", "rawContent", "raw_content",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(stable(value)),
  ).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 500) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function recordBody(record = {}) {
  const body = { ...record };
  delete body.record_hash;
  return body;
}

function finalizeRecord(record = {}) {
  const body = stable(recordBody(record));
  return { ...body, record_hash: digest(body) };
}

function validateHashedRecord(record, schema) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, reason: "MISSING_OR_INVALID" };
  }
  if (record.schema !== schema) return { valid: false, reason: "SCHEMA_MISMATCH" };
  const expected = digest(stable(recordBody(record)));
  if (record.record_hash !== expected) return { valid: false, reason: "HASH_MISMATCH" };
  return { valid: true, reason: null };
}

function sanitizeCapsule(value, path = "capsule") {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeCapsule(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 2000 ? value.slice(0, 2000) : value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CAPSULE_KEYS.has(key)) {
      throw new Error(`CODEX_SESSION_HANDOFF_FORBIDDEN_CAPSULE_FIELD:${path}.${key}`);
    }
    out[key] = sanitizeCapsule(child, `${path}.${key}`);
  }
  return out;
}

function paths(repoRoot) {
  const root = resolve(repoRoot);
  return {
    root,
    activeState: join(root, RUNTIME_STATE_DIR, "active-state.json"),
    activeContract: join(root, RUNTIME_STATE_DIR, "active-contract.json"),
    authority: join(root, RUNTIME_STATE_DIR, "session-authority.json"),
    handoff: join(root, RUNTIME_STATE_DIR, "session-handoff.json"),
    claimLock: join(root, RUNTIME_STATE_DIR, "session-handoff.claim.lock"),
    telemetry: join(root, ".codex/orchestra-telemetry/events.jsonl"),
  };
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function appendTelemetry(path, event) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ timestamp: nowIso(), ...event }) + "\n", "utf8");
  } catch {}
}

function gitOutput(root, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function workspacePathspecs() {
  return [
    ".",
    ":(exclude).agents/**",
    ":(exclude).codex/orchestra-state/**",
    ":(exclude).codex/orchestra-telemetry/**",
    ":(exclude).codex/orchestra-artifacts/**",
    ":(exclude).codex/orchestra-semantic/**",
    ":(exclude).codex/runtime-management/**",
    ":(exclude).codex/orchestra-runtime.json",
  ];
}

function nulPaths(buffer) {
  return String(buffer || "").split("\0").filter(Boolean);
}

function hashRegularFile(path) {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      h.update(buffer.subarray(0, bytesRead));
    }
    return h.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function workingFileIdentity(root, relPath) {
  const absolute = join(root, relPath);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return { path: relPath, kind: "SYMLINK", mode: stat.mode & 0o7777, content_hash: digest(readlinkSync(absolute, "utf8")) };
    }
    if (stat.isFile()) {
      return { path: relPath, kind: "FILE", mode: stat.mode & 0o7777, size: stat.size, content_hash: hashRegularFile(absolute) };
    }
    if (stat.isDirectory()) {
      let nestedHead = null;
      try { nestedHead = gitOutput(absolute, ["rev-parse", "HEAD"]).trim() || null; } catch {}
      return { path: relPath, kind: "DIRECTORY", mode: stat.mode & 0o7777, nested_head: nestedHead };
    }
    return { path: relPath, kind: "OTHER", mode: stat.mode & 0o7777, size: stat.size };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relPath, kind: "DELETED" };
    throw error;
  }
}

export function readCodexWorkspaceFingerprint(repoRoot) {
  const root = resolve(repoRoot);
  try {
    const specs = workspacePathspecs();
    const head = gitOutput(root, ["rev-parse", "HEAD"]).trim() || null;
    const indexListing = gitOutput(root, ["ls-files", "-s", "-z", "--", ...specs], { encoding: "buffer" });
    const indexHash = digest(indexListing);
    const trackedDirty = nulPaths(gitOutput(root, ["diff", "--name-only", "-z", "HEAD", "--", ...specs], { encoding: "buffer" }));
    const untracked = nulPaths(gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs], { encoding: "buffer" }));
    const dirtyPaths = [...new Set([...trackedDirty, ...untracked])].sort();
    const workingFiles = dirtyPaths.map((relPath) => workingFileIdentity(root, relPath));
    const body = { head, index_hash: indexHash, working_files: workingFiles };
    return {
      available: true,
      head,
      index_hash: indexHash,
      working_tree_hash: digest(workingFiles),
      dirty_file_count: workingFiles.length,
      fingerprint: digest(body),
    };
  } catch {
    return {
      available: false,
      head: null,
      index_hash: null,
      working_tree_hash: null,
      dirty_file_count: null,
      fingerprint: digest({ git: "UNAVAILABLE" }),
    };
  }
}

function activeStateSnapshot(activeState = {}) {
  return {
    taskId: activeState.taskId || activeState.taskKey || null,
    taskAction: activeState.taskAction || activeState.task_action || null,
    taskDomain: activeState.taskDomain || activeState.task_domain || null,
    state: activeState.state || null,
    acceptanceState: activeState.acceptanceState || null,
    attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
    mutationSeq: Number.isInteger(activeState.mutationSeq)
      ? activeState.mutationSeq
      : (Number.isInteger(activeState.mutation_seq) ? activeState.mutation_seq : 0),
    candidateHead: activeState.evidenceCandidateHead || activeState.candidateHead || activeState.currentHead || null,
    ciWait: activeState.ciWait && typeof activeState.ciWait === "object"
      ? {
          status: activeState.ciWait.status || activeState.ciWait.state || null,
          watchId: activeState.ciWait.watchId || activeState.ciWait.watch_id || null,
        }
      : null,
    evidenceWatchCount: activeState.evidenceWatches && typeof activeState.evidenceWatches === "object"
      ? Object.values(activeState.evidenceWatches).filter((watch) => !String(watch?.status || "").startsWith("TERMINAL_") && watch?.status !== "TIMED_OUT").length
      : 0,
  };
}

export function codexActiveStateFingerprint(activeState = {}) {
  return digest(activeStateSnapshot(activeState));
}

function boundaryReady(activeState = {}) {
  if (!activeState || Object.keys(activeState).length === 0) return true;
  const state = String(activeState.state || "INTAKE").toUpperCase();
  if (!QUIESCENT_STATES.has(state)) return false;
  if (activeStateSnapshot(activeState).evidenceWatchCount > 0) return false;
  const ciStatus = String(activeState.ciWait?.status || activeState.ciWait?.state || "").toUpperCase();
  if (ciStatus && !["DONE", "SUCCESS", "FAILED", "CANCELLED", "COMPLETE", "COMPLETED", "TIMED_OUT"].includes(ciStatus)) return false;
  return true;
}

function boundaryCapsule(activeState = {}, authority = {}, reason = null, label = null) {
  return sanitizeCapsule({
    schema: "orchestra.codex-session-boundary-capsule.v1",
    mode: CODEX_SESSION_HANDOFF_MODE,
    lineage_id: authority.lineage_id,
    previous_generation: authority.generation,
    target_generation: authority.generation + 1,
    previous_task: {
      task_id: activeState.taskId || activeState.taskKey || null,
      state: activeState.state || "INTAKE",
      acceptance_state: activeState.acceptanceState || null,
      attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
      mutation_seq: Number.isInteger(activeState.mutationSeq)
        ? activeState.mutationSeq
        : (Number.isInteger(activeState.mutation_seq) ? activeState.mutation_seq : 0),
      candidate_head: activeState.evidenceCandidateHead || activeState.candidateHead || null,
    },
    reason: clean(reason) || null,
    label: clean(label, 160) || null,
    context_policy: "FRESH_MILESTONE_NO_PREVIOUS_SCOPE_EVIDENCE_OR_TRANSCRIPT",
  });
}

function validateAuthority(record) {
  const base = validateHashedRecord(record, CODEX_SESSION_AUTHORITY_SCHEMA);
  if (!base.valid) return base;
  if (!record.main_session_id || !record.lineage_id || !Number.isInteger(record.generation) || record.generation < 0) {
    return { valid: false, reason: "AUTHORITY_IDENTITY_INVALID" };
  }
  if (!Object.values(CODEX_SESSION_AUTHORITY_STATUSES).includes(record.status)) {
    return { valid: false, reason: "AUTHORITY_STATUS_INVALID" };
  }
  if (record.status === CODEX_SESSION_AUTHORITY_STATUSES.TRANSFERRING && (!record.pending_session_id || !record.pending_handoff_id)) {
    return { valid: false, reason: "AUTHORITY_TRANSFER_IDENTITY_INVALID" };
  }
  return { valid: true, reason: null };
}

export function validateCodexSessionHandoff(record) {
  const base = validateHashedRecord(record, CODEX_SESSION_HANDOFF_SCHEMA);
  if (!base.valid) return base;
  if (!Object.values(CODEX_SESSION_HANDOFF_STATUSES).includes(record.status)) return { valid: false, reason: "HANDOFF_STATUS_INVALID" };
  if (record.mode !== CODEX_SESSION_HANDOFF_MODE) return { valid: false, reason: "HANDOFF_MODE_INVALID" };
  if (!record.handoff_id || !record.from_session_id || !record.lineage_id) return { valid: false, reason: "HANDOFF_IDENTITY_INVALID" };
  try { sanitizeCapsule(record.capsule || {}); } catch (error) { return { valid: false, reason: String(error.message || error) }; }
  return { valid: true, reason: null };
}

export function readCodexSessionAuthority(repoRoot) {
  const p = paths(repoRoot);
  if (!existsSync(p.authority)) return { exists: false, valid: true, record: null, path: p.authority };
  const record = readJson(p.authority, null);
  const validation = validateAuthority(record);
  return { exists: true, valid: validation.valid, reason: validation.reason, record, path: p.authority };
}

export function readCodexSessionHandoff(repoRoot) {
  const p = paths(repoRoot);
  if (!existsSync(p.handoff)) return { exists: false, valid: true, record: null, path: p.handoff };
  const record = readJson(p.handoff, null);
  const validation = validateCodexSessionHandoff(record);
  return { exists: true, valid: validation.valid, reason: validation.reason, record, path: p.handoff };
}

function createAuthority({ sessionId, lineageId = null, generation = 0, source = "SESSION_START_BOOTSTRAP", previousSessionId = null } = {}) {
  const createdAt = nowIso();
  return finalizeRecord({
    schema: CODEX_SESSION_AUTHORITY_SCHEMA,
    lineage_id: lineageId || `codex-lineage-${digest({ sessionId, createdAt }).slice(0, 24)}`,
    generation,
    main_session_id: sessionId,
    previous_session_id: previousSessionId,
    status: CODEX_SESSION_AUTHORITY_STATUSES.ACTIVE,
    pending_session_id: null,
    pending_handoff_id: null,
    source,
    confidence: "HIGH",
    updated_at: createdAt,
  });
}

function writeAuthority(repoRoot, authority) {
  const p = paths(repoRoot);
  writeJson(p.authority, authority);
  return authority;
}

export function bootstrapCodexSessionAuthority(repoRoot, { sessionId } = {}) {
  const sid = clean(sessionId, 300);
  if (!sid) throw new Error("CODEX_SESSION_ID_REQUIRED");
  const current = readCodexSessionAuthority(repoRoot);
  if (current.exists) {
    if (!current.valid) throw new Error(`CODEX_SESSION_AUTHORITY_INVALID:${current.reason}`);
    return { bootstrapped: false, authority: current.record };
  }
  const handoff = readCodexSessionHandoff(repoRoot);
  if (handoff.exists && (!handoff.valid || handoff.record?.status === CODEX_SESSION_HANDOFF_STATUSES.ARMED)) {
    throw new Error("CODEX_SESSION_AUTHORITY_MISSING_WITH_HANDOFF_STATE");
  }
  const authority = createAuthority({ sessionId: sid });
  writeAuthority(repoRoot, authority);
  const p = paths(repoRoot);
  appendTelemetry(p.telemetry, {
    type: "CODEX_SESSION_AUTHORITY_BOOTSTRAPPED",
    sessionId: sid,
    lineageId: authority.lineage_id,
    generation: authority.generation,
  });
  return { bootstrapped: true, authority };
}

export function authorizeCodexSession(repoRoot, sessionId) {
  const sid = clean(sessionId, 300);
  if (!sid) return { allowed: false, reason: "CODEX_SESSION_ID_REQUIRED", authority: null };
  const current = readCodexSessionAuthority(repoRoot);
  if (!current.exists) return { allowed: false, reason: "CODEX_SESSION_AUTHORITY_NOT_INITIALIZED", authority: null };
  if (!current.valid) return { allowed: false, reason: `CODEX_SESSION_AUTHORITY_INVALID:${current.reason}`, authority: null };
  if (current.record.status === CODEX_SESSION_AUTHORITY_STATUSES.TRANSFERRING) {
    return { allowed: false, reason: "CODEX_SESSION_AUTHORITY_TRANSFERRING", authority: current.record };
  }
  if (current.record.main_session_id !== sid) {
    return { allowed: false, reason: "CODEX_SESSION_NOT_MAIN", authority: current.record };
  }
  return { allowed: true, reason: null, authority: current.record };
}

export function prepareCodexSessionHandoff(repoRoot, { reason = null, label = null } = {}) {
  const p = paths(repoRoot);
  const authorityLoad = readCodexSessionAuthority(repoRoot);
  if (!authorityLoad.exists) throw new Error("CODEX_SESSION_AUTHORITY_NOT_INITIALIZED");
  if (!authorityLoad.valid) throw new Error(`CODEX_SESSION_AUTHORITY_INVALID:${authorityLoad.reason}`);
  const authority = authorityLoad.record;
  if (authority.status === CODEX_SESSION_AUTHORITY_STATUSES.TRANSFERRING) {
    throw new Error("CODEX_SESSION_AUTHORITY_TRANSFERRING");
  }
  const activeState = readJson(p.activeState, {});
  if (!boundaryReady(activeState)) throw new Error("CODEX_SESSION_HANDOFF_BOUNDARY_NOT_QUIESCENT");
  const workspace = readCodexWorkspaceFingerprint(repoRoot);
  if (!workspace.available) throw new Error("CODEX_SESSION_HANDOFF_GIT_REQUIRED");
  const stateFingerprint = codexActiveStateFingerprint(activeState);

  const existing = readCodexSessionHandoff(repoRoot);
  if (
    existing.exists && existing.valid && existing.record.status === CODEX_SESSION_HANDOFF_STATUSES.ARMED
