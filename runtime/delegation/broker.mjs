import {
  assertDelegationRequest,
  assertDelegationResult,
} from "../../core/domain/delegation.mjs";
import { authorizeDelegationRequest } from "../../core/delegation/policy.mjs";
import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";
import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  cleanupDelegationWorkspace,
  inspectDelegationWorkspace,
  prepareDelegationWorkspace,
} from "./workspace.mjs";
import { writeDelegationRecord } from "./store.mjs";
import { createDelegationLifecycleEvent } from "./events.mjs";

const PRODUCT_FINGERPRINT_EXCLUDES = Object.freeze([".orchestra/state/**"]);
const FAILURE_REASONS = new Set([
  "PROVIDER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "WORKSPACE_PREP_FAILED",
  "EXECUTION_FAILED",
  "EXECUTION_TIMED_OUT",
  "INVALID_RESULT",
  "WORKSPACE_CLEANUP_FAILED",
]);

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

function validateServices(workspace, store, events) {
  for (const fn of [workspace.prepare, workspace.inspect, workspace.cleanup, store.write, events.create, events.emit]) {
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

function resultWorkspace(initialFingerprint = null, inspection = null) {
  return {
    initialFingerprint: initialFingerprint ?? null,
    finalFingerprint: inspection?.finalFingerprint ?? null,
    dirty: typeof inspection?.dirty === "boolean" ? inspection.dirty : null,
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
  inspection = null,
} = {}) {
  const result = {
    schema: "orchestra.delegation-result.v1",
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
    workspace: resultWorkspace(initialFingerprint, inspection),
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
      initialFingerprint: workspace.initialFingerprint,
      finalFingerprint: null,
      dirty: false,
      dirtyFileCount: 0,
      cleaned: false,
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
  evidenceRefs,
}) {
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
    workspace: {
      sourceRevision: request.workspace.sourceRevision,
      initialFingerprint: workspace.initialFingerprint,
      finalFingerprint: inspection?.finalFingerprint ?? null,
      dirty: inspection?.dirty === true,
      dirtyFileCount: Number.isInteger(inspection?.dirtyFileCount) && inspection.dirtyFileCount >= 0
        ? inspection.dirtyFileCount
        : 0,
      cleaned: cleanup.cleaned === true,
      cleanupReason: cleanup.cleaned === true ? null : "WORKSPACE_CLEANUP_FAILED",
      recoverablePath: cleanup.cleaned === true ? null : workspace.path,
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

function recordStatusFor(result, cleanup) {
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

export function createDelegationBroker({
  executors = [],
  workspace: workspaceOverrides = {},
  store: storeOverrides = {},
  events: eventOverrides = {},
} = {}) {
  const executorMap = normalizeExecutors(executors);
  const workspace = normalizeWorkspace(workspaceOverrides);
  const store = normalizeStore(storeOverrides);
  const events = normalizeEvents(eventOverrides);
  validateServices(workspace, store, events);

  return {
    async executeDelegation(request, { repoRoot, generation, actor } = {}) {
      assertDelegationRequest(request);
      validateInvocation({ repoRoot, generation, actor });

      if (!rootActorMatchesRequest(actor, request)) {
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

      let executionResult;
      try {
        executionResult = await executor.execute({
          request,
          workerEnvelope: buildWorkerEnvelope(request),
          workspace: workspaceContext,
        });
      } catch {
        executionResult = {
          ok: false,
          provider: request.target.provider,
          reason: "EXECUTION_FAILED",
          execution: { exitCode: null, durationMs: 0 },
        };
      }

      let inspection = null;
      try {
        inspection = await workspace.inspect(workspaceContext);
      } catch {
        inspection = null;
      }

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

      let cleanup;
      try {
        cleanup = await workspace.cleanup(workspaceContext);
      } catch {
        cleanup = { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
      }
      if (!cleanup || cleanup.cleaned !== true) {
        cleanup = { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
        result = failureResult(request, "WORKSPACE_CLEANUP_FAILED", {
          execution: executionResult?.execution,
          initialFingerprint: workspaceContext.initialFingerprint,
          inspection,
        });
      }

      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();
      const durationMs = Math.max(0, completedAtMs - startedAtMs);
      const recordStatus = recordStatusFor(result, cleanup);
      const failureReason = recordStatus === "COMPLETED" ? null
        : recordStatus === "CLEANUP_FAILED" ? "WORKSPACE_CLEANUP_FAILED"
          : result.reason;
      const evidenceRefs = recordStatus === "COMPLETED" ? [...result.evidenceRefs] : [];

      store.write(repoRoot, terminalRecord(request, {
        generation,
        startedAt,
        completedAt,
        durationMs,
        recordStatus,
        failureReason,
        workspace: workspaceContext,
        inspection,
        cleanup,
        evidenceRefs,
      }));
      await emitLifecycle(events, {
        delegationId: request.delegationId,
        state: terminalEventState(recordStatus),
        generation,
        taskId: request.taskId,
        actor,
      });

      return result;
    },
  };
}
