const LIVENESS = new Set(["LIVE", "TERMINAL", "STALE_RECOVERABLE", "STALE_DIRTY", "UNKNOWN"]);
const WORKSPACE_STATUS = new Set(["ABSENT", "CLEAN", "DIRTY", "UNKNOWN"]);
const CLEANUP_STATUS = new Set(["NOT_REQUIRED", "CLEANED", "FAILED", "PRESERVED", "PENDING"]);
const OUTCOME = new Set(["RECOVERED", "STALE_DIRTY", "CLEANUP_FAILED"]);

function valid() {
  return { valid: true, errors: [] };
}

function invalid(message, path = "/") {
  return { valid: false, errors: [{ path, message }] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every((key) => keys.has(key));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function validateOperationRecoveryV2(value) {
  const top = new Set([
    "schema", "projectId", "operationId", "workId", "generation", "commandId",
    "assessment", "workspace", "terminal", "cleanup", "outcome", "recordedAt",
  ]);
  if (!hasOnlyKeys(value, top) || value.schema !== "orchestra.operation-recovery.v2") {
    return invalid("invalid recovery schema");
  }
  for (const key of ["projectId", "operationId", "workId", "commandId"]) {
    if (!nonEmpty(value[key])) return invalid(`${key} required`, `/${key}`);
  }
  if (!Number.isInteger(value.generation) || value.generation < 0) {
    return invalid("generation must be a non-negative integer", "/generation");
  }

  const assessmentKeys = new Set(["liveness", "reason", "observedAt"]);
  if (!hasOnlyKeys(value.assessment, assessmentKeys)
    || !LIVENESS.has(value.assessment.liveness)
    || !nonEmpty(value.assessment.reason)
    || !timestamp(value.assessment.observedAt)) {
    return invalid("invalid recovery assessment", "/assessment");
  }

  const workspaceKeys = new Set(["ref", "status"]);
  if (!hasOnlyKeys(value.workspace, workspaceKeys)
    || (value.workspace.ref !== null && !nonEmpty(value.workspace.ref))
    || !WORKSPACE_STATUS.has(value.workspace.status)) {
    return invalid("invalid recovery workspace", "/workspace");
  }

  if (value.terminal !== null) {
    const terminalKeys = new Set(["workflowState", "resultRef"]);
    if (!hasOnlyKeys(value.terminal, terminalKeys)
      || !nonEmpty(value.terminal.workflowState)
      || !nonEmpty(value.terminal.resultRef)) {
      return invalid("invalid recovery terminal result", "/terminal");
    }
  }

  const cleanupKeys = new Set(["status"]);
  if (!hasOnlyKeys(value.cleanup, cleanupKeys) || !CLEANUP_STATUS.has(value.cleanup.status)) {
    return invalid("invalid recovery cleanup", "/cleanup");
  }
  if (!OUTCOME.has(value.outcome)) return invalid("invalid recovery outcome", "/outcome");
  if (!timestamp(value.recordedAt)) return invalid("invalid recovery timestamp", "/recordedAt");
  return valid();
}
