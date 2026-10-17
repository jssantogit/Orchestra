import { authorizeAttach, authorizeCapability } from "./authority.mjs";

function requireState(state) {
  if (!state?.projects?.inspect || !state?.work?.current || !state?.operations?.listLive) {
    throw new TypeError("state with projects/work/operations is required");
  }
  return state;
}

export function createWorkAuthority({ state } = {}) {
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
    const liveOperations = store.operations.listLive({
      projectId,
      workId: work.workId,
      generation: work.generation,
    });
    return { project, work, liveOperations };
  }

  function freshnessDecision(facts, actor, observedInstructionEpoch) {
    return authorizeAttach({
      project: facts.project,
      work: facts.work,
      actor,
      observedInstructionEpoch,
      liveOperations: facts.liveOperations,
    });
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

    authorize({
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
      return authorizeCapability({
        project: facts.project,
        work: facts.work,
        actor,
        capability,
        workspaceRef,
        expectedGeneration,
        liveOperations: facts.liveOperations,
      });
    },

    abandon(command) {
      const projectId = command?.projectId;
      if (!store.projects.inspect(projectId)) return { ok: false, reason: "PROJECT_NOT_FOUND" };
      return store.work.abandonCurrent(command);
    },
  });
}
