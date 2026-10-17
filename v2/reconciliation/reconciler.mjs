import { validateLivenessAssessmentV2 } from "../liveness/contracts.mjs";

const RECOVERY_WORKFLOW_STATE = "ABORTED";
const RECOVERY_RESULT_REASON = "OWNER_TERMINATED_WITHOUT_TERMINALIZATION";
const WORKSPACE_STATUSES = new Set(["ABSENT", "CLEAN", "DIRTY", "UNKNOWN"]);

function failure(reason, fields = {}) {
  return { ok: false, reason, ...fields };
}

function requireState(state) {
  if (!state?.projects?.inspect || !state?.operations?.inspect || !state?.operations?.terminalize) {
    throw new TypeError("state with projects and operations is required");
  }
  return state;
}

function requireLiveness(operationLiveness) {
  if (typeof operationLiveness?.assess !== "function") {
    throw new TypeError("operationLiveness.assess is required");
  }
  return operationLiveness;
}

function requireWorkspaceRecovery(workspaceRecovery) {
  if (typeof workspaceRecovery?.inspect !== "function" || typeof workspaceRecovery?.cleanup !== "function") {
    throw new TypeError("workspaceRecovery.inspect and cleanup are required");
  }
  return workspaceRecovery;
}

function recoveryResultRef(operationId) {
  return `recovery:${operationId}:${RECOVERY_RESULT_REASON}`;
}

function terminalReplay(operation) {
  return {
    ok: true,
    recovered: true,
    replayed: true,
    operation,
    cleanup: { status: "NOT_REQUIRED" },
  };
}

function unknownResult(operationId, reason) {
  return failure("OPERATION_LIVENESS_UNKNOWN", {
    operationId,
    livenessReason: reason,
    humanGate: true,
  });
}

export function createOperationReconciler({
  state,
  operationLiveness,
  workspaceRecovery,
} = {}) {
  const store = requireState(state);
  const liveness = requireLiveness(operationLiveness);
  const workspaces = requireWorkspaceRecovery(workspaceRecovery);

  async function assess(operation) {
    let result;
    try {
      result = await liveness.assess(operation);
    } catch {
      return null;
    }
    if (!validateLivenessAssessmentV2(result).valid || result.operationId !== operation.operationId) {
      return null;
    }
    return result;
  }

  async function inspectWorkspace(operation) {
    if (operation.workspaceRef === null) {
      return { workspaceRef: null, status: "ABSENT" };
    }
    let result;
    try {
      result = await workspaces.inspect(operation.workspaceRef);
    } catch {
      return { workspaceRef: operation.workspaceRef, status: "UNKNOWN" };
    }
    if (!result || result.workspaceRef !== operation.workspaceRef || !WORKSPACE_STATUSES.has(result.status)) {
      return { workspaceRef: operation.workspaceRef, status: "UNKNOWN" };
    }
    return result;
  }

  function terminalize(operation) {
    return store.operations.terminalize({
      operationId: operation.operationId,
      workflowState: RECOVERY_WORKFLOW_STATE,
      resultRef: recoveryResultRef(operation.operationId),
    });
  }

  return Object.freeze({
    async recover({ projectId, operationId, commandId } = {}) {
      if (typeof projectId !== "string" || projectId.length === 0
        || typeof operationId !== "string" || operationId.length === 0
        || typeof commandId !== "string" || commandId.length === 0) {
        return failure("RECOVERY_COMMAND_INVALID");
      }

      if (!store.projects.inspect(projectId)) return failure("PROJECT_NOT_FOUND");
      const operation = store.operations.inspect(operationId);
      if (!operation) return failure("OPERATION_NOT_FOUND");
      if (operation.projectId !== projectId) return failure("OPERATION_PROJECT_MISMATCH");

      if (operation.liveness === "TERMINAL") return terminalReplay(operation);

      const assessment = await assess(operation);
      if (!assessment) return unknownResult(operationId, "ASSESSMENT_INVALID");

      if (assessment.liveness === "LIVE") {
        return failure("OPERATION_LIVE", {
          operationId,
          livenessReason: assessment.reason,
        });
      }
      if (assessment.liveness === "UNKNOWN") {
        return unknownResult(operationId, assessment.reason);
      }
      if (assessment.liveness === "TERMINAL") {
        const latest = store.operations.inspect(operationId);
        if (latest?.liveness === "TERMINAL") return terminalReplay(latest);
        return unknownResult(operationId, "ASSESSMENT_TERMINAL_STATE_MISMATCH");
      }
      if (assessment.liveness !== "STALE_RECOVERABLE") {
        return unknownResult(operationId, "ASSESSMENT_RECOVERY_UNSUPPORTED");
      }

      const workspace = await inspectWorkspace(operation);
      if (workspace.status === "DIRTY") {
        return failure("STALE_DIRTY", {
          operationId,
          livenessReason: assessment.reason,
          workspace,
          preserved: true,
          actionRequired: "RESOLVE_DIRTY_WORKSPACE",
        });
      }
      if (workspace.status === "UNKNOWN") {
        return failure("RECOVERY_WORKSPACE_UNKNOWN", {
          operationId,
          livenessReason: assessment.reason,
          workspace,
          humanGate: true,
        });
      }

      const terminal = terminalize(operation);
      if (!terminal.ok) {
        return failure("RECOVERY_TERMINALIZATION_FAILED", {
          operationId,
          terminalReason: terminal.reason,
        });
      }

      if (workspace.status === "ABSENT") {
        return {
          ok: true,
          recovered: true,
          replayed: Boolean(terminal.replayed),
          operation: terminal.operation,
          cleanup: { status: "NOT_REQUIRED" },
        };
      }

      try {
        await workspaces.cleanup(operation.workspaceRef);
      } catch {
        return failure("RECOVERY_CLEANUP_FAILED", {
          operationId,
          terminalized: true,
          operation: terminal.operation,
          cleanup: { status: "FAILED" },
        });
      }

      return {
        ok: true,
        recovered: true,
        replayed: Boolean(terminal.replayed),
        operation: terminal.operation,
        cleanup: { status: "CLEANED" },
      };
    },
  });
}
