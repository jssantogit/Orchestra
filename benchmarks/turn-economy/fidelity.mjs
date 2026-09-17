import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  decideRoute as decideCodexRoute,
  CODEX_MODELS,
} from "../../runtimes/codex/.codex/astra-orchestra/routing-policy.mjs";

import {
  decideRoute as decideAgyRoute,
  GEMINI_MODELS,
  ANTIGRAVITY_MODELS,
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

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
 * Expected architectural routing per runtime (baseline reference table).
 * Reflects the policies dynamically derived from decideRoute in each runtime.
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
      multi: { profile: "luna-max", model: "gpt-5.6-luna", reasoningEffort: "max" },
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
      simple: { profile: "flash-low-worker", model: "gemini-3.8-flash-low", reasoningEffort: "low" },
      multi: { profile: "flash-medium-worker", model: "gemini-3.8-flash-medium", reasoningEffort: "medium" },
      investigation: { profile: "flash-worker", model: "gemini-3.8-flash-high", reasoningEffort: "high" },
    },
  },
};

/**
 * Classifies confidence level for role attribution.
 * HIGH: Explicit runtime actor / thread / agent evidence (SQLite child thread, explicit subagent session, hook payload).
 * MEDIUM: Strong correlation of invocation + requestedAgent + timing.
 * LOW: Indirect inference without actor identity.
 */
export function classifyRoleAttributionConfidence(evidence = {}) {
  if (Array.isArray(evidence.mutationEvents) && evidence.mutationEvents.length > 0) {
    const confidences = evidence.mutationEvents.map((e) => e.confidence || "LOW");
    if (confidences.every((c) => c === "HIGH")) return "HIGH";
    if (confidences.some((c) => c === "HIGH" || c === "MEDIUM")) return "MEDIUM";
    return "LOW";
  }
  if (evidence.hasExplicitThreadId || evidence.hasExplicitAgentRole || evidence.hasSubagentTrace) {
    return "HIGH";
  }
  if (evidence.hasRequestedAgent && evidence.hasInvocationTimingCorrelation) {
    return "MEDIUM";
  }
  return "LOW";
}

/**
 * Returns expected route for a given task and runtime, dynamically derived
 * from the authoritative deterministic routing policy of each runtime.
 */
export function getExpectedRoute(taskKey, runtime) {
  const req = TASK_FIDELITY_REQUIREMENTS[taskKey];
  if (!req) return null;

  if (runtime === "codex") {
    const orchRoute = decideCodexRoute({ taskAction: "ORCHESTRATE" });
    let workerDef = null;
    if (req.delegationExpected) {
      if (taskKey === "simple") {
        const wRoute = decideCodexRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" });
        workerDef = { profile: wRoute.profile, model: wRoute.model, reasoningEffort: wRoute.reasoningEffort };
      } else if (taskKey === "multi") {
        const wRoute = decideCodexRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" });
        workerDef = { profile: wRoute.profile, model: wRoute.model, reasoningEffort: wRoute.reasoningEffort };
      } else if (taskKey === "investigation") {
        const wRoute = decideCodexRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" });
        workerDef = { profile: wRoute.profile, model: wRoute.model, reasoningEffort: wRoute.reasoningEffort };
      }
    }
    return {
      orchestrator: orchRoute.profile,
      orchestratorModel: orchRoute.model,
      worker: workerDef ? workerDef.profile : null,
      workerModel: workerDef ? workerDef.model : null,
      delegationExpected: req.delegationExpected,
    };
  }

  if (runtime === "antigravity") {
    const orchRoute = decideAgyRoute({ taskAction: "ORCHESTRATE" });
    let workerDef = null;
    if (req.delegationExpected) {
      if (taskKey === "simple") {
        const wRoute = decideAgyRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" });
        workerDef = { profile: "flash-low-worker", model: wRoute.model, reasoningEffort: wRoute.effort };
      } else if (taskKey === "multi") {
        const wRoute = decideAgyRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" });
        workerDef = { profile: "flash-medium-worker", model: wRoute.model, reasoningEffort: wRoute.effort };
      } else if (taskKey === "investigation") {
        const wRoute = decideAgyRoute({ taskAction: "INVESTIGATE" });
        workerDef = { profile: "flash-worker", model: wRoute.model, reasoningEffort: wRoute.effort };
      } else if (taskKey === "critical") {
        workerDef = { profile: "flash-reviewer", model: GEMINI_MODELS.REVIEWER_A, reasoningEffort: "high" };
      }
    }
    return {
      orchestrator: orchRoute.executor || "flash-orchestrator",
      orchestratorModel: orchRoute.model || "gemini-3.8-flash-medium",
      worker: workerDef ? workerDef.profile : null,
      workerModel: workerDef ? workerDef.model : null,
      delegationExpected: req.delegationExpected,
    };
  }

  return null;
}

/**
 * Evaluates execution fidelity for a task run.
 * Enforces per-mutation attribution, dry-run simulation semantics,
 * and fails closed on orchestrator product writes or unknown actors.
 */
export function evaluateTaskFidelity({
  taskKey,
  runtime,
  subagentInvocations = 0,
  mutationActor = "NONE", // "WORKER" | "ORCHESTRATOR" | "NONE" | "UNKNOWN"
  mutationEvents = [],
  orchestratorWorkspaceWrites = 0,
  unknownWorkspaceWrites = 0,
  controlPlaneWrites = 0,
  dryRun = false,
  runtimeLoaded = true,
  orchestratorIdentity = null,
  workerObserved = false,
  confidenceEvidence = {},
  gaps = [],
  workerCompletionClaimed = false,
  workerValidationObserved = false,
  workerValidationVerified = false,
  workerValidationExecutionId = null,
  workerValidationConversationId = null,
  workerValidationActor = null,
  workerValidationExitCode = null,
  workerValidationFresh = false,
  acceptanceObserved = false,
  acceptanceActor = null,
  acceptanceState = null,
  mutationAttributionMode = null,
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

  // Dry-run simulation mode: returns SIMULATED status with LOW confidence
  if (dryRun) {
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
        orchestrator: orchestratorIdentity || (runtime === "codex" ? "terra-medium" : "flash-orchestrator"),
        worker: delegationExpected ? (expectedRoute?.worker || "worker") : null,
        delegation: delegationExpected,
        subagentInvocations,
        productMutationActor: delegationExpected ? "WORKER" : "NONE",
        mutationEvents: [],
        worker_completion_claimed: false,
        worker_validation_observed: false,
        worker_validation_verified: false,
        worker_validation_execution_id: null,
        worker_validation_conversation_id: null,
        worker_validation_actor: null,
        worker_validation_exit_code: null,
        worker_validation_fresh: false,
        acceptance_observed: delegationExpected,
        acceptance_actor: delegationExpected ? "ORCHESTRATOR" : null,
        acceptance_state: delegationExpected ? "ACCEPTED" : null,
        mutation_attribution_mode: "SIMULATED",
      },
      worker_completion_claimed: false,
      worker_validation_observed: false,
      worker_validation_verified: false,
      worker_validation_execution_id: null,
      worker_validation_conversation_id: null,
      worker_validation_actor: null,
      worker_validation_exit_code: null,
      worker_validation_fresh: false,
      acceptance_observed: delegationExpected,
      acceptance_actor: delegationExpected ? "ORCHESTRATOR" : null,
      acceptance_state: delegationExpected ? "ACCEPTED" : null,
      mutation_attribution_mode: "SIMULATED",
      writeActorValid: true,
      fidelityStatus: "SIMULATED",
      confidence: "LOW",
      violations: [...gaps],
      dryRun: true,
    };
  }

  const violations = [...gaps];
  let writeActorValid = true;

  // 1. Audit individual mutation events
  const normEvents = Array.isArray(mutationEvents) ? mutationEvents : [];
  const workerMutations = normEvents.filter(
    (e) => e.actorRole === "WORKER" || e.actorRole === "WORKER_SUBAGENT"
  );
  const orchestratorMutations = normEvents.filter(
    (e) => e.actorRole === "ORCHESTRATOR"
  );
  const unknownMutations = normEvents.filter(
    (e) => e.actorRole === "UNKNOWN" || !e.actorRole
  );

  let effectiveActor = mutationActor;
  if (orchestratorWorkspaceWrites > 0 || orchestratorMutations.length > 0) {
    effectiveActor = "ORCHESTRATOR";
  } else if (unknownWorkspaceWrites > 0 || unknownMutations.length > 0) {
    effectiveActor = "UNKNOWN";
  } else if (workerMutations.length > 0) {
    effectiveActor = "WORKER";
  }

  // 2. Strict architectural enforcement: orchestrator writes to product code are forbidden
  if (orchestratorWorkspaceWrites > 0 || orchestratorMutations.length > 0 || mutationActor === "ORCHESTRATOR") {
    writeActorValid = false;
    violations.push("FIDELITY_VIOLATION: ORCHESTRATOR_PRODUCT_WRITE_ALLOWED");
  }

  // 3. Strict role attribution: unknown actor fails closed
  if (unknownWorkspaceWrites > 0 || unknownMutations.length > 0 || mutationActor === "UNKNOWN") {
    writeActorValid = false;
    violations.push("FIDELITY_VIOLATION: MUTATION_ACTOR_UNKNOWN");
  }

  // 4. Task intent and delegation verification
  const isWorkerPresent = workerObserved || workerMutations.length > 0 || subagentInvocations > 0;

  if (delegationExpected) {
    if (!isWorkerPresent) {
      writeActorValid = false;
      violations.push("EXPECTED_WORKER_ABSENT");
    }

    if (req.allowedMutationActors.includes("NONE")) {
      // Read-only delegated task (e.g. critical review)
      if (effectiveActor !== "NONE" && effectiveActor !== null) {
        writeActorValid = false;
        violations.push(`UNEXPECTED_MUTATION_IN_READONLY_TASK: actor=${effectiveActor}`);
      }
    } else {
      if (normEvents.length > 0) {
        // Mutation events present: check that at least one is attributed to WORKER
        if (workerMutations.length === 0) {
          writeActorValid = false;
          violations.push("FIDELITY_VIOLATION: NO_WORKER_MUTATIONS");
        }
      } else {
        // normEvents is empty — typical for AGY multi-agent architecture.
        // Worker writes happen in the child conversation context; the parent's
        // post-tool-telemetry cannot observe them. Use subagent presence as proxy.
        if (!isWorkerPresent) {
          // No subagent was ever invoked — definitively absent
          writeActorValid = false;
          violations.push("EXPECTED_WORKER_ABSENT");
        }
        // If isWorkerPresent && mutationActor === "NONE": worker delegated normally,
        // parent cannot see child mutations. This is expected. Treat as PASS-eligible.
      }
    }
  } else {
    // Non-delegation tasks (status, lookup)
    if (effectiveActor !== "NONE" && effectiveActor !== null) {
      writeActorValid = false;
      violations.push(`UNEXPECTED_MUTATION_IN_READONLY_TASK: actor=${effectiveActor}`);
    }
  }

  // Compute attribution confidence
  let confidence = classifyRoleAttributionConfidence({
    ...confidenceEvidence,
    mutationEvents: normEvents,
  });

  const delegatedWithEmptyEvents = delegationExpected && isWorkerPresent && normEvents.length === 0 && effectiveActor === "NONE";
  const isFactualWorker = normEvents.length > 0 && normEvents.some(e => e.actorRole === "WORKER" || e.actorRole === "WORKER_SUBAGENT");
  const attributionMode = mutationAttributionMode || (delegatedWithEmptyEvents ? "PROXY" : (isFactualWorker ? "FACTUAL" : (effectiveActor === "NONE" ? "NONE" : "FACTUAL")));

  // Invariant: WORKER_PROXY confidence is capped at MEDIUM and is not factual attribution
  if (delegatedWithEmptyEvents || attributionMode === "PROXY") {
    if (confidence === "HIGH") {
      confidence = "MEDIUM";
    }
  }

  // PASS only allowed when confidence is HIGH or MEDIUM for delegated worker execution.
  if (delegationExpected && !delegatedWithEmptyEvents && effectiveActor === "WORKER" && confidence === "LOW") {
    writeActorValid = false;
    violations.push("FIDELITY_VIOLATION: LOW_ATTRIBUTION_CONFIDENCE");
  }
  if (delegatedWithEmptyEvents && confidence === "LOW") {
    writeActorValid = false;
    violations.push("FIDELITY_VIOLATION: LOW_ATTRIBUTION_CONFIDENCE");
  }

  // 5. Evidence Ledger / Worker Validation verification for delegated implementation tasks
  const isDelegatedImpl = delegationExpected && (req.intent === "IMPLEMENTATION" || req.intent === "INVESTIGATION_AND_FIX");
  if (isDelegatedImpl) {
    if (workerCompletionClaimed !== true) {
      writeActorValid = false;
      violations.push("WORKER_COMPLETION_NOT_CLAIMED");
    }
    if (workerValidationObserved !== true) {
      writeActorValid = false;
      violations.push("WORKER_VALIDATION_NOT_OBSERVED");
    }
    if (workerValidationVerified !== true) {
      writeActorValid = false;
      violations.push("WORKER_VALIDATION_NOT_VERIFIED");
    }
    if (workerValidationFresh !== true) {
      writeActorValid = false;
      violations.push("WORKER_VALIDATION_STALE");
    }
    if (!workerValidationActor || workerValidationActor !== "WORKER") {
      writeActorValid = false;
      violations.push("WORKER_VALIDATION_INVALID_ACTOR");
    }
    if (workerValidationExitCode !== 0) {
      writeActorValid = false;
      violations.push("WORKER_VALIDATION_FAILED");
    }
    if (acceptanceObserved !== true) {
      writeActorValid = false;
      violations.push("ORCHESTRATOR_ACCEPTANCE_NOT_OBSERVED");
    }
    if (!acceptanceActor || acceptanceActor !== "ORCHESTRATOR") {
      writeActorValid = false;
      violations.push("INVALID_ACCEPTANCE_ACTOR");
    }
    if (acceptanceState !== "ACCEPTED") {
      writeActorValid = false;
      violations.push("IMPLEMENTATION_NOT_ACCEPTED");
    }
  }

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
      orchestrator: orchestratorIdentity || (runtime === "codex" ? "terra-medium" : "flash-orchestrator"),
      worker: isWorkerPresent ? (expectedRoute?.worker || "worker") : null,
      delegation: isWorkerPresent,
      subagentInvocations,
      productMutationActor: delegatedWithEmptyEvents ? "WORKER_PROXY" : effectiveActor,
      mutationEvents: normEvents,
      orchestratorWorkspaceWrites,
      controlPlaneWrites,
      unknownWorkspaceWrites,
      worker_completion_claimed: workerCompletionClaimed,
      worker_validation_observed: workerValidationObserved,
      worker_validation_verified: workerValidationVerified,
      worker_validation_execution_id: workerValidationExecutionId || null,
      worker_validation_conversation_id: workerValidationConversationId || null,
      worker_validation_actor: workerValidationActor,
      worker_validation_exit_code: workerValidationExitCode,
      worker_validation_fresh: workerValidationFresh,
      acceptance_observed: Boolean(acceptanceObserved),
      acceptance_actor: acceptanceActor || null,
      acceptance_state: acceptanceState || null,
      mutation_attribution_mode: attributionMode,
    },
    worker_completion_claimed: workerCompletionClaimed,
    worker_validation_observed: workerValidationObserved,
    worker_validation_verified: workerValidationVerified,
    worker_validation_execution_id: workerValidationExecutionId || null,
    worker_validation_conversation_id: workerValidationConversationId || null,
    worker_validation_actor: workerValidationActor,
    worker_validation_exit_code: workerValidationExitCode,
    worker_validation_fresh: workerValidationFresh,
    acceptance_observed: Boolean(acceptanceObserved),
    acceptance_actor: acceptanceActor || null,
    acceptance_state: acceptanceState || null,
    mutation_attribution_mode: attributionMode,
    writeActorValid,
    fidelityStatus,
    confidence,
    violations: [...new Set(violations)],
  };
}
