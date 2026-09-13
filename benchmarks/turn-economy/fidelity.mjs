import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Task-level fidelity specifications.
 * Defines whether worker delegation is expected and allowed actors for mutations.
 */
export const TASK_FIDELITY_REQUIREMENTS = {
  status: {
    delegationExpected: false,
    allowedMutationActors: ["NONE"],
    intent: "DIRECT_ACTION",
  },
  lookup: {
    delegationExpected: false,
    allowedMutationActors: ["NONE"],
    intent: "READ_ONLY",
  },
  simple: {
    delegationExpected: true,
    allowedMutationActors: ["WORKER"],
    intent: "IMPLEMENTATION",
  },
  multi: {
    delegationExpected: true,
    allowedMutationActors: ["WORKER"],
    intent: "IMPLEMENTATION",
  },
  investigation: {
    delegationExpected: true,
    allowedMutationActors: ["WORKER"],
    intent: "INVESTIGATION_AND_FIX",
  },
  critical: {
    delegationExpected: false, // Orchestrator coordinates Two-Key Reviewers, not standard worker
    allowedMutationActors: ["NONE"],
    intent: "CRITICAL_REVIEW",
  },
};

/**
 * Expected architectural routing per runtime.
 */
export const EXPECTED_ROUTES = {
  codex: {
    orchestrator: {
      profile: "terra-medium",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
    worker: {
      simple: { profile: "luna-high", model: "gpt-5.6-luna", reasoningEffort: "high" },
      multi: { profile: "luna-high", model: "gpt-5.6-luna", reasoningEffort: "high" },
      investigation: { profile: "luna-high", model: "gpt-5.6-luna", reasoningEffort: "high" },
    },
  },
  antigravity: {
    orchestrator: {
      profile: "flash-orchestrator",
      model: "gemini-3.8-flash-medium",
      reasoningEffort: "medium",
    },
    worker: {
      simple: { profile: "flash-worker", model: "gemini-3.8-flash", reasoningEffort: "low" },
      multi: { profile: "flash-medium-worker", model: "gemini-3.8-flash-medium", reasoningEffort: "medium" },
      investigation: { profile: "flash-worker", model: "gemini-3.8-flash", reasoningEffort: "low" },
    },
  },
};

/**
 * Classifies confidence level for role attribution.
 * HIGH: Explicit runtime actor / thread / agent evidence (SQLite child thread, explicit subagent session).
 * MEDIUM: Strong correlation of invocation + requestedAgent + timing.
 * LOW: Indirect inference without actor identity.
 */
export function classifyRoleAttributionConfidence(evidence = {}) {
  if (evidence.hasExplicitThreadId || evidence.hasExplicitAgentRole || evidence.hasSubagentTrace) {
    return "HIGH";
  }
  if (evidence.hasRequestedAgent && evidence.hasInvocationTimingCorrelation) {
    return "MEDIUM";
  }
  return "LOW";
}

/**
 * Returns expected route for a given task and runtime.
 */
export function getExpectedRoute(taskKey, runtime) {
  const rtExpected = EXPECTED_ROUTES[runtime];
  if (!rtExpected) return null;

  const req = TASK_FIDELITY_REQUIREMENTS[taskKey];
  const workerDef = (req && req.delegationExpected && rtExpected.worker) ? rtExpected.worker[taskKey] || null : null;

  return {
    orchestrator: rtExpected.orchestrator.profile,
    orchestratorModel: rtExpected.orchestrator.model,
    worker: workerDef ? workerDef.profile : null,
    workerModel: workerDef ? workerDef.model : null,
    delegationExpected: req ? req.delegationExpected : false,
  };
}

/**
 * Evaluates execution fidelity for a task run.
 */
export function evaluateTaskFidelity({
  taskKey,
  runtime,
  subagentInvocations = 0,
  mutationActor = "NONE", // "WORKER" | "ORCHESTRATOR" | "NONE" | "UNKNOWN"
  runtimeLoaded = true,
  orchestratorIdentity = null,
  workerObserved = false,
  confidenceEvidence = {},
  gaps = [],
}) {
  const req = TASK_FIDELITY_REQUIREMENTS[taskKey];
  if (!req) {
    return {
      fidelityStatus: "UNKNOWN",
      confidence: "LOW",
      reason: `Unknown taskKey: ${taskKey}`,
    };
  }

  const expectedRoute = getExpectedRoute(taskKey, runtime);
  const delegationExpected = req.delegationExpected;
  const isWorkerPresent = workerObserved || subagentInvocations > 0;

  // Determine mutation actor validity
  let writeActorValid = true;
  const violations = [...gaps];

  if (delegationExpected) {
    if (!isWorkerPresent) {
      writeActorValid = false;
      violations.push("EXPECTED_WORKER_ABSENT");
    }
    if (mutationActor === "ORCHESTRATOR") {
      writeActorValid = false;
      violations.push("FIDELITY_VIOLATION: ORCHESTRATOR_PRODUCT_WRITE_ALLOWED");
    } else if (mutationActor === "UNKNOWN") {
      writeActorValid = false;
      violations.push("FIDELITY_VIOLATION: MUTATION_ACTOR_UNKNOWN");
    }
  } else {
    // Non-delegation tasks (direct status, lookup, critical)
    if (mutationActor !== "NONE") {
      writeActorValid = false;
      violations.push(`UNEXPECTED_MUTATION_IN_READONLY_TASK: actor=${mutationActor}`);
    }
  }

  const confidence = classifyRoleAttributionConfidence(confidenceEvidence);

  let fidelityStatus = "PASS";
  if (!runtimeLoaded) {
    fidelityStatus = "FAIL";
    violations.push("RUNTIME_NOT_LOADED");
  } else if (!writeActorValid || violations.length > 0) {
    fidelityStatus = "FAIL";
  }

  return {
    runtime,
    task: taskKey,
    runtimeLoaded,
    expectedRoute: {
      orchestrator: expectedRoute?.orchestrator || "unknown",
      worker: expectedRoute?.worker || null,
      delegationExpected,
    },
    observed: {
      orchestrator: orchestratorIdentity || (runtime === "codex" ? "terra-medium" : "generic-agent"),
      worker: isWorkerPresent ? (expectedRoute?.worker || "worker") : null,
      delegation: isWorkerPresent,
      subagentInvocations,
      productMutationActor: mutationActor,
    },
    writeActorValid,
    fidelityStatus,
    confidence,
    violations,
  };
}
