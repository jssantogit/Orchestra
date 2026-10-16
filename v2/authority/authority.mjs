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
  expectedGeneration,
  liveOperations = [],
} = {}) {
  const invalid = baseValidation({ project, work, actor });
  if (invalid) return invalid;
  if (expectedGeneration !== work.generation) return { allowed: false, reason: "STALE_GENERATION" };

  const invalidOperations = validateOperations({ project, work, liveOperations });
  if (invalidOperations) return invalidOperations;

  if (capability === "WORKSPACE_EDIT") {
    const incompatible = liveOperations.find((operation) =>
      operation.liveness === "LIVE" && Array.isArray(operation.capabilities) && operation.capabilities.includes("WORKSPACE_EDIT"));
    if (incompatible) return { allowed: false, reason: "INCOMPATIBLE_LIVE_OPERATION", operation: incompatible.operationId ?? null };
  }

  return { allowed: true, reason: null, generation: work.generation };
}
