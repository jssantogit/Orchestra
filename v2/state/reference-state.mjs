import { isDeepStrictEqual } from "node:util";

import {
  validateOperationV2,
  validateProjectV2,
  validateWorkUnitV2,
} from "../domain/contracts.mjs";

const WORK_IDENTITY_FIELDS = new Set(["workId", "projectId", "taskId", "generation"]);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasWorkspaceEdit(operation) {
  return Array.isArray(operation?.capabilities) && operation.capabilities.includes("WORKSPACE_EDIT");
}

function sameTerminalResult(operation, { workflowState, resultRef }) {
  return operation.workflowState === workflowState && operation.resultRef === resultRef;
}

function rebindKey({ projectId, expectedRoot, newRoot }) {
  return JSON.stringify([projectId, expectedRoot, newRoot]);
}

export function createReferenceState() {
  const projectsById = new Map();
  const projectIdByRoot = new Map();
  const projectRegisterRequestsById = new Map();
  const successfulRebindRequests = new Set();
  const worksById = new Map();
  const workOpenRequestsById = new Map();
  const transitionsByWork = new Map();
  const operationsById = new Map();
  const operationBeginRequestsById = new Map();

  const projects = {
    register(project) {
      if (!validateProjectV2(project).valid) return failure("PROJECT_INVALID");

      const existing = projectsById.get(project.projectId);
      if (existing) {
        const originalRegistration = projectRegisterRequestsById.get(project.projectId);
        if (originalRegistration && isDeepStrictEqual(originalRegistration, project)) {
          return success({ project: clone(existing), replayed: true });
        }
        return failure("PROJECT_ID_CONFLICT");
      }

      const rootOwner = projectIdByRoot.get(project.workspace.canonicalRoot);
      if (rootOwner && rootOwner !== project.projectId) {
        return failure("WORKSPACE_ALREADY_REGISTERED", { projectId: rootOwner });
      }

      const stored = clone(project);
      projectsById.set(stored.projectId, stored);
      projectRegisterRequestsById.set(stored.projectId, clone(project));
      projectIdByRoot.set(stored.workspace.canonicalRoot, stored.projectId);
      return success({ project: clone(stored), replayed: false });
    },

    resolve(rootOrId) {
      const byId = projectsById.get(rootOrId);
      if (byId) return clone(byId);
      const projectId = projectIdByRoot.get(rootOrId);
      return projectId ? clone(projectsById.get(projectId)) : null;
    },

    inspect(projectId) {
      return clone(projectsById.get(projectId) ?? null);
    },

    rebind({ projectId, expectedRoot, newRoot } = {}) {
      const current = projectsById.get(projectId);
      if (!current) return failure("PROJECT_NOT_FOUND");

      const requestKey = rebindKey({ projectId, expectedRoot, newRoot });
      if (successfulRebindRequests.has(requestKey)) {
        return success({ project: clone(current), replayed: true });
      }

      if (current.workspace.canonicalRoot !== expectedRoot) {
        return failure("STALE_PROJECT_ROOT", { currentRoot: current.workspace.canonicalRoot });
      }
      if (newRoot === expectedRoot) {
        successfulRebindRequests.add(requestKey);
        return success({ project: clone(current), replayed: true });
      }

      const targetOwner = projectIdByRoot.get(newRoot);
      if (targetOwner && targetOwner !== projectId) {
        return failure("WORKSPACE_ALREADY_REGISTERED", { projectId: targetOwner });
      }

      const next = {
        ...clone(current),
        workspace: { ...clone(current.workspace), canonicalRoot: newRoot },
      };
      if (!validateProjectV2(next).valid) return failure("PROJECT_INVALID");

      projectIdByRoot.delete(expectedRoot);
      projectIdByRoot.set(newRoot, projectId);
      projectsById.set(projectId, next);
      successfulRebindRequests.add(requestKey);
      return success({ project: clone(next), replayed: false });
    },
  };

  const work = {
    open(workUnit) {
      if (!validateWorkUnitV2(workUnit).valid) return failure("WORK_INVALID");

      const project = projectsById.get(workUnit.projectId);
      if (!project) return failure("PROJECT_NOT_FOUND");
      if (workUnit.runtimeImage !== project.runtime.pinnedImage) return failure("RUNTIME_IMAGE_MISMATCH");
      if (workUnit.instructionEpoch !== project.runtime.instructionEpoch) return failure("INSTRUCTION_EPOCH_MISMATCH");

      const existing = worksById.get(workUnit.workId);
      if (existing) {
        const originalOpen = workOpenRequestsById.get(workUnit.workId);
        if (originalOpen && isDeepStrictEqual(originalOpen, workUnit)) {
          return success({ work: clone(existing), replayed: true });
        }
        return failure("WORK_ID_CONFLICT");
      }

      const stored = clone(workUnit);
      worksById.set(stored.workId, stored);
      workOpenRequestsById.set(stored.workId, clone(workUnit));
      transitionsByWork.set(stored.workId, new Map());
      return success({ work: clone(stored), replayed: false });
    },

    read(projectId, workId) {
      const current = worksById.get(workId);
      if (!current || current.projectId !== projectId) return null;
      return clone(current);
    },

    transition({ projectId, workId, expectedGeneration, transitionId, patch } = {}) {
      const current = worksById.get(workId);
      if (!current) return failure("WORK_NOT_FOUND");
      if (current.projectId !== projectId) return failure("WORK_PROJECT_MISMATCH");
      if (typeof transitionId !== "string" || transitionId.length === 0 || !isRecord(patch)) {
        return failure("WORK_TRANSITION_INVALID");
      }

      const transitionLog = transitionsByWork.get(workId);
      const prior = transitionLog.get(transitionId);
      const request = clone({ projectId, workId, expectedGeneration, transitionId, patch });
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request)) return failure("IDEMPOTENCY_CONFLICT");
        return success({ work: clone(prior.work), replayed: true });
      }

      if (expectedGeneration !== current.generation) {
        return failure("STALE_GENERATION", { currentGeneration: current.generation });
      }

      if (Object.keys(patch).some((key) => WORK_IDENTITY_FIELDS.has(key))) {
        return failure("IMMUTABLE_WORK_IDENTITY");
      }

      const next = {
        ...clone(current),
        ...clone(patch),
        generation: current.generation + 1,
      };
      if (!validateWorkUnitV2(next).valid) return failure("WORK_TRANSITION_INVALID");
      if (next.runtimeImage !== projectsById.get(projectId)?.runtime.pinnedImage) return failure("RUNTIME_IMAGE_MISMATCH");
      if (next.instructionEpoch !== projectsById.get(projectId)?.runtime.instructionEpoch) return failure("INSTRUCTION_EPOCH_MISMATCH");

      worksById.set(workId, next);
      transitionLog.set(transitionId, { request, work: clone(next) });
      return success({ work: clone(next), replayed: false });
    },
  };

  const operations = {
    begin({ expectedGeneration, operation } = {}) {
      if (!validateOperationV2(operation).valid) return failure("OPERATION_INVALID");

      const existing = operationsById.get(operation.operationId);
      if (existing) {
        const originalBegin = operationBeginRequestsById.get(operation.operationId);
        const request = { expectedGeneration, operation: clone(operation) };
        if (originalBegin && isDeepStrictEqual(originalBegin, request)) {
          return success({ operation: clone(existing), replayed: true });
        }
        return failure("OPERATION_ID_CONFLICT");
      }

      if (operation.liveness !== "LIVE") return failure("OPERATION_BEGIN_NOT_LIVE");
      if (hasWorkspaceEdit(operation) && !operation.workspaceRef) return failure("MUTATION_WORKSPACE_REQUIRED");

      const currentWork = worksById.get(operation.workId);
      if (!currentWork) return failure("WORK_NOT_FOUND");
      if (operation.projectId !== currentWork.projectId) return failure("OPERATION_PROJECT_MISMATCH");
      if (!projectsById.has(operation.projectId)) return failure("PROJECT_NOT_FOUND");
      if (expectedGeneration !== currentWork.generation) {
        return failure("STALE_GENERATION", { currentGeneration: currentWork.generation });
      }
      if (operation.generation !== currentWork.generation) {
        return failure("OPERATION_GENERATION_MISMATCH", { currentGeneration: currentWork.generation });
      }

      if (hasWorkspaceEdit(operation)) {
        const incompatible = [...operationsById.values()].find((candidate) =>
          candidate.projectId === operation.projectId
          && candidate.workspaceRef === operation.workspaceRef
          && candidate.liveness === "LIVE"
          && hasWorkspaceEdit(candidate));
        if (incompatible) {
          return failure("INCOMPATIBLE_LIVE_OPERATION", { operationId: incompatible.operationId });
        }
      }

      const stored = clone(operation);
      operationsById.set(stored.operationId, stored);
      operationBeginRequestsById.set(stored.operationId, {
        expectedGeneration,
        operation: clone(operation),
      });
      return success({ operation: clone(stored), replayed: false });
    },

    inspect(operationId) {
      return clone(operationsById.get(operationId) ?? null);
    },

    listLive({ projectId, workId = null, generation = null } = {}) {
      return [...operationsById.values()]
        .filter((operation) => operation.projectId === projectId)
        .filter((operation) => workId === null || operation.workId === workId)
        .filter((operation) => generation === null || operation.generation === generation)
        .filter((operation) => operation.liveness === "LIVE")
        .map(clone);
    },

    heartbeat({ operationId, runtimeOwnerRef, heartbeatAt } = {}) {
      const current = operationsById.get(operationId);
      if (!current) return failure("OPERATION_NOT_FOUND");
      if (current.liveness === "TERMINAL") return failure("OPERATION_TERMINAL");
      if (current.runtimeOwnerRef !== runtimeOwnerRef) return failure("OWNER_PROOF_MISMATCH");

      const previousHeartbeat = current.heartbeatAt ? Date.parse(current.heartbeatAt) : Number.NEGATIVE_INFINITY;
      const nextHeartbeat = Date.parse(heartbeatAt);
      if (!Number.isFinite(nextHeartbeat)) return failure("HEARTBEAT_INVALID");
      if (nextHeartbeat < previousHeartbeat) return failure("STALE_HEARTBEAT");

      const next = { ...clone(current), heartbeatAt };
      if (!validateOperationV2(next).valid) return failure("HEARTBEAT_INVALID");
      operationsById.set(operationId, next);
      return success({ operation: clone(next) });
    },

    terminalize({ operationId, workflowState, resultRef } = {}) {
      const current = operationsById.get(operationId);
      if (!current) return failure("OPERATION_NOT_FOUND");

      if (current.liveness === "TERMINAL") {
        if (sameTerminalResult(current, { workflowState, resultRef })) {
          return success({ operation: clone(current), replayed: true });
        }
        return failure("TERMINAL_RESULT_CONFLICT");
      }

      const next = {
        ...clone(current),
        workflowState,
        liveness: "TERMINAL",
        resultRef,
      };
      if (!validateOperationV2(next).valid) return failure("TERMINAL_RESULT_INVALID");
      operationsById.set(operationId, next);
      return success({ operation: clone(next), replayed: false });
    },
  };

  return Object.freeze({ projects, work, operations });
}
