import { createWorkAuthority } from "../../authority/work-authority.mjs";
import { normalizeAntigravityActor } from "./actor.mjs";

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

function authorityActor(actor, observedAt) {
  return {
    schema: "orchestra.actor-provenance.v2",
    provider: actor.provider,
    subjectHash: actor.actorIdHash,
    source: "PROVIDER_FACT",
    observedAt,
  };
}

function isSessionStart(payload) {
  const aliases = ["hook_event_name", "hookEventName", "eventType"]
    .filter((key) => Object.hasOwn(payload, key))
    .map((key) => payload[key]);
  return aliases.length > 0
    && aliases.every((value) => value === "SessionStart");
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
  };
}

export function createAntigravityHookHandler({ registry, now = () => new Date().toISOString() } = {}) {
  if (!registry?.state || typeof registry.resolveWorkspace !== "function") {
    throw new TypeError("global project registry is required");
  }

  const authority = createWorkAuthority({ state: registry.state });

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

  return Object.freeze({
    async handle(payload = {}, { cwd = process.cwd() } = {}) {
      if (!isSessionStart(payload)) return result(false, "ANTIGRAVITY_HOOK_EVENT_UNSUPPORTED");

      let actor;
      try {
        actor = normalizeAntigravityActor(payload);
      } catch (error) {
        return result(false, error.code || "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID");
      }

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
        return sessionStartResponse(result(true, "ORCHESTRA_V2_INTAKE", {
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
        });
      }

      const work = {
        workId: attachment.workId,
        taskId: attachment.taskId,
        continuationRef: attachment.continuationRef,
      };
      return sessionStartResponse(result(true, null, {
        projectId: project.projectId,
        work,
        generation: attachment.generation,
      }), {
        ...contextBase,
        work,
        generation: attachment.generation,
      });
    },
  });
}
