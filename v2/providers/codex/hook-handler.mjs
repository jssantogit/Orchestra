import { createWorkAuthority } from "../../authority/work-authority.mjs";
import { normalizeCodexActor } from "./actor.mjs";

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

export function createCodexHookHandler({ registry, now = () => new Date().toISOString() } = {}) {
  if (!registry?.state || typeof registry.resolveWorkspace !== "function") {
    throw new TypeError("global project registry is required");
  }
  const authority = createWorkAuthority({ state: registry.state });

  return Object.freeze({
    async handle(payload = {}, { cwd = process.cwd() } = {}) {
      let actor;
      try {
        actor = normalizeCodexActor(payload);
      } catch (error) {
        return result(false, error.code || "CODEX_PROVIDER_IDENTITY_INVALID");
      }
      if (payload.hook_event_name !== "SessionStart") {
        return result(false, "CODEX_HOOK_EVENT_UNSUPPORTED");
      }

      let project;
      try {
        project = await registry.resolveWorkspace(
          typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : cwd,
        );
      } catch (error) {
        if (["ORCHESTRA_PROJECT_NOT_GIT", "ORCHESTRA_PROJECT_ROOT_INVALID", "ORCHESTRA_PROJECT_ROOT_UNAVAILABLE"].includes(error.code)) {
          return result(false, "PROJECT_NOT_REGISTERED", { registered: false });
        }
        throw error;
      }
      if (!project) return result(false, "PROJECT_NOT_REGISTERED", { registered: false });

      const observedAt = now();
      const authorityActor = {
        schema: "orchestra.actor-provenance.v2",
        provider: actor.provider,
        subjectHash: actor.actorIdHash,
        source: "PROVIDER_FACT",
        observedAt,
      };
      const attachment = authority.attach({
        projectId: project.projectId,
        actor: authorityActor,
        observedInstructionEpoch: project.runtime.instructionEpoch,
      });

      if (!attachment.allowed && attachment.reason !== "NO_ACTIVE_WORK") {
        return result(false, attachment.reason, {
          projectId: project.projectId,
          ...(attachment.currentInstructionEpoch !== undefined
            ? { currentInstructionEpoch: attachment.currentInstructionEpoch }
            : {}),
          ...(attachment.continuationAvailable !== undefined
            ? { continuationAvailable: attachment.continuationAvailable }
            : {}),
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
