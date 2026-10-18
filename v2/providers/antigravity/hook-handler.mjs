import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { createWorkAuthority } from "../../authority/work-authority.mjs";
import { createExperienceRecorders } from "../../experience/recorders.mjs";
import { createHostProcessIdentityReader, createLocalProcessOwnerProbe } from "../../liveness/local-process-probe.mjs";
import { createOperationLivenessService } from "../../liveness/operation-liveness-service.mjs";
import { createProviderEventProbe } from "../../liveness/provider-event-liveness.mjs";
import { createRuntimeOwnerStore } from "../../liveness/runtime-owner-store.mjs";
import { normalizeAntigravityActor } from "./actor.mjs";
import { normalizeAntigravityToolEvent } from "./tool-event.mjs";

const PROVIDER_EVENT_DEADLINE_MS = 5 * 60_000;

function result(ok, reason, fields = {}) {
  return { ok, reason, ...fields };
}

function lifecycleResponse(response, context, hookEventName) {
  return {
    ...response,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: JSON.stringify(context),
    },
  };
}

function preToolUseResponse(ok, reason, fields = {}) {
  const decision = ok ? "allow" : "deny";
  return {
    ...result(ok, reason, fields),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: JSON.stringify({ reason, ...fields }),
    },
  };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
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

function authorityActor(actor, observedAt) {
  return {
    schema: "orchestra.actor-provenance.v2",
    provider: actor.provider,
    subjectHash: actor.actorIdHash,
    source: "PROVIDER_FACT",
    observedAt,
  };
}

function isAttachLifecycle(payload) {
  const aliases = ["hook_event_name", "hookEventName", "eventType"]
    .filter((key) => Object.hasOwn(payload, key))
    .map((key) => payload[key]);
  return aliases.length > 0
    && ["SessionStart", "PreInvocation"].includes(aliases[0])
    && aliases.every((value) => value === aliases[0]);
}

function eventName(payload) {
  const names = ["hook_event_name", "hookEventName", "eventType"]
    .filter((key) => Object.hasOwn(payload, key))
    .map((key) => payload[key]);
  if (names.length === 0 || names.some((name) => name !== names[0])) return null;
  return names[0];
}

export function createAntigravityHookHandler({
  registry,
  now = () => new Date().toISOString(),
  experienceRecorder = null,
} = {}) {
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
  const recorder = experienceRecorder
    ?? (registry.state.experience ? createExperienceRecorders({ persistence: registry.state.experience }) : null);

  async function safeRecord(method, payload) {
    try {
      if (typeof recorder?.[method] === "function") await recorder[method](payload);
    } catch {
      // Experience is non-authoritative and cannot alter provider execution outcomes.
    }
  }

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
      event = normalizeAntigravityToolEvent(payload);
    } catch (error) {
      return preToolUseResponse(false, error.code || "ANTIGRAVITY_HOOK_PAYLOAD_INVALID");
    }
    if (event.eventType !== "TOOL_REQUEST") return preToolUseResponse(false, "ANTIGRAVITY_HOOK_EVENT_UNSUPPORTED");

    const project = await resolveProject(payload, cwd);
    if (!project) return preToolUseResponse(false, "PROJECT_NOT_REGISTERED", { registered: false });

    const observedAt = now();
    const actorRef = authorityActor(actor, observedAt);
    const observation = registry.state.sessionObservations.get({
      provider: "antigravity",
      projectId: project.projectId,
      actorIdHash: actor.actorIdHash,
    });
    if (!observation) {
      return preToolUseResponse(false, "ANTIGRAVITY_SESSION_OBSERVATION_MISSING", { projectId: project.projectId });
    }
    if (observation.observedWorkId === null || observation.observedGeneration === null) {
      return preToolUseResponse(false, "NO_ACTIVE_WORK", { projectId: project.projectId });
    }

    const isReadOnly = event.sideEffectClass === "READ_ONLY";
    if (!isReadOnly && !event.factualIds.toolCallId) {
      return preToolUseResponse(false, "ANTIGRAVITY_TOOL_CORRELATION_REQUIRED", { projectId: project.projectId });
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
      const authorized = await authorizedAuthority.authorize({ ...expectedTuple, capability: "WORKSPACE_READ" });
      if (!authorized.allowed) return preToolUseResponse(false, authorized.reason, freshnessFields(authorized));
      await safeRecord("recordProviderCapability", {
        project,
        workId: observation.observedWorkId,
        providerFamily: "antigravity",
        capabilityClass: "WORKSPACE_READ",
        toolClass: event.sideEffectClass,
      });
      return preToolUseResponse(true, null, { projectId: project.projectId });
    }

    const correlationHash = hash(event.factualIds.toolCallId);
    const existingCorrelation = registry.state.operationCorrelations.get({
      provider: "antigravity",
      projectId: project.projectId,
      correlationHash,
    });
    if (existingCorrelation) {
      if (existingCorrelation.workId !== observation.observedWorkId
        || existingCorrelation.generation !== observation.observedGeneration
        || existingCorrelation.actorIdHash !== actor.actorIdHash) {
        return preToolUseResponse(false, "ANTIGRAVITY_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
      }
      const authorized = await authorizedAuthority.authorize({ ...expectedTuple, capability: "WORKSPACE_READ" });
      if (!authorized.allowed) return preToolUseResponse(false, authorized.reason, freshnessFields(authorized));
      const operation = registry.state.operations.inspect(existingCorrelation.operationId);
      if (!operation) return preToolUseResponse(false, "ANTIGRAVITY_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
      const assessment = await operationLiveness.assess(operation);
      if (assessment.liveness !== "LIVE" || operation.workflowState !== "RUNNING" || operation.liveness !== "LIVE") {
        const reason = assessment.liveness === "STALE_RECOVERABLE" ? "STALE_OPERATION_RECOVERY_REQUIRED"
          : assessment.liveness === "UNKNOWN" ? "OPERATION_LIVENESS_UNKNOWN"
            : "ANTIGRAVITY_TOOL_OPERATION_NOT_REPLAYABLE";
        return preToolUseResponse(false, reason, {
          projectId: project.projectId,
          operation: operation.operationId,
          liveness: assessment.liveness,
          livenessReason: assessment.reason,
          recoveryRequired: assessment.liveness === "STALE_RECOVERABLE",
        });
      }
      await safeRecord("recordProviderCapability", {
        project,
        workId: operation.workId,
        operationId: operation.operationId,
        providerFamily: "antigravity",
        capabilityClass: "WORKSPACE_EDIT",
        toolClass: event.sideEffectClass,
      });
      return preToolUseResponse(true, null, {
        projectId: project.projectId,
        operation: { operationId: operation.operationId },
        replayed: true,
      });
    }

    const authorized = await authorizedAuthority.authorize({ ...expectedTuple, capability: "WORKSPACE_EDIT" });
    if (!authorized.allowed) return preToolUseResponse(false, authorized.reason, freshnessFields(authorized));

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
      provider: "antigravity",
      projectId: project.projectId,
      correlationHash,
      operationId,
      workId: observation.observedWorkId,
      generation: observation.observedGeneration,
      actorIdHash: actor.actorIdHash,
    });
    if (!correlation.ok) return preToolUseResponse(false, correlation.reason, { projectId: project.projectId });

    await safeRecord("recordProviderCapability", {
      project,
      workId: observation.observedWorkId,
      operationId,
      providerFamily: "antigravity",
      capabilityClass: "WORKSPACE_EDIT",
      toolClass: event.sideEffectClass,
    });
    return preToolUseResponse(true, null, {
      projectId: project.projectId,
      operation: { operationId },
      replayed: false,
    });
  }

  async function postToolUse(payload, actor, cwd) {
    let event;
    try {
      event = normalizeAntigravityToolEvent(payload);
    } catch (error) {
      return result(false, error.code || "ANTIGRAVITY_HOOK_PAYLOAD_INVALID");
    }
    if (event.eventType !== "TOOL_RESULT") return result(false, "ANTIGRAVITY_HOOK_EVENT_UNSUPPORTED");
    if (event.sideEffectClass === "READ_ONLY") return result(true, null, { readOnly: true });
    if (!event.factualIds.toolCallId) return result(false, "ANTIGRAVITY_TOOL_OPERATION_NOT_FOUND");

    const project = await resolveProject(payload, cwd);
    if (!project) return result(false, "PROJECT_NOT_REGISTERED", { registered: false });

    const correlationHash = hash(event.factualIds.toolCallId);
    const correlation = registry.state.operationCorrelations.get({
      provider: "antigravity",
      projectId: project.projectId,
      correlationHash,
    });
    if (!correlation) return result(false, "ANTIGRAVITY_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
    if (correlation.provider !== "antigravity" || correlation.projectId !== project.projectId
      || correlation.correlationHash !== correlationHash || correlation.actorIdHash !== actor.actorIdHash) {
      return result(false, "ANTIGRAVITY_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    const observation = registry.state.sessionObservations.get({
      provider: "antigravity",
      projectId: project.projectId,
      actorIdHash: actor.actorIdHash,
    });
    if (!observation || observation.observedWorkId !== correlation.workId
      || observation.observedGeneration !== correlation.generation) {
      return result(false, "ANTIGRAVITY_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    const operation = registry.state.operations.inspect(correlation.operationId);
    if (!operation) return result(false, "ANTIGRAVITY_TOOL_OPERATION_NOT_FOUND", { projectId: project.projectId });
    if (operation.projectId !== project.projectId || operation.projectId !== correlation.projectId
      || operation.workId !== correlation.workId || operation.generation !== correlation.generation
      || operation.actorRef !== actor.actorIdHash || correlation.actorIdHash !== actor.actorIdHash) {
      return result(false, "ANTIGRAVITY_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    const workflowState = classifyToolResult(payload);
    if (!workflowState) return result(false, "ANTIGRAVITY_TOOL_RESULT_INVALID", { projectId: project.projectId });
    const terminal = registry.state.operations.terminalize({
      operationId: correlation.operationId,
      workflowState,
      resultRef: `provider-result:${workflowState.toLowerCase()}:${correlationHash}`,
      expectedHeartbeatAt: operation.heartbeatAt,
    });
    if (!terminal.ok) {
      return result(false, terminal.reason === "OPERATION_NOT_FOUND"
        ? "ANTIGRAVITY_TOOL_OPERATION_NOT_FOUND"
        : "ANTIGRAVITY_PROVIDER_EVENT_MISMATCH", { projectId: project.projectId });
    }

    await safeRecord("recordProviderTerminal", {
      project,
      operation: terminal.operation,
      providerFamily: "antigravity",
      workflowState: terminal.operation.workflowState,
    });
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
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return result(false, "ANTIGRAVITY_HOOK_PAYLOAD_INVALID");
      }
      const hookEvent = eventName(payload);

      let actor;
      try {
        actor = normalizeAntigravityActor(payload);
      } catch (error) {
        if (hookEvent === "PreToolUse") {
          return preToolUseResponse(false, error.code || "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID");
        }
        return result(false, error.code || "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID");
      }

      let event;
      try {
        event = normalizeAntigravityToolEvent(payload);
      } catch (error) {
        if (hookEvent === "PreToolUse") return preToolUseResponse(false, error.code || "ANTIGRAVITY_HOOK_PAYLOAD_INVALID");
        return result(false, error.code || "ANTIGRAVITY_HOOK_PAYLOAD_INVALID");
      }
      if (event.eventType === "TOOL_REQUEST") return preToolUse(payload, actor, cwd);
      if (event.eventType === "TOOL_RESULT") return postToolUse(payload, actor, cwd);
      if (!isAttachLifecycle(payload)) return result(false, "ANTIGRAVITY_HOOK_EVENT_UNSUPPORTED");

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
        provider: "antigravity",
        projectId: project.projectId,
        actorIdHash: actor.actorIdHash,
        observedInstructionEpoch: project.runtime.instructionEpoch,
        observedWorkId: attachment.allowed ? attachment.workId : null,
        observedGeneration: attachment.allowed ? attachment.generation : null,
        observedAt,
      };
      const persisted = registry.state.sessionObservations.put(observation);
      if (!persisted.ok) return result(false, persisted.reason, { projectId: project.projectId });

      const contextBase = {
        schema: "orchestra.antigravity-session-context.v2",
        projectId: project.projectId,
        instructionEpoch: project.runtime.instructionEpoch,
      };
      if (!attachment.allowed) {
        return lifecycleResponse(result(true, "ORCHESTRA_V2_INTAKE", {
          projectId: project.projectId,
          activeWork: null,
          work: null,
          generation: null,
          mutationAuthority: "UNAVAILABLE_UNTIL_WORK_STARTS",
        }), {
          ...contextBase,
          activeWork: null,
          work: null,
          generation: null,
          mutationAuthority: "UNAVAILABLE_UNTIL_WORK_STARTS",
        }, hookEvent);
      }

      const work = {
        workId: attachment.workId,
        taskId: attachment.taskId,
        continuationRef: attachment.continuationRef,
      };
      return lifecycleResponse(result(true, null, {
        projectId: project.projectId,
        work,
        generation: attachment.generation,
      }), {
        ...contextBase,
        work,
        generation: attachment.generation,
      }, hookEvent);
    },
  });
}
