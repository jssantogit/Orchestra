const RECOVERY_WORKFLOW_STATE = "ABORTED";
const RECOVERY_RESULT_REASON = "OWNER_TERMINATED_WITHOUT_TERMINALIZATION";
const TERMINAL_CLEANUP_REASON = "RECOVERY_TERMINAL_PENDING_CLEANUP";
const WORKSPACE_STATUSES = new Set(["ABSENT", "CLEAN", "DIRTY", "UNKNOWN"]);

function recoveryResultRef(operationId) {
  return `recovery:${operationId}:${RECOVERY_RESULT_REASON}`;
}

function isRecoveryTerminal(operation) {
  return operation?.liveness === "TERMINAL"
    && operation.workflowState === RECOVERY_WORKFLOW_STATE
    && operation.resultRef === recoveryResultRef(operation.operationId);
}

function isExplicitPreserve(recovery) {
  return recovery?.outcome === "STALE_DIRTY"
    && recovery.terminal !== null
    && recovery.cleanup?.status === "PRESERVED"
    && recovery.resolutionAction === "PRESERVE";
}

function terminalAssessment(operation, now) {
  return {
    schema: "orchestra.liveness-assessment.v2",
    operationId: operation.operationId,
    observedAt: now(),
    liveness: "TERMINAL",
    reason: TERMINAL_CLEANUP_REASON,
    evidence: {
      ownerStatus: null,
      heartbeatFresh: null,
      deadlineExpired: null,
    },
  };
}

function requireInputs({ state, reconciler, workspaceRecovery }) {
  if (!state?.operations?.list || !state?.recoveries?.latest) {
    throw new TypeError("state with operations.list and recoveries.latest is required");
  }
  if (typeof reconciler?.inspect !== "function"
    || typeof reconciler?.recover !== "function"
    || typeof reconciler?.resolveDirty !== "function") {
    throw new TypeError("reconciler inspect/recover/resolveDirty is required");
  }
  if (typeof workspaceRecovery?.inspect !== "function") {
    throw new TypeError("workspaceRecovery.inspect is required");
  }
}

async function inspectWorkspace(workspaceRecovery, operation) {
  if (operation.workspaceRef === null) return { workspaceRef: null, status: "ABSENT" };
  let result;
  try {
    result = await workspaceRecovery.inspect(operation.workspaceRef, operation);
  } catch {
    return { workspaceRef: operation.workspaceRef, status: "UNKNOWN" };
  }
  if (!result || result.workspaceRef !== operation.workspaceRef || !WORKSPACE_STATUSES.has(result.status)) {
    return { workspaceRef: operation.workspaceRef, status: "UNKNOWN" };
  }
  return result;
}

async function terminalReadiness({ operation, recovery, workspaceRecovery }) {
  const workspace = await inspectWorkspace(workspaceRecovery, operation);

  if (workspace.status === "DIRTY") {
    return {
      workspace,
      blocksMutation: false,
      recoveryAvailable: false,
      humanGateRequired: false,
      actionRequired: recovery?.resolutionAction === "DISCARD"
        ? "RETRY_DIRTY_DISCARD"
        : "RESOLVE_DIRTY_WORKSPACE",
    };
  }
  if (workspace.status === "UNKNOWN") {
    return {
      workspace,
      blocksMutation: false,
      recoveryAvailable: false,
      humanGateRequired: true,
      actionRequired: "PROVE_WORKSPACE_IDENTITY",
    };
  }
  return {
    workspace,
    blocksMutation: false,
    recoveryAvailable: true,
    humanGateRequired: false,
    actionRequired: recovery?.outcome === "CLEANUP_FAILED" ? "RETRY_RECOVERY" : "RUN_RECOVERY",
  };
}

export function createRecoveryAwareStatusReconciler({
  state,
  reconciler,
  workspaceRecovery,
  now = () => new Date().toISOString(),
} = {}) {
  requireInputs({ state, reconciler, workspaceRecovery });
  if (typeof now !== "function") throw new TypeError("now must be a function");

  return Object.freeze({
    recover: (...args) => reconciler.recover(...args),
    resolveDirty: (...args) => reconciler.resolveDirty(...args),

    async inspect(command = {}) {
      const base = await reconciler.inspect(command);
      if (!base?.ok) return base;

      const projectId = base.project.projectId;
      const pending = [];
      for (const operation of state.operations.list({ projectId, liveness: "TERMINAL" })) {
        if (!isRecoveryTerminal(operation)) continue;
        const recovery = state.recoveries.latest({ projectId, operationId: operation.operationId });
        if (recovery?.outcome === "RECOVERED" || isExplicitPreserve(recovery)) continue;

        pending.push({
          operation,
          assessment: terminalAssessment(operation, now),
          recovery,
          ...await terminalReadiness({ operation, recovery, workspaceRecovery }),
        });
      }

      const operations = [...base.operations, ...pending]
        .sort((left, right) => left.operation.operationId.localeCompare(right.operation.operationId));
      return { ...base, operations };
    },
  });
}
