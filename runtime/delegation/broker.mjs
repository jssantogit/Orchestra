import {
  assertDelegationRequest,
  assertDelegationResult,
} from "../../core/domain/delegation.mjs";
import { authorizeDelegationRequest } from "../../core/delegation/policy.mjs";
import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";
import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { sealDelegationArtifact } from "./artifact-lifecycle.mjs";
import {
  cleanupMutableDelegationWorkspace,
  inspectMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "./mutable-workspace.mjs";
import {
  cleanupDelegationWorkspace,
  inspectDelegationWorkspace,
  prepareDelegationWorkspace,
} from "./workspace.mjs";
import { writeDelegationRecord } from "./store.mjs";
import { createDelegationLifecycleEvent } from "./events.mjs";

const PRODUCT_FINGERPRINT_EXCLUDES = Object.freeze([".orchestra/state/**"]);
const UNALLOCATED_WORKSPACE = "UNALLOCATED";
const FAILURE_REASONS = new Set([
  "PROVIDER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "WORKSPACE_PREP_FAILED",
  "EXECUTION_FAILED",
  "EXECUTION_TIMED_OUT",
  "INVALID_RESULT",
  "WORKSPACE_CLEANUP_FAILED",
  "SCOPE_VIOLATION",
  "ARTIFACT_SEAL_FAILED",
  "ARTIFACT_TAMPERED",
  "PROMOTION_STALE",
  "PROMOTION_FAILED",
]);

function isImplementationRequest(request) {
  return request?.schema === "orchestra.delegation-request.v2";
}

function normalizeExecutors(executors) {
  if (!Array.isArray(executors)) throw new TypeError("DELEGATION_EXECUTORS_REQUIRED");
  const map = new Map();
  for (const executor of executors) {
    if (!executor || typeof executor !== "object"
        || typeof executor.provider !== "string" || !executor.provider.trim()
        || typeof executor.discover !== "function"
        || typeof executor.execute !== "function") {
      throw new TypeError("DELEGATION_EXECUTOR_INVALID");
    }
    if (map.has(executor.provider)) throw new TypeError("DELEGATION_EXECUTOR_DUPLICATE");
    map.set(executor.provider, executor);
  }
  return map;
}

function normalizeWorkspace(workspace = {}) {
  return {
    prepare: workspace.prepare ?? prepareDelegationWorkspace,
    inspect: workspace.inspect ?? inspectDelegationWorkspace,
    cleanup: workspace.cleanup ?? cleanupDelegationWorkspace,
  };
}

function normalizeMutableWorkspace(workspace = {}) {
  return {
    prepare: workspace.prepare ?? prepareMutableDelegationWorkspace,
    inspect: workspace.inspect ?? inspectMutableDelegationWorkspace,
    cleanup: workspace.cleanup ?? cleanupMutableDelegationWorkspace,
  };
}

function normalizeArtifacts(artifacts = {}) {
  return {
    seal: artifacts.seal ?? sealDelegationArtifact,
  };
}

function normalizeStore(store = {}) {
  return {
    write: store.write ?? writeDelegationRecord,
  };
}

function normalizeEvents(events = {}) {
  return {
    create: events.create ?? createDelegationLifecycleEvent,
    emit: events.emit ?? (() => {}),
  };
}

function validateServices(workspace, mutableWorkspace, artifacts, store, events) {
  for (const fn of [
    workspace.prepare,
    workspace.inspect,
    workspace.cleanup,
    mutableWorkspace.prepare,
    mutableWorkspace.inspect,
    mutableWorkspace.cleanup,
    artifacts.seal,
    store.write,
    events.create,
    events.emit,
  ]) {
    if (typeof fn !== "function") throw new TypeError("DELEGATION_BROKER_SERVICE_INVALID");
  }
}

function executionFacts(execution = {}) {
  return {
    exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : null,
    durationMs: Number.isInteger(execution.durationMs) && execution.durationMs >= 0
      ? Math.min(execution.durationMs, 3_600_000)
      : 0,
  };
}

function resultWorkspaceV1(initialFingerprint = null, inspection = null) {
  return {
    initialFingerprint: initialFingerprint ?? null,
    finalFingerprint: inspection?.finalFingerprint ?? null,
    dirty: typeof inspection?.dirty === "boolean" ? inspection.dirty : null,
  };
}

function resultWorkspaceV2(request, workspaceContext = null, inspection = null) {
  const changedPaths = Array.isArray(inspection?.changedPaths)
    ? [...inspection.changedPaths]
    : [];
  return {
    sourceRevision: request.workspace.sourceRevision,
    sourceFingerprint: request.workspace.sourceFingerprint,
    delegatedPath: workspaceContext?.path ?? UNALLOCATED_WORKSPACE,
    changedPaths,
    dirty: changedPaths.length > 0,
  };
}

function baseResult(request, {
  status,
  reason = undefined,
  summary = "",
  findings = [],
  evidenceRefs = [],
  execution = {},
  initialFingerprint = null,
  workspaceContext = null,
  inspection = null,
  artifact = undefined,
} = {}) {
  const result = {
    schema: isImplementationRequest(request)
      ? "orchestra.delegation-result.v2"
      : "orchestra.delegation-result.v1",
    delegationId: request.delegationId,
    provider: request.target.provider,
    logicalRole: request.target.logicalRole,
    purpose: request.purpose,
    status,
    ...(reason ? { reason } : {}),
    summary,
    findings,
    evidenceRefs,
    execution: executionFacts(execution),
    workspace: isImplementationRequest(request)
      ? resultWorkspaceV2(request, workspaceContext, inspection)
      : resultWorkspaceV1(initialFingerprint, inspection),
    ...(artifact ? { artifact } : {}),
  };
  assertDelegationResult(result);
  return result;
}

function failureStatus(reason) {
  if (reason === "CAPABILITY_DENIED") return "DENIED";
  if (reason === "EXECUTION_TIMED_OUT") return "TIMED_OUT";
  return "FAILED";
}

function failureResult(request, reason, context = {}) {
  const boundedReason = FAILURE_REASONS.has(reason) ? reason : "EXECUTION_FAILED";
  const { status = failureStatus(boundedReason), ...facts } = context;
  return baseResult(request, {
    ...facts,
    status,
    reason: boundedReason,
    summary: "",
    findings: [],
    evidenceRefs: [],
  });
}

function startedRecord(request, { generation, startedAt, workspace }) {
  const implementation = isImplementationRequest(request);
  return {
    delegationId: request.delegationId,
    taskId: request.taskId,
    generation,
    source: { ...request.source },
    target: { ...request.target },
    purpose: request.purpose,
    status: "STARTED",
    startedAt,
    completedAt: null,
    durationMs: null,
    failureReason: null,
    workspace: {
      sourceRevision: request.workspace.sourceRevision,
      initialFingerprint: implementation
        ? request.workspace.sourceFingerprint
        : workspace.initialFingerprint,
      finalFingerprint: null,
      dirty: false,
      dirtyFileCount: 0,
      cleaned: false,
      ...(implementation ? { retained: false } : {}),
      cleanupReason: null,
      recoverablePath: null,
    },
    evidenceRefs: [],
  };
}

function terminalRecord(request, {
  generation,
  startedAt,
  completedAt,
  durationMs,
  recordStatus,
  failureReason,
  workspace,
  inspection,
  cleanup,
  retained = false,
  artifact = null,
  evidenceRefs,
}) {
  const implementation = isImplementationRequest(request);
  const changedPaths = implementation && Array.isArray(inspection?.changedPaths)
    ? inspection.changedPaths
    : [];
  const cleaned = retained ? false : cleanup.cleaned === true;
  return {
    delegationId: request.delegationId,
    taskId: request.taskId,
    generation,
    source: { ...request.source },
    target: { ...request.target },
    purpose: request.purpose,
    status: recordStatus,
    startedAt,
    completedAt,
    durationMs,
    failureReason,
    ...(artifact ? { artifactId: artifact.artifactId } : {}),
    workspace: {
      sourceRevision: request.workspace.sourceRevision,
      initialFingerprint: implementation
        ? request.workspace.sourceFingerprint
        : workspace.initialFingerprint,
      finalFingerprint: implementation ? null : (inspection?.finalFingerprint ?? null),
      dirty: implementation ? changedPaths.length > 0 : inspection?.dirty === true,
      dirtyFileCount: implementation
        ? changedPaths.length
        : (Number.isInteger(inspection?.dirtyFileCount) && inspection.dirtyFileCount >= 0
          ? inspection.dirtyFileCount
          : 0),
      cleaned,
      ...(implementation ? { retained } : {}),
      cleanupReason: retained || cleaned ? null : "WORKSPACE_CLEANUP_FAILED",
      recoverablePath: retained ? workspace.path : (cleaned ? null : workspace.path),
    },
    evidenceRefs,
  };
}

function terminalEventState(recordStatus) {
  if (recordStatus === "COMPLETED") return "COMPLETED";
  if (recordStatus === "TIMED_OUT") return "TIMED_OUT";
  if (recordStatus === "CLEANUP_FAILED") return "CLEANUP_FAILED";
  return "FAILED";
}

function recordStatusFor(result, cleanup, { retained = false } = {}) {
  if (retained && result.status === "COMPLETED") return "COMPLETED";
  if (cleanup.cleaned !== true) return "CLEANUP_FAILED";
  if (result.status === "COMPLETED") return "COMPLETED";
  if (result.status === "TIMED_OUT") return "TIMED_OUT";
  return "FAILED";
}

async function emitLifecycle(events, input) {
  const event = events.create(input);
  try {
    await events.emit(event);
  } catch {
    // Event sinks are observability only and never gain execution authority.
  }
}

function rootActorMatchesRequest(actor, request) {
  return actor
    && actor.isRoot === true
    && actor.provider === request.source.provider
    && actor.actorIdHash === request.source.actorIdHash;
}

function validateInvocation({ repoRoot, generation, actor }) {
  if (typeof repoRoot !== "string" || !repoRoot.trim()) {
    throw new TypeError("DELEGATION_REPO_ROOT_REQUIRED");
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError("DELEGATION_GENERATION_INVALID");
  }
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new TypeError("DELEGATION_ACTOR_REQUIRED");
  }
}

function executorFailureReason(executionResult) {
  if (!executionResult || typeof executionResult !== "object" || Array.isArray(executionResult)) {
    return "INVALID_RESULT";
  }
  if (executionResult.ok === true) return null;
  if (executionResult.ok !== false || !FAILURE_REASONS.has(executionResult.reason)) return "INVALID_RESULT";
  return executionResult.reason;
}

function validSuccessfulExecution(executionResult, targetProvider) {
  return executionResult
    && executionResult.ok === true
    && executionResult.provider === targetProvider
    && executionResult.report
    && typeof executionResult.report === "object"
    && !Array.isArray(executionResult.report)
    && executionResult.execution
    && typeof executionResult.execution === "object";
}

async function runExecutor(executor, request, workspaceContext) {
  try {
    return await executor.execute({
      request,
      workerEnvelope: buildWorkerEnvelope(request),
      workspace: workspaceContext,
    });
  } catch {
    return {
      ok: false,
      provider: request.target.provider,
      reason: "EXECUTION_FAILED",
      execution: { exitCode: null, durationMs: 0 },
    };
  }
}

async function safeInspect(workspace, workspaceContext) {
  try {
    return await workspace.inspect(workspaceContext);
  } catch {
    return null;
  }
}

async function safeCleanup(workspace, workspaceContext) {
  try {
    const cleanup = await workspace.cleanup(workspaceContext);
    if (cleanup?.cleaned === true) return cleanup;
  } catch {
    // Cleanup failure is normalized below.
  }
  return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
}

function completedRecordFacts(result, cleanup, retained) {
  const recordStatus = recordStatusFor(result, cleanup, { retained });
  return {
    recordStatus,
    failureReason: recordStatus === "COMPLETED" ? null
      : recordStatus === "CLEANUP_FAILED" ? "WORKSPACE_CLEANUP_FAILED"
        : result.reason,
    evidenceRefs: recordStatus === "COMPLETED" ? [...result.evidenceRefs] : [],
  };
}

async function finishLifecycle({
  request,
  repoRoot,
  generation,
  actor,
  startedAtMs,
  startedAt,
  workspaceContext,
  inspection,
  cleanup,
  retained = false,
  artifact = null,
  result,
  store,
  events,
}) {
  const completedAtMs = Date.now();
  const completedAt = new Date(completedAtMs).toISOString();
  const durationMs = Math.max(0, completedAtMs - startedAtMs);
  const recordFacts = completedRecordFacts(result, cleanup, retained);

  store.write(repoRoot, terminalRecord(request, {
    generation,
    startedAt,
    completedAt,
    durationMs,
    recordStatus: recordFacts.recordStatus,
    failureReason: recordFacts.failureReason,
    workspace: workspaceContext,
    inspection,
    cleanup,
    retained,
    artifact,
    evidenceRefs: recordFacts.evidenceRefs,
  }));
  await emitLifecycle(events, {
    delegationId: request.delegationId,
    state: terminalEventState(recordFacts.recordStatus),
    generation,
    taskId: request.taskId,
    actor,
  });
  return result;
}

async function executeReadOnlyLifecycle({
  request,
  repoRoot,
  generation,
  actor,
  executor,
  workspace,
  store,
  events,
}) {
  let workspaceContext;
  try {
    workspaceContext = await workspace.prepare({ repoRoot, request });
  } catch {
    return failureResult(request, "WORKSPACE_PREP_FAILED");
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  store.write(repoRoot, startedRecord(request, { generation, startedAt, workspace: workspaceContext }));
  await emitLifecycle(events, {
    delegationId: request.delegationId,
    state: "STARTED",
    generation,
    taskId: request.taskId,
    actor,
  });

  const executionResult = await runExecutor(executor, request, workspaceContext);
  const inspection = await safeInspect(workspace, workspaceContext);

  let result;
  const executorReason = executorFailureReason(executionResult);
  if (!inspection) {
    result = failureResult(request, "EXECUTION_FAILED", {
      status: "FAILED",
      execution: executionResult?.execution,
      initialFingerprint: workspaceContext.initialFingerprint,
    });
  } else if (inspection.dirty === true) {
    result = failureResult(request, "CAPABILITY_DENIED", {
      status: "FAILED",
      execution: executionResult?.execution,
      initialFingerprint: workspaceContext.initialFingerprint,
      inspection,
    });
  } else if (executorReason) {
    result = failureResult(request, executorReason, {
      execution: executionResult?.execution,
      initialFingerprint: workspaceContext.initialFingerprint,
      inspection,
    });
  } else if (!validSuccessfulExecution(executionResult, request.target.provider)) {
    result = failureResult(request, "INVALID_RESULT", {
      execution: executionResult?.execution,
      initialFingerprint: workspaceContext.initialFingerprint,
      inspection,
    });
  } else {
    try {
      result = baseResult(request, {
        status: "COMPLETED",
        summary: executionResult.report.summary,
        findings: executionResult.report.findings,
        evidenceRefs: executionResult.report.evidenceRefs,
        execution: executionResult.execution,
        initialFingerprint: workspaceContext.initialFingerprint,
        inspection,
      });
    } catch {
      result = failureResult(request, "INVALID_RESULT", {
        execution: executionResult.execution,
        initialFingerprint: workspaceContext.initialFingerprint,
        inspection,
      });
    }
  }

  const cleanup = await safeCleanup(workspace, workspaceContext);
  if (cleanup.cleaned !== true) {
    result = failureResult(request, "WORKSPACE_CLEANUP_FAILED", {
      execution: executionResult?.execution,
      initialFingerprint: workspaceContext.initialFingerprint,
      inspection,
    });
  }

  return finishLifecycle({
    request,
    repoRoot,
    generation,
    actor,
    startedAtMs,
    startedAt,
    workspaceContext,
    inspection,
    cleanup,
    result,
    store,
    events,
  });
}

async function executeImplementationLifecycle({
  request,
  repoRoot,
  generation,
  actor,
  executor,
  workspace,
  artifacts,
  store,
  events,
}) {
  let workspaceContext;
  try {
    workspaceContext = await workspace.prepare({ repoRoot, request });
  } catch {
    return failureResult(request, "WORKSPACE_PREP_FAILED");
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  store.write(repoRoot, startedRecord(request, { generation, startedAt, workspace: workspaceContext }));
  await emitLifecycle(events, {
    delegationId: request.delegationId,
    state: "STARTED",
    generation,
    taskId: request.taskId,
    actor,
  });

  const executionResult = await runExecutor(executor, request, workspaceContext);
  const inspection = await safeInspect(workspace, workspaceContext);
  const executorReason = executorFailureReason(executionResult);
  let result = null;
  let artifact = null;

  if (!inspection) {
    result = failureResult(request, "EXECUTION_FAILED", {
      status: "FAILED",
      execution: executionResult?.execution,
      workspaceContext,
    });
  } else if (executorReason) {
    result = failureResult(request, executorReason, {
      execution: executionResult?.execution,
      workspaceContext,
      inspection,
    });
  } else if (!validSuccessfulExecution(executionResult, request.target.provider)) {
    result = failureResult(request, "INVALID_RESULT", {
      execution: executionResult?.execution,
      workspaceContext,
      inspection,
    });
  } else {
    try {
      baseResult(request, {
        status: "COMPLETED",
        summary: executionResult.report.summary,
        findings: executionResult.report.findings,
        evidenceRefs: executionResult.report.evidenceRefs,
        execution: executionResult.execution,
        workspaceContext,
        inspection,
      });
    } catch {
      result = failureResult(request, "INVALID_RESULT", {
        execution: executionResult.execution,
        workspaceContext,
        inspection,
      });
    }
  }

  if (!result) {
    try {
      artifact = await artifacts.seal({
        repoRoot,
        request,
        generation,
        actor,
        workspace: workspaceContext,
        report: executionResult.report,
      });
      const sealedInspection = {
        ...inspection,
        changedPaths: [...artifact.changedPaths],
        dirtyFileCount: artifact.changedPaths.length,
      };
      result = baseResult(request, {
        status: "COMPLETED",
        summary: executionResult.report.summary,
        findings: executionResult.report.findings,
        evidenceRefs: executionResult.report.evidenceRefs,
        execution: executionResult.execution,
        workspaceContext,
        inspection: sealedInspection,
        artifact,
      });
      return finishLifecycle({
        request,
        repoRoot,
        generation,
        actor,
        startedAtMs,
        startedAt,
        workspaceContext,
        inspection: sealedInspection,
        cleanup: { cleaned: false, reason: null },
        retained: true,
        artifact,
        result,
        store,
        events,
      });
    } catch (error) {
      const reason = error?.reason === "SCOPE_VIOLATION" || error?.code === "SCOPE_VIOLATION"
        ? "SCOPE_VIOLATION"
        : "ARTIFACT_SEAL_FAILED";
      result = failureResult(request, reason, {
        execution: executionResult?.execution,
        workspaceContext,
        inspection,
      });
    }
  }

  const cleanup = await safeCleanup(workspace, workspaceContext);
  if (cleanup.cleaned !== true) {
    result = failureResult(request, "WORKSPACE_CLEANUP_FAILED", {
      execution: executionResult?.execution,
      workspaceContext,
      inspection,
    });
  }

  return finishLifecycle({
    request,
    repoRoot,
    generation,
    actor,
    startedAtMs,
    startedAt,
    workspaceContext,
    inspection,
    cleanup,
    result,
    store,
    events,
  });
}

export function createDelegationBroker({
  executors = [],
  workspace: workspaceOverrides = {},
  mutableWorkspace: mutableWorkspaceOverrides = {},
  artifacts: artifactOverrides = {},
  store: storeOverrides = {},
  events: eventOverrides = {},
} = {}) {
  const executorMap = normalizeExecutors(executors);
  const workspace = normalizeWorkspace(workspaceOverrides);
  const mutableWorkspace = normalizeMutableWorkspace(mutableWorkspaceOverrides);
  const artifacts = normalizeArtifacts(artifactOverrides);
  const store = normalizeStore(storeOverrides);
  const events = normalizeEvents(eventOverrides);
  validateServices(workspace, mutableWorkspace, artifacts, store, events);

  return {
    async executeDelegation(request, { repoRoot, generation, actor } = {}) {
      assertDelegationRequest(request);
      validateInvocation({ repoRoot, generation, actor });

      if (!rootActorMatchesRequest(actor, request)) {
        return failureResult(request, "CAPABILITY_DENIED");
      }
      if (isImplementationRequest(request) && request.packet.candidateGeneration !== generation) {
        return failureResult(request, "CAPABILITY_DENIED");
      }

      const sourceIdentity = readWorkspaceFingerprint(repoRoot, {
        excludedPaths: PRODUCT_FINGERPRINT_EXCLUDES,
      });
      const authorization = authorizeDelegationRequest(request, {
        sourceProvider: actor.provider,
        sourceFingerprint: sourceIdentity.fingerprint,
      });
      if (!authorization.allowed) {
        return failureResult(request, authorization.reason);
      }

      const executor = executorMap.get(request.target.provider);
      if (!executor) return failureResult(request, "PROVIDER_UNAVAILABLE");

      let discovery;
      try {
        discovery = await executor.discover();
      } catch {
        discovery = null;
      }
      if (!discovery?.available || discovery.provider !== request.target.provider) {
        return failureResult(request, "PROVIDER_UNAVAILABLE");
      }

      if (isImplementationRequest(request)) {
        return executeImplementationLifecycle({
          request,
          repoRoot,
          generation,
          actor,
          executor,
          workspace: mutableWorkspace,
          artifacts,
          store,
          events,
        });
      }

      return executeReadOnlyLifecycle({
        request,
        repoRoot,
        generation,
        actor,
        executor,
        workspace,
        store,
        events,
      });
    },
  };
}
