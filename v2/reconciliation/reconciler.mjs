import { validateLivenessAssessmentV2 } from "../liveness/contracts.mjs";

const RECOVERY_WORKFLOW_STATE = "ABORTED";
const RECOVERY_RESULT_REASON = "OWNER_TERMINATED_WITHOUT_TERMINALIZATION";
const TERMINAL_CLEANUP_REASON = "RECOVERY_TERMINAL_PENDING_CLEANUP";
const TERMINAL_DIRTY_REASON = "RECOVERY_TERMINAL_PENDING_DIRTY_RESOLUTION";
const EXPLICIT_DISCARD_REASON = "STALE_DIRTY_EXPLICIT_DISCARD";
const WORKSPACE_STATUSES = new Set(["ABSENT", "CLEAN", "DIRTY", "PROJECT_ROOT", "UNKNOWN"]);
const DIRTY_ACTIONS = new Set(["PRESERVE", "DISCARD"]);

function failure(reason, fields = {}) {
  return { ok: false, reason, ...fields };
}

function requireState(state) {
  if (!state?.projects?.inspect
    || !state?.work?.current
    || !state?.operations?.inspect
    || !state?.operations?.listLive
    || !state?.operations?.terminalize) {
    throw new TypeError("state with projects, work and operations is required");
  }
  if (!state?.recoveries?.record || !state?.recoveries?.latest || !state?.recoveries?.byCommand) {
    throw new TypeError("state with recovery journal is required");
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

function terminalReplay(operation, cleanupStatus = "NOT_REQUIRED") {
  return {
    ok: true,
    recovered: true,
    replayed: true,
    operation,
    cleanup: { status: cleanupStatus },
  };
}

function unknownResult(operationId, reason) {
  return failure("OPERATION_LIVENESS_UNKNOWN", {
    operationId,
    livenessReason: reason,
    humanGate: true,
  });
}

function workspaceResult(record) {
  return {
    workspaceRef: record.workspace.ref,
    status: record.workspace.status,
  };
}

function replayRecordedRecovery(record, operation) {
  if (record.operationId !== operation.operationId) {
    return failure("IDEMPOTENCY_CONFLICT");
  }
  if (record.outcome === "RECOVERED") {
    return terminalReplay(operation, record.cleanup.status);
  }
  if (record.outcome === "STALE_DIRTY") {
    return failure("STALE_DIRTY", {
      operationId: operation.operationId,
      livenessReason: record.assessment.reason,
      workspace: workspaceResult(record),
      preserved: true,
      actionRequired: "RESOLVE_DIRTY_WORKSPACE",
      replayed: true,
    });
  }
  if (record.outcome === "CLEANUP_FAILED") {
    return failure("RECOVERY_CLEANUP_FAILED", {
      operationId: operation.operationId,
      terminalized: record.terminal !== null,
      operation,
      cleanup: { status: "FAILED" },
      replayed: true,
    });
  }
  return failure("RECOVERY_JOURNAL_INVALID");
}

function replayDirtyResolution(record, operation, action) {
  if (record.operationId !== operation.operationId) return failure("IDEMPOTENCY_CONFLICT");
  if (action === "PRESERVE"
    && record.outcome === "STALE_DIRTY"
    && record.terminal !== null
    && record.cleanup.status === "PRESERVED") {
    return {
      ok: true,
      resolved: true,
      action,
      replayed: true,
      operation,
      workspace: workspaceResult(record),
      preserved: true,
    };
  }
  if (action === "DISCARD"
    && record.outcome === "RECOVERED"
    && record.assessment.reason === EXPLICIT_DISCARD_REASON
    && record.workspace.status === "ABSENT") {
    return {
      ok: true,
      resolved: true,
      action,
      replayed: true,
      operation,
      workspace: workspaceResult(record),
      discarded: true,
    };
  }
  return failure("IDEMPOTENCY_CONFLICT");
}

export function createOperationReconciler({
  state,
  operationLiveness,
  workspaceRecovery,
  now = () => new Date().toISOString(),
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

  function unknownAssessment(operationId, reason = "ASSESSMENT_INVALID") {
    return {
      schema: "orchestra.liveness-assessment.v2",
      operationId,
      observedAt: now(),
      liveness: "UNKNOWN",
      reason,
      evidence: {
        ownerStatus: null,
        heartbeatFresh: null,
        deadlineExpired: null,
      },
    };
  }

  async function inspectWorkspace(operation) {
    if (operation.workspaceRef === null) {
      return { workspaceRef: null, status: "ABSENT" };
    }
    let result;
    try {
      result = await workspaces.inspect(operation.workspaceRef, operation);
    } catch {
      return { workspaceRef: operation.workspaceRef, status: "UNKNOWN" };
    }
    if (!result || result.workspaceRef !== operation.workspaceRef || !WORKSPACE_STATUSES.has(result.status)) {
      return { workspaceRef: operation.workspaceRef, status: "UNKNOWN" };
    }
    return result;
  }

  async function inspectRecoveryReadiness(operation, assessment) {
    if (assessment.liveness === "LIVE") {
      return {
        workspace: null,
        blocksMutation: true,
        recoveryAvailable: false,
        humanGateRequired: false,
        actionRequired: "WAIT_FOR_LIVE_OPERATION",
      };
    }

    if (assessment.liveness === "UNKNOWN") {
      return {
        workspace: null,
        blocksMutation: true,
        recoveryAvailable: false,
        humanGateRequired: true,
        actionRequired: "RESOLVE_LIVENESS",
      };
    }

    if (assessment.liveness !== "STALE_RECOVERABLE") {
      return {
        workspace: null,
        blocksMutation: true,
        recoveryAvailable: false,
        humanGateRequired: true,
        actionRequired: "RESOLVE_LIVENESS",
      };
    }

    const workspace = await inspectWorkspace(operation);
    if (workspace.status === "CLEAN" || workspace.status === "ABSENT" || workspace.status === "PROJECT_ROOT") {
      return {
        workspace,
        blocksMutation: false,
        recoveryAvailable: true,
        humanGateRequired: false,
        actionRequired: "RUN_RECOVERY",
      };
    }
    if (workspace.status === "DIRTY") {
      return {
        workspace,
        blocksMutation: false,
        recoveryAvailable: false,
        humanGateRequired: false,
        actionRequired: "RESOLVE_DIRTY_WORKSPACE",
      };
    }
    return {
      workspace,
      blocksMutation: false,
      recoveryAvailable: false,
      humanGateRequired: true,
      actionRequired: "PROVE_WORKSPACE_IDENTITY",
    };
  }

  function terminalize(operation) {
    return store.operations.terminalize({
      operationId: operation.operationId,
      workflowState: RECOVERY_WORKFLOW_STATE,
      resultRef: recoveryResultRef(operation.operationId),
      expectedHeartbeatAt: operation.heartbeatAt,
    });
  }

  function terminalizationFailure(operationId, terminal) {
    if (terminal?.reason === "OPERATION_CHANGED") {
      return failure("RECOVERY_RACE_LOST", {
        operationId,
        terminalized: false,
        retryable: true,
      });
    }
    return failure("RECOVERY_TERMINALIZATION_FAILED", {
      operationId,
      terminalReason: terminal?.reason ?? "UNKNOWN",
    });
  }

  function recoveryRecord({ operation, commandId, assessment, workspace, terminal, cleanupStatus, outcome, resolutionAction = null }) {
    const record = {
      schema: "orchestra.operation-recovery.v2",
      projectId: operation.projectId,
      operationId: operation.operationId,
      workId: operation.workId,
      generation: operation.generation,
      commandId,
      assessment: {
        liveness: assessment.liveness,
        reason: assessment.reason,
        observedAt: assessment.observedAt,
      },
      workspace: {
        ref: operation.workspaceRef,
        status: workspace.status,
      },
      terminal: terminal === null ? null : {
        workflowState: terminal.workflowState,
        resultRef: terminal.resultRef,
      },
      cleanup: { status: cleanupStatus },
      outcome,
      recordedAt: now(),
    };
    if (resolutionAction !== null) record.resolutionAction = resolutionAction;
    return record;
  }

  function writeRecovery(record) {
    const written = store.recoveries.record(record);
    if (!written.ok) {
      return failure("RECOVERY_JOURNAL_FAILED", {
        journalReason: written.reason,
      });
    }
    return written;
  }

  function recoveredResult(operation, cleanupStatus, replayed = false) {
    return {
      ok: true,
      recovered: true,
      replayed,
      operation,
      cleanup: { status: cleanupStatus },
    };
  }

  async function completeTerminalRecovery({ operation, commandId }) {
    const latest = store.recoveries.latest({
      projectId: operation.projectId,
      operationId: operation.operationId,
    });
    if (latest?.outcome === "RECOVERED") {
      return terminalReplay(operation, latest.cleanup.status);
    }

    const assessment = {
      liveness: "TERMINAL",
      reason: TERMINAL_CLEANUP_REASON,
      observedAt: now(),
    };
    const workspace = await inspectWorkspace(operation);
    if (workspace.status === "UNKNOWN") {
      return failure("RECOVERY_WORKSPACE_UNKNOWN", {
        operationId: operation.operationId,
        workspace,
        humanGate: true,
      });
    }
    if (workspace.status === "DIRTY") {
      const record = recoveryRecord({
        operation,
        commandId,
        assessment,
        workspace,
        terminal: operation,
        cleanupStatus: "PRESERVED",
        outcome: "STALE_DIRTY",
      });
      const written = writeRecovery(record);
      if (!written.ok) return written;
      return failure("STALE_DIRTY", {
        operationId: operation.operationId,
        livenessReason: assessment.reason,
        workspace,
        preserved: true,
        actionRequired: "RESOLVE_DIRTY_WORKSPACE",
        replayed: Boolean(written.replayed),
      });
    }
    if (workspace.status === "ABSENT" || workspace.status === "PROJECT_ROOT") {
      const record = recoveryRecord({
        operation,
        commandId,
        assessment,
        workspace,
        terminal: operation,
        cleanupStatus: "NOT_REQUIRED",
        outcome: "RECOVERED",
      });
      const written = writeRecovery(record);
      if (!written.ok) return written;
      return recoveredResult(operation, "NOT_REQUIRED", Boolean(written.replayed));
    }

    try {
      await workspaces.cleanup(operation.workspaceRef, operation);
    } catch {
      const record = recoveryRecord({
        operation,
        commandId,
        assessment,
        workspace,
        terminal: operation,
        cleanupStatus: "FAILED",
        outcome: "CLEANUP_FAILED",
      });
      const written = writeRecovery(record);
      if (!written.ok) return written;
      return failure("RECOVERY_CLEANUP_FAILED", {
        operationId: operation.operationId,
        terminalized: true,
        operation,
        cleanup: { status: "FAILED" },
        replayed: Boolean(written.replayed),
      });
    }

    const record = recoveryRecord({
      operation,
      commandId,
      assessment,
      workspace,
      terminal: operation,
      cleanupStatus: "CLEANED",
      outcome: "RECOVERED",
    });
    const written = writeRecovery(record);
    if (!written.ok) return written;
    return recoveredResult(operation, "CLEANED", Boolean(written.replayed));
  }

  async function resolveDirty({ projectId, operationId, action, commandId } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0
      || typeof operationId !== "string" || operationId.length === 0
      || typeof commandId !== "string" || commandId.length === 0
      || !DIRTY_ACTIONS.has(action)) {
      return failure("DIRTY_RESOLUTION_COMMAND_INVALID");
    }

    if (!store.projects.inspect(projectId)) return failure("PROJECT_NOT_FOUND");
    let operation = store.operations.inspect(operationId);
    if (!operation) return failure("OPERATION_NOT_FOUND");
    if (operation.projectId !== projectId) return failure("OPERATION_PROJECT_MISMATCH");

    const priorCommand = store.recoveries.byCommand({ projectId, commandId });
    if (priorCommand) return replayDirtyResolution(priorCommand, operation, action);

    let assessment;
    if (operation.liveness === "TERMINAL") {
      if (operation.workflowState !== RECOVERY_WORKFLOW_STATE
        || operation.resultRef !== recoveryResultRef(operation.operationId)) {
        return failure("OPERATION_TERMINAL_UNRELATED");
      }
      assessment = {
        liveness: "TERMINAL",
        reason: TERMINAL_DIRTY_REASON,
        observedAt: now(),
      };
    } else {
      assessment = await assess(operation);
      if (!assessment) return unknownResult(operationId, "ASSESSMENT_INVALID");
      if (assessment.liveness === "LIVE") {
        return failure("OPERATION_LIVE", {
          operationId,
          livenessReason: assessment.reason,
        });
      }
      if (assessment.liveness === "UNKNOWN") return unknownResult(operationId, assessment.reason);
      if (assessment.liveness !== "STALE_RECOVERABLE") {
        return unknownResult(operationId, "ASSESSMENT_RECOVERY_UNSUPPORTED");
      }
    }

    let workspace = await inspectWorkspace(operation);
    if (workspace.status !== "DIRTY") {
      return failure("WORKSPACE_NOT_DIRTY", { workspace });
    }
    if (action === "DISCARD" && typeof workspaces.discard !== "function") {
      return failure("DIRTY_DISCARD_UNAVAILABLE", { workspace });
    }

    if (operation.liveness !== "TERMINAL") {
      const terminal = terminalize(operation);
      if (!terminal.ok) return terminalizationFailure(operationId, terminal);
      operation = terminal.operation;
    }

    if (action === "PRESERVE") {
      const record = recoveryRecord({
        operation,
        commandId,
        assessment,
        workspace,
        terminal: operation,
        cleanupStatus: "PRESERVED",
        outcome: "STALE_DIRTY",
        resolutionAction: action,
      });
      const written = writeRecovery(record);
      if (!written.ok) return written;
      return {
        ok: true,
        resolved: true,
        action,
        replayed: Boolean(written.replayed),
        operation,
        workspace,
        preserved: true,
      };
    }

    try {
      await workspaces.discard(operation.workspaceRef, operation);
    } catch {
      const afterFailure = await inspectWorkspace(operation);
      if (afterFailure.status === "DIRTY") {
        const record = recoveryRecord({
          operation,
          commandId,
          assessment: {
            ...assessment,
            liveness: "TERMINAL",
            reason: TERMINAL_DIRTY_REASON,
            observedAt: now(),
          },
          workspace: afterFailure,
          terminal: operation,
          cleanupStatus: "PRESERVED",
          outcome: "STALE_DIRTY",
          resolutionAction: action,
        });
        const written = writeRecovery(record);
        if (!written.ok) return written;
      }
      return failure("DIRTY_DISCARD_FAILED", {
        operationId,
        terminalized: true,
        workspace: afterFailure,
        preserved: afterFailure.status === "DIRTY",
        retryable: true,
      });
    }

    workspace = await inspectWorkspace(operation);
    if (workspace.status !== "ABSENT") {
      return failure("DIRTY_DISCARD_FAILED", {
        operationId,
        terminalized: true,
        workspace,
        retryable: true,
      });
    }

    const record = recoveryRecord({
      operation,
      commandId,
      assessment: {
        ...assessment,
        liveness: "TERMINAL",
        reason: EXPLICIT_DISCARD_REASON,
        observedAt: now(),
      },
      workspace,
      terminal: operation,
      cleanupStatus: "NOT_REQUIRED",
      outcome: "RECOVERED",
      resolutionAction: action,
    });
    const written = writeRecovery(record);
    if (!written.ok) return written;
    return {
      ok: true,
      resolved: true,
      action,
      replayed: Boolean(written.replayed),
      operation,
      workspace,
      discarded: true,
    };
  }

  return Object.freeze({
    async inspect({ projectId } = {}) {
      if (typeof projectId !== "string" || projectId.length === 0) {
        return failure("PROJECT_ID_INVALID");
      }
      const project = store.projects.inspect(projectId);
      if (!project) return failure("PROJECT_NOT_FOUND");
      const work = store.work.current(projectId);
      const candidates = store.operations.listLive({ projectId })
        .sort((left, right) => left.operationId.localeCompare(right.operationId));
      const operations = [];
      for (const operation of candidates) {
        const assessment = await assess(operation) ?? unknownAssessment(operation.operationId);
        const recovery = store.recoveries.latest({ projectId, operationId: operation.operationId });
        const readiness = await inspectRecoveryReadiness(operation, assessment);
        operations.push({
          operation,
          assessment,
          recovery,
          ...readiness,
        });
      }
      return {
        ok: true,
        project,
        work,
        operations,
      };
    },

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

      const priorCommand = store.recoveries.byCommand({ projectId, commandId });
      if (priorCommand) return replayRecordedRecovery(priorCommand, operation);

      if (operation.liveness === "TERMINAL") {
        if (operation.workflowState === RECOVERY_WORKFLOW_STATE
          && operation.resultRef === recoveryResultRef(operation.operationId)) {
          return completeTerminalRecovery({ operation, commandId });
        }
        return terminalReplay(operation);
      }

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
        const record = recoveryRecord({
          operation,
          commandId,
          assessment,
          workspace,
          terminal: null,
          cleanupStatus: "PRESERVED",
          outcome: "STALE_DIRTY",
        });
        const written = writeRecovery(record);
        if (!written.ok) return written;
        return failure("STALE_DIRTY", {
          operationId,
          livenessReason: assessment.reason,
          workspace,
          preserved: true,
          actionRequired: "RESOLVE_DIRTY_WORKSPACE",
          replayed: Boolean(written.replayed),
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
      if (!terminal.ok) return terminalizationFailure(operationId, terminal);
      if (terminal.replayed) {
        const latest = store.recoveries.latest({
          projectId: operation.projectId,
          operationId: operation.operationId,
        });
        if (latest?.terminal?.resultRef === terminal.operation.resultRef) {
          return replayRecordedRecovery(latest, terminal.operation);
        }
        return failure("RECOVERY_RACE_LOST", {
          operationId,
          terminalized: true,
          retryable: true,
        });
      }

      if (workspace.status === "ABSENT" || workspace.status === "PROJECT_ROOT") {
        const record = recoveryRecord({
          operation,
          commandId,
          assessment,
          workspace,
          terminal: terminal.operation,
          cleanupStatus: "NOT_REQUIRED",
          outcome: "RECOVERED",
        });
        const written = writeRecovery(record);
        if (!written.ok) return written;
        return recoveredResult(terminal.operation, "NOT_REQUIRED", Boolean(written.replayed));
      }

      try {
        await workspaces.cleanup(operation.workspaceRef, operation);
      } catch {
        const record = recoveryRecord({
          operation,
          commandId,
          assessment,
          workspace,
          terminal: terminal.operation,
          cleanupStatus: "FAILED",
          outcome: "CLEANUP_FAILED",
        });
        const written = writeRecovery(record);
        if (!written.ok) return written;
        return failure("RECOVERY_CLEANUP_FAILED", {
          operationId,
          terminalized: true,
          operation: terminal.operation,
          cleanup: { status: "FAILED" },
          replayed: Boolean(written.replayed),
        });
      }

      const record = recoveryRecord({
        operation,
        commandId,
        assessment,
        workspace,
        terminal: terminal.operation,
        cleanupStatus: "CLEANED",
        outcome: "RECOVERED",
      });
      const written = writeRecovery(record);
      if (!written.ok) return written;
      return recoveredResult(terminal.operation, "CLEANED", Boolean(written.replayed));
    },

    resolveDirty,
  });
}
