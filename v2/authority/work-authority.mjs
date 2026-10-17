import { validateLivenessAssessmentV2 } from "../liveness/contracts.mjs";
import { authorizeAttach, authorizeCapability } from "./authority.mjs";

function requireState(state) {
  if (!state?.projects?.inspect || !state?.work?.current || !state?.operations?.listLive) {
    throw new TypeError("state with projects/work/operations is required");
  }
  return state;
}

function isMutationCandidate(operation, workspaceRef) {
  if (!Array.isArray(operation?.capabilities) || !operation.capabilities.includes("WORKSPACE_EDIT")) return false;
  if (typeof workspaceRef !== "string" || workspaceRef.trim().length === 0) return true;
  if (typeof operation.workspaceRef !== "string" || operation.workspaceRef.trim().length === 0) return true;
  return operation.workspaceRef === workspaceRef;
}

function factualDenial(reason, operation, assessment = null) {
  return {
    allowed: false,
    reason,
    operation: operation?.operationId ?? null,
    ...(assessment?.reason ? { livenessReason: assessment.reason } : {}),
  };
}

function validAssessment(operation, assessment) {
  return validateLivenessAssessmentV2(assessment).valid
    && assessment.operationId === operation.operationId;
}

export function createWorkAuthority({ state, operationLiveness = null } = {}) {
  const store = requireState(state);

  function currentFacts(projectId) {
    const project = store.projects.inspect(projectId);
    if (!project) return { error: { allowed: false, reason: "PROJECT_NOT_FOUND" } };
    let work;
    try {
      work = store.work.current(projectId);
    } catch (error) {
      if (error?.code === "ORCHESTRA_ACTIVE_WORK_HEAD_CORRUPT") {
        return { project, error: { allowed: false, reason: "ACTIVE_WORK_CORRUPT" } };
      }
      throw error;
    }
    if (!work) return { project, error: { allowed: false, reason: "NO_ACTIVE_WORK" } };
    const candidateOperations = store.operations.listLive({
      projectId,
      workId: work.workId,
      generation: work.generation,
    });
    return { project, work, candidateOperations };
  }

  function freshnessDecision(facts, actor, observedInstructionEpoch) {
    return authorizeAttach({
      project: facts.project,
      work: facts.work,
      actor,
      observedInstructionEpoch,
      liveOperations: facts.candidateOperations,
    });
  }

  async function factualMutationOperations(facts, workspaceRef) {
    const candidates = facts.candidateOperations.filter((operation) => isMutationCandidate(operation, workspaceRef));
    if (candidates.length === 0) return { liveOperations: [] };

    if (typeof operationLiveness?.assess !== "function") {
      return { denial: factualDenial("OPERATION_LIVENESS_UNAVAILABLE", candidates[0]) };
    }

    const assessed = await Promise.all(candidates.map(async (operation) => {
      try {
        const assessment = await operationLiveness.assess(operation);
        if (!validAssessment(operation, assessment)) {
          return { operation, assessment: null, error: "ASSESSMENT_INVALID" };
        }
        return { operation, assessment, error: null };
      } catch {
        return { operation, assessment: null, error: "ASSESSMENT_FAILED" };
      }
    }));

    const live = assessed.filter((entry) => entry.assessment?.liveness === "LIVE").map((entry) => entry.operation);
    if (live.length > 0) return { liveOperations: live };

    const invalid = assessed.find((entry) => entry.error);
    if (invalid) {
      return {
        denial: {
          ...factualDenial("OPERATION_LIVENESS_UNKNOWN", invalid.operation),
          livenessReason: invalid.error,
        },
      };
    }

    const unknown = assessed.find((entry) => entry.assessment.liveness === "UNKNOWN");
    if (unknown) {
      return { denial: factualDenial("OPERATION_LIVENESS_UNKNOWN", unknown.operation, unknown.assessment) };
    }

    const stale = assessed.find((entry) => entry.assessment.liveness === "STALE_RECOVERABLE");
    if (stale) {
      return { denial: factualDenial("STALE_OPERATION_RECOVERY_REQUIRED", stale.operation, stale.assessment) };
    }

    return { liveOperations: [] };
  }

  return Object.freeze({
    current(projectId) {
      const facts = currentFacts(projectId);
      if (facts.error) return facts.error;
      return {
        ok: true,
        projectId,
        work: facts.work,
      };
    },

    start(workUnit) {
      return store.work.startCurrent(workUnit);
    },

    attach({ projectId, actor, observedInstructionEpoch } = {}) {
      const facts = currentFacts(projectId);
      if (facts.error) return facts.error;
      const decision = freshnessDecision(facts, actor, observedInstructionEpoch);
      if (!decision.allowed) return decision;
      return {
        allowed: true,
        reason: null,
        projectId,
        workId: facts.work.workId,
        taskId: facts.work.taskId,
        generation: facts.work.generation,
        continuationRef: facts.work.continuationRef,
      };
    },

    async authorize({
      projectId,
      expectedWorkId,
      actor,
      observedInstructionEpoch,
      capability,
      workspaceRef = null,
      expectedGeneration,
    } = {}) {
      const facts = currentFacts(projectId);
      if (facts.error) return facts.error;
      if (expectedWorkId !== facts.work.workId) {
        return {
          allowed: false,
          reason: "STALE_ACTIVE_WORK",
          currentWorkId: facts.work.workId,
        };
      }
      const freshness = freshnessDecision(facts, actor, observedInstructionEpoch);
      if (!freshness.allowed) return freshness;

      let liveOperations = facts.candidateOperations;
      if (capability === "WORKSPACE_EDIT") {
        const factual = await factualMutationOperations(facts, workspaceRef);
        if (factual.denial) return factual.denial;
        liveOperations = factual.liveOperations;
      }

      return authorizeCapability({
        project: facts.project,
        work: facts.work,
        actor,
        capability,
        workspaceRef,
        expectedGeneration,
        liveOperations,
      });
    },

    abandon(command) {
      const projectId = command?.projectId;
      if (!store.projects.inspect(projectId)) return { ok: false, reason: "PROJECT_NOT_FOUND" };
      return store.work.abandonCurrent(command);
    },
  });
}
