import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const STATE_DIR = ".orchestra/state/delegations";
const RECORD_SCHEMA = "orchestra.delegation-record.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATUSES = new Set(["STARTED", "COMPLETED", "FAILED", "TIMED_OUT", "CLEANUP_FAILED"]);
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "CLEANUP_FAILED"]);
const FAILURE_REASONS = new Set([
  "PROVIDER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "WORKSPACE_PREP_FAILED",
  "EXECUTION_FAILED",
  "EXECUTION_TIMED_OUT",
  "INVALID_RESULT",
  "WORKSPACE_CLEANUP_FAILED",
]);
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "delegationId",
  "taskId",
  "generation",
  "source",
  "target",
  "purpose",
  "status",
  "startedAt",
  "completedAt",
  "durationMs",
  "failureReason",
  "workspace",
  "evidenceRefs",
]);
const SOURCE_KEYS = new Set(["provider", "actorIdHash"]);
const TARGET_KEYS = new Set(["provider", "logicalRole"]);
const WORKSPACE_KEYS = new Set([
  "sourceRevision",
  "initialFingerprint",
  "finalFingerprint",
  "dirty",
  "dirtyFileCount",
  "cleaned",
  "cleanupReason",
  "recoverablePath",
]);

function invalid(code = "DELEGATION_RECORD_INVALID") {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function assertDelegationId(delegationId) {
  if (typeof delegationId !== "string"
      || delegationId === "."
      || delegationId === ".."
      || !SAFE_ID.test(delegationId)) {
    invalid("DELEGATION_ID_INVALID");
  }
  return delegationId;
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, max, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validTimestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function validateRecord(record) {
  if (!exactKeys(record, TOP_LEVEL_KEYS)) return false;
  try {
    assertDelegationId(record.delegationId);
  } catch {
    return false;
  }
  if (record.schema !== undefined && record.schema !== RECORD_SCHEMA) return false;
  if (!boundedString(record.taskId, 300)) return false;
  if (!Number.isInteger(record.generation) || record.generation < 0) return false;

  if (!exactKeys(record.source, SOURCE_KEYS)
      || !boundedString(record.source.provider, 120)
      || !boundedString(record.source.actorIdHash, 300)) return false;
  if (!exactKeys(record.target, TARGET_KEYS)
      || !boundedString(record.target.provider, 120)
      || !boundedString(record.target.logicalRole, 120)) return false;
  if (!boundedString(record.purpose, 120)) return false;
  if (!STATUSES.has(record.status)) return false;
  if (!validTimestamp(record.startedAt)) return false;
  if (!validTimestamp(record.completedAt, { nullable: true })) return false;
  if (!(record.durationMs === null || (Number.isInteger(record.durationMs) && record.durationMs >= 0))) return false;
  if (!(record.failureReason === null || FAILURE_REASONS.has(record.failureReason))) return false;

  if (!exactKeys(record.workspace, WORKSPACE_KEYS)) return false;
  const workspace = record.workspace;
  if (!boundedString(workspace.sourceRevision, 300)) return false;
  if (!boundedString(workspace.initialFingerprint, 300)) return false;
  if (!(workspace.finalFingerprint === null || boundedString(workspace.finalFingerprint, 300))) return false;
  if (typeof workspace.dirty !== "boolean") return false;
  if (!Number.isInteger(workspace.dirtyFileCount) || workspace.dirtyFileCount < 0) return false;
  if (typeof workspace.cleaned !== "boolean") return false;
  if (!(workspace.cleanupReason === null || boundedString(workspace.cleanupReason, 300))) return false;
  if (!(workspace.recoverablePath === null || boundedString(workspace.recoverablePath, 4096))) return false;

  if (!Array.isArray(record.evidenceRefs)
      || record.evidenceRefs.length > 64
      || record.evidenceRefs.some((ref) => !boundedString(ref, 512))
      || new Set(record.evidenceRefs).size !== record.evidenceRefs.length) return false;

  if (record.status === "STARTED") {
    if (record.completedAt !== null || record.durationMs !== null || record.failureReason !== null) return false;
    if (workspace.cleaned !== false || workspace.cleanupReason !== null || workspace.recoverablePath !== null) return false;
    return true;
  }

  if (!TERMINAL_STATUSES.has(record.status)
      || record.completedAt === null
      || record.durationMs === null) return false;

  if (record.status === "COMPLETED") {
    if (record.failureReason !== null || workspace.cleaned !== true) return false;
  } else if (record.status === "CLEANUP_FAILED") {
    if (record.failureReason !== "WORKSPACE_CLEANUP_FAILED"
        || workspace.cleaned !== false
        || workspace.cleanupReason !== "WORKSPACE_CLEANUP_FAILED"
        || workspace.recoverablePath === null) return false;
  } else {
    if (record.failureReason === null || workspace.cleaned !== true) return false;
  }
  return true;
}

function paths(repoRoot, delegationId = null) {
  const root = resolve(repoRoot);
  const dir = join(root, STATE_DIR);
  return {
    root,
    dir,
    record: delegationId === null ? null : join(dir, `${delegationId}.json`),
  };
}

function normalizeRecord(record) {
  const candidate = {
    schema: RECORD_SCHEMA,
    ...record,
  };
  if (!validateRecord(candidate)) invalid();
  return candidate;
}

export function writeDelegationRecord(repoRoot, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) invalid();
  if (!Object.hasOwn(record, "delegationId")) invalid();
  assertDelegationId(record.delegationId);
  const normalized = normalizeRecord(record);
  const p = paths(repoRoot, normalized.delegationId);
  mkdirSync(p.dir, { recursive: true });
  const temp = `${p.record}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, p.record);
  return normalized;
}

export function readDelegationRecord(repoRoot, delegationId) {
  assertDelegationId(delegationId);
  const p = paths(repoRoot, delegationId);
  if (!existsSync(p.record)) {
    return { exists: false, valid: true, record: null, reason: null, path: p.record };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(p.record, "utf8"));
  } catch {
    return {
      exists: true,
      valid: false,
      record: null,
      reason: "DELEGATION_RECORD_PARSE_INVALID",
      path: p.record,
    };
  }
  if (!validateRecord(record)) {
    return {
      exists: true,
      valid: false,
      record,
      reason: "DELEGATION_RECORD_INVALID",
      path: p.record,
    };
  }
  return { exists: true, valid: true, record, reason: null, path: p.record };
}

export function listDelegationRecords(repoRoot) {
  const p = paths(repoRoot);
  if (!existsSync(p.dir)) return [];
  const records = [];
  for (const file of readdirSync(p.dir).filter((name) => name.endsWith(".json")).sort()) {
    const delegationId = file.slice(0, -5);
    let result;
    try {
      result = readDelegationRecord(repoRoot, delegationId);
    } catch {
      invalid();
    }
    if (!result.valid || !result.exists) invalid();
    records.push(result.record);
  }
  return records.sort((a, b) => a.delegationId.localeCompare(b.delegationId));
}

export function hasInFlightDelegation(repoRoot) {
  return listDelegationRecords(repoRoot).some((record) => record.status === "STARTED");
}
