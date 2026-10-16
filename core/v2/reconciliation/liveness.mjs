const TERMINAL_WORKFLOW_STATES = new Set([
  "COMPLETED",
  "FAILED",
  "ABORTED",
  "PROMOTED",
  "DISCARDED",
  "DONE",
  "BLOCKED",
]);

export function classifyPersistedOperation({
  operation,
  ownerProof = null,
  heartbeatFresh = false,
  dirtyWorkspace = false,
  recoverableWorkspace = false,
} = {}) {
  if (!operation || typeof operation !== "object") {
    return { liveness: "UNKNOWN", reason: "OPERATION_FACTS_INVALID" };
  }

  if (TERMINAL_WORKFLOW_STATES.has(operation.workflowState)) {
    return { liveness: "TERMINAL", reason: "WORKFLOW_TERMINAL" };
  }

  if (ownerProof?.live === true && heartbeatFresh === true) {
    return { liveness: "LIVE", reason: "OWNER_AND_HEARTBEAT_PROVEN" };
  }

  if (ownerProof?.dead === true) {
    if (dirtyWorkspace) return { liveness: "STALE_DIRTY", reason: "OWNER_DEAD_DIRTY_WORKSPACE" };
    if (recoverableWorkspace) return { liveness: "STALE_RECOVERABLE", reason: "OWNER_DEAD_RECOVERABLE_WORKSPACE" };
    return { liveness: "STALE_RECOVERABLE", reason: "OWNER_DEAD" };
  }

  return { liveness: "UNKNOWN", reason: "LIVENESS_NOT_PROVEN" };
}
