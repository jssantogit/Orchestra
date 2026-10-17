import { createHash } from "node:crypto";

import { validateOperationRecoveryV2 } from "./contracts.mjs";

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

export function canonicalRecoveryJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function recoveryDigest(value) {
  return createHash("sha256").update(canonicalRecoveryJson(value), "utf8").digest("hex");
}

function commandKey(projectId, commandId) {
  return `${projectId}\u0000${commandId}`;
}

function operationKey(projectId, operationId) {
  return `${projectId}\u0000${operationId}`;
}

export function requireRecoveryState(state) {
  if (!state?.projects?.inspect || !state?.operations?.inspect) {
    throw new TypeError("state with projects.inspect and operations.inspect is required");
  }
  return state;
}

export function validateRecoveryIdentity(state, recovery) {
  if (!validateOperationRecoveryV2(recovery).valid) return failure("RECOVERY_INVALID");
  const project = state.projects.inspect(recovery.projectId);
  if (!project) return failure("PROJECT_NOT_FOUND");
  const operation = state.operations.inspect(recovery.operationId);
  if (!operation) return failure("OPERATION_NOT_FOUND");
  if (operation.projectId !== recovery.projectId) return failure("OPERATION_PROJECT_MISMATCH");
  if (operation.workId !== recovery.workId || operation.generation !== recovery.generation) {
    return failure("RECOVERY_OPERATION_MISMATCH");
  }
  if (recovery.terminal !== null
    && (operation.liveness !== "TERMINAL"
      || operation.workflowState !== recovery.terminal.workflowState
      || operation.resultRef !== recovery.terminal.resultRef)) {
    return failure("RECOVERY_TERMINAL_STATE_MISMATCH");
  }
  return null;
}

export function createInMemoryRecoveryJournal({ state } = {}) {
  const store = requireRecoveryState(state);
  const commands = new Map();
  const byOperation = new Map();

  return Object.freeze({
    record(recovery) {
      const invalid = validateRecoveryIdentity(store, recovery);
      if (invalid) return invalid;

      const key = commandKey(recovery.projectId, recovery.commandId);
      const encoded = canonicalRecoveryJson(recovery);
      const fingerprint = recoveryDigest(recovery);
      const prior = commands.get(key);
      if (prior) {
        if (prior.digest !== fingerprint || prior.encoded !== encoded) {
          return failure("IDEMPOTENCY_CONFLICT");
        }
        return success({ recovery: clone(prior.recovery), replayed: true });
      }

      const stored = clone(recovery);
      commands.set(key, { recovery: stored, encoded, digest: fingerprint });
      const opKey = operationKey(recovery.projectId, recovery.operationId);
      const records = byOperation.get(opKey) ?? [];
      records.push(stored);
      byOperation.set(opKey, records);
      return success({ recovery: clone(stored), replayed: false });
    },

    byCommand({ projectId, commandId } = {}) {
      return clone(commands.get(commandKey(projectId, commandId))?.recovery ?? null);
    },

    latest({ projectId, operationId } = {}) {
      const records = byOperation.get(operationKey(projectId, operationId));
      return records?.length ? clone(records[records.length - 1]) : null;
    },
  });
}
