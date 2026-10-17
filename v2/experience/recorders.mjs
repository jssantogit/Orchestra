import { projectExperience } from "./projector.mjs";
import { createExperienceStore } from "./store.mjs";

const DOMAIN_COHORT = "software-engineering";

function unavailable() {
  return { ok: false, reason: "EXPERIENCE_RECORDING_UNAVAILABLE" };
}

function failed() {
  return { ok: false, reason: "EXPERIENCE_RECORDING_FAILED" };
}

function normalizedClass(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(normalized) ? normalized : fallback;
}

function source(project, { workId = null, operationId = null } = {}) {
  return {
    sourceProjectId: project?.projectId,
    sourceLineageId: project?.lineageId,
    workId,
    operationId,
    domainCohort: DOMAIN_COHORT,
    projectLineageIds: project?.lineageId ? [project.lineageId] : [],
    requestedScope: "PROJECT",
  };
}

export function createExperienceRecorders({ persistence, projectionVersion = "1" } = {}) {
  if (!persistence) {
    return Object.freeze({
      async recordRecovery() { return unavailable(); },
      async recordProviderCapability() { return unavailable(); },
      async recordProviderTerminal() { return unavailable(); },
      async recordRuntimeChange() { return unavailable(); },
      async recordRuntimeFailure() { return unavailable(); },
    });
  }

  let store;
  try {
    store = createExperienceStore({ persistence });
  } catch {
    return Object.freeze({
      async recordRecovery() { return unavailable(); },
      async recordProviderCapability() { return unavailable(); },
      async recordProviderTerminal() { return unavailable(); },
      async recordRuntimeChange() { return unavailable(); },
      async recordRuntimeFailure() { return unavailable(); },
    });
  }

  async function persist(specs) {
    try {
      const results = [];
      const experienceIds = [];
      for (const spec of specs) {
        const projected = projectExperience({ ...spec, projectionVersion });
        if (!projected.valid) return failed();
        const written = store.put(projected.experience);
        if (!written?.ok) return failed();
        results.push(written);
        experienceIds.push(projected.experience.experienceId);
      }
      return {
        ok: true,
        experienceIds,
        replayed: results.length > 0 && results.every((entry) => Boolean(entry.replayed)),
      };
    } catch {
      return failed();
    }
  }

  return Object.freeze({
    async recordRecovery({ project, operation, failureClass, recoveryClass, cleanupStatus } = {}) {
      return persist([{
        category: "DIAGNOSTIC",
        ...source(project, {
          workId: operation?.workId ?? null,
          operationId: operation?.operationId ?? null,
        }),
        facts: {
          failureClass: normalizedClass(failureClass, "STALE_OPERATION"),
          recoveryClass: normalizedClass(recoveryClass, "RECONCILED"),
          resultClass: normalizedClass(cleanupStatus, "RECOVERED"),
        },
        outcome: {
          terminalOutcome: "RECOVERED",
          success: true,
          recoveryClass: normalizedClass(recoveryClass, "RECONCILED"),
        },
      }]);
    },

    async recordProviderCapability({
      project,
      workId = null,
      operationId = null,
      providerFamily,
      capabilityClass,
      toolClass,
    } = {}) {
      return persist([{
        category: "PROVIDER_TOOL_FACT",
        ...source(project, { workId, operationId }),
        facts: {
          providerFamily,
          capabilityClass: normalizedClass(capabilityClass, "UNKNOWN_CAPABILITY"),
          toolClass: normalizedClass(toolClass, "UNKNOWN_TOOL"),
        },
        outcome: { resultClass: "OBSERVED" },
      }]);
    },

    async recordProviderTerminal({ project, operation, providerFamily, workflowState } = {}) {
      const terminalOutcome = normalizedClass(workflowState, "UNKNOWN");
      const operationClass = normalizedClass(operation?.kind, "PROVIDER_OPERATION");
      const shared = {
        ...source(project, {
          workId: operation?.workId ?? null,
          operationId: operation?.operationId ?? null,
        }),
        facts: {
          providerFamily,
          operationClass,
          resultClass: terminalOutcome,
        },
        outcome: {
          terminalOutcome,
          success: terminalOutcome === "SUCCEEDED",
        },
      };
      return persist([
        { category: "EXECUTION", ...shared },
        {
          category: "PERFORMANCE",
          ...shared,
          facts: { ...shared.facts, latencyBucket: "UNKNOWN" },
        },
      ]);
    },

    async recordRuntimeChange({ project, action } = {}) {
      const normalizedAction = action === "ROLLBACK" ? "ROLLBACK" : "UPGRADE";
      return persist([{
        category: normalizedAction === "ROLLBACK" ? "COUNTEREXAMPLE" : "EXECUTION",
        ...source(project),
        facts: {
          operationClass: `RUNTIME_${normalizedAction}`,
          resultClass: "ACTIVATED",
        },
        outcome: {
          terminalOutcome: normalizedAction === "ROLLBACK" ? "ROLLED_BACK" : "UPGRADED",
          success: true,
        },
      }]);
    },

    async recordRuntimeFailure({ project, failureClass } = {}) {
      const normalizedFailure = normalizedClass(failureClass, "RUNTIME_ACTIVATION_FAILED");
      return persist([{
        category: "DIAGNOSTIC",
        ...source(project),
        facts: {
          failureClass: normalizedFailure,
          operationClass: "RUNTIME_ACTIVATION",
        },
        outcome: {
          terminalOutcome: "DENIED",
          success: false,
          failureClass: normalizedFailure,
        },
      }]);
    },
  });
}
