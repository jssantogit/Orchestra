import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { createWorkAuthority } from "../../authority/work-authority.mjs";
import { createOperationLivenessService } from "../../liveness/operation-liveness-service.mjs";
import { createHostProcessIdentityReader, createLocalProcessOwnerProbe } from "../../liveness/local-process-probe.mjs";
import { createProviderEventProbe } from "../../liveness/provider-event-liveness.mjs";
import { createRuntimeOwnerStore } from "../../liveness/runtime-owner-store.mjs";
import { normalizeCodexActor } from "./actor.mjs";
import { normalizeCodexToolEvent } from "./tool-event.mjs";

const PROVIDER_EVENT_DEADLINE_MS = 5 * 60_000;

function result(ok, reason, fields = {}) {
  return { ok, reason, ...fields };
}

function sessionStartResponse(response, context) {
  return {
    ...response,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: JSON.stringify(context),
    },
  };
}

function preToolUseResponse(ok, reason, fields = {}) {
  const decision = ok ? "allow" : "deny";
  const diagnostic = { reason, ...fields };
  return {
    ...result(ok, reason, fields),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: JSON.stringify(diagnostic),
    },
  };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function authorityActor(actor, observedAt) {
  return {
    schema: "orchestra.actor-provenance.v2",
    provider: actor.provider,
    subjectHash: actor.actorIdHash,
    source: "PROVIDER_FACT",
    observedAt,
  };
}

function addMilliseconds(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function classifyToolResult(payload) {
  const hasSnakeErrorFlag = Object.hasOwn(payload, "is_error");
  const hasCamelErrorFlag = Object.hasOwn(payload, "isError");
  const hasErrorFlag = hasSnakeErrorFlag || hasCamelErrorFlag;
  const errorFlag = hasSnakeErrorFlag ? payload.is_error : payload.isError;
  const hasSnakeExitCode = Object.hasOwn(payload, "exit_code");
  const hasCamelExitCode = Object.hasOwn(payload, "exitCode");
  const hasExitCode = hasSnakeExitCode || hasCamelExitCode;
  const exitCode = hasSnakeExitCode ? payload.exit_code : payload.exitCode;

  if (hasErrorFlag && typeof errorFlag !== "boolean") return null;
  if (hasExitCode && (!Number.isSafeInteger(exitCode) || exitCode < 0)) return null;
  if (hasSnakeErrorFlag && hasCamelErrorFlag && payload.is_error !== payload.isError) return null;
  if (hasSnakeExitCode && hasCamelExitCode && payload.exit_code !== payload.exitCode) return null;
  if (hasErrorFlag && hasExitCode && errorFlag === false && exitCode !== 0) return null;
  if (hasErrorFlag && hasExitCode && errorFlag === true && exitCode === 0) return null;
  if (errorFlag === true || (hasExitCode && exitCode > 0)) return "FAILED";
  if (errorFlag === false || (hasExitCode && exitCode === 0)) return "SUCCEEDED";
  return null;
}

export function createCodexHookHandler({ registry, now = () => new Date().toISOString() } = {}) {
  if (!registry?.state || typeof registry.resolveWorkspace !== "function") {
    throw new TypeError("global project registry is required");
  }
  if (typeof registry.paths?.home !== "string") throw new TypeError("global project registry home is required");

  const authority = createWorkAuthority({ state: registry.state });
  const runtimeOwnerStore = createRuntimeOwnerStore({ rootDir: join(registry.paths.home, "runtime-owners") });
  const ownerProbe = createLocalProcessOwnerProbe({
    readProcessIdentity: createHostProcessIdentityReader(),
    now,
  });
  const operationLiveness = createOperationLivenessService({
    runtimeOwnerStore,
    ownerProbe,
    providerEventProbe: createProviderEventProbe({ now }),
    now,
  });
  const authorizedAuthority = createWorkAuthority({ state: registry.state, operationLiveness });

  async function resolveProject(payload, cwd) {
    try {
      return await registry.resolveWorkspace(
        typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : cwd,
      );
    } catch (error) {
      if (["ORCHESTRA_PROJECT_NOT_GIT", "ORCHESTRA_PROJECT_ROOT_INVALID", "ORCHESTRA_PROJECT_ROOT_UNAVAILABLE"].includes(error.code)) {
        return null;
      }
      throw error;
    }
  }

  function freshnessFields(decision) {
    return {
      ...(decision.currentInstructionEpoch !== undefined
        ? { currentInstructionEpoch: decision.currentInstructionEpoch }
        : {}),
      ...(decision.continuationAvailable !== undefined
        ? { continuationAvailable: decision.continuationAvailable }
        : {}),
      ...(decision.currentWorkId !== undefined ? { currentWorkId: decision.currentWorkId } : {}),
      ...(decision.currentGeneration !== undefined ? { currentGeneration: decision.currentGeneration } : {}),
      ...(decision.operation !== undefined ? { operation: decision.operation } : {}),
      ...(decision.livenessReason ? { livenessReason: decision.livenessReason } : {}),
    };
  }

  async function preToolUse(payload, actor, cwd) {
    let event;
    try {
      event = normalizeCodexToolEvent(payload);
    } catch (error) {
      return preToolUseResponse(false, error.code || "CODEX_HOOK_PAYLOAD_INVALID");
    }
    if (event.eventType !== "TOOL_REQUEST") return preToolUseResponse(false, "CODEX_HOOK_EVENT_UNSUPPORTED");

    const project = await resolveProject(payload, cwd);
    if (!project) return preToolUseResponse(false, "PROJECT_NOT_REGISTERED", { registered: false });

    const observedAt = now();
    const actorRef = authorityActor(actor, observedAt);
    const observation = registry.state.sessionObservations.get({
      provider: "codex",
      projectId: project.projectId,
      actorIdHash: actor.actorIdHash,
    });
    if (!observation) return preToolUseResponse(false, "CODEX_SESSION_OBSERVATION_MISSING", { projectId: project.projectId });
    if (observation.observedWorkId === null || observation.observedGeneration === null) {
      return preToolUseResponse(false, "NO_ACTIVE_WORK", { projectId: project.projectId });
    }

    const isReadOnly = event.sideEffectClass === "READ_ONLY";
    if (!isReadOnly && !event.factualIds.toolCallId) {
      return preToolUseResponse(false, "CODEX_TOOL_CORRELATION_REQUIRED", { projectId: project.projectId });
    }

    const expectedTuple = {
      projectId: project.projectId,
      expectedWorkId: observation.observedWorkId,
      expectedGeneration: observation.observedGeneration,
      observedInstructionEpoch: observation.observedInstructionEpoch,
      actor: actorRef,
      workspaceRef: project.workspace.canonicalRoot,
    };

    if (isReadOnly) {
      const authorized = await authorizedAuthority.authorize({
        ...expectedTuple,
        capability: "WORKSPACE_READ",
      });
      if (!authorized.allowed) {
        return preToolUseResponse(false, authorized.reason, freshnessFields(authorized));
      }
      return preToolUseResponse(true, null, { projectId: project.projectId });
    }

    const correlationHash = hash(event.factualIds.toolCallId);
    const existingCorrelation = registry.state.operationCorrelations.get({
      provider: "codex",
      projectId: project.projectId,
      correlationHash,
    });
    if (existingCorrelation) {
      if (existingCorrelation.workId !== observation.observedWorkId
        || existingCorrelation.generation !== observation.observedGeneration
        || existingCorrelation.actorIdHash !== actor.actorIdHash) {
        return preToolUseResponse(false, "CODEX_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
      }
      const authorized = await authorizedAuthority.authorize({ ...expectedTuple, capability: "WORKSPACE_READ" });
      if (!authorized.allowed) {
        return preToolUseResponse(false, authorized.reason, freshnessFields(authorized));
      }
      const operation = registry.state.operations.inspect(existingCorrelation.operationId);
      if (!operation) return preToolUseResponse(false, "CODEX_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
      const assessment = await operationLiveness.assess(operation);
      if (assessment.liveness !== "LIVE" || operation.workflowState !== "RUNNING" || operation.liveness !== "LIVE") {
        const reason = assessment.liveness === "STALE_RECOVERABLE" ? "STALE_OPERATION_RECOVERY_REQUIRED"
          : assessment.liveness === "UNKNOWN" ? "OPERATION_LIVENESS_UNKNOWN"
            : "CODEX_TOOL_OPERATION_NOT_REPLAYABLE";
        return preToolUseResponse(false, reason, {
          projectId: project.projectId,
          operation: operation.operationId,
          liveness: assessment.liveness,
          livenessReason: assessment.reason,
          recoveryRequired: assessment.liveness === "STALE_RECOVERABLE",
        });
      }
      return preToolUseResponse(true, null, {
        projectId: project.projectId,
        operation: { operationId: operation.operationId },
        replayed: true,
      });
    }

    const authorized = await authorizedAuthority.authorize({
      ...expectedTuple,
      capability: "WORKSPACE_EDIT",
    });
    if (!authorized.allowed) {
      return preToolUseResponse(false, authorized.reason, freshnessFields(authorized));
    }

    const operationId = `op_${randomUUID()}`;
    const runtimeOwnerId = `provider-owner:${operationId}`;
    const startedAt = now();
    const deadlineAt = addMilliseconds(startedAt, PROVIDER_EVENT_DEADLINE_MS);
    const runtimeOwner = {
      schema: "orchestra.runtime-owner.v2",
      runtimeOwnerId,
      operationId,
      kind: "PROVIDER_EVENT",
      registeredAt: startedAt,
      correlationRef: correlationHash,
      startedAt,
      lastProviderEventAt: startedAt,
      deadlineAt,
    };
    const ownerResult = await runtimeOwnerStore.register(runtimeOwner);
    if (!ownerResult.ok) return preToolUseResponse(false, ownerResult.reason, { projectId: project.projectId });

    const operation = {
      schema: "orchestra.operation.v2",
      operationId,
      projectId: project.projectId,
      workId: observation.observedWorkId,
      generation: observation.observedGeneration,
      kind: "DIRECT_MUTATION",
      actorRef: actor.actorIdHash,
      capabilities: ["WORKSPACE_EDIT"],
      workflowState: "RUNNING",
      liveness: "LIVE",
      startedAt,
      heartbeatAt: startedAt,
      deadlineAt,
      runtimeOwnerRef: runtimeOwnerId,
      workspaceRef: project.workspace.canonicalRoot,
      resultRef: null,
    };
    const begun = registry.state.operations.begin({
      expectedGeneration: observation.observedGeneration,
      operation,
    });
    if (!begun.ok) return preToolUseResponse(false, begun.reason, { projectId: project.projectId });

    const correlation = registry.state.operationCorrelations.put({
      provider: "codex",
      projectId: project.projectId,
      correlationHash,
      operationId,
      workId: observation.observedWorkId,
      generation: observation.observedGeneration,
      actorIdHash: actor.actorIdHash,
    });
    if (!correlation.ok) return preToolUseResponse(false, correlation.reason, { projectId: project.projectId });

    return preToolUseResponse(true, null, {
      projectId: project.projectId,
      operation: { operationId },
      replayed: false,
    });
  }

  async function postToolUse(payload, actor, cwd) {
    let event;
    try {
      event = normalizeCodexToolEvent(payload);
    } catch (error) {
      return result(false, error.code || "CODEX_HOOK_PAYLOAD_INVALID");
    }
    if (event.eventType !== "TOOL_RESULT") return result(false, "CODEX_HOOK_EVENT_UNSUPPORTED");
    if (event.sideEffectClass === "READ_ONLY") return result(true, null, { readOnly: true });
    if (!event.factualIds.toolCallId) return result(false, "CODEX_TOOL_OPERATION_NOT_FOUND");

    const project = await resolveProject(payload, cwd);
    if (!project) return result(false, "PROJECT_NOT_REGISTERED", { registered: false });

    const correlationHash = hash(event.factualIds.toolCallId);
    const found = registry.state.operationCorrelations.get({
      provider: "codex",
      projectId: project.projectId,
      correlationHash,
    });
    if (Array.isArray(found)) {
      if (found.length > 1) return result(false, "CODEX_TOOL_OPERATION_AMBIGUOUS", { projectId: project.projectId });
      if (found.length === 0) return result(false, "CODEX_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
    }
    const correlation = Array.isArray(found) ? found[0] : found;
    if (!correlation) return result(false, "CODEX_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
    if (correlation.provider !== "codex" || correlation.projectId !== project.projectId
      || correlation.correlationHash !== correlationHash
      || correlation.actorIdHash !== actor.actorIdHash) {
      return result(false, "CODEX_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    const observation = registry.state.sessionObservations.get({
      provider: "codex",
      projectId: project.projectId,
      actorIdHash: actor.actorIdHash,
    });
    if (!observation || observation.observedWorkId !== correlation.workId
      || observation.observedGeneration !== correlation.generation) {
      return result(false, "CODEX_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    const operation = registry.state.operations.inspect(correlation.operationId);
    if (!operation) return result(false, "CODEX_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
    if (operation.projectId !== project.projectId || operation.projectId !== correlation.projectId
      || operation.workId !== correlation.workId || operation.generation !== correlation.generation
      || operation.actorRef !== actor.actorIdHash || correlation.actorIdHash !== actor.actorIdHash) {
      return result(false, "CODEX_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    const workflowState = classifyToolResult(payload);
    if (!workflowState) return result(false, "CODEX_TOOL_RESULT_INVALID", { projectId: project.projectId });
    const resultRef = `provider-result:${workflowState.toLowerCase()}:${correlationHash}`;
    const terminal = registry.state.operations.terminalize({
      operationId: correlation.operationId,
      workflowState,
      resultRef,
      expectedHeartbeatAt: operation.heartbeatAt,
    });
    if (!terminal.ok) {
      if (terminal.reason === "OPERATION_NOT_FOUND") {
        return result(false, "CODEX_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
      }
      return result(false, "CODEX_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    return result(true, null, {
      projectId: project.projectId,
      operation: {
        operationId: terminal.operation.operationId,
        workflowState: terminal.operation.workflowState,
        liveness: terminal.operation.liveness,
      },
      replayed: terminal.replayed,
    });
  }

  return Object.freeze({
    async handle(payload = {}, { cwd = process.cwd() } = {}) {
      let actor;
      try {
        actor = normalizeCodexActor(payload);
      } catch (error) {
        const reason = error.code || "CODEX_PROVIDER_IDENTITY_INVALID";
        return payload.hook_event_name === "PreToolUse"
          ? preToolUseResponse(false, reason)
          : result(false, reason);
      }

      if (payload.hook_event_name === "PreToolUse") return preToolUse(payload, actor, cwd);
      if (payload.hook_event_name === "PostToolUse") return postToolUse(payload, actor, cwd);
      if (payload.hook_event_name !== "SessionStart") return result(false, "CODEX_HOOK_EVENT_UNSUPPORTED");

      const project = await resolveProject(payload, cwd);
      if (!project) return result(false, "PROJECT_NOT_REGISTERED", { registered: false });

      const observedAt = now();
      const attachment = authority.attach({
        projectId: project.projectId,
        actor: authorityActor(actor, observedAt),
        observedInstructionEpoch: project.runtime.instructionEpoch,
      });

      if (!attachment.allowed && attachment.reason !== "NO_ACTIVE_WORK") {
        return result(false, attachment.reason, {
          projectId: project.projectId,
          ...freshnessFields(attachment),
        });
      }

      const observation = {
        provider: "codex",
        projectId: project.projectId,
        actorIdHash: actor.actorIdHash,
        observedInstructionEpoch: project.runtime.instructionEpoch,
        observedWorkId: attachment.allowed ? attachment.workId : null,
        observedGeneration: attachment.allowed ? attachment.generation : null,
        observedAt,
      };
      const persisted = registry.state.sessionObservations.put(observation);
      if (!persisted.ok) return result(false, persisted.reason, { projectId: project.projectId });

      if (!attachment.allowed) {
        return sessionStartResponse(result(true, "ORCHESTRA_V2_INTAKE", {
          projectId: project.projectId,
          activeWork: null,
          work: null,
          generation: null,
          mutationAuthority: "UNAVAILABLE_UNTIL_WORK_STARTS",
        }), {
          schema: "orchestra.codex-session-context.v2",
          projectId: project.projectId,
          instructionEpoch: project.runtime.instructionEpoch,
          activeWork: null,
          work: null,
          generation: null,
          mutationAuthority: "UNAVAILABLE_UNTIL_WORK_STARTS",
        });
      }

      return sessionStartResponse(result(true, null, {
        projectId: project.projectId,
        work: {
          workId: attachment.workId,
          taskId: attachment.taskId,
          continuationRef: attachment.continuationRef,
        },
        generation: attachment.generation,
      }), {
        schema: "orchestra.codex-session-context.v2",
        projectId: project.projectId,
        instructionEpoch: project.runtime.instructionEpoch,
        work: {
          workId: attachment.workId,
          taskId: attachment.taskId,
          continuationRef: attachment.continuationRef,
        },
        generation: attachment.generation,
      });
    },
  });
}
