const LIVENESS = new Set(["LIVE", "TERMINAL", "STALE_RECOVERABLE", "STALE_DIRTY", "UNKNOWN"]);
const RECOVERY_ASSESSMENT_LIVENESS = new Set(["TERMINAL", "STALE_RECOVERABLE"]);
const WORKSPACE_STATUS = new Set(["ABSENT", "CLEAN", "DIRTY", "PROJECT_ROOT", "UNKNOWN"]);
const CLEANUP_STATUS = new Set(["NOT_REQUIRED", "CLEANED", "FAILED", "PRESERVED", "PENDING"]);
const OUTCOME = new Set(["RECOVERED", "STALE_DIRTY", "CLEANUP_FAILED"]);
const RESOLUTION_ACTIONS = new Set(["PRESERVE", "DISCARD"]);
const RECOVERY_WORKFLOW_STATE = "ABORTED";
const RECOVERY_RESULT_REASON = "OWNER_TERMINATED_WITHOUT_TERMINALIZATION";
const EXPLICIT_DISCARD_REASON = "STALE_DIRTY_EXPLICIT_DISCARD";

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

function expectedRecoveryResultRef(operationId) {
  return `recovery:${operationId}:${RECOVERY_RESULT_REASON}`;
}

function validateResolutionAction(value) {
  if (value.resolutionAction === undefined) return null;
  if (!RESOLUTION_ACTIONS.has(value.resolutionAction)) {
    return invalid("invalid dirty resolution action", "/resolutionAction");
  }
  if (value.terminal === null) {
    return invalid("dirty resolution action requires factual terminalization", "/terminal");
  }
  if (value.resolutionAction === "PRESERVE") {
    if (value.outcome !== "STALE_DIRTY"
      || value.workspace.status !== "DIRTY"
      || value.cleanup.status !== "PRESERVED") {
      return invalid("preserve resolution must retain a stale-dirty preserved workspace", "/resolutionAction");
    }
    return null;
  }

  if (value.outcome === "STALE_DIRTY") {
    if (value.workspace.status !== "DIRTY" || value.cleanup.status !== "PRESERVED") {
      return invalid("failed discard must preserve a factual dirty workspace", "/resolutionAction");
    }
    return null;
  }

  if (value.outcome === "RECOVERED") {
    if (value.workspace.status !== "ABSENT"
      || value.cleanup.status !== "NOT_REQUIRED"
      || value.assessment.reason !== EXPLICIT_DISCARD_REASON) {
      return invalid("successful discard requires factual workspace absence", "/resolutionAction");
    }
    return null;
  }

  return invalid("discard resolution must either remain stale-dirty or recover", "/resolutionAction");
}

function validateRecoverySemantics(value) {
  if (!RECOVERY_ASSESSMENT_LIVENESS.has(value.assessment.liveness)) {
    return invalid("recovery assessment must be stale-recoverable or terminal", "/assessment/liveness");
  }

  if (value.workspace.ref === null && value.workspace.status !== "ABSENT") {
    return invalid("workspace without a factual ref must be absent", "/workspace");
  }
  if (value.workspace.ref !== null && value.workspace.status === "ABSENT") {
    // A managed workspace may have already disappeared; the ref remains factual audit identity.
  }

  if (value.terminal !== null) {
    if (value.terminal.workflowState !== RECOVERY_WORKFLOW_STATE) {
      return invalid("recovery terminal state must be ABORTED", "/terminal/workflowState");
    }
    if (value.terminal.resultRef !== expectedRecoveryResultRef(value.operationId)) {
      return invalid("recovery terminal result must bind to the recovered operation", "/terminal/resultRef");
    }
  }

  const resolutionError = validateResolutionAction(value);
  if (resolutionError) return resolutionError;

  if (value.outcome === "RECOVERED") {
    if (value.terminal === null) {
      return invalid("recovered outcome requires factual terminalization", "/terminal");
    }
    if (value.workspace.status === "CLEAN" && value.cleanup.status !== "CLEANED") {
      return invalid("clean recovered workspace must be cleaned", "/cleanup/status");
    }
    if (value.workspace.status === "ABSENT" && value.cleanup.status !== "NOT_REQUIRED") {
      return invalid("absent recovered workspace needs no cleanup", "/cleanup/status");
    }
    if (value.workspace.status === "PROJECT_ROOT" && value.cleanup.status !== "NOT_REQUIRED") {
      return invalid("persistent project root must never be cleaned", "/cleanup/status");
    }
    if (!new Set(["CLEAN", "ABSENT", "PROJECT_ROOT"]).has(value.workspace.status)) {
      return invalid("recovered outcome requires clean, absent, or persistent project-root workspace", "/workspace/status");
    }
    return valid();
  }

  if (value.outcome === "STALE_DIRTY") {
    if (value.workspace.status !== "DIRTY") {
      return invalid("stale-dirty outcome requires dirty workspace", "/workspace/status");
    }
    if (value.cleanup.status !== "PRESERVED") {
      return invalid("stale-dirty outcome must preserve workspace", "/cleanup/status");
    }
    return valid();
  }

  if (value.outcome === "CLEANUP_FAILED") {
    if (value.terminal === null) {
      return invalid("cleanup failure requires factual terminalization", "/terminal");
    }
    if (value.workspace.status !== "CLEAN") {
      return invalid("cleanup failure requires a previously clean workspace", "/workspace/status");
    }
    if (value.cleanup.status !== "FAILED") {
      return invalid("cleanup-failed outcome requires failed cleanup status", "/cleanup/status");
    }
    return valid();
  }

  return invalid("invalid recovery outcome", "/outcome");
}

export function validateOperationRecoveryV2(value) {
  const top = new Set([
    "schema", "projectId", "operationId", "workId", "generation", "commandId",
    "assessment", "workspace", "terminal", "cleanup", "outcome", "recordedAt", "resolutionAction",
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
  return validateRecoverySemantics(value);
}
