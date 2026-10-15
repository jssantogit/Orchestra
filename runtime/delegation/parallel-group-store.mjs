import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { validateParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";

const GROUP_ROOT = ".orchestra/state/delegation/parallel-groups";
const GROUP_STATE_SCHEMA = "orchestra.parallel-group-state.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATES = new Set([
  "CREATED",
  "RUNNING",
  "MEMBERS_READY",
  "COMPOSING",
  "READY_FOR_REVIEW",
  "FAILED",
  "PROMOTED",
  "DISCARDED",
]);
const IN_FLIGHT_STATES = new Set(["CREATED", "RUNNING", "MEMBERS_READY", "COMPOSING"]);
const TRANSITIONS = new Map([
  ["CREATED", new Set(["RUNNING", "FAILED"])],
  ["RUNNING", new Set(["MEMBERS_READY", "FAILED"])],
  ["MEMBERS_READY", new Set(["COMPOSING", "FAILED"])],
  ["COMPOSING", new Set(["READY_FOR_REVIEW", "FAILED"])],
  ["READY_FOR_REVIEW", new Set(["PROMOTED", "DISCARDED", "FAILED"])],
  ["FAILED", new Set()],
  ["PROMOTED", new Set()],
  ["DISCARDED", new Set()],
]);
const RECORD_KEYS = new Set([
  "schema",
  "group",
  "state",
  "memberArtifactIds",
  "compositeArtifactId",
  "failureReason",
  "cleanupFailures",
  "createdAt",
  "updatedAt",
]);
const CLEANUP_KEYS = new Set(["memberId", "recoverablePath"]);
const TRANSITION_KEYS = new Set([
  "expectedState",
  "nextState",
  "memberArtifactIds",
  "compositeArtifactId",
  "failureReason",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validTimestamp(value) {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

export function assertParallelGroupId(groupId) {
  if (typeof groupId !== "string"
      || groupId === "."
      || groupId === ".."
      || !SAFE_ID.test(groupId)) fail("PARALLEL_GROUP_ID_INVALID");
  return groupId;
}

function validArtifactIds(value) {
  return Array.isArray(value)
    && value.length <= 2
    && new Set(value).size === value.length
    && value.every((id) => SAFE_ID.test(id));
}

function validCleanupFailures(value, group) {
  if (!Array.isArray(value) || value.length > 2) return false;
  const memberIds = new Set(group.members.map((member) => member.memberId));
  const seen = new Set();
  for (const entry of value) {
    if (!exactKeys(entry, CLEANUP_KEYS)
        || !boundedString(entry.memberId, 160)
        || !memberIds.has(entry.memberId)
        || seen.has(entry.memberId)
        || !boundedString(entry.recoverablePath, 4096)) return false;
    seen.add(entry.memberId);
  }
  return true;
}

function validStateFacts(record) {
  const memberCount = record.memberArtifactIds.length;
  const hasComposite = record.compositeArtifactId !== null;
  const hasFailure = record.failureReason !== null;
  if (["CREATED", "RUNNING"].includes(record.state)) {
    return memberCount === 0 && !hasComposite && !hasFailure;
  }
  if (["MEMBERS_READY", "COMPOSING"].includes(record.state)) {
    return memberCount === 2 && !hasComposite && !hasFailure;
  }
  if (["READY_FOR_REVIEW", "PROMOTED", "DISCARDED"].includes(record.state)) {
    return memberCount === 2 && hasComposite && !hasFailure;
  }
  if (record.state === "FAILED") {
    return memberCount <= 2 && !hasComposite && hasFailure;
  }
  return false;
}

function validateRecord(record) {
  if (!exactKeys(record, RECORD_KEYS) || record.schema !== GROUP_STATE_SCHEMA) return false;
  const groupValidation = validateParallelImplementationGroup(record.group);
  if (!groupValidation.valid) return false;
  try { assertParallelGroupId(record.group.groupId); } catch { return false; }
  if (!STATES.has(record.state)
      || !validArtifactIds(record.memberArtifactIds)
      || !(record.compositeArtifactId === null || SAFE_ID.test(record.compositeArtifactId))
      || !(record.failureReason === null || boundedString(record.failureReason, 256))
      || !validCleanupFailures(record.cleanupFailures, record.group)
      || !validTimestamp(record.createdAt)
      || !validTimestamp(record.updatedAt)) return false;
  return validStateFacts(record);
}

function paths(repoRoot, groupId = null) {
  const root = resolve(repoRoot);
  const groups = join(root, GROUP_ROOT);
  if (groupId === null) return { root, groups };
  assertParallelGroupId(groupId);
  const dir = join(groups, groupId);
  return { root, groups, dir, record: join(dir, "group.json") };
}

function replaceRecord(repoRoot, groupId, record) {
  const p = paths(repoRoot, groupId);
  if (!validateRecord(record) || record.group.groupId !== groupId) fail("PARALLEL_GROUP_STATE_INVALID");
  const temp = `${p.record}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, p.record);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return record;
}

export function createParallelGroup(repoRoot, group) {
  const validation = validateParallelImplementationGroup(group);
  if (!validation.valid) fail("PARALLEL_IMPLEMENTATION_GROUP_INVALID");
  const groupId = assertParallelGroupId(group.groupId);
  const p = paths(repoRoot, groupId);
  mkdirSync(p.groups, { recursive: true });
  if (existsSync(p.dir)) fail("PARALLEL_GROUP_ALREADY_EXISTS");
  const now = new Date().toISOString();
  const record = {
    schema: GROUP_STATE_SCHEMA,
    group,
    state: "CREATED",
    memberArtifactIds: [],
    compositeArtifactId: null,
    failureReason: null,
    cleanupFailures: [],
    createdAt: now,
    updatedAt: now,
  };
  if (!validateRecord(record)) fail("PARALLEL_GROUP_STATE_INVALID");

  const tempDir = join(p.groups, `.${groupId}.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(tempDir, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(join(tempDir, "group.json"), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tempDir, p.dir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return record;
}

export function readParallelGroup(repoRoot, groupId) {
  const p = paths(repoRoot, groupId);
  if (!existsSync(p.dir)) {
    return { exists: false, valid: true, record: null, reason: null, path: p.dir };
  }
  if (!existsSync(p.record)) {
    return {
      exists: true,
      valid: false,
      record: null,
      reason: "PARALLEL_GROUP_STATE_INVALID",
      path: p.dir,
    };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(p.record, "utf8"));
  } catch {
    return {
      exists: true,
      valid: false,
      record: null,
      reason: "PARALLEL_GROUP_STATE_INVALID",
      path: p.dir,
    };
  }
  if (!validateRecord(record) || record.group.groupId !== groupId) {
    return {
      exists: true,
      valid: false,
      record,
      reason: "PARALLEL_GROUP_STATE_INVALID",
      path: p.dir,
    };
  }
  return { exists: true, valid: true, record, reason: null, path: p.dir };
}

export function listParallelGroups(repoRoot) {
  const p = paths(repoRoot);
  if (!existsSync(p.groups)) return [];
  const records = [];
  for (const name of readdirSync(p.groups).sort()) {
    if (name.startsWith(".")) continue;
    const result = readParallelGroup(repoRoot, name);
    if (!result.exists || !result.valid || !result.record) fail("PARALLEL_GROUP_STATE_INVALID");
    records.push(result.record);
  }
  return records.sort((a, b) => a.group.groupId.localeCompare(b.group.groupId));
}

export function hasInFlightParallelGroup(repoRoot) {
  return listParallelGroups(repoRoot).some((record) => IN_FLIGHT_STATES.has(record.state));
}

export function transitionParallelGroupState(repoRoot, groupId, transition = {}) {
  if (!exactKeys(transition, TRANSITION_KEYS)) fail("PARALLEL_GROUP_TRANSITION_INVALID");
  const { expectedState, nextState } = transition;
  if (!STATES.has(expectedState)
      || !STATES.has(nextState)
      || !TRANSITIONS.get(expectedState)?.has(nextState)) {
    const current = readParallelGroup(repoRoot, groupId);
    return {
      transitioned: false,
      reason: "PARALLEL_GROUP_TRANSITION_INVALID",
      record: current.valid ? current.record : null,
    };
  }

  const current = readParallelGroup(repoRoot, groupId);
  if (!current.exists || !current.valid || !current.record) {
    return {
      transitioned: false,
      reason: current.reason ?? "PARALLEL_GROUP_STATE_INVALID",
      record: current.record,
    };
  }
  if (current.record.state !== expectedState) {
    return {
      transitioned: false,
      reason: "PARALLEL_GROUP_STATE_MISMATCH",
      record: current.record,
    };
  }

  const next = {
    ...current.record,
    state: nextState,
    ...(transition.memberArtifactIds === undefined ? {} : { memberArtifactIds: [...transition.memberArtifactIds] }),
    ...(transition.compositeArtifactId === undefined ? {} : { compositeArtifactId: transition.compositeArtifactId }),
    failureReason: nextState === "FAILED" ? transition.failureReason ?? null : null,
    updatedAt: new Date().toISOString(),
  };
  if (!validateRecord(next)) {
    return {
      transitioned: false,
      reason: "PARALLEL_GROUP_STATE_INVALID",
      record: current.record,
    };
  }
  return {
    transitioned: true,
    reason: null,
    record: replaceRecord(repoRoot, groupId, next),
  };
}

export function recordParallelGroupCleanup(repoRoot, groupId, cleanupFailures) {
  const current = readParallelGroup(repoRoot, groupId);
  if (!current.exists || !current.valid || !current.record) {
    return { updated: false, reason: current.reason ?? "PARALLEL_GROUP_STATE_INVALID", record: current.record };
  }
  if (!validCleanupFailures(cleanupFailures, current.record.group)) fail("PARALLEL_GROUP_CLEANUP_INVALID");
  const next = {
    ...current.record,
    cleanupFailures: cleanupFailures.map((entry) => ({ ...entry })),
    updatedAt: new Date().toISOString(),
  };
  return {
    updated: true,
    reason: null,
    record: replaceRecord(repoRoot, groupId, next),
  };
}
