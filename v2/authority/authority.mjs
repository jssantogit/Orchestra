import {
  validateActorProvenanceV2,
  validateProjectV2,
  validateWorkUnitV2,
} from "../domain/contracts.mjs";

function baseValidation({ project, work, actor }) {
  if (!validateProjectV2(project).valid || !validateWorkUnitV2(work).valid || !validateActorProvenanceV2(actor).valid) {
    return { allowed: false, reason: "AUTHORITY_FACTS_INVALID" };
  }
  if (work.projectId !== project.projectId) return { allowed: false, reason: "WORK_PROJECT_MISMATCH" };
  if (work.runtimeImage !== project.runtime.pinnedImage) return { allowed: false, reason: "RUNTIME_IMAGE_MISMATCH" };
  return null;
}

function validateOperations({ project, work, liveOperations }) {
  for (const operation of liveOperations || []) {
    if (operation.projectId !== project.projectId) return { allowed: false, reason: "CROSS_PROJECT_OPERATION" };
    if (operation.workId !== work.workId) return { allowed: false, reason: "CROSS_WORK_OPERATION" };
    if (operation.generation !== work.generation) return { allowed: false, reason: "STALE_OPERATION_GENERATION" };
  }
  return null;
}

function liveMutationOperations(liveOperations) {
  return (liveOperations || []).filter((operation) =>
    operation.liveness === "LIVE"
    && Array.isArray(operation.capabilities)
    && operation.capabilities.includes("WORKSPACE_EDIT"));
}

export function authorizeAttach({ project, work, actor, observedInstructionEpoch, liveOperations = [] } = {}) {
  const invalid = baseValidation({ project, work, actor });
  if (invalid) return invalid;
  const invalidOperations = validateOperations({ project, work, liveOperations });
  if (invalidOperations) return invalidOperations;
  if (observedInstructionEpoch !== project.runtime.instructionEpoch || work.instructionEpoch !== project.runtime.instructionEpoch) {
    return {
      allowed: false,
      reason: "SESSION_RUNTIME_STALE",
      currentInstructionEpoch: project.runtime.instructionEpoch,
      continuationAvailable: Boolean(work.continuationRef),
    };
  }
  return { allowed: true, reason: null, generation: work.generation };
}

export function authorizeCapability({
  project,
  work,
  actor,
  capability,
  workspaceRef = null,
  expectedGeneration,
  liveOperations = [],
} = {}) {
  const invalid = baseValidation({ project, work, actor });
  if (invalid) return invalid;
  if (expectedGeneration !== work.generation) return { allowed: false, reason: "STALE_GENERATION" };

  const invalidOperations = validateOperations({ project, work, liveOperations });
  if (invalidOperations) return invalidOperations;

  if (capability === "WORKSPACE_EDIT") {
    const mutations = liveMutationOperations(liveOperations);
    if (typeof workspaceRef !== "string" || workspaceRef.trim().length === 0) {
      // Conservatively preserve the older denial reason when an incompatible writer
      // is already factual, while still requiring a workspace for otherwise legal mutation.
      if (mutations.length > 0) {
        return { allowed: false, reason: "INCOMPATIBLE_LIVE_OPERATION", operation: mutations[0].operationId ?? null };
      }
      return { allowed: false, reason: "MUTATION_WORKSPACE_REQUIRED" };
    }

    const unscoped = mutations.find((operation) => typeof operation.workspaceRef !== "string" || operation.workspaceRef.trim().length === 0);
    if (unscoped) {
      return { allowed: false, reason: "INCOMPATIBLE_LIVE_OPERATION", operation: unscoped.operationId ?? null };
    }

    const incompatible = mutations.find((operation) => operation.workspaceRef === workspaceRef);
    if (incompatible) {
      return { allowed: false, reason: "INCOMPATIBLE_LIVE_OPERATION", operation: incompatible.operationId ?? null };
    }
  }

  return { allowed: true, reason: null, generation: work.generation };
}
